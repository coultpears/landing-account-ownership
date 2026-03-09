'use strict';

/**
 * qualify.js — Lead qualification gate
 *
 * A property/owner qualifies if it is:
 *   - Class A or Class B multifamily
 *   - Conventional (market-rate), NOT affordable/restricted/niche
 *
 * Returns { qualified: boolean, reasons: string[], flags: string[] }
 *   reasons — hard disqualifiers (stop processing)
 *   flags   — soft warnings (proceed but verify)
 */

const QUALIFYING_CLASSES = ['a', 'b'];

const DISQUALIFYING_TYPES = [
  'affordable',
  'lihtc',
  'low income',
  'section 8',
  'hud',
  'tax credit',
  'senior',
  'student',
  'independent living',
  'assisted living',
  'memory care',
  'manufactured',
  'mobile home',
  'single family',
  'build to rent',
  'btr'
];

const QUALIFYING_TYPE_KEYWORDS = [
  'conventional',
  'market rate',
  'market-rate',
  'multifamily',
  'apartment',
  'residential'
];

function qualify(input) {
  const { propertyClass, propertyType } = input;

  const result = {
    qualified: false,
    reasons: [],
    flags: []
  };

  // ── Class check ───────────────────────────────────────────────────────────
  if (propertyClass) {
    const classNorm = propertyClass.toLowerCase().replace(/[^a-z]/g, '');
    // Accept "classa", "a", "classb", "b"
    const letter = classNorm.replace('class', '').trim();
    if (!QUALIFYING_CLASSES.includes(letter)) {
      result.reasons.push(
        `Property class "${propertyClass}" is not Class A or Class B. ` +
        `Class C and below do not qualify.`
      );
      return result;
    }
  } else {
    result.flags.push(
      'Property class not provided — assuming eligible. Verify it is Class A or B before proceeding.'
    );
  }

  // ── Type check ────────────────────────────────────────────────────────────
  if (propertyType) {
    const typeNorm = propertyType.toLowerCase();

    // Hard disqualifiers
    const disqualifier = DISQUALIFYING_TYPES.find(t => typeNorm.includes(t));
    if (disqualifier) {
      result.reasons.push(
        `Property type "${propertyType}" contains disqualifying category "${disqualifier}". ` +
        `Only Class A/B Conventional MF qualifies.`
      );
      return result;
    }

    // Check it looks like conventional MF
    const hasQualifyingKeyword = QUALIFYING_TYPE_KEYWORDS.some(k => typeNorm.includes(k));
    if (!hasQualifyingKeyword) {
      result.flags.push(
        `Property type "${propertyType}" could not be confirmed as Conventional MF. ` +
        `Verify before processing.`
      );
    }
  } else {
    result.flags.push(
      'Property type not provided — assuming Conventional MF. Verify before processing.'
    );
  }

  result.qualified = true;
  return result;
}

module.exports = { qualify };
