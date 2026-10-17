import { spawn, type SpawnSyncReturns } from 'node:child_process';
import { performance } from 'node:perf_hooks';

export interface OwnedInstalledObservation {
  timeoutMs: number; elapsedMs: number; timeoutObserved: boolean; closeObserved: boolean; groupClosed: boolean;
}
export type OwnedInstalledResult = SpawnSyncReturns<Buffer> & { observation: OwnedInstalledObservation };
/** Test harness process ownership; production callers retain the fixed 10-second watchdog. */
export async function runOwnedInstalledConsumer(runtime: string, args: string[], env: NodeJS.ProcessEnv, cwd: string, timeoutMs: number): Promise<OwnedInstalledResult> {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 10_000) throw new Error('Invalid owned consumer watchdog');
  const started = performance.now();
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
    resolve({ pid: child.pid!, status, signal, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr),
      error: error ?? (timedOut ? new Error('Owned consumer timeout') : undefined),
      observation: { timeoutMs, elapsedMs: Math.round((performance.now() - started) * 1000) / 1000, timeoutObserved: timedOut, closeObserved: true, groupClosed } } as OwnedInstalledResult);
  }));
}
