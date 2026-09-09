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
