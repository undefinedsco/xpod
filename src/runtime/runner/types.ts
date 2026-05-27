import type { App } from '@solid/community-server';
import type { AuthContext } from '../../api/auth/AuthContext';
import type { ApiServiceHandle } from '../../api/runtime';
import type { Supervisor } from '../../supervisor/Supervisor';
import type { RuntimeConnectionTarget, RuntimeHost } from '../host/types';

export interface CssRuntimeRunnerStartOptions {
  configPath: string;
  packageRoot: string;
  logLevel: string;
  shorthand: Record<string, string | number | boolean>;
}

export interface CssRuntimeRunner {
  readonly name: string;
  start(options: CssRuntimeRunnerStartOptions): Promise<App>;
}

export interface ApiRuntimeRunnerStartOptions {
  open: boolean;
  authContext: AuthContext;
  runtimeHost: RuntimeHost;
}

export interface ApiRuntimeRunner {
  readonly name: string;
  start(options: ApiRuntimeRunnerStartOptions): Promise<ApiServiceHandle>;
}

export interface GatewayRuntimeRunnerStartOptions {
  port?: number;
  bindHost: string;
  socketPath?: string;
  shutdownHandler: () => Promise<void>;
  baseUrl: string;
  runtimeHost: RuntimeHost;
  supervisor: Supervisor;
  targets: {
    css: RuntimeConnectionTarget;
    api: RuntimeConnectionTarget;
  };
}

export interface GatewayRuntimeHandle {
  stop(): Promise<void>;
}

export interface GatewayRuntimeRunner {
  readonly name: string;
  start(options: GatewayRuntimeRunnerStartOptions): Promise<GatewayRuntimeHandle>;
}
