'use strict';

/**
 * router.js — Intent-to-handler dispatch for /apbot
 *
 * Maps parsed intents to handler functions and returns Slack blocks.
 * Detects follow-up questions and routes them to the analyst with
 * the previous conversation context (no re-fetch needed).
 */

const handleCheck     = require('./handlers/check');
const handleAudit     = require('./handlers/audit');
const handleLookup    = require('./handlers/lookup');
const handlePipeline  = require('./handlers/pipeline');
const handleDashboard = require('./handlers/dashboard');
const handleActivity  = require('./handlers/activity');
const handleTerritory = require('./handlers/territory');
const handleDealDetail = require('./handlers/deal-detail');
const { analyze, isFollowUp, getMemory } = require('./analyst');

const HANDLERS = {
  check:       handleCheck,
  audit:       handleAudit,
  lookup:      handleLookup,
  pipeline:    handlePipeline,
  dashboard:   handleDashboard,
  activity:    handleActivity,
  territory:   handleTerritory,
  deal_detail: handleDealDetail
};

/**
 * Route a parsed intent to the appropriate handler.
 *
 * @param {object} parsed - Output from parser.parse()
 * @param {object} context - { userId, userName, slackClient, _originalText }
 * @returns {object} { blocks: [] } or { text: string }
 */
async function route(parsed, context) {
  const originalText = context._originalText || parsed.entity || '';

  // Check for follow-up: if user has recent conversation memory and this
  // looks like a follow-up question, skip intent routing and go straight
  // to the analyst with the previous data context.
  const prior = getMemory(context.userId);
  if (prior && isFollowUp(originalText)) {
    try {
      const answer = await analyze(
        originalText,
        prior.dataSummary,
        prior.dataContext,
        context.userId
      );
      return {
        blocks: [
          { type: 'header', text: { type: 'plain_text', text: '📊 Follow-up', emoji: true } },
          { type: 'section', text: { type: 'mrkdwn', text: answer } }
        ]
      };
    } catch (err) {
      console.error('[apbot/router] Follow-up analysis failed:', err.message);
      // Fall through to normal routing
    }
  }

  const handler = HANDLERS[parsed.intent];
  if (!handler) {
    return {
      text: `Unknown intent: "${parsed.intent}". Try rephrasing your question.`
    };
  }

  try {
    return await handler(parsed, context);
  } catch (err) {
    console.error(`[apbot/router] Handler "${parsed.intent}" failed:`, err.message);
    return {
      text: `Error processing your request: ${err.message}`
    };
  }
}

module.exports = { route };
