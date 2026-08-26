import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const db = vi.hoisted(() => ({
  findById: vi.fn(),
  findByIri: vi.fn(),
  query: {
    credential: { findMany: vi.fn() },
    provider: { findMany: vi.fn() },
  },
}));

const selection = vi.hoisted(() => vi.fn());

vi.mock('@undefineds.co/drizzle-solid', async (importOriginal) => {
  const original = await importOriginal<typeof import('@undefineds.co/drizzle-solid')>();
  return {
    ...original,
    drizzle: vi.fn(() => db),
  };
});

vi.mock('@undefineds.co/models', async (importOriginal) => {
  const original = await importOriginal<typeof import('@undefineds.co/models')>();
  return {
    ...original,
    selectAIConfigCredential: selection,
  };
});

import { AgentExecutorFactory } from '../../src/agents/AgentExecutorFactory';

describe('AgentExecutorFactory server transport boundary', () => {
  const savedEdition = process.env.XPOD_EDITION;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.XPOD_EDITION = 'cloud';
    db.findById.mockResolvedValue({
      id: 'openai',
      displayName: 'OpenAI',
      enabled: 'true',
      baseUrl: 'http://169.254.169.254/latest',
      defaultModel: null,
      hasModel: null,
    });
    db.query.credential.findMany.mockResolvedValue([]);
    db.query.provider.findMany.mockResolvedValue([]);
    selection.mockReturnValue({
      providerId: 'openai',
      apiKey: 'pod-key',
      baseUrl: 'http://169.254.169.254/latest',
      proxyUrl: 'http://127.0.0.1:7890',
      credential: {},
    });
  });

  afterEach(() => {
    if (savedEdition === undefined) delete process.env.XPOD_EDITION;
    else process.env.XPOD_EDITION = savedEdition;
  });

  it('rejects Pod-controlled CodeBuddy endpoints before creating an executor in cloud edition', async () => {
    const factory = new AgentExecutorFactory();

    const executor = await factory.create(
      'https://pod.example/alice/',
      'openai',
      'codebuddy',
      vi.fn() as unknown as typeof fetch,
      'https://pod.example/alice/profile/card#me',
    );

    expect(executor).toBeNull();
    expect(db.findByIri).not.toHaveBeenCalled();
  });
});
