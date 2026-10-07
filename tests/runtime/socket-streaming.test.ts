import { getEventListeners } from 'node:events';
import { createServer, type ServerResponse } from 'node:http';
import { type Socket } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { fetchViaSocket, registerSocketFetchOrigin } from '../../src/runtime/socket-fetch';

const sockets = new Set<Socket>();
const responses = new Map<string, ServerResponse>();
let produced = 0;
const closures = new Map<string, Promise<void>>();
const server = createServer((request, response) => {
  response.setHeader('Connection', 'close');
  const path = request.url!;
  responses.set(path, response);
  closures.set(path, new Promise(resolve => response.once('close', resolve)));
  if (path === '/backpressure') {
    response.writeHead(200); produced = 0;
    const pump = (): void => {
      while (produced < 64) { produced += 1; if (!response.write(Buffer.alloc(65536, 122))) { response.once('drain', pump); return; } }
      response.end();
    };
    pump(); return;
  }
  if (path === '/denied') { response.writeHead(403).end('permission denied'); return; }
  if (path.startsWith('/wait')) return;
  if (path.startsWith('/stream')) { response.writeHead(200, { 'Content-Type': 'text/event-stream' }); response.write('data: first\n\n'); return; }
  if (path === '/truncated') { response.writeHead(200, { 'Content-Length': '100' }); response.write('partial'); setTimeout(() => response.destroy(), 20); return; }
  if (path.startsWith('/status/')) { response.writeHead(Number(path.split('/')[2])).end(); return; }
  const chunks: Buffer[] = [];
  request.on('data', chunk => chunks.push(Buffer.from(chunk)));
  request.on('end', () => { response.writeHead(200, { 'Content-Type': 'application/octet-stream' }); response.end(chunks.length ? Buffer.concat(chunks) : Buffer.from([0, 255, 13, 10])); });
});
server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
let directory: string; let socketPath: string;
const origin = 'http://socket-streaming.invalid';
beforeAll(async() => { directory = mkdtempSync(join(tmpdir(), 'xs-stream-')); socketPath = join(directory, 'http.sock'); await new Promise<void>(resolve => server.listen(socketPath, resolve)); });
afterEach(async() => { await Promise.all([...sockets].map(socket => new Promise<void>(resolve => { socket.once('close', resolve); socket.destroy(); }))); responses.clear(); closures.clear(); });
afterAll(async() => { for (const socket of sockets) socket.destroy(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); rmSync(directory, { recursive: true, force: true }); });
async function headers(path: string, init?: RequestInit): Promise<Response> {
  return Promise.race([fetchViaSocket(socketPath, origin, `${origin}${path}`, init), new Promise<never>((_, reject) => setTimeout(() => reject(new Error('Headers blocked behind producer EOF')), 500))]);
}
describe('actual Unix socket response streaming', () => {
  it('returns headers and successive chunks before EOF; cancellation closes the original producer', async() => {
    const response = await headers('/stream'); const reader = response.body!.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toBe('data: first\n\n');
    responses.get('/stream')!.write('data: second\n\n');
    expect(new TextDecoder().decode((await reader.read()).value)).toBe('data: second\n\n');
    await reader.cancel(); await closures.get('/stream'); expect(responses.get('/stream')!.destroyed).toBe(true);
  });
  it('init abort after headers errors the body and closes the producer', async() => {
    const controller = new AbortController(); const response = await headers('/stream-abort', { signal: controller.signal });
    controller.abort(new Error('caller cancelled')); await expect(response.text()).rejects.toThrow(); await closures.get('/stream-abort');
  });
  it('Request inherited abort reaches the global shim after headers', async() => {
    const release = registerSocketFetchOrigin(origin, socketPath); const controller = new AbortController();
    try { const response = await fetch(new Request(`${origin}/stream-request`, { signal: controller.signal })); controller.abort(); await expect(response.text()).rejects.toThrow(); await closures.get('/stream-request'); }
    finally { await release(); }
  });
  it('already aborted and pre-header abort reject fetch', async() => {
    const already = new AbortController(); already.abort();
    await expect(fetchViaSocket(socketPath, origin, new Request(`${origin}/finite`, { signal: already.signal }))).rejects.toThrow();
    const controller = new AbortController(); const pending = fetchViaSocket(socketPath, origin, `${origin}/wait-abort`, { signal: controller.signal });
    setTimeout(() => controller.abort(), 20); await expect(pending).rejects.toThrow();
  });
  it('finite bytes and Request body are preserved', async() => {
    expect(new Uint8Array(await (await headers('/finite')).arrayBuffer())).toEqual(new Uint8Array([0, 255, 13, 10]));
    const request = new Request(`${origin}/echo`, { method: 'POST', body: 'finite request body' });
    expect(await (await fetchViaSocket(socketPath, origin, request)).text()).toBe('finite request body');
  });
  it('HEAD and null-body statuses produce valid null bodies', async() => {
    expect((await headers('/finite', { method: 'HEAD' })).body).toBeNull();
    for (const status of [204, 205, 304]) { const response = await headers(`/status/${status}`); expect(response.status).toBe(status); expect(response.body).toBeNull(); }
  });
  it('unconsumed response applies backpressure before the finite producer completes', async() => {
    const response = await headers('/backpressure');
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(produced).toBeLessThan(64);
    const bytes = new Uint8Array(await response.arrayBuffer());
    expect(bytes.byteLength).toBe(64 * 65536); expect(bytes.every(value => value === 122)).toBe(true);
  });
  it('HTTP error bodies remain readable', async() => {
    const response = await headers('/denied'); expect(response.status).toBe(403); expect(await response.text()).toBe('permission denied');
  });
  it('global shim preserves normal fetch for an unregistered origin', async() => {
    const ordinary = createServer((_request, response) => response.end('ordinary fetch'));
    await new Promise<void>(resolve => ordinary.listen(0, '127.0.0.1', resolve));
    const address = ordinary.address(); if (!address || typeof address === 'string') throw new Error('Missing ordinary listener');
    const release = registerSocketFetchOrigin(origin, socketPath);
    try { expect(await (await fetch(`http://127.0.0.1:${address.port}/finite`)).text()).toBe('ordinary fetch'); }
    finally { await release(); await new Promise<void>((resolve, reject) => ordinary.close(error => error ? reject(error) : resolve())); }
  });
  it('completed, cancelled and aborted response lifetimes remove abort listeners', async() => {
    const controller = new AbortController(); const baseline = getEventListeners(controller.signal, 'abort').length;
    for (let i = 0; i < 3; i += 1) await (await headers('/finite', { signal: controller.signal })).arrayBuffer();
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(baseline);
    const response = await headers('/stream-listeners', { signal: controller.signal });
    await response.body!.cancel(); await closures.get('/stream-listeners');
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(baseline);
  });
  it('an explicit init signal replaces an aborted Request signal, including null', async() => {
    const controller = new AbortController(); controller.abort();
    const request = new Request(`${origin}/finite`, { signal: controller.signal });
    for (const signal of [new AbortController().signal, null]) {
      expect(new Uint8Array(await (await fetchViaSocket(socketPath, origin, request, { signal })).arrayBuffer())).toEqual(new Uint8Array([0, 255, 13, 10]));
    }
  });
  it('abrupt post-header truncation rejects body reads rather than manufacturing EOF', async() => {
    const response = await headers('/truncated'); await expect(response.arrayBuffer()).rejects.toThrow();
  });
});
