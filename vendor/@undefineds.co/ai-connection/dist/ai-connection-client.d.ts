export declare const AI_CONNECTION_PROVIDERS: readonly ["openai", "anthropic", "kimi", "bailian", "deepseek"];
export type AiConnectionProvider = (typeof AI_CONNECTION_PROVIDERS)[number];
export type AiConnectionMode = 'browserAssistedApiKey' | 'deviceCodeOAuth' | 'connectUnsupported';
export type AiConnectStatus = 'pending' | 'authorization_pending' | 'slow_down' | 'completed' | 'expired' | 'cancelled' | 'unsupported';
export interface AiConnectAttempt {
    mode: AiConnectionMode;
    status: AiConnectStatus;
    provider: AiConnectionProvider;
    attemptId?: string;
    state?: string;
    signature?: string;
    expiresAt?: string;
    authorizationUrl?: string;
    userCode?: string;
    verificationUri?: string;
    verificationUriComplete?: string;
    intervalSeconds?: number;
    apiKeyManagementSupported?: boolean;
    credentialId?: string;
    message?: string;
}
export interface AiConnectionCredential {
    id: string;
    credentialIri: string;
    webId: string;
    provider: AiConnectionProvider;
    authMode: string;
    status: string;
    accountLabel?: string;
    expiresAt?: string;
    version?: number;
    reauthRequired?: boolean;
}
export interface AiQuotaWindow {
    name?: string;
    limit?: number;
    used?: number;
    remaining?: number;
    resetsAt?: string;
    [key: string]: unknown;
}
export interface AiQuotaSnapshot {
    credential: string;
    status: 'available' | 'unsupported' | 'error';
    balance?: number;
    windows: AiQuotaWindow[];
    observedAt: string;
    expiresAt: string;
    source: string;
    stale?: boolean;
}
export interface GatewayKeyRecord {
    id: string;
    owner: string;
    scopes: string[];
    createdAt: string;
    expiresAt?: string;
    lastUsedAt?: string;
    revokedAt?: string;
    name?: string;
}
export interface AiGatewayModel {
    id: string;
    provider: AiConnectionProvider;
    displayName?: string;
    contextWindow?: number;
    protocols?: string[];
}
export interface CreatedGatewayKey {
    plaintext: string;
    record: GatewayKeyRecord;
}
export interface AiProviderConnectionSummary {
    provider: AiConnectionProvider;
    status: 'connected' | 'disconnected' | 'reauthRequired';
    authMode?: string;
    accountLabel?: string;
    expiresAt?: string;
    reauthRequired?: boolean;
    credentialIri?: string;
    version?: number;
    connect: {
        modes: AiConnectionMode[];
        configured: boolean;
        message?: string;
    };
}
export interface AiConnectionClient {
    readonly webId: string;
    readonly apiBase: string;
    getServiceAccess(): Promise<unknown>;
    listProviders(): Promise<AiProviderConnectionSummary[]>;
    listModels(): Promise<AiGatewayModel[]>;
    listGatewayKeys(): Promise<GatewayKeyRecord[]>;
    createGatewayKey(input: {
        name?: string;
        scopes?: string[];
        expiresAt?: string;
    }): Promise<CreatedGatewayKey>;
    revokeGatewayKey(keyId: string): Promise<GatewayKeyRecord | undefined>;
    beginConnect(provider: AiConnectionProvider, mode: AiConnectionMode): Promise<AiConnectAttempt>;
    connectStatus(provider: AiConnectionProvider, attempt: Pick<AiConnectAttempt, 'attemptId' | 'state' | 'signature'>): Promise<AiConnectAttempt>;
    completeApiKey(provider: AiConnectionProvider, attempt: Pick<AiConnectAttempt, 'attemptId' | 'state' | 'signature'>, apiKey: string, accountLabel?: string): Promise<AiConnectAttempt>;
    pollDevice(provider: AiConnectionProvider, attempt: Pick<AiConnectAttempt, 'attemptId' | 'state' | 'signature'>): Promise<AiConnectAttempt>;
    disconnect(provider: AiConnectionProvider): Promise<AiConnectionCredential | undefined>;
    quota(provider: AiConnectionProvider, refresh?: boolean): Promise<AiQuotaSnapshot>;
}
export declare const AI_CONNECTION_GENERIC_ERROR_MESSAGE = "AI Connection request failed. Please try again.";
interface CreateAiConnectionClientInput {
    webId: string;
    podBaseUrl: string;
    authenticatedFetch: typeof fetch;
}
export declare function resolveAiConnectionApiBase(podBaseUrl: string): string;
export declare function createAiConnectionClient({ webId, podBaseUrl, authenticatedFetch, }: CreateAiConnectionClientInput): AiConnectionClient;
export declare function normalizeAiConnectionThrownError(error: unknown): string;
export declare function normalizeAiConnectionErrorMessage(payload: unknown, status: number, context?: {
    provider?: AiConnectionProvider;
}): string;
export {};
