export interface AiConnectionClientProfile {
  endpoint: string;
  apiKey?: string;
  webId: string;
  model?: string;
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
  plan(profile: AiConnectionClientProfile): Promise<AiClientConfigPlan>;
  apply(plan: AiClientConfigPlan): Promise<void>;
  verify(profile: AiConnectionClientProfile): Promise<ClientVerification>;
  restore(webId: string): Promise<void>;
}
