#!/usr/bin/env node
/**
 * DRY-RUN: CoStar PDF ingest end-to-end. Zero HubSpot writes.
 *
 * Usage:
 *   python scripts/parse-costar-pdf.py "path.pdf" > /tmp/parsed.ndjson
 *   node scripts/dry-run-pdf-ingest.js /tmp/parsed.ndjson
 */
'use strict';

require('dotenv').config();
const fs = require('fs');
const { runPdfIngest } = require('../src/costar-sync/pdf-orchestrator');

async function main(ndjsonPath = '/tmp/parsed.ndjson') {
  console.log(`[dry-run] Running against ${ndjsonPath}`);
  const report = await runPdfIngest(ndjsonPath, { dryRun: true,
    onProgress: p => { if (p.current % 20 === 0) console.error(`  … ${p.current}/${p.total}: ${p.owner}`); }
  });
  const out = '/tmp/dry-run-report.json';
  fs.writeFileSync(out, JSON.stringify(report, null, 2));
  console.log(`\n${'='.repeat(60)}\nDRY-RUN REPORT\n${'='.repeat(60)}`);
  console.log(JSON.stringify(report.summary, null, 2));
  console.log(`\nFull report → ${out}`);
  console.log(`Total owners processed: ${report.owners.length}`);
  if (report.skipped_no_domain_owners.length) {
    console.log(`\n⚠ Skipped (no domain): ${report.skipped_no_domain_owners.length}`);
    report.skipped_no_domain_owners.forEach(s => console.log(`   • ${s.ownerName} (${s.properties_in_batch} props)`));
  }
  if (report.skipped_no_rep_owners.length) {
    console.log(`\n⚠ Skipped (no rep resolvable): ${report.skipped_no_rep_owners.length}`);
    report.skipped_no_rep_owners.forEach(s => console.log(`   • ${s.ownerName} — HQ: ${s.hqLocation || 'unknown'} (${s.properties_in_batch} props)`));
  }
  if (report.roe_active_mismatches.length) {
    console.log(`\n⚠ Active-engagement overrides: ${report.roe_active_mismatches.length}`);
    report.roe_active_mismatches.slice(0,10).forEach(m =>
      console.log(`   • ${m.ownerName} — ROE ${m.roeRep}, active rep holds ${m.activeDealCount} deal(s)`));
  }
  if (report.warnings.length) {
    console.log(`\nWarnings: ${report.warnings.length}`);
    report.warnings.slice(0,10).forEach(w => console.log('  -', w));
  }
}

main(process.argv[2]).catch(e => { console.error('FATAL', e); process.exit(1); });
