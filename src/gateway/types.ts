export interface ServiceConfig {
  name: string;
  command: string;
  args: string[];
  env?: Record<string, string>;
  cwd?: string;
  readyUrl?: string; // Optional health check URL
}

export type ServiceStatus = 'stopped' | 'starting' | 'running' | 'crashed';

export interface ServiceState {
  name: string;
  status: ServiceStatus;
  pid?: number;
  startTime?: number;
  uptime?: number;
  lastExitCode?: number | null;
  restartCount: number;
}
