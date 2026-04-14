'use strict';

/**
 * leaseup.js — Xander's lease-up workflow on top of CoStar sync.
 *
 * When Xander drops a CoStar export in the sync channel, after the normal
 * company sync we run this for each company:
 *
 *   1. Find an open deal on the company in AP Pipeline.
 *      - If exists: update owner=Xander + deal_category=Lease Up (no new deal)
 *      - If not:    create "{Company} - Lease Up" deal (stage New Opportunities)
 *   2. Enrich the company with ZoomInfo contacts:
 *      - Pull decision-maker contacts (owner/acquisitions/leasing/dev/etc.)
 *      - For each: dedup by email, then by name+company; create if missing
 *      - Associate every contact (new or existing) to company + deal
 *
 * All create paths run dedup first per project rule feedback_hubspot_dedup.
 */

const hsx = require('./hs-extra');
const zi  = require('./zoominfo');

const {
  AP_PIPELINE_ID,
  NEW_OPPORTUNITIES_STAGE,
  XANDER_OWNER_ID,
  DEAL_CATEGORY_LEASE_UP,
  findOpenDealForCompany,
  createDeal,
  updateDeal,
  findContactByEmail,
  findContactByNameAtCompany,
  createContact,
  associateContactToCompany,
  associateContactToDeal,
  deriveDominantDomain,
  getCompanyBasics,
  updateCompany
} = hsx;

// ---------------------------------------------------------------------------
// Deal create/merge
// ---------------------------------------------------------------------------

/**
 * Ensure a lease-up deal exists for this company.
 * - If an open AP Pipeline deal exists → update owner + category (merge).
 * - Otherwise → create a new deal.
 * Returns { dealId, action: 'created'|'merged', deal }
 */
async function ensureLeaseUpDeal(companyId, companyName, { dryRun = false, ownerId = XANDER_OWNER_ID } = {}) {
  const existing = await findOpenDealForCompany(companyId);

  if (existing) {
    const props = existing.properties || {};
    const updates = {};
    if (props.hubspot_owner_id !== String(ownerId)) updates.hubspot_owner_id = String(ownerId);
    if (props.deal_category !== DEAL_CATEGORY_LEASE_UP) updates.deal_category = DEAL_CATEGORY_LEASE_UP;

    if (Object.keys(updates).length > 0 && !dryRun) {
      await updateDeal(existing.id, updates);
    }
    return { dealId: existing.id, action: 'merged', deal: existing, updates };
  }

  if (dryRun) {
    return { dealId: null, action: 'would_create', deal: null };
  }

  const created = await createDeal({
    name:      `${companyName} - Lease Up`,
    ownerId:   ownerId,
    pipeline:  AP_PIPELINE_ID,
    stage:     NEW_OPPORTUNITIES_STAGE,
    category:  DEAL_CATEGORY_LEASE_UP,
    companyId: companyId
  });
  return { dealId: created.id, action: 'created', deal: created };
}

// ---------------------------------------------------------------------------
// Contact enrichment (per company, optionally tied to a deal)
// ---------------------------------------------------------------------------

/**
 * Enrich a company with relevant ZoomInfo contacts. Dedups against HubSpot
 * first (by email, then name+company). Creates missing contacts with
 * associations to company (and optionally deal).
 *
 * Returns { searched, enrichedFromZI, existing, created, associated, errors }
 */
async function enrichCompanyContacts(companyId, companyName, { dealId = null, dryRun = false, maxContacts = 15 } = {}) {
  const summary = {
    company:        companyName,
    companyId,
    dealId,
    ziFound:        0,
    existing:       0,
    created:        0,
    associated:     0,
    errors:         [],
    contacts:       []
  };

  let ziContacts;
  try {
    ziContacts = await zi.findRelevantContacts(companyName, { maxResults: maxContacts });
  } catch (e) {
    summary.errors.push(`zoominfo: ${e.message}`);
    return summary;
  }

  summary.ziFound = ziContacts.length;
  if (!ziContacts.length) return summary;

  for (const zc of ziContacts) {
    const email     = (zc.email || '').toLowerCase();
    const firstname = zc.firstName || '';
    const lastname  = zc.lastName  || '';
    const title     = zc.jobTitle  || '';
    const phone     = zc.phone || zc.mobilePhone || '';
    const linkedin  = Array.isArray(zc.externalUrls)
      ? (zc.externalUrls.find(u => /linkedin/i.test(u?.url || u)) || {}).url || ''
      : '';

    try {
      // Dedup: email first
      let existing = email ? await findContactByEmail(email) : null;
      // Fall back: name + company
      if (!existing && firstname && lastname) {
        existing = await findContactByNameAtCompany(firstname, lastname, companyId);
      }

      if (existing) {
        summary.existing++;
        // Ensure associations (idempotent)
        if (!dryRun) {
          try { await associateContactToCompany(existing.id, companyId); } catch {}
          if (dealId) {
            try { await associateContactToDeal(existing.id, dealId); } catch {}
          }
        }
        summary.associated++;
        summary.contacts.push({ action: 'linked_existing', id: existing.id, email, name: `${firstname} ${lastname}`.trim(), title });
        continue;
      }

      // Create
      if (dryRun) {
        summary.contacts.push({ action: 'would_create', email, name: `${firstname} ${lastname}`.trim(), title });
        continue;
      }

      const props = {
        ...(email     ? { email }                             : {}),
        ...(firstname ? { firstname }                         : {}),
        ...(lastname  ? { lastname }                          : {}),
        ...(title     ? { jobtitle: title }                   : {}),
        ...(phone     ? { phone }                             : {}),
        ...(linkedin  ? { hs_linkedin_url: linkedin }         : {})
      };

      const created = await createContact(props, { companyId, dealId });
      summary.created++;
      summary.associated++;
      summary.contacts.push({ action: 'created', id: created.id, email, name: `${firstname} ${lastname}`.trim(), title });
    } catch (e) {
      summary.errors.push(`${firstname} ${lastname} (${email}): ${e.message}`);
    }
  }

  // Backfill company.domain if empty. Every company should have a domain;
  // we can derive it from the dominant non-public email domain of the
  // enriched contacts.
  if (!dryRun && (summary.created + summary.existing) > 0) {
    try {
      const current = await getCompanyBasics(companyId);
      if (!current.properties?.domain) {
        const derived = deriveDominantDomain(ziContacts);
        if (derived) {
          await updateCompany(companyId, { domain: derived });
          summary.domainSet = derived;
        }
      }
    } catch (e) {
      summary.errors.push(`domain backfill: ${e.message}`);
    }
  }

  return summary;
}

// ---------------------------------------------------------------------------
// Orchestrator — run after a CoStar sync for a single (companyId, companyName)
// ---------------------------------------------------------------------------

/**
 * Full lease-up workflow for one company:
 *   1. ensureLeaseUpDeal (create or merge)
 *   2. enrichCompanyContacts tied to that deal
 */
async function runLeaseUpForCompany(companyId, companyName, opts = {}) {
  const dealResult = await ensureLeaseUpDeal(companyId, companyName, opts);
  const enrichment = await enrichCompanyContacts(companyId, companyName, {
    ...opts,
    dealId: dealResult.dealId
  });
  return { company: companyName, companyId, deal: dealResult, enrichment };
}

module.exports = {
  ensureLeaseUpDeal,
  enrichCompanyContacts,
  runLeaseUpForCompany
};
