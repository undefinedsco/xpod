import type { WebExtensionHost, WebExtensionSessionStatus, WebExtensionSolidPodStatus } from '@undefineds.co/extension-sdk/web';
import { type AiConnectionClient, type AiConnectionProvider, type AiProviderConnectionSummary } from './ai-connection-client';
import type { AiClientConfigurationBridge } from './AiClientConfigurationSection';
export interface AiProviderDefinition {
    id: AiConnectionProvider;
    name: string;
    browserMode: 'browserAssistedApiKey' | 'deviceCodeOAuth' | 'connectUnsupported';
    browserLabel: string;
}
export declare const PROVIDERS: AiProviderDefinition[];
export type ProviderProductState = 'loading' | 'unconfigured' | 'configured' | 'connected' | 'attention';
export type ServiceAccessState = 'checking' | 'granted' | 'missing' | 'permissionDenied' | 'capabilityUnavailable' | 'invalidDescriptor';
export interface AiConnectionController {
    readonly client: AiConnectionClient | null;
    readonly sessionStatus: WebExtensionSessionStatus;
    readonly podStatus: WebExtensionSolidPodStatus;
    readonly error?: Error;
    readonly login: () => Promise<void>;
    readonly openExternal: (url: string) => Promise<void>;
    readonly clientConfigurationBridge?: AiClientConfigurationBridge;
    readonly selectedProvider: AiConnectionProvider;
    readonly searchQuery: string;
    readonly providerStates: Partial<Record<AiConnectionProvider, ProviderProductState>>;
    readonly providerSummaries: Partial<Record<AiConnectionProvider, AiProviderConnectionSummary>>;
    readonly providerLoadError?: string;
    readonly serviceAccessState: ServiceAccessState;
    selectProvider(provider: AiConnectionProvider): void;
    setSearchQuery(value: string): void;
    setProviderState(provider: AiConnectionProvider, state: ProviderProductState): void;
    ensureServiceAccess(): Promise<void>;
    revokeServiceAccess(): Promise<void>;
    loadProviders(): Promise<void>;
    subscribe(listener: () => void): () => void;
}
export declare function createAiConnectionController(host: WebExtensionHost): AiConnectionController;
export declare function useSelectedProvider(controller: AiConnectionController): AiConnectionProvider;
export declare function useProviderSearch(controller: AiConnectionController): string;
export declare function useProviderStates(controller: AiConnectionController): Partial<Record<AiConnectionProvider, ProviderProductState>>;
export declare function useProviderSummaries(controller: AiConnectionController): Partial<Record<AiConnectionProvider, AiProviderConnectionSummary>>;
export declare function useProviderLoadError(controller: AiConnectionController): string | undefined;
export declare function useServiceAccessState(controller: AiConnectionController): ServiceAccessState;
