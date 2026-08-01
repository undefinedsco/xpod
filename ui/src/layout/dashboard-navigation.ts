import { Activity, ChartNoAxesCombined, Gauge, Network, ScrollText, Waypoints } from 'lucide-react';
import type { ProductNavigationItem } from './XpodProductLayout';

export const dashboardNavigationItems = [
  { id: 'overview', label: 'Overview', path: '/overview', icon: Gauge },
  { id: 'runtime', label: 'Runtime', path: '/runtime', icon: Activity },
  { id: 'logs', label: 'Logs', path: '/logs', icon: ScrollText },
  { id: 'rdf', label: 'RDF', path: '/rdf', icon: Waypoints },
  { id: 'network', label: 'Network', path: '/network', icon: Network },
  { id: 'usage', label: 'Usage', path: '/usage', icon: ChartNoAxesCombined },
] as const satisfies readonly ProductNavigationItem[];
