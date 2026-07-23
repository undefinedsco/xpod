import * as path from 'node:path';
import { afterEach, describe, it, expect } from 'vitest';
import { AcpAgentRuntime } from '../../src/api/chatkit/runtime/AcpAgentRuntime';

describe('ACP Thread Runtime', () => {
  const workspaceRef = `file://localhost${process.cwd()}`;
  const savedEnv: Record<string, string | undefined> = {};
  const ambientProviderKeys = [
    'OPENAI_API_KEY',
    'OPENAI_BASE_URL',
    'ANTHROPIC_API_KEY',
    'ANTHROPIC_BASE_URL',
    'DEFAULT_API_KEY',
    'DEFAULT_API_BASE',
  ];

  afterEach(() => {
    for (const key of ambientProviderKeys) {
      if (savedEnv[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = savedEnv[key];
      }
    }
  });

  it('streams agent_message_chunk from ACP session/update notifications', async () => {
    const rt = new AcpAgentRuntime();
    const agentPath = path.join(process.cwd(), 'tests/fixtures/acp-echo-agent.js');

    let out = '';
    for await (
      const ev of rt.run({
        threadId: 'thread-acp-test',
        prompt: 'hello',
        config: {
          workspace: workspaceRef,
          runner: {
            type: 'codex',
            protocol: 'acp',
            argv: [ 'node', agentPath ],
          },
          agentConfig: testAgentConfig(),
        },
      })
    ) {
      if (ev.type === 'text') {
        out += ev.text;
      }
    }

    expect(out).toBe('echo:hello');
  }, 20_000);

  it('surfaces auth_required events with an auth URL', async () => {
    const rt = new AcpAgentRuntime();
    const agentPath = path.join(process.cwd(), 'tests/fixtures/acp-auth-agent.js');

    let sawAuth = false;
    let out = '';
    for await (
      const ev of rt.run({
        threadId: 'thread-acp-auth-test',
        prompt: 'hello',
        config: {
          workspace: workspaceRef,
          idleMs: 50,
          runner: {
            type: 'codex',
            protocol: 'acp',
            argv: [ 'node', agentPath ],
          },
          agentConfig: testAgentConfig(),
        },
      })
    ) {
      if (ev.type === 'auth_required') {
        expect(ev.url).toBe('https://example.com/login');
        sawAuth = true;
      }
      if (ev.type === 'text') {
        out += ev.text;
      }
    }

    expect(sawAuth).toBe(true);
    expect(out).toBe('ok');
  }, 20_000);

  it('scrubs ambient provider credentials and projects only invocation-scoped AI Connection for Codex', () => {
    for (const key of ambientProviderKeys) {
      savedEnv[key] = process.env[key];
    }
    process.env.OPENAI_API_KEY = 'ambient-openai';
    process.env.OPENAI_BASE_URL = 'https://ambient-openai.example/v1';
    process.env.ANTHROPIC_API_KEY = 'ambient-anthropic';
    process.env.ANTHROPIC_BASE_URL = 'https://ambient-anthropic.example';
    process.env.DEFAULT_API_KEY = 'ambient-default';
    process.env.DEFAULT_API_BASE = 'https://ambient-default.example/v1';

    const rt = new AcpAgentRuntime();
    const env = (rt as any).buildRunnerEnv('codex', 'thread-env', process.cwd(), {
      id: 'agent',
      displayName: 'Agent',
      systemPrompt: '',
      executorType: 'codex',
      apiKey: 'gateway-key',
      baseUrl: 'http://127.0.0.1:3000/v1',
      model: 'linx',
      mcpServers: {},
      skills: [],
      enabled: true,
    });

    expect(env.AI_CONNECTION_BASE_URL).toBe('http://127.0.0.1:3000/v1');
    expect(env.AI_CONNECTION_API_KEY).toBe('gateway-key');
    expect(env.OPENAI_BASE_URL).toBe('http://127.0.0.1:3000/v1');
    expect(env.OPENAI_API_KEY).toBe('gateway-key');
    expect(env.DEFAULT_API_KEY).toBeUndefined();
    expect(env.DEFAULT_API_BASE).toBeUndefined();
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.ANTHROPIC_BASE_URL).toBeUndefined();
  });

  it('fails ACP model runners closed without explicit AI Connection config', () => {
    const rt = new AcpAgentRuntime();
    expect(() => (rt as any).buildRunnerEnv('codex', 'thread-missing', process.cwd(), {
      id: 'agent',
      displayName: 'Agent',
      systemPrompt: '',
      executorType: 'codex',
      apiKey: '',
      mcpServers: {},
      skills: [],
      enabled: true,
    })).toThrow(/AI Connection/);
  });

  function testAgentConfig() {
    return {
      id: 'agent-test',
      displayName: 'Agent Test',
      systemPrompt: '',
      executorType: 'codex' as const,
      apiKey: 'gateway-key',
      baseUrl: 'http://127.0.0.1:3000/v1',
      model: 'linx',
      mcpServers: {},
      skills: [],
      enabled: true,
    };
  }
});
