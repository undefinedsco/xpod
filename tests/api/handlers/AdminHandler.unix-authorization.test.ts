import { createServer, request, type OutgoingHttpHeaders, type Server } from 'node:http';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { isAdminMutationAllowed } from '../../../src/api/handlers/AdminHandler';
import type { AuthenticatedRequest } from '../../../src/api/middleware/AuthMiddleware';
import { createGatewayAdminProxyHeaders } from '../../../src/runtime/GatewayAdminProxyAuth';
import { GatewayProxy, getFreePort } from '../../../src/runtime';
import { Supervisor } from '../../../src/supervisor';

describe('Admin authorization over the actual Unix API transport', () => {
  const secret = 'disposable-unix-admin-marker-secret';
  const route = '/api/admin/config';
  let root: string;
  let socketPath: string;
  let api: Server;
  let gateway: GatewayProxy;
  let gatewayPort: number;
  let previousToken: string | undefined;

  beforeAll(async () => {
    previousToken = process.env.XPOD_ADMIN_TOKEN;
    delete process.env.XPOD_ADMIN_TOKEN;
    await mkdir('.test-data', { recursive: true });
    root = await mkdtemp(path.resolve('.test-data/admin-unix-'));
    // Unix socket paths have a small platform limit, so bind relative to cwd.
    socketPath = path.relative(process.cwd(), path.join(root, 'api.sock'));
    api = createServer((req, res) => {
      res.statusCode = isAdminMutationAllowed(req as AuthenticatedRequest, {
        internalAdminAuthSecret: secret,
        allowLoopback: !req.url?.includes('requireToken=1'),
      }) ? 200 : 403;
      res.end();
    });
    await new Promise<void>((resolve, reject) => {
      api.once('error', reject);
      api.listen(socketPath, resolve);
    });
    gatewayPort = await getFreePort(46700, '127.0.0.1');
    gateway = new GatewayProxy(gatewayPort, new Supervisor(), '127.0.0.1', {
      internalAdminAuthSecret: secret,
      clientRemoteAddressResolver: (req) => String(req.headers['x-test-remote-address'] ?? req.socket.remoteAddress ?? ''),
    });
    gateway.setTargets({ api: { socketPath } });
    await gateway.start();
  });

  afterAll(async () => {
    await gateway?.stop();
    if (api?.listening) {
      await new Promise<void>((resolve, reject) => api.close((error) => error ? reject(error) : resolve()));
    }
    if (root) { await rm(root, { recursive: true, force: true }); }
    if (previousToken === undefined) { delete process.env.XPOD_ADMIN_TOKEN; }
    else { process.env.XPOD_ADMIN_TOKEN = previousToken; }
  });

  it('accepts the Gateway signature for an original loopback client over Unix', async () => {
    expect((await fetch(`http://127.0.0.1:${gatewayPort}${route}`, {
      method: 'PUT', headers: { 'x-test-remote-address': '127.0.0.1' },
    })).status).toBe(200);
  });

  it('rejects a remote client even when it supplies forged loopback evidence', async () => {
    const forged = createGatewayAdminProxyHeaders({ secret, method: 'PUT', url: route, originalClientLoopback: true });
    expect((await fetch(`http://127.0.0.1:${gatewayPort}${route}`, {
      method: 'PUT', headers: { ...stringHeaders(forged), 'x-test-remote-address': '203.0.113.4' },
    })).status).toBe(403);
  });

  it('does not treat an unsigned Unix peer as local authority', async () => {
    expect(await direct()).toBe(403);
  });

  it('rejects bad signatures and valid signatures with remote provenance', async () => {
    expect(await direct(createGatewayAdminProxyHeaders({ secret: 'wrong-secret', method: 'PUT', url: route, originalClientLoopback: true }))).toBe(403);
    expect(await direct(createGatewayAdminProxyHeaders({ secret, method: 'PUT', url: route, originalClientLoopback: false }))).toBe(403);
  });

  it('does not elevate a bearer credential when the caller requires explicit admin authentication', async () => {
    expect(isAdminMutationAllowed({
      headers: { authorization: 'Bearer ordinary-provision-token' },
      socket: { remoteAddress: '127.0.0.1' }, method: 'PUT', url: route,
    } as AuthenticatedRequest, { allowLoopback: false })).toBe(false);
    expect((await fetch(`http://127.0.0.1:${gatewayPort}${route}?requireToken=1`, {
      method: 'PUT', headers: { 'x-test-remote-address': '127.0.0.1', authorization: 'Bearer ordinary-provision-token' },
    })).status).toBe(403);
  });

  it('retains the existing admin-token authority when loopback fallback is disabled', async () => {
    process.env.XPOD_ADMIN_TOKEN = 'disposable-unix-admin-token';
    try {
      expect((await fetch(`http://127.0.0.1:${gatewayPort}${route}?requireToken=1`, {
        method: 'PUT', headers: { 'x-test-remote-address': '203.0.113.4', 'x-xpod-admin-token': 'disposable-unix-admin-token' },
      })).status).toBe(200);
    } finally { delete process.env.XPOD_ADMIN_TOKEN; }
  });

  async function direct(headers: OutgoingHttpHeaders = {}): Promise<number> {
    return new Promise((resolve, reject) => {
      const req = request({ socketPath, path: route, method: 'PUT', headers }, (res) => {
        res.resume();
        res.once('end', () => resolve(res.statusCode!));
      });
      req.once('error', reject);
      req.end();
    });
  }

  function stringHeaders(headers: OutgoingHttpHeaders): Record<string, string> {
    const result: Record<string, string> = {};
    for (const [name, value] of Object.entries(headers)) {
      if (typeof value === 'string') { result[name] = value; }
      else if (value !== undefined) { throw new Error(`Unexpected signed header type: ${name}`); }
    }
    return result;
  }
});
