'use strict';

/**
 * audit-overwrites.js — READ-ONLY. Find deals where the CoStar ingest
 * (INTEGRATION sourceId 33346625) overwrote a rep's CRM_UI value with a
 * DIFFERENT value on a location/identity field. That is the "wrong deal got
 * clobbered" bug (dedup false-match → location override fires on wrong record).
 *
 * Scans pre-existing AP deals (createdate < window) modified during the window.
 * Output: /tmp/costar-overwrites.json
 */

const fs  = require('fs');
const hsx = require('../src/costar-sync/hs-extra');
const { apiRequest } = hsx;

const AP_PIPELINE_ID = '64402505';
const INGEST_SOURCE_ID = '33346625';
const WINDOW_START = Date.parse(process.argv[2] || '2026-04-25T00:00:00Z');
const HIST_FIELDS = ['property_city','property_state','property_street_address',
                     'property_zip','property_name','company_name','dealname'];

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

// Every deal the ingest created OR merged-into gets costar_last_synced stamped.
// Filtering on it returns exactly the ingest-touched set (well under the 10k
// search cap), instead of every AP deal modified in the window.
async function searchIngestTouched() {
  const out = [];
  let after;
  const windowISO = new Date(WINDOW_START).toISOString();
  do {
    const r = await apiRequest('POST', '/crm/v3/objects/deals/search', {
      filterGroups: [{ filters: [
        { propertyName: 'costar_last_synced', operator: 'GTE', value: windowISO }
      ]}],
      properties: ['dealname','dealstage','hubspot_owner_id','createdate'],
      sorts: [{ propertyName: 'costar_last_synced', direction: 'ASCENDING' }],
      limit: 100,
      after
    });
    out.push(...(r.results || []));
    after = r.paging?.next?.after;
  } while (after);
  return out;
}

async function runWithConcurrency(items, limit, worker) {
  let i = 0;
  const run = async () => { while (i < items.length) { const idx = i++; await worker(items[idx], idx); } };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run));
}

async function main() {
  console.error(`[overwrites] window: ${new Date(WINDOW_START).toISOString()}  ingest sourceId: ${INGEST_SOURCE_ID}`);
  const owners = await getOwners();
  const deals = await searchIngestTouched();
  console.error(`[overwrites] ingest-touched deals (costar_last_synced in window): ${deals.length}`);

  const overwrites = [];      // ingest changed a field to a value != prior CRM_UI value
  const ingestTouched = [];   // ingest touched the deal at all (any field)
  let scanned = 0;

  await runWithConcurrency(deals, 5, async (d) => {
    let full;
    try {
      full = await apiRequest('GET',
        `/crm/v3/objects/deals/${d.id}?propertiesWithHistory=${HIST_FIELDS.join(',')}`);
    } catch { return; }
    if (++scanned % 200 === 0) console.error(`[overwrites] scanned ${scanned}/${deals.length}`);
    const hist = full.propertiesWithHistory || {};
    let touched = false;
    const fieldFindings = [];
    for (const field of HIST_FIELDS) {
      const entries = hist[field] || [];   // newest-first
      // index of the most recent ingest write
      const ingestIdx = entries.findIndex(e => e.sourceType === 'INTEGRATION' && String(e.sourceId) === INGEST_SOURCE_ID);
      if (ingestIdx === -1) continue;
      touched = true;
      const ingestEntry = entries[ingestIdx];
      // the value that existed immediately BEFORE the ingest write = entries[ingestIdx+1]
      const prior = entries[ingestIdx + 1];
      if (prior && prior.sourceType === 'CRM_UI' &&
          String(prior.value).trim() !== String(ingestEntry.value).trim()) {
        // ingest clobbered a rep-entered value with a different value
        const current = entries[0];
        fieldFindings.push({
          field,
          repValue: prior.value,
          ingestValue: ingestEntry.value,
          ingestAt: ingestEntry.timestamp,
          repEditedBy: owners[String(prior.sourceId).replace(/^userId:/,'')] || prior.sourceId,
          currentValue: current.value,
          repReverted: String(current.sourceType) === 'CRM_UI' && entries[0] !== ingestEntry &&
                       new Date(current.timestamp) > new Date(ingestEntry.timestamp)
        });
      }
    }
    if (touched) ingestTouched.push(d.id);
    if (fieldFindings.length) {
      overwrites.push({
        dealId: d.id,
        dealname: d.properties?.dealname,
        owner: owners[d.properties?.hubspot_owner_id] || d.properties?.hubspot_owner_id || '(none)',
        stage: d.properties?.dealstage,
        fields: fieldFindings
      });
    }
  });

  // sort: location-field overwrites first (most damaging)
  const LOC = new Set(['property_city','property_state','property_street_address','property_zip']);
  overwrites.sort((a, b) => {
    const al = a.fields.some(f => LOC.has(f.field)) ? 0 : 1;
    const bl = b.fields.some(f => LOC.has(f.field)) ? 0 : 1;
    return al - bl;
  });

  const report = {
    generatedAt: new Date().toISOString(),
    windowStart: new Date(WINDOW_START).toISOString(),
    ingestSourceId: INGEST_SOURCE_ID,
    totals: {
      ingest_touched_scanned: deals.length,
      ingest_touched_confirmed: ingestTouched.length,
      overwrote_rep_value: overwrites.length,
      overwrote_location_field: overwrites.filter(o => o.fields.some(f => LOC.has(f.field))).length
    },
    overwrites
  };
  fs.writeFileSync('/tmp/costar-overwrites.json', JSON.stringify(report, null, 2));

  console.log('\n=== CoStar overwrite audit ===');
  console.log(`Ingest-touched deals scanned             : ${deals.length}`);
  console.log(`Confirmed ingest writes in history       : ${ingestTouched.length}`);
  console.log(`Ingest overwrote a rep (CRM_UI) value    : ${overwrites.length}`);
  console.log(`  of which a LOCATION field              : ${report.totals.overwrote_location_field}`);
  console.log('');
  for (const o of overwrites.slice(0, 50)) {
    console.log(`• ${o.dealId} "${o.dealname}" [${o.owner}]`);
    for (const f of o.fields) {
      const rev = f.repReverted ? '  (rep re-fixed since)' : '  *** STILL WRONG ***';
      console.log(`    ${f.field}: rep="${f.repValue}" -> ingest="${f.ingestValue}"${rev}`);
    }
  }
  if (overwrites.length > 50) console.log(`...and ${overwrites.length - 50} more (see /tmp/costar-overwrites.json)`);
  console.log('\nFull report: /tmp/costar-overwrites.json');
}

main().catch(e => { console.error('OVERWRITE AUDIT FAILED:', e); process.exit(1); });
