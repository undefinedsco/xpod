import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(__dirname, '../..');
const facadeHeader = path.join(repoRoot, 'native/postgres/qlever_adapter/src/XpodPhysicalBackend.hpp');

function hasCxx(): boolean {
  try {
    execFileSync('/usr/bin/env', ['c++', '--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

describe('QLever adapter physical backend facade', () => {
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
  backend.prefix_range = prefix_range;
  backend.scan_permutation = scan;
  backend.estimate_source_scope = estimate_source_scope;
  backend.resolve_source_scope = resolve_source_scope;
  backend.histogram_hints = histogram_hints;

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

  xpod_rdf_term resolved[2] = {};
  if (physical.resolveTerms(keys, 2, snapshot, resolved, term_statuses) != XPOD_RDF_STATUS_OK) return 5;
  if (resolved[0].value.size != 4 || resolved[1].value.size != 2) return 6;

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
  if (calls != 11110111) return 16;

  xpod_rdf_backend_v1 truncated = {};
  truncated.abi_version = XPOD_RDF_PHYSICAL_BACKEND_ABI_VERSION;
  truncated.struct_size = offsetof(xpod_rdf_backend_v1, lookup_term);
  truncated.backend_user_data = &calls;
  truncated.lookup_term = lookup_one;
  xpod::rdf::PhysicalBackend truncated_physical(&truncated);
  xpod_rdf_term_key lookup_key = 0;
  if (truncated_physical.lookupTerm(terms[0], snapshot, lookup_key) != XPOD_RDF_STATUS_UNSUPPORTED) return 12;
  if (lookup_key != 0) return 13;
  if (calls != 11110111) return 14;

  xpod_rdf_backend_v1 missing = {};
  missing.abi_version = XPOD_RDF_PHYSICAL_BACKEND_ABI_VERSION;
  missing.struct_size = sizeof(xpod_rdf_backend_v1);
  xpod::rdf::PhysicalBackend unsupported(&missing);
  if (unsupported.lookupTerms(terms, 2, snapshot, keys, term_statuses) != XPOD_RDF_STATUS_UNSUPPORTED) return 9;
  if (unsupported.resolveTerms(keys, 2, snapshot, resolved, term_statuses) != XPOD_RDF_STATUS_UNSUPPORTED) return 10;
  if (unsupported.scanPermutation(request, nullptr, nullptr) != XPOD_RDF_STATUS_UNSUPPORTED) return 11;
  if (unsupported.estimateSourceScope(source_scope, snapshot, source_estimate) != XPOD_RDF_STATUS_UNSUPPORTED) return 17;
  if (unsupported.resolveSourceScope(source_scope, snapshot, resolved_source_scope) != XPOD_RDF_STATUS_UNSUPPORTED) return 31;
  if (unsupported.prefixRange(prefix_request, on_prefix_ranges, &prefix_state, prefix_collation) != XPOD_RDF_STATUS_UNSUPPORTED) return 22;
  if (unsupported.histogramHints(histogram_request, on_histogram_hints, &histogram_state, histogram_stats_version) != XPOD_RDF_STATUS_UNSUPPORTED) return 27;

  return 0;
}
`, 'utf8');

      execFileSync('c++', [
        '-std=c++17',
        '-Wall',
        '-Wextra',
        '-Werror',
        '-I', path.dirname(facadeHeader),
        '-I', path.join(repoRoot, 'native/postgres/rdf_protocol/include'),
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
