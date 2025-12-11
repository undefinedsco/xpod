import { AsyncLocalStorage } from 'node:async_hooks';

export interface LogContext {
  requestId: string;
}

export const logContext = new AsyncLocalStorage<LogContext>();
