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
