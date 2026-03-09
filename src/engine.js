'use strict';

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');

// ---------------------------------------------------------------------------
// Data loading
// ---------------------------------------------------------------------------

function loadData() {
  const owners = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'owners.json'), 'utf8'));
  const assignments = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'assignments.json'), 'utf8'));
  return { owners, assignments };
}

// ---------------------------------------------------------------------------
// Fuzzy matching
// ---------------------------------------------------------------------------

function normalize(str) {
  return str
    .toLowerCase()
    .replace(/[&]/g, 'and')
    .replace(/[^a-z0-9\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Score how well a query matches a candidate name + aliases.
 * Returns a score 0–1 and a match type string.
 */
function scoreMatch(query, candidateName, aliases = []) {
  const q = normalize(query);
  const allNames = [candidateName, ...aliases].map(normalize);

  for (const name of allNames) {
    // Exact
    if (q === name) return { score: 1.0, type: 'exact' };

    // Full substring either direction
    if (name.includes(q) || q.includes(name)) {
      return { score: 0.9, type: 'contains' };
    }
  }

  // Word-level matching against all names
  const qWords = q.split(' ').filter(w => w.length > 2);
  let bestWordScore = 0;

  for (const name of allNames) {
    const nameWords = name.split(' ');
    const hits = qWords.filter(w => nameWords.includes(w));
    if (hits.length > 0) {
      const score = 0.65 * (hits.length / Math.max(qWords.length, nameWords.length));
      if (score > bestWordScore) bestWordScore = score;
    }
  }

  if (bestWordScore > 0) return { score: bestWordScore, type: 'word' };

  return { score: 0, type: 'none' };
}

/**
 * Find the best fuzzy match for ownerName in a list of candidates.
 * Each candidate must have a `name` field and optionally an `aliases` array.
 * Returns null if no match exceeds the threshold.
 */
function fuzzyMatch(query, candidates, threshold = 0.3) {
  let best = null;
  let bestScore = 0;

  for (const candidate of candidates) {
    const { score, type } = scoreMatch(query, candidate.name, candidate.aliases || []);
    if (score > bestScore) {
      bestScore = score;
      best = { match: candidate, score, type };
    }
  }

  return bestScore >= threshold ? best : null;
}

// ---------------------------------------------------------------------------
// Market resolution
// ---------------------------------------------------------------------------

function getMarketReps(market, assignments) {
  const { marketAssignments, regionAssignments } = assignments;

  // Direct market assignment first
  const direct = marketAssignments.find(
    a => normalize(a.market) === normalize(market)
  );
  if (direct) {
    return { reps: direct.reps, source: 'market', label: direct.market };
  }

  // Region fallback — derive state code from last token of market string (e.g. "Charlotte NC" → "NC")
  const parts = market.trim().split(' ');
  const stateCode = parts[parts.length - 1].toUpperCase();

  for (const region of regionAssignments) {
    if (!region.states.includes(stateCode)) continue;

    const excluded = (region.excludedMarkets || []).some(
      m => normalize(m) === normalize(market)
    );
    if (excluded) continue;

    return { reps: region.reps, source: 'region', label: region.region };
  }

  return null;
}

// ---------------------------------------------------------------------------
// Audit log
// ---------------------------------------------------------------------------

function logCheck(entry) {
  const logPath = path.join(DATA_DIR, 'log.json');
  let log = [];
  try {
    log = JSON.parse(fs.readFileSync(logPath, 'utf8'));
  } catch {
    log = [];
  }
  log.push(entry);
  fs.writeFileSync(logPath, JSON.stringify(log, null, 2));
}

// ---------------------------------------------------------------------------
// Resolution engine — four-tier hierarchy
// ---------------------------------------------------------------------------

/**
 * Resolve ownership for a given input.
 *
 * Input shape:
 *   ownerName    {string}  — required
 *   market       {string}  — optional, e.g. "Dallas TX"
 *   isLeaseUp    {boolean} — optional
 *   propertyClass {string} — optional, e.g. "Class A"
 *   propertyType  {string} — optional, e.g. "Conventional MF"
 *
 * Resolution hierarchy:
 *   1. Top 50 owner                          → Jack Thomasson
 *   2. Lease-up + NOT Top 50                 → Xavier
 *   3. Owner-level assignment (beats market) → assigned rep
 *   4. Market-level fallback                 → market/region rep(s)
 *   5. Unassigned
 */
function resolve(input) {
  const { owners, assignments } = loadData();
  const { ownerName, market, isLeaseUp } = input;

  const result = {
    input,
    timestamp: new Date().toISOString(),
    rep: null,
    rule: null,
    explanation: null,
    matchedOwner: null,
    conflict: false,
    warnings: []
  };

  // ── Tier 1: Top 50 ────────────────────────────────────────────────────────
  const top50Hit = fuzzyMatch(ownerName, owners.top50);
  if (top50Hit) {
    result.rep = 'Jack Thomasson';
    result.rule = 'TOP_50';
    result.matchedOwner = top50Hit.match.name;
    result.explanation =
      `"${ownerName}" matched Top 50 owner "${top50Hit.match.name}" ` +
      `(${top50Hit.type} match, confidence ${pct(top50Hit.score)}). ` +
      `All Top 50 owners are assigned to Jack Thomasson regardless of market.`;
    finalize(result);
    return result;
  }

  // ── Tier 2: Lease-up (owner NOT in Top 50) ───────────────────────────────
  if (isLeaseUp) {
    result.rep = 'Xavier';
    result.rule = 'LEASE_UP';
    result.explanation =
      `"${ownerName}" is not a Top 50 owner, and this property is flagged as lease-up. ` +
      `Lease-up properties with non-Top-50 owners route to Xavier.`;
    finalize(result);
    return result;
  }

  // ── Tier 3: Owner-level assignment ───────────────────────────────────────
  // Build a searchable list from ownerAssignments (each has .owner + .aliases)
  const ownerCandidates = assignments.ownerAssignments.map(a => ({
    name: a.owner,
    aliases: a.aliases || [],
    _raw: a
  }));
  const ownerHit = fuzzyMatch(ownerName, ownerCandidates);

  if (ownerHit) {
    const assignment = ownerHit.match._raw;
    result.rep = assignment.rep;
    result.rule = 'OWNER_ASSIGNMENT';
    result.matchedOwner = assignment.owner;
    result.explanation =
      `"${ownerName}" matched owner-level assignment for "${assignment.owner}" ` +
      `(${ownerHit.type} match, confidence ${pct(ownerHit.score)}). ` +
      `Owner-level assignments take precedence over market assignments. ` +
      `Assigned to ${assignment.rep}.`;

    // Warn if a market was provided and it has a different rep
    if (market) {
      const marketResult = getMarketReps(market, assignments);
      if (marketResult && !marketResult.reps.includes(assignment.rep)) {
        result.warnings.push(
          `Market "${market}" is assigned to ${marketResult.reps.join('/')} but owner-level ` +
          `assignment overrides this to ${assignment.rep}. No conflict — owner wins.`
        );
      }
    }

    finalize(result);
    return result;
  }

  // ── Tier 4: Market-level fallback ────────────────────────────────────────
  if (market) {
    const marketResult = getMarketReps(market, assignments);
    if (marketResult) {
      result.rep = marketResult.reps;
      result.rule = 'MARKET_FALLBACK';
      result.explanation =
        `No Top 50, lease-up, or owner-level assignment found for "${ownerName}". ` +
        `Falling back to ${marketResult.source} assignment for "${market}" → ` +
        `${marketResult.label}. Assigned to: ${marketResult.reps.join(', ')}.`;

      if (marketResult.reps.length > 1) {
        result.warnings.push(
          `Multiple reps cover this market (${marketResult.reps.join(', ')}). ` +
          `Coordinate coverage or assign a primary.`
        );
      }

      finalize(result);
      return result;
    }
  }

  // ── Tier 5: Unassigned ───────────────────────────────────────────────────
  result.rule = 'UNASSIGNED';
  result.explanation =
    `No assignment found for "${ownerName}"` +
    (market ? ` in market "${market}"` : '') +
    `. Not in Top 50, not a lease-up, no owner-level assignment, and no market assignment found.`;
  result.warnings.push('This lead is unassigned. Manual assignment required.');
  finalize(result);
  return result;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function pct(score) {
  return `${Math.round(score * 100)}%`;
}

function finalize(result) {
  logCheck({
    timestamp: result.timestamp,
    rule: result.rule,
    ownerQuery: result.input.ownerName,
    matchedOwner: result.matchedOwner,
    market: result.input.market || null,
    isLeaseUp: result.input.isLeaseUp || false,
    rep: Array.isArray(result.rep) ? result.rep.join(', ') : result.rep,
    conflict: result.conflict,
    warnings: result.warnings
  });
}

module.exports = { resolve, fuzzyMatch, getMarketReps };
