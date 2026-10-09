import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startFixtureServer, type FixtureServer } from '../helpers/agent-directory/fixtureServer';
import { startRecordingProxy, type RecordingProxy } from './support/recordingProxy';

const TEST_DATA_ROOT = path.resolve('.test-data/agent-directory-workers/agentfs-test');

const BIG = 120_000;
const ALPHA_BODY = `${'A'.repeat(BIG)}\nALPHA_END_MARKER\n`;
const BRAVO_BODY = `${'B'.repeat(BIG)}\nBRAVO_END_MARKER\n`;
const SMALL_BODY = 'SMALL_ONLY_MARKER short line\n';
const NESTED_BODY = 'NESTED_ONLY_MARKER\n';
const SECRET_BODY = 'SECRET_BODY_MARKER TOP_SECRET_PAYLOAD\n';

const TOTAL_BODY_BYTES =
  Buffer.byteLength(ALPHA_BODY) + Buffer.byteLength(BRAVO_BODY) + Buffer.byteLength(SMALL_BODY) + Buffer.byteLength(NESTED_BODY);

interface ListBody {
  entries: { path: string; type: string; size?: number }[];
  complete: boolean;
  scanned: number;
}

interface ReadBody {
  url: string;
  size: number;
  bodyBase64: string;
}

interface SearchBody {
  matches: { path: string; line: number; text: string }[];
  complete: boolean;
}

describe('AgentDirectory HTTP acceptance with request/byte accounting', () => {
  let fixtureDir: string;
  let server: FixtureServer;
  let proxy: RecordingProxy;
  let proxyRoot: string;

  beforeAll(async () => {
    await mkdir(TEST_DATA_ROOT, { recursive: true });
    fixtureDir = await mkdtemp(path.join(TEST_DATA_ROOT, 'http-'));
    await mkdir(path.join(fixtureDir, 'sub'), { recursive: true });
    await writeFile(path.join(fixtureDir, 'alpha.txt'), ALPHA_BODY);
    await writeFile(path.join(fixtureDir, 'bravo.txt'), BRAVO_BODY);
    await writeFile(path.join(fixtureDir, 'small.txt'), SMALL_BODY);
    await writeFile(path.join(fixtureDir, 'sub', 'nested.txt'), NESTED_BODY);
    await writeFile(path.join(fixtureDir, 'secret.txt'), SECRET_BODY);
    server = await startFixtureServer({ fixtureDir, deniedPaths: [ 'secret.txt' ] });
    proxy = await startRecordingProxy(server.origin);
    proxyRoot = `${proxy.origin}/pod/`;
  });

  afterAll(async () => {
    await proxy.close();
    await server.close();
    await rm(fixtureDir, { recursive: true, force: true });
  });

  async function getJson<T>(route: string, origin = proxy.origin): Promise<{ status: number; body: T; raw: string }> {
    const response = await fetch(new URL(route, origin));
    const raw = await response.text();
    return { status: response.status, body: raw ? (JSON.parse(raw) as T) : (undefined as T), raw };
  }

  it('readdir transfers only metadata, never file bodies', async () => {
    proxy.reset();
    const { status, body, raw } = await getJson<ListBody>(
      `/-/agent-directory/list?root=${encodeURIComponent(proxyRoot)}`,
    );

    expect(status).toBe(200);
    const paths = body.entries.map((entry) => entry.path).sort();
    expect(paths).toEqual([ 'alpha.txt', 'bravo.txt', 'small.txt', 'sub/', 'sub/nested.txt' ]);
    expect(JSON.stringify(body)).not.toContain('SMALL_ONLY_MARKER');

    const reads = proxy.log.filter((entry) => entry.path.includes('/read') || entry.path.includes('/search'));
    expect(reads).toEqual([]);
    const listEntries = proxy.log.filter((entry) => entry.path.includes('/-/agent-directory/list'));
    expect(listEntries).toHaveLength(1);
    const transferred = listEntries[0].responseBytes;
    expect(transferred).toBeLessThan(8_192);
    expect(transferred).toBeLessThan(TOTAL_BODY_BYTES / 10);
  });

  it('a single-file read transfers that file only, not its neighbours', async () => {
    proxy.reset();
    const url = `${proxyRoot}alpha.txt`;
    const { status, body } = await getJson<ReadBody>(`/-/agent-directory/read?url=${encodeURIComponent(url)}`);

    expect(status).toBe(200);
    expect(body.size).toBe(Buffer.byteLength(ALPHA_BODY));
    const decoded = Buffer.from(body.bodyBase64, 'base64').toString('utf8');
    expect(decoded).toBe(ALPHA_BODY);
    expect(decoded).not.toContain('BRAVO_END_MARKER');

    const readEntries = proxy.log.filter((entry) => entry.path.includes('/-/agent-directory/read'));
    expect(readEntries).toHaveLength(1);
    expect(readEntries[0].path).toContain(encodeURIComponent(url));
    const bravoRequests = proxy.log.filter((entry) => entry.path.includes('bravo.txt'));
    expect(bravoRequests).toEqual([]);
    expect(readEntries[0].responseBytes).toBeLessThan(Buffer.byteLength(ALPHA_BODY) * 2);
  });

  it('search returns matching lines without transferring the directory body', async () => {
    proxy.reset();
    const { status, body, raw } = await getJson<SearchBody>(
      `/-/agent-directory/search?root=${encodeURIComponent(proxyRoot)}&q=BRAVO_END_MARKER&mode=literal`,
    );

    expect(status).toBe(200);
    expect(body.matches).toEqual([
      expect.objectContaining({ path: 'bravo.txt', line: 2, text: 'BRAVO_END_MARKER' }),
    ]);
    expect(raw).not.toContain(`B${'B'.repeat(200)}`);
    expect(raw).not.toContain(`A${'A'.repeat(200)}`);

    const searchEntries = proxy.log.filter((entry) => entry.path.includes('/-/agent-directory/search'));
    expect(searchEntries).toHaveLength(1);
    expect(searchEntries[0].responseBytes).toBeLessThan(4_096);
    expect(searchEntries[0].responseBytes).toBeLessThan(TOTAL_BODY_BYTES / 20);
  });

  it('keeps transplanted content out of denied resources', async () => {
    proxy.reset();
    const list = await getJson<ListBody>(`/-/agent-directory/list?root=${encodeURIComponent(proxyRoot)}`);
    expect(list.body.entries.map((entry) => entry.path)).not.toContain('secret.txt');

    const deniedRead = await fetch(
      new URL(`/-/agent-directory/read?url=${encodeURIComponent(`${proxyRoot}secret.txt`)}`, proxy.origin),
    );
    expect(deniedRead.status).toBe(403);

    const deniedSearch = await getJson<SearchBody>(
      `/-/agent-directory/search?root=${encodeURIComponent(proxyRoot)}&q=SECRET_BODY_MARKER&mode=literal`,
    );
    expect(deniedSearch.body.matches).toEqual([]);
    expect(deniedSearch.raw).not.toContain('TOP_SECRET_PAYLOAD');
  });

  it('rejects a root outside the request origin', async () => {
    const response = await fetch(
      new URL(`/-/agent-directory/list?root=${encodeURIComponent('http://evil.example/pod/')}`, proxy.origin),
    );
    expect(response.status).toBe(403);
  });

  it('reads a nested file without enumerating or transferring its siblings', async () => {
    proxy.reset();
    const url = `${proxyRoot}sub/nested.txt`;
    const { status, body } = await getJson<ReadBody>(`/-/agent-directory/read?url=${encodeURIComponent(url)}`);
    expect(status).toBe(200);
    expect(Buffer.from(body.bodyBase64, 'base64').toString('utf8')).toBe(NESTED_BODY);
    expect(proxy.log.filter((entry) => entry.path.includes('alpha.txt'))).toEqual([]);
    expect(proxy.log.filter((entry) => entry.path.includes('bravo.txt'))).toEqual([]);
  });
});
