declare module '@undefineds.co/ai-connections/client-config' {
  export interface AiConnectionsClientProfile {
    endpoint: string;
    apiKey?: string;
    webId: string;
    model?: string;
    activeModels: readonly AiClientModelReference[];
    catalogVersion?: string;
  }

  export type AiClientModelAvailability = 'available' | 'unavailable' | 'statusUnknown';

  export interface AiClientModelReference {
    id: string;
    provider?: string;
    displayName?: string;
    availability?: AiClientModelAvailability;
  }

  export interface ClientDetection {
    installed: boolean;
    configExists: boolean;
    configPaths: string[];
  }

  export interface ClientInspection {
    ownership: 'unowned' | 'owned' | 'foreign';
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

  export class AiClientConfigError extends Error {
    readonly code: 'model_catalog_empty' | 'model_catalog_invalid' | 'model_not_available';
    constructor(
      code: 'model_catalog_empty' | 'model_catalog_invalid' | 'model_not_available',
      message?: string,
    );
  }

  export function resolveActiveModel(profile: AiConnectionClientProfile): string;

  export class CodexConfigAdapter implements AiClientConfigAdapter {
    constructor(options?: { homeDir?: string });
    detect(): Promise<ClientDetection>;
    inspect(): Promise<ClientInspection>;
    plan(profile: AiConnectionsClientProfile): Promise<AiClientConfigPlan>;
    apply(plan: AiClientConfigPlan): Promise<void>;
    verify(profile: AiConnectionsClientProfile): Promise<ClientVerification>;
    restore(webId: string): Promise<void>;
  }

  export class ClaudeCodeConfigAdapter implements AiClientConfigAdapter {
    constructor(options?: { homeDir?: string });
    detect(): Promise<ClientDetection>;
    inspect(): Promise<ClientInspection>;
    plan(profile: AiConnectionsClientProfile): Promise<AiClientConfigPlan>;
    apply(plan: AiClientConfigPlan): Promise<void>;
    verify(profile: AiConnectionsClientProfile): Promise<ClientVerification>;
    restore(webId: string): Promise<void>;
  }

  export class PiConfigAdapter implements AiClientConfigAdapter {
    constructor(options?: { homeDir?: string });
    detect(): Promise<ClientDetection>;
    inspect(): Promise<ClientInspection>;
    plan(profile: AiConnectionsClientProfile): Promise<AiClientConfigPlan>;
    apply(plan: AiClientConfigPlan): Promise<void>;
    verify(profile: AiConnectionsClientProfile): Promise<ClientVerification>;
    restore(webId: string): Promise<void>;
  }

  export class CodeBuddyConfigAdapter implements AiClientConfigAdapter {
    constructor(options?: { homeDir?: string });
    detect(): Promise<ClientDetection>;
    inspect(): Promise<ClientInspection>;
    plan(profile: AiConnectionsClientProfile): Promise<AiClientConfigPlan>;
    apply(plan: AiClientConfigPlan): Promise<void>;
    verify(profile: AiConnectionsClientProfile): Promise<ClientVerification>;
    restore(webId: string): Promise<void>;
  }
}
