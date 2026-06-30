import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { fakeEncodedIriManagerHeader, fakeParsedQueryHeader, fakeSparqlTripleHeader } from './qleverFakeHeaders';

const repoRoot = path.resolve(__dirname, '../..');
const adapterSource = path.join(repoRoot, 'native/postgres/qlever_adapter/src/xpod_qlever_adapter.cpp');
const executorSource = path.join(repoRoot, 'native/postgres/qlever_adapter/src/XpodQleverExecutor.cpp');
const bridgeSource = path.join(repoRoot, 'native/postgres/qlever_adapter/src/XpodQleverBridge.cpp');

function hasCxx(): boolean {
  try {
    execFileSync('/usr/bin/env', ['c++', '--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

describe('QLever planner lazy execution path', () => {
  it('executes a planner-produced IndexScan through QueryExecutionTree lazy result and Xpod physical index', async () => {
    expect(hasCxx(), 'c++ compiler is required for native QLever planner lazy execution check').toBe(true);

    const root = await mkdtemp(path.join(os.tmpdir(), 'xpod-qlever-planner-lazy-execution-'));
    try {
      const qleverSource = path.join(root, 'qlever');
      await mkdir(path.join(qleverSource, 'src/libqlever'), { recursive: true });
      await mkdir(path.join(qleverSource, 'src/parser'), { recursive: true });
      await mkdir(path.join(qleverSource, 'src/engine/idTable'), { recursive: true });
      await mkdir(path.join(qleverSource, 'src/engine'), { recursive: true });
      await mkdir(path.join(qleverSource, 'src/global'), { recursive: true });
      await mkdir(path.join(qleverSource, 'src/index'), { recursive: true });
      await writeFile(path.join(qleverSource, 'src/index/EncodedIriManager.h'), fakeEncodedIriManagerHeader, 'utf8');
      await mkdir(path.join(qleverSource, 'src/util'), { recursive: true });
      await writeFile(path.join(qleverSource, 'src/libqlever/Qlever.h'), '#pragma once\n', 'utf8');
      await writeFile(path.join(qleverSource, 'src/parser/ParsedQuery.h'), fakeParsedQueryHeader, 'utf8');
      await writeFile(path.join(qleverSource, 'src/parser/SparqlTriple.h'), fakeSparqlTripleHeader, 'utf8');
      await writeFile(path.join(qleverSource, 'src/parser/SparqlParser.h'), '#pragma once\n#include <string>\n#include "parser/ParsedQuery.h"\nclass SparqlParser { public: static ParsedQuery parseQuery(const void*, std::string) { return ParsedQuery::minimalSelect(); } };\n', 'utf8');
      await writeFile(path.join(qleverSource, 'src/util/CancellationHandle.h'), '#pragma once\nnamespace ad_utility { struct SharedCancellationHandle {}; }\n', 'utf8');
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
      await writeFile(path.join(qleverSource, 'src/index/Permutation.h'), `
#pragma once
class Permutation {
 public:
  enum struct Enum { PSO, POS, SPO, SOP, OPS, OSP };
  explicit Permutation(Enum value = Enum::SPO) : value_(value) {}
  Enum permutation() const { return value_; }
 private:
  Enum value_;
};
`, 'utf8');
      await writeFile(path.join(qleverSource, 'src/index/LocalVocab.h'), '#pragma once\nclass LocalVocab {};\n', 'utf8');
      await writeFile(path.join(qleverSource, 'src/index/Index.h'), '#pragma once\nclass Index {};\n', 'utf8');
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
#include <memory>
#include <optional>
#include <utility>
#include <vector>
#include "engine/idTable/IdTable.h"
#include "global/Id.h"
#include "index/LocalVocab.h"

class Result {
 public:
  struct IdTableVocabPair {
    IdTable idTable_;
    LocalVocab localVocab_;
  };
  class LazyResult {
   public:
    explicit LazyResult(std::vector<IdTableVocabPair> chunks)
        : chunks_(std::move(chunks)) {}
    std::optional<IdTableVocabPair> get() {
      if (offset_ >= chunks_.size()) return std::nullopt;
      return std::move(chunks_[offset_++]);
    }
   private:
    std::vector<IdTableVocabPair> chunks_;
    size_t offset_ = 0;
  };

  Result(IdTable table, std::vector<ColumnIndex> sortedBy, LocalVocab&&)
      : materialized_(std::move(table)), sortedBy_(std::move(sortedBy)) {}
  Result(LazyResult lazy, std::vector<ColumnIndex> sortedBy)
      : lazy_(std::move(lazy)), sortedBy_(std::move(sortedBy)) {}

  bool isFullyMaterialized() const { return materialized_.has_value(); }
  const IdTable& idTable() const { return *materialized_; }
  LazyResult idTables() const { return std::move(*lazy_); }
  const std::vector<ColumnIndex>& sortedBy() const { return sortedBy_; }
 private:
  mutable std::optional<LazyResult> lazy_;
  std::optional<IdTable> materialized_;
  std::vector<ColumnIndex> sortedBy_;
};
`, 'utf8');
      await writeFile(path.join(qleverSource, 'src/engine/Operation.h'), `
#pragma once
#include <memory>
#include <string>
#include <vector>
#include "engine/Result.h"
#include "engine/QueryExecutionContext.h"
class QueryExecutionTree;
enum class ComputationMode { FULLY_MATERIALIZED, ONLY_IF_CACHED, LAZY_IF_SUPPORTED };
class Operation {
 public:
  explicit Operation(QueryExecutionContext* qec) : qec_(qec) {}
  virtual ~Operation() = default;
  virtual std::string getDescriptor() const = 0;
  virtual size_t getResultWidth() const = 0;
  const std::vector<ColumnIndex>& getResultSortedOn() const {
    sorted_cache_ = resultSortedOn();
    return sorted_cache_;
  }
  virtual std::vector<QueryExecutionTree*> getChildren() { return {}; }
  std::vector<const QueryExecutionTree*> getChildren() const { return {}; }
  std::shared_ptr<const Result> getResult(bool, ComputationMode mode) {
    return std::make_shared<Result>(computeResult(mode == ComputationMode::LAZY_IF_SUPPORTED));
  }
 protected:
  virtual std::vector<ColumnIndex> resultSortedOn() const = 0;
  virtual Result computeResult(bool requestLaziness) = 0;
  QueryExecutionContext* qec_;
 private:
  mutable std::vector<ColumnIndex> sorted_cache_;
};
`, 'utf8');
      await writeFile(path.join(qleverSource, 'src/engine/QueryExecutionTree.h'), `
#pragma once
#include <memory>
#include <string>
#include <vector>
#include "engine/Operation.h"
class QueryExecutionTree {
 public:
  QueryExecutionTree() = default;
  QueryExecutionTree(QueryExecutionContext*, std::shared_ptr<Operation> root)
      : root_(std::move(root)) {}
  explicit QueryExecutionTree(std::shared_ptr<Operation> root) : root_(std::move(root)) {}
  bool isEmpty() const { return root_ == nullptr; }
  std::shared_ptr<Operation> getRootOperation() const { return root_; }
  const std::string& getDescriptor() const { return descriptor_; }
  size_t getResultWidth() const { return root_->getResultWidth(); }
  const std::vector<ColumnIndex>& resultSortedOn() const { return root_->getResultSortedOn(); }
  std::shared_ptr<const Result> getResult(bool requestLaziness = false) const {
    return root_->getResult(true, requestLaziness ? ComputationMode::LAZY_IF_SUPPORTED
                                                 : ComputationMode::FULLY_MATERIALIZED);
  }
 private:
  std::shared_ptr<Operation> root_;
  std::string descriptor_;
};
`, 'utf8');
      await writeFile(path.join(qleverSource, 'src/engine/QueryExecutionContext.h'), `
#pragma once
#include <memory>
#include "XpodQleverPhysicalIndex.hpp"
class QueryExecutionContext {
 public:
  void setXpodPhysicalIndex(std::shared_ptr<const xpod::qlever::XpodQleverPhysicalIndex> index) {
    index_ = std::move(index);
  }
  const xpod::qlever::XpodQleverPhysicalIndex* xpodPhysicalIndex() const {
    return index_.get();
  }
 private:
  std::shared_ptr<const xpod::qlever::XpodQleverPhysicalIndex> index_;
};
`, 'utf8');
      await writeFile(path.join(qleverSource, 'src/index/CompressedRelation.h'), `
#pragma once
#include <memory>
#include <optional>
#include <vector>
#include "engine/idTable/IdTable.h"
namespace ad_utility {
template <typename T, typename Details = int>
class InputRangeFromGet {
 public:
  virtual ~InputRangeFromGet() = default;
  virtual std::optional<T> get() = 0;
  Details& details() { return details_; }
 private:
  Details details_;
};
template <typename T, typename Details = int>
class InputRangeTypeErased {
 public:
  InputRangeTypeErased() = default;
  explicit InputRangeTypeErased(std::unique_ptr<InputRangeFromGet<T, Details>> impl)
      : impl_(std::move(impl)) {}
  std::optional<T> get() {
    if (!impl_) return std::nullopt;
    return impl_->get();
  }
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
    const std::vector<CompressedBlockMetadata>& getBlockMetadataView() const { return blockMetadata_; }
  };
  struct LazyScanMetadata {
    size_t numBlocksRead_ = 0;
    size_t numBlocksAll_ = 0;
    size_t numElementsRead_ = 0;
    size_t numElementsYielded_ = 0;
  };
  using IdTableGeneratorInputRange = ad_utility::InputRangeTypeErased<IdTable, LazyScanMetadata>;
};
`, 'utf8');
      await writeFile(path.join(qleverSource, 'src/engine/IndexScan.h'), `
#pragma once
#include <optional>
#include <string>
#include <utility>
#include <vector>
#include "XpodQleverPhysicalIndexScanContextBridge.hpp"
#include "engine/Operation.h"
#include "index/Permutation.h"
#include "parser/SparqlTriple.h"
class IndexScan final : public Operation {
 public:
  IndexScan(QueryExecutionContext* qec = nullptr)
      : Operation(qec),
        subject_(Variable{"?s"}),
        predicate_(Variable{"?p"}),
        object_(Variable{"?o"}),
        permutation_(Permutation::Enum::SPO) {
    scan_spec_and_blocks_.scanSpec_.col1 = Id::fromBits(20);
    CompressedRelationReader::CompressedBlockMetadata::PermutedTriple triple = {
        Id::fromBits(10), Id::fromBits(20), Id::fromBits(30), Id::fromBits(40)};
    scan_spec_and_blocks_.blockMetadata_.push_back({7, 1, triple, triple});
  }
  const TripleComponent& subject() const { return subject_; }
  const TripleComponent& predicate() const { return predicate_; }
  const TripleComponent& object() const { return object_; }
  const Permutation& permutation() const { return permutation_; }
  std::string getDescriptor() const override { return "planner lazy IndexScan"; }
  size_t getResultWidth() const override { return 3; }
  CompressedRelationReader::IdTableGeneratorInputRange getLazyScan(
      std::optional<std::vector<CompressedRelationReader::CompressedBlockMetadata>> blocks) const {
    auto result = xpod::qlever::lazyScanRangeFromQleverScanSpecAndBlocks(
        *qec_, permutation_.permutation(), scan_spec_and_blocks_, std::move(blocks));
    return std::move(result.blocks);
  }
 protected:
  std::vector<ColumnIndex> resultSortedOn() const override { return {0}; }
  Result computeResult(bool requestLaziness) override {
    if (!requestLaziness) {
      IdTable table(3);
      table.push_back({Id::fromBits(999), Id::fromBits(999), Id::fromBits(999)});
      return {std::move(table), {0}, LocalVocab{}};
    }
    std::vector<Result::IdTableVocabPair> chunks;
    auto range = getLazyScan(std::nullopt);
    while (auto table = range.get()) {
      chunks.push_back({std::move(*table), LocalVocab{}});
    }
    return {Result::LazyResult{std::move(chunks)}, {0}};
  }
 private:
  TripleComponent subject_;
  TripleComponent predicate_;
  TripleComponent object_;
  Permutation permutation_;
  CompressedRelationReader::ScanSpecAndBlocks scan_spec_and_blocks_;
};
`, 'utf8');
      await writeFile(path.join(qleverSource, 'src/engine/Join.h'), `
#pragma once
#include "engine/Operation.h"
class Join final : public Operation {
 public:
  explicit Join(QueryExecutionContext* qec = nullptr) : Operation(qec) {}
  std::string getDescriptor() const override { return "unused join"; }
  size_t getResultWidth() const override { return 0; }
 protected:
  std::vector<ColumnIndex> resultSortedOn() const override { return {}; }
  Result computeResult(bool) override { return {IdTable(0), {}, LocalVocab{}}; }
};
`, 'utf8');
      await writeFile(path.join(qleverSource, 'src/engine/RuntimeInformation.h'), '#pragma once\n', 'utf8');
      await writeFile(path.join(qleverSource, 'src/engine/QueryPlanner.h'), `
#pragma once
#include <memory>
#include "engine/IndexScan.h"
#include "engine/QueryExecutionContext.h"
#include "engine/QueryExecutionTree.h"
#include "parser/ParsedQuery.h"
#include "util/CancellationHandle.h"
class QueryPlanner {
 public:
  QueryPlanner(QueryExecutionContext* qec, ad_utility::SharedCancellationHandle)
      : qec_(qec) {}
  QueryExecutionTree createExecutionTree(ParsedQuery&, bool = false) {
    return QueryExecutionTree(qec_, std::make_shared<IndexScan>(qec_));
  }
 private:
  QueryExecutionContext* qec_;
};
`, 'utf8');

      const smoke = path.join(root, 'planner_lazy_execution_smoke.cpp');
      const binary = path.join(root, 'planner_lazy_execution_smoke');
      await writeFile(smoke, `
#include <string_view>
#include "xpod_qlever_adapter.h"

struct BackendState {
  int scan_calls = 0;
  bool saw_block_restricted_lazy_scan = false;
};

static xpod_rdf_status get_capabilities(void*, xpod_rdf_backend_capabilities* out_capabilities) {
  out_capabilities->supported_permutations = XPOD_RDF_PERM_CAP_SPOG;
  out_capabilities->features = XPOD_RDF_BACKEND_FEATURE_BLOCK_RESTRICTED_SCAN;
  return XPOD_RDF_STATUS_OK;
}

static xpod_rdf_status encode(void*, xpod_rdf_term_key term, uint64_t* out_bits) {
  *out_bits = term;
  return XPOD_RDF_STATUS_OK;
}

static xpod_rdf_status decode(void*, uint64_t bits, xpod_rdf_term_key* out_term) {
  *out_term = bits;
  return XPOD_RDF_STATUS_OK;
}

static xpod_rdf_status resolve_terms(
    void*,
    const xpod_rdf_term_key* keys,
    size_t key_count,
    const xpod_rdf_snapshot*,
    xpod_rdf_term* out_terms,
    xpod_rdf_status* out_statuses) {
  static const char s[] = "urn:s";
  static const char p[] = "urn:p";
  static const char o[] = "urn:o";
  for (size_t i = 0; i < key_count; ++i) {
    out_statuses[i] = XPOD_RDF_STATUS_OK;
    out_terms[i].kind = XPOD_RDF_TERM_IRI;
    if (keys[i] == 10) out_terms[i].value = {s, 5};
    else if (keys[i] == 20) out_terms[i].value = {p, 5};
    else if (keys[i] == 30) out_terms[i].value = {o, 5};
    else return XPOD_RDF_STATUS_BACKEND_ERROR;
  }
  return XPOD_RDF_STATUS_OK;
}

static xpod_rdf_status estimate_scan(void*, const xpod_rdf_scan_request*, xpod_rdf_estimate* out_estimate) {
  out_estimate->rows = 1;
  out_estimate->confidence = XPOD_RDF_ESTIMATE_EXACT;
  return XPOD_RDF_STATUS_OK;
}

static xpod_rdf_status scan(
    void* user_data,
    const xpod_rdf_scan_request* request,
    xpod_rdf_quad_batch_callback on_batch,
    void* callback_user_data) {
  auto* state = static_cast<BackendState*>(user_data);
  ++state->scan_calls;
  if (request->permutation != XPOD_RDF_PERM_SPOG) return XPOD_RDF_STATUS_BACKEND_ERROR;
  if (!request->pattern.has_predicate || request->pattern.predicate != 20) return XPOD_RDF_STATUS_BACKEND_ERROR;
  if (request->block_metadata_count != 1) return XPOD_RDF_STATUS_BACKEND_ERROR;
  if (request->block_metadata[0].block_id != 7) return XPOD_RDF_STATUS_BACKEND_ERROR;
  state->saw_block_restricted_lazy_scan = true;
  xpod_rdf_quad_key rows[1] = {{10, 20, 30, 40}};
  xpod_rdf_quad_batch batch = {};
  batch.rows = rows;
  batch.row_count = 1;
  return on_batch(callback_user_data, &batch);
}

int main() {
  BackendState state;
  xpod_rdf_backend_v1 raw_backend = {};
  raw_backend.abi_version = XPOD_RDF_PHYSICAL_BACKEND_ABI_VERSION;
  raw_backend.struct_size = sizeof(xpod_rdf_backend_v1);
  raw_backend.backend_user_data = &state;
  raw_backend.get_capabilities = get_capabilities;
  raw_backend.encode_qlever_id = encode;
  raw_backend.decode_qlever_id = decode;
  raw_backend.resolve_terms = resolve_terms;
  raw_backend.estimate_scan = estimate_scan;
  raw_backend.scan_permutation = scan;
  raw_backend.term_key_encoding = XPOD_RDF_TERM_KEY_ENCODING_QLEVER_VALUE_ID_BITS;

  xpod_qlever_adapter_config config = {};
  config.backend = &raw_backend;
  xpod_qlever_adapter* adapter = nullptr;
  if (xpod_qlever_adapter_create(&config, &adapter) != XPOD_RDF_STATUS_OK) return 1;

  xpod_qlever_query_request request = {};
  request.sparql = {"SELECT * WHERE { ?s ?p ?o }", 27};
  xpod_qlever_query_result result = {};
  xpod_rdf_status status = xpod_qlever_adapter_query_request(adapter, &request, &result);
  std::string_view json(result.result_json.data, result.result_json.size);
  std::string_view profile(result.profile_json.data, result.profile_json.size);
  if (status != XPOD_RDF_STATUS_OK) return 2;
  if (!state.saw_block_restricted_lazy_scan || state.scan_calls != 1) return 3;
  if (json.find("urn:s") == std::string_view::npos) return 4;
  if (json.find("urn:p") == std::string_view::npos) return 5;
  if (json.find("urn:o") == std::string_view::npos) return 6;
  if (json.find("999") != std::string_view::npos) return 7;
  if (profile.find("planner lazy IndexScan") == std::string_view::npos) return 8;
  xpod_qlever_adapter_destroy(adapter);
  return 0;
}
`, 'utf8');

      execFileSync('c++', [
        '-std=c++17',
        '-Wall',
        '-Wextra',
        '-Werror',
        '-DXPOD_QLEVER_ADAPTER_ENABLE_QLEVER=1',
        '-I', path.join(repoRoot, 'native/postgres/rdf_protocol/include'),
        '-I', path.join(repoRoot, 'native/postgres/qlever_adapter/include'),
        '-I', path.join(repoRoot, 'native/postgres/qlever_adapter/src'),
        '-I', path.join(qleverSource, 'src'),
        adapterSource,
        executorSource,
        bridgeSource,
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
