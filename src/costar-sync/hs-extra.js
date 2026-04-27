'use strict';

/**
 * hs-extra.js — HubSpot helpers for deals + contacts used by the lease-up flow.
 *
 * Pattern-aligned with src/hubspot.js and src/costar-sync/sync.js. Keeps all
 * deal/contact primitives in one place so leaseup.js and the backfill script
 * share the same dedup + association logic.
 *
 * IMPORTANT: every create path here runs dedup first. Per project rule
 * (feedback_hubspot_dedup): never POST a new company/contact/deal without
 * checking for an existing match.
 */

const https = require('https');
const fs    = require('fs');
const path  = require('path');

(function loadDotEnv() {
  try {
    const envPath = path.join(__dirname, '..', '..', '.env');
    const lines = fs.readFileSync(envPath, 'utf8').split(/\r?\n/);
    for (const line of lines) {
      const m = line.match(/^([A-Z_][A-Z0-9_]*)\s*=\s*(.+)$/);
      if (m && !process.env[m[1]]) {
        process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
      }
    }
  } catch { /* no .env is fine */ }
})();

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const AP_PIPELINE_ID         = '64402505';                  // Outside Sales AP Partnerships
const NEW_OPPORTUNITIES_STAGE = '126194574';                // "New Opportunities "
const XANDER_OWNER_ID        = '80597267';                  // Xander Williams
const DEAL_CATEGORY_LEASE_UP = 'Lease Up';

// Standard HubSpot association type IDs
const ASSOC = {
  CONTACT_TO_COMPANY: 1,
  DEAL_TO_COMPANY:    5,
  COMPANY_TO_DEAL:    6,
  DEAL_TO_CONTACT:    3,
  CONTACT_TO_DEAL:    4
};

// Closed deal stages (can't merge into one that is closed)
const CLOSED_STAGES = new Set([
  'closedwon', 'closedlost',
  '126194579',  // Closed Won (AP)
  '1097165102', // Lost Deal
  '126194580',  // (Old) Closed lost
  '111805297', '111805298', '148374638'
]);

// ---------------------------------------------------------------------------
// HTTP helper — same pattern as sync.js
// ---------------------------------------------------------------------------

function _singleRequest(method, apiPath, body = null) {
  return new Promise((resolve, reject) => {
    const token = process.env.HUBSPOT_TOKEN;
    if (!token) return reject(new Error('HUBSPOT_TOKEN not set'));
    const bodyStr = body ? JSON.stringify(body) : null;

    const req = https.request({
      hostname: 'api.hubapi.com',
      path:     apiPath,
      method,
      headers: {
        Authorization:  `Bearer ${token}`,
        'Content-Type': 'application/json',
        ...(bodyStr ? { 'Content-Length': Buffer.byteLength(bodyStr) } : {})
      }
    }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        if (res.statusCode >= 400) {
          let msg;
          try { msg = JSON.parse(data).message || data.slice(0, 300); }
          catch { msg = data.slice(0, 300); }
          const err = new Error(`HubSpot ${res.statusCode} ${method} ${apiPath}: ${msg}`);
          err.statusCode = res.statusCode;
          return reject(err);
        }
        try { resolve(JSON.parse(data)); } catch { resolve(data); }
      });
    });
    req.on('error', reject);
    req.setTimeout(20000, () => { req.destroy(); reject(new Error(`Timeout: ${apiPath}`)); });
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

async function apiRequest(method, apiPath, body = null) {
  const MAX_RETRIES = 5;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      return await _singleRequest(method, apiPath, body);
    } catch (err) {
      if (err.statusCode === 429 && attempt < MAX_RETRIES) {
        const delay = attempt * 1500;  // 1.5s, 3s, 4.5s, 6s
        await sleep(delay);
        continue;
      }
      throw err;
    }
  }
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Deals — find open deal on a company (AP Pipeline)
// ---------------------------------------------------------------------------

/**
 * Find an open deal associated with this company in AP Pipeline.
 * Returns the most-recently-updated open deal, or null.
 */
async function findOpenDealForCompany(companyId) {
  // Fetch deal IDs associated to the company
  const assoc = await apiRequest(
    'GET',
    `/crm/v4/objects/companies/${companyId}/associations/deals?limit=100`
  );
  const dealIds = (assoc.results || []).map(r => r.toObjectId).filter(Boolean);
  if (!dealIds.length) return null;

  // Batch read deals with fields we need
  const res = await apiRequest('POST', '/crm/v3/objects/deals/batch/read', {
    inputs:     dealIds.map(id => ({ id: String(id) })),
    properties: ['dealname', 'dealstage', 'pipeline', 'hubspot_owner_id',
                 'deal_category', 'hs_lastmodifieddate']
  });

  const open = (res.results || [])
    .filter(d => d.properties?.pipeline === AP_PIPELINE_ID)
    .filter(d => !CLOSED_STAGES.has(d.properties?.dealstage))
    .sort((a, b) => (b.properties.hs_lastmodifieddate || '').localeCompare(
                    a.properties.hs_lastmodifieddate || ''));

  return open[0] || null;
}

// ---------------------------------------------------------------------------
// Deals — create (with company association)
// ---------------------------------------------------------------------------

async function createDeal({ name, ownerId, pipeline, stage, category, companyId }) {
  const payload = {
    properties: {
      dealname:          name,
      pipeline:          pipeline,
      dealstage:         stage,
      hubspot_owner_id:  String(ownerId),
      ...(category ? { deal_category: category } : {})
    },
    associations: [{
      to:    { id: String(companyId) },
      types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: ASSOC.DEAL_TO_COMPANY }]
    }]
  };
  return apiRequest('POST', '/crm/v3/objects/deals', payload);
}

async function updateDeal(dealId, properties) {
  return apiRequest('PATCH', `/crm/v3/objects/deals/${dealId}`, { properties });
}

// HubSpot archive = soft delete (90-day recovery window in UI).
async function archiveDeal(dealId) {
  return apiRequest('DELETE', `/crm/v3/objects/deals/${dealId}`);
}

/**
 * Merge a secondary deal into a primary. Transfers all activity (notes,
 * emails, calls, tasks, stage history), contact/company associations, and
 * property values from secondary → primary, then archives secondary.
 * Primary retains its ID and ownership; secondary becomes unreachable.
 *
 * Use this in place of `archiveDeal` when de-duplicating so rep history
 * doesn't get stranded on the archived record.
 */
async function mergeDeals(primaryId, secondaryId) {
  return apiRequest('POST', '/crm/v3/objects/deals/merge', {
    primaryObjectId: String(primaryId),
    objectIdToMerge: String(secondaryId)
  });
}

// ---------------------------------------------------------------------------
// Deals — search by stage + pipeline (for backfill)
// ---------------------------------------------------------------------------

async function searchDealsByPipelineAndStage(pipelineId, stageId, maxResults = 1000) {
  const results = [];
  let after;
  do {
    const res = await apiRequest('POST', '/crm/v3/objects/deals/search', {
      filterGroups: [{ filters: [
        { propertyName: 'pipeline',  operator: 'EQ', value: pipelineId },
        { propertyName: 'dealstage', operator: 'EQ', value: stageId }
      ]}],
      properties: ['dealname', 'hubspot_owner_id', 'dealstage', 'pipeline', 'deal_category'],
      limit: 100,
      ...(after ? { after } : {})
    });
    results.push(...(res.results || []));
    after = res.paging?.next?.after;
    if (after) await sleep(200);
  } while (after && results.length < maxResults);
  return results;
}

/** Given a list of deal IDs, return { dealId: [companyId,...] } */
async function getDealCompanies(dealIds) {
  if (!dealIds.length) return {};
  const out = {};
  const chunkSize = 100;
  for (let i = 0; i < dealIds.length; i += chunkSize) {
    const chunk = dealIds.slice(i, i + chunkSize);
    const res = await apiRequest('POST', '/crm/v4/associations/deals/companies/batch/read', {
      inputs: chunk.map(id => ({ id: String(id) }))
    });
    for (const item of (res.results || [])) {
      if (item.from?.id && item.to?.length) {
        out[item.from.id] = item.to.map(t => String(t.toObjectId));
      }
    }
    if (i + chunkSize < dealIds.length) await sleep(200);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Contacts — dedup + create
// ---------------------------------------------------------------------------

async function findContactByEmail(email) {
  if (!email) return null;
  const res = await apiRequest('POST', '/crm/v3/objects/contacts/search', {
    filterGroups: [{ filters: [{ propertyName: 'email', operator: 'EQ', value: email.toLowerCase() }] }],
    properties: ['email', 'firstname', 'lastname'],
    limit: 1
  });
  return (res.results || [])[0] || null;
}

async function findContactByNameAtCompany(firstname, lastname, companyId) {
  if (!firstname || !lastname) return null;
  // Pull existing contacts on this company and match name — avoids collisions
  // with contacts of the same name at other companies
  const assoc = await apiRequest(
    'GET',
    `/crm/v4/objects/companies/${companyId}/associations/contacts?limit=100`
  );
  const contactIds = (assoc.results || []).map(r => r.toObjectId);
  if (!contactIds.length) return null;

  const res = await apiRequest('POST', '/crm/v3/objects/contacts/batch/read', {
    inputs:     contactIds.map(id => ({ id: String(id) })),
    properties: ['firstname', 'lastname', 'email']
  });

  const fnLower = firstname.toLowerCase();
  const lnLower = lastname.toLowerCase();
  return (res.results || []).find(c =>
    (c.properties?.firstname || '').toLowerCase() === fnLower &&
    (c.properties?.lastname  || '').toLowerCase() === lnLower
  ) || null;
}

async function createContact(props, { companyId, dealId } = {}) {
  const associations = [];
  if (companyId) {
    associations.push({
      to:    { id: String(companyId) },
      types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: ASSOC.CONTACT_TO_COMPANY }]
    });
  }
  if (dealId) {
    associations.push({
      to:    { id: String(dealId) },
      types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: ASSOC.CONTACT_TO_DEAL }]
    });
  }
  return apiRequest('POST', '/crm/v3/objects/contacts', {
    properties: props,
    ...(associations.length ? { associations } : {})
  });
}

async function associateContactToCompany(contactId, companyId) {
  return apiRequest(
    'PUT',
    `/crm/v4/objects/contacts/${contactId}/associations/default/companies/${companyId}`
  );
}

async function associateContactToDeal(contactId, dealId) {
  return apiRequest(
    'PUT',
    `/crm/v4/objects/contacts/${contactId}/associations/default/deals/${dealId}`
  );
}

// ---------------------------------------------------------------------------
// Notes — create a HubSpot Note engagement attached to a deal
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Companies — domain-first dedup + read/update helpers
// ---------------------------------------------------------------------------

const PUBLIC_EMAIL_DOMAINS = new Set([
  'gmail.com', 'yahoo.com', 'hotmail.com', 'outlook.com', 'aol.com',
  'icloud.com', 'me.com', 'live.com', 'msn.com', 'comcast.net',
  'protonmail.com', 'proton.me', 'mail.com', 'yahoo.co.uk', 'ymail.com'
]);

// Big-brand corporate domains we never trust as an owner-company identifier.
// These attract false positives: e.g. a "Chase Hospitality" owner gets ZI
// contacts on chase.com (the bank), which would domain-match JPMorgan Chase.
// When ZI-derives one of these, we fall through to name-based matching.
const AMBIGUOUS_CORPORATE_DOMAINS = new Set([
  'chase.com', 'jpmorgan.com', 'jpmorganchase.com',
  'wellsfargo.com', 'bankofamerica.com', 'bofa.com', 'citi.com',
  'capitalone.com', 'usbank.com', 'pnc.com', 'tdbank.com',
  'morganstanley.com', 'goldmansachs.com', 'blackrock.com',
  'hsbc.com', 'barclays.com', 'ubs.com', 'db.com',
  'amazon.com', 'apple.com', 'google.com', 'microsoft.com', 'meta.com',
  'walmart.com', 'target.com', 'costco.com',
  'marriott.com', 'hilton.com', 'hyatt.com',
  'deloitte.com', 'pwc.com', 'ey.com', 'kpmg.com',
  'related.com'  // grabbed by a "Collins Enterprises" record in our CRM
]);

/** Extract the most-common non-public email domain from a list of contacts. */
function deriveDominantDomain(contacts) {
  const counts = {};
  for (const c of contacts) {
    const email = (c.email || c.properties?.email || '').toLowerCase();
    const at = email.indexOf('@');
    if (at < 0) continue;
    const d = email.slice(at + 1).trim();
    if (!d || PUBLIC_EMAIL_DOMAINS.has(d)) continue;
    if (AMBIGUOUS_CORPORATE_DOMAINS.has(d)) continue;
    counts[d] = (counts[d] || 0) + 1;
  }
  const entries = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  return entries.length ? entries[0][0] : null;
}

async function findCompanyByDomain(domain) {
  if (!domain) return null;
  const res = await apiRequest('POST', '/crm/v3/objects/companies/search', {
    filterGroups: [{ filters: [{ propertyName: 'domain', operator: 'EQ', value: domain.toLowerCase() }] }],
    properties: ['name', 'domain', 'city', 'state'],
    limit: 1
  });
  return (res.results || [])[0] || null;
}

async function getCompanyBasics(companyId) {
  return apiRequest('GET', `/crm/v3/objects/companies/${companyId}?properties=name,domain,city,state,address,address2,zip,country`);
}

// Return ALL open AP deals on a company (most-recent first), not just the top one.
async function findOpenDealsForCompany(companyId) {
  const assoc = await apiRequest(
    'GET',
    `/crm/v4/objects/companies/${companyId}/associations/deals?limit=100`
  );
  const dealIds = (assoc.results || []).map(r => r.toObjectId).filter(Boolean);
  if (!dealIds.length) return [];
  const res = await apiRequest('POST', '/crm/v3/objects/deals/batch/read', {
    inputs:     dealIds.map(id => ({ id: String(id) })),
    properties: ['dealname', 'dealstage', 'pipeline', 'hubspot_owner_id',
                 'deal_category', 'hs_lastmodifieddate']
  });
  return (res.results || [])
    .filter(d => d.properties?.pipeline === AP_PIPELINE_ID)
    .filter(d => !CLOSED_STAGES.has(d.properties?.dealstage))
    .sort((a, b) => (b.properties.hs_lastmodifieddate || '').localeCompare(
                    a.properties.hs_lastmodifieddate || ''));
}

async function updateCompany(companyId, properties) {
  return apiRequest('PATCH', `/crm/v3/objects/companies/${companyId}`, { properties });
}

async function createCompany(properties) {
  return apiRequest('POST', '/crm/v3/objects/companies', { properties });
}

// ---------------------------------------------------------------------------
// Closed-Won lookup — used by the rep cascade as the highest-priority tier
// ---------------------------------------------------------------------------

/**
 * Return the set of all stage IDs that mark "Closed Won" across every pipeline.
 * HubSpot's stage metadata exposes `probability` — probability == 1.0 is the
 * canonical Closed-Won marker. Cached for the life of the process.
 */
let _closedWonStageIdsCache = null;
async function getClosedWonStageIds() {
  if (_closedWonStageIdsCache) return _closedWonStageIdsCache;
  const ids = new Set();
  try {
    const res = await apiRequest('GET', '/crm/v3/pipelines/deals');
    for (const p of res.results || []) {
      for (const s of p.stages || []) {
        const prob = Number(s?.metadata?.probability);
        if (prob === 1 || prob === 1.0) ids.add(s.id);
      }
    }
  } catch { /* swallow — caller treats empty set as "no Closed-Won detection" */ }
  _closedWonStageIdsCache = ids;
  return ids;
}

/**
 * Returns true if the HubSpot owner is currently active (not archived/deleted).
 * Inactive seats fall through the rep cascade so dead reps never get new deals.
 * Cached per process — rep churn is infrequent enough that we don't refresh.
 */
const _ownerActiveCache = new Map();
async function isOwnerActive(ownerId) {
  if (!ownerId) return false;
  const key = String(ownerId);
  if (_ownerActiveCache.has(key)) return _ownerActiveCache.get(key);
  try {
    const res = await apiRequest('GET', `/crm/v3/owners/${key}`);
    const active = !res?.archived && !!res?.id;
    _ownerActiveCache.set(key, active);
    return active;
  } catch (e) {
    // 404 → archived/deleted owner; treat as inactive
    if (e.statusCode === 404) { _ownerActiveCache.set(key, false); return false; }
    // Other errors: don't cache, default to active so we don't lock out
    // the cascade if the owners endpoint flaps
    return true;
  }
}

/**
 * Find the rep who owns a company by virtue of having a Closed-Won deal on it.
 *
 * Policy (Matt, 2026-04-27):
 *   • Any pipeline counts (probability == 1.0 stage metadata)
 *   • Multi-winner tiebreak → most recent `closedate`
 *   • If the most-recent winner's owner is inactive → fall through (return null
 *     so the cascade tries ownerAssignments → Top-50 → Lease-Up → territory)
 *
 * Returns { ownerId, closeDate, dealId, dealname } or null.
 */
async function findClosedWonOwnerForCompany(companyId) {
  const closedWonStages = await getClosedWonStageIds();
  if (!closedWonStages.size) return null;

  // Companies with lots of deals (Bell Partners, Greystar, Camden) blow past
  // a single page. Paginate associations + chunk the batch/read at 100 inputs.
  const dealIds = [];
  let after;
  do {
    const url = `/crm/v4/objects/companies/${companyId}/associations/deals?limit=500` +
                (after ? `&after=${encodeURIComponent(after)}` : '');
    const page = await apiRequest('GET', url);
    for (const r of page.results || []) if (r.toObjectId) dealIds.push(r.toObjectId);
    after = page.paging?.next?.after;
  } while (after);
  if (!dealIds.length) return null;

  const wonDeals = [];
  for (let i = 0; i < dealIds.length; i += 100) {
    const chunk = dealIds.slice(i, i + 100);
    const res = await apiRequest('POST', '/crm/v3/objects/deals/batch/read', {
      inputs: chunk.map(id => ({ id: String(id) })),
      properties: ['dealname', 'dealstage', 'pipeline',
                   'hubspot_owner_id', 'closedate', 'hs_closed_won_date']
    });
    for (const d of res.results || []) {
      if (closedWonStages.has(d.properties?.dealstage) && d.properties?.hubspot_owner_id) {
        wonDeals.push(d);
      }
    }
  }

  if (!wonDeals.length) return null;

  // Sort by close date desc — most recent winner first
  const closeOf = d => Date.parse(d.properties?.closedate ||
                                  d.properties?.hs_closed_won_date || '') || 0;
  wonDeals.sort((a, b) => closeOf(b) - closeOf(a));

  // Walk from most-recent down; return the first deal whose owner is still active.
  // If none of them is active, return null (cascade falls through).
  for (const d of wonDeals) {
    const ownerId = d.properties.hubspot_owner_id;
    if (await isOwnerActive(ownerId)) {
      return {
        ownerId,
        closeDate: d.properties.closedate || d.properties.hs_closed_won_date || null,
        dealId: d.id,
        dealname: d.properties.dealname || null
      };
    }
  }
  return null;
}

async function createNoteOnDeal(dealId, body) {
  return apiRequest('POST', '/crm/v3/objects/notes', {
    properties: {
      hs_note_body: body,
      hs_timestamp: String(Date.now())
    },
    associations: [{
      to:    { id: String(dealId) },
      // 214 = note → deal (HubSpot-defined)
      types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: 214 }]
    }]
  });
}

module.exports = {
  AP_PIPELINE_ID,
  NEW_OPPORTUNITIES_STAGE,
  XANDER_OWNER_ID,
  DEAL_CATEGORY_LEASE_UP,
  ASSOC,
  CLOSED_STAGES,
  apiRequest,
  findOpenDealForCompany,
  findOpenDealsForCompany,
  createDeal,
  updateDeal,
  archiveDeal,
  mergeDeals,
  searchDealsByPipelineAndStage,
  getDealCompanies,
  findContactByEmail,
  findContactByNameAtCompany,
  createContact,
  associateContactToCompany,
  associateContactToDeal,
  createNoteOnDeal,
  getClosedWonStageIds,
  isOwnerActive,
  findClosedWonOwnerForCompany,
  deriveDominantDomain,
  findCompanyByDomain,
  getCompanyBasics,
  updateCompany,
  createCompany,
  PUBLIC_EMAIL_DOMAINS,
  AMBIGUOUS_CORPORATE_DOMAINS
};
