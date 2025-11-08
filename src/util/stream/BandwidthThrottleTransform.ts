import { Transform, TransformCallback } from 'node:stream';

export interface BandwidthThrottleTransformOptions {
  bytesPerSecond: number;
  objectMode?: boolean;
  measure?: (chunk: unknown, encoding: BufferEncoding) => number;
}

export class BandwidthThrottleTransform extends Transform {
  private readonly bytesPerSecond: number;
  private readonly measure: (chunk: unknown, encoding: BufferEncoding) => number;
  private nextAvailableTime = Date.now();

  public constructor(options: BandwidthThrottleTransformOptions) {
    super({
      objectMode: options.objectMode ?? false,
      readableObjectMode: options.objectMode ?? false,
      writableObjectMode: options.objectMode ?? false,
    });
    this.bytesPerSecond = options.bytesPerSecond;
    this.measure = options.measure ?? BandwidthThrottleTransform.defaultMeasure;
  }

  public override _transform(chunk: unknown, encoding: BufferEncoding, callback: TransformCallback): void {
    if (this.bytesPerSecond <= 0) {
      callback(null, chunk);
      return;
    }

    const size = this.safeMeasure(chunk, encoding);
    if (size <= 0) {
      callback(null, chunk);
      return;
    }

    const now = Date.now();
    if (this.nextAvailableTime < now) {
      this.nextAvailableTime = now;
    }

    const durationMs = (size / this.bytesPerSecond) * 1000;
    const delay = Math.max(0, this.nextAvailableTime - now);
    this.nextAvailableTime += durationMs;

    if (delay <= 0) {
      callback(null, chunk);
      return;
    }

    setTimeout(() => callback(null, chunk), delay);
  }

  private safeMeasure(chunk: unknown, encoding: BufferEncoding): number {
    try {
      return this.measure(chunk, encoding) ?? 0;
    } catch {
      return 0;
    }
  }

  private static defaultMeasure(chunk: unknown, encoding: BufferEncoding): number {
    if (chunk instanceof Buffer) {
      return chunk.length;
    }
    if (typeof chunk === 'string') {
      return Buffer.byteLength(chunk, encoding);
    }
    return 0;
  }
}
