import type { LogEntry } from '../../api/admin';

export type LogTimeRange = 'all' | '15m' | '1h' | '24h';

export interface LogFilters {
  source: string;
  level: string;
  keyword: string;
  timeRange: LogTimeRange;
  now?: Date;
}

const RANGE_MS: Record<Exclude<LogTimeRange, 'all'>, number> = {
  '15m': 15 * 60 * 1000,
  '1h': 60 * 60 * 1000,
  '24h': 24 * 60 * 60 * 1000,
};

export function filterLogEntries(logs: LogEntry[], filters: LogFilters): LogEntry[] {
  const keyword = filters.keyword.trim().toLowerCase();
  const cutoff = filters.timeRange === 'all'
    ? null
    : (filters.now ?? new Date()).getTime() - RANGE_MS[filters.timeRange];
  return logs.filter((log) => {
    const sourceMatch = matchesSource(log, filters.source);
    const levelMatch = filters.level === 'all' || log.level === filters.level;
    const keywordMatch = !keyword || `${log.timestamp} ${log.level} ${log.source} ${log.message}`.toLowerCase().includes(keyword);
    const timestamp = Date.parse(log.timestamp);
    const timeMatch = cutoff == null || (Number.isFinite(timestamp) && timestamp >= cutoff);
    return sourceMatch && levelMatch && keywordMatch && timeMatch;
  });
}

function matchesSource(log: LogEntry, source: string): boolean {
  if (source === 'all') return true;
  if (source === 'errors') return log.level === 'error';
  if (source === 'solid-server') return log.source === 'css' || log.source === 'solid-server';
  if (source === 'runtime') return log.source === 'xpod' || log.source === 'runtime';
  return log.source === source;
}
