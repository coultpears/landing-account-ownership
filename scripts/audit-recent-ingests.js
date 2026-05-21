'use strict';

/**
 * audit-recent-ingests.js — READ-ONLY audit of recent CoStar ingest activity.
 *
 * No writes. Produces /tmp/costar-audit.json + a console summary.
 *
 * Checks:
 *   1. Deals created in the window that duplicate an existing Closed-Won deal
 *      on the same company (property-name token / street overlap).
 *   2. Wrong-rep candidates: created deal owner != Closed-Won rep on the company.
 *   3. Inventory: every AP deal created in the window, with CoStar markers.
 *
 * Usage:  node scripts/audit-recent-ingests.js [windowStartISO]
 */

const fs   = require('fs');
const path = require('path');
const hsx  = require('../src/costar-sync/hs-extra');
const { apiRequest } = hsx;

const AP_PIPELINE_ID = '64402505';
const WINDOW_START = Date.parse(process.argv[2] || '2026-04-25T00:00:00Z');

// Property-name stopwords (mirror of pdf-ingest.js PROPERTY_NAME_STOPWORDS)
const STOP = new Set([
  'the','at','of','and','by','a','an','on','in','de','la','el',
  'apartments','apartment','residences','residence','residential',
  'tower','towers','place','park','plaza','village','villas','villa',
  'lofts','loft','heights','house','homes','home','estates','estate',
  'square','pointe','point','manor','court','centre','center','suites',
  'building','buildings','property','properties','flats','commons',
  'gardens','garden','crossing','landing','run','ridge','hill','hills',
  'creek','grove','vista','view','views','meadows','meadow','springs','spring'
]);

function distinctiveTokens(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/[.,'"()&\/\-]/g, ' ')
    .split(/\s+/)
    .filter(t => t.length >= 3 && !STOP.has(t) && !/^\d+$/.test(t));
}

// Two properties are "likely the same building" if they share a distinctive
// token AND (same street address OR no conflicting street). Conservative:
// shared distinctive token + same state is the floor.
function sameProperty(a, b) {
  const aStreet = (a.property_street_address || '').toLowerCase().replace(/\s+/g, ' ').trim();
  const bStreet = (b.property_street_address || '').toLowerCase().replace(/\s+/g, ' ').trim();
  if (aStreet && bStreet && aStreet === bStreet) return { match: true, basis: 'street' };
  const at = new Set(distinctiveTokens(a.property_name || a.dealname));
  const bt = new Set(distinctiveTokens(b.property_name || b.dealname));
  let shared = [];
  for (const t of at) if (bt.has(t)) shared.push(t);
  if (!shared.length) return { match: false };
  const aState = (a.property_state || '').toUpperCase().trim();
  const bState = (b.property_state || '').toUpperCase().trim();
  const aCity  = (a.property_city  || '').toLowerCase().trim();
  const bCity  = (b.property_city  || '').toLowerCase().trim();
  // shared token + same city = strong; + same state = medium; differing city = weak/flag
  if (aCity && bCity && aCity === bCity) return { match: true, basis: `name+city (${shared.join(',')})` };
  if (aState && bState && aState === bState) return { match: true, basis: `name+state (${shared.join(',')})`, weak: true };
  return { match: false };
}

async function getOwners() {
  const map = {};
  let after;
  do {
    const r = await apiRequest('GET', `/crm/v3/owners${after ? `?after=${after}` : ''}`);
    for (const o of r.results || []) {
      map[String(o.id)] = `${o.firstName || ''} ${o.lastName || ''}`.trim() || o.email || String(o.id);
    }
    after = r.paging?.next?.after;
  } while (after);
  return map;
}

async function getClosedWonStages() {
  const ids = new Set();
  const pl = await apiRequest('GET', '/crm/v3/pipelines/deals');
  const named = {};
  for (const p of pl.results || []) {
    for (const s of p.stages || []) {
      if (Number(s?.metadata?.probability) === 1) { ids.add(s.id); named[s.id] = `${p.label} / ${s.label}`; }
    }
  }
  return { ids, named };
}

const DEAL_PROPS = [
  'dealname','dealstage','pipeline','hubspot_owner_id','createdate','hs_createdate',
  'hs_lastmodifieddate','closedate','property_name','property_city','property_state',
  'property_street_address','property_zip','company_name','costar_last_synced',
  'costar_market','costar_property_type','asset_class','costar_year_built','vacancy__',
  'deal_category','number_of_units'
];

async function searchCreatedDeals() {
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
      limit: 100,
      after
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
    const chunk = ids.slice(i, i + 100);
    const r = await apiRequest('POST', '/crm/v3/objects/deals/batch/read', {
      inputs: chunk.map(id => ({ id })),
      properties: DEAL_PROPS
    });
    deals.push(...(r.results || []));
  }
  return deals;
}

async function main() {
  console.error(`[audit] window start: ${new Date(WINDOW_START).toISOString()}`);
  const owners = await getOwners();
  const { ids: cwStages, named: cwNamed } = await getClosedWonStages();
  console.error(`[audit] closed-won stages: ${[...cwStages].join(', ')}`);

  const created = await searchCreatedDeals();
  console.error(`[audit] AP deals created since window: ${created.length}`);

  // CoStar-attributable = has any costar_* marker populated
  const isCostar = d => {
    const p = d.properties || {};
    return !!(p.costar_last_synced || p.costar_market || p.costar_property_type ||
              p.asset_class || p.costar_year_built);
  };
  const costarCreated = created.filter(isCostar);
  console.error(`[audit] of which CoStar-attributable: ${costarCreated.length}`);

  // Map created deal -> company (dedupe company lookups)
  const dealCompany = {};
  const companyIds = new Set();
  for (const d of costarCreated) {
    const cs = await companiesForDeal(d.id);
    dealCompany[d.id] = cs;
    cs.forEach(c => companyIds.add(c));
  }
  console.error(`[audit] unique companies on created deals: ${companyIds.size}`);

  // Pull every deal on each company once
  const companyDeals = {};
  let n = 0;
  for (const cid of companyIds) {
    companyDeals[cid] = await allDealsForCompany(cid);
    if (++n % 25 === 0) console.error(`[audit] company deal pull ${n}/${companyIds.size}`);
  }

  // CHECK 1+2: created deal duplicates an existing Closed-Won deal on same company
  const closedWonDupes = [];
  const wrongRep = [];
  for (const d of costarCreated) {
    const dp = d.properties || {};
    const row = {
      property_name: dp.property_name, dealname: dp.dealname,
      property_city: dp.property_city, property_state: dp.property_state,
      property_street_address: dp.property_street_address
    };
    const cids = dealCompany[d.id] || [];
    for (const cid of cids) {
      const siblings = companyDeals[cid] || [];
      for (const sib of siblings) {
        if (String(sib.id) === String(d.id)) continue;
        const sp = sib.properties || {};
        if (!cwStages.has(sp.dealstage)) continue;
        const sm = sameProperty(row, {
          property_name: sp.property_name, dealname: sp.dealname,
          property_city: sp.property_city, property_state: sp.property_state,
          property_street_address: sp.property_street_address
        });
        if (sm.match) {
          closedWonDupes.push({
            createdDealId: d.id,
            createdDealname: dp.dealname,
            createdStage: dp.dealstage,
            createdOwner: owners[dp.hubspot_owner_id] || dp.hubspot_owner_id || '(none)',
            createdAt: dp.createdate,
            companyId: cid,
            closedWonDealId: sib.id,
            closedWonDealname: sp.dealname,
            closedWonStage: cwNamed[sp.dealstage] || sp.dealstage,
            closedWonOwner: owners[sp.hubspot_owner_id] || sp.hubspot_owner_id || '(none)',
            closedWonCloseDate: sp.closedate,
            matchBasis: sm.basis,
            weak: !!sm.weak
          });
          // wrong-rep: created deal owner differs from closed-won rep
          if (dp.hubspot_owner_id && sp.hubspot_owner_id &&
              String(dp.hubspot_owner_id) !== String(sp.hubspot_owner_id)) {
            wrongRep.push({
              createdDealId: d.id,
              createdDealname: dp.dealname,
              assignedRep: owners[dp.hubspot_owner_id] || dp.hubspot_owner_id,
              shouldBeRep: owners[sp.hubspot_owner_id] || sp.hubspot_owner_id,
              reason: `company has Closed-Won deal ${sib.id} owned by Closed-Won rep`,
              closedWonDealId: sib.id
            });
          }
        }
      }
    }
  }

  // stage breakdown of created deals
  const stageCount = {};
  for (const d of costarCreated) {
    const s = d.properties?.dealstage || '(none)';
    stageCount[s] = (stageCount[s] || 0) + 1;
  }

  const report = {
    generatedAt: new Date().toISOString(),
    windowStart: new Date(WINDOW_START).toISOString(),
    totals: {
      ap_deals_created: created.length,
      costar_attributable: costarCreated.length,
      unique_companies: companyIds.size,
      closed_won_duplicate_deals: closedWonDupes.length,
      wrong_rep_candidates: wrongRep.length
    },
    created_stage_breakdown: stageCount,
    closed_won_duplicates: closedWonDupes,
    wrong_rep_candidates: wrongRep
  };
  fs.writeFileSync('/tmp/costar-audit.json', JSON.stringify(report, null, 2));

  console.log('\n=== CoStar ingest audit ===');
  console.log(`Window start            : ${report.windowStart}`);
  console.log(`AP deals created        : ${report.totals.ap_deals_created}`);
  console.log(`CoStar-attributable     : ${report.totals.costar_attributable}`);
  console.log(`Unique companies        : ${report.totals.unique_companies}`);
  console.log(`Created-stage breakdown : ${JSON.stringify(stageCount)}`);
  console.log(`\n[BUG 1] Created deals that duplicate a Closed-Won deal: ${closedWonDupes.length}`);
  for (const x of closedWonDupes.slice(0, 40)) {
    console.log(`  • new ${x.createdDealId} "${x.createdDealname}" [${x.createdOwner}]`);
    console.log(`     dup of CLOSED-WON ${x.closedWonDealId} "${x.closedWonDealname}" [${x.closedWonOwner}] — ${x.matchBasis}${x.weak ? ' (weak)' : ''}`);
  }
  if (closedWonDupes.length > 40) console.log(`  ...and ${closedWonDupes.length - 40} more (see /tmp/costar-audit.json)`);
  console.log(`\n[BUG 3] Wrong-rep candidates (created deal owner != Closed-Won rep): ${wrongRep.length}`);
  for (const x of wrongRep.slice(0, 40)) {
    console.log(`  • ${x.createdDealId} "${x.createdDealname}" assigned=${x.assignedRep} shouldBe=${x.shouldBeRep}`);
  }
  console.log(`\nFull report: /tmp/costar-audit.json`);
}

main().catch(e => { console.error('AUDIT FAILED:', e); process.exit(1); });
