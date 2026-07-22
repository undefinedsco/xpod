import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';

import { readBoundedJsonBody } from '../../../src/api/http/readBoundedJsonBody';

describe('readBoundedJsonBody', () => {
  it('resolves 413 as soon as a later chunk exceeds the limit without buffering the oversized chunk or following chunks', async () => {
    const request = new PassThrough();
    const bufferedSizes: number[] = [];
    const resultPromise = readBoundedJsonBody(request as any, {
      limitBytes: 8,
      onBufferedBytes: (bytes) => bufferedSizes.push(bytes),
    });

    request.write('{"a"');
    request.write(':1234567890');
    await expect(resultPromise).resolves.toEqual({
      ok: false,
      status: 413,
      error: 'Request body too large',
    });

    request.write(',"after":"must-not-buffer"}');
    request.end();

    expect(bufferedSizes).toEqual([4]);
  });
});
