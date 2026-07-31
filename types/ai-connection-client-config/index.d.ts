declare module '@undefineds.co/ai-connection/client-config' {
  export interface AiConnectionClientProfile {
    endpoint: string;
    gatewayKey: string;
    webId: string;
    model?: string;
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
    plan(profile: AiConnectionClientProfile): Promise<AiClientConfigPlan>;
    apply(plan: AiClientConfigPlan): Promise<void>;
    verify(profile: AiConnectionClientProfile): Promise<ClientVerification>;
    restore(webId: string): Promise<void>;
  }

  export class CodexConfigAdapter implements AiClientConfigAdapter {
    constructor(options?: { homeDir?: string });
    detect(): Promise<ClientDetection>;
    inspect(): Promise<ClientInspection>;
    plan(profile: AiConnectionClientProfile): Promise<AiClientConfigPlan>;
    apply(plan: AiClientConfigPlan): Promise<void>;
    verify(profile: AiConnectionClientProfile): Promise<ClientVerification>;
    restore(webId: string): Promise<void>;
  }

  export class ClaudeCodeConfigAdapter implements AiClientConfigAdapter {
    constructor(options?: { homeDir?: string });
    detect(): Promise<ClientDetection>;
    inspect(): Promise<ClientInspection>;
    plan(profile: AiConnectionClientProfile): Promise<AiClientConfigPlan>;
    apply(plan: AiClientConfigPlan): Promise<void>;
    verify(profile: AiConnectionClientProfile): Promise<ClientVerification>;
    restore(webId: string): Promise<void>;
  }

  export class PiConfigAdapter implements AiClientConfigAdapter {
    constructor(options?: { homeDir?: string });
    detect(): Promise<ClientDetection>;
    inspect(): Promise<ClientInspection>;
    plan(profile: AiConnectionClientProfile): Promise<AiClientConfigPlan>;
    apply(plan: AiClientConfigPlan): Promise<void>;
    verify(profile: AiConnectionClientProfile): Promise<ClientVerification>;
    restore(webId: string): Promise<void>;
  }

  export class CodeBuddyConfigAdapter implements AiClientConfigAdapter {
    constructor(options?: { homeDir?: string });
    detect(): Promise<ClientDetection>;
    inspect(): Promise<ClientInspection>;
    plan(profile: AiConnectionClientProfile): Promise<AiClientConfigPlan>;
    apply(plan: AiClientConfigPlan): Promise<void>;
    verify(profile: AiConnectionClientProfile): Promise<ClientVerification>;
    restore(webId: string): Promise<void>;
  }
}
