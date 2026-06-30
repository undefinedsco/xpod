import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(__dirname, '../..');
const operationHeader = path.join(repoRoot, 'native/postgres/qlever_adapter/src/XpodQleverOperationExecutor.hpp');

function hasCxx(): boolean {
  try {
    execFileSync('/usr/bin/env', ['c++', '--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

async function writeFakeQleverHeaders(root: string): Promise<string> {
  const qleverSource = path.join(root, 'qlever');
  await mkdir(path.join(qleverSource, 'src/global'), { recursive: true });
  await mkdir(path.join(qleverSource, 'src/engine'), { recursive: true });
  await mkdir(path.join(qleverSource, 'src/engine/idTable'), { recursive: true });
  await mkdir(path.join(qleverSource, 'src/index'), { recursive: true });
  await writeFile(path.join(qleverSource, 'src/global/Id.h'), `
#pragma once
#include <cstdint>
using ColumnIndex = uint64_t;
class Id {
 public:
  static Id fromBits(uint64_t bits) { return Id(bits); }
  uint64_t getBits() const { return bits_; }
 private:
  explicit Id(uint64_t bits) : bits_(bits) {}
  uint64_t bits_;
};
`, 'utf8');
  await writeFile(path.join(qleverSource, 'src/index/LocalVocab.h'), `
#pragma once
class LocalVocab {};
`, 'utf8');
  await writeFile(path.join(qleverSource, 'src/index/Permutation.h'), `
#pragma once
class Permutation {
 public:
  enum struct Enum { PSO, POS, SPO, SOP, OPS, OSP };
};
`, 'utf8');
  await writeFile(path.join(qleverSource, 'src/engine/idTable/IdTable.h'), `
#pragma once
#include <cstddef>
#include <vector>
#include "global/Id.h"
class IdTable {
 public:
  explicit IdTable(size_t width) : width_(width) {}
  size_t numColumns() const { return width_; }
  size_t numRows() const { return rows_.size(); }
  void push_back(const std::vector<Id>& row) { rows_.push_back(row); }
  const Id& operator()(size_t row, size_t column) const { return rows_[row][column]; }
 private:
  size_t width_;
  std::vector<std::vector<Id>> rows_;
};
`, 'utf8');
  await writeFile(path.join(qleverSource, 'src/engine/Result.h'), `
#pragma once
#include <utility>
#include <vector>
#include "engine/idTable/IdTable.h"
#include "global/Id.h"
#include "index/LocalVocab.h"
class Result {
 public:
  Result(IdTable table, std::vector<ColumnIndex> sortedBy, LocalVocab&&)
      : table_(std::move(table)), sortedBy_(std::move(sortedBy)) {}
  const IdTable& idTable() const { return table_; }
  const std::vector<ColumnIndex>& sortedBy() const { return sortedBy_; }
 private:
  IdTable table_;
  std::vector<ColumnIndex> sortedBy_;
};
`, 'utf8');
  return qleverSource;
}

describe('QLever candidate physical operation bridge', () => {
  it('executes text and vector candidate roots from a native physical plan', async () => {
    expect(hasCxx(), 'c++ compiler is required for native candidate operation bridge check').toBe(true);

    const root = await mkdtemp(path.join(os.tmpdir(), 'xpod-qlever-candidate-operation-'));
    try {
      const qleverSource = await writeFakeQleverHeaders(root);
      const smoke = path.join(root, 'candidate_operation_smoke.cpp');
      const binary = path.join(root, 'candidate_operation_smoke');
      await writeFile(smoke, `
#include "XpodQleverOperationExecutor.hpp"

#include <cstring>
#include <string>

static bool bytes_equal(xpod_rdf_bytes actual, const char* expected) {
  size_t length = std::strlen(expected);
  return actual.size == length && std::string(actual.data, actual.size) == expected;
}

struct State {
  int text_calls;
  int vector_calls;
  int profile_calls;
  xpod_rdf_profile_kind profile_kinds[8];
  xpod_rdf_profile_status profile_statuses[8];
};

static void on_profile(void* user_data, const xpod_rdf_profile_event* event) {
  State* state = static_cast<State*>(user_data);
  int index = state->profile_calls++;
  if (index >= 8) return;
  state->profile_kinds[index] = event->kind;
  state->profile_statuses[index] = event->status;
}

static xpod_rdf_status get_capabilities(
    void*,
    xpod_rdf_backend_capabilities* out_capabilities) {
  out_capabilities->features =
      XPOD_RDF_BACKEND_FEATURE_TEXT_SEARCH |
      XPOD_RDF_BACKEND_FEATURE_VECTOR_SEARCH;
  return XPOD_RDF_STATUS_OK;
}

static xpod_rdf_status estimate_text_search(
    void*,
    const xpod_rdf_text_search_request* request,
    xpod_rdf_estimate* out_estimate) {
  if (!bytes_equal(request->query, "topic")) return XPOD_RDF_STATUS_BACKEND_ERROR;
  out_estimate->rows = 5;
  out_estimate->confidence = XPOD_RDF_ESTIMATE_FRESH;
  return XPOD_RDF_STATUS_OK;
}

static xpod_rdf_status text_search(
    void* user_data,
    const xpod_rdf_text_search_request* request,
    xpod_rdf_candidate_batch_callback on_batch,
    void* callback_user_data) {
  State* state = static_cast<State*>(user_data);
  state->text_calls++;
  if (!bytes_equal(request->query, "topic")) return XPOD_RDF_STATUS_BACKEND_ERROR;
  if (!bytes_equal(request->source_scope.local_path_prefix, "/workspace/docs/")) return XPOD_RDF_STATUS_BACKEND_ERROR;
  if (request->limit != 2) return XPOD_RDF_STATUS_BACKEND_ERROR;
  xpod_rdf_candidate row = {};
  row.has_retrieval_point = 1;
  row.retrieval_point = 101;
  row.score = 0.8;
  xpod_rdf_candidate_batch batch = {};
  batch.rows = &row;
  batch.row_count = 1;
  batch.scanned_rows = 9;
  batch.scorer = {"pg-ts-rank-cd", 13};
  return on_batch(callback_user_data, &batch);
}

static xpod_rdf_status estimate_vector_search(
    void*,
    const xpod_rdf_vector_search_request* request,
    xpod_rdf_estimate* out_estimate) {
  if (request->dimensions != 2) return XPOD_RDF_STATUS_BACKEND_ERROR;
  out_estimate->rows = 7;
  out_estimate->confidence = XPOD_RDF_ESTIMATE_HEURISTIC;
  return XPOD_RDF_STATUS_OK;
}

static xpod_rdf_status vector_search(
    void* user_data,
    const xpod_rdf_vector_search_request* request,
    xpod_rdf_candidate_batch_callback on_batch,
    void* callback_user_data) {
  State* state = static_cast<State*>(user_data);
  state->vector_calls++;
  if (request->dimensions != 2) return XPOD_RDF_STATUS_BACKEND_ERROR;
  if (request->vector[0] != 0.1 || request->vector[1] != 0.2) return XPOD_RDF_STATUS_BACKEND_ERROR;
  if (!bytes_equal(request->model, "embed-v1")) return XPOD_RDF_STATUS_BACKEND_ERROR;
  if (request->limit != 3) return XPOD_RDF_STATUS_BACKEND_ERROR;
  xpod_rdf_candidate row = {};
  row.has_source_node = 1;
  row.source_node = 202;
  row.score = 0.9;
  xpod_rdf_candidate_batch batch = {};
  batch.rows = &row;
  batch.row_count = 1;
  batch.scanned_rows = 11;
  batch.scorer = {"vector-cosine", 13};
  return on_batch(callback_user_data, &batch);
}

int main() {
  State state = {};
  xpod_rdf_backend_v1 backend = {};
  backend.abi_version = XPOD_RDF_PHYSICAL_BACKEND_ABI_VERSION;
  backend.struct_size = sizeof(xpod_rdf_backend_v1);
  backend.backend_user_data = &state;
  backend.on_profile_event = on_profile;
  backend.profile_user_data = &state;
  backend.get_capabilities = get_capabilities;
  backend.estimate_text_search = estimate_text_search;
  backend.text_search = text_search;
  backend.estimate_vector_search = estimate_vector_search;
  backend.vector_search = vector_search;
  xpod::rdf::PhysicalBackend physical(&backend);
  if (!xpod::qlever::isBridgeCandidateRoot(xpod::qlever::BridgeOperationKind::TextSearch)) return 32;
  if (!xpod::qlever::isBridgeCandidateRoot(xpod::qlever::BridgeOperationKind::VectorSearch)) return 33;
  if (xpod::qlever::isBridgeCandidateRoot(xpod::qlever::BridgeOperationKind::HashJoin)) return 34;

  xpod::qlever::BridgePhysicalPlan text_plan;
  xpod::qlever::BridgeTextCandidateSource text;
  text.request.query = {"topic", 5};
  text.request.source_scope.local_path_prefix = {"/workspace/docs/", 16};
  text.request.limit = 2;
  text.descriptor = "text candidate root";
  text.profile_node = 10;
  text_plan.text_sources.push_back(text);
  text_plan.root.kind = xpod::qlever::BridgeOperationKind::TextSearch;
  text_plan.root.candidate_index = 0;

  auto text_result = xpod::qlever::executeBridgeCandidateOperationPlan(physical, text_plan);
  if (text_result.status != XPOD_RDF_STATUS_OK) return 1;
  if (text_result.candidates.rows.size() != 1) return 2;
  if (!text_result.candidates.rows[0].has_retrieval_point || text_result.candidates.rows[0].retrieval_point != 101) return 3;
  if (text_result.candidates.scanned_rows != 9) return 4;
  auto typed_text_result = xpod::qlever::executeBridgePhysicalPlan(physical, text_plan);
  if (typed_text_result.kind != xpod::qlever::BridgePhysicalResultKind::CandidateRows) return 18;
  if (!typed_text_result.candidates.has_value()) return 19;
  if (typed_text_result.candidates->status != XPOD_RDF_STATUS_OK) return 20;
  if (typed_text_result.candidates->candidates.rows.size() != 1) return 21;

  double vector_values[2] = {0.1, 0.2};
  xpod::qlever::BridgePhysicalPlan vector_plan;
  xpod::qlever::BridgeVectorCandidateSource vector;
  vector.request.vector = vector_values;
  vector.request.dimensions = 2;
  vector.request.model = {"embed-v1", 8};
  vector.request.metric = XPOD_RDF_VECTOR_COSINE;
  vector.request.limit = 3;
  vector.descriptor = "vector candidate root";
  vector.profile_node = 20;
  vector_plan.vector_sources.push_back(vector);
  vector_plan.root.kind = xpod::qlever::BridgeOperationKind::VectorSearch;
  vector_plan.root.candidate_index = 0;

  auto vector_result = xpod::qlever::executeBridgeCandidateOperationPlan(physical, vector_plan);
  if (vector_result.status != XPOD_RDF_STATUS_OK) return 5;
  if (vector_result.candidates.rows.size() != 1) return 6;
  if (!vector_result.candidates.rows[0].has_source_node || vector_result.candidates.rows[0].source_node != 202) return 7;
  if (vector_result.candidates.scanned_rows != 11) return 8;
  auto typed_vector_result = xpod::qlever::executeBridgePhysicalPlan(physical, vector_plan);
  if (typed_vector_result.kind != xpod::qlever::BridgePhysicalResultKind::CandidateRows) return 22;
  if (!typed_vector_result.candidates.has_value()) return 23;
  if (typed_vector_result.candidates->status != XPOD_RDF_STATUS_OK) return 24;
  if (typed_vector_result.candidates->candidates.rows.size() != 1) return 25;

  auto qlever_result = xpod::qlever::executeBridgeOperationPlan(physical, text_plan);
  if (qlever_result.status != XPOD_RDF_STATUS_UNSUPPORTED) return 9;
  if (state.text_calls != 2 || state.vector_calls != 2) return 10;
  if (state.profile_calls != 8) return 11;
  if (state.profile_kinds[0] != XPOD_RDF_PROFILE_TEXT_SEARCH) return 12;
  if (state.profile_statuses[0] != XPOD_RDF_PROFILE_RUNNING) return 13;
  if (state.profile_statuses[1] != XPOD_RDF_PROFILE_COMPLETED) return 14;
  if (state.profile_kinds[2] != XPOD_RDF_PROFILE_TEXT_SEARCH) return 15;
  if (state.profile_statuses[2] != XPOD_RDF_PROFILE_RUNNING) return 16;
  if (state.profile_statuses[3] != XPOD_RDF_PROFILE_COMPLETED) return 17;
  if (state.profile_kinds[4] != XPOD_RDF_PROFILE_VECTOR_SEARCH) return 26;
  if (state.profile_statuses[4] != XPOD_RDF_PROFILE_RUNNING) return 27;
  if (state.profile_statuses[5] != XPOD_RDF_PROFILE_COMPLETED) return 28;
  if (state.profile_kinds[6] != XPOD_RDF_PROFILE_VECTOR_SEARCH) return 29;
  if (state.profile_statuses[6] != XPOD_RDF_PROFILE_RUNNING) return 30;
  if (state.profile_statuses[7] != XPOD_RDF_PROFILE_COMPLETED) return 31;
  return 0;
}
`, 'utf8');

      execFileSync('c++', [
        '-std=c++17',
        '-Wall',
        '-Wextra',
        '-Werror',
        '-DXPOD_QLEVER_ADAPTER_ENABLE_QLEVER=1',
        '-I', path.dirname(operationHeader),
        '-I', path.join(repoRoot, 'native/postgres/rdf_protocol/include'),
        '-I', path.join(qleverSource, 'src'),
        smoke,
        '-o',
        binary,
      ], { stdio: 'pipe' });
      execFileSync(binary, [], { stdio: 'pipe' });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('fails closed when declared candidate output columns are missing', async () => {
    expect(hasCxx(), 'c++ compiler is required for native candidate operation bridge check').toBe(true);

    const root = await mkdtemp(path.join(os.tmpdir(), 'xpod-qlever-candidate-columns-'));
    try {
      const qleverSource = await writeFakeQleverHeaders(root);
      const smoke = path.join(root, 'candidate_columns_smoke.cpp');
      const binary = path.join(root, 'candidate_columns_smoke');
      await writeFile(smoke, `
#include "XpodQleverOperationExecutor.hpp"

#include <string>

static bool bytes_equal(xpod_rdf_bytes actual, const char* expected) {
  return std::string(actual.data, actual.size) == expected;
}

static xpod_rdf_status get_capabilities(
    void*,
    xpod_rdf_backend_capabilities* out_capabilities) {
  out_capabilities->features = XPOD_RDF_BACKEND_FEATURE_TEXT_SEARCH;
  return XPOD_RDF_STATUS_OK;
}

static xpod_rdf_status estimate_text_search(
    void*,
    const xpod_rdf_text_search_request*,
    xpod_rdf_estimate* out_estimate) {
  out_estimate->rows = 1;
  out_estimate->confidence = XPOD_RDF_ESTIMATE_FRESH;
  return XPOD_RDF_STATUS_OK;
}

static xpod_rdf_status text_search(
    void*,
    const xpod_rdf_text_search_request* request,
    xpod_rdf_candidate_batch_callback on_batch,
    void* callback_user_data) {
  if (!bytes_equal(request->query, "entity-topic")) {
    return XPOD_RDF_STATUS_BACKEND_ERROR;
  }
  xpod_rdf_candidate row = {};
  row.has_retrieval_point = 1;
  row.retrieval_point = 101;
  row.score = 0.8;
  xpod_rdf_candidate_batch batch = {};
  batch.rows = &row;
  batch.row_count = 1;
  return on_batch(callback_user_data, &batch);
}

int main() {
  xpod_rdf_backend_v1 backend = {};
  backend.abi_version = XPOD_RDF_PHYSICAL_BACKEND_ABI_VERSION;
  backend.struct_size = sizeof(xpod_rdf_backend_v1);
  backend.get_capabilities = get_capabilities;
  backend.estimate_text_search = estimate_text_search;
  backend.text_search = text_search;
  xpod::rdf::PhysicalBackend physical(&backend);

  xpod::qlever::BridgePhysicalPlan plan;
  xpod::qlever::BridgeTextCandidateSource source;
  source.request.query = {"entity-topic", 12};
  source.output_columns.push_back({
      "text",
      xpod::qlever::BridgeCandidateColumnKind::RetrievalPoint,
  });
  source.output_columns.push_back({
      "entity",
      xpod::qlever::BridgeCandidateColumnKind::ResourceTerm,
  });
  plan.text_sources.push_back(source);
  plan.root.kind = xpod::qlever::BridgeOperationKind::TextSearch;
  plan.root.candidate_index = 0;

  auto result = xpod::qlever::executeBridgeCandidateOperationPlan(physical, plan);
  if (result.status != XPOD_RDF_STATUS_UNSUPPORTED) return 1;
  if (result.candidates.rows.size() != 1) return 2;
  if (!result.candidates.rows[0].has_retrieval_point) return 3;
  if (result.candidates.rows[0].has_resource_term) return 4;
  return 0;
}
`, 'utf8');

      execFileSync('c++', [
        '-std=c++17',
        '-Wall',
        '-Wextra',
        '-Werror',
        '-DXPOD_QLEVER_ADAPTER_ENABLE_QLEVER=1',
        '-I', path.dirname(operationHeader),
        '-I', path.join(repoRoot, 'native/postgres/rdf_protocol/include'),
        '-I', path.join(qleverSource, 'src'),
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
