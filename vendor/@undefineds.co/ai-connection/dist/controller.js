import { useSyncExternalStore } from 'react';
import { AI_CONNECTION_PROVIDERS, createAiConnectionClient, normalizeAiConnectionThrownError, } from './ai-connection-client.js';
import { parseAiConnectionServiceAccess } from './service-access.js';
export const PROVIDERS = [
    { id: 'openai', name: 'OpenAI', browserMode: 'browserAssistedApiKey', browserLabel: '打开官方控制台' },
    { id: 'anthropic', name: 'Anthropic', browserMode: 'browserAssistedApiKey', browserLabel: '打开官方控制台' },
    { id: 'kimi', name: 'Kimi', browserMode: 'deviceCodeOAuth', browserLabel: '浏览器鉴权' },
    { id: 'bailian', name: '百炼', browserMode: 'browserAssistedApiKey', browserLabel: '打开官方控制台' },
    { id: 'deepseek', name: 'DeepSeek', browserMode: 'connectUnsupported', browserLabel: '浏览器鉴权不支持' },
];
if (PROVIDERS.map((provider) => provider.id).join(',') !== AI_CONNECTION_PROVIDERS.join(',')) {
    throw new Error('AI Connection provider UI is out of sync with the client catalog');
}
export function createAiConnectionController(host) {
    const sessionSnapshot = host.solid.session.getSnapshot();
    const sessionStatus = sessionStatusFromSnapshot(sessionSnapshot);
    const pod = host.solid.pod;
    const authenticated = sessionSnapshot.status === 'authenticated'
        && pod.status === 'ready';
    const client = authenticated
        ? createAiConnectionClient({
            webId: sessionSnapshot.webId,
            podBaseUrl: pod.current.podUrl,
            authenticatedFetch: host.solid.session.fetch,
        })
        : null;
    let selectedProvider = 'openai';
    let searchQuery = '';
    let providerStates = {};
    let providerSummaries = {};
    let providerLoadError;
    let providerLoadGeneration = 0;
    let providerLoadPromise;
    let serviceAccessState = client ? 'checking' : 'missing';
    let serviceAccessPromise;
    const listeners = new Set();
    const notify = () => listeners.forEach((listener) => listener());
    const controller = {
        client,
        sessionStatus,
        podStatus: pod.status,
        error: pod.status === 'error'
            ? pod.error
            : sessionSnapshot.status === 'error' && !sessionSnapshot.webId
                ? sessionSnapshot.error
                : undefined,
        login: host.solid.requireLogin,
        openExternal: host.navigation.openExternal,
        clientConfigurationBridge: host.capabilities.aiClientConfiguration,
        get selectedProvider() {
            return selectedProvider;
        },
        get searchQuery() {
            return searchQuery;
        },
        get providerStates() {
            return providerStates;
        },
        get providerSummaries() {
            return providerSummaries;
        },
        get providerLoadError() {
            return providerLoadError;
        },
        get serviceAccessState() {
            return serviceAccessState;
        },
        selectProvider(provider) {
            if (selectedProvider === provider)
                return;
            selectedProvider = provider;
            notify();
        },
        setSearchQuery(value) {
            if (searchQuery === value)
                return;
            searchQuery = value;
            notify();
        },
        setProviderState(provider, state) {
            if (providerStates[provider] === state)
                return;
            providerLoadGeneration += 1;
            providerStates = { ...providerStates, [provider]: state };
            const summary = durableSummaryFromProductState(provider, state);
            if (summary) {
                providerSummaries = {
                    ...providerSummaries,
                    [provider]: summary,
                };
            }
            notify();
        },
        async ensureServiceAccess() {
            if (serviceAccessPromise)
                return serviceAccessPromise;
            serviceAccessPromise = (async () => {
                if (!client) {
                    serviceAccessState = 'missing';
                    notify();
                    return;
                }
                if (!host.solid.permissions) {
                    serviceAccessState = 'capabilityUnavailable';
                    notify();
                    return;
                }
                if (host.solid.pod.status !== 'ready') {
                    serviceAccessState = 'missing';
                    notify();
                    return;
                }
                serviceAccessState = 'checking';
                notify();
                try {
                    const descriptor = parseAiConnectionServiceAccess(await client.getServiceAccess(), host.solid.pod.current.podUrl);
                    const status = await host.solid.permissions.ensureAgentAccess(descriptor);
                    serviceAccessState = status.status === 'granted'
                        ? 'granted'
                        : status.status;
                    notify();
                    if (status.status === 'granted') {
                        await controller.loadProviders();
                    }
                }
                catch (error) {
                    serviceAccessState = error instanceof Error && error.message.startsWith('invalid_')
                        ? 'invalidDescriptor'
                        : 'permissionDenied';
                    notify();
                }
                finally {
                    serviceAccessPromise = undefined;
                }
            })();
            return serviceAccessPromise;
        },
        async revokeServiceAccess() {
            if (!client) {
                serviceAccessState = 'missing';
                notify();
                return;
            }
            if (!host.solid.permissions) {
                serviceAccessState = 'capabilityUnavailable';
                notify();
                return;
            }
            if (host.solid.pod.status !== 'ready') {
                serviceAccessState = 'missing';
                notify();
                return;
            }
            serviceAccessState = 'checking';
            notify();
            try {
                const descriptor = parseAiConnectionServiceAccess(await client.getServiceAccess(), host.solid.pod.current.podUrl);
                const status = await host.solid.permissions.revokeAgentAccess(descriptor);
                serviceAccessState = status.status === 'granted'
                    ? 'granted'
                    : status.status;
                notify();
            }
            catch (error) {
                serviceAccessState = error instanceof Error && error.message.startsWith('invalid_')
                    ? 'invalidDescriptor'
                    : 'permissionDenied';
                notify();
            }
        },
        async loadProviders() {
            if (!client)
                return;
            if (providerLoadPromise)
                return providerLoadPromise;
            providerLoadPromise = (async () => {
                const generation = providerLoadGeneration + 1;
                providerLoadGeneration = generation;
                providerLoadError = undefined;
                notify();
                try {
                    const summaries = await client.listProviders();
                    if (generation !== providerLoadGeneration)
                        return;
                    providerSummaries = Object.fromEntries(summaries.map((summary) => [summary.provider, summary]));
                    providerStates = Object.fromEntries(PROVIDERS.map((provider) => [
                        provider.id,
                        productStateFromSummary(providerSummaries[provider.id]),
                    ]));
                    notify();
                }
                catch (error) {
                    if (generation !== providerLoadGeneration)
                        return;
                    providerLoadError = errorMessage(error);
                    notify();
                }
                finally {
                    providerLoadPromise = undefined;
                }
            })();
            return providerLoadPromise;
        },
        subscribe(listener) {
            listeners.add(listener);
            return () => listeners.delete(listener);
        },
    };
    return controller;
}
function sessionStatusFromSnapshot(snapshot) {
    if (snapshot.status === 'initializing')
        return 'authenticating';
    if (snapshot.status === 'authenticated')
        return 'authenticated';
    if (snapshot.status === 'error' && snapshot.webId)
        return 'expired';
    return 'anonymous';
}
export function useSelectedProvider(controller) {
    return useSyncExternalStore(controller.subscribe, () => controller.selectedProvider, () => controller.selectedProvider);
}
export function useProviderSearch(controller) {
    return useSyncExternalStore(controller.subscribe, () => controller.searchQuery, () => controller.searchQuery);
}
export function useProviderStates(controller) {
    return useSyncExternalStore(controller.subscribe, () => controller.providerStates, () => controller.providerStates);
}
export function useProviderSummaries(controller) {
    return useSyncExternalStore(controller.subscribe, () => controller.providerSummaries, () => controller.providerSummaries);
}
export function useProviderLoadError(controller) {
    return useSyncExternalStore(controller.subscribe, () => controller.providerLoadError, () => controller.providerLoadError);
}
export function useServiceAccessState(controller) {
    return useSyncExternalStore(controller.subscribe, () => controller.serviceAccessState, () => controller.serviceAccessState);
}
function productStateFromSummary(summary) {
    if (!summary || summary.status === 'disconnected')
        return 'unconfigured';
    if (summary.status === 'reauthRequired')
        return 'attention';
    return summary.authMode === 'browserAssistedApiKey' ? 'configured' : 'connected';
}
function durableSummaryFromProductState(provider, state) {
    if (state === 'configured') {
        return {
            provider,
            status: 'connected',
            authMode: 'browserAssistedApiKey',
            connect: {
                modes: ['browserAssistedApiKey'],
                configured: true,
            },
        };
    }
    if (state === 'connected') {
        return {
            provider,
            status: 'connected',
            connect: {
                modes: ['deviceCodeOAuth', 'browserAssistedApiKey'],
                configured: true,
            },
        };
    }
    if (state === 'attention') {
        return undefined;
    }
    if (state === 'loading') {
        return undefined;
    }
    return {
        provider,
        status: 'disconnected',
        connect: {
            modes: ['browserAssistedApiKey'],
            configured: false,
        },
    };
}
function errorMessage(error) {
    return normalizeAiConnectionThrownError(error);
}
