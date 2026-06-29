# Native-first RDF Physical Protocol Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Add the first native-first RDF physical backend protocol artifact: a stable C ABI header, header validator, and docs links for future PostgreSQL extension / QLever-compatible executor work.

**Architecture:** The protocol source of truth is a C ABI header under `native/postgres/rdf_protocol/include/`. TypeScript is used only for tests and validation tooling. The header defines opaque/native-safe value structs, callback tables, scan/search/stats/profile surfaces, and avoids QLever/C++ types at the boundary.

**Tech Stack:** C11-compatible ABI header, Vitest for repository tests, Node script for ABI/header checks, existing Bun test runner.

---

### Task 1: Header validation test

**Files:**
- Create: `tests/native/RdfPhysicalBackendProtocolHeader.test.ts`

- [x] **Step 1: Write failing tests for the native protocol header**

```ts
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(__dirname, '../..');
const headerPath = path.join(repoRoot, 'native/postgres/rdf_protocol/include/xpod_rdf_physical_backend.h');

function compiler(name: 'cc' | 'c++'): string | null {
  try {
    execFileSync('/usr/bin/env', [name, '--version'], { stdio: 'ignore' });
    return name;
  } catch {
    return null;
  }
}

describe('native RDF physical backend protocol header', () => {
  it('exists and exposes a native-first C ABI boundary', () => {
    expect(existsSync(headerPath)).toBe(true);
    const header = readFileSync(headerPath, 'utf8');

    expect(header).toContain('#define XPOD_RDF_PHYSICAL_BACKEND_ABI_VERSION 1');
    expect(header).toContain('extern "C"');
    expect(header).toContain('typedef struct xpod_rdf_backend_v1');
    expect(header).toContain('xpod_rdf_scan_permutation_fn');
    expect(header).toContain('xpod_rdf_text_search_fn');
    expect(header).toContain('xpod_rdf_vector_search_fn');
    expect(header).toContain('xpod_rdf_profile_event_callback');

    expect(header).not.toMatch(/std::|namespace\s+|template\s*</);
    expect(header).not.toMatch(/IndexImpl|PermutationPtr|RuntimeInformation|QLever/);
  });

  it('is consumable from C and C++ without exposing C++ ABI', async () => {
    const cc = compiler('cc');
    const cxx = compiler('c++');
    expect(cc, 'cc compiler is required for native ABI syntax check').toBeTruthy();
    expect(cxx, 'c++ compiler is required for native ABI syntax check').toBeTruthy();

    const root = await mkdtemp(path.join(os.tmpdir(), 'xpod-rdf-protocol-'));
    try {
      const source = `#include "native/postgres/rdf_protocol/include/xpod_rdf_physical_backend.h"\nint main(void) {\n  xpod_rdf_backend_v1 backend = {0};\n  backend.abi_version = XPOD_RDF_PHYSICAL_BACKEND_ABI_VERSION;\n  return backend.abi_version == 1 ? 0 : 1;\n}\n`;
      const cFile = path.join(root, 'check.c');
      const cppFile = path.join(root, 'check.cpp');
      await writeFile(cFile, source, 'utf8');
      await writeFile(cppFile, source, 'utf8');

      execFileSync(cc!, ['-std=c11', '-Wall', '-Wextra', '-Werror', '-I', repoRoot, '-fsyntax-only', cFile], { stdio: 'pipe' });
      execFileSync(cxx!, ['-std=c++17', '-Wall', '-Wextra', '-Werror', '-I', repoRoot, '-fsyntax-only', cppFile], { stdio: 'pipe' });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
```

- [x] **Step 2: Run test to verify it fails**

Run: `bun test tests/native/RdfPhysicalBackendProtocolHeader.test.ts --run`

Expected: FAIL because `native/postgres/rdf_protocol/include/xpod_rdf_physical_backend.h` does not exist.

### Task 2: Native C ABI header

**Files:**
- Create: `native/postgres/rdf_protocol/include/xpod_rdf_physical_backend.h`

- [x] **Step 1: Implement the minimal native protocol header**

Create a C11-compatible header with:

- ABI/version macros.
- `extern "C"` guard.
- fixed-width opaque handles (`uint64_t`).
- term/snapshot/quad/graph/access/source structs.
- permutation scan, count/distinct, stats, text search, vector search callbacks.
- execution profile callback shape.
- `xpod_rdf_backend_v1` function table.

- [x] **Step 2: Run header test to verify it passes**

Run: `bun test tests/native/RdfPhysicalBackendProtocolHeader.test.ts --run`

Expected: PASS.

### Task 3: ABI check script and package command

**Files:**
- Create: `scripts/check-rdf-physical-protocol-abi.cjs`
- Modify: `package.json`

- [x] **Step 1: Add script-level validator**

The script should:

- read the header;
- assert required symbols exist;
- assert forbidden C++/QLever-internal symbols do not exist;
- compile a tiny C and C++ translation unit if `cc` / `c++` are available.

- [x] **Step 2: Add package script**

Add:

```json
"check:rdf-protocol-abi": "node scripts/check-rdf-physical-protocol-abi.cjs"
```

- [x] **Step 3: Run script**

Run: `bun run check:rdf-protocol-abi`

Expected: PASS with an OK message.

### Task 4: Docs wiring

**Files:**
- Modify: `docs/superpowers/specs/2026-06-29-qlever-compatible-rdf-physical-backend-protocol-design.md`
- Modify: `docs/rdf-engine-spec.md` only if needed for the concrete header path.

- [x] **Step 1: Link the spec to the new header**

Add a short implementation artifact section pointing to:

```text
native/postgres/rdf_protocol/include/xpod_rdf_physical_backend.h
scripts/check-rdf-physical-protocol-abi.cjs
```

- [x] **Step 2: Verify docs and staged diff**

Run:

```bash
git diff --check
git status --short
```

Expected: only planned files changed, no whitespace errors.

### Task 5: Final verification and commit

**Files:** all changed files.

- [x] **Step 1: Run focused verification**

Run:

```bash
bun test tests/native/RdfPhysicalBackendProtocolHeader.test.ts --run
bun run check:rdf-protocol-abi
bun run build:ts
```

Expected: all pass.

- [x] **Step 2: Commit**

Use a lore commit message that records the native-first boundary and explicitly rejects TS-as-hot-protocol.

### Task 6: Native text candidate output columns

**Files:**
- Modify: `tests/native/QleverOperationPlanBridge.test.ts`
- Modify: `tests/native/qleverFakeHeaders.ts`
- Modify: `native/postgres/qlever_adapter/src/XpodQleverOperationBridge.hpp`
- Modify: `native/postgres/qlever_adapter/src/XpodQleverOperationPlanBridge.hpp`
- Modify: `native/postgres/qlever_adapter/src/XpodQleverPlanBridge.hpp`
- Modify: `docs/superpowers/specs/2026-06-29-qlever-compatible-rdf-physical-backend-protocol-design.md`

- [x] **Step 1: Write the failing native operation-plan test**

Change `tests/native/QleverOperationPlanBridge.test.ts` so variable `TextIndexScanForEntity("native-first")` must produce a native text candidate source instead of returning `std::nullopt`.

Expected shape:
- `root.kind == BridgeOperationKind::TextSearch`
- `result_width == 2`
- `output_variables == ["text", "entity"]`
- source output column `text` maps to `BridgeCandidateColumnKind::RetrievalPoint`
- source output column `entity` maps to `BridgeCandidateColumnKind::ResourceTerm`
- `toBridgePhysicalPlan(...)` preserves the source output columns.

- [x] **Step 2: Run test to verify it fails**

Run: `bun test tests/native/QleverOperationPlanBridge.test.ts --run`

Expected: FAIL because `BridgeTextCandidateSource` has no `output_columns` and `BridgeCandidateColumnKind` does not exist.

- [x] **Step 3: Implement candidate output column metadata**

Add to `native/postgres/qlever_adapter/src/XpodQleverOperationBridge.hpp`:
- `BridgeCandidateColumnKind`
- `BridgeCandidateOutputColumn`
- `BridgeTextCandidateSource::output_columns`

Add to `native/postgres/qlever_adapter/src/XpodQleverPlanBridge.hpp`:
- `bridgeVariableName(const Variable&)`

Update `native/postgres/qlever_adapter/src/XpodQleverOperationPlanBridge.hpp` so:
- `TextIndexScanForWord` emits the text record variable as a retrieval-point candidate column.
- fixed-entity `TextIndexScanForEntity` emits the text record variable and keeps `required_entities`.
- variable-entity `TextIndexScanForEntity` emits both text record and entity variables, mapping the entity to `ResourceTerm`.

- [x] **Step 4: Run target verification**

Run: `bun test tests/native/QleverOperationPlanBridge.test.ts --run`

Expected: PASS.

### Task 7: Candidate output column execution guard

**Files:**
- Modify: `tests/native/QleverCandidateOperationBridge.test.ts`
- Modify: `native/postgres/qlever_adapter/src/XpodQleverOperationExecutor.hpp`
- Modify: `docs/superpowers/specs/2026-06-29-qlever-compatible-rdf-physical-backend-protocol-design.md`

- [x] **Step 1: Write the failing native execution test**

Add a native smoke test where a text candidate source declares two output columns:
- `text` → `BridgeCandidateColumnKind::RetrievalPoint`
- `entity` → `BridgeCandidateColumnKind::ResourceTerm`

The backend returns a candidate row with `has_retrieval_point = 1` but without `has_resource_term`.

- [x] **Step 2: Run test to verify it fails**

Run: `bun test tests/native/QleverCandidateOperationBridge.test.ts --run`

Expected: FAIL because the current executor returns `XPOD_RDF_STATUS_OK` even though the declared entity/resource output is missing.

- [x] **Step 3: Implement native candidate output validation**

Add to `native/postgres/qlever_adapter/src/XpodQleverOperationExecutor.hpp`:
- `candidateRowHasOutputColumn(...)`
- `validateCandidateOutputColumns(...)`

Then make `executeBridgeTextCandidateSource(...)` validate rows after text candidate execution. It preserves returned candidate rows for diagnostics but changes status to `XPOD_RDF_STATUS_UNSUPPORTED` when a declared output channel is missing.

- [x] **Step 4: Run target verification**

Run: `bun test tests/native/QleverCandidateOperationBridge.test.ts --run`

Expected: PASS.

### Task 8: Cross-slot native HashJoin

**Files:**
- Modify: `tests/native/QleverOperationBridge.test.ts`
- Modify: `tests/native/QleverOperationPlanBridge.test.ts`
- Modify: `tests/native/qleverFakeHeaders.ts`
- Modify: `native/postgres/qlever_adapter/src/XpodQleverOperationBridge.hpp`
- Modify: `native/postgres/qlever_adapter/src/XpodQleverOperationExecutor.hpp`
- Modify: `native/postgres/qlever_adapter/src/XpodQleverOperationPlanBridge.hpp`
- Modify: `native/postgres/qlever_adapter/src/XpodQleverPlanBridge.hpp`
- Modify: `docs/superpowers/specs/2026-06-29-qlever-compatible-rdf-physical-backend-protocol-design.md`

- [x] **Step 1: Write the failing native execution test**

Add a `BridgePhysicalPlan` hash join where the left scan joins on object and the right scan joins on subject:

```sparql
{ ?s ?p ?mid . ?mid <urn:type> <urn:Thing> }
```

Expected: FAIL because `BridgeOperationPlan` only has one `join_slot` and cannot express a per-scan join column.

- [x] **Step 2: Write the failing operation-plan test**

Extend the fake QLever `IndexScan` shape so a smoke test can construct two `IndexScan` leaves with the common variable in different RDF slots.

Expected shape:
- `root.kind == BridgeOperationKind::HashJoin`
- `root.scan_indexes == [0, 1]`
- `root.join_slots == [XPOD_RDF_SLOT_OBJECT, XPOD_RDF_SLOT_SUBJECT]`
- legacy `root.join_slot == XPOD_RDF_SLOT_OBJECT`

Expected: FAIL because `BridgeOperationPlan` has no `join_slots`.

- [x] **Step 3: Implement per-scan join slots**

Add `BridgeOperationPlan::join_slots` as the native physical expression of the join key per scan. Keep `join_slot` as a compatibility fallback for existing hand-built plans.

Update operation planning so constrained `Join` trees flatten only when every leaf is an `IndexScan` and one common variable appears in every leaf. The planner records each scan's RDF slot for that variable.

Update native `HashJoin` execution so the right-side filter scans collect keys from their own join slot, while the primary scan filters on its own join slot.

- [x] **Step 4: Preserve parsed-BGP compatibility**

For parsed two-triple subject-filter fallback plans, set:

```cpp
root.join_slots = {XPOD_RDF_SLOT_SUBJECT, XPOD_RDF_SLOT_SUBJECT};
```

This keeps fallback parsed plans explicit without changing their semantics.

- [x] **Step 5: Run target verification**

Run:

```bash
bun test tests/native/QleverOperationBridge.test.ts --run
bun test tests/native/QleverOperationPlanBridge.test.ts --run
```

Expected: PASS.
