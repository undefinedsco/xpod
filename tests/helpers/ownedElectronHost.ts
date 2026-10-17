import type { ChildProcess } from 'node:child_process';

export interface OwnedHostGroup {
  pid: number; exitObserved: boolean; closeObserved: boolean; closeReturned: boolean;
  exitCode: number | null; signal: NodeJS.Signals | null; groupAbsent: boolean;
  forcedCleanup: boolean; ownershipUnknown: boolean;
}
type Host = { process(): ChildProcess; close(): Promise<void> };

export function recordOwnedHost(app: Host): OwnedHostGroup {
  const child = app.process();
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) throw new Error('Live owned Electron PID required');
  const record: OwnedHostGroup = { pid: child.pid, exitObserved: false, closeObserved: false, closeReturned: false,
    exitCode: null, signal: null, groupAbsent: false, forcedCleanup: false, ownershipUnknown: false };
  child.once('exit', (code, signal) => { record.exitObserved = true; record.exitCode = code; record.signal = signal; });
  child.once('close', () => { record.closeObserved = true; });
  return record;
}

/** ESRCH alone proves group absence; permissions and unknown ownership never pass. */
export function ownedHostGroupAbsent(record: OwnedHostGroup): boolean {
  try { process.kill(-record.pid, 0); return false; } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return true;
    record.ownershipUnknown = true;
    return false;
  }
}
async function waitAbsent(record: OwnedHostGroup, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (!ownedHostGroupAbsent(record) && !record.ownershipUnknown && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 25));
  return record.groupAbsent = ownedHostGroupAbsent(record);
}

/** Only a recorded launch PID may be signalled. Forced cleanup is always ineligible. */
export async function cleanupOwnedHostGroup(record: OwnedHostGroup): Promise<void> {
  if (await waitAbsent(record, 1000)) return;
  record.forcedCleanup = true;
  for (const signal of ['SIGTERM', 'SIGKILL'] as const) {
    if (record.ownershipUnknown) break;
    try { process.kill(-record.pid, signal); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') record.ownershipUnknown = true;
    }
    if (await waitAbsent(record, 750)) break;
  }
}

export function hostGroupPassed(record: OwnedHostGroup): boolean {
  return record.exitObserved && record.closeObserved && record.closeReturned && record.exitCode === 0
    && record.signal === null && record.groupAbsent && !record.forcedCleanup && !record.ownershipUnknown;
}

export async function closeOwnedHost(app: Host, record: OwnedHostGroup): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const close = app.close().then(() => { record.closeReturned = true; });
  try {
    await Promise.race([close, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error('Owned Electron close deadline exceeded')), 5000);
    })]);
  } finally {
    if (timer) clearTimeout(timer);
    await cleanupOwnedHostGroup(record);
  }
  const deadline = Date.now() + 1000;
  while ((!record.exitObserved || !record.closeObserved) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 25));
  if (!hostGroupPassed(record)) throw new Error('Owned Electron host lifecycle incomplete');
}
