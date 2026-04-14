'use strict';

/**
 * backfill-new-opps.js — One-shot enrichment for existing deals in
 * AP Pipeline at stage "New Opportunities".
 *
 * For each such deal:
 *   1. Resolve associated company
 *   2. Run ZoomInfo contact enrichment with dedup (same logic as lease-up flow)
 *   3. Associate new/existing contacts to the company + deal
 *
 * Does NOT change deal owner, category, or stage — purely contact enrichment.
 *
 * Usage:
 *   node src/costar-sync/backfill-new-opps.js                # live
 *   node src/costar-sync/backfill-new-opps.js --dry-run      # preview
 *   node src/costar-sync/backfill-new-opps.js --limit 5      # first 5 deals
 */

const hsx = require('./hs-extra');
const { enrichCompanyContacts } = require('./leaseup');

const {
  AP_PIPELINE_ID,
  NEW_OPPORTUNITIES_STAGE,
  apiRequest,
  searchDealsByPipelineAndStage,
  getDealCompanies
} = hsx;

function parseArgs(argv) {
  const out = { dryRun: false, limit: Infinity, offset: 0, concurrency: 4 };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--dry-run' || argv[i] === '-n') out.dryRun = true;
    else if (argv[i] === '--limit')       out.limit       = parseInt(argv[++i], 10) || Infinity;
    else if (argv[i] === '--offset')      out.offset      = parseInt(argv[++i], 10) || 0;
    else if (argv[i] === '--concurrency') out.concurrency = parseInt(argv[++i], 10) || 4;
  }
  return out;
}

// Simple worker-pool: run up to N tasks concurrently, preserving order of results.
async function runWithConcurrency(items, concurrency, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  async function run() {
    while (true) {
      const i = cursor++;
      if (i >= items.length) return;
      try { results[i] = await worker(items[i], i); }
      catch (err) { results[i] = { error: err.message }; }
    }
  }
  await Promise.all(Array.from({ length: concurrency }, run));
  return results;
}

async function resolveCompanyName(companyId) {
  try {
    const res = await apiRequest('GET', `/crm/v3/objects/companies/${companyId}?properties=name`);
    return res.properties?.name || null;
  } catch {
    return null;
  }
}

async function main() {
  const { dryRun, limit, offset, concurrency } = parseArgs(process.argv.slice(2));

  console.log(`\n=== Backfill: New Opportunities → ZoomInfo contact enrichment ===`);
  console.log(`Mode: ${dryRun ? 'DRY RUN (no writes)' : 'LIVE'} | concurrency: ${concurrency}\n`);

  console.log(`Fetching deals in AP Pipeline (${AP_PIPELINE_ID}) at stage "New Opportunities" (${NEW_OPPORTUNITIES_STAGE})…`);
  const deals = await searchDealsByPipelineAndStage(AP_PIPELINE_ID, NEW_OPPORTUNITIES_STAGE);
  console.log(`Found ${deals.length} deals.`);

  const dealIds = deals.map(d => d.id);
  const dealToCompanies = await getDealCompanies(dealIds);

  // Build unique-by-company work list. If a company has multiple open New-Opp
  // deals (rare), we attach enrichment to the first — associating the contact
  // to the company means it's discoverable on the others anyway.
  const seen = new Set();
  const work = [];
  for (const deal of deals) {
    const companyIds = dealToCompanies[deal.id] || [];
    for (const companyId of companyIds) {
      if (seen.has(companyId)) continue;
      seen.add(companyId);
      work.push({ dealId: deal.id, dealName: deal.properties?.dealname, companyId });
    }
  }

  console.log(`Total company-deal pairs to process: ${work.length}`);
  const targets = work.slice(offset, offset + (limit === Infinity ? work.length : limit));
  if (offset > 0) console.log(`Skipping first ${offset} per --offset flag.`);
  if (limit !== Infinity) console.log(`Processing ${targets.length} companies (indices ${offset+1}–${offset+targets.length}).\n`);

  const totals = {
    companies: 0,
    ziFound:   0,
    created:   0,
    linked:    0,
    errors:    []
  };

  let done = 0;
  await runWithConcurrency(targets, concurrency, async (t, idx) => {
    const { dealId, dealName, companyId } = t;
    const companyName = await resolveCompanyName(companyId);
    if (!companyName) {
      done++;
      console.log(`[${done}/${targets.length}] Skip company ${companyId} (no name on record)`);
      return;
    }

    try {
      const res = await enrichCompanyContacts(companyId, companyName, { dealId, dryRun });
      totals.companies++;
      totals.ziFound += res.ziFound;
      totals.created += res.created;
      totals.linked  += res.associated;
      done++;
      console.log(`[${done}/${targets.length}] ${companyName} — ZI:${res.ziFound} exist:${res.existing} created:${res.created} assoc:${res.associated}`);
      for (const e of res.errors) totals.errors.push(`${companyName}: ${e}`);
    } catch (err) {
      done++;
      console.log(`[${done}/${targets.length}] ${companyName} — ERROR: ${err.message}`);
      totals.errors.push(`${companyName}: ${err.message}`);
    }
  });

  console.log(`\n=== Summary ===`);
  console.log(`Companies processed: ${totals.companies}`);
  console.log(`ZoomInfo contacts found (total): ${totals.ziFound}`);
  console.log(`New HS contacts created: ${totals.created}`);
  console.log(`Contacts associated (new + existing): ${totals.linked}`);
  if (totals.errors.length) {
    console.log(`Errors: ${totals.errors.length}`);
    for (const e of totals.errors.slice(0, 20)) console.log(`  - ${e}`);
  }
}

if (require.main === module) {
  main().catch(err => {
    console.error('FATAL:', err.message);
    process.exit(1);
  });
}
