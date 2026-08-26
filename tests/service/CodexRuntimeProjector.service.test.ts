import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CodexRuntimeProjector } from '../../src/api/chatkit/runtime/CodexRuntimeProjector';
import type { ResolvedAgentConfig } from '../../src/agents/config/types';

describe('CodexRuntimeProjector', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('projects an Xpod Agent Profile into Codex runtime files', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xpod-codex-projector-'));
    tempDirs.push(root);
    const codexHome = path.join(root, '.codex');
    const agentConfig: ResolvedAgentConfig = {
      id: 'secretary',
      displayName: 'Secretary',
      systemPrompt: 'Help.',
      executorType: 'codex',
      model: 'gpt-test',
      enabled: true,
      mcpServers: {
        jina: {
          type: 'stdio',
          command: 'npx',
          args: ['-y', '@jina-ai/mcp-server'],
          env: { JINA_API_KEY: 'secret' },
        },
      },
      skills: [
        {
          name: 'drizzle solid',
          content: 'Use drizzle-solid.',
        },
      ],
    };

    new CodexRuntimeProjector().project({
      codexHome,
      baseUrl: 'https://api.openai.com/v1',
      apiKey: 'sk-test',
      wireApi: 'responses',
      model: 'gpt-test',
      agentConfig,
    });

    const configToml = fs.readFileSync(path.join(codexHome, 'config.toml'), 'utf8');
    expect(configToml).toContain('model_provider = "codex"');
    expect(configToml).toContain('model = "gpt-test"');
    expect(configToml).toContain('base_url = "https://api.openai.com/v1"');
    expect(configToml).toContain('wire_api = "responses"');
    expect(configToml).toContain('[mcp_servers.jina]');
    expect(configToml).toContain('command = "npx"');
    expect(configToml).toContain('args = ["-y","@jina-ai/mcp-server"]');
    expect(configToml).toContain('env = { JINA_API_KEY = "secret" }');

    expect(JSON.parse(fs.readFileSync(path.join(codexHome, 'auth.json'), 'utf8')))
      .toEqual({ OPENAI_API_KEY: 'sk-test' });
    expect(fs.readFileSync(path.join(codexHome, 'skills', 'drizzle-solid', 'SKILL.md'), 'utf8'))
      .toBe('Use drizzle-solid.');
  });

  it('fails closed when platform AI baseUrl or key is missing', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xpod-codex-projector-missing-'));
    tempDirs.push(root);

    expect(() => new CodexRuntimeProjector().project({
      codexHome: path.join(root, '.codex'),
      apiKey: 'gw-key',
      wireApi: 'responses',
    })).toThrow(/platform AI baseUrl/);

    expect(() => new CodexRuntimeProjector().project({
      codexHome: path.join(root, '.codex2'),
      baseUrl: 'http://127.0.0.1:3000/v1',
      wireApi: 'responses',
    })).toThrow(/platform AI API key/);
  });

  it('surfaces required config and auth write errors without leaking the key', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xpod-codex-projector-write-'));
    tempDirs.push(root);
    const codexHome = path.join(root, '.codex');
    const filesystem = {
      mkdirSync: () => undefined,
      writeFileSync: (target: fs.PathOrFileDescriptor) => {
        if (String(target).endsWith('auth.json')) {
          throw new Error('disk denied');
        }
      },
    };

    expect(() => new CodexRuntimeProjector(filesystem).project({
      codexHome,
      baseUrl: 'http://127.0.0.1:3000/v1',
      apiKey: 'gw-secret-key',
      wireApi: 'responses',
    })).toThrow(/auth\.json.*disk denied/);

    expect(() => new CodexRuntimeProjector(filesystem).project({
      codexHome,
      baseUrl: 'http://127.0.0.1:3000/v1',
      apiKey: 'gw-secret-key',
      wireApi: 'responses',
    })).not.toThrow(/gw-secret-key/);
  });
});
