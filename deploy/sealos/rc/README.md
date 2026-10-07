# GZ RC overlay

This overlay contains only RC-owned ConfigMap, Service and Deployment. It cannot initialize a database,
create a Namespace or modify shared Gateway, Inngest, Ingress or TLS resources.
The only admitted server/namespace are https://gzg.sealos.run:6443 / ns-iknkxtc8.

The independently dispatched `solidfs-gz-readonly.yml` workflow uses the existing
GZ CI credential only after checking that exact server, and issues namespace-scoped
GETs for Deployment/StatefulSet/Service/Ingress metadata. Its artifact explicitly
uses `READ-ONLY-METADATA`: images, PVC references and clone-admission locator are
observations, not backup/restore, ready-Pod identity, registry pull, OAuth or RC
acceptance. It never reads Secret contents or performs cluster mutations. Its
offline tests exercise wrong-server refusal and output redaction, not a real GZ
instance. This entry point does not replace the admission gates below.

The existing canonical hosts are undefineds-gz-rc-id.sealosgzg.site,
undefineds-gz-rc-pods.sealosgzg.site and undefineds-gz-rc-api.sealosgzg.site.
Fresh UID/TLS/route admission verifies shared nginx 8082/8083/8081 → xpod-rc:80.
Missing or conflicting declarations stop deployment; the workflow never rewrites shared routes.
The 2026-10-05 read-only observation binds all three Ingress paths to the existing `gateway` Service. It does not prove loaded nginx routing. Headers may be inherited; real OAuth/DPoP/Pod acceptance determines their runtime correctness. Shared Inngest has no RC registration and is left untouched. This workflow birth-creates a run-owned managed executor from the existing cloud Inngest template and derives its Service URL. The independent PG17 clone remains a required separately prepared input.

The authoritative APP_ENV_FILE supplies the prepared independent PG17 xpod_rc DSNs,
nonzero Redis DB, isolated xpod-rc R2 bucket/credentials and stable locator/Inngest keys.
The real original xpod_rc is PG16.4 on undefineds-gz-postgresql-postgresql; the old scaled-down
RC StatefulSet/PVC is not its source. Controlled backup and clone restoration happen outside
this workflow. See docs/RELEASE.md for PG156, required extension/ABI and provenance checks.
No random password, emptyDir database reset, CREATE EXTENSION or PVC/Secret deletion is permitted.

Run-specific immutable runtime/seed Secret names carry a nonce and acknowledged birth UID.
Secrets still referenced by a Deployment/Pod are retained. Only unused acknowledged owned
Secrets may be deleted with a UID precondition; collisions/unknown creation outcomes are preserved.
The current RC Deployment UID/resourceVersion, accepted digest and run seed mount are rendered
into one final manifest and applied once, without set-image/restart intermediate operations.
The Bun CLI explicitly uses cloud.qlever.json, Gateway 3000 and internal CSS/API 6300/6301.

All live Pod, OIDC, two-identity/browser, Gateway/AI/Tasks, Local, desktop, native and package
consumer gates remain mandatory. Local mock contract tests do not establish GZ readiness.

Run-owned executor objects use `xpod-rc-inngest-<run-id>-<attempt>` and `inngest start`, the same existing image/protocol, prepared PG17 and isolated Redis from the versioned runtime Secret. Fresh absence precedes atomic create; acknowledged birth UID and owner nonce precede rollout. Unknown create outcomes are retained. The guarded final app apply references that executor. Cleanup preserves any referenced executor or Secret; an accepted later switch may reclaim the prior run by exact UID/nonce, with foreground deletion and bounded absence waits. No actual executor rollout or Tasks delivery is established by local fixtures.


Prepared clone admission requires the immutable ConfigMap referenced by the target StatefulSet annotation `xpod.undefineds.co/rc-clone-restore-admission`; see `docs/RELEASE.md` for the source/archive/restore/UID proof schema. Metadata labels do not establish a full restore. Missing records, nonpersistent PGDATA, reuse of source or legacy RC volumes, conflicting optional `CSS_TASK_DB_URL`, and a Service pointing outside the admitted ready Pod fail closed. Actual backup/restore compatibility remains untested until the data lane produces and independently validates the original evidence.
