import { Box, Cloud, Database, KeyRound, ServerCog, Wrench } from 'lucide-react';
import type { ComponentType } from 'react';

export interface SystemSettingsNavigationItem {
  id: string;
  label: string;
  path: string;
  description: string;
  icon: ComponentType<{ className?: string }>;
}

export const systemSettingsNavigationItems: SystemSettingsNavigationItem[] = [
  { id: 'pod', label: 'Pod', path: 'pod', description: 'Current Pod identity and data boundary.', icon: Box },
  { id: 'identity-access', label: 'Identity & Access', path: 'identity-access', description: 'Session, WebID, and account access.', icon: KeyRound },
  { id: 'storage', label: 'Storage', path: 'storage', description: 'Authority storage backend and limits.', icon: Database },
  { id: 'runtime', label: 'Runtime', path: 'runtime', description: 'Low-frequency runtime configuration.', icon: ServerCog },
  { id: 'cloud', label: 'Cloud', path: 'cloud', description: 'Cloud coordination settings when supported.', icon: Cloud },
  { id: 'advanced', label: 'Advanced', path: 'advanced', description: 'Expert and compatibility controls.', icon: Wrench },
];
