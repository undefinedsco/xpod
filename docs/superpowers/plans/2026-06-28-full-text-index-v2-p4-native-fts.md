# Full-text Index V2 P4 Native FTS Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fully implement the PostgreSQL native FTS physical backend behind existing `TextMatchSource` semantics and prove it with focused tests plus a performance benchmark gate.

**Architecture:** Keep `RdfTextIndexLike` as the public boundary. Add an opt-in PG-native backend inside `PostgresRdfTextIndex` that maintains derived `rdf_text_fts_pg` rows beside current postings and falls back visibly when native search is unavailable or unsafe. Benchmark native against the current postings backend; do not promote it as default unless the gate passes.

**Tech Stack:** TypeScript, Bun, Vitest, PGlite/PostgreSQL SQL, PostgreSQL `tsvector`/GIN/`websearch_to_tsquery`/`ts_rank_cd`, existing RDF benchmark scripts.

---

### Task 1: Lock PG-native FTS storage and lifecycle behavior

**Files:**
- Modify: `tests/storage/rdf/PostgresRdfTextIndex.test.ts`
- Modify: `src/storage/rdf/types.ts`
- Modify: `src/storage/rdf/PostgresRdfTextIndex.ts`

- [ ] **Step 1: Write failing tests**
  - Add tests for:
    - opt-in `textSearchBackend: 'pg-native-fts'` creates `rdf_text_fts_pg` and GIN index.
    - `indexText()` writes one native row per chunk.
    - `deleteSource()` removes native rows.
    - `moveSource()` changes path/source metadata without rewriting native `updated_at`.

- [ ] **Step 2: Run focused test and verify RED**
  - Run: `bun vitest --run tests/storage/rdf/PostgresRdfTextIndex.test.ts -t "native FTS"`
  - Expected: FAIL because option/table/native lifecycle do not exist.

- [ ] **Step 3: Implement minimal schema/lifecycle**
  - Extend PG text index options with internal backend mode.
  - Create `rdf_text_fts_pg` only when native mode is requested.
  - Upsert native rows from chunk content/heading/path after chunk insert.
  - Ensure cascade/delete cleanup and move-only no-rewrite.

- [ ] **Step 4: Verify GREEN**
  - Run the same focused native lifecycle tests.
  - Expected: PASS.

### Task 2: Implement PG-native search, scoring, and cardinality

**Files:**
- Modify: `tests/storage/rdf/PostgresRdfTextIndex.test.ts`
- Modify: `src/storage/rdf/types.ts`
- Modify: `src/storage/rdf/PostgresRdfTextIndex.ts`

- [ ] **Step 1: Write failing tests**
  - Add tests for:
    - native search returns `pg-ts-rank-cd` score components.
    - workspace/source/path/allowed/denied filters apply before result limit.
    - per-source limit works through native query.
    - CJK/no-space query falls back to postings and remains searchable.
    - `estimateSearchCardinality()` returns native index-choice for supported query and postings fallback for fallback query.

- [ ] **Step 2: Run focused test and verify RED**
  - Run: `bun vitest --run tests/storage/rdf/PostgresRdfTextIndex.test.ts -t "native FTS"`
  - Expected: FAIL on missing native search/score/fallback behavior.

- [ ] **Step 3: Implement native query path**
  - Add backend selector.
  - Add SQL using `websearch_to_tsquery`, `@@`, `ts_rank_cd`, source/entity filters, per-source window, and deterministic tie-breakers.
  - Add fallback for CJK/no-space and capability failures.
  - Preserve existing result hydration.

- [ ] **Step 4: Verify GREEN**
  - Run the same focused tests.
  - Expected: PASS.

### Task 3: Add benchmark switch and native-vs-postings gate

**Files:**
- Modify: `scripts/rdf-postgres-models-benchmark.ts`
- Modify: `scripts/assert-rdf-benchmark-report-gate.ts`
- Modify: `src/storage/rdf/models-benchmark.ts`
- Modify: `tests/api/service/RdfBenchmarkReportGate.test.ts`

- [ ] **Step 1: Write failing benchmark/gate tests**
  - Add a benchmark option/report field for `textSearchBackend`.
  - Add a gate assertion that can require native FTS evidence and native-vs-postings comparison.

- [ ] **Step 2: Run focused gate tests and verify RED**
  - Run: `bun vitest --run tests/api/service/RdfBenchmarkReportGate.test.ts -t "native FTS"`
  - Expected: FAIL because report/gate fields do not exist.

- [ ] **Step 3: Implement benchmark wiring**
  - Allow benchmark script to construct `PostgresRdfTextIndex({ textSearchBackend: 'pg-native-fts' })`.
  - Persist backend choice and native evidence in report.
  - Add gate flag for native text backend and compare against postings baseline where provided.

- [ ] **Step 4: Verify GREEN**
  - Run focused gate tests.
  - Expected: PASS.

### Task 4: Run performance benchmark and final verification

**Files:**
- Generated benchmark artifacts under `.test-data/rdf-engine/`.
- Update implementation report/spec only if the benchmark discovers a boundary change.

- [ ] **Step 1: Run focused implementation tests**
  - Run: `bun vitest --run tests/storage/rdf/PostgresRdfTextIndex.test.ts tests/api/service/RdfBenchmarkReportGate.test.ts`
  - Expected: PASS.

- [ ] **Step 2: Run benchmark baseline and native benchmark**
  - Run postings baseline with current benchmark script.
  - Run native PG FTS benchmark with the new backend switch.
  - Expected: native benchmark reports `pg-native-fts` evidence and broad text/fusion improvement or fails the native gate.

- [ ] **Step 3: Run required regression checks**
  - Run focused RDF/search suite if benchmark passes.
  - Run `bun run build:ts`.
  - Run `git diff --check`.

- [ ] **Step 4: Completion audit**
  - Verify every P4 acceptance item against tests, benchmark artifact, and code.
  - Keep the goal active if benchmark evidence is missing or native remains incomplete.
