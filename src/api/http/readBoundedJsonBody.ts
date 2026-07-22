import type { IncomingMessage } from 'node:http';

export type BoundedJsonBodyResult =
  | { ok: true; value: unknown }
  | { ok: false; status: 400 | 413; error: string };

export interface ReadBoundedJsonBodyOptions {
  limitBytes: number;
  onBufferedBytes?: (bytes: number) => void;
}

export function readBoundedJsonBody(
  request: IncomingMessage,
  options: ReadBoundedJsonBodyOptions,
): Promise<BoundedJsonBodyResult> {
  return new Promise((resolve, reject) => {
    let body = '';
    let bytes = 0;
    let settled = false;

    const cleanup = (): void => {
      request.off('data', onData);
      request.off('end', onEnd);
      request.off('error', onError);
    };

    const settle = (result: BoundedJsonBodyResult): void => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      resolve(result);
    };

    function onData(chunk: Buffer | string): void {
      const chunkBytes = Buffer.byteLength(chunk);
      if (bytes + chunkBytes > options.limitBytes) {
        request.pause();
        settle({ ok: false, status: 413, error: 'Request body too large' });
        return;
      }
      bytes += chunkBytes;
      body += chunk;
      options.onBufferedBytes?.(bytes);
    }

    function onEnd(): void {
      if (!body.trim()) {
        settle({ ok: true, value: {} });
        return;
      }
      try {
        settle({ ok: true, value: JSON.parse(body) });
      } catch {
        settle({ ok: false, status: 400, error: 'Request body must be valid JSON' });
      }
    }

    function onError(error: Error): void {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      reject(error);
    }

    request.on('data', onData);
    request.on('end', onEnd);
    request.on('error', onError);
  });
}
