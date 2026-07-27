# Applet Service Access and Host SDK Design

## Status

Approved for implementation on 2026-07-27.

## Context

LinX applets share the host's Solid OIDC session. Browser sessions normally use
DPoP-bound access tokens, so an Xpod API process cannot reuse a browser token to
write another resource: it does not possess the browser's DPoP private key and
cannot create a proof for the target Pod URL.

AI Connection also needs Xpod to read provider credentials after the browser has
closed, because Codex, Claude Code, Pi, and CodeBuddy call Xpod through a Gateway
Key rather than through the user's browser session.

The permission boundary therefore has to remain explicit in the Pod:

- the browser acts as the current Pod owner;
- Xpod acts as a distinct service WebID;
- the Pod owner grants that service WebID access to exact AI Connection
  resources;
- Xpod uses its own OIDC credentials when reading or writing those resources.

Neither the applet nor Xpod forwards a bare DPoP token. Xpod does not bypass Pod
ACL or ACP enforcement.

## Goals

1. Make AI Connection work for every authenticated WebID, not only the WebID
   associated with Xpod's internal client credentials.
2. Keep provider secrets and Gateway Key records in the user's Pod as the final
   source of truth.
3. Put permission orchestration in reusable Host SDK capabilities rather than in
   AI Connection UI code.
4. Keep applets independent of local/cloud deployment and of the host shell.
5. Allow the same applet to run in LinX, the standalone test host, and future
   desktop or browser hosts.
6. Grant the smallest practical access surface and make every grant observable,
   retryable, and revocable.

## Non-goals

- Applets do not implement OIDC callbacks, token refresh, DPoP proofs, WAC, or
  ACP directly.
- This design does not grant Xpod access to all of `/settings/` or to a Pod
  root.
- Provider API secrets are never returned to the applet after completion.
- The SDK does not expose local/cloud branching or filesystem placement.
- This design does not introduce a second account system or a second login.

## Identity Model

Xpod has one configured service identity:

```ts
interface ServicePrincipal {
  webId: string
  clientId?: string
  label: string
}
```

The WebID is authoritative. `clientId` is descriptive metadata and is not used
as the Pod ACL agent identifier.

Xpod obtains a token for this service identity through its configured internal
OIDC client credentials. The token response must contain one stable,
authoritative WebID. Xpod caches the token by service identity, not by target
Pod owner.

When Xpod accesses a user's AI Connection resource, the Pod server authorizes
the service WebID through the resource's ACL or ACP policy. Xpod still verifies
that the authenticated management caller owns the target resource locator
before mutating it.

## Resource Boundary

AI Connection uses exact, model-owned resource URLs:

| Purpose | Resource |
| --- | --- |
| Provider credentials | `{podRoot}/settings/credentials.ttl` |
| Provider definitions | `{podRoot}/settings/providers.ttl` |
| Gateway access keys | `{podRoot}/settings/ai/gateway/access-keys.ttl` |
| Provider quota snapshots | `{podRoot}/settings/ai/quota-snapshots.ttl` |

The authoritative paths continue to come from `@undefineds.co/models`. Applet
and Xpod code must not duplicate path-building rules.

Each target resource is created before access is granted. A grant applies only
to that resource. Parent-container default access is not changed.

The service receives:

- `read`, `append`, and `write`;
- no `controlRead` or `controlWrite`;
- no permission to alter the resource's access-control document.

The Pod owner retains control access.

## Discovery Protocol

Xpod exposes an authenticated management endpoint:

```http
GET /api/applets/service-access/ai-connection
```

Successful response:

```json
{
  "appletId": "co.undefineds.ai-connection",
  "service": {
    "webId": "https://id.example/xpod-service/profile/card#me",
    "label": "Xpod AI Connection"
  },
  "resources": [
    {
      "id": "providerCredentials",
      "url": "https://pod.example/alice/settings/credentials.ttl",
      "mediaType": "text/turtle",
      "access": { "read": true, "append": true, "write": true }
    }
  ]
}
```

Rules:

- the endpoint requires a valid Solid management session;
- every returned resource URL must be inside the authenticated WebID's current
  Pod;
- Xpod derives URLs from shared models and the authenticated WebID;
- the caller cannot submit or override a resource URL or service WebID;
- responses contain no client secret, access token, DPoP proof, provider secret,
  or Gateway Key secret.

## Host SDK Capability

The extension host exposes a generic permission capability:

```ts
interface SolidAgentAccess {
  read?: boolean
  append?: boolean
  write?: boolean
}

interface SolidServiceAccessRequest {
  appletId: string
  service: {
    webId: string
    label: string
  }
  resources: Array<{
    id: string
    url: string
    mediaType: 'text/turtle'
    access: SolidAgentAccess
  }>
}

interface SolidPermissionCapability {
  inspectAgentAccess(
    request: SolidServiceAccessRequest,
  ): Promise<SolidServiceAccessStatus>

  ensureAgentAccess(
    request: SolidServiceAccessRequest,
  ): Promise<SolidServiceAccessStatus>

  revokeAgentAccess(
    request: SolidServiceAccessRequest,
  ): Promise<SolidServiceAccessStatus>
}
```

`WebExtensionSolidCapability` owns this permission capability alongside
`session`, `pod`, and `requireLogin`. AI Connection asks for access through the
host; it never imports Inrupt access-control functions.

The initial browser implementation adapts Inrupt
`universalAccess.setAgentAccess`. The adapter is isolated because that API is
experimental and because future hosts may use WAC-specific, ACP-specific, or
native desktop implementations.

## Provisioning Flow

1. The host restores the shared Solid session and opens the current Pod.
2. AI Connection activates and requests its service-access descriptor from
   Xpod.
3. The controller validates the descriptor against:
   - the applet ID;
   - the current Pod root;
   - allowed media types;
   - supported access modes.
4. The controller asks `solid.permissions.inspectAgentAccess`.
5. If access is missing, the UI shows one host-owned permission action
   describing the service WebID and exact resources.
6. After user confirmation, the host:
   - creates each missing RDF resource with an empty Turtle document;
   - calls the access adapter for that exact resource;
   - reads access back and verifies the effective result.
7. AI Connection retries its provider and Gateway Key reads.
8. Xpod uses its service OIDC session for all subsequent Pod operations.

Trusted hosts may adopt a policy that confirms the grant at applet-install time.
The applet API remains the same; policy and presentation belong to the host.

## Applet Lifecycle

Applet activation remains idempotent:

```text
mount -> createController -> activate
                           -> discover service access
                           -> inspect/ensure permission
                           -> load providers and keys
```

`activate()` may be replayed by React StrictMode. The controller uses one
single-flight promise per permission request and per provider load. Unmounting
does not revoke access automatically; installation and access grants outlive a
component render.

A host without the permission capability returns an explicit
`capabilityUnavailable` state. The applet remains renderable and independently
testable; it does not fall back to unsafe token forwarding.

## Server-side Pod Access

The internal token provider changes from target-owner impersonation to a stable
service principal:

```text
configured client credentials
    -> service OIDC token
    -> authoritative service WebID
    -> authenticated fetch
    -> Pod ACL/ACP authorizes exact resource
```

The provider must reject a token if its authoritative WebID changes from the
configured or first verified service WebID.

Repositories receive the service fetch. They do not:

- compare the service WebID with the Pod owner's WebID;
- fall back to forwarding a DPoP access token without a matching proof;
- swallow 401 or 403 responses as an empty resource;
- access a URL outside the authenticated owner's derived Pod root.

Bearer management credentials can still be used for test and delegated
execution paths, but they are not required for browser operation.

## Error Handling

The host maps failures to stable states:

| Failure | Applet state | Recovery |
| --- | --- | --- |
| Session expired | `loginRequired` | Host refresh/login |
| Service descriptor rejected | `invalidDescriptor` | Stop; report Xpod contract error |
| Resource creation denied | `permissionDenied` | Show resource and retry action |
| Access API unavailable | `capabilityUnavailable` | Host-specific guidance |
| Grant verification mismatch | `permissionDenied` | Do not call Connect |
| Service fetch receives 401 | `serviceAuthenticationFailed` | Refresh service token |
| Service fetch receives 403 | `serviceAccessMissing` | Re-run host permission flow |

Errors and logs may contain applet ID, resource purpose, HTTP status, and a
redacted origin. They must not contain tokens, DPoP proofs, API keys, encrypted
secret payloads, Gateway Key secrets, or URL query strings.

## Revocation

`revokeAgentAccess` removes the service WebID's explicit access from the exact
resources and verifies the result. Revoking service access is distinct from:

- disconnecting one provider;
- revoking one Gateway Key;
- uninstalling the applet.

The host may offer all three actions separately. Removing the applet does not
silently delete Pod data.

## Testing

### SDK unit tests

- permission capability types are host-independent;
- descriptors outside the current Pod are rejected;
- resource creation occurs before access mutation;
- grants are read back and verified;
- StrictMode activation coalesces permission work;
- missing capability produces an explicit state;
- revoke changes only the requested service agent.

### Xpod unit tests

- service identity discovery returns an authoritative WebID and model-derived
  resource URLs;
- caller-controlled resource URLs are impossible;
- the internal token provider caches one stable service identity;
- a changed token WebID fails closed;
- repositories never forward a bare DPoP token.

### Real E2E

The existing seeded runtime test is extended with a second browser account:

1. sign in through the real Solid OIDC browser flow;
2. grant Xpod's service WebID access to the second user's exact resources;
3. connect OpenAI with an API Key;
4. verify ciphertext and wrapped key exist in the second Pod and plaintext does
   not;
5. create a Gateway Key;
6. call `/v1/models` and streaming `/v1/responses`;
7. verify the first user's provider and key records are not visible;
8. revoke service access and verify Xpod receives 403 for that user's resources.

### Regression gates

- LinX typecheck and full Web unit suite;
- extension SDK, AI Connection, and standalone host suites;
- Xpod TypeScript build and focused auth/repository suites;
- Xpod lite integration suite;
- Xpod full integration suite when Docker dependencies are available.

## Security Invariants

1. The current Pod owner is the only actor that creates or changes the grant.
2. The service agent is an authoritative WebID, not a caller-provided string.
3. Resource URLs are derived from the authenticated WebID and shared models.
4. No service receives control access.
5. No raw browser DPoP token is reused for another URL.
6. Pod ACL or ACP remains the enforcement point.
7. Pod records remain the authorization, revocation, and credential source of
   truth.
8. Applets consume a host capability and cannot reach host session internals or
   access-control implementation details.

## Rollout

1. Add the SDK types and an Inrupt-backed host adapter.
2. Add Xpod service identity discovery and stable service-token handling.
3. Gate AI Connection Connect and Gateway Key actions on verified access.
4. Extend the real two-WebID E2E.
5. Remove temporary request-auth fallback paths after all hosts provide the
   permission capability.
