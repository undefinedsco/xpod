# Native-first RDF Physical Protocol Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Add the first native-first RDF physical backend protocol artifact: a stable C ABI header, header validator, and docs links for future PostgreSQL extension / QLever-compatible executor work.

**Architecture:** The protocol source of truth is a C ABI header under `native/postgres/rdf_protocol/include/`. TypeScript is used only for tests and validation tooling. The header defines opaque/native-safe value structs, callback tables, scan/search/stats/profile surfaces, and avoids QLever/C++ types at the boundary.

**Product boundary update (2026-07-01):** QLever-compatible native acceleration is **Cloud Enterprise-only**. Local deployments do not expose the QLever-compatible native adapter; local/native tests may compile or execute fixtures only as conformance gates for the Cloud Enterprise protocol, not as a local runtime feature.

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

### Task 9: Native HashJoin profile tree

**Files:**
- Modify: `tests/native/QleverOperationBridge.test.ts`
- Modify: `tests/native/QleverPlanBridge.test.ts`
- Modify: `native/postgres/qlever_adapter/src/XpodQleverOperationBridge.hpp`
- Modify: `native/postgres/qlever_adapter/src/XpodQleverOperationExecutor.hpp`
- Modify: `native/postgres/qlever_adapter/src/XpodQleverPlanBridge.hpp`
- Modify: `docs/superpowers/specs/2026-06-29-qlever-compatible-rdf-physical-backend-protocol-design.md`

- [x] **Step 1: Write the failing native execution profile test**

Extend the native HashJoin smoke test with a profile callback and a two-scan join plan where:
- root `BridgeOperationPlan.profile_node == 100`
- primary scan `profile_node == 101`, `parent_profile_node == 100`
- filter scan `profile_node == 102`, `parent_profile_node == 100`

Expected event sequence:
- `RDF_JOIN` running for node 100
- filter scan running/completed under parent 100
- primary scan running/completed under parent 100
- `RDF_JOIN` completed for node 100 with output row count

Expected: FAIL because `BridgeOperationPlan` has no root profile node and the executor does not emit root join events.

- [x] **Step 2: Implement native operation profile events**

Add root profile node fields to `BridgeOperationPlan` and make `executeBridgeHashJoin(...)` emit:
- `XPOD_RDF_PROFILE_RDF_JOIN` running before child scan execution
- `XPOD_RDF_PROFILE_RDF_JOIN` failed before error returns after execution starts
- `XPOD_RDF_PROFILE_RDF_JOIN` completed with output row count after filtering succeeds

- [x] **Step 3: Write the failing physical-plan profile tree test**

Extend the parsed plan bridge test so `toBridgePhysicalPlan(...)` for a parsed two-triple join produces:
- root profile node 1
- primary scan node 2, parent 1
- filter scan node 3, parent 1

Expected: FAIL because the converter only assigns profile nodes to scans and leaves the root unprofiled.

- [x] **Step 4: Implement physical profile tree generation**

Update `toBridgePhysicalPlan(...)` so `HashJoin` roots get profile node 1 and child scan adapters are assigned sequential nodes with `parent_profile_node = 1`. Keep single `PermutationScan` plans as direct scan profile nodes without an artificial root.

- [x] **Step 5: Run target verification**

Run:

```bash
bun test tests/native/QleverOperationBridge.test.ts --run
bun test tests/native/QleverPlanBridge.test.ts --run
```

Expected: PASS.

### Task 10: Text candidate to RDF scan join

**Files:**
- Modify: `tests/native/QleverOperationPlanBridge.test.ts`
- Modify: `tests/native/QleverOperationBridge.test.ts`
- Modify: `native/postgres/qlever_adapter/src/XpodQleverOperationBridge.hpp`
- Modify: `native/postgres/qlever_adapter/src/XpodQleverOperationPlanBridge.hpp`
- Modify: `native/postgres/qlever_adapter/src/XpodQleverOperationExecutor.hpp`
- Modify: `native/postgres/qlever_adapter/src/XpodQleverPlanBridge.hpp`
- Modify: `docs/superpowers/specs/2026-06-29-qlever-compatible-rdf-physical-backend-protocol-design.md`

- [x] **Step 1: Write the failing planner-output join test**

Add a native operation-plan smoke where a QLever-shaped
`Join(TextIndexScanForEntity("native-first"), IndexScan(?entity <urn:label> ?label))`
must produce a native `HashJoin` plan instead of returning unsupported.

Expected shape:
- `root.kind == BridgeOperationKind::HashJoin`
- `root.use_candidate_join == true`
- `root.candidate_join_column == BridgeCandidateColumnKind::ResourceTerm`
- `root.scan_indexes == [0]`
- `root.join_slots == [XPOD_RDF_SLOT_SUBJECT]`
- one text candidate source and one RDF scan
- profile tree root node 1, text node 2, scan node 3

Expected: FAIL because `BridgeOperationPlan` has no candidate join fields and `planTextJoinOperation(...)` only handles text-word plus fixed-entity joins.

- [x] **Step 2: Implement the planner mapping**

Add an opt-in candidate join shape to `BridgeOperationPlan`:

```cpp
bool use_candidate_join;
BridgeCandidateColumnKind candidate_join_column;
```

Then map the constrained text/RDF join only when the text side is a variable-entity `TextIndexScanForEntity` and the RDF `IndexScan` contains that entity variable in subject/predicate/object. The result remains an RDF scan projection filtered by candidate `ResourceTerm`; it is not yet a full QLever join projection that appends text columns.

- [x] **Step 3: Attach profile nodes for mixed candidate/RDF joins**

Update `toBridgePhysicalPlan(...)` so mixed candidate/RDF `HashJoin` roots attach the text source and scan under the same join root:

```text
HashJoin node 1
  TextSearch node 2
  PermutationScan node 3
```

- [x] **Step 4: Execute candidate-filtered RDF scan**

Extend native `HashJoin` execution with the opt-in candidate join path:
- execute the text candidate source;
- collect `ResourceTerm` keys from candidate rows;
- execute the RDF scan;
- filter scan rows by the configured scan slot;
- emit root `RDF_JOIN` profile events around the text and scan child nodes.

Unsupported candidate channels still fail closed.

- [x] **Step 5: Run target verification**

Run:

```bash
bun test tests/native/QleverOperationPlanBridge.test.ts --run
bun test tests/native/QleverOperationBridge.test.ts --run
```

Expected: PASS.

### Task 11: Typed candidate source joins

**Files:**
- Modify: `tests/native/QleverOperationBridge.test.ts`
- Modify: `native/postgres/qlever_adapter/src/XpodQleverOperationBridge.hpp`
- Modify: `native/postgres/qlever_adapter/src/XpodQleverOperationExecutor.hpp`
- Modify: `docs/superpowers/specs/2026-06-29-qlever-compatible-rdf-physical-backend-protocol-design.md`

- [x] **Step 1: Write the failing native execution test**

Extend the candidate/RDF HashJoin smoke so a vector candidate source that emits a `ResourceTerm` can filter one RDF `IndexScan` by subject.

Expected: FAIL because candidate HashJoin dispatch assumes the candidate source is always `text_sources[candidate_index]`.

- [x] **Step 2: Add typed candidate source selection**

Add `BridgeCandidateSourceKind::{Text, Vector}` and `BridgeOperationPlan::candidate_source`, defaulting to `Text` for compatibility with existing QLever text plans.

- [x] **Step 3: Dispatch candidate HashJoin through the selected source**

Route candidate HashJoin execution through a small typed dispatcher:
- `Text` -> `executeBridgeTextCandidateSource(...)`;
- `Vector` -> `executeBridgeVectorCandidateSource(...)`;
- invalid source/index -> fail closed with `XPOD_RDF_STATUS_UNSUPPORTED`.

The join filtering semantics stay the same: collect candidate keys from the configured candidate column, execute one RDF scan, and filter by the configured RDF slot.

- [x] **Step 4: Run target verification**

Run:

```bash
bun test tests/native/QleverOperationBridge.test.ts --run
```

Expected: PASS.

### Task 12: Candidate/RDF projection merge

**Files:**
- Modify: `tests/native/QleverOperationPlanBridge.test.ts`
- Modify: `tests/native/QleverOperationBridge.test.ts`
- Modify: `native/postgres/qlever_adapter/src/XpodQleverOperationBridge.hpp`
- Modify: `native/postgres/qlever_adapter/src/XpodQleverOperationPlanBridge.hpp`
- Modify: `native/postgres/qlever_adapter/src/XpodQleverOperationExecutor.hpp`
- Modify: `docs/superpowers/specs/2026-06-29-qlever-compatible-rdf-physical-backend-protocol-design.md`

- [x] **Step 1: Write the failing planner projection test**

Extend the QLever operation-plan smoke for `Join(TextIndexScanForEntity(variable), IndexScan(... ?entity ...))` so the bridge must preserve the candidate-side `text` variable and deduplicate the shared `entity` variable.

Expected output variables:
- `text` from the candidate retrieval point column;
- `entity`, `label` from the RDF scan columns.

Expected: FAIL because mixed candidate/RDF join previously returned only RDF scan variables.

- [x] **Step 2: Write the failing native execution projection test**

Extend the native candidate HashJoin smoke so a text candidate with `RetrievalPoint` + `ResourceTerm` projects the configured retrieval-point column before the RDF scan columns.

Expected: FAIL because candidate HashJoin previously used candidate rows only as a filter set and discarded candidate columns.

- [x] **Step 3: Add explicit candidate projection columns**

Add `BridgeOperationPlan::candidate_project_columns`. Planner-generated mixed joins populate it with candidate variables not already present in the RDF scan output, keeping common join variables deduplicated.

- [x] **Step 4: Merge candidate rows with scan rows during native execution**

Change candidate HashJoin execution from set-based filtering to keyed candidate rows:
- build candidate rows by join key;
- execute the RDF scan;
- for each matching scan row, prepend encoded candidate projection values;
- append the RDF scan row;
- shift scan sorted columns by the candidate projection width.

Projection values are encoded through the backend `encode_qlever_id`; projected candidate keys must be RDF-compatible keys for SPARQL serialization.

- [x] **Step 5: Run target verification**

Run:

```bash
bun test tests/native/QleverOperationPlanBridge.test.ts tests/native/QleverOperationBridge.test.ts --run
```

Expected: PASS.

### Task 13: RDF/RDF HashJoin projection merge

**Files:**
- Modify: `tests/native/QleverOperationPlanBridge.test.ts`
- Modify: `tests/native/QleverOperationBridge.test.ts`
- Modify: `native/postgres/qlever_adapter/src/XpodQleverOperationBridge.hpp`
- Modify: `native/postgres/qlever_adapter/src/XpodQleverOperationPlanBridge.hpp`
- Modify: `native/postgres/qlever_adapter/src/XpodQleverOperationExecutor.hpp`
- Modify: `docs/superpowers/specs/2026-06-29-qlever-compatible-rdf-physical-backend-protocol-design.md`

- [x] **Step 1: Write the failing planner projection test**

Extend the QLever operation-plan smoke for an RDF/RDF join:

```sparql
{ ?entity <urn:label> ?label . ?entity <urn:type> ?type }
```

Expected output variables:
- `entity`, `label` from the primary scan;
- `type` from the right scan;
- duplicate join variable `entity` is not emitted twice.

Expected native plan shape:
- `root.kind == BridgeOperationKind::HashJoin`
- `root.scan_project_slots == [[SUBJECT, OBJECT], [OBJECT]]`
- `result_width == 3`

Expected: FAIL because RDF/RDF joins previously kept only the left scan projection.

- [x] **Step 2: Write the failing native execution projection test**

Extend the native HashJoin smoke with a hand-built two-scan plan whose right scan matches by subject and projects object.

Expected output rows:
- primary subject/object columns;
- right object column appended for each matching right row.

Expected: FAIL because RDF/RDF HashJoin previously behaved as a semi-join filter and discarded right-side columns.

- [x] **Step 3: Add explicit scan projection slots**

Add `BridgeOperationPlan::scan_project_slots`, aligned with `scan_indexes`.

Planner-generated RDF/RDF joins populate:
- primary scan slots in output-variable order;
- each filter/right scan's non-duplicate variable slots;
- output variables and `result_width` from the merged projection.

Hand-built or legacy plans that omit `scan_project_slots` continue to use the old semi-join path.

- [x] **Step 4: Merge right scan projections during native execution**

Change the explicit-projection HashJoin path to:
- execute each right scan;
- group projected right rows by each scan's join key;
- execute the primary scan;
- for each primary row, append the cartesian combination of matching right projections;
- preserve the previous semi-join behavior when no explicit projection slots are present.

- [x] **Step 5: Run target verification**

Run:

```bash
bun test tests/native/QleverOperationPlanBridge.test.ts tests/native/QleverOperationBridge.test.ts --run
```

Expected: PASS.

### Task 14: Multi-key RDF/RDF HashJoin

**Files:**
- Modify: `tests/native/QleverOperationPlanBridge.test.ts`
- Modify: `tests/native/QleverOperationBridge.test.ts`
- Modify: `native/postgres/qlever_adapter/src/XpodQleverOperationBridge.hpp`
- Modify: `native/postgres/qlever_adapter/src/XpodQleverOperationPlanBridge.hpp`
- Modify: `native/postgres/qlever_adapter/src/XpodQleverOperationExecutor.hpp`
- Modify: `docs/superpowers/specs/2026-06-29-qlever-compatible-rdf-physical-backend-protocol-design.md`

- [x] **Step 1: Write the failing planner multi-key test**

Extend the QLever operation-plan smoke for a join with two shared variables:

```sparql
{ ?s ?p ?o . ?s ?p ?type }
```

Expected native plan shape:
- `root.kind == BridgeOperationKind::HashJoin`
- `root.join_key_slots == [[SUBJECT, PREDICATE], [SUBJECT, PREDICATE]]`
- `root.scan_project_slots == [[SUBJECT, PREDICATE, OBJECT], [OBJECT]]`
- output variables are `s`, `p`, `o`, `type`

Expected: FAIL because RDF/RDF joins previously had only one join slot per scan.

- [x] **Step 2: Write the failing native execution multi-key test**

Extend the native HashJoin smoke with a hand-built two-scan plan that joins by `(subject, predicate)` and projects the right object.

Expected output:
- one row for each matching `(subject, predicate)` tuple;
- right rows with the same subject but different predicate do not match.

Expected: FAIL because projected HashJoin previously keyed right rows by a single term.

- [x] **Step 3: Add explicit multi-key join slots**

Add `BridgeOperationPlan::join_key_slots`, aligned with `scan_indexes`.

Planner-generated RDF/RDF joins infer all common variables in canonical RDF slot order `S/P/O`, preserving the legacy `join_slot`/`join_slots` first-key fallback for existing call sites.

- [x] **Step 4: Execute projected HashJoin with tuple keys**

Change the explicit-projection HashJoin path to:
- decode a tuple join key from each scan row;
- group right scan projections by the tuple key;
- match primary rows against every right-side tuple group;
- keep legacy single-key fallback when `join_key_slots` is absent.

- [x] **Step 5: Run target verification**

Run:

```bash
bun test tests/native/QleverOperationPlanBridge.test.ts tests/native/QleverOperationBridge.test.ts --run
```

Expected: PASS.

### Task 15: Limit/Offset result modifier

**Files:**
- Modify: `tests/native/QleverOperationPlanBridge.test.ts`
- Modify: `tests/native/QleverOperationBridge.test.ts`
- Modify: `tests/native/qleverFakeHeaders.ts`
- Modify: `native/postgres/qlever_adapter/src/XpodQleverOperationBridge.hpp`
- Modify: `native/postgres/qlever_adapter/src/XpodQleverOperationPlanBridge.hpp`
- Modify: `native/postgres/qlever_adapter/src/XpodQleverOperationExecutor.hpp`
- Modify: `docs/superpowers/specs/2026-06-29-qlever-compatible-rdf-physical-backend-protocol-design.md`

- [x] **Step 1: Write the failing planner Limit/Offset test**

Extend the QLever operation-plan smoke with a QLever-shaped `LimitOffset`
operation above an `IndexScan`.

Expected native plan shape:
- child root stays `BridgeOperationKind::PermutationScan`;
- `root.has_limit == true`;
- `root.limit` and `root.offset` preserve the modifier values;
- output variables still come from the child operation.

Expected: FAIL because the bridge previously had no modifier slot on the
physical root.

- [x] **Step 2: Write the failing native execution Limit/Offset test**

Extend the native operation executor smoke with a hand-built permutation scan
that returns multiple rows and a root-level limit/offset modifier.

Expected output:
- executor still runs the scan once;
- result rows are sliced after the supported scan root;
- sorted columns are preserved.

Expected: FAIL because scan/join execution previously returned the full table.

- [x] **Step 3: Add a root-level result modifier**

Add `BridgeOperationPlan::has_limit`, `limit`, and `offset`.

This is deliberately an internal physical-plan modifier, not a new public C ABI
operation. It composes over already-supported RDF roots and keeps the hot
protocol stable.

- [x] **Step 4: Plan and execute the modifier**

When the embedded QLever build exposes `engine/LimitOffset.h`, map
`LimitOffset(child, limit, offset)` to the child's `BridgeQueryPlan` and attach
the modifier to the child root.

After executing supported RDF roots (`PermutationScan` / `HashJoin`), slice the
`IdTable` by offset and limit before returning the QLever `Result`.

- [x] **Step 5: Run target verification**

Run:

```bash
bun test tests/native/QleverOperationPlanBridge.test.ts tests/native/QleverOperationBridge.test.ts --run
```

Expected: PASS.

### Task 16: Distinct result modifier

**Files:**
- Modify: `tests/native/QleverOperationPlanBridge.test.ts`
- Modify: `tests/native/QleverOperationBridge.test.ts`
- Modify: `tests/native/qleverFakeHeaders.ts`
- Modify: `native/postgres/qlever_adapter/src/XpodQleverOperationBridge.hpp`
- Modify: `native/postgres/qlever_adapter/src/XpodQleverOperationPlanBridge.hpp`
- Modify: `native/postgres/qlever_adapter/src/XpodQleverOperationExecutor.hpp`
- Modify: `docs/superpowers/specs/2026-06-29-qlever-compatible-rdf-physical-backend-protocol-design.md`

- [x] **Step 1: Confirm upstream operation shape**

Use upstream QLever headers as the source of truth.

`Distinct.h` exposes:
- `Distinct` as an `Operation`;
- one child through `getChildren()`;
- distinct key columns through `getDistinctColumns()`;
- sortedness inherited from the child.

- [x] **Step 2: Write the failing planner Distinct test**

Extend the operation-plan smoke with `Distinct(IndexScan(...), {0, 2})`.

Expected native plan shape:
- child root stays `BridgeOperationKind::PermutationScan`;
- `root.has_distinct == true`;
- `root.distinct_columns == [0, 2]`;
- `root.result_modifiers` records one `Distinct` modifier;
- child output variables are preserved.

Expected: FAIL because the bridge previously had no distinct modifier.

- [x] **Step 3: Write the failing native execution Distinct test**

Extend the operation executor smoke with a scan returning multiple rows that
share one projected column and a distinct modifier over that column.

Expected output:
- executor still runs the scan once;
- duplicate keys are removed while keeping the first matching row;
- sorted columns are preserved.

Expected: FAIL because execution previously returned all scan rows.

- [x] **Step 4: Add ordered result modifiers**

Add internal `BridgeResultModifier` records so QLever result modifiers can be
preserved in tree order. Keep the existing `has_limit` hand-built fields as
compatibility shims for tests and older internal callers, but let
planner-generated `LimitOffset` and `Distinct` append ordered modifiers.

- [x] **Step 5: Plan and execute Distinct**

When the embedded QLever build exposes `engine/Distinct.h`, map
`Distinct(child, columns)` to the child's `BridgeQueryPlan` and append a
`Distinct` result modifier.

Execution applies ordered modifiers after supported RDF roots. Distinct fails
closed on invalid column indexes and otherwise keeps the first row for each
distinct key tuple.

- [x] **Step 6: Run target verification**

Run:

```bash
bun test tests/native/QleverOperationPlanBridge.test.ts tests/native/QleverOperationBridge.test.ts --run
```

Expected: PASS.

### Task 17: OrderBy result modifier

**Files:**
- Modify: `tests/native/QleverOperationPlanBridge.test.ts`
- Modify: `tests/native/QleverOperationBridge.test.ts`
- Modify: `tests/native/qleverFakeHeaders.ts`
- Modify: `native/postgres/qlever_adapter/src/XpodQleverOperationBridge.hpp`
- Modify: `native/postgres/qlever_adapter/src/XpodQleverOperationPlanBridge.hpp`
- Modify: `native/postgres/qlever_adapter/src/XpodQleverOperationExecutor.hpp`
- Modify: `docs/superpowers/specs/2026-06-29-qlever-compatible-rdf-physical-backend-protocol-design.md`

- [x] **Step 1: Confirm upstream operation shape**

Use upstream QLever headers as the source of truth.

`OrderBy.h` exposes:
- `OrderBy` as an `Operation`;
- one child through `getChildren()`;
- public `getSortedVariables()` returning `(Variable, Asc|Desc)`;
- `resultSortedOn() == {}` because semantic user-facing ordering is not the
  same as internal ID sortedness.

`Sort.h` exposes the internal sort columns through public `resultSortedOn()`,
but it is a different operation from `OrderBy`: `Sort` uses QLever's internal
ID order, while `OrderBy` represents user-facing semantic value ordering.

- [x] **Step 2: Write the failing planner OrderBy test**

Extend the operation-plan smoke with
`OrderBy(IndexScan(...), [(?o, Desc), (?s, Asc)])`.

Expected native plan shape:
- child root stays `BridgeOperationKind::PermutationScan`;
- `root.result_modifiers` records one `OrderBy` modifier;
- modifier columns map variables to output columns `[2, 0]`;
- modifier descending flags are `[true, false]`;
- child output variables are preserved;
- `sorted_by` is cleared.

Expected: FAIL because the bridge previously had no OrderBy modifier.

- [x] **Step 3: Write the failing native execution OrderBy test**

Extend the operation executor smoke with a scan returning multiple rows and an
ordered modifier over `(object DESC, subject ASC)`.

Expected output:
- executor still runs the scan once;
- rows are stably sorted by the configured columns;
- returned internal `sortedBy` is empty, matching QLever `OrderBy` semantics.

Expected: FAIL because execution previously had no ordered sort modifier.

- [x] **Step 4: Add OrderBy modifier state**

Add `BridgeResultModifierKind::OrderBy` and per-key `descending` flags on
`BridgeResultModifier`.

- [x] **Step 5: Plan and execute OrderBy**

When the embedded QLever build exposes `engine/OrderBy.h`, map
`OrderBy(child, sorted variables)` to the child's `BridgeQueryPlan`, resolve
variables against `output_variables`, append an `OrderBy` result modifier, and
clear `sorted_by`.

Execution applies a stable native sort over the produced `IdTable` using the
configured column order and direction. This is a native bridge step toward
QLever composition; full SPARQL semantic term comparison remains a later
dictionary / ValueId comparator integration.

- [x] **Step 6: Run target verification**

Run:

```bash
bun test tests/native/QleverOperationPlanBridge.test.ts tests/native/QleverOperationBridge.test.ts --run
```

Expected: PASS.

### Task 18: Sort internal result modifier

**Files:**
- Modify: `tests/native/QleverOperationPlanBridge.test.ts`
- Modify: `tests/native/QleverOperationBridge.test.ts`
- Modify: `tests/native/qleverFakeHeaders.ts`
- Modify: `native/postgres/qlever_adapter/src/XpodQleverOperationBridge.hpp`
- Modify: `native/postgres/qlever_adapter/src/XpodQleverOperationPlanBridge.hpp`
- Modify: `native/postgres/qlever_adapter/src/XpodQleverOperationExecutor.hpp`
- Modify: `docs/superpowers/specs/2026-06-29-qlever-compatible-rdf-physical-backend-protocol-design.md`

- [x] **Step 1: Confirm upstream operation shape**

Use upstream QLever `Sort.h` as the source of truth.

`Sort` exposes:
- one child through `getChildren()`;
- internal sorted columns through public `resultSortedOn()`;
- ID-based internal sort semantics, not SPARQL `ORDER BY` semantic value
  comparison.

- [x] **Step 2: Write the failing planner Sort test**

Extend the operation-plan smoke with `Sort(IndexScan(...), [2, 0])`.

Expected native plan shape:
- child root stays `BridgeOperationKind::PermutationScan`;
- `root.result_modifiers` records one `InternalSort` modifier;
- modifier columns are `[2, 0]`;
- `sorted_by` is updated to `[2, 0]`;
- output variables are preserved.

Expected: FAIL because the bridge previously had no internal Sort modifier.

- [x] **Step 3: Write the failing native execution Sort test**

Extend the operation executor smoke with an intentionally unsorted scan and an
internal sort modifier over the subject column.

Expected output:
- executor still runs the scan once;
- rows are stably sorted by encoded QLever id bits in ascending order;
- returned internal `sortedBy` records the sort columns.

Expected: FAIL because execution previously had no internal sort modifier.

- [x] **Step 4: Plan and execute Sort**

When the embedded QLever build exposes `engine/Sort.h`, map
`Sort(child, columns)` to the child's `BridgeQueryPlan`, append an
`InternalSort` result modifier, and set `sorted_by` to the sort columns.

Execution applies a stable ascending native sort over encoded QLever id bits.
This intentionally models QLever's internal `Sort`, not SPARQL `OrderBy`.

- [x] **Step 5: Run target verification**

Run:

```bash
bun test tests/native/QleverOperationPlanBridge.test.ts tests/native/QleverOperationBridge.test.ts --run
```

Expected: PASS.

### Task 19: TextLimit pushdown for text candidate roots

**Files:**
- Modify: `tests/native/QleverOperationPlanBridge.test.ts`
- Modify: `tests/native/qleverFakeHeaders.ts`
- Modify: `native/postgres/qlever_adapter/src/XpodQleverOperationPlanBridge.hpp`
- Modify: `docs/superpowers/specs/2026-06-29-qlever-compatible-rdf-physical-backend-protocol-design.md`

- [x] **Step 1: Confirm upstream operation shape**

Use upstream QLever `TextLimit.h` as the source of truth.

`TextLimit` exposes:
- a text limit through public `getTextLimit()`;
- one child through the normal `Operation::getChildren()` virtual seam.

The first bridge increment only supports `TextLimit` above a native text
candidate root. More complex `TextLimit` shapes that require per-entity
combination limiting fail closed instead of pretending to be supported.

- [x] **Step 2: Write the failing planner TextLimit test**

Extend the operation-plan smoke with
`TextLimit(TextIndexScanForWord("native-first"), limit=5)`.

Expected native plan shape:
- child root stays `BridgeOperationKind::TextSearch`;
- the child text candidate source remains the only text source;
- `text_sources[0].request.limit == 5`;
- the physical plan preserves the same text request limit.

Expected: FAIL because the bridge previously did not plan `TextLimit`.

- [x] **Step 3: Plan TextLimit as text-search request limit**

When the embedded QLever build exposes `engine/TextLimit.h`, map
`TextLimit(child)` to the child's `BridgeQueryPlan` only if the child root is a
native `TextSearch` candidate root. Set the selected text candidate source's
request limit from `getTextLimit()`.

- [x] **Step 4: Run target verification**

Run:

```bash
bun test tests/native/QleverOperationPlanBridge.test.ts --run
```

Expected: PASS.

### Task 20: NeutralElementOperation leaf

**Files:**
- Modify: `tests/native/QleverOperationPlanBridge.test.ts`
- Modify: `tests/native/QleverOperationBridge.test.ts`
- Modify: `tests/native/qleverFakeHeaders.ts`
- Modify: `native/postgres/qlever_adapter/src/XpodQleverOperationBridge.hpp`
- Modify: `native/postgres/qlever_adapter/src/XpodQleverOperationPlanBridge.hpp`
- Modify: `native/postgres/qlever_adapter/src/XpodQleverOperationExecutor.hpp`
- Modify: `docs/superpowers/specs/2026-06-29-qlever-compatible-rdf-physical-backend-protocol-design.md`

- [x] **Step 1: Confirm upstream operation shape**

Use upstream QLever `NeutralElementOperation.h` as the source of truth.

`NeutralElementOperation` exposes:
- no children through `getChildren()`;
- `getResultWidth() == 0`;
- empty `resultSortedOn()`;
- an execution result containing one zero-width row.

- [x] **Step 2: Write the failing planner and executor tests**

Extend the operation-plan smoke with a `NeutralElementOperation` leaf.

Expected native plan shape:
- `root.kind == BridgeOperationKind::NeutralElement`;
- result width is `0`;
- output variables are empty;
- the physical plan has no scans.

Extend the operation executor smoke with a hand-built neutral root.

Expected execution:
- no backend scan is invoked;
- result status is OK;
- result table has width `0` and one row;
- sorted columns are empty.

Expected: FAIL because the bridge previously had no neutral-element root.

- [x] **Step 3: Plan and execute NeutralElementOperation**

When the embedded QLever build exposes `engine/NeutralElementOperation.h`, map
the operation to a `NeutralElement` root and use the upstream descriptor.

Execution materializes an empty-width `IdTable` with one row and no sorted
columns.

- [x] **Step 4: Run target verification**

Run:

```bash
bun test tests/native/QleverOperationPlanBridge.test.ts tests/native/QleverOperationBridge.test.ts --run
```

Expected: PASS.

### Task 21: Union operation over supported child plans

**Files:**
- Modify: `tests/native/QleverOperationPlanBridge.test.ts`
- Modify: `tests/native/QleverOperationBridge.test.ts`
- Modify: `tests/native/qleverFakeHeaders.ts`
- Modify: `native/postgres/qlever_adapter/src/XpodQleverOperationBridge.hpp`
- Modify: `native/postgres/qlever_adapter/src/XpodQleverPlanBridge.hpp`
- Modify: `native/postgres/qlever_adapter/src/XpodQleverOperationPlanBridge.hpp`
- Modify: `native/postgres/qlever_adapter/src/XpodQleverOperationExecutor.hpp`
- Modify: `docs/superpowers/specs/2026-06-29-qlever-compatible-rdf-physical-backend-protocol-design.md`

- [x] **Step 1: Confirm upstream operation shape**

Use upstream QLever `Union.h` as the source of truth.

`Union` exposes:
- `leftChild()` and `rightChild()` as public child accessors;
- `getOriginalColumn(leftChild, unionColumn)` for output-column origins;
- `resultSortedOn()` / `getResultSortedOn()` for target sortedness;
- `getResultWidth()` and `getDescriptor()`.

- [x] **Step 2: Write failing planner and executor tests**

Extend the operation-plan smoke with a two-child `Union` where both children are
already supported `IndexScan` roots.

Expected native plan shape:
- `root.kind == BridgeOperationKind::Union`;
- query-plan children are kept as pre-binding child plans;
- physical-plan children are flattened into shared scan storage with adjusted
  child scan indexes;
- `column_origins` records the left/right source column for each union output
  column;
- sortedness is preserved on the union root.

Extend the operation executor smoke with a hand-built union root over two scan
children.

Expected execution:
- both child scans execute;
- rows from the left child are emitted first, followed by rows from the right
  child;
- the result is not deduplicated; `Distinct` remains the operation that removes
  duplicates;
- sortedness is preserved from the union root.

Expected: FAIL because the bridge previously had no tree-shaped children or
union root.

- [x] **Step 3: Add recursive child-plan support and constrained Union**

Add `BridgeQueryPlan.child_plans` so term binding and request-context propagation
can run before physical flattening. Flatten child physical plans into shared
scan/candidate storage and offset child indexes during `toBridgePhysicalPlan`.

When the embedded QLever build exposes `engine/Union.h`, map `Union` to a native
root if both child plans have complete output-column mappings. The first version
only accepted complete mappings; Task 25 adds missing-column / `UNDEF` padding
without changing the child-plan boundary.

Execution recursively evaluates the two child roots and appends rows according
to `column_origins`.

- [x] **Step 4: Run target verification**

Run:

```bash
bun test tests/native/QleverOperationPlanBridge.test.ts tests/native/QleverOperationBridge.test.ts --run
```

Expected: PASS.

### Task 22: CartesianProductJoin over supported child plans

**Files:**
- Modify: `tests/native/QleverOperationPlanBridge.test.ts`
- Modify: `tests/native/QleverOperationBridge.test.ts`
- Modify: `tests/native/qleverFakeHeaders.ts`
- Modify: `native/postgres/qlever_adapter/src/XpodQleverOperationBridge.hpp`
- Modify: `native/postgres/qlever_adapter/src/XpodQleverOperationPlanBridge.hpp`
- Modify: `native/postgres/qlever_adapter/src/XpodQleverOperationExecutor.hpp`
- Modify: `docs/superpowers/specs/2026-06-29-qlever-compatible-rdf-physical-backend-protocol-design.md`

- [x] **Step 1: Confirm upstream operation shape**

Use upstream QLever `CartesianProductJoin.h` as the source of truth.

`CartesianProductJoin` exposes:
- child access through `getChildren()`;
- `getResultWidth()` and `getDescriptor()`;
- empty sortedness by default through `getResultSortedOn()`.

- [x] **Step 2: Write failing planner and executor tests**

Extend the operation-plan smoke with a two-child `CartesianProductJoin` whose
children are supported `IndexScan` roots.

Expected native plan shape:
- `root.kind == BridgeOperationKind::CartesianProductJoin`;
- query-plan children are kept as pre-binding child plans;
- output variables are concatenated in child order;
- physical-plan children are flattened into shared scan storage with adjusted
  child scan indexes.

Extend the operation executor smoke with a hand-built Cartesian root over two
scan children.

Expected execution:
- every child scan executes once;
- output rows are the full Cartesian product in child order;
- output columns are concatenated in child order;
- sortedness is empty unless a future modifier supplies it.

Expected: FAIL because the bridge previously had no Cartesian root.

- [x] **Step 3: Plan and execute CartesianProductJoin**

When the embedded QLever build exposes `engine/CartesianProductJoin.h`, map the
operation to a native tree root and reuse the existing child-plan boundary.
Execution recursively evaluates all children and materializes the product by
concatenating row columns.

- [x] **Step 4: Run target verification**

Run:

```bash
bun test tests/native/QleverOperationPlanBridge.test.ts tests/native/QleverOperationBridge.test.ts --run
```

Expected: PASS.

### Task 23: Minus over supported child plans

**Files:**
- Modify: `tests/native/QleverOperationPlanBridge.test.ts`
- Modify: `tests/native/QleverOperationBridge.test.ts`
- Modify: `tests/native/qleverFakeHeaders.ts`
- Modify: `native/postgres/qlever_adapter/src/XpodQleverOperationBridge.hpp`
- Modify: `native/postgres/qlever_adapter/src/XpodQleverOperationPlanBridge.hpp`
- Modify: `native/postgres/qlever_adapter/src/XpodQleverOperationExecutor.hpp`
- Modify: `docs/superpowers/specs/2026-06-29-qlever-compatible-rdf-physical-backend-protocol-design.md`

- [x] **Step 1: Confirm upstream operation shape**

Use upstream QLever `Minus.h` as the source of truth.

`Minus` exposes:
- child access through `getChildren()`;
- left-result width and descriptor through public `Operation` methods;
- result sortedness through `getResultSortedOn()`;
- no public accessor for the internal `_matchedColumns` vector.

The bridge therefore derives matched columns from the two child plans'
`output_variables` instead of reaching into QLever private state.

- [x] **Step 2: Write failing planner and executor tests**

Extend the operation-plan smoke with a two-child `Minus` where the left and
right child share `?entity`.

Expected native plan shape:
- `root.kind == BridgeOperationKind::Minus`;
- query-plan children are kept as pre-binding child plans;
- result variables and width come from the left child;
- `root.matched_columns` records the shared variable column pair;
- physical-plan children are flattened into shared scan storage with adjusted
  child scan indexes.

Extend the operation executor smoke with a hand-built Minus root over two scan
children.

Expected execution:
- both child scans execute once;
- rows from the left side that have a right-side match on all matched columns
  are removed;
- rows without a match are preserved with their original left-side columns;
- if no variables are shared, MINUS preserves the left side.

Expected: FAIL because the bridge previously had no Minus root or matched
column expression.

- [x] **Step 3: Plan and execute Minus**

When the embedded QLever build exposes `engine/Minus.h`, map the operation to a
native tree root and reuse the existing child-plan boundary. Execution
recursively evaluates the two children and performs an exact-id anti-join over
`matched_columns`.

This first implementation compares encoded QLever id bits. Full SPARQL value
comparison semantics, if needed for non-dictionary local values, belong to the
later ValueId comparator integration.

- [x] **Step 4: Run target verification**

Run:

```bash
bun test tests/native/QleverOperationPlanBridge.test.ts tests/native/QleverOperationBridge.test.ts --run
```

Expected: PASS.

### Task 24: OptionalJoin over supported child plans

**Files:**
- Modify: `tests/native/QleverOperationPlanBridge.test.ts`
- Modify: `tests/native/QleverOperationBridge.test.ts`
- Modify: `tests/native/qleverFakeHeaders.ts`
- Modify: `native/postgres/qlever_adapter/src/XpodQleverOperationBridge.hpp`
- Modify: `native/postgres/qlever_adapter/src/XpodQleverOperationPlanBridge.hpp`
- Modify: `native/postgres/qlever_adapter/src/XpodQleverOperationExecutor.hpp`
- Modify: `docs/superpowers/specs/2026-06-29-qlever-compatible-rdf-physical-backend-protocol-design.md`

- [x] **Step 1: Confirm upstream operation shape**

Use upstream QLever `OptionalJoin.h` as the source of truth.

`OptionalJoin` exposes:
- child access through `getChildren()`;
- result width, descriptor, and sortedness through public `Operation` methods;
- no public accessor for the internal join-column vector or `keepJoinColumns_`.

The bridge therefore derives the join columns from shared output variable names
and derives the right-side projected columns from variables that do not already
exist on the left side. If the inferred output shape does not match
`getResultWidth()`, the shape fails closed.

- [x] **Step 2: Write failing planner and executor tests**

Extend the operation-plan smoke with a two-child `OptionalJoin` where the left
and right child share `?entity` and the right child contributes `?nick`.

Expected native plan shape:
- `root.kind == BridgeOperationKind::OptionalJoin`;
- query-plan children are kept as pre-binding child plans;
- result variables start with the left child and append right-side non-duplicate
  variables;
- `root.matched_columns` records the shared variable column pair;
- `root.right_projection_columns` records right-side columns that must be
  appended;
- physical-plan children are flattened into shared scan storage with adjusted
  child scan indexes.

Extend the operation executor smoke with a hand-built OptionalJoin root over two
scan children where only one left row has a right-side match.

Expected execution:
- both child scans execute once;
- matching right rows append projected right columns to the left row;
- unmatched left rows append QLever `UNDEF` ids for each projected right column;
- if no variables are shared, the join degenerates to a Cartesian optional
  product, with UNDEF padding when the right side is empty.

Expected: FAIL because the bridge previously had no OptionalJoin root or
right-side projection expression.

- [x] **Step 3: Plan and execute OptionalJoin**

When the embedded QLever build exposes `engine/OptionalJoin.h`, map the
operation to a native tree root and reuse the existing child-plan boundary.
Execution recursively evaluates both children and materializes a left outer join
over `matched_columns`, appending `Id::makeUndefined()` for missing optional
right-side values.

- [x] **Step 4: Run target verification**

Run:

```bash
bun test tests/native/QleverOperationPlanBridge.test.ts tests/native/QleverOperationBridge.test.ts --run
```

Expected: PASS.

### Task 25: Union missing-column UNDEF padding

**Files:**
- Modify: `tests/native/QleverOperationPlanBridge.test.ts`
- Modify: `tests/native/QleverOperationBridge.test.ts`
- Modify: `native/postgres/qlever_adapter/src/XpodQleverOperationBridge.hpp`
- Modify: `native/postgres/qlever_adapter/src/XpodQleverOperationPlanBridge.hpp`
- Modify: `native/postgres/qlever_adapter/src/XpodQleverOperationExecutor.hpp`
- Modify: `docs/superpowers/specs/2026-06-29-qlever-compatible-rdf-physical-backend-protocol-design.md`

- [x] **Step 1: Write failing planner and executor tests**

Extend the operation-plan smoke with a `Union` whose result has three variables:
`?entity`, `?name`, and `?nick`. The left child contributes `?entity ?name` and
has no `?nick`; the right child contributes `?entity ?nick` and has no `?name`.

Expected native plan shape:
- `root.kind == BridgeOperationKind::Union`;
- `result_width == 3`;
- output variables are inferred from whichever child has a column for that union
  output slot;
- missing child columns are recorded as `BRIDGE_NO_COLUMN` instead of rejecting
  the operation.

Extend the operation executor smoke with a hand-built sparse-column Union root.

Expected execution:
- both child scans execute once;
- rows from the left child append `UNDEF` for the missing right-only variable;
- rows from the right child append `UNDEF` for the missing left-only variable;
- sortedness remains the Union root sortedness.

Expected: FAIL because the bridge previously treated missing union columns as an
unsupported shape.

- [x] **Step 2: Add a native missing-column sentinel**

Add `BRIDGE_NO_COLUMN` to the native operation bridge metadata. Keep the value as
`static_cast<size_t>(-1)` so it is cheap to store in the existing
`column_origins` pair without widening the ABI-facing internal plan shape.

- [x] **Step 3: Plan and execute sparse Union columns**

`planUnionOperation(...)` accepts any union column with at least one child origin.
If both children provide an origin, their output variable names must match. If
only one child provides an origin, the planner uses that child's variable name
and records `BRIDGE_NO_COLUMN` for the missing side.

`appendBridgeUnionRows(...)` materializes `BRIDGE_NO_COLUMN` as
`bridgeUndefinedId()` and otherwise keeps the existing column-bounds check.

- [x] **Step 4: Run target verification**

Run:

```bash
bun test tests/native/QleverOperationPlanBridge.test.ts tests/native/QleverOperationBridge.test.ts --run
```

Expected: PASS.

### Task 26: GroupBy without aggregate aliases

**Files:**
- Modify: `tests/native/QleverOperationPlanBridge.test.ts`
- Modify: `tests/native/QleverOperationBridge.test.ts`
- Modify: `tests/native/qleverFakeHeaders.ts`
- Modify: `native/postgres/qlever_adapter/src/XpodQleverOperationBridge.hpp`
- Modify: `native/postgres/qlever_adapter/src/XpodQleverOperationPlanBridge.hpp`
- Modify: `native/postgres/qlever_adapter/src/XpodQleverOperationExecutor.hpp`
- Modify: `docs/superpowers/specs/2026-06-29-qlever-compatible-rdf-physical-backend-protocol-design.md`

- [x] **Step 1: Write failing planner and executor tests**

Extend the fake QLever headers with a public `GroupBy` shape exposing
`groupByVariables()`, `aliases()`, and `getChildren()`.

Extend the operation-plan smoke with `GroupBy(child, {?category})` above a
supported child `IndexScan`.

Expected native plan shape:
- `root.kind == BridgeOperationKind::GroupBy`;
- one child plan is preserved through `toBridgePhysicalPlan(...)`;
- `result_width == groupByVariables().size()`;
- `root.projection_columns` maps group-key variables to child output columns.

Extend the operation executor smoke with a hand-built GroupBy root over a scan
that returns duplicate category ids.

Expected execution:
- the child scan executes once;
- the output projects only group-key columns;
- duplicate exact-id group tuples are removed while preserving first-seen order.

Expected: FAIL because the bridge previously had no GroupBy operation root.

- [x] **Step 2: Add the native GroupBy root metadata**

Add `BridgeOperationKind::GroupBy` and `BridgeOperationPlan::projection_columns`
to the internal native operation plan. This stays outside the public C ABI.

- [x] **Step 3: Plan and execute the no-alias GroupBy subset**

When the embedded QLever build exposes `engine/GroupBy.h`, map only the safe
public subset where `aliases().empty()` is true. Aggregate aliases still fail
closed because aggregate value semantics require QLever's richer GroupByImpl
state.

Execution recursively evaluates the child root, projects configured group-key
columns, and deduplicates exact encoded QLever id tuples.

- [x] **Step 4: Run target verification**

Run:

```bash
bun test tests/native/QleverOperationPlanBridge.test.ts tests/native/QleverOperationBridge.test.ts --run
```

Expected: PASS.

### Task 27: MultiColumnJoin over supported child roots

**Files:**
- Modify: `tests/native/QleverOperationPlanBridge.test.ts`
- Modify: `tests/native/QleverOperationBridge.test.ts`
- Modify: `tests/native/qleverFakeHeaders.ts`
- Modify: `native/postgres/qlever_adapter/src/XpodQleverOperationBridge.hpp`
- Modify: `native/postgres/qlever_adapter/src/XpodQleverOperationPlanBridge.hpp`
- Modify: `native/postgres/qlever_adapter/src/XpodQleverOperationExecutor.hpp`
- Modify: `docs/superpowers/specs/2026-06-29-qlever-compatible-rdf-physical-backend-protocol-design.md`

- [x] **Step 1: Write failing planner and executor tests**

Extend the fake QLever headers with a public `MultiColumnJoin` shape exposing
`getChildren()` and `getResultWidth()`.

Extend the operation-plan smoke with a join whose children share two variables:
`?entity` and `?category`. The left child contributes `?name`; the right child
contributes `?score`.

Expected native plan shape:
- `root.kind == BridgeOperationKind::MultiColumnJoin`;
- both child plans are preserved through `toBridgePhysicalPlan(...)`;
- `matched_columns` contains both shared-variable column pairs;
- `right_projection_columns` contains only right-side non-duplicate variables;
- output variables are `?entity`, `?category`, `?name`, `?score`.

Extend the operation executor smoke with a hand-built MultiColumnJoin root over
two scans where only rows matching both configured key columns are joined.

Expected: FAIL because the bridge previously had no MultiColumnJoin operation
root.

- [x] **Step 2: Add native MultiColumnJoin metadata**

Add `BridgeOperationKind::MultiColumnJoin` to the internal native operation plan
and profile it as `RDF_JOIN`. This stays outside the public C ABI.

- [x] **Step 3: Plan and execute exact-id inner joins**

When the embedded QLever build exposes `engine/MultiColumnJoin.h`, map the
operation by using only public child metadata. Derive shared-variable columns
from the child output variable lists and reject shapes with no shared variables.

Execution recursively evaluates both child roots, compares all configured
matched columns by encoded QLever id bits, appends the left row plus configured
right projection columns, and preserves root result modifiers.

- [x] **Step 4: Run target verification**

Run:

```bash
bun test tests/native/QleverOperationPlanBridge.test.ts tests/native/QleverOperationBridge.test.ts --run
```

Expected: PASS.

### Task 28: QLever term-order contract for native scans

**Files:**
- Modify: `tests/native/RdfPhysicalBackendProtocolHeader.test.ts`
- Modify: `tests/native/QleverBackedIndexScan.test.ts`
- Modify: `native/postgres/rdf_protocol/include/xpod_rdf_physical_backend.h`
- Modify: `native/postgres/qlever_adapter/src/XpodPhysicalBackend.hpp`
- Modify: `native/postgres/qlever_adapter/src/XpodBackedIndexScan.hpp`
- Modify: `scripts/check-rdf-physical-protocol-abi.cjs`
- Modify: `docs/superpowers/specs/2026-06-29-qlever-compatible-rdf-physical-backend-protocol-design.md`

- [x] **Step 1: Write failing protocol and adapter tests**

Add protocol-header expectations for `xpod_rdf_qlever_term_ordering` and
`XPOD_RDF_QLEVER_TERM_ORDER_PRESERVED`. Extend the Xpod-backed IndexScan smoke
with an opaque custom encoder that reverses term order.

Expected: FAIL because the public ABI has no term-order contract and the scan
adapter currently preserves QLever `sorted_by` metadata even when encoded id
order may differ from native term-key order.

- [x] **Step 2: Add the native term-order contract**

Extend `xpod_rdf_backend_v1` with optional `qlever_term_ordering`. Backends can
set `XPOD_RDF_QLEVER_TERM_ORDER_PRESERVED` when their permutation output remains
sorted after term keys are converted to QLever id bits. Direct
`XPOD_RDF_TERM_KEY_ENCODING_QLEVER_VALUE_ID_BITS` remains order-preserving by
construction.

- [x] **Step 3: Fail safe on opaque order**

`XpodBackedIndexScan` now reports and returns sorted columns only when the
physical backend declares QLever term order is preserved. Opaque/custom encoders
without that contract still execute correctly, but they do not expose false
sortedness to QLever upper operators.

- [x] **Step 4: Run target verification**

Run:

```bash
bun test tests/native/RdfPhysicalBackendProtocolHeader.test.ts tests/native/QleverBackedIndexScan.test.ts --run
```

Expected: PASS.

### Task 29: TermDictionary prefix range native ABI

**Files:**
- Modify: `tests/native/RdfPhysicalBackendProtocolHeader.test.ts`
- Modify: `tests/native/QleverPhysicalBackendFacade.test.ts`
- Modify: `native/postgres/rdf_protocol/include/xpod_rdf_physical_backend.h`
- Modify: `native/postgres/qlever_adapter/src/XpodPhysicalBackend.hpp`
- Modify: `scripts/check-rdf-physical-protocol-abi.cjs`
- Modify: `docs/superpowers/specs/2026-06-29-qlever-compatible-rdf-physical-backend-protocol-design.md`

- [x] **Step 1: Write failing protocol and facade tests**

Add protocol-header expectations for `xpod_rdf_prefix_range_request` and
`xpod_rdf_prefix_range_fn`. Extend the physical-backend facade smoke with a
prefix request for IRI terms, a two-range callback response, and an unsupported
backend check.

Expected: FAIL because the public ABI has no prefix range surface and the C++
facade has no wrapper.

- [x] **Step 2: Add native prefix range structs and callback**

Add `xpod_rdf_term_range`, `xpod_rdf_term_range_batch`,
`xpod_rdf_prefix_range_request`, `xpod_rdf_term_collation`, and
`xpod_rdf_prefix_range_fn` to the physical backend ABI. The result is callback
based because a lexical prefix may map to multiple term-key ranges.

- [x] **Step 3: Expose prefix range through `PhysicalBackend`**

Add `PhysicalBackend::prefixRange(...)` that checks the optional ABI field,
forwards range batches, and captures the backend collation marker. Missing
callbacks fail closed as `XPOD_RDF_STATUS_UNSUPPORTED`.

- [x] **Step 4: Run target verification**

Run:

```bash
bun test tests/native/RdfPhysicalBackendProtocolHeader.test.ts tests/native/QleverPhysicalBackendFacade.test.ts --run
```

Expected: PASS.

### Task 30: Slot term-range constraints in native scan requests

**Files:**
- Modify: `tests/native/RdfPhysicalBackendProtocolHeader.test.ts`
- Modify: `tests/native/QleverScanBridge.test.ts`
- Modify: `native/postgres/rdf_protocol/include/xpod_rdf_physical_backend.h`
- Modify: `native/postgres/qlever_adapter/src/XpodQleverScanBridge.hpp`
- Modify: `scripts/check-rdf-physical-protocol-abi.cjs`
- Modify: `docs/superpowers/specs/2026-06-29-qlever-compatible-rdf-physical-backend-protocol-design.md`

- [x] **Step 1: Write failing protocol and scan bridge tests**

Extend the protocol-header test with `xpod_rdf_slot_term_range` and the scan
request `slot_ranges` pointer. Extend the scan bridge smoke so a subject slot
range is added to `ScanRequestInput` and must be visible in the generated
`xpod_rdf_scan_request`.

Expected: FAIL because `prefixRange` could produce dictionary ranges, but the
permutation scan request had no slot-range constraint surface.

- [x] **Step 2: Add flat slot-range constraints to scan requests**

Add `xpod_rdf_slot_term_range` to the C ABI as `{slot, range, collation}` and
add `slot_ranges` / `slot_range_count` to `xpod_rdf_scan_request`. Keep this as
a flat array instead of nested per-slot arrays so ownership stays simple across
the C ABI and `ScanRequestInput` can safely own the vector.

- [x] **Step 3: Forward scan slot ranges through the QLever scan bridge**

Add `ScanRequestInput::slot_ranges` and copy its data pointer/count into
`makeScanRequest(...)`. This lets future QLever prefix/vocabulary planning feed
TermDictionary prefix ranges directly into `PermutationAccess` without adding an
operation-specific bridge.

- [x] **Step 4: Run target verification**

Run:

```bash
bun test tests/native/RdfPhysicalBackendProtocolHeader.test.ts tests/native/QleverScanBridge.test.ts --run
```

Expected: PASS.

### Task 31: Execute slot term-key ranges in PostgresRdfEngine scans

**Files:**
- Modify: `tests/storage/rdf/PostgresRdfEngine.test.ts`
- Modify: `src/storage/rdf/types.ts`
- Modify: `src/storage/rdf/PostgresRdfEngine.ts`
- Modify: `docs/superpowers/specs/2026-06-29-qlever-compatible-rdf-physical-backend-protocol-design.md`

- [x] **Step 1: Write failing engine test**

Add a PostgreSQL RDF scan test with three matching subjects and a subject
term-key range that should select only the middle subject.

Expected: FAIL because the native protocol could carry `slot_ranges`, but the
actual Postgres RDF scan path ignored slot term-key ranges.

- [x] **Step 2: Add internal scan option shape**

Add `RdfSlotTermKeyRange` and allow `RdfQuadScanOptions.slotTermRanges`. This is
an internal physical scan option, not a Pod model field or user-facing RDF
pattern operator.

- [x] **Step 3: Push ranges into SQL and fallback scans**

Compile `slotTermRanges` into `rdf_quads` term-id column predicates for SQL
scans and custom-index fallback counts. Also apply the same range predicate to
post-filter scans so unsupported patterns do not silently ignore the physical
constraint.

- [x] **Step 4: Run target verification**

Run:

```bash
bun test tests/storage/rdf/PostgresRdfEngine.test.ts --run -t "slot term-key ranges"
```

Expected: PASS.

### Task 32: Bind prefix constraints into scan slot ranges

**Files:**
- Modify: `tests/native/QleverPlanBridge.test.ts`
- Modify: `native/postgres/qlever_adapter/src/XpodQleverPlanBridge.hpp`
- Modify: `docs/superpowers/specs/2026-06-29-qlever-compatible-rdf-physical-backend-protocol-design.md`

- [x] **Step 1: Write failing prefix-binding bridge test**

Add a native C++ smoke that constructs a `BridgeTermBinding` marked as a prefix
constraint, provides a physical backend `prefix_range` callback, calls
`bindPlanTerms(...)`, and expects the returned dictionary ranges to appear in
`plan.scan.slot_ranges` instead of exact scan pattern slots.

Expected: FAIL because `prefixRange` and `slot_ranges` existed independently,
but `bindPlanTerms(...)` had no prefix-binding path.

- [x] **Step 2: Add prefix binding semantics**

Add `BridgeTermBinding::is_prefix`. Exact bindings still use batch
`lookupTerms(...)`; prefix bindings use `PhysicalBackend::prefixRange(...)` and
append returned ranges as `xpod_rdf_slot_term_range` values for the binding slot.

- [x] **Step 3: Fail empty prefixes closed**

If a prefix resolves to zero ranges, mark the plan/filter scan as known-empty so
upper operators do not scan the whole permutation by mistake.

- [x] **Step 4: Run target verification**

Run:

```bash
bun test tests/native/QleverPlanBridge.test.ts --run -t "prefix term constraints"
```

Expected: PASS.

### Task 33: Backend QLever id comparator for native sort modifiers

**Files:**
- Modify: `tests/native/RdfPhysicalBackendProtocolHeader.test.ts`
- Modify: `tests/native/QleverOperationBridge.test.ts`
- Modify: `native/postgres/rdf_protocol/include/xpod_rdf_physical_backend.h`
- Modify: `native/postgres/qlever_adapter/src/XpodPhysicalBackend.hpp`
- Modify: `native/postgres/qlever_adapter/src/XpodQleverOperationExecutor.hpp`
- Modify: `scripts/check-rdf-physical-protocol-abi.cjs`
- Modify: `docs/superpowers/specs/2026-06-29-qlever-compatible-rdf-physical-backend-protocol-design.md`

- [x] **Step 1: Write failing ABI and native operation tests**

Extend the protocol-header test with `xpod_rdf_compare_qlever_ids_fn` and a
`compare_qlever_ids` callback field on `xpod_rdf_backend_v1`.

Add a native operation smoke where the backend uses opaque QLever id bits that
sort in the opposite order from the underlying term keys. An `OrderBy` modifier
must call the backend comparator and return rows in semantic term-key order.

Expected: FAIL because the ABI had no comparator field and native sort/order
modifiers compared raw encoded id bits directly.

- [x] **Step 2: Add optional comparator to the native protocol**

Add `xpod_rdf_compare_qlever_ids_fn` to the C ABI. The callback compares two
QLever id-bit values and returns a negative/zero/positive compare result.

Expose it through `PhysicalBackend::compareQleverIds(...)`. Missing callbacks
fall back to numeric id-bit order for compatibility only; correctness-sensitive
backends with opaque or non-order-preserving id bits must provide the callback.

- [x] **Step 3: Use the comparator in native sort modifiers**

Update native `OrderBy` and internal sort modifiers to compare ids through
`PhysicalBackend::compareQleverIds(...)` instead of directly comparing
`Id::getBits()`. Comparator errors fail closed.

- [x] **Step 4: Run target verification**

Run:

```bash
bun test tests/native/RdfPhysicalBackendProtocolHeader.test.ts --run -t "exists and exposes"
bun test tests/native/QleverOperationBridge.test.ts --run -t "orders QLever ids"
```

Expected: PASS.

### Task 34: Planner-generated modifiers must not reuse legacy shims

**Files:**
- Modify: `tests/native/QleverOperationPlanBridge.test.ts`
- Modify: `native/postgres/qlever_adapter/src/XpodQleverOperationPlanBridge.hpp`

- [x] **Step 1: Write failing planner-shape regression**

Update the QLever operation-plan smoke so planner-generated `LimitOffset` and
`Distinct` operations must emit only ordered `result_modifiers`. The legacy
`root.has_limit` / `root.has_distinct` shims must remain unset because the
executor still applies those fields for hand-built compatibility plans.

Expected: FAIL because the planner path populated both the new modifier list
and the legacy root shims, which would make execution apply limit/distinct
twice.

- [x] **Step 2: Remove legacy shim writes from planner-generated operations**

Keep `LimitOffset` and `Distinct` represented in `root.result_modifiers` only.
Do not set `root.has_limit`, `root.limit`, `root.offset`,
`root.has_distinct`, or `root.distinct_columns` from the planner path.

- [x] **Step 3: Run target verification**

Run:

```bash
bun test tests/native/QleverOperationPlanBridge.test.ts --run -t "builds a bridge query plan"
```

Expected: PASS.

### Task 35: Carry graph slots through the physical scan primitive

**Files:**
- Modify: `tests/native/QleverScanBridge.test.ts`
- Modify: `tests/native/QleverScanMaterializer.test.ts`
- Modify: `native/postgres/qlever_adapter/src/XpodQleverScanBridge.hpp`
- Modify: `native/postgres/qlever_adapter/src/XpodQleverScanMaterializer.hpp`
- Modify: `docs/superpowers/specs/2026-06-29-qlever-compatible-rdf-physical-backend-protocol-design.md`

- [x] **Step 1: Write failing scan-bridge and materializer tests**

Extend the scan bridge smoke so `TripleKeyPattern` can carry an exact graph
term key and `XPOD_RDF_SLOT_GRAPH` in `needed_slots`.

Extend the scan materializer smoke so a quad batch can materialize graph as a
requested fourth slot, both as raw term keys and encoded QLever id bits.

Expected: FAIL because the bridge only carried S/P/O and the materializer
iterated three-slot QLever permutation strings.

- [x] **Step 2: Add graph to the scan request primitive**

Add `has_graph` / `graph` to `TripleKeyPattern` and copy them into
`xpod_rdf_quad_pattern`. This keeps graph filtering at the physical scan
boundary instead of requiring graph-aware operator glue.

- [x] **Step 3: Materialize graph as part of the native permutation row**

Treat QLever triple permutations as Xpod quad permutations with graph appended
(`SPOG`, `POSG`, etc.). `XPOD_RDF_SLOT_GRAPH` is emitted only when requested by
`needed_slots`, so existing triple-shaped scans keep their three-column result.

- [x] **Step 4: Run target verification**

Run:

```bash
bun test tests/native/QleverScanBridge.test.ts --run -t "builds an Xpod physical scan request"
bun test tests/native/QleverScanMaterializer.test.ts --run -t "materializes Xpod quad batches"
bun test tests/native/QleverScanMaterializer.test.ts --run -t "materializes scan rows as QLever id bits"
```

Expected: PASS.

### Task 36: Map parsed GRAPH IRI clauses to graph scan constraints

**Files:**
- Modify: `tests/native/qleverFakeHeaders.ts`
- Modify: `tests/native/QleverPlanBridge.test.ts`
- Modify: `native/postgres/qlever_adapter/src/XpodQleverPlanBridge.hpp`
- Modify: `docs/superpowers/specs/2026-06-29-qlever-compatible-rdf-physical-backend-protocol-design.md`

- [x] **Step 1: Write failing parsed GRAPH test**

Extend the fake parsed-query headers with QLever-shaped
`parsedQuery::GroupGraphPattern` and a `ParsedQuery::graphIriSelect()` helper.
Add a native smoke that expects `GRAPH <urn:g> { ?s ?p ?o }` to produce a
`XPOD_RDF_SLOT_GRAPH` term binding and, after `bindPlanTerms(...)`, an exact
`scan.pattern.graph` constraint.

Expected: FAIL because the parsed fallback only accepted root
`BasicGraphPattern` operations.

- [x] **Step 2: Extract fixed-IRI graph scope from `GroupGraphPattern`**

Detect a root `parsedQuery::GroupGraphPattern` whose `graphSpec_` is a fixed
`TripleComponent::Iri` and whose child contains exactly one `BasicGraphPattern`.
Variable graph scopes still fail closed; the physical protocol can carry exact
graph keys, but result projection for graph variables is a separate planner
shape.

- [x] **Step 3: Bind graph scope through existing term dictionary path**

Represent the graph IRI as a normal `BridgeTermBinding` on
`XPOD_RDF_SLOT_GRAPH`. `bindPatternSlot(...)` now writes graph keys into
`TripleKeyPattern`, so scan request creation and execution reuse the same
physical primitive as S/P/O constants.

- [x] **Step 4: Run target verification**

Run:

```bash
bun test tests/native/QleverPlanBridge.test.ts --run -t "binds parsed GRAPH IRIs"
bun test tests/native/QleverPlanBridge.test.ts --run
```

Expected: PASS.

### Task 37: Project parsed GRAPH variables through the scan graph slot

**Files:**
- Modify: `tests/native/qleverFakeHeaders.ts`
- Modify: `tests/native/QleverPlanBridge.test.ts`
- Modify: `native/postgres/qlever_adapter/src/XpodQleverPlanBridge.hpp`
- Modify: `docs/superpowers/specs/2026-06-29-qlever-compatible-rdf-physical-backend-protocol-design.md`

- [x] **Step 1: Write failing parsed GRAPH-variable test**

Extend the fake QLever parsed-query headers with the upstream-shaped
`GroupGraphPattern::GraphVar` graph spec and a `ParsedQuery::graphVariableSelect()`
helper. Add a native smoke that expects `GRAPH ?g { ?s ?p ?o }` to include
`XPOD_RDF_SLOT_GRAPH` in `needed_slots`, append `g` to the output-variable list
in scan materialization order, and carry a four-column scan width into the
physical plan.

Expected: FAIL because the parsed fallback only accepted fixed-IRI GRAPH scopes.

- [x] **Step 2: Add graph-variable projection metadata**

Represent a parsed GRAPH scope as either an exact graph binding or a projected
graph variable. For graph variables, add `XPOD_RDF_SLOT_GRAPH` to the scan
projection and append the graph variable after S/P/O so it matches the existing
`SPOG` materializer order.

- [x] **Step 3: Keep unsupported multi-triple GRAPH-variable groups closed**

Reject two-triple parsed fallback groups under `GRAPH ?g` until the fallback can
join both subject and graph slots. Fixed-IRI GRAPH groups continue to reuse the
existing graph exact constraint path.

- [x] **Step 4: Run target verification**

Run:

```bash
bun test tests/native/QleverPlanBridge.test.ts --run -t "projects parsed GRAPH variables"
```

Expected: PASS.

### Task 38: Join parsed GRAPH variable groups on subject and graph

**Files:**
- Modify: `tests/native/qleverFakeHeaders.ts`
- Modify: `tests/native/QleverPlanBridge.test.ts`
- Modify: `native/postgres/qlever_adapter/src/XpodQleverPlanBridge.hpp`
- Modify: `docs/superpowers/specs/2026-06-29-qlever-compatible-rdf-physical-backend-protocol-design.md`

- [x] **Step 1: Write failing GRAPH-variable multi-triple test**

Add a parsed fallback smoke for
`GRAPH ?g { ?s ?p ?o . ?s <urn:type> <urn:Thing> }`. The plan must not fall
back to subject-only join semantics; it must project graph on both scans and
record a composite `{subject, graph}` join key.

Expected: FAIL because `GRAPH ?g` with two triples was intentionally rejected
after single-scan graph projection landed.

- [x] **Step 2: Reuse projected hash join with composite graph key**

For two-triple parsed fallback groups under `GRAPH ?g`, add graph to the filter
scan projection and set `join_key_slots` to `{S,G}` for both scans. Use
`scan_project_slots` to preserve the left scan output (`S/P/O/G`) and project no
columns from the filter scan, so execution remains a graph-safe semi-join over
the native physical executor.

- [x] **Step 3: Run target verification**

Run:

```bash
bun test tests/native/QleverPlanBridge.test.ts --run -t "joins parsed GRAPH variable groups"
```

Expected: PASS.

### Task 39: Carry graph scope through the scan request input

**Files:**
- Modify: `tests/native/QleverScanBridge.test.ts`
- Modify: `native/postgres/qlever_adapter/src/XpodQleverScanBridge.hpp`
- Modify: `docs/superpowers/specs/2026-06-29-qlever-compatible-rdf-physical-backend-protocol-design.md`

- [x] **Step 1: Write failing scan-scope test**

Extend the scan-bridge smoke so `ScanRequestInput` can carry an
`xpod_rdf_graph_scope` set and `makeScanRequest(...)` forwards it unchanged to
the native `xpod_rdf_scan_request`.

Expected: FAIL because `ScanRequestInput` had no graph-scope field and
`makeScanRequest(...)` always forced `XPOD_RDF_GRAPH_SCOPE_ALL`.

- [x] **Step 2: Move graph scope to the physical scan boundary**

Add `graph_scope` to `ScanRequestInput` with `ALL` as the default, and copy it
directly into the C ABI scan request. This lets QLever planner/executor paths
carry graph exact/set/prefix constraints through the same low-level scan
protocol instead of requiring graph-specific operator glue above the scan.

- [x] **Step 3: Run target verification**

Run:

```bash
bun test tests/native/QleverScanBridge.test.ts --run -t "builds an Xpod physical scan request"
```

Expected: PASS.

### Task 40: Carry request-level graph scope into planner scan input

**Files:**
- Modify: `tests/native/QleverScanBridge.test.ts`
- Modify: `tests/native/QleverAdapterFacade.test.ts`
- Modify: `scripts/check-rdf-physical-protocol-abi.cjs`
- Modify: `native/postgres/qlever_adapter/include/xpod_qlever_adapter.h`
- Modify: `native/postgres/qlever_adapter/src/XpodQleverPlannerScanInput.hpp`
- Modify: `docs/superpowers/specs/2026-06-29-qlever-compatible-rdf-physical-backend-protocol-design.md`

- [x] **Step 1: Write failing request-context propagation test**

Extend the planner scan input smoke so `xpod_qlever_query_request` can carry an
exact graph scope and `makeScanRequestInput(...)` propagates it into
`makeScanRequest(...)`.

Expected: FAIL because `xpod_qlever_query_request` had no graph-scope field.

- [x] **Step 2: Add graph scope to the query request ABI**

Add `xpod_rdf_graph_scope graph_scope` to the adapter query request, include it
in the header/ABI checks, and copy it from `PlannerRequestContext` into
`ScanRequestInput`. Zero-initialized requests still default to
`XPOD_RDF_GRAPH_SCOPE_ALL`, preserving existing callers.

- [x] **Step 3: Run target verification**

Run:

```bash
bun test tests/native/QleverScanBridge.test.ts --run -t "builds scan input from the native planner request context"
```

Expected: PASS.

### Task 41: Apply request graph scope to all bridge scan plans

**Files:**
- Modify: `tests/native/QleverPlanRequestContext.test.ts`
- Modify: `native/postgres/qlever_adapter/src/XpodQleverPlanBridge.hpp`
- Modify: `native/postgres/qlever_adapter/src/XpodQleverBridge.cpp`
- Modify: `docs/superpowers/specs/2026-06-29-qlever-compatible-rdf-physical-backend-protocol-design.md`

- [x] **Step 1: Write failing request-context plan test**

Extend the plan request-context smoke so `applyBridgeRequestContext(...)` must
apply an exact graph scope to the primary scan and filter scan, alongside
snapshot/source/access scope.

Expected: FAIL because `applyBridgeRequestContext(...)` accepted only snapshot,
source scope, and access scope.

- [x] **Step 2: Propagate graph scope through bridge plans**

Thread `xpod_rdf_graph_scope` through `applyBridgeRequestContext(...)`, copy it
onto the primary scan, every filter scan, and child plans, and pass
`request.graph_scope` from the adapter query execution path. Candidate source
requests do not yet expose graph scope, so this task deliberately limits the
change to RDF scan plans.

- [x] **Step 3: Run target verification**

Run:

```bash
bun test tests/native/QleverPlanRequestContext.test.ts --run
```

Expected: PASS.

### Task 42: Carry request graph scope into candidate-source protocol

**Files:**
- Modify: `tests/native/QleverPlanRequestContext.test.ts`
- Modify: `scripts/check-rdf-physical-protocol-abi.cjs`
- Modify: `native/postgres/rdf_protocol/include/xpod_rdf_physical_backend.h`
- Modify: `native/postgres/qlever_adapter/src/XpodQleverPlanBridge.hpp`
- Modify: `docs/superpowers/specs/2026-06-29-qlever-compatible-rdf-physical-backend-protocol-design.md`

- [x] **Step 1: Write failing candidate-source graph-scope test**

Extend the plan request-context smoke so text and vector candidate-source
requests must carry the same exact graph scope as RDF scans.

Expected: FAIL because `xpod_rdf_text_search_request` and
`xpod_rdf_vector_search_request` had no `graph_scope` field.

- [x] **Step 2: Add graph scope to text/vector candidate requests**

Add `xpod_rdf_graph_scope graph_scope` to both candidate-source request structs
and copy the request-level graph scope in `applyBridgeRequestContext(...)`.
This keeps FTS/vector candidates on the same Solid graph-scope boundary as RDF
permutation scans before QLever planner/executor performs fusion joins.

- [x] **Step 3: Run target verification**

Run:

```bash
bun test tests/native/QleverPlanRequestContext.test.ts --run
```

Expected: PASS.

### Task 43: Carry graph/source scope into join fanout estimates

**Files:**
- Modify: `scripts/check-rdf-physical-protocol-abi.cjs`
- Modify: `native/postgres/rdf_protocol/include/xpod_rdf_physical_backend.h`
- Modify: `docs/superpowers/specs/2026-06-29-qlever-compatible-rdf-physical-backend-protocol-design.md`

- [x] **Step 1: Write failing ABI smoke for scoped join fanout stats**

Extend the native ABI smoke so `xpod_rdf_join_fanout_request` must expose both
`graph_scope` and `source_scope`.

Expected: FAIL because join fanout estimates only carried snapshot, patterns,
bound slots, and access scope.

- [x] **Step 2: Add scope fields to join fanout request**

Add `xpod_rdf_graph_scope graph_scope` and `xpod_rdf_source_scope source_scope`
to `xpod_rdf_join_fanout_request`, keeping planner statistics under the same
graph/path protocol boundary as scan and candidate-source execution.

- [x] **Step 3: Run target verification**

Run:

```bash
bun run check:rdf-protocol-abi
```

Expected: PASS.

### Task 44: Expose scoped histogram hints in the native physical protocol

**Files:**
- Modify: `tests/native/QleverPhysicalBackendFacade.test.ts`
- Modify: `scripts/check-rdf-physical-protocol-abi.cjs`
- Modify: `native/postgres/rdf_protocol/include/xpod_rdf_physical_backend.h`
- Modify: `native/postgres/qlever_adapter/src/XpodPhysicalBackend.hpp`
- Modify: `docs/superpowers/specs/2026-06-29-qlever-compatible-rdf-physical-backend-protocol-design.md`

- [x] **Step 1: Write failing protocol/facade tests**

Extend the ABI smoke and C++ facade smoke so the physical backend must expose a
scoped `histogram_hints` callback over `xpod_rdf_histogram_request` and return
`xpod_rdf_histogram_hint_batch` rows.

Expected: FAIL because the native protocol had scan and join fanout estimates,
but no histogram hint request/batch/callback surface.

- [x] **Step 2: Add the minimal histogram hint ABI**

Add `xpod_rdf_histogram_request`, `xpod_rdf_histogram_hint`,
`xpod_rdf_histogram_hint_batch`, `xpod_rdf_histogram_hints_fn`, and a guarded
`PhysicalBackend::histogramHints(...)` wrapper. The request carries snapshot,
quad pattern, graph scope, source scope, access scope, slot mask, and max bucket
count so QLever can consume selectivity hints without a TS planner layer.

- [x] **Step 3: Run target verification**

Run:

```bash
bun test tests/native/QleverPhysicalBackendFacade.test.ts --run
bun run check:rdf-protocol-abi
```

Expected: PASS.

### Task 45: Carry cancellation through long-running physical requests

**Files:**
- Modify: `tests/native/QleverPhysicalBackendFacade.test.ts`
- Modify: `scripts/check-rdf-physical-protocol-abi.cjs`
- Modify: `native/postgres/rdf_protocol/include/xpod_rdf_physical_backend.h`
- Modify: `docs/superpowers/specs/2026-06-29-qlever-compatible-rdf-physical-backend-protocol-design.md`

- [x] **Step 1: Write failing ABI/facade cancellation tests**

Extend the C++ facade smoke so scan and prefix-range callbacks must receive an
optional `xpod_rdf_cancellation` token and can return `XPOD_RDF_STATUS_CANCELLED`
when the token is set. Extend the ABI smoke so text/vector/join/histogram
requests also compile with the same cancellation field.

Expected: FAIL because the C ABI exposed `XPOD_RDF_STATUS_CANCELLED` but no
request-level cancellation token.

- [x] **Step 2: Add the minimal cancellation token protocol**

Add `xpod_rdf_is_cancelled_fn` and `xpod_rdf_cancellation`, then attach an
optional `const xpod_rdf_cancellation* cancellation` to long-running physical
requests: prefix range, permutation scan, join fanout estimate, histogram hints,
text search, and vector search.

- [x] **Step 3: Run target verification**

Run:

```bash
bun test tests/native/QleverPhysicalBackendFacade.test.ts --run
bun run check:rdf-protocol-abi
```

Expected: PASS.

### Task 46: Propagate cancellation from QLever query request into physical plans

**Files:**
- Modify: `tests/native/QleverScanBridge.test.ts`
- Modify: `tests/native/QleverPlanRequestContext.test.ts`
- Modify: `scripts/check-rdf-physical-protocol-abi.cjs`
- Modify: `native/postgres/qlever_adapter/include/xpod_qlever_adapter.h`
- Modify: `native/postgres/qlever_adapter/src/XpodQleverScanBridge.hpp`
- Modify: `native/postgres/qlever_adapter/src/XpodQleverPlannerScanInput.hpp`
- Modify: `native/postgres/qlever_adapter/src/XpodQleverPlanBridge.hpp`
- Modify: `native/postgres/qlever_adapter/src/XpodQleverBridge.cpp`
- Modify: `docs/superpowers/specs/2026-06-29-qlever-compatible-rdf-physical-backend-protocol-design.md`

- [x] **Step 1: Write failing propagation tests**

Extend the scan bridge and plan request-context smokes so cancellation must flow
from `xpod_qlever_query_request` to `ScanRequestInput`, physical scan requests,
filter scans, text/vector candidate requests, and child plans. Extend the ABI
check so the public QLever query request must expose a cancellation field.

Expected: FAIL because the previous task added physical request cancellation,
but the QLever adapter query entry point could not pass it into generated plans.

- [x] **Step 2: Thread cancellation through the adapter request context**

Add `const xpod_rdf_cancellation* cancellation` to `xpod_qlever_query_request`,
carry it through `makeScanRequestInput(...)`, `ScanRequestInput`,
`makeScanRequest(...)`, `applyBridgeRequestContext(...)`, and the adapter query
call site.

- [x] **Step 3: Run target verification**

Run:

```bash
bun test tests/native/QleverScanBridge.test.ts tests/native/QleverPlanRequestContext.test.ts --run
bun run check:rdf-protocol-abi
```

Expected: PASS.

### Task 47: Map Xpod cancellation into QLever planner cancellation handles

**Files:**
- Modify: `tests/native/QleverOperationPlanBridge.test.ts`
- Modify: `tests/native/QleverExecutorPlannerContextProvider.test.ts`
- Modify: `native/postgres/qlever_adapter/src/XpodQleverPlannerRequestContext.hpp`
- Modify: `native/postgres/qlever_adapter/src/XpodQleverPlannerContextProvider.hpp`
- Modify: `native/postgres/qlever_adapter/src/XpodQleverPlannerScanInput.hpp`
- Modify: `native/postgres/qlever_adapter/src/XpodQleverOperationPlanBridge.hpp`
- Modify: `docs/superpowers/specs/2026-06-29-qlever-compatible-rdf-physical-backend-protocol-design.md`

- [x] **Step 1: Write failing planner-cancellation tests**

Extend the native-context planner smoke so fake QLever only returns a plan when
its constructor receives a non-null `SharedCancellationHandle` that reflects the
Xpod request cancellation state. Extend the planner-context provider smoke so
`request.cancellation` is part of the native planner request context.

Expected: FAIL because the previous bridge passed `SharedCancellationHandle{}`
to QLever planner constructors and only carried cancellation into lower physical
requests.

- [x] **Step 2: Make cancellation part of native planner request context**

Add `PlannerRequestContext::cancellation`, populate it from
`xpod_qlever_query_request`, and let scan input reuse the context field instead
of re-reading the request struct.

- [x] **Step 3: Create QLever cancellation handles at the native planner seam**

Create a QLever `SharedCancellationHandle` when the handle type is shared-pointer
like, and pre-cancel it when the Xpod cancellation callback is already set. Keep
non-shared fake or older handle shapes on the previous default-construction
fallback.

- [x] **Step 4: Run target verification**

Run:

```bash
bun test tests/native/QleverExecutorPlannerContextProvider.test.ts tests/native/QleverOperationPlanBridge.test.ts --run
```

Expected: PASS.

### Task 48: Expose native source-scope resolution in the physical protocol

**Files:**
- Modify: `tests/native/RdfPhysicalBackendProtocolHeader.test.ts`
- Modify: `tests/native/QleverPhysicalBackendFacade.test.ts`
- Modify: `scripts/check-rdf-physical-protocol-abi.cjs`
- Modify: `native/postgres/rdf_protocol/include/xpod_rdf_physical_backend.h`
- Modify: `native/postgres/qlever_adapter/src/XpodPhysicalBackend.hpp`
- Modify: `docs/superpowers/specs/2026-06-29-qlever-compatible-rdf-physical-backend-protocol-design.md`

- [x] **Step 1: Write failing native protocol tests**

Extend the C ABI/header smoke and the QLever physical backend facade smoke so
source/path scope must support a real resolve callback, not only cardinality
estimation. The facade test requires a backend callback to return backend-owned
source-node and graph-scope constraints, and requires missing/truncated callback
tables to fail closed with `UNSUPPORTED`.

Expected: FAIL because the protocol only exposed `estimate_source_scope`.

- [x] **Step 2: Add the minimal C ABI and C++ facade seam**

Add `xpod_rdf_resolved_source_scope` and
`xpod_rdf_resolve_source_scope_fn` to the native physical backend header. Add the
callback to `xpod_rdf_backend_v1` as an additive struct-size-gated field and
surface it as `PhysicalBackend::resolveSourceScope(...)`.

- [x] **Step 3: Run target verification**

Run:

```bash
bun test tests/native/RdfPhysicalBackendProtocolHeader.test.ts tests/native/QleverPhysicalBackendFacade.test.ts --run
bun run check:rdf-protocol-abi
```

Expected: PASS.

### Task 49: Expose distinct cardinality estimates in the physical protocol

**Files:**
- Modify: `tests/native/RdfPhysicalBackendProtocolHeader.test.ts`
- Modify: `tests/native/QleverPhysicalBackendFacade.test.ts`
- Modify: `scripts/check-rdf-physical-protocol-abi.cjs`
- Modify: `native/postgres/rdf_protocol/include/xpod_rdf_physical_backend.h`
- Modify: `native/postgres/qlever_adapter/src/XpodPhysicalBackend.hpp`
- Modify: `docs/superpowers/specs/2026-06-29-qlever-compatible-rdf-physical-backend-protocol-design.md`

- [x] **Step 1: Write failing distinct-estimate tests**

Extend the protocol/header smoke and physical backend facade smoke so
`CardinalityStats.estimateDistinct(...)` is represented in the C ABI and surfaced
through the C++ facade. The test uses a real `xpod_rdf_distinct_request` and
requires missing callback tables to fail closed with `UNSUPPORTED`.

Expected: FAIL because the protocol exposed `distinct_scan` but not a distinct
cardinality estimate callback.

- [x] **Step 2: Add the additive native callback and facade method**

Add `xpod_rdf_estimate_distinct_fn` and append `estimate_distinct` to
`xpod_rdf_backend_v1` as a struct-size-gated field. Surface it as
`PhysicalBackend::estimateDistinct(...)`.

- [x] **Step 3: Run target verification**

Run:

```bash
bun test tests/native/RdfPhysicalBackendProtocolHeader.test.ts tests/native/QleverPhysicalBackendFacade.test.ts --run
bun run check:rdf-protocol-abi
```

Expected: PASS.


### Task 50: Native backend capability negotiation

**Files:**
- Modify: `tests/native/RdfPhysicalBackendProtocolHeader.test.ts`
- Modify: `tests/native/QleverPhysicalBackendFacade.test.ts`
- Modify: `scripts/check-rdf-physical-protocol-abi.cjs`
- Modify: `native/postgres/rdf_protocol/include/xpod_rdf_physical_backend.h`
- Modify: `native/postgres/qlever_adapter/src/XpodPhysicalBackend.hpp`
- Modify: `docs/superpowers/specs/2026-06-29-qlever-compatible-rdf-physical-backend-protocol-design.md`

- [x] **Step 1: Write failing native protocol tests**

Extend the protocol/header smoke and physical backend facade smoke so a backend can declare supported permutation indexes and hard pushdown features before QLever-facing code plans against it.

Expected: FAIL because the native protocol had data callbacks but no capability negotiation callback.

- [x] **Step 2: Add the minimal C ABI and C++ facade seam**

Add `xpod_rdf_backend_capabilities`, permutation capability bits, backend feature bits, and `xpod_rdf_backend_capabilities_fn get_capabilities` as an additive struct-size-gated callback. Surface it as `PhysicalBackend::getCapabilities(...)`.

This is intentionally a lower data-protocol seam. It does not add planner policies or QLever operator replicas to Xpod.

- [x] **Step 3: Run target verification**

Run:

```bash
bun test tests/native/RdfPhysicalBackendProtocolHeader.test.ts tests/native/QleverPhysicalBackendFacade.test.ts --run
bun run check:rdf-protocol-abi
```

Expected: PASS.

### Task 51: Carry backend capabilities into planner request context

**Files:**
- Modify: `tests/native/QleverExecutorPlannerContextProvider.test.ts`
- Modify: `native/postgres/qlever_adapter/src/XpodQleverPlannerRequestContext.hpp`
- Modify: `native/postgres/qlever_adapter/src/XpodQleverPlannerContextProvider.hpp`
- Modify: `docs/superpowers/specs/2026-06-29-qlever-compatible-rdf-physical-backend-protocol-design.md`

- [x] **Step 1: Write failing native planner-context test**

Extend the planner context provider smoke so `provider->current(request)` must expose a per-query snapshot of `xpod_rdf_backend_capabilities` and the status returned by `PhysicalBackend::getCapabilities(...)`.

Expected: FAIL because `PlannerRequestContext` only carried backend, request, and cancellation pointers.

- [x] **Step 2: Add capability snapshot fields to the native planner context**

Add `PlannerRequestContext::capabilities` and `PlannerRequestContext::capabilities_status`. Refresh them when the provider binds a new `xpod_qlever_query_request`.

This is a lower physical-protocol handoff to QLever planner construction. It does not add planner policy or duplicate QLever operators in Xpod.

- [x] **Step 3: Run target verification**

Run:

```bash
bun test tests/native/QleverExecutorPlannerContextProvider.test.ts --run
```

Expected: PASS.

### Task 52: Gate Xpod-backed scans with backend permutation capabilities

**Files:**
- Modify: `tests/native/QleverPermutationMap.test.ts`
- Modify: `tests/native/QleverBackedIndexScan.test.ts`
- Modify: `native/postgres/qlever_adapter/src/XpodQleverPermutationMap.hpp`
- Modify: `native/postgres/qlever_adapter/src/XpodBackedIndexScan.hpp`
- Modify: `docs/superpowers/specs/2026-06-29-qlever-compatible-rdf-physical-backend-protocol-design.md`

- [x] **Step 1: Write failing permutation capability mapping test**

Extend the QLever permutation smoke so every `Permutation::Enum` maps to the corresponding `XPOD_RDF_PERM_CAP_*` bit as well as the physical `XPOD_RDF_PERM_*` value.

Expected: FAIL because only the physical permutation mapping existed.

- [x] **Step 2: Write failing backed IndexScan capability gate test**

Add a native smoke where the backend declares support for `POSG` only, while the Xpod-backed scan requests QLever `SPO`. The adapter must return `UNSUPPORTED` before calling estimate or scan callbacks.

Expected: FAIL because the adapter previously ignored capability snapshots and delegated directly to backend callbacks.

- [x] **Step 3: Add the minimal lower-protocol capability gate**

Add `toXpodPermutationCapability(...)` beside the existing permutation mapping and make `XpodBackedIndexScan` treat an OK capability response as authoritative for the requested permutation. Missing capability callbacks remain compatible and keep the old callback-driven behavior.

This keeps capability enforcement in the lower data interface; it does not add planner policy or QLever operator replicas.

- [x] **Step 4: Run target verification**

Run:

```bash
bun test tests/native/QleverBackedIndexScan.test.ts tests/native/QleverPermutationMap.test.ts --run
```

Expected: PASS.

### Task 53: Gate candidate sources with backend feature capabilities

**Files:**
- Modify: `tests/native/QleverBackedTextSearch.test.ts`
- Modify: `tests/native/QleverBackedVectorSearch.test.ts`
- Modify: `native/postgres/qlever_adapter/src/XpodBackedCandidateOperation.hpp`
- Modify: `native/postgres/qlever_adapter/src/XpodBackedTextSearch.hpp`
- Modify: `native/postgres/qlever_adapter/src/XpodBackedVectorSearch.hpp`
- Modify: `docs/superpowers/specs/2026-06-29-qlever-compatible-rdf-physical-backend-protocol-design.md`

- [x] **Step 1: Write failing text/vector feature-gate tests**

Add native smokes where the backend explicitly returns capabilities that do not include the requested candidate feature. Text search must require `XPOD_RDF_BACKEND_FEATURE_TEXT_SEARCH`; vector search must require `XPOD_RDF_BACKEND_FEATURE_VECTOR_SEARCH`.

Expected: FAIL because text/vector operation shells previously delegated directly to estimate/search callbacks.

- [x] **Step 2: Add shared lower-protocol feature gate**

Add a small candidate-operation helper that treats an OK capability response as authoritative and returns `UNSUPPORTED` before estimate/search callbacks when the required feature bit is absent. Missing capability callbacks remain compatible and keep the older callback-driven behavior.

This keeps feature enforcement in the lower data interface; it does not add planner policy or QLever operator replicas.

- [x] **Step 3: Run target verification**

Run:

```bash
bun test tests/native/QleverBackedTextSearch.test.ts tests/native/QleverBackedVectorSearch.test.ts --run
```

Expected: PASS.

### Task 54: Add a QLever-shaped physical index seam over the native backend

**Files:**
- Create: `tests/native/QleverPhysicalIndex.test.ts`
- Create: `native/postgres/qlever_adapter/src/XpodQleverPhysicalIndex.hpp`
- Modify: `docs/superpowers/specs/2026-06-29-qlever-compatible-rdf-physical-backend-protocol-design.md`

- [x] **Step 1: Write a failing physical index smoke**

Add a native smoke that includes `XpodQleverPhysicalIndex.hpp`, constructs it from `PlannerRequestContext`, asks for a `Permutation::Enum::SPO` access object, and executes estimate plus scan through the physical backend.

Expected: FAIL because the QLever-facing lower access surface did not exist.

- [x] **Step 2: Add the minimal native index/permutation seam**

Add a header-only `XpodQleverPhysicalIndex` and `XpodQleverPhysicalPermutation` pair. The seam exposes QLever-shaped `permutation(...).estimate(...)` and `permutation(...).scan(...)` entry points over the existing native backend, query snapshot, source scope, graph scope, access scope, and capability-guarded scan adapter.

This is not another planner or operator bridge. It is the lower access surface that a patched or embedded QLever planner/executor can call instead of reading QLever's own on-disk permutations.

- [x] **Step 3: Add dictionary access to the same seam**

Add a native smoke for `lookupTerm(...)` and `resolveTerm(...)`, and implement both on `XpodQleverPhysicalIndex` using the query snapshot from `PlannerRequestContext`.

Expected: PASS.

- [x] **Step 4: Run target verification**

Run:

```bash
bun test tests/native/QleverPhysicalIndex.test.ts --run
```

Expected: PASS.

### Task 55: Add term prefix-range access to the physical index seam

**Files:**
- Modify: `tests/native/QleverPhysicalIndex.test.ts`
- Modify: `native/postgres/qlever_adapter/src/XpodQleverPhysicalIndex.hpp`
- Modify: `docs/superpowers/specs/2026-06-29-qlever-compatible-rdf-physical-backend-protocol-design.md`

- [x] **Step 1: Write a failing prefix-range smoke**

Extend the physical index native smoke so `XpodQleverPhysicalIndex::prefixRanges(...)` must call the backend `prefix_range` callback with the current query snapshot and requested term kind.

Expected: FAIL because the physical index seam exposed lookup/resolve and permutation scan, but not term prefix ranges.

- [x] **Step 2: Add the minimal prefix-range result seam**

Add `XpodQleverPrefixRangeResult` plus `XpodQleverPhysicalIndex::prefixRanges(...)`. The method only materializes backend term ranges and collation; it does not translate them into planner filters or apply any SPARQL policy.

- [x] **Step 3: Run target verification**

Run:

```bash
bun test tests/native/QleverPhysicalIndex.test.ts --run
```

Expected: PASS.

### Task 56: Add batch dictionary access to the physical index seam

**Files:**
- Modify: `tests/native/QleverPhysicalIndex.test.ts`
- Modify: `native/postgres/qlever_adapter/src/XpodQleverPhysicalIndex.hpp`
- Modify: `docs/superpowers/specs/2026-06-29-qlever-compatible-rdf-physical-backend-protocol-design.md`

- [x] **Step 1: Write a failing batch dictionary smoke**

Extend the physical index native smoke so `XpodQleverPhysicalIndex::lookupTerms(...)` and `resolveTerms(...)` must call the backend batch dictionary callbacks with the current query snapshot and return parallel key/term plus per-item status vectors.

Expected: FAIL because the physical index seam only exposed single-term lookup and resolution.

- [x] **Step 2: Add the minimal batch dictionary result seam**

Add `XpodQleverLookupTermsResult`, `XpodQleverResolveTermsResult`, and corresponding methods on `XpodQleverPhysicalIndex`. Empty batches return OK locally; non-empty batches delegate to the native backend. Do not add fallback loops or planner policy here.

- [x] **Step 3: Run target verification**

Run:

```bash
bun test tests/native/QleverPhysicalIndex.test.ts --run
```

Expected: PASS.

### Task 57: Add exact count and distinct access to the physical permutation seam

**Files:**
- Modify: `tests/native/QleverPhysicalIndex.test.ts`
- Modify: `native/postgres/qlever_adapter/src/XpodQleverPhysicalIndex.hpp`
- Modify: `docs/superpowers/specs/2026-06-29-qlever-compatible-rdf-physical-backend-protocol-design.md`

- [x] **Step 1: Write a failing count/distinct smoke**

Extend the physical index native smoke so `XpodQleverPhysicalPermutation::count(...)` calls the backend `count_scan` callback, and `distinct(...)` calls the backend `distinct_scan` callback for the same permutation, scan pattern, and requested distinct slot.

Expected: FAIL because the physical permutation seam exposed estimate and scan, but not exact count or distinct tuple access.

- [x] **Step 2: Add the minimal count/distinct result seam**

Add `XpodQleverCountResult`, `XpodQleverDistinctTermsResult`, `XpodQleverPhysicalPermutation::count(...)`, and `distinct(...)`. Both methods build native scan requests from `PlannerRequestContext` and delegate to the RDF physical backend. Distinct materializes term-key tuples only; it does not add join planning, grouping policy, or SPARQL modifier behavior.

- [x] **Step 3: Run target verification**

Run:

```bash
bun test tests/native/QleverPhysicalIndex.test.ts --run
```

Expected: PASS.
- No QLever C++ dependency yet.

### Task 58: Add distinct cardinality estimates to the physical permutation seam

**Files:**
- Modify: `tests/native/QleverPhysicalIndex.test.ts`
- Modify: `native/postgres/qlever_adapter/src/XpodQleverPhysicalIndex.hpp`
- Modify: `docs/superpowers/specs/2026-06-29-qlever-compatible-rdf-physical-backend-protocol-design.md`

- [x] **Step 1: Write a failing estimateDistinct smoke**

Extend the physical permutation stats smoke so `XpodQleverPhysicalPermutation::estimateDistinct(...)` must call the backend `estimate_distinct` callback with the same native distinct request shape as `distinct(...)`.

Expected: FAIL because the physical permutation seam exposed exact distinct scans, but not the distinct-cardinality estimate that QLever-style cost planning needs.

- [x] **Step 2: Add the minimal estimateDistinct result seam**

Add `XpodQleverDistinctEstimateResult` and `XpodQleverPhysicalPermutation::estimateDistinct(...)`. Reuse the same distinct request construction as `distinct(...)`, delegate to the native backend, and return the backend estimate unchanged.

- [x] **Step 3: Run target verification**

Run:

```bash
bun test tests/native/QleverPhysicalIndex.test.ts --run
```

Expected: PASS.
- No QLever C++ dependency yet.

### Task 59: Expose QLever id codec and comparator on the physical index seam

**Files:**
- Modify: `tests/native/QleverPhysicalIndex.test.ts`
- Modify: `native/postgres/qlever_adapter/src/XpodQleverPhysicalIndex.hpp`
- Modify: `docs/superpowers/specs/2026-06-29-qlever-compatible-rdf-physical-backend-protocol-design.md`

- [x] **Step 1: Write a failing id codec smoke**

Add a native physical-index smoke so `XpodQleverPhysicalIndex::encodeQleverId(...)`, `decodeQleverId(...)`, and `compareQleverIds(...)` must delegate to the backend QLever id callbacks.

Expected: FAIL because the lower physical index exposed dictionary lookup/resolution but not QLever ValueId encoding, decoding, or semantic comparison.

- [x] **Step 2: Add the minimal codec/comparator wrappers**

Add direct physical-index wrappers over `PhysicalBackend::encodeQleverId(...)`, `decodeQleverId(...)`, and `compareQleverIds(...)`. These are backend data contracts, not planner policy.

- [x] **Step 3: Run target verification**

Run:

```bash
bun test tests/native/QleverPhysicalIndex.test.ts --run
```

Expected: PASS.
- No QLever C++ dependency yet.

### Task 60: Expose backend capability snapshot on the physical index seam

**Files:**
- Modify: `tests/native/QleverPhysicalIndex.test.ts`
- Modify: `native/postgres/qlever_adapter/src/XpodQleverPhysicalIndex.hpp`
- Modify: `docs/superpowers/specs/2026-06-29-qlever-compatible-rdf-physical-backend-protocol-design.md`

- [x] **Step 1: Write a failing capability snapshot smoke**

Add a native physical-index smoke so `XpodQleverPhysicalIndex::capabilitiesStatus()` and `capabilities()` must return the `PlannerRequestContext` capability snapshot.

Expected: FAIL because callers could inspect `context()` directly, but the QLever-facing physical index did not expose a dedicated planner-visible capability surface.

- [x] **Step 2: Add read-only capability accessors**

Add direct read-only accessors for capability status and capabilities. Do not probe backend callbacks or infer support in the physical index; capability negotiation remains owned by `PlannerRequestContext`.

- [x] **Step 3: Run target verification**

Run:

```bash
bun test tests/native/QleverPhysicalIndex.test.ts --run
```

Expected: PASS.
- No QLever C++ dependency yet.

### Task 61: Expose text and vector candidate sources on the physical index seam

**Files:**
- Modify: `tests/native/QleverPhysicalIndex.test.ts`
- Modify: `native/postgres/qlever_adapter/src/XpodQleverPhysicalIndex.hpp`
- Modify: `docs/superpowers/specs/2026-06-29-qlever-compatible-rdf-physical-backend-protocol-design.md`

- [x] **Step 1: Write a failing candidate-source smoke**

Add a native physical-index smoke so `XpodQleverPhysicalIndex::textSearch(...)` and `vectorSearch(...)` must return candidate-source objects whose `estimate()` and `execute()` delegate to backend text/vector callbacks while carrying the current query snapshot, graph scope, source scope, access scope, and cancellation pointer.

Expected: FAIL because text/vector candidate sources existed as separate backed operation shells, but not on the QLever-facing physical index surface.

- [x] **Step 2: Add minimal candidate-source factories**

Add `textSearch(...)` and `vectorSearch(...)` methods that copy the request, apply `PlannerRequestContext`, and return `XpodBackedTextSearch` / `XpodBackedVectorSearch`. This keeps FTS/vector as lower data sources and does not add fusion, ranking, or join planning policy.

- [x] **Step 3: Run target verification**

Run:

```bash
bun test tests/native/QleverPhysicalIndex.test.ts --run
```

Expected: PASS.
- No QLever C++ dependency yet.

### Task 62: Map QLever ScanSpecification into the physical index seam

**Files:**
- Modify: `tests/native/QleverPhysicalIndex.test.ts`
- Modify: `native/postgres/qlever_adapter/src/XpodQleverPhysicalIndex.hpp`
- Modify: `docs/superpowers/specs/2026-06-29-qlever-compatible-rdf-physical-backend-protocol-design.md`

- [x] **Step 1: Write a failing scan-spec smoke**

Add a native physical-index smoke where a QLever-shaped `ScanSpecification` with `col0Id()/col1Id()/col2Id()` must be accepted by `XpodQleverPhysicalIndex` and mapped by the selected `Permutation::Enum` into RDF subject/predicate/object pattern slots.

Expected: FAIL because the physical index seam could scan only from Xpod `TripleKeyPattern`, not from QLever's lower `ScanSpecification` shape.

- [x] **Step 2: Add the minimal lower mapping**

Add `scanSpecificationPattern(...)` plus `estimateScanSpecification(...)` / `scanScanSpecification(...)`. The mapping only translates permutation columns to RDF slots and delegates to the existing physical permutation scan; it does not interpret SPARQL, joins, graph filter policy, or QLever block metadata.

- [x] **Step 3: Run target verification**

Run:

```bash
bun test tests/native/QleverPhysicalIndex.test.ts --run
```

Expected: PASS.
- No QLever C++ dependency yet.

### Task 63: Fail closed for unsupported QLever scan-spec graph filters

**Files:**
- Modify: `tests/native/QleverPhysicalIndex.test.ts`
- Modify: `native/postgres/qlever_adapter/src/XpodQleverPhysicalIndex.hpp`
- Modify: `docs/superpowers/specs/2026-06-29-qlever-compatible-rdf-physical-backend-protocol-design.md`

- [x] **Step 1: Write a failing graph-filter smoke**

Add a native physical-index smoke where a QLever-shaped `ScanSpecification` exposes `graphFilter().areAllGraphsAllowed() == false`. The physical index must return `XPOD_RDF_STATUS_UNSUPPORTED` and must not call backend scan/estimate callbacks.

Expected: FAIL because scan-spec mapping ignored graph filters and could return incorrectly broad results.

- [x] **Step 2: Add the fail-closed guard**

Detect scan-spec graph filters that expose `areAllGraphsAllowed()`. If the filter is not all-graphs, `estimateScanSpecification(...)` and `scanScanSpecification(...)` return `XPOD_RDF_STATUS_UNSUPPORTED` before building a backend scan. This preserves correctness until a later QLever patch can expose whitelist/blacklist values as Xpod graph scope.

- [x] **Step 3: Run target verification**

Run:

```bash
bun test tests/native/QleverPhysicalIndex.test.ts --run
```

Expected: PASS.
- No QLever C++ dependency yet.


### Task 64: Expose histogram hints on the physical index seam

**Files:**
- Modify: `tests/native/QleverPhysicalIndex.test.ts`
- Modify: `native/postgres/qlever_adapter/src/XpodQleverPhysicalIndex.hpp`
- Modify: `docs/superpowers/specs/2026-06-29-qlever-compatible-rdf-physical-backend-protocol-design.md`

- [x] **Step 1: Write a failing histogram smoke**

Add a native physical-index smoke so `XpodQleverPhysicalIndex::histogramHints(...)` must call the backend `histogram_hints` callback with the current query snapshot, graph scope, source scope, access scope, cancellation pointer, RDF slot pattern, requested slots, and max bucket count.

Expected: FAIL because histogram hints existed on the lower `PhysicalBackend`, but not on the QLever-facing physical index surface.

- [x] **Step 2: Add the minimal histogram result seam**

Add `XpodQleverHistogramHintsResult`, a histogram batch collector, and `XpodQleverPhysicalIndex::histogramHints(...)`. The method only builds a native histogram request and materializes backend hints plus stats version; it does not add planning policy or a cost model in Xpod.

- [x] **Step 3: Run target verification**

Run:

```bash
bun test tests/native/QleverPhysicalIndex.test.ts --run
```

Expected: PASS.
- No QLever C++ dependency yet.

### Task 65: Guard histogram hints with the capability snapshot

**Files:**
- Modify: `tests/native/QleverPhysicalIndex.test.ts`
- Modify: `native/postgres/qlever_adapter/src/XpodQleverPhysicalIndex.hpp`

- [x] **Step 1: Write a failing histogram capability smoke**

Add a native physical-index smoke where `PlannerRequestContext.capabilities_status == OK` but `XPOD_RDF_BACKEND_FEATURE_HISTOGRAM_HINTS` is absent. `XpodQleverPhysicalIndex::histogramHints(...)` must return `XPOD_RDF_STATUS_UNSUPPORTED` and must not call backend histogram callbacks.

Expected: FAIL because the histogram seam delegated to the backend callback even when the query capability snapshot said histogram hints were unavailable.

- [x] **Step 2: Add the fail-closed feature guard**

Add a small physical-index feature guard using the existing query capability snapshot. `UNSUPPORTED` capability snapshots retain callback-driven compatibility; explicit OK snapshots without the requested feature fail closed before constructing the backend histogram request.

- [x] **Step 3: Run target verification**

Run:

```bash
bun test tests/native/QleverPhysicalIndex.test.ts --run
```

Expected: PASS.
- No QLever C++ dependency yet.

### Task 66: Expose scoped join-fanout estimates on the physical index seam

**Files:**
- Modify: `tests/native/QleverPhysicalIndex.test.ts`
- Modify: `native/postgres/qlever_adapter/src/XpodQleverPhysicalIndex.hpp`
- Modify: `docs/superpowers/specs/2026-06-29-qlever-compatible-rdf-physical-backend-protocol-design.md`

- [x] **Step 1: Write a failing join-fanout smoke**

Add a native physical-index smoke so `XpodQleverPhysicalIndex::estimateJoinFanout(...)` must call the backend `estimate_join_fanout` callback with the current query snapshot, graph scope, source scope, access scope, cancellation pointer, RDF slot patterns, and bound-slot mask.

Expected: FAIL because join-fanout estimates existed on the lower `PhysicalBackend`, but not on the QLever-facing physical index surface.

- [x] **Step 2: Add the minimal lower estimate seam**

Add `XpodQleverJoinFanoutEstimateResult` and `XpodQleverPhysicalIndex::estimateJoinFanout(...)`. The method converts `TripleKeyPattern` inputs into native quad patterns, copies request scope from `PlannerRequestContext`, and delegates to `PhysicalBackend::estimateJoinFanout(...)`. It does not add planner policy, join ordering, or a cost model in Xpod.

- [x] **Step 3: Run target verification**

Run:

```bash
bun test tests/native/QleverPhysicalIndex.test.ts --run
```

Expected: PASS.
- No QLever C++ dependency yet.

### Task 67: Record the QLever integration ownership boundary

**Files:**
- Modify: `docs/superpowers/specs/2026-06-29-qlever-compatible-rdf-physical-backend-protocol-design.md`
- Modify: `docs/superpowers/plans/2026-06-29-native-first-rdf-physical-protocol.md`

- [x] **Step 1: Make the boundary explicit in the spec**

Record that Xpod only owns the data-layer protocol: dictionary, permutation scans, stats, text/vector candidate sources, source/path scope, ACL/ACR scope, cancellation, snapshots, and profile events.

- [x] **Step 2: Assign upper strategy to QLever**

Record that QLever owns SPARQL parsing, logical/physical planning, join ordering, filter placement, lazy/block execution strategy, modifiers, aggregates, text/fusion strategy, cache policy, and runtime information.

- [x] **Step 3: Freeze Xpod planner growth**

Mark current Xpod operation-plan / parsed-BGP bridges as compatibility spikes and conformance harnesses only. New work should patch or embed QLever against the lower protocol instead of growing a parallel QLever planner in Xpod.

### Task 68: Expose access/source scope utilities on the physical index seam

**Files:**
- Modify: `tests/native/QleverPhysicalIndex.test.ts`
- Modify: `native/postgres/qlever_adapter/src/XpodQleverPhysicalIndex.hpp`
- Modify: `docs/superpowers/specs/2026-06-29-qlever-compatible-rdf-physical-backend-protocol-design.md`

- [x] **Step 1: Write a failing scope smoke**

Add a native physical-index smoke so `XpodQleverPhysicalIndex` must expose `resolveAccessScope(...)`, `estimateAccessScope(...)`, `estimateSourceScope(...)`, and `resolveSourceScope(...)` over the lower `PhysicalBackend` callbacks using the current query snapshot.

Expected: FAIL because the lower `PhysicalBackend` already had these callbacks, but the QLever-facing physical index surface did not expose them.

- [x] **Step 2: Add the minimal lower scope seam**

Add `XpodQleverAccessScopeResult`, `XpodQleverScopeEstimateResult`, `XpodQleverResolvedSourceScopeResult`, and the four physical-index methods. The methods only delegate lower data-protocol scope resolution/estimation; they do not decide ACL/ACR policy or planner strategy in Xpod.

- [x] **Step 3: Run target verification**

Run:

```bash
bun test tests/native/QleverPhysicalIndex.test.ts --run -t "access and source scope"
```

Expected: PASS.
- No QLever C++ dependency yet.

### Task 69: Guard access/source scope utilities with the capability snapshot

**Files:**
- Modify: `tests/native/QleverPhysicalIndex.test.ts`
- Modify: `native/postgres/qlever_adapter/src/XpodQleverPhysicalIndex.hpp`

- [x] **Step 1: Write a failing scope capability smoke**

Add a native physical-index smoke where `PlannerRequestContext.capabilities_status == OK` but `XPOD_RDF_BACKEND_FEATURE_ACCESS_SCOPE` and `XPOD_RDF_BACKEND_FEATURE_SOURCE_SCOPE` are absent. Access/source scope utilities must return `XPOD_RDF_STATUS_UNSUPPORTED` and must not call backend scope callbacks.

Expected: FAIL because the new scope seam delegated to backend callbacks even when the query capability snapshot said scope pushdowns were unavailable.

- [x] **Step 2: Add fail-closed feature guards**

Use the existing physical-index feature guard: access-scope resolution/estimate requires `XPOD_RDF_BACKEND_FEATURE_ACCESS_SCOPE`; source-scope resolution/estimate requires `XPOD_RDF_BACKEND_FEATURE_SOURCE_SCOPE`. `UNSUPPORTED` capability snapshots retain callback-driven compatibility.

- [x] **Step 3: Run target verification**

Run:

```bash
bun test tests/native/QleverPhysicalIndex.test.ts --run -t "scope"
```

Expected: PASS.
- No QLever C++ dependency yet.

### Task 70: Add QLever-shaped scan-spec size/count methods to the physical permutation seam

**Files:**
- Modify: `tests/native/QleverPhysicalIndex.test.ts`
- Modify: `native/postgres/qlever_adapter/src/XpodQleverPhysicalIndex.hpp`
- Modify: `docs/superpowers/specs/2026-06-29-qlever-compatible-rdf-physical-backend-protocol-design.md`

- [x] **Step 1: Write a failing scan-spec size/count smoke**

Add a native physical-index smoke where a QLever-shaped `ScanSpecification` is converted by `XpodQleverPhysicalPermutation::getScanSpecAndBlocks(...)`, then passed to `getSizeEstimateForScan(...)` and `getResultSizeOfScan(...)`.

Expected: FAIL because the physical permutation seam could map and execute scan specifications, but did not expose QLever `Permutation`-shaped size/count methods that `IndexScan::computeSizeEstimate()` and `IndexScan::getExactSize()` expect.

- [x] **Step 2: Add the minimal lower size/count seam**

Add `XpodQleverScanSpecAndBlocks` and `XpodQleverScanSizeBoundsResult`. `getScanSpecAndBlocks(...)` only stores the mapped pattern and needed slots, failing closed for unsupported graph filters. `getSizeEstimateForScan(...)` delegates to backend scan estimates and converts `EXACT` confidence to equal lower/upper bounds; non-exact estimates use `0..rows` as conservative bounds. `getResultSizeOfScan(...)` delegates to backend exact `countScan`.

This is deliberately not compressed block metadata or lazy join strategy. The next QLever lower-layer step is a block/lazy scan protocol that real QLever `IndexScan` can consume without Xpod reimplementing join planning.

- [x] **Step 3: Run target verification**

Run:

```bash
bun test tests/native/QleverPhysicalIndex.test.ts --run -t "scan-spec size"
```

Expected: PASS.
- No upstream QLever C++ dependency yet.

### Task 71: Add scan block metadata to the native physical backend protocol

**Files:**
- Modify: `native/postgres/rdf_protocol/include/xpod_rdf_physical_backend.h`
- Modify: `native/postgres/qlever_adapter/src/XpodPhysicalBackend.hpp`
- Modify: `scripts/check-rdf-physical-protocol-abi.cjs`
- Modify: `tests/native/QleverPhysicalBackendFacade.test.ts`
- Modify: `tests/native/RdfPhysicalBackendProtocolHeader.test.ts`
- Modify: `docs/superpowers/specs/2026-06-29-qlever-compatible-rdf-physical-backend-protocol-design.md`

- [x] **Step 1: Write a failing block-metadata facade smoke**

Add a native physical-backend facade smoke where a backend implements `scan_block_metadata(...)` and returns block ids, first/last quad keys, row counts, sorted slots, total block count, and a metadata version for a scoped scan request.

Expected: FAIL because the C ABI and C++ facade do not expose scan block metadata.

- [x] **Step 2: Add the minimal append-only C ABI and facade method**

Add `xpod_rdf_scan_block_metadata`, `xpod_rdf_scan_block_metadata_batch`, `xpod_rdf_scan_block_metadata_fn`, `XPOD_RDF_BACKEND_FEATURE_BLOCK_METADATA`, and `PhysicalBackend::scanBlockMetadata(...)`.

This is only the lower metadata seam required by QLever lazy scan / block join integration. It does not implement lazy scanning or block join policy in Xpod.

- [x] **Step 3: Run target verification**

Run:

```bash
bun test tests/native/QleverPhysicalBackendFacade.test.ts --run
bun test tests/native/RdfPhysicalBackendProtocolHeader.test.ts --run
bun run check:rdf-protocol-abi
```

Expected: PASS.
- No upstream QLever lazy scan consumer yet.

### Task 72: Surface scan block metadata through the QLever physical permutation seam

**Files:**
- Modify: `native/postgres/qlever_adapter/src/XpodQleverPhysicalIndex.hpp`
- Modify: `tests/native/QleverPhysicalIndex.test.ts`
- Modify: `docs/superpowers/specs/2026-06-29-qlever-compatible-rdf-physical-backend-protocol-design.md`

- [x] **Step 1: Write a failing scan-spec block metadata smoke**

Add a native physical-index smoke where `XpodQleverPhysicalPermutation::getMetadataAndBlocks(...)` must accept a QLever-shaped scan spec, build the same scoped `ScanRequest`, and collect block ids, first/last quad keys, row counts, sorted slots, total block count, and metadata version from the lower `scan_block_metadata` callback.

Expected: FAIL because the physical permutation seam has scan-spec size/count methods but no block metadata method.

- [x] **Step 2: Add the minimal metadata collection seam**

Add `XpodQleverMetadataAndBlocksResult`, a scan block metadata batch collector, and `XpodQleverPhysicalPermutation::getMetadataAndBlocks(...)`. The method delegates only to `PhysicalBackend::scanBlockMetadata(...)`; it does not implement lazy scan or block join policy in Xpod.

- [x] **Step 3: Run target verification**

Run:

```bash
bun test tests/native/QleverPhysicalIndex.test.ts --run -t "block metadata"
bun test tests/native/QleverPhysicalIndex.test.ts --run
```

Expected: PASS.
- No upstream QLever `lazyScan(...)` consumer yet.

### Task 73: Carry selected block metadata through native scan requests

**Files:**
- Modify: `native/postgres/rdf_protocol/include/xpod_rdf_physical_backend.h`
- Modify: `native/postgres/qlever_adapter/src/XpodQleverScanBridge.hpp`
- Modify: `native/postgres/qlever_adapter/src/XpodBackedIndexScan.hpp`
- Modify: `scripts/check-rdf-physical-protocol-abi.cjs`
- Modify: `tests/native/QleverScanBridge.test.ts`
- Modify: `tests/native/QleverBackedIndexScan.test.ts`
- Modify: `tests/native/RdfPhysicalBackendProtocolHeader.test.ts`
- Modify: `docs/superpowers/specs/2026-06-29-qlever-compatible-rdf-physical-backend-protocol-design.md`

- [x] **Step 1: Write failing selected-block scan request smoke**

Extend the scan bridge smoke so `ScanRequestInput` can carry selected `xpod_rdf_scan_block_metadata` rows and a metadata version into `xpod_rdf_scan_request`.

Expected: FAIL because neither the native request struct nor the C++ scan input carries selected block metadata.

- [x] **Step 2: Add the minimal lower request fields**

Add `block_metadata`, `block_metadata_count`, and `block_metadata_version` to `xpod_rdf_scan_request`, plus matching fields in `ScanRequestInput` and `makeScanRequest(...)`.

- [x] **Step 3: Fail closed without block-restricted scan capability**

Add `XPOD_RDF_BACKEND_FEATURE_BLOCK_RESTRICTED_SCAN` and make `XpodBackedIndexScan` return `UNSUPPORTED` when selected block metadata is present but the backend capability snapshot does not declare support.

This is still only lower protocol plumbing. It enables a future QLever `lazyScan(optBlocks)` adapter to pass prefiltered blocks down safely; it does not implement lazy scan strategy in Xpod.

- [x] **Step 4: Run target verification**

Run:

```bash
bun test tests/native/QleverScanBridge.test.ts --run
bun test tests/native/QleverBackedIndexScan.test.ts --run
bun test tests/native/RdfPhysicalBackendProtocolHeader.test.ts --run
bun run check:rdf-protocol-abi
```

Expected: PASS.
- No upstream QLever `lazyScan(...)` consumer yet.

### Task 74: Add a selected-block scan consumer to the QLever physical permutation seam

**Files:**
- Modify: `native/postgres/qlever_adapter/src/XpodQleverPhysicalIndex.hpp`
- Modify: `tests/native/QleverPhysicalIndex.test.ts`
- Modify: `docs/superpowers/specs/2026-06-29-qlever-compatible-rdf-physical-backend-protocol-design.md`

- [x] **Step 1: Write a failing selected-block consumer smoke**

Add a native physical-index smoke where `getMetadataAndBlocks(...)` returns two block metadata rows and `XpodQleverPhysicalPermutation::scanSelectedBlocks(...)` must pass those selected blocks plus the metadata version into the lower `scan_permutation` request.

Expected: FAIL because the physical permutation seam can produce block metadata and the scan bridge can carry it, but no QLever-facing consumer method connects the two.

- [x] **Step 2: Preserve empty selected-block semantics**

Extend the smoke so an empty selected-block list returns an empty IdTable without calling the backend scan. This matches QLever lazy/block-prefilter semantics: an explicit empty selection means no blocks, not a broad scan.

Expected: FAIL until the consumer treats empty selected blocks as an empty result.

- [x] **Step 3: Add the minimal consumer seam**

Add `XpodQleverPhysicalPermutation::scanSelectedBlocks(...)`. It copies selected block metadata and metadata version into `ScanRequestInput`, delegates execution through `XpodBackedIndexScan`, and relies on the existing `BLOCK_RESTRICTED_SCAN` capability guard.

This is deliberately a lower materialized consumer seam, not QLever `lazyScan(...)` itself. QLever still owns block selection, lazy execution strategy, located-triples behavior, and block-zipper joins.

- [x] **Step 4: Run target verification**

Run:

```bash
bun test tests/native/QleverPhysicalIndex.test.ts --run -t "selected scan-spec blocks"
```

Expected: PASS.
- Upstream QLever `lazyScan(...)` is still not consuming this seam yet.

### Task 75: Mirror upstream `Permutation::scan(ScanSpecAndBlocks)` on the physical seam

**Files:**
- Modify: `native/postgres/qlever_adapter/src/XpodQleverPhysicalIndex.hpp`
- Modify: `tests/native/QleverPhysicalIndex.test.ts`
- Modify: `docs/superpowers/specs/2026-06-29-qlever-compatible-rdf-physical-backend-protocol-design.md`

- [x] **Step 1: Extend the scan-spec smoke with an upstream-shaped direct scan**

In the existing scan-spec smoke, call `permutation.scan(scanSpecAndBlocks)` after `getScanSpecAndBlocks(...)` and require it to execute through the same physical scan path.

Expected: FAIL because the physical permutation only accepted `TripleKeyPattern`, not `ScanSpecAndBlocks`.

- [x] **Step 2: Add the minimal overload**

Add `XpodQleverPhysicalPermutation::scan(const XpodQleverScanSpecAndBlocks&)`. It fails through the embedded status when scan-spec construction failed; otherwise it delegates to the existing physical pattern scan using the mapped pattern and needed slots.

This mirrors upstream `Permutation::scan(ScanSpecAndBlocks)` for materialized scans. It does not implement lazy/block strategy.

- [x] **Step 3: Run target verification**

Run:

```bash
bun test tests/native/QleverPhysicalIndex.test.ts --run -t "maps QLever scan specifications"
```

Expected: PASS.
- Upstream QLever `IndexScan::getLazyScan()` still requires the next `lazyScan(optBlocks)` seam.

### Task 76: Expose a lower lazy scan seam that preserves backend scan batches

**Files:**
- Modify: `native/postgres/qlever_adapter/src/XpodQleverIdTableBridge.hpp`
- Modify: `native/postgres/qlever_adapter/src/XpodQleverPhysicalIndex.hpp`
- Modify: `tests/native/QleverPhysicalIndex.test.ts`
- Modify: `docs/superpowers/specs/2026-06-29-qlever-compatible-rdf-physical-backend-protocol-design.md`

- [x] **Step 1: Write a failing lower lazy scan smoke**

Add a native physical-index smoke where `XpodQleverPhysicalPermutation::lazyScan(...)` must accept a scan spec plus QLever-selected block metadata, pass those blocks into the lower physical scan request, and return one `IdTable` per backend scan batch.

Expected: FAIL because the physical permutation seam can run materialized scans and selected-block scans, but has no lower lazy-scan shape.

- [x] **Step 2: Preserve explicit empty block selections**

Require `lazyScan(scanSpec, {})` to return an empty block list without calling the backend scan. This keeps QLever `optBlocks` semantics: an explicit empty block set means no scan, not a broad scan.

Expected: FAIL until the lazy scan seam distinguishes empty selected blocks from unspecified blocks.

- [x] **Step 3: Fail closed without block-restricted scan capability**

Require selected-block lazy scans to return `UNSUPPORTED` and avoid the backend scan when the query capability snapshot is OK but lacks `BLOCK_RESTRICTED_SCAN`.

Expected: FAIL until the lower lazy path uses the same capability contract as selected-block materialized scans.

- [x] **Step 4: Add the minimal lower lazy seam**

Add `QleverIdTableBlocksResult`, a scan-batch-to-`IdTable` collector, and `XpodQleverPhysicalPermutation::lazyScan(...)`. The method keeps backend callback batch boundaries visible as lower scan blocks and delegates all block selection to QLever-provided metadata. It does not implement QLever's upstream `CompressedRelationReader::IdTableGeneratorInputRange`, located-triples handling, block join policy, or runtime lazy materialization strategy.

- [x] **Step 5: Run target verification**

Run:

```bash
bun test tests/native/QleverPhysicalIndex.test.ts --run
```

Expected: PASS.
- This is a lower data-protocol seam. Upstream QLever `IndexScan::getLazyScan()` still needs an adapter from this block result to QLever's native generator/runtime metadata.

### Task 77: Adapt lower lazy scan blocks to QLever's native generator range

**Files:**
- Add: `native/postgres/qlever_adapter/src/XpodQleverLazyScanBridge.hpp`
- Add: `tests/native/QleverLazyScanBridge.test.ts`
- Modify: `docs/superpowers/specs/2026-06-29-qlever-compatible-rdf-physical-backend-protocol-design.md`

- [x] **Step 1: Write a failing generator adapter smoke**

Add a native smoke with a minimal upstream-shaped `CompressedRelationReader::IdTableGeneratorInputRange` stub. The smoke must convert a `QleverIdTableBlocksResult` into that range, read each block via `get()`, and verify `LazyScanMetadata` counters.

Expected: FAIL because lower lazy scan blocks exist but no adapter exposes them as QLever's native generator type.

- [x] **Step 2: Implement the minimal generator adapter**

Add `XpodQleverLazyScanBridge.hpp` with `toQleverLazyScanRange(...)`. It wraps lower `IdTable` blocks in an `ad_utility::InputRangeFromGet<IdTable, CompressedRelationReader::LazyScanMetadata>` implementation when `index/CompressedRelation.h` is available. Non-OK lower statuses return the status and no generator.

- [x] **Step 3: Run target verification**

Run:

```bash
bun test tests/native/QleverLazyScanBridge.test.ts --run
```

Expected: PASS.
- Upstream QLever `IndexScan::getLazyScan()` still needs to call this adapter from the patched/embedded permutation path.

### Task 78: Expose the QLever generator range from the physical permutation seam

**Files:**
- Modify: `native/postgres/qlever_adapter/src/XpodQleverPhysicalIndex.hpp`
- Modify: `tests/native/QleverPhysicalIndex.test.ts`
- Modify: `docs/superpowers/specs/2026-06-29-qlever-compatible-rdf-physical-backend-protocol-design.md`

- [x] **Step 1: Write a failing physical lazy-range smoke**

Extend the physical-index smoke with an upstream-shaped `CompressedRelationReader` stub and require `XpodQleverPhysicalPermutation::lazyScanRange(...)` to return a QLever `IdTableGeneratorInputRange`.

Expected: FAIL because the standalone lower-block adapter exists, but the physical permutation seam does not yet expose it.

- [x] **Step 2: Add the minimal physical adapter method**

Include `XpodQleverLazyScanBridge.hpp` from the physical index and add `lazyScanRange(...)` when `index/CompressedRelation.h` is available. The method simply calls the lower `lazyScan(...)` data seam and adapts the result to QLever's generator range.

- [x] **Step 3: Run target verification**

Run:

```bash
bun test tests/native/QleverPhysicalIndex.test.ts --run -t "lazy scans to QLever generator ranges"
```

Expected: PASS.
- The remaining integration gap is the actual patched/embedded upstream `IndexScan::getLazyScan()` / `Permutation::lazyScan(...)` call path.

### Task 79: Inject the native physical index into QLever planner contexts

**Files:**
- Modify: `native/postgres/qlever_adapter/src/XpodQleverPlannerContextProvider.hpp`
- Modify: `tests/native/QleverExecutorPlannerContextProvider.test.ts`
- Modify: `docs/superpowers/specs/2026-06-29-qlever-compatible-rdf-physical-backend-protocol-design.md`

- [x] **Step 1: Write a failing physical-index context smoke**

Add a native planner-context-provider smoke where the fake upstream `QueryExecutionContext` exposes `setXpodPhysicalIndex(...)` but not `setXpodPlannerRequestContext(...)`. The provider must return a `QueryExecutionContext*`, call the setter, and the received `XpodQleverPhysicalIndex` must be able to perform an estimate through the native backend.

Expected: FAIL because the provider only detected `setXpodPlannerRequestContext(...)`, so contexts that accepted the lower physical index directly were ignored.

- [x] **Step 2: Add the minimal physical-index applier**

Detect `setXpodPhysicalIndex(const XpodQleverPhysicalIndex&)` when the upstream header set is rich enough to include `XpodQleverPhysicalIndex.hpp`. When present, construct the lightweight physical index from the refreshed `PlannerRequestContext`, pass it to the upstream context, and return the `QueryExecutionContext*`. Contexts with no Xpod setter still return only the native request handle.

This is still a data-layer handoff. It does not add planning, joins, modifiers, ranking, or cache policy to Xpod; it gives patched or embedded QLever code a native physical index to call from its own planner/executor objects.

- [x] **Step 3: Run target verification**

Run:

```bash
bun test tests/native/QleverExecutorPlannerContextProvider.test.ts --run -t "physical index"
```

Expected: PASS.
- The next gap is patching or embedding QLever `IndexScan::getLazyScan()` / `Permutation::lazyScan(...)` to fetch this physical index and call `lazyScanRange(...)`.

### Task 80: Add the upstream-shaped lazy scan context bridge

**Files:**
- Add: `native/postgres/qlever_adapter/src/XpodQleverPhysicalIndexScanContextBridge.hpp`
- Add: `tests/native/QleverPhysicalIndexScanContextBridge.test.ts`
- Modify: `docs/superpowers/specs/2026-06-29-qlever-compatible-rdf-physical-backend-protocol-design.md`

- [x] **Step 1: Write a failing context lazy-scan smoke**

Add a native smoke where an upstream-shaped `QueryExecutionContext` stores the injected `XpodQleverPhysicalIndex` and exposes `xpodPhysicalIndex()`. The smoke calls `lazyScanRangeFromContext(...)` with a QLever `ScanSpecification`-shaped object and a selected block, then requires the backend scan request to receive the mapped predicate key, needed slots, and selected block metadata.

Expected: FAIL because there is no context-to-physical-index lazy scan bridge header.

- [x] **Step 2: Add the minimal context bridge**

Add `XpodQleverPhysicalIndexScanContextBridge.hpp` with `physicalIndexFromContext(...)` and `lazyScanRangeFromContext(...)`. The bridge only retrieves the already-injected physical index from an upstream context, maps the QLever scan specification through `XpodQleverPhysicalPermutation::getScanSpecAndBlocks(...)`, and delegates to `lazyScanRange(...)`.

This is intentionally not a planner or executor. It is the small patch target for upstream `Permutation::lazyScan(...)` / `IndexScan::getLazyScan()` code that already owns block selection and lazy execution policy.

- [x] **Step 3: Run target verification**

Run:

```bash
bun test tests/native/QleverPhysicalIndexScanContextBridge.test.ts --run
```

Expected: PASS.
- The remaining gap is applying this bridge inside the real embedded/patched QLever call path instead of calling it from an external smoke.

### Task 81: Add the upstream-shaped `IndexScan::getLazyScan` patch seam

**Files:**
- Modify: `native/postgres/qlever_adapter/src/XpodQleverPhysicalIndexScanContextBridge.hpp`
- Modify: `tests/native/QleverPhysicalIndexScanContextBridge.test.ts`
- Modify: `docs/superpowers/specs/2026-06-29-qlever-compatible-rdf-physical-backend-protocol-design.md`

- [x] **Step 1: Write a failing `IndexScan::getLazyScan`-shaped smoke**

Add a native smoke where a fake upstream `IndexScan::getLazyScan(...)` owns a QLever `ScanSpecAndBlocks`, receives selected `CompressedBlockMetadata`, and calls the Xpod context bridge instead of calling QLever's own permutation files.

Expected: FAIL because the context bridge only accepts a raw `ScanSpecification` plus Xpod block metadata, not QLever's `ScanSpecAndBlocks` and selected `CompressedBlockMetadata` shape.

- [x] **Step 2: Add the minimal conversion seam**

Add `lazyScanRangeFromQleverScanSpecAndBlocks(...)`. It extracts `scanSpec_`, converts QLever selected block metadata into `xpod_rdf_scan_block_metadata`, retrieves the injected physical index from `QueryExecutionContext::xpodPhysicalIndex()`, and delegates to the existing physical lazy range.

This is still a data seam. It does not choose blocks, handle joins, apply modifiers, or rank results; those remain QLever-owned.

- [x] **Step 3: Run target verification**

Run:

```bash
bun test tests/native/QleverPhysicalIndexScanContextBridge.test.ts --run
```

Expected: PASS.
- The remaining gap is applying the equivalent patch to the real upstream QLever source tree / overlay so `IndexScan::getLazyScan(...)` uses this seam in an embedded build.

### Task 82: Support the non-prefiltered `getLazyScan(nullopt)` path

**Files:**
- Modify: `native/postgres/qlever_adapter/src/XpodQleverPhysicalIndexScanContextBridge.hpp`
- Modify: `tests/native/QleverPhysicalIndexScanContextBridge.test.ts`
- Modify: `docs/superpowers/specs/2026-06-29-qlever-compatible-rdf-physical-backend-protocol-design.md`

- [x] **Step 1: Extend the failing smoke to call `getLazyScan(std::nullopt)`**

The upstream `IndexScan::chunkedIndexScan()` path calls `getLazyScan()` without selected prefilter blocks. The smoke now gives `ScanSpecAndBlocks` its own block metadata view and requires `getLazyScan(std::nullopt)` to scan those blocks through the physical backend.

Expected: FAIL because the bridge treats missing selected blocks as unsupported and returns an empty range.

- [x] **Step 2: Convert `ScanSpecAndBlocks` block metadata views**

When selected `CompressedBlockMetadata` is absent, `lazyScanRangeFromQleverScanSpecAndBlocks(...)` now detects `getBlockMetadataView()` and converts that view to Xpod block metadata. If neither selected blocks nor a metadata view are available, it still fails closed.

- [x] **Step 3: Run target verification**

Run:

```bash
bun test tests/native/QleverPhysicalIndexScanContextBridge.test.ts --run
```

Expected: PASS.
- The remaining gap is the real upstream source overlay/patch and limit/offset/column-subset parity.

### Task 83: Add the real upstream `IndexScan::getLazyScan` overlay patch

**Files:**
- Add: `native/postgres/qlever_adapter/patches/qlever-indexscan-physical-lazy-scan.patch`
- Add: `scripts/check-qlever-upstream-patches.cjs`
- Add: `tests/native/QleverUpstreamIndexScanPatch.test.ts`
- Modify: `package.json`
- Modify: `docs/superpowers/specs/2026-06-29-qlever-compatible-rdf-physical-backend-protocol-design.md`

- [x] **Step 1: Write a failing upstream patch asset test**

Add a native patch smoke with an upstream-shaped `src/engine/IndexScan.cpp` fixture. The smoke must run a patch validator, apply the overlay to a temporary QLever source tree, and assert that the patched source contains the Xpod physical lazy scan hook while preserving the original `permutation().lazyScan(...)` fallback.

Expected: FAIL because the patch asset and validator do not exist.

- [x] **Step 2: Add the minimal overlay patch and validator**

Add `qlever-indexscan-physical-lazy-scan.patch` that includes `XpodQleverPhysicalIndexScanContextBridge.hpp` and inserts the Xpod physical lazy scan path immediately after QLever computes `filteredBlocks`. The inserted path delegates to `lazyScanRangeFromQleverScanSpecAndBlocks(...)`, returns the QLever generator range on `OK`, falls back only on `UNSUPPORTED`, and keeps the original QLever `permutation().lazyScan(...)` call intact.

Add `scripts/check-qlever-upstream-patches.cjs` plus `check:qlever-upstream-patches` so a supplied `XPOD_QLEVER_SOURCE_DIR` / `--qlever-source` can verify or apply the overlay without making TypeScript the hot-path protocol.

- [x] **Step 3: Verify against fixture and current upstream source**

Run:

```bash
bun test tests/native/QleverUpstreamIndexScanPatch.test.ts --run
node scripts/check-qlever-upstream-patches.cjs --qlever-source <downloaded-current-qlever-fixture>
```

Expected: PASS.
- The remaining gap is compiling a patched upstream QLever build with the adapter include path and then running a real `QueryPlanner -> IndexScan::getLazyScan -> XpodPhysicalIndex` query instead of only validating the source overlay.

### Task 84: Gate QLever-enabled adapter builds on the upstream lazy-scan overlay

**Files:**
- Modify: `native/postgres/qlever_adapter/CMakeLists.txt`
- Modify: `tests/native/QleverAdapterCmake.test.ts`
- Modify: `docs/superpowers/specs/2026-06-29-qlever-compatible-rdf-physical-backend-protocol-design.md`

- [x] **Step 1: Write a failing CMake source-tree gate test**

Extend the CMake test so a QLever source tree with all required headers but an unpatched `src/engine/IndexScan.cpp` must fail configure with a clear message pointing at `check-qlever-upstream-patches.cjs`.

Expected: FAIL because the existing CMake gate only checks headers and accepts an unpatched source tree.

- [x] **Step 2: Require the overlay hook in QLever mode**

When `XPOD_QLEVER_ADAPTER_ENABLE_QLEVER=ON`, CMake now reads `${XPOD_QLEVER_SOURCE_DIR}/src/engine/IndexScan.cpp` and fails if `lazyScanRangeFromQleverScanSpecAndBlocks` is absent. The accepted-source-tree smoke writes a patched marker, and the adapter target adds the local adapter `src` directory to include paths for QLever-facing bridge headers.

- [x] **Step 3: Run target verification**

Run:

```bash
bun test tests/native/QleverAdapterCmake.test.ts --run
```

Expected: PASS.
- The remaining gap is a real patched upstream QLever compile/e2e; this CMake gate only prevents accidental unpatched source-tree use.

### Task 85: Gate QLever-enabled adapter builds on the upstream QueryExecutionContext overlay

**Files:**
- Add: `native/postgres/qlever_adapter/patches/qlever-queryexecutioncontext-physical-index.patch`
- Add: `tests/native/QleverUpstreamQueryExecutionContextPatch.test.ts`
- Modify: `scripts/check-qlever-upstream-patches.cjs`
- Modify: `native/postgres/qlever_adapter/CMakeLists.txt`
- Modify: `tests/native/QleverAdapterCmake.test.ts`
- Modify: `docs/superpowers/specs/2026-06-29-qlever-compatible-rdf-physical-backend-protocol-design.md`

- [x] **Step 1: Write a failing upstream QueryExecutionContext patch asset test**

Add a native patch smoke with an upstream-shaped `src/engine/QueryExecutionContext.h` fixture. The smoke must run the shared patch validator, apply the overlay to a temporary QLever source tree, and assert that the patched header contains `XpodQleverPhysicalIndex.hpp`, `setXpodPhysicalIndex(...)`, `xpodPhysicalIndex() const`, and the value-owned physical-index storage.

Expected: FAIL before the patch asset exists or applies cleanly.

- [x] **Step 2: Add the context overlay patch and validator entry**

Add `qlever-queryexecutioncontext-physical-index.patch` that includes `XpodQleverPhysicalIndex.hpp`, injects `setXpodPhysicalIndex(...)` next to `getIndex()`, exposes `xpodPhysicalIndex() const` for the upstream lazy-scan patch, and stores the physical index by value so the provider does not hand QLever a dangling pointer. Extend `check-qlever-upstream-patches.cjs` so it validates both upstream overlays by default and can validate either patch explicitly.

- [x] **Step 3: Require the context overlay in QLever mode**

When `XPOD_QLEVER_ADAPTER_ENABLE_QLEVER=ON`, CMake now reads `${XPOD_QLEVER_SOURCE_DIR}/src/engine/QueryExecutionContext.h` and fails if either `setXpodPhysicalIndex` or `xpodPhysicalIndex() const` is absent. The accepted-source-tree CMake smoke writes a minimal patched context, and a separate smoke verifies that a tree with only the IndexScan overlay still fails clearly.

- [x] **Step 4: Run target verification**

Run:

```bash
bun test tests/native/QleverUpstreamQueryExecutionContextPatch.test.ts tests/native/QleverUpstreamIndexScanPatch.test.ts --run
bun test tests/native/QleverAdapterCmake.test.ts --run
node scripts/check-qlever-upstream-patches.cjs --qlever-source <downloaded-current-qlever-fixture> --patch native/postgres/qlever_adapter/patches/qlever-queryexecutioncontext-physical-index.patch --apply
```

Expected: PASS.
- The remaining gap is compiling a patched upstream QLever source tree and running a real `QueryPlanner -> QueryExecutionContext -> IndexScan::getLazyScan -> XpodPhysicalIndex -> native backend` query. Source patch validation and CMake gating now prevent the known half-wired state.

### Task 86: Make real upstream source probes patch the intended tree

**Files:**
- Add: `native/postgres/qlever_adapter/src/gtest/gtest_prod.h`
- Modify: `scripts/check-qlever-upstream-patches.cjs`
- Modify: `tests/native/QleverUpstreamQueryExecutionContextPatch.test.ts`
- Modify: `tests/native/QleverAdapterCmake.test.ts`
- Modify: `docs/superpowers/specs/2026-06-29-qlever-compatible-rdf-physical-backend-protocol-design.md`

- [x] **Step 1: Reproduce the nested-source patching bug**

Download a QLever source tarball into `.test-data/qlever-upstream`, run `check-qlever-upstream-patches.cjs --apply`, and verify that `git apply` reports success while the target files remain unmodified. This happens because `git apply` discovers the parent xpod worktree and treats patch paths relative to the xpod repo root.

Expected: FAIL before the fix; the nested-source regression test sees no `setXpodPhysicalIndex` in the target header.

- [x] **Step 2: Isolate Git discovery and post-apply verification**

Set `GIT_CEILING_DIRECTORIES` for patch commands so a nested QLever source tree is treated as its own patch root, not as a child of the xpod worktree. After `--apply`, reread the target file and require the overlay tokens to be present; this turns future skipped patches into hard failures.

- [x] **Step 3: Remove the first production-build-only test dependency**

Real upstream `QueryExecutionContext.h` includes `<gtest/gtest_prod.h>` for `FRIEND_TEST`. The adapter now provides a local `gtest/gtest_prod.h` shim that expands `FRIEND_TEST` to nothing, so standalone adapter builds do not require QLever's test dependency just to parse production headers.

- [x] **Step 4: Run the real-source probe**

Run:

```bash
curl -L -o .test-data/qlever-upstream.tar.gz https://github.com/ad-freiburg/qlever/archive/refs/heads/master.tar.gz
tar -xzf .test-data/qlever-upstream.tar.gz -C .test-data/qlever-upstream --strip-components=1
node scripts/check-qlever-upstream-patches.cjs --qlever-source .test-data/qlever-upstream --apply
cmake -S native/postgres/qlever_adapter -B .test-data/qlever-real-adapter-build -DXPOD_QLEVER_ADAPTER_ENABLE_QLEVER=ON -DXPOD_QLEVER_SOURCE_DIR=$PWD/.test-data/qlever-upstream
cmake --build .test-data/qlever-real-adapter-build --target xpod_qlever_adapter -j2
```

Expected now:
- Patch application and second validation pass.
- CMake configure passes against the real patched source tree.
- Build advances past missing `gtest/gtest_prod.h`.
- Build currently stops at QLever's real dependency closure, first at `<absl/types/compare.h>`. This should be solved by consuming QLever's dependency targets / dependency prefix, not by adding broad adapter-local Abseil shims.

### Task 87: Compile the QLever adapter against a real patched upstream source tree

**Files:**
- Modify: `native/postgres/qlever_adapter/CMakeLists.txt`
- Modify: `native/postgres/qlever_adapter/src/XpodQleverIdTableBridge.hpp`
- Modify: `native/postgres/qlever_adapter/src/XpodBackedIndexScan.hpp`
- Modify: `native/postgres/qlever_adapter/src/XpodQleverOperationExecutor.hpp`
- Modify: `native/postgres/qlever_adapter/src/XpodQleverOperationIntrospection.hpp`
- Modify: `native/postgres/qlever_adapter/src/XpodQleverOperationPlanBridge.hpp`
- Modify: `tests/native/QleverAdapterCmake.test.ts`
- Modify: `docs/superpowers/specs/2026-06-29-qlever-compatible-rdf-physical-backend-protocol-design.md`

- [x] **Step 1: Lock the real upstream API assumptions in the CMake smoke**

The accepted-source-tree CMake smoke now uses a QLever-shaped `IdTable` constructor that requires `ad_utility::AllocatorWithLimit<Id>` and a patched `QueryExecutionContext` fixture that asserts QLever range backport compile definitions are present. This makes the fake header harness fail when the adapter drifts back to the old single-argument `IdTable(width)` assumption or omits upstream range-mode defines.

Expected: FAIL before the adapter supplies allocator-aware table construction and upstream range-mode compile definitions.

- [x] **Step 2: Mirror QLever compile-mode definitions in adapter CMake**

When `XPOD_QLEVER_ADAPTER_ENABLE_QLEVER=ON`, the adapter still requests C++20, but it now mirrors QLever's compiler-dependent range mode: Clang/AppleClang older than 17 gets `QLEVER_CPP_17 CPP_CXX_CONCEPTS=0`; other C++20 builds get `RANGE_V3_COMBINE_WITH_STD`. This is required because upstream QLever uses range-v3 backports for older Clang standard libraries even when the nominal language standard is C++20.

- [x] **Step 3: Construct QLever IdTables through an allocator-aware helper**

The adapter now creates result and intermediate `IdTable` objects through `makeQleverIdTable(width)`, which supplies a QLever allocator instead of relying on the obsolete one-argument constructor. This aligns the Xpod physical scan and operation bridge with upstream `IdTable{width, allocator}` usage.

- [x] **Step 4: Adjust adapter calls to current upstream public APIs**

`QueryExecutionTree` descriptors are read from the root operation (`getRootOperation()->getDescriptor()`), and child lists for const `Join` planning are obtained through the `Operation` const child accessor instead of calling `Join::getChildren()` directly on a const join. This avoids depending on adapter-local fake APIs that upstream QLever does not expose.

- [x] **Step 5: Run the real-source compile probe**

Run the patched upstream compile probe with QLever's pinned dependency headers:

```bash
cmake -S native/postgres/qlever_adapter -B .test-data/qlever-real-adapter-build \
  -DXPOD_QLEVER_ADAPTER_ENABLE_QLEVER=ON \
  -DXPOD_QLEVER_ADAPTER_BUILD_SHARED=OFF \
  -DXPOD_QLEVER_SOURCE_DIR=$PWD/.test-data/qlever-upstream \
  "-DXPOD_QLEVER_DEPENDENCY_INCLUDE_DIRS=$PWD/.test-data/qlever-deps/abseil;$PWD/.test-data/qlever-deps/range-v3/include;$PWD/.test-data/qlever-deps/uriparser/include;$PWD/.test-data/qlever-deps;$PWD/.test-data/qlever-deps/nlohmann-json/include;$PWD/.test-data/qlever-deps/re2;/opt/homebrew/opt/icu4c/include;$PWD/.test-data/qlever-deps/fsst;$PWD/.test-data/qlever-deps/ctre/single-header"
cmake --build .test-data/qlever-real-adapter-build --target xpod_qlever_adapter -j2
```

Observed: PASS on the local AppleClang 15 environment for the standalone static adapter library. Full upstream QLever CMake still requires Clang++ >= 16, so this probe intentionally validates the Xpod adapter against patched upstream headers and pinned dependency includes rather than configuring the whole QLever project locally.

Remaining gap: this proves the adapter compiles against real upstream APIs. It does not yet prove a real `QueryPlanner -> QueryExecutionContext -> IndexScan::getLazyScan -> XpodPhysicalIndex -> PG/RDF backend` end-to-end query. That e2e remains the next completion gate for “the whole QLever is connected”.

### Task 88: Execute a planner-produced lazy QLever result through the Xpod physical index

**Files:**
- Add: `tests/native/QleverPlannerLazyExecution.test.ts`
- Modify: `native/postgres/qlever_adapter/src/XpodQleverBridge.cpp`
- Modify: `docs/superpowers/specs/2026-06-29-qlever-compatible-rdf-physical-backend-protocol-design.md`

- [x] **Step 1: Add a failing planner/lazy execution gate**

Add a native smoke that builds the QLever-enabled adapter against an upstream-shaped fixture where `QueryPlanner` returns a `QueryExecutionTree` rooted at `IndexScan`. The fake `IndexScan::computeResult(true)` must call `getLazyScan(...)`, and the backend must reject ordinary broad scans unless the request carries the selected block metadata from that lazy scan path.

Expected: FAIL before the bridge executes `QueryExecutionTree::getResult(true)`; the old bridge converts the `IndexScan` back into an Xpod `BridgePhysicalPlan` and calls `scan_permutation` without the QLever-selected block metadata.

- [x] **Step 2: Prefer real QLever tree execution when available**

When the upstream-shaped tree exposes `getResult(true)`, the bridge now asks QLever for a lazy result before falling back to the older bridge operation executor. The result table is materialized from either a fully materialized `Result::idTable()` or a lazy `Result::idTables()` chunk stream, then serialized through the existing dictionary resolution and SPARQL JSON boundary.

- [x] **Step 3: Preserve compatibility with reduced fake headers and fallback plans**

The new execution path is SFINAE-gated on the actual `QueryPlanner::createExecutionTree(...)` return type. Fixtures or builds that do not expose `QueryExecutionTree::getResult(true)` still compile and use the existing parsed/operation bridge fallback. Candidate roots remain excluded from the SPARQL JSON path.

- [x] **Step 4: Run target and real-source verification**

Run:

```bash
bun test tests/native/QleverPlannerLazyExecution.test.ts --run
bun test tests/native --run
cmake -S native/postgres/qlever_adapter -B .test-data/qlever-real-adapter-build \
  -DXPOD_QLEVER_ADAPTER_ENABLE_QLEVER=ON \
  -DXPOD_QLEVER_ADAPTER_BUILD_SHARED=OFF \
  -DXPOD_QLEVER_SOURCE_DIR=$PWD/.test-data/qlever-upstream \
  "-DXPOD_QLEVER_DEPENDENCY_INCLUDE_DIRS=$PWD/.test-data/qlever-deps/abseil;$PWD/.test-data/qlever-deps/range-v3/include;$PWD/.test-data/qlever-deps/uriparser/include;$PWD/.test-data/qlever-deps;$PWD/.test-data/qlever-deps/nlohmann-json/include;$PWD/.test-data/qlever-deps/re2;/opt/homebrew/opt/icu4c/include;$PWD/.test-data/qlever-deps/fsst;$PWD/.test-data/qlever-deps/ctre/single-header"
cmake --build .test-data/qlever-real-adapter-build --target xpod_qlever_adapter -j2
bun run check:rdf-protocol-abi
bun run build:ts
git diff --check
```

Observed: PASS locally. This is the first runtime gate that proves the public adapter can take a planner-produced QLever tree, request lazy execution, and reach the Xpod physical scan seam through `IndexScan::getLazyScan(...)`.

Remaining gap: the runtime gate still uses an upstream-shaped fixture. The real patched upstream QLever source tree currently proves compilation against the same bridge code, but not a full linked upstream QLever server/query execution binary over PG-backed facts. The next gate is either a Linux/Clang>=16 full upstream build or a smaller embedded upstream target that links enough real QLever objects to execute the same query without fake headers.

### Task 89: Make the real upstream engine compile gate explicit

**Files:**
- Add: `native/postgres/qlever_adapter/patches/qlever-libcxx-normalized-string.patch`
- Add: `native/postgres/qlever_adapter/patches/qlever-libcxx-string-sort-comparator.patch`
- Add: `native/postgres/qlever_adapter/patches/qlever-libcxx-string-utils.patch`
- Add: `tests/native/QleverUpstreamLibcxxCompatPatch.test.ts`
- Add: `tests/native/QleverUpstreamNormalizedStringPatch.test.ts`
- Modify: `scripts/check-qlever-upstream-patches.cjs`
- Modify: `native/postgres/qlever_adapter/CMakeLists.txt`
- Modify: `tests/native/QleverAdapterCmake.test.ts`
- Modify: `docs/superpowers/specs/2026-06-29-qlever-compatible-rdf-physical-backend-protocol-design.md`

- [x] **Step 1: Reproduce the real full-engine compile blockers**

Build upstream QLever's real `engine` target after applying the existing Xpod `IndexScan` and `QueryExecutionContext` overlays.

Observed before this task: the build reached upstream libc++ portability errors: `std::basic_string<uint8_t>`, `std::basic_string_view<volatile std::byte>`, and `std::basic_string<NormalizedChar>` do not have portable `std::char_traits` support on the local Clang/libc++ toolchain.

- [x] **Step 2: Add explicit libc++ overlay patch assets**

Add three small upstream overlays:

- `NormalizedString` becomes char-backed `std::string` / `std::string_view`;
- byte sort-key strings become `std::string` / `std::string_view`;
- constant-time string compare uses volatile `unsigned char*` byte loops instead of `std::basic_string_view<volatile std::byte>`.

These are source-tree compatibility patches, not product semantics. They exist so the patched upstream engine can compile far enough to exercise the Xpod lower data seam.

- [x] **Step 3: Make patch validation and adapter CMake reject half-patched trees**

`check-qlever-upstream-patches.cjs` now validates five upstream patches by default. QLever-enabled adapter CMake also checks the libc++ overlay tokens in `NormalizedString.h`, `StringSortComparator.h`, and `StringUtils.h`, so a source tree that can pass the adapter header probe but fail the full upstream engine build is rejected earlier with an actionable message.

- [x] **Step 4: Verify the real upstream engine target**

Run:

```bash
node scripts/check-qlever-upstream-patches.cjs --qlever-source .test-data/qlever-upstream
cmake --build .test-data/qlever-full-build --target engine -j2
cmake --build .test-data/qlever-real-adapter-build --target xpod_qlever_adapter -j2
bun test tests/native --run
bun run check:rdf-protocol-abi
bun run build:ts
bun run test:integration
```

Observed: PASS locally after applying the full patch set and configuring upstream QLever with the Xpod adapter/protocol include paths and `XPOD_QLEVER_ADAPTER_ENABLE_QLEVER=1`. The upstream `engine` target now compiles with the Xpod lower lazy-scan bridge visible.

Remaining gap: this is still a compile/data-interface gate. It does not yet prove a linked real upstream query binary over PG-backed facts. The next gate is to replace the upstream-shaped runtime fixture with a real linked execution path that returns rows through `QueryPlanner -> QueryExecutionTree::getResult(true) -> IndexScan::getLazyScan -> XpodQleverPhysicalIndex -> xpod_rdf_backend_v1`.

### Task 90: Make the full upstream engine gate reproducible

**Files:**
- Add: `scripts/check-qlever-full-engine-build.cjs`
- Add: `tests/native/QleverFullEngineBuildScript.test.ts`
- Modify: `package.json`
- Modify: `docs/superpowers/specs/2026-06-29-qlever-compatible-rdf-physical-backend-protocol-design.md`

- [x] **Step 1: Add a failing script contract test**

Add a native test that requires:

- `package.json` exposes `check:qlever-full-engine`;
- the script can print its CMake plan in `--dry-run --json` mode;
- the printed configure args contain `XPOD_QLEVER_ADAPTER_ENABLE_QLEVER=1` and the adapter/protocol include paths;
- the build target defaults to upstream QLever `engine`;
- missing source configuration fails with `missing --qlever-source or XPOD_QLEVER_SOURCE_DIR`.

Expected: FAIL before the script and package entry exist.

- [x] **Step 2: Implement the native-first full-engine build script**

`scripts/check-qlever-full-engine-build.cjs` now:

- resolves `--qlever-source` / `XPOD_QLEVER_SOURCE_DIR`;
- runs the upstream patch checker before real builds;
- configures upstream QLever with the Xpod adapter/protocol include paths and `XPOD_QLEVER_ADAPTER_ENABLE_QLEVER=1`;
- defaults to `CHEAPER_COMPILATION=ON`, no precompiled headers, no io_uring, and target `engine`;
- supports `--dry-run`, `--json`, `--configure-only`, `--build-only`, `--target`, `--jobs`, and env-driven compiler / prefix / ICU / Boost overrides.

This script is still a build gate, not a product runtime entrypoint.

- [x] **Step 3: Verify against the real local upstream tree**

Run:

```bash
bun test tests/native/QleverFullEngineBuildScript.test.ts --run
node scripts/check-qlever-full-engine-build.cjs \
  --qlever-source .test-data/qlever-upstream \
  --build-dir .test-data/qlever-full-build \
  --target engine \
  --jobs 2
```

Observed: PASS locally. The script now reproduces the previous manual full upstream `engine` build with the Xpod lower data seam visible.

Remaining gap: the next gate is still a linked real-upstream query execution binary over `xpod_rdf_backend_v1`; this task only removes the manual CMake command as a source of drift.

### Task 91: Stabilize full-upstream CMake environment probes

**Files:**
- Modify: `scripts/check-qlever-full-engine-build.cjs`
- Modify: `tests/native/QleverFullEngineBuildScript.test.ts`
- Modify: `docs/superpowers/specs/2026-06-29-qlever-compatible-rdf-physical-backend-protocol-design.md`

- [x] **Step 1: Reproduce the executable-link environment drift**

Running the full upstream script against `--target qlever-server` on local macOS exposed that the previously reproducible `engine` gate was still relying on pre-existing CMake cache state for executable-link dependencies. Two concrete drift points showed up:

- `pkg-config jemalloc` pointed at an x86_64 `/usr/local/Cellar/jemalloc/...` library while the build target was arm64;
- clean CMake build directories needed the Homebrew ICU/prefix hints that were already present in the older cache.

This does not complete the real PG-backed QLever runtime path, but it closes a reproducibility gap before the next real linked query probe.

- [x] **Step 2: Add script contract coverage for link dependency discovery**

`QleverFullEngineBuildScript.test.ts` now covers:

- compatible `pkg-config jemalloc` library dirs are passed through as `CMAKE_EXE_LINKER_FLAGS` for executable targets;
- architecture-incompatible Darwin jemalloc paths are not passed to CMake and the configure environment can quarantine pkg-config to Homebrew arm64 pkg-config roots.

- [x] **Step 3: Make the build script deterministic on local macOS**

`check-qlever-full-engine-build.cjs` now:

- defaults Darwin/Homebrew builds to `CMAKE_PREFIX_PATH=/opt/homebrew;/opt/homebrew/opt/icu4c;/opt/homebrew/opt/openssl@3;/opt/homebrew/opt/boost` when no explicit prefix is supplied;
- defaults `ICU_ROOT` to `/opt/homebrew/opt/icu4c` when available;
- inspects `pkg-config jemalloc` output and rejects architecture-incompatible `libjemalloc.dylib` before it reaches the CMake executable linker flags;
- for incompatible Darwin pkg-config state, runs CMake with `PKG_CONFIG_LIBDIR=/opt/homebrew/lib/pkgconfig:/opt/homebrew/share/pkgconfig` so stale x86_64 `/usr/local` pkg-config entries do not poison fresh configure runs.

- [x] **Step 4: Verify the script gate**

Run:

```bash
bun test tests/native/QleverFullEngineBuildScript.test.ts --run
node scripts/check-qlever-full-engine-build.cjs \
  --qlever-source .test-data/qlever-upstream \
  --build-dir .test-data/qlever-full-build \
  --target engine \
  --jobs 2
```

Observed: PASS locally. A fresh no-jemalloc `qlever-server` build now gets past ICU and stale x86_64 jemalloc discovery, but the clean build was interrupted by a transient GitHub FetchContent download failure for `nlohmann/json`; this is an external dependency fetch issue, not the Xpod physical data seam. The next product gate remains a real linked query execution path over `xpod_rdf_backend_v1`, not the standalone QLever server binary.

### Task 92: Let unprefiltered upstream lazy scans fall through to broad physical scans

**Files:**
- Modify: `native/postgres/qlever_adapter/src/XpodQleverPhysicalIndex.hpp`
- Modify: `native/postgres/qlever_adapter/src/XpodQleverPhysicalIndexScanContextBridge.hpp`
- Modify: `native/postgres/qlever_adapter/patches/qlever-indexscan-physical-lazy-scan.patch`
- Modify: `scripts/check-qlever-upstream-patches.cjs`
- Modify: `native/postgres/qlever_adapter/CMakeLists.txt`
- Modify: `tests/native/QleverPhysicalIndexScanContextBridge.test.ts`
- Modify: `tests/native/QleverUpstreamIndexScanPatch.test.ts`
- Modify: `tests/native/QleverAdapterCmake.test.ts`

- [x] **Step 1: Write a failing broad-lazy context smoke**

Add a native smoke where QLever calls `getLazyScan(std::nullopt)` for a non-prefiltered scan and the `ScanSpecAndBlocks` view has no QLever block metadata. The smoke requires the bridge to run an unrestricted physical lazy scan with `block_metadata_count = 0`, while an explicit empty selected-block vector remains an empty result and must not broaden into a full scan.

Expected: FAIL because `lazyScanRangeFromQleverScanSpecAndBlocks(...)` previously returned `UNSUPPORTED` whenever no selected or embedded block metadata was present.

- [x] **Step 2: Add an unrestricted physical lazy-scan seam**

Add `XpodQleverPhysicalPermutation::lazyScanAll(...)` plus the matching `lazyScanRange(scanSpecAndBlocks)` overload. This validates the permutation capability and delegates to the same physical scan callback path without selected block metadata. It does not require `BLOCK_RESTRICTED_SCAN`, because no selected-block restriction is being requested.

- [x] **Step 3: Preserve selected-empty semantics in the upstream context bridge**

Extend `lazyScanRangeFromQleverScanSpecAndBlocks(...)` with an explicit `allow_unrestricted_when_no_metadata` flag. The bridge now distinguishes three cases:

- selected blocks present: run the block-restricted physical lazy scan;
- selected-block vector explicitly empty: return an empty range, not a broad scan;
- selected blocks absent and no QLever metadata view: run a broad physical lazy scan only when the caller marks the scan as unprefiltered.

- [x] **Step 4: Update the upstream patch and source-tree gate**

The `IndexScan::getLazyScan(...)` overlay passes `!scanSpecAndBlocksIsPrefiltered_` to the bridge after QLever has applied the limit/offset rule to `filteredBlocks`. The patch validator and QLever-enabled adapter CMake gate now require that token so an older lazy-scan overlay cannot silently keep the stricter metadata-only behavior.

- [x] **Step 5: Verify the focused gate**

Run:

```bash
bun test tests/native/QleverPhysicalIndexScanContextBridge.test.ts tests/native/QleverUpstreamIndexScanPatch.test.ts tests/native/QleverAdapterCmake.test.ts --run
```

Observed: PASS locally. This still does not complete the whole QLever runtime integration, but it removes one more dependency on QLever-owned block metadata for plain non-prefiltered lazy scans.

### Task 93: Let real upstream planning reach the Xpod physical seam

**Files:**
- Add: `native/postgres/qlever_adapter/patches/qlever-queryplanner-physical-index.patch`
- Add: `tests/native/QleverUpstreamQueryPlannerPatch.test.ts`
- Modify: `scripts/check-qlever-upstream-patches.cjs`
- Modify: `native/postgres/qlever_adapter/CMakeLists.txt`
- Modify: `tests/native/QleverAdapterCmake.test.ts`
- Modify: `docs/superpowers/specs/2026-06-29-qlever-compatible-rdf-physical-backend-protocol-design.md`

- [x] **Step 1: Lock the upstream planner guard contract**

Add a patch contract requiring the real upstream `QueryPlanner` to tolerate an injected Xpod physical index before QLever-native permutation files are loaded. Without this guard, Xpod-backed execution can fail during planning because QLever sees no native on-disk permutation index even though the data is available through `xpodPhysicalIndex()`.

- [x] **Step 2: Validate the patch in the real-source gates**

Extend the upstream patch validator and QLever-enabled adapter CMake gate so half-patched source trees fail before build or runtime. The source tree must now contain the physical-index planner guard plus the earlier `IndexScan` lazy-scan and text-search overlays.

- [x] **Step 3: Verify planner-source compatibility**

Run:

```bash
bun test tests/native/QleverUpstreamQueryPlannerPatch.test.ts tests/native/QleverAdapterCmake.test.ts --run
bun run check:rdf-protocol-abi
bun run build:ts
bun test tests/native --run
bun run test:integration
```

Observed: PASS locally. This makes real upstream planning able to proceed toward the patched `IndexScan` physical seam in an Xpod-backed context, but it still does not prove a linked real upstream query executable reaches the backend callbacks.

### Task 94: Add a real upstream runtime smoke gate

**Files:**
- Add: `scripts/check-qlever-real-runtime.cjs`
- Add: `tests/native/QleverRealRuntimeBuildScript.test.ts`
- Modify: `package.json`
- Modify: `docs/superpowers/specs/2026-06-29-qlever-compatible-rdf-physical-backend-protocol-design.md`

- [x] **Step 1: Add a failing script contract test**

Add a native test requiring:

- `package.json` exposes `check:qlever-real-runtime`;
- `--dry-run --json` prints the upstream engine build, required upstream library build, real adapter build, compile, link, and run plan;
- compile args inherit platform flags such as `-arch` and `-isysroot` from QLever's generated link line;
- the smoke link step filters out QLever's `libserver.a`, because server executable code is not part of the adapter runtime path;
- missing source configuration fails with `missing --qlever-source or XPOD_QLEVER_SOURCE_DIR`.

Expected: FAIL before the script and package entry exist.

- [x] **Step 2: Implement the linked real-upstream runtime smoke**

The script now:

- builds the patched upstream `engine` through `check:qlever-full-engine`;
- builds the upstream library targets the smoke needs (`qlever`, `SortPerformanceEstimator`, `compilationInfo`) without requiring the standalone `qlever-server` executable target;
- builds the real QLever-enabled Xpod adapter;
- writes and compiles a small executable that links against real upstream parser/planner/runtime objects and `libxpod_qlever_adapter.a`;
- executes `SELECT * WHERE { ?s ?p ?o }` through `xpod_qlever_adapter_query_request(...)`;
- verifies the real execution path reaches `xpod_rdf_backend_v1.scan_permutation` and serializes the expected RDF terms.

- [x] **Step 3: Verify the real runtime gate and full regression set**

Run:

```bash
bun test tests/native/QleverRealRuntimeBuildScript.test.ts --run
bun run check:qlever-real-runtime -- \
  --qlever-source .test-data/qlever-upstream \
  --qlever-build-dir .test-data/qlever-full-build \
  --adapter-build-dir .test-data/qlever-real-adapter-build \
  --runtime-build-dir .test-data/qlever-real-runtime-build \
  --jobs 2
bun test tests/native --run
bun run check:rdf-protocol-abi
bun run build:ts
bun run test:integration
git diff --check
```

Observed: PASS locally. This remains a seam gate over an in-process callback backend, not a production PG dynamic-loader gate or a broad SPARQL conformance suite.


### Task 95: Let real QLever text roots reach Xpod TEXT_SEARCH

**Files:**
- Modify: `native/postgres/qlever_adapter/src/XpodQleverBridge.cpp`
- Modify: `scripts/check-qlever-real-runtime.cjs`
- Modify: `tests/native/QleverRealRuntimeBuildScript.test.ts`
- Modify: `tests/native/QleverOperationBridge.test.ts`
- Modify: `docs/superpowers/specs/2026-06-29-qlever-compatible-rdf-physical-backend-protocol-design.md`

- [x] **Step 1: Add a failing runtime-smoke contract**

The real runtime smoke must no longer prove only BGP. It now writes a second probe for `SELECT * WHERE { ?text ql:contains-word "topic" }`, requires the generated C++ smoke to provide `estimate_text_search` / `text_search`, and verifies the backend observes `state.text_calls` and serializes `urn:text`.

Observed before implementation: the generated smoke had no `TEXT_SEARCH` callback and the new contract failed.

- [x] **Step 2: Materialize supported text candidate roots at the SPARQL facade**

The bridge now executes supported `TextSearch` candidate roots through `executeBridgePhysicalPlan(...)`, projects declared candidate output columns with the backend QLever-id encoder, resolves those ids through the dictionary seam, and writes normal SPARQL JSON bindings. Vector roots and unsupported candidate-root shapes still fail closed because they do not yet have a SPARQL projection contract.

Observed before the fix: the linked real runtime failed with `QLever bridge query produced candidate rows, not SPARQL RDF rows`.

- [x] **Step 3: Verify real upstream text execution**

Run:

```bash
bun test tests/native/QleverRealRuntimeBuildScript.test.ts tests/native/QleverOperationBridge.test.ts tests/native/QleverCandidateOperationBridge.test.ts tests/native/QleverPhysicalTextIndexScanContextBridge.test.ts --run
bun run check:qlever-upstream-patches -- --qlever-source .test-data/qlever-upstream
bun run check:qlever-real-adapter --   --qlever-source .test-data/qlever-upstream   --qlever-build-dir .test-data/qlever-full-build   --adapter-build-dir .test-data/qlever-real-adapter-build
bun run check:qlever-real-runtime --   --qlever-source .test-data/qlever-upstream   --qlever-build-dir .test-data/qlever-full-build   --adapter-build-dir .test-data/qlever-real-adapter-build   --runtime-build-dir .test-data/qlever-real-runtime-build   --skip-prerequisites
bun run build:ts
```

Observed: PASS locally. The smoke still uses an in-process callback backend, but it now proves that real upstream QLever text syntax reaches the Xpod `TEXT_SEARCH` physical data source and returns SPARQL JSON through the public adapter query API.

### Task 96: Let real fixed-entity QLever text search bind through Xpod dictionary

**Files:**
- Add: `native/postgres/qlever_adapter/patches/qlever-text-search-query-physical-fixed-entity.patch`
- Add: `tests/native/QleverUpstreamTextSearchQueryPatch.test.ts`
- Add: `tests/native/QleverBridgeParserContext.test.ts`
- Modify: `native/postgres/qlever_adapter/src/XpodQleverBridge.cpp`
- Modify: `native/postgres/qlever_adapter/src/XpodQleverPhysicalTextIndexScanContextBridge.hpp`
- Modify: `scripts/check-qlever-upstream-patches.cjs`
- Modify: `scripts/check-qlever-real-runtime.cjs`
- Modify: `tests/native/QleverRealRuntimeBuildScript.test.ts`
- Modify: `tests/native/QleverPhysicalTextIndexScanContextBridge.test.ts`
- Modify: `docs/superpowers/specs/2026-06-29-qlever-compatible-rdf-physical-backend-protocol-design.md`
- Modify: `docs/rdf-engine-spec.md`

- [x] **Step 1: Lock the fixed-entity upstream patch contract**

Add a patch for upstream `TextSearchQuery` so an injected Xpod physical index bypasses QLever's native vocab existence check for fixed `ql:contains-entity` values. In Xpod-backed mode, QLever-native vocab is not populated and cannot be used as the source of truth.

Observed before implementation: the real runtime smoke failed with `The entity <urn:entity> is not part of the underlying knowledge graph`.

- [x] **Step 2: Keep upstream parsing from dereferencing a null encoded IRI manager**

The adapter now passes a real `EncodedIriManager` into `SparqlParser::parseQuery(...)`. Fixed IRI text-search terms can therefore pass through upstream parsing without crashing before the physical dictionary bridge sees them.

Observed before implementation: the same smoke could segfault in `EncodedIriManagerImpl::encode(...)` when parsing IRI text-search terms.

- [x] **Step 3: Bind fixed text entities via batch dictionary lookup**

The physical text bridge now resolves fixed entities through `lookupTerms(...)` and then passes the resolved key to `required_entities` for `TEXT_SEARCH` estimates and materialization. The real runtime smoke covers both estimate and materialization callbacks for `ql:contains-word + ql:contains-entity`.

Observed: PASS locally:

```bash
bun test tests/native/QleverRealRuntimeBuildScript.test.ts tests/native/QleverUpstreamTextSearchQueryPatch.test.ts tests/native/QleverBridgeParserContext.test.ts tests/native/QleverPhysicalTextIndexScanContextBridge.test.ts --run
bun run check:qlever-upstream-patches -- --qlever-source .test-data/qlever-upstream
bun run check:qlever-real-runtime -- --qlever-source .test-data/qlever-upstream --qlever-build-dir .test-data/qlever-full-build --adapter-build-dir .test-data/qlever-real-adapter-build --runtime-build-dir .test-data/qlever-real-runtime-build --jobs 2
```

This is still a Cloud Enterprise-only native path. Local deployments do not expose the QLever-compatible adapter; local fixtures here are conformance gates for the Cloud Enterprise protocol.


### Task 97: Prove real RDF/RDF join fallback over Xpod physical scans

**Files:**
- Modify: `scripts/check-qlever-real-runtime.cjs`
- Modify: `native/postgres/qlever_adapter/src/XpodQleverBridge.cpp`
- Modify: `native/postgres/qlever_adapter/src/XpodQleverPlanBridge.hpp`
- Modify: `tests/native/QleverRealRuntimeBuildScript.test.ts`
- Modify: `tests/native/QleverPlanBridge.test.ts`
- Modify: `tests/native/qleverFakeHeaders.ts`
- Modify: `docs/superpowers/specs/2026-06-29-qlever-compatible-rdf-physical-backend-protocol-design.md`

- [x] **Step 1: Add a real linked RDF/RDF join probe**

The real runtime smoke now includes `SELECT ?s ?tail WHERE { ?s ?p ?o . ?o ?p2 ?tail }` over two physical quads. The backend must observe at least two physical scan calls and the public adapter result must contain `urn:s` and `urn:tail`.

Observed before implementation: the smoke failed because upstream QLever attempted to use QLever-native `IndexImpl` distinct statistics for the join path and asserted that all native permutations had not been registered.

- [x] **Step 2: Do not treat upstream native-index stats failure as a public adapter failure**

`executeBridgeQueryWithPlannerContext(...)` now treats native tree execution failure as a signal to continue into the Xpod physical operation plan path. `planBridgeParsedQuery(...)` also catches failures from the QLever planner-output mapping before falling back to the parser-only physical plan. This keeps Xpod-backed execution from depending on QLever-native fact/index metadata that is intentionally not populated.

- [x] **Step 3: Teach parsed two-triple fallback cross-slot joins**

The parsed fallback can now plan a two-triple BGP where the shared variable appears in different RDF slots, such as first object to second subject. It records `join_key_slots` and right-side projection slots so the physical executor can return variables introduced by the second triple.

Observed: PASS locally:

```bash
bun test tests/native/QleverPlanBridge.test.ts tests/native/QleverOperationBridge.test.ts tests/native/QleverRealRuntimeBuildScript.test.ts --run
bun run check:qlever-real-runtime -- --qlever-source .test-data/qlever-upstream --qlever-build-dir .test-data/qlever-full-build --adapter-build-dir .test-data/qlever-real-adapter-build --runtime-build-dir .test-data/qlever-real-runtime-build --jobs 2
```

This is still not a complete QLever join-statistics integration. It is a safety and conformance step: in Xpod-backed Cloud Enterprise mode, QLever-native index metadata is not authoritative, and unsupported native planner/executor attempts must fall through to the Xpod physical protocol rather than surfacing as a 500.


### Task 98: Keep candidate-source runtime Cloud Enterprise-only

**Files:**
- Modify: `native/postgres/qlever_adapter/src/XpodBackedCandidateOperation.hpp`
- Modify: `tests/native/QleverBackedTextSearch.test.ts`
- Modify: `tests/native/QleverBackedVectorSearch.test.ts`
- Modify: `tests/native/QleverCandidateOperationBridge.test.ts`
- Modify: `tests/native/QleverOperationBridge.test.ts`
- Modify: `docs/superpowers/specs/2026-06-29-qlever-compatible-rdf-physical-backend-protocol-design.md`

- [x] **Step 1: Lock missing capability declaration as fail-closed**

Add text/vector candidate smoke tests where the backend provides working search callbacks but no `get_capabilities` declaration. The expected behavior is `XPOD_RDF_STATUS_UNSUPPORTED` and zero estimate/search callback calls.

Observed before implementation: the tests failed because `validateBackendFeatureCapability(...)` treated missing capability callbacks as implicit support.

- [x] **Step 2: Require explicit candidate-source feature bits**

`validateBackendFeatureCapability(...)` now returns `UNSUPPORTED` when `get_capabilities` itself is unsupported. Successful candidate-source fixtures declare `TEXT_SEARCH` / `VECTOR_SEARCH` explicitly. This does not create a local runtime feature; local/native execution remains a conformance harness for the Cloud Enterprise protocol.

- [x] **Step 3: Verify focused candidate-source behavior**

Run:

```bash
bun test tests/native/QleverBackedTextSearch.test.ts tests/native/QleverBackedVectorSearch.test.ts tests/native/QleverCandidateOperationBridge.test.ts tests/native/QleverOperationBridge.test.ts --run
```

Observed: PASS locally. This only verifies the candidate-source capability gate; broader native/QLever runtime verification remains part of the surrounding QLever integration tasks.


### Task 99: Feed real QLever join planning with physical stats and public projection

**Files:**
- Modify: `native/postgres/qlever_adapter/src/XpodQleverPhysicalIndexScanContextBridge.hpp`
- Modify: `native/postgres/qlever_adapter/patches/qlever-indexscan-physical-lazy-scan.patch`
- Modify: `scripts/check-qlever-upstream-patches.cjs`
- Modify: `scripts/check-qlever-real-runtime.cjs`
- Modify: `native/postgres/qlever_adapter/src/XpodQleverOperationBridge.hpp`
- Modify: `native/postgres/qlever_adapter/src/XpodQleverOperationExecutor.hpp`
- Modify: `native/postgres/qlever_adapter/src/XpodQleverOperationPlanBridge.hpp`
- Modify: `native/postgres/qlever_adapter/src/XpodQleverBridge.cpp`
- Modify: `tests/native/QleverPhysicalIndexScanContextBridge.test.ts`
- Modify: `tests/native/QleverUpstreamIndexScanPatch.test.ts`
- Modify: `tests/native/QleverRealRuntimeBuildScript.test.ts`
- Modify: `docs/superpowers/specs/2026-06-29-qlever-compatible-rdf-physical-backend-protocol-design.md`

- [x] **Step 1: Route upstream IndexScan multiplicities through physical distinct estimates**

Add `multiplicitiesFromQleverScanSpecAndBlocks(...)` and patch upstream `IndexScan::determineMultiplicities()` so injected Xpod physical indexes use `estimate_distinct` instead of QLever-native permutation metadata. The helper computes multiplicity from the physical row estimate and the distinct estimate for each projected RDF slot.

Observed before implementation: real QLever RDF/RDF join planning could reach native-index statistics that are not populated in Xpod-backed mode.

- [x] **Step 2: Preserve public SELECT projection for direct QLever tree execution**

The operation-plan path already had a `Project` result modifier, but direct upstream `QueryExecutionTree::getResult(true)` materialization bypassed it. The bridge now applies the parsed `SELECT` projection to the materialized QLever result table before SPARQL JSON serialization, so internal join variables such as `?o`, `?p`, and `?p2` do not leak when the public query asks for `?s ?tail`.

Observed before implementation: the real runtime smoke returned head vars `["o","p","s","p2","tail"]` for `SELECT ?s ?tail ...`.

- [x] **Step 3: Verify linked upstream runtime**

Run:

```bash
bun test tests/native/QleverOperationPlanBridge.test.ts tests/native/QleverOperationBridge.test.ts tests/native/QleverPhysicalIndexScanContextBridge.test.ts tests/native/QleverUpstreamIndexScanPatch.test.ts tests/native/QleverRealRuntimeBuildScript.test.ts --run
bun test tests/native --run
bun run build:ts
git diff --check
bun run check:qlever-real-adapter -- --qlever-source .test-data/qlever-upstream --qlever-build-dir .test-data/qlever-full-build --adapter-build-dir .test-data/qlever-real-adapter-build --jobs 2
bun run check:qlever-real-runtime -- --qlever-source .test-data/qlever-upstream --qlever-build-dir .test-data/qlever-full-build --adapter-build-dir .test-data/qlever-real-adapter-build --runtime-build-dir .test-data/qlever-real-runtime-build --skip-prerequisites
```

Observed: PASS locally after rebuilding the adapter. A stale adapter library reproduced the old projection failure; rebuilding `libxpod_qlever_adapter.a` made the linked smoke pass.
