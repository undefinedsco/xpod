import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startFixtureServer, type FixtureServer } from '../helpers/agent-directory/fixtureServer';

const TEST_DATA_ROOT = path.resolve('.test-data/agent-directory-workers');

interface ListResponse {
  entries: { path: string; type: string }[];
  complete: boolean;
  scanned: number;
  skippedUnauthorized?: number;
}

interface SearchResponse {
  matches: { path: string; line: number; column: number; text: string }[];
  complete: boolean;
  hasUnscannedScope: boolean;
  skippedUnsupported: number;
  nextCursor?: string;
}

describe('AgentDirectoryHttpHandler', () => {
  let fixtureDir: string;
  let server: FixtureServer;

  beforeAll(async () => {
    await mkdir(TEST_DATA_ROOT, { recursive: true });
    fixtureDir = await mkdtemp(path.join(TEST_DATA_ROOT, 'handler-'));
    await mkdir(path.join(fixtureDir, 'sub'), { recursive: true });
    await writeFile(path.join(fixtureDir, 'a.txt'), 'alpha beta\nGAMMA\nbeta beta\n');
    await writeFile(path.join(fixtureDir, 'sub', 'b.txt'), 'nothing here\n');
    await writeFile(path.join(fixtureDir, 'noise.txt'), `${'n'.repeat(200)}\nbeta-noise\n`);
    await writeFile(path.join(fixtureDir, 'secret.txt'), 'betasecret\n');
    server = await startFixtureServer({ fixtureDir, deniedPaths: [ 'secret.txt' ] });
  });

  afterAll(async () => {
    await server.close();
    await rm(fixtureDir, { recursive: true, force: true });
  });

  async function getJson<T>(route: string): Promise<{ status: number; body: T }> {
    const response = await fetch(new URL(route, server.origin));
    return { status: response.status, body: (await response.json()) as T };
  }

  it('lists only authorized children and reports skipped unauthorized resources', async () => {
    const { status, body } = await getJson<ListResponse>(`/-/agent-directory/list?root=${encodeURIComponent(server.podRoot)}`);
    expect(status).toBe(200);
    const paths = body.entries.map((entry) => entry.path).sort();
    expect(paths).toEqual([ 'a.txt', 'noise.txt', 'sub/', 'sub/b.txt' ]);
    expect(paths).not.toContain('secret.txt');
    // Denied resources are excluded and their count is never leaked.
    expect(body.skippedUnauthorized).toBeUndefined();
    expect(Object.prototype.hasOwnProperty.call(body, 'skippedUnauthorized')).toBe(false);
    // `scanned` counts only authorized, visible entries.
    expect(body.scanned).toBe(paths.length);
    expect(body.complete).toBe(true);
  });

  it('returns only matching text and never the full directory body', async () => {
    const { status, body } = await getJson<SearchResponse>(
      `/-/agent-directory/search?root=${encodeURIComponent(server.podRoot)}&q=beta&mode=literal`,
    );
    expect(status).toBe(200);
    expect(body.matches.every((match) => match.path !== 'secret.txt')).toBe(true);
    expect(body.matches.some((match) => match.path === 'a.txt' && match.line === 1 && match.column === 7)).toBe(true);
    expect(body.matches.some((match) => match.text.includes('beta-noise'))).toBe(true);
    expect(body.complete).toBe(true);
    expect(body.hasUnscannedScope).toBe(false);
    // The unique non-matching content must never be transferred.
    expect(JSON.stringify(body)).not.toContain('nothing here');
    expect(JSON.stringify(body)).not.toContain('n'.repeat(200));
  });

  it('does not report an incomplete scan as a full zero-hit result', async () => {
    const response = await fetch(
      new URL(
        `/-/agent-directory/search?root=${encodeURIComponent(server.podRoot)}&q=nope&mode=literal&maxFileBytes=4`,
        server.origin,
      ),
    );
    const body = (await response.json()) as SearchResponse;
    expect(body.matches).toEqual([]);
    expect(body.skippedUnsupported).toBeGreaterThan(0);
    expect(body.complete).toBe(false);
    expect(body.hasUnscannedScope).toBe(true);
  });

  it('reports pagination instead of silently truncating the listing', async () => {
    const response = await fetch(
      new URL(`/-/agent-directory/list?root=${encodeURIComponent(server.podRoot)}&limit=1`, server.origin),
    );
    const body = (await response.json()) as { truncated: boolean; complete: boolean; nextCursor?: string; entries: unknown[] };
    expect(body.entries).toHaveLength(1);
    expect(body.truncated).toBe(true);
    // Normal pagination is not a coverage omission.
    expect(body.complete).toBe(true);
    expect(body.nextCursor).toBeTruthy();

    // Following every page reaches coverage-complete without ever being marked
    // permanently incomplete.
    let cursor = body.nextCursor;
    let pages = 1;
    let complete = body.complete;
    while (cursor && pages < 10) {
      const pageResponse = await fetch(
        new URL(`/-/agent-directory/list?root=${encodeURIComponent(server.podRoot)}&limit=1&cursor=${encodeURIComponent(cursor)}`, server.origin),
      );
      const page = (await pageResponse.json()) as { truncated: boolean; complete: boolean; nextCursor?: string };
      complete = complete && page.complete;
      cursor = page.nextCursor;
      pages += 1;
    }
    expect(complete).toBe(true);
  });

  it('rejects search modes it cannot reproduce exactly', async () => {
    const response = await fetch(
      new URL(`/-/agent-directory/search?root=${encodeURIComponent(server.podRoot)}&q=beta&mode=regex`, server.origin),
    );
    expect(response.status).toBe(501);
  });

  it('rejects a root outside the request origin', async () => {
    const response = await fetch(
      new URL(`/-/agent-directory/list?root=${encodeURIComponent('http://evil.example/pod/')}`, server.origin),
    );
    expect(response.status).toBe(403);
  });

  it('refuses to read denied resources even when the URL is known', async () => {
    const response = await fetch(
      new URL(`/-/agent-directory/read?url=${encodeURIComponent(`${server.podRoot}secret.txt`)}`, server.origin),
    );
    expect(response.status).toBe(403);
  });

  it('rejects child URIs that leave the canonical root scope', async () => {
    const scoped = await startFixtureServer({
      fixtureDir,
      injectChildren: (container) => [
        'http://evil.example/pod/evil.txt',
        `${container}query.txt?token=1`,
        `${container}hash.txt#frag`,
        `${container}nested/deep.txt`,
      ],
    });
    try {
      const response = await fetch(
        new URL(`/-/agent-directory/list?root=${encodeURIComponent(scoped.podRoot)}`, scoped.origin),
      );
      const body = (await response.json()) as ListResponse;
      const paths = body.entries.map((entry) => entry.path);
      expect(paths).not.toContain('evil.txt');
      expect(paths).not.toContain('query.txt');
      expect(paths).not.toContain('hash.txt');
      expect(paths).not.toContain('nested/deep.txt');
      // Rejected children make the result explicitly incomplete.
      expect(body.complete).toBe(false);
    } finally {
      await scoped.close();
    }
  });

  it('marks enumeration incomplete instead of silently swallowing read failures', async () => {
    const failing = await startFixtureServer({ fixtureDir, failChildrenFor: '/sub/' });
    try {
      const response = await fetch(
        new URL(`/-/agent-directory/list?root=${encodeURIComponent(failing.podRoot)}`, failing.origin),
      );
      const body = (await response.json()) as ListResponse;
      expect(body.entries.some((entry) => entry.path === 'a.txt')).toBe(true);
      expect(body.complete).toBe(false);
    } finally {
      await failing.close();
    }
  });

  it('resumes in-file pagination without dropping later matches', async () => {
    await writeFile(path.join(fixtureDir, 'many.txt'), 'needle one\nneedle two\nneedle three\nneedle four\n');
    const collected: number[] = [];
    let cursor: string | undefined;
    let complete = true;
    let pages = 0;
    do {
      const query = new URLSearchParams({ root: server.podRoot, q: 'needle', mode: 'literal', limit: '1' });
      if (cursor) {
        query.set('cursor', cursor);
      }
      const response = await fetch(new URL(`/-/agent-directory/search?${query.toString()}`, server.origin));
      const body = (await response.json()) as SearchResponse & { matches: { path: string; line: number }[]; nextCursor?: string };
      for (const match of body.matches) {
        if (match.path === 'many.txt') {
          collected.push(match.line);
        }
      }
      cursor = body.nextCursor;
      complete = complete && body.complete;
      pages += 1;
    } while (cursor && pages < 10);
    expect(collected).toEqual([ 1, 2, 3, 4 ]);
    expect(complete).toBe(true);
  });
});
