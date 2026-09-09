import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'bun:test';

const repoRoot = path.resolve(__dirname, '../..');
const bridgeHeader = path.join(repoRoot, 'qlever/qlever_adapter/src/XpodQleverPhysicalIndexScanContextBridge.hpp');

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
  Id() : bits_(0) {}
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
#include "index/CompressedRelation.h"
class Permutation {
 public:
  enum struct Enum { PSO, POS, SPO, SOP, OPS, OSP };
  using ScanSpecAndBlocks = CompressedRelationReader::ScanSpecAndBlocks;
  using MetadataAndBlocks = CompressedRelationReader::ScanSpecAndBlocksAndBounds;
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
#include <utility>
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
    size_t sizeBlockMetadata_ = 0;
    ScanSpecAndBlocks() = default;
    ScanSpecAndBlocks(
        ScanSpecification scanSpec,
        const std::vector<std::vector<CompressedBlockMetadata>>& ranges)
        : scanSpec_(scanSpec) {
      for (const auto& range : ranges) {
        blockMetadata_.insert(blockMetadata_.end(), range.begin(), range.end());
      }
      sizeBlockMetadata_ = blockMetadata_.size();
    }
    const std::vector<CompressedBlockMetadata>& getBlockMetadataView() const {
      return blockMetadata_;
    }
  };
  struct ScanSpecAndBlocksAndBounds : public ScanSpecAndBlocks {
    struct FirstAndLastTriple {
      CompressedBlockMetadata::PermutedTriple firstTriple_;
      CompressedBlockMetadata::PermutedTriple lastTriple_;
    };
    FirstAndLastTriple firstAndLastTriple_;
    ScanSpecAndBlocksAndBounds(
        ScanSpecAndBlocks base,
        FirstAndLastTriple triples)
        : ScanSpecAndBlocks(std::move(base)),
          firstAndLastTriple_(std::move(triples)) {}
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
using CompressedBlockMetadata = CompressedRelationReader::CompressedBlockMetadata;
using BlockMetadataSpan = std::vector<CompressedBlockMetadata>;
using BlockMetadataRange = std::vector<CompressedBlockMetadata>;
using BlockMetadataRanges = std::vector<BlockMetadataRange>;
`, 'utf8');
  return qleverSource;
}

describe('QLever physical index scan context bridge', () => {
  it('treats missing physical block metadata as an empty metadata result instead of an IndexScan failure', () => {
    const header = readFileSync(bridgeHeader, 'utf8');

    expect(header).toContain('if (physical_metadata.status == XPOD_RDF_STATUS_UNSUPPORTED)');
    expect(header).toContain('result.status = XPOD_RDF_STATUS_OK;');
    expect(header).toContain('return result;');
  });

  it('converts QLever limit-offset clauses into physical scan bounds', async () => {
    expect(hasCxx(), 'c++ compiler is required for native physical limit-offset bridge check').toBe(true);

    const root = await mkdtemp(path.join(os.tmpdir(), 'xpod-qlever-limit-offset-'));
    try {
      const qleverSource = await writeMinimalQleverHeaders(root);
      const smoke = path.join(root, 'limit_offset_smoke.cpp');
      const binary = path.join(root, 'limit_offset_smoke');
      await writeFile(smoke, `
#include "XpodQleverPhysicalIndexScanContextBridge.hpp"

#include <cstdint>

struct FakeLimitOffset {
  bool unconstrained;
  uint64_t _offset;
  uint64_t limit;

  bool isUnconstrained() const { return unconstrained; }
  uint64_t limitOrDefault() const { return limit; }
};

int main() {
  auto unconstrained = xpod::qlever::qleverPhysicalScanLimitOffset(
      FakeLimitOffset{true, 99, 88});
  if (unconstrained.limit != 0 || unconstrained.offset != 0) return 1;

  auto constrained = xpod::qlever::qleverPhysicalScanLimitOffset(
      FakeLimitOffset{false, 2, 1});
  if (constrained.limit != 1 || constrained.offset != 2) return 2;

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
        '-I', path.join(repoRoot, 'qlever/rdf_protocol/include'),
        '-I', path.join(repoRoot, 'qlever/qlever_adapter/include'),
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

  it('recognizes when upstream IndexScan construction can avoid QLever block metadata', async () => {
    expect(hasCxx(), 'c++ compiler is required for native physical index context bridge check').toBe(true);

    const root = await mkdtemp(path.join(os.tmpdir(), 'xpod-qlever-context-scan-spec-'));
    try {
      const qleverSource = await writeMinimalQleverHeaders(root);
      const smoke = path.join(root, 'context_scan_spec_smoke.cpp');
      const binary = path.join(root, 'context_scan_spec_smoke');
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

static xpod_rdf_status get_capabilities(
    void*,
    xpod_rdf_backend_capabilities* out_capabilities) {
  out_capabilities->supported_permutations = XPOD_RDF_PERM_CAP_SPOG;
  out_capabilities->features = 0;
  return XPOD_RDF_STATUS_OK;
}

static xpod_rdf_status scan_permutation(
    void*,
    const xpod_rdf_scan_request*,
    xpod_rdf_quad_batch_callback,
    void*) {
  return XPOD_RDF_STATUS_OK;
}

static xpod_rdf_status estimate_scan(
    void*,
    const xpod_rdf_scan_request* request,
    xpod_rdf_estimate* out_estimate) {
  if (request->permutation != XPOD_RDF_PERM_SPOG) return XPOD_RDF_STATUS_BACKEND_ERROR;
  if (!request->pattern.has_predicate || request->pattern.predicate != 20) return XPOD_RDF_STATUS_BACKEND_ERROR;
  out_estimate->rows = 12;
  out_estimate->confidence = XPOD_RDF_ESTIMATE_EXACT;
  return XPOD_RDF_STATUS_OK;
}

int main() {
  xpod_rdf_backend_v1 raw_backend = {};
  raw_backend.abi_version = XPOD_RDF_PHYSICAL_BACKEND_ABI_VERSION;
  raw_backend.struct_size = sizeof(xpod_rdf_backend_v1);
  raw_backend.get_capabilities = get_capabilities;
  raw_backend.scan_permutation = scan_permutation;
  raw_backend.estimate_scan = estimate_scan;
  raw_backend.term_key_encoding = XPOD_RDF_TERM_KEY_ENCODING_QLEVER_VALUE_ID_BITS;
  xpod::rdf::PhysicalBackend physical(&raw_backend);

  xpod_qlever_query_request request = {};
  xpod::qlever::PlannerRequestContext planner_context{physical, &request, request.cancellation};
  planner_context.capabilities_status = physical.getCapabilities(planner_context.capabilities);

  QueryExecutionContext qec;
  qec.setXpodPhysicalIndex(xpod::qlever::XpodQleverPhysicalIndex(planner_context));

  ScanSpec spec;
  if (!xpod::qlever::canUsePhysicalScanSpecAndBlocks(
          qec, Permutation::Enum::SPO, spec)) {
    return 1;
  }
  auto estimate = xpod::qlever::sizeEstimateFromQleverScanSpecAndBlocks(
      qec, Permutation::Enum::SPO, spec);
  if (estimate.status != XPOD_RDF_STATUS_OK) return 2;
  if (!estimate.exact || estimate.rows != 12) return 3;

  xpod_rdf_backend_v1 no_estimate_backend = raw_backend;
  no_estimate_backend.estimate_scan = nullptr;
  xpod::rdf::PhysicalBackend no_estimate_physical(&no_estimate_backend);
  xpod::qlever::PlannerRequestContext no_estimate_context{
      no_estimate_physical,
      &request,
      request.cancellation};
  no_estimate_context.capabilities_status =
      no_estimate_physical.getCapabilities(no_estimate_context.capabilities);
  QueryExecutionContext no_estimate_qec;
  no_estimate_qec.setXpodPhysicalIndex(
      xpod::qlever::XpodQleverPhysicalIndex(no_estimate_context));
  if (xpod::qlever::canUsePhysicalScanSpecAndBlocks(
          no_estimate_qec, Permutation::Enum::SPO, spec)) {
    return 4;
  }

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
        '-I', path.join(repoRoot, 'qlever/rdf_protocol/include'),
        '-I', path.join(repoRoot, 'qlever/qlever_adapter/include'),
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

  it('recognizes QLever GRAPH variable scans when the default graph blacklist is a runtime vocab id', async () => {
    expect(hasCxx(), 'c++ compiler is required for native physical index context bridge graph-variable check').toBe(true);

    const root = await mkdtemp(path.join(os.tmpdir(), 'xpod-qlever-context-runtime-default-graph-'));
    try {
      const qleverSource = await writeMinimalQleverHeaders(root);
      await writeFile(path.join(qleverSource, 'src/engine/QueryExecutionContext.h'), `
#pragma once
class FakeIndexImpl {};
class FakeIndex {
 public:
  const FakeIndexImpl& getImpl() const { return impl_; }
 private:
  FakeIndexImpl impl_;
};
class QueryExecutionContext {
 public:
  const FakeIndex& getIndex() const { return index_; }
 private:
  FakeIndex index_;
};
`, 'utf8');
      await mkdir(path.join(qleverSource, 'src/util'), { recursive: true });
      await writeFile(path.join(qleverSource, 'src/util/Conversions.h'), `
#pragma once
#include <string>
#include <string_view>
inline std::string_view asStringViewUnsafe(const std::string& value) {
  return value;
}
`, 'utf8');
      await writeFile(path.join(qleverSource, 'src/index/ExportIds.h'), `
#pragma once
#include <optional>
#include <string>
#include "global/Id.h"
#include "index/LocalVocab.h"

class FakeIndexImpl;

namespace ql::exportIds {
class ResolvedLiteralOrIri {
 public:
  explicit ResolvedLiteralOrIri(std::string iri) : iri_(std::move(iri)) {}
  bool isIri() const { return true; }
  bool isLiteral() const { return false; }
  const std::string& getIriContent() const { return iri_; }
  const std::string& getLiteralContent() const { return iri_; }
  bool hasDatatype() const { return false; }
  const std::string& getDatatype() const { return iri_; }
  bool hasLanguageTag() const { return false; }
  const std::string& getLanguageTag() const { return iri_; }
 private:
  std::string iri_;
};

inline std::optional<ResolvedLiteralOrIri> idToLiteralOrIri(
    const FakeIndexImpl&,
    Id id,
    const LocalVocab&) {
  if (id.getBits() == 3000) {
    return ResolvedLiteralOrIri{
        "http://qlever.cs.uni-freiburg.de/builtin-functions/default-graph"};
  }
  if (id.getBits() == 3001) {
    return ResolvedLiteralOrIri{"urn:missing-graph"};
  }
  if (id.getBits() == 3002) {
    return ResolvedLiteralOrIri{"urn:graphs/visible"};
  }
  return std::nullopt;
}
}
`, 'utf8');
      const smoke = path.join(root, 'context_runtime_default_graph_smoke.cpp');
      const binary = path.join(root, 'context_runtime_default_graph_smoke');
      await writeFile(smoke, `
#include <algorithm>
#include <array>
#include <optional>
#include <string_view>
#include <variant>
#include <vector>
#include "XpodQleverPhysicalIndexScanContextBridge.hpp"

class GraphFilter {
 public:
  struct AllTag {};
  using FilterType = std::variant<AllTag, std::vector<Id>, Id>;

  static GraphFilter Whitelist(std::vector<Id> values) {
    return GraphFilter(std::move(values));
  }
  static GraphFilter Blacklist(Id value) { return GraphFilter(value); }
  bool areAllGraphsAllowed() const { return std::holds_alternative<AllTag>(filter_); }
  const FilterType& xpodPhysicalFilterType() const { return filter_; }
 private:
  explicit GraphFilter(FilterType filter) : filter_(filter) {}
  FilterType filter_;
};

class ScanSpecification {
 public:
  using T = std::optional<Id>;
  ScanSpecification(T col0, T col1, T col2, GraphFilter graph_filter)
      : col0_(col0), col1_(col1), col2_(col2), graph_filter_(graph_filter) {}
  const T& col0Id() const { return col0_; }
  const T& col1Id() const { return col1_; }
  const T& col2Id() const { return col2_; }
  const GraphFilter& graphFilter() const { return graph_filter_; }
 private:
  T col0_;
  T col1_;
  T col2_;
  GraphFilter graph_filter_;
};

class TripleComponent {
 public:
  bool isVariable() const { return true; }
};

static xpod_rdf_bytes bytes(std::string_view value) {
  return {value.data(), value.size()};
}

static bool hasGraph(const xpod::qlever::XpodQleverScanSpecAndBlocks& scan,
                     xpod_rdf_term_key graph) {
  if (scan.graph_scope.kind == XPOD_RDF_GRAPH_SCOPE_EXACT) {
    return scan.graph_scope.exact_graph == graph;
  }
  if (scan.graph_scope.kind == XPOD_RDF_GRAPH_SCOPE_SET) {
    return std::find(scan.graph_scope.graph_set,
                     scan.graph_scope.graph_set + scan.graph_scope.graph_set_size,
                     graph) !=
           scan.graph_scope.graph_set + scan.graph_scope.graph_set_size;
  }
  return false;
}

class BridgeContext {
 public:
  explicit BridgeContext(const xpod::qlever::XpodQleverPhysicalIndex& index)
      : index_(index) {}
  const xpod::qlever::XpodQleverPhysicalIndex* xpodPhysicalIndex() const {
    return &index_;
  }
 private:
  xpod::qlever::XpodQleverPhysicalIndex index_;
};

static xpod_rdf_status get_capabilities(
    void*,
    xpod_rdf_backend_capabilities* out_capabilities) {
  out_capabilities->supported_permutations = XPOD_RDF_PERM_CAP_SPOG;
  return XPOD_RDF_STATUS_OK;
}

static xpod_rdf_status decode_qlever_id(void*, uint64_t bits, xpod_rdf_term_key* out_term) {
  if (bits == 3001) {
    return XPOD_RDF_STATUS_UNSUPPORTED;
  }
  *out_term = bits;
  return XPOD_RDF_STATUS_OK;
}

static xpod_rdf_status lookup_term(
    void*,
    const xpod_rdf_term* term,
    const xpod_rdf_snapshot*,
    xpod_rdf_term_key* out_term) {
  std::string_view value{term->value.data, term->value.size};
  if (term->kind != XPOD_RDF_TERM_IRI) return XPOD_RDF_STATUS_NOT_FOUND;
  if (value == "http://qlever.cs.uni-freiburg.de/builtin-functions/default-graph") {
    *out_term = 99;
    return XPOD_RDF_STATUS_OK;
  }
  if (value == "urn:graphs/visible") {
    *out_term = 100;
    return XPOD_RDF_STATUS_OK;
  }
  return XPOD_RDF_STATUS_NOT_FOUND;
}

static xpod_rdf_status resolve_term(
    void*,
    xpod_rdf_term_key key,
    const xpod_rdf_snapshot*,
    xpod_rdf_term* out_term) {
  if (key == 99) {
    out_term->kind = XPOD_RDF_TERM_IRI;
    out_term->value = bytes("http://qlever.cs.uni-freiburg.de/builtin-functions/default-graph");
    return XPOD_RDF_STATUS_OK;
  }
  if (key == 100) {
    out_term->kind = XPOD_RDF_TERM_IRI;
    out_term->value = bytes("urn:graphs/visible");
    return XPOD_RDF_STATUS_OK;
  }
  return XPOD_RDF_STATUS_NOT_FOUND;
}

static xpod_rdf_status estimate_scan(
    void*,
    const xpod_rdf_scan_request*,
    xpod_rdf_estimate* out_estimate) {
  out_estimate->rows = 1;
  out_estimate->confidence = XPOD_RDF_ESTIMATE_EXACT;
  return XPOD_RDF_STATUS_OK;
}

static xpod_rdf_status scan_permutation(
    void*,
    const xpod_rdf_scan_request*,
    xpod_rdf_quad_batch_callback,
    void*) {
  return XPOD_RDF_STATUS_OK;
}

int main() {
  xpod_rdf_backend_v1 raw_backend = {};
  raw_backend.abi_version = XPOD_RDF_PHYSICAL_BACKEND_ABI_VERSION;
  raw_backend.struct_size = sizeof(xpod_rdf_backend_v1);
  raw_backend.get_capabilities = get_capabilities;
  raw_backend.decode_qlever_id = decode_qlever_id;
  raw_backend.lookup_term = lookup_term;
  raw_backend.resolve_term = resolve_term;
  raw_backend.estimate_scan = estimate_scan;
  raw_backend.scan_permutation = scan_permutation;
  raw_backend.term_key_encoding = XPOD_RDF_TERM_KEY_ENCODING_QLEVER_VALUE_ID_BITS;
  xpod::rdf::PhysicalBackend physical(&raw_backend);

  xpod_qlever_query_request request = {};
  QueryExecutionContext qec;
  xpod::qlever::PlannerRequestContext planner_context{
      physical,
      &request,
      request.cancellation};
  planner_context.qec = &qec;
  planner_context.capabilities_status =
      physical.getCapabilities(planner_context.capabilities);
  BridgeContext bridge_context{
      xpod::qlever::XpodQleverPhysicalIndex(planner_context)};

  ScanSpecification spec{
      Id::fromBits(10),
      Id::fromBits(20),
      Id::fromBits(30),
      GraphFilter::Blacklist(Id::fromBits(3000))};
  TripleComponent s;
  TripleComponent p;
  TripleComponent o;
  std::array<const TripleComponent* const, 3> permuted_triple{&s, &p, &o};
  if (!xpod::qlever::canUsePhysicalScanSpecAndBlocks(
          bridge_context,
          Permutation::Enum::SPO,
          spec,
          permuted_triple)) {
    return 1;
  }
  ScanSpecification missing_graph_spec{
      Id::fromBits(10),
      Id::fromBits(20),
      Id::fromBits(30),
      GraphFilter::Whitelist({Id::fromBits(3001)})};
  if (!xpod::qlever::canUsePhysicalScanSpecAndBlocks(
          bridge_context,
          Permutation::Enum::SPO,
          missing_graph_spec,
          permuted_triple)) {
    return 2;
  }
  auto missing_graph_scan = bridge_context.xpodPhysicalIndex()
                                ->permutation(Permutation::Enum::SPO)
                                .getScanSpecAndBlocks(
                                    missing_graph_spec, permuted_triple);
  if (missing_graph_scan.status != XPOD_RDF_STATUS_OK ||
      !missing_graph_scan.always_empty) {
    return 3;
  }
  auto missing_graph_estimate = bridge_context.xpodPhysicalIndex()
                                    ->permutation(Permutation::Enum::SPO)
                                    .getSizeEstimateForScan(missing_graph_scan);
  if (missing_graph_estimate.status != XPOD_RDF_STATUS_OK ||
      missing_graph_estimate.lower != 0 ||
      missing_graph_estimate.upper != 0 ||
      !missing_graph_estimate.exact) {
    return 4;
  }
  ScanSpecification mixed_graph_spec{
      Id::fromBits(10),
      Id::fromBits(20),
      Id::fromBits(30),
      GraphFilter::Whitelist({Id::fromBits(3000), Id::fromBits(3001)})};
  auto mixed_graph_scan = bridge_context.xpodPhysicalIndex()
                              ->permutation(Permutation::Enum::SPO)
                              .getScanSpecAndBlocks(
                                  mixed_graph_spec, permuted_triple);
  if (mixed_graph_scan.status != XPOD_RDF_STATUS_OK ||
      mixed_graph_scan.always_empty ||
      mixed_graph_scan.graph_scope.kind != XPOD_RDF_GRAPH_SCOPE_EXACT ||
      mixed_graph_scan.graph_scope.exact_graph != 99) {
    return 5;
  }

  request.graph_scope.kind = XPOD_RDF_GRAPH_SCOPE_PREFIX;
  request.graph_scope.iri_prefix = bytes("urn:graphs/");
  request.source_scope.source_uri_prefix = bytes("urn:graphs/");
  xpod::qlever::XpodQleverPhysicalIndex source_index(planner_context);
  ScanSpecification source_spec{
      std::nullopt,
      std::nullopt,
      std::nullopt,
      GraphFilter::Whitelist({Id::fromBits(3000), Id::fromBits(3002)})};
  auto matching_source_scan = xpod::qlever::physicalScanSpecAndBlocks(
      source_index,
      Permutation::Enum::SPO,
      source_spec,
      permuted_triple,
      XPOD_RDF_SLOT_SUBJECT | XPOD_RDF_SLOT_PREDICATE |
          XPOD_RDF_SLOT_OBJECT);
  if (matching_source_scan.status != XPOD_RDF_STATUS_OK) return 6;
  if (!hasGraph(matching_source_scan, 99) ||
      !hasGraph(matching_source_scan, 100)) {
    return 7;
  }

  request.source_scope = {};
  xpod::qlever::XpodQleverPhysicalIndex no_source_index(planner_context);
  auto no_source_scan = xpod::qlever::physicalScanSpecAndBlocks(
      no_source_index,
      Permutation::Enum::SPO,
      source_spec,
      permuted_triple,
      XPOD_RDF_SLOT_SUBJECT | XPOD_RDF_SLOT_PREDICATE |
          XPOD_RDF_SLOT_OBJECT);
  if (no_source_scan.status != XPOD_RDF_STATUS_OK) return 8;
  if (hasGraph(no_source_scan, 99) || !hasGraph(no_source_scan, 100)) {
    return 9;
  }

  request.source_scope.source_uri_prefix = bytes("urn:other/");
  xpod::qlever::XpodQleverPhysicalIndex mismatched_source_index(planner_context);
  auto mismatched_source_scan = xpod::qlever::physicalScanSpecAndBlocks(
      mismatched_source_index,
      Permutation::Enum::SPO,
      source_spec,
      permuted_triple,
      XPOD_RDF_SLOT_SUBJECT | XPOD_RDF_SLOT_PREDICATE |
          XPOD_RDF_SLOT_OBJECT);
  if (mismatched_source_scan.status != XPOD_RDF_STATUS_OK) return 10;
  if (hasGraph(mismatched_source_scan, 99) ||
      !hasGraph(mismatched_source_scan, 100)) {
    return 11;
  }
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
        '-I', path.join(repoRoot, 'qlever/rdf_protocol/include'),
        '-I', path.join(repoRoot, 'qlever/qlever_adapter/include'),
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

  it('resolves upstream IndexScan exact sizes through the injected physical count seam', async () => {
    expect(hasCxx(), 'c++ compiler is required for native physical index context bridge check').toBe(true);

    const root = await mkdtemp(path.join(os.tmpdir(), 'xpod-qlever-context-exact-size-'));
    try {
      const qleverSource = await writeMinimalQleverHeaders(root);
      const smoke = path.join(root, 'context_exact_size_smoke.cpp');
      const binary = path.join(root, 'context_exact_size_smoke');
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
  int count_calls;
};

static xpod_rdf_status get_capabilities(
    void*,
    xpod_rdf_backend_capabilities* out_capabilities) {
  out_capabilities->supported_permutations = XPOD_RDF_PERM_CAP_SPOG;
  out_capabilities->features = 0;
  return XPOD_RDF_STATUS_OK;
}

static xpod_rdf_status count_scan(
    void* user_data,
    const xpod_rdf_scan_request* request,
    xpod_rdf_count_result* out_result) {
  auto* state = static_cast<BackendState*>(user_data);
  ++state->count_calls;
  if (request->permutation != XPOD_RDF_PERM_SPOG) return XPOD_RDF_STATUS_BACKEND_ERROR;
  if (!request->pattern.has_predicate || request->pattern.predicate != 20) return XPOD_RDF_STATUS_BACKEND_ERROR;
  out_result->count = 42;
  out_result->confidence = XPOD_RDF_ESTIMATE_EXACT;
  return XPOD_RDF_STATUS_OK;
}

int main() {
  BackendState state = {};
  xpod_rdf_backend_v1 raw_backend = {};
  raw_backend.abi_version = XPOD_RDF_PHYSICAL_BACKEND_ABI_VERSION;
  raw_backend.struct_size = sizeof(xpod_rdf_backend_v1);
  raw_backend.backend_user_data = &state;
  raw_backend.get_capabilities = get_capabilities;
  raw_backend.count_scan = count_scan;
  raw_backend.term_key_encoding = XPOD_RDF_TERM_KEY_ENCODING_QLEVER_VALUE_ID_BITS;
  xpod::rdf::PhysicalBackend physical(&raw_backend);

  xpod_qlever_query_request request = {};
  xpod::qlever::PlannerRequestContext planner_context{physical, &request, request.cancellation};
  planner_context.capabilities_status = physical.getCapabilities(planner_context.capabilities);

  QueryExecutionContext qec;
  qec.setXpodPhysicalIndex(xpod::qlever::XpodQleverPhysicalIndex(planner_context));

  ScanSpec spec;
  auto exact = xpod::qlever::exactSizeFromQleverScanSpecAndBlocks(
      qec,
      Permutation::Enum::SPO,
      spec);
  if (exact.status != XPOD_RDF_STATUS_OK) return 1;
  if (exact.rows != 42) return 2;
  if (state.count_calls != 1) return 3;

  xpod_rdf_backend_v1 no_count_backend = raw_backend;
  no_count_backend.count_scan = nullptr;
  xpod::rdf::PhysicalBackend no_count_physical(&no_count_backend);
  xpod::qlever::PlannerRequestContext no_count_context{
      no_count_physical,
      &request,
      request.cancellation};
  no_count_context.capabilities_status =
      no_count_physical.getCapabilities(no_count_context.capabilities);
  QueryExecutionContext no_count_qec;
  no_count_qec.setXpodPhysicalIndex(
      xpod::qlever::XpodQleverPhysicalIndex(no_count_context));
  auto unsupported = xpod::qlever::exactSizeFromQleverScanSpecAndBlocks(
      no_count_qec,
      Permutation::Enum::SPO,
      spec);
  if (unsupported.status != XPOD_RDF_STATUS_UNSUPPORTED) return 4;

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
        '-I', path.join(repoRoot, 'qlever/rdf_protocol/include'),
        '-I', path.join(repoRoot, 'qlever/qlever_adapter/include'),
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

  it('estimates upstream IndexScan multiplicities through physical distinct estimates', async () => {
    expect(hasCxx(), 'c++ compiler is required for native physical multiplicity bridge check').toBe(true);

    const root = await mkdtemp(path.join(os.tmpdir(), 'xpod-qlever-context-multiplicity-'));
    try {
      const qleverSource = await writeMinimalQleverHeaders(root);
      const smoke = path.join(root, 'context_multiplicity_smoke.cpp');
      const binary = path.join(root, 'context_multiplicity_smoke');
      await writeFile(smoke, `
#include "XpodQleverPhysicalIndexScanContextBridge.hpp"

#include <cmath>
#include <optional>
#include <vector>

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
  int estimate_scan_calls = 0;
  int estimate_distinct_calls = 0;
  uint32_t distinct_slots_seen[3] = {};
};

static xpod_rdf_status get_capabilities(
    void*,
    xpod_rdf_backend_capabilities* out_capabilities) {
  out_capabilities->supported_permutations = XPOD_RDF_PERM_CAP_SPOG;
  out_capabilities->features = 0;
  return XPOD_RDF_STATUS_OK;
}

static xpod_rdf_status estimate_scan(
    void* user_data,
    const xpod_rdf_scan_request* request,
    xpod_rdf_estimate* out_estimate) {
  auto* state = static_cast<BackendState*>(user_data);
  ++state->estimate_scan_calls;
  if (request->permutation != XPOD_RDF_PERM_SPOG) return XPOD_RDF_STATUS_BACKEND_ERROR;
  if (!request->pattern.has_predicate || request->pattern.predicate != 20) return XPOD_RDF_STATUS_BACKEND_ERROR;
  out_estimate->rows = 12;
  out_estimate->confidence = XPOD_RDF_ESTIMATE_FRESH;
  return XPOD_RDF_STATUS_OK;
}

static xpod_rdf_status estimate_distinct(
    void* user_data,
    const xpod_rdf_distinct_request* request,
    xpod_rdf_estimate* out_estimate) {
  auto* state = static_cast<BackendState*>(user_data);
  if (state->estimate_distinct_calls >= 3) return XPOD_RDF_STATUS_BACKEND_ERROR;
  state->distinct_slots_seen[state->estimate_distinct_calls] = request->distinct_slots;
  ++state->estimate_distinct_calls;
  if (request->scan.permutation != XPOD_RDF_PERM_SPOG) return XPOD_RDF_STATUS_BACKEND_ERROR;
  if (!request->scan.pattern.has_predicate || request->scan.pattern.predicate != 20) return XPOD_RDF_STATUS_BACKEND_ERROR;
  if (request->distinct_slots == XPOD_RDF_SLOT_SUBJECT) {
    out_estimate->rows = 3;
  } else if (request->distinct_slots == XPOD_RDF_SLOT_OBJECT) {
    out_estimate->rows = 4;
  } else {
    return XPOD_RDF_STATUS_BACKEND_ERROR;
  }
  out_estimate->confidence = XPOD_RDF_ESTIMATE_FRESH;
  return XPOD_RDF_STATUS_OK;
}

int main() {
  BackendState state = {};
  xpod_rdf_backend_v1 raw_backend = {};
  raw_backend.abi_version = XPOD_RDF_PHYSICAL_BACKEND_ABI_VERSION;
  raw_backend.struct_size = sizeof(xpod_rdf_backend_v1);
  raw_backend.backend_user_data = &state;
  raw_backend.get_capabilities = get_capabilities;
  raw_backend.estimate_scan = estimate_scan;
  raw_backend.estimate_distinct = estimate_distinct;
  raw_backend.term_key_encoding = XPOD_RDF_TERM_KEY_ENCODING_QLEVER_VALUE_ID_BITS;
  xpod::rdf::PhysicalBackend physical(&raw_backend);

  xpod_qlever_query_request request = {};
  xpod::qlever::PlannerRequestContext planner_context{physical, &request, request.cancellation};
  planner_context.capabilities_status = physical.getCapabilities(planner_context.capabilities);

  QueryExecutionContext qec;
  qec.setXpodPhysicalIndex(xpod::qlever::XpodQleverPhysicalIndex(planner_context));

  CompressedRelationReader::ScanSpecAndBlocks scan_spec_and_blocks = {};
  scan_spec_and_blocks.scanSpec_.col1 = Id::fromBits(20);

  const std::vector<uint32_t> projected_slots = {
      XPOD_RDF_SLOT_SUBJECT,
      XPOD_RDF_SLOT_OBJECT,
  };
  auto multiplicities =
      xpod::qlever::multiplicitiesFromQleverScanSpecAndBlocks(
          qec, Permutation::Enum::SPO, scan_spec_and_blocks, projected_slots);
  if (multiplicities.status != XPOD_RDF_STATUS_OK) return 1;
  if (multiplicities.values.size() != 2) return 2;
  if (std::fabs(multiplicities.values[0] - 4.0f) > 0.001f) return 3;
  if (std::fabs(multiplicities.values[1] - 3.0f) > 0.001f) return 4;
  if (state.estimate_scan_calls != 1) return 5;
  if (state.estimate_distinct_calls != 2) return 6;
  if (state.distinct_slots_seen[0] != XPOD_RDF_SLOT_SUBJECT) return 7;
  if (state.distinct_slots_seen[1] != XPOD_RDF_SLOT_OBJECT) return 8;
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
        '-I', path.join(repoRoot, 'qlever/rdf_protocol/include'),
        '-I', path.join(repoRoot, 'qlever/qlever_adapter/include'),
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

  it('materializes upstream IndexScan results through the injected physical index', async () => {
    expect(hasCxx(), 'c++ compiler is required for native physical index context bridge check').toBe(true);

    const root = await mkdtemp(path.join(os.tmpdir(), 'xpod-qlever-context-materialized-scan-'));
    try {
      const qleverSource = await writeMinimalQleverHeaders(root);
      const smoke = path.join(root, 'context_materialized_scan_smoke.cpp');
      const binary = path.join(root, 'context_materialized_scan_smoke');
      await writeFile(smoke, `
#include "XpodQleverPhysicalIndexScanContextBridge.hpp"

#include <array>
#include <optional>
#include <string>
#include <string_view>

struct ScanSpec {
  std::optional<Id> col0Id() const { return std::nullopt; }
  std::optional<Id> col1Id() const { return Id::fromBits(9999); }
  std::optional<Id> col2Id() const { return std::nullopt; }
};

struct FakeIri {
  std::string value;
  const std::string& toStringRepresentation() const { return value; }
};

struct FakeComponent {
  bool variable;
  FakeIri iri;
  bool isVariable() const { return variable; }
  bool isIri() const { return !variable; }
  const FakeIri& getIri() const { return iri; }
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
  int lookup_terms_calls;
  uint32_t last_needed_slots;
};

static xpod_rdf_status get_capabilities(
    void*,
    xpod_rdf_backend_capabilities* out_capabilities) {
  out_capabilities->supported_permutations = XPOD_RDF_PERM_CAP_SPOG;
  out_capabilities->features = 0;
  return XPOD_RDF_STATUS_OK;
}

static bool bytes_equal(xpod_rdf_bytes actual, const char* expected) {
  return std::string_view(actual.data, actual.size) == expected;
}

static xpod_rdf_status lookup_terms(
    void* user_data,
    const xpod_rdf_term* terms,
    size_t term_count,
    const xpod_rdf_snapshot*,
    xpod_rdf_term_key* out_keys,
    xpod_rdf_status* out_statuses) {
  auto* state = static_cast<BackendState*>(user_data);
  ++state->lookup_terms_calls;
  if (term_count != 1) return XPOD_RDF_STATUS_BACKEND_ERROR;
  if (terms[0].kind == XPOD_RDF_TERM_IRI &&
      bytes_equal(terms[0].value, "urn:p")) {
    out_keys[0] = 20;
    out_statuses[0] = XPOD_RDF_STATUS_OK;
    return XPOD_RDF_STATUS_OK;
  }
  return XPOD_RDF_STATUS_NOT_FOUND;
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
  if (!request->pattern.has_predicate || request->pattern.predicate != 20) return XPOD_RDF_STATUS_BACKEND_ERROR;
  if (request->needed_slots != (XPOD_RDF_SLOT_SUBJECT | XPOD_RDF_SLOT_OBJECT)) return XPOD_RDF_STATUS_BACKEND_ERROR;

  xpod_rdf_quad_key rows[2] = {
      {101, 20, 303, 404},
      {102, 20, 304, 404},
  };
  xpod_rdf_quad_batch batch = {};
  batch.rows = rows;
  batch.row_count = 2;
  return on_batch(callback_user_data, &batch);
}

int main() {
  BackendState state = {};
  xpod_rdf_backend_v1 raw_backend = {};
  raw_backend.abi_version = XPOD_RDF_PHYSICAL_BACKEND_ABI_VERSION;
  raw_backend.struct_size = sizeof(xpod_rdf_backend_v1);
  raw_backend.backend_user_data = &state;
  raw_backend.get_capabilities = get_capabilities;
  raw_backend.lookup_terms = lookup_terms;
  raw_backend.scan_permutation = scan_permutation;
  raw_backend.term_key_encoding = XPOD_RDF_TERM_KEY_ENCODING_QLEVER_VALUE_ID_BITS;
  xpod::rdf::PhysicalBackend physical(&raw_backend);

  xpod_qlever_query_request request = {};
  xpod::qlever::PlannerRequestContext planner_context{physical, &request, request.cancellation};
  planner_context.capabilities_status = physical.getCapabilities(planner_context.capabilities);

  QueryExecutionContext qec;
  qec.setXpodPhysicalIndex(xpod::qlever::XpodQleverPhysicalIndex(planner_context));

  ScanSpec spec;
  FakeComponent subject{true, {"?s"}};
  FakeComponent predicate{false, {"<urn:p>"}};
  FakeComponent object{true, {"?o"}};
  std::array<const FakeComponent* const, 3> permuted_triple{
      &subject, &predicate, &object};
  auto result = xpod::qlever::materializedScanFromQleverScanSpecAndBlocks(
      qec,
      Permutation::Enum::SPO,
      spec,
      permuted_triple,
      XPOD_RDF_SLOT_SUBJECT | XPOD_RDF_SLOT_OBJECT);
  if (result.status != XPOD_RDF_STATUS_OK) return 1;
  if (result.table.numColumns() != 2 || result.table.numRows() != 2) return 2;
  if (result.table(0, 0).getBits() != 101 || result.table(0, 1).getBits() != 303) return 3;
  if (result.table(1, 0).getBits() != 102 || result.table(1, 1).getBits() != 304) return 4;
  if (state.scan_calls != 1) return 5;
  if (state.last_needed_slots != (XPOD_RDF_SLOT_SUBJECT | XPOD_RDF_SLOT_OBJECT)) return 6;
  if (state.lookup_terms_calls != 1) return 7;
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
        '-I', path.join(repoRoot, 'qlever/rdf_protocol/include'),
        '-I', path.join(repoRoot, 'qlever/qlever_adapter/include'),
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

  it('treats missing IndexScan constants as supported empty physical scans', async () => {
    expect(hasCxx(), 'c++ compiler is required for native physical missing constant bridge check').toBe(true);

    const root = await mkdtemp(path.join(os.tmpdir(), 'xpod-qlever-context-empty-scan-'));
    try {
      const qleverSource = await writeMinimalQleverHeaders(root);
      const smoke = path.join(root, 'context_empty_scan_smoke.cpp');
      const binary = path.join(root, 'context_empty_scan_smoke');
      await writeFile(smoke, `
#include "XpodQleverPhysicalIndexScanContextBridge.hpp"

#include <array>
#include <optional>
#include <string>
#include <string_view>

struct ScanSpec {
  std::optional<Id> col0Id() const { return Id::fromBits(9999); }
  std::optional<Id> col1Id() const { return std::nullopt; }
  std::optional<Id> col2Id() const { return std::nullopt; }
};

struct FakeIri {
  std::string value;
  const std::string& toStringRepresentation() const { return value; }
};

struct FakeComponent {
  bool variable;
  FakeIri iri;
  bool isVariable() const { return variable; }
  bool isIri() const { return !variable; }
  const FakeIri& getIri() const { return iri; }
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
  int count_calls;
  int estimate_calls;
  int lookup_terms_calls;
};

static xpod_rdf_status get_capabilities(
    void*,
    xpod_rdf_backend_capabilities* out_capabilities) {
  out_capabilities->supported_permutations = XPOD_RDF_PERM_CAP_SPOG;
  out_capabilities->features = 0;
  return XPOD_RDF_STATUS_OK;
}

static bool bytes_equal(xpod_rdf_bytes actual, const char* expected) {
  return std::string_view(actual.data, actual.size) == expected;
}

static xpod_rdf_status lookup_terms(
    void* user_data,
    const xpod_rdf_term* terms,
    size_t term_count,
    const xpod_rdf_snapshot*,
    xpod_rdf_term_key* out_keys,
    xpod_rdf_status* out_statuses) {
  auto* state = static_cast<BackendState*>(user_data);
  ++state->lookup_terms_calls;
  if (term_count != 1) return XPOD_RDF_STATUS_BACKEND_ERROR;
  if (terms[0].kind == XPOD_RDF_TERM_IRI &&
      bytes_equal(terms[0].value, "urn:missing")) {
    out_keys[0] = 0;
    out_statuses[0] = XPOD_RDF_STATUS_NOT_FOUND;
    return XPOD_RDF_STATUS_OK;
  }
  return XPOD_RDF_STATUS_BACKEND_ERROR;
}

static xpod_rdf_status scan_permutation(
    void* user_data,
    const xpod_rdf_scan_request*,
    xpod_rdf_quad_batch_callback,
    void*) {
  ++static_cast<BackendState*>(user_data)->scan_calls;
  return XPOD_RDF_STATUS_BACKEND_ERROR;
}

static xpod_rdf_status count_scan(
    void* user_data,
    const xpod_rdf_scan_request*,
    xpod_rdf_count_result*) {
  ++static_cast<BackendState*>(user_data)->count_calls;
  return XPOD_RDF_STATUS_BACKEND_ERROR;
}

static xpod_rdf_status estimate_scan(
    void* user_data,
    const xpod_rdf_scan_request*,
    xpod_rdf_estimate*) {
  ++static_cast<BackendState*>(user_data)->estimate_calls;
  return XPOD_RDF_STATUS_BACKEND_ERROR;
}

int main() {
  BackendState state = {};
  xpod_rdf_backend_v1 raw_backend = {};
  raw_backend.abi_version = XPOD_RDF_PHYSICAL_BACKEND_ABI_VERSION;
  raw_backend.struct_size = sizeof(xpod_rdf_backend_v1);
  raw_backend.backend_user_data = &state;
  raw_backend.get_capabilities = get_capabilities;
  raw_backend.lookup_terms = lookup_terms;
  raw_backend.scan_permutation = scan_permutation;
  raw_backend.count_scan = count_scan;
  raw_backend.estimate_scan = estimate_scan;
  raw_backend.term_key_encoding = XPOD_RDF_TERM_KEY_ENCODING_QLEVER_VALUE_ID_BITS;
  xpod::rdf::PhysicalBackend physical(&raw_backend);

  xpod_qlever_query_request request = {};
  xpod::qlever::PlannerRequestContext planner_context{physical, &request, request.cancellation};
  planner_context.capabilities_status = physical.getCapabilities(planner_context.capabilities);

  QueryExecutionContext qec;
  qec.setXpodPhysicalIndex(xpod::qlever::XpodQleverPhysicalIndex(planner_context));

  ScanSpec spec;
  FakeComponent subject{false, {"<urn:missing>"}};
  FakeComponent predicate{true, {"?p"}};
  FakeComponent object{true, {"?o"}};
  std::array<const FakeComponent* const, 3> permuted_triple{
      &subject, &predicate, &object};

  if (!xpod::qlever::canUsePhysicalScanSpecAndBlocks(
          qec, Permutation::Enum::SPO, spec, permuted_triple)) return 1;

  auto scan = xpod::qlever::materializedScanFromQleverScanSpecAndBlocks(
      qec,
      Permutation::Enum::SPO,
      spec,
      permuted_triple,
      XPOD_RDF_SLOT_PREDICATE | XPOD_RDF_SLOT_OBJECT);
  if (scan.status != XPOD_RDF_STATUS_OK) return 2;
  if (scan.table.numColumns() != 2 || scan.table.numRows() != 0) return 3;

  auto size = xpod::qlever::sizeEstimateFromQleverScanSpecAndBlocks(
      qec,
      Permutation::Enum::SPO,
      spec,
      permuted_triple,
      XPOD_RDF_SLOT_PREDICATE | XPOD_RDF_SLOT_OBJECT);
  if (size.status != XPOD_RDF_STATUS_OK || !size.exact || size.rows != 0) return 4;

  auto exact = xpod::qlever::exactSizeFromQleverScanSpecAndBlocks(
      qec,
      Permutation::Enum::SPO,
      spec,
      permuted_triple,
      XPOD_RDF_SLOT_PREDICATE | XPOD_RDF_SLOT_OBJECT);
  if (exact.status != XPOD_RDF_STATUS_OK || exact.rows != 0) return 5;

  if (state.scan_calls != 0) return 6;
  if (state.count_calls != 0) return 7;
  if (state.estimate_calls != 0) return 8;
  if (state.lookup_terms_calls != 4) return 9;
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
        '-I', path.join(repoRoot, 'qlever/rdf_protocol/include'),
        '-I', path.join(repoRoot, 'qlever/qlever_adapter/include'),
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

  it('resolves literal IndexScan constants through the injected physical dictionary', async () => {
    expect(hasCxx(), 'c++ compiler is required for native physical literal constant bridge check').toBe(true);

    const root = await mkdtemp(path.join(os.tmpdir(), 'xpod-qlever-context-literal-scan-'));
    try {
      const qleverSource = await writeMinimalQleverHeaders(root);
      const smoke = path.join(root, 'context_literal_scan_smoke.cpp');
      const binary = path.join(root, 'context_literal_scan_smoke');
      await writeFile(smoke, `
#include "XpodQleverPhysicalIndexScanContextBridge.hpp"

#include <array>
#include <optional>
#include <string>
#include <string_view>

struct ScanSpec {
  std::optional<Id> col0Id() const { return std::nullopt; }
  std::optional<Id> col1Id() const { return std::nullopt; }
  std::optional<Id> col2Id() const { return Id::fromBits(8888); }
};

struct FakeIri {
  std::string value;
  const std::string& toStringRepresentation() const { return value; }
};

struct FakeLiteral {
  std::string value;
  const std::string& getContent() const { return value; }
  bool hasDatatype() const { return false; }
  bool hasLanguageTag() const { return false; }
};

struct FakeComponent {
  enum class Kind { Variable, Iri, Literal };
  Kind kind;
  FakeIri iri;
  FakeLiteral literal;
  bool isVariable() const { return kind == Kind::Variable; }
  bool isIri() const { return kind == Kind::Iri; }
  bool isLiteral() const { return kind == Kind::Literal; }
  const FakeIri& getIri() const { return iri; }
  const FakeLiteral& getLiteral() const { return literal; }
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
  int estimate_calls;
  int lookup_terms_calls;
};

static xpod_rdf_status get_capabilities(
    void*,
    xpod_rdf_backend_capabilities* out_capabilities) {
  out_capabilities->supported_permutations = XPOD_RDF_PERM_CAP_SPOG;
  out_capabilities->features = 0;
  return XPOD_RDF_STATUS_OK;
}

static bool bytes_equal(xpod_rdf_bytes actual, const char* expected) {
  return std::string_view(actual.data, actual.size) == expected;
}

static xpod_rdf_status lookup_terms(
    void* user_data,
    const xpod_rdf_term* terms,
    size_t term_count,
    const xpod_rdf_snapshot*,
    xpod_rdf_term_key* out_keys,
    xpod_rdf_status* out_statuses) {
  auto* state = static_cast<BackendState*>(user_data);
  ++state->lookup_terms_calls;
  if (term_count != 1) return XPOD_RDF_STATUS_BACKEND_ERROR;
  if (terms[0].kind != XPOD_RDF_TERM_LITERAL) return XPOD_RDF_STATUS_BACKEND_ERROR;
  if (!bytes_equal(terms[0].value, "literal-value")) return XPOD_RDF_STATUS_BACKEND_ERROR;
  if (terms[0].datatype_iri.size != 0 || terms[0].language.size != 0) {
    return XPOD_RDF_STATUS_BACKEND_ERROR;
  }
  out_keys[0] = 80;
  out_statuses[0] = XPOD_RDF_STATUS_OK;
  return XPOD_RDF_STATUS_OK;
}

static xpod_rdf_status estimate_scan(
    void* user_data,
    const xpod_rdf_scan_request* request,
    xpod_rdf_estimate* out_estimate) {
  auto* state = static_cast<BackendState*>(user_data);
  ++state->estimate_calls;
  if (request->permutation != XPOD_RDF_PERM_SPOG) return XPOD_RDF_STATUS_BACKEND_ERROR;
  if (!request->pattern.has_object || request->pattern.object != 80) return XPOD_RDF_STATUS_BACKEND_ERROR;
  out_estimate->rows = 1;
  out_estimate->confidence = XPOD_RDF_ESTIMATE_EXACT;
  return XPOD_RDF_STATUS_OK;
}

int main() {
  BackendState state = {};
  xpod_rdf_backend_v1 raw_backend = {};
  raw_backend.abi_version = XPOD_RDF_PHYSICAL_BACKEND_ABI_VERSION;
  raw_backend.struct_size = sizeof(xpod_rdf_backend_v1);
  raw_backend.backend_user_data = &state;
  raw_backend.get_capabilities = get_capabilities;
  raw_backend.lookup_terms = lookup_terms;
  raw_backend.estimate_scan = estimate_scan;
  raw_backend.term_key_encoding = XPOD_RDF_TERM_KEY_ENCODING_QLEVER_VALUE_ID_BITS;
  xpod::rdf::PhysicalBackend physical(&raw_backend);

  xpod_qlever_query_request request = {};
  xpod::qlever::PlannerRequestContext planner_context{physical, &request, request.cancellation};
  planner_context.capabilities_status = physical.getCapabilities(planner_context.capabilities);

  QueryExecutionContext qec;
  qec.setXpodPhysicalIndex(xpod::qlever::XpodQleverPhysicalIndex(planner_context));

  ScanSpec spec;
  CompressedRelationReader::ScanSpecAndBlocks scan_spec_and_blocks = {};
  scan_spec_and_blocks.scanSpec_.col2 = Id::fromBits(8888);
  FakeComponent subject{FakeComponent::Kind::Variable, {"?s"}, {""}};
  FakeComponent predicate{FakeComponent::Kind::Variable, {"?p"}, {""}};
  FakeComponent object{FakeComponent::Kind::Literal, {""}, {"literal-value"}};
  std::array<const FakeComponent* const, 3> permuted_triple{
      &subject, &predicate, &object};

  auto estimate = xpod::qlever::sizeEstimateFromQleverScanSpecAndBlocks(
      qec,
      Permutation::Enum::SPO,
      scan_spec_and_blocks,
      permuted_triple,
      XPOD_RDF_SLOT_SUBJECT);
  if (estimate.status != XPOD_RDF_STATUS_OK) return 1;
  if (!estimate.exact || estimate.rows != 1) return 2;
  if (state.lookup_terms_calls != 1) return 3;
  if (state.estimate_calls != 1) return 4;
  (void)spec;
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
        '-I', path.join(repoRoot, 'qlever/rdf_protocol/include'),
        '-I', path.join(repoRoot, 'qlever/qlever_adapter/include'),
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
        '-I', path.join(repoRoot, 'qlever/rdf_protocol/include'),
        '-I', path.join(repoRoot, 'qlever/qlever_adapter/include'),
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
  if (request->limit != 1 || request->offset != 2) return XPOD_RDF_STATUS_BACKEND_ERROR;
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
      true,
      1,
      2);
  if (broad.status != XPOD_RDF_STATUS_OK) return 1;
  auto table = broad.blocks.get();
  if (!table.has_value()) return 2;
  if (table->numColumns() != 2 || table->numRows() != 1) return 3;
  if ((*table)(0, 0).getBits() != 101 || (*table)(0, 1).getBits() != 303) return 4;
  if (broad.blocks.get().has_value()) return 5;
  if (state.scan_calls != 1 || !state.saw_unrestricted_scan) return 6;
  std::optional<std::vector<CompressedBlockMetadata>> selected_empty_blocks =
      std::vector<CompressedBlockMetadata>{};

  auto selected_empty_unprefiltered =
      xpod::qlever::lazyScanRangeFromQleverScanSpecAndBlocks(
      qec,
      Permutation::Enum::SPO,
      scan_spec_and_blocks,
      selected_empty_blocks,
      XPOD_RDF_SLOT_SUBJECT | XPOD_RDF_SLOT_OBJECT,
      xpod_rdf_bytes{},
      true,
      1,
      2);
  if (selected_empty_unprefiltered.status != XPOD_RDF_STATUS_OK) return 7;
  auto selected_unprefiltered_table = selected_empty_unprefiltered.blocks.get();
  if (!selected_unprefiltered_table.has_value()) return 8;
  if (selected_unprefiltered_table->numColumns() != 2 ||
      selected_unprefiltered_table->numRows() != 1) return 9;
  if ((*selected_unprefiltered_table)(0, 0).getBits() != 101 ||
      (*selected_unprefiltered_table)(0, 1).getBits() != 303) return 10;
  if (selected_empty_unprefiltered.blocks.get().has_value()) return 11;
  if (state.scan_calls != 2) return 12;

  auto selected_empty_prefiltered =
      xpod::qlever::lazyScanRangeFromQleverScanSpecAndBlocks(
      qec,
      Permutation::Enum::SPO,
      scan_spec_and_blocks,
      selected_empty_blocks,
      XPOD_RDF_SLOT_SUBJECT | XPOD_RDF_SLOT_OBJECT,
      xpod_rdf_bytes{},
      false);
  if (selected_empty_prefiltered.status != XPOD_RDF_STATUS_OK) return 13;
  if (selected_empty_prefiltered.blocks.get().has_value()) return 14;
  if (state.scan_calls != 2) return 15;

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
        '-I', path.join(repoRoot, 'qlever/rdf_protocol/include'),
        '-I', path.join(repoRoot, 'qlever/qlever_adapter/include'),
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

  it('bridges physical block metadata into QLever metadata for prefiltered IndexScan paths', async () => {
    expect(hasCxx(), 'c++ compiler is required for native physical index context bridge check').toBe(true);

    const root = await mkdtemp(path.join(os.tmpdir(), 'xpod-qlever-context-block-metadata-'));
    try {
      const qleverSource = await writeMinimalQleverHeaders(root);
      const smoke = path.join(root, 'context_block_metadata_smoke.cpp');
      const binary = path.join(root, 'context_block_metadata_smoke');
      await writeFile(smoke, `
#include "XpodQleverPhysicalIndexScanContextBridge.hpp"

#include <array>
#include <optional>
#include <string>
#include <string_view>

struct FakeIri {
  std::string value;
  const std::string& toStringRepresentation() const { return value; }
};

struct FakeComponent {
  bool variable;
  FakeIri iri;
  bool isVariable() const { return variable; }
  bool isIri() const { return !variable; }
  const FakeIri& getIri() const { return iri; }
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
  int metadata_calls;
  int lookup_terms_calls;
  uint32_t last_needed_slots;
};

static xpod_rdf_status get_capabilities(
    void*,
    xpod_rdf_backend_capabilities* out_capabilities) {
  out_capabilities->supported_permutations = XPOD_RDF_PERM_CAP_SPOG;
  out_capabilities->features = XPOD_RDF_BACKEND_FEATURE_BLOCK_METADATA;
  return XPOD_RDF_STATUS_OK;
}

static bool bytes_equal(xpod_rdf_bytes actual, const char* expected) {
  return std::string_view(actual.data, actual.size) == expected;
}

static xpod_rdf_status lookup_terms(
    void* user_data,
    const xpod_rdf_term* terms,
    size_t term_count,
    const xpod_rdf_snapshot*,
    xpod_rdf_term_key* out_keys,
    xpod_rdf_status* out_statuses) {
  auto* state = static_cast<BackendState*>(user_data);
  ++state->lookup_terms_calls;
  if (term_count != 1) return XPOD_RDF_STATUS_BACKEND_ERROR;
  if (terms[0].kind == XPOD_RDF_TERM_IRI &&
      bytes_equal(terms[0].value, "urn:p")) {
    out_keys[0] = 20;
    out_statuses[0] = XPOD_RDF_STATUS_OK;
    return XPOD_RDF_STATUS_OK;
  }
  return XPOD_RDF_STATUS_NOT_FOUND;
}

static xpod_rdf_status scan_block_metadata(
    void* user_data,
    const xpod_rdf_scan_request* request,
    xpod_rdf_scan_block_metadata_batch_callback on_batch,
    void* callback_user_data) {
  auto* state = static_cast<BackendState*>(user_data);
  ++state->metadata_calls;
  state->last_needed_slots = request->needed_slots;
  if (request->permutation != XPOD_RDF_PERM_SPOG) return XPOD_RDF_STATUS_BACKEND_ERROR;
  if (!request->pattern.has_predicate || request->pattern.predicate != 20) return XPOD_RDF_STATUS_BACKEND_ERROR;

  xpod_rdf_scan_block_metadata rows[2] = {};
  rows[0].block_id = 7;
  rows[0].row_count = 2;
  rows[0].first_quad = {101, 20, 301, 401};
  rows[0].last_quad = {102, 20, 302, 402};
  rows[1].block_id = 8;
  rows[1].row_count = 3;
  rows[1].first_quad = {103, 20, 303, 403};
  rows[1].last_quad = {104, 20, 304, 404};

  static const char version[] = "v1";
  xpod_rdf_scan_block_metadata_batch batch = {};
  batch.rows = rows;
  batch.row_count = 2;
  batch.total_blocks = 2;
  batch.metadata_version = {version, 2};
  return on_batch(callback_user_data, &batch);
}

int main() {
  BackendState state = {};
  xpod_rdf_backend_v1 raw_backend = {};
  raw_backend.abi_version = XPOD_RDF_PHYSICAL_BACKEND_ABI_VERSION;
  raw_backend.struct_size = sizeof(xpod_rdf_backend_v1);
  raw_backend.backend_user_data = &state;
  raw_backend.get_capabilities = get_capabilities;
  raw_backend.lookup_terms = lookup_terms;
  raw_backend.scan_block_metadata = scan_block_metadata;
  raw_backend.term_key_encoding = XPOD_RDF_TERM_KEY_ENCODING_QLEVER_VALUE_ID_BITS;
  xpod::rdf::PhysicalBackend physical(&raw_backend);

  xpod_qlever_query_request request = {};
  xpod::qlever::PlannerRequestContext planner_context{physical, &request, request.cancellation};
  planner_context.capabilities_status = physical.getCapabilities(planner_context.capabilities);

  QueryExecutionContext qec;
  qec.setXpodPhysicalIndex(xpod::qlever::XpodQleverPhysicalIndex(planner_context));

  CompressedRelationReader::ScanSpecAndBlocks scan_spec_and_blocks = {};
  scan_spec_and_blocks.scanSpec_.col1 = Id::fromBits(20);
  FakeComponent subject{true, {"?s"}};
  FakeComponent predicate{false, {"<urn:p>"}};
  FakeComponent object{true, {"?o"}};
  std::array<const FakeComponent* const, 3> permuted_triple{
      &subject, &predicate, &object};
  std::vector<CompressedBlockMetadata> storage;
  auto result = xpod::qlever::metadataForScanFromQleverScanSpecAndBlocks(
      qec,
      Permutation::Enum::SPO,
      scan_spec_and_blocks,
      permuted_triple,
      storage,
      XPOD_RDF_SLOT_SUBJECT | XPOD_RDF_SLOT_OBJECT);

  if (result.status != XPOD_RDF_STATUS_OK) return 1;
  if (!result.metadata.has_value()) return 2;
  if (storage.size() != 2) return 3;
  if (result.metadata->sizeBlockMetadata_ != 2) return 4;
  if (result.metadata->firstAndLastTriple_.firstTriple_.col0Id_.getBits() != 101) return 5;
  if (result.metadata->firstAndLastTriple_.lastTriple_.col2Id_.getBits() != 304) return 6;
  if (storage[1].blockIndex_ != 8 || storage[1].numRows_ != 3) return 7;
  if (state.metadata_calls != 1) return 8;
  if (state.last_needed_slots != (XPOD_RDF_SLOT_SUBJECT | XPOD_RDF_SLOT_OBJECT)) return 9;
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
        '-I', path.join(repoRoot, 'qlever/rdf_protocol/include'),
        '-I', path.join(repoRoot, 'qlever/qlever_adapter/include'),
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
        '-I', path.join(repoRoot, 'qlever/rdf_protocol/include'),
        '-I', path.join(repoRoot, 'qlever/qlever_adapter/include'),
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
