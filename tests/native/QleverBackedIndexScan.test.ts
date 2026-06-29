import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(__dirname, '../..');
const scanHeader = path.join(repoRoot, 'native/postgres/qlever_adapter/src/XpodBackedIndexScan.hpp');

function hasCxx(): boolean {
  try {
    execFileSync('/usr/bin/env', ['c++', '--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

describe('Xpod-backed QLever IndexScan adapter', () => {
  it('executes a scan adapter shell into a QLever IdTable', async () => {
    expect(hasCxx(), 'c++ compiler is required for native backed index scan check').toBe(true);

    const root = await mkdtemp(path.join(os.tmpdir(), 'xpod-backed-index-scan-'));
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

      const smoke = path.join(root, 'backed_index_scan_smoke.cpp');
      const binary = path.join(root, 'backed_index_scan_smoke');
      await writeFile(smoke, `
#include "XpodBackedIndexScan.hpp"

struct ProfileState {
  int calls;
  xpod_rdf_profile_status statuses[2];
  xpod_rdf_profile_node_key nodes[2];
  xpod_rdf_profile_node_key parents[2];
  uint8_t has_parents[2];
  uint64_t output_rows[2];
};

static void on_profile(void* user_data, const xpod_rdf_profile_event* event) {
  ProfileState* state = static_cast<ProfileState*>(user_data);
  int index = state->calls++;
  if (index >= 2) return;
  state->statuses[index] = event->status;
  state->nodes[index] = event->node;
  state->parents[index] = event->parent;
  state->has_parents[index] = event->has_parent;
  state->output_rows[index] = event->output_rows;
}

static xpod_rdf_status encode(void*, xpod_rdf_term_key term, uint64_t* out_bits) {
  *out_bits = term + 1000;
  return XPOD_RDF_STATUS_OK;
}

static xpod_rdf_status estimate_scan(
    void*,
    const xpod_rdf_scan_request* request,
    xpod_rdf_estimate* out_estimate) {
  if (request->permutation != XPOD_RDF_PERM_SPOG) return XPOD_RDF_STATUS_BACKEND_ERROR;
  out_estimate->rows = 42;
  out_estimate->cpu_cost = 5;
  out_estimate->io_cost = 7;
  out_estimate->startup_cost = 3;
  out_estimate->confidence = XPOD_RDF_ESTIMATE_EXACT;
  return XPOD_RDF_STATUS_OK;
}

static xpod_rdf_status scan(
    void*,
    const xpod_rdf_scan_request*,
    xpod_rdf_quad_batch_callback on_batch,
    void* callback_user_data) {
  xpod_rdf_quad_key rows[1] = {
    {10, 20, 30, 40},
  };
  xpod_rdf_quad_batch batch = {};
  batch.rows = rows;
  batch.row_count = 1;
  return on_batch(callback_user_data, &batch);
}

int main() {
  ProfileState profile = {};
  xpod_rdf_backend_v1 backend = {};
  backend.abi_version = XPOD_RDF_PHYSICAL_BACKEND_ABI_VERSION;
  backend.struct_size = sizeof(xpod_rdf_backend_v1);
  backend.on_profile_event = on_profile;
  backend.profile_user_data = &profile;
  backend.encode_qlever_id = encode;
  backend.qlever_term_ordering = XPOD_RDF_QLEVER_TERM_ORDER_PRESERVED;
  backend.estimate_scan = estimate_scan;
  backend.scan_permutation = scan;
  xpod::rdf::PhysicalBackend physical(&backend);

  xpod::qlever::ScanRequestInput input = {};
  input.permutation = Permutation::Enum::SPO;

  xpod::qlever::XpodBackedIndexScan scanAdapter(physical, input, {0}, 3, "xpod scan ?s ?p ?o", 77, 55);
  if (scanAdapter.getResultWidth() != 3) return 10;
  if (scanAdapter.getDescriptor() != "xpod scan ?s ?p ?o") return 11;
  if (scanAdapter.resultSortedOn().size() != 1 || scanAdapter.resultSortedOn()[0] != 0) return 12;
  auto estimate = scanAdapter.estimate();
  if (estimate.status != XPOD_RDF_STATUS_OK) return 16;
  if (estimate.estimate.rows != 42) return 17;
  if (scanAdapter.getSizeEstimate() != 42) return 18;
  if (scanAdapter.getCostEstimate() != 15) return 19;
  if (scanAdapter.knownEmptyResult()) return 20;

  auto result = scanAdapter.execute();
  if (result.status != XPOD_RDF_STATUS_OK) return 1;
  if (result.table.numColumns() != 3 || result.table.numRows() != 1) return 2;
  if (result.table(0, 0).getBits() != 1010) return 3;
  if (result.table(0, 1).getBits() != 1020) return 4;
  if (result.table(0, 2).getBits() != 1030) return 5;

  auto qleverResult = scanAdapter.executeResult({0});
  if (qleverResult.status != XPOD_RDF_STATUS_OK) return 6;
  if (qleverResult.result.idTable().numRows() != 1) return 7;
  if (qleverResult.result.idTable()(0, 2).getBits() != 1030) return 8;
  if (qleverResult.result.sortedBy().size() != 1 || qleverResult.result.sortedBy()[0] != 0) return 9;

  auto operationResult = scanAdapter.computeResult(false);
  if (operationResult.status != XPOD_RDF_STATUS_OK) return 13;
  if (operationResult.result.idTable().numRows() != 1) return 14;
  if (operationResult.result.sortedBy().size() != 1 || operationResult.result.sortedBy()[0] != 0) return 15;
  if (profile.calls != 2) return 21;
  if (profile.statuses[0] != XPOD_RDF_PROFILE_RUNNING) return 22;
  if (profile.statuses[1] != XPOD_RDF_PROFILE_COMPLETED) return 23;
  if (profile.nodes[0] != 77 || profile.nodes[1] != 77) return 24;
  if (!profile.has_parents[0] || profile.parents[0] != 55) return 25;
  if (profile.output_rows[1] != 1) return 26;
  return 0;
}
`, 'utf8');

      execFileSync('c++', [
        '-std=c++17',
        '-Wall',
        '-Wextra',
        '-Werror',
        '-DXPOD_QLEVER_ADAPTER_ENABLE_QLEVER=1',
        '-I', path.dirname(scanHeader),
        '-I', path.join(repoRoot, 'native/postgres/rdf_protocol/include'),
        '-I', path.join(qleverSource, 'src'),
        smoke,
        '-o',
        binary,
      ], { stdio: 'pipe' });
      execFileSync(binary, [], { stdio: 'pipe' });

      const opaqueOrderSmoke = path.join(root, 'backed_index_scan_opaque_order_smoke.cpp');
      const opaqueOrderBinary = path.join(root, 'backed_index_scan_opaque_order_smoke');
      await writeFile(opaqueOrderSmoke, `
#include "XpodBackedIndexScan.hpp"

static xpod_rdf_status encode(void*, xpod_rdf_term_key term, uint64_t* out_bits) {
  *out_bits = 1000 - term;
  return XPOD_RDF_STATUS_OK;
}

static xpod_rdf_status estimate_scan(
    void*,
    const xpod_rdf_scan_request*,
    xpod_rdf_estimate* out_estimate) {
  out_estimate->rows = 2;
  out_estimate->confidence = XPOD_RDF_ESTIMATE_EXACT;
  return XPOD_RDF_STATUS_OK;
}

static xpod_rdf_status scan(
    void*,
    const xpod_rdf_scan_request*,
    xpod_rdf_quad_batch_callback on_batch,
    void* callback_user_data) {
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
  xpod_rdf_backend_v1 backend = {};
  backend.abi_version = XPOD_RDF_PHYSICAL_BACKEND_ABI_VERSION;
  backend.struct_size = sizeof(xpod_rdf_backend_v1);
  backend.encode_qlever_id = encode;
  backend.estimate_scan = estimate_scan;
  backend.scan_permutation = scan;
  xpod::rdf::PhysicalBackend physical(&backend);

  xpod::qlever::ScanRequestInput input = {};
  input.permutation = Permutation::Enum::SPO;

  xpod::qlever::XpodBackedIndexScan scanAdapter(physical, input, {0}, 3, "opaque-order scan");
  if (!scanAdapter.resultSortedOn().empty()) return 1;
  auto result = scanAdapter.executeResult();
  if (result.status != XPOD_RDF_STATUS_OK) return 2;
  if (!result.result.sortedBy().empty()) return 3;
  auto explicitSorted = scanAdapter.executeResult({0});
  if (explicitSorted.status != XPOD_RDF_STATUS_OK) return 4;
  if (!explicitSorted.result.sortedBy().empty()) return 5;
  if (result.result.idTable().numRows() != 2) return 6;
  return 0;
}
`, 'utf8');

      execFileSync('c++', [
        '-std=c++17',
        '-Wall',
        '-Wextra',
        '-Werror',
        '-DXPOD_QLEVER_ADAPTER_ENABLE_QLEVER=1',
        '-I', path.dirname(scanHeader),
        '-I', path.join(repoRoot, 'native/postgres/rdf_protocol/include'),
        '-I', path.join(qleverSource, 'src'),
        opaqueOrderSmoke,
        '-o',
        opaqueOrderBinary,
      ], { stdio: 'pipe' });
      execFileSync(opaqueOrderBinary, [], { stdio: 'pipe' });

      const unsupportedCapabilitySmoke = path.join(root, 'backed_index_scan_capability_smoke.cpp');
      const unsupportedCapabilityBinary = path.join(root, 'backed_index_scan_capability_smoke');
      await writeFile(unsupportedCapabilitySmoke, `
#include "XpodBackedIndexScan.hpp"

struct CallState {
  int estimate_calls;
  int scan_calls;
};

static xpod_rdf_status get_capabilities(
    void*,
    xpod_rdf_backend_capabilities* out_capabilities) {
  out_capabilities->supported_permutations = XPOD_RDF_PERM_CAP_POSG;
  return XPOD_RDF_STATUS_OK;
}

static xpod_rdf_status estimate_scan(
    void* user_data,
    const xpod_rdf_scan_request*,
    xpod_rdf_estimate* out_estimate) {
  auto* state = static_cast<CallState*>(user_data);
  ++state->estimate_calls;
  out_estimate->rows = 1;
  out_estimate->confidence = XPOD_RDF_ESTIMATE_EXACT;
  return XPOD_RDF_STATUS_OK;
}

static xpod_rdf_status scan(
    void* user_data,
    const xpod_rdf_scan_request*,
    xpod_rdf_quad_batch_callback,
    void*) {
  auto* state = static_cast<CallState*>(user_data);
  ++state->scan_calls;
  return XPOD_RDF_STATUS_OK;
}

int main() {
  CallState calls = {};
  xpod_rdf_backend_v1 backend = {};
  backend.abi_version = XPOD_RDF_PHYSICAL_BACKEND_ABI_VERSION;
  backend.struct_size = sizeof(xpod_rdf_backend_v1);
  backend.backend_user_data = &calls;
  backend.get_capabilities = get_capabilities;
  backend.estimate_scan = estimate_scan;
  backend.scan_permutation = scan;
  xpod::rdf::PhysicalBackend physical(&backend);

  xpod::qlever::ScanRequestInput input = {};
  input.permutation = Permutation::Enum::SPO;

  xpod::qlever::XpodBackedIndexScan scanAdapter(physical, input, {0}, 3, "unsupported capability scan");
  if (scanAdapter.estimate().status != XPOD_RDF_STATUS_UNSUPPORTED) return 1;
  if (scanAdapter.execute().status != XPOD_RDF_STATUS_UNSUPPORTED) return 2;
  if (calls.estimate_calls != 0 || calls.scan_calls != 0) return 3;
  return 0;
}
`, 'utf8');

      execFileSync('c++', [
        '-std=c++17',
        '-Wall',
        '-Wextra',
        '-Werror',
        '-DXPOD_QLEVER_ADAPTER_ENABLE_QLEVER=1',
        '-I', path.dirname(scanHeader),
        '-I', path.join(repoRoot, 'native/postgres/rdf_protocol/include'),
        '-I', path.join(qleverSource, 'src'),
        unsupportedCapabilitySmoke,
        '-o',
        unsupportedCapabilityBinary,
      ], { stdio: 'pipe' });
      execFileSync(unsupportedCapabilityBinary, [], { stdio: 'pipe' });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
