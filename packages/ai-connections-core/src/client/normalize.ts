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

/**
 * A failed AI Connection request.
 *
 * It carries the facts a caller needs to decide what to say - the wire code, the
 * upstream status, the payload itself - and a diagnostic message that names the
 * code. The sentence a user reads is the applet's (`error-wording.ts`): a shared
 * client must not pick the wording for whoever happens to render it.
 */
export class AiConnectionsRequestError extends Error {
  public readonly code?: string
  public readonly status: number
  public readonly providerStatus?: number
  public readonly payload: unknown
  public readonly provider?: string
  public readonly authMode?: string

  constructor(
    payload: unknown,
    status: number,
    context: { provider?: string; authMode?: string } = {},
  ) {
    const code = aiConnectionsErrorCode(payload)
    super(code ? `AI Connection request failed: ${code}` : `AI Connection request failed (HTTP ${status})`)
    this.name = 'AiConnectionsRequestError'
    this.code = code
    this.status = status
    this.providerStatus = isRecord(payload) && typeof payload.providerStatus === 'number'
      ? payload.providerStatus : undefined
    this.payload = payload
    this.provider = context.provider
    this.authMode = context.authMode
  }
}


export function aiConnectionsErrorCode(payload: unknown): string | undefined {
  if (!isRecord(payload)) return undefined
  if (typeof payload.code === 'string') return payload.code
  if (typeof payload.errorCode === 'string') return payload.errorCode
  if (typeof payload.error === 'string' && /^[a-z][a-z0-9_:-]{0,80}$/i.test(payload.error)) {
    return payload.error
  }
  return undefined
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
    // Recorded by the server when the credential was issued/applied; the app
    // needs them to revoke the CSS credential without a stored secret.
    clientCredentialId: stringValue(value.clientCredentialId),
    appliedTo: stringValue(value.appliedTo),
    appliedOn: stringValue(value.appliedOn),
    appliedAt: stringValue(value.appliedAt),
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
  // Only what a model can do for the caller earns a mark. `parallelToolCalls`
  // refines tool calling and `promptCaching` is a transport optimisation, so
  // neither becomes a marker of its own.
  if (value.capabilities.toolCalls === true) capabilities.push('tool_call')
  if (value.capabilities.reasoningEffort === true) capabilities.push('reasoning')
  // A curated tier marker, not a measurement: the catalog has no latency data,
  // so a model is only "fast" because the catalog says so.
  if (value.capabilities.fast === true) capabilities.push('fast')
  // Catalog-provided embedding models carry the capability as an object flag, the
  // same way the AI Config embedding assignment reads them.
  if (value.capabilities.embedding === true) capabilities.push('embedding')
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
    label: stringValue(value.label),
    lifecycle,
    reason: stringValue(value.reason),
  }) as unknown as AiProviderAuthorizationMethod
}

function authorizationMethodLifecycleValue(value: unknown): AiProviderAuthorizationMethod['lifecycle'] | undefined {
  return value === 'active' || value === 'unavailable' ? value : undefined
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
      const capabilities = Array.isArray(item.capabilities)
        ? item.capabilities.filter((cap): cap is string => typeof cap === 'string')
        : undefined
      const modelType = discoveredModelType(item.modelType)
      return compactObject({
        id: item.id,
        displayName: stringValue(item.displayName),
        // A provider that declares capabilities sends them; otherwise the type
        // is the only evidence a row has, and an embedding model without it is
        // listed as if it were a chat model.
        capabilities: capabilities ?? (modelType === 'embedding' ? ['embedding'] : undefined),
        modelType,
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

/**
 * Only the two classes the Pod stores survive the wire.
 *
 * A server that sends anything else (an older release, a provider's own
 * vocabulary) leaves the row untyped, which reads as a chat model - never as a
 * value the AI config write would reject.
 */
function discoveredModelType(value: unknown): DiscoveredProviderModel['modelType'] {
  return value === 'chat' || value === 'embedding' ? value : undefined
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
