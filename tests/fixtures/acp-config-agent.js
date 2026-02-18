#!/usr/bin/env node
/* eslint-disable no-console */
// ACP agent fixture that validates session/new receives agent config params
// (mcpServers, systemPrompt, allowedTools, maxTurns, etc.)
// and echoes them back in session/prompt responses.

const readline = require('node:readline');

function write(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

const rl = readline.createInterface({ input: process.stdin });

let nextSessionId = 1;
let sessionConfig = {};

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
          serverInfo: { name: 'acp-config-agent', version: 'test' },
        },
      });
      return;
    }

    if (method === 'session/new') {
      const sessionId = `sess_${nextSessionId++}`;
      // Capture config params passed via session/new
      sessionConfig = {
        mcpServers: params?.mcpServers ?? [],
        systemPrompt: params?.systemPrompt ?? null,
        appendSystemPrompt: params?.appendSystemPrompt ?? null,
        maxTurns: params?.maxTurns ?? null,
        allowedTools: params?.allowedTools ?? null,
        disallowedTools: params?.disallowedTools ?? null,
        permissionMode: params?.permissionMode ?? null,
      };
      write({ jsonrpc: '2.0', id, result: { sessionId } });
      return;
    }

    if (method === 'session/prompt') {
      const sessionId = params && params.sessionId;
      // Echo back the captured session config as JSON so the test can verify it.
      const payload = JSON.stringify(sessionConfig);

      write({
        jsonrpc: '2.0',
        method: 'session/update',
        params: {
          sessionId,
          update: {
            type: 'agent_message_chunk',
            content: { content: { type: 'text', text: payload } },
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
