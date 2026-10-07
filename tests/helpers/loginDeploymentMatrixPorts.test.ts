import net from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { getFreePort, getFreePortForWildcard } from '../../src/runtime/port-finder';
import { XpodTestStack } from './XpodTestStack';

/**
 * A port that is free on IPv4 can still be owned by another process on `[::]`: platforms may
 * let a wildcard bind and a specific-address bind sit on the same port. An IPv4-only probe then
 * hands that port to a login-matrix deployment, and requests to it (including the
 * `/service/status` readiness gate) are answered by the foreign process instead of ours.
 * These regressions use real listeners - not mocked probes - to lock the isolation boundary.
 */
const handles: net.Server[] = [];

describe('login deployment port isolation', () => {
  afterEach(async() => {
    for (const server of handles.splice(0)) {
      await closeServer(server);
    }
  });

  it('shows an IPv4-only probe claiming a port owned on the IPv6 wildcard', async() => {
    const { port } = await listenIpv6Only();

    // The old selection surface: free on 127.0.0.1, yet already taken on `[::]`.
    await expect(getFreePort(port, '127.0.0.1')).resolves.toBe(port);

    // This is why the collision is fatal: `localhost` dials the competitor, not our service.
    await expect(canConnect('::1', port)).resolves.toBe(true);
    await expect(canConnect('127.0.0.1', port)).resolves.toBe(false);
  });

  it('skips the competing port and returns one free on both address families', async() => {
    const { port } = await listenIpv6Only();

    const chosen = await getFreePortForWildcard(port);

    expect(chosen).not.toBe(port);
    expect(chosen).toBeGreaterThan(port);
    await expect(bindAndRelease(chosen, '0.0.0.0')).resolves.toBeUndefined();
    await expect(bindAndRelease(chosen, '::')).resolves.toBeUndefined();
  });

  it('does not plan a port another process holds on concrete loopback IPv4', async() => {
    const { port } = await listenIpv4Loopback();

    // Wildcard and specific-address binds may coexist on a port, so the wildcard probes alone
    // report this port as free even though a loopback child cannot bind it.
    await expect(bindAndRelease(port, '127.0.0.1')).rejects.toThrow(/EADDRINUSE/u);

    const chosen = await getFreePortForWildcard(port);

    expect(chosen).not.toBe(port);
    expect(chosen).toBeGreaterThan(port);
    await expect(bindAndRelease(chosen, '127.0.0.1')).resolves.toBeUndefined();
  });

  it('never plans an internal port that a process owns on the IPv6 wildcard', async() => {
    const { port } = await openIpv6OnlyListenerWithFreeNeighbour();
    const stack = new XpodTestStack();

    // The gateway is pinned (as the login matrix pins it); the internal CSS/API ports are
    // planned by the stack itself, and the CSS port would previously be the IPv6-owned port.
    const plan = await stack.resolvePortOptions({ gatewayPort: port - 1 });

    expect(plan.gatewayPort).toBe(port - 1);
    expect(plan.cssPort).not.toBe(port);
    expect(plan.apiPort).not.toBe(port);
    expect(plan.cssPort!).toBeGreaterThan(port);
    expect(plan.apiPort!).toBeGreaterThan(port);
    expect(new Set([ plan.gatewayPort, plan.cssPort, plan.apiPort ]).size).toBe(3);
    expect(plan.baseUrl).toBe(`http://localhost:${plan.gatewayPort}/`);
  });
});

/**
 * Opens a real `[::]`-only listener on an ephemeral port whose IPv4-loopback neighbour is
 * free, so a pinned gateway one below it is a valid deployment plan.
 */
async function openIpv6OnlyListenerWithFreeNeighbour(): Promise<{ port: number }> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const { port } = await listenIpv6Only();
    if (await canBind(port - 1, '127.0.0.1')) {
      return { port };
    }
    const server = handles.pop();
    if (server) await closeServer(server);
  }
  throw new Error('could not place an IPv6-only competitor beside a free loopback port');
}

function canBind(port: number, host: string): Promise<boolean> {
  return bindAndRelease(port, host).then(() => true, () => false);
}

function closeServer(server: net.Server): Promise<void> {
  return new Promise((resolve) => {
    server.close(() => resolve());
  });
}

/** A real process holding the port on `[::]` only, as the foreign workspace runtime does. */
async function listenIpv6Only(): Promise<{ server: net.Server; port: number }> {
  const server = net.createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen({ host: '::', port: 0, ipv6Only: true }, () => resolve());
  });
  handles.push(server);
  return { server, port: portOf(server) };
}

/** A real process holding a concrete IPv4 loopback port, as the foreign runtime that failed 39004 did. */
async function listenIpv4Loopback(): Promise<{ server: net.Server; port: number }> {
  const server = net.createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen({ host: '127.0.0.1', port: 0 }, () => resolve());
  });
  handles.push(server);
  return { server, port: portOf(server) };
}

function portOf(server: net.Server): number {
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('listener did not report a port');
  }
  return address.port;
}

function bindAndRelease(port: number, host: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(port, host, () => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  });
}

function canConnect(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    const finish = (value: boolean): void => {
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(1_000);
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
    socket.once('timeout', () => finish(false));
  });
}
