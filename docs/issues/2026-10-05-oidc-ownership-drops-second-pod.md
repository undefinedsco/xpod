# OIDC ownership selection drops a second Pod owned by the same WebID

2026-10-05. This is an identity adapter defect, not an ORM URI-resolution capability gap.

## Actual failure

The exact d02c19ab desktop package provisioned two distinct Managed Local Pod bindings for one Cloud WebID under a new test Account. The public Cloud profile/Card retained that identity and the two independent storage bindings. Actual interaction-scoped `GET .../oidc/pick-webid/` returned one `entries` row, matching Pod A and excluding Pod B. The Consent surface therefore rendered a single identity/storage card and no native storage selector. The packaged permission producer refused to count its callback as an exact UI Pod selection; neither the 29-resource permission chain nor Chat was accepted.

Public `service/status` and `api/service-info` responses are healthy, and the latter reports the Cloud edition, but neither response supplies a verifiable semver. The relevant resolver implementation is identical in the accepted 0.4.25 source and the d02 0.4.26 candidate. This diagnosis does not infer a deployed version from those public responses. Private Account/binding, browser response, DOM and callback evidence remains task-private under `.test-data/sol-release/026-exact-d02c19ab/`.

## Root cause and bounded correction

`CssPodOwnershipResolver.resolveOwnedWebIds` and its existing verified remote lookup both use `resolvedWebIds: Set<string>`. After emitting an owner's first matching Pod, a later registered Pod with the exact same WebID is skipped. Account linkage and Pod ownership remain valid; the set accidentally collapses a relation into an identity.

Deduplicate the exact `(webId, ensureTrailingSlash(storageUrl))` pair only after the existing account/candidate/target/owner checks. Preserve order and exact WebID fragments. The storage URL remains the registered CSS Pod base or the authenticated remote lookup row; it is never inferred from the WebID. Existing target, unowned candidate, malformed remote payload and remote credential guards retain their behavior.

Regression tests first failed for local and remote same-WebID/two-storage cases; they also require repeated identical pairs to collapse while unrelated owner/fragment, foreign target and foreign remote `podUrl` rows stay excluded. This correction still requires a new immutable source and actual Cloud/desktop selection validation; unit tests do not prove the deployed chooser has changed.

## Separate session observation

The same private profile can restart and reload without password entry, but a driver that activates login/Consent is not proof of automatic SDK restoration or Refresh Token renewal. Those interactive runs observed one Consent POST each and an authorization-code exchange, not a refresh exchange. A separate observation-only run records automatic behavior without clicking login or authorization. The user's report of two visible Consent screens remains independently open until its page/transaction cause is proven. Natural 14-day expiry and six-hour browser renewal are not established by these short runs.
