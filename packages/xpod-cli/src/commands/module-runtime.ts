import { startModuleRuntime, ModuleRuntimeStartupError, type ModuleRuntimeHandle, type ModuleRuntimeOptions } from '../../../../src/runtime/module-host';

/** Keep the lock callback's process alive until canonical cleanup succeeds. */
export async function runForegroundModuleRuntime(options: ModuleRuntimeOptions): Promise<void> {
  let runtime: ModuleRuntimeHandle | undefined;
  let shutdownRequested = false;
  // A pending Promise/SQLite transaction alone does not keep Node alive.
  // Retain this owner even if a failed close has already removed all I/O.
  const owner = setInterval(() => {}, 60_000);
  const observeFailure = (handle: ModuleRuntimeHandle) => {
    void handle.cleanupFailure.then(error => {
      process.exitCode = 1;
      process.stderr.write(`Runtime cleanup failed; module leases retained. Retry shutdown: ${String(error)}\n`);
    });
  };
  const shutdown = () => {
    shutdownRequested = true;
    if (runtime) void runtime.stop().catch(() => {});
  };
  process.on('SIGINT', shutdown); process.on('SIGTERM', shutdown);
  try {
    try {
      runtime = await startModuleRuntime(options);
      observeFailure(runtime);
      if (shutdownRequested) shutdown();
    } catch (error) {
      if (error instanceof ModuleRuntimeStartupError) {
        runtime = error.runtime;
        observeFailure(runtime);
        shutdown();
        await runtime.closed;
      }
      throw error;
    }
    await runtime.closed;
  } finally {
    clearInterval(owner);
    process.off('SIGINT', shutdown); process.off('SIGTERM', shutdown);
  }
}
