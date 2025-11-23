import { Transform } from 'stream';

export interface BandwidthThrottleTransformOptions {
  bytesPerSecond: number;
  objectMode?: boolean;
  measure?: (chunk: unknown, encoding: BufferEncoding) => number;
}

export type BandwidthThrottleTransform = Transform;

export function createBandwidthThrottleTransform(options: BandwidthThrottleTransformOptions): Transform {
  const bytesPerSecond = options.bytesPerSecond;
  const measure = options.measure ?? defaultMeasure;
  let nextAvailableTime = Date.now();

  return new Transform({
    objectMode: options.objectMode ?? false,
    readableObjectMode: options.objectMode ?? false,
    writableObjectMode: options.objectMode ?? false,
    transform(chunk, encoding, callback) {
      if (bytesPerSecond <= 0) {
        callback(null, chunk);
        return;
      }

      const size = safeMeasure(chunk, encoding, measure);
      if (size <= 0) {
        callback(null, chunk);
        return;
      }

      const now = Date.now();
      if (nextAvailableTime < now) {
        nextAvailableTime = now;
      }

      const durationMs = (size / bytesPerSecond) * 1000;
      const delay = Math.max(0, nextAvailableTime - now);
      nextAvailableTime += durationMs;

      if (delay <= 0) {
        callback(null, chunk);
        return;
      }

      setTimeout(() => callback(null, chunk), delay);
    },
  });
}

function safeMeasure(
  chunk: unknown,
  encoding: BufferEncoding,
  measure: (chunk: unknown, encoding: BufferEncoding) => number,
): number {
  try {
    return measure(chunk, encoding) ?? 0;
  } catch {
    return 0;
  }
}

function defaultMeasure(chunk: unknown, encoding: BufferEncoding): number {
  if (chunk instanceof Buffer) {
    return chunk.length;
  }
  if (typeof chunk === 'string') {
    return Buffer.byteLength(chunk, encoding);
  }
  return 0;
}
