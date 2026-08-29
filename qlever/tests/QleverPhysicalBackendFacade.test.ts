import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'bun:test';

const repoRoot = path.resolve(__dirname, '../..');
const facadeHeader = path.join(repoRoot, 'qlever/qlever_adapter/src/XpodPhysicalBackend.hpp');

function hasCxx(): boolean {
  try {
    execFileSync('/usr/bin/env', ['c++', '--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

describe('QLever adapter physical backend facade', () => {
  it('gates optional pull cursor callbacks behind appended ABI fields', async () => {
    expect(hasCxx(), 'c++ compiler is required for native scan cursor facade check').toBe(true);

    const root = await mkdtemp(path.join(os.tmpdir(), 'xpod-qlever-scan-cursor-facade-'));
    try {
      const source = path.join(root, 'check.cpp');
      const binary = path.join(root, 'check');
      await writeFile(source, `
#include "XpodPhysicalBackend.hpp"

#include <cstddef>

static_assert(
    XPOD_RDF_STATUS_OK == 0 &&
    XPOD_RDF_STATUS_NOT_FOUND == 1 &&
    XPOD_RDF_STATUS_UNSUPPORTED == 2 &&
    XPOD_RDF_STATUS_CANCELLED == 3 &&
    XPOD_RDF_STATUS_PERMISSION_DENIED == 4 &&
    XPOD_RDF_STATUS_STALE_STATS == 5 &&
    XPOD_RDF_STATUS_DONE == 6 &&
    XPOD_RDF_STATUS_BACKEND_ERROR == 100,
    "status values must remain stable with DONE appended in the existing gap");
static_assert(
    offsetof(xpod_rdf_backend_v1, open_scan_cursor) >
        offsetof(xpod_rdf_backend_v1, encode_qlever_ids),
    "cursor callbacks must be appended after encode_qlever_ids");
static_assert(
    offsetof(xpod_rdf_backend_v1, next_scan_cursor) >
        offsetof(xpod_rdf_backend_v1, open_scan_cursor),
    "next_scan_cursor must follow open_scan_cursor");
static_assert(
    offsetof(xpod_rdf_backend_v1, close_scan_cursor) >
        offsetof(xpod_rdf_backend_v1, next_scan_cursor),
    "close_scan_cursor must follow next_scan_cursor");

struct State {
  int open_calls = 0;
  int next_calls = 0;
  int close_calls = 0;
  const xpod_rdf_scan_request* opened_request = nullptr;
};

struct Cursor {
  State* state;
  xpod_rdf_quad_key rows[2];
};

static xpod_rdf_status fail_open(
    void*,
    const xpod_rdf_scan_request*,
    xpod_rdf_scan_cursor**) {
  return XPOD_RDF_STATUS_BACKEND_ERROR;
}

static xpod_rdf_status open_cursor(
    void* backend_user_data,
    const xpod_rdf_scan_request* request,
    xpod_rdf_scan_cursor** out) {
  State* state = static_cast<State*>(backend_user_data);
  ++state->open_calls;
  state->opened_request = request;
  static Cursor cursor;
  cursor.state = state;
  cursor.rows[0] = {11, 12, 13, 14};
  cursor.rows[1] = {21, 22, 23, 24};
  *out = reinterpret_cast<xpod_rdf_scan_cursor*>(&cursor);
  return XPOD_RDF_STATUS_OK;
}

static xpod_rdf_status next_cursor(
    void* backend_user_data,
    xpod_rdf_scan_cursor* opaque_cursor,
    xpod_rdf_quad_batch* out) {
  State* state = static_cast<State*>(backend_user_data);
  Cursor* cursor = reinterpret_cast<Cursor*>(opaque_cursor);
  if (cursor == nullptr || cursor->state != state) {
    return XPOD_RDF_STATUS_BACKEND_ERROR;
  }
  ++state->next_calls;
  if (state->next_calls == 1) {
    out->rows = cursor->rows;
    out->row_count = 2;
    out->sorted_slots = XPOD_RDF_SLOT_SUBJECT | XPOD_RDF_SLOT_PREDICATE;
    out->scanned_rows = 9;
    return XPOD_RDF_STATUS_OK;
  }
  return XPOD_RDF_STATUS_DONE;
}

static void close_cursor(void* backend_user_data, xpod_rdf_scan_cursor* opaque_cursor) {
  State* state = static_cast<State*>(backend_user_data);
  if (opaque_cursor != nullptr) {
    ++state->close_calls;
  }
}

int main() {
  State state;
  xpod_rdf_scan_request request = {};
  request.permutation = XPOD_RDF_PERM_POSG;
  request.batch_size = 123;
  xpod_rdf_scan_cursor* cursor = reinterpret_cast<xpod_rdf_scan_cursor*>(0x1);
  xpod_rdf_quad_batch batch = {};
  batch.rows = reinterpret_cast<const xpod_rdf_quad_key*>(0x2);
  batch.row_count = 77;

  xpod_rdf_backend_v1 legacy = {};
  legacy.abi_version = XPOD_RDF_PHYSICAL_BACKEND_ABI_VERSION;
  legacy.struct_size = offsetof(xpod_rdf_backend_v1, open_scan_cursor);
  legacy.backend_user_data = &state;
  legacy.open_scan_cursor = fail_open;
  xpod::rdf::PhysicalBackend legacy_physical(&legacy);
  if (legacy_physical.hasScanCursor()) return 1;
  if (legacy_physical.openScanCursor(request, cursor) != XPOD_RDF_STATUS_UNSUPPORTED) return 2;
  if (cursor != nullptr) return 3;
  if (legacy_physical.nextScanCursor(reinterpret_cast<xpod_rdf_scan_cursor*>(0x3), batch) !=
      XPOD_RDF_STATUS_UNSUPPORTED) return 4;
  if (batch.rows != nullptr || batch.row_count != 0 ||
      batch.sorted_slots != 0 || batch.scanned_rows != 0) return 5;
  legacy_physical.closeScanCursor(reinterpret_cast<xpod_rdf_scan_cursor*>(0x4));
  if (state.open_calls != 0 || state.next_calls != 0 || state.close_calls != 0) return 6;

  xpod_rdf_backend_v1 current = {};
  current.abi_version = XPOD_RDF_PHYSICAL_BACKEND_ABI_VERSION;
  current.struct_size = sizeof(xpod_rdf_backend_v1);
  current.backend_user_data = &state;
  current.open_scan_cursor = open_cursor;
  current.next_scan_cursor = next_cursor;
  current.close_scan_cursor = close_cursor;
  xpod::rdf::PhysicalBackend physical(&current);
  if (!physical.hasScanCursor()) return 7;
  if (physical.openScanCursor(request, cursor) != XPOD_RDF_STATUS_OK) return 8;
  if (cursor == nullptr || state.open_calls != 1 || state.opened_request != &request) return 9;
  if (physical.nextScanCursor(cursor, batch) != XPOD_RDF_STATUS_OK) return 10;
  if (batch.rows == nullptr || batch.row_count != 2 ||
      batch.rows[0].subject != 11 || batch.rows[1].object != 23 ||
      batch.sorted_slots != (XPOD_RDF_SLOT_SUBJECT | XPOD_RDF_SLOT_PREDICATE) ||
      batch.scanned_rows != 9) return 11;
  if (physical.nextScanCursor(cursor, batch) != XPOD_RDF_STATUS_DONE) return 12;
  if (state.next_calls != 2) return 13;
  physical.closeScanCursor(cursor);
  physical.closeScanCursor(nullptr);
  if (state.close_calls != 1) return 14;

  xpod_rdf_backend_v1 missing = current;
  missing.open_scan_cursor = nullptr;
  if (xpod::rdf::PhysicalBackend(&missing).hasScanCursor()) return 15;
  missing = current;
  missing.next_scan_cursor = nullptr;
  if (xpod::rdf::PhysicalBackend(&missing).hasScanCursor()) return 16;
  missing = current;
  missing.close_scan_cursor = nullptr;
  if (xpod::rdf::PhysicalBackend(&missing).hasScanCursor()) return 17;

  return 0;
}
`, 'utf8');

      execFileSync('c++', [
        '-std=c++17',
        '-Wall',
        '-Wextra',
        '-Werror',
        '-I', path.dirname(facadeHeader),
        '-I', path.join(repoRoot, 'qlever/rdf_protocol/include'),
        source,
        '-o',
        binary,
      ], { stdio: 'pipe' });
      execFileSync(binary, [], { stdio: 'pipe' });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('resolves physical text-term keys without routing them through the RDF dictionary', async () => {
    expect(hasCxx(), 'c++ compiler is required for native text-term facade check').toBe(true);

    const root = await mkdtemp(path.join(os.tmpdir(), 'xpod-qlever-text-term-facade-'));
    try {
      const source = path.join(root, 'check.cpp');
      const binary = path.join(root, 'check');
      await writeFile(source, `
#include "XpodPhysicalBackend.hpp"

#include <cstring>

struct State {
  int single_calls = 0;
  int bulk_calls = 0;
};

static xpod_rdf_status resolve_text_term(
    void* user_data,
    xpod_rdf_text_term_key key,
    const xpod_rdf_snapshot*,
    xpod_rdf_bytes* out_term) {
  auto* state = static_cast<State*>(user_data);
  ++state->single_calls;
  static const char runtime[] = "runtime";
  if (key != 51 || out_term == nullptr) return XPOD_RDF_STATUS_NOT_FOUND;
  *out_term = {runtime, sizeof(runtime) - 1};
  return XPOD_RDF_STATUS_OK;
}

static xpod_rdf_status resolve_text_terms(
    void* user_data,
    const xpod_rdf_text_term_key* keys,
    size_t key_count,
    const xpod_rdf_snapshot*,
    xpod_rdf_bytes* out_terms,
    xpod_rdf_status* out_statuses) {
  auto* state = static_cast<State*>(user_data);
  ++state->bulk_calls;
  static const char runtime[] = "runtime";
  static const char runner[] = "runner";
  for (size_t i = 0; i < key_count; ++i) {
    if (keys[i] == 51) {
      out_terms[i] = {runtime, sizeof(runtime) - 1};
      out_statuses[i] = XPOD_RDF_STATUS_OK;
    } else if (keys[i] == 52) {
      out_terms[i] = {runner, sizeof(runner) - 1};
      out_statuses[i] = XPOD_RDF_STATUS_OK;
    } else {
      out_terms[i] = {};
      out_statuses[i] = XPOD_RDF_STATUS_NOT_FOUND;
    }
  }
  return XPOD_RDF_STATUS_OK;
}

int main() {
  State state;
  xpod_rdf_backend_v1 backend = {};
  backend.abi_version = XPOD_RDF_PHYSICAL_BACKEND_ABI_VERSION;
  backend.struct_size = sizeof(backend);
  backend.backend_user_data = &state;
  backend.resolve_text_term = resolve_text_term;
  backend.resolve_text_terms = resolve_text_terms;
  xpod::rdf::PhysicalBackend physical(&backend);
  xpod_rdf_snapshot snapshot = {};

  xpod_rdf_bytes one = {};
  if (physical.resolveTextTerm(51, snapshot, one) != XPOD_RDF_STATUS_OK) return 1;
  if (one.size != 7 || std::memcmp(one.data, "runtime", 7) != 0) return 2;

  xpod_rdf_text_term_key keys[2] = {51, 52};
  xpod_rdf_bytes terms[2] = {};
  xpod_rdf_status statuses[2] = {};
  if (physical.resolveTextTerms(keys, 2, snapshot, terms, statuses) !=
      XPOD_RDF_STATUS_OK) return 3;
  if (statuses[0] != XPOD_RDF_STATUS_OK || statuses[1] != XPOD_RDF_STATUS_OK) return 4;
  if (terms[1].size != 6 || std::memcmp(terms[1].data, "runner", 6) != 0) return 5;
  if (state.single_calls != 1 || state.bulk_calls != 1) return 6;

  xpod_rdf_backend_v1 legacy = backend;
  legacy.struct_size = offsetof(xpod_rdf_backend_v1, resolve_text_term);
  xpod::rdf::PhysicalBackend legacy_physical(&legacy);
  if (legacy_physical.resolveTextTerm(51, snapshot, one) !=
      XPOD_RDF_STATUS_UNSUPPORTED) return 7;
  if (legacy_physical.resolveTextTerms(keys, 2, snapshot, terms, statuses) !=
      XPOD_RDF_STATUS_UNSUPPORTED) return 8;
  if (state.single_calls != 1 || state.bulk_calls != 1) return 9;
  return 0;
}
`, 'utf8');

      execFileSync('c++', [
        '-std=c++17', '-Wall', '-Wextra', '-Werror',
        '-I', path.dirname(facadeHeader),
        '-I', path.join(repoRoot, 'qlever/rdf_protocol/include'),
        source, '-o', binary,
      ], { stdio: 'pipe' });
      execFileSync(binary, [], { stdio: 'pipe' });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('wraps the native C ABI callback table for internal C++ adapter code', async () => {
    expect(hasCxx(), 'c++ compiler is required for native facade check').toBe(true);
    expect(existsSync(facadeHeader)).toBe(true);

    const root = await mkdtemp(path.join(os.tmpdir(), 'xpod-qlever-physical-facade-'));
    try {
      const source = path.join(root, 'check.cpp');
      const binary = path.join(root, 'check');
      await writeFile(source, `
#include "XpodPhysicalBackend.hpp"
#include <utility>

static xpod_rdf_status lookup_one(
    void* backend_user_data,
    const xpod_rdf_term*,
    const xpod_rdf_snapshot*,
    xpod_rdf_term_key* out_key) {
  int* calls = static_cast<int*>(backend_user_data);
  *calls += 1000;
  *out_key = 42;
  return XPOD_RDF_STATUS_OK;
}

static xpod_rdf_status lookup_terms(
    void* backend_user_data,
    const xpod_rdf_term* terms,
    size_t term_count,
    const xpod_rdf_snapshot*,
    xpod_rdf_term_key* out_keys,
    xpod_rdf_status* out_statuses) {
  int* calls = static_cast<int*>(backend_user_data);
  *calls += 10;
  for (size_t i = 0; i < term_count; ++i) {
    out_keys[i] = terms[i].value.size + 100;
    out_statuses[i] = XPOD_RDF_STATUS_OK;
  }
  return XPOD_RDF_STATUS_OK;
}

static xpod_rdf_status resolve_terms(
    void* backend_user_data,
    const xpod_rdf_term_key* keys,
    size_t key_count,
    const xpod_rdf_snapshot*,
    xpod_rdf_term* out_terms,
    xpod_rdf_status* out_statuses) {
  int* calls = static_cast<int*>(backend_user_data);
  *calls += 100;
  for (size_t i = 0; i < key_count; ++i) {
    out_terms[i].kind = XPOD_RDF_TERM_IRI;
    out_terms[i].value = {nullptr, keys[i] - 100};
    out_statuses[i] = XPOD_RDF_STATUS_OK;
  }
  return XPOD_RDF_STATUS_OK;
}

static xpod_rdf_status resolve_retrieval_points(
    void* backend_user_data,
    const xpod_rdf_retrieval_point_key* keys,
    size_t key_count,
    const xpod_rdf_snapshot*,
    xpod_rdf_bytes* out_contents,
    xpod_rdf_status* out_statuses) {
  int* calls = static_cast<int*>(backend_user_data);
  *calls += 100000000;
  static const char content[] = "retrieval";
  for (size_t i = 0; i < key_count; ++i) {
    out_contents[i] = {content, keys[i] == 7 ? 9u : 0u};
    out_statuses[i] = keys[i] == 7 ? XPOD_RDF_STATUS_OK
                                   : XPOD_RDF_STATUS_NOT_FOUND;
  }
  return XPOD_RDF_STATUS_OK;
}

static xpod_rdf_status prefix_range(
    void* backend_user_data,
    const xpod_rdf_prefix_range_request* request,
    xpod_rdf_term_range_batch_callback on_batch,
    void* callback_user_data) {
  int* calls = static_cast<int*>(backend_user_data);
  *calls += 100000;
  if (request->cancellation == nullptr ||
      request->cancellation->is_cancelled == nullptr) {
    return XPOD_RDF_STATUS_BACKEND_ERROR;
  }
  if (request->cancellation->is_cancelled(
          request->cancellation->cancellation_user_data) != 0) {
    return XPOD_RDF_STATUS_CANCELLED;
  }
  if (request->prefix.size != 5 || !request->has_kind ||
      request->kind != XPOD_RDF_TERM_IRI) {
    return XPOD_RDF_STATUS_BACKEND_ERROR;
  }
  xpod_rdf_term_range ranges[2] = {};
  ranges[0].lower = 10;
  ranges[0].upper = 20;
  ranges[0].has_lower = 1;
  ranges[0].has_upper = 1;
  ranges[0].lower_inclusive = 1;
  ranges[0].upper_exclusive = 1;
  ranges[1].lower = 30;
  ranges[1].upper = 40;
  ranges[1].has_lower = 1;
  ranges[1].has_upper = 1;
  ranges[1].lower_inclusive = 1;
  ranges[1].upper_exclusive = 1;
  xpod_rdf_term_range_batch batch = {};
  batch.ranges = ranges;
  batch.range_count = 2;
  batch.collation = XPOD_RDF_TERM_COLLATION_BYTEWISE;
  return on_batch(callback_user_data, &batch);
}

static uint8_t cancel_requested(void* cancellation_user_data) {
  int* cancelled = static_cast<int*>(cancellation_user_data);
  return *cancelled != 0 ? 1 : 0;
}

static xpod_rdf_status scan(
    void* backend_user_data,
    const xpod_rdf_scan_request* request,
    xpod_rdf_quad_batch_callback on_batch,
    void* callback_user_data) {
  if (request->cancellation == nullptr ||
      request->cancellation->is_cancelled == nullptr) {
    return XPOD_RDF_STATUS_BACKEND_ERROR;
  }
  if (request->cancellation->is_cancelled(
          request->cancellation->cancellation_user_data) != 0) {
    return XPOD_RDF_STATUS_CANCELLED;
  }
  int* calls = static_cast<int*>(backend_user_data);
  *calls += 1;
  (void)on_batch;
  (void)callback_user_data;
  return XPOD_RDF_STATUS_OK;
}

static xpod_rdf_status estimate_distinct(
    void* backend_user_data,
    const xpod_rdf_distinct_request* request,
    xpod_rdf_estimate* out_estimate) {
  int* calls = static_cast<int*>(backend_user_data);
  *calls += 100000000;
  if (request->distinct_slots != XPOD_RDF_SLOT_SUBJECT ||
      request->scan.source_scope.local_path_prefix.size != 6) {
    return XPOD_RDF_STATUS_BACKEND_ERROR;
  }
  out_estimate->rows = 3;
  out_estimate->distinct_subjects = 3;
  out_estimate->confidence = XPOD_RDF_ESTIMATE_FRESH;
  return XPOD_RDF_STATUS_OK;
}

static xpod_rdf_status estimate_source_scope(
    void* backend_user_data,
    const xpod_rdf_source_scope* source_scope,
    const xpod_rdf_snapshot*,
    xpod_rdf_estimate* out_estimate) {
  int* calls = static_cast<int*>(backend_user_data);
  *calls += 10000;
  if (source_scope->local_path_prefix.size != 6) {
    return XPOD_RDF_STATUS_BACKEND_ERROR;
  }
  out_estimate->rows = 12;
  out_estimate->confidence = XPOD_RDF_ESTIMATE_FRESH;
  return XPOD_RDF_STATUS_OK;
}

static xpod_rdf_status resolve_source_scope(
    void* backend_user_data,
    const xpod_rdf_source_scope* source_scope,
    const xpod_rdf_snapshot*,
    xpod_rdf_resolved_source_scope* out_scope) {
  int* calls = static_cast<int*>(backend_user_data);
  *calls += 10000000;
  if (source_scope->local_path_prefix.size != 6) {
    return XPOD_RDF_STATUS_BACKEND_ERROR;
  }
  static xpod_rdf_source_node_key source_nodes[2] = {101, 102};
  static xpod_rdf_term_key graphs[2] = {201, 202};
  out_scope->source_nodes = source_nodes;
  out_scope->source_nodes_size = 2;
  out_scope->graph_scope.kind = XPOD_RDF_GRAPH_SCOPE_SET;
  out_scope->graph_scope.graph_set = graphs;
  out_scope->graph_scope.graph_set_size = 2;
  out_scope->scope_version = {"scope-v1", 8};
  return XPOD_RDF_STATUS_OK;
}

static xpod_rdf_status histogram_hints(
    void* backend_user_data,
    const xpod_rdf_histogram_request* request,
    xpod_rdf_histogram_hint_batch_callback on_batch,
    void* callback_user_data) {
  int* calls = static_cast<int*>(backend_user_data);
  *calls += 1000000;
  if (request->graph_scope.kind != XPOD_RDF_GRAPH_SCOPE_EXACT ||
      request->source_scope.local_path_prefix.size != 6 ||
      request->pattern.has_predicate != 1 ||
      request->slots != XPOD_RDF_SLOT_OBJECT ||
      request->max_buckets != 8) {
    return XPOD_RDF_STATUS_BACKEND_ERROR;
  }
  xpod_rdf_histogram_hint hint = {};
  hint.slots = XPOD_RDF_SLOT_OBJECT;
  hint.range.lower = 10;
  hint.range.upper = 20;
  hint.range.has_lower = 1;
  hint.range.has_upper = 1;
  hint.rows = 7;
  hint.distinct_terms = 3;
  hint.selectivity = 0.25;
  hint.confidence = XPOD_RDF_ESTIMATE_FRESH;
  xpod_rdf_histogram_hint_batch batch = {};
  batch.rows = &hint;
  batch.row_count = 1;
  batch.stats_version = {"stats-v1", 8};
  return on_batch(callback_user_data, &batch);
}

static xpod_rdf_status scan_block_metadata(
    void* backend_user_data,
    const xpod_rdf_scan_request* request,
    xpod_rdf_scan_block_metadata_batch_callback on_batch,
    void* callback_user_data) {
  int* calls = static_cast<int*>(backend_user_data);
  *calls += 200000000;
  if (request->graph_scope.kind != XPOD_RDF_GRAPH_SCOPE_EXACT ||
      request->source_scope.local_path_prefix.size != 6 ||
      request->pattern.has_predicate != 1) {
    return XPOD_RDF_STATUS_BACKEND_ERROR;
  }
  xpod_rdf_scan_block_metadata rows[2] = {};
  rows[0].block_id = 1001;
  rows[0].first_quad = {10, 5, 30, 201};
  rows[0].last_quad = {19, 5, 39, 201};
  rows[0].row_count = 10;
  rows[0].sorted_slots = XPOD_RDF_SLOT_SUBJECT;
  rows[1].block_id = 1002;
  rows[1].first_quad = {20, 5, 40, 202};
  rows[1].last_quad = {29, 5, 49, 202};
  rows[1].row_count = 10;
  rows[1].sorted_slots = XPOD_RDF_SLOT_SUBJECT;
  xpod_rdf_scan_block_metadata_batch batch = {};
  batch.rows = rows;
  batch.row_count = 2;
  batch.total_blocks = 4;
  batch.metadata_version = {"blocks-v1", 9};
  return on_batch(callback_user_data, &batch);
}

static xpod_rdf_status apply_mutation(
    void* backend_user_data,
    const xpod_rdf_mutation_request* request,
    xpod_rdf_mutation_result* out_result) {
  int* calls = static_cast<int*>(backend_user_data);
  *calls += 400000000;
  if (request->mutation_count != 1 ||
      request->mutations == nullptr ||
      request->mutations[0].kind != XPOD_RDF_MUTATION_INSERT ||
      request->mutations[0].quad.subject.kind != XPOD_RDF_TERM_IRI ||
      request->mutations[0].quad.predicate.kind != XPOD_RDF_TERM_IRI ||
      request->mutations[0].quad.object.kind != XPOD_RDF_TERM_LITERAL) {
    return XPOD_RDF_STATUS_BACKEND_ERROR;
  }
  out_result->inserted_count = 1;
  out_result->deleted_count = 0;
  out_result->facts_version = {"facts-v2", 8};
  return XPOD_RDF_STATUS_OK;
}

static xpod_rdf_status load_document(
    void* backend_user_data,
    const xpod_rdf_load_document_request* request,
    xpod_rdf_load_document_result* out_result) {
  int* calls = static_cast<int*>(backend_user_data);
  *calls += 7;
  if (request == nullptr || out_result == nullptr ||
      request->source_iri.size != 12) {
    return XPOD_RDF_STATUS_BACKEND_ERROR;
  }
  out_result->content = {"<urn:s> <urn:p> <urn:o> .", 25};
  out_result->media_type = {"application/n-triples", 21};
  return XPOD_RDF_STATUS_OK;
}

static xpod_rdf_status begin_transaction(
    void* backend_user_data,
    const xpod_rdf_snapshot* snapshot) {
  int* calls = static_cast<int*>(backend_user_data);
  *calls += 2;
  return snapshot != nullptr ? XPOD_RDF_STATUS_OK : XPOD_RDF_STATUS_BACKEND_ERROR;
}

static xpod_rdf_status commit_transaction(void* backend_user_data) {
  int* calls = static_cast<int*>(backend_user_data);
  *calls += 3;
  return XPOD_RDF_STATUS_OK;
}

static xpod_rdf_status rollback_transaction(void* backend_user_data) {
  int* calls = static_cast<int*>(backend_user_data);
  *calls += 5;
  return XPOD_RDF_STATUS_OK;
}

static xpod_rdf_status get_capabilities(
    void* backend_user_data,
    xpod_rdf_backend_capabilities* out_capabilities) {
  int* calls = static_cast<int*>(backend_user_data);
  *calls += 1000000000;
  out_capabilities->supported_permutations =
      XPOD_RDF_PERM_CAP_SPOG | XPOD_RDF_PERM_CAP_POSG;
  out_capabilities->features =
      XPOD_RDF_BACKEND_FEATURE_SLOT_RANGES |
      XPOD_RDF_BACKEND_FEATURE_GRAPH_SCOPE |
      XPOD_RDF_BACKEND_FEATURE_SOURCE_SCOPE |
      XPOD_RDF_BACKEND_FEATURE_ACCESS_SCOPE |
      XPOD_RDF_BACKEND_FEATURE_TEXT_SEARCH |
      XPOD_RDF_BACKEND_FEATURE_BLOCK_METADATA |
      XPOD_RDF_BACKEND_FEATURE_MUTATION;
  out_capabilities->max_batch_size = 4096;
  out_capabilities->backend_name = {"postgres-rdf3x", 14};
  out_capabilities->backend_version = {"0.13", 4};
  return XPOD_RDF_STATUS_OK;
}

int main() {
  int calls = 0;
  int cancelled = 0;
  xpod_rdf_cancellation cancellation = {};
  cancellation.cancellation_user_data = &cancelled;
  cancellation.is_cancelled = cancel_requested;
  xpod_rdf_backend_v1 backend = {};
  backend.abi_version = XPOD_RDF_PHYSICAL_BACKEND_ABI_VERSION;
  backend.struct_size = sizeof(xpod_rdf_backend_v1);
  backend.backend_user_data = &calls;
  backend.lookup_terms = lookup_terms;
  backend.resolve_terms = resolve_terms;
  backend.resolve_retrieval_points = resolve_retrieval_points;
  backend.prefix_range = prefix_range;
  backend.scan_permutation = scan;
  backend.estimate_distinct = estimate_distinct;
  backend.estimate_source_scope = estimate_source_scope;
  backend.resolve_source_scope = resolve_source_scope;
  backend.histogram_hints = histogram_hints;
  backend.scan_block_metadata = scan_block_metadata;
  backend.apply_mutation = apply_mutation;
  backend.begin_transaction = begin_transaction;
  backend.commit_transaction = commit_transaction;
  backend.rollback_transaction = rollback_transaction;
  backend.load_document = load_document;
  backend.get_capabilities = get_capabilities;

  xpod::rdf::PhysicalBackend physical(&backend);
  if (!physical.valid()) return 1;

  xpod_rdf_term terms[2] = {};
  terms[0].kind = XPOD_RDF_TERM_IRI;
  terms[0].value = {"abcd", 4};
  terms[1].kind = XPOD_RDF_TERM_LITERAL;
  terms[1].value = {"xy", 2};
  xpod_rdf_term_key keys[2] = {};
  xpod_rdf_status term_statuses[2] = {};
  xpod_rdf_snapshot snapshot = {};
  if (physical.lookupTerms(terms, 2, snapshot, keys, term_statuses) != XPOD_RDF_STATUS_OK) return 2;
  if (keys[0] != 104 || keys[1] != 102) return 3;
  if (term_statuses[0] != XPOD_RDF_STATUS_OK || term_statuses[1] != XPOD_RDF_STATUS_OK) return 4;
  xpod_rdf_term_key single_key = 0;
  if (physical.lookupTerm(terms[0], snapshot, single_key) != XPOD_RDF_STATUS_OK) return 46;
  if (single_key != 104) return 47;

  xpod_rdf_term resolved[2] = {};
  if (physical.resolveTerms(keys, 2, snapshot, resolved, term_statuses) != XPOD_RDF_STATUS_OK) return 5;
  if (resolved[0].value.size != 4 || resolved[1].value.size != 2) return 6;
  xpod_rdf_retrieval_point_key retrieval_keys[1] = {7};
  xpod_rdf_bytes retrieval_contents[1] = {};
  xpod_rdf_status retrieval_statuses[1] = {};
  if (physical.resolveRetrievalPoints(
          retrieval_keys, 1, snapshot, retrieval_contents,
          retrieval_statuses) != XPOD_RDF_STATUS_OK) return 62;
  if (retrieval_contents[0].size != 9 ||
      retrieval_statuses[0] != XPOD_RDF_STATUS_OK) return 63;

  xpod_rdf_prefix_range_request prefix_request = {};
  prefix_request.prefix = {"urn:x", 5};
  prefix_request.has_kind = 1;
  prefix_request.kind = XPOD_RDF_TERM_IRI;
  prefix_request.cancellation = &cancellation;
  xpod_rdf_term_range prefix_ranges[4] = {};
  size_t prefix_range_count = 0;
  xpod_rdf_term_collation prefix_collation = XPOD_RDF_TERM_COLLATION_UNKNOWN;
  auto on_prefix_ranges = [](void* user_data, const xpod_rdf_term_range_batch* batch) -> xpod_rdf_status {
    auto* state = static_cast<std::pair<xpod_rdf_term_range*, size_t*>*>(user_data);
    for (size_t i = 0; i < batch->range_count; ++i) {
      state->first[*state->second + i] = batch->ranges[i];
    }
    *state->second += batch->range_count;
    return XPOD_RDF_STATUS_OK;
  };
  std::pair<xpod_rdf_term_range*, size_t*> prefix_state{prefix_ranges, &prefix_range_count};
  if (physical.prefixRange(prefix_request, on_prefix_ranges, &prefix_state, prefix_collation) != XPOD_RDF_STATUS_OK) return 18;
  if (prefix_range_count != 2) return 19;
  if (prefix_ranges[0].lower != 10 || prefix_ranges[1].upper != 40) return 20;
  if (prefix_collation != XPOD_RDF_TERM_COLLATION_BYTEWISE) return 21;

  xpod_rdf_scan_request request = {};
  request.cancellation = &cancellation;
  if (physical.scanPermutation(request, nullptr, nullptr) != XPOD_RDF_STATUS_OK) return 7;
  cancelled = 1;
  if (physical.scanPermutation(request, nullptr, nullptr) != XPOD_RDF_STATUS_CANCELLED) return 28;
  cancelled = 0;
  xpod_rdf_source_scope source_scope = {};
  source_scope.local_path_prefix = {"/docs/", 6};
  xpod_rdf_distinct_request distinct_request = {};
  distinct_request.scan.source_scope = source_scope;
  distinct_request.distinct_slots = XPOD_RDF_SLOT_SUBJECT;
  xpod_rdf_estimate distinct_estimate = {};
  if (physical.estimateDistinct(distinct_request, distinct_estimate) != XPOD_RDF_STATUS_OK) return 32;
  if (distinct_estimate.rows != 3 ||
      distinct_estimate.distinct_subjects != 3 ||
      distinct_estimate.confidence != XPOD_RDF_ESTIMATE_FRESH) return 33;
  xpod_rdf_estimate source_estimate = {};
  if (physical.estimateSourceScope(source_scope, snapshot, source_estimate) != XPOD_RDF_STATUS_OK) return 8;
  if (source_estimate.rows != 12 || source_estimate.confidence != XPOD_RDF_ESTIMATE_FRESH) return 15;
  xpod_rdf_resolved_source_scope resolved_source_scope = {};
  if (physical.resolveSourceScope(source_scope, snapshot, resolved_source_scope) != XPOD_RDF_STATUS_OK) return 29;
  if (resolved_source_scope.source_nodes_size != 2 ||
      resolved_source_scope.source_nodes[0] != 101 ||
      resolved_source_scope.graph_scope.kind != XPOD_RDF_GRAPH_SCOPE_SET ||
      resolved_source_scope.graph_scope.graph_set_size != 2 ||
      resolved_source_scope.scope_version.size != 8) return 30;

  xpod_rdf_histogram_request histogram_request = {};
  histogram_request.graph_scope.kind = XPOD_RDF_GRAPH_SCOPE_EXACT;
  histogram_request.source_scope = source_scope;
  histogram_request.pattern.has_predicate = 1;
  histogram_request.pattern.predicate = 5;
  histogram_request.slots = XPOD_RDF_SLOT_OBJECT;
  histogram_request.max_buckets = 8;
  xpod_rdf_histogram_hint histogram_rows[2] = {};
  size_t histogram_row_count = 0;
  xpod_rdf_bytes histogram_stats_version = {};
  auto on_histogram_hints = [](void* user_data, const xpod_rdf_histogram_hint_batch* batch) -> xpod_rdf_status {
    auto* state = static_cast<std::pair<xpod_rdf_histogram_hint*, size_t*>*>(user_data);
    for (size_t i = 0; i < batch->row_count; ++i) {
      state->first[*state->second + i] = batch->rows[i];
    }
    *state->second += batch->row_count;
    return XPOD_RDF_STATUS_OK;
  };
  std::pair<xpod_rdf_histogram_hint*, size_t*> histogram_state{histogram_rows, &histogram_row_count};
  if (physical.histogramHints(histogram_request, on_histogram_hints, &histogram_state, histogram_stats_version) != XPOD_RDF_STATUS_OK) return 23;
  if (histogram_row_count != 1) return 24;
  if (histogram_rows[0].rows != 7 || histogram_rows[0].distinct_terms != 3) return 25;
  if (histogram_stats_version.size != 8) return 26;
  xpod_rdf_scan_request block_request = {};
  block_request.graph_scope.kind = XPOD_RDF_GRAPH_SCOPE_EXACT;
  block_request.source_scope = source_scope;
  block_request.pattern.has_predicate = 1;
  block_request.pattern.predicate = 5;
  xpod_rdf_scan_block_metadata block_rows[4] = {};
  size_t block_row_count = 0;
  xpod_rdf_bytes block_metadata_version = {};
  auto on_scan_block_metadata = [](void* user_data, const xpod_rdf_scan_block_metadata_batch* batch) -> xpod_rdf_status {
    auto* state = static_cast<std::pair<xpod_rdf_scan_block_metadata*, size_t*>*>(user_data);
    for (size_t i = 0; i < batch->row_count; ++i) {
      state->first[*state->second + i] = batch->rows[i];
    }
    *state->second += batch->row_count;
    return XPOD_RDF_STATUS_OK;
  };
  std::pair<xpod_rdf_scan_block_metadata*, size_t*> block_state{block_rows, &block_row_count};
  if (physical.scanBlockMetadata(block_request, on_scan_block_metadata, &block_state, block_metadata_version) != XPOD_RDF_STATUS_OK) return 40;
  if (block_row_count != 2) return 41;
  if (block_rows[0].block_id != 1001 || block_rows[1].last_quad.object != 49) return 42;
  if (block_metadata_version.size != 9) return 43;
  xpod_rdf_quad_mutation mutations[1] = {};
  mutations[0].kind = XPOD_RDF_MUTATION_INSERT;
  mutations[0].quad.subject.kind = XPOD_RDF_TERM_IRI;
  mutations[0].quad.subject.value = {"urn:new", 7};
  mutations[0].quad.predicate.kind = XPOD_RDF_TERM_IRI;
  mutations[0].quad.predicate.value = {"urn:p", 5};
  mutations[0].quad.object.kind = XPOD_RDF_TERM_LITERAL;
  mutations[0].quad.object.value = {"literal", 7};
  xpod_rdf_mutation_request mutation_request = {};
  mutation_request.mutations = mutations;
  mutation_request.mutation_count = 1;
  xpod_rdf_mutation_result mutation_result = {};
  if (physical.applyMutation(mutation_request, mutation_result) != XPOD_RDF_STATUS_OK) return 48;
  if (mutation_result.inserted_count != 1 || mutation_result.deleted_count != 0 || mutation_result.facts_version.size != 8) return 49;
  if (physical.beginTransaction(snapshot) != XPOD_RDF_STATUS_OK) return 52;
  if (physical.commitTransaction() != XPOD_RDF_STATUS_OK) return 53;
  if (physical.beginTransaction(snapshot) != XPOD_RDF_STATUS_OK) return 54;
  if (physical.rollbackTransaction() != XPOD_RDF_STATUS_OK) return 55;
  xpod_rdf_load_document_request load_request = {};
  load_request.source_iri = {"urn:load-src", 12};
  xpod_rdf_load_document_result load_result = {};
  if (physical.loadDocument(load_request, load_result) != XPOD_RDF_STATUS_OK) return 59;
  if (load_result.content.size != 25 || load_result.media_type.size != 21) return 60;
  xpod_rdf_backend_capabilities capabilities = {};
  if (physical.getCapabilities(capabilities) != XPOD_RDF_STATUS_OK) return 35;
  if ((capabilities.supported_permutations & XPOD_RDF_PERM_CAP_POSG) == 0) return 36;
  if ((capabilities.features & XPOD_RDF_BACKEND_FEATURE_SLOT_RANGES) == 0) return 37;
  if ((capabilities.features & XPOD_RDF_BACKEND_FEATURE_BLOCK_METADATA) == 0) return 45;
  if ((capabilities.features & XPOD_RDF_BACKEND_FEATURE_MUTATION) == 0) return 50;
  if (capabilities.max_batch_size != 4096 || capabilities.backend_name.size != 14) return 38;
  if (calls != 1811110140) return 16;

  xpod_rdf_backend_v1 truncated = {};
  truncated.abi_version = XPOD_RDF_PHYSICAL_BACKEND_ABI_VERSION;
  truncated.struct_size = offsetof(xpod_rdf_backend_v1, lookup_term);
  truncated.backend_user_data = &calls;
  truncated.lookup_term = lookup_one;
  xpod::rdf::PhysicalBackend truncated_physical(&truncated);
  xpod_rdf_term_key lookup_key = 0;
  if (truncated_physical.lookupTerm(terms[0], snapshot, lookup_key) != XPOD_RDF_STATUS_UNSUPPORTED) return 12;
  if (lookup_key != 0) return 13;
  if (calls != 1811110140) return 14;

  xpod_rdf_backend_v1 missing = {};
  missing.abi_version = XPOD_RDF_PHYSICAL_BACKEND_ABI_VERSION;
  missing.struct_size = sizeof(xpod_rdf_backend_v1);
  xpod::rdf::PhysicalBackend unsupported(&missing);
  if (unsupported.lookupTerms(terms, 2, snapshot, keys, term_statuses) != XPOD_RDF_STATUS_UNSUPPORTED) return 9;
  if (unsupported.resolveTerms(keys, 2, snapshot, resolved, term_statuses) != XPOD_RDF_STATUS_UNSUPPORTED) return 10;
  if (unsupported.resolveRetrievalPoints(
          retrieval_keys, 1, snapshot, retrieval_contents,
          retrieval_statuses) != XPOD_RDF_STATUS_UNSUPPORTED) return 64;
  if (unsupported.scanPermutation(request, nullptr, nullptr) != XPOD_RDF_STATUS_UNSUPPORTED) return 11;
  if (unsupported.estimateDistinct(distinct_request, distinct_estimate) != XPOD_RDF_STATUS_UNSUPPORTED) return 34;
  if (unsupported.estimateSourceScope(source_scope, snapshot, source_estimate) != XPOD_RDF_STATUS_UNSUPPORTED) return 17;
  if (unsupported.resolveSourceScope(source_scope, snapshot, resolved_source_scope) != XPOD_RDF_STATUS_UNSUPPORTED) return 31;
  if (unsupported.prefixRange(prefix_request, on_prefix_ranges, &prefix_state, prefix_collation) != XPOD_RDF_STATUS_UNSUPPORTED) return 22;
  if (unsupported.histogramHints(histogram_request, on_histogram_hints, &histogram_state, histogram_stats_version) != XPOD_RDF_STATUS_UNSUPPORTED) return 27;
  if (unsupported.scanBlockMetadata(block_request, on_scan_block_metadata, &block_state, block_metadata_version) != XPOD_RDF_STATUS_UNSUPPORTED) return 44;
  if (unsupported.applyMutation(mutation_request, mutation_result) != XPOD_RDF_STATUS_UNSUPPORTED) return 51;
  if (unsupported.beginTransaction(snapshot) != XPOD_RDF_STATUS_UNSUPPORTED) return 56;
  if (unsupported.commitTransaction() != XPOD_RDF_STATUS_UNSUPPORTED) return 57;
  if (unsupported.rollbackTransaction() != XPOD_RDF_STATUS_UNSUPPORTED) return 58;
  if (unsupported.loadDocument(load_request, load_result) != XPOD_RDF_STATUS_UNSUPPORTED) return 61;
  if (unsupported.getCapabilities(capabilities) != XPOD_RDF_STATUS_UNSUPPORTED) return 39;

  return 0;
}
`, 'utf8');

      execFileSync('c++', [
        '-std=c++17',
        '-Wall',
        '-Wextra',
        '-Werror',
        '-I', path.dirname(facadeHeader),
        '-I', path.join(repoRoot, 'qlever/rdf_protocol/include'),
        source,
        '-o',
        binary,
      ], { stdio: 'pipe' });
      execFileSync(binary, [], { stdio: 'pipe' });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('kind-tagged physical term ids', () => {
  it('round-trips RDF kind and sequence inside the 60-bit QLever payload', async () => {
    expect(hasCxx(), 'c++ compiler is required for tagged term-id check').toBe(true);

    const root = await mkdtemp(path.join(os.tmpdir(), 'xpod-tagged-term-id-'));
    try {
      const source = path.join(root, 'check.cpp');
      const binary = path.join(root, 'check');
      await writeFile(source, `
#include "xpod_rdf_physical_backend.h"
#include <cstdint>

int main() {
  xpod_rdf_term_key iri = 0;
  xpod_rdf_term_key blank = 0;
  xpod_rdf_term_key literal = 0;
  if (!xpod_rdf_make_kind_tagged_term_key(42, XPOD_RDF_TERM_KIND_TAG_IRI, &iri)) return 1;
  if (!xpod_rdf_make_kind_tagged_term_key(43, XPOD_RDF_TERM_KIND_TAG_BLANK, &blank)) return 2;
  if (!xpod_rdf_make_kind_tagged_term_key(44, XPOD_RDF_TERM_KIND_TAG_LITERAL, &literal)) return 3;
  if (iri != (42ULL << 2 | 1ULL)) return 4;
  if (xpod_rdf_kind_tagged_term_key_kind(blank) != XPOD_RDF_TERM_KIND_TAG_BLANK) return 5;
  if (xpod_rdf_kind_tagged_term_key_sequence(literal) != 44) return 6;
  if (xpod_rdf_make_kind_tagged_term_key(0, XPOD_RDF_TERM_KIND_TAG_IRI, &iri)) return 7;
  if (xpod_rdf_make_kind_tagged_term_key(
        XPOD_RDF_KIND_TAGGED_MAX_SEQUENCE + 1,
        XPOD_RDF_TERM_KIND_TAG_IRI, &iri)) return 8;
  if (xpod_rdf_make_kind_tagged_term_key(1, XPOD_RDF_TERM_KIND_TAG_RESERVED, &iri)) return 9;
  return 0;
}
`, 'utf8');
      execFileSync('c++', [
        '-std=c++17', '-Wall', '-Wextra', '-Werror',
        '-I', path.join(repoRoot, 'qlever/rdf_protocol/include'),
        source, '-o', binary,
      ], { stdio: 'pipe' });
      execFileSync(binary, [], { stdio: 'pipe' });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
