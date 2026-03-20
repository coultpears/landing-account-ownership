'use strict';

/**
 * audit.js — /apbot audit handler
 *
 * Wraps the existing audit pipeline for use via /apbot.
 */

const fs   = require('fs');
const path = require('path');

const { auditRep, KNOWN_REPS } = require('../../audit');
const { ensureOwnershipRuleProperty } = require('../../hubspot');

const RULE_LABELS = {
  TOP_50:           'Top 50 Owner → Jack Harvey',
  LEASE_UP:         'Lease-Up → Xander Williams',
  OWNER_ASSIGNMENT: 'Owner-Level Assignment',
  STATE_FALLBACK:   'State/Regional Fallback',
  UNASSIGNED:       'Unassigned'
};

function humanizeDays(n) {
  if (n === null || n === undefined) return '—';
  if (n <= 0)   return 'today';
  if (n === 1)  return 'yesterday';
  if (n < 7)    return `${n}d ago`;
  if (n < 30)   return `${Math.round(n / 7)}w ago`;
  if (n < 365)  return `${Math.round(n / 30)}mo ago`;
  return `${Math.round(n / 365)}y ago`;
}

function qualBadge(status) {
  if (status === 'qualified') return '🟢 MF';
  if (status === 'not-mf')    return '🔴 Non-MF';
  return '🟡 Unverified';
}

function loadConfig() {
  try {
    return JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', '..', 'data', 'config.json'), 'utf8'));
  } catch { return { slackToRep: {}, repOwnerIds: {} }; }
}

function resolveRepName(parsed, context) {
  const entity = parsed.entity || '';
  const self = parsed.parameters?.self;

  if (self || !entity) {
    // Resolve from Slack user
    const config = loadConfig();
    const rep = config.slackToRep?.[context.userId];
    return rep || null;
  }

  // Fuzzy match entity to known rep
  const needle = entity.toLowerCase().replace(/[^a-z\s]/g, '').trim();
  return KNOWN_REPS.find(r => r.toLowerCase() === needle)
    || KNOWN_REPS.find(r => r.toLowerCase().includes(needle))
    || KNOWN_REPS.find(r => needle.includes(r.split(' ')[0].toLowerCase()))
    || KNOWN_REPS.find(r => needle.split(/\s+/).some(w => w.length >= 3 && r.toLowerCase().includes(w)))
    || null;
}

async function handleAudit(parsed, context) {
  const repName = resolveRepName(parsed, context);
  if (!repName) {
    return {
      text: `Could not determine which rep to audit. Try: \`audit Scout Bishop\`\n*Available reps:* ${KNOWN_REPS.join(', ')}`
    };
  }

  const daysBack = parsed.parameters?.days || 90;

  try {
    await ensureOwnershipRuleProperty();
  } catch { /* non-fatal */ }

  const result = await auditRep(repName, { daysBack, qualifiedOnly: false });

  if (result.error) {
    return { text: `Error: ${result.error}` };
  }

  const { conflicts, companies, excluded, hubspotOwner, summary, stageAverages, stageOrder } = result;
  const ownerLabel = hubspotOwner
    ? `${hubspotOwner.firstName} ${hubspotOwner.lastName}`
    : repName;

  // Activity summary
  const actParts = [];
  if (summary.deals)    actParts.push(`${summary.deals} deal${summary.deals !== 1 ? 's' : ''}`);
  if (summary.emails)   actParts.push(`${summary.emails}${summary.emails >= 200 ? '+' : ''} email${summary.emails !== 1 ? 's' : ''}`);
  if (summary.calls)    actParts.push(`${summary.calls} call${summary.calls !== 1 ? 's' : ''}`);
  if (summary.meetings) actParts.push(`${summary.meetings} meeting${summary.meetings !== 1 ? 's' : ''}`);
  if (summary.tasks)    actParts.push(`${summary.tasks} task${summary.tasks !== 1 ? 's' : ''}`);
  const actLine = actParts.length > 0
    ? actParts.join(', ') + ` — *${summary.totalActivities} total activities*`
    : 'No activity found';

  const blocks = [
    { type: 'header', text: { type: 'plain_text', text: `📊 Audit — ${ownerLabel}`, emoji: true } },
    { type: 'section', text: { type: 'mrkdwn', text:
      `*Lookback:* Last ${daysBack} days\n` +
      `*Companies hit:* ${companies.length}` + (excluded > 0 ? ` _(${excluded} vendors excluded)_` : '') + '\n' +
      `*Conflicts:* ${conflicts.length > 0 ? `*${conflicts.length}* ⚠` : '✅ 0'}`
    }},
    { type: 'divider' },
    { type: 'section', text: { type: 'mrkdwn', text: `*Activity Overview*\n${actLine}` } }
  ];

  // Stage averages
  const stageLines = Object.entries(stageAverages || {})
    .sort((a, b) => (stageOrder[a[0]] ?? 999) - (stageOrder[b[0]] ?? 999))
    .map(([stage, s]) => `  • ${stage}: ${s.deals} deal${s.deals !== 1 ? 's' : ''}, ~${s.avgTouchpoints} touches/deal`);

  if (stageLines.length > 0) {
    blocks.push({ type: 'section', text: { type: 'mrkdwn', text: `*Avg Touchpoints by Deal Stage*\n${stageLines.join('\n')}` } });
  }

  blocks.push({ type: 'divider' });

  if (conflicts.length === 0) {
    blocks.push({ type: 'section', text: { type: 'mrkdwn', text: `✅ No conflicts — ${repName} is correctly assigned on all active accounts.` } });
  } else {
    const MAX_SHOWN = 10;
    const shown = conflicts.slice(0, MAX_SHOWN);
    const remaining = conflicts.length - shown.length;

    for (const c of shown) {
      const recency = humanizeDays(c.daysSince);
      const badge = qualBadge(c.qualStatus);
      const ruleLabel = RULE_LABELS[c.rule] || c.rule;
      blocks.push({ type: 'section', text: { type: 'mrkdwn', text:
        `*${c.companyName}* ${badge}\n` +
        `<${c.link}|View in HubSpot>   ·   *Market:* ${c.market}   ·   *Last activity:* ${recency}\n` +
        `*Working it:* ${c.workingRep}   →   *Should be:* *${c.expectedRep}*\n` +
        `*Rule:* ${ruleLabel}`
      }});
    }

    if (remaining > 0) {
      blocks.push({ type: 'divider' });
      blocks.push({ type: 'section', text: { type: 'mrkdwn', text: `_…and ${remaining} more conflicts not shown. Use \`/audit ${repName}\` for the full view with assignment buttons._` } });
    }
  }

  // Truncate to 50 blocks
  return { blocks: blocks.slice(0, 50) };
}

module.exports = handleAudit;
