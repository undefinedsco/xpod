import { describe, expect, it, vi, afterEach } from 'vitest';
import { CertificateRenewalScheduler } from '../../../src/edge/acme/CertificateRenewalScheduler';

/**
 * N15: renewal used to be on demand only, so a node that stayed up long enough served an expired
 * certificate until someone called the admin endpoint. The scheduler closes that loop: it checks
 * on an interval, renews when the status says it is due, backs off after failures, and never
 * renews twice at once or after being stopped.
 */
const silentLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

afterEach(() => {
  vi.useRealTimers();
});

describe('CertificateRenewalScheduler (N15)', () => {
  it('renews while the status says it is due and stops once the certificate is valid', async () => {
    let status: 'valid' | 'renewal_due' | 'missing' = 'renewal_due';
    const renew = vi.fn(async () => {
      status = 'valid';
    });
    const scheduler = new CertificateRenewalScheduler({
      readStatus: async () => ({ status }),
      renew,
      intervalMs: 10,
      logger: silentLogger,
    });

    const first = await scheduler.runOnce();
    expect(renew).toHaveBeenCalledTimes(1);
    expect(first).toMatchObject({ lastStatus: 'renewal_due', consecutiveFailures: 0 });
    expect(first.lastRenewedAt).toBeDefined();

    const second = await scheduler.runOnce();
    expect(renew).toHaveBeenCalledTimes(1);
    expect(second).toMatchObject({ lastStatus: 'valid', lastError: undefined });
  });

  it('treats a missing certificate as a reason to renew, not as an error', async () => {
    const renew = vi.fn(async () => undefined);
    const scheduler = new CertificateRenewalScheduler({
      readStatus: async () => ({ status: 'missing' }),
      renew,
      logger: silentLogger,
    });

    await scheduler.runOnce();

    expect(renew).toHaveBeenCalledTimes(1);
  });

  it('backs off exponentially when renewal keeps failing and clears the streak on success', async () => {
    const failures = { count: 0 };
    const renew = vi.fn(async () => {
      failures.count += 1;
      if (failures.count <= 4) {
        throw new Error('CA unreachable');
      }
    });
    const scheduler = new CertificateRenewalScheduler({
      readStatus: async () => ({ status: 'renewal_due' }),
      renew,
      intervalMs: 10,
      retryBaseDelayMs: 100,
      retryMaxDelayMs: 500,
      logger: silentLogger,
    });

    await scheduler.runOnce();
    expect(scheduler.nextDelayMs()).toBe(100);
    expect(scheduler.getStatus().lastError).toContain('CA unreachable');

    await scheduler.runOnce();
    expect(scheduler.nextDelayMs()).toBe(200);
    await scheduler.runOnce();
    expect(scheduler.nextDelayMs()).toBe(400);
    await scheduler.runOnce();
    expect(scheduler.nextDelayMs()).toBe(500);

    await scheduler.runOnce();
    expect(scheduler.getStatus().consecutiveFailures).toBe(0);
    expect(scheduler.nextDelayMs()).toBe(10);
  });

  it('does not renew twice when a check is still running', async () => {
    let release!: () => void;
    const renew = vi.fn(async () => await new Promise<void>((resolve) => {
      release = resolve;
    }));
    const scheduler = new CertificateRenewalScheduler({
      readStatus: async () => ({ status: 'renewal_due' }),
      renew,
      logger: silentLogger,
    });

    const running = scheduler.runOnce();
    await vi.waitFor(() => expect(renew).toHaveBeenCalledTimes(1));
    await scheduler.runOnce();
    expect(renew).toHaveBeenCalledTimes(1);

    release();
    await running;
  });

  it('keeps checking on the interval and stops when told to', async () => {
    vi.useFakeTimers();
    const renew = vi.fn(async () => undefined);
    const scheduler = new CertificateRenewalScheduler({
      readStatus: async () => ({ status: 'renewal_due' }),
      renew,
      intervalMs: 1_000,
      logger: silentLogger,
    });

    // start() checks immediately, so the first renewal happens at t=0. The clock is driven by
    // hand: `vi.waitFor` would advance the fake timers itself and renew more than once.
    scheduler.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(renew).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(999);
    expect(renew).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(renew).toHaveBeenCalledTimes(2);

    scheduler.stop();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(renew).toHaveBeenCalledTimes(2);
    expect(scheduler.getStatus().running).toBe(false);
    expect(scheduler.getStatus().nextCheckInMs).toBeUndefined();
  });

  it('ignores a repeated start so a restart cannot double the timers', async () => {
    vi.useFakeTimers();
    const renew = vi.fn(async () => undefined);
    const scheduler = new CertificateRenewalScheduler({
      readStatus: async () => ({ status: 'renewal_due' }),
      renew,
      intervalMs: 1_000,
      logger: silentLogger,
    });

    scheduler.start();
    scheduler.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(renew).toHaveBeenCalledTimes(1);
    // A doubled timer would renew twice per interval; one start means one timer.
    await vi.advanceTimersByTimeAsync(1_000);
    expect(renew).toHaveBeenCalledTimes(2);

    scheduler.stop();
  });
});
