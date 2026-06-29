import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(__dirname, '../..');
const textSearchHeader = path.join(repoRoot, 'native/postgres/qlever_adapter/src/XpodBackedTextSearch.hpp');

function hasCxx(): boolean {
  try {
    execFileSync('/usr/bin/env', ['c++', '--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

describe('Xpod-backed QLever TextSearch adapter', () => {
  it('executes a text candidate operation shell with estimate and profile events', async () => {
    expect(hasCxx(), 'c++ compiler is required for native backed text search check').toBe(true);

    const root = await mkdtemp(path.join(os.tmpdir(), 'xpod-backed-text-search-'));
    try {
      const smoke = path.join(root, 'backed_text_search_smoke.cpp');
      const binary = path.join(root, 'backed_text_search_smoke');
      await writeFile(smoke, `
#include "XpodBackedTextSearch.hpp"

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

static bool request_matches(const xpod_rdf_text_search_request* request) {
  if (request == nullptr) return false;
  if (!bytes_equal(request->query, "hello world")) return false;
  if (!bytes_equal(request->source_scope.local_path_prefix, "/workspace/docs/")) return false;
  if (request->access_scope == nullptr) return false;
  if (!bytes_equal(request->access_scope->principal, "urn:alice")) return false;
  if (request->access_scope->mode != XPOD_RDF_ACCESS_READ) return false;
  if (request->limit != 2 || request->offset != 1) return false;
  if (request->required_entities_size != 2) return false;
  if (request->required_entities[0] != 1001 || request->required_entities[1] != 1002) return false;
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

static xpod_rdf_status estimate_text_search(
    void* user_data,
    const xpod_rdf_text_search_request* request,
    xpod_rdf_estimate* out_estimate) {
  if (!request_matches(request)) return XPOD_RDF_STATUS_BACKEND_ERROR;
  CallbackState* state = static_cast<CallbackState*>(user_data);
  state->estimate_calls++;
  out_estimate->rows = 7;
  out_estimate->cpu_cost = 5;
  out_estimate->io_cost = 2;
  out_estimate->startup_cost = 1;
  out_estimate->confidence = XPOD_RDF_ESTIMATE_FRESH;
  return XPOD_RDF_STATUS_OK;
}

static xpod_rdf_status text_search(
    void* user_data,
    const xpod_rdf_text_search_request* request,
    xpod_rdf_candidate_batch_callback on_batch,
    void* callback_user_data) {
  if (!request_matches(request)) return XPOD_RDF_STATUS_BACKEND_ERROR;
  CallbackState* state = static_cast<CallbackState*>(user_data);
  state->search_calls++;
  xpod_rdf_candidate rows[2] = {};
  rows[0].has_source_node = 1;
  rows[0].source_node = 11;
  rows[0].has_retrieval_point = 1;
  rows[0].retrieval_point = 44;
  rows[0].score = 0.8;
  rows[0].range.start_line = 10;
  rows[0].range.end_line = 12;
  rows[0].scorer = {"pg-ts-rank-cd", 13};
  rows[1].has_resource_term = 1;
  rows[1].resource_term = 55;
  rows[1].score = 0.4;
  rows[1].scorer = {"pg-ts-rank-cd", 13};
  xpod_rdf_candidate_batch batch = {};
  batch.rows = rows;
  batch.row_count = 2;
  batch.scanned_rows = 9;
  batch.scorer = {"pg-ts-rank-cd", 13};
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
  backend.estimate_text_search = estimate_text_search;
  backend.text_search = text_search;
  xpod::rdf::PhysicalBackend physical(&backend);

  xpod_rdf_access_scope access = {};
  access.principal = {"urn:alice", 9};
  access.mode = XPOD_RDF_ACCESS_READ;
  access.authorization_model = XPOD_RDF_AUTH_ACP;

  xpod_rdf_term_key required[2] = {1001, 1002};
  xpod_rdf_text_search_request request = {};
  request.query = {"hello world", 11};
  request.source_scope.local_path_prefix = {"/workspace/docs/", 16};
  request.access_scope = &access;
  request.limit = 2;
  request.offset = 1;
  request.required_entities = required;
  request.required_entities_size = 2;

  xpod::qlever::XpodBackedTextSearch textSearch(physical, request, "xpod text hello", 77, 55);
  if (textSearch.getDescriptor() != "xpod text hello") return 1;
  auto estimate = textSearch.estimate();
  if (estimate.status != XPOD_RDF_STATUS_OK) return 2;
  if (estimate.estimate.rows != 7) return 3;
  if (textSearch.getSizeEstimate() != 7) return 4;
  if (textSearch.getCostEstimate() != 8) return 5;

  auto result = textSearch.execute();
  if (result.status != XPOD_RDF_STATUS_OK) return 6;
  if (result.candidates.rows.size() != 2) return 7;
  if (result.candidates.scanned_rows != 9) return 8;
  if (result.candidates.scorer != "pg-ts-rank-cd") return 9;
  if (!result.candidates.rows[0].has_source_node || result.candidates.rows[0].source_node != 11) return 10;
  if (!result.candidates.rows[0].has_retrieval_point || result.candidates.rows[0].retrieval_point != 44) return 11;
  if (result.candidates.rows[0].range.start_line != 10 || result.candidates.rows[0].range.end_line != 12) return 12;
  if (!result.candidates.rows[1].has_resource_term || result.candidates.rows[1].resource_term != 55) return 13;

  auto operationResult = textSearch.computeResult(false);
  if (operationResult.status != XPOD_RDF_STATUS_OK) return 14;
  if (operationResult.candidates.rows.size() != 2) return 15;
  if (callbacks.estimate_calls < 3) return 16;
  if (callbacks.search_calls != 2) return 17;
  if (profile.calls != 2) return 18;
  if (profile.kinds[0] != XPOD_RDF_PROFILE_TEXT_SEARCH || profile.kinds[1] != XPOD_RDF_PROFILE_TEXT_SEARCH) return 19;
  if (profile.statuses[0] != XPOD_RDF_PROFILE_RUNNING) return 20;
  if (profile.statuses[1] != XPOD_RDF_PROFILE_COMPLETED) return 21;
  if (profile.nodes[0] != 77 || profile.nodes[1] != 77) return 22;
  if (!profile.has_parents[0] || profile.parents[0] != 55) return 23;
  if (profile.output_rows[1] != 2) return 24;
  if (profile.scanned_rows[1] != 9) return 25;
  if (profile.estimate_rows[0] != 7 || profile.estimate_rows[1] != 7) return 26;
  return 0;
}
`, 'utf8');

      execFileSync('c++', [
        '-std=c++17',
        '-Wall',
        '-Wextra',
        '-Werror',
        '-I', path.dirname(textSearchHeader),
        '-I', path.join(repoRoot, 'native/postgres/rdf_protocol/include'),
        smoke,
        '-o',
        binary,
      ], { stdio: 'pipe' });
      execFileSync(binary, [], { stdio: 'pipe' });

      const unsupportedFeatureSmoke = path.join(root, 'backed_text_search_capability_smoke.cpp');
      const unsupportedFeatureBinary = path.join(root, 'backed_text_search_capability_smoke');
      await writeFile(unsupportedFeatureSmoke, `
#include "XpodBackedTextSearch.hpp"

struct CallState {
  int estimate_calls;
  int search_calls;
};

static xpod_rdf_status get_capabilities(
    void*,
    xpod_rdf_backend_capabilities* out_capabilities) {
  out_capabilities->features = XPOD_RDF_BACKEND_FEATURE_VECTOR_SEARCH;
  return XPOD_RDF_STATUS_OK;
}

static xpod_rdf_status estimate_text_search(
    void* user_data,
    const xpod_rdf_text_search_request*,
    xpod_rdf_estimate* out_estimate) {
  auto* state = static_cast<CallState*>(user_data);
  ++state->estimate_calls;
  out_estimate->rows = 1;
  return XPOD_RDF_STATUS_OK;
}

static xpod_rdf_status text_search(
    void* user_data,
    const xpod_rdf_text_search_request*,
    xpod_rdf_candidate_batch_callback,
    void*) {
  auto* state = static_cast<CallState*>(user_data);
  ++state->search_calls;
  return XPOD_RDF_STATUS_OK;
}

int main() {
  CallState calls = {};
  xpod_rdf_backend_v1 backend = {};
  backend.abi_version = XPOD_RDF_PHYSICAL_BACKEND_ABI_VERSION;
  backend.struct_size = sizeof(xpod_rdf_backend_v1);
  backend.backend_user_data = &calls;
  backend.get_capabilities = get_capabilities;
  backend.estimate_text_search = estimate_text_search;
  backend.text_search = text_search;
  xpod::rdf::PhysicalBackend physical(&backend);

  xpod_rdf_text_search_request request = {};
  request.query = {"hello", 5};
  xpod::qlever::XpodBackedTextSearch textSearch(physical, request);
  if (textSearch.estimate().status != XPOD_RDF_STATUS_UNSUPPORTED) return 1;
  if (textSearch.execute().status != XPOD_RDF_STATUS_UNSUPPORTED) return 2;
  if (calls.estimate_calls != 0 || calls.search_calls != 0) return 3;
  return 0;
}
`, 'utf8');

      execFileSync('c++', [
        '-std=c++17',
        '-Wall',
        '-Wextra',
        '-Werror',
        '-I', path.dirname(textSearchHeader),
        '-I', path.join(repoRoot, 'native/postgres/rdf_protocol/include'),
        unsupportedFeatureSmoke,
        '-o',
        unsupportedFeatureBinary,
      ], { stdio: 'pipe' });
      execFileSync(unsupportedFeatureBinary, [], { stdio: 'pipe' });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
