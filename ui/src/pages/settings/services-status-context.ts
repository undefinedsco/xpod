import { createContext, useContext } from 'react';
import type { AdminCapability, ServicesStatusSnapshot } from '../../api/admin';

export interface ServicesStatusContextValue {
  snapshot: ServicesStatusSnapshot | null;
  loading: boolean;
  refreshing: boolean;
  error?: string;
  refresh(): void;
  restartCapability: AdminCapability;
  configurationWriteCapability: AdminCapability;
}

export const ServicesStatusContext = createContext<ServicesStatusContextValue | null>(null);

export function useServicesStatus(): ServicesStatusContextValue | null {
  return useContext(ServicesStatusContext);
}
