import { useSyncExternalStore } from 'react'
import type {
  AiConnectionsPodStore,
  WebExtensionHost,
  WebExtensionSessionStatus,
  WebExtensionSolidPodStatus,
} from '@undefineds.co/extension-sdk/web'
import {
  AI_CONNECTIONS_PROVIDERS,
  createAiConnectionsClient,
  normalizeAiConnectionsThrownError,
  withAiClientCredentialsGatewayKeys,
  type AiConnectionsClient,
  type AiConnectionsMode,
  type AiConnectionsProvider,
  type AiGatewayModel,
  type AiProviderConnectionSummary,
  type AiProviderCredentialSummary,
  type AiProviderSummary,
} from './ai-connections-client'
import type { AiClientConfigurationBridge } from './AiClientConfigurationSection'
import { parseAiConnectionsServiceAccess } from './service-access'

export interface AiProviderDefinition {
  id: AiConnectionsProvider
  name: string
  browserMode: 'browserAssistedApiKey' | 'deviceCodeOAuth' | 'connectUnsupported'
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
  readonly providerSummaries: Partial<Record<AiConnectionsProvider, AiProviderSummary>>
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
    ? createInteractiveAiConnectionsClient(
      host.capabilities.aiClientCredentials
        ? withAiClientCredentialsGatewayKeys(createAiConnectionsClient({
          webId: sessionSnapshot.webId,
          podBaseUrl: pod.current.podUrl,
          authenticatedFetch: host.solid.session.fetch,
        }), host.capabilities.aiClientCredentials)
        : createAiConnectionsClient({
        webId: sessionSnapshot.webId,
        podBaseUrl: pod.current.podUrl,
        authenticatedFetch: host.solid.session.fetch,
      }),
      host.capabilities.aiConnectionsPodStore,
    )
    : null
  let selectedProvider: AiConnectionsProvider = 'openai'
  let searchQuery = ''
  let providerStates: Partial<Record<AiConnectionsProvider, ProviderProductState>> = {}
  let providerSummaries: Partial<Record<AiConnectionsProvider, AiProviderSummary>> = {}
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
      const product = durableProviderFromProductState(provider, state)
      if (product) {
        providerSummaries = {
          ...providerSummaries,
          [provider]: product,
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
        providerSummaries = Object.fromEntries(summaries.map((summary) => [summary.id, summary]))
        providerStates = Object.fromEntries(
          PROVIDERS.map((provider) => [
            provider.id,
            productStateFromProvider(providerSummaries[provider.id]),
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

function createInteractiveAiConnectionsClient(
  operationsClient: AiConnectionsClient,
  podStore?: AiConnectionsPodStore,
): AiConnectionsClient {
  if (!podStore) return operationsClient
  return {
    ...operationsClient,
    listProviders: async () => podStore.listProviders() as Promise<AiProviderSummary[]>,
    listModels: podStore.listModels
      ? async () => podStore.listModels!() as Promise<AiGatewayModel[]>
      : operationsClient.listModels,
    createApiKeyCredential: podStore.createApiKeyCredential
      ? async (provider, input) =>
          podStore.createApiKeyCredential!(provider, input) as Promise<AiProviderCredentialSummary>
      : operationsClient.createApiKeyCredential,
    updateProviderCredential: podStore.updateProviderCredential
      ? async (provider, credentialId, input) =>
          podStore.updateProviderCredential!(provider, credentialId, input) as Promise<AiProviderCredentialSummary>
      : operationsClient.updateProviderCredential,
    deleteProviderCredential: podStore.deleteProviderCredential
      ? async (provider, credentialId) =>
          podStore.deleteProviderCredential!(provider, credentialId) as Promise<AiProviderCredentialSummary | undefined>
      : operationsClient.deleteProviderCredential,
    pollDevice: podStore.saveOAuthCredential
      ? async (provider, attempt) => {
          const result = await operationsClient.pollDevice(provider, attempt)
          if (result.status !== 'completed' || !result.oauthCredential) return result
          const saved = await podStore.saveOAuthCredential!(provider, result.oauthCredential) as {
            id?: string
          } | undefined
          const { oauthCredential: _discarded, ...publicResult } = result
          return {
            ...publicResult,
            credentialId: saved?.id ?? result.credentialId,
          }
        }
      : operationsClient.pollDevice,
    refreshOAuthCredential: podStore.readCredentialSecret && podStore.updateOAuthCredential
      ? async (provider, credentialId, _refreshToken, _expectedVersion) => {
          const providers = await podStore.listProviders() as AiProviderSummary[]
          const credential = providers
            .find((item) => item.id === provider)
            ?.credentials.find((item) => item.id === credentialId)
          if (!credential) throw new Error('oauth_credential_not_found')
          const secret = await podStore.readCredentialSecret!(provider, credentialId)
          const refreshToken = typeof secret.refreshToken === 'string' ? secret.refreshToken : undefined
          if (!refreshToken) throw new Error('oauth_refresh_token_required')
          const result = await operationsClient.refreshOAuthCredential(
            provider,
            credentialId,
            refreshToken,
            credential.version,
          )
          if (result.status !== 'completed' || !result.oauthCredential) return result
          await podStore.updateOAuthCredential!(
            provider,
            credentialId,
            credential.version,
            result.oauthCredential,
          )
          const { oauthCredential: _discarded, ...publicResult } = result
          return publicResult
        }
      : operationsClient.refreshOAuthCredential,
    quota: podStore.readCredentialSecret
      ? async (provider) => {
          const providers = await podStore.listProviders() as AiProviderSummary[]
          const credential = providers
            .find((item) => item.id === provider)
            ?.credentials.find((item) => item.enabled)
          if (!credential) throw new Error('quota_credential_not_found')
          const secret = await podStore.readCredentialSecret!(provider, credential.id)
          return operationsClient.quotaFromSecret(provider, {
            credentialId: credential.id,
            credentialIri: credential.id,
            authMode: credential.authMode === 'deviceCode' || credential.authMode === 'oauth'
              ? 'deviceCodeOAuth'
              : 'apiKey',
            offeringId: credential.offeringId,
            baseUrl: credential.baseUrl,
            secret,
          })
        }
      : operationsClient.quota,
    disconnect: async (provider, credentialId) => {
      if (!credentialId || !podStore.deleteProviderCredential) {
        return operationsClient.disconnect(provider, credentialId)
      }
      const deleted = await podStore.deleteProviderCredential(provider, credentialId)
      return deleted as Awaited<ReturnType<AiConnectionsClient['disconnect']>>
    },
    discoverModels: podStore.readCredentialSecret
      ? async (provider, input) => {
          const summaries = await podStore.listProviders() as AiProviderSummary[]
          const product = summaries.find((item) => item.id === provider)
          const credentials = product?.credentials.filter((item) => (
            item.enabled
            && (!input?.offeringId || item.offeringId === input.offeringId)
            && (!input?.credentialId || item.id === input.credentialId)
          )) ?? []
          if (credentials.length === 0) throw new Error('models_credential_not_found')
          const settled = await Promise.allSettled(credentials.map(async (credential) => {
            const secret = await podStore.readCredentialSecret!(provider, credential.id)
            const discoverySecret = discoverySecretFromProviderSecret(secret, credential.authMode)
            if (!discoverySecret) throw new Error('models_secret_missing')
            return operationsClient.discoverModels(provider, {
              credentialId: credential.id,
              offeringId: credential.offeringId,
              authMode: credential.authMode === 'deviceCode' || credential.authMode === 'oauth'
                ? 'deviceCodeOAuth'
                : 'apiKey',
              secret: discoverySecret,
              baseUrl: credential.baseUrl,
            })
          }))
          const successful = settled
            .filter((result): result is PromiseFulfilledResult<Awaited<ReturnType<AiConnectionsClient['discoverModels']>>> => result.status === 'fulfilled')
            .map((result) => result.value)
          if (successful.length === 0) {
            throw (settled[0] as PromiseRejectedResult).reason
          }
          if (podStore.saveDiscoveredModels) {
            await Promise.all(successful.map((result) =>
              podStore.saveDiscoveredModels!(provider, result.credential, result.models)))
          }
          const models = [...new Map(successful.flatMap((result) => result.models).map((model) => [model.id, model])).values()]
          return { ...successful[0]!, models }
        }
      : operationsClient.discoverModels,
    saveModelSelection: podStore.saveModelSelection
      ? async (provider, modelIds) => podStore.saveModelSelection!(provider, modelIds)
      : operationsClient.saveModelSelection,
  }
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
    () => legacySummariesFor(controller.providerSummaries),
    () => legacySummariesFor(controller.providerSummaries),
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

function productStateFromProvider(
  product?: AiProviderSummary,
): ProviderProductState {
  if (!product || product.status === 'unconfigured' || product.status === 'unavailable') {
    return 'unconfigured'
  }
  if (product.status === 'configured') return 'configured'
  if (product.status === 'attention') return 'attention'
  const credential = primaryCredential(product)
  return credential?.authMode === 'oauth' || credential?.authMode === 'deviceCode'
    ? 'connected'
    : 'configured'
}

const legacySummaryCache = new WeakMap<
  Partial<Record<AiConnectionsProvider, AiProviderSummary>>,
  Partial<Record<AiConnectionsProvider, AiProviderConnectionSummary>>
>()

function legacySummariesFor(
  products: Partial<Record<AiConnectionsProvider, AiProviderSummary>>,
): Partial<Record<AiConnectionsProvider, AiProviderConnectionSummary>> {
  const cached = legacySummaryCache.get(products)
  if (cached) return cached
  const summaries = Object.fromEntries(
    Object.values(products).filter(isDefined).map((product) => [
      product.id,
      legacySummaryFromProviderProduct(product),
    ]),
  )
  legacySummaryCache.set(products, summaries)
  return summaries
}

function legacySummaryFromProviderProduct(product: AiProviderSummary): AiProviderConnectionSummary {
  const credential = primaryCredential(product)
  const status = product.status === 'available'
    ? 'connected'
    : product.status === 'attention'
      ? 'reauthRequired'
      : 'disconnected'
  const credentialMode = credential?.authMode
  return {
    provider: product.id,
    status,
    authMode: credentialMode === 'oauth' || credentialMode === 'deviceCode'
      ? 'deviceCodeOAuth'
      : credentialMode
        ? 'browserAssistedApiKey'
        : undefined,
    accountLabel: credential?.label,
    expiresAt: credential?.expiresAt,
    reauthRequired: status === 'reauthRequired' ? true : undefined,
    credentialIri: credential?.id,
    version: credential?.version,
    connect: {
      modes: connectModesFromProviderProduct(product),
      configured: product.status !== 'unavailable',
    },
  }
}

function connectModesFromProviderProduct(product: AiProviderSummary): AiConnectionsMode[] {
  const modes = [
    ...product.offerings.flatMap((offering) => offering.authModes ?? []),
    ...product.credentials.map((credential) => credential.authMode),
  ].map((authMode): AiConnectionsMode | undefined => (
    authMode === 'oauth' || authMode === 'deviceCode'
      ? 'deviceCodeOAuth'
      : authMode === 'apiKey' || authMode === 'local'
        ? 'browserAssistedApiKey'
        : undefined
  )).filter(isDefined)
  return modes.length > 0 ? [...new Set(modes)] : ['browserAssistedApiKey']
}

function primaryCredential(product: AiProviderSummary): AiProviderCredentialSummary | undefined {
  return product.credentials.find((credential) => credential.enabled) ?? product.credentials[0]
}

function durableProviderFromProductState(
  provider: AiConnectionsProvider,
  state: ProviderProductState,
): AiProviderSummary | undefined {
  if (state === 'configured') {
    return {
      id: provider,
      name: providerName(provider),
      offerings: [],
      credentials: [durableCredential(provider, 'apiKey')],
      selectedModels: [],
      status: 'available',
    }
  }

  if (state === 'connected') {
    return {
      id: provider,
      name: providerName(provider),
      offerings: [],
      credentials: [durableCredential(provider, 'deviceCode')],
      selectedModels: [],
      status: 'available',
    }
  }

  if (state === 'attention') {
    return undefined
  }

  if (state === 'loading') {
    return undefined
  }

  return {
    id: provider,
    name: providerName(provider),
    offerings: [],
    credentials: [],
    selectedModels: [],
    status: 'unconfigured',
  }
}

function durableCredential(
  provider: AiConnectionsProvider,
  authMode: AiProviderCredentialSummary['authMode'],
): AiProviderCredentialSummary {
  return {
    id: `${provider}:current`,
    offeringId: authMode === 'deviceCode' || authMode === 'oauth'
      ? 'official-subscription'
      : 'api-platform',
    authMode,
    enabled: true,
    priority: 0,
    health: 'healthy',
    version: 0,
  }
}

function providerName(provider: AiConnectionsProvider): string {
  return PROVIDERS.find((candidate) => candidate.id === provider)?.name ?? provider
}

function discoverySecretFromProviderSecret(
  secret: Record<string, unknown>,
  authMode: AiProviderCredentialSummary['authMode'],
): Record<string, unknown> | undefined {
  if (authMode === 'deviceCode' || authMode === 'oauth') {
    const accessToken = typeof secret.accessToken === 'string' && secret.accessToken.trim()
      ? secret.accessToken
      : undefined
    return accessToken ? { type: 'oauth', accessToken } : undefined
  }
  const apiKey = typeof secret.apiKey === 'string' && secret.apiKey.trim()
    ? secret.apiKey
    : undefined
  return apiKey ? { type: 'apiKey', apiKey } : undefined
}

function isDefined<T>(value: T | undefined): value is T {
  return value !== undefined
}

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message
    ? error.message
    : normalizeAiConnectionsThrownError(error)
}
