#!/usr/bin/env node
/**
 * Clean up contacts on test-stage deals to match the refreshed policy:
 *   1. Dissociate off-target contacts (sales, engineer, accounting, clinical, etc.)
 *      from the DEAL. Keep them on the company — reps can still find them there.
 *   2. Enforce 8-contact cap per deal. If a deal has more than 8 target-eligible
 *      contacts, keep the top 8 by location-first + title-priority ranking;
 *      dissociate the rest from the deal.
 *   3. Backfill contact location (city/state) from the associated company's HQ
 *      when the contact has no location data.
 *
 * Only operates on deals with dealstage=1343039756 (test stage) to stay out
 * of production.
 *
 * Modes: --dry-run (default), --execute
 */
'use strict';

require('dotenv').config();
const fs = require('fs');
const hsx = require('../src/costar-sync/hs-extra');
const zi  = require('../src/costar-sync/zoominfo');

const DRY_RUN = !process.argv.includes('--execute');
const MAX_DEAL_CONTACTS = 8;

function selectContactsForDeal(contactIds, contactProps, propState, propCity, cap) {
  const buckets = { cityMatch: [], stateMatch: [], noLocation: [] };
  for (const ctid of contactIds) {
    const p = contactProps[ctid] || {};
    const state = (p.state || '').trim().toUpperCase();
    const city  = (p.city  || '').trim().toLowerCase();
    if (!state) buckets.noLocation.push(ctid);
    else if (state === propState) {
      if (city && city === propCity) buckets.cityMatch.push(ctid);
      else buckets.stateMatch.push(ctid);
    }
    // state set and != propState → excluded from deal
  }
  const rank = (ids) => ids.slice().sort((a, b) => {
    const ta = contactProps[a]?.jobtitle || '';
    const tb = contactProps[b]?.jobtitle || '';
    return zi.titlePriorityScore(ta) - zi.titlePriorityScore(tb);
  });
  return [
    ...rank(buckets.cityMatch),
    ...rank(buckets.stateMatch),
    ...rank(buckets.noLocation)
  ].slice(0, cap);
}

async function main() {
  console.log(`[cleanup] mode=${DRY_RUN ? 'DRY-RUN' : 'EXECUTE'}  cap=${MAX_DEAL_CONTACTS}`);

  // 1) All test-stage deals touched by ingest
  const deals = [];
  let after;
  do {
    const r = await hsx.apiRequest('POST', '/crm/v3/objects/deals/search', {
      filterGroups: [{ filters: [
        { propertyName: 'dealstage', operator: 'EQ', value: '1343039756' },
        { propertyName: 'costar_last_synced', operator: 'HAS_PROPERTY' }
      ]}],
      properties: ['dealname','property_city','property_state'],
      limit: 100, ...(after ? { after } : {})
    });
    deals.push(...(r.results || []));
    after = r.paging?.next?.after;
  } while (after);
  console.log(`[cleanup] Test-stage ingest deals: ${deals.length}`);

  // 2) For each deal, pull associated contacts
  const dealToContacts = {};
  for (let i = 0; i < deals.length; i += 100) {
    const chunk = deals.slice(i, i + 100);
    const r = await hsx.apiRequest('POST', '/crm/v4/associations/deals/contacts/batch/read', {
      inputs: chunk.map(d => ({ id: String(d.id) }))
    });
    for (const e of (r.results || [])) {
      dealToContacts[e.from.id] = (e.to || []).map(t => String(t.toObjectId));
    }
  }
  const allContactIds = [...new Set(Object.values(dealToContacts).flat())];
  console.log(`[cleanup] Unique contacts associated: ${allContactIds.length}`);

  // 3) Read contact props (title, city, state) in batches
  const contactProps = {};
  for (let i = 0; i < allContactIds.length; i += 100) {
    const chunk = allContactIds.slice(i, i + 100);
    const r = await hsx.apiRequest('POST', '/crm/v3/objects/contacts/batch/read', {
      inputs: chunk.map(id => ({ id })),
      properties: ['jobtitle','city','state','address','email']
    });
    for (const c of (r.results || [])) contactProps[c.id] = c.properties || {};
    if (i % 500 === 0) console.error(`  …read ${Math.min(i+100, allContactIds.length)}/${allContactIds.length}`);
  }

  // 4) For each deal, figure out dissociations
  const dissociatePairs = [];
  let dealsChanged = 0, offTargetCount = 0, overflowCount = 0;
  for (const d of deals) {
    const current = (dealToContacts[d.id] || []).filter(ctid => contactProps[ctid]);
    if (!current.length) continue;
    const propState = (d.properties?.property_state || '').trim().toUpperCase();
    const propCity  = (d.properties?.property_city  || '').trim().toLowerCase();

    // Step A: filter by title
    const targetEligible = current.filter(ctid => {
      const title = contactProps[ctid]?.jobtitle;
      if (!title || !title.trim()) return true;
      return zi.titleMatchesTarget(title);
    });
    const offTarget = current.filter(ctid => !targetEligible.includes(ctid));
    offTargetCount += offTarget.length;

    // Step B: from target-eligible, select top MAX using location-first
    const selected = new Set(selectContactsForDeal(targetEligible, contactProps, propState, propCity, MAX_DEAL_CONTACTS));
    const overflow = targetEligible.filter(ctid => !selected.has(ctid));
    overflowCount += overflow.length;

    const toDissociate = [...offTarget, ...overflow];
    if (toDissociate.length) {
      dealsChanged++;
      for (const ctid of toDissociate) dissociatePairs.push({ dealId: String(d.id), contactId: String(ctid) });
    }
  }

  console.log(`\n=== PLAN ===`);
  console.log(`Deals affected           : ${dealsChanged}`);
  console.log(`Total dissociations      : ${dissociatePairs.length}`);
  console.log(`  off-target title       : ${offTargetCount}`);
  console.log(`  overflow (>${MAX_DEAL_CONTACTS} per deal)   : ${overflowCount}`);

  fs.writeFileSync('/tmp/cleanup-report.json', JSON.stringify({ dealsChanged, offTargetCount, overflowCount, pairs_sample: dissociatePairs.slice(0, 100) }, null, 2));
  console.log('\nReport (sampled) → /tmp/cleanup-report.json');

  if (DRY_RUN) {
    console.log('\n[cleanup] DRY RUN — no writes. Run with --execute.');
    return;
  }

  console.log(`\n[cleanup] Removing ${dissociatePairs.length} contact-deal associations…`);
  // HS v4 batch/archive expects: { inputs: [{ from: {id}, to: [{id},...] }] }
  // Group by contact to allow multi-deal-per-contact in one input.
  const byContact = {};
  for (const p of dissociatePairs) {
    byContact[p.contactId] = byContact[p.contactId] || [];
    byContact[p.contactId].push(p.dealId);
  }
  const inputs = Object.entries(byContact).map(([cid, dids]) => ({
    from: { id: cid },
    to:   dids.map(did => ({ id: did }))
  }));
  let ok = 0, fail = 0;
  for (let i = 0; i < inputs.length; i += 100) {
    const chunk = inputs.slice(i, i + 100);
    try {
      await hsx.apiRequest('POST', '/crm/v4/associations/contacts/deals/batch/archive', { inputs: chunk });
      ok += chunk.length;
    } catch (e) {
      console.error(`  batch archive failed (${i}): ${e.message.slice(0, 120)}`);
      fail += chunk.length;
    }
    if (i % 500 === 0) console.error(`  …processed ${Math.min(i+100, inputs.length)}/${inputs.length}`);
  }
  console.log(`[cleanup] Dissociated ${ok}, failed ${fail}.`);
}

main().catch(e => { console.error('FATAL', e); process.exit(1); });
