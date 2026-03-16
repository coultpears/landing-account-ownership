'use strict';

/**
 * audit.js — HubSpot conflict detection
 *
 * For a given rep, finds every company they've touched in HubSpot (via deals,
 * calls, emails, meetings, tasks) and runs each through the ownership
 * resolution engine. Flags any company where the engine assigns a different
 * rep than the one working it.
 *
 * Features:
 *   - Exclusion list (data/config.json) suppresses vendor/tool companies
 *   - Qualification status per company (qualified / unverified / not-mf)
 *   - Last-activity timestamp tracking; conflicts sorted most-recent-first
 */

const fs   = require('fs');
const path = require('path');

const {
  getOwners,
  getPortalId,
  getDealsByOwner,
  getEngagementsByOwner,
  getAssociatedCompanyIds,
  getCompaniesBatch,
  getDealStageLabels,
  getDealStageOrder,
  getAssociatedIds
} = require('./hubspot');

const { resolve } = require('./engine');

// All reps tracked by the resolution engine
const KNOWN_REPS = [
  'Jack Harvey',
  'Xander Williams',
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
// Config
// ---------------------------------------------------------------------------

function loadConfig() {
  try {
    return JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'config.json'), 'utf8'));
  } catch {
    return { excludedCompanies: [], excludedDomains: [], qualifyingIndustries: [], nonMFIndustries: [] };
  }
}

// ---------------------------------------------------------------------------
// Exclusion check
// ---------------------------------------------------------------------------

/**
 * Returns true if the company should be suppressed from conflict reports.
 * Matches on normalised company name (partial) and domain.
 */
function isExcluded(company, config) {
  const props   = company.properties || {};
  const nameLow = (props.name || '').toLowerCase();
  const domain  = (props.domain || '').toLowerCase();

  for (const excl of (config.excludedCompanies || [])) {
    if (nameLow.includes(excl.toLowerCase())) return true;
  }
  for (const excl of (config.excludedDomains || [])) {
    if (domain === excl.toLowerCase()) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Qualification status
// ---------------------------------------------------------------------------

/**
 * Returns one of:
 *   'qualified'   — HubSpot industry field confirms this is likely MF/RE
 *   'unverified'  — industry is blank, can't confirm either way
 *   'not-mf'      — industry is clearly not multifamily
 */
function getQualStatus(industry, config) {
  if (!industry || !industry.trim()) return 'unverified';
  const norm = industry.trim();

  if ((config.qualifyingIndustries || []).some(q => q.toLowerCase() === norm.toLowerCase())) {
    return 'qualified';
  }
  if ((config.nonMFIndustries || []).some(q => q.toLowerCase() === norm.toLowerCase())) {
    return 'not-mf';
  }
  // Unknown industry value — treat as unverified rather than hiding it
  return 'unverified';
}

// ---------------------------------------------------------------------------
// Owner matching
// ---------------------------------------------------------------------------

function normName(s) {
  return s.toLowerCase().replace(/[^a-z\s]/g, '').trim().replace(/\s+/g, ' ');
}

function matchOwner(repName, owners) {
  const repNorm = normName(repName);
  const exact   = owners.find(o =>
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

/**
 * Parse a HubSpot timestamp value to milliseconds since epoch.
 * HubSpot may return a numeric ms string ("1741564800000") or an ISO date
 * string ("2025-03-09T14:30:00.000Z"). parseInt() on an ISO string gives
 * just the year digits, so we handle both formats explicitly.
 */
function parseTs(val) {
  if (!val) return 0;
  const n = Number(val);
  if (!isNaN(n) && n > 1000000000) return n; // looks like a unix-ms timestamp
  const d = new Date(val);
  return isNaN(d.getTime()) ? 0 : d.getTime();
}

// ---------------------------------------------------------------------------
// Core audit function
// ---------------------------------------------------------------------------

/**
 * Audit a single rep.
 *
 * Options:
 *   daysBack      {number}   — lookback window in days (default 90)
 *   allOwners     {object[]} — pre-fetched HubSpot owners
 *   portalId      {string}   — pre-fetched portal ID
 *   qualifiedOnly {boolean}  — when true, omit 'not-mf' companies from conflicts
 *   progress      {function} — progress callback (msg) => void
 *
 * Returns:
 *   { rep, hubspotOwner, daysBack, companies[], conflicts[], excluded, error? }
 */
async function auditRep(repName, {
  daysBack      = 90,
  allOwners,
  portalId,
  qualifiedOnly = false,
  progress
} = {}) {
  const log = progress || (() => {});

  if (!allOwners) allOwners = await getOwners();
  if (!portalId)  portalId  = await getPortalId();

  const config = loadConfig();

  const owner = matchOwner(repName, allOwners);
  if (!owner) {
    const available = allOwners
      .map(o => `${o.firstName || ''} ${o.lastName || ''}`.trim())
      .filter(Boolean).sort().join(', ');
    return {
      rep: repName,
      error: `No HubSpot owner found matching "${repName}".\nAvailable owners: ${available}`,
      companies: [], conflicts: [], excluded: 0
    };
  }

  const ownerId = owner.id;
  log(`  HubSpot owner: ${owner.firstName} ${owner.lastName} (ID: ${ownerId})`);

  // companyId -> { count, lastTs }
  const activityCount = {}; // companyId -> number
  const lastActivity  = {}; // companyId -> ms timestamp

  // High-level activity summary
  const summary = { deals: 0, calls: 0, emails: 0, meetings: 0, tasks: 0, totalActivities: 0 };
  // Deal stage tracking: dealId -> { stage }
  const dealDetails = {};
  // Per-deal activity tracking (from direct associations): dealId -> { calls, emails, meetings, tasks }
  const dealActivityCounts = {};

  const tally = (ids, ts = 0) => {
    for (const id of ids) {
      activityCount[id] = (activityCount[id] || 0) + 1;
      if (ts && (!lastActivity[id] || ts > lastActivity[id])) {
        lastActivity[id] = ts;
      }
    }
  };

  // ── Deals ────────────────────────────────────────────────────────────────
  log(`  Fetching deals...`);
  const deals = await getDealsByOwner(ownerId, daysBack);
  summary.deals = deals.length;
  log(`    ${deals.length} deal${deals.length !== 1 ? 's' : ''}`);

  if (deals.length) {
    const dealMap = await getAssociatedCompanyIds('deals', deals.map(d => d.id));
    const tsByDeal = Object.fromEntries(
      deals.map(d => [d.id, parseTs(d.properties?.hs_lastmodifieddate)])
    );
    for (const deal of deals) {
      dealDetails[deal.id] = { stage: deal.properties?.dealstage || 'unknown' };
      dealActivityCounts[deal.id] = { calls: 0, emails: 0, meetings: 0, tasks: 0 };
    }
    for (const [dealId, companyIds] of Object.entries(dealMap)) {
      tally(companyIds, tsByDeal[dealId] || 0);
    }
  }

  // ── Engagements (for company-level conflict detection) ────────────────────
  // Emails are capped at 200 — HubSpot auto-logs received, sequence, and
  // marketing emails under the rep's owner ID, inflating the count well past
  // 1000. 200 recent emails is enough to identify active companies without
  // pulling in noise. Other types use the default 1000 cap.
  const ENGAGEMENT_CAPS = { calls: 1000, emails: 200, meetings: 1000, tasks: 1000 };

  for (const type of ['calls', 'emails', 'meetings', 'tasks']) {
    log(`  Fetching ${type}...`);
    const cap = ENGAGEMENT_CAPS[type];
    const engagements = await getEngagementsByOwner(type, ownerId, daysBack, cap);
    summary[type] = engagements.length;
    summary.totalActivities += engagements.length;
    const truncated = engagements.length >= cap;
    log(`    ${engagements.length} ${type}${truncated ? ` (capped at ${cap})` : ''}`);

    if (engagements.length) {
      const tsByEng = Object.fromEntries(
        engagements.map(e => [e.id, parseTs(e.properties?.hs_timestamp)])
      );
      const map = await getAssociatedCompanyIds(type, engagements.map(e => e.id));
      for (const [engId, companyIds] of Object.entries(map)) {
        tally(companyIds, tsByEng[engId] || 0);
      }
    }
  }

  // ── Deal-level touchpoints (direct deal → engagement associations) ──────
  const dealIds = Object.keys(dealDetails);
  if (dealIds.length) {
    log(`  Fetching deal-level activity associations...`);
    for (const type of ['calls', 'emails', 'meetings', 'tasks']) {
      const assocMap = await getAssociatedIds('deals', type, dealIds);
      for (const [dealId, engIds] of Object.entries(assocMap)) {
        if (dealActivityCounts[dealId]) {
          dealActivityCounts[dealId][type] = engIds.length;
        }
      }
    }
  }

  // ── Compute per-stage averages ──────────────────────────────────────────
  let stageLabels = {};
  let stageOrder  = {};
  try {
    stageLabels = await getDealStageLabels();
    stageOrder  = await getDealStageOrder();
  } catch { /* use raw IDs */ }

  const stageStats = {}; // stageLabel -> { dealCount, totalActivities }
  for (const [dealId, dd] of Object.entries(dealDetails)) {
    const label = stageLabels[dd.stage] || dd.stage;
    if (!stageStats[label]) stageStats[label] = { dealCount: 0, totalActivities: 0 };
    stageStats[label].dealCount++;
    const dc = dealActivityCounts[dealId] || {};
    stageStats[label].totalActivities += (dc.calls || 0) + (dc.emails || 0) + (dc.meetings || 0) + (dc.tasks || 0);
  }
  // Convert to avg touchpoints per deal
  const stageAverages = {};
  for (const [stage, s] of Object.entries(stageStats)) {
    stageAverages[stage] = {
      deals: s.dealCount,
      avgTouchpoints: s.dealCount > 0 ? Math.round((s.totalActivities / s.dealCount) * 10) / 10 : 0
    };
  }

  // ── Company details ───────────────────────────────────────────────────────
  const companyIds = Object.keys(activityCount);
  log(`  ${companyIds.length} unique companies — fetching details...`);

  const companies = companyIds.length ? await getCompaniesBatch(companyIds) : [];

  // ── Resolution + conflict detection ───────────────────────────────────────
  const conflicts = [];
  const checked   = [];
  let   excluded  = 0;

  for (const company of companies) {
    // Exclusion filter
    if (isExcluded(company, config)) { excluded++; continue; }

    const props      = company.properties || {};
    const name       = props.name || `(ID: ${company.id})`;
    const market     = companyMarket(props);
    const industry   = props.industry || '';
    const activities = activityCount[company.id] || 0;
    const lastTs     = lastActivity[company.id] || null;
    const daysSince  = lastTs ? Math.floor((Date.now() - lastTs) / 86400000) : null;
    const qualStatus = getQualStatus(industry, config);

    // Run through the ownership engine
    const resolution = resolve({ ownerName: name, market, isLeaseUp: false });

    const expected = (Array.isArray(resolution.rep) ? resolution.rep : [resolution.rep])
      .filter(r => r && r !== 'UNASSIGNED');

    const isConflict = expected.length > 0 &&
      !expected.some(r => normName(r) === normName(repName));

    const record = {
      companyId:   company.id,
      companyName: name,
      link:        `https://app.hubspot.com/contacts/${portalId}/company/${company.id}`,
      market:      market || '—',
      industry:    industry || '',
      qualStatus,
      workingRep:  repName,
      expectedRep: expected.join(' / ') || 'UNASSIGNED',
      rule:        resolution.rule,
      activities,
      daysSince,
      conflict:    isConflict
    };

    checked.push(record);
    if (isConflict) {
      // Apply --qualified-only filter: hide confirmed non-MF companies
      if (!qualifiedOnly || qualStatus !== 'not-mf') {
        conflicts.push(record);
      }
    }
  }

  // Sort conflicts: most recent activity first; null timestamps at the end
  conflicts.sort((a, b) => {
    if (a.daysSince === null && b.daysSince === null) return 0;
    if (a.daysSince === null) return 1;
    if (b.daysSince === null) return -1;
    return a.daysSince - b.daysSince;
  });

  return {
    rep: repName, hubspotOwner: owner, daysBack,
    companies: checked, conflicts, excluded,
    summary, stageAverages, stageOrder
  };
}

module.exports = { auditRep, KNOWN_REPS };
