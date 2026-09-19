import { Box, Cloud, Database, KeyRound, ServerCog, Wrench } from 'lucide-react';
import type { ComponentType } from 'react';

/**
 * Which authority a settings entry belongs to.
 *
 * `account` entries describe the signed-in Pod and its session; `node` entries
 * change the deployment every Pod on this machine shares. They are presented as
 * separate groups because a Pod owner editing `CSS_BASE_URL` is re-deploying
 * the node, not configuring their Pod.
 */
export type SystemSettingsScope = 'account' | 'node';

export interface SystemSettingsNavigationItem {
  id: string;
  label: string;
  path: string;
  description: string;
  icon: ComponentType<{ className?: string }>;
}

export interface SystemSettingsNavigationGroup {
  scope: SystemSettingsScope;
  label: string;
  description: string;
  items: SystemSettingsNavigationItem[];
}

export const systemSettingsNavigationGroups: SystemSettingsNavigationGroup[] = [
  {
    scope: 'account',
    label: 'Account',
    description: 'Your Pod and its session.',
    items: [
      { id: 'pod', label: 'Pod', path: 'pod', description: 'Current Pod identity and data boundary.', icon: Box },
      { id: 'identity-access', label: 'Identity & Access', path: 'identity-access', description: 'Session, WebID, and account access.', icon: KeyRound },
    ],
  },
  {
    scope: 'node',
    label: 'This node',
    description: 'Shared by every Pod on this machine.',
    items: [
      { id: 'storage', label: 'Storage', path: 'storage', description: 'Authority storage backend and limits.', icon: Database },
      { id: 'runtime', label: 'Runtime', path: 'runtime', description: 'Low-frequency runtime configuration.', icon: ServerCog },
      { id: 'cloud', label: 'Cloud', path: 'cloud', description: 'Cloud coordination settings when supported.', icon: Cloud },
      { id: 'advanced', label: 'Advanced', path: 'advanced', description: 'Expert and compatibility controls.', icon: Wrench },
    ],
  },
];
