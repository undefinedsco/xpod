import type { AIModelClass } from '@undefineds.co/models'
/**
 * Wire and view types of the AI connections API. No behaviour.
 */
import type {
  AiClientCredentialsCapability,
  AiConnectionsModelSelection,
  AiConnectionsModelUsage,
  AiConnectionsOAuthCredential,
} from '@undefineds.co/extension-sdk/web'

export const AI_CONNECTIONS_PROVIDERS = [
  'openai',
  'anthropic',
  'kimi',
  'bailian',
  'deepseek',
  'zhipu',
  'ollama',
  'custom',
] as const

export type AiConnectionsProvider = (typeof AI_CONNECTIONS_PROVIDERS)[number]
export type AiConnectionsMode =
  | 'browserAssistedApiKey'
  | 'deviceCodeOAuth'
  | 'authorizationCodeOAuth'
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
  offeringId?: string
  authorizationMethodId?: string
  oauthCredential?: AiConnectionsOAuthCredential
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

/**
 * One row of the Xpod key list as the page renders it.
 *
 * The Account owns the credential, so a record carries identity
 * (`id`/`clientCredentialId`/`credentialResource`) and the label the user gave
 * it. `lastUsedAt`/`appliedAt`/`expiresAt`/`appliedTo` are session-local
 * observations or absent: the Account does not own them, and nothing here is a
 * second key index.
 */
export interface GatewayKeyRecord {
  id: string
  kind?: 'client-credentials'
  credentialResource?: string
  /**
   * Digest of the `sk-` wrapper the known client configuration was written with
   * (the same value the native adapters report as `apiKeyFingerprint`), never a
   * secret. It is a session-local observation: the Account owns no wrapper, so a
   * row restored from the Account list has no digest and cannot be tested. The
   * credential's equality identity stays `clientCredentialId`.
   */
  fingerprint?: string
  owner: string
  /** Account-owned scopes are not projected here; the wrapper's reach is the Pod. */
  scopes?: string[]
  /** Account credits carry no creation timestamp; absent rather than invented. */
  createdAt?: string
  expiresAt?: string
  lastUsedAt?: string
  disabledAt?: string
  revokedAt?: string
  name?: string
  maskedHint?: string
  plaintextAvailable?: boolean
  /** CSS/OIDC client id of the issued credential (the wrapper's `client_id`). */
  clientCredentialId?: string
  /** Client application the credential was written into, and the device that did it. */
  appliedTo?: string
  appliedOn?: string
  appliedAt?: string
  appliedClients?: string[]
}

export interface CreatedGatewayKey {
  plaintext: string
  record: GatewayKeyRecord
}

export interface AiGatewayModel extends AiConnectionsModelSelection {
  provider: AiConnectionsProvider
  /**
   * What kind of model this row is, when the Pod or the provider catalog knows.
   *
   * Rows read from the Pod carry it as their own column; the settings list shows
   * it as the same capability mark the Gateway projection uses.
   */
  modelType?: AIModelClass
  /** Owning credential for providers that allow multiple independent custom endpoints. */
  credentialId?: string
  displayName?: string
  availability?: 'available' | 'unavailable'
  contextWindow?: number
  /** Canonical embeddingModelResource.dimension, when supplied by the catalog. */
  dimension?: number
  protocols?: string[]
  custom?: boolean
  inputModalities?: string[]
  outputModalities?: string[]
  capabilities?: string[]
}

/** Public Gateway directory entries can belong to a platform or an unknown provider. */
export interface AiGatewayCatalogModel {
  id: string
  displayName?: string
  provider?: string
}

/**
 * What the provider's own model list said a model is.
 *
 * Two values only, because that is the distinction the product acts on and the
 * only one the Pod can store: the server infers it
 * (`ProviderModelType.inferProviderModelType`) and the Pod row keeps it, so an
 * embedding model stays selectable for embedding instead of being stored as an
 * ordinary chat model.
 */
export type DiscoveredProviderModelType = 'chat' | 'embedding'

export interface DiscoveredProviderModel {
  id: string
  displayName?: string
  capabilities?: string[]
  modelType?: DiscoveredProviderModelType
}

export interface CustomProviderModel {
  id: string
  displayName?: string
  inputModalities?: string[]
  outputModalities?: string[]
  capabilities?: string[]
}

export interface ProviderModelDiscovery {
  /** False when some service scopes failed; retain their previous catalog. */
  complete?: boolean
  provider: AiConnectionsProvider
  credential: string
  models: DiscoveredProviderModel[]
  observedAt: string
  source: string
}

export type AiProviderAuthorizationMethodId =
  | 'device-code'
  | 'local-session-import'
  | 'api-key'
  | 'local-service'
  /** Opens the provider console to sign in and mint the key the entry then stores. */
  | 'browser-login'
  /** Starts an authorization-code browser sign-in and waits for the local callback. */
  | 'browser-oauth'
  | string

export interface AiProviderAuthorizationMethod {
  id: AiProviderAuthorizationMethodId
  authMode: 'oauth' | 'deviceCode' | 'local' | 'apiKey'
  connectMode?: AiConnectionsMode
  /**
   * The wording the entry is shown under. Optional on purpose: the shared core
   * names the action by `id` and the applet supplies the wording, so a payload
   * carrying none is still a complete contract. A provider the user configured
   * may declare its own wording here, which is what keeps a custom entry from
   * rendering under a built-in name.
   */
  label?: string
  lifecycle: 'active' | 'unavailable'
  reason?: string
}

export interface AiProviderAuthorizationMethodsSummary {
  provider: AiConnectionsProvider
  offeringId: string
  endpoints?: AiProviderOffering['endpoints']
  authorizationMethods: AiProviderAuthorizationMethod[]
}

export interface AiConnectionBeginOptions {
  offeringId?: string
  authorizationMethodId?: string
}

export interface AiProviderOffering {
  id: string
  label?: string
  kind?: 'oauth-subscription' | 'api-platform' | 'token-plan' | 'local'
  lifecycle?: 'active' | 'legacy' | 'unavailable'
  authModes?: Array<'oauth' | 'deviceCode' | 'apiKey' | 'local'>
  authorizationMethods?: AiProviderAuthorizationMethod[]
  runtimeProviderIds?: string[]
  productLabel?: string
  credentialPrefixHints?: string[]
  consoleUrl?: string
  subscriptionUrl?: string
  endpoints?: Array<{ protocol: string; baseUrl: string; region?: string; supportsDeveloperMessages?: boolean }>
  modelDiscovery?: { strategy: string; path: string; endpointProtocol: string }
  quota?: { strategy: string; url: string }
  usagePolicyUrl?: string
  region?: string
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
  /** Proxy endpoint with credentials removed; the secret value never leaves the Pod. */
  proxyUrl?: string
  compatibility?: 'auto' | 'openai' | 'anthropic'
  lastFailureCode?: string
  lastFailureAt?: string
  rateLimitResetAt?: string
  failCount?: number
  expiresAt?: string
  version: number
}

export interface AiProviderSummary {
  id: AiConnectionsProvider
  name: string
  offerings: AiProviderOffering[]
  credentials: AiProviderCredentialSummary[]
  selectedModels: AiGatewayModel[]
  status: 'unconfigured' | 'configured' | 'available' | 'attention' | 'unavailable'
}

export type AiProviderSummaryStatus =
  | 'unconfigured'
  | 'configured'
  | 'available'
  | 'attention'
  | 'unavailable'

export interface CreateApiKeyCredentialInput {
  offeringId?: string
  apiKey: string
  label?: string
  baseUrl?: string
  proxyUrl?: string
  priority?: number
  compatibility?: 'auto' | 'openai' | 'anthropic'
}

export interface UpdateProviderCredentialInput {
  /** Nonempty replacement only; omission preserves the existing secret. */
  apiKey?: string
  expectedVersion: number
  label?: string
  enabled?: boolean
  priority?: number
  baseUrl?: string
  proxyUrl?: string
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
  listAuthorizationMethods?(): Promise<AiProviderAuthorizationMethodsSummary[]>
  listModels(): Promise<AiGatewayModel[]>
  listModelUsages?(): Promise<AiConnectionsModelUsage[]>
  /** Active Gateway routing projection, independent of a host's Pod catalog. */
  listGatewayModels?(): Promise<AiGatewayModel[]>
  /** Complete Gateway directory, including platform routing roles and unattributed entries. */
  listGatewayCatalogModels?(): Promise<AiGatewayCatalogModel[]>
  /**
   * Xpod key management is Account client-credentials management. These three
   * calls are backed by the host's `AiClientCredentialsCapability` and never by
   * a Gateway key route: a client without that capability fails closed.
   *
   * There is deliberately no enable/disable call - the Account has no such
   * capability - and no reveal call: the `sk-` wrapper exists only in the create
   * response and in `plaintexts` for the session that issued it.
   */
  listGatewayKeys(): Promise<GatewayKeyRecord[]>
  createGatewayKey(input: {
    name: string
    credentialResource?: string
    /** Client application the key is meant for; a session-local annotation only. */
    appliedTo?: string
  }): Promise<CreatedGatewayKey>
  deleteGatewayKey(keyId: string): Promise<void>
  beginConnect(provider: AiConnectionsProvider, mode: AiConnectionsMode, options?: AiConnectionBeginOptions): Promise<AiConnectAttempt>
  connectStatus(provider: AiConnectionsProvider, attempt: Pick<AiConnectAttempt, 'attemptId' | 'state' | 'signature' | 'offeringId'> & Partial<Pick<AiConnectAttempt, 'mode'>>): Promise<AiConnectAttempt>
  completeApiKey(
    provider: AiConnectionsProvider,
    attempt: Pick<AiConnectAttempt, 'attemptId' | 'state' | 'signature' | 'offeringId'> & Partial<Pick<AiConnectAttempt, 'mode'>>,
    apiKey: string,
    accountLabel?: string,
    baseUrl?: string,
  ): Promise<AiConnectAttempt>
  pollDevice(provider: AiConnectionsProvider, attempt: Pick<AiConnectAttempt, 'attemptId' | 'state' | 'signature' | 'offeringId'> & Partial<Pick<AiConnectAttempt, 'mode'>>): Promise<AiConnectAttempt>
  cancelConnect?(provider: AiConnectionsProvider, attempt: Pick<AiConnectAttempt, 'attemptId' | 'state' | 'signature' | 'offeringId'> & Partial<Pick<AiConnectAttempt, 'mode'>>): Promise<AiConnectAttempt>
  refreshOAuthCredential(provider: AiConnectionsProvider, credentialId: string, refreshToken: string, expectedVersion: number, offeringId?: string, mode?: AiConnectionsMode): Promise<AiConnectAttempt>
  disconnect(provider: AiConnectionsProvider, credentialId?: string): Promise<AiConnectionsCredential | undefined>
  createApiKeyCredential(provider: AiConnectionsProvider, input: CreateApiKeyCredentialInput): Promise<AiProviderCredentialSummary>
  createLocalCredential(provider: AiConnectionsProvider, input: { authorizationMethodId?: string; offeringId?: string; label?: string; baseUrl?: string; priority?: number }): Promise<AiProviderCredentialSummary>
  updateProviderCredential(provider: AiConnectionsProvider, credentialId: string, input: UpdateProviderCredentialInput): Promise<AiProviderCredentialSummary>
  deleteProviderCredential(provider: AiConnectionsProvider, credentialId: string): Promise<AiProviderCredentialSummary | undefined>
  testProviderCredential(provider: AiConnectionsProvider, input: TestProviderCredentialInput): Promise<Record<string, unknown>>
  quota(provider: AiConnectionsProvider, refresh?: boolean, input?: { offeringId?: string; credentialId?: string; credentialIri?: string }): Promise<AiQuotaSnapshot>
  quotaFromSecret(provider: AiConnectionsProvider, input: {
    credentialId: string
    credentialIri: string
    authMode: 'apiKey' | 'deviceCodeOAuth'
    offeringId?: string
    baseUrl?: string
    proxyUrl?: string
    compatibility?: 'auto' | 'openai' | 'anthropic'
    secret: Record<string, unknown>
  }): Promise<AiQuotaSnapshot>
  discoverModels(provider: AiConnectionsProvider, input?: {
    credentialId?: string
    offeringId?: string
    authMode?: 'apiKey' | 'deviceCodeOAuth' | 'local'
    secret?: Record<string, unknown>
    apiKey?: string
    baseUrl?: string
    proxyUrl?: string
    compatibility?: 'auto' | 'openai' | 'anthropic'
  }): Promise<ProviderModelDiscovery>
  saveModelSelection?(provider: AiConnectionsProvider, models: AiConnectionsModelSelection[], credentialId?: string): Promise<void>
  saveProviderModel(provider: AiConnectionsProvider, model: CustomProviderModel): Promise<CustomProviderModel[]>
  deleteProviderModel(provider: AiConnectionsProvider, modelId: string): Promise<CustomProviderModel[]>
}

/** Inputs the client factory derives every request from. */
export interface CreateAiConnectionsClientInput {
  webId: string
  podBaseUrl: string
  authenticatedFetch: typeof fetch
  /**
   * The Account client-credentials capability that backs Xpod key management.
   * Optional at the type level so a Pod-only client still type-checks, but the
   * three key calls fail closed without it.
   */
  clientCredentials?: AiClientCredentialsCapability
}
