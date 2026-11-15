import { describe, expect, it, vi } from 'vitest';
import { emitMountedCommandDiagnostic, mountedCommandDiagnostic } from './support/commandDiagnostic';

describe('mounted command diagnostics', () => {
  it('records a synchronous spawn timeout without inventing a wait or exit', () => {
    const error = Object.assign(new Error('secret cwd and token'), { code: 'ETIMEDOUT', errno: -60, syscall: 'spawn' });
    const row = mountedCommandDiagnostic('shell', '/private/secret-command', ['secret-token'], '/private/secret-cwd',
      performance.now(), 60_000, false, { state: 'spawn-threw', actualExit: null, signal: null }, error);
    expect(row).toMatchObject({ role: 'shell', timeoutMs: 60_000, waitBudgetMs: 75_000, timeoutObserved: false,
      state: 'spawn-threw', actualWait: false, closeObserved: false, actualExit: null, signal: 'unknown',
      errorCode: 'ETIMEDOUT', errno: -60, syscall: 'spawn' });
    expect(row.elapsedMs).toBeGreaterThanOrEqual(0);
    for (const name of ['commandSHA256', 'argvSHA256', 'cwdSHA256']) expect(row[name]).toMatch(/^[a-f0-9]{64}$/u);
    expect(JSON.stringify(row)).not.toContain('secret');
  });
  it('distinguishes an observed timer kill from pending closure and a spawn without an application deadline', () => {
    const closed = mountedCommandDiagnostic('git', 'git', ['status'], '/cwd', performance.now(), 60_000, true,
      { state: 'closed', actualExit: null, signal: 'SIGKILL' });
    expect(closed).toMatchObject({ actualWait: true, closeObserved: true, timeoutObserved: true, signal: 'SIGKILL' });
    const pending = mountedCommandDiagnostic('mount-daemon', 'helper', ['mount'], '/cwd', performance.now(), null, false,
      { state: 'pending', actualExit: null, signal: null });
    expect(pending).toMatchObject({ actualWait: false, closeObserved: false, timeoutMs: null, waitBudgetMs: null, signal: 'unknown' });
  });
  it('emits only the diagnostic projection into the existing parent raw stream', () => {
    const emit = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const row = mountedCommandDiagnostic('consumer-command', 'private', ['private'], 'private', performance.now(), 1, false,
        { state: 'spawn-error', actualExit: null, signal: null }, Object.assign(new Error('private'), { code: 'private' }));
      emitMountedCommandDiagnostic(row);
      expect(emit).toHaveBeenCalledWith('[mounted-command-diagnostic]', JSON.stringify(row));
      expect(row.errorCode).toBe('unknown');
      expect(JSON.stringify(row)).not.toContain('private');
    } finally { emit.mockRestore(); }
  });
});
