import { describe, expect, test } from 'vitest';
import type { LogEntry } from '@/api/admin';
import { filterLogEntries } from './log-filters';

const logs: LogEntry[] = [
  { timestamp: '2026-08-09T11:55:00.000Z', level: 'info', source: 'xpod', message: 'runtime ready' },
  { timestamp: '2026-08-09T11:50:00.000Z', level: 'error', source: 'css', message: 'CSS failed' },
  { timestamp: '2026-08-09T10:00:00.000Z', level: 'warn', source: 'api', message: 'slow request' },
];

describe('filterLogEntries', () => {
  test('treats Errors as a cross-service source', () => {
    expect(filterLogEntries(logs, { source: 'errors', level: 'all', keyword: '', timeRange: 'all', now: new Date('2026-08-09T12:00:00.000Z') }))
      .toEqual([logs[1]]);
  });

  test('filters by the selected relative time range', () => {
    expect(filterLogEntries(logs, { source: 'all', level: 'all', keyword: '', timeRange: '15m', now: new Date('2026-08-09T12:00:00.000Z') }))
      .toEqual([logs[0], logs[1]]);
  });

  test('combines source aliases and keyword matching', () => {
    expect(filterLogEntries(logs, { source: 'solid-server', level: 'all', keyword: 'failed', timeRange: 'all', now: new Date('2026-08-09T12:00:00.000Z') }))
      .toEqual([logs[1]]);
  });
});
