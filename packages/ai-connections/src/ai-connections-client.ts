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

export interface GatewayKeyRecord {
  id: string
  owner: string
  scopes: string[]
  createdAt: string
  expiresAt?: string
  lastUsedAt?: string
  revokedAt?: string
  name?: string
}

export interface AiGatewayModel {
  id: string
  provider: AiConnectionsProvider
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
  credential: string
  models: DiscoveredProviderModel[]
  observedAt: string
  source: string
}

export interface AiProviderOffering {
  id: string
  label?: string
  kind?: string
  authModes?: Array<'oauth' | 'deviceCode' | 'apiKey' | 'local'>
  runtimeProviderIds?: string[]
}

export interface AiProviderCredentialSummary {
  id: string
  provider?: AiConnectionsProvider
  offeringId: string
  authMode: 'oauth' | 'deviceCode' | 'apiKey' | 'local'
  label?: string
  enabled: boolean
  priority: number
  health: 'healthy' | 'expired' | 'invalid' | 'unknown'
  maskedHint?: string
  baseUrl?: string
  expiresAt?: string
  version: number
}

export interface AiProviderSummary {
  id: AiConnectionsProvider
  name: string
  offerings: AiProviderOffering[]
  credentials: AiProviderCredentialSummary[]
  selectedModels: AiGatewayModel[]
  status: 'unconfigured' | 'available' | 'attention' | 'unavailable'
}

export type AiProviderSummaryStatus =
  | 'unconfigured'
  | 'available'
  | 'attention'
  | 'unavailable'

export interface CreatedGatewayKey {
  plaintext: string
  record: GatewayKeyRecord
}

export interface CreateApiKeyCredentialInput {
  offeringId?: string
  apiKey: string
  label?: string
  baseUrl?: string
  priority?: number
}

export interface UpdateProviderCredentialInput {
  expectedVersion: number
  label?: string
  enabled?: boolean
  priority?: number
  baseUrl?: string
}

export interface TestProviderCredentialInput {
  credentialId: string
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
  getServiceAccess(): Promise<unknown>
  listProviders(): Promise<AiProviderSummary[]>
  listModels(): Promise<AiGatewayModel[]>
  listGatewayKeys(): Promise<GatewayKeyRecord[]>
  createGatewayKey(input: { name?: string; scopes?: string[]; expiresAt?: string }): Promise<CreatedGatewayKey>
  revokeGatewayKey(keyId: string): Promise<GatewayKeyRecord | undefined>
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
  disconnect(provider: AiConnectionsProvider, credentialId?: string): Promise<AiConnectionsCredential | undefined>
  createApiKeyCredential(provider: AiConnectionsProvider, input: CreateApiKeyCredentialInput): Promise<AiProviderCredentialSummary>
  updateProviderCredential(provider: AiConnectionsProvider, credentialId: string, input: UpdateProviderCredentialInput): Promise<AiProviderCredentialSummary>
  deleteProviderCredential(provider: AiConnectionsProvider, credentialId: string): Promise<AiProviderCredentialSummary | undefined>
  testProviderCredential(provider: AiConnectionsProvider, input: TestProviderCredentialInput): Promise<Record<string, unknown>>
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
}: CreateAiConnectionsClientInput): AiConnectionsClient {
  const apiBase = resolveAiConnectionsApiBase(podBaseUrl)

  const request = async <T>(
    path: string,
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
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
    return `/api/ai/gateway/providers/${provider}`
  }
  const requestConnect = async (
    provider: AiConnectionsProvider,
    path: string,
    method: 'GET' | 'POST',
    body?: Record<string, unknown>,
  ): Promise<AiConnectAttempt> => {
    const payload = await request<unknown>(`${providerPath(provider)}${path}`, method, body, { provider })
    return parseConnectAttempt(payload, provider)
  }

  return {
    webId,
    apiBase,

    getServiceAccess() {
      return request<unknown>('/api/applets/service-access/ai-connections', 'GET')
    },

    async listProviders() {
      const payload = await request<{ data?: unknown[] }>('/api/ai/providers', 'GET')
      return Array.isArray(payload.data) ? parseProviderSummaries(payload.data) : []
    },

    async listModels() {
      const payload = await request<{ data?: unknown[] }>('/v1/models', 'GET')
      return Array.isArray(payload.data)
        ? payload.data.map(parseGatewayModel).filter(isDefined)
        : []
    },

    async listGatewayKeys() {
      const payload = await request<{ data?: unknown[] }>('/api/ai/gateway/keys', 'GET')
      return Array.isArray(payload.data)
        ? payload.data.map(parseGatewayKeyRecord).filter(isDefined)
        : []
    },

    async createGatewayKey(input) {
      const payload = await request<{ key?: unknown; record?: unknown }>(
        '/api/ai/gateway/keys',
        'POST',
        compactObject(input),
      )
      if (typeof payload.key !== 'string' || !payload.key) {
        throw new Error('AI Connection did not return the one-time Gateway key')
      }
      const record = parseGatewayKeyRecord(payload.record)
      if (!record) {
        throw new Error('AI Connection returned an invalid Gateway key record')
      }
      return { plaintext: payload.key, record }
    },

    async revokeGatewayKey(keyId) {
      const payload = await request<{ record?: unknown }>(
        `/api/ai/gateway/keys/${encodeURIComponent(keyId)}`,
        'DELETE',
      )
      return parseGatewayKeyRecord(payload.record)
    },

    async beginConnect(provider, mode) {
      return await requestConnect(
        provider,
        '/connect/begin',
        'POST',
        { mode },
      )
    },

    connectStatus(provider, attempt) {
      if (!attempt.attemptId) {
        throw new Error('Connect attempt id is required')
      }
      const query = new URLSearchParams({
        state: attempt.state ?? '',
        signature: attempt.signature ?? '',
      })
      return requestConnect(
        provider,
        `/connect/status/${encodeURIComponent(attempt.attemptId)}?${query}`,
        'GET',
      )
    },

    completeApiKey(provider, attempt, apiKey, accountLabel, baseUrl) {
      return requestConnect(
        provider,
        '/connect/complete-api-key',
        'POST',
        compactObject({
          attemptId: attempt.attemptId,
          state: attempt.state,
          signature: attempt.signature,
          apiKey,
          accountLabel,
          baseUrl,
        }),
      )
    },

    pollDevice(provider, attempt) {
      return requestConnect(
        provider,
        '/connect/poll',
        'POST',
        compactObject({
          attemptId: attempt.attemptId,
          state: attempt.state,
          signature: attempt.signature,
        }),
      )
    },

    async disconnect(provider, credentialId) {
      const query = credentialId
        ? `?${new URLSearchParams({ credentialId })}`
        : ''
      const payload = await request<{ record?: unknown }>(
        `${providerPath(provider)}/connect${query}`,
        'DELETE',
      )
      return parseCredential(payload.record)
    },

    async createApiKeyCredential(provider, input) {
      const payload = await request<{ credential?: unknown }>(
        `/api/ai/providers/${provider}/credentials/api-key`,
        'POST',
        compactObject({ ...input }),
        { provider },
      )
      const credential = parseProviderCredentialSummary(payload.credential)
      if (!credential) {
        throw new Error('AI Connection returned an invalid Provider credential')
      }
      return credential
    },

    async updateProviderCredential(provider, credentialId, input) {
      const payload = await request<{ credential?: unknown }>(
        `/api/ai/providers/${provider}/credentials/${encodeURIComponent(credentialId)}`,
        'PATCH',
        compactObject({ ...input }),
        { provider },
      )
      const credential = parseProviderCredentialSummary(payload.credential)
      if (!credential) {
        throw new Error('AI Connection returned an invalid Provider credential')
      }
      return credential
    },

    async deleteProviderCredential(provider, credentialId) {
      const payload = await request<{ credential?: unknown }>(
        `/api/ai/providers/${provider}/credentials/${encodeURIComponent(credentialId)}`,
        'DELETE',
        undefined,
        { provider },
      )
      return parseProviderCredentialSummary(payload.credential)
    },

    async testProviderCredential(provider, input) {
      const payload = await request<{ result?: unknown }>(
        `/api/ai/providers/${provider}/credentials/test`,
        'POST',
        compactObject({ ...input }),
        { provider },
      )
      return sanitizePublicObject(payload.result)
    },

    quota(provider, refresh = false) {
      return request<AiQuotaSnapshot>(
        `${providerPath(provider)}/quota/${refresh ? 'refresh' : 'status'}`,
        refresh ? 'POST' : 'GET',
        refresh ? {} : undefined,
        { provider },
      )
    },

    async discoverModels(provider) {
      const payload = await request<unknown>(
        `${providerPath(provider)}/models/refresh`,
        'POST',
        {},
        { provider },
      )
      return parseModelDiscovery(payload, provider)
    },

    async saveProviderModel(provider, model) {
      const payload = await request<{ data?: unknown }>(
        providerPath(provider) + '/models',
        'POST',
        compactObject({
          id: model.id,
          displayName: model.displayName,
          inputModalities: model.inputModalities,
          outputModalities: model.outputModalities,
          capabilities: model.capabilities,
        }),
        { provider },
      )
      return parseCustomModelList(payload.data)
    },

    async deleteProviderModel(provider, modelId) {
      const payload = await request<{ data?: unknown }>(
        `${providerPath(provider)}/models/${encodeURIComponent(modelId)}`,
        'DELETE',
        undefined,
        { provider },
      )
      return parseCustomModelList(payload.data)
    },
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
    if (text === 'AI Connection service identity is unavailable') {
      return text
    }
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
  if (message === 'AI Connection service identity is unavailable') return message
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
      return 'AI Connection service identity is unavailable'
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

function parseGatewayKeyRecord(value: unknown): GatewayKeyRecord | undefined {
  if (!isRecord(value)
    || typeof value.id !== 'string'
    || typeof value.owner !== 'string'
    || !Array.isArray(value.scopes)
    || !value.scopes.every((scope) => typeof scope === 'string')
    || typeof value.createdAt !== 'string') {
    return undefined
  }
  return compactObject({
    id: value.id,
    owner: value.owner,
    scopes: value.scopes,
    createdAt: value.createdAt,
    expiresAt: stringValue(value.expiresAt),
    lastUsedAt: stringValue(value.lastUsedAt),
    revokedAt: stringValue(value.revokedAt),
    name: stringValue(value.name),
  }) as unknown as GatewayKeyRecord
}

function parseCustomModelList(value: unknown): CustomProviderModel[] {
  if (!Array.isArray(value)) {
    throw new Error('AI Connection returned an invalid custom models response')
  }
  const models: CustomProviderModel[] = []
  for (const item of value) {
    if (!isRecord(item) || typeof item.id !== 'string' || !item.id) continue
    models.push(compactObject({
      id: item.id,
      displayName: stringValue(item.displayName),
      inputModalities: stringListValue(item.inputModalities),
      outputModalities: stringListValue(item.outputModalities),
      capabilities: stringListValue(item.capabilities),
    }) as unknown as CustomProviderModel)
  }
  return models
}

function stringListValue(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  const list = value.filter((item): item is string => typeof item === 'string')
  return list.length > 0 ? list : undefined
}

function parseGatewayModel(value: unknown): AiGatewayModel | undefined {
  if (!isRecord(value) || typeof value.id !== 'string') return undefined
  if (isPlatformModelId(value.id)) return undefined
  const provider = providerValue(value.provider)
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
  }) as unknown as AiGatewayModel
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
  const normalized = value.toLowerCase().trim()
  if (
    normalized === 'alibaba'
    || normalized === 'dashscope'
    || normalized === 'alibaba-bailian'
    || normalized === 'bailian-coding-plan'
    || normalized === 'bailian-token-plan'
  ) return 'bailian'
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

function parseProviderSummaries(values: unknown[]): AiProviderSummary[] {
  const grouped = new Map<AiConnectionsProvider, AiProviderSummary>()
  for (const value of values) {
    const summary = parseProviderSummary(value)
    if (!summary) continue
    const current = grouped.get(summary.id)
    grouped.set(summary.id, current ? mergeProviderSummaries(current, summary) : summary)
  }
  return [...grouped.values()]
}

function parseProviderSummary(value: unknown): AiProviderSummary | undefined {
  return parseGroupedProviderSummary(value) ?? parseLegacyProviderSummary(value)
}

function parseLegacyProviderSummary(value: unknown): AiProviderSummary | undefined {
  if (!isRecord(value)
    || typeof value.provider !== 'string'
    || !isProviderStatus(value.status)
    || !isRecord(value.connect)
    || !Array.isArray(value.connect.modes)
    || !value.connect.modes.every(isConnectMode)
    || typeof value.connect.configured !== 'boolean') {
    return undefined
  }
  const provider = providerValue(value.provider)
  if (!provider) return undefined
  const credential = legacyCredentialFromSummary(value, provider)
  return {
    id: provider,
    name: providerDisplayName(provider),
    offerings: [],
    credentials: credential ? [credential] : [],
    selectedModels: [],
    status: providerProductStatusFromLegacy(value.status),
  }
}

function parseGroupedProviderSummary(value: unknown): AiProviderSummary | undefined {
  if (!isRecord(value)) return undefined
  const provider = providerValue(value.id) ?? providerValue(value.provider)
  if (!provider || !isProviderSummaryStatus(value.status)) return undefined
  const offerings = arrayValue(value.offerings, parseProviderOffering)
  const credentials = arrayValue(value.credentials, parseProviderCredentialSummary)
  const selectedModels = arrayValue(value.selectedModels, parseGatewayModel)
  return {
    id: provider,
    name: stringValue(value.name) ?? providerDisplayName(provider),
    offerings,
    credentials,
    selectedModels,
    status: value.status,
  }
}

function parseProviderOffering(value: unknown): AiProviderOffering | undefined {
  if (!isRecord(value) || typeof value.id !== 'string' || !value.id) return undefined
  const authModes = arrayValue(value.authModes, offeringAuthModeValue)
  return compactObject({
    id: value.id,
    label: stringValue(value.label),
    kind: stringValue(value.kind),
    authModes,
    runtimeProviderIds: stringListValue(value.runtimeProviderIds),
  }) as unknown as AiProviderOffering
}

function parseProviderCredentialSummary(value: unknown): AiProviderCredentialSummary | undefined {
  if (!isRecord(value)
    || typeof value.id !== 'string'
    || !value.id
    || typeof value.offeringId !== 'string'
    || !value.offeringId
    || !isOfferingAuthMode(value.authMode)
    || typeof value.enabled !== 'boolean'
    || typeof value.priority !== 'number'
    || !Number.isFinite(value.priority)
    || !isCredentialHealth(value.health)
    || typeof value.version !== 'number'
    || !Number.isFinite(value.version)) {
    return undefined
  }
  return compactObject({
    id: value.id,
    provider: providerValue(value.provider),
    offeringId: value.offeringId,
    authMode: value.authMode,
    label: stringValue(value.label),
    enabled: value.enabled,
    priority: value.priority,
    health: value.health,
    maskedHint: stringValue(value.maskedHint),
    baseUrl: stringValue(value.baseUrl),
    expiresAt: stringValue(value.expiresAt),
    version: value.version,
  }) as unknown as AiProviderCredentialSummary
}

function sanitizePublicObject(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) return {}
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !isSecretFieldName(key))
      .map(([key, item]) => [key, sanitizePublicValue(item)]),
  )
}

function sanitizePublicValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitizePublicValue)
  if (isRecord(value)) return sanitizePublicObject(value)
  return value
}

function isSecretFieldName(value: string): boolean {
  const normalized = value.toLocaleLowerCase()
  return normalized.includes('secret')
    || normalized.includes('token')
    || normalized.includes('apikey')
    || normalized === 'api_key'
    || normalized === 'key'
    || normalized === 'authorization'
}

function mergeProviderSummaries(
  left: AiProviderSummary,
  right: AiProviderSummary,
): AiProviderSummary {
  const credentials = uniqueBy(
    [...left.credentials, ...right.credentials],
    (credential) => credential.id,
  )
  const offerings = uniqueBy(
    [...left.offerings, ...right.offerings],
    (offering) => offering.id,
  )
  const selectedModels = uniqueBy(
    [...left.selectedModels, ...right.selectedModels],
    (model) => `${model.provider}:${model.id}`,
  )
  return {
    id: left.id,
    name: left.name ?? right.name,
    offerings,
    credentials,
    selectedModels,
    status: mergeProviderSummaryStatus(left.status, right.status),
  }
}

function providerProductStatusFromLegacy(
  status: AiProviderConnectionSummary['status'],
): AiProviderSummary['status'] {
  if (status === 'connected') return 'available'
  if (status === 'reauthRequired') return 'attention'
  return 'unconfigured'
}

function mergeProviderSummaryStatus(
  left: AiProviderSummary['status'],
  right: AiProviderSummary['status'],
): AiProviderSummary['status'] {
  if (left === 'available' || right === 'available') return 'available'
  if (left === 'attention' || right === 'attention') return 'attention'
  if (left === 'unconfigured' || right === 'unconfigured') return 'unconfigured'
  return 'unavailable'
}

function legacyCredentialFromSummary(
  value: Record<string, unknown>,
  provider: AiConnectionsProvider,
): AiProviderCredentialSummary | undefined {
  if (value.status === 'disconnected') return undefined
  const authMode = legacyCredentialAuthMode(value.authMode)
  return compactObject({
    id: stringValue(value.credentialIri) ?? `${provider}:current`,
    offeringId: legacyOfferingId(authMode),
    authMode,
    label: stringValue(value.accountLabel),
    enabled: value.status === 'connected',
    priority: 0,
    health: value.status === 'reauthRequired' || value.reauthRequired === true
      ? 'expired'
      : 'healthy',
    maskedHint: stringValue(value.maskedHint),
    baseUrl: stringValue(value.baseUrl),
    expiresAt: stringValue(value.expiresAt),
    version: typeof value.version === 'number' ? value.version : 0,
  }) as AiProviderCredentialSummary
}

function legacyCredentialAuthMode(value: unknown): AiProviderCredentialSummary['authMode'] {
  if (value === 'deviceCodeOAuth') return 'deviceCode'
  return 'apiKey'
}

function legacyOfferingId(authMode: AiProviderCredentialSummary['authMode']): string {
  return authMode === 'deviceCode' || authMode === 'oauth'
    ? 'official-subscription'
    : 'api-platform'
}

function offeringAuthModeValue(value: unknown): AiProviderCredentialSummary['authMode'] | undefined {
  return isOfferingAuthMode(value) ? value : undefined
}

function isOfferingAuthMode(value: unknown): value is AiProviderCredentialSummary['authMode'] {
  return value === 'oauth'
    || value === 'deviceCode'
    || value === 'apiKey'
    || value === 'local'
}

function isCredentialHealth(value: unknown): value is AiProviderCredentialSummary['health'] {
  return value === 'healthy'
    || value === 'expired'
    || value === 'invalid'
    || value === 'unknown'
}

function isProviderSummaryStatus(value: unknown): value is AiProviderSummary['status'] {
  return value === 'unconfigured'
    || value === 'available'
    || value === 'attention'
    || value === 'unavailable'
}

function arrayValue<T>(
  value: unknown,
  parseItem: (item: unknown) => T | undefined,
): T[] {
  if (!Array.isArray(value)) return []
  return value.map(parseItem).filter(isDefined)
}

function uniqueBy<T>(values: T[], keyFor: (value: T) => string): T[] {
  const seen = new Set<string>()
  const result: T[] = []
  for (const value of values) {
    const key = keyFor(value)
    if (seen.has(key)) continue
    seen.add(key)
    result.push(value)
  }
  return result
}

function providerDisplayName(provider: AiConnectionsProvider): string {
  switch (provider) {
    case 'openai': return 'OpenAI'
    case 'anthropic': return 'Anthropic'
    case 'kimi': return 'Kimi'
    case 'bailian': return 'Alibaba Bailian'
    case 'deepseek': return 'DeepSeek'
  }
}

function parseCredential(value: unknown): AiConnectionsCredential | undefined {
  if (!isRecord(value)
    || typeof value.id !== 'string'
    || typeof value.credentialIri !== 'string'
    || typeof value.webId !== 'string'
    || typeof value.provider !== 'string'
    || typeof value.authMode !== 'string'
    || typeof value.status !== 'string') {
    return undefined
  }
  const provider = providerValue(value.provider)
  if (!provider) return undefined
  return compactObject({
    id: value.id,
    credentialIri: value.credentialIri,
    webId: value.webId,
    provider,
    authMode: value.authMode,
    status: value.status,
    accountLabel: stringValue(value.accountLabel),
    expiresAt: stringValue(value.expiresAt),
    version: typeof value.version === 'number' ? value.version : undefined,
    reauthRequired: typeof value.reauthRequired === 'boolean' ? value.reauthRequired : undefined,
  }) as unknown as AiConnectionsCredential
}

function parseConnectAttempt(
  value: unknown,
  expectedProvider: AiConnectionsProvider,
): AiConnectAttempt {
  if (!isRecord(value)
    || !isConnectMode(value.mode)
    || !isConnectStatus(value.status)
    || value.provider !== expectedProvider) {
    throw new Error('AI Connection returned an invalid Connect response')
  }
  return compactObject({
    mode: value.mode,
    status: value.status,
    provider: expectedProvider,
    attemptId: stringValue(value.attemptId),
    state: stringValue(value.state),
    signature: stringValue(value.signature),
    expiresAt: stringValue(value.expiresAt),
    authorizationUrl: safeHttpUrl(value.authorizationUrl),
    userCode: stringValue(value.userCode),
    verificationUri: safeHttpUrl(value.verificationUri),
    verificationUriComplete: safeHttpUrl(value.verificationUriComplete),
    intervalSeconds: typeof value.intervalSeconds === 'number' ? value.intervalSeconds : undefined,
    apiKeyManagementSupported: typeof value.apiKeyManagementSupported === 'boolean'
      ? value.apiKeyManagementSupported
      : undefined,
    credentialId: stringValue(value.credentialId),
    message: stringValue(value.message),
  }) as unknown as AiConnectAttempt
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
    credential: typeof value.credential === 'string' ? value.credential : '',
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

function safeHttpUrl(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  try {
    const parsed = new URL(value)
    return parsed.protocol === 'https:' || parsed.protocol === 'http:' ? parsed.href : undefined
  } catch {
    return undefined
  }
}

function isConnectMode(value: unknown): value is AiConnectionsMode {
  return value === 'browserAssistedApiKey'
    || value === 'deviceCodeOAuth'
    || value === 'connectUnsupported'
}

function isConnectStatus(value: unknown): value is AiConnectStatus {
  return value === 'pending'
    || value === 'authorization_pending'
    || value === 'slow_down'
    || value === 'completed'
    || value === 'expired'
    || value === 'cancelled'
    || value === 'unsupported'
}

function isProviderStatus(
  value: unknown,
): value is AiProviderConnectionSummary['status'] {
  return value === 'connected' || value === 'disconnected' || value === 'reauthRequired'
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function isDefined<T>(value: T | undefined): value is T {
  return value !== undefined
}
