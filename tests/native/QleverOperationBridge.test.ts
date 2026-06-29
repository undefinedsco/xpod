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
  static Id makeUndefined() { return Id(UINT64_MAX); }
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
  row.has_retrieval_point = 1;
  row.retrieval_point = 101;
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
    if (request->pattern.predicate == 20 && !request->pattern.has_object) {
      xpod_rdf_quad_key rows[2] = {
        {10, 20, 30, 40},
        {11, 20, 31, 40},
      };
      xpod_rdf_quad_batch batch = {};
      batch.rows = rows;
      batch.row_count = 2;
      return on_batch(callback_user_data, &batch);
    }
    if (request->pattern.predicate == 110 && !request->pattern.has_object) {
      xpod_rdf_quad_key rows[2] = {
        {11, 110, 111, 40},
        {10, 110, 112, 40},
      };
      xpod_rdf_quad_batch batch = {};
      batch.rows = rows;
      batch.row_count = 2;
      return on_batch(callback_user_data, &batch);
    }
    if (request->pattern.predicate == 130 && !request->pattern.has_object) {
      xpod_rdf_quad_key rows[1] = {
        {10, 130, 131, 40},
      };
      xpod_rdf_quad_batch batch = {};
      batch.rows = rows;
      batch.row_count = 1;
      return on_batch(callback_user_data, &batch);
    }
    if (request->pattern.predicate == 150 && !request->pattern.has_object) {
      xpod_rdf_quad_key rows[1] = {
        {10, 150, 151, 40},
      };
      xpod_rdf_quad_batch batch = {};
      batch.rows = rows;
      batch.row_count = 1;
      return on_batch(callback_user_data, &batch);
    }
    if (request->pattern.predicate == 170 && !request->pattern.has_object) {
      xpod_rdf_quad_key rows[3] = {
        {10, 170, 30, 40},
        {11, 170, 30, 40},
        {12, 170, 31, 40},
      };
      xpod_rdf_quad_batch batch = {};
      batch.rows = rows;
      batch.row_count = 3;
      return on_batch(callback_user_data, &batch);
    }
    if (request->pattern.predicate == 180 && !request->pattern.has_object) {
      xpod_rdf_quad_key rows[2] = {
        {10, 180, 30, 40},
        {10, 180, 31, 40},
      };
      xpod_rdf_quad_batch batch = {};
      batch.rows = rows;
      batch.row_count = 2;
      return on_batch(callback_user_data, &batch);
    }
    if (request->pattern.predicate == 190 && !request->pattern.has_object) {
      xpod_rdf_quad_key rows[3] = {
        {10, 190, 30, 40},
        {10, 190, 31, 40},
        {11, 190, 30, 40},
      };
      xpod_rdf_quad_batch batch = {};
      batch.rows = rows;
      batch.row_count = 3;
      return on_batch(callback_user_data, &batch);
    }
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
  xpod_rdf_quad_key rows[4] = {
    {10, 20, 30, 40},
    {11, 20, 31, 40},
    {12, 20, 32, 40},
    {13, 20, 33, 40},
  };
  xpod_rdf_quad_batch batch = {};
  batch.rows = rows;
  batch.row_count = 4;
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
      "text",
      xpod::qlever::BridgeCandidateColumnKind::RetrievalPoint,
  });
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
  candidate_join_plan.root.candidate_project_columns.push_back({
      "text",
      xpod::qlever::BridgeCandidateColumnKind::RetrievalPoint,
  });
  candidate_join_plan.root.scan_indexes = {0};
  candidate_join_plan.root.join_slot = XPOD_RDF_SLOT_SUBJECT;
  candidate_join_plan.root.join_slots = {XPOD_RDF_SLOT_SUBJECT};
  candidate_join_plan.root.profile_node = 200;

  auto candidate_join_result = xpod::qlever::executeBridgeOperationPlan(physical, candidate_join_plan);
  if (candidate_join_result.status != XPOD_RDF_STATUS_OK) return 30;
  if (state.calls != 1) return 31;
  const IdTable& candidate_join_table = candidate_join_result.result.idTable();
  if (candidate_join_table.numColumns() != 4 || candidate_join_table.numRows() != 1) return 32;
  if (candidate_join_table(0, 0).getBits() != 1101) return 33;
  if (candidate_join_table(0, 1).getBits() != 1011) return 34;
  if (candidate_join_table(0, 2).getBits() != 1020) return 35;
  if (candidate_join_table(0, 3).getBits() != 1031) return 36;
  if (profile.calls != 6) return 37;
  if (profile.kinds[0] != XPOD_RDF_PROFILE_RDF_JOIN || profile.statuses[0] != XPOD_RDF_PROFILE_RUNNING) return 38;
  if (profile.nodes[0] != 200 || profile.has_parents[0]) return 39;
  if (profile.kinds[1] != XPOD_RDF_PROFILE_TEXT_SEARCH || profile.statuses[1] != XPOD_RDF_PROFILE_RUNNING) return 40;
  if (profile.nodes[1] != 202 || !profile.has_parents[1] || profile.parents[1] != 200) return 41;
  if (profile.kinds[2] != XPOD_RDF_PROFILE_TEXT_SEARCH || profile.statuses[2] != XPOD_RDF_PROFILE_COMPLETED) return 42;
  if (profile.nodes[2] != 202 || !profile.has_parents[2] || profile.parents[2] != 200) return 43;
  if (profile.kinds[3] != XPOD_RDF_PROFILE_PERMUTATION_SCAN || profile.statuses[3] != XPOD_RDF_PROFILE_RUNNING) return 44;
  if (profile.nodes[3] != 203 || !profile.has_parents[3] || profile.parents[3] != 200) return 45;
  if (profile.kinds[4] != XPOD_RDF_PROFILE_PERMUTATION_SCAN || profile.statuses[4] != XPOD_RDF_PROFILE_COMPLETED) return 46;
  if (profile.nodes[4] != 203 || !profile.has_parents[4] || profile.parents[4] != 200) return 47;
  if (profile.kinds[5] != XPOD_RDF_PROFILE_RDF_JOIN || profile.statuses[5] != XPOD_RDF_PROFILE_COMPLETED) return 48;
  if (profile.nodes[5] != 200 || profile.has_parents[5]) return 49;
  if (profile.output_rows[5] != 1) return 50;

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

  state.calls = 0;
  xpod::qlever::BridgePhysicalPlan rdf_projection_plan;
  xpod::qlever::BridgePhysicalScan rdf_projection_primary;
  rdf_projection_primary.scan.permutation = Permutation::Enum::SPO;
  rdf_projection_primary.scan.needed_slots = XPOD_RDF_SLOT_SUBJECT | XPOD_RDF_SLOT_OBJECT;
  rdf_projection_primary.sorted_by = {0};
  rdf_projection_primary.result_width = 2;
  rdf_projection_primary.descriptor = "rdf projection primary scan";
  rdf_projection_plan.scans.push_back(rdf_projection_primary);

  xpod::qlever::BridgePhysicalScan rdf_projection_filter;
  rdf_projection_filter.scan.permutation = Permutation::Enum::SPO;
  rdf_projection_filter.scan.pattern.has_predicate = true;
  rdf_projection_filter.scan.pattern.predicate = 110;
  rdf_projection_filter.scan.needed_slots = XPOD_RDF_SLOT_SUBJECT | XPOD_RDF_SLOT_OBJECT;
  rdf_projection_filter.sorted_by = {0};
  rdf_projection_filter.result_width = 2;
  rdf_projection_filter.descriptor = "rdf projection filter scan";
  rdf_projection_plan.scans.push_back(rdf_projection_filter);

  rdf_projection_plan.root.kind = xpod::qlever::BridgeOperationKind::HashJoin;
  rdf_projection_plan.root.scan_indexes = {0, 1};
  rdf_projection_plan.root.join_slot = XPOD_RDF_SLOT_SUBJECT;
  rdf_projection_plan.root.join_slots = {
      XPOD_RDF_SLOT_SUBJECT,
      XPOD_RDF_SLOT_SUBJECT,
  };
  rdf_projection_plan.root.scan_project_slots = {
      {XPOD_RDF_SLOT_SUBJECT, XPOD_RDF_SLOT_OBJECT},
      {XPOD_RDF_SLOT_OBJECT},
  };

  auto rdf_projection_result = xpod::qlever::executeBridgeOperationPlan(physical, rdf_projection_plan);
  if (rdf_projection_result.status != XPOD_RDF_STATUS_OK) return 70;
  if (state.calls != 2) return 71;
  const IdTable& rdf_projection_table = rdf_projection_result.result.idTable();
  if (rdf_projection_table.numColumns() != 3 || rdf_projection_table.numRows() != 2) return 72;
  if (rdf_projection_table(0, 0).getBits() != 1010) return 73;
  if (rdf_projection_table(0, 1).getBits() != 1030) return 74;
  if (rdf_projection_table(0, 2).getBits() != 1112) return 75;
  if (rdf_projection_table(1, 0).getBits() != 1011) return 76;
  if (rdf_projection_table(1, 1).getBits() != 1031) return 77;
  if (rdf_projection_table(1, 2).getBits() != 1111) return 78;

  state.calls = 0;
  xpod::qlever::BridgePhysicalPlan multi_key_plan;
  xpod::qlever::BridgePhysicalScan multi_key_primary;
  multi_key_primary.scan.permutation = Permutation::Enum::SPO;
  multi_key_primary.scan.needed_slots =
      XPOD_RDF_SLOT_SUBJECT | XPOD_RDF_SLOT_PREDICATE | XPOD_RDF_SLOT_OBJECT;
  multi_key_primary.sorted_by = {0, 1};
  multi_key_primary.result_width = 3;
  multi_key_primary.descriptor = "multi-key primary scan";
  multi_key_plan.scans.push_back(multi_key_primary);

  xpod::qlever::BridgePhysicalScan multi_key_filter;
  multi_key_filter.scan.permutation = Permutation::Enum::SPO;
  multi_key_filter.scan.pattern.has_predicate = true;
  multi_key_filter.scan.pattern.predicate = 20;
  multi_key_filter.scan.needed_slots =
      XPOD_RDF_SLOT_SUBJECT | XPOD_RDF_SLOT_PREDICATE | XPOD_RDF_SLOT_OBJECT;
  multi_key_filter.sorted_by = {0, 1};
  multi_key_filter.result_width = 3;
  multi_key_filter.descriptor = "multi-key filter scan";
  multi_key_plan.scans.push_back(multi_key_filter);

  multi_key_plan.root.kind = xpod::qlever::BridgeOperationKind::HashJoin;
  multi_key_plan.root.scan_indexes = {0, 1};
  multi_key_plan.root.join_slot = XPOD_RDF_SLOT_SUBJECT;
  multi_key_plan.root.join_slots = {
      XPOD_RDF_SLOT_SUBJECT,
      XPOD_RDF_SLOT_SUBJECT,
  };
  multi_key_plan.root.join_key_slots = {
      {XPOD_RDF_SLOT_SUBJECT, XPOD_RDF_SLOT_PREDICATE},
      {XPOD_RDF_SLOT_SUBJECT, XPOD_RDF_SLOT_PREDICATE},
  };
  multi_key_plan.root.scan_project_slots = {
      {XPOD_RDF_SLOT_SUBJECT, XPOD_RDF_SLOT_PREDICATE, XPOD_RDF_SLOT_OBJECT},
      {XPOD_RDF_SLOT_OBJECT},
  };

  auto multi_key_result = xpod::qlever::executeBridgeOperationPlan(physical, multi_key_plan);
  if (multi_key_result.status != XPOD_RDF_STATUS_OK) return 79;
  if (state.calls != 2) return 80;
  const IdTable& multi_key_table = multi_key_result.result.idTable();
  if (multi_key_table.numColumns() != 4 || multi_key_table.numRows() != 2) return 81;
  if (multi_key_table(0, 0).getBits() != 1010) return 82;
  if (multi_key_table(0, 1).getBits() != 1020) return 83;
  if (multi_key_table(0, 2).getBits() != 1030) return 84;
  if (multi_key_table(0, 3).getBits() != 1030) return 85;
  if (multi_key_table(1, 0).getBits() != 1011) return 86;
  if (multi_key_table(1, 1).getBits() != 1020) return 87;
  if (multi_key_table(1, 2).getBits() != 1031) return 88;
  if (multi_key_table(1, 3).getBits() != 1031) return 89;

  state.calls = 0;
  xpod::qlever::BridgePhysicalPlan limit_plan;
  xpod::qlever::BridgePhysicalScan limit_scan;
  limit_scan.scan.permutation = Permutation::Enum::SPO;
  limit_scan.scan.needed_slots =
      XPOD_RDF_SLOT_SUBJECT | XPOD_RDF_SLOT_PREDICATE | XPOD_RDF_SLOT_OBJECT;
  limit_scan.sorted_by = {0};
  limit_scan.result_width = 3;
  limit_scan.descriptor = "limit primary scan";
  limit_plan.scans.push_back(limit_scan);
  limit_plan.root.kind = xpod::qlever::BridgeOperationKind::PermutationScan;
  limit_plan.root.scan_indexes = {0};
  limit_plan.root.has_limit = true;
  limit_plan.root.offset = 1;
  limit_plan.root.limit = 2;

  auto limit_result = xpod::qlever::executeBridgeOperationPlan(physical, limit_plan);
  if (limit_result.status != XPOD_RDF_STATUS_OK) return 90;
  if (state.calls != 1) return 91;
  const IdTable& limit_table = limit_result.result.idTable();
  if (limit_table.numColumns() != 3 || limit_table.numRows() != 2) return 92;
  if (limit_table(0, 0).getBits() != 1011) return 93;
  if (limit_table(0, 1).getBits() != 1020) return 94;
  if (limit_table(0, 2).getBits() != 1031) return 95;
  if (limit_table(1, 0).getBits() != 1012) return 96;
  if (limit_table(1, 1).getBits() != 1020) return 97;
  if (limit_table(1, 2).getBits() != 1032) return 98;

  state.calls = 0;
  xpod::qlever::BridgePhysicalPlan distinct_plan;
  xpod::qlever::BridgePhysicalScan distinct_scan;
  distinct_scan.scan.permutation = Permutation::Enum::SPO;
  distinct_scan.scan.needed_slots =
      XPOD_RDF_SLOT_SUBJECT | XPOD_RDF_SLOT_PREDICATE | XPOD_RDF_SLOT_OBJECT;
  distinct_scan.sorted_by = {0};
  distinct_scan.result_width = 3;
  distinct_scan.descriptor = "distinct primary scan";
  distinct_plan.scans.push_back(distinct_scan);
  distinct_plan.root.kind = xpod::qlever::BridgeOperationKind::PermutationScan;
  distinct_plan.root.scan_indexes = {0};
  distinct_plan.root.has_distinct = true;
  distinct_plan.root.distinct_columns = {1};

  auto distinct_result = xpod::qlever::executeBridgeOperationPlan(physical, distinct_plan);
  if (distinct_result.status != XPOD_RDF_STATUS_OK) return 99;
  if (state.calls != 1) return 100;
  const IdTable& distinct_table = distinct_result.result.idTable();
  if (distinct_table.numColumns() != 3 || distinct_table.numRows() != 1) return 101;
  if (distinct_table(0, 0).getBits() != 1010) return 102;
  if (distinct_table(0, 1).getBits() != 1020) return 103;
  if (distinct_table(0, 2).getBits() != 1030) return 104;

  state.calls = 0;
  xpod::qlever::BridgePhysicalPlan order_plan;
  xpod::qlever::BridgePhysicalScan order_scan;
  order_scan.scan.permutation = Permutation::Enum::SPO;
  order_scan.scan.needed_slots =
      XPOD_RDF_SLOT_SUBJECT | XPOD_RDF_SLOT_PREDICATE | XPOD_RDF_SLOT_OBJECT;
  order_scan.sorted_by = {0};
  order_scan.result_width = 3;
  order_scan.descriptor = "order primary scan";
  order_plan.scans.push_back(order_scan);
  order_plan.root.kind = xpod::qlever::BridgeOperationKind::PermutationScan;
  order_plan.root.scan_indexes = {0};
  xpod::qlever::BridgeResultModifier order_modifier;
  order_modifier.kind = xpod::qlever::BridgeResultModifierKind::OrderBy;
  order_modifier.columns = {2, 0};
  order_modifier.descending = {true, false};
  order_plan.root.result_modifiers.push_back(order_modifier);

  auto order_result = xpod::qlever::executeBridgeOperationPlan(physical, order_plan);
  if (order_result.status != XPOD_RDF_STATUS_OK) return 105;
  if (state.calls != 1) return 106;
  const IdTable& order_table = order_result.result.idTable();
  if (order_table.numColumns() != 3 || order_table.numRows() != 4) return 107;
  if (!order_result.result.sortedBy().empty()) return 108;
  if (order_table(0, 0).getBits() != 1013) return 109;
  if (order_table(0, 2).getBits() != 1033) return 110;
  if (order_table(1, 0).getBits() != 1012) return 111;
  if (order_table(1, 2).getBits() != 1032) return 112;
  if (order_table(2, 0).getBits() != 1011) return 113;
  if (order_table(2, 2).getBits() != 1031) return 114;
  if (order_table(3, 0).getBits() != 1010) return 115;
  if (order_table(3, 2).getBits() != 1030) return 116;

  state.calls = 0;
  xpod::qlever::BridgePhysicalPlan sort_plan;
  xpod::qlever::BridgePhysicalScan sort_scan;
  sort_scan.scan.permutation = Permutation::Enum::SPO;
  sort_scan.scan.pattern.has_predicate = true;
  sort_scan.scan.pattern.predicate = 110;
  sort_scan.scan.needed_slots =
      XPOD_RDF_SLOT_SUBJECT | XPOD_RDF_SLOT_PREDICATE | XPOD_RDF_SLOT_OBJECT;
  sort_scan.sorted_by = {};
  sort_scan.result_width = 3;
  sort_scan.descriptor = "sort primary scan";
  sort_plan.scans.push_back(sort_scan);
  sort_plan.root.kind = xpod::qlever::BridgeOperationKind::PermutationScan;
  sort_plan.root.scan_indexes = {0};
  xpod::qlever::BridgeResultModifier sort_modifier;
  sort_modifier.kind = xpod::qlever::BridgeResultModifierKind::InternalSort;
  sort_modifier.columns = {0};
  sort_plan.root.result_modifiers.push_back(sort_modifier);

  auto sort_result = xpod::qlever::executeBridgeOperationPlan(physical, sort_plan);
  if (sort_result.status != XPOD_RDF_STATUS_OK) return 117;
  if (state.calls != 1) return 118;
  const IdTable& sort_table = sort_result.result.idTable();
  if (sort_table.numColumns() != 3 || sort_table.numRows() != 2) return 119;
  if (sort_result.result.sortedBy().size() != 1 ||
      sort_result.result.sortedBy()[0] != 0) return 120;
  if (sort_table(0, 0).getBits() != 1010) return 121;
  if (sort_table(1, 0).getBits() != 1011) return 122;

  state.calls = 0;
  xpod::qlever::BridgePhysicalPlan neutral_plan;
  neutral_plan.root.kind = xpod::qlever::BridgeOperationKind::NeutralElement;
  auto neutral_result = xpod::qlever::executeBridgeOperationPlan(physical, neutral_plan);
  if (neutral_result.status != XPOD_RDF_STATUS_OK) return 123;
  if (state.calls != 0) return 124;
  const IdTable& neutral_table = neutral_result.result.idTable();
  if (neutral_table.numColumns() != 0 || neutral_table.numRows() != 1) return 125;
  if (!neutral_result.result.sortedBy().empty()) return 126;

  state.calls = 0;
  xpod::qlever::BridgePhysicalPlan union_plan;
  xpod::qlever::BridgePhysicalScan union_left;
  union_left.scan.permutation = Permutation::Enum::SPO;
  union_left.scan.pattern.has_predicate = true;
  union_left.scan.pattern.predicate = 20;
  union_left.scan.needed_slots = XPOD_RDF_SLOT_SUBJECT | XPOD_RDF_SLOT_OBJECT;
  union_left.result_width = 2;
  union_plan.scans.push_back(union_left);
  xpod::qlever::BridgePhysicalScan union_right;
  union_right.scan.permutation = Permutation::Enum::SPO;
  union_right.scan.pattern.has_predicate = true;
  union_right.scan.pattern.predicate = 110;
  union_right.scan.needed_slots = XPOD_RDF_SLOT_SUBJECT | XPOD_RDF_SLOT_OBJECT;
  union_right.result_width = 2;
  union_plan.scans.push_back(union_right);
  union_plan.root.kind = xpod::qlever::BridgeOperationKind::Union;
  union_plan.root.sorted_by = {0};
  union_plan.root.column_origins = {{ {0, 0}, {1, 1} }};
  xpod::qlever::BridgeOperationPlan union_left_root;
  union_left_root.kind = xpod::qlever::BridgeOperationKind::PermutationScan;
  union_left_root.scan_indexes = {0};
  xpod::qlever::BridgeOperationPlan union_right_root;
  union_right_root.kind = xpod::qlever::BridgeOperationKind::PermutationScan;
  union_right_root.scan_indexes = {1};
  union_plan.root.children = {union_left_root, union_right_root};
  auto union_result = xpod::qlever::executeBridgeOperationPlan(physical, union_plan);
  if (union_result.status != XPOD_RDF_STATUS_OK) return 127;
  if (state.calls != 2) return 128;
  const IdTable& union_table = union_result.result.idTable();
  if (union_table.numColumns() != 2 || union_table.numRows() != 4) return 129;
  if (union_table(0, 0).getBits() != 1010 || union_table(0, 1).getBits() != 1030) return 130;
  if (union_table(1, 0).getBits() != 1011 || union_table(1, 1).getBits() != 1031) return 131;
  if (union_table(2, 0).getBits() != 1011 || union_table(2, 1).getBits() != 1111) return 132;
  if (union_table(3, 0).getBits() != 1010 || union_table(3, 1).getBits() != 1112) return 133;
  if (union_result.result.sortedBy().size() != 1 || union_result.result.sortedBy()[0] != 0) return 134;

  state.calls = 0;
  xpod::qlever::BridgePhysicalPlan sparse_union_plan;
  xpod::qlever::BridgePhysicalScan sparse_union_left;
  sparse_union_left.scan.permutation = Permutation::Enum::SPO;
  sparse_union_left.scan.pattern.has_predicate = true;
  sparse_union_left.scan.pattern.predicate = 20;
  sparse_union_left.scan.needed_slots = XPOD_RDF_SLOT_SUBJECT | XPOD_RDF_SLOT_OBJECT;
  sparse_union_left.result_width = 2;
  sparse_union_plan.scans.push_back(sparse_union_left);
  xpod::qlever::BridgePhysicalScan sparse_union_right;
  sparse_union_right.scan.permutation = Permutation::Enum::SPO;
  sparse_union_right.scan.pattern.has_predicate = true;
  sparse_union_right.scan.pattern.predicate = 150;
  sparse_union_right.scan.needed_slots = XPOD_RDF_SLOT_SUBJECT | XPOD_RDF_SLOT_OBJECT;
  sparse_union_right.result_width = 2;
  sparse_union_plan.scans.push_back(sparse_union_right);
  sparse_union_plan.root.kind = xpod::qlever::BridgeOperationKind::Union;
  sparse_union_plan.root.sorted_by = {0};
  sparse_union_plan.root.column_origins = {{
      {0, 0},
      {1, xpod::qlever::BRIDGE_NO_COLUMN},
      {xpod::qlever::BRIDGE_NO_COLUMN, 1},
  }};
  xpod::qlever::BridgeOperationPlan sparse_union_left_root;
  sparse_union_left_root.kind = xpod::qlever::BridgeOperationKind::PermutationScan;
  sparse_union_left_root.scan_indexes = {0};
  xpod::qlever::BridgeOperationPlan sparse_union_right_root;
  sparse_union_right_root.kind = xpod::qlever::BridgeOperationKind::PermutationScan;
  sparse_union_right_root.scan_indexes = {1};
  sparse_union_plan.root.children = {sparse_union_left_root, sparse_union_right_root};
  auto sparse_union_result = xpod::qlever::executeBridgeOperationPlan(physical, sparse_union_plan);
  if (sparse_union_result.status != XPOD_RDF_STATUS_OK) return 152;
  if (state.calls != 2) return 153;
  const IdTable& sparse_union_table = sparse_union_result.result.idTable();
  if (sparse_union_table.numColumns() != 3 || sparse_union_table.numRows() != 3) return 154;
  if (sparse_union_table(0, 0).getBits() != 1010 || sparse_union_table(0, 1).getBits() != 1030 ||
      sparse_union_table(0, 2).getBits() != Id::makeUndefined().getBits()) return 155;
  if (sparse_union_table(1, 0).getBits() != 1011 || sparse_union_table(1, 1).getBits() != 1031 ||
      sparse_union_table(1, 2).getBits() != Id::makeUndefined().getBits()) return 156;
  if (sparse_union_table(2, 0).getBits() != 1010 ||
      sparse_union_table(2, 1).getBits() != Id::makeUndefined().getBits() ||
      sparse_union_table(2, 2).getBits() != 1151) return 157;
  if (sparse_union_result.result.sortedBy().size() != 1 || sparse_union_result.result.sortedBy()[0] != 0) return 158;

  state.calls = 0;
  xpod::qlever::BridgePhysicalPlan cartesian_plan;
  xpod::qlever::BridgePhysicalScan cartesian_left;
  cartesian_left.scan.permutation = Permutation::Enum::SPO;
  cartesian_left.scan.pattern.has_predicate = true;
  cartesian_left.scan.pattern.predicate = 20;
  cartesian_left.scan.needed_slots = XPOD_RDF_SLOT_SUBJECT | XPOD_RDF_SLOT_OBJECT;
  cartesian_left.result_width = 2;
  cartesian_plan.scans.push_back(cartesian_left);
  xpod::qlever::BridgePhysicalScan cartesian_right;
  cartesian_right.scan.permutation = Permutation::Enum::SPO;
  cartesian_right.scan.pattern.has_predicate = true;
  cartesian_right.scan.pattern.predicate = 110;
  cartesian_right.scan.needed_slots = XPOD_RDF_SLOT_SUBJECT | XPOD_RDF_SLOT_OBJECT;
  cartesian_right.result_width = 2;
  cartesian_plan.scans.push_back(cartesian_right);
  cartesian_plan.root.kind = xpod::qlever::BridgeOperationKind::CartesianProductJoin;
  xpod::qlever::BridgeOperationPlan cartesian_left_root;
  cartesian_left_root.kind = xpod::qlever::BridgeOperationKind::PermutationScan;
  cartesian_left_root.scan_indexes = {0};
  xpod::qlever::BridgeOperationPlan cartesian_right_root;
  cartesian_right_root.kind = xpod::qlever::BridgeOperationKind::PermutationScan;
  cartesian_right_root.scan_indexes = {1};
  cartesian_plan.root.children = {cartesian_left_root, cartesian_right_root};
  auto cartesian_result = xpod::qlever::executeBridgeOperationPlan(physical, cartesian_plan);
  if (cartesian_result.status != XPOD_RDF_STATUS_OK) return 135;
  if (state.calls != 2) return 136;
  const IdTable& cartesian_table = cartesian_result.result.idTable();
  if (cartesian_table.numColumns() != 4 || cartesian_table.numRows() != 4) return 137;
  if (cartesian_table(0, 0).getBits() != 1010 || cartesian_table(0, 1).getBits() != 1030 ||
      cartesian_table(0, 2).getBits() != 1011 || cartesian_table(0, 3).getBits() != 1111) return 138;
  if (cartesian_table(3, 0).getBits() != 1011 || cartesian_table(3, 1).getBits() != 1031 ||
      cartesian_table(3, 2).getBits() != 1010 || cartesian_table(3, 3).getBits() != 1112) return 139;
  if (!cartesian_result.result.sortedBy().empty()) return 140;

  state.calls = 0;
  xpod::qlever::BridgePhysicalPlan minus_plan;
  xpod::qlever::BridgePhysicalScan minus_left;
  minus_left.scan.permutation = Permutation::Enum::SPO;
  minus_left.scan.pattern.has_predicate = true;
  minus_left.scan.pattern.predicate = 20;
  minus_left.scan.needed_slots = XPOD_RDF_SLOT_SUBJECT | XPOD_RDF_SLOT_OBJECT;
  minus_left.sorted_by = {0};
  minus_left.result_width = 2;
  minus_plan.scans.push_back(minus_left);
  xpod::qlever::BridgePhysicalScan minus_right;
  minus_right.scan.permutation = Permutation::Enum::SPO;
  minus_right.scan.pattern.has_predicate = true;
  minus_right.scan.pattern.predicate = 130;
  minus_right.scan.needed_slots = XPOD_RDF_SLOT_SUBJECT | XPOD_RDF_SLOT_OBJECT;
  minus_right.result_width = 2;
  minus_plan.scans.push_back(minus_right);
  minus_plan.root.kind = xpod::qlever::BridgeOperationKind::Minus;
  minus_plan.root.sorted_by = {0};
  minus_plan.root.matched_columns = {{ {0, 0} }};
  xpod::qlever::BridgeOperationPlan minus_left_root;
  minus_left_root.kind = xpod::qlever::BridgeOperationKind::PermutationScan;
  minus_left_root.scan_indexes = {0};
  xpod::qlever::BridgeOperationPlan minus_right_root;
  minus_right_root.kind = xpod::qlever::BridgeOperationKind::PermutationScan;
  minus_right_root.scan_indexes = {1};
  minus_plan.root.children = {minus_left_root, minus_right_root};
  auto minus_result = xpod::qlever::executeBridgeOperationPlan(physical, minus_plan);
  if (minus_result.status != XPOD_RDF_STATUS_OK) return 141;
  if (state.calls != 2) return 142;
  const IdTable& minus_table = minus_result.result.idTable();
  if (minus_table.numColumns() != 2 || minus_table.numRows() != 1) return 143;
  if (minus_table(0, 0).getBits() != 1011 || minus_table(0, 1).getBits() != 1031) return 144;
  if (minus_result.result.sortedBy().size() != 1 || minus_result.result.sortedBy()[0] != 0) return 145;

  state.calls = 0;
  xpod::qlever::BridgePhysicalPlan optional_plan;
  xpod::qlever::BridgePhysicalScan optional_left;
  optional_left.scan.permutation = Permutation::Enum::SPO;
  optional_left.scan.pattern.has_predicate = true;
  optional_left.scan.pattern.predicate = 20;
  optional_left.scan.needed_slots = XPOD_RDF_SLOT_SUBJECT | XPOD_RDF_SLOT_OBJECT;
  optional_left.sorted_by = {0};
  optional_left.result_width = 2;
  optional_plan.scans.push_back(optional_left);
  xpod::qlever::BridgePhysicalScan optional_right;
  optional_right.scan.permutation = Permutation::Enum::SPO;
  optional_right.scan.pattern.has_predicate = true;
  optional_right.scan.pattern.predicate = 150;
  optional_right.scan.needed_slots = XPOD_RDF_SLOT_SUBJECT | XPOD_RDF_SLOT_OBJECT;
  optional_right.result_width = 2;
  optional_plan.scans.push_back(optional_right);
  optional_plan.root.kind = xpod::qlever::BridgeOperationKind::OptionalJoin;
  optional_plan.root.sorted_by = {0};
  optional_plan.root.matched_columns = {{ {0, 0} }};
  optional_plan.root.right_projection_columns = {1};
  xpod::qlever::BridgeOperationPlan optional_left_root;
  optional_left_root.kind = xpod::qlever::BridgeOperationKind::PermutationScan;
  optional_left_root.scan_indexes = {0};
  xpod::qlever::BridgeOperationPlan optional_right_root;
  optional_right_root.kind = xpod::qlever::BridgeOperationKind::PermutationScan;
  optional_right_root.scan_indexes = {1};
  optional_plan.root.children = {optional_left_root, optional_right_root};
  auto optional_result = xpod::qlever::executeBridgeOperationPlan(physical, optional_plan);
  if (optional_result.status != XPOD_RDF_STATUS_OK) return 146;
  if (state.calls != 2) return 147;
  const IdTable& optional_table = optional_result.result.idTable();
  if (optional_table.numColumns() != 3 || optional_table.numRows() != 2) return 148;
  if (optional_table(0, 0).getBits() != 1010 || optional_table(0, 1).getBits() != 1030 ||
      optional_table(0, 2).getBits() != 1151) return 149;
  if (optional_table(1, 0).getBits() != 1011 || optional_table(1, 1).getBits() != 1031 ||
      optional_table(1, 2).getBits() != Id::makeUndefined().getBits()) return 150;
  if (optional_result.result.sortedBy().size() != 1 || optional_result.result.sortedBy()[0] != 0) return 151;

  state.calls = 0;
  xpod::qlever::BridgePhysicalPlan multi_plan;
  xpod::qlever::BridgePhysicalScan multi_left;
  multi_left.scan.permutation = Permutation::Enum::SPO;
  multi_left.scan.pattern.has_predicate = true;
  multi_left.scan.pattern.predicate = 180;
  multi_left.scan.needed_slots = XPOD_RDF_SLOT_SUBJECT | XPOD_RDF_SLOT_PREDICATE | XPOD_RDF_SLOT_OBJECT;
  multi_left.result_width = 3;
  multi_plan.scans.push_back(multi_left);
  xpod::qlever::BridgePhysicalScan multi_right;
  multi_right.scan.permutation = Permutation::Enum::SPO;
  multi_right.scan.pattern.has_predicate = true;
  multi_right.scan.pattern.predicate = 190;
  multi_right.scan.needed_slots = XPOD_RDF_SLOT_SUBJECT | XPOD_RDF_SLOT_PREDICATE | XPOD_RDF_SLOT_OBJECT;
  multi_right.result_width = 3;
  multi_plan.scans.push_back(multi_right);
  multi_plan.root.kind = xpod::qlever::BridgeOperationKind::MultiColumnJoin;
  multi_plan.root.matched_columns = {{ {0, 0}, {2, 2} }};
  multi_plan.root.right_projection_columns = {1};
  xpod::qlever::BridgeOperationPlan multi_left_root;
  multi_left_root.kind = xpod::qlever::BridgeOperationKind::PermutationScan;
  multi_left_root.scan_indexes = {0};
  xpod::qlever::BridgeOperationPlan multi_right_root;
  multi_right_root.kind = xpod::qlever::BridgeOperationKind::PermutationScan;
  multi_right_root.scan_indexes = {1};
  multi_plan.root.children = {multi_left_root, multi_right_root};
  auto multi_result = xpod::qlever::executeBridgeOperationPlan(physical, multi_plan);
  if (multi_result.status != XPOD_RDF_STATUS_OK) return 164;
  if (state.calls != 2) return 165;
  const IdTable& multi_table = multi_result.result.idTable();
  if (multi_table.numColumns() != 4 || multi_table.numRows() != 2) return 166;
  if (multi_table(0, 0).getBits() != 1010 || multi_table(0, 1).getBits() != 1180 ||
      multi_table(0, 2).getBits() != 1030 || multi_table(0, 3).getBits() != 1190) return 167;
  if (multi_table(1, 0).getBits() != 1010 || multi_table(1, 1).getBits() != 1180 ||
      multi_table(1, 2).getBits() != 1031 || multi_table(1, 3).getBits() != 1190) return 168;

  state.calls = 0;
  xpod::qlever::BridgePhysicalPlan group_plan;
  xpod::qlever::BridgePhysicalScan group_scan;
  group_scan.scan.permutation = Permutation::Enum::SPO;
  group_scan.scan.pattern.has_predicate = true;
  group_scan.scan.pattern.predicate = 170;
  group_scan.scan.needed_slots = XPOD_RDF_SLOT_SUBJECT | XPOD_RDF_SLOT_OBJECT;
  group_scan.result_width = 2;
  group_plan.scans.push_back(group_scan);
  group_plan.root.kind = xpod::qlever::BridgeOperationKind::GroupBy;
  group_plan.root.projection_columns = {1};
  xpod::qlever::BridgeOperationPlan group_child_root;
  group_child_root.kind = xpod::qlever::BridgeOperationKind::PermutationScan;
  group_child_root.scan_indexes = {0};
  group_plan.root.children = {group_child_root};
  auto group_result = xpod::qlever::executeBridgeOperationPlan(physical, group_plan);
  if (group_result.status != XPOD_RDF_STATUS_OK) return 159;
  if (state.calls != 1) return 160;
  const IdTable& group_table = group_result.result.idTable();
  if (group_table.numColumns() != 1 || group_table.numRows() != 2) return 161;
  if (group_table(0, 0).getBits() != 1030) return 162;
  if (group_table(1, 0).getBits() != 1031) return 163;

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
  }, 30_000);
});
