'use strict';

/**
 * activity.js — /apbot activity handler
 *
 * Rep activity summary: deals (created vs modified), calls, emails, meetings, tasks.
 * Shows stage coverage gaps — which pipeline stages had no activity in the lookback.
 * Lighter than full audit — no conflict detection.
 */

const fs   = require('fs');
const path = require('path');

const {
  getOwners, getDealsByOwner, getEngagementsByOwner, getDealStageLabels, getDealStageOrder
} = require('../../hubspot');
const { KNOWN_REPS } = require('../../audit');
const { analyze } = require('../analyst');
const { summarizeActivity } = require('../summarize');

const AP_PIPELINE_ID = '64402505';

function loadConfig() {
  try {
    return JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', '..', 'data', 'config.json'), 'utf8'));
  } catch { return { slackToRep: {}, repOwnerIds: {} }; }
}

function matchOwner(repName, owners) {
  const norm = s => s.toLowerCase().replace(/[^a-z\s]/g, '').trim();
  const rn = norm(repName);
  return owners.find(o => norm(`${o.firstName || ''} ${o.lastName || ''}`) === rn)
    || owners.find(o => {
      const full = norm(`${o.firstName || ''} ${o.lastName || ''}`);
      return full.includes(rn) || rn.includes(full);
    }) || null;
}

function parseTs(val) {
  if (!val) return 0;
  const n = Number(val);
  if (!isNaN(n) && n > 1000000000) return n;
  const d = new Date(val);
  return isNaN(d.getTime()) ? 0 : d.getTime();
}

async function handleActivity(parsed, context) {
  const config = loadConfig();
  let repName;

  if (parsed.parameters?.self || !parsed.entity) {
    repName = config.slackToRep?.[context.userId];
    if (!repName) {
      return { text: `Your Slack account isn't mapped to a rep. Try: \`activity Scout Bishop\`` };
    }
  } else {
    const needle = (parsed.entity || '').toLowerCase().replace(/[^a-z\s]/g, '').trim();
    repName = KNOWN_REPS.find(r => r.toLowerCase() === needle)
      || KNOWN_REPS.find(r => r.toLowerCase().includes(needle))
      || KNOWN_REPS.find(r => needle.includes(r.split(' ')[0].toLowerCase()))
      || KNOWN_REPS.find(r => needle.split(/\s+/).some(w => w.length >= 3 && r.toLowerCase().includes(w)));
    if (!repName) {
      return { text: `No rep found matching "${parsed.entity}". *Available:* ${KNOWN_REPS.join(', ')}` };
    }
  }

  const daysBack = parsed.parameters?.days || 30;
  const allOwners = await getOwners();
  const owner = matchOwner(repName, allOwners);

  if (!owner) {
    return { text: `No HubSpot owner found for "${repName}".` };
  }

  const ownerId = owner.id;

  // Fetch activity counts sequentially to avoid HubSpot rate limits
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const deals = await getDealsByOwner(ownerId, daysBack);
  await sleep(250);
  const calls = await getEngagementsByOwner('calls', ownerId, daysBack, 500);
  await sleep(250);
  const emails = await getEngagementsByOwner('emails', ownerId, daysBack, 200);
  await sleep(250);
  const meetings = await getEngagementsByOwner('meetings', ownerId, daysBack, 500);
  await sleep(250);
  const tasks = await getEngagementsByOwner('tasks', ownerId, daysBack, 500);

  // Split deals into created vs modified
  const cutoff = Date.now() - daysBack * 86400000;
  let dealsCreated = 0;
  let dealsModified = 0;
  for (const d of deals) {
    const created = parseTs(d.properties?.createdate);
    if (created >= cutoff) {
      dealsCreated++;
    } else {
      dealsModified++;
    }
  }

  const engagementTotal = calls.length + emails.length + meetings.length + tasks.length;
  const total = deals.length + engagementTotal;

  const timeLabel = daysBack === 1 ? 'Today' : daysBack === 2 ? 'Since yesterday' : `Last ${daysBack} days`;

  const blocks = [
    { type: 'header', text: { type: 'plain_text', text: `📊 Activity — ${repName}`, emoji: true } },
    { type: 'section', text: { type: 'mrkdwn', text:
      `*${timeLabel}*   ·   *${total} total activities*\n\n` +
      `  • *Deals created:* ${dealsCreated}\n` +
      `  • *Deals modified:* ${dealsModified}\n` +
      `  • *Calls:* ${calls.length}\n` +
      `  • *Emails:* ${emails.length}${emails.length >= 200 ? '+' : ''}\n` +
      `  • *Meetings:* ${meetings.length}\n` +
      `  • *Tasks:* ${tasks.length}`
    }}
  ];

  // Stage coverage — fetch AP pipeline stages only
  let apStageLabels = {}; // stageId -> label
  let apStageOrder = [];  // [label, ...] in pipeline order
  try {
    const https = require('https');
    const pipelineData = await new Promise((resolve, reject) => {
      const req = https.request({
        hostname: 'api.hubapi.com',
        path: `/crm/v3/pipelines/deals/${AP_PIPELINE_ID}`,
        method: 'GET',
        headers: { Authorization: `Bearer ${process.env.HUBSPOT_TOKEN}`, 'Content-Type': 'application/json' }
      }, res => {
        let data = '';
        res.on('data', chunk => { data += chunk; });
        res.on('end', () => { try { resolve(JSON.parse(data)); } catch { resolve({}); } });
      });
      req.on('error', reject);
      req.setTimeout(10000, () => { req.destroy(); reject(new Error('Timeout')); });
      req.end();
    });
    const stages = (pipelineData.stages || []).sort((a, b) => (a.displayOrder || 0) - (b.displayOrder || 0));
    for (const s of stages) {
      apStageLabels[s.id] = s.label;
    }
    apStageOrder = stages.map(s => s.label);
  } catch { /* use raw IDs */ }

  // Count deals per stage and track which stages had activity
  const workedStages = {};
  for (const d of deals) {
    const stageId = d.properties?.dealstage;
    const label = apStageLabels[stageId] || stageId || 'Unknown';
    workedStages[label] = (workedStages[label] || 0) + 1;
  }

  // Get all AP pipeline stages in order, excluding terminal stages
  const terminalStages = new Set(['Closed Won', 'Closed Lost']);
  const allStages = apStageOrder.filter(name => !terminalStages.has(name));

  const unworkedStages = allStages.filter(s => !workedStages[s]);

  if (deals.length > 0) {
    // Show which stages were worked
    const orderMap = Object.fromEntries(apStageOrder.map((name, i) => [name, i]));
    const workedLines = Object.entries(workedStages)
      .sort((a, b) => (orderMap[a[0]] ?? 999) - (orderMap[b[0]] ?? 999))
      .map(([stage, count]) => `  • ${stage}: ${count} deal${count !== 1 ? 's' : ''}`);

    blocks.push({ type: 'divider' });
    blocks.push({ type: 'section', text: { type: 'mrkdwn', text:
      `*Deal Stages Worked:*\n${workedLines.join('\n')}`
    }});

    if (unworkedStages.length > 0 && daysBack >= 3) {
      blocks.push({ type: 'section', text: { type: 'mrkdwn', text:
        `⚠ *Stages with no activity:* ${unworkedStages.join(', ')}`
      }});
    }
  }

  // Trend breakdown — daily for short lookbacks, weekly for longer
  const now = Date.now();
  const allEngagements = [...calls, ...emails, ...meetings, ...tasks];

  if (daysBack <= 2) {
    // No trend for today/yesterday — the summary is enough
  } else if (daysBack <= 7) {
    // Daily breakdown
    const buckets = new Array(daysBack).fill(0);
    for (const e of allEngagements) {
      const ts = parseTs(e.properties?.hs_timestamp);
      if (!ts) continue;
      const daysAgo = Math.floor((now - ts) / 86400000);
      if (daysAgo >= 0 && daysAgo < buckets.length) buckets[daysAgo]++;
    }
    const dayLabels = ['Today', 'Yesterday'];
    for (let i = 2; i < buckets.length; i++) dayLabels.push(`${i}d ago`);
    const trendLines = buckets.map((count, i) => `  • ${dayLabels[i]}: ${count}`).join('\n');
    blocks.push({ type: 'divider' });
    blocks.push({ type: 'section', text: { type: 'mrkdwn', text: `*Daily Breakdown:*\n${trendLines}` } });
  } else {
    // Weekly breakdown
    const numWeeks = Math.min(Math.ceil(daysBack / 7), 4);
    const weeks = new Array(numWeeks).fill(0);
    for (const e of allEngagements) {
      const ts = parseTs(e.properties?.hs_timestamp);
      if (!ts) continue;
      const weeksAgo = Math.floor((now - ts) / (7 * 86400000));
      if (weeksAgo >= 0 && weeksAgo < numWeeks) weeks[weeksAgo]++;
    }
    const weekLabels = ['This week', 'Last week'];
    for (let i = 2; i < weeks.length; i++) weekLabels.push(`${i} weeks ago`);
    const trendLines = weeks.map((count, i) => `  • ${weekLabels[i]}: ${count}`).join('\n');
    blocks.push({ type: 'divider' });
    blocks.push({ type: 'section', text: { type: 'mrkdwn', text: `*Weekly Trend:*\n${trendLines}` } });
  }

  // If the original question is more specific than "X's activity", use the analyst
  const originalText = context._originalText || '';
  const isComplexQuestion = /\b(when|last time|how many|which|compare|most|least|did .+ complete|has .+ done)\b/i.test(originalText);

  if (isComplexQuestion) {
    let stageLabels = {};
    try { stageLabels = await getDealStageLabels(); } catch {}

    const actSummary = summarizeActivity(repName, daysBack, deals, calls, emails, meetings, tasks, stageLabels);
    const dataContext = `Activity data for rep ${repName} over the last ${daysBack} days in the Outside Sales AP Partnerships pipeline.`;
    const answer = await analyze(originalText, actSummary, dataContext, context.userId);

    blocks.push({ type: 'divider' });
    blocks.push({ type: 'section', text: { type: 'mrkdwn', text: answer } });
  }

  return { blocks: blocks.slice(0, 50) };
}

module.exports = handleActivity;
