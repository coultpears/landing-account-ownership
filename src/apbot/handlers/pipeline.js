'use strict';

/**
 * pipeline.js — /apbot pipeline handler
 *
 * Two modes:
 *   1. Deal listings — "my deals", "deals in Contract Redline" → structured Slack blocks
 *   2. Analytics/reporting — any freeform question about the pipeline → smart analyst
 *      Fetches all AP pipeline deals, builds a compact summary, and lets the LLM answer.
 */

const fs   = require('fs');
const path = require('path');

const {
  getOwners, getPortalId, getDealStageLabels, getDealStageOrder
} = require('../../hubspot');
const { KNOWN_REPS } = require('../../audit');
const { analyze } = require('../analyst');
const { summarizeDeals } = require('../summarize');

const https = require('https');

const AP_PIPELINE_ID = '64402505';

// AP Pipeline stage IDs (Outside Sales AP Partnerships, pipeline 64402505)
const AP_STAGES = {
  NEW_OPPORTUNITIES:   '126194574',
  CONTACTED:           '128203694',
  DEFINING_CALL:       '185461262',
  CALL_SCHEDULED:      '126194575',
  IC_REVIEW:           '1225117962',
  ACTIVE:              '126194576',
  LATE_STAGE:          '126194577',
  CONTRACT_DISCUSSIONS:'128915635',
  CONTRACT_REDLINE:    '126194578',
  CLOSED_WON:          '126194579',
  LOST_DEAL:           '1097165102'
};

// Stage enter/exit date properties for the AP pipeline
const STAGE_DATE_PROPS = Object.values(AP_STAGES).flatMap(id => [
  `hs_v2_date_entered_${id}`,
  `hs_v2_date_exited_${id}`
]);

const DEAL_PROPERTIES_FULL = [
  'dealname', 'dealstage', 'hubspot_owner_id', 'amount', 'pipeline',
  'createdate', 'closedate', 'notes_last_updated', 'notes_last_contacted',
  'hs_v2_time_in_current_stage', 'hs_is_closed_won', 'closed_won_reason',
  'hs_lastmodifieddate', 'first_pitch_date__ap_', 'pitch_category', 'in_person_pitch',
  ...STAGE_DATE_PROPS
];

function getToken() { return process.env.HUBSPOT_TOKEN; }

function apiRequest(method, apiPath, body = null) {
  return new Promise((resolve, reject) => {
    const token = getToken();
    const bodyStr = body ? JSON.stringify(body) : null;
    const options = {
      hostname: 'api.hubapi.com', path: apiPath, method,
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        ...(bodyStr ? { 'Content-Length': Buffer.byteLength(bodyStr) } : {})
      }
    };
    const req = https.request(options, res => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        if (res.statusCode >= 400) reject(new Error(`HubSpot ${res.statusCode}`));
        else { try { resolve(JSON.parse(data)); } catch { resolve(data); } }
      });
    });
    req.on('error', reject);
    req.setTimeout(20000, () => { req.destroy(); reject(new Error('Timeout')); });
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function searchDeals(filterGroups, properties, maxResults = 500) {
  const results = [];
  let after;
  do {
    const body = { filterGroups, properties, limit: 100, ...(after ? { after } : {}) };
    const res = await apiRequest('POST', '/crm/v3/objects/deals/search', body);
    results.push(...(res.results || []));
    after = res.paging?.next?.after;
    if (after) await sleep(200);
  } while (after && results.length < maxResults);
  return results;
}

function loadConfig() {
  try {
    return JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', '..', 'data', 'config.json'), 'utf8'));
  } catch { return { slackToRep: {}, repOwnerIds: {} }; }
}

function humanizeDays(n) {
  if (n === null || n === undefined) return '—';
  if (n <= 0) return 'today';
  if (n < 7)  return `${n}d`;
  if (n < 30) return `${Math.round(n / 7)}w`;
  return `${Math.round(n / 30)}mo`;
}

function secondsToDays(s) {
  if (!s) return null;
  return Math.round(Number(s) / 86400 * 10) / 10;
}

async function resolveOwnerId(parsed, context) {
  const config = loadConfig();
  if (parsed.parameters?.self) {
    const repName = config.slackToRep?.[context.userId];
    if (repName && config.repOwnerIds?.[repName]) {
      return { ownerId: config.repOwnerIds[repName], repName };
    }
    return null;
  }

  // Check parsed.parameters.rep first (LLM-extracted rep name)
  const repParam = parsed.parameters?.rep;
  if (repParam) {
    const needle = repParam.toLowerCase().replace(/[^a-z\s]/g, '').trim();
    const matched = KNOWN_REPS.find(r => r.toLowerCase() === needle)
      || KNOWN_REPS.find(r => r.toLowerCase().includes(needle))
      || KNOWN_REPS.find(r => needle.includes(r.split(' ')[0].toLowerCase()));
    if (matched && config.repOwnerIds?.[matched]) {
      return { ownerId: config.repOwnerIds[matched], repName: matched };
    }
  }

  // Fall back to entity
  const entity = (parsed.entity || '').trim();
  if (!entity) return null;

  const needle = entity.toLowerCase().replace(/[^a-z\s]/g, '').trim();
  const rep = KNOWN_REPS.find(r => r.toLowerCase() === needle)
    || KNOWN_REPS.find(r => r.toLowerCase().includes(needle))
    || KNOWN_REPS.find(r => needle.includes(r.split(' ')[0].toLowerCase()))
    || KNOWN_REPS.find(r => needle.split(/\s+/).some(w => w.length >= 3 && r.toLowerCase().includes(w)));

  if (rep && config.repOwnerIds?.[rep]) {
    return { ownerId: config.repOwnerIds[rep], repName: rep };
  }
  return null;
}

/**
 * Determine if this is a reporting/analytics question (→ smart analyst)
 * or a deal listing request (→ structured blocks).
 *
 * Analytics: any question about metrics, averages, comparisons, trends,
 * rates, rankings, or "how/what/which/why" questions.
 *
 * Listings: "my deals", "deals in [stage]", "stale deals", "show pipeline"
 */
function isAnalyticsQuestion(parsed, originalText) {
  const metric = parsed.parameters?.metric;
  // Pitch and stale queries have their own handlers
  if (metric === 'last_pitch' || metric === 'stale') return false;
  // Explicit analytics metrics
  if (metric) return true;

  // Freeform question patterns — but not if it's about pitches
  const lower = (originalText || '').toLowerCase();
  if (/pitch/i.test(lower)) return false;
  if (/\b(average|avg|mean|median|how long|how many|what is|what's|which rep|who has|compare|trend|rate|percent|fastest|slowest|biggest|most|least|best|worst|rank|top|bottom)\b/i.test(lower)) {
    return true;
  }

  return false;
}

// ---------------------------------------------------------------------------
// Main handler
// ---------------------------------------------------------------------------

async function handlePipeline(parsed, context) {
  const metric = parsed.parameters?.metric;
  const stage = parsed.parameters?.stage;
  const originalText = parsed.entity || '';

  // Pitch query — structured output (has specific display needs)
  if (metric === 'last_pitch') {
    return handlePitchQuery(parsed, context);
  }

  // Analytics / reporting question → smart analyst
  if (isAnalyticsQuestion(parsed, context._originalText || originalText)) {
    return handleSmartAnalytics(context._originalText || originalText || parsed.entity, parsed, context);
  }

  // Deal listing — structured blocks
  return handleDealListing(parsed, context);
}

// ---------------------------------------------------------------------------
// Smart analytics — LLM answers any reporting question
// ---------------------------------------------------------------------------

async function handleSmartAnalytics(question, parsed, context) {
  // Fetch all AP pipeline deals — cap at 2000 to cover full pipeline
  const deals = await searchDeals(
    [{ filters: [{ propertyName: 'pipeline', operator: 'EQ', value: AP_PIPELINE_ID }] }],
    DEAL_PROPERTIES_FULL,
    2000
  );

  const stageLabels = await getDealStageLabels();
  const allOwners = await getOwners();

  // Build compact summary for the LLM
  const summary = summarizeDeals(deals, stageLabels, allOwners);

  const dataContext = `Outside Sales AP Partnerships pipeline (pipeline ID ${AP_PIPELINE_ID}). ` +
    `This is the main apartment partnerships deal pipeline. ` +
    `Known deal properties include: deal name, stage, owner, amount, create date, close date, ` +
    `time in current stage, first pitch date (AP), pitch category, in-person pitch flag, ` +
    `last modified date, last contacted date, closed won reason. ` +
    `Reps on the team: ${KNOWN_REPS.join(', ')}.`;

  const answer = await analyze(question, summary, dataContext, context.userId);

  const blocks = [
    { type: 'header', text: { type: 'plain_text', text: '📊 Pipeline Analytics', emoji: true } },
    { type: 'section', text: { type: 'mrkdwn', text: answer } }
  ];

  return { blocks: blocks.slice(0, 50) };
}

// ---------------------------------------------------------------------------
// Deal listing — structured Slack blocks
// ---------------------------------------------------------------------------

async function handleDealListing(parsed, context) {
  const metric = parsed.parameters?.metric;
  const stage = parsed.parameters?.stage;

  const ownerInfo = await resolveOwnerId(parsed, context);
  const stageLabels = await getDealStageLabels();
  const portalId = await getPortalId();

  const filters = [
    { propertyName: 'pipeline', operator: 'EQ', value: AP_PIPELINE_ID }
  ];

  if (ownerInfo) {
    filters.push({ propertyName: 'hubspot_owner_id', operator: 'EQ', value: ownerInfo.ownerId });
  }

  if (stage) {
    const stageId = Object.entries(stageLabels).find(
      ([id, label]) => label.toLowerCase() === stage.toLowerCase()
    )?.[0];
    if (stageId) {
      filters.push({ propertyName: 'dealstage', operator: 'EQ', value: stageId });
    }
  }

  const deals = await searchDeals([{ filters }], DEAL_PROPERTIES_FULL, 200);
  const allOwners = await getOwners();
  const ownerName = (id) => {
    const o = allOwners.find(o => String(o.id) === String(id));
    return o ? `${o.firstName} ${o.lastName}`.trim() : '—';
  };

  let displayDeals = deals;
  if (metric === 'stale') {
    const cutoff = Date.now() - 4 * 86400000;
    displayDeals = deals.filter(d => {
      const lastMod = d.properties?.hs_lastmodifieddate;
      return lastMod && new Date(lastMod).getTime() < cutoff;
    });
  }

  const titleParts = [];
  if (metric === 'stale') titleParts.push('Stale');
  if (ownerInfo) titleParts.push(`${ownerInfo.repName}'s`);
  if (stage) titleParts.push(`${stage}`);
  titleParts.push('Deals');
  const title = titleParts.join(' ');

  const blocks = [
    { type: 'header', text: { type: 'plain_text', text: `📈 ${title}`, emoji: true } },
    { type: 'section', text: { type: 'mrkdwn', text: `*${displayDeals.length} deal${displayDeals.length !== 1 ? 's' : ''}* in AP Pipeline` } }
  ];

  if (displayDeals.length === 0) {
    blocks.push({ type: 'section', text: { type: 'mrkdwn', text: '_No deals found matching your criteria._' } });
    return { blocks };
  }

  // Stage distribution summary
  const stageCounts = {};
  for (const d of displayDeals) {
    const label = stageLabels[d.properties?.dealstage] || d.properties?.dealstage || 'Unknown';
    stageCounts[label] = (stageCounts[label] || 0) + 1;
  }
  const stageOrder = await getDealStageOrder();
  const distLines = Object.entries(stageCounts)
    .sort((a, b) => (stageOrder[a[0]] ?? 999) - (stageOrder[b[0]] ?? 999))
    .map(([s, n]) => `  • ${s}: *${n}*`);

  blocks.push({ type: 'section', text: { type: 'mrkdwn', text: `*Stage Distribution:*\n${distLines.join('\n')}` } });
  blocks.push({ type: 'divider' });

  const MAX_SHOWN = 12;
  const shown = displayDeals.slice(0, MAX_SHOWN);
  const remaining = displayDeals.length - shown.length;

  for (const d of shown) {
    const dp = d.properties || {};
    const stageLabel = stageLabels[dp.dealstage] || dp.dealstage || '—';
    const timeInStage = secondsToDays(dp.hs_v2_time_in_current_stage);
    const timeStr = timeInStage !== null ? `${timeInStage}d in stage` : '';
    const lastMod = dp.hs_lastmodifieddate ? new Date(dp.hs_lastmodifieddate) : null;
    const daysAgo = lastMod ? Math.floor((Date.now() - lastMod.getTime()) / 86400000) : null;
    const hsLink = `https://app.hubspot.com/contacts/${portalId}/deal/${d.id}`;

    blocks.push({ type: 'section', text: { type: 'mrkdwn', text:
      `<${hsLink}|${dp.dealname || '(unnamed)'}>\n` +
      `*Stage:* ${stageLabel}` +
      (timeStr ? `   ·   *${timeStr}*` : '') +
      (daysAgo !== null ? `   ·   *Last activity:* ${humanizeDays(daysAgo)}` : '') +
      (!ownerInfo ? `   ·   *Owner:* ${ownerName(dp.hubspot_owner_id)}` : '') +
      (dp.amount ? `   ·   *$${Number(dp.amount).toLocaleString()}*` : '')
    }});
  }

  if (remaining > 0) {
    blocks.push({ type: 'section', text: { type: 'mrkdwn', text: `_…and ${remaining} more deals not shown._` } });
  }

  return { blocks: blocks.slice(0, 50) };
}

// ---------------------------------------------------------------------------
// Pitch queries — structured output
// ---------------------------------------------------------------------------

async function handlePitchQuery(parsed, context) {
  const ownerInfo = await resolveOwnerId(parsed, context);
  const portalId = await getPortalId();
  const stageLabels = await getDealStageLabels();
  const allOwners = await getOwners();
  const ownerName = (id) => {
    const o = allOwners.find(o => String(o.id) === String(id));
    return o ? `${o.firstName} ${o.lastName}`.trim() : '—';
  };

  const filters = [
    { propertyName: 'pipeline', operator: 'EQ', value: AP_PIPELINE_ID },
    { propertyName: 'first_pitch_date__ap_', operator: 'HAS_PROPERTY' }
  ];

  if (ownerInfo) {
    filters.push({ propertyName: 'hubspot_owner_id', operator: 'EQ', value: ownerInfo.ownerId });
  }

  const deals = await searchDeals([{ filters }], DEAL_PROPERTIES_FULL, 100);

  deals.sort((a, b) => {
    const da = new Date(a.properties?.first_pitch_date__ap_ || 0).getTime();
    const db = new Date(b.properties?.first_pitch_date__ap_ || 0).getTime();
    return db - da;
  });

  const title = ownerInfo ? `${ownerInfo.repName}'s Pitches` : 'Recent Pitches';

  if (deals.length === 0) {
    return {
      blocks: [
        { type: 'header', text: { type: 'plain_text', text: `🎯 ${title}`, emoji: true } },
        { type: 'section', text: { type: 'mrkdwn', text: '_No deals found with a pitch date._' } }
      ]
    };
  }

  const lastPitchDate = new Date(deals[0].properties?.first_pitch_date__ap_);
  const daysSinceLastPitch = Math.floor((Date.now() - lastPitchDate.getTime()) / 86400000);
  const lastPitchStr = daysSinceLastPitch === 0 ? 'today'
    : daysSinceLastPitch === 1 ? 'yesterday'
    : `${daysSinceLastPitch} days ago`;

  const blocks = [
    { type: 'header', text: { type: 'plain_text', text: `🎯 ${title}`, emoji: true } },
    { type: 'section', text: { type: 'mrkdwn', text:
      `*${deals.length} deal${deals.length !== 1 ? 's' : ''} with pitch dates*\n` +
      `*Last pitch:* ${lastPitchDate.toLocaleDateString()} _(${lastPitchStr})_`
    } }
  ];

  const MAX_SHOWN = 10;
  const shown = deals.slice(0, MAX_SHOWN);

  for (const d of shown) {
    const dp = d.properties || {};
    const pitchDate = dp.first_pitch_date__ap_ ? new Date(dp.first_pitch_date__ap_).toLocaleDateString() : '—';
    const stageLabel = stageLabels[dp.dealstage] || dp.dealstage || '—';
    const category = dp.pitch_category || null;
    const inPerson = dp.in_person_pitch || null;
    const hsLink = `https://app.hubspot.com/contacts/${portalId}/deal/${d.id}`;

    let line = `<${hsLink}|${dp.dealname || '(unnamed)'}>\n` +
      `*Pitch date:* ${pitchDate}   ·   *Stage:* ${stageLabel}`;
    if (!ownerInfo) line += `   ·   *Owner:* ${ownerName(dp.hubspot_owner_id)}`;
    if (category) line += `\n*Category:* ${category}`;
    if (inPerson) line += `   ·   *In-person:* ${inPerson}`;

    blocks.push({ type: 'section', text: { type: 'mrkdwn', text: line } });
  }

  if (deals.length > MAX_SHOWN) {
    blocks.push({ type: 'section', text: { type: 'mrkdwn', text: `_…and ${deals.length - MAX_SHOWN} more not shown._` } });
  }

  return { blocks: blocks.slice(0, 50) };
}

module.exports = handlePipeline;
