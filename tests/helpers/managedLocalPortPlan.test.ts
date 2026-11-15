import net from 'node:net';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as runtimeModule from '../../src/runtime/XpodRuntime';
import type { XpodRuntimeHandle, XpodRuntimeOptions } from '../../src/runtime/XpodRuntime';
import { XpodTestStack, type TestPortPlanEnvFactory } from './XpodTestStack';

const servers: net.Server[] = [];
const roots: string[] = [];
const originalSecret = process.env.XPOD_GATEWAY_ADMIN_PROXY_AUTH_SECRET;
async function listen(port = 0): Promise<net.Server> {
  const server = net.createServer();
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolve();
    });
  });
  return server;
}
async function close(server: net.Server): Promise<void> {
  if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
}
const portOf = (server: net.Server): number => (server.address() as net.AddressInfo).port;
const planForIngress = (port: number): Partial<XpodRuntimeOptions> => ({
  gatewayPort: port - 3, cssPort: port - 2, apiPort: port - 1,
  baseUrl: `http://localhost:${port - 3}/`, bindHost: '127.0.0.1',
});
async function ownRoot(): Promise<string> {
  await mkdir('.test-data', { recursive: true });
  const root = await mkdtemp(path.resolve('.test-data/managed-local-port-plan-'));
  roots.push(root);
  return root;
}
function handle(options: XpodRuntimeOptions, stop = async(): Promise<void> => undefined): XpodRuntimeHandle {
  process.env.XPOD_GATEWAY_ADMIN_PROXY_AUTH_SECRET = 'disposable-port-plan-unit-secret';
  return { baseUrl: options.baseUrl, ports: { gateway: options.gatewayPort, api: options.apiPort }, sockets: {},
    fetch: async() => new Response('{}'), stop } as unknown as XpodRuntimeHandle;
}
afterEach(async() => {
  vi.restoreAllMocks();
  for (const server of servers.splice(0)) await close(server);
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
  if (originalSecret === undefined) delete process.env.XPOD_GATEWAY_ADMIN_PROXY_AUTH_SECRET;
  else process.env.XPOD_GATEWAY_ADMIN_PROXY_AUTH_SECRET = originalSecret;
});

describe('managed Local canonical URL follows the locked retry plan', () => {
  it('recomputes the public URL after a real additional-listener EADDRINUSE', async() => {
    const root = await ownRoot(), lock = path.join(root, 'start.lock');
    const competitor = await listen(), occupied = portOf(competitor);
    const reservation = await listen(), free = portOf(reservation);
    await close(reservation);
    const stack = new XpodTestStack(lock);
    const plans = vi.spyOn(stack, 'resolvePortOptions')
      .mockResolvedValueOnce(planForIngress(occupied)).mockResolvedValueOnce(planForIngress(free));
    const starts: XpodRuntimeOptions[] = [];
    const start = vi.spyOn(runtimeModule, 'startXpodRuntime').mockImplementation(async(options = {}) => {
      starts.push(options);
      // Actual loopback bind error, while runtime startup itself remains a unit double.
      const ingress = await listen(options.gatewayPort! + 3);
      return handle(options, () => close(ingress));
    });
    const factory: TestPortPlanEnvFactory = vi.fn(plan => {
      expect(existsSync(lock)).toBe(true);
      expect(Object.isFrozen(plan)).toBe(true);
      return { XPOD_PUBLIC_URL: plan.baseUrl, XPOD_PROVISION_CODE: '' };
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await stack.start('local', {
      transport: 'port', runtimeRoot: path.join(root, 'runtime'),
      env: { XPOD_PUBLIC_URL: 'https://stale.example/', SOLID_OIDC_ISSUER: 'https://cloud.example/' },
    }, factory);
    expect(start).toHaveBeenCalledTimes(2);
    expect(plans).toHaveBeenCalledTimes(2);
    expect(factory).toHaveBeenCalledTimes(2);
    expect(starts.map(options => options.env?.XPOD_PUBLIC_URL)).toEqual(starts.map(options => options.baseUrl));
    expect(starts[0].env?.XPOD_PUBLIC_URL).not.toBe(starts[1].env?.XPOD_PUBLIC_URL);
    expect(starts.every(options => options.env?.XPOD_PROVISION_CODE === '')).toBe(true);
    expect(starts.every(options => options.env?.SOLID_OIDC_ISSUER === 'https://cloud.example/')).toBe(true);
    expect(stack.baseUrl).toBe(starts[1].env?.XPOD_PUBLIC_URL);
    expect(warn).toHaveBeenCalledWith('[XpodTestStack] port-conflict retry', JSON.stringify({
      attempt: 1, maxAttempts: 3, code: 'EADDRINUSE', syscall: 'listen', address: '127.0.0.1', port: occupied,
    }));
    await stack.stop();
  });

  it('keeps explicitly pinned ports at one attempt even with an environment factory', async() => {
    const root = await ownRoot(), lock = path.join(root, 'start.lock');
    const competitor = await listen(), occupied = portOf(competitor), plan = planForIngress(occupied);
    const stack = new XpodTestStack(lock);
    const plans = vi.spyOn(stack, 'resolvePortOptions').mockResolvedValue(plan);
    const factory: TestPortPlanEnvFactory = vi.fn(plan => ({ XPOD_PUBLIC_URL: plan.baseUrl }));
    const start = vi.spyOn(runtimeModule, 'startXpodRuntime').mockImplementation(async() => {
      await listen(occupied);
      throw new Error('occupied listener unexpectedly bound');
    });
    await expect(stack.start('local', { transport: 'port', gatewayPort: plan.gatewayPort }, factory)).rejects.toMatchObject({ code: 'EADDRINUSE', port: occupied });
    expect(start).toHaveBeenCalledTimes(1);
    expect(plans).toHaveBeenCalledTimes(1);
    expect(factory).toHaveBeenCalledTimes(1);
  });

  it('preserves the existing fixed environment when no plan factory is supplied', async() => {
    const root = await ownRoot(), stack = new XpodTestStack(path.join(root, 'start.lock'));
    vi.spyOn(stack, 'resolvePortOptions').mockResolvedValue(planForIngress(22004));
    const start = vi.spyOn(runtimeModule, 'startXpodRuntime').mockImplementation(async(options = {}) => handle(options));
    await stack.start('local', { transport: 'port', env: { XPOD_PUBLIC_URL: 'https://fixed.example/' } });
    expect(start.mock.calls[0][0]?.env?.XPOD_PUBLIC_URL).toBe('https://fixed.example/');
    expect(start.mock.calls[0][0]?.baseUrl).toBe('http://localhost:22001/');
    await stack.stop();
  });
});
