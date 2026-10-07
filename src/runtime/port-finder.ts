import net from 'node:net';
import os from 'node:os';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { getUnreservedEphemeralPort, reservedPorts } from './port-reservations';

const HIGHEST_PORT = 65_535;
const PORT_PROBE_TIMEOUT_MS = 1_000;
const RETRYABLE_PORT_ERRORS = new Set([
  'EACCES',
  'EADDRINUSE',
  'EADDRNOTAVAIL',
]);

interface BunRuntimeLike {
  listen(options: {
    hostname: string;
    port: number;
    socket: {
      data: () => void;
    };
  }): {
    stop(closeActiveConnections?: boolean): void;
  };
}

function getBunRuntime(): BunRuntimeLike | undefined {
  const bun = (globalThis as typeof globalThis & { Bun?: BunRuntimeLike }).Bun;
  return bun && typeof bun.listen === 'function' ? bun : undefined;
}

function normalizeListenError(error: unknown, host: string, port: number): Error {
  const code = typeof error === 'object' && error && 'code' in error ? String((error as { code?: unknown }).code) : undefined;
  if (code === 'EPERM') {
    return new Error(`Unable to probe port ${host}:${port}; local TCP listen is not permitted in this runtime.`);
  }
  return error instanceof Error ? error : new Error(String(error));
}

async function canListen(port: number, host: string, timeoutMs = PORT_PROBE_TIMEOUT_MS): Promise<boolean> {
  const bun = getBunRuntime();
  if (bun) {
    try {
      const server = bun.listen({
        hostname: host,
        port,
        socket: {
          data: () => undefined,
        },
      });
      server.stop(true);
      return true;
    } catch (error) {
      if (
        typeof error === 'object' &&
        error &&
        'code' in error &&
        RETRYABLE_PORT_ERRORS.has(String((error as { code?: unknown }).code))
      ) {
        return false;
      }
      throw normalizeListenError(error, host, port);
    }
  }

  return new Promise((resolve, reject) => {
    const server = net.createServer();
    let settled = false;

    const finish = (callback: () => void): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      callback();
    };

    const closeServer = (callback: () => void): void => {
      try {
        server.close(() => callback());
      } catch {
        callback();
      }
    };

    const timer = setTimeout(() => {
      finish(() => {
        closeServer(() => {
          reject(new Error(
            `Timed out probing port ${host}:${port}; local TCP listen may be unavailable in this runtime.`,
          ));
        });
      });
    }, timeoutMs);

    timer.unref?.();

    server.once('error', (error: NodeJS.ErrnoException) => {
      finish(() => {
        closeServer(() => {
          if (error?.code && RETRYABLE_PORT_ERRORS.has(error.code)) {
            resolve(false);
            return;
          }
          reject(normalizeListenError(error, host, port));
        });
      });
    });

    server.once('listening', () => {
      finish(() => {
        closeServer(() => {
          resolve(true);
        });
      });
    });

    server.listen(port, host);
  });
}

/**
 * The port a remote tunnel forwards to: the Gateway's tunnel entry.
 *
 * It sits a few ports above the Gateway so it is predictable - the user copies this one number
 * into a provider console and it survives restarts - while staying clear of the block a
 * neighbouring runtime plans for its own services. When the neighbourhood is busy the caller
 * gets an OS-assigned port instead of a stolen one; the runtime reports whichever it got.
 *
 * Reserved ports are skipped here too: a group that needs a fixed port has published a
 * reservation, and a dynamic entry that took it would break that group's tunnel instead of
 * merely moving its own listener.
 */
export async function findGatewayIngressPort(gatewayPort: number, excluded: ReadonlySet<number> = new Set()): Promise<number> {
  for (let offset = 3; offset < 10; offset += 1) {
    const candidate = gatewayPort + offset;
    if (await getFreePortForWildcard(candidate, PORT_PROBE_TIMEOUT_MS, excluded) === candidate) {
      return candidate;
    }
  }
  return await getFreePortForWildcard(await getEphemeralLoopbackPort(), PORT_PROBE_TIMEOUT_MS, excluded);
}

/**
 * The first free port at or above `basePort`.
 *
 * Reserved ports are skipped, not merely avoided by convention: a group that needs a fixed port
 * (the tunnel acceptance's console-owned 5737) publishes a reservation, and every allocator -
 * the runtime, the test helpers, the integration runners - goes around it instead of racing for
 * it. That is the difference between "usually fine" and "cannot collide".
 */
export async function getFreePort(basePort: number, host = '127.0.0.1', timeoutMs = PORT_PROBE_TIMEOUT_MS, excluded: ReadonlySet<number> = new Set()): Promise<number> {
  const reserved = reservedPorts();
  for (let port = basePort; port <= HIGHEST_PORT; port++) {
    if (reserved.has(port) || excluded.has(port)) {
      continue;
    }
    if (await canListen(port, host, timeoutMs)) {
      return port;
    }
  }

  throw new Error(`No open port available from ${host}:${basePort} to ${host}:${HIGHEST_PORT}`);
}

/**
 * Loopback port handed out by the OS for a listener that must not collide with ports the
 * embedding process plans for other services.
 *
 * Probing next to the ports this runtime already owns is not safe: a host that allocates
 * `gateway + 10`/`gateway + 11` (the full integration matrix does) has already reserved
 * the neighbour of our own `api` port for another runtime, and binding it steals that
 * runtime's service.
 */
export async function getEphemeralLoopbackPort(): Promise<number> {
  // One retry rule for "the OS does not know about reservations", shared with the fixtures that
  // bind their own server (`listenOnUnreservedPort`).
  return await getUnreservedEphemeralPort('127.0.0.1');
}

function hasIpv6Address(): boolean {
  return Object.values(os.networkInterfaces()).some(
    (entries) => entries?.some((entry) => entry.family === 'IPv6'),
  );
}

/**
 * Addresses this allocator clears before handing out a port: the wildcard addresses plus the
 * loopback addresses child services use by default (`bindHost` defaults to `127.0.0.1`).
 * Platforms may allow a wildcard bind and a specific-address bind on the same port (this macOS
 * host does, under Node and Bun), so probing one category can report an unusable port as free.
 * A port held on a non-loopback specific address is outside this guarantee: it is not probed.
 */
function serviceProbeHosts(probeIpv6: boolean): string[] {
  return probeIpv6
    ? [ '0.0.0.0', '::', '127.0.0.1', '::1' ]
    : [ '0.0.0.0', '127.0.0.1' ];
}

/** The first address a service may bind that is already taken, if any. */
async function firstOccupiedServiceAddress(port: number, timeoutMs: number, probeIpv6: boolean): Promise<string | undefined> {
  for (const host of serviceProbeHosts(probeIpv6)) {
    if (!await canListen(port, host, timeoutMs)) {
      return host;
    }
  }
  return undefined;
}

/** Tests socket availability on all service addresses, including an explicitly reserved port. */
export async function isFreePortForWildcard(port: number, timeoutMs = PORT_PROBE_TIMEOUT_MS): Promise<boolean> {
  if (!Number.isInteger(port) || port <= 0 || port > HIGHEST_PORT) {
    return false;
  }
  return await firstOccupiedServiceAddress(port, timeoutMs, hasIpv6Address()) === undefined;
}

/**
 * Takes exactly this port or fails.
 *
 * A port that a tunnel console forwards to cannot be substituted: `getFreePortForWildcard`
 * scans upward, which would leave the runtime listening somewhere the tunnel never reaches.
 */
export async function requireFreePortForWildcard(port: number, timeoutMs = PORT_PROBE_TIMEOUT_MS): Promise<number> {
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`ingress port ${port} is not a valid port number`);
  }
  const occupied = await firstOccupiedServiceAddress(port, timeoutMs, hasIpv6Address());
  if (occupied) {
    const family = occupied.includes(':') ? ' on IPv6' : '';
    throw new Error(`ingress port ${port} is already in use${family}; free it or point the tunnel at another port`);
  }
  return port;
}

/**
 * Allocates a port for child services that bind wildcard addresses.
 *
 * CSS may bind `::` while the API binds `0.0.0.0`, so probing only localhost can miss an
 * occupied port on the other address family - and a reserved port is skipped either way.
 */
export async function getFreePortForWildcard(basePort: number, timeoutMs = PORT_PROBE_TIMEOUT_MS, excluded: ReadonlySet<number> = new Set()): Promise<number> {
  const probeIpv6 = hasIpv6Address();
  const reserved = reservedPorts();
  for (let port = basePort; port <= HIGHEST_PORT; port++) {
    if (reserved.has(port) || excluded.has(port)) {
      continue;
    }
    if (await firstOccupiedServiceAddress(port, timeoutMs, probeIpv6)) {
      continue;
    }
    return port;
  }

  throw new Error(`No open port available from 0.0.0.0:${basePort} to 0.0.0.0:${HIGHEST_PORT}`);
}
