'use strict';

/**
 * agent.js — LLM tool-use agent for /apbot (v2.1)
 *
 * Replaces parser.js + router.js. Single entry point: handleQuery(text, context).
 * Uses Anthropic's native tool_use API — the LLM decides what data to fetch,
 * fetches it via tools, then generates a conversational Slack response.
 *
 * v2.1 improvements:
 *  - Persistent learnings loaded from data/apbot-learnings.json
 *  - Few-shot examples in system prompt
 *  - Tool output _hints for LLM interpretation
 *  - Sonnet escalation for complex multi-rep queries
 *  - Post-query validation pass to catch missing reps
 *  - Always include deal record links
 */

const Anthropic = require('@anthropic-ai/sdk');
const fs   = require('fs');
const path = require('path');

const { executeTool } = require('./tools');
const { KNOWN_REPS }  = require('../audit');
const { getMemory, saveMemory, clearMemory } = require('./analyst');
const { loadLearnings: loadLearningsFromStorage, saveLearnings: saveLearningsToStorage } = require('./storage');
const { createTrace, logGeneration, logToolCall, finalizeTrace, flush: flushTraces } = require('./observability');

// ---------------------------------------------------------------------------
// Anthropic client
// ---------------------------------------------------------------------------

let _client = null;

function getClient() {
  if (_client) return _client;
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return null;
  _client = new Anthropic({ apiKey: key });
  return _client;
}

// ---------------------------------------------------------------------------
// Config + learnings
// ---------------------------------------------------------------------------

const DATA_DIR = path.join(__dirname, '..', '..', 'data');

function loadConfig() {
  try { return JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'config.json'), 'utf8')); }
  catch { return { slackToRep: {} }; }
}

// In-memory cache of learnings — loaded from GCS on first use
let _learningsCache = null;
let _learningsLoaded = false;

/**
 * Load learnings formatted for system prompt injection.
 * Uses GCS when available, falls back to local fs.
 */
async function loadLearnings() {
  if (!_learningsLoaded) {
    _learningsCache = await loadLearningsFromStorage();
    _learningsLoaded = true;
  }
  if (!_learningsCache || _learningsCache.length === 0) return '';
  return _learningsCache.map(l => `- ${l.correction}`).join('\n');
}

/**
 * Save a new learning from user correction.
 * Persists to GCS (and local backup).
 */
async function saveLearning(correction, context) {
  if (!_learningsLoaded) {
    _learningsCache = await loadLearningsFromStorage();
    _learningsLoaded = true;
  }
  const learnings = _learningsCache || [];
  const nextId = learnings.length > 0 ? Math.max(...learnings.map(l => l.id || 0)) + 1 : 1;
  learnings.push({
    id: nextId,
    query: `auto-learned from ${context?.userName || 'user'}`,
    correction,
    date: new Date().toISOString().slice(0, 10)
  });
  _learningsCache = learnings;
  await saveLearningsToStorage(learnings);
}

// ---------------------------------------------------------------------------
// System prompt — built dynamically with learnings
// ---------------------------------------------------------------------------

async function buildSystemPrompt() {
  const learnings = await loadLearnings();
  const learningsSection = learnings
    ? `\n## Learned Corrections (from past mistakes — follow these strictly)\n${learnings}\n`
    : '';

  return `You are an assistant for Landing's apartment partnerships (AP) sales team. You answer questions about accounts, deals, territories, pipeline data, rep activity, and ownership rules by calling tools to fetch data from HubSpot and other sources.

## Team Context
- This is a multifamily real estate sales team selling apartment partnerships
- The AP Pipeline (ID 64402505) is the main deal pipeline
- Known reps: ${KNOWN_REPS.join(', ')}
- Ownership is determined by a 5-tier hierarchy: Top 50 owners → Lease-ups → Owner-level assignments → State/regional fallback → Unassigned

## How to Answer
1. Read the user's question and decide which tool(s) to call to get the data you need
2. After receiving tool results, answer the question conversationally
3. Use Slack mrkdwn formatting: *bold* (single asterisk, NOT double **), _italic_, bullet points with •, <url|text> for links. NEVER use **double asterisks** — Slack does not render them correctly. Always use *single asterisks* for bold.
4. Keep answers concise — lead with the key insight, then supporting detail
5. When showing lists or rankings, use bullet points
6. Round numbers sensibly (1 decimal for days, whole numbers for counts, nearest % for rates)
7. If territory conflicts are detected (hasConflicts = true), flag them prominently with ⚠
8. Do not use markdown headers (#) — use *bold* text instead
9. Do not wrap your response in code blocks
10. If the data doesn't contain enough info, say what's missing and suggest what to ask
11. ALWAYS include HubSpot links for deals, companies, and contacts when available. Use <url|deal name> format so users can click through. Every deal mentioned in your answer MUST have its link.

## Deal Links (MANDATORY — NO EXCEPTIONS)
Whenever you reference a deal in your response — whether listing, comparing, or mentioning in passing — you MUST include the HubSpot link. Tool results include a "link" field for every deal. Format: <link|Deal Name>. Never mention a deal without its link. Even when listing 20+ deals, EVERY SINGLE ONE must have its link. If you are listing many deals, do not get lazy — include the link for each one. This is non-negotiable.

## Tool Selection Guide
- "who owns X?" / "account owner" / company status → search_company FIRST. This checks HubSpot for the ACTUAL owner. The company.owner field is the current account owner — report this as the answer. Only use resolve_ownership if the company is NOT in HubSpot.
- "who SHOULD own X?" / new lead routing → resolve_ownership (5-tier hierarchy for accounts not yet in HubSpot)
- Company intel, deals, contacts, engagements → search_company
- Pipeline data, deal lists, pitches, analytics → get_pipeline_data
- Rep activity summary → get_rep_activity
- "who covers X?" / territory → get_territory
- Launch Dashboard properties, contract dates, signed dates → search_dashboard (supports date filtering with month parameter)
- Find deals by name → search_deals
- Find contacts by name/email → search_contacts
- Rep audit / conflicts → run_audit
- Market research, vacancy rates, concessions, expansion viability, competitor intel → web_search

## Account Ownership (CRITICAL — read this carefully)
When someone asks "who owns [company]?" or "account owner for [company]":
1. ALWAYS call search_company first — this looks up the actual HubSpot record
2. The company.owner field IS the answer — this is who currently owns the account in HubSpot
3. If there are AP Pipeline deals, also mention the deal owner(s) — but the COMPANY owner is the primary answer
4. DO NOT call resolve_ownership for existing companies. resolve_ownership is for NEW leads that aren't in HubSpot yet.
5. NEVER report a contact-level owner as the account owner. The company.owner field is the account owner, not the owner on individual contacts.
6. If the company is not found in HubSpot, THEN use resolve_ownership to determine who should own it.

## Web Search + Market Research
When the user asks about market conditions, vacancy rates, concessions, expansion potential, or anything not in our internal data, use web_search. Combine with internal tools for multi-step research.

### How to search effectively:
1. First call search_dashboard to get our actual property names and cities
2. Then web_search EACH property by its EXACT property name + city. Use the property name from the dashboard, NOT a portfolio or owner name.
3. Good search queries (use the actual property name from the dashboard):
   - "[Property Name] [City] apartments pricing availability"
   - "[Property Name] [City] apartments specials"
   - "[Property Name] [City] apartment concessions move in special"
4. BAD search queries (avoid these):
   - Portfolio names like "Bellrock" — listing sites don't use portfolio names
   - Generic market searches like "Houston apartments concessions" — too broad
   - Old years like "2024" — use current data
5. Search results will come from apartments.com, Zillow, ForRent, Realtor.com, etc. Look for:
   - Starting rent prices (e.g. "starting at $1,377")
   - Unit availability (e.g. "10 units available")
   - Move-in specials / concessions mentioned in snippets
   - Number of floor plans / bed/bath options
6. For expansion viability analysis:
   - Properties with many available units = potential vacancy = expansion opportunity
   - Properties advertising specials/concessions = softer demand = our opportunity to negotiate
   - Compare current rents across our properties to identify pricing trends
7. Report what you found with specific data points. If a property search returned pricing but no concession info, say that clearly.

## Team-Wide Queries (CRITICAL)
When the user asks about "all reps", "the team", "who is best", "overall performance", "everyone", rankings, or any question that implies comparing ALL reps:
1. Call get_pipeline_data() with NO rep filter first — the repSummary field shows every rep with AP pipeline deals
2. IMPORTANT: get_pipeline_data only shows reps with AP pipeline deals. Some reps may be missing from repSummary.
3. Check repSummary against the full roster: ${KNOWN_REPS.join(', ')}. For any rep NOT in repSummary, call get_rep_activity to check their activity.
4. NEVER answer a team-wide question by only looking at reps already discussed in conversation. You MUST fetch fresh data covering all reps.
5. Include EVERY rep in your ranking — even if a rep has zero activity, mention them.

## Deal Close Likelihood
When the user asks "what's most likely to close", "what's closing next", or similar:
- Close likelihood = how far along in the pipeline, NOT how recently it was pitched
- Pipeline stages in close order (closest to close first): Contract Redline → Contract Discussions → Late Stage Opportunities → Active Opportunities
- Look for deals in the latest stages FIRST. A deal in Contract Redline is far more likely to close than one that was just pitched.
- If no deals are in Contract Redline, check Contract Discussions, then Late Stage, etc.
- Time in stage matters too — a deal that's been in Contract Redline for 3 days is closer than one stuck there for 60 days
- NEVER use "most recent pitch date" as a proxy for close likelihood. Pitching is the beginning of the process, not the end.

## Comparisons
- For "compare X to Y", call the relevant tool once per rep
- For "who is best" / rankings, call get_pipeline_data() with no rep filter to get everyone's data in one call, then supplement with get_rep_activity for missing reps

## Pitch Queries (CRITICAL)
When the user asks about pitches ("how many pitches", "pitches this week", "pitch count", "who pitched"):
1. ALWAYS set pitch_only: true — without it, pitch data (pitchList, pitchByRep, pitchCountInWindow) is NOT returned
2. For calendar month queries ("in March", "in February"), use start_date/end_date with exact dates (e.g. start_date: "2026-03-01", end_date: "2026-03-31"). NEVER approximate with days.
3. For relative queries ("this week", "last 30 days"), use the days parameter
4. Use pitchByRep for per-rep counts and pitchCountInWindow for the total — these are pre-computed and accurate

## Trending / Activity Trends
When the user asks about "trending", "trending up/down", or "who is most active":
1. Call get_pipeline_data(days: 7) for pipeline metrics
2. ALSO call get_rep_activity for at least the top 5-6 reps to get engagement data (calls, emails, meetings, tasks)
3. Compare BOTH pipeline deals AND engagement volume. A rep trending up should show increases in both areas.
4. Pipeline data alone is NOT sufficient for trending questions — engagement data is required.
${learningsSection}
## Self-Validation (CRITICAL — do this BEFORE writing your response)
After receiving tool results and before answering, check your own math:
1. *Counts must add up.* If you state a total and then list per-rep numbers, the per-rep numbers MUST sum to the total. If they don't, use the per-rep breakdown (pitchByRep, recentRepActivity) as the source of truth and recompute the total.
2. *Dates must be in range.* If the user asked about "today", only include items dated today. If they asked about "this week", only include items within the last 7 days. Check the pitchDate or date fields in the tool results — do not assume every item returned is in range.
3. *List length must match stated count.* If you say "5 pitches" and then list deals, you must list exactly 5. If there are more than you can list, say "X pitches total, here are the top ones:".
4. *Use pre-computed breakdowns.* If the tool result includes pitchByRep, recentRepActivity, or similar pre-aggregated fields, use those numbers directly. Do NOT try to recount from the pitchList — it may be truncated.
5. *Don't invent data.* If a field is null or missing, don't guess. Say the data isn't available.
6. *Cross-check before responding.* Read your draft answer one more time. Does every number trace back to the tool result? If you can't point to where a number came from, remove it.

## Important Rules
- When the user says "my" or "me", use their rep name (provided in the user message context)
- For follow-up questions, use the conversation context — you have prior tool results available
- When a tool result includes a _hints field, READ IT — it contains guidance on how to interpret the data correctly
- Pipeline stages in order: New Opportunities → Contacted → Defining Call Schedule → Call Scheduled → IC Review → Active Opportunities → Late Stage Opportunities → Contract Discussions → Contract Redline → Closed Won / Lost Deal
- AP Pipeline ID: 64402505

## Examples

### Example 1: Rep pitches this week
User: "renato pitches this week"
→ Call get_pipeline_data(rep: "Renato Lagomarsino", pitch_only: true, days: 7)
→ Answer with count of pitches whose pitch date is in the last 7 days, list each deal with <link|name>, pitch date, stage

### Example 1b: Pitches in a calendar month
User: "how many pitches in March?"
→ Call get_pipeline_data(pitch_only: true, start_date: "2026-03-01", end_date: "2026-03-31")
→ Use pitchCountInWindow and pitchByRep for the answer — these are exact counts for March 1-31
→ NEVER use "days: 31" for calendar month queries — that gives a rolling window, not the calendar month

### Example 1c: Pitch comparison
User: "how many pitches does john L have compared to the team"
→ Call get_pipeline_data(pitch_only: true) with NO days/dates for all-time, or with start_date/end_date if a time period is implied
→ ALWAYS use pitch_only: true when the question is about pitches — without it, pitch data is not returned

### Example 2: Team-wide ranking
User: "who is performing best this week?"
→ Call get_pipeline_data(days: 7) with NO rep filter
→ Check repSummary — if any known reps are missing, call get_rep_activity(rep, days: 7) for each missing rep
→ Rank ALL reps by deals + engagements + wins. Include every rep even if they have zero activity.

### Example 3: Company status
User: "venterra status"
→ Call search_company(name: "Venterra")
→ Answer with company overview, deals (each with <link|name>), contacts, recent engagements, territory status

### Example 4: Follow-up
User: "break that down by rep"
→ Do NOT re-fetch data. Use prior tool results from conversation context.
→ Reformat the same data grouped by rep.

### Example 5: Ownership check for unknown company
User: "who owns Starlight Capital?"
→ Call resolve_ownership(name: "Starlight Capital")
→ Answer with rule, assigned rep, explanation, HubSpot link if found

## Handling Corrections
If the user says something is wrong ("that's not right", "wrong", "incorrect", "actually it's X"):
1. Acknowledge the mistake clearly
2. State what was wrong and what the correct answer is
3. End your response with a line in this exact format: [LEARNING: description of what was wrong and the correct behavior]
The system will automatically save this for future reference.`;
}

// ---------------------------------------------------------------------------
// Tool definitions for the API
// ---------------------------------------------------------------------------

const TOOL_DEFINITIONS = [
  {
    name: 'search_company',
    description: 'Search for a company in HubSpot and get full intelligence: current owner, AP Pipeline deals, contacts, engagements, territory conflicts. The company.owner field shows who currently owns the account. Use for "who owns X?", "venterra status", "show me [company]", "account owner for [company]". This is the PRIMARY tool for ownership questions about existing accounts.',
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Company or owner name to search for' }
      },
      required: ['name']
    }
  },
  {
    name: 'get_pipeline_data',
    description: 'Fetch AP pipeline deals with optional filters. Returns deal summary with stage distribution, close times, win rates, pitch data, stale deals, and per-rep breakdown (repSummary). When called with NO rep filter, repSummary contains ALL reps with AP pipeline deals — use this for team-wide comparisons. IMPORTANT: check repSummary against the known reps list and call get_rep_activity for any missing reps. For calendar month queries (e.g. "in March"), use start_date/end_date instead of days.',
    input_schema: {
      type: 'object',
      properties: {
        rep: { type: 'string', description: 'Rep name to filter by (e.g. "Renato Lagomarsino"). Omit for all reps — repSummary will show every rep.' },
        stage: { type: 'string', description: 'Pipeline stage to filter by (e.g. "Contract Redline"). Omit for all stages.' },
        days: { type: 'number', description: 'Rolling lookback window in days from now. Use for "this week" (7), "last 30 days" (30). Do NOT use for calendar month queries — use start_date/end_date instead.' },
        start_date: { type: 'string', description: 'Start date (YYYY-MM-DD) for calendar date range queries. Use for "in March" (start_date: "2026-03-01", end_date: "2026-03-31"), "in Q1", etc. Takes precedence over days.' },
        end_date: { type: 'string', description: 'End date (YYYY-MM-DD) for calendar date range queries. If omitted, defaults to today.' },
        pitch_only: { type: 'boolean', description: 'If true, only return deals with pitch dates and build a pitchList with per-rep breakdown. ALWAYS set this to true when the user asks about pitches.' }
      },
      required: []
    }
  },
  {
    name: 'get_rep_activity',
    description: 'Get a rep\'s activity summary: deals created/modified, calls, emails, meetings, tasks, weekly trend, stage coverage gaps. Use for "scout\'s activity", "my activity last 30 days". Also use this to fill in data for reps missing from get_pipeline_data repSummary.',
    input_schema: {
      type: 'object',
      properties: {
        rep: { type: 'string', description: 'Rep name (e.g. "Scout Bishop")' },
        days: { type: 'number', description: 'Lookback window in days (default: 30)' }
      },
      required: ['rep']
    }
  },
  {
    name: 'resolve_ownership',
    description: 'Run ownership resolution for a NEW lead using the 5-tier hierarchy. Use ONLY for new leads not yet in HubSpot, or when the user asks "who SHOULD own X?" For existing accounts ("who owns X?", "account owner"), use search_company instead — it reads the actual HubSpot owner. Set lease_up=true when the user mentions a lease-up property.',
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Company or owner name to resolve' },
        lease_up: { type: 'boolean', description: 'Whether this is a lease-up property. Set true when user mentions lease-up.' },
        market: { type: 'string', description: 'Property market/location (e.g. "Tampa FL", "Dallas TX"). Pass when user mentions a location.' }
      },
      required: ['name']
    }
  },
  {
    name: 'get_territory',
    description: 'Look up which rep(s) cover a location. Use for "who covers Phoenix?", "whose territory is VA?", "who has Georgia?".',
    input_schema: {
      type: 'object',
      properties: {
        location: { type: 'string', description: 'City, state name, or state code (e.g. "Phoenix", "VA", "Virginia")' }
      },
      required: ['location']
    }
  },
  {
    name: 'search_dashboard',
    description: 'Search the Launch Dashboard for properties and partners: units, AE, PSM, signed/contract dates, expected launch. Supports text search (property name, partner name, market, rep) AND date filtering (e.g. "contracts signed in March"). Use for "units at [property]", "properties in Atlanta", "what signed in March", "partners with contract dates in March 2026". Handles misspelled names.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Property name, partner name, market, or search term. Can be empty when using month filter to get all properties for that month.' },
        month: { type: 'string', description: 'Month filter for date-based queries, e.g. "march 2026", "march", "2026-03". Returns only properties with signed/contract dates in that month.' },
        date_field: { type: 'string', description: 'Which date to filter by: "signed" (default, contract signing date) or "launch" (expected go-live date).' }
      },
      required: []
    }
  },
  {
    name: 'search_deals',
    description: 'Search HubSpot deals by name. Returns matching deals with stage, owner, amount, and HubSpot link. Use when looking for a specific deal by name.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Deal name to search for' }
      },
      required: ['query']
    }
  },
  {
    name: 'search_contacts',
    description: 'Search HubSpot contacts by name or email. Returns matching contacts with title, email, phone, owner, and HubSpot link.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Contact name or email to search for' }
      },
      required: ['query']
    }
  },
  {
    name: 'run_audit',
    description: 'Run a conflict audit for a rep. Finds all companies they\'ve touched and flags ownership conflicts. Returns activity overview, stage averages, and conflict list with HubSpot links. Use for "audit Scout", "run audit for Wells last 30 days".',
    input_schema: {
      type: 'object',
      properties: {
        rep: { type: 'string', description: 'Rep name (e.g. "Scout Bishop")' },
        days: { type: 'number', description: 'Lookback window in days (default: 90)' }
      },
      required: ['rep']
    }
  },
  {
    name: 'web_search',
    description: 'Search the web for real-time market data, property details, vacancy rates, concessions, and competitor intel. Use for questions about market conditions, property availability, expansion viability, or any data not in our internal systems. Examples: "vacancy rate at Domain Heights", "concessions at apartments in Austin", "[property name] availability 2026". Can also research owners, operators, and market trends.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Web search query. Be specific — include property name, city, and what data you need (vacancy, concessions, pricing, etc.)' }
      },
      required: ['query']
    }
  }
];

// ---------------------------------------------------------------------------
// Complexity detection — Haiku vs Sonnet
// ---------------------------------------------------------------------------

/**
 * Detect if a query is complex enough to warrant Sonnet instead of Haiku.
 * Complex = team-wide comparisons, multi-rep analysis, ranking all reps,
 * or multi-step research (web search + internal data).
 */
function isComplexQuery(text) {
  const lower = (text || '').toLowerCase();

  // Web search / market research — multi-step reasoning
  if (/\b(web search|vacancy|concession|expansion|viable|market research|market condition)\b/i.test(lower)) return true;

  // Team-wide / ranking / comparison keywords
  if (/\b(all reps|the team|every rep|everyone|team-wide|overall|rank|ranking|leaderboard)\b/i.test(lower)) return true;
  if (/\b(who is|who's)\s+(the )?(best|worst|top|bottom|leading|trailing|most|least)\b/i.test(lower)) return true;
  if (/\bcompare\b.*\b(to|vs|versus|and|with)\b/i.test(lower)) return true;

  // Multi-step analytical questions
  if (/\b(trend|trending|performance|performing)\b/i.test(lower) && !/\bmy\b/i.test(lower)) return true;
  if (/\b(break.*down|drill.*down|by rep)\b/i.test(lower)) return true;

  return false;
}

// ---------------------------------------------------------------------------
// Conversation memory helpers
// ---------------------------------------------------------------------------

/**
 * Strip thinking blocks from assistant messages — they're large and not needed
 * for follow-up context. Only keep text and tool_use blocks.
 */
function stripThinking(messages) {
  return messages.map(msg => {
    if (msg.role === 'assistant' && Array.isArray(msg.content)) {
      const filtered = msg.content.filter(b => b.type !== 'thinking');
      return { ...msg, content: filtered };
    }
    return msg;
  });
}

function trimMessages(messages) {
  // Always strip thinking blocks first — they're huge and not needed for follow-ups
  let cleaned = stripThinking(messages);

  if (cleaned.length <= 8) return cleaned;

  const keep = cleaned.slice(-8);
  const old = cleaned.slice(0, -8);

  const trimmed = old.map(msg => {
    if (msg.role === 'user' && Array.isArray(msg.content)) {
      return {
        role: 'user',
        content: msg.content.map(block => {
          if (block.type === 'tool_result') {
            try {
              const data = JSON.parse(block.content);
              const keys = Object.keys(data).slice(0, 3).join(', ');
              return { ...block, content: `[tool result summarized: ${keys}...]` };
            } catch {
              return { ...block, content: '[tool result summarized]' };
            }
          }
          return block;
        })
      };
    }
    return msg;
  });

  return [...trimmed, ...keep];
}

// ---------------------------------------------------------------------------
// Keyword fallback — when Anthropic API is unavailable
// ---------------------------------------------------------------------------

function keywordFallback(text) {
  const lower = text.toLowerCase().trim();

  if (/who owns|who should own|^check\b/i.test(lower)) {
    const name = text.replace(/^.*(?:who owns|who should own|check)\s*/i, '').replace(/\?/g, '').trim();
    return name ? { tool: 'resolve_ownership', args: { name } } : null;
  }
  if (/who covers|whose territory|territory/i.test(lower)) {
    const location = text.replace(/^.*(?:who covers|whose territory is|territory)\s*/i, '').replace(/\?/g, '').trim();
    return location ? { tool: 'get_territory', args: { location } } : null;
  }
  if (/^audit\b/i.test(lower)) {
    const rest = text.slice(5).trim();
    const daysMatch = rest.match(/(\d+)\s*days?/);
    const rep = rest.replace(/\d+\s*days?/g, '').replace(/last/gi, '').trim();
    return rep ? { tool: 'run_audit', args: { rep, days: daysMatch ? parseInt(daysMatch[1]) : 90 } } : null;
  }
  if (/pipeline|deals?\b|stage|stale|pitch|win rate|close time/i.test(lower)) {
    const pitchOnly = /pitch/i.test(lower);
    return { tool: 'get_pipeline_data', args: { pitch_only: pitchOnly || undefined } };
  }
  if (/activity|activities/i.test(lower)) {
    const rest = text.replace(/activit(?:y|ies)/i, '').trim();
    const rep = rest.replace(/\b(my|me|this week|last \d+ days?|today|yesterday)\b/gi, '').trim();
    return rep ? { tool: 'get_rep_activity', args: { rep } } : null;
  }
  if (/\bunits?\b|\bpsm\b|\blaunch\b|\bdashboard\b/i.test(lower)) {
    const query = text.replace(/^.*(?:units? at|psm for|show me)\s*/i, '').replace(/\?/g, '').trim();
    return query ? { tool: 'search_dashboard', args: { query } } : null;
  }

  return { tool: 'search_company', args: { name: text.trim() } };
}

// ---------------------------------------------------------------------------
// Format response for Slack
// ---------------------------------------------------------------------------

function formatSlackBlocks(text) {
  // Fix double-asterisk bold (**x**) → single-asterisk (*x*) for Slack mrkdwn
  text = text.replace(/\*\*([^*]+)\*\*/g, '*$1*');
  // Fix markdown headers (# x) → bold (*x*)
  text = text.replace(/^#{1,3}\s+(.+)$/gm, '*$1*');

  const blocks = [];
  const MAX_BLOCK_LEN = 2900;

  const paragraphs = text.split(/\n\n+/);
  let current = '';

  for (const para of paragraphs) {
    if (current.length + para.length + 2 > MAX_BLOCK_LEN) {
      if (current) {
        blocks.push({ type: 'section', text: { type: 'mrkdwn', text: current.trim() } });
      }
      if (para.length > MAX_BLOCK_LEN) {
        const lines = para.split('\n');
        current = '';
        for (const line of lines) {
          if (current.length + line.length + 1 > MAX_BLOCK_LEN) {
            blocks.push({ type: 'section', text: { type: 'mrkdwn', text: current.trim() } });
            current = line + '\n';
          } else {
            current += line + '\n';
          }
        }
      } else {
        current = para + '\n\n';
      }
    } else {
      current += (current ? '\n\n' : '') + para;
    }
  }

  if (current.trim()) {
    blocks.push({ type: 'section', text: { type: 'mrkdwn', text: current.trim() } });
  }

  return blocks.slice(0, 49);
}

// ---------------------------------------------------------------------------
// Post-query validation
// ---------------------------------------------------------------------------

/**
 * Check if a team-wide answer mentions all known reps. If reps are missing,
 * return a list of missing rep names so we can fetch their data.
 */
function validateTeamAnswer(queryText, answerText) {
  const lower = (queryText || '').toLowerCase();
  const isTeamQuery = /\b(all reps|the team|every rep|everyone|team-wide|overall|rank|ranking|leaderboard|who is|who's)\b/i.test(lower)
    && /\b(best|worst|top|perform|trend|rank|compar)\b/i.test(lower);

  if (!isTeamQuery) return null;

  const answerLower = (answerText || '').toLowerCase();
  const missing = KNOWN_REPS.filter(rep => {
    const firstName = rep.split(' ')[0].toLowerCase();
    const lastName = rep.split(' ').slice(-1)[0].toLowerCase();
    return !answerLower.includes(firstName) && !answerLower.includes(lastName);
  });

  return missing.length > 0 ? missing : null;
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

async function handleQuery(text, context) {
  const client = getClient();
  const trace = createTrace({
    userId: context.userId,
    userName: context.userName,
    query: text
  });

  const config = loadConfig();
  const callerRep = config.slackToRep?.[context.userId] || null;

  let userContent = text;
  if (callerRep) {
    userContent = `[Context: The user is ${callerRep} (Slack user ${context.userName}).]\n\n${text}`;
  }

  if (!client) {
    return handleFallback(text, callerRep, context);
  }

  // Build messages: include conversation memory for follow-ups
  const prior = getMemory(context.userId);
  let messages;

  if (prior && prior.messages && prior.messages.length > 0) {
    messages = [
      ...trimMessages(prior.messages),
      { role: 'user', content: userContent }
    ];
  } else {
    messages = [
      { role: 'user', content: userContent }
    ];
  }

  // Choose model based on query complexity — try Sonnet for complex, fall back to Haiku
  const complex = isComplexQuery(text);
  const SONNET_MODEL = 'claude-sonnet-4-6';
  const HAIKU_MODEL = 'claude-haiku-4-5-20251001';
  let model = complex ? SONNET_MODEL : HAIKU_MODEL;
  if (complex) console.log('[apbot/agent] Complex query detected, trying Sonnet');

  const systemPrompt = await buildSystemPrompt();

  // Prompt caching: wrap system prompt and mark last tool for caching
  const cachedSystem = [
    { type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } }
  ];
  const cachedTools = TOOL_DEFINITIONS.map((tool, i) => {
    if (i === TOOL_DEFINITIONS.length - 1) {
      return { ...tool, cache_control: { type: 'ephemeral' } };
    }
    return tool;
  });

  // Extended thinking config — budget scales with complexity
  const thinkingConfig = {
    type: 'enabled',
    budget_tokens: complex ? 8000 : 4000
  };

  try {
    const MAX_TURNS = 10;
    let turn = 0;
    let answer = null;
    const collectedToolResults = []; // Track all tool calls for output validation

    while (turn < MAX_TURNS) {
      turn++;

      let response;
      const llmStart = new Date();
      try {
        response = await client.messages.create({
          model,
          max_tokens: complex ? 16000 : 8000,
          system: cachedSystem,
          tools: cachedTools,
          thinking: thinkingConfig,
          messages
        });
      } catch (modelErr) {
        // If Sonnet not available (404, billing), fall back to Haiku
        if (model === SONNET_MODEL && (modelErr.status === 404 || modelErr.status === 400)) {
          console.log('[apbot/agent] Sonnet unavailable, falling back to Haiku');
          model = HAIKU_MODEL;
          // Reset thinking budget — Haiku gets 4k thinking, and max_tokens must exceed it
          thinkingConfig.budget_tokens = 4000;
          response = await client.messages.create({
            model,
            max_tokens: 8000,
            system: cachedSystem,
            tools: cachedTools,
            thinking: thinkingConfig,
            messages
          });
        } else {
          throw modelErr;
        }
      }
      logGeneration(trace, { model, messages, response, startTime: llmStart, usage: response.usage });

      const toolUseBlocks = response.content.filter(b => b.type === 'tool_use');
      const textBlocks = response.content.filter(b => b.type === 'text');

      if (toolUseBlocks.length === 0) {
        answer = textBlocks.map(b => b.text).join('\n\n');
        messages.push({ role: 'assistant', content: response.content });
        break;
      }

      messages.push({ role: 'assistant', content: response.content });

      // Execute tools sequentially (HubSpot rate limits)
      const toolResults = [];
      for (const toolBlock of toolUseBlocks) {
        console.log(`[apbot/agent] Calling tool: ${toolBlock.name}`, JSON.stringify(toolBlock.input));
        const toolStart = new Date();
        const result = await executeTool(toolBlock.name, toolBlock.input);
        logToolCall(trace, { toolName: toolBlock.name, args: toolBlock.input, result, startTime: toolStart });
        toolResults.push({
          type: 'tool_result',
          tool_use_id: toolBlock.id,
          content: JSON.stringify(result)
        });
        collectedToolResults.push({ tool: toolBlock.name, args: toolBlock.input, result });
      }

      messages.push({ role: 'user', content: toolResults });
    }

    if (!answer || !answer.trim()) {
      saveMemory(context.userId, messages, null, null);
      return { text: '_No response generated. Try rephrasing your question._' };
    }

    // Post-query validation: check for missing reps in team-wide queries
    const missingReps = validateTeamAnswer(text, answer);
    if (missingReps && missingReps.length > 0 && turn < MAX_TURNS - 1) {
      console.log(`[apbot/agent] Validation: ${missingReps.length} reps missing from answer, requesting correction`);

      const correctionMsg = `Your answer is missing these reps from the roster: ${missingReps.join(', ')}. ` +
        `The user asked about the whole team. Please call get_rep_activity for each missing rep to get their data, ` +
        `then provide a complete answer that includes ALL reps. If a rep has zero activity, still mention them.`;

      messages.push({ role: 'user', content: correctionMsg });

      // Run additional turns to fill in missing reps
      let correctionTurns = 0;
      while (correctionTurns < 4) {
        correctionTurns++;

        const correctionResponse = await client.messages.create({
          model,
          max_tokens: 8000,
          system: cachedSystem,
          tools: cachedTools,
          thinking: thinkingConfig,
          messages
        });

        const corrToolUse = correctionResponse.content.filter(b => b.type === 'tool_use');
        const corrText = correctionResponse.content.filter(b => b.type === 'text');

        if (corrToolUse.length === 0) {
          answer = corrText.map(b => b.text).join('\n\n');
          messages.push({ role: 'assistant', content: correctionResponse.content });
          break;
        }

        messages.push({ role: 'assistant', content: correctionResponse.content });

        const corrResults = [];
        for (const toolBlock of corrToolUse) {
          console.log(`[apbot/agent] Correction tool: ${toolBlock.name}`, JSON.stringify(toolBlock.input));
          const result = await executeTool(toolBlock.name, toolBlock.input);
          corrResults.push({
            type: 'tool_result',
            tool_use_id: toolBlock.id,
            content: JSON.stringify(result)
          });
          // Persist correction tool results for output validation
          collectedToolResults.push({ tool: toolBlock.name, args: toolBlock.input, result });
        }

        messages.push({ role: 'user', content: corrResults });
      }
    }

    // Extract and save any learnings from the response
    const learningMatch = answer.match(/\[LEARNING:\s*(.+?)\]/i);
    if (learningMatch) {
      const correction = learningMatch[1].trim();
      await saveLearning(correction, context);
      console.log(`[apbot/agent] Saved learning: ${correction}`);
      // Remove the learning tag from the user-facing response
      answer = answer.replace(/\[LEARNING:\s*.+?\]/i, '').trim();
    }

    // Output validation — cross-check LLM numbers against tool data
    const validationIssues = validateOutputNumbers(answer, collectedToolResults);
    if (validationIssues.length > 0) {
      console.log(`[apbot/agent] Validation found ${validationIssues.length} issue(s)`);
      answer += '\n\n' + validationIssues.join('\n');
    }

    // Save to memory — strip thinking blocks to keep memory lean
    saveMemory(context.userId, stripThinking(messages), null, null);

    const blocks = formatSlackBlocks(answer);
    finalizeTrace(trace, { output: answer, status: 'success', model, totalTurns: turn, validationIssues: validationIssues.length });
    return { blocks };

  } catch (err) {
    console.error('[apbot/agent] LLM error:', err.message);
    finalizeTrace(trace, { output: err.message, status: 'error', model });

    // Retry once on transient errors (overloaded, timeout, 5xx)
    const isTransient = err.status === 529 || err.status === 503 || err.status >= 500
      || err.message?.includes('timeout') || err.message?.includes('overloaded');
    if (isTransient) {
      console.log('[apbot/agent] Transient error, retrying in 2s...');
      await new Promise(r => setTimeout(r, 2000));
      try {
        return await handleQuery(text, context);
      } catch (retryErr) {
        console.error('[apbot/agent] Retry also failed:', retryErr.message);
      }
    }

    return handleFallback(text, callerRep, context);
  }
}

// ---------------------------------------------------------------------------
// Output validation — cross-check LLM numbers against tool data (Phase 3)
// ---------------------------------------------------------------------------

/**
 * After the LLM generates a response, check key numbers against tool results.
 * If mismatches are found, append a correction note or re-query.
 */
function validateOutputNumbers(answer, toolResults) {
  const issues = [];

  for (const { tool, result } of toolResults) {
    if (tool === 'get_pipeline_data' && result && !result.error) {
      // Check pitch count — validate that the total appears in the response.
      // Skip when pitchByRep is present: the response may focus on individual rep counts
      // which will naturally differ from the total (e.g. "John has 2" vs total 2000).
      if (result.pitchCountInWindow !== undefined) {
        const expected = result.pitchCountInWindow;
        const mentioned = extractNumbersFromText(answer);
        // Only flag if the response appears to state a TOTAL pitch count that's wrong.
        // When pitchByRep exists, individual rep counts are valid — don't compare them to the total.
        const hasByRep = result.pitchByRep && Object.keys(result.pitchByRep).length > 1;
        if (expected > 0 && !mentioned.includes(expected) && !hasByRep) {
          const wrongCount = mentioned.find(n => n !== expected && n > 0 && Math.abs(n - expected) < expected);
          if (wrongCount !== undefined) {
            issues.push(`⚠ _Correction: pitch count is *${expected}*, not ${wrongCount}._`);
          }
        }
      }

      // Check recent wins
      if (result.timeWindow?.recentWins) {
        const expected = result.timeWindow.recentWins.count;
        const mentioned = extractNumbersFromText(answer);
        // Only flag if the answer mentions "closed" and has a wrong number
        if (/clos/i.test(answer) && expected >= 0 && !mentioned.includes(expected)) {
          const wrongCount = mentioned.find(n => n !== expected && /clos/i.test(answer));
          if (wrongCount !== undefined && wrongCount !== expected) {
            issues.push(`⚠ _Correction: ${expected} deals closed in this period, not ${wrongCount}._`);
          }
        }
      }
    }
  }

  return issues;
}

/**
 * Extract human-readable numbers from text (strips URLs and large IDs).
 */
function extractNumbersFromText(text) {
  const cleaned = text.replace(/https?:\/\/[^\s>|)]+/g, '');
  return (cleaned.match(/\b\d[\d,]*\b/g) || [])
    .map(m => parseInt(m.replace(/,/g, ''), 10))
    .filter(n => !isNaN(n) && n < 100000 && !(n >= 2020 && n <= 2030));
}

/**
 * Keyword fallback — when Anthropic API is unavailable.
 * Formats tool data into readable Slack blocks instead of raw JSON.
 */
async function handleFallback(text, callerRep, context) {
  let resolvedText = text;
  if (callerRep && /\bmy\b/i.test(text)) {
    resolvedText = text.replace(/\bmy\b/gi, callerRep + "'s");
  }

  const match = keywordFallback(resolvedText);
  if (!match) {
    return {
      blocks: [
        { type: 'section', text: { type: 'mrkdwn', text: `I'm having trouble processing that right now. Try again in a moment, or use a specific query like:` } },
        { type: 'section', text: { type: 'mrkdwn', text: `• \`/apbot who owns Camden?\`\n• \`/apbot who covers Dallas?\`\n• \`/apbot pitches this week\`\n• \`/apbot audit Scout Bishop\`` } }
      ]
    };
  }

  if (match.args && !match.args.rep && callerRep) {
    if (match.tool === 'get_pipeline_data' || match.tool === 'get_rep_activity') {
      match.args.rep = callerRep;
    }
  }

  try {
    const result = await executeTool(match.tool, match.args);
    const formatted = formatFallbackResult(match.tool, result);
    return {
      blocks: [
        { type: 'section', text: { type: 'mrkdwn', text: `_⚠ Running in simplified mode — LLM unavailable_` } },
        ...formatted
      ]
    };
  } catch (err) {
    return {
      blocks: [
        { type: 'section', text: { type: 'mrkdwn', text: `I'm having trouble right now. Please try again in a moment.` } },
        { type: 'section', text: { type: 'mrkdwn', text: `_Error: ${err.message.slice(0, 200)}_` } }
      ]
    };
  }
}

/**
 * Format tool results into readable Slack blocks for fallback mode.
 */
function formatFallbackResult(tool, result) {
  const blocks = [];

  if (result.error) {
    blocks.push({ type: 'section', text: { type: 'mrkdwn', text: `_Error: ${result.error}_` } });
    return blocks;
  }

  switch (tool) {
    case 'resolve_ownership': {
      const reps = (result.assignedTo || []).join(', ') || 'UNASSIGNED';
      let text = `*${result.query}* → *${reps}*`;
      if (result.ruleLabel) text += `\nRule: ${result.ruleLabel}`;
      if (result.explanation) text += `\n${result.explanation}`;
      if (result.hubspot?.link) text += `\n<${result.hubspot.link}|View in HubSpot>`;
      blocks.push({ type: 'section', text: { type: 'mrkdwn', text } });
      break;
    }
    case 'get_territory': {
      if (!result.found) {
        blocks.push({ type: 'section', text: { type: 'mrkdwn', text: `No territory assignment found for "${result.query}".` } });
      } else {
        const reps = result.reps.map(r => `• *${r.rep}*${r.focus ? ` (${r.focus})` : ''}`).join('\n');
        blocks.push({ type: 'section', text: { type: 'mrkdwn', text: `*${result.query}* (${result.stateCode}):\n${reps}` } });
      }
      break;
    }
    case 'get_pipeline_data': {
      let text = `*Pipeline Summary:* ${result.totalDeals} deals`;
      if (result.totalAmount) text += ` • $${(result.totalAmount / 1000000).toFixed(1)}M total`;
      if (result.winRate) text += ` • ${result.winRate}% win rate`;
      const stages = Object.entries(result.byStage || {}).sort((a, b) => b[1] - a[1]).slice(0, 10);
      if (stages.length) {
        text += '\n\n*By Stage:*\n' + stages.map(([s, c]) => `• ${s}: ${c}`).join('\n');
      }
      const reps = (result.repSummary || []).slice(0, 10);
      if (reps.length) {
        text += '\n\n*By Rep:*\n' + reps.map(r => `• ${r.rep}: ${r.deals} deals, ${r.won} won`).join('\n');
      }
      blocks.push({ type: 'section', text: { type: 'mrkdwn', text: text.slice(0, 2900) } });
      break;
    }
    case 'get_rep_activity': {
      let text = `*${result.rep}* — ${result.days}-day activity`;
      text += `\n• ${result.dealsCreated || 0} deals created, ${result.dealsModified || 0} modified`;
      text += `\n• ${result.calls || 0} calls, ${result.emails || 0} emails, ${result.meetings || 0} meetings, ${result.tasks || 0} tasks`;
      blocks.push({ type: 'section', text: { type: 'mrkdwn', text } });
      break;
    }
    default: {
      // Generic: show key fields
      const keys = Object.keys(result).filter(k => !k.startsWith('_'));
      const summary = keys.slice(0, 8).map(k => {
        const v = result[k];
        if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') return `• *${k}:* ${v}`;
        if (Array.isArray(v)) return `• *${k}:* ${v.length} items`;
        return null;
      }).filter(Boolean).join('\n');
      blocks.push({ type: 'section', text: { type: 'mrkdwn', text: summary || '_No data available_' } });
    }
  }

  return blocks;
}

module.exports = { handleQuery };
