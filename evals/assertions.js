'use strict';

/**
 * Custom promptfoo assertions that cross-check LLM response numbers
 * against actual tool result data.
 *
 * Usage in promptfooconfig.yaml:
 *   assert:
 *     - type: javascript
 *       value: file://assertions.js#pitchCountMatches
 */

/**
 * Extract all numbers from a string.
 */
function extractNumbers(text) {
  const matches = text.match(/\b\d[\d,]*\b/g) || [];
  return matches.map(m => parseInt(m.replace(/,/g, ''), 10)).filter(n => !isNaN(n));
}

/**
 * Find a tool result by tool name from metadata.
 */
function findToolResult(metadata, toolName) {
  if (!metadata?.toolCalls) return null;
  const call = metadata.toolCalls.find(tc => tc.tool === toolName);
  return call?.result || null;
}

/**
 * Pitch count: the number stated in the response must match pitchCountInWindow
 * from the get_pipeline_data tool result.
 */
function pitchCountMatches({ output, metadata }) {
  const pipelineResult = findToolResult(metadata, 'get_pipeline_data');
  if (!pipelineResult || pipelineResult.error) {
    return { pass: true, score: 1, reason: 'No pipeline data to validate against (skipped)' };
  }

  const expectedCount = pipelineResult.pitchCountInWindow;
  if (expectedCount === undefined || expectedCount === null) {
    return { pass: true, score: 1, reason: 'No pitchCountInWindow in tool result (not a pitch query)' };
  }

  // Extract numbers from the response and check if any match
  const numbers = extractNumbers(output);
  if (numbers.includes(expectedCount)) {
    return { pass: true, score: 1, reason: `Response correctly states ${expectedCount} pitches` };
  }

  // Check if the response mentions zero when count is zero
  if (expectedCount === 0 && /\b(no|zero|0)\b.*pitch/i.test(output)) {
    return { pass: true, score: 1, reason: 'Response correctly indicates zero pitches' };
  }

  return {
    pass: false,
    score: 0,
    reason: `Pitch count mismatch: tool returned pitchCountInWindow=${expectedCount}, but response contains numbers [${numbers.join(', ')}]. None match the actual count.`
  };
}

/**
 * Recent wins count: the number of wins stated must match timeWindow.recentWins.count.
 */
function recentWinsCountMatches({ output, metadata }) {
  const pipelineResult = findToolResult(metadata, 'get_pipeline_data');
  if (!pipelineResult || pipelineResult.error) {
    return { pass: true, score: 1, reason: 'No pipeline data to validate against (skipped)' };
  }

  const recentWins = pipelineResult.timeWindow?.recentWins;
  if (!recentWins) {
    return { pass: true, score: 1, reason: 'No timeWindow.recentWins in tool result (not a time-scoped query)' };
  }

  const expectedCount = recentWins.count;
  const numbers = extractNumbers(output);

  if (numbers.includes(expectedCount)) {
    return { pass: true, score: 1, reason: `Response correctly states ${expectedCount} recent wins` };
  }

  if (expectedCount === 0 && /\b(no|zero|0|nothing|none)\b.*clos/i.test(output)) {
    return { pass: true, score: 1, reason: 'Response correctly indicates zero recent wins' };
  }

  return {
    pass: false,
    score: 0,
    reason: `Recent wins mismatch: tool returned timeWindow.recentWins.count=${expectedCount}, but response contains numbers [${numbers.join(', ')}]. None match.`
  };
}

/**
 * Deal list count: if the response says "N deals" and lists them,
 * the stated count must match the actual tool data total.
 */
function dealCountMatches({ output, metadata }) {
  const pipelineResult = findToolResult(metadata, 'get_pipeline_data');
  if (!pipelineResult || pipelineResult.error) {
    return { pass: true, score: 1, reason: 'No pipeline data to validate against (skipped)' };
  }

  // Check dealList (stage-filtered queries)
  if (pipelineResult.dealList) {
    const expectedTotal = pipelineResult.dealList.total;
    const numbers = extractNumbers(output);
    if (numbers.includes(expectedTotal)) {
      return { pass: true, score: 1, reason: `Response correctly states ${expectedTotal} deals` };
    }
    return {
      pass: false,
      score: 0,
      reason: `Deal count mismatch: tool returned dealList.total=${expectedTotal}, but response contains numbers [${numbers.join(', ')}]. None match.`
    };
  }

  // Check totalDeals for unfiltered queries
  const expectedTotal = pipelineResult.totalDeals;
  if (expectedTotal === undefined) {
    return { pass: true, score: 1, reason: 'No deal count to validate (skipped)' };
  }

  const numbers = extractNumbers(output);
  if (numbers.includes(expectedTotal)) {
    return { pass: true, score: 1, reason: `Response correctly states ${expectedTotal} total deals` };
  }

  return {
    pass: false,
    score: 0,
    reason: `Total deals mismatch: tool returned totalDeals=${expectedTotal}, but response contains numbers [${numbers.join(', ')}]. None match.`
  };
}

/**
 * Territory rep: the rep name in the response must match the tool result.
 */
function territoryRepMatches({ output, metadata }) {
  const territoryResult = findToolResult(metadata, 'get_territory');
  if (!territoryResult || territoryResult.error || !territoryResult.found) {
    return { pass: true, score: 1, reason: 'No territory result to validate (skipped)' };
  }

  const expectedReps = territoryResult.reps.map(r => r.rep);
  const outputLower = output.toLowerCase();

  for (const rep of expectedReps) {
    // Check last name match (more robust than full name)
    const lastName = rep.split(' ').pop().toLowerCase();
    if (outputLower.includes(lastName)) {
      return { pass: true, score: 1, reason: `Response correctly mentions ${rep}` };
    }
  }

  return {
    pass: false,
    score: 0,
    reason: `Territory rep mismatch: tool returned reps [${expectedReps.join(', ')}], but none found in response.`
  };
}

/**
 * Ownership rule: the assigned rep must match the tool result.
 */
function ownershipRepMatches({ output, metadata }) {
  const ownershipResult = findToolResult(metadata, 'resolve_ownership');
  if (!ownershipResult || ownershipResult.error || ownershipResult.disqualified) {
    return { pass: true, score: 1, reason: 'No ownership result to validate (skipped)' };
  }

  const assignedTo = ownershipResult.assignedTo || [];
  const outputLower = output.toLowerCase();

  if (assignedTo.includes('UNASSIGNED') && /unassigned/i.test(output)) {
    return { pass: true, score: 1, reason: 'Response correctly states UNASSIGNED' };
  }

  for (const rep of assignedTo) {
    const lastName = rep.split(' ').pop().toLowerCase();
    if (outputLower.includes(lastName)) {
      return { pass: true, score: 1, reason: `Response correctly mentions ${rep}` };
    }
  }

  return {
    pass: false,
    score: 0,
    reason: `Ownership rep mismatch: tool says assignedTo=[${assignedTo.join(', ')}], but none found in response.`
  };
}

module.exports = {
  pitchCountMatches,
  recentWinsCountMatches,
  dealCountMatches,
  territoryRepMatches,
  ownershipRepMatches,
};
