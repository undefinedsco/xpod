import * as path from 'node:path';
import * as fs from 'node:fs';
import { afterEach, describe, it, expect } from 'vitest';
import { AcpAgentRuntime } from '../../src/api/chatkit/runtime/AcpAgentRuntime';
import { sanitizeRuntimeEnv } from '../../src/runtime/safe-env';

describe('ACP Thread Runtime', () => {
  const workspaceRef = `file://localhost${process.cwd()}`;
  const savedEnv: Record<string, string | undefined> = {};
  const ambientProviderKeys = [
    'OPENAI_API_KEY',
    'OPENAI_BASE_URL',
    'OPENAI_API_BASE',
    'OPENAI_ORG_ID',
    'OPENAI_ORGANIZATION',
    'OPENAI_PROJECT',
    'OPENAI_MODEL',
    'CODEX_API_KEY',
    'CODEX_MODEL',
    'ANTHROPIC_API_KEY',
    'ANTHROPIC_AUTH_TOKEN',
    'ANTHROPIC_BASE_URL',
    'ANTHROPIC_DEFAULT_SONNET_MODEL',
    'ANTHROPIC_DEFAULT_HAIKU_MODEL',
    'ANTHROPIC_DEFAULT_OPUS_MODEL',
    'DEFAULT_API_KEY',
    'DEFAULT_API_BASE',
    'DEFAULT_PROVIDER',
    'DEFAULT_MODEL',
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
    process.env.DEFAULT_API_KEY = 'gateway-key';
    process.env.DEFAULT_API_BASE = 'http://127.0.0.1:3000/v1';
    process.env.DEFAULT_MODEL = 'linx';

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
    process.env.DEFAULT_API_KEY = 'gateway-key';
    process.env.DEFAULT_API_BASE = 'http://127.0.0.1:3000/v1';
    process.env.DEFAULT_MODEL = 'linx';

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

  it('keeps ambient and raw Pod provider credentials out of Codex, Claude and ACP runner env', () => {
    for (const key of ambientProviderKeys) {
      savedEnv[key] = process.env[key];
    }
    process.env.OPENAI_API_KEY = 'ambient-openai';
    process.env.OPENAI_BASE_URL = 'https://ambient-openai.example/v1';
    process.env.OPENAI_API_BASE = 'https://ambient-openai-api-base.example/v1';
    process.env.OPENAI_ORG_ID = 'ambient-openai-org-id';
    process.env.OPENAI_ORGANIZATION = 'ambient-openai-organization';
    process.env.OPENAI_PROJECT = 'ambient-openai-project';
    process.env.OPENAI_MODEL = 'ambient-openai-model';
    process.env.CODEX_API_KEY = 'ambient-codex-key';
    process.env.CODEX_MODEL = 'ambient-codex-model';
    process.env.ANTHROPIC_API_KEY = 'ambient-anthropic';
    process.env.ANTHROPIC_AUTH_TOKEN = 'ambient-anthropic-token';
    process.env.ANTHROPIC_BASE_URL = 'https://ambient-anthropic.example';
    process.env.ANTHROPIC_DEFAULT_SONNET_MODEL = 'ambient-sonnet';
    process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL = 'ambient-haiku';
    process.env.ANTHROPIC_DEFAULT_OPUS_MODEL = 'ambient-opus';
    process.env.DEFAULT_API_KEY = 'gateway-key';
    process.env.DEFAULT_API_BASE = 'http://127.0.0.1:3000/v1';
    process.env.DEFAULT_PROVIDER = 'openai';
    process.env.DEFAULT_MODEL = 'linx';

    const rt = new AcpAgentRuntime();
    const rawProviderKey = 'raw-pod-provider-key';
    const agentConfig = {
      id: 'agent',
      displayName: 'Agent',
      systemPrompt: '',
      executorType: 'codex',
      apiKey: rawProviderKey,
      baseUrl: 'https://raw-provider.example/v1',
      model: 'linx',
      mcpServers: {},
      skills: [],
      enabled: true,
    };
    const env = (rt as any).buildRunnerEnv(
      'codex',
      'thread-env',
      process.cwd(),
      agentConfig,
    );
    const args = (rt as any).resolveRunnerArgv('codex', [ 'node', 'runner.js' ]);
    const authJson = fs.readFileSync(path.join(env.CODEX_HOME, 'auth.json'), 'utf8');
    const serializedEnv = JSON.stringify(env);
    const sanitizedProcessEnv = sanitizeRuntimeEnv(process.env);

    expect(env.AI_CONNECTIONS_BASE_URL).toBe('http://127.0.0.1:3000/v1');
    expect(env.AI_CONNECTIONS_API_KEY).toBe('gateway-key');
    expect(env.OPENAI_BASE_URL).toBe('http://127.0.0.1:3000/v1');
    expect(env.OPENAI_API_BASE).toBe('http://127.0.0.1:3000/v1');
    expect(env.OPENAI_API_KEY).toBe('gateway-key');
    expect(env.CODEX_API_KEY).toBe('gateway-key');
    expect(env.OPENAI_MODEL).toBe('linx');
    expect(env.CODEX_MODEL).toBe('linx');
    expect(env.OPENAI_ORG_ID).toBeUndefined();
    expect(env.OPENAI_ORGANIZATION).toBeUndefined();
    expect(env.OPENAI_PROJECT).toBeUndefined();
    expect(env.DEFAULT_API_KEY).toBeUndefined();
    expect(env.DEFAULT_API_BASE).toBeUndefined();
    expect(env.DEFAULT_PROVIDER).toBeUndefined();
    expect(env.DEFAULT_MODEL).toBeUndefined();
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
    expect(env.ANTHROPIC_BASE_URL).toBeUndefined();
    for (const ambientValue of [
      'ambient-openai',
      'https://ambient-openai.example/v1',
      'https://ambient-openai-api-base.example/v1',
      'ambient-openai-org-id',
      'ambient-openai-organization',
      'ambient-openai-project',
      'ambient-openai-model',
      'ambient-codex-key',
      'ambient-codex-model',
      'ambient-anthropic',
      'ambient-anthropic-token',
      'https://ambient-anthropic.example',
      'ambient-sonnet',
      'ambient-haiku',
      'ambient-opus',
    ]) {
      expect(serializedEnv).not.toContain(ambientValue);
      expect(JSON.stringify(sanitizedProcessEnv)).not.toContain(ambientValue);
    }
    for (const key of ambientProviderKeys) {
      expect(sanitizedProcessEnv[key]).toBeUndefined();
    }
    expect(serializedEnv).not.toContain(rawProviderKey);
    expect(authJson).toContain('gateway-key');
    expect(authJson).not.toContain(rawProviderKey);
    expect(JSON.stringify(args)).not.toContain(rawProviderKey);

    const claudeEnv = (rt as any).buildRunnerEnv(
      'claude',
      'thread-env',
      process.cwd(),
      agentConfig,
    );
    expect(claudeEnv.ANTHROPIC_API_KEY).toBe('gateway-key');
    expect(claudeEnv.ANTHROPIC_BASE_URL).toBe('http://127.0.0.1:3000');
    expect(claudeEnv.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe('linx');
    expect(claudeEnv.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe('linx');
    expect(claudeEnv.ANTHROPIC_DEFAULT_OPUS_MODEL).toBe('linx');
    expect(claudeEnv.OPENAI_API_KEY).toBeUndefined();
    expect(claudeEnv.CODEX_API_KEY).toBeUndefined();
    expect(claudeEnv.DEFAULT_API_KEY).toBeUndefined();
    expect(JSON.stringify(claudeEnv)).not.toContain(rawProviderKey);
    expect(JSON.stringify(claudeEnv)).not.toContain('ambient-anthropic');
  });

  it('fails ACP model runners closed when only a raw Pod provider config is present', () => {
    delete process.env.DEFAULT_API_KEY;
    delete process.env.DEFAULT_API_BASE;
    const rt = new AcpAgentRuntime();
    expect(() => (rt as any).buildRunnerEnv('codex', 'thread-missing', process.cwd(), {
      id: 'agent',
      displayName: 'Agent',
      systemPrompt: '',
      executorType: 'codex',
      apiKey: 'raw-pod-provider-key',
      baseUrl: 'https://raw-provider.example/v1',
      mcpServers: {},
      skills: [],
      enabled: true,
    })).toThrow(/platform AI/);
    expect(() => (rt as any).buildRunnerEnv('claude', 'thread-missing', process.cwd(), {
      id: 'agent',
      displayName: 'Agent',
      systemPrompt: '',
      executorType: 'claude',
      apiKey: 'raw-pod-provider-key',
      baseUrl: 'https://raw-provider.example/v1',
      mcpServers: {},
      skills: [],
      enabled: true,
    })).toThrow(/platform AI/);
  });

  it('fails ACP model runners closed before projecting non-platform models to gateway env', () => {
    process.env.DEFAULT_API_KEY = 'gateway-key';
    process.env.DEFAULT_API_BASE = 'http://127.0.0.1:3000/v1';
    process.env.DEFAULT_MODEL = 'gpt-test';
    const rt = new AcpAgentRuntime();

    expect(() => (rt as any).buildRunnerEnv('codex', 'thread-non-platform', process.cwd(), {
      id: 'agent',
      displayName: 'Agent',
      systemPrompt: '',
      executorType: 'codex',
      model: 'gpt-test',
      mcpServers: {},
      skills: [],
      enabled: true,
    })).toThrow(/only supports shared platform models/);
  });

  function testAgentConfig() {
    return {
      id: 'agent-test',
      displayName: 'Agent Test',
      systemPrompt: '',
      executorType: 'codex' as const,
      model: 'linx',
      mcpServers: {},
      skills: [],
      enabled: true,
    };
  }
});
