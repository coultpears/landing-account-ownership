'use strict';

/**
 * sync.js — CoStar → HubSpot sync engine
 *
 * Parses a CoStar XLSX/CSV export, matches each company to a HubSpot record
 * (domain-first, then fuzzy name), diffs fields, and upserts.
 *
 * Flow:
 *   1. Parse file → array of CoStar rows
 *   2. Ensure custom HubSpot properties exist
 *   3. For each row:
 *      a. Search HS by domain (if available) → exact match
 *      b. Fallback: search HS by company name → fuzzy match
 *      c. If found: compare fields, update if drifted
 *      d. If not found: validate, then create new company record
 *   4. Return sync summary
 */

const XLSX    = require('xlsx');
const path    = require('path');
const fs      = require('fs');
const hubspot = require('../hubspot');
const {
  FIELD_MAP,
  SYNC_TIMESTAMP_FIELD,
  COSTAR_GROUP,
  getCustomFields,
  rowToHubspotProps,
  getFieldByCostar
} = require('./fields');

// ---------------------------------------------------------------------------
// File parsing
// ---------------------------------------------------------------------------

function parseFile(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const workbook = XLSX.readFile(filePath);
  const sheetName = workbook.SheetNames[0];
  const sheet = workbook.Sheets[sheetName];
  const rows = XLSX.utils.sheet_to_json(sheet, { defval: '' });

  // Filter out empty rows (CoStar sometimes appends blank lines)
  return rows.filter(row => row['Company'] && String(row['Company']).trim());
}

// ---------------------------------------------------------------------------
// HubSpot property setup — ensure costar_ group + properties exist
// ---------------------------------------------------------------------------

const https = require('https');

async function ensurePropertyGroup() {
  try {
    await hubspotApi('POST', '/crm/v3/properties/companies/groups', {
      name:  COSTAR_GROUP.name,
      label: COSTAR_GROUP.label
    });
  } catch (e) {
    if (!e.message.includes('409')) throw e;
    // 409 = group already exists
  }
}

async function ensureCustomProperties() {
  await ensurePropertyGroup();

  const allFields = [...getCustomFields(), SYNC_TIMESTAMP_FIELD];

  for (const field of allFields) {
    try {
      await hubspotApi('POST', '/crm/v3/properties/companies', {
        name:      field.hubspot,
        label:     field.label,
        type:      field.type,
        fieldType: field.fieldType,
        groupName: field.groupName || 'costar_data'
      });
    } catch (e) {
      if (!e.message.includes('409')) throw e;
      // 409 = already exists
    }
  }
}

// Reuse the same HTTP helper pattern from hubspot.js
function hubspotApi(method, apiPath, body = null) {
  return new Promise((resolve, reject) => {
    const token = process.env.HUBSPOT_TOKEN;
    if (!token) throw new Error('HUBSPOT_TOKEN not set');
    const bodyStr = body ? JSON.stringify(body) : null;

    const options = {
      hostname: 'api.hubapi.com',
      path:     apiPath,
      method,
      headers: {
        Authorization:  `Bearer ${token}`,
        'Content-Type': 'application/json',
        ...(bodyStr ? { 'Content-Length': Buffer.byteLength(bodyStr) } : {})
      }
    };

    const req = https.request(options, res => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        if (res.statusCode >= 400) {
          let msg;
          try { msg = JSON.parse(data).message || data.slice(0, 300); }
          catch { msg = data.slice(0, 300); }
          reject(new Error(`HubSpot ${res.statusCode} ${method} ${apiPath}: ${msg}`));
        } else {
          try { resolve(JSON.parse(data)); }
          catch { resolve(data); }
        }
      });
    });

    req.on('error', reject);
    req.setTimeout(20000, () => { req.destroy(); reject(new Error(`Timeout: ${apiPath}`)); });
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ---------------------------------------------------------------------------
// Company matching — domain-first, then name
// ---------------------------------------------------------------------------

/**
 * Search HubSpot for a company matching this CoStar row.
 * Strategy:
 *   1. Search by domain (exact match) — most reliable
 *   2. Fallback: search by company name (fuzzy) — picks best match
 * Returns { match: hsCompany, method: 'domain'|'name' } or null
 */
async function findHubspotMatch(companyName) {
  // 1. Try name search (CONTAINS_TOKEN) — CoStar doesn't export domains
  const nameResults = await hubspot.searchCompanyByName(companyName, 5);

  if (nameResults.length === 0) return null;

  // Score results by name similarity
  const normalizedQuery = normalize(companyName);
  let best = null;
  let bestScore = 0;

  for (const co of nameResults) {
    const hsName = co.properties?.name || '';
    const score = nameSimilarity(normalizedQuery, normalize(hsName));
    if (score > bestScore) {
      bestScore = score;
      best = co;
    }
  }

  // Require high confidence to avoid false matches
  // Single-word names (after normalization) need exact match to avoid
  // collisions like "Arbor Properties" vs "Arbor Company" (different entities)
  const queryWords = normalizedQuery.split(' ').filter(w => w.length >= 2);
  const minConfidence = queryWords.length <= 1 ? 0.9 : 0.75;

  if (bestScore >= minConfidence) {
    return { match: best, method: 'name', confidence: bestScore };
  }

  return null;
}

/** Normalize company name for comparison */
function normalize(name) {
  return name
    .toLowerCase()
    .replace(/[.,'"()]/g, '')
    .replace(/\b(inc|llc|llp|corp|corporation|company|co|ltd|group|lp|properties|management|realty)\b/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Score similarity between two normalized names (0-1) */
function nameSimilarity(a, b) {
  if (a === b) return 1;

  // Substring match in either direction
  if (a.includes(b) || b.includes(a)) return 0.9;

  // Word overlap
  const wordsA = new Set(a.split(' ').filter(w => w.length >= 2));
  const wordsB = new Set(b.split(' ').filter(w => w.length >= 2));
  if (wordsA.size === 0 || wordsB.size === 0) return 0;

  let overlap = 0;
  for (const w of wordsA) {
    if (wordsB.has(w)) overlap++;
  }

  return overlap / Math.max(wordsA.size, wordsB.size);
}

// ---------------------------------------------------------------------------
// Diff — compare CoStar props vs existing HS props, return only changes
// ---------------------------------------------------------------------------

function diffProperties(costarProps, hsProperties) {
  const changes = {};

  for (const [key, newVal] of Object.entries(costarProps)) {
    // Always update the sync timestamp
    if (key === SYNC_TIMESTAMP_FIELD.hubspot) {
      changes[key] = newVal;
      continue;
    }

    const currentVal = hsProperties[key];

    // Skip if values match (normalize for comparison)
    const normNew = String(newVal).trim();
    const normCur = (currentVal == null || currentVal === '') ? '' : String(currentVal).trim();

    if (normNew === normCur) continue;

    // CoStar always wins
    changes[key] = newVal;
  }

  return changes;
}

// ---------------------------------------------------------------------------
// Create company
// ---------------------------------------------------------------------------

async function createCompany(companyName, costarProps) {
  const props = { ...costarProps, name: companyName };
  return hubspotApi('POST', '/crm/v3/objects/companies', { properties: props });
}

// ---------------------------------------------------------------------------
// Main sync
// ---------------------------------------------------------------------------

/**
 * Run the full CoStar → HubSpot sync.
 * @param {string} filePath - Path to CoStar XLSX/CSV export
 * @param {object} opts
 * @param {boolean} opts.dryRun - If true, don't write to HubSpot
 * @param {function} opts.onProgress - Called with { current, total, company, action }
 * @returns {object} Summary: { total, matched, created, updated, skipped, errors, details[] }
 */
async function runSync(filePath, opts = {}) {
  const { dryRun = false, onProgress } = opts;

  // 1. Parse file
  const rows = parseFile(filePath);
  if (!rows.length) throw new Error('No data rows found in file');

  // 2. Ensure HS properties exist (skip in dry run)
  if (!dryRun) {
    await ensureCustomProperties();
  }

  // 3. Process each row
  const summary = {
    total:    rows.length,
    matched:  0,
    created:  0,
    updated:  0,
    skipped:  0,
    errors:   0,
    details:  []
  };

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const companyName = String(row['Company']).trim();

    if (onProgress) {
      onProgress({ current: i + 1, total: rows.length, company: companyName });
    }

    try {
      const costarProps = rowToHubspotProps(row);
      const result = await findHubspotMatch(companyName);

      if (result) {
        // Found existing company — diff and update
        summary.matched++;
        const hsProps = result.match.properties || {};
        const changes = diffProperties(costarProps, hsProps);

        // Count real changes (exclude timestamp-only)
        const realChanges = Object.keys(changes).filter(k => k !== SYNC_TIMESTAMP_FIELD.hubspot);

        if (realChanges.length > 0) {
          if (!dryRun) {
            await hubspot.updateCompany(result.match.id, changes);
          }
          summary.updated++;
          summary.details.push({
            company:   companyName,
            action:    'updated',
            hsId:      result.match.id,
            hsName:    hsProps.name || '',
            method:    result.method,
            confidence: result.confidence,
            changes:   realChanges
          });
        } else {
          // No changes needed — just update sync timestamp
          if (!dryRun) {
            await hubspot.updateCompany(result.match.id, {
              [SYNC_TIMESTAMP_FIELD.hubspot]: String(Date.now())
            });
          }
          summary.skipped++;
          summary.details.push({
            company:  companyName,
            action:   'no_changes',
            hsId:     result.match.id,
            hsName:   hsProps.name || '',
            method:   result.method
          });
        }
      } else {
        // No match — create new company
        if (!dryRun) {
          const created = await createCompany(companyName, costarProps);
          summary.details.push({
            company:  companyName,
            action:   'created',
            hsId:     created.id
          });
        } else {
          summary.details.push({
            company: companyName,
            action:  'would_create'
          });
        }
        summary.created++;
      }
    } catch (err) {
      summary.errors++;
      summary.details.push({
        company: companyName,
        action:  'error',
        error:   err.message
      });
    }

    // Rate limiting — stay well under HubSpot limits
    if (i < rows.length - 1) await sleep(300);
  }

  return summary;
}

// ---------------------------------------------------------------------------
// Dry run helper for CLI/testing
// ---------------------------------------------------------------------------

async function dryRun(filePath) {
  return runSync(filePath, { dryRun: true });
}

module.exports = {
  parseFile,
  runSync,
  dryRun,
  ensureCustomProperties,
  findHubspotMatch,
  normalize,
  nameSimilarity
};
