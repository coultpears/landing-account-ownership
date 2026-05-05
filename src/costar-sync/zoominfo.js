'use strict';

/**
 * zoominfo.js — ZoomInfo Enterprise API client for contact enrichment.
 *
 * Used to find relevant decision-maker contacts at a company and return
 * enriched records (name, email, phone, LinkedIn, title) for HubSpot dedup +
 * creation in leaseup.js.
 *
 * Auth: username+password → POST /authenticate returns JWT, 1hr TTL.
 * Creds come from env vars or the shared .env file.
 */

const https = require('https');
const fs    = require('fs');
const path  = require('path');

(function loadDotEnv() {
  try {
    const envPath = path.join(__dirname, '..', '..', '.env');
    const lines = fs.readFileSync(envPath, 'utf8').split(/\r?\n/);
    for (const line of lines) {
      const m = line.match(/^([A-Z_][A-Z0-9_]*)\s*=\s*(.+)$/);
      if (m && !process.env[m[1]]) {
        process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
      }
    }
  } catch { /* no .env is fine */ }
})();

// Relevant titles for multifamily lease-up outreach.
// Match is case-insensitive substring on jobTitle.
const TARGET_TITLE_KEYWORDS = [
  'owner', 'principal', 'president', 'ceo', 'cfo', 'coo', 'founder',
  'chief financial officer', 'chief operating officer', 'chief investment officer', 'cio',
  'acquisition', 'dispositions',
  'asset management', 'asset manager',
  'leasing',
  'property management', 'property manager',
  'director of development', 'development partner', 'development',
  'managing partner', 'managing director', 'partner',
  'head of real estate', 'real estate',
  'investments', 'investor relations',
  'portfolio manager', 'portfolio',
  'vice president', 'vp ', ' vp'
];

// Priority keywords — contacts whose titles include one of these sort first,
// with earlier entries ranking higher than later ones. Overlap with
// TARGET_TITLE_KEYWORDS is fine (a match in EITHER list qualifies the contact;
// priority only affects ordering within qualified contacts).
// Order matters — index is the priority rank.
//
// 'regional' removed 2026-05-04 — at multifamily owner-operators it pulled in
// Regional Manager / Regional Service Manager (property-level ops staff, not
// outreach targets). Real decision-makers like Regional VP of Asset Management
// still pass via TARGET 'asset management' / 'vp ' and rank highly via 'asset'.
const PRIORITY_TITLE_KEYWORDS = [
  'asset',
  'revenue',
  'portfolio',
  'operations',
  'financial',
  'strategy',
  'strategic',
  'development'
];

// Exclusion list — if any of these appear in the title, drop the contact even
// if a positive keyword matched. Catches "Property Management Accountant",
// "Development Financial Analyst", "Affordable Housing Development", etc.
const TITLE_EXCLUDE_KEYWORDS = [
  // Social/impact verticals unrelated to market-rate MF
  'affordable',
  'impact',

  // HR / L&D roles that share "Development" with real-estate development
  'professional development',
  'learning and development', 'learning & development',
  'talent development',
  'organizational development',

  // Junior / administrative — usually not decision-makers
  'accountant', 'accounting',
  'analyst',
  'assistant',
  'intern',
  'coordinator',
  'receptionist',
  'bookkeeper',
  'payroll',
  'admin',
  'marketing',
  'controller',                     // accounting-adjacent, not owner-side
  'project manager',                // distinct from property manager
  'community manager',              // property-site staff, not a decision-maker

  // Non-real-estate divisions at multi-division firms (Macquarie, JLL, etc.)
  'legal', 'counsel', 'attorney',
  'regulatory', 'compliance',
  'commodities',
  'cryptography', 'crypto',
  'expense management',
  'human resources', ' hr ',
  'information technology', ' it ',
  'cybersecurity', 'security engineer',
  'product manager',

  // Added 2026-04-22 — categorical non-target functions
  'sales',                          // sales manager / sales director / sales operations / account executive
  'data engineer', 'data scientist', 'data analyst', 'data ops', 'data infra',
  'data infrastructure', 'data science',
  'engineer', 'engineering',        // software eng, platform eng, SRE, devops
  'clinical', 'medical', 'pharma', 'pharmacy', 'physician', 'nurse',
  'construction',                   // Construction Manager, VP Construction
  'academic', 'professor', 'teacher', 'student',
  'non-profit', 'nonprofit', 'ngo',
  'restaurant', 'hospitality manager',  // rare but noisy when they appear

  // Added 2026-05-04 — property-level operations roles. At multifamily
  // owner-operators these are field/site staff, not corporate decision-makers.
  // Senior versions (Director/VP of Property Management, VP Leasing, Head of
  // Asset Management) still pass via their senior modifiers in TARGET; these
  // EXCLUDE substrings only catch the bare junior titles.
  'leasing professional',
  'leasing agent',
  'leasing consultant',
  'leasing specialist',
  'leasing associate',
  'leasing manager',                // building-level, distinct from Director/VP of Leasing
  'service manager',                // catches "Regional Service Manager" too
  'maintenance',
  'property manager'                // junior on-site role; "VP/Director of Property Management" still passes
];

// ---------------------------------------------------------------------------
// Low-level HTTPS helper (ZoomInfo host)
// ---------------------------------------------------------------------------

function zoomRequest(method, apiPath, body = null, token = null) {
  return new Promise((resolve, reject) => {
    const bodyStr = body ? JSON.stringify(body) : null;
    const req = https.request({
      hostname: 'api.zoominfo.com',
      path:     apiPath,
      method,
      headers: {
        'Content-Type': 'application/json',
        'Accept':       'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(bodyStr ? { 'Content-Length': Buffer.byteLength(bodyStr) } : {})
      }
    }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        if (res.statusCode >= 400) {
          return reject(new Error(`ZoomInfo ${res.statusCode} ${method} ${apiPath}: ${data.slice(0, 400)}`));
        }
        try { resolve(JSON.parse(data)); } catch { resolve(data); }
      });
    });
    req.on('error', reject);
    req.setTimeout(20000, () => { req.destroy(); reject(new Error(`ZoomInfo timeout: ${apiPath}`)); });
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// Authentication — cached JWT (1hr TTL)
// ---------------------------------------------------------------------------

let _token = null;
let _tokenExpiresAt = 0;
let _authInFlight = null;  // shared promise for concurrent callers

async function authenticate() {
  if (_token && Date.now() < _tokenExpiresAt) return _token;

  // Concurrent callers share a single in-flight auth request. Prevents
  // hitting ZI's rate limit when multiple owner groups start in parallel.
  if (_authInFlight) return _authInFlight;

  const username = process.env.ZOOMINFO_USERNAME || 'carter.harris@hellolanding.com';
  const password = process.env.ZOOMINFO_PASSWORD;
  if (!password) {
    throw new Error('ZOOMINFO_PASSWORD not set in env');
  }

  _authInFlight = (async () => {
    try {
      // Retry auth on 429 with exponential backoff — covers cases where our
      // token expired mid-run and ZI rate-limits the refresh attempt.
      let lastErr = null;
      for (let attempt = 1; attempt <= 4; attempt++) {
        try {
          const res = await zoomRequest('POST', '/authenticate', { username, password });
          if (!res.jwt) throw new Error('ZoomInfo auth failed: no jwt in response');
          _token = res.jwt;
          _tokenExpiresAt = Date.now() + 55 * 60 * 1000;  // 55min safety margin
          return _token;
        } catch (e) {
          lastErr = e;
          if (!/429/.test(e.message || '') || attempt === 4) throw e;
          await sleep(1500 * attempt);  // 1.5s, 3s, 4.5s
        }
      }
      throw lastErr;
    } finally {
      _authInFlight = null;
    }
  })();
  return _authInFlight;
}

// ---------------------------------------------------------------------------
// Contact search — returns basic contact list for a company
// ---------------------------------------------------------------------------

async function searchContacts(companyName, { maxResults = 50 } = {}) {
  const token = await authenticate();
  const body = {
    companyName: companyName,
    rpp:         Math.min(maxResults, 100),
    page:        1,
    sortBy:      'contactAccuracyScore',
    sortOrder:   'desc',
    // Note: managementLevel is not permitted in /search output on our plan.
    // We still filter by title keywords which covers the same intent.
    outputFields: [
      'id', 'firstName', 'lastName', 'jobTitle',
      'companyName', 'hasEmail', 'hasDirectPhone', 'hasMobilePhone',
      'contactAccuracyScore'
    ]
  };
  const res = await zoomRequest('POST', '/search/contact', body, token);
  return res.data || [];
}

// ---------------------------------------------------------------------------
// Enrich — get full contact (email, phone, LinkedIn) by personId
// ---------------------------------------------------------------------------

async function enrichContactsById(personIds) {
  if (!personIds.length) return [];
  const token = await authenticate();

  // Enrich API takes matchPersonInput[]; batch up to 25
  const results = [];
  const chunkSize = 25;
  for (let i = 0; i < personIds.length; i += chunkSize) {
    const chunk = personIds.slice(i, i + chunkSize);
    const body = {
      matchPersonInput: chunk.map(id => ({ personId: String(id) })),
      outputFields: [
        'id', 'firstName', 'lastName', 'email', 'phone', 'mobilePhone',
        'jobTitle',
        'companyName', 'companyWebsite', 'externalUrls',
        'contactAccuracyScore', 'city', 'state'
      ]
    };
    try {
      const res = await zoomRequest('POST', '/enrich/contact', body, token);
      const matches = res?.data?.result || res?.data || [];
      for (const m of matches) {
        const matched = m.data?.[0] || m;  // response shape varies
        if (matched?.email || matched?.firstName) results.push(matched);
      }
    } catch (e) {
      console.warn(`[zoominfo] enrich batch failed: ${e.message}`);
    }
    if (i + chunkSize < personIds.length) await sleep(300);
  }
  return results;
}

// ---------------------------------------------------------------------------
// High-level: find relevant contacts at a company, enriched
// ---------------------------------------------------------------------------

function titleMatchesTarget(title) {
  if (!title) return false;
  const lower = title.toLowerCase();
  if (TITLE_EXCLUDE_KEYWORDS.some(kw => lower.includes(kw))) return false;
  return TARGET_TITLE_KEYWORDS.some(kw => lower.includes(kw))
      || PRIORITY_TITLE_KEYWORDS.some(kw => lower.includes(kw));
}

// Returns the index of the first PRIORITY_TITLE_KEYWORDS hit (0 = top),
// or 999 if no priority keyword matched. Used as the primary sort key.
function titlePriorityScore(title) {
  if (!title) return 999;
  const lower = title.toLowerCase();
  for (let i = 0; i < PRIORITY_TITLE_KEYWORDS.length; i++) {
    if (lower.includes(PRIORITY_TITLE_KEYWORDS[i])) return i;
  }
  return 999;
}

// Strip legal suffixes that ZI's search is fussy about — "Inc", "LLC",
// "LP", "Corp", "Ltd", "Co", etc. Many ZI queries with the suffix
// return 0 results; same query without the suffix matches.
const LEGAL_SUFFIX_RE = /[,.]?\s*\b(inc|llc|llp|lp|ltd|corp|corporation|company|co|group|holdings?|management|partners|pllc|realty|capital|properties|trust)\s*\.?\s*$/i;

function stripLegalSuffix(name) {
  if (!name) return name;
  let n = String(name).trim();
  // Iteratively strip trailing legal markers (handles "ABC, LP Inc" → "ABC")
  for (let i = 0; i < 4; i++) {
    const stripped = n.replace(LEGAL_SUFFIX_RE, '').trim();
    if (stripped === n || !stripped) break;
    n = stripped;
  }
  return n.replace(/[,.\s]+$/, '').trim();
}

async function findRelevantContacts(companyName, { maxResults = 20 } = {}) {
  if (!companyName) return [];

  // Try full name first; if zero, retry with legal suffixes stripped.
  let searchResults = await searchContacts(companyName, { maxResults: 100 });
  if (!searchResults.length) {
    const alt = stripLegalSuffix(companyName);
    if (alt && alt !== companyName) {
      searchResults = await searchContacts(alt, { maxResults: 100 });
    }
  }
  if (!searchResults.length) return [];

  // Filter: must have email or phone, and title must match target OR priority keywords.
  // Sort: priority rank asc (lower index = higher priority), then accuracy desc.
  const candidates = searchResults
    .filter(c => c.hasEmail || c.hasDirectPhone || c.hasMobilePhone)
    .filter(c => titleMatchesTarget(c.jobTitle))
    .sort((a, b) => {
      const pa = titlePriorityScore(a.jobTitle);
      const pb = titlePriorityScore(b.jobTitle);
      if (pa !== pb) return pa - pb;
      return (b.contactAccuracyScore || 0) - (a.contactAccuracyScore || 0);
    })
    .slice(0, maxResults);

  if (!candidates.length) return [];

  const ids = candidates.map(c => c.id).filter(Boolean);
  const enriched = await enrichContactsById(ids);

  // Filter: drop enriched records with NEITHER email NOR phone (can't reach
  // them at all). A phone-only contact is still useful to reps — they can
  // call or reference on LinkedIn via externalUrls.
  return enriched.filter(c => c.email || c.phone || c.mobilePhone);
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

module.exports = {
  authenticate,
  searchContacts,
  enrichContactsById,
  findRelevantContacts,
  titleMatchesTarget,
  titlePriorityScore,
  TARGET_TITLE_KEYWORDS,
  PRIORITY_TITLE_KEYWORDS,
  TITLE_EXCLUDE_KEYWORDS
};
