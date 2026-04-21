#!/usr/bin/env node
/**
 * For deals that STILL have no contacts after the company-association
 * backfill, the root cause is the company has no contacts at all. Run ZI
 * enrichment for each of those owners to populate contacts.
 *
 * Uses the same runZiEnrichmentForOwner() function the ingest calls, so
 * behavior matches: owner-priority title keywords, top 20 pull, dedup on
 * email/name, fan-out to every deal.
 *
 * Modes: --dry-run (default), --execute
 */
'use strict';

require('dotenv').config();
const fs = require('fs');
const hsx = require('../src/costar-sync/hs-extra');
const pdfIngest = require('../src/costar-sync/pdf-ingest');

const DRY_RUN = !process.argv.includes('--execute');

async function main() {
  // Find all still-contactless CoStar-touched deals
  const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
  const deals = [];
  let after;
  do {
    const res = await hsx.apiRequest('POST', '/crm/v3/objects/deals/search', {
      filterGroups: [{ filters: [{ propertyName: 'costar_last_synced', operator: 'GTE', value: String(cutoff) }] }],
      properties: ['dealname','company_name','hubspot_owner_id','costar_last_synced'],
      limit: 100, ...(after ? { after } : {})
    });
    deals.push(...(res.results || []));
    after = res.paging?.next?.after;
    if (after) await new Promise(r => setTimeout(r, 150));
  } while (after);

  const seen = new Set();
  for (let i = 0; i < deals.length; i += 100) {
    const chunk = deals.slice(i, i + 100);
    const r = await hsx.apiRequest('POST', '/crm/v4/associations/deals/contacts/batch/read', {
      inputs: chunk.map(d => ({ id: String(d.id) }))
    });
    for (const entry of (r.results || [])) seen.add(String(entry.from.id));
  }
  const contactless = deals.filter(d => !seen.has(String(d.id)));
  console.log(`[zi-backfill] Still contactless after assoc-backfill: ${contactless.length}`);

  // Group by company (so we only call ZI once per owner)
  const dealToCompany = await hsx.getDealCompanies(contactless.map(d => String(d.id)));
  const companyToDeals = {};
  const companyOwnerName = {};
  const companyRepId = {};
  for (const d of contactless) {
    const coIds = dealToCompany[d.id] || [];
    for (const coId of coIds) {
      companyToDeals[coId] = companyToDeals[coId] || [];
      companyToDeals[coId].push(String(d.id));
      companyRepId[coId] = d.properties?.hubspot_owner_id;
      companyOwnerName[coId] = d.properties?.company_name;
    }
  }
  const uniqueCoIds = Object.keys(companyToDeals);
  console.log(`[zi-backfill] Unique owner companies to enrich: ${uniqueCoIds.length}`);

  // Also fetch company name (ZI needs it to search)
  for (let i = 0; i < uniqueCoIds.length; i += 100) {
    const chunk = uniqueCoIds.slice(i, i + 100);
    const r = await hsx.apiRequest('POST', '/crm/v3/objects/companies/batch/read', {
      inputs: chunk.map(id => ({ id: String(id) })),
      properties: ['name']
    });
    for (const c of (r.results || [])) {
      if (c.properties?.name) companyOwnerName[c.id] = c.properties.name;
    }
  }

  console.log(`\n=== PLAN ===`);
  console.log(`Will run ZI for ${uniqueCoIds.length} owner companies.`);
  console.log('Sample (first 10):');
  for (const coId of uniqueCoIds.slice(0, 10)) {
    console.log(`  • ${coId} ${companyOwnerName[coId] || '(unknown)'} — ${companyToDeals[coId].length} deal(s), rep: ${companyRepId[coId]}`);
  }
  if (uniqueCoIds.length > 10) console.log(`  … and ${uniqueCoIds.length - 10} more`);

  if (DRY_RUN) {
    console.log('\n[zi-backfill] DRY RUN — no writes. Run with --execute to apply.');
    return;
  }

  console.log(`\n[zi-backfill] Running ZI enrichment…`);
  let totalZiFound = 0, totalCreated = 0, totalAssociated = 0, errs = 0;
  let done = 0;
  for (const coId of uniqueCoIds) {
    const name = companyOwnerName[coId];
    if (!name) { done++; continue; }
    const dealIds = companyToDeals[coId];
    const ownerId = companyRepId[coId];
    try {
      const r = await pdfIngest.runZiEnrichmentForOwner({
        ownerName: name,
        companyId: coId,
        dealIds,
        dealOwnerId: ownerId,
        dryRun: false
      });
      totalZiFound += r.ziFound || 0;
      totalCreated += r.created || 0;
      totalAssociated += r.associated || 0;
      if (r.errors?.length) errs += r.errors.length;
    } catch (e) { errs++; console.error('ZI err for', name, ':', e.message.slice(0, 100)); }
    done++;
    if (done % 25 === 0) console.error(`  ... ${done}/${uniqueCoIds.length} owners processed`);
  }
  console.log(`\n[zi-backfill] Complete.`);
  console.log(`  ZI contacts found  : ${totalZiFound}`);
  console.log(`  New contacts created: ${totalCreated}`);
  console.log(`  Associations made   : ${totalAssociated}`);
  console.log(`  Errors              : ${errs}`);
}

main().catch(e => { console.error('FATAL', e); process.exit(1); });
