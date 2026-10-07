# Membership policy observation needs a strict standard-policy and inventory boundary

Observed 2026-10-03 while implementing canonical membership lifecycle; this is an adapter contract gap, not a claim that a published ORM promises effective access evaluation.

## Scenario and existing public surface

An invited authenticated actor legitimately cannot read the canonical Chat before join. Membership source control uses an explicit current named owner lease, while the actor remains the original caller. Join/leave must establish effective Read for the canonical resource and source room history, including direct policy overrides and inherited policies. A successful update of one grant does not establish that result.

The currently verified public drizzle-solid surface serializes shared Chat/Message schema with insert/update `.toSPARQL()` and executes conditional source mutations with the public dialect endpoint. The installed public row decoder does not expose the strict schema-aware same-body RDF cardinality/provenance contract required for arbitrary authorization policy graphs; the existing decoder gap is recorded in [Matrix atomicity](drizzle-solid-matrix-atomicity.md). No verified public ORM contract currently supplies authenticated Link discovery, complete LDP resource inventory, authorization-policy dependency closure or commit-time topology absence protection. Do not substitute a successful Chat row query for these proofs.

WAC and ACP are standard Solid protocol data. Adding local Xpod copies of shared models schema or guessing `.acl` URLs is not an acceptable remedy. Standards links: [WAC discovery/effective ACL](https://solid.github.io/web-access-control-spec/), [ACP effective policies](https://solid.github.io/authorization-panel/acp-specification/).

## Failure sequences to preserve

- A resource returns a nonstandard actual ACL URL in `Link rel=acl`; constructing a suffix reads a different resource.
- An ACL representation is present but empty. Empty RDF graph enumeration cannot distinguish it from HTTP404.
- A source default grants Read, but an existing history resource has its own WAC ACL, or its ACP effective policies include a descendant deny or ancestor member policy.
- The old target grant is removed, but a public, group, authenticated, client-constrained or other applicable policy retains Read.
- A new descendant ACL is created after HTTP observation. The old finite WHERE policy graphs remain unchanged, so those graph comparisons alone do not prove complete effective topology.

These are normative/server-interface counterexamples, not reports that a complete membership ACL adapter has already failed a production test. The current product contains internal source phase primitives; it has not claimed real ACL effects.

## Temporary read-only containment

Record this issue before the scoped bridge. Allow standard RDF policy decoding and actual authenticated HTTP Link/container observations in a dedicated Matrix protocol adapter, using the existing N3 parser and existing CSS public Link parser. Keep application Chat/Message identities, layouts and CRUD on shared models/public ORM. The adapter uses one explicitly named, per-physical-request fenced source capability; it does not expose owner fetch, credentials or a new data authority.

Observe the whole declared source-room history range without a current-day shortcut. Distinguish present-empty, absent404, denied403, malformed, partial206 and exhausted/incomplete results. Same-Pod policy reading may be the first implementation boundary; WAC legally permits a policy at another origin, so that case is explicit unsupported, not an invalid Link. Observe ancestors where the chosen policy requires them. Return observations and coverage limits, not an effective-authorization proof or a lifecycle completion flag. No ACL writes or phase marks are allowed in this slice.

## Remaining server boundary

The existing conditional auxiliary update supports one write graph and finite fixed WHERE dependencies under the shared hierarchy lock. Native prepared delta v1 has no containment read-set, existence condition or topology token. Mix `getChildren` can enumerate raw containment under a room WRITE lock; configured authorization strategy can read actual policy resources and distinguish NotFound from empty. A later server-side check must evaluate that complete dependency set while the commit locks remain held. HTTP observation and process-local generation snapshots are insufficient substitutes. Do not widen this read-only bridge into a cross-document transaction claim.

Upstream/public interfaces should eventually expose strict policy decoding/observations and explicit conditional result semantics with supported scope and incompleteness. Real effective-policy evaluation, lock-held topology validation, caller GET403/200/403, stale-writer and recovery evidence remain required before C2 ACL acceptance.

## Guarded conditional transport gap (recorded before implementation)

The next bounded adapter requires one public-ORM-serialized exact conditional update to carry a complete expected policy/resource closure to the existing room SPARQL endpoint. The verified public dialect executes SPARQL text but has no verified contract for a versioned commit-time inventory and full-policy-content precondition. A custom header could be ignored by an older server and therefore cannot provide this guarantee.

Allow a narrow temporary transport wrapper around the existing public ORM serialization and approved exact-CAS adapter, using `application/vnd.xpod.guarded-sparql-update+json`, version 1. An older server must reject unsupported media with 415; never retry the same operation as plain SPARQL. The server must rebuild the full resource inventory, actual authorization-policy mapping, ancestor dependencies, absence/empty state and full ground-RDF digest under the same current hierarchy locks before either a single policy update or a single canonical Chat CAS. A closure mismatch is 409 with no mutation from that request. No new dependencies, private ORM imports, local copies of shared schema, credentials, generic owner fetch or arbitrary write capability are justified by this bridge.

The initial ground-RDF profile explicitly rejects blank nodes, RDF-star, foreign graphs and unsupported authorization dependencies; it does not claim general RDF canonicalization, ACP evaluation or effective Read. Successful guarded commit proves the expected topology and policy content at that commit only. Post-policy canonical phase updates need a freshly observed post-update guard, and real effective Read evaluation remains a separate prerequisite for business phase completion. Native single-graph writes remain separate recoverable steps; this envelope does not turn ACL, Chat and PDU writes into one transaction.
