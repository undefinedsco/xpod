import http from 'node:http';
import net from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getFreePort } from '../../src/runtime/port-finder';
import { GatewayProxy } from '../../src/runtime/Proxy';
import { Supervisor } from '../../src/supervisor/Supervisor';

describe('Gateway API capability unavailable', () => {
  let css: http.Server;
  let proxy: GatewayProxy;
  let proxyPort: number;
  const cssRequests: string[] = [];
  const cssUpgrades: string[] = [];

  beforeAll(async () => {
    css = http.createServer((req, res) => {
      cssRequests.push(req.url ?? '');
      res.end(`css:${req.url}`);
    });
    css.on('upgrade', (req, socket) => {
      cssUpgrades.push(req.url ?? '');
      socket.end('HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n');
    });
    await new Promise<void>((resolve) => css.listen(0, '127.0.0.1', resolve));
    const cssPort = (css.address() as import('node:net').AddressInfo).port;
    proxyPort = await getFreePort(46700, '127.0.0.1');
    proxy = new GatewayProxy(proxyPort, new Supervisor(), '127.0.0.1');
    proxy.setTargets({ css: `http://127.0.0.1:${cssPort}` });
    await proxy.start();
  });

  afterAll(async () => {
    await proxy?.stop();
    if (css?.listening) await new Promise<void>((resolve, reject) => css.close(error => error ? reject(error) : resolve()));
  });

  for (const [pathname, host] of [
    ['/anything', 'api.example.test'],
    ['/anything', 'registry.example.test'],
    ['/api/account', 'pod.example.test'],
    ['/v1/models', 'pod.example.test'],
    ['/settings/models', 'pod.example.test'],
    ['/auth/callback?state=owned', 'pod.example.test'],
  ]) {
    it(`refuses ${host}${pathname} without forwarding to CSS`, async () => {
      const before = cssRequests.length;
      const response = await request(pathname, host);
      expect(response.status).toBe(503);
      expect(response.body).toBe('API Service Not Available');
      expect(cssRequests.length).toBe(before);
    });
  }

  it('still forwards ordinary Solid resource requests to CSS', async () => {
    const response = await request('/alice/public/resource', 'pod.example.test');
    expect(response.status).toBe(200);
    expect(response.body).toBe('css:/alice/public/resource');
    expect(cssRequests).toEqual(['/alice/public/resource']);
  });

  for (const [pathname, host] of [
    ['/ws/device', 'pod.example.test'],
    ['/v1/notifications/ws', 'pod.example.test'],
    ['/custom', 'api.example.test'],
    ['/api/events', 'pod.example.test'],
    ['/settings/live', 'pod.example.test'],
  ]) {
    it(`refuses unavailable API upgrade ${host}${pathname} without reaching CSS`, async () => {
      const response = await upgrade(pathname, host);
      expect(response).toMatch(/^HTTP\/1.1 503 /);
      expect(cssUpgrades).toEqual([]);
    });
  }

  it('still forwards a CSS-owned upgrade to CSS', async () => {
    const response = await upgrade('/.notifications/WebSocketChannel2023/probe', 'pod.example.test');
    expect(response).toMatch(/^HTTP\/1.1 101 /);
    expect(cssUpgrades).toEqual(['/.notifications/WebSocketChannel2023/probe']);
  });

  function upgrade(pathname: string, host: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const socket = net.connect(proxyPort, '127.0.0.1');
      let response = '';
      socket.setTimeout(5_000, () => socket.destroy(new Error('upgrade response timed out')));
      socket.on('connect', () => socket.write(`GET ${pathname} HTTP/1.1\r\nHost: ${host}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: b3duZWQtZml4dHVyZQ==\r\n\r\n`));
      socket.on('data', chunk => { response += chunk.toString(); if (response.includes('\r\n\r\n')) { socket.destroy(); resolve(response); } });
      socket.on('error', reject);
      socket.on('end', () => resolve(response));
    });
  }

  function request(pathname: string, host: string): Promise<{ status: number; body: string }> {
    return new Promise((resolve, reject) => {
      const req = http.get({ host: '127.0.0.1', port: proxyPort, path: pathname, headers: { host } }, res => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', chunk => { body += chunk; });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
      });
      req.on('error', reject);
    });
  }
});
