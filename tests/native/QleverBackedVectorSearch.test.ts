import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(__dirname, '../..');
const vectorSearchHeader = path.join(repoRoot, 'native/postgres/qlever_adapter/src/XpodBackedVectorSearch.hpp');

function hasCxx(): boolean {
  try {
    execFileSync('/usr/bin/env', ['c++', '--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

describe('Xpod-backed QLever VectorSearch adapter', () => {
  it('executes a vector candidate operation shell with estimate and profile events', async () => {
    expect(hasCxx(), 'c++ compiler is required for native backed vector search check').toBe(true);

    const root = await mkdtemp(path.join(os.tmpdir(), 'xpod-backed-vector-search-'));
    try {
      const smoke = path.join(root, 'backed_vector_search_smoke.cpp');
      const binary = path.join(root, 'backed_vector_search_smoke');
      await writeFile(smoke, `
#include "XpodBackedTextSearch.hpp"
#include "XpodBackedVectorSearch.hpp"

#include <cstring>
#include <string>

static bool bytes_equal(xpod_rdf_bytes actual, const char* expected) {
  size_t length = std::strlen(expected);
  return actual.size == length && std::string(actual.data, actual.size) == expected;
}

struct CallbackState {
  int estimate_calls;
  int search_calls;
};

struct ProfileState {
  int calls;
  xpod_rdf_profile_kind kinds[2];
  xpod_rdf_profile_status statuses[2];
  xpod_rdf_profile_node_key nodes[2];
  xpod_rdf_profile_node_key parents[2];
  uint8_t has_parents[2];
  uint64_t output_rows[2];
  uint64_t scanned_rows[2];
  uint64_t estimate_rows[2];
};

static bool request_matches(const xpod_rdf_vector_search_request* request) {
  if (request == nullptr) return false;
  if (request->dimensions != 3) return false;
  if (request->vector == nullptr) return false;
  if (request->vector[0] != 0.1 || request->vector[1] != 0.2 || request->vector[2] != 0.3) return false;
  if (!bytes_equal(request->model, "qwen-text-embedding-v4")) return false;
  if (request->metric != XPOD_RDF_VECTOR_COSINE) return false;
  if (!bytes_equal(request->source_scope.local_path_prefix, "/workspace/docs/")) return false;
  if (request->access_scope == nullptr) return false;
  if (!bytes_equal(request->access_scope->principal, "urn:alice")) return false;
  if (request->access_scope->mode != XPOD_RDF_ACCESS_READ) return false;
  if (request->limit != 3) return false;
  if (!request->has_threshold || request->threshold != 0.25) return false;
  return true;
}

static void on_profile(void* user_data, const xpod_rdf_profile_event* event) {
  ProfileState* state = static_cast<ProfileState*>(user_data);
  int index = state->calls++;
  if (index >= 2) return;
  state->kinds[index] = event->kind;
  state->statuses[index] = event->status;
  state->nodes[index] = event->node;
  state->parents[index] = event->parent;
  state->has_parents[index] = event->has_parent;
  state->output_rows[index] = event->output_rows;
  state->scanned_rows[index] = event->scanned_rows;
  state->estimate_rows[index] = event->estimate.rows;
}

static xpod_rdf_status estimate_vector_search(
    void* user_data,
    const xpod_rdf_vector_search_request* request,
    xpod_rdf_estimate* out_estimate) {
  if (!request_matches(request)) return XPOD_RDF_STATUS_BACKEND_ERROR;
  CallbackState* state = static_cast<CallbackState*>(user_data);
  state->estimate_calls++;
  out_estimate->rows = 13;
  out_estimate->cpu_cost = 7;
  out_estimate->io_cost = 3;
  out_estimate->startup_cost = 2;
  out_estimate->confidence = XPOD_RDF_ESTIMATE_HEURISTIC;
  return XPOD_RDF_STATUS_OK;
}

static xpod_rdf_status vector_search(
    void* user_data,
    const xpod_rdf_vector_search_request* request,
    xpod_rdf_candidate_batch_callback on_batch,
    void* callback_user_data) {
  if (!request_matches(request)) return XPOD_RDF_STATUS_BACKEND_ERROR;
  CallbackState* state = static_cast<CallbackState*>(user_data);
  state->search_calls++;
  xpod_rdf_candidate rows[2] = {};
  rows[0].has_retrieval_point = 1;
  rows[0].retrieval_point = 88;
  rows[0].score = 0.91;
  rows[0].scorer = {"vector-cosine", 13};
  rows[1].has_source_node = 1;
  rows[1].source_node = 99;
  rows[1].score = 0.73;
  rows[1].scorer = {"vector-cosine", 13};
  xpod_rdf_candidate_batch batch = {};
  batch.rows = rows;
  batch.row_count = 2;
  batch.scanned_rows = 21;
  batch.scorer = {"vector-cosine", 13};
  return on_batch(callback_user_data, &batch);
}

int main() {
  CallbackState callbacks = {};
  ProfileState profile = {};
  xpod_rdf_backend_v1 backend = {};
  backend.abi_version = XPOD_RDF_PHYSICAL_BACKEND_ABI_VERSION;
  backend.struct_size = sizeof(xpod_rdf_backend_v1);
  backend.backend_user_data = &callbacks;
  backend.on_profile_event = on_profile;
  backend.profile_user_data = &profile;
  backend.estimate_vector_search = estimate_vector_search;
  backend.vector_search = vector_search;
  xpod::rdf::PhysicalBackend physical(&backend);

  xpod_rdf_access_scope access = {};
  access.principal = {"urn:alice", 9};
  access.mode = XPOD_RDF_ACCESS_READ;
  access.authorization_model = XPOD_RDF_AUTH_ACP;

  double values[3] = {0.1, 0.2, 0.3};
  xpod_rdf_vector_search_request request = {};
  request.vector = values;
  request.dimensions = 3;
  request.model = {"qwen-text-embedding-v4", 22};
  request.metric = XPOD_RDF_VECTOR_COSINE;
  request.source_scope.local_path_prefix = {"/workspace/docs/", 16};
  request.access_scope = &access;
  request.limit = 3;
  request.threshold = 0.25;
  request.has_threshold = 1;

  xpod::qlever::XpodBackedVectorSearch vectorSearch(physical, request, "xpod vector qwen", 78, 55);
  if (vectorSearch.getDescriptor() != "xpod vector qwen") return 1;
  auto estimate = vectorSearch.estimate();
  if (estimate.status != XPOD_RDF_STATUS_OK) return 2;
  if (estimate.estimate.rows != 13) return 3;
  if (vectorSearch.getSizeEstimate() != 13) return 4;
  if (vectorSearch.getCostEstimate() != 12) return 5;

  auto result = vectorSearch.execute();
  if (result.status != XPOD_RDF_STATUS_OK) return 6;
  if (result.candidates.rows.size() != 2) return 7;
  if (result.candidates.scanned_rows != 21) return 8;
  if (result.candidates.scorer != "vector-cosine") return 9;
  if (!result.candidates.rows[0].has_retrieval_point || result.candidates.rows[0].retrieval_point != 88) return 10;
  if (!result.candidates.rows[1].has_source_node || result.candidates.rows[1].source_node != 99) return 11;

  auto operationResult = vectorSearch.computeResult(false);
  if (operationResult.status != XPOD_RDF_STATUS_OK) return 12;
  if (operationResult.candidates.rows.size() != 2) return 13;
  if (callbacks.estimate_calls < 3) return 14;
  if (callbacks.search_calls != 2) return 15;
  if (profile.calls != 2) return 16;
  if (profile.kinds[0] != XPOD_RDF_PROFILE_VECTOR_SEARCH || profile.kinds[1] != XPOD_RDF_PROFILE_VECTOR_SEARCH) return 17;
  if (profile.statuses[0] != XPOD_RDF_PROFILE_RUNNING) return 18;
  if (profile.statuses[1] != XPOD_RDF_PROFILE_COMPLETED) return 19;
  if (profile.nodes[0] != 78 || profile.nodes[1] != 78) return 20;
  if (!profile.has_parents[0] || profile.parents[0] != 55) return 21;
  if (profile.output_rows[1] != 2) return 22;
  if (profile.scanned_rows[1] != 21) return 23;
  if (profile.estimate_rows[0] != 13 || profile.estimate_rows[1] != 13) return 24;
  return 0;
}
`, 'utf8');

      execFileSync('c++', [
        '-std=c++17',
        '-Wall',
        '-Wextra',
        '-Werror',
        '-I', path.dirname(vectorSearchHeader),
        '-I', path.join(repoRoot, 'native/postgres/rdf_protocol/include'),
        smoke,
        '-o',
        binary,
      ], { stdio: 'pipe' });
      execFileSync(binary, [], { stdio: 'pipe' });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
