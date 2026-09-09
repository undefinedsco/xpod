import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'bun:test';

const repoRoot = path.resolve(__dirname, '../..');
const headerPath = path.join(repoRoot, 'qlever/rdf_protocol/include/xpod_rdf_physical_backend.h');
const nativeAbiCheckTimeoutMs = 30_000;

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

    expect(header).toContain('#define XPOD_RDF_PHYSICAL_BACKEND_ABI_VERSION 7');
    expect(header).toContain('#define XPOD_RDF_SCAN_ORDER_MAX_SLOTS 4');
    expect(header).toContain('#define XPOD_RDF_PHYSICAL_BACKEND_VERSION_MINOR 20');
    expect(header).toContain('extern "C"');
    expect(header).toContain('typedef struct xpod_rdf_backend_v1');
    expect(header).toContain('typedef struct xpod_rdf_backend_capabilities');
    expect(header).toContain('uint32_t max_term_tuple_filter_rows');
    expect(header).toContain('xpod_rdf_backend_capabilities_fn');
    expect(header).toContain('xpod_rdf_backend_capabilities_fn get_capabilities');
    expect(header).toContain('XPOD_RDF_PERM_CAP_SPOG');
    expect(header).toContain('XPOD_RDF_BACKEND_FEATURE_SLOT_RANGES');
    expect(header).toContain('xpod_rdf_lookup_terms_fn');
    expect(header).toContain('xpod_rdf_resolve_terms_fn');
    expect(header).toContain('xpod_rdf_resolve_retrieval_points_fn');
    expect(header).toContain('xpod_rdf_resolve_retrieval_points_fn resolve_retrieval_points');
    expect(header).toContain('typedef struct xpod_rdf_prefix_range_request');
    expect(header).toContain('xpod_rdf_prefix_range_fn');
    expect(header).toContain('typedef struct xpod_rdf_slot_term_range');
    expect(header).toContain('const xpod_rdf_slot_term_range* slot_ranges');
    expect(header).toContain('xpod_rdf_scan_permutation_fn');
    expect(header).toContain('typedef struct xpod_rdf_scan_block_metadata');
    expect(header).toContain('typedef struct xpod_rdf_scan_block_metadata_batch');
    expect(header).toContain('const xpod_rdf_scan_block_metadata* block_metadata');
    expect(header).toContain('size_t block_metadata_count');
    expect(header).toContain('xpod_rdf_bytes block_metadata_version');
    expect(header).toContain('xpod_rdf_scan_block_metadata_fn');
    expect(header).toContain('xpod_rdf_scan_block_metadata_fn scan_block_metadata');
    expect(header).toContain('typedef struct xpod_rdf_quad');
    expect(header).toContain('typedef struct xpod_rdf_quad_mutation');
    expect(header).toContain('typedef struct xpod_rdf_mutation_request');
    expect(header).toContain('typedef struct xpod_rdf_mutation_result');
    expect(header).toContain('xpod_rdf_apply_mutation_fn');
    expect(header).toContain('xpod_rdf_apply_mutation_fn apply_mutation');
    expect(header).toContain('xpod_rdf_begin_transaction_fn');
    expect(header).toContain('xpod_rdf_commit_transaction_fn');
    expect(header).toContain('xpod_rdf_rollback_transaction_fn');
    expect(header).toContain('xpod_rdf_begin_transaction_fn begin_transaction');
    expect(header).toContain('xpod_rdf_commit_transaction_fn commit_transaction');
    expect(header).toContain('xpod_rdf_rollback_transaction_fn rollback_transaction');
    expect(header).toContain('typedef struct xpod_rdf_load_document_request');
    expect(header).toContain('typedef struct xpod_rdf_load_document_result');
    expect(header).toContain('xpod_rdf_load_document_fn');
    expect(header).toContain('xpod_rdf_load_document_fn load_document');
    expect(header).toContain('XPOD_RDF_BACKEND_FEATURE_MUTATION');
    expect(header).toContain('XPOD_RDF_BACKEND_FEATURE_TRANSACTIONS');
    expect(header).toContain('XPOD_RDF_BACKEND_FEATURE_LOAD_DOCUMENT');
    expect(header).toContain('XPOD_RDF_BACKEND_FEATURE_BLOCK_METADATA');
    expect(header).toContain('XPOD_RDF_BACKEND_FEATURE_BLOCK_RESTRICTED_SCAN');
    expect(header).toContain('XPOD_RDF_BACKEND_FEATURE_TEXT_MATCHED_TERM');
    expect(header).toContain('XPOD_RDF_BACKEND_FEATURE_TERM_TUPLE_FILTER');
    expect(header).toContain('XPOD_RDF_BACKEND_FEATURE_SCAN_FILTER');
    expect(header).toContain('XPOD_RDF_BACKEND_FEATURE_SCAN_VALUE_RANGE');
    expect(header).toContain('typedef struct xpod_rdf_term_tuple_filter');
    expect(header).toContain('typedef enum xpod_rdf_scan_filter_kind');
    expect(header).toContain('typedef struct xpod_rdf_scan_filter');
    expect(header).toMatch(
      /typedef struct xpod_rdf_scan_filter[\s\S]*xpod_rdf_term operand;\s*uint8_t has_operand;/,
    );
    expect(header).toMatch(/typedef struct xpod_rdf_term_tuple_filter[\s\S]*const uint32_t\* slots;[\s\S]*size_t slot_count;[\s\S]*const xpod_rdf_term_key\* terms;[\s\S]*size_t row_count;[\s\S]*} xpod_rdf_term_tuple_filter;/);
    expect(header).toMatch(/typedef struct xpod_rdf_scan_request[\s\S]*const xpod_rdf_term_tuple_filter\* term_tuple_filter;\s*const xpod_rdf_scan_filter\* filters;\s*size_t filter_count;\s*} xpod_rdf_scan_request;/);
    expect(header).toContain('typedef uint64_t xpod_rdf_text_term_key');
    expect(header).toMatch(/typedef struct xpod_rdf_candidate[\s\S]*xpod_rdf_bytes scorer;\s*xpod_rdf_bytes source_key;\s*uint8_t has_source_key;\s*xpod_rdf_bytes retrieval_point_key;\s*uint8_t has_retrieval_point_key;[\s\S]*} xpod_rdf_candidate;/);
    expect(header).not.toMatch(/typedef struct xpod_rdf_candidate[\s\S]*matched_term[\s\S]*} xpod_rdf_candidate;/);
    expect(header).toMatch(/typedef struct xpod_rdf_candidate_batch[\s\S]*const xpod_rdf_text_term_key\* matched_terms;[\s\S]*const uint8_t\* has_matched_terms;[\s\S]*} xpod_rdf_candidate_batch;/);
    expect(header).toContain('xpod_rdf_resolve_text_term_fn');
    expect(header).toContain('xpod_rdf_resolve_text_terms_fn');
    expect(header).toContain('xpod_rdf_resolve_text_term_fn resolve_text_term');
    expect(header).toContain('xpod_rdf_resolve_text_terms_fn resolve_text_terms');
    expect(header).toContain('xpod_rdf_source_scope source_scope');
    expect(header).toContain('typedef struct xpod_rdf_resolved_source_scope');
    expect(header).toContain('xpod_rdf_resolve_source_scope_fn');
    expect(header).toContain('xpod_rdf_resolve_source_scope_fn resolve_source_scope');
    expect(header).toContain('xpod_rdf_estimate_source_scope_fn');
    expect(header).toContain('xpod_rdf_estimate_distinct_fn');
    expect(header).toContain('xpod_rdf_estimate_distinct_fn estimate_distinct');
    expect(header).toContain('xpod_rdf_text_search_fn');
    expect(header).toContain('typedef enum xpod_rdf_text_candidate_kind');
    expect(header).toContain('XPOD_RDF_TEXT_CANDIDATE_RECORD');
    expect(header).toContain('XPOD_RDF_TEXT_CANDIDATE_ENTITY');
    expect(header).toContain('xpod_rdf_text_candidate_kind candidate_kind');
    expect(header).toContain('xpod_rdf_vector_search_fn');
    expect(header).toContain('typedef struct xpod_rdf_vector_search_request');
    expect(header).toContain('xpod_rdf_bytes provider');
    expect(header).toContain('xpod_rdf_bytes model_version');
    expect(header).toContain('xpod_rdf_bytes input_kind');
    expect(header).toContain('xpod_rdf_bytes projection_policy_version');
    expect(header).toContain('xpod_rdf_encode_qlever_id_fn');
    expect(header).toContain('xpod_rdf_compare_qlever_ids_fn');
    expect(header).toContain('XPOD_RDF_TERM_KEY_ENCODING_QLEVER_VALUE_ID_BITS');
    expect(header).toContain('XPOD_RDF_QLEVER_TERM_ORDER_PRESERVED');
    expect(header).toContain('xpod_rdf_qlever_term_ordering qlever_term_ordering');
    expect(header).toContain('xpod_rdf_compare_qlever_ids_fn compare_qlever_ids');
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
      const source = `#include <string.h>\n#include "qlever/rdf_protocol/include/xpod_rdf_physical_backend.h"\nint main(void) {\n  xpod_rdf_backend_v1 backend;\n  memset(&backend, 0, sizeof(backend));\n  backend.abi_version = XPOD_RDF_PHYSICAL_BACKEND_ABI_VERSION;\n  return backend.abi_version == 7 ? 0 : 1;\n}\n`;
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

  it('keeps the candidate prefix layout ABI-compatible while gating its tail', async () => {
    const cc = compiler('cc');
    expect(cc, 'cc compiler is required for native ABI layout check').toBeTruthy();

    const root = await mkdtemp(path.join(os.tmpdir(), 'xpod-rdf-candidate-abi-'));
    try {
      const source = path.join(root, 'candidate-layout.c');
      await writeFile(source, `
#include <stddef.h>
#include "qlever/rdf_protocol/include/xpod_rdf_physical_backend.h"

typedef struct legacy_xpod_rdf_candidate {
  xpod_rdf_source_node_key source_node;
  uint8_t has_source_node;
  xpod_rdf_retrieval_point_key retrieval_point;
  uint8_t has_retrieval_point;
  xpod_rdf_term_key resource_term;
  uint8_t has_resource_term;
  double score;
  xpod_rdf_source_range range;
  xpod_rdf_bytes scorer;
} legacy_xpod_rdf_candidate;

typedef struct legacy_xpod_rdf_candidate_batch {
  const legacy_xpod_rdf_candidate* rows;
  size_t row_count;
  uint64_t scanned_rows;
  xpod_rdf_bytes scorer;
} legacy_xpod_rdf_candidate_batch;

_Static_assert(
    offsetof(xpod_rdf_candidate, source_key) ==
        sizeof(legacy_xpod_rdf_candidate),
    "stable source key must extend candidate row append-only");
_Static_assert(
    offsetof(xpod_rdf_candidate, retrieval_point_key) >
        offsetof(xpod_rdf_candidate, source_key),
    "stable retrieval point key must follow source key");
_Static_assert(
    offsetof(xpod_rdf_candidate_batch, matched_terms) ==
        sizeof(legacy_xpod_rdf_candidate_batch),
    "matched text terms must extend the batch, not candidate row stride");
_Static_assert(XPOD_RDF_PHYSICAL_BACKEND_ABI_VERSION == 7,
               "native protocol header should expose the current ABI");
_Static_assert(XPOD_RDF_BACKEND_FEATURE_TEXT_MATCHED_TERM !=
                   XPOD_RDF_BACKEND_FEATURE_TEXT_SEARCH,
               "matched text terms need a dedicated capability");

int main(void) { return 0; }
`, 'utf8');
      execFileSync(cc!, [
        '-std=c11', '-Wall', '-Wextra', '-Werror', '-I', repoRoot,
        '-fsyntax-only', source,
      ], { stdio: 'pipe' });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it('extends scan requests append-only with term tuple filtering', async () => {
    const cc = compiler('cc');
    expect(cc, 'cc compiler is required for native ABI layout check').toBeTruthy();

    const root = await mkdtemp(path.join(os.tmpdir(), 'xpod-rdf-scan-filter-abi-'));
    try {
      const source = path.join(root, 'scan-filter-layout.c');
      await writeFile(source, `
#include <stddef.h>
#include "qlever/rdf_protocol/include/xpod_rdf_physical_backend.h"

typedef struct legacy_xpod_rdf_scan_request {
  xpod_rdf_snapshot snapshot;
  const xpod_rdf_cancellation* cancellation;
  xpod_rdf_permutation permutation;
  xpod_rdf_quad_pattern pattern;
  xpod_rdf_graph_scope graph_scope;
  xpod_rdf_source_scope source_scope;
  const xpod_rdf_access_scope* access_scope;
  xpod_rdf_scan_order order;
  const xpod_rdf_slot_term_range* slot_ranges;
  size_t slot_range_count;
  uint64_t limit;
  uint64_t offset;
  uint32_t batch_size;
  uint32_t needed_slots;
  const xpod_rdf_scan_block_metadata* block_metadata;
  size_t block_metadata_count;
  xpod_rdf_bytes block_metadata_version;
} legacy_xpod_rdf_scan_request;

_Static_assert(XPOD_RDF_PHYSICAL_BACKEND_ABI_VERSION == 7,
               "stable candidate identity requires ABI v7");
_Static_assert(XPOD_RDF_BACKEND_FEATURE_TERM_TUPLE_FILTER == (1u << 17),
               "term tuple filtering must use the next append-only feature bit");
_Static_assert(
    offsetof(xpod_rdf_scan_request, term_tuple_filter) ==
        sizeof(legacy_xpod_rdf_scan_request),
    "term_tuple_filter must extend xpod_rdf_scan_request append-only");
_Static_assert(sizeof(((xpod_rdf_term_tuple_filter*) 0)->slots) ==
                   sizeof(const uint32_t*),
               "term tuple filter slots must be a uint32_t slot array");
_Static_assert(sizeof(((xpod_rdf_term_tuple_filter*) 0)->slot_count) ==
                   sizeof(size_t),
               "term tuple filter slot_count must be size_t");
_Static_assert(sizeof(((xpod_rdf_term_tuple_filter*) 0)->terms) ==
                   sizeof(const xpod_rdf_term_key*),
               "term tuple filter terms must be a term-key array");
_Static_assert(sizeof(((xpod_rdf_term_tuple_filter*) 0)->row_count) ==
                   sizeof(size_t),
               "term tuple filter row_count must be size_t");

typedef struct legacy_v4_xpod_rdf_scan_request {
  legacy_xpod_rdf_scan_request base;
  const xpod_rdf_term_tuple_filter* term_tuple_filter;
} legacy_v4_xpod_rdf_scan_request;

_Static_assert(XPOD_RDF_BACKEND_FEATURE_SCAN_FILTER == (1u << 18),
               "scan filtering must use the next append-only feature bit");
_Static_assert(
    offsetof(xpod_rdf_scan_request, filters) ==
        sizeof(legacy_v4_xpod_rdf_scan_request),
    "filters must extend the ABI v4 scan request append-only");
_Static_assert(sizeof(((xpod_rdf_scan_request*) 0)->filter_count) ==
                   sizeof(size_t),
               "filter_count must be size_t");

int main(void) { return 0; }
`, 'utf8');
      execFileSync(cc!, [
        '-std=c11', '-Wall', '-Wextra', '-Werror', '-I', repoRoot,
        '-fsyntax-only', source,
      ], { stdio: 'pipe' });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('has a repository ABI check command for the native protocol header', () => {
    const scriptPath = path.join(repoRoot, 'qlever/scripts/check-rdf-physical-protocol-abi.cjs');
    expect(existsSync(scriptPath)).toBe(true);
    execFileSync(process.execPath, [scriptPath], { cwd: repoRoot, stdio: 'pipe' });
  }, nativeAbiCheckTimeoutMs);

});
