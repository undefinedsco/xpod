import { describe, expect, test } from 'bun:test';
import { statusNavigationItems } from './status-navigation';

describe('Status navigation', () => {
  test('exposes every operational subject as a direct list row', () => {
    expect(statusNavigationItems.map(({ group, label }) => `${group}:${label}`)).toEqual([
      'Overview:Overview',
      'Services:Gateway', 'Services:Solid Server', 'Services:API Server',
      'Diagnostics:Logs',
      'Index:Index Overview', 'Index:RDF', 'Index:FTS', 'Index:Vector', 'Index:Retrieval Points', 'Index:Cache', 'Index:Slow Queries', 'Index:Benchmark',
      'Usage:Usage Overview', 'Usage:Storage', 'Usage:Bandwidth', 'Usage:AI Usage', 'Usage:Index Storage',
    ]);
  });

  test('contains no generic attention destination or nested runtime row', () => {
    expect(statusNavigationItems.some((item) => /attention|runtime/i.test(item.label))).toBe(false);
  });
});
