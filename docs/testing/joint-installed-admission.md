# Installed joint PG17 admission

Issue [#39](https://github.com/undefinedsco/xpod/issues/39) tracks replacement of
the old separate-database admission with a sanitized v2 proof. The proof binds
one owned PG17 container, server identifier and database to both the public
16-case and private 17-case canonical suites, including native search. The
public RDF base table must retain its OID through repeated extension preparation
and both suites; exactly two projection columns and one projection trigger are
required. These are measured installed-component facts, not real-user Pod or
release acceptance.

`scripts/lib/joint-installed-admission.ts` validates an exact field allowlist,
candidate source/image/runner identities, both fixture and validator identities,
table composition, closed producer receipts and verified cleanup. Private raw
reports and fixture contents are excluded. The public consumer first verifies
the existing byte-authority boundary and then invokes this validator; a valid
byte receipt does not excuse mixed servers, substituted tables or incomplete
semantics. Old v1 proofs are rejected.

The private producer's joint mode receives `--public-root`, verifies the exact
Git HEAD and blob bytes of its five allowlisted public dependencies, runs both
canonical validators on the actual serialized reports, and issues the proof
only after database and owned-resource cleanup. Its source authority is the
SHA256 of the JSON array of three ordered SHA256 digests: producer, input-kit
builder, installed bootstrap. Validator and private contract digests remain
separate bindings. A changed dependency requires rebinding and fresh acceptance.

The producer authority is now bound to
`7c2176daae1ee2b356dd02471a942866faceab24b2cf429a2305471b3e7194da`
after formal CNB amd64 run `cnb-2gt-1k4f22ire` passed on public source
`944acf06a5ffe8ead2562ec515faed11c2164751`, private producer source
`e3ec7ff1c89bbb6072b5538be58455e03c43c279`, service digest
`6ada40ff9a772c0c4d9658e42248f0c2c32b290dd2cdaf1481d7dc40cb3ad50d`
and the approved PG17 digest `1199698c789fb65897e4b0bd370f7faa959bcbdd3499784af256ad5bb8f0a5f3`.
The actual producer and wrapper exited zero. Both serialized reports were
independently checked again with the canonical validators; all child log hashes,
the producer receipt hash and external absence of owned resources were checked.
The sanitized proof SHA256 is
`f9ec2ac0f9dac2f47f03cab94c5ccd5a0eec07d910d19eb869e5cd3e0b7f19c4`.
Private reports were exported encrypted and retained only in private evidence.

This CNB run validates the formal producer and v2 contract. The existing release
transport still requires a GHCR service image and separately configured byte
authority. Local file verification also accepts the approved CNB repository,
with the same exact-byte authority check; arbitrary repositories remain rejected. Updating this pin changes public source and validator bytes, so final
source commits, native/mounted artifacts and installed images must be bound
again before promotion. Shared RC continues to require an ordinary reviewed
merge into `staging` and exclusive queue ownership.

Focused public regression:

```sh
bun run test -- tests/scripts/joint-installed-admission.test.ts tests/scripts/check-qlever-installed-image-conformance.test.ts tests/scripts/candidate-workflow.test.ts
bun run build:ts
bun run typecheck:test
bun run test:integration
```

Keep actual Gateway identity/Pod, client authentication, models, Chat, Tasks,
desktop permissions, backup/restore and release evidence as separate gates.
