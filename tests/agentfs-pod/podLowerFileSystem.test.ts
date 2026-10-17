import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  PodHttpLowerFileSystem,
  PodLowerConflictError,
  PodLowerHttpError,
} from '../../packages/xpod-afs/src/agent-fs/pod-lower';
import {
  AgentDirectoryClient,
  type AgentDirectoryRequest,
} from '../../packages/xpod-afs/src/directory/client';
import { startPodContractServer, type PodContractServer } from './support/podContractServer';

const ALPHA = 'ALPHA_BODY_0123456789\n';
const BIG = `${'x'.repeat(200_000)}\nBIG_END\n`;
const TOKEN = 'lower-token';

function authedFetch(token: string): AgentDirectoryRequest {
  return (url, init) =>
    fetch(url, {
      ...init,
      headers: { ...(init.headers as Record<string, string> | undefined), authorization: `Bearer ${token}` },
    });
}

describe('PodHttpLowerFileSystem over the Pod HTTP contract', () => {
  let server: PodContractServer;
  let lower: PodHttpLowerFileSystem;

  function makeLower(token = TOKEN, request?: AgentDirectoryRequest): PodHttpLowerFileSystem {
    const effective = request ?? authedFetch(token);
    return new PodHttpLowerFileSystem({
      baseUrl: server.podRoot,
      request: effective,
      client: new AgentDirectoryClient({ baseUrl: server.podRoot, request: effective }),
    });
  }

  beforeEach(async () => {
    server = await startPodContractServer({
      token: TOKEN,
      deniedPaths: [ 'secret.txt' ],
      files: { 'alpha.txt': ALPHA, 'big.txt': BIG, 'secret.txt': 'SECRET\n' },
    });
    lower = makeLower();
  });

  afterEach(async () => {
    await server.close();
  });

  it('readdir is metadata-only and never reads file bodies', async () => {
    server.resetLog();
    const entries = await lower.readdir('');

    expect(entries.map((entry) => entry.path).sort()).toEqual([ 'alpha.txt', 'big.txt' ]);
    expect(entries.find((entry) => entry.path === 'big.txt')?.size).toBe(Buffer.byteLength(BIG));
    expect(server.log.some((entry) => entry.resource !== undefined)).toBe(false);
    expect(lower.getTransferStats().bodiesReadBytes).toBe(0);
  });

  it('stat uses HEAD and returns metadata without a body', async () => {
    server.resetLog();
    const stat = await lower.stat('alpha.txt');

    expect(stat).toMatchObject({ path: 'alpha.txt', type: 'file', size: Buffer.byteLength(ALPHA), version: '"v1"' });
    expect(server.log).toHaveLength(1);
    expect(server.log[0].method).toBe('HEAD');
    expect(server.log.filter((entry) => entry.method === 'GET')).toEqual([]);
    expect(lower.getTransferStats().bodiesReadBytes).toBe(0);
  });

  it('range reads transfer only the requested slice', async () => {
    server.resetLog();
    const result = await lower.read('alpha.txt', 6, 9);

    expect(result.rangeIgnored).toBe(false);
    expect(result.data.toString('utf8')).toBe('BODY_0123');
    const getEntry = server.log.find((entry) => entry.method === 'GET' && entry.resource === 'alpha.txt');
    expect(getEntry?.range).toBe('bytes=6-14');
    expect(getEntry?.responseBytes).toBe(9);
    expect(lower.getTransferStats().bodiesReadBytes).toBe(9);
  });

  it('rejects a duplicate conditional create without overwriting', async () => {
    const created = await lower.create('created.txt', Buffer.from('CREATED\n'));
    expect(created.version).toBe('"v1"');
    expect(server.readBody('created.txt')).toBe('CREATED\n');

    await expect(lower.create('created.txt', Buffer.from('OVERWRITE\n'))).rejects.toBeInstanceOf(PodLowerConflictError);
    expect(server.readBody('created.txt')).toBe('CREATED\n');
  });

  it('rejects a stale conditional write and accepts a fresh version', async () => {
    const before = await lower.stat('alpha.txt');
    expect(before?.version).toBe('"v1"');

    server.mutate('alpha.txt', 'REMOTE_UPDATE\n');
    await expect(lower.write('alpha.txt', Buffer.from('LOCAL_STALE\n'), '"v1"')).rejects.toBeInstanceOf(PodLowerConflictError);
    expect(server.readBody('alpha.txt')).toBe('REMOTE_UPDATE\n');

    const fresh = await lower.stat('alpha.txt');
    expect(fresh?.version).toBe('"v2"');
    await lower.write('alpha.txt', Buffer.from('LOCAL_FRESH\n'), fresh?.version ?? '');
    expect(server.readBody('alpha.txt')).toBe('LOCAL_FRESH\n');
  });

  it('requires a version baseline for delete', async () => {
    await expect(lower.remove('alpha.txt')).rejects.toBeInstanceOf(PodLowerConflictError);

    const stat = await lower.stat('alpha.txt');
    await lower.remove('alpha.txt', stat?.version);
    expect(server.readBody('alpha.txt')).toBe('');
  });

  it('revalidates versions so external updates are observed without a body cache', async () => {
    const first = await lower.stat('alpha.txt');
    expect(first?.version).toBe('"v1"');

    server.mutate('alpha.txt', 'EXTERNAL_CHANGE\n');
    const reread = await lower.read('alpha.txt');
    expect(reread.data.toString('utf8')).toBe('EXTERNAL_CHANGE\n');
    expect((await lower.stat('alpha.txt'))?.version).toBe('"v2"');
  });

  it('keeps dirty operations pending until commit and surfaces them to the search view', async () => {
    lower.enqueue({ id: 'p1', op: 'write', path: 'pending.txt', dataBase64: Buffer.from('PENDING_DIRTY\n').toString('base64'), create: true });
    expect(lower.listPending()).toHaveLength(1);

    const committed = await lower.commit();
    expect(committed).toEqual({ applied: 1, conflicts: [] });
    expect(lower.listPending()).toEqual([]);
    expect(server.readBody('pending.txt')).toBe('PENDING_DIRTY\n');

    const listing = await lower.readdir('');
    expect(listing.map((entry) => entry.path)).toContain('pending.txt');
    const search = await fetch(`${server.origin}/-/agent-directory/search?q=PENDING_DIRTY&root=${encodeURIComponent(server.podRoot)}`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    const searchBody = (await search.json()) as { matches: { path: string }[] };
    expect(searchBody.matches.map((match) => match.path)).toContain('pending.txt');
  });

  it('retains a conflicted pending operation instead of dropping it', async () => {
    const stat = await lower.stat('alpha.txt');
    server.mutate('alpha.txt', 'REMOTE_MOVED_ON\n');
    lower.enqueue({ id: 'p2', op: 'write', path: 'alpha.txt', dataBase64: Buffer.from('LOCAL\n').toString('base64'), baseVersion: stat?.version, create: false });

    const committed = await lower.commit();
    expect(committed.conflicts).toEqual([ 'alpha.txt' ]);
    expect(lower.listPending().map((operation) => operation.id)).toEqual([ 'p2' ]);
    expect(server.readBody('alpha.txt')).toBe('REMOTE_MOVED_ON\n');
  });

  it('renames through conditional create plus conditional delete', async () => {
    await lower.create('from.txt', Buffer.from('RENAME_BODY\n'));
    await lower.rename('from.txt', 'to.txt');

    expect(server.readBody('to.txt')).toBe('RENAME_BODY\n');
    expect(server.readBody('from.txt')).toBe('');
  });

  it('fails closed on authentication and permission errors', async () => {
    const anonymous = makeLower('wrong-token');
    await expect(anonymous.stat('alpha.txt')).rejects.toBeInstanceOf(PodLowerHttpError);
    await expect(anonymous.stat('alpha.txt')).rejects.toMatchObject({ status: 401 });

    await expect(lower.stat('secret.txt')).rejects.toMatchObject({ status: 403 });
  });

  it('rejects path traversal before issuing a request', async () => {
    await expect(lower.read('../outside.txt')).rejects.toThrow(/Invalid Pod relative path/);
  });
});
