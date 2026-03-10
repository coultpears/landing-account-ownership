'use strict';

/**
 * hubspot.js — HubSpot API wrapper
 *
 * Auth: set HUBSPOT_TOKEN in .env or as an environment variable.
 * Get a private app token: HubSpot → Settings → Integrations → Private Apps.
 * Required scopes: crm.objects.companies.read, crm.objects.deals.read,
 *   crm.objects.contacts.read, sales-email-read, crm.objects.owners.read,
 *   crm.schemas.companies.read, crm.associations.read
 *
 * Optionally set HUBSPOT_PORTAL_ID to skip the /account-info API call.
 */

const https = require('https');
const fs    = require('fs');
const path  = require('path');

// ---------------------------------------------------------------------------
// .env loader (no external deps)
// ---------------------------------------------------------------------------

(function loadDotEnv() {
  try {
    const envPath = path.join(__dirname, '..', '.env');
    const lines = fs.readFileSync(envPath, 'utf8').split(/\r?\n/);
    for (const line of lines) {
      const m = line.match(/^([A-Z_][A-Z0-9_]*)\s*=\s*(.+)$/);
      if (m && !process.env[m[1]]) {
        process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
      }
    }
  } catch { /* no .env file is fine */ }
})();

function getToken() {
  const t = process.env.HUBSPOT_TOKEN;
  if (!t) throw new Error(
    'HUBSPOT_TOKEN not set.\n' +
    'Add it to a .env file in the project root, or set it as an environment variable.\n' +
    'Create a private app at: HubSpot → Settings → Integrations → Private Apps\n' +
    'Required scopes: crm.objects.companies.read, crm.objects.deals.read,\n' +
    '  crm.objects.contacts.read, sales-email-read, crm.objects.owners.read,\n' +
    '  crm.associations.read'
  );
  return t;
}

// ---------------------------------------------------------------------------
// Core HTTP helper
// ---------------------------------------------------------------------------

function apiRequest(method, apiPath, body = null) {
  return new Promise((resolve, reject) => {
    const token  = getToken();
    const bodyStr = body ? JSON.stringify(body) : null;

    const options = {
      hostname: 'api.hubapi.com',
      path:     apiPath,
      method,
      headers: {
        Authorization:  `Bearer ${token}`,
        'Content-Type': 'application/json',
        ...(bodyStr ? { 'Content-Length': Buffer.byteLength(bodyStr) } : {})
      }
    };

    const req = https.request(options, res => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        if (res.statusCode >= 400) {
          let msg;
          try { msg = JSON.parse(data).message || data.slice(0, 300); }
          catch { msg = data.slice(0, 300); }
          reject(new Error(`HubSpot ${res.statusCode} ${method} ${apiPath}: ${msg}`));
        } else {
          try { resolve(JSON.parse(data)); }
          catch { resolve(data); }
        }
      });
    });

    req.on('error', reject);
    req.setTimeout(20000, () => { req.destroy(); reject(new Error(`Timeout: ${apiPath}`)); });
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ---------------------------------------------------------------------------
// Paginated search — works for any CRM object type
// ---------------------------------------------------------------------------

async function searchAll(objectType, filterGroups, properties, maxResults = 1000) {
  const results = [];
  let after     = undefined;
  const limit   = 100;

  do {
    const body = {
      filterGroups,
      properties,
      limit,
      ...(after !== undefined ? { after } : {})
    };
    const res  = await apiRequest('POST', `/crm/v3/objects/${objectType}/search`, body);
    const page = res.results || [];
    results.push(...page);
    after = res.paging?.next?.after;
    if (after) await sleep(200); // stay well under rate limit
  } while (after && results.length < maxResults);

  return results;
}

// ---------------------------------------------------------------------------
// Public: Owners
// ---------------------------------------------------------------------------

async function getOwners() {
  const res = await apiRequest('GET', '/crm/v3/owners?limit=500&archived=false');
  return res.results || [];
}

// ---------------------------------------------------------------------------
// Public: Portal ID (for building HubSpot links)
// ---------------------------------------------------------------------------

let _portalId = null;

async function getPortalId() {
  if (_portalId) return _portalId;
  if (process.env.HUBSPOT_PORTAL_ID) {
    _portalId = process.env.HUBSPOT_PORTAL_ID;
    return _portalId;
  }
  const res = await apiRequest('GET', '/account-info/v3/details');
  _portalId = String(res.portalId);
  return _portalId;
}

// ---------------------------------------------------------------------------
// Public: Deals by owner
// ---------------------------------------------------------------------------

async function getDealsByOwner(ownerId, daysBack = 90) {
  const cutoff = Date.now() - daysBack * 24 * 60 * 60 * 1000;
  return searchAll(
    'deals',
    [{ filters: [
      { propertyName: 'hubspot_owner_id',      operator: 'EQ',  value: String(ownerId) },
      { propertyName: 'hs_lastmodifieddate',   operator: 'GTE', value: String(cutoff) }
    ]}],
    ['dealname', 'dealstage', 'hs_lastmodifieddate']
  );
}

// ---------------------------------------------------------------------------
// Public: Engagements (calls / emails / meetings / tasks) by owner
// ---------------------------------------------------------------------------

const ENGAGEMENT_PROPS = {
  calls:    ['hs_call_title', 'hs_timestamp'],
  emails:   ['hs_email_subject', 'hs_timestamp'],
  meetings: ['hs_meeting_title', 'hs_timestamp'],
  tasks:    ['hs_task_subject', 'hs_timestamp']
};

async function getEngagementsByOwner(type, ownerId, daysBack = 90) {
  const cutoff = Date.now() - daysBack * 24 * 60 * 60 * 1000;
  return searchAll(
    type,
    [{ filters: [
      { propertyName: 'hubspot_owner_id', operator: 'EQ',  value: String(ownerId) },
      { propertyName: 'hs_timestamp',     operator: 'GTE', value: String(cutoff) }
    ]}],
    ENGAGEMENT_PROPS[type] || ['hs_timestamp']
  );
}

// ---------------------------------------------------------------------------
// Public: Batch associations — fromType objects → company IDs
// Returns { objectId: [companyId, ...] }
// ---------------------------------------------------------------------------

async function getAssociatedCompanyIds(fromType, fromIds) {
  if (!fromIds.length) return {};

  const result    = {};
  const chunkSize = 100;

  for (let i = 0; i < fromIds.length; i += chunkSize) {
    const chunk = fromIds.slice(i, i + chunkSize);
    try {
      const res = await apiRequest(
        'POST',
        `/crm/v4/associations/${fromType}/companies/batch/read`,
        { inputs: chunk.map(id => ({ id: String(id) })) }
      );
      for (const item of (res.results || [])) {
        if (item.from?.id && item.to?.length) {
          result[item.from.id] = item.to.map(t => String(t.toObjectId));
        }
      }
    } catch {
      // Non-fatal: engagements without company associations return 4xx
    }
    if (i + chunkSize < fromIds.length) await sleep(200);
  }

  return result;
}

// ---------------------------------------------------------------------------
// Public: Batch-read company details
// ---------------------------------------------------------------------------

async function getCompaniesBatch(companyIds) {
  if (!companyIds.length) return [];

  const results    = [];
  const chunkSize  = 100;
  const properties = [
    'name', 'city', 'state', 'country', 'zip',
    'hubspot_owner_id', 'domain', 'industry'
  ];

  for (let i = 0; i < companyIds.length; i += chunkSize) {
    const chunk = companyIds.slice(i, i + chunkSize);
    const res = await apiRequest('POST', '/crm/v3/objects/companies/batch/read', {
      inputs: chunk.map(id => ({ id: String(id) })),
      properties
    });
    results.push(...(res.results || []));
    if (i + chunkSize < companyIds.length) await sleep(200);
  }

  return results;
}

// ---------------------------------------------------------------------------
// Public: Single company read / write (used by fix command)
// ---------------------------------------------------------------------------

async function getCompany(companyId) {
  const props = 'name,city,state,address,zip,country,domain,industry,hubspot_owner_id';
  return apiRequest('GET', `/crm/v3/objects/companies/${companyId}?properties=${props}`);
}

async function updateCompany(companyId, properties) {
  return apiRequest('PATCH', `/crm/v3/objects/companies/${companyId}`, { properties });
}

module.exports = {
  getOwners,
  getPortalId,
  getDealsByOwner,
  getEngagementsByOwner,
  getAssociatedCompanyIds,
  getCompaniesBatch,
  getCompany,
  updateCompany
};
