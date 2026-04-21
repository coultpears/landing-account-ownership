#!/usr/bin/env node
/**
 * Backfill contacts onto every CoStar-touched deal that currently has zero
 * contact associations. Iterates contactless deals; for each:
 *   1. Find the associated company
 *   2. Get ALL the company's contact IDs
 *   3. Batch-associate each contact to the deal
 *
 * Matches what the fixed ingest ZI fan-out does on every run, applied
 * retroactively to deals ingested before the fan-out fix landed.
 *
 * Modes: --dry-run (default), --execute
 */
'use strict';

require('dotenv').config();
const fs = require('fs');
const hsx = require('../src/costar-sync/hs-extra');

const DRY_RUN = !process.argv.includes('--execute');

async function main() {
  // 1. Find all CoStar-touched deals in last 30 days (wider window — catches any the ingest touched)
  const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
  const deals = [];
  let after;
  do {
    const res = await hsx.apiRequest('POST', '/crm/v3/objects/deals/search', {
      filterGroups: [{ filters: [{ propertyName: 'costar_last_synced', operator: 'GTE', value: String(cutoff) }] }],
      properties: ['dealname'],
      limit: 100, ...(after ? { after } : {})
    });
    deals.push(...(res.results || []));
    after = res.paging?.next?.after;
    if (after) await new Promise(r => setTimeout(r, 150));
  } while (after);
  console.log(`[backfill] CoStar-touched deals in window: ${deals.length}`);

  // 2. Check contact associations for each (batch-read; missing = zero contacts)
  const seen = new Set();
  for (let i = 0; i < deals.length; i += 100) {
    const chunk = deals.slice(i, i + 100);
    const r = await hsx.apiRequest('POST', '/crm/v4/associations/deals/contacts/batch/read', {
      inputs: chunk.map(d => ({ id: String(d.id) }))
    });
    for (const entry of (r.results || [])) seen.add(String(entry.from.id));
  }
  const contactless = deals.filter(d => !seen.has(String(d.id))).map(d => ({ id: String(d.id), name: d.properties?.dealname }));
  console.log(`[backfill] Contactless deals: ${contactless.length}`);

  // 3. Pull company for each contactless deal
  const dealToCompany = await hsx.getDealCompanies(contactless.map(d => d.id));
  const uniqueCoIds = [...new Set(Object.values(dealToCompany).flat())];
  console.log(`[backfill] Unique companies: ${uniqueCoIds.length}`);

  // 4. For each company, cache its contact IDs
  const companyContacts = {};
  for (let i = 0; i < uniqueCoIds.length; i++) {
    const coId = uniqueCoIds[i];
    try {
      const r = await hsx.apiRequest('GET', `/crm/v4/objects/companies/${coId}/associations/contacts?limit=500`);
      companyContacts[coId] = (r.results || []).map(x => String(x.toObjectId));
    } catch {
      companyContacts[coId] = [];
    }
    if (i % 50 === 0) console.error(`  ... ${i}/${uniqueCoIds.length} companies`);
  }

  // 5. Build association-pair list
  const pairs = [];
  let noCompany = 0, noCompanyContacts = 0;
  const plan = [];
  for (const d of contactless) {
    const coIds = dealToCompany[d.id] || [];
    if (!coIds.length) { noCompany++; continue; }
    let added = 0;
    for (const coId of coIds) {
      const ctids = companyContacts[coId] || [];
      for (const ctid of ctids) {
        pairs.push({
          from: { id: ctid },
          to:   { id: d.id },
          types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: 4 }]
        });
        added++;
      }
    }
    if (added === 0) noCompanyContacts++;
    else plan.push({ dealId: d.id, dealName: d.name, willAdd: added });
  }

  console.log(`\n=== PLAN ===`);
  console.log(`Contactless deals:                ${contactless.length}`);
  console.log(`  — no company association      : ${noCompany}`);
  console.log(`  — company has zero contacts   : ${noCompanyContacts}`);
  console.log(`  — fixable (company has contacts): ${plan.length}`);
  console.log(`Association pairs to create       : ${pairs.length}`);

  if (plan.length) {
    console.log('\nSample (first 10):');
    for (const p of plan.slice(0, 10)) {
      console.log(`  • ${p.dealId} | ${(p.dealName || '').slice(0, 60)} | +${p.willAdd} contacts`);
    }
    if (plan.length > 10) console.log(`  … and ${plan.length - 10} more deals`);
  }

  fs.writeFileSync('/tmp/contact-backfill-report.json', JSON.stringify({ contactless, plan, noCompany, noCompanyContacts, pair_count: pairs.length }, null, 2));
  console.log('\nFull report → /tmp/contact-backfill-report.json');

  if (DRY_RUN) {
    console.log('\n[backfill] DRY RUN — no writes. Run with --execute to apply.');
    return;
  }

  console.log(`\n[backfill] Writing ${pairs.length} contact→deal associations in batches of 100...`);
  let ok = 0, fail = 0;
  for (let i = 0; i < pairs.length; i += 100) {
    const chunk = pairs.slice(i, i + 100);
    try {
      await hsx.apiRequest('POST', '/crm/v4/associations/contacts/deals/batch/create', { inputs: chunk });
      ok += chunk.length;
    } catch (e) {
      console.error(`[backfill] batch failed (${i}): ${e.message.slice(0, 200)}`);
      // Fall back to per-pair
      for (const p of chunk) {
        try {
          await hsx.apiRequest('PUT', `/crm/v4/objects/contacts/${p.from.id}/associations/default/deals/${p.to.id}`);
          ok++;
        } catch { fail++; }
      }
    }
    if (i % 500 === 0) console.error(`  ... ${i}/${pairs.length} pairs processed`);
  }
  console.log(`[backfill] Created ${ok} associations, ${fail} failed.`);
}

main().catch(e => { console.error('FATAL', e); process.exit(1); });
