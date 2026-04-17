#!/usr/bin/env node
/**
 * LIVE: CoStar PDF ingest end-to-end. WRITES to HubSpot.
 *
 * Use /costar-dryrun FIRST and confirm the output before running this.
 *
 * Usage:
 *   python scripts/parse-costar-pdf.py "path.pdf" > /tmp/parsed.ndjson
 *   node scripts/run-pdf-ingest.js /tmp/parsed.ndjson
 */
'use strict';

require('dotenv').config();
const fs = require('fs');
const { runPdfIngest } = require('../src/costar-sync/pdf-orchestrator');

async function main(ndjsonPath = '/tmp/parsed.ndjson') {
  console.log(`[LIVE] CoStar PDF ingest against ${ndjsonPath}`);
  console.log(`[LIVE] WRITES ENABLED — new deals will go to test stage 1343039756`);
  const report = await runPdfIngest(ndjsonPath, { dryRun: false,
    onProgress: p => { if (p.current % 10 === 0) console.error(`  … ${p.current}/${p.total}: ${p.owner}`); }
  });
  const out = '/tmp/live-run-report.json';
  fs.writeFileSync(out, JSON.stringify(report, null, 2));
  console.log(`\n${'='.repeat(60)}\nLIVE RUN REPORT\n${'='.repeat(60)}`);
  console.log(JSON.stringify(report.summary, null, 2));
  console.log(`\nFull report → ${out}`);
  if (report.skipped_no_domain_owners.length) {
    console.log(`\n⚠ Skipped (no domain): ${report.skipped_no_domain_owners.length}`);
  }
  if (report.skipped_no_rep_owners.length) {
    console.log(`\n⚠ Skipped (no rep resolvable): ${report.skipped_no_rep_owners.length}`);
  }
  if (report.warnings.length) {
    console.log(`\nWarnings: ${report.warnings.length}`);
    report.warnings.slice(0,20).forEach(w => console.log('  -', w));
  }
}

main(process.argv[2]).catch(e => { console.error('FATAL', e); process.exit(1); });
