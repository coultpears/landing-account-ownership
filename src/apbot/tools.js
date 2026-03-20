'use strict';

/**
 * tools.js — Tool implementations for the /apbot agent
 *
 * Each function is callable by the LLM via tool_use. Returns plain JSON
 * (not Slack blocks) — the LLM formats the final response.
 *
 * Extracted from the former handler files (check.js, lookup.js, pipeline.js,
 * activity.js, territory.js, dashboard.js, audit.js, deal-detail.js).
 */

const fs   = require('fs');
const path = require('path');
const https = require('https');

const { resolve, getStateReps } = require('../engine');
const { qualify }               = require('../qualify');
const { enrichFromPropertyName, enrichOwnerHQ, looksLikePropertyName } = require('../search');
const { auditRep, KNOWN_REPS }  = require('../audit');
const { searchProperties }      = require('./datasources/launch-dashboard');
const { getContactsByCompany }  = require('./contacts');
const { summarizeDeals, summarizeActivity } = require('./summarize');

const {
  getOwners, getPortalId, getCompany, getDeal, getContact,
  searchCompanyByName, searchDealsByName, searchContacts,
  getDealStageLabels, getDealStageOrder,
  getAssociatedCompanyIds, getAssociatedIds,
  getEngagementsByOwner, getDealsByOwner,
  ensureOwnershipRuleProperty
} = require('../hubspot');

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

const DATA_DIR = path.join(__dirname, '..', '..', 'data');
const CACHE_PATH = path.join(DATA_DIR, 'cache.json');
const AP_PIPELINE_ID = '64402505';

function loadConfig() {
  try { return JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'config.json'), 'utf8')); }
  catch { return { slackToRep: {}, repOwnerIds: {} }; }
}

function loadAssignments() {
  try { return JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'assignments.json'), 'utf8')); }
  catch { return { stateAssignments: [], ownerAssignments: [] }; }
}

function loadCache() {
  try { return JSON.parse(fs.readFileSync(CACHE_PATH, 'utf8')); } catch { return {}; }
}
function saveCache(c) {
  try { fs.writeFileSync(CACHE_PATH, JSON.stringify(c, null, 2)); } catch {}
}
function cacheKey(q) { return q.toLowerCase().replace(/\s+/g, ' ').trim(); }

function getToken() { return process.env.HUBSPOT_TOKEN; }

function apiRequest(method, apiPath, body = null) {
  return new Promise((resolve, reject) => {
    const token = getToken();
    const bodyStr = body ? JSON.stringify(body) : null;
    const options = {
      hostname: 'api.hubapi.com', path: apiPath, method,
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        ...(bodyStr ? { 'Content-Length': Buffer.byteLength(bodyStr) } : {})
      }
    };
    const req = https.request(options, res => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        if (res.statusCode >= 400) reject(new Error(`HubSpot ${res.statusCode} ${method} ${apiPath}`));
        else { try { resolve(JSON.parse(data)); } catch { resolve(data); } }
      });
    });
    req.on('error', reject);
    req.setTimeout(20000, () => { req.destroy(); reject(new Error('Timeout')); });
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function parseTs(val) {
  if (!val) return 0;
  const n = Number(val);
  if (!isNaN(n) && n > 1000000000) return n;
  const d = new Date(val);
  return isNaN(d.getTime()) ? 0 : d.getTime();
}

function ownerNameFn(allOwners) {
  return (id) => {
    if (!id) return null;
    const o = allOwners.find(o => String(o.id) === String(id));
    return o ? `${o.firstName} ${o.lastName}`.trim() : null;
  };
}

function matchRepName(needle) {
  const norm = needle.toLowerCase().replace(/[^a-z\s]/g, '').trim();
  return KNOWN_REPS.find(r => r.toLowerCase() === norm)
    || KNOWN_REPS.find(r => r.toLowerCase().includes(norm))
    || KNOWN_REPS.find(r => norm.includes(r.split(' ')[0].toLowerCase()))
    || KNOWN_REPS.find(r => norm.split(/\s+/).some(w => w.length >= 3 && r.toLowerCase().includes(w)))
    || null;
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

// Deal properties used when fetching pipeline data
const AP_STAGES = {
  NEW_OPPORTUNITIES:   '126194574',
  CONTACTED:           '128203694',
  DEFINING_CALL:       '185461262',
  CALL_SCHEDULED:      '126194575',
  IC_REVIEW:           '1225117962',
  ACTIVE:              '126194576',
  LATE_STAGE:          '126194577',
  CONTRACT_DISCUSSIONS:'128915635',
  CONTRACT_REDLINE:    '126194578',
  CLOSED_WON:          '126194579',
  LOST_DEAL:           '1097165102'
};

const STAGE_DATE_PROPS = Object.values(AP_STAGES).flatMap(id => [
  `hs_v2_date_entered_${id}`,
  `hs_v2_date_exited_${id}`
]);

const DEAL_PROPS = [
  'dealname', 'dealstage', 'hubspot_owner_id', 'amount', 'pipeline',
  'createdate', 'closedate', 'notes_last_contacted', 'hs_lastmodifieddate',
  'hs_v2_time_in_current_stage', 'first_pitch_date__ap_', 'pitch_category',
  'in_person_pitch', 'hs_is_closed_won', 'closed_won_reason',
  'notes_last_updated',
  ...STAGE_DATE_PROPS
];

const CONTACT_PROPS = [
  'firstname', 'lastname', 'jobtitle', 'email', 'phone',
  'num_notes', 'notes_last_contacted', 'lastmodifieddate',
  'hubspot_owner_id'
];

const RULE_LABELS = {
  TOP_50:           'Top 50 Owner → Jack Harvey',
  LEASE_UP:         'Lease-Up → Xander Williams',
  OWNER_ASSIGNMENT: 'Owner-Level Assignment',
  STATE_FALLBACK:   'State/Regional Fallback',
  UNASSIGNED:       'Unassigned'
};

async function searchDealsAPI(filterGroups, properties, maxResults = 500) {
  const results = [];
  let after;
  do {
    const body = { filterGroups, properties, limit: 100, ...(after ? { after } : {}) };
    const res = await apiRequest('POST', '/crm/v3/objects/deals/search', body);
    results.push(...(res.results || []));
    after = res.paging?.next?.after;
    if (after) await sleep(200);
  } while (after && results.length < maxResults);
  return results;
}

// ===================================================================
// Tool: search_company
// ===================================================================

async function search_company({ name }) {
  if (!name) return { error: 'Company name is required.' };

  const [allOwners, portalId, stageLabels] = await Promise.all([
    getOwners(), getPortalId(), getDealStageLabels()
  ]);
  const ownerName = ownerNameFn(allOwners);

  const companyHits = await searchCompanyByName(name);

  if (companyHits.length === 0) {
    // Not in HubSpot — run ownership resolution
    const resolution = resolve({ ownerName: name });
    const suggestedReps = (Array.isArray(resolution.rep) ? resolution.rep : [resolution.rep])
      .filter(r => r && r !== 'UNASSIGNED');

    // Also check deals/contacts
    const [dealHits, contactHits] = await Promise.all([
      searchDealsByName(name).catch(() => []),
      searchContacts(name).catch(() => [])
    ]);

    return {
      found: false,
      query: name,
      ownership: {
        rule: resolution.rule,
        ruleLabel: RULE_LABELS[resolution.rule] || resolution.rule,
        assignedTo: suggestedReps.length > 0 ? suggestedReps : ['UNASSIGNED'],
        explanation: resolution.explanation,
        warnings: resolution.warnings
      },
      relatedDeals: dealHits.slice(0, 5).map(d => {
        const dp = d.properties || {};
        return {
          id: d.id, name: dp.dealname || '(unnamed)',
          stage: stageLabels[dp.dealstage] || dp.dealstage || 'Unknown',
          owner: ownerName(dp.hubspot_owner_id) || 'unassigned',
          link: `https://app.hubspot.com/contacts/${portalId}/deal/${d.id}`
        };
      }),
      relatedContacts: contactHits.slice(0, 5).map(c => {
        const cp = c.properties || {};
        return {
          id: c.id,
          name: [cp.firstname, cp.lastname].filter(Boolean).join(' ') || '(unnamed)',
          email: cp.email || null,
          link: `https://app.hubspot.com/contacts/${portalId}/contact/${c.id}`
        };
      }),
      _hints: 'Company not found in HubSpot. Show the ownership resolution result. ' +
        'If relatedDeals or relatedContacts exist, mention them with links. ' +
        'Suggest the user create a company record if appropriate.'
    };
  }

  // Company found — fetch all associated data
  const companyId = companyHits[0].id;
  const company = await getCompany(companyId);
  const cp = company.properties || {};

  const [dealAssoc, contactAssoc] = await Promise.all([
    getAssociatedIds('companies', 'deals', [companyId]).catch(() => ({})),
    getAssociatedIds('companies', 'contacts', [companyId]).catch(() => ({}))
  ]);

  const dealIds = dealAssoc[companyId] || [];
  const contactIds = contactAssoc[companyId] || [];

  // Batch-read deals
  let deals = [];
  if (dealIds.length > 0) {
    try {
      const res = await apiRequest('POST', '/crm/v3/objects/deals/batch/read', {
        inputs: dealIds.slice(0, 50).map(id => ({ id: String(id) })),
        properties: DEAL_PROPS
      });
      deals = res.results || [];
    } catch { /* non-fatal */ }
    await sleep(250);
  }

  // Batch-read contacts
  let contacts = [];
  if (contactIds.length > 0) {
    try {
      const res = await apiRequest('POST', '/crm/v3/objects/contacts/batch/read', {
        inputs: contactIds.slice(0, 20).map(id => ({ id: String(id) })),
        properties: CONTACT_PROPS
      });
      contacts = res.results || [];
    } catch { /* non-fatal */ }
    await sleep(250);
  }

  // Fetch engagements
  const engSummary = { calls: 0, emails: 0, meetings: 0, tasks: 0 };
  let mostRecentEngagement = null;
  let mostRecentTs = 0;

  for (const type of ['calls', 'emails', 'meetings', 'tasks']) {
    try {
      const engAssoc = await getAssociatedIds('companies', type, [companyId]);
      const engIds = (engAssoc[companyId] || []).slice(0, 30);
      if (engIds.length > 0) {
        const props = {
          calls: ['hs_call_title', 'hs_timestamp'],
          emails: ['hs_email_subject', 'hs_timestamp'],
          meetings: ['hs_meeting_title', 'hs_timestamp'],
          tasks: ['hs_task_subject', 'hs_timestamp']
        };
        const res = await apiRequest('POST', `/crm/v3/objects/${type}/batch/read`, {
          inputs: engIds.map(id => ({ id: String(id) })),
          properties: props[type]
        });
        for (const e of (res.results || [])) {
          engSummary[type]++;
          const ts = parseTs(e.properties?.hs_timestamp);
          if (ts > mostRecentTs) {
            mostRecentTs = ts;
            const title = e.properties?.hs_call_title || e.properties?.hs_email_subject
              || e.properties?.hs_meeting_title || e.properties?.hs_task_subject || '';
            mostRecentEngagement = {
              type, title,
              date: new Date(ts).toISOString().slice(0, 10),
              daysAgo: Math.floor((Date.now() - ts) / 86400000)
            };
          }
        }
      }
    } catch { /* non-fatal */ }
    await sleep(200);
  }

  // Territory conflict detection
  const market = [cp.city, cp.state].filter(Boolean).join(' ');
  let territoryConflicts = null;
  if (market) {
    const assignments = loadAssignments();
    const stateResult = getStateReps(market, assignments);
    if (stateResult) {
      const expectedNames = stateResult.reps.map(r => r.toLowerCase());
      const conflicts = [];

      const companyOwner = ownerName(cp.hubspot_owner_id);
      if (companyOwner && !expectedNames.includes(companyOwner.toLowerCase())) {
        const isOwnerAssignment = assignments.ownerAssignments.some(
          a => a.rep.toLowerCase() === companyOwner.toLowerCase()
        );
        if (!isOwnerAssignment) {
          conflicts.push({
            type: 'company', record: cp.name,
            currentOwner: companyOwner,
            expectedReps: stateResult.reps
          });
        }
      }

      for (const d of deals) {
        const dp = d.properties || {};
        const stage = stageLabels[dp.dealstage] || dp.dealstage || 'Unknown';
        if (stage === 'Closed Won' || stage === 'Closed Lost' || stage === 'Lost Deal') continue;
        const dealOwner = ownerName(dp.hubspot_owner_id);
        if (dealOwner && !expectedNames.includes(dealOwner.toLowerCase())) {
          const isOA = assignments.ownerAssignments.some(a => a.rep.toLowerCase() === dealOwner.toLowerCase());
          if (!isOA) {
            conflicts.push({
              type: 'deal', record: dp.dealname,
              currentOwner: dealOwner, expectedReps: stateResult.reps
            });
          }
        }
      }

      territoryConflicts = {
        market, stateCode: stateResult.stateCode,
        expectedReps: stateResult.details.map(d => ({ rep: d.rep, focus: d.focus || null })),
        conflicts, hasConflicts: conflicts.length > 0
      };
    }
  }

  // Build deal summaries
  const dealSummaries = deals.map(d => {
    const dp = d.properties || {};
    const stage = stageLabels[dp.dealstage] || dp.dealstage || 'Unknown';
    const lastMod = parseTs(dp.hs_lastmodifieddate);
    return {
      id: d.id,
      name: dp.dealname || '(unnamed)',
      stage,
      owner: ownerName(dp.hubspot_owner_id) || 'unassigned',
      amount: dp.amount ? Number(dp.amount) : null,
      pipeline: dp.pipeline === AP_PIPELINE_ID ? 'AP Pipeline' : 'Other',
      created: dp.createdate ? new Date(dp.createdate).toISOString().slice(0, 10) : null,
      closeDate: dp.closedate ? new Date(dp.closedate).toISOString().slice(0, 10) : null,
      lastModifiedDaysAgo: lastMod ? Math.floor((Date.now() - lastMod) / 86400000) : null,
      pitchDate: dp.first_pitch_date__ap_ || null,
      link: `https://app.hubspot.com/contacts/${portalId}/deal/${d.id}`
    };
  }).sort((a, b) => (a.lastModifiedDaysAgo ?? 999) - (b.lastModifiedDaysAgo ?? 999));

  // Build contact summaries
  const contactSummaries = contacts.map(c => {
    const ctp = c.properties || {};
    return {
      id: c.id,
      name: [ctp.firstname, ctp.lastname].filter(Boolean).join(' ') || '(unnamed)',
      title: ctp.jobtitle || null,
      email: ctp.email || null,
      phone: ctp.phone || null,
      owner: ownerName(ctp.hubspot_owner_id) || null,
      numNotes: parseInt(ctp.num_notes || '0', 10),
      lastContacted: ctp.notes_last_contacted || null
    };
  }).sort((a, b) => b.numNotes - a.numNotes);

  const companyLink = `https://app.hubspot.com/contacts/${portalId}/company/${companyId}`;

  return {
    found: true,
    company: {
      id: companyId,
      name: cp.name || '(unnamed)',
      city: cp.city || null,
      state: cp.state || null,
      industry: cp.industry || null,
      domain: cp.domain || null,
      owner: ownerName(cp.hubspot_owner_id) || 'unassigned',
      link: companyLink
    },
    deals: { count: dealSummaries.length, records: dealSummaries.slice(0, 20) },
    contacts: { count: contactSummaries.length, records: contactSummaries.slice(0, 10) },
    engagements: {
      ...engSummary,
      total: engSummary.calls + engSummary.emails + engSummary.meetings + engSummary.tasks,
      mostRecent: mostRecentEngagement
    },
    territoryConflicts,
    asOfDate: new Date().toISOString().slice(0, 10),
    _hints: 'Each deal record includes a "link" field — ALWAYS include this in your response as <link|deal name>. ' +
      'If territoryConflicts.hasConflicts is true, flag it prominently with ⚠. ' +
      'The company.link field is the HubSpot company link — include it in your response.'
  };
}

// ===================================================================
// Tool: get_pipeline_data
// ===================================================================

async function get_pipeline_data({ rep, stage, days, pitch_only }) {
  const config = loadConfig();
  const allOwners = await getOwners();
  const stageLabels = await getDealStageLabels();

  const filters = [
    { propertyName: 'pipeline', operator: 'EQ', value: AP_PIPELINE_ID }
  ];

  // Resolve rep to owner ID
  let repName = null;
  if (rep) {
    repName = matchRepName(rep);
    if (repName) {
      const owner = matchOwner(repName, allOwners);
      if (owner) {
        filters.push({ propertyName: 'hubspot_owner_id', operator: 'EQ', value: String(owner.id) });
      }
    }
  }

  if (stage) {
    const stageId = Object.entries(stageLabels).find(
      ([id, label]) => label.toLowerCase().includes(stage.toLowerCase())
    )?.[0];
    if (stageId) {
      filters.push({ propertyName: 'dealstage', operator: 'EQ', value: stageId });
    }
  }

  if (pitch_only) {
    filters.push({ propertyName: 'first_pitch_date__ap_', operator: 'HAS_PROPERTY' });
  }

  // When days is specified, add a date filter so we only get recently active deals
  // This is critical — the pipeline has 1000+ deals total, so without a date filter
  // we'd miss recent closes that fall outside the first 500 results
  if (days) {
    const cutoffMs = Date.now() - days * 86400000;
    const cutoffStr = new Date(cutoffMs).toISOString().split('.')[0] + 'Z';
    filters.push({ propertyName: 'hs_lastmodifieddate', operator: 'GTE', value: cutoffStr });
  }

  const maxDeals = days ? 2000 : 2000;
  const deals = await searchDealsAPI([{ filters }], DEAL_PROPS, maxDeals);

  // Build summary using shared summarizer (all-time stats for the fetched deals)
  const summary = summarizeDeals(deals, stageLabels, allOwners);

  // When days is specified, add time-scoped metrics so the LLM uses recent data
  if (days) {
    const now = Date.now();
    const cutoff = now - days * 86400000;
    const CLOSED_WON_ID = '126194579';
    const LOST_DEAL_ID = '1097165102';
    const portalId = await getPortalId();
    const ownerName = ownerNameFn(allOwners);

    // Deals that entered Closed Won within the time window
    const recentWins = deals.filter(d => {
      const dp = d.properties || {};
      const enteredWon = dp[`hs_v2_date_entered_${CLOSED_WON_ID}`];
      if (!enteredWon) return false;
      const ts = new Date(enteredWon).getTime();
      return !isNaN(ts) && ts >= cutoff;
    }).map(d => {
      const dp = d.properties || {};
      return {
        name: dp.dealname || '(unnamed)',
        owner: ownerName(dp.hubspot_owner_id) || 'unassigned',
        amount: dp.amount ? Number(dp.amount) : null,
        closedDate: dp[`hs_v2_date_entered_${CLOSED_WON_ID}`]
          ? new Date(dp[`hs_v2_date_entered_${CLOSED_WON_ID}`]).toISOString().slice(0, 10) : null,
        link: `https://app.hubspot.com/contacts/${portalId}/deal/${d.id}`
      };
    });

    // Deals that entered Lost Deal within the time window
    const recentLosses = deals.filter(d => {
      const dp = d.properties || {};
      const enteredLost = dp[`hs_v2_date_entered_${LOST_DEAL_ID}`];
      if (!enteredLost) return false;
      const ts = new Date(enteredLost).getTime();
      return !isNaN(ts) && ts >= cutoff;
    }).map(d => {
      const dp = d.properties || {};
      return {
        name: dp.dealname || '(unnamed)',
        owner: ownerName(dp.hubspot_owner_id) || 'unassigned',
        link: `https://app.hubspot.com/contacts/${portalId}/deal/${d.id}`
      };
    });

    // Deals created within the time window
    const recentCreated = deals.filter(d => {
      const ts = new Date(d.properties?.createdate || 0).getTime();
      return ts >= cutoff;
    }).length;

    // Per-rep breakdown scoped to the time window
    const recentRepActivity = {};
    for (const d of deals) {
      const dp = d.properties || {};
      const rep = ownerName(dp.hubspot_owner_id) || 'Unknown';
      if (!recentRepActivity[rep]) recentRepActivity[rep] = { deals: 0, won: 0, lost: 0, created: 0, pitches: 0 };

      // Count deals modified in window
      const lastMod = parseTs(dp.hs_lastmodifieddate);
      if (lastMod >= cutoff) recentRepActivity[rep].deals++;

      // Count wins in window
      const enteredWon = dp[`hs_v2_date_entered_${CLOSED_WON_ID}`];
      if (enteredWon && new Date(enteredWon).getTime() >= cutoff) recentRepActivity[rep].won++;

      // Count losses in window
      const enteredLost = dp[`hs_v2_date_entered_${LOST_DEAL_ID}`];
      if (enteredLost && new Date(enteredLost).getTime() >= cutoff) recentRepActivity[rep].lost++;

      // Count created in window
      const created = new Date(dp.createdate || 0).getTime();
      if (created >= cutoff) recentRepActivity[rep].created++;

      // Count pitches in window
      const pitchDate = dp.first_pitch_date__ap_;
      if (pitchDate && new Date(pitchDate).getTime() >= cutoff) recentRepActivity[rep].pitches++;
    }

    summary.timeWindow = {
      days,
      cutoffDate: new Date(cutoff).toISOString().slice(0, 10),
      recentWins: { count: recentWins.length, deals: recentWins },
      recentLosses: { count: recentLosses.length, deals: recentLosses },
      recentDealsCreated: recentCreated,
      recentRepActivity,
      _note: `These metrics are scoped to the last ${days} days. Closed Won is determined by hs_v2_date_entered (stage entry date), not the closedate field. USE THESE NUMBERS for any "this week/month" questions — not the all-time counts above.`
    };
  }

  // If pitch_only, build a pitch list filtered by date window
  if (pitch_only) {
    const portalId = await getPortalId();
    const ownerName = ownerNameFn(allOwners);
    const now = Date.now();

    // Compare pitch dates as date strings (YYYY-MM-DD) to avoid timezone issues.
    // HubSpot stores pitch dates as date-only values — comparing as strings in
    // US Central time (Landing's timezone) gives the right results.
    const toDateStr = (ms) => {
      const d = new Date(ms);
      // Convert to US Central time (UTC-5 or UTC-6 depending on DST)
      const central = new Date(d.toLocaleString('en-US', { timeZone: 'America/Chicago' }));
      return central.toISOString().slice(0, 10);
    };
    const todayStr = toDateStr(now);
    const cutoffStr = days ? toDateStr(now - days * 86400000) : null;

    const filteredPitches = deals
      .filter(d => {
        const pitchDate = (d.properties?.first_pitch_date__ap_ || '').slice(0, 10);
        if (!pitchDate) return false;
        // Exclude future pitch dates — only show pitches up to today
        if (pitchDate > todayStr) return false;
        // When days is set, only include pitches within the date window
        if (cutoffStr && pitchDate < cutoffStr) return false;
        return true;
      })
      .sort((a, b) => {
        const da = new Date(a.properties.first_pitch_date__ap_).getTime();
        const db = new Date(b.properties.first_pitch_date__ap_).getTime();
        return db - da;
      });

    // Count before slicing so the LLM gets the true total
    const totalPitchCount = filteredPitches.length;

    // Per-rep pitch breakdown from filtered results
    const pitchByRep = {};
    for (const d of filteredPitches) {
      const rep = ownerName(d.properties?.hubspot_owner_id) || 'Unknown';
      pitchByRep[rep] = (pitchByRep[rep] || 0) + 1;
    }

    const pitchDeals = filteredPitches
      .slice(0, 50)
      .map(d => {
        const dp = d.properties || {};
        const pitchDateStr = (dp.first_pitch_date__ap_ || '').slice(0, 10);
        // Calculate daysAgo using date strings to avoid timezone drift
        const daysDiff = Math.round((new Date(todayStr) - new Date(pitchDateStr)) / 86400000);
        return {
          name: dp.dealname || '(unnamed)',
          pitchDate: pitchDateStr,
          daysAgo: daysDiff,
          stage: stageLabels[dp.dealstage] || dp.dealstage || 'Unknown',
          owner: ownerName(dp.hubspot_owner_id) || 'unassigned',
          category: dp.pitch_category || null,
          inPerson: dp.in_person_pitch || null,
          link: `https://app.hubspot.com/contacts/${portalId}/deal/${d.id}`
        };
      });
    summary.pitchList = pitchDeals;
    summary.pitchCountInWindow = totalPitchCount;
    summary.pitchByRep = pitchByRep;
    if (days) {
      summary.pitchWindowNote = `Only pitches with pitch dates in the last ${days} days are included.`;
    }
  }

  summary.filters = { rep: repName, stage: stage || null, pitchOnly: !!pitch_only };
  summary._hints = 'repSummary contains ALL-TIME per-rep breakdown. ' +
    'CRITICAL: When "days" was specified, a "timeWindow" object is included with time-scoped metrics. ' +
    'For "this week/month" questions, ALWAYS use timeWindow.recentWins, timeWindow.recentLosses, ' +
    'timeWindow.recentRepActivity, and timeWindow.recentDealsCreated — NOT the all-time counts. ' +
    'timeWindow.recentRepActivity has per-rep won/lost/created/pitches counts scoped to the time window. ' +
    'Check repSummary reps against the known roster: ' + KNOWN_REPS.join(', ') + '. ' +
    'Any roster rep NOT in repSummary has no AP pipeline deals — call get_rep_activity for them. ' +
    'pitchList (if present) contains deals with links — ALWAYS include <link|deal name> for every deal you mention. ' +
    'pitchCountInWindow is the TRUE total pitch count for the window — use this number, not the list length. ' +
    'pitchByRep (if present) has the exact per-rep pitch counts — use these for breakdowns, do NOT count from pitchList.';
  return summary;
}

// ===================================================================
// Tool: get_rep_activity
// ===================================================================

async function get_rep_activity({ rep, days }) {
  const daysBack = days || 30;
  const repName = matchRepName(rep);
  if (!repName) return { error: `No rep found matching "${rep}". Available: ${KNOWN_REPS.join(', ')}` };

  const allOwners = await getOwners();
  const owner = matchOwner(repName, allOwners);
  if (!owner) return { error: `No HubSpot owner found for "${repName}".` };

  const ownerId = owner.id;
  const stageLabels = await getDealStageLabels();

  // Fetch data sequentially (HubSpot rate limits)
  const deals = await getDealsByOwner(ownerId, daysBack);
  await sleep(250);
  const calls = await getEngagementsByOwner('calls', ownerId, daysBack, 500);
  await sleep(250);
  const emails = await getEngagementsByOwner('emails', ownerId, daysBack, 200);
  await sleep(250);
  const meetings = await getEngagementsByOwner('meetings', ownerId, daysBack, 500);
  await sleep(250);
  const tasks = await getEngagementsByOwner('tasks', ownerId, daysBack, 500);

  const actSummary = summarizeActivity(repName, daysBack, deals, calls, emails, meetings, tasks, stageLabels);

  // Stage coverage gaps
  const stageOrder = await getDealStageOrder();
  const terminalStages = new Set(['Closed Won', 'Closed Lost', 'Lost Deal']);
  const allStages = Object.keys(stageOrder).filter(s => !terminalStages.has(s))
    .sort((a, b) => (stageOrder[a] ?? 999) - (stageOrder[b] ?? 999));
  const workedStages = Object.keys(actSummary.stageActivity);
  const unworkedStages = allStages.filter(s => !workedStages.includes(s));

  actSummary.stageCoverageGaps = unworkedStages;
  actSummary.allPipelineStages = allStages;
  actSummary._hints = 'totalEngagements = calls + emails + meetings + tasks. ' +
    'dealsCreated = new deals in the window, dealsModified = existing deals touched. ' +
    'stageCoverageGaps shows pipeline stages with zero activity — flag these as areas needing attention. ' +
    'weeklyTrend shows engagement volume by week — use this for trending comparisons. ' +
    'Email count is capped at 200 (HubSpot auto-logs marketing emails under rep IDs).';

  return actSummary;
}

// ===================================================================
// Tool: resolve_ownership
// ===================================================================

async function resolve_ownership({ name }) {
  if (!name) return { error: 'Name is required.' };

  const input = {
    ownerName: name,
    market: null, ownerHQ: null,
    isLeaseUp: false, propertyClass: null, propertyType: null
  };

  // Enrichment: cache → property name → HQ
  const cache = loadCache();
  const key = cacheKey(input.ownerName);

  if (cache[key]) {
    const c = cache[key];
    if (c.ownerName) input.ownerName = c.ownerName;
    if (c.market)    input.market    = c.market;
    if (c.ownerHQ)   input.ownerHQ   = c.ownerHQ;
  } else if (looksLikePropertyName(input.ownerName)) {
    const enriched = await enrichFromPropertyName(input.ownerName);
    const toCache = { cachedAt: new Date().toISOString() };
    if (enriched.ownerName) { input.ownerName = toCache.ownerName = enriched.ownerName; }
    if (enriched.market)    { input.market    = toCache.market    = enriched.market; }
    if (enriched.ownerHQ)   { input.ownerHQ   = toCache.ownerHQ   = enriched.ownerHQ; }
    if (Object.keys(toCache).length > 1) { cache[key] = toCache; saveCache(cache); }
  } else if (!input.ownerHQ && !input.market) {
    const hq = await enrichOwnerHQ(input.ownerName);
    if (hq) {
      input.ownerHQ = hq;
      cache[key] = { ownerHQ: hq, cachedAt: new Date().toISOString() };
      saveCache(cache);
    }
  }

  // Qualification gate
  const qual = qualify(input);
  if (!qual.qualified) {
    return { disqualified: true, reasons: qual.reasons, query: name };
  }

  let result = resolve(input);

  // HubSpot lookup for location + re-resolve
  let companyInfo = null;
  try {
    const [hits, portalId, allOwners] = await Promise.all([
      searchCompanyByName(input.ownerName),
      getPortalId(),
      getOwners()
    ]);

    if (hits.length > 0) {
      const company = await getCompany(hits[0].id);
      const p = company.properties || {};
      const ownerName = ownerNameFn(allOwners);

      companyInfo = {
        id: hits[0].id,
        name: p.name || null,
        currentOwner: ownerName(p.hubspot_owner_id) || 'unassigned',
        link: `https://app.hubspot.com/contacts/${portalId}/company/${hits[0].id}`
      };

      const hsMarket = [p.city, p.state].filter(Boolean).join(' ');
      if (hsMarket && !input.market && !input.ownerHQ) {
        const retried = resolve({ ...input, market: hsMarket });
        if (retried.rule !== 'UNASSIGNED') {
          result = retried;
          input.market = hsMarket;
        }
      }
    }
  } catch { /* non-fatal */ }

  // Top contacts
  let topContacts = [];
  if (companyInfo) {
    try {
      topContacts = await getContactsByCompany(companyInfo.id, 2);
    } catch { /* non-fatal */ }
  }

  const suggestedReps = (Array.isArray(result.rep) ? result.rep : [result.rep])
    .filter(r => r && r !== 'UNASSIGNED');

  return {
    query: name,
    matchedOwner: result.matchedOwner || null,
    rule: result.rule,
    ruleLabel: RULE_LABELS[result.rule] || result.rule,
    assignedTo: suggestedReps.length > 0 ? suggestedReps : ['UNASSIGNED'],
    explanation: result.explanation,
    warnings: result.warnings,
    hubspot: companyInfo,
    topContacts: topContacts.map(c => ({
      name: c.name, title: c.title, email: c.email, phone: c.phone
    })),
    _hints: 'Include the hubspot.link in your response. If warnings exist, show them. ' +
      'assignedTo is who SHOULD own this account per the rules.'
  };
}

// ===================================================================
// Tool: get_territory
// ===================================================================

async function get_territory({ location }) {
  if (!location) return { error: 'Location is required.' };

  const assignments = loadAssignments();
  const result = getStateReps(location, assignments);

  if (!result) {
    return { found: false, query: location, message: `No territory assignment found for "${location}".` };
  }

  return {
    found: true,
    query: location,
    stateCode: result.stateCode,
    reps: result.details.map(d => ({ rep: d.rep, focus: d.focus || null })),
    fallback: result.fallback || false,
    multipleReps: result.reps.length > 1,
    _hints: 'If fallback is true, the city did not match any sub-market — show all reps with a coordination warning. ' +
      'If multipleReps is true, each rep has a different sub-market focus — explain which covers what.'
  };
}

// ===================================================================
// Tool: search_dashboard
// ===================================================================

async function search_dashboard({ query }) {
  if (!query) return { error: 'Search query is required.' };

  let rows;
  try {
    rows = await searchProperties(query);
  } catch (err) {
    if (err.message.includes('not configured')) {
      return { error: 'LAUNCH_DASHBOARD_CSV_URL is not configured.' };
    }
    throw err;
  }

  if (rows.length === 0) {
    return { found: false, query, message: `No properties found matching "${query}".` };
  }

  return {
    found: true,
    query,
    count: rows.length,
    properties: rows.slice(0, 15).map(row => ({
      name: row['Property Name'] || '(unnamed)',
      market: row['Market'] || null,
      units: row['Unit Count'] || row['Total Unit Count'] || null,
      ae: row['Account Executive'] || row['AP Sales Person'] || null,
      psm: row['Partner Success manager'] || null,
      opsCoordinator: row['Operations Coordinator'] || row['AP Coordinator'] || null,
      signedDate: row['Signed Date'] || row['Contract Signed Date'] || null,
      expectedLaunch: row['Expected Launch'] || null,
      link: row['Link'] || null,
      source: row['_source'] || null
    })),
    _hints: 'Include property links when available. Show units, AE, PSM, market, and launch dates for each property. ' +
      'The "source" field indicates which dashboard tab the data came from. ' +
      'When a market column is present, location-based queries will return accurate results.'
  };
}

// ===================================================================
// Tool: search_deals
// ===================================================================

async function search_deals({ query }) {
  if (!query) return { error: 'Search query is required.' };

  const [hits, stageLabels, allOwners, portalId] = await Promise.all([
    searchDealsByName(query),
    getDealStageLabels(),
    getOwners(),
    getPortalId()
  ]);
  const ownerName = ownerNameFn(allOwners);

  return {
    count: hits.length,
    deals: hits.slice(0, 10).map(d => {
      const dp = d.properties || {};
      return {
        id: d.id,
        name: dp.dealname || '(unnamed)',
        stage: stageLabels[dp.dealstage] || dp.dealstage || 'Unknown',
        owner: ownerName(dp.hubspot_owner_id) || 'unassigned',
        amount: dp.amount ? Number(dp.amount) : null,
        lastModified: dp.hs_lastmodifieddate || null,
        link: `https://app.hubspot.com/contacts/${portalId}/deal/${d.id}`
      };
    }),
    _hints: 'Every deal has a "link" field. ALWAYS include it as <link|deal name> in your response.'
  };
}

// ===================================================================
// Tool: search_contacts
// ===================================================================

async function search_contacts_tool({ query }) {
  if (!query) return { error: 'Search query is required.' };

  const [hits, allOwners, portalId] = await Promise.all([
    searchContacts(query),
    getOwners(),
    getPortalId()
  ]);
  const ownerName = ownerNameFn(allOwners);

  return {
    count: hits.length,
    contacts: hits.slice(0, 10).map(c => {
      const cp = c.properties || {};
      return {
        id: c.id,
        name: [cp.firstname, cp.lastname].filter(Boolean).join(' ') || '(unnamed)',
        email: cp.email || null,
        phone: cp.phone || null,
        title: cp.jobtitle || null,
        owner: ownerName(cp.hubspot_owner_id) || null,
        link: `https://app.hubspot.com/contacts/${portalId}/contact/${c.id}`
      };
    }),
    _hints: 'Include contact links as <link|contact name> in your response.'
  };
}

// ===================================================================
// Tool: run_audit
// ===================================================================

async function run_audit({ rep, days }) {
  const daysBack = days || 90;
  const repName = matchRepName(rep);
  if (!repName) return { error: `No rep found matching "${rep}". Available: ${KNOWN_REPS.join(', ')}` };

  try { await ensureOwnershipRuleProperty(); } catch { /* non-fatal */ }

  const result = await auditRep(repName, { daysBack, qualifiedOnly: false });
  if (result.error) return { error: result.error };

  const { conflicts, companies, excluded, summary, stageAverages, stageOrder } = result;

  // Stage averages sorted by pipeline order
  const stageAvgSorted = Object.entries(stageAverages || {})
    .sort((a, b) => (stageOrder[a[0]] ?? 999) - (stageOrder[b[0]] ?? 999))
    .map(([stage, s]) => ({ stage, deals: s.deals, avgTouchpoints: s.avgTouchpoints }));

  return {
    rep: repName,
    daysBack,
    companiesHit: companies.length,
    excluded,
    conflictCount: conflicts.length,
    activity: summary,
    stageAverages: stageAvgSorted,
    conflicts: conflicts.slice(0, 15).map(c => ({
      companyName: c.companyName,
      market: c.market,
      daysSince: c.daysSince,
      qualStatus: c.qualStatus,
      workingRep: c.workingRep,
      expectedRep: c.expectedRep,
      rule: c.rule,
      ruleLabel: RULE_LABELS[c.rule] || c.rule,
      link: c.link
    })),
    _hints: 'Each conflict has a "link" field — include as <link|company name>. ' +
      'conflictCount is the total, but only the top 15 are shown. ' +
      'activity contains deals, emails, calls, meetings, tasks counts.'
  };
}

// ===================================================================
// Registry — maps tool names to implementations
// ===================================================================

const TOOL_REGISTRY = {
  search_company,
  get_pipeline_data,
  get_rep_activity,
  resolve_ownership,
  get_territory,
  search_dashboard,
  search_deals,
  search_contacts: search_contacts_tool,
  run_audit
};

/**
 * Execute a tool by name. Returns JSON result.
 */
async function executeTool(name, args) {
  const fn = TOOL_REGISTRY[name];
  if (!fn) return { error: `Unknown tool: ${name}` };

  try {
    return await fn(args || {});
  } catch (err) {
    console.error(`[apbot/tools] ${name} failed:`, err.message);
    return { error: `Tool ${name} failed: ${err.message}` };
  }
}

module.exports = { executeTool, TOOL_REGISTRY, KNOWN_REPS };
