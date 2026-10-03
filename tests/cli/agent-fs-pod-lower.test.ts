import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AgentDirectoryClient } from '../../src/agent-directory/client/AgentDirectoryClient';
import {
  PodHttpLowerFileSystem,
  PodLowerConflictError,
} from '../../src/cli/agent-fs/pod-lower';

interface FixtureRecord {
  method: string;
  url: string;
  range?: string;
  bytesOut: number;
}

interface StoredFile {
  data: Buffer;
  version: string;
}

class FixturePod {
  public readonly requests: FixtureRecord[] = [];
  private readonly files = new Map<string, StoredFile>();
  private readonly server: Server;
  private nextVersion = 1;
  public origin = '';

  public constructor() {
    this.server = createServer((request, response) => {
      void this.handle(request, response);
    });
  }

  public async start(): Promise<void> {
    await new Promise<void>((resolve) => this.server.listen(0, '127.0.0.1', () => resolve()));
    const address = this.server.address() as AddressInfo;
    this.origin = `http://127.0.0.1:${address.port}`;
  }

  public async stop(): Promise<void> {
    await new Promise<void>((resolve, reject) => this.server.close((error) => (error ? reject(error) : resolve())));
  }

  public podRoot(): string {
    return `${this.origin}/pod/`;
  }

  public putRaw(relative: string, data: string | Buffer): void {
    this.files.set(relative, { data: Buffer.from(data), version: this.bumpVersion() });
  }

  public mutateExternally(relative: string, data: string): void {
    this.putRaw(relative, data);
  }

  public raw(relative: string): Buffer | undefined {
    return this.files.get(relative)?.data;
  }

  private bumpVersion(): string {
    this.nextVersion += 1;
    return `"v${this.nextVersion}"`;
  }

  private record(request: { method?: string; url?: string; headers: Record<string, unknown> }, bytesOut: number): void {
    this.requests.push({
      method: request.method ?? 'GET',
      url: request.url ?? '',
      ...(request.headers.range ? { range: String(request.headers.range) } : {}),
      bytesOut,
    });
  }

  private async handle(
    request: import('node:http').IncomingMessage,
    response: import('node:http').ServerResponse,
  ): Promise<void> {
    const relative = decodeURIComponent(new URL(request.url ?? '/', this.origin).pathname.replace(/^\/pod\//, ''));
    const existing = this.files.get(relative);

    if (request.method === 'HEAD') {
      this.record(request as never, 0);
      if (!existing) {
        response.writeHead(404).end();
        return;
      }
      response.writeHead(200, {
        'Content-Length': String(existing.data.length),
        'Content-Type': 'text/plain',
        ETag: existing.version,
        'Last-Modified': 'Wed, 01 Oct 2025 00:00:00 GMT',
      }).end();
      return;
    }

    if (request.method === 'GET') {
      if (!existing) {
        this.record(request as never, 0);
        response.writeHead(404).end();
        return;
      }
      const range = request.headers.range;
      if (range) {
        const match = /bytes=(\d+)-(\d*)/.exec(range);
        const start = match ? Number(match[1]) : 0;
        const end = match && match[2] ? Number(match[2]) : existing.data.length - 1;
        const slice = existing.data.subarray(start, end + 1);
        this.record(request as never, slice.length);
        response.writeHead(206, {
          'Content-Range': `bytes ${start}-${start + slice.length - 1}/${existing.data.length}`,
          'Content-Length': String(slice.length),
        }).end(slice);
        return;
      }
      this.record(request as never, existing.data.length);
      response.writeHead(200, { 'Content-Length': String(existing.data.length) }).end(existing.data);
      return;
    }

    if (request.method === 'PUT') {
      const chunks: Buffer[] = [];
      for await (const chunk of request) {
        chunks.push(Buffer.from(chunk));
      }
      const body = Buffer.concat(chunks);
      if (request.headers['if-none-match'] === '*' && existing) {
        this.record(request as never, body.length);
        response.writeHead(412).end();
        return;
      }
      if (request.headers['if-none-match'] === '*' && !existing) {
        const version = this.bumpVersion();
        this.files.set(relative, { data: body, version });
        this.record(request as never, body.length);
        response.writeHead(201, { ETag: version }).end();
        return;
      }
      const ifMatch = request.headers['if-match'];
      if (typeof ifMatch === 'string' && existing && existing.version !== ifMatch) {
        this.record(request as never, body.length);
        response.writeHead(412).end();
        return;
      }
      const version = this.bumpVersion();
      this.files.set(relative, { data: body, version });
      this.record(request as never, body.length);
      response.writeHead(200, { ETag: version }).end();
      return;
    }

    if (request.method === 'DELETE') {
      if (!existing) {
        this.record(request as never, 0);
        response.writeHead(404).end();
        return;
      }
      const ifMatch = request.headers['if-match'];
      if (typeof ifMatch === 'string' && existing.version !== ifMatch) {
        this.record(request as never, 0);
        response.writeHead(412).end();
        return;
      }
      this.files.delete(relative);
      this.record(request as never, 0);
      response.writeHead(204).end();
      return;
    }

    response.writeHead(405).end();
  }
}

function fakeClient(entries: { path: string; type: 'file' | 'container'; url?: string }[]): AgentDirectoryClient {
  return {
    listAll: async () => ({
      root: 'root',
      entries: entries.map((entry) => ({
        path: entry.path,
        url: entry.url ?? `https://pod.example/alice/${entry.path}`,
        type: entry.type,
      })),
      truncated: false,
      complete: true,
      scanned: entries.length,
    }),
  } as unknown as AgentDirectoryClient;
}

describe('PodHttpLowerFileSystem over HTTP', () => {
  let pod: FixturePod;
  let lower: PodHttpLowerFileSystem;

  beforeAll(async () => {
    pod = new FixturePod();
    await pod.start();
    pod.putRaw('hello.txt', 'abcdefghij');
    lower = new PodHttpLowerFileSystem({
      baseUrl: pod.podRoot(),
      request: (url, init) => fetch(url, init),
      client: fakeClient([ { path: 'hello.txt', type: 'file' }, { path: 'sub/', type: 'container' } ]),
    });
  });

  afterAll(async () => {
    await pod.stop();
  });

  it('enumerates metadata without transferring any file body', async () => {
    pod.requests.length = 0;
    const entries = await lower.readdir('');
    expect(entries.map((entry) => entry.path)).toEqual([ 'hello.txt', 'sub/' ]);
    expect(pod.requests).toEqual([]);
  });

  it('reads only the requested byte range', async () => {
    pod.requests.length = 0;
    const result = await lower.read('hello.txt', 2, 4);
    expect(result.data.toString('utf8')).toBe('cdef');
    expect(result.rangeIgnored).toBe(false);
    const gets = pod.requests.filter((entry) => entry.method === 'GET');
    expect(gets).toHaveLength(1);
    expect(gets[0].range).toBe('bytes=2-5');
    expect(gets[0].bytesOut).toBe(4);
  });

  it('reports a 200 fallback when the server ignores Range', async () => {
    const ignoring = new PodHttpLowerFileSystem({
      baseUrl: pod.podRoot(),
      request: async (url, init) => {
        const headers = new Headers(init?.headers);
        headers.delete('Range');
        return fetch(url, { ...init, headers });
      },
      client: fakeClient([]),
    });
    const result = await ignoring.read('hello.txt', 2, 4);
    expect(result.data.toString('utf8')).toBe('cdef');
    expect(result.rangeIgnored).toBe(true);
  });

  it('creates conditionally and reports a conflict on a second create', async () => {
    const created = await lower.create('new.txt', Buffer.from('one'));
    expect(created.version).toBeTruthy();
    await expect(lower.create('new.txt', Buffer.from('two'))).rejects.toBeInstanceOf(PodLowerConflictError);
  });

  it('rejects an overwrite with a stale version baseline', async () => {
    const stat = await lower.stat('hello.txt');
    expect(stat?.version).toBeTruthy();
    pod.mutateExternally('hello.txt', 'external-change');
    await expect(lower.write('hello.txt', Buffer.from('local'), stat?.version as string))
      .rejects.toBeInstanceOf(PodLowerConflictError);
    expect(pod.raw('hello.txt')?.toString('utf8')).toBe('external-change');
  });

  it('revalidates versions after an external change instead of serving a cached body', async () => {
    const before = await lower.stat('hello.txt');
    pod.mutateExternally('hello.txt', 'changed-again');
    const after = await lower.stat('hello.txt');
    expect(after?.version).toBeTruthy();
    expect(after?.version).not.toBe(before?.version);
    const read = await lower.read('hello.txt');
    expect(read.data.toString('utf8')).toBe('changed-again');
  });

  it('deletes conditionally and rejects a stale delete', async () => {
    await lower.create('doomed.txt', Buffer.from('x'));
    const stat = await lower.stat('doomed.txt');
    pod.mutateExternally('doomed.txt', 'y');
    await expect(lower.remove('doomed.txt', stat?.version as string)).rejects.toBeInstanceOf(PodLowerConflictError);
    const fresh = await lower.stat('doomed.txt');
    await lower.remove('doomed.txt', fresh?.version as string);
    expect(await lower.stat('doomed.txt')).toBeUndefined();
  });

  it('applies pending operations and retains conflicts for retry', async () => {
    await lower.create('pending.txt', Buffer.from('base'));
    const stat = await lower.stat('pending.txt');
    pod.mutateExternally('pending.txt', 'moved-on');

    lower.enqueue({
      id: 'w1',
      op: 'write',
      path: 'pending.txt',
      dataBase64: Buffer.from('dirty').toString('base64'),
      baseVersion: stat?.version,
      create: false,
    });
    const helloVersion = (await lower.stat('hello.txt'))?.version;
    lower.enqueue({ id: 'd1', op: 'delete', path: 'hello.txt', baseVersion: helloVersion });

    const result = await lower.commit();
    expect(result.applied).toBe(1);
    expect(result.conflicts).toEqual([ 'pending.txt' ]);
    // The conflicted op is retained; the successful one is gone.
    expect(lower.listPending().map((operation) => operation.id)).toEqual([ 'w1' ]);
    // The conflicted file was not overwritten remotely.
    expect(pod.raw('pending.txt')?.toString('utf8')).toBe('moved-on');
  });

  it('does not download the whole file for a partial read', async () => {
    pod.putRaw('big.bin', Buffer.alloc(1024 * 64, 7));
    pod.requests.length = 0;
    const result = await lower.read('big.bin', 0, 16);
    expect(result.data.length).toBe(16);
    const bytesOut = pod.requests.reduce((sum, entry) => sum + entry.bytesOut, 0);
    expect(bytesOut).toBe(16);
  });
});
