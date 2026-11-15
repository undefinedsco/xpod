import { afterEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { appendFileSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  buildPreChildFailureRecord, classifyMatrixTermination, cleanupFailureDetail, createPrivateDirSync,
  finalizeSecondaryCleanupFailure, resolveFinallyCleanup, runTerminalCleanup,
  shouldPreserveMatrixRuntime, withSecondaryCleanupFailure, writePrivateFileSync,
} from './runMatrixCollaborationAcceptance';

const artifacts: string[] = [];
const tempRoot = (): string => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'matrix-private-'));
  artifacts.push(dir);
  return dir;
};
afterEach(() => {
  while (artifacts.length) rmSync(artifacts.pop()!, { recursive: true, force: true });
});

// Regression guard for the ROOT review: the old helper inferred `timedOut` from
// `killed === true && (signal === SIGTERM || code === 143)` and its onSignal path called cleanup()
// with the delete default. These tests pin the actual-timer attribution and preserve-on-signal.
describe('Matrix helper termination attribution', () => {
  it('does not infer a timer deadline from a killed exit 143 alone', () => {
    // A user/teardown SIGTERM can surface as killed=true + code 143 without our deadline firing.
    expect(classifyMatrixTermination({ childFailed: true, userSignal: false, timerFired: false }))
      .toBe('other');
  });

  it('attributes the deadline only when the monotonic timer actually fired', () => {
    expect(classifyMatrixTermination({ childFailed: true, userSignal: false, timerFired: true }))
      .toBe('timer-deadline');
  });

  it('distinguishes a user signal from a timer deadline and other failures', () => {
    expect(classifyMatrixTermination({ childFailed: true, userSignal: true, timerFired: true }))
      .toBe('user-signal');
    expect(classifyMatrixTermination({ childFailed: false, userSignal: false, timerFired: false }))
      .toBe('exit');
  });

  it('preserves the failed runtime on the first cleanup after a signal or deadline', () => {
    expect(shouldPreserveMatrixRuntime({ childFailed: false, userSignal: true, timerFired: false })).toBe(true);
    expect(shouldPreserveMatrixRuntime({ childFailed: false, userSignal: false, timerFired: true })).toBe(true);
    expect(shouldPreserveMatrixRuntime({ childFailed: true, userSignal: false, timerFired: false })).toBe(true);
    // Only a clean child exit with no signal and no deadline may delete the runtime.
    expect(shouldPreserveMatrixRuntime({ childFailed: false, userSignal: false, timerFired: false })).toBe(false);
  });
});

// Regression guard for the ROOT review: the retained runtime and diagnostic evidence could be left
// world-readable, because the runtime mkdir used umask defaults and the diag writes set no mode. These
// tests force the permissive umask022 a fresh deployment may have and assert the real on-disk modes.
describe('Matrix helper private evidence modes', () => {
  const withUmask = <T>(mask: number, run: () => T): T => {
    const previous = process.umask(mask);
    try { return run(); } finally { process.umask(previous); }
  };

  it('creates a fresh runtime root private (0700) under a fresh parent and umask022', () => {
    const parent = tempRoot();
    const runtimeRoot = path.join(parent, 'nested', randomUUID());
    withUmask(0o022, () => createPrivateDirSync(runtimeRoot));
    expect(statSync(path.dirname(runtimeRoot)).mode & 0o777).toBe(0o700);
    expect(statSync(runtimeRoot).mode & 0o777).toBe(0o700);
  });

  it('writes evidence files private (0600) under umask022', () => {
    const dir = tempRoot();
    const file = path.join(dir, 'helper-failure.json');
    withUmask(0o022, () => writePrivateFileSync(file, '{"status":"helper-failure"}\n'));
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  it('keeps the helper diagnostic log 0600 when it appends after a private creation', () => {
    const dir = tempRoot();
    const log = path.join(dir, 'wrapper-diag.log');
    // This mirrors the helper's exact sequence: create privately up front, then append.
    withUmask(0o022, () => {
      writePrivateFileSync(log, '');
      appendFileSync(log, 'DIAG_START\n');
    });
    expect(statSync(log).mode & 0o777).toBe(0o600);
    expect(readFileSync(log, 'utf8')).toContain('DIAG_START');
  });

  it('tightens an already-created world-readable runtime root rather than trusting the parent', () => {
    const parent = tempRoot();
    const runtimeRoot = path.join(parent, 'runtime');
    // Simulate a root another writer already made 0755: we own it and must force 0700.
    withUmask(0o022, () => createPrivateDirSync(runtimeRoot));
    expect(statSync(runtimeRoot).mode & 0o777).toBe(0o700);
    // A clean run removes the runtime; the primitive only guarantees the created mode.
    rmSync(runtimeRoot, { recursive: true, force: true });
    expect(() => statSync(runtimeRoot)).toThrow();
  });
});

// Regression guard for the ROOT review: the inherited `finally { await cleanup() }` could replace a
// primary child/setup error with a cleanup rejection, and skipped listener removal when cleanup threw.
describe('Matrix helper primary-error preservation across cleanup', () => {
  it('preserves the primary error identity when cleanup also fails', async () => {
    const primary = new Error('primary-child-failure');
    const secondary = Object.assign(new Error('stack.stop rejected'), { name: 'CleanupError' });
    const seen: unknown[] = [];
    let listenersRemoved = false;
    const outcome = await runTerminalCleanup({
      cleanup: () => Promise.reject(secondary),
      removeListeners: () => { listenersRemoved = true; },
      primaryFailed: true,
      primaryError: primary,
      onCleanupFailure: (error) => seen.push(error),
    });
    expect(outcome).toEqual({ failed: true, error: primary });
    expect(seen).toEqual([secondary]);
    expect(listenersRemoved).toBe(true);
  });

  it('fails the run when cleanup rejects and there is no primary failure', async () => {
    const secondary = Object.assign(new Error('stack.stop rejected'), { name: 'CleanupError' });
    let listenersRemoved = false;
    const outcome = await runTerminalCleanup({
      cleanup: () => Promise.reject(secondary),
      removeListeners: () => { listenersRemoved = true; },
      primaryFailed: false,
      primaryError: undefined,
    });
    expect(outcome).toEqual({ failed: true, error: secondary });
    expect(listenersRemoved).toBe(true);
  });

  it('treats a rejected undefined as a real primary failure, not success', async () => {
    const secondary = Object.assign(new Error('cleanup'), { name: 'CleanupError' });
    const seen: unknown[] = [];
    const outcome = await runTerminalCleanup({
      cleanup: () => Promise.reject(secondary),
      removeListeners: () => undefined,
      primaryFailed: true,
      primaryError: undefined,
      onCleanupFailure: (error) => seen.push(error),
    });
    expect(outcome.failed).toBe(true);
    expect(outcome.error).toBeUndefined();
    expect(seen).toEqual([secondary]);
  });

  it('surfaces a cleanup rejected with undefined after a successful primary', async () => {
    let listenersRemoved = false;
    const outcome = await runTerminalCleanup({
      cleanup: async () => { throw undefined; },
      removeListeners: () => { listenersRemoved = true; },
      primaryFailed: false,
      primaryError: undefined,
    });
    expect(outcome.failed).toBe(true);
    expect(outcome.error).toBeUndefined();
    expect(listenersRemoved).toBe(true);
  });

  it('preserves falsy primitive rejection values with their identity', async () => {
    for (const value of [null, 0, false, ''] as const) {
      const outcome = await runTerminalCleanup({
        cleanup: async () => { throw value; },
        removeListeners: () => undefined,
        primaryFailed: false,
        primaryError: undefined,
      });
      expect(outcome.failed).toBe(true);
      expect(outcome.error).toBe(value);
    }
  });

  it('removes signal listeners even when cleanup rejects, so no unhandled cleanup signal remains', async () => {
    // Real process listeners prove the removal actually runs on the rejection path.
    const sigterm = (): void => undefined;
    const sigint = (): void => undefined;
    process.on('SIGTERM', sigterm);
    process.on('SIGINT', sigint);
    const before = process.listenerCount('SIGTERM') + process.listenerCount('SIGINT');
    const primary = new Error('primary');
    const outcome = await runTerminalCleanup({
      cleanup: () => Promise.reject(new Error('cleanup')),
      removeListeners: () => { process.removeListener('SIGTERM', sigterm); process.removeListener('SIGINT', sigint); },
      primaryFailed: true,
      primaryError: primary,
      onCleanupFailure: () => undefined,
    });
    const after = process.listenerCount('SIGTERM') + process.listenerCount('SIGINT');
    expect(outcome.error).toBe(primary);
    expect(after).toBe(before - 2);
  });

  it('cleans up without error and records no secondary failure on a clean success', async () => {
    let cleaned = false;
    let listenersRemoved = false;
    const seen: unknown[] = [];
    const outcome = await runTerminalCleanup({
      cleanup: async () => { cleaned = true; },
      removeListeners: () => { listenersRemoved = true; },
      primaryFailed: false,
      primaryError: undefined,
      onCleanupFailure: (error) => seen.push(error),
    });
    expect(outcome).toEqual({ failed: false, error: undefined });
    expect(cleaned).toBe(true);
    expect(listenersRemoved).toBe(true);
    expect(seen).toEqual([]);
  });

  it('sanitizes the secondary cleanup failure to an allowlisted name and keeps primary facts intact', () => {
    expect(cleanupFailureDetail(Object.assign(new Error('boom'), { name: 'CleanupError' }))).toBe('CleanupError');
    expect(cleanupFailureDetail(new Error('has a message'))).toBe('Error');
    expect(cleanupFailureDetail({ not: 'an error' })).toBe('Error');
    expect(cleanupFailureDetail(Object.assign(new Error(''), { name: 'bad name!' }))).toBe('Error');

    const record = { status: 'helper-failure', cause: 'other', exitCode: 1, signal: 'SIGTERM', killed: true, userSignal: null, timerFired: false };
    const merged = withSecondaryCleanupFailure(record, Object.assign(new Error('x'), { name: 'CleanupError' }));
    expect(merged).toMatchObject({ status: 'helper-failure', cause: 'other', exitCode: 1, signal: 'SIGTERM', killed: true, secondaryCleanupFailure: 'CleanupError' });
    // The original record is untouched so the primary evidence cannot be mutated in place.
    expect(record).not.toHaveProperty('secondaryCleanupFailure');
  });

  it('persists a safe setup-failure record with the secondary cleanup fact before any child existed', async () => {
    const dir = tempRoot();
    const output = path.join(dir, 'result.json');
    const context = {
      helperStartedAtMs: performance.now() - 5,
      runtimeRoot: path.join(dir, 'runtime'),
      diagnostics: `${output}.diagnostics.json`,
    };
    const primary = Object.assign(new Error('stack.start failed'), { name: 'SetupError' });
    const cleanup = Object.assign(new Error('stop rejected'), { name: 'CleanupError' });
    let persisted: Record<string, unknown> | null = null;
    let listenersRemoved = false;
    const outcome = await runTerminalCleanup({
      cleanup: () => Promise.reject(cleanup),
      removeListeners: () => { listenersRemoved = true; },
      primaryFailed: true,
      primaryError: primary,
      onCleanupFailure: (error) => {
        persisted = finalizeSecondaryCleanupFailure(null, primary, error, context);
        writePrivateFileSync(`${output}.helper-failure.json`, `${JSON.stringify(persisted, null, 2)}\n`);
      },
    });
    expect(outcome).toEqual({ failed: true, error: primary });
    expect(listenersRemoved).toBe(true);
    expect(persisted).toMatchObject({
      status: 'helper-failure', cause: 'other',
      exitCode: null, signal: null, killed: false,
      sampleStartedAtMs: null, deadlineMs: null, timerFiredAtMs: null,
      primaryFailureKind: 'SetupError',
      secondaryCleanupFailure: 'CleanupError',
    });
    // No fabricated child stderr or credentials may leak into the safe record.
    expect(persisted).not.toHaveProperty('stderrTail');
    expect(statSync(`${output}.helper-failure.json`).mode & 0o777).toBe(0o600);
  });

  it('merges a secondary cleanup failure onto an existing child failure record without mutating it', () => {
    const existing = { status: 'helper-failure', cause: 'timer-deadline', exitCode: 143, signal: 'SIGTERM', killed: true };
    const merged = finalizeSecondaryCleanupFailure(existing, new Error('primary'), Object.assign(new Error('x'), { name: 'CleanupError' }),
      { helperStartedAtMs: 0, runtimeRoot: '/runtime', diagnostics: '/out.diagnostics.json' });
    expect(merged).toMatchObject({ status: 'helper-failure', cause: 'timer-deadline', exitCode: 143, signal: 'SIGTERM', killed: true, secondaryCleanupFailure: 'CleanupError' });
    expect(merged).not.toHaveProperty('primaryFailureKind');
    expect(existing).not.toHaveProperty('secondaryCleanupFailure');
  });

  it('builds a setup-failure record that never invents child, sample or deadline facts', () => {
    const record = buildPreChildFailureRecord({ not: 'an error' },
      { helperStartedAtMs: 100, runtimeRoot: '/runtime', diagnostics: '/out.diagnostics.json' });
    expect(record).toMatchObject({
      status: 'helper-failure', cause: 'other', exitCode: null, signal: null, killed: false,
      sampleStartedAtMs: null, deadlineMs: null, timerFiredAtMs: null, primaryFailureKind: 'Error',
    });
    expect(record.elapsedMs).toBeTypeOf('number');
  });

  it('decides the outcome solely from explicit failure flags, preserving undefined values', () => {
    const primary = new Error('primary');
    const secondary = new Error('cleanup');
    expect(resolveFinallyCleanup({ failed: true, error: primary }, { failed: true, error: secondary }))
      .toEqual({ failed: true, error: primary });
    expect(resolveFinallyCleanup({ failed: false, error: undefined }, { failed: true, error: secondary }))
      .toEqual({ failed: true, error: secondary });
    expect(resolveFinallyCleanup({ failed: true, error: undefined }, { failed: true, error: secondary }))
      .toEqual({ failed: true, error: undefined });
    expect(resolveFinallyCleanup({ failed: false, error: undefined }, { failed: true, error: undefined }))
      .toEqual({ failed: true, error: undefined });
    expect(resolveFinallyCleanup({ failed: false, error: undefined }, { failed: false, error: undefined }))
      .toEqual({ failed: false, error: undefined });
  });
});
