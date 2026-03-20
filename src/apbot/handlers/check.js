'use strict';

/**
 * check.js — /apbot check handler
 *
 * Wraps the existing /check ownership resolution logic.
 * Delegates to the same resolution pipeline used by the /check slash command.
 */

const fs   = require('fs');
const path = require('path');

const { resolve }              = require('../../engine');
const { qualify }              = require('../../qualify');
const { enrichFromPropertyName, enrichOwnerHQ, looksLikePropertyName } = require('../../search');
const { searchCompanyByName, getCompany, getOwners, getPortalId } = require('../../hubspot');
const { buildContactBlocks }   = require('../contacts');

const CACHE_PATH = path.join(__dirname, '..', '..', '..', 'data', 'cache.json');

function loadCache() {
  try { return JSON.parse(fs.readFileSync(CACHE_PATH, 'utf8')); } catch { return {}; }
}
function saveCache(c) {
  try { fs.writeFileSync(CACHE_PATH, JSON.stringify(c, null, 2)); } catch {}
}
function cacheKey(q) { return q.toLowerCase().replace(/\s+/g, ' ').trim(); }

const RULE_LABELS = {
  TOP_50:           'Top 50 Owner → Jack Harvey',
  LEASE_UP:         'Lease-Up → Xander Williams',
  OWNER_ASSIGNMENT: 'Owner-Level Assignment',
  STATE_FALLBACK:   'State/Regional Fallback',
  UNASSIGNED:       'Unassigned'
};

/**
 * Handle a check intent from /apbot.
 */
async function handleCheck(parsed, context) {
  const query = parsed.entity || '';
  if (!query) {
    return { text: 'What owner or property would you like to check? Example: `check Camden`' };
  }

  const input = {
    ownerName: query,
    market: null,
    ownerHQ: null,
    isLeaseUp: false,
    propertyClass: null,
    propertyType: null
  };

  // Enrichment: cache → property name → HQ
  const cache = loadCache();
  const key = cacheKey(input.ownerName);

  if (cache[key]) {
    const c = cache[key];
    if (c.ownerName) input.ownerName = c.ownerName;
    if (c.market)    input.market    = c.market;
    if (c.ownerHQ)   input.ownerHQ   = c.ownerHQ;
  } else if (looksLikePropertyName(input.ownerName)) {
    const enriched = await enrichFromPropertyName(input.ownerName);
    const toCache = { cachedAt: new Date().toISOString() };
    if (enriched.ownerName) { input.ownerName = toCache.ownerName = enriched.ownerName; }
    if (enriched.market)    { input.market    = toCache.market    = enriched.market; }
    if (enriched.ownerHQ)   { input.ownerHQ   = toCache.ownerHQ   = enriched.ownerHQ; }
    if (Object.keys(toCache).length > 1) { cache[key] = toCache; saveCache(cache); }
  } else if (!input.ownerHQ && !input.market) {
    const hq = await enrichOwnerHQ(input.ownerName);
    if (hq) {
      input.ownerHQ = hq;
      cache[key] = { ownerHQ: hq, cachedAt: new Date().toISOString() };
      saveCache(cache);
    }
  }

  // Qualification gate
  const qual = qualify(input);
  if (!qual.qualified) {
    return {
      blocks: [
        { type: 'header', text: { type: 'plain_text', text: '🚫 Lead Disqualified', emoji: true } },
        { type: 'section', text: { type: 'mrkdwn', text:
          `*Query:* ${query}\n\n` +
          qual.reasons.map(r => `✗ ${r}`).join('\n') +
          '\n\nThis property/owner does not meet Class A/B Conventional MF criteria.'
        }}
      ]
    };
  }

  // Resolve
  let result = resolve(input);

  // HubSpot lookup for location + re-resolve
  let companyId = null;
  let hubspotLink = null;
  let currentOwnerName = null;

  try {
    const [hits, portalId, allOwners] = await Promise.all([
      searchCompanyByName(input.ownerName),
      getPortalId(),
      getOwners()
    ]);

    if (hits.length > 0) {
      companyId = hits[0].id;
      hubspotLink = `https://app.hubspot.com/contacts/${portalId}/company/${companyId}`;

      const company = await getCompany(companyId);
      const p = company.properties || {};

      if (p.hubspot_owner_id) {
        const o = allOwners.find(o => String(o.id) === String(p.hubspot_owner_id));
        if (o) currentOwnerName = `${o.firstName} ${o.lastName}`.trim();
      }

      const hsMarket = [p.city, p.state].filter(Boolean).join(' ');
      if (hsMarket && !input.market && !input.ownerHQ) {
        const retried = resolve({ ...input, market: hsMarket });
        if (retried.rule !== 'UNASSIGNED') {
          result = retried;
          input.market = hsMarket;
        }
      }
    }
  } catch { /* non-fatal */ }

  // Build response
  const suggestedReps = (Array.isArray(result.rep) ? result.rep : [result.rep])
    .filter(r => r && r !== 'UNASSIGNED');
  const repDisplay = suggestedReps.join(' / ') || 'UNASSIGNED';
  const ruleLabel = RULE_LABELS[result.rule] || result.rule;

  const blocks = [
    { type: 'header', text: { type: 'plain_text', text: '📋 Ownership Resolution', emoji: true } },
    { type: 'section', text: { type: 'mrkdwn', text:
      `*Query:* ${query}\n` +
      (result.matchedOwner ? `*Matched:* ${result.matchedOwner}\n` : '') +
      (currentOwnerName ? `*Current HubSpot owner:* ${currentOwnerName}\n` : '') +
      `*Rule:* ${ruleLabel}\n` +
      `*Should be:* *${repDisplay}*`
    }},
    { type: 'section', text: { type: 'mrkdwn', text: `*Why:* ${result.explanation}` } }
  ];

  if (result.warnings.length > 0) {
    blocks.push({ type: 'section', text: { type: 'mrkdwn', text: result.warnings.map(w => `⚠ ${w}`).join('\n') } });
  }

  if (hubspotLink) {
    blocks.push({ type: 'section', text: { type: 'mrkdwn', text: `*HubSpot:* <${hubspotLink}|View record>` } });
  }

  // Append top 2 contacts
  if (companyId) {
    const contactBlocks = await buildContactBlocks(companyId);
    blocks.push(...contactBlocks);
  }

  return { blocks };
}

module.exports = handleCheck;
