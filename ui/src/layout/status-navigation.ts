import { Activity, BarChart3, Boxes, Braces, Database, Gauge, HardDrive, Network, ScrollText, Server, Sparkles, Timer, Waypoints, Wifi } from 'lucide-react';
import type { ComponentType } from 'react';

export type StatusNavigationGroup = 'Overview' | 'Services' | 'Diagnostics' | 'Index' | 'Usage';

export interface StatusNavigationItem {
  id: string;
  label: string;
  path: string;
  group: StatusNavigationGroup;
  icon: ComponentType<{ className?: string }>;
}

export const statusNavigationItems: StatusNavigationItem[] = [
  { id: 'overview', label: 'Overview', path: '/status/overview', group: 'Overview', icon: Activity },
  { id: 'gateway', label: 'Gateway', path: '/status/services/gateway', group: 'Services', icon: Waypoints },
  { id: 'solid-server', label: 'Solid Server', path: '/status/services/solid-server', group: 'Services', icon: Database },
  { id: 'api-server', label: 'API Server', path: '/status/services/api-server', group: 'Services', icon: Server },
  { id: 'logs', label: 'Logs', path: '/status/logs', group: 'Diagnostics', icon: ScrollText },
  { id: 'index-overview', label: 'Index Overview', path: '/status/index', group: 'Index', icon: Boxes },
  { id: 'rdf', label: 'RDF', path: '/status/index/rdf', group: 'Index', icon: Braces },
  { id: 'fts', label: 'FTS', path: '/status/index/fts', group: 'Index', icon: ScrollText },
  { id: 'vector', label: 'Vector', path: '/status/index/vector', group: 'Index', icon: Sparkles },
  { id: 'retrieval-points', label: 'Retrieval Points', path: '/status/index/retrieval-points', group: 'Index', icon: Network },
  { id: 'cache', label: 'Cache', path: '/status/index/cache', group: 'Index', icon: HardDrive },
  { id: 'slow-queries', label: 'Slow Queries', path: '/status/index/slow-queries', group: 'Index', icon: Timer },
  { id: 'benchmark', label: 'Benchmark', path: '/status/index/benchmark', group: 'Index', icon: Gauge },
  { id: 'usage-overview', label: 'Usage Overview', path: '/status/usage', group: 'Usage', icon: BarChart3 },
  { id: 'storage', label: 'Storage', path: '/status/usage/storage', group: 'Usage', icon: HardDrive },
  { id: 'bandwidth', label: 'Bandwidth', path: '/status/usage/bandwidth', group: 'Usage', icon: Wifi },
  { id: 'ai-usage', label: 'AI Usage', path: '/status/usage/ai', group: 'Usage', icon: Sparkles },
  { id: 'index-storage', label: 'Index Storage', path: '/status/usage/index-storage', group: 'Usage', icon: Boxes },
];
