module.exports = (output, context) => {
  const metadata = context.providerResponse?.metadata;
  if (!metadata?.toolCalls) return { pass: true, score: 1, reason: 'No tool data (skipped)' };

  // Only validate on queries explicitly about ownership
  const query = (context.vars?.query || '').toLowerCase();
  const isAboutOwnership = /who (owns|should own)|ownership|lease-up/i.test(query);
  if (!isAboutOwnership) return { pass: true, score: 1, reason: 'Not an ownership query (skipped)' };

  const call = metadata.toolCalls.find(tc => tc.tool === 'resolve_ownership');
  if (!call?.result || call.result.error || call.result.disqualified) return { pass: true, score: 1, reason: 'No ownership result (skipped)' };

  const assignedTo = call.result.assignedTo || [];
  const outputLower = output.toLowerCase();

  if (assignedTo.includes('UNASSIGNED') && /unassigned/i.test(output)) return { pass: true, score: 1, reason: 'Correctly states UNASSIGNED' };

  for (const rep of assignedTo) {
    const lastName = rep.split(' ').pop().toLowerCase();
    if (outputLower.includes(lastName)) return { pass: true, score: 1, reason: `Response correctly mentions ${rep}` };
  }

  return { pass: false, score: 0, reason: `Ownership mismatch: tool says [${assignedTo.join(', ')}], none found in response` };
};
