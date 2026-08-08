# Caller-Owned AI Connections Access Design

> Date: 2026-08-09
>
> Status: approved direction, based on the product decisions recorded in the AI Connections thread
>
> Scope: replace the default Xpod service identity in AI Connections without changing the Provider/Offering/Credential/Model product model.

## 1. Decision

AI Connections must not depend on a deployment-wide
`XPOD_GATEWAY_INTERNAL_CLIENT_ID` / `XPOD_GATEWAY_INTERNAL_CLIENT_SECRET` pair.
The identity that authorizes a Pod operation must be self-describing in the
calling context:

- interactive Settings/LinX management uses the current Solid browser session;
- Codex, Claude Code, Pi and CodeBuddy use the existing
  `sk-base64(client_id:client_secret)` wrapper; Xpod exchanges those user-owned
  CSS client credentials for a short-lived Solid token bound to the same WebID;
- durable task execution uses a separate delegated authorization owned by the
  task system. It is not part of this design and must never be inferred from a
  browser login or from a global service account.

`deployment: local | cloud` remains an Xpod runtime concern. AI Connections data
and authorization do not branch on it in the Applet.

## 2. Rejected default

The current default is rejected:

```text
browser login
  -> grant four Pod resources to one Xpod service WebID
  -> mint an invocation token
  -> API reads/writes every user's Pod with global client credentials
```

It requires a global secret, makes the Applet depend on an Xpod deployment
identity, and turns an interactive user action into service delegation. It also
blocks local acceptance whenever the global service credential is absent.

The Solid permission broker remains an SDK capability for Applets that truly
need agent/service delegation, but AI Connections no longer invokes it during
ordinary interactive management.

## 3. Authorization lanes

### 3.1 Interactive management

The host exposes an `AiConnectionsPodStore` capability backed by the already
opened `OpenPodRuntime.database`. The adapter uses `@undefineds.co/models` and
drizzle-solid for Provider, Credential, Model Selection and Gateway client
metadata CRUD. The Applet sees a narrow storage interface; it does not import
Xpod server modules and does not reach into the host session.

```text
Applet action
  -> AiConnectionsPodStore
  -> drizzle-solid database opened with current Session.fetch
  -> user's Pod
```

The management API remains responsible only for operations that need a trusted
server boundary: Provider OAuth integration, upstream network probes, quota
adapters and client filesystem apply. When such an operation needs a Provider
secret, the host reads the selected credential with the current session and
sends the secret only in the authenticated request body. The server must not
persist or log that transient secret, and its response must not echo it.

OAuth completion returns a one-time credential payload to the initiating
authenticated browser. The host immediately writes it to the Pod and discards
the response object. OAuth `client_secret` remains server-only; Provider access
and refresh tokens are user-owned credential data and may enter the browser on
this authenticated handoff.

### 3.2 Coding clients and standard APIs

The public API key is not a second Xpod key type. It is the already implemented
transport wrapper:

```text
sk-base64(client_id:client_secret)
```

`ClientCredentialsAuthenticator` exchanges it at the CSS token endpoint and
produces a Solid auth context containing the owner WebID and a short-lived
Bearer token. Repository adapters use that caller token to open the same Pod
data through drizzle-solid. They must reject owner mismatch, missing token and
DPoP tokens for which the server cannot generate a fresh proof.

The opaque `akv2` locator/key repository is removed from the AI Connections
product path. Existing records may remain readable for a bounded migration, but
the UI must not create new opaque Gateway keys and `/v1/models`,
`/v1/responses`, `/v1/chat/completions` and `/v1/messages` must work with the
CSS client-credentials wrapper.

### 3.3 Durable work

A future task delegation capability may issue a scoped fetch for an owner and
expiry. Repositories may accept it only when the auth context explicitly says
`delegatedTask`; there is no fallback from missing caller authorization to a
deployment service identity.

## 4. Applet and SDK boundaries

The extension SDK adds an optional host capability:

```ts
interface AiConnectionsPodStore {
  listProviders(): Promise<AiProviderSummary[]>
  createApiKeyCredential(provider: string, input: CreateApiKeyCredentialInput): Promise<AiProviderCredentialSummary>
  updateCredential(provider: string, credentialId: string, input: UpdateProviderCredentialInput): Promise<AiProviderCredentialSummary>
  deleteCredential(provider: string, credentialId: string): Promise<void>
  readCredentialSecret(provider: string, credentialId: string): Promise<Record<string, unknown>>
  saveDiscoveredModels(provider: string, credentialId: string, models: DiscoveredProviderModel[]): Promise<void>
  saveModelSelection(provider: string, modelIds: string[]): Promise<void>
  saveOAuthCredential(provider: string, payload: OneTimeOAuthCredential): Promise<AiProviderCredentialSummary>
}
```

The concrete Xpod adapter owns model imports, exact RDF ids, plaintext-v1
credential envelope compatibility and collection hydration. The Applet
controller composes the Pod store with an operations client. LinX can provide
the same capability over its shared Solid runtime and therefore executes the
same logic.

## 5. Product behavior

- A successful Solid login immediately loads Providers. There is no “service
  access authorized” banner and no permission grant before Provider data.
- Adding an API Key writes it directly to the current Pod and survives reload.
- Multiple OAuth accounts and API keys remain sibling credentials and are
  addressed by credential id.
- Model discovery tests one selected credential, merges upstream models and
  stores the catalog/selection through the Pod store.
- Models removed upstream stay visible with an unavailable marker; only picked
  models appear through `/v1/models`.
- “Client access” explains or imports CSS client credentials. It does not mint
  an opaque Xpod Gateway key.
- Codex, Claude Code, Pi and CodeBuddy apply the stable Xpod endpoint plus the
  `sk-base64(...)` wrapper.

## 6. Error contract

- `caller_pod_access_unavailable`: request has no usable caller/delegated Pod access;
- `caller_owner_mismatch`: credential WebID differs from the requested Pod owner;
- `caller_dpop_replay_unsupported`: server received a DPoP token but cannot replay it for another URL;
- `credential_collection_query_unsupported`: Pod lacks the required collection sidecar;
- `provider_test_failed`: transient upstream probe failed; no secret is returned;
- `authorization_expired` / `authorization_denied`: Provider OAuth terminal states.

These are safe product errors. Raw upstream bodies, tokens and credential
payloads never enter logs or error responses.

## 7. Acceptance gates

### Interactive browser

1. Start closed-auth Xpod with `CSS_SEED_CONFIG`; seeded profile contains
   `solid:oidcIssuer` and `solid:storage`.
2. Log in through the shared LinX/Xpod Solid login and select the existing Pod;
   no second Pod creation appears.
3. Add two API keys for one Provider; reload and observe both.
4. Edit priority/label/enabled, delete exactly one credential, and verify the
   sibling remains.
5. Run a real or deterministic local upstream model discovery, pick models,
   reload, and verify unavailable selected models remain visible.
6. Confirm no request or startup path requires the two global internal-client
   environment variables.

### Standard API

1. Create CSS client credentials for the same WebID and wrap them as `sk-*`.
2. `/v1/models` returns only picked models.
3. Responses, Chat Completions and Messages each complete one request through
   the selected Provider credential.
4. Wrong-WebID, expired and revoked client credentials cannot read the Pod.

### Regression

- drizzle-solid CRUD tests cover exact ids and collection hydration;
- management tests prove transient secrets are not persisted or echoed;
- package tests cover Applet behavior without a permission service;
- full integration tests remain green;
- browser evidence is recorded from the built Settings product, not a Vite
  prototype.

## 8. Migration and removal

The first implementation keeps old service-access and `akv2` code only behind
explicit legacy compatibility. No new UI action or default container wiring may
create or require it. After production confirms CSS client-credential traffic,
remove:

- `XPOD_GATEWAY_INTERNAL_CLIENT_ID`;
- `XPOD_GATEWAY_INTERNAL_CLIENT_SECRET`;
- the AI Connections service-access descriptor/invocation bootstrap;
- opaque Gateway-key creation from Settings;
- default `gatewayInternalPodAccess` injection into credential, quota, model and
  custom-model repositories.
