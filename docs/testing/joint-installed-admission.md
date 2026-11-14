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

The `--verify-private17-admission` CLI consumes the byte-authorized v2 joint
proof directly. Its public and private sections already bind both suites to
the same PG17 server, database and unchanged base table. The candidate workflow
does not supply a separate Public16 envelope. The old `--public16-report` flag
is explicitly rejected, because a separate-database envelope cannot prove
this joint contract. The preceding public installed-image conformance gate
remains required independently. Changing the CLI changes its validator digest;
the final source, installed image and joint proof require fresh validation.

The private producer's joint mode receives `--public-root`, verifies the exact
Git HEAD and blob bytes of its five allowlisted public dependencies, runs both
canonical validators on the actual serialized reports, and issues the proof
only after database and owned-resource cleanup. Its source authority is the
SHA256 of the JSON array of three ordered SHA256 digests: producer, input-kit
builder, installed bootstrap. Validator and private contract digests remain
separate bindings. A changed dependency requires rebinding and fresh acceptance.

The producer authority is now bound to
`6356588bdee4250f66d87739c41ece044b05c3d3197de89eda673b18b7c8d688`, the
SHA256 of the compact JSON array of the current producer, input-kit builder and
installed bootstrap digests:

| private component | sha256 |
|---|---|
| `produce-installed-component-admission.ts` | `72b184674f8bdfbfd8c67f0364ac69f131745d400d7822e045a7469cd364fd83` |
| `installed-joint-inputs.ts` | `3f0035dbb7362cb8256e4952ae0a5d55973e3c8552cc63197504915ff7b5a265` |
| `installed-joint-bootstrap.cjs` | `386fbfe8303a72a8ddb13c8fc23141856c3129c40055b0c35c6895f5248de38d` |

Those three file digests are shown because the pin is only reproducible from
them; their contents stay in the private tree. The pinned private contract moved
with them to `e7a40270edc77b29313da0858a949f5ee8d126a30c5857f454c39e9b03ee6469`,
whose only change from the previous binding is where the historical Private17
joint fixture lives: that corpus now sits at an explicit versioned private path
so it can never displace the public 17+6 semantic corpus at
`qlever/tests/fixtures/qlever-semantic-conformance.cjs`. The fixture's own bytes
and case set are unchanged, so the private validator (`e962c8b9…`) and both
suites' digests stay exactly where they were.

Joint mode no longer implies a single PostgreSQL digest. It takes PostgreSQL from
the caller's own `--postgres-image`, accepted only in the strict
`ccr.ccs.tencentyun.com/undefineds/xpod-rdf-postgres@sha256:<digest>` form, and the
issued proof binds the exact value returned; public validation still requires
`proof.postgresImage` to equal the caller's `--pg-image`. That keeps the pair on
whatever canonical `NATIVE_PG_IMAGE` the candidate deploys, while floating tags,
foreign registries and malformed digests stay rejected before any Docker call.

Previous binding, kept for history: source array
`7c2176daae1ee2b356dd02471a942866faceab24b2cf429a2305471b3e7194da` from private
producer commit `e3ec7ff1c89bbb6072b5538be58455e03c43c279`, formal CNB amd64 run
`cnb-2gt-1k4f22ire` on public source
`944acf06a5ffe8ead2562ec515faed11c2164751`, service digest
`6ada40ff9a772c0c4d9658e42248f0c2c32b290dd2cdaf1481d7dc40cb3ad50d`, PG17
`1199698c789fb65897e4b0bd370f7faa959bcbdd3499784af256ad5bb8f0a5f3`, sanitized
proof `f9ec2ac0f9dac2f47f03cab94c5ccd5a0eec07d910d19eb869e5cd3e0b7f19c4`. That
proof does not carry over: the producer and private contract bytes changed, so a
fresh admission must be produced against the new public source and the actual
candidate digest pair.

This pin change is public source only. The existing release transport still
requires a GHCR service image and a separately configured byte authority. Local
file verification also accepts the approved CNB repository, with the same
exact-byte authority check; arbitrary repositories remain rejected. Updating this
pin changes public source bytes, so the future source commit, native/mounted
artifacts and installed images must be bound again before promotion — and until a
new candidate produces a valid joint proof, no image or RC may claim this
admission. Shared RC continues to require an ordinary reviewed merge into
`staging` and exclusive queue ownership.

## Same-failed-candidate resume

Re-running only the failed `deploy_and_accept` job is supported **only** as
consuming the original successful producer attempt. `build_image` exports the
attempt that actually produced the retained service/SDK originals
(`producer_attempt`), and `observe_service_sdk_source` passes that value to the
source/ABI observer instead of `GITHUB_RUN_ATTEMPT`. The service artifact, SDK
artifact, source closure and ABI relation therefore stay on the original
attempt/digest pair; nothing is rebuilt, renamed or spoofed, and the consumer's
own run attempt still owns the RC seed secret, cleanup and observation
artifacts.

GitHub attempts are immutable: attempt 1 of a run that later succeeded at
attempt 2 remains `completed/failure`. The candidate-only origin scope may
therefore accept that overall run state, but it is **provisional**: the private
issuer still requires the exact same-attempt producer job, its required steps,
the artifact name/digest/window, the immutable workflow bytes and the source
SDK/kernel/ancestor custody. Only then is an authenticity capability issued,
and that capability never claims RC qualification, installed-image conformance
or release acceptance. Cancelled, timed-out, neutral, skipped and every other
non-success conclusion stay rejected, as do failed runs of any other workflow
and mismatched source/job/attempt/digest coordinates.

A **whole-run rerun** that genuinely re-executes every producer at a new
attempt produces new producer coordinates (and possibly a new image digest).
That is a different candidate artifact: it needs a fresh joint admission and
Private17 proof and is not the case claimed here. Only the failed
`deploy_and_accept` consumer retry that keeps producer attempt 1 is claimed.

A **partial** rerun that rebuilds only `build_image` (or only the SDK) at
attempt 2 is **not** claimed: the deploy path requires both the service and SDK
producers to be the original attempt. Source/tree identity is never substituted
for digest identity. Refresh timing of `XPOD_PRIVATE17_ADMISSION_SHA256` remains
unknown; no race or new configuration is relied upon.

Focused public regression:

```sh
bun run test -- tests/scripts/joint-installed-admission.test.ts tests/scripts/check-qlever-installed-image-conformance.test.ts tests/scripts/candidate-workflow.test.ts
bun run build
bun run typecheck:test
bun run test:integration
```

In a fresh worktree, generate Components artifacts before freezing the physical
build and dependency manifest for the two integration runs. TypeScript alone
does not generate those artifacts; generating them during a run invalidates
the before/after binding even when the tests themselves pass. Wait for all
build and typecheck processes to exit before starting the frozen gate.

Keep actual Gateway identity/Pod, client authentication, models, Chat, Tasks,
desktop permissions, backup/restore and release evidence as separate gates.
