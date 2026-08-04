# Xpod RC Sealos overlay

This overlay deploys only RC-owned resources into the Sealos-assigned CO
namespace. It never creates a Namespace or a private Inngest instance.

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
PostgreSQL, Redis, and Inngest, but must select an isolated logical
database/schema, nonzero Redis DB, and Event Key. Pod blobs are written to the
dedicated Cloudflare R2 bucket `xpod-rc`; its endpoint and credentials come only
from `APP_ENV_FILE`. The historical `CSS_MINIO_*` names remain for compatibility
in this release even though the backend is R2. The Inngest Signing Key is shared
with the shared Inngest instance. Production object storage is not modified.

`CSS_BASE_URL`, `CSS_ALLOWED_HOSTS`, `XPOD_PUBLIC_API_URL`, ports, edition, and
RC source are fixed in the manifest. The managed Gateway block also preserves
the public Host and HTTPS forwarding headers so OIDC/DPoP URL verification sees
the same origin as the browser. Do not place production hosts or unsupported
prefix variables in `APP_ENV_FILE`.
