export const MOUNTED_TIMING_OPERATIONS = ['metadata-objects', 'metadata-refs', 'metadata-index'] as const;
export const MOUNTED_TIMING_MARKS = ['spawn-returned', 'spawn-threw', 'closed', 'spawn-error', 'pending'] as const;
export type MountedTimingOperation = typeof MOUNTED_TIMING_OPERATIONS[number];
export type MountedCommandOperation = MountedTimingOperation;
export type MountedTimingMark = typeof MOUNTED_TIMING_MARKS[number];
type HttpPhase = 'start' | 'finish' | 'close';
type HelperChannel = 'stdout' | 'stderr';
type TimingEvent = { elapsedMs: number } & (
  { kind: 'mark'; mark: MountedTimingMark } |
  { kind: 'http'; phase: HttpPhase; requestId: number } |
  { kind: 'helper'; channel: HelperChannel; bytes: number });
interface TimingWindow {
  id: number; operation: MountedTimingOperation; startedAtMs: number; ended: boolean; truncated: boolean;
  events: TimingEvent[];
  counters: { httpStart: number; httpFinish: number; httpClose: number; stdoutBytes: number; stderrBytes: number };
}
export interface MountedCommandTimingSnapshot {
  observation: 'event-loop-observation-only'; windowsDropped: number; windows: TimingWindow[];
}
const increment = (current: number, amount = 1) => Math.min(Number.MAX_SAFE_INTEGER, current + amount);
/** JS callback observations only: no timers, execution, retries or native-close inference. */
export class MountedCommandTiming {
  private readonly origin = performance.now();
  private elapsed = 0;
  private sequence = 0;
  private windowsDropped = 0;
  private readonly windows: TimingWindow[] = [];
  private active?: TimingWindow;
  private now(): number {
    this.elapsed = Math.max(this.elapsed, Math.round((performance.now() - this.origin) * 1000) / 1000);
    return this.elapsed;
  }
  private append(event: TimingEvent): void {
    if (!this.active) return;
    if (this.active.events.length < 16) this.active.events.push(event);
    else this.active.truncated = true;
  }
  public begin(operation: MountedTimingOperation): void {
    if (!MOUNTED_TIMING_OPERATIONS.includes(operation)) return;
    if (this.active) this.active.ended = true;
    this.sequence = increment(this.sequence);
    this.active = { id: this.sequence, operation, startedAtMs: this.now(), ended: false, truncated: false, events: [],
      counters: { httpStart: 0, httpFinish: 0, httpClose: 0, stdoutBytes: 0, stderrBytes: 0 } };
    this.windows.push(this.active);
    if (this.windows.length > 8) { this.windows.shift(); this.windowsDropped = increment(this.windowsDropped); }
  }
  public mark(mark: MountedTimingMark): void {
    if (!this.active || !MOUNTED_TIMING_MARKS.includes(mark)) return;
    this.append({ kind: 'mark', mark, elapsedMs: this.now() });
  }
  public http(phase: HttpPhase, requestId: number): void {
    if (!this.active || !['start', 'finish', 'close'].includes(phase) || !Number.isSafeInteger(requestId) || requestId < 0) return;
    const key = phase === 'start' ? 'httpStart' : phase === 'finish' ? 'httpFinish' : 'httpClose';
    this.active.counters[key] = increment(this.active.counters[key]);
    this.append({ kind: 'http', phase, requestId, elapsedMs: this.now() });
  }
  public helper(channel: HelperChannel, bytes: number): void {
    if (!this.active || !['stdout', 'stderr'].includes(channel) || !Number.isSafeInteger(bytes) || bytes < 0) return;
    const key = channel === 'stdout' ? 'stdoutBytes' : 'stderrBytes';
    this.active.counters[key] = increment(this.active.counters[key], bytes);
    this.append({ kind: 'helper', channel, bytes, elapsedMs: this.now() });
  }
  public snapshot(): MountedCommandTimingSnapshot {
    return { observation: 'event-loop-observation-only', windowsDropped: this.windowsDropped,
      windows: this.windows.map(window => ({ ...window, counters: { ...window.counters }, events: window.events.map(event => ({ ...event })) })) };
  }
}
