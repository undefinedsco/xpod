import { BrainCircuit, Cable, Gauge, Network, Settings } from 'lucide-react';
import type { ComponentType } from 'react';
import { canonicalRoutes } from '../routes/canonical-routes';

export type GlobalNavigationItemId = 'status' | 'network' | 'ai-connections' | 'ai-config' | 'settings';

export interface GlobalNavigationItem {
  id: GlobalNavigationItemId;
  label: string;
  href: string;
  activePaths: readonly string[];
  placement: 'primary' | 'bottom';
  icon: ComponentType<{ className?: string }>;
}

export const globalNavigationItems = [
  {
    id: 'status',
    label: 'Status',
    href: canonicalRoutes.status,
    activePaths: ['/status'],
    placement: 'primary',
    icon: Gauge,
  },
  {
    id: 'network',
    label: 'Network',
    href: canonicalRoutes.network,
    activePaths: ['/network'],
    placement: 'primary',
    icon: Network,
  },
  {
    id: 'ai-connections',
    label: 'AI Connections',
    href: canonicalRoutes.aiConnections,
    activePaths: ['/ai-connections'],
    placement: 'primary',
    icon: Cable,
  },
  {
    id: 'ai-config',
    label: 'AI Config',
    href: canonicalRoutes.aiConfig,
    activePaths: ['/ai-config'],
    placement: 'primary',
    icon: BrainCircuit,
  },
  {
    id: 'settings',
    label: 'Settings',
    href: canonicalRoutes.settings,
    activePaths: ['/settings'],
    placement: 'bottom',
    icon: Settings,
  },
] as const satisfies readonly GlobalNavigationItem[];

export function isGlobalNavigationItemActive(item: GlobalNavigationItem, pathname: string): boolean {
  const normalized = pathname.replace(/\/+$/, '') || '/';
  return item.activePaths.some((path) => normalized === path || normalized.startsWith(`${path}/`));
}
