import { useSyncExternalStore } from 'react'
import type {
  WebExtensionHost,
  WebExtensionSessionStatus,
  WebExtensionSolidPodStatus,
} from '@undefineds.co/extension-sdk/web'
import {
  AI_CONNECTION_PROVIDERS,
  createAiConnectionClient,
  normalizeAiConnectionThrownError,
  type AiConnectionClient,
  type AiConnectionProvider,
  type AiProviderConnectionSummary,
} from './ai-connection-client'
import type { AiClientConfigurationBridge } from './AiClientConfigurationSection'
import { parseAiConnectionServiceAccess } from './service-access'

export interface AiProviderDefinition {
  id: AiConnectionProvider
  name: string
  browserMode: 'browserAssistedApiKey' | 'deviceCodeOAuth' | 'connectUnsupported'
  browserLabel: string
}

export const PROVIDERS: AiProviderDefinition[] = [
  { id: 'openai', name: 'OpenAI', browserMode: 'browserAssistedApiKey', browserLabel: '打开官方控制台' },
  { id: 'anthropic', name: 'Anthropic', browserMode: 'browserAssistedApiKey', browserLabel: '打开官方控制台' },
  { id: 'kimi', name: 'Kimi', browserMode: 'deviceCodeOAuth', browserLabel: '浏览器鉴权' },
  { id: 'bailian', name: '百炼', browserMode: 'browserAssistedApiKey', browserLabel: '打开官方控制台' },
  { id: 'deepseek', name: 'DeepSeek', browserMode: 'connectUnsupported', browserLabel: '浏览器鉴权不支持' },
]

export type ProviderProductState =
  | 'loading'
  | 'unconfigured'
  | 'configured'
  | 'connected'
  | 'attention'

export type ServiceAccessState =
  | 'checking'
  | 'granted'
  | 'missing'
  | 'permissionDenied'
  | 'capabilityUnavailable'
  | 'invalidDescriptor'

if (PROVIDERS.map((provider) => provider.id).join(',') !== AI_CONNECTION_PROVIDERS.join(',')) {
  throw new Error('AI Connection provider UI is out of sync with the client catalog')
}

export interface AiConnectionController {
  readonly client: AiConnectionClient | null
  readonly sessionStatus: WebExtensionSessionStatus
  readonly podStatus: WebExtensionSolidPodStatus
  readonly error?: Error
  readonly login: () => Promise<void>
  readonly openExternal: (url: string) => Promise<void>
  readonly clientConfigurationBridge?: AiClientConfigurationBridge
  readonly selectedProvider: AiConnectionProvider
  readonly searchQuery: string
  readonly providerStates: Partial<Record<AiConnectionProvider, ProviderProductState>>
  readonly providerSummaries: Partial<Record<AiConnectionProvider, AiProviderConnectionSummary>>
  readonly providerLoadError?: string
  readonly serviceAccessState: ServiceAccessState
  selectProvider(provider: AiConnectionProvider): void
  setSearchQuery(value: string): void
  setProviderState(provider: AiConnectionProvider, state: ProviderProductState): void
  ensureServiceAccess(): Promise<void>
  revokeServiceAccess(): Promise<void>
  loadProviders(): Promise<void>
  subscribe(listener: () => void): () => void
}

export function createAiConnectionController(host: WebExtensionHost): AiConnectionController {
  const sessionSnapshot = host.solid.session.getSnapshot()
  const sessionStatus = sessionStatusFromSnapshot(sessionSnapshot)
  const pod = host.solid.pod
  const authenticated = sessionSnapshot.status === 'authenticated'
    && pod.status === 'ready'
  const client = authenticated
    ? createAiConnectionClient({
        webId: sessionSnapshot.webId,
        podBaseUrl: pod.current.podUrl,
        authenticatedFetch: host.solid.session.fetch,
      })
    : null
  let selectedProvider: AiConnectionProvider = 'openai'
  let searchQuery = ''
  let providerStates: Partial<Record<AiConnectionProvider, ProviderProductState>> = {}
  let providerSummaries: Partial<Record<AiConnectionProvider, AiProviderConnectionSummary>> = {}
  let providerLoadError: string | undefined
  let providerLoadGeneration = 0
  let providerLoadPromise: Promise<void> | undefined
  let serviceAccessState: ServiceAccessState = client ? 'checking' : 'missing'
  let serviceAccessPromise: Promise<void> | undefined
  const listeners = new Set<() => void>()
  const notify = () => listeners.forEach((listener) => listener())

  const controller: AiConnectionController = {
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
      return selectedProvider
    },
    get searchQuery() {
      return searchQuery
    },
    get providerStates() {
      return providerStates
    },
    get providerSummaries() {
      return providerSummaries
    },
    get providerLoadError() {
      return providerLoadError
    },
    get serviceAccessState() {
      return serviceAccessState
    },
    selectProvider(provider) {
      if (selectedProvider === provider) return
      selectedProvider = provider
      notify()
    },
    setSearchQuery(value) {
      if (searchQuery === value) return
      searchQuery = value
      notify()
    },
    setProviderState(provider, state) {
      if (providerStates[provider] === state) return
      providerLoadGeneration += 1
      providerStates = { ...providerStates, [provider]: state }
      const summary = durableSummaryFromProductState(provider, state)
      if (summary) {
        providerSummaries = {
          ...providerSummaries,
          [provider]: summary,
        }
      }
      notify()
    },
    async ensureServiceAccess() {
      if (serviceAccessPromise) return serviceAccessPromise
      serviceAccessPromise = (async () => {
        if (!client) {
          serviceAccessState = 'missing'
          notify()
          return
        }
        if (!host.solid.permissions) {
          serviceAccessState = 'capabilityUnavailable'
          notify()
          return
        }
        if (host.solid.pod.status !== 'ready') {
          serviceAccessState = 'missing'
          notify()
          return
        }
        serviceAccessState = 'checking'
        notify()
        try {
          const descriptor = parseAiConnectionServiceAccess(
            await client.getServiceAccess(),
            host.solid.pod.current.podUrl,
          )
          const status = await host.solid.permissions.ensureAgentAccess(descriptor)
          serviceAccessState = status.status === 'granted'
            ? 'granted'
            : status.status
          notify()
          if (status.status === 'granted') {
            await controller.loadProviders()
          }
        } catch (error) {
          serviceAccessState = error instanceof Error && error.message.startsWith('invalid_')
            ? 'invalidDescriptor'
            : 'permissionDenied'
          notify()
        } finally {
          serviceAccessPromise = undefined
        }
      })()
      return serviceAccessPromise
    },
    async revokeServiceAccess() {
      if (!client) {
        serviceAccessState = 'missing'
        notify()
        return
      }
      if (!host.solid.permissions) {
        serviceAccessState = 'capabilityUnavailable'
        notify()
        return
      }
      if (host.solid.pod.status !== 'ready') {
        serviceAccessState = 'missing'
        notify()
        return
      }
      serviceAccessState = 'checking'
      notify()
      try {
        const descriptor = parseAiConnectionServiceAccess(
          await client.getServiceAccess(),
          host.solid.pod.current.podUrl,
        )
        const status = await host.solid.permissions.revokeAgentAccess(descriptor)
        serviceAccessState = status.status === 'granted'
          ? 'granted'
          : status.status
        notify()
      } catch (error) {
        serviceAccessState = error instanceof Error && error.message.startsWith('invalid_')
          ? 'invalidDescriptor'
          : 'permissionDenied'
        notify()
      }
    },
    async loadProviders() {
      if (!client) return
      if (providerLoadPromise) return providerLoadPromise
      providerLoadPromise = (async () => {
      const generation = providerLoadGeneration + 1
      providerLoadGeneration = generation
      providerLoadError = undefined
      notify()
      try {
        const summaries = await client.listProviders()
        if (generation !== providerLoadGeneration) return
        providerSummaries = Object.fromEntries(
          summaries.map((summary) => [summary.provider, summary]),
        )
        providerStates = Object.fromEntries(
          PROVIDERS.map((provider) => [
            provider.id,
            productStateFromSummary(providerSummaries[provider.id]),
          ]),
        )
        notify()
      } catch (error) {
        if (generation !== providerLoadGeneration) return
        providerLoadError = errorMessage(error)
        notify()
      } finally {
        providerLoadPromise = undefined
      }
      })()
      return providerLoadPromise
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }

  return controller
}

function sessionStatusFromSnapshot(
  snapshot: ReturnType<WebExtensionHost['solid']['session']['getSnapshot']>,
): WebExtensionSessionStatus {
  if (snapshot.status === 'initializing') return 'authenticating'
  if (snapshot.status === 'authenticated') return 'authenticated'
  if (snapshot.status === 'error' && snapshot.webId) return 'expired'
  return 'anonymous'
}

export function useSelectedProvider(controller: AiConnectionController): AiConnectionProvider {
  return useSyncExternalStore(
    controller.subscribe,
    () => controller.selectedProvider,
    () => controller.selectedProvider,
  )
}

export function useProviderSearch(controller: AiConnectionController): string {
  return useSyncExternalStore(
    controller.subscribe,
    () => controller.searchQuery,
    () => controller.searchQuery,
  )
}

export function useProviderStates(
  controller: AiConnectionController,
): Partial<Record<AiConnectionProvider, ProviderProductState>> {
  return useSyncExternalStore(
    controller.subscribe,
    () => controller.providerStates,
    () => controller.providerStates,
  )
}

export function useProviderSummaries(
  controller: AiConnectionController,
): Partial<Record<AiConnectionProvider, AiProviderConnectionSummary>> {
  return useSyncExternalStore(
    controller.subscribe,
    () => controller.providerSummaries,
    () => controller.providerSummaries,
  )
}

export function useProviderLoadError(controller: AiConnectionController): string | undefined {
  return useSyncExternalStore(
    controller.subscribe,
    () => controller.providerLoadError,
    () => controller.providerLoadError,
  )
}

export function useServiceAccessState(controller: AiConnectionController): ServiceAccessState {
  return useSyncExternalStore(
    controller.subscribe,
    () => controller.serviceAccessState,
    () => controller.serviceAccessState,
  )
}

function productStateFromSummary(
  summary?: AiProviderConnectionSummary,
): ProviderProductState {
  if (!summary || summary.status === 'disconnected') return 'unconfigured'
  if (summary.status === 'reauthRequired') return 'attention'
  return summary.authMode === 'browserAssistedApiKey' ? 'configured' : 'connected'
}

function durableSummaryFromProductState(
  provider: AiConnectionProvider,
  state: ProviderProductState,
): AiProviderConnectionSummary | undefined {
  if (state === 'configured') {
    return {
      provider,
      status: 'connected',
      authMode: 'browserAssistedApiKey',
      connect: {
        modes: ['browserAssistedApiKey'],
        configured: true,
      },
    }
  }

  if (state === 'connected') {
    return {
      provider,
      status: 'connected',
      connect: {
        modes: ['deviceCodeOAuth', 'browserAssistedApiKey'],
        configured: true,
      },
    }
  }

  if (state === 'attention') {
    return undefined
  }

  if (state === 'loading') {
    return undefined
  }

  return {
    provider,
    status: 'disconnected',
    connect: {
      modes: ['browserAssistedApiKey'],
      configured: false,
    },
  }
}

function errorMessage(error: unknown): string {
  return normalizeAiConnectionThrownError(error)
}
