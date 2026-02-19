import * as path from 'node:path';
import { describe, it, expect } from 'vitest';
import { PtyThreadRuntime } from '../../src/api/chatkit/runtime/PtyThreadRuntime';
import type { ResolvedAgentConfig } from '../../src/agents/config/types';

describe('ACP Agent Config Passthrough', () => {
  const workdir = process.cwd();
  const agentPath = path.join(process.cwd(), 'tests/fixtures/acp-config-agent.js');

  it('passes agentConfig fields to session/new', async () => {
    const rt = new PtyThreadRuntime();

    const agentConfig: ResolvedAgentConfig = {
      id: 'secretary',
      displayName: 'Secretary',
      description: 'Test agent',
      systemPrompt: 'You are a helpful secretary.',
      executorType: 'claude',
      apiKey: 'sk-test-key',
      baseUrl: 'https://api.example.com',
      model: 'claude-sonnet-4',
      maxTurns: 10,
      allowedTools: ['Read', 'Write', 'Edit'],
      disallowedTools: ['Bash'],
      permissionMode: 'auto',
      mcpServers: {
        jina: {
          type: 'stdio',
          command: 'npx',
          args: ['-y', '@jina-ai/mcp-server'],
        },
      },
      skillsContent: 'You know drizzle-solid.',
      enabled: true,
    };

    await rt.ensureStarted('thread-config-test', {
      workspace: { type: 'path', rootPath: workdir },
      runner: {
        type: 'codex',
        protocol: 'acp',
        argv: ['node', agentPath],
      },
      agentConfig,
    });

    let out = '';
    for await (const ev of rt.sendMessage('thread-config-test', 'ping', { idleMs: 50 })) {
      if (ev.type === 'text') {
        out += ev.text;
      }
    }

    // The fixture echoes back the session/new config as JSON
    const received = JSON.parse(out);
    expect(received.systemPrompt).toBe('You are a helpful secretary.');
    expect(received.appendSystemPrompt).toBe('You know drizzle-solid.');
    expect(received.maxTurns).toBe(10);
    expect(received.allowedTools).toEqual(['Read', 'Write', 'Edit']);
    expect(received.disallowedTools).toEqual(['Bash']);
    expect(received.permissionMode).toBe('auto');
    expect(received.mcpServers).toEqual([
      { name: 'jina', type: 'stdio', command: 'npx', args: ['-y', '@jina-ai/mcp-server'] },
    ]);
  }, 20_000);

  it('passes empty mcpServers when agentConfig has none', async () => {
    const rt = new PtyThreadRuntime();

    const agentConfig = {
      id: 'minimal',
      displayName: 'Minimal',
      systemPrompt: 'Hello.',
      executorType: 'claude',
      apiKey: 'sk-test',
      mcpServers: {},
      enabled: true,
    } as ResolvedAgentConfig;

    await rt.ensureStarted('thread-config-empty', {
      workspace: { type: 'path', rootPath: workdir },
      runner: {
        type: 'codex',
        protocol: 'acp',
        argv: ['node', agentPath],
      },
      agentConfig,
    });

    let out = '';
    for await (const ev of rt.sendMessage('thread-config-empty', 'ping', { idleMs: 50 })) {
      if (ev.type === 'text') {
        out += ev.text;
      }
    }

    const received = JSON.parse(out);
    expect(received.mcpServers).toEqual([]);
    expect(received.systemPrompt).toBe('Hello.');
    expect(received.maxTurns).toBeNull();
    expect(received.allowedTools).toBeNull();
  }, 20_000);

  it('falls back to empty mcpServers without agentConfig', async () => {
    const rt = new PtyThreadRuntime();

    await rt.ensureStarted('thread-config-none', {
      workspace: { type: 'path', rootPath: workdir },
      runner: {
        type: 'codex',
        protocol: 'acp',
        argv: ['node', agentPath],
      },
    });

    let out = '';
    for await (const ev of rt.sendMessage('thread-config-none', 'ping', { idleMs: 50 })) {
      if (ev.type === 'text') {
        out += ev.text;
      }
    }

    const received = JSON.parse(out);
    expect(received.mcpServers).toEqual([]);
    expect(received.systemPrompt).toBeNull();
  }, 20_000);
});
