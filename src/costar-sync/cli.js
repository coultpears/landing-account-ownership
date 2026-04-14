'use strict';

/**
 * costar-sync CLI — run sync from command line for testing
 *
 * Usage:
 *   node src/costar-sync/cli.js <file>              # full sync
 *   node src/costar-sync/cli.js --dry-run <file>    # preview only
 *   node src/costar-sync/cli.js --parse <file>      # just parse and show rows
 */

const path = require('path');
const { runSync, parseFile } = require('./sync');

const args = process.argv.slice(2);

if (args.length === 0) {
  console.log('Usage:');
  console.log('  node src/costar-sync/cli.js <file.xlsx>           # sync to HubSpot');
  console.log('  node src/costar-sync/cli.js --dry-run <file.xlsx> # preview changes');
  console.log('  node src/costar-sync/cli.js --parse <file.xlsx>   # parse and display');
  process.exit(0);
}

const isDryRun = args.includes('--dry-run');
const isParseOnly = args.includes('--parse');
const filePath = args.filter(a => !a.startsWith('--'))[0];

if (!filePath) {
  console.error('Error: no file path provided');
  process.exit(1);
}

const resolved = path.resolve(filePath);

if (isParseOnly) {
  const rows = parseFile(resolved);
  console.log(`Parsed ${rows.length} rows:\n`);
  for (const row of rows.slice(0, 5)) {
    console.log(`  ${row['Company']} — ${row['HQ City']}, ${row['HQ State']} — ${row['Apt Units']} units`);
  }
  if (rows.length > 5) console.log(`  … and ${rows.length - 5} more`);
  process.exit(0);
}

(async () => {
  console.log(isDryRun ? 'DRY RUN — no HubSpot writes\n' : 'Syncing to HubSpot…\n');

  try {
    const summary = await runSync(resolved, {
      dryRun: isDryRun,
      onProgress: ({ current, total, company }) => {
        process.stdout.write(`\r  [${current}/${total}] ${company.padEnd(50)}`);
      }
    });

    console.log('\n');
    console.log(`  Total:    ${summary.total}`);
    console.log(`  Updated:  ${summary.updated}`);
    console.log(`  Created:  ${summary.created}`);
    console.log(`  Skipped:  ${summary.skipped}`);
    console.log(`  Errors:   ${summary.errors}`);

    if (summary.errors > 0) {
      console.log('\nErrors:');
      for (const d of summary.details.filter(d => d.action === 'error')) {
        console.log(`  ${d.company}: ${d.error}`);
      }
    }

    if (summary.updated > 0) {
      console.log('\nUpdated:');
      for (const d of summary.details.filter(d => d.action === 'updated')) {
        console.log(`  ${d.company} → ${d.changes.join(', ')}`);
      }
    }

    if (summary.created > 0) {
      console.log(`\n${isDryRun ? 'Would create' : 'Created'}:`);
      for (const d of summary.details.filter(d => d.action === 'created' || d.action === 'would_create')) {
        console.log(`  ${d.company}`);
      }
    }

  } catch (err) {
    console.error(`\nError: ${err.message}`);
    process.exit(1);
  }
})();
