# Browser restore authority reads the wrong SDK selected-session pointer

2026-10-05. This is a host/SDK integration defect; it does not change the Account Cookie or Access/Refresh Token lifetime policy.

## Real evidence and scope

With the exact d02c19ab packaged Local runtime, an owned desktop profile completed a new Account password login once. Interactive diagnostics could restart and reload that profile without submitting a password, but each run activated a new authorization and Consent and exchanged an authorization code. Those runs prove Account reuse only, not automatic SDK restoration or Refresh Token renewal.

A separate observer-only restart did not call the login helper or click login/Consent. It failed to reach the same exact WebID/Pod within the existing 90-second budget and left the visible Consent awaiting user action, with zero Account POSTs and zero token exchanges. Before product initialization, the actual SDK pointer and its namespaced record were present and the record's issuer matched the current Cloud authority. Observation retains only safe booleans in the public summary; all browser/profile state and request URLs remain task-private. The owned App and child process tree stopped normally with no residual owned PIDs. The profile is retained for further renewal tests.

## Cause

The installed Inrupt browser SDK is 3.1.1. Its public core export `SOLID_CLIENT_AUTHN_KEY_PREFIX` is `solidClientAuthn:`. The browser SDK stores its selected session pointer at `${SOLID_CLIENT_AUTHN_KEY_PREFIX}currentSession`. Its per-session record uses the separate `solidClientAuthenticationUser:<sessionId>` naming contract; those are different keys.

`XpodSolidRuntime.readActiveRestoreIssuer` incorrectly looked up `solidClientAuthenticationUser:currentSession`. It therefore did not read the SDK's actual selected record and supplied `restorePreviousSession: false` despite a valid active authority. The old host unit fixture repeated the same incorrect key. Existing installed-SDK/real-HTTP restoration tests independently failed two cases before the repair (silent redirect timed out); the host authority regression also failed with the official pointer.

## Bounded repair

Use the existing SDK's public prefix for the global selected pointer. Continue to read only that session's existing namespaced record, compare its issuer to the authority verified by the current Gateway, and delegate restoration to the same Inrupt Session. Do not scan matching bystander records, accept old key aliases, manufacture credentials, or persist additional secrets. Foreign/missing selected metadata still suppresses restoration; actual callbacks still use the SDK state/PKCE validation path regardless of stale restore metadata.

Regressions use both the host authority adapter and the installed SDK with actual HTTP discovery/token/JWKS endpoints. They retain missing-pointer, foreign selected issuer and matching-bystander rejection. These protocol tests are not a live deployment pass.

## Remaining acceptance

The updated renderer must prove automatic same-profile restart/reload without activating login or Consent, then the original six-hour/idle Access Token renewal and Refresh Token independence checks. Short diagnostics do not prove natural 14-day expiry. The user's two-visible-Consent report remains independently open until actual page/transaction evidence distinguishes duplicate OIDC consent from the separate declared service-resource permission operation. Ownership pair deduplication is tracked separately in [the OIDC ownership issue](2026-10-05-oidc-ownership-drops-second-pod.md).

## 2026-10-05 phase-2 correction: the remembered-client prerequisite was never exercised

The remembered desktop-client contract lives in **this** repository; it is not an
external IdP policy that Xpod cannot control:

- `src/identity/oidc/RememberedClientPromptFactory.ts` restores an explicitly
  remembered `XPOD_DESKTOP_CLIENT_ID` grant after the existing account/WebID
  checks and suppresses only the `native_client_prompt` check for that restored
  record.
- `src/identity/oidc/RememberedClientGrantStore.ts` validates account, client,
  expiry and the live provider grant before reuse.
- `src/identity/oidc/RememberedConsentHandler.ts` reads the Consent POST's
  `remember` boolean and either stores or forgets the grant.
- `config/xpod.base.json` already wires all three.

`ConsentPage` defaults `rememberClient` to `false`, and the acceptance helper
only ever exposed `rememberAccount`. Every fresh bootstrap therefore submitted
`remember:false`, which actively calls `store.forget(...)`. The retained-profile
`prompt=none → interaction_required` observation was taken against a profile with
no remembered-client record, so it is **not** evidence that remembered-client
recovery is broken. The gap found so far is an acceptance/test prerequisite (the
helper never selected the "以后不再询问" checkbox), not a proven production defect.

Phase 2 adds an explicit, independent `rememberClient` acceptance option in
`tests/helpers/browserSolidOidc.ts`: it opens the collapsed request details, sets
the exact checkbox, verifies the choice is retained before approval, and traces
the safe requested/observed booleans plus the posted `remember` value. The
packaged fresh bootstrap now selects it explicitly. A successful silent restore
that issues a new authorization code (without a refresh token) remains the
expected browser behaviour, so the acceptance criterion is a no-interaction
`exact-ready` outcome, not a persisted refresh token.

Status: prerequisite implemented with bounded unit regressions green; the live
no-interaction reload/reopen proof on the owned profile is still pending and the
production contract remains read-only until that proof exists.

### Phase-2 live diagnostic result (owned profile, retained)

- The OIDC authority used by this desktop account is the **cloud IdP**
  `https://id.undefineds.co/` (issuer host recorded as `id.undefineds.co`), not
  the local packaged CSS. Evidence: every `/.oidc/auth`,
  `/.account/interaction/**` (account/bindings/webid/pod),
  `/.account/interaction/**/oidc/consent/`,
  `/.account/interaction/**/oidc/pick-webid/`, `/.oidc/token` and `/.oidc/jwks`
  request in the bootstrap stage carried that origin; the local gateway at
  `127.0.0.1:65500` served only app assets and `/auth/callback`.
- Consequence for evidence: for this flow the persisted remembered-client record
  lives on the authority side. The owned profile's KeyValueStorage
  (`identity.sqlite` → `internal_kv`) is **not** the store used here, so the
  absence of an `idp/remembered-clients/*` row in the profile says nothing about
  remembered consent and must not be cited as a gap.
- Observed with the explicit `rememberClient:true` prerequisite (one controlled
  bootstrap, then two no-action stages): bootstrap reached `exact-ready`;
  password POSTs 0 (Account cookie reused); exactly one consent POST with
  `remember:true`; one `authorization_code` grant. Reload with no actions reached
  `exact-ready` in ~3.0s through `prompt=none` plus one token request. Full
  close/reopen with no actions opened `/device/services` and issued **no**
  authorize request at all (0 token requests), so it never exercises session
  restore: that stage is inconclusive, not a remembered-consent regression.
- Still unverified: whether the authority serving this flow persists and consumes
  remembered-client grants. The service-info response cannot establish the
  deployed source SHA, and the accepted prerequisite only proves that the UI
  choice is offered, retained and posted. Closing this needs either a deployment
  known to contain the remembered-client code, or the same flow served by the
  local CSS, plus a cold-start stage that actually opens the app route.

### Phase-3 cold-start correction and double-consent classification

**Cold start (corrected scenario)**. The earlier full-close/reopen observation was
a scenario artifact, not a restore failure: the packaged fixture's configured
start URL is `/device/services`, so that stage never mounted the product route
and never issued an authorization. Repeating it on the same retained profile
with the product route `/ai-connections` opened as explicit scenario setup (no
login/Consent/remembered-account clicks, no cookie/token injection) reached
`exact-ready` in 17.9s: one authorize with `prompt=none`, one `authorization_code`
token, **0 password POSTs and 0 consent POSTs**, and the same WebID/Pod hashes.
Cold-start automatic restore therefore holds for the same session; the runtime
passed through `initializing → error → authenticated` inside that window.

**"Two Consent pages"**. Within a single authorization (one interaction id, one
`/.oidc/auth`) there is exactly **one** visible consent page and exactly **one**
consent POST. The inflated request counts are explained by the client, not by a
second permission screen:

- `/.account/<interaction>/oidc/pick-webid/` is an **in-page data endpoint** that
  `ConsentPage` itself fetches to list eligible WebIDs/storage bindings
  (`ui/src/pages/ConsentPage.tsx` derives `oidc/pick-webid/` and fetches it on
  load and on refresh); it is a data fetch on the consent screen, not a second
  page.
- The consent **document** was fetched three times, two of them 1 ms apart,
  i.e. duplicate/concurrent fetches of one screen.

The user-visible repeat approval is **two separate authorizations**, each with its
own interaction id and its own consent POST: the interactive reuse trace shows one
consent approval in the `restart` stage and another in the `reload` stage for the
same desktop client. That is a repeat prompt for the same client/identity, not two
distinct permission grants, and no abandoned parallel authorize flow appears in
any stored trace (one interaction id per stage).

Scope-set equality remains **PENDING**: the stored traces (recorded before the
scope hook existed) did not capture the authorize `scope` parameter, so they
cannot retroactively prove whether the two prompts requested the same scope set.
`tests/helpers/browserSolidOidc.ts` now records the observed authorize `scope`
per request as a normalized, deduped, sorted set (`'<none>'` when absent) and
never retains state/PKCE/other authorization secrets; the secret-redaction
regression lives in `tests/helpers/browserSolidOidc.test.ts`. Settling equality
needs one future **actual recorded** request trace through the existing helper; a
green unit test alone must not be read as proving scope equality. No new login is
required to keep this pending — it is only required to close it.
