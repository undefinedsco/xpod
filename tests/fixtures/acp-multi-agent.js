#!/usr/bin/env node
/* eslint-disable no-console */
// Deterministic ACP stdio agent simulator for tests.
//
// Usage:
//   node acp-multi-agent.js secretary
//   node acp-multi-agent.js worker-claude
//   node acp-multi-agent.js worker-codebuddy
//
// It supports:
// - initialize
// - session/new
// - session/prompt (streams session/update agent_message_chunk)
//
// It also emits an auth/request once for the secretary on first prompt to
// validate runtime.auth_required propagation.

const readline = require('node:readline');

function write(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

const rl = readline.createInterface({ input: process.stdin });
const role = process.argv[2] || 'worker';

let nextSessionId = 1;
let sessionId = null;
let sentSecretaryAuth = false;

function emitChunk(text) {
  if (!sessionId) return;
  write({
    jsonrpc: '2.0',
    method: 'session/update',
    params: {
      sessionId,
      update: {
        type: 'agent_message_chunk',
        content: { content: { type: 'text', text } },
      },
    },
  });
}

function extractPromptText(params) {
  const prompt = params && params.prompt;
  if (!Array.isArray(prompt) || prompt.length === 0) return '';
  const first = prompt[0];
  if (first && first.type === 'text' && typeof first.text === 'string') return first.text;
  return '';
}

function handleLine(line) {
  const trimmed = line.trim();
  if (!trimmed) return;

  let msg;
  try {
    msg = JSON.parse(trimmed);
  } catch {
    return;
  }

  // We don't need to handle client -> agent responses for this fixture:
  // runtime auto-acks auth requests, and this agent does not block on them.

  if (msg && msg.jsonrpc === '2.0' && typeof msg.method === 'string' && typeof msg.id === 'number') {
    const { id, method, params } = msg;

    if (method === 'initialize') {
      write({
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: 1,
          serverCapabilities: {},
          serverInfo: { name: 'acp-multi-agent', version: 'test' },
        },
      });
      return;
    }

    if (method === 'session/new') {
      sessionId = `sess_${nextSessionId++}`;
      write({ jsonrpc: '2.0', id, result: { sessionId } });
      return;
    }

    if (method === 'session/prompt') {
      sessionId = params && params.sessionId ? params.sessionId : sessionId;
      const t = extractPromptText(params);

      if (role === 'secretary') {
        if (!sentSecretaryAuth) {
          sentSecretaryAuth = true;
          // Trigger auth so the server can surface runtime.auth_required.
          write({
            jsonrpc: '2.0',
            id: 9001,
            method: 'auth/request',
            params: {
              url: 'https://example.com/login',
              message: 'Login required (test)',
            },
          });
        }

        if (t.startsWith('REQUEST:')) {
          emitChunk('DELEGATE claude: Please summarize the repo structure (1 paragraph).\n');
          emitChunk('DELEGATE codebuddy: Please list 3 potential risks and mitigations.\n');
          emitChunk('WAITING\n');
        } else if (t.startsWith('RESULTS:')) {
          emitChunk('FINAL: aggregated -> ' + t.slice('RESULTS:'.length).trim() + '\n');
        } else {
          emitChunk('ACK: ' + t + '\n');
        }
      } else if (role === 'worker-claude') {
        emitChunk('RESULT(claude): ' + t + '\n');
      } else if (role === 'worker-codebuddy') {
        emitChunk('RESULT(codebuddy): ' + t + '\n');
      } else {
        emitChunk('RESULT(worker): ' + t + '\n');
      }

      write({ jsonrpc: '2.0', id, result: { stopReason: 'end_turn' } });
      return;
    }

    write({
      jsonrpc: '2.0',
      id,
      error: { code: -32601, message: `Method not found: ${method}` },
    });
  }
}

rl.on('line', handleLine);

