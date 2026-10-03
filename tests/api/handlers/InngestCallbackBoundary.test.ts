import { createServer, request as httpRequest, type Server } from 'node:http';
import { AddressInfo } from 'node:net';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { InngestRunExecutionBackend } from '../../../src/api/runs/InngestRunExecutionBackend';
import { registerInngestRoutes } from '../../../src/api/handlers/InngestHandler';
import type { ApiServer, RouteHandler } from '../../../src/api/ApiServer';
import type { EmbeddedInngestRuntimeConfig } from '../../../src/api/runs/EmbeddedInngestService';
import { createGatewayAdminProxyHeaders } from '../../../src/runtime/GatewayAdminProxyAuth';

// HTTP-level evidence for the callback boundary the isDev fix depends on.
//
// `registerInngestRoutes` mounts the real `serve()` handler from `inngest/node`
// on a public route. These tests drive that route over real HTTP (no mocked
// serve) to prove the protocol split the fix relies on and the guard that keeps
// the unsigned dev callback local:
//   - managed (mode "managed"): a callback without x-inngest-signature is
//     rejected with 401; signature validation must not be downgraded.
//   - spawn (mode "spawn"): the unsigned callback the spawned `inngest dev`
//     executor sends from loopback is accepted (otherwise the original bug
//     returns), while a Gateway-reported non-loopback caller is rejected 403.
function buildBackend(mode: 'managed' | 'spawn'): InngestRunExecutionBackend {
  return new InngestRunExecutionBackend({
    source: 'test',
    baseUrl: mode === 'spawn' ? 'http://127.0.0.1:8288' : 'http://xpod-inngest:8288',
    eventKey: 'event-key',
    signingKey: 'signing-key',
    isDev: mode === 'spawn',
    durableDelivery: true,
    executeInline: false,
  });
}

function runtimeConfig(mode: 'managed' | 'spawn'): EmbeddedInngestRuntimeConfig {
  return {
    enabled: true,
    durableDelivery: true,
    mode,
    baseUrl: mode === 'spawn' ? 'http://127.0.0.1:8288' : 'http://xpod-inngest:8288',
    eventKey: 'event-key',
    signingKey: 'signing-key',
    functionEndpoint: 'http://localhost:3001/api/inngest',
  };
}

/** Capture the registered route handler and serve it with a real HTTP server. */
function serveRegistered(
  mode: 'managed' | 'spawn',
  secret: string | undefined,
): { server: Server; getHandler: () => RouteHandler } {
  let captured: RouteHandler | undefined;
  const server = {
    all: (_path: string, handler: RouteHandler) => { captured = handler; },
  } as unknown as ApiServer;
  registerInngestRoutes(server, {
    backend: buildBackend(mode),
    runtimeConfig: runtimeConfig(mode),
    gatewayAdminProxyAuthSecret: secret,
  });
  if (!captured) throw new Error('Inngest route was not registered');
  const handler = captured;
  const http = createServer((req, res) => handler(req as any, res, {}));
  return { server: http, getHandler: () => handler };
}

async function withServer<T>(server: Server, run: (base: string) => Promise<T>): Promise<T> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  try {
    return await run(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

async function postCallback(base: string, headers: Record<string, string> = {}): Promise<number> {
  const response = await fetch(`${base}/api/inngest`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify({ event: { name: 'xpod/test/run.requested', data: { runId: 'run_x' } }, events: [] }),
  });
  await response.arrayBuffer();
  return response.status;
}

/** Serve the route over a real Unix domain socket (default non-Windows transport). */
async function withUnixSocket<T>(server: Server, run: (socketPath: string) => Promise<T>): Promise<T> {
  const testRoot = path.join(process.cwd(), '.test-data');
  mkdirSync(testRoot, { recursive: true });
  const dir = mkdtempSync(path.join(testRoot, 'inngest-cb-'));
  const socketPath = path.join(dir, 'api.sock');
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  try {
    return await run(socketPath);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
  }
}

/** POST over the Unix socket; note req.socket.remoteAddress is undefined there. */
function postCallbackOverSocket(socketPath: string, headers: Record<string, string> = {}): Promise<number> {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ event: { name: 'xpod/test/run.requested', data: { runId: 'run_x' } }, events: [] });
    const request = httpRequest({
      socketPath,
      path: '/api/inngest',
      method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), ...headers },
    }, (response) => {
      response.resume();
      response.once('end', () => resolve(response.statusCode ?? 0));
    });
    request.once('error', reject);
    request.end(body);
  });
}

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

const SECRET = 'test-gateway-admin-proxy-secret';

describe('Inngest callback signature boundary (HTTP)', () => {
  it('rejects an unsigned /api/inngest callback in managed mode with 401', async () => {
    const { server } = serveRegistered('managed', SECRET);
    servers.push(server);
    const status = await withServer(server, (base) => postCallback(base));
    expect(status).toBe(401);
  });

  it('rejects a forged callback signature in managed mode with 401', async () => {
    const { server } = serveRegistered('managed', SECRET);
    servers.push(server);
    const status = await withServer(server, (base) => postCallback(base, {
      'x-inngest-signature': `t=${Date.now()}&s=forged`,
    }));
    expect(status).toBe(401);
  });

  it('accepts the unsigned callback the spawned dev executor sends from loopback', async () => {
    const { server } = serveRegistered('spawn', SECRET);
    servers.push(server);
    const status = await withServer(server, (base) => postCallback(base));
    expect(status).not.toBe(401);
    expect(status).not.toBe(403);
  });

  it('rejects a dev callback the Gateway reports came from a non-loopback client', async () => {
    const { server } = serveRegistered('spawn', SECRET);
    servers.push(server);
    const marker = createGatewayAdminProxyHeaders({
      secret: SECRET,
      method: 'POST',
      url: '/api/inngest',
      originalClientLoopback: false,
    });
    const status = await withServer(server, (base) => postCallback(base, marker));
    expect(status).toBe(403);
  });

  it('rejects a dev callback carrying a forged Gateway marker', async () => {
    const { server } = serveRegistered('spawn', SECRET);
    servers.push(server);
    const forged = createGatewayAdminProxyHeaders({
      secret: 'wrong-secret',
      method: 'POST',
      url: '/api/inngest',
      originalClientLoopback: true,
    });
    const status = await withServer(server, (base) => postCallback(base, forged));
    expect(status).toBe(403);
  });

  it('keeps the dev callback accepted when a valid loopback marker is present', async () => {
    const { server } = serveRegistered('spawn', SECRET);
    servers.push(server);
    const marker = createGatewayAdminProxyHeaders({
      secret: SECRET,
      method: 'POST',
      url: '/api/inngest',
      originalClientLoopback: true,
    });
    const status = await withServer(server, (base) => postCallback(base, marker));
    expect(status).not.toBe(403);
  });

  // Default non-Windows transport is a Unix domain socket. There the API sees no
  // TCP peer address (req.socket.remoteAddress is undefined), so the guard must
  // trust the Gateway's signed marker instead of requiring both. This mirrors
  // the existing ConfiguredLoopbackDPoPWebIdExtractor trust model.
  it('accepts the signed local Gateway callback over a Unix domain socket', async () => {
    const { server } = serveRegistered('spawn', SECRET);
    servers.push(server);
    const marker = createGatewayAdminProxyHeaders({
      secret: SECRET,
      method: 'POST',
      url: '/api/inngest',
      originalClientLoopback: true,
    });
    const status = await withUnixSocket(server, (socketPath) => postCallbackOverSocket(socketPath, marker));
    expect(status).not.toBe(403);
    expect(status).not.toBe(401);
  });

  it('rejects a no-marker dev callback over a Unix domain socket', async () => {
    const { server } = serveRegistered('spawn', SECRET);
    servers.push(server);
    const status = await withUnixSocket(server, (socketPath) => postCallbackOverSocket(socketPath));
    expect(status).toBe(403);
  });

  it('rejects a signed non-loopback marker over a Unix domain socket', async () => {
    const { server } = serveRegistered('spawn', SECRET);
    servers.push(server);
    const marker = createGatewayAdminProxyHeaders({
      secret: SECRET,
      method: 'POST',
      url: '/api/inngest',
      originalClientLoopback: false,
    });
    const status = await withUnixSocket(server, (socketPath) => postCallbackOverSocket(socketPath, marker));
    expect(status).toBe(403);
  });

  it('rejects an expired signed loopback marker', async () => {
    const { server } = serveRegistered('spawn', SECRET);
    servers.push(server);
    const marker = createGatewayAdminProxyHeaders({
      secret: SECRET,
      method: 'POST',
      url: '/api/inngest',
      originalClientLoopback: true,
      issuedAt: Date.now() - 10 * 60 * 1000,
    });
    const status = await withServer(server, (base) => postCallback(base, marker));
    expect(status).toBe(403);
  });

  it('rejects a signed marker bound to a different method and path', async () => {
    const { server } = serveRegistered('spawn', SECRET);
    servers.push(server);
    const marker = createGatewayAdminProxyHeaders({
      secret: SECRET,
      method: 'GET',
      url: '/api/other',
      originalClientLoopback: true,
    });
    const status = await withServer(server, (base) => postCallback(base, marker));
    expect(status).toBe(403);
  });
});
