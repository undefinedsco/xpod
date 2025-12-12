/**
 * Terminal Sidecar Types
 */

export type SessionStatus = 'active' | 'idle' | 'terminated';

export interface TerminalPermissions {
  /** Allowed working directories */
  allowedWorkdirs: string[];
  /** Secrets to inject as environment variables */
  injectSecrets: string[];
  /** Maximum session duration in seconds */
  maxSessionDuration: number;
  /** Network access domains (for bubblewrap) */
  networkAccess?: string[];
}

export interface SessionConfig {
  /** Command to execute (must be in TRUSTED_AGENTS) */
  command: string;
  /** Command arguments */
  args: string[];
  /** Working directory */
  workdir: string;
  /** Environment variables to inject */
  env: Record<string, string | EnvRef>;
  /** Session timeout in seconds */
  timeout: number;
}

export interface EnvRef {
  '@ref': string;
  jsonPath: string;
}

export interface Session {
  sessionId: string;
  userId: string;
  command: string;
  workdir: string;
  status: SessionStatus;
  createdAt: Date;
  expiresAt: Date;
  ptyPid?: number;
}

export interface CreateSessionRequest {
  command: string;
  args?: string[];
  workdir?: string;
  env?: Record<string, string | EnvRef>;
  timeout?: number;
}

export interface CreateSessionResponse {
  sessionId: string;
  status: SessionStatus;
  wsUrl: string;
  createdAt: string;
  expiresAt: string;
}

// WebSocket message types

export type ClientMessageType = 'input' | 'resize' | 'signal' | 'ping' | 'permission_response';
export type ServerMessageType = 'output' | 'exit' | 'error' | 'pong' | 'permission_request';

export interface ClientMessage {
  type: ClientMessageType;
  data?: string;
  cols?: number;
  rows?: number;
  signal?: string;
  requestId?: string;
  granted?: boolean;
}

export interface ServerMessage {
  type: ServerMessageType;
  data?: string;
  code?: number | string;
  signal?: string;
  message?: string;
  requestId?: string;
  description?: string;
  action?: string;
  resource?: string;
  timeout?: number;
}

// Trusted agents whitelist
export const TRUSTED_AGENTS = ['claude', 'codex', 'aider'] as const;
export type TrustedAgent = typeof TRUSTED_AGENTS[number];

export function isTrustedAgent(command: string): command is TrustedAgent {
  return TRUSTED_AGENTS.includes(command as TrustedAgent);
}
