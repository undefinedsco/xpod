import * as path from 'node:path';
import { afterEach, beforeEach, describe, it, expect } from 'vitest';
import { AcpAgentRuntime } from '../../src/api/chatkit/runtime/AcpAgentRuntime';
import type { ResolvedAgentConfig } from '../../src/agents/config/types';

describe('ACP Agent Config Passthrough', () => {
  const workspaceRef = `file://localhost${process.cwd()}`;
  const agentPath = path.join(process.cwd(), 'tests/fixtures/acp-config-agent.js');
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const key of ['DEFAULT_API_KEY', 'DEFAULT_API_BASE', 'DEFAULT_MODEL']) {
      savedEnv[key] = process.env[key];
    }
    process.env.DEFAULT_API_KEY = 'gateway-key';
    process.env.DEFAULT_API_BASE = 'http://127.0.0.1:3000/v1';
    process.env.DEFAULT_MODEL = 'linx';
  });

  afterEach(() => {
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it('passes agentConfig fields to session/new', async () => {
    const rt = new AcpAgentRuntime();

    const agentConfig: ResolvedAgentConfig = {
      id: 'secretary',
      displayName: 'Secretary',
      description: 'Test agent',
      systemPrompt: 'You are a helpful secretary.',
      executorType: 'claude',
      model: 'linx',
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
      skills: [
        {
          name: 'drizzle-solid',
          content: '---\nname: drizzle-solid\n---\n\nYou know drizzle-solid.',
        },
      ],
      enabled: true,
    };

    let out = '';
    for await (const ev of rt.run({
      threadId: 'thread-config-test',
      prompt: 'ping',
      config: {
        workspace: workspaceRef,
        idleMs: 50,
        runner: {
          type: 'codex',
          protocol: 'acp',
          argv: ['node', agentPath],
        },
        agentConfig,
      },
    })) {
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
    const rt = new AcpAgentRuntime();

    const agentConfig = {
      id: 'minimal',
      displayName: 'Minimal',
      systemPrompt: 'Hello.',
      executorType: 'claude',
      mcpServers: {},
      enabled: true,
    } as ResolvedAgentConfig;

    let out = '';
    for await (const ev of rt.run({
      threadId: 'thread-config-empty',
      prompt: 'ping',
      config: {
        workspace: workspaceRef,
        idleMs: 50,
        runner: {
          type: 'codex',
          protocol: 'acp',
          argv: ['node', agentPath],
        },
        agentConfig,
      },
    })) {
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
    const rt = new AcpAgentRuntime();

    let out = '';
    for await (const ev of rt.run({
      threadId: 'thread-config-none',
      prompt: 'ping',
      config: {
        workspace: workspaceRef,
        idleMs: 50,
        runner: {
          type: 'codex',
          protocol: 'acp',
          argv: ['node', agentPath],
        },
      },
    })) {
      if (ev.type === 'text') {
        out += ev.text;
      }
    }

    const received = JSON.parse(out);
    expect(received.mcpServers).toEqual([]);
    expect(received.systemPrompt).toBeNull();
  }, 20_000);
});
