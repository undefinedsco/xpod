import { createContext, useContext } from 'react';
import type { DeploymentEdition } from '../types/ui';

export interface AdminConfig {
  edition: DeploymentEdition;
  features: {
    quota: boolean;
    nodes: boolean;
  };
  baseUrl?: string;
  signalEndpoint?: string;
}

export const AdminConfigContext = createContext<AdminConfig>({
  edition: 'cluster',
  features: {
    quota: true,
    nodes: false,
  },
  baseUrl: undefined,
  signalEndpoint: undefined,
});

export function useAdminConfig(): AdminConfig {
  return useContext(AdminConfigContext);
}
