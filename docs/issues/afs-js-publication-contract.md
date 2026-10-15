# AFS standalone JS publication contract (proposed)

This is a producer contract for review, not an artifact or release approval. The source workspace remains private. The existing platform producer emits `@undefineds.co/xpod-afs-<platform>-<arch>`; that artifact cannot satisfy the generic `@undefineds.co/xpod-afs` dependency.

## Identity and private boundary

The distribution name and exact version come from the AFS source manifest, not a new catalog. A dedicated distribution-manifest builder explicitly declares that the **staged JS distribution** is publishable (`private: false`) while preserving the original private source manifest verbatim under provenance. This is a reviewed distribution boundary, not an edit to `packages/xpod-afs/package.json`. Until this boundary is approved and the producer/consumer evidence exists, the artifact is blocked for registry admission. No public publication is part of implementation or testing.

The distribution copies the existing `type`, `exports`, `main`, `types`, `typesVersions`, `engines`, license and Components.js mapping fields. It selects runtime `dependencies`, `optionalDependencies`, `peerDependencies` and peer metadata from that one source manifest; it drops build scripts/workspaces/devDependencies rather than shipping build-time paths. Workspace runtime edges are normalized through an extracted, shared function from the existing workspace pack helper, using verified dependency source identities. No manual dependency list, `file:` override, or removal of runtime edges is permitted. Runtime closure admission must account for the bundler's actual external imports as well as declared edges.

## Normal producer lifetime

Use `buildAfsClient` under the existing `withStagedProducerInput` scope and verified normal CLI/client publication inputs. Emit distribution files and close their receipt before that verified scope closes; call `producerInput.assertCurrent()` around emission. Do not create a second build implementation or copy installed package directories. The initial emitter consumes a completed normal client build and does not itself install, download or build dependencies.

The existing `check-afs-package.cjs` manually copies built dist into an external consumer. That is useful library evidence, **not** an archive-install or normal-publication acceptance gate. Keep its role explicit. Add a separate archive consumer to the normal publication preparation path, with isolated HOME, no repository ancestor imports, unchanged runtime edges, exact dependency originals, and real Node/Bun exits. Source, CLI/client tool material and generated payload bindings are separate facts.

## Bounded staged payload

Derive export/type/Components.js entry roots from the existing manifest and the normal build outputs. Retain their reachable JS/CJS/MJS, declarations, generated component JSON-LD and contexts, `dist/library.cjs`, `dist/runtime.mjs`, and the transitive notice/object files referenced by `dist/licenses`. All selected paths must be regular files under the completed build root; reject symlinks, traversal, duplicate destinations, missing targets, and unbounded file/count/total size. Validate every declared target before packing.

Do not blindly copy all dist: `library-source.ts`, `commands-source.ts`, build-only metafiles and inspection JSON belong in a provenance input bundle rather than being executable package exports. Existing `exports` includes commands/runner/install surfaces; these public JS exports remain available and must not silently disappear merely because the archive excludes native helpers. The current moduleLauncher launches the generic package’s own dist/entry.mjs; it does not automatically resolve or download a platform module. The emitter explicitly retains that generated entry and its JS closure. Packing/import checks must not launch the entry or native helpers.

No native binaries, helper payload, QLever/SQLite dynamic library, server runtime tree, source tree, node_modules, caches or platform module package enter this JS archive. Do not vendor the runtime client to avoid its declared external identity. Keep original licensing notices and content-addressed objects; a top-level license file is required even though the current workspace has no local LICENSE (use the existing repository license as an explicit input, preserving its hash). Include the existing AFS README with its hash, and document that helper/mount behavior requires the separately installed platform module.

## Retained originals and evidence

Emit a normal pack archive from the dedicated stage using the existing normal pack mechanism; never reconstruct it from the root package archive. Inspect that archive with the existing package inspection utilities. Retain:

- normal tgz original with exact name/version, actual bytes/SHA256/SRI;
- original private source manifest and generated distribution manifest, with independent hashes;
- sorted payload inventory (relative path, bytes, SHA256, mode) validated against the archive;
- source/tool input references, exact actual checkout and source snapshot state, CLI producer index and client publication archive hashes;
- real build, Node/Bun archive consumer and cleanup receipts; separate source/payload/legal/runtime-closure status, each blocked when missing.

An emitter fixture cannot attest a build or consumer run. No `ok: true` / source-qualified / release-qualified claim may be inferred from a matching archive hash alone. Keep historical 3606 compatibility failures unchanged and test any real producer with a new source-bound candidate.

## Proposed implementation file ownership

| File | Responsibility |
| --- | --- |
| `scripts/workspace-package-pack.cjs` | Extract and reuse its existing workspace dependency normalization, preserving current pack behavior. |
| `packages/xpod-afs/scripts/client-publication.cjs` (new) | Pure staged JS distribution-manifest/payload emitter and inventory; no dependency install, native build or network. |
| `packages/xpod-afs/scripts/build-client.ts` | Call emitter only in the reviewed normal publication path while the verified producer scope is live; preserve ordinary client build behavior. |
| `scripts/check-afs-client-publication.cjs` (new, later step) | Normal archive preparation and actual external Node/Bun consumer receipts; no public publish. |
| `tests/scripts/afs-client-publication.node-test.cjs` (new) | Tiny synthetic completed-build fixtures for manifest normalization, path/identity/private policy, inventory and blocked authority; no real product build or external dependencies. |
| AFS documentation | State the generic JS archive versus platform module contract and archive consumer limits. |

The first implementation is the pure emitter and shared normalization extraction after this contract is reviewed. Integration wiring and real producer acceptance follow separately. It must not touch Fabric's install-phase diagnostics or external extensions source.

## First implementation for peer review

The pure emitter and shared normalizer are implemented without build-client wiring or a normal archive consumer. The emitter stages verified completed-build files only and reports all build/consumer/source/release qualification flags false. Its caller must supply the live scope assertion; it checks that assertion before reading, before writing, and after writing, and removes a partial stage on failure. Twelve tiny fixtures pass, including source/external symlink-parent rejection and replacement-stage cleanup ownership. Destination ancestors must be existing real directories; canonical source containment is rejected before creating the fresh owned stage. Workspace dependency names reject dot segments before any manifest lookup. The existing normal-pack regression was attempted but could not spawn npm in this local tool environment (`ENOENT`); it is not recorded as passing. No dependency installation or large build was used to work around that limitation.
