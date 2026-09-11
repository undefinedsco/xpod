import { useSyncExternalStore } from 'react'
import type {
  AiClientCredentialsCapability,
  AiConnectionsPodStore,
  WebExtensionHost,
} from '@undefineds.co/extension-sdk/web'
import {
  AI_CONNECTIONS_PROVIDERS,
  AiConnectionsRequestError,
  createAiConnectionsClient,
  normalizeAiConnectionsThrownError,
  type AiConnectionsClient,
  type AiConnectionsMode,
  type AiProviderAuthorizationMethodsSummary,
  type AiConnectionsProvider,
  type AiGatewayModel,
  type AiProviderConnectionSummary,
  type AiProviderCredentialSummary,
  type AiProviderSummary,
} from './ai-connections-client'
import type { AiClientConfigurationBridge } from './AiClientConfigurationSection'

export interface AiProviderDefinition {
  id: AiConnectionsProvider
  name: string
  browserMode: AiConnectionsMode
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
  { id: 'zhipu', name: '智谱 AI', browserMode: 'browserAssistedApiKey', browserLabel: '登录', description: '智谱 AI / GLM 模型服务', homeUrl: 'https://open.bigmodel.cn', apiKeyUrl: 'https://open.bigmodel.cn/usercenter/apikeys', apiKeyPlaceholder: 'id.secret-...', defaultBaseUrl: 'https://open.bigmodel.cn/api/paas/v4' },
  { id: 'ollama', name: 'Ollama', browserMode: 'connectUnsupported', browserLabel: '本地服务', description: '本地 Ollama 模型服务', homeUrl: 'https://ollama.com', defaultBaseUrl: 'http://localhost:11434/v1' },
  { id: 'custom', name: 'Custom', browserMode: 'browserAssistedApiKey', browserLabel: '配置', description: 'OpenAI / Anthropic 兼容的自定义模型服务', homeUrl: 'https://undefineds.co', apiKeyPlaceholder: 'sk-...', defaultBaseUrl: 'https://example.com/v1' },
]

export type ProviderProductState =
  | 'loading'
  | 'unconfigured'
  | 'configured'
  | 'connected'
  | 'attention'

export const AI_CONNECTIONS_PINNED_SECTIONS = [
  { id: 'keys', label: 'API Keys', title: 'API KEYS' },
] as const

export type AiConnectionsPinnedSection = typeof AI_CONNECTIONS_PINNED_SECTIONS[number]['id']
export type AiConnectionsWorkspaceSection = AiConnectionsPinnedSection | 'provider'

if (PROVIDERS.map((provider) => provider.id).join(',') !== AI_CONNECTIONS_PROVIDERS.join(',')) {
  throw new Error('AI Connection provider UI is out of sync with the client catalog')
}

export interface AiConnectionsController {
  readonly client: AiConnectionsClient | null
  readonly openExternal: (url: string) => Promise<void>
  readonly clientConfigurationBridge?: AiClientConfigurationBridge
  readonly selectedSection: AiConnectionsWorkspaceSection
  readonly selectedProvider: AiConnectionsProvider
  readonly selectedCredentialId?: string
  readonly searchQuery: string
  readonly providerStates: Partial<Record<AiConnectionsProvider, ProviderProductState>>
  readonly providerSummaries: Partial<Record<AiConnectionsProvider, AiProviderSummary>>
  readonly providerLoadError?: string
  selectSection(section: AiConnectionsPinnedSection): void
  selectProvider(provider: AiConnectionsProvider, credentialId?: string): void
  selectFirstUnconfiguredProvider(): void
  setSearchQuery(value: string): void
  setProviderState(provider: AiConnectionsProvider, state: ProviderProductState): void
  loadProviders(): Promise<void>
  subscribe(listener: () => void): () => void
}

export function createAiConnectionsController(host: WebExtensionHost): AiConnectionsController {
  const sessionSnapshot = host.solid.session.getSnapshot()
  const pod = host.solid.pod
  const readyPod = pod?.status === 'ready' ? pod : undefined
  const authenticated = sessionSnapshot.status === 'authenticated'
    && readyPod !== undefined
  const client = authenticated
    ? createInteractiveAiConnectionsClient(
      withAccountClientCredentials(createAiConnectionsClient({
        webId: sessionSnapshot.webId,
        podBaseUrl: readyPod.current.podUrl,
        authenticatedFetch: host.solid.session.fetch,
      }), host.capabilities.aiClientCredentials),
      host.capabilities.aiConnectionsPodStore,
    )
    : null
  let selectedSection: AiConnectionsWorkspaceSection = 'keys'
  let selectedProvider: AiConnectionsProvider = 'openai'
  let selectedCredentialId: string | undefined
  let searchQuery = ''
  let providerStates: Partial<Record<AiConnectionsProvider, ProviderProductState>> = {}
  let providerSummaries: Partial<Record<AiConnectionsProvider, AiProviderSummary>> = {}
  let providerLoadError: string | undefined
  let providerLoadGeneration = 0
  let providerLoadPromise: Promise<void> | undefined
  const listeners = new Set<() => void>()
  const notify = () => listeners.forEach((listener) => listener())

  const controller: AiConnectionsController = {
    client,
    openExternal: host.navigation.openExternal,
    clientConfigurationBridge: host.capabilities.aiClientConfiguration,
    get selectedSection() {
      return selectedSection
    },
    get selectedProvider() {
      return selectedProvider
    },
    get selectedCredentialId() {
      return selectedCredentialId
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
    selectSection(section) {
      if (selectedSection === section) return
      selectedSection = section
      notify()
    },
    selectProvider(provider, credentialId) {
      const nextCredentialId = provider === 'custom' ? credentialId : undefined
      if (
        selectedSection === 'provider'
        && selectedProvider === provider
        && selectedCredentialId === nextCredentialId
      ) return
      selectedSection = 'provider'
      selectedProvider = provider
      selectedCredentialId = nextCredentialId
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
      const product = providerSummaries[provider] ? undefined : durableProviderFromProductState(provider, state)
      if (product) {
        providerSummaries = {
          ...providerSummaries,
          [provider]: product,
        }
      }
      notify()
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

function withAccountClientCredentials(
  client: AiConnectionsClient,
  credentials?: AiClientCredentialsCapability,
): AiConnectionsClient {
  return {
    ...client,
    async createGatewayKey({ name }) {
      if (!credentials) throw new Error('当前账号登录状态不支持创建客户端凭据。')
      const issued = await credentials.create({ name, webId: client.webId })
      try {
        return await client.createGatewayKey({ name, apiKey: issued.apiKey, credentialResource: issued.resource })
      } catch (cause) {
        try {
          await credentials.revoke({ ...issued, webId: client.webId })
        } catch {
          throw new Error('API Key 未能保存到 Pod，且账号凭据撤销失败。该凭据尚未应用到客户端。')
        }
        throw cause
      }
    },
    async deleteGatewayKey(keyId) {
      const record = (await client.listGatewayKeys()).find((key) => key.id === keyId)
      if (record?.kind === 'client-credentials') {
        if (!credentials || !record.credentialResource) {
          throw new Error('当前账号登录状态无法撤销此客户端凭据，Key 记录已保留。')
        }
        const apiKey = await client.revealGatewayKey(keyId)
        await credentials.revoke({ apiKey, resource: record.credentialResource, webId: client.webId })
      }
      await client.deleteGatewayKey(keyId)
    },
  }
}

function createInteractiveAiConnectionsClient(
  operationsClient: AiConnectionsClient,
  podStore?: AiConnectionsPodStore,
): AiConnectionsClient {
  if (!podStore) return operationsClient
  const refreshTasks = new Map<string, ReturnType<AiConnectionsClient['refreshOAuthCredential']>>()
  const refreshOAuthCredential: AiConnectionsClient['refreshOAuthCredential'] =
    podStore.readCredentialSecret && podStore.updateOAuthCredential
      ? (provider, credentialId) => {
          const key = JSON.stringify([provider, credentialId])
          const pending = refreshTasks.get(key)
          if (pending) return pending
          const task = (async () => {
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
              credential.offeringId,
              secret.authorizationMethodId === 'browser-oauth' ? 'authorizationCodeOAuth' : undefined,
            )
            if (result.status !== 'completed' || !result.oauthCredential) throw new Error('oauth_refresh_failed')
            await podStore.updateOAuthCredential!(
              provider,
              credentialId,
              credential.version,
              result.oauthCredential,
            )
            const { oauthCredential: _discarded, ...publicResult } = result
            return publicResult
          })().finally(() => { refreshTasks.delete(key) })
          refreshTasks.set(key, task)
          return task
        }
      : operationsClient.refreshOAuthCredential

  const readUsableCredential = async (
    provider: AiConnectionsProvider,
    credential: AiProviderCredentialSummary,
    forceRefresh = false,
  ) => {
    let didRefresh = false
    let secret = await podStore.readCredentialSecret!(provider, credential.id)
    const expiresAt = typeof secret.expiresAt === 'string' ? secret.expiresAt : credential.expiresAt
    if ((credential.authMode === 'oauth' || credential.authMode === 'deviceCode')
      && (forceRefresh || (expiresAt && Date.parse(expiresAt) <= Date.now() + 60_000))) {
      if (!podStore.updateOAuthCredential) throw new Error('oauth_refresh_unavailable')
      await refreshOAuthCredential(provider, credential.id, '', credential.version)
      const providers = await podStore.listProviders() as AiProviderSummary[]
      const current = providers.find((item) => item.id === provider)
        ?.credentials.find((item) => item.id === credential.id)
      if (!current) throw new Error('oauth_credential_not_found')
      didRefresh = true
      credential = current
      secret = await podStore.readCredentialSecret!(provider, credential.id)
    }
    return { credential, secret, didRefresh }
  }
  return {
    ...operationsClient,
    listProviders: async () => mergeAuthorizationMethodsIntoProviders(
      await podStore.listProviders() as AiProviderSummary[],
      operationsClient.listAuthorizationMethods
        ? await operationsClient.listAuthorizationMethods()
        : [],
    ),
    listModels: podStore.listModels
      ? async () => podStore.listModels!() as Promise<AiGatewayModel[]>
      : operationsClient.listModels,
    createApiKeyCredential: podStore.createApiKeyCredential
      ? async (provider, input) =>
          podStore.createApiKeyCredential!(provider, input) as Promise<AiProviderCredentialSummary>
      : operationsClient.createApiKeyCredential,
    createLocalCredential: podStore.createLocalCredential
      ? async (provider, input) => input.authorizationMethodId === 'local-session-import'
        || (!input.authorizationMethodId && input.offeringId === 'official-subscription')
        ? operationsClient.createLocalCredential(provider, input)
        : podStore.createLocalCredential!(provider, input) as Promise<AiProviderCredentialSummary>
      : operationsClient.createLocalCredential,
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
    refreshOAuthCredential,
    quota: podStore.readCredentialSecret
      ? async (provider, _refresh = false, input) => {
          const providers = await podStore.listProviders() as AiProviderSummary[]
          const credentials = providers
            .find((item) => item.id === provider)
            ?.credentials ?? []
          const requestedCredentialId = input?.credentialId ?? input?.credentialIri
          const credential = requestedCredentialId
            ? credentials.find((item) => item.id === requestedCredentialId)
            : credentials.find((item) => item.enabled && (!input?.offeringId || item.offeringId === input.offeringId))
          if (!credential) throw new Error('quota_credential_not_found')
          const { secret } = await readUsableCredential(provider, credential)
          const quotaSecret = discoverySecretFromProviderSecret(secret, credential.authMode)
          if (!quotaSecret) throw new Error('credential_secret_unavailable')
          return operationsClient.quotaFromSecret(provider, {
            credentialId: credential.id,
            credentialIri: credential.id,
            authMode: credential.authMode === 'deviceCode' || credential.authMode === 'oauth'
              ? 'deviceCodeOAuth'
              : 'apiKey',
            offeringId: credential.offeringId,
            baseUrl: credential.baseUrl,
            proxyUrl: credential.proxyUrl,
            compatibility: credential.compatibility,
            secret: quotaSecret,
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
    testProviderCredential: podStore.readCredentialSecret
      ? async (provider, input) => {
          const summaries = await podStore.listProviders() as AiProviderSummary[]
          let credential = summaries
            .find((item) => item.id === provider)
            ?.credentials.find((item) => item.id === input.credentialId)
          if (!credential) throw new Error('test_credential_not_found')
          const usable = await readUsableCredential(provider, credential)
          credential = usable.credential
          const { secret } = usable
          const discoverySecret = discoverySecretFromProviderSecret(secret, credential.authMode)
          if (!discoverySecret) throw new Error('test_secret_missing')
          let result
          try {
            result = await operationsClient.discoverModels(provider, {
              credentialId: credential.id,
              offeringId: credential.offeringId,
              authMode: credential.authMode === 'deviceCode' || credential.authMode === 'oauth'
                ? 'deviceCodeOAuth'
                : credential.authMode === 'local' ? 'local' : 'apiKey',
              secret: discoverySecret,
              baseUrl: credential.baseUrl,
              proxyUrl: credential.proxyUrl,
              compatibility: credential.compatibility,
            })
          } catch (error) {
            await podStore.markCredentialHealth?.(
              provider,
              credential.id,
              'invalid',
              credential.version,
            ).catch(() => undefined)
            throw error
          }
          const persistedCredential = await podStore.markCredentialHealth?.(
            provider,
            credential.id,
            'healthy',
            credential.version,
          )
          return {
            ok: true,
            credentialId: credential.id,
            ...(persistedCredential ? { credential: persistedCredential } : {}),
            modelCount: result.models.length,
            observedAt: result.observedAt,
          }
        }
      : operationsClient.testProviderCredential,
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
          const scopeFor = (credential: AiProviderCredentialSummary) => JSON.stringify([
            provider,
            credential.offeringId,
            (credential.baseUrl ?? '').trim().replace(/\/+$/u, ''),
            input?.compatibility ?? credential.compatibility ?? 'auto',
            // Custom model catalogs are persisted per connection instance.
            provider === 'custom' ? credential.id : undefined,
          ])
          const scopes = new Map<string, AiProviderCredentialSummary[]>()
          for (const credential of [...credentials].sort((left, right) => left.priority - right.priority)) {
            const scope = scopeFor(credential)
            const candidates = scopes.get(scope) ?? []
            candidates.push(credential)
            scopes.set(scope, candidates)
          }
          const settled = await Promise.allSettled([...scopes.values()].map(async (candidates) => {
            let lastError: unknown
            for (const credential of candidates) {
              try {
                let usable = await readUsableCredential(provider, credential)
                const discover = () => {
                  const discoverySecret = discoverySecretFromProviderSecret(usable.secret, credential.authMode)
                  if (!discoverySecret) throw new Error('models_secret_missing')
                  return operationsClient.discoverModels(provider, {
                    credentialId: credential.id,
                    offeringId: credential.offeringId,
                    authMode: credential.authMode === 'deviceCode' || credential.authMode === 'oauth'
                      ? 'deviceCodeOAuth'
                      : credential.authMode === 'local' ? 'local' : 'apiKey',
                    secret: discoverySecret,
                    baseUrl: credential.baseUrl,
                    proxyUrl: credential.proxyUrl,
                    compatibility: input?.compatibility ?? credential.compatibility,
                  })
                }
                let result
                try {
                  result = await discover()
                } catch (error) {
                  if (usable.didRefresh || !(error instanceof AiConnectionsRequestError)
                    || error.code !== 'provider_models_fetch_failed' || error.providerStatus !== 401
                    || (credential.authMode !== 'oauth' && credential.authMode !== 'deviceCode')) throw error
                  usable = await readUsableCredential(provider, usable.credential, true)
                  result = await discover()
                }
                return {
                  ...result,
                  credential: credential.id,
                  credentialVersion: usable.credential.version,
                  models: result.models.map((model) => ({
                    ...model,
                    offeringId: credential.offeringId,
                    ...(provider === 'custom' ? { credentialId: credential.id } : {}),
                  })),
                }
              } catch (error) {
                lastError = error
              }
            }
            throw lastError
          }))
          const successful = settled.flatMap((result) => result.status === 'fulfilled' ? [result.value] : [])
          if (successful.length === 0) {
            throw (settled[0] as PromiseRejectedResult).reason
          }
          for (const result of successful) {
            await podStore.markCredentialHealth?.(
              provider,
              result.credential,
              'healthy',
              result.credentialVersion,
            )
          }
          const modelKey = (model: (typeof successful)[number]['models'][number]) =>
            `${model.offeringId}\0${model.credentialId ?? ''}\0${('resourceId' in model ? model.resourceId : undefined) ?? model.id}`
          if (podStore.saveDiscoveredModels) {
            try {
              const failedOfferings = new Set([...scopes.values()].flatMap((candidates, index) =>
                settled[index]?.status === 'rejected' ? [candidates[0]!.offeringId] : []))
              const catalogs = new Map<string, { credential: string; models: typeof successful[number]['models'] }>()
              for (const result of successful) {
                const credential = credentials.find((item) => item.id === result.credential)!
                // A partial catalog must not mark models from a failed endpoint missing.
                if (provider !== 'custom' && failedOfferings.has(credential.offeringId)) continue
                const key = provider === 'custom' ? credential.id : credential.offeringId
                const catalog = catalogs.get(key) ?? { credential: credential.id, models: [] }
                catalog.models.push(...result.models)
                catalogs.set(key, catalog)
              }
              // Each offering shares a Pod model document; persist its union once, serially.
              for (const catalog of catalogs.values()) {
                await podStore.saveDiscoveredModels(provider, catalog.credential,
                  [...new Map(catalog.models.map((model) => [modelKey(model), model])).values()])
              }
            } catch {
              throw new Error('models_persistence_failed')
            }
          }
          const models = [...new Map(successful.flatMap((result) => result.models).map((model) => [
            modelKey(model), model,
          ])).values()]
          return { ...successful[0]!, models, complete: successful.length === scopes.size }
        }
      : operationsClient.discoverModels,
    saveModelSelection: podStore.saveModelSelection
      ? async (provider, modelIds, credentialId) => podStore.saveModelSelection!(provider, modelIds, credentialId)
      : operationsClient.saveModelSelection,
  }
}

export function useSelectedSection(controller: AiConnectionsController): AiConnectionsWorkspaceSection {
  return useSyncExternalStore(
    controller.subscribe,
    () => controller.selectedSection ?? 'provider',
    () => controller.selectedSection ?? 'provider',
  )
}

export function useSelectedProvider(controller: AiConnectionsController): AiConnectionsProvider {
  return useSyncExternalStore(
    controller.subscribe,
    () => controller.selectedProvider,
    () => controller.selectedProvider,
  )
}

export function useSelectedCredentialId(controller: AiConnectionsController): string | undefined {
  return useSyncExternalStore(
    controller.subscribe,
    () => controller.selectedCredentialId,
    () => controller.selectedCredentialId,
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

export function useProviderProducts(
  controller: AiConnectionsController,
): Partial<Record<AiConnectionsProvider, AiProviderSummary>> {
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


function mergeAuthorizationMethodsIntoProviders(
  providers: AiProviderSummary[],
  methods: AiProviderAuthorizationMethodsSummary[],
): AiProviderSummary[] {
  if (methods.length === 0) return providers
  const methodsByOffering = new Map(methods.map((item) => [
    `${item.provider}:${item.offeringId}`,
    item,
  ]))
  return providers.map((provider) => ({
    ...provider,
    offerings: provider.offerings.map((offering) => {
      const capability = methodsByOffering.get(`${provider.id}:${offering.id}`)
      if (!capability) return offering
      const authorizationMethods = capability.authorizationMethods
      return {
        ...offering,
        ...(capability.endpoints ? { endpoints: capability.endpoints } : {}),
        ...(authorizationMethods.length ? {
          authorizationMethods,
          authModes: mergeAuthModes(offering.authModes, authorizationMethods.map((method) => method.authMode)),
        } : {}),
      }
    }),
  }))
}

function mergeAuthModes(
  current: AiProviderSummary['offerings'][number]['authModes'],
  next: NonNullable<AiProviderSummary['offerings'][number]['authModes']>,
): NonNullable<AiProviderSummary['offerings'][number]['authModes']> {
  return Array.from(new Set([...(current ?? []), ...next]))
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
  if (authMode === 'local') return { type: 'local' }
  const apiKey = typeof secret.apiKey === 'string' && secret.apiKey.trim()
    ? secret.apiKey
    : undefined
  return apiKey ? { type: 'apiKey', apiKey } : undefined
}

function isDefined<T>(value: T | undefined): value is T {
  return value !== undefined
}

function errorMessage(error: unknown): string {
  return normalizeAiConnectionsThrownError(error)
}
