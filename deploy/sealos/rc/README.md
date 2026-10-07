# Xpod RC Sealos overlay

RC is released only from `rc` commits. Validate development branches in
isolated Docker projects, normally merge reviewed changes preserving ancestry, then admit one immutable
candidate to the shared environment. The workflow never automatically cancels
an active candidate. CNB and manual operations are outside GitHub's lock and
must coordinate exclusive ownership before touching RC. See the authoritative
[release process](../../../docs/RELEASE.md#先合入再发-rc); this overlay is not an
alternative branch release entry point.

This overlay deploys only RC-owned resources into the Sealos-assigned GZ
namespace. It never creates a Namespace or a private Inngest instance.

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
interrupt CSS while it is creating the seeded accounts. Every candidate resets its own
database in the shared PostgreSQL instance (`xpod-rdf-postgres`, database
`xpod_rc`) before deploying: the database is dropped and recreated, then the
`vector`, `xpod_rdf` and `xpod_qlever` extensions are installed in that order,
so stale schemas and candidate data cannot cross runs and no per-run database
instance has to be provisioned or reclaimed. The shared
public RC entry points are serialized: only rc candidates may deploy, and
development branches must not mutate the static RC service. RC reuses
Redis and Inngest with an isolated nonzero Redis DB and Event Key. Pod blobs are written to the
dedicated Cloudflare R2 bucket `xpod-rc`; its endpoint and credentials come only
from `APP_ENV_FILE`. The historical `CSS_MINIO_*` names remain for compatibility
in this release even though the backend is R2. The Inngest Signing Key is shared
with the shared Inngest instance. Production object storage is not modified.

`CSS_BASE_URL`, `CSS_ALLOWED_HOSTS`, `XPOD_PUBLIC_API_URL`, ports, edition, and
RC source are fixed in the manifest. The managed Gateway block also preserves
the public Host and HTTPS forwarding headers so OIDC/DPoP URL verification sees
the same origin as the browser. `CSS_IDENTITY_DB_URL` and `CSS_SPARQL_ENDPOINT`
are provided by `APP_ENV_FILE` and target the shared `xpod-rdf-postgres`
instance; the workflow resets only the logical `xpod_rc` database (drop and
recreate, then the `vector`/`xpod_rdf`/`xpod_qlever` extensions) before
deploying, without provisioning or reclaiming a per-run PostgreSQL instance.
Do not place production hosts or unsupported prefix variables in
`APP_ENV_FILE`.
