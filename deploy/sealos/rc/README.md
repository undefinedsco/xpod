# Xpod RC Sealos overlay

This overlay deploys only RC-owned resources into the Sealos-assigned CO
namespace. It never creates a Namespace and it does not modify production
Inngest; `xpod-rc-inngest` is owned by this overlay.

Public entry points mirror production roles:

- `id-rc.undefineds.co` for OIDC, WebID, dashboard, and settings
- `pods-rc.undefineds.co` for the hosted Pod entry point
- `api-rc.undefineds.co` for authenticated APIs

All three Ingresses target `Service/xpod-rc-gateway`, a stable selector alias
for the existing unified Nginx Gateway. The Gateway routes each host to
`Service/xpod-rc`; it must be updated with
`scripts/update-gateway-rc-configmap.cjs` before public acceptance.

The candidate workflow renders this placeholder overlay into the assigned
namespace, creates `xpod-rc-secret` from the RC Environment's `APP_ENV_FILE`,
and mounts the fixed Alice/Bob seed separately. RC reuses the physical
PostgreSQL and Redis services, but selects an isolated logical database/schema
and nonzero Redis DB. Its dedicated Inngest Deployment uses the RC Event and
Signing Keys and only calls `xpod-rc`. Pod blobs are written to the
dedicated Cloudflare R2 bucket `xpod-rc`; its endpoint and credentials come only
from `APP_ENV_FILE`. The storage adapter's current configuration contract names
these fields `CSS_MINIO_*` even when the endpoint is R2. Production object
storage is not modified.

`CSS_BASE_URL`, `CSS_ALLOWED_HOSTS`, `XPOD_PUBLIC_API_URL`, ports, edition, and
RC source are fixed in the manifest. The managed Gateway block also preserves
the public Host and HTTPS forwarding headers so OIDC/DPoP URL verification sees
the same origin as the browser. Do not place production hosts or unsupported
prefix variables in `APP_ENV_FILE`.
