'use strict';

/**
 * observability.js — Langfuse tracing for /apbot
 *
 * When LANGFUSE_SECRET_KEY + LANGFUSE_PUBLIC_KEY are set, logs every query
 * as a trace with spans for LLM calls, tool executions, and the final response.
 *
 * Falls back to no-op when Langfuse is not configured (local dev).
 */

let _langfuse = null;
let _available = null;

function getLangfuse() {
  if (_available === false) return null;

  if (!process.env.LANGFUSE_SECRET_KEY || !process.env.LANGFUSE_PUBLIC_KEY) {
    _available = false;
    return null;
  }

  if (_langfuse) return _langfuse;

  try {
    const { Langfuse } = require('langfuse');
    _langfuse = new Langfuse({
      secretKey: process.env.LANGFUSE_SECRET_KEY,
      publicKey: process.env.LANGFUSE_PUBLIC_KEY,
      baseUrl: process.env.LANGFUSE_HOST || 'https://cloud.langfuse.com',
      flushAt: 5,       // Flush after 5 events
      flushInterval: 5000 // or every 5 seconds
    });
    _available = true;
    console.log('[apbot/observability] Langfuse tracing enabled');
    return _langfuse;
  } catch (err) {
    console.error('[apbot/observability] Langfuse init failed:', err.message);
    _available = false;
    return null;
  }
}

/**
 * Create a trace for a user query. Returns a trace object or a no-op stub.
 */
function createTrace({ userId, userName, query }) {
  const langfuse = getLangfuse();

  if (!langfuse) {
    // Return no-op stub so callers don't need null checks
    return {
      id: null,
      span: () => ({
        end: () => {},
        update: () => {}
      }),
      generation: () => ({
        end: () => {},
        update: () => {}
      }),
      update: () => {},
      _noop: true
    };
  }

  const trace = langfuse.trace({
    name: 'apbot-query',
    userId,
    metadata: { userName },
    input: query,
    tags: ['apbot']
  });

  return trace;
}

/**
 * Log an LLM generation (Anthropic API call).
 */
function logGeneration(trace, { model, messages, response, startTime, usage }) {
  if (trace._noop) return;

  try {
    trace.generation({
      name: 'anthropic-llm',
      model,
      input: messages,
      output: response?.content,
      startTime,
      endTime: new Date(),
      usage: usage ? {
        input: usage.input_tokens,
        output: usage.output_tokens,
        total: (usage.input_tokens || 0) + (usage.output_tokens || 0)
      } : undefined,
      metadata: {
        stopReason: response?.stop_reason,
        cacheCreation: usage?.cache_creation_input_tokens,
        cacheRead: usage?.cache_read_input_tokens
      }
    });
  } catch (err) {
    console.error('[apbot/observability] Generation log failed:', err.message);
  }
}

/**
 * Log a tool execution span.
 */
function logToolCall(trace, { toolName, args, result, startTime }) {
  if (trace._noop) return;

  try {
    const span = trace.span({
      name: `tool:${toolName}`,
      input: args,
      startTime,
      endTime: new Date(),
      metadata: {
        resultSize: JSON.stringify(result).length,
        hasError: !!result?.error
      }
    });
    span.end({ output: result?.error ? { error: result.error } : { success: true } });
  } catch (err) {
    console.error('[apbot/observability] Tool log failed:', err.message);
  }
}

/**
 * Finalize a trace with the output and status.
 */
function finalizeTrace(trace, { output, status, model, totalTurns, validationIssues }) {
  if (trace._noop) return;

  try {
    trace.update({
      output,
      metadata: {
        status: status || 'success',
        model,
        totalTurns,
        validationIssues: validationIssues || 0
      }
    });
  } catch (err) {
    console.error('[apbot/observability] Trace finalize failed:', err.message);
  }
}

/**
 * Flush pending events. Call on process shutdown.
 */
async function flush() {
  if (_langfuse) {
    try {
      await _langfuse.flushAsync();
    } catch {}
  }
}

module.exports = {
  createTrace,
  logGeneration,
  logToolCall,
  finalizeTrace,
  flush
};
