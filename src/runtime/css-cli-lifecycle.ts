interface CssCliApp { start(): Promise<void>; stop(): Promise<void> }
interface SignalSource {
  on(signal: 'SIGINT' | 'SIGTERM', listener: () => void): unknown;
  removeListener(signal: 'SIGINT' | 'SIGTERM', listener: () => void): unknown;
}

/** Own the same CLI-created App throughout startup and signal-driven finalization. */
export async function runCssCliLifecycle(
  createApp: () => Promise<CssCliApp>,
  reportStopFailure: (error: unknown) => void,
  signals: SignalSource = process,
): Promise<void> {
  let app: CssCliApp | undefined;
  let shutdownRequested = false;
  let stopPromise: Promise<void> | undefined;
  let stopFailureReported = false;
  const removeSignals = (): void => {
    signals.removeListener('SIGINT', shutdown);
    signals.removeListener('SIGTERM', shutdown);
  };
  const stop = (): Promise<void> => {
    if (!stopPromise) {
      stopPromise = (async(): Promise<void> => {
        if (app) await app.stop();
        removeSignals();
      })();
    }
    return stopPromise;
  };
  let startup: Promise<void>;
  const shutdown = (): void => {
    shutdownRequested = true;
    // Never finalize concurrently with creation or the initializer chain.
    void startup.then(stop, stop).catch((error: unknown) => {
      if (!stopFailureReported) { stopFailureReported = true; reportStopFailure(error); }
    });
  };
  signals.on('SIGINT', shutdown);
  signals.on('SIGTERM', shutdown);
  startup = Promise.resolve().then(async(): Promise<void> => {
    app = await createApp();
    if (!shutdownRequested) await app.start();
  });
  try {
    await startup;
  } catch (startupError: unknown) {
    try { await stop(); }
    catch (stopError: unknown) { throw new AggregateError([startupError, stopError], 'CSS startup and cleanup failed'); }
    throw startupError;
  }
  if (shutdownRequested) await stop();
}
