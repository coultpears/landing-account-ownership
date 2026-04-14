const extractNumbers = require('./extract-numbers');

module.exports = (output, context) => {
  const metadata = context.providerResponse?.metadata;
  if (!metadata?.toolCalls) return { pass: true, score: 1, reason: 'No tool data (skipped)' };

  const pipelineCall = metadata.toolCalls.find(tc => tc.tool === 'get_pipeline_data');
  if (!pipelineCall?.result) return { pass: true, score: 1, reason: 'No pipeline data (skipped)' };

  // Only validate when a stage filter was applied (dealList present)
  const dealList = pipelineCall.result.dealList;
  if (!dealList) return { pass: true, score: 1, reason: 'No stage-filtered deal list (skipped)' };

  const expected = dealList.total;
  const numbers = extractNumbers(output);

  if (numbers.includes(expected)) return { pass: true, score: 1, reason: `Deal count ${expected} found in response` };

  return { pass: false, score: 0, reason: `Deal count mismatch: tool says ${expected} deals, response has [${numbers.join(', ')}]` };
};
