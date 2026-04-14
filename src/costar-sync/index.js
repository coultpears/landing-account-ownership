'use strict';

/**
 * costar-sync/index.js — Public API for CoStar sync module
 */

const { runSync, dryRun, parseFile, ensureCustomProperties } = require('./sync');
const { FIELD_MAP, rowToHubspotProps } = require('./fields');

module.exports = {
  runSync,
  dryRun,
  parseFile,
  ensureCustomProperties,
  FIELD_MAP,
  rowToHubspotProps
};
