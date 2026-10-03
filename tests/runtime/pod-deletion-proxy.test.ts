import http from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { GatewayProxy, getFreePort } from '../../src/runtime';
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
