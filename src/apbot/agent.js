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
const LEARNINGS_PATH = path.join(DATA_DIR, 'apbot-learnings.json');

function loadConfig() {
  try { return JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'config.json'), 'utf8')); }
  catch { return { slackToRep: {} }; }
}

function loadLearnings() {
  try {
    const raw = JSON.parse(fs.readFileSync(LEARNINGS_PATH, 'utf8'));
    return raw.map(l => `- ${l.correction}`).join('\n');
  } catch { return ''; }
}

/**
 * Save a new learning from user correction.
 */
function saveLearning(correction, context) {
  let learnings = [];
  try { learnings = JSON.parse(fs.readFileSync(LEARNINGS_PATH, 'utf8')); } catch {}
  const nextId = learnings.length > 0 ? Math.max(...learnings.map(l => l.id || 0)) + 1 : 1;
  learnings.push({
    id: nextId,
    query: `auto-learned from ${context?.userName || 'user'}`,
    correction,
    date: new Date().toISOString().slice(0, 10)
  });
  try { fs.writeFileSync(LEARNINGS_PATH, JSON.stringify(learnings, null, 2)); } catch {}
}

// ---------------------------------------------------------------------------
// System prompt — built dynamically with learnings
// ---------------------------------------------------------------------------

function buildSystemPrompt() {
  const learnings = loadLearnings();
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
3. Use Slack mrkdwn formatting: *bold*, _italic_, bullet points with •, <url|text> for links
4. Keep answers concise — lead with the key insight, then supporting detail
5. When showing lists or rankings, use bullet points
6. Round numbers sensibly (1 decimal for days, whole numbers for counts, nearest % for rates)
7. If territory conflicts are detected (hasConflicts = true), flag them prominently with ⚠
8. Do not use markdown headers (#) — use *bold* text instead
9. Do not wrap your response in code blocks
10. If the data doesn't contain enough info, say what's missing and suggest what to ask
11. ALWAYS include HubSpot links for deals, companies, and contacts when available. Use <url|deal name> format so users can click through. Every deal mentioned in your answer MUST have its link.

## Deal Links (MANDATORY)
Whenever you reference a deal in your response — whether listing, comparing, or mentioning in passing — you MUST include the HubSpot link. Tool results include a "link" field for every deal. Format: <link|Deal Name>. Never mention a deal without its link.

## Tool Selection Guide
- Company status/intel → search_company (fetches deals, contacts, engagements, territory conflicts)
- "who owns X?" / ownership check → resolve_ownership
- Pipeline data, deal lists, pitches, analytics → get_pipeline_data
- Rep activity summary → get_rep_activity
- "who covers X?" / territory → get_territory
- Launch Dashboard properties → search_dashboard
- Find deals by name → search_deals
- Find contacts by name/email → search_contacts
- Rep audit / conflicts → run_audit

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
${learningsSection}
## Self-Validation (CRITICAL — do this BEFORE writing your response)
After receiving tool results and before answering, check your own math:
1. **Counts must add up.** If you state a total and then list per-rep numbers, the per-rep numbers MUST sum to the total. If they don't, use the per-rep breakdown (pitchByRep, recentRepActivity) as the source of truth and recompute the total.
2. **Dates must be in range.** If the user asked about "today", only include items dated today. If they asked about "this week", only include items within the last 7 days. Check the pitchDate or date fields in the tool results — do not assume every item returned is in range.
3. **List length must match stated count.** If you say "5 pitches" and then list deals, you must list exactly 5. If there are more than you can list, say "X pitches total, here are the top ones:".
4. **Use pre-computed breakdowns.** If the tool result includes pitchByRep, recentRepActivity, or similar pre-aggregated fields, use those numbers directly. Do NOT try to recount from the pitchList — it may be truncated.
5. **Don't invent data.** If a field is null or missing, don't guess. Say the data isn't available.
6. **Cross-check before responding.** Read your draft answer one more time. Does every number trace back to the tool result? If you can't point to where a number came from, remove it.

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
    description: 'Search for a company in HubSpot and get full intelligence: deals, contacts, engagements, territory conflicts. If not found in HubSpot, automatically runs ownership resolution. Use this for "venterra status", "show me [company]", "what\'s going on with [company]".',
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
    description: 'Fetch AP pipeline deals with optional filters. Returns deal summary with stage distribution, close times, win rates, pitch data, stale deals, and per-rep breakdown (repSummary). When called with NO rep filter, repSummary contains ALL reps with AP pipeline deals — use this for team-wide comparisons. IMPORTANT: check repSummary against the known reps list and call get_rep_activity for any missing reps.',
    input_schema: {
      type: 'object',
      properties: {
        rep: { type: 'string', description: 'Rep name to filter by (e.g. "Renato Lagomarsino"). Omit for all reps — repSummary will show every rep.' },
        stage: { type: 'string', description: 'Pipeline stage to filter by (e.g. "Contract Redline"). Omit for all stages.' },
        days: { type: 'number', description: 'Lookback window in days. When used with pitch_only, filters to pitches with pitch dates within this window. Omit for all time.' },
        pitch_only: { type: 'boolean', description: 'If true, only return deals with pitch dates. When combined with days, only includes deals whose pitch date falls within the days window.' }
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
    description: 'Run ownership resolution for a company/owner name. Applies the 5-tier hierarchy, enriches from cache/web, checks HubSpot. Use for "who owns X?", "check Camden", "who should own Greystar?".',
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Company or owner name to resolve' }
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
    description: 'Search the Launch Dashboard (Google Sheet) for property details: units, AE, PSM, signed date, expected launch. Use for "units at [property]", "PSM for [property]", "properties in Atlanta".',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Property name or search term' }
      },
      required: ['query']
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
  }
];

// ---------------------------------------------------------------------------
// Complexity detection — Haiku vs Sonnet
// ---------------------------------------------------------------------------

/**
 * Detect if a query is complex enough to warrant Sonnet instead of Haiku.
 * Complex = team-wide comparisons, multi-rep analysis, ranking all reps.
 */
function isComplexQuery(text) {
  const lower = (text || '').toLowerCase();

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
  const SONNET_MODEL = 'claude-sonnet-4-5-20241022';
  const HAIKU_MODEL = 'claude-haiku-4-5-20251001';
  let model = complex ? SONNET_MODEL : HAIKU_MODEL;
  if (complex) console.log('[apbot/agent] Complex query detected, trying Sonnet');

  const systemPrompt = buildSystemPrompt();

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

    while (turn < MAX_TURNS) {
      turn++;

      let response;
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
        const result = await executeTool(toolBlock.name, toolBlock.input);
        toolResults.push({
          type: 'tool_result',
          tool_use_id: toolBlock.id,
          content: JSON.stringify(result)
        });
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
        }

        messages.push({ role: 'user', content: corrResults });
      }
    }

    // Extract and save any learnings from the response
    const learningMatch = answer.match(/\[LEARNING:\s*(.+?)\]/i);
    if (learningMatch) {
      const correction = learningMatch[1].trim();
      saveLearning(correction, context);
      console.log(`[apbot/agent] Saved learning: ${correction}`);
      // Remove the learning tag from the user-facing response
      answer = answer.replace(/\[LEARNING:\s*.+?\]/i, '').trim();
    }

    // Save to memory — strip thinking blocks to keep memory lean
    saveMemory(context.userId, stripThinking(messages), null, null);

    const blocks = formatSlackBlocks(answer);
    return { blocks };

  } catch (err) {
    console.error('[apbot/agent] LLM error, falling back:', err.message);
    return handleFallback(text, callerRep, context);
  }
}

/**
 * Keyword fallback — when Anthropic API is unavailable.
 */
async function handleFallback(text, callerRep, context) {
  let resolvedText = text;
  if (callerRep && /\bmy\b/i.test(text)) {
    resolvedText = text.replace(/\bmy\b/gi, callerRep + "'s");
  }

  const match = keywordFallback(resolvedText);
  if (!match) {
    return { text: `I couldn't understand that. Try something like \`who owns Greystar?\` or \`my deals\`.` };
  }

  if (match.args && !match.args.rep && callerRep) {
    if (match.tool === 'get_pipeline_data' || match.tool === 'get_rep_activity') {
      match.args.rep = callerRep;
    }
  }

  try {
    const result = await executeTool(match.tool, match.args);
    const json = JSON.stringify(result, null, 2);
    const truncated = json.length > 2800 ? json.slice(0, 2800) + '\n…(truncated)' : json;
    return {
      blocks: [
        { type: 'section', text: { type: 'mrkdwn', text: `_⚠ Running in fallback mode (LLM unavailable)_` } },
        { type: 'section', text: { type: 'mrkdwn', text: '```' + truncated + '```' } }
      ]
    };
  } catch (err) {
    return { text: `Error: ${err.message}` };
  }
}

module.exports = { handleQuery };
