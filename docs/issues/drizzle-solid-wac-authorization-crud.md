# Membership ACL mutation needs a shared WAC Authorization CRUD schema

Observed 2026-10-04 while implementing the bounded actual WAC Read/ACL lifecycle slice.
This is a concrete adapter/model gap; it is not a claim that a published ORM promised
authorization-policy CRUD.

## Scenario and existing public surface

Join/leave must change the actual room authorization policy so the invited actor gains Read on
the room and its whole history (join) or loses it (leave), then prove the new effective state.
The currently verified public `@undefineds.co/models` surface exposes the shared Chat/Message
schema with strict `insert`/`update` `.toSPARQL()` serialization and the public dialect conditional
endpoint, but it has **no shared entity/schema/row type for a WAC `acl:Authorization` or ACP
policy**, and no verified authenticated Link discovery or commit-time policy-closure guard.

The existing readonly observation contract (`drizzle-solid-membership-policy-observation.md`) and
the guarded closure envelope do not cover an actual business ACL mutation: they can read and
commit a canonical Chat CAS or a previously compiled policy closure, but they do not provide a
typed model API to compose a WAC authorization delta.

Standard WAC is protocol data, not application schema. Adding a local Xpod copy of shared models
schema, a local `solidTable`, or guessing `.acl` suffixes is not an acceptable remedy.

## Temporary bounded bridge (recorded before use)

Use the already approved narrow conditional authority primitive: a single guarded conditional
INSERT/DELETE through the existing room `-/sparql` sidecar with
`application/vnd.xpod.guarded-sparql-update+json`, the current named lease per physical request,
the exact discovered policy IRI, and the previously compiled full resource/policy/ancestry guard.
The bridge:

- manipulates standard protocol quads only; it does not define or copy a shared local
  `solidTable`/schema and does not add a generic privileged fetch, DB or transport interface;
- preserves immutable owner and unrelated actual authorizations, and when it must create the first
  direct room ACL it rebases the relevant inherited authorizations onto the room with exact
  `accessTo`/`default` scope before adding the target grant, so inheritance cannot silently drop
  the owner's Control/Write/Read or public rights;
- removes only the operation-owned deterministic target grant, never a colliding third-party grant
  and never an ancestor policy;
- keeps the original operation pending on any residual/unknown result and never lets the phase
  helper `replace` adopt a same-looking winner after an explicit 409/415.

## Remaining upstream boundary

A shared WAC/ACP authorization CRUD model with strict same-body RDF cardinality/provenance, actual
Link discovery and a commit-time topology/absence guard under the shared source lock remains the
correct long-term surface. Real effective Read evaluation, lock-held topology validation, stale
writer recovery and ACP/ownerRecovery remain separate required work.
