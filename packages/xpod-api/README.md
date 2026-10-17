# Xpod API platform producer

The producer starts from canonical `src/api/main.ts`, checks the actual Bun physical-input graph, then transpiles the complete local CommonJS source closure into its original relative layout. External packages retain their original physical files, dynamic resources and resolved dependency versions. Byte-identical originals are shared only when their complete dependency graphs also match; required conflicting versions retain nearest-parent placement. This does not rename or copy the root service distribution.

From the repository root:

```
bun packages/xpod-api/scripts/build.ts
bun packages/xpod-api/scripts/stage.ts .test-data/api-producer/package
bun packages/xpod-api/scripts/notice-material.ts .test-data/api-producer/package <notice-supplement-directory>
bun packages/xpod-api/scripts/native-material.ts .test-data/api-producer/package <official-evidence-directory>
bun packages/xpod-api/scripts/pack.ts .test-data/api-producer/package .test-data/api-producer/api-preview.tgz
```

Use fresh explicit output paths. The host platform controls this preview; foreign native targets are not claimed. Both API and CSS producers use `scripts/lib/physical-module-archive.ts` as the single inventory/tar factory. It verifies every archive member after packing and normalizes runtime modes to 0644/0755 while preserving original package modes in provenance. The archive carries the ModuleStore v1 exact file hash/size/mode inventory and the canonical API executable entry. An earlier controlled Darwin ARM64 preview was installed, started to HTTP 200 and normally stopped through the public CLI with both Node and Bun; each final archive requires its own complete consumer proof. This is a controlled registry fixture, not registry publication evidence.

`provenance` binds original package files, source inventory and emitted outputs; the API bundle path preserves producer/toolchain distributions in a verified source-only archive. The original member limit remains 50,000. API-host requirements outside the physical static graph are declared explicitly: the producer manifest declares embedded Inngest and default ACP runtime packages. Their standard `package.json` bin declarations generate regular launchers bound to the original targets; JavaScript launchers use the current Node/Bun service executable, and native launchers wait for the actual child exit. The Inngest hook-produced executable and actual `bin/LICENSE.md` are retained.

The native material stage requires the official release API/tag records, matching platform release archive and commit-bound upstream source archive. It verifies the executable and original terms byte for byte and retains the original archives. Packing rejects absent or drifted material. Public release remains blocked until the complete third-party notice/material audit closes. Preview metadata states `publishReady: false`; it does not promote legal clearance. The API owns its existing dashboard, settings and authentication-callback routes. The build executes the two canonical UI builds and binds their exact asset inventory and original UI/workspace source inventory. UI build tools are not installed as API runtime dependencies. Stage rejects stale asset or source bytes. CSS startup/configuration remains an independent product; shared CSS library components remain when the API actually depends on them. A health response does not prove these static routes or default ACP initialization; they require separate archive consumer checks.

### Explicit build publication mode

`bun scripts/stage.ts <fresh-stage> release 0.1.0` selects a formal candidate; omitting both mode and version retains the controlled private preview. Release staging and packing independently require the actual Git tree to remain clean and bind the exact source commit. Adapter manifest fields cannot override package identity or publication status. Candidate tar bytes remain immutable while external acceptance receipts attach to their digest.

Formal API packing currently refuses incomplete native build/toolchain/source bindings. Official binary and source archive hashes alone do not close this requirement. Original notice gaps also block formal output. Preview archives and their historic evidence remain distinct from release candidates.

Formal packing additionally requires an explicit external native material directory: `bun scripts/pack.ts <product-stage> <fresh-runtime.tgz> <external-materials-root>`. Both roots must contain the same original small native binding index; expanded sources, toolchain inputs and raw evidence stay outside the product inventory. Inner source-kit hashes bind original JSON bytes. The independent outer material artifact later binds the actual closed runtime digest through central admission, without rewriting the runtime. This interface does not establish complete native materials or release readiness.


The normal `bun run stage` and `bun run pack` commands use the strict two-entry bundle receipt and the normal static-product receipt. Stage streams original materials directly into a bounded USTAR/gzip sourcekit. Pack replays the original source inventory and final byte budget before writing an archive. Missing or stale receipts reject before creating a new product. The sourcekit is not a runtime dependency directory. Original named terms and native source/toolchain gaps remain explicit; controlled previews retain `publishReady: false`. See [API bundle material contracts](../../docs/testing/api-bundle-materials.md). Small flow fixtures and negative command checks do not qualify a full API archive or replace the final independent consumer test.
