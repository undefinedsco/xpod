import { getLoggerFor } from 'global-logger-factory';

/**
 * Renews a certificate before it expires, without a human in the loop (audit N15).
 *
 * The runtime could already read a certificate's status and renew on demand, but nothing drove
 * that: a node that stayed up long enough simply served an expired certificate until someone
 * called the admin endpoint. This keeps a single timer that checks the status, renews when the
 * status says it is due, and backs off when renewal fails instead of hammering the CA.
 *
 * It is deliberately provider-agnostic (status reader + renewer) so the ACME manager and the
 * cluster-mode manager can share it, and so tests need no certificates at all.
 */

export type CertificateRenewalStatus = 'valid' | 'renewal_due' | 'missing' | 'invalid';

export interface CertificateRenewalState {
  status: CertificateRenewalStatus;
  expiresAt?: string;
}

export interface CertificateRenewalSchedulerOptions {
  readStatus: () => Promise<CertificateRenewalState>;
  renew: () => Promise<void>;
  /** How often to look when everything is fine. */
  intervalMs?: number;
  /** First retry delay after a failed renewal; doubles up to `retryMaxDelayMs`. */
  retryBaseDelayMs?: number;
  retryMaxDelayMs?: number;
  now?: () => Date;
  logger?: Pick<ReturnType<typeof getLoggerFor>, 'info' | 'warn' | 'error'>;
}

export interface CertificateRenewalSchedulerStatus {
  running: boolean;
  /** What the last check saw. */
  lastStatus?: CertificateRenewalStatus;
  lastCheckedAt?: string;
  lastRenewedAt?: string;
  lastError?: string;
  consecutiveFailures: number;
  /** Delay before the next check, so a crash loop is visible instead of implied. */
  nextCheckInMs?: number;
}

const DEFAULT_INTERVAL_MS = 6 * 60 * 60 * 1_000;
const DEFAULT_RETRY_BASE_DELAY_MS = 60 * 1_000;
const DEFAULT_RETRY_MAX_DELAY_MS = 60 * 60 * 1_000;

export class CertificateRenewalScheduler {
  private readonly logger: Pick<ReturnType<typeof getLoggerFor>, 'info' | 'warn' | 'error'>;
  private readonly now: () => Date;
  private readonly intervalMs: number;
  private readonly retryBaseDelayMs: number;
  private readonly retryMaxDelayMs: number;
  private timer?: NodeJS.Timeout;
  private running = false;
  private inFlight = false;
  private consecutiveFailures = 0;
  private status: CertificateRenewalSchedulerStatus = { running: false, consecutiveFailures: 0 };

  public constructor(private readonly options: CertificateRenewalSchedulerOptions) {
    this.logger = options.logger ?? getLoggerFor('CertificateRenewalScheduler');
    this.now = options.now ?? (() => new Date());
    this.intervalMs = positive(options.intervalMs, DEFAULT_INTERVAL_MS);
    this.retryBaseDelayMs = positive(options.retryBaseDelayMs, DEFAULT_RETRY_BASE_DELAY_MS);
    this.retryMaxDelayMs = positive(options.retryMaxDelayMs, DEFAULT_RETRY_MAX_DELAY_MS);
  }

  /** Starts the loop; repeated calls are a no-op, so a restart cannot double the timers. */
  public start(): void {
    if (this.running) {
      return;
    }
    this.running = true;
    this.status = { ...this.status, running: true };
    this.schedule(0);
  }

  public stop(): void {
    this.running = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    this.status = { ...this.status, running: false, nextCheckInMs: undefined };
  }

  public getStatus(): CertificateRenewalSchedulerStatus {
    return { ...this.status };
  }

  /**
   * One check-and-renew cycle.
   *
   * Exposed so an operator action or a test can drive it directly; concurrent calls share the
   * in-flight run instead of renewing twice.
   */
  public async runOnce(): Promise<CertificateRenewalSchedulerStatus> {
    if (this.inFlight) {
      return this.getStatus();
    }
    this.inFlight = true;
    try {
      const current = await this.options.readStatus();
      this.status = {
        ...this.status,
        lastStatus: current.status,
        lastCheckedAt: this.now().toISOString(),
      };

      if (current.status === 'valid') {
        this.consecutiveFailures = 0;
        this.status = { ...this.status, consecutiveFailures: 0, lastError: undefined };
        return this.getStatus();
      }

      this.logger.info(`certificate status is ${current.status}; renewing`);
      await this.options.renew();
      this.consecutiveFailures = 0;
      this.status = {
        ...this.status,
        consecutiveFailures: 0,
        lastError: undefined,
        lastRenewedAt: this.now().toISOString(),
      };
      this.logger.info('certificate renewed');
      return this.getStatus();
    } catch (error) {
      this.consecutiveFailures += 1;
      const message = error instanceof Error ? error.message : String(error);
      this.status = {
        ...this.status,
        consecutiveFailures: this.consecutiveFailures,
        lastError: message,
      };
      this.logger.error(`certificate renewal failed (attempt ${this.consecutiveFailures}): ${message}`);
      return this.getStatus();
    } finally {
      this.inFlight = false;
    }
  }

  /** Delay before the next check: the normal interval, or a growing retry after failures. */
  public nextDelayMs(): number {
    if (this.consecutiveFailures === 0) {
      return this.intervalMs;
    }
    const exponent = Math.max(0, this.consecutiveFailures - 1);
    return Math.min(this.retryBaseDelayMs * 2 ** exponent, this.retryMaxDelayMs);
  }

  private schedule(delayMs: number): void {
    if (!this.running) {
      return;
    }
    this.status = { ...this.status, nextCheckInMs: delayMs };
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.runOnce().then(() => this.schedule(this.nextDelayMs()));
    }, delayMs);
    // A renewal timer must not keep the process alive on its own.
    this.timer.unref?.();
  }
}

function positive(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback;
}
