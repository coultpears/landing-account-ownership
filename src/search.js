'use strict';

/**
 * search.js — Web enrichment module
 *
 * When the CLI receives a query that looks like a property name (not an owner),
 * or when an owner is provided but HQ/market are missing, this module searches
 * the web to fill in the gaps before resolution runs.
 *
 * Uses DuckDuckGo's free JSON API (no API key required). Results are best-effort —
 * well-known properties and large management companies tend to resolve cleanly.
 * For ambiguous or very small owners, the CLI will print what it found and flag
 * anything it couldn't determine.
 */

const https = require('https');

// ---------------------------------------------------------------------------
// HTTP helper
// ---------------------------------------------------------------------------

function httpGet(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'User-Agent': 'landing-ownership-engine/1.0' } }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return resolve(httpGet(res.headers.location));
      }
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve(data));
    });
    req.on('error', reject);
    req.setTimeout(8000, () => { req.destroy(); reject(new Error('Search timeout')); });
  });
}

async function ddgSearch(query) {
  const url = `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&skip_disambig=1`;
  const raw = await httpGet(url);
  return JSON.parse(raw);
}

/**
 * Scrape DuckDuckGo HTML search results as a fallback when the Instant Answer
 * API returns nothing. Returns raw text from result snippets.
 */
/**
 * Scrape a company's own website (contact/about pages) to find their address.
 * Returns plain text from the page or null.
 */
async function scrapeCompanyWebsite(domain) {
  const paths = ['/contact-us', '/contact', '/about-us', '/about', '/'];
  for (const p of paths) {
    try {
      const raw = await httpGet(`https://www.${domain}${p}`);
      const plain = raw.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
      // Return full text so extractLocation can search the entire page
      if (/[A-Z][a-zA-Z\s]{2,20},?\s+[A-Z]{2}\b/.test(plain)) {
        return plain;
      }
    } catch { /* try next path */ }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Parsers
// ---------------------------------------------------------------------------

/**
 * Extract "City ST" from free text. Returns e.g. "New Haven CT" or null.
 */
function extractLocation(text) {
  // Match patterns like "New Haven, CT" or "New Haven CT 06511"
  const pattern = /\b([A-Z][a-zA-Z\s]{2,20}),?\s+([A-Z]{2})\b(?:\s+\d{5})?/g;
  const skip = new Set(['United States', 'New York', 'Los Angeles', 'San Francisco']);
  const US_STATES = new Set([
    'AL','AK','AZ','AR','CA','CO','CT','DE','FL','GA','HI','ID','IL','IN','IA',
    'KS','KY','LA','ME','MD','MA','MI','MN','MS','MO','MT','NE','NV','NH','NJ',
    'NM','NY','NC','ND','OH','OK','OR','PA','RI','SC','SD','TN','TX','UT','VT',
    'VA','WA','WV','WI','WY','DC'
  ]);
  for (const m of text.matchAll(pattern)) {
    const city = m[1].trim();
    const state = m[2];
    // Skip non-state codes, all-caps words in city (nav elements like "CONTACT US"), and known junk
    if (!US_STATES.has(state)) continue;
    if (/\b[A-Z]{2,}\b/.test(city)) continue;  // skip entries with ALL-CAPS words
    if (city.split(' ').length <= 4 && !skip.has(city + ' ' + state)) {
      return `${city} ${state}`;
    }
  }
  return null;
}

/**
 * Extract an owner/manager name from free text.
 * Looks for "managed by X", "owned by X", "developed by X", etc.
 */
function extractOwner(text) {
  const patterns = [
    /(?:managed|operated) by ([A-Z][A-Za-z0-9\s&,\.]+?)(?:\.|,\s+[a-z]|$)/,
    /(?:developed|built) by ([A-Z][A-Za-z0-9\s&,\.]+?)(?:\.|,\s+[a-z]|$)/,
    /(?:owned) by ([A-Z][A-Za-z0-9\s&,\.]+?)(?:\.|,\s+[a-z]|$)/,
    /([A-Z][A-Za-z0-9\s&]+?) (?:manages|owns|developed)/,
  ];
  for (const p of patterns) {
    const m = text.match(p);
    if (m) {
      const name = m[1].trim().replace(/\s+/g, ' ');
      if (name.length > 3 && name.length < 60) return name;
    }
  }
  return null;
}

/**
 * Extract a property class signal from free text.
 * Returns "Class A", "Class B", or an affordable-flag string, or null.
 * Only returns a value when confidence is high — prefers explicit class labels.
 */
function extractPropertyClass(text) {
  const lower = text.toLowerCase();
  if (/class[\s-]*a\b/.test(lower)) return 'Class A';
  if (/class[\s-]*b\b/.test(lower)) return 'Class B';
  if (/\bluxury\b/.test(lower)) return 'Class A';
  if (/\b(affordable|lihtc|section[\s-]*8|tax[\s-]*credit|hud|low[\s-]income)\b/.test(lower)) return 'Affordable';
  return null;
}

/**
 * Collapse all searchable text out of a DuckDuckGo response into one string.
 */
function collapseText(r) {
  return [
    r.AbstractText,
    r.Answer,
    ...(r.RelatedTopics || []).map(t => t.Text || ''),
    ...(r.Results || []).map(t => t.Text || '')
  ].filter(Boolean).join(' ');
}

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

/**
 * Returns true if the query looks like a property name rather than a company name.
 * Heuristics:
 *   - Contains a digit (e.g. "Axis 201", "One Park Avenue")
 *   - Short (≤3 words) AND lacks common business-entity suffixes
 */
function looksLikePropertyName(query) {
  if (/\d/.test(query)) return true;
  const businessTerms = /\b(llc|inc|corp|ltd|partners|management|residential|communities|capital|properties|realty|investments|trust|group|advisors|associates|ventures|holdings)\b/i;
  const words = query.trim().split(/\s+/);
  if (words.length <= 3 && !businessTerms.test(query)) return true;
  return false;
}

// ---------------------------------------------------------------------------
// Enrichment functions
// ---------------------------------------------------------------------------

/**
 * Given a property name, find: owner name, property market (city+state), owner HQ.
 * Returns { ownerName, market, ownerHQ, searchNote } — null fields = not found.
 */
async function enrichFromPropertyName(propertyName) {
  const result = { ownerName: null, market: null, ownerHQ: null, propertyClass: null, searchNote: null };
  const notes = [];

  try {
    // Pass 1: property → location + owner
    const r1 = await ddgSearch(`${propertyName} apartment property`);
    const text1 = collapseText(r1);

    if (text1) {
      result.market = extractLocation(text1);
      result.ownerName = extractOwner(text1);
      result.propertyClass = extractPropertyClass(text1);
      notes.push(`property search: "${propertyName} apartment property"`);
    }

    // Pass 2: owner → HQ
    if (result.ownerName) {
      const r2 = await ddgSearch(`${result.ownerName} real estate headquarters`);
      const text2 = collapseText(r2);
      if (text2) {
        result.ownerHQ = extractLocation(text2);
        notes.push(`HQ search: "${result.ownerName} real estate headquarters"`);
      }
    }
  } catch (e) {
    notes.push(`search failed: ${e.message}`);
  }

  result.searchNote = notes.join(' | ');
  return result;
}

/**
 * Given an owner name with no HQ, search for their headquarters state.
 * Returns a location string or null.
 */
async function enrichOwnerHQ(ownerName) {
  try {
    const r = await ddgSearch(`${ownerName} real estate company headquarters`);
    const text = collapseText(r);
    return text ? extractLocation(text) : null;
  } catch {
    return null;
  }
}

/**
 * Try to extract a street address from free text.
 * Returns e.g. "123 Main Street" or null. Best-effort — not always present.
 */
function extractStreetAddress(text) {
  const m = text.match(
    /\b(\d{1,5}\s+[A-Z][A-Za-z0-9\s]{2,30}(?:Street|St|Avenue|Ave|Boulevard|Blvd|Road|Rd|Drive|Dr|Lane|Ln|Way|Court|Ct|Place|Pl)\.?)\b/
  );
  return m ? m[1].trim().replace(/\s+/g, ' ') : null;
}

/**
 * Given a company name, search for its HQ city, state, and (optionally) street address.
 * Returns { city, state, address } — null fields = not found.
 *
 * In Claude Code sessions, prefer using the built-in WebSearch tool for more
 * reliable results before calling this function.
 */
async function enrichCompanyLocation(companyName, domain) {
  try {
    const searchStr = `${companyName} company headquarters address location`;

    // Try Instant Answer API first
    const r    = await ddgSearch(searchStr);
    let text = collapseText(r);

    // Fallback: scrape company's own website if API returned nothing and we have a domain
    if (!text && domain) {
      text = await scrapeCompanyWebsite(domain);
    }

    if (!text) return { city: null, state: null, address: null };

    const location = extractLocation(text);
    let city = null, state = null;
    if (location) {
      const parts = location.split(' ');
      state = parts.pop();
      city  = parts.join(' ');
    }

    const address = extractStreetAddress(text);
    return { city, state, address };
  } catch {
    return { city: null, state: null, address: null };
  }
}

module.exports = {
  enrichFromPropertyName,
  enrichOwnerHQ,
  enrichCompanyLocation,
  looksLikePropertyName,
  extractPropertyClass
};
