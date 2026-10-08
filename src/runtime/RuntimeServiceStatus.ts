import type { ServiceStatus } from '../supervisor/types';

/** Read-only lifecycle facts supplied by the implementation that owns a service. */
export interface RuntimeServiceState {
  name: string;
  status: ServiceStatus | 'disabled' | 'unavailable' | 'managed';
  pid?: number;
}
