'use strict';

/**
 * pdf-ingest.js — Production CoStar PDF ingest rules & pipeline.
 *
 * This module contains the rule set we validated through three rounds of
 * dry-run testing on 2026-04-16. It does NOT write to HubSpot directly —
 * callers pass { dryRun: true } to produce a plan, or { dryRun: false } to
 * execute. The live entry point is `runPdfIngest(parsedProperties, opts)`.
 *
 * Upstream: scripts/parse-costar-pdf.py converts the CoStar "Space Availability
 * with Photo Report" PDF into NDJSON. This module consumes that NDJSON.
 *
 * RULES (locked after 2026-04-16 dry-runs):
 *
 *   Pre-ingest filters (Category-C):
 *     - Skip properties with no True Owner AND no Recorded Owner.
 *     - Skip Recorded-Owner fallbacks matching HOA/trust/individual patterns
 *       (homeowner associations, condo assns, trusts, estates, gov entities,
 *       joint personal names).
 *
 *   Company resolution tiers (stop at first confident match):
 *     Tier 1    CoStar PDF website + owner-token sanity           (primary)
 *     Tier 1.25 Derive domain from named-contact email             (PDF-local)
 *     Tier 1.5  Clearbit autocomplete w/ strict token sanity       (external)
 *     Tier 3    Curated data/owner-domains.json map                (human)
 *     Tier 2    Fuzzy HS name match (threshold 0.75 / 0.9 / 1.0)   (legacy)
 *     Tier 4    Create new company WITH a derived domain           (new record)
 *
 *   HARD RULE: if no domain can be resolved AND no HS match is found,
 *   the entire owner group is skipped. No company, deal, or contact is
 *   created. The owner is flagged in the Slack summary for operator review
 *   (add to owner-domains.json manually).
 *
 *   Token sanity:
 *     - sharesOwnerToken: lenient check (≥1 shared 3-char token)
 *     - allQueryTokensInCandidate: every query token must appear in candidate
 *     - candidateHasExtraTokens: candidate with business padding words the
 *       query doesn't have ("Healthcare", "Care", "Ventures") is rejected
 *
 *   Deal dedup:
 *     - dealMatchesRow: property-name token + owner-token, format-agnostic
 *     - Oldest matching open deal wins; newer dupes archived
 *     - Property location fields (city/state/zip/street) OVERWRITE existing
 *       values — CoStar is source of truth. Overrides trigger a deal note.
 *
 *   Re-surfacing updates:
 *     - Deal: overwrite all CoStar-sourced fields. primary_contact_* only if
 *       currently blank (don't overwrite rep selections).
 *     - Company: domain/address/city/state/zip/phone only if currently blank.
 *       Name never touched. HQ mismatch logged to summary instead of overwritten.
 *     - Contact: email is match key, never mutated. Title/phone/linkedin
 *       updated only if blank. Associate to new deals always.
 *
 *   Verification (run post-write):
 *     - Field integrity: re-read each touched deal, diff intended vs actual.
 *     - Association: 1 company per deal; contact→company + contact→deal
 *       associations match planned set.
 *     - Dedup audit: open AP-pipeline deal count per company = expected.
 */

const fs    = require('fs');
const path  = require('path');
const https = require('https');
const hsx   = require('./hs-extra');

const engine = require('../engine');
const zi     = require('./zoominfo');

const {
  AP_PIPELINE_ID, NEW_OPPORTUNITIES_STAGE, XANDER_OWNER_ID, DEAL_CATEGORY_LEASE_UP,
  apiRequest, findOpenDealsForCompany, findCompanyByDomain,
  findContactByEmail, findContactByNameAtCompany, createContact,
  associateContactToCompany, associateContactToDeal,
  createCompany, updateCompany, getCompanyBasics,
  updateDeal, archiveDeal, createNoteOnDeal, deriveDominantDomain,
  PUBLIC_EMAIL_DOMAINS, AMBIGUOUS_CORPORATE_DOMAINS
} = hsx;

// ---------------------------------------------------------------------------
// Stage + pipeline constants
// ---------------------------------------------------------------------------

// Matt is running a test stage during initial rollout. All new deals go here
// until he flips the switch. When he signals production, change this constant
// back to NEW_OPPORTUNITIES_STAGE.
const TEST_STAGE = '1343039756';
const DEAL_STAGE_FOR_NEW = TEST_STAGE;

// Active-engagement lookback window
const ACTIVE_ENGAGEMENT_DAYS = 60;

// ---------------------------------------------------------------------------
// Name normalization & similarity
// ---------------------------------------------------------------------------

function normName(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[.,'"()&]/g, '')
    .replace(/\b(inc|llc|llp|corp|corporation|company|co|ltd|group|lp|properties|management|realty)\b/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function nameScore(a, b) {
  if (!a || !b) return 0;
  if (a === b) return 1;
  if (a.includes(b) || b.includes(a)) return 0.9;
  const wa = new Set(a.split(' ').filter(w => w.length >= 2));
  const wb = new Set(b.split(' ').filter(w => w.length >= 2));
  if (!wa.size || !wb.size) return 0;
  let overlap = 0;
  for (const w of wa) if (wb.has(w)) overlap++;
  return overlap / Math.max(wa.size, wb.size);
}

function normPropToken(s) {
  return String(s || '').toLowerCase().replace(/[.,'"()&\/\-]/g, ' ').replace(/\s+/g, ' ').trim();
}

function dealMatchesRow(existingDealName, prop, ownerName) {
  const existing = normPropToken(existingDealName);
  if (!existing) return false;
  const propToken  = normPropToken(prop.property_name || prop.property_street_address);
  const ownerToken = normPropToken((ownerName || '').split(/\s+/).slice(0, 2).join(' '));
  if (!propToken || propToken.length < 5) return false;
  if (!existing.includes(propToken)) return false;
  if (ownerToken && ownerToken.length >= 4 && !existing.includes(ownerToken)) return false;
  return true;
}

// Lenient: any 3+ char token shared between query and candidate.
function sharesOwnerToken(queriedOwner, candidateName) {
  const q = new Set(normName(queriedOwner).split(' ').filter(w => w.length >= 3));
  const c = new Set(normName(candidateName).split(' ').filter(w => w.length >= 3));
  for (const w of q) if (c.has(w)) return true;
  return false;
}

// Strict: every query token must appear in candidate.
function allQueryTokensInCandidate(queriedOwner, candidateName) {
  const q = normName(queriedOwner).split(' ').filter(w => w.length >= 3);
  const c = new Set(normName(candidateName).split(' ').filter(w => w.length >= 3));
  if (!q.length || !c.size) return false;
  for (const w of q) if (!c.has(w)) return false;
  return true;
}

// Reject candidate with extra business-padding tokens ("Healthcare", "Care", etc).
function candidateHasExtraTokens(queriedOwner, candidateName) {
  const q = new Set(normName(queriedOwner).split(' ').filter(w => w.length >= 3));
  const c = normName(candidateName).split(' ').filter(w => w.length >= 3);
  for (const w of c) if (!q.has(w)) return true;
  return false;
}

// ---------------------------------------------------------------------------
// State abbreviation expansion (HS state_region enum requires full names)
// ---------------------------------------------------------------------------

const US_STATE_MAP = {
  AL:'Alabama', AK:'Alaska', AZ:'Arizona', AR:'Arkansas', CA:'California',
  CO:'Colorado', CT:'Connecticut', DE:'Delaware', FL:'Florida', GA:'Georgia',
  HI:'Hawaii', ID:'Idaho', IL:'Illinois', IN:'Indiana', IA:'Iowa',
  KS:'Kansas', KY:'Kentucky', LA:'Louisiana', ME:'Maine', MD:'Maryland',
  MA:'Massachusetts', MI:'Michigan', MN:'Minnesota', MS:'Mississippi',
  MO:'Missouri', MT:'Montana', NE:'Nebraska', NV:'Nevada', NH:'New Hampshire',
  NJ:'New Jersey', NM:'New Mexico', NY:'New York', NC:'North Carolina',
  ND:'North Dakota', OH:'Ohio', OK:'Oklahoma', OR:'Oregon', PA:'Pennsylvania',
  RI:'Rhode Island', SC:'South Carolina', SD:'South Dakota', TN:'Tennessee',
  TX:'Texas', UT:'Utah', VT:'Vermont', VA:'Virginia', WA:'Washington',
  WV:'West Virginia', WI:'Wisconsin', WY:'Wyoming', DC:'Washington DC'
};
function expandState(s) {
  const v = String(s || '').trim();
  if (!v) return '';
  return US_STATE_MAP[v.toUpperCase()] || v;
}

// ---------------------------------------------------------------------------
// Owner classification — HOA/trust/individual filter (Category-C)
// ---------------------------------------------------------------------------

const HOA_TRUST_PATTERNS = [
  /\b(hoa|poa|coa|homeowners?|property owners?)\b/i,
  /\b(association|assn|assoc)\b/i,
  /\bcondominium\b/i,
  /\btrust(?:ee)?s?\b/i,
  /\bestate\b/i,
  /\bboard of (county|commissioners?)\b/i,
  /\bcity of\b/i,
  /\bcounty of\b/i
];
const CORPORATE_SUFFIX_RE = /\b(inc|llc|llp|corp|corporation|company|co|ltd|group|lp|partners|holdings?|capital|management|trust company|fund)\b/i;

function isIndividualName(name) {
  if (CORPORATE_SUFFIX_RE.test(name)) return false;
  if (/\b(and|&)\b.+\b(and|&)\b/i.test(name)) return true;
  if (/\b(and|&)\b/i.test(name) && /[A-Z][a-z]+\s+[A-Z][a-z]+/.test(name)) return true;
  const tokens = name.trim().split(/\s+/).filter(t => t.length >= 2);
  if (tokens.length >= 2 && tokens.length <= 4) {
    const allPersonish = tokens.every(t => /^[A-Z][a-z]+$/.test(t) || /^[A-Z]\.$/.test(t) || /^[A-Z]$/.test(t));
    if (allPersonish) return true;
  }
  return false;
}

/** Returns {skip, reason}. Called only when fallbackUsed=true (Recorded Owner). */
function shouldSkipOwner(name, fallbackUsed) {
  if (!fallbackUsed) return { skip: false };
  if (!name) return { skip: true, reason: 'no owner name' };
  for (const re of HOA_TRUST_PATTERNS) {
    if (re.test(name)) return { skip: true, reason: `HOA/trust pattern: ${re.source}` };
  }
  if (isIndividualName(name)) return { skip: true, reason: 'individual/personal name' };
  return { skip: false };
}

// ---------------------------------------------------------------------------
// Owner entity extraction from parsed PDF row
// ---------------------------------------------------------------------------

function getPrimaryOwnerEntity(prop) {
  const top = prop.contacts?.true_owners?.[0];
  if (top?.name) return { entity: top, source: 'true_owner', fallback_used: false };
  const rec = prop.contacts?.recorded_owner;
  if (rec?.name) return { entity: rec, source: 'recorded_owner', fallback_used: true };
  if (prop.true_owner_header) {
    return { entity: { name: prop.true_owner_header }, source: 'header_string', fallback_used: false };
  }
  return { entity: null, source: null, fallback_used: false };
}

// ---------------------------------------------------------------------------
// Domain derivation
// ---------------------------------------------------------------------------

function cleanDomain(website) {
  if (!website) return null;
  return String(website).toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/^www\./, '')
    .replace(/\/.*$/, '')
    .trim() || null;
}

/** Derive a company domain from a named-contact email (PDF-local, no API). */
function deriveDomainFromContactEmails(ownerEntity) {
  const contacts = ownerEntity?.contacts || [];
  for (const c of contacts) {
    const email = (c.email || '').toLowerCase();
    const at = email.indexOf('@');
    if (at < 0) continue;
    const d = email.slice(at + 1).trim();
    if (!d) continue;
    if (PUBLIC_EMAIL_DOMAINS.has(d)) continue;
    if (AMBIGUOUS_CORPORATE_DOMAINS.has(d)) continue;
    return d;
  }
  return null;
}

// --- Clearbit autocomplete (free endpoint, in-memory cache) ---------------

const _clearbitCache = new Map();
function clearbitLookup(name) {
  const key = String(name || '').trim().toLowerCase();
  if (!key) return Promise.resolve(null);
  if (_clearbitCache.has(key)) return Promise.resolve(_clearbitCache.get(key));
  const url = `https://autocomplete.clearbit.com/v1/companies/suggest?query=${encodeURIComponent(name)}`;
  return new Promise((resolve) => {
    const req = https.get(url, { timeout: 5000, headers: { 'User-Agent': 'landing-costar-ingest/1.0' } }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data || '[]');
          const top = Array.isArray(parsed) && parsed[0] ? parsed[0] : null;
          _clearbitCache.set(key, top);
          resolve(top);
        } catch { _clearbitCache.set(key, null); resolve(null); }
      });
    });
    req.on('error',   () => { _clearbitCache.set(key, null); resolve(null); });
    req.on('timeout', () => { req.destroy(); _clearbitCache.set(key, null); resolve(null); });
  });
}

// --- Curated owner-domain map --------------------------------------------

const CURATED_DOMAINS_PATH = path.resolve(__dirname, '..', '..', 'data', 'owner-domains.json');
let _curatedDomains = null;
function loadCuratedDomains() {
  if (_curatedDomains) return _curatedDomains;
  try { _curatedDomains = JSON.parse(fs.readFileSync(CURATED_DOMAINS_PATH, 'utf8')); }
  catch { _curatedDomains = {}; }
  _curatedDomains._norm = {};
  for (const [k, v] of Object.entries(_curatedDomains)) {
    if (k.startsWith('_')) continue;
    _curatedDomains._norm[normName(k)] = v;
  }
  return _curatedDomains;
}

async function searchCompanyByName(name) {
  const res = await apiRequest('POST', '/crm/v3/objects/companies/search', {
    filterGroups: [{ filters: [{ propertyName: 'name', operator: 'CONTAINS_TOKEN', value: name }] }],
    properties: ['name','city','state','domain','num_associated_deals','address','zip','phone'],
    limit: 10
  });
  return res.results || [];
}

/**
 * Resolve a CoStar owner to an HS company. Returns:
 *   { tier, action, company, resolvedDomain, notes }
 * The caller is responsible for acting on `action`:
 *   matched_by_costar_domain | matched_by_email_domain | matched_by_clearbit_domain
 *   matched_by_curated_domain | matched_by_name
 *   would_create_with_domain | would_create_no_domain
 * If action is `would_create_no_domain` the caller MUST skip ingest for
 * this owner group per the ingest rules.
 */
async function resolveCompany(ownerName, { costarDomain, emailDomain } = {}) {
  const result = { tier: null, action: null, company: null, notes: [], resolvedDomain: costarDomain || null };

  // Tier 1: CoStar PDF website
  if (costarDomain && !AMBIGUOUS_CORPORATE_DOMAINS.has(costarDomain)) {
    const m = await findCompanyByDomain(costarDomain);
    if (m && sharesOwnerToken(ownerName, m.properties?.name || '')) {
      return { ...result, tier: 1, action: 'matched_by_costar_domain',
               company: m, notes: [`CoStar website → ${costarDomain}`] };
    }
    if (m) result.notes.push(`domain ${costarDomain} matched ${m.properties?.name} but no token overlap — rejected`);
  }

  let derivedDomain = costarDomain;

  // Tier 1.25: named-contact email domain
  if (!derivedDomain && emailDomain) {
    derivedDomain = emailDomain.toLowerCase();
    result.resolvedDomain = derivedDomain;
    result.notes.push(`email domain: ${derivedDomain}`);
    const m = await findCompanyByDomain(derivedDomain);
    if (m && sharesOwnerToken(ownerName, m.properties?.name || '')) {
      return { ...result, tier: 1.25, action: 'matched_by_email_domain', company: m };
    }
  }

  // Tier 1.5: Clearbit autocomplete (strict token sanity)
  if (!derivedDomain) {
    const cb = await clearbitLookup(ownerName);
    if (cb?.domain && !AMBIGUOUS_CORPORATE_DOMAINS.has(cb.domain) &&
        allQueryTokensInCandidate(ownerName, cb.name || '') &&
        !candidateHasExtraTokens(ownerName, cb.name || '')) {
      derivedDomain = cb.domain.toLowerCase();
      result.resolvedDomain = derivedDomain;
      result.notes.push(`Clearbit: ${cb.name} → ${derivedDomain}`);
      const m = await findCompanyByDomain(derivedDomain);
      if (m && sharesOwnerToken(ownerName, m.properties?.name || '')) {
        return { ...result, tier: 1.5, action: 'matched_by_clearbit_domain', company: m,
                 notes: [...result.notes, `Clearbit domain matched existing HS company`] };
      }
    } else if (cb?.domain) {
      result.notes.push(`Clearbit returned ${cb.name} — rejected (token mismatch or extra tokens)`);
    }
  }

  // Tier 3: curated owner-domains.json
  if (!derivedDomain) {
    const curated = loadCuratedDomains();
    const mapped = curated._norm[normName(ownerName)];
    if (mapped) {
      derivedDomain = mapped.toLowerCase();
      result.resolvedDomain = derivedDomain;
      result.notes.push(`curated map: ${mapped}`);
      const m = await findCompanyByDomain(derivedDomain);
      if (m && sharesOwnerToken(ownerName, m.properties?.name || '')) {
        return { ...result, tier: 3, action: 'matched_by_curated_domain', company: m };
      }
    }
  }

  // Tier 2: fuzzy HS name match (tightened — reject candidates with extra tokens)
  const normalized = normName(ownerName);
  const candidates = await searchCompanyByName(ownerName);
  const scored = candidates
    .map(c => ({
      c, score: nameScore(normalized, normName(c.properties?.name || '')),
      hasDomain: !!(c.properties?.domain),
      deals: Number(c.properties?.num_associated_deals || 0),
      allTokensCovered: allQueryTokensInCandidate(ownerName, c.properties?.name || ''),
      hasExtraTokens:   candidateHasExtraTokens(ownerName, c.properties?.name || '')
    }))
    .filter(s => s.allTokensCovered && !s.hasExtraTokens);

  scored.sort((a,b) =>
    (b.score - a.score) ||
    (Number(b.hasDomain) - Number(a.hasDomain)) ||
    (b.deals - a.deals) ||
    String(a.c.id).localeCompare(String(b.c.id)));
  const best      = scored[0]?.c || null;
  const bestScore = scored[0]?.score || 0;

  const nWords = normalized.split(' ').filter(w => w.length >= 2).length;
  let threshold;
  if (derivedDomain) threshold = nWords <= 1 ? 0.9 : 0.75;
  else               threshold = 1.0;

  if (best && bestScore >= threshold) {
    const adoptedDomain = best.properties?.domain || derivedDomain;
    return { ...result, tier: 2, action: 'matched_by_name',
             company: best, resolvedDomain: adoptedDomain,
             notes: [...result.notes, `name score ${bestScore.toFixed(2)}, domain=${adoptedDomain || '(none)'}`] };
  }

  // Tier 4: create or skip
  return { ...result, tier: 4,
           action: derivedDomain ? 'would_create_with_domain' : 'would_create_no_domain',
           company: null,
           notes: [...result.notes, `no HS match — would create${derivedDomain ? ` with domain ${derivedDomain}` : ' WITHOUT domain'}`] };
}

// ---------------------------------------------------------------------------
// Field policies — what to overwrite vs preserve on re-surface
// ---------------------------------------------------------------------------

// Deal field update policy (default = overwrite unless listed)
const DEAL_FIELD_POLICY = {
  primary_contact_email: 'blank_only',
  primary_contact_name:  'blank_only',
  number_of_units:       'never',
  available_units:       'never',
  hubspot_owner_id:      'never',
  dealstage:             'never',
  pipeline:              'never',
  amount:                'never',
  closedate:             'never'
};

const COMPANY_FIELD_POLICY = {
  name:    'never',
  domain:  'blank_only',
  address: 'blank_only',
  city:    'blank_only',
  state:   'blank_only',
  zip:     'blank_only',
  phone:   'blank_only'
};

/**
 * Decide which proposed field values to actually write based on policy.
 * Returns { updates, skipped, mismatch } where `mismatch` captures values
 * that will OVERWRITE a non-blank different value (for deal-note surfacing).
 */
function decideUpdate(existing, proposed, policyMap) {
  const updates = {}, skipped = {}, mismatch = {};
  for (const [k, v] of Object.entries(proposed)) {
    if (v == null || v === '' || k === 'costar_last_synced') {
      if (k === 'costar_last_synced') updates[k] = v;
      continue;
    }
    const current = existing?.properties?.[k];
    const policy = policyMap[k];
    if (policy === 'never')     { skipped[k] = { current, proposed: v, reason: 'policy=never' }; continue; }
    if (policy === 'blank_only') {
      if (current == null || current === '') updates[k] = v;
      else skipped[k] = { current, proposed: v, reason: 'blank_only (non-blank)' };
      continue;
    }
    if (current != null && current !== '' && String(current) !== String(v)) {
      mismatch[k] = { current, proposed: v };
    }
    updates[k] = v;
  }
  return { updates, skipped, mismatch };
}

// ---------------------------------------------------------------------------
// Deal name + field mapping
// ---------------------------------------------------------------------------

function buildDealName(prop, ownerName) {
  const market = `${prop.property_city}, ${prop.property_state}`;
  const propName = prop.property_name || prop.property_street_address;
  return `${market}-${propName}/${ownerName || ''}`;
}

function buildDealFields(prop, ownerEntity) {
  const ownerStreet = ownerEntity?.street || '';
  const ownerCity   = ownerEntity?.city   || '';
  const ownerState  = ownerEntity?.state  || '';
  const ownerZip    = ownerEntity?.zip    || '';

  const hqLoc  = [ownerCity, ownerState].filter(Boolean).join(', ');
  const hqAddr = [ownerStreet, ownerCity, ownerState, ownerZip].filter(Boolean).join(', ');

  const primaryContact = ownerEntity?.contacts?.[0] || null;

  const vacancyUnits = (prop.costar_total_units && prop.vacancy_pct != null)
    ? Math.round(prop.costar_total_units * prop.vacancy_pct / 100) : null;

  return {
    // Owner Intel (populated from True Owner HQ)
    city: ownerCity || null,
    state_region: expandState(ownerState) || null,
    hq_location: hqLoc || null,
    company_hq_address: hqAddr || null,
    company_name: ownerEntity?.name || null,
    primary_contact_email: primaryContact?.email || null,
    primary_contact_name: primaryContact?.name || null,
    // Property Intel (populated from property row)
    property_name: prop.property_name,
    property_street_address: prop.property_street_address,
    property_city: prop.property_city,
    property_state: prop.property_state,
    property_zip: prop.property_zip,
    vacancy__: prop.vacancy_pct,
    vacant_units: vacancyUnits,
    asset_class: prop.building_class || null,
    // CoStar reference fields
    costar_total_units: prop.costar_total_units,
    costar_year_built: prop.costar_year_built,
    costar_year_renovated: prop.costar_year_renovated,
    costar_star_rating: prop.costar_star_rating,
    costar_asking_rent_per_unit: prop.costar_asking_rent_per_unit,
    costar_stories: prop.costar_stories,
    costar_parking: prop.costar_parking,
    costar_market_segment: prop.costar_market_segment,
    costar_property_type: prop.costar_property_type,
    costar_building_status: prop.costar_building_status,
    costar_market: prop.property_city,
    costar_submarket: prop.submarket,
    costar_commercial_available_sf: prop.costar_commercial_available_sf,
    costar_commercial_asking_rent: prop.costar_commercial_asking_rent,
    costar_recorded_owner: prop.contacts?.recorded_owner?.name || null,
    costar_true_owner_contact: primaryContact?.name || null,
    costar_additional_true_owners: (prop.contacts?.true_owners || []).slice(1).map(e => e.name).join(', ') || null,
    costar_leasing_company: prop.contacts?.leasing_companies?.[0]?.name || null,
    costar_leasing_company_address: prop.contacts?.leasing_companies?.[0]?.street || null,
    costar_leasing_company_phone: prop.contacts?.leasing_companies?.[0]?.phone || null,
    costar_leasing_company_website: prop.contacts?.leasing_companies?.[0]?.website || null,
    costar_amenities_unit: prop.costar_amenities_unit,
    costar_amenities_site: prop.costar_amenities_site,
    costar_property_notes: prop.property_notes,
    costar_last_synced: String(Date.now()),
    // System — set on create; NEVER updated on re-surface (per policy)
    dealname: null,
    pipeline: AP_PIPELINE_ID,
    dealstage: NEW_OPPORTUNITIES_STAGE,
    hubspot_owner_id: String(XANDER_OWNER_ID),          // TODO: rep routing
    deal_category: DEAL_CATEGORY_LEASE_UP               // TODO: rep routing
  };
}

function buildCompanyFields(ownerEntity) {
  return {
    name: ownerEntity?.name || null,
    domain: cleanDomain(ownerEntity?.website),
    address: ownerEntity?.street || null,
    city: ownerEntity?.city || null,
    state: ownerEntity?.state || null,
    zip: ownerEntity?.zip || null,
    phone: ownerEntity?.phone || null
  };
}

// ---------------------------------------------------------------------------
// Rep resolution — ROE cascade + active-engagement override
// ---------------------------------------------------------------------------

// Cache HS owner lookups (rep name → hubspot_owner_id)
let _hsOwnersCache = null;
async function getHsOwnerIdByName(repName) {
  if (!repName) return null;
  if (!_hsOwnersCache) {
    _hsOwnersCache = {};
    let after;
    do {
      const res = await apiRequest('GET', `/crm/v3/owners${after ? `?after=${after}` : ''}`);
      for (const o of (res.results || [])) {
        const fullName = `${o.firstName || ''} ${o.lastName || ''}`.trim();
        if (fullName) _hsOwnersCache[fullName.toLowerCase()] = String(o.id);
        if (o.email) _hsOwnersCache[o.email.toLowerCase()] = String(o.id);
      }
      after = res.paging?.next?.after;
    } while (after);
  }
  return _hsOwnersCache[repName.toLowerCase()] || null;
}

/**
 * Resolve the ROE rep name for an owner using the existing engine.resolve()
 * cascade. Returns { rep, rule, matchedOwner, explanation, warnings, conflict }.
 *
 * The caller should use this rep as the DEFAULT, then check active engagement
 * to potentially override.
 */
function resolveRoeRep(ownerName, trueOwnerHqLocation) {
  try {
    const result = engine.resolve({
      ownerName,
      market: trueOwnerHqLocation,      // engine keys territory on the query market
      isLeaseUp: false,                 // PDF ingest is not lease-up-only anymore
      ownerHQ: trueOwnerHqLocation
    });
    return result;
  } catch (e) {
    return { rep: null, rule: null, explanation: `engine.resolve() error: ${e.message}`, warnings: [], conflict: false };
  }
}

/**
 * Active-engagement override. Given an existing HS company and a default
 * ROE rep, check if any of the company's open deals has engagement in the
 * last ACTIVE_ENGAGEMENT_DAYS. If yes, return that rep's owner ID — they
 * keep ownership regardless of ROE.
 *
 * Returns { activeOwnerId, activeRepName, dealCount, lastActivityAt } or null.
 */
async function findActiveEngagementRep(companyId) {
  if (!companyId) return null;
  try {
    const deals = await findOpenDealsForCompany(companyId);
    if (!deals.length) return null;
    const cutoff = Date.now() - ACTIVE_ENGAGEMENT_DAYS * 24 * 60 * 60 * 1000;
    const active = deals.filter(d => {
      const modified  = Date.parse(d.properties?.hs_lastmodifieddate || '') || 0;
      const contacted = Date.parse(d.properties?.notes_last_contacted || '') || 0;
      return Math.max(modified, contacted) >= cutoff;
    });
    if (!active.length) return null;
    // Sort by most-recent activity
    active.sort((a, b) => {
      const am = Math.max(Date.parse(a.properties?.hs_lastmodifieddate || '') || 0,
                          Date.parse(a.properties?.notes_last_contacted || '') || 0);
      const bm = Math.max(Date.parse(b.properties?.hs_lastmodifieddate || '') || 0,
                          Date.parse(b.properties?.notes_last_contacted || '') || 0);
      return bm - am;
    });
    const top = active[0];
    const ownerId = top.properties?.hubspot_owner_id;
    if (!ownerId) return null;
    return {
      activeOwnerId: String(ownerId),
      dealId: top.id,
      dealCount: active.length,
      lastActivityAt: top.properties?.hs_lastmodifieddate || top.properties?.notes_last_contacted
    };
  } catch (e) {
    return null;
  }
}

// ---------------------------------------------------------------------------
// ZI enrichment — mirrors leaseup-ingest.js behavior
// ---------------------------------------------------------------------------

async function fetchCompanyContactIds(companyId) {
  try {
    const res = await apiRequest('GET', `/crm/v4/objects/companies/${companyId}/associations/contacts?limit=500`);
    return (res.results || []).map(r => String(r.toObjectId));
  } catch { return []; }
}

/**
 * Run ZI enrichment for an owner group and associate contacts to the company
 * and every deal in the batch. Only newly-created contacts get the assigned
 * rep as hubspot_owner_id; existing contacts are associated without owner
 * mutation.
 */
async function runZiEnrichmentForOwner({ ownerName, companyId, dealIds, dealOwnerId, dryRun }) {
  const result = {
    ziFound: 0, created: 0, existing: 0, associated: 0, errors: []
  };
  let ziContacts = [];
  try {
    ziContacts = await zi.findRelevantContacts(ownerName, { maxResults: 20 });
    result.ziFound = ziContacts.length;
  } catch (e) {
    result.errors.push(`zoominfo (${ownerName}): ${e.message}`);
    return result;
  }
  if (dryRun || !companyId || !ziContacts.length) return result;

  // Write contacts with dedup, associated to company + first deal
  const firstDealId = dealIds[0] || null;
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
      let existing = email ? await findContactByEmail(email) : null;
      if (!existing && firstname && lastname) {
        existing = await findContactByNameAtCompany(firstname, lastname, companyId);
      }
      if (existing) {
        result.existing++;
        try { await associateContactToCompany(existing.id, companyId); } catch {}
        if (firstDealId) { try { await associateContactToDeal(existing.id, firstDealId); } catch {} }
        result.associated++;
        continue;
      }
      const props = {
        ...(email     ? { email }                     : {}),
        ...(firstname ? { firstname }                 : {}),
        ...(lastname  ? { lastname }                  : {}),
        ...(title     ? { jobtitle: title }           : {}),
        ...(phone     ? { phone }                     : {}),
        ...(linkedin  ? { hs_linkedin_url: linkedin } : {}),
        ...(dealOwnerId ? { hubspot_owner_id: String(dealOwnerId) } : {})
      };
      await createContact(props, { companyId, dealId: firstDealId });
      result.created++;
      result.associated++;
    } catch (e) {
      result.errors.push(`${firstname} ${lastname} (${email}): ${e.message}`);
    }
  }

  // Fan contacts out to remaining deals in the batch
  if (dealIds.length > 1) {
    const contactIds = await fetchCompanyContactIds(companyId);
    for (const dealId of dealIds.slice(1)) {
      for (const ctid of contactIds) {
        try { await associateContactToDeal(ctid, dealId); } catch {}
      }
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Write-mode helpers
// ---------------------------------------------------------------------------

async function createOrUpdateCompany(resolved, proposal, ownerAssignedId) {
  if (resolved.company) {
    // Existing — enrich blank fields only, never touch owner or name
    const { updates } = decideUpdate(resolved.company, proposal, COMPANY_FIELD_POLICY);
    if (Object.keys(updates).length) {
      await updateCompany(resolved.company.id, updates);
    }
    return { id: resolved.company.id, action: 'enriched' };
  }
  // New — create with assigned rep as owner
  const props = {
    ...(proposal.name    ? { name:    proposal.name }    : {}),
    ...(proposal.domain  ? { domain:  proposal.domain }  : {}),
    ...(proposal.address ? { address: proposal.address } : {}),
    ...(proposal.city    ? { city:    proposal.city }    : {}),
    ...(proposal.state   ? { state:   proposal.state }   : {}),
    ...(proposal.zip     ? { zip:     proposal.zip }     : {}),
    ...(proposal.phone   ? { phone:   proposal.phone }   : {}),
    ...(ownerAssignedId  ? { hubspot_owner_id: String(ownerAssignedId) } : {})
  };
  const created = await createCompany(props);
  return { id: created.id, action: 'created' };
}

async function createOrMergeDeal({ row, ownerName, ownerEntity, companyId, dealOwnerId, openDeals, dryRun }) {
  const dealName = buildDealName(row, ownerName);
  const fields   = buildDealFields(row, ownerEntity);
  fields.dealname = dealName;

  const matches = openDeals.filter(d => dealMatchesRow(d.properties?.dealname, row, ownerName));
  if (matches.length) {
    matches.sort((a, b) => (a.properties.hs_lastmodifieddate || '').localeCompare(b.properties.hs_lastmodifieddate || ''));
    const winner = matches[0];
    const archivedDupes = matches.slice(1);

    // Re-read the winner with ALL the fields we might change — needed to
    // compute mismatches for location-override notes. findOpenDealsForCompany
    // only loads a small property set.
    let winnerFull = winner;
    try {
      const read = await apiRequest('POST', '/crm/v3/objects/deals/batch/read', {
        inputs: [{ id: String(winner.id) }],
        properties: Object.keys(fields)
      });
      if (read.results?.[0]) winnerFull = read.results[0];
    } catch {}

    // Merge: overwrite CoStar fields per policy, NEVER touch owner/pipeline/stage/amount/closedate
    const { updates, mismatch } = decideUpdate(winnerFull, fields, DEAL_FIELD_POLICY);
    // Remove system fields from the patch on merge paths (policy=never prevents,
    // but be explicit in case of schema drift)
    delete updates.hubspot_owner_id;
    delete updates.pipeline;
    delete updates.dealstage;
    // Dealname: update to canonical format
    if ((winnerFull.properties?.dealname || '') !== dealName) updates.dealname = dealName;

    if (!dryRun && Object.keys(updates).length) {
      await updateDeal(winner.id, updates);
    }
    // Archive newer dupes
    for (const dup of archivedDupes) {
      if (!dryRun) { try { await archiveDeal(dup.id); } catch {} }
    }

    // Location-override note
    const locKeys = ['property_city','property_state','property_street_address','property_zip'];
    const locOverrides = Object.fromEntries(locKeys.filter(k => mismatch[k]).map(k => [k, mismatch[k]]));
    if (Object.keys(locOverrides).length && !dryRun) {
      const noteBody = `<p><strong>Property location updated per CoStar ingest ${new Date().toISOString().slice(0,10)}</strong></p>` +
        `<ul>${Object.entries(locOverrides).map(([k,v]) => `<li>${k}: "${v.current}" → "${v.proposed}"</li>`).join('')}</ul>`;
      try { await createNoteOnDeal(winner.id, noteBody); } catch {}
    }

    return { dealId: winner.id, action: 'merged', archivedDupes: archivedDupes.map(d => d.id), mismatch };
  }

  // Create new
  if (dryRun) return { dealId: null, action: 'would_create' };

  const payload = {
    properties: {
      ...fields,
      dealname: dealName,
      pipeline: AP_PIPELINE_ID,
      dealstage: DEAL_STAGE_FOR_NEW,
      hubspot_owner_id: String(dealOwnerId),
      ...(DEAL_CATEGORY_LEASE_UP ? { deal_category: DEAL_CATEGORY_LEASE_UP } : {})
    },
    associations: [{
      to: { id: String(companyId) },
      types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: hsx.ASSOC.DEAL_TO_COMPANY }]
    }]
  };
  // Strip null/empty properties to avoid HS validation errors
  for (const k of Object.keys(payload.properties)) {
    const v = payload.properties[k];
    if (v == null || v === '') delete payload.properties[k];
  }
  const created = await apiRequest('POST', '/crm/v3/objects/deals', payload);
  return { dealId: created.id, action: 'created' };
}

// ---------------------------------------------------------------------------
// Primary contact (from PDF) — create if missing, associate to deal
// ---------------------------------------------------------------------------

async function handlePdfPrimaryContact({ ownerEntity, companyId, dealIds, dealOwnerId, dryRun }) {
  const primary = ownerEntity?.contacts?.[0];
  if (!primary?.email) return { created: false, associated: false };
  if (dryRun) return { created: false, associated: false, dryRun: true };
  try {
    let contact = await findContactByEmail(primary.email);
    if (!contact) {
      const [firstname, ...lastParts] = (primary.name || '').split(/\s+/);
      const props = {
        email: primary.email.toLowerCase(),
        ...(firstname ? { firstname } : {}),
        ...(lastParts.length ? { lastname: lastParts.join(' ') } : {}),
        ...(primary.title ? { jobtitle: primary.title } : {}),
        ...(primary.phone ? { phone: primary.phone } : {}),
        ...(dealOwnerId ? { hubspot_owner_id: String(dealOwnerId) } : {})
      };
      contact = await createContact(props, { companyId, dealId: dealIds[0] || null });
      for (const dealId of dealIds.slice(1)) {
        try { await associateContactToDeal(contact.id, dealId); } catch {}
      }
      return { created: true, associated: true, contactId: contact.id };
    }
    // Existing — associate only, never mutate
    try { await associateContactToCompany(contact.id, companyId); } catch {}
    for (const dealId of dealIds) {
      try { await associateContactToDeal(contact.id, dealId); } catch {}
    }
    return { created: false, associated: true, contactId: contact.id };
  } catch (e) {
    return { created: false, associated: false, error: e.message };
  }
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  // Classification & filters
  normName, nameScore, normPropToken, dealMatchesRow,
  sharesOwnerToken, allQueryTokensInCandidate, candidateHasExtraTokens,
  HOA_TRUST_PATTERNS, CORPORATE_SUFFIX_RE, isIndividualName, shouldSkipOwner,
  getPrimaryOwnerEntity,

  // Domain derivation
  cleanDomain, deriveDomainFromContactEmails, clearbitLookup, loadCuratedDomains,

  // Company resolution
  searchCompanyByName, resolveCompany,

  // Rep resolution
  resolveRoeRep, findActiveEngagementRep, getHsOwnerIdByName,
  ACTIVE_ENGAGEMENT_DAYS, DEAL_STAGE_FOR_NEW, TEST_STAGE,

  // Write helpers
  createOrUpdateCompany, createOrMergeDeal, handlePdfPrimaryContact, runZiEnrichmentForOwner,

  // State
  expandState,

  // Field mapping
  buildDealName, buildDealFields, buildCompanyFields,
  DEAL_FIELD_POLICY, COMPANY_FIELD_POLICY, decideUpdate
};
