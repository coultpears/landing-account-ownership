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

const readline = require('readline');

const { resolve } = require('./engine');
const { qualify } = require('./qualify');
const { enrichFromPropertyName, enrichOwnerHQ, enrichCompanyLocation, looksLikePropertyName } = require('./search');
const { auditRep, KNOWN_REPS } = require('./audit');
const { getCompany, updateCompany, getOwners, getPortalId, ensureOwnershipRuleProperty } = require('./hubspot');

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
// Config + log helpers (used by audit interactive flow)
// ---------------------------------------------------------------------------

function loadCliConfig() {
  try {
    return JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'config.json'), 'utf8'));
  } catch {
    return { repOwnerIds: {} };
  }
}

function appendLog(entry) {
  const logPath = path.join(__dirname, '..', 'data', 'log.json');
  let log = [];
  try { log = JSON.parse(fs.readFileSync(logPath, 'utf8')); } catch { log = []; }
  log.push(entry);
  try { fs.writeFileSync(logPath, JSON.stringify(log, null, 2)); } catch { /* non-fatal */ }
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
// Shared helpers
// ---------------------------------------------------------------------------

function humanizeDays(n) {
  if (n === null || n === undefined) return '—';
  if (n === 0)  return 'today';
  if (n === 1)  return 'yesterday';
  if (n < 7)    return `${n}d ago`;
  if (n < 30)   return `${Math.round(n / 7)}w ago`;
  if (n < 365)  return `${Math.round(n / 30)}mo ago`;
  return `${Math.round(n / 365)}y ago`;
}

function qualBadge(status) {
  if (status === 'qualified')   return `\x1b[32m● MF\x1b[0m`;
  if (status === 'not-mf')      return `\x1b[31m● Non-MF\x1b[0m`;
  return `\x1b[33m● Unverified\x1b[0m`;
}

function prompt(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => rl.question(question, ans => { rl.close(); resolve(ans.trim()); }));
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
  const idx      = index !== undefined ? ` ${index + 1} of ${total}` : '';
  const recency  = humanizeDays(c.daysSince);
  const actLabel = `${c.activities} activit${c.activities !== 1 ? 'ies' : 'y'}`;
  console.log(BOLD + `  CONFLICT${idx}` + RESET);
  console.log(line('─'));
  console.log(` Company       : ${BOLD}${c.companyName}${RESET}  ${qualBadge(c.qualStatus)}`);
  console.log(` HubSpot       : ${DIM}${c.link}${RESET}`);
  console.log(` Market        : ${c.market}`);
  console.log(` Last activity : ${BOLD}${recency}${RESET}  ${DIM}(${actLabel})${RESET}`);
  console.log(` Working it    : \x1b[31m${c.workingRep}${RESET}`);
  console.log(` Should be     : \x1b[32m${BOLD}${c.expectedRep}${RESET}`);
  console.log(` Rule          : ${DIM}${RULE_LABELS_AUDIT[c.rule] || c.rule}${RESET}`);
}

/**
 * After printing a conflict block, prompt the user to reassign the HubSpot
 * company owner to the correct rep. Always writes landing_ownership_rule —
 * either the rule tier (accepted) or an EXCEPTION note (declined).
 */
async function promptConflictReassignment(c, config) {
  const repOwnerIds = config.repOwnerIds || {};
  const today       = new Date().toISOString().slice(0, 10);

  if (c.expectedRep === 'UNASSIGNED') return;

  const expectedReps = c.expectedRep.split(' / ').map(r => r.trim()).filter(Boolean);
  const assignable   = expectedReps.filter(r => repOwnerIds[r]);

  if (assignable.length === 0) {
    console.log(`  ${DIM}(No HubSpot owner ID mapped for "${c.expectedRep}" — skipping auto-assign)${RESET}`);
    return;
  }

  let targetRep;

  if (assignable.length === 1) {
    targetRep = assignable[0];
    const ans = await prompt(
      `  Reassign to \x1b[32m${BOLD}${targetRep}${RESET} based on ${DIM}${c.rule}${RESET}?` +
      ` Currently: \x1b[31m${c.workingRep}${RESET}. [y/N] `
    );
    if (!ans.toLowerCase().startsWith('y')) {
      const ruleValue = `EXCEPTION — ${c.rule} declined by user on ${today}`;
      try { await updateCompany(c.companyId, { landing_ownership_rule: ruleValue }); }
      catch (e) { console.log(`  \x1b[33m  Warning: could not write ownership rule: ${e.message}\x1b[0m`); }
      appendLog({ timestamp: new Date().toISOString(), rule: 'OWNER_REASSIGNMENT', action: 'declined',
        companyId: c.companyId, companyName: c.companyName, from: c.workingRep, to: targetRep, hsRule: c.rule });
      console.log(`  ${DIM}Logged as declined.${RESET}`);
      return;
    }
  } else {
    // Multiple reps qualify — let user pick
    const choices = assignable.map((r, i) => `[${i + 1}] ${r}`).join('  ');
    console.log(`  Multiple reps qualify: ${choices}`);
    const ans = await prompt(`  Reassign to which rep? Enter 1–${assignable.length}, or [n]o: `);
    if (!ans || ans.toLowerCase().startsWith('n')) {
      const ruleValue = `EXCEPTION — ${c.rule} declined by user on ${today}`;
      try { await updateCompany(c.companyId, { landing_ownership_rule: ruleValue }); }
      catch {}
      console.log(`  ${DIM}Logged as declined.${RESET}`);
      return;
    }
    const idx = parseInt(ans, 10) - 1;
    if (isNaN(idx) || idx < 0 || idx >= assignable.length) {
      console.log(`  Invalid selection — skipping.`);
      return;
    }
    targetRep = assignable[idx];
  }

  // Apply the owner update + write landing_ownership_rule
  const newOwnerId = repOwnerIds[targetRep];
  try {
    await updateCompany(c.companyId, {
      hubspot_owner_id:      newOwnerId,
      landing_ownership_rule: c.rule
    });
    console.log(`  \x1b[32m✓  HubSpot owner → ${targetRep}\x1b[0m`);
    appendLog({ timestamp: new Date().toISOString(), rule: 'OWNER_REASSIGNMENT', action: 'accepted',
      companyId: c.companyId, companyName: c.companyName, from: c.workingRep, to: targetRep,
      newOwnerId, hsRule: c.rule });
  } catch (e) {
    console.log(`  \x1b[31m  Error updating HubSpot: ${e.message}\x1b[0m`);
  }
}

async function runAuditReport(result, { qualifiedOnly = false } = {}) {
  const { rep, hubspotOwner, daysBack, companies, conflicts, excluded = 0, error } = result;

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

  const ownerEmail   = hubspotOwner?.email ? `  (${hubspotOwner.email})` : '';
  const excludedNote = excluded > 0 ? `  ${DIM}(${excluded} vendor/tool records excluded)${RESET}` : '';
  const filterNote   = qualifiedOnly ? `  ${DIM}(--qualified-only: non-MF hidden)${RESET}` : '';
  console.log(` HubSpot owner : ${hubspotOwner.firstName} ${hubspotOwner.lastName}${ownerEmail}`);
  console.log(` Companies hit : ${BOLD}${companies.length}${RESET}${excludedNote}`);
  console.log(` Conflicts     : ${conflicts.length > 0 ? `\x1b[31m${BOLD}${conflicts.length}${RESET}` : `\x1b[32m${BOLD}0${RESET}`}${filterNote}`);

  if (conflicts.length === 0) {
    console.log('');
    console.log(` \x1b[32m✓  No conflicts — ${rep} is correctly assigned on all active accounts.\x1b[0m`);
  } else {
    const config = loadCliConfig();
    console.log(line('─'));
    for (let i = 0; i < conflicts.length; i++) {
      printConflictBlock(conflicts[i], i, conflicts.length);
      await promptConflictReassignment(conflicts[i], config);
      if (i < conflicts.length - 1) console.log(line('─'));
    }
  }

  console.log(BOLD + line('═') + RESET);
  console.log('');
}

async function runAuditSummary(results) {
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
    const excl = r.excluded > 0 ? ` ${DIM}(${r.excluded} excl.)${RESET}` : '';
    const flag = r.conflicts.length > 0 ? `  \x1b[31m⚠  ${r.conflicts.length} conflict${r.conflicts.length !== 1 ? 's' : ''}\x1b[0m` : `  \x1b[32m✓\x1b[0m`;
    console.log(`   ${r.rep.padEnd(22)} — ${String(r.companies.length).padStart(3)} companies${excl}${flag}`);
  }

  // Conflict detail grouped by rep
  const withConflicts = results.filter(r => r.conflicts?.length > 0);
  if (withConflicts.length > 0) {
    console.log('');
    console.log(BOLD + line('─') + RESET);
    console.log(BOLD + ' CONFLICTS:' + RESET);

    const config = loadCliConfig();
    for (const r of withConflicts) {
      console.log('');
      console.log(BOLD + ` ${r.rep}` + RESET + DIM + ` (${r.conflicts.length} conflict${r.conflicts.length !== 1 ? 's' : ''})` + RESET);
      console.log(line('─'));
      for (let i = 0; i < r.conflicts.length; i++) {
        printConflictBlock(r.conflicts[i], i, r.conflicts.length);
        await promptConflictReassignment(r.conflicts[i], config);
        if (i < r.conflicts.length - 1) console.log(line('─'));
      }
    }
  } else {
    console.log('');
    console.log(` \x1b[32m✓  No conflicts found across the entire team.\x1b[0m`);
  }

  console.log(BOLD + line('═') + RESET);
  console.log('');
}

// ---------------------------------------------------------------------------
// Fix helpers
// ---------------------------------------------------------------------------

/**
 * Fetch a company from HubSpot, search the web for corrected location data,
 * show a diff, and if confirmed, write the update back to HubSpot.
 */
async function runFix(recordId) {
  console.log('');
  console.log(BOLD + line('═') + RESET);
  console.log(BOLD + ` FIX — Company ${recordId}` + RESET);
  console.log(BOLD + line('═') + RESET);

  let company;
  try {
    company = await getCompany(recordId);
  } catch (e) {
    console.error(` \x1b[31mError fetching company: ${e.message}\x1b[0m`);
    console.log(BOLD + line('═') + RESET);
    return false;
  }

  const props = company.properties || {};
  const name  = props.name || `(ID: ${recordId})`;

  console.log(` Company  : ${BOLD}${name}${RESET}`);
  console.log(` HubSpot  : https://app.hubspot.com/contacts/${process.env.HUBSPOT_PORTAL_ID || '?'}/company/${recordId}`);
  console.log('');
  console.log(` Current values:`);
  console.log(`   city    : ${props.city    || DIM + '(blank)' + RESET}`);
  console.log(`   state   : ${props.state   || DIM + '(blank)' + RESET}`);
  console.log(`   address : ${props.address || DIM + '(blank)' + RESET}`);
  console.log('');

  console.log(`\x1b[2m  Searching web for "${name}" headquarters location...\x1b[0m`);
  const found = await enrichCompanyLocation(name);

  if (!found.city && !found.state && !found.address) {
    console.log(`\x1b[33m  Could not find location data via web search.\x1b[0m`);
    console.log(`\x1b[33m  Tip: search manually and update via the link above.\x1b[0m`);
    console.log(BOLD + line('═') + RESET);
    return false;
  }

  console.log(` Proposed corrections:`);
  if (found.city)    console.log(`   city    : ${BOLD}\x1b[32m${found.city}\x1b[0m${RESET}   ${DIM}(was: ${props.city || 'blank'})${RESET}`);
  if (found.state)   console.log(`   state   : ${BOLD}\x1b[32m${found.state}\x1b[0m${RESET}   ${DIM}(was: ${props.state || 'blank'})${RESET}`);
  if (found.address) console.log(`   address : ${BOLD}\x1b[32m${found.address}\x1b[0m${RESET}   ${DIM}(was: ${props.address || 'blank'})${RESET}`);
  console.log('');

  const ans = await prompt(` Apply these changes? [y/N] `);
  if (!ans.toLowerCase().startsWith('y')) {
    console.log(` Skipped.`);
    console.log(BOLD + line('═') + RESET);
    return false;
  }

  const update = {};
  if (found.city)    update.city    = found.city;
  if (found.state)   update.state   = found.state;
  if (found.address) update.address = found.address;

  try {
    await updateCompany(recordId, update);
    console.log(` \x1b[32m✓  HubSpot record updated.\x1b[0m`);

    // Append to audit log
    const logPath = path.join(__dirname, '..', 'data', 'log.json');
    let log = [];
    try { log = JSON.parse(fs.readFileSync(logPath, 'utf8')); } catch { log = []; }
    log.push({
      timestamp:   new Date().toISOString(),
      rule:        'FIX',
      companyId:   recordId,
      companyName: name,
      before:      { city: props.city || null, state: props.state || null, address: props.address || null },
      after:       update,
      source:      'cli fix command'
    });
    fs.writeFileSync(logPath, JSON.stringify(log, null, 2));
  } catch (e) {
    console.error(` \x1b[31mError updating HubSpot: ${e.message}\x1b[0m`);
    console.log(BOLD + line('═') + RESET);
    return false;
  }

  console.log(BOLD + line('═') + RESET);
  console.log('');
  return true;
}

/**
 * Batch-fix a list of conflict records that have missing location data.
 * Prompts for confirmation on each one.
 */
async function runBatchFix(records) {
  let fixed = 0;
  for (const record of records) {
    const didFix = await runFix(record.companyId);
    if (didFix) fixed++;
  }
  if (fixed > 0) {
    console.log(`\x1b[32m  ✓  ${fixed} of ${records.length} records updated in HubSpot.\x1b[0m\n`);
  }
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
    // ── audit <rep name> [--days <n>] [--qualified-only] [--fix] ──────────
    if (!rest.length) {
      console.error('\x1b[31mError: Please provide a rep name, e.g. "audit Scout Bishop"\x1b[0m');
      process.exit(1);
    }

    let daysBack = 90, qualifiedOnly = false, fix = false;
    const nameTokens = [];
    for (let i = 0; i < rest.length; i++) {
      if (rest[i] === '--days' && rest[i + 1])  { daysBack = parseInt(rest[++i], 10) || 90; }
      else if (rest[i] === '--qualified-only')   { qualifiedOnly = true; }
      else if (rest[i] === '--fix')              { fix = true; }
      else if (!rest[i].startsWith('--'))        { nameTokens.push(rest[i]); }
    }
    const repName = nameTokens.join(' ').trim();

    if (!repName) {
      console.error('\x1b[31mError: Could not parse a rep name from arguments.\x1b[0m');
      process.exit(1);
    }

    const progress = (msg) => process.stderr.write(`\x1b[2m${msg}\x1b[0m\n`);
    progress(`\nAuditing ${repName}...`);

    await ensureOwnershipRuleProperty();
    const result = await auditRep(repName, { daysBack, qualifiedOnly, progress });
    await runAuditReport(result, { qualifiedOnly });

    // ── --fix: batch-fix companies with missing location data ─────────────
    if (fix && result.conflicts?.length > 0) {
      const missing = result.conflicts.filter(c => c.market === '—');
      if (missing.length === 0) {
        console.log(`\x1b[2m  --fix: all conflict companies have location data. Nothing to fix.\x1b[0m\n`);
      } else {
        console.log(`\x1b[33m  --fix: ${missing.length} conflict compan${missing.length !== 1 ? 'ies' : 'y'} missing city/state. Searching for corrections...\x1b[0m\n`);
        await runBatchFix(missing);
      }
    }

  } else if (command === 'audit-all') {
    // ── audit-all [--days <n>] [--qualified-only] ─────────────────────────
    let daysBack = 90, qualifiedOnly = false;
    for (let i = 0; i < rest.length; i++) {
      if (rest[i] === '--days' && rest[i + 1]) daysBack = parseInt(rest[++i], 10) || 90;
      else if (rest[i] === '--qualified-only')  qualifiedOnly = true;
    }

    const progress = (msg) => process.stderr.write(`\x1b[2m${msg}\x1b[0m\n`);

    progress('\nFetching HubSpot owners and portal ID...');
    const [allOwners, portalId] = await Promise.all([getOwners(), getPortalId()]);
    progress(`  ${allOwners.length} HubSpot owners found. Portal ID: ${portalId}\n`);

    await ensureOwnershipRuleProperty();

    const results = [];
    for (const rep of KNOWN_REPS) {
      progress(`Auditing ${rep}...`);
      const result = await auditRep(rep, { daysBack, allOwners, portalId, qualifiedOnly, progress });
      results.push(result);
      progress('');
    }

    await runAuditSummary(results);

  } else if (command === 'fix') {
    // ── fix <hubspot-record-id> ───────────────────────────────────────────
    const recordId = rest.find(r => !r.startsWith('--'));
    if (!recordId) {
      console.error('\x1b[31mError: Please provide a HubSpot company record ID, e.g. "fix 8924545632"\x1b[0m');
      process.exit(1);
    }

    await runFix(recordId);

  } else {
    printUsage();
  }
})();
