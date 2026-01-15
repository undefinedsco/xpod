export interface ServiceConfig {
  name: string;
  command: string;
  args: string[];
  env?: Record<string, string>;
  cwd?: string;
  readyUrl?: string;
}

export type ServiceStatus = 'stopped' | 'starting' | 'running' | 'crashed';

export interface ServiceState {
  name: string;
  status: ServiceStatus;
  pid?: number;
  startTime?: number;
  uptime?: number;
  lastExitCode?: number;
  restartCount: number;
}

export type StatusChangeHandler = (name: string, state: ServiceState) => void;
