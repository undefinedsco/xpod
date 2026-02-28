import type { ResultStream } from '@rdfjs/types';

/**
 * Collect a ResultStream into an array.
 * Replaces `(stream as any).toArray()` with a type-safe helper.
 */
export async function arrayFromStream<T>(stream: ResultStream<T>): Promise<T[]> {
  const results: T[] = [];
  for await (const item of stream as any) {
    results.push(item);
  }
  return results;
}
