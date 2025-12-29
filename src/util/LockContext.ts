import { AsyncLocalStorage } from 'node:async_hooks';

export type LockState = Map<string, number>;

export const lockContext = new AsyncLocalStorage<LockState>();
