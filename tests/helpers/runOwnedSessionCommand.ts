import { createRequire } from 'node:module';

const { runOwnedModeCommand } = createRequire(import.meta.url)('../../scripts/lib/owned-mode-command.cjs');

/** A grants B ten seconds to drain this independent browser process group. */
export async function runOwnedSessionCommand(binary: string, args: string[], options: {
  cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number; outputBytes: number;
}): Promise<any> {
  const cancellation = new AbortController();
  const cancel = () => cancellation.abort();
  process.on('SIGTERM', cancel); process.on('SIGINT', cancel);
  try {
    const result = await runOwnedModeCommand(binary, args, {
      ...options, signal: cancellation.signal, terminationGraceMs: 1000,
    });
    // Cancellation can arrive after close but before the continuation is sampled.
    result.record.cancelled ||= cancellation.signal.aborted;
    return result;
  } finally {
    process.removeListener('SIGTERM', cancel); process.removeListener('SIGINT', cancel);
  }
}
