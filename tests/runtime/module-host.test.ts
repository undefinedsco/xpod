import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import { NodeRuntimeHost } from '../../src/runtime/host/node/NodeRuntimeHost';
import { ModuleRuntimeStartupError, startModuleRuntime, type ModuleRuntimeHandle } from '../../src/runtime/module-host';
import type { RuntimeModuleDescription } from '../../src/runtime/service-plan';
import type { RuntimeListenableServer, RuntimeListenEndpoint } from '../../src/runtime/host/types';

let directory: string;
beforeAll(() => {
  mkdirSync('.test-data', { recursive: true });
  directory = mkdtempSync(path.resolve('.test-data/module-host-'));
  writeFileSync(path.join(directory, 'child.cjs'), `
const http=require('node:http'),fs=require('node:fs');
const [name,port,record]=process.argv.slice(2);
fs.writeFileSync(record,JSON.stringify({pid:process.pid,name}));
const server=http.createServer((req,res)=>{res.end(name+':'+req.url)});
server.listen(Number(port),'127.0.0.1');
process.once('SIGTERM',()=>server.close(()=>{fs.writeFileSync(record+'.closed','closed');process.exit(0)}));
`);
});
afterAll(() => rmSync(directory, { recursive: true, force: true }));
async function port(): Promise<number> {
  const server = http.createServer();
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const selected = (server.address() as import('node:net').AddressInfo).port;
  await new Promise<void>(resolve => server.close(() => resolve()));
  return selected;
}
async function module(id: 'css' | 'api', suffix: string): Promise<RuntimeModuleDescription> {
  const selected = await port();
  return { id, process: { name: id, command: 'node', args: [path.join(directory, 'child.cjs'), id, String(selected), path.join(directory, suffix + '-' + id)] }, target: { url: `http://127.0.0.1:${selected}` } };
}
function request(selected: number, resource: string, method = 'GET'): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const outgoing = http.request({ host: '127.0.0.1', port: selected, path: resource, method, agent: false }, response => {
      let body = ''; response.on('data', chunk => { body += chunk; });
      response.on('end', () => resolve({ status: response.statusCode!, body }));
    }).on('error', reject);
    outgoing.end();
  });
}
function assertClosed(suffix: string, id: string): void {
  expect(readFileSync(path.join(directory, suffix + '-' + id + '.closed'), 'utf8')).toBe('closed');
  const { pid } = JSON.parse(readFileSync(path.join(directory, suffix + '-' + id), 'utf8'));
  expect(() => process.kill(pid, 0)).toThrow();
}
class DeferredCloseHost extends NodeRuntimeHost {
  release!: () => void;
  calls = 0;
  override close(server: RuntimeListenableServer, endpoint?: RuntimeListenEndpoint): Promise<void> {
    this.calls++;
    return new Promise<void>((resolve, reject) => { this.release = () => { super.close(server, endpoint).then(resolve, reject); }; });
  }
}

describe('admitted module host with real child HTTP listeners', () => {
  it.each([['css'], ['api'], ['css', 'api']] as const)('routes only selected capabilities %j', async (...ids) => {
    const suffix = ids.join('-'); const selected = await port();
    const modules = await Promise.all(ids.map(id => module(id, suffix)));
    const runtime = await startModuleRuntime({ modules, port: selected, bindHost: '127.0.0.1', baseUrl: `http://127.0.0.1:${selected}/`, externalOidcIssuer: 'https://issuer.example/' });
    try {
      expect(runtime.plan.modules.map(item => item.id)).toEqual(ids);
      expect(runtime.supervisor.getAllStatus().map(item => item.name)).toEqual(ids);
      const admitted = new Set<string>(ids);
      for (const [id, resource] of [['css', '/resource'], ['api', '/v1/models']] as const) {
        const response = await request(selected, resource);
        expect(response.status).toBe(admitted.has(id) ? 200 : 503);
        if (admitted.has(id)) expect(response.body).toBe(id + ':' + resource);
      }
      const first = runtime.stop(); expect(runtime.stop()).toBe(first); await first;
      await runtime.closed;
      for (const id of ids) assertClosed(suffix, id);
    } finally { await runtime.stop(); }
  });

  it('cleans real children after Gateway bind fails without closing the foreign listener', async () => {
    const occupied = http.createServer((_, response) => response.end('foreign'));
    await new Promise<void>(resolve => occupied.listen(0, '127.0.0.1', resolve));
    const selected = (occupied.address() as import('node:net').AddressInfo).port;
    try {
      await expect(startModuleRuntime({ modules: [await module('css', 'bind-failure')], port: selected, bindHost: '127.0.0.1', baseUrl: `http://127.0.0.1:${selected}/` })).rejects.toThrow();
      assertClosed('bind-failure', 'css');
      expect((await request(selected, '/')).body).toBe('foreign');
    } finally { await new Promise<void>(resolve => occupied.close(() => resolve())); }
  });

  it('retains a pending strict listener close across timeout and succeeds on retry', async () => {
    class EphemeralCloseHost extends DeferredCloseHost {
      requestedPort?: number;
      assignedPort?: number;
      override async listen(server: RuntimeListenableServer, endpoint: RuntimeListenEndpoint): Promise<void> {
        await super.listen(server, endpoint);
        if (endpoint.type === 'port') {
          this.requestedPort = endpoint.port;
          this.assignedPort = ((server as http.Server).address() as net.AddressInfo).port;
        }
      }
    }
    const host = new EphemeralCloseHost();
    const runtime: ModuleRuntimeHandle = await startModuleRuntime({ modules: [await module('css', 'strict')], port: 0, bindHost: '127.0.0.1', baseUrl: 'http://127.0.0.1:0/', runtimeHost: host });
    try {
      expect(host.requestedPort).toBe(0);
      expect(host.assignedPort).toBeGreaterThan(0);
      const first = runtime.stop(); const concurrent = runtime.stop();
      expect(concurrent).toBe(first);
      const failures = await Promise.allSettled([first, concurrent]);
      expect(failures.every(result => result.status === 'rejected')).toBe(true);
      if (failures[0].status === 'rejected' && failures[1].status === 'rejected') {
        expect(failures[0].reason).toBe(failures[1].reason);
      }
      assertClosed('strict', 'css'); expect(host.calls).toBe(1);
      host.release(); await runtime.stop(); expect(host.calls).toBe(1);
    } finally { host.release(); await runtime.stop(); }
  }, 10_000);

  it.each([false, true])('cleans partial startup after ingress bind failure (deferred close=%s)', async delayed => {
    const foreign = http.createServer((_, response) => response.end('foreign ingress'));
    await new Promise<void>(resolve => foreign.listen(0, '127.0.0.1', resolve));
    const ingress = (foreign.address() as import('node:net').AddressInfo).port;
    const selected = await port(); const suffix = 'ingress-' + delayed;
    const host = delayed ? new DeferredCloseHost() : new NodeRuntimeHost();
    let retained: ModuleRuntimeHandle | undefined;
    try {
      const failure = await startModuleRuntime({ modules: [await module('css', suffix)], port: selected,
        ingressPort: ingress, bindHost: '127.0.0.1', baseUrl: `http://127.0.0.1:${selected}/`, runtimeHost: host })
        .then(() => { throw new Error('Unexpected successful startup'); }, error => error);
      assertClosed(suffix, 'css');
      expect((await request(ingress, '/')).body).toBe('foreign ingress');
      if (host instanceof DeferredCloseHost) {
        expect(failure).toBeInstanceOf(ModuleRuntimeStartupError);
        retained = (failure as ModuleRuntimeStartupError).runtime;
        expect((failure as ModuleRuntimeStartupError).startupError).toBeDefined();
        expect((failure as ModuleRuntimeStartupError).cleanupError).toBeDefined();
        expect(host.calls).toBe(1);
        host.release(); await retained.stop(); expect(host.calls).toBe(1);
      } else {
        expect(failure).toMatchObject({ code: 'EADDRINUSE' });
      }
      await expect(request(selected, '/')).rejects.toThrow();
    } finally {
      if (host instanceof DeferredCloseHost && retained) { host.release(); await retained.stop(); }
      await new Promise<void>(resolve => foreign.close(() => resolve()));
    }
  }, 15_000);

  it('does not lose ownership when rejected close has already fenced the real listener', async () => {
    class RejectedCloseHost extends NodeRuntimeHost {
      calls = 0;
      confirmed = false;
      release = false;
      held!: net.Socket;
      peer!: import('node:stream').Duplex;
      override async listen(server: RuntimeListenableServer, endpoint: RuntimeListenEndpoint): Promise<void> {
        await super.listen(server, endpoint);
        if (endpoint.type !== 'port') throw new Error('Fixture requires a port listener');
        const actual = server as http.Server;
        actual.removeAllListeners('upgrade');
        const upgraded = new Promise<void>(resolve => actual.once('upgrade', (_, socket) => { this.peer = socket; resolve(); }));
        this.held = net.connect(endpoint.port, endpoint.host);
        await new Promise<void>((resolve, reject) => { this.held.once('connect', resolve); this.held.once('error', reject); });
        // The injected host owns a real upgraded connection, whose close confirmation is deferred.
        this.held.write('GET /resource HTTP/1.1\r\nHost: fixture\r\nConnection: Upgrade\r\nUpgrade: fixture\r\n\r\n');
        await upgraded;
      }
      override close(server: RuntimeListenableServer): Promise<void> {
        this.calls++;
        if (this.calls === 1) server.close(() => { this.confirmed = true; });
        expect(server.listening).toBe(false);
        return this.release && this.confirmed ? Promise.resolve() : Promise.reject(new Error('Controlled close confirmation pending'));
      }
    }
    const host = new RejectedCloseHost(); const selected = await port();
    const runtime = await startModuleRuntime({ modules: [await module('css', 'rejected-close')], port: selected,
      bindHost: '127.0.0.1', baseUrl: `http://127.0.0.1:${selected}/`, runtimeHost: host });
    try {
      await expect(runtime.stop()).rejects.toThrow();
      await expect(runtime.stop()).rejects.toThrow();
      expect(host.calls).toBe(2); assertClosed('rejected-close', 'css');
      expect(host.confirmed).toBe(false);
      host.held.destroy(); host.peer.destroy();
      await new Promise(resolve => setTimeout(resolve, 20));
      expect(host.confirmed).toBe(true); host.release = true;
      await runtime.stop(); expect(host.calls).toBe(3);
    } finally { host.held.destroy(); host.peer.destroy(); host.release = true; await runtime.stop(); }
  });

  it('handles real service stop cleanup rejection and retains a retryable runtime', async () => {
    const host = new DeferredCloseHost(); const selected = await port();
    const runtime = await startModuleRuntime({ modules: [await module('css', 'http-stop')], port: selected,
      bindHost: '127.0.0.1', baseUrl: `http://127.0.0.1:${selected}/`, runtimeHost: host });
    try {
      const response = await request(selected, '/service/stop', 'POST');
      expect(response.status).toBe(202);
      expect(JSON.parse(response.body)).toEqual({ accepted: true });
      // Wait for the production bounded close rejection; Vitest also rejects unhandled promises.
      await new Promise(resolve => setTimeout(resolve, 2_600));
      assertClosed('http-stop', 'css'); expect(host.calls).toBe(1);
      host.release(); await runtime.stop(); expect(host.calls).toBe(1);
      await expect(request(selected, '/')).rejects.toThrow();
    } finally { host.release(); await runtime.stop(); }
  }, 10_000);
});
