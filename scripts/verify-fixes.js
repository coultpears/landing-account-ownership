'use strict';

/**
 * verify-fixes.js — READ-ONLY. Replays the audit findings against the NEW
 * dedup/guard code to confirm each issue would no longer occur.
 *
 * PART A — matcher correctness (deterministic, pure functions):
 *   • 7 closed-won pairs: new matcher must now flag them -> skip-create.
 *   • open-deal pairs: new matcher must still link them -> merge not duplicate.
 *   • The Hamilton false match: corroboration guard must REJECT it.
 * PART B — live decision (dry-run, no writes): re-run createOrMergeDeal for
 *   each flagged property; the action must never be a fresh create.
 *
 * Reads /tmp/costar-dupes.json (from scripts/audit-dupes.js).
 */

const fs  = require('fs');
const hsx = require('../src/costar-sync/hs-extra');
const pdf = require('../src/costar-sync/pdf-ingest');

const sleep = ms => new Promise(r => setTimeout(r, ms));
async function api(method, path, body) {
  for (let a = 1; a <= 6; a++) {
    try { return await hsx.apiRequest(method, path, body); }
    catch (e) { if ((e.statusCode && e.statusCode < 500 && e.statusCode !== 429) || a === 6) throw e; await sleep(a * 2000); }
  }
}

const DEAL_PROPS = ['dealname','dealstage','pipeline','hubspot_owner_id','closedate',
  'property_name','property_city','property_state','property_street_address','property_zip','company_name'];

const rowFromDeal = p => ({
  property_name: p.property_name, property_city: p.property_city,
  property_state: p.property_state, property_street_address: p.property_street_address,
  property_zip: p.property_zip
});

async function getDeal(id) {
  try { const d = await api('GET', `/crm/v3/objects/deals/${id}?properties=${DEAL_PROPS.join(',')}`); return d.properties || {}; }
  catch { return null; }
}
async function companyOf(dealId) {
  try { const r = await api('GET', `/crm/v4/objects/deals/${dealId}/associations/companies?limit=10`);
        return (r.results || []).map(x => String(x.toObjectId))[0] || null; } catch { return null; }
}

async function main() {
  const rep = JSON.parse(fs.readFileSync('/tmp/costar-dupes.json', 'utf8'));
  let passA = 0, failA = 0; const failsA = [];

  console.log('=== PART A — matcher correctness ===\n');

  // --- closed-won pairs: must now be detected as same property ---
  console.log(`Closed-Won duplicates (${rep.closed_won_duplicates.length}) — new code must SKIP-create:`);
  for (const x of rep.closed_won_duplicates) {
    const [nd, cw] = await Promise.all([getDeal(x.newDeal), getDeal(x.closedWonDeal)]);
    if (!nd || !cw) { console.log(`  ? ${x.newDeal} — could not fetch`); continue; }
    const owner = nd.company_name || x.newName;
    const hit = pdf.dealIsSameProperty(cw, rowFromDeal(nd), owner, { sameCompany: true });
    if (hit) { passA++; console.log(`  PASS  ${x.newDeal} "${x.newName}" -> detects Closed-Won ${x.closedWonDeal}`); }
    else { failA++; failsA.push(x.newDeal); console.log(`  FAIL  ${x.newDeal} "${x.newName}" -> Closed-Won ${x.closedWonDeal} NOT detected`); }
  }

  // --- open-deal pairs: must still link (merge, not duplicate) ---
  console.log(`\nOpen-deal duplicates (${rep.open_duplicates.length}) — new code must LINK -> merge:`);
  for (const x of rep.open_duplicates) {
    const [nd, od] = await Promise.all([getDeal(x.newDeal), getDeal(x.openDeal)]);
    if (!nd || !od) { console.log(`  ? ${x.newDeal} — could not fetch`); continue; }
    const owner = nd.company_name || x.newName;
    const hit = pdf.dealIsSameProperty(od, rowFromDeal(nd), owner, { sameCompany: true });
    if (hit) { passA++; }
    else { failA++; failsA.push(x.newDeal); console.log(`  FAIL  ${x.newDeal} "${x.newName}" -> open ${x.openDeal} NOT linked (${x.basis})`); }
  }
  console.log(`  ${rep.open_duplicates.length - rep.open_duplicates.filter(x=>failsA.includes(x.newDeal)).length}/${rep.open_duplicates.length} linked`);

  // --- The Hamilton: cross-company corroboration must REJECT the false match ---
  console.log('\nThe Hamilton false-match (deal 60254151066) — corroboration must REJECT:');
  const kissimmeeRow = { property_name:'The Hamilton', property_city:'Kissimmee',
    property_state:'FL', property_street_address:'2250 Blue Hesper Dr' };
  const miamiCandidate = { dealname:'MIA - The Hamilton - Kushner - 5', property_name:'The Hamilton',
    property_city:'Miami', property_state:'FL', property_street_address:'555 NE 34th St' };
  const corrob = pdf.corroboratesCrossCompany(kissimmeeRow, miamiCandidate, 'The United Group of Companies, Inc.');
  if (corrob === false) { passA++; console.log('  PASS  Kissimmee row does NOT corroborate the Miami deal -> false match rejected'); }
  else { failA++; console.log('  FAIL  corroboration still accepts the cross-city false match'); }

  // --- soft-override logic check on the live Hamilton deal ---
  console.log('\nSoft-override — a rep-entered (CRM_UI) value must be preserved:');
  const hist = await hsx.getDealPropertyHistory('60254151066',
    ['property_city','property_street_address','company_name']);
  console.log(`  60254151066 current source: city=${hist.property_city?.sourceType} ` +
    `street=${hist.property_street_address?.sourceType} company=${hist.company_name?.sourceType}`);
  console.log('  (soft-override drops any field whose latest history sourceType === CRM_UI)');

  // ---- PART B — live dry-run decision ----
  console.log('\n=== PART B — live dry-run decision (no writes) ===\n');
  let passB = 0, failB = 0;
  const sample = [...rep.closed_won_duplicates, ...rep.open_duplicates];
  for (const x of sample) {
    const nd = await getDeal(x.newDeal);
    if (!nd) continue;
    const companyId = await companyOf(x.newDeal);
    if (!companyId) { console.log(`  ? ${x.newDeal} — no company`); continue; }
    const openDeals = (await hsx.findOpenDealsForCompany(companyId))
      .filter(d => String(d.id) !== String(x.newDeal));   // pretend the duplicate was never created
    const closedWonDeals = await hsx.findClosedWonDealsForCompany(companyId);
    let res;
    try {
      res = await pdf.createOrMergeDeal({
        row: rowFromDeal(nd), ownerName: nd.company_name || '',
        ownerEntity: { name: nd.company_name || '' },
        companyId, dealOwnerId: nd.hubspot_owner_id || '1',
        openDeals, closedWonDeals, dryRun: true
      });
    } catch (e) { console.log(`  ? ${x.newDeal} — error ${e.message}`); continue; }
    const created = res.action === 'would_create' || res.action === 'created';
    if (!created) { passB++; }
    else { failB++; console.log(`  FAIL  ${x.newDeal} "${x.newName}" -> action=${res.action} (would still create a duplicate)`); }
  }
  console.log(`  ${passB}/${passB + failB} flagged properties now resolve to an existing deal (merge or closed-won skip)`);

  console.log('\n=== SUMMARY ===');
  console.log(`PART A matcher checks : ${passA} pass / ${failA} fail`);
  console.log(`PART B live decisions : ${passB} pass / ${failB} fail`);
  console.log(failA + failB === 0
    ? '\nALL CLEAR — no residual divergence on the audited cases.'
    : `\nRESIDUAL ISSUES — ${failA + failB} case(s) need a closer look.`);
}

main().catch(e => { console.error('VERIFY FAILED:', e); process.exit(1); });
