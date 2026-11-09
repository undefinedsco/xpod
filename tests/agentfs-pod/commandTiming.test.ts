import { describe, expect, it } from 'vitest';
import { MountedCommandTiming, MOUNTED_TIMING_OPERATIONS } from './support/commandTiming';

describe('bounded mounted command callback timing', () => {
  it('preserves fixed operation order and monotonic relative observations without native-close claims', () => {
    const timing = new MountedCommandTiming();
    for (const operation of MOUNTED_TIMING_OPERATIONS) {
      timing.begin(operation); timing.mark('spawn-returned'); timing.http('start', 1); timing.helper('stdout', 3);
    }
    const snapshot = timing.snapshot();
    expect(snapshot.observation).toBe('event-loop-observation-only');
    expect(snapshot.windows.map(window => window.operation)).toEqual([...MOUNTED_TIMING_OPERATIONS]);
    expect(snapshot.windows.map(window => window.ended)).toEqual([true, true, false]);
    const times = snapshot.windows.flatMap(window => [window.startedAtMs, ...window.events.map(event => event.elapsedMs)]);
    expect(times.every((value, index) => value >= 0 && value >= (times[index - 1] ?? 0))).toBe(true);
    expect(JSON.stringify(snapshot)).not.toContain('actualWait'); expect(JSON.stringify(snapshot)).not.toContain('closeObserved');
  });
  it('retains queued HTTP observations after a thrown spawn and never invents closure', () => {
    const timing = new MountedCommandTiming(); timing.begin('metadata-objects'); timing.mark('spawn-threw');
    timing.http('start', 7); timing.http('finish', 7); timing.http('close', 7);
    const window = timing.snapshot().windows[0];
    expect(window.events.map(event => event.kind)).toEqual(['mark', 'http', 'http', 'http']);
    expect(window.events[0]).toMatchObject({ kind: 'mark', mark: 'spawn-threw' });
    expect(window.counters).toMatchObject({ httpStart: 1, httpFinish: 1, httpClose: 1 });
    expect(window.ended).toBe(false);
    timing.begin('metadata-refs'); expect(timing.snapshot().windows[0].ended).toBe(true);
  });
  it('keeps only eight recent windows and sixteen prefix events each while preserving bounded counters', () => {
    const timing = new MountedCommandTiming();
    for (let i = 0; i < 12; i++) {
      timing.begin('metadata-index');
      for (let j = 0; j < 22; j++) timing.http('start', j);
      timing.helper('stdout', 42); timing.helper('stderr', 17);
    }
    const snapshot = timing.snapshot();
    expect(snapshot.windowsDropped).toBe(4); expect(snapshot.windows).toHaveLength(8);
    expect(snapshot.windows.map(window => window.id)).toEqual([5, 6, 7, 8, 9, 10, 11, 12]);
    expect(snapshot.windows.flatMap(window => window.events)).toHaveLength(128);
    for (const window of snapshot.windows) {
      expect(window.truncated).toBe(true); expect(window.events).toHaveLength(16);
      expect(window.events.map(event => 'requestId' in event ? event.requestId : -1)).toEqual(Array.from({ length: 16 }, (_, i) => i));
      expect(window.counters).toMatchObject({ httpStart: 22, stdoutBytes: 42, stderrBytes: 17 });
    }
  });
  it('deep copies snapshots and records the exact sixteen-event boundary without truncation', () => {
    const timing = new MountedCommandTiming(); timing.begin('metadata-refs');
    for (let i = 0; i < 16; i++) timing.mark('pending');
    const snapshot = timing.snapshot(); expect(snapshot.windows[0].truncated).toBe(false);
    snapshot.windows[0].events[0].elapsedMs = -1; snapshot.windows[0].events.pop();
    snapshot.windows[0].counters.httpStart = -1; snapshot.windows[0].operation = 'metadata-index'; snapshot.windows.pop();
    const fresh = timing.snapshot(); expect(fresh.windows).toHaveLength(1); expect(fresh.windows[0].events).toHaveLength(16);
    expect(fresh.windows[0].events[0].elapsedMs).toBeGreaterThanOrEqual(0);
    expect(fresh.windows[0].operation).toBe('metadata-refs'); expect(fresh.windows[0].counters.httpStart).toBe(0);
    timing.mark('closed'); expect(timing.snapshot().windows[0].truncated).toBe(true);
  });
  it('ignores malformed observer inputs and accepts no free text, argv, URLs or error messages', () => {
    const timing = new MountedCommandTiming();
    timing.mark('pending'); timing.http('start', 1); timing.helper('stdout', 1); expect(timing.snapshot().windows).toHaveLength(0);
    timing.begin('metadata-objects');
    const unsafe = timing as unknown as { begin(value: unknown): void; mark(value: unknown): void; http(phase: unknown, id: unknown): void; helper(channel: unknown, bytes: unknown): void };
    unsafe.begin('secret-path'); unsafe.mark('secret-argv'); unsafe.http('secret-url', 1); unsafe.http('start', 'secret-token');
    unsafe.helper('stderr', 'secret-body'); unsafe.helper('stdout', -1); unsafe.helper('secret-error', 10);
    timing.helper('stderr', Number.MAX_SAFE_INTEGER); timing.helper('stderr', 1);
    const snapshot = timing.snapshot(); expect(snapshot.windows).toHaveLength(1);
    expect(snapshot.windows[0].counters.stderrBytes).toBe(Number.MAX_SAFE_INTEGER);
    expect(JSON.stringify(snapshot)).not.toContain('secret'); expect(snapshot.windows[0].events).toHaveLength(2);
  });
});
