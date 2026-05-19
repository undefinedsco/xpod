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
      apiKey: 'sk-test',
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
});
