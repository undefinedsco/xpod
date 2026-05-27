export type RuntimeTransport = 'socket' | 'port';
export type RuntimeTransportPreference = 'auto' | RuntimeTransport;

export interface RuntimePortListenEndpoint {
  type: 'port';
  host: string;
  port: number;
}

export interface RuntimeSocketListenEndpoint {
  type: 'socket';
  socketPath: string;
}

export type RuntimeListenEndpoint = RuntimePortListenEndpoint | RuntimeSocketListenEndpoint;

export interface RuntimeConnectionTarget {
  url?: string;
  socketPath?: string;
}

export interface RuntimeListenableServer {
  once(event: 'error', listener: (error: Error) => void): unknown;
  listen(socketPath: string, listeningListener?: () => void): unknown;
  listen(port: number, host: string, listeningListener?: () => void): unknown;
  close(callback: (error?: Error | null) => void): unknown;
}

export interface RuntimePortAllocationOptions {
  gatewayPort?: number;
  cssPort?: number;
  apiPort?: number;
  basePort?: number;
}

export interface RuntimePorts {
  gateway: number;
  css: number;
  api: number;
}

export interface RuntimeHost {
  readonly name: string;
  resolveTransport(preference?: RuntimeTransportPreference): RuntimeTransport;
  allocatePorts(options?: RuntimePortAllocationOptions): Promise<RuntimePorts>;
  createListenEndpoint(options: { port?: number; host?: string; socketPath?: string }): RuntimeListenEndpoint;
  formatListenEndpoint(endpoint: RuntimeListenEndpoint): string;
  listen(server: RuntimeListenableServer, endpoint: RuntimeListenEndpoint): Promise<void>;
  close(server: RuntimeListenableServer, endpoint?: RuntimeListenEndpoint): Promise<void>;
  waitForPortReady(port: number, host?: string, timeoutMs?: number): Promise<void>;
  isConnectionTargetReady(target: RuntimeConnectionTarget, timeoutMs?: number): Promise<boolean>;
  registerSocketOrigins(origin: string, socketPath: string): () => Promise<void>;
  cleanupSocketPath(socketPath: string): void;
}
