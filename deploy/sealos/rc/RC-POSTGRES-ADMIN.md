# RC-only PostgreSQL administrator credential (D3 decision)

ROOT decision: **retain** a standing RC-only administrator credential bound to the
RC PVC, with an explicit revocation/reset procedure. This document is the
contract; there is no automated rotation.

## What the credential is

| | |
|---|---|
| Secret | `xpod-rc-postgres-bootstrap` (keys `username`, `password`, `database`) |
| Role | `xpod_rc_admin`, the cluster superuser of the **RC-only** StatefulSet |
| Scope | RC-only PostgreSQL instance `xpod-rc-rdf-postgres` and its PVC |
| Created | once, when the PVC is first initialised |
| Rotated | never automatically |
| Readable by | the bootstrap Job only |

`xpod_rc_admin` is a PostgreSQL **superuser** because `CREATE EXTENSION` requires
it. It is bound to the RC PVC: deleting the Secret without deleting the PVC does
not change the database password, and deleting the PVC without the Secret leaves
an orphan Secret.

## The application must never read it

- The app Deployment mounts only `xpod-rc-secret` (`CSS_*` env). It has no
  reference to `xpod-rc-postgres-bootstrap`.
- The bootstrap secret is *not* projected into the app pod, is not in the app's
  `envFrom`, and is not mounted as a volume.
- The app connects as `xpod_rc` (non-superuser, `NOSUPERUSER NOCREATEROLE
  NOCREATEDB`), whose password is `xpod-rc-postgres-app`.
- A unit test asserts that no app manifest references the bootstrap secret name.

## Revocation / reset procedure (destructive, RC-only)

Use when the administrator credential is believed exposed, or when a full RC
reset is required. **This destroys all RC data. It never touches `xpod_cn`,
`xpod_co`, or the shared `xpod-rdf-postgres` instance/PVC.**

```sh
set -euo pipefail
NS="$SEALOS_NAMESPACE"

# 1. Stop the app so nothing reconnects mid-reset.
kubectl -n "$NS" scale deployment/xpod-rc --replicas=0

# 2. Delete the RC-only server, its PVC and both credentials together. The
#    StatefulSet uses persistentVolumeClaimRetentionPolicy: Retain, so the PVC
#    must be deleted explicitly.
kubectl -n "$NS" delete statefulset xpod-rc-rdf-postgres --ignore-not-found --cascade=foreground --wait=true
kubectl -n "$NS" delete pvc -l app=xpod-rc-rdf-postgres --ignore-not-found --wait=true
kubectl -n "$NS" delete secret xpod-rc-postgres-bootstrap xpod-rc-postgres-app --ignore-not-found

# 3. Confirm nothing RC-only survives.
kubectl -n "$NS" get statefulset,pvc,secret -l app=xpod-rc-rdf-postgres
kubectl -n "$NS" get secret xpod-rc-postgres-bootstrap --ignore-not-found   # must print nothing

# 4. The next candidate run re-creates the PVC, a fresh admin Secret, the role
#    and the xpod_rc database through the same bootstrap Job.
```

Partial revocation is explicitly **not** supported: resetting only the Secret
leaves the old password valid in `pg_authid`. Only the delete-both path revokes.

## Residual risk accepted by ROOT

Until revocation, a reader of `xpod-rc-postgres-bootstrap` has superuser rights
on the RC-only instance. That instance contains only RC seed data, is not
reachable from production, and cannot read `xpod_cn`/`xpod_co` (separate
cluster). The blast radius is bounded to RC.
