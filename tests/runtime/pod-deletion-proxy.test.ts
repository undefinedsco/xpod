import http from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { GatewayProxy, getFreePort } from '../../src/runtime';
import { isPortConflict } from '../helpers/testRuntime';
import { NodeRuntimeHost } from '../../src/runtime/host/node/NodeRuntimeHost';
import { Supervisor } from '../../src/supervisor/Supervisor';

describe('Pod deletion gateway ownership', () => {
  let css: http.Server;
  let api: http.Server;
  let gateway: GatewayProxy;
  let root: string;
  beforeAll(async () => {
    const cssPort = await getFreePort(46500, '127.0.0.1');
    const apiPort = await getFreePort(cssPort + 1, '127.0.0.1');
    const gatewayPort = await getFreePort(apiPort + 1, '127.0.0.1');
    const listen = async (port: number, label: string): Promise<http.Server> => {
      const server = http.createServer((_request, response) => { response.end(label); });
      await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve));
      return server;
    };
    css = await listen(cssPort, 'css'); api = await listen(apiPort, 'api');
    gateway = new GatewayProxy(gatewayPort, new Supervisor(), '127.0.0.1', { baseUrl: 'https://node.test/' });
    gateway.setTargets({ css: `http://127.0.0.1:${cssPort}`, api: `http://127.0.0.1:${apiPort}` });
    await gateway.start(); root = `http://127.0.0.1:${gatewayPort}`;
  });
  afterAll(async () => {
    await gateway.stop();
    await Promise.all([css, api].map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  });
  it.each(['node.test', 'api.node.test'])('routes DELETE to CSS on %s, preserving provisioning GET/POST', async (host) => {
    const headers = { host };
    expect(await (await fetch(`${root}/provision/pods/alice?retry=1`, { method: 'DELETE', headers })).text()).toBe('css');
    expect(await (await fetch(`${root}/provision/pods/alice`, { headers })).text()).toBe('api');
    expect(await (await fetch(`${root}/provision/pods`, { method: 'POST', headers })).text()).toBe('api');
    expect(await (await fetch(`${root}/api/pod-deletions/op/claim`, { method: 'POST', headers })).text()).toBe('api');
  });
});


describe('Gateway startup listener ownership', () => {
  it.each([ false, true ])('closes its main listener and retains startup/cleanup facts after a foreign ingress rejection (cleanup error=%s)', async (cleanupErrorInjected) => {
    const foreign = http.createServer((_request, response) => response.end('foreign-owned'));
    await new Promise<void>((resolve) => foreign.listen(0, '127.0.0.1', resolve));
    const foreignAddress = foreign.address();
    if (!foreignAddress || typeof foreignAddress === 'string') throw new Error('Missing foreign listener identity');
    const host = new NodeRuntimeHost(); const listen = host.listen.bind(host);
    let mainPort: number | undefined;
    host.listen = async (server, endpoint) => {
      await listen(server, endpoint);
      const address = (server as http.Server).address();
      if (endpoint.type === 'port' && endpoint.port === 0 && address && typeof address !== 'string') mainPort = address.port;
    };
    const cleanupFailure = new Error('owned close observation failed');
    if (cleanupErrorInjected) {
      const close = host.close.bind(host);
      host.close = async (server, endpoint, options) => {
        await close(server, endpoint, options);
        throw cleanupFailure;
      };
    }
    const gateway = new GatewayProxy(0, new Supervisor(), '127.0.0.1', { runtimeHost: host, ingressPort: foreignAddress.port });
    const rebound = http.createServer((_request, response) => response.end('rebound-owned'));
    try {
      let startupError: unknown;
      try { await gateway.start(); } catch (error) { startupError = error; }
      if (cleanupErrorInjected) {
        expect(startupError).toBeInstanceOf(AggregateError);
        const errors = (startupError as AggregateError).errors;
        expect(errors[0]).toMatchObject({ code: 'EADDRINUSE', port: foreignAddress.port });
        expect(errors[1]).toBe(cleanupFailure);
        expect(isPortConflict(startupError), 'unknown cleanup must not enter a port retry').toBe(false);
      } else {
        expect(startupError).toMatchObject({ code: 'EADDRINUSE', port: foreignAddress.port });
        expect(isPortConflict(startupError)).toBe(true);
      }
      expect(mainPort, 'the real main listener bound before ingress failed').toBeGreaterThan(0);
      expect(foreign.listening).toBe(true);
      expect(await (await fetch(`http://127.0.0.1:${foreignAddress.port}/`, { signal: AbortSignal.timeout(2000) })).text()).toBe('foreign-owned');
      await new Promise<void>((resolve, reject) => {
        rebound.once('error', reject);
        rebound.listen(mainPort, '127.0.0.1', resolve);
      });
      expect(await (await fetch(`http://127.0.0.1:${mainPort}/`, { signal: AbortSignal.timeout(2000) })).text()).toBe('rebound-owned');
      expect(foreign.listening).toBe(true);
    } finally {
      // The red regression's old stop closes the main listener before rejecting
      // ERR_SERVER_NOT_RUNNING for the ingress that never bound. Keep that red
      // error from masking the actual main-port rebind assertion.
      await gateway.stop().catch((error: NodeJS.ErrnoException) => { if (error.code !== 'ERR_SERVER_NOT_RUNNING') throw error; });
      await Promise.all([ rebound, foreign ].filter((server) => server.listening).map((server) =>
        new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))));
    }
  });
});
