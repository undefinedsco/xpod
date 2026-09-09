# AI Connection Client-Credentials Convergence Plan

## Goal

Use Xpod's existing Solid authentication surfaces for every AI Connection request:

- browser/Applet requests use Solid OIDC Bearer/DPoP and already carry a WebID;
- coding clients use the existing `sk-${base64(client_id:client_secret)}` wrapper, which `ClientCredentialsAuthenticator` exchanges at CSS for a Solid token and WebID.

Remove the duplicate Xpod Gateway Key/locator design from the active product. Provider API keys and browser-assisted provider tokens remain private Credential resources in the authenticated user's Pod.

## Constraints

- `ClientCredentialsAuthenticator` and CSS account client-credentials remain the sole coding-client API-key mechanism.
- No locator secret, owner index, GatewayAccessKey RDF document, or gateway-key pre-auth Pod read is needed.
- Pod data access always receives a verified `SolidAuthContext`; `viaApiKey` is the existing client-credentials marker.
- Internal invocation tokens for bounded agent/runtime calls are a separate capability and must use an independent configured or process-ephemeral signing key.
- Preserve existing task-system long-term delegation; do not replace it with browser-session credentials.
- Lock current client-credentials behavior with regression tests before deleting duplicate paths.

## Cleanup sequence

1. Add regressions proving an `sk-*` client credential authenticates `/v1/models`, `/v1/chat/completions`, and `/v1/responses` with the exchanged WebID and accesses only that WebID's Pod.
2. Replace AI Connection's “Gateway Keys” product surface with the existing CSS account client-credentials capability and API-key wrapper format.
3. Remove `GatewayApiKeyAuthenticator` from `MultiAuthenticator`, Gateway key management routes, locator codecs, Pod GatewayAccessKey repository, gateway-key-specific scopes/context fields, and internal pre-auth scope handling where no remaining consumer exists.
4. Remove `gatewayAccessKeys` from AI Connection service-access descriptors and the applet service-access contract.
5. Decouple invocation signing and session affinity from `XPOD_GATEWAY_LOCATOR_SECRET`; use their own configured values or process-ephemeral random values.
6. Update settings/client configuration flows and tests to create/revoke CSS client credentials, show the `sk-*` API key once, and generate Codex/Claude/Pi/CodeBuddy configuration from it.
7. Update configuration and architecture documentation. Explicitly mark locator variables obsolete for AI Connection.
8. Run focused auth/UI tests, build/typecheck, package tests, full integration, browser acceptance, RC deployment, then production acceptance.

## Non-goals

- Do not change the provider Credential RDF schema.
- Do not store client secrets in the Pod; CSS account client-credential storage remains authoritative for Xpod API access keys.
- Do not introduce a second API-key database or locator projection.
- Do not remove unrelated node/service token authentication.
