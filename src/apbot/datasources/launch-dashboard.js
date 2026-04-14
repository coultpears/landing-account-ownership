'use strict';

/**
 * launch-dashboard.js — Google Sheet CSV fetcher + fuzzy search
 *
 * Fetches Launch Dashboard CSVs from published Google Sheet tabs.
 * Searches across multiple tabs (Data Hub + Import of New Deals) to find
 * the best matches. No caching — fresh fetch every query.
 *
 * Supports:
 *   - Text search: property name, partner name, market, AE, rep
 *   - Date filtering: signed/contract dates within a month or range
 *   - Fuzzy matching: handles misspellings via edit distance
 */

const https = require('https');

const CSV_URL = process.env.LAUNCH_DASHBOARD_CSV_URL;
const IMPORT_CSV_URL = process.env.LAUNCH_IMPORT_CSV_URL;
const AP_DEALS_CSV_URL = process.env.AP_DEALS_CSV_URL;

/**
 * Fetch and parse CSVs from all configured tabs. Returns array of row objects.
 * Each row is tagged with _source and has normalized column names.
 */
async function fetchDashboard() {
  if (!CSV_URL && !IMPORT_CSV_URL && !AP_DEALS_CSV_URL) {
    throw new Error('No dashboard CSV URLs configured');
  }

  const fetches = [];
  // AP Deals sheet is the primary source — has Partner column, proper dates, 1000+ properties
  if (AP_DEALS_CSV_URL) fetches.push(fetchUrl(AP_DEALS_CSV_URL).then(raw => parseCSV(raw).map(r => normalizeAPDealsRow(r))));
  if (CSV_URL) fetches.push(fetchUrl(CSV_URL).then(raw => parseCSV(raw).map(r => normalizeRow(r, 'Data Hub'))));
  if (IMPORT_CSV_URL) fetches.push(fetchUrl(IMPORT_CSV_URL).then(raw => parseCSV(raw).map(r => normalizeImportRow(r))));

  const results = await Promise.all(fetches);
  const allRows = results.flat();

  // Deduplicate by property name — prefer AP Deals > Data Hub > Import
  const SOURCE_PRIORITY = { 'AP Deals': 3, 'Data Hub': 2, 'Import of New Deals': 1 };
  const seen = new Map();
  for (const row of allRows) {
    const key = (row._propertyName || '').toLowerCase().trim();
    if (!key) continue;
    const existing = seen.get(key);
    const existingPriority = existing ? (SOURCE_PRIORITY[existing._source] || 0) : 0;
    const newPriority = SOURCE_PRIORITY[row._source] || 0;
    if (!existing || newPriority > existingPriority) {
      seen.set(key, row);
    }
  }
  return Array.from(seen.values());
}

/**
 * Normalize an AP Deals row — primary source with Partner column, proper dates.
 * Columns: Property Name, Market, Total Unit Count, Lexit Unit Count, AP Sales Person,
 * Contract Signed Date, Partner, GLD, Deal Type, Term Length, etc.
 */
function normalizeAPDealsRow(row) {
  // Extract AE name from email (e.g. "jack.thomasson@hellolanding.com" → "Jack Thomasson")
  const email = row['AP Sales Person'] || '';
  const ae = email.includes('@')
    ? email.split('@')[0].split('.').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ')
    : email;

  return {
    'Property Name': row['Property Name'] || '',
    'Market': row['Market'] || '',
    'Unit Count': row['Total Unit Count'] || '',
    'AP Sales Person': ae,
    'Signed Date': row['Contract Signed Date'] || '',
    'Partner': row['Partner'] || '',
    'GLD': row['GLD'] || '',
    'Deal Type': row['Deal Type'] || '',
    'Property Address': row['Property Address'] || '',
    'Market Region': row['Market Region'] || '',
    _source: 'AP Deals',
    _propertyName: row['Property Name'] || '',
    _market: row['Market'] || '',
    _units: row['Total Unit Count'] || '',
    _ae: ae,
    _psm: '',
    _signedDate: row['Contract Signed Date'] || '',
    _expectedLaunch: row['GLD'] || '',
    _partner: row['Partner'] || '',
  };
}

/**
 * Normalize a Data Hub row — columns are correctly aligned.
 */
function normalizeRow(row, source) {
  return {
    ...row,
    _source: source,
    _propertyName: row['Property Name'] || '',
    _market: row['Market'] || '',
    _units: row['Unit Count'] || '',
    _ae: row['Account Executive'] || row['AP Sales Person'] || '',
    _psm: row['Partner Success manager'] || '',
    _signedDate: row['Signed Date'] || '',
    _expectedLaunch: row['Expected Launch'] || '',
  };
}

/**
 * Normalize an Import tab row — columns are shifted/misaligned.
 * Actual mapping: Market=City, Total Unit Count=State, AP Sales Person=Units,
 * Contract Signed Date=Rep email, AP Coordinator=Signed Date
 */
function normalizeImportRow(row) {
  return {
    'Property Name': row['Property Name'] || '',
    'Market': row['Market'] || '', // Actually city
    'State': row['Total Unit Count'] || '', // Actually state
    'Unit Count': row['AP Sales Person'] || '', // Actually units
    'AP Sales Person': row['Contract Signed Date'] || '', // Actually rep email
    'Signed Date': row['AP Coordinator'] || '', // Actually signed/contract date
    'AGM/Installer': row['AGM/Installer'] || '',
    'Hub Manager': row['Hub Manager'] || '',
    _source: 'Import of New Deals',
    _propertyName: row['Property Name'] || '',
    _market: row['Market'] || '',
    _units: row['AP Sales Person'] || '',
    _ae: row['Contract Signed Date'] || '',
    _signedDate: row['AP Coordinator'] || '',
    _expectedLaunch: '',
  };
}

/**
 * Search properties by text, with optional date and partner filters.
 *
 * @param {string} query - Search text (property name, partner, market, etc.)
 * @param {object} [options] - Optional filters
 * @param {string} [options.month] - Month filter e.g. "march 2026", "march", "2026-03"
 * @param {string} [options.dateField] - Which date to filter: "signed" (default) or "launch"
 */
async function searchProperties(query, options = {}) {
  const rows = await fetchDashboard();

  // Date filtering
  let filtered = rows;
  if (options.month) {
    const monthFilter = parseMonthFilter(options.month);
    if (monthFilter) {
      const dateField = options.dateField === 'launch' ? '_expectedLaunch' : '_signedDate';
      filtered = rows.filter(row => {
        const dateStr = row[dateField];
        if (!dateStr) return false;
        const parsed = parseDate(dateStr);
        if (!parsed) return false;
        return parsed.month === monthFilter.month && parsed.year === monthFilter.year;
      });

      // If no text query, return all date-matched rows
      if (!query || query.trim() === '') {
        return filtered.slice(0, 50).map(r => stripInternal(r));
      }
    }
  }

  // Text search with fuzzy matching
  const norm = normalize(query);
  const qWords = norm.split(' ').filter(w => w.length > 2);

  const scored = [];
  for (const row of filtered) {
    const score = scoreRow(row, norm, qWords);
    if (score >= 20) {
      scored.push({ row, score });
    }
  }

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, 25).map(s => stripInternal(s.row));
}

/**
 * Score a row against the search query. Uses exact, substring, word-level,
 * and fuzzy (edit distance) matching across property name, market, AE, PSM.
 */
function scoreRow(row, norm, qWords) {
  const propName = normalize(row._propertyName);
  const market = normalize(row._market);
  const ae = normalize(row._ae);
  const psm = normalize(row._psm || '');

  const partner = normalize(row._partner || '');

  // Searchable fields: property name, partner, market, AE, PSM
  const fields = [
    { text: propName, weight: 1.0 },
    { text: partner, weight: 1.0 },
    { text: market, weight: 0.9 },
    { text: ae, weight: 0.8 },
    { text: psm, weight: 0.8 },
  ];

  let score = 0;

  for (const { text, weight } of fields) {
    if (!text) continue;

    // Exact match
    if (text === norm) {
      score = Math.max(score, 100 * weight);
      continue;
    }

    // Substring match
    if (text.includes(norm)) {
      score = Math.max(score, 90 * weight);
    } else if (norm.includes(text) && text.length > 3) {
      score = Math.max(score, 80 * weight);
    }

    // Word-level matching
    const fieldWords = text.split(' ').filter(w => w.length > 2);
    const exactWordHits = qWords.filter(w => fieldWords.some(fw => fw === w));
    if (exactWordHits.length > 0) {
      const wordScore = 65 * (exactWordHits.length / Math.max(qWords.length, 1)) * weight;
      score = Math.max(score, wordScore);
    }

    // Fuzzy word matching (handles misspellings)
    const fuzzyWordHits = qWords.filter(qw =>
      fieldWords.some(fw => fuzzyMatch(qw, fw))
    );
    if (fuzzyWordHits.length > exactWordHits.length) {
      const fuzzyScore = 50 * (fuzzyWordHits.length / Math.max(qWords.length, 1)) * weight;
      score = Math.max(score, fuzzyScore);
    }
  }

  // Full-text fallback across all columns
  if (score < 30) {
    const allValues = Object.entries(row)
      .filter(([k]) => !k.startsWith('_'))
      .map(([, v]) => v)
      .join(' ')
      .toLowerCase();

    if (allValues.includes(norm)) {
      score = Math.max(score, 35);
    }

    // Fuzzy full-text
    const allWords = allValues.split(/\s+/).filter(w => w.length > 2);
    const fuzzyHits = qWords.filter(qw => allWords.some(aw => fuzzyMatch(qw, aw)));
    if (fuzzyHits.length > 0) {
      score = Math.max(score, 25 * (fuzzyHits.length / qWords.length));
    }
  }

  return score;
}

// ---------------------------------------------------------------------------
// Fuzzy matching — Levenshtein edit distance
// ---------------------------------------------------------------------------

/**
 * Check if two words are a fuzzy match (within edit distance threshold).
 * Threshold: 1 edit for words <= 5 chars, 2 edits for longer words.
 */
function fuzzyMatch(a, b) {
  if (a === b) return true;
  if (Math.abs(a.length - b.length) > 2) return false;

  const threshold = Math.max(a.length, b.length) <= 5 ? 1 : 2;
  return editDistance(a, b) <= threshold;
}

function editDistance(a, b) {
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  const matrix = [];
  for (let i = 0; i <= b.length; i++) matrix[i] = [i];
  for (let j = 0; j <= a.length; j++) matrix[0][j] = j;

  for (let i = 1; i <= b.length; i++) {
    for (let j = 1; j <= a.length; j++) {
      const cost = b[i - 1] === a[j - 1] ? 0 : 1;
      matrix[i][j] = Math.min(
        matrix[i - 1][j] + 1,
        matrix[i][j - 1] + 1,
        matrix[i - 1][j - 1] + cost
      );
    }
  }
  return matrix[b.length][a.length];
}

// ---------------------------------------------------------------------------
// Date parsing
// ---------------------------------------------------------------------------

const MONTH_NAMES = {
  jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3,
  apr: 4, april: 4, may: 5, jun: 6, june: 6,
  jul: 7, july: 7, aug: 8, august: 8, sep: 9, september: 9,
  oct: 10, october: 10, nov: 11, november: 11, dec: 12, december: 12
};

/**
 * Parse a month filter string like "march 2026", "march", "2026-03", "3/2026".
 * Returns { month, year } or null.
 */
function parseMonthFilter(str) {
  const lower = str.toLowerCase().trim();

  // "march 2026" or "march"
  for (const [name, num] of Object.entries(MONTH_NAMES)) {
    if (lower.includes(name)) {
      const yearMatch = lower.match(/20\d{2}/);
      return { month: num, year: yearMatch ? parseInt(yearMatch[0]) : new Date().getFullYear() };
    }
  }

  // "2026-03" or "03/2026"
  const isoMatch = lower.match(/^(\d{4})-(\d{1,2})$/);
  if (isoMatch) return { month: parseInt(isoMatch[2]), year: parseInt(isoMatch[1]) };

  const slashMatch = lower.match(/^(\d{1,2})\/(\d{4})$/);
  if (slashMatch) return { month: parseInt(slashMatch[1]), year: parseInt(slashMatch[2]) };

  return null;
}

/**
 * Parse a date string from the dashboard. Handles:
 *   "10/10/23", "11/9/2023" (MM/DD/YY or M/D/YYYY)
 *   "2023-10-10" (YYYY-MM-DD)
 * Returns { month, year, day } or null.
 */
function parseDate(str) {
  if (!str) return null;
  const s = str.trim();

  // YYYY-MM-DD
  const isoMatch = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (isoMatch) {
    return { year: parseInt(isoMatch[1]), month: parseInt(isoMatch[2]), day: parseInt(isoMatch[3]) };
  }

  // MM/DD/YY or M/D/YYYY
  const slashMatch = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})/);
  if (slashMatch) {
    let year = parseInt(slashMatch[3]);
    if (year < 100) year += 2000;
    return { year, month: parseInt(slashMatch[1]), day: parseInt(slashMatch[2]) };
  }

  return null;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function normalize(str) {
  return (str || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Strip internal _fields before returning to caller */
function stripInternal(row) {
  const out = {};
  for (const [k, v] of Object.entries(row)) {
    if (!k.startsWith('_')) out[k] = v;
  }
  return out;
}

function fetchUrl(url) {
  return new Promise((resolve, reject) => {
    const get = (u, redirects = 0) => {
      if (redirects > 5) return reject(new Error('Too many redirects'));
      https.get(u, { timeout: 15000 }, res => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          return get(res.headers.location, redirects + 1);
        }
        if (res.statusCode >= 400) {
          return reject(new Error(`HTTP ${res.statusCode} fetching CSV`));
        }
        let data = '';
        res.on('data', chunk => { data += chunk; });
        res.on('end', () => resolve(data));
      }).on('error', reject);
    };
    get(url);
  });
}

/**
 * Hand-rolled CSV parser — handles quoted fields with commas and newlines.
 */
function parseCSV(text) {
  const lines = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '"') {
      current += ch; // Preserve quotes so splitCSVLine can handle them
      if (inQuotes && text[i + 1] === '"') {
        current += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if ((ch === '\n' || ch === '\r') && !inQuotes) {
      if (current.trim()) lines.push(current);
      current = '';
      if (ch === '\r' && text[i + 1] === '\n') i++;
    } else {
      current += ch;
    }
  }
  if (current.trim()) lines.push(current);

  if (lines.length < 2) return [];

  const headers = splitCSVLine(lines[0]);
  const rows = [];

  for (let i = 1; i < lines.length; i++) {
    const values = splitCSVLine(lines[i]);
    const row = {};
    for (let j = 0; j < headers.length; j++) {
      row[headers[j].trim()] = (values[j] || '').trim();
    }
    rows.push(row);
  }

  return rows;
}

function splitCSVLine(line) {
  const fields = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === ',' && !inQuotes) {
      fields.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  fields.push(current);
  return fields;
}

module.exports = { fetchDashboard, searchProperties };
