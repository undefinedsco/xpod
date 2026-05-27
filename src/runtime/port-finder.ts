import net from 'node:net';

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
