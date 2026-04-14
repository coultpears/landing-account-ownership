const extractNumbers = require('./extract-numbers');

module.exports = (output, context) => {
  const metadata = context.providerResponse?.metadata;
  if (!metadata?.toolCalls) return { pass: true, score: 1, reason: 'No tool data (skipped)' };

  // Find pipeline calls with pitch data — prefer the most specific call:
  // 1. Rep-specific + time-scoped (rep + days/start_date)
  // 2. Rep-specific only
  // 3. Time-scoped only (days or start_date)
  // 4. Unfiltered team-wide
  const pipelineCalls = metadata.toolCalls.filter(tc => tc.tool === 'get_pipeline_data' && tc.result?.pitchCountInWindow !== undefined);
  if (pipelineCalls.length === 0) return { pass: true, score: 1, reason: 'Not a pitch query (skipped)' };

  const hasRep = (tc) => !!tc.args?.rep;
  const hasTime = (tc) => !!(tc.args?.days || tc.args?.start_date);

  const call =
    pipelineCalls.find(tc => hasRep(tc) && hasTime(tc)) ||
    pipelineCalls.find(tc => hasRep(tc)) ||
    pipelineCalls.find(tc => hasTime(tc)) ||
    pipelineCalls[0];

  const expected = call.result.pitchCountInWindow;

  // When pitchByRep exists (team-wide query), validate that the response includes
  // either the total OR any of the per-rep counts from pitchByRep — the response
  // may focus on individual reps rather than stating the total.
  const pitchByRep = call.result.pitchByRep;
  if (pitchByRep && Object.keys(pitchByRep).length > 1) {
    const numbers = extractNumbers(output);
    const repCounts = Object.values(pitchByRep);
    // Pass if the total appears, or if at least 2 individual rep counts appear
    if (numbers.includes(expected)) return { pass: true, score: 1, reason: `Total pitch count ${expected} found in response` };
    const matchedReps = repCounts.filter(c => numbers.includes(c));
    if (matchedReps.length >= 2) return { pass: true, score: 1, reason: `${matchedReps.length} per-rep pitch counts match pitchByRep data` };
    if (expected === 0 && /\b(no|zero|0)\b.*pitch/i.test(output)) return { pass: true, score: 1, reason: 'Correctly says zero pitches' };
    return { pass: false, score: 0, reason: `Pitch count mismatch: tool says total=${expected}, pitchByRep=${JSON.stringify(pitchByRep)}, but response numbers [${numbers.join(', ')}] don't match` };
  }

  const numbers = extractNumbers(output);

  if (numbers.includes(expected)) return { pass: true, score: 1, reason: `Pitch count ${expected} found in response` };
  if (expected === 0 && /\b(no|zero|0)\b.*pitch/i.test(output)) return { pass: true, score: 1, reason: 'Correctly says zero pitches' };

  return { pass: false, score: 0, reason: `Pitch count mismatch: tool says ${expected}, response has [${numbers.join(', ')}]` };
};
