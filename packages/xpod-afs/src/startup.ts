import type { ChildProcess } from 'node:child_process';

/** Own only the foreground startup child; native mount teardown is separate. */
export class StartupCancellation {
  readonly controller = new AbortController();
  signal?: 'SIGINT' | 'SIGTERM';
  private child?: ChildProcess;
  private readonly interrupt = (): void => this.cancel('SIGINT');
  private readonly terminate = (): void => this.cancel('SIGTERM');

  constructor() {
    process.on('SIGINT', this.interrupt);
    process.on('SIGTERM', this.terminate);
  }

  private cancel(signal: 'SIGINT' | 'SIGTERM'): void {
    this.signal ??= signal;
    this.controller.abort();
    this.child?.kill('SIGTERM');
  }

  track(child: ChildProcess): void {
    this.child = child;
    if (this.signal) { child.kill('SIGTERM'); }
  }

  dispose(): void {
    process.removeListener('SIGINT', this.interrupt);
    process.removeListener('SIGTERM', this.terminate);
  }
}

const closed = new WeakMap<ChildProcess, Promise<void>>();
export function observeChild(child: ChildProcess): ChildProcess {
  closed.set(child, new Promise(resolve => child.once('close', () => resolve())));
  return child;
}

export async function stopOwnedChild(child: ChildProcess): Promise<void> {
  const closure = closed.get(child);
  if (!closure) { throw new Error('AFS child closure was not observed'); }
  if (child.exitCode === null && child.signalCode === null) { child.kill('SIGTERM'); }
  const timer = setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); }
  }, 2000);
  try { await closure; }
  finally { clearTimeout(timer); }
  if (!child.pid) { return; }
  const absent = (): boolean => {
    try { process.kill(-child.pid!, 0); return false; }
    catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === 'ESRCH') { return true; }
      throw new Error('AFS proxy group absence unconfirmed');
    }
  };
  if (absent()) { return; }
  // Proxy is created in its own process group, never the caller's group.
  try { process.kill(-child.pid, 'SIGTERM'); } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== 'ESRCH') { throw cause; }
  }
  for (let n = 0; n < 40 && !absent(); n++) { await new Promise(resolve => setTimeout(resolve, 25)); }
  if (!absent()) {
    try { process.kill(-child.pid, 'SIGKILL'); } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== 'ESRCH') { throw cause; }
    }
    for (let n = 0; n < 40 && !absent(); n++) { await new Promise(resolve => setTimeout(resolve, 25)); }
  }
  if (!absent()) { throw new Error('AFS proxy group absence unconfirmed'); }
}
