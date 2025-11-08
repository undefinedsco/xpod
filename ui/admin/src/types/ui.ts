import type { ReactNode } from 'react';

export type DeploymentEdition = 'cluster' | 'local';

export interface NavigationEntry {
  path: string;
  translationKey: string;
  icon?: ReactNode;
  clusterOnly?: boolean;
}
