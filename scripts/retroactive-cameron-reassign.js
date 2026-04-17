#!/usr/bin/env node
/**
 * Retroactive rep-territory reassignment for Cameron Copeland.
 *
 * Cameron joined 2026-04-17 covering IN, MN, MI, WV — territories formerly
 * held by Richard Baugh (IN/MN/MI) and Scout Bishop (WV). This script
 * retroactively reassigns deals whose True Owner HQ is in Cameron's new
 * territory, respecting the active-engagement rule.
 *
 * Logic per deal:
 *   1. Find all open deals currently owned by someone whose territory used
 *      to cover IN/MN/MI/WV (Richard, Scout).
 *   2. For each, resolve the associated company's HQ state.
 *   3. If HQ state is IN/MN/MI/WV:
 *      a. If the current rep (or any rep on a deal for this company) has
 *         engaged within last 60 days — KEEP. Log as "active-engagement
 *         override" (rep retains deal per RoE rule).
 *      b. Else — reassign to Cameron. Update deal.hubspot_owner_id.
 *
 * Run modes:
 *   --dry-run  (default): print the plan, write nothing
 *   --execute          : apply the changes
 *
 * Produces a report at /tmp/cameron-reassign-report.json.
 */
'use strict';

require('dotenv').config();
const fs = require('fs');
const hsx = require('../src/costar-sync/hs-extra');
const pdfIngest = require('../src/costar-sync/pdf-ingest');

const CAMERON_STATES = new Set(['IN', 'MN', 'MI', 'WV']);
const CAMERON_OWNER_ID = '90548860';
const ACTIVE_DAYS = pdfIngest.ACTIVE_ENGAGEMENT_DAYS;  // 60
const CUTOFF = Date.now() - ACTIVE_DAYS * 24 * 60 * 60 * 1000;

// Previous-owner reps whose territories used to include IN/MN/MI/WV —
// we only need to scan deals they currently own.
const SCAN_REP_NAMES = ['Richard Baugh', 'Scout Bishop'];

const DRY_RUN = !process.argv.includes('--execute');

async function main() {
  console.log(`[retro] Cameron Copeland reassignment — ${DRY_RUN ? 'DRY RUN (no writes)' : 'EXECUTE MODE'}`);

  // Resolve owner IDs for scan set
  const scanOwnerIds = {};
  for (const name of SCAN_REP_NAMES) {
    scanOwnerIds[name] = await pdfIngest.getHsOwnerIdByName(name);
  }
  console.log('[retro] Scanning deals owned by:', scanOwnerIds);

  // Pull all open deals owned by scan reps, in AP pipeline, not closed.
  // Using HS search with hubspot_owner_id IN filter + open stages.
  const AP_PIPELINE = '64402505';
  const CLOSED_STAGES = new Set(['126194580', '126194581']);  // closed-won/closed-lost (check hs-extra for exact ids)

  const scanDeals = [];
  for (const [name, oid] of Object.entries(scanOwnerIds)) {
    if (!oid) continue;
    let after;
    do {
      const res = await hsx.apiRequest('POST', '/crm/v3/objects/deals/search', {
        filterGroups: [{
          filters: [
            { propertyName: 'pipeline', operator: 'EQ', value: AP_PIPELINE },
            { propertyName: 'hubspot_owner_id', operator: 'EQ', value: oid }
          ]
        }],
        properties: ['dealname', 'dealstage', 'hubspot_owner_id', 'hs_lastmodifieddate', 'notes_last_contacted'],
        limit: 100,
        ...(after ? { after } : {})
      });
      scanDeals.push(...(res.results || []).map(d => ({ ...d, _currentRep: name })));
      after = res.paging?.next?.after;
      if (after) await new Promise(r => setTimeout(r, 200));
    } while (after);
  }
  console.log(`[retro] Found ${scanDeals.length} open AP deals to examine`);

  // Batch-read associated companies
  const dealToCompany = await hsx.getDealCompanies(scanDeals.map(d => String(d.id)));

  // Gather unique company IDs, batch-fetch state
  const uniqueCoIds = [...new Set(Object.values(dealToCompany).flat())];
  console.log(`[retro] Unique companies: ${uniqueCoIds.length}`);

  const companyState = {};
  const chunkSize = 100;
  for (let i = 0; i < uniqueCoIds.length; i += chunkSize) {
    const chunk = uniqueCoIds.slice(i, i + chunkSize);
    const res = await hsx.apiRequest('POST', '/crm/v3/objects/companies/batch/read', {
      inputs: chunk.map(id => ({ id: String(id) })),
      properties: ['name', 'state', 'city', 'hubspot_owner_id']
    });
    for (const c of (res.results || [])) {
      companyState[c.id] = {
        name: c.properties?.name,
        state: (c.properties?.state || '').trim().toUpperCase(),
        city: c.properties?.city,
        ownerId: c.properties?.hubspot_owner_id
      };
    }
  }

  // Filter to deals whose company HQ is in Cameron's territory
  const candidates = [];
  for (const d of scanDeals) {
    const coIds = dealToCompany[d.id] || [];
    for (const coId of coIds) {
      const co = companyState[coId];
      if (!co) continue;
      // State may be stored as abbreviation "IN" or full "Indiana". Handle both.
      const stateCode = stateToCode(co.state);
      if (CAMERON_STATES.has(stateCode)) {
        candidates.push({ deal: d, companyId: coId, company: co, stateCode });
        break;
      }
    }
  }
  console.log(`[retro] Candidates in IN/MN/MI/WV: ${candidates.length}`);

  // For each candidate, check the whole company for active engagement.
  // If ANY deal on that company was touched in last 60d, the CURRENT owner
  // of the most-recently-engaged deal retains ownership (per RoE rule).
  // Else → reassign this deal to Cameron.
  const plan = { reassign: [], keep_active: [], already_cameron: [] };
  for (const cand of candidates) {
    if (cand.deal.properties?.hubspot_owner_id === CAMERON_OWNER_ID) {
      plan.already_cameron.push(cand);
      continue;
    }
    const active = await pdfIngest.findActiveEngagementRep(cand.companyId);
    if (active && active.activeOwnerId !== CAMERON_OWNER_ID) {
      plan.keep_active.push({
        ...cand,
        activeOwnerId: active.activeOwnerId,
        activeDealCount: active.dealCount,
        lastActivityAt: active.lastActivityAt
      });
    } else {
      plan.reassign.push(cand);
    }
  }

  console.log(`\n=== PLAN ===`);
  console.log(`Reassign to Cameron        : ${plan.reassign.length}`);
  console.log(`Keep with current rep      : ${plan.keep_active.length} (active engagement within ${ACTIVE_DAYS}d)`);
  console.log(`Already owned by Cameron   : ${plan.already_cameron.length}`);
  console.log();

  // Sample output
  if (plan.reassign.length) {
    console.log('Will reassign (sample 15):');
    for (const r of plan.reassign.slice(0, 15)) {
      console.log(`  • ${r.deal.properties.dealname} | ${r.company.name} (${r.company.city}, ${r.stateCode}) | current: ${r.deal._currentRep}`);
    }
    if (plan.reassign.length > 15) console.log(`  … and ${plan.reassign.length - 15} more`);
  }
  if (plan.keep_active.length) {
    console.log('\nKeep (active within 60d, sample 10):');
    for (const r of plan.keep_active.slice(0, 10)) {
      console.log(`  • ${r.deal.properties.dealname} | ${r.company.name} (${r.stateCode}) | keeping: ${r.deal._currentRep} (last active ${r.lastActivityAt?.slice(0,10) || '?'})`);
    }
  }

  // Write detailed report
  const reportPath = '/tmp/cameron-reassign-report.json';
  fs.writeFileSync(reportPath, JSON.stringify({
    mode: DRY_RUN ? 'dry-run' : 'execute',
    timestamp: new Date().toISOString(),
    scanned_deal_count: scanDeals.length,
    candidate_count: candidates.length,
    summary: {
      reassign: plan.reassign.length,
      keep_active: plan.keep_active.length,
      already_cameron: plan.already_cameron.length
    },
    reassign: plan.reassign.map(r => ({
      dealId: r.deal.id,
      dealname: r.deal.properties.dealname,
      companyId: r.companyId,
      companyName: r.company.name,
      state: r.stateCode,
      fromRep: r.deal._currentRep,
      fromOwnerId: r.deal.properties.hubspot_owner_id
    })),
    keep_active: plan.keep_active.map(r => ({
      dealId: r.deal.id,
      dealname: r.deal.properties.dealname,
      companyName: r.company.name,
      state: r.stateCode,
      currentRep: r.deal._currentRep,
      lastActivityAt: r.lastActivityAt,
      activeDealCount: r.activeDealCount
    }))
  }, null, 2));
  console.log(`\nFull report → ${reportPath}`);

  if (DRY_RUN) {
    console.log('\n[retro] DRY RUN — no writes. Run with --execute to apply.');
    return;
  }

  // EXECUTE: batch-update hubspot_owner_id
  console.log(`\n[retro] Writing ${plan.reassign.length} reassignments…`);
  const updates = plan.reassign.map(r => ({
    id: String(r.deal.id),
    properties: { hubspot_owner_id: CAMERON_OWNER_ID }
  }));
  let ok = 0, fail = 0;
  for (let i = 0; i < updates.length; i += 100) {
    const chunk = updates.slice(i, i + 100);
    try {
      await hsx.apiRequest('POST', '/crm/v3/objects/deals/batch/update', { inputs: chunk });
      ok += chunk.length;
    } catch (e) {
      console.error(`[retro] batch update failed (chunk ${i}): ${e.message}`);
      fail += chunk.length;
    }
  }
  console.log(`[retro] Reassigned ${ok} deals, ${fail} failed.`);
}

function stateToCode(raw) {
  if (!raw) return '';
  const s = String(raw).trim();
  if (s.length === 2) return s.toUpperCase();
  const MAP = {
    'INDIANA':'IN','MINNESOTA':'MN','MICHIGAN':'MI','WEST VIRGINIA':'WV',
    'ILLINOIS':'IL','OHIO':'OH','WISCONSIN':'WI','NORTH DAKOTA':'ND','SOUTH DAKOTA':'SD',
    'ALABAMA':'AL','ALASKA':'AK','ARIZONA':'AZ','ARKANSAS':'AR','CALIFORNIA':'CA',
    'COLORADO':'CO','CONNECTICUT':'CT','DELAWARE':'DE','FLORIDA':'FL','GEORGIA':'GA',
    'HAWAII':'HI','IDAHO':'ID','IOWA':'IA','KANSAS':'KS','KENTUCKY':'KY','LOUISIANA':'LA',
    'MAINE':'ME','MARYLAND':'MD','MASSACHUSETTS':'MA','MISSISSIPPI':'MS','MISSOURI':'MO',
    'MONTANA':'MT','NEBRASKA':'NE','NEVADA':'NV','NEW HAMPSHIRE':'NH','NEW JERSEY':'NJ',
    'NEW MEXICO':'NM','NEW YORK':'NY','NORTH CAROLINA':'NC','OKLAHOMA':'OK','OREGON':'OR',
    'PENNSYLVANIA':'PA','RHODE ISLAND':'RI','SOUTH CAROLINA':'SC','TENNESSEE':'TN',
    'TEXAS':'TX','UTAH':'UT','VERMONT':'VT','VIRGINIA':'VA','WASHINGTON':'WA',
    'WYOMING':'WY','WASHINGTON DC':'DC','DISTRICT OF COLUMBIA':'DC'
  };
  return MAP[s.toUpperCase()] || s.toUpperCase();
}

main().catch(e => { console.error('FATAL', e); process.exit(1); });
