import { PassThrough, Readable } from 'node:stream';
import { once } from 'node:events';
import type { HttpResponse, MetadataWriter } from '@solid/community-server';
import { describe, expect, it, vi } from 'vitest';
import { HeadSafeResponseWriter } from '../../src/http/HeadSafeResponseWriter';

describe('HeadSafeResponseWriter', () => {
  it.each([200, 401, 403, 404, 500])('does not serialize a HEAD %s body', async (statusCode) => {
    const response = Object.assign(new PassThrough(), {
      req: { method: 'HEAD' }, writeHead: vi.fn(),
    });
    const chunks: Buffer[] = [];
    response.on('data', (chunk) => chunks.push(chunk));
    const finished = once(response, 'finish');
    const data = Readable.from(['error representation']);
    const writer = new HeadSafeResponseWriter({ handleSafe: vi.fn() } as unknown as MetadataWriter);
    await writer.handle({ response: response as unknown as HttpResponse, result: { statusCode, data } });
    await finished;
    expect(response.writeHead).toHaveBeenCalledWith(statusCode);
    expect(Buffer.concat(chunks).length).toBe(0);
    expect(data.destroyed).toBe(true);
  });

  it('preserves GET response streams', async () => {
    const response = Object.assign(new PassThrough(), { req: { method: 'GET' }, writeHead: vi.fn() });
    const chunks: Buffer[] = [];
    response.on('data', (chunk) => chunks.push(chunk));
    const finished = once(response, 'finish');
    const writer = new HeadSafeResponseWriter({ handleSafe: vi.fn() } as unknown as MetadataWriter);
    await writer.handle({ response: response as unknown as HttpResponse, result: { statusCode: 404, data: Readable.from(['missing']) } });
    await finished;
    expect(Buffer.concat(chunks).toString()).toBe('missing');
  });
});
