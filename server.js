'use strict';

/**
 * server.js — Slack Bot MVP (Phase 3)
 *
 * Slash commands:
 *   /check [owner or property name or email]  — full ownership resolution pipeline
 *   /audit [rep name] [days]                  — conflict audit for a rep (default: calling user, 90 days)
 *   /lookup [name or email or record ID]      — lightweight HubSpot record search (deals, companies, contacts)
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
  getDeal,
  getContact,
  updateCompany,
  ensureOwnershipRuleProperty,
  searchCompanyByName,
  searchDealsByName,
  searchContacts,
  searchCompanyByDomain,
  getDealStageLabels,
  getAssociatedCompanyIds
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

// Prevent crashes from transient Socket Mode reconnection errors or
// network blips in Bolt's respond() calls.
process.on('unhandledRejection', (err) => {
  console.error('[unhandledRejection]', err?.message || err);
});

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
    let emailContact = null;  // populated if input is an email address
    let emailNote    = null;

    // ── Step 0: Email detection — extract domain, find company + contact ───
    const emailMatch = input.ownerName.match(/^([^\s@]+@([^\s@]+\.[^\s@]+))$/i);
    if (emailMatch) {
      const email  = emailMatch[1];
      const domain = emailMatch[2];

      // Search for contact and company in parallel
      const [contacts, companies] = await Promise.all([
        searchContacts(email).catch(() => []),
        searchCompanyByDomain(domain).catch(() => [])
      ]);

      if (contacts.length) {
        const ctp = contacts[0].properties || {};
        emailContact = {
          id:    contacts[0].id,
          name:  [ctp.firstname, ctp.lastname].filter(Boolean).join(' ') || email,
          email: ctp.email || email,
          owner: ctp.hubspot_owner_id || null
        };
      }

      if (companies.length) {
        const cp = companies[0].properties || {};
        input.ownerName = cp.name || domain;
        if (cp.city && !input.market)  input.market = [cp.city, cp.state].filter(Boolean).join(' ');
        if (cp.state && !input.ownerHQ) input.ownerHQ = cp.state;
        emailNote = `📧 Email lookup: *${email}* → company *${input.ownerName}*`;
      } else {
        // No company found for domain — use domain as owner name
        input.ownerName = domain;
        emailNote = `📧 Email lookup: *${email}* — no company found for domain \`${domain}\``;
      }
    }

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
    let hsDomain = null;               // domain from HubSpot (for better web search)
    let webCity = null, webState = null; // what web search finds (only if HS missing)
    let enrichmentNote  = null;

    try {
      const [hits, portalId, allOwners] = await Promise.all([
        searchCompanyByName(input.ownerName),
        getPortalId(),
        getOwners()
      ]);

      // Resolve contact owner name + link now that we have portalId/allOwners
      if (emailContact) {
        emailContact.link = `https://app.hubspot.com/contacts/${portalId}/contact/${emailContact.id}`;
        if (emailContact.owner) {
          const co = allOwners.find(o => String(o.id) === String(emailContact.owner));
          if (co) emailContact.ownerName = `${co.firstName} ${co.lastName}`.trim();
        }
      }

      if (hits.length > 0) {
        companyId   = hits[0].id;
        hubspotLink = `https://app.hubspot.com/contacts/${portalId}/company/${companyId}`;

        const company = await getCompany(companyId);
        const p       = company.properties || {};

        hsCity  = p.city  || null;
        hsState = p.state || null;
        hsDomain = p.domain || null;

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

    // ── Step 4: Web search fallback — fires when resolution failed or HS missing location
    const needsWebSearch =
      (result.rule === 'UNASSIGNED') ||
      (companyId && (!hsCity || !hsState));

    if (needsWebSearch) {
      try {
        const found = await enrichCompanyLocation(input.ownerName, hsDomain);
        if (found.city || found.state) {
          webCity  = found.city  || null;
          webState = found.state || null;
          const webMarket = [webCity, webState].filter(Boolean).join(' ');
          if (result.rule === 'UNASSIGNED') {
            const retried = resolve({ ...input, market: webMarket });
            if (retried.rule !== 'UNASSIGNED') {
              result       = retried;
              input.market = webMarket;
              enrichmentNote = `🌐 Location from web search: *${webMarket}*`;
            }
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

    // ── Store pending context (for assignment + enrichment buttons) ──────────
    const config = loadConfig();
    let checkKey = null;
    if (companyId) {
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
      emailMatch          ? `*Query:* ${text}` : null,
      emailContact        ? `*Contact:* ${emailContact.link ? `<${emailContact.link}|${emailContact.name}>` : emailContact.name} (${emailContact.email})${emailContact.ownerName ? ` — owner: ${emailContact.ownerName}` : ''}` : null,
      `*${emailMatch ? 'Company' : 'Query'}:* ${input.ownerName}`,
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

    if (emailNote)      blocks.push(section(emailNote));
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

    // ── Enrichment button — offer to fill missing city/state from web search ──
    const canEnrichLocation = companyId && checkKey &&
      (webCity || webState) && (!hsCity || !hsState);
    if (canEnrichLocation) {
      const locationLabel = [webCity, webState].filter(Boolean).join(', ');
      const enrichKey = `enrich_${checkKey}`;
      setPendingFix(enrichKey, { companyId, companyName: input.ownerName, link: hubspotLink, webCity, webState });
      blocks.push(divider());
      blocks.push(section(`📍 HubSpot is missing city/state. Web search found: *${locationLabel}*`));
      blocks.push({
        type: 'actions',
        block_id: enrichKey,
        elements: [
          {
            type: 'button',
            text: { type: 'plain_text', text: '✅ Update record', emoji: true },
            style: 'primary',
            action_id: 'check_enrich_yes',
            value: enrichKey
          },
          {
            type: 'button',
            text: { type: 'plain_text', text: '❌ No', emoji: true },
            action_id: 'check_enrich_no',
            value: enrichKey
          }
        ]
      });
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
// Interactive: /check — Update city/state from web search
// ---------------------------------------------------------------------------

app.action('check_enrich_yes', async ({ body, ack, respond }) => {
  await ack();

  const enrichKey = body.actions[0].value;
  const fix       = getPendingFix(enrichKey);

  if (!fix) {
    await respond({ text: '❌ This action has expired. Run `/check` again.', replace_original: false });
    return;
  }

  const { companyId, companyName, link, webCity, webState } = fix;
  const update = {};
  if (webCity)  update.city  = webCity;
  if (webState) update.state = webState;

  try {
    await updateCompany(companyId, update);
    pendingFixes.delete(enrichKey);

    const locationLabel = [webCity, webState].filter(Boolean).join(', ');
    appendLog({
      timestamp: new Date().toISOString(),
      rule: 'ENRICH_LOCATION',
      action: 'accepted',
      source: 'slack /check',
      companyId, companyName,
      city: webCity, state: webState,
      slackUser: body.user?.name || body.user?.id
    });

    await respond({
      replace_original: false,
      text: `📍 Updated *<${link}|${companyName}>* — city/state set to *${locationLabel}*.`
    });
  } catch (err) {
    await respond({ text: `❌ Failed to update HubSpot: ${err.message}`, replace_original: false });
  }
});

app.action('check_enrich_no', async ({ body, ack, respond }) => {
  await ack();
  const enrichKey = body.actions[0].value;
  pendingFixes.delete(enrichKey);
  await respond({ replace_original: false, text: '📍 Skipped — city/state not updated.' });
});

// ---------------------------------------------------------------------------
// /audit-me — run audit for the calling user's rep
// ---------------------------------------------------------------------------

app.command('/audit', async ({ command, ack, respond, client }) => {
  const t0 = Date.now();
  const text = (command.text || '').trim();
  log('cmd_received', { cmd: '/audit', user: command.user_name, text });

  await ack();
  log('ack_sent', { cmd: '/audit', ackMs: Date.now() - t0 });

  // Parse optional days argument: "/audit scout 30", "/audit scout last 30 days", "/audit 30"
  let daysBack = 90;
  const daysMatch = text.match(/(?:\b(?:last|past)\s+)?(\d+)\s*(?:days?)?\s*$/i);
  const nameText = daysMatch ? text.slice(0, daysMatch.index).trim() : text;
  if (daysMatch) daysBack = Math.max(1, Math.min(365, parseInt(daysMatch[1], 10)));

  // If no name provided, resolve from Slack user identity
  let repName = null;
  if (nameText) {
    const needle = nameText.toLowerCase();
    repName = KNOWN_REPS.find(r => r.toLowerCase() === needle)
      || KNOWN_REPS.find(r => r.toLowerCase().includes(needle));
    if (!repName) {
      await respond(
        `❌ No rep found matching "${nameText}".\n\n` +
        '*Available reps:* ' + KNOWN_REPS.join(', ')
      );
      log('respond_sent', { cmd: '/audit', ms: Date.now() - t0, result: 'no_match', query: nameText });
      return;
    }
  } else {
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
        `Type \`/audit [rep name]\` to audit a specific rep, or send your Slack user ID to *Matt Pears* to get mapped.\n` +
        `Your user ID: \`${command.user_id}\`\n\n` +
        '*Available reps:* ' + KNOWN_REPS.join(', ')
      );
      log('respond_sent', { cmd: '/audit', ms: Date.now() - t0, result: 'no_rep_mapping', userId: command.user_id });
      return;
    }
  }

  await respond({ response_type: 'ephemeral', text: `_Running audit for *${repName}*… (this may take 30–60 seconds)_` });
  log('respond_working', { cmd: '/audit', ms: Date.now() - t0, rep: repName });

  try {
    await ensureOwnershipRuleProperty();
    const result = await auditRep(repName, { daysBack, qualifiedOnly: false });

    if (result.error) {
      log('error', { cmd: '/audit', ms: Date.now() - t0, rep: repName, error: result.error });
      await respond({ text: `❌ ${result.error}`, replace_original: true });
      return;
    }

    const { conflicts, companies, excluded, hubspotOwner, daysBack: resultDays, summary, stageAverages, stageOrder } = result;
    const ownerLabel = hubspotOwner
      ? `${hubspotOwner.firstName} ${hubspotOwner.lastName}`
      : repName;

    // ── Activity summary line ──────────────────────────────────────────────
    const actParts = [];
    if (summary.deals)    actParts.push(`${summary.deals} deal${summary.deals !== 1 ? 's' : ''}`);
    if (summary.emails)   actParts.push(`${summary.emails} email${summary.emails !== 1 ? 's' : ''}`);
    if (summary.calls)    actParts.push(`${summary.calls} call${summary.calls !== 1 ? 's' : ''}`);
    if (summary.meetings) actParts.push(`${summary.meetings} meeting${summary.meetings !== 1 ? 's' : ''}`);
    if (summary.tasks)    actParts.push(`${summary.tasks} task${summary.tasks !== 1 ? 's' : ''}`);
    const actLine = actParts.length > 0
      ? actParts.join(', ') + ` — *${summary.totalActivities} total activities*`
      : 'No activity found';

    // ── Per-stage avg touchpoints (sorted by pipeline order) ───────────────
    const stageLines = Object.entries(stageAverages || {})
      .sort((a, b) => {
        const oA = stageOrder[a[0]] ?? 999;
        const oB = stageOrder[b[0]] ?? 999;
        return oA - oB;
      })
      .map(([stage, s]) => `  • ${stage}: ${s.deals} deal${s.deals !== 1 ? 's' : ''}, ~${s.avgTouchpoints} touches/deal`);

    const blocks = [
      header(`📊 Audit — ${ownerLabel}`),
      section(
        `*Lookback:* Last ${daysBack} days\n` +
        `*Companies hit:* ${companies.length}` + (excluded > 0 ? ` _(${excluded} vendors excluded)_` : '') + '\n' +
        `*Conflicts:* ${conflicts.length > 0 ? `*${conflicts.length}* ⚠` : '✅ 0'}`
      ),
      divider(),
      section(`*Activity Overview*\n${actLine}`),
    ];

    if (stageLines.length > 0) {
      blocks.push(section(`*Avg Touchpoints by Deal Stage*\n${stageLines.join('\n')}`));
    }

    blocks.push(divider());

    const config = loadConfig();

    if (conflicts.length === 0) {
      blocks.push(section(`✅ No conflicts — ${repName} is correctly assigned on all active accounts.`));
    } else {
      // Slack limits messages to 50 blocks — each conflict uses 2 blocks (section + actions)
      // Header/summary uses ~7 blocks, so we can show ~14 conflicts with inline buttons
      const MAX_SHOWN = 14;
      const shown = conflicts.slice(0, MAX_SHOWN);
      const remaining = conflicts.length - shown.length;

      for (const c of shown) {
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

        // Inline assign button for this conflict
        const fixKey = makeFixKey();
        setPendingFix(fixKey, {
          companyId:    c.companyId,
          companyName:  c.companyName,
          link:         c.link,
          suggestedRep: c.expectedRep,
          rule:         c.rule,
          workingRep:   c.workingRep,
          repOwnerIds:  config.repOwnerIds || {},
        });
        const repOptions = buildRepOptions(config.repOwnerIds || {});
        const actionElements = [
          {
            type:      'button',
            text:      { type: 'plain_text', text: `✅ Assign → ${c.expectedRep}`, emoji: true },
            style:     'primary',
            action_id: 'check_assign_suggested',
            value:     fixKey
          }
        ];
        if (repOptions.length > 0) {
          actionElements.push({
            type:        'static_select',
            placeholder: { type: 'plain_text', text: 'Assign to someone else…' },
            action_id:   'check_assign_other',
            options:     repOptions
          });
        }
        blocks.push({
          type: 'actions',
          block_id: fixKey,
          elements: actionElements
        });
      }
      if (remaining > 0) {
        blocks.push(divider());
        blocks.push(section(`_…and ${remaining} more conflicts not shown. Use the CLI for the full list:_\n\`node src/cli.js audit "${repName}"\``));
      }
    }

    log('respond_sent', { cmd: '/audit', ms: Date.now() - t0, rep: repName, companies: companies.length, conflicts: conflicts.length });
    await respond({ blocks, replace_original: true });

  } catch (err) {
    log('error', { cmd: '/audit', ms: Date.now() - t0, rep: repName, error: err.message });
    await respond({ text: `❌ Audit failed: ${err.message}`, replace_original: true });
  }
});

// ---------------------------------------------------------------------------
// /lookup — lightweight HubSpot record lookup (deal, company, or contact)
// ---------------------------------------------------------------------------

app.command('/lookup', async ({ command, ack, respond }) => {
  const t0 = Date.now();
  log('cmd_received', { cmd: '/lookup', user: command.user_name, text: command.text });

  await ack();
  log('ack_sent', { cmd: '/lookup', ackMs: Date.now() - t0 });

  const text = (command.text || '').trim();
  if (!text) {
    await respond(
      'Usage: `/lookup [name, email, or record ID]`\n' +
      'Searches HubSpot deals, companies, and contacts.\n' +
      'Examples: `/lookup 8924545632` · `/lookup Greystar` · `/lookup john@example.com`'
    );
    log('respond_sent', { cmd: '/lookup', ms: Date.now() - t0, result: 'usage' });
    return;
  }

  await respond({ response_type: 'ephemeral', text: `_Looking up *${text}*…_` });
  log('respond_working', { cmd: '/lookup', ms: Date.now() - t0 });

  try {
    const [allOwners, portalId] = await Promise.all([getOwners(), getPortalId()]);
    const ownerName = (id) => {
      if (!id) return '_(unassigned)_';
      const o = allOwners.find(o => String(o.id) === String(id));
      return o ? `${o.firstName} ${o.lastName}`.trim() : `Owner ID: ${id}`;
    };

    const isId = /^\d+$/.test(text);
    const blocks = [];

    if (isId) {
      // Try deal first, then company, then contact
      let found = false;

      // ── Try as Deal ──────────────────────────────────────────────────────
      try {
        const deal = await getDeal(text);
        const dp = deal.properties || {};
        const stageLabels = await getDealStageLabels();
        const stageLabel = stageLabels[dp.dealstage] || dp.dealstage || '—';
        const lastMod = dp.hs_lastmodifieddate ? new Date(dp.hs_lastmodifieddate) : null;
        const lastModStr = lastMod ? `${humanizeDays(Math.floor((Date.now() - lastMod.getTime()) / 86400000))} _(${lastMod.toLocaleDateString()})_` : '—';
        const hsLink = `https://app.hubspot.com/contacts/${portalId}/deal/${text}`;

        // Get associated company
        const assocCompanies = await getAssociatedCompanyIds('deals', [text]);
        let companyLine = '';
        if (assocCompanies[text]?.length) {
          const companyId = assocCompanies[text][0];
          try {
            const co = await getCompany(companyId);
            const coLink = `https://app.hubspot.com/contacts/${portalId}/company/${companyId}`;
            companyLine = `\n*Company:* <${coLink}|${co.properties?.name || companyId}>`;
          } catch { companyLine = `\n*Company ID:* ${companyId}`; }
        }

        blocks.push(
          header('🔍 Deal Lookup'),
          section(
            `*Deal:* <${hsLink}|${dp.dealname || '(unnamed)'}>\n` +
            `*Stage:* ${stageLabel}\n` +
            `*Owner:* ${ownerName(dp.hubspot_owner_id)}\n` +
            `*Last activity:* ${lastModStr}\n` +
            `*Amount:* ${dp.amount ? `$${Number(dp.amount).toLocaleString()}` : '—'}` +
            companyLine
          )
        );
        found = true;
      } catch { /* not a deal */ }

      // ── Try as Company ───────────────────────────────────────────────────
      if (!found) {
        try {
          const company = await getCompany(text);
          const cp = company.properties || {};
          const market = [cp.city, cp.state].filter(Boolean).join(', ') || '—';
          const hsLink = `https://app.hubspot.com/contacts/${portalId}/company/${text}`;

          blocks.push(
            header('🔍 Company Lookup'),
            section(
              `*Company:* <${hsLink}|${cp.name || '(unnamed)'}>\n` +
              `*Market:* ${market}\n` +
              `*Industry:* ${cp.industry || '—'}\n` +
              `*Domain:* ${cp.domain || '—'}\n` +
              `*Owner:* ${ownerName(cp.hubspot_owner_id)}`
            )
          );
          found = true;
        } catch { /* not a company */ }
      }

      // ── Try as Contact ───────────────────────────────────────────────────
      if (!found) {
        try {
          const contact = await getContact(text);
          const ctp = contact.properties || {};
          const name = [ctp.firstname, ctp.lastname].filter(Boolean).join(' ') || '(unnamed)';
          const lastMod = ctp.lastmodifieddate ? new Date(ctp.lastmodifieddate) : null;
          const lastModStr = lastMod ? `${humanizeDays(Math.floor((Date.now() - lastMod.getTime()) / 86400000))} _(${lastMod.toLocaleDateString()})_` : '—';
          const hsLink = `https://app.hubspot.com/contacts/${portalId}/contact/${text}`;

          blocks.push(
            header('🔍 Contact Lookup'),
            section(
              `*Contact:* <${hsLink}|${name}>\n` +
              `*Email:* ${ctp.email || '—'}\n` +
              `*Phone:* ${ctp.phone || '—'}\n` +
              `*Lifecycle:* ${ctp.lifecyclestage || '—'}\n` +
              `*Lead status:* ${ctp.hs_lead_status || '—'}\n` +
              `*Owner:* ${ownerName(ctp.hubspot_owner_id)}\n` +
              `*Last activity:* ${lastModStr}`
            )
          );
          found = true;
        } catch { /* not a contact */ }
      }

      if (!found) {
        await respond({ text: `❌ No deal, company, or contact found with ID \`${text}\`.`, replace_original: true });
        return;
      }

    } else {
      // ── Name/email search → search companies, deals, and contacts ──────
      const stageLabels = await getDealStageLabels();
      const [companyHits, dealHits, contactHits] = await Promise.all([
        searchCompanyByName(text).catch(() => []),
        searchDealsByName(text).catch(() => []),
        searchContacts(text).catch(() => [])
      ]);

      if (!companyHits.length && !dealHits.length && !contactHits.length) {
        await respond({ text: `❌ No results found for "${text}" in companies, deals, or contacts.`, replace_original: true });
        return;
      }

      blocks.push(header(`🔍 Results for "${text}"`));

      // Show matching deals
      for (const deal of dealHits.slice(0, 3)) {
        const dp = deal.properties || {};
        const stageLabel = stageLabels[dp.dealstage] || dp.dealstage || '—';
        const lastMod = dp.hs_lastmodifieddate ? new Date(dp.hs_lastmodifieddate) : null;
        const lastModStr = lastMod ? humanizeDays(Math.floor((Date.now() - lastMod.getTime()) / 86400000)) : '—';
        const hsLink = `https://app.hubspot.com/contacts/${portalId}/deal/${deal.id}`;
        blocks.push(section(
          `📋 *Deal:* <${hsLink}|${dp.dealname || '(unnamed)'}>\n` +
          `*Stage:* ${stageLabel}   ·   *Owner:* ${ownerName(dp.hubspot_owner_id)}   ·   *Last activity:* ${lastModStr}` +
          (dp.amount ? `   ·   *Amount:* $${Number(dp.amount).toLocaleString()}` : '')
        ));
      }

      // Show matching companies
      for (const co of companyHits.slice(0, 3)) {
        const cp = co.properties || {};
        const market = [cp.city, cp.state].filter(Boolean).join(', ') || '—';
        const hsLink = `https://app.hubspot.com/contacts/${portalId}/company/${co.id}`;
        blocks.push(section(
          `🏢 *Company:* <${hsLink}|${cp.name || '(unnamed)'}>\n` +
          `*Market:* ${market}   ·   *Industry:* ${cp.industry || '—'}   ·   *Owner:* ${ownerName(cp.hubspot_owner_id)}`
        ));
      }

      // Show matching contacts
      for (const ct of contactHits.slice(0, 3)) {
        const ctp = ct.properties || {};
        const ctName = [ctp.firstname, ctp.lastname].filter(Boolean).join(' ') || '(unnamed)';
        const lastMod = ctp.lastmodifieddate ? new Date(ctp.lastmodifieddate) : null;
        const lastModStr = lastMod ? humanizeDays(Math.floor((Date.now() - lastMod.getTime()) / 86400000)) : '—';
        const hsLink = `https://app.hubspot.com/contacts/${portalId}/contact/${ct.id}`;
        blocks.push(section(
          `👤 *Contact:* <${hsLink}|${ctName}>\n` +
          `*Email:* ${ctp.email || '—'}   ·   *Owner:* ${ownerName(ctp.hubspot_owner_id)}   ·   *Last activity:* ${lastModStr}`
        ));
      }
    }

    // Add HubSpot link as footer
    blocks.push(divider());
    blocks.push(section('_Use `/check [name]` for ownership resolution · `/audit [rep]` for conflict audit_'));

    log('respond_sent', { cmd: '/lookup', ms: Date.now() - t0, query: text });
    await respond({ blocks, replace_original: true });

  } catch (err) {
    log('error', { cmd: '/lookup', ms: Date.now() - t0, error: err.message });
    await respond({ text: `❌ Error: ${err.message}`, replace_original: true });
  }
});

// ---------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------


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
