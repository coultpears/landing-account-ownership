#!/usr/bin/env node
'use strict';

/**
 * Fetch all workspace users via Slack Web API (users.list).
 * Outputs: Slack User ID | Real Name | Email
 *
 * Usage:
 *   node scripts/list-slack-users.js
 *
 * Requires SLACK_BOT_TOKEN in .env (needs users:read + users:read.email scopes).
 */

const fs   = require('fs');
const path = require('path');

// Load .env
try {
  const lines = fs.readFileSync(path.join(__dirname, '..', '.env'), 'utf8').split(/\r?\n/);
  for (const line of lines) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)\s*=\s*(.+)$/);
    if (m && !process.env[m[1]]) {
      process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
    }
  }
} catch { /* no .env */ }

const token = process.env.SLACK_BOT_TOKEN;
if (!token) {
  console.error('Error: SLACK_BOT_TOKEN not set. Add it to .env');
  process.exit(1);
}

async function fetchUsers() {
  let cursor = '';
  const users = [];

  do {
    const url = new URL('https://slack.com/api/users.list');
    url.searchParams.set('limit', '200');
    if (cursor) url.searchParams.set('cursor', cursor);

    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` }
    });
    const data = await res.json();

    if (!data.ok) {
      console.error(`Slack API error: ${data.error}`);
      process.exit(1);
    }

    for (const u of data.members || []) {
      if (u.is_bot || u.id === 'USLACKBOT' || u.deleted) continue;
      users.push({
        id:    u.id,
        name:  u.profile?.real_name || u.real_name || u.name,
        email: u.profile?.email || '—'
      });
    }

    cursor = data.response_metadata?.next_cursor || '';
  } while (cursor);

  return users;
}

(async () => {
  const users = await fetchUsers();

  // Header
  console.log('Slack User ID    | Real Name                      | Email');
  console.log('-'.repeat(80));

  for (const u of users.sort((a, b) => a.name.localeCompare(b.name))) {
    const id   = u.id.padEnd(16);
    const name = u.name.padEnd(32);
    console.log(`${id} | ${name} | ${u.email}`);
  }

  console.log(`\nTotal: ${users.length} users`);

  // Also output JSON for easy copy-paste into config.json
  console.log('\n--- slackToRep template (paste into data/config.json) ---');
  console.log('{');
  for (const u of users.sort((a, b) => a.name.localeCompare(b.name))) {
    console.log(`  "${u.id}": "${u.name}",`);
  }
  console.log('}');
})();
