/**
 * Port-allocator regressions for the runtime the product actually serves on.
 *
 * vitest always runs on Node, and the CLI runtime allocates ports through
 * `Bun.listen`, so the allocator's Bun behaviour needs a native `bun test` file:
 *
 *   bun test tests/bun/port-finder.test.ts
 *
 * (also wired into `bun run test:bun:runtime`, which CI runs).
 *
 * These tests use real listeners instead of mocks. BSD sockets keep wildcard and
 * concrete-address binds independent, so binding `0.0.0.0` still succeeds while
 * another process holds `127.0.0.1` on that port. An allocator that probes only
 * the wildcard addresses therefore hands out a port that the runtime's loopback
 * children cannot bind - the login matrix's API child then fails with EADDRINUSE.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import net from 'node:net';
import { getFreePortForWildcard } from '../../src/runtime/port-finder';
import { NodeRuntimeHost } from '../../src/runtime/host/node/NodeRuntimeHost';

const cleanups: Array<() => Promise<void>> = [];

afterAll(async() => {
  for (const cleanup of cleanups.reverse()) {
    await cleanup();
  }
});

/** A real process holding a port, optionally on the IPv6 wildcard only. */
async function holdPort(host: string, ipv6Only = false): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(ipv6Only ? { host, port: 0, ipv6Only: true } : { host, port: 0 }, () => resolve());
  });
  cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));

  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('listener did not report a port');
  }
  return address.port;
}

/** Binds and releases a port, rejecting with the real bind error when it is taken. */
function bindOnce(port: number, host: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(port, host, () => server.close((error) => (error ? reject(error) : resolve())));
  });
}

describe('port allocation under Bun', () => {
  test('skips a port another process holds on concrete loopback IPv4', async() => {
    const occupied = await holdPort('127.0.0.1');

    // The failure this guards: the port is unbound for our loopback child even though the
    // wildcard addresses are still bindable by this process.
    // Bun reports a lost bind as "Failed to listen at <host>" rather than with an errno code.
    await expect(bindOnce(occupied, '127.0.0.1')).rejects.toThrow(/EADDRINUSE|Failed to listen/u);

    const chosen = await getFreePortForWildcard(occupied);

    expect(chosen).not.toBe(occupied);
    expect(chosen > occupied).toBe(true);
    // The port we hand out must be usable by both kinds of listener the runtime starts.
    await expect(bindOnce(chosen, '127.0.0.1')).resolves.toBeUndefined();
    await expect(bindOnce(chosen, '0.0.0.0')).resolves.toBeUndefined();
  });

  test('skips a port another process holds on the IPv6 wildcard', async() => {
    const occupied = await holdPort('::', true);

    await expect(bindOnce(occupied, '::')).rejects.toThrow(/EADDRINUSE|Failed to listen/u);

    const chosen = await getFreePortForWildcard(occupied);

    expect(chosen).not.toBe(occupied);
    expect(chosen > occupied).toBe(true);
    await expect(bindOnce(chosen, '0.0.0.0')).resolves.toBeUndefined();
    await expect(bindOnce(chosen, '::')).resolves.toBeUndefined();
  });
});

describe('two assigned internal ports under an occupied preferred port', () => {
  /**
   * Contract the CLI's two-call allocation depends on: the `excluded` set must be honoured even
   * for a candidate that is NOT bound by the OS. When CSS and the API are allocated in sequence,
   * the CSS port is only *reserved* (the child binds it later, during DI startup), so an API call
   * that forgets it walks forward and hands out the very port CSS already owns - the observed
   * EADDRINUSE restart loop. This asserts the allocator side of that contract; it deliberately
   * does not claim to be the caller regression (that is the real remote unpatched/patched proof).
   */
  test('never returns an excluded candidate that is merely reserved and still unbound', async() => {
    // Two real ports this process owns: the gateway and the client's preferred (occupied) port.
    const mainPort = await holdPort('127.0.0.1');
    const preferred = await holdPort('127.0.0.1');

    // CSS: walk forward past the occupied preferred port, never onto the gateway.
    const css = await getFreePortForWildcard(preferred, undefined, new Set([mainPort]));

    expect(css).not.toBe(preferred);
    expect(css > preferred).toBe(true);
    expect(css).not.toBe(mainPort);

    // The hazard: `css` is reserved but not yet bound, so an allocation that ignores the
    // reservation returns it verbatim. This is exactly what the second call must not do.
    await expect(getFreePortForWildcard(css)).resolves.toBe(css);
    await expect(bindOnce(css, '127.0.0.1')).resolves.toBeUndefined();

    // API: same walk, but now both assigned ports are excluded, so the reserved `css` port is
    // skipped even though nothing listens on it yet.
    const api = await getFreePortForWildcard(css, undefined, new Set([mainPort, css]));

    expect(api).not.toBe(css);
    expect(api).not.toBe(mainPort);
    expect(api).not.toBe(preferred);
    expect(api > css).toBe(true);

    // Both assignments must be genuinely usable by the loopback children the runtime starts.
    await expect(bindOnce(css, '127.0.0.1')).resolves.toBeUndefined();
    await expect(bindOnce(api, '127.0.0.1')).resolves.toBeUndefined();
    await expect(bindOnce(api, '0.0.0.0')).resolves.toBeUndefined();
  });
});

describe('default runtime port planning under Bun', () => {
  /**
   * The default runtime path (`bootstrap` -> `NodeRuntimeHost.allocatePorts`) is what the CLI
   * actually serves on, so its selection rule needs the same native coverage as the utility.
   * `bootstrap` publishes `localhost` for the default `bindHost` 127.0.0.1, and `localhost`
   * dials the competing `[::]` listener, so the plan must skip a port held there.
   */
  test('does not plan the default gateway on a port another process holds on the IPv6 wildcard', async() => {
    const occupied = await holdPort('::', true);

    const plan = await new NodeRuntimeHost().allocatePorts({ basePort: occupied });

    expect(plan.gateway).not.toBe(occupied);
    expect(plan.gateway > occupied).toBe(true);
    // The planned ports still have to be bindable by the loopback children the runtime starts.
    await expect(bindOnce(plan.gateway, '127.0.0.1')).resolves.toBeUndefined();
  });
});
