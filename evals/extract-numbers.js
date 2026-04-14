'use strict';

/**
 * Extract human-readable numbers from LLM output, ignoring URLs, IDs, and dates.
 */
module.exports = function extractNumbers(text) {
  // Strip URLs (HubSpot links contain large IDs)
  const cleaned = text.replace(/https?:\/\/[^\s>|)]+/g, '');

  // Match numbers, but filter out likely IDs (>= 8 digits) and year-like numbers
  const matches = cleaned.match(/\b\d[\d,]*\b/g) || [];
  return matches
    .map(m => parseInt(m.replace(/,/g, ''), 10))
    .filter(n => !isNaN(n) && n < 100000 && !(n >= 2020 && n <= 2030));
};
