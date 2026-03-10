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
  const markets = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'markets.json'), 'utf8'));
  return { owners, assignments, markets };
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

// Words that appear in many company names and carry no discriminating signal.
// Excluded from word-level scoring to prevent false positives like
// "Lennar Multifamily" → "FPA Multifamily" or "The Graham Companies" → "The Related Companies".
const STOPWORDS = new Set([
  // Articles / conjunctions / prepositions
  'the', 'a', 'an', 'of', 'and', 'or', 'in', 'at', 'by', 'for',
  // Legal entity suffixes
  'llc', 'inc', 'corp', 'ltd', 'co',
  // Generic real estate / business descriptors
  'company', 'companies', 'group', 'capital', 'properties', 'property',
  'management', 'residential', 'real', 'estate', 'investments', 'investment',
  'trust', 'realty', 'partners', 'multifamily', 'apartment', 'apartments',
  'communities', 'community', 'housing', 'homes', 'assets', 'fund',
  'holdings', 'services', 'solutions', 'ventures', 'advisors', 'advisory'
]);

/**
 * Score how well a query matches a candidate name + aliases.
 * Returns a score 0–1 and a match type string.
 *
 * Contains-match direction rule:
 *   name.includes(q)  — always valid (e.g. "Camden" found inside "Camden Property Trust")
 *   q.includes(name)  — only valid if name has 2+ words; prevents single generic-word
 *                       aliases (e.g. "Related") from matching inside longer queries
 *                       (e.g. "Related Group")
 *
 * Word-level scoring strips STOPWORDS from both sides before comparing, so
 * shared generic words like "Companies", "Group", "Multifamily" don't drive matches.
 */
function scoreMatch(query, candidateName, aliases = []) {
  const q = normalize(query);
  const allNames = [candidateName, ...aliases].map(normalize);

  for (const name of allNames) {
    // Exact
    if (q === name) return { score: 1.0, type: 'exact' };

    // name found inside query — always valid
    if (name.includes(q)) return { score: 0.9, type: 'contains' };

    // query contains name — only if name is 2+ words (guards against short generic aliases)
    if (q.includes(name) && name.split(' ').filter(Boolean).length >= 2) {
      return { score: 0.9, type: 'contains' };
    }
  }

  // Word-level matching — strip stopwords from both sides before comparing
  const qWords = q.split(' ').filter(w => w.length > 2 && !STOPWORDS.has(w));
  if (qWords.length === 0) return { score: 0, type: 'none' };

  let bestWordScore = 0;

  for (const name of allNames) {
    const nameWords = name.split(' ').filter(w => !STOPWORDS.has(w));
    if (nameWords.length === 0) continue;
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
 *
 * Threshold raised to 0.4 — with stopwords stripped, a 40% word-overlap
 * score represents meaningful content-word similarity, not coincidental hits.
 */
function fuzzyMatch(query, candidates, threshold = 0.4) {
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
// Top 20 MSA check
// ---------------------------------------------------------------------------

/**
 * Returns the matching MSA object if the market string falls within a Top 20
 * MSA, or null if it does not.
 *
 * Matching uses whole-word comparison: the market string is tokenized and each
 * keyword is checked as a full token match (or multi-word phrase match).
 * This prevents short keywords like "LA" from falsely matching inside words
 * like "Dallas" or "Orlando".
 */
function getTop20MSA(market, markets) {
  if (!market || !markets) return null;
  const mLower = market.toLowerCase();
  // Tokenize the market string for word-boundary checks
  const mTokens = mLower.replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(Boolean);

  for (const msa of markets.top20MSAs) {
    const matched = msa.keywords.some(kw => {
      const kwLower = kw.toLowerCase();
      // Multi-word keywords: use substring match (phrase is specific enough)
      if (kwLower.includes(' ')) return mLower.includes(kwLower);
      // Single-word keywords: require exact token match to avoid false positives
      return mTokens.includes(kwLower);
    });
    if (matched) return msa;
  }
  return null;
}

// ---------------------------------------------------------------------------
// State code resolution
// ---------------------------------------------------------------------------

const STATE_NAMES = {
  'alabama': 'AL', 'alaska': 'AK', 'arizona': 'AZ', 'arkansas': 'AR',
  'california': 'CA', 'colorado': 'CO', 'connecticut': 'CT', 'delaware': 'DE',
  'florida': 'FL', 'georgia': 'GA', 'hawaii': 'HI', 'idaho': 'ID',
  'illinois': 'IL', 'indiana': 'IN', 'iowa': 'IA', 'kansas': 'KS',
  'kentucky': 'KY', 'louisiana': 'LA', 'maine': 'ME', 'maryland': 'MD',
  'massachusetts': 'MA', 'michigan': 'MI', 'minnesota': 'MN', 'mississippi': 'MS',
  'missouri': 'MO', 'montana': 'MT', 'nebraska': 'NE', 'nevada': 'NV',
  'new hampshire': 'NH', 'new jersey': 'NJ', 'new mexico': 'NM', 'new york': 'NY',
  'north carolina': 'NC', 'north dakota': 'ND', 'ohio': 'OH', 'oklahoma': 'OK',
  'oregon': 'OR', 'pennsylvania': 'PA', 'rhode island': 'RI', 'south carolina': 'SC',
  'south dakota': 'SD', 'tennessee': 'TN', 'texas': 'TX', 'utah': 'UT',
  'vermont': 'VT', 'virginia': 'VA', 'washington': 'WA', 'west virginia': 'WV',
  'wisconsin': 'WI', 'wyoming': 'WY', 'district of columbia': 'DC'
};

/**
 * Extract a 2-letter state code from a location string.
 * Accepts: "VA", "McLean VA", "Virginia", "virginia", "Atlanta GA", etc.
 */
function extractStateCode(locationStr) {
  const str = locationStr.trim();
  const lastToken = str.split(' ').pop().toUpperCase();

  // Standard 2-letter code as last token
  if (/^[A-Z]{2}$/.test(lastToken)) return lastToken;

  // Full state name (whole string or substring)
  const lower = str.toLowerCase();
  // Check longest matches first to handle "west virginia" before "virginia"
  const sortedNames = Object.keys(STATE_NAMES).sort((a, b) => b.length - a.length);
  for (const name of sortedNames) {
    if (lower.includes(name)) return STATE_NAMES[name];
  }

  return lastToken; // last resort
}

// ---------------------------------------------------------------------------
// State-based regional resolution
// ---------------------------------------------------------------------------

/**
 * Given a location string (owner HQ or property market), return all reps
 * assigned to that state via stateAssignments.
 *
 * Matching logic:
 *   - Extract state code via extractStateCode().
 *   - Find all stateAssignments whose states[] includes that code.
 *   - For assignments with subMarkets[], only include if the location string
 *     contains one of the sub-market keywords (case-insensitive).
 *   - Assignments with no subMarkets[] always match their state.
 *   - If sub-market filtering eliminates ALL state matches, fall back and
 *     return every rep assigned to that state (with a warning flag).
 */
function getStateReps(location, assignments) {
  const { stateAssignments } = assignments;
  if (!stateAssignments) return null;

  const stateCode = extractStateCode(location);
  const marketNorm = location.toLowerCase();

  const allForState = stateAssignments.filter(a => a.states.includes(stateCode));
  if (allForState.length === 0) return null;

  const matched = allForState.filter(a => {
    if (!a.subMarkets || a.subMarkets.length === 0) return true;
    return a.subMarkets.some(sm => marketNorm.includes(sm.toLowerCase()));
  });

  // If sub-market filtering zeroed out results, surface all state reps with a warning
  const results = matched.length > 0 ? matched : allForState;
  const fallback = matched.length === 0;

  return {
    reps: results.map(a => a.rep),
    details: results.map(a => ({ rep: a.rep, focus: a.focus || null })),
    stateCode,
    fallback
  };
}

/**
 * Extract just the state code from a location string — thin wrapper
 * used when callers only need the code without a full rep lookup.
 */
function stateCodeOf(locationStr) {
  return extractStateCode(locationStr);
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
 *   0. Known non-Top-50 owner (disambiguation guard)   → skip Tier 1, fall through
 *   1. Top 50 owner                                    → Jack Harvey
 *   2. Lease-up + NOT Top 50 + no owner relationship   → Xander Williams
 *   3. Owner-level assignment (beats market/state)     → assigned rep
 *      — covers ALL properties nationwide incl. referrals
 *   4. State-based regional fallback                   → state rep(s)
 *   5. Unassigned
 */
function resolve(input) {
  const { owners, assignments, markets } = loadData();
  const { ownerName, market, isLeaseUp, ownerHQ } = input;

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

  // ── Tier 0: Known non-Top-50 disambiguation ───────────────────────────────
  // Some owners share a distinctive word with a Top 50 entry but are different
  // entities (e.g. "Related Group" vs "The Related Companies"). Entries in
  // owners.knownOwners with isTop50: false are matched first at high confidence
  // (0.85+) to explicitly skip Top 50 fuzzy matching for those names.
  let skipTop50 = false;
  if (owners.knownOwners && owners.knownOwners.length > 0) {
    const knownHit = fuzzyMatch(ownerName, owners.knownOwners, 0.85);
    if (knownHit) {
      skipTop50 = true;
      result.warnings.push(
        `"${ownerName}" matched known non-Top-50 owner "${knownHit.match.name}". ` +
        `Top 50 fuzzy matching skipped. ${knownHit.match.notes || ''}`
      );
    }
  }

  // ── Tier 1: Top 50 ────────────────────────────────────────────────────────
  const top50Hit = !skipTop50 && fuzzyMatch(ownerName, owners.top50);
  if (top50Hit) {
    result.rep = 'Jack Harvey';
    result.rule = 'TOP_50';
    result.matchedOwner = top50Hit.match.name;
    result.explanation =
      `"${ownerName}" matched Top 50 owner "${top50Hit.match.name}" ` +
      `(${top50Hit.type} match, confidence ${pct(top50Hit.score)}). ` +
      `All Top 50 owners are assigned to Jack Harvey regardless of market.`;
    finalize(result);
    return result;
  }

  // Build owner-level candidate list — used by both Tier 2 and Tier 3
  const ownerCandidates = assignments.ownerAssignments.map(a => ({
    name: a.owner,
    aliases: a.aliases || [],
    _raw: a
  }));
  const ownerHit = fuzzyMatch(ownerName, ownerCandidates);

  // ── Tier 2: Xander Williams lease-up hunting ──────────────────────────────────────
  // Xander Williams gets a lease-up property only when ALL three conditions are met:
  //   a) Owner is NOT in the Top 50         (passed Tier 1)
  //   b) No rep already owns this owner relationship
  //   c) Property is in a Top 20 MSA
  // If (b) or (c) fail, fall through — the property routes to the owner's rep
  // or the regional rep instead.
  if (isLeaseUp) {
    if (ownerHit) {
      // Condition (b) fails: a rep owns this relationship — skip Xander Williams entirely,
      // Tier 3 will assign to that rep.
    } else {
      const msa = getTop20MSA(market, markets);
      if (msa) {
        result.rep = 'Xander Williams';
        result.rule = 'LEASE_UP';
        result.explanation =
          `Lease-up property in "${market}" (${msa.name} MSA). ` +
          `Owner "${ownerName}" is not Top 50 and has no existing rep relationship. ` +
          `All three Xander Williams conditions met — routes to Xander Williams.`;
        finalize(result);
        return result;
      } else {
        // Condition (c) fails: not a Top 20 MSA — fall through to regional rep
        const msaNote = market
          ? `"${market}" is not in a Top 20 MSA`
          : `no market provided, cannot confirm Top 20 MSA`;
        result.warnings.push(
          `Lease-up flagged but ${msaNote}. Xander Williams is restricted to Top 20 MSAs. ` +
          `Routing to regional rep instead.`
        );
      }
    }
  }

  // ── Tier 3: Owner-level assignment ───────────────────────────────────────
  // Owner-level assignments cover ALL properties for that owner nationwide,
  // including referrals, regardless of market or state.
  if (ownerHit) {
    const assignment = ownerHit.match._raw;
    result.rep = assignment.rep;
    result.rule = 'OWNER_ASSIGNMENT';
    result.matchedOwner = assignment.owner;
    result.explanation =
      `"${ownerName}" matched owner-level assignment for "${assignment.owner}" ` +
      `(${ownerHit.type} match, confidence ${pct(ownerHit.score)}). ` +
      `Owner-level assignments cover all properties for this owner nationwide, ` +
      `including referrals, and take precedence over state/market assignments. ` +
      `Assigned to ${assignment.rep}.`;

    if (market) {
      const stateResult = getStateReps(market, assignments);
      if (stateResult && !stateResult.reps.includes(assignment.rep)) {
        result.warnings.push(
          `State/market "${market}" is covered by ${stateResult.reps.join('/')} ` +
          `but owner-level assignment overrides to ${assignment.rep}. No conflict — owner wins.`
        );
      }
    }

    finalize(result);
    return result;
  }

  // ── Tier 4: State-based regional fallback ────────────────────────────────
  // Per policy: ownership resolves on OWNER HQ STATE, not property location.
  // Use ownerHQ if provided; fall back to market only if HQ is unknown.
  const lookupStr = ownerHQ || market;
  const usingHQ = !!ownerHQ;

  if (lookupStr) {
    const stateResult = getStateReps(lookupStr, assignments);
    if (stateResult) {
      result.rep = stateResult.reps;
      result.rule = 'STATE_FALLBACK';

      const repList = stateResult.details
        .map(d => d.focus ? `${d.rep} (${d.focus})` : d.rep)
        .join(', ');

      result.explanation =
        `No Top 50, lease-up, or owner-level assignment found for "${ownerName}". ` +
        `Resolving by ${usingHQ ? `owner HQ "${ownerHQ}"` : `property market "${market}"`} ` +
        `(${stateResult.stateCode}). Assigned to: ${repList}.`;

      if (!usingHQ && market) {
        result.warnings.push(
          `Owner HQ not provided — using property market "${market}" for regional assignment. ` +
          `Pass --hq if the owner is headquartered in a different state.`
        );
      }

      if (usingHQ && market) {
        const propCode = stateCodeOf(market);
        if (propCode !== stateResult.stateCode) {
          result.warnings.push(
            `Property is in ${propCode} but owner is HQ'd in ${stateResult.stateCode}. ` +
            `Per policy, ownership resolves to the HQ state rep — not the property's regional rep.`
          );
        }
      }

      if (stateResult.fallback) {
        result.warnings.push(
          `"${lookupStr}" did not match any sub-market focus within ${stateResult.stateCode}. ` +
          `Returning all ${stateResult.stateCode} reps — coordinate to assign a primary.`
        );
      } else if (stateResult.reps.length > 1) {
        result.warnings.push(
          `Multiple reps cover this state (${stateResult.reps.join(', ')}). ` +
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
    `. Not in Top 50, not a qualifying lease-up, no owner-level assignment, ` +
    `and no state assignment found.`;
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
    ownerHQ: result.input.ownerHQ || null,
    market: result.input.market || null,
    isLeaseUp: result.input.isLeaseUp || false,
    rep: Array.isArray(result.rep) ? result.rep.join(', ') : result.rep,
    conflict: result.conflict,
    warnings: result.warnings
  });
}

module.exports = { resolve, fuzzyMatch, getStateReps };
