# Plaintext Pod Credentials Interim Design

## Status

Approved direction for an interim implementation. This design deliberately postpones SecretCell encryption until root-key ownership, Pod data keys, rotation, long-running delegation, and cross-Pod portability are specified together.

## Decision

AI Connection keeps the existing split between provider metadata and a dedicated private Credential RDF resource. It does not move secrets onto the provider resource and does not introduce a second credential model.

For the interim release, the Credential resource stores its sensitive payload as plaintext protected by the Pod's Solid ACL/ACP boundary. The record is marked `storageMode: plaintext-v1` so a future migration can identify every unencrypted record.

This is a temporary security debt, not the final encryption architecture.

## Data Model

Provider metadata remains independently queryable and contains no secret values. The existing Provider-to-Credential relationship remains authoritative.

The Credential resource stores:

- provider relation;
- authentication mode;
- status, scopes, expiry, account label, and refresh metadata;
- `storageMode: plaintext-v1`;
- `secretPayload`, containing the provider credential JSON.

The interim schema must not call plaintext content `encryptedSecret`, `ciphertext`, or `wrappedDataKey`. Shared RDF schema changes belong in `@undefineds.co/models`; Xpod consumes the model through an adapter and does not keep a competing schema copy.

## Access Boundary

Credential payloads are accessed only through the dedicated Credential Repository. Provider list, connection status, quota summaries, diagnostics, and ordinary RDF projections must not return `secretPayload`.

For Pods hosted by the current Xpod deployment, the repository uses a server-owned internal data adapter after the request principal has been authenticated and authorized. It does not replay browser Bearer or DPoP material to another URL.

Authorization rules are:

- interactive management requires the current Solid WebID to equal the Credential owner;
- Gateway inference requires a valid Gateway Key whose owner matches the Credential owner and whose scopes authorize the requested operation;
- service, node, or unrelated WebID principals cannot read or mutate the payload;
- third-party remote Solid Pods are unsupported by this interim internal adapter.

The adapter may bypass an external HTTP round trip, but it must not bypass the same owner and scope decision enforced at the API boundary.

## API and Logging Rules

- Secret input is accepted only by create/update/connect operations.
- No response returns `secretPayload`, API keys, OAuth access tokens, OAuth refresh tokens, client secrets, or proxy credentials.
- Logs, errors, traces, metrics, and Inngest events must redact these values.
- Read APIs return only safe metadata such as provider, auth mode, status, label, scopes, expiry, and quota summary.
- Startup must not require `XPOD_SECRET_CELL_KEY`, `XPOD_GATEWAY_LOCATOR_SECRET`, or internal Solid client credentials for this interim path.

## Gateway Key Locators

Gateway Key records remain separate from provider credentials. The interim implementation must not add another mandatory encryption key merely to start Xpod.

Opaque locator encryption is postponed with SecretCell. A locator must remain unguessable and integrity-protected using the Gateway Key's own random identifier and secret hash; it must not expose a Provider credential or become an authorization decision by itself.

## Migration Contract

The later encrypted format will use a new storage mode, for example `secret-cell-v1`. Migration will:

1. enumerate only `plaintext-v1` Credential resources;
2. seal each `secretPayload` under the approved Pod key architecture;
3. write the encrypted payload and new storage mode atomically;
4. remove the plaintext predicate;
5. verify decryption before marking the record migrated;
6. support restart and idempotent retries.

No automatic migration is implemented until the final encryption design is approved.

## Deferred Security Design

The following items are explicitly deferred and tracked as one coherent follow-up rather than independent environment variables:

- whether the deployment root key is generated automatically or externally supplied;
- per-Pod DEKs and envelope encryption;
- root-key backup, recovery, and deliberate rotation;
- local-device persistence without Keychain/KMS requirements;
- long-running task delegation after browser session expiry;
- access to credentials stored on remote third-party Solid Pods;
- a standard SecretCell RDF representation and drizzle-solid hydration behavior.

## Verification

The implementation is complete only when tests prove:

- API-key and browser-assisted credential entry persist to the current user's private Credential resource;
- Provider and status reads never expose the payload;
- logs and error responses contain no submitted secret;
- another WebID cannot read or mutate the Credential;
- a mismatched or insufficiently scoped Gateway Key cannot use it;
- Xpod starts without SecretCell, locator, or internal client credential environment variables;
- existing encrypted records fail closed with an explicit unsupported-storage-mode result rather than being misread as plaintext;
- `plaintext-v1` records can be enumerated deterministically for the future migration.

## Known Risk

A compromise of the Pod storage or its database can reveal plaintext provider credentials. Solid ACL/ACP protects protocol access but is not encryption at rest. This risk is accepted only for the interim product phase and must remain visible in release and operator documentation.
