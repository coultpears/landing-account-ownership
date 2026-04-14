'use strict';

/**
 * link-xander-deal-contacts.js — For every deal Xander owns, copy all
 * contacts from the associated company onto the deal. Ensures the contacts
 * we enriched via ZoomInfo roll up on Xander's deals regardless of which
 * deal the backfill originally linked them to.
 *
 * Usage:
 *   node src/costar-sync/link-xander-deal-contacts.js               # live
 *   node src/costar-sync/link-xander-deal-contacts.js --dry-run     # preview
 */

const hsx = require('./hs-extra');
const { XANDER_OWNER_ID, apiRequest } = hsx;

function parseArgs(argv) {
  return { dryRun: argv.includes('--dry-run') || argv.includes('-n') };
}

async function fetchXanderDeals() {
  const results = [];
  let after;
  do {
    const res = await apiRequest('POST', '/crm/v3/objects/deals/search', {
      filterGroups: [{ filters: [
        { propertyName: 'hubspot_owner_id', operator: 'EQ', value: String(XANDER_OWNER_ID) }
      ]}],
      properties: ['dealname', 'dealstage', 'pipeline'],
      limit: 100,
      ...(after ? { after } : {})
    });
    results.push(...(res.results || []));
    after = res.paging?.next?.after;
    if (after) await sleep(250);
  } while (after);
  return results;
}

async function fetchAssociatedIds(fromType, toType, fromId) {
  try {
    const res = await apiRequest('GET', `/crm/v4/objects/${fromType}/${fromId}/associations/${toType}?limit=500`);
    return (res.results || []).map(r => String(r.toObjectId));
  } catch {
    return [];
  }
}

async function associateContactToDeal(contactId, dealId) {
  return apiRequest(
    'PUT',
    `/crm/v4/objects/contacts/${contactId}/associations/default/deals/${dealId}`
  );
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function main() {
  const { dryRun } = parseArgs(process.argv.slice(2));
  console.log(`\n=== Link company contacts → Xander's deals ===`);
  console.log(`Mode: ${dryRun ? 'DRY RUN' : 'LIVE'}\n`);

  const deals = await fetchXanderDeals();
  console.log(`Xander owns ${deals.length} deals total.\n`);

  let totalNewLinks = 0;
  let totalAlreadyLinked = 0;
  let dealsTouched = 0;
  const errors = [];

  for (let i = 0; i < deals.length; i++) {
    const deal = deals[i];
    const dealId = deal.id;
    const dealName = deal.properties?.dealname || '(unnamed)';

    const companyIds = await fetchAssociatedIds('deals', 'companies', dealId);
    if (!companyIds.length) continue;

    // Gather all contacts on associated companies
    const contactIds = new Set();
    for (const cid of companyIds) {
      for (const ctid of await fetchAssociatedIds('companies', 'contacts', cid)) {
        contactIds.add(ctid);
      }
    }

    if (!contactIds.size) continue;

    // Existing contacts already on this deal
    const existingOnDeal = new Set(await fetchAssociatedIds('deals', 'contacts', dealId));
    const toAdd = [...contactIds].filter(id => !existingOnDeal.has(id));

    totalAlreadyLinked += existingOnDeal.size;

    if (!toAdd.length) {
      console.log(`[${i+1}/${deals.length}] "${dealName}" — all ${contactIds.size} company contacts already on deal`);
      continue;
    }

    if (dryRun) {
      console.log(`[${i+1}/${deals.length}] "${dealName}" — would link ${toAdd.length} new contacts (of ${contactIds.size})`);
      totalNewLinks += toAdd.length;
      dealsTouched++;
      continue;
    }

    let linked = 0;
    for (const ctid of toAdd) {
      try {
        await associateContactToDeal(ctid, dealId);
        linked++;
      } catch (e) {
        errors.push(`deal ${dealId} / contact ${ctid}: ${e.message}`);
      }
    }
    totalNewLinks += linked;
    if (linked) dealsTouched++;
    console.log(`[${i+1}/${deals.length}] "${dealName}" — linked ${linked} new (had ${existingOnDeal.size})`);
  }

  console.log(`\n=== Summary ===`);
  console.log(`Xander deals scanned:    ${deals.length}`);
  console.log(`Deals touched:           ${dealsTouched}`);
  console.log(`New contact→deal links:  ${totalNewLinks}`);
  console.log(`Already-linked existing: ${totalAlreadyLinked}`);
  if (errors.length) {
    console.log(`Errors: ${errors.length}`);
    errors.slice(0, 15).forEach(e => console.log('  -', e));
  }
}

if (require.main === module) {
  main().catch(err => { console.error('FATAL:', err.message); process.exit(1); });
}
