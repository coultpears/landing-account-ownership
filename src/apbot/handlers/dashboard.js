'use strict';

/**
 * dashboard.js — /apbot Launch Dashboard handler
 *
 * Queries the Launch Dashboard CSV (Data Hub tab) for property info:
 * "units at [property]", "PSM for [property]", "properties in [market]"
 *
 * Columns: Property Name, AP Sales Person, AP Coordinator, AGM/Installer,
 *   Hub Manager, Link, Account Executive, Partner Success manager,
 *   Operations Coordinator, Unit Count, Signed Date, Kickoff Email Deadline,
 *   Kickoff Call Deadline, Expected Launch, Contract Link
 */

const { searchProperties } = require('../datasources/launch-dashboard');
const { buildContactBlocks } = require('../contacts');
const { searchCompanyByName } = require('../../hubspot');

async function handleDashboard(parsed, context) {
  const query = parsed.entity || '';
  if (!query) {
    return { text: 'What property would you like to look up? Example: `units at Modera Buckhead`' };
  }

  let rows;
  try {
    rows = await searchProperties(query);
  } catch (err) {
    if (err.message.includes('not configured')) {
      return { text: '`LAUNCH_DASHBOARD_CSV_URL` is not configured. Add the Google Sheets published CSV URL to `.env`.' };
    }
    throw err;
  }

  if (rows.length === 0) {
    return { text: `No properties found matching "${query}" in the Launch Dashboard.` };
  }

  const blocks = [
    { type: 'header', text: { type: 'plain_text', text: `🏗 Launch Dashboard — "${query}"`, emoji: true } },
    { type: 'section', text: { type: 'mrkdwn', text: `*${rows.length} propert${rows.length !== 1 ? 'ies' : 'y'} found*` } }
  ];

  const MAX_SHOWN = 8;
  const shown = rows.slice(0, MAX_SHOWN);
  const remaining = rows.length - shown.length;

  for (const row of shown) {
    const propName = row['Property Name'] || '(unnamed)';
    const units = row['Unit Count'] || '—';
    const ae = row['Account Executive'] || '—';
    const psm = row['Partner Success manager'] || '—';
    const opsCoord = row['Operations Coordinator'] || '—';
    const signedDate = row['Signed Date'] || '—';
    const expectedLaunch = row['Expected Launch'] || '—';
    const link = row['Link'] || null;

    const nameDisplay = link ? `<${link}|${propName}>` : `*${propName}*`;

    blocks.push({ type: 'divider' });
    blocks.push({ type: 'section', text: { type: 'mrkdwn', text:
      `${nameDisplay}\n` +
      `*Units:* ${units}   ·   *AE:* ${ae}   ·   *PSM:* ${psm}\n` +
      `*OC:* ${opsCoord}\n` +
      `*Signed:* ${signedDate}   ·   *Expected Launch:* ${expectedLaunch}`
    }});

    // Try to find HubSpot company and add contacts
    try {
      const hits = await searchCompanyByName(propName.split(' ').slice(0, 3).join(' '));
      if (hits.length > 0) {
        const contactBlocks = await buildContactBlocks(hits[0].id);
        blocks.push(...contactBlocks);
      }
    } catch { /* non-fatal */ }
  }

  if (remaining > 0) {
    blocks.push({ type: 'divider' });
    blocks.push({ type: 'section', text: { type: 'mrkdwn', text: `_…and ${remaining} more properties not shown._` } });
  }

  return { blocks: blocks.slice(0, 50) };
}

module.exports = handleDashboard;
