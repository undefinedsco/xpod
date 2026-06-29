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
