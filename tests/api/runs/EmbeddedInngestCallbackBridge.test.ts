import { createServer, request as httpRequest, type Server } from 'node:http';
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { InngestRunExecutionBackend } from '../../../src/api/runs/InngestRunExecutionBackend';
import { EmbeddedInngestService } from '../../../src/api/runs/EmbeddedInngestService';
import { registerInngestRoutes } from '../../../src/api/handlers/InngestHandler';
import type { ApiServer, RouteHandler } from '../../../src/api/ApiServer';
import type { EmbeddedInngestRuntimeConfig } from '../../../src/api/runs/EmbeddedInngestService';

// End-to-end proof for the socket callback repair: the private loopback bridge
// puts the spawned executor's unsigned callback in front of the real
// registerInngestRoutes/dev authorizer over a real Unix socket. The bridge must
// make the API accept it as local (not 401/403); without the signed marker the
// same request over a Unix socket is rejected (see InngestCallbackBoundary).

const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }));

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, spawn: spawnMock };
});

const SECRET = 'bridge-boundary-secret';

function fakeChild(): EventEmitter & {
  stdout: EventEmitter;
  stderr: EventEmitter;
  kill: ReturnType<typeof vi.fn<[signal?: string], boolean>>;
} {
  const child = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter;
    stderr: EventEmitter;
    kill: ReturnType<typeof vi.fn<[signal?: string], boolean>>;
  };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = vi.fn((signal?: string) => {
    child.emit('exit', signal === 'SIGTERM' ? 0 : 1, signal);
    return true;
  });
  return child;
}

function runtimeConfig(functionEndpoint: string): EmbeddedInngestRuntimeConfig {
  return {
    enabled: true,
    durableDelivery: true,
    mode: 'spawn',
    baseUrl: 'http://127.0.0.1:8288',
    eventKey: 'event-key',
    signingKey: 'signing-key',
    functionEndpoint,
  };
}

function buildBackend(): InngestRunExecutionBackend {
  return new InngestRunExecutionBackend({
    source: 'test',
    baseUrl: 'http://127.0.0.1:8288',
    eventKey: 'event-key',
    signingKey: 'signing-key',
    isDev: true,
    durableDelivery: true,
    executeInline: false,
  });
}

const sockets: Array<{ server: Server; dir: string }> = [];
afterEach(async() => {
  for (const { server, dir } of sockets.splice(0)) {
    server.closeAllConnections?.();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
  }
});

async function serveAuthorizerOnSocket(functionEndpoint: string): Promise<string> {
  let captured: RouteHandler | undefined;
  const fakeApiServer = {
    all: (_path: string, handler: RouteHandler) => { captured = handler; },
  } as unknown as ApiServer;
  registerInngestRoutes(fakeApiServer, {
    backend: buildBackend(),
    runtimeConfig: runtimeConfig(functionEndpoint),
    gatewayAdminProxyAuthSecret: SECRET,
  });
  if (!captured) {
    throw new Error('Inngest route was not registered');
  }
  const handler = captured;

  const root = path.join(process.cwd(), '.test-data');
  mkdirSync(root, { recursive: true });
  const dir = mkdtempSync(path.join(root, 'ib-'));
  const socketPath = path.join(dir, 'a.sock');
  const server = createServer((req, res) => handler(req as any, res, {}));
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  sockets.push({ server, dir });
  return socketPath;
}

function postCallback(base: string, headers: Record<string, string> = {}): Promise<number> {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ event: { name: 'xpod/test/run.requested', data: {} }, events: [] });
    const request = httpRequest(`${base}/api/inngest`, {
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

describe('EmbeddedInngest socket callback bridge vs dev authorizer', () => {
  it('delivers the spawned executor callback through the bridge and is accepted as local', async () => {
    const socketPath = await serveAuthorizerOnSocket('http://127.0.0.1:1/api/inngest');
    spawnMock.mockReturnValueOnce(fakeChild());
    const service = new EmbeddedInngestService({
      edition: 'local',
      apiBaseUrl: 'http://localhost/',
      databaseUrl: 'sqlite::memory:',
      socketPath,
      gatewayAdminProxyAuthSecret: SECRET,
      mode: 'spawn',
      binaryPath: 'node',
      baseUrl: 'http://127.0.0.1:8288',
      eventKey: 'event-key',
      signingKey: 'signing-key',
    });

    try {
      const config = await service.start();
      const endpoint = new URL(config.functionEndpoint!);
      expect(endpoint.pathname).toBe('/api/inngest');

      const status = await postCallback(endpoint.origin);
      expect(status).not.toBe(401);
      expect(status).not.toBe(403);
    } finally {
      await service.stop();
    }
  });
});
