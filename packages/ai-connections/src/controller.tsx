import { useSyncExternalStore } from 'react'
import type {
  AiClientCredentialsCapability,
  AiConnectionsPodStore,
  SolidLiveUpdateState,
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
} from '@undefineds.co/ai-connections-core/client'
import type { AiClientConfigurationBridge } from './AiClientConfigurationSection'
import {
  credentialCollectionRuntime,
  type CredentialCollection,
  type CredentialRow,
} from './collections'
import type { PodCollection } from '@undefineds.co/pod-collections'

/**
 * The four credential writes the collection can carry. The client dispatches to
 * them as soon as the lazily loaded layer has the table, and stays on the store
 * until then - the same two paths the controller has always had, chosen per call
 * instead of once at mount.
 */
type CredentialMutationOverrides = Pick<
  AiConnectionsClient,
  'createApiKeyCredential' | 'createLocalCredential' | 'updateProviderCredential' | 'deleteProviderCredential'
>

/** The live table as the interactive client sees it: fillable after the fact. */
interface LiveCredentialsAccess {
  collection(): CredentialCollection | undefined
  mutations(): CredentialMutationOverrides | undefined
}

export interface AiProviderDefinition {
  id: AiConnectionsProvider
  name: string
  description: string
  homeUrl: string
  apiKeyUrl?: string
  apiKeyPlaceholder?: string
  defaultBaseUrl?: string
}

/**
 * Provider pages explain themselves through the header's ⓘ tooltip, so each
 * description is one line of the same shape — where the models come from and how
 * this deployment can be authorized — instead of a restatement of the name.
 *
 * Connect actions are deliberately absent here: which ways in exist is offering
 * data (`authorizationMethods`), derived by the server per offering, and a
 * provider-level label is exactly how a page could offer a 「登录」 no offering
 * declares.
 */
export const PROVIDERS: AiProviderDefinition[] = [
  { id: 'openai', name: 'OpenAI', description: 'OpenAI 官方 GPT 与推理模型，支持 API Key 与订阅导入。', homeUrl: 'https://openai.com', apiKeyUrl: 'https://platform.openai.com/api-keys', apiKeyPlaceholder: 'sk-...', defaultBaseUrl: 'https://api.openai.com/v1' },
  { id: 'anthropic', name: 'Anthropic', description: 'Anthropic 官方 Claude 模型，支持 API Key 与订阅导入。', homeUrl: 'https://www.anthropic.com', apiKeyUrl: 'https://console.anthropic.com/settings/keys', apiKeyPlaceholder: 'sk-ant-...', defaultBaseUrl: 'https://api.anthropic.com' },
  { id: 'kimi', name: 'Kimi', description: '月之暗面 Kimi 模型，支持账号订阅、编码套餐与开放平台。', homeUrl: 'https://www.moonshot.cn', apiKeyUrl: 'https://platform.moonshot.cn/console/api-keys', apiKeyPlaceholder: 'sk-...', defaultBaseUrl: 'https://api.moonshot.cn/v1' },
  { id: 'bailian', name: '百炼', description: '阿里云百炼的通义千问等模型，提供按量与多种套餐。', homeUrl: 'https://www.aliyun.com/product/bailian', apiKeyUrl: 'https://bailian.console.aliyun.com/#/api-key', apiKeyPlaceholder: 'sk-...', defaultBaseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1' },
  { id: 'deepseek', name: 'DeepSeek', description: 'DeepSeek 官方模型，API Key 接入，接口兼容 OpenAI。', homeUrl: 'https://www.deepseek.com', apiKeyUrl: 'https://platform.deepseek.com/api_keys', apiKeyPlaceholder: 'sk-...', defaultBaseUrl: 'https://api.deepseek.com/v1' },
  { id: 'zhipu', name: '智谱 AI', description: '智谱 GLM 系列模型，支持 API Key 与 GLM 编码套餐。', homeUrl: 'https://open.bigmodel.cn', apiKeyUrl: 'https://open.bigmodel.cn/usercenter/apikeys', apiKeyPlaceholder: 'id.secret-...', defaultBaseUrl: 'https://open.bigmodel.cn/api/paas/v4' },
  { id: 'ollama', name: 'Ollama', description: '运行在本机的 Ollama 模型，无需 API Key，仅本机可达。', homeUrl: 'https://ollama.com', defaultBaseUrl: 'http://localhost:11434/v1' },
  { id: 'custom', name: 'Custom', description: '任意 OpenAI 或 Anthropic 兼容服务，自填地址与 API Key。', homeUrl: 'https://undefineds.co', apiKeyPlaceholder: 'sk-...', defaultBaseUrl: 'https://example.com/v1' },
]

export type ProviderProductState =
  | 'loading'
  | 'unconfigured'
  | 'configured'
  | 'connected'
  | 'attention'

export const AI_CONNECTIONS_PINNED_SECTIONS = [
  { id: 'keys', label: 'Xpod', title: 'API KEYS' },
] as const

/**
 * Coalescing window for Pod change signals.
 *
 * A notification only says "this document changed", so a burst of writes must
 * cost one re-read, not one per write; the first signal arms a fixed window and
 * everything arriving inside it is absorbed.
 */
export const TABLE_CHANGE_COALESCE_MS = 75

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
  /**
   * Whether the Pod table documents this page renders are pushing changes.
   *
   * `unavailable` also covers a host that offers no live-update capability at
   * all; either way the page keeps working from explicit reads.
   */
  readonly liveUpdates: SolidLiveUpdateState
  /**
   * The live credentials table (`settings/credentials.ttl`), when the host
   * exposes `podCollections` and the lazily loaded collection layer has landed.
   * The page renders its rows; the controller's own live-revision refresh does
   * not watch that document while this is present.
   */
  readonly credentialsCollection?: PodCollection<CredentialRow>
  /**
   * The collection's rows as its own change feed reports them, or `undefined`
   * while the layer is still loading, when the host offers no collection, or
   * after a failed first read. This is what the credentials list renders (and
   * what makes every credential write optimistic).
   */
  readonly credentialRows?: readonly CredentialRow[]
  /**
   * Advances once per coalesced burst of changes to those documents. Pages
   * re-read through the loaders they already have when it changes.
   */
  readonly liveRevision: number
  selectSection(section: AiConnectionsPinnedSection): void
  selectProvider(provider: AiConnectionsProvider, credentialId?: string): void
  selectFirstUnconfiguredProvider(): void
  setSearchQuery(value: string): void
  setProviderState(provider: AiConnectionsProvider, state: ProviderProductState): void
  loadProviders(): Promise<void>
  /**
   * Watches the table documents the open page renders: the credentials table
   * plus the open provider's document.
   *
   * Re-entrant and idempotent, so React StrictMode's setup/cleanup/setup cycle
   * stays harmless; releasing the last hold leaves no channel and no socket
   * behind for this page.
   */
  watchPageTables(): () => void
  cancelProviderLoads(): void
  subscribe(listener: () => void): () => void
}

class ProviderLoadCancelled extends Error {}

interface ProviderLoadGuard {
  assertCurrent(): void
  dispose(): void
  cancel(): void
}

export function createAiConnectionsController(host: WebExtensionHost): AiConnectionsController {
  const sessionSnapshot = host.solid.session.getSnapshot()
  const pod = host.solid.pod
  const readyPod = pod?.status === 'ready' ? pod : undefined
  const authenticated = sessionSnapshot.status === 'authenticated'
    && readyPod !== undefined
  /**
   * The live credentials table, when the host offers one.
   *
   * Declaring it here (and not in a page) is what keeps one table to one
   * collection: the page reads the same instance the client writes through.
   *
   * It is declared *asynchronously* and lands in `credentials` (+ `credentialRows`
   * and `credentialMutations`): the collection layer is loaded on demand through
   * `collections.credentialCollectionRuntime()` - the table declaration, the row
   * read and the credential writes all live in that chunk - so the applet renders
   * from the store first and upgrades to live rows when the collection's first
   * read is back. When the host offers no `podCollections` capability at all the
   * collection never lands and the controller behaves exactly as before
   * (`docs/pod-collections.md` §8.9).
   */
  let credentials: CredentialCollection | undefined
  let credentialRows: readonly CredentialRow[] | undefined
  let credentialMutations: CredentialMutationOverrides | undefined
  const liveCredentials: LiveCredentialsAccess = {
    collection: () => credentials,
    mutations: () => credentialMutations,
  }
  let providerLoadGeneration = 0
  let providerLoadPromise: Promise<void> | undefined
  let providerLoadOperation: object | undefined
  const activeProviderLoads = new Set<ProviderLoadGuard>()
  const isCurrentSession = () => {
    const current = host.solid.session.getSnapshot()
    return authenticated && current.status === 'authenticated' && current.webId === sessionSnapshot.webId
  }
  const cancelProviderLoads = () => {
    providerLoadGeneration += 1
    providerLoadOperation = undefined
    providerLoadPromise = undefined
    for (const guard of activeProviderLoads) guard.cancel()
  }
  const beginProviderLoad = (): ProviderLoadGuard => {
    const generation = providerLoadGeneration
    let invalidated = !isCurrentSession()
    let released = false
    let unsubscribe = () => undefined as void
    const guard: ProviderLoadGuard = {
      assertCurrent() {
        if (invalidated || generation !== providerLoadGeneration || !isCurrentSession()) throw new ProviderLoadCancelled()
      },
      dispose() {
        if (released) return
        released = true
        activeProviderLoads.delete(guard)
        unsubscribe()
      },
      cancel() {
        invalidated = true
        guard.dispose()
      },
    }
    activeProviderLoads.add(guard)
    let subscribing = true
    unsubscribe = host.solid.session.subscribe((current) => {
      // The Solid SDK deduplicates unchanged state except new LOGIN/RESTORED
      // sessions; SESSION_EXTENDED does not notify. Accept a synchronous initial
      // snapshot, then invalidate on every published session transition.
      if (!subscribing || current.status !== 'authenticated' || current.webId !== sessionSnapshot.webId) cancelProviderLoads()
    })
    subscribing = false
    // Also handle a host that synchronously publishes its state on subscribe.
    if (released) unsubscribe()
    return guard
  }
  const client = authenticated
    ? createInteractiveAiConnectionsClient(
      withAccountClientCredentials(createAiConnectionsClient({
        webId: sessionSnapshot.webId,
        podBaseUrl: readyPod.current.podUrl,
        authenticatedFetch: host.solid.session.fetch,
      }), host.capabilities.aiClientCredentials),
      host.capabilities.aiConnectionsPodStore,
      liveCredentials,
      beginProviderLoad,
    )
    : null
  let selectedSection: AiConnectionsWorkspaceSection = 'keys'
  let selectedProvider: AiConnectionsProvider = 'openai'
  let selectedCredentialId: string | undefined
  let searchQuery = ''
  let providerStates: Partial<Record<AiConnectionsProvider, ProviderProductState>> = {}
  let providerSummaries: Partial<Record<AiConnectionsProvider, AiProviderSummary>> = {}
  let providerLoadError: string | undefined
  const listeners = new Set<() => void>()
  const notify = () => listeners.forEach((listener) => listener())

  const notifications = host.capabilities.solidNotifications
  const podStore = host.capabilities.aiConnectionsPodStore
  /** Release function per watched topic document; one entry per document. */
  const tableSubscriptions = new Map<string, () => void>()
  let pageTableHolds = 0
  let liveUpdates: SolidLiveUpdateState = currentLiveUpdates()
  let liveRevision = 0
  let coalesceTimer: ReturnType<typeof setTimeout> | undefined

  function scheduleLiveRefresh(): void {
    if (coalesceTimer !== undefined) return
    coalesceTimer = setTimeout(() => {
      coalesceTimer = undefined
      liveRevision += 1
      notify()
    }, TABLE_CHANGE_COALESCE_MS)
  }

  /**
   * The documents the open page renders *and* this controller refreshes; a table
   * is one document, never a row.
   *
   * One table has exactly one refresh path. The credentials table is owned by
   * the collection when the host exposes one - the collection subscribes to the
   * same notification primitive with the same document - so it is left out here;
   * without a collection it stays on this path, exactly as before. The open
   * provider's document is always this path's (P4 moves it).
   */
  function pageTableDocuments(): string[] {
    if (!podStore) return []
    const documents = new Set<string>()
    const credentialsDocument = credentials ? undefined : podStore.credentialsTableDocument?.()
    if (credentialsDocument) documents.add(credentialsDocument)
    if (selectedSection === 'provider') {
      const provider = podStore.providerTableDocument?.(selectedProvider, selectedCredentialId)
      if (provider) documents.add(provider)
    }
    return [...documents]
  }

  function releaseTableSubscriptions(): void {
    for (const [document, release] of tableSubscriptions) {
      tableSubscriptions.delete(document)
      release()
    }
  }

  function syncTableSubscriptions(): void {
    if (!notifications || pageTableHolds === 0) return
    const wanted = new Set(pageTableDocuments())
    for (const [document, release] of tableSubscriptions) {
      if (wanted.has(document)) continue
      tableSubscriptions.delete(document)
      release()
    }
    for (const document of wanted) {
      if (tableSubscriptions.has(document)) continue
      tableSubscriptions.set(document, notifications.watch(document, scheduleLiveRefresh))
    }
  }

  /**
   * The availability signal the page shows.
   *
   * With a live collection the page's truth is the *collection's* sync state,
   * not the transport's global state: `live` only when the table's own feed is
   * established and the transport is actually pushing. Without one, this is the
   * transport's state, exactly as before.
   */
  function currentLiveUpdates(): SolidLiveUpdateState {
    const transport = notifications ? notifications.getState() : 'unavailable'
    if (!credentials || !host.capabilities.podCollections) return transport
    const sync = host.capabilities.podCollections.syncState(credentials.collection)
    if (sync === 'unavailable' || sync === 'degraded' || transport === 'unavailable') {
      return 'unavailable'
    }
    return sync === 'live' && transport === 'live' ? 'live' : 'idle'
  }

  notifications?.subscribeState(() => {
    const next = currentLiveUpdates()
    if (next === liveUpdates) return
    liveUpdates = next
    notify()
  })
  host.capabilities.podCollections?.subscribeSyncState(() => {
    const next = currentLiveUpdates()
    if (next === liveUpdates) return
    liveUpdates = next
    notify()
  })

  /**
   * The page's live rows: re-read from the collection when it changes, and
   * `undefined` until its first read lands (or forever, when there is no
   * collection). One snapshot object per change keeps `useSyncExternalStore`
   * stable between reads.
   */
  function publishCredentialRows(): void {
    const collection = credentials?.collection
    const next = collection?.isReady()
      ? collection.toArray as unknown as readonly CredentialRow[]
      : undefined
    if (next === credentialRows) return
    credentialRows = next
    notify()
  }

  /**
   * Adopt the host's credentials collection once the lazy layer has it.
   *
   * Three things change at once, and they have to change together: the rows the
   * page renders (from the collection's own change feed and status), the
   * credential mutations (the client dispatches to them from now on), and the
   * fallback table watch - the credentials document leaves the controller's
   * `liveRevision` path because the collection now owns that table, which has to
   * happen by releasing the subscription the controller opened before the
   * collection arrived.
   */
  function adoptCredentials(loaded: CredentialCollection, mutations: CredentialMutationOverrides): void {
    credentials = loaded
    credentialMutations = mutations
    const collection = loaded.collection
    // The collection is owned by the host capability and lives as long as the
    // session; these two subscriptions live with it rather than with the page.
    collection.subscribeChanges(() => publishCredentialRows())
    collection.on('status:change', () => publishCredentialRows())
    publishCredentialRows()
    syncTableSubscriptions()
    notify()
  }

  // A host that offers no collection never fetches the layer: the capability is
  // checked before the dynamic import, not inside it.
  if (authenticated && sessionSnapshot.webId && host.capabilities.podCollections) {
    void credentialCollectionRuntime()
      .then(async (runtime) => {
        const loaded = await runtime.openCredentialCollection(host)
        if (!loaded || !podStore) return
        adoptCredentials(loaded, runtime.collectionCredentialMutations(loaded, podStore))
      })
      // No collection layer (chunk unavailable, layout underivable, table
      // undefined): the page keeps the store's own reads, as before.
      .catch(() => undefined)
  }

  const controller: AiConnectionsController = {
    client,
    openExternal: host.navigation.openExternal,
    clientConfigurationBridge: host.capabilities.aiClientConfiguration,
    get credentialsCollection() {
      return credentials?.collection
    },
    get credentialRows() {
      return credentialRows
    },
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
    get liveUpdates() {
      return liveUpdates
    },
    get liveRevision() {
      return liveRevision
    },
    watchPageTables() {
      pageTableHolds += 1
      syncTableSubscriptions()
      let released = false
      return () => {
        if (released) return
        released = true
        pageTableHolds -= 1
        if (pageTableHolds > 0) return
        pageTableHolds = 0
        releaseTableSubscriptions()
      }
    },
    selectSection(section) {
      if (selectedSection === section) return
      selectedSection = section
      syncTableSubscriptions()
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
      syncTableSubscriptions()
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
    cancelProviderLoads,
    async loadProviders() {
      if (!client) return
      if (providerLoadPromise) return providerLoadPromise
      const operation = {}
      providerLoadOperation = operation
      const generation = ++providerLoadGeneration
      const load = Promise.resolve().then(async () => {
        if (providerLoadOperation !== operation) return
        providerLoadError = undefined
        notify()
        try {
          const summaries = await client.listProviders()
          if (generation !== providerLoadGeneration || !isCurrentSession()) return
          providerSummaries = Object.fromEntries(summaries.map((summary) => [summary.id, summary]))
          providerStates = Object.fromEntries(
            PROVIDERS.map((provider) => [
              provider.id,
              productStateFromProvider(providerSummaries[provider.id]),
            ]),
          )
          notify()
        } catch (error) {
          if (error instanceof ProviderLoadCancelled || generation !== providerLoadGeneration || !isCurrentSession()) return
          providerLoadError = errorMessage(error)
          notify()
        } finally {
          if (providerLoadOperation === operation) {
            providerLoadOperation = undefined
            providerLoadPromise = undefined
          }
        }
      })
      providerLoadPromise = load
      return load
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
    async createGatewayKey(input) {
      if (!credentials) throw new Error('当前账号登录状态不支持创建客户端凭据。')
      const issued = await credentials.create({ name: input.name, webId: client.webId })
      try {
        // The wrapper is issued here; the declared purpose and the rest of the
        // caller's input travel with it so the record keeps where it applies.
        return await client.createGatewayKey({
          ...input,
          apiKey: issued.apiKey,
          credentialResource: issued.resource,
        })
      } catch (cause) {
        try {
          await credentials.revoke({
            clientId: clientIdFromApiKey(issued.apiKey), resource: issued.resource, webId: client.webId,
          })
        } catch {
          throw new Error('API Key 未能保存到 Pod，且账号凭据撤销失败。该凭据尚未应用到客户端。')
        }
        throw cause
      }
    },
    async deleteGatewayKey(keyId) {
      const record = (await client.listGatewayKeys()).find((key) => key.id === keyId)
      if (record?.kind === 'client-credentials') {
        if (!credentials || !record.clientCredentialId) {
          throw new Error('当前账号登录状态无法撤销此客户端凭据，Key 记录已保留。')
        }
        const issued = await credentials.list()
        const target = issued.find((entry) => entry.clientId === record.clientCredentialId)
        if (!target) throw new Error('账号服务中已找不到该客户端凭据，请刷新后重试。')
        await credentials.revoke({ clientId: target.clientId, resource: target.resource, webId: client.webId })
      }
      await client.deleteGatewayKey(keyId)
    },
  }
}

function createInteractiveAiConnectionsClient(
  operationsClient: AiConnectionsClient,
  podStore: AiConnectionsPodStore | undefined,
  live: LiveCredentialsAccess,
  beginProviderLoad: () => ProviderLoadGuard,
): AiConnectionsClient {
  const listProviders = async () => {
    const guard = beginProviderLoad()
    try {
      guard.assertCurrent()
      const providers = podStore
        ? await podStore.listProviders() as AiProviderSummary[]
        : await operationsClient.listProviders()
      guard.assertCurrent()
      if (!podStore) return providers
      const methods = operationsClient.listAuthorizationMethods
        ? await operationsClient.listAuthorizationMethods()
        : []
      guard.assertCurrent()
      return mergeAuthorizationMethodsIntoProviders(providers, methods)
    } finally {
      guard.dispose()
    }
  }
  if (!podStore) return { ...operationsClient, listProviders }
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
  const storeClient: AiConnectionsClient = {
    ...operationsClient,
    listProviders,
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

  /**
   * With a live credentials collection, credential writes go through it: the
   * page sees them immediately, they roll back on rejection, and the document's
   * own echo reconciles instead of overwriting.
   *
   * The collection may not be there yet (the layer loads lazily) and may never
   * be (a host without the capability), so this dispatches per call: until the
   * table lands, every write is the store's own, exactly as before.
   *
   * Reads of credentials stay in `listProviders` for now (it also carries
   * providers and models); the page renders the credential lists from the
   * collection's rows, and the store's summary of the same row is only the
   * enrichment for attributes the descriptor cannot project.
   */
  const credentialStore: Pick<
    AiConnectionsClient,
    'createApiKeyCredential' | 'createLocalCredential' | 'updateProviderCredential' | 'deleteProviderCredential'
  > = {
    createApiKeyCredential: (provider, input) =>
      live.mutations()?.createApiKeyCredential(provider, input)
      ?? storeClient.createApiKeyCredential(provider, input),
    // Two local-connection flows are account/Gateway operations, not Pod rows.
    createLocalCredential: (provider, input) => (
      input.authorizationMethodId === 'local-session-import'
        || (!input.authorizationMethodId && input.offeringId === 'official-subscription')
        ? storeClient.createLocalCredential(provider, input)
        : live.mutations()?.createLocalCredential(provider, input)
          ?? storeClient.createLocalCredential(provider, input)
    ),
    updateProviderCredential: (provider, credentialId, input) =>
      live.mutations()?.updateProviderCredential(provider, credentialId, input)
      ?? storeClient.updateProviderCredential(provider, credentialId, input),
    deleteProviderCredential: (provider, credentialId) =>
      live.mutations()?.deleteProviderCredential(provider, credentialId)
      ?? storeClient.deleteProviderCredential(provider, credentialId),
  }
  return { ...storeClient, ...credentialStore }
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

/**
 * Providers this deployment offers, as reported by the server.
 *
 * Cloud answers with the operator-designated providers only (no self-hosted
 * `custom`, no local daemon), so the settings surface cannot offer a provider the
 * deployment does not provide. Before the first successful load this is
 * `undefined`, which keeps every provider visible (Local behavior).
 */
export function useAvailableProviders(controller: AiConnectionsController): AiConnectionsProvider[] | undefined {
  const summaries = useProviderSummaries(controller)
  const ids = Object.keys(summaries) as AiConnectionsProvider[]
  return ids.length > 0 ? ids : undefined
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

/** Whether live Pod updates are on, for a status affordance that stays small. */
export function useLiveUpdates(controller: AiConnectionsController): SolidLiveUpdateState {
  return useSyncExternalStore(
    controller.subscribe,
    () => controller.liveUpdates,
    () => controller.liveUpdates,
  )
}

/** Advances once per coalesced burst of Pod changes; drives page re-reads. */
export function useLiveRevision(controller: AiConnectionsController): number {
  return useSyncExternalStore(
    controller.subscribe,
    () => controller.liveRevision,
    () => controller.liveRevision,
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
      // The server's list is authoritative, an empty one included: it omits a
      // connect entry this build has not implemented, and that omission has to
      // survive the merge rather than fall back to deriving one from `authModes`.
      const authorizationMethods = capability.authorizationMethods
      return {
        ...offering,
        ...(capability.endpoints ? { endpoints: capability.endpoints } : {}),
        authorizationMethods,
        authModes: mergeAuthModes(offering.authModes, authorizationMethods.map((method) => method.authMode)),
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

/** The wrapper carries the OIDC client id; parsing it needs no stored secret. */
function clientIdFromApiKey(apiKey: string): string {
  const decoded = atob(apiKey.replace(/^sk-/u, ''))
  const separator = decoded.indexOf(':')
  if (separator <= 0) throw new Error('客户端凭据格式无效。')
  return decoded.slice(0, separator)
}
