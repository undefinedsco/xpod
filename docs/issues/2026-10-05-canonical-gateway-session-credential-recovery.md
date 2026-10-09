# Managed Local canonical API reads missed session credential recovery

## Actual failure

On 2026-10-04 UTC the isolated desktop, authenticated at the Cloud issuer, selected its registered Local Pod with no public route. The same mounted Solid session and `X-Xpod-Pod-Url` returned 403 `service_access_missing` for the canonical `/api/ai/gateway/keys` request and 200 for the loopback control-plane request. The private Gateway log classified the former as `caller_dpop_replay_unsupported`: the server cannot spend a browser-owned DPoP private key to open the Pod.

The first permission operation separately initialized and granted all 29 declared targets. Repeating that authorization does not repair the request-credential boundary. The owner/service identity and storage binding remain exact; this issue is not an ORM address-resolution gap.

## Root cause and repair boundary

The host already creates one session request credential, and its core exposes a verified route transport that preserves explicit credential authorization. The Provider previously passed native `plainFetch` as the recovery transport, so an eligible canonical retry still missed the local route. Its predicate accepted only `window.location.origin`. The shared client uses the current Pod's canonical API origin, so that request never entered the existing recovery path.

The host now supplies its existing `runtime.resolveLocalUrl` to the predicate. A canonical API URL is eligible only when that verified mapping reaches the current control-plane origin with the exact same path and query, with no fragment or user information. Both Provider wrappers now pass the existing `runtime.transportFetch` for recovery, while Account issuance keeps its existing native fetch. The original canonical request remains the request sent to the existing credential-preserving route transport. No Pod root is inferred from WebID, no new authentication factory is created, and foreign URLs, RDF resources, changed paths/queries, and another mapped origin remain excluded.

Recovery is limited to GET/HEAD after the exact 403 missing-access code. Mutations and 401 are not replayed. The previous consumed-body POST replay tests exposed a pre-existing broad retry assumption; they now require one original dispatch and the original refusal. An available credential may be used by an explicit capability before a write's first dispatch. Token refresh before dispatch belongs to the existing Solid session, not a business-level write retry.

## Verification and limitations

The canonical-read regression and the mutation regression were RED on the prior helper. After the change, 50 host credential/runtime tests passed with actual exit 0. They cover canonical transport preservation, foreign authority/path/query/fragment/userinfo mappings, original same-origin recovery, one bounded read retry, no DPoP proof carryover, 401 refusal, and a consumed write body dispatched only once. A separate Provider test mounts the actual runtime core: both exposed read wrappers route the canonical request to the current physical Gateway, retain its canonical header, remove the DPoP proof on the explicit-credential retry, and reuse one natively issued Account credential. Its mutation reaches that Gateway only once. The combined four-file run passed 142 tests; test typechecking also returned actual exit 0.

The isolated desktop then reused its existing Cloud Account login and completed the ordinary consent callback. With no public Local route, the same mounted session read canonical models and Gateway keys with HTTP 200. Repeating the actual applet authorization inspected all 29 existing target ACRs with no ACR PUT or PATCH and returned successfully. These are working-tree UI observations in an isolated 0.4.25 shell, not final packaged 0.4.26 evidence. The key-creation dialog independently returned Account credential HTTP 401, and creating a fresh Provider row through the active collection independently reported a server-wins conflict; those remaining paths are not covered by the read-recovery result.

This is not final packaged desktop acceptance or a release result. The original isolated Gateway provision refresh failure was preserved: a normal restart with the same persisted node and credentials restored a usable code, but the old process failure's cause has not been established. The separate repeated-ACR empty-SPARQL failure is recorded in the permission-broker issue.
