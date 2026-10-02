# Xpod RC PostgreSQL + QLever overlay

This overlay owns only `Service/xpod-rc-postgres` and
`StatefulSet/xpod-rc-postgres` inside the Sealos-assigned RC namespace. It never
creates a Namespace, a PVC, or any production resource. Data lives on an
`emptyDir` so every candidate run starts from an empty PostgreSQL authority.

## Immutable image

The StatefulSet pins the private PostgreSQL 17 + pgvector + QLever database image
by digest:

```
ccr.ccs.tencentyun.com/undefineds/xpod-rdf-postgres@sha256:de247beacf40af59a9e209e02cf257b0bdb33d9f47a7f77e4eb379635a2488ba
```

Never deploy a mutable tag. The old GHCR digests predate the default-graph and
native SPI changes and must not be used. Anonymous or default-registry `docker
pull` against the newest TCR image returns `401` for authorization, not a missing
artifact; authorization is granted through a namespace pull secret.

## Pull secret

The private TCR registry requires an `imagePullSecrets` entry whose name matches
a secret that actually exists in the assigned namespace. ROOT confirmed the
namespace contains the existing `kubernetes.io/dockerconfigjson` secret
`tcr-creds`, so this overlay references exactly that name. Static historical
names such as `xpod-qlever-rc-registry` or `xpod-rdf-ghcr` must not be substituted.
The runner's image gate may read only the authorized TCR entry into a temporary
0600 Docker config; credential values must never be printed or uploaded. The name proves
existence, not pull permission: the candidate workflow must still pass the
namespace-local pull preflight below before any old RC resource is replaced.

## Predeployment pull preflight

Before the workflow rotates the old PostgreSQL password/DSN or deletes any RC
resource, it applies `pull-preflight.yaml`. That Job runs the exact pinned
digest with `imagePullSecrets: [tcr-creds]`, never mounts the RC data volume, and
only checks PostgreSQL version plus the `vector` / `xpod_rdf` / `xpod_qlever`
extension control files. It proves the assigned namespace kubelet can pull the
digest independently of the runner Docker gate, and it deletes its own Job on
every path. A pull or check failure leaves the existing RC database untouched.

## Bootstrap contract

The candidate workflow provisions the authority once the StatefulSet is ready:

1. `CREATE EXTENSION IF NOT EXISTS vector`
2. `CREATE EXTENSION IF NOT EXISTS xpod_rdf`
3. `CREATE EXTENSION IF NOT EXISTS xpod_qlever`
4. verify `xpod_rdf.native_sparql_capabilities()` returns `abiVersion = 1` and
   `ready = true`

The installed `PostgresRdfEngine.initialize` creates the authority and physical
schema through the product path. The workflow does not duplicate its schema DDL
or manually prepare the physical schema.

The public 16-case semantic and search conformance does **not** run in the RC
business database. `PostgresRdfEngine.initialize` calls
`xpod_rdf.ensure_statistics_triggers()`, which drops/recreates five global
statistics triggers on `public.rdf_quads`/`public.rdf_sources`, so a per-schema
`search_path` is not sufficient isolation. Instead the workflow creates a unique
owned database `xpod_rc_native_<run>_<attempt>` on the same PostgreSQL pod,
installs the same extensions there, derives the container DSN from
`CSS_SPARQL_ENDPOINT` with only the URL pathname changed, and drops that database
even on failure. The gate fails closed: a missing capability, a failed case, or a
digested candidate whose runner or fixture hash drifted from the pinned contract
stops the deploy instead of falling back to Comunica.
