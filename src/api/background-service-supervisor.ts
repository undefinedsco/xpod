import { getLoggerFor } from 'global-logger-factory';

/**
 * Keeps a background service alive instead of starting it once (audit N18).
 *
 * `startBackgroundServices()` ran each service exactly once and logged whatever failed, so a
 * tunnel or DDNS client that could not start (offline at boot, provider hiccup) stayed down for
 * the lifetime of the process, and one that died later was never noticed. This supervisor owns
 * that loop: bounded exponential backoff while starting, a periodic liveness check once it is
 * up, and a stop() that really stops (a pending retry must not resurrect it — the same failure
 * mode the process supervisor had).
 */

export interface BackgroundServiceSupervisorOptions {
  name: string;
  /** Starts the service; may throw. Must be safe to call again after a failure. */
  start: () => Promise<void> | void;
  /** Stops the service (used by stop()). */
  stop?: () => Promise<void> | void;
  /**
   * Reports whether the service is still up. When provided, the supervisor restarts it after a
   * liveness check fails; without it, supervision covers startup only.
   */
  isRunning?: () => boolean | Promise<boolean>;
  retryBaseDelayMs?: number;
  retryMaxDelayMs?: number;
  checkIntervalMs?: number;
  now?: () => Date;
  logger?: Pick<ReturnType<typeof getLoggerFor>, 'info' | 'warn' | 'error'>;
}

export interface BackgroundServiceSupervisorStatus {
  name: string;
  state: 'idle' | 'starting' | 'running' | 'retrying' | 'stopped';
  attempts: number;
  restarts: number;
  lastError?: string;
  startedAt?: string;
  nextRetryInMs?: number;
}

const DEFAULT_RETRY_BASE_DELAY_MS = 5_000;
const DEFAULT_RETRY_MAX_DELAY_MS = 5 * 60_000;
const DEFAULT_CHECK_INTERVAL_MS = 30_000;

export class BackgroundServiceSupervisor {
  private readonly logger: Pick<ReturnType<typeof getLoggerFor>, 'info' | 'warn' | 'error'>;
  private readonly now: () => Date;
  private readonly retryBaseDelayMs: number;
  private readonly retryMaxDelayMs: number;
  private readonly checkIntervalMs: number;
  private timer?: NodeJS.Timeout;
  private running = false;
  private inFlight = false;
  private consecutiveFailures = 0;
  private restarts = 0;
  private status: BackgroundServiceSupervisorStatus;

  public constructor(private readonly options: BackgroundServiceSupervisorOptions) {
    this.logger = options.logger ?? getLoggerFor('BackgroundServiceSupervisor');
    this.now = options.now ?? (() => new Date());
    this.retryBaseDelayMs = positive(options.retryBaseDelayMs, DEFAULT_RETRY_BASE_DELAY_MS);
    this.retryMaxDelayMs = positive(options.retryMaxDelayMs, DEFAULT_RETRY_MAX_DELAY_MS);
    this.checkIntervalMs = positive(options.checkIntervalMs, DEFAULT_CHECK_INTERVAL_MS);
    this.status = { name: options.name, state: 'idle', attempts: 0, restarts: 0 };
  }

  /** Starts supervising; repeated calls are a no-op so a restart cannot double the timers. */
  public start(): void {
    if (this.running) {
      return;
    }
    this.running = true;
    this.status = { ...this.status, state: 'starting', nextRetryInMs: undefined };
    // One cycle now, then the loop keeps its own timer.
    void this.runOnce().then(() => this.scheduleNext());
  }

  public async stop(): Promise<void> {
    this.running = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    this.status = { ...this.status, state: 'stopped', nextRetryInMs: undefined };
    try {
      await this.options.stop?.();
    } catch (error) {
      this.logger.warn(`${this.options.name}: stop failed: ${message(error)}`);
    }
  }

  public getStatus(): BackgroundServiceSupervisorStatus {
    return { ...this.status };
  }

  /** One start-or-check cycle, exposed so an operator action or a test can drive it. */
  public async runOnce(): Promise<BackgroundServiceSupervisorStatus> {
    if (this.inFlight) {
      return this.getStatus();
    }
    this.inFlight = true;
    try {
      if (this.status.state === 'running') {
        return await this.checkAlive();
      }
      return await this.attempt();
    } finally {
      this.inFlight = false;
    }
  }

  public nextDelayMs(): number {
    if (this.consecutiveFailures === 0) {
      return this.checkIntervalMs;
    }
    const exponent = Math.max(0, this.consecutiveFailures - 1);
    return Math.min(this.retryBaseDelayMs * 2 ** exponent, this.retryMaxDelayMs);
  }

  private async attempt(): Promise<BackgroundServiceSupervisorStatus> {
    this.status = { ...this.status, attempts: this.status.attempts + 1 };
    try {
      await this.options.start();
      this.consecutiveFailures = 0;
      this.status = {
        ...this.status,
        state: 'running',
        lastError: undefined,
        startedAt: this.now().toISOString(),
      };
      this.logger.info(`${this.options.name}: started`);
      return this.getStatus();
    } catch (error) {
      this.consecutiveFailures += 1;
      const delay = this.nextDelayMs();
      this.status = {
        ...this.status,
        state: 'retrying',
        lastError: message(error),
        nextRetryInMs: delay,
      };
      this.logger.warn(
        `${this.options.name}: start failed (attempt ${this.status.attempts}), retrying in ${delay}ms: ${message(error)}`,
      );
      return this.getStatus();
    }
  }

  private async checkAlive(): Promise<BackgroundServiceSupervisorStatus> {
    if (!this.options.isRunning) {
      return this.getStatus();
    }
    let alive: boolean;
    try {
      alive = await this.options.isRunning();
    } catch (error) {
      alive = false;
      this.logger.warn(`${this.options.name}: liveness check failed: ${message(error)}`);
    }
    if (alive) {
      return this.getStatus();
    }
    this.restarts += 1;
    this.consecutiveFailures = 0;
    this.status = { ...this.status, restarts: this.restarts };
    this.logger.warn(`${this.options.name}: not running any more; restarting (restart ${this.restarts})`);
    // Restart in this cycle rather than waiting for the next check.
    return await this.attempt();
  }

  /** Schedules the next cycle from the current state; the loop owns its own timer. */
  public scheduleNext(): void {
    if (!this.running) {
      return;
    }
    const delay = this.status.state === 'running' && this.options.isRunning
      ? this.checkIntervalMs
      : this.nextDelayMs();
    this.status = { ...this.status, nextRetryInMs: delay };
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.runOnce().then(() => this.scheduleNext());
    }, delay);
    this.timer.unref?.();
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function positive(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback;
}
