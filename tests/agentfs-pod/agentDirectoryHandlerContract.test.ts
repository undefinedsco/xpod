import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startFixtureServer, type FixtureServer } from '../helpers/agent-directory/fixtureServer';
import { startRecordingProxy, type RecordingProxy } from './support/recordingProxy';

const TEST_DATA_ROOT = path.resolve('.test-data/agent-directory-workers/agentfs-test/handler-contract');

interface ListBody {
  entries: { path: string; type: string }[];
  complete: boolean;
  truncated: boolean;
  nextCursor?: string;
}

interface SearchBody {
  matches: { path: string; line: number }[];
  complete: boolean;
  nextCursor?: string;
}

describe('real AgentDirectoryHttpHandler contract (root/pathPrefix/pagination)', () => {
  let fixtureDir: string;
  let server: FixtureServer;
  let proxy: RecordingProxy;
  let root: string;

  beforeAll(async () => {
    await mkdir(TEST_DATA_ROOT, { recursive: true });
    fixtureDir = await mkdtemp(path.join(TEST_DATA_ROOT, 'fx-'));
    await mkdir(path.join(fixtureDir, 'sub'), { recursive: true });
    await writeFile(path.join(fixtureDir, 'a.txt'), 'alpha\n');
    await writeFile(path.join(fixtureDir, 'b.txt'), 'beta\n');
    await writeFile(path.join(fixtureDir, 'sub', 'c.txt'), 'gamma\n');
    await writeFile(path.join(fixtureDir, 'many.txt'), 'needle one\nneedle two\nneedle three\nneedle four\n');
    server = await startFixtureServer({ fixtureDir });
    proxy = await startRecordingProxy(server.origin);
    root = `${proxy.origin}/pod/`;
  });

  afterAll(async () => {
    await proxy.close();
    await server.close();
    await rm(fixtureDir, { recursive: true, force: true });
  });

  it('requires a canonical same-origin root parameter', async () => {
    const missing = await fetch(`${proxy.origin}/-/agent-directory/list`);
    expect([ 400, 403 ]).toContain(missing.status);

    const evil = await fetch(`${proxy.origin}/-/agent-directory/list?root=${encodeURIComponent('http://evil.example/pod/')}`);
    expect(evil.status).toBe(403);
  });

  it('accepts both trailing-slash and bare subdirectory pathPrefix, rejecting interior empty/..', async () => {
    const trailing = await fetch(`${proxy.origin}/-/agent-directory/list?root=${encodeURIComponent(root)}&pathPrefix=${encodeURIComponent('sub/')}`);
    expect(trailing.status).toBe(200);
    expect(((await trailing.json()) as ListBody).entries.map((entry) => entry.path)).toContain('sub/c.txt');

    const bare = await fetch(`${proxy.origin}/-/agent-directory/list?root=${encodeURIComponent(root)}&pathPrefix=${encodeURIComponent('sub')}`);
    expect(bare.status).toBe(200);
    expect(((await bare.json()) as ListBody).entries.map((entry) => entry.path)).toContain('sub/c.txt');

    const interior = await fetch(`${proxy.origin}/-/agent-directory/list?root=${encodeURIComponent(root)}&pathPrefix=${encodeURIComponent('sub//x')}`);
    expect(interior.status).toBe(400);

    const traversal = await fetch(`${proxy.origin}/-/agent-directory/list?root=${encodeURIComponent(root)}&pathPrefix=${encodeURIComponent('a/../b')}`);
    expect(traversal.status).toBe(400);
  });

  it('pages the listing without losing entries and finishes complete', async () => {
    const collected: string[] = [];
    let cursor: string | undefined;
    let complete = false;
    let firstTruncated: boolean | undefined;
    for (let page = 0; page < 20; page += 1) {
      const query = new URLSearchParams({ root, limit: '2' });
      if (cursor) {
        query.set('cursor', cursor);
      }
      const response = await fetch(`${proxy.origin}/-/agent-directory/list?${query.toString()}`);
      expect(response.status).toBe(200);
      const body = (await response.json()) as ListBody;
      if (page === 0) {
        firstTruncated = body.truncated;
      }
      collected.push(...body.entries.map((entry) => entry.path));
      cursor = body.nextCursor;
      complete = body.complete;
      if (!cursor) {
        break;
      }
    }
    expect(firstTruncated).toBe(true);
    expect(complete).toBe(true);
    expect([ ...collected ].sort()).toEqual([ 'a.txt', 'b.txt', 'many.txt', 'sub/', 'sub/c.txt' ]);
    expect(new Set(collected).size).toBe(collected.length);
  });

  it('resumes in-file search pagination without dropping later matches', async () => {
    const collected: { path: string; line: number }[] = [];
    let cursor: string | undefined;
    let complete = false;
    for (let page = 0; page < 20; page += 1) {
      const query = new URLSearchParams({ root, q: 'needle', mode: 'literal', limit: '1' });
      if (cursor) {
        query.set('cursor', cursor);
      }
      const response = await fetch(`${proxy.origin}/-/agent-directory/search?${query.toString()}`);
      expect(response.status).toBe(200);
      const body = (await response.json()) as SearchBody;
      collected.push(...body.matches.map((match) => ({ path: match.path, line: match.line })));
      cursor = body.nextCursor;
      complete = body.complete;
      if (!cursor) {
        break;
      }
    }
    expect(complete).toBe(true);
    expect(collected.filter((match) => match.path === 'many.txt').map((match) => match.line)).toEqual([ 1, 2, 3, 4 ]);
  });
});
