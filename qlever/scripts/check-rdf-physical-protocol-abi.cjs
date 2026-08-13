#!/usr/bin/env node
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const repoRoot = path.resolve(__dirname, '..');
const headerPath = path.join(repoRoot, 'rdf_protocol/include/xpod_rdf_physical_backend.h');
const adapterHeaderPath = path.join(repoRoot, 'qlever_adapter/include/xpod_qlever_adapter.h');
const adapterSourcePath = path.join(repoRoot, 'qlever_adapter/src/xpod_qlever_adapter.cpp');
const adapterRoot = path.join(repoRoot, 'qlever_adapter');
const adapterCmakePath = path.join(adapterRoot, 'CMakeLists.txt');

const requiredSymbols = [
  '#define XPOD_RDF_PHYSICAL_BACKEND_ABI_VERSION 7',
  'extern "C"',
  'typedef struct xpod_rdf_backend_v1',
  'typedef struct xpod_rdf_backend_capabilities',
  'uint32_t max_term_tuple_filter_rows',
  'xpod_rdf_backend_capabilities_fn',
  'xpod_rdf_backend_capabilities_fn get_capabilities',
  'XPOD_RDF_PERM_CAP_SPOG',
  'XPOD_RDF_BACKEND_FEATURE_SLOT_RANGES',
  'XPOD_RDF_BACKEND_FEATURE_BLOCK_METADATA',
  'XPOD_RDF_BACKEND_FEATURE_BLOCK_RESTRICTED_SCAN',
  'XPOD_RDF_BACKEND_FEATURE_TERM_TUPLE_FILTER',
  'XPOD_RDF_BACKEND_FEATURE_SCAN_FILTER',
  'xpod_rdf_lookup_term_fn',
  'xpod_rdf_lookup_terms_fn',
  'xpod_rdf_resolve_terms_fn',
  'typedef struct xpod_rdf_cancellation',
  'xpod_rdf_is_cancelled_fn',
  'xpod_rdf_prefix_range_fn',
  'typedef struct xpod_rdf_prefix_range_request',
  'typedef struct xpod_rdf_slot_term_range',
  'const xpod_rdf_slot_term_range* slot_ranges',
  'typedef struct xpod_rdf_histogram_request',
  'typedef struct xpod_rdf_histogram_hint',
  'typedef struct xpod_rdf_histogram_hint_batch',
  'xpod_rdf_histogram_hints_fn',
  'xpod_rdf_scan_permutation_fn',
  'typedef struct xpod_rdf_scan_block_metadata',
  'typedef struct xpod_rdf_scan_block_metadata_batch',
  'typedef struct xpod_rdf_term_tuple_filter',
  'const uint32_t* slots',
  'size_t slot_count',
  'const xpod_rdf_term_key* terms',
  'const xpod_rdf_scan_block_metadata* block_metadata',
  'size_t block_metadata_count',
  'xpod_rdf_bytes block_metadata_version',
  'const xpod_rdf_term_tuple_filter* term_tuple_filter',
  'typedef enum xpod_rdf_scan_filter_kind',
  'typedef struct xpod_rdf_scan_filter',
  'const xpod_rdf_scan_filter* filters',
  'size_t filter_count',
  'xpod_rdf_scan_block_metadata_fn',
  'xpod_rdf_scan_block_metadata_fn scan_block_metadata',
  'typedef struct xpod_rdf_quad',
  'typedef struct xpod_rdf_quad_mutation',
  'typedef struct xpod_rdf_mutation_request',
  'typedef struct xpod_rdf_mutation_result',
  'xpod_rdf_apply_mutation_fn',
  'xpod_rdf_apply_mutation_fn apply_mutation',
  'xpod_rdf_begin_transaction_fn',
  'xpod_rdf_commit_transaction_fn',
  'xpod_rdf_rollback_transaction_fn',
  'xpod_rdf_begin_transaction_fn begin_transaction',
  'xpod_rdf_commit_transaction_fn commit_transaction',
  'xpod_rdf_rollback_transaction_fn rollback_transaction',
  'typedef struct xpod_rdf_load_document_request',
  'typedef struct xpod_rdf_load_document_result',
  'xpod_rdf_load_document_fn',
  'xpod_rdf_load_document_fn load_document',
  'XPOD_RDF_BACKEND_FEATURE_MUTATION',
  'XPOD_RDF_BACKEND_FEATURE_TRANSACTIONS',
  'XPOD_RDF_BACKEND_FEATURE_LOAD_DOCUMENT',
  'typedef struct xpod_rdf_text_search_request',
  'typedef enum xpod_rdf_text_candidate_kind',
  'xpod_rdf_text_candidate_kind candidate_kind',
  'typedef struct xpod_rdf_vector_search_request',
  'xpod_rdf_bytes provider',
  'xpod_rdf_bytes model_version',
  'xpod_rdf_bytes input_kind',
  'xpod_rdf_bytes projection_policy_version',
  'xpod_rdf_graph_scope graph_scope',
  'xpod_rdf_source_scope source_scope',
  'typedef struct xpod_rdf_resolved_source_scope',
  'xpod_rdf_resolve_source_scope_fn',
  'xpod_rdf_resolve_source_scope_fn resolve_source_scope',
  'xpod_rdf_estimate_source_scope_fn',
  'xpod_rdf_estimate_distinct_fn',
  'xpod_rdf_estimate_distinct_fn estimate_distinct',
  'xpod_rdf_estimate_scan_fn',
  'xpod_rdf_text_search_fn',
  'xpod_rdf_vector_search_fn',
  'xpod_rdf_resolve_access_scope_fn',
  'xpod_rdf_encode_qlever_id_fn',
  'xpod_rdf_compare_qlever_ids_fn',
  'XPOD_RDF_TERM_KEY_ENCODING_QLEVER_VALUE_ID_BITS',
  'XPOD_RDF_QLEVER_TERM_ORDER_PRESERVED',
  'xpod_rdf_qlever_term_ordering qlever_term_ordering',
  'xpod_rdf_compare_qlever_ids_fn compare_qlever_ids',
  'xpod_rdf_profile_event_callback',
];

const forbiddenHeaderPatterns = [
  /std::/,
  /namespace\s+/,
  /template\s*</,
  /IndexImpl/,
  /PermutationPtr/,
  /RuntimeInformation/,
  /QLever/,
];

const requiredAdapterHeaderSymbols = [
  '#include "xpod_rdf_physical_backend.h"',
  'extern "C"',
  'typedef struct xpod_qlever_adapter_config',
  'typedef struct xpod_qlever_backend_provider_config',
  'xpod_qlever_backend_provider_create_fn',
  'xpod_qlever_backend_provider_destroy_fn',
  'const xpod_qlever_backend_provider_config* backend_provider',
  'typedef struct xpod_qlever_query_request',
  'typedef struct xpod_qlever_vector_query',
  'xpod_rdf_bytes provider',
  'xpod_rdf_bytes model_version',
  'xpod_rdf_bytes input_kind',
  'xpod_rdf_bytes projection_policy_version',
  'const xpod_rdf_cancellation* cancellation',
  'xpod_rdf_graph_scope graph_scope',
  'xpod_rdf_source_scope source_scope',
  'xpod_qlever_adapter_query_request',
  'xpod_qlever_adapter_create',
  'xpod_qlever_adapter_destroy',
  'xpod_qlever_adapter_abi_version',
];

const forbiddenAdapterHeaderPatterns = [
  /std::/,
  /namespace\s+/,
  /template\s*</,
  /IndexImpl/,
  /PermutationPtr/,
  /RuntimeInformation/,
];

function fail(message, error) {
  console.error(`[rdf-protocol-abi] ${message}`);
  if (error) {
    console.error(error instanceof Error ? error.message : String(error));
  }
  process.exit(1);
}

function commandExists(command) {
  try {
    execFileSync('/usr/bin/env', [command, '--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

if (!fs.existsSync(headerPath)) {
  fail(`missing header: ${path.relative(repoRoot, headerPath)}`);
}

const header = fs.readFileSync(headerPath, 'utf8');
for (const symbol of requiredSymbols) {
  if (!header.includes(symbol)) {
    fail(`header is missing required symbol: ${symbol}`);
  }
}

for (const pattern of forbiddenHeaderPatterns) {
  if (pattern.test(header)) {
    fail(`header leaks forbidden native-boundary token: ${pattern}`);
  }
}

if (!fs.existsSync(adapterHeaderPath)) {
  fail(`missing adapter header: ${path.relative(repoRoot, adapterHeaderPath)}`);
}
if (!fs.existsSync(adapterSourcePath)) {
  fail(`missing adapter source: ${path.relative(repoRoot, adapterSourcePath)}`);
}
if (!fs.existsSync(adapterCmakePath)) {
  fail(`missing adapter CMake target: ${path.relative(repoRoot, adapterCmakePath)}`);
}

const adapterHeader = fs.readFileSync(adapterHeaderPath, 'utf8');
for (const symbol of requiredAdapterHeaderSymbols) {
  if (!adapterHeader.includes(symbol)) {
    fail(`adapter header is missing required symbol: ${symbol}`);
  }
}
for (const pattern of forbiddenAdapterHeaderPatterns) {
  if (pattern.test(adapterHeader)) {
    fail(`adapter header leaks forbidden native-boundary token: ${pattern}`);
  }
}

function replaceRequired(input, search, replacement, description) {
  if (!input.includes(search)) {
    fail(`fixture anchor not found: ${description}`);
  }
  return input.replace(search, replacement);
}

const source = `#include <string.h>\n#include "rdf_protocol/include/xpod_rdf_physical_backend.h"\nint main(void) {\n  xpod_rdf_backend_v1 backend;\n  memset(&backend, 0, sizeof(backend));\n  backend.abi_version = XPOD_RDF_PHYSICAL_BACKEND_ABI_VERSION;\n  backend.struct_size = sizeof(backend);\n  xpod_rdf_cancellation cancellation;\n  memset(&cancellation, 0, sizeof(cancellation));\n  xpod_rdf_text_search_request text_request;\n  memset(&text_request, 0, sizeof(text_request));\n  text_request.graph_scope.kind = XPOD_RDF_GRAPH_SCOPE_EXACT;\n  text_request.cancellation = &cancellation;\n  xpod_rdf_vector_search_request vector_request;\n  memset(&vector_request, 0, sizeof(vector_request));\n  vector_request.graph_scope.kind = text_request.graph_scope.kind;\n  vector_request.cancellation = &cancellation;\n  xpod_rdf_join_fanout_request join_request;\n  memset(&join_request, 0, sizeof(join_request));\n  join_request.graph_scope.kind = vector_request.graph_scope.kind;\n  join_request.cancellation = &cancellation;\n  join_request.source_scope.local_path_prefix.data = "/workspace/";\n  join_request.source_scope.local_path_prefix.size = 11;\n  xpod_rdf_histogram_request histogram_request;\n  memset(&histogram_request, 0, sizeof(histogram_request));\n  histogram_request.graph_scope.kind = join_request.graph_scope.kind;\n  histogram_request.source_scope = join_request.source_scope;\n  histogram_request.slots = XPOD_RDF_SLOT_OBJECT;\n  histogram_request.max_buckets = 8;\n  histogram_request.cancellation = &cancellation;\n  xpod_rdf_histogram_hint hint;\n  memset(&hint, 0, sizeof(hint));\n  hint.slots = histogram_request.slots;\n  xpod_rdf_histogram_hint_batch hint_batch;\n  memset(&hint_batch, 0, sizeof(hint_batch));\n  hint_batch.rows = &hint;\n  hint_batch.row_count = 1;\n  xpod_rdf_scan_block_metadata block_metadata;\n  memset(&block_metadata, 0, sizeof(block_metadata));\n  block_metadata.block_id = 1;\n  block_metadata.sorted_slots = XPOD_RDF_SLOT_SUBJECT;\n  xpod_rdf_scan_block_metadata_batch block_metadata_batch;\n  memset(&block_metadata_batch, 0, sizeof(block_metadata_batch));\n  block_metadata_batch.rows = &block_metadata;\n  block_metadata_batch.row_count = 1;\n  xpod_rdf_scan_request scan_request;\n  memset(&scan_request, 0, sizeof(scan_request));\n  scan_request.block_metadata = &block_metadata;\n  scan_request.block_metadata_count = 1;\n  scan_request.block_metadata_version = block_metadata_batch.metadata_version;\n  xpod_rdf_resolved_source_scope resolved_source_scope;\n  memset(&resolved_source_scope, 0, sizeof(resolved_source_scope));\n  resolved_source_scope.graph_scope.kind = histogram_request.graph_scope.kind;\n  xpod_rdf_backend_capabilities capabilities;\n  memset(&capabilities, 0, sizeof(capabilities));\n  capabilities.supported_permutations = XPOD_RDF_PERM_CAP_SPOG | XPOD_RDF_PERM_CAP_POSG;\n  xpod_rdf_quad_mutation mutation;\n  memset(&mutation, 0, sizeof(mutation));\n  mutation.kind = XPOD_RDF_MUTATION_INSERT;\n  mutation.quad.subject.kind = XPOD_RDF_TERM_IRI;\n  xpod_rdf_mutation_request mutation_request;\n  memset(&mutation_request, 0, sizeof(mutation_request));\n  mutation_request.mutations = &mutation;\n  mutation_request.mutation_count = 1;\n  xpod_rdf_mutation_result mutation_result;\n  memset(&mutation_result, 0, sizeof(mutation_result));\n  mutation_result.inserted_count = 1;\n  xpod_rdf_load_document_request load_request;\n  memset(&load_request, 0, sizeof(load_request));\n  load_request.source_iri.data = "urn:load-src";\n  load_request.source_iri.size = 12;\n  xpod_rdf_load_document_result load_result;\n  memset(&load_result, 0, sizeof(load_result));\n  load_result.media_type.data = "application/n-triples";\n  load_result.media_type.size = 21;\n  capabilities.features = XPOD_RDF_BACKEND_FEATURE_SLOT_RANGES | XPOD_RDF_BACKEND_FEATURE_GRAPH_SCOPE | XPOD_RDF_BACKEND_FEATURE_BLOCK_METADATA | XPOD_RDF_BACKEND_FEATURE_BLOCK_RESTRICTED_SCAN | XPOD_RDF_BACKEND_FEATURE_MUTATION | XPOD_RDF_BACKEND_FEATURE_LOAD_DOCUMENT;\n  backend.resolve_source_scope = 0;\n  backend.estimate_distinct = 0;\n  backend.get_capabilities = 0;\n  backend.scan_block_metadata = 0;\n  backend.apply_mutation = 0;\n  backend.load_document = 0;\n  return backend.abi_version == 2 && hint_batch.rows[0].slots == XPOD_RDF_SLOT_OBJECT && block_metadata_batch.rows[0].block_id == 1 && scan_request.block_metadata_count == 1 && scan_request.block_metadata[0].block_id == 1 && resolved_source_scope.graph_scope.kind == XPOD_RDF_GRAPH_SCOPE_EXACT && mutation_request.mutations[0].kind == XPOD_RDF_MUTATION_INSERT && mutation_result.inserted_count == 1 && load_request.source_iri.size == 12 && load_result.media_type.size == 21 && (capabilities.supported_permutations & XPOD_RDF_PERM_CAP_POSG) != 0 && (capabilities.features & XPOD_RDF_BACKEND_FEATURE_BLOCK_METADATA) != 0 && (capabilities.features & XPOD_RDF_BACKEND_FEATURE_BLOCK_RESTRICTED_SCAN) != 0 && (capabilities.features & XPOD_RDF_BACKEND_FEATURE_MUTATION) != 0 && (capabilities.features & XPOD_RDF_BACKEND_FEATURE_TRANSACTIONS) != 0 && (capabilities.features & XPOD_RDF_BACKEND_FEATURE_LOAD_DOCUMENT) != 0 ? 0 : 1;\n}\n`;
let checkedSource = replaceRequired(
  source,
  '#include <string.h>\n#include "rdf_protocol/include/xpod_rdf_physical_backend.h"\n',
  '#include <stddef.h>\n#include <string.h>\n#include "rdf_protocol/include/xpod_rdf_physical_backend.h"\n#ifndef __cplusplus\n#define XPOD_RDF_STATIC_ASSERT _Static_assert\n#else\n#define XPOD_RDF_STATIC_ASSERT static_assert\n#endif\n\ntypedef struct legacy_xpod_rdf_scan_request {\n  xpod_rdf_snapshot snapshot;\n  const xpod_rdf_cancellation* cancellation;\n  xpod_rdf_permutation permutation;\n  xpod_rdf_quad_pattern pattern;\n  xpod_rdf_graph_scope graph_scope;\n  xpod_rdf_source_scope source_scope;\n  const xpod_rdf_access_scope* access_scope;\n  xpod_rdf_scan_order order;\n  const xpod_rdf_slot_term_range* slot_ranges;\n  size_t slot_range_count;\n  uint64_t limit;\n  uint64_t offset;\n  uint32_t batch_size;\n  uint32_t needed_slots;\n  const xpod_rdf_scan_block_metadata* block_metadata;\n  size_t block_metadata_count;\n  xpod_rdf_bytes block_metadata_version;\n} legacy_xpod_rdf_scan_request;\n\nXPOD_RDF_STATIC_ASSERT(XPOD_RDF_PHYSICAL_BACKEND_ABI_VERSION == 4,\n                       "term tuple filtering requires ABI v4");\nXPOD_RDF_STATIC_ASSERT(XPOD_RDF_BACKEND_FEATURE_TERM_TUPLE_FILTER == (1u << 17),\n                       "term tuple filter feature bit must be 1<<17");\nXPOD_RDF_STATIC_ASSERT(offsetof(xpod_rdf_scan_request, term_tuple_filter) ==\n                           sizeof(legacy_xpod_rdf_scan_request),\n                       "term_tuple_filter must extend scan request append-only");\nXPOD_RDF_STATIC_ASSERT(sizeof(((xpod_rdf_term_tuple_filter*) 0)->slots) ==\n                           sizeof(const uint32_t*),\n                       "term tuple filter slots must be const uint32_t*");\nXPOD_RDF_STATIC_ASSERT(sizeof(((xpod_rdf_term_tuple_filter*) 0)->slot_count) ==\n                           sizeof(size_t),\n                       "term tuple filter slot_count must be size_t");\nXPOD_RDF_STATIC_ASSERT(sizeof(((xpod_rdf_term_tuple_filter*) 0)->terms) ==\n                           sizeof(const xpod_rdf_term_key*),\n                       "term tuple filter terms must be const xpod_rdf_term_key*");\nXPOD_RDF_STATIC_ASSERT(sizeof(((xpod_rdf_term_tuple_filter*) 0)->row_count) ==\n                           sizeof(size_t),\n                       "term tuple filter row_count must be size_t");\n',
  'fixture includes',
);
checkedSource = replaceRequired(
  checkedSource,
  'XPOD_RDF_STATIC_ASSERT(XPOD_RDF_PHYSICAL_BACKEND_ABI_VERSION == 4,',
  'XPOD_RDF_STATIC_ASSERT(XPOD_RDF_PHYSICAL_BACKEND_ABI_VERSION == 7,',
  'ABI v7 fixture assertion',
);
checkedSource = replaceRequired(
  checkedSource,
    'scan_request.block_metadata_version = block_metadata_batch.metadata_version;\n',
    'scan_request.block_metadata_version = block_metadata_batch.metadata_version;\n  const uint32_t tuple_filter_slots[2] = { XPOD_RDF_SLOT_SUBJECT, XPOD_RDF_SLOT_OBJECT };\n  const xpod_rdf_term_key tuple_filter_terms[2] = { 101, 202 };\n  xpod_rdf_term_tuple_filter term_tuple_filter;\n  memset(&term_tuple_filter, 0, sizeof(term_tuple_filter));\n  term_tuple_filter.slots = tuple_filter_slots;\n  term_tuple_filter.slot_count = 2;\n  term_tuple_filter.terms = tuple_filter_terms;\n  term_tuple_filter.row_count = 1;\n  scan_request.term_tuple_filter = &term_tuple_filter;\n',
  'term tuple filter fixture initialization',
);
checkedSource = replaceRequired(
  checkedSource,
    'capabilities.features = XPOD_RDF_BACKEND_FEATURE_SLOT_RANGES | XPOD_RDF_BACKEND_FEATURE_GRAPH_SCOPE | XPOD_RDF_BACKEND_FEATURE_BLOCK_METADATA | XPOD_RDF_BACKEND_FEATURE_BLOCK_RESTRICTED_SCAN | XPOD_RDF_BACKEND_FEATURE_MUTATION | XPOD_RDF_BACKEND_FEATURE_LOAD_DOCUMENT;\n',
    'capabilities.features = XPOD_RDF_BACKEND_FEATURE_SLOT_RANGES | XPOD_RDF_BACKEND_FEATURE_GRAPH_SCOPE | XPOD_RDF_BACKEND_FEATURE_BLOCK_METADATA | XPOD_RDF_BACKEND_FEATURE_BLOCK_RESTRICTED_SCAN | XPOD_RDF_BACKEND_FEATURE_MUTATION | XPOD_RDF_BACKEND_FEATURE_LOAD_DOCUMENT | XPOD_RDF_BACKEND_FEATURE_TERM_TUPLE_FILTER;\n',
  'term tuple filter feature fixture initialization',
);
checkedSource = replaceRequired(
  checkedSource,
    'return backend.abi_version == 2 && hint_batch.rows[0].slots == XPOD_RDF_SLOT_OBJECT',
    'return backend.abi_version == 7 && hint_batch.rows[0].slots == XPOD_RDF_SLOT_OBJECT',
  'ABI v7 fixture return check',
);
checkedSource = replaceRequired(
  checkedSource,
    'scan_request.block_metadata[0].block_id == 1 && resolved_source_scope.graph_scope.kind',
    'scan_request.block_metadata[0].block_id == 1 && scan_request.term_tuple_filter != 0 && scan_request.term_tuple_filter->slot_count == 2 && scan_request.term_tuple_filter->row_count == 1 && scan_request.term_tuple_filter->slots[1] == XPOD_RDF_SLOT_OBJECT && scan_request.term_tuple_filter->terms[0] == 101 && resolved_source_scope.graph_scope.kind',
  'term tuple filter fixture return check',
);
checkedSource = replaceRequired(
  checkedSource,
    '(capabilities.features & XPOD_RDF_BACKEND_FEATURE_LOAD_DOCUMENT) != 0 ? 0 : 1;',
    '(capabilities.features & XPOD_RDF_BACKEND_FEATURE_LOAD_DOCUMENT) != 0 && (capabilities.features & XPOD_RDF_BACKEND_FEATURE_TERM_TUPLE_FILTER) != 0 ? 0 : 1;',
  'term tuple filter feature fixture return check',
);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'xpod-rdf-protocol-abi-'));
try {
  const cFile = path.join(tmp, 'check.c');
  const cppFile = path.join(tmp, 'check.cpp');
  fs.writeFileSync(cFile, checkedSource);
  fs.writeFileSync(cppFile, checkedSource);

  if (commandExists('cc')) {
    execFileSync('cc', ['-std=c11', '-Wall', '-Wextra', '-Werror', '-I', repoRoot, '-fsyntax-only', cFile], { stdio: 'pipe' });
  } else {
    console.warn('[rdf-protocol-abi] warning: cc not found, skipped C syntax check');
  }

  if (commandExists('c++')) {
    execFileSync('c++', ['-std=c++17', '-Wall', '-Wextra', '-Werror', '-I', repoRoot, '-fsyntax-only', cppFile], { stdio: 'pipe' });
    execFileSync('c++', [
      '-std=c++17',
      '-Wall',
      '-Wextra',
      '-Werror',
      '-I', path.join(repoRoot, 'rdf_protocol/include'),
      '-I', path.join(repoRoot, 'qlever_adapter/include'),
      '-I', repoRoot,
      '-fsyntax-only',
      adapterSourcePath,
    ], { stdio: 'pipe' });
  } else {
    console.warn('[rdf-protocol-abi] warning: c++ not found, skipped C++ syntax check');
  }
  if (commandExists('cmake')) {
    const buildDir = path.join(tmp, 'adapter-build');
    execFileSync('cmake', [
      '-S', adapterRoot,
      '-B', buildDir,
    ], { stdio: 'pipe' });
    execFileSync('cmake', [
      '--build', buildDir,
      '--target', 'xpod_qlever_adapter',
    ], { stdio: 'pipe' });
  } else {
    console.warn('[rdf-protocol-abi] warning: cmake not found, skipped adapter target build check');
  }
} catch (error) {
  fail('native RDF protocol ABI check failed', error);
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log('[rdf-protocol-abi] OK: native RDF physical backend C ABI header is valid.');
console.log('[rdf-protocol-abi] OK: QLever adapter facade is valid.');
console.log('[rdf-protocol-abi] OK: QLever adapter CMake target builds.');
