#!/usr/bin/env node
'use strict';

/**
 * cli.js — Ownership conflict resolution CLI
 *
 * Usage:
 *   node src/cli.js check <owner> [options]
 *   npm run check -- <owner> [options]
 *
 * Options:
 *   --market <market>     Property location, e.g. "Dallas TX" (used for Xavier MSA check)
 *   --hq <location>       Owner HQ state, e.g. "VA", "Virginia", "McLean VA"
 *   --lease-up            Flag property as lease-up
 *   --class <class>       e.g. "Class A", "Class B"
 *   --type <type>         e.g. "Conventional MF", "Affordable"
 *
 * Examples:
 *   node src/cli.js check "Camden"
 *   node src/cli.js check "MAA" --market "Dallas TX"
 *   node src/cli.js check "Unknown Owner" --market "Charlotte NC" --lease-up
 *   node src/cli.js check "Greystar" --market "Miami FL"
 *   node src/cli.js check "Some Owner" --hq "Virginia" --market "Miami FL"
 *   node src/cli.js check "Some Owner" --class "Class C"
 */

const fs   = require('fs');
const path = require('path');

const { resolve } = require('./engine');
const { qualify } = require('./qualify');
const { enrichFromPropertyName, enrichOwnerHQ, looksLikePropertyName } = require('./search');
const { auditRep, KNOWN_REPS } = require('./audit');

// ---------------------------------------------------------------------------
// Enrichment cache  (data/cache.json)
// ---------------------------------------------------------------------------

const CACHE_PATH = path.join(__dirname, '..', 'data', 'cache.json');

function loadCache() {
  try { return JSON.parse(fs.readFileSync(CACHE_PATH, 'utf8')); } catch { return {}; }
}

function saveCache(cache) {
  try { fs.writeFileSync(CACHE_PATH, JSON.stringify(cache, null, 2)); } catch { /* non-fatal */ }
}

function cacheKey(query) {
  return query.toLowerCase().replace(/\s+/g, ' ').trim();
}

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

function parseArgs(args) {
  const input = {
    ownerName: null,
    market: null,
    ownerHQ: null,
    isLeaseUp: false,
    propertyClass: null,
    propertyType: null
  };

  const positional = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--market' && args[i + 1]) {
      input.market = args[++i];
    } else if (arg === '--hq' && args[i + 1]) {
      input.ownerHQ = args[++i];
    } else if (arg === '--lease-up' || arg === '--leaseup') {
      input.isLeaseUp = true;
    } else if (arg === '--class' && args[i + 1]) {
      input.propertyClass = args[++i];
    } else if (arg === '--type' && args[i + 1]) {
      input.propertyType = args[++i];
    } else if (!arg.startsWith('--')) {
      positional.push(arg);
    }
  }

  if (positional.length > 0) {
    input.ownerName = positional.join(' ');
  }

  return input;
}

// ---------------------------------------------------------------------------
// Output formatting
// ---------------------------------------------------------------------------

const RULE_LABELS = {
  TOP_50:           'TOP 50 OWNER',
  LEASE_UP:         'LEASE-UP (non-Top-50)',
  OWNER_ASSIGNMENT: 'OWNER-LEVEL ASSIGNMENT',
  STATE_FALLBACK:   'STATE/REGIONAL FALLBACK',
  UNASSIGNED:       'UNASSIGNED'
};

const RULE_COLORS = {
  TOP_50:           '\x1b[32m',  // green
  LEASE_UP:         '\x1b[36m',  // cyan
  OWNER_ASSIGNMENT: '\x1b[34m',  // blue
  STATE_FALLBACK:   '\x1b[33m',  // yellow
  UNASSIGNED:       '\x1b[31m'   // red
};

const RESET = '\x1b[0m';
const BOLD  = '\x1b[1m';
const DIM   = '\x1b[2m';

function line(char = '─', len = 60) {
  return char.repeat(len);
}

function printResult(result) {
  const color = RULE_COLORS[result.rule] || '';
  const repDisplay = Array.isArray(result.rep)
    ? result.rep.join(', ')
    : result.rep || 'UNASSIGNED';

  console.log('');
  console.log(BOLD + line('═') + RESET);
  console.log(BOLD + ' OWNERSHIP RESOLUTION' + RESET);
  console.log(BOLD + line('═') + RESET);

  console.log(` Owner query : ${BOLD}${result.input.ownerName}${RESET}`);
  if (result.input.ownerHQ)   console.log(` Owner HQ    : ${result.input.ownerHQ}`);
  if (result.input.market)    console.log(` Property    : ${result.input.market}`);
  if (result.input.isLeaseUp) console.log(` Lease-up    : Yes`);
  if (result.matchedOwner)    console.log(` Matched     : ${DIM}${result.matchedOwner}${RESET}`);
  console.log(` Timestamp   : ${DIM}${result.timestamp}${RESET}`);

  console.log(line('─'));

  console.log(` Rule        : ${color}${BOLD}${RULE_LABELS[result.rule] || result.rule}${RESET}`);
  console.log(` Assigned to : ${color}${BOLD}${repDisplay}${RESET}`);

  console.log(line('─'));
  console.log(` Why:`);

  // Word-wrap the explanation at ~56 chars
  const words = result.explanation.split(' ');
  let currentLine = '   ';
  for (const word of words) {
    if (currentLine.length + word.length + 1 > 58) {
      console.log(currentLine);
      currentLine = '   ' + word;
    } else {
      currentLine += (currentLine === '   ' ? '' : ' ') + word;
    }
  }
  if (currentLine.trim()) console.log(currentLine);

  if (result.warnings.length > 0) {
    console.log('');
    result.warnings.forEach(w => {
      console.log(` \x1b[33m⚠  ${w}${RESET}`);
    });
  }

  if (result.conflict) {
    console.log('');
    console.log(` \x1b[31m!! CONFLICT DETECTED — Manual review required.${RESET}`);
  }

  console.log(BOLD + line('═') + RESET);
  console.log('');
}

function printUsage() {
  console.log(`
${BOLD}Usage:${RESET}
  node src/cli.js check <owner> [options]
  npm run check -- <owner> [options]

${BOLD}Options:${RESET}
  --market <market>   Property location, e.g. "Dallas TX" (used for Xavier MSA check)
  --hq <location>     Owner HQ state, e.g. "VA", "Virginia", "McLean VA"
  --lease-up          Flag the property as a lease-up
  --class <class>     Property class, e.g. "Class A", "Class B"
  --type <type>       Property type, e.g. "Conventional MF", "Affordable"

${BOLD}Resolution hierarchy:${RESET}
  1. Top 50 owner              → Jack Harvey (always, regardless of market)
  2. Lease-up (3 conditions)   → Xavier (not Top 50, no owner relationship, Top 20 MSA)
  3. Owner-level assignment    → that rep, nationwide including referrals
  4. State/regional fallback   → rep for owner's HQ state (--hq), or property market if HQ unknown

${BOLD}Examples:${RESET}
  node src/cli.js check "Camden"
  node src/cli.js check "MAA" --market "Dallas TX"
  node src/cli.js check "Greystar" --market "Houston TX"
  node src/cli.js check "Unknown Owner" --market "Charlotte NC" --lease-up
  node src/cli.js check "Some Owner" --hq "Virginia" --market "Miami FL"
  node src/cli.js check "Some Owner" --market "Miami FL" --class "Class A"
`);
}

// ---------------------------------------------------------------------------
// Audit output formatting
// ---------------------------------------------------------------------------

const RULE_LABELS_AUDIT = {
  TOP_50:           'Top 50 Owner  → Jack Harvey',
  LEASE_UP:         'Lease-Up      → Xavier',
  OWNER_ASSIGNMENT: 'Owner Assignment',
  STATE_FALLBACK:   'State/Regional Fallback',
  UNASSIGNED:       'Unassigned'
};

function printConflictBlock(c, index, total) {
  const idx = index !== undefined ? ` ${index + 1} of ${total}` : '';
  console.log(BOLD + `  CONFLICT${idx}` + RESET);
  console.log(line('─'));
  console.log(` Company     : ${BOLD}${c.companyName}${RESET}`);
  console.log(` HubSpot     : ${DIM}${c.link}${RESET}`);
  console.log(` Market      : ${c.market}`);
  console.log(` Working it  : \x1b[31m${c.workingRep}${RESET}  (${c.activities} activit${c.activities !== 1 ? 'ies' : 'y'})`);
  console.log(` Should be   : \x1b[32m${BOLD}${c.expectedRep}${RESET}`);
  console.log(` Rule        : ${DIM}${RULE_LABELS_AUDIT[c.rule] || c.rule}${RESET}`);
}

function printAuditReport(result) {
  const { rep, hubspotOwner, daysBack, companies, conflicts, error } = result;

  console.log('');
  console.log(BOLD + line('═') + RESET);
  console.log(BOLD + ` AUDIT — ${rep}   ${DIM}│  last ${daysBack} days${RESET}`);
  console.log(BOLD + line('═') + RESET);

  if (error) {
    console.log(` \x1b[31m${error}${RESET}`);
    console.log(BOLD + line('═') + RESET);
    console.log('');
    return;
  }

  const ownerEmail = hubspotOwner?.email ? `  (${hubspotOwner.email})` : '';
  console.log(` HubSpot owner : ${hubspotOwner.firstName} ${hubspotOwner.lastName}${ownerEmail}`);
  console.log(` Companies hit : ${BOLD}${companies.length}${RESET}   ${DIM}│${RESET}   Conflicts: ${conflicts.length > 0 ? `\x1b[31m${BOLD}${conflicts.length}${RESET}` : `\x1b[32m${BOLD}0${RESET}`}`);

  if (conflicts.length === 0) {
    console.log('');
    console.log(` \x1b[32m✓  No conflicts — ${rep} is correctly assigned on all active accounts.\x1b[0m`);
  } else {
    console.log(line('─'));
    conflicts.forEach((c, i) => {
      printConflictBlock(c, i, conflicts.length);
      if (i < conflicts.length - 1) console.log(line('─'));
    });
  }

  console.log(BOLD + line('═') + RESET);
  console.log('');
}

function printAuditSummary(results) {
  const totalCompanies = results.reduce((n, r) => n + (r.companies?.length || 0), 0);
  const totalConflicts = results.reduce((n, r) => n + (r.conflicts?.length || 0), 0);
  const daysBack       = results[0]?.daysBack || 90;

  console.log('');
  console.log(BOLD + line('═') + RESET);
  console.log(BOLD + ' FULL TEAM AUDIT' + RESET + `   ${DIM}│  last ${daysBack} days${RESET}`);
  console.log(BOLD + line('═') + RESET);
  console.log(` Reps audited    : ${BOLD}${results.length}${RESET}`);
  console.log(` Companies found : ${BOLD}${totalCompanies}${RESET}   ${DIM}│${RESET}   Conflicts: ${totalConflicts > 0 ? `\x1b[31m${BOLD}${totalConflicts}${RESET}` : `\x1b[32m${BOLD}0${RESET}`}`);
  console.log(line('─'));

  // Per-rep summary
  console.log(BOLD + ' BY REP:' + RESET);
  for (const r of results) {
    if (r.error) {
      console.log(`   ${DIM}${r.rep.padEnd(22)} — not found in HubSpot${RESET}`);
      continue;
    }
    const flag = r.conflicts.length > 0 ? `  \x1b[31m⚠  ${r.conflicts.length} conflict${r.conflicts.length !== 1 ? 's' : ''}\x1b[0m` : `  \x1b[32m✓\x1b[0m`;
    console.log(`   ${r.rep.padEnd(22)} — ${String(r.companies.length).padStart(3)} companies${flag}`);
  }

  // Conflict detail grouped by rep
  const withConflicts = results.filter(r => r.conflicts?.length > 0);
  if (withConflicts.length > 0) {
    console.log('');
    console.log(BOLD + line('─') + RESET);
    console.log(BOLD + ' CONFLICTS:' + RESET);

    for (const r of withConflicts) {
      console.log('');
      console.log(BOLD + ` ${r.rep}` + RESET + DIM + ` (${r.conflicts.length} conflict${r.conflicts.length !== 1 ? 's' : ''})` + RESET);
      console.log(line('─'));
      r.conflicts.forEach((c, i) => {
        printConflictBlock(c, i, r.conflicts.length);
        if (i < r.conflicts.length - 1) console.log(line('─'));
      });
    }
  } else {
    console.log('');
    console.log(` \x1b[32m✓  No conflicts found across the entire team.\x1b[0m`);
  }

  console.log(BOLD + line('═') + RESET);
  console.log('');
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

const [,, command, ...rest] = process.argv;

(async () => {
  if (command === 'check') {
    if (!rest.length) {
      console.error('\x1b[31mError: Please provide an owner or property name.\x1b[0m');
      printUsage();
      process.exit(1);
    }

    let input = parseArgs(rest);

    if (!input.ownerName) {
      console.error('\x1b[31mError: Could not parse a name from arguments.\x1b[0m');
      printUsage();
      process.exit(1);
    }

    // ── Auto-enrichment ────────────────────────────────────────────────────
    // First check the local cache. If no hit, search the web and cache results.
    // Discovered owner, market, HQ, and property class are all applied to input
    // so downstream qualification and resolution use the enriched data.

    const cache = loadCache();
    const key   = cacheKey(input.ownerName);

    if (cache[key]) {
      // ── Cache hit ─────────────────────────────────────────────────────────
      const cached = cache[key];
      console.log(`\n\x1b[2m  Using cached data for "${input.ownerName}":\x1b[0m`);
      if (cached.ownerName) {
        console.log(`\x1b[2m    Owner  : ${cached.ownerName}\x1b[0m`);
        input.ownerName = cached.ownerName;
      }
      if (cached.market && !input.market) {
        console.log(`\x1b[2m    Market : ${cached.market}\x1b[0m`);
        input.market = cached.market;
      }
      if (cached.ownerHQ && !input.ownerHQ) {
        console.log(`\x1b[2m    HQ     : ${cached.ownerHQ}\x1b[0m`);
        input.ownerHQ = cached.ownerHQ;
      }
      if (cached.propertyClass && !input.propertyClass) {
        console.log(`\x1b[2m    Class  : ${cached.propertyClass}\x1b[0m`);
        input.propertyClass = cached.propertyClass;
      }

    } else if (looksLikePropertyName(input.ownerName)) {
      // ── Property name — search for owner + location + class ───────────────
      console.log(`\n\x1b[2m  Searching web for "${input.ownerName}"...\x1b[0m`);
      const enriched = await enrichFromPropertyName(input.ownerName);

      if (enriched.ownerName || enriched.market || enriched.ownerHQ || enriched.propertyClass) {
        console.log(`\x1b[2m  Enriched from web:\x1b[0m`);
        const toCache = { cachedAt: new Date().toISOString() };

        if (enriched.ownerName) {
          console.log(`\x1b[2m    Owner  : ${enriched.ownerName}\x1b[0m`);
          input.ownerName = toCache.ownerName = enriched.ownerName;
        }
        if (enriched.market && !input.market) {
          console.log(`\x1b[2m    Market : ${enriched.market}\x1b[0m`);
          input.market = toCache.market = enriched.market;
        }
        if (enriched.ownerHQ && !input.ownerHQ) {
          console.log(`\x1b[2m    HQ     : ${enriched.ownerHQ}\x1b[0m`);
          input.ownerHQ = toCache.ownerHQ = enriched.ownerHQ;
        }
        if (enriched.propertyClass && !input.propertyClass) {
          console.log(`\x1b[2m    Class  : ${enriched.propertyClass}\x1b[0m`);
          input.propertyClass = toCache.propertyClass = enriched.propertyClass;
        }

        cache[key] = toCache;
        saveCache(cache);
      } else {
        console.log(`\x1b[33m  Could not enrich "${input.ownerName}" from web — proceeding with available data.\x1b[0m`);
      }

    } else if (!input.ownerHQ && !input.market) {
      // ── Owner name known but no location — search for HQ ──────────────────
      console.log(`\n\x1b[2m  Searching for HQ of "${input.ownerName}"...\x1b[0m`);
      const hq = await enrichOwnerHQ(input.ownerName);
      if (hq) {
        console.log(`\x1b[2m    HQ     : ${hq}\x1b[0m`);
        input.ownerHQ = hq;
        cache[key] = { ownerHQ: hq, cachedAt: new Date().toISOString() };
        saveCache(cache);
      }
    }

    // ── Qualification gate ─────────────────────────────────────────────────
    const qual = qualify(input);

    if (!qual.qualified) {
      console.log('');
      console.log('\x1b[31m' + BOLD + ' LEAD DISQUALIFIED' + RESET);
      console.log(line('─'));
      qual.reasons.forEach(r => console.log(` ✗  ${r}`));
      console.log('');
      console.log(` This property/owner does not meet Class A/B Conventional MF`);
      console.log(` criteria. No ownership resolution performed.`);
      console.log('');
      process.exit(0);
    }

    if (qual.flags.length > 0) {
      console.log('');
      console.log('\x1b[33mQualification notes:\x1b[0m');
      qual.flags.forEach(f => console.log(`  ℹ  ${f}`));
    }

    const result = resolve(input);
    printResult(result);

  } else if (command === 'audit') {
    // ── audit <rep name> [--days <n>] ─────────────────────────────────────
    if (!rest.length) {
      console.error('\x1b[31mError: Please provide a rep name, e.g. "audit Scout Bishop"\x1b[0m');
      process.exit(1);
    }

    // Extract --days flag, rest is the rep name
    let daysBack = 90;
    const nameTokens = [];
    for (let i = 0; i < rest.length; i++) {
      if (rest[i] === '--days' && rest[i + 1]) { daysBack = parseInt(rest[++i], 10) || 90; }
      else if (!rest[i].startsWith('--')) nameTokens.push(rest[i]);
    }
    const repName = nameTokens.join(' ').trim();

    if (!repName) {
      console.error('\x1b[31mError: Could not parse a rep name from arguments.\x1b[0m');
      process.exit(1);
    }

    const progress = (msg) => process.stderr.write(`\x1b[2m${msg}\x1b[0m\n`);
    progress(`\nAuditing ${repName}...`);

    const result = await auditRep(repName, { daysBack, progress });
    printAuditReport(result);

  } else if (command === 'audit-all') {
    // ── audit-all [--days <n>] ────────────────────────────────────────────
    let daysBack = 90;
    for (let i = 0; i < rest.length; i++) {
      if (rest[i] === '--days' && rest[i + 1]) daysBack = parseInt(rest[++i], 10) || 90;
    }

    const progress = (msg) => process.stderr.write(`\x1b[2m${msg}\x1b[0m\n`);

    // Pre-fetch shared data once
    progress('\nFetching HubSpot owners and portal ID...');
    const { getOwners, getPortalId } = require('./hubspot');
    const [allOwners, portalId] = await Promise.all([getOwners(), getPortalId()]);
    progress(`  ${allOwners.length} HubSpot owners found. Portal ID: ${portalId}\n`);

    const results = [];
    for (const rep of KNOWN_REPS) {
      progress(`Auditing ${rep}...`);
      const result = await auditRep(rep, { daysBack, allOwners, portalId, progress });
      results.push(result);
      progress('');
    }

    printAuditSummary(results);

  } else {
    printUsage();
  }
})();
