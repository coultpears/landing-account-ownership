'use strict';

/**
 * lookup.js — /apbot lookup handler (smart company intelligence)
 *
 * When the query matches a company, fetches all associated data
 * (deals, contacts, engagements) and uses the smart analyst to
 * answer any question about that company. Supports follow-ups.
 *
 * For numeric IDs, does a direct record lookup.
 * For rep names, shows territory.
 */

const {
  getOwners, getPortalId, getCompany, getDeal, getContact,
  searchCompanyByName, searchDealsByName, searchContacts,
  getDealStageLabels, getAssociatedCompanyIds, getAssociatedIds,
  getEngagementsByOwner, getDealsByOwner
} = require('../../hubspot');
const { KNOWN_REPS } = require('../../audit');
const { getStateReps } = require('../../engine');
const { analyze } = require('../analyst');

const fs   = require('fs');
const path = require('path');

function loadAssignments() {
  try {
    return JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', '..', 'data', 'assignments.json'), 'utf8'));
  } catch { return { stateAssignments: [], ownerAssignments: [] }; }
}

const https = require('https');

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
        if (res.statusCode >= 400) reject(new Error(`HubSpot ${res.statusCode}`));
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

const AP_PIPELINE_ID = '64402505';

const DEAL_PROPS = [
  'dealname', 'dealstage', 'hubspot_owner_id', 'amount', 'pipeline',
  'createdate', 'closedate', 'hs_lastmodifieddate', 'notes_last_contacted',
  'hs_v2_time_in_current_stage', 'first_pitch_date__ap_',
  'hs_is_closed_won', 'closed_won_reason'
];

const CONTACT_PROPS = [
  'firstname', 'lastname', 'jobtitle', 'email', 'phone',
  'num_notes', 'notes_last_contacted', 'lastmodifieddate',
  'hubspot_owner_id'
];

function humanizeDays(n) {
  if (n === null || n === undefined) return '—';
  if (n <= 0) return 'today';
  if (n === 1) return 'yesterday';
  if (n < 7) return `${n}d ago`;
  if (n < 30) return `${Math.round(n / 7)}w ago`;
  if (n < 365) return `${Math.round(n / 30)}mo ago`;
  return `${Math.round(n / 365)}y ago`;
}

function parseTs(val) {
  if (!val) return 0;
  const n = Number(val);
  if (!isNaN(n) && n > 1000000000) return n;
  const d = new Date(val);
  return isNaN(d.getTime()) ? 0 : d.getTime();
}

/**
 * Build a compact company intelligence summary for the analyst.
 */
function summarizeCompany(company, deals, contacts, engagements, stageLabels, allOwners, portalId) {
  const ownerName = (id) => {
    const o = allOwners.find(o => String(o.id) === String(id));
    return o ? `${o.firstName} ${o.lastName}`.trim() : null;
  };

  const cp = company.properties || {};
  const companyLink = `https://app.hubspot.com/contacts/${portalId}/company/${company.id}`;

  // Deals summary
  const dealSummaries = deals.map(d => {
    const dp = d.properties || {};
    const stage = stageLabels[dp.dealstage] || dp.dealstage || 'Unknown';
    const lastMod = parseTs(dp.hs_lastmodifieddate);
    const daysAgo = lastMod ? Math.floor((Date.now() - lastMod) / 86400000) : null;
    return {
      id: d.id,
      name: dp.dealname || '(unnamed)',
      stage,
      owner: ownerName(dp.hubspot_owner_id) || 'unassigned',
      amount: dp.amount ? Number(dp.amount) : null,
      pipeline: dp.pipeline === AP_PIPELINE_ID ? 'AP Pipeline' : 'Other',
      created: dp.createdate ? new Date(dp.createdate).toISOString().slice(0, 10) : null,
      closeDate: dp.closedate ? new Date(dp.closedate).toISOString().slice(0, 10) : null,
      lastModifiedDaysAgo: daysAgo,
      pitchDate: dp.first_pitch_date__ap_ || null,
      lastContacted: dp.notes_last_contacted || null,
      link: `https://app.hubspot.com/contacts/${portalId}/deal/${d.id}`
    };
  });

  // Sort deals by last modified (most recent first)
  dealSummaries.sort((a, b) => (a.lastModifiedDaysAgo ?? 999) - (b.lastModifiedDaysAgo ?? 999));

  // Contacts summary
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
      lastContacted: ctp.notes_last_contacted || null,
      lastModified: ctp.lastmodifieddate || null
    };
  });

  contactSummaries.sort((a, b) => b.numNotes - a.numNotes);

  // Engagement summary
  const engSummary = { calls: 0, emails: 0, meetings: 0, tasks: 0 };
  let mostRecentEngagement = null;
  let mostRecentTs = 0;

  for (const e of engagements) {
    const type = e._type || 'unknown';
    if (engSummary[type] !== undefined) engSummary[type]++;
    const ts = parseTs(e.properties?.hs_timestamp);
    if (ts > mostRecentTs) {
      mostRecentTs = ts;
      const title = e.properties?.hs_call_title || e.properties?.hs_email_subject
        || e.properties?.hs_meeting_title || e.properties?.hs_task_subject || '';
      mostRecentEngagement = {
        type,
        title,
        date: new Date(ts).toISOString().slice(0, 10),
        daysAgo: Math.floor((Date.now() - ts) / 86400000)
      };
    }
  }

  return {
    company: {
      id: company.id,
      name: cp.name || '(unnamed)',
      city: cp.city || null,
      state: cp.state || null,
      industry: cp.industry || null,
      domain: cp.domain || null,
      owner: ownerName(cp.hubspot_owner_id) || 'unassigned',
      link: companyLink
    },
    deals: {
      count: dealSummaries.length,
      records: dealSummaries.slice(0, 20)
    },
    contacts: {
      count: contactSummaries.length,
      records: contactSummaries.slice(0, 10)
    },
    engagements: {
      ...engSummary,
      total: engSummary.calls + engSummary.emails + engSummary.meetings + engSummary.tasks,
      mostRecent: mostRecentEngagement
    },
    territoryConflicts: detectTerritoryConflicts(company, deals, stageLabels, allOwners),
    asOfDate: new Date().toISOString().slice(0, 10)
  };
}

/**
 * Detect territory conflicts: compare HubSpot deal owners against
 * territory assignment rules. Flag any deal where the owner doesn't
 * match who should own it based on the company's state/city.
 */
function detectTerritoryConflicts(company, deals, stageLabels, allOwners) {
  const cp = company.properties || {};
  const market = [cp.city, cp.state].filter(Boolean).join(' ');
  if (!market) return { checked: false, reason: 'Company missing city/state in HubSpot' };

  const assignments = loadAssignments();
  const stateResult = getStateReps(market, assignments);
  if (!stateResult) return { checked: true, conflicts: [], expectedReps: [], market };

  const expectedReps = stateResult.details.map(d => ({
    rep: d.rep,
    focus: d.focus || null
  }));
  const expectedNames = stateResult.reps.map(r => r.toLowerCase());

  const ownerName = (id) => {
    const o = allOwners.find(o => String(o.id) === String(id));
    return o ? `${o.firstName} ${o.lastName}`.trim() : null;
  };

  const conflicts = [];

  // Check company-level owner
  const companyOwner = ownerName(cp.hubspot_owner_id);
  if (companyOwner && !expectedNames.includes(companyOwner.toLowerCase())) {
    // Check if it's an owner-level assignment (e.g. Jack Harvey for Top 50)
    const isOwnerAssignment = assignments.ownerAssignments.some(
      a => a.rep.toLowerCase() === companyOwner.toLowerCase()
    );
    if (!isOwnerAssignment) {
      conflicts.push({
        type: 'company',
        record: cp.name || '(unnamed)',
        currentOwner: companyOwner,
        expectedReps: stateResult.reps,
        note: `Company owner "${companyOwner}" does not match territory assignment for ${market}. Expected: ${stateResult.reps.join(' or ')}.`
      });
    }
  }

  // Check each deal owner
  for (const d of deals) {
    const dp = d.properties || {};
    const stage = stageLabels[dp.dealstage] || dp.dealstage || 'Unknown';
    // Skip closed/lost deals
    if (stage === 'Closed Won' || stage === 'Closed Lost' || stage === 'Lost Deal') continue;

    const dealOwner = ownerName(dp.hubspot_owner_id);
    if (dealOwner && !expectedNames.includes(dealOwner.toLowerCase())) {
      const isOwnerAssignment = assignments.ownerAssignments.some(
        a => a.rep.toLowerCase() === dealOwner.toLowerCase()
      );
      if (!isOwnerAssignment) {
        conflicts.push({
          type: 'deal',
          record: dp.dealname || '(unnamed)',
          stage,
          currentOwner: dealOwner,
          expectedReps: stateResult.reps,
          note: `Deal "${dp.dealname}" owned by "${dealOwner}" but territory rules assign ${market} to ${stateResult.reps.join(' or ')}.`
        });
      }
    }
  }

  return {
    checked: true,
    market,
    stateCode: stateResult.stateCode,
    expectedReps,
    conflicts,
    hasConflicts: conflicts.length > 0
  };
}

async function handleLookup(parsed, context) {
  const query = parsed.entity || '';
  const originalText = context._originalText || query;

  if (!query) {
    return { text: 'What would you like to know? Example: `when was the last contact from Venterra?`' };
  }

  // Rep territory lookup
  if (!/^\d+$/.test(query) && !query.includes('@')) {
    const needle = query.toLowerCase().trim();
    const repMatch = KNOWN_REPS.find(r => r.toLowerCase() === needle)
      || KNOWN_REPS.find(r => r.toLowerCase().includes(needle))
      || KNOWN_REPS.find(r => needle.includes(r.split(' ')[0].toLowerCase()));
    if (repMatch) {
      // Delegate to territory handler
      const handleTerritory = require('./territory');
      return handleTerritory({ ...parsed, entity: repMatch }, context);
    }
  }

  const [allOwners, portalId, stageLabels] = await Promise.all([
    getOwners(), getPortalId(), getDealStageLabels()
  ]);

  // Direct ID lookup
  if (/^\d+$/.test(query)) {
    return handleIdLookup(query, allOwners, portalId, stageLabels, originalText, context);
  }

  // Company search — find the company, then fetch all associated data
  const companyHits = await searchCompanyByName(query);

  if (companyHits.length === 0) {
    // Not in HubSpot — run ownership resolution to tell the user who it should go to
    const { resolve } = require('../../engine');
    const resolution = resolve({ ownerName: query });
    const suggestedReps = (Array.isArray(resolution.rep) ? resolution.rep : [resolution.rep])
      .filter(r => r && r !== 'UNASSIGNED');

    const blocks = [
      { type: 'header', text: { type: 'plain_text', text: `🔍 ${query}`, emoji: true } },
      { type: 'section', text: { type: 'mrkdwn', text: `⚠ *Not found in HubSpot* — no company record exists for "${query}".` } }
    ];

    if (suggestedReps.length > 0) {
      const RULE_LABELS = {
        TOP_50: 'Top 50 Owner', LEASE_UP: 'Lease-Up', OWNER_ASSIGNMENT: 'Owner-Level Assignment',
        STATE_FALLBACK: 'State/Regional', UNASSIGNED: 'Unassigned'
      };
      blocks.push({ type: 'section', text: { type: 'mrkdwn', text:
        `*Should be assigned to:* ${suggestedReps.join(' / ')}\n` +
        `*Rule:* ${RULE_LABELS[resolution.rule] || resolution.rule}\n` +
        `*Why:* ${resolution.explanation}`
      }});
    } else {
      blocks.push({ type: 'section', text: { type: 'mrkdwn', text:
        `Could not determine assignment — no territory match found. ` +
        `If you know the owner's HQ state or property market, try: \`check ${query} --market "City ST"\``
      }});
    }

    if (resolution.warnings.length > 0) {
      blocks.push({ type: 'section', text: { type: 'mrkdwn', text: resolution.warnings.map(w => `⚠ ${w}`).join('\n') } });
    }

    // Also check if there are deals/contacts with this name
    const [dealHits, contactHits] = await Promise.all([
      searchDealsByName(query).catch(() => []),
      searchContacts(query).catch(() => [])
    ]);

    if (dealHits.length > 0 || contactHits.length > 0) {
      blocks.push({ type: 'divider' });
      blocks.push({ type: 'section', text: { type: 'mrkdwn', text: `_No company record, but found related records:_` } });
      for (const deal of dealHits.slice(0, 3)) {
        const dp = deal.properties || {};
        const stageLabel = stageLabels[dp.dealstage] || dp.dealstage || '—';
        const hsLink = `https://app.hubspot.com/contacts/${portalId}/deal/${deal.id}`;
        const ownerLabel = (() => { const o = allOwners.find(o => String(o.id) === String(dp.hubspot_owner_id)); return o ? `${o.firstName} ${o.lastName}`.trim() : '—'; })();
        blocks.push({ type: 'section', text: { type: 'mrkdwn', text:
          `📋 *Deal:* <${hsLink}|${dp.dealname || '(unnamed)'}>\n` +
          `*Stage:* ${stageLabel}   ·   *Owner:* ${ownerLabel}`
        }});
      }
      for (const ct of contactHits.slice(0, 3)) {
        const ctp = ct.properties || {};
        const ctName = [ctp.firstname, ctp.lastname].filter(Boolean).join(' ') || '(unnamed)';
        const hsLink = `https://app.hubspot.com/contacts/${portalId}/contact/${ct.id}`;
        blocks.push({ type: 'section', text: { type: 'mrkdwn', text:
          `👤 *Contact:* <${hsLink}|${ctName}> · ${ctp.email || '—'}`
        }});
      }
    }

    return { blocks: blocks.slice(0, 50) };
  }

  const companyId = companyHits[0].id;
  const company = await getCompany(companyId);

  // Fetch associated deals and contacts
  const [dealAssoc, contactAssoc] = await Promise.all([
    getAssociatedIds('companies', 'deals', [companyId]).catch(() => ({})),
    getAssociatedIds('companies', 'contacts', [companyId]).catch(() => ({}))
  ]);

  const dealIds = dealAssoc[companyId] || [];
  const contactIds = contactAssoc[companyId] || [];

  // Batch-read deals
  let deals = [];
  if (dealIds.length > 0) {
    const take = dealIds.slice(0, 50);
    try {
      const res = await apiRequest('POST', '/crm/v3/objects/deals/batch/read', {
        inputs: take.map(id => ({ id: String(id) })),
        properties: DEAL_PROPS
      });
      deals = res.results || [];
    } catch { /* non-fatal */ }
    await sleep(250);
  }

  // Batch-read contacts
  let contacts = [];
  if (contactIds.length > 0) {
    const take = contactIds.slice(0, 20);
    try {
      const res = await apiRequest('POST', '/crm/v3/objects/contacts/batch/read', {
        inputs: take.map(id => ({ id: String(id) })),
        properties: CONTACT_PROPS
      });
      contacts = res.results || [];
    } catch { /* non-fatal */ }
    await sleep(250);
  }

  // Fetch recent engagements associated with this company
  const engagements = [];
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
          e._type = type;
          engagements.push(e);
        }
      }
    } catch { /* non-fatal */ }
    await sleep(200);
  }

  // Resolve rep filter if specified (by parser or extracted from original text)
  const repParam = parsed.parameters?.rep || null;
  let repFilter = null;
  if (repParam) {
    const needle = repParam.toLowerCase().replace(/[^a-z\s]/g, '').trim();
    const matchedRep = KNOWN_REPS.find(r => r.toLowerCase() === needle)
      || KNOWN_REPS.find(r => r.toLowerCase().includes(needle))
      || KNOWN_REPS.find(r => needle.includes(r.split(' ')[0].toLowerCase()));
    if (matchedRep) {
      const owner = allOwners.find(o =>
        `${o.firstName} ${o.lastName}`.toLowerCase().trim() === matchedRep.toLowerCase()
      );
      if (owner) repFilter = { name: matchedRep, ownerId: String(owner.id) };
    }
  }

  // If rep filter is set, check if this rep has deals on this company.
  // If not, also search that rep's own deals for the company name — the deal
  // might be linked to a different company record but contain the name.
  let repDealsFromSearch = [];
  if (repFilter) {
    const repHasDeals = deals.some(d =>
      String(d.properties?.hubspot_owner_id) === repFilter.ownerId
    );
    if (!repHasDeals) {
      // Strategy 1: Search the rep's deals for the company name in deal name
      try {
        const searchRes = await apiRequest('POST', '/crm/v3/objects/deals/search', {
          filterGroups: [{
            filters: [
              { propertyName: 'hubspot_owner_id', operator: 'EQ', value: repFilter.ownerId },
              { propertyName: 'dealname', operator: 'CONTAINS_TOKEN', value: query }
            ]
          }],
          properties: DEAL_PROPS,
          limit: 10
        });
        repDealsFromSearch = searchRes.results || [];
      } catch { /* non-fatal */ }

      // Strategy 2: If still nothing, find ALL company records matching the query
      // and check if any of their deals belong to this rep
      if (repDealsFromSearch.length === 0) {
        try {
          // Get all company records matching the name
          const allCompanyHits = await searchCompanyByName(query);
          const allCompanyIds = allCompanyHits.map(c => c.id);

          for (const cid of allCompanyIds) {
            if (cid === companyId) continue; // already checked this one
            const assoc = await getAssociatedIds('companies', 'deals', [cid]).catch(() => ({}));
            const dIds = (assoc[cid] || []).slice(0, 20);
            if (dIds.length === 0) continue;

            const res = await apiRequest('POST', '/crm/v3/objects/deals/batch/read', {
              inputs: dIds.map(id => ({ id: String(id) })),
              properties: DEAL_PROPS
            });
            const matched = (res.results || []).filter(d =>
              String(d.properties?.hubspot_owner_id) === repFilter.ownerId
            );
            repDealsFromSearch.push(...matched);
            await sleep(200);
            if (repDealsFromSearch.length > 0) break;
          }
        } catch { /* non-fatal */ }
      }
    }
  }

  // Build summary and let analyst answer
  const summary = summarizeCompany(company, deals, contacts, engagements, stageLabels, allOwners, portalId);

  // Add rep's deals found via name search (not associated with the company record)
  if (repDealsFromSearch.length > 0) {
    const ownerName = (id) => {
      const o = allOwners.find(o => String(o.id) === String(id));
      return o ? `${o.firstName} ${o.lastName}`.trim() : null;
    };
    summary.repDealsFromNameSearch = repDealsFromSearch.map(d => {
      const dp = d.properties || {};
      return {
        id: d.id,
        name: dp.dealname || '(unnamed)',
        stage: stageLabels[dp.dealstage] || dp.dealstage || 'Unknown',
        owner: ownerName(dp.hubspot_owner_id) || 'unassigned',
        amount: dp.amount ? Number(dp.amount) : null,
        created: dp.createdate ? new Date(dp.createdate).toISOString().slice(0, 10) : null,
        lastModifiedDaysAgo: dp.hs_lastmodifieddate
          ? Math.floor((Date.now() - new Date(dp.hs_lastmodifieddate).getTime()) / 86400000)
          : null,
        pitchDate: dp.first_pitch_date__ap_ || null,
        link: `https://app.hubspot.com/contacts/${portalId}/deal/${d.id}`
      };
    });
  }

  const cp = company.properties || {};
  let dataContext = `All HubSpot data for company "${cp.name || query}". ` +
    `Includes associated deals (with stage, owner, dates, pitch dates), ` +
    `contacts (with title, email, phone, engagement counts), ` +
    `and recent engagements (calls, emails, meetings, tasks with timestamps). ` +
    `The AP Pipeline ID is ${AP_PIPELINE_ID}. Deal links and company link are included. ` +
    `IMPORTANT: The data includes a "territoryConflicts" section. If hasConflicts is true, ` +
    `you MUST flag this prominently in your response with a ⚠ warning. Territory assignment rules ` +
    `are the source of truth — if HubSpot shows a different owner than the territory rules dictate, ` +
    `that is a conflict that needs investigation. Show who currently owns it and who SHOULD own it per territory rules.`;

  if (repFilter) {
    dataContext += ` The user is asking specifically about ${repFilter.name}'s deals/activity with this company. ` +
      `Filter your answer to deals owned by "${repFilter.name}" (look at the owner field in each deal record). ` +
      `Still mention other deals if relevant for context, but focus on ${repFilter.name}'s deals.`;
    if (repDealsFromSearch.length > 0) {
      dataContext += ` NOTE: ${repFilter.name} has no deals directly associated with the "${cp.name}" company record, ` +
        `but a search of ${repFilter.name}'s deals found ${repDealsFromSearch.length} deal(s) with "${query}" in the name ` +
        `(see repDealsFromNameSearch in the data). These are likely the deals the user is asking about — show them.`;
    }
  }

  const answer = await analyze(originalText, summary, dataContext, context.userId);

  const blocks = [
    { type: 'header', text: { type: 'plain_text', text: `🏢 ${cp.name || query}`, emoji: true } },
    { type: 'section', text: { type: 'mrkdwn', text: answer } }
  ];

  return { blocks: blocks.slice(0, 50) };
}

// ---------------------------------------------------------------------------
// Direct ID lookup — structured output
// ---------------------------------------------------------------------------

async function handleIdLookup(id, allOwners, portalId, stageLabels, originalText, context) {
  const ownerName = (oid) => {
    if (!oid) return '_(unassigned)_';
    const o = allOwners.find(o => String(o.id) === String(oid));
    return o ? `${o.firstName} ${o.lastName}`.trim() : `Owner ID: ${oid}`;
  };

  // Try deal, company, contact
  try {
    const deal = await getDeal(id);
    const dp = deal.properties || {};
    const stageLabel = stageLabels[dp.dealstage] || dp.dealstage || '—';
    const hsLink = `https://app.hubspot.com/contacts/${portalId}/deal/${id}`;
    return {
      blocks: [
        { type: 'header', text: { type: 'plain_text', text: '🔍 Deal', emoji: true } },
        { type: 'section', text: { type: 'mrkdwn', text:
          `*Deal:* <${hsLink}|${dp.dealname || '(unnamed)'}>\n` +
          `*Stage:* ${stageLabel}\n` +
          `*Owner:* ${ownerName(dp.hubspot_owner_id)}\n` +
          (dp.amount ? `*Amount:* $${Number(dp.amount).toLocaleString()}` : '')
        }}
      ]
    };
  } catch { /* not a deal */ }

  try {
    const company = await getCompany(id);
    const cp = company.properties || {};
    const hsLink = `https://app.hubspot.com/contacts/${portalId}/company/${id}`;
    return {
      blocks: [
        { type: 'header', text: { type: 'plain_text', text: '🔍 Company', emoji: true } },
        { type: 'section', text: { type: 'mrkdwn', text:
          `*Company:* <${hsLink}|${cp.name || '(unnamed)'}>\n` +
          `*Market:* ${[cp.city, cp.state].filter(Boolean).join(', ') || '—'}\n` +
          `*Industry:* ${cp.industry || '—'}\n` +
          `*Owner:* ${ownerName(cp.hubspot_owner_id)}`
        }}
      ]
    };
  } catch { /* not a company */ }

  try {
    const contact = await getContact(id);
    const ctp = contact.properties || {};
    const name = [ctp.firstname, ctp.lastname].filter(Boolean).join(' ') || '(unnamed)';
    const hsLink = `https://app.hubspot.com/contacts/${portalId}/contact/${id}`;
    return {
      blocks: [
        { type: 'header', text: { type: 'plain_text', text: '🔍 Contact', emoji: true } },
        { type: 'section', text: { type: 'mrkdwn', text:
          `*Contact:* <${hsLink}|${name}>\n` +
          `*Email:* ${ctp.email || '—'}\n` +
          `*Phone:* ${ctp.phone || '—'}\n` +
          `*Owner:* ${ownerName(ctp.hubspot_owner_id)}`
        }}
      ]
    };
  } catch { /* not a contact */ }

  return { text: `No deal, company, or contact found with ID \`${id}\`.` };
}

// ---------------------------------------------------------------------------
// Name search fallback — when no company match, search everything
// ---------------------------------------------------------------------------

async function handleNameSearch(query, allOwners, portalId, stageLabels, originalText, context) {
  const ownerName = (id) => {
    if (!id) return '_(unassigned)_';
    const o = allOwners.find(o => String(o.id) === String(id));
    return o ? `${o.firstName} ${o.lastName}`.trim() : `Owner ID: ${id}`;
  };

  const [dealHits, contactHits] = await Promise.all([
    searchDealsByName(query).catch(() => []),
    searchContacts(query).catch(() => [])
  ]);

  if (!dealHits.length && !contactHits.length) {
    return { text: `No results found for "${query}" in HubSpot.` };
  }

  const blocks = [
    { type: 'header', text: { type: 'plain_text', text: `🔍 Results for "${query}"`, emoji: true } }
  ];

  for (const deal of dealHits.slice(0, 5)) {
    const dp = deal.properties || {};
    const stageLabel = stageLabels[dp.dealstage] || dp.dealstage || '—';
    const lastMod = dp.hs_lastmodifieddate ? new Date(dp.hs_lastmodifieddate) : null;
    const lastModStr = lastMod ? humanizeDays(Math.floor((Date.now() - lastMod.getTime()) / 86400000)) : '—';
    const hsLink = `https://app.hubspot.com/contacts/${portalId}/deal/${deal.id}`;
    blocks.push({ type: 'section', text: { type: 'mrkdwn', text:
      `📋 *Deal:* <${hsLink}|${dp.dealname || '(unnamed)'}>\n` +
      `*Stage:* ${stageLabel}   ·   *Owner:* ${ownerName(dp.hubspot_owner_id)}   ·   *Last activity:* ${lastModStr}`
    }});
  }

  for (const ct of contactHits.slice(0, 5)) {
    const ctp = ct.properties || {};
    const ctName = [ctp.firstname, ctp.lastname].filter(Boolean).join(' ') || '(unnamed)';
    const hsLink = `https://app.hubspot.com/contacts/${portalId}/contact/${ct.id}`;
    blocks.push({ type: 'section', text: { type: 'mrkdwn', text:
      `👤 *Contact:* <${hsLink}|${ctName}>\n` +
      `*Email:* ${ctp.email || '—'}   ·   *Owner:* ${ownerName(ctp.hubspot_owner_id)}`
    }});
  }

  return { blocks: blocks.slice(0, 50) };
}

module.exports = handleLookup;
