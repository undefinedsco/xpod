# Xpod CSS module producer

This producer stages the canonical CSS CLI and the Components used by Xpod's declared profiles. It keeps the Community Solid Server CLI, original config/context IRIs, templates, static resources, and per-request authentication adapters. The distribution name changes the Components `requireName`; it does not rename the protocol vocabulary.

`component-resources.ts` selects config-referenced components and their metadata dependencies, resolves runtime value exports to canonical source declarations, and binds copied resources to their SHA256 inventory. Its generated component entry imports those compiled declarations directly. It never loads the root service index or launches the Gateway/API host.

`build-package.ts --out <fresh-directory>` uses the shared physical module staging producer. The stage is diagnostic producer material, not an installable or publishable module yet. Complete original dependency/source/notices and actual platform native authority must pass admission before archive emission. Node/Bun ModuleStore installation, actual CSS HTTP requests, and owned process cleanup remain required acceptance stages. A CLI help result or resource-plan test does not satisfy those stages.

The standalone CSS profile must include the authorization/auxiliary imports selected by the public `auth-config` helper (`cssAuthModeConfigImports`). The service host retains its existing configuration wrapper; this module does not duplicate that policy. Local RDF profiles also require the declared QLever native runtime in the final module material. Supplying an external helper for a controlled diagnostic does not prove the distribution carries it.

An optional `--archive <fresh-file>` calls the canonical shared physical archive factory for a controlled preview. The factory owns the ModuleStore inventory, normalized artifact modes, regular-only tar layout, and byte/mode readback checks. Archive creation alone does not satisfy native/source/notices or release admission.

For an installed CSS ModuleManifest, the CLI entry derives the QLever command from its declared `native/qlever/bin/xpod_qlever_local_runtime` file. Missing, nonregular, or escaping paths fail startup; an existing explicit deployment binding retains its established meaning. The full service entry keeps its previous startup behavior. ModuleStore remains responsible for complete inventory/hash verification.

Publication staging now accepts `--publication preview|release` and `--version` through the shared producer. Release additionally requires `--materials-root` pointing to an independent original-material directory. Native binary references belong to the product; source kits, compiler inputs, sysroot originals and closed build/test observations belong to that external directory. Only the bound native index belongs in product provenance; expanded materials must not enter its runtime inventory. Shared notices/native verifiers reject missing or drifting authority before release archive creation. A release archive remains a candidate awaiting external admission, never an accepted publication.

The common platform declaration pure entry is still pending integration. This adapter uses the existing module catalog for package identity and does not introduce another platform matrix. Historical controlled preview archives remain unchanged.
