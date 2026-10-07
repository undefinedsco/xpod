import http from 'node:http';
import https from 'node:https';
import { Readable } from 'node:stream';

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
  body?: ReadableStream<Uint8Array>;
}

export async function requestViaSocket(request: SocketTransportRequest): Promise<SocketTransportResponse> {
  return await new Promise<SocketTransportResponse>((resolve, reject) => {
    const abortSignal = request.signal;
    const abortError = (): Error => {
      const reason = abortSignal?.reason;
      return reason instanceof Error ? reason : new Error(String(reason ?? 'Aborted'));
    };
    if (abortSignal?.aborted) { reject(abortError()); return; }

    let response: http.IncomingMessage | undefined;
    const cleanupAbort = (): void => abortSignal?.removeEventListener('abort', abortHandler);
    const requester = request.protocol === 'https:' ? https : http;
    const req = requester.request({
      protocol: request.protocol,
      socketPath: request.socketPath,
      path: request.path,
      method: request.method,
      headers: request.headers,
    }, (res) => {
      response = res;
      res.once('end', cleanupAbort);
      res.once('error', cleanupAbort);
      res.once('close', cleanupAbort);
      const responseHeaders = new Headers();
      for (const [key, value] of Object.entries(res.headers)) {
        if (Array.isArray(value)) {
          for (const item of value) responseHeaders.append(key, item);
        } else if (value !== undefined) responseHeaders.set(key, String(value));
      }
      const status = res.statusCode ?? 500;
      const nullBody = request.method.toUpperCase() === 'HEAD' || NULL_BODY_STATUS.has(status);
      // Bridge the original producer: byte-based queue bounds, cancellation and premature-close errors.
      const body = nullBody ? undefined : Readable.toWeb(res, {
        strategy: { highWaterMark: res.readableHighWaterMark, size: chunk => chunk.byteLength },
      }) as ReadableStream<Uint8Array>;
      if (nullBody) res.resume();
      resolve({ status, statusText: res.statusMessage ?? '', headers: responseHeaders, body });
    });
    const abortHandler = (): void => {
      const error = abortError();
      response?.destroy(error);
      req.destroy(error);
      cleanupAbort();
      reject(error);
    };
    req.on('error', (error) => {
      response?.destroy(error);
      cleanupAbort();
      reject(error);
    });
    abortSignal?.addEventListener('abort', abortHandler, { once: true });
    if (abortSignal?.aborted) { abortHandler(); return; }
    if (request.body && request.method !== 'GET' && request.method !== 'HEAD') req.write(request.body);
    req.end();
  });
}
