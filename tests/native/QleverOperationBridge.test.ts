import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(__dirname, '../..');
const operationHeader = path.join(repoRoot, 'native/postgres/qlever_adapter/src/XpodQleverOperationExecutor.hpp');
const bridgeSource = path.join(repoRoot, 'native/postgres/qlever_adapter/src/XpodQleverBridge.cpp');

function hasCxx(): boolean {
  try {
    execFileSync('/usr/bin/env', ['c++', '--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

describe('QLever native physical operation bridge', () => {
  it('keeps query bridge delegated to the native physical operation executor', () => {
    const source = readFileSync(bridgeSource, 'utf8');

    expect(source).toContain('executeBridgeOperationPlan');
    expect(source).toContain('isBridgeCandidateRoot(plan.root.kind)');
    expect(source).toContain('QLever bridge query produced candidate rows');
    expect(source).not.toContain('collectFilterSubjectKeys');
    expect(source).not.toContain('filterResultBySubject');
  });

  it('executes a hash-join physical plan without TS planner mediation', async () => {
    expect(hasCxx(), 'c++ compiler is required for native operation bridge check').toBe(true);

    const root = await mkdtemp(path.join(os.tmpdir(), 'xpod-qlever-operation-bridge-'));
    try {
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

      const smoke = path.join(root, 'operation_bridge_smoke.cpp');
      const binary = path.join(root, 'operation_bridge_smoke');
      await writeFile(smoke, `
#include "XpodQleverOperationExecutor.hpp"

static xpod_rdf_status encode(void*, xpod_rdf_term_key term, uint64_t* out_bits) {
  *out_bits = term + 1000;
  return XPOD_RDF_STATUS_OK;
}

static xpod_rdf_status decode(void*, uint64_t bits, xpod_rdf_term_key* out_term) {
  *out_term = bits - 1000;
  return XPOD_RDF_STATUS_OK;
}

struct ScanState { int calls = 0; };

struct ProfileState {
  int calls = 0;
  xpod_rdf_profile_kind kinds[16] = {};
  xpod_rdf_profile_status statuses[16] = {};
  xpod_rdf_profile_node_key nodes[16] = {};
  xpod_rdf_profile_node_key parents[16] = {};
  uint8_t has_parents[16] = {};
  uint64_t output_rows[16] = {};
};

static void on_profile(void* user_data, const xpod_rdf_profile_event* event) {
  auto* state = static_cast<ProfileState*>(user_data);
  int index = state->calls++;
  if (index >= 16) return;
  state->kinds[index] = event->kind;
  state->statuses[index] = event->status;
  state->nodes[index] = event->node;
  state->parents[index] = event->parent;
  state->has_parents[index] = event->has_parent;
  state->output_rows[index] = event->output_rows;
}

static bool bytes_equal(xpod_rdf_bytes actual, const char* expected) {
  size_t index = 0;
  for (; expected[index] != '\\0'; ++index) {
    if (index >= actual.size || actual.data[index] != expected[index]) {
      return false;
    }
  }
  return index == actual.size;
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
  if (!bytes_equal(request->query, "native-first")) {
    return XPOD_RDF_STATUS_BACKEND_ERROR;
  }
  xpod_rdf_candidate row = {};
  row.has_resource_term = 1;
  row.resource_term = 11;
  row.score = 0.9;
  xpod_rdf_candidate_batch batch = {};
  batch.rows = &row;
  batch.row_count = 1;
  batch.scanned_rows = 3;
  return on_batch(callback_user_data, &batch);
}

static xpod_rdf_status estimate_vector_search(
    void*,
    const xpod_rdf_vector_search_request* request,
    xpod_rdf_estimate* out_estimate) {
  if (request->dimensions != 2) {
    return XPOD_RDF_STATUS_BACKEND_ERROR;
  }
  if (!bytes_equal(request->model, "embed-v1")) {
    return XPOD_RDF_STATUS_BACKEND_ERROR;
  }
  out_estimate->rows = 1;
  out_estimate->confidence = XPOD_RDF_ESTIMATE_FRESH;
  return XPOD_RDF_STATUS_OK;
}

static xpod_rdf_status vector_search(
    void*,
    const xpod_rdf_vector_search_request* request,
    xpod_rdf_candidate_batch_callback on_batch,
    void* callback_user_data) {
  if (request->dimensions != 2) {
    return XPOD_RDF_STATUS_BACKEND_ERROR;
  }
  if (!bytes_equal(request->model, "embed-v1")) {
    return XPOD_RDF_STATUS_BACKEND_ERROR;
  }
  xpod_rdf_candidate row = {};
  row.has_resource_term = 1;
  row.resource_term = 11;
  row.score = 0.91;
  xpod_rdf_candidate_batch batch = {};
  batch.rows = &row;
  batch.row_count = 1;
  batch.scanned_rows = 4;
  return on_batch(callback_user_data, &batch);
}

static xpod_rdf_status scan(
    void* user_data,
    const xpod_rdf_scan_request* request,
    xpod_rdf_quad_batch_callback on_batch,
    void* callback_user_data) {
  auto* state = static_cast<ScanState*>(user_data);
  state->calls += 1;
  if (request->permutation != XPOD_RDF_PERM_SPOG) return XPOD_RDF_STATUS_BACKEND_ERROR;
  if (request->pattern.has_predicate) {
    if (!request->pattern.has_object) return XPOD_RDF_STATUS_BACKEND_ERROR;
    xpod_rdf_quad_key rows[1] = {};
    if (request->pattern.predicate == 50 && request->pattern.object == 60) {
      rows[0] = {10, 50, 60, 40};
    } else if (request->pattern.predicate == 70 && request->pattern.object == 80) {
      rows[0] = {10, 70, 80, 40};
    } else if (request->pattern.predicate == 90 && request->pattern.object == 100) {
      rows[0] = {30, 90, 100, 40};
    } else {
      return XPOD_RDF_STATUS_BACKEND_ERROR;
    }
    xpod_rdf_quad_batch batch = {};
    batch.rows = rows;
    batch.row_count = 1;
    return on_batch(callback_user_data, &batch);
  }
  xpod_rdf_quad_key rows[2] = {
    {10, 20, 30, 40},
    {11, 20, 31, 40},
  };
  xpod_rdf_quad_batch batch = {};
  batch.rows = rows;
  batch.row_count = 2;
  return on_batch(callback_user_data, &batch);
}

int main() {
  ScanState state;
  xpod_rdf_backend_v1 backend = {};
  backend.abi_version = XPOD_RDF_PHYSICAL_BACKEND_ABI_VERSION;
  backend.struct_size = sizeof(xpod_rdf_backend_v1);
  backend.backend_user_data = &state;
  backend.encode_qlever_id = encode;
  backend.decode_qlever_id = decode;
  backend.scan_permutation = scan;
  backend.estimate_text_search = estimate_text_search;
  backend.text_search = text_search;
  backend.estimate_vector_search = estimate_vector_search;
  backend.vector_search = vector_search;
  xpod::rdf::PhysicalBackend physical(&backend);

  xpod::qlever::BridgePhysicalPlan plan;
  xpod::qlever::BridgePhysicalScan primary;
  primary.scan.permutation = Permutation::Enum::SPO;
  primary.scan.needed_slots = XPOD_RDF_SLOT_SUBJECT | XPOD_RDF_SLOT_PREDICATE | XPOD_RDF_SLOT_OBJECT;
  primary.sorted_by = {0};
  primary.result_width = 3;
  primary.descriptor = "main scan";
  plan.scans.push_back(primary);

  xpod::qlever::BridgePhysicalScan filter;
  filter.scan.permutation = Permutation::Enum::SPO;
  filter.scan.pattern.has_predicate = true;
  filter.scan.pattern.predicate = 50;
  filter.scan.pattern.has_object = true;
  filter.scan.pattern.object = 60;
  filter.scan.needed_slots = XPOD_RDF_SLOT_SUBJECT | XPOD_RDF_SLOT_PREDICATE | XPOD_RDF_SLOT_OBJECT;
  filter.descriptor = "filter scan";
  plan.scans.push_back(filter);

  xpod::qlever::BridgePhysicalScan second_filter;
  second_filter.scan.permutation = Permutation::Enum::SPO;
  second_filter.scan.pattern.has_predicate = true;
  second_filter.scan.pattern.predicate = 70;
  second_filter.scan.pattern.has_object = true;
  second_filter.scan.pattern.object = 80;
  second_filter.scan.needed_slots = XPOD_RDF_SLOT_SUBJECT | XPOD_RDF_SLOT_PREDICATE | XPOD_RDF_SLOT_OBJECT;
  second_filter.descriptor = "second filter scan";
  plan.scans.push_back(second_filter);

  plan.root.kind = xpod::qlever::BridgeOperationKind::HashJoin;
  plan.root.scan_indexes = {0, 1, 2};
  plan.root.join_slot = XPOD_RDF_SLOT_SUBJECT;

  auto result = xpod::qlever::executeBridgeOperationPlan(physical, plan);
  if (result.status != XPOD_RDF_STATUS_OK) return 1;
  if (state.calls != 3) return 2;
  const IdTable& table = result.result.idTable();
  if (table.numColumns() != 3 || table.numRows() != 1) return 3;
  if (table(0, 0).getBits() != 1010) return 4;
  if (table(0, 1).getBits() != 1020) return 5;
  if (table(0, 2).getBits() != 1030) return 6;
  if (result.result.sortedBy().size() != 1 || result.result.sortedBy()[0] != 0) return 7;
  if (state.calls != 3) return 8;

  state.calls = 0;
  xpod::qlever::BridgePhysicalPlan cross_slot_plan;
  xpod::qlever::BridgePhysicalScan cross_primary;
  cross_primary.scan.permutation = Permutation::Enum::SPO;
  cross_primary.scan.needed_slots = XPOD_RDF_SLOT_SUBJECT | XPOD_RDF_SLOT_PREDICATE | XPOD_RDF_SLOT_OBJECT;
  cross_primary.sorted_by = {0};
  cross_primary.result_width = 3;
  cross_primary.descriptor = "cross-slot primary scan";
  cross_slot_plan.scans.push_back(cross_primary);

  xpod::qlever::BridgePhysicalScan cross_filter;
  cross_filter.scan.permutation = Permutation::Enum::SPO;
  cross_filter.scan.pattern.has_predicate = true;
  cross_filter.scan.pattern.predicate = 90;
  cross_filter.scan.pattern.has_object = true;
  cross_filter.scan.pattern.object = 100;
  cross_filter.scan.needed_slots = XPOD_RDF_SLOT_SUBJECT;
  cross_filter.descriptor = "cross-slot subject filter scan";
  cross_slot_plan.scans.push_back(cross_filter);

  cross_slot_plan.root.kind = xpod::qlever::BridgeOperationKind::HashJoin;
  cross_slot_plan.root.scan_indexes = {0, 1};
  cross_slot_plan.root.join_slot = XPOD_RDF_SLOT_OBJECT;
  cross_slot_plan.root.join_slots = {XPOD_RDF_SLOT_OBJECT, XPOD_RDF_SLOT_SUBJECT};

  auto cross_result = xpod::qlever::executeBridgeOperationPlan(physical, cross_slot_plan);
  if (cross_result.status != XPOD_RDF_STATUS_OK) return 9;
  if (state.calls != 2) return 10;
  const IdTable& cross_table = cross_result.result.idTable();
  if (cross_table.numColumns() != 3 || cross_table.numRows() != 1) return 11;
  if (cross_table(0, 0).getBits() != 1010) return 12;
  if (cross_table(0, 1).getBits() != 1020) return 13;
  if (cross_table(0, 2).getBits() != 1030) return 14;

  ProfileState profile;
  backend.on_profile_event = on_profile;
  backend.profile_user_data = &profile;

  state.calls = 0;
  xpod::qlever::BridgePhysicalPlan profile_plan;
  xpod::qlever::BridgePhysicalScan profile_primary;
  profile_primary.scan.permutation = Permutation::Enum::SPO;
  profile_primary.scan.needed_slots = XPOD_RDF_SLOT_SUBJECT | XPOD_RDF_SLOT_PREDICATE | XPOD_RDF_SLOT_OBJECT;
  profile_primary.sorted_by = {0};
  profile_primary.result_width = 3;
  profile_primary.descriptor = "profile primary scan";
  profile_primary.profile_node = 101;
  profile_primary.parent_profile_node = 100;
  profile_plan.scans.push_back(profile_primary);

  xpod::qlever::BridgePhysicalScan profile_filter;
  profile_filter.scan.permutation = Permutation::Enum::SPO;
  profile_filter.scan.pattern.has_predicate = true;
  profile_filter.scan.pattern.predicate = 50;
  profile_filter.scan.pattern.has_object = true;
  profile_filter.scan.pattern.object = 60;
  profile_filter.scan.needed_slots = XPOD_RDF_SLOT_SUBJECT;
  profile_filter.descriptor = "profile filter scan";
  profile_filter.profile_node = 102;
  profile_filter.parent_profile_node = 100;
  profile_plan.scans.push_back(profile_filter);

  profile_plan.root.kind = xpod::qlever::BridgeOperationKind::HashJoin;
  profile_plan.root.scan_indexes = {0, 1};
  profile_plan.root.join_slot = XPOD_RDF_SLOT_SUBJECT;
  profile_plan.root.profile_node = 100;

  auto profile_result = xpod::qlever::executeBridgeOperationPlan(physical, profile_plan);
  if (profile_result.status != XPOD_RDF_STATUS_OK) return 15;
  if (profile.calls != 6) return 16;
  if (profile.kinds[0] != XPOD_RDF_PROFILE_RDF_JOIN || profile.statuses[0] != XPOD_RDF_PROFILE_RUNNING) return 17;
  if (profile.nodes[0] != 100 || profile.has_parents[0]) return 18;
  if (profile.kinds[1] != XPOD_RDF_PROFILE_PERMUTATION_SCAN || profile.statuses[1] != XPOD_RDF_PROFILE_RUNNING) return 19;
  if (profile.nodes[1] != 102 || !profile.has_parents[1] || profile.parents[1] != 100) return 20;
  if (profile.kinds[2] != XPOD_RDF_PROFILE_PERMUTATION_SCAN || profile.statuses[2] != XPOD_RDF_PROFILE_COMPLETED) return 21;
  if (profile.nodes[2] != 102 || !profile.has_parents[2] || profile.parents[2] != 100) return 22;
  if (profile.kinds[3] != XPOD_RDF_PROFILE_PERMUTATION_SCAN || profile.statuses[3] != XPOD_RDF_PROFILE_RUNNING) return 23;
  if (profile.nodes[3] != 101 || !profile.has_parents[3] || profile.parents[3] != 100) return 24;
  if (profile.kinds[4] != XPOD_RDF_PROFILE_PERMUTATION_SCAN || profile.statuses[4] != XPOD_RDF_PROFILE_COMPLETED) return 25;
  if (profile.nodes[4] != 101 || !profile.has_parents[4] || profile.parents[4] != 100) return 26;
  if (profile.kinds[5] != XPOD_RDF_PROFILE_RDF_JOIN || profile.statuses[5] != XPOD_RDF_PROFILE_COMPLETED) return 27;
  if (profile.nodes[5] != 100 || profile.has_parents[5]) return 28;
  if (profile.output_rows[5] != 1) return 29;

  state.calls = 0;
  profile = {};
  xpod::qlever::BridgePhysicalPlan candidate_join_plan;
  xpod::qlever::BridgeTextCandidateSource text_source;
  text_source.setQuery("native-first");
  text_source.output_columns.push_back({
      "entity",
      xpod::qlever::BridgeCandidateColumnKind::ResourceTerm,
  });
  text_source.profile_node = 202;
  text_source.parent_profile_node = 200;
  candidate_join_plan.text_sources.push_back(text_source);

  xpod::qlever::BridgePhysicalScan candidate_primary;
  candidate_primary.scan.permutation = Permutation::Enum::SPO;
  candidate_primary.scan.needed_slots = XPOD_RDF_SLOT_SUBJECT | XPOD_RDF_SLOT_PREDICATE | XPOD_RDF_SLOT_OBJECT;
  candidate_primary.sorted_by = {0};
  candidate_primary.result_width = 3;
  candidate_primary.descriptor = "candidate join primary scan";
  candidate_primary.profile_node = 203;
  candidate_primary.parent_profile_node = 200;
  candidate_join_plan.scans.push_back(candidate_primary);

  candidate_join_plan.root.kind = xpod::qlever::BridgeOperationKind::HashJoin;
  candidate_join_plan.root.use_candidate_join = true;
  candidate_join_plan.root.candidate_index = 0;
  candidate_join_plan.root.candidate_join_column =
      xpod::qlever::BridgeCandidateColumnKind::ResourceTerm;
  candidate_join_plan.root.scan_indexes = {0};
  candidate_join_plan.root.join_slot = XPOD_RDF_SLOT_SUBJECT;
  candidate_join_plan.root.join_slots = {XPOD_RDF_SLOT_SUBJECT};
  candidate_join_plan.root.profile_node = 200;

  auto candidate_join_result = xpod::qlever::executeBridgeOperationPlan(physical, candidate_join_plan);
  if (candidate_join_result.status != XPOD_RDF_STATUS_OK) return 30;
  if (state.calls != 1) return 31;
  const IdTable& candidate_join_table = candidate_join_result.result.idTable();
  if (candidate_join_table.numColumns() != 3 || candidate_join_table.numRows() != 1) return 32;
  if (candidate_join_table(0, 0).getBits() != 1011) return 33;
  if (candidate_join_table(0, 1).getBits() != 1020) return 34;
  if (candidate_join_table(0, 2).getBits() != 1031) return 35;
  if (profile.calls != 6) return 36;
  if (profile.kinds[0] != XPOD_RDF_PROFILE_RDF_JOIN || profile.statuses[0] != XPOD_RDF_PROFILE_RUNNING) return 37;
  if (profile.nodes[0] != 200 || profile.has_parents[0]) return 38;
  if (profile.kinds[1] != XPOD_RDF_PROFILE_TEXT_SEARCH || profile.statuses[1] != XPOD_RDF_PROFILE_RUNNING) return 39;
  if (profile.nodes[1] != 202 || !profile.has_parents[1] || profile.parents[1] != 200) return 40;
  if (profile.kinds[2] != XPOD_RDF_PROFILE_TEXT_SEARCH || profile.statuses[2] != XPOD_RDF_PROFILE_COMPLETED) return 41;
  if (profile.nodes[2] != 202 || !profile.has_parents[2] || profile.parents[2] != 200) return 42;
  if (profile.kinds[3] != XPOD_RDF_PROFILE_PERMUTATION_SCAN || profile.statuses[3] != XPOD_RDF_PROFILE_RUNNING) return 43;
  if (profile.nodes[3] != 203 || !profile.has_parents[3] || profile.parents[3] != 200) return 44;
  if (profile.kinds[4] != XPOD_RDF_PROFILE_PERMUTATION_SCAN || profile.statuses[4] != XPOD_RDF_PROFILE_COMPLETED) return 45;
  if (profile.nodes[4] != 203 || !profile.has_parents[4] || profile.parents[4] != 200) return 46;
  if (profile.kinds[5] != XPOD_RDF_PROFILE_RDF_JOIN || profile.statuses[5] != XPOD_RDF_PROFILE_COMPLETED) return 47;
  if (profile.nodes[5] != 200 || profile.has_parents[5]) return 48;
  if (profile.output_rows[5] != 1) return 49;

  state.calls = 0;
  profile = {};
  double vector_values[2] = {0.1, 0.2};
  xpod::qlever::BridgePhysicalPlan vector_join_plan;
  xpod::qlever::BridgeVectorCandidateSource vector_source;
  vector_source.request.vector = vector_values;
  vector_source.request.dimensions = 2;
  vector_source.request.model = {"embed-v1", 8};
  vector_source.request.metric = XPOD_RDF_VECTOR_COSINE;
  vector_source.request.limit = 2;
  vector_source.descriptor = "vector resource candidate";
  vector_source.profile_node = 302;
  vector_source.parent_profile_node = 300;
  vector_join_plan.vector_sources.push_back(vector_source);

  xpod::qlever::BridgePhysicalScan vector_primary;
  vector_primary.scan.permutation = Permutation::Enum::SPO;
  vector_primary.scan.needed_slots = XPOD_RDF_SLOT_SUBJECT | XPOD_RDF_SLOT_PREDICATE | XPOD_RDF_SLOT_OBJECT;
  vector_primary.sorted_by = {0};
  vector_primary.result_width = 3;
  vector_primary.descriptor = "vector candidate join primary scan";
  vector_primary.profile_node = 303;
  vector_primary.parent_profile_node = 300;
  vector_join_plan.scans.push_back(vector_primary);

  vector_join_plan.root.kind = xpod::qlever::BridgeOperationKind::HashJoin;
  vector_join_plan.root.use_candidate_join = true;
  vector_join_plan.root.candidate_source =
      xpod::qlever::BridgeCandidateSourceKind::Vector;
  vector_join_plan.root.candidate_index = 0;
  vector_join_plan.root.candidate_join_column =
      xpod::qlever::BridgeCandidateColumnKind::ResourceTerm;
  vector_join_plan.root.scan_indexes = {0};
  vector_join_plan.root.join_slot = XPOD_RDF_SLOT_SUBJECT;
  vector_join_plan.root.join_slots = {XPOD_RDF_SLOT_SUBJECT};
  vector_join_plan.root.profile_node = 300;

  auto vector_join_result = xpod::qlever::executeBridgeOperationPlan(physical, vector_join_plan);
  if (vector_join_result.status != XPOD_RDF_STATUS_OK) return 50;
  if (state.calls != 1) return 51;
  const IdTable& vector_join_table = vector_join_result.result.idTable();
  if (vector_join_table.numColumns() != 3 || vector_join_table.numRows() != 1) return 52;
  if (vector_join_table(0, 0).getBits() != 1011) return 53;
  if (vector_join_table(0, 1).getBits() != 1020) return 54;
  if (vector_join_table(0, 2).getBits() != 1031) return 55;
  if (profile.calls != 6) return 56;
  if (profile.kinds[0] != XPOD_RDF_PROFILE_RDF_JOIN || profile.statuses[0] != XPOD_RDF_PROFILE_RUNNING) return 57;
  if (profile.nodes[0] != 300 || profile.has_parents[0]) return 58;
  if (profile.kinds[1] != XPOD_RDF_PROFILE_VECTOR_SEARCH || profile.statuses[1] != XPOD_RDF_PROFILE_RUNNING) return 59;
  if (profile.nodes[1] != 302 || !profile.has_parents[1] || profile.parents[1] != 300) return 60;
  if (profile.kinds[2] != XPOD_RDF_PROFILE_VECTOR_SEARCH || profile.statuses[2] != XPOD_RDF_PROFILE_COMPLETED) return 61;
  if (profile.nodes[2] != 302 || !profile.has_parents[2] || profile.parents[2] != 300) return 62;
  if (profile.kinds[3] != XPOD_RDF_PROFILE_PERMUTATION_SCAN || profile.statuses[3] != XPOD_RDF_PROFILE_RUNNING) return 63;
  if (profile.nodes[3] != 303 || !profile.has_parents[3] || profile.parents[3] != 300) return 64;
  if (profile.kinds[4] != XPOD_RDF_PROFILE_PERMUTATION_SCAN || profile.statuses[4] != XPOD_RDF_PROFILE_COMPLETED) return 65;
  if (profile.nodes[4] != 303 || !profile.has_parents[4] || profile.parents[4] != 300) return 66;
  if (profile.kinds[5] != XPOD_RDF_PROFILE_RDF_JOIN || profile.statuses[5] != XPOD_RDF_PROFILE_COMPLETED) return 67;
  if (profile.nodes[5] != 300 || profile.has_parents[5]) return 68;
  if (profile.output_rows[5] != 1) return 69;
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
