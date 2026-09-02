import { promises as fs } from 'node:fs';
import { Writable } from 'node:stream';
import { describe, expect, test, vi } from 'vitest';
import { AppStaticAssetHandler } from '../../src/http/AppStaticAssetHandler';

class SlowResponse extends Writable {
  statusCode = 0;

  readonly headers = new Map<string, string | number>();

  writeHead(statusCode: number, headers: Record<string, string | number>): this {
    this.statusCode = statusCode;
    for (const [name, value] of Object.entries(headers)) this.headers.set(name.toLowerCase(), value);
    return this;
  }

  override _write(_chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    setTimeout(callback, 5);
  }
}

describe('AppStaticAssetHandler', () => {
  test('serves built-in UI assets without depending on the asynchronous filesystem pool', async () => {
    const readFile = vi.spyOn(fs, 'readFile').mockImplementation(() => new Promise(() => {}));
    const handler = new AppStaticAssetHandler();
    const response = new SlowResponse();

    try {
      const completed = await Promise.race([
        handler.handle({
          request: { method: 'GET', url: '/app/assets/main.js' },
          response,
        } as never).then(() => true),
        new Promise<false>((resolve) => setTimeout(() => resolve(false), 50)),
      ]);

      expect(completed).toBe(true);
      expect(response.statusCode).toBe(200);
    } finally {
      readFile.mockRestore();
    }
  });

  test('does not resolve a GET until the complete asset response has finished', async () => {
    const handler = new AppStaticAssetHandler();
    const response = new SlowResponse();
    let finished = false;
    response.once('finish', () => {
      finished = true;
    });

    await handler.handle({
      request: { method: 'GET', url: '/app/assets/main.js' },
      response,
    } as never);

    expect(response.statusCode).toBe(200);
    expect(finished).toBe(true);
  });
});
