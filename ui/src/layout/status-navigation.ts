import { Activity, Boxes, Braces, Database, Gauge, HardDrive, Network, ScrollText, Server, Sparkles, Timer, Waypoints } from 'lucide-react';
import type { ComponentType } from 'react';

export type StatusNavigationGroup = 'Overview' | 'Services' | 'Usage' | 'Diagnostics' | 'Index';

export interface StatusNavigationItem {
  id: string;
  label: string;
  path: string;
  href: string;
  end: boolean;
  group: StatusNavigationGroup;
  icon: ComponentType<{ className?: string }>;
}

function statusItem(
  id: string,
  label: string,
  path: string,
  group: StatusNavigationGroup,
  icon: StatusNavigationItem['icon'],
): StatusNavigationItem {
  return { id, label, path, href: `/status/${path}`, end: true, group, icon };
}

export const statusNavigationItems: StatusNavigationItem[] = [
  statusItem('overview', 'Overview', 'overview', 'Overview', Activity),
  statusItem('gateway', 'Gateway', 'services/gateway', 'Services', Waypoints),
  statusItem('solid-server', 'Solid Server', 'services/solid-server', 'Services', Database),
  statusItem('api-server', 'API Server', 'services/api-server', 'Services', Server),
  statusItem('usage-overview', 'Usage', 'usage/overview', 'Usage', Activity),
  statusItem('usage-storage', 'Storage', 'usage/storage', 'Usage', HardDrive),
  statusItem('usage-bandwidth', 'Bandwidth', 'usage/bandwidth', 'Usage', Waypoints),
  statusItem('usage-ai', 'AI usage', 'usage/ai', 'Usage', Sparkles),
  statusItem('usage-index-storage', 'Index storage', 'usage/index-storage', 'Usage', Boxes),
  statusItem('logs', 'Logs', 'logs', 'Diagnostics', ScrollText),
  statusItem('index-overview', 'Index Overview', 'index', 'Index', Boxes),
  statusItem('rdf', 'RDF', 'index/rdf', 'Index', Braces),
  statusItem('fts', 'FTS', 'index/fts', 'Index', ScrollText),
  statusItem('vector', 'Vector', 'index/vector', 'Index', Sparkles),
  statusItem('retrieval-points', 'Retrieval Points', 'index/retrieval-points', 'Index', Network),
  statusItem('cache', 'Cache', 'index/cache', 'Index', HardDrive),
  statusItem('slow-queries', 'Slow Queries', 'index/slow-queries', 'Index', Timer),
  statusItem('benchmark', 'Benchmark', 'index/benchmark', 'Index', Gauge),
];
