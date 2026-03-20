'use strict';

/**
 * launch-dashboard.js — Google Sheet CSV fetcher + fuzzy search
 *
 * Fetches Launch Dashboard CSVs from published Google Sheet tabs.
 * Searches across multiple tabs (Data Hub + Import of New Deals) to find
 * the best matches. No caching — fresh fetch every query.
 *
 * Abstraction: exports fetchDashboard() and searchProperties().
 * When Looker API replaces the CSV, swap this file only — handler code unchanged.
 */

const https = require('https');

const CSV_URL = process.env.LAUNCH_DASHBOARD_CSV_URL;
const IMPORT_CSV_URL = process.env.LAUNCH_IMPORT_CSV_URL;

/**
 * Fetch and parse CSVs from all configured tabs. Returns array of row objects.
 * Each row is tagged with _source ('Data Hub' or 'Import of New Deals').
 */
async function fetchDashboard() {
  if (!CSV_URL && !IMPORT_CSV_URL) {
    throw new Error('LAUNCH_DASHBOARD_CSV_URL not configured');
  }

  const fetches = [];
  if (CSV_URL) fetches.push(fetchUrl(CSV_URL).then(raw => parseCSV(raw).map(r => ({ ...r, _source: 'Data Hub' }))));
  if (IMPORT_CSV_URL) fetches.push(fetchUrl(IMPORT_CSV_URL).then(raw => parseCSV(raw).map(r => ({ ...r, _source: 'Import of New Deals' }))));

  const results = await Promise.all(fetches);
  return results.flat();
}

/**
 * Search properties by name, market, or other text. Returns matching rows.
 */
async function searchProperties(query) {
  const rows = await fetchDashboard();
  const norm = normalize(query);
  const qWords = norm.split(' ').filter(w => w.length > 2);

  const scored = [];
  for (const row of rows) {
    const propName = normalize(row['Property Name'] || '');
    const market = normalize(row['Market'] || '');

    let score = 0;

    // --- Property name matching ---
    if (propName === norm) {
      score = 100;
    } else if (propName.includes(norm)) {
      score = 90;
    } else if (norm.includes(propName) && propName.length > 3) {
      score = 80;
    }

    // --- Market matching (city/state) ---
    if (market) {
      if (market === norm) {
        score = Math.max(score, 95);
      } else if (market.includes(norm)) {
        score = Math.max(score, 85);
      } else {
        // Check if all query words appear in the market field
        const mWords = market.split(' ').filter(w => w.length > 1);
        const marketHits = qWords.filter(w => mWords.some(mw => mw === w));
        if (marketHits.length > 0) {
          const marketScore = 70 * (marketHits.length / Math.max(qWords.length, 1));
          score = Math.max(score, marketScore);
        }
      }
    }

    // --- Word-level property name matching (fallback) ---
    if (score < 50) {
      const pWords = propName.split(' ').filter(w => w.length > 2);
      const hits = qWords.filter(w => pWords.some(pw => pw === w));
      if (hits.length > 0) {
        const wordScore = 50 * (hits.length / Math.max(qWords.length, 1));
        score = Math.max(score, wordScore);
      }
    }

    // --- Full-text fallback across all columns ---
    if (score < 40) {
      const allValues = Object.values(row).join(' ').toLowerCase();
      if (allValues.includes(norm)) {
        score = Math.max(score, 40);
      }
    }

    if (score >= 25) {
      scored.push({ row, score });
    }
  }

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, 15).map(s => s.row);
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
