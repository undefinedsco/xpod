import { AsyncLocalStorage } from 'node:async_hooks';

const directDataRead = new AsyncLocalStorage<boolean>();

/**
 * Internal ResourceStore consumers need data, not browser download redirects.
 * This only selects the read representation; callers must authorize separately.
 */
export function withDirectDataRead<T>(operation: () => T): T {
  return directDataRead.run(true, operation);
}

export function isDirectDataRead(): boolean {
  return directDataRead.getStore() === true;
}
