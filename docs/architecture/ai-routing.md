# AI Routing Architecture

This document is the current source of truth for Xpod AI routing.

**Status:** boundary correction is implemented for platform AI routing. Platform-model Chat calls pass against a real local Xpod. User-provider execution through Xpod API is allowed only when the current request carries caller-owned Solid client credentials; browser DPoP requests fail closed and the external `ai-gateway` never receives Pod authority or BYOK settings. The drizzle-solid configured-endpoint and LDP update readback fixes are released upstream in 0.3.24 and covered by focused regression tests. Plain `.ttl` resources remain RDF document sources fetched by the Solid client/Comunica path, not SPARQL Protocol endpoints. The full RC Web flow still needs to pass save -> reload -> read -> update before promotion. PG17 release-artifact and production verification are pending.
**Compatibility impact:** breaking removal of the former Gateway-to-Pod access design; no compatibility layer, migration, or fallback is retained.
**Release boundary:** code verification is separate from RC promotion and production replacement.

The external `ai-gateway` service is only the platform model execution plane. It must never read user Pods, receive Pod credentials or authority, receive Pod URL/WebID as routing or authorization metadata, or receive user BYOK provider credentials. Inference content can still contain user-selected text or URLs; that content grants no Pod access. Xpod owns routing and the `/v1/*` API surface. The browser settings UI owns user provider configuration by using the current browser Solid session to read and write the user's Pod directly.

There is no internal service account, gateway WebID, ACP grant, or platform principal that can read a user Pod for AI routing. Xpod API may read Pod-backed BYOK settings only with Solid client credentials supplied by the caller for the current request. Browser DPoP tokens are not replayed by the server. User-provider configuration must never be forwarded to `ai-gateway`.

## Component Boundary

| Component | Owns | Must not own |
| --- | --- | --- |
| Browser settings UI | Logged-in browser Solid session, direct Pod read/write for provider rows, model rows, and plaintext `credential.apiKey` | Server-side Pod reads, platform model execution, external gateway credentials |
| Xpod API | Solid caller authentication, stateless provider probes, unified `/v1/*` routing, platform model forwarding, caller-owned client-credentials Pod reads for user-provider execution | Browser settings persistence, replaying browser DPoP tokens to Pods, gateway WebIDs, Pod ACP grants, provider-key persistence, service-account Pod reads |
| External `ai-gateway` | Platform model execution for `linx` and `linx-lite`, LiteLLM virtual keys, execution-plane retry/budget behavior | Pod reads, Pod authority, Pod identity used as routing/auth metadata, user BYOK credentials, product account semantics |
| User Pod | User-supplied provider configuration, provider credentials, user model metadata | Platform cloud model catalog rows, gateway invocation tokens |

## Request Flow

### Browser Settings

1. The user logs in with the browser Solid session.
2. The settings UI reads and writes provider/model records directly in the user's Pod.
3. User BYOK credentials are stored as plaintext `credential.apiKey` in the Pod.
4. Xpod API is not in the persistence path for settings data.

The settings UI can call Xpod API only for stateless provider probes. Probe requests explicitly include the transient `apiKey` and optional `baseUrl` in the current request body. Xpod uses them only for that probe call, does not accept WebID or Pod authority for the probe, and does not persist or return the secret.

### Model Listing

1. The client calls Xpod `/v1/models`.
2. Xpod always includes platform models `linx-lite` and `linx` from server-side platform configuration.
3. Browser DPoP callers get the shared platform catalog without any Pod read.
4. Browser DPoP callers get no Pod model merge because the server cannot replay a browser DPoP session.
5. Callers using the `sk-base64(client_id:client_secret)` wrapper get user-configured models merged from their Pod through a fresh server-side Solid session.

Platform models are visible without writing catalog rows into the user's Pod. Platform model ownership wins if a stale Pod row has the same model id.

### Platform Model Inference

1. The client calls Xpod `/v1/chat/completions`, `/v1/responses`, or another supported `/v1/*` endpoint.
2. Xpod authenticates the caller and selects the requested model.
3. If the model is `linx` or `linx-lite`, Xpod forwards the request to external `ai-gateway`.
4. Xpod uses server-only `DEFAULT_API_BASE` and `DEFAULT_API_KEY` for that hop.

The external `ai-gateway` sees only Xpod's platform execution credential. It does not receive authority to read the user's Pod and does not receive user provider keys.

A Pod-capable agent process is an Xpod-side client acting with the caller's Solid authority. Its Solid token can be available to local agent tools, but it is not an `ai-gateway` credential and must never be copied into gateway request headers, routing metadata, or provider configuration. Pod content deliberately selected for inference remains ordinary model input and does not give the gateway a reusable Pod session.

### User Provider Inference

1. The client calls Xpod `/v1/*` with a user-configured model.
2. Xpod requires caller-owned Solid client credentials in the current auth context.
3. Xpod exchanges those client credentials for a server-side Solid session, reads the user's Pod provider/model/credential rows through drizzle-solid, and calls the selected provider directly.
4. Provider secrets stay inside this Xpod request path and are not sent to external `ai-gateway`.

Browser DPoP is valid authentication for the current Xpod API request, but it is not reusable server-side Pod authority. Browser callers therefore fail closed for user-provider inference unless they switch to a caller-owned client-credentials API flow.

### Stateless Provider Probe

1. The browser settings UI calls `/api/ai/connections/providers/:provider/models/refresh` or `/api/ai/connections/providers/:provider/quota/refresh`.
2. Xpod authenticates the current API request.
3. The request body provides the transient provider `apiKey` and optional `baseUrl`.
4. Xpod validates the provider and base URL, calls the provider adapter, and returns sanitized probe results. Cloud accepts only the registered HTTPS endpoints; Local accepts an explicit HTTP(S) self-hosted endpoint supplied by the current authenticated user.

The probe service and provider adapters do not receive WebID, Pod URL, Pod authority, stored credentials, or service identity context. These are not connect routes and they do not create server-side provider state.

## Security Invariants

- The user still logs in. This is zero configuration for platform models, not zero login.
- Browser settings data is persisted by the browser's own Solid session, not by Xpod API.
- The Pod settings status API reports platform-owned identity and usage data only; it does not read or summarize Pod AI provider records.
- External `ai-gateway` cannot read Pod data and must not receive Pod URLs or user WebIDs as routing or authorization metadata.
- There is no gateway WebID for user-Pod authorization rules.
- There are no Pod ACP grants for a gateway or platform principal.
- There are no gateway invocation keys, connect tokens, or legacy bearer-key records.
- There is no internal AI service account that reads user Pods.
- There is no compatibility layer, fallback path, or migration for removed gateway-backed provider management.
- Platform model configuration uses server-only `DEFAULT_API_BASE` and `DEFAULT_API_KEY`.
- Every platform execution path branches before constructing a Pod database or reading provider/credential rows.
- User BYOK/self-hosted provider calls through `/v1` may read Pod configuration only under caller-owned Solid client credentials.
- Cloud BYOK execution accepts only the registered provider's safe HTTPS base URLs and never honors a Pod-supplied proxy URL. Local edition may use explicit HTTP(S) self-hosted endpoints and proxies.
- Browser DPoP callers fail closed for server-side user-model Pod reads.
- Stateless provider probe routes may use a request-body `apiKey`, but never persist it or use it to read Pod data. Cloud remains restricted to registered HTTPS endpoints; Local may probe an explicit self-hosted HTTP(S) endpoint.

## Test Evidence

The boundary is covered by the following test targets:

| Evidence | What it proves |
| --- | --- |
| `tests/service/VercelChatServiceConfig.test.ts` | Platform model calls use `DEFAULT_API_BASE`/`DEFAULT_API_KEY`; platform model listing is visible without Pod reads or gateway identity metadata for browser callers; user model calls fail closed for browser DPoP but use caller-owned client credentials to read Pod provider config; client-credentials model listing merges Pod-backed user models while platform models win on duplicate ids. |
| `tests/agent/AgentExecutorFactoryBoundary.test.ts` | Platform agent execution branches before any Pod database/provider lookup; cloud user-provider execution rejects Pod-controlled unsafe base URLs and proxies. |
| `tests/api/auth/SolidClientCredentialsSession.test.ts` | Server-side Pod access creates a fresh Node Solid session from client credentials instead of replaying the API request token. |
| `tests/api/ClientCredentialsAuthenticator.test.ts` | `sk-base64(client_id:client_secret)` is parsed and exchanged as CSS client credentials. |
| `tests/api/container/config.test.ts` | Xpod API container does not register Pod-backed gateway runtime services, provider connect state, provider quota services, credential vaults, or gateway credential stores. |
| `tests/api/RoutesRegistration.test.ts` | Unified `/v1/*` routes remain available; obsolete bearer-key, applet descriptor, connect, and fallback routes are absent; stateless AI Connections probe routes are present. |
| `tests/api/handlers/AiConnectionsHandler.test.ts` | Provider probes require the current API caller, accept only explicit transient request credentials, and do not forward auth/WebID/Pod authority to provider services. |
| `tests/api/ai-connections/ProviderProbeService.test.ts` | Provider probes are request-scoped, reject unsafe base URLs, and do not depend on stored Pod credentials. |
| `tests/api/ai-connections/ProviderModelsAdapters.test.ts` | Provider model discovery adapters use only the explicit provider key/base URL supplied for the probe. |
| `tests/api/service/ProviderRegistry.test.ts` | Cloud provider transport accepts only exact registered HTTPS endpoints and rejects Pod-supplied proxies; local self-hosted HTTP(S) remains explicit. |
| `tests/api/handlers/PodSettingsHandler.test.ts` | The Pod settings status API has no AI provider reader or `aiConnection` response field. |
| `tests/integration/XpodSettings.integration.test.ts` | The lightweight settings acceptance plan includes the `ai-routing-boundary` item. |

Run focused verification with:

```bash
bun run test:run -- tests/service/VercelChatServiceConfig.test.ts tests/api/auth/SolidClientCredentialsSession.test.ts tests/api/ClientCredentialsAuthenticator.test.ts tests/api/container/config.test.ts tests/api/RoutesRegistration.test.ts --poolOptions.forks.minForks=1 --poolOptions.forks.maxForks=2
bun run test:run -- tests/api/handlers/AiConnectionsHandler.test.ts tests/api/ai-connections/ProviderProbeService.test.ts tests/api/ai-connections/ProviderModelsAdapters.test.ts tests/api/ai-connections/ProviderQuotaAdapters.test.ts --poolOptions.forks.minForks=1 --poolOptions.forks.maxForks=2
bun run test:run -- tests/api/handlers/PodSettingsHandler.test.ts tests/integration/PodSettingsApi.integration.test.ts ui/src/api/pod-settings.test.ts ui/src/pages/settings/PodPage.test.tsx --poolOptions.forks.minForks=1 --poolOptions.forks.maxForks=2
bun run test:run -- tests/agent/AgentExecutorFactoryBoundary.test.ts tests/agent/Executors.test.ts tests/api/service/ProviderRegistry.test.ts --poolOptions.forks.minForks=1 --poolOptions.forks.maxForks=2
```

Run the final repository gate before release:

```bash
bun run build:ts
bun run test:integration
```

Local verification on 2026-08-25 currently proves the platform catalog and platform Chat path against a real local Xpod. Provider and credential RDF resources are browser-owned settings data; Xpod API treats them as server-readable routing state only when the current request carries caller-owned Solid client credentials. The fresh-browser/ORM readback bug was that drizzle-solid selected `SparqlStrategy` for configured resources but still queried the physical `.ttl` URL as if it were a SPARQL Protocol endpoint. drizzle-solid 0.3.24 makes configured table `sparqlEndpoint` values drive SELECT queries while LDP update/delete reads keep plain `.ttl` URLs on the authenticated Comunica document-source path; unchanged triples are not rewritten. Xpod does not copy Turtle parsing into the product layer. `tests/drizzle-solid/sparql-strategy-endpoint.test.ts` proves relative and absolute configured endpoints are used as SPARQL sources, and `ui/src/solid/SparqlEndpointQueryEngine.test.ts` proves plain `.ttl` sources use authenticated GET. Do not describe browser persistence as complete until the real Web flow passes save -> reload -> read -> update in RC.

## Deployment Status

This architecture describes the implemented current code boundary. Passing local tests means the code path is ready for release-artifact validation. It does not mean production has already been replaced.

Production replacement must be tracked separately by release evidence: deployed image digest, runtime configuration showing Xpod has `DEFAULT_API_BASE` and `DEFAULT_API_KEY`, smoke output for `linx-lite` and `linx`, and confirmation that obsolete bearer-key, applet descriptor, connect, invocation-token, fallback, and gateway Pod-access routes are not exposed.
