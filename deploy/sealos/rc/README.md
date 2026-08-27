# Xpod RC Sealos overlay

This overlay deploys only RC-owned resources into the Sealos-assigned CO
namespace. It never creates a Namespace and it does not modify production
Inngest; `xpod-rc-inngest` is owned by this overlay.

Public entry points mirror production roles:

- `id-rc.undefineds.co` for OIDC, WebID, dashboard, and settings
- `pods-rc.undefineds.co` for the hosted Pod entry point
- `api-rc.undefineds.co` for authenticated APIs

All three Ingresses target the RC-owned `Service/xpod-rc` directly. This keeps
the overlay self-contained in a fresh Sealos namespace and avoids mutating or
depending on a production Gateway Deployment or ConfigMap.

The candidate workflow renders this placeholder overlay into the assigned
namespace, creates `xpod-rc-secret` from the RC Environment's `APP_ENV_FILE`,
and mounts the fixed Alice/Bob seed separately. `CSS_IDENTITY_DB_URL` and
`CSS_SPARQL_ENDPOINT` from `APP_ENV_FILE` are ignored: every candidate run
generates a fresh PostgreSQL password, recreates the ephemeral `StatefulSet/xpod-rc-postgres`
from the pinned PostgreSQL 17 + pgvector image in `deploy/sealos/rc-postgres`,
first removes the previous RC Xpod and Inngest Deployments so no old process can
initialize the new database, uses an `emptyDir` database volume scoped to that
acceptance run, verifies and enables `vector`,
and writes the generated `xpod_rc` connection URLs into the runtime Secret. RC
still reuses Redis, but
must use an isolated nonzero Redis DB. Its dedicated Inngest Deployment uses
the RC Event and Signing Keys and only calls `xpod-rc`. Pod blobs are written to the
dedicated Cloudflare R2 bucket `xpod-rc`; its endpoint and credentials come only
from `APP_ENV_FILE`. The storage adapter's current configuration contract names
these fields `CSS_MINIO_*` even when the endpoint is R2. Production object
storage is not modified.

`CSS_BASE_URL`, `CSS_ALLOWED_HOSTS`, `XPOD_PUBLIC_API_URL`, ports, edition, and
RC source are fixed in the manifest. The Ingress preserves the public Host and
HTTPS forwarding headers so OIDC/DPoP URL verification sees the same origin as
the browser. Do not place production hosts or unsupported
prefix variables in `APP_ENV_FILE`.
