'use strict';

/**
 * analyst.js — Conversation memory for /apbot agent
 *
 * Maintains per-user conversation history so follow-up questions
 * ("why?", "break that down by rep", "what about last month?")
 * have full context from the previous exchange.
 *
 * The analyze() and isFollowUp() functions were removed in v2 —
 * the tool-use agent handles both naturally via conversation context.
 */

// ---------------------------------------------------------------------------
// Conversation memory — per-user, 10-min TTL
// ---------------------------------------------------------------------------

const _memory = new Map(); // userId -> { messages, dataSummary, dataContext, ts }
const MEMORY_TTL = 10 * 60 * 1000; // 10 minutes

function getMemory(userId) {
  const entry = _memory.get(userId);
  if (!entry) return null;
  if (Date.now() - entry.ts > MEMORY_TTL) {
    _memory.delete(userId);
    return null;
  }
  return entry;
}

function saveMemory(userId, messages, dataSummary, dataContext) {
  _memory.set(userId, { messages, dataSummary, dataContext, ts: Date.now() });
}

function clearMemory(userId) {
  _memory.delete(userId);
}

module.exports = { getMemory, saveMemory, clearMemory };
