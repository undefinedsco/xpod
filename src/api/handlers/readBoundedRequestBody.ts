import type { IncomingMessage } from 'node:http';
import { MatrixError } from '../matrix/MatrixError';

/** Reject oversize bodies while draining the request, preserving its response socket. */
export function readBoundedRequestBody(request: IncomingMessage, maxBytes: number, message: string): Promise<Buffer[]> {
  return new Promise<Buffer[]>((resolve, reject) => {
    const buffers: Buffer[] = [];
    let bytes = 0;
    const cleanup = (): void => {
      request.removeListener('data', onData);
      request.removeListener('end', onEnd);
      request.removeListener('error', onError);
      request.removeListener('aborted', onAborted);
    };
    const onError = (error: Error): void => { cleanup(); reject(error); };
    const onAborted = (): void => onError(new MatrixError(400, 'M_BAD_JSON', 'Request aborted'));
    const onEnd = (): void => { cleanup(); resolve(buffers); };
    const onData = (chunk: Buffer | string): void => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bytes += buffer.length;
      if (bytes > maxBytes) {
        // Drain without retaining the payload or destroying the response socket.
        cleanup();
        request.resume();
        reject(new MatrixError(413, 'M_TOO_LARGE', message));
        return;
      }
      buffers.push(buffer);
    };
    request.on('data', onData);
    request.once('end', onEnd);
    request.once('error', onError);
    request.once('aborted', onAborted);
  });
}
