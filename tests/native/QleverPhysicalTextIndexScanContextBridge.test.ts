import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(__dirname, '../..');
const bridgeHeader = path.join(repoRoot, 'native/postgres/qlever_adapter/src/XpodQleverPhysicalTextIndexScanContextBridge.hpp');

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
  await mkdir(path.join(qleverSource, 'src/engine/idTable'), { recursive: true });
  await mkdir(path.join(qleverSource, 'src/engine'), { recursive: true });
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
#include <vector>
#include "engine/idTable/IdTable.h"
#include "global/Id.h"

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
 private:
  std::unique_ptr<InputRangeFromGet<T, Details>> impl_;
};
}

class CompressedRelationReader {
 public:
  struct ScanSpecification {
    std::optional<Id> col0Id() const { return std::nullopt; }
    std::optional<Id> col1Id() const { return std::nullopt; }
    std::optional<Id> col2Id() const { return std::nullopt; }
  };
  struct CompressedBlockMetadata {
    struct PermutedTriple {
      Id col0Id_ = Id::fromBits(0);
      Id col1Id_ = Id::fromBits(0);
      Id col2Id_ = Id::fromBits(0);
      Id graphId_ = Id::fromBits(0);
    };
    size_t blockIndex_ = 0;
    size_t numRows_ = 0;
    PermutedTriple firstTriple_;
    PermutedTriple lastTriple_;
  };
  struct ScanSpecAndBlocks { ScanSpecification scanSpec_; };
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

describe('QLever physical text index scan context bridge', () => {
  it('materializes non-prefix TextIndexScanForWord from the injected physical text source', async () => {
    expect(hasCxx(), 'c++ compiler is required for native text context bridge check').toBe(true);

    const root = await mkdtemp(path.join(os.tmpdir(), 'xpod-qlever-text-context-'));
    try {
      const qleverSource = await writeMinimalQleverHeaders(root);
      const smoke = path.join(root, 'text_word_context_smoke.cpp');
      const binary = path.join(root, 'text_word_context_smoke');
      await writeFile(smoke, `
#include "XpodQleverPhysicalTextIndexScanContextBridge.hpp"

#include <cstring>
#include <optional>

struct QueryExecutionContext {
  void setXpodPhysicalIndex(const xpod::qlever::XpodQleverPhysicalIndex& index) {
    index_.emplace(index);
  }
  const xpod::qlever::XpodQleverPhysicalIndex* xpodPhysicalIndex() const {
    return index_.has_value() ? &*index_ : nullptr;
  }
 private:
  std::optional<xpod::qlever::XpodQleverPhysicalIndex> index_;
};

static int text_search_calls = 0;

static xpod_rdf_status get_capabilities(
    void*,
    xpod_rdf_backend_capabilities* out_capabilities) {
  out_capabilities->features = XPOD_RDF_BACKEND_FEATURE_TEXT_SEARCH;
  return XPOD_RDF_STATUS_OK;
}

static xpod_rdf_status encode_qlever_id(
    void*,
    xpod_rdf_term_key term,
    uint64_t* out_qlever_id_bits) {
  *out_qlever_id_bits = term + 1000;
  return XPOD_RDF_STATUS_OK;
}

static xpod_rdf_status estimate_text_search(
    void*,
    const xpod_rdf_text_search_request* request,
    xpod_rdf_estimate* out_estimate) {
  if (request->query.size != 7 || std::memcmp(request->query.data, "runtime", 7) != 0) {
    return XPOD_RDF_STATUS_BACKEND_ERROR;
  }
  out_estimate->rows = 2;
  out_estimate->startup_cost = 3;
  out_estimate->cpu_cost = 4;
  out_estimate->io_cost = 5;
  out_estimate->confidence = XPOD_RDF_ESTIMATE_EXACT;
  return XPOD_RDF_STATUS_OK;
}

static xpod_rdf_status text_search(
    void*,
    const xpod_rdf_text_search_request* request,
    xpod_rdf_candidate_batch_callback on_batch,
    void* callback_user_data) {
  ++text_search_calls;
  if (request->query.size != 7 || std::memcmp(request->query.data, "runtime", 7) != 0) {
    return XPOD_RDF_STATUS_BACKEND_ERROR;
  }
  xpod_rdf_candidate rows[2] = {};
  rows[0].retrieval_point = 41;
  rows[0].has_retrieval_point = 1;
  rows[1].retrieval_point = 42;
  rows[1].has_retrieval_point = 1;
  xpod_rdf_candidate_batch batch = {};
  batch.rows = rows;
  batch.row_count = 2;
  batch.scanned_rows = 9;
  return on_batch(callback_user_data, &batch);
}

static xpod::qlever::XpodQleverPhysicalIndex make_index(
    xpod::rdf::PhysicalBackend physical,
    xpod_qlever_query_request& request) {
  xpod::qlever::PlannerRequestContext planner_context{
      physical,
      &request,
      request.cancellation};
  planner_context.capabilities_status =
      physical.getCapabilities(planner_context.capabilities);
  return xpod::qlever::XpodQleverPhysicalIndex(planner_context);
}

int main() {
  xpod_rdf_backend_v1 raw_backend = {};
  raw_backend.abi_version = XPOD_RDF_PHYSICAL_BACKEND_ABI_VERSION;
  raw_backend.struct_size = sizeof(xpod_rdf_backend_v1);
  raw_backend.get_capabilities = get_capabilities;
  raw_backend.encode_qlever_id = encode_qlever_id;
  raw_backend.estimate_text_search = estimate_text_search;
  raw_backend.text_search = text_search;
  raw_backend.term_key_encoding = XPOD_RDF_TERM_KEY_ENCODING_QLEVER_VALUE_ID_BITS;
  xpod::rdf::PhysicalBackend physical(&raw_backend);

  xpod_qlever_query_request request = {};
  QueryExecutionContext qec;
  qec.setXpodPhysicalIndex(make_index(physical, request));

  auto estimate = xpod::qlever::textWordSizeEstimateFromContext(
      qec, "runtime", false, false);
  if (estimate.status != XPOD_RDF_STATUS_OK) return 12;
  if (estimate.rows != 2 || estimate.cost != 12) return 13;
  if (!estimate.exact) return 14;

  auto result = xpod::qlever::textWordResultFromContext(
      qec, "runtime", false, false, {ColumnIndex{0}});
  if (result.status != XPOD_RDF_STATUS_OK) return 1;
  if (result.result.idTable().numColumns() != 1) return 2;
  if (result.result.idTable().numRows() != 2) return 3;
  if (result.result.idTable()(0, 0).getBits() != 1041) return 4;
  if (result.result.idTable()(1, 0).getBits() != 1042) return 5;
  if (result.result.sortedBy().size() != 1 || result.result.sortedBy()[0] != 0) return 6;
  if (text_search_calls != 1) return 7;

  auto prefix = xpod::qlever::textWordResultFromContext(
      qec, "run*", true, false, {ColumnIndex{0}});
  if (prefix.status != XPOD_RDF_STATUS_UNSUPPORTED) return 8;
  auto score = xpod::qlever::textWordResultFromContext(
      qec, "runtime", false, true, {ColumnIndex{0}});
  if (score.status != XPOD_RDF_STATUS_UNSUPPORTED) return 9;
  if (text_search_calls != 1) return 10;

  xpod_rdf_backend_v1 no_text_backend = raw_backend;
  no_text_backend.get_capabilities = [](void*, xpod_rdf_backend_capabilities* out) {
    out->features = 0;
    return XPOD_RDF_STATUS_OK;
  };
  xpod::rdf::PhysicalBackend no_text_physical(&no_text_backend);
  QueryExecutionContext no_text_qec;
  no_text_qec.setXpodPhysicalIndex(make_index(no_text_physical, request));
  auto unsupported = xpod::qlever::textWordResultFromContext(
      no_text_qec, "runtime", false, false, {ColumnIndex{0}});
  if (unsupported.status != XPOD_RDF_STATUS_UNSUPPORTED) return 11;
  return 0;
}
`, 'utf8');

      execFileSync('c++', [
        '-std=c++20',
        '-DXPOD_QLEVER_ADAPTER_ENABLE_QLEVER=1',
        '-I', path.join(qleverSource, 'src'),
        '-I', path.join(repoRoot, 'native/postgres/qlever_adapter/src'),
        '-I', path.join(repoRoot, 'native/postgres/qlever_adapter/include'),
        '-I', path.join(repoRoot, 'native/postgres/rdf_protocol/include'),
        smoke,
        '-o', binary,
      ], { stdio: 'pipe' });
      execFileSync(binary, [], { stdio: 'pipe' });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
