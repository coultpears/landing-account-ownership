'use strict';

/**
 * deal-detail.js — /apbot deal detail handler
 *
 * "tell me about deal 12345", "status on [deal name]"
 * Shows full deal properties, time in stage, associated company, top contacts.
 */

const {
  getOwners, getPortalId, getDealStageLabels,
  getAssociatedCompanyIds, getCompany, searchDealsByName
} = require('../../hubspot');
const { buildContactBlocks } = require('../contacts');

const https = require('https');

const DEAL_PROPERTIES_FULL = [
  'dealname', 'dealstage', 'hubspot_owner_id', 'amount', 'pipeline',
  'createdate', 'closedate', 'notes_last_updated', 'notes_last_contacted',
  'hs_v2_time_in_current_stage', 'hs_is_closed_won', 'closed_won_reason',
  'hs_lastmodifieddate'
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
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('Timeout')); });
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

async function getDealFull(dealId) {
  const props = DEAL_PROPERTIES_FULL.join(',');
  return apiRequest('GET', `/crm/v3/objects/deals/${dealId}?properties=${props}`);
}

function humanizeDays(n) {
  if (n === null || n === undefined) return '—';
  if (n <= 0) return 'today';
  if (n < 7)  return `${n}d ago`;
  if (n < 30) return `${Math.round(n / 7)}w ago`;
  return `${Math.round(n / 30)}mo ago`;
}

async function handleDealDetail(parsed, context) {
  const query = parsed.entity || '';
  if (!query) {
    return { text: 'Which deal? Example: `deal 12345` or `status on [deal name]`' };
  }

  let deal;
  const isId = /^\d+$/.test(query);

  if (isId) {
    try {
      deal = await getDealFull(query);
    } catch {
      return { text: `No deal found with ID \`${query}\`.` };
    }
  } else {
    // Search by name
    const hits = await searchDealsByName(query);
    if (hits.length === 0) {
      return { text: `No deal found matching "${query}".` };
    }
    deal = await getDealFull(hits[0].id);
  }

  const dp = deal.properties || {};
  const [allOwners, portalId, stageLabels] = await Promise.all([
    getOwners(), getPortalId(), getDealStageLabels()
  ]);

  const ownerName = (id) => {
    const o = allOwners.find(o => String(o.id) === String(id));
    return o ? `${o.firstName} ${o.lastName}`.trim() : '—';
  };

  const stageLabel = stageLabels[dp.dealstage] || dp.dealstage || '—';
  const timeInStage = dp.hs_v2_time_in_current_stage
    ? `${Math.round(Number(dp.hs_v2_time_in_current_stage) / 86400 * 10) / 10} days`
    : '—';
  const lastMod = dp.hs_lastmodifieddate ? new Date(dp.hs_lastmodifieddate) : null;
  const lastModStr = lastMod ? humanizeDays(Math.floor((Date.now() - lastMod.getTime()) / 86400000)) : '—';
  const created = dp.createdate ? new Date(dp.createdate).toLocaleDateString() : '—';
  const closeDate = dp.closedate ? new Date(dp.closedate).toLocaleDateString() : '—';
  const hsLink = `https://app.hubspot.com/contacts/${portalId}/deal/${deal.id}`;

  const blocks = [
    { type: 'header', text: { type: 'plain_text', text: `📋 Deal: ${dp.dealname || '(unnamed)'}`, emoji: true } },
    { type: 'section', text: { type: 'mrkdwn', text:
      `<${hsLink}|View in HubSpot>\n\n` +
      `*Stage:* ${stageLabel}   ·   *Time in stage:* ${timeInStage}\n` +
      `*Owner:* ${ownerName(dp.hubspot_owner_id)}\n` +
      `*Amount:* ${dp.amount ? `$${Number(dp.amount).toLocaleString()}` : '—'}\n` +
      `*Created:* ${created}   ·   *Close date:* ${closeDate}\n` +
      `*Last activity:* ${lastModStr}\n` +
      (dp.notes_last_contacted ? `*Last contacted:* ${new Date(dp.notes_last_contacted).toLocaleDateString()}\n` : '') +
      (dp.closed_won_reason ? `*Won reason:* ${dp.closed_won_reason}\n` : '')
    }}
  ];

  // Associated company
  try {
    const assocMap = await getAssociatedCompanyIds('deals', [deal.id]);
    const companyIds = assocMap[deal.id] || [];
    if (companyIds.length > 0) {
      const company = await getCompany(companyIds[0]);
      const cp = company.properties || {};
      const companyLink = `https://app.hubspot.com/contacts/${portalId}/company/${companyIds[0]}`;
      blocks.push({ type: 'section', text: { type: 'mrkdwn', text:
        `*Company:* <${companyLink}|${cp.name || '(unnamed)'}>\n` +
        `*Market:* ${[cp.city, cp.state].filter(Boolean).join(', ') || '—'}`
      }});

      // Top contacts
      const contactBlocks = await buildContactBlocks(companyIds[0]);
      blocks.push(...contactBlocks);
    }
  } catch { /* non-fatal */ }

  return { blocks: blocks.slice(0, 50) };
}

module.exports = handleDealDetail;
