import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import http from 'node:http';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import { EmbeddedInngestService } from '../../src/api/runs/EmbeddedInngestService';
import { verifyGatewayAdminProxyHeaders } from '../../src/runtime/GatewayAdminProxyAuth';
import { nodeRuntimeHost } from '../../src/runtime/host/node/NodeRuntimeHost';

const { spawnMock } = vi.hoisted(() => ({
  spawnMock: vi.fn(),
}));

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    spawn: spawnMock,
  };
});

const GATEWAY_SECRET = 'test-gateway-marker-secret';

// Top-level reset: every describe in this file depends on a clean spawn mock.
// A describe-scoped hook would let `mockReturnValueOnce` queues spill between
// groups and mismatch which child a start actually owns.
beforeEach(() => {
  spawnMock.mockReset();
});

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

interface RecordedCallback {
  method: string | undefined;
  url: string | undefined;
  headers: http.IncomingHttpHeaders;
  body: string;
}

/** A real HTTP server on a Unix socket standing in for the API listener. */
async function startSocketApi(): Promise<{
  socketPath: string;
  requests: RecordedCallback[];
  close: () => Promise<void>;
}> {
  const root = path.join(process.cwd(), '.test-data');
  mkdirSync(root, { recursive: true });
  const dir = mkdtempSync(path.join(root, 'ib-'));
  const socketPath = path.join(dir, 'a.sock');
  const requests: RecordedCallback[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
    req.on('end', () => {
      requests.push({
        method: req.method,
        url: req.url,
        headers: req.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      });
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ ok: true }));
    });
  });
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  return {
    socketPath,
    requests,
    close: async() => {
      server.closeAllConnections?.();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

function socketService(socketPath: string): EmbeddedInngestService {
  return new EmbeddedInngestService({
    edition: 'local',
    apiBaseUrl: 'http://localhost/',
    databaseUrl: 'sqlite::memory:',
    socketPath,
    gatewayAdminProxyAuthSecret: GATEWAY_SECRET,
    mode: 'spawn',
    binaryPath: 'node',
    baseUrl: 'http://127.0.0.1:8288',
    eventKey: 'event-key',
    signingKey: 'signing-key',
  });
}

describe('EmbeddedInngestService', () => {
  it('reports the owned child and invalidates its status on unexpected exit', async () => {
    const child = Object.assign(fakeChild(), { pid: 4242, exitCode: null, signalCode: null });
    spawnMock.mockReturnValueOnce(child);
    const service = new EmbeddedInngestService({
      edition: 'local', apiBaseUrl: 'http://127.0.0.1:3001',
      databaseUrl: 'sqlite::memory:', mode: 'spawn', binaryPath: 'node',
      baseUrl: 'http://127.0.0.1:8288', eventKey: 'test-event', signingKey: 'test-signing',
    });
    try {
      expect(service.getRuntimeServiceStatuses()).toEqual([{ name: 'inngest', status: 'stopped' }]);
      await service.start();
      expect(service.getRuntimeServiceStatuses()).toEqual([{ name: 'inngest', status: 'running', pid: 4242 }]);
      child.emit('exit', 1, null);
      expect(service.getRuntimeServiceStatuses()).toEqual([{ name: 'inngest', status: 'crashed' }]);
    } finally {
      await service.stop();
    }
    expect(service.getRuntimeServiceStatuses()).toEqual([{ name: 'inngest', status: 'stopped' }]);
  });

  it('stays disabled when cloud Inngest is not configured', async () => {
    const service = new EmbeddedInngestService({
      edition: 'cloud',
      apiBaseUrl: 'https://api.xpod.example',
      databaseUrl: 'postgres://db/xpod',
    });

    const config = await service.start();

    expect(config).toEqual({
      enabled: false,
      durableDelivery: false,
    });
    expect(service.getRuntimeServiceStatuses()).toEqual([{ name: 'inngest', status: 'disabled' }]);
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('stays disabled when local Inngest is not configured', async () => {
    const service = new EmbeddedInngestService({
      edition: 'local',
      apiBaseUrl: 'http://127.0.0.1:3001',
      databaseUrl: 'sqlite:./identity.sqlite',
    });

    const config = await service.start();

    expect(config).toEqual({
      enabled: false,
      durableDelivery: false,
    });
    expect(service.getRuntimeServiceStatuses()).toEqual([{ name: 'inngest', status: 'disabled' }]);
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('uses a deployment-provided cloud Inngest URL without spawning per API replica', async () => {
    const service = new EmbeddedInngestService({
      edition: 'cloud',
      apiBaseUrl: 'https://api.xpod.example',
      databaseUrl: 'postgres://db/xpod',
      redisUrl: 'redis://redis:6379',
      baseUrl: 'http://xpod-inngest:8288',
      eventKey: 'cluster-event-key',
      signingKey: 'cluster-signing-key',
    });

    const config = await service.start();

    expect(config).toEqual({
      enabled: true,
      durableDelivery: true,
      mode: 'managed',
      baseUrl: 'http://xpod-inngest:8288',
      eventKey: 'cluster-event-key',
      signingKey: 'cluster-signing-key',
      functionEndpoint: 'https://api.xpod.example/api/inngest',
    });
    expect(service.getRuntimeServiceStatuses()).toEqual([{ name: 'inngest', status: 'managed' }]);
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('rejects managed cloud Inngest without explicit signing secrets', async () => {
    const service = new EmbeddedInngestService({
      edition: 'cloud',
      apiBaseUrl: 'https://api.xpod.example',
      databaseUrl: 'postgres://db/xpod',
      baseUrl: 'http://xpod-inngest:8288',
    });

    await expect(service.start()).rejects.toThrow('Managed/cloud Inngest requires explicit eventKey and signingKey');
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('spawns local Inngest when explicitly configured for local single-node mode', async () => {
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
    spawnMock.mockReturnValueOnce(child);

    const service = new EmbeddedInngestService({
      edition: 'local',
      apiBaseUrl: 'http://127.0.0.1:3001',
      databaseUrl: 'sqlite:./identity.sqlite',
      mode: 'spawn',
      binaryPath: 'node',
      baseUrl: 'http://127.0.0.1:8288',
      eventKey: 'local-event-key',
      signingKey: 'local-signing-key',
    });

    const started = await service.start();
    expect(started.durableDelivery).toBe(true);
    await service.stop();
    expect(started.durableDelivery).toBe(false);

    expect(started.mode).toBe('spawn');
    expect(spawnMock).toHaveBeenCalledTimes(1);
    const [command, args, options] = spawnMock.mock.calls[0];
    const portIndex = args.indexOf('--port');
    expect(command).toBe('node');
    expect(portIndex).toBeGreaterThan(-1);
    const port = args[portIndex + 1];
    expect(port).toMatch(/^\d+$/);
    expect(args).toEqual([
      'dev',
      '--no-discovery',
      '--host',
      '127.0.0.1',
      '--port',
      port,
      '-u',
      'http://127.0.0.1:3001/api/inngest',
    ]);
    expect(options).toEqual(expect.objectContaining({
      env: expect.objectContaining({
        INNGEST_BASE_URL: 'http://127.0.0.1:8288',
        INNGEST_EVENT_KEY: 'local-event-key',
        INNGEST_SIGNING_KEY: 'local-signing-key',
      }),
    }));
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
  });

  it('keeps local runtime usable without durable delivery when the Inngest CLI wrapper is not installed', async () => {
    const service = new EmbeddedInngestService({
      edition: 'local',
      apiBaseUrl: 'http://127.0.0.1:3001',
      databaseUrl: 'sqlite:./identity.sqlite',
      mode: 'spawn',
      binaryPath: '/not-found/inngest',
      baseUrl: 'http://127.0.0.1:8288',
    });

    const config = await service.start();

    expect(config).toEqual({
      enabled: true,
      durableDelivery: false,
      mode: 'spawn',
      baseUrl: 'http://127.0.0.1:8288',
      eventKey: 'xpod-local-event-key',
      signingKey: '78706f642d6c6f63616c2d7369676e696e672d6b6579',
      functionEndpoint: 'http://127.0.0.1:3001/api/inngest',
    });
    expect(spawnMock).not.toHaveBeenCalled();
  });
});

describe('EmbeddedInngestService socket callback bridge', () => {
  it('derives a loopback callback and forwards the dev callback to the API socket with a local marker', async () => {
    const api = await startSocketApi();
    spawnMock.mockReturnValueOnce(fakeChild());
    const service = socketService(api.socketPath);
    try {
      const config = await service.start();
      expect(config.functionEndpoint).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/api\/inngest$/u);

      const endpoint = new URL(config.functionEndpoint!);
      const response = await fetch(`${endpoint.origin}/api/inngest?probe=1`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ event: { name: 'xpod/test/run.requested' } }),
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ ok: true });

      expect(api.requests).toHaveLength(1);
      const recorded = api.requests[0];
      expect(recorded.method).toBe('POST');
      expect(recorded.url).toBe('/api/inngest?probe=1');
      expect(JSON.parse(recorded.body)).toEqual({ event: { name: 'xpod/test/run.requested' } });

      const marker = verifyGatewayAdminProxyHeaders({
        headers: recorded.headers,
        secret: GATEWAY_SECRET,
        method: 'POST',
        url: '/api/inngest?probe=1',
      });
      expect(marker.present).toBe(true);
      expect(marker.valid).toBe(true);
      expect(marker.originalClientLoopback).toBe(true);
    } finally {
      await service.stop();
      await api.close();
    }
  });

  it('does not expose non-callback API paths through the bridge', async () => {
    const api = await startSocketApi();
    spawnMock.mockReturnValueOnce(fakeChild());
    const service = socketService(api.socketPath);
    try {
      const config = await service.start();
      const origin = new URL(config.functionEndpoint!).origin;

      const response = await fetch(`${origin}/api/tasks`, { method: 'GET' });
      expect(response.status).toBe(404);
      expect(api.requests).toHaveLength(0);
    } finally {
      await service.stop();
      await api.close();
    }
  });

  it('strips an inbound forged marker and re-signs the callback as local', async () => {
    const api = await startSocketApi();
    spawnMock.mockReturnValueOnce(fakeChild());
    const service = socketService(api.socketPath);
    try {
      const config = await service.start();
      const origin = new URL(config.functionEndpoint!).origin;

      await fetch(`${origin}/api/inngest`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-xpod-admin-proxy-loopback': '0',
          'x-xpod-admin-proxy-timestamp': String(Date.now()),
          'x-xpod-admin-proxy-signature': 'forged',
        },
        body: JSON.stringify({ events: [] }),
      });

      const recorded = api.requests[0];
      const marker = verifyGatewayAdminProxyHeaders({
        headers: recorded.headers,
        secret: GATEWAY_SECRET,
        method: 'POST',
        url: '/api/inngest',
      });
      expect(marker.valid).toBe(true);
      expect(marker.originalClientLoopback).toBe(true);
    } finally {
      await service.stop();
      await api.close();
    }
  });

  it('closes the derived callback listener on stop', async () => {
    const api = await startSocketApi();
    spawnMock.mockReturnValueOnce(fakeChild());
    const service = socketService(api.socketPath);
    const config = await service.start();
    const origin = new URL(config.functionEndpoint!).origin;

    await service.stop();
    await api.close();

    await expect(fetch(`${origin}/api/inngest`)).rejects.toThrow();
  });

  it('keeps the public callback endpoint when no socket is configured', async () => {
    spawnMock.mockReturnValueOnce(fakeChild());
    const service = new EmbeddedInngestService({
      edition: 'local',
      apiBaseUrl: 'http://127.0.0.1:3001',
      databaseUrl: 'sqlite::memory:',
      mode: 'spawn',
      binaryPath: 'node',
      baseUrl: 'http://127.0.0.1:8288',
      eventKey: 'event-key',
      signingKey: 'signing-key',
    });

    const config = await service.start();
    await service.stop();

    expect(config.functionEndpoint).toBe('http://127.0.0.1:3001/api/inngest');
  });
});

describe('EmbeddedInngestService lifecycle failures', () => {
  it('fails clearly for socket+spawn without a marker secret instead of advertising an unreachable durable callback', async () => {
    const service = new EmbeddedInngestService({
      edition: 'local',
      apiBaseUrl: 'http://localhost/',
      databaseUrl: 'sqlite::memory:',
      socketPath: path.join(process.cwd(), '.test-data', 'xpod-no-secret.sock'),
      mode: 'spawn',
      binaryPath: 'node',
      baseUrl: 'http://127.0.0.1:8288',
      eventKey: 'event-key',
      signingKey: 'signing-key',
    });

    await expect(service.start()).rejects.toThrow(/requires the Gateway marker secret/u);
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('does not cache an enabled config on a missing-secret failure, so the SAME instance retries and rejects again', async () => {
    const service = new EmbeddedInngestService({
      edition: 'local',
      apiBaseUrl: 'http://localhost/',
      databaseUrl: 'sqlite::memory:',
      socketPath: path.join(process.cwd(), '.test-data', 'xpod-no-secret.sock'),
      mode: 'spawn',
      binaryPath: 'node',
      baseUrl: 'http://127.0.0.1:8288',
      eventKey: 'event-key',
      signingKey: 'signing-key',
    });

    // Regression: the first throw used to leave this.config cached, so a second
    // call returned the stale enabled config instead of retrying.
    await expect(service.start()).rejects.toThrow(/requires the Gateway marker secret/u);
    await expect(service.start()).rejects.toThrow(/requires the Gateway marker secret/u);
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('does not cache on a bridge listen failure: the SAME instance retries and fails again, then succeeds when the host recovers', async () => {
    const api = await startSocketApi();
    let refuse = true;
    const togglingHost = {
      name: 'toggling-host',
      // Preserve the real endpoint the service derived so a recovered start
      // binds a genuine loopback port instead of the privileged port 1.
      createListenEndpoint: (options: { port?: number; host?: string; socketPath?: string }) =>
        nodeRuntimeHost.createListenEndpoint(options),
      listen: async(server: any, endpoint: any) => {
        if (refuse) {
          throw new Error('listen refused');
        }
        // Delegate to the real host once the failure mode is cleared.
        return await nodeRuntimeHost.listen(server, endpoint);
      },
      close: async(server: any, endpoint: any) => {
        return await nodeRuntimeHost.close(server, endpoint);
      },
    };
    const options = {
      edition: 'local' as const,
      apiBaseUrl: 'http://localhost/',
      databaseUrl: 'sqlite::memory:',
      socketPath: api.socketPath,
      gatewayAdminProxyAuthSecret: GATEWAY_SECRET,
      mode: 'spawn' as const,
      binaryPath: 'node',
      baseUrl: 'http://127.0.0.1:8288',
      eventKey: 'event-key',
      signingKey: 'signing-key',
      runtimeHost: togglingHost as any,
    };

    const service = new EmbeddedInngestService(options);
    try {
      await expect(service.start()).rejects.toThrow(/listen refused/u);
      // Same instance, still failing: must reject rather than return a cached config.
      await expect(service.start()).rejects.toThrow(/listen refused/u);

      // Same instance recovers once the host can bind.
      refuse = false;
      spawnMock.mockReturnValueOnce(fakeChild());
      const config = await service.start();
      expect(config.durableDelivery).toBe(true);
      expect(config.functionEndpoint).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/api\/inngest$/u);
    } finally {
      await service.stop();
      await api.close();
    }
  });

  it('invalidates the returned config and closes the bridge when the executor exits unpredictably', async () => {
    const api = await startSocketApi();
    const child = fakeChild();
    spawnMock.mockReturnValueOnce(child);
    const service = socketService(api.socketPath);
    try {
      const config = await service.start();
      expect(config.durableDelivery).toBe(true);
      const origin = new URL(config.functionEndpoint!).origin;

      child.emit('exit', 1, null);
      await new Promise((resolve) => setTimeout(resolve, 20));

      // The exact object handed to consumers must reflect no delivery.
      expect(config.durableDelivery).toBe(false);
      // The dead executor's bridge is closed before the retry.
      await expect(fetch(`${origin}/api/inngest`)).rejects.toThrow();

      // Re-running start on the SAME instance must re-resolve, not hand back a
      // stale config.
      spawnMock.mockReturnValueOnce(fakeChild());
      const restarted = await service.start();
      expect(restarted).not.toBe(config);
      expect(restarted.durableDelivery).toBe(true);
      const restartedOrigin = new URL(restarted.functionEndpoint!).origin;

      const response = await fetch(`${restartedOrigin}/api/inngest`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ events: [] }),
      });
      expect(response.status).toBe(200);
    } finally {
      await service.stop();
      await api.close();
    }
  });

  it('invalidates delivery and closes the bridge even on a clean executor termination (code 0)', async () => {
    const api = await startSocketApi();
    const child = fakeChild();
    spawnMock.mockReturnValueOnce(child);
    const service = socketService(api.socketPath);
    try {
      const config = await service.start();
      expect(config.durableDelivery).toBe(true);
      const origin = new URL(config.functionEndpoint!).origin;

      child.emit('exit', 0, null);
      await new Promise((resolve) => setTimeout(resolve, 20));

      // A clean exit still means no executor: config invalidated, bridge closed.
      expect(config.durableDelivery).toBe(false);
      await expect(fetch(`${origin}/api/inngest`)).rejects.toThrow();

      spawnMock.mockReturnValueOnce(fakeChild());
      const restarted = await service.start();
      expect(restarted.durableDelivery).toBe(true);
    } finally {
      await service.stop();
      await api.close();
    }
  });

  it('invalidates the returned config on an explicit stop', async () => {
    const api = await startSocketApi();
    spawnMock.mockReturnValueOnce(fakeChild());
    const service = socketService(api.socketPath);
    const config = await service.start();
    expect(config.durableDelivery).toBe(true);

    await service.stop();
    await api.close();

    expect(config.durableDelivery).toBe(false);
  });

  it('returns 413 for an oversize callback body without destroying the response socket', async () => {
    const api = await startSocketApi();
    spawnMock.mockReturnValueOnce(fakeChild());
    const service = socketService(api.socketPath);
    try {
      const config = await service.start();
      const origin = new URL(config.functionEndpoint!).origin;

      const response = await fetch(`${origin}/api/inngest`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: 'x'.repeat(26 * 1024 * 1024),
      });
      expect(response.status).toBe(413);
      expect(api.requests).toHaveLength(0);
    } finally {
      await service.stop();
      await api.close();
    }
  });
});
