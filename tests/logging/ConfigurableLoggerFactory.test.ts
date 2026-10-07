import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TransformableInfo } from 'logform';
import { ConfigurableLoggerFactory } from '../../src/logging/ConfigurableLoggerFactory';
import { logContext } from '../../src/logging/LogContext';

vi.mock('winston-daily-rotate-file', () => ({ default: class { setMaxListeners() {} } }));

class FormatProbe extends ConfigurableLoggerFactory {
  public recordFormatter() {
    return this.getFormat('example/Handler');
  }

  public static formatRecord(level = 'info'): TransformableInfo {
    // Exercise the real formatter without creating file/console transports.
    const factory = new FormatProbe('info');
    const formatter = factory.getFormat('example/Handler');
    return formatter.transform({ level, message: 'fixture', [Symbol.for('level')]: level }, formatter.options) as TransformableInfo;
  }
}

const originalTimezone = process.env.TZ;
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  if (originalTimezone === undefined) delete process.env.TZ;
  else process.env.TZ = originalTimezone;
});

describe('ConfigurableLoggerFactory local timestamp', () => {
  it('observes timezone changes with the same factory and formatter', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const date = new Date('2026-01-01T00:00:00Z');
    vi.setSystemTime(date);
    const formatter = new FormatProbe('info').recordFormatter();
    for (const timezone of ['UTC', 'Asia/Shanghai', 'America/New_York']) {
      process.env.TZ = timezone;
      const expected = date.toLocaleString('sv-SE', { timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone });
      const info = formatter.transform({ level: 'info', message: 'fixture', [Symbol.for('level')]: 'info' }, formatter.options) as TransformableInfo;
      expect(info.timestamp).toBe(expected);
    }
  });

  it.each(['UTC', 'Asia/Shanghai', 'America/New_York'])('preserves local day and DST boundaries in %s', timezone => {
    process.env.TZ = timezone;
    vi.useFakeTimers({ toFake: ['Date'] });
    for (const iso of ['2026-01-01T00:00:00Z', '2026-03-08T06:59:59Z', '2026-03-08T07:00:00Z', '2026-11-01T05:59:59Z', '2026-11-01T06:00:00Z']) {
      const date = new Date(iso);
      const expected = date.toLocaleString('sv-SE', { timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone });
      vi.setSystemTime(date);
      expect(FormatProbe.formatRecord().timestamp).toBe(expected);
    }
  });

  it('retains label, request context and debug formatting', () => {
    const info = logContext.run({ requestId: 'fixture-request' }, () => FormatProbe.formatRecord('debug'));
    expect(info.label).toBe('example/Handler');
    expect(info.requestId).toBe('fixture-request');
    expect(info[Symbol.for('message')]).toContain('[Req:fixture-request] [example/Handler] debug: fixture');
  });

  it('retains the invalid-date timestamp', () => {
    vi.spyOn(Date.prototype, 'getTime').mockReturnValue(Number.NaN);
    vi.spyOn(Date.prototype, 'toLocaleString').mockReturnValue('Invalid Date');
    expect(FormatProbe.formatRecord().timestamp).toBe('Invalid Date');
  });

  it('does not invoke internationalized formatting for repeated records including debug', () => {
    const locale = vi.spyOn(Date.prototype, 'toLocaleString');
    for (let index = 0; index < 20; index++) FormatProbe.formatRecord(index % 2 ? 'debug' : 'info');
    expect(locale).not.toHaveBeenCalled();
  });
});
