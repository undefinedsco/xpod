import { beforeEach, describe, expect, it, vi } from 'vitest';

const { drizzleMock } = vi.hoisted(() => ({
  drizzleMock: vi.fn(),
}));

vi.mock('global-logger-factory', () => ({
  getLoggerFor: () => ({
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
  }),
}));

vi.mock('@undefineds.co/drizzle-solid', async () => {
  const actual = await vi.importActual<typeof import('@undefineds.co/drizzle-solid')>('@undefineds.co/drizzle-solid');
  return {
    ...actual,
    drizzle: drizzleMock,
  };
});

import { resolveAgentConfig } from '../../src/agents/config/resolve';

describe('resolveAgentConfig', () => {
  beforeEach(() => {
    drizzleMock.mockReset();
  });

  it('falls back to Pod metadata when AGENTS.md is missing', async () => {
    const metaRecord = {
      id: 'config',
      name: 'Secretary',
      description: 'Pod metadata description',
      instructions: 'You are from Pod metadata.',
      provider: 'http://pod.example/settings/providers/anthropic.ttl',
      runtimeKind: 'claude',
      credential: 'http://pod.example/settings/credentials.ttl#anthropic-key',
      model: 'http://pod.example/settings/providers/anthropic.ttl#claude-sonnet-4',
      enabled: 'true',
      maxTurns: 7,
    };

    const db = {
      findById: vi.fn().mockImplementation((_table: unknown, id: string) => {
        if (id === '.meta#config') {
          return Promise.resolve(metaRecord);
        }
        return Promise.resolve(null);
      }),
      findByIri: vi.fn().mockImplementation((_table: unknown, iri: string) => {
        if (iri === 'http://pod.example/settings/providers/anthropic.ttl') {
          return Promise.resolve({
            id: 'anthropic',
            displayName: 'Anthropic',
            baseUrl: 'https://api.anthropic.com',
            defaultModel: 'http://pod.example/settings/providers/anthropic.ttl#claude-sonnet-4',
            enabled: 'true',
          });
        }
        if (iri === 'http://pod.example/settings/credentials.ttl#anthropic-key') {
          return Promise.resolve({
            id: 'anthropic-key',
            apiKey: 'sk-ant-test',
            baseUrl: 'https://cred.example',
            proxyUrl: 'http://proxy.example',
          });
        }
        if (iri === 'http://pod.example/settings/providers/anthropic.ttl#claude-sonnet-4') {
          return Promise.resolve({
            id: 'claude-sonnet-4',
          });
        }
        return Promise.resolve(null);
      }),
    };

    drizzleMock.mockReturnValue(db);

    const authenticatedFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 404,
    });

    const result = await resolveAgentConfig('secretary', {
      podBaseUrl: 'http://pod.example/',
      authenticatedFetch: authenticatedFetch as unknown as typeof fetch,
      webId: 'http://pod.example/profile/card#me',
    });

    expect(result).toMatchObject({
      id: 'secretary',
      displayName: 'Secretary',
      description: 'Pod metadata description',
      systemPrompt: 'You are from Pod metadata.',
      executorType: 'claude',
      apiKey: 'sk-ant-test',
      baseUrl: 'https://cred.example',
      proxyUrl: 'http://proxy.example',
      model: 'claude-sonnet-4',
      maxTurns: 7,
      enabled: true,
    });
    expect(authenticatedFetch).toHaveBeenCalledTimes(1);
  });

  it('uses AGENTS.md as plain instructions and structured fields from .meta', async () => {
    const metaRecord = {
      id: 'config',
      name: 'Meta Name',
      description: 'Meta description',
      instructions: 'Prompt from metadata.',
      provider: 'http://pod.example/settings/providers/anthropic.ttl',
      runtimeKind: 'claude',
      enabled: 'true',
      maxTurns: 9,
      allowedTools: ['Read', 'Write'],
      disallowedTools: ['Bash'],
      permissionMode: 'acceptEdits',
      skills: ['skills/local-skill', '/skills/shared-skill'],
      mcpServers: [JSON.stringify({
        name: 'jina',
        transport: 'stdio',
        command: 'npx',
        args: ['-y', '@jina-ai/mcp-server'],
      })],
    };

    const db = {
      findById: vi.fn().mockImplementation((_table: unknown, id: string) => {
        if (id === '.meta#config') {
          return Promise.resolve(metaRecord);
        }
        return Promise.resolve(null);
      }),
      findByIri: vi.fn().mockImplementation((_table: unknown, iri: string) => {
        if (iri === 'http://pod.example/settings/providers/anthropic.ttl') {
          return Promise.resolve({
            id: 'anthropic',
            displayName: 'Anthropic',
            baseUrl: 'https://api.anthropic.com',
            defaultModel: 'http://pod.example/settings/providers/anthropic.ttl#claude-sonnet-4',
            enabled: 'true',
          });
        }
        if (iri === 'http://pod.example/settings/providers/anthropic.ttl#claude-sonnet-4') {
          return Promise.resolve({
            id: 'claude-sonnet-4',
          });
        }
        return Promise.resolve(null);
      }),
    };

    drizzleMock.mockReturnValue(db);

    const authenticatedFetch = vi.fn().mockImplementation((url: string) => {
      const href = String(url);
      if (href.endsWith('/agents/secretary/AGENTS.md')) {
        return Promise.resolve({
          ok: true,
          text: vi.fn().mockResolvedValue('---\nname: should-not-be-frontmatter\n---\n\nPrompt from agents file.'),
        });
      }
      if (href.endsWith('/agents/secretary/skills/local-skill/SKILL.md')) {
        return Promise.resolve({
          ok: true,
          text: vi.fn().mockResolvedValue('---\nname: local\n---\n\nLocal skill body.'),
        });
      }
      if (href.endsWith('/skills/shared-skill/SKILL.md')) {
        return Promise.resolve({
          ok: true,
          text: vi.fn().mockResolvedValue('Shared skill body.'),
        });
      }
      return Promise.resolve({ ok: false, status: 404 });
    });

    const result = await resolveAgentConfig('secretary', {
      podBaseUrl: 'http://pod.example/',
      authenticatedFetch: authenticatedFetch as unknown as typeof fetch,
    });

    expect(result).toMatchObject({
      id: 'secretary',
      displayName: 'Meta Name',
      description: 'Meta description',
      systemPrompt: '---\nname: should-not-be-frontmatter\n---\n\nPrompt from agents file.',
      maxTurns: 9,
      allowedTools: ['Read', 'Write'],
      disallowedTools: ['Bash'],
      permissionMode: 'acceptEdits',
      mcpServers: {
        jina: {
          type: 'stdio',
          command: 'npx',
          args: ['-y', '@jina-ai/mcp-server'],
        },
      },
      skills: [
        { name: 'local-skill', content: '---\nname: local\n---\n\nLocal skill body.' },
        { name: 'shared-skill', content: 'Shared skill body.' },
      ],
      skillsContent: 'Local skill body.\n\n---\n\nShared skill body.',
      enabled: true,
    });
    expect(authenticatedFetch).not.toHaveBeenCalledWith(expect.stringContaining('/mcp/'));
    expect(authenticatedFetch).not.toHaveBeenCalledWith(expect.stringContaining('/rules/'));
  });
});
