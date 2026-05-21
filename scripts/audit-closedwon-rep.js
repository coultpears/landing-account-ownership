'use strict';

/**
 * audit-closedwon-rep.js — READ-ONLY. Tests ownership rule #4:
 *   "If a rep has a Closed-Won deal on a company, that rep retains the company
 *    and every future deal on it — regardless of territory."
 *
 * For every CoStar-created deal in the window, find the company's Closed-Won
 * deal(s). If one exists, the created deal's owner MUST equal the most-recent
 * Closed-Won deal's owner. Any mismatch is a rule-#4 violation.
 *
 * Output: /tmp/costar-closedwon-rep.json
 */

const fs  = require('fs');
const hsx = require('../src/costar-sync/hs-extra');
const { apiRequest } = hsx;

const AP_PIPELINE_ID = '64402505';
const WINDOW_START = Date.parse(process.argv[2] || '2026-04-25T00:00:00Z');

const DEAL_PROPS = ['dealname','dealstage','pipeline','hubspot_owner_id','createdate',
                    'closedate','property_name','property_city','property_state',
                    'costar_last_synced','costar_market','costar_property_type',
                    'asset_class','costar_year_built'];

async function getOwners() {
  const map = {};
  let after;
  do {
    const r = await apiRequest('GET', `/crm/v3/owners${after ? `?after=${after}` : ''}`);
    for (const o of r.results || []) map[String(o.id)] = `${o.firstName||''} ${o.lastName||''}`.trim() || String(o.id);
    after = r.paging?.next?.after;
  } while (after);
  return map;
}

async function getClosedWonStages() {
  const ids = new Set(), named = {};
  const pl = await apiRequest('GET', '/crm/v3/pipelines/deals');
  for (const p of pl.results || []) for (const s of p.stages || [])
    if (Number(s?.metadata?.probability) === 1) { ids.add(s.id); named[s.id] = `${p.label}/${s.label}`; }
  return { ids, named };
}

async function searchCreated() {
  const out = [];
  let after;
  do {
    const r = await apiRequest('POST', '/crm/v3/objects/deals/search', {
      filterGroups: [{ filters: [
        { propertyName: 'pipeline',   operator: 'EQ',  value: AP_PIPELINE_ID },
        { propertyName: 'createdate', operator: 'GTE', value: String(WINDOW_START) }
      ]}],
      properties: DEAL_PROPS,
      sorts: [{ propertyName: 'createdate', direction: 'ASCENDING' }],
      limit: 100, after
    });
    out.push(...(r.results || []));
    after = r.paging?.next?.after;
  } while (after);
  return out;
}

async function companiesForDeal(dealId) {
  try {
    const r = await apiRequest('GET', `/crm/v4/objects/deals/${dealId}/associations/companies?limit=50`);
    return (r.results || []).map(x => String(x.toObjectId)).filter(Boolean);
  } catch { return []; }
}

async function allDealsForCompany(companyId) {
  const ids = [];
  let after;
  do {
    const r = await apiRequest('GET',
      `/crm/v4/objects/companies/${companyId}/associations/deals?limit=500` +
      (after ? `&after=${encodeURIComponent(after)}` : ''));
    for (const x of r.results || []) if (x.toObjectId) ids.push(String(x.toObjectId));
    after = r.paging?.next?.after;
  } while (after);
  if (!ids.length) return [];
  const deals = [];
  for (let i = 0; i < ids.length; i += 100) {
    const r = await apiRequest('POST', '/crm/v3/objects/deals/batch/read', {
      inputs: ids.slice(i, i + 100).map(id => ({ id })),
      properties: DEAL_PROPS
    });
    deals.push(...(r.results || []));
  }
  return deals;
}

async function main() {
  const owners = await getOwners();
  const { ids: cwStages } = await getClosedWonStages();
  const created = (await searchCreated()).filter(d => {
    const p = d.properties || {};
    return !!(p.costar_last_synced || p.costar_market || p.costar_property_type || p.asset_class || p.costar_year_built);
  });
  console.error(`[cw-rep] CoStar-created deals: ${created.length}`);

  // company -> deals (dedupe)
  const dealCompany = {};
  const companyIds = new Set();
  for (const d of created) {
    const cs = await companiesForDeal(d.id);
    dealCompany[d.id] = cs;
    cs.forEach(c => companyIds.add(c));
  }
  const companyDeals = {};
  let n = 0;
  for (const cid of companyIds) {
    companyDeals[cid] = await allDealsForCompany(cid);
    if (++n % 50 === 0) console.error(`[cw-rep] company pull ${n}/${companyIds.size}`);
  }

  const violations = [];
  let companiesWithCW = 0, createdOnCWcompany = 0;
  const cwCompanySeen = new Set();

  for (const d of created) {
    const dp = d.properties || {};
    for (const cid of (dealCompany[d.id] || [])) {
      const won = (companyDeals[cid] || []).filter(x => cwStages.has(x.properties?.dealstage) && x.properties?.hubspot_owner_id);
      if (!won.length) continue;
      if (!cwCompanySeen.has(cid)) { cwCompanySeen.add(cid); companiesWithCW++; }
      createdOnCWcompany++;
      won.sort((a, b) => (Date.parse(b.properties?.closedate||'')||0) - (Date.parse(a.properties?.closedate||'')||0));
      const cwOwner = String(won[0].properties.hubspot_owner_id);
      if (String(dp.hubspot_owner_id || '') !== cwOwner) {
        violations.push({
          createdDealId: d.id,
          createdDealname: dp.dealname,
          createdAt: dp.createdate,
          assignedRep: owners[dp.hubspot_owner_id] || dp.hubspot_owner_id || '(none)',
          shouldBeRep: owners[cwOwner] || cwOwner,
          companyId: cid,
          closedWonDealId: won[0].id,
          closedWonDealname: won[0].properties.dealname,
          closedWonCloseDate: won[0].properties.closedate,
          allClosedWonOnCompany: won.map(w => ({ id: w.id, owner: owners[w.properties.hubspot_owner_id] || w.properties.hubspot_owner_id }))
        });
      }
    }
  }

  const report = {
    generatedAt: new Date().toISOString(),
    windowStart: new Date(WINDOW_START).toISOString(),
    rule: 'Rule #4 — Closed-Won rep retains the company for all future deals',
    totals: {
      costar_created: created.length,
      companies_with_a_closed_won_deal: companiesWithCW,
      created_deals_on_a_closed_won_company: createdOnCWcompany,
      rule4_violations: violations.length
    },
    violations
  };
  fs.writeFileSync('/tmp/costar-closedwon-rep.json', JSON.stringify(report, null, 2));

  console.log('\n=== Closed-Won rep-retention audit (Rule #4) ===');
  console.log(`CoStar-created deals                       : ${created.length}`);
  console.log(`Companies with >=1 Closed-Won deal         : ${companiesWithCW}`);
  console.log(`Created deals landing on such a company    : ${createdOnCWcompany}`);
  console.log(`Rule #4 violations (wrong rep)             : ${violations.length}`);
  console.log('');
  for (const v of violations.slice(0, 50)) {
    console.log(`• ${v.createdDealId} "${v.createdDealname}"`);
    console.log(`    assigned=${v.assignedRep}  should be=${v.shouldBeRep}  (Closed-Won deal ${v.closedWonDealId})`);
  }
  if (violations.length > 50) console.log(`...and ${violations.length - 50} more`);
  console.log('\nFull report: /tmp/costar-closedwon-rep.json');
}

main().catch(e => { console.error('CW-REP AUDIT FAILED:', e); process.exit(1); });
