'use strict';

/**
 * pdf-orchestrator.js — Per-owner loop that ties together rep resolution,
 * company/deal resolution, ZI enrichment, and verification. Runs in either
 * dry-run or execute mode based on `opts.dryRun`.
 *
 * Consumers:
 *   scripts/dry-run-pdf-ingest.js  (dryRun: true)
 *   scripts/run-pdf-ingest.js      (dryRun: false)
 *
 * Input: parsed NDJSON rows from scripts/parse-costar-pdf.py
 */

const fs  = require('fs');
const hsx = require('./hs-extra');
const pdfIngest = require('./pdf-ingest');

const {
  apiRequest, findOpenDealsForCompany, findContactByEmail
} = hsx;

const {
  // filters / classification
  normName, dealMatchesRow, shouldSkipOwner, getPrimaryOwnerEntity,
  // domain / company resolution
  cleanDomain, deriveDomainFromContactEmails, resolveCompany,
  // rep resolution
  resolveRoeRep, findActiveEngagementRep, getHsOwnerIdByName,
  ACTIVE_ENGAGEMENT_DAYS,
  // field mapping + policies
  buildDealName, buildDealFields, buildCompanyFields,
  DEAL_FIELD_POLICY, COMPANY_FIELD_POLICY, decideUpdate,
  // write helpers
  createOrUpdateCompany, createOrMergeDeal, handlePdfPrimaryContact, runZiEnrichmentForOwner
} = pdfIngest;

async function runPdfIngest(ndjsonPath, { dryRun = true, onProgress } = {}) {
  const lines = fs.readFileSync(ndjsonPath, 'utf8').split('\n').filter(Boolean);
  const props = lines.map(l => JSON.parse(l));

  // Pre-filter: no owner at all → skip
  const hasAnyOwner = props.filter(p => getPrimaryOwnerEntity(p).entity);
  const skippedNoOwner = props.length - hasAnyOwner.length;

  // Pre-filter: Recorded-Owner HOA/trust/individual patterns
  const filteredHOA = [], valid = [];
  for (const p of hasAnyOwner) {
    const e = getPrimaryOwnerEntity(p);
    const decision = shouldSkipOwner(e.entity.name, e.fallback_used);
    if (decision.skip) filteredHOA.push({ property: p.property_name, owner: e.entity.name, reason: decision.reason });
    else valid.push(p);
  }

  // Group by unique True Owner
  const ownerGroups = new Map();
  for (const p of valid) {
    const { entity, source, fallback_used } = getPrimaryOwnerEntity(p);
    const key = normName(entity.name);
    if (!ownerGroups.has(key)) {
      ownerGroups.set(key, { ownerName: entity.name, entity, source, fallback_used, props: [] });
    }
    ownerGroups.get(key).props.push({ ...p, _owner_source: source, _owner_fallback_used: fallback_used });
  }

  const fallbackCount = valid.filter(p => getPrimaryOwnerEntity(p).fallback_used).length;

  const report = {
    mode: dryRun ? 'dry-run' : 'execute',
    summary: {
      total_properties: props.length,
      skipped_no_owner: skippedNoOwner,
      processed: valid.length,
      unique_owners: ownerGroups.size,
      companies: {
        tier1_costar_domain: 0, tier125_email_domain: 0, tier15_clearbit: 0,
        tier2_name: 0, tier3_curated: 0,
        tier4_create_with_domain: 0, tier4_skipped_no_domain: 0,
        enriched: 0, created: 0
      },
      deals: { created: 0, merged: 0, dupes_archived: 0,
               location_overrides: 0, skipped_no_domain: 0, skipped_no_rep: 0 },
      contacts: { pdf_primary_created: 0, pdf_primary_associated: 0,
                  zi_found: 0, zi_created: 0, zi_associated: 0 },
      reps: { via_roe: 0, via_active_engagement: 0, via_territory: 0, no_rep_flagged: 0 },
      recorded_owner_fallbacks: fallbackCount,
      skipped_hoa_trust_individual: filteredHOA.length,
      skipped_no_domain_owners: 0,
      deal_mismatches: 0,
      multi_owner_jv: 0
    },
    filtered_hoa_trust_individual: filteredHOA,
    skipped_no_domain_owners: [],
    skipped_no_rep_owners: [],
    roe_active_mismatches: [],
    location_overrides: [],
    recorded_owner_notes: [],
    owners: [],
    warnings: []
  };

  let idx = 0;
  for (const [key, grp] of ownerGroups) {
    idx++;
    const { ownerName, entity, props: ownerProps } = grp;
    if (onProgress) onProgress({ current: idx, total: ownerGroups.size, owner: ownerName });

    // 1) Resolve domain
    const costarDomain = cleanDomain(entity?.website);
    const emailDomain  = deriveDomainFromContactEmails(entity);
    const resolved = await resolveCompany(ownerName, { costarDomain, emailDomain });

    if (resolved.tier === 1)         report.summary.companies.tier1_costar_domain++;
    else if (resolved.tier === 1.25) report.summary.companies.tier125_email_domain++;
    else if (resolved.tier === 1.5)  report.summary.companies.tier15_clearbit++;
    else if (resolved.tier === 2)    report.summary.companies.tier2_name++;
    else if (resolved.tier === 3)    report.summary.companies.tier3_curated++;
    else if (resolved.action === 'would_create_with_domain') report.summary.companies.tier4_create_with_domain++;
    else                             report.summary.companies.tier4_skipped_no_domain++;

    // HARD RULE: skip whole group if no domain resolved
    if (resolved.tier === 4 && resolved.action === 'would_create_no_domain') {
      report.skipped_no_domain_owners.push({ ownerName, properties_in_batch: ownerProps.length, notes: resolved.notes });
      report.summary.deals.skipped_no_domain += ownerProps.length;
      report.summary.skipped_no_domain_owners++;
      continue;
    }

    // 2) Resolve ROE rep
    const hqLocation = [entity?.city, entity?.state].filter(Boolean).join(', ');
    const roe = resolveRoeRep(ownerName, hqLocation);

    // engine.resolve() sets rep to string for Top 50 / owner-assignment,
    // but to an array of reps for state fallback. Normalize + pick or flag.
    let repName = null;
    if (Array.isArray(roe.rep)) {
      if (roe.rep.length === 1) {
        repName = roe.rep[0];
      } else if (roe.rep.length > 1) {
        // Ambiguous: multiple reps cover this state + sub-market couldn't disambiguate.
        // Flag for manual triage.
        report.skipped_no_rep_owners.push({
          ownerName, hqLocation, properties_in_batch: ownerProps.length,
          warnings: [`Territory lookup returned multiple reps: ${roe.rep.join(', ')} — manual triage needed`]
        });
        report.summary.deals.skipped_no_rep += ownerProps.length;
        report.summary.reps.no_rep_flagged++;
        continue;
      }
    } else if (typeof roe.rep === 'string') {
      repName = roe.rep;
    }

    // HARD RULE: no rep resolvable → skip whole group
    if (!repName) {
      report.skipped_no_rep_owners.push({
        ownerName, hqLocation, properties_in_batch: ownerProps.length,
        warnings: roe.warnings || [`engine.resolve() returned no rep (rule: ${roe.rule || 'none'})`]
      });
      report.summary.deals.skipped_no_rep += ownerProps.length;
      report.summary.reps.no_rep_flagged++;
      continue;
    }
    // Translate rep name → HS owner ID
    const roeOwnerId = await getHsOwnerIdByName(repName);
    if (!roeOwnerId) {
      report.skipped_no_rep_owners.push({ ownerName, hqLocation, properties_in_batch: ownerProps.length,
        warnings: [`ROE rep "${repName}" not found in HubSpot owners`] });
      report.summary.deals.skipped_no_rep += ownerProps.length;
      report.summary.reps.no_rep_flagged++;
      continue;
    }
    if (roe.rule === 'TOP_50' || roe.rule === 'OWNER_ASSIGNMENT') report.summary.reps.via_roe++;
    else if (/state/i.test(roe.rule || '')) report.summary.reps.via_territory++;

    // 3) Active-engagement override
    let finalOwnerId = roeOwnerId;
    let finalOwnerSource = roe.rule || 'territory';
    let activeOverride = null;
    if (resolved.company) {
      activeOverride = await findActiveEngagementRep(resolved.company.id);
      if (activeOverride && activeOverride.activeOwnerId !== roeOwnerId) {
        finalOwnerId = activeOverride.activeOwnerId;
        finalOwnerSource = 'active_engagement';
        report.summary.reps.via_active_engagement++;
        report.roe_active_mismatches.push({
          ownerName,
          roeRep: repName, roeOwnerId,
          activeOwnerId: activeOverride.activeOwnerId,
          activeDealCount: activeOverride.dealCount,
          lastActivityAt: activeOverride.lastActivityAt,
          note: `ROE says ${repName}; ${activeOverride.dealCount} open deal(s) actively engaged within ${ACTIVE_ENGAGEMENT_DAYS}d — new deals go to active rep.`
        });
      }
    }

    // 4) Resolve / create company
    const compProposal = buildCompanyFields(entity);
    let companyId, companyAction;
    if (dryRun) {
      companyId = resolved.company?.id || null;
      companyAction = resolved.company ? 'would_enrich' : 'would_create';
      if (resolved.company) report.summary.companies.enriched++;
      else report.summary.companies.created++;
    } else {
      const r = await createOrUpdateCompany(resolved, compProposal, finalOwnerId);
      companyId = r.id;
      companyAction = r.action;
      if (r.action === 'enriched') report.summary.companies.enriched++;
      if (r.action === 'created')  report.summary.companies.created++;
    }

    // 5) For each property, resolve / create / merge deal
    const openDeals = companyId ? await findOpenDealsForCompany(companyId) : [];
    const dealIds = [];
    const perProp = [];
    for (const p of ownerProps) {
      if ((p.contacts?.true_owners || []).length > 1) report.summary.multi_owner_jv++;
      try {
        const dealResult = await createOrMergeDeal({
          row: p, ownerName, ownerEntity: entity,
          companyId, dealOwnerId: finalOwnerId,
          openDeals, dryRun
        });
        if (dealResult.action === 'created')    report.summary.deals.created++;
        else if (dealResult.action === 'merged') report.summary.deals.merged++;
        else if (dealResult.action === 'would_create') report.summary.deals.created++;
        if (dealResult.archivedDupes?.length) report.summary.deals.dupes_archived += dealResult.archivedDupes.length;
        if (dealResult.dealId) dealIds.push(dealResult.dealId);

        // Location-override bookkeeping
        if (dealResult.mismatch) {
          const locKeys = ['property_city','property_state','property_street_address','property_zip'];
          const locOv = {};
          for (const k of locKeys) if (dealResult.mismatch[k]) locOv[k] = dealResult.mismatch[k];
          if (Object.keys(locOv).length) {
            report.summary.deals.location_overrides++;
            report.location_overrides.push({
              dealId: dealResult.dealId, ownerName,
              property: p.property_name,
              overrides: locOv
            });
          }
          report.summary.deal_mismatches += Object.keys(dealResult.mismatch).length;
        }

        // Recorded-Owner fallback note
        if (p._owner_fallback_used) {
          report.recorded_owner_notes.push({
            dealId: dealResult.dealId, ownerName,
            plannedNote: `⚠ No True Owner identified in CoStar PDF. Using Recorded Owner "${ownerName}". Rep: please verify and update the associated company if a better match exists.`
          });
        }

        perProp.push({
          property_index: p.property_index, property_name: p.property_name,
          action: dealResult.action, dealId: dealResult.dealId,
          archivedDupes: dealResult.archivedDupes || []
        });
      } catch (e) {
        report.warnings.push(`deal create/merge failed for ${p.property_name} (owner ${ownerName}): ${e.message}`);
      }
    }

    // 6) PDF primary contact + ZI enrichment
    const pdfContactResult = await handlePdfPrimaryContact({
      ownerEntity: entity, companyId, dealIds, dealOwnerId: finalOwnerId, dryRun
    });
    if (pdfContactResult.created)    report.summary.contacts.pdf_primary_created++;
    if (pdfContactResult.associated) report.summary.contacts.pdf_primary_associated++;

    const ziResult = await runZiEnrichmentForOwner({
      ownerName, companyId, dealIds, dealOwnerId: finalOwnerId, dryRun
    });
    report.summary.contacts.zi_found += ziResult.ziFound;
    report.summary.contacts.zi_created += ziResult.created;
    report.summary.contacts.zi_associated += ziResult.associated;
    for (const e of ziResult.errors) report.warnings.push(e);

    report.owners.push({
      ownerName, uniqueKey: key, properties_in_batch: ownerProps.length,
      company: {
        resolution: resolved,
        action: companyAction,
        id: companyId,
        hq_mismatches: resolved.company ? decideUpdate(resolved.company, compProposal, COMPANY_FIELD_POLICY).skipped : {}
      },
      rep: {
        roe: { rep: repName, rule: roe.rule, matchedOwner: roe.matchedOwner, ownerId: roeOwnerId },
        final: { ownerId: finalOwnerId, source: finalOwnerSource },
        activeOverride
      },
      contacts: { pdf: pdfContactResult, zi: ziResult },
      properties: perProp
    });

    if (idx % 10 === 0) console.error(`  … processed ${idx}/${ownerGroups.size} owners`);
  }

  return report;
}

module.exports = { runPdfIngest };
