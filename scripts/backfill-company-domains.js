#!/usr/bin/env node
/**
 * Backfill company domains for CoStar-touched companies using Clearbit
 * autocomplete. The initial backfill-company-hq-from-costar.js script fixed
 * address/city/state/zip/phone from deal Owner Intel, but domain wasn't on
 * the deal, so some bad domains (e.g. Asset Living → allegiant-carter.com)
 * weren't touched.
 *
 * Logic per company:
 *   1. If current domain passes a token-sanity check vs company name → KEEP.
 *   2. Else → query Clearbit by company name.
 *      a. If Clearbit returns a domain that passes STRICT token sanity
 *         (all query tokens in candidate, no extra tokens), update.
 *      b. Else → leave alone, flag in report for manual review.
 *
 * Scope: same window as the HQ backfill — companies touched by deals with
 * costar_last_synced within --days (default 3).
 *
 * Modes: --dry-run (default), --execute
 * Report: /tmp/domain-backfill-report.json
 */
'use strict';

require('dotenv').config();
const fs = require('fs');
const hsx = require('../src/costar-sync/hs-extra');
const pdfIngest = require('../src/costar-sync/pdf-ingest');

const DRY_RUN = !process.argv.includes('--execute');
const DAYS_ARG = process.argv.find(a => a.startsWith('--days='));
const DAYS = DAYS_ARG ? parseInt(DAYS_ARG.slice(7), 10) : 3;

async function main() {
  const cutoff = Date.now() - DAYS * 24 * 60 * 60 * 1000;
  console.log(`[domain-backfill] mode=${DRY_RUN ? 'DRY-RUN' : 'EXECUTE'}  days=${DAYS}`);

  // Find deals recently synced by CoStar
  const deals = [];
  let after;
  do {
    const res = await hsx.apiRequest('POST', '/crm/v3/objects/deals/search', {
      filterGroups: [{ filters: [
        { propertyName: 'costar_last_synced', operator: 'GTE', value: String(cutoff) }
      ]}],
      properties: ['dealname', 'costar_last_synced'],
      limit: 100,
      ...(after ? { after } : {})
    });
    deals.push(...(res.results || []));
    after = res.paging?.next?.after;
    if (after) await new Promise(r => setTimeout(r, 200));
  } while (after);

  const dealToCompany = await hsx.getDealCompanies(deals.map(d => String(d.id)));
  const uniqueCoIds = [...new Set(Object.values(dealToCompany).flat())];
  console.log(`[domain-backfill] Unique companies touched: ${uniqueCoIds.length}`);

  // Fetch current company state
  const companyData = {};
  for (let i = 0; i < uniqueCoIds.length; i += 100) {
    const chunk = uniqueCoIds.slice(i, i + 100);
    const res = await hsx.apiRequest('POST', '/crm/v3/objects/companies/batch/read', {
      inputs: chunk.map(id => ({ id: String(id) })),
      properties: ['name', 'domain']
    });
    for (const c of (res.results || [])) companyData[c.id] = c;
  }

  const plan = { updates: [], kept_good: [], flagged_unresolved: [] };

  for (const [coId, co] of Object.entries(companyData)) {
    const name = co.properties?.name || '';
    const currentDomain = (co.properties?.domain || '').toLowerCase().trim();
    if (!name) continue;

    // Check if current domain already passes token sanity
    const currentOk = currentDomain &&
      !pdfIngest.AMBIGUOUS_CORPORATE_DOMAINS?.has?.(currentDomain) &&
      pdfIngest.sharesOwnerToken(name, currentDomain.split('.')[0]);

    if (currentOk) {
      plan.kept_good.push({ coId, name, currentDomain });
      continue;
    }

    // Ask Clearbit
    const cb = await pdfIngest.clearbitLookup(name);
    if (cb?.domain &&
        pdfIngest.allQueryTokensInCandidate(name, cb.name || '') &&
        !pdfIngest.candidateHasExtraTokens(name, cb.name || '')) {
      const newDomain = cb.domain.toLowerCase();
      if (newDomain !== currentDomain) {
        plan.updates.push({ coId, name, before: currentDomain || '(blank)', after: newDomain, source: `Clearbit: ${cb.name}` });
      } else {
        plan.kept_good.push({ coId, name, currentDomain });
      }
    } else {
      plan.flagged_unresolved.push({ coId, name, currentDomain, clearbit_returned: cb ? { name: cb.name, domain: cb.domain } : null });
    }
  }

  console.log(`\n=== PLAN ===`);
  console.log(`Updates          : ${plan.updates.length}`);
  console.log(`Kept (domain ok) : ${plan.kept_good.length}`);
  console.log(`Flagged unresolved: ${plan.flagged_unresolved.length}`);

  if (plan.updates.length) {
    console.log('\nSample updates (first 15):');
    for (const u of plan.updates.slice(0, 15)) {
      console.log(`  • ${u.name.padEnd(40)} ${u.before} -> ${u.after}`);
    }
    if (plan.updates.length > 15) console.log(`  … and ${plan.updates.length - 15} more`);
  }
  if (plan.flagged_unresolved.length) {
    console.log('\nSample flagged (Clearbit rejected / no hit, manual curation needed):');
    for (const u of plan.flagged_unresolved.slice(0, 10)) {
      console.log(`  • ${u.name} (current: ${u.currentDomain || '(blank)'})${u.clearbit_returned ? ' | Clearbit: ' + u.clearbit_returned.name + ' → ' + u.clearbit_returned.domain : ''}`);
    }
  }

  fs.writeFileSync('/tmp/domain-backfill-report.json', JSON.stringify(plan, null, 2));
  console.log('\nFull report → /tmp/domain-backfill-report.json');

  if (DRY_RUN) {
    console.log('\n[domain-backfill] DRY RUN — no writes. Run with --execute to apply.');
    return;
  }

  console.log(`\n[domain-backfill] Writing ${plan.updates.length} domain updates…`);
  const updates = plan.updates.map(u => ({ id: String(u.coId), properties: { domain: u.after } }));
  let ok = 0, fail = 0;
  for (let i = 0; i < updates.length; i += 100) {
    const chunk = updates.slice(i, i + 100);
    try {
      await hsx.apiRequest('POST', '/crm/v3/objects/companies/batch/update', { inputs: chunk });
      ok += chunk.length;
    } catch (e) {
      console.error(`[domain-backfill] batch failed (${i}): ${e.message}`);
      fail += chunk.length;
    }
  }
  console.log(`[domain-backfill] Updated ${ok} companies, ${fail} failed.`);
}

main().catch(e => { console.error('FATAL', e); process.exit(1); });
