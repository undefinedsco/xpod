import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import { RdfSearchIndexingSolidFsSyncer } from '../../../src/api/service/RdfSearchIndexingSolidFsSyncer';
import {
  RdfSearchReconciliationRepository,
  type RdfSearchAppliedInput,
  type RdfSearchBlockedConfigInput,
  type RdfSearchConfigWaitInput,
  type RdfSearchReconciliationRow,
  type RdfSearchReconciliationState,
  type RdfSearchRetryableInput,
} from '../../../src/search/RdfSearchReconciliationRepository';
import { RdfSearchReconciliationWorker } from '../../../src/api/service/RdfSearchReconciliationWorker';
import { RunAuthContextRegistry } from '../../../src/api/runs/RunAuthContextRegistry';
import type {
  RdfSearchIndexingService,
  RdfVectorDeleteResult,
  RdfVectorIndexingResult,
} from '../../../src/api/service/RdfSearchIndexingService';
import type { SolidFsChange, SolidFsManifest } from '../../../src/solidfs';
import { getIdentityDatabase } from '../../../src/identity/drizzle/db';

const context = {
  auth: {
    type: 'solid',
    webId: 'https://pod.example/alice/profile/card#me',
    clientId: 'solid-client-id',
    clientSecret: 'solid-client-secret',
    viaApiKey: true,
  },
};

function fingerprint(input: {
  providerId: string;
  embeddingModel: string;
  embeddingModelVersion?: string;
  credentialId: string;
}): string {
  return `sha256:${createHash('sha256')
    .update([
      input.providerId,
      input.embeddingModel,
      input.embeddingModelVersion ?? 'no-model-version',
      input.credentialId,
    ].join('\0'))
    .digest('hex')}`;
}

describe('RdfSearchIndexingSolidFsSyncer', () => {
  it('indexes changed line-addressable text files with the current Pod context', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'xpod-rdf-search-solidfs-'));
    const filePath = path.join(root, 'docs', 'runbook.md');
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, '# Runbook\n\nManaged runtime notes.\n', 'utf8');
    const runbookHash = createHash('sha256').update('# Runbook\n\nManaged runtime notes.\n').digest('hex');
    const rebuildVectorSource = vi.fn(async (_input: {
      context: unknown;
      sourceKey: string;
    }): Promise<RdfVectorIndexingResult> => ({
      status: 'indexed',
      source: 'https://pod.example/alice/projects/demo/docs/runbook.md',
      sourceHash: runbookHash,
      chunkCount: 1,
      providerId: 'cloudflare',
      model: 'text-embedding-3-small',
      configFingerprint: fingerprint({
        providerId: 'cloudflare',
        embeddingModel: 'text-embedding-3-small',
        credentialId: 'cred-1',
      }),
    }));
    const onResult = vi.fn();
    const deleteSource = vi.fn(async () => {});
    const upsertApplied = vi.fn(async (input: RdfSearchAppliedInput): Promise<RdfSearchReconciliationRow> =>
      reconciliationRow(input, 'applied'));
    const syncer = new RdfSearchIndexingSolidFsSyncer({
      service: { rebuildVectorSource } as unknown as RdfSearchIndexingService,
      onResult,
      reconciliationRepository: {
        deleteSource,
        upsertApplied,
        upsertBlockedConfig: upsertBlockedConfigMock(),
        waitForConfig: waitForConfigMock(),
        upsertRetryable: upsertRetryableMock(),
      },
    });

    try {
      await syncer.sync(
        change('docs/runbook.md', filePath, 'updated', 'text/markdown'),
        manifestFor('https://pod.example/alice/projects/demo/'),
        context,
      );

      expect(rebuildVectorSource).toHaveBeenCalledWith({
        context,
        sourceKey: 'https://pod.example/alice/projects/demo/docs/runbook.md',
      });
      expect(onResult).toHaveBeenCalledWith({
        status: 'indexed',
        source: 'https://pod.example/alice/projects/demo/docs/runbook.md',
        sourceHash: runbookHash,
        chunkCount: 1,
        providerId: 'cloudflare',
        model: 'text-embedding-3-small',
        configFingerprint: fingerprint({
          providerId: 'cloudflare',
          embeddingModel: 'text-embedding-3-small',
          credentialId: 'cred-1',
        }),
      });
      expect(upsertApplied).toHaveBeenCalledWith(expect.objectContaining({
        sourceKey: 'https://pod.example/alice/projects/demo/docs/runbook.md',
        sourceUri: 'https://pod.example/alice/projects/demo/docs/runbook.md',
        providerId: 'cloudflare',
        model: 'text-embedding-3-small',
        sourceHash: runbookHash,
        sourceVersion: undefined,
        reason: 'source-indexed',
      }));
      expect(upsertApplied.mock.calls[0][0].configFingerprint).toMatch(/^sha256:[0-9a-f]{64}$/);
      expect(deleteSource).not.toHaveBeenCalled();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('uses the explicit resource as the canonical vector source', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'xpod-rdf-search-resource-'));
    const filePath = path.join(root, 'messages.ttl');
    await writeFile(filePath, '<#msg> <https://schema.org/text> "hello" .\n', 'utf8');
    const rebuildVectorSource = vi.fn(async (_input: {
      context: unknown;
      sourceKey: string;
    }): Promise<RdfVectorIndexingResult> => ({
      status: 'indexed',
      source: 'https://pod.example/alice/.data/chat/default/2026/06/09/messages.ttl',
      chunkCount: 1,
    }));
    const syncer = new RdfSearchIndexingSolidFsSyncer({
      service: { rebuildVectorSource } as unknown as RdfSearchIndexingService,
    });

    try {
      await syncer.sync(
        {
          ...change('ignored/messages.ttl', filePath, 'updated', 'text/turtle'),
          resource: 'https://pod.example/alice/.data/chat/default/2026/06/09/messages.ttl',
        },
        manifestFor('https://pod.example/alice/projects/demo/'),
        context,
      );

      expect(rebuildVectorSource.mock.calls[0][0].sourceKey).toBe(
        'https://pod.example/alice/.data/chat/default/2026/06/09/messages.ttl',
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('deletes vector source chunks for removed indexed files', async () => {
    const deleteVectorSource = vi.fn(async (): Promise<RdfVectorDeleteResult> => ({
      status: 'deleted',
      source: 'https://pod.example/alice/projects/demo/docs/runbook.md',
      deletedChunks: 3,
    }));
    const deleteSource = vi.fn(async () => {});
    const syncer = new RdfSearchIndexingSolidFsSyncer({
      service: { deleteVectorSource } as unknown as RdfSearchIndexingService,
      reconciliationRepository: {
        deleteSource,
        upsertBlockedConfig: upsertBlockedConfigMock(),
        waitForConfig: waitForConfigMock(),
        upsertRetryable: upsertRetryableMock(),
        upsertApplied: upsertAppliedMock(),
      },
    });

    await syncer.sync(
      change('docs/runbook.md', '/tmp/missing.md', 'deleted', 'text/markdown'),
      manifestFor('https://pod.example/alice/projects/demo/'),
      context,
    );

    expect(deleteVectorSource).toHaveBeenCalledWith({
      source: 'https://pod.example/alice/projects/demo/docs/runbook.md',
    });
    expect(deleteSource).toHaveBeenCalledWith('https://pod.example/alice/projects/demo/docs/runbook.md');
  });

  it('persists skipped missing embedding config for later reconciliation', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'xpod-rdf-search-wait-config-'));
    const filePath = path.join(root, 'notes.txt');
    await writeFile(filePath, 'notes', 'utf8');
    const waitForConfig = waitForConfigMock();
    const notesHash = createHash('sha256').update('notes').digest('hex');
    const rebuildVectorSource = vi.fn(async (): Promise<RdfVectorIndexingResult> => ({
      status: 'skipped',
      source: 'https://pod.example/alice/projects/demo/notes.txt',
      sourceHash: notesHash,
      reason: 'ai_config_unavailable',
    }));
    const syncer = new RdfSearchIndexingSolidFsSyncer({
      service: { rebuildVectorSource } as unknown as RdfSearchIndexingService,
      reconciliationRepository: {
        waitForConfig,
        deleteSource: vi.fn(),
        upsertBlockedConfig: upsertBlockedConfigMock(),
        upsertRetryable: upsertRetryableMock(),
        upsertApplied: upsertAppliedMock(),
      },
    });

    try {
      await syncer.sync(
        change('notes.txt', filePath, 'updated', 'text/plain'),
        manifestFor('https://pod.example/alice/projects/demo/'),
        context,
      );

      expect(waitForConfig).toHaveBeenCalledWith({
        sourceKey: 'https://pod.example/alice/projects/demo/notes.txt',
        sourceUri: 'https://pod.example/alice/projects/demo/notes.txt',
        podRoot: 'https://pod.example/alice/projects/demo/',
        sourceHash: notesHash,
        sourceVersion: undefined,
        reason: 'ai_config_unavailable',
        failureCategory: 'ai_config_unavailable',
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('does not read or rechunk the raw SolidFS file when rebuilding from committed FTS', async () => {
    const waitForConfig = waitForConfigMock();
    const rebuildVectorSource = vi.fn(async (): Promise<RdfVectorIndexingResult> => ({
      status: 'skipped',
      source: 'https://pod.example/alice/projects/demo/missing-on-disk.txt',
      sourceHash: 'committed-fts-hash',
      sourceVersion: 'fts-version-1',
      reason: 'ai_config_unavailable',
    }));
    const syncer = new RdfSearchIndexingSolidFsSyncer({
      service: { rebuildVectorSource } as unknown as RdfSearchIndexingService,
      reconciliationRepository: {
        waitForConfig,
        deleteSource: vi.fn(),
        upsertBlockedConfig: upsertBlockedConfigMock(),
        upsertRetryable: upsertRetryableMock(),
        upsertApplied: upsertAppliedMock(),
      },
    });

    await expect(syncer.sync(
      change('missing-on-disk.txt', '/tmp/xpod-does-not-exist/missing-on-disk.txt', 'updated', 'text/plain'),
      manifestFor('https://pod.example/alice/projects/demo/'),
      context,
    )).resolves.toBeUndefined();

    expect(rebuildVectorSource).toHaveBeenCalledWith({
      context,
      sourceKey: 'https://pod.example/alice/projects/demo/missing-on-disk.txt',
    });
    expect(waitForConfig).toHaveBeenCalledWith(expect.objectContaining({
      sourceKey: 'https://pod.example/alice/projects/demo/missing-on-disk.txt',
      sourceHash: 'committed-fts-hash',
      sourceVersion: 'fts-version-1',
    }));
  });

  it('persists retryable provider failures with a bounded retry delay', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'xpod-rdf-search-retryable-'));
    const filePath = path.join(root, 'notes.txt');
    await writeFile(filePath, 'notes', 'utf8');
    const upsertRetryable = upsertRetryableMock();
    const notesHash = createHash('sha256').update('notes').digest('hex');
    const rebuildVectorSource = vi.fn(async (): Promise<RdfVectorIndexingResult> => ({
      status: 'retryable',
      source: 'https://pod.example/alice/projects/demo/notes.txt',
      sourceHash: notesHash,
      reason: 'embedding_provider_failed',
      providerId: 'cloudflare',
      model: 'linx-embedding',
      configFingerprint: fingerprint({
        providerId: 'cloudflare',
        embeddingModel: 'linx-embedding',
        credentialId: 'cred-1',
      }),
      message: 'quota exceeded',
    }));
    const syncer = new RdfSearchIndexingSolidFsSyncer({
      service: { rebuildVectorSource } as unknown as RdfSearchIndexingService,
      reconciliationRepository: {
        waitForConfig: waitForConfigMock(),
        deleteSource: vi.fn(),
        upsertBlockedConfig: upsertBlockedConfigMock(),
        upsertRetryable,
        upsertApplied: upsertAppliedMock(),
      },
      now: () => Date.parse('2026-08-12T00:00:00.000Z'),
      retryDelayMs: 120_000,
    });

    try {
      await syncer.sync(
        change('notes.txt', filePath, 'updated', 'text/plain'),
        manifestFor('https://pod.example/alice/projects/demo/'),
        context,
      );

      expect(upsertRetryable).toHaveBeenCalledWith(expect.objectContaining({
        sourceKey: 'https://pod.example/alice/projects/demo/notes.txt',
        sourceUri: 'https://pod.example/alice/projects/demo/notes.txt',
        providerId: 'cloudflare',
        model: 'linx-embedding',
        sourceHash: notesHash,
        sourceVersion: undefined,
        reason: 'embedding_provider_failed',
        failureCategory: 'embedding_provider_failed',
        nextAttemptAt: new Date('2026-08-12T00:02:00.000Z'),
      }));
      expect(upsertRetryable.mock.calls[0][0].configFingerprint).toMatch(/^sha256:[0-9a-f]{64}$/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('persists first-attempt authentication failures as blocked until the profile changes', async () => {
    const upsertBlockedConfig = vi.fn(async (input) => reconciliationRow(input, 'blocked-config'));
    const profileFingerprint = fingerprint({
      providerId: 'cloudflare',
      embeddingModel: 'linx-embedding',
      credentialId: 'cred-invalid',
    });
    const syncer = new RdfSearchIndexingSolidFsSyncer({
      service: {
        rebuildVectorSource: vi.fn(async (): Promise<RdfVectorIndexingResult> => ({
          status: 'skipped',
          source: 'https://pod.example/alice/projects/demo/notes.txt',
          sourceHash: 'sha256:notes',
          reason: 'embedding_authentication_failed',
          providerId: 'cloudflare',
          model: 'linx-embedding',
          modelVersion: 'unversioned',
          configFingerprint: profileFingerprint,
        })),
      } as unknown as RdfSearchIndexingService,
      reconciliationRepository: {
        waitForConfig: waitForConfigMock(),
        deleteSource: vi.fn(),
        upsertRetryable: upsertRetryableMock(),
        upsertBlockedConfig,
        upsertApplied: upsertAppliedMock(),
      },
    });

    await syncer.sync(
      change('notes.txt', '/tmp/not-read-by-syncer.txt', 'updated', 'text/plain'),
      manifestFor('https://pod.example/alice/projects/demo/'),
      context,
    );

    expect(upsertBlockedConfig).toHaveBeenCalledWith({
      sourceKey: 'https://pod.example/alice/projects/demo/notes.txt',
      sourceUri: 'https://pod.example/alice/projects/demo/notes.txt',
      podRoot: 'https://pod.example/alice/projects/demo/',
      providerId: 'cloudflare',
      model: 'linx-embedding',
      modelVersion: 'unversioned',
      configFingerprint: profileFingerprint,
      sourceHash: 'sha256:notes',
      sourceVersion: undefined,
      reason: 'embedding_authentication_failed',
      failureCategory: 'embedding_authentication_failed',
    });
  });

  it('records direct indexed profiles as applied so periodic reconcile is idempotent until the model changes', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'xpod-rdf-search-applied-'));
    const filePath = path.join(root, 'notes.txt');
    await writeFile(filePath, 'notes', 'utf8');
    const repo = new RdfSearchReconciliationRepository(
      getIdentityDatabase('sqlite::memory:rdf-search-solidfs-applied'),
    );
    const sourceUri = 'https://pod.example/alice/notes.txt';
    const notesHash = createHash('sha256').update('notes').digest('hex');
    const syncer = new RdfSearchIndexingSolidFsSyncer({
      service: {
        rebuildVectorSource: vi.fn(async (): Promise<RdfVectorIndexingResult> => ({
          status: 'indexed',
          source: sourceUri,
          sourceHash: notesHash,
          providerId: 'cloudflare',
          model: 'linx-embedding',
          modelVersion: '2026-08-12',
          configFingerprint: fingerprint({
            providerId: 'cloudflare',
            embeddingModel: 'linx-embedding',
            embeddingModelVersion: '2026-08-12',
            credentialId: 'cred-1',
          }),
          chunkCount: 1,
        })),
      } as unknown as RdfSearchIndexingService,
      reconciliationRepository: repo,
    });
    const registry = new RunAuthContextRegistry();
    registry.remember(context);
    let modelVersion = '2026-08-12';
    const worker = new RdfSearchReconciliationWorker({
      repository: repo,
      indexingService: {
        rebuildVectorSource: vi.fn(async (): Promise<RdfVectorIndexingResult> => ({
          status: 'indexed',
          source: sourceUri,
          providerId: 'cloudflare',
          model: 'linx-embedding',
          modelVersion,
          configFingerprint: fingerprint({
            providerId: 'cloudflare',
            embeddingModel: 'linx-embedding',
            embeddingModelVersion: modelVersion,
            credentialId: 'cred-1',
          }),
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
      rdfEngine: {
        listTextSources: vi.fn(async () => [{
          sourceKey: sourceUri,
          source: sourceUri,
          workspace: 'https://pod.example/alice/',
          localPath: 'notes.txt',
          contentType: 'text/plain',
          sourceHash: notesHash,
          updatedAt: '2026-08-12T00:00:00.000Z',
        }]),
      },
      workerId: 'worker-1',
      now: () => Date.parse('2026-08-12T00:00:00.000Z'),
    });

    try {
      await syncer.sync(
        change('notes.txt', filePath, 'updated', 'text/plain'),
        manifestFor('https://pod.example/alice/'),
        context,
      );
      await expect(repo.get(sourceUri)).resolves.toMatchObject({
        state: 'applied',
        modelVersion: '2026-08-12',
      });

      await worker.reconcileRememberedContexts();
      expect(await repo.listRunnable(new Date('2026-08-12T00:02:00.000Z'))).toHaveLength(0);

      modelVersion = '2026-08-13';
      await worker.reconcileRememberedContexts();
      const runnable = await repo.listRunnable(new Date('2026-08-12T00:02:00.000Z'));
      expect(runnable).toHaveLength(1);
      expect(runnable[0]).toMatchObject({
        state: 'ready',
        modelVersion: '2026-08-13',
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('skips without a Pod store context and does not block commits on indexing failures by default', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'xpod-rdf-search-error-'));
    const filePath = path.join(root, 'notes.txt');
    await writeFile(filePath, 'notes', 'utf8');
    const error = new Error('embedding provider unavailable');
    const rebuildVectorSource = vi.fn(async () => {
      throw error;
    });
    const onError = vi.fn();
    const syncer = new RdfSearchIndexingSolidFsSyncer({
      service: { rebuildVectorSource } as unknown as RdfSearchIndexingService,
      onError,
    });

    try {
      await syncer.sync(
        change('notes.txt', filePath, 'updated', 'text/plain'),
        manifestFor('https://pod.example/alice/projects/demo/'),
      );
      expect(rebuildVectorSource).not.toHaveBeenCalled();

      await expect(syncer.sync(
        change('notes.txt', filePath, 'updated', 'text/plain'),
        manifestFor('https://pod.example/alice/projects/demo/'),
        context,
      )).resolves.toBeUndefined();
      expect(onError).toHaveBeenCalledWith(error, expect.objectContaining({
        source: 'https://pod.example/alice/projects/demo/notes.txt',
      }));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('can be configured to fail fast when the caller wants journal retry semantics', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'xpod-rdf-search-fail-fast-'));
    const filePath = path.join(root, 'notes.txt');
    await writeFile(filePath, 'notes', 'utf8');
    const error = new Error('embedding provider unavailable');
    const syncer = new RdfSearchIndexingSolidFsSyncer({
      service: {
        rebuildVectorSource: vi.fn(async () => {
          throw error;
        }),
      } as unknown as RdfSearchIndexingService,
      failOnError: true,
    });

    try {
      await expect(syncer.sync(
        change('notes.txt', filePath, 'updated', 'text/plain'),
        manifestFor('https://pod.example/alice/projects/demo/'),
        context,
      )).rejects.toThrow(error);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

function change(
  pathValue: string,
  sourcePath: string,
  type: SolidFsChange['type'],
  contentType: string,
): SolidFsChange {
  return {
    path: pathValue,
    resource: undefined,
    source: 'pod-http',
    sourcePath,
    contentType,
    projection: 'direct',
    type,
  };
}

function manifestFor(workspace: string): SolidFsManifest {
  return {
    workspace,
    cwd: '/tmp/workspace',
    projection: 'direct',
    entries: [],
  };
}

function waitForConfigMock() {
  return vi.fn(async (input: RdfSearchConfigWaitInput): Promise<RdfSearchReconciliationRow> =>
    reconciliationRow(input, 'waiting-config'));
}

function upsertRetryableMock() {
  return vi.fn(async (input: RdfSearchRetryableInput): Promise<RdfSearchReconciliationRow> =>
    reconciliationRow(input, 'retryable'));
}

function upsertBlockedConfigMock() {
  return vi.fn(async (input: RdfSearchBlockedConfigInput): Promise<RdfSearchReconciliationRow> =>
    reconciliationRow(input, 'blocked-config'));
}

function upsertAppliedMock() {
  return vi.fn(async (input: RdfSearchAppliedInput): Promise<RdfSearchReconciliationRow> =>
    reconciliationRow(input, 'applied'));
}

function reconciliationRow(
  input: RdfSearchConfigWaitInput | RdfSearchRetryableInput | RdfSearchBlockedConfigInput | RdfSearchAppliedInput,
  state: RdfSearchReconciliationState,
): RdfSearchReconciliationRow {
  const desired = input as Partial<RdfSearchAppliedInput>;
  return {
    sourceKey: input.sourceKey,
    sourceUri: input.sourceUri,
    podRoot: input.podRoot,
    providerId: desired.providerId,
    model: desired.model,
    modelVersion: desired.modelVersion,
    configFingerprint: desired.configFingerprint,
    sourceHash: input.sourceHash,
    sourceVersion: input.sourceVersion,
    state,
    reason: input.reason,
    attemptCount: state === 'retryable' ? 1 : 0,
    nextAttemptAt: 'nextAttemptAt' in input ? input.nextAttemptAt : new Date(0),
    failureCategory: 'failureCategory' in input ? input.failureCategory : undefined,
    updatedAt: new Date(0),
  };
}
