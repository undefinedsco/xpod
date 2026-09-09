# Web AI Connections acceptance — 2026-08-28

## Scope and identity

This is an actual Web UI against the running local Docker acceptance Gateway,
not mocked API calls or a production deployment. Cloud, managed Local and
Standalone run the same immutable application image:

`sha256:3073e6aafe5e4da32da84c9c21963c14060316b4046c722c1eea1a04f158b61c`

The image is an incremental local acceptance build over the previously tested
runtime dependency baseline; it is **not** evidence for a production release.
QLever is disabled. No production resources, secrets or QLever resources changed.

- Web: `http://127.0.0.1:5173/ai-connections`
- Local Gateway: `http://127.0.0.1:16310/`
- WebID: `http://cloud.localhost:16300/accept-web-mtcam75t/profile/card#me`
- Canonical Pod: `https://acceptance-local.nodes.acceptance.test/accept-web-mtcam75t/`

`cloud.localhost` is the **Docker test Cloud**, not the production IdP. It
allocated the Local SP's canonical `nodes.acceptance.test` address. Loopback is
only the transport hop; it must not replace the Pod's RDF identity.

The active repository maps this Web account to:

| Resource | Path below the canonical Pod |
| --- | --- |
| Provider credentials | `settings/credentials.ttl` |
| Xpod API Key metadata | `.data/ai/gateway/access-keys.ttl` |
| Recoverable Xpod API Key plaintext | `.data/ai/gateway/access-key-secrets.json` |

These addresses are derived from the active repository mapping. Secret contents
are deliberately absent from this record and from the evidence JSON.

## Actual Web actions and results

1. Continued the existing Cloud identity and completed consent. The existing
   Local Pod opened successfully after container recreation, without editing its
   ACL/ACR or creating a substitute account.
2. Entered the dedicated DeepSeek test credential in the Web form and saved it.
   The UI showed an enabled credential, a real balance response, and three
   provider-discovered models. Selected `deepseek-v4-flash` in the UI.
3. Refreshed and re-entered the application. DeepSeek remained configured.
4. Initially created `Web acceptance 20260828` through the Web API Keys form. The result
   appeared in the list; the UI reported the general configuration was copied.
5. Used **that exact Web-created key** against the running Local Gateway:
   - `/v1/models`: HTTP 200, selected `deepseek-v4-flash` present.
   - `/v1/chat/completions`: HTTP 200, content exactly `XPOD_WEB_OK`.
6. Disabled the key through the Web UI: the original key returned HTTP 401.
   Re-enabled it through the UI: the original key returned HTTP 200 again.

That first single-process key fingerprint was `1d0245277e933b88`. It later
failed recreation; the diagnosis is recorded below, not hidden by replacing it.

After fixing both service-secret and non-RDF file-root persistence, the Web UI
created `Web durable Pod acceptance 20260828` (fingerprint `18f9b866e6455413`).
This key passed models and Chat before recreation. Local was then recreated
with its data volume retained. A fresh browser document signed into the same
account and copied the same row successfully (reveal HTTP 200). The original key
again passed models and Chat with `XPOD_WEB_OK`; no replacement key was created
after recreation. Its companion JSON remained under `/app/data`, and its
masked suffix stayed unchanged in the list. The key remains enabled for testing.

That initial durability check used image `6f6200afc751…`. After the final image
above replaced all three service containers, the **same** key again returned
models HTTP 200 and real Chat `XPOD_WEB_OK`. The original Web account restored
automatically, still showed the same masked key, and its copy action completed
without a visible error. The evidence collector checks matching fingerprints
and rejects three-mode reports older than the currently running containers.

## Browser restoration and cross-page check

- Fixed the Cloud IdP adapter overriding Inrupt's explicit `web` client type
  with `native` merely because its callback is loopback. The native consent
  policy and redirect validation remain intact; no consent bypass was added.
- Two consecutive hard reloads returned automatically to AI Connections,
  without pressing Continue or Approve. Actual callback diagnostics showed no
  OIDC error. A third reload passed after removing those temporary diagnostics
  and restarting Vite.
- After Cloud and Local container recreation, the original browser session
  also restored automatically. No browser cookies/storage were cleared and no
  replacement account or key was used.
- AI Config initially failed to read the Cloud-WebID/Local-Pod account. Its
  store omitted the ownership-resolved `podBaseUrl` when opening trusted access.
  Passing that canonical Pod root fixed the actual Model Assignments page.
  Switching back to AI Connections did not prompt for login. This checks page
  loading/session reuse, not every AI Config model/rebuild operation.

See [silent restoration diagnosis](../issues/2026-08-28-web-silent-session-restore.md).

## Same-image three-mode regression

Separate real-account API acceptance ran against Cloud, Local and Standalone.
All three passed identity, authenticated Pod read/write, API Key lifecycle,
Provider persistence, non-empty selected models and real Chat. Disabled and
deleted test keys were rejected. The managed Local report records a canonical
Pod URI and a loopback transport target. These API checks supplement, rather
than replace, the Web actions above.

Gateway, CSS and API processes in all three containers run Bun. Local's primary
RDF index is now `/app/data/rdf-index.sqlite` on the retained volume. Its legacy
migration marker reached `complete` before the Web read succeeded.

## Automated regression and evidence

- Auth/storage focused suite: 67 passed.
- RDF engine/index/accessor suite: 107 passed.
- Runtime-path suite: 42 passed.
- File-root/bridge/repository/management regression: 143 passed.
- Inrupt/runtime/callback regression: 81 passed, supplemented by the real
  browser restoration above.
- Client-type and actual upstream native-consent policy regression: 7 passed.
- AI Config store/handler/route regression: 27 passed.
- Full integration after combined source changes: 182 passed, 5 skipped;
  repeated before handoff.
- Root TypeScript, Components.js runtime metadata (302 components), package
  builds, UI builds, UI typecheck and touched UI lint passed.

Local evidence (untracked; no plaintext secrets in these reports):

- `.test-data/acceptance/auth-storage-evidence.json`
- `.test-data/acceptance/web-created-key-chat.json`
- `.test-data/acceptance/web-combined-final-full-integration.log`
- `.test-data/acceptance/web-session-final-live-{cloud,local,standalone}.log`
- `.test-data/acceptance/web-durable-key-{before,after}-recreate.log`
- `.test-data/acceptance/web-durable-key-recreate.log`
- `.test-data/acceptance/web-durable-key-final-image.log`
- `.test-data/acceptance/web-session-browser-restore.json`

## Main code changes and simplifications

- `src/identity/oidc/LoopbackClientIdAdapterFactory.ts`: preserve explicit client
  metadata instead of overriding it from the callback URL.
- `ui/src/solid/XpodSolidRuntime.ts` and callback/provider companions: retain
  the Inrupt restoration anchor and keep restoration in the shared runtime.
- `scripts/patch-inrupt-authn-transport.js`, `packages/solid-sdk/src/local-route-fetch.ts`
  and `src/api/auth/SolidTokenAuthenticator.ts`: preserve canonical signed URLs
  while optimizing the physical local hop.
- `src/runtime/gateway-locator-secret.ts`, `src/runtime/css-process.ts` and
  `src/api/container/common.ts`: durable locator secret and a single persistent
  storage root for both RDF metadata and non-RDF secret companions.
- `src/api/ai-config/AiConfigStore.ts` and `src/api/container/routes.ts`: reuse
  the ownership-resolved Pod root rather than deriving storage from the WebID.
- Key repository/handler, Pod-data bridge and AI Connections clients: correct
  secret companion reads, masked metadata, and safe actionable error mapping.

No new authentication implementation, consent exception, configuration switch
or dependency was added for the final client-type/AI Config fixes. Temporary
Vite request diagnostics were removed.

## Login-card presentation regression (follow-up)

The successful authenticated flow above did not cover the anonymous entry's
appearance. `WebIdAuthBoundary` still rendered the generic SDK route picker:
an outer “Connect Xpod” panel and a nested origin/address card. This was not
the agreed LinX-style login presentation, even though the login action worked.

The Xpod boundary now composes the existing shared-ui compact `AuthSurface`,
`WebIdLoginEntryView`, `LoginAccountView`, and progress/failure views. It does
not import LinX's product-specific provider chooser. All states retain the
same 280 × 400 CSS-pixel document frame; the existing native-window host fills
its window. Unknown identities use the centered shield/brand, while remembered
identities use the account avatar and name. No origin card, account/password
form, or additional-provider chooser is added. The WebID/selected-Pod gate and
controller actions remain the same. Cancelling an in-flight action prevents
its late rejection from replacing the login card with an obsolete error.

Evidence for this follow-up is separate from the Docker image acceptance:

- Actual anonymous Web entry on the same Vite server via `localhost:5173`:
  one compact card, one login action, no rail or nested route panel.
- Clicked Login, completed the existing test Cloud consent, and returned to
  AI Connections with the same original three Key rows. No new account or
  replacement key was created.
- Reloaded the original `127.0.0.1:5173` document: the compact restoring card
  appeared without a login action, then the same Key list opened automatically.
  AI Connections → AI Config → AI Connections retained the session and list.
- Remembered avatar, restoring, expired, error, cancelled action, selected-Pod
  mismatch, and native fill behavior are covered by component regression
  tests. They are not claimed as a fresh desktop end-to-end acceptance.
- Focused UI/routing/callback/brand suite: 48 passed. Shared-ui suite: 44 passed.
- Broader authentication/runtime/callback/Dashboard regression: 229 passed.
- Full integration: 182 passed, 5 skipped. Root TypeScript, Settings UI build
  (including UI typecheck), and touched UI ESLint passed.
- Logs: `.test-data/acceptance/web-login-card-{build,integration,final-integration,auth-regression}.log`.

Changed files: `ui/src/solid/WebIdAuthBoundary.tsx` and its tests,
`packages/shared-ui/src/webid-auth.tsx` and its tests, and this record. The
shared-ui change only omits an empty heading when the supplied brand already
contains the title. Other consumers' generic route-picker API is unchanged.

Visual acceptance must include the **anonymous** entry as well as the
authenticated workspace; passing API/Chat checks alone cannot establish that
the login presentation is correct. This follow-up is live in the Web dev
server; no production image or desktop package was published for it.

### WebID-only remembered identity (completed follow-up)

The first presentation pass used seeded remembered records in component tests.
An actual WebID-only sign-in exposed two remaining record-population errors:
`XpodRememberedLoginBridge` required an Account email, and its storage normalizer
required the UI, WebID, and Pod to have the same origin. Both assumptions are
invalid for a local UI using a Cloud WebID and a distinct canonical Local Pod.

The existing presentation record now permits an absent email and absolute
HTTP(S) WebID/Pod URLs on different origins. It still requires a ready live
WebID/selected-Pod pair before writing, and an existing record must match that
pair before it can be refreshed. URL credentials and non-HTTP(S) URLs remain
invalid; remembered avatars are restricted to the WebID, Pod, or UI origins,
and temporary blob URLs are not persisted. Account authentication, Inrupt
session ownership, and the protected-content gates are unchanged. Remembered
display data is not authentication evidence.

- RED: 10 new regression assertions failed before the fix.
- GREEN: focused remembered-storage/bridge/card tests: 48 passed.
- Authentication/runtime/profile/user-card regression: 257 passed.
- Full integration: 182 passed, 5 skipped; Settings build/typecheck and ESLint
  on the changed files passed.
- Actual Vite Web acceptance: opened `127.0.0.1:5173/ai-connections` using the
  existing Cloud WebID / canonical Local Pod test account, then hard-reloaded.
  The restoring card now showed `accept-web-mtcam75t` and its initial avatar,
  not the Xpod brand. It then returned automatically to the original three
  API Key rows without another login. No new account, replacement Key,
  browser-storage manipulation, or backend restart was used.
- Custom avatar URL persistence/rendering is covered by component tests; the
  real test account uses an initial avatar, not an uploaded profile photo.
- Logs: `.test-data/acceptance/webid-remembered-{red,green,auth-regression,integration,final-integration,build}.log`.

Changed files: `ui/src/auth/xpod-remembered-login.ts`,
`ui/src/auth/XpodRememberedLoginBridge.tsx`,
`ui/src/solid/WebIdAuthBoundary.tsx`, their regression tests, and this record.
The fix removes incorrect prerequisites from the existing display cache;
it adds no new session manager, configuration, shared schema, or dependency.
It is live in the Web dev server; desktop packaging/production release remain
outside this follow-up's evidence.

## Remaining observations

- The first recreation exposed two independent bugs: a process-ephemeral
  locator secret invalidated issued keys, and a non-persistent file root lost
  their recoverable plaintext while leaving metadata visible. Both have fixes
  and the same-key recreation result above. Already-lost secrets/plaintext
  cannot be reconstructed from metadata. See
  [durability diagnosis](../issues/2026-08-28-gateway-key-restart-durability.md).
- Two older failed acceptance rows remain as diagnostic history; use
  `Web durable Pod acceptance 20260828` for the verified current key. Previously
  lost plaintext cannot be recovered by changing UI copy logic.
- The final restart hit a full 16 GB Docker disk, causing PostgreSQL to exit.
  Removed only 4.34 GB of identified private Xpod build-cache records; no image,
  account data or volume was deleted. Restarted the original PostgreSQL volume
  and services, then reran the browser/same-key/three-mode checks successfully.
- Root `typecheck:test` still encounters pre-existing parser errors in the
  installed `@vitejs/plugin-react` declaration, and whole-UI lint has existing
  errors in `XpodLoginController.ts` and `context/AuthContext.tsx`. Root production
  TypeScript, UI build/typecheck and lint on the touched UI files pass. These
  results must not be described as a completely green repository-wide lint and
  test-declaration typecheck.
- Desktop/tray behavior, production Cloud compatibility and release packaging
  are not claimed by this local Web acceptance.
