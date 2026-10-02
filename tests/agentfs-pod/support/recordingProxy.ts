import { createServer, request as httpRequest, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface AccessLogEntry {
  method: string;
  path: string;
  range: string | undefined;
  status: number;
  requestBytes: number;
  responseBytes: number;
}

export interface RecordingProxy {
  origin: string;
  log: AccessLogEntry[];
  reset: () => void;
  close: () => Promise<void>;
}

export async function startRecordingProxy(targetOrigin: string): Promise<RecordingProxy> {
  const target = new URL(targetOrigin);
  const entries: AccessLogEntry[] = [];

  const server: Server = createServer((request, response) => {
    const requestChunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => requestChunks.push(chunk));
    request.on('end', () => {
      const requestBody = Buffer.concat(requestChunks);
      const upstream = httpRequest(
        {
          hostname: target.hostname,
          port: target.port,
          method: request.method,
          path: request.url,
          headers: request.headers,
        },
        (upstreamResponse) => {
          const responseChunks: Buffer[] = [];
          upstreamResponse.on('data', (chunk: Buffer) => responseChunks.push(chunk));
          upstreamResponse.on('end', () => {
            const responseBody = Buffer.concat(responseChunks);
            entries.push({
              method: request.method ?? '',
              path: request.url ?? '',
              range: typeof request.headers.range === 'string' ? request.headers.range : undefined,
              status: upstreamResponse.statusCode ?? 0,
              requestBytes: requestBody.length,
              responseBytes: responseBody.length,
            });
            response.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers);
            response.end(responseBody);
          });
        },
      );
      upstream.on('error', () => {
        response.writeHead(502, { 'content-type': 'text/plain' });
        response.end('recording proxy upstream error');
      });
      upstream.end(requestBody);
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address() as AddressInfo;

  return {
    origin: `http://127.0.0.1:${address.port}`,
    log: entries,
    reset: () => {
      entries.length = 0;
    },
    close: async () => {
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    },
  };
}
