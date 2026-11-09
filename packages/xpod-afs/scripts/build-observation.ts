import { spawn } from 'node:child_process';
import { writeSync } from 'node:fs';

// Diagnostic facts only. The caller's existing lifetime deadline owns cancellation.
export function createBuildObserver(write: (line: string) => void = line => {
  if (writeSync(2, line) !== Buffer.byteLength(line)) throw new Error('Build observation short write');
}, spawnChild: typeof spawn = spawn) {
  let events = 0, bytes = 0;
  const emit = (value: Record<string, unknown>): void => {
    if (typeof value.phase !== 'string' || !/^[a-z0-9-]{1,64}$/.test(value.phase)) throw new Error('Invalid build observation phase');
    const line = JSON.stringify({ kind: 'afs-build-phase', pid: process.pid, at: new Date().toISOString(), ...value }) + '\n';
    const size = Buffer.byteLength(line);
    if (++events > 256 || size > 8192 || bytes + size > 65536) throw new Error('Build observation budget exceeded');
    write(line); bytes += size;
  };
  const usage = () => { try { return process.resourceUsage(); } catch { return undefined; } };
  const finish = (name: string, started: number, before: ReturnType<typeof usage>, fields: Record<string, unknown>) => {
    const after = usage();
    emit({ phase: name, event: 'end', elapsedMs: performance.now() - started,
      resourceScope: 'this process only; excludes child CPU and does not identify a bottleneck',
      resourceDelta: before && after ? { userCPUTime: after.userCPUTime - before.userCPUTime,
        systemCPUTime: after.systemCPUTime - before.systemCPUTime,
        fsRead: after.fsRead - before.fsRead, fsWrite: after.fsWrite - before.fsWrite } : null, ...fields });
  };
  const phase = async <T>(name: string, operation: () => T | Promise<T>): Promise<T> => {
    const started = performance.now(), before = usage();
    emit({ phase: name, event: 'start' });
    let value: T;
    try { value = await operation(); }
    catch (primary) {
      try { finish(name, started, before, { result: 'failed' }); }
      catch (secondary) { throw new AggregateError([primary, secondary], 'Build and observation failed', { cause: primary }); }
      throw primary;
    }
    finish(name, started, before, { result: 'returned' });
    return value;
  };
  // Cleanup is an obligation: diagnostic failure must never prevent its attempt.
  const cleanup = async (name: string, operation: () => void | Promise<void>, failure?: { error: unknown }): Promise<void> => {
    const started = performance.now(), before = usage(), diagnostics: unknown[] = [];
    let cleanupFailed = false, cleanupError: unknown;
    try { emit({ phase: name, event: 'start' }); } catch (error) { diagnostics.push(error); }
    try { await operation(); } catch (error) { cleanupFailed = true; cleanupError = error; }
    try { finish(name, started, before, { result: cleanupFailed ? 'failed' : 'returned', cleanupAttempted: true }); }
    catch (error) { diagnostics.push(error); }
    if (!cleanupFailed && !diagnostics.length) return;
    const errors = [...(failure ? [failure.error] : []), ...(cleanupFailed ? [cleanupError] : []), ...diagnostics];
    if (errors.length === 1) throw errors[0];
    throw new AggregateError(errors, 'Build cleanup or observation failed', { cause: errors[0] });
  };
  const command = (name: string, executable: string, args: string[], cwd: string): Promise<{
    status: number | null; signal: NodeJS.Signals | null; error: Error | null;
  }> => {
    const started = performance.now(), before = usage();
    emit({ phase: name, event: 'start', command: executable, args, cwd });
    return new Promise((resolve, reject) => {
      let child: ReturnType<typeof spawn>;
      try { child = spawnChild(executable, args, { cwd, stdio: 'inherit' }); }
      catch (primary) {
        try { finish(name, started, before, { spawnAttempted: true, childCreated: false, exitObserved: false, closeObserved: false }); }
        catch (secondary) { reject(new AggregateError([primary, secondary], 'Build spawn and observation failed', { cause: primary })); return; }
        reject(primary); return;
      }
      let error: Error | null = null, exitObserved = false;
      let exitCode: number | null = null, exitSignal: NodeJS.Signals | null = null;
      child.once('error', value => { error = value; });
      child.once('exit', (code, signal) => { exitObserved = true; exitCode = code; exitSignal = signal; });
      // Do not finish on exit/error: close is a separate observed child event.
      child.once('close', (code, signal) => {
        const primary = error ?? (code !== 0 || signal ? new Error('Observed build child failed') : null);
        try {
          finish(name, started, before, { command: executable, args, cwd, childPid: child.pid ?? null,
            spawnAttempted: true, childCreated: child.pid !== undefined,
            exitObserved, exitCode, exitSignal, closeObserved: true, closeCode: code, closeSignal: signal,
            spawnError: error ? { name: error.name, code: (error as NodeJS.ErrnoException).code ?? null } : null,
            stdio: 'inherit', descendantClosure: 'not observed' });
        } catch (secondary) {
          reject(primary ? new AggregateError([primary, secondary], 'Build child and observation failed', { cause: primary }) : secondary); return;
        }
        resolve({ status: error ? null : code, signal, error });
      });
    });
  };
  return { phase, command, cleanup };
}

export const buildObserver = createBuildObserver();
