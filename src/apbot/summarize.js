'use strict';

/**
 * summarize.js — Pre-compute compact data summaries for the analyst LLM
 *
 * Raw HubSpot records are too large for an LLM context window.
 * This module builds structured summaries that contain the signal
 * the analyst needs to answer any reporting question.
 *
 * Close time is calculated from deal creation to the date the deal
 * entered the "Closed Won" stage (hs_v2_date_entered_126194579),
 * NOT from the closedate field which may be unset or inaccurate.
 *
 * Stage movement is tracked via hs_v2_date_entered_* / hs_v2_date_exited_*
 * properties, giving time spent in each stage.
 */

// AP Pipeline stage IDs → labels (in pipeline order)
const AP_STAGE_MAP = [
  { id: '126194574',  label: 'New Opportunities' },
  { id: '128203694',  label: 'Contacted' },
  { id: '185461262',  label: 'Defining Call Schedule' },
  { id: '126194575',  label: 'Call Scheduled' },
  { id: '1225117962', label: 'IC Review' },
  { id: '126194576',  label: 'Active Opportunities' },
  { id: '126194577',  label: 'Late Stage Opportunities' },
  { id: '128915635',  label: 'Contract Discussions' },
  { id: '126194578',  label: 'Contract Redline' },
  { id: '126194579',  label: 'Closed Won' },
  { id: '1097165102', label: 'Lost Deal' }
];

const CLOSED_WON_STAGE_ID = '126194579';

function parseDate(val) {
  if (!val) return null;
  const d = new Date(val);
  return isNaN(d.getTime()) ? null : d.getTime();
}

/**
 * Summarize an array of deal records into a compact analytics object.
 */
function summarizeDeals(deals, stageLabels, allOwners) {
  const ownerName = (id) => {
    const o = allOwners.find(o => String(o.id) === String(id));
    return o ? `${o.firstName} ${o.lastName}`.trim() : 'Unknown';
  };

  const now = Date.now();

  const byStage = {};
  const byRep = {};
  const closedWon = [];
  const closedLost = [];
  const pitches = [];
  const staleDeals = [];
  let totalAmount = 0;
  let amountCount = 0;

  // Per-stage average time (from enter to exit dates)
  const stageTimings = {}; // stageLabel -> [days, ...]

  for (const d of deals) {
    const dp = d.properties || {};
    const stage = stageLabels[dp.dealstage] || dp.dealstage || 'Unknown';
    const rep = ownerName(dp.hubspot_owner_id);
    const amount = dp.amount ? Number(dp.amount) : 0;

    byStage[stage] = (byStage[stage] || 0) + 1;

    if (!byRep[rep]) byRep[rep] = { deals: 0, won: 0, lost: 0, totalAmount: 0, pitches: 0, stages: {} };
    byRep[rep].deals++;
    if (!byRep[rep].stages[stage]) byRep[rep].stages[stage] = 0;
    byRep[rep].stages[stage]++;

    if (amount) {
      totalAmount += amount;
      amountCount++;
      byRep[rep].totalAmount += amount;
    }

    // Stage movement timing — calculate time spent in each stage
    for (const s of AP_STAGE_MAP) {
      const entered = parseDate(dp[`hs_v2_date_entered_${s.id}`]);
      const exited = parseDate(dp[`hs_v2_date_exited_${s.id}`]);
      if (entered && exited && exited > entered) {
        const days = Math.round((exited - entered) / 86400000 * 10) / 10;
        if (!stageTimings[s.label]) stageTimings[s.label] = [];
        stageTimings[s.label].push(days);
      }
    }

    // Closed Won — use stage entry date, not closedate
    if (stage === 'Closed Won' || dp.hs_is_closed_won === 'true') {
      const created = parseDate(dp.createdate);
      const closedWonEntry = parseDate(dp[`hs_v2_date_entered_${CLOSED_WON_STAGE_ID}`]);
      const daysToClose = (created && closedWonEntry && closedWonEntry > created)
        ? Math.round((closedWonEntry - created) / 86400000 * 10) / 10
        : null;
      const closedDate = closedWonEntry
        ? new Date(closedWonEntry).toISOString().slice(0, 10)
        : (dp.closedate ? new Date(dp.closedate).toISOString().slice(0, 10) : null);

      closedWon.push({
        name: dp.dealname || '(unnamed)',
        rep,
        amount,
        daysToClose,
        closedDate,
        reason: dp.closed_won_reason || null
      });
      byRep[rep].won++;
    }

    // Closed Lost
    if (stage === 'Closed Lost' || stage === 'Lost Deal') {
      closedLost.push({ name: dp.dealname || '(unnamed)', rep, amount });
      byRep[rep].lost++;
    }

    // Pitch data
    if (dp.first_pitch_date__ap_) {
      const pitchDate = new Date(dp.first_pitch_date__ap_);
      pitches.push({
        name: dp.dealname || '(unnamed)',
        rep,
        pitchDate: dp.first_pitch_date__ap_,
        daysAgo: Math.floor((now - pitchDate.getTime()) / 86400000),
        category: dp.pitch_category || null,
        inPerson: dp.in_person_pitch || null
      });
      byRep[rep].pitches++;
    }

    // Stale deals
    if (stage !== 'Closed Won' && stage !== 'Closed Lost' && stage !== 'Lost Deal') {
      const lastMod = parseDate(dp.hs_lastmodifieddate);
      const daysSince = lastMod ? Math.floor((now - lastMod) / 86400000) : null;
      if (daysSince !== null && daysSince > 4) {
        const timeInStage = dp.hs_v2_time_in_current_stage
          ? Math.round(Number(dp.hs_v2_time_in_current_stage) / 86400 * 10) / 10
          : null;
        staleDeals.push({
          name: dp.dealname || '(unnamed)',
          rep, stage,
          daysSinceActivity: daysSince,
          timeInStageDays: timeInStage
        });
      }
    }
  }

  // Close time stats
  const closeTimes = closedWon.map(d => d.daysToClose).filter(d => d !== null);
  const closeTimeStats = closeTimes.length > 0 ? {
    count: closeTimes.length,
    avg: Math.round(closeTimes.reduce((a, b) => a + b, 0) / closeTimes.length * 10) / 10,
    median: Math.round(closeTimes.sort((a, b) => a - b)[Math.floor(closeTimes.length / 2)] * 10) / 10,
    fastest: Math.round(Math.min(...closeTimes) * 10) / 10,
    slowest: Math.round(Math.max(...closeTimes) * 10) / 10
  } : null;

  // Stage timing averages
  const stageAvgTiming = {};
  for (const [label, times] of Object.entries(stageTimings)) {
    const avg = Math.round(times.reduce((a, b) => a + b, 0) / times.length * 10) / 10;
    stageAvgTiming[label] = { avgDays: avg, dealCount: times.length };
  }

  pitches.sort((a, b) => a.daysAgo - b.daysAgo);
  staleDeals.sort((a, b) => b.daysSinceActivity - a.daysSinceActivity);

  const repSummary = Object.entries(byRep).map(([name, data]) => ({
    rep: name,
    deals: data.deals,
    won: data.won,
    lost: data.lost,
    winRate: (data.won + data.lost) > 0 ? Math.round(data.won / (data.won + data.lost) * 100) : null,
    totalAmount: Math.round(data.totalAmount),
    pitches: data.pitches,
    stages: data.stages
  })).sort((a, b) => b.deals - a.deals);

  return {
    totalDeals: deals.length,
    totalAmount: Math.round(totalAmount),
    avgDealAmount: amountCount > 0 ? Math.round(totalAmount / amountCount) : null,
    byStage,
    stageAvgTiming,
    repSummary,
    closedWon: { count: closedWon.length, deals: closedWon.slice(0, 20) },
    closedLost: { count: closedLost.length },
    closeTimeStats,
    closeTimeNote: 'daysToClose = days from deal creation to entering Closed Won stage (based on hs_v2_date_entered). Deals without a Closed Won entry date are excluded from close time calculations.',
    winRate: (closedWon.length + closedLost.length) > 0
      ? Math.round(closedWon.length / (closedWon.length + closedLost.length) * 100)
      : null,
    pitches: { count: pitches.length, recent: pitches.slice(0, 10) },
    staleDeals: { count: staleDeals.length, worst: staleDeals.slice(0, 10) },
    asOfDate: new Date().toISOString().slice(0, 10)
  };
}

/**
 * Summarize rep activity data for the analyst.
 */
function summarizeActivity(repName, daysBack, deals, calls, emails, meetings, tasks, stageLabels) {
  const now = Date.now();
  const cutoff = now - daysBack * 86400000;

  let dealsCreated = 0;
  let dealsModified = 0;
  const stageActivity = {};

  for (const d of deals) {
    const created = new Date(d.properties?.createdate || 0).getTime();
    if (created >= cutoff) dealsCreated++;
    else dealsModified++;

    const stage = stageLabels[d.properties?.dealstage] || d.properties?.dealstage || 'Unknown';
    stageActivity[stage] = (stageActivity[stage] || 0) + 1;
  }

  const allEngagements = [...calls, ...emails, ...meetings, ...tasks];
  const weekBuckets = [0, 0, 0, 0];
  for (const e of allEngagements) {
    const raw = e.properties?.hs_timestamp;
    if (!raw) continue;
    const n = Number(raw);
    const ts = (!isNaN(n) && n > 1000000000) ? n : new Date(raw).getTime();
    if (!ts || isNaN(ts)) continue;
    const weeksAgo = Math.floor((now - ts) / (7 * 86400000));
    if (weeksAgo >= 0 && weeksAgo < 4) weekBuckets[weeksAgo]++;
  }

  return {
    rep: repName,
    daysBack,
    dealsCreated,
    dealsModified,
    totalDeals: deals.length,
    calls: calls.length,
    emails: emails.length,
    meetings: meetings.length,
    tasks: tasks.length,
    totalEngagements: allEngagements.length,
    stageActivity,
    weeklyTrend: {
      thisWeek: weekBuckets[0],
      lastWeek: weekBuckets[1],
      twoWeeksAgo: weekBuckets[2],
      threeWeeksAgo: weekBuckets[3]
    },
    asOfDate: new Date().toISOString().slice(0, 10)
  };
}

module.exports = { summarizeDeals, summarizeActivity };
