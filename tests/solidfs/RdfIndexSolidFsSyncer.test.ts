import { describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import arrayifyStream from 'arrayify-stream';
import { RepresentationMetadata, guardStream, INTERNAL_QUADS } from '@solid/community-server';
import { Readable } from 'node:stream';

import { LocalSolidFS, RdfIndexSolidFsSyncer } from '../../src/solidfs';
import { RdfTextIndex } from '../../src/storage/rdf';
import type { SolidFsChange, SolidFsManifest } from '../../src/solidfs';

function mockAccessor(overrides: Record<string, unknown> = {}) {
  return {
    canHandle: vi.fn().mockResolvedValue(undefined),
    getData: vi.fn(),
    getMetadata: vi.fn(),
    getChildren: vi.fn(),
    writeContainer: vi.fn().mockResolvedValue(undefined),
    writeDocument: vi.fn().mockResolvedValue(undefined),
    writeMetadata: vi.fn().mockResolvedValue(undefined),
    deleteResource: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  } as any;
}

describe('RdfIndexSolidFsSyncer', () => {
  it('refreshes the RDF index from SolidFS-updated local Turtle files', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'xpod-solidfs-rdf-sync-'));
    const source = path.join(root, 'workspace');
    await mkdir(source, { recursive: true });
    await writeFile(path.join(source, 'data.ttl'), '<#me> <https://schema.org/name> "before" .\n', 'utf8');

    const structured = mockAccessor();
    const index = {
      async syncLocalRdfDocument(identifier: { path: string }, data: any, contentType?: string): Promise<void> {
        const chunks = await arrayifyStream(data);
        const text = chunks
          .map((chunk: Buffer | Uint8Array | string) => typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'))
          .join('');
        await structured.writeDocument(
          identifier,
          guardStream(Readable.from([text])),
          new RepresentationMetadata(identifier, { 'content-type': INTERNAL_QUADS }),
        );
        (structured.writeDocument as any).mock.calls[(structured.writeDocument as any).mock.calls.length - 1].push(contentType);
      },
      async deleteLocalRdfIndex(identifier: { path: string }): Promise<void> {
        await structured.deleteResource(identifier);
      },
    };

    try {
      const solidfs = new LocalSolidFS({
        syncer: new RdfIndexSolidFsSyncer({ index }),
      });
      const workspace = await solidfs.prepare({
        workspace: 'https://pod.example/alice/projects/demo/',
        sourcePath: source,
        projection: 'direct',
      });

      await writeFile(path.join(workspace.cwd, 'data.ttl'), '<#me> <https://schema.org/name> "after" .\n', 'utf8');
      await workspace.commit();

      expect(structured.writeDocument).toHaveBeenCalledTimes(1);
      expect(structured.writeDocument.mock.calls[0][0]).toEqual({
        path: 'https://pod.example/alice/projects/demo/data.ttl',
      });
      expect(structured.writeDocument.mock.calls[0][3]).toBe('text/turtle');
      const indexedChunks = await arrayifyStream(structured.writeDocument.mock.calls[0][1]);
      const indexedText = indexedChunks
        .map((chunk: Buffer | Uint8Array | string) => typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'))
        .join('');
      expect(indexedText).toContain('after');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('indexes direct workspace Markdown changes into the derived text index', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'xpod-solidfs-text-sync-'));
    const source = path.join(root, 'workspace');
    const textIndex = new RdfTextIndex({ path: ':memory:' });
    textIndex.open();
    await mkdir(path.join(source, 'docs'), { recursive: true });

    try {
      const solidfs = new LocalSolidFS({
        syncer: new RdfIndexSolidFsSyncer({
          index: {
            syncLocalRdfDocument: vi.fn().mockResolvedValue(undefined),
            deleteLocalRdfIndex: vi.fn().mockResolvedValue(undefined),
          },
          textIndex,
        }),
      });
      const workspace = await solidfs.prepare({
        workspace: 'https://pod.example/alice/projects/demo/',
        sourcePath: source,
        projection: 'direct',
      });

      await writeFile(path.join(workspace.cwd, 'docs', 'runbook.md'), '# Runbook\n\nManaged runtime notes.\n', 'utf8');
      const manifest = await workspace.commit();

      expect(manifest.changes).toEqual([
        {
          path: path.join('docs', 'runbook.md'),
        resource: 'https://pod.example/alice/projects/demo/docs/runbook.md',
          source: 'pod-http',
          sourcePath: path.join(source, 'docs', 'runbook.md'),
          contentType: 'text/markdown',
          projection: 'direct',
          type: 'created',
        },
      ]);
      expect(textIndex.search({ query: 'managed runtime' })).toMatchObject([
        {
          source: 'https://pod.example/alice/projects/demo/docs/runbook.md',
          workspace: 'https://pod.example/alice/projects/demo/',
          localPath: 'docs/runbook.md',
          contentType: 'text/markdown',
          heading: 'Runbook',
          path: ['Runbook'],
        },
      ]);
    } finally {
      textIndex.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('removes deleted Markdown sources from the derived text index', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'xpod-solidfs-text-delete-'));
    const source = path.join(root, 'workspace');
    const textIndex = new RdfTextIndex({ path: ':memory:' });
    textIndex.open();
    await mkdir(source, { recursive: true });
    await writeFile(path.join(source, 'runbook.md'), '# Runbook\n\nDelete me later.\n', 'utf8');

    try {
      const solidfs = new LocalSolidFS({
        syncer: new RdfIndexSolidFsSyncer({
          index: {
            syncLocalRdfDocument: vi.fn().mockResolvedValue(undefined),
            deleteLocalRdfIndex: vi.fn().mockResolvedValue(undefined),
          },
          textIndex,
        }),
      });
      const workspace = await solidfs.prepare({
        workspace: 'https://pod.example/alice/projects/demo/',
        sourcePath: source,
        projection: 'direct',
      });

      textIndex.indexText({
        source: 'https://pod.example/alice/projects/demo/runbook.md',
        workspace: 'https://pod.example/alice/projects/demo/',
        localPath: 'runbook.md',
        contentType: 'text/markdown',
      }, '# Runbook\n\nDelete me later.\n');

      await rm(path.join(workspace.cwd, 'runbook.md'));
      await workspace.commit();

      expect(textIndex.search({ query: 'delete me' })).toEqual([]);
    } finally {
      textIndex.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('keeps Turtle files in both the RDF index and the text chunk index', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'xpod-solidfs-rdf-text-sync-'));
    const source = path.join(root, 'workspace');
    await mkdir(source, { recursive: true });
    await writeFile(path.join(source, 'data.ttl'), '<#me> <https://schema.org/name> "before" .\n', 'utf8');

    const textIndex = new RdfTextIndex({ path: ':memory:' });
    textIndex.open();
    const rdfIndex = {
      syncLocalRdfDocument: vi.fn().mockResolvedValue(undefined),
      deleteLocalRdfIndex: vi.fn().mockResolvedValue(undefined),
    };

    try {
      const solidfs = new LocalSolidFS({
        syncer: new RdfIndexSolidFsSyncer({
          index: rdfIndex,
          textIndex,
        }),
      });
      const workspace = await solidfs.prepare({
        workspace: 'https://pod.example/alice/projects/demo/',
        sourcePath: source,
        projection: 'direct',
      });

      await writeFile(path.join(workspace.cwd, 'data.ttl'), '<#me> <https://schema.org/name> "after searchable" .\n', 'utf8');
      await workspace.commit();

      expect(rdfIndex.syncLocalRdfDocument).toHaveBeenCalledTimes(1);
      expect(textIndex.search({ query: 'after searchable' })).toMatchObject([
        {
          source: 'https://pod.example/alice/projects/demo/data.ttl',
          localPath: 'data.ttl',
          contentType: 'text/turtle',
        },
      ]);
    } finally {
      textIndex.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('keeps JSON-LD files searchable as standard RDF text', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'xpod-solidfs-jsonld-text-sync-'));
    const source = path.join(root, 'workspace');
    await mkdir(source, { recursive: true });
    await writeFile(path.join(source, 'data.jsonld'), '{ "@id": "#me", "http://schema.org/name": "before" }\n', 'utf8');

    const textIndex = new RdfTextIndex({ path: ':memory:' });
    textIndex.open();
    const rdfIndex = {
      syncLocalRdfDocument: vi.fn().mockResolvedValue(undefined),
      deleteLocalRdfIndex: vi.fn().mockResolvedValue(undefined),
    };

    try {
      const solidfs = new LocalSolidFS({
        syncer: new RdfIndexSolidFsSyncer({
          index: rdfIndex,
          textIndex,
        }),
      });
      const workspace = await solidfs.prepare({
        workspace: 'https://pod.example/alice/projects/demo/',
        sourcePath: source,
        projection: 'direct',
      });

      await writeFile(path.join(workspace.cwd, 'data.jsonld'), '{ "@id": "#me", "http://schema.org/name": "after searchable jsonld" }\n', 'utf8');
      await workspace.commit();

      expect(rdfIndex.syncLocalRdfDocument).toHaveBeenCalledTimes(1);
      expect(textIndex.search({ query: 'searchable jsonld' })).toMatchObject([
        {
          source: 'https://pod.example/alice/projects/demo/data.jsonld',
          localPath: 'data.jsonld',
          contentType: 'application/ld+json',
        },
      ]);
    } finally {
      textIndex.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('tracks standard RDF by-line formats through the structured index', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'xpod-solidfs-rdf-nquads-sync-'));
    const source = path.join(root, 'workspace');
    await mkdir(source, { recursive: true });
    await writeFile(path.join(source, 'graph.nq'), '<http://example.test/s> <http://example.test/p> "before" <http://example.test/g> .\n', 'utf8');

    const rdfIndex = {
      syncLocalRdfDocument: vi.fn().mockResolvedValue(undefined),
      deleteLocalRdfIndex: vi.fn().mockResolvedValue(undefined),
    };

    try {
      const solidfs = new LocalSolidFS({
        syncer: new RdfIndexSolidFsSyncer({ index: rdfIndex }),
      });
      const workspace = await solidfs.prepare({
        workspace: 'https://pod.example/alice/projects/demo/',
        sourcePath: source,
        projection: 'direct',
      });

      await writeFile(path.join(workspace.cwd, 'graph.nq'), '<http://example.test/s> <http://example.test/p> "after" <http://example.test/g> .\n', 'utf8');
      await workspace.commit();

      expect(rdfIndex.syncLocalRdfDocument).toHaveBeenCalledWith(
        { path: 'https://pod.example/alice/projects/demo/graph.nq' },
        expect.anything(),
        'application/n-quads',
        {
          source: 'https://pod.example/alice/projects/demo/graph.nq',
          workspace: 'https://pod.example/alice/projects/demo/',
          localPath: 'graph.nq',
          sourceVersion: undefined,
        },
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('refreshes the RDF index from RDF/XML without indexing it as by-line text', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'xpod-solidfs-rdfxml-sync-'));
    const source = path.join(root, 'workspace');
    const textIndex = new RdfTextIndex({ path: ':memory:' });
    textIndex.open();
    await mkdir(source, { recursive: true });
    await writeFile(path.join(source, 'ontology.owl'), `<?xml version="1.0"?>
<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"
         xmlns:ex="http://example.test/">
  <rdf:Description rdf:about="http://example.test/s">
    <ex:p>before</ex:p>
  </rdf:Description>
</rdf:RDF>
`, 'utf8');

    const rdfIndex = {
      syncLocalRdfDocument: vi.fn().mockResolvedValue(undefined),
      deleteLocalRdfIndex: vi.fn().mockResolvedValue(undefined),
    };

    try {
      const solidfs = new LocalSolidFS({
        syncer: new RdfIndexSolidFsSyncer({ index: rdfIndex, textIndex }),
      });
      const workspace = await solidfs.prepare({
        workspace: 'https://pod.example/alice/projects/demo/',
        sourcePath: source,
        projection: 'direct',
      });

      await writeFile(path.join(workspace.cwd, 'ontology.owl'), `<?xml version="1.0"?>
<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"
         xmlns:ex="http://example.test/">
  <rdf:Description rdf:about="http://example.test/s">
    <ex:p>after</ex:p>
  </rdf:Description>
</rdf:RDF>
`, 'utf8');
      await workspace.commit();

      expect(rdfIndex.syncLocalRdfDocument).toHaveBeenCalledWith(
        { path: 'https://pod.example/alice/projects/demo/ontology.owl' },
        expect.anything(),
        'application/rdf+xml',
        {
          source: 'https://pod.example/alice/projects/demo/ontology.owl',
          workspace: 'https://pod.example/alice/projects/demo/',
          localPath: 'ontology.owl',
          sourceVersion: undefined,
        },
      );
      expect(rdfIndex.deleteLocalRdfIndex).not.toHaveBeenCalled();
      expect(textIndex.search({ query: 'after' })).toEqual([]);
    } finally {
      textIndex.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('indexes file workspace Turtle text without treating it as a Pod RDF resource', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'xpod-solidfs-file-rdf-text-'));
    const source = path.join(root, 'workspace');
    await mkdir(source, { recursive: true });
    await writeFile(path.join(source, 'data.ttl'), '<#me> <https://schema.org/name> "before" .\n', 'utf8');

    const textIndex = new RdfTextIndex({ path: ':memory:' });
    textIndex.open();
    const rdfIndex = {
      syncLocalRdfDocument: vi.fn().mockResolvedValue(undefined),
      deleteLocalRdfIndex: vi.fn().mockResolvedValue(undefined),
    };

    try {
      const solidfs = new LocalSolidFS({
        syncer: new RdfIndexSolidFsSyncer({
          index: rdfIndex,
          textIndex,
        }),
      });
      const workspace = await solidfs.prepare({
        workspace: `file://${source}/`,
        projection: 'direct',
      });

      await writeFile(path.join(workspace.cwd, 'data.ttl'), '<#me> <https://schema.org/name> "local searchable" .\n', 'utf8');
      await workspace.commit();

      expect(rdfIndex.syncLocalRdfDocument).not.toHaveBeenCalled();
      expect(textIndex.search({ query: 'local searchable' })).toMatchObject([
        {
          source: `file://${source}/data.ttl`,
          localPath: 'data.ttl',
          contentType: 'text/turtle',
        },
      ]);
    } finally {
      textIndex.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('deletes the RDF index when a tracked RDF file is removed', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'xpod-solidfs-rdf-delete-'));
    const source = path.join(root, 'workspace');
    await mkdir(source, { recursive: true });
    await writeFile(path.join(source, 'data.ttl'), '<#me> <https://schema.org/name> "before" .\n', 'utf8');
    const index = {
      syncLocalRdfDocument: vi.fn().mockResolvedValue(undefined),
      deleteLocalRdfIndex: vi.fn().mockResolvedValue(undefined),
    };

    try {
      const solidfs = new LocalSolidFS({
        syncer: new RdfIndexSolidFsSyncer({ index }),
      });
      const workspace = await solidfs.prepare({
        workspace: 'https://pod.example/alice/projects/demo/',
        sourcePath: source,
        projection: 'direct',
      });

      await rm(path.join(workspace.cwd, 'data.ttl'));
      await workspace.commit();

      expect(index.deleteLocalRdfIndex).toHaveBeenCalledWith({
        path: 'https://pod.example/alice/projects/demo/data.ttl',
      });
      expect(index.syncLocalRdfDocument).not.toHaveBeenCalled();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('does not treat file IRIs as Pod resource identifiers without an explicit resolver', async () => {
    const index = {
      syncLocalRdfDocument: vi.fn().mockResolvedValue(undefined),
      deleteLocalRdfIndex: vi.fn().mockResolvedValue(undefined),
    };
    const syncer = new RdfIndexSolidFsSyncer({ index });
    const change: SolidFsChange = {
      path: 'data.ttl',
        resource: 'file:///tmp/workspace/data.ttl',
      source: 'filesystem',
      sourcePath: '/tmp/workspace/data.ttl',
      contentType: 'text/turtle',
      projection: 'direct',
      type: 'updated',
    };
    const manifest: SolidFsManifest = {
      workspace: 'file:///tmp/workspace/',
      cwd: '/tmp/workspace',
      projection: 'direct',
      entries: [],
    };

    await syncer.sync(change, manifest);

    expect(index.syncLocalRdfDocument).not.toHaveBeenCalled();
    expect(index.deleteLocalRdfIndex).not.toHaveBeenCalled();
  });
});
