import { type AiConnectionClient, type AiConnectionProvider, type AiProviderConnectionSummary } from './ai-connection-client';
import { type ProviderProductState } from './controller';
import { type AiClientConfigurationBridge } from './AiClientConfigurationSection';
export interface AiConnectionPanelProps {
    client: AiConnectionClient;
    openExternal?: (url: string) => void | Promise<void>;
    clientConfigurationBridge?: AiClientConfigurationBridge;
    selectedProvider?: AiConnectionProvider;
    providerSummaries?: Partial<Record<AiConnectionProvider, AiProviderConnectionSummary>>;
    providerLoadError?: string;
    serviceAccessGranted?: boolean;
    onProviderStateChange?: (provider: AiConnectionProvider, state: ProviderProductState) => void;
}
export declare function AiConnectionPanel({ client, openExternal, clientConfigurationBridge, selectedProvider, providerSummaries: providerSummariesInput, providerLoadError, serviceAccessGranted, onProviderStateChange, }: AiConnectionPanelProps): import("react").JSX.Element;
