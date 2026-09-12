import type { AiConnectionsOAuthCredential } from '@undefineds.co/extension-sdk/web'
import { AI_CONNECTIONS_PROVIDERS } from './types'
import type {
  AiConnectAttempt,
  AiConnectionsCredential,
  AiConnectionsMode,
  AiConnectionsProvider,
  AiConnectStatus,
  AiGatewayModel,
  AiProviderAuthorizationMethod,
  AiProviderAuthorizationMethodsSummary,
  AiProviderConnectionSummary,
  AiProviderCredentialSummary,
  AiProviderOffering,
  AiProviderSummary,
  CustomProviderModel,
  DiscoveredProviderModel,
  GatewayKeyRecord,
  ProviderModelDiscovery,
} from './types'

/**
 * Everything that turns untrusted API payloads, user input and failures into the
 * shapes the rest of the app can rely on: proxy/pod URL normalising, error text,
 * and the parsers for each response.
 *
 * The request factory calls some of the parsers directly, so they carry `export`
 * within this module family. The published surface is the explicit list in
 * `ai-connections-client.ts`, not this file.
 */
export const AI_CONNECTIONS_GENERIC_ERROR_MESSAGE = 'AI Connection request failed. Please try again.'

/**
 * Validate and normalize a user supplied upstream proxy URL. Proxy credentials
 * are intentionally rejected because proxy auth is not stored in the Pod
 * secret cell.
 */
export function normalizeProxyUrl(value: string | undefined | null): string | undefined {
  if (value === undefined || value === null || !value.trim()) return undefined
  let parsed: URL
  try {
    parsed = new URL(value.trim())
  } catch {
    throw new Error('invalid_proxy_url')
  }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.hash) {
    throw new Error('invalid_proxy_url')
  }
  if (!parsed.hostname) throw new Error('invalid_proxy_url')
  return parsed.href.replace(/\/$/u, '')
}

export function redactProxyUrl(value: string | undefined | null): string | undefined {
  if (value === undefined || value === null || !value.trim()) return undefined
  let parsed: URL
  try {
    parsed = new URL(value.trim())
  } catch {
    return undefined
  }
  if (!['http:', 'https:'].includes(parsed.protocol) || !parsed.hostname) return undefined
  parsed.username = ''
  parsed.password = ''
  parsed.search = ''
  parsed.hash = ''
  return parsed.href.replace(/\/$/u, '')
}

export class AiConnectionsRequestError extends Error {
  public readonly code?: string
  public readonly providerStatus?: number

  constructor(message: string, payload: unknown) {
    super(message)
    this.name = 'AiConnectionsRequestError'
    this.code = errorCodeFromPayload(payload)
    this.providerStatus = isRecord(payload) && typeof payload.providerStatus === 'number'
      ? payload.providerStatus : undefined
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
  context: { provider?: AiConnectionsProvider; authMode?: 'apiKey' | 'deviceCodeOAuth' | 'local' } = {},
): string {
  const code = errorCodeFromPayload(payload)
  if (code === 'provider_models_response_error') {
    const message = isRecord(payload) && typeof payload.message === 'string'
      ? sanitizeProviderResponseMessage(payload.message)
      : undefined
    if (message) return message
    return '模型列表获取失败。请检查密钥、服务地址或网络后重试。'
  }
  if (code === 'provider_models_fetch_failed') {
    const providerStatus = isRecord(payload) && typeof payload.providerStatus === 'number'
      ? payload.providerStatus
      : undefined
    const providerMessage = isRecord(payload) && typeof payload.providerMessage === 'string'
      ? payload.providerMessage.trim()
      : undefined
    return withProviderMessage(modelDiscoveryErrorMessage(providerStatus, context.authMode), providerMessage)
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
    if (text === 'Provider credential not found for current identity') {
      return '当前身份没有可用的额度凭证。'
    }
    if (text === 'Provider quota adapter not found' || text === 'Provider quota lookup failed') {
      return '该接入方式不支持查询官方额度。'
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

const LOCAL_SESSION_REFRESH_FAILED_MESSAGE = '订阅登录态自动刷新失败，请稍后重试。'
const LOCAL_SESSION_REAUTH_REQUIRED_MESSAGE = '订阅登录态已失效，请在原客户端重新登录后重读，或使用设备码登录。'

const OAUTH_MODEL_AUTH_FAILED_MESSAGE = '订阅登录态不可用，请重读登录态或重新登录后再同步模型。'

const MODEL_DISCOVERY_SAFE_MESSAGES = new Set([
  OAUTH_MODEL_AUTH_FAILED_MESSAGE,
  LOCAL_SESSION_REFRESH_FAILED_MESSAGE,
  LOCAL_SESSION_REAUTH_REQUIRED_MESSAGE,
  '密钥不可用。请检查密钥是否填写正确，或换一个密钥后重试。',
  '模型服务地址不正确。请检查服务地址后重试。',
  '请求太频繁。请稍等一会儿再试。',
  '模型服务暂时没有响应。请稍后重试。',
  '模型列表获取失败。请检查密钥、服务地址或网络后重试。',
])

function normalizeAiConnectionsErrorText(message: string): string {
  if (message.startsWith('provider_models_response_error:')) {
    return sanitizeProviderResponseMessage(message.slice('provider_models_response_error:'.length))
      ?? '模型列表获取失败。请检查密钥、服务地址或网络后重试。'
  }
  const exact = messageForSafeErrorCode(message)
  if (exact) return exact
  const prefix = message.split(':', 1)[0]?.trim()
  const prefixed = prefix ? messageForSafeErrorCode(prefix) : undefined
  if (prefixed) return prefixed
  if (message === 'AI Connection service identity is unavailable') return message
  if (MODEL_DISCOVERY_SAFE_MESSAGES.has(message)) return message
  if (isModelDiscoveryMessageWithProviderDetail(message)) return message
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
    case 'unsafe_provider_base_url':
      return '该服务地址指向 Xpod 不允许访问的网络，请改用公网 HTTPS 地址。'
    case 'invalid_proxy_url':
      return '代理地址必须是无账号密码的 HTTP 或 HTTPS 地址。'
    case 'oauth_refresh_failed':
    case 'oauth_refresh_unavailable':
    case 'local_session_refresh_failed':
      return LOCAL_SESSION_REFRESH_FAILED_MESSAGE
    case 'oauth_session_reauth_required':
    case 'oauth_refresh_token_required':
    case 'local_session_reauth_required':
    case 'local_session_missing_refresh_token':
      return LOCAL_SESSION_REAUTH_REQUIRED_MESSAGE
    case 'models_persistence_failed':
      return '模型已获取，但保存到 Pod 失败。请重试同步模型。'
    case 'quota_credential_not_found':
      return '当前身份没有可用的额度凭证。'
    case 'credential_secret_unavailable':
      return '当前凭证密钥不可用，请重新保存后再查询额度。'
    case 'gateway_api_key_plaintext_unavailable':
      return 'Pod 中未找到此 API Key 的原文，无法复制配置。请创建新的 Key，更新客户端后再删除旧 Key。'
    case 'quota_adapter_not_found':
      return '该接入方式不支持查询官方额度。'
    default:
      return undefined
  }
}

function modelDiscoveryErrorMessage(providerStatus: number | undefined, authMode?: string): string {
  if (providerStatus === 401 || providerStatus === 403) {
    if (authMode === 'deviceCodeOAuth') return OAUTH_MODEL_AUTH_FAILED_MESSAGE
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

function withProviderMessage(message: string, providerMessage: string | undefined): string {
  const sanitized = providerMessage ? sanitizeProviderResponseMessage(providerMessage) : undefined
  if (!sanitized) return message
  return `${message} 上游返回：${sanitized}`
}

function isModelDiscoveryMessageWithProviderDetail(message: string): boolean {
  const marker = ' 上游返回：'
  const index = message.indexOf(marker)
  if (index <= 0) return false
  return MODEL_DISCOVERY_SAFE_MESSAGES.has(message.slice(0, index))
}

function sanitizeProviderResponseMessage(value: string): string | undefined {
  const sanitized = value
    .replace(/[\u0000-\u001f\u007f]/gu, ' ')
    .replace(/\bBearer\s+[^\s,;]+/giu, 'Bearer [REDACTED]')
    .replace(/(?:sk|id)[._-][A-Za-z0-9._-]{8,}/gu, '[REDACTED]')
    .replace(/https?:\/\/[^\s]+/giu, '[URL]')
    .trim()
    .slice(0, 240)
  return sanitized || undefined
}

function providerLabel(provider: AiConnectionsProvider): string {
  switch (provider) {
    case 'openai': return 'OpenAI'
    case 'anthropic': return 'Anthropic'
    case 'kimi': return 'Kimi'
    case 'bailian': return 'Bailian'
    case 'deepseek': return 'DeepSeek'
    case 'zhipu': return 'Zhipu'
    case 'ollama': return 'Ollama'
    case 'custom': return 'Custom'
  }
}

export async function readJson(response: Response): Promise<unknown> {
  const text = await response.text()
  if (!text) return undefined
  try {
    return JSON.parse(text)
  } catch {
    throw new Error(`AI Connection returned invalid JSON (${response.status})`)
  }
}

export function assertProvider(provider: string): asserts provider is AiConnectionsProvider {
  if (!(AI_CONNECTIONS_PROVIDERS as readonly string[]).includes(provider)) {
    throw new Error(`Unsupported AI provider: ${provider}`)
  }
}

export function parseGatewayKeyRecord(value: unknown): GatewayKeyRecord | undefined {
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
    kind: value.kind === 'client-credentials' ? value.kind : undefined,
    credentialResource: stringValue(value.credentialResource),
    fingerprint: stringValue(value.fingerprint),
    owner: value.owner,
    scopes: value.scopes,
    createdAt: value.createdAt,
    expiresAt: stringValue(value.expiresAt),
    lastUsedAt: stringValue(value.lastUsedAt),
    disabledAt: stringValue(value.disabledAt),
    revokedAt: stringValue(value.revokedAt),
    name: stringValue(value.name),
    maskedHint: stringValue(value.maskedHint),
    plaintextAvailable: typeof value.plaintextAvailable === 'boolean' ? value.plaintextAvailable : undefined,
    appliedClients: stringListValue(value.appliedClients),
  }) as unknown as GatewayKeyRecord
}

export function parseCustomModelList(value: unknown): CustomProviderModel[] {
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

export function parseGatewayModel(value: unknown): AiGatewayModel | undefined {
  if (!isRecord(value) || typeof value.id !== 'string') return undefined
  if (isPlatformModelId(value.id)) return undefined
  const provider = providerValue(value.provider)
    ?? providerValue(value.providerId)
    ?? providerValue(value.owned_by)
    ?? providerFromModelId(value.id)
  if (!provider) return undefined
  const imageInput = isRecord(value.capabilities) ? value.capabilities.imageInput : undefined

  return compactObject({
    id: value.id,
    provider,
    offeringId: stringValue(value.offeringId),
    resourceId: stringValue(value.resourceId),
    displayName: stringValue(value.displayName) ?? stringValue(value.display_name) ?? stringValue(value.name),
    contextWindow: numberValue(value.contextWindow) ?? numberValue(value.context_window),
    protocols: Array.isArray(value.protocols)
      ? value.protocols.filter((protocol): protocol is string => typeof protocol === 'string')
      : undefined,
    custom: value.custom === true ? true : undefined,
    inputModalities: modalitiesFromWire(value.modalities, 'input')
      ?? (imageInput === true ? ['text', 'image'] : imageInput === false ? ['text'] : undefined),
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

export function parseProviderSummaries(values: unknown[]): AiProviderSummary[] {
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
    lifecycle: offeringLifecycleValue(value.lifecycle),
    authModes,
    authorizationMethods: arrayValue(value.authorizationMethods, parseAuthorizationMethod),
    runtimeProviderIds: stringListValue(value.runtimeProviderIds),
    productLabel: stringValue(value.productLabel),
    credentialPrefixHints: stringListValue(value.credentialPrefixHints),
    consoleUrl: stringValue(value.consoleUrl),
    subscriptionUrl: stringValue(value.subscriptionUrl),
    endpoints: arrayValue(value.endpoints, parseOfferingEndpoint),
    modelDiscovery: parseOfferingModelDiscovery(value.modelDiscovery),
    quota: parseOfferingQuota(value.quota),
    usagePolicyUrl: stringValue(value.usagePolicyUrl),
    region: stringValue(value.region),
  }) as unknown as AiProviderOffering
}

export function parseAuthorizationMethodsSummary(value: unknown): AiProviderAuthorizationMethodsSummary | undefined {
  if (!isRecord(value) || typeof value.offeringId !== 'string' || !value.offeringId) return undefined
  const provider = providerValue(value.provider)
  if (!provider) return undefined
  const authorizationMethods = arrayValue(value.authorizationMethods, parseAuthorizationMethod)
  return {
    provider,
    offeringId: value.offeringId,
    ...(Array.isArray(value.endpoints) ? { endpoints: arrayValue(value.endpoints, parseOfferingEndpoint) } : {}),
    authorizationMethods,
  }
}

function parseAuthorizationMethod(value: unknown): AiProviderAuthorizationMethod | undefined {
  if (!isRecord(value) || typeof value.id !== 'string' || !value.id) return undefined
  const authMode = offeringAuthModeValue(value.authMode)
  const lifecycle = authorizationMethodLifecycleValue(value.lifecycle)
  if (!authMode || !lifecycle) return undefined
  const connectMode = isConnectMode(value.connectMode) ? value.connectMode : undefined
  return compactObject({
    id: value.id,
    authMode,
    connectMode,
    label: stringValue(value.label) ?? authorizationMethodFallbackLabel(value.id, authMode),
    lifecycle,
    reason: stringValue(value.reason),
  }) as unknown as AiProviderAuthorizationMethod
}

function authorizationMethodLifecycleValue(value: unknown): AiProviderAuthorizationMethod['lifecycle'] | undefined {
  return value === 'active' || value === 'unavailable' ? value : undefined
}

function authorizationMethodFallbackLabel(id: string, authMode: AiProviderAuthorizationMethod['authMode']): string {
  if (id === 'device-code') return '设备码登录'
  if (id === 'local-session-import') return '已有登录态'
  if (id === 'local-service') return '本地服务'
  if (id === 'api-key' || authMode === 'apiKey') return 'API Key'
  if (authMode === 'local') return '本地服务'
  return '浏览器登录'
}

function offeringLifecycleValue(value: unknown): AiProviderOffering['lifecycle'] | undefined {
  return value === 'active' || value === 'legacy' || value === 'unavailable'
    ? value
    : undefined
}

function parseOfferingEndpoint(value: unknown): { protocol: string; baseUrl: string; region?: string } | undefined {
  if (!isRecord(value)) return undefined
  const protocol = stringValue(value.protocol)
  const baseUrl = stringValue(value.baseUrl)
  if (!protocol || !baseUrl) return undefined
  return compactObject({ protocol, baseUrl, region: stringValue(value.region) })
}

function parseOfferingModelDiscovery(value: unknown): AiProviderOffering['modelDiscovery'] | undefined {
  if (!isRecord(value)) return undefined
  const strategy = stringValue(value.strategy)
  const path = stringValue(value.path)
  const endpointProtocol = stringValue(value.endpointProtocol)
  return strategy && path && endpointProtocol ? { strategy, path, endpointProtocol } : undefined
}

function parseOfferingQuota(value: unknown): AiProviderOffering['quota'] | undefined {
  if (!isRecord(value)) return undefined
  const strategy = stringValue(value.strategy)
  const url = stringValue(value.url)
  return strategy && url ? { strategy, url } : undefined
}

export function parseProviderCredentialSummary(value: unknown): AiProviderCredentialSummary | undefined {
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
    proxyUrl: stringValue(value.proxyUrl),
    expiresAt: stringValue(value.expiresAt),
    version: value.version,
  }) as unknown as AiProviderCredentialSummary
}

export function sanitizePublicObject(value: unknown): Record<string, unknown> {
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
    modelIdentity,
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

function modelIdentity(model: AiGatewayModel): string {
  return model.resourceId
    ?? `${model.provider}:${model.offeringId ?? ''}:${model.id}`
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
  if (left === 'configured' || right === 'configured') return 'configured'
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
    offeringId: legacyOfferingId(provider, authMode),
    authMode,
    label: stringValue(value.accountLabel),
    enabled: value.status === 'connected',
    priority: 0,
    health: value.status === 'reauthRequired' || value.reauthRequired === true
      ? 'expired'
      : 'healthy',
    maskedHint: stringValue(value.maskedHint),
    baseUrl: stringValue(value.baseUrl),
    proxyUrl: stringValue(value.proxyUrl),
    expiresAt: stringValue(value.expiresAt),
    version: typeof value.version === 'number' ? value.version : 0,
  }) as AiProviderCredentialSummary
}

function legacyCredentialAuthMode(value: unknown): AiProviderCredentialSummary['authMode'] {
  if (value === 'deviceCodeOAuth') return 'deviceCode'
  return 'apiKey'
}

function legacyOfferingId(
  provider: AiConnectionsProvider,
  authMode: AiProviderCredentialSummary['authMode'],
): string {
  if (provider === 'kimi' && (authMode === 'deviceCode' || authMode === 'oauth')) return 'subscription-key'
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
    || value === 'configured'
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
    case 'zhipu': return 'Zhipu'
    case 'ollama': return 'Ollama'
    case 'custom': return 'Custom'
  }
}

export function parseCredential(value: unknown): AiConnectionsCredential | undefined {
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

export function parseConnectAttempt(
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
    offeringId: stringValue(value.offeringId),
    authorizationMethodId: stringValue(value.authorizationMethodId),
    oauthCredential: parseOAuthCredential(value.oauthCredential),
    message: stringValue(value.message),
  }) as unknown as AiConnectAttempt
}

function parseOAuthCredential(value: unknown): AiConnectionsOAuthCredential | undefined {
  if (value === undefined) return undefined
  if (!isRecord(value)
    || typeof value.accessToken !== 'string'
    || !value.accessToken
    || typeof value.refreshToken !== 'string'
    || !value.refreshToken) {
    throw new Error('AI Connection returned an invalid OAuth credential payload')
  }
  return compactObject({
    accessToken: value.accessToken,
    refreshToken: value.refreshToken,
    expiresAt: stringValue(value.expiresAt),
    scope: stringValue(value.scope),
    idToken: stringValue(value.idToken),
    accountSubject: stringValue(value.accountSubject),
    accountId: stringValue(value.accountId),
    accountLabel: stringValue(value.accountLabel),
    offeringId: stringValue(value.offeringId),
    authorizationMethodId: stringValue(value.authorizationMethodId),
    expectedVersion: typeof value.expectedVersion === 'number' ? value.expectedVersion : undefined,
  }) as AiConnectionsOAuthCredential
}

export function parseModelDiscovery(
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

export function compactObject<T extends Record<string, unknown>>(value: T): T {
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
    || value === 'authorizationCodeOAuth'
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

export function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

export function isDefined<T>(value: T | undefined): value is T {
  return value !== undefined
}
