import { mkdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import type { XpodRuntimeHandle, XpodRuntimeOptions } from '../../src/runtime/XpodRuntime';

/** Where test processes coordinate who may probe ports right now. */
const START_LOCK_DIR = path.join(process.cwd(), '.test-data', 'runtime-start.lock');
/** A started process that died holding the lock must not block the suite forever. */
const STALE_LOCK_MS = 5 * 60_000;
const LOCK_WAIT_TIMEOUT_MS = 5 * 60_000;

/**
 * Which start failures mean "somebody else probed the same free port first".
 *
 * Port-transport runtimes probe a range and then bind, so two test files that start a runtime at
 * the same time can both be told the same port is free. The loser has to give up that choice and
 * probe again rather than fail the suite. Bun's HTTP server reports the same condition without
 * the errno, as "Failed to start server. Is port NNN in use?", so both phrasings are matched.
 */
export function isPortConflict(error: unknown): boolean {
  const message = error instanceof Error
    ? `${error.message}${error.cause ? ` ${String(error.cause)}` : ''}`
    : String(error);
  return /EADDRINUSE|address already in use|port \d+ in use/iu.test(message);
}

/**
 * Start a real runtime for a test, serialised against every other test process in this workspace.
 *
 * Probing for a free port and binding it cannot be atomic, so the whole start runs under a
 * cross-process lock: while one test holds it, no other test can be told the same ports are free.
 * A lost race is still retried, because a non-test process can take the port in that window, and
 * `startXpodRuntime` closes whatever it did start before rethrowing.
 *
 * Explicitly pinned ports are not retried - the same conflict would repeat.
 */
export async function startTestRuntime(
  start: (options: XpodRuntimeOptions) => Promise<XpodRuntimeHandle>,
  options: XpodRuntimeOptions,
  attempts = 3,
): Promise<XpodRuntimeHandle> {
  const pinned = options.gatewayPort !== undefined
    || options.cssPort !== undefined
    || options.apiPort !== undefined
    || options.transport === 'socket';
  const limit = pinned ? 1 : attempts;

  return await withRuntimeStartLock(async () => {
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await start(options);
      } catch (error) {
        if (attempt >= limit || !isPortConflict(error)) {
          throw error;
        }
      }
    }
  });
}

/**
 * Run `start` while no other test process in this workspace is probing for runtime ports.
 *
 * `mkdir` is the atomic primitive: whoever creates the directory owns the lock, and the loser
 * waits and tries again. The directory is removed in `finally`, and a lock older than the stale
 * window is reclaimed so a killed process cannot wedge the suite.
 */
export async function withRuntimeStartLock<T>(start: () => Promise<T>): Promise<T> {
  const waitStartedAt = Date.now();
  await mkdir(path.dirname(START_LOCK_DIR), { recursive: true });

  for (;;) {
    try {
      await mkdir(START_LOCK_DIR, { recursive: false });
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
        throw error;
      }
      if (await isStaleLock()) {
        await rm(START_LOCK_DIR, { recursive: true, force: true }).catch(() => undefined);
        continue;
      }
      if (Date.now() - waitStartedAt > LOCK_WAIT_TIMEOUT_MS) {
        throw new Error(`Timed out waiting for the runtime start lock at ${START_LOCK_DIR}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 50 + Math.floor(Math.random() * 100)));
    }
  }

  try {
    return await start();
  } finally {
    await rm(START_LOCK_DIR, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function isStaleLock(): Promise<boolean> {
  try {
    const info = await stat(START_LOCK_DIR);
    return Date.now() - info.mtimeMs > STALE_LOCK_MS;
  } catch {
    // The holder released it between the failed mkdir and this check; try again immediately.
    return true;
  }
}
