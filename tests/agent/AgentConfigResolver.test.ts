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

  it('falls back to Pod metadata when AGENT.md is missing', async () => {
    const metaRecord = {
      id: 'config',
      name: 'Secretary',
      description: 'Pod metadata description',
      instructions: 'You are from Pod metadata.',
      provider: 'http://pod.example/settings/ai/providers.ttl#anthropic',
      runtimeKind: 'claude',
      credential: 'http://pod.example/settings/credentials.ttl#anthropic-key',
      model: 'http://pod.example/settings/ai/models.ttl#claude-sonnet-4',
      enabled: 'true',
      maxTurns: 7,
    };

    const db = {
      query: {
        agentMeta: {
          findFirst: vi.fn().mockResolvedValue(metaRecord),
        },
      },
      findByLocator: vi.fn().mockImplementation((_table: unknown, locator: { id: string }) => {
        if (locator.id === 'claude-sonnet-4') {
          return Promise.resolve({
            id: 'claude-sonnet-4',
          });
        }
        return Promise.resolve(null);
      }),
      findByIri: vi.fn().mockImplementation((_table: unknown, iri: string) => {
        if (iri === 'http://pod.example/settings/ai/providers.ttl#anthropic') {
          return Promise.resolve({
            id: 'anthropic',
            displayName: 'Anthropic',
            baseUrl: 'https://api.anthropic.com',
            defaultModel: 'http://pod.example/settings/ai/models.ttl#claude-sonnet-4',
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
        if (iri === 'http://pod.example/settings/ai/models.ttl#claude-sonnet-4') {
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

  it('prefers AGENT.md prompt and frontmatter max-turns when present', async () => {
    const metaRecord = {
      id: 'config',
      name: 'Meta Name',
      instructions: 'Prompt from metadata.',
      provider: 'http://pod.example/settings/ai/providers.ttl#anthropic',
      runtimeKind: 'claude',
      enabled: 'true',
      maxTurns: 9,
    };

    const db = {
      query: {
        agentMeta: {
          findFirst: vi.fn().mockResolvedValue(metaRecord),
        },
      },
      findByLocator: vi.fn().mockImplementation((_table: unknown, locator: { id: string }) => {
        return Promise.resolve(null);
      }),
      findByIri: vi.fn().mockImplementation((_table: unknown, iri: string) => {
        if (iri === 'http://pod.example/settings/ai/providers.ttl#anthropic') {
          return Promise.resolve({
            id: 'anthropic',
            displayName: 'Anthropic',
            baseUrl: 'https://api.anthropic.com',
            defaultModel: 'http://pod.example/settings/ai/models.ttl#claude-sonnet-4',
            enabled: 'true',
          });
        }
        if (iri === 'http://pod.example/settings/ai/models.ttl#claude-sonnet-4') {
          return Promise.resolve({
            id: 'claude-sonnet-4',
          });
        }
        return Promise.resolve(null);
      }),
    };

    drizzleMock.mockReturnValue(db);

    const authenticatedFetch = vi.fn().mockResolvedValue({
      ok: true,
      text: vi.fn().mockResolvedValue(`---
name: Markdown Name
description: Markdown description
max-turns: 3
---

Prompt from markdown.
`),
    });

    const result = await resolveAgentConfig('secretary', {
      podBaseUrl: 'http://pod.example/',
      authenticatedFetch: authenticatedFetch as unknown as typeof fetch,
    });

    expect(result).toMatchObject({
      id: 'secretary',
      displayName: 'Meta Name',
      description: 'Markdown description',
      systemPrompt: 'Prompt from markdown.',
      maxTurns: 3,
      enabled: true,
    });
  });
});
