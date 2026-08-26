import {
  aiConfigModelRef,
  aiModelResource,
  aiProviderResource,
  buildAIConfigDisconnectPlan,
  buildAIConfigMutationPlan,
  buildAIConfigProviderStateMap,
  credentialResource,
  filterAIModelCapabilityUris,
  filterAIModelModalities,
  normalizeAIConfigModelId,
  normalizeAIConfigProviderId,
  normalizeAIConfigResourceId,
  sameAIConfigProviderFamily,
  selectAIConfigCredential,
  toAIModelCapabilityName,
  type AIConfigModel,
  type AIModelRow,
  type AIProviderRow,
  type CredentialRow,
  type SolidDatabase,
} from '@undefineds.co/models'

aiProviderResource.setSparqlEndpoint('/settings/-/sparql')
credentialResource.setSparqlEndpoint('/settings/-/sparql')
aiModelResource.setSparqlEndpoint('/settings/-/sparql')

export const AI_CONNECTIONS_PROVIDERS = [
  'openai',
  'anthropic',
  'kimi',
  'bailian',
  'deepseek',
] as const

export type AiConnectionsProvider = (typeof AI_CONNECTIONS_PROVIDERS)[number]
export type AiConnectionsMode =
  | 'browserAssistedApiKey'
  | 'deviceCodeOAuth'
  | 'connectUnsupported'
export type AiConnectStatus =
  | 'pending'
  | 'authorization_pending'
  | 'slow_down'
  | 'completed'
  | 'expired'
  | 'cancelled'
  | 'unsupported'

export interface AiConnectAttempt {
  mode: AiConnectionsMode
  status: AiConnectStatus
  provider: AiConnectionsProvider
  attemptId?: string
  state?: string
  signature?: string
  expiresAt?: string
  authorizationUrl?: string
  userCode?: string
  verificationUri?: string
  verificationUriComplete?: string
  intervalSeconds?: number
  apiKeyManagementSupported?: boolean
  credentialId?: string
  message?: string
}

export interface AiConnectionsCredential {
  id: string
  credentialIri: string
  webId: string
  provider: AiConnectionsProvider
  authMode: string
  status: string
  accountLabel?: string
  expiresAt?: string
  version?: number
  reauthRequired?: boolean
}

export interface AiQuotaWindow {
  name?: string
  limit?: number
  used?: number
  remaining?: number
  resetsAt?: string
  [key: string]: unknown
}

export interface AiQuotaSnapshot {
  credential: string
  status: 'available' | 'unsupported' | 'error'
  balance?: number
  windows: AiQuotaWindow[]
  observedAt: string
  expiresAt: string
  source: string
  stale?: boolean
}

export interface AiModelSummary {
  id: string
  provider: AiConnectionsProvider | 'undefineds'
  displayName?: string
  contextWindow?: number
  protocols?: string[]
  custom?: boolean
  inputModalities?: string[]
  outputModalities?: string[]
  capabilities?: string[]
}

export interface DiscoveredProviderModel {
  id: string
  displayName?: string
  capabilities?: string[]
}

export interface CustomProviderModel {
  id: string
  displayName?: string
  inputModalities?: string[]
  outputModalities?: string[]
  capabilities?: string[]
}

export interface ProviderModelDiscovery {
  provider: AiConnectionsProvider
  models: DiscoveredProviderModel[]
  observedAt: string
  source: string
}

export interface AiProviderConnectionSummary {
  provider: AiConnectionsProvider
  status: 'connected' | 'disconnected' | 'reauthRequired'
  authMode?: string
  accountLabel?: string
  baseUrl?: string
  expiresAt?: string
  reauthRequired?: boolean
  credentialIri?: string
  version?: number
  connect: {
    modes: AiConnectionsMode[]
    configured: boolean
    message?: string
  }
}

export interface AiConnectionsClient {
  readonly webId: string
  readonly apiBase: string
  listProviders(): Promise<AiProviderConnectionSummary[]>
  listModels(): Promise<AiModelSummary[]>
  beginConnect(provider: AiConnectionsProvider, mode: AiConnectionsMode): Promise<AiConnectAttempt>
  connectStatus(provider: AiConnectionsProvider, attempt: Pick<AiConnectAttempt, 'attemptId' | 'state' | 'signature'>): Promise<AiConnectAttempt>
  completeApiKey(
    provider: AiConnectionsProvider,
    attempt: Pick<AiConnectAttempt, 'attemptId' | 'state' | 'signature'>,
    apiKey: string,
    accountLabel?: string,
    baseUrl?: string,
  ): Promise<AiConnectAttempt>
  pollDevice(provider: AiConnectionsProvider, attempt: Pick<AiConnectAttempt, 'attemptId' | 'state' | 'signature'>): Promise<AiConnectAttempt>
  disconnect(provider: AiConnectionsProvider): Promise<AiConnectionsCredential | undefined>
  quota(provider: AiConnectionsProvider, refresh?: boolean): Promise<AiQuotaSnapshot>
  discoverModels(provider: AiConnectionsProvider): Promise<ProviderModelDiscovery>
  saveProviderModel(provider: AiConnectionsProvider, model: CustomProviderModel): Promise<CustomProviderModel[]>
  deleteProviderModel(provider: AiConnectionsProvider, modelId: string): Promise<CustomProviderModel[]>
}

export const AI_CONNECTIONS_GENERIC_ERROR_MESSAGE = 'AI Connection request failed. Please try again.'

interface CreateAiConnectionsClientInput {
  webId: string
  podBaseUrl: string
  authenticatedFetch: typeof fetch
  database: SolidDatabase
}

export function resolveAiConnectionsApiBase(podBaseUrl: string): string {
  const parsed = new URL(podBaseUrl)
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new Error('Current Pod URL must use HTTP or HTTPS')
  }
  return parsed.origin
}

export function createAiConnectionsClient({
  webId,
  podBaseUrl,
  authenticatedFetch,
  database,
}: CreateAiConnectionsClientInput): AiConnectionsClient {
  const apiBase = resolveAiConnectionsApiBase(podBaseUrl)

  const request = async <T>(
    path: string,
    method: 'GET' | 'POST' | 'DELETE',
    body?: Record<string, unknown>,
    context: { provider?: AiConnectionsProvider } = {},
  ): Promise<T> => {
    const response = await authenticatedFetch(`${apiBase}${path}`, {
      method,
      credentials: 'omit',
      mode: 'cors',
      headers: {
        accept: 'application/json',
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    })
    const payload = await readJson(response)
    if (!response.ok) {
      throw new Error(normalizeAiConnectionsErrorMessage(payload, response.status, context))
    }
    return payload as T
  }

  const providerPath = (provider: AiConnectionsProvider): string => {
    assertProvider(provider)
    return `/api/ai/connections/providers/${provider}`
  }

  const loadConfigRows = () => loadAiConfigRows(database)

  const credentialForProvider = async (provider: AiConnectionsProvider): Promise<ProviderProbeCredential> => {
    const rows = await loadConfigRows()
    const selection = selectAIConfigCredential(provider, rows.credentialRows, rows.providerRows)
    if (!selection?.apiKey) {
      throw new Error('not_configured')
    }
    return {
      apiKey: selection.apiKey,
      baseUrl: selection.baseUrl,
    }
  }

  return {
    webId,
    apiBase,

    async listProviders() {
      const rows = await loadConfigRows()
      const states = buildAIConfigProviderStateMap({
        catalog: providerCatalog(),
        providerRows: rows.providerRows,
        credentialRows: rows.credentialRows,
        modelRows: rows.modelRows,
      })
      return AI_CONNECTIONS_PROVIDERS.map((provider) =>
        providerSummaryFromState(provider, states[provider]),
      )
    },

    async listModels() {
      const payload = await request<{ data?: unknown[] }>('/v1/models', 'GET')
      const platformModels = Array.isArray(payload.data)
        ? payload.data.map(parseModelSummary).filter(isDefined)
        : []
      const rows = await loadConfigRows()
      const podModels = rows.modelRows
        .map((row) => modelSummaryFromPodRow(row))
        .filter(isDefined)
      return dedupeModels([ ...podModels, ...platformModels ])
    },

    async beginConnect(provider, mode) {
      assertProvider(provider)
      if (mode !== 'browserAssistedApiKey') {
        return {
          mode,
          status: 'unsupported',
          provider,
          message: `${providerLabel(provider)} does not support this operation.`,
        }
      }
      const descriptor = providerBrowserConnectDescriptor(provider)
      return {
        mode,
        status: descriptor.supported ? 'pending' : 'unsupported',
        provider,
        authorizationUrl: descriptor.apiKeyUrl,
        apiKeyManagementSupported: Boolean(descriptor.apiKeyUrl),
        message: descriptor.supported ? undefined : `${providerLabel(provider)} does not support this operation.`,
      }
    },

    connectStatus(provider, attempt) {
      assertProvider(provider)
      return Promise.resolve({
        mode: 'browserAssistedApiKey',
        status: 'pending',
        provider,
        attemptId: attempt.attemptId,
        state: attempt.state,
        signature: attempt.signature,
      })
    },

    async completeApiKey(provider, attempt, apiKey, accountLabel, baseUrl) {
      assertProvider(provider)
      const rows = await loadConfigRows()
      const plan = buildAIConfigMutationPlan({
        providerId: provider,
        currentProviderRows: rows.providerRows,
        currentCredentialRows: rows.credentialRows,
        currentModelRows: rows.modelRows,
        updates: {
          enabled: true,
          apiKey,
          baseUrl,
          credentialLabel: accountLabel,
        },
      })
      await applyAiConfigMutationPlan(database, rows, plan)
      return {
        mode: 'browserAssistedApiKey',
        status: 'completed',
        provider,
        attemptId: attempt.attemptId,
        state: attempt.state,
        signature: attempt.signature,
        credentialId: plan.credentialPayload?.id,
      }
    },

    pollDevice(provider, attempt) {
      assertProvider(provider)
      return Promise.resolve({
        mode: 'deviceCodeOAuth',
        status: 'unsupported',
        provider,
        attemptId: attempt.attemptId,
        state: attempt.state,
        signature: attempt.signature,
      })
    },

    async disconnect(provider) {
      assertProvider(provider)
      const rows = await loadConfigRows()
      const plan = buildAIConfigDisconnectPlan({
        providerId: provider,
        currentCredentialRows: rows.credentialRows,
      })
      await applyAiConfigDisconnectPlan(database, plan)
      return {
        id: plan.credentialDeleteIds[0] ?? provider,
        credentialIri: plan.credentialDeleteIds[0] ?? provider,
        webId,
        provider,
        authMode: 'apiKey',
        status: 'disconnected',
      }
    },

    async quota(provider, refresh = false) {
      const credential = await credentialForProvider(provider)
      return request<AiQuotaSnapshot>(
        `${providerPath(provider)}/quota/refresh`,
        'POST',
        credential,
        { provider },
      )
    },

    async discoverModels(provider) {
      const credential = await credentialForProvider(provider)
      const payload = await request<unknown>(
        `${providerPath(provider)}/models/refresh`,
        'POST',
        credential,
        { provider },
      )
      return parseModelDiscovery(payload, provider)
    },

    async saveProviderModel(provider, model) {
      assertProvider(provider)
      const rows = await loadConfigRows()
      const existing = customModelsForProvider(rows.modelRows, provider)
      const next = upsertCustomModel(existing, {
        id: model.id,
        displayName: model.displayName,
        inputModalities: model.inputModalities,
        outputModalities: model.outputModalities,
        capabilities: model.capabilities,
      })
      const plan = buildAIConfigMutationPlan({
        providerId: provider,
        currentProviderRows: rows.providerRows,
        currentCredentialRows: rows.credentialRows,
        currentModelRows: rows.modelRows,
        updates: { models: next.map(aiConfigModelFromCustomModel) },
      })
      await applyAiConfigMutationPlan(database, rows, plan)
      return next
    },

    async deleteProviderModel(provider, modelId) {
      assertProvider(provider)
      const rows = await loadConfigRows()
      const next = customModelsForProvider(rows.modelRows, provider)
        .filter((model) => model.id !== modelId)
      const plan = buildAIConfigMutationPlan({
        providerId: provider,
        currentProviderRows: rows.providerRows,
        currentCredentialRows: rows.credentialRows,
        currentModelRows: rows.modelRows,
        updates: { models: next.map(aiConfigModelFromCustomModel) },
      })
      await applyAiConfigMutationPlan(database, rows, plan)
      return next
    },
  }
}

type AiConfigRows = {
  providerRows: Array<Partial<AIProviderRow> & Record<string, unknown>>
  credentialRows: Array<Partial<CredentialRow> & Record<string, unknown>>
  modelRows: Array<Partial<AIModelRow> & Record<string, unknown>>
}

type ProviderProbeCredential = {
  apiKey: string
  baseUrl?: string
}

type AiConnectionsDb = Pick<SolidDatabase, 'select' | 'insert' | 'findById' | 'updateById' | 'deleteById'> & {
  init?: (...resources: unknown[]) => Promise<void>
}

async function loadAiConfigRows(database: SolidDatabase): Promise<AiConfigRows> {
  const db = database as AiConnectionsDb
  await db.init?.(aiProviderResource, credentialResource, aiModelResource)
  const [ providerRows, credentialRows, modelRows ] = await Promise.all([
    selectAllRows(db, aiProviderResource),
    selectAllRows(db, credentialResource),
    selectAllRows(db, aiModelResource),
  ])
  return {
    providerRows: providerRows as AiConfigRows['providerRows'],
    credentialRows: credentialRows as AiConfigRows['credentialRows'],
    modelRows: modelRows as AiConfigRows['modelRows'],
  }
}

async function selectAllRows(db: AiConnectionsDb, resource: unknown): Promise<Record<string, unknown>[]> {
  return await (db.select().from(resource as never).execute() as Promise<Record<string, unknown>[]>)
}

async function applyAiConfigMutationPlan(
  database: SolidDatabase,
  rows: AiConfigRows,
  plan: ReturnType<typeof buildAIConfigMutationPlan>,
): Promise<void> {
  const db = database as AiConnectionsDb
  if (plan.providerPayload) {
    const existingProvider = rows.providerRows.find((row) =>
      sameAIConfigProviderFamily(rowKey(row), plan.providerId),
    )
    await upsertById(db, aiProviderResource, existingProvider, plan.providerPayload)
  }

  if (plan.credentialPayload) {
    const credentialId = normalizeAIConfigResourceId(plan.credentialPayload.id)
    const existingCredential = rows.credentialRows.find((row) =>
      normalizeAIConfigResourceId(rowKey(row)) === credentialId,
    ) ?? rows.credentialRows.find((row) =>
      sameAIConfigProviderFamily(stringValue(row.provider), plan.providerId),
    )
    await upsertById(db, credentialResource, existingCredential, plan.credentialPayload)
  }

  const modelsForProvider = rows.modelRows.filter((row) =>
    sameAIConfigProviderFamily(stringValue(row.isProvidedBy), plan.providerId),
  )
  for (const payload of plan.modelUpserts) {
    const modelId = normalizeAIConfigModelId(payload.id, plan.providerId)
    const existingModel = modelsForProvider.find((row) =>
      normalizeAIConfigModelId(rowKey(row), plan.providerId) === modelId,
    )
    await upsertById(db, aiModelResource, existingModel, payload)
  }
  for (const modelId of plan.modelDeleteIds) {
    const normalizedModelId = normalizeAIConfigModelId(modelId, plan.providerId)
    const existingModel = modelsForProvider.find((row) =>
      normalizeAIConfigModelId(rowKey(row), plan.providerId) === normalizedModelId,
    )
    if (existingModel) {
      await db.deleteById(aiModelResource, rowKey(existingModel))
    }
  }
}

async function applyAiConfigDisconnectPlan(
  database: SolidDatabase,
  plan: ReturnType<typeof buildAIConfigDisconnectPlan>,
): Promise<void> {
  const db = database as AiConnectionsDb
  for (const credentialId of plan.credentialDeleteIds) {
    await db.deleteById(credentialResource, credentialId)
  }
}

async function upsertById(
  db: AiConnectionsDb,
  resource: unknown,
  existing: Record<string, unknown> | undefined,
  payload: Record<string, unknown>,
): Promise<void> {
  const id = normalizeAIConfigResourceId(stringValue(payload.id))
  if (!id) return
  const clean = compactObject(payload)
  if (existing) {
    const { id: _id, '@id': _iri, ...patch } = clean
    await db.updateById(resource as never, rowKey(existing), patch)
    return
  }
  await db.insert(resource as never).values(clean as never).execute()
}

function rowKey(row: Record<string, unknown>): string {
  const key = stringValue(row.id) ?? stringValue(row['@id'])
  if (!key) {
    throw new Error('AI config row is missing id')
  }
  return key
}

function providerCatalog() {
  return AI_CONNECTIONS_PROVIDERS.map((provider) => ({
    id: provider,
    displayName: providerLabel(provider),
    defaultBaseUrl: providerBrowserConnectDescriptor(provider).defaultBaseUrl,
  }))
}

function providerSummaryFromState(
  provider: AiConnectionsProvider,
  state: ReturnType<typeof buildAIConfigProviderStateMap>[string] | undefined,
): AiProviderConnectionSummary {
  const connected = Boolean(state?.enabled && state.apiKey)
  return compactObject({
    provider,
    status: connected ? 'connected' : 'disconnected',
    authMode: connected ? 'apiKey' : undefined,
    accountLabel: state?.credentialLabel,
    baseUrl: state?.baseUrl,
    credentialIri: state?.credentialId,
    connect: {
      modes: ['browserAssistedApiKey'],
      configured: connected,
      message: providerBrowserConnectDescriptor(provider).supported
        ? undefined
        : `${providerLabel(provider)} does not support this operation.`,
    },
  }) as AiProviderConnectionSummary
}

function modelSummaryFromPodRow(row: Partial<AIModelRow> & Record<string, unknown>): AiModelSummary | undefined {
  const id = normalizeAIConfigModelId(stringValue(row.id) ?? stringValue(row['@id']))
  if (!id) return undefined
  const provider = providerFromRelation(stringValue(row.isProvidedBy))
  if (!provider) return undefined
  const capabilities = semanticCapabilityNames(row.capabilities)
  const inputModalities = filterAIModelModalities(row.inputModalities)
  const outputModalities = filterAIModelModalities(row.outputModalities)
  return compactObject({
    id,
    provider,
    displayName: stringValue(row.displayName),
    custom: true,
    inputModalities: inputModalities.length > 0 ? inputModalities : undefined,
    outputModalities: outputModalities.length > 0 ? outputModalities : undefined,
    capabilities: capabilities.length > 0 ? capabilities : undefined,
  }) as AiModelSummary
}

function providerFromRelation(value: string | undefined): AiModelSummary['provider'] | undefined {
  if (!value) return undefined
  const provider = normalizeAIConfigProviderId(value)
  if (provider === 'undefineds') return 'undefineds'
  return providerValue(provider)
}

function dedupeModels(models: AiModelSummary[]): AiModelSummary[] {
  const byKey = new Map<string, AiModelSummary>()
  for (const model of models) {
    byKey.set(`${model.provider}:${model.id}`, model)
  }
  return Array.from(byKey.values())
}

function customModelsForProvider(
  rows: AiConfigRows['modelRows'],
  provider: AiConnectionsProvider,
): CustomProviderModel[] {
  return rows
    .filter((row) => sameAIConfigProviderFamily(stringValue(row.isProvidedBy), provider))
    .map((row): CustomProviderModel | undefined => {
      const id = normalizeAIConfigModelId(stringValue(row.id) ?? stringValue(row['@id']), provider)
      if (!id) return undefined
      const capabilities = semanticCapabilityNames(row.capabilities)
      const inputModalities = filterAIModelModalities(row.inputModalities)
      const outputModalities = filterAIModelModalities(row.outputModalities)
      return compactObject({
        id,
        displayName: stringValue(row.displayName),
        inputModalities: inputModalities.length > 0 ? inputModalities : undefined,
        outputModalities: outputModalities.length > 0 ? outputModalities : undefined,
        capabilities: capabilities.length > 0 ? capabilities : undefined,
      }) as CustomProviderModel
    })
    .filter(isDefined)
}

function upsertCustomModel(models: CustomProviderModel[], model: CustomProviderModel): CustomProviderModel[] {
  const byId = new Map(models.map((item) => [ item.id, item ] as const))
  byId.set(model.id, compactObject(model as unknown as Record<string, unknown>) as unknown as CustomProviderModel)
  return Array.from(byId.values())
}

function aiConfigModelFromCustomModel(model: CustomProviderModel): AIConfigModel {
  return {
    id: model.id,
    name: model.displayName ?? model.id,
    enabled: true,
    capabilities: model.capabilities ?? [],
    modelType: 'chat',
    isCustom: true,
  }
}

function providerBrowserConnectDescriptor(provider: AiConnectionsProvider): {
  supported: boolean
  apiKeyUrl?: string
  defaultBaseUrl?: string
} {
  switch (provider) {
    case 'openai':
      return { supported: true, apiKeyUrl: 'https://platform.openai.com/api-keys', defaultBaseUrl: 'https://api.openai.com/v1' }
    case 'anthropic':
      return { supported: true, apiKeyUrl: 'https://console.anthropic.com/settings/keys', defaultBaseUrl: 'https://api.anthropic.com/v1' }
    case 'kimi':
      return { supported: true, apiKeyUrl: 'https://platform.moonshot.cn/console/api-keys', defaultBaseUrl: 'https://api.moonshot.ai/v1' }
    case 'bailian':
      return { supported: true, apiKeyUrl: 'https://bailian.console.aliyun.com/#/api-key', defaultBaseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1' }
    case 'deepseek':
      return { supported: false, apiKeyUrl: 'https://platform.deepseek.com/api_keys', defaultBaseUrl: 'https://api.deepseek.com/v1' }
  }
}

export function normalizeAiConnectionsThrownError(error: unknown): string {
  if (error instanceof Error) {
    return normalizeAiConnectionsErrorText(error.message)
  }
  return normalizeAiConnectionsErrorText(String(error))
}

export function normalizeAiConnectionsErrorMessage(
  payload: unknown,
  status: number,
  context: { provider?: AiConnectionsProvider } = {},
): string {
  const code = errorCodeFromPayload(payload)
  if (code === 'provider_models_fetch_failed') {
    const providerStatus = isRecord(payload) && typeof payload.providerStatus === 'number'
      ? payload.providerStatus
      : undefined
    return modelDiscoveryErrorMessage(providerStatus)
  }
  const coded = code ? messageForSafeErrorCode(code, context.provider) : undefined
  if (coded) return coded

  const text = isRecord(payload) && typeof payload.error === 'string'
    ? payload.error
    : undefined
  if (text) {
    const exact = messageForSafeErrorCode(text, context.provider)
    if (exact) return exact
  }

  if (status === 401) return 'Please sign in again to continue.'
  if (status === 403) return 'AI Connection permission was denied.'
  if (status === 404 && context.provider) {
    return `${providerLabel(context.provider)} connection is not configured.`
  }
  if (status === 429) return 'AI Connection is rate limited. Please try again later.'
  if (status === 503) return 'AI Connection service is unavailable.'
  return AI_CONNECTIONS_GENERIC_ERROR_MESSAGE
}

const MODEL_DISCOVERY_SAFE_MESSAGES = new Set([
  '密钥不可用。请检查密钥是否填写正确，或换一个密钥后重试。',
  '模型服务地址不正确。请检查服务地址后重试。',
  '请求太频繁。请稍等一会儿再试。',
  '模型服务暂时没有响应。请稍后重试。',
  '模型列表获取失败。请检查密钥、服务地址或网络后重试。',
])

function normalizeAiConnectionsErrorText(message: string): string {
  const exact = messageForSafeErrorCode(message)
  if (exact) return exact
  const prefix = message.split(':', 1)[0]?.trim()
  const prefixed = prefix ? messageForSafeErrorCode(prefix) : undefined
  if (prefixed) return prefixed
  if (MODEL_DISCOVERY_SAFE_MESSAGES.has(message)) return message
  if (message.startsWith('invalid_')) return 'AI Connection returned an invalid response.'
  return AI_CONNECTIONS_GENERIC_ERROR_MESSAGE
}

function errorCodeFromPayload(payload: unknown): string | undefined {
  if (!isRecord(payload)) return undefined
  if (typeof payload.code === 'string') return payload.code
  if (typeof payload.errorCode === 'string') return payload.errorCode
  if (typeof payload.error === 'string' && /^[a-z][a-z0-9_:-]{0,80}$/i.test(payload.error)) {
    return payload.error
  }
  return undefined
}

function messageForSafeErrorCode(
  code: string,
  provider?: AiConnectionsProvider,
): string | undefined {
  switch (code.trim().toLowerCase().replace(/-/g, '_')) {
    case 'not_configured':
    case 'notconfigured':
      return provider
        ? `${providerLabel(provider)} connection is not configured.`
        : 'AI provider connection is not configured.'
    case 'unsupported':
      return provider
        ? `${providerLabel(provider)} does not support this operation.`
        : 'This AI Connection operation is not supported.'
    case 'service_identity_unavailable':
      return 'AI Connection probe is unavailable.'
    case 'unauthorized':
      return 'Please sign in again to continue.'
    case 'forbidden':
    case 'permission_denied':
      return 'AI Connection permission was denied.'
    case 'rate_limited':
      return 'AI Connection is rate limited. Please try again later.'
    case 'service_unavailable':
      return 'AI Connection service is unavailable.'
    default:
      return undefined
  }
}

function modelDiscoveryErrorMessage(providerStatus: number | undefined): string {
  if (providerStatus === 401 || providerStatus === 403) {
    return '密钥不可用。请检查密钥是否填写正确，或换一个密钥后重试。'
  }
  if (providerStatus === 404) {
    return '模型服务地址不正确。请检查服务地址后重试。'
  }
  if (providerStatus === 429) {
    return '请求太频繁。请稍等一会儿再试。'
  }
  if (providerStatus !== undefined && providerStatus >= 500) {
    return '模型服务暂时没有响应。请稍后重试。'
  }
  return '模型列表获取失败。请检查密钥、服务地址或网络后重试。'
}

function providerLabel(provider: AiConnectionsProvider): string {
  switch (provider) {
    case 'openai': return 'OpenAI'
    case 'anthropic': return 'Anthropic'
    case 'kimi': return 'Kimi'
    case 'bailian': return 'Bailian'
    case 'deepseek': return 'DeepSeek'
  }
}

async function readJson(response: Response): Promise<unknown> {
  const text = await response.text()
  if (!text) return undefined
  try {
    return JSON.parse(text)
  } catch {
    throw new Error(`AI Connection returned invalid JSON (${response.status})`)
  }
}

function assertProvider(provider: string): asserts provider is AiConnectionsProvider {
  if (!(AI_CONNECTIONS_PROVIDERS as readonly string[]).includes(provider)) {
    throw new Error(`Unsupported AI provider: ${provider}`)
  }
}

function stringListValue(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  const list = value.filter((item): item is string => typeof item === 'string')
  return list.length > 0 ? list : undefined
}

function semanticCapabilityNames(value: unknown): string[] {
  return filterAIModelCapabilityUris(value)
    .map(toAIModelCapabilityName)
    .filter(isDefined)
}

function parseModelSummary(value: unknown): AiModelSummary | undefined {
  if (!isRecord(value) || typeof value.id !== 'string') return undefined
  const provider = isPlatformModelId(value.id)
    ? 'undefineds'
    : providerValue(value.provider)
    ?? providerValue(value.providerId)
    ?? providerValue(value.owned_by)
    ?? providerFromModelId(value.id)
  if (!provider) return undefined

  return compactObject({
    id: value.id,
    provider,
    displayName: stringValue(value.displayName) ?? stringValue(value.display_name) ?? stringValue(value.name),
    contextWindow: numberValue(value.contextWindow) ?? numberValue(value.context_window),
    protocols: Array.isArray(value.protocols)
      ? value.protocols.filter((protocol): protocol is string => typeof protocol === 'string')
      : undefined,
    custom: value.custom === true ? true : undefined,
    inputModalities: modalitiesFromWire(value.modalities, 'input'),
    outputModalities: modalitiesFromWire(value.modalities, 'output'),
    capabilities: modelCapabilitiesFromWire(value),
  }) as unknown as AiModelSummary
}

function modalitiesFromWire(value: unknown, direction: 'input' | 'output'): string[] | undefined {
  if (!isRecord(value)) return undefined
  const list = value[direction]
  if (!Array.isArray(list)) return undefined
  const modalities = list.filter((item): item is string => typeof item === 'string')
  return modalities.length > 0 ? modalities : undefined
}

function modelCapabilitiesFromWire(value: Record<string, unknown>): string[] | undefined {
  if (Array.isArray(value.custom_capabilities)) {
    const custom = value.custom_capabilities.filter((cap): cap is string => typeof cap === 'string')
    if (custom.length > 0) return custom
  }
  if (!isRecord(value.capabilities)) return undefined
  const capabilities: string[] = []
  if (value.capabilities.imageInput === true) capabilities.push('image')
  if (value.capabilities.toolCalls === true) capabilities.push('tool_call')
  if (value.capabilities.reasoningEffort === true) capabilities.push('reasoning')
  return capabilities.length > 0 ? capabilities : undefined
}

function isPlatformModelId(modelId: string): boolean {
  const normalized = modelId.toLowerCase()
  return normalized === 'linx'
    || normalized === 'linx-lite'
    || normalized === 'undefineds/linx'
    || normalized === 'undefineds/linx-lite'
}

function providerValue(value: unknown): AiConnectionsProvider | undefined {
  if (typeof value !== 'string') return undefined
  const normalized = value.toLowerCase()
  if (normalized === 'undefineds') return undefined
  if (normalized === 'alibaba' || normalized === 'dashscope') return 'bailian'
  return (AI_CONNECTIONS_PROVIDERS as readonly string[]).includes(normalized)
    ? normalized as AiConnectionsProvider
    : undefined
}

function providerFromModelId(modelId: string): AiConnectionsProvider | undefined {
  const prefix = modelId.split('/', 1)[0]
  return modelId.includes('/') ? providerValue(prefix) : undefined
}

function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function parseModelDiscovery(
  value: unknown,
  expectedProvider: AiConnectionsProvider,
): ProviderModelDiscovery {
  if (!isRecord(value) || !Array.isArray(value.models)) {
    throw new Error('AI Connection returned an invalid model discovery response')
  }
  const models = value.models
    .map((item): DiscoveredProviderModel | undefined => {
      if (!isRecord(item) || typeof item.id !== 'string' || !item.id) return undefined
      return compactObject({
        id: item.id,
        displayName: stringValue(item.displayName),
        capabilities: Array.isArray(item.capabilities)
          ? item.capabilities.filter((cap): cap is string => typeof cap === 'string')
          : undefined,
      }) as unknown as DiscoveredProviderModel
    })
    .filter(isDefined)
  return {
    provider: expectedProvider,
    models,
    observedAt: typeof value.observedAt === 'string' ? value.observedAt : new Date(0).toISOString(),
    source: typeof value.source === 'string' ? value.source : '',
  }
}

function compactObject<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(
    Object.entries(value).filter(([, item]) => item !== undefined),
  ) as T
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function isDefined<T>(value: T | undefined): value is T {
  return value !== undefined
}
