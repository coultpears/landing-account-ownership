'use strict';

/**
 * audit.js — HubSpot conflict detection
 *
 * For a given rep, finds every company they've touched in HubSpot (via deals,
 * calls, emails, meetings, tasks) and runs each through the ownership
 * resolution engine. Flags any company where the engine assigns a different
 * rep than the one working it.
 */

const {
  getOwners,
  getPortalId,
  getDealsByOwner,
  getEngagementsByOwner,
  getAssociatedCompanyIds,
  getCompaniesBatch
} = require('./hubspot');

const { resolve } = require('./engine');

// All reps tracked by the resolution engine
const KNOWN_REPS = [
  'Jack Harvey',
  'Xavier',
  'Jack Thomasson',
  'Wells Davis',
  'John LaVanway',
  'Scout Bishop',
  'Ashtyn Garner',
  'Renato Lagomarsino',
  'Sophia Nadler',
  'Richard Baugh',
  'Raegan Harris',
  'Ghislain Cossio',
  'Nolan Moran'
];

// ---------------------------------------------------------------------------
// Owner matching
// ---------------------------------------------------------------------------

function normName(s) {
  return s.toLowerCase().replace(/[^a-z\s]/g, '').trim().replace(/\s+/g, ' ');
}

/**
 * Find a HubSpot owner object by rep name.
 * Tries exact full-name match, then partial containment.
 */
function matchOwner(repName, owners) {
  const repNorm = normName(repName);
  const exact = owners.find(o =>
    normName(`${o.firstName || ''} ${o.lastName || ''}`) === repNorm
  );
  if (exact) return exact;

  return owners.find(o => {
    const full = normName(`${o.firstName || ''} ${o.lastName || ''}`);
    return full.includes(repNorm) || repNorm.includes(full);
  }) || null;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function companyMarket(props = {}) {
  return [props.city, props.state].filter(Boolean).join(' ') || null;
}

// ---------------------------------------------------------------------------
// Core audit function
// ---------------------------------------------------------------------------

/**
 * Audit a single rep.
 *
 * Options:
 *   daysBack  {number}   — lookback window (default 90)
 *   allOwners {object[]} — pre-fetched HubSpot owners (avoids duplicate fetch in audit-all)
 *   portalId  {string}   — pre-fetched portal ID
 *   progress  {function} — optional logging callback (msg) => void
 *
 * Returns:
 *   { rep, hubspotOwner, daysBack, companies[], conflicts[], error? }
 */
async function auditRep(repName, { daysBack = 90, allOwners, portalId, progress } = {}) {
  const log = progress || (() => {});

  if (!allOwners) allOwners = await getOwners();
  if (!portalId)  portalId  = await getPortalId();

  const owner = matchOwner(repName, allOwners);
  if (!owner) {
    const available = allOwners
      .map(o => `${o.firstName || ''} ${o.lastName || ''}`.trim())
      .filter(Boolean)
      .sort()
      .join(', ');
    return {
      rep: repName,
      error: `No HubSpot owner found matching "${repName}".\nAvailable owners: ${available}`,
      companies: [],
      conflicts: []
    };
  }

  const ownerId = owner.id;
  log(`  HubSpot owner: ${owner.firstName} ${owner.lastName} (ID: ${ownerId})`);

  // companyId -> activity count (each engagement/deal = 1)
  const activityCount = {};

  const tally = (ids) => {
    for (const id of ids) activityCount[id] = (activityCount[id] || 0) + 1;
  };

  // ── Deals ────────────────────────────────────────────────────────────────
  log(`  Fetching deals...`);
  const deals = await getDealsByOwner(ownerId, daysBack);
  log(`    ${deals.length} deal${deals.length !== 1 ? 's' : ''}`);

  if (deals.length) {
    const map = await getAssociatedCompanyIds('deals', deals.map(d => d.id));
    for (const ids of Object.values(map)) tally(ids);
  }

  // ── Engagements ───────────────────────────────────────────────────────────
  for (const type of ['calls', 'emails', 'meetings', 'tasks']) {
    log(`  Fetching ${type}...`);
    const engagements = await getEngagementsByOwner(type, ownerId, daysBack);
    log(`    ${engagements.length} ${type}`);

    if (engagements.length) {
      const map = await getAssociatedCompanyIds(type, engagements.map(e => e.id));
      for (const ids of Object.values(map)) tally(ids);
    }
  }

  // ── Company details ───────────────────────────────────────────────────────
  const companyIds = Object.keys(activityCount);
  log(`  ${companyIds.length} unique companies — fetching details...`);

  const companies = companyIds.length ? await getCompaniesBatch(companyIds) : [];

  // ── Resolution + conflict detection ───────────────────────────────────────
  const conflicts = [];
  const checked   = [];

  for (const company of companies) {
    const name       = company.properties?.name || `(ID: ${company.id})`;
    const market     = companyMarket(company.properties);
    const activities = activityCount[company.id] || 0;

    // Run through the ownership engine (silent — no qualification gate needed here)
    const resolution = resolve({ ownerName: name, market, isLeaseUp: false });

    const expected = (Array.isArray(resolution.rep) ? resolution.rep : [resolution.rep])
      .filter(r => r && r !== 'UNASSIGNED');

    // Conflict: engine assigned someone definitive AND it's not the rep we're auditing
    const isConflict = expected.length > 0 &&
      !expected.some(r => normName(r) === normName(repName));

    const record = {
      companyId:   company.id,
      companyName: name,
      link:        `https://app.hubspot.com/contacts/${portalId}/company/${company.id}`,
      market:      market || '—',
      workingRep:  repName,
      expectedRep: expected.join(' / ') || 'UNASSIGNED',
      rule:        resolution.rule,
      activities,
      conflict:    isConflict
    };

    checked.push(record);
    if (isConflict) conflicts.push(record);
  }

  return { rep: repName, hubspotOwner: owner, daysBack, companies: checked, conflicts };
}

module.exports = { auditRep, KNOWN_REPS };
