import http from 'node:http';
import { createHash } from 'node:crypto';
import type { EventEmitter } from 'node:events';
import { GatewayProxy } from '../../src/runtime/Proxy';
import { Supervisor } from '../../src/supervisor/Supervisor';

// Keep this fixture independent of authentication, filesystems and UI builds.
const runtimeVersion = process.versions.bun;
if (!runtimeVersion) throw new Error('The proxy response fixture requires Bun.');
const payload = Buffer.from(`/*${'a'.repeat(1_980_650)}*/;globalThis.__proxyPayloadComplete = true;`);
const upstream = http.createServer((request, response) => {
  if (request.url === '/') {
    response.setHeader('Content-Type', 'text/html');
    response.end('<link rel="icon" href="data:,"><script type="module" src="/module.js"></script>');
    return;
  }
  if (request.url !== '/module.js') {
    response.writeHead(404);
    response.end();
    return;
  }
  response.setHeader('Content-Type', 'text/javascript');
  response.setHeader('Content-Length', payload.byteLength);
  response.end(payload);
});
await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
const upstreamPort = (upstream.address() as { port: number }).port;
const gateway = new GatewayProxy(0, new Supervisor(), '127.0.0.1');
gateway.setTargets({ css: `http://127.0.0.1:${upstreamPort}` });

// Test-only observation of the existing proxy event. Hold the JS consumer
// briefly after headers arrive while the native transport receives the body.
// This exercises delivery across event-loop delay, without a mock response.
const proxyEvents = (gateway as unknown as { proxy: EventEmitter }).proxy;
proxyEvents.on('proxyRes', (_response, request: http.IncomingMessage) => {
  if (request.url !== '/module.js') return;
  const until = performance.now() + 50;
  while (performance.now() < until) { /* controlled 50 ms consumer delay */ }
});
await gateway.start();
const gatewayServer = (gateway as unknown as { server: http.Server }).server;
const gatewayPort = (gatewayServer.address() as { port: number }).port;
console.log(`PROXY_RESPONSE_READY ${JSON.stringify({
  baseUrl: `http://127.0.0.1:${gatewayPort}/`,
  runtime: `Bun ${runtimeVersion}`,
  bytes: payload.byteLength,
  sha256: createHash('sha256').update(payload).digest('hex'),
})}`);

let stopping = false;
process.on('SIGTERM', () => {
  if (stopping) return;
  stopping = true;
  void (async () => {
    const timeout = setTimeout(() => process.exit(1), 4_000);
    timeout.unref();
    await gateway.stop();
    await new Promise<void>((resolve, reject) => upstream.close((error) => error ? reject(error) : resolve()));
    clearTimeout(timeout);
    process.exit(0);
  })().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
});
