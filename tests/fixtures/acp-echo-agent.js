#!/usr/bin/env node
/* eslint-disable no-console */
// Minimal ACP stdio agent for tests (JSON-RPC 2.0 NDJSON).
//
// It supports:
// - initialize
// - session/new
// - session/prompt (streams session/update agent_message_chunk notifications)

const readline = require('node:readline');

function write(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

const rl = readline.createInterface({ input: process.stdin });

let nextSessionId = 1;

rl.on('line', (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;

  let msg;
  try {
    msg = JSON.parse(trimmed);
  } catch {
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
          serverInfo: { name: 'acp-echo-agent', version: 'test' },
        },
      });
      return;
    }

    if (method === 'session/new') {
      const sessionId = `sess_${nextSessionId++}`;
      write({ jsonrpc: '2.0', id, result: { sessionId } });
      return;
    }

    if (method === 'session/prompt') {
      const sessionId = params && params.sessionId;
      const prompt = params && Array.isArray(params.prompt) ? params.prompt : [];
      const text = prompt.map((b) => (b && b.type === 'text' ? b.text : '')).join('');
      const payload = `echo:${text}`;

      // Stream in 2 chunks to validate incremental updates.
      const a = payload.slice(0, Math.ceil(payload.length / 2));
      const b = payload.slice(Math.ceil(payload.length / 2));

      write({
        jsonrpc: '2.0',
        method: 'session/update',
        params: {
          sessionId,
          update: {
            type: 'agent_message_chunk',
            content: { content: { type: 'text', text: a } },
          },
        },
      });
      write({
        jsonrpc: '2.0',
        method: 'session/update',
        params: {
          sessionId,
          update: {
            type: 'agent_message_chunk',
            content: { content: { type: 'text', text: b } },
          },
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

