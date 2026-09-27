/**
 * Driving the outbound queue.
 *
 * The queue knows what is still owed and the sender knows how to send it; this is what makes
 * delivery happen without putting a federation round trip inside a local write. It owns three
 * things and nothing else:
 *
 * - **serialization**: one pass at a time, so two writers cannot both drain the same queue and
 *   send the same transaction twice;
 * - **coalescing**: a signal that arrives during a pass becomes exactly one more pass, not a
 *   queue of them;
 * - **a periodic safety net**: even with no signal at all, every scope is flushed on an
 *   interval, so a lost signal delays delivery instead of stopping it.
 *
 * A signal is deliberately pluggable: `schedule()` is what a write, a notification, or an
 * operator calls. The timer is only the fallback.
 */
import { MatrixOutbox, type MatrixOutboxReport } from './outboundQueue';

/** A timer handle, so tests can drive the clock. */
export type SchedulerTimer = ReturnType<typeof setInterval>;

export interface MatrixOutboxPass {
  /** How many scopes were flushed. */
  scopes: number;
  delivered: number;
  deferred: number;
  rejected: number;
  blocked: number;
  abandoned: number;
  /** Scopes whose flush threw; the pass continues with the rest. */
  failed: number;
}

export interface MatrixOutboxSchedulerOptions {
  outbox: MatrixOutbox;
  /** Defaults to 30 seconds. */
  intervalMs?: number;
  setInterval?: (fn: () => void, ms: number) => SchedulerTimer;
  clearInterval?: (handle: SchedulerTimer) => void;
  onPass?: (pass: MatrixOutboxPass) => void;
  onError?: (error: Error) => void;
}

export const DEFAULT_FLUSH_INTERVAL_MS = 30_000;

export class MatrixOutboxScheduler {
  private readonly options: MatrixOutboxSchedulerOptions;
  private timer?: SchedulerTimer;
  private inFlight?: Promise<MatrixOutboxPass>;
  /** A signal that arrived while a pass was running: run exactly one more afterwards. */
  private again = false;
  /**
   * Armed on construction: a signal can drive delivery without the periodic timer at all.
   * `stop()` is the only thing that disarms it.
   */
  private stopped = false;

  public constructor(options: MatrixOutboxSchedulerOptions) {
    this.options = options;
  }

  /**
   * Add the periodic safety net and run a pass now. Idempotent. Signals work without this;
   * this is what makes a lost signal delay delivery instead of stopping it.
   */
  public start(): void {
    if (this.timer !== undefined) return;
    const every = this.options.intervalMs ?? DEFAULT_FLUSH_INTERVAL_MS;
    if (every > 0) {
      const setIntervalFn = this.options.setInterval ?? setInterval;
      this.timer = setIntervalFn(() => { this.schedule(); }, every);
      // A timer must not keep the process alive on its own.
      (this.timer as { unref?: () => void }).unref?.();
    }
    this.schedule();
  }

  /** Stop scheduling. A pass already running finishes; no further one starts. */
  public stop(): void {
    this.stopped = true;
    if (this.timer !== undefined) {
      (this.options.clearInterval ?? clearInterval)(this.timer);
      this.timer = undefined;
    }
  }

  /** Whether the scheduler still accepts signals and passes. */
  public isRunning(): boolean {
    return !this.stopped;
  }

  /** Ask for a pass. While one runs this coalesces into a single follow-up pass. */
  public schedule(): void {
    if (this.stopped) return;
    if (this.inFlight) {
      this.again = true;
      return;
    }
    this.inFlight = this.run();
  }

  /** One pass over every scope with work, serialized and never throwing. */
  public async flushOnce(): Promise<MatrixOutboxPass> {
    if (this.inFlight) return await this.inFlight;
    this.inFlight = this.run();
    return await this.inFlight;
  }

  private async run(): Promise<MatrixOutboxPass> {
    const pass: MatrixOutboxPass = { scopes: 0, delivered: 0, deferred: 0, rejected: 0, blocked: 0, abandoned: 0, failed: 0 };
    try {
      const scopes = await this.options.outbox.scopes();
      for (const scope of scopes) {
        let report: MatrixOutboxReport;
        try {
          report = await this.options.outbox.flush({ scope });
        } catch (error) {
          pass.failed += 1;
          this.options.onError?.(error instanceof Error ? error : new Error(String(error)));
          continue;
        }
        pass.scopes += 1;
        pass.delivered += report.delivered.length;
        pass.deferred += report.deferred.length;
        pass.rejected += report.rejected.length;
        pass.blocked += report.blocked.length;
        pass.abandoned += report.abandoned.length;
      }
      this.options.onPass?.(pass);
      return pass;
    } catch (error) {
      this.options.onError?.(error instanceof Error ? error : new Error(String(error)));
      return pass;
    } finally {
      this.inFlight = undefined;
      // A signal that arrived mid-pass earns one more pass, and only one.
      if (this.again) {
        this.again = false;
        if (!this.stopped) this.schedule();
      }
    }
  }
}
