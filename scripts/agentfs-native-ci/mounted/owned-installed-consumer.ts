import { spawn, type SpawnSyncReturns } from 'node:child_process';
import { performance } from 'node:perf_hooks';

export interface OwnedInstalledObservation {
  parentDeadlineMonotonicMs?: number; startedMonotonicMs?: number; timeoutMs: number; elapsedMs: number; timeoutObserved: boolean; closeObserved: boolean; groupClosed: boolean;
}
export type OwnedInstalledResult = SpawnSyncReturns<Buffer> & { observation: OwnedInstalledObservation };
/** Fixed test budgets: whole-archive installation differs from a small CLI probe. */
export const INSTALLED_CONSUMER_PARENT_MS = 60_000;
export const INSTALLED_CONSUMER_CLEANUP_MS = 3_000;
export function installedConsumerWatchdogMs(stage: string, parentBudgetMs?: number): number {
  if (parentBudgetMs !== undefined && parentBudgetMs !== INSTALLED_CONSUMER_PARENT_MS) throw new Error('Invalid installed parent budget');
  return stage === 'node-cli-install' || stage === 'bun-cli-install' ? (parentBudgetMs ?? 15_000) : 10_000;
}

/** Own every started child through exit, close and process-group disappearance. */
export async function runOwnedInstalledConsumer(runtime: string, args: string[], env: NodeJS.ProcessEnv, cwd: string, timeoutMs: number, stage = 'command', parentDeadlineMonotonicMs?: number): Promise<OwnedInstalledResult> {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > installedConsumerWatchdogMs(stage, parentDeadlineMonotonicMs === undefined ? undefined : INSTALLED_CONSUMER_PARENT_MS)) throw new Error('Invalid owned consumer watchdog');
  const started = performance.now();
  if (parentDeadlineMonotonicMs !== undefined) {
    const remaining = parentDeadlineMonotonicMs - started;
    if (!Number.isFinite(parentDeadlineMonotonicMs) || remaining > INSTALLED_CONSUMER_PARENT_MS || remaining <= INSTALLED_CONSUMER_CLEANUP_MS) throw new Error('Invalid or expired installed parent deadline');
    timeoutMs = Math.min(timeoutMs, Math.floor(remaining - INSTALLED_CONSUMER_CLEANUP_MS));
    if (timeoutMs < 1) throw new Error('Invalid or expired installed parent deadline');
  }
  const child = spawn(runtime, args, { cwd, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const stdout: Buffer[] = []; const stderr: Buffer[] = []; let error: Error | undefined; let timedOut = false;
  const signalGroup = (signal: NodeJS.Signals): void => {
    if (!child.pid) { return; }
    try { process.kill(-child.pid, signal); } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== 'ESRCH') { error = new Error('Owned group signal failed'); }
    }
  };
  let escalation: ReturnType<typeof setTimeout> | undefined;
  const watchdog = setTimeout(() => {
    timedOut = true; signalGroup('SIGTERM'); escalation = setTimeout(() => signalGroup('SIGKILL'), 1000);
  }, timeoutMs);
  child.stdout.on('data', chunk => stdout.push(Buffer.from(chunk))); child.stderr.on('data', chunk => stderr.push(Buffer.from(chunk)));
  child.once('error', cause => { error = cause; });
  return new Promise(resolve => child.once('close', async (status, signal) => {
    clearTimeout(watchdog); clearTimeout(escalation);
    const present = (): boolean => {
      if (!child.pid) { return false; }
      try { process.kill(-child.pid, 0); return true; }
      catch (cause) { if ((cause as NodeJS.ErrnoException).code === 'ESRCH') { return false; } error = new Error('Owned group absence unconfirmed'); return true; }
    };
    if (present()) {
      signalGroup('SIGTERM');
      for (let n = 0; n < 40 && present(); n++) { await new Promise(done => setTimeout(done, 25)); }
      if (present()) { signalGroup('SIGKILL'); }
      for (let n = 0; n < 40 && present(); n++) { await new Promise(done => setTimeout(done, 25)); }
      if (present()) { error = new Error('Owned group absence unconfirmed'); }
    }
    const groupClosed = !!child.pid && !present();
    const elapsedMs = performance.now() - started;
    resolve({ pid: child.pid!, status, signal, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr),
      error: error ?? (timedOut ? new Error('Owned consumer timeout') : undefined),
      observation: { ...(parentDeadlineMonotonicMs === undefined ? {} : { parentDeadlineMonotonicMs, startedMonotonicMs: started }), timeoutMs, elapsedMs: parentDeadlineMonotonicMs === undefined ? Math.round(elapsedMs * 1000) / 1000 : elapsedMs, timeoutObserved: timedOut, closeObserved: true, groupClosed } } as OwnedInstalledResult);
  }));
}
