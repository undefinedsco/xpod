import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'bun:test';
import { fakeCancellationHandleHeader, fakeEncodedIriManagerHeader, fakeJoinHeader, fakeParsedQueryHeader, fakeRdfParserHeader, fakeThrowingSparqlParserHeader, fakeSparqlTripleHeader, fakeTokenizerCtreHeader } from './qleverFakeHeaders';

const repoRoot = path.resolve(__dirname, '../..');
const adapterSource = path.join(repoRoot, 'qlever/qlever_adapter/src/xpod_qlever_adapter.cpp');
const executorSource = path.join(repoRoot, 'qlever/qlever_adapter/src/XpodQleverExecutor.cpp');
const bridgeSource = path.join(repoRoot, 'qlever/qlever_adapter/src/XpodQleverBridge.cpp');

function hasCxx(): boolean {
  try {
    execFileSync('/usr/bin/env', ['c++', '--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

const executorIdTableHeader = `
#pragma once
#include <cstddef>
#include <vector>
#include "global/Id.h"
#include "util/AllocatorWithLimit.h"
class IdTable {
 public:
  explicit IdTable(size_t width) : width_(width) {}
  IdTable(size_t width, ad_utility::AllocatorWithLimit<Id>) : width_(width) {}
  size_t numColumns() const { return width_; }
  size_t numRows() const { return rows_.size(); }
  bool empty() const { return rows_.empty(); }
  void push_back(const std::vector<Id>& row) { rows_.push_back(row); }
  const Id& operator()(size_t row, size_t column) const { return rows_[row][column]; }
 private:
  size_t width_;
  std::vector<std::vector<Id>> rows_;
};
`;

const executorResultHeader = `
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
    auto begin() { return chunks_.begin(); }
    auto end() { return chunks_.end(); }
   private:
    std::vector<IdTableVocabPair> chunks_;
    size_t offset_ = 0;
  };

  Result(IdTable table, std::vector<ColumnIndex> sortedBy, LocalVocab&& localVocab)
      : materialized_(std::move(table)), sortedBy_(std::move(sortedBy)),
        sharedLocalVocab_(std::make_shared<LocalVocab>(std::move(localVocab))) {}
  Result(LazyResult lazy, std::vector<ColumnIndex> sortedBy)
      : lazy_(std::move(lazy)), sortedBy_(std::move(sortedBy)) {}
  Result(
      IdTable table,
      std::vector<ColumnIndex> sortedBy,
      std::shared_ptr<const LocalVocab> localVocab)
      : materialized_(std::move(table)), sortedBy_(std::move(sortedBy)),
        sharedLocalVocab_(std::move(localVocab)) {}

  bool isFullyMaterialized() const { return materialized_.has_value(); }
  const IdTable& idTable() const { return *materialized_; }
  LazyResult idTables() const { return std::move(*lazy_); }
  const LocalVocab& localVocab() const { return *sharedLocalVocab_; }
  std::shared_ptr<const LocalVocab> getSharedLocalVocab() const {
    return sharedLocalVocab_;
  }
  const std::vector<ColumnIndex>& sortedBy() const { return sortedBy_; }
 private:
  mutable std::optional<LazyResult> lazy_;
  std::optional<IdTable> materialized_;
  std::vector<ColumnIndex> sortedBy_;
  std::shared_ptr<const LocalVocab> sharedLocalVocab_ =
      std::make_shared<LocalVocab>();
};
`;

const executorQueryExecutionContextHeader = `
#pragma once
#include <functional>
#include <memory>
#include <string>
#include "XpodQleverPhysicalIndex.hpp"
#include "engine/MaterializedViews.h"
#include "engine/NamedResultCache.h"
#include "engine/SortPerformanceEstimator.h"
#include "index/Index.h"
#include "util/AllocatorWithLimit.h"
extern "C" void xpod_test_mark_qec_constructed(bool disable_caching);
class QueryResultCache {
 public:
  void clearAll() {}
};
class QueryExecutionContext {
 public:
  enum struct DisableCaching { True, False, FromRuntimeParameter };
  QueryExecutionContext() = delete;
  QueryExecutionContext(
      std::shared_ptr<const Index> index,
      QueryResultCache*,
      ad_utility::AllocatorWithLimit<Id> allocator,
      SortPerformanceEstimator,
      NamedResultCache*,
      std::shared_ptr<MaterializedViewsManager>,
      std::function<void(std::string)> = [](std::string) {},
      bool = false,
      bool = false,
      DisableCaching disable_caching = DisableCaching::FromRuntimeParameter)
      : index_owner_(std::move(index)), allocator_(allocator),
        disable_caching_(disable_caching == DisableCaching::True) {
    xpod_test_mark_qec_constructed(disable_caching_);
  }
  bool disableCaching() const { return disable_caching_; }
  const ad_utility::AllocatorWithLimit<Id>& getAllocator() const {
    return allocator_;
  }
  const Index& getIndex() const { return *index_owner_; }
  const LocalVocabContext& getLocalVocabContext() const {
    return local_vocab_context_;
  }
  void clearCacheUnpinnedOnly() {}
  void setXpodPhysicalIndex(std::shared_ptr<const xpod::qlever::XpodQleverPhysicalIndex> index) {
    index_ = std::move(index);
  }
  const xpod::qlever::XpodQleverPhysicalIndex* xpodPhysicalIndex() const {
    return index_.get();
  }
 private:
  std::shared_ptr<const Index> index_owner_;
  ad_utility::AllocatorWithLimit<Id> allocator_;
  bool disable_caching_;
  std::shared_ptr<const xpod::qlever::XpodQleverPhysicalIndex> index_;
  LocalVocabContext local_vocab_context_;
};
`;

const executorOperationHeader = `
#pragma once
#include <cstdint>
#include <map>
#include <memory>
#include <string>
#include <utility>
#include <variant>
#include <vector>
#include "engine/QueryExecutionContext.h"
#include "engine/Result.h"
#include "global/Id.h"
#include "parser/ParsedQuery.h"
#include "util/Exception.h"
class QueryExecutionTree;
class ExternalValues;
enum class ComputationMode { FULLY_MATERIALIZED, ONLY_IF_CACHED, LAZY_IF_SUPPORTED };
struct ColumnIndexAndTypeInfo {
  enum struct UndefStatus { AlwaysDefined, PossiblyUndefined };
  ColumnIndex columnIndex_;
  UndefStatus mightContainUndef_ = UndefStatus::AlwaysDefined;
};
using VariableToColumnMap = std::map<Variable, ColumnIndexAndTypeInfo>;
inline ColumnIndexAndTypeInfo makeAlwaysDefinedColumn(ColumnIndex column) {
  return {column, ColumnIndexAndTypeInfo::UndefStatus::AlwaysDefined};
}
class Operation {
 public:
  explicit Operation(QueryExecutionContext* qec = nullptr) : qec_(qec) {}
  virtual ~Operation() = default;
  virtual size_t getCostEstimate() { return 0; }
  virtual std::string getDescriptor() const { return ""; }
  virtual size_t getResultWidth() const { return 0; }
  virtual float getMultiplicity(size_t) { return 1; }
  virtual bool knownEmptyResult() { return false; }
  const std::vector<ColumnIndex>& getResultSortedOn() const {
    sorted_cache_ = resultSortedOn();
    return sorted_cache_;
  }
  virtual std::vector<QueryExecutionTree*> getChildren() { return {}; }
  std::vector<const QueryExecutionTree*> getChildren() const { return {}; }
  virtual VariableToColumnMap computeVariableToColumnMap() const { return {}; }
  virtual const VariableToColumnMap& getExternallyVisibleVariableColumns() const {
    variable_columns_cache_ = computeVariableToColumnMap();
    return variable_columns_cache_;
  }
  virtual void getExternalValues(std::vector<ExternalValues*>&) {}
  uint64_t getSizeEstimate() { return getSizeEstimateBeforeLimit(); }
  bool canResultBeCached() const { return canResultBeCachedImpl(); }
  std::unique_ptr<Operation> clone() const { return cloneImpl(); }
  QueryExecutionContext* getExecutionContext() const { return qec_; }
  const ad_utility::AllocatorWithLimit<Id>& allocator() const {
    return qec_->getAllocator();
  }
  std::shared_ptr<const Result> getResult(bool, ComputationMode mode) {
    try {
      return std::make_shared<Result>(
          computeResult(mode == ComputationMode::LAZY_IF_SUPPORTED));
    } catch (const ad_utility::AbortException&) {
      throw;
    } catch (const std::exception& error) {
      throw ad_utility::AbortException(error);
    }
  }
 protected:
  virtual uint64_t getSizeEstimateBeforeLimit() { return 0; }
  virtual std::vector<ColumnIndex> resultSortedOn() const { return {}; }
  virtual Result computeResult(bool) { return {IdTable(getResultWidth()), resultSortedOn(), LocalVocab{}}; }
  QueryExecutionContext* qec_;
 private:
  virtual std::string getCacheKeyImpl() const { return {}; }
  virtual bool canResultBeCachedImpl() const { return true; }
  virtual std::unique_ptr<Operation> cloneImpl() const { return nullptr; }
  mutable std::vector<ColumnIndex> sorted_cache_;
  mutable VariableToColumnMap variable_columns_cache_;
};
`;

const executorQueryExecutionTreeHeader = `
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
  bool& isRoot() { return is_root_; }
  std::shared_ptr<Operation> getRootOperation() const { return root_; }
  const std::string& getDescriptor() const { return descriptor_; }
  size_t getResultWidth() const { return root_ == nullptr ? 0 : root_->getResultWidth(); }
  const std::vector<ColumnIndex>& resultSortedOn() const { return root_->getResultSortedOn(); }
  std::shared_ptr<const Result> getResult(bool requestLaziness = false) const {
    return root_->getResult(true, requestLaziness ? ComputationMode::LAZY_IF_SUPPORTED
                                                 : ComputationMode::FULLY_MATERIALIZED);
  }
 private:
  std::shared_ptr<Operation> root_;
  std::string descriptor_;
  bool is_root_ = false;
};
`;

const executorCompressedRelationHeader = `
#pragma once
#include <memory>
#include <optional>
#include <utility>
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
    ScanSpecAndBlocks() = default;
    ScanSpecAndBlocks(
        ScanSpecification scanSpec,
        const std::vector<std::vector<CompressedBlockMetadata>>& ranges)
        : scanSpec_(std::move(scanSpec)) {
      for (const auto& range : ranges) {
        blockMetadata_.insert(blockMetadata_.end(), range.begin(), range.end());
      }
    }
    const std::vector<CompressedBlockMetadata>& getBlockMetadataView() const { return blockMetadata_; }
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
  using IdTableGeneratorInputRange = ad_utility::InputRangeTypeErased<IdTable, LazyScanMetadata>;
};
using CompressedBlockMetadata = CompressedRelationReader::CompressedBlockMetadata;
using BlockMetadataSpan = std::vector<CompressedBlockMetadata>;
using BlockMetadataRange = std::vector<CompressedBlockMetadata>;
using BlockMetadataRanges = std::vector<BlockMetadataRange>;
`;

const executorIndexScanHeader = `
#pragma once
#include <optional>
#include <stdexcept>
#include <string>
#include <utility>
#include <vector>
#include "XpodQleverPhysicalIndexScanContextBridge.hpp"
#include "engine/Operation.h"
#include "index/CompressedRelation.h"
#include "index/Permutation.h"
#include "parser/SparqlTriple.h"
extern "C" bool xpod_test_native_transform_filter_enabled();
class GraphFilter {
 public:
  struct AllTag {};
  using FilterType =
      std::variant<AllTag, TripleComponent, std::vector<TripleComponent>>;
  bool areAllGraphsAllowed() const { return true; }
  const FilterType& xpodPhysicalFilterType() const { return filter_; }
 private:
  FilterType filter_{AllTag{}};
};
class IndexScan final : public Operation {
 public:
  explicit IndexScan(QueryExecutionContext* qec = nullptr)
      : Operation(qec),
        subject_(Variable{"?s"}),
        predicate_(Variable{"?p"}),
        object_(Variable{"?o"}),
        permutation_(Permutation::Enum::SPO),
        descriptor_("IndexScan SPO ?s ?p ?o"),
        result_width_(3),
        sorted_({0}) {
    CompressedRelationReader::CompressedBlockMetadata::PermutedTriple triple = {
        Id::fromBits(10), Id::fromBits(20), Id::fromBits(30), Id::fromBits(40)};
    scan_spec_and_blocks_.blockMetadata_.push_back({7, 2, triple, triple});
  }
  IndexScan(QueryExecutionContext* qec, bool numeric_predicate)
      : Operation(qec),
        subject_(Variable{"?s"}),
        predicate_(numeric_predicate
                       ? TripleComponent{TripleComponent::Iri{"<urn:numeric>"}}
                       : TripleComponent{Variable{"?p"}}),
        object_(Variable{"?o"}),
        permutation_(numeric_predicate ? Permutation::Enum::POS
                                       : Permutation::Enum::SPO),
        descriptor_(numeric_predicate
                        ? "IndexScan POS ?s <urn:numeric> ?o"
                        : "IndexScan SPO ?s ?p ?o"),
        result_width_(numeric_predicate ? 2 : 3),
        sorted_(numeric_predicate ? std::vector<ColumnIndex>{1}
                                  : std::vector<ColumnIndex>{0}) {
    CompressedRelationReader::CompressedBlockMetadata::PermutedTriple triple = {
        Id::fromBits(10), Id::fromBits(numeric_predicate ? 90 : 20),
        Id::fromBits(numeric_predicate ? 81 : 30), Id::fromBits(40)};
    scan_spec_and_blocks_.blockMetadata_.push_back({7, 2, triple, triple});
  }
  const TripleComponent& subject() const { return subject_; }
  const TripleComponent& predicate() const { return predicate_; }
  const TripleComponent& object() const { return object_; }
  const Permutation& permutation() const { return permutation_; }
  const std::vector<ColumnIndex>& additionalColumns() const { return additional_columns_; }
  const std::vector<Variable>& additionalVariables() const { return additional_variables_; }
  const GraphFilter& graphsToFilter() const { return graph_filter_; }
  std::string getDescriptor() const override { return descriptor_; }
  size_t getResultWidth() const override { return result_width_; }
  CompressedRelationReader::IdTableGeneratorInputRange getLazyScan(
      std::optional<std::vector<CompressedRelationReader::CompressedBlockMetadata>> blocks) const {
    auto result = xpod::qlever::lazyScanRangeFromQleverScanSpecAndBlocks(
        *qec_, permutation_.permutation(), scan_spec_and_blocks_, std::move(blocks));
    return std::move(result.blocks);
  }
 protected:
  std::vector<ColumnIndex> resultSortedOn() const override { return sorted_; }
  Result computeResult(bool requestLaziness) override {
    if (xpod_test_native_transform_filter_enabled()) {
      IdTable table(result_width_);
      if (result_width_ == 3) {
        table.push_back(
            {Id::fromBits(1010), Id::fromBits(1020), Id::fromBits(1030)});
      } else {
        table.push_back({Id::fromBits(1010), Id::fromBits(1030)});
      }
      return {std::move(table), sorted_, LocalVocab{}};
    }
    if (!requestLaziness) {
      IdTable table(result_width_);
      table.push_back({Id::fromBits(999), Id::fromBits(999), Id::fromBits(999)});
      return {std::move(table), sorted_, LocalVocab{}};
    }
    std::vector<Result::IdTableVocabPair> chunks;
    auto range = getLazyScan(std::nullopt);
    while (auto table = range.get()) {
      chunks.push_back({std::move(*table), LocalVocab{}});
    }
    return {Result::LazyResult{std::move(chunks)}, sorted_};
  }
 private:
  TripleComponent subject_;
  TripleComponent predicate_;
  TripleComponent object_;
  Permutation permutation_;
  std::string descriptor_;
  size_t result_width_;
  std::vector<ColumnIndex> sorted_;
  std::vector<ColumnIndex> additional_columns_;
  std::vector<Variable> additional_variables_;
  GraphFilter graph_filter_;
  CompressedRelationReader::ScanSpecAndBlocks scan_spec_and_blocks_;
};
`;

const executorParsedQueryHeader = fakeParsedQueryHeader
  .replace(
    `struct LimitOffsetClause {
  bool isUnconstrained() const { return true; }
  size_t limitOrDefault() const { return 0; }
  size_t _offset = 0;
};`,
    `struct LimitOffsetClause {
  bool isUnconstrained() const { return !constrained_; }
  size_t limitOrDefault() const { return limit_; }
  bool constrained_ = false;
  size_t limit_ = 0;
  size_t _offset = 0;
};`,
  )
  .replace(
    'explicit Variable(std::string name) : name_(std::move(name)) {}',
    `explicit Variable(std::string name) : name_(std::move(name)) {
    if (!name_.empty() && name_.front() == static_cast<char>(36)) {
      name_.front() = '?';
    }
  }`,
  )
  .replace(
    'const std::string& name() const { return name_; }',
    `const std::string& name() const { return name_; }
  friend bool operator<(const Variable& left, const Variable& right) {
    return left.name_ < right.name_;
  }`,
  )
  .replace(
    'explicit TripleComponent(UNDEF) : kind_(Kind::Undef) {}',
    `explicit TripleComponent(UNDEF) : kind_(Kind::Undef) {}
  explicit TripleComponent(Id id) : kind_(Kind::Id), id_(id) {}`,
  )
  .replace(
    'bool isId() const { return false; }\n  Id getId() const { return Id::fromBits(0); }',
    'bool isId() const { return kind_ == Kind::Id; }\n  Id getId() const { return id_; }',
  )
  .replace(
    'enum class Kind { Variable, Iri, Literal, Undef };',
    'enum class Kind { Variable, Iri, Literal, Undef, Id };',
  )
  .replace(
    'std::variant<GeoPoint> variant_{GeoPoint{}};',
    'std::variant<GeoPoint> variant_{GeoPoint{}};\n  Id id_{Id::fromBits(0)};',
  )
  .replace(
    '  static ParsedQuery minimalAsk() {',
    `  static ParsedQuery twoHopJoinSelect() {
    ParsedQuery query;
    parsedQuery::BasicGraphPattern basic;
    basic._triples.emplace_back(
        TripleComponent{Variable{"?s"}},
        TripleComponent{TripleComponent::Iri{"<urn:p>"}},
        TripleComponent{Variable{"?o"}});
    basic._triples.emplace_back(
        TripleComponent{Variable{"?o"}},
        TripleComponent{TripleComponent::Iri{"<urn:p>"}},
        TripleComponent{Variable{"?x"}});
    query._rootGraphPattern._graphPatterns.emplace_back(std::move(basic));
    query.select_clause_.setSelected({Variable{"?s"}, Variable{"?x"}});
    return query;
  }
  static ParsedQuery boundedFilterObjectGreaterThanIntegerSelect() {
    ParsedQuery query;
    parsedQuery::BasicGraphPattern basic;
    basic._triples.emplace_back(
        TripleComponent{Variable{"?s"}},
        TripleComponent{TripleComponent::Iri{"<urn:numeric>"}},
        TripleComponent{Variable{"?o"}});
    query._rootGraphPattern._graphPatterns.emplace_back(std::move(basic));
    SparqlFilter filter;
    filter.expression_ = sparqlExpression::SparqlExpressionPimpl{"(?o > 8)"};
    query._rootGraphPattern._filters.push_back(std::move(filter));
    query.select_clause_.setSelected({Variable{"?o"}});
    query._orderBy.push_back({Variable{"?o"}, false});
    query._limitOffset.constrained_ = true;
    query._limitOffset.limit_ = 2;
    return query;
  }
  static ParsedQuery boundedFilterObjectLcaseEqualsValueSelectObjectOnly() {
    ParsedQuery query = filterObjectNotTailSelect();
    query.select_clause_.setSelected({Variable{"?o"}});
    query._rootGraphPattern._filters[0].expression_ =
        sparqlExpression::SparqlExpressionPimpl{
            "LCASE(STR(?o)) = \\"value\\""};
    query._orderBy.push_back({Variable{"?o"}, false});
    query._limitOffset.constrained_ = true;
    query._limitOffset.limit_ = 2;
    return query;
  }
  static ParsedQuery boundedFilterObjectUcaseEqualsValueSelectObjectOnly() {
    ParsedQuery query = filterObjectNotTailSelect();
    query.select_clause_.setSelected({Variable{"?o"}});
    query._rootGraphPattern._filters[0].expression_ =
        sparqlExpression::SparqlExpressionPimpl{
            "UCASE(STR(?o)) = \\"VALUE\\""};
    query._orderBy.push_back({Variable{"?o"}, false});
    query._limitOffset.constrained_ = true;
    query._limitOffset.limit_ = 2;
    return query;
  }
  static ParsedQuery boundedFilterSubjectContainsSelectObjectOnly() {
    ParsedQuery query = filterSubjectContainsSelectObjectOnly();
    query._orderBy.push_back({Variable{"?o"}, false});
    query._limitOffset.constrained_ = true;
    query._limitOffset.limit_ = 2;
    return query;
  }
  static ParsedQuery minimalAsk() {`,
  )
  .replace(
    'struct Values {\n  SparqlValues _inlineValues;\n  size_t _id = static_cast<size_t>(-1);\n};',
    `struct Values {
  SparqlValues _inlineValues;
  size_t _id = static_cast<size_t>(-1);
};
struct MagicServiceQuery {
  std::optional<GraphPattern> childGraphPattern_;
  virtual ~MagicServiceQuery() = default;
};
struct ExternalValuesQuery : MagicServiceQuery {
  ExternalValuesQuery() = default;
  ExternalValuesQuery(std::string name, std::vector<Variable> variables)
      : name_(std::move(name)), variables_(std::move(variables)) {}
  std::string name_;
  std::vector<Variable> variables_;
};`,
  )
  .replace(
    `struct DescribeSubquery {
  const ParsedQuery* query = nullptr;
  const ParsedQuery& get() const { return *query; }
};`,
    `struct Subquery {
  const ParsedQuery* query = nullptr;
  const ParsedQuery& get() const { return *query; }
};
struct TransPath {
  GraphPattern _childGraphPattern;
};
struct DescribeSubquery {
  const ParsedQuery* query = nullptr;
  const ParsedQuery& get() const { return *query; }
};`,
  )
  .replace(
    'using GraphPatternOperationVariant = std::variant<BasicGraphPattern, Values, Bind, GroupGraphPattern, Optional, Minus, Union, Describe>;',
    'using GraphPatternOperationVariant = std::variant<BasicGraphPattern, Values, Bind, GroupGraphPattern, Optional, Minus, Union, Subquery, TransPath, Describe, ExternalValuesQuery>;',
  )
  .replace(
    'static ParsedQuery minimalSelect() {',
    `static ParsedQuery vectorResourceSelect() {
    ParsedQuery query;
    query.select_clause_.setSelected({Variable{"?resource"}});
    return query;
  }
  static ParsedQuery vectorRetrievalSelect() {
    ParsedQuery query;
    query.select_clause_.setSelected({Variable{"?retrieval"}});
    return query;
  }
  static ParsedQuery vectorResourceSelectWithExternalValues(
      std::string name, bool nested) {
    ParsedQuery query = vectorResourceSelect();
    parsedQuery::ExternalValuesQuery external_values{
        std::move(name), {Variable{"?retrieval"}, Variable{"?resource"}}};
    if (nested) {
      parsedQuery::GraphPattern child;
      child._graphPatterns.emplace_back(std::move(external_values));
      query._rootGraphPattern._graphPatterns.emplace_back(
          parsedQuery::Optional{std::move(child)});
    } else {
      query._rootGraphPattern._graphPatterns.emplace_back(
          std::move(external_values));
    }
    return query;
  }
  static ParsedQuery minimalSelect() {`,
  );

const executorSparqlParserHeader = fakeThrowingSparqlParserHeader.replace(
  'if (query.find("ASK") != std::string::npos)',
  'if (query.find("XpodVectorQuery") != std::string::npos) return ParsedQuery::vectorResourceSelectWithExternalValues("XpodVectorQuery", query.find("OPTIONAL") != std::string::npos); if (query.find("OrdinaryExternalValues") != std::string::npos) return ParsedQuery::vectorResourceSelectWithExternalValues("OrdinaryExternalValues", false); if (query.find("?retrieval") != std::string::npos) return ParsedQuery::vectorRetrievalSelect(); if (query.find("?resource") != std::string::npos) return ParsedQuery::vectorResourceSelect(); if (query.find("ASK") != std::string::npos)',
).replace(
  'if (query.find("<urn:p>") != std::string::npos) return ParsedQuery::predicateIriSelect();',
  'if (query.find("TwoHopJoin") != std::string::npos) return ParsedQuery::twoHopJoinSelect(); if (query.find("LCASE") != std::string::npos) return ParsedQuery::boundedFilterObjectLcaseEqualsValueSelectObjectOnly(); if (query.find("UCASE") != std::string::npos) return ParsedQuery::boundedFilterObjectUcaseEqualsValueSelectObjectOnly(); if (query.find("<urn:numeric>") != std::string::npos) return ParsedQuery::boundedFilterObjectGreaterThanIntegerSelect(); if (query.find("CONTAINS") != std::string::npos) return ParsedQuery::boundedFilterSubjectContainsSelectObjectOnly(); if (query.find("<urn:p>") != std::string::npos) return ParsedQuery::predicateIriSelect();',
);

const executorExternalValuesHeader = `
#pragma once
#include <stdexcept>
#include <string>
#include <utility>
#include <vector>
#include "engine/Operation.h"
#include "parser/ExternalValuesQuery.h"

extern "C" void xpod_test_mark_external_values_planned();
extern "C" void xpod_test_mark_external_values_updated();
extern "C" void xpod_test_mark_vector_result_requested();
extern "C" void xpod_test_mark_native_filter_planned();
extern "C" void xpod_test_set_native_transform_filter(bool enabled);
extern "C" bool xpod_test_native_transform_filter_enabled();

class ExternalValues final : public Operation {
 public:
  ExternalValues(
      QueryExecutionContext* qec,
      const parsedQuery::ExternalValuesQuery& query)
      : Operation(qec), name_(query.name_) {
    values_._variables = query.variables_;
    xpod_test_mark_external_values_planned();
  }
  const std::string& getName() const { return name_; }
  void updateValues(parsedQuery::SparqlValues values) {
    bool variables_match = values._variables.size() == values_._variables.size();
    for (size_t i = 0; variables_match && i < values._variables.size(); ++i) {
      variables_match = values._variables[i].name() == values_._variables[i].name();
    }
    if (!variables_match) {
      throw std::runtime_error("ExternalValues variables changed");
    }
    values_ = std::move(values);
    xpod_test_mark_external_values_updated();
  }
  const parsedQuery::SparqlValues& values() const { return values_; }
  std::string getDescriptor() const override {
    return "EXTERNAL VALUES '" + name_ + "'";
  }
  size_t getResultWidth() const override { return values_._variables.size(); }
  void getExternalValues(std::vector<ExternalValues*>& values) override {
    values.push_back(this);
  }
 protected:
  std::vector<ColumnIndex> resultSortedOn() const override { return {}; }
  Result computeResult(bool) override {
    if (!qec_->disableCaching()) {
      throw std::runtime_error("ExternalValues caching was not disabled");
    }
    IdTable table(values_._variables.size());
    for (const auto& value_row : values_._values) {
      std::vector<Id> row;
      row.reserve(value_row.size());
      for (const auto& value : value_row) row.push_back(value.getId());
      table.push_back(row);
    }
    return {std::move(table), {}, LocalVocab{}};
  }
 private:
  std::string name_;
  parsedQuery::SparqlValues values_;
};
`;

const executorQueryPlannerHeader = `
#pragma once
#include <memory>
#include <stdexcept>
#include <utility>
#include <vector>
#include "XpodQleverVectorIndexScan.hpp"
#include "engine/ExternalValues.h"
#include "engine/IndexScan.h"
#include "engine/QueryExecutionContext.h"
#include "engine/QueryExecutionTree.h"
#include "parser/ParsedQuery.h"
#include "util/CancellationHandle.h"

class QueryPlanner {
 public:
  QueryPlanner(QueryExecutionContext* qec, ad_utility::SharedCancellationHandle)
      : qec_(qec) {}
  QueryExecutionTree createExecutionTree(ParsedQuery& parsed, bool = false) {
    for (const auto& operation : parsed._rootGraphPattern._graphPatterns) {
      if (std::get_if<parsedQuery::Values>(
              &static_cast<const parsedQuery::GraphPatternOperationVariant&>(operation)) != nullptr) {
        throw std::runtime_error("vector source used inline Values instead of ExternalValues");
      }
      const auto* external_query = std::get_if<parsedQuery::ExternalValuesQuery>(
          &static_cast<const parsedQuery::GraphPatternOperationVariant&>(operation));
      if (external_query == nullptr) continue;
      if (!xpod::qlever::XpodQleverVectorIndexScan::canHandle(
              qec_, *external_query)) {
        continue;
      }
      auto vector_source =
          std::make_shared<xpod::qlever::XpodQleverVectorIndexScan>(
              qec_, *external_query);
      (void)vector_source->getSizeEstimate();
      return QueryExecutionTree(qec_, std::move(vector_source));
    }
    if (!parsed._rootGraphPattern._filters.empty()) {
      xpod_test_mark_native_filter_planned();
      const std::string descriptor =
          parsed._rootGraphPattern._filters[0].expression_.getDescriptor();
      const bool transform_predicate =
          descriptor.find("LCASE") != std::string::npos ||
          descriptor.find("UCASE") != std::string::npos;
      xpod_test_set_native_transform_filter(transform_predicate);
      return QueryExecutionTree(
          qec_, std::make_shared<IndexScan>(qec_, !transform_predicate));
    }
    xpod_test_set_native_transform_filter(false);
    return QueryExecutionTree(qec_, std::make_shared<IndexScan>(qec_));
  }
 private:
  QueryExecutionContext* qec_;
};
`;

const executorExecuteUpdateHeader = `
#pragma once
#include <array>
#include <utility>
#include <vector>
#include "engine/Operation.h"
#include "engine/Result.h"
#include "index/Index.h"
#include "index/LocalVocab.h"
#include "parser/ParsedQuery.h"
#include "util/CancellationHandle.h"

struct UpdateMetadata {};

extern "C" bool xpod_test_duplicate_prepared_graph_quad();

template <typename = void>
class IdTriple {
 public:
  explicit IdTriple(std::array<Id, 4> ids) : ids_(std::move(ids)) {}
  const std::array<Id, 4>& ids() const { return ids_; }
 private:
  std::array<Id, 4> ids_;
};

class ExecuteUpdate {
 public:
  struct PreparedGraphUpdate {
    std::vector<IdTriple<>> toInsert_;
    std::vector<IdTriple<>> toDelete_;
    LocalVocab localVocab_;
    UpdateMetadata metadata_;
  };

  static PreparedGraphUpdate prepareGraphUpdate(
      const Index&,
      const ParsedQuery& query,
      const Result&,
      const VariableToColumnMap&,
      const ad_utility::SharedCancellationHandle&) {
    PreparedGraphUpdate prepared;
    const auto& update = query.updateClause().op_;
    const std::array<Id, 4> quad{
        Id::fromBits(1010), Id::fromBits(1020),
        Id::fromBits(1030), Id::fromBits(1040)};
    if (!update.toDelete_.triples_.empty()) {
      prepared.toDelete_.emplace_back(quad);
    }
    if (!update.toInsert_.triples_.empty()) {
      prepared.toInsert_.emplace_back(quad);
      if (xpod_test_duplicate_prepared_graph_quad()) {
        prepared.toInsert_.emplace_back(std::array<Id, 4>{
            Id::fromBits(1011), Id::fromBits(1020),
            Id::fromBits(1030), Id::fromBits(1040)});
      }
    }
    return prepared;
  }
};
`;

describe('QLever executor factory', () => {
  it('routes the compiled-in product executor by the configured execution policy', () => {
    const executor = readFileSync(executorSource, 'utf8');
    expect(executor).toContain('QueryExecutionPolicy::CompatibilityAllowed');
    expect(executor).toContain('executeBridgeQueryWithPlannerContext');
    expect(executor).toContain('executeNativeQleverQueryWithPlannerContext');
  });

  it('evaluates constant DATA updates once without synthesizing a binding row', () => {
    const bridge = readFileSync(bridgeSource, 'utf8');
    const preservedTemplate = bridge.indexOf(
      'const auto graph_update = parsed_update.updateClause().op_;',
    );
    const plannerExecution = bridge.indexOf(
      'auto native_execution = executeQleverParsedQueryWithNativeTree(',
      preservedTemplate,
    );
    expect(preservedTemplate).toBeGreaterThan(-1);
    expect(plannerExecution).toBeGreaterThan(preservedTemplate);
    expect(bridge).toContain('bool evaluate_once_without_bindings');
    expect(bridge).toContain(
      'evaluate_once_without_bindings && table.numRows() == 0',
    );
    expect(bridge).toContain('template_bindings, !has_where_pattern,');
    expect(bridge).not.toContain('push_back({Id::makeUndefined()})');
  });

  it('does not reject native QLever text scan roots as bridge-only candidate plans', () => {
    const bridge = readFileSync(bridgeSource, 'utf8');

    expect(bridge).toContain('executeQleverPlannerTree');
    expect(bridge).toContain('XPOD_RDF_BACKEND_FEATURE_TEXT_SEARCH');
    expect(bridge).not.toContain('!plan.has_value() || isBridgeCandidateRoot(plan->root.kind)');
  });

  it('executes reserved vector sources as planner operations without post-planning injection', () => {
    const bridge = readFileSync(bridgeSource, 'utf8');

    expect(bridge).toContain('#include "XpodQleverVectorIndexScan.hpp"');
    expect(bridge).toContain(
      'catch (const XpodQleverVectorExecutionError& error)',
    );
    expect(bridge).not.toContain('VectorExternalValuesBinding');
    expect(bridge).not.toContain('updateVectorExternalValues');
    expect(bridge).not.toContain('getExternalValues(external_values)');
    expect(bridge).not.toContain('vector_binding');
  });

  it('enables the same strip-columns runtime contract as qlever-server', () => {
    const executor = readFileSync(executorSource, 'utf8');

    expect(executor).toContain('#include "global/RuntimeParameters.h"');
    expect(executor).toContain(
      'setRuntimeParameter<&RuntimeParameters::stripColumns_>(true);',
    );
  });

  it('keeps physical planner contexts request-local without mutating the global cache parameter', () => {
    const executor = readFileSync(executorSource, 'utf8');
    const provider = readFileSync(
      path.join(repoRoot, 'qlever/qlever_adapter/src/XpodQleverPlannerContextProvider.hpp'),
      'utf8',
    );

    expect(executor).not.toContain(
      'setRuntimeParameter<&RuntimeParameters::disableCaching_>',
    );
    expect(executor).not.toContain('QueryExecutionContextCacheMode::Cached');
    expect(executor.match(/QueryExecutionContextCacheMode::Uncached/g)).toHaveLength(1);
    expect(executor).toContain('auto planner_context_provider = createQueryPlannerContextProvider(');
    expect(executor).not.toContain('normal_planner_context_provider_');
    expect(executor).not.toContain('vector_planner_context_provider_');
    expect(provider).toContain('context_.clearCacheUnpinnedOnly();');
  });

  it('executes vector candidates through the upstream planner operation', async () => {
    expect(hasCxx(), 'c++ compiler is required for native executor factory check').toBe(true);

    const root = await mkdtemp(path.join(os.tmpdir(), 'xpod-qlever-executor-factory-'));
    try {
      const qleverSource = path.join(root, 'qlever');
      await mkdir(path.join(qleverSource, 'src/libqlever'), { recursive: true });
      await mkdir(path.join(qleverSource, 'src/parser'), { recursive: true });
      await mkdir(path.join(qleverSource, 'src/engine'), { recursive: true });
      await mkdir(path.join(qleverSource, 'src/engine/idTable'), { recursive: true });
      await mkdir(path.join(qleverSource, 'src/global'), { recursive: true });
      await mkdir(path.join(qleverSource, 'src/index'), { recursive: true });
      await mkdir(path.join(qleverSource, 'src/util'), { recursive: true });
      await writeFile(path.join(qleverSource, 'src/index/EncodedIriManager.h'), fakeEncodedIriManagerHeader, 'utf8');
      await writeFile(path.join(qleverSource, 'src/index/ExportIds.h'), `
#pragma once
#include <optional>
#include <string>
#include <utility>

namespace ql::exportIds {
template <typename IdT>
inline std::optional<std::pair<std::string, const char*>>
idToStringAndTypeForEncodedValue(const IdT&) {
  return std::nullopt;
}
}
`, 'utf8');
      await writeFile(path.join(qleverSource, 'src/libqlever/Qlever.h'), '#pragma once\n', 'utf8');
      await writeFile(path.join(qleverSource, 'src/parser/ParsedQuery.h'), executorParsedQueryHeader, 'utf8');
      await writeFile(path.join(qleverSource, 'src/parser/ExternalValuesQuery.h'), '#pragma once\n#include "parser/ParsedQuery.h"\n', 'utf8');
      await writeFile(path.join(qleverSource, 'src/parser/RdfParser.h'), fakeRdfParserHeader, 'utf8');
      await writeFile(path.join(qleverSource, 'src/parser/SparqlTriple.h'), fakeSparqlTripleHeader, 'utf8');
      await writeFile(path.join(qleverSource, 'src/parser/SparqlParser.h'), executorSparqlParserHeader, 'utf8');
      await writeFile(path.join(qleverSource, 'src/parser/TokenizerCtre.h'), fakeTokenizerCtreHeader, 'utf8');
      await writeFile(path.join(qleverSource, 'src/util/CancellationHandle.h'), fakeCancellationHandleHeader, 'utf8');
      await writeFile(path.join(qleverSource, 'src/util/Exception.h'), `
#pragma once
#include <exception>
#include <string>
#include <utility>
namespace ad_utility {
class AbortException : public std::exception {
 public:
  explicit AbortException(const std::exception& original)
      : message_(original.what()) {}
  explicit AbortException(std::string message)
      : message_(std::move(message)) {}
  const char* what() const noexcept override { return message_.c_str(); }
 private:
  std::string message_;
};
}
`, 'utf8');
      await writeFile(path.join(qleverSource, 'src/util/AllocatorWithLimit.h'), `
#pragma once
#include <cstdint>
namespace ad_utility {
class MemorySize {
 public:
  static MemorySize bytes(uint64_t value) { return MemorySize(value); }
  uint64_t getBytes() const { return value_; }
 private:
  explicit MemorySize(uint64_t value) : value_(value) {}
  uint64_t value_;
};
template <typename T>
class AllocatorWithLimit {
 public:
  AllocatorWithLimit(uint64_t limit = 0) : limit_(limit) {}
  uint64_t limit() const { return limit_; }
 private:
  uint64_t limit_;
};
template <typename T>
AllocatorWithLimit<T> makeAllocatorWithLimit(MemorySize limit) {
  return AllocatorWithLimit<T>{limit.getBytes()};
}
template <typename T>
AllocatorWithLimit<T> makeUnlimitedAllocator() { return AllocatorWithLimit<T>{};
}
}
`, 'utf8');
      await writeFile(path.join(qleverSource, 'src/engine/SortPerformanceEstimator.h'), '#pragma once\nclass SortPerformanceEstimator {};\n', 'utf8');
      await writeFile(path.join(qleverSource, 'src/engine/NamedResultCache.h'), '#pragma once\nclass NamedResultCache {};\n', 'utf8');
      await writeFile(path.join(qleverSource, 'src/engine/MaterializedViews.h'), '#pragma once\nclass MaterializedViewsManager {};\n', 'utf8');
      await writeFile(path.join(qleverSource, 'src/engine/QueryExecutionContext.h'), executorQueryExecutionContextHeader, 'utf8');
      await writeFile(path.join(qleverSource, 'src/engine/QueryExecutionTree.h'), executorQueryExecutionTreeHeader, 'utf8');
      await writeFile(path.join(qleverSource, 'src/engine/Operation.h'), executorOperationHeader, 'utf8');
      await writeFile(path.join(qleverSource, 'src/engine/ExternalValues.h'), executorExternalValuesHeader, 'utf8');
      await writeFile(path.join(qleverSource, 'src/engine/ExecuteUpdate.h'), executorExecuteUpdateHeader, 'utf8');
      await writeFile(path.join(qleverSource, 'src/engine/QueryPlanner.h'), executorQueryPlannerHeader, 'utf8');
      await writeFile(path.join(qleverSource, 'src/engine/IndexScan.h'), executorIndexScanHeader, 'utf8');
      await writeFile(
        path.join(qleverSource, 'src/engine/Join.h'),
        fakeJoinHeader.replaceAll(
          'variable_columns_.push_back({',
          'variable_columns_.insert({',
        ),
        'utf8',
      );
      await writeFile(path.join(qleverSource, 'src/engine/idTable/IdTable.h'), executorIdTableHeader, 'utf8');
      await writeFile(path.join(qleverSource, 'src/engine/RuntimeInformation.h'), '#pragma once\n', 'utf8');
      await writeFile(path.join(qleverSource, 'src/engine/VariableToColumnMap.h'), '#pragma once\n#include "engine/Operation.h"\n', 'utf8');
      await mkdir(path.join(qleverSource, 'src/engine/sparqlExpressions'), { recursive: true });
      await writeFile(path.join(qleverSource, 'src/engine/sparqlExpressions/SparqlExpression.h'), '#pragma once\n#include "parser/ParsedQuery.h"\n', 'utf8');
      await mkdir(path.join(qleverSource, 'src/rdfTypes'), { recursive: true });
      await writeFile(path.join(qleverSource, 'src/rdfTypes/Variable.h'), '#pragma once\n#include "parser/ParsedQuery.h"\n', 'utf8');
      await writeFile(path.join(qleverSource, 'src/global/Id.h'), `
#pragma once
#include <cstdint>
using ColumnIndex = uint64_t;
template <typename Tag>
class XpodTestIndex {
 public:
  static XpodTestIndex make(uint64_t value) { return XpodTestIndex(value); }
  uint64_t get() const { return value_; }
 private:
  explicit XpodTestIndex(uint64_t value) : value_(value) {}
  uint64_t value_;
};
struct XpodTestBlankNodeIndexTag {};
struct XpodTestLocalVocabIndexTag {};
struct XpodTestTextRecordIndexTag {};
struct XpodTestWordVocabIndexTag {};
using BlankNodeIndex = XpodTestIndex<XpodTestBlankNodeIndexTag>;
using LocalVocabIndex = XpodTestIndex<XpodTestLocalVocabIndexTag>;
using TextRecordIndex = XpodTestIndex<XpodTestTextRecordIndexTag>;
using WordVocabIndex = XpodTestIndex<XpodTestWordVocabIndexTag>;
enum class Datatype {
  Undefined,
  BlankNodeIndex,
  LocalVocabIndex,
  TextRecordIndex,
  WordVocabIndex,
  Date,
  GeoPoint,
  VocabIndex,
  Int,
  Double,
  EncodedVal,
};
class Id {
 public:
  static constexpr uint64_t maxIndex = (1ULL << 60) - 1;
  static Id fromBits(uint64_t bits) { return Id(bits, Datatype::Undefined); }
  static Id makeUndefined() { return Id(0, Datatype::Undefined); }
  static Id makeFromInt(int64_t value) {
    return Id(0xA100000000000000ULL | static_cast<uint64_t>(value),
              Datatype::EncodedVal);
  }
  static Id makeFromDouble(double value) {
    return Id(0xA200000000000000ULL |
                  (static_cast<uint64_t>(value) & 0x0000FFFFFFFFFFFFULL),
              Datatype::EncodedVal);
  }
  static Id makeFromBool(bool value) {
    return Id(0xB100000000000000ULL | static_cast<uint64_t>(value),
              Datatype::EncodedVal);
  }
  static Id makeBoolFromZeroOrOne(bool value) {
    return Id(0xB200000000000000ULL | static_cast<uint64_t>(value),
              Datatype::EncodedVal);
  }
  static Id makeFromTextRecordIndex(TextRecordIndex index) {
    return Id(index.get(), Datatype::TextRecordIndex);
  }
  static Id makeFromLocalVocabIndex(LocalVocabIndex index) {
    return Id(index.get(), Datatype::LocalVocabIndex);
  }
  uint64_t getBits() const { return bits_; }
  int64_t getInt() const {
    return static_cast<int64_t>(bits_ & 0x0000FFFFFFFFFFFFULL);
  }
  double getDouble() const {
    return static_cast<double>(bits_ & 0x0000FFFFFFFFFFFFULL);
  }
  bool getBool() const { return (bits_ & 1ULL) != 0; }
  bool getBoolLiteral() const { return getBool(); }
  Datatype getDatatype() const { return datatype_; }
  BlankNodeIndex getBlankNodeIndex() const { return BlankNodeIndex::make(bits_); }
  LocalVocabIndex getLocalVocabIndex() const { return LocalVocabIndex::make(bits_); }
  TextRecordIndex getTextRecordIndex() const { return TextRecordIndex::make(bits_); }
  WordVocabIndex getWordVocabIndex() const { return WordVocabIndex::make(bits_); }
  friend bool operator<(const Id& left, const Id& right) {
    return left.bits_ < right.bits_;
  }
  uint64_t bits_;
 private:
  Id(uint64_t bits, Datatype datatype) : bits_(bits), datatype_(datatype) {}
  Datatype datatype_;
};
`, 'utf8');
      await writeFile(path.join(qleverSource, 'src/global/ValueId.h'), '#pragma once\n#include "global/Id.h"\n', 'utf8');
      await writeFile(path.join(qleverSource, 'src/global/RuntimeParameters.h'), `
#pragma once
struct RuntimeParameters {
  struct Bool {};
  Bool stripColumns_;
  Bool disableCaching_;
};
inline bool xpod_test_disable_caching = false;
inline bool xpod_test_strip_columns = false;
template <auto Parameter>
void setRuntimeParameter(bool value) {
  if constexpr (Parameter == &RuntimeParameters::disableCaching_) {
    xpod_test_disable_caching = value;
  } else if constexpr (Parameter == &RuntimeParameters::stripColumns_) {
    xpod_test_strip_columns = value;
  }
}
`, 'utf8');
      await writeFile(path.join(qleverSource, 'src/index/LocalVocab.h'), `
#pragma once
#include <string>
#include <string_view>
#include <utility>
#include <vector>
#include "global/Id.h"
class XpodTestLocalVocabWord {
 public:
  XpodTestLocalVocabWord() = default;
  explicit XpodTestLocalVocabWord(std::string value)
      : value_(std::move(value)) {}
  static XpodTestLocalVocabWord literal(std::string value) {
    XpodTestLocalVocabWord word(std::move(value));
    word.is_literal_ = true;
    return word;
  }
  static XpodTestLocalVocabWord literalWithoutQuotes(
      std::string_view value, const class LocalVocabContext&) {
    return literal(std::string(value));
  }
  bool isIri() const { return !value_.empty() && !is_literal_; }
  bool isLiteral() const { return !value_.empty() && is_literal_; }
  std::string_view getIriContent() const { return value_; }
  std::string_view getLiteralContent() const { return value_; }
  bool hasLanguageTag() const { return false; }
  bool hasDatatype() const { return false; }
  std::string_view getLanguageTag() const { return {}; }
  std::string_view getDatatype() const { return {}; }
 private:
  std::string value_;
  bool is_literal_ = false;
};
using LocalVocabEntry = XpodTestLocalVocabWord;
class LocalVocabContext {};
class LocalVocab {
 public:
  LocalVocab() = default;
  LocalVocab(const LocalVocab&) = delete;
  LocalVocab& operator=(const LocalVocab&) = delete;
  LocalVocab(LocalVocab&&) noexcept = default;
  LocalVocab& operator=(LocalVocab&&) noexcept = default;
  LocalVocab clone() const {
    LocalVocab copy;
    copy.words_ = words_;
    return copy;
  }
  LocalVocabIndex addIri(std::string value) {
    words_.emplace_back(std::move(value));
    return LocalVocabIndex::make(words_.size());
  }
  LocalVocabIndex addLiteral(std::string value, std::string) {
    words_.push_back(XpodTestLocalVocabWord::literal(std::move(value)));
    return LocalVocabIndex::make(words_.size());
  }
  LocalVocabIndex getIndexAndAddIfNotContained(
      const XpodTestLocalVocabWord& word) {
    words_.push_back(word);
    return LocalVocabIndex::make(words_.size());
  }
  void mergeWith(const LocalVocab& other) {
    words_.insert(words_.end(), other.words_.begin(), other.words_.end());
  }
  bool isBlankNodeIndexContained(BlankNodeIndex) const { return false; }
  const XpodTestLocalVocabWord& getWord(LocalVocabIndex index) const {
    if (index.get() > 0 && index.get() <= words_.size()) {
      return words_[index.get() - 1];
    }
    static const XpodTestLocalVocabWord word;
    return word;
  }
  size_t size() const { return words_.size(); }
 private:
  std::vector<XpodTestLocalVocabWord> words_;
};
`, 'utf8');
      await writeFile(path.join(qleverSource, 'src/engine/Result.h'), executorResultHeader, 'utf8');
      await writeFile(path.join(qleverSource, 'src/index/Index.h'), `
#pragma once
#include <string>
#include "global/Id.h"
#include "util/AllocatorWithLimit.h"
class Index {
 public:
  explicit Index(ad_utility::AllocatorWithLimit<Id>) {}
  void setOnDiskBase(const std::string& value) { on_disk_base_ = value; }
 private:
  std::string on_disk_base_;
};
`, 'utf8');
      await writeFile(path.join(qleverSource, 'src/index/CompressedRelation.h'), executorCompressedRelationHeader, 'utf8');
      await writeFile(path.join(qleverSource, 'src/index/Permutation.h'), `
#pragma once
#include "index/CompressedRelation.h"
class Permutation {
 public:
  enum struct Enum { PSO, POS, SPO, SOP, OPS, OSP };
  using ScanSpecAndBlocks = CompressedRelationReader::ScanSpecAndBlocks;
  using MetadataAndBlocks = CompressedRelationReader::ScanSpecAndBlocksAndBounds;
  explicit Permutation(Enum value = Enum::SPO) : value_(value) {}
  Enum permutation() const { return value_; }
 private:
  Enum value_;
};
`, 'utf8');

      const smoke = path.join(root, 'enabled_executor_smoke.cpp');
      const binary = path.join(root, 'enabled_executor_smoke');
      await writeFile(smoke, `
#include <cstdio>
#include <string>
#include <string_view>
#include "global/RuntimeParameters.h"
#include "XpodQleverBridge.hpp"
#include "XpodQleverPhysicalFilterContextBridge.hpp"
#include "xpod_qlever_adapter.h"

static bool external_values_planned = false;
static int retrieval_point_encode_attempts = 0;
static int retrieval_point_resolve_calls = 0;
static bool resolve_subject_as_blank = false;
static bool resolve_second_subject_as_blank = false;
static bool duplicate_prepared_graph_quad = false;
static bool resolve_graph_source = false;
static int source_scope_resolution_calls = 0;
static xpod_rdf_status source_scope_resolution_status = XPOD_RDF_STATUS_OK;
static xpod_rdf_status graph_lookup_status = XPOD_RDF_STATUS_OK;
static int graph_lookup_calls = 0;
static const xpod_rdf_cancellation* expected_vector_cancellation = nullptr;
static std::string vector_events;
static std::string qec_cache_modes;
static int native_filter_plan_calls = 0;
static bool native_transform_filter_enabled = false;

static uint8_t record_vector_cancellation_check(void* user_data) {
  auto* calls = static_cast<int*>(user_data);
  *calls += 1;
  return 0;
}

extern "C" void xpod_test_mark_external_values_planned() {
  external_values_planned = true;
}

extern "C" void xpod_test_mark_external_values_updated() {}

extern "C" void xpod_test_mark_vector_result_requested() {}

extern "C" void xpod_test_mark_native_filter_planned() {
  native_filter_plan_calls += 1;
}

extern "C" void xpod_test_set_native_transform_filter(bool enabled) {
  native_transform_filter_enabled = enabled;
}

extern "C" bool xpod_test_native_transform_filter_enabled() {
  return native_transform_filter_enabled;
}

extern "C" void xpod_test_mark_qec_constructed(bool disable_caching) {
  qec_cache_modes.push_back(disable_caching ? 'U' : 'C');
}

extern "C" bool xpod_test_duplicate_prepared_graph_quad() {
  return duplicate_prepared_graph_quad;
}

static xpod_rdf_status encode(void*, xpod_rdf_term_key term, uint64_t* out_bits) {
  if (term == 84) {
    retrieval_point_encode_attempts += 1;
    return XPOD_RDF_STATUS_BACKEND_ERROR;
  }
  *out_bits = term + 1000;
  return XPOD_RDF_STATUS_OK;
}

static xpod_rdf_status decode(void*, uint64_t bits, xpod_rdf_term_key* out_term) {
  if (bits == Id::makeUndefined().getBits() || bits == 999999) {
    return XPOD_RDF_STATUS_BACKEND_ERROR;
  }
  *out_term = bits - 1000;
  return XPOD_RDF_STATUS_OK;
}

static bool vector_capability_enabled = false;
static uint32_t physical_capability_features = 0;
static int numeric_literal_lookup_calls = 0;
static bool fail_numeric_filter_lookup = false;
static xpod_rdf_status vector_search_status = XPOD_RDF_STATUS_OK;

struct ScanState {
  bool saw_context = false;
  bool transaction_active = false;
  bool committed_prepared_quad_exists = false;
  bool staged_prepared_quad_exists = false;
  int calls = 0;
  int vector_estimate_calls = 0;
  int vector_calls = 0;
  int mutation_calls = 0;
  int transaction_begin_calls = 0;
  int transaction_commit_calls = 0;
  int transaction_rollback_calls = 0;
  size_t last_filter_count = 0;
  xpod_rdf_scan_filter_kind last_filter_kind =
      XPOD_RDF_SCAN_FILTER_TERM_NOT_EQUAL;
  uint64_t last_limit = 0;
  size_t physical_filter_observations = 0;
};

static xpod_rdf_status get_capabilities(
    void*, xpod_rdf_backend_capabilities* out_capabilities) {
  if (!vector_capability_enabled && physical_capability_features == 0) {
    return XPOD_RDF_STATUS_UNSUPPORTED;
  }
  *out_capabilities = {};
  out_capabilities->supported_permutations =
      XPOD_RDF_PERM_CAP_SPOG |
      XPOD_RDF_PERM_CAP_SOPG |
      XPOD_RDF_PERM_CAP_PSOG |
      XPOD_RDF_PERM_CAP_POSG |
      XPOD_RDF_PERM_CAP_OSPG |
      XPOD_RDF_PERM_CAP_OPSG;
  out_capabilities->features =
      XPOD_RDF_BACKEND_FEATURE_SOURCE_SCOPE |
      XPOD_RDF_BACKEND_FEATURE_ACCESS_SCOPE |
      XPOD_RDF_BACKEND_FEATURE_TERM_TUPLE_FILTER |
      physical_capability_features;
  if (vector_capability_enabled) {
    out_capabilities->features |= XPOD_RDF_BACKEND_FEATURE_VECTOR_SEARCH;
  }
  return XPOD_RDF_STATUS_OK;
}

static xpod_rdf_status lookup_terms(
    void* backend_user_data,
    const xpod_rdf_term* terms,
    size_t term_count,
    const xpod_rdf_snapshot*,
    xpod_rdf_term_key* out_keys,
    xpod_rdf_status* out_statuses) {
  if (std::getenv("XPOD_QLEVER_RUNTIME_TRACE") != nullptr) {
    std::fprintf(stderr, "fake lookup term_count=%zu", term_count);
    for (size_t index = 0; index < term_count; ++index) {
      std::fprintf(
          stderr, " [%d:%.*s]", static_cast<int>(terms[index].kind),
          static_cast<int>(terms[index].value.size),
          terms[index].value.data);
    }
    std::fprintf(stderr, "\\n");
  }
  if (term_count == 1) {
    const std::string_view value(terms[0].value.data, terms[0].value.size);
    if (terms[0].kind == XPOD_RDF_TERM_LITERAL && value == "8") {
      numeric_literal_lookup_calls += 1;
      if (fail_numeric_filter_lookup) {
        return XPOD_RDF_STATUS_BACKEND_ERROR;
      }
      out_keys[0] = 80;
    } else if (terms[0].kind != XPOD_RDF_TERM_IRI) {
      return XPOD_RDF_STATUS_BACKEND_ERROR;
    } else if (value == "urn:p") {
      out_keys[0] = 20;
    } else if (value == "urn:s") {
      out_keys[0] = 10;
    } else if (value == "urn:o") {
      out_keys[0] = 30;
    } else if (value == "urn:numeric") {
      out_keys[0] = 90;
    } else if (value ==
               "http://qlever.cs.uni-freiburg.de/builtin-functions/default-graph") {
      out_keys[0] = 40;
    } else if (value == "urn:g") {
      graph_lookup_calls += 1;
      auto* state = static_cast<ScanState*>(backend_user_data);
      const bool staged_graph_exists = state != nullptr &&
          state->transaction_active && state->staged_prepared_quad_exists;
      if (graph_lookup_status != XPOD_RDF_STATUS_OK &&
          !(graph_lookup_status == XPOD_RDF_STATUS_NOT_FOUND &&
            staged_graph_exists)) {
        out_statuses[0] = graph_lookup_status;
        return XPOD_RDF_STATUS_OK;
      }
      out_keys[0] = 40;
    } else {
      return XPOD_RDF_STATUS_BACKEND_ERROR;
    }
    out_statuses[0] = XPOD_RDF_STATUS_OK;
    return XPOD_RDF_STATUS_OK;
  }
  if (term_count != 2) return XPOD_RDF_STATUS_BACKEND_ERROR;
  if (terms[0].kind != XPOD_RDF_TERM_IRI || terms[1].kind != XPOD_RDF_TERM_IRI) return XPOD_RDF_STATUS_BACKEND_ERROR;
  if (std::string_view(terms[0].value.data, terms[0].value.size) != "urn:type") return XPOD_RDF_STATUS_BACKEND_ERROR;
  if (std::string_view(terms[1].value.data, terms[1].value.size) != "urn:Thing") return XPOD_RDF_STATUS_BACKEND_ERROR;
  out_keys[0] = 50;
  out_statuses[0] = XPOD_RDF_STATUS_OK;
  out_keys[1] = 60;
  out_statuses[1] = XPOD_RDF_STATUS_OK;
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
  static const char other[] = "urn:other";
  static const char p[] = "urn:p";
  static const char o[] = "value";
  static const char filtered[] = "filtered";
  static const char joined[] = "joined";
  static const char joined_other[] = "joined-other";
  static const char graph[] = "urn:g";
  static const char vector_candidate[] = "urn:vector-candidate";
  static const char datatype[] = "http://www.w3.org/2001/XMLSchema#string";
  static const char integer_datatype[] = "http://www.w3.org/2001/XMLSchema#integer";
  static const char seven[] = "7";
  static const char eight[] = "8";
  static const char eleven[] = "11";
  static const char plain[] = "plain";
  static const char tagged[] = "tagged";
  static const char english_upper[] = "EN";
  for (size_t i = 0; i < key_count; ++i) {
    out_statuses[i] = XPOD_RDF_STATUS_OK;
    if (keys[i] == 10) {
      out_terms[i].kind = resolve_subject_as_blank
                              ? XPOD_RDF_TERM_BLANK
                              : XPOD_RDF_TERM_IRI;
      out_terms[i].value = resolve_subject_as_blank
                               ? xpod_rdf_bytes{"blank-subject", 13}
                               : xpod_rdf_bytes{s, 5};
    } else if (keys[i] == 11) {
      out_terms[i].kind = resolve_second_subject_as_blank
                              ? XPOD_RDF_TERM_BLANK
                              : XPOD_RDF_TERM_IRI;
      out_terms[i].value = resolve_second_subject_as_blank
                               ? xpod_rdf_bytes{"blank-second", 12}
                               : xpod_rdf_bytes{other, 9};
    } else if (keys[i] == 20) {
      out_terms[i].kind = XPOD_RDF_TERM_IRI;
      out_terms[i].value = {p, 5};
    } else if (keys[i] == 30) {
      out_terms[i].kind = XPOD_RDF_TERM_LITERAL;
      out_terms[i].value = {o, 5};
      out_terms[i].datatype_iri = {datatype, sizeof(datatype) - 1};
    } else if (keys[i] == 31) {
      out_terms[i].kind = XPOD_RDF_TERM_LITERAL;
      out_terms[i].value = {filtered, 8};
      out_terms[i].datatype_iri = {datatype, sizeof(datatype) - 1};
    } else if (keys[i] == 32) {
      out_terms[i].kind = XPOD_RDF_TERM_LITERAL;
      out_terms[i].value = {joined, 6};
      out_terms[i].datatype_iri = {datatype, sizeof(datatype) - 1};
    } else if (keys[i] == 33) {
      out_terms[i].kind = XPOD_RDF_TERM_LITERAL;
      out_terms[i].value = {joined_other, 12};
      out_terms[i].datatype_iri = {datatype, sizeof(datatype) - 1};
    } else if (keys[i] == 40) {
      out_terms[i].kind = XPOD_RDF_TERM_IRI;
      out_terms[i].value = {graph, 5};
    } else if (keys[i] == 42) {
      vector_events.push_back('R');
      out_terms[i].kind = XPOD_RDF_TERM_IRI;
      out_terms[i].value = {vector_candidate, 20};
    } else if (keys[i] == 80) {
      out_terms[i].kind = XPOD_RDF_TERM_LITERAL;
      out_terms[i].value = {eight, 1};
      out_terms[i].datatype_iri = {
          integer_datatype, sizeof(integer_datatype) - 1};
    } else if (keys[i] == 81) {
      out_terms[i].kind = XPOD_RDF_TERM_LITERAL;
      out_terms[i].value = {seven, 1};
      out_terms[i].datatype_iri = {
          integer_datatype, sizeof(integer_datatype) - 1};
    } else if (keys[i] == 82) {
      out_terms[i].kind = XPOD_RDF_TERM_LITERAL;
      out_terms[i].value = {eleven, 2};
      out_terms[i].datatype_iri = {
          integer_datatype, sizeof(integer_datatype) - 1};
    } else if (keys[i] == 100) {
      out_terms[i].kind = XPOD_RDF_TERM_LITERAL;
      out_terms[i].value = {plain, sizeof(plain) - 1};
    } else if (keys[i] == 101) {
      out_terms[i].kind = XPOD_RDF_TERM_LITERAL;
      out_terms[i].value = {tagged, sizeof(tagged) - 1};
      out_terms[i].language = {
          english_upper, sizeof(english_upper) - 1};
    } else if (keys[i] == 102) {
      out_terms[i].kind = XPOD_RDF_TERM_BLANK;
      out_terms[i].value = {"blank", 5};
    } else if (keys[i] == 90) {
      out_terms[i].kind = XPOD_RDF_TERM_IRI;
      out_terms[i].value = {"urn:numeric", 11};
    } else {
      out_statuses[i] = XPOD_RDF_STATUS_NOT_FOUND;
    }
  }
  return XPOD_RDF_STATUS_OK;
}

static xpod_rdf_status resolve_retrieval_points(
    void*,
    const xpod_rdf_retrieval_point_key* keys,
    size_t key_count,
    const xpod_rdf_snapshot*,
    xpod_rdf_bytes* out_contents,
    xpod_rdf_status* out_statuses) {
  static const char content[] = "retrieval-candidate";
  retrieval_point_resolve_calls += 1;
  for (size_t i = 0; i < key_count; ++i) {
    out_contents[i] = {content, sizeof(content) - 1};
    out_statuses[i] = keys[i] == 84 ? XPOD_RDF_STATUS_OK
                                    : XPOD_RDF_STATUS_NOT_FOUND;
  }
  return XPOD_RDF_STATUS_OK;
}

static xpod_rdf_status estimate_scan(
    void*,
    const xpod_rdf_scan_request*,
    xpod_rdf_estimate* out_estimate) {
  out_estimate->rows = 1;
  out_estimate->confidence = XPOD_RDF_ESTIMATE_EXACT;
  return XPOD_RDF_STATUS_OK;
}

static xpod_rdf_status resolve_source_scope(
    void*,
    const xpod_rdf_source_scope* source_scope,
    const xpod_rdf_snapshot*,
    xpod_rdf_resolved_source_scope* out_scope) {
  static const xpod_rdf_source_node_key unique_source[] = {70};
  static const xpod_rdf_source_node_key ambiguous_sources[] = {70, 71};
  source_scope_resolution_calls += 1;
  if (source_scope_resolution_status != XPOD_RDF_STATUS_OK) {
    return source_scope_resolution_status;
  }
  *out_scope = {};
  out_scope->graph_scope.kind = XPOD_RDF_GRAPH_SCOPE_ALL;
  const std::string_view source_uri(
      source_scope->source_uri.data, source_scope->source_uri.size);
  if (source_uri == "urn:source" ||
      (resolve_graph_source && source_uri == "urn:g")) {
    out_scope->source_nodes = unique_source;
    out_scope->source_nodes_size = 1;
  } else if (source_uri == "urn:bad-prefix") {
    out_scope->source_nodes = unique_source;
    out_scope->source_nodes_size = 1;
    out_scope->graph_scope.kind = XPOD_RDF_GRAPH_SCOPE_PREFIX;
    out_scope->graph_scope.iri_prefix = {nullptr, 1};
  } else if (source_uri == "urn:ambiguous") {
    out_scope->source_nodes = ambiguous_sources;
    out_scope->source_nodes_size = 2;
  }
  return XPOD_RDF_STATUS_OK;
}

static xpod_rdf_status apply_mutation(
    void* backend_user_data,
    const xpod_rdf_mutation_request* request,
    xpod_rdf_mutation_result* out_result) {
  auto* state = static_cast<ScanState*>(backend_user_data);
  state->mutation_calls += 1;
  *out_result = {};
  if (!state->transaction_active || request == nullptr ||
      request->mutation_count != 1) {
    return XPOD_RDF_STATUS_BACKEND_ERROR;
  }
  const xpod_rdf_quad_mutation& mutation = request->mutations[0];
  if (mutation.quad.has_graph == 0 ||
      std::string_view(mutation.quad.graph.value.data,
                       mutation.quad.graph.value.size) != "urn:g") {
    return XPOD_RDF_STATUS_BACKEND_ERROR;
  }
  if (mutation.kind == XPOD_RDF_MUTATION_INSERT) {
    state->staged_prepared_quad_exists = true;
    out_result->inserted_count = 1;
  } else if (mutation.kind == XPOD_RDF_MUTATION_DELETE) {
    state->staged_prepared_quad_exists = false;
    out_result->deleted_count = 1;
  } else {
    return XPOD_RDF_STATUS_BACKEND_ERROR;
  }
  return XPOD_RDF_STATUS_OK;
}

static xpod_rdf_status count_scan(
    void* backend_user_data,
    const xpod_rdf_scan_request* request,
    xpod_rdf_count_result* out_result) {
  auto* state = static_cast<ScanState*>(backend_user_data);
  if (!state->transaction_active || request == nullptr ||
      out_result == nullptr || request->pattern.has_subject == 0 ||
      request->pattern.subject != 10 ||
      request->pattern.has_predicate == 0 ||
      request->pattern.predicate != 20 ||
      request->pattern.has_object == 0 || request->pattern.object != 30 ||
      request->pattern.has_graph == 0 || request->pattern.graph != 40) {
    return XPOD_RDF_STATUS_BACKEND_ERROR;
  }
  *out_result = {};
  out_result->count = state->staged_prepared_quad_exists ? 1 : 0;
  return XPOD_RDF_STATUS_OK;
}

static xpod_rdf_status begin_transaction(
    void* backend_user_data,
    const xpod_rdf_snapshot*) {
  auto* state = static_cast<ScanState*>(backend_user_data);
  if (state->transaction_active) return XPOD_RDF_STATUS_BACKEND_ERROR;
  state->transaction_active = true;
  state->staged_prepared_quad_exists =
      state->committed_prepared_quad_exists;
  state->transaction_begin_calls += 1;
  return XPOD_RDF_STATUS_OK;
}

static xpod_rdf_status commit_transaction(void* backend_user_data) {
  auto* state = static_cast<ScanState*>(backend_user_data);
  if (!state->transaction_active) return XPOD_RDF_STATUS_BACKEND_ERROR;
  state->committed_prepared_quad_exists =
      state->staged_prepared_quad_exists;
  state->transaction_active = false;
  state->transaction_commit_calls += 1;
  return XPOD_RDF_STATUS_OK;
}

static xpod_rdf_status rollback_transaction(void* backend_user_data) {
  auto* state = static_cast<ScanState*>(backend_user_data);
  if (!state->transaction_active) return XPOD_RDF_STATUS_BACKEND_ERROR;
  state->staged_prepared_quad_exists =
      state->committed_prepared_quad_exists;
  state->transaction_active = false;
  state->transaction_rollback_calls += 1;
  return XPOD_RDF_STATUS_OK;
}

static xpod_rdf_status estimate_vector_search(
    void* backend_user_data,
    const xpod_rdf_vector_search_request*,
    xpod_rdf_estimate* out_estimate) {
  auto* state = static_cast<ScanState*>(backend_user_data);
  state->vector_estimate_calls += 1;
  vector_events.push_back('E');
  out_estimate->rows = 1;
  out_estimate->confidence = XPOD_RDF_ESTIMATE_EXACT;
  return XPOD_RDF_STATUS_OK;
}

static xpod_rdf_status vector_search(
    void* backend_user_data,
    const xpod_rdf_vector_search_request* request,
    xpod_rdf_candidate_batch_callback on_batch,
    void* callback_user_data) {
  auto* state = static_cast<ScanState*>(backend_user_data);
  state->vector_calls += 1;
  if (external_values_planned) return XPOD_RDF_STATUS_BACKEND_ERROR;
  if (expected_vector_cancellation != nullptr) {
    if (request->cancellation != expected_vector_cancellation ||
        request->cancellation->is_cancelled == nullptr ||
        request->cancellation->is_cancelled(
            request->cancellation->cancellation_user_data) != 0) {
      return XPOD_RDF_STATUS_BACKEND_ERROR;
    }
  }
  vector_events.push_back('V');
  if (vector_search_status != XPOD_RDF_STATUS_OK) {
    return vector_search_status;
  }
  if (request == nullptr || request->limit != 1) return XPOD_RDF_STATUS_BACKEND_ERROR;
  if (std::string_view(request->provider.data, request->provider.size) != "xpod") {
    return XPOD_RDF_STATUS_BACKEND_ERROR;
  }
  if (std::string_view(request->model.data, request->model.size) != "embed-v1") {
    return XPOD_RDF_STATUS_BACKEND_ERROR;
  }
  if (std::string_view(request->model_version.data, request->model_version.size) != "2026-08-12") {
    return XPOD_RDF_STATUS_BACKEND_ERROR;
  }
  if (std::string_view(request->input_kind.data, request->input_kind.size) != "entity-card") {
    return XPOD_RDF_STATUS_BACKEND_ERROR;
  }
  if (std::string_view(
          request->projection_policy_version.data,
          request->projection_policy_version.size) != "policy-v1") {
    return XPOD_RDF_STATUS_BACKEND_ERROR;
  }
  if (request->snapshot.snapshot_token.size != 15) return XPOD_RDF_STATUS_BACKEND_ERROR;
  if (std::string_view(
          request->snapshot.snapshot_token.data,
          request->snapshot.snapshot_token.size) != "vector-snapshot") {
    return XPOD_RDF_STATUS_BACKEND_ERROR;
  }
  if (request->graph_scope.kind != XPOD_RDF_GRAPH_SCOPE_EXACT ||
      request->graph_scope.exact_graph != 88) {
    return XPOD_RDF_STATUS_BACKEND_ERROR;
  }
  if (std::string_view(
          request->source_scope.workspace.data,
          request->source_scope.workspace.size) != "workspace-1") {
    return XPOD_RDF_STATUS_BACKEND_ERROR;
  }
  if (request->access_scope == nullptr) return XPOD_RDF_STATUS_PERMISSION_DENIED;
  if (request->access_scope->denied_graphs_size != 1 ||
      request->access_scope->denied_graphs[0] != 77) {
    return XPOD_RDF_STATUS_PERMISSION_DENIED;
  }
  xpod_rdf_candidate row = {};
  row.has_retrieval_point = 1;
  row.retrieval_point = 84;
  row.has_retrieval_point_key = 1;
  row.retrieval_point_key = {"chunk-84", 8};
  row.has_resource_term = 1;
  row.resource_term = 42;
  xpod_rdf_candidate_batch batch = {};
  batch.rows = &row;
  batch.row_count = 1;
  batch.scanned_rows = 2;
  return on_batch(callback_user_data, &batch);
}

static xpod_rdf_status scan(
    void* backend_user_data,
    const xpod_rdf_scan_request* request,
    xpod_rdf_quad_batch_callback on_batch,
    void* callback_user_data) {
  auto* state = static_cast<ScanState*>(backend_user_data);
  state->calls += 1;
  state->last_filter_count = request->filter_count;
  if (request->filter_count != 0) {
    state->physical_filter_observations += 1;
    state->last_filter_kind = request->filters[0].kind;
  }
  state->last_limit = request->limit;
  if (std::getenv("XPOD_QLEVER_RUNTIME_TRACE") != nullptr) {
    std::fprintf(
        stderr,
        "fake scan permutation=%d s=%d:%llu p=%d:%llu o=%d:%llu filter=%zu\\n",
        static_cast<int>(request->permutation),
        request->pattern.has_subject,
        static_cast<unsigned long long>(request->pattern.subject),
        request->pattern.has_predicate,
        static_cast<unsigned long long>(request->pattern.predicate),
        request->pattern.has_object,
        static_cast<unsigned long long>(request->pattern.object),
        request->term_tuple_filter == nullptr
            ? 0
            : request->term_tuple_filter->row_count);
  }
  if (request->snapshot.snapshot_token.size != 7) return XPOD_RDF_STATUS_BACKEND_ERROR;
  if (std::string_view(request->snapshot.snapshot_token.data, request->snapshot.snapshot_token.size) != "snap-v1") return XPOD_RDF_STATUS_BACKEND_ERROR;
  if (request->source_scope.local_path_prefix.size != 16) return XPOD_RDF_STATUS_BACKEND_ERROR;
  if (std::string_view(request->source_scope.local_path_prefix.data, request->source_scope.local_path_prefix.size) != "/workspace/docs/") return XPOD_RDF_STATUS_BACKEND_ERROR;
  if (request->access_scope == nullptr) return XPOD_RDF_STATUS_PERMISSION_DENIED;
  if (std::string_view(request->access_scope->principal.data, request->access_scope->principal.size) != "urn:alice") return XPOD_RDF_STATUS_PERMISSION_DENIED;
  state->saw_context = true;
  if (native_transform_filter_enabled) {
    xpod_rdf_quad_key rows[1] = {{10, 20, 30, 40}};
    xpod_rdf_quad_batch batch = {};
    batch.rows = rows;
    batch.row_count = 1;
    batch.scanned_rows = 2;
    return on_batch(callback_user_data, &batch);
  }
  if (request->pattern.has_predicate) {
    if (request->pattern.predicate == 20) {
      if (request->filter_count != 0) {
        if (request->filter_count != 1 ||
            request->filters[0].kind !=
                XPOD_RDF_SCAN_FILTER_VALUE_GREATER_THAN ||
            request->filters[0].slot != XPOD_RDF_SLOT_OBJECT) {
          return XPOD_RDF_STATUS_BACKEND_ERROR;
        }
        xpod_rdf_quad_key rows[1] = {{11, 20, 31, 40}};
        xpod_rdf_quad_batch batch = {};
        batch.rows = rows;
        batch.row_count = 1;
        batch.scanned_rows = 1;
        return on_batch(callback_user_data, &batch);
      }
      if (request->term_tuple_filter != nullptr) {
        if (request->term_tuple_filter->slot_count != 1 ||
            request->term_tuple_filter->slots[0] != XPOD_RDF_SLOT_SUBJECT) {
          return XPOD_RDF_STATUS_BACKEND_ERROR;
        }
        xpod_rdf_quad_key rows[2] = {};
        size_t row_count = 0;
        for (size_t i = 0; i < request->term_tuple_filter->row_count &&
             row_count < 2; ++i) {
          if (request->term_tuple_filter->terms[i] == 30) {
            rows[row_count++] = {30, 20, 32, 40};
          } else if (request->term_tuple_filter->terms[i] == 31) {
            rows[row_count++] = {31, 20, 33, 40};
          }
        }
        xpod_rdf_quad_batch batch = {};
        batch.rows = rows;
        batch.row_count = row_count;
        batch.scanned_rows = row_count;
        return on_batch(callback_user_data, &batch);
      }
      xpod_rdf_quad_key rows[2] = {
          {10, 20, 30, 40},
          {11, 20, 31, 40}};
      xpod_rdf_quad_batch batch = {};
      batch.rows = rows;
      batch.row_count = 2;
      batch.scanned_rows = 2;
      return on_batch(callback_user_data, &batch);
    }
    if (request->pattern.predicate == 90) {
      if (request->filter_count != 0) {
        if (request->filter_count != 1 ||
            request->filters[0].kind !=
                XPOD_RDF_SCAN_FILTER_VALUE_GREATER_THAN ||
            request->filters[0].slot != XPOD_RDF_SLOT_OBJECT) {
          return XPOD_RDF_STATUS_BACKEND_ERROR;
        }
        xpod_rdf_quad_key rows[1] = {{11, 90, 82, 40}};
        xpod_rdf_quad_batch batch = {};
        batch.rows = rows;
        batch.row_count = 1;
        batch.scanned_rows = 1;
        return on_batch(callback_user_data, &batch);
      }
      xpod_rdf_quad_key rows[2] = {
          {10, 90, 81, 40},
          {11, 90, 82, 40}};
      xpod_rdf_quad_batch batch = {};
      batch.rows = rows;
      batch.row_count = 2;
      batch.scanned_rows = 2;
      return on_batch(callback_user_data, &batch);
    }
    if (request->pattern.predicate != 50) return XPOD_RDF_STATUS_BACKEND_ERROR;
    if (!request->pattern.has_object || request->pattern.object != 60) return XPOD_RDF_STATUS_BACKEND_ERROR;
    xpod_rdf_quad_key rows[1] = {{10, 50, 60, 40}};
    xpod_rdf_quad_batch batch = {};
    batch.rows = rows;
    batch.row_count = 1;
    return on_batch(callback_user_data, &batch);
  }
  if (request->permutation == XPOD_RDF_PERM_POSG) {
    xpod_rdf_quad_key rows[1] = {{11, 82, 82, 40}};
    xpod_rdf_quad_batch batch = {};
    batch.rows = rows;
    batch.row_count = 1;
    batch.scanned_rows = 1;
    return on_batch(callback_user_data, &batch);
  }
  xpod_rdf_quad_key first_row[1] = {{10, 20, 30, 40}};
  xpod_rdf_quad_batch first_batch = {};
  first_batch.rows = first_row;
  first_batch.row_count = 1;
  first_batch.scanned_rows = 1;
  xpod_rdf_status status = on_batch(callback_user_data, &first_batch);
  if (status != XPOD_RDF_STATUS_OK) return status;
  xpod_rdf_quad_key second_row[1] = {{11, 20, 31, 40}};
  xpod_rdf_quad_batch second_batch = {};
  second_batch.rows = second_row;
  second_batch.row_count = 1;
  second_batch.scanned_rows = 1;
  return on_batch(callback_user_data, &second_batch);
}

namespace xpod::qlever {
void xpodQleverDiagnosticsEnable() noexcept;
void xpodQleverDiagnosticsDisable() noexcept;
std::string xpodQleverDiagnosticsJson();
}

static bool has_json_number(std::string_view json, std::string_view key) {
  const std::string needle = "\\"" + std::string(key) + "\\":";
  size_t offset = json.find(needle);
  if (offset == std::string_view::npos) return false;
  offset += needle.size();
  if (offset >= json.size()) return false;
  if (json[offset] == '-') ++offset;
  const size_t first_digit = offset;
  while (offset < json.size() && json[offset] >= '0' && json[offset] <= '9') {
    ++offset;
  }
  return offset > first_digit;
}

static size_t count_substring(
    std::string_view haystack, std::string_view needle) {
  size_t count = 0;
  size_t offset = 0;
  while ((offset = haystack.find(needle, offset)) != std::string_view::npos) {
    ++count;
    offset += needle.size();
  }
  return count;
}

static std::optional<std::string> json_string_field(
    std::string_view json, std::string_view key) {
  std::string needle = "\\"" + std::string(key) + "\\":";
  size_t offset = json.find(needle);
  if (offset == std::string_view::npos) return std::nullopt;
  offset += needle.size();
  if (offset >= json.size() || json[offset] != '\\"') return std::nullopt;
  ++offset;
  std::string value;
  while (offset < json.size()) {
    char ch = json[offset++];
    if (ch == '\\"') return value;
    if (ch != '\\\\') {
      value.push_back(ch);
      continue;
    }
    if (offset >= json.size()) return std::nullopt;
    char escaped = json[offset++];
    switch (escaped) {
      case '\\"':
      case '\\\\':
      case '/':
        value.push_back(escaped);
        break;
      case 'n':
        value.push_back('\\n');
        break;
      case 'r':
        value.push_back('\\r');
        break;
      case 't':
        value.push_back('\\t');
        break;
      default:
        value.push_back(escaped);
        break;
    }
  }
  return std::nullopt;
}

static bool json_null_field(std::string_view json, std::string_view key) {
  std::string needle = "\\"" + std::string(key) + "\\":null";
  return json.find(needle) != std::string_view::npos;
}

int main() {
  ScanState scan_state;
  xpod_rdf_backend_v1 backend = {};
  backend.abi_version = XPOD_RDF_PHYSICAL_BACKEND_ABI_VERSION;
  backend.struct_size = sizeof(xpod_rdf_backend_v1);
  backend.backend_user_data = &scan_state;
  backend.get_capabilities = get_capabilities;
  backend.encode_qlever_id = encode;
  backend.decode_qlever_id = decode;
  backend.lookup_terms = lookup_terms;
  backend.resolve_terms = resolve_terms;
  backend.resolve_retrieval_points = resolve_retrieval_points;
  backend.resolve_source_scope = resolve_source_scope;
  backend.estimate_scan = estimate_scan;
  backend.scan_permutation = scan;
  backend.count_scan = count_scan;
  backend.estimate_vector_search = estimate_vector_search;
  backend.vector_search = vector_search;
  backend.apply_mutation = apply_mutation;
  backend.begin_transaction = begin_transaction;
  backend.commit_transaction = commit_transaction;
  backend.rollback_transaction = rollback_transaction;

  xpod::qlever::PlannerRequestContext metadata_context{
      xpod::rdf::PhysicalBackend(&backend)};
  xpod::qlever::XpodQleverPhysicalIndex metadata_index(metadata_context);
  std::string metadata_language;
  std::string metadata_datatype;
  bool metadata_is_literal = false;
  for (Id inline_bool :
       {Id::makeFromBool(true), Id::makeBoolFromZeroOrOne(false)}) {
    if (xpod::qlever::physicalFilterTermMetadataFromId(
            metadata_index, inline_bool, metadata_language,
            metadata_datatype, metadata_is_literal) != XPOD_RDF_STATUS_OK ||
        !metadata_is_literal || !metadata_language.empty() ||
        metadata_datatype !=
            "http://www.w3.org/2001/XMLSchema#boolean") {
      return 240;
    }
  }
  if (xpod::qlever::physicalFilterTermMetadataFromId(
          metadata_index, Id::fromBits(1100), metadata_language,
          metadata_datatype, metadata_is_literal) != XPOD_RDF_STATUS_OK ||
      !metadata_is_literal || !metadata_language.empty() ||
      metadata_datatype !=
          "http://www.w3.org/2001/XMLSchema#string") {
    return 241;
  }
  if (xpod::qlever::physicalFilterTermMetadataFromId(
          metadata_index, Id::fromBits(1101), metadata_language,
          metadata_datatype, metadata_is_literal) != XPOD_RDF_STATUS_OK ||
      !metadata_is_literal || metadata_language != "EN" ||
      metadata_datatype !=
          "http://www.w3.org/1999/02/22-rdf-syntax-ns#langString") {
    return 242;
  }
  if (xpod::qlever::physicalFilterTermMetadataFromId(
          metadata_index, Id::fromBits(999999), metadata_language,
          metadata_datatype, metadata_is_literal) !=
      XPOD_RDF_STATUS_UNSUPPORTED) {
    return 243;
  }

  VariableToColumnMap metadata_columns{
      {Variable{"?value"}, makeAlwaysDefinedColumn(0)}};
  for (std::string_view descriptor :
       {"LANG(?value) = \\"en\\"", "\\"en\\" = LANG(?value)",
        "LANG(?value) != \\"en\\"", "\\"en\\" != LANG(?value)"}) {
    auto filter = xpod::qlever::physicalMetadataFilterFromExpression(
        metadata_columns, descriptor);
    if (!filter.has_value() ||
        filter->metadata_filter != XPOD_RDF_SCAN_FILTER_LANGUAGE_EQUAL ||
        filter->string_prefix != "en" ||
        filter->equals !=
            (descriptor.find(" != ") == std::string_view::npos)) {
      return 244;
    }
  }
  for (std::string_view descriptor : {
           "DATATYPE(?value) = <http://www.w3.org/2001/XMLSchema#string>",
           "<http://www.w3.org/2001/XMLSchema#string> = DATATYPE(?value)",
           "DATATYPE(?value) != <http://www.w3.org/1999/02/22-rdf-syntax-ns#langString>",
           "<http://www.w3.org/1999/02/22-rdf-syntax-ns#langString> != DATATYPE(?value)",
       }) {
    auto filter = xpod::qlever::physicalMetadataFilterFromExpression(
        metadata_columns, descriptor);
    if (!filter.has_value() ||
        filter->metadata_filter != XPOD_RDF_SCAN_FILTER_DATATYPE_EQUAL ||
        filter->equals !=
            (descriptor.find(" != ") == std::string_view::npos)) {
      return 245;
    }
  }

  auto metadata_allocator = ad_utility::makeUnlimitedAllocator<Id>();
  auto metadata_qlever_index =
      std::make_shared<Index>(metadata_allocator);
  QueryExecutionContext metadata_qec{
      metadata_qlever_index,
      nullptr,
      metadata_allocator,
      SortPerformanceEstimator{},
      nullptr,
      std::make_shared<MaterializedViewsManager>()};
  IdTable metadata_input{1, metadata_allocator};
  metadata_input.push_back({Id::fromBits(1020)});
  metadata_input.push_back({Id::fromBits(1102)});
  metadata_input.push_back({Id::makeUndefined()});
  metadata_input.push_back({Id::fromBits(1100)});
  metadata_input.push_back({Id::fromBits(1101)});

  xpod::qlever::XpodQleverBoundedFilterExpression language_not_equal;
  language_not_equal.kind =
      xpod::qlever::XpodQleverPhysicalFilterKind::MetadataPredicate;
  language_not_equal.equals = false;
  language_not_equal.column = 0;
  language_not_equal.string_prefix = "en";
  language_not_equal.metadata_filter =
      XPOD_RDF_SCAN_FILTER_LANGUAGE_EQUAL;
  auto language_output = xpod::qlever::physicalMetadataFilterIdTable(
      metadata_qec, metadata_index, metadata_input, language_not_equal);
  if (!language_output.has_value() || language_output->numRows() != 1 ||
      (*language_output)(0, 0).getBits() != 1100) {
    return 246;
  }

  xpod::qlever::XpodQleverBoundedFilterExpression datatype_not_equal =
      language_not_equal;
  datatype_not_equal.string_prefix =
      "http://www.w3.org/2001/XMLSchema#string";
  datatype_not_equal.metadata_filter =
      XPOD_RDF_SCAN_FILTER_DATATYPE_EQUAL;
  auto datatype_output = xpod::qlever::physicalMetadataFilterIdTable(
      metadata_qec, metadata_index, metadata_input, datatype_not_equal);
  if (!datatype_output.has_value() || datatype_output->numRows() != 1 ||
      (*datatype_output)(0, 0).getBits() != 1101) {
    return 247;
  }
  qec_cache_modes.clear();

  xpod_qlever_adapter_config config = {};
  config.backend = &backend;
  config.execution_policy = XPOD_QLEVER_EXECUTION_COMPATIBILITY_ALLOWED;

  xpod_qlever_adapter* adapter = nullptr;
  if (xpod_qlever_adapter_create(&config, &adapter) != XPOD_RDF_STATUS_OK) return 1;
  if (!qec_cache_modes.empty()) return 47;
  if (xpod_test_disable_caching) return 53;

  xpod_qlever_query_result result = {};
  xpod_rdf_bytes query = {"SELECT ?s ?p ?o WHERE { ?s ?p ?o . ?s <urn:type> <urn:Thing> }", 62};
  xpod_rdf_access_scope access = {};
  access.principal = {"urn:alice", 9};
  xpod_qlever_query_request request = {};
  request.sparql = query;
  request.snapshot.snapshot_token = {"snap-v1", 7};
  request.source_scope.local_path_prefix = {"/workspace/docs/", 16};
  request.access_scope = &access;
  xpod::qlever::xpodQleverDiagnosticsEnable();
  xpod_rdf_status status = xpod_qlever_adapter_query_request(adapter, &request, &result);
  if (qec_cache_modes != "U") return 48;
  std::string_view body(result.result_json.data, result.result_json.size);
  std::string_view profile(result.profile_json.data, result.profile_json.size);
  std::string diagnostics = xpod::qlever::xpodQleverDiagnosticsJson();
  if (status != XPOD_RDF_STATUS_OK) return 2;
  if (result.status != XPOD_RDF_STATUS_OK) return 3;
  if (body.find("\\"head\\":{\\"vars\\":[\\"s\\",\\"p\\",\\"o\\"]}") == std::string_view::npos) return 4;
  if (body.find("\\"s\\":{\\"type\\":\\"uri\\",\\"value\\":\\"urn:s\\"}") == std::string_view::npos) return 5;
  if (body.find("\\"o\\":{\\"type\\":\\"literal\\",\\"value\\":\\"value\\"") == std::string_view::npos) return 8;
  if (body.find("urn:other") == std::string_view::npos) return 9;
  if (scan_state.calls != 1) return 16;
  if (profile.empty()) return 238;
  if (profile.find("\\"kind\\":") == std::string_view::npos) return 239;
  if (profile.find("\\"executionMode\\":\\"native-qlever-tree\\"") == std::string_view::npos) return 248;
  if (profile.find("\\"outputRows\\":2") == std::string_view::npos) return 11;
  if (profile.find("\\"descriptor\\":\\"IndexScan SPO ?s ?p ?o\\"") == std::string_view::npos) return 12;
  if (diagnostics.find("\\"executionMode\\":\\"native-qlever-tree\\"") == std::string::npos) return 249;
  if (!has_json_number(diagnostics, "parse-plan")) return 145;
  if (!has_json_number(diagnostics, "backend-scan")) return 146;
  if (!has_json_number(diagnostics, "id-table-materialization")) return 147;
  if (!has_json_number(diagnostics, "algebra-execution")) return 148;
  if (!has_json_number(diagnostics, "term-resolution")) return 149;
  if (!has_json_number(diagnostics, "serialization")) return 150;
  if (diagnostics.find("\\"backendScanCount\\":1") == std::string::npos) return 151;
  if (diagnostics.find("\\"backendRows\\":2") == std::string::npos) return 152;
  if (diagnostics.find("\\"backendBytes\\":" + std::to_string(2 * sizeof(xpod_rdf_quad_key))) == std::string::npos) return 153;
  xpod::qlever::xpodQleverDiagnosticsDisable();
  if (!xpod::qlever::xpodQleverDiagnosticsJson().empty()) return 154;

  xpod_qlever_adapter_release_result(adapter, &result);

  std::string native_result_storage;
  std::string native_profile_storage;
  std::string native_error_storage;
  xpod::qlever::xpodQleverDiagnosticsEnable();
  status = xpod::qlever::executeNativeQleverQueryWithPlannerContext(
      xpod::rdf::PhysicalBackend(&backend),
      xpod::qlever::PlannerContextHandle{&metadata_qec, nullptr},
      request,
      result,
      native_result_storage,
      native_profile_storage,
      native_error_storage);
  std::string_view native_profile(result.profile_json.data, result.profile_json.size);
  std::string native_diagnostics = xpod::qlever::xpodQleverDiagnosticsJson();
  if (status != XPOD_RDF_STATUS_OK) return 250;
  if (native_profile.find("\\"executionMode\\":\\"native-qlever-tree\\"") == std::string_view::npos) return 252;
  if (native_diagnostics.find("\\"executionMode\\":\\"native-qlever-tree\\"") == std::string::npos) return 253;
  xpod::qlever::xpodQleverDiagnosticsDisable();

  std::string native_unavailable_result_storage;
  std::string native_unavailable_profile_storage;
  std::string native_unavailable_error_storage;
  xpod::qlever::xpodQleverDiagnosticsEnable();
  status = xpod::qlever::executeNativeQleverQueryWithPlannerContext(
      xpod::rdf::PhysicalBackend(&backend),
      xpod::qlever::PlannerContextHandle{},
      request,
      result,
      native_unavailable_result_storage,
      native_unavailable_profile_storage,
      native_unavailable_error_storage);
  std::string native_unavailable_diagnostics =
      xpod::qlever::xpodQleverDiagnosticsJson();
  if (status != XPOD_RDF_STATUS_UNSUPPORTED) return 254;
  if (native_unavailable_diagnostics.find(
          "\\"executionMode\\":\\"native-qlever-tree\\"") == std::string::npos) return 255;
  xpod::qlever::xpodQleverDiagnosticsDisable();

  const char filter_sparql[] =
      "SELECT ?o WHERE { ?s <urn:numeric> ?o . FILTER(?o > 8) } ORDER BY ?o LIMIT 2";
  xpod_qlever_query_request filter_request = {};
  filter_request.sparql = {filter_sparql, sizeof(filter_sparql) - 1};
  filter_request.snapshot.snapshot_token = {"snap-v1", 7};
  filter_request.source_scope = request.source_scope;
  filter_request.access_scope = request.access_scope;
  const int calls_before_filter = scan_state.calls;
  const int lookups_before_filter = numeric_literal_lookup_calls;
  physical_capability_features =
      XPOD_RDF_BACKEND_FEATURE_SCAN_FILTER |
      XPOD_RDF_BACKEND_FEATURE_SCAN_VALUE_RANGE;
  status = xpod_qlever_adapter_query_request(
      adapter, &filter_request, &result);
  body = std::string_view(result.result_json.data, result.result_json.size);
  profile = std::string_view(result.profile_json.data, result.profile_json.size);
  if (status != XPOD_RDF_STATUS_OK) {
    std::fwrite(result.error_message.data, 1, result.error_message.size, stderr);
    std::fputc('\\n', stderr);
    return 180;
  }
  if (result.status != XPOD_RDF_STATUS_OK) return 181;
  if (scan_state.calls != calls_before_filter + 1) return 182;
  if (scan_state.last_filter_count != 1) return 183;
  if (scan_state.last_filter_kind !=
      XPOD_RDF_SCAN_FILTER_VALUE_GREATER_THAN) return 184;
  if (profile.find("\\"kind\\":\\"PermutationScan\\"") ==
      std::string_view::npos) return 185;
  if (profile.find("\\"executionMode\\":\\"compatibility-bounded-physical\\"") ==
      std::string_view::npos) return 256;
  if (!scan_state.saw_context) return 186;
  if (body.find("\\"head\\":{\\"vars\\":[\\"o\\"]}") ==
      std::string_view::npos) return 193;
  if (count_substring(body, "\\"o\\":{") != 1) return 194;
  if (body.find("\\"value\\":\\"11\\"") ==
      std::string_view::npos) return 195;
  if (body.find("\\"value\\":\\"7\\"") !=
      std::string_view::npos) return 196;
  if (numeric_literal_lookup_calls != lookups_before_filter + 2) return 200;
  xpod_qlever_adapter_release_result(adapter, &result);

  const int calls_before_probe_error_filter = scan_state.calls;
  const int lookups_before_probe_error = numeric_literal_lookup_calls;
  scan_state.last_limit = 999;
  fail_numeric_filter_lookup = true;
  status = xpod_qlever_adapter_query_request(
      adapter, &filter_request, &result);
  fail_numeric_filter_lookup = false;
  body = std::string_view(result.result_json.data, result.result_json.size);
  if (status != XPOD_RDF_STATUS_OK) return 201;
  if (result.status != XPOD_RDF_STATUS_OK) return 202;
  if (result.error_message.size != 0) return 203;
  const int calls_after_probe_error_filter = scan_state.calls;
  if (calls_after_probe_error_filter >
      calls_before_probe_error_filter + 1) return 204;
  if (calls_after_probe_error_filter != calls_before_probe_error_filter) {
    if (scan_state.last_filter_count != 0) return 205;
    if (scan_state.last_limit == 2) return 206;
  }
  if (numeric_literal_lookup_calls != lookups_before_probe_error + 1) return 207;
  if (body.find("\\"head\\":{\\"vars\\":[\\"o\\"]}") ==
      std::string_view::npos) return 208;
  if (body.find("\\"results\\":{\\"bindings\\":[") ==
      std::string_view::npos) return 209;
  xpod_qlever_adapter_release_result(adapter, &result);
  physical_capability_features = 0;

  const int calls_before_unaccelerated_filter = scan_state.calls;
  scan_state.last_limit = 999;
  status = xpod_qlever_adapter_query_request(
      adapter, &filter_request, &result);
  body = std::string_view(result.result_json.data, result.result_json.size);
  if (status != XPOD_RDF_STATUS_OK) return 187;
  if (result.status != XPOD_RDF_STATUS_OK) return 188;
  if (scan_state.calls != calls_before_unaccelerated_filter + 1) return 189;
  if (scan_state.last_filter_count != 0) return 190;
  if (scan_state.last_limit == 2) return 191;
  if (body.find("\\"head\\":{\\"vars\\":[\\"o\\"]}") ==
      std::string_view::npos) return 192;
  if (count_substring(body, "\\"o\\":{") != 1) return 197;
  if (body.find("\\"value\\":\\"11\\"") ==
      std::string_view::npos) return 198;
  if (body.find("\\"value\\":\\"7\\"") !=
      std::string_view::npos) return 199;

  xpod_qlever_adapter_release_result(adapter, &result);

  physical_capability_features = XPOD_RDF_BACKEND_FEATURE_SCAN_FILTER;
  const char lcase_filter_sparql[] =
      "SELECT ?o WHERE { ?s ?p ?o . FILTER(LCASE(STR(?o)) = \\"value\\") } ORDER BY ?o LIMIT 2";
  xpod_qlever_query_request lcase_filter_request = {};
  lcase_filter_request.sparql = {
      lcase_filter_sparql, sizeof(lcase_filter_sparql) - 1};
  lcase_filter_request.snapshot.snapshot_token = {"snap-v1", 7};
  lcase_filter_request.source_scope = request.source_scope;
  lcase_filter_request.access_scope = request.access_scope;
  const int native_filter_plans_before_lcase = native_filter_plan_calls;
  scan_state.physical_filter_observations = 0;
  scan_state.last_filter_count = 0;
  scan_state.last_limit = 0;
  xpod::qlever::xpodQleverDiagnosticsEnable();
  status = xpod_qlever_adapter_query_request(
      adapter, &lcase_filter_request, &result);
  body = std::string_view(result.result_json.data, result.result_json.size);
  std::string lcase_diagnostics =
      xpod::qlever::xpodQleverDiagnosticsJson();
  if (status != XPOD_RDF_STATUS_OK) return 210;
  if (result.status != XPOD_RDF_STATUS_OK) return 211;
  if (body.find("\\"head\\":{\\"vars\\":[\\"o\\"]}") ==
      std::string_view::npos) return 212;
  if (native_filter_plan_calls <= native_filter_plans_before_lcase) return 227;
  if (count_substring(body, "\\"o\\":{") != 1) return 224;
  if (body.find("\\"value\\":\\"value\\"") == std::string_view::npos) return 225;
  if (body.find("\\"value\\":\\"filtered\\"") != std::string_view::npos) return 226;
  if (scan_state.physical_filter_observations != 0) return 229;
  if (scan_state.last_limit == 2) return 230;
  std::optional<std::string> lcase_reason =
      json_string_field(lcase_diagnostics, "filterFallbackReason");
  if (!lcase_reason.has_value() ||
      *lcase_reason != "string-transform-lowercase-unsupported") return 213;
  std::optional<std::string> lcase_expression =
      json_string_field(lcase_diagnostics, "filterFallbackExpression");
  if (!lcase_expression.has_value() ||
      *lcase_expression != "LCASE(STR(?o)) = \\"value\\"") return 214;
  xpod_qlever_adapter_release_result(adapter, &result);

  const char contains_filter_sparql[] =
      "SELECT ?o WHERE { ?s ?p ?o . FILTER(CONTAINS(STR(?s), \\"literal\\")) } ORDER BY ?o LIMIT 2";
  xpod_qlever_query_request contains_filter_request = {};
  contains_filter_request.sparql = {
      contains_filter_sparql, sizeof(contains_filter_sparql) - 1};
  contains_filter_request.snapshot.snapshot_token = {"snap-v1", 7};
  contains_filter_request.source_scope = request.source_scope;
  contains_filter_request.access_scope = request.access_scope;
  status = xpod_qlever_adapter_query_request(
      adapter, &contains_filter_request, &result);
  std::string contains_diagnostics =
      xpod::qlever::xpodQleverDiagnosticsJson();
  if (status != XPOD_RDF_STATUS_OK) return 216;
  if (result.status != XPOD_RDF_STATUS_OK) return 217;
  if (!json_null_field(contains_diagnostics, "filterFallbackReason")) return 218;
  if (!json_null_field(contains_diagnostics, "filterFallbackExpression")) return 219;
  xpod_qlever_adapter_release_result(adapter, &result);

  const char ucase_filter_sparql[] =
      "SELECT ?o WHERE { ?s ?p ?o . FILTER(UCASE(STR(?o)) = \\"VALUE\\") } ORDER BY ?o LIMIT 2";
  xpod_qlever_query_request ucase_filter_request = {};
  ucase_filter_request.sparql = {
      ucase_filter_sparql, sizeof(ucase_filter_sparql) - 1};
  ucase_filter_request.snapshot.snapshot_token = {"snap-v1", 7};
  ucase_filter_request.source_scope = request.source_scope;
  ucase_filter_request.access_scope = request.access_scope;
  const int native_filter_plans_before_ucase = native_filter_plan_calls;
  scan_state.physical_filter_observations = 0;
  scan_state.last_filter_count = 0;
  scan_state.last_limit = 0;
  status = xpod_qlever_adapter_query_request(
      adapter, &ucase_filter_request, &result);
  body = std::string_view(result.result_json.data, result.result_json.size);
  std::string ucase_diagnostics =
      xpod::qlever::xpodQleverDiagnosticsJson();
  if (status != XPOD_RDF_STATUS_OK) return 220;
  if (result.status != XPOD_RDF_STATUS_OK) return 221;
  if (native_filter_plan_calls <= native_filter_plans_before_ucase) return 234;
  if (count_substring(body, "\\"o\\":{") != 1) return 231;
  if (body.find("\\"value\\":\\"value\\"") == std::string_view::npos) return 232;
  if (body.find("\\"value\\":\\"filtered\\"") != std::string_view::npos) return 233;
  if (scan_state.physical_filter_observations != 0) return 236;
  if (scan_state.last_limit == 2) return 237;
  std::optional<std::string> ucase_reason =
      json_string_field(ucase_diagnostics, "filterFallbackReason");
  if (!ucase_reason.has_value() ||
      *ucase_reason != "string-transform-uppercase-unsupported") return 222;
  std::optional<std::string> ucase_expression =
      json_string_field(ucase_diagnostics, "filterFallbackExpression");
  if (!ucase_expression.has_value() ||
      *ucase_expression != "UCASE(STR(?o)) = \\"VALUE\\"") return 223;
  xpod::qlever::xpodQleverDiagnosticsDisable();
  xpod_qlever_adapter_release_result(adapter, &result);
  physical_capability_features = 0;

  xpod_rdf_bytes ask_query = {"ASK { ?s ?p ?o }", 16};
  xpod_qlever_query_request ask_request = {};
  ask_request.sparql = ask_query;
  ask_request.snapshot.snapshot_token = {"snap-v1", 7};
  ask_request.source_scope.local_path_prefix = {"/workspace/docs/", 16};
  ask_request.access_scope = &access;
  status = xpod_qlever_adapter_query_request(adapter, &ask_request, &result);
  std::string_view ask_body(result.result_json.data, result.result_json.size);
  std::string_view ask_profile(result.profile_json.data, result.profile_json.size);
  if (status != XPOD_RDF_STATUS_OK) return 6;
  if (ask_body.find("\\"boolean\\":true") == std::string_view::npos) return 7;
  if (ask_profile.find("Ask") == std::string_view::npos) return 17;
  if (ask_profile.find("PermutationScan") == std::string_view::npos) return 18;
  if (ask_profile.find("}]}") == std::string_view::npos) return 19;

  xpod_qlever_adapter_release_result(adapter, &result);

  vector_capability_enabled = true;
  const char join_sparql[] =
      "# TwoHopJoin\\nSELECT ?s ?x WHERE { ?s <urn:p> ?o . ?o <urn:p> ?x }";
  xpod_qlever_query_request join_request = {};
  join_request.sparql = {join_sparql, sizeof(join_sparql) - 1};
  join_request.snapshot.snapshot_token = {"snap-v1", 7};
  join_request.source_scope.local_path_prefix = {"/workspace/docs/", 16};
  join_request.access_scope = &access;
  status = xpod_qlever_adapter_query_request(
      adapter, &join_request, &result);
  std::string_view native_join_body(
      result.result_json.data, result.result_json.size);
  std::string_view native_join_profile(
      result.profile_json.data, result.profile_json.size);
  if (status != XPOD_RDF_STATUS_OK) {
    std::fprintf(
        stderr, "native join status=%d error=%.*s\\n",
        static_cast<int>(status),
        static_cast<int>(result.error_message.size),
        result.error_message.data);
    return 169;
  }
  if (result.error_message.size != 0) return 174;
  if (native_join_body.find(
          "\\"head\\":{\\"vars\\":[\\"s\\",\\"x\\"]}") ==
      std::string_view::npos) return 175;
  if (native_join_body.find(
          "\\"s\\":{\\"type\\":\\"uri\\",\\"value\\":\\"urn:s\\"}") ==
      std::string_view::npos) return 176;
  if (native_join_profile.find("\\"details\\":") == std::string_view::npos) return 170;
  if (native_join_profile.find("\\"cacheStatus\\":\\"computed\\"") ==
      std::string_view::npos) return 177;
  if (native_join_profile.find("\\"parameterized\\":true") == std::string_view::npos) return 171;
  if (native_join_profile.find("\\"dependentBackendRows\\":2") == std::string_view::npos) return 172;
  if (native_join_profile.find("\\"fallbackReason\\":null") == std::string_view::npos) return 173;
  xpod_qlever_adapter_release_result(adapter, &result);

  std::string join_result_storage;
  std::string join_profile_storage;
  std::string join_error_storage;
  status = xpod::qlever::executeBridgeQueryWithPlannerContext(
      xpod::rdf::PhysicalBackend(&backend),
      xpod::qlever::PlannerContextHandle{},
      join_request,
      result,
      join_result_storage,
      join_profile_storage,
      join_error_storage);
  std::string_view join_profile(result.profile_json.data, result.profile_json.size);
  if (status != XPOD_RDF_STATUS_OK) return 161;
  if (join_profile.find("\\"kind\\":\\"HashJoin\\"") == std::string_view::npos) return 162;
  if (join_profile.find("\\"executionMode\\":\\"compatibility-parameterized-join\\"") == std::string_view::npos) return 257;
  if (join_profile.find("\\"details\\":") == std::string_view::npos) return 163;
  if (join_profile.find("\\"parameterized\\":true") == std::string_view::npos) return 164;
  if (join_profile.find("\\"seedRows\\":2") == std::string_view::npos) return 165;
  if (join_profile.find("\\"uniqueJoinTuples\\":2") == std::string_view::npos) return 166;
  if (join_profile.find("\\"dependentBackendRows\\":2") == std::string_view::npos) return 167;
  if (join_profile.find("\\"fallbackReason\\":null") == std::string_view::npos) return 168;
  vector_capability_enabled = false;

  const char operation_plan_sparql[] =
      "SELECT ?s ?p ?o WHERE { ?s ?p ?o }";
  xpod_qlever_query_request operation_plan_request = {};
  operation_plan_request.sparql = {
      operation_plan_sparql, sizeof(operation_plan_sparql) - 1};
  operation_plan_request.snapshot.snapshot_token = {"snap-v1", 7};
  operation_plan_request.source_scope.local_path_prefix = {"/workspace/docs/", 16};
  operation_plan_request.access_scope = &access;
  std::string operation_result_storage;
  std::string operation_profile_storage;
  std::string operation_error_storage;
  xpod::qlever::xpodQleverDiagnosticsEnable();
  status = xpod::qlever::executeBridgeQueryWithPlannerContext(
      xpod::rdf::PhysicalBackend(&backend),
      xpod::qlever::PlannerContextHandle{},
      operation_plan_request,
      result,
      operation_result_storage,
      operation_profile_storage,
      operation_error_storage);
  std::string_view operation_profile(
      result.profile_json.data, result.profile_json.size);
  std::string operation_diagnostics =
      xpod::qlever::xpodQleverDiagnosticsJson();
  if (status != XPOD_RDF_STATUS_OK) return 265;
  if (operation_profile.find(
          "\\"executionMode\\":\\"compatibility-parsed-bgp\\"") ==
      std::string_view::npos) return 266;
  if (operation_diagnostics.find(
          "\\"executionMode\\":\\"compatibility-parsed-bgp\\"") ==
      std::string::npos) return 267;
  xpod::qlever::xpodQleverDiagnosticsDisable();

  std::string parsed_ask_result_storage;
  std::string parsed_ask_profile_storage;
  std::string parsed_ask_error_storage;
  xpod::qlever::xpodQleverDiagnosticsEnable();
  status = xpod::qlever::executeBridgeQueryWithPlannerContext(
      xpod::rdf::PhysicalBackend(&backend),
      xpod::qlever::PlannerContextHandle{},
      ask_request,
      result,
      parsed_ask_result_storage,
      parsed_ask_profile_storage,
      parsed_ask_error_storage);
  std::string_view parsed_ask_profile(
      result.profile_json.data, result.profile_json.size);
  std::string parsed_ask_diagnostics =
      xpod::qlever::xpodQleverDiagnosticsJson();
  if (status != XPOD_RDF_STATUS_OK) return 272;
  if (parsed_ask_profile.find(
          "\\"executionMode\\":\\"compatibility-parsed-bgp\\"") ==
      std::string_view::npos) return 273;
  if (parsed_ask_diagnostics.find(
          "\\"executionMode\\":\\"compatibility-parsed-bgp\\"") ==
      std::string::npos) return 274;
  xpod::qlever::xpodQleverDiagnosticsDisable();

  xpod_rdf_bytes broken_query = {"BROKEN { ?s ?p ?o }", 20};
  xpod::qlever::xpodQleverDiagnosticsEnable();
  status = xpod_qlever_adapter_query(adapter, broken_query, &result);
  std::string error_diagnostics = xpod::qlever::xpodQleverDiagnosticsJson();
  std::string_view error(result.error_message.data, result.error_message.size);
  if (status != XPOD_RDF_STATUS_UNSUPPORTED) return 13;
  if (error.find("failed to parse QLever bridge query") == std::string_view::npos) return 14;
  if (error_diagnostics.find("\\"executionMode\\":\\"compatibility-operation-plan\\"") == std::string::npos) return 258;
  if (error_diagnostics.find("\\"backendScanCount\\":0") == std::string::npos) return 155;
  xpod::qlever::xpodQleverDiagnosticsDisable();
  if (!xpod::qlever::xpodQleverDiagnosticsJson().empty()) return 156;

  xpod_qlever_adapter_release_result(adapter, &result);

  const char prepared_insert_sparql[] =
      "INSERT DATA { GRAPH <urn:g> { <urn:s> <urn:p> <urn:o> } }";
  const char prepared_media_type[] =
      "application/vnd.xpod.rdf-prepared-delta+json;version=1";
  xpod_qlever_query_request prepared_request = {};
  prepared_request.operation = XPOD_QLEVER_REQUEST_PREPARE_UPDATE;
  prepared_request.sparql = {
      prepared_insert_sparql, sizeof(prepared_insert_sparql) - 1};
  prepared_request.source_scope.source_uri = {"urn:g", 5};
  prepared_request.accept_media_type = {
      prepared_media_type, sizeof(prepared_media_type) - 1};
  const int source_scope_calls_before_existing_graph =
      source_scope_resolution_calls;
  const int graph_lookups_before_existing_graph = graph_lookup_calls;
  const int mutations_before_existing_graph = scan_state.mutation_calls;
  const int begins_before_existing_graph =
      scan_state.transaction_begin_calls;
  const int commits_before_existing_graph =
      scan_state.transaction_commit_calls;
  const int rollbacks_before_existing_graph =
      scan_state.transaction_rollback_calls;
  status = xpod_qlever_adapter_query_request(
      adapter, &prepared_request, &result);
  if (status != XPOD_RDF_STATUS_UNSUPPORTED) return 110;
  if (scan_state.mutation_calls != mutations_before_existing_graph) {
    return 111;
  }
  if (graph_lookup_calls != graph_lookups_before_existing_graph + 1) {
    return 112;
  }
  if (source_scope_resolution_calls !=
      source_scope_calls_before_existing_graph + 1) return 120;
  if (scan_state.transaction_begin_calls != begins_before_existing_graph + 1) {
    return 121;
  }
  if (scan_state.transaction_rollback_calls !=
      rollbacks_before_existing_graph + 1) return 122;
  if (scan_state.transaction_commit_calls != commits_before_existing_graph) {
    return 123;
  }
  if (scan_state.transaction_active ||
      scan_state.committed_prepared_quad_exists) return 124;

  xpod_qlever_adapter_release_result(adapter, &result);

  graph_lookup_status = XPOD_RDF_STATUS_NOT_FOUND;
  const int source_scope_calls_before_new_graph =
      source_scope_resolution_calls;
  const int graph_lookups_before_new_graph = graph_lookup_calls;
  const int mutations_before_new_graph = scan_state.mutation_calls;
  const int begins_before_new_graph = scan_state.transaction_begin_calls;
  const int commits_before_new_graph = scan_state.transaction_commit_calls;
  const int rollbacks_before_new_graph =
      scan_state.transaction_rollback_calls;
  status = xpod_qlever_adapter_query_request(
      adapter, &prepared_request, &result);
  body = std::string_view(result.result_json.data, result.result_json.size);
  std::string_view media_type(
      result.result_media_type.data, result.result_media_type.size);
  if (status != XPOD_RDF_STATUS_OK) return 75;
  if (media_type != prepared_media_type) return 76;
  if (body.find("\\"version\\":1") == std::string_view::npos) return 77;
  if (body.find("\\"graphIri\\":\\"urn:g\\"") == std::string_view::npos) return 78;
  if (body.find("\\"sourceUri\\":\\"urn:g\\"") == std::string_view::npos) return 79;
  if (body.find("\\"deletes\\":[]") == std::string_view::npos) return 80;
  if (body.find("\\"inserts\\":[{\\"subject\\":{\\"type\\":\\"uri\\",\\"value\\":\\"urn:s\\"}") == std::string_view::npos) return 81;
  if (body.find("\\"object\\":{\\"type\\":\\"uri\\",\\"value\\":\\"urn:o\\"}") == std::string_view::npos) return 82;
  if (scan_state.mutation_calls != mutations_before_new_graph + 1) return 83;
  if (source_scope_resolution_calls !=
      source_scope_calls_before_new_graph + 1) return 99;
  if (graph_lookup_calls != graph_lookups_before_new_graph + 2) return 113;
  if (scan_state.transaction_begin_calls != begins_before_new_graph + 1 ||
      scan_state.transaction_rollback_calls != rollbacks_before_new_graph + 1 ||
      scan_state.transaction_commit_calls != commits_before_new_graph ||
      scan_state.transaction_active ||
      scan_state.committed_prepared_quad_exists) return 125;
  if (std::fwrite(join_profile.data(), 1, join_profile.size(), stdout) != join_profile.size()) return 169;
  if (std::fputc('\\n', stdout) == EOF) return 170;
  if (std::fwrite(native_profile.data(), 1, native_profile.size(), stdout) != native_profile.size()) return 259;
  if (std::fputc('\\n', stdout) == EOF) return 260;
  if (std::fwrite(operation_profile.data(), 1, operation_profile.size(), stdout) != operation_profile.size()) return 268;
  if (std::fputc('\\n', stdout) == EOF) return 269;
  if (std::fwrite(diagnostics.data(), 1, diagnostics.size(), stdout) != diagnostics.size()) return 157;
  if (std::fputc('\\n', stdout) == EOF) return 158;
  if (std::fwrite(native_diagnostics.data(), 1, native_diagnostics.size(), stdout) != native_diagnostics.size()) return 261;
  if (std::fputc('\\n', stdout) == EOF) return 262;
  if (std::fwrite(operation_diagnostics.data(), 1, operation_diagnostics.size(), stdout) != operation_diagnostics.size()) return 270;
  if (std::fputc('\\n', stdout) == EOF) return 271;
  if (std::fwrite(parsed_ask_profile.data(), 1, parsed_ask_profile.size(), stdout) != parsed_ask_profile.size()) return 275;
  if (std::fputc('\\n', stdout) == EOF) return 276;
  if (std::fwrite(parsed_ask_diagnostics.data(), 1, parsed_ask_diagnostics.size(), stdout) != parsed_ask_diagnostics.size()) return 277;
  if (std::fputc('\\n', stdout) == EOF) return 278;
  if (std::fwrite(native_unavailable_diagnostics.data(), 1, native_unavailable_diagnostics.size(), stdout) != native_unavailable_diagnostics.size()) return 263;
  if (std::fputc('\\n', stdout) == EOF) return 264;
  if (std::fwrite(error_diagnostics.data(), 1, error_diagnostics.size(), stdout) != error_diagnostics.size()) return 159;
  if (std::fputc('\\n', stdout) == EOF) return 160;
  if (std::fwrite(body.data(), 1, body.size(), stdout) != body.size()) return 108;
  if (std::fputc('\\n', stdout) == EOF) return 109;

  xpod_qlever_adapter_release_result(adapter, &result);

  graph_lookup_status = XPOD_RDF_STATUS_OK;
  xpod_qlever_query_request existing_source_request = prepared_request;
  existing_source_request.source_scope.source_uri = {"urn:source", 10};
  const int source_scope_calls_before_existing_source =
      source_scope_resolution_calls;
  const int mutations_before_existing_source = scan_state.mutation_calls;
  const int begins_before_existing_source =
      scan_state.transaction_begin_calls;
  const int commits_before_existing_source =
      scan_state.transaction_commit_calls;
  const int rollbacks_before_existing_source =
      scan_state.transaction_rollback_calls;
  status = xpod_qlever_adapter_query_request(
      adapter, &existing_source_request, &result);
  body = std::string_view(result.result_json.data, result.result_json.size);
  if (status != XPOD_RDF_STATUS_OK) return 100;
  if (body.find("\\"sourceUri\\":\\"urn:source\\"") == std::string_view::npos) return 101;
  if (source_scope_resolution_calls !=
      source_scope_calls_before_existing_source + 1) return 102;
  if (scan_state.mutation_calls != mutations_before_existing_source + 1 ||
      scan_state.transaction_begin_calls != begins_before_existing_source + 1 ||
      scan_state.transaction_rollback_calls !=
          rollbacks_before_existing_source + 1 ||
      scan_state.transaction_commit_calls != commits_before_existing_source ||
      scan_state.transaction_active ||
      scan_state.committed_prepared_quad_exists) return 103;

  xpod_qlever_adapter_release_result(adapter, &result);

  graph_lookup_status = XPOD_RDF_STATUS_NOT_FOUND;
  const int graph_lookups_before_resolved_source_new_graph =
      graph_lookup_calls;
  const int mutation_calls_before_resolved_source_new_graph =
      scan_state.mutation_calls;
  status = xpod_qlever_adapter_query_request(
      adapter, &existing_source_request, &result);
  if (status != XPOD_RDF_STATUS_UNSUPPORTED) return 142;
  if (graph_lookup_calls !=
      graph_lookups_before_resolved_source_new_graph + 1) return 143;
  if (scan_state.mutation_calls !=
      mutation_calls_before_resolved_source_new_graph) return 144;
  graph_lookup_status = XPOD_RDF_STATUS_OK;

  xpod_qlever_adapter_release_result(adapter, &result);

  const xpod_rdf_bytes malformed_graph_prefixes[] = {{nullptr, 1}};

  xpod_qlever_query_request malformed_request_prefix =
      existing_source_request;
  malformed_request_prefix.graph_scope.kind = XPOD_RDF_GRAPH_SCOPE_PREFIX;
  malformed_request_prefix.graph_scope.iri_prefix =
      malformed_graph_prefixes[0];
  const int source_scope_calls_before_malformed_request_prefix =
      source_scope_resolution_calls;
  const int mutation_calls_before_malformed_request_prefix =
      scan_state.mutation_calls;
  status = xpod_qlever_adapter_query_request(
      adapter, &malformed_request_prefix, &result);
  if (status != XPOD_RDF_STATUS_UNSUPPORTED) return 130;
  if (scan_state.mutation_calls !=
      mutation_calls_before_malformed_request_prefix) return 131;
  if (source_scope_resolution_calls !=
      source_scope_calls_before_malformed_request_prefix) return 132;

  xpod_qlever_adapter_release_result(adapter, &result);

  xpod_qlever_query_request malformed_resolved_prefix =
      existing_source_request;
  malformed_resolved_prefix.source_scope.source_uri =
      {"urn:bad-prefix", 14};
  const int source_scope_calls_before_malformed_resolved_prefix =
      source_scope_resolution_calls;
  const int mutation_calls_before_malformed_resolved_prefix =
      scan_state.mutation_calls;
  status = xpod_qlever_adapter_query_request(
      adapter, &malformed_resolved_prefix, &result);
  if (status != XPOD_RDF_STATUS_UNSUPPORTED) return 133;
  if (scan_state.mutation_calls !=
      mutation_calls_before_malformed_resolved_prefix) return 134;
  if (source_scope_resolution_calls !=
      source_scope_calls_before_malformed_resolved_prefix + 1) return 135;

  xpod_qlever_adapter_release_result(adapter, &result);

  xpod_rdf_access_scope malformed_allowed_prefix_access = {};
  malformed_allowed_prefix_access.allowed_graph_prefixes =
      malformed_graph_prefixes;
  malformed_allowed_prefix_access.allowed_graph_prefixes_size = 1;
  xpod_qlever_query_request malformed_allowed_prefix =
      existing_source_request;
  malformed_allowed_prefix.access_scope = &malformed_allowed_prefix_access;
  const int source_scope_calls_before_malformed_allowed_prefix =
      source_scope_resolution_calls;
  const int mutation_calls_before_malformed_allowed_prefix =
      scan_state.mutation_calls;
  status = xpod_qlever_adapter_query_request(
      adapter, &malformed_allowed_prefix, &result);
  if (status != XPOD_RDF_STATUS_UNSUPPORTED) return 136;
  if (scan_state.mutation_calls !=
      mutation_calls_before_malformed_allowed_prefix) return 137;
  if (source_scope_resolution_calls !=
      source_scope_calls_before_malformed_allowed_prefix + 1) return 138;

  xpod_qlever_adapter_release_result(adapter, &result);

  xpod_rdf_access_scope malformed_denied_prefix_access = {};
  malformed_denied_prefix_access.denied_graph_prefixes =
      malformed_graph_prefixes;
  malformed_denied_prefix_access.denied_graph_prefixes_size = 1;
  xpod_qlever_query_request malformed_denied_prefix =
      existing_source_request;
  malformed_denied_prefix.access_scope = &malformed_denied_prefix_access;
  const int source_scope_calls_before_malformed_denied_prefix =
      source_scope_resolution_calls;
  const int mutation_calls_before_malformed_denied_prefix =
      scan_state.mutation_calls;
  status = xpod_qlever_adapter_query_request(
      adapter, &malformed_denied_prefix, &result);
  if (status != XPOD_RDF_STATUS_UNSUPPORTED) return 139;
  if (scan_state.mutation_calls !=
      mutation_calls_before_malformed_denied_prefix) return 140;
  if (source_scope_resolution_calls !=
      source_scope_calls_before_malformed_denied_prefix + 1) return 141;

  xpod_qlever_adapter_release_result(adapter, &result);

  graph_lookup_status = XPOD_RDF_STATUS_NOT_FOUND;
  const char prepared_delete_sparql[] =
      "DELETE DATA { GRAPH <urn:g> { <urn:s> <urn:p> <urn:o> } }";
  xpod_qlever_query_request prepared_delete_request = prepared_request;
  prepared_delete_request.sparql = {
      prepared_delete_sparql, sizeof(prepared_delete_sparql) - 1};
  const int mutations_before_prepared_delete = scan_state.mutation_calls;
  const int begins_before_prepared_delete =
      scan_state.transaction_begin_calls;
  const int rollbacks_before_prepared_delete =
      scan_state.transaction_rollback_calls;
  status = xpod_qlever_adapter_query_request(
      adapter, &prepared_delete_request, &result);
  body = std::string_view(result.result_json.data, result.result_json.size);
  if (status != XPOD_RDF_STATUS_OK) return 93;
  if (body.find("\\"graphs\\":[]") == std::string_view::npos) return 94;
  if (scan_state.mutation_calls != mutations_before_prepared_delete + 1 ||
      scan_state.transaction_begin_calls != begins_before_prepared_delete + 1 ||
      scan_state.transaction_rollback_calls !=
          rollbacks_before_prepared_delete + 1 ||
      scan_state.transaction_active ||
      scan_state.committed_prepared_quad_exists) return 96;

  const int mutation_calls_after_prepared_delete =
      scan_state.mutation_calls;

  xpod_qlever_adapter_release_result(adapter, &result);

  xpod_rdf_term_key denied_prepared_graph = 40;
  xpod_rdf_access_scope denied_prepared_access = {};
  denied_prepared_access.denied_graphs = &denied_prepared_graph;
  denied_prepared_access.denied_graphs_size = 1;
  graph_lookup_status = XPOD_RDF_STATUS_OK;
  xpod_qlever_query_request denied_prepared_request = existing_source_request;
  denied_prepared_request.access_scope = &denied_prepared_access;
  status = xpod_qlever_adapter_query_request(
      adapter, &denied_prepared_request, &result);
  if (status != XPOD_RDF_STATUS_PERMISSION_DENIED) return 84;
  if (scan_state.mutation_calls != mutation_calls_after_prepared_delete) return 85;

  xpod_qlever_adapter_release_result(adapter, &result);

  xpod_qlever_query_request ambiguous_source_request = prepared_request;
  ambiguous_source_request.source_scope.source_uri = {"urn:ambiguous", 13};
  const int source_scope_calls_before_ambiguous =
      source_scope_resolution_calls;
  status = xpod_qlever_adapter_query_request(
      adapter, &ambiguous_source_request, &result);
  if (status != XPOD_RDF_STATUS_UNSUPPORTED) return 86;
  if (scan_state.mutation_calls != mutation_calls_after_prepared_delete) return 87;
  if (source_scope_resolution_calls !=
      source_scope_calls_before_ambiguous + 1) return 104;

  xpod_qlever_adapter_release_result(adapter, &result);

  const int source_scope_calls_before_backend_error =
      source_scope_resolution_calls;
  const int graph_lookups_before_source_backend_error = graph_lookup_calls;
  const int mutation_calls_before_source_backend_error =
      scan_state.mutation_calls;
  source_scope_resolution_status = XPOD_RDF_STATUS_BACKEND_ERROR;
  status = xpod_qlever_adapter_query_request(
      adapter, &prepared_request, &result);
  source_scope_resolution_status = XPOD_RDF_STATUS_OK;
  if (status != XPOD_RDF_STATUS_BACKEND_ERROR) return 145;
  if (source_scope_resolution_calls !=
      source_scope_calls_before_backend_error + 1) return 146;
  if (graph_lookup_calls != graph_lookups_before_source_backend_error) {
    return 147;
  }
  if (scan_state.mutation_calls !=
      mutation_calls_before_source_backend_error) return 148;

  xpod_qlever_adapter_release_result(adapter, &result);

  xpod_qlever_query_request prefix_source_request = prepared_request;
  prefix_source_request.source_scope.source_uri = {};
  prefix_source_request.source_scope.source_uri_prefix = {"urn:", 4};
  const int source_scope_calls_before_prefix =
      source_scope_resolution_calls;
  resolve_graph_source = true;
  status = xpod_qlever_adapter_query_request(
      adapter, &prefix_source_request, &result);
  resolve_graph_source = false;
  body = std::string_view(result.result_json.data, result.result_json.size);
  if (status != XPOD_RDF_STATUS_OK) return 105;
  if (source_scope_resolution_calls !=
      source_scope_calls_before_prefix + 1) return 106;
  if (body.find("\\\"sourceUri\\\":\\\"urn:g\\\"") ==
      std::string_view::npos) return 149;
  if (scan_state.mutation_calls != mutation_calls_after_prepared_delete + 1) return 107;

  const int mutation_calls_after_prefix = scan_state.mutation_calls;

  xpod_qlever_adapter_release_result(adapter, &result);

  xpod_qlever_query_request mismatched_prefix_request = prefix_source_request;
  mismatched_prefix_request.source_scope.source_uri_prefix = {"https:", 6};
  const int source_scope_calls_before_mismatched_prefix =
      source_scope_resolution_calls;
  graph_lookup_status = XPOD_RDF_STATUS_NOT_FOUND;
  status = xpod_qlever_adapter_query_request(
      adapter, &mismatched_prefix_request, &result);
  graph_lookup_status = XPOD_RDF_STATUS_OK;
  if (status != XPOD_RDF_STATUS_UNSUPPORTED) return 150;
  if (source_scope_resolution_calls !=
      source_scope_calls_before_mismatched_prefix) return 151;
  if (scan_state.mutation_calls != mutation_calls_after_prefix) return 152;

  xpod_qlever_adapter_release_result(adapter, &result);

  xpod_qlever_query_request explicit_mismatched_prefix_request = prepared_request;
  explicit_mismatched_prefix_request.source_scope.source_uri_prefix =
      {"https:", 6};
  const int source_scope_calls_before_explicit_mismatched_prefix =
      source_scope_resolution_calls;
  graph_lookup_status = XPOD_RDF_STATUS_NOT_FOUND;
  status = xpod_qlever_adapter_query_request(
      adapter, &explicit_mismatched_prefix_request, &result);
  graph_lookup_status = XPOD_RDF_STATUS_OK;
  if (status != XPOD_RDF_STATUS_UNSUPPORTED) return 159;
  if (source_scope_resolution_calls !=
      source_scope_calls_before_explicit_mismatched_prefix) return 160;
  if (scan_state.mutation_calls != mutation_calls_after_prefix) return 161;

  xpod_qlever_adapter_release_result(adapter, &result);

  xpod_qlever_query_request malformed_source_uri_request = prepared_request;
  malformed_source_uri_request.source_scope.source_uri = {nullptr, 1};
  const int source_scope_calls_before_malformed_source_uri =
      source_scope_resolution_calls;
  status = xpod_qlever_adapter_query_request(
      adapter, &malformed_source_uri_request, &result);
  if (status != XPOD_RDF_STATUS_UNSUPPORTED) return 153;
  if (source_scope_resolution_calls !=
      source_scope_calls_before_malformed_source_uri) return 154;
  if (scan_state.mutation_calls != mutation_calls_after_prefix) return 155;

  xpod_qlever_adapter_release_result(adapter, &result);

  xpod_qlever_query_request malformed_source_prefix_request = prepared_request;
  malformed_source_prefix_request.source_scope.source_uri = {};
  malformed_source_prefix_request.source_scope.source_uri_prefix = {nullptr, 1};
  const int source_scope_calls_before_malformed_source_prefix =
      source_scope_resolution_calls;
  status = xpod_qlever_adapter_query_request(
      adapter, &malformed_source_prefix_request, &result);
  if (status != XPOD_RDF_STATUS_UNSUPPORTED) return 156;
  if (source_scope_resolution_calls !=
      source_scope_calls_before_malformed_source_prefix) return 157;
  if (scan_state.mutation_calls != mutation_calls_after_prefix) return 158;

  xpod_qlever_adapter_release_result(adapter, &result);

  xpod_qlever_query_request mismatched_source_request = prepared_request;
  mismatched_source_request.source_scope.source_uri = {"urn:other", 9};
  const int graph_lookups_before_backend_error = graph_lookup_calls;
  graph_lookup_status = XPOD_RDF_STATUS_BACKEND_ERROR;
  status = xpod_qlever_adapter_query_request(
      adapter, &mismatched_source_request, &result);
  if (status != XPOD_RDF_STATUS_BACKEND_ERROR) return 114;
  if (scan_state.mutation_calls != mutation_calls_after_prefix) return 115;
  if (graph_lookup_calls != graph_lookups_before_backend_error + 1) return 116;
  graph_lookup_status = XPOD_RDF_STATUS_OK;

  xpod_qlever_adapter_release_result(adapter, &result);

  const int graph_lookups_before_not_found = graph_lookup_calls;
  graph_lookup_status = XPOD_RDF_STATUS_NOT_FOUND;
  status = xpod_qlever_adapter_query_request(
      adapter, &mismatched_source_request, &result);
  if (status != XPOD_RDF_STATUS_UNSUPPORTED) return 117;
  if (scan_state.mutation_calls != mutation_calls_after_prefix) return 118;
  if (graph_lookup_calls != graph_lookups_before_not_found + 1) return 119;
  graph_lookup_status = XPOD_RDF_STATUS_OK;

  xpod_qlever_adapter_release_result(adapter, &result);

  const std::string_view lifecycle_queries[] = {
      "LOAD <urn:source> INTO GRAPH <urn:g>",
      "CREATE GRAPH <urn:g>",
      "DROP GRAPH <urn:g>",
      "CLEAR GRAPH <urn:g>",
      "COPY GRAPH <urn:g> TO GRAPH <urn:other>",
      "MOVE GRAPH <urn:g> TO GRAPH <urn:other>",
      "ADD GRAPH <urn:g> TO GRAPH <urn:other>",
  };
  for (const std::string_view lifecycle_sparql : lifecycle_queries) {
    xpod_qlever_query_request lifecycle_request = prepared_request;
    lifecycle_request.sparql = {
        lifecycle_sparql.data(), lifecycle_sparql.size()};
    status = xpod_qlever_adapter_query_request(
        adapter, &lifecycle_request, &result);
    if (status != XPOD_RDF_STATUS_UNSUPPORTED) return 88;
    if (scan_state.mutation_calls != mutation_calls_after_prefix) return 89;
    xpod_qlever_adapter_release_result(adapter, &result);
  }

  vector_capability_enabled = true;
  double vector_values[2] = {0.25, 0.75};
  xpod_qlever_vector_query vector_query = {};
  vector_query.vector = vector_values;
  vector_query.dimensions = 2;
  vector_query.provider = {"xpod", 4};
  vector_query.model = {"embed-v1", 8};
  vector_query.model_version = {"2026-08-12", 10};
  vector_query.input_kind = {"entity-card", 11};
  vector_query.projection_policy_version = {"policy-v1", 9};
  vector_query.metric = XPOD_RDF_VECTOR_COSINE;
  vector_query.limit = 1;
  vector_query.retrieval_point_variable = {"?retrieval", 10};
  vector_query.resource_variable = {"?resource", 9};
  xpod_rdf_term_key denied_graph = 77;
  xpod_rdf_access_scope vector_access = {};
  vector_access.denied_graphs = &denied_graph;
  vector_access.denied_graphs_size = 1;

  const char invalid_vector_sparql[] = "BROKEN vector query";
  xpod_qlever_query_request invalid_vector_request = {};
  invalid_vector_request.sparql = {
      invalid_vector_sparql, sizeof(invalid_vector_sparql) - 1};
  invalid_vector_request.vector_query = &vector_query;
  invalid_vector_request.access_scope = &vector_access;
  const int vector_estimate_calls_before_invalid =
      scan_state.vector_estimate_calls;
  const int vector_calls_before_invalid = scan_state.vector_calls;
  status = xpod_qlever_adapter_query_request(
      adapter, &invalid_vector_request, &result);
  error = std::string_view(result.error_message.data, result.error_message.size);
  if (status != XPOD_RDF_STATUS_UNSUPPORTED) return 20;
  if (error.find("failed to parse QLever bridge query") == std::string_view::npos) return 21;
  if (scan_state.vector_estimate_calls !=
      vector_estimate_calls_before_invalid) return 54;
  if (scan_state.vector_calls != vector_calls_before_invalid) return 22;

  xpod_qlever_adapter_release_result(adapter, &result);

  const char update_vector_sparql[] =
      "INSERT DATA { <urn:s> <urn:p> <urn:o> }";
  xpod_qlever_query_request update_vector_request = {};
  update_vector_request.sparql = {
      update_vector_sparql, sizeof(update_vector_sparql) - 1};
  update_vector_request.vector_query = &vector_query;
  status = xpod_qlever_adapter_query_request(
      adapter, &update_vector_request, &result);
  error = std::string_view(result.error_message.data, result.error_message.size);
  if (status != XPOD_RDF_STATUS_UNSUPPORTED) return 27;
  if (error.find("SPARQL UPDATE") == std::string_view::npos) return 28;
  if (scan_state.vector_estimate_calls !=
      vector_estimate_calls_before_invalid) return 55;
  if (scan_state.vector_calls != vector_calls_before_invalid) return 29;
  if (scan_state.mutation_calls != mutation_calls_after_prefix) return 45;

  xpod_qlever_adapter_release_result(adapter, &result);

  vector_events.clear();
  const char vector_select_sparql[] = "SELECT ?resource WHERE { }";
  xpod_qlever_query_request vector_select_request = {};
  vector_select_request.sparql = {
      vector_select_sparql, sizeof(vector_select_sparql) - 1};
  vector_select_request.vector_query = &vector_query;
  vector_select_request.snapshot.snapshot_token = {"vector-snapshot", 15};
  vector_select_request.graph_scope.kind = XPOD_RDF_GRAPH_SCOPE_EXACT;
  vector_select_request.graph_scope.exact_graph = 88;
  vector_select_request.source_scope.workspace = {"workspace-1", 11};
  vector_select_request.access_scope = &vector_access;
  int vector_cancellation_checks = 0;
  xpod_rdf_cancellation vector_cancellation = {
      &vector_cancellation_checks, record_vector_cancellation_check};
  expected_vector_cancellation = &vector_cancellation;
  vector_select_request.cancellation = &vector_cancellation;
  status = xpod_qlever_adapter_query_request(
      adapter, &vector_select_request, &result);
  expected_vector_cancellation = nullptr;
  body = std::string_view(result.result_json.data, result.result_json.size);
  if (status != XPOD_RDF_STATUS_OK) return 30;
  if (body.find("\\\"resource\\\":{\\\"type\\\":\\\"uri\\\",\\\"value\\\":\\\"urn:vector-candidate\\\"}") == std::string_view::npos) return 31;
  if (vector_events != "EVR") return 32;
  if (external_values_planned) return 33;
  if (scan_state.vector_estimate_calls !=
      vector_estimate_calls_before_invalid + 1) return 56;
  if (scan_state.vector_calls != vector_calls_before_invalid + 1) return 34;
  if (vector_cancellation_checks != 1) return 46;
  if (retrieval_point_resolve_calls != 0) return 50;
  if (retrieval_point_encode_attempts != 0) return 51;

  xpod_qlever_adapter_release_result(adapter, &result);

  xpod_qlever_vector_query dollar_vector_query = vector_query;
  dollar_vector_query.retrieval_point_variable = {"$retrieval", 10};
  dollar_vector_query.resource_variable = {"$resource", 9};
  xpod_qlever_query_request dollar_vector_request = vector_select_request;
  dollar_vector_request.vector_query = &dollar_vector_query;
  dollar_vector_request.cancellation = nullptr;
  vector_events.clear();
  const int estimates_before_dollar = scan_state.vector_estimate_calls;
  const int searches_before_dollar = scan_state.vector_calls;
  status = xpod_qlever_adapter_query_request(
      adapter, &dollar_vector_request, &result);
  body = std::string_view(result.result_json.data, result.result_json.size);
  if (status != XPOD_RDF_STATUS_OK) return 60;
  if (body.find("\\\"resource\\\":{\\\"type\\\":\\\"uri\\\",\\\"value\\\":\\\"urn:vector-candidate\\\"}") == std::string_view::npos) return 61;
  if (vector_events != "EVR") return 62;
  if (scan_state.vector_estimate_calls != estimates_before_dollar + 1 ||
      scan_state.vector_calls != searches_before_dollar + 1) return 63;
  if (dollar_vector_query.retrieval_point_variable.data[0] != '$' ||
      dollar_vector_query.resource_variable.data[0] != '$') return 74;

  xpod_qlever_adapter_release_result(adapter, &result);

  xpod_qlever_vector_query resource_only_vector_query = vector_query;
  resource_only_vector_query.retrieval_point_variable = {};
  xpod_qlever_query_request resource_only_vector_request =
      vector_select_request;
  resource_only_vector_request.vector_query = &resource_only_vector_query;
  resource_only_vector_request.cancellation = nullptr;
  vector_events.clear();
  const int estimates_before_resource_only = scan_state.vector_estimate_calls;
  const int searches_before_resource_only = scan_state.vector_calls;
  status = xpod_qlever_adapter_query_request(
      adapter, &resource_only_vector_request, &result);
  body = std::string_view(result.result_json.data, result.result_json.size);
  if (status != XPOD_RDF_STATUS_OK) return 90;
  if (body.find("\\\"resource\\\":{\\\"type\\\":\\\"uri\\\",\\\"value\\\":\\\"urn:vector-candidate\\\"}") == std::string_view::npos) return 91;
  if (vector_events != "EVR") return 92;
  if (scan_state.vector_estimate_calls !=
          estimates_before_resource_only + 1 ||
      scan_state.vector_calls != searches_before_resource_only + 1) return 93;
  if (retrieval_point_resolve_calls != 0) return 94;
  if (retrieval_point_encode_attempts != 0) return 95;

  xpod_qlever_adapter_release_result(adapter, &result);

  xpod_qlever_vector_query retrieval_only_vector_query = vector_query;
  retrieval_only_vector_query.resource_variable = {};
  xpod_qlever_query_request retrieval_only_vector_request =
      vector_select_request;
  const char retrieval_only_select_sparql[] =
      "SELECT ?retrieval WHERE { }";
  retrieval_only_vector_request.sparql = {
      retrieval_only_select_sparql, sizeof(retrieval_only_select_sparql) - 1};
  retrieval_only_vector_request.vector_query = &retrieval_only_vector_query;
  retrieval_only_vector_request.cancellation = nullptr;
  vector_events.clear();
  const int estimates_before_retrieval_only =
      scan_state.vector_estimate_calls;
  const int searches_before_retrieval_only = scan_state.vector_calls;
  status = xpod_qlever_adapter_query_request(
      adapter, &retrieval_only_vector_request, &result);
  body = std::string_view(result.result_json.data, result.result_json.size);
  if (status != XPOD_RDF_STATUS_OK) return 96;
  if (body.find("\\\"retrieval\\\":{\\\"type\\\":\\\"literal\\\",\\\"value\\\":\\\"retrieval-candidate\\\"}") == std::string_view::npos) {
    std::fwrite(body.data(), 1, body.size(), stderr);
    return 97;
  }
  if (body.find("\\\"resource\\\":") != std::string_view::npos) return 98;
  if (vector_events != "EV") return 99;
  if (scan_state.vector_estimate_calls !=
          estimates_before_retrieval_only + 1 ||
      scan_state.vector_calls != searches_before_retrieval_only + 1) return 100;
  if (retrieval_point_resolve_calls != 1) return 101;
  if (retrieval_point_encode_attempts != 0) return 102;

  xpod_qlever_adapter_release_result(adapter, &result);

  xpod_qlever_vector_query duplicate_vector_query = vector_query;
  duplicate_vector_query.retrieval_point_variable = {"$x", 2};
  duplicate_vector_query.resource_variable = {"?x", 2};
  xpod_qlever_query_request duplicate_vector_request = vector_select_request;
  duplicate_vector_request.vector_query = &duplicate_vector_query;
  duplicate_vector_request.cancellation = nullptr;
  vector_events.clear();
  const int estimates_before_duplicate = scan_state.vector_estimate_calls;
  const int searches_before_duplicate = scan_state.vector_calls;
  status = xpod_qlever_adapter_query_request(
      adapter, &duplicate_vector_request, &result);
  if (status != XPOD_RDF_STATUS_UNSUPPORTED) return 64;
  if (!vector_events.empty() ||
      scan_state.vector_estimate_calls != estimates_before_duplicate ||
      scan_state.vector_calls != searches_before_duplicate) return 65;

  xpod_qlever_adapter_release_result(adapter, &result);

  const char preexisting_reserved_sparql[] = R"(
    SELECT ?resource WHERE {
      SERVICE <https://qlever.cs.uni-freiburg.de/external-values/> {
        [] <name> "XpodVectorQuery" .
        [] <variable> ?retrieval .
        [] <variable> ?resource .
      }
    }
  )";
  xpod_qlever_query_request preexisting_reserved_request =
      vector_select_request;
  preexisting_reserved_request.sparql = {
      preexisting_reserved_sparql, sizeof(preexisting_reserved_sparql) - 1};
  preexisting_reserved_request.cancellation = nullptr;
  vector_events.clear();
  const int estimates_before_preexisting = scan_state.vector_estimate_calls;
  const int searches_before_preexisting = scan_state.vector_calls;
  status = xpod_qlever_adapter_query_request(
      adapter, &preexisting_reserved_request, &result);
  error = std::string_view(result.error_message.data, result.error_message.size);
  if (status != XPOD_RDF_STATUS_UNSUPPORTED) return 66;
  if (error.find("XpodVectorQuery") == std::string_view::npos) return 67;
  if (!vector_events.empty() ||
      scan_state.vector_estimate_calls != estimates_before_preexisting ||
      scan_state.vector_calls != searches_before_preexisting) return 68;

  xpod_qlever_adapter_release_result(adapter, &result);

  const char nested_preexisting_reserved_sparql[] = R"(
    SELECT ?resource WHERE {
      OPTIONAL {
        SERVICE <https://qlever.cs.uni-freiburg.de/external-values/> {
          [] <name> "XpodVectorQuery" .
          [] <variable> ?retrieval .
          [] <variable> ?resource .
        }
      }
    }
  )";
  xpod_qlever_query_request nested_preexisting_reserved_request =
      vector_select_request;
  nested_preexisting_reserved_request.sparql = {
      nested_preexisting_reserved_sparql,
      sizeof(nested_preexisting_reserved_sparql) - 1};
  nested_preexisting_reserved_request.cancellation = nullptr;
  vector_events.clear();
  status = xpod_qlever_adapter_query_request(
      adapter, &nested_preexisting_reserved_request, &result);
  error = std::string_view(result.error_message.data, result.error_message.size);
  if (status != XPOD_RDF_STATUS_UNSUPPORTED) return 69;
  if (error.find("XpodVectorQuery") == std::string_view::npos) return 70;
  if (!vector_events.empty() ||
      scan_state.vector_estimate_calls != estimates_before_preexisting ||
      scan_state.vector_calls != searches_before_preexisting) return 71;

  xpod_qlever_adapter_release_result(adapter, &result);

  const char ordinary_external_values_sparql[] = R"(
    SELECT ?resource WHERE {
      SERVICE <https://qlever.cs.uni-freiburg.de/external-values/> {
        [] <name> "OrdinaryExternalValues" .
        [] <variable> ?retrieval .
        [] <variable> ?resource .
      }
    }
  )";
  xpod_qlever_query_request ordinary_external_values_request =
      vector_select_request;
  ordinary_external_values_request.sparql = {
      ordinary_external_values_sparql,
      sizeof(ordinary_external_values_sparql) - 1};
  ordinary_external_values_request.cancellation = nullptr;
  vector_events.clear();
  status = xpod_qlever_adapter_query_request(
      adapter, &ordinary_external_values_request, &result);
  if (status != XPOD_RDF_STATUS_OK) return 72;
  if (vector_events != "EVR" ||
      scan_state.vector_estimate_calls != estimates_before_preexisting + 1 ||
      scan_state.vector_calls != searches_before_preexisting + 1) return 73;

  xpod_qlever_adapter_release_result(adapter, &result);

  vector_search_status = XPOD_RDF_STATUS_BACKEND_ERROR;
  vector_events.clear();
  status = xpod_qlever_adapter_query_request(
      adapter, &vector_select_request, &result);
  error = std::string_view(result.error_message.data, result.error_message.size);
  if (status != XPOD_RDF_STATUS_BACKEND_ERROR) return 57;
  if (error.find("Xpod vector search failed") == std::string_view::npos) return 58;
  if (vector_events != "EV") return 59;
  vector_search_status = XPOD_RDF_STATUS_OK;

  xpod_qlever_adapter_release_result(adapter, &result);

  std::string native_prepare_result_storage;
  std::string native_prepare_profile_storage;
  std::string native_prepare_error_storage;
  graph_lookup_status = XPOD_RDF_STATUS_NOT_FOUND;
  xpod::qlever::xpodQleverDiagnosticsEnable();
  status = xpod::qlever::executeNativeQleverQueryWithPlannerContext(
      xpod::rdf::PhysicalBackend(&backend),
      xpod::qlever::PlannerContextHandle{&metadata_qec, nullptr},
      prepared_request,
      result,
      native_prepare_result_storage,
      native_prepare_profile_storage,
      native_prepare_error_storage);
  std::string_view native_prepare_profile(
      result.profile_json.data, result.profile_json.size);
  std::string native_prepare_diagnostics =
      xpod::qlever::xpodQleverDiagnosticsJson();
  if (status != XPOD_RDF_STATUS_OK) return 279;
  if (native_prepare_profile.find(
          "\\"executionMode\\":\\"native-qlever-prepared-update\\"") ==
      std::string_view::npos) return 280;
  if (native_prepare_diagnostics.find(
          "\\"executionMode\\":\\"native-qlever-prepared-update\\"") ==
      std::string::npos) return 281;
  xpod::qlever::xpodQleverDiagnosticsDisable();
  graph_lookup_status = XPOD_RDF_STATUS_OK;

  const int mutation_calls_after_native_prepare = scan_state.mutation_calls;

  xpod_qlever_adapter_release_result(adapter, &result);

  xpod_qlever_query_request direct_update_request = prepared_request;
  direct_update_request.operation = XPOD_QLEVER_REQUEST_EXECUTE;
  direct_update_request.accept_media_type = {};
  status = xpod_qlever_adapter_query_request(
      adapter, &direct_update_request, &result);
  body = std::string_view(result.result_json.data, result.result_json.size);
  std::string_view direct_update_profile(
      result.profile_json.data, result.profile_json.size);
  std::string direct_update_profile_json(direct_update_profile);
  if (status != XPOD_RDF_STATUS_OK) return 90;
  if (body.find("\\"inserted\\":1") == std::string_view::npos) return 91;
  if (scan_state.mutation_calls != mutation_calls_after_native_prepare + 1) return 92;
  if (direct_update_profile_json.find(
          "\\"executionMode\\":\\"compatibility-operation-plan\\"") ==
      std::string::npos) return 282;

  xpod_qlever_adapter_release_result(adapter, &result);

  std::string native_update_result_storage;
  std::string native_update_profile_storage;
  std::string native_update_error_storage;
  xpod::qlever::xpodQleverDiagnosticsEnable();
  status = xpod::qlever::executeNativeQleverQueryWithPlannerContext(
      xpod::rdf::PhysicalBackend(&backend),
      xpod::qlever::PlannerContextHandle{&metadata_qec, nullptr},
      direct_update_request,
      result,
      native_update_result_storage,
      native_update_profile_storage,
      native_update_error_storage);
  body = std::string_view(result.result_json.data, result.result_json.size);
  std::string_view native_update_profile(
      result.profile_json.data, result.profile_json.size);
  std::string native_update_diagnostics =
      xpod::qlever::xpodQleverDiagnosticsJson();
  if (status != XPOD_RDF_STATUS_OK) return 283;
  if (body.find("\\"inserted\\":1") == std::string_view::npos) return 284;
  if (scan_state.mutation_calls != mutation_calls_after_native_prepare + 2) return 285;
  if (native_update_profile.find(
          "\\"executionMode\\":\\"native-qlever-update\\"") ==
      std::string_view::npos) return 286;
  if (native_update_diagnostics.find(
          "\\"executionMode\\":\\"native-qlever-update\\"") ==
      std::string::npos) return 287;
  xpod::qlever::xpodQleverDiagnosticsDisable();

  xpod_qlever_adapter_release_result(adapter, &result);

  QueryExecutionContext filter_qec{
      std::make_shared<Index>(ad_utility::makeUnlimitedAllocator<Id>()),
      nullptr,
      ad_utility::makeUnlimitedAllocator<Id>(),
      SortPerformanceEstimator{},
      nullptr,
      std::make_shared<MaterializedViewsManager>()};
  filter_qec.setXpodPhysicalIndex(
      std::make_shared<xpod::qlever::XpodQleverPhysicalIndex>(
          metadata_context));
  VariableToColumnMap filter_columns;
  filter_columns[Variable{"?s"}] = makeAlwaysDefinedColumn(0);

  LocalVocab first_chunk_vocab;
  const LocalVocabIndex first_local_index =
      first_chunk_vocab.addIri("keep-one");
  IdTable first_chunk_table(1);
  first_chunk_table.push_back({Id::makeFromLocalVocabIndex(first_local_index)});

  LocalVocab second_chunk_vocab;
  const LocalVocabIndex second_local_index =
      second_chunk_vocab.addIri("keep-two");
  IdTable second_chunk_table(1);
  second_chunk_table.push_back(
      {Id::makeFromLocalVocabIndex(second_local_index)});

  std::vector<Result::IdTableVocabPair> local_vocab_chunks;
  local_vocab_chunks.push_back(
      {std::move(first_chunk_table), std::move(first_chunk_vocab)});
  local_vocab_chunks.push_back(
      {std::move(second_chunk_table), std::move(second_chunk_vocab)});
  Result lazy_local_vocab_result{
      Result::LazyResult{std::move(local_vocab_chunks)}, {}};
  const sparqlExpression::SparqlExpressionPimpl local_vocab_filter{
      R"(CONTAINS(STR(?s), "keep"))"};

  auto local_vocab_output = xpod::qlever::physicalFilterResultFromContext(
      filter_qec,
      filter_columns,
      local_vocab_filter,
      lazy_local_vocab_result,
      {});
  if (local_vocab_output.status != XPOD_RDF_STATUS_OK) return 330;
  const IdTable& local_vocab_table = local_vocab_output.result.idTable();
  if (local_vocab_table.numRows() != 2 ||
      local_vocab_table.numColumns() != 1) return 331;
  const LocalVocab& merged_local_vocab =
      local_vocab_output.result.localVocab();
  if (merged_local_vocab.size() != 2) return 332;
  const auto& merged_first =
      merged_local_vocab.getWord(local_vocab_table(0, 0).getLocalVocabIndex());
  const auto& merged_second =
      merged_local_vocab.getWord(local_vocab_table(1, 0).getLocalVocabIndex());
  if (!merged_first.isIri() || merged_first.getIriContent() != "keep-one") {
    return 333;
  }
  if (!merged_second.isIri() ||
      merged_second.getIriContent() != "keep-two") {
    return 334;
  }

  if (std::fwrite(native_prepare_profile.data(), 1, native_prepare_profile.size(), stdout) != native_prepare_profile.size()) return 288;
  if (std::fputc('\\n', stdout) == EOF) return 289;
  if (std::fwrite(native_prepare_diagnostics.data(), 1, native_prepare_diagnostics.size(), stdout) != native_prepare_diagnostics.size()) return 290;
  if (std::fputc('\\n', stdout) == EOF) return 291;
  if (std::fwrite(direct_update_profile_json.data(), 1, direct_update_profile_json.size(), stdout) != direct_update_profile_json.size()) return 292;
  if (std::fputc('\\n', stdout) == EOF) return 293;
  if (std::fwrite(native_update_profile.data(), 1, native_update_profile.size(), stdout) != native_update_profile.size()) return 294;
  if (std::fputc('\\n', stdout) == EOF) return 295;
  if (std::fwrite(native_update_diagnostics.data(), 1, native_update_diagnostics.size(), stdout) != native_update_diagnostics.size()) return 296;
  if (std::fputc('\\n', stdout) == EOF) return 297;

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
        '-DXPOD_QLEVER_ADAPTER_ENABLE_VECTOR=1',
        '-I', path.join(repoRoot, 'qlever/include'),
        '-I', path.join(repoRoot, 'qlever/rdf_protocol/include'),
        '-I', path.join(repoRoot, 'qlever/qlever_adapter/include'),
        '-I', path.join(repoRoot, 'qlever/qlever_adapter/src'),
        '-I', path.join(qleverSource, 'src'),
        adapterSource,
        executorSource,
        bridgeSource,
        smoke,
        '-o',
        binary,
      ], { stdio: 'pipe' });
      const stdout = execFileSync(binary, [], { encoding: 'utf8' });
      const [
        joinProfileLine,
        nativeProfileLine,
        operationProfileLine,
        diagnosticsLine,
        nativeDiagnosticsLine,
        operationDiagnosticsLine,
        parsedAskProfileLine,
        parsedAskDiagnosticsLine,
        nativeUnavailableDiagnosticsLine,
        errorDiagnosticsLine,
        preparedDeltaLine,
        nativePrepareProfileLine,
        nativePrepareDiagnosticsLine,
        directUpdateProfileLine,
        nativeUpdateProfileLine,
        nativeUpdateDiagnosticsLine,
      ] = stdout.trim().split('\n');
      const joinProfile = JSON.parse(joinProfileLine);
      expect(joinProfile.executionMode).toBe('compatibility-parameterized-join');
      expect(joinProfile.root.details).toEqual({
        parameterized: true,
        seedRows: 2,
        uniqueJoinTuples: 2,
        dependentBackendRows: 2,
        fallbackReason: null,
      });
      const nativeProfile = JSON.parse(nativeProfileLine);
      expect(nativeProfile.executionMode).toBe('native-qlever-tree');
      const operationProfile = JSON.parse(operationProfileLine);
      expect(operationProfile.executionMode).toBe('compatibility-parsed-bgp');
      const diagnostics = JSON.parse(diagnosticsLine);
      expect(diagnostics.executionMode).toBe('native-qlever-tree');
      expect(Object.keys(diagnostics.stageMs).sort()).toEqual([
        'algebra-execution',
        'backend-scan',
        'id-table-materialization',
        'parse-plan',
        'serialization',
        'term-resolution',
      ]);
      for (const value of Object.values(diagnostics.stageMs)) {
        expect(typeof value).toBe('number');
        expect(Number.isFinite(value)).toBe(true);
      }
      expect(diagnostics.backendScanCount).toBe(1);
      expect(diagnostics.backendRows).toBe(2);
      expect(diagnostics.backendBytes).toBe(64);
      const nativeDiagnostics = JSON.parse(nativeDiagnosticsLine);
      expect(nativeDiagnostics.executionMode).toBe('native-qlever-tree');
      const operationDiagnostics = JSON.parse(operationDiagnosticsLine);
      expect(operationDiagnostics.executionMode).toBe('compatibility-parsed-bgp');
      const parsedAskProfile = JSON.parse(parsedAskProfileLine);
      expect(parsedAskProfile.executionMode).toBe('compatibility-parsed-bgp');
      const parsedAskDiagnostics = JSON.parse(parsedAskDiagnosticsLine);
      expect(parsedAskDiagnostics.executionMode).toBe('compatibility-parsed-bgp');
      const nativeUnavailableDiagnostics = JSON.parse(nativeUnavailableDiagnosticsLine);
      expect(nativeUnavailableDiagnostics.executionMode).toBe('native-qlever-tree');
      const errorDiagnostics = JSON.parse(errorDiagnosticsLine);
      expect(errorDiagnostics.executionMode).toBe('compatibility-operation-plan');
      expect(errorDiagnostics.backendScanCount).toBe(0);
      expect(errorDiagnostics.backendRows).toBe(0);
      expect(errorDiagnostics.backendBytes).toBe(0);
      const preparedDelta = JSON.parse(preparedDeltaLine);
      expect(preparedDelta).toEqual({
        version: 1,
        graphs: [{
          graphIri: 'urn:g',
          sourceUri: 'urn:g',
          deletes: [],
          inserts: [{
            subject: { type: 'uri', value: 'urn:s' },
            predicate: { type: 'uri', value: 'urn:p' },
            object: { type: 'uri', value: 'urn:o' },
            graph: { type: 'uri', value: 'urn:g' },
          }],
        }],
      });
      const nativePrepareProfile = JSON.parse(nativePrepareProfileLine);
      expect(nativePrepareProfile.executionMode).toBe(
        'native-qlever-prepared-update',
      );
      const nativePrepareDiagnostics = JSON.parse(nativePrepareDiagnosticsLine);
      expect(nativePrepareDiagnostics.executionMode).toBe(
        'native-qlever-prepared-update',
      );
      const directUpdateProfile = JSON.parse(directUpdateProfileLine);
      expect(directUpdateProfile.executionMode).toBe('compatibility-operation-plan');
      const nativeUpdateProfile = JSON.parse(nativeUpdateProfileLine);
      expect(nativeUpdateProfile.executionMode).toBe('native-qlever-update');
      const nativeUpdateDiagnostics = JSON.parse(nativeUpdateDiagnosticsLine);
      expect(nativeUpdateDiagnostics.executionMode).toBe(
        'native-qlever-update',
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 30_000);
});
