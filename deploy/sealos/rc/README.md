# Xpod RC Sealos overlay

RC is released only from `staging` commits. Validate development branches in
isolated Docker projects, normally merge reviewed changes preserving ancestry, then admit one immutable
candidate to the shared environment. The workflow never automatically cancels
an active candidate. CNB and manual operations are outside GitHub's lock and
must coordinate exclusive ownership before touching RC. See the authoritative
[release process](../../../docs/RELEASE.md#先合入再发-rc); this overlay is not an
alternative branch release entry point.

This overlay deploys only RC-owned resources into GZ
(`https://gzg.sealos.run:6443`, namespace `ns-iknkxtc8`). It never creates a
Namespace or modifies production PostgreSQL databases or shared Inngest.

Public entry points mirror production roles:

- `id-rc.undefineds.cn` for OIDC, WebID, dashboard, and settings
- `pods-rc.undefineds.cn` for the hosted Pod entry point
- `api-rc.undefineds.cn` for authenticated APIs

All three Ingresses target `Service/xpod-rc-gateway`, a stable selector alias
for the existing unified Nginx Gateway. The Gateway routes each host to
`Service/xpod-rc`; it must be updated with
`scripts/update-gateway-rc-configmap.cjs` before public acceptance.

The candidate workflow renders this placeholder overlay into the assigned
namespace, creates `xpod-rc-secret` from the RC Environment's `APP_ENV_FILE`,
and mounts the fixed Alice/Bob seed from a run-specific Secret. The renderer
must place the immutable image digest, seed Secret name, seed mount, and
`CSS_SEED_CONFIG` into one final Deployment manifest before the workflow calls
`kubectl apply`. Do not patch the Deployment, set its image, or restart it in
separate steps: each pod-template mutation creates another ReplicaSet and can
interrupt CSS while it is creating the seeded accounts.

RC owns a dedicated PostgreSQL 17 server: `postgres.yaml` renders
`statefulset/xpod-rc-rdf-postgres`, its headless Service and an 8 GiB PVC, and
`postgres-bootstrap.yaml` renders the run-scoped bootstrap Job. Both are
deliberately outside `kustomization.yaml`, so the PG half is applied separately
*before* the app and the app itself is still a single final apply. The PG image
is the one canonical `NATIVE_PG_IMAGE` digest (`6a5731d7…`); the shared
production `xpod-rdf-postgres` instance, its PVC and its `xpod_cn`/`xpod_co`
data are never reset, upgraded or scaled by RC. A candidate resets only the
logical `xpod_rc` database on the RC-only server, then installs
`vector → xpod_rdf → xpod_qlever` in dependency order.

The current `APP_ENV_FILE` may still carry the old shared service host. The
centralized materializer in `scripts/check-rc-deployment-boundary.cjs` derives
the dedicated `xpod-rc-rdf-postgres` hostname from it, preserving the
`xpod_rc` role/database, scheme, port and percent-encoded password and every
other entry; the strict validator then rejects shared/production hosts, so no
manual secret migration and no fallback/alias is required. Before any reset the
workflow runs a fail-closed quiescence gate: `deployment/xpod-rc` must be at
`spec.replicas=0` with observed replicas at 0 and no running, pending, unknown
or terminating pod. The candidate never scales an active candidate; cross-run
ownership is coordinated with ROOT. The run-scoped bootstrap Job is deleted
only with its nonce annotation and live UID precondition; a foreign or replaced
Job is retained. The administrator Secret is retained with the PVC; see
`RC-POSTGRES-ADMIN.md` for the destructive revocation/reset procedure.

This destroys prior RC data, so coordinate exclusive ownership before merging a
deploying candidate. The shared
public RC entry points are serialized: only staging candidates may deploy, and
development branches must not mutate the static RC service. RC reuses
Redis and Inngest with an isolated nonzero Redis DB and Event Key. Pod blobs are written to the
dedicated Cloudflare R2 bucket `xpod-rc`; its endpoint and credentials come only
from `APP_ENV_FILE`. The historical `CSS_MINIO_*` names remain for compatibility
in this release even though the backend is R2. The Inngest Signing Key is shared
with the shared Inngest instance. Production object storage is not modified.

`CSS_BASE_URL`, `CSS_ALLOWED_HOSTS` and `XPOD_PUBLIC_API_URL` come from APP_ENV_FILE;
inline constants must not override them. Ports and edition remain structural
manifest settings. The managed Gateway block also preserves
the public Host and HTTPS forwarding headers so OIDC/DPoP URL verification sees
the same origin as the browser. `CSS_IDENTITY_DB_URL` and `CSS_SPARQL_ENDPOINT`
from `APP_ENV_FILE` are preserved field-by-field and their hostname is derived
for the dedicated RC-only PostgreSQL; the result is validated against the
`xpod_rc` role/database. Do not place production hosts or unsupported prefix variables in
`APP_ENV_FILE`.
