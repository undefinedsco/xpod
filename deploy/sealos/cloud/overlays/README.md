# Per-environment overlays

These directories record what the `cn` and `co` environments actually run. They
were exported from the live Deployments and Services in the Guangzhou cluster on
2026-10-06 rather than written by hand, because the two environments differ in
ways no single template predicted:

| | cn | co |
|---|---|---|
| config source | `xpod-cloud-config` + `xpod-cloud-secret` | `xpod-cloud-secret` only |
| pull secrets | `xpod-registry`, `rdf-parity-ghcr` | `xpod-registry` |
| logs | mounted from `xpod-storage` | its own `xpod-co-logs` volume |

The image is pinned to the digest that was running at export time; a deploy
replaces it (`deploy.yml` sets the image and rolls out). The base directory next
to this one still describes the retired single-cloud layout and is kept only as
history.
