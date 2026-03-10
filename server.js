'use strict';

/**
 * server.js — Slack Bot MVP (Phase 3)
 *
 * Slash commands:
 *   /check [owner or property name]  — full ownership resolution pipeline
 *   /audit-me                        — conflict audit for the calling rep (last 90 days)
 *   /fix [hubspot record ID | name]  — show current vs correct owner with Approve/Decline
 *
 * Setup:
 *   1. npm install
 *   2. Add SLACK_BOT_TOKEN, SLACK_SIGNING_SECRET (+ SLACK_APP_TOKEN for Socket Mode) to .env
 *   3. node server.js
 *
 * See CLAUDE.md Phase 3 section for full setup instructions.
 */

// Load .env before any other requires so hubspot.js picks up HUBSPOT_TOKEN
const fs   = require('fs');
const path = require('path');

(function loadDotEnv() {
  try {
    const lines = fs.readFileSync(path.join(__dirname, '.env'), 'utf8').split(/\r?\n/);
    for (const line of lines) {
      const m = line.match(/^([A-Z_][A-Z0-9_]*)\s*=\s*(.+)$/);
      if (m && !process.env[m[1]]) {
        process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
      }
    }
  } catch { /* no .env — rely on environment */ }
})();

const { App, ExpressReceiver } = require('@slack/bolt');

const { resolve }                                    = require('./src/engine');
const { qualify }                                    = require('./src/qualify');
const {
  enrichFromPropertyName,
  enrichOwnerHQ,
  enrichCompanyLocation,
  looksLikePropertyName
}                                                    = require('./src/search');
const { auditRep, KNOWN_REPS }                       = require('./src/audit');
const {
  getOwners,
  getPortalId,
  getCompany,
  updateCompany,
  ensureOwnershipRuleProperty,
  searchCompanyByName
}                                                    = require('./src/hubspot');

// ---------------------------------------------------------------------------
// Slack App
// Socket Mode (local dev):  SLACK_APP_TOKEN set  → persistent WebSocket
// HTTP Mode   (Cloud Run):  SLACK_APP_TOKEN absent → ExpressReceiver on PORT
//
// HTTP mode uses a custom ExpressReceiver so we can drop Slack's retry
// requests immediately. Slack retries a slash command if it doesn't get a
// response within ~3 seconds, even after ack() sends the HTTP 200 — because
// on Cloud Run the CPU is throttled once the 200 is sent, which stalls the
// async work and makes Slack think the request timed out. Dropping retries
// at the HTTP layer prevents the resulting retry storm.
// ---------------------------------------------------------------------------

let app;
let httpReceiver = null; // set in HTTP mode; used to register /health

if (process.env.SLACK_APP_TOKEN) {
  // ── Socket Mode ────────────────────────────────────────────────────────────
  app = new App({
    token:         process.env.SLACK_BOT_TOKEN,
    signingSecret: process.env.SLACK_SIGNING_SECRET,
    socketMode:    true,
    appToken:      process.env.SLACK_APP_TOKEN
  });
} else {
  // ── HTTP Mode ──────────────────────────────────────────────────────────────
  httpReceiver = new ExpressReceiver({
    signingSecret: process.env.SLACK_SIGNING_SECRET
  });

  // Drop Slack retry requests immediately — return 200 and ignore.
  // Without this, slow handlers (audit, HubSpot enrichment) trigger a retry
  // storm: Slack retries → queued requests → apparent 429s → dead bot.
  httpReceiver.app.use((req, res, next) => {
    if (req.headers['x-slack-retry-num']) {
      res.sendStatus(200);
      return;
    }
    next();
  });

  // Health check — used by Cloud Run readiness probes and manual verification
  httpReceiver.app.get('/health', (_req, res) => res.status(200).json({ ok: true }));

  app = new App({
    token:    process.env.SLACK_BOT_TOKEN,
    receiver: httpReceiver
  });
}

// ---------------------------------------------------------------------------
// Slack user → rep mapping (loaded from data/config.json → slackToRep)
// ---------------------------------------------------------------------------

/**
 * Returns the rep name for a given Slack user, or null if unmapped.
 * Mapping is maintained in data/config.json under "slackToRep":
 *   { "U012AB3CD": "Scout Bishop", "U034EF5GH": "Wells Davis" }
 *
 * To find a user's Slack ID: right-click their profile → Copy member ID.
 * No code deploy needed — just edit config.json and restart.
 */
function slackUserToRep(userId, userName, realName) {
  const { slackToRep = {} } = loadConfig();
  if (slackToRep[userId])   return slackToRep[userId];
  if (slackToRep[userName]) return slackToRep[userName];
  if (realName) {
    const norm = s => s.toLowerCase().replace(/[^a-z\s]/g, '').trim();
    const rn   = norm(realName);
    for (const rep of KNOWN_REPS) {
      const rNorm = norm(rep);
      if (rNorm === rn || rn.includes(rNorm) || rNorm.includes(rn)) return rep;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Cache helpers (shares data/cache.json with the CLI)
// ---------------------------------------------------------------------------

const CACHE_PATH = path.join(__dirname, 'data', 'cache.json');

function loadCache() {
  try { return JSON.parse(fs.readFileSync(CACHE_PATH, 'utf8')); } catch { return {}; }
}
function saveCache(c) {
  try { fs.writeFileSync(CACHE_PATH, JSON.stringify(c, null, 2)); } catch {}
}
function cacheKey(q) { return q.toLowerCase().replace(/\s+/g, ' ').trim(); }

// ---------------------------------------------------------------------------
// Config + audit log
// ---------------------------------------------------------------------------

function loadConfig() {
  try {
    return JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'config.json'), 'utf8'));
  } catch { return { repOwnerIds: {} }; }
}

function appendLog(entry) {
  const logPath = path.join(__dirname, 'data', 'log.json');
  let log = [];
  try { log = JSON.parse(fs.readFileSync(logPath, 'utf8')); } catch { log = []; }
  log.push(entry);
  try { fs.writeFileSync(logPath, JSON.stringify(log, null, 2)); } catch {}
}

// ---------------------------------------------------------------------------
// Pending fix state (in-memory, 30-min TTL)
// ---------------------------------------------------------------------------

const pendingFixes = new Map();

function setPendingFix(key, data) {
  pendingFixes.set(key, { ...data, ts: Date.now() });
}
function getPendingFix(key) {
  const e = pendingFixes.get(key);
  if (!e) return null;
  if (Date.now() - e.ts > 30 * 60 * 1000) { pendingFixes.delete(key); return null; }
  return e;
}
function makeFixKey() {
  return `fix_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

// ---------------------------------------------------------------------------
// Display helpers (plain text — no ANSI)
// ---------------------------------------------------------------------------

const RULE_LABELS = {
  TOP_50:           'Top 50 Owner → Jack Harvey',
  LEASE_UP:         'Lease-Up → Xander Williams',
  OWNER_ASSIGNMENT: 'Owner-Level Assignment',
  STATE_FALLBACK:   'State/Regional Fallback',
  UNASSIGNED:       'Unassigned'
};

function humanizeDays(n) {
  if (n === null || n === undefined) return '—';
  if (n === 0)  return 'today';
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

// ---------------------------------------------------------------------------
// Structured logger
// ---------------------------------------------------------------------------

/**
 * Emits a single-line JSON log to stdout. Cloud Run captures stdout as
 * structured Cloud Logging entries, making these queryable in Log Explorer.
 */
function log(event, data = {}) {
  console.log(JSON.stringify({ ts: new Date().toISOString(), event, ...data }));
}

// ---------------------------------------------------------------------------
// Block Kit helpers
// ---------------------------------------------------------------------------

const divider = ()         => ({ type: 'divider' });
const section = text       => ({ type: 'section', text: { type: 'mrkdwn', text } });
const header  = text       => ({ type: 'header',  text: { type: 'plain_text', text, emoji: true } });

// ---------------------------------------------------------------------------
// Argument parser for /check (mirrors cli.js parseArgs)
// ---------------------------------------------------------------------------

function parseCheckText(text) {
  const input = {
    ownerName: null, market: null, ownerHQ: null,
    isLeaseUp: false, propertyClass: null, propertyType: null
  };

  // Tokenise preserving quoted strings
  const tokens     = text.match(/"(?:[^"\\]|\\.)*"|\S+/g) || [];
  const positional = [];

  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i].replace(/^"|"$/g, '');
    if      (t === '--market'   && tokens[i + 1]) { input.market        = tokens[++i].replace(/^"|"$/g, ''); }
    else if (t === '--hq'       && tokens[i + 1]) { input.ownerHQ       = tokens[++i].replace(/^"|"$/g, ''); }
    else if (t === '--lease-up' || t === '--leaseup') { input.isLeaseUp = true; }
    else if (t === '--class'    && tokens[i + 1]) { input.propertyClass = tokens[++i].replace(/^"|"$/g, ''); }
    else if (t === '--type'     && tokens[i + 1]) { input.propertyType  = tokens[++i].replace(/^"|"$/g, ''); }
    else if (!t.startsWith('--'))                 { positional.push(t); }
  }

  input.ownerName = positional.join(' ') || text.trim();
  return input;
}

// ---------------------------------------------------------------------------
// Shared assignment helper — used by check_assign_suggested + check_assign_other
// ---------------------------------------------------------------------------

/**
 * Write the HubSpot owner update + ownership rule, auto-fill any missing
 * city/state with web-discovered values, and append to the audit log.
 *
 * Returns { locationFilled: boolean } for confirmation messaging.
 */
async function performAssignment(fix, targetRep, slackUserName) {
  const { companyId, companyName, rule, workingRep, repOwnerIds,
          webCity, webState, hsCity, hsState } = fix;

  const newOwnerId = repOwnerIds[targetRep] || null;

  // Try to write landing_ownership_rule; fall back silently if the property
  // doesn't exist (missing crm.schemas.companies.write scope on the private app).
  let ruleWritten = true;
  try {
    await ensureOwnershipRuleProperty();
  } catch {
    ruleWritten = false;
  }

  const update = {};
  if (ruleWritten) update.landing_ownership_rule = rule;
  if (newOwnerId)  update.hubspot_owner_id        = newOwnerId;
  // Auto-fill city/state with web-discovered data when the HubSpot record was missing them
  if (!hsCity  && webCity)  update.city  = webCity;
  if (!hsState && webState) update.state = webState;

  await updateCompany(companyId, update);

  const locationFilled = (!hsCity && webCity) || (!hsState && webState);

  appendLog({
    timestamp:      new Date().toISOString(),
    rule:           'OWNER_REASSIGNMENT',
    action:         'accepted',
    source:         'slack /check',
    companyId, companyName,
    from:           workingRep,
    to:             targetRep,
    newOwnerId,
    hsRule:         rule,
    locationFilled: !!locationFilled,
    ruleWritten,
    slackUser:      slackUserName
  });

  return { locationFilled, ruleWritten };
}

/**
 * Build the static_select options list from all reps that have a mapped
 * HubSpot owner ID. Used for "Assign to someone else…" dropdown.
 */
function buildRepOptions(repOwnerIds) {
  return KNOWN_REPS
    .filter(r => repOwnerIds[r])
    .map(r => ({ text: { type: 'plain_text', text: r }, value: r }));
}

// ---------------------------------------------------------------------------
// /check — ownership resolution
// ---------------------------------------------------------------------------

app.command('/check', async ({ command, ack, respond }) => {
  const t0 = Date.now();
  log('cmd_received', { cmd: '/check', user: command.user_name, text: command.text });

  await ack();
  log('ack_sent', { cmd: '/check', ackMs: Date.now() - t0 });

  const text = (command.text || '').trim();
  if (!text) {
    await respond('Usage: `/check [owner or property name]`\nExamples: `/check Greystar` · `/check MAA --market "Dallas TX"` · `/check "Axis 201"`');
    log('respond_sent', { cmd: '/check', ms: Date.now() - t0, result: 'usage' });
    return;
  }

  await respond({ response_type: 'ephemeral', text: `_Resolving ownership for *${text}*…_` });
  log('respond_working', { cmd: '/check', ms: Date.now() - t0 });

  try {
    let input = parseCheckText(text);

    // ── Step 1: Standard enrichment (cache → property-name → HQ search) ────
    const cache = loadCache();
    const key   = cacheKey(input.ownerName);

    if (cache[key]) {
      const c = cache[key];
      if (c.ownerName)                             input.ownerName     = c.ownerName;
      if (c.market        && !input.market)        input.market        = c.market;
      if (c.ownerHQ       && !input.ownerHQ)       input.ownerHQ       = c.ownerHQ;
      if (c.propertyClass && !input.propertyClass) input.propertyClass = c.propertyClass;
    } else if (looksLikePropertyName(input.ownerName)) {
      const enriched = await enrichFromPropertyName(input.ownerName);
      const toCache  = { cachedAt: new Date().toISOString() };
      if (enriched.ownerName)    { input.ownerName    = toCache.ownerName    = enriched.ownerName; }
      if (enriched.market    && !input.market)        { input.market       = toCache.market       = enriched.market; }
      if (enriched.ownerHQ   && !input.ownerHQ)       { input.ownerHQ      = toCache.ownerHQ      = enriched.ownerHQ; }
      if (enriched.propertyClass && !input.propertyClass) { input.propertyClass = toCache.propertyClass = enriched.propertyClass; }
      if (Object.keys(toCache).length > 1) { cache[key] = toCache; saveCache(cache); }
    } else if (!input.ownerHQ && !input.market) {
      const hq = await enrichOwnerHQ(input.ownerName);
      if (hq) {
        input.ownerHQ = hq;
        cache[key] = { ownerHQ: hq, cachedAt: new Date().toISOString() };
        saveCache(cache);
      }
    }

    // ── Qualification gate ───────────────────────────────────────────────────
    const qual = qualify(input);
    if (!qual.qualified) {
      await respond({
        replace_original: true,
        blocks: [
          header('🚫 Lead Disqualified'),
          section(
            `*Query:* ${text}\n\n` +
            qual.reasons.map(r => `✗ ${r}`).join('\n') +
            '\n\nThis property/owner does not meet Class A/B Conventional MF criteria.'
          )
        ]
      });
      return;
    }

    // ── Step 2: Initial resolve ─────────────────────────────────────────────
    let result = resolve(input);

    // ── Step 3: HubSpot record lookup — city/state/owner before web search ──
    let companyId       = null;
    let hubspotLink     = null;
    let currentOwnerName = null;
    let hsCity = null, hsState = null;  // what HubSpot actually has
    let webCity = null, webState = null; // what web search finds (only if HS missing)
    let enrichmentNote  = null;

    try {
      const [hits, portalId, allOwners] = await Promise.all([
        searchCompanyByName(input.ownerName),
        getPortalId(),
        getOwners()
      ]);

      if (hits.length > 0) {
        companyId   = hits[0].id;
        hubspotLink = `https://app.hubspot.com/contacts/${portalId}/company/${companyId}`;

        const company = await getCompany(companyId);
        const p       = company.properties || {};

        hsCity  = p.city  || null;
        hsState = p.state || null;

        // Current HubSpot owner
        if (p.hubspot_owner_id) {
          const o = allOwners.find(o => String(o.id) === String(p.hubspot_owner_id));
          if (o) currentOwnerName = `${o.firstName} ${o.lastName}`.trim();
        }

        // Re-resolve using HubSpot city/state if input was missing location
        const hsMarket = [hsCity, hsState].filter(Boolean).join(' ');
        if (hsMarket && !input.market && !input.ownerHQ) {
          const retried = resolve({ ...input, market: hsMarket });
          if (retried.rule !== 'UNASSIGNED') {
            result = retried;
            input.market = hsMarket;
            enrichmentNote = `📍 Location from HubSpot: *${hsMarket}*`;
          }
        }
      }
    } catch { /* non-fatal — continue without HubSpot data */ }

    // ── Step 4: Web search fallback — only if still UNASSIGNED and HS missing ──
    if (result.rule === 'UNASSIGNED' && !input.market && !input.ownerHQ) {
      try {
        const found = await enrichCompanyLocation(input.ownerName);
        if (found.city || found.state) {
          webCity  = found.city  || null;
          webState = found.state || null;
          const webMarket = [webCity, webState].filter(Boolean).join(' ');
          const retried   = resolve({ ...input, market: webMarket });
          if (retried.rule !== 'UNASSIGNED') {
            result       = retried;
            input.market = webMarket;
            enrichmentNote = `🌐 Location from web search: *${webMarket}*`;
          }
        }
      } catch { /* non-fatal */ }
    }

    // ── Conflict detection ───────────────────────────────────────────────────
    const suggestedReps = (Array.isArray(result.rep) ? result.rep : [result.rep])
      .filter(r => r && r !== 'UNASSIGNED');
    const repDisplay    = suggestedReps.join(' / ') || 'UNASSIGNED';
    const ruleLabel     = RULE_LABELS[result.rule] || result.rule;

    const normStr  = s => (s || '').toLowerCase().replace(/[^a-z\s]/g, '').trim();
    const isConflict = currentOwnerName &&
      suggestedReps.length > 0 &&
      !suggestedReps.some(r => normStr(r) === normStr(currentOwnerName));

    // ── Store pending context (for assignment buttons) ───────────────────────
    const config = loadConfig();
    let checkKey = null;
    if (companyId && suggestedReps.length > 0) {
      checkKey = makeFixKey();
      setPendingFix(checkKey, {
        companyId,
        companyName: input.ownerName,
        link:        hubspotLink,
        suggestedRep: repDisplay,
        rule:         result.rule,
        workingRep:   currentOwnerName || '(unassigned)',
        repOwnerIds:  config.repOwnerIds || {},
        hsCity, hsState,
        webCity, webState
      });
    }

    // ── Build response blocks ─────────────────────────────────────────────────
    const identityLines = [
      `*Query:* ${input.ownerName}`,
      input.market        ? `*Property:* ${input.market}`        : null,
      input.ownerHQ       ? `*Owner HQ:* ${input.ownerHQ}`       : null,
      result.matchedOwner ? `*Matched:* ${result.matchedOwner}`  : null,
      currentOwnerName    ? `*Current HubSpot owner:* ${currentOwnerName}` : null
    ].filter(Boolean).join('\n');

    let statusLine;
    if (result.rule === 'UNASSIGNED') {
      if (!companyId) {
        statusLine = '🔴 *UNASSIGNED* — no HubSpot record found';
      } else if (!input.market && !input.ownerHQ) {
        statusLine = '🔴 *UNASSIGNED* — HubSpot record found but missing city/state';
      } else {
        statusLine = '🔴 *UNASSIGNED* — no rule matched';
      }
    } else if (isConflict) {
      statusLine = `⚠ *Conflict* — currently owned by ${currentOwnerName}`;
    } else {
      statusLine = `✅ *Ownership confirmed*`;
    }

    const blocks = [
      header('📋 Ownership Resolution'),
      section(identityLines),
    ];

    if (enrichmentNote) blocks.push(section(enrichmentNote));

    blocks.push(divider());
    blocks.push(section(
      `${statusLine}\n` +
      `*Rule:* ${ruleLabel}\n` +
      (repDisplay !== 'UNASSIGNED' ? `*Should be:* *${repDisplay}*` : '*Should be:* _(no match found)_')
    ));
    blocks.push(section(`*Why:* ${result.explanation}`));

    const allWarnings = [...qual.flags, ...result.warnings];
    if (allWarnings.length > 0) {
      blocks.push(section(allWarnings.map(w => `⚠ ${w}`).join('\n')));
    }

    if (hubspotLink) blocks.push(section(`*HubSpot:* <${hubspotLink}|View record>`));

    // ── Action buttons ────────────────────────────────────────────────────────
    // Show whenever we found the HubSpot record and have a suggestion or just the dropdown.
    if (companyId) {
      blocks.push(divider());
      const repOptions = buildRepOptions(config.repOwnerIds || {});
      const elements   = [];

      // Primary button — only when a specific rep is suggested
      if (suggestedReps.length > 0 && checkKey) {
        elements.push({
          type:      'button',
          text:      { type: 'plain_text', text: `✅ Assign to ${repDisplay}`, emoji: true },
          style:     'primary',
          action_id: 'check_assign_suggested',
          value:     checkKey
        });
      }

      // "Assign to someone else" dropdown — always shown when record exists
      if (repOptions.length > 0 && checkKey) {
        elements.push({
          type:        'static_select',
          placeholder: { type: 'plain_text', text: suggestedReps.length > 0 ? 'Assign to someone else…' : 'Assign to rep…' },
          action_id:   'check_assign_other',
          options:     repOptions
        });
      }

      if (elements.length > 0) {
        blocks.push({ type: 'actions', block_id: checkKey, elements });
      }
    } else if (result.rule === 'UNASSIGNED') {
      blocks.push(section('_No HubSpot record found — search HubSpot manually to assign._'));
    }

    log('respond_sent', { cmd: '/check', ms: Date.now() - t0, rule: result.rule, rep: repDisplay, conflict: isConflict, companyId });
    await respond({ blocks, replace_original: true });

  } catch (err) {
    log('error', { cmd: '/check', ms: Date.now() - t0, error: err.message });
    await respond({ text: `❌ Error: ${err.message}`, replace_original: true });
  }
});

// ---------------------------------------------------------------------------
// Interactive: /check — Assign to suggested rep
// ---------------------------------------------------------------------------

app.action('check_assign_suggested', async ({ body, ack, respond }) => {
  await ack();

  const checkKey = body.actions[0].value;
  const fix      = getPendingFix(checkKey);
  const today    = new Date().toISOString().slice(0, 10);

  if (!fix) {
    await respond({ text: '❌ This action has expired. Run `/check` again.', replace_original: true });
    return;
  }

  // Pick first rep that has a mapped owner ID
  const reps      = fix.suggestedRep.split(' / ').map(r => r.trim());
  const targetRep = reps.find(r => fix.repOwnerIds[r]) || reps[0];

  try {
    const { locationFilled, ruleWritten } = await performAssignment(fix, targetRep, body.user?.name || body.user?.id);
    pendingFixes.delete(checkKey);

    const notes = [
      locationFilled ? '📍 *Also updated:* city/state filled in from enrichment data.' : null,
      !ruleWritten   ? '⚠ `landing_ownership_rule` not written — add `crm.schemas.companies.write` scope to your HubSpot private app.' : null
    ].filter(Boolean).join('\n');

    await respond({
      replace_original: true,
      blocks: [
        header('✅ Ownership Assigned'),
        section(
          `*Company:* <${fix.link}|${fix.companyName}>\n` +
          `*Assigned to:* *${targetRep}*\n` +
          (ruleWritten ? `*Rule written:* \`${fix.rule}\`\n` : '') +
          `*By:* ${body.user?.name || 'Unknown'} on ${today}`
        ),
        ...(notes ? [section(notes)] : [])
      ]
    });
  } catch (err) {
    await respond({ text: `❌ Failed to update HubSpot: ${err.message}`, replace_original: true });
  }
});

// ---------------------------------------------------------------------------
// Interactive: /check — Assign to someone else (dropdown)
// ---------------------------------------------------------------------------

app.action('check_assign_other', async ({ body, ack, respond }) => {
  await ack();

  const checkKey  = body.actions[0].block_id;
  const targetRep = body.actions[0].selected_option?.value;
  const fix       = getPendingFix(checkKey);
  const today     = new Date().toISOString().slice(0, 10);

  if (!fix || !targetRep) {
    await respond({ text: '❌ This action has expired or had no selection. Run `/check` again.', replace_original: true });
    return;
  }

  try {
    const { locationFilled, ruleWritten } = await performAssignment(fix, targetRep, body.user?.name || body.user?.id);
    pendingFixes.delete(checkKey);

    const notes = [
      locationFilled ? '📍 *Also updated:* city/state filled in from enrichment data.' : null,
      !ruleWritten   ? '⚠ `landing_ownership_rule` not written — add `crm.schemas.companies.write` scope to your HubSpot private app.' : null
    ].filter(Boolean).join('\n');

    await respond({
      replace_original: true,
      blocks: [
        header('✅ Ownership Assigned'),
        section(
          `*Company:* <${fix.link}|${fix.companyName}>\n` +
          `*Assigned to:* *${targetRep}*\n` +
          (ruleWritten ? `*Rule written:* \`${fix.rule}\`\n` : '') +
          `*By:* ${body.user?.name || 'Unknown'} on ${today}`
        ),
        ...(notes ? [section(notes)] : [])
      ]
    });
  } catch (err) {
    await respond({ text: `❌ Failed to update HubSpot: ${err.message}`, replace_original: true });
  }
});

// ---------------------------------------------------------------------------
// /audit-me — run audit for the calling user's rep
// ---------------------------------------------------------------------------

app.command('/audit-me', async ({ command, ack, respond, client }) => {
  const t0 = Date.now();
  log('cmd_received', { cmd: '/audit-me', user: command.user_name });

  await ack();
  log('ack_sent', { cmd: '/audit-me', ackMs: Date.now() - t0 });

  // Resolve Slack user → rep name
  let repName = null;
  try {
    const info  = await client.users.info({ user: command.user_id });
    const real  = info.user?.profile?.real_name || info.user?.real_name || '';
    repName     = slackUserToRep(command.user_id, command.user_name, real);
  } catch {
    repName = slackUserToRep(command.user_id, command.user_name, null);
  }

  if (!repName) {
    await respond(
      `❌ Your Slack account isn't mapped to a rep yet.\n\n` +
      `Send your Slack user ID to *Matt Pears* and he'll add you.\n` +
      `Your user ID: \`${command.user_id}\``
    );
    log('respond_sent', { cmd: '/audit-me', ms: Date.now() - t0, result: 'no_rep_mapping', userId: command.user_id });
    return;
  }

  await respond({ response_type: 'ephemeral', text: `_Running audit for *${repName}*… (this may take 30–60 seconds)_` });
  log('respond_working', { cmd: '/audit-me', ms: Date.now() - t0, rep: repName });

  try {
    await ensureOwnershipRuleProperty();
    const result = await auditRep(repName, { daysBack: 90, qualifiedOnly: false });

    if (result.error) {
      log('error', { cmd: '/audit-me', ms: Date.now() - t0, rep: repName, error: result.error });
      await respond({ text: `❌ ${result.error}`, replace_original: true });
      return;
    }

    const { conflicts, companies, excluded, hubspotOwner, daysBack } = result;
    const ownerLabel = hubspotOwner
      ? `${hubspotOwner.firstName} ${hubspotOwner.lastName}`
      : repName;

    const blocks = [
      header(`📊 Audit — ${ownerLabel}`),
      section(
        `*Lookback:* Last ${daysBack} days\n` +
        `*Companies hit:* ${companies.length}` + (excluded > 0 ? ` _(${excluded} vendors excluded)_` : '') + '\n' +
        `*Conflicts:* ${conflicts.length > 0 ? `*${conflicts.length}* ⚠` : '✅ 0'}`
      )
    ];

    if (conflicts.length === 0) {
      blocks.push(section('✅ No conflicts — you are correctly assigned on all active accounts.'));
    } else {
      blocks.push(divider());
      for (const c of conflicts) {
        const recency   = humanizeDays(c.daysSince);
        const badge     = qualBadge(c.qualStatus);
        const ruleLabel = RULE_LABELS[c.rule] || c.rule;
        const actLabel  = `${c.activities} activit${c.activities !== 1 ? 'ies' : 'y'}`;
        blocks.push(section(
          `*${c.companyName}* ${badge}\n` +
          `<${c.link}|View in HubSpot>   ·   *Market:* ${c.market}   ·   *Last activity:* ${recency} _(${actLabel})_\n` +
          `*Working it:* ${c.workingRep}   →   *Should be:* *${c.expectedRep}*\n` +
          `*Rule:* ${ruleLabel}`
        ));
        blocks.push(divider());
      }
      blocks.push(section('_Use `/fix [HubSpot record ID]` to reassign individual records._'));
    }

    log('respond_sent', { cmd: '/audit-me', ms: Date.now() - t0, rep: repName, companies: companies.length, conflicts: conflicts.length });
    await respond({ blocks, replace_original: true });

  } catch (err) {
    log('error', { cmd: '/audit-me', ms: Date.now() - t0, rep: repName, error: err.message });
    await respond({ text: `❌ Audit failed: ${err.message}`, replace_original: true });
  }
});

// ---------------------------------------------------------------------------
// /fix — resolve and present Approve/Decline for a specific company
// ---------------------------------------------------------------------------

app.command('/fix', async ({ command, ack, respond }) => {
  const t0 = Date.now();
  log('cmd_received', { cmd: '/fix', user: command.user_name, text: command.text });

  await ack();
  log('ack_sent', { cmd: '/fix', ackMs: Date.now() - t0 });

  const text = (command.text || '').trim();
  if (!text) {
    await respond('Usage: `/fix [HubSpot record ID]` or `/fix [company name]`\nExample: `/fix 8924545632`');
    log('respond_sent', { cmd: '/fix', ms: Date.now() - t0, result: 'usage' });
    return;
  }

  await respond({ response_type: 'ephemeral', text: `_Looking up *${text}*…_` });
  log('respond_working', { cmd: '/fix', ms: Date.now() - t0 });

  try {
    await ensureOwnershipRuleProperty();
    const [allOwners, portalId] = await Promise.all([getOwners(), getPortalId()]);

    // ── Resolve company record ──────────────────────────────────────────────
    let company, companyId;
    const isId = /^\d+$/.test(text);
    if (isId) {
      company   = await getCompany(text);
      companyId = text;
    } else {
      const hits = await searchCompanyByName(text);
      if (!hits.length) {
        await respond({ text: `❌ No HubSpot company found matching "${text}".`, replace_original: true });
        return;
      }
      companyId = hits[0].id;
      company   = await getCompany(companyId); // full property set
    }

    const props  = company.properties || {};
    const coName = props.name || `(ID: ${companyId})`;
    const market = [props.city, props.state].filter(Boolean).join(' ') || null;
    const hsLink = `https://app.hubspot.com/contacts/${portalId}/company/${companyId}`;

    // ── Current HubSpot owner ───────────────────────────────────────────────
    const currentOwner = props.hubspot_owner_id
      ? allOwners.find(o => String(o.id) === String(props.hubspot_owner_id))
      : null;
    const currentOwnerName = currentOwner
      ? `${currentOwner.firstName} ${currentOwner.lastName}`.trim()
      : '(unassigned)';

    // ── Ownership resolution ────────────────────────────────────────────────
    const resolution = resolve({ ownerName: coName, market, isLeaseUp: false });
    const expectedRep = Array.isArray(resolution.rep)
      ? resolution.rep.join(' / ')
      : (resolution.rep || 'UNASSIGNED');
    const ruleLabel  = RULE_LABELS[resolution.rule] || resolution.rule;

    // ── Web enrichment for missing location ─────────────────────────────────
    let locationNote = null;
    if (!props.city || !props.state) {
      try {
        const found = await enrichCompanyLocation(coName);
        if (found.city || found.state) {
          locationNote = [found.city, found.state].filter(Boolean).join(', ');
        }
      } catch { /* non-fatal */ }
    }

    // ── Conflict check ───────────────────────────────────────────────────────
    const isConflict = expectedRep !== 'UNASSIGNED' &&
      expectedRep.toLowerCase() !== currentOwnerName.toLowerCase();

    // ── Store pending context ────────────────────────────────────────────────
    const config = loadConfig();
    const fixKey = makeFixKey();
    setPendingFix(fixKey, {
      companyId, companyName: coName, link: hsLink,
      expectedRep, rule: resolution.rule,
      workingRep: currentOwnerName,
      repOwnerIds: config.repOwnerIds || {}
    });

    // ── Build blocks ─────────────────────────────────────────────────────────
    const blocks = [
      header('🔧 Fix — Ownership Resolution'),
      section(
        `*Company:* <${hsLink}|${coName}>\n` +
        `*Market:* ${market || '_(missing — no city/state in HubSpot)_'}\n` +
        `*Current owner:* ${currentOwnerName}`
      ),
      divider(),
      section(
        `${isConflict ? '⚠ *Conflict detected*' : '✅ Ownership looks correct'}\n` +
        `*Should be:* *${expectedRep}*\n` +
        `*Rule:* ${ruleLabel}\n` +
        `*Explanation:* ${resolution.explanation}`
      )
    ];

    if (locationNote) {
      blocks.push(section(`📍 Web search found location: *${locationNote}*\nVerify this is correct before approving.`));
    }

    if (resolution.warnings.length > 0) {
      blocks.push(section(resolution.warnings.map(w => `⚠ ${w}`).join('\n')));
    }

    if (expectedRep !== 'UNASSIGNED') {
      blocks.push(divider());
      blocks.push({
        type: 'actions',
        block_id: fixKey,
        elements: [
          {
            type:      'button',
            text:      { type: 'plain_text', text: `✅ Approve — Assign to ${expectedRep}`, emoji: true },
            style:     'primary',
            action_id: 'fix_approve',
            value:     fixKey
          },
          {
            type:      'button',
            text:      { type: 'plain_text', text: '❌ Decline', emoji: true },
            style:     'danger',
            action_id: 'fix_decline',
            value:     fixKey
          }
        ]
      });
    }

    log('respond_sent', { cmd: '/fix', ms: Date.now() - t0, companyId, rule: resolution.rule, expectedRep, conflict: isConflict });
    await respond({ blocks, replace_original: true });

  } catch (err) {
    log('error', { cmd: '/fix', ms: Date.now() - t0, error: err.message });
    await respond({ text: `❌ Error: ${err.message}`, replace_original: true });
  }
});

// ---------------------------------------------------------------------------
// Interactive: Approve button
// ---------------------------------------------------------------------------

app.action('fix_approve', async ({ body, ack, respond }) => {
  await ack();

  const fixKey = body.actions[0].value;
  const fix    = getPendingFix(fixKey);
  const today  = new Date().toISOString().slice(0, 10);

  if (!fix) {
    await respond({ text: '❌ This action has expired or was already handled. Run `/fix` again.', replace_original: true });
    return;
  }

  const { companyId, companyName, link, expectedRep, rule, repOwnerIds, workingRep } = fix;

  // If multiple reps, pick the first one that has a mapped HubSpot owner ID
  const reps       = expectedRep.split(' / ').map(r => r.trim());
  const targetRep  = reps.find(r => repOwnerIds[r]) || reps[0];
  const newOwnerId = repOwnerIds[targetRep] || null;

  try {
    let ruleWritten = true;
    try { await ensureOwnershipRuleProperty(); } catch { ruleWritten = false; }

    const update = {};
    if (ruleWritten) update.landing_ownership_rule = rule;
    if (newOwnerId)  update.hubspot_owner_id        = newOwnerId;
    await updateCompany(companyId, update);

    appendLog({
      timestamp: new Date().toISOString(),
      rule:      'OWNER_REASSIGNMENT',
      action:    'accepted',
      source:    'slack /fix',
      companyId, companyName,
      from:      workingRep,
      to:        targetRep,
      newOwnerId,
      hsRule:    rule,
      ruleWritten,
      slackUser: body.user?.name || body.user?.id
    });

    pendingFixes.delete(fixKey);

    const ruleNote = !ruleWritten
      ? '\n⚠ `landing_ownership_rule` not written — add `crm.schemas.companies.write` scope to your HubSpot private app.'
      : '';

    await respond({
      replace_original: true,
      blocks: [
        header('✅ Ownership Updated'),
        section(
          `*Company:* <${link}|${companyName}>\n` +
          `*Assigned to:* *${targetRep}*\n` +
          (ruleWritten ? `*Rule written:* \`${rule}\`\n` : '') +
          `*Updated by:* ${body.user?.name || 'Unknown'} on ${today}` +
          ruleNote
        )
      ]
    });

  } catch (err) {
    await respond({ text: `❌ Failed to update HubSpot: ${err.message}`, replace_original: true });
  }
});

// ---------------------------------------------------------------------------
// Interactive: Decline button
// ---------------------------------------------------------------------------

app.action('fix_decline', async ({ body, ack, respond }) => {
  await ack();

  const fixKey = body.actions[0].value;
  const fix    = getPendingFix(fixKey);
  const today  = new Date().toISOString().slice(0, 10);

  if (!fix) {
    await respond({ text: '❌ This action has expired or was already handled. Run `/fix` again.', replace_original: true });
    return;
  }

  const { companyId, companyName, link, expectedRep, rule, workingRep } = fix;
  const ruleValue = `EXCEPTION — ${rule} declined by ${body.user?.name || 'user'} on ${today}`;

  try {
    let ruleWritten = true;
    try { await ensureOwnershipRuleProperty(); } catch { ruleWritten = false; }
    if (ruleWritten) await updateCompany(companyId, { landing_ownership_rule: ruleValue });

    appendLog({
      timestamp: new Date().toISOString(),
      rule:      'OWNER_REASSIGNMENT',
      action:    'declined',
      source:    'slack /fix',
      companyId, companyName,
      from:      workingRep,
      to:        expectedRep,
      hsRule:    rule,
      slackUser: body.user?.name || body.user?.id
    });

    pendingFixes.delete(fixKey);

    await respond({
      replace_original: true,
      blocks: [
        header('⏭ Assignment Declined'),
        section(
          `*Company:* <${link}|${companyName}>\n` +
          `*Declined by:* ${body.user?.name || 'Unknown'} on ${today}\n` +
          `*Rule written:* \`${ruleValue}\``
        )
      ]
    });

  } catch (err) {
    await respond({ text: `❌ Failed to write exception: ${err.message}`, replace_original: true });
  }
});

// ---------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------

// Prevent unhandled promise rejections from crashing the process.
// Bolt's action/command handlers are all wrapped in try/catch, but Belt itself
// may surface unexpected rejections (e.g. network blips in respond()).
process.on('unhandledRejection', (reason) => {
  console.error('[unhandledRejection]', reason);
});

(async () => {
  try { await ensureOwnershipRuleProperty(); } catch { /* non-fatal */ }

  const port = parseInt(process.env.PORT || '3000', 10);

  if (process.env.SLACK_APP_TOKEN) {
    // Socket Mode — no public URL needed; ideal for local dev
    await app.start();
    console.log('⚡ Slack bot running in Socket Mode');
  } else {
    // HTTP Mode — for Cloud Run and any reverse-proxied deployment
    await app.start(port);
    console.log(`⚡ Slack bot listening on port ${port}`);
  }
})();
