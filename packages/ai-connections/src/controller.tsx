import { useSyncExternalStore } from 'react'
import type {
  WebExtensionHost,
  WebExtensionSessionStatus,
  WebExtensionSolidPodStatus,
} from '@undefineds.co/extension-sdk/web'
import {
  AI_CONNECTIONS_PROVIDERS,
  createAiConnectionsClient,
  normalizeAiConnectionsThrownError,
  type AiConnectionsClient,
  type AiConnectionsProvider,
  type AiProviderConnectionSummary,
} from './ai-connections-client'
import type { AiClientConfigurationBridge } from './AiClientConfigurationSection'
import { parseAiConnectionsServiceAccess } from './service-access'

export interface AiProviderDefinition {
  id: AiConnectionsProvider
  name: string
  browserMode: 'browserAssistedApiKey' | 'connectUnsupported'
  browserLabel: string
  description: string
  homeUrl: string
  apiKeyUrl?: string
  apiKeyPlaceholder?: string
  defaultBaseUrl?: string
}

export const PROVIDERS: AiProviderDefinition[] = [
  { id: 'openai', name: 'OpenAI', browserMode: 'browserAssistedApiKey', browserLabel: '登录', description: 'OpenAI 模型与编码能力', homeUrl: 'https://openai.com', apiKeyUrl: 'https://platform.openai.com/api-keys', apiKeyPlaceholder: 'sk-...', defaultBaseUrl: 'https://api.openai.com/v1' },
  { id: 'anthropic', name: 'Anthropic', browserMode: 'browserAssistedApiKey', browserLabel: '登录', description: 'Claude 模型与编码能力', homeUrl: 'https://www.anthropic.com', apiKeyUrl: 'https://console.anthropic.com/settings/keys', apiKeyPlaceholder: 'sk-ant-...', defaultBaseUrl: 'https://api.anthropic.com' },
  { id: 'kimi', name: 'Kimi', browserMode: 'browserAssistedApiKey', browserLabel: '登录', description: 'Moonshot AI 模型服务', homeUrl: 'https://www.moonshot.cn', apiKeyUrl: 'https://platform.moonshot.cn/console/api-keys', apiKeyPlaceholder: 'sk-...', defaultBaseUrl: 'https://api.moonshot.cn/v1' },
  { id: 'bailian', name: '百炼', browserMode: 'browserAssistedApiKey', browserLabel: '登录', description: '阿里云百炼模型服务', homeUrl: 'https://www.aliyun.com/product/bailian', apiKeyUrl: 'https://bailian.console.aliyun.com/#/api-key', apiKeyPlaceholder: 'sk-...', defaultBaseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1' },
  { id: 'deepseek', name: 'DeepSeek', browserMode: 'connectUnsupported', browserLabel: '不支持登录', description: 'DeepSeek 模型服务', homeUrl: 'https://www.deepseek.com', apiKeyUrl: 'https://platform.deepseek.com/api_keys', apiKeyPlaceholder: 'sk-...', defaultBaseUrl: 'https://api.deepseek.com/v1' },
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

if (PROVIDERS.map((provider) => provider.id).join(',') !== AI_CONNECTIONS_PROVIDERS.join(',')) {
  throw new Error('AI Connection provider UI is out of sync with the client catalog')
}

export interface AiConnectionsController {
  readonly client: AiConnectionsClient | null
  readonly sessionStatus: WebExtensionSessionStatus
  readonly podStatus: WebExtensionSolidPodStatus
  readonly error?: Error
  readonly login: () => Promise<void>
  readonly openExternal: (url: string) => Promise<void>
  readonly clientConfigurationBridge?: AiClientConfigurationBridge
  readonly selectedProvider: AiConnectionsProvider
  readonly searchQuery: string
  readonly providerStates: Partial<Record<AiConnectionsProvider, ProviderProductState>>
  readonly providerSummaries: Partial<Record<AiConnectionsProvider, AiProviderConnectionSummary>>
  readonly providerLoadError?: string
  readonly serviceAccessState: ServiceAccessState
  selectProvider(provider: AiConnectionsProvider): void
  selectFirstUnconfiguredProvider(): void
  setSearchQuery(value: string): void
  setProviderState(provider: AiConnectionsProvider, state: ProviderProductState): void
  ensureServiceAccess(): Promise<void>
  revokeServiceAccess(): Promise<void>
  loadProviders(): Promise<void>
  subscribe(listener: () => void): () => void
}

export function createAiConnectionsController(host: WebExtensionHost): AiConnectionsController {
  const sessionSnapshot = host.solid.session.getSnapshot()
  const sessionStatus = sessionStatusFromSnapshot(sessionSnapshot)
  const pod = host.solid.pod
  const authenticated = sessionSnapshot.status === 'authenticated'
    && pod.status === 'ready'
  const client = authenticated
    ? createAiConnectionsClient({
        webId: sessionSnapshot.webId,
        podBaseUrl: pod.current.podUrl,
        authenticatedFetch: host.solid.session.fetch,
      })
    : null
  let selectedProvider: AiConnectionsProvider = 'openai'
  let searchQuery = ''
  let providerStates: Partial<Record<AiConnectionsProvider, ProviderProductState>> = {}
  let providerSummaries: Partial<Record<AiConnectionsProvider, AiProviderConnectionSummary>> = {}
  let providerLoadError: string | undefined
  let providerLoadGeneration = 0
  let providerLoadPromise: Promise<void> | undefined
  let serviceAccessState: ServiceAccessState = client ? 'checking' : 'missing'
  let serviceAccessPromise: Promise<void> | undefined
  const listeners = new Set<() => void>()
  const notify = () => listeners.forEach((listener) => listener())

  const controller: AiConnectionsController = {
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
    selectFirstUnconfiguredProvider() {
      const currentIndex = PROVIDERS.findIndex((candidate) => candidate.id === selectedProvider)
      const ordered = currentIndex < 0
        ? PROVIDERS
        : [...PROVIDERS.slice(currentIndex + 1), ...PROVIDERS.slice(0, currentIndex + 1)]
      const provider = ordered.find(
        (candidate) => providerStates[candidate.id] === 'unconfigured' && candidate.id !== selectedProvider,
      ) ?? PROVIDERS.find(
        (candidate) => providerStates[candidate.id] === 'unconfigured',
      ) ?? PROVIDERS[0]
      if (provider) controller.selectProvider(provider.id)
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
          const descriptor = parseAiConnectionsServiceAccess(
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
        const descriptor = parseAiConnectionsServiceAccess(
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

export function useSelectedProvider(controller: AiConnectionsController): AiConnectionsProvider {
  return useSyncExternalStore(
    controller.subscribe,
    () => controller.selectedProvider,
    () => controller.selectedProvider,
  )
}

export function useProviderSearch(controller: AiConnectionsController): string {
  return useSyncExternalStore(
    controller.subscribe,
    () => controller.searchQuery,
    () => controller.searchQuery,
  )
}

export function useProviderStates(
  controller: AiConnectionsController,
): Partial<Record<AiConnectionsProvider, ProviderProductState>> {
  return useSyncExternalStore(
    controller.subscribe,
    () => controller.providerStates,
    () => controller.providerStates,
  )
}

export function useProviderSummaries(
  controller: AiConnectionsController,
): Partial<Record<AiConnectionsProvider, AiProviderConnectionSummary>> {
  return useSyncExternalStore(
    controller.subscribe,
    () => controller.providerSummaries,
    () => controller.providerSummaries,
  )
}

export function useProviderLoadError(controller: AiConnectionsController): string | undefined {
  return useSyncExternalStore(
    controller.subscribe,
    () => controller.providerLoadError,
    () => controller.providerLoadError,
  )
}

export function useServiceAccessState(controller: AiConnectionsController): ServiceAccessState {
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
  return isApiKeyConnectionSummary(summary) ? 'configured' : 'connected'
}

function durableSummaryFromProductState(
  provider: AiConnectionsProvider,
  state: ProviderProductState,
): AiProviderConnectionSummary | undefined {
  if (state === 'configured') {
    return {
      provider,
      status: 'connected',
      authMode: 'apiKey',
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
        modes: ['browserAssistedApiKey'],
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

export function isApiKeyConnectionSummary(summary: AiProviderConnectionSummary): boolean {
  return summary.status === 'connected'
    && summary.connect.configured
    && summary.connect.modes.includes('browserAssistedApiKey')
    && summary.authMode === 'apiKey'
}

function errorMessage(error: unknown): string {
  return normalizeAiConnectionsThrownError(error)
}
