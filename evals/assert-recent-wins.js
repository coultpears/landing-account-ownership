const extractNumbers = require('./extract-numbers');

module.exports = (output, context) => {
  const metadata = context.providerResponse?.metadata;
  if (!metadata?.toolCalls) return { pass: true, score: 1, reason: 'No tool data (skipped)' };

  // Only validate on queries that are explicitly about closings/wins
  const query = (context.vars?.query || '').toLowerCase();
  const isAboutWins = /clos|won|win/i.test(query);
  if (!isAboutWins) return { pass: true, score: 1, reason: 'Not a wins query (skipped)' };

  // Find pipeline calls with time window
  const pipelineCalls = metadata.toolCalls.filter(tc => tc.tool === 'get_pipeline_data' && tc.result?.timeWindow?.recentWins);
  if (pipelineCalls.length === 0) return { pass: true, score: 1, reason: 'No timeWindow data (skipped)' };

  const repCall = pipelineCalls.find(tc => tc.args?.rep);
  const call = repCall || pipelineCalls[0];
  const expected = call.result.timeWindow.recentWins.count;
  const numbers = extractNumbers(output);

  if (numbers.includes(expected)) return { pass: true, score: 1, reason: `Recent wins count ${expected} found in response` };
  if (expected === 0 && /\b(no|zero|0|nothing|none)\b.*clos/i.test(output)) return { pass: true, score: 1, reason: 'Correctly says zero wins' };

  return { pass: false, score: 0, reason: `Recent wins mismatch: tool says ${expected}, response has [${numbers.join(', ')}]` };
};
