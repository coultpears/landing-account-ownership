#!/usr/bin/env node
/**
 * Backfill company HQ fields from CoStar-ingested deal Owner Intel data.
 *
 * Context: until 2026-04-21, the ingest used 'blank_only' policy on company
 * fields — existing companies never got updated with CoStar data, even when
 * CoStar was clearly more accurate (e.g. Asset Living had stale Tampa/FL +
 * wrong domain 'allegiant-carter.com'). Policy flipped to 'overwrite' in
 * pdf-ingest.js. This script retroactively applies CoStar data to every
 * company touched by a recent ingest.
 *
 * Source of truth: the deal's Owner Intel fields (city, state_region,
 * company_hq_address) which contain the CoStar-derived values — they were
 * written even when the associated company was left alone.
 *
 * Logic:
 *   1. Find all deals with costar_last_synced timestamp within --days.
 *   2. For each deal, pull the associated company.
 *   3. Parse deal.company_hq_address -> {street, city, state, zip}.
 *   4. If any of company's {address, city, state, zip, phone, domain} differs
 *      from the deal-derived value, update.
 *   5. Name is NEVER touched.
 *
 * Modes: --dry-run (default), --execute, --days N (default 3).
 * Report: /tmp/hq-backfill-report.json
 */
'use strict';

require('dotenv').config();
const fs = require('fs');
const hsx = require('../src/costar-sync/hs-extra');

const DRY_RUN = !process.argv.includes('--execute');
const DAYS_ARG = process.argv.find(a => a.startsWith('--days='));
const DAYS = DAYS_ARG ? parseInt(DAYS_ARG.slice(7), 10) : 3;

const US_STATE_TO_CODE = {
  'Alabama':'AL','Alaska':'AK','Arizona':'AZ','Arkansas':'AR','California':'CA',
  'Colorado':'CO','Connecticut':'CT','Delaware':'DE','Florida':'FL','Georgia':'GA',
  'Hawaii':'HI','Idaho':'ID','Illinois':'IL','Indiana':'IN','Iowa':'IA','Kansas':'KS',
  'Kentucky':'KY','Louisiana':'LA','Maine':'ME','Maryland':'MD','Massachusetts':'MA',
  'Michigan':'MI','Minnesota':'MN','Mississippi':'MS','Missouri':'MO','Montana':'MT',
  'Nebraska':'NE','Nevada':'NV','New Hampshire':'NH','New Jersey':'NJ','New Mexico':'NM',
  'New York':'NY','North Carolina':'NC','North Dakota':'ND','Ohio':'OH','Oklahoma':'OK',
  'Oregon':'OR','Pennsylvania':'PA','Rhode Island':'RI','South Carolina':'SC',
  'South Dakota':'SD','Tennessee':'TN','Texas':'TX','Utah':'UT','Vermont':'VT',
  'Virginia':'VA','Washington':'WA','West Virginia':'WV','Wisconsin':'WI','Wyoming':'WY',
  'Washington DC':'DC','District of Columbia':'DC'
};

/**
 * Parse the deal's company_hq_address denormalized string back into parts.
 * Format produced by buildDealFields: "{street}, {city}, {state}, {zip}"
 * Handles missing street ("city, state, zip") too.
 */
function parseCompositeHq(composite) {
  if (!composite) return { street: null, city: null, state: null, zip: null };
  const parts = composite.split(',').map(s => s.trim()).filter(Boolean);
  // From the end: zip (numeric), state (2-letter or full), city, rest = street
  let zip = null, state = null, city = null, street = null;
  const isZip = s => /^\d{5}(-\d{4})?$/.test(s);
  const isStateCode = s => /^[A-Z]{2}$/.test(s);
  const isStateName = s => US_STATE_TO_CODE[s] !== undefined;
  if (parts.length && isZip(parts[parts.length - 1])) zip = parts.pop();
  if (parts.length) {
    const last = parts[parts.length - 1];
    if (isStateCode(last)) { state = last; parts.pop(); }
    else if (isStateName(last)) { state = US_STATE_TO_CODE[last]; parts.pop(); }
  }
  if (parts.length) city = parts.pop();
  if (parts.length) street = parts.join(', ');
  return { street, city, state, zip };
}

async function main() {
  const cutoff = Date.now() - DAYS * 24 * 60 * 60 * 1000;
  console.log(`[backfill] mode=${DRY_RUN ? 'DRY-RUN' : 'EXECUTE'}  days=${DAYS}  cutoff=${new Date(cutoff).toISOString()}`);

  // Find all deals with costar_last_synced >= cutoff
  const deals = [];
  let after;
  do {
    const res = await hsx.apiRequest('POST', '/crm/v3/objects/deals/search', {
      filterGroups: [{ filters: [
        { propertyName: 'costar_last_synced', operator: 'GTE', value: String(cutoff) }
      ]}],
      properties: ['dealname', 'city', 'state_region', 'company_hq_address',
                   'hq_location', 'company_name', 'costar_last_synced'],
      limit: 100,
      ...(after ? { after } : {})
    });
    deals.push(...(res.results || []));
    after = res.paging?.next?.after;
    if (after) await new Promise(r => setTimeout(r, 200));
  } while (after);
  console.log(`[backfill] Found ${deals.length} deals with recent CoStar sync`);

  // Map deals → their associated companies
  const dealToCompany = await hsx.getDealCompanies(deals.map(d => String(d.id)));

  // Collect unique company IDs
  const uniqueCoIds = [...new Set(Object.values(dealToCompany).flat())];
  console.log(`[backfill] Unique companies: ${uniqueCoIds.length}`);

  // Pick the most-recent deal per company (for when a company has multiple
  // deals ingested in the window, use the freshest Owner Intel data)
  const companyToBestDeal = {};
  for (const d of deals) {
    const coIds = dealToCompany[d.id] || [];
    for (const coId of coIds) {
      const prev = companyToBestDeal[coId];
      if (!prev || (d.properties?.costar_last_synced || '') > (prev.properties?.costar_last_synced || '')) {
        companyToBestDeal[coId] = d;
      }
    }
  }

  // Batch-fetch existing company data
  const companyData = {};
  const chunkSize = 100;
  for (let i = 0; i < uniqueCoIds.length; i += chunkSize) {
    const chunk = uniqueCoIds.slice(i, i + chunkSize);
    const res = await hsx.apiRequest('POST', '/crm/v3/objects/companies/batch/read', {
      inputs: chunk.map(id => ({ id: String(id) })),
      properties: ['name', 'domain', 'address', 'city', 'state', 'zip', 'phone']
    });
    for (const c of (res.results || [])) companyData[c.id] = c;
  }

  // Build the update plan
  const plan = { updates: [], unchanged: [], errors: [] };
  for (const [coId, deal] of Object.entries(companyToBestDeal)) {
    const co = companyData[coId];
    if (!co) { plan.errors.push({ coId, reason: 'company not found' }); continue; }

    const composite = deal.properties?.company_hq_address;
    const { street: propStreet, city: propCity, state: propState, zip: propZip } = parseCompositeHq(composite);
    const current = co.properties || {};

    const changes = {};
    const meaningful = (a, b) => {
      const na = (a || '').toString().trim();
      const nb = (b || '').toString().trim();
      return nb && na.toLowerCase() !== nb.toLowerCase();
    };
    if (meaningful(current.address, propStreet)) changes.address = propStreet;
    if (meaningful(current.city, propCity))       changes.city    = propCity;
    if (meaningful(current.state, propState))     changes.state   = propState;
    if (meaningful(current.zip, propZip))         changes.zip     = propZip;
    // phone: we don't have it on the deal (not mapped), skip for now
    // domain: we don't have the CoStar-derived domain on the deal either; skip

    if (Object.keys(changes).length) {
      plan.updates.push({
        coId,
        name: current.name,
        changes,
        before: { address: current.address, city: current.city, state: current.state, zip: current.zip },
        sourceDealId: deal.id,
        sourceDealName: deal.properties?.dealname
      });
    } else {
      plan.unchanged.push({ coId, name: current.name });
    }
  }

  console.log(`\n=== PLAN ===`);
  console.log(`Companies to update : ${plan.updates.length}`);
  console.log(`Unchanged           : ${plan.unchanged.length}`);
  console.log(`Errors              : ${plan.errors.length}`);

  if (plan.updates.length) {
    console.log('\nSample updates (first 15):');
    for (const u of plan.updates.slice(0, 15)) {
      console.log(`  • ${u.name} (${u.coId})`);
      for (const [k, v] of Object.entries(u.changes)) {
        console.log(`      ${k}: ${JSON.stringify(u.before[k] || '')} -> ${JSON.stringify(v)}`);
      }
    }
    if (plan.updates.length > 15) console.log(`  … and ${plan.updates.length - 15} more`);
  }

  fs.writeFileSync('/tmp/hq-backfill-report.json', JSON.stringify(plan, null, 2));
  console.log('\nFull report → /tmp/hq-backfill-report.json');

  if (DRY_RUN) {
    console.log('\n[backfill] DRY RUN — no writes. Run with --execute to apply.');
    return;
  }

  console.log(`\n[backfill] Writing ${plan.updates.length} company updates…`);
  const updates = plan.updates.map(u => ({ id: String(u.coId), properties: u.changes }));
  let ok = 0, fail = 0;
  for (let i = 0; i < updates.length; i += 100) {
    const chunk = updates.slice(i, i + 100);
    try {
      await hsx.apiRequest('POST', '/crm/v3/objects/companies/batch/update', { inputs: chunk });
      ok += chunk.length;
    } catch (e) {
      console.error(`[backfill] batch failed (${i}): ${e.message}`);
      fail += chunk.length;
    }
  }
  console.log(`[backfill] Updated ${ok} companies, ${fail} failed.`);
}

main().catch(e => { console.error('FATAL', e); process.exit(1); });
