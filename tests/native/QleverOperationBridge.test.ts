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
