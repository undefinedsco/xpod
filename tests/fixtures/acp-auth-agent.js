#!/usr/bin/env node
/* eslint-disable no-console */
// Minimal ACP stdio agent for tests that triggers an auth request.
//
// It supports:
// - initialize
// - session/new
// - session/prompt (sends auth/request then streams session/update agent_message_chunk)

const readline = require('node:readline');

function write(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

const rl = readline.createInterface({ input: process.stdin });

let nextSessionId = 1;
let pendingAuthRequestId = null;
let pendingSessionId = null;

rl.on('line', (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;

  let msg;
  try {
    msg = JSON.parse(trimmed);
  } catch {
    return;
  }

  // Handle client -> agent responses (e.g. auth request ack).
  if (msg && msg.jsonrpc === '2.0' && typeof msg.id === 'number' && pendingAuthRequestId === msg.id) {
    // After the client acks, continue streaming response text.
    if (pendingSessionId) {
      write({
        jsonrpc: '2.0',
        method: 'session/update',
        params: {
          sessionId: pendingSessionId,
          update: {
            type: 'agent_message_chunk',
            content: { content: { type: 'text', text: 'ok' } },
          },
        },
      });
    }
    pendingAuthRequestId = null;
    return;
  }

  if (msg && msg.jsonrpc === '2.0' && typeof msg.method === 'string' && typeof msg.id === 'number') {
    const { id, method, params } = msg;

    if (method === 'initialize') {
      write({
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: 1,
          serverCapabilities: {},
          serverInfo: { name: 'acp-auth-agent', version: 'test' },
        },
      });
      return;
    }

    if (method === 'session/new') {
      const sessionId = `sess_${nextSessionId++}`;
      pendingSessionId = sessionId;
      write({ jsonrpc: '2.0', id, result: { sessionId } });
      return;
    }

    if (method === 'session/prompt') {
      const sessionId = params && params.sessionId;
      pendingSessionId = sessionId;

      // Ask the client to open a browser URL (simulated auth flow).
      pendingAuthRequestId = 999;
      write({
        jsonrpc: '2.0',
        id: pendingAuthRequestId,
        method: 'auth/request',
        params: {
          url: 'https://example.com/login',
          message: 'Please login to continue',
        },
      });

      write({ jsonrpc: '2.0', id, result: { stopReason: 'end_turn' } });
      return;
    }

    write({
      jsonrpc: '2.0',
      id,
      error: { code: -32601, message: `Method not found: ${method}` },
    });
  }
});
