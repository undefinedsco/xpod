import { AsyncResource } from 'node:async_hooks';
import { IncomingMessage } from 'node:http';
import type { Readable } from 'node:stream';
import type { LocalPhysicalOperationService } from './LocalPhysicalOperationService';

/** Observe the owned producer before exposing or piping it. A destroy request is not completion. */
export function observePhysicalStream(stream: Readable): Promise<void> {
  if (stream.closed) { return Promise.resolve(); }
  const read = stream.read;
  const destroy = stream.destroy;
  // Consumer-triggered lazy work re-enters the original genuinely admitted async context.
  stream.read = AsyncResource.bind(read.bind(stream));
  stream.destroy = AsyncResource.bind(destroy.bind(stream));
  return new Promise<void>((resolve) => {
    const closed = (): void => {
      stream.read = read;
      stream.destroy = destroy;
      stream.removeListener('error', failed);
      resolve();
    };
    // Keep the error observed while asynchronous _destroy still owns the producer.
    const failed = (): void => {
      if (!stream.destroyed) { stream.destroy(); }
    };
    stream.once('close', closed);
    stream.on('error', failed);
  });
}

/** Deliver a lazy result promptly while its admitted callback retains the actual producer. */
export function deliverPhysicalResult<T>(
  service: LocalPhysicalOperationService | undefined,
  callback: () => Promise<T>,
  lifetime: (value: T) => Promise<void>,
): Promise<T> {
  if (!service) { return callback(); }
  let delivered = false;
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const result = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  const operation = service.run(async () => {
    try {
      const value = await callback();
      const drained = lifetime(value);
      delivered = true;
      resolve(value);
      await drained;
      await service.awaitRegisteredDrains();
    } catch (error) {
      if (!delivered) { delivered = true; reject(error); }
      await service.awaitRegisteredDrains();
      throw error;
    }
  });
  void operation.catch((error: unknown) => { if (!delivered) { reject(error); } });
  return result;
}

/** Iteration and return execute in the original admission and confirm the original iterator's completion. */
export async function* iteratePhysicalResult<T>(
  service: LocalPhysicalOperationService | undefined,
  factory: () => AsyncIterable<T>,
): AsyncIterableIterator<T> {
  if (!service) { yield* factory(); return; }
  let complete!: () => void;
  const drained = new Promise<void>((resolve) => { complete = resolve; });
  const iterator = await deliverPhysicalResult(service, async () => {
    const source = factory()[Symbol.asyncIterator]();
    const invoke = async (method: 'next' | 'return' | 'throw', argument?: unknown): Promise<IteratorResult<T>> => {
      const call = source[method];
      if (!call) {
        // A missing return cannot confirm cleanup of a partially consumed producer.
        return { done: true, value: undefined };
      }
      const value = await call.call(source, argument as never);
      if (value.done) { complete(); }
      return value;
    };
    const bound: AsyncIterableIterator<T> = {
      next: AsyncResource.bind(() => invoke('next')),
      return: AsyncResource.bind(() => invoke('return')),
      throw: AsyncResource.bind((error: unknown) => invoke('throw', error)),
      [Symbol.asyncIterator](): AsyncIterableIterator<T> { return this; },
    };
    return bound;
  }, () => drained);
  let failed = false;
  try { yield* iterator; }
  catch (error) { failed = true; throw error; }
  finally {
    await iterator.return?.();
    // An external exhausted iterator also waits for its admission to commit; nested callers reuse it.
    if (!failed) { await service.run(() => undefined); }
  }
}

/** Keep a supplied input producer owned across validation, persistence and exceptional cleanup. */
export function runPhysicalOperation<T>(
  service: LocalPhysicalOperationService | undefined,
  callback: () => Promise<T>,
  input?: Readable,
): Promise<T> {
  if (!service) { return callback(); }
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const result = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  const operation = service.run(async () => {
    const drained = input && observePhysicalStream(input);
    if (drained) { service.registerDrain(drained); }
    try { return await callback(); }
    catch (error) { reject(error); throw error; }
    finally {
      if (input && !input.destroyed) {
        // CSS raw bodies are the actual HTTP request: destroy would also tear down its error response.
        if (input instanceof IncomingMessage) { input.resume(); }
        else { input.destroy(); }
      }
      if (drained) { await drained; }
    }
  });
  void operation.then(resolve, reject);
  return result;
}
