'use strict';

/**
 * parser.js — LLM intent parser for /apbot
 *
 * Calls Claude Haiku to classify freeform queries into structured intents.
 * Falls back to keyword matching if the API is unavailable.
 */

const Anthropic = require('@anthropic-ai/sdk');

const KNOWN_REPS = require('../audit').KNOWN_REPS;

const INTENTS = [
  'check',        // ownership resolution (who owns X?)
  'audit',        // conflict audit for a rep
  'lookup',       // HubSpot record search
  'pipeline',     // deal pipeline queries + analytics
  'dashboard',    // Launch Dashboard property queries
  'activity',     // rep activity summary
  'territory',    // territory lookup (who covers X?)
  'deal_detail'   // single deal deep-dive
];

const PIPELINE_STAGES = [
  'Inbound Lead', 'Research', 'Cold Outreach', 'Call Scheduled',
  'Active', 'IC Review', 'Contract Redline', 'Closed Won', 'Closed Lost'
];

const SYSTEM_PROMPT = `You are an intent classifier for a Slack bot that manages apartment partnership sales accounts.

Available intents:
- check: ownership resolution — "who owns X?", "check Camden", "who should own Greystar?"
- audit: conflict audit for a rep — "audit Scout", "run audit for Wells last 30 days"
- lookup: company intelligence / HubSpot search — "when was the last contact from Venterra?", "what's the status of Sophia's deal with Venterra?", "show me Venterra", "look up deal 12345", "search for john@example.com". Use this for any question about a specific company, partner, or account.
- pipeline: deal pipeline queries — "my deals", "show pipeline", "deals in Contract Redline", "stale deals", "stage distribution", "average time in IC Review", "conversion rates", "when was [rep]'s last pitch?", "recent pitches", "[rep]'s pitches", "average time to close", "how long to close a deal?", "avg close time", "win rate"
- dashboard: Launch Dashboard property queries — "units at [property]", "PSM for [property]", "properties in Atlanta", "show me [property name]", "launch date for [property]"
- activity: rep activity summary — "Scout's activity this week", "my activity last 30 days"
- territory: territory lookup — "who covers Phoenix?", "whose territory is VA?", "who has Georgia?"
- deal_detail: single deal deep-dive — "tell me about deal 12345", "status on [deal name]"

Known reps: ${KNOWN_REPS.join(', ')}

Pipeline stages: ${PIPELINE_STAGES.join(', ')}

Respond with ONLY a JSON object (no markdown, no explanation):
{
  "intent": "<one of: ${INTENTS.join(', ')}>",
  "entity": "<the main subject — company name, property name, deal ID, location, etc. For lookup, this should be the COMPANY name.>",
  "parameters": {
    "days": <number or null — lookback window if mentioned>,
    "stage": "<pipeline stage if mentioned, or null>",
    "self": <true if user says "my" or "me", false otherwise>,
    "metric": "<for pipeline analytics: 'distribution', 'avg_time', 'conversion', 'stale', 'last_pitch', 'avg_close_time', or null>",
    "rep": "<if a specific rep is mentioned in the question, their full name from the known reps list. e.g. 'sophia's deal with Venterra' → rep: 'Sophia Nadler'. null if no rep mentioned>"
  }
}`;

let _client = null;

function getClient() {
  if (_client) return _client;
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return null;
  _client = new Anthropic({ apiKey: key });
  return _client;
}

/**
 * Parse a freeform query into a structured intent using Claude Haiku.
 * Falls back to keyword matching if the API call fails or no key is set.
 */
async function parse(text) {
  const client = getClient();

  if (client) {
    try {
      const response = await client.messages.create({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 256,
        temperature: 0,
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content: text }]
      });

      const raw = response.content[0]?.text || '';
      // Strip markdown fences if present
      const cleaned = raw.replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '').trim();
      const parsed = JSON.parse(cleaned);

      if (INTENTS.includes(parsed.intent)) {
        return {
          intent: parsed.intent,
          entity: parsed.entity || null,
          parameters: parsed.parameters || {},
          source: 'llm'
        };
      }
    } catch (err) {
      console.error('[apbot/parser] LLM parse failed, falling back to keywords:', err.message);
    }
  }

  // Keyword fallback
  return keywordFallback(text);
}

/**
 * Keyword-based intent classification — used when LLM is unavailable.
 */
function keywordFallback(text) {
  const lower = text.toLowerCase().trim();

  // Direct command prefixes
  if (lower.startsWith('check ') || lower === 'check') {
    return { intent: 'check', entity: text.slice(6).trim() || null, parameters: {}, source: 'keyword' };
  }
  if (lower.startsWith('audit ') || lower === 'audit') {
    return { intent: 'audit', entity: text.slice(6).trim() || null, parameters: {}, source: 'keyword' };
  }
  if (lower.startsWith('lookup ') || lower.startsWith('look up ') || lower.startsWith('find ') || lower.startsWith('search ')) {
    const entity = text.replace(/^(?:lookup|look up|find|search)\s+/i, '').trim();
    return { intent: 'lookup', entity: entity || null, parameters: {}, source: 'keyword' };
  }

  // "who owns" / "who should own" → check
  if (/who owns|who should own/i.test(lower)) {
    const entity = text.replace(/^.*(?:who owns|who should own)\s*/i, '').replace(/\?/g, '').trim();
    return { intent: 'check', entity: entity || null, parameters: {}, source: 'keyword' };
  }

  // Deal detail (numeric ID or "deal" keyword) — must be before pipeline
  if (/^deal\s+\d+/i.test(lower) || /tell me about deal|status on deal/i.test(lower)) {
    const idMatch = text.match(/\d+/);
    return { intent: 'deal_detail', entity: idMatch ? idMatch[0] : text.trim(), parameters: {}, source: 'keyword' };
  }

  // Territory
  if (/who covers|whose territory|who has .*(state|territory)/i.test(lower) || lower.includes('territory')) {
    const entity = text.replace(/^.*(?:who covers|whose territory is|who has)\s*/i, '').replace(/\?/g, '').trim();
    return { intent: 'territory', entity: entity || null, parameters: {}, source: 'keyword' };
  }

  // Dashboard
  if (/\bunits?\b|\bpsm\b|\blaunch\b|\bproperty\b|\bproperties\b/i.test(lower) && !/pipeline|deal|stage/i.test(lower)) {
    const entity = text.replace(/^.*(?:units? at|psm for|properties in|show me)\s*/i, '').replace(/\?/g, '').trim();
    return { intent: 'dashboard', entity: entity || text.trim(), parameters: {}, source: 'keyword' };
  }

  // Pipeline
  if (/pipeline|deals?\b|stage|stale|distribution|conversion|avg time|time to close|close time|win rate|pitch/i.test(lower)) {
    const self = /\bmy\b/i.test(lower);
    let metric = null;
    if (/time to close|close time|how long.*(close|win)|win rate/i.test(lower)) metric = 'avg_close_time';
    else if (/distribution/i.test(lower)) metric = 'distribution';
    else if (/avg time|average time|how long/i.test(lower)) metric = 'avg_time';
    else if (/conversion|convert/i.test(lower)) metric = 'conversion';
    else if (/stale/i.test(lower)) metric = 'stale';
    else if (/pitch/i.test(lower)) metric = 'last_pitch';

    // Try to extract stage name
    let stage = null;
    for (const s of PIPELINE_STAGES) {
      if (lower.includes(s.toLowerCase())) { stage = s; break; }
    }

    const entity = text.replace(/^.*(?:deals? in|deals? at|show|my)\s*/i, '').replace(/\?/g, '').trim();
    return { intent: 'pipeline', entity: entity || null, parameters: { self, metric, stage }, source: 'keyword' };
  }

  // Activity
  if (/activity|activities/i.test(lower)) {
    const self = /\bmy\b/i.test(lower);
    const daysMatch = lower.match(/(\d+)\s*days?/);
    let days = daysMatch ? parseInt(daysMatch[1], 10) : null;
    if (!days && /\btoday\b/i.test(lower)) days = 1;
    if (!days && /\bthis week\b/i.test(lower)) days = 7;
    if (!days && /\blast week\b/i.test(lower)) days = 14;
    if (!days && /\byesterday\b/i.test(lower)) days = 2;
    if (!days && /\bthis month\b/i.test(lower)) days = 30;
    if (!days && /\blast month\b/i.test(lower)) days = 60;
    // Try to extract rep name: "sophia's activity", "activity for sophia", "what was sophia's activity today"
    let entity = null;
    const beforeMatch = text.match(/(?:what was|show|get)\s+(.+?)(?:'s)?\s+activit/i) || text.match(/^(.+?)(?:'s)\s+activit/i);
    const afterMatch = text.match(/activit(?:y|ies)\s+(?:for|of)\s+(.+?)(?:\s+(?:this|last|today|$))/i);
    if (beforeMatch) entity = beforeMatch[1].replace(/\bmy\b/i, '').trim();
    else if (afterMatch) entity = afterMatch[1].trim();
    else entity = text.replace(/^.*(?:activity for|activity)\s*/i, '').replace(/\s*(?:this week|last \d+ days?|today).*$/i, '').trim();
    return { intent: 'activity', entity: entity || null, parameters: { self, days }, source: 'keyword' };
  }

  // Default to lookup
  return { intent: 'lookup', entity: text.trim(), parameters: {}, source: 'keyword' };
}

module.exports = { parse, INTENTS, PIPELINE_STAGES };
