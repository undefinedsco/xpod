import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import type { Format } from 'logform';
import type * as Transport from 'winston-transport';
import TransportStream from 'winston-transport';
import { MESSAGE } from 'triple-beam';
import { ConfigurableLoggerFactory } from '../../src/logging/ConfigurableLoggerFactory';

/**
 * `triple-beam`'s `MESSAGE` is a unique symbol; the logger info object is
 * indexed by it at runtime, so tests read through this narrow accessor.
 */
function messageOf(info: object): string {
  return String((info as Record<symbol, unknown>)[MESSAGE] ?? '');
}

/**
 * Regression coverage for the logger timestamp hot path.
 *
 * Winston applies the logger-level `format` in `_transform` before any
 * transport (and its `level`) filters the record. So `logger.debug(...)` on an
 * `error`-level logger still runs every format step, including the timestamp.
 * The original implementation built a fresh `Intl.DateTimeFormat` and called
 * `Date.toLocaleString` for every log line, which dominated the Matrix helper
 * profile. These tests pin the timestamp/format contract and fail if the
 * per-line formatter construction returns.
 */

const ROOT = path.resolve(process.cwd(), '.test-data', 'logging-factory');
const TIME_ZONE = Intl.DateTimeFormat().resolvedOptions().timeZone;

/** Every factory built here, so the shared file transport is closed after tests. */
const created: ConfigurableLoggerFactory[] = [];

/** Reference output: the old per-line `Date.toLocaleString('sv-SE', { timeZone })`. */
function referenceTimestamp(date: Date): string {
  return date.toLocaleString('sv-SE', { timeZone: TIME_ZONE });
}

interface Counters {
  constructions: number;
  toLocaleCalls: number;
}

function instrumentIntl(): { counters: Counters; restore: () => void } {
  const counters: Counters = { constructions: 0, toLocaleCalls: 0 };
  const realDateTimeFormat = Intl.DateTimeFormat;
  const realToLocaleString = Date.prototype.toLocaleString;

  function CountedDateTimeFormat(...args: unknown[]): Intl.DateTimeFormat {
    counters.constructions += 1;
    return new realDateTimeFormat(...(args as []));
  }
  (CountedDateTimeFormat as unknown as { prototype: object }).prototype = realDateTimeFormat.prototype;
  (CountedDateTimeFormat as unknown as { supportedLocalesOf: unknown }).supportedLocalesOf =
    realDateTimeFormat.supportedLocalesOf;

  (Intl as unknown as { DateTimeFormat: unknown }).DateTimeFormat = CountedDateTimeFormat;
  Date.prototype.toLocaleString = function counted(this: Date, ...args: unknown[]): string {
    counters.toLocaleCalls += 1;
    return (realToLocaleString as (...a: unknown[]) => string).apply(this, args);
  } as typeof Date.prototype.toLocaleString;

  return {
    counters,
    restore: () => {
      Intl.DateTimeFormat = realDateTimeFormat;
      Date.prototype.toLocaleString = realToLocaleString;
    },
  };
}

class MemoryTransport extends TransportStream {
  public readonly lines: string[] = [];
  public override log(info: Record<symbol, unknown>, callback: () => void): void {
    this.lines.push(String(info[MESSAGE] ?? ''));
    callback();
  }
}
/** Shared subclass: isolated in-memory transport and a never-touched file path. */
class TestFactory extends ConfigurableLoggerFactory {
  public readonly memory = new MemoryTransport();
  protected override createTransports(): Transport[] {
    return [this.memory];
  }
  public formatFor(label: string): Format {
    return this.getFormat(label);
  }
}

function makeFactory(level: string): TestFactory {
  const factory = new TestFactory(level, { fileName: path.join(ROOT, 'test-%DATE%.log'), showLocation: false });
  created.push(factory);
  return factory;
}

describe('ConfigurableLoggerFactory timestamp formatting', () => {
  beforeAll(() => {
    fs.rmSync(ROOT, { recursive: true, force: true });
    fs.mkdirSync(ROOT, { recursive: true });
  });

  afterAll(async () => {
    for (const factory of created) {
      const transport = (factory as unknown as { fileTransport?: { close?: () => void; logStream?: { end?: (cb?: () => void) => void } } }).fileTransport;
      await new Promise<void>((resolve) => {
        try {
          if (transport?.close) transport.close();
          transport?.logStream?.end?.(() => resolve());
          setTimeout(resolve, 200);
        } catch { resolve(); }
      });
    }
    fs.rmSync(ROOT, { recursive: true, force: true });
  });

  it('does not construct a formatter or call toLocaleString for filtered log lines', () => {
    const factory = makeFactory('error');
    const logger = factory.createLogger('FilteredService');
    const lineCount = 500;

    const { counters, restore } = instrumentIntl();
    try {
      for (let index = 0; index < lineCount; index += 1) {
        logger.debug(`filtered message ${index}`);
      }
    } finally {
      restore();
    }

    // A formatter may be created once at construction; it must not scale with
    // the number of filtered log lines.
    expect(counters.constructions).toBeLessThan(10);
    expect(counters.toLocaleCalls).toBe(0);
  });

  it('keeps the sv-SE local timestamp layout in the final message', () => {
    const frozen = new Date('2026-10-02T03:24:56Z');
    vi.useFakeTimers();
    try {
      vi.setSystemTime(frozen);
      const factory = makeFactory('info');
      const info = factory.formatFor('Service').transform({ level: 'info', message: 'hello' }) as Record<string, unknown>;
      const message = messageOf(info);
      expect(message).toBe(`${referenceTimestamp(frozen)} [Service] info: hello`);
    } finally {
      vi.useRealTimers();
    }
  });

  it('matches the authoritative sv-SE formatter across seconds, days and DST boundaries', () => {
    const samples = [
      '2026-01-01T00:00:00.000Z',
      '2026-03-08T07:00:00.000Z',
      '2026-06-15T23:59:59.000Z',
      '2026-10-02T03:24:56.000Z',
      '2026-11-01T06:00:00.000Z',
      '2026-12-31T16:00:00.000Z',
    ];
    vi.useFakeTimers();
    try {
      for (const iso of samples) {
        const date = new Date(iso);
        vi.setSystemTime(date);
        const factory = makeFactory('info');
        const info = factory.formatFor('Service').transform({ level: 'info', message: 'x' }) as Record<string, unknown>;
        expect(messageOf(info)).toBe(`${referenceTimestamp(date)} [Service] info: x`);
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it('preserves level filtering between the logger and its transports', () => {
    const factory = makeFactory('error');
    const logger = factory.createLogger('LevelService');

    logger.info('must be filtered');
    logger.error('must be emitted');

    expect(factory.memory.lines).toHaveLength(1);
    expect(factory.memory.lines[0]).toContain('error: must be emitted');
    expect(factory.memory.lines[0]).not.toContain('must be filtered');
  });
});
