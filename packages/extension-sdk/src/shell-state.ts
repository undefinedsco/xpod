/** Host projections point to Pod objects; resolving an object removes every projection. */
export interface ShellAttentionItem {
  id: string;
  title: string;
  href: string;
  kind: 'approval' | 'run' | 'network' | 'quota';
  approvalId?: string;
  thread?: string;
  run?: string;
  resumeApproval?: string;
  risk?: string;
  expiresAt?: string;
  toolName?: string;
}

export interface ShellActivityItem {
  id: string;
  title: string;
  href: string;
  createdAt: string;
  read?: boolean;
}

export interface ShellProgressItem {
  id: string;
  title: string;
  href: string;
}

export interface ShellInboxItem {
  id: string;
  actor?: string;
  object: string;
  createdAt: string;
  approvalId?: string;
}

export interface ShellAttentionSnapshot {
  attention: ShellAttentionItem[];
  activity: ShellActivityItem[];
  inProgress: ShellProgressItem[];
  inbox: ShellInboxItem[];
}

export interface DesktopRuntimeSettings {
  state: 'stopped' | 'starting' | 'running' | 'failed';
  ownership: 'none' | 'external' | 'desktop';
  launchAtLogin: boolean;
  /** Undefined means the host cannot configure automatic restart. */
  autoRestart?: boolean;
  dataDirectory?: string;
}

export interface DesktopRuntimeBridge {
  getRuntimeSettings(): Promise<DesktopRuntimeSettings>;
  setLaunchAtLogin(enabled: boolean): Promise<void>;
  setAutoRestart(enabled: boolean): Promise<void>;
  runtimeAction(action: 'start' | 'stop' | 'restart'): Promise<void>;
  showDataDirectory(): Promise<void>;
  selectDataDirectory(): Promise<string | undefined>;
}

/** An active Local onboarding operation; the host supplies its own transport. */
export interface DesktopProvisionRequest {
  provisionCode: string;
  path: '/provision/pods' | '/provision/webids';
  body: Record<string, unknown>;
}

export interface DesktopProvisionResponse {
  status: number;
  body: unknown;
}

export interface DesktopProvisionBridge {
  request(input: DesktopProvisionRequest): Promise<DesktopProvisionResponse>;
}
