import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import {
  LocalSolidFS,
  SolidFsConflictError,
  type SolidFsChange,
  type SolidFsCommitHydratedInput,
  type SolidFsHydrateInput,
  type SolidFsManifest,
} from '../../src/solidfs';

const execFileAsync = promisify(execFile);

describe('LocalSolidFS', () => {
  let testRoot: string;
  let workspaceRoot: string;
  let workRoot: string;
  let solidfs: LocalSolidFS;

  beforeEach(async () => {
    testRoot = await mkdtemp(path.join(os.tmpdir(), 'xpod-solidfs-test-'));
    workspaceRoot = path.join(testRoot, 'workspace');
    workRoot = path.join(testRoot, 'work');
    await mkdir(path.join(workspaceRoot, 'notes'), { recursive: true });
    await writeFile(path.join(workspaceRoot, 'notes', 'hello.txt'), 'hello solidfs\n', 'utf8');
    await writeFile(path.join(workspaceRoot, 'data.ttl'), '<#me> <http://schema.org/name> "Alice" .\n', 'utf8');
    solidfs = new LocalSolidFS({ workRoot });
  });

  afterEach(async () => {
    await rm(testRoot, { recursive: true, force: true });
  });

  it('uses the real local workspace for direct projection', async () => {
    const workspace = await solidfs.prepare({
      workspace: pathToFileUrl(workspaceRoot),
      projection: 'direct',
      run: { id: 'run_direct' },
    });

    expect(workspace.cwd).toBe(workspaceRoot);
    expect(workspace.manifest.entries).toEqual([]);

    const grep = await execFileAsync('grep', [ '-R', 'solidfs', '.' ], { cwd: workspace.cwd });
    expect(grep.stdout).toContain('hello solidfs');

    await writeFile(path.join(workspace.cwd, 'notes', 'created.txt'), 'created by agent\n', 'utf8');
    await workspace.commit();

    await expect(readFile(path.join(workspaceRoot, 'notes', 'created.txt'), 'utf8'))
      .resolves.toBe('created by agent\n');
  });

  it('reports direct projection file changes for index synchronization', async () => {
    const synced: SolidFsChange[] = [];
    solidfs = new LocalSolidFS({
      workRoot,
      syncer: {
        async sync(change): Promise<void> {
          synced.push(change);
        },
      },
    });
    const workspace = await solidfs.prepare({
      workspace: pathToFileUrl(workspaceRoot),
      projection: 'direct',
      run: { id: 'run_direct_sync' },
    });

    await writeFile(path.join(workspace.cwd, 'data.ttl'), '<#me> <http://schema.org/name> "Updated" .\n', 'utf8');
    await writeFile(path.join(workspace.cwd, 'notes', 'created.ttl'), '<#new> <http://schema.org/name> "New" .\n', 'utf8');
    const manifest = await workspace.commit();

    expect(manifest.changes).toEqual([
      {
        path: 'data.ttl',
        resource: pathToFileUrl(path.join(workspaceRoot, 'data.ttl')),
        source: 'filesystem',
        sourcePath: path.join(workspaceRoot, 'data.ttl'),
        contentType: 'text/turtle',
        projection: 'direct',
        type: 'updated',
      },
      {
        path: path.join('notes', 'created.ttl'),
        resource: pathToFileUrl(path.join(workspaceRoot, 'notes', 'created.ttl')),
        source: 'filesystem',
        sourcePath: path.join(workspaceRoot, 'notes', 'created.ttl'),
        contentType: 'text/turtle',
        projection: 'direct',
        type: 'created',
      },
    ]);
    expect(synced).toEqual(manifest.changes);
  });

  it('lets syncers opt into text paths for direct projection tracking', async () => {
    const synced: SolidFsChange[] = [];
    solidfs = new LocalSolidFS({
      workRoot,
      syncer: {
        shouldTrackPath(relativePath): boolean {
          return relativePath.endsWith('.txt');
        },
        async sync(change): Promise<void> {
          synced.push(change);
        },
      },
    });
    const workspace = await solidfs.prepare({
      workspace: pathToFileUrl(workspaceRoot),
      projection: 'direct',
      run: { id: 'run_direct_text_sync' },
    });

    await writeFile(path.join(workspace.cwd, 'notes', 'hello.txt'), 'updated text\n', 'utf8');
    await writeFile(path.join(workspace.cwd, 'data.ttl'), '<#me> <http://schema.org/name> "Ignored" .\n', 'utf8');
    const manifest = await workspace.commit();

    expect(manifest.changes).toEqual([
      {
        path: path.join('notes', 'hello.txt'),
        resource: pathToFileUrl(path.join(workspaceRoot, 'notes', 'hello.txt')),
        source: 'filesystem',
        sourcePath: path.join(workspaceRoot, 'notes', 'hello.txt'),
        contentType: 'text/plain',
        projection: 'direct',
        type: 'updated',
      },
    ]);
    expect(synced).toEqual(manifest.changes);
  });

  it('rejects missing workspaces before returning a cwd', async () => {
    await expect(solidfs.prepare({
      workspace: pathToFileUrl(path.join(testRoot, 'missing')),
      projection: 'direct',
      run: { id: 'run_missing' },
    })).rejects.toThrow('SolidFS workspace does not exist');
  });

  it('rejects file paths as workspaces', async () => {
    await expect(solidfs.prepare({
      workspace: pathToFileUrl(path.join(workspaceRoot, 'data.ttl')),
      projection: 'direct',
      run: { id: 'run_file' },
    })).rejects.toThrow('SolidFS workspace is not a directory');
  });

  it('commits copy projection changes back to the source workspace', async () => {
    const workspace = await solidfs.prepare({
      workspace: pathToFileUrl(workspaceRoot),
      projection: 'copy',
      run: { id: 'run_copy' },
    });

    expect(workspace.cwd).not.toBe(workspaceRoot);
    await writeFile(path.join(workspace.cwd, 'notes', 'hello.txt'), 'updated in copy\n', 'utf8');
    await writeFile(path.join(workspace.cwd, 'notes', 'new.txt'), 'new file\n', 'utf8');
    await rm(path.join(workspace.cwd, 'data.ttl'));

    await workspace.commit();

    await expect(readFile(path.join(workspaceRoot, 'notes', 'hello.txt'), 'utf8'))
      .resolves.toBe('updated in copy\n');
    await expect(readFile(path.join(workspaceRoot, 'notes', 'new.txt'), 'utf8'))
      .resolves.toBe('new file\n');
    await expect(stat(path.join(workspaceRoot, 'data.ttl'))).rejects.toThrow();
  });

  it('reports copy projection changes before syncing back to source', async () => {
    const synced: Array<{ change: SolidFsChange; manifest: SolidFsManifest }> = [];
    solidfs = new LocalSolidFS({
      workRoot,
      syncer: {
        async sync(change, manifest): Promise<void> {
          synced.push({ change, manifest });
        },
      },
    });
    const workspace = await solidfs.prepare({
      workspace: pathToFileUrl(workspaceRoot),
      projection: 'copy',
      run: { id: 'run_copy_sync' },
    });

    await writeFile(path.join(workspace.cwd, 'data.ttl'), '<#me> <http://schema.org/name> "Copied" .\n', 'utf8');
    await writeFile(path.join(workspace.cwd, 'notes', 'new.jsonld'), '{ "@id": "#new" }\n', 'utf8');
    await rm(path.join(workspace.cwd, 'notes', 'hello.txt'));

    const manifest = await workspace.commit();

    expect(manifest.changes).toEqual([
      {
        path: 'data.ttl',
        resource: pathToFileUrl(path.join(workspaceRoot, 'data.ttl')),
        source: 'filesystem',
        sourcePath: path.join(workspace.cwd, 'data.ttl'),
        contentType: 'text/turtle',
        projection: 'copy',
        type: 'updated',
      },
      {
        path: path.join('notes', 'hello.txt'),
        resource: pathToFileUrl(path.join(workspaceRoot, 'notes', 'hello.txt')),
        source: 'filesystem',
        sourcePath: path.join(workspaceRoot, 'notes', 'hello.txt'),
        contentType: 'text/plain',
        projection: 'copy',
        type: 'deleted',
      },
      {
        path: path.join('notes', 'new.jsonld'),
        resource: pathToFileUrl(path.join(workspaceRoot, 'notes', 'new.jsonld')),
        source: 'filesystem',
        sourcePath: path.join(workspace.cwd, 'notes', 'new.jsonld'),
        contentType: 'application/ld+json',
        projection: 'copy',
        type: 'created',
      },
    ]);
    expect(synced.map(({ change }) => change)).toEqual(manifest.changes);
    expect(synced.every(({ manifest: passedManifest }) => passedManifest === manifest)).toBe(true);
  });

  it('detects standard RDF by-line formats by extension', async () => {
    const synced: SolidFsChange[] = [];
    solidfs = new LocalSolidFS({
      workRoot,
      syncer: {
        async sync(change): Promise<void> {
          synced.push(change);
        },
      },
    });
    await writeFile(path.join(workspaceRoot, 'graph.nq'), '<http://example.test/s> <http://example.test/p> "before" <http://example.test/g> .\n', 'utf8');
    const workspace = await solidfs.prepare({
      workspace: pathToFileUrl(workspaceRoot),
      projection: 'direct',
    });

    await writeFile(path.join(workspace.cwd, 'graph.nq'), '<http://example.test/s> <http://example.test/p> "after" <http://example.test/g> .\n', 'utf8');
    const manifest = await workspace.commit();

    expect(manifest.changes).toEqual([
      {
        path: 'graph.nq',
        resource: pathToFileUrl(path.join(workspaceRoot, 'graph.nq')),
        source: 'filesystem',
        sourcePath: path.join(workspaceRoot, 'graph.nq'),
        contentType: 'application/n-quads',
        projection: 'direct',
        type: 'updated',
      },
    ]);
    expect(synced).toEqual(manifest.changes);
  });

  it('rolls back copy projection without touching the source workspace', async () => {
    const workspace = await solidfs.prepare({
      workspace: workspaceRoot,
      projection: 'copy',
      run: { id: 'run_rollback' },
    });

    await writeFile(path.join(workspace.cwd, 'notes', 'hello.txt'), 'discarded\n', 'utf8');
    await workspace.rollback();

    await expect(readFile(path.join(workspaceRoot, 'notes', 'hello.txt'), 'utf8'))
      .resolves.toBe('hello solidfs\n');
    await expect(stat(workspace.cwd)).rejects.toThrow();
  });

  it('reports conflicts when the source changes after prepare', async () => {
    const workspace = await solidfs.prepare({
      workspace: workspaceRoot,
      projection: 'copy',
      run: { id: 'run_conflict' },
    });

    await writeFile(path.join(workspaceRoot, 'notes', 'hello.txt'), 'external change\n', 'utf8');
    await writeFile(path.join(workspace.cwd, 'notes', 'hello.txt'), 'agent change\n', 'utf8');

    await expect(workspace.commit()).rejects.toBeInstanceOf(SolidFsConflictError);
    await expect(readFile(path.join(workspaceRoot, 'notes', 'hello.txt'), 'utf8'))
      .resolves.toBe('external change\n');
  });

  it('hydrates object-backed files on demand and commits dirty hydrated copies', async () => {
    const hydrated: SolidFsHydrateInput[] = [];
    const committed: SolidFsCommitHydratedInput[] = [];
    solidfs = new LocalSolidFS({
      workRoot,
      hydrator: {
        async hydrate(input): Promise<{ contentType: string; sourceVersion: string }> {
          hydrated.push(input);
          await writeFile(input.targetPath, 'remote object before\n', 'utf8');
          return {
            contentType: 'application/octet-stream',
            sourceVersion: 'etag-before',
          };
        },
        async commit(input): Promise<{ sourceVersion: string }> {
          committed.push(input);
          return { sourceVersion: 'etag-after' };
        },
      },
    });

    const workspace = await solidfs.prepare({
      workspace: 'https://pod.example/alice/projects/demo/',
      sourcePath: workspaceRoot,
      projection: 'hydrated-object',
      run: { id: 'run_hydrate' },
    });

    expect(workspace.cwd).not.toBe(workspaceRoot);
    await expect(stat(workspace.cwd)).resolves.toBeDefined();
    await expect(stat(path.join(workspace.cwd, 'assets', 'image.bin'))).rejects.toThrow();

    const entry = await workspace.hydrate!('assets/image.bin');
    expect(entry).toMatchObject({
      path: path.join('assets', 'image.bin'),
        resource: 'https://pod.example/alice/projects/demo/assets/image.bin',
      source: 'object',
      contentType: 'application/octet-stream',
      projection: 'hydrated-object',
      sourceVersion: 'etag-before',
      state: 'clean',
    });
    expect(hydrated[0]).toMatchObject({
      path: path.join('assets', 'image.bin'),
      workspace: workspace.manifest,
    });
    await expect(readFile(path.join(workspace.cwd, 'assets', 'image.bin'), 'utf8'))
      .resolves.toBe('remote object before\n');

    await writeFile(path.join(workspace.cwd, 'assets', 'image.bin'), 'remote object after\n', 'utf8');
    const manifest = await workspace.commit();

    expect(manifest.changes).toEqual([
      {
        path: path.join('assets', 'image.bin'),
        resource: 'https://pod.example/alice/projects/demo/assets/image.bin',
        source: 'object',
        sourcePath: path.join(workspace.cwd, 'assets', 'image.bin'),
        contentType: 'application/octet-stream',
        projection: 'hydrated-object',
        type: 'updated',
        sourceVersion: 'etag-before',
      },
    ]);
    expect(committed).toHaveLength(1);
    expect(committed[0].change).toEqual(manifest.changes![0]);
    expect(manifest.entries[0].sourceVersion).toBe('etag-after');
    expect(manifest.entries[0].state).toBe('committed');
  });

  it('commits newly created files in hydrated-object workspaces', async () => {
    const committed: SolidFsCommitHydratedInput[] = [];
    solidfs = new LocalSolidFS({
      workRoot,
      hydrator: {
        async hydrate(input): Promise<void> {
          await writeFile(input.targetPath, `existing ${input.path}\n`, 'utf8');
        },
        async commit(input): Promise<{ sourceVersion: string }> {
          committed.push(input);
          return { sourceVersion: `etag-after:${input.change.path}` };
        },
      },
    });
    const workspace = await solidfs.prepare({
      workspace: 'https://pod.example/alice/projects/demo/',
      sourcePath: workspaceRoot,
      projection: 'hydrated-object',
      run: { id: 'run_hydrate_created' },
    });

    await mkdir(path.join(workspace.cwd, 'notes'), { recursive: true });
    await writeFile(path.join(workspace.cwd, 'notes', 'new.txt'), 'created object\n', 'utf8');
    const manifest = await workspace.commit();

    expect(manifest.changes).toEqual([
      {
        path: path.join('notes', 'new.txt'),
        resource: 'https://pod.example/alice/projects/demo/notes/new.txt',
        source: 'object',
        sourcePath: path.join(workspace.cwd, 'notes', 'new.txt'),
        contentType: 'text/plain',
        projection: 'hydrated-object',
        type: 'created',
      },
    ]);
    expect(committed).toHaveLength(1);
    expect(committed[0].change).toEqual(manifest.changes![0]);
    expect(manifest.entries[0]).toMatchObject({
      path: path.join('notes', 'new.txt'),
        resource: 'https://pod.example/alice/projects/demo/notes/new.txt',
      source: 'object',
      sourceVersion: `etag-after:${path.join('notes', 'new.txt')}`,
      state: 'committed',
    });
  });

  it('commits hydrated deletions once and stops tracking removed files', async () => {
    const deleted: SolidFsCommitHydratedInput[] = [];
    solidfs = new LocalSolidFS({
      workRoot,
      hydrator: {
        async hydrate(input): Promise<{ sourceVersion: string }> {
          await writeFile(input.targetPath, `remote ${input.path}\n`, 'utf8');
          return { sourceVersion: `etag:${input.path}` };
        },
        async commit(): Promise<void> {
          throw new Error('not expected');
        },
        async delete(input): Promise<void> {
          deleted.push(input);
        },
      },
    });
    const workspace = await solidfs.prepare({
      workspace: 'https://pod.example/alice/projects/demo/',
      sourcePath: workspaceRoot,
      projection: 'hydrated-object',
      run: { id: 'run_hydrate_delete' },
    });

    await workspace.hydrate!('notes/old.txt');
    await rm(path.join(workspace.cwd, 'notes', 'old.txt'));

    const firstManifest = await workspace.commit();
    expect(firstManifest.changes).toEqual([
      {
        path: path.join('notes', 'old.txt'),
        resource: 'https://pod.example/alice/projects/demo/notes/old.txt',
        source: 'object',
        sourcePath: path.join(workspace.cwd, 'notes', 'old.txt'),
        contentType: 'text/plain',
        projection: 'hydrated-object',
        type: 'deleted',
        sourceVersion: `etag:${path.join('notes', 'old.txt')}`,
      },
    ]);
    expect(deleted).toHaveLength(1);
    expect(firstManifest.entries).toEqual([]);

    const secondManifest = await workspace.commit();
    expect(secondManifest.changes).toEqual([]);
    expect(deleted).toHaveLength(1);
  });

  it('prunes only clean hydrated files and keeps dirty working copies', async () => {
    solidfs = new LocalSolidFS({
      workRoot,
      hydrator: {
        async hydrate(input): Promise<{ sourceVersion: string }> {
          await writeFile(input.targetPath, `content for ${input.path}\n`, 'utf8');
          return { sourceVersion: `etag:${input.path}` };
        },
        async commit(): Promise<void> {
          throw new Error('not expected');
        },
      },
    });
    const workspace = await solidfs.prepare({
      workspace: 'https://pod.example/alice/projects/demo/',
      sourcePath: workspaceRoot,
      projection: 'hydrated-object',
      run: { id: 'run_prune' },
    });

    await workspace.hydrate!('clean.bin');
    await workspace.hydrate!('dirty.bin');
    await writeFile(path.join(workspace.cwd, 'dirty.bin'), 'modified\n', 'utf8');

    const manifest = await workspace.prune!({ olderThanMs: 1, now: Date.now() + 10_000 });

    expect(manifest.entries.map((entry) => entry.path)).toEqual(['dirty.bin']);
    expect(manifest.entries[0].state).toBe('dirty');
    await expect(stat(path.join(workspace.cwd, 'clean.bin'))).rejects.toThrow();
    await expect(readFile(path.join(workspace.cwd, 'dirty.bin'), 'utf8')).resolves.toBe('modified\n');
  });

  it('rejects hydrated-object path traversal', async () => {
    solidfs = new LocalSolidFS({
      workRoot,
      hydrator: {
        async hydrate(input): Promise<void> {
          await writeFile(input.targetPath, 'unexpected\n', 'utf8');
        },
        async commit(): Promise<void> {},
      },
    });
    const workspace = await solidfs.prepare({
      workspace: 'https://pod.example/alice/projects/demo/',
      sourcePath: workspaceRoot,
      projection: 'hydrated-object',
      run: { id: 'run_traversal' },
    });

    await expect(workspace.hydrate!('../escape.txt')).rejects.toThrow('Invalid SolidFS relative path');
    await expect(workspace.hydrate!('/absolute.txt')).rejects.toThrow('Invalid SolidFS relative path');
  });
});

function pathToFileUrl(filePath: string): string {
  const resolved = path.resolve(filePath);
  const pathname = resolved.split(path.sep).map(encodeURIComponent).join('/');
  return `file://${pathname.startsWith('/') ? '' : '/'}${pathname}`;
}
