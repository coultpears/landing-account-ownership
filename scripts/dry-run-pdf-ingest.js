#!/usr/bin/env node
/**
 * DRY-RUN: CoStar PDF ingest end-to-end.
 *
 * All rules live in src/costar-sync/pdf-ingest.js — this script just orchestrates
 * the dry-run and prints the report. NO WRITES to HubSpot.
 *
 * Usage:
 *   python scripts/parse-costar-pdf.py "path.pdf" > /tmp/parsed.ndjson
 *   node scripts/dry-run-pdf-ingest.js /tmp/parsed.ndjson
 */
'use strict';

require('dotenv').config();
const fs = require('fs');
const hsx = require('../src/costar-sync/hs-extra');
const pdfIngest = require('../src/costar-sync/pdf-ingest');

const {
  normName, dealMatchesRow, shouldSkipOwner, getPrimaryOwnerEntity,
  cleanDomain, deriveDomainFromContactEmails, resolveCompany,
  buildDealName, buildDealFields, buildCompanyFields,
  DEAL_FIELD_POLICY, COMPANY_FIELD_POLICY, decideUpdate
} = pdfIngest;

const { apiRequest, findOpenDealsForCompany, findContactByEmail } = hsx;

async function main(ndjsonPath) {
  const lines = fs.readFileSync(ndjsonPath, 'utf8').split('\n').filter(Boolean);
  const props = lines.map(l => JSON.parse(l));
  console.log(`[dry-run] Parsed ${props.length} properties from ${ndjsonPath}`);

  // Category-C filter + no-owner filter
  const hasAnyOwner = props.filter(p => getPrimaryOwnerEntity(p).entity);
  const skippedNoOwner = props.length - hasAnyOwner.length;
  const filteredHOA = [], valid = [];
  for (const p of hasAnyOwner) {
    const e = getPrimaryOwnerEntity(p);
    const decision = shouldSkipOwner(e.entity.name, e.fallback_used);
    if (decision.skip) filteredHOA.push({ property: p.property_name, owner: e.entity.name, reason: decision.reason });
    else valid.push(p);
  }
  const fallbackCount = valid.filter(p => getPrimaryOwnerEntity(p).fallback_used).length;
  console.log(`[dry-run] Ingestible: ${valid.length}  |  Skipped no-owner: ${skippedNoOwner}  |  Skipped HOA/trust/individual: ${filteredHOA.length}`);
  console.log(`[dry-run] Using Recorded Owner fallback (business entities): ${fallbackCount} properties`);

  // Group by unique owner
  const ownerGroups = new Map();
  for (const p of valid) {
    const { entity, source, fallback_used } = getPrimaryOwnerEntity(p);
    const key = normName(entity.name);
    if (!ownerGroups.has(key)) {
      ownerGroups.set(key, { ownerName: entity.name, entity, source, fallback_used, props: [] });
    }
    ownerGroups.get(key).props.push({ ...p, _owner_source: source, _owner_fallback_used: fallback_used });
  }
  console.log(`[dry-run] Unique owners: ${ownerGroups.size}\n`);

  const report = {
    summary: {
      total_properties: props.length,
      skipped_no_owner: skippedNoOwner,
      processed: valid.length,
      unique_owners: ownerGroups.size,
      companies: {
        tier1_costar_domain: 0, tier125_email_domain: 0, tier15_clearbit: 0,
        tier2_name: 0, tier3_curated: 0,
        tier4_create_with_domain: 0, tier4_skipped_no_domain: 0
      },
      deals: { would_create: 0, would_merge: 0, would_merge_with_dupe_archive: 0,
               location_overrides: 0, would_skip_no_domain: 0 },
      contacts: { primary_in_pdf: 0, primary_would_create: 0, primary_already_in_hs: 0 },
      recorded_owner_fallbacks: fallbackCount,
      skipped_hoa_trust_individual: filteredHOA.length,
      skipped_no_domain_owners: 0,
      companies_hq_mismatch: 0,
      deal_mismatches: 0,
      multi_owner_jv: 0
    },
    filtered_hoa_trust_individual: filteredHOA,
    skipped_no_domain_owners: [],
    owners: [],
    location_overrides: [],
    recorded_owner_notes: [],
    warnings: []
  };

  let idx = 0;
  for (const [key, grp] of ownerGroups) {
    idx++;
    const { ownerName, entity, props: ownerProps } = grp;
    const costarDomain = cleanDomain(entity?.website);
    const emailDomain  = deriveDomainFromContactEmails(entity);
    const resolved = await resolveCompany(ownerName, { costarDomain, emailDomain });

    if (resolved.tier === 1)    report.summary.companies.tier1_costar_domain++;
    else if (resolved.tier === 1.25) report.summary.companies.tier125_email_domain++;
    else if (resolved.tier === 1.5)  report.summary.companies.tier15_clearbit++;
    else if (resolved.tier === 2)    report.summary.companies.tier2_name++;
    else if (resolved.tier === 3)    report.summary.companies.tier3_curated++;
    else if (resolved.action === 'would_create_with_domain') report.summary.companies.tier4_create_with_domain++;
    else                             report.summary.companies.tier4_skipped_no_domain++;

    // HARD RULE: skip entire owner group if no domain resolved
    if (resolved.tier === 4 && resolved.action === 'would_create_no_domain') {
      report.skipped_no_domain_owners.push({
        ownerName, properties_in_batch: ownerProps.length, notes: resolved.notes
      });
      report.summary.deals.would_skip_no_domain += ownerProps.length;
      report.summary.skipped_no_domain_owners++;
      continue;
    }

    // Company field proposal + diff
    const compProposal = buildCompanyFields(entity);
    const compDiff = resolved.company
      ? decideUpdate(resolved.company, compProposal, COMPANY_FIELD_POLICY)
      : { updates: compProposal, skipped: {}, mismatch: {} };
    if (Object.keys(compDiff.mismatch).length) report.summary.companies_hq_mismatch++;

    // Per-property deal analysis
    const perProp = [];
    const openDeals = resolved.company ? await findOpenDealsForCompany(resolved.company.id) : [];
    for (const p of ownerProps) {
      if ((p.contacts?.true_owners || []).length > 1) report.summary.multi_owner_jv++;
      const dealName = buildDealName(p, ownerName);
      const fields = buildDealFields(p, entity);
      fields.dealname = dealName;

      const matches = openDeals.filter(d => dealMatchesRow(d.properties?.dealname, p, ownerName));
      let action, winnerId = null, archiveIds = [];
      if (matches.length) {
        matches.sort((a,b) => (a.properties.hs_lastmodifieddate || '').localeCompare(b.properties.hs_lastmodifieddate || ''));
        winnerId = matches[0].id;
        archiveIds = matches.slice(1).map(d => d.id);
        action = 'merge';
        if (archiveIds.length) report.summary.deals.would_merge_with_dupe_archive++;
        report.summary.deals.would_merge++;
      } else {
        action = 'create';
        report.summary.deals.would_create++;
      }

      let fieldDiff = null;
      if (winnerId) {
        try {
          const existing = await apiRequest('POST', '/crm/v3/objects/deals/batch/read', {
            inputs: [{ id: String(winnerId) }],
            properties: Object.keys(fields)
          });
          const cur = (existing.results || [])[0];
          fieldDiff = decideUpdate(cur, fields, DEAL_FIELD_POLICY);
          if (Object.keys(fieldDiff.mismatch).length) report.summary.deal_mismatches += Object.keys(fieldDiff.mismatch).length;

          const locKeys = ['property_city','property_state','property_street_address','property_zip'];
          const locOverrides = {};
          for (const k of locKeys) if (fieldDiff.mismatch[k]) locOverrides[k] = fieldDiff.mismatch[k];
          if (Object.keys(locOverrides).length) {
            report.summary.deals.location_overrides++;
            report.location_overrides.push({
              dealId: winnerId, dealName, ownerName, overrides: locOverrides,
              plannedNote: `Property location updated per CoStar ingest ${new Date().toISOString().slice(0,10)}: ${Object.entries(locOverrides).map(([k,v]) => `${k}: "${v.current}" → "${v.proposed}"`).join('; ')}`
            });
          }
        } catch (e) {
          report.warnings.push(`read existing deal ${winnerId} failed: ${e.message}`);
        }
      }

      if (p._owner_fallback_used) {
        report.recorded_owner_notes.push({
          dealId: winnerId || '(new-deal)', dealName, ownerNameUsed: ownerName,
          plannedNote: `⚠ No True Owner identified in CoStar PDF. Using Recorded Owner "${ownerName}" as owner identity. Rep: please verify and update the associated company to the actual operating owner if known.`
        });
      }

      const primaryContact = entity?.contacts?.[0];
      if (primaryContact?.email) {
        report.summary.contacts.primary_in_pdf++;
        try {
          const existing = await findContactByEmail(primaryContact.email);
          if (existing) report.summary.contacts.primary_already_in_hs++;
          else report.summary.contacts.primary_would_create++;
        } catch {}
      }

      perProp.push({
        property_index: p.property_index, property_name: p.property_name,
        dealName, action, winnerId, archiveIds,
        field_diff_sample: fieldDiff ? {
          updates: Object.keys(fieldDiff.updates).length,
          skipped: Object.keys(fieldDiff.skipped).length,
          mismatch: fieldDiff.mismatch
        } : null
      });
    }

    report.owners.push({
      ownerName, uniqueKey: key, properties_in_batch: ownerProps.length,
      company: {
        resolution: resolved, proposal: compProposal,
        field_diff: compDiff.updates && {
          updates: Object.keys(compDiff.updates).length,
          skipped_blank_only: Object.keys(compDiff.skipped).length,
          mismatch: compDiff.mismatch
        }
      },
      named_contacts_in_pdf: (entity?.contacts || []).length,
      properties: perProp
    });

    if (idx % 10 === 0) console.error(`  … processed ${idx}/${ownerGroups.size} owners`);
  }

  const reportPath = '/tmp/dry-run-report.json';
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
  console.log(`\n${'='.repeat(60)}\nDRY-RUN REPORT\n${'='.repeat(60)}`);
  console.log(JSON.stringify(report.summary, null, 2));
  console.log(`\nFull report → ${reportPath}`);
  console.log(`Total owners: ${report.owners.length}`);
  if (report.warnings.length) {
    console.log(`Warnings: ${report.warnings.length}`);
    report.warnings.slice(0,10).forEach(w => console.log('  -', w));
  }
}

main(process.argv[2] || '/tmp/parsed.ndjson').catch(e => { console.error('FATAL', e); process.exit(1); });
