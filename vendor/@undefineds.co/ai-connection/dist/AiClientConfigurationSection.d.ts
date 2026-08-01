export declare const AI_CONNECTION_CLIENTS: readonly ["codex", "claude-code", "pi", "codebuddy"];
export type AiConnectionClientId = (typeof AI_CONNECTION_CLIENTS)[number];
export interface AiClientConfigurationStatus {
    status: 'notConfigured' | 'configured' | 'drifted' | 'unavailable' | 'unverifiable' | 'failedAndRestored';
    message?: string;
}
export interface AiClientConfigurationConfirmation {
    required: boolean;
    token: string;
    targetHash: string;
    message?: string;
}
export interface AiClientConfigurationDryRun {
    planId: string;
    client: AiConnectionClientId;
    confirmation?: AiClientConfigurationConfirmation;
    changes: Array<{
        target: string;
        action: 'update' | 'createOrUpdate' | 'delete';
        backup: boolean;
    }>;
}
export interface AiClientConfigurationBridge {
    inspect(client: AiConnectionClientId): Promise<AiClientConfigurationStatus>;
    plan(input: {
        client: AiConnectionClientId;
        endpoint: string;
    }): Promise<AiClientConfigurationDryRun>;
    apply(input: {
        client: AiConnectionClientId;
        planId: string;
        gatewayKey: string;
        confirmation?: {
            token: string;
            targetHash: string;
        };
    }): Promise<{
        applied: true;
    }>;
    verify(input: {
        client: AiConnectionClientId;
        planId: string;
    }): Promise<AiClientConfigurationStatus>;
    restore(client: AiConnectionClientId): Promise<AiClientConfigurationStatus>;
}
export declare const AI_CLIENT_LABELS: Record<AiConnectionClientId, string>;
export interface ManagedGatewayKeyLease {
    gatewayKey: string;
    revoke(): Promise<void>;
}
export declare function AiClientConfigurationSection({ bridge, endpoint, createGatewayKey, }: {
    bridge?: AiClientConfigurationBridge;
    endpoint: string;
    createGatewayKey?: (client: AiConnectionClientId) => Promise<ManagedGatewayKeyLease>;
}): import("react").JSX.Element;
