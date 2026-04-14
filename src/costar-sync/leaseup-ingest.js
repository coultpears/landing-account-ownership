'use strict';

/**
 * leaseup-ingest.js — Property-level CoStar ingest for Xander's lease-up hunts.
 *
 * Triggered when Xander drops a property-level CoStar export (columns:
 * Property Address, Property Name, True Owner Name, Market Name, City, State,
 * Building Class, Number Of Units, ...) into the sync Slack channel.
 *
 * Per row:
 *   1. Resolve True Owner Name → find or create HubSpot company (dedup)
 *   2. Build conflict note if owner is Top 50 or has an existing owner-level
 *      assignment. Per business rule: Xander still hunts the lease-up, note
 *      the conflict on the deal for awareness.
 *   3. Create/merge a deal named "{Property Name} - Lease Up"
 *      (fall back to "{Property Address} - Lease Up" when name is blank).
 *      Owner = Xander, Stage = New Opportunities, Category = Lease Up.
 *   4. Associate deal to company.
 *
 * After all rows: enrich each UNIQUE owner company once via ZoomInfo. Contact
 * associations attach to company and to the first deal for that owner in this
 * batch (so Taylor has someone to reach on every property, even without a
 * direct per-deal enrichment).
 *
 * Dedup is mandatory on every create path (feedback_hubspot_dedup).
 */

const XLSX    = require('xlsx');
const fs      = require('fs');
const path    = require('path');

const hsx = require('./hs-extra');
const zi  = require('./zoominfo');

const {
  AP_PIPELINE_ID,
  NEW_OPPORTUNITIES_STAGE,
  XANDER_OWNER_ID,
  DEAL_CATEGORY_LEASE_UP,
  apiRequest,
  findOpenDealForCompany,
  createDeal,
  updateDeal,
  createNoteOnDeal,
  deriveDominantDomain,
  findCompanyByDomain,
  findContactByEmail,
  findContactByNameAtCompany,
  createContact,
  associateContactToCompany,
  associateContactToDeal,
  createCompany,
  updateCompany,
  getCompanyBasics
} = hsx;

// Load owner reference data for conflict detection
const OWNERS_JSON_PATH      = path.join(__dirname, '..', '..', 'data', 'owners.json');
const ASSIGNMENTS_JSON_PATH = path.join(__dirname, '..', '..', 'data', 'assignments.json');

let _ownerIndex = null;
function getOwnerIndex() {
  if (_ownerIndex) return _ownerIndex;
  const owners      = JSON.parse(fs.readFileSync(OWNERS_JSON_PATH, 'utf8'));
  const assignments = JSON.parse(fs.readFileSync(ASSIGNMENTS_JSON_PATH, 'utf8'));
  _ownerIndex = {
    top50:            owners.top50 || [],
    ownerAssignments: assignments.ownerAssignments || []
  };
  return _ownerIndex;
}

// ---------------------------------------------------------------------------
// File parsing & schema detection
// ---------------------------------------------------------------------------

const PROPERTY_LEVEL_MARKERS = ['True Owner Name', 'Property Address', 'Property Name'];

function parsePropertyFile(filePath) {
  const wb = XLSX.readFile(filePath);
  const sheet = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(sheet, { defval: '' });
  return rows.filter(r => (r['True Owner Name'] || '').toString().trim());
}

/** Return true if the file is a property-level CoStar export. */
function isPropertyLevelFile(filePath) {
  try {
    const wb = XLSX.readFile(filePath);
    const sheet = wb.Sheets[wb.SheetNames[0]];
    const header = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' })[0] || [];
    const cols = header.map(h => String(h || '').trim());
    return PROPERTY_LEVEL_MARKERS.every(m => cols.includes(m));
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Owner company — find or create (fuzzy name dedup)
// ---------------------------------------------------------------------------

function normName(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[.,'"()&]/g, '')
    .replace(/\b(inc|llc|llp|corp|corporation|company|co|ltd|group|lp|properties|management|realty)\b/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function nameScore(a, b) {
  if (!a || !b) return 0;
  if (a === b) return 1;
  if (a.includes(b) || b.includes(a)) return 0.9;
  const wa = new Set(a.split(' ').filter(w => w.length >= 2));
  const wb = new Set(b.split(' ').filter(w => w.length >= 2));
  if (!wa.size || !wb.size) return 0;
  let overlap = 0;
  for (const w of wa) if (wb.has(w)) overlap++;
  return overlap / Math.max(wa.size, wb.size);
}

async function fetchCompanyContactIds(companyId) {
  try {
    const res = await apiRequest('GET', `/crm/v4/objects/companies/${companyId}/associations/contacts?limit=500`);
    return (res.results || []).map(r => String(r.toObjectId));
  } catch {
    return [];
  }
}

async function searchCompanyByName(name) {
  const res = await apiRequest('POST', '/crm/v3/objects/companies/search', {
    filterGroups: [{ filters: [{ propertyName: 'name', operator: 'CONTAINS_TOKEN', value: name }] }],
    properties:  ['name', 'city', 'state', 'domain'],
    limit: 10
  });
  return res.results || [];
}

/**
 * Find or create an owner company with domain-first dedup.
 *   1. If derivedDomain available → try exact match on domain
 *   2. Fallback: fuzzy match on name (thresholds 0.75 / 0.9 single-word)
 *   3. Create with name + domain + hint city/state if no match found
 * If we match an existing company but it has no domain and we derived one,
 * patch the domain onto the existing record.
 */
async function findOrCreateOwnerCompany(ownerName, { derivedDomain, hintCity, hintState } = {}) {
  const normalized = normName(ownerName);
  if (!normalized) throw new Error('Empty owner name');

  // 1. Domain-first dedup (most reliable — unique per org)
  if (derivedDomain) {
    const match = await findCompanyByDomain(derivedDomain);
    if (match) {
      return {
        companyId: match.id,
        action:    'matched_by_domain',
        matchedBy: 'domain',
        name:      match.properties?.name,
        domain:    derivedDomain
      };
    }
  }

  // 2. Fuzzy name fallback
  const candidates = await searchCompanyByName(ownerName);
  let best = null, bestScore = 0;
  for (const c of candidates) {
    const s = nameScore(normalized, normName(c.properties?.name || ''));
    if (s > bestScore) { bestScore = s; best = c; }
  }
  const nWords = normalized.split(' ').filter(w => w.length >= 2).length;
  const threshold = nWords <= 1 ? 0.9 : 0.75;
  if (best && bestScore >= threshold) {
    // Backfill domain on the matched company if we have one and it's empty
    if (derivedDomain && !best.properties?.domain) {
      try { await updateCompany(best.id, { domain: derivedDomain }); } catch {}
    }
    return {
      companyId: best.id,
      action:    'matched_by_name',
      matchedBy: 'name',
      score:     bestScore,
      name:      best.properties?.name,
      domain:    best.properties?.domain || derivedDomain || null
    };
  }

  // 3. Create new — always include domain if we derived one
  const props = {
    name: ownerName,
    ...(derivedDomain ? { domain: derivedDomain } : {}),
    ...(hintCity      ? { city:   hintCity }      : {}),
    ...(hintState     ? { state:  hintState }     : {})
  };
  const created = await createCompany(props);
  return {
    companyId: created.id,
    action:    'created',
    matchedBy: null,
    name:      ownerName,
    domain:    derivedDomain || null
  };
}

// ---------------------------------------------------------------------------
// Conflict detection — Top 50 or owner-level assignment
// ---------------------------------------------------------------------------

function aliasMatch(query, candidateName, aliases = []) {
  const q = normName(query);
  const names = [candidateName, ...(aliases || [])].map(normName).filter(Boolean);
  return names.some(n => {
    if (!n) return false;
    if (q === n) return true;
    if (q.includes(n) && n.split(' ').length >= 2) return true;
    if (n.includes(q) && q.split(' ').length >= 2) return true;
    return false;
  });
}

function detectConflict(ownerName) {
  const { top50, ownerAssignments } = getOwnerIndex();

  for (const o of top50) {
    if (aliasMatch(ownerName, o.name, o.aliases)) {
      return { kind: 'TOP_50', rep: o.assignedRep || 'Jack Harvey', matched: o.name };
    }
  }
  for (const a of ownerAssignments) {
    if (aliasMatch(ownerName, a.owner, a.aliases)) {
      return { kind: 'OWNER_ASSIGNMENT', rep: a.rep, matched: a.owner };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Deal — create per property
// ---------------------------------------------------------------------------

function buildDealName(row) {
  // Xander's established nomenclature: "{Market}-{Property}/{Owner}"
  // Examples from HubSpot:
  //   "Austin, TX-Encore Lakeside/Grayco Partners, LLC"
  //   "Dallas-Fort Worth, TX-Westbend South/Trademark"
  //   "Houston, TX-The Ava Galleria/"
  const market   = String(row['Market Name'] || '').trim() ||
                   `${String(row['City'] || '').trim()}, ${String(row['State'] || '').trim()}`.replace(/^, $/, '');
  const propName = String(row['Property Name'] || '').trim() ||
                   String(row['Property Address'] || '').trim();
  const owner    = String(row['True Owner Name'] || '').trim();
  return `${market}-${propName}/${owner}`;
}

function buildConflictNoteBody(ownerName, conflict, row) {
  if (!conflict) return null;
  // HubSpot note body accepts HTML. Keep it simple and readable.
  return [
    `<p><strong>Owner conflict flagged at deal creation</strong></p>`,
    `<p><strong>Owner:</strong> ${ownerName}<br>`,
    `<strong>Conflict:</strong> ${conflict.kind} — matches "${conflict.matched}", belongs to ${conflict.rep}<br>`,
    `<strong>Property:</strong> ${row['Property Name'] || row['Property Address'] || '(unnamed)'}<br>`,
    `<strong>Market:</strong> ${row['Market Name'] || `${row['City']}, ${row['State']}`}</p>`,
    `<p>Per business rule: Xander still hunts the lease-up property. ${conflict.rep} retains the owner relationship. Coordinate before outreach.</p>`
  ].join('\n');
}

async function createOrMergeLeaseUpDeal(companyId, row, conflictNote) {
  const dealName = buildDealName(row);

  // Dedup: check for open AP deal on this company
  const existing = await findOpenDealForCompany(companyId);
  if (existing && (existing.properties?.dealname || '').toLowerCase() === dealName.toLowerCase()) {
    const updates = {};
    if (existing.properties?.hubspot_owner_id !== String(XANDER_OWNER_ID)) {
      updates.hubspot_owner_id = String(XANDER_OWNER_ID);
    }
    if (existing.properties?.deal_category !== DEAL_CATEGORY_LEASE_UP) {
      updates.deal_category = DEAL_CATEGORY_LEASE_UP;
    }
    if (Object.keys(updates).length) await updateDeal(existing.id, updates);
    if (conflictNote) await createNoteOnDeal(existing.id, conflictNote);
    return { dealId: existing.id, action: 'merged', name: existing.properties?.dealname };
  }

  const properties = {
    dealname:         dealName,
    pipeline:         AP_PIPELINE_ID,
    dealstage:        NEW_OPPORTUNITIES_STAGE,
    hubspot_owner_id: String(XANDER_OWNER_ID),
    deal_category:    DEAL_CATEGORY_LEASE_UP
  };

  const payload = {
    properties,
    associations: [{
      to:    { id: String(companyId) },
      types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: hsx.ASSOC.DEAL_TO_COMPANY }]
    }]
  };
  const created = await apiRequest('POST', '/crm/v3/objects/deals', payload);
  if (conflictNote) await createNoteOnDeal(created.id, conflictNote);
  return { dealId: created.id, action: 'created', name: dealName };
}

// ---------------------------------------------------------------------------
// Main ingest
// ---------------------------------------------------------------------------

/**
 * Write enriched ZI contacts to HubSpot with dedup.
 * Dedup order: email → name-at-company → create. Associates every contact
 * (new or existing) to the company and to the provided deal.
 */
async function writeContactsToHS(ziContacts, companyId, dealId, dryRun) {
  const out = { created: 0, existing: 0, associated: 0, errors: [] };
  for (const zc of ziContacts) {
    const email     = (zc.email || '').toLowerCase();
    const firstname = zc.firstName || '';
    const lastname  = zc.lastName  || '';
    const title     = zc.jobTitle  || '';
    const phone     = zc.phone || zc.mobilePhone || '';
    const linkedin  = Array.isArray(zc.externalUrls)
      ? (zc.externalUrls.find(u => /linkedin/i.test(u?.url || u)) || {}).url || ''
      : '';

    try {
      let existing = email ? await findContactByEmail(email) : null;
      if (!existing && firstname && lastname) {
        existing = await findContactByNameAtCompany(firstname, lastname, companyId);
      }

      if (existing) {
        out.existing++;
        if (!dryRun) {
          try { await associateContactToCompany(existing.id, companyId); } catch {}
          if (dealId) {
            try { await associateContactToDeal(existing.id, dealId); } catch {}
          }
        }
        out.associated++;
        continue;
      }

      if (dryRun) continue;
      const props = {
        ...(email     ? { email }                       : {}),
        ...(firstname ? { firstname }                   : {}),
        ...(lastname  ? { lastname }                    : {}),
        ...(title     ? { jobtitle: title }             : {}),
        ...(phone     ? { phone }                       : {}),
        ...(linkedin  ? { hs_linkedin_url: linkedin }   : {})
      };
      await createContact(props, { companyId, dealId });
      out.created++;
      out.associated++;
    } catch (e) {
      out.errors.push(`${firstname} ${lastname} (${email}): ${e.message}`);
    }
  }
  return out;
}

async function runLeaseUpIngest(filePath, { dryRun = false, onProgress } = {}) {
  const rows = parsePropertyFile(filePath);
  if (!rows.length) throw new Error('No property rows found (missing True Owner Name)');

  const summary = {
    total:             rows.length,
    dealsCreated:      0,
    dealsMerged:       0,
    conflicts:         0,
    companiesMatched:  0,
    companiesCreated:  0,
    companiesMatchedByDomain: 0,
    domainsBackfilled: 0,
    enrichment: {
      companies:        0,
      contactsCreated:  0,
      contactsLinked:   0,
      ziFound:          0
    },
    details: [],
    errors:  []
  };

  // Group rows by unique owner (normalized name)
  const ownerGroups = new Map();
  for (const row of rows) {
    const owner = String(row['True Owner Name'] || '').trim();
    if (!owner) continue;
    const key = normName(owner);
    if (!ownerGroups.has(key)) ownerGroups.set(key, { ownerName: owner, rows: [] });
    ownerGroups.get(key).rows.push(row);
  }

  let ownerIdx = 0;
  for (const [, group] of ownerGroups) {
    ownerIdx++;
    const { ownerName, rows: ownerRows } = group;
    if (onProgress) onProgress({ current: ownerIdx, total: ownerGroups.size, owner: ownerName });

    try {
      // Step 1 — ZoomInfo enrich for this owner to get contacts + domain hint
      let ziContacts = [];
      try {
        ziContacts = await zi.findRelevantContacts(ownerName, { maxResults: 20 });
      } catch (e) {
        summary.errors.push(`zoominfo (${ownerName}): ${e.message}`);
      }
      summary.enrichment.ziFound += ziContacts.length;
      const derivedDomain = deriveDominantDomain(ziContacts);

      // Step 2 — Find or create owner company (domain-first dedup)
      const firstRow = ownerRows[0];
      let companyInfo;
      if (dryRun) {
        companyInfo = { companyId: null, action: 'would_find_or_create', domain: derivedDomain };
      } else {
        companyInfo = await findOrCreateOwnerCompany(ownerName, {
          derivedDomain,
          hintCity:  firstRow['City'],
          hintState: firstRow['State']
        });
      }
      if (companyInfo.action === 'matched_by_domain') summary.companiesMatchedByDomain++;
      if (companyInfo.action === 'matched_by_name')   summary.companiesMatched++;
      if (companyInfo.action === 'created')           summary.companiesCreated++;

      // Step 3 — Create a deal for each property row of this owner
      const conflict = detectConflict(ownerName);
      if (conflict) summary.conflicts += ownerRows.length;
      const conflictNote = conflict
        ? buildConflictNoteBody(ownerName, conflict, firstRow)  // row-specific details filled per row below
        : null;

      const ownerDealIds = [];
      for (const row of ownerRows) {
        try {
          const perRowNote = conflict ? buildConflictNoteBody(ownerName, conflict, row) : null;
          let dealResult;
          if (dryRun) {
            dealResult = { dealId: null, action: 'would_create', name: buildDealName(row) };
          } else {
            dealResult = await createOrMergeLeaseUpDeal(companyInfo.companyId, row, perRowNote);
          }
          if (dealResult.action === 'created') summary.dealsCreated++;
          if (dealResult.action === 'merged')  summary.dealsMerged++;
          if (dealResult.dealId) ownerDealIds.push(dealResult.dealId);

          summary.details.push({
            owner: ownerName,
            property: row['Property Name'] || row['Property Address'],
            market: row['Market Name'] || `${row['City']}, ${row['State']}`,
            companyId: companyInfo.companyId,
            companyAction: companyInfo.action,
            companyDomain: companyInfo.domain || null,
            dealId: dealResult.dealId,
            dealAction: dealResult.action,
            dealName: dealResult.name,
            conflict: conflict ? `${conflict.kind}: ${conflict.rep} (${conflict.matched})` : null
          });
        } catch (err) {
          summary.errors.push(`${ownerName} / ${row['Property Name'] || row['Property Address']}: ${err.message}`);
        }
      }

      // Step 4 — Write contacts (dedup + create) associated to company and
      // to EVERY lease-up deal just created for this owner in this run.
      if (!dryRun && companyInfo.companyId && ziContacts.length) {
        // Write/dedup each contact once, associated to company + first deal
        const firstDealId = ownerDealIds[0] || null;
        const contactResult = await writeContactsToHS(ziContacts, companyInfo.companyId, firstDealId, false);
        summary.enrichment.companies++;
        summary.enrichment.contactsCreated += contactResult.created;
        summary.enrichment.contactsLinked  += contactResult.associated;
        for (const e of contactResult.errors) summary.errors.push(`${ownerName}: ${e}`);

        // Now fan the same contacts out to the OTHER deals for this owner
        if (ownerDealIds.length > 1) {
          const extraDeals = ownerDealIds.slice(1);
          // Re-fetch contact IDs on the company (includes both newly created
          // and pre-existing). Associate each to the remaining deals.
          const contactIdsOnCompany = await fetchCompanyContactIds(companyInfo.companyId);
          for (const dealId of extraDeals) {
            for (const ctid of contactIdsOnCompany) {
              try { await associateContactToDeal(ctid, dealId); }
              catch (e) { summary.errors.push(`assoc contact ${ctid} → deal ${dealId}: ${e.message}`); }
            }
          }
        }

        if (derivedDomain && companyInfo.action === 'matched_by_name' && !companyInfo.domain) {
          summary.domainsBackfilled++;
        }
      }
    } catch (err) {
      summary.errors.push(`owner ${ownerName}: ${err.message}`);
    }
  }

  return summary;
}

module.exports = {
  runLeaseUpIngest,
  isPropertyLevelFile,
  parsePropertyFile,
  detectConflict,
  buildDealName
};
