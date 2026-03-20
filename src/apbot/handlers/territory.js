'use strict';

/**
 * territory.js — /apbot territory handler
 *
 * "who covers Phoenix?", "whose territory is VA?"
 * Uses getStateReps from engine.js.
 */

const fs   = require('fs');
const path = require('path');

const { getStateReps } = require('../../engine');

function loadAssignments() {
  try {
    return JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', '..', 'data', 'assignments.json'), 'utf8'));
  } catch { return { stateAssignments: [], ownerAssignments: [] }; }
}

async function handleTerritory(parsed, context) {
  const query = parsed.entity || '';
  if (!query) {
    return { text: 'What location would you like to check? Example: `who covers Phoenix?`' };
  }

  const assignments = loadAssignments();
  const result = getStateReps(query, assignments);

  if (!result) {
    return { text: `No territory assignment found for "${query}". Try a city name or state (e.g. "Phoenix", "VA", "Virginia").` };
  }

  const blocks = [
    { type: 'header', text: { type: 'plain_text', text: `📍 Territory: ${query}`, emoji: true } }
  ];

  const lines = result.details.map(d =>
    d.focus ? `  • *${d.rep}* — ${d.focus}` : `  • *${d.rep}*`
  );

  blocks.push({ type: 'section', text: { type: 'mrkdwn', text:
    `*State:* ${result.stateCode}\n` +
    `*Assigned rep${result.reps.length > 1 ? 's' : ''}:*\n${lines.join('\n')}`
  }});

  if (result.fallback) {
    blocks.push({ type: 'section', text: { type: 'mrkdwn', text:
      `⚠ "${query}" did not match any sub-market focus within ${result.stateCode}. Showing all reps for this state — coordinate to assign a primary.`
    }});
  }

  if (result.reps.length > 1 && !result.fallback) {
    blocks.push({ type: 'section', text: { type: 'mrkdwn', text:
      `⚠ Multiple reps cover ${result.stateCode}. Each has a sub-market focus — verify which rep best fits.`
    }});
  }

  return { blocks };
}

module.exports = handleTerritory;
