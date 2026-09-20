import net from 'node:net';
import os from 'node:os';

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

export async function getFreePort(basePort: number, host = '127.0.0.1', timeoutMs = PORT_PROBE_TIMEOUT_MS): Promise<number> {
  for (let port = basePort; port <= HIGHEST_PORT; port++) {
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
  return await new Promise<number>((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(port);
      });
    });
  });
}

function hasIpv6Address(): boolean {
  return Object.values(os.networkInterfaces()).some(
    (entries) => entries?.some((entry) => entry.family === 'IPv6'),
  );
}

/**
 * Allocates a port for child services that bind wildcard addresses.
 * CSS may bind `::` while the API binds `0.0.0.0`, so probing only localhost
 * can miss an occupied port on the other address family.
 */
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
  if (!await canListen(port, '0.0.0.0', timeoutMs)) {
    throw new Error(`ingress port ${port} is already in use; free it or point the tunnel at another port`);
  }
  if (hasIpv6Address() && !await canListen(port, '::', timeoutMs)) {
    throw new Error(`ingress port ${port} is already in use on IPv6; free it or point the tunnel at another port`);
  }
  return port;
}

export async function getFreePortForWildcard(basePort: number, timeoutMs = PORT_PROBE_TIMEOUT_MS): Promise<number> {
  const probeIpv6 = hasIpv6Address();
  for (let port = basePort; port <= HIGHEST_PORT; port++) {
    if (!await canListen(port, '0.0.0.0', timeoutMs)) {
      continue;
    }
    if (probeIpv6 && !await canListen(port, '::', timeoutMs)) {
      continue;
    }
    return port;
  }

  throw new Error(`No open port available from 0.0.0.0:${basePort} to 0.0.0.0:${HIGHEST_PORT}`);
}
