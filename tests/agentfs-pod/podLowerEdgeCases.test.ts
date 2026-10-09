import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  PodHttpLowerFileSystem,
  PodLowerConflictError,
  PodLowerHttpError,
  type PendingOperation,
} from '../../packages/xpod-afs/src/agent-fs/pod-lower';
import { PodLowerPendingStore } from '../../packages/xpod-afs/src/agent-fs/pending-store';
import {
  AgentDirectoryClient,
  type AgentDirectoryRequest,
} from '../../packages/xpod-afs/src/directory/client';
import { startPodContractServer, type PodContractServer } from './support/podContractServer';

const TOKEN = 'edge-token';
const ALPHA = 'ALPHA_BODY_0123456789\n';
const bodyFor = (start: number): string => ALPHA.slice(start);
const TEST_DATA_ROOT = path.resolve('.test-data/agent-directory-workers/agentfs-test/edge');

function authedFetch(token: string): AgentDirectoryRequest {
  return (url, init) =>
    fetch(url, {
      ...init,
      headers: { ...(init.headers as Record<string, string> | undefined), authorization: `Bearer ${token}` },
    });
}

async function startRawServer(handler: (url: URL, request: import('node:http').IncomingMessage, response: import('node:http').ServerResponse) => void): Promise<{ origin: string; close: () => Promise<void> }> {
  const server: Server = createServer((request, response) => handler(new URL(request.url ?? '/', 'http://placeholder'), request, response));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address() as AddressInfo;
  return {
    origin: `http://127.0.0.1:${address.port}`,
    close: async () => {
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    },
  };
}

describe('PodHttpLowerFileSystem illegal path and URL-encoding boundaries', () => {
  let server: PodContractServer;
  let lower: PodHttpLowerFileSystem;

  function makeLower(): PodHttpLowerFileSystem {
    const request = authedFetch(TOKEN);
    return new PodHttpLowerFileSystem({
      baseUrl: server.podRoot,
      request,
      client: new AgentDirectoryClient({ baseUrl: server.podRoot, request }),
    });
  }

  beforeEach(async () => {
    server = await startPodContractServer({ token: TOKEN, files: { 'alpha.txt': ALPHA } });
    lower = makeLower();
  });

  afterEach(async () => {
    await server.close();
  });

  it('percent-encodes each path segment exactly once', () => {
    expect(lower.resourceUrl('a b/c#d%e.txt')).toBe(`${server.podRoot}a%20b/c%23d%25e.txt`);
    expect(lower.resourceUrl('café/Ω.txt')).toBe(`${server.podRoot}caf%C3%A9/%CE%A9.txt`);
    expect(lower.resourceUrl('a?b.txt')).toBe(`${server.podRoot}a%3Fb.txt`);
  });

  it('round-trips names with spaces, hash, percent and unicode', async () => {
    const name = 'a b/c#d%e.txt';
    await lower.create(name, Buffer.from('ENCODED_NAME\n'));
    expect(server.readBody(name)).toBe('ENCODED_NAME\n');
    expect((await lower.read(name)).data.toString('utf8')).toBe('ENCODED_NAME\n');

    await lower.create('café/Ω.txt', Buffer.from('UNICODE_NAME\n'));
    expect(server.readBody('café/Ω.txt')).toBe('UNICODE_NAME\n');
  });

  it('keeps a leading slash inside the Pod root instead of escaping to the origin', () => {
    const url = lower.resourceUrl('/abs.txt');
    expect(url.startsWith(server.podRoot)).toBe(true);
    expect(url).toBe(`${server.podRoot}abs.txt`);
  });

  it('rejects traversal, empty and dot segments before any request', async () => {
    for (const bad of [ '..', '../escape.txt', 'a/../b', 'a//b', './a', 'sub/./x' ]) {
      await expect(lower.read(bad), bad).rejects.toThrow(/Invalid Pod relative path/);
    }
  });
});

describe('PodHttpLowerFileSystem version consistency and Range boundaries', () => {
  it('never claims a stale version after a remote change following HEAD', async () => {
    const server = await startPodContractServer({ token: TOKEN, files: { 'alpha.txt': ALPHA } });
    const request = authedFetch(TOKEN);
    const lower = new PodHttpLowerFileSystem({
      baseUrl: server.podRoot,
      request,
      client: new AgentDirectoryClient({ baseUrl: server.podRoot, request }),
    });
    try {
      const head = await lower.stat('alpha.txt');
      expect(head?.version).toBe('"v1"');

      server.mutate('alpha.txt', 'REMOTE_AFTER_HEAD\n');

      const read = await lower.read('alpha.txt');
      expect(read.data.toString('utf8')).toBe('REMOTE_AFTER_HEAD\n');
      expect((await lower.stat('alpha.txt'))?.version).toBe('"v2"');

      await expect(lower.write('alpha.txt', Buffer.from('STALE\n'), head?.version ?? '')).rejects.toBeInstanceOf(PodLowerConflictError);
      expect(server.readBody('alpha.txt')).toBe('REMOTE_AFTER_HEAD\n');
    } finally {
      await server.close();
    }
  });

  it('accepts a legal short 206 read when the requested end goes past EOF', async () => {
    const total = 22;
    const raw = await startRawServer((_url, _request, response) => {
      const start = Number.parseInt(/bytes=(\d+)-/.exec(_request.headers.range ?? '')?.[1] ?? '0', 10);
      const end = total - 1;
      response.writeHead(206, {
        'content-type': 'text/plain',
        'content-range': `bytes ${start}-${end}/${total}`,
        'content-length': end - start + 1,
      });
      response.end(bodyFor(start));
    });
    const request = authedFetch(TOKEN);
    const lower = new PodHttpLowerFileSystem({
      baseUrl: `${raw.origin}/pod/`,
      request,
      client: new AgentDirectoryClient({ baseUrl: `${raw.origin}/pod/`, request }),
    });
    try {
      const result = await lower.read('alpha.txt', 20, 10);
      expect(result.rangeIgnored).toBe(false);
      expect(result.data).toHaveLength(2);
      expect(result.data.toString('utf8')).toBe(bodyFor(20));
    } finally {
      await raw.close();
    }
  });

  it('treats a 416 past-EOF range as a normal empty read (POSIX pread semantics)', async () => {
    const raw = await startRawServer((_url, _request, response) => {
      response.writeHead(416, { 'content-range': 'bytes */22', 'content-length': 0 });
      response.end();
    });
    const request = authedFetch(TOKEN);
    const lower = new PodHttpLowerFileSystem({
      baseUrl: `${raw.origin}/pod/`,
      request,
      client: new AgentDirectoryClient({ baseUrl: `${raw.origin}/pod/`, request }),
    });
    try {
      const result = await lower.read('alpha.txt', 100, 5);
      expect(result.data).toHaveLength(0);
      expect(result.rangeIgnored).toBe(false);
    } finally {
      await raw.close();
    }
  });

  it('treats a 416 as a normal empty read only when the offset is at/after the Content-Range total', async () => {
    const atEnd = await startRawServer((_url, _request, response) => {
      response.writeHead(416, { 'content-range': 'bytes */22', 'content-length': 0 });
      response.end();
    });
    const request = authedFetch(TOKEN);
    const lower = new PodHttpLowerFileSystem({
      baseUrl: `${atEnd.origin}/pod/`,
      request,
      client: new AgentDirectoryClient({ baseUrl: `${atEnd.origin}/pod/`, request }),
    });
    try {
      const result = await lower.read('alpha.txt', 22, 5);
      expect(result.data).toHaveLength(0);
    } finally {
      await atEnd.close();
    }

    const inside = await startRawServer((_url, _request, response) => {
      response.writeHead(416, { 'content-range': 'bytes */100', 'content-length': 0 });
      response.end();
    });
    const lower2 = new PodHttpLowerFileSystem({
      baseUrl: `${inside.origin}/pod/`,
      request,
      client: new AgentDirectoryClient({ baseUrl: `${inside.origin}/pod/`, request }),
    });
    try {
      await expect(lower2.read('alpha.txt', 10, 5)).rejects.toBeInstanceOf(PodLowerHttpError);
    } finally {
      await inside.close();
    }
  });

  it('maps HEAD 404 to a missing stat and never reports a missing Content-Length as size 0', async () => {
    const missing = await startRawServer((_url, _request, response) => {
      response.writeHead(404, { 'content-length': 0 });
      response.end();
    });
    const noLength = await startRawServer((_url, _request, response) => {
      response.writeHead(200, { 'content-type': 'text/plain' });
      response.end();
    });
    const request = authedFetch(TOKEN);
    const missingLower = new PodHttpLowerFileSystem({
      baseUrl: `${missing.origin}/pod/`,
      request,
      client: new AgentDirectoryClient({ baseUrl: `${missing.origin}/pod/`, request }),
    });
    const noLengthLower = new PodHttpLowerFileSystem({
      baseUrl: `${noLength.origin}/pod/`,
      request,
      client: new AgentDirectoryClient({ baseUrl: `${noLength.origin}/pod/`, request }),
    });
    try {
      expect(await missingLower.stat('alpha.txt')).toBeUndefined();
      const stat = await noLengthLower.stat('alpha.txt');
      expect(stat).toBeDefined();
      expect(stat?.size).not.toBe(0);
      expect(stat?.size).toBeUndefined();
    } finally {
      await missing.close();
      await noLength.close();
    }
  });

  it('rejects a 206 whose Content-Range start does not match the requested start', async () => {
    const raw = await startRawServer((_url, _request, response) => {
      response.writeHead(206, {
        'content-type': 'text/plain',
        'content-range': 'bytes 0-4/100',
        'content-length': 5,
      });
      response.end('WRONG');
    });
    const request = authedFetch(TOKEN);
    const lower = new PodHttpLowerFileSystem({
      baseUrl: `${raw.origin}/pod/`,
      request,
      client: new AgentDirectoryClient({ baseUrl: `${raw.origin}/pod/`, request }),
    });
    try {
      await expect(lower.read('alpha.txt', 10, 5)).rejects.toBeInstanceOf(PodLowerHttpError);
    } finally {
      await raw.close();
    }
  });

  it('reports rangeIgnored and full-download bytes when the server ignores Range', async () => {
    const big = Buffer.alloc(2 * 1024 * 1024, 0x41);
    const raw = await startRawServer((_url, _request, response) => {
      response.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': big.length });
      response.end(big);
    });
    const request = authedFetch(TOKEN);
    const lower = new PodHttpLowerFileSystem({
      baseUrl: `${raw.origin}/pod/`,
      request,
      client: new AgentDirectoryClient({ baseUrl: `${raw.origin}/pod/`, request }),
    });
    try {
      const result = await lower.read('big.bin', 1024, 16);
      expect(result.rangeIgnored).toBe(true);
      expect(result.data).toHaveLength(16);
      expect(result.data.every((byte) => byte === 0x41)).toBe(true);
      expect(lower.getTransferStats().bodiesReadBytes).toBe(big.length);
    } finally {
      await raw.close();
    }
  });
});

describe('PodHttpLowerFileSystem pending concurrency, restart and rename partial failure', () => {
  let server: PodContractServer;

  beforeEach(async () => {
    server = await startPodContractServer({ token: TOKEN, files: { 'alpha.txt': ALPHA } });
  });

  afterEach(async () => {
    await server.close();
  });

  function makeLower(): PodHttpLowerFileSystem {
    const request = authedFetch(TOKEN);
    return new PodHttpLowerFileSystem({
      baseUrl: server.podRoot,
      request,
      client: new AgentDirectoryClient({ baseUrl: server.podRoot, request }),
    });
  }

  function writeOp(id: string, file: string, content: string, extra: Partial<PendingOperation> = {}): PendingOperation {
    return { id, op: 'write', path: file, dataBase64: Buffer.from(content).toString('base64'), create: true, ...extra } as PendingOperation;
  }

  it('serializes concurrent commits without double-applying', async () => {
    const lower = makeLower();
    lower.enqueue(writeOp('c1', 'conc.txt', 'CONCURRENT\n'));

    const results = await Promise.all([ lower.commit(), lower.commit() ]);
    const applied = results.reduce((sum, result) => sum + result.applied, 0);
    expect(applied).toBe(1);
    expect(server.readBody('conc.txt')).toBe('CONCURRENT\n');
    expect(lower.listPending()).toHaveLength(0);
  });

  it('survives a restart by reloading persisted pending operations', () => {
    mkdirSync(TEST_DATA_ROOT, { recursive: true });
    const dir = mkdtempSync(path.join(TEST_DATA_ROOT, 'session-'));
    try {
      const first = makeLower();
      first.enqueue(writeOp('r1', 'restart.txt', 'AFTER_RESTART\n'));
      new PodLowerPendingStore(dir).save(first.listPending());

      const second = makeLower();
      for (const operation of new PodLowerPendingStore(dir).load()) {
        second.enqueue(operation);
      }
      return second.commit().then((result) => {
        expect(result).toEqual({ applied: 1, conflicts: [] });
        expect(server.readBody('restart.txt')).toBe('AFTER_RESTART\n');
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('exposes a non-atomic rename when the conditional delete fails', async () => {
    const lower = makeLower();
    await lower.create('from.txt', Buffer.from('RENAME_SOURCE\n'));

    server.mutate('from.txt', 'CHANGED_REMOTELY\n');

    await expect(lower.rename('from.txt', 'to.txt', '"v1"')).rejects.toBeInstanceOf(PodLowerConflictError);
    expect(server.readBody('to.txt')).toBe('CHANGED_REMOTELY\n');
    expect(server.readBody('from.txt')).toBe('CHANGED_REMOTELY\n');
  });
});

describe('PodHttpLowerFileSystem merges the client-side overlay before commit', () => {
  let server: PodContractServer;
  let lower: PodHttpLowerFileSystem;

  beforeEach(async () => {
    server = await startPodContractServer({ token: TOKEN, files: { 'alpha.txt': ALPHA } });
    const request = authedFetch(TOKEN);
    lower = new PodHttpLowerFileSystem({
      baseUrl: server.podRoot,
      request,
      client: new AgentDirectoryClient({ baseUrl: server.podRoot, request }),
    });
  });

  afterEach(async () => {
    await server.close();
  });

  it('keeps the Pod authoritative until commit while retaining the client-side delta', async () => {
    lower.enqueue({ id: 'd1', op: 'write', path: 'dirty.txt', dataBase64: Buffer.from('DIRTY_VIEW\n').toString('base64'), create: true });
    lower.enqueue({ id: 'd3', op: 'delete', path: 'alpha.txt', baseVersion: '"v1"' });

    // Whether the delta is merged in the lower or in a separate overlay view,
    // the Pod must not change before an explicit commit.
    expect(server.readBody('dirty.txt')).toBe('');
    expect(server.readBody('alpha.txt')).toBe(ALPHA);
    expect(lower.listPending().map((operation) => `${operation.op}:${operation.path}`).sort()).toEqual([
      'delete:alpha.txt',
      'write:dirty.txt',
    ]);
  });

  it('exposes pending add/write/delete operations for an overlay consumer to merge', () => {
    lower.enqueue({ id: 'add', op: 'write', path: 'dirty.txt', dataBase64: Buffer.from('DIRTY_VIEW\n').toString('base64'), create: true });
    lower.enqueue({ id: 'overwrite', op: 'write', path: 'alpha.txt', dataBase64: Buffer.from('OVERWRITTEN\n').toString('base64'), baseVersion: '"v1"', create: false });
    lower.enqueue({ id: 'delete', op: 'delete', path: 'gone.txt', baseVersion: '"v1"' });

    expect(lower.listPending().map((operation) => `${operation.op}:${operation.path}`)).toEqual([
      'write:dirty.txt',
      'write:alpha.txt',
      'delete:gone.txt',
    ]);
  });

  it('reflects per-resource versions so an overlay can detect base-version drift', async () => {
    const stat = await lower.stat('alpha.txt');
    expect(stat?.version).toBe('"v1"');
    server.mutate('alpha.txt', 'REMOTE\n');
    expect((await lower.stat('alpha.txt'))?.version).toBe('"v2"');
  });
});
