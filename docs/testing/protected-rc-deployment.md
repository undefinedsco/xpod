# RC-dedicated PostgreSQL boundary

RC runs its own PostgreSQL 17 StatefulSet, `statefulset/xpod-rc-rdf-postgres`,
with a dedicated 8 GiB PVC and its own Service. It is rendered from the same
canonical `NATIVE_PG_IMAGE` digest (`6a5731d7…`) that the pre-Kubernetes
17-semantic + 6-wire conformance gate and the exact-image pull preflight prove.
The shared production instance `statefulset/xpod-rdf-postgres` and its data are
never read for RC writes, never reset, never upgraded, and never scaled by the
candidate or cleanup jobs. Production `xpod_cn`/`xpod_co` are outside the RC
blast radius entirely.

`candidate.yml` does not require an operator to rewrite the RC database host by
hand. The centralized materializer in `scripts/check-rc-deployment-boundary.cjs`
(`materializeRcDatabaseConfiguration`) takes the current `APP_ENV_FILE`
credentials exactly as stored, keeps role `xpod_rc`, database `xpod_rc`, scheme,
port and percent-encoded password bytes, and derives the dedicated
`xpod-rc-rdf-postgres` hostname before the strict validator runs. Only the two
database endpoint values (`CSS_IDENTITY_DB_URL`, `CSS_SPARQL_ENDPOINT`, plus an
exact `DATABASE_URL`/`CSS_TASK_DB_URL` alias when present) are rebound; every
other entry is preserved byte for byte. No GitHub secret write and no new
configuration alias is introduced. The strict `validateDatabases` gate still
rejects the shared production host and any production role/database when called
directly, so a stale or tampered configuration cannot silently pass.

## Ordering

The immutable 17-semantic + 6-wire installed-image conformance gate, the
full-integration run against the same PG17 digest, the independent Private17
admission and the namespace pull preflight all complete before the first
mutation of the RC environment. Concretely:

1. pre-Kubernetes 17+6 conformance and exact-image pull against `NATIVE_PG_IMAGE`;
2. full integration against the same PG17 candidate;
3. Private17 admission and namespace pull preflight;
4. RC-only PG render, quiescence, bootstrap Job, readiness;
5. runtime Secret, gateway ConfigMap and the single final app apply.

Nothing at step 4 runs unless steps 1–3 passed. The app Deployment still has
exactly one `kubectl apply -f "$rendered_manifest"`; the PG half is a separate
rendered file applied earlier. No `set image`, no Deployment patch and no
rollout restart of the app is allowed.

## Quiescence and ownership

Before the bootstrap Job may `DROP`/`CREATE` the logical `xpod_rc` database, the
workflow reads `deployment/xpod-rc` and `pods -l app=xpod-rc` and runs
`scripts/rc-bootstrap-ownership.cjs quiescent`. It fails closed unless
`spec.replicas` is 0, observed `status.replicas`/`readyReplicas`/
`availableReplicas` are all 0, and no pod is terminating or in a running,
pending, unknown or missing phase. An API error aborts; only an authoritative
404 with `--ignore-not-found` may be treated as absent. The workflow never
scales an active candidate — cross-run ownership is a ROOT coordination
decision, not something the candidate may interrupt.

The bootstrap Job name is run-scoped
(`xpod-rc-postgres-bootstrap-${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}`) and carries
the `xpod.undefineds.co/bootstrap-owner` annotation. Any pre-existing same-name
Job is removed only after proving that annotation matches *and* deleting through
a `DeleteOptions` document with the live `metadata.uid` precondition. Cleanup
repeats the same nonce+UID guard in its own bounded block; a foreign or replaced
Job is retained, and its pod wait failure is not swallowed.

## Role, credentials and revocation

The bootstrap Job creates `xpod_rc` with `LOGIN NOSUPERUSER NOCREATEROLE
NOCREATEDB`, re-applies `ALTER ROLE … PASSWORD :'rc_password'` on every run from
the `xpod-rc-postgres-app` Secret derived from the validated environment file,
and then authenticates as that role. The app Deployment never references the
standalone administrator Secret. Readiness (`scripts/verify-protected-rc-database.sh`)
runs read-only inside the RC-only pod and additionally requires PG17, the
`xpod_rc` owner, a non-superuser role and the exact `vector`/`xpod_rdf 0.2.0`/
`xpod_qlever 0.4.0` extension versions.

Neither `xpod_rdf` nor `xpod_qlever` ships any `GRANT`, and PostgreSQL gives a
custom schema no default `PUBLIC` `USAGE`. A non-superuser `xpod_rc` therefore
could not even resolve `xpod_rdf.version()`. After extension installation the
bootstrap Job grants only the minimum the public `PostgresRdfEngine` needs:
`USAGE` on schema `xpod_rdf`, table `SELECT/INSERT/UPDATE/DELETE` in that schema,
sequence `USAGE, SELECT` in that schema, and two matching `ALTER DEFAULT
PRIVILEGES IN SCHEMA xpod_rdf` entries for future extension objects. The grants
name only `xpod_rdf` and `TO xpod_rc`; there is no `PUBLIC`, `GRANT ALL`,
`SUPERUSER`/`CREATEROLE`/`CREATEDB`, ownership transfer, `REASSIGN OWNED` or
`SECURITY DEFINER`, and the role remains `NOSUPERUSER NOCREATEROLE NOCREATEDB`.

The administrator credential `xpod-rc-postgres-bootstrap` is intentionally
retained with the RC PVC; it is never rotated automatically. Its scope, the hard
rule that the app can never read it, and the destructive RC-only revocation/reset
procedure (scale app to zero → delete the RC StatefulSet, its PVC by label and
both RC PostgreSQL Secrets → confirm absence → next run re-creates them) are
documented in `deploy/sealos/rc/RC-POSTGRES-ADMIN.md`. Partial revocation is not
supported: deleting only the Secret leaves the old password valid in `pg_authid`.

Cleanup deliberately keeps the RC StatefulSet, its PVC and the administrator
Secret. It scales only `deployment/xpod-rc` and removes only the per-run seed
Secret plus the run-owned bootstrap Job.

## What this boundary does not prove

These tests and the workflow contract prove configuration, rendering, shell,
grant-scope and ownership semantics. The scoped-grant proof is synthetic
(bootstrap template + stub `psql`); it is not an installed-roles regression
receipt. They do not prove StatefulSet scheduling, a real PVC-backed bootstrap,
extension availability or real engine behaviour inside the final `6a…` image,
the 17+6 gate passing on a real cluster, the quiescence refusal branch against a
live namespace, the UID-precondition delete against a real API server, or
product acceptance of the migrated database. A real deployment must still
produce those receipts. In particular, final native semantic bindings are NOT
proven here: a local raw native query returned an empty binding set, and that
empty result must not be promoted to a semantic pass.
Existing production backup/full-restore evidence does not substitute for RC
product conformance, and no test here is a canonical RC or release acceptance.

The mounted development workflow uses one immutable authority inventory at
`scripts/agentfs-native-ci/mounted/native-authority.json`. Four targets execute
Node and Bun separately against the same built module/core and fresh homes.
Runner architecture, native artifact metadata and hashes, source reuse, actual mounted
cases and supervised close/cleanup remain required. Native build success alone cannot
satisfy mounted acceptance. These jobs do not enter or mutate RC.
