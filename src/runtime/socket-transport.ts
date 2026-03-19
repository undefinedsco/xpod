import http from 'node:http';
import https from 'node:https';

const NULL_BODY_STATUS = new Set([101, 103, 204, 205, 304]);

export interface SocketTransportRequest {
  protocol: 'http:' | 'https:';
  socketPath: string;
  path: string;
  method: string;
  headers: Record<string, string>;
  body?: Buffer;
  signal?: AbortSignal;
}

export interface SocketTransportResponse {
  status: number;
  statusText: string;
  headers: Headers;
  body?: Buffer;
}

export async function requestViaSocket(request: SocketTransportRequest): Promise<SocketTransportResponse> {
  return await new Promise<SocketTransportResponse>((resolve, reject) => {
    const requester = request.protocol === 'https:' ? https : http;
    const req = requester.request({
      protocol: request.protocol,
      socketPath: request.socketPath,
      path: request.path,
      method: request.method,
      headers: request.headers,
    }, (res) => {
      const chunks: Buffer[] = [];

      res.on('data', (chunk) => {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      });
      res.on('end', () => {
        cleanupAbort();

        const responseHeaders = new Headers();
        for (const [key, value] of Object.entries(res.headers)) {
          if (Array.isArray(value)) {
            for (const item of value) {
              responseHeaders.append(key, item);
            }
            continue;
          }
          if (value !== undefined) {
            responseHeaders.set(key, String(value));
          }
        }

        const status = res.statusCode ?? 500;
        resolve({
          status,
          statusText: res.statusMessage ?? '',
          headers: responseHeaders,
          body: NULL_BODY_STATUS.has(status) ? undefined : Buffer.concat(chunks),
        });
      });
      res.on('error', (error) => {
        cleanupAbort();
        reject(error);
      });
    });

    const abortSignal = request.signal;
    const abortError = (): Error => {
      const reason = abortSignal?.reason;
      return reason instanceof Error ? reason : new Error(String(reason ?? 'Aborted'));
    };
    const abortHandler = (): void => {
      const error = abortError();
      req.destroy(error);
      reject(error);
    };
    const cleanupAbort = (): void => abortSignal?.removeEventListener('abort', abortHandler);

    if (abortSignal?.aborted) {
      abortHandler();
      return;
    }

    abortSignal?.addEventListener('abort', abortHandler, { once: true });
    req.on('error', (error) => {
      cleanupAbort();
      reject(error);
    });

    if (request.body && request.method !== 'GET' && request.method !== 'HEAD') {
      req.write(request.body);
    }
    req.end();
  });
}
