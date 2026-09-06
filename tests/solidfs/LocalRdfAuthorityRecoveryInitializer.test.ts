import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type { FileIdentifierMapper, ResourceIdentifier } from '@solid/community-server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  LocalRdfAuthorityRecoveryInitializer,
  RootedSolidFsSyncJournal,
} from '../../src/solidfs';
import type { LocalRdfIndexAccessor } from '../../src/storage/accessors/MixDataAccessor';

describe('LocalRdfAuthorityRecoveryInitializer', () => {
  let root: string;
  let authorityRoot: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'xpod-rdf-authority-recovery-'));
    authorityRoot = path.join(root, 'data');
    await mkdir(authorityRoot, { recursive: true });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('bootstraps authority files and replays them into the derived index', async () => {
    const rdfPath = path.join(authorityRoot, 'alice', 'profile.ttl');
    const jsonLdPath = path.join(authorityRoot, 'alice', 'settings.jsonld');
    await mkdir(path.dirname(rdfPath), { recursive: true });
    await writeFile(rdfPath, '<#me> <https://schema.org/name> "Alice" .\n', 'utf8');
    await writeFile(jsonLdPath, '{"@id":"#settings"}\n', 'utf8');
    await writeFile(path.join(authorityRoot, 'ignored.bin'), 'binary', 'utf8');

    const journal = new RootedSolidFsSyncJournal(authorityRoot);
    const syncLocalRdfDocument = vi.fn(async () => undefined);
    const mapper = resourceMapper(authorityRoot);
    const initializer = new LocalRdfAuthorityRecoveryInitializer(
      journal,
      rdfIndex({ syncLocalRdfDocument }),
      mapper,
      'https://pod.example/',
      authorityRoot,
    );

    await initializer.handle();

    expect(mapper.mapFilePathToUrl).toHaveBeenCalledTimes(2);
    expect(syncLocalRdfDocument).toHaveBeenCalledTimes(2);
    expect(journal.listOperations()).toEqual(expect.arrayContaining([
      expect.objectContaining({ stage: 'done', change: expect.objectContaining({
        resource: 'https://pod.example/alice/profile.ttl',
      }) }),
      expect.objectContaining({ stage: 'done', change: expect.objectContaining({
        resource: 'https://pod.example/alice/settings.jsonld',
      }) }),
    ]));
    await initializer.finalize();
  });

  it('replays unchanged authority files after the derived index is replaced', async () => {
    const rdfPath = path.join(authorityRoot, 'alice', 'settings', 'providers', 'timecc.ttl');
    await mkdir(path.dirname(rdfPath), { recursive: true });
    await writeFile(rdfPath, '<#provider> <https://undefineds.co/ns#displayName> "timecc" .\n', 'utf8');

    const firstSync = vi.fn(async () => undefined);
    const first = new LocalRdfAuthorityRecoveryInitializer(
      new RootedSolidFsSyncJournal(authorityRoot),
      rdfIndex({ syncLocalRdfDocument: firstSync }),
      resourceMapper(authorityRoot),
      'https://pod.example/',
      authorityRoot,
    );
    await first.handle();
    await first.finalize();

    const replacementIndexSync = vi.fn(async () => undefined);
    const restarted = new LocalRdfAuthorityRecoveryInitializer(
      new RootedSolidFsSyncJournal(authorityRoot),
      rdfIndex({ syncLocalRdfDocument: replacementIndexSync }),
      resourceMapper(authorityRoot),
      'https://pod.example/',
      authorityRoot,
    );
    await restarted.handle();

    expect(firstSync).toHaveBeenCalledOnce();
    expect(replacementIndexSync).toHaveBeenCalledOnce();
    await restarted.finalize();
  });

  it('fails startup when replay leaves retryable index work', async () => {
    await writeFile(
      path.join(authorityRoot, 'data.ttl'),
      '<#data> <https://schema.org/name> "Data" .\n',
      'utf8',
    );
    const journal = new RootedSolidFsSyncJournal(authorityRoot);
    const initializer = new LocalRdfAuthorityRecoveryInitializer(
      journal,
      rdfIndex({ syncLocalRdfDocument: vi.fn().mockRejectedValue(new Error('index unavailable')) }),
      resourceMapper(authorityRoot),
      'https://pod.example/',
      authorityRoot,
    );

    await expect(initializer.handle()).rejects.toThrow(
      'Local RDF authority recovery left 1 retryable and 0 reconcile-required operations',
    );
    expect(journal.listOperations()).toEqual([
      expect.objectContaining({ stage: 'failed_retryable', retryCount: 1 }),
    ]);
    await initializer.finalize();
  });

  it('removes stale index entries for files deleted while the server was offline', async () => {
    const rdfPath = path.join(authorityRoot, 'removed.ttl');
    await writeFile(rdfPath, '<#data> <https://schema.org/name> "Removed" .\n');
    const first = new LocalRdfAuthorityRecoveryInitializer(
      new RootedSolidFsSyncJournal(authorityRoot), rdfIndex({}),
      resourceMapper(authorityRoot), 'https://pod.example/', authorityRoot,
    );
    await first.handle();
    await first.finalize();
    await rm(rdfPath);

    const deleteLocalRdfIndex = vi.fn(async () => undefined);
    const restarted = new LocalRdfAuthorityRecoveryInitializer(
      new RootedSolidFsSyncJournal(authorityRoot), rdfIndex({ deleteLocalRdfIndex }),
      resourceMapper(authorityRoot), 'https://pod.example/', authorityRoot,
    );
    try {
      await restarted.handle();
      expect(deleteLocalRdfIndex).toHaveBeenCalledOnce();
      expect(deleteLocalRdfIndex).toHaveBeenCalledWith({ path: 'https://pod.example/removed.ttl' });
    } finally {
      await restarted.finalize();
    }
  });

  it('retains pending operations and their retry history across restarts', async () => {
    await writeFile(path.join(authorityRoot, 'pending.ttl'), '<#data> <https://schema.org/name> "Pending" .\n');
    let operationId: string | undefined;
    for (const retryCount of [1, 2]) {
      const journal = new RootedSolidFsSyncJournal(authorityRoot);
      const initializer = new LocalRdfAuthorityRecoveryInitializer(
        journal,
        rdfIndex({ syncLocalRdfDocument: vi.fn().mockRejectedValue(new Error('index unavailable')) }),
        resourceMapper(authorityRoot), 'https://pod.example/', authorityRoot,
      );
      try {
        await expect(initializer.handle()).rejects.toThrow('1 retryable');
        const operations = journal.listOperations();
        expect(operations).toHaveLength(1);
        operationId ??= operations[0].id;
        expect(operations[0]).toMatchObject({ id: operationId, stage: 'failed_retryable', retryCount });
      } finally {
        await initializer.finalize();
      }
    }
  });

  function resourceMapper(rootPath: string): FileIdentifierMapper {
    return {
      mapFilePathToUrl: vi.fn(async (filePath: string) => ({
        identifier: {
          path: new URL(
            path.relative(rootPath, filePath).split(path.sep).join('/'),
            'https://pod.example/',
          ).href,
        },
        filePath,
        contentType: 'text/turtle',
        isMetadata: false,
      })),
      mapUrlToFilePath: vi.fn(),
    };
  }

  function rdfIndex(overrides: Partial<LocalRdfIndexAccessor>): LocalRdfIndexAccessor {
    return {
      syncLocalRdfDocument: async () => undefined,
      deleteLocalRdfIndex: async (_identifier: ResourceIdentifier) => undefined,
      ...overrides,
    };
  }
});
