module.exports = (output, context) => {
  const metadata = context.providerResponse?.metadata;
  if (!metadata?.toolCalls) return { pass: true, score: 1, reason: 'No tool data (skipped)' };

  // Only validate on queries explicitly about territory
  const query = (context.vars?.query || '').toLowerCase();
  const isAboutTerritory = /who covers|territory|whose .* is/i.test(query);
  if (!isAboutTerritory) return { pass: true, score: 1, reason: 'Not a territory query (skipped)' };

  const call = metadata.toolCalls.find(tc => tc.tool === 'get_territory');
  if (!call?.result?.found) return { pass: true, score: 1, reason: 'No territory result (skipped)' };

  const expectedReps = call.result.reps.map(r => r.rep);
  const outputLower = output.toLowerCase();

  for (const rep of expectedReps) {
    const lastName = rep.split(' ').pop().toLowerCase();
    if (outputLower.includes(lastName)) return { pass: true, score: 1, reason: `Response correctly mentions ${rep}` };
  }

  return { pass: false, score: 0, reason: `Territory rep mismatch: tool says [${expectedReps.join(', ')}], none found in response` };
};
