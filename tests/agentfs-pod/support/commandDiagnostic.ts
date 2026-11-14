import { createHash } from 'node:crypto';

export type MountedCommandRole = 'shell' | 'git' | 'consumer-command' | 'mount-daemon';
export interface CommandObservation {
  state: 'closed' | 'spawn-error' | 'pending' | 'spawn-threw';
  actualExit: number | null;
  signal: string | null;
}
/** Diagnostic projection only; does not execute, retry, wait or decide acceptance. */
export function mountedCommandDiagnostic(role: MountedCommandRole, command: string, args: string[], cwd: string,
  started: number, timeoutMs: number | null, timeoutObserved: boolean, observation: CommandObservation, error?: unknown): Record<string, unknown> {
  const digest = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex');
  const failure = error as NodeJS.ErrnoException | undefined;
  return { diagnosticOnly: true, role, commandSHA256: digest(command), argvSHA256: digest(args), cwdSHA256: digest(cwd),
    elapsedMs: Math.max(0, Math.round(performance.now() - started)), timeoutMs,
    waitBudgetMs: timeoutMs === null ? null : timeoutMs + 15_000, timeoutObserved,
    state: observation.state, actualWait: observation.state === 'closed', closeObserved: observation.state === 'closed',
    actualExit: observation.actualExit, signal: observation.state === 'closed' ? observation.signal : 'unknown',
    errorCode: failure ? ['ETIMEDOUT', 'ENOENT', 'EACCES', 'EPERM', 'EAGAIN', 'ENOMEM'].includes(failure.code ?? '') ? failure.code : 'unknown' : null,
    errno: typeof failure?.errno === 'number' && Number.isSafeInteger(failure.errno) ? failure.errno : null,
    syscall: failure?.syscall === 'spawn' ? 'spawn' : failure ? 'unknown' : null };
}
export function emitMountedCommandDiagnostic(diagnostic: Record<string, unknown>): void {
  // The existing parent harness captures this marker in its original raw stream.
  // This marker is never an admission receipt or a claim that the parent closed.
  console.error('[mounted-command-diagnostic]', JSON.stringify(diagnostic));
}
