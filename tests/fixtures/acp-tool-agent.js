#!/usr/bin/env node
/* eslint-disable no-console */
// Minimal ACP stdio agent for tests that triggers a "tool call" (unknown request).
//
// It supports:
// - initialize
// - session/new
// - session/prompt (sends a request and waits for a response before streaming output)

const readline = require('node:readline');

function write(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

const rl = readline.createInterface({ input: process.stdin });

let nextSessionId = 1;
let pendingSessionId = null;
let waitingForToolResponse = false;

rl.on('line', (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;

  let msg;
  try {
    msg = JSON.parse(trimmed);
  } catch {
    return;
  }

  // Tool response from client.
  if (msg && msg.jsonrpc === '2.0' && typeof msg.id === 'number' && msg.id === 4242) {
    waitingForToolResponse = false;
    if (pendingSessionId) {
      write({
        jsonrpc: '2.0',
        method: 'session/update',
        params: {
          sessionId: pendingSessionId,
          update: {
            type: 'agent_message_chunk',
            content: { content: { type: 'text', text: 'after-tool' } },
          },
        },
      });
    }
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
          serverInfo: { name: 'acp-tool-agent', version: 'test' },
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

      // Unknown request => should become a client_tool_call.
      waitingForToolResponse = true;
      write({
        jsonrpc: '2.0',
        id: 4242,
        method: 'tool/example',
        params: { a: 1 },
      });

      // Return prompt result immediately; we'll stream after we get the tool response.
      write({ jsonrpc: '2.0', id, result: { stopReason: 'tool_call' } });
      return;
    }

    write({
      jsonrpc: '2.0',
      id,
      error: { code: -32601, message: `Method not found: ${method}` },
    });
  }
});

