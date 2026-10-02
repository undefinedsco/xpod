import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer, request } from 'node:http';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { Writable } from 'node:stream';
import {
  guardedStreamFrom,
  RepresentationMetadata,
  type HttpResponse,
  type MetadataWriter,
} from '@solid/community-server';
import httpProxy from 'http-proxy';
import { describe, expect, it, vi } from 'vitest';
import { resolveJsRuntime } from '../../src/runtime/js-runtime';
import { HeadSafeResponseWriter } from '../../src/http/HeadSafeResponseWriter';

function fixture(method: string) {
  const chunks: Buffer[] = [];
  const response = Object.assign(new Writable({
    write(chunk, _encoding, callback) { chunks.push(Buffer.from(chunk)); callback(); },
  }), { req: { method }, writeHead: vi.fn() }) as unknown as HttpResponse;
  const metadataWriter = { handleSafe: vi.fn(async () => {}) } as unknown as MetadataWriter;
  return { response, chunks, metadataWriter, writer: new HeadSafeResponseWriter(metadataWriter) };
}

describe('HeadSafeResponseWriter', () => {
  it.each([200, 404, 500])('ends HEAD %s without streaming a generated body', async (statusCode) => {
    const { response, chunks, metadataWriter, writer } = fixture('HEAD');
    const metadata = new RepresentationMetadata();
    const data = guardedStreamFrom('Generated response body');
    const finished = once(response, 'finish');
    await writer.handle({ response, result: { statusCode, metadata, data } });
    await finished;
    expect(response.writeHead).toHaveBeenCalledWith(statusCode);
    expect(metadataWriter.handleSafe).toHaveBeenCalledWith({ response, metadata });
    expect(Buffer.concat(chunks).length).toBe(0);
    expect(data.destroyed).toBe(true);
  });

  it.each([404, 200])('preserves GET %s bodies and metadata', async (statusCode) => {
    const { response, chunks, metadataWriter, writer } = fixture('GET');
    const metadata = new RepresentationMetadata();
    const body = Buffer.from([0, 255, 32, 65]);
    const finished = once(response, 'finish');
    await writer.handle({ response, result: { statusCode, metadata, data: guardedStreamFrom(body) } });
    await finished;
    expect(response.writeHead).toHaveBeenCalledWith(statusCode);
    expect(metadataWriter.handleSafe).toHaveBeenCalledWith({ response, metadata });
    expect(Buffer.concat(chunks)).toEqual(body);
  });

  it('preserves an already bodyless HEAD response', async () => {
    const { response, chunks, writer } = fixture('HEAD');
    const finished = once(response, 'finish');
    await writer.handle({ response, result: { statusCode: 404 } });
    await finished;
    expect(response.writeHead).toHaveBeenCalledWith(404);
    expect(chunks).toHaveLength(0);
  });
});

// CI supplies Bun 1.3.12; Node's HTTP parser must accept HEAD errors from the
// CSS runtime. The body-producing upstream is what triggered HPE_INVALID_CONSTANT.
const runtime = resolveJsRuntime();
it.skipIf(!runtime.isBun || Boolean(process.versions.bun))('serves Bun HEAD errors through a Node proxy without corrupting HTTP framing', async () => {
  const child = spawn(runtime.command, [path.resolve('tests/helpers/headResponseWriterServer.ts')], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const childClosed = new Promise<void>((resolve) => child.once('close', () => resolve()));
  const lines = createInterface({ input: child.stdout! });
  let stderr = '';
  child.stderr!.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
  const proxy = httpProxy.createProxyServer();
  const errors: string[] = [];
  proxy.on('error', (error, _request, response) => {
    errors.push(error.message);
    if ('writeHead' in response) { response.writeHead(502); response.end(); }
  });
  let upstreamPort: number;
  const server = createServer((req, res) => proxy.web(req, res, { target: `http://127.0.0.1:${upstreamPort}` }));
  try {
    upstreamPort = await new Promise<number>((resolve, reject) => {
      const timer = setTimeout(() => finish(new Error(`Bun response fixture timed out: ${stderr}`)), 15_000);
      const onError = (error: Error) => finish(error);
      const onExit = () => finish(new Error(`Bun response fixture exited: ${stderr}`));
      const onLine = (line: string) => {
        if (!line.startsWith('{"port":')) { return; }
        const port = (JSON.parse(line) as { port: number }).port;
        finish(undefined, port);
      };
      const finish = (error?: Error, port?: number) => {
        clearTimeout(timer);
        child.off('error', onError); child.off('exit', onExit); lines.off('line', onLine);
        if (error) { reject(error); } else { resolve(port!); }
      };
      child.once('error', onError); child.once('exit', onExit); lines.on('line', onLine);
    });
    const listening = once(server, 'listening');
    server.listen(0, '127.0.0.1');
    await listening;
    const address = server.address();
    if (!address || typeof address === 'string') { throw new Error('Node proxy has no bound port'); }
    for (const method of ['HEAD', 'GET']) {
      const observed = await new Promise<{ status?: number; body: string }>((resolve, reject) => {
        const req = request({ hostname: '127.0.0.1', port: address.port, path: '/missing', method }, (res) => {
          let body = '';
          res.on('data', (chunk: Buffer) => { body += chunk.toString(); });
          res.once('end', () => resolve({ status: res.statusCode, body }));
          res.once('error', reject);
        });
        req.setTimeout(5_000, () => req.destroy(new Error('Proxy response timed out')));
        req.once('error', reject); req.end();
      });
      expect(observed).toEqual({ status: 404, body: method === 'HEAD' ? '' : 'NotFoundHttpError: \n' });
    }
    expect(errors).toEqual([]);
  } finally {
    server.closeAllConnections(); server.close(); proxy.close(); lines.close();
    if (child.exitCode === null && child.signalCode === null) { child.kill('SIGTERM'); }
    await childClosed;
  }
}, 30_000);
