export const AI_CONNECTION_PROVIDERS = [
  'openai',
  'anthropic',
  'kimi',
  'bailian',
  'deepseek',
] as const

export type AiConnectionProvider = (typeof AI_CONNECTION_PROVIDERS)[number]
export type AiConnectionMode =
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
  mode: AiConnectionMode
  status: AiConnectStatus
  provider: AiConnectionProvider
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

export interface AiConnectionCredential {
  id: string
  credentialIri: string
  webId: string
  provider: AiConnectionProvider
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

export interface AiGatewayModel {
  id: string
  provider: AiConnectionProvider
  displayName?: string
  contextWindow?: number
  protocols?: string[]
}

export type AiProviderModelType = 'chat' | 'embedding' | 'image' | 'audio' | 'other'
export type AiProviderModelAvailability = 'available' | 'unavailable' | 'statusUnknown'
export type AiProviderModelCatalogStatus = 'ready' | 'notFetched' | 'statusUnknown'

export interface AiProviderModel {
  id: string
  displayName?: string
  modelType: AiProviderModelType
  selected: boolean
  availability: AiProviderModelAvailability
}

export interface AiProviderModelCatalog {
  provider: AiConnectionProvider
  fetchedAt?: string
  version: string
  status: AiProviderModelCatalogStatus
  models: AiProviderModel[]
}

export interface AiProviderModelSelectionInput {
  modelIds: string[]
  defaultModel?: string
  expectedVersion?: string
}

export interface AiProviderConnectionSummary {
  provider: AiConnectionProvider
  status: 'connected' | 'disconnected' | 'reauthRequired'
  authMode?: string
  accountLabel?: string
  expiresAt?: string
  reauthRequired?: boolean
  credentialIri?: string
  version?: number
  connect: {
    modes: AiConnectionMode[]
    configured: boolean
    apiKeyManagementSupported?: boolean
    disabled?: boolean
    message?: string
  }
}

export type AiConnectionSummaryState =
  | 'configured'
  | 'connected'
  | 'disconnected'
  | 'reauthRequired'

export function connectionStateFromSummary(
  summary: AiProviderConnectionSummary,
): AiConnectionSummaryState
export function connectionStateFromSummary(
  summary?: AiProviderConnectionSummary,
): AiConnectionSummaryState | undefined
export function connectionStateFromSummary(
  summary?: AiProviderConnectionSummary,
): AiConnectionSummaryState | undefined {
  if (!summary) return undefined
  if (summary.status === 'disconnected') return 'disconnected'
  if (summary.status === 'reauthRequired') return 'reauthRequired'
  if (summary.status !== 'connected') return undefined
  return summary.authMode === 'apiKey' || summary.authMode === 'browserAssistedApiKey'
    ? 'configured'
    : 'connected'
}

export interface AiConnectionClient {
  readonly webId: string
  readonly apiBase: string
  getServiceAccess(): Promise<unknown>
  listProviders(): Promise<AiProviderConnectionSummary[]>
  listModels(): Promise<AiGatewayModel[]>
  discoverModels(provider: AiConnectionProvider): Promise<AiProviderModelCatalog>
  getProviderModels(provider: AiConnectionProvider): Promise<AiProviderModelCatalog>
  replaceModelSelection(
    provider: AiConnectionProvider,
    selection: AiProviderModelSelectionInput,
  ): Promise<AiProviderModelCatalog>
  beginConnect(provider: AiConnectionProvider, mode: AiConnectionMode): Promise<AiConnectAttempt>
  connectStatus(provider: AiConnectionProvider, attempt: Pick<AiConnectAttempt, 'attemptId' | 'state' | 'signature' | 'mode'>): Promise<AiConnectAttempt>
  completeApiKey(
    provider: AiConnectionProvider,
    attempt: Pick<AiConnectAttempt, 'attemptId' | 'state' | 'signature'>,
    apiKey: string,
    accountLabel?: string,
  ): Promise<AiConnectAttempt>
  pollDevice(provider: AiConnectionProvider, attempt: Pick<AiConnectAttempt, 'attemptId' | 'state' | 'signature'>): Promise<AiConnectAttempt>
  disconnect(provider: AiConnectionProvider): Promise<AiConnectionCredential | undefined>
  quota(provider: AiConnectionProvider, refresh?: boolean): Promise<AiQuotaSnapshot>
}

export const AI_CONNECTION_GENERIC_ERROR_MESSAGE = 'AI Connection request failed. Please try again.'

interface CreateAiConnectionClientInput {
  webId: string
  podBaseUrl: string
  authenticatedFetch: typeof fetch
}

export function resolveAiConnectionApiBase(podBaseUrl: string): string {
  const parsed = new URL(podBaseUrl)
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new Error('Current Pod URL must use HTTP or HTTPS')
  }
  return parsed.origin
}

export function createAiConnectionClient({
  webId,
  podBaseUrl,
  authenticatedFetch,
}: CreateAiConnectionClientInput): AiConnectionClient {
  const apiBase = resolveAiConnectionApiBase(podBaseUrl)

  const request = async <T>(
    path: string,
    method: 'GET' | 'POST' | 'PUT' | 'DELETE',
    body?: Record<string, unknown>,
    context: { provider?: AiConnectionProvider } = {},
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
      throw new Error(normalizeAiConnectionErrorMessage(payload, response.status, context))
    }
    return payload as T
  }

  const providerPath = (provider: AiConnectionProvider): string => {
    assertProvider(provider)
    return `/api/ai/gateway/providers/${provider}`
  }
  const requestConnect = async (
    provider: AiConnectionProvider,
    path: string,
    method: 'GET' | 'POST',
    body?: Record<string, unknown>,
  ): Promise<AiConnectAttempt> => {
    const payload = await request<unknown>(`${providerPath(provider)}${path}`, method, body, { provider })
    return parseConnectAttempt(payload, provider)
  }
  const requestModelCatalog = async (
    provider: AiConnectionProvider,
    suffix: '/models' | '/models/discover' | '/models/selection',
    method: 'GET' | 'POST' | 'PUT',
    body?: Record<string, unknown>,
  ): Promise<AiProviderModelCatalog> => {
    const payload = await request<unknown>(
      `${providerPath(provider)}${suffix}`,
      method,
      body,
      { provider },
    )
    return parseProviderModelCatalog(payload, provider)
  }

  return {
    webId,
    apiBase,

    getServiceAccess() {
      return request<unknown>('/api/applets/service-access/ai-connection', 'GET')
    },

    async listProviders() {
      const payload = await request<{ data?: unknown[] }>('/api/ai/connections/providers', 'GET')
      return Array.isArray(payload.data)
        ? payload.data.map(parseProviderSummary).filter(isDefined)
        : []
    },

    async listModels() {
      const payload = await request<{ data?: unknown[] }>('/v1/models', 'GET')
      return Array.isArray(payload.data)
        ? payload.data.map(parseGatewayModel).filter(isDefined)
        : []
    },

    discoverModels(provider) {
      return requestModelCatalog(provider, '/models/discover', 'POST')
    },

    getProviderModels(provider) {
      return requestModelCatalog(provider, '/models', 'GET')
    },

    replaceModelSelection(provider, selection) {
      return requestModelCatalog(
        provider,
        '/models/selection',
        'PUT',
        compactObject({
          modelIds: selection.modelIds,
          defaultModel: selection.defaultModel,
          expectedVersion: selection.expectedVersion,
        }),
      )
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
        ...(attempt.mode ? { mode: attempt.mode } : {}),
      })
      return requestConnect(
        provider,
        `/connect/status/${encodeURIComponent(attempt.attemptId)}?${query}`,
        'GET',
      )
    },

    completeApiKey(provider, attempt, apiKey, accountLabel) {
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

    async disconnect(provider) {
      const payload = await request<{ record?: unknown }>(
        `${providerPath(provider)}/connect`,
        'DELETE',
      )
      return parseCredential(payload.record)
    },

    quota(provider, refresh = false) {
      return request<AiQuotaSnapshot>(
        `${providerPath(provider)}/quota/${refresh ? 'refresh' : 'status'}`,
        refresh ? 'POST' : 'GET',
        refresh ? {} : undefined,
        { provider },
      )
    },
  }
}

export function normalizeAiConnectionThrownError(error: unknown): string {
  if (error instanceof Error) {
    return normalizeAiConnectionErrorText(error.message)
  }
  return normalizeAiConnectionErrorText(String(error))
}

export function normalizeAiConnectionErrorMessage(
  payload: unknown,
  status: number,
  context: { provider?: AiConnectionProvider } = {},
): string {
  const code = errorCodeFromPayload(payload)
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
  return AI_CONNECTION_GENERIC_ERROR_MESSAGE
}

function normalizeAiConnectionErrorText(message: string): string {
  const exact = messageForSafeErrorCode(message)
  if (exact) return exact
  const prefix = message.split(':', 1)[0]?.trim()
  const prefixed = prefix ? messageForSafeErrorCode(prefix) : undefined
  if (prefixed) return prefixed
  if (message === 'AI Connection service identity is unavailable') return message
  if (message.startsWith('invalid_')) return 'AI Connection returned an invalid response.'
  return AI_CONNECTION_GENERIC_ERROR_MESSAGE
}

function errorCodeFromPayload(payload: unknown): string | undefined {
  if (!isRecord(payload)) return undefined
  if (typeof payload.code === 'string') return payload.code
  if (typeof payload.errorCode === 'string') return payload.errorCode
  if (isRecord(payload.error) && typeof payload.error.code === 'string') {
    return payload.error.code
  }
  if (typeof payload.error === 'string' && /^[a-z][a-z0-9_:-]{0,80}$/i.test(payload.error)) {
    return payload.error
  }
  return undefined
}

function messageForSafeErrorCode(
  code: string,
  provider?: AiConnectionProvider,
): string | undefined {
  switch (code.trim().toLowerCase().replace(/-/g, '_')) {
    case 'not_configured':
    case 'notconfigured':
      return provider
        ? `${providerLabel(provider)} connection is not configured.`
        : 'AI provider connection is not configured.'
    case 'unsupported':
    case 'connect_unsupported':
    case 'connect_mode_unsupported':
      return provider
        ? `${providerLabel(provider)} does not support this operation.`
        : 'This AI Connection operation is not supported.'
    case 'connect_disabled':
      return 'AI Connection 管理功能已由此 Xpod 部署禁用。'
    case 'connect_not_configured':
      return provider
        ? `${providerLabel(provider)} connection is not configured.`
        : 'AI provider connection is not configured.'
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
    case 'model_catalog_not_ready':
      return '请先重新连接后再保存模型选择。'
    default:
      return undefined
  }
}

function providerLabel(provider: AiConnectionProvider): string {
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

function assertProvider(provider: string): asserts provider is AiConnectionProvider {
  if (!(AI_CONNECTION_PROVIDERS as readonly string[]).includes(provider)) {
    throw new Error(`Unsupported AI provider: ${provider}`)
  }
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
    displayName: stringValue(value.displayName) ?? stringValue(value.name),
    contextWindow: numberValue(value.contextWindow) ?? numberValue(value.context_window),
    protocols: Array.isArray(value.protocols)
      ? value.protocols.filter((protocol): protocol is string => typeof protocol === 'string')
      : undefined,
  }) as unknown as AiGatewayModel
}

function parseProviderModelCatalog(
  value: unknown,
  expectedProvider: AiConnectionProvider,
): AiProviderModelCatalog {
  if (!isRecord(value)
    || value.provider !== expectedProvider
    || typeof value.version !== 'string'
    || !isProviderModelCatalogStatus(value.status)
    || !Array.isArray(value.models)) {
    throw new Error('AI Connection returned an invalid model catalog response')
  }
  return compactObject({
    provider: expectedProvider,
    fetchedAt: stringValue(value.fetchedAt),
    version: value.version,
    status: value.status,
    models: value.models.map(parseProviderModel).filter(isDefined),
  }) as unknown as AiProviderModelCatalog
}

function parseProviderModel(value: unknown): AiProviderModel | undefined {
  if (!isRecord(value)
    || typeof value.id !== 'string'
    || typeof value.selected !== 'boolean'
    || !isProviderModelAvailability(value.availability)) {
    return undefined
  }
  return compactObject({
    id: value.id,
    displayName: stringValue(value.displayName),
    modelType: isProviderModelType(value.modelType) ? value.modelType : 'other',
    selected: value.selected,
    availability: value.availability,
  }) as unknown as AiProviderModel
}

function isPlatformModelId(modelId: string): boolean {
  const normalized = modelId.toLowerCase()
  return normalized === 'linx'
    || normalized === 'linx-lite'
    || normalized === 'undefineds/linx'
    || normalized === 'undefineds/linx-lite'
}

function providerValue(value: unknown): AiConnectionProvider | undefined {
  if (typeof value !== 'string') return undefined
  const normalized = value.toLowerCase()
  if (normalized === 'alibaba' || normalized === 'dashscope') return 'bailian'
  return (AI_CONNECTION_PROVIDERS as readonly string[]).includes(normalized)
    ? normalized as AiConnectionProvider
    : undefined
}

function providerFromModelId(modelId: string): AiConnectionProvider | undefined {
  const prefix = modelId.split('/', 1)[0]
  return modelId.includes('/') ? providerValue(prefix) : undefined
}

function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function parseProviderSummary(value: unknown): AiProviderConnectionSummary | undefined {
  if (!isRecord(value)
    || typeof value.provider !== 'string'
    || !isProviderStatus(value.status)
    || !isRecord(value.connect)
    || !Array.isArray(value.connect.modes)
    || !value.connect.modes.every(isConnectMode)
    || typeof value.connect.configured !== 'boolean') {
    return undefined
  }
  assertProvider(value.provider)
  return compactObject({
    provider: value.provider,
    status: value.status,
    authMode: stringValue(value.authMode),
    accountLabel: stringValue(value.accountLabel),
    expiresAt: stringValue(value.expiresAt),
    reauthRequired: typeof value.reauthRequired === 'boolean' ? value.reauthRequired : undefined,
    credentialIri: stringValue(value.credentialIri),
    version: typeof value.version === 'number' ? value.version : undefined,
    connect: compactObject({
      modes: [...value.connect.modes],
      configured: value.connect.configured,
      apiKeyManagementSupported: typeof value.connect.apiKeyManagementSupported === 'boolean'
        ? value.connect.apiKeyManagementSupported
        : undefined,
      disabled: typeof value.connect.disabled === 'boolean'
        ? value.connect.disabled
        : undefined,
      message: stringValue(value.connect.message),
    }),
  }) as unknown as AiProviderConnectionSummary
}

function parseCredential(value: unknown): AiConnectionCredential | undefined {
  if (!isRecord(value)
    || typeof value.id !== 'string'
    || typeof value.credentialIri !== 'string'
    || typeof value.webId !== 'string'
    || typeof value.provider !== 'string'
    || typeof value.authMode !== 'string'
    || typeof value.status !== 'string') {
    return undefined
  }
  assertProvider(value.provider)
  return compactObject({
    id: value.id,
    credentialIri: value.credentialIri,
    webId: value.webId,
    provider: value.provider,
    authMode: value.authMode,
    status: value.status,
    accountLabel: stringValue(value.accountLabel),
    expiresAt: stringValue(value.expiresAt),
    version: typeof value.version === 'number' ? value.version : undefined,
    reauthRequired: typeof value.reauthRequired === 'boolean' ? value.reauthRequired : undefined,
  }) as unknown as AiConnectionCredential
}

function parseConnectAttempt(
  value: unknown,
  expectedProvider: AiConnectionProvider,
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

function isConnectMode(value: unknown): value is AiConnectionMode {
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

function isProviderModelType(value: unknown): value is AiProviderModelType {
  return value === 'chat'
    || value === 'embedding'
    || value === 'image'
    || value === 'audio'
    || value === 'other'
}

function isProviderModelAvailability(value: unknown): value is AiProviderModelAvailability {
  return value === 'available' || value === 'unavailable' || value === 'statusUnknown'
}

function isProviderModelCatalogStatus(value: unknown): value is AiProviderModelCatalogStatus {
  return value === 'ready' || value === 'notFetched' || value === 'statusUnknown'
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
