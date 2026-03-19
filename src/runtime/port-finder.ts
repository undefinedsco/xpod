import net from 'node:net';

const HIGHEST_PORT = 65_535;
const RETRYABLE_PORT_ERRORS = new Set([
  'EACCES',
  'EADDRINUSE',
  'EADDRNOTAVAIL',
  'EPERM',
]);

async function canListen(port: number, host: string): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();

    server.once('error', (error: NodeJS.ErrnoException) => {
      server.close(() => undefined);
      if (error?.code && RETRYABLE_PORT_ERRORS.has(error.code)) {
        resolve(false);
        return;
      }
      reject(error);
    });

    server.once('listening', () => {
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(true);
      });
    });

    server.listen(port, host);
  });
}

export async function getFreePort(basePort: number, host = '127.0.0.1'): Promise<number> {
  for (let port = basePort; port <= HIGHEST_PORT; port++) {
    if (await canListen(port, host)) {
      return port;
    }
  }

  throw new Error(`No open port available from ${host}:${basePort} to ${host}:${HIGHEST_PORT}`);
}
