import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import { RdfSearchIndexingSolidFsSyncer } from '../../../src/api/service/RdfSearchIndexingSolidFsSyncer';
import type {
  RdfSearchIndexingService,
  RdfVectorDeleteResult,
  RdfVectorIndexingResult,
} from '../../../src/api/service/RdfSearchIndexingService';
import type { SolidFsChange, SolidFsManifest } from '../../../src/solidfs';

const context = {
  auth: {
    type: 'solid',
    webId: 'https://pod.example/alice/profile/card#me',
    accessToken: 'token-123',
  },
};

describe('RdfSearchIndexingSolidFsSyncer', () => {
  it('indexes changed line-addressable text files with the current Pod context', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'xpod-rdf-search-solidfs-'));
    const filePath = path.join(root, 'docs', 'runbook.md');
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, '# Runbook\n\nManaged runtime notes.\n', 'utf8');
    const indexVectorSource = vi.fn(async (): Promise<RdfVectorIndexingResult> => ({
      status: 'indexed',
      source: 'https://pod.example/alice/projects/demo/docs/runbook.md',
      chunkCount: 1,
      model: 'text-embedding-3-small',
    }));
    const onResult = vi.fn();
    const syncer = new RdfSearchIndexingSolidFsSyncer({
      service: { indexVectorSource } as unknown as RdfSearchIndexingService,
      onResult,
    });

    try {
      await syncer.sync(
        change('docs/runbook.md', filePath, 'updated', 'text/markdown'),
        manifestFor('https://pod.example/alice/projects/demo/'),
        context,
      );

      expect(indexVectorSource).toHaveBeenCalledWith({
        context,
        source: {
          source: 'https://pod.example/alice/projects/demo/docs/runbook.md',
          workspace: 'https://pod.example/alice/projects/demo/',
          localPath: 'docs/runbook.md',
          contentType: 'text/markdown',
          sourceVersion: undefined,
        },
        text: '# Runbook\n\nManaged runtime notes.\n',
      });
      expect(onResult).toHaveBeenCalledWith({
        status: 'indexed',
        source: 'https://pod.example/alice/projects/demo/docs/runbook.md',
        chunkCount: 1,
        model: 'text-embedding-3-small',
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('uses the explicit resource as the canonical vector source', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'xpod-rdf-search-resource-'));
    const filePath = path.join(root, 'messages.ttl');
    await writeFile(filePath, '<#msg> <https://schema.org/text> "hello" .\n', 'utf8');
    const indexVectorSource = vi.fn(async (): Promise<RdfVectorIndexingResult> => ({
      status: 'indexed',
      source: 'https://pod.example/alice/.data/chat/default/2026/06/09/messages.ttl',
      chunkCount: 1,
    }));
    const syncer = new RdfSearchIndexingSolidFsSyncer({
      service: { indexVectorSource } as unknown as RdfSearchIndexingService,
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

      expect(indexVectorSource.mock.calls[0][0].source.source).toBe(
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
    const syncer = new RdfSearchIndexingSolidFsSyncer({
      service: { deleteVectorSource } as unknown as RdfSearchIndexingService,
    });

    await syncer.sync(
      change('docs/runbook.md', '/tmp/missing.md', 'deleted', 'text/markdown'),
      manifestFor('https://pod.example/alice/projects/demo/'),
      context,
    );

    expect(deleteVectorSource).toHaveBeenCalledWith({
      source: 'https://pod.example/alice/projects/demo/docs/runbook.md',
    });
  });

  it('skips without a Pod store context and does not block commits on indexing failures by default', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'xpod-rdf-search-error-'));
    const filePath = path.join(root, 'notes.txt');
    await writeFile(filePath, 'notes', 'utf8');
    const error = new Error('embedding provider unavailable');
    const indexVectorSource = vi.fn(async () => {
      throw error;
    });
    const onError = vi.fn();
    const syncer = new RdfSearchIndexingSolidFsSyncer({
      service: { indexVectorSource } as unknown as RdfSearchIndexingService,
      onError,
    });

    try {
      await syncer.sync(
        change('notes.txt', filePath, 'updated', 'text/plain'),
        manifestFor('https://pod.example/alice/projects/demo/'),
      );
      expect(indexVectorSource).not.toHaveBeenCalled();

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
        indexVectorSource: vi.fn(async () => {
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
