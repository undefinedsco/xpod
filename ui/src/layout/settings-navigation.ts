import { Box, Bot, Network, Server } from 'lucide-react';
import type { ComponentType } from 'react';

export type SettingsSectionId = 'models' | 'pod' | 'network' | 'services';

export interface SettingsNavigationItem {
  id: SettingsSectionId;
  label: string;
  path: string;
  icon: ComponentType<{ className?: string }>;
}

export const settingsNavigationItems: SettingsNavigationItem[] = [
  { id: 'models', label: 'Models', path: '/models', icon: Bot },
  { id: 'pod', label: 'Pod', path: '/pod', icon: Box },
  { id: 'network', label: 'Network', path: '/network', icon: Network },
  { id: 'services', label: 'Services', path: '/services', icon: Server },
];

export const legacyDashboardRedirects = {
  status: '/services',
  logs: '/services/logs',
  rdf: '/services/rdf',
  settings: '/services/runtime',
} as const;
