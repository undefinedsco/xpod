import { describe, expect, it, vi, afterEach } from 'vitest';
import { BackgroundServiceSupervisor } from '../../src/api/background-service-supervisor';

/**
 * N18（监督）：`startBackgroundServices()` 对每个后台服务只调用一次 start，失败就只写日志，
 * 之后再也不管——开机时断网、provider 抖动的隧道会一直躺着，跑着跑着死掉的也没人发现。
 * 这里验证退避重试、存活复查与"停止后不会被自己排的重试复活"。
 */
const silentLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

afterEach(() => {
  vi.useRealTimers();
});

describe('BackgroundServiceSupervisor (N18)', () => {
  it('retries a failing start with exponential backoff until it succeeds', async () => {
    let attempts = 0;
    const start = vi.fn(async () => {
      attempts += 1;
      if (attempts < 3) {
        throw new Error('provider offline');
      }
    });
    const supervisor = new BackgroundServiceSupervisor({
      name: 'tunnel',
      start,
      retryBaseDelayMs: 100,
      retryMaxDelayMs: 1_000,
      checkIntervalMs: 2_000,
      logger: silentLogger,
    });

    const first = await supervisor.runOnce();
    expect(first).toMatchObject({ state: 'retrying', attempts: 1, nextRetryInMs: 100 });
    expect(first.lastError).toContain('provider offline');
    expect(supervisor.nextDelayMs()).toBe(100);

    await supervisor.runOnce();
    expect(supervisor.nextDelayMs()).toBe(200);
    expect(supervisor.getStatus().state).toBe('retrying');

    const third = await supervisor.runOnce();
    expect(third).toMatchObject({ state: 'running', attempts: 3, lastError: undefined });
    expect(third.startedAt).toBeDefined();
    // Once it is up, the next cycle is a liveness check on the normal interval.
    expect(supervisor.nextDelayMs()).toBe(2_000);
  });

  it('caps the backoff instead of growing without bound', async () => {
    const start = vi.fn(async () => {
      throw new Error('still offline');
    });
    const supervisor = new BackgroundServiceSupervisor({
      name: 'ddns',
      start,
      retryBaseDelayMs: 100,
      retryMaxDelayMs: 400,
      logger: silentLogger,
    });

    for (let attempt = 0; attempt < 6; attempt += 1) {
      await supervisor.runOnce();
    }

    expect(supervisor.nextDelayMs()).toBe(400);
    expect(supervisor.getStatus().attempts).toBe(6);
  });

  it('restarts the service when the liveness check says it is gone', async () => {
    let alive = true;
    const start = vi.fn(async () => undefined);
    const supervisor = new BackgroundServiceSupervisor({
      name: 'tunnel',
      start,
      isRunning: () => alive,
      checkIntervalMs: 25,
      logger: silentLogger,
    });

    expect(await supervisor.runOnce()).toMatchObject({ state: 'running', attempts: 1 });

    alive = false;
    const restarted = await supervisor.runOnce();

    expect(start).toHaveBeenCalledTimes(2);
    expect(restarted).toMatchObject({ state: 'running', restarts: 1, attempts: 2 });
  });

  it('treats a throwing liveness check as "not running"', async () => {
    const start = vi.fn(async () => undefined);
    const supervisor = new BackgroundServiceSupervisor({
      name: 'tunnel',
      start,
      isRunning: () => {
        throw new Error('status endpoint exploded');
      },
      logger: silentLogger,
    });

    await supervisor.runOnce();
    const restarted = await supervisor.runOnce();

    expect(restarted.restarts).toBe(1);
    expect(start).toHaveBeenCalledTimes(2);
  });

  it('keeps checking on its own timer and stops for good when told to', async () => {
    vi.useFakeTimers();
    let alive = true;
    const start = vi.fn(async () => undefined);
    const stop = vi.fn(async () => undefined);
    const supervisor = new BackgroundServiceSupervisor({
      name: 'tunnel',
      start,
      stop,
      isRunning: () => alive,
      checkIntervalMs: 1_000,
      logger: silentLogger,
    });

    supervisor.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(start).toHaveBeenCalledTimes(1);

    // It notices a dead service on its own, without anyone calling runOnce().
    alive = false;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(start).toHaveBeenCalledTimes(2);

    await supervisor.stop();
    expect(stop).toHaveBeenCalledTimes(1);
    const callsAfterStop = start.mock.calls.length;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(start).toHaveBeenCalledTimes(callsAfterStop);
    expect(supervisor.getStatus().state).toBe('stopped');
  });

  it('does not let a scheduled retry resurrect a stopped service', async () => {
    vi.useFakeTimers();
    const start = vi.fn(async () => {
      throw new Error('offline');
    });
    const supervisor = new BackgroundServiceSupervisor({
      name: 'tunnel',
      start,
      retryBaseDelayMs: 500,
      logger: silentLogger,
    });

    supervisor.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(start).toHaveBeenCalledTimes(1);
    expect(supervisor.getStatus().nextRetryInMs).toBe(500);

    await supervisor.stop();
    const callsAfterStop = start.mock.calls.length;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(start).toHaveBeenCalledTimes(callsAfterStop);
  });

  it('ignores a repeated start so supervision cannot double the timers', async () => {
    const start = vi.fn(async () => undefined);
    const supervisor = new BackgroundServiceSupervisor({ name: 'tunnel', start, logger: silentLogger });

    supervisor.start();
    supervisor.start();
    await supervisor.runOnce();

    expect(start).toHaveBeenCalledTimes(1);
    await supervisor.stop();
  });
});
