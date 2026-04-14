'use strict';

/**
 * Promptfoo custom provider — wraps handleQuery from agent.js
 * so evals test the full agent loop (LLM → tool selection → tool execution → response).
 *
 * Intercepts tool calls to capture results for cross-validation assertions.
 *
 * Usage in promptfooconfig.yaml:
 *   providers:
 *     - file://provider.js
 */

const path = require('path');

// Load env vars from .env at project root
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

// Intercept executeTool to capture tool results
const tools = require('../src/apbot/tools');
const _originalExecuteTool = tools.executeTool;
let _capturedToolCalls = [];

tools.executeTool = async function(name, args) {
  const result = await _originalExecuteTool(name, args);
  _capturedToolCalls.push({ tool: name, args, result });
  return result;
};

const { handleQuery } = require('../src/apbot/agent');

class ApbotProvider {
  constructor(options) {
    this.options = options || {};
  }

  id() {
    return 'apbot-agent';
  }

  async callApi(prompt, context) {
    const vars = context?.vars || {};

    // Reset captured tool calls for this test
    _capturedToolCalls = [];

    // Simulate Slack context
    const slackContext = {
      userId: vars.userId || `U_EVAL_${Date.now()}`, // unique per test to avoid memory crosstalk
      userName: vars.userName || 'eval-user',
      channelId: vars.channelId || 'C_EVAL',
    };

    try {
      const result = await handleQuery(prompt, slackContext);

      // handleQuery returns { blocks } or { text }
      let output;
      if (result.blocks) {
        output = result.blocks
          .filter(b => b.type === 'section' && b.text)
          .map(b => b.text.text || b.text)
          .join('\n');
      } else if (result.text) {
        output = result.text;
      } else {
        output = JSON.stringify(result);
      }

      return {
        output,
        metadata: { toolCalls: _capturedToolCalls }
      };
    } catch (err) {
      return { output: `ERROR: ${err.message}`, error: err.message };
    }
  }
}

module.exports = ApbotProvider;
