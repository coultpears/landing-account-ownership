#!/usr/bin/env node
/**
 * Backfill city/state (and street address) on contacts that are missing
 * location data but are associated to companies we have HQ data for.
 *
 * Policy: only fill blank fields on the contact. Never overwrite existing
 * values. Uses the company's HQ address (CoStar-sourced or manually curated)
 * as the fallback source — same pattern the ingest applies on create.
 *
 * Scope: contacts associated to any CoStar-touched deal. Wider than just
 * test stage because location data is useful everywhere.
 *
 * Modes: --dry-run (default), --execute
 */
'use strict';

require('dotenv').config();
const hsx = require('../src/costar-sync/hs-extra');

const DRY_RUN = !process.argv.includes('--execute');

async function main() {
  console.log(`[loc-backfill] mode=${DRY_RUN ? 'DRY-RUN' : 'EXECUTE'}`);

  // All CoStar-touched deals
  const deals = [];
  let after;
  do {
    const r = await hsx.apiRequest('POST', '/crm/v3/objects/deals/search', {
      filterGroups: [{ filters: [{ propertyName: 'costar_last_synced', operator: 'HAS_PROPERTY' }] }],
      properties: ['dealname'],
      limit: 100, ...(after ? { after } : {})
    });
    deals.push(...(r.results || []));
    after = r.paging?.next?.after;
  } while (after);
  console.log(`[loc-backfill] CoStar deals: ${deals.length}`);

  // Collect unique contacts associated to these deals
  const allContactIds = new Set();
  for (let i = 0; i < deals.length; i += 100) {
    const chunk = deals.slice(i, i + 100);
    const r = await hsx.apiRequest('POST', '/crm/v4/associations/deals/contacts/batch/read', {
      inputs: chunk.map(d => ({ id: String(d.id) }))
    });
    for (const e of (r.results || [])) for (const t of (e.to || [])) allContactIds.add(String(t.toObjectId));
  }
  console.log(`[loc-backfill] Unique contacts: ${allContactIds.size}`);

  // Read contact location fields
  const contactProps = {};
  const blankContacts = [];
  const ids = [...allContactIds];
  for (let i = 0; i < ids.length; i += 100) {
    const chunk = ids.slice(i, i + 100);
    const r = await hsx.apiRequest('POST', '/crm/v3/objects/contacts/batch/read', {
      inputs: chunk.map(id => ({ id })),
      properties: ['city','state','address']
    });
    for (const c of (r.results || [])) {
      contactProps[c.id] = c.properties || {};
      const state = (c.properties?.state || '').trim();
      const city  = (c.properties?.city || '').trim();
      if (!state || !city) blankContacts.push(c.id);
    }
  }
  console.log(`[loc-backfill] Contacts needing backfill: ${blankContacts.length}`);

  // For each blank contact, find associated companies and pick the first with HQ data
  const contactToCompanies = {};
  for (let i = 0; i < blankContacts.length; i += 100) {
    const chunk = blankContacts.slice(i, i + 100);
    const r = await hsx.apiRequest('POST', '/crm/v4/associations/contacts/companies/batch/read', {
      inputs: chunk.map(id => ({ id }))
    });
    for (const e of (r.results || [])) contactToCompanies[e.from.id] = (e.to || []).map(t => String(t.toObjectId));
  }
  const allCoIds = [...new Set(Object.values(contactToCompanies).flat())];

  // Read company HQ data
  const companyHQ = {};
  for (let i = 0; i < allCoIds.length; i += 100) {
    const chunk = allCoIds.slice(i, i + 100);
    const r = await hsx.apiRequest('POST', '/crm/v3/objects/companies/batch/read', {
      inputs: chunk.map(id => ({ id: String(id) })),
      properties: ['city','state','address']
    });
    for (const c of (r.results || [])) companyHQ[c.id] = c.properties || {};
  }

  // Build patch list
  const patches = [];
  let noCompany = 0, noHQ = 0;
  for (const ctid of blankContacts) {
    const coIds = contactToCompanies[ctid] || [];
    if (!coIds.length) { noCompany++; continue; }
    // Pick first company with HQ city+state
    let hq = null;
    for (const coId of coIds) {
      const h = companyHQ[coId];
      if (h && (h.city || '').trim() && (h.state || '').trim()) { hq = h; break; }
    }
    if (!hq) { noHQ++; continue; }
    const current = contactProps[ctid] || {};
    const patch = {};
    if (!(current.city || '').trim()  && (hq.city || '').trim())  patch.city  = hq.city.trim();
    if (!(current.state || '').trim() && (hq.state || '').trim()) patch.state = hq.state.trim();
    if (!(current.address || '').trim() && (hq.address || '').trim()) patch.address = hq.address.trim();
    if (Object.keys(patch).length) patches.push({ id: ctid, properties: patch });
  }

  console.log(`\n=== PLAN ===`);
  console.log(`Contacts to patch   : ${patches.length}`);
  console.log(`Skipped no company  : ${noCompany}`);
  console.log(`Skipped no HQ data  : ${noHQ}`);

  if (DRY_RUN) {
    console.log('\nSample (first 5):');
    for (const p of patches.slice(0, 5)) console.log(' •', p.id, '→', JSON.stringify(p.properties));
    console.log('\n[loc-backfill] DRY RUN — no writes.');
    return;
  }

  console.log(`\n[loc-backfill] Writing ${patches.length} patches…`);
  let ok = 0, fail = 0;
  for (let i = 0; i < patches.length; i += 100) {
    const chunk = patches.slice(i, i + 100);
    try {
      await hsx.apiRequest('POST', '/crm/v3/objects/contacts/batch/update', { inputs: chunk });
      ok += chunk.length;
    } catch (e) {
      console.error(`batch fail (${i}): ${e.message.slice(0, 150)}`);
      fail += chunk.length;
    }
    if (i % 500 === 0) console.error(`  …${Math.min(i+100, patches.length)}/${patches.length}`);
  }
  console.log(`[loc-backfill] Updated ${ok}, failed ${fail}.`);
}

main().catch(e => { console.error('FATAL', e); process.exit(1); });
