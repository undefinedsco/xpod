import type { AuthContext } from '../api/auth/AuthContext';
import type { Supervisor } from '../supervisor/Supervisor';
import type { RuntimeDriver } from './driver/types';
import type { RuntimeHost } from './host/types';
import type { RuntimePlatform } from './platform/types';
import type { ApiRuntimeRunner, CssRuntimeRunner, GatewayRuntimeRunner } from './runner/types';

export interface XpodRuntimePorts {
  gateway?: number;
  css?: number;
  api?: number;
}

export interface XpodRuntimeSockets {
  gateway?: string;
  css?: string;
  api?: string;
}

export interface XpodRuntimeOptions {
  mode?: 'local' | 'cloud';
  open?: boolean;
  authMode?: 'acp' | 'acl' | 'allow-all';
  apiOpen?: boolean;
  authContext?: AuthContext;
  envFile?: string;
  env?: Record<string, string | undefined>;
  shorthand?: Record<string, string | number | boolean>;
  baseUrl?: string;
  bindHost?: string;
  transport?: 'auto' | 'socket' | 'port';
  runtimeRoot?: string;
  rootFilePath?: string;
  sparqlEndpoint?: string;
  identityDbUrl?: string;
  usageDbUrl?: string;
  logLevel?: string;
  gatewayPort?: number;
  cssPort?: number;
  apiPort?: number;
  gatewaySocketPath?: string;
  cssSocketPath?: string;
  apiSocketPath?: string;
  edgeNodesEnabled?: boolean;
  centerRegistrationEnabled?: boolean;
  driver?: RuntimeDriver;
  host?: RuntimeHost;
  platform?: RuntimePlatform;
  cssRunner?: CssRuntimeRunner;
  apiRunner?: ApiRuntimeRunner;
  gatewayRunner?: GatewayRuntimeRunner;
}

export interface XpodRuntimeHandle {
  id: string;
  mode: 'local' | 'cloud';
  transport: 'socket' | 'port';
  baseUrl: string;
  supervisor: Supervisor;
  ports: XpodRuntimePorts;
  sockets: XpodRuntimeSockets;
  fetch: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
  stop: () => Promise<void>;
}
