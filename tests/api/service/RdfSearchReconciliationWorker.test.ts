import { describe, expect, it, vi } from 'vitest';

import { RdfSearchReconciliationWorker } from '../../../src/api/service/RdfSearchReconciliationWorker';
import {
  RdfSearchReconciliationRepository,
  type RdfSearchReconciliationRepository as RdfSearchReconciliationRepositoryType,
} from '../../../src/search/RdfSearchReconciliationRepository';
import type {
  RdfSearchIndexingService,
  RdfVectorIndexingResult,
} from '../../../src/api/service/RdfSearchIndexingService';
import { RunAuthContextRegistry } from '../../../src/api/runs/RunAuthContextRegistry';
import type { RdfTextSourceMetadata } from '../../../src/storage/rdf';
import { getIdentityDatabase } from '../../../src/identity/drizzle/db';

function context(webId = 'https://pod.example/alice/profile/card#me'): Record<string, unknown> {
  return {
    userId: 'alice',
    auth: {
      type: 'solid',
      webId,
      accessToken: 'token-1',
    },
  };
}

function inProgressRow(overrides: Record<string, unknown> = {}) {
  return {
    sourceKey: 'https://pod.example/alice/docs/a.md',
    sourceUri: 'https://pod.example/alice/docs/a.md',
    podRoot: 'https://pod.example/alice/',
    state: 'in-progress' as const,
    reason: 'source-changed',
    attemptCount: 0,
    nextAttemptAt: new Date('2026-08-12T00:00:00.000Z'),
    leaseOwner: 'worker-1',
    leaseExpiresAt: new Date('2026-08-12T00:01:00.000Z'),
    updatedAt: new Date('2026-08-12T00:00:00.000Z'),
    ...overrides,
  };
}

function repository(overrides: Partial<RdfSearchReconciliationRepositoryType> = {}) {
  return {
    claimNext: vi.fn(),
    complete: vi.fn(),
    markBlockedConfig: vi.fn(),
    markRetryable: vi.fn(),
    upsertDesired: vi.fn(),
    waitForConfig: vi.fn(),
    deleteSource: vi.fn(),
    listPodRoots: vi.fn(async () => []),
    ...overrides,
  } as unknown as RdfSearchReconciliationRepositoryType;
}

function source(overrides: Partial<RdfTextSourceMetadata> = {}): RdfTextSourceMetadata {
  return {
    sourceKey: 'https://pod.example/alice/docs/a.md',
    source: 'https://pod.example/alice/docs/a.md',
    workspace: 'https://pod.example/alice/',
    localPath: 'docs/a.md',
    contentType: 'text/markdown',
    sourceHash: 'hash-a',
    updatedAt: '2026-08-12T00:00:00.000Z',
    ...overrides,
  };
}

describe('RdfSearchReconciliationWorker', () => {
  it('claims runnable work with the process-local Pod context and completes successful vector rebuilds', async () => {
    const registry = new RunAuthContextRegistry();
    const storeContext = context();
    registry.remember(storeContext);
    const repo = repository({
      claimNext: vi.fn()
        .mockResolvedValueOnce(inProgressRow())
        .mockResolvedValue(undefined),
    });
    const rebuildVectorSource = vi.fn(async (): Promise<RdfVectorIndexingResult> => ({
      status: 'indexed',
      source: 'https://pod.example/alice/docs/a.md',
      model: 'linx-embedding',
      chunkCount: 1,
    }));
    const worker = new RdfSearchReconciliationWorker({
      repository: repo,
      indexingService: { rebuildVectorSource } as unknown as RdfSearchIndexingService,
      contextRegistry: registry,
      workerId: 'worker-1',
      now: () => Date.parse('2026-08-12T00:00:00.000Z'),
    });

    await expect(worker.drain()).resolves.toEqual({ processed: 1 });

    expect(rebuildVectorSource).toHaveBeenCalledWith({
      context: storeContext,
      sourceKey: 'https://pod.example/alice/docs/a.md',
    });
    expect(repo.complete).toHaveBeenCalledWith(
      'https://pod.example/alice/docs/a.md',
      'worker-1',
      new Date('2026-08-12T00:00:00.000Z'),
    );
  });

  it('keeps config failures blocked until a later profile wake rather than retrying online', async () => {
    const registry = new RunAuthContextRegistry();
    registry.remember(context());
    const repo = repository({
      claimNext: vi.fn()
        .mockResolvedValueOnce(inProgressRow({ reason: 'missing-ai-config' }))
        .mockResolvedValue(undefined),
    });
    const worker = new RdfSearchReconciliationWorker({
      repository: repo,
      indexingService: {
        rebuildVectorSource: vi.fn(async (): Promise<RdfVectorIndexingResult> => ({
          status: 'skipped',
          source: 'https://pod.example/alice/docs/a.md',
          reason: 'embedding_model_unavailable',
        })),
      } as unknown as RdfSearchIndexingService,
      contextRegistry: registry,
      workerId: 'worker-1',
      now: () => Date.parse('2026-08-12T00:00:00.000Z'),
    });

    await worker.drain();

    expect(repo.markBlockedConfig).toHaveBeenCalledWith(
      'https://pod.example/alice/docs/a.md',
      'worker-1',
      'embedding_model_unavailable',
      new Date('2026-08-12T00:00:00.000Z'),
    );
  });

  it('backs off provider failures without persisting API credentials', async () => {
    const registry = new RunAuthContextRegistry();
    registry.remember(context());
    const repo = repository({
      claimNext: vi.fn()
        .mockResolvedValueOnce(inProgressRow({ attemptCount: 1 }))
        .mockResolvedValue(undefined),
    });
    const worker = new RdfSearchReconciliationWorker({
      repository: repo,
      indexingService: {
        rebuildVectorSource: vi.fn(async (): Promise<RdfVectorIndexingResult> => ({
          status: 'retryable',
          source: 'https://pod.example/alice/docs/a.md',
          reason: 'embedding_provider_failed',
          providerId: 'cloudflare',
          model: 'linx-embedding',
          configFingerprint: 'sha256:profile-a',
        })),
      } as unknown as RdfSearchIndexingService,
      contextRegistry: registry,
      workerId: 'worker-1',
      now: () => Date.parse('2026-08-12T00:00:00.000Z'),
      retryBaseDelayMs: 60_000,
      retryMaxDelayMs: 300_000,
    });

    await worker.drain();

    expect(repo.markRetryable).toHaveBeenCalledWith(
      'https://pod.example/alice/docs/a.md',
      'worker-1',
      'embedding_provider_failed',
      new Date('2026-08-12T00:02:00.000Z'),
      new Date('2026-08-12T00:00:00.000Z'),
    );
    expect(JSON.stringify((repo.markRetryable as any).mock.calls)).not.toContain('sk-');
  });

  it('rebuilds runnable work after restart using a Pod config resolver without a live auth context', async () => {
    const registry = new RunAuthContextRegistry();
    const repo = repository({
      claimNext: vi.fn()
        .mockResolvedValueOnce(inProgressRow())
        .mockResolvedValue(undefined),
    });
    const rebuildVectorSource = vi.fn(async (): Promise<RdfVectorIndexingResult> => ({
      status: 'indexed',
      source: 'https://pod.example/alice/docs/a.md',
      providerId: 'cloudflare',
      model: 'linx-embedding',
      configFingerprint: 'sha256:profile-a',
      chunkCount: 1,
    }));
    const worker = new RdfSearchReconciliationWorker({
      repository: repo,
      indexingService: { rebuildVectorSource } as unknown as RdfSearchIndexingService,
      contextRegistry: registry,
      podConfigResolver: {
        getAiConfig: vi.fn(async () => ({
          providerId: 'cloudflare',
          baseUrl: 'https://api.cloudflare.com/client/v4/accounts/a/ai/v1',
          apiKey: 'sk-secret',
          credentialId: 'cred-1',
          embeddingModel: 'linx-embedding',
        })),
      },
      workerId: 'worker-1',
      now: () => Date.parse('2026-08-12T00:00:00.000Z'),
    });

    await expect(worker.drain()).resolves.toEqual({ processed: 1 });

    expect(rebuildVectorSource).toHaveBeenCalledWith({
      sourceKey: 'https://pod.example/alice/docs/a.md',
      embeddingConfig: expect.objectContaining({
        providerId: 'cloudflare',
        embeddingModel: 'linx-embedding',
        apiKey: 'sk-secret',
      }),
    });
    expect(JSON.stringify((repo.complete as any).mock.calls)).not.toContain('sk-secret');
  });

  it('deletes stale queue rows when committed FTS source chunks are gone', async () => {
    const registry = new RunAuthContextRegistry();
    const repo = repository({
      claimNext: vi.fn()
        .mockResolvedValueOnce(inProgressRow())
        .mockResolvedValue(undefined),
    });
    const worker = new RdfSearchReconciliationWorker({
      repository: repo,
      indexingService: {
        rebuildVectorSource: vi.fn(async (): Promise<RdfVectorIndexingResult> => ({
          status: 'skipped',
          source: 'https://pod.example/alice/docs/a.md',
          reason: 'text_source_unavailable',
        })),
      } as unknown as RdfSearchIndexingService,
      contextRegistry: registry,
      podConfigResolver: {
        getAiConfig: vi.fn(async () => ({
          providerId: 'cloudflare',
          baseUrl: 'https://api.cloudflare.com/client/v4/accounts/a/ai/v1',
          apiKey: 'sk-secret',
          credentialId: 'cred-1',
          embeddingModel: 'linx-embedding',
        })),
      },
      workerId: 'worker-1',
      now: () => Date.parse('2026-08-12T00:00:00.000Z'),
    });

    await worker.drain();

    expect(repo.deleteSource).toHaveBeenCalledWith('https://pod.example/alice/docs/a.md');
    expect(repo.complete).not.toHaveBeenCalled();
  });

  it('does not match a sibling Pod whose path only shares the same text prefix', async () => {
    const registry = new RunAuthContextRegistry();
    registry.remember(context('https://pod.example/alice/profile/card#me'));
    const repo = repository({
      claimNext: vi.fn()
        .mockResolvedValueOnce(inProgressRow({
          sourceKey: 'https://pod.example/alice2/docs/a.md',
          sourceUri: 'https://pod.example/alice2/docs/a.md',
        }))
        .mockResolvedValue(undefined),
    });
    const rebuildVectorSource = vi.fn(async (): Promise<RdfVectorIndexingResult> => ({
      status: 'indexed',
      source: 'https://pod.example/alice2/docs/a.md',
      chunkCount: 1,
    }));
    const worker = new RdfSearchReconciliationWorker({
      repository: repo,
      indexingService: { rebuildVectorSource } as unknown as RdfSearchIndexingService,
      contextRegistry: registry,
      workerId: 'worker-1',
      now: () => Date.parse('2026-08-12T00:00:00.000Z'),
    });

    await worker.drain();

    expect(rebuildVectorSource).not.toHaveBeenCalled();
    expect(repo.markRetryable).toHaveBeenCalledWith(
      'https://pod.example/alice2/docs/a.md',
      'worker-1',
      'auth_context_unavailable',
      new Date('2026-08-12T00:01:00.000Z'),
      new Date('2026-08-12T00:00:00.000Z'),
    );
  });

  it('uses the Pod config resolver when a durable row survives without a process-local context', async () => {
    const registry = new RunAuthContextRegistry();
    registry.remember(context());
    const repo = repository({
      claimNext: vi.fn()
        .mockResolvedValueOnce(inProgressRow({
          sourceKey: 'https://pod.example/alice2/docs/a.md',
          sourceUri: 'https://pod.example/alice2/docs/a.md',
          podRoot: 'https://pod.example/alice2/',
        }))
        .mockResolvedValue(undefined),
    });
    const rebuildVectorSource = vi.fn(async (): Promise<RdfVectorIndexingResult> => ({
      status: 'indexed',
      source: 'https://pod.example/alice2/docs/a.md',
      chunkCount: 1,
    }));
    const embeddingConfig = {
      providerId: 'cloudflare',
      baseUrl: 'https://api.cloudflare.com/client/v4/accounts/acct/ai/v1',
      embeddingModel: 'bge-small',
      apiKey: 'sk-pod',
      credentialId: 'https://pod.example/alice2/settings/credentials.ttl#default',
    };
    const worker = new RdfSearchReconciliationWorker({
      repository: repo,
      indexingService: { rebuildVectorSource } as unknown as RdfSearchIndexingService,
      contextRegistry: registry,
      podConfigResolver: { getAiConfig: vi.fn(async () => embeddingConfig) },
      workerId: 'worker-1',
      now: () => Date.parse('2026-08-12T00:00:00.000Z'),
    });

    await worker.drain();

    expect(rebuildVectorSource).toHaveBeenCalledWith({
      embeddingConfig,
      sourceKey: 'https://pod.example/alice2/docs/a.md',
    });
    expect(repo.complete).toHaveBeenCalledWith(
      'https://pod.example/alice2/docs/a.md',
      'worker-1',
      new Date('2026-08-12T00:00:00.000Z'),
    );
  });

  it('reports a row failure, releases the lease as retryable, and keeps draining the batch', async () => {
    const registry = new RunAuthContextRegistry();
    registry.remember(context());
    const first = inProgressRow({ sourceKey: 'first', sourceUri: 'https://pod.example/alice/docs/first.md' });
    const second = inProgressRow({ sourceKey: 'second', sourceUri: 'https://pod.example/alice/docs/second.md' });
    const repo = repository({
      claimNext: vi.fn()
        .mockResolvedValueOnce(first)
        .mockResolvedValueOnce(second)
        .mockResolvedValue(undefined),
    });
    const error = new Error('embedding worker failed');
    const onError = vi.fn();
    const rebuildVectorSource = vi.fn()
      .mockRejectedValueOnce(error)
      .mockResolvedValueOnce({
        status: 'indexed',
        source: 'https://pod.example/alice/docs/second.md',
        chunkCount: 1,
      } satisfies RdfVectorIndexingResult);
    const worker = new RdfSearchReconciliationWorker({
      repository: repo,
      indexingService: { rebuildVectorSource } as unknown as RdfSearchIndexingService,
      contextRegistry: registry,
      workerId: 'worker-1',
      now: () => Date.parse('2026-08-12T00:00:00.000Z'),
      onError,
    });

    await expect(worker.drain()).resolves.toEqual({ processed: 2 });

    expect(onError).toHaveBeenCalledWith(error, {
      phase: 'drain',
      sourceKey: 'first',
      sourceUri: 'https://pod.example/alice/docs/first.md',
    });
    expect(repo.markRetryable).toHaveBeenCalledWith(
      'first',
      'worker-1',
      'embedding_reconciliation_failed',
      new Date('2026-08-12T00:01:00.000Z'),
      new Date('2026-08-12T00:00:00.000Z'),
    );
    expect(repo.complete).toHaveBeenCalledWith('second', 'worker-1', new Date('2026-08-12T00:00:00.000Z'));
  });

  it('wakes all FTS sources in a remembered Pod scope when embedding config becomes available or changes', async () => {
    const registry = new RunAuthContextRegistry();
    const storeContext = context();
    registry.remember(storeContext);
    const repo = repository();
    const getAiConfig = vi.fn(async () => ({
      providerId: 'cloudflare',
      baseUrl: 'https://api.cloudflare.com/client/v4/accounts/a/ai/v1',
      apiKey: 'sk-secret',
      credentialId: 'cred-1',
      embeddingModel: 'linx-embedding',
      embeddingModelVersion: '2026-08-12',
    }));
    const listTextSources = vi.fn(async () => [
      source(),
      source({
        sourceKey: 'https://pod.example/alice/docs/b.md',
        source: 'https://pod.example/alice/docs/b.md',
        localPath: 'docs/b.md',
      }),
    ]);
    const worker = new RdfSearchReconciliationWorker({
      repository: repo,
      indexingService: { rebuildVectorSource: vi.fn() } as unknown as RdfSearchIndexingService,
      contextRegistry: registry,
      store: { getAiConfig },
      rdfEngine: { listTextSources },
      workerId: 'worker-1',
      now: () => Date.parse('2026-08-12T00:00:00.000Z'),
    });

    await expect(worker.reconcileRememberedContexts()).resolves.toEqual({ contexts: 1, sources: 2 });

    expect(listTextSources).toHaveBeenCalledWith({
      sourcePrefix: 'https://pod.example/alice/',
      limit: 1000,
      offset: 0,
    });
    expect(repo.upsertDesired).toHaveBeenCalledTimes(2);
    expect(repo.upsertDesired).toHaveBeenCalledWith(expect.objectContaining({
      sourceKey: 'https://pod.example/alice/docs/a.md',
      sourceUri: 'https://pod.example/alice/docs/a.md',
      providerId: 'cloudflare',
      model: 'linx-embedding',
      modelVersion: '2026-08-12',
      sourceHash: 'hash-a',
      sourceVersion: undefined,
      reason: 'embedding-config-observed',
    }), new Date('2026-08-12T00:00:00.000Z'));
    expect(JSON.stringify((repo.upsertDesired as any).mock.calls)).not.toContain('sk-secret');
  });

  it('paginates remembered Pod source reconciliation beyond one page', async () => {
    const registry = new RunAuthContextRegistry();
    registry.remember(context());
    const repo = repository();
    const firstPage = [
      source({ sourceKey: 'source-1', source: 'https://pod.example/alice/docs/1.md' }),
      source({ sourceKey: 'source-2', source: 'https://pod.example/alice/docs/2.md' }),
    ];
    const secondPage = [
      source({ sourceKey: 'source-3', source: 'https://pod.example/alice/docs/3.md' }),
    ];
    const listTextSources = vi.fn()
      .mockResolvedValueOnce(firstPage)
      .mockResolvedValueOnce(secondPage);
    const worker = new RdfSearchReconciliationWorker({
      repository: repo,
      indexingService: { rebuildVectorSource: vi.fn() } as unknown as RdfSearchIndexingService,
      contextRegistry: registry,
      store: {
        getAiConfig: vi.fn(async () => ({
          providerId: 'cloudflare',
          baseUrl: 'https://api.cloudflare.com/client/v4/accounts/a/ai/v1',
          apiKey: 'sk-secret',
          credentialId: 'cred-1',
          embeddingModel: 'linx-embedding',
        })),
      },
      rdfEngine: { listTextSources },
      workerId: 'worker-1',
      now: () => Date.parse('2026-08-12T00:00:00.000Z'),
      sourcePageSize: 2,
    });

    await expect(worker.reconcileRememberedContexts()).resolves.toEqual({ contexts: 1, sources: 3 });

    expect(listTextSources).toHaveBeenNthCalledWith(1, {
      sourcePrefix: 'https://pod.example/alice/',
      limit: 2,
      offset: 0,
    });
    expect(listTextSources).toHaveBeenNthCalledWith(2, {
      sourcePrefix: 'https://pod.example/alice/',
      limit: 2,
      offset: 2,
    });
    expect(repo.upsertDesired).toHaveBeenCalledTimes(3);
  });

  it('reconciles durable pod roots after restart and reports resolver errors without fallback', async () => {
    const registry = new RunAuthContextRegistry();
    const repo = repository({
      listPodRoots: vi.fn(async () => [
        'https://pod.example/alice/',
        'https://pod.example/bob/',
      ]),
    });
    const onError = vi.fn();
    const listTextSources = vi.fn(async () => [source()]);
    const resolver = {
      getAiConfig: vi.fn(async (podRoot: string) => {
        if (podRoot === 'https://pod.example/bob/') {
          throw new Error('qlever config read failed');
        }
        return {
          providerId: 'cloudflare',
          baseUrl: 'https://api.cloudflare.com/client/v4/accounts/a/ai/v1',
          apiKey: 'sk-secret',
          credentialId: 'cred-1',
          embeddingModel: 'linx-embedding',
          embeddingModelVersion: '2026-08-12',
        };
      }),
    };
    const worker = new RdfSearchReconciliationWorker({
      repository: repo,
      indexingService: { rebuildVectorSource: vi.fn() } as unknown as RdfSearchIndexingService,
      contextRegistry: registry,
      podConfigResolver: resolver,
      rdfEngine: { listTextSources },
      workerId: 'worker-1',
      now: () => Date.parse('2026-08-12T00:00:00.000Z'),
      onError,
    });

    await expect(worker.reconcileRememberedContexts()).resolves.toEqual({ contexts: 1, sources: 1 });

    expect(listTextSources).toHaveBeenCalledWith({
      sourcePrefix: 'https://pod.example/alice/',
      limit: 1000,
      offset: 0,
    });
    expect(listTextSources).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith(expect.any(Error), { phase: 'reconcile' });
    expect(JSON.stringify((repo.upsertDesired as any).mock.calls)).not.toContain('sk-secret');
  });

  it('prefers the server-authority Pod profile over a remembered live context for the same Pod', async () => {
    const registry = new RunAuthContextRegistry();
    registry.remember(context());
    const repo = repository({
      listPodRoots: vi.fn(async () => ['https://pod.example/alice/']),
    });
    const listTextSources = vi.fn(async () => [source()]);
    const worker = new RdfSearchReconciliationWorker({
      repository: repo,
      indexingService: { rebuildVectorSource: vi.fn() } as unknown as RdfSearchIndexingService,
      contextRegistry: registry,
      store: {
        getAiConfig: vi.fn(async () => ({
          providerId: 'cloudflare',
          baseUrl: 'https://api.cloudflare.com/client/v4/accounts/a/ai/v1',
          apiKey: 'live-secret',
          credentialId: 'cred-1',
          embeddingModel: 'linx-embedding',
        })),
      },
      podConfigResolver: {
        getAiConfig: vi.fn(async () => ({
          providerId: 'cloudflare',
          baseUrl: 'https://api.cloudflare.com/client/v4/accounts/a/ai/v1',
          apiKey: 'authority-secret',
          credentialId: 'cred-1',
          embeddingModel: 'linx-embedding',
          embeddingModelVersion: '2026-08-13',
        })),
      },
      rdfEngine: { listTextSources },
      workerId: 'worker-1',
      now: () => Date.parse('2026-08-13T00:00:00.000Z'),
    });

    await expect(worker.reconcileRememberedContexts()).resolves.toEqual({ contexts: 1, sources: 1 });

    expect(listTextSources).toHaveBeenCalledTimes(1);
    expect(repo.upsertDesired).toHaveBeenCalledWith(expect.objectContaining({
      modelVersion: '2026-08-13',
    }), new Date('2026-08-13T00:00:00.000Z'));
    expect(JSON.stringify((repo.upsertDesired as any).mock.calls)).not.toMatch(/live-secret|authority-secret/);
  });

  it('does not requeue an applied source on repeated same-profile and same-text reconciliation but wakes it on text hash change', async () => {
    const registry = new RunAuthContextRegistry();
    registry.remember(context());
    const repo = new RdfSearchReconciliationRepository(
      getIdentityDatabase('sqlite::memory:rdf-search-worker-applied'),
    );
    let sourceHash = 'hash-a';
    const listTextSources = vi.fn(async () => [source({ sourceHash })]);
    let modelVersion = '2026-08-12';
    const worker = new RdfSearchReconciliationWorker({
      repository: repo,
      indexingService: {
        rebuildVectorSource: vi.fn(async (): Promise<RdfVectorIndexingResult> => ({
          status: 'indexed',
          source: 'https://pod.example/alice/docs/a.md',
          model: 'linx-embedding',
          chunkCount: 1,
        })),
      } as unknown as RdfSearchIndexingService,
      contextRegistry: registry,
      store: {
        getAiConfig: vi.fn(async () => ({
          providerId: 'cloudflare',
          baseUrl: 'https://api.cloudflare.com/client/v4/accounts/a/ai/v1',
          apiKey: 'sk-secret',
          credentialId: 'cred-1',
          embeddingModel: 'linx-embedding',
          embeddingModelVersion: modelVersion,
        })),
      },
      rdfEngine: { listTextSources },
      workerId: 'worker-1',
      now: () => Date.parse('2026-08-12T00:00:00.000Z'),
    });

    await worker.reconcileRememberedContexts();
    expect(await repo.listRunnable(new Date('2026-08-12T00:00:00.000Z'))).toHaveLength(1);
    await worker.drain();
    expect(await repo.listRunnable(new Date('2026-08-12T00:00:00.000Z'))).toHaveLength(0);

    await worker.reconcileRememberedContexts();
    expect(await repo.listRunnable(new Date('2026-08-12T00:02:00.000Z'))).toHaveLength(0);

    sourceHash = 'hash-b';
    await worker.reconcileRememberedContexts();
    const runnable = await repo.listRunnable(new Date('2026-08-12T00:02:00.000Z'));
    expect(runnable).toHaveLength(1);
    expect(runnable[0]).toMatchObject({
      state: 'ready',
      modelVersion: '2026-08-12',
      sourceHash: 'hash-b',
    });
  });
});
