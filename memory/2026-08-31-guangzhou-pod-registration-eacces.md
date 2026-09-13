# Debug Report: Guangzhou Pod registration EACCES

- Date: 2026-08-31
- Status: DONE
- Environment: Guangzhou `xpod-rc`, namespace `ns-iknkxtc8`

## Symptom

Registration created the account and password login, but Pod creation returned HTTP 400:

`EACCES: permission denied, mkdir '/app/cuilinsu/'`

## Root cause

The Guangzhou container correctly runs as UID/GID 1000. `/app` is owned by root and is not writable by UID 1000. The deployment starts Xpod without defining the CSS root file path:

`node dist/main.js -c config/cloud.json -p 3000`

The CSS `FileIdentifierMapper` therefore resolves the new Pod's local RDF mirror beneath the working directory and tries to create `/app/cuilinsu`. The deployment already mounts `/app/data` with group 1000 and that path is writable, but CSS was not configured to use it.

Singapore has the same missing root-path argument, but its container runs as root, so the configuration defect is hidden there.

## Evidence

- Account password login request returned HTTP 200.
- Pod creation request logged MinIO `writeContainer`, then failed creating `/app/cuilinsu`.
- Guangzhou runtime identity is `uid=1000 gid=1000`.
- `/app` is `root:root` and not writable by UID 1000.
- `/app/data` is group-owned by GID 1000 and writable.
- Both checked-in RC/Cloud manifests omitted `CSS_ROOT_FILE_PATH=/app/data`.
- The running Guangzhou and Singapore deployments both omitted the root-path setting.
- Passing `-f /app/data` to `dist/main.js` does not fix this path: `-f` belongs to the child Community Solid Server CLI, while the outer Xpod legacy CLI does not forward it.

## Fix

Define `CSS_ROOT_FILE_PATH=/app/data` in the authoritative RC and Cloud deployment manifests and in the Guangzhou deployment workflow. The CSS child process already inherits this environment variable and Community Solid Server resolves it as `rootFilePath`.

The Guangzhou deployment was patched and rolled out without changing its image or security context. Singapore was inspected only and was not modified. The fix deliberately keeps Guangzhou non-root and does not make `/app` world-writable.

Guangzhou exposes separate Cloud and RC account hosts. The first rollout fixed `xpod-rc` (`undefineds-gz-rc-id.sealosgzg.site`), while the user-facing signup page uses `xpod-cloud` (`undefineds-gz-id.sealosgzg.site`). The Cloud deployment still had the old runtime environment and reproduced the same `/app/cuilinsu` error. `CSS_ROOT_FILE_PATH=/app/data` was therefore also applied to the live `xpod-cloud` deployment and its rollout was verified.

## Partial state

The account and password login were created before the original Pod creation failed. Community Solid Server rolled back the Pod identity record, but the multi-store write was not atomic: MinIO retained `cuilinsu/.container` and the RDF store retained the matching `meta:` graph. That stale storage state caused a later retry to report `Pod name "cuilinsu" is already taken for this storage target` even though the account dashboard listed no Pod.

Account identity and Pod name are intentionally separate. The login account uses email/password; the Pod name is the globally unique public storage identifier. The separation is valid, but the stale marker and the account page's lack of visible login identity made the failure misleading.

The failed `cuilinsu` storage marker and all agent-created `gzfix-*` test accounts, Pods, RDF rows, object-store entries, and local test directories were removed through exact allowlists. The user's current login account was not deleted.

## Verification

- Guangzhou rollout completed with one ready replica and zero restarts.
- Runtime remains `uid=1000 gid=1000`.
- `CSS_ROOT_FILE_PATH=/app/data` is present and writable in the running container.
- A new account and Pod were created through the real public account API.
- The local RDF mirror was created under `/app/data/gzfix-mtg2vopc`, not `/app`.
- `GET /gzfix-mtg2vopc/profile/card` returned HTTP 200 with `text/turtle`.
- No `EACCES`, `permission denied`, or `mkdir '/app/…'` error appeared after the fix.
- Manifest/workflow regression tests and TypeScript build passed.
- Lite integration regression passed: 25 files and 133 tests passed; 3 files and 5 tests were intentionally skipped.
- Cleanup verification found zero `cuilinsu` or `gzfix-*` matches in identity storage, RDF sources/terms/access-control rows, MinIO, and the local RDF mirror.
- The Guangzhou deployment remained `1/1` ready and the public account page returned HTTP 200 after cleanup.
- The Guangzhou Cloud deployment also remained `1/1` ready, reported `CSS_ROOT_FILE_PATH=/app/data`, and confirmed that path was writable by UID/GID 1000.
- The failed Cloud signup left 14 `cuilinsu` objects and 5 metadata quads; all were removed through exact allowlists. The attempted email had no surviving identity record, so the same signup details can be submitted again after refreshing the page.
