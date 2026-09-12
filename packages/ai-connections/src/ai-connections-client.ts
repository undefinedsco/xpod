/**
 * Public entry point of the AI connections client
 * (`@undefineds.co/ai-connections/client`).
 *
 * The implementation lives in `./client`, split into wire types, payload
 * normalisation and the request factory. This file stays a barrel — importers
 * keep using this path, so the published `./client` export is unchanged — and it
 * lists the surface explicitly rather than re-exporting whole modules: the
 * parsers under `./client` are internal, and `export *` would publish them.
 */
export { AI_CONNECTIONS_PROVIDERS } from './client/types'
export type {
  AiConnectAttempt,
  AiConnectionBeginOptions,
  AiConnectionsClient,
  AiConnectionsCredential,
  AiConnectionsMode,
  AiConnectionsProvider,
  AiConnectStatus,
  AiGatewayModel,
  AiProviderAuthorizationMethod,
  AiProviderAuthorizationMethodId,
  AiProviderAuthorizationMethodsSummary,
  AiProviderConnectionSummary,
  AiProviderCredentialSummary,
  AiProviderOffering,
  AiProviderSummary,
  AiProviderSummaryStatus,
  AiQuotaSnapshot,
  AiQuotaWindow,
  CreateApiKeyCredentialInput,
  CreatedGatewayKey,
  CustomProviderModel,
  DiscoveredProviderModel,
  GatewayKeyRecord,
  ProviderModelDiscovery,
  TestProviderCredentialInput,
  UpdateProviderCredentialInput,
} from './client/types'
export {
  AI_CONNECTIONS_GENERIC_ERROR_MESSAGE,
  AiConnectionsRequestError,
  normalizeAiConnectionsErrorMessage,
  normalizeAiConnectionsThrownError,
  normalizeProxyUrl,
  redactProxyUrl,
} from './client/normalize'
export { createAiConnectionsClient, resolveAiConnectionsApiBase } from './client/request'
