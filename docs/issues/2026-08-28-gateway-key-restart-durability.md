# Gateway API Key restart durability

## Reproduced failure

A real Web-created API Key successfully listed models and completed DeepSeek
Chat. Pausing and re-enabling it also worked in the same Local process. After
recreating only the Local container with the same image and retained data
volume, the original key returned `401 Invalid gateway API key`.

The same account could still sign in, read its Provider configuration and list
the enabled key, but copying the saved configuration failed. Thus listing Pod
metadata was not evidence that the issued key remained usable.

## Cause

Two independent durability problems were found.

### Locator secret was process-local

`GatewayKeyLocatorCodec` encrypts the owner/resource locator inside the key ID.
The repository must decode that locator before authentication or reveal can
find the Pod record. Previously its secret could fall back to a runtime-only
Gateway ingress secret or random bytes. Recreating the process changed that
secret. Owner-scoped listing did not need locator decoding, which explains the
misleading combination of a valid-looking list and failed operations.

### Non-RDF file root was not colocated with durable SQLite data

After the locator secret was made durable, the same Web-created key survived
Local container recreation for `/v1/models` and Chat, but copying the saved
configuration still failed. A read-only inspection of the running Local
container showed the key metadata in the durable RDF SQLite data root, while no
`access-key-secrets.json` companion resource existed in the retained data.

The split was between structured metadata and non-RDF payload storage:

- `CSS_IDENTITY_DB_URL` and `CSS_SPARQL_ENDPOINT` pointed at `/app/data/*.sqlite`,
  which is retained by the acceptance data volume.
- The legacy CSS child runtime used `/app/.xpod/runtime/legacy-css` as its
  working/runtime root. Without an explicit `CSS_ROOT_FILE_PATH`, CSS resolved
  its file data root under that runtime area instead of the durable SQLite data
  root.
- `access-keys.ttl` was therefore still visible through the RDF/SQLite path, but
  the recoverable plaintext companion JSON was not present after container
  recreation.

The internal Pod data bridge also requested Turtle representations for all
GET/HEAD reads. For `access-key-secrets.json`, this must prefer
`application/json`; otherwise a present JSON companion can be read as an
unusable representation. If the resource is missing, the current repository
branch treats a `200 text/turtle` empty graph or a non-OK response as an empty
secret map, not as a JSON parse error.

## Required behavior

- Local/Standalone generate one independent private secret beside the durable
  SQLite identity database, outside the Pod resource tree. Keep it with the data
  volume, not with ephemeral runtime files. No new user configuration is needed.
- Cloud requires the existing `XPOD_GATEWAY_LOCATOR_SECRET` to be stable and
  shared by all replicas. Never generate independent per-replica secrets.
- An explicit secret takes precedence. Corrupt, unreadable or unsafe local
  files must fail clearly; never silently replace them and invalidate keys.
- Concurrent first starts must publish one complete private secret atomically.
- Locator secrets are service-private state, not Provider credentials and not
  an additional copy of a user's API Key. User key metadata and recoverable
  plaintext retain their existing protected Pod resources.
- Local/Standalone must colocate the default CSS `rootFilePath` for non-RDF
  `FileDataAccessor` payloads with the durable SQLite identity/RDF data root
  when no explicit root is configured. Cloud must not silently derive a
  per-replica local file root; deployments need an explicit shared object/file
  storage strategy.

An old random secret already lost with its process cannot be reconstructed.
Keys issued under that lost secret are not retroactively repaired by persisting
a new one; record that limitation rather than claiming successful migration.
Likewise, an already-lost recoverable plaintext companion cannot be recreated
from `secretHash`, locator ID, or metadata alone.

## Acceptance gate

Create a key through the actual Web UI, save its fingerprint, verify models and
real Chat, recreate the Local container while retaining its data volume, then
copy the saved configuration and verify models/Chat with **the original key**.
Run Cloud, Local and Standalone against the same application image. A newly
created replacement key after restart does not satisfy this gate.

## 2026-08-28 verification progress

The stable-secret image is
`sha256:82e5d17b91b9d02fa0306fb2fe11a9f9611224a4a279fa9b2f06b28d189885ff`.
The actual Web UI created `Web persistent acceptance 20260828`, fingerprint
`de971901d32e4f16`. With the data volume retained, Local was recreated and that
**same key** returned models HTTP 200 and real DeepSeek Chat HTTP 200 with the
exact content `XPOD_WEB_OK`, both before and after recreation.

This proves issued-key authentication durability, not the whole gate. Copying
the saved configuration still failed in both the old page and a newly signed-in
page.

Follow-up read-only diagnostics found the target Pod's `access-keys.ttl` rows
in the durable RDF SQLite index, including `Web persistent acceptance 20260828`,
but found no `access-key-secrets.json` companion in either the retained data
root or the RDF source table. The key therefore remains usable for
models/Chat through its metadata `secretHash`, but its saved plaintext cannot be
revealed after the companion resource has been lost.

### File-root fix: same-key recreation passed

Image `sha256:6f6200afc751410f83e6fd64d845389ceed7d7ea868ed86b6d16bf3adefd24de`
contains the file-root and representation fixes. The actual Web UI created
`Web durable Pod acceptance 20260828`, fingerprint `18f9b866e6455413`.
Read-only inspection confirmed the companion at
`/app/data/accept-web-mtcam75t/.data/ai/gateway/access-key-secrets.json`, not the
ephemeral runtime directory. Local was recreated without removing its volume;
the companion remained. A new browser document signed into the same account,
listed the same masked suffix and copied that key through the reveal endpoint
with HTTP 200. The original key returned models HTTP 200 and DeepSeek Chat
HTTP 200 with exact content `XPOD_WEB_OK` before and after recreation.

Evidence (local generated artifacts; contain no plaintext in the logs):

- `.test-data/acceptance/web-durable-key-before-recreate.log`
- `.test-data/acceptance/web-durable-key-after-recreate.log`
- `.test-data/acceptance/web-durable-key-recreate.log`
- `.test-data/acceptance/vite-key-diagnostic.log` (safe operation/status only)
- `.test-data/acceptance/durable-file-root-live-{cloud,local,standalone}.log`

Cloud, Local and Standalone passed Pod read/write, key lifecycle, models and
real Chat with that same image. Full integration passed 182 tests, with five
pre-existing skips. These results validate key durability only: hard-refresh
Web session restoration still returns to Continue and is a separate open gate.
This is an isolated Docker test Cloud, not a production-cloud release verdict.

The root change does not migrate non-RDF files from an old runtime directory.
For an existing installation, preserve and migrate that directory before
switching its file root; never delete the old data as part of upgrading.
