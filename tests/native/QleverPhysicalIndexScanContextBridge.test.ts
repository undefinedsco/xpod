import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(__dirname, '../..');
const bridgeHeader = path.join(repoRoot, 'native/postgres/qlever_adapter/src/XpodQleverPhysicalIndexScanContextBridge.hpp');

function hasCxx(): boolean {
  try {
    execFileSync('/usr/bin/env', ['c++', '--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

async function writeMinimalQleverHeaders(root: string): Promise<string> {
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
  bool empty() const { return rows_.empty(); }
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
  await writeFile(path.join(qleverSource, 'src/index/CompressedRelation.h'), `
#pragma once
#include <memory>
#include <optional>
#include "engine/idTable/IdTable.h"

namespace ad_utility {
template <typename T, typename Details>
class InputRangeFromGet {
 public:
  virtual ~InputRangeFromGet() = default;
  virtual std::optional<T> get() = 0;
  Details& details() { return details_; }
 private:
  Details details_;
};

template <typename T, typename Details>
class InputRangeTypeErased {
 public:
  InputRangeTypeErased() = default;
  explicit InputRangeTypeErased(std::unique_ptr<InputRangeFromGet<T, Details>> impl)
      : impl_(std::move(impl)) {}
  std::optional<T> get() {
    if (!impl_) return std::nullopt;
    return impl_->get();
  }
  Details& details() { return impl_->details(); }
  bool has_value() const { return impl_ != nullptr; }
 private:
  std::unique_ptr<InputRangeFromGet<T, Details>> impl_;
};
}

class CompressedRelationReader {
 public:
  struct CompressedBlockMetadata {
    struct PermutedTriple {
      Id col0Id_;
      Id col1Id_;
      Id col2Id_;
      Id graphId_;
    };
    size_t blockIndex_ = 0;
    size_t numRows_ = 0;
    PermutedTriple firstTriple_;
    PermutedTriple lastTriple_;
  };
  struct ScanSpecification {
    std::optional<Id> col0;
    std::optional<Id> col1;
    std::optional<Id> col2;
    std::optional<Id> col0Id() const { return col0; }
    std::optional<Id> col1Id() const { return col1; }
    std::optional<Id> col2Id() const { return col2; }
  };
  struct ScanSpecAndBlocks {
    ScanSpecification scanSpec_;
    std::vector<CompressedBlockMetadata> blockMetadata_;
    const std::vector<CompressedBlockMetadata>& getBlockMetadataView() const {
      return blockMetadata_;
    }
  };
  struct LazyScanMetadata {
    size_t numBlocksRead_ = 0;
    size_t numBlocksAll_ = 0;
    size_t numElementsRead_ = 0;
    size_t numElementsYielded_ = 0;
  };
  using IdTableGeneratorInputRange =
      ad_utility::InputRangeTypeErased<IdTable, LazyScanMetadata>;
};
`, 'utf8');
  return qleverSource;
}

describe('QLever physical index scan context bridge', () => {
  it('lets an upstream-shaped context lazy-scan through the injected physical index', async () => {
    expect(hasCxx(), 'c++ compiler is required for native physical index context bridge check').toBe(true);

    const root = await mkdtemp(path.join(os.tmpdir(), 'xpod-qlever-context-lazy-scan-'));
    try {
      const qleverSource = await writeMinimalQleverHeaders(root);
      const smoke = path.join(root, 'context_lazy_scan_smoke.cpp');
      const binary = path.join(root, 'context_lazy_scan_smoke');
      await writeFile(smoke, `
#include "XpodQleverPhysicalIndexScanContextBridge.hpp"

#include <optional>

struct ScanSpec {
  std::optional<Id> col0Id() const { return std::nullopt; }
  std::optional<Id> col1Id() const { return Id::fromBits(20); }
  std::optional<Id> col2Id() const { return std::nullopt; }
};

class QueryExecutionContext {
 public:
  void setXpodPhysicalIndex(const xpod::qlever::XpodQleverPhysicalIndex& index) {
    index_.emplace(index);
  }
  const xpod::qlever::XpodQleverPhysicalIndex* xpodPhysicalIndex() const {
    return index_.has_value() ? &*index_ : nullptr;
  }
 private:
  std::optional<xpod::qlever::XpodQleverPhysicalIndex> index_;
};

struct BackendState {
  int scan_calls;
  uint64_t last_block_id;
  uint32_t last_needed_slots;
  bool saw_predicate;
};

static xpod_rdf_status get_capabilities(
    void*,
    xpod_rdf_backend_capabilities* out_capabilities) {
  out_capabilities->supported_permutations = XPOD_RDF_PERM_CAP_SPOG;
  out_capabilities->features = XPOD_RDF_BACKEND_FEATURE_BLOCK_RESTRICTED_SCAN;
  return XPOD_RDF_STATUS_OK;
}

static xpod_rdf_status scan_permutation(
    void* user_data,
    const xpod_rdf_scan_request* request,
    xpod_rdf_quad_batch_callback on_batch,
    void* callback_user_data) {
  auto* state = static_cast<BackendState*>(user_data);
  ++state->scan_calls;
  state->last_needed_slots = request->needed_slots;
  if (request->permutation != XPOD_RDF_PERM_SPOG) return XPOD_RDF_STATUS_BACKEND_ERROR;
  if (request->needed_slots != (XPOD_RDF_SLOT_SUBJECT | XPOD_RDF_SLOT_OBJECT)) return XPOD_RDF_STATUS_BACKEND_ERROR;
  if (!request->pattern.has_predicate || request->pattern.predicate != 20) return XPOD_RDF_STATUS_BACKEND_ERROR;
  if (request->block_metadata_count != 1) return XPOD_RDF_STATUS_BACKEND_ERROR;
  state->saw_predicate = true;
  state->last_block_id = request->block_metadata[0].block_id;
  if (state->last_block_id != 9001) return XPOD_RDF_STATUS_BACKEND_ERROR;

  xpod_rdf_quad_key rows[1] = {{101, 20, 303, 404}};
  xpod_rdf_quad_batch batch = {};
  batch.rows = rows;
  batch.row_count = 1;
  return on_batch(callback_user_data, &batch);
}

int main() {
  BackendState state = {};
  xpod_rdf_backend_v1 raw_backend = {};
  raw_backend.abi_version = XPOD_RDF_PHYSICAL_BACKEND_ABI_VERSION;
  raw_backend.struct_size = sizeof(xpod_rdf_backend_v1);
  raw_backend.backend_user_data = &state;
  raw_backend.get_capabilities = get_capabilities;
  raw_backend.scan_permutation = scan_permutation;
  raw_backend.term_key_encoding = XPOD_RDF_TERM_KEY_ENCODING_QLEVER_VALUE_ID_BITS;
  xpod::rdf::PhysicalBackend physical(&raw_backend);

  xpod_qlever_query_request request = {};
  xpod::qlever::PlannerRequestContext planner_context{physical, &request, request.cancellation};
  planner_context.capabilities_status = physical.getCapabilities(planner_context.capabilities);

  QueryExecutionContext qec;
  xpod::qlever::XpodQleverPhysicalIndex index(planner_context);
  qec.setXpodPhysicalIndex(index);

  xpod_rdf_scan_block_metadata block = {};
  block.block_id = 9001;
  ScanSpec spec;
  auto result = xpod::qlever::lazyScanRangeFromContext(
      qec,
      Permutation::Enum::SPO,
      spec,
      std::vector<xpod_rdf_scan_block_metadata>{block},
      XPOD_RDF_SLOT_SUBJECT | XPOD_RDF_SLOT_OBJECT);

  if (result.status != XPOD_RDF_STATUS_OK) return 1;
  auto table = result.blocks.get();
  if (!table.has_value()) return 2;
  if (table->numColumns() != 2 || table->numRows() != 1) return 3;
  if ((*table)(0, 0).getBits() != 101 || (*table)(0, 1).getBits() != 303) return 4;
  if (result.blocks.get().has_value()) return 5;
  if (state.scan_calls != 1) return 6;
  if (!state.saw_predicate || state.last_needed_slots != (XPOD_RDF_SLOT_SUBJECT | XPOD_RDF_SLOT_OBJECT)) return 7;
  return 0;
}
`, 'utf8');

      execFileSync('c++', [
        '-std=c++17',
        '-Wall',
        '-Wextra',
        '-Werror',
        '-DXPOD_QLEVER_ADAPTER_ENABLE_QLEVER=1',
        '-I', path.dirname(bridgeHeader),
        '-I', path.join(repoRoot, 'native/postgres/rdf_protocol/include'),
        '-I', path.join(repoRoot, 'native/postgres/qlever_adapter/include'),
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

  it('lets unprefiltered getLazyScan(nullopt) use a broad physical lazy scan when QLever has no block metadata', async () => {
    expect(hasCxx(), 'c++ compiler is required for native physical index context bridge check').toBe(true);

    const root = await mkdtemp(path.join(os.tmpdir(), 'xpod-qlever-context-broad-lazy-scan-'));
    try {
      const qleverSource = await writeMinimalQleverHeaders(root);
      const smoke = path.join(root, 'context_broad_lazy_scan_smoke.cpp');
      const binary = path.join(root, 'context_broad_lazy_scan_smoke');
      await writeFile(smoke, `
#include "XpodQleverPhysicalIndexScanContextBridge.hpp"

#include <optional>

using CompressedBlockMetadata = CompressedRelationReader::CompressedBlockMetadata;

class QueryExecutionContext {
 public:
  void setXpodPhysicalIndex(const xpod::qlever::XpodQleverPhysicalIndex& index) {
    index_.emplace(index);
  }
  const xpod::qlever::XpodQleverPhysicalIndex* xpodPhysicalIndex() const {
    return index_.has_value() ? &*index_ : nullptr;
  }
 private:
  std::optional<xpod::qlever::XpodQleverPhysicalIndex> index_;
};

struct BackendState {
  int scan_calls;
  bool saw_unrestricted_scan;
};

static xpod_rdf_status get_capabilities(
    void*,
    xpod_rdf_backend_capabilities* out_capabilities) {
  out_capabilities->supported_permutations = XPOD_RDF_PERM_CAP_SPOG;
  out_capabilities->features = 0;
  return XPOD_RDF_STATUS_OK;
}

static xpod_rdf_status scan_permutation(
    void* user_data,
    const xpod_rdf_scan_request* request,
    xpod_rdf_quad_batch_callback on_batch,
    void* callback_user_data) {
  auto* state = static_cast<BackendState*>(user_data);
  ++state->scan_calls;
  if (request->permutation != XPOD_RDF_PERM_SPOG) return XPOD_RDF_STATUS_BACKEND_ERROR;
  if (request->needed_slots != (XPOD_RDF_SLOT_SUBJECT | XPOD_RDF_SLOT_OBJECT)) return XPOD_RDF_STATUS_BACKEND_ERROR;
  if (!request->pattern.has_predicate || request->pattern.predicate != 20) return XPOD_RDF_STATUS_BACKEND_ERROR;
  if (request->block_metadata_count != 0) return XPOD_RDF_STATUS_BACKEND_ERROR;
  state->saw_unrestricted_scan = true;

  xpod_rdf_quad_key rows[1] = {{101, 20, 303, 404}};
  xpod_rdf_quad_batch batch = {};
  batch.rows = rows;
  batch.row_count = 1;
  return on_batch(callback_user_data, &batch);
}

int main() {
  BackendState state = {};
  xpod_rdf_backend_v1 raw_backend = {};
  raw_backend.abi_version = XPOD_RDF_PHYSICAL_BACKEND_ABI_VERSION;
  raw_backend.struct_size = sizeof(xpod_rdf_backend_v1);
  raw_backend.backend_user_data = &state;
  raw_backend.get_capabilities = get_capabilities;
  raw_backend.scan_permutation = scan_permutation;
  raw_backend.term_key_encoding = XPOD_RDF_TERM_KEY_ENCODING_QLEVER_VALUE_ID_BITS;
  xpod::rdf::PhysicalBackend physical(&raw_backend);

  xpod_qlever_query_request request = {};
  xpod::qlever::PlannerRequestContext planner_context{physical, &request, request.cancellation};
  planner_context.capabilities_status = physical.getCapabilities(planner_context.capabilities);

  QueryExecutionContext qec;
  qec.setXpodPhysicalIndex(xpod::qlever::XpodQleverPhysicalIndex(planner_context));

  CompressedRelationReader::ScanSpecAndBlocks scan_spec_and_blocks = {};
  scan_spec_and_blocks.scanSpec_.col1 = Id::fromBits(20);
  std::optional<std::vector<CompressedBlockMetadata>> no_qlever_blocks =
      std::nullopt;

  auto broad = xpod::qlever::lazyScanRangeFromQleverScanSpecAndBlocks(
      qec,
      Permutation::Enum::SPO,
      scan_spec_and_blocks,
      no_qlever_blocks,
      XPOD_RDF_SLOT_SUBJECT | XPOD_RDF_SLOT_OBJECT,
      xpod_rdf_bytes{},
      true);
  if (broad.status != XPOD_RDF_STATUS_OK) return 1;
  auto table = broad.blocks.get();
  if (!table.has_value()) return 2;
  if (table->numColumns() != 2 || table->numRows() != 1) return 3;
  if ((*table)(0, 0).getBits() != 101 || (*table)(0, 1).getBits() != 303) return 4;
  if (broad.blocks.get().has_value()) return 5;
  if (state.scan_calls != 1 || !state.saw_unrestricted_scan) return 6;
  std::optional<std::vector<CompressedBlockMetadata>> selected_empty_blocks =
      std::vector<CompressedBlockMetadata>{};

  auto selected_empty = xpod::qlever::lazyScanRangeFromQleverScanSpecAndBlocks(
      qec,
      Permutation::Enum::SPO,
      scan_spec_and_blocks,
      selected_empty_blocks,
      XPOD_RDF_SLOT_SUBJECT | XPOD_RDF_SLOT_OBJECT,
      xpod_rdf_bytes{},
      true);
  if (selected_empty.status != XPOD_RDF_STATUS_OK) return 7;
  if (selected_empty.blocks.get().has_value()) return 8;
  if (state.scan_calls != 1) return 9;

  return 0;
}
`, 'utf8');

      execFileSync('c++', [
        '-std=c++17',
        '-Wall',
        '-Wextra',
        '-Werror',
        '-DXPOD_QLEVER_ADAPTER_ENABLE_QLEVER=1',
        '-I', path.dirname(bridgeHeader),
        '-I', path.join(repoRoot, 'native/postgres/rdf_protocol/include'),
        '-I', path.join(repoRoot, 'native/postgres/qlever_adapter/include'),
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

  it('gives an upstream IndexScan getLazyScan patch a direct physical-index path', async () => {
    expect(hasCxx(), 'c++ compiler is required for native physical index context bridge check').toBe(true);

    const root = await mkdtemp(path.join(os.tmpdir(), 'xpod-qlever-indexscan-lazy-scan-'));
    try {
      const qleverSource = await writeMinimalQleverHeaders(root);
      const smoke = path.join(root, 'indexscan_lazy_scan_smoke.cpp');
      const binary = path.join(root, 'indexscan_lazy_scan_smoke');
      await writeFile(smoke, `
#include "XpodQleverPhysicalIndexScanContextBridge.hpp"

#include <optional>

using CompressedBlockMetadata = CompressedRelationReader::CompressedBlockMetadata;

class QueryExecutionContext {
 public:
  void setXpodPhysicalIndex(const xpod::qlever::XpodQleverPhysicalIndex& index) {
    index_.emplace(index);
  }
  const xpod::qlever::XpodQleverPhysicalIndex* xpodPhysicalIndex() const {
    return index_.has_value() ? &*index_ : nullptr;
  }
 private:
  std::optional<xpod::qlever::XpodQleverPhysicalIndex> index_;
};

class IndexScan {
 public:
  using ScanSpecAndBlocks = CompressedRelationReader::ScanSpecAndBlocks;

  IndexScan(
      QueryExecutionContext& qec,
      Permutation::Enum permutation,
      ScanSpecAndBlocks scan_spec_and_blocks)
      : qec_(qec),
        permutation_(permutation),
        scan_spec_and_blocks_(scan_spec_and_blocks) {}

  CompressedRelationReader::IdTableGeneratorInputRange getLazyScan(
      std::optional<std::vector<CompressedBlockMetadata>> blocks) const {
    auto result = xpod::qlever::lazyScanRangeFromQleverScanSpecAndBlocks(
        qec_,
        permutation_,
        scan_spec_and_blocks_,
        std::move(blocks),
        XPOD_RDF_SLOT_SUBJECT | XPOD_RDF_SLOT_OBJECT);
    return std::move(result.blocks);
  }

 private:
  QueryExecutionContext& qec_;
  Permutation::Enum permutation_;
  ScanSpecAndBlocks scan_spec_and_blocks_;
};

struct BackendState {
  int scan_calls;
  uint64_t last_block_id;
  uint64_t last_first_subject;
  uint64_t last_last_object;
};

static xpod_rdf_status get_capabilities(
    void*,
    xpod_rdf_backend_capabilities* out_capabilities) {
  out_capabilities->supported_permutations = XPOD_RDF_PERM_CAP_SPOG;
  out_capabilities->features = XPOD_RDF_BACKEND_FEATURE_BLOCK_RESTRICTED_SCAN;
  return XPOD_RDF_STATUS_OK;
}

static xpod_rdf_status scan_permutation(
    void* user_data,
    const xpod_rdf_scan_request* request,
    xpod_rdf_quad_batch_callback on_batch,
    void* callback_user_data) {
  auto* state = static_cast<BackendState*>(user_data);
  ++state->scan_calls;
  if (request->permutation != XPOD_RDF_PERM_SPOG) return XPOD_RDF_STATUS_BACKEND_ERROR;
  if (!request->pattern.has_predicate || request->pattern.predicate != 20) return XPOD_RDF_STATUS_BACKEND_ERROR;
  if (request->needed_slots != (XPOD_RDF_SLOT_SUBJECT | XPOD_RDF_SLOT_OBJECT)) return XPOD_RDF_STATUS_BACKEND_ERROR;
  if (request->block_metadata_count != 1) return XPOD_RDF_STATUS_BACKEND_ERROR;
  state->last_block_id = request->block_metadata[0].block_id;
  state->last_first_subject = request->block_metadata[0].first_quad.subject;
  state->last_last_object = request->block_metadata[0].last_quad.object;
  if (state->last_block_id != 7) return XPOD_RDF_STATUS_BACKEND_ERROR;
  if (state->last_first_subject != 101 || state->last_last_object != 303) return XPOD_RDF_STATUS_BACKEND_ERROR;

  xpod_rdf_quad_key rows[1] = {{101, 20, 303, 404}};
  xpod_rdf_quad_batch batch = {};
  batch.rows = rows;
  batch.row_count = 1;
  return on_batch(callback_user_data, &batch);
}

int main() {
  BackendState state = {};
  xpod_rdf_backend_v1 raw_backend = {};
  raw_backend.abi_version = XPOD_RDF_PHYSICAL_BACKEND_ABI_VERSION;
  raw_backend.struct_size = sizeof(xpod_rdf_backend_v1);
  raw_backend.backend_user_data = &state;
  raw_backend.get_capabilities = get_capabilities;
  raw_backend.scan_permutation = scan_permutation;
  raw_backend.term_key_encoding = XPOD_RDF_TERM_KEY_ENCODING_QLEVER_VALUE_ID_BITS;
  xpod::rdf::PhysicalBackend physical(&raw_backend);

  xpod_qlever_query_request request = {};
  xpod::qlever::PlannerRequestContext planner_context{physical, &request, request.cancellation};
  planner_context.capabilities_status = physical.getCapabilities(planner_context.capabilities);

  QueryExecutionContext qec;
  qec.setXpodPhysicalIndex(xpod::qlever::XpodQleverPhysicalIndex(planner_context));

  CompressedRelationReader::ScanSpecAndBlocks scan_spec_and_blocks = {};
  scan_spec_and_blocks.scanSpec_.col1 = Id::fromBits(20);

  CompressedBlockMetadata::PermutedTriple triple = {
      Id::fromBits(101),
      Id::fromBits(20),
      Id::fromBits(303),
      Id::fromBits(404)};
  CompressedBlockMetadata block = {7, 1, triple, triple};
  scan_spec_and_blocks.blockMetadata_ = {block};

  IndexScan scan(qec, Permutation::Enum::SPO, scan_spec_and_blocks);
  auto range = scan.getLazyScan(std::vector<CompressedBlockMetadata>{block});

  auto table = range.get();
  if (!table.has_value()) return 1;
  if (table->numColumns() != 2 || table->numRows() != 1) return 2;
  if ((*table)(0, 0).getBits() != 101 || (*table)(0, 1).getBits() != 303) return 3;
  if (range.get().has_value()) return 4;
  if (state.scan_calls != 1) return 5;

  auto all_block_range = scan.getLazyScan(std::nullopt);
  auto all_block_table = all_block_range.get();
  if (!all_block_table.has_value()) return 6;
  if (all_block_table->numColumns() != 2 || all_block_table->numRows() != 1) return 7;
  if ((*all_block_table)(0, 0).getBits() != 101 ||
      (*all_block_table)(0, 1).getBits() != 303) return 8;
  if (all_block_range.get().has_value()) return 9;
  if (state.scan_calls != 2) return 10;
  return 0;
}
`, 'utf8');

      execFileSync('c++', [
        '-std=c++17',
        '-Wall',
        '-Wextra',
        '-Werror',
        '-DXPOD_QLEVER_ADAPTER_ENABLE_QLEVER=1',
        '-I', path.dirname(bridgeHeader),
        '-I', path.join(repoRoot, 'native/postgres/rdf_protocol/include'),
        '-I', path.join(repoRoot, 'native/postgres/qlever_adapter/include'),
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
