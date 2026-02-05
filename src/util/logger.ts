/**
 * Simple logger with configurable prefix.
 * Used by xpod main process and subprocesses.
 */

let globalPrefix = '[xpod]';

export function setLogPrefix(prefix: string): void {
  globalPrefix = prefix;
}

export function getLogPrefix(): string {
  return globalPrefix;
}

export const logger = {
  log(...args: unknown[]): void {
    console.log(globalPrefix, ...args);
  },
  info(...args: unknown[]): void {
    console.log(globalPrefix, ...args);
  },
  warn(...args: unknown[]): void {
    console.warn(globalPrefix, ...args);
  },
  error(...args: unknown[]): void {
    console.error(globalPrefix, ...args);
  },
  debug(...args: unknown[]): void {
    if (process.env.DEBUG) {
      console.log(globalPrefix, '[DEBUG]', ...args);
    }
  },
};
