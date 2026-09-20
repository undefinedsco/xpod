/**
 * Public entry point of the AI Connections client protocol. This package is
 * the shared core: the gateway and the applet both consume it, and the applet
 * (`@undefineds.co/ai-connections`) adds the components, artwork and wording.
 * (`@undefineds.co/ai-connections-core/client`).
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
  AiConnectionsRequestError,
  aiConnectionsErrorCode,
  normalizeProxyUrl,
  redactProxyUrl,
} from './client/normalize'
export { createAiConnectionsClient, resolveAiConnectionsApiBase } from './client/request'
/**
 * Storage-shape rules for credential rows. They are shared with the Pod adapter
 * (`ui/src/extensions/XpodAiConnectionsPodStore.ts`) and with the collection
 * layer that writes the same rows: one envelope format, one provider relation.
 */
export {
  credentialProviderRelation,
  credentialRowKeyFor,
  credentialSecretEnvelope,
  customCredentialProviderRelation,
  decodeCredentialSecret,
  providerOfCredentialKey,
  providerResourceKey,
  providerResourceReference,
} from './credential-storage'
export type {
  CredentialSecretEnvelopeInput,
  CredentialSecretReadInput,
} from './credential-storage'
