'use strict';

/**
 * Dry-run: AP Sales - Expansions pipeline (HubSpot ID 877479748)
 *
 * For every deal in the pipeline:
 *   1. Pull associated company
 *   2. Use company HQ city/state (NOT property location)
 *   3. Run engine.resolve() to get proposed territory rep
 *   4. Compare to current hubspot_owner_id
 *   5. Flag issues (missing company, missing HQ, multi-rep, Top 50, owner-assignment, etc.)
 *
 * NO WRITES. Outputs JSON + summary.
 */

const fs = require('fs');
const path = require('path');

const {
  apiRequest,
  getOwners
} = require('./src/hubspot');

const { resolve: resolveOwner } = require('./src/engine');

const PIPELINE_ID = '877479748';
const OUT_PATH = path.join(__dirname, '_expansion-dryrun-out.json');

// ---------------------------------------------------------------------------
// Pull all deals in the pipeline (paginated search)
// ---------------------------------------------------------------------------

async function getAllDealsInPipeline(pipelineId) {
  const props = [
    'dealname',
    'dealstage',
    'pipeline',
    'hubspot_owner_id',
    'amount',
    'hs_lastmodifieddate',
    'createdate',
    'closedate',
    'deal_category',
    'city',
    'state_region',
    'property_city',
    'property_state'
  ];
  const results = [];
  let after;
  do {
    const body = {
      filterGroups: [{
        filters: [
          { propertyName: 'pipeline', operator: 'EQ', value: pipelineId }
        ]
      }],
      properties: props,
      limit: 100,
      ...(after !== undefined ? { after } : {})
    };
    const res = await apiRequest('POST', '/crm/v3/objects/deals/search', body);
    const page = res.results || [];
    results.push(...page);
    after = res.paging?.next?.after;
    if (after) await new Promise(r => setTimeout(r, 200));
    process.stdout.write(`\r  pulled ${results.length} deals...`);
  } while (after);
  process.stdout.write('\n');
  return results;
}

// ---------------------------------------------------------------------------
// Batch: deals → company IDs
// ---------------------------------------------------------------------------

async function getDealCompanyIds(dealIds) {
  const map = {};
  const chunkSize = 100;
  for (let i = 0; i < dealIds.length; i += chunkSize) {
    const chunk = dealIds.slice(i, i + chunkSize);
    try {
      const res = await apiRequest(
        'POST',
        '/crm/v4/associations/deals/companies/batch/read',
        { inputs: chunk.map(id => ({ id: String(id) })) }
      );
      for (const item of (res.results || [])) {
        if (item.from?.id && item.to?.length) {
          map[item.from.id] = item.to.map(t => String(t.toObjectId));
        }
      }
    } catch (e) {
      console.error(`  assoc err chunk ${i}: ${e.message}`);
    }
    if (i + chunkSize < dealIds.length) await new Promise(r => setTimeout(r, 200));
  }
  return map;
}

// ---------------------------------------------------------------------------
// Batch: company IDs → company records
// ---------------------------------------------------------------------------

async function getCompaniesBatch(companyIds) {
  const props = ['name', 'city', 'state', 'state_region', 'hubspot_owner_id', 'domain', 'industry'];
  const map = {};
  const chunkSize = 100;
  const uniq = [...new Set(companyIds)];
  for (let i = 0; i < uniq.length; i += chunkSize) {
    const chunk = uniq.slice(i, i + chunkSize);
    try {
      const res = await apiRequest('POST', '/crm/v3/objects/companies/batch/read', {
        properties: props,
        inputs: chunk.map(id => ({ id: String(id) }))
      });
      for (const c of (res.results || [])) {
        map[c.id] = c.properties || {};
      }
    } catch (e) {
      console.error(`  cmp batch err ${i}: ${e.message}`);
    }
    if (i + chunkSize < uniq.length) await new Promise(r => setTimeout(r, 200));
  }
  return map;
}

// ---------------------------------------------------------------------------
// Build owner ID → name lookup
// ---------------------------------------------------------------------------

async function getOwnerLookup() {
  const owners = await getOwners();
  const map = {};
  for (const o of owners) {
    const name = [o.firstName, o.lastName].filter(Boolean).join(' ').trim() || o.email || o.id;
    map[String(o.id)] = name;
  }
  return map;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  // Load .env explicitly (in case main script is run from elsewhere)
  try {
    const envPath = path.join(__dirname, '.env');
    fs.readFileSync(envPath, 'utf8').split(/\r?\n/).forEach(line => {
      const m = line.match(/^([A-Z_][A-Z0-9_]*)\s*=\s*(.+)$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
    });
  } catch {}

  console.log(`\n[1/4] Pulling deals from pipeline ${PIPELINE_ID}...`);
  const deals = await getAllDealsInPipeline(PIPELINE_ID);
  console.log(`  ${deals.length} deals found\n`);

  console.log('[2/4] Fetching deal → company associations...');
  const dealCompanyMap = await getDealCompanyIds(deals.map(d => d.id));
  console.log(`  ${Object.keys(dealCompanyMap).length} deals have at least one company`);
  const dealsNoCompany = deals.filter(d => !dealCompanyMap[d.id]);
  console.log(`  ${dealsNoCompany.length} deals have NO associated company\n`);

  const allCompanyIds = [...new Set(Object.values(dealCompanyMap).flat())];
  console.log(`[3/4] Fetching ${allCompanyIds.length} unique companies...`);
  const companies = await getCompaniesBatch(allCompanyIds);
  console.log(`  ${Object.keys(companies).length} companies fetched\n`);

  console.log('[4/4] Resolving ownership for each deal...');
  const ownerLookup = await getOwnerLookup();

  const rows = [];
  for (const deal of deals) {
    const props = deal.properties || {};
    const dealName = props.dealname || '(unnamed)';
    const currentOwnerId = props.hubspot_owner_id ? String(props.hubspot_owner_id) : null;
    const currentOwnerName = currentOwnerId ? (ownerLookup[currentOwnerId] || `id:${currentOwnerId}`) : '(none)';

    const cmpIds = dealCompanyMap[deal.id] || [];
    const primaryCmp = cmpIds[0] ? companies[cmpIds[0]] : null;
    const cmpName = primaryCmp?.name || null;
    // company HQ — prefer state_region (a HubSpot multifamily-team convention),
    // fall back to state. Per memory: territory uses COMPANY HQ, never property.
    const cmpCity = primaryCmp?.city || null;
    const cmpState = primaryCmp?.state_region || primaryCmp?.state || null;
    const cmpHQ = [cmpCity, cmpState].filter(Boolean).join(' ').trim() || null;

    const issues = [];
    if (cmpIds.length === 0) issues.push('NO_COMPANY');
    if (cmpIds.length > 1) issues.push(`MULTI_COMPANY:${cmpIds.length}`);
    if (cmpIds.length > 0 && !primaryCmp) issues.push('COMPANY_FETCH_FAILED');
    if (primaryCmp && !cmpName) issues.push('COMPANY_NO_NAME');
    if (primaryCmp && !cmpHQ) issues.push('COMPANY_NO_HQ');

    let resolution = null;
    if (cmpName) {
      try {
        resolution = resolveOwner({
          ownerName: cmpName,
          ownerHQ: cmpHQ || undefined,
          // Do NOT pass property market — we only assign by company HQ
        });
      } catch (e) {
        issues.push(`RESOLVE_ERR:${e.message.slice(0, 60)}`);
      }
    }

    let proposedRep = null;
    let proposedRepArr = null;
    if (resolution) {
      if (Array.isArray(resolution.rep)) {
        proposedRepArr = resolution.rep;
        if (resolution.rep.length === 1) proposedRep = resolution.rep[0];
        else if (resolution.rep.length > 1) {
          proposedRep = resolution.rep[0];
          issues.push(`MULTI_REP:${resolution.rep.join('|')}`);
        }
      } else {
        proposedRep = resolution.rep;
      }
      if (!resolution.rep) issues.push('UNASSIGNED');
      if (resolution.warnings && resolution.warnings.length) {
        for (const w of resolution.warnings) issues.push(`WARN:${w.slice(0, 80)}`);
      }
    }

    const changesOwner = proposedRep && proposedRep !== currentOwnerName;

    rows.push({
      dealId: deal.id,
      dealName,
      stage: props.dealstage,
      currentOwnerId,
      currentOwnerName,
      companyIds: cmpIds,
      companyName: cmpName,
      companyCity: cmpCity,
      companyState: cmpState,
      companyHQ: cmpHQ,
      proposedRep,
      proposedRepArr,
      rule: resolution?.rule || null,
      matchedOwner: resolution?.matchedOwner || null,
      changesOwner,
      issues
    });
  }

  fs.writeFileSync(OUT_PATH, JSON.stringify(rows, null, 2));

  // ---- Summary ----
  const totalDeals = rows.length;
  const byProposed = {};
  const byCurrent = {};
  const byRule = {};
  const byIssue = {};
  let willChange = 0;
  let unassigned = 0;

  for (const r of rows) {
    byCurrent[r.currentOwnerName] = (byCurrent[r.currentOwnerName] || 0) + 1;
    if (r.proposedRep) {
      byProposed[r.proposedRep] = (byProposed[r.proposedRep] || 0) + 1;
    } else {
      unassigned++;
    }
    if (r.rule) byRule[r.rule] = (byRule[r.rule] || 0) + 1;
    for (const i of r.issues) {
      const key = i.split(':')[0];
      byIssue[key] = (byIssue[key] || 0) + 1;
    }
    if (r.changesOwner) willChange++;
  }

  console.log('\n========== DRY-RUN SUMMARY ==========\n');
  console.log(`Pipeline:      AP Sales - Expansions (${PIPELINE_ID})`);
  console.log(`Total deals:   ${totalDeals}`);
  console.log(`Will change:   ${willChange} (proposed rep != current owner)`);
  console.log(`Same owner:    ${totalDeals - willChange - unassigned}`);
  console.log(`UNASSIGNED:    ${unassigned} (no proposed rep)\n`);

  console.log('--- Current owners (top 20) ---');
  for (const [name, n] of Object.entries(byCurrent).sort((a, b) => b[1] - a[1]).slice(0, 20)) {
    console.log(`  ${String(n).padStart(5)}  ${name}`);
  }

  console.log('\n--- Proposed reps ---');
  for (const [name, n] of Object.entries(byProposed).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(n).padStart(5)}  ${name}`);
  }

  console.log('\n--- Resolution rules ---');
  for (const [rule, n] of Object.entries(byRule).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(n).padStart(5)}  ${rule}`);
  }

  console.log('\n--- Issues ---');
  for (const [issue, n] of Object.entries(byIssue).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(n).padStart(5)}  ${issue}`);
  }

  console.log(`\nFull row-level output: ${OUT_PATH}`);
  console.log('=====================================\n');
}

main().catch(e => { console.error(e); process.exit(1); });
