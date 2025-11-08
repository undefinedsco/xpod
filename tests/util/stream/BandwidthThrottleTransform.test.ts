import { describe, it, expect, vi } from 'vitest';
import { Readable } from 'node:stream';
import { BandwidthThrottleTransform } from '../../../src/util/stream/BandwidthThrottleTransform';

describe('BandwidthThrottleTransform', () => {
  it('在限速下延迟输出数据', async () => {
    vi.useFakeTimers();
    try {
      const throttle = new BandwidthThrottleTransform({ bytesPerSecond: 1 });
      const chunks: Buffer[] = [];
      const completion = new Promise<void>((resolve, reject) => {
        throttle.on('data', (chunk) => {
          chunks.push(Buffer.from(chunk));
        });
        throttle.on('end', resolve);
        throttle.on('error', reject);
      });
      Readable.from([ Buffer.from([ 1, 2 ]) ]).pipe(throttle);

      expect(chunks).toHaveLength(0);
      await vi.advanceTimersByTimeAsync(2000);
      await completion;
      expect(chunks).toHaveLength(1);
      expect(chunks[0]).toEqual(Buffer.from([ 1, 2 ]));
    } finally {
      vi.useRealTimers();
    }
  });

  it('限速为 0 时直通', async () => {
    const throttle = new BandwidthThrottleTransform({ bytesPerSecond: 0 });
    const chunks: Buffer[] = [];
    const completion = new Promise<void>((resolve, reject) => {
      throttle.on('data', (chunk) => {
        chunks.push(Buffer.from(chunk));
      });
      throttle.on('end', resolve);
      throttle.on('error', reject);
    });
    Readable.from([ Buffer.from('hello') ]).pipe(throttle);
    await completion;
    expect(chunks).toHaveLength(1);
    expect(chunks[0].toString()).toBe('hello');
  });
});
