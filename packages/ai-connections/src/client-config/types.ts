export interface AiConnectionsClientProfile {
  endpoint: string;
  apiKey?: string;
  webId: string;
  model?: string;
  /**
   * The active model projection returned by the authenticated Xpod Gateway.
   * Client adapters must never invent or discover provider models themselves.
   */
  activeModels: readonly AiClientModelReference[];
  /** Stable hash of the active Gateway projection used when this profile was planned. */
  catalogVersion?: string;
}

export type AiClientModelAvailability = 'available' | 'unavailable' | 'statusUnknown';

export interface AiClientModelReference {
  id: string;
  provider?: string;
  displayName?: string;
  availability?: AiClientModelAvailability;
}

export type ClientOwnership = 'unowned' | 'owned' | 'foreign';

export interface ClientDetection {
  installed: boolean;
  configExists: boolean;
  configPaths: string[];
}

export interface ClientInspection {
  ownership: ClientOwnership;
  webIdHash?: string;
  configPaths: string[];
}

export interface ClientVerification {
  ok: boolean;
  reason?: string;
}

export interface ConfigWrite {
  path: string;
  content: string | null;
  backupPath?: string;
  createBackup?: boolean;
}

export interface AiClientConfigPlan {
  client: string;
  webIdHash: string;
  writes: ConfigWrite[];
}

export interface AiClientConfigAdapter {
  detect(): Promise<ClientDetection>;
  inspect(): Promise<ClientInspection>;
  plan(profile: AiConnectionsClientProfile): Promise<AiClientConfigPlan>;
  apply(plan: AiClientConfigPlan): Promise<void>;
  verify(profile: AiConnectionsClientProfile): Promise<ClientVerification>;
  restore(webId: string): Promise<void>;
}
