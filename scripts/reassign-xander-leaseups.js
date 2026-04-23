#!/usr/bin/env node
/**
 * Retroactive reassignment: Xander is the lease-up specialist. Any deal
 * where the property is Built 2025+ OR has vacancy 25%+ should route to
 * Xander UNLESS the owner is in the Top 50 (Jack Harvey).
 *
 * Scope: all test-stage (1343039756) ingest-created deals. Skips deals
 * already owned by Xander or Jack. Respects active-engagement only insofar
 * as it doesn't override Top-50; lease-up always routes to Xander or Jack.
 *
 * Modes: --dry-run (default), --execute
 */
'use strict';

require('dotenv').config();
const fs = require('fs');
const hsx = require('../src/costar-sync/hs-extra');
const pdfIngest = require('../src/costar-sync/pdf-ingest');
const engine = require('../src/engine');
const assignments = JSON.parse(fs.readFileSync(require('path').join(__dirname, '..', 'data', 'assignments.json'), 'utf8'));

const DRY_RUN = !process.argv.includes('--execute');
const XANDER_OWNER_ID = '80597267';

async function main() {
  console.log(`[lease-up-retro] mode=${DRY_RUN ? 'DRY-RUN' : 'EXECUTE'}`);

  // 1) All test-stage ingest-created deals with CoStar data
  const deals = [];
  let after;
  do {
    const r = await hsx.apiRequest('POST', '/crm/v3/objects/deals/search', {
      filterGroups: [{ filters: [
        { propertyName: 'dealstage', operator: 'EQ', value: '1343039756' },
        { propertyName: 'costar_last_synced', operator: 'HAS_PROPERTY' }
      ]}],
      properties: ['dealname','hubspot_owner_id','company_name','hq_location',
                   'costar_year_built','vacancy__','property_city','property_state'],
      limit: 100, ...(after ? { after } : {})
    });
    deals.push(...(r.results || []));
    after = r.paging?.next?.after;
  } while (after);
  console.log(`[lease-up-retro] Test-stage ingest deals: ${deals.length}`);

  const XanderName = 'Xander Williams';
  const JackName   = 'Jack Harvey';
  const xanderId = await pdfIngest.getHsOwnerIdByName(XanderName);
  const jackId   = await pdfIngest.getHsOwnerIdByName(JackName);

  const reassign = [];
  let alreadyXander = 0, alreadyJack = 0, notLeaseUp = 0;

  for (const d of deals) {
    const year   = Number(d.properties?.costar_year_built);
    const vacRaw = Number(d.properties?.vacancy__);
    const leaseUp = (Number.isFinite(year) && year >= 2025) ||
                    (Number.isFinite(vacRaw) && vacRaw >= 25);
    if (!leaseUp) { notLeaseUp++; continue; }

    const currentOwner = String(d.properties?.hubspot_owner_id || '');
    if (currentOwner === String(xanderId)) { alreadyXander++; continue; }
    if (currentOwner === String(jackId))   { alreadyJack++;   continue; }

    // Determine correct rep via engine with isLeaseUp=true
    const ownerName = d.properties?.company_name || '';
    const hq = d.properties?.hq_location || '';
    const roe = engine.resolve({ ownerName, market: hq, ownerHQ: hq, isLeaseUp: true });
    const repName = Array.isArray(roe.rep) ? roe.rep[0] : roe.rep;
    if (!repName) continue;
    const correctId = repName === XanderName ? xanderId
                    : repName === JackName   ? jackId
                    : await pdfIngest.getHsOwnerIdByName(repName);
    if (!correctId || String(correctId) === currentOwner) continue;

    reassign.push({
      dealId: d.id,
      dealName: d.properties?.dealname,
      fromOwnerId: currentOwner,
      toRep: repName,
      toOwnerId: String(correctId),
      year, vac: vacRaw,
      rule: roe.rule
    });
  }

  console.log(`\n=== PLAN ===`);
  console.log(`Non-lease-up (skipped)    : ${notLeaseUp}`);
  console.log(`Already Xander (skipped)  : ${alreadyXander}`);
  console.log(`Already Jack (skipped)    : ${alreadyJack}`);
  console.log(`To reassign               : ${reassign.length}`);

  // Group by destination
  const byTarget = {};
  for (const r of reassign) byTarget[r.toRep] = (byTarget[r.toRep] || 0) + 1;
  console.log('\nBy target rep:');
  for (const [rep, c] of Object.entries(byTarget).sort((a,b) => b[1] - a[1])) console.log(' ', c, '→', rep);

  console.log('\nSample (first 15):');
  for (const r of reassign.slice(0, 15)) {
    console.log(`  • ${r.dealId} | ${(r.dealName || '').slice(0, 55)} | ${r.fromOwnerId} → ${r.toRep} | built:${r.year || '?'} vac:${r.vac != null ? r.vac + '%' : '?'} | rule:${r.rule}`);
  }

  fs.writeFileSync('/tmp/lease-up-retro-report.json', JSON.stringify({ plan: reassign, notLeaseUp, alreadyXander, alreadyJack }, null, 2));

  if (DRY_RUN) { console.log('\n[lease-up-retro] DRY RUN — no writes.'); return; }

  console.log(`\n[lease-up-retro] Reassigning ${reassign.length} deals…`);
  const updates = reassign.map(r => ({ id: String(r.dealId), properties: { hubspot_owner_id: r.toOwnerId } }));
  let ok = 0, fail = 0;
  for (let i = 0; i < updates.length; i += 100) {
    const chunk = updates.slice(i, i + 100);
    try {
      await hsx.apiRequest('POST', '/crm/v3/objects/deals/batch/update', { inputs: chunk });
      ok += chunk.length;
    } catch (e) { console.error('batch fail', i, e.message.slice(0, 120)); fail += chunk.length; }
  }
  console.log(`[lease-up-retro] Reassigned ${ok}, failed ${fail}.`);
}

main().catch(e => { console.error('FATAL', e); process.exit(1); });
