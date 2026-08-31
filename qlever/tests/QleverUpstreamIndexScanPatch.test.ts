import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'bun:test';

const repoRoot = path.resolve(__dirname, '../..');
const patchScript = path.join(repoRoot, 'qlever/scripts/check-qlever-upstream-patches.cjs');
const patchPath = path.join(
  repoRoot,
  'qlever/patches/qlever-indexscan-physical-lazy-scan.patch',
);
const nativeValueOrderPatchPath = path.join(
  repoRoot,
  'qlever/patches/qlever-indexscan-native-value-order.patch',
);
const transitivePathPatchPath = path.join(
  repoRoot,
  'qlever/patches/qlever-transitive-path-physical-id.patch',
);
const valuesPatchPath = path.join(
  repoRoot,
  'qlever/patches/qlever-values-physical-id.patch',
);
const describePatchPath = path.join(
  repoRoot,
  'qlever/patches/qlever-describe-physical-id.patch',
);
const existsJoinAccessorPatchPath = path.join(
  repoRoot,
  'qlever/patches/qlever-exists-join-test-accessor.patch',
);
const existsJoinTestPatchPath = path.join(
  repoRoot,
  'qlever/patches/qlever-exists-join-test-access.patch',
);
const graphFilterPatchPath = path.join(
  repoRoot,
  'qlever/patches/qlever-graph-filter-physical-scope.patch',
);
const scanSpecificationPatchPath = path.join(
  repoRoot,
  'qlever/patches/qlever-scan-specification-physical-local-vocab.patch',
);
const regexPrefixPatchPath = path.join(
  repoRoot,
  'qlever/patches/qlever-regex-prefix-physical-string.patch',
);
const regexExpressionAccessorPatchPath = path.join(
  repoRoot,
  'qlever/patches/qlever-regex-expression-test-accessor.patch',
);
const regexExpressionTestPatchPath = path.join(
  repoRoot,
  'qlever/patches/qlever-regex-expression-test-access.patch',
);
const operationAccessorPatchPath = path.join(
  repoRoot,
  'qlever/patches/qlever-operation-test-accessor.patch',
);
const operationTestPatchPath = path.join(
  repoRoot,
  'qlever/patches/qlever-operation-test-access.patch',
);
const lazyGroupByAccessorPatchPath = path.join(
  repoRoot,
  'qlever/patches/qlever-lazy-group-by-test-accessor.patch',
);
const lazyGroupByTestPatchPath = path.join(
  repoRoot,
  'qlever/patches/qlever-lazy-group-by-test-access.patch',
);
const sparqlAntlrVisitorAccessorPatchPath = path.join(
  repoRoot,
  'qlever/patches/qlever-sparql-antlr-parser-test-accessor.patch',
);
const sparqlAntlrParserTestPatchPath = path.join(
  repoRoot,
  'qlever/patches/qlever-sparql-antlr-parser-test-access.patch',
);
const constructTripleGeneratorAccessorPatchPath = path.join(
  repoRoot,
  'qlever/patches/qlever-construct-triple-generator-test-accessor.patch',
);
const constructTripleGeneratorTestPatchPath = path.join(
  repoRoot,
  'qlever/patches/qlever-construct-triple-generator-test-access.patch',
);
const exportQueryExecutionTreesAccessorPatchPath = path.join(
  repoRoot,
  'qlever/patches/qlever-export-query-execution-trees-test-accessor.patch',
);
const exportQueryExecutionTreesTestPatchPath = path.join(
  repoRoot,
  'qlever/patches/qlever-export-query-execution-trees-test-access.patch',
);
const serviceAccessorPatchPath = path.join(
  repoRoot,
  'qlever/patches/qlever-service-test-accessor.patch',
);
const serviceTestPatchPath = path.join(
  repoRoot,
  'qlever/patches/qlever-service-test-access.patch',
);
const materializedViewsAccessorPatchPath = path.join(
  repoRoot,
  'qlever/patches/qlever-materialized-views-test-accessor.patch',
);
const materializedViewsServerAccessorPatchPath = path.join(
  repoRoot,
  'qlever/patches/qlever-materialized-views-server-test-accessor.patch',
);
const materializedViewsTestPatchPath = path.join(
  repoRoot,
  'qlever/patches/qlever-materialized-views-test-access.patch',
);
const graphStoreProtocolAccessorPatchPath = path.join(
  repoRoot,
  'qlever/patches/qlever-graph-store-protocol-test-accessor.patch',
);
const executeUpdateAccessorPatchPath = path.join(
  repoRoot,
  'qlever/patches/qlever-execute-update-test-accessor.patch',
);
const parsedRequestBuilderAccessorPatchPath = path.join(
  repoRoot,
  'qlever/patches/qlever-parsed-request-builder-test-accessor.patch',
);
const sparqlProtocolAccessorPatchPath = path.join(
  repoRoot,
  'qlever/patches/qlever-sparql-protocol-test-accessor.patch',
);
const indexImplAccessorPatchPath = path.join(
  repoRoot,
  'qlever/patches/qlever-index-impl-test-accessor.patch',
);
const graphNameManagerAccessorPatchPath = path.join(
  repoRoot,
  'qlever/patches/qlever-graph-name-manager-test-accessor.patch',
);
const locatedTriplesAccessorPatchPath = path.join(
  repoRoot,
  'qlever/patches/qlever-located-triples-test-accessor.patch',
);
const deltaTriplesAccessorPatchPath = path.join(
  repoRoot,
  'qlever/patches/qlever-delta-triples-test-accessor.patch',
);
const localVocabEntryAccessorPatchPath = path.join(
  repoRoot,
  'qlever/patches/qlever-local-vocab-entry-test-accessor.patch',
);

const upstreamIndexScanFixture = `// Copyright 2015, University of Freiburg,
// Chair of Algorithms and Data Structures.
// Author: Björn Buchhold (buchhold@informatik.uni-freiburg.de)

#include "engine/IndexScan.h"

#include <absl/container/inlined_vector.h>
#include <absl/strings/str_join.h>

#include <sstream>
#include <string>
#include <utility>

#include "engine/MaterializedViews.h"
#include "engine/QueryExecutionTree.h"
#include "engine/VariableToColumnMap.h"
#include "index/IndexImpl.h"
#include "parser/ParsedQuery.h"
#include "util/Exception.h"
#include "util/InputRangeUtils.h"
#include "util/Iterators.h"

using std::string;
using LazyScanMetadata = CompressedRelationReader::LazyScanMetadata;

std::vector<ColumnIndex> IndexScan::resultSortedOn() const {
  std::vector<ColumnIndex> result;
  for (auto i : ad_utility::integerRange(ColumnIndex{numVariables_})) {
    result.push_back(i);
  }
  for (size_t i = 0; i < additionalColumns_.size(); ++i) {
    if (additionalColumns_.at(i) == ADDITIONAL_COLUMN_GRAPH_ID) {
      result.push_back(numVariables_ + i);
    }
  }

  return result;
}

IdTable IndexScan::materializedIndexScan() const {
  IdTable idTable = permutation().scan(scanSpecAndBlocks_, additionalColumns(),
                                       cancellationHandle_,
                                       locatedTriplesState(), getLimitOffset());
  AD_LOG_DEBUG << "IndexScan result computation done.\\n";
  checkCancellation();
  idTable = makeApplyColumnSubset()(std::move(idTable));
  AD_CORRECTNESS_CHECK(idTable.numColumns() == getResultWidth());
  return idTable;
}

std::pair<bool, size_t> IndexScan::computeSizeEstimate() const {
  AD_CORRECTNESS_CHECK(_executionContext);

  // For a full index scan (think \`?s ?p ?o\`), simply use the total number
  // of triples in the selected permutation (from the permutation's metadata) as
  // estimate. Note that this is not always the same as the index' number of
  // triples, because the permutation could be a materialized view. See the
  // comment before the declaration of this function for details.
  if (numVariables() == 3 && !scanSpecAndBlocksIsPrefiltered_) {
    return {false, permutation().numTriples()};
  }

  auto [lower, upper] = permutation().getSizeEstimateForScan(
      scanSpecAndBlocks_, locatedTriplesState());
  return {lower == upper, lower + (upper - lower) / 2};
}

size_t IndexScan::getExactSize() const {
  AD_CORRECTNESS_CHECK(_executionContext);
  return permutation().getResultSizeOfScan(scanSpecAndBlocks_,
                                           locatedTriplesState());
}

void IndexScan::determineMultiplicities() {
  multiplicity_ = [this]() -> std::vector<float> {
    const auto& idx = getIndex();
    if (numVariables_ == 0) {
      return {};
    } else if (numVariables_ == 1) {
      // There are no duplicate triples in RDF and two elements are fixed.
      return {1.0f};
    } else if (numVariables_ == 2) {
      return idx.getMultiplicities(*getPermutedTriple()[0], permutation(),
                                   locatedTriplesState());
    } else {
      AD_CORRECTNESS_CHECK(numVariables_ == 3);
      return idx.getMultiplicities(permutation());
    }
  }();
  multiplicity_.resize(multiplicity_.size() + additionalColumns_.size(), 1.0f);

  if (varsToKeep_.has_value()) {
    std::vector<float> actualMultiplicites;
    for (size_t column : getSubsetForStrippedColumns()) {
      actualMultiplicites.push_back(multiplicity_.at(column));
    }
    multiplicity_ = std::move(actualMultiplicites);
  }
  AD_CONTRACT_CHECK(multiplicity_.size() == getResultWidth());
}

// ___________________________________________________________________________
Permutation::ScanSpecAndBlocks IndexScan::getScanSpecAndBlocks() const {
  return permutation().getScanSpecAndBlocks(getScanSpecification(),
                                            locatedTriplesState());
}

CompressedRelationReader::IdTableGeneratorInputRange IndexScan::getLazyScan(
    std::optional<std::vector<CompressedBlockMetadata>> blocks) const {
  // If there is a LIMIT or OFFSET clause that constrains the scan
  // (which can happen with an explicit subquery), we cannot use the prefiltered
  // blocks, as we currently have no mechanism to include limits and offsets
  // into the prefiltering (\`std::nullopt\` means \`scan all blocks\`).
  auto filteredBlocks =
      getLimitOffset().isUnconstrained() ? std::move(blocks) : std::nullopt;
  auto lazyScanAllCols = permutation().lazyScan(
      scanSpecAndBlocks_, filteredBlocks, additionalColumns(),
      cancellationHandle_, locatedTriplesState(), getLimitOffset());
  return CompressedRelationReader::IdTableGeneratorInputRange{
      ad_utility::CachingTransformInputRange<
          ad_utility::OwningView<
              CompressedRelationReader::IdTableGeneratorInputRange>,
          decltype(makeApplyColumnSubset()), LazyScanMetadata>{
          std::move(lazyScanAllCols), makeApplyColumnSubset()}};
};

std::optional<Permutation::MetadataAndBlocks> IndexScan::getMetadataForScan()
    const {
  return permutation().getMetadataAndBlocks(scanSpecAndBlocks_,
                                            locatedTriplesState());
};
`;

const upstreamIndexScanHeaderFixture = `#ifndef QLEVER_SRC_ENGINE_INDEXSCAN_H
#define QLEVER_SRC_ENGINE_INDEXSCAN_H

#include <string>

#include "engine/Operation.h"
#include "index/DeltaTriples.h"
#include "util/HashMap.h"

class SparqlTriple;
class SparqlTripleSimple;

class IndexScan final : public Operation {
 public:
  using Graphs = ScanSpecificationAsTripleComponent::GraphFilter;
  using PermutationPtr = std::shared_ptr<const Permutation>;

 private:
  using ScanSpecAndBlocks = Permutation::ScanSpecAndBlocks;

 private:
  PermutationPtr permutation_;
  LocatedTriplesSharedState locatedTriplesSharedState_;
  TripleComponent subject_;
  TripleComponent predicate_;
  TripleComponent object_;
  Graphs graphsToFilter_;
  ScanSpecAndBlocks scanSpecAndBlocks_;
  bool scanSpecAndBlocksIsPrefiltered_;
  size_t numVariables_;
  size_t sizeEstimate_;
  bool sizeEstimateIsExact_;
  std::vector<float> multiplicity_;

  // Additional columns (e.g. patterns) that are being retrieved in addition to
  // the "ordinary" subjects, predicates, or objects, as well as the variables
  // that they are bound to.
  std::vector<ColumnIndex> additionalColumns_;
  std::vector<Variable> additionalVariables_;
};

#endif  // QLEVER_SRC_ENGINE_INDEXSCAN_H
`;

async function writeIndexScanPatchFixtures(qleverSource: string): Promise<{
  indexScanPath: string;
  indexScanHeaderPath: string;
}> {
  const indexScanPath = path.join(qleverSource, 'src/engine/IndexScan.cpp');
  const indexScanHeaderPath = path.join(qleverSource, 'src/engine/IndexScan.h');
  await mkdir(path.dirname(indexScanPath), { recursive: true });
  await writeFile(indexScanPath, upstreamIndexScanFixture, 'utf8');
  await writeFile(indexScanHeaderPath, upstreamIndexScanHeaderFixture, 'utf8');
  return { indexScanPath, indexScanHeaderPath };
}

const upstreamGraphFilterFixture = `#ifndef QLEVER_SRC_INDEX_GRAPHFILTER_H
#define QLEVER_SRC_INDEX_GRAPHFILTER_H
#include <variant>
namespace ad_utility {
template <typename T>
class HashSet {};
}
namespace qlever::index {
template <typename T>
class GraphFilter {
 public:
  struct AllTag {};
  using FilterType = std::variant<AllTag, ad_utility::HashSet<T>, T>;
 private:
  explicit GraphFilter(FilterType filterType);
  FilterType filter_;
 public:
  static GraphFilter All();

  // Return true iff all graphs are always allowed.
  bool areAllGraphsAllowed() const;

  // Make sure this filter is comparable.
  QL_DEFINE_DEFAULTED_EQUALITY_OPERATOR_LOCAL(GraphFilter, filter_)
};
}
#endif
`;

const upstreamScanSpecificationFixture = `#ifndef QLEVER_SRC_INDEX_SCANSPECIFICATION_H
#define QLEVER_SRC_INDEX_SCANSPECIFICATION_H
#include <memory>
class LocalVocab {};
class ScanSpecification {
 public:
  using T = int;
 private:
  T col0Id_;
  T col1Id_;
  T col2Id_;
  std::shared_ptr<const LocalVocab> localVocab_;
 public:
  const T& col0Id() const { return col0Id_; }
  const T& col1Id() const { return col1Id_; }
  const T& col2Id() const { return col2Id_; }

  // Get the corresponding index to the first free \`colXId_\`.
  size_t firstFreeColIndex() const {
    return 0;
  }
};
#endif
`;

const upstreamTransitivePathImplFixture = `#ifndef QLEVER_REDUCED_FEATURE_SET_FOR_CPP17

#ifndef QLEVER_SRC_ENGINE_TRANSITIVEPATHIMPL_H
#define QLEVER_SRC_ENGINE_TRANSITIVEPATHIMPL_H

#include <utility>

#include "engine/TransitivePathBase.h"
#include "engine/TransitivePathGraphSearch.h"
#include "util/Iterators.h"
#include "util/Timer.h"

template <typename T>
class TransitivePathImpl : public TransitivePathBase {
 public:
  CPP_template(typename Node)(requires ql::ranges::range<Node>) NodeGenerator
      transitiveHull(T edges, LocalVocab edgesVocab, Node startNodes,
                     TripleComponent start, TripleComponent target,
                     bool yieldOnce) const {
    // \`targetId\` is only ever used for comparisons, and never stored in the
    // result, so we use a separate local vocabulary.
    LocalVocab targetHelper;
    const auto& index = getIndex();
    std::optional<Id> targetId =
        target.isVariable()
            ? std::nullopt
            : std::optional{std::move(target).toValueId(index, targetHelper)};
    bool sameVariableOnBothSides =
        !targetId.has_value() && lhs_.value_ == rhs_.value_;
    bool endsWithGraphVariable =
        !targetId.has_value() && graphVariable_ == target.getVariable();
    return {};
  }

  SetWithGraph setupNodes(const IdTableView<0>& sub,
                          const TransitivePathSide& startSide,
                          const T& edges) const {
    SetWithGraph result{allocator()};
    if (startSide.isVariable()) {
      for (Id id : sub.getColumn(startSide.subCol_)) {
        result.emplace(id, Id::makeUndefined());
      }
      return result;
    }
    // id -> var|id
    LocalVocab helperVocab;
    Id startId =
        TripleComponent{startSide.value_}.toValueId(getIndex(), helperVocab);
    // Make sure we retrieve the Id from an IndexScan, so we don't have to pass
    // this LocalVocab around. If it's not present then no result needs to be
    // returned anyways. This also augments the id with matching graph ids.
    auto idAndGraphs = edges.getEquivalentIdAndMatchingGraphs(startId);
    result.insert(idAndGraphs.begin(), idAndGraphs.end());
    return result;
  }
};

#endif
#endif
`;

const upstreamExistsJoinHeaderFixture = `#ifndef QLEVER_SRC_ENGINE_EXISTSJOIN_H
#define QLEVER_SRC_ENGINE_EXISTSJOIN_H
#include <array>
#include <memory>
#include <vector>
using ColumnIndex = unsigned long;
class QueryExecutionContext;
class QueryExecutionTree;
class Variable {};
class Operation {};
class ExistsJoin : public Operation {
 private:
  std::shared_ptr<QueryExecutionTree> left_;
  std::shared_ptr<QueryExecutionTree> right_;
  std::vector<std::array<ColumnIndex, 2>> joinColumns_;
  Variable existsVariable_;

 public:
  ExistsJoin(QueryExecutionContext* qec,
             std::shared_ptr<QueryExecutionTree> left,
             std::shared_ptr<QueryExecutionTree> right,
             Variable existsVariable);

  // Extract all \`ExistsExpression\`s from the given \`expression\`. For each
  // \`ExistsExpression\`, add an \`ExistsJoin\`. The left side of the first
  // \`ExistsJoin\` is the input \`subtree\`. The left side of subsequent
  static std::shared_ptr<QueryExecutionTree> addExistsJoinsToSubtree();
};
#endif
`;

const upstreamExistsJoinTestFixture = `#include "engine/ExistsJoin.h"

TEST(ExistsJoin, addExistsJoinsToSubtreeDoesntCollideForHiddenVariables) {
  const ExistsJoin& existsJoin =
      *std::dynamic_pointer_cast<ExistsJoin>(tree->getRootOperation());

  // Even though both variables match, only one of them should be joined.
  EXPECT_THAT(existsJoin.joinColumns_,
              ::testing::ElementsAre(std::array<ColumnIndex, 2>{0, 0}));
}

`;

const upstreamValuesFixture = `#include "engine/Values.h"

#include <absl/strings/str_cat.h>
#include <absl/strings/str_join.h>

#include "engine/CallFixedSize.h"
#include "util/Exception.h"
#include "util/HashSet.h"

// ____________________________________________________________________________
Values::Values(QueryExecutionContext* qec, SparqlValues parsedValues)
    : Operation(qec), parsedValues_(std::move(parsedValues)) {}

template <size_t I>
void Values::writeValues(IdTable* idTablePtr, LocalVocab* localVocab) {
  IdTableStatic<I> idTable = std::move(*idTablePtr).toStatic<I>();
  idTable.resize(parsedValues_._values.size());
  size_t rowIdx = 0;
  std::vector<size_t> numLocalVocabPerColumn(idTable.numColumns());
  for (auto& row : parsedValues_._values) {
    for (size_t colIdx = 0; colIdx < idTable.numColumns(); colIdx++) {
      const TripleComponent& tc = row[colIdx];
      // TODO<joka921> We don't want to move, but also don't want to
      // unconditionally copy.
      Id id = TripleComponent{tc}.toValueId(getIndex(), *localVocab);
      idTable(rowIdx, colIdx) = id;
      if (id.getDatatype() == Datatype::LocalVocabIndex) {
        ++numLocalVocabPerColumn[colIdx];
      }
    }
    rowIdx++;
  }
  *idTablePtr = std::move(idTable).toDynamic();
}
`;

const upstreamDescribeFixture = `#include "engine/Describe.h"

#include <absl/strings/str_join.h>

#include "engine/ExplicitIdTableOperation.h"
#include "engine/IndexScan.h"
#include "engine/Join.h"

// _____________________________________________________________________________
Describe::Describe(QueryExecutionContext* qec,
                   std::shared_ptr<QueryExecutionTree> subtree,
                   parsedQuery::Describe describe)
    : Operation{qec},
      subtree_{std::move(subtree)},
      describe_{std::move(describe)} {}

${'\n'.repeat(180)}
// _____________________________________________________________________________
IdTable Describe::getIdsToDescribe(const Result& result,
                                   LocalVocab& localVocab) const {
  // First collect the \`Id\`s in a hash set, in order to remove duplicates.
  ad_utility::HashSetWithMemoryLimit<Id> idsToDescribe{allocator()};
  for (const auto& resource : describe_.resources_) {
    if (std::holds_alternative<TripleComponent::Iri>(resource)) {
      // For an IRI, add the corresponding ID to \`idsToDescribe\`.
      idsToDescribe.insert(
          TripleComponent{std::get<TripleComponent::Iri>(resource)}.toValueId(
              getIndex(), localVocab));
    } else {
      // For a variable, add all IDs that match the variable in the \`result\` of
      // the WHERE clause to \`idsToDescribe\`.
      const auto& var = std::get<Variable>(resource);
      auto column = subtree_->getVariableColumnOrNullopt(var);
      if (!column.has_value()) {
        continue;
      }
    }
  }
  return IdTable{1, allocator()};
}
`;

const upstreamRegexExpressionFixture = `#include "engine/sparqlExpressions/RegexExpression.h"

#include <re2/re2.h>

#include "backports/StartsWithAndEndsWith.h"
#include "engine/sparqlExpressions/LiteralExpression.h"
#include "engine/sparqlExpressions/NaryExpression.h"
#include "engine/sparqlExpressions/NaryExpressionImpl.h"
#include "engine/sparqlExpressions/SparqlExpressionGenerators.h"
#include "engine/sparqlExpressions/SparqlExpressionValueGetters.h"
#include "engine/sparqlExpressions/StringExpressionsHelper.h"
#include "global/ValueIdComparators.h"

using namespace std::literals;

namespace sparqlExpression::detail {

void ensureIsSimpleLiteral(
    const ad_utility::triple_component::Literal& literal) {
}

}  // namespace sparqlExpression::detail

namespace sparqlExpression {

ExpressionResult PrefixRegexExpression::evaluate(
    EvaluationContext* context) const {
  auto optColumn = context->getColumnIndexForVariable(variable_);
  if (!optColumn.has_value()) {
    return Id::makeUndefined();
  }

  std::vector<std::string> actualPrefixes;
  actualPrefixes.push_back("\\"" + prefixRegex_);
  if (childIsStrExpression_) {
    actualPrefixes.push_back("<" + prefixRegex_);
  }

  std::vector<std::pair<Id, Id>> lowerAndUpperIds;
  lowerAndUpperIds.reserve(actualPrefixes.size());
  for (const auto& prefix : actualPrefixes) {
    const auto& ranges = context->_qec.getIndex().prefixRanges(prefix);
    for (const auto& [begin, end] : ranges.ranges()) {
      lowerAndUpperIds.emplace_back(Id::makeFromVocabIndex(begin),
                                    Id::makeFromVocabIndex(end));
    }
  }
  checkCancellation(context);

  // Begin and end of the input (for each row of which we want to
  // evaluate the regex).
  auto beg = context->_inputTable.begin() + context->_beginIndex;
  auto end = context->_inputTable.begin() + context->_endIndex;
  AD_CONTRACT_CHECK(end <= context->_inputTable.end());
}

std::optional<PrefixRegexExpression>
PrefixRegexExpression::makePrefixRegexExpressionIfPossible(
    Ptr& string, const SparqlExpression& regex) {
  detail::ensureIsValidRegexIfConstant(regex);
  const auto* variableExpression = dynamic_cast<const VariableExpression*>(
      string->isStrExpression() ? string->children()[0].get() : string.get());
  if (!variableExpression) {
    return std::nullopt;
  }
  return std::nullopt;
}

}  // namespace sparqlExpression
`;

const upstreamRegexExpressionHeaderFixture = `#ifndef QLEVER_SRC_ENGINE_SPARQLEXPRESSIONS_REGEXEXPRESSION_H
#define QLEVER_SRC_ENGINE_SPARQLEXPRESSIONS_REGEXEXPRESSION_H
#include <optional>
#include <string>
namespace sparqlExpression {
class Variable {};
class SparqlExpression {};
class PrefixRegexExpression : public SparqlExpression {
 private:
  std::string prefixRegex_;
  Variable variable_;

 public:
  static std::optional<PrefixRegexExpression>
  makePrefixRegexExpressionIfPossible();

 private:
  // Check if \`regex\` is a prefix regex which means that it starts with \`^\` and
  // contains no other "special" regex characters like \`*\` or \`.\`.
  // escaping undone. Else, \`std::nullopt\` is returned.
  static std::optional<std::string> getPrefixRegex(std::string regex);

  FRIEND_TEST(RegexExpression, getPrefixRegex);
  FRIEND_TEST(RegexExpression, makePrefixMatchExpression);
};
}
#endif
`;

const upstreamRegexExpressionTestFixture = [
  'namespace sparqlExpression {',
  '// Test the `getPrefixRegex` function (which returns `std::nullopt` if the regex',
  '// is not a simple prefix regex).',
  'TEST(RegexExpression, getPrefixRegex) {',
  '  ASSERT_EQ(std::nullopt, PrefixRegexExpression::getPrefixRegex("alpha"));',
  '  ASSERT_EQ(std::nullopt, PrefixRegexExpression::getPrefixRegex("^al.ha"));',
  '  ASSERT_EQ(std::nullopt, PrefixRegexExpression::getPrefixRegex("^alh*"));',
  '  ASSERT_EQ(std::nullopt, PrefixRegexExpression::getPrefixRegex("^a(lh)"));',
  '',
  '  ASSERT_EQ("alpha", PrefixRegexExpression::getPrefixRegex("^alpha"));',
  '  ASSERT_EQ(R"(\\al*ph.a()",',
  '            PrefixRegexExpression::getPrefixRegex(R"(^\\\\al\\*ph\\.a\\()"));',
  '  // Escapes of non-special characters (e.g. `\\"`) are valid regex features',
  '  // handled by RE2 in the general regex path, so the prefix check declines',
  '  // (returns `std::nullopt`) rather than throwing.',
  '  ASSERT_EQ(std::nullopt, PrefixRegexExpression::getPrefixRegex(R"(^\\")"));',
  '}',
  '',
  '// _____________________________________________________________________________',
  '',
  'TEST(RegexExpression, makePrefixMatchExpression) {',
  '  using namespace ::testing;',
  '  auto hasPrefixAndVariableMatcher = [](std::string variableName,',
  '                                        std::string_view prefix) {',
  '    return Pointee(WhenDynamicCastTo<const PrefixRegexExpression&>(',
  '        AllOf(AD_FIELD(PrefixRegexExpression, prefixRegex_, Eq(prefix)),',
  '              AD_FIELD(PrefixRegexExpression, variable_,',
  '                       Eq(Variable{std::move(variableName)})))));',
  '  };',
  '}',
  '}',
  '',
].join('\n');

const upstreamOperationHeaderFixture = `
class Operation {
  bool externalLimitApplied_ = false;

 public:
  Operation();
  CPP_template(typename MakeCloneWithNewChildren)(
      requires true)
      std::optional<std::shared_ptr<QueryExecutionTree>> pushDownBindToAnyChild(
          const parsedQuery::Bind& bind,
          std::vector<std::shared_ptr<QueryExecutionTree>> children,
          MakeCloneWithNewChildren makeCloneWithNewChildren) const;

 private:
  void updateRuntimeStats(bool applyToLimit, unsigned long numRows,
                          unsigned long numCols, int duration) const;
  Result runComputation(const Timer& timer, ComputationMode computationMode);
  CacheValue runComputationAndPrepareForCache(const Timer& timer,
                                              ComputationMode computationMode,
                                              const QueryCacheKey& cacheKey,
                                              bool pinned, bool isRoot);
};
`;

const upstreamOperationTestFixture = (() => {
  const lines = Array.from({ length: 850 }, () => '');
  const put = (line: number, value: string) => {
    lines[line - 1] = value;
  };
  put(360, 'TEST(Operation, updateRuntimeStatsWorksCorrectly) {');
  put(371, '  // Test operation with built-in filter');
  put(372, '  valuesForTesting.externalLimitApplied_ = false;');
  put(373, '  valuesForTesting.updateRuntimeStats(false, 11, 13, 17ms);');
  put(381, '  // Test built-in filter');
  put(382, '  valuesForTesting.externalLimitApplied_ = false;');
  put(383, '  valuesForTesting.updateRuntimeStats(true, 5, 3, 7ms);');
  put(398, '  // Test operation with external filter');
  put(399, '  valuesForTesting.externalLimitApplied_ = true;');
  put(400, '  valuesForTesting.updateRuntimeStats(false, 31, 37, 41ms);');
  put(414, '  // Test external filter');
  put(415, '  valuesForTesting.externalLimitApplied_ = true;');
  put(416, '  valuesForTesting.updateRuntimeStats(true, 19, 23, 29ms);');
  put(446, '  EXPECT_THROW(');
  put(447, '      valuesForTesting.runComputation(timer, ComputationMode::ONLY_IF_CACHED),');
  put(448, '      ad_utility::Exception);');
  put(451, '  auto result = valuesForTesting.runComputation(');
  put(452, '      timer, ComputationMode::LAZY_IF_SUPPORTED);');
  put(504, '  auto result =');
  put(505, '      operation.runComputation(timer, ComputationMode::LAZY_IF_SUPPORTED);');
  put(539, '  auto result =');
  put(540, '      operation.runComputation(timer, ComputationMode::LAZY_IF_SUPPORTED);');
  put(587, '  auto result =');
  put(588, '      operation.runComputation(timer, ComputationMode::LAZY_IF_SUPPORTED);');
  put(629, '    auto result =');
  put(630, '        operation.runComputation(timer, ComputationMode::LAZY_IF_SUPPORTED);');
  put(656, '  auto result = valuesForTesting.runComputation(');
  put(657, '      timer, ComputationMode::LAZY_IF_SUPPORTED);');
  put(697, '  auto cacheValue = valuesForTesting.runComputationAndPrepareForCache(');
  put(698, '      timer, ComputationMode::LAZY_IF_SUPPORTED, makeQueryCacheKey("test"),');
  put(756, '    cacheValue = valuesForTesting.runComputationAndPrepareForCache(');
  put(757, '        timer, ComputationMode::LAZY_IF_SUPPORTED, makeQueryCacheKey("test"),');
  put(783, '  auto cacheValue = valuesForTesting.runComputationAndPrepareForCache(');
  put(784, '      timer, ComputationMode::LAZY_IF_SUPPORTED, makeQueryCacheKey("test"),');
  put(827, '    auto cacheValue = valuesForTesting.runComputationAndPrepareForCache(');
  put(828, '        timer, ComputationMode::LAZY_IF_SUPPORTED, makeQueryCacheKey("test"),');
  return lines.join('\n');
})();

const upstreamLazyGroupByHeaderFixture = `
class LazyGroupBy {
  GroupByImpl::HashMapAggregationData<0> aggregationData_;

 public:
  LazyGroupBy();

  // Commit the current group to the result table. This will write the final id
  // into the \`resultTable\` and reset the aggregation data for the next group.
  void commitRow();
};
`;

const upstreamLazyGroupByTestFixture = (() => {
  const lines = Array.from({ length: 170 }, () => '');
  const put = (line: number, value: string) => {
    lines[line - 1] = value;
  };
  put(145, 'TEST(LazyGroupBy, verifyGroupConcatIsCorrectlyInitialized) {');
  put(158, '  using Gc = GroupConcatAggregationData;');
  put(159, '  EXPECT_THAT(lazyGroupBy.aggregationData_.getAggregationDataVariant(0),');
  put(160, '              VariantWith<sparqlExpression::VectorWithMemoryLimit<Gc>>(');
  return lines.join('\n');
})();

const upstreamSparqlQleverVisitorFixture = `
class SparqlQleverVisitor {
 public:
  [[noreturn]] static void reportError();
  [[noreturn]] static void reportNotSupported();

 private:
  // Convert an instance of \`Triples\` to a \`BasicGraphPattern\` so it can be used
  // just like a WHERE clause.
  parsedQuery::BasicGraphPattern toGraphPattern(
      const ad_utility::sparql_types::Triples& triples) const;
};
`;

const upstreamSparqlAntlrParserTestFixture = (() => {
  const lines = Array.from({ length: 1240 }, () => '');
  const put = (line: number, value: string) => {
    lines[line - 1] = value;
  };
  put(1227, 'TEST(SparqlParser, ensureExceptionOnInvalidGraphTerm) {');
  put(1232, '  EXPECT_THROW(');
  put(1233, '      visitor.toGraphPattern({{Var{"?a"}, BlankNode{true, "0"}, Var{"?b"}}}),');
  put(1234, '      ad_utility::Exception);');
  put(1235, '  EXPECT_THROW(');
  put(1236, '      visitor.toGraphPattern({{Var{"?a"}, Literal{"\\"Abc\\""}, Var{"?b"}}}),');
  put(1237, '      ad_utility::Exception);');
  return lines.join('\n');
})();

const upstreamConstructTripleGeneratorHeaderFixture = "// Copyright 2026 The QLever Authors, in particular:\n// 2026 Marvin Stoetzel <marvin.stoetzel@email.uni-freiburg.de>, UFR\n// UFR = University of Freiburg, Chair of Algorithms and Data Structures\n//\n// You may not use this file except in compliance with the Apache 2.0 License,\n// which can be found in the `LICENSE` file at the root of the QLever project.\n\n#ifndef QLEVER_SRC_ENGINE_CONSTRUCTTRIPLEGENERATOR_H\n#define QLEVER_SRC_ENGINE_CONSTRUCTTRIPLEGENERATOR_H\n\n#include <gtest/gtest_prod.h>\n\n#include \"engine/ConstructBatchEvaluator.h\"\n#include \"engine/ConstructTypes.h\"\n#include \"engine/QueryExecutionTree.h\"\n#include \"engine/QueryExportTypes.h\"\n#include \"engine/Result.h\"\n#include \"engine/VariableToColumnMap.h\"\n#include \"index/Index.h\"\n#include \"util/CancellationHandle.h\"\n#include \"util/Iterators.h\"\n#include \"util/http/MediaTypes.h\"\n\nnamespace qlever::constructExport {\n\nusing ad_utility::InputRangeTypeErased;\nusing CancellationHandle = ad_utility::SharedCancellationHandle;\nusing Triples = ad_utility::sparql_types::Triples;\nusing IdCache =\n    ad_utility::util::LRUCacheWithStatistics<Id, std::optional<EvaluatedTerm>>;\nusing StringTriple = QueryExecutionTree::StringTriple;\n\n// Generates triples from the CONSTRUCT query results by instantiating the\n// template triple patterns with the values from the result table produced by\n// the WHERE clause of the CONSTRUCT query.\nclass ConstructTripleGenerator {\n  friend class ConstructTripleGeneratorTest;\n\n public:\n  // the number of `IdTable` rows that one batch consists of.\n  static constexpr size_t BATCH_SIZE = 1024;\n  // the number of entries in the `IdCache` for each variable in the construct\n  // clause template.\n  static constexpr size_t CACHE_ENTRIES_PER_VARIABLE = 2048;\n\n  // Instantiates `templateTriples` for each row in `rowIndices` and returns a\n  // lazy range of triples serialized according to `mediaType`.\n  static InputRangeTypeErased<std::string> generateFormattedTriples(\n      const Triples& templateTriples, const VariableToColumnMap& variableColums,\n      const Index& index, CancellationHandle cancellationhandle,\n      InputRangeTypeErased<TableWithRange> rowIndices, size_t rowOffset,\n      ad_utility::MediaType mediaType);\n\n  // Instantiates `templateTriples` for each row in `rowIndices` and returns a\n  // lazy range of `StringTriple`.\n  static InputRangeTypeErased<StringTriple> generateStringTriples(\n      const Triples& templateTriples, const VariableToColumnMap& variableColums,\n      const Index& index, CancellationHandle cancellationhandle,\n      InputRangeTypeErased<TableWithRange> rowIndices, size_t rowOffset);\n\n private:\n  // Returns an `IdCache` sized for `tmpl` (minimum one slot to handle\n  // blank-node-only templates).\n  static IdCache makeIdCache(const PreprocessedConstructTemplate& tmpl);\n\n  // Lazily evaluates all `TableWithRange` values from `rowIndices`, processes\n  // them in batches of `BATCH_SIZE` rows, and returns a flat range of\n  // `EvaluatedTriple`.\n  static InputRangeTypeErased<EvaluatedTriple> evaluateTables(\n      const Triples& templateTriples,\n      const VariableToColumnMap& variableColumns, const Index& index,\n      CancellationHandle cancellationhandle,\n      ad_utility::InputRangeTypeErased<TableWithRange> rowIndices,\n      size_t rowOffset);\n\n  FRIEND_TEST(MakeIdCache, emptyTemplate);\n  FRIEND_TEST(MakeIdCache, singleVariable);\n  FRIEND_TEST(MakeIdCache, multipleVariables);\n  FRIEND_TEST(ConstructTripleGeneratorTest, rowOffsetAccumulatesAcrossTables);\n  FRIEND_TEST(ConstructTripleGeneratorTest, cannotCancelDuringBatch);\n  FRIEND_TEST(ConstructTripleGeneratorTest, cancellationThrowsBetweenBatches);\n};\n\n}  // namespace qlever::constructExport\n\n#endif  // QLEVER_SRC_ENGINE_CONSTRUCTTRIPLEGENERATOR_H\n";

const upstreamConstructTripleGeneratorTestFixture = "// Copyright 2026 The QLever Authors, in particular:\n// 2026 Marvin Stoetzel <marvin.stoetzel@email.uni-freiburg.de>, UFR\n//\n// UFR = University of Freiburg, Chair of Algorithms and Data Structures\n\n// You may not use this file except in compliance with the Apache 2.0 License,\n// which can be found in the `LICENSE` file at the root of the QLever project.\n\n#include <gmock/gmock.h>\n\n#include \"./util/IdTableHelpers.h\"\n#include \"./util/TripleComponentTestHelpers.h\"\n#include \"engine/ConstructTripleGenerator.h\"\n#include \"engine/ConstructTripleInstantiator.h\"\n#include \"engine/Result.h\"\n#include \"util/Algorithm.h\"\n#include \"util/CancellationHandle.h\"\n\nnamespace {\n\nusing namespace qlever::constructExport;\nusing ::testing::AllOf;\nusing ::testing::ElementsAre;\nusing ::testing::Field;\nusing ::testing::ResultOf;\nusing Triples = ad_utility::sparql_types::Triples;\n\nauto iriV = ad_utility::testing::iriV;\n\nstatic auto matchTriple(const std::string& s, const std::string& p,\n                        const std::string& o) {\n  auto termStr = [](const EvaluatedTerm& t) {\n    return formatTerm(*t, /*includeDataType=*/false);\n  };\n  return AllOf(Field(&EvaluatedTriple::subject_, ResultOf(termStr, s)),\n               Field(&EvaluatedTriple::predicate_, ResultOf(termStr, p)),\n               Field(&EvaluatedTriple::object_, ResultOf(termStr, o)));\n}\n\nstatic auto matchStringTriple(const std::string& s, const std::string& p,\n                              const std::string& o) {\n  return AllOf(Field(&StringTriple::subject_, s),\n               Field(&StringTriple::predicate_, p),\n               Field(&StringTriple::object_, o));\n}\n\nstatic constexpr auto U = Id::makeUndefined();\n\n}  // namespace\n\nnamespace qlever::constructExport {\n\n// =============================================================================\n// Test fixture.\n// Builds a small index from:\n//   <s> <p> <o> .\n//   <s> <q> \"hello\" .\n//\n// Provides helpers to build `IdTable`s, template triples, and `TableWithRange`\n// values.\n// =============================================================================\n\nclass ConstructTripleGeneratorTest : public ::testing::Test {\n protected:\n  QueryExecutionContext* qec_ =\n      ad_utility::testing::getQec(\"<s> <p> <o> . <s> <q> \\\"hello\\\" .\");\n  const Index& index_ = qec_->getIndex();\n\n  Id idS_ = ad_utility::testing::makeGetId(index_)(\"<s>\");\n  Id idP_ = ad_utility::testing::makeGetId(index_)(\"<p>\");\n  Id idO_ = ad_utility::testing::makeGetId(index_)(\"<o>\");\n  Id idQ_ = ad_utility::testing::makeGetId(index_)(\"<q>\");\n\n  // Create a non-cancelled `CancellationHandle`.\n  static ad_utility::SharedCancellationHandle makeHandle() {\n    return std::make_shared<\n        ad_utility::SharedCancellationHandle::element_type>();\n  }\n\n  // Wrap an `IdTable` in a shared Result (moves the table in).\n  static std::shared_ptr<const Result> makeResult(IdTable table) {\n    return std::make_shared<const Result>(\n        std::move(table), std::vector<ColumnIndex>{}, LocalVocab{});\n  }\n\n  // Create a `TableWithRange` referencing the Result's `IdTable`, covering rows\n  // [start, end).\n  static TableWithRange makeTableWithRange(const Result& result, uint64_t start,\n                                           uint64_t end) {\n    return {TableConstRefWithVocab{result.idTableView(), result.localVocab()},\n            ql::views::iota(start, end)};\n  }\n\n  // Wrap a single `TableWithRange` in an `InputRangeTypeErased`.\n  static ad_utility::InputRangeTypeErased<TableWithRange> singleTableRange(\n      TableWithRange table) {\n    return ad_utility::InputRangeTypeErased{\n        std::vector<TableWithRange>{std::move(table)}};\n  }\n\n  // Run `ConstructTripleGenerator::evaluateTables` over a single\n  // `TableWithRange` and collect `EvaluatedTriple`s.\n  std::vector<EvaluatedTriple> run(\n      Triples triples, VariableToColumnMap varMap, TableWithRange table,\n      ad_utility::SharedCancellationHandle handle = makeHandle()) {\n    auto stringTriples = ConstructTripleGenerator::evaluateTables(\n        triples, varMap, index_, handle, singleTableRange(std::move(table)), 0);\n\n    return ::ranges::to_vector(stringTriples);\n  }\n\n  // Build a single-triple CONSTRUCT template.\n  static Triples oneTriple(GraphTerm s, GraphTerm p, GraphTerm o) {\n    return {std::array{std::move(s), std::move(p), std::move(o)}};\n  }\n};\n\n// =============================================================================\n// Tests\n// =============================================================================\n\n// No rows in the table view -> no triples emitted, regardless of the template.\nTEST_F(ConstructTripleGeneratorTest, emptyTable) {\n  auto result = makeResult(makeIdTableFromVector({}));\n  auto table = makeTableWithRange(*result, 0, 0);  // empty table\n  auto templateTriples = oneTriple(iriV(\"<s>\"), iriV(\"<p>\"), iriV(\"<o>\"));\n\n  EXPECT_TRUE(run(templateTriples, {}, table).empty());\n}\n\n// All-constants template: every result row emits one identical triple,\n// regardless of `IdTable` cell contents.\nTEST_F(ConstructTripleGeneratorTest, allConstantsYieldsOneTriplePerRow) {\n  //              col 0\n  // row 0:       undefined\n  // row 1:       undefined\n  // row 2:       undefined\n  auto result = makeResult(makeIdTableFromVector({{U}, {U}, {U}}));\n  auto table = makeTableWithRange(*result, 0, 3);\n  auto templateTriples = oneTriple(iriV(\"<s>\"), iriV(\"<p>\"), iriV(\"<o>\"));\n\n  EXPECT_THAT(run(templateTriples, {}, table),\n              ElementsAre(matchTriple(\"<s>\", \"<p>\", \"<o>\"),\n                          matchTriple(\"<s>\", \"<p>\", \"<o>\"),\n                          matchTriple(\"<s>\", \"<p>\", \"<o>\")));\n}\n\n// Variable in subject position: correctly resolved from the `IdTable` column.\nTEST_F(ConstructTripleGeneratorTest, variableInSubjectResolved) {\n  //              col 0\n  // row 0:       <s>\n  // row 1:       <o>\n  auto result = makeResult(makeIdTableFromVector({{idS_}, {idO_}}));\n  auto table = makeTableWithRange(*result, 0, 2);\n  auto triples = oneTriple(Variable{\"?sub\"}, iriV(\"<p>\"), iriV(\"<o>\"));\n  VariableToColumnMap varMap;\n  // values of variable ?sub are located in column 0 of `Idtable`.\n  varMap[Variable{\"?sub\"}] = makeAlwaysDefinedColumn(0);\n\n  EXPECT_THAT(run(triples, varMap, table),\n              ElementsAre(matchTriple(\"<s>\", \"<p>\", \"<o>\"),\n                          matchTriple(\"<o>\", \"<p>\", \"<o>\")));\n}\n\n// A row where a variable resolves to an undefined `Id` -> that triple is\n// dropped.\n// Rows before and after the undefined row are unaffected.\nTEST_F(ConstructTripleGeneratorTest, undefDropsTriple) {\n  auto result = makeResult(makeIdTableFromVector({{idS_}, {U}, {idO_}}));\n  auto table = makeTableWithRange(*result, 0, 3);\n  auto triples = oneTriple(Variable{\"?sub\"}, iriV(\"<p>\"), iriV(\"<o>\"));\n  VariableToColumnMap varMap;\n  varMap[Variable{\"?sub\"}] = makeAlwaysDefinedColumn(0);\n\n  EXPECT_THAT(run(triples, varMap, table),\n              ElementsAre(matchTriple(\"<s>\", \"<p>\", \"<o>\"),\n                          matchTriple(\"<o>\", \"<p>\", \"<o>\")));\n}\n\n// Multiple template triples: for each result row all template triples are\n// emitted in row-major order (all template triples for row 0, then row 1, ...).\nTEST_F(ConstructTripleGeneratorTest, multipleTemplateTriples) {\n  auto result = makeResult(makeIdTableFromVector({{idS_}, {idO_}}));\n  auto table = makeTableWithRange(*result, 0, 2);\n  Triples templateTriples{\n      std::array<GraphTerm, 3>{Variable{\"?sub\"}, iriV(\"<p>\"), iriV(\"<o1>\")},\n      std::array<GraphTerm, 3>{Variable{\"?sub\"}, iriV(\"<q>\"), iriV(\"<o2>\")},\n  };\n  VariableToColumnMap varMap;\n  varMap[Variable{\"?sub\"}] = makeAlwaysDefinedColumn(0);\n\n  EXPECT_THAT(run(templateTriples, varMap, table),\n              ElementsAre(matchTriple(\"<s>\", \"<p>\", \"<o1>\"),\n                          matchTriple(\"<s>\", \"<q>\", \"<o2>\"),\n                          matchTriple(\"<o>\", \"<p>\", \"<o1>\"),\n                          matchTriple(\"<o>\", \"<q>\", \"<o2>\")));\n}\n\n// Blank-node row IDs combine rowOffset (accumulated over prior tables),\n// firstRow (view start), and the in-batch row index:\n//   blankNodeRowId = rowOffset + firstRow + rowInBatch\nTEST_F(ConstructTripleGeneratorTest, blankNodeUsesCorrectRowId) {\n  auto result = makeResult(makeIdTableFromVector({{U}, {U}, {U}}));\n\n  // View starts at absolute row 1 of the `IdTable`: firstRow=1, numRows=2.\n  auto table = makeTableWithRange(*result, 1, 3);\n  // Template: _:u<rowId>_node <p> <o>  (rowOffset=0)\n  // row 0 of batch -> blankNodeRowId = 0 + 1 + 0 = 1\n  // row 1 of batch -> blankNodeRowId = 0 + 1 + 1 = 2\n  auto templateTriples =\n      oneTriple(BlankNode{false, \"node\"}, iriV(\"<p>\"), iriV(\"<o>\"));\n\n  EXPECT_THAT(run(templateTriples, {}, table),\n              ElementsAre(matchTriple(\"_:u1_node\", \"<p>\", \"<o>\"),\n                          matchTriple(\"_:u2_node\", \"<p>\", \"<o>\")));\n}\n\n// rowOffset accumulates across multiple tables: blank node IDs from the second\n// table incorporate the row count of the first table.\nTEST_F(ConstructTripleGeneratorTest, rowOffsetAccumulatesAcrossTables) {\n  // Table 1: 3 rows (view 0..3)\n  auto result1 = makeResult(makeIdTableFromVector({{U}, {U}, {U}}));\n  auto table1 = makeTableWithRange(*result1, 0, 3);\n\n  // Table 2: 2 rows (view 5..7, i.e. rows 5 and 6 of its IdTable)\n  auto result2 =\n      makeResult(makeIdTableFromVector({{U}, {U}, {U}, {U}, {U}, {U}, {U}}));\n  auto table2 = makeTableWithRange(*result2, 5, 7);\n\n  auto templateTriples =\n      oneTriple(BlankNode{false, \"x\"}, iriV(\"<p>\"), iriV(\"<o>\"));\n\n  std::vector<TableWithRange> tables{table1, table2};\n\n  auto tableRange =\n      ad_utility::InputRangeTypeErased<TableWithRange>{std::move(tables)};\n\n  auto range = ConstructTripleGenerator::evaluateTables(\n      templateTriples, {}, index_, makeHandle(), std::move(tableRange), 0);\n\n  // Table 1: rowOffset=0, firstRow=0\n  //   row 0: rowId = 0+0+0 = 0\n  //   row 1: rowId = 0+0+1 = 1\n  //   row 2: rowId = 0+0+2 = 2\n  // Table 2: rowOffset=3 (3 rows processed from table1), firstRow=5\n  //   row 0: rowId = 3+5+0 = 8\n  //   row 1: rowId = 3+5+1 = 9\n  EXPECT_THAT(::ranges::to_vector(std::move(range)),\n              ElementsAre(matchTriple(\"_:u0_x\", \"<p>\", \"<o>\"),\n                          matchTriple(\"_:u1_x\", \"<p>\", \"<o>\"),\n                          matchTriple(\"_:u2_x\", \"<p>\", \"<o>\"),\n                          matchTriple(\"_:u8_x\", \"<p>\", \"<o>\"),\n                          matchTriple(\"_:u9_x\", \"<p>\", \"<o>\")));\n}\n\n// A view starting at a non-zero index reads the correct rows from the\n// `IdTable`.\nTEST_F(ConstructTripleGeneratorTest, viewSubrangeReadsCorrectRowsOfIdTable) {\n  //              col 0\n  // row 0:       <s>     <- not in the view\n  // row 1:       <p>     <- firstRow (view starts here)\n  // row 2:       <o>\n  // row 3:       <q>     <- endRow (exclusive)\n  auto result =\n      makeResult(makeIdTableFromVector({{idS_}, {idP_}, {idO_}, {idQ_}}));\n  auto table = makeTableWithRange(*result, 1, 3);\n  auto templateTriples =\n      oneTriple(Variable{\"?sub\"}, iriV(\"<pred>\"), iriV(\"<obj>\"));\n  VariableToColumnMap varMap;\n  varMap[Variable{\"?sub\"}] = makeAlwaysDefinedColumn(0);\n\n  EXPECT_THAT(run(templateTriples, varMap, table),\n              ElementsAre(matchTriple(\"<p>\", \"<pred>\", \"<obj>\"),\n                          matchTriple(\"<o>\", \"<pred>\", \"<obj>\")));\n}\n\n// More than `ConstructTripleGenerator::BATCH_SIZE` rows: the generator\n// correctly crosses the internal batch boundary and yields triples for all\n// rows.\nTEST_F(ConstructTripleGeneratorTest, acrossBatchBoundary) {\n  constexpr size_t N = ConstructTripleGenerator::BATCH_SIZE + 1;\n\n  std::vector<std::vector<IntOrId>> rows(N, std::vector<IntOrId>{idS_});\n  auto result = makeResult(makeIdTableFromVector(rows));\n  auto table = makeTableWithRange(*result, 0, N);\n  auto templateTriples = oneTriple(Variable{\"?sub\"}, iriV(\"<p>\"), iriV(\"<o>\"));\n  VariableToColumnMap varMap;\n  varMap[Variable{\"?sub\"}] = makeAlwaysDefinedColumn(0);\n\n  auto collected = run(templateTriples, varMap, table);\n\n  ASSERT_EQ(collected.size(), N);\n  for (const auto& triple : collected) {\n    EXPECT_THAT(triple, matchTriple(\"<s>\", \"<p>\", \"<o>\"));\n  }\n}\n\n// After consuming all `ConstructTripleGenerator::BATCH_SIZE` triples in\n// batch 0, cancelling the handle causes the next get() call (which would start\n// batch 1) to throw.\nTEST_F(ConstructTripleGeneratorTest, cancellationThrowsBetweenBatches) {\n  constexpr size_t N = ConstructTripleGenerator::BATCH_SIZE + 1;\n\n  std::vector<std::vector<IntOrId>> rows(N, std::vector<IntOrId>{idS_});\n  auto result = makeResult(makeIdTableFromVector(rows));\n  auto table = makeTableWithRange(*result, 0, N);\n  auto templateTriples = oneTriple(iriV(\"<s>\"), iriV(\"<p>\"), iriV(\"<o>\"));\n\n  auto handle = makeHandle();\n  auto range = ConstructTripleGenerator::evaluateTables(\n      templateTriples, {}, index_, handle, singleTableRange(table), 0);\n\n  // Drain all ConstructTripleGenerator::BATCH_SIZE triples from batch\n  // 0.\n  for (size_t i = 0; i < ConstructTripleGenerator::BATCH_SIZE; ++i) {\n    ASSERT_TRUE(range.get().has_value());\n  }\n\n  // Cancel before the next get() triggers batch 1.\n  handle->cancel(ad_utility::CancellationState::MANUAL);\n\n  EXPECT_ANY_THROW(range.get());\n}\n\n// Cancellation is only checked at the start of each batch, not within one.\n// Cancelling mid-batch does not interrupt the current batch: the remaining\n// triples of that batch are still returned.\nTEST_F(ConstructTripleGeneratorTest, cannotCancelDuringBatch) {\n  // Two rows. Both should fit inside a single batch (make sure via assert).\n  static_assert(2 < ConstructTripleGenerator::BATCH_SIZE);\n  auto result = makeResult(makeIdTableFromVector({{idS_}, {idO_}}));\n  auto table = makeTableWithRange(*result, 0, 2);\n  auto templateTriples = oneTriple(iriV(\"<s>\"), iriV(\"<p>\"), iriV(\"<o>\"));\n\n  auto handle = makeHandle();\n  auto range = ConstructTripleGenerator::evaluateTables(\n      templateTriples, {}, index_, handle, singleTableRange(std::move(table)),\n      0);\n\n  // First triple succeeds.\n  ASSERT_TRUE(range.get().has_value());\n\n  // Cancel mid-batch.\n  handle->cancel(ad_utility::CancellationState::MANUAL);\n\n  // Second triple is still returned: the batch was already computed and\n  // cancellation is not re-checked until the next batch starts.\n  EXPECT_TRUE(range.get().has_value());\n\n  // Range exhausted normally, no second batch means no throw.\n  EXPECT_FALSE(range.get().has_value());\n}\n\n// The `IdCache` is shared across batches: for the same `Id`, the\n// `EvaluatedTerm` `shared_ptr` returned in batch 1 is pointer-identical to the\n// one from batch 0, proving the cache was not reset between batches.\nTEST_F(ConstructTripleGeneratorTest, idCacheIsSharedAcrossBatches) {\n  constexpr size_t N = ConstructTripleGenerator::BATCH_SIZE + 1;\n\n  // All rows hold the same ID so the second batch is guaranteed to be a cache\n  // hit if the cache is carried over. This relies on the cache capacity being\n  // larger than `BATCH_SIZE`. The minimum cache capacity is\n  // `CACHE_ENTRIES_PER_VARIABLE` (due to the std::max floor in `makeIdCache`),\n  // which currently exceeds `BATCH_SIZE`.\n  std::vector<std::vector<IntOrId>> rows(N, std::vector<IntOrId>{idS_});\n  auto result = makeResult(makeIdTableFromVector(rows));\n  auto table = makeTableWithRange(*result, 0, N);\n  auto templateTriples = oneTriple(Variable{\"?sub\"}, iriV(\"<p>\"), iriV(\"<o>\"));\n  VariableToColumnMap varMap;\n  varMap[Variable{\"?sub\"}] = makeAlwaysDefinedColumn(0);\n\n  auto collected = run(templateTriples, varMap, std::move(table));\n  ASSERT_EQ(collected.size(), N);\n\n  // Batch 0: row 0. Batch 1: last row. Check pointer equality here.\n  const EvaluatedTerm& fromBatch0 = collected.front().subject_;\n  const EvaluatedTerm& fromBatch1 = collected.back().subject_;\n  EXPECT_EQ(fromBatch0.get(), fromBatch1.get());\n}\n\n// =============================================================================\n// Tests for `ConstructTripleGenerator::makeIdCache`\n// =============================================================================\n\n// Zero variables: the `std::max` floor ensures we never create a zero-capacity\n// cache, so the capacity equals exactly `CACHE_ENTRIES_PER_VARIABLE`.\nTEST(MakeIdCache, emptyTemplate) {\n  PreprocessedConstructTemplate tmpl;\n  auto cache = ConstructTripleGenerator::makeIdCache(tmpl);\n  EXPECT_EQ(cache.capacity(),\n            ConstructTripleGenerator::CACHE_ENTRIES_PER_VARIABLE);\n}\n\n// One variable: the floor is not doing work; result is still\n// `CACHE_ENTRIES_PER_VARIABLE`.\nTEST(MakeIdCache, singleVariable) {\n  PreprocessedConstructTemplate tmpl;\n  tmpl.uniqueVariableColumns_ = {0};\n  auto cache = ConstructTripleGenerator::makeIdCache(tmpl);\n  EXPECT_EQ(cache.capacity(),\n            ConstructTripleGenerator::CACHE_ENTRIES_PER_VARIABLE);\n}\n\n// Multiple variables: capacity scales linearly with the number of unique\n// variable columns.\nTEST(MakeIdCache, multipleVariables) {\n  PreprocessedConstructTemplate tmpl;\n  tmpl.uniqueVariableColumns_ = {0, 1, 2};\n  auto cache = ConstructTripleGenerator::makeIdCache(tmpl);\n  EXPECT_EQ(cache.capacity(),\n            3 * ConstructTripleGenerator::CACHE_ENTRIES_PER_VARIABLE);\n}\n\n// =============================================================================\n// Tests for `ConstructTripleGenerator::generateStringTriples`\n// =============================================================================\n\n// Smoke test: constants are emitted as plain IRI strings in the StringTriple.\nTEST_F(ConstructTripleGeneratorTest, generateStringTriplesFormatsAsStrings) {\n  auto result = makeResult(makeIdTableFromVector({{U}}));\n  auto table = makeTableWithRange(*result, 0, 1);\n  auto templateTriples = oneTriple(iriV(\"<s>\"), iriV(\"<p>\"), iriV(\"<o>\"));\n\n  auto range = ConstructTripleGenerator::generateStringTriples(\n      templateTriples, {}, index_, makeHandle(),\n      singleTableRange(std::move(table)), 0);\n\n  auto triples = ::ranges::to_vector(range);\n\n  EXPECT_THAT(triples, ElementsAre(matchStringTriple(\"<s>\", \"<p>\", \"<o>\")));\n}\n\n// =============================================================================\n// Tests for `ConstructTripleGenerator::generateFormattedTriples`\n// =============================================================================\n\n// Helper: collect all strings from a formatted-triples range.\nstatic std::vector<std::string> collectFormatted(\n    ad_utility::InputRangeTypeErased<std::string> range) {\n  std::vector<std::string> result;\n  while (auto s = range.get()) {\n    result.push_back(std::move(*s));\n  }\n  return result;\n}\n\nstruct FormattedTriplesParam {\n  ad_utility::MediaType mediaType;\n  std::string expected;\n};\n\nclass GenerateFormattedTriplesTest\n    : public ConstructTripleGeneratorTest,\n      public ::testing::WithParamInterface<FormattedTriplesParam> {};\n\nTEST_P(GenerateFormattedTriplesTest, formatsCorrectly) {\n  auto result = makeResult(makeIdTableFromVector({{U}}));\n  auto table = makeTableWithRange(*result, 0, 1);\n  auto templateTriples = oneTriple(iriV(\"<s>\"), iriV(\"<p>\"), iriV(\"<o>\"));\n\n  auto range = ConstructTripleGenerator::generateFormattedTriples(\n      templateTriples, {}, index_, makeHandle(),\n      singleTableRange(std::move(table)), 0, GetParam().mediaType);\n\n  EXPECT_THAT(collectFormatted(std::move(range)),\n              ElementsAre(GetParam().expected));\n}\n\nINSTANTIATE_TEST_SUITE_P(\n    FormattedTripleFormats, GenerateFormattedTriplesTest,\n    ::testing::Values(\n        FormattedTriplesParam{ad_utility::MediaType::turtle, \"<s> <p> <o> .\\n\"},\n        FormattedTriplesParam{ad_utility::MediaType::csv, \"<s>,<p>,<o>\\n\"},\n        FormattedTriplesParam{ad_utility::MediaType::tsv, \"<s>\\t<p>\\t<o>\\n\"}));\n\n// Only turtle, csv, and tsv are supported. Any other media type triggers a\n// contract check failure when the first triple is pulled from the range.\nTEST_F(ConstructTripleGeneratorTest,\n       generateFormattedTriplesRejectsUnsupportedMediaType) {\n  auto result = makeResult(makeIdTableFromVector({{U}}));\n  auto table = makeTableWithRange(*result, 0, 1);\n  auto templateTriples = oneTriple(iriV(\"<s>\"), iriV(\"<p>\"), iriV(\"<o>\"));\n\n  static constexpr std::array supported{ad_utility::MediaType::turtle,\n                                        ad_utility::MediaType::csv,\n                                        ad_utility::MediaType::tsv};\n\n  // expect that unsupported mediatypes throw, expect that supported mediatypes\n  // don't throw.\n  for (const auto& [mediaType, _] : ad_utility::detail::getAllMediaTypes()) {\n    auto range = ConstructTripleGenerator::generateFormattedTriples(\n        templateTriples, {}, index_, makeHandle(), singleTableRange(table), 0,\n        mediaType);\n\n    if (ad_utility::contains(supported, mediaType)) {\n      EXPECT_NO_THROW(range.get());\n    } else {\n      EXPECT_ANY_THROW(range.get());\n    }\n  }\n}\n\n}  // namespace qlever::constructExport\n";


const upstreamExportQueryExecutionTreesHeaderFixture = "// Copyright 2022 - 2026, The QLever Authors, in particular:\n//\n// 2022 - 2026 Johannes Kalmbach <kalmbach@cs.uni-freiburg.de>, UFR\n// 2022 - 2026 Robin Textor-Falconi <textorr@cs.uni-freiburg.de>, UFR\n// 2022 - 2026 Hannah Bast <bast@cs.uni-freiburg.de>, UFR\n// 2026        Marvin Stoetzel <stoetzem@email.uni-freiburg.de>, UFR\n//\n// UFR = University of Freiburg, Chair of Algorithms and Data Structures\n// Copyright 2025, Bayerische Motoren Werke Aktiengesellschaft (BMW AG)\n\n// You may not use this file except in compliance with the Apache 2.0 License,\n// which can be found in the `LICENSE` file at the root of the QLever project.\n\n#ifndef QLEVER_SRC_ENGINE_EXPORTQUERYEXECUTIONTREES_H\n#define QLEVER_SRC_ENGINE_EXPORTQUERYEXECUTIONTREES_H\n\n#include <functional>\n\n#include \"engine/QueryExecutionTree.h\"\n#include \"engine/QueryExportTypes.h\"\n#include \"parser/data/LimitOffsetClause.h\"\n#include \"util/CancellationHandle.h\"\n#include \"util/http/MediaTypes.h\"\n#include \"util/stream_generator.h\"\n\n// Class for computing the result of an already parsed and planned query and\n// exporting it in different formats (TSV, CSV, Turtle, JSON, Binary).\n//\n// TODO<joka921> Also implement a streaming JSON serializer to reduce the RAM\n// consumption of large JSON exports and to make this interface even simpler.\nclass ExportQueryExecutionTrees {\n public:\n  using MediaType = ad_utility::MediaType;\n  using CancellationHandle = ad_utility::SharedCancellationHandle;\n  using LiteralOrIri = ad_utility::triple_component::LiteralOrIri;\n  using Literal = ad_utility::triple_component::Literal;\n\n  // Compute the result of the given `parsedQuery` (created by the\n  // `SparqlParser`) for which the `QueryExecutionTree` has been previously\n  // created by the `QueryPlanner`. The result is converted into a sequence of\n  // bytes that represents the result of the computed query in the format\n  // specified by the `mediaType`. Supported formats for this function are CSV,\n  // TSV, Turtle, Binary, SparqlJSON, QLeverJSON. Note that the Binary format\n  // can only be used with SELECT queries and the Turtle format can only be used\n  // with CONSTRUCT queries. Invalid `mediaType`s and invalid combinations of\n  // `mediaType` and the query type will throw. The result is returned as a\n  // `generator` that lazily computes the serialized result in large chunks of\n  // bytes.\n  using ComputeResultReturnType =\n#ifndef QLEVER_REDUCED_FEATURE_SET_FOR_CPP17\n      cppcoro::generator<std::string>;\n#else\n      void;\n#endif\n  static ComputeResultReturnType computeResult(\n      const ParsedQuery& parsedQuery, const QueryExecutionTree& qet,\n      MediaType mediaType, const ad_utility::Timer& requestTimer,\n      CancellationHandle cancellationHandle, STREAMABLE_YIELDER_ARG_DECL);\n\n  // Convert a `stream_generator` to an \"ordinary\" `InputRange<string>` that\n  // yields exactly the same chunks as the `stream_generator`. Exceptions that\n  // happen during the creation of the first chunk (default chunk size is 1MB)\n  // will be immediately thrown when calling this function. Exceptions that\n  // happen later will be caught and their exception message will be  yielded by\n  // the resulting `generator<string>` together with a message, that explains,\n  // that there is no good mechanism for handling errors during a chunked HTTP\n  // response transfer.\n\n#ifndef QLEVER_REDUCED_FEATURE_SET_FOR_CPP17\n  static ad_utility::InputRangeTypeErased<std::string>\n  convertStreamGeneratorForChunkedTransfer(\n      STREAMABLE_GENERATOR_TYPE streamGenerator);\n#endif\n\n private:\n  // Make sure that the offset is not applied again when exporting the\n  // result (it is already applied by the root operation in the query\n  // execution tree). Note that we don't need this for the limit because\n  // applying a fixed limit is idempotent. This only works because the query\n  // planner does the exact same `handlesLimitOffset()` check.\n  static void compensateForLimitOffsetClause(\n      LimitOffsetClause& limitOffsetClause, const QueryExecutionTree& qet);\n\n  // Generate the bindings of the result of a SELECT or CONSTRUCT query in the\n  // `application/qlever-results+json` format.\n  //\n  // NOTE: This calls `selectQueryResultBindingsToQLeverJSON` or\n  // `constructQueryResultBindingsToQLeverJSON` for the bindings and adds the\n  // remaining (meta) fields needed for the `application/qlever-results+json`\n  // format.\n  static STREAMABLE_GENERATOR_TYPE computeResultAsQLeverJSON(\n      const ParsedQuery& query, const QueryExecutionTree& qet,\n      const LimitOffsetClause& limitOffset,\n      const ad_utility::Timer& requestTimer,\n      CancellationHandle cancellationHandle, STREAMABLE_YIELDER_ARG_DECL);\n\n  // Generate the bindings of the result of a SELECT query in the\n  // `application/ qlever+json` format.\n  static ad_utility::InputRangeTypeErased<std::string>\n  selectQueryResultBindingsToQLeverJSON(\n      const QueryExecutionTree& qet,\n      const parsedQuery::SelectClause& selectClause,\n      const LimitOffsetClause& limitAndOffset,\n      std::shared_ptr<const Result> result, uint64_t& resultSize,\n      CancellationHandle cancellationHandle);\n\n  // Generate the bindings of the result of a CONSTRUCT query in the\n  // `application/ qlever+json` format.\n  static ad_utility::InputRangeTypeErased<std::string>\n  constructQueryResultBindingsToQLeverJSON(\n      const QueryExecutionTree& qet,\n      const ad_utility::sparql_types::Triples& constructTriples,\n      const LimitOffsetClause& limitAndOffset,\n      std::shared_ptr<const Result> result, uint64_t& resultSize,\n      CancellationHandle cancellationHandle);\n\n  // Helper function that generates the individual bindings for the\n  // `application/ qlever+json` format.\n  static auto idTableToQLeverJSONBindings(\n      const QueryExecutionTree& qet, LimitOffsetClause limitAndOffset,\n      const QueryExecutionTree::ColumnIndicesAndTypes columns,\n      std::shared_ptr<const Result> result, uint64_t& resultSize,\n      CancellationHandle cancellationHandle);\n\n  // Helper function that generates the result of a CONSTRUCT query as\n  // `StringTriple`s.\n  static auto constructQueryResultToStringTriples(\n      const QueryExecutionTree& qet,\n      const ad_utility::sparql_types::Triples& constructTriples,\n      LimitOffsetClause limitAndOffset, std::shared_ptr<const Result> result,\n      uint64_t& resultSize, CancellationHandle cancellationHandle);\n\n  // Helper function that generates the result of a CONSTRUCT query as a\n  // CSV or TSV stream.\n  template <MediaType format>\n  static STREAMABLE_GENERATOR_TYPE constructQueryResultToStream(\n      const QueryExecutionTree& qet,\n      const ad_utility::sparql_types::Triples& constructTriples,\n      LimitOffsetClause limitAndOffset, std::shared_ptr<const Result> result,\n      CancellationHandle cancellationHandle, STREAMABLE_YIELDER_ARG_DECL);\n\n  // Generate the result of a SELECT query as a CSV or TSV or binary stream.\n  template <MediaType format>\n  static STREAMABLE_GENERATOR_TYPE selectQueryResultToStream(\n      const QueryExecutionTree& qet,\n      const parsedQuery::SelectClause& selectClause,\n      LimitOffsetClause limitAndOffset, CancellationHandle cancellationHandle,\n      const ad_utility::Timer& requestTimer, STREAMABLE_YIELDER_ARG_DECL);\n\n  // Yield all `IdTables` provided by the given `result`.\n  static ad_utility::InputRangeTypeErased<TableConstRefWithVocab> getIdTables(\n      const Result& result);\n\n  // Generate the result in \"blocks\" and, when iterating over the generator\n  // from beginning to end, return the total number of rows in the result\n  // in `totalResultSize`.\n  //\n  // Blocks, where all rows are before OFFSET, are requested (and hence\n  // computed), but skipped.\n  //\n  // Blocks, where at least one row is after OFFSET but before the effective\n  // export limit (minimum of the LIMIT and the value of the `send` parameter),\n  // are requested and yielded (together with the corresponding `LocalVocab`\n  // and the range from that `IdTable` that belongs to the result).\n  //\n  // Blocks after the effective export limit until the LIMIT are requested, and\n  // counted towards the `totalResultSize`, but not yielded.\n  //\n  // Blocks after the LIMIT are not even requested.\n public:\n  static ad_utility::InputRangeTypeErased<TableWithRange> getRowIndices(\n      const LimitOffsetClause& limitOffset, const Result& result,\n      uint64_t& resutSizeTotal, uint64_t resultSizeMultiplicator = 1);\n\n private:\n  FRIEND_TEST(ExportQueryExecutionTrees, getIdTablesReturnsSingletonIterator);\n  FRIEND_TEST(ExportQueryExecutionTrees, getIdTablesMirrorsGenerator);\n  FRIEND_TEST(ExportQueryExecutionTrees, ensureCorrectSlicingOfSingleIdTable);\n  FRIEND_TEST(ExportQueryExecutionTrees,\n              ensureCorrectSlicingOfIdTablesWhenFirstIsSkipped);\n  FRIEND_TEST(ExportQueryExecutionTrees,\n              ensureCorrectSlicingOfIdTablesWhenLastIsSkipped);\n  FRIEND_TEST(ExportQueryExecutionTrees,\n              ensureCorrectSlicingOfIdTablesWhenFirstAndSecondArePartial);\n  FRIEND_TEST(ExportQueryExecutionTrees,\n              ensureCorrectSlicingOfIdTablesWhenFirstAndLastArePartial);\n  FRIEND_TEST(ExportQueryExecutionTrees,\n              ensureGeneratorIsNotConsumedWhenNotRequired);\n  FRIEND_TEST(ExportQueryExecutionTrees, verifyQleverJsonContainsValidMetadata);\n  FRIEND_TEST(ExportQueryExecutionTrees, compensateForLimitOffsetClause);\n};\n\n#endif  // QLEVER_SRC_ENGINE_EXPORTQUERYEXECUTIONTREES_H\n";

const upstreamExportQueryExecutionTreesTestFixture = "// Copyright 2023 - 2024, University of Freiburg\n// Chair of Algorithms and Data Structures\n// Authors: Johannes Kalmbach <kalmbach@cs.uni-freiburg.de>\n//          Robin Textor-Falconi <robintf@cs.uni-freiburg.de>\n//          Hannah Bast <bast@cs.uni-freiburg.de>\n\n#include <gmock/gmock.h>\n\n#include \"engine/ExportQueryExecutionTrees.h\"\n#include \"engine/IndexScan.h\"\n#include \"engine/QueryExportTypes.h\"\n#include \"engine/QueryPlanner.h\"\n#include \"index/ExportIds.h\"\n#include \"parser/NormalizedString.h\"\n#include \"parser/SparqlParser.h\"\n#include \"rdfTypes/Literal.h\"\n#include \"util/GTestHelpers.h\"\n#include \"util/IdTableHelpers.h\"\n#include \"util/IdTestHelpers.h\"\n#include \"util/IndexTestHelpers.h\"\n#include \"util/ParseableDuration.h\"\n#include \"util/RuntimeParametersTestHelpers.h\"\n\nusing namespace std::string_literals;\nusing namespace std::chrono_literals;\nusing ::testing::ElementsAre;\nusing ::testing::EndsWith;\nusing ::testing::Eq;\nusing ::testing::HasSubstr;\n\nnamespace {\nauto parseQuery(std::string query,\n                const std::vector<DatasetClause>& datasets = {}) {\n  static EncodedIriManager evM;\n  return SparqlParser::parseQuery(&evM, std::move(query), datasets);\n}\n\n// Run the given SPARQL `query` on the given Turtle `kg` and export the result\n// as the `mediaType`. `mediaType` must be TSV or CSV.\nstd::string runQueryStreamableResult(\n    const std::string& kg, const std::string& query,\n    ad_utility::MediaType mediaType, bool useTextIndex = false,\n    std::optional<size_t> exportLimit = std::nullopt) {\n  ad_utility::testing::TestIndexConfig config{kg};\n  config.createTextIndex = useTextIndex;\n  auto qec = ad_utility::testing::getQec(std::move(config));\n  // TODO<joka921> There is a bug in the caching that we have yet to trace.\n  // This cache clearing should not be necessary.\n  qec->clearCacheUnpinnedOnly();\n  auto cancellationHandle =\n      std::make_shared<ad_utility::CancellationHandle<>>();\n  QueryPlanner qp{qec, cancellationHandle};\n  auto pq = parseQuery(query);\n  pq._limitOffset.exportLimit_ = exportLimit;\n  auto qet = qp.createExecutionTree(pq);\n  ad_utility::Timer timer(ad_utility::Timer::Started);\n  auto strGenerator = ExportQueryExecutionTrees::computeResult(\n      pq, qet, mediaType, timer, std::move(cancellationHandle));\n\n  std::string result;\n  for (const auto& block : strGenerator) {\n    result += block;\n  }\n  return result;\n}\n\n// Run the given SPARQL `query` on the given Turtle `kg` and export the result\n// as JSON. `mediaType` must be `sparqlJSON` or `qleverJSON`.\nnlohmann::json runJSONQuery(const std::string& kg, const std::string& query,\n                            ad_utility::MediaType mediaType,\n                            bool useTextIndex = false,\n                            std::optional<size_t> exportLimit = std::nullopt) {\n  ad_utility::testing::TestIndexConfig config{kg};\n  config.createTextIndex = useTextIndex;\n  auto qec = ad_utility::testing::getQec(std::move(config));\n  // TODO<joka921> There is a bug in the caching that we have yet to trace.\n  // This cache clearing should not be necessary.\n  qec->clearCacheUnpinnedOnly();\n  auto cancellationHandle =\n      std::make_shared<ad_utility::CancellationHandle<>>();\n  QueryPlanner qp{qec, cancellationHandle};\n  auto pq = parseQuery(query);\n  pq._limitOffset.exportLimit_ = exportLimit;\n  auto qet = qp.createExecutionTree(pq);\n  ad_utility::Timer timer{ad_utility::Timer::Started};\n  std::string resStr;\n  for (auto c : ExportQueryExecutionTrees::computeResult(\n           pq, qet, mediaType, timer, std::move(cancellationHandle))) {\n    resStr += c;\n  }\n  return nlohmann::json::parse(resStr);\n}\n\n// A test case that tests the correct execution and exporting of a SELECT query\n// in various formats.\nstruct TestCaseSelectQuery {\n  std::string kg;                   // The knowledge graph (TURTLE)\n  std::string query;                // The query (SPARQL)\n  uint64_t resultSize;              // The expected number of results.\n  std::string resultTsv;            // The expected result in TSV format.\n  std::string resultCsv;            // The expected result in CSV format\n  nlohmann::json resultQLeverJSON;  // The expected result in QLeverJSOn format.\n                                    // Note: this member only contains the inner\n                                    // result array with the bindings and NOT\n                                    // the metadata.\n  nlohmann::json resultSparqlJSON;  // The expected result in SparqlJSON format.\n  std::string resultXml;\n};\n\n// A test case that tests the correct execution and exporting of an ASK query\n// in various formats.\nstruct TestCaseAskQuery {\n  std::string kg;                   // The knowledge graph (TURTLE)\n  std::string query;                // The query (SPARQL)\n  nlohmann::json resultQLeverJSON;  // The expected result in QLeverJSON format.\n  // Note: this member only contains the inner\n  // result array with the bindings and NOT\n  // the metadata.\n  nlohmann::json resultSparqlJSON;  // The expected result in SparqlJSON format.\n  std::string resultXml;\n};\n\n// For a CONSTRUCT query, the `resultSize` of the QLever JSON is the number of\n// results of the WHERE clause.\nstruct TestCaseConstructQuery {\n  std::string kg;                   // The knowledge graph (TURTLE)\n  std::string query;                // The query (SPARQL)\n  uint64_t resultSizeTotal;         // The expected number of results,\n                                    // including triples with UNDEF values.\n  uint64_t resultSizeExported;      // The expected number of results exported.\n  std::string resultTsv;            // The expected result in TSV format.\n  std::string resultCsv;            // The expected result in CSV format\n  std::string resultTurtle;         // The expected result in Turtle format\n  nlohmann::json resultQLeverJSON;  // The expected result in QLeverJSOn format.\n                                    // Note: this member only contains the inner\n                                    // result array with the bindings and NOT\n                                    // the metadata.\n  // How many triples the construct query contains.\n  size_t numTriples = 1;\n};\n\n// Run a single test case for a SELECT query.\nvoid runSelectQueryTestCase(\n    const TestCaseSelectQuery& testCase, bool useTextIndex = false,\n    ad_utility::source_location l = AD_CURRENT_SOURCE_LOC()) {\n  auto cleanup = setRuntimeParameterForTest<\n      &RuntimeParameters::sparqlResultsJsonWithTime_>(false);\n  auto trace = generateLocationTrace(l, \"runSelectQueryTestCase\");\n  using enum ad_utility::MediaType;\n  EXPECT_EQ(\n      runQueryStreamableResult(testCase.kg, testCase.query, tsv, useTextIndex),\n      testCase.resultTsv);\n  EXPECT_EQ(\n      runQueryStreamableResult(testCase.kg, testCase.query, csv, useTextIndex),\n      testCase.resultCsv);\n\n  auto resultJSON = nlohmann::json::parse(runQueryStreamableResult(\n      testCase.kg, testCase.query, qleverJson, useTextIndex));\n  // TODO<joka921> Test other members of the JSON result (e.g. the selected\n  // variables).\n  ASSERT_EQ(resultJSON[\"query\"], testCase.query);\n  ASSERT_EQ(resultJSON[\"resultSizeTotal\"], testCase.resultSize);\n  ASSERT_EQ(resultJSON[\"resultSizeExported\"], testCase.resultSize);\n  EXPECT_EQ(resultJSON[\"res\"], testCase.resultQLeverJSON);\n\n  EXPECT_EQ(nlohmann::json::parse(runQueryStreamableResult(\n                testCase.kg, testCase.query, sparqlJson, useTextIndex)),\n            testCase.resultSparqlJSON);\n\n  // TODO<joka921> Use this for proper testing etc.\n  auto xmlAsString = runQueryStreamableResult(testCase.kg, testCase.query,\n                                              sparqlXml, useTextIndex);\n  EXPECT_EQ(testCase.resultXml, xmlAsString);\n\n  // Test the interaction of normal limit (the LIMIT of the query) and export\n  // limit (the value of the `send` parameter).\n  for (uint64_t exportLimit = 0ul; exportLimit < 4ul; ++exportLimit) {\n    auto resultJson = nlohmann::json::parse(runQueryStreamableResult(\n        testCase.kg, testCase.query, qleverJson, useTextIndex, exportLimit));\n    ASSERT_EQ(resultJson[\"resultSizeTotal\"], testCase.resultSize);\n    ASSERT_EQ(resultJson[\"resultSizeExported\"],\n              std::min(exportLimit, testCase.resultSize));\n  }\n}\n\n// Run a single test case for a CONSTRUCT query.\nvoid runConstructQueryTestCase(\n    const TestCaseConstructQuery& testCase,\n    ad_utility::source_location l = AD_CURRENT_SOURCE_LOC()) {\n  auto cleanup = setRuntimeParameterForTest<\n      &RuntimeParameters::sparqlResultsJsonWithTime_>(false);\n  auto trace = generateLocationTrace(l, \"runConstructQueryTestCase\");\n  using enum ad_utility::MediaType;\n  EXPECT_EQ(runQueryStreamableResult(testCase.kg, testCase.query, tsv),\n            testCase.resultTsv);\n  EXPECT_EQ(runQueryStreamableResult(testCase.kg, testCase.query, csv),\n            testCase.resultCsv);\n  auto resultJson = nlohmann::json::parse(\n      runQueryStreamableResult(testCase.kg, testCase.query, qleverJson));\n  ASSERT_EQ(resultJson[\"query\"], testCase.query);\n  ASSERT_EQ(resultJson[\"resultSizeTotal\"], testCase.resultSizeTotal);\n  ASSERT_EQ(resultJson[\"resultSizeExported\"], testCase.resultSizeExported);\n  EXPECT_EQ(resultJson[\"res\"], testCase.resultQLeverJSON);\n  EXPECT_EQ(runQueryStreamableResult(testCase.kg, testCase.query, turtle),\n            testCase.resultTurtle);\n\n  // Test the interaction of normal limit (the LIMIT of the query) and export\n  // limit (the value of the `send` parameter).\n  for (uint64_t exportLimit = 0ul; exportLimit < 4ul; ++exportLimit) {\n    auto resultJson = nlohmann::json::parse(runQueryStreamableResult(\n        testCase.kg, testCase.query, qleverJson, false, exportLimit));\n    ASSERT_EQ(resultJson[\"resultSizeTotal\"], testCase.resultSizeTotal);\n    ASSERT_EQ(resultJson[\"resultSizeExported\"],\n              std::min(exportLimit * testCase.numTriples,\n                       testCase.resultSizeExported));\n  }\n}\n\n// Run a single test case for an ASK query.\nvoid runAskQueryTestCase(\n    const TestCaseAskQuery& testCase,\n    ad_utility::source_location l = AD_CURRENT_SOURCE_LOC()) {\n  auto trace = generateLocationTrace(l, \"runAskQueryTestCase\");\n  using enum ad_utility::MediaType;\n  // TODO<joka921> match the exception\n  EXPECT_ANY_THROW(runQueryStreamableResult(testCase.kg, testCase.query, tsv));\n  EXPECT_ANY_THROW(runQueryStreamableResult(testCase.kg, testCase.query, csv));\n  EXPECT_ANY_THROW(\n      runQueryStreamableResult(testCase.kg, testCase.query, octetStream));\n  EXPECT_ANY_THROW(\n      runQueryStreamableResult(testCase.kg, testCase.query, turtle));\n  auto resultJson = nlohmann::json::parse(\n      runQueryStreamableResult(testCase.kg, testCase.query, qleverJson));\n  ASSERT_EQ(resultJson[\"query\"], testCase.query);\n  ASSERT_EQ(resultJson[\"resultSizeExported\"], 1u);\n  EXPECT_EQ(resultJson[\"res\"], testCase.resultQLeverJSON);\n\n  EXPECT_EQ(nlohmann::json::parse(runQueryStreamableResult(\n                testCase.kg, testCase.query, sparqlJson)),\n            testCase.resultSparqlJSON);\n\n  auto xmlAsString =\n      runQueryStreamableResult(testCase.kg, testCase.query, sparqlXml);\n  EXPECT_EQ(testCase.resultXml, xmlAsString);\n}\n\n// Create a `json` that can be used as the `resultQLeverJSON` of a\n// `TestCaseSelectQuery`. This function can only be used when there is a single\n// variable in the result. The `values` then become the bindings of that\n// variable.\nnlohmann::json makeExpectedQLeverJSON(\n    const std::vector<std::optional<std::string>>& values) {\n  nlohmann::json j;\n  for (const auto& value : values) {\n    if (value.has_value()) {\n      j.push_back(std::vector{value.value()});\n    } else {\n      j.emplace_back();\n      j.back().push_back(nullptr);\n    }\n  }\n  return j;\n}\n\n// Create a single binding in the `SparqlJSON` format from the given `datatype`\n// `type`, `value` and `langtag`. `datatype` and `langtag` are not always\n// present, so those arguments are of type `std::optional`.\nnlohmann::json makeJSONBinding(\n    const std::optional<std::string>& datatype, const std::string& type,\n    const std::string& value,\n    const std::optional<std::string>& langtag = std::nullopt) {\n  std::unordered_map<std::string, std::string> m;\n  if (datatype.has_value()) {\n    m[\"datatype\"] = datatype.value();\n  }\n  m[\"type\"] = type;\n  m[\"value\"] = value;\n  if (langtag.has_value()) {\n    m[\"xml:lang\"] = langtag.value();\n  }\n  return m;\n}\n\n// Create a `json` that can be used as the `resultSparqlJSON` member of a\n// `TestCaseSelectQuery`. This function can only be used when there is a single\n// variable called `?o` in the result. The `bindings` then become the bindings\n// of that variable. These bindings are typically created via the\n// `makeJSONBinding` function.\nnlohmann::json makeExpectedSparqlJSON(\n    const std::vector<nlohmann::json>& bindings) {\n  nlohmann::json j;\n  j[\"head\"][\"vars\"].push_back(\"o\");\n  auto& res = j[\"results\"][\"bindings\"];\n  res = std::vector<std::string>{};\n  for (const auto& binding : bindings) {\n    res.emplace_back();\n    res.back()[\"o\"] = binding;\n  }\n  return j;\n}\n\n// Return a header of a SPARQL XML export including the given variables until\n// the opening `<results>` tag.\nstatic std::string makeXMLHeader(\n    std::vector<std::string> varsWithoutQuestionMark) {\n  std::string result = R\"(<?xml version=\"1.0\"?>\n<sparql xmlns=\"http://www.w3.org/2005/sparql-results#\">\n<head>)\";\n  for (const auto& var : varsWithoutQuestionMark) {\n    absl::StrAppend(&result, \"\\n  <variable name=\\\"\", var, R\"(\"/>)\");\n  }\n  absl::StrAppend(&result, \"\\n</head>\\n<results>\");\n  return result;\n}\n\n// The end of a SPARQL XML export.\nstatic const std::string xmlTrailer = \"\\n</results>\\n</sparql>\";\n\n// Helper function for easier testing of the `IdTable` generator.\nstd::vector<IdTable> convertToVector(\n    ad_utility::InputRangeTypeErased<TableConstRefWithVocab> generator) {\n  std::vector<IdTable> result;\n  for (const TableConstRefWithVocab& pair : generator) {\n    result.push_back(pair.idTable().clone());\n  }\n  return result;\n}\n\n// match the contents of a `vector<IdTable>` to the given `tables`.\ntemplate <typename... Tables>\nauto matchesIdTables(const Tables&... tables) {\n  return ElementsAre(matchesIdTable(tables)...);\n}\n\nstd::vector<IdTable> convertToVector(\n    ad_utility::InputRangeTypeErased<TableWithRange> generator) {\n  std::vector<IdTable> result;\n  for (const auto& [pair, range] : generator) {\n    const auto& idTable = pair.idTable();\n    result.emplace_back(idTable.numColumns(), idTable.getAllocator());\n    result.back().insertAtEnd(idTable, *range.begin(), *(range.end() - 1) + 1);\n  }\n  return result;\n}\n\nstd::chrono::milliseconds toChrono(std::string_view string) {\n  EXPECT_THAT(string, EndsWith(\"ms\"));\n  return ad_utility::ParseableDuration<std::chrono::milliseconds>::fromString(\n      string);\n}\n}  // namespace\n\n// ____________________________________________________________________________\nTEST(ExportQueryExecutionTrees, Integers) {\n  std::string kg =\n      \"<s> <p> 42 . <s> <p> -42019234865781 . <s> <p> 4012934858173560\";\n  std::string query = \"SELECT ?o WHERE {?s ?p ?o} ORDER BY ?o\";\n  std::string expectedXml = makeXMLHeader({\"o\"}) +\n                            R\"(\n  <result>\n    <binding name=\"o\"><literal datatype=\"http://www.w3.org/2001/XMLSchema#int\">-42019234865781</literal></binding>\n  </result>\n  <result>\n    <binding name=\"o\"><literal datatype=\"http://www.w3.org/2001/XMLSchema#int\">42</literal></binding>\n  </result>\n  <result>\n    <binding name=\"o\"><literal datatype=\"http://www.w3.org/2001/XMLSchema#int\">4012934858173560</literal></binding>\n  </result>)\" + xmlTrailer;\n  TestCaseSelectQuery testCase{\n      kg, query, 3,\n      // TSV\n      \"?o\\n\"\n      \"-42019234865781\\n\"\n      \"42\\n\"\n      \"4012934858173560\\n\",\n      // CSV\n      \"o\\n\"\n      \"-42019234865781\\n\"\n      \"42\\n\"\n      \"4012934858173560\\n\",\n      makeExpectedQLeverJSON(\n          {\"\\\"-42019234865781\\\"^^<http://www.w3.org/2001/XMLSchema#int>\"s,\n           \"\\\"42\\\"^^<http://www.w3.org/2001/XMLSchema#int>\"s,\n           \"\\\"4012934858173560\\\"^^<http://www.w3.org/2001/XMLSchema#int>\"s}),\n      makeExpectedSparqlJSON(\n          {makeJSONBinding(\"http://www.w3.org/2001/XMLSchema#int\", \"literal\",\n                           \"-42019234865781\"),\n           makeJSONBinding(\"http://www.w3.org/2001/XMLSchema#int\", \"literal\",\n                           \"42\"),\n           makeJSONBinding(\"http://www.w3.org/2001/XMLSchema#int\", \"literal\",\n                           \"4012934858173560\")}),\n      expectedXml};\n  runSelectQueryTestCase(testCase);\n\n  TestCaseConstructQuery testCaseConstruct{\n      kg, \"CONSTRUCT {?s ?p ?o} WHERE {?s ?p ?o} ORDER BY ?o\", 3, 3,\n      // TSV\n      \"<s>\\t<p>\\t-42019234865781\\n\"\n      \"<s>\\t<p>\\t42\\n\"\n      \"<s>\\t<p>\\t4012934858173560\\n\",\n      // CSV\n      \"<s>,<p>,-42019234865781\\n\"\n      \"<s>,<p>,42\\n\"\n      \"<s>,<p>,4012934858173560\\n\",\n      // Turtle\n      \"<s> <p> -42019234865781 .\\n\"\n      \"<s> <p> 42 .\\n\"\n      \"<s> <p> 4012934858173560 .\\n\",\n      []() {\n        nlohmann::json j;\n        j.push_back(std::vector{\"<s>\"s, \"<p>\"s, \"-42019234865781\"s});\n        j.push_back(std::vector{\"<s>\"s, \"<p>\"s, \"42\"s});\n        j.push_back(std::vector{\"<s>\"s, \"<p>\"s, \"4012934858173560\"s});\n        return j;\n      }()};\n  runConstructQueryTestCase(testCaseConstruct);\n}\n\n// ____________________________________________________________________________\nTEST(ExportQueryExecutionTrees, Bool) {\n  std::string kg =\n      \"<s> <p> true . <s> <p> false .\"\n      \" <s2> <p2> \\\"1\\\"^^<http://www.w3.org/2001/XMLSchema#boolean> .\"\n      \" <s2> <p2> \\\"0\\\"^^<http://www.w3.org/2001/XMLSchema#boolean> .\";\n  std::string query = \"SELECT ?o WHERE {?s ?p ?o} ORDER BY ?o\";\n\n  std::string expectedXml = makeXMLHeader({\"o\"}) +\n                            R\"(\n  <result>\n    <binding name=\"o\"><literal datatype=\"http://www.w3.org/2001/XMLSchema#boolean\">false</literal></binding>\n  </result>\n  <result>\n    <binding name=\"o\"><literal datatype=\"http://www.w3.org/2001/XMLSchema#boolean\">0</literal></binding>\n  </result>\n  <result>\n    <binding name=\"o\"><literal datatype=\"http://www.w3.org/2001/XMLSchema#boolean\">true</literal></binding>\n  </result>\n  <result>\n    <binding name=\"o\"><literal datatype=\"http://www.w3.org/2001/XMLSchema#boolean\">1</literal></binding>\n  </result>)\" + xmlTrailer;\n  TestCaseSelectQuery testCase{\n      kg, query, 4,\n      // TSV\n      \"?o\\n\"\n      \"false\\n\"\n      \"0\\n\"\n      \"true\\n\"\n      \"1\\n\",\n      // CSV\n      \"o\\n\"\n      \"false\\n\"\n      \"0\\n\"\n      \"true\\n\"\n      \"1\\n\",\n      makeExpectedQLeverJSON(\n          {\"\\\"false\\\"^^<http://www.w3.org/2001/XMLSchema#boolean>\"s,\n           \"\\\"0\\\"^^<http://www.w3.org/2001/XMLSchema#boolean>\"s,\n           \"\\\"true\\\"^^<http://www.w3.org/2001/XMLSchema#boolean>\"s,\n           \"\\\"1\\\"^^<http://www.w3.org/2001/XMLSchema#boolean>\"s}),\n      makeExpectedSparqlJSON(\n          {makeJSONBinding(\"http://www.w3.org/2001/XMLSchema#boolean\",\n                           \"literal\", \"false\"),\n           makeJSONBinding(\"http://www.w3.org/2001/XMLSchema#boolean\",\n                           \"literal\", \"0\"),\n           makeJSONBinding(\"http://www.w3.org/2001/XMLSchema#boolean\",\n                           \"literal\", \"true\"),\n           makeJSONBinding(\"http://www.w3.org/2001/XMLSchema#boolean\",\n                           \"literal\", \"1\")}),\n      expectedXml};\n  runSelectQueryTestCase(testCase);\n\n  TestCaseConstructQuery testCaseConstruct{\n      kg, \"CONSTRUCT {?s ?p ?o} WHERE {?s ?p ?o} ORDER BY ?o\", 4, 4,\n      // TSV\n      \"<s>\\t<p>\\tfalse\\n\"\n      \"<s2>\\t<p2>\\t\\\"0\\\"^^<http://www.w3.org/2001/XMLSchema#boolean>\\n\"\n      \"<s>\\t<p>\\ttrue\\n\"\n      \"<s2>\\t<p2>\\t\\\"1\\\"^^<http://www.w3.org/2001/XMLSchema#boolean>\\n\",\n      // CSV\n      \"<s>,<p>,false\\n\"\n      \"<s2>,<p2>,\\\"\\\"\\\"0\\\"\\\"^^<http://www.w3.org/2001/XMLSchema#boolean>\\\"\\n\"\n      \"<s>,<p>,true\\n\"\n      \"<s2>,<p2>,\\\"\\\"\\\"1\\\"\\\"^^<http://www.w3.org/2001/XMLSchema#boolean>\\\"\\n\",\n      // Turtle\n      \"<s> <p> false .\\n\"\n      \"<s2> <p2> \\\"0\\\"^^<http://www.w3.org/2001/XMLSchema#boolean> .\\n\"\n      \"<s> <p> true .\\n\"\n      \"<s2> <p2> \\\"1\\\"^^<http://www.w3.org/2001/XMLSchema#boolean> .\\n\",\n      []() {\n        nlohmann::json j;\n        j.push_back(std::vector{\"<s>\"s, \"<p>\"s, \"false\"s});\n        j.push_back(\n            std::vector{\"<s2>\"s, \"<p2>\"s,\n                        \"\\\"0\\\"^^<http://www.w3.org/2001/XMLSchema#boolean>\"s});\n        j.push_back(std::vector{\"<s>\"s, \"<p>\"s, \"true\"s});\n        j.push_back(\n            std::vector{\"<s2>\"s, \"<p2>\"s,\n                        \"\\\"1\\\"^^<http://www.w3.org/2001/XMLSchema#boolean>\"s});\n        return j;\n      }()};\n  runConstructQueryTestCase(testCaseConstruct);\n}\n\n// ____________________________________________________________________________\nTEST(ExportQueryExecutionTrees, UnusedVariable) {\n  std::string kg = \"<s> <p> true . <s> <p> false.\";\n  std::string query = \"SELECT ?o WHERE {?s ?p ?x} ORDER BY ?s\";\n  std::string expectedXml = makeXMLHeader({\"o\"}) + R\"(\n  <result>\n  </result>\n  <result>\n  </result>)\" + xmlTrailer;\n  TestCaseSelectQuery testCase{\n      kg, query, 2,\n      // TSV\n      \"?o\\n\"\n      \"\\n\"\n      \"\\n\",\n      // CSV\n      \"o\\n\"\n      \"\\n\"\n      \"\\n\",\n      makeExpectedQLeverJSON({std::nullopt, std::nullopt}),\n      []() {\n        nlohmann::json j;\n        j[\"head\"][\"vars\"].push_back(\"o\");\n        j[\"results\"][\"bindings\"].push_back({});\n        j[\"results\"][\"bindings\"].push_back({});\n        return j;\n      }(),\n      expectedXml};\n  runSelectQueryTestCase(testCase);\n\n  // The `2` is the number of results including triples with UNDEF values. The\n  // `0` is the number of results excluding such triples.\n  TestCaseConstructQuery testCaseConstruct{\n      kg, \"CONSTRUCT {?x ?p ?o} WHERE {?s ?p ?o} ORDER BY ?o\", 2, 0,\n      // TSV\n      \"\",\n      // CSV\n      \"\",\n      // Turtle\n      \"\", []() { return nlohmann::json::parse(\"[]\"); }()};\n  runConstructQueryTestCase(testCaseConstruct);\n}\n\n// ____________________________________________________________________________\nTEST(ExportQueryExecutionTrees, Floats) {\n  std::string kg =\n      \"<s> <p> 42.2 . <s> <p> -42019234865.781e12 .\"\n      \" <s> <p> 100.0 . <s> <p> 960000.06 .\"\n      \" <s> <p> 123456.00000001 . <s> <p> 1e-10 .\"\n      \" <s> <p> 4.012934858173560e-12 .\"\n      \" <s> <p> \\\"NaN\\\"^^<http://www.w3.org/2001/XMLSchema#double> .\"\n      \" <s> <p> \\\"INF\\\"^^<http://www.w3.org/2001/XMLSchema#double> .\"\n      \" <s> <p> \\\"-INF\\\"^^<http://www.w3.org/2001/XMLSchema#double> .\";\n  std::string query = \"SELECT ?o WHERE {?s ?p ?o} ORDER BY ?o\";\n\n  std::string expectedXml = makeXMLHeader({\"o\"}) +\n                            R\"(\n  <result>\n    <binding name=\"o\"><literal datatype=\"http://www.w3.org/2001/XMLSchema#double\">-INF</literal></binding>\n  </result>\n  <result>\n    <binding name=\"o\"><literal datatype=\"http://www.w3.org/2001/XMLSchema#decimal\">-42019234865780982022144.0</literal></binding>\n  </result>\n  <result>\n    <binding name=\"o\"><literal datatype=\"http://www.w3.org/2001/XMLSchema#decimal\">4.012934858174e-12</literal></binding>\n  </result>\n  <result>\n    <binding name=\"o\"><literal datatype=\"http://www.w3.org/2001/XMLSchema#decimal\">1e-10</literal></binding>\n  </result>\n  <result>\n    <binding name=\"o\"><literal datatype=\"http://www.w3.org/2001/XMLSchema#decimal\">42.2</literal></binding>\n  </result>\n  <result>\n    <binding name=\"o\"><literal datatype=\"http://www.w3.org/2001/XMLSchema#decimal\">100.0</literal></binding>\n  </result>\n  <result>\n    <binding name=\"o\"><literal datatype=\"http://www.w3.org/2001/XMLSchema#decimal\">123456.0</literal></binding>\n  </result>\n  <result>\n    <binding name=\"o\"><literal datatype=\"http://www.w3.org/2001/XMLSchema#decimal\">960000.06</literal></binding>\n  </result>\n  <result>\n    <binding name=\"o\"><literal datatype=\"http://www.w3.org/2001/XMLSchema#double\">INF</literal></binding>\n  </result>\n  <result>\n    <binding name=\"o\"><literal datatype=\"http://www.w3.org/2001/XMLSchema#double\">NaN</literal></binding>\n  </result>)\" + xmlTrailer;\n  TestCaseSelectQuery testCaseFloat{\n      kg, query, 10,\n      // TSV\n      \"?o\\n\"\n      \"-INF\\n\"\n      \"-42019234865780982022144.0\\n\"\n      \"4.012934858174e-12\\n\"\n      \"1e-10\\n\"\n      \"42.2\\n\"\n      \"100.0\\n\"\n      \"123456.0\\n\"\n      \"960000.06\\n\"\n      \"INF\\n\"\n      \"NaN\\n\",\n      // CSV\n      \"o\\n\"\n      \"-INF\\n\"\n      \"-42019234865780982022144.0\\n\"\n      \"4.012934858174e-12\\n\"\n      \"1e-10\\n\"\n      \"42.2\\n\"\n      \"100.0\\n\"\n      \"123456.0\\n\"\n      \"960000.06\\n\"\n      \"INF\\n\"\n      \"NaN\\n\",\n      makeExpectedQLeverJSON(\n          {\"\\\"-INF\\\"^^<http://www.w3.org/2001/XMLSchema#double>\"s,\n           \"\\\"-42019234865780982022144.0\\\"^^<http://www.w3.org/2001/XMLSchema#decimal>\"s,\n           \"\\\"4.012934858174e-12\\\"^^<http://www.w3.org/2001/XMLSchema#decimal>\"s,\n           \"\\\"1e-10\\\"^^<http://www.w3.org/2001/XMLSchema#decimal>\"s,\n           \"\\\"42.2\\\"^^<http://www.w3.org/2001/XMLSchema#decimal>\"s,\n           \"\\\"100.0\\\"^^<http://www.w3.org/2001/XMLSchema#decimal>\"s,\n           \"\\\"123456.0\\\"^^<http://www.w3.org/2001/XMLSchema#decimal>\"s,\n           \"\\\"960000.06\\\"^^<http://www.w3.org/2001/XMLSchema#decimal>\"s,\n           \"\\\"INF\\\"^^<http://www.w3.org/2001/XMLSchema#double>\"s,\n           \"\\\"NaN\\\"^^<http://www.w3.org/2001/XMLSchema#double>\"s}),\n      makeExpectedSparqlJSON(\n          {makeJSONBinding(\"http://www.w3.org/2001/XMLSchema#double\", \"literal\",\n                           \"-INF\"),\n           makeJSONBinding(\"http://www.w3.org/2001/XMLSchema#decimal\",\n                           \"literal\", \"-42019234865780982022144.0\"),\n           makeJSONBinding(\"http://www.w3.org/2001/XMLSchema#decimal\",\n                           \"literal\", \"4.012934858174e-12\"),\n           makeJSONBinding(\"http://www.w3.org/2001/XMLSchema#decimal\",\n                           \"literal\", \"1e-10\"),\n           makeJSONBinding(\"http://www.w3.org/2001/XMLSchema#decimal\",\n                           \"literal\", \"42.2\"),\n           makeJSONBinding(\"http://www.w3.org/2001/XMLSchema#decimal\",\n                           \"literal\", \"100.0\"),\n           makeJSONBinding(\"http://www.w3.org/2001/XMLSchema#decimal\",\n                           \"literal\", \"123456.0\"),\n           makeJSONBinding(\"http://www.w3.org/2001/XMLSchema#decimal\",\n                           \"literal\", \"960000.06\"),\n           makeJSONBinding(\"http://www.w3.org/2001/XMLSchema#double\", \"literal\",\n                           \"INF\"),\n           makeJSONBinding(\"http://www.w3.org/2001/XMLSchema#double\", \"literal\",\n                           \"NaN\")}),\n      expectedXml};\n  runSelectQueryTestCase(testCaseFloat);\n\n  TestCaseConstructQuery testCaseConstruct{\n      kg, \"CONSTRUCT {?s ?p ?o} WHERE {?s ?p ?o} ORDER BY ?o\", 10, 10,\n      // TSV\n      \"<s>\\t<p>\\t\\\"-INF\\\"^^<http://www.w3.org/2001/XMLSchema#double>\\n\"\n      \"<s>\\t<p>\\t-42019234865780982022144.0\\n\"\n      \"<s>\\t<p>\\t4.012934858174e-12\\n\"\n      \"<s>\\t<p>\\t1e-10\\n\"\n      \"<s>\\t<p>\\t42.2\\n\"\n      \"<s>\\t<p>\\t100.0\\n\"\n      \"<s>\\t<p>\\t123456.0\\n\"\n      \"<s>\\t<p>\\t960000.06\\n\"\n      \"<s>\\t<p>\\t\\\"INF\\\"^^<http://www.w3.org/2001/XMLSchema#double>\\n\"\n      \"<s>\\t<p>\\t\\\"NaN\\\"^^<http://www.w3.org/2001/XMLSchema#double>\\n\",\n      // CSV\n      \"<s>,<p>,\\\"\\\"\\\"-INF\\\"\\\"^^<http://www.w3.org/2001/XMLSchema#double>\\\"\\n\"\n      \"<s>,<p>,-42019234865780982022144.0\\n\"\n      \"<s>,<p>,4.012934858174e-12\\n\"\n      \"<s>,<p>,1e-10\\n\"\n      \"<s>,<p>,42.2\\n\"\n      \"<s>,<p>,100.0\\n\"\n      \"<s>,<p>,123456.0\\n\"\n      \"<s>,<p>,960000.06\\n\"\n      \"<s>,<p>,\\\"\\\"\\\"INF\\\"\\\"^^<http://www.w3.org/2001/XMLSchema#double>\\\"\\n\"\n      \"<s>,<p>,\\\"\\\"\\\"NaN\\\"\\\"^^<http://www.w3.org/2001/XMLSchema#double>\\\"\\n\",\n      // Turtle\n      \"<s> <p> \\\"-INF\\\"^^<http://www.w3.org/2001/XMLSchema#double> .\\n\"\n      \"<s> <p> -42019234865780982022144.0 .\\n\"\n      \"<s> <p> 4.012934858174e-12 .\\n\"\n      \"<s> <p> 1e-10 .\\n\"\n      \"<s> <p> 42.2 .\\n\"\n      \"<s> <p> 100.0 .\\n\"\n      \"<s> <p> 123456.0 .\\n\"\n      \"<s> <p> 960000.06 .\\n\"\n      \"<s> <p> \\\"INF\\\"^^<http://www.w3.org/2001/XMLSchema#double> .\\n\"\n      \"<s> <p> \\\"NaN\\\"^^<http://www.w3.org/2001/XMLSchema#double> .\\n\",\n      []() {\n        nlohmann::json j;\n        j.push_back(std::vector{\n            \"<s>\"s, \"<p>\"s,\n            \"\\\"-INF\\\"^^<http://www.w3.org/2001/XMLSchema#double>\"s});\n        j.push_back(std::vector{\"<s>\"s, \"<p>\"s, \"-42019234865780982022144.0\"s});\n        j.push_back(std::vector{\"<s>\"s, \"<p>\"s, \"4.012934858174e-12\"s});\n        j.push_back(std::vector{\"<s>\"s, \"<p>\"s, \"1e-10\"s});\n        j.push_back(std::vector{\"<s>\"s, \"<p>\"s, \"42.2\"s});\n        j.push_back(std::vector{\"<s>\"s, \"<p>\"s, \"100.0\"s});\n        j.push_back(std::vector{\"<s>\"s, \"<p>\"s, \"123456.0\"s});\n        j.push_back(std::vector{\"<s>\"s, \"<p>\"s, \"960000.06\"s});\n        j.push_back(\n            std::vector{\"<s>\"s, \"<p>\"s,\n                        \"\\\"INF\\\"^^<http://www.w3.org/2001/XMLSchema#double>\"s});\n        j.push_back(\n            std::vector{\"<s>\"s, \"<p>\"s,\n                        \"\\\"NaN\\\"^^<http://www.w3.org/2001/XMLSchema#double>\"s});\n        return j;\n      }()};\n  runConstructQueryTestCase(testCaseConstruct);\n}\n\n// ____________________________________________________________________________\nTEST(ExportQueryExecutionTrees, Dates) {\n  std::string kg =\n      \"<s> <p> \"\n      \"\\\"1950-01-01T00:00:00\\\"^^<http://www.w3.org/2001/XMLSchema#dateTime>.\";\n  std::string query = \"SELECT ?o WHERE {?s ?p ?o} ORDER BY ?o\";\n  std::string expectedXml = makeXMLHeader({\"o\"}) +\n                            R\"(\n  <result>\n    <binding name=\"o\"><literal datatype=\"http://www.w3.org/2001/XMLSchema#dateTime\">1950-01-01T00:00:00</literal></binding>\n  </result>)\" + xmlTrailer;\n  TestCaseSelectQuery testCase{\n      kg, query, 1,\n      // TSV\n      \"?o\\n\"\n      \"1950-01-01T00:00:00\\n\",\n      // should be\n      // \"\\\"1950-01-01T00:00:00\\\"^^<http://www.w3.org/2001/XMLSchema#dateTime>\\n\",\n      // but that is a bug in the TSV export for another PR. Note: the duplicate\n      // quotes are due to the escaping for CSV.\n      \"o\\n\"\n      \"1950-01-01T00:00:00\\n\",\n      makeExpectedQLeverJSON(\n          {\"\\\"1950-01-01T00:00:00\\\"^^<http://www.w3.org/2001/XMLSchema#dateTime>\"s}),\n      makeExpectedSparqlJSON(\n          {makeJSONBinding(\"http://www.w3.org/2001/XMLSchema#dateTime\",\n                           \"literal\", \"1950-01-01T00:00:00\")}),\n      expectedXml};\n  runSelectQueryTestCase(testCase);\n\n  TestCaseConstructQuery testCaseConstruct{\n      kg,\n      \"CONSTRUCT {?s ?p ?o} WHERE {?s ?p ?o} ORDER BY ?o\",\n      1,\n      1,\n      // TSV\n      \"<s>\\t<p>\\t\\\"1950-01-01T00:00:00\\\"^^<http://www.w3.org/2001/\"\n      \"XMLSchema#dateTime>\\n\",  // missing\n                                // \"^^<http://www.w3.org/2001/XMLSchema#dateTime>\\n\",\n      // CSV\n      // TODO<joka921> This format is wrong, but this is is due to the way that\n      // CONSTRUCT queries are currently exported. This has to be fixed in a\n      // different PR.\n      \"<s>,<p>,\\\"\\\"\\\"1950-01-01T00:00:00\\\"\\\"^^<http://www.w3.org/2001/\"\n      \"XMLSchema#dateTime>\\\"\\n\",\n      // Turtle\n      \"<s> <p> \"\n      \"\\\"1950-01-01T00:00:00\\\"^^<http://www.w3.org/2001/XMLSchema#dateTime> \"\n      \".\\n\",\n      []() {\n        nlohmann::json j;\n        j.push_back(std::vector{\n            \"<s>\"s, \"<p>\"s,\n            \"\\\"1950-01-01T00:00:00\\\"^^<http://www.w3.org/2001/XMLSchema#dateTime>\"s});\n        return j;\n      }(),\n  };\n  runConstructQueryTestCase(testCaseConstruct);\n}\n\n// ____________________________________________________________________________\nTEST(ExportQueryExecutionTrees, GeoPoints) {\n  std::string kg =\n      \"<s> <p> \"\n      \"\\\"POINT(50.0 \"\n      \"50.0)\\\"^^<http://www.opengis.net/ont/geosparql#wktLiteral>.\";\n  std::string query = \"SELECT ?o WHERE {?s ?p ?o} ORDER BY ?o\";\n  std::string expectedXml = makeXMLHeader({\"o\"}) +\n                            R\"(\n  <result>\n    <binding name=\"o\"><literal datatype=\"http://www.opengis.net/ont/geosparql#wktLiteral\">POINT(50.000000 50.000000)</literal></binding>\n  </result>)\" + xmlTrailer;\n  TestCaseSelectQuery testCase{\n      kg, query, 1,\n      // TSV\n      \"?o\\n\"\n      \"POINT(50.000000 50.000000)\\n\",\n      // should be\n      // \"\\\"POINT(50.000000 50.000000)\\\"^^<http://www.opengis.net/ont/geosparql#wktLiteral>\\n\",\n      // but that is a bug in the TSV export for another PR. Note: the duplicate\n      // quotes are due to the escaping for CSV.\n      \"o\\n\"\n      \"POINT(50.000000 50.000000)\\n\",\n      makeExpectedQLeverJSON(\n          {\"\\\"POINT(50.000000 50.000000)\\\"^^<http://www.opengis.net/ont/geosparql#wktLiteral>\"s}),\n      makeExpectedSparqlJSON(\n          {makeJSONBinding(\"http://www.opengis.net/ont/geosparql#wktLiteral\",\n                           \"literal\", \"POINT(50.000000 50.000000)\")}),\n      expectedXml};\n  runSelectQueryTestCase(testCase);\n}\n\n// ____________________________________________________________________________\nTEST(ExportQueryExecutionTrees, Entities) {\n  std::string kg = \"PREFIX qlever: <http://qlever.com/> \\n <s> <p> qlever:o\";\n  std::string query = \"SELECT ?o WHERE {?s ?p ?o} ORDER BY ?o\";\n  std::string expectedXml = makeXMLHeader({\"o\"}) +\n                            R\"(\n  <result>\n    <binding name=\"o\"><uri>http://qlever.com/o</uri></binding>\n  </result>)\" + xmlTrailer;\n  TestCaseSelectQuery testCase{\n      kg, query, 1,\n      // TSV\n      \"?o\\n\"\n      \"<http://qlever.com/o>\\n\",\n      // CSV\n      \"o\\n\"\n      \"http://qlever.com/o\\n\",\n      makeExpectedQLeverJSON({\"<http://qlever.com/o>\"s}),\n      makeExpectedSparqlJSON(\n          {makeJSONBinding(std::nullopt, \"uri\", \"http://qlever.com/o\")}),\n      expectedXml};\n  runSelectQueryTestCase(testCase);\n  testCase.kg = \"<s> <x> <y>\";\n  testCase.query =\n      \"PREFIX qlever: <http://qlever.com/> \\n SELECT ?o WHERE {VALUES ?o \"\n      \"{qlever:o}} ORDER BY ?o\";\n  runSelectQueryTestCase(testCase);\n\n  TestCaseConstructQuery testCaseConstruct{\n      kg,\n      \"CONSTRUCT {?s ?p ?o} WHERE {?s ?p ?o} ORDER BY ?o\",\n      1,\n      1,\n      // TSV\n      \"<s>\\t<p>\\t<http://qlever.com/o>\\n\",\n      // CSV\n      \"<s>,<p>,<http://qlever.com/o>\\n\",\n      // Turtle\n      \"<s> <p> <http://qlever.com/o> .\\n\",\n      []() {\n        nlohmann::json j;\n        j.push_back(std::vector{\"<s>\"s, \"<p>\"s, \"<http://qlever.com/o>\"s});\n        return j;\n      }(),\n  };\n  runConstructQueryTestCase(testCaseConstruct);\n}\n\n// ____________________________________________________________________________\nTEST(ExportQueryExecutionTrees, LiteralWithLanguageTag) {\n  std::string kg = R\"(<s> <p> \"Some\\\"Where\tOver,\"@en-ca.)\";\n  std::string query = \"SELECT ?o WHERE {?s ?p ?o} ORDER BY ?o\";\n  std::string expectedXml = makeXMLHeader({\"o\"}) +\n                            R\"(\n  <result>\n    <binding name=\"o\"><literal xml:lang=\"en-ca\">Some&quot;Where)\" +\n                            \"\\t\" + R\"(Over,</literal></binding>\n  </result>)\" + xmlTrailer;\n  TestCaseSelectQuery testCase{\n      kg, query, 1,\n      // TSV\n      \"?o\\n\"\n      \"\\\"Some\\\"Where Over,\\\"@en-ca\\n\",\n      // CSV\n      \"o\\n\"\n      \"\\\"Some\\\"\\\"Where\\tOver,\\\"\\n\",\n      makeExpectedQLeverJSON({\"\\\"Some\\\"Where\\tOver,\\\"@en-ca\"s}),\n      makeExpectedSparqlJSON({makeJSONBinding(std::nullopt, \"literal\",\n                                              \"Some\\\"Where\\tOver,\", \"en-ca\")}),\n      expectedXml};\n  runSelectQueryTestCase(testCase);\n  testCase.kg = \"<s> <x> <y>\";\n  testCase.query =\n      \"SELECT ?o WHERE { VALUES ?o {\\\"\\\"\\\"Some\\\"Where\\tOver,\\\"\\\"\\\"@en-ca}} \"\n      \"ORDER BY ?o\";\n  runSelectQueryTestCase(testCase);\n\n  TestCaseConstructQuery testCaseConstruct{\n      kg,\n      \"CONSTRUCT {?s ?p ?o} WHERE {?s ?p ?o} ORDER BY ?o\",\n      1,\n      1,\n      // TSV\n      \"<s>\\t<p>\\t\\\"Some\\\"Where Over,\\\"@en-ca\\n\",\n      // CSV\n      \"<s>,<p>,\\\"\\\"\\\"Some\\\"\\\"Where\\tOver,\\\"\\\"@en-ca\\\"\\n\",\n      // Turtle\n      \"<s> <p> \\\"Some\\\\\\\"Where\\tOver,\\\"@en-ca .\\n\",\n      []() {\n        nlohmann::json j;\n        j.push_back(\n            std::vector{\"<s>\"s, \"<p>\"s, \"\\\"Some\\\"Where\\tOver,\\\"@en-ca\"s});\n        return j;\n      }(),\n  };\n  runConstructQueryTestCase(testCaseConstruct);\n}\n\n// ____________________________________________________________________________\nTEST(ExportQueryExecutionTrees, LiteralWithDatatype) {\n  std::string kg = \"<s> <p> \\\"something\\\"^^<www.example.org/bim>\";\n  std::string query = \"SELECT ?o WHERE {?s ?p ?o} ORDER BY ?o\";\n  std::string expectedXml = makeXMLHeader({\"o\"}) +\n                            R\"(\n  <result>\n    <binding name=\"o\"><literal datatype=\"www.example.org/bim\">something</literal></binding>\n  </result>)\" + xmlTrailer;\n  TestCaseSelectQuery testCase{\n      kg, query, 1,\n      // TSV\n      \"?o\\n\"\n      \"\\\"something\\\"^^<www.example.org/bim>\\n\",\n      // CSV\n      \"o\\n\"\n      \"something\\n\",\n      makeExpectedQLeverJSON({\"\\\"something\\\"^^<www.example.org/bim>\"s}),\n      makeExpectedSparqlJSON(\n          {makeJSONBinding(\"www.example.org/bim\", \"literal\", \"something\")}),\n      expectedXml};\n  runSelectQueryTestCase(testCase);\n  testCase.kg = \"<s> <x> <y>\";\n  testCase.query =\n      \"SELECT ?o WHERE { VALUES ?o {\\\"something\\\"^^<www.example.org/bim>}} \"\n      \"ORDER BY ?o\";\n  runSelectQueryTestCase(testCase);\n\n  TestCaseConstructQuery testCaseConstruct{\n      kg,\n      \"CONSTRUCT {?s ?p ?o} WHERE {?s ?p ?o} ORDER BY ?o\",\n      1,\n      1,\n      // TSV\n      \"<s>\\t<p>\\t\\\"something\\\"^^<www.example.org/bim>\\n\",\n      // CSV\n      \"<s>,<p>,\\\"\\\"\\\"something\\\"\\\"^^<www.example.org/bim>\\\"\\n\",\n      // Turtle\n      \"<s> <p> \\\"something\\\"^^<www.example.org/bim> .\\n\",\n      []() {\n        nlohmann::json j;\n        j.push_back(std::vector{\"<s>\"s, \"<p>\"s,\n                                \"\\\"something\\\"^^<www.example.org/bim>\"s});\n        return j;\n      }(),\n  };\n  runConstructQueryTestCase(testCaseConstruct);\n}\n\n// ____________________________________________________________________________\nTEST(ExportQueryExecutionTrees, LiteralPlain) {\n  std::string kg = \"<s> <p> \\\"something\\\"\";\n  std::string query = \"SELECT ?o WHERE {?s ?p ?o} ORDER BY ?o\";\n  std::string expectedXml = makeXMLHeader({\"o\"}) +\n                            R\"(\n  <result>\n    <binding name=\"o\"><literal>something</literal></binding>\n  </result>)\" + xmlTrailer;\n  TestCaseSelectQuery testCase{kg, query, 1,\n                               // TSV\n                               \"?o\\n\"\n                               \"\\\"something\\\"\\n\",\n                               // CSV\n                               \"o\\n\"\n                               \"something\\n\",\n                               makeExpectedQLeverJSON({\"\\\"something\\\"\"s}),\n                               makeExpectedSparqlJSON({makeJSONBinding(\n                                   std::nullopt, \"literal\", \"something\")}),\n                               expectedXml};\n  runSelectQueryTestCase(testCase);\n  testCase.kg = \"<s> <x> <y>\";\n  testCase.query =\n      \"SELECT ?o WHERE { VALUES ?o {\\\"something\\\"}} \"\n      \"ORDER BY ?o\";\n  runSelectQueryTestCase(testCase);\n\n  TestCaseConstructQuery testCaseConstruct{\n      kg,\n      \"CONSTRUCT {?s ?p ?o} WHERE {?s ?p ?o} ORDER BY ?o\",\n      1,\n      1,\n      // TSV\n      \"<s>\\t<p>\\t\\\"something\\\"\\n\",\n      // CSV\n      \"<s>,<p>,\\\"\\\"\\\"something\\\"\\\"\\\"\\n\",\n      // Turtle\n      \"<s> <p> \\\"something\\\" .\\n\",\n      []() {\n        nlohmann::json j;\n        j.push_back(std::vector{\"<s>\"s, \"<p>\"s, \"\\\"something\\\"\"s});\n        return j;\n      }(),\n  };\n  runConstructQueryTestCase(testCaseConstruct);\n}\n\n// ____________________________________________________________________________\nTEST(ExportQueryExecutionTrees, TestWithIriEscaped) {\n  std::string kg = \"<s> <p> <https://\\\\u0009:\\\\u0020)\\\\u000AtestIriKg>\";\n  std::string objectQuery = \"SELECT ?o WHERE { ?s ?p ?o }\";\n  std::string expectedXml = makeXMLHeader({\"o\"}) +\n                            R\"(\n  <result>\n    <binding name=\"o\"><uri>https://)\" +\n                            \"\\x09\" + R\"(: )\ntestIriKg</uri></binding>\n  </result>)\" + xmlTrailer;\n\n  TestCaseSelectQuery testCaseTextIndex{\n      kg, objectQuery, 1,\n      // TSV\n      \"?o\\n\"\n      \"<https:// : )\\\\ntestIriKg>\\n\",\n      // CSV\n      \"o\\n\"\n      \"\\\"https://\\t: )\\ntestIriKg\\\"\\n\",\n      makeExpectedQLeverJSON({\"<https://\\t: )\\ntestIriKg>\"s}),\n      makeExpectedSparqlJSON(\n          {makeJSONBinding(std::nullopt, \"uri\", \"https://\\t: )\\ntestIriKg\")}),\n      expectedXml};\n  runSelectQueryTestCase(testCaseTextIndex);\n\n  TestCaseConstructQuery testCaseConstruct{\n      kg,\n      \"CONSTRUCT {?s ?p ?o} WHERE {?s ?p ?o} ORDER BY ?o\",\n      1,\n      1,\n      // TSV\n      \"<s>\\t<p>\\t<https:// : )\\\\ntestIriKg>\\n\",\n      // CSV\n      \"<s>,<p>,\\\"<https://\\t: )\\ntestIriKg>\\\"\\n\",\n      // Turtle\n      \"<s> <p> <https://\\t: )\\ntestIriKg> .\\n\",\n      []() {\n        nlohmann::json j;\n        j.push_back(std::vector{\"<s>\"s, \"<p>\"s, \"<https://\\t: )\\ntestIriKg>\"s});\n        return j;\n      }(),\n  };\n  runConstructQueryTestCase(testCaseConstruct);\n}\n\n// ____________________________________________________________________________\nTEST(ExportQueryExecutionTrees, TestWithIriExtendedEscaped) {\n  std::string kg =\n      \"<s> <p>\"\n      \"<iriescaped\\\\u0001o\\\\u0002e\\\\u0003i\\\\u0004o\\\\u0005u\\\\u0006e\\\\u00\"\n      \"07g\\\\u0008c\\\\u0009u\\\\u000Ae\\\\u000Be\\\\u000Ca\\\\u000Dd\\\\u000En\\\\u000F?\"\n      \"\\\\u0010u\\\\u0011u\\\\u0012u\\\\u0013###\\\\u0020d>\";\n  std::string objectQuery = \"SELECT ?o WHERE { ?s ?p ?o }\";\n  std::string expectedXml =\n      makeXMLHeader({\"o\"}) +\n      R\"(\n  <result>\n    <binding name=\"o\"><uri>)\" +\n      \"iriescaped\\x01o\\x02\"\n      \"e\\x03i\\x04o\\x05u\\x06\"\n      \"e\\ag\\bc\\tu\\ne\\ve\\fa\\rd\\x0En\\x0F?\\x10u\\x11u\\x12u\\x13### d\" +\n      R\"(</uri></binding>\n  </result>)\" +\n      xmlTrailer;\n\n  TestCaseSelectQuery testCaseTextIndex{\n      kg, objectQuery, 1,\n      // TSV\n      \"?o\\n\"\n      \"<iriescaped\\x01o\\x02\"\n      \"e\\x03i\\x04o\\x05u\\x06\"\n      \"e\\ag\\bc u\\\\ne\\ve\\fa\\rd\\x0En\\x0F?\\x10u\\x11u\\x12u\\x13### d>\\n\",\n      // CSV\n      \"o\\n\"\n      \"\\\"iriescaped\\x01o\\x02\"\n      \"e\\x03i\\x04o\\x05u\\x06\"\n      \"e\\ag\\bc\\tu\\ne\\ve\\fa\\rd\\x0En\\x0F?\\x10u\\x11u\\x12u\\x13### d\\\"\\n\",\n      makeExpectedQLeverJSON(\n          {\"<iriescaped\\u0001o\\u0002e\\u0003i\\u0004o\\u0005u\\u0006e\\u0007\"\n           \"g\\u0008c\\u0009u\\u000Ae\\u000Be\\u000Ca\\u000Dd\\u000En\\u000F?\"\n           \"\\u0010u\\u0011u\\u0012u\\u0013### d>\"s}),\n      makeExpectedSparqlJSON({makeJSONBinding(\n          std::nullopt, \"uri\",\n          \"iriescaped\\u0001o\\u0002e\\u0003i\\u0004o\\u0005u\\u0006e\"\n          \"\\u0007\"\n          \"g\\u0008c\\u0009u\\u000Ae\\u000Be\\u000Ca\\u000Dd\\u000En\\u000F?\"\n          \"\\u0010u\\u0011u\\u0012u\\u0013### d\")}),\n      expectedXml};\n  runSelectQueryTestCase(testCaseTextIndex);\n\n  TestCaseConstructQuery testCaseConstruct{\n      kg,\n      \"CONSTRUCT {?s ?p ?o} WHERE {?s ?p ?o} ORDER BY ?o\",\n      1,\n      1,\n      // TSV\n      \"<s>\\t<p>\\t<iriescaped\\x01o\\x02\"\n      \"e\\x03i\\x04o\\x05u\\x06\"\n      \"e\\ag\\bc u\\\\ne\\ve\\fa\\rd\\x0En\\x0F?\\x10u\\x11u\\x12u\\x13### d>\\n\",\n      // CSV\n      \"<s>,<p>,\\\"<iriescaped\\x01o\\x02\"\n      \"e\\x03i\\x04o\\x05u\\x06\"\n      \"e\\ag\\bc\\tu\\ne\\ve\\fa\\rd\\x0En\\x0F?\\x10u\\x11u\\x12u\\x13### d>\\\"\\n\",\n      // Turtle\n      \"<s> <p> <iriescaped\\x01o\\x02\"\n      \"e\\x03i\\x04o\\x05u\\x06\"\n      \"e\\ag\\bc\\tu\\ne\\ve\\fa\\rd\\x0En\\x0F?\\x10u\\x11u\\x12u\\x13### d> .\\n\",\n      []() {\n        nlohmann::json j;\n        j.push_back(std::vector{\n            \"<s>\"s, \"<p>\"s,\n            \"<iriescaped\\x01o\\x02\"\n            \"e\\x03i\\x04o\\x05u\\x06\"\n            \"e\\ag\\bc\\tu\\ne\\ve\\fa\\rd\\x0En\\x0F?\\x10u\\x11u\\x12u\\x13### d>\"s});\n        return j;\n      }(),\n  };\n}\n\n// ____________________________________________________________________________\nTEST(ExportQueryExecutionTrees, TestIriWithEscapedIriString) {\n  std::string kg = \"<s> <p> \\\" hallo\\\\n\\\\t welt\\\"\";\n  std::string objectQuery =\n      \"SELECT ?o WHERE { \"\n      \"BIND(IRI(\\\" hallo\\\\n\\\\t welt\\\") AS ?o) }\";\n  std::string expectedXml = makeXMLHeader({\"o\"}) +\n                            R\"(\n  <result>\n    <binding name=\"o\"><uri> hallo\n)\" + \"\\t\" + R\"( welt</uri></binding>\n  </result>)\" + xmlTrailer;\n  TestCaseSelectQuery testCaseTextIndex{\n      kg, objectQuery, 1,\n      // TSV\n      \"?o\\n\"\n      \"< hallo\\\\n  welt>\\n\",\n      // CSV\n      \"o\\n\"\n      \"\\\" hallo\\n\\t welt\\\"\\n\",\n      makeExpectedQLeverJSON({\"< hallo\\n\\t welt>\"s}),\n      makeExpectedSparqlJSON(\n          {makeJSONBinding(std::nullopt, \"uri\", \" hallo\\n\\t welt\")}),\n      expectedXml};\n  runSelectQueryTestCase(testCaseTextIndex);\n\n  TestCaseConstructQuery testCaseConstruct{\n      kg,\n      \"CONSTRUCT {?s ?p ?o} WHERE {?s ?p ?o} ORDER BY ?o\",\n      1,\n      1,\n      // TSV\n      \"<s>\\t<p>\\t\\\" hallo\\\\n  welt\\\"\\n\",\n      // CSV\n      \"<s>,<p>,\\\"\\\"\\\" hallo\\n\\t welt\\\"\\\"\\\"\\n\",\n      // Turtle\n      \"<s> <p> \\\" hallo\\\\n\\t welt\\\" .\\n\",\n      []() {\n        nlohmann::json j;\n        j.push_back(std::vector{\"<s>\"s, \"<p>\"s, \"\\\" hallo\\n\\t welt\\\"\"s});\n        return j;\n      }(),\n  };\n  runConstructQueryTestCase(testCaseConstruct);\n}\n\n// ____________________________________________________________________________\nTEST(ExportQueryExecutionTrees, UndefinedValues) {\n  std::string kg = \"<s> <p> <o>\";\n  std::string query =\n      \"SELECT ?o WHERE {?s <p> <o> OPTIONAL {?s <p2> ?o}} ORDER BY ?o\";\n  std::string expectedXml = makeXMLHeader({\"o\"}) +\n                            R\"(\n  <result>\n  </result>)\" + xmlTrailer;\n  TestCaseSelectQuery testCase{\n      kg,\n      query,\n      1,\n      \"?o\\n\\n\",\n      \"o\\n\\n\",\n      nlohmann::json{std::vector{std::vector{nullptr}}},\n      []() {\n        nlohmann::json j;\n        j[\"head\"][\"vars\"].push_back(\"o\");\n        j[\"results\"][\"bindings\"].push_back(nlohmann::json::object());\n        return j;\n      }(),\n      expectedXml};\n  runSelectQueryTestCase(testCase);\n\n  // The `1` is the number of results including triples with UNDEF values. The\n  // `0` is the number of results excluding such triples.\n  TestCaseConstructQuery testCaseConstruct{\n      kg,\n      \"CONSTRUCT {?s <pred> ?o} WHERE {?s <p> <o> OPTIONAL {?s <p2> ?o}} ORDER \"\n      \"BY ?o\",\n      1,\n      0,\n      \"\",\n      \"\",\n      \"\",\n      std::vector<std::string>{}};\n  runConstructQueryTestCase(testCaseConstruct);\n}\n\n// ____________________________________________________________________________\nTEST(ExportQueryExecutionTrees, EmptyLines) {\n  std::string kg = \"<s> <p> <o>\";\n  std::string query = \"SELECT * WHERE { <s> <p> <o> }\";\n  std::string expectedXml = makeXMLHeader({}) +\n                            R\"(\n  <result>\n  </result>)\" + xmlTrailer;\n  TestCaseSelectQuery testCase{kg,\n                               query,\n                               1,\n                               \"\\n\\n\",\n                               \"\\n\\n\",\n                               nlohmann::json{std::vector{std::vector<int>{}}},\n                               []() {\n                                 nlohmann::json j;\n                                 j[\"head\"][\"vars\"] = nlohmann::json::array();\n                                 j[\"results\"][\"bindings\"].push_back({});\n                                 return j;\n                               }(),\n                               expectedXml};\n  runSelectQueryTestCase(testCase);\n}\n\n// ____________________________________________________________________________\nTEST(ExportQueryExecutionTrees, BlankNode) {\n  std::string kg = \"<s> <p> _:blank\";\n  std::string objectQuery = \"SELECT ?o WHERE { ?s ?p ?o } ORDER BY ?o\";\n  std::string expectedXml = makeXMLHeader({\"o\"}) +\n                            R\"(\n  <result>\n    <binding name=\"o\"><bnode>bn0</bnode></binding>\n  </result>)\" + xmlTrailer;\n  TestCaseSelectQuery testCaseBlankNode{\n      kg, objectQuery, 1,\n      // TSV\n      \"?o\\n\"\n      \"_:bn0\\n\",\n      // CSV\n      \"o\\n\"\n      \"_:bn0\\n\",\n      makeExpectedQLeverJSON({\"_:bn0\"s}),\n      makeExpectedSparqlJSON({makeJSONBinding(std::nullopt, \"bnode\", \"bn0\")}),\n      expectedXml};\n  runSelectQueryTestCase(testCaseBlankNode);\n  // Note: Blank nodes cannot be introduced in a `VALUES` clause, so they can\n  // never be part of the local vocabulary. For this reason we don't need a\n  // `VALUES` clause in the test query like in the test cases above.\n  kg = \"<s> <p> <o>\";\n  objectQuery =\n      \"SELECT (BNODE(\\\"1\\\") AS ?a) (BNODE(?x) AS ?b) WHERE { VALUES (?x) { (1) \"\n      \"(2) } }\";\n  expectedXml = makeXMLHeader({\"a\", \"b\"}) +\n                R\"(\n  <result>\n    <binding name=\"a\"><bnode>un1_0</bnode></binding>\n    <binding name=\"b\"><bnode>un1_0</bnode></binding>\n  </result>\n  <result>\n    <binding name=\"a\"><bnode>un1_1</bnode></binding>\n    <binding name=\"b\"><bnode>un2_1</bnode></binding>\n  </result>)\" + xmlTrailer;\n  testCaseBlankNode = TestCaseSelectQuery{\n      kg, objectQuery, 2,\n      // TSV\n      \"?a\\t?b\\n\"\n      \"_:un1_0\\t_:un1_0\\n\"\n      \"_:un1_1\\t_:un2_1\\n\",\n      // CSV\n      \"a,b\\n\"\n      \"_:un1_0,_:un1_0\\n\"\n      \"_:un1_1,_:un2_1\\n\",\n      []() {\n        nlohmann::json j;\n        j.push_back(std::vector{\"_:un1_0\"s, \"_:un1_0\"s});\n        j.push_back(std::vector{\"_:un1_1\"s, \"_:un2_1\"s});\n        return j;\n      }(),\n      []() {\n        nlohmann::json j;\n        j[\"head\"][\"vars\"].push_back(\"a\");\n        j[\"head\"][\"vars\"].push_back(\"b\");\n        auto& bindings = j[\"results\"][\"bindings\"];\n        bindings.emplace_back();\n        bindings.back()[\"a\"] = makeJSONBinding(std::nullopt, \"bnode\", \"un1_0\");\n        bindings.back()[\"b\"] = makeJSONBinding(std::nullopt, \"bnode\", \"un1_0\");\n        bindings.emplace_back();\n        bindings.back()[\"a\"] = makeJSONBinding(std::nullopt, \"bnode\", \"un1_1\");\n        bindings.back()[\"b\"] = makeJSONBinding(std::nullopt, \"bnode\", \"un2_1\");\n        return j;\n      }(),\n      expectedXml};\n  runSelectQueryTestCase(testCaseBlankNode);\n\n  TestCaseConstructQuery testCaseConstruct{\n      \"<a> <b> <c> . <d> <e> <f> . <g> <h> <i> . <j> <k> <l>\",\n      \"CONSTRUCT { [] <p> _:a . [] <p> _:a } WHERE { ?s ?p ?o }\", 8, 8,\n      // TSV\n      \"_:g0_0\\t<p>\\t_:u0_a\\n\"\n      \"_:g0_1\\t<p>\\t_:u0_a\\n\"\n      \"_:g1_0\\t<p>\\t_:u1_a\\n\"\n      \"_:g1_1\\t<p>\\t_:u1_a\\n\"\n      \"_:g2_0\\t<p>\\t_:u2_a\\n\"\n      \"_:g2_1\\t<p>\\t_:u2_a\\n\"\n      \"_:g3_0\\t<p>\\t_:u3_a\\n\"\n      \"_:g3_1\\t<p>\\t_:u3_a\\n\",\n      // CSV\n      \"_:g0_0,<p>,_:u0_a\\n\"\n      \"_:g0_1,<p>,_:u0_a\\n\"\n      \"_:g1_0,<p>,_:u1_a\\n\"\n      \"_:g1_1,<p>,_:u1_a\\n\"\n      \"_:g2_0,<p>,_:u2_a\\n\"\n      \"_:g2_1,<p>,_:u2_a\\n\"\n      \"_:g3_0,<p>,_:u3_a\\n\"\n      \"_:g3_1,<p>,_:u3_a\\n\",\n      // Turtle\n      \"_:g0_0 <p> _:u0_a .\\n\"\n      \"_:g0_1 <p> _:u0_a .\\n\"\n      \"_:g1_0 <p> _:u1_a .\\n\"\n      \"_:g1_1 <p> _:u1_a .\\n\"\n      \"_:g2_0 <p> _:u2_a .\\n\"\n      \"_:g2_1 <p> _:u2_a .\\n\"\n      \"_:g3_0 <p> _:u3_a .\\n\"\n      \"_:g3_1 <p> _:u3_a .\\n\",\n      []() {\n        nlohmann::json j;\n        j.push_back(std::vector{\"_:g0_0\"s, \"<p>\"s, \"_:u0_a\"s});\n        j.push_back(std::vector{\"_:g0_1\"s, \"<p>\"s, \"_:u0_a\"s});\n        j.push_back(std::vector{\"_:g1_0\"s, \"<p>\"s, \"_:u1_a\"s});\n        j.push_back(std::vector{\"_:g1_1\"s, \"<p>\"s, \"_:u1_a\"s});\n        j.push_back(std::vector{\"_:g2_0\"s, \"<p>\"s, \"_:u2_a\"s});\n        j.push_back(std::vector{\"_:g2_1\"s, \"<p>\"s, \"_:u2_a\"s});\n        j.push_back(std::vector{\"_:g3_0\"s, \"<p>\"s, \"_:u3_a\"s});\n        j.push_back(std::vector{\"_:g3_1\"s, \"<p>\"s, \"_:u3_a\"s});\n        return j;\n      }(),\n      2};\n  runConstructQueryTestCase(testCaseConstruct);\n}\n\n// ____________________________________________________________________________\nTEST(ExportQueryExecutionTrees, TextIndex) {\n  std::string kg = \"<s> <p> \\\"alpha beta\\\". <s2> <p2> \\\"alphax betax\\\". \";\n  std::string objectQuery =\n      \"SELECT ?o WHERE {<s> <p> ?t. ?text ql:contains-entity ?t .?text \"\n      \"ql:contains-word \\\"alph*\\\" BIND (?ql_matchingword_text_alph AS ?o)}\";\n\n  std::string expectedXml = makeXMLHeader({\"o\"}) +\n                            R\"(\n  <result>\n    <binding name=\"o\"><literal>alpha</literal></binding>\n  </result>)\" + xmlTrailer;\n  TestCaseSelectQuery testCaseTextIndex{kg, objectQuery, 1,\n                                        // TSV\n                                        \"?o\\n\"\n                                        \"alpha\\n\",\n                                        // CSV\n                                        \"o\\n\"\n                                        \"alpha\\n\",\n                                        makeExpectedQLeverJSON({\"alpha\"s}),\n                                        makeExpectedSparqlJSON({makeJSONBinding(\n                                            std::nullopt, \"literal\", \"alpha\")}),\n                                        expectedXml};\n  runSelectQueryTestCase(testCaseTextIndex, true);\n}\n\n// ____________________________________________________________________________\nTEST(ExportQueryExecutionTrees, MultipleVariables) {\n  std::string kg = \"<s> <p> <o>\";\n  std::string objectQuery = \"SELECT ?p ?o WHERE {<s> ?p ?o } ORDER BY ?p ?o\";\n  std::string expectedXml = makeXMLHeader({\"p\", \"o\"}) +\n                            R\"(\n  <result>\n    <binding name=\"p\"><uri>p</uri></binding>\n    <binding name=\"o\"><uri>o</uri></binding>\n  </result>)\" + xmlTrailer;\n  TestCaseSelectQuery testCaseMultipleVariables{\n      kg, objectQuery, 1,\n      // TSV\n      \"?p\\t?o\\n\"\n      \"<p>\\t<o>\\n\",\n      // CSV\n      \"p,o\\n\"\n      \"p,o\\n\",\n      []() {\n        nlohmann::json j;\n        j.push_back(std::vector{\"<p>\"s, \"<o>\"s});\n        return j;\n      }(),\n      []() {\n        nlohmann::json j;\n        j[\"head\"][\"vars\"].push_back(\"p\");\n        j[\"head\"][\"vars\"].push_back(\"o\");\n        auto& bindings = j[\"results\"][\"bindings\"];\n        bindings.emplace_back();\n        bindings.back()[\"p\"] = makeJSONBinding(std::nullopt, \"uri\", \"p\");\n        bindings.back()[\"o\"] = makeJSONBinding(std::nullopt, \"uri\", \"o\");\n        return j;\n      }(),\n      expectedXml};\n  runSelectQueryTestCase(testCaseMultipleVariables);\n}\n\n// ____________________________________________________________________________\nTEST(ExportQueryExecutionTrees, LimitOffset) {\n  std::string kg = \"<a> <b> <c> . <d> <e> <f> . <g> <h> <i> . <j> <k> <l>\";\n  std::string expectedXml = makeXMLHeader({\"s\"}) +\n                            R\"(\n  <result>\n    <binding name=\"s\"><uri>d</uri></binding>\n  </result>\n  <result>\n    <binding name=\"s\"><uri>g</uri></binding>\n  </result>)\" + xmlTrailer;\n  // The `OrderBy` operation does not handle the limit.\n  std::string_view objectQuery0 =\n      \"SELECT ?s WHERE { ?s ?p ?o } ORDER BY ?s LIMIT 2 OFFSET 1\";\n  // The `IndexScan` operation handles the limit.\n  std::string_view objectQuery1 =\n      \"SELECT ?s WHERE { ?s ?p ?o } INTERNAL SORT BY ?s LIMIT 2 OFFSET 1\";\n  for (auto objectQuery : {objectQuery0, objectQuery1}) {\n    TestCaseSelectQuery testCaseLimitOffset{\n        kg, std::string{objectQuery}, 2,\n        // TSV\n        \"?s\\n\"\n        \"<d>\\n\"\n        \"<g>\\n\",\n        // CSV\n        \"s\\n\"\n        \"d\\n\"\n        \"g\\n\",\n        []() {\n          nlohmann::json j;\n          j.push_back(std::vector{\n              \"<d>\"s,\n          });\n          j.push_back(std::vector{\n              \"<g>\"s,\n          });\n          return j;\n        }(),\n        []() {\n          nlohmann::json j;\n          j[\"head\"][\"vars\"].push_back(\"s\");\n          auto& bindings = j[\"results\"][\"bindings\"];\n          bindings.emplace_back();\n          bindings.back()[\"s\"] = makeJSONBinding(std::nullopt, \"uri\", \"d\");\n          bindings.emplace_back();\n          bindings.back()[\"s\"] = makeJSONBinding(std::nullopt, \"uri\", \"g\");\n          return j;\n        }(),\n        expectedXml};\n    runSelectQueryTestCase(testCaseLimitOffset);\n  }\n}\n\n// ____________________________________________________________________________\nTEST(ExportQueryExecutionTrees, BinaryExport) {\n  std::string kg = \"<s> <p> 31 . <s> <o> 42\";\n  std::string query = \"SELECT ?p ?o WHERE {<s> ?p ?o } ORDER BY ?p ?o\";\n  std::string result =\n      runQueryStreamableResult(kg, query, ad_utility::MediaType::octetStream);\n  ASSERT_EQ(4 * sizeof(Id), result.size());\n  auto qec = ad_utility::testing::getQec(kg);\n  auto getId = ad_utility::testing::makeGetId(qec->getIndex());\n  auto p = getId(\"<p>\");\n  auto o = getId(\"<o>\");\n\n  Id id0, id1, id2, id3;\n  std::memcpy(&id0, result.data(), sizeof(Id));\n  std::memcpy(&id1, result.data() + sizeof(Id), sizeof(Id));\n  std::memcpy(&id2, result.data() + 2 * sizeof(Id), sizeof(Id));\n  std::memcpy(&id3, result.data() + 3 * sizeof(Id), sizeof(Id));\n\n  // The result is \"p, 31\" (first row) \"o, 42\" (second row)\n  ASSERT_EQ(o, id0);\n  ASSERT_EQ(ad_utility::testing::IntId(42), id1);\n  ASSERT_EQ(p, id2);\n  ASSERT_EQ(ad_utility::testing::IntId(31), id3);\n}\n\n// ____________________________________________________________________________\nTEST(ExportQueryExecutionTrees, CornerCases) {\n  std::string kg = \"<s> <p> <o>\";\n  std::string query = \"SELECT ?p ?o WHERE {<s> ?p ?o } ORDER BY ?p ?o\";\n  std::string constructQuery =\n      \"CONSTRUCT {?s ?p ?o} WHERE {?s ?p ?o } ORDER BY ?p ?o\";\n\n  // Turtle is not supported for SELECT queries.\n  ASSERT_THROW(\n      runQueryStreamableResult(kg, query, ad_utility::MediaType::turtle),\n      ad_utility::Exception);\n  // SPARQL JSON is not supported for construct queries.\n  ASSERT_THROW(\n      runJSONQuery(kg, constructQuery, ad_utility::MediaType::sparqlJson),\n      ad_utility::Exception);\n  // XML is currently not supported for construct queries.\n  AD_EXPECT_THROW_WITH_MESSAGE(\n      runQueryStreamableResult(kg, constructQuery,\n                               ad_utility::MediaType::sparqlXml),\n      ::testing::ContainsRegex(\n          \"XML export is currently not supported for CONSTRUCT\"));\n\n  // Binary export is not supported for CONSTRUCT queries.\n  ASSERT_THROW(runQueryStreamableResult(kg, constructQuery,\n                                        ad_utility::MediaType::octetStream),\n               ad_utility::Exception);\n\n  // If none of the selected variables is defined in the query body, we have an\n  // empty solution mapping per row, but there is no need to materialize any\n  // IRIs or literals.\n  std::string queryNoVariablesVisible = \"SELECT ?not ?known WHERE {<s> ?p ?o}\";\n  auto resultNoColumns = runJSONQuery(kg, queryNoVariablesVisible,\n                                      ad_utility::MediaType::sparqlJson);\n  ASSERT_EQ(resultNoColumns[\"results\"][\"bindings\"].size(), 1);\n  EXPECT_TRUE(resultNoColumns[\"results\"][\"bindings\"][0].is_object());\n  EXPECT_TRUE(resultNoColumns[\"results\"][\"bindings\"][0].empty());\n  auto qec = ad_utility::testing::getQec(kg);\n  AD_EXPECT_THROW_WITH_MESSAGE(\n      ql::exportIds::idToStringAndType(qec->getIndex(), Id::max(),\n                                       LocalVocab{}),\n      ::testing::ContainsRegex(\"should be unreachable\"));\n  AD_EXPECT_THROW_WITH_MESSAGE(\n      ql::exportIds::getLiteralOrIriFromVocabIndex(qec->getIndex(), Id::max(),\n                                                   LocalVocab{}),\n      ::testing::ContainsRegex(\"should be unreachable\"));\n  AD_EXPECT_THROW_WITH_MESSAGE(\n      ql::exportIds::idToStringAndTypeForEncodedValue(\n          ad_utility::testing::VocabId(12)),\n      ::testing::ContainsRegex(\"should be unreachable\"));\n}\n\n// _____________________________________________________________________________\n// Test the correct exporting of ASK queries.\nTEST(ExportQueryExecutionTrees, AskQuery) {\n  auto askResultTrue = [](bool lazy) {\n    TestCaseAskQuery testCase;\n    if (lazy) {\n      testCase.kg = \"<x> <y> <z>\";\n      testCase.query = \"ASK { <x> ?p ?o}\";\n    } else {\n      testCase.query = \"ASK { BIND (3 as ?x) FILTER (?x > 0)}\";\n    }\n    testCase.resultQLeverJSON = nlohmann::json{std::vector<std::string>{\n        \"\\\"true\\\"^^<http://www.w3.org/2001/XMLSchema#boolean>\"}};\n    testCase.resultSparqlJSON =\n        nlohmann::json::parse(R\"({\"head\":{ }, \"boolean\" : true})\");\n    testCase.resultXml =\n        \"<?xml version=\\\"1.0\\\"?>\\n<sparql \"\n        \"xmlns=\\\"http://www.w3.org/2005/sparql-results#\\\">\\n  <head/>\\n  \"\n        \"<boolean>true</boolean>\\n</sparql>\";\n\n    return testCase;\n  };\n\n  auto askResultFalse = [](bool lazy) {\n    TestCaseAskQuery testCase;\n    if (lazy) {\n      testCase.kg = \"<x> <y> <z>\";\n      testCase.query = \"ASK { <y> ?p ?o}\";\n    } else {\n      testCase.query = \"ASK { BIND (3 as ?x) FILTER (?x < 0)}\";\n    }\n    testCase.resultQLeverJSON = nlohmann::json{std::vector<std::string>{\n        \"\\\"false\\\"^^<http://www.w3.org/2001/XMLSchema#boolean>\"}};\n    testCase.resultSparqlJSON =\n        nlohmann::json::parse(R\"({\"head\":{ }, \"boolean\" : false})\");\n    testCase.resultXml =\n        \"<?xml version=\\\"1.0\\\"?>\\n<sparql \"\n        \"xmlns=\\\"http://www.w3.org/2005/sparql-results#\\\">\\n  <head/>\\n  \"\n        \"<boolean>false</boolean>\\n</sparql>\";\n    return testCase;\n  };\n  runAskQueryTestCase(askResultTrue(true));\n  runAskQueryTestCase(askResultTrue(false));\n  runAskQueryTestCase(askResultFalse(true));\n  runAskQueryTestCase(askResultFalse(false));\n}\n\nusing enum ad_utility::MediaType;\n\n// ____________________________________________________________________________\nclass StreamableMediaTypesFixture\n    : public ::testing::Test,\n      public ::testing::WithParamInterface<ad_utility::MediaType> {};\n\nTEST_P(StreamableMediaTypesFixture, CancellationCancelsStream) {\n  auto cancellationHandle =\n      std::make_shared<ad_utility::CancellationHandle<>>();\n\n  auto* qec = ad_utility::testing::getQec(\n      \"<s> <p> 42 . <s> <p> -42019234865781 . <s> <p> 4012934858173560\");\n  QueryPlanner qp{qec, cancellationHandle};\n  auto pq = parseQuery(GetParam() == turtle\n                           ? \"CONSTRUCT { ?x ?y ?z } WHERE { ?x ?y ?z }\"\n                           : \"SELECT * WHERE { ?x ?y ?z }\");\n  auto qet = qp.createExecutionTree(pq);\n\n  cancellationHandle->cancel(ad_utility::CancellationState::MANUAL);\n  ad_utility::Timer timer(ad_utility::Timer::Started);\n  EXPECT_ANY_THROW(([&]() {\n    [[maybe_unused]] auto generator = ExportQueryExecutionTrees::computeResult(\n        pq, qet, GetParam(), timer, std::move(cancellationHandle));\n  }()));\n}\n\nINSTANTIATE_TEST_SUITE_P(StreamableMediaTypes, StreamableMediaTypesFixture,\n                         ::testing::Values(turtle, sparqlXml, tsv, csv,\n                                           octetStream, sparqlJson,\n                                           qleverJson));\n\n// TODO<joka921> Unit tests for the more complex CONSTRUCT export (combination\n// between constants and stuff from the knowledge graph).\n\n// TODO<joka921> Unit tests that also test for the export of text records from\n// the text index and thus systematically fill the coverage gaps.\n\n// _____________________________________________________________________________\nTEST(ExportQueryExecutionTrees, getIdTablesReturnsSingletonIterator) {\n  auto idTable = makeIdTableFromVector({{42}, {1337}});\n\n  Result result{idTable.clone(), {}, LocalVocab{}};\n  auto generator = ExportQueryExecutionTrees::getIdTables(result);\n\n  EXPECT_THAT(convertToVector(std::move(generator)), matchesIdTables(idTable));\n}\n\n// _____________________________________________________________________________\nTEST(ExportQueryExecutionTrees, getIdTablesMirrorsGenerator) {\n  IdTable idTable1 = makeIdTableFromVector({{1}, {2}, {3}});\n  IdTable idTable2 = makeIdTableFromVector({{42}, {1337}});\n  auto tableGenerator = [](IdTable idTableA,\n                           IdTable idTableB) -> Result::Generator {\n    co_yield {std::move(idTableA), LocalVocab{}};\n\n    co_yield {std::move(idTableB), LocalVocab{}};\n  }(idTable1.clone(), idTable2.clone());\n\n  Result result{std::move(tableGenerator), {}};\n  auto generator = ExportQueryExecutionTrees::getIdTables(result);\n\n  EXPECT_THAT(convertToVector(std::move(generator)),\n              matchesIdTables(idTable1, idTable2));\n}\n\n// _____________________________________________________________________________\nTEST(ExportQueryExecutionTrees, ensureCorrectSlicingOfSingleIdTable) {\n  auto tableGenerator = []() -> Result::Generator {\n    Result::IdTableVocabPair pair1{makeIdTableFromVector({{1}, {2}, {3}}),\n                                   LocalVocab{}};\n    co_yield pair1;\n  }();\n\n  Result result{std::move(tableGenerator), {}};\n  uint64_t resultSizeTotal = 0;\n  auto generator = ExportQueryExecutionTrees::getRowIndices(\n      LimitOffsetClause{._limit = 1, ._offset = 1}, result, resultSizeTotal);\n\n  auto expectedResult = makeIdTableFromVector({{2}});\n  EXPECT_THAT(convertToVector(std::move(generator)),\n              matchesIdTables(expectedResult));\n  EXPECT_EQ(resultSizeTotal, 1);\n}\n\n// _____________________________________________________________________________\nTEST(ExportQueryExecutionTrees,\n     ensureCorrectSlicingOfIdTablesWhenFirstIsSkipped) {\n  auto tableGenerator = []() -> Result::Generator {\n    Result::IdTableVocabPair pair1{makeIdTableFromVector({{1}, {2}, {3}}),\n                                   LocalVocab{}};\n    co_yield pair1;\n\n    Result::IdTableVocabPair pair2{makeIdTableFromVector({{4}, {5}}),\n                                   LocalVocab{}};\n    co_yield pair2;\n  }();\n\n  Result result{std::move(tableGenerator), {}};\n  uint64_t resultSizeTotal = 0;\n  auto generator = ExportQueryExecutionTrees::getRowIndices(\n      LimitOffsetClause{._limit = std::nullopt, ._offset = 3}, result,\n      resultSizeTotal);\n\n  auto expectedResult = makeIdTableFromVector({{4}, {5}});\n\n  EXPECT_THAT(convertToVector(std::move(generator)),\n              matchesIdTables(expectedResult));\n  EXPECT_EQ(resultSizeTotal, 2);\n}\n\n// _____________________________________________________________________________\nTEST(ExportQueryExecutionTrees,\n     ensureCorrectSlicingOfIdTablesWhenLastIsSkipped) {\n  auto tableGenerator = []() -> Result::Generator {\n    Result::IdTableVocabPair pair1{makeIdTableFromVector({{1}, {2}, {3}}),\n                                   LocalVocab{}};\n    co_yield pair1;\n\n    Result::IdTableVocabPair pair2{makeIdTableFromVector({{4}, {5}}),\n                                   LocalVocab{}};\n    co_yield pair2;\n  }();\n\n  Result result{std::move(tableGenerator), {}};\n  uint64_t resultSizeTotal = 0;\n  auto generator = ExportQueryExecutionTrees::getRowIndices(\n      LimitOffsetClause{._limit = 3}, result, resultSizeTotal);\n\n  auto expectedResult = makeIdTableFromVector({{1}, {2}, {3}});\n\n  EXPECT_THAT(convertToVector(std::move(generator)),\n              matchesIdTables(expectedResult));\n  EXPECT_EQ(resultSizeTotal, 3);\n}\n\n// _____________________________________________________________________________\nTEST(ExportQueryExecutionTrees,\n     ensureCorrectSlicingOfIdTablesWhenFirstAndSecondArePartial) {\n  auto tableGenerator = []() -> Result::Generator {\n    Result::IdTableVocabPair pair1{makeIdTableFromVector({{1}, {2}, {3}}),\n                                   LocalVocab{}};\n    co_yield pair1;\n\n    Result::IdTableVocabPair pair2{makeIdTableFromVector({{4}, {5}}),\n                                   LocalVocab{}};\n    co_yield pair2;\n  }();\n\n  Result result{std::move(tableGenerator), {}};\n  uint64_t resultSizeTotal = 0;\n  auto generator = ExportQueryExecutionTrees::getRowIndices(\n      LimitOffsetClause{._limit = 3, ._offset = 1}, result, resultSizeTotal);\n\n  auto expectedResult1 = makeIdTableFromVector({{2}, {3}});\n  auto expectedResult2 = makeIdTableFromVector({{4}});\n\n  EXPECT_THAT(convertToVector(std::move(generator)),\n              matchesIdTables(expectedResult1, expectedResult2));\n  EXPECT_EQ(resultSizeTotal, 3);\n}\n\n// _____________________________________________________________________________\nTEST(ExportQueryExecutionTrees,\n     ensureCorrectSlicingOfIdTablesWhenFirstAndLastArePartial) {\n  auto tableGenerator = []() -> Result::Generator {\n    Result::IdTableVocabPair pair1{makeIdTableFromVector({{1}, {2}, {3}}),\n                                   LocalVocab{}};\n    co_yield pair1;\n\n    Result::IdTableVocabPair pair2{makeIdTableFromVector({{4}, {5}}),\n                                   LocalVocab{}};\n    co_yield pair2;\n\n    Result::IdTableVocabPair pair3{makeIdTableFromVector({{6}, {7}, {8}, {9}}),\n                                   LocalVocab{}};\n    co_yield pair3;\n  }();\n\n  Result result{std::move(tableGenerator), {}};\n  uint64_t resultSizeTotal = 0;\n  auto generator = ExportQueryExecutionTrees::getRowIndices(\n      LimitOffsetClause{._limit = 5, ._offset = 2}, result, resultSizeTotal);\n\n  auto expectedTable1 = makeIdTableFromVector({{3}});\n  auto expectedTable2 = makeIdTableFromVector({{4}, {5}});\n  auto expectedTable3 = makeIdTableFromVector({{6}, {7}});\n\n  EXPECT_THAT(convertToVector(std::move(generator)),\n              matchesIdTables(expectedTable1, expectedTable2, expectedTable3));\n  EXPECT_EQ(resultSizeTotal, 5);\n}\n\n// _____________________________________________________________________________\nTEST(ExportQueryExecutionTrees, ensureGeneratorIsNotConsumedWhenNotRequired) {\n  {\n    auto throwingGenerator = []() -> Result::Generator {\n      std::string message = \"Generator was started, but should not have been\";\n      ADD_FAILURE() << message << std::endl;\n      throw std::runtime_error(message);\n      co_return;\n    }();\n\n    Result result{std::move(throwingGenerator), {}};\n    uint64_t resultSizeTotal = 0;\n    auto generator = ExportQueryExecutionTrees::getRowIndices(\n        LimitOffsetClause{._limit = 0, ._offset = 0}, result, resultSizeTotal);\n    EXPECT_NO_THROW(convertToVector(std::move(generator)));\n  }\n\n  {\n    auto throwAfterYieldGenerator = []() -> Result::Generator {\n      Result::IdTableVocabPair pair1{makeIdTableFromVector({{1}}),\n                                     LocalVocab{}};\n      co_yield pair1;\n\n      std::string message =\n          \"Generator was called a second time, but should not \"\n          \"have been\";\n      ADD_FAILURE() << message << std::endl;\n      throw std::runtime_error(message);\n    }();\n\n    Result result{std::move(throwAfterYieldGenerator), {}};\n    uint64_t resultSizeTotal = 0;\n    auto generator = ExportQueryExecutionTrees::getRowIndices(\n        LimitOffsetClause{._limit = 1, ._offset = 0}, result, resultSizeTotal);\n    IdTable expectedTable = makeIdTableFromVector({{1}});\n    std::vector<IdTable> tables;\n    EXPECT_NO_THROW({ tables = convertToVector(std::move(generator)); });\n    EXPECT_THAT(tables, matchesIdTables(expectedTable));\n    EXPECT_EQ(resultSizeTotal, 1);\n  }\n}\n\n// _____________________________________________________________________________\nTEST(ExportQueryExecutionTrees, verifyQleverJsonContainsValidMetadata) {\n  std::string_view query =\n      \"SELECT * WHERE { ?x ?y ?z . FILTER(?y != <p2>) } OFFSET 1 LIMIT 4\";\n  auto cancellationHandle =\n      std::make_shared<ad_utility::CancellationHandle<>>();\n\n  auto* qec = ad_utility::testing::getQec(\n      \"<s> <p1> 40,41,42,43,44,45,46,47,48,49\"\n      \" ; <p2> 50,51,52,53,54,55,56,57,58,59\");\n  QueryPlanner qp{qec, cancellationHandle};\n  auto pq = parseQuery(std::string{query});\n  auto qet = qp.createExecutionTree(pq);\n\n  ad_utility::Timer timer{ad_utility::Timer::Started};\n\n  // Verify this is accounted for for time calculation.\n  std::this_thread::sleep_for(1ms);\n\n  auto jsonStream = ExportQueryExecutionTrees::computeResultAsQLeverJSON(\n      pq, qet, pq._limitOffset, timer, std::move(cancellationHandle));\n\n  std::string aggregateString{};\n  for (std::string_view chunk : jsonStream) {\n    aggregateString += chunk;\n  }\n  nlohmann::json json = nlohmann::json::parse(aggregateString);\n  auto originalRuntimeInfo = qet.getRootOperation()->runtimeInfo();\n\n  EXPECT_EQ(json[\"query\"], query);\n  EXPECT_EQ(json[\"status\"], \"OK\");\n  EXPECT_THAT(json[\"warnings\"], ElementsAre());\n  EXPECT_THAT(json[\"selected\"], ElementsAre(Eq(\"?x\"), Eq(\"?y\"), Eq(\"?z\")));\n  EXPECT_EQ(json[\"res\"].size(), 4);\n  auto& runtimeInformationWrapper = json[\"runtimeInformation\"];\n  EXPECT_TRUE(runtimeInformationWrapper.contains(\"meta\"));\n  ASSERT_TRUE(runtimeInformationWrapper.contains(\"query_execution_tree\"));\n  auto& runtimeInformation = runtimeInformationWrapper[\"query_execution_tree\"];\n  EXPECT_EQ(runtimeInformation[\"result_cols\"], 3);\n  EXPECT_EQ(runtimeInformation[\"result_rows\"], 4);\n  EXPECT_EQ(json[\"resultsize\"], 4);\n  auto& timingInformation = json[\"time\"];\n  EXPECT_GE(toChrono(timingInformation[\"total\"].get<std::string_view>()), 1ms);\n  // Ensure result is not returned in microseconds and subsequently interpreted\n  // in milliseconds\n  EXPECT_LT(\n      toChrono(timingInformation[\"computeResult\"].get<std::string_view>()),\n      100ms);\n  EXPECT_GE(\n      toChrono(timingInformation[\"total\"].get<std::string_view>()),\n      toChrono(timingInformation[\"computeResult\"].get<std::string_view>()));\n}\n\n// _____________________________________________________________________________\nTEST(ExportQueryExecutionTrees, convertGeneratorForChunkedTransfer) {\n  using S = ad_utility::streams::stream_generator;\n  auto throwEarly = []() -> S {\n    co_yield \" Hallo... Ups\\n\";\n    throw std::runtime_error{\"failed\"};\n  };\n  auto call = [](S stream) {\n    [[maybe_unused]] auto res =\n        ExportQueryExecutionTrees::convertStreamGeneratorForChunkedTransfer(\n            std::move(stream));\n  };\n  AD_EXPECT_THROW_WITH_MESSAGE(call(throwEarly()), std::string_view(\"failed\"));\n  auto throwLate = [](bool throwProperException) -> S {\n    size_t largerThanBufferSize = (1ul << 20) + 4;\n    std::string largerThanBuffer;\n    largerThanBuffer.resize(largerThanBufferSize);\n    co_yield largerThanBuffer;\n    if (throwProperException) {\n      throw std::runtime_error{\"proper exception\"};\n    } else {\n      throw 424231;\n    }\n  };\n\n  auto consume = [](auto generator) {\n    std::string res;\n    for (const auto& el : generator) {\n      res.append(el);\n    }\n    return res;\n  };\n\n  std::optional<ad_utility::InputRangeTypeErased<std::string>> res;\n  using namespace ::testing;\n  EXPECT_NO_THROW((\n      res = ExportQueryExecutionTrees::convertStreamGeneratorForChunkedTransfer(\n          throwLate(true))));\n  EXPECT_THAT(consume(std::move(res.value())),\n              AllOf(HasSubstr(\"!!!!>># An error has occurred\"),\n                    HasSubstr(\"proper exception\")));\n\n  EXPECT_NO_THROW((\n      res = ExportQueryExecutionTrees::convertStreamGeneratorForChunkedTransfer(\n          throwLate(false))));\n  EXPECT_THAT(consume(std::move(res.value())),\n              AllOf(HasSubstr(\"!!!!>># An error has occurred\"),\n                    HasSubstr(\"A very strange\")));\n}\n\n// _____________________________________________________________________________\nTEST(ExportQueryExecutionTrees, compensateForLimitOffsetClause) {\n  auto* qec = ad_utility::testing::getQec();\n\n  auto qet1 = ad_utility::makeExecutionTree<ValuesForTesting>(\n      qec, makeIdTableFromVector({{1}}),\n      std::vector<std::optional<Variable>>{std::nullopt}, false);\n  auto qet2 = ad_utility::makeExecutionTree<ValuesForTesting>(\n      qec, makeIdTableFromVector({{1}}),\n      std::vector<std::optional<Variable>>{std::nullopt}, true);\n\n  LimitOffsetClause limit{10, 5};\n  ExportQueryExecutionTrees::compensateForLimitOffsetClause(limit, *qet1);\n  EXPECT_EQ(limit._offset, 5);\n\n  ExportQueryExecutionTrees::compensateForLimitOffsetClause(limit, *qet2);\n  EXPECT_EQ(limit._offset, 0);\n}\n\n// _____________________________________________________________________________\nTEST(ExportQueryExecutionTrees, EncodedIriManagerUsage) {\n  // Test that encoded IRIs are properly handled during export\n\n  // Create a knowledge graph with IRIs that should be encodable\n  std::string kg =\n      \"<http://example.org/123> <http://example.org/predicate456> \"\n      \"<http://example.org/789> .\"\n      \"<http://test.com/id/111> <http://example.org/predicate456> \\\"literal \"\n      \"value\\\" .\";\n\n  // Test XML export with encoded IRIs\n  std::string query = \"SELECT ?s ?p ?o WHERE { ?s ?p ?o } ORDER BY ?s ?p ?o\";\n\n  // Create test configuration with EncodedIriManager\n  auto encodedIriManager = std::make_shared<EncodedIriManager>(\n      std::vector<std::string>{\"http://example.org/\", \"http://test.com/id/\"});\n\n  ad_utility::testing::TestIndexConfig config{kg};\n  config.encodedPrefixesWithoutAngleBrackets =\n      std::vector<std::string>{\"http://example.org/\", \"http://test.com/id/\"};\n  auto qec = ad_utility::testing::getQec(std::move(config));\n\n  // Parse query with the same EncodedIriManager\n  auto parsedQuery =\n      SparqlParser::parseQuery(encodedIriManager.get(), query, {});\n\n  auto cancellationHandle =\n      std::make_shared<ad_utility::CancellationHandle<>>();\n  QueryPlanner qp{qec, cancellationHandle};\n  auto qet = qp.createExecutionTree(parsedQuery);\n\n  // Export as XML and verify encoded IRIs are properly converted back\n  ad_utility::Timer timer{ad_utility::Timer::Started};\n  auto cancellationHandle2 =\n      std::make_shared<ad_utility::CancellationHandle<>>();\n  std::string result;\n  for (const auto& chunk : ExportQueryExecutionTrees::computeResult(\n           parsedQuery, qet, ad_utility::MediaType::sparqlXml, timer,\n           std::move(cancellationHandle2))) {\n    result += chunk;\n  }\n\n  // Verify that the original IRI strings appear in the output\n  EXPECT_THAT(result, HasSubstr(\"http://example.org/123\"));\n  EXPECT_THAT(result, HasSubstr(\"http://example.org/predicate456\"));\n  EXPECT_THAT(result, HasSubstr(\"http://example.org/789\"));\n  EXPECT_THAT(result, HasSubstr(\"http://test.com/id/111\"));\n  EXPECT_THAT(result, HasSubstr(\"literal value\"));\n\n  // Test TSV export as well\n  ad_utility::Timer tsvTimer{ad_utility::Timer::Started};\n  auto cancellationHandle3 =\n      std::make_shared<ad_utility::CancellationHandle<>>();\n  std::string tsvResult;\n  for (const auto& chunk : ExportQueryExecutionTrees::computeResult(\n           parsedQuery, qet, ad_utility::MediaType::tsv, tsvTimer,\n           std::move(cancellationHandle3))) {\n    tsvResult += chunk;\n  }\n  EXPECT_THAT(tsvResult, HasSubstr(\"http://example.org/123\"));\n  EXPECT_THAT(tsvResult, HasSubstr(\"http://example.org/predicate456\"));\n  EXPECT_THAT(tsvResult, HasSubstr(\"http://example.org/789\"));\n  EXPECT_THAT(tsvResult, HasSubstr(\"http://test.com/id/111\"));\n}\n\n// _____________________________________________________________________________\n// Test that a `sparql-results+json` export includes a `meta` field if and\n// only if the respective runtime parameter is enabled.\nTEST(ExportQueryExecutionTrees, SparqlJsonWithMetaField) {\n  std::string kg = \"<x> <y> <z>\";\n  std::string query = \"SELECT ?s ?p ?o WHERE {?s ?p ?o}\";\n\n  // Case 1: Runtime parameter enabled (default).\n  {\n    auto cleanup = setRuntimeParameterForTest<\n        &RuntimeParameters::sparqlResultsJsonWithTime_>(true);\n    auto result = runJSONQuery(kg, query, ad_utility::MediaType::sparqlJson);\n    ASSERT_TRUE(result.contains(\"head\"));\n    ASSERT_TRUE(result.contains(\"results\"));\n    ASSERT_TRUE(result[\"head\"].contains(\"vars\"));\n    ASSERT_TRUE(result.contains(\"meta\"));\n    ASSERT_TRUE(result[\"meta\"].contains(\"query-time-ms\"));\n    ASSERT_TRUE(result[\"meta\"].contains(\"result-size-total\"));\n    ASSERT_TRUE(result[\"meta\"][\"query-time-ms\"].is_number());\n    ASSERT_TRUE(result[\"meta\"][\"result-size-total\"].is_number());\n    EXPECT_GE(result[\"meta\"][\"query-time-ms\"].get<int64_t>(), 0);\n    EXPECT_EQ(result[\"meta\"][\"result-size-total\"].get<int64_t>(), 1);\n  }\n\n  // Case 2: Runtime parameter disabled.\n  {\n    auto cleanup = setRuntimeParameterForTest<\n        &RuntimeParameters::sparqlResultsJsonWithTime_>(false);\n    auto result = runJSONQuery(kg, query, ad_utility::MediaType::sparqlJson);\n    ASSERT_TRUE(result.contains(\"head\"));\n    ASSERT_TRUE(result.contains(\"results\"));\n    ASSERT_TRUE(result[\"head\"].contains(\"vars\"));\n    ASSERT_FALSE(result.contains(\"meta\"));\n  }\n}\n";

const upstreamServiceHeaderFixture = "// Copyright 2022 - 2023, University of Freiburg,\n// Chair of Algorithms and Data Structures.\n// Author: Hannah Bast (bast@cs.uni-freiburg.de)\n// Copyright 2025, Bayerische Motoren Werke Aktiengesellschaft (BMW AG)\n\n#ifndef QLEVER_SRC_ENGINE_SERVICE_H\n#define QLEVER_SRC_ENGINE_SERVICE_H\n\n#ifndef QLEVER_REDUCED_FEATURE_SET_FOR_CPP17\n\n#include \"backports/functional.h\"\n#include \"engine/Operation.h\"\n#include \"engine/VariableToColumnMap.h\"\n#include \"parser/ParsedQuery.h\"\n#include \"util/LazyJsonParser.h\"\n#include \"util/http/HttpClient.h\"\n\n// The SERVICE operation. Sends a query to the remote endpoint specified by the\n// service IRI, gets the result as JSON, parses it, and writes it into a result\n// table.\n//\n// TODO: The current implementation works, but is preliminary in several\n// respects:\n//\n// 1. There should be a timeout.\n//\n// 2. A variable in place of the IRI is not yet supported (see comment in\n// `computeResult` for details).\n//\n// 3. The SERVICE is currently executed *after* the query planning. The\n// estimates of the result size, cost, and multiplicities are therefore dummy\n// values.\n//\nclass Service : public Operation {\n public:\n  // Information on a Sibling operation.\n  struct SiblingInfo {\n    std::shared_ptr<const Result> precomputedResult_;\n    VariableToColumnMap variables_;\n    std::string cacheKey_;\n  };\n\n private:\n  // The parsed SERVICE clause.\n  parsedQuery::Service parsedServiceClause_;\n\n  // The function used to obtain the result from the remote endpoint.\n  SendRequestType getResultFunction_;\n\n  // Optional sibling information to be used in `getSiblingValuesClause`.\n  std::optional<SiblingInfo> siblingInfo_;\n\n  // Counter to generate fresh ids for each instance of the class.\n  static inline std::atomic_uint32_t counter_ = 0;\n\n  // Id that is being used to avoid caching of the result. It is supposed to be\n  // unique for every instance of the class.\n  uint32_t cacheBreaker_ = counter_++;\n\n public:\n  // Construct from parsed Service clause.\n  //\n  // NOTE: The third argument is the function used to obtain the result from the\n  // remote endpoint. The default is to use `httpUtils::sendHttpOrHttpsRequest`,\n  // but in our tests (`ServiceTest`) we use a mock function that does not\n  // require a running `HttpServer`.\n  Service(QueryExecutionContext* qec, parsedQuery::Service parsedServiceClause,\n          SendRequestType getResultFunction = sendHttpOrHttpsRequest);\n\n  // Methods inherited from base class `Operation`.\n  std::string getDescriptor() const override;\n  size_t getResultWidth() const override;\n  std::vector<ColumnIndex> resultSortedOn() const override { return {}; }\n  float getMultiplicity(size_t col) override;\n\n private:\n  uint64_t getSizeEstimateBeforeLimit() override;\n\n public:\n  size_t getCostEstimate() override;\n  VariableToColumnMap computeVariableToColumnMap() const override;\n\n  // We know nothing about the result at query planning time.\n  bool knownEmptyResult() override { return false; }\n\n  // A SERVICE clause has no children.\n  std::vector<QueryExecutionTree*> getChildren() override { return {}; }\n\n  // Convert the given binding to TripleComponent.\n  TripleComponent bindingToTripleComponent(\n      const nlohmann::json& binding,\n      ad_utility::HashMap<std::string, Id>& blankNodeMap,\n      LocalVocab* localVocab) const;\n\n  // Create a value for the VALUES-clause used in `getSiblingValuesClause` from\n  // id. If the id is of type blank node `std::nullopt` is returned.\n  static std::optional<std::string> idToValueForValuesClause(\n      const Index& index, Id id, const LocalVocab& localVocab);\n\n  // Given two child-operations of a `Join`-, `OptionalJoin`- or `Minus`\n  // operation, this method tries to precompute the result of one if the other\n  // one (its sibling) is a `Service` operation. If `rightOnly` is true (used by\n  // `OptionalJoin` and `Minus`), only the right operation can be a `Service`.\n  static void precomputeSiblingResult(std::shared_ptr<Operation> left,\n                                      std::shared_ptr<Operation> right,\n                                      bool rightOnly, bool requestLaziness);\n\n private:\n  std::unique_ptr<Operation> cloneImpl() const override;\n\n  // The string returned by this function is used as cache key.\n  std::string getCacheKeyImpl() const override;\n\n  // Push down a `VALUES` clause into the body of the SERVICE clause and return\n  // it.\n  static std::string pushDownValues(std::string_view pattern,\n                                    std::string_view values);\n\n  // Return the optimized graph pattern derived from `parsedServiceClause_` and\n  // an optional derived sibling.\n  std::string getGraphPattern() const;\n\n  // Compute the result using `getResultFunction_` and `siblingInfo_`.\n  Result computeResult(bool requestLaziness) override;\n\n  // Actually compute the result for the function above.\n  Result computeResultImpl(bool requestLaziness);\n\n  // Get a VALUES clause that contains the values of the siblingTree's result.\n  std::optional<std::string> getSiblingValuesClause() const;\n\n  // Create result for silent fail.\n  Result makeNeutralElementResultForSilentFail() const;\n\n  // Check that all visible variables of the SERVICE clause exist in the json\n  // object, otherwise throw an error.\n  void verifyVariables(const nlohmann::json& head,\n                       const ad_utility::LazyJsonParser::Details& gen) const;\n\n  // Throws an error message, providing the first 100 bytes of the result as\n  // context.\n  [[noreturn]] void throwErrorWithContext(\n      std::string_view msg, std::string_view first100,\n      std::string_view last100 = \"\"sv) const;\n\n  // Throws if the IRI is forbidden by the IRI prefix whitelist.\n  void throwIfIriNotWhitelisted();\n\n  // Write the given JSON result to the given result object. The `I` is the\n  // width of the result table.\n  //\n  // NOTE: This is similar to `Values::writeValues`, except that we have to\n  // parse JSON here and not a VALUES clause.\n  template <size_t I>\n  void writeJsonResult(const std::vector<std::string>& vars,\n                       const nlohmann::json& partJson, IdTable* idTable,\n                       LocalVocab* localVocab, size_t& rowIdx);\n\n  // Compute the result lazy as IdTable generator.\n  // If the `singleIdTable` flag is set, the result is yielded as one idTable.\n  Result::LazyResult computeResultLazily(\n      const std::vector<std::string> vars,\n      ad_utility::LazyJsonParser::Generator body, bool singleIdTable);\n\n  FRIEND_TEST(ServiceTest, computeResult);\n  FRIEND_TEST(ServiceTest, computeResultWrapSubqueriesWithSibling);\n  FRIEND_TEST(ServiceTest, precomputeSiblingResultDoesNotWorkWithCaching);\n  FRIEND_TEST(ServiceTest, precomputeSiblingResultDoesNotWorkWithLimit);\n  FRIEND_TEST(ServiceTest, precomputeSiblingResult);\n};\n#else\n// In the C++17 mode, where the If we disable the `Service` operation isled,\n// wemputeSiblingResult` function, which does still provide a dummy for the\n// `preco completely disabn completely in the C++17 mode, hen we canthen we\n// still can't// wffix  th\nstruct Service {\n  template <typename... Ts>\n  static void precomputeSiblingResult(Ts&&...) {}\n};\n#endif  // QLEVER_REDUCED_FEATURE_SET_FOR_CPP17\n\n#endif  // QLEVER_SRC_ENGINE_SERVICE_H\n";

const upstreamServiceTestFixture = "//  Copyright 2022 - 2023, University of Freiburg,\n//  Chair of Algorithms and Data Structures.\n//  Author: Hannah Bast <bast@cs.uni-freiburg.de>\n\n#include <gmock/gmock.h>\n#include <gtest/gtest.h>\n\n#include <ctre-unicode.hpp>\n#include <exception>\n#include <regex>\n\n#include \"backports/StartsWithAndEndsWith.h\"\n#include \"engine/Service.h\"\n#include \"engine/Sort.h\"\n#include \"engine/Values.h\"\n#include \"global/Constants.h\"\n#include \"global/IndexTypes.h\"\n#include \"global/RuntimeParameters.h\"\n#include \"parser/GraphPatternOperation.h\"\n#include \"util/AllocatorWithLimit.h\"\n#include \"util/CancellationHandle.h\"\n#include \"util/GTestHelpers.h\"\n#include \"util/HttpClientTestHelpers.h\"\n#include \"util/IdTableHelpers.h\"\n#include \"util/IndexTestHelpers.h\"\n#include \"util/OperationTestHelpers.h\"\n#include \"util/RuntimeParametersTestHelpers.h\"\n#include \"util/TripleComponentTestHelpers.h\"\n#include \"util/http/HttpUtils.h\"\n\n// Fixture that sets up a test index and a factory for producing mocks for the\n// `getResultFunction` needed by the `Service` operation.\nclass ServiceTest : public ::testing::Test {\n protected:\n  // Query execution context (with small test index) and allocator for testing,\n  // see `IndexTestHelpers.h`. Note that `getQec` returns a pointer to a static\n  // `QueryExecutionContext`, so no need to ever delete `testQec`.\n  QueryExecutionContext* testQec = ad_utility::testing::getQec();\n\n  // Factory for generating mocks of the `sendHttpOrHttpsRequest` function that\n  // is used by default by a `Service` operation (see the constructor in\n  // `Service.h`). Each mock does the following:\n  //\n  // 1. It tests that the request method is POST, the content-type header is\n  //    `application/sparql-query`, and the accept header is\n  //    `text/tab-separated-values` (our `Service` always does this).\n  //\n  // 2. It tests that the host and port are as expected.\n  //\n  // 3. It tests that the post data is as expected.\n  //\n  // 4. It returns the specified JSON.\n  //\n  // NOTE: In a previous version of this test, we set up an actual test server.\n  // The code can be found in the history of this PR.\n  static auto constexpr getResultFunctionFactory =\n      [](std::string_view expectedUrl, std::string_view expectedSparqlQuery,\n         std::string predefinedResult,\n         boost::beast::http::status status = boost::beast::http::status::ok,\n         std::string contentType = \"application/sparql-results+json\",\n         std::exception_ptr mockException = nullptr,\n         ad_utility::source_location loc =\n             AD_CURRENT_SOURCE_LOC()) -> SendRequestType {\n    // Check that the request parameters are as expected.\n    //\n    // NOTE: Method, Content-Type and Accept are hard-coded in\n    // `Service::computeResult`, but the host and port of the endpoint are\n    // derived from the IRI, so url and post data are non-trivial.\n    httpClientTestHelpers::RequestMatchers matchers{\n        .url_ = testing::Eq(expectedUrl),\n        .method_ = testing::Eq(boost::beast::http::verb::post),\n        // Check that the whitespace-normalized POST data is the expected query.\n        //\n        // NOTE: a SERVICE clause specifies only the body of a SPARQL query,\n        // from which `Service::computeResult` has to construct a full SPARQL\n        // query by adding `SELECT ... WHERE`, so this checks something\n        // non-trivial.\n        .postData_ = testing::ResultOf(\n            [](std::string_view postData) {\n              return std::regex_replace(std::string{postData},\n                                        std::regex{\"\\\\s+\"}, \" \");\n            },\n            testing::Eq(expectedSparqlQuery)),\n        .contentType_ = testing::Eq(\"application/sparql-query\"),\n        .accept_ = testing::Eq(\"application/sparql-results+json\")};\n    return httpClientTestHelpers::getResultFunctionFactory(\n        predefinedResult, contentType, status, matchers, mockException, loc);\n  };\n\n  // The following method generates a JSON result from variables and rows for\n  // Testing.\n  // Passing more values per row than variables are given isn't supported.\n  // Generates all cells with the given values and type uri.\n  static std::string genJsonResult(\n      std::vector<std::string_view> vars,\n      std::vector<std::vector<std::string_view>> rows) {\n    nlohmann::json res;\n    res[\"head\"][\"vars\"] = vars;\n    res[\"results\"][\"bindings\"] = nlohmann::json::array();\n\n    for (size_t i = 0; i < rows.size(); ++i) {\n      nlohmann::json binding;\n      for (size_t j = 0; j < std::min(rows[i].size(), vars.size()); ++j) {\n        binding[vars[j]] = {{\"type\", \"uri\"}, {\"value\", rows[i][j]}};\n      }\n      res[\"results\"][\"bindings\"].push_back(binding);\n    }\n    return res.dump();\n  }\n\n  static Service::SiblingInfo siblingInfoFromOp(std::shared_ptr<Operation> op) {\n    return Service::SiblingInfo{op->getResult(),\n                                op->getExternallyVisibleVariableColumns(),\n                                op->getCacheKey()};\n  };\n};\n\n// Test basic methods of class `Service`.\nTEST_F(ServiceTest, basicMethods) {\n  // Construct a parsed SERVICE clause by hand. The fourth argument is the query\n  // body (empty in this case because this test is not about evaluating a\n  // query). The fourth argument plays no role in our test (and isn't really\n  // used in `parsedQuery::Service` either).\n  parsedQuery::Service parsedServiceClause{\n      {Variable{\"?x\"}, Variable{\"?y\"}},\n      TripleComponent::Iri::fromIriref(\"<http://localhorst/api>\"),\n      \"PREFIX doof: <http://doof.org>\",\n      \"{ }\",\n      false};\n  // Create an operation from this.\n  Service serviceOp{testQec, parsedServiceClause};\n\n  // Test the basic methods.\n  ASSERT_EQ(serviceOp.getDescriptor(),\n            \"Service with IRI <http://localhorst/api>\");\n  ASSERT_TRUE(ql::starts_with(serviceOp.getCacheKey(), \"SERVICE \"))\n      << serviceOp.getCacheKey();\n  ASSERT_EQ(serviceOp.getResultWidth(), 2);\n  ASSERT_EQ(serviceOp.getMultiplicity(0), 1);\n  ASSERT_EQ(serviceOp.getMultiplicity(1), 1);\n  ASSERT_EQ(serviceOp.getSizeEstimate(), 100'000);\n  ASSERT_EQ(serviceOp.getCostEstimate(), 1'000'000);\n  using V = Variable;\n  ASSERT_THAT(serviceOp.computeVariableToColumnMap(),\n              ::testing::UnorderedElementsAreArray(VariableToColumnMap{\n                  {V{\"?x\"}, makePossiblyUndefinedColumn(0)},\n                  {V{\"?y\"}, makePossiblyUndefinedColumn(1)}}));\n  ASSERT_FALSE(serviceOp.knownEmptyResult());\n  ASSERT_TRUE(serviceOp.getChildren().empty());\n}\n\n// Tests that `computeResult` behaves as expected.\nTEST_F(ServiceTest, computeResult) {\n  // These tests are randomized, and there used to be an error that was found by\n  // these random tests (but not always). Run the tests 10 times, this is a good\n  // compromise between reasonable runtimes of the tests and a reasonable test\n  // coverage.\n  for (size_t i = 0; i < 10; ++i) {\n    // Construct a parsed SERVICE clause by hand, see `basicMethods` test above.\n    parsedQuery::Service parsedServiceClause{\n        {Variable{\"?x\"}, Variable{\"?y\"}},\n        TripleComponent::Iri::fromIriref(\"<http://localhorst/api>\"),\n        \"PREFIX doof: <http://doof.org>\",\n        \"{ }\",\n        false};\n    parsedQuery::Service parsedServiceClauseSilent{\n        {Variable{\"?x\"}, Variable{\"?y\"}},\n        TripleComponent::Iri::fromIriref(\"<http://localhorst/api>\"),\n        \"PREFIX doof: <http://doof.org>\",\n        \"{ }\",\n        true};\n\n    // This is the (port-normalized) URL and (whitespace-normalized) SPARQL\n    // query we expect.\n    std::string_view expectedUrl = \"http://localhorst:80/api\";\n    std::string_view expectedSparqlQuery =\n        \"PREFIX doof: <http://doof.org> SELECT ?x ?y { }\";\n\n    // Shorthand to run computeResult with the test parameters given above.\n    auto runComputeResult =\n        [&](const std::string& result,\n            boost::beast::http::status status = boost::beast::http::status::ok,\n            std::string contentType = \"application/sparql-results+json\",\n            bool silent = false,\n            ad_utility::source_location loc =\n                AD_CURRENT_SOURCE_LOC()) -> Result {\n      Service s{\n          testQec, silent ? parsedServiceClauseSilent : parsedServiceClause,\n          getResultFunctionFactory(expectedUrl, expectedSparqlQuery, result,\n                                   status, contentType, nullptr, loc)};\n      return s.computeResultOnlyForTesting();\n    };\n\n    // Compute the Result lazily for the given Service and check that the\n    // resulting IdTable equals the expected IdTable-vector.\n    auto checkLazyResult =\n        [this](Service& service,\n               const std::vector<std::vector<std::string>>& expIdTableVector) {\n          auto result = service.computeResultOnlyForTesting(true);\n\n          // compute resulting idTable\n          IdTable idTable{2, ad_utility::testing::makeAllocator()};\n          std::vector<LocalVocab> localVocabs{};\n          for (auto& pair : result.idTables()) {\n            idTable.insertAtEnd(pair.idTable_);\n            localVocabs.emplace_back(std::move(pair.localVocab_));\n          }\n\n          // create expected idTable\n          auto get = [this, &localVocabs](\n                         std::string_view s) -> std::optional<LocalVocabIndex> {\n            for (const LocalVocab& localVocab : localVocabs) {\n              auto index =\n                  localVocab.getIndexOrNullopt(LocalVocabEntry::fromIriref(\n                      s, testQec->getLocalVocabContext()));\n              if (index.has_value()) {\n                return index;\n              }\n            }\n            return std::nullopt;\n          };\n          std::vector<std::vector<IntOrId>> idVector;\n          std::map<std::string, Id> ids;\n          size_t indexCounter = 0;\n          for (auto& row : expIdTableVector) {\n            auto& idVecRow = idVector.emplace_back();\n            for (auto& e : row) {\n              if (!ids.contains(e)) {\n                auto str = absl::StrCat(\"<\", e, \">\");\n                auto idx = get(str);\n                ASSERT_TRUE(idx) << '\\'' << str << \"' not in local vocab\";\n                ids.insert({e, Id::makeFromLocalVocabIndex(idx.value())});\n                ++indexCounter;\n              }\n              idVecRow.emplace_back(ids.at(e));\n            }\n          }\n          EXPECT_EQ(indexCounter, ids.size());\n\n          EXPECT_EQ(idTable, makeIdTableFromVector(idVector));\n        };\n\n    // Checks that a given result throws a specific error message, however when\n    // the `SILENT` keyword is set it will be caught.\n    auto expectThrowOrSilence =\n        [&](const std::string& result, std::string_view errorMsg,\n            boost::beast::http::status status = boost::beast::http::status::ok,\n            std::string contentType = \"application/sparql-results+json\",\n            ad_utility::source_location loc = AD_CURRENT_SOURCE_LOC()) {\n          auto g = generateLocationTrace(loc);\n          AD_EXPECT_THROW_WITH_MESSAGE(\n              runComputeResult(result, status, contentType, false),\n              ::testing::HasSubstr(errorMsg));\n          EXPECT_NO_THROW(runComputeResult(result, status, contentType, true));\n\n          // In the syntax test mode, all services (so also the failing ones)\n          // return the neutral result.\n          auto cleanup =\n              setRuntimeParameterForTest<&RuntimeParameters::syntaxTestMode_>(\n                  true);\n          EXPECT_NO_THROW(runComputeResult(result, status, contentType, false));\n        };\n\n    // CHECK 1: An exception shall be thrown (and maybe silenced), when\n    // status-code isn't ok\n    expectThrowOrSilence(\n        genJsonResult({\"x\", \"y\"}, {{\"bla\", \"bli\"}, {\"blu\"}, {\"bli\", \"blu\"}}),\n        \"SERVICE responded with HTTP status code: 400, Bad Request\",\n        boost::beast::http::status::bad_request,\n        \"application/sparql-results+json\");\n    // contentType doesn't match\n    expectThrowOrSilence(\n        genJsonResult({\"x\", \"y\"}, {{\"bla\", \"bli\"}, {\"blu\"}, {\"bli\", \"blu\"}}),\n        \"QLever requires the endpoint of a SERVICE to send \"\n        \"the result as 'application/sparql-results+json' but \"\n        \"the endpoint sent 'wrong/type'\",\n        boost::beast::http::status::ok, \"wrong/type\");\n\n    // or Result has invalid structure\n    // `results` missing\n    expectThrowOrSilence(\"{\\\"head\\\": {\\\"vars\\\": [\\\"x\\\", \\\"y\\\"]}}\",\n                         \"results section missing\");\n    expectThrowOrSilence(\"\", \"results section missing\");\n    // `bindings` missing\n    expectThrowOrSilence(\n        \"{\\\"head\\\": {\\\"vars\\\": [\\\"x\\\", \\\"y\\\"]},\"\n        \"\\\"results\\\": {}}\",\n        \"results section missing\");\n    // wrong `bindings` type (array expected)\n    expectThrowOrSilence(\n        \"{\\\"head\\\": {\\\"vars\\\": [\\\"x\\\", \\\"y\\\"]},\"\n        \"\\\"results\\\": {\\\"bindings\\\": {}}}\",\n        \"results section missing\");\n\n    // `head`/`vars` missing\n    expectThrowOrSilence(\n        \"{\\\"results\\\": {\\\"bindings\\\": [{\\\"x\\\": {\\\"type\\\": \\\"uri\\\", \\\"value\\\": \"\n        \"\\\"a\\\"}, \\\"y\\\": {\\\"type\\\": \\\"uri\\\", \\\"value\\\": \\\"b\\\"}}]}}\",\n        \"head section missing\");\n    expectThrowOrSilence(\n        \"{\\\"head\\\": {},\"\n        \"\\\"results\\\": {\\\"bindings\\\": []}}\",\n        \"\\\"head\\\" section is not according to the SPARQL standard\");\n    // wrong variables type (array of strings expected)\n    expectThrowOrSilence(\n        \"{\\\"head\\\": {\\\"vars\\\": [\\\"x\\\", \\\"y\\\", 3]},\"\n        \"\\\"results\\\": {\\\"bindings\\\": []}}\",\n        \"\\\"head\\\" section is not according to the SPARQL standard\");\n\n    // Internal parser errors.\n    expectThrowOrSilence(\n        std::string(1'000'000, '0'),\n        \"QLever currently doesn't support SERVICE results where a single \"\n        \"result row is larger than 1MB\");\n\n    // CHECK 1b: Even if the SILENT-keyword is set, throw local errors.\n    Service serviceSilent{\n        testQec, parsedServiceClauseSilent,\n        getResultFunctionFactory(\n            expectedUrl, expectedSparqlQuery, \"{}\",\n            boost::beast::http::status::ok, \"application/sparql-results+json\",\n            std::make_exception_ptr(ad_utility::CancellationException(\n                ad_utility::CancellationState::MANUAL, \"Mock Cancellation\")))};\n\n    AD_EXPECT_THROW_WITH_MESSAGE_AND_TYPE(\n        serviceSilent.computeResultOnlyForTesting(),\n        ::testing::HasSubstr(\"Mock Cancellation\"),\n        ad_utility::CancellationException);\n\n    Service serviceSilent2{\n        testQec, parsedServiceClauseSilent,\n        getResultFunctionFactory(\n            expectedUrl, expectedSparqlQuery, \"{}\",\n            boost::beast::http::status::ok, \"application/sparql-results+json\",\n            std::make_exception_ptr(\n                ad_utility::detail::AllocationExceedsLimitException(2_B,\n                                                                    1_B)))};\n\n    AD_EXPECT_THROW_WITH_MESSAGE_AND_TYPE(\n        serviceSilent2.computeResultOnlyForTesting(),\n        ::testing::HasSubstr(\"Tried to allocate\"),\n        ad_utility::detail::AllocationExceedsLimitException);\n\n    // CHECK 1c: Accept the content-type regardless of it's case or additional\n    // parameters.\n    EXPECT_NO_THROW(runComputeResult(\n        genJsonResult({\"x\", \"y\"},\n                      {{\"bla\", \"bli\"}, {\"blu\", \"bla\"}, {\"bli\", \"blu\"}}),\n        boost::beast::http::status::ok,\n        \"APPLICATION/SPARQL-RESULTS+JSON;charset=utf-8\"));\n\n    // CHECK 2: Header row of returned JSON is wrong (missing expected\n    // variables)\n    // -> an exception should be thrown.\n    expectThrowOrSilence(genJsonResult({\"x\"}, {{\"bla\"}, {\"blu\"}, {\"bli\"}}),\n                         \"Header row of JSON result for SERVICE query is \"\n                         \"\\\"?x\\\", but expected \\\"?x ?y\\\".\");\n\n    // CHECK 3: A result row of the returned JSON is missing a variable's\n    // value -> undefined value\n    auto result3 = runComputeResult(\n        genJsonResult({\"x\", \"y\"}, {{\"bla\", \"bli\"}, {\"blu\"}, {\"bli\", \"blu\"}}));\n    EXPECT_TRUE(result3.idTableView()(1, 1).isUndefined());\n\n    testQec->clearCacheUnpinnedOnly();\n\n    // CHECK 4: Returned JSON has correct format matching the query -> check\n    // that the result table returned by the operation corresponds to the\n    // contents of the JSON and its local vocabulary are correct.\n    auto result = runComputeResult(genJsonResult(\n        {\"x\", \"y\"},\n        {{\"x\", \"y\"}, {\"bla\", \"bli\"}, {\"blu\", \"bla\"}, {\"bli\", \"blu\"}}));\n\n    // Check that `<x>` and `<y>` were contained in the original vocabulary\n    // and that `<bla>`, `<bli>`, `<blu>` were added to the (initially\n    // empty) local vocabulary. On the way, obtain their IDs, which we then\n    // need below.\n    auto getId = ad_utility::testing::makeGetId(testQec->getIndex());\n    Id idX = getId(\"<x>\");\n    Id idY = getId(\"<y>\");\n    const auto& localVocab = result.localVocab();\n    EXPECT_EQ(localVocab.size(), 3);\n    const auto& localVocabContext = testQec->getLocalVocabContext();\n    auto get = [&localVocab, &localVocabContext](std::string_view s) {\n      return localVocab.getIndexOrNullopt(\n          LocalVocabEntry::fromIriref(s, localVocabContext));\n    };\n    std::optional<LocalVocabIndex> idxBla = get(\"<bla>\");\n    std::optional<LocalVocabIndex> idxBli = get(\"<bli>\");\n    std::optional<LocalVocabIndex> idxBlu = get(\"<blu>\");\n    ASSERT_TRUE(idxBli.has_value());\n    ASSERT_TRUE(idxBla.has_value());\n    ASSERT_TRUE(idxBlu.has_value());\n    Id idBli = Id::makeFromLocalVocabIndex(idxBli.value());\n    Id idBla = Id::makeFromLocalVocabIndex(idxBla.value());\n    Id idBlu = Id::makeFromLocalVocabIndex(idxBlu.value());\n\n    // Check that the result table corresponds to the contents of the JSON.\n    IdTable expectedIdTable = makeIdTableFromVector(\n        {{idX, idY}, {idBla, idBli}, {idBlu, idBla}, {idBli, idBlu}});\n    EXPECT_EQ(result.idTableView(), expectedIdTable);\n\n    // Check 5: When a siblingTree with variables common to the Service\n    // Clause is passed, the Service Operation shall use the siblings result\n    // to reduce its Query complexity by injecting them as Values Clause\n\n    auto iri = ad_utility::testing::iri;\n    using TC = TripleComponent;\n\n    auto sibling = std::make_shared<Values>(\n        testQec, (parsedQuery::SparqlValues){\n                     {Variable{\"?x\"}, Variable{\"?y\"}, Variable{\"?z\"}},\n                     {{TC(iri(\"<x>\")), TC(iri(\"<y>\")), TC(iri(\"<z>\"))},\n                      {TC(iri(\"<x>\")), TC(iri(\"<y>\")), TC(iri(\"<z2>\"))},\n                      {TC(iri(\"<blu>\")), TC(iri(\"<bla>\")), TC(iri(\"<blo>\"))},\n                      // This row will be ignored in the created Values Clause\n                      // as it contains a blank node.\n                      {TC(Id::makeFromBlankNodeIndex(BlankNodeIndex::make(0))),\n                       TC(iri(\"<bl>\")), TC(iri(\"<ank>\"))}}});\n\n    auto parsedServiceClause5 = parsedServiceClause;\n    parsedServiceClause5.graphPatternAsString_ =\n        \"{ ?x <ble> ?y . ?y <is-a> ?z2 . }\";\n    parsedServiceClause5.visibleVariables_.emplace_back(\"?z2\");\n\n    std::string_view expectedSparqlQuery5 =\n        \"PREFIX doof: <http://doof.org> SELECT ?x ?y ?z2 \"\n        \"{ VALUES (?x ?y) { (<x> <y>) (<blu> <bla>) } . ?x <ble> ?y \"\n        \". ?y \"\n        \"<is-a> ?z2 . }\";\n\n    Service serviceOperation5{\n        testQec, parsedServiceClause5,\n        getResultFunctionFactory(\n            expectedUrl, expectedSparqlQuery5,\n            genJsonResult({\"x\", \"y\", \"z2\"}, {{\"x\", \"y\", \"y\"},\n                                             {\"bla\", \"bli\", \"y\"},\n                                             {\"blu\", \"bla\", \"y\"},\n                                             {\"bli\", \"blu\", \"y\"}}))};\n\n    serviceOperation5.siblingInfo_.emplace(siblingInfoFromOp(sibling));\n    EXPECT_NO_THROW(serviceOperation5.computeResultOnlyForTesting());\n\n    // Check 7: Lazy computation\n    Service lazyService{\n        testQec, parsedServiceClause,\n        getResultFunctionFactory(\n            expectedUrl, expectedSparqlQuery,\n            genJsonResult({\"x\", \"y\"},\n                          {{\"bla\", \"bli\"}, {\"blu\", \"bla\"}, {\"bli\", \"blu\"}}),\n            boost::beast::http::status::ok, \"application/sparql-results+json\")};\n\n    checkLazyResult(lazyService,\n                    {{\"bla\", \"bli\"}, {\"blu\", \"bla\"}, {\"bli\", \"blu\"}});\n\n    // Check 8: LazyJsonParser Error\n    Service service8{\n        testQec, parsedServiceClause,\n        getResultFunctionFactory(\n            expectedUrl, expectedSparqlQuery, std::string(1'000'000, '0'),\n            boost::beast::http::status::ok, \"application/sparql-results+json\")};\n    AD_EXPECT_THROW_WITH_MESSAGE(\n        service8.computeResultOnlyForTesting(),\n        ::testing::HasSubstr(\"Parser failed with error\"));\n    AD_EXPECT_THROW_WITH_MESSAGE(\n        checkLazyResult(service8, {}),\n        ::testing::HasSubstr(\"Parser failed with error\"));\n\n    Service service8b{\n        testQec, parsedServiceClause,\n        getResultFunctionFactory(\n            expectedUrl, expectedSparqlQuery,\n            R\"({\"head\": {\"vars\": [\"a\"]}, \"results\": {\"bindings\": [{\"a\": break}]}})\",\n            boost::beast::http::status::ok, \"application/sparql-results+json\")};\n    AD_EXPECT_THROW_WITH_MESSAGE(\n        service8b.computeResultOnlyForTesting(),\n        ::testing::HasSubstr(\"Parser failed with error\"));\n    AD_EXPECT_THROW_WITH_MESSAGE(\n        checkLazyResult(service8b, {}),\n        ::testing::HasSubstr(\"Parser failed with error\"));\n  }\n}\n\n// _____________________________________________________________________________\nTEST_F(ServiceTest, computeResultWrapSubqueriesWithSibling) {\n  auto iri = ad_utility::testing::iri;\n  using TC = TripleComponent;\n\n  auto sibling = std::make_shared<Values>(\n      testQec,\n      (parsedQuery::SparqlValues){{Variable{\"?a\"}}, {{TC(iri(\"<a>\"))}}});\n\n  parsedQuery::Service parsedServiceClause{\n      {Variable{\"?a\"}},\n      TripleComponent::Iri::fromIriref(\"<http://localhost/api>\"),\n      \"\",\n      \"{ SELECT ?obj WHERE { ?a ?b ?c } }\",\n      false};\n\n  std::string_view expectedSparqlQuery =\n      \" SELECT ?a { VALUES (?a) { (<a>) } . { SELECT ?obj WHERE { ?a ?b \"\n      \"?c } } }\";\n\n  Service serviceOperation{\n      testQec, parsedServiceClause,\n      getResultFunctionFactory(\"http://localhost:80/api\", expectedSparqlQuery,\n                               genJsonResult({\"a\"}, {{\"a\"}}))};\n\n  serviceOperation.siblingInfo_.emplace(siblingInfoFromOp(sibling));\n  EXPECT_NO_THROW(serviceOperation.computeResultOnlyForTesting());\n}\n\n// _____________________________________________________________________________\nTEST_F(ServiceTest, computeResultNoVariables) {\n  parsedQuery::Service parsedServiceClause{\n      {},\n      TripleComponent::Iri::fromIriref(\"<http://localhost/api>\"),\n      \"\",\n      \"{ <a> <b> <c> }\",\n      false};\n\n  std::string_view expectedSparqlQuery = \" SELECT * { <a> <b> <c> }\";\n\n  Service serviceOperation{\n      testQec, parsedServiceClause,\n      getResultFunctionFactory(\"http://localhost:80/api\", expectedSparqlQuery,\n                               genJsonResult({}, {{}}))};\n\n  EXPECT_NO_THROW(serviceOperation.computeResultOnlyForTesting());\n}\n\nTEST_F(ServiceTest, getCacheKey) {\n  // Base query to check cache-keys against.\n  parsedQuery::Service parsedServiceClause{\n      {Variable{\"?x\"}, Variable{\"?y\"}},\n      TripleComponent::Iri::fromIriref(\"<http://localhorst/api>\"),\n      \"PREFIX doof: <http://doof.org>\",\n      \"{ }\",\n      false};\n\n  Service service1{\n      testQec, parsedServiceClause,\n      getResultFunctionFactory(\n          \"http://localhorst:80/api\",\n          \"PREFIX doof: <http://doof.org> SELECT ?x ?y WHERE { }\",\n          genJsonResult(\n              {\"x\", \"y\"},\n              {{\"x\", \"y\"}, {\"bla\", \"bli\"}, {\"blu\", \"bla\"}, {\"bli\", \"blu\"}}))};\n\n  Service service2{\n      testQec, parsedServiceClause,\n      getResultFunctionFactory(\n          \"http://localhorst:80/api\",\n          \"PREFIX doof: <http://doof.org> SELECT ?x ?y WHERE { }\",\n          genJsonResult(\n              {\"x\", \"y\"},\n              {{\"x\", \"y\"}, {\"bla\", \"bli\"}, {\"blu\", \"bla\"}, {\"bli\", \"blu\"}}))};\n\n  // Identically constructed services should have have unique cache keys.\n  // Because a remote endpoint cannot be considered cached.\n  EXPECT_NE(service1.getCacheKey(), service2.getCacheKey());\n}\n\n// _____________________________________________________________________________\nTEST_F(ServiceTest, getCacheKeyWithCaching) {\n  using namespace ::testing;\n  auto cleanup =\n      setRuntimeParameterForTest<&RuntimeParameters::cacheServiceResults_>(\n          true);\n  {\n    parsedQuery::Service parsedServiceClause{\n        {Variable{\"?x\"}, Variable{\"?y\"}},\n        TripleComponent::Iri::fromIriref(\"<http://localhorst/api>\"),\n        \"PREFIX doof: <http://doof.org>\",\n        \"{ }\",\n        false};\n\n    Service service{\n        testQec, parsedServiceClause,\n        getResultFunctionFactory(\n            \"http://localhorst:80/api\",\n            \"PREFIX doof: <http://doof.org> SELECT ?x ?y WHERE { }\",\n            genJsonResult(\n                {\"x\", \"y\"},\n                {{\"x\", \"y\"}, {\"bla\", \"bli\"}, {\"blu\", \"bla\"}, {\"bli\", \"blu\"}}))};\n\n    EXPECT_THAT(service.getCacheKey(),\n                AllOf(StartsWith(\"SERVICE\"), Not(HasSubstr(\"SILENT\")),\n                      HasSubstr(\"<http://localhorst/api>\"),\n                      HasSubstr(\"PREFIX doof: <http://doof.org>\"),\n                      HasSubstr(parsedServiceClause.graphPatternAsString_)));\n  }\n  {\n    parsedQuery::Service parsedServiceClause{\n        {Variable{\"?x\"}, Variable{\"?y\"}},\n        TripleComponent::Iri::fromIriref(\"<http://localhorst/api>\"),\n        \"PREFIX doof: <http://doof.org>\",\n        \"{ }\",\n        true};\n\n    Service service{\n        testQec, parsedServiceClause,\n        getResultFunctionFactory(\n            \"http://localhorst:80/api\",\n            \"PREFIX doof: <http://doof.org> SELECT ?x ?y WHERE { }\",\n            genJsonResult(\n                {\"x\", \"y\"},\n                {{\"x\", \"y\"}, {\"bla\", \"bli\"}, {\"blu\", \"bla\"}, {\"bli\", \"blu\"}}))};\n\n    EXPECT_THAT(service.getCacheKey(),\n                AllOf(StartsWith(\"SERVICE\"), HasSubstr(\"SILENT\"),\n                      HasSubstr(\"<http://localhorst/api>\"),\n                      HasSubstr(\"PREFIX doof: <http://doof.org>\"),\n                      HasSubstr(parsedServiceClause.graphPatternAsString_)));\n  }\n}\n\n// Test that bindingToTripleComponent behaves as expected.\nTEST_F(ServiceTest, bindingToTripleComponent) {\n  ad_utility::HashMap<std::string, Id> blankNodeMap;\n  parsedQuery::Service parsedServiceClause{\n      {Variable{\"?x\"}, Variable{\"?y\"}},\n      TripleComponent::Iri::fromIriref(\"<http://localhorst/api>\"),\n      \"PREFIX doof: <http://doof.org>\",\n      \"{ }\",\n      false};\n  Service service{testQec, parsedServiceClause};\n  LocalVocab localVocab{};\n\n  auto bTTC = [&service, &blankNodeMap,\n               &localVocab](const nlohmann::json& binding) -> TripleComponent {\n    return service.bindingToTripleComponent(binding, blankNodeMap, &localVocab);\n  };\n\n  // Missing type or value.\n  AD_EXPECT_THROW_WITH_MESSAGE(bTTC({{\"type\", \"literal\"}}),\n                               ::testing::HasSubstr(\"Missing type or value\"));\n  AD_EXPECT_THROW_WITH_MESSAGE(bTTC({{\"value\", \"v\"}}),\n                               ::testing::HasSubstr(\"Missing type or value\"));\n\n  EXPECT_EQ(\n      bTTC({{\"type\", \"literal\"}, {\"value\", \"42\"}, {\"datatype\", XSD_INT_TYPE}}),\n      42);\n\n  EXPECT_EQ(\n      bTTC({{\"type\", \"literal\"}, {\"value\", \"Hallo Welt\"}, {\"xml:lang\", \"de\"}}),\n      TripleComponent::Literal::literalWithoutQuotes(\"Hallo Welt\", \"@de\"));\n\n  // See the comment in `src/engine/Service.cpp` regarding the support of the\n  // deprecated `typed-literal` type.\n  EXPECT_EQ(\n      bTTC({{\"type\", \"typed-literal\"},\n            {\"value\", \"Hallo Welt\"},\n            {\"xml:lang\", \"de\"}}),\n      TripleComponent::Literal::literalWithoutQuotes(\"Hallo Welt\", \"@de\"));\n\n  EXPECT_EQ(bTTC({{\"type\", \"literal\"}, {\"value\", \"Hello World\"}}),\n            TripleComponent::Literal::literalWithoutQuotes(\"Hello World\"));\n\n  // Test literals with escape characters (there used to be a bug for those)\n  EXPECT_EQ(\n      bTTC({{\"type\", \"literal\"}, {\"value\", \"Hello \\\\World\"}}),\n      TripleComponent::Literal::fromEscapedRdfLiteral(\"\\\"Hello \\\\\\\\World\\\"\"));\n\n  EXPECT_EQ(\n      bTTC(\n          {{\"type\", \"literal\"}, {\"value\", \"Hallo \\\\Welt\"}, {\"xml:lang\", \"de\"}}),\n      TripleComponent::Literal::fromEscapedRdfLiteral(\"\\\"Hallo \\\\\\\\Welt\\\"\",\n                                                      \"@de\"));\n\n  EXPECT_EQ(bTTC({{\"type\", \"literal\"}, {\"value\", \"a\\\"b\\\"c\"}}),\n            TripleComponent::Literal::fromEscapedRdfLiteral(\"\\\"a\\\\\\\"b\\\\\\\"c\\\"\"));\n\n  EXPECT_EQ(bTTC({{\"type\", \"uri\"}, {\"value\", \"http://doof.org\"}}),\n            TripleComponent::Iri::fromIrirefWithoutBrackets(\"http://doof.org\"));\n\n  // Blank Nodes.\n  EXPECT_EQ(blankNodeMap.size(), 0);\n\n  const EncodedIriManager encodedIriManager;\n  Id a = bTTC({{\"type\", \"bnode\"}, {\"value\", \"A\"}})\n             .toValueIdIfNotString(&encodedIriManager)\n             .value();\n  Id b = bTTC({{\"type\", \"bnode\"}, {\"value\", \"B\"}})\n             .toValueIdIfNotString(&encodedIriManager)\n             .value();\n  EXPECT_EQ(a.getDatatype(), Datatype::BlankNodeIndex);\n  EXPECT_EQ(b.getDatatype(), Datatype::BlankNodeIndex);\n  EXPECT_NE(a, b);\n\n  EXPECT_EQ(blankNodeMap.size(), 2);\n\n  // This BlankNode exists already, known Id will be used.\n  Id a2 = bTTC({{\"type\", \"bnode\"}, {\"value\", \"A\"}})\n              .toValueIdIfNotString(&encodedIriManager)\n              .value();\n  EXPECT_EQ(a, a2);\n\n  // Invalid type -> throw.\n  AD_EXPECT_THROW_WITH_MESSAGE(\n      bTTC({{\"type\", \"INVALID_TYPE\"}, {\"value\", \"v\"}}),\n      ::testing::HasSubstr(\"Type INVALID_TYPE is undefined.\"));\n}\n\n// ____________________________________________________________________________\nTEST_F(ServiceTest, idToValueForValuesClause) {\n  auto idToVc = Service::idToValueForValuesClause;\n  LocalVocab localVocab{};\n  auto index = ad_utility::testing::makeIndexWithTestSettings();\n\n  // blanknode -> nullopt\n  EXPECT_EQ(idToVc(index, Id::makeFromBlankNodeIndex(BlankNodeIndex::make(0)),\n                   localVocab),\n            std::nullopt);\n\n  EXPECT_EQ(idToVc(index, Id::makeUndefined(), localVocab), \"UNDEF\");\n\n  // simple datatypes -> implicit string representation\n  EXPECT_EQ(idToVc(index, Id::makeFromInt(42), localVocab), \"42\");\n  EXPECT_EQ(idToVc(index, Id::makeFromDouble(3.14), localVocab), \"3.14\");\n  EXPECT_EQ(idToVc(index, Id::makeFromBool(true), localVocab), \"true\");\n\n  // Escape Quotes within literals.\n  auto str = LocalVocabEntry::literalWithoutQuotes(\"a\\\"b\\\"c\", index);\n  EXPECT_EQ(idToVc(index, Id::makeFromLocalVocabIndex(&str), localVocab),\n            \"\\\"a\\\\\\\"b\\\\\\\"c\\\"\");\n\n  // value with xsd-type\n  EXPECT_EQ(\n      idToVc(index, Id::makeFromGeoPoint(GeoPoint(70.5, 130.2)), localVocab)\n          .value(),\n      absl::StrCat(\"\\\"POINT(130.200000 70.500000)\\\"^^<\", GEO_WKT_LITERAL, \">\"));\n}\n\n// ____________________________________________________________________________\nTEST_F(ServiceTest, precomputeSiblingResultDoesNotWorkWithCaching) {\n  auto cleanup =\n      setRuntimeParameterForTest<&RuntimeParameters::cacheServiceResults_>(\n          true);\n  auto service = std::make_shared<Service>(\n      testQec,\n      parsedQuery::Service{\n          {Variable{\"?x\"}, Variable{\"?y\"}},\n          TripleComponent::Iri::fromIriref(\"<http://localhorst/api>\"),\n          \"PREFIX doof: <http://doof.org>\",\n          \"{ }\",\n          true},\n      getResultFunctionFactory(\n          \"http://localhorst:80/api\",\n          \"PREFIX doof: <http://doof.org> SELECT ?x ?y WHERE { }\",\n          genJsonResult({\"x\", \"y\"}, {{\"a\", \"b\"}}),\n          boost::beast::http::status::ok, \"application/sparql-results+json\"));\n\n  auto sibling = std::make_shared<AlwaysFailOperation>(testQec, Variable{\"?x\"});\n\n  EXPECT_NO_THROW(\n      Service::precomputeSiblingResult(sibling, service, true, false));\n  EXPECT_FALSE(service->siblingInfo_.has_value());\n}\n\n// ____________________________________________________________________________\nTEST_F(ServiceTest, precomputeSiblingResultDoesNotWorkWithLimit) {\n  std::array limitsAndOffsets{\n      LimitOffsetClause{1},\n      LimitOffsetClause{std::nullopt, 1},\n      LimitOffsetClause{1, 1},\n  };\n  for (const LimitOffsetClause& limitOffset : limitsAndOffsets) {\n    auto service = std::make_shared<Service>(\n        testQec,\n        parsedQuery::Service{\n            {Variable{\"?x\"}, Variable{\"?y\"}},\n            TripleComponent::Iri::fromIriref(\"<http://localhorst/api>\"),\n            \"PREFIX doof: <http://doof.org>\",\n            \"{ }\",\n            true},\n        getResultFunctionFactory(\n            \"http://localhorst:80/api\",\n            \"PREFIX doof: <http://doof.org> SELECT ?x ?y WHERE { }\",\n            genJsonResult({\"x\", \"y\"}, {{\"a\", \"b\"}}),\n            boost::beast::http::status::ok, \"application/sparql-results+json\"));\n\n    service->applyLimitOffset(limitOffset);\n\n    auto sibling =\n        std::make_shared<AlwaysFailOperation>(testQec, Variable{\"?x\"});\n\n    EXPECT_NO_THROW(\n        Service::precomputeSiblingResult(sibling, service, true, false));\n    EXPECT_FALSE(service->siblingInfo_.has_value());\n  }\n}\n\n// ____________________________________________________________________________\nTEST_F(ServiceTest, precomputeSiblingResult) {\n  auto service = std::make_shared<Service>(\n      testQec,\n      parsedQuery::Service{\n          {Variable{\"?x\"}, Variable{\"?y\"}},\n          TripleComponent::Iri::fromIriref(\"<http://localhorst/api>\"),\n          \"PREFIX doof: <http://doof.org>\",\n          \"{ }\",\n          true},\n      getResultFunctionFactory(\n          \"http://localhorst:80/api\",\n          \"PREFIX doof: <http://doof.org> SELECT ?x ?y { }\",\n          genJsonResult({\"x\", \"y\"}, {{\"a\", \"b\"}}),\n          boost::beast::http::status::ok, \"application/sparql-results+json\"));\n\n  auto service2 = std::make_shared<Service>(*service);\n\n  // Adaptation of the Values class, allowing to compute lazy Results.\n  class MockValues : public Values {\n   public:\n    MockValues(QueryExecutionContext* qec,\n               parsedQuery::SparqlValues parsedValues)\n        : Operation{qec}, Values(qec, parsedValues) {}\n\n    Result computeResult([[maybe_unused]] bool requestLaziness) override {\n      Result res = Values::computeResult(false);\n\n      if (!requestLaziness) {\n        return Result(Result::IdTableVocabPair(res.cloneIdTable(),\n                                               res.localVocab().clone()),\n                      res.sortedBy());\n      }\n\n      // yield each row individually\n      return {[&](IdTable clone) -> Result::Generator {\n                IdTable idt{clone.numColumns(),\n                            ad_utility::makeUnlimitedAllocator<IdTable>()};\n                for (size_t i = 0; i < clone.size(); ++i) {\n                  idt.push_back(clone[i]);\n                  Result::IdTableVocabPair pair{std::move(idt), LocalVocab{}};\n                  co_yield pair;\n                  idt.clear();\n                }\n              }(res.cloneIdTable()),\n              res.sortedBy()};\n    }\n  };\n\n  auto iri = ad_utility::testing::iri;\n  using TC = TripleComponent;\n  auto siblingOperation = std::make_shared<MockValues>(\n      testQec, parsedQuery::SparqlValues{{Variable{\"?x\"}, Variable{\"?y\"}},\n                                         {{TC(iri(\"<x>\")), TC(iri(\"<y>\"))},\n                                          {TC(iri(\"<z>\")), TC(iri(\"<a>\"))}}});\n  auto sibling = std::make_shared<Sort>(\n      testQec, std::make_shared<QueryExecutionTree>(testQec, siblingOperation),\n      std::vector<ColumnIndex>{});\n\n  // Reset the computed results, to reuse the mock-operations.\n  auto reset = [&]() {\n    service->siblingInfo_.reset();\n    service2->precomputedResultBecauseSiblingOfService().reset();\n    siblingOperation->precomputedResultBecauseSiblingOfService().reset();\n    testQec->clearCacheUnpinnedOnly();\n  };\n\n  // Right requested but it is not a Service -> no computation\n  Service::precomputeSiblingResult(service, sibling, true, false);\n  EXPECT_FALSE(\n      siblingOperation->precomputedResultBecauseSiblingOfService().has_value());\n  EXPECT_FALSE(service->siblingInfo_.has_value());\n  EXPECT_FALSE(service->precomputedResultBecauseSiblingOfService().has_value());\n  reset();\n\n  // Two Service operations -> no computation\n  Service::precomputeSiblingResult(service, service2, false, false);\n  EXPECT_FALSE(\n      service2->precomputedResultBecauseSiblingOfService().has_value());\n  EXPECT_FALSE(service->siblingInfo_.has_value());\n  EXPECT_FALSE(service->precomputedResultBecauseSiblingOfService().has_value());\n  reset();\n\n  // Right requested and two Service operations -> compute\n  Service::precomputeSiblingResult(service, service2, true, false);\n  EXPECT_TRUE(service2->precomputedResultBecauseSiblingOfService().has_value());\n  EXPECT_TRUE(service->siblingInfo_.has_value());\n  EXPECT_FALSE(service->precomputedResultBecauseSiblingOfService().has_value());\n  reset();\n\n  // Right requested and it is a service -> sibling result is computed and\n  // shared with service\n  Service::precomputeSiblingResult(sibling, service, true, false);\n  ASSERT_TRUE(\n      siblingOperation->precomputedResultBecauseSiblingOfService().has_value());\n  EXPECT_TRUE(siblingOperation->precomputedResultBecauseSiblingOfService()\n                  .value()\n                  ->isFullyMaterialized());\n  EXPECT_TRUE(service->siblingInfo_.has_value());\n  EXPECT_FALSE(service->precomputedResultBecauseSiblingOfService().has_value());\n  reset();\n\n  // Compute (large) sibling -> sibling result is computed\n  const auto maxValueRowsDefault =\n      getRuntimeParameter<&RuntimeParameters::serviceMaxValueRows_>();\n  setRuntimeParameter<&RuntimeParameters::serviceMaxValueRows_>(0);\n  Service::precomputeSiblingResult(sibling, service, true, false);\n  ASSERT_TRUE(\n      siblingOperation->precomputedResultBecauseSiblingOfService().has_value());\n  EXPECT_TRUE(siblingOperation->precomputedResultBecauseSiblingOfService()\n                  .value()\n                  ->isFullyMaterialized());\n  EXPECT_FALSE(service->siblingInfo_.has_value());\n  EXPECT_FALSE(service->precomputedResultBecauseSiblingOfService().has_value());\n  setRuntimeParameter<&RuntimeParameters::serviceMaxValueRows_>(\n      maxValueRowsDefault);\n  reset();\n\n  // Lazy compute (small) sibling -> sibling result is fully materialized and\n  // shared with service\n  Service::precomputeSiblingResult(service, sibling, false, true);\n  ASSERT_TRUE(\n      siblingOperation->precomputedResultBecauseSiblingOfService().has_value());\n  EXPECT_TRUE(siblingOperation->precomputedResultBecauseSiblingOfService()\n                  .value()\n                  ->isFullyMaterialized());\n  EXPECT_TRUE(service->siblingInfo_.has_value());\n  EXPECT_FALSE(service->precomputedResultBecauseSiblingOfService().has_value());\n  reset();\n\n  // Lazy compute (large) sibling -> partially materialized result is passed\n  // back to sibling\n  setRuntimeParameter<&RuntimeParameters::serviceMaxValueRows_>(0);\n  Service::precomputeSiblingResult(service, sibling, false, true);\n  ASSERT_TRUE(\n      siblingOperation->precomputedResultBecauseSiblingOfService().has_value());\n  EXPECT_FALSE(siblingOperation->precomputedResultBecauseSiblingOfService()\n                   .value()\n                   ->isFullyMaterialized());\n  EXPECT_FALSE(service->siblingInfo_.has_value());\n  EXPECT_FALSE(service->precomputedResultBecauseSiblingOfService().has_value());\n  setRuntimeParameter<&RuntimeParameters::serviceMaxValueRows_>(\n      maxValueRowsDefault);\n\n  // consume the sibling result-generator\n  for ([[maybe_unused]] auto& _ :\n       siblingOperation->precomputedResultBecauseSiblingOfService()\n           .value()\n           ->idTables()) {\n  }\n}\n\n// ____________________________________________________________________________\nTEST_F(ServiceTest, clone) {\n  Service service{\n      testQec,\n      parsedQuery::Service{\n          {Variable{\"?x\"}, Variable{\"?y\"}},\n          TripleComponent::Iri::fromIriref(\"<http://localhorst/api>\"),\n          \"PREFIX doof: <http://doof.org>\",\n          \"{ }\",\n          true},\n      getResultFunctionFactory(\n          \"http://localhorst:80/api\",\n          \"PREFIX doof: <http://doof.org> SELECT ?x ?y WHERE { }\",\n          genJsonResult({\"x\", \"y\"}, {{\"a\", \"b\"}}),\n          boost::beast::http::status::ok, \"application/sparql-results+json\")};\n\n  auto clone = service.clone();\n  ASSERT_TRUE(clone);\n  EXPECT_THAT(service, IsDeepCopy(*clone));\n  EXPECT_EQ(clone->getDescriptor(), service.getDescriptor());\n}\n\n// _____________________________________________________________________________\nTEST_F(ServiceTest, serviceAllowedIriPrefixes) {\n  parsedQuery::Service parsedServiceClause{\n      {Variable{\"?x\"}, Variable{\"?y\"}},\n      TripleComponent::Iri::fromIriref(\"<http://localhost/api>\"),\n      \"PREFIX doof: <http://doof.org>\",\n      \"{ }\",\n      false};\n  parsedQuery::Service parsedServiceClauseSilent{\n      {Variable{\"?x\"}, Variable{\"?y\"}},\n      TripleComponent::Iri::fromIriref(\"<http://localhost/api>\"),\n      \"PREFIX doof: <http://doof.org>\",\n      \"{ }\",\n      true};\n\n  std::string_view expectedUrl = \"http://localhost:80/api\";\n  std::string_view expectedSparqlQuery =\n      \"PREFIX doof: <http://doof.org> SELECT ?x ?y { }\";\n  auto result = genJsonResult({\"x\", \"y\"}, {{\"a\", \"b\"}});\n\n  auto makeService = [&](const parsedQuery::Service& clause) {\n    return Service{\n        testQec, clause,\n        getResultFunctionFactory(expectedUrl, expectedSparqlQuery, result)};\n  };\n\n  // With an empty whitelist (default), all URLs should be allowed.\n  {\n    auto cleanup = setRuntimeParameterForTest<\n        &RuntimeParameters::serviceAllowedIriPrefixes_>(\n        std::vector<std::string>{});\n    auto s = makeService(parsedServiceClause);\n    EXPECT_NO_THROW(s.computeResultOnlyForTesting());\n  }\n\n  // With a matching prefix, the IRI should be allowed.\n  {\n    auto cleanup = setRuntimeParameterForTest<\n        &RuntimeParameters::serviceAllowedIriPrefixes_>(\n        std::vector<std::string>{\"http://localhost/\"});\n    auto s = makeService(parsedServiceClause);\n    EXPECT_NO_THROW(s.computeResultOnlyForTesting());\n  }\n\n  // With a non-matching prefix, the IRI should be rejected.\n  {\n    auto cleanup = setRuntimeParameterForTest<\n        &RuntimeParameters::serviceAllowedIriPrefixes_>(\n        std::vector<std::string>{\"http://example.org/\"});\n    auto s = makeService(parsedServiceClause);\n    AD_EXPECT_THROW_WITH_MESSAGE(s.computeResultOnlyForTesting(),\n                                 ::testing::HasSubstr(\"not allowed\"));\n  }\n\n  // With SILENT keyword, the rejected URL should be silenced.\n  {\n    auto cleanup = setRuntimeParameterForTest<\n        &RuntimeParameters::serviceAllowedIriPrefixes_>(\n        std::vector<std::string>{\"http://example.org/\"});\n    auto s = makeService(parsedServiceClauseSilent);\n    EXPECT_NO_THROW(s.computeResultOnlyForTesting());\n  }\n\n  // With multiple prefixes, matching any should allow.\n  {\n    auto cleanup = setRuntimeParameterForTest<\n        &RuntimeParameters::serviceAllowedIriPrefixes_>(\n        std::vector<std::string>{\"http://example.org/\", \"http://localhost/\"});\n    auto s = makeService(parsedServiceClause);\n    EXPECT_NO_THROW(s.computeResultOnlyForTesting());\n  }\n\n  // With multiple prefixes, none matching should reject.\n  {\n    auto cleanup = setRuntimeParameterForTest<\n        &RuntimeParameters::serviceAllowedIriPrefixes_>(\n        std::vector<std::string>{\"http://example.org/\", \"http://other.org/\"});\n    auto s = makeService(parsedServiceClause);\n    AD_EXPECT_THROW_WITH_MESSAGE(s.computeResultOnlyForTesting(),\n                                 ::testing::HasSubstr(\"not allowed\"));\n  }\n}\n\n// Test that a `Service` operation correctly passes the `maxRedirects` parameter\n// to the HTTP client. The actual redirect handling is tested in `HttpTest.cpp`.\nTEST_F(ServiceTest, redirectsIntegration) {\n  parsedQuery::Service parsedServiceClause{\n      {Variable{\"?x\"}, Variable{\"?y\"}},\n      TripleComponent::Iri::fromIriref(\"<http://example.com/api>\"),\n      \"\",\n      \"{ }\",\n      false};\n  auto result = genJsonResult({\"x\", \"y\"}, {{\"a\", \"b\"}});\n\n  // Test with default setting for `maxRedirects`, which is 1.\n  {\n    httpClientTestHelpers::RequestMatchers matchers{.maxRedirects_ =\n                                                        testing::Eq(1)};\n    Service service{testQec, parsedServiceClause,\n                    httpClientTestHelpers::getResultFunctionFactory(\n                        result, \"application/sparql-results+json\",\n                        boost::beast::http::status::ok, matchers)};\n    EXPECT_NO_THROW(service.computeResultOnlyForTesting());\n  }\n\n  // Test with custom setting for `maxRedirects`.\n  {\n    auto cleanup =\n        setRuntimeParameterForTest<&RuntimeParameters::serviceMaxRedirects_>(5);\n    httpClientTestHelpers::RequestMatchers matchers{.maxRedirects_ =\n                                                        testing::Eq(5)};\n    Service service{testQec, parsedServiceClause,\n                    httpClientTestHelpers::getResultFunctionFactory(\n                        result, \"application/sparql-results+json\",\n                        boost::beast::http::status::ok, matchers)};\n    EXPECT_NO_THROW(service.computeResultOnlyForTesting());\n  }\n}\n";


const upstreamMaterializedViewsHeaderFixture = `class MaterializedView : public std::enable_shared_from_this<MaterializedView> {
 private:
  std::string onDiskBase_;
  std::string name_;
  std::optional<std::string> originalQuery_;
  std::optional<ParsedQuery> parsedQuery_;

 public:
  const VariableToColumnMap& variableToColumnMap() const {
    return varToColMap_;
  }

  // Get the original query string used for writing the view.
  const std::optional<std::string>& originalQuery() const {
    return originalQuery_;
  }

  // Get a parsed version of the original query, used for query analysis.
  const std::optional<ParsedQuery>& parsedQuery() const { return parsedQuery_; }

  // Return the combined filename from the index' \`onDiskBase\` and the name of
  // the view. Note that this function does not check for validity or existence.
  static std::string getFilenameBase(std::string_view onDiskBase,
                                     std::string_view name);
};
`;

const upstreamServerHeaderFixture = `class Server {
 private:
  qlever::Qlever qlever_;

  // Given a name and query, compute the query result and write a new
  // materialized view of this result to disk. This assumes that the access
  // token has already been checked.
  void writeMaterializedView(
      const std::string& name,
      const ad_utility::url_parser::sparqlOperation::Query& query,
      const ad_utility::Timer& requestTimer,
      ad_utility::SharedCancellationHandle cancellationHandle,
      TimeLimit timeLimit);
  FRIEND_TEST(MaterializedViewsTest, serverIntegration);

  // Trigger an index rebuild with \`indexBaseName\` as the base name for the new
  // index. This assumes that the access token has already been checked and no
  // other build is currently in progress.
  Awaitable<void> rebuildIndex(const std::string& indexBaseName);
};
`;

const upstreamMaterializedViewsTestFixture = `  // View with no parsed query is skipped by \`QueryPatternCache::analyzeView\`.
  {
    qlv().writeMaterializedView("testView7", simpleWriteQuery_);
    auto view = std::make_shared<MaterializedView>(testIndexBase_, "testView7");
    view->parsedQuery_ = std::nullopt;
    materializedViewsQueryAnalysis::QueryPatternCache c;
    EXPECT_FALSE(c.analyzeView(view));
  }

// _____________________________________________________________________________
TEST_F(MaterializedViewsTest, serverIntegration) {
  // Write a new materialized view using the \`writeMaterializedView\` method of
  // the \`Server\` class.
  {
    // Initialize but do not start a \`Server\` instance on our test index.
    Server server{4321, 1, "accessToken", config};

    ad_utility::url_parser::sparqlOperation::Query query{simpleWriteQuery_, {}};
    ad_utility::Timer requestTimer{ad_utility::Timer::InitialStatus::Started};
    auto cancellationHandle =
        std::make_shared<ad_utility::CancellationHandle<>>();
    static constexpr size_t dummyTimeLimit = 1000 * 60 * 60;  // 1 hour
    std::chrono::milliseconds timeLimit{dummyTimeLimit};
    server.writeMaterializedView("testViewFromServer", query, requestTimer,
                                 cancellationHandle, timeLimit);
  }

  // Test the preloading of materialized views on server start.
  {
    config.persistUpdates_ = false;
    config.preloadMaterializedViews_ = {"testViewForServerPreload"};
    qlv().writeMaterializedView("testViewForServerPreload", simpleWriteQuery_);
    Server server{4321, 1, "accessToken", config};
    EXPECT_TRUE(server.qlever_.materializedViewsManager()->isViewLoaded(
        "testViewForServerPreload"));
  }

  // Try loading the new view.
}
`;




const upstreamParsedRequestBuilderHeaderFixture = `struct ParsedRequestBuilder {
  FRIEND_TEST(ParsedRequestBuilderTest, extractTargetGraph);
  FRIEND_TEST(ParsedRequestBuilderTest, determineAccessToken);
  FRIEND_TEST(ParsedRequestBuilderTest, parameterIsContainedExactlyOnce);

  using RequestType =
      boost::beast::http::request<boost::beast::http::string_body>;

  ad_utility::url_parser::ParsedRequest parsedRequest_;
  std::optional<std::string> host_ = std::nullopt;

  explicit ParsedRequestBuilder(const RequestType& request);
  void extractAccessToken(const RequestType& request);

  // Returns whether the request is a Graph Store operation.
  bool isGraphStoreOperationIndirect() const;
  bool isGraphStoreOperationDirect() const;

  // Set the operation to the parsed Graph Store operation.
  void extractGraphStoreOperationIndirect();
  void extractGraphStoreOperationDirect();

  // Returns whether the parameters contain a parameter with the given key.
  bool parametersContain(std::string_view param) const;

  // Check that requests don't both have these content types and are Graph
  // Store operations.
  void reportUnsupportedContentTypeIfGraphStore(
      std::string_view contentType) const;

  // Move the \`ParsedRequest\` out when parsing is finished.
  ad_utility::url_parser::ParsedRequest build() &&;

 private:
  // Adds a dataset clause to the operation if it is of the given type. The
  // dataset clause's IRI is the value of parameter \`key\`. The \`isNamed_\` of the
  // dataset clause is as given.
  template <typename Operation>
  void extractDatasetClauseIfOperationIs(const std::string& key, bool isNamed);

  // Check that a parameter is contained exactly once. An exception is thrown if
  // a parameter is contained more than once.
  bool parameterIsContainedExactlyOnce(std::string_view key) const;

  // Extract the graph to be acted upon using from the URL query parameters
  // (\`Indirect Graph Identification\`). See
  // https://www.w3.org/TR/2013/REC-sparql11-http-rdf-update-20130321/#indirect-graph-identification
  static GraphOrDefault extractTargetGraph(
      const ad_utility::url_parser::ParamValueMap& params);

  // Determine the access token from the parameters and the requests
  // Authorization header.
  static std::optional<std::string> determineAccessToken(
      const RequestType& request,
      const ad_utility::url_parser::ParamValueMap& params);
};
`;

const upstreamSparqlProtocolHeaderFixture = `class SparqlProtocol {
  FRIEND_TEST(SparqlProtocolTest, parseGET);
  FRIEND_TEST(SparqlProtocolTest, parseUrlencodedPOST);
  FRIEND_TEST(SparqlProtocolTest, parseQueryPOST);
  FRIEND_TEST(SparqlProtocolTest, parseUpdatePOST);
  FRIEND_TEST(SparqlProtocolTest, parsePOST);
  FRIEND_TEST(SparqlProtocolTest, parseGraphStoreProtocolIndirect);
  FRIEND_TEST(SparqlProtocolTest, parseGraphStoreProtocolDirect);

  static constexpr std::string_view contentTypeUrlEncoded =
      "application/x-www-form-urlencoded";
  static constexpr std::string_view contentTypeSparqlQuery =
      "application/sparql-query";
  static constexpr std::string_view contentTypeSparqlUpdate =
      "application/sparql-update";

  using RequestType = ParsedRequestBuilder::RequestType;

  // Parse an HTTP GET request into a \`ParsedRequest\`. The
  // \`ParsedRequestBuilder\` must have already extracted the access token.
  static ad_utility::url_parser::ParsedRequest parseGET(
      const RequestType& request);

  // Parse an HTTP POST request with content-type
  // \`application/x-www-form-urlencoded\` into a \`ParsedRequest\`.
  static ad_utility::url_parser::ParsedRequest parseUrlencodedPOST(
      const RequestType& request);

  // Parse an HTTP POST request with a SPARQL operation in its body
  // into a \`ParsedRequest\`. This is used for the content types
  // \`application/sparql-query\` and \`application/sparql-update\`.
  template <typename Operation>
  static ad_utility::url_parser::ParsedRequest parseSPARQLPOST(
      const RequestType& request, std::string_view contentType);

  // Parse an HTTP POST request into a \`ParsedRequest\`.
  static ad_utility::url_parser::ParsedRequest parsePOST(
      const RequestType& request);

  // Parse a Graph Store Protocol request with direct or indirect graph
  // identification.
  static ad_utility::url_parser::ParsedRequest parseGraphStoreProtocolIndirect(
      const RequestType& request);
  static ad_utility::url_parser::ParsedRequest parseGraphStoreProtocolDirect(
      const RequestType& request);

 public:
  // Parse a HTTP request.
  static ad_utility::url_parser::ParsedRequest parseHttpRequest(
      RequestType& request);
};
`;

const upstreamIndexImplHeaderFixture = `class IndexImpl {
  using TextVec = ad_utility::CompressedExternalIdTableSorter<SortText, 5>;

  struct IndexMetaDataMmapDispatcher {
    using WriteType = IndexMetaDataMmap;
    using ReadType = IndexMetaDataMmapView;
  };

  using NumNormalAndInternal = Index::NumNormalAndInternal;

  // Private data members.
 protected:
  std::string onDiskBase_;
  std::string settingsFileName_;
  bool onlyAsciiTurtlePrefixes_ = false;
  nlohmann::json configurationJson_;
  double avgNumDistinctPredicatesPerSubject_;
  double avgNumDistinctSubjectsPerPredicate_;
  uint64_t numDistinctSubjectPredicatePairs_;
  NumNormalAndInternal numSubjects_;
  NumNormalAndInternal numObjects_;
};
`;

const upstreamGraphNameManagerHeaderFixture = `// Generates new graphs with a fixed prefix that don't exist yet. Currently,
// the graphs are of the form \`{prefix}/{ascending number}\`.
// NOTE: this is currently not actively used.
class GraphNameManager {
  std::string prefixWithoutBraces_ = std::string(QLEVER_NEW_GRAPH_PREFIX);
  // The smallest number such that the graph for this number and all after it
  // are not used. Graphs that are generated are not necessarily all used so
  // there may be "gaps" in the actually used graphs.
  ad_utility::CopyableAtomic<uint64_t> nextUnallocatedGraph_ = 1;

  // File where the state is persisted to.
  std::optional<std::filesystem::path> filenameForPersisting_;

  FRIEND_TEST(GraphNameManager, storeAndRestoreData);
  FRIEND_TEST(GraphNameManager, readFromDisk);
  FRIEND_TEST(IndexImpl, graphNameManagerIntegration);

 public:
  GraphNameManager() = default;
};
`;

const upstreamLocatedTriplesHeaderFixture = `// Sorted sets of located triples, grouped by block. We use this to store all
// located triples for a permutation.
class LocatedTriplesPerBlock {
 private:
  // The total number of \`LocatedTriple\` objects stored (for all blocks).
  size_t numTriples_ = 0;

  // For each block with a non-empty set of located triples, the located triples
  // in that block.
  ad_utility::HashMap<size_t, LocatedTriples> map_;

  FRIEND_TEST(LocatedTriplesTest, numTriplesInBlock);

  // Implementation of the \`mergeTriples\` function (which has \`numIndexColumns\`
  // as a normal argument, and translates it into a template argument).
  template <size_t numIndexColumns, bool includeGraphColumn>
  IdTable mergeTriplesImpl(size_t blockIndex, const IdTable& block) const;

 public:
  void updateAugmentedMetadata();
};
`;

const upstreamDeltaTriplesHeaderFixture = `class DeltaTriples {
 public:
  using Triples = std::vector<IdTriple<0>>;
  using CancellationHandle = ad_utility::SharedCancellationHandle;

 private:
  // The index to which these triples are added.
  const IndexImpl& index_;

  LocalVocab localVocab_;

  template <bool isInternal>
  struct TriplesToHandles {
    TriplesToHandlesMap triplesInserted_;
    TriplesToHandlesMap triplesDeleted_;
  };

  TriplesToHandles<false> triplesToHandlesNormal_;
  TriplesToHandles<true> triplesToHandlesInternal_;

 public:
  explicit DeltaTriples(const IndexImpl& index);

  // Disable accidental copying.
  DeltaTriples(const DeltaTriples&) = delete;
  DeltaTriples& operator=(const DeltaTriples&) = delete;

  // Get the common \`LocalVocab\` of the delta triples.
 private:
  LocalVocab& localVocab() { return localVocab_; }

 public:
  const LocalVocab& localVocab() const { return localVocab_; }

#ifndef QLEVER_REDUCED_FEATURE_SET_FOR_CPP17
  // Compute the diff between \`oldState\` (the snapshot used to start the index
  // rebuild) and \`newState\` (the current snapshot), remap the IDs using
  // \`idMapping\`, and add the resulting triples to this \`DeltaTriples\` instance.
  void addFromSnapshotDiff(
      const LocatedTriplesState& oldState, const LocatedTriplesState& newState,
      const qlever::indexRebuilder::IndexRebuildMapping& idMapping,
      CancellationHandle cancellationHandle,
      ad_utility::timer::TimeTracer& tracer);

 private:
  // Remap the \`Id\` from the old index to the new index using the given
  // \`idMapping\`. If the \`Id\` can't be remapped, this means that it was added
  // after the mapping was created and will be left unchanged.
  static void remapId(
      const qlever::indexRebuilder::IndexRebuildMapping& idMapping, Id& id);
#endif

 private:
  // The proper state according to the template parameter. This will either
  // return a reference to \`triplesToHandlesInternal_\` or
  // \`triplesToHandlesNormal_\`.
  template <bool isInternal>
  TriplesToHandles<isInternal>& getState();

  void rewriteLocalVocabEntriesAndBlankNodes(Triples& triples);
  FRIEND_TEST(DeltaTriplesTest, rewriteLocalVocabEntriesAndBlankNodes);
};

// This class synchronizes the access to a \`DeltaTriples\` object, thus avoiding
// race conditions between concurrent updates and queries.
class DeltaTriplesManager {
  ad_utility::Synchronized<DeltaTriples> deltaTriples_;
  ad_utility::Synchronized<LocatedTriplesSharedState, std::shared_mutex>
      currentLocatedTriplesSharedState_;

 public:
  using CancellationHandle = DeltaTriples::CancellationHandle;
  using Triples = DeltaTriples::Triples;
};
`;

const upstreamLocalVocabEntryHeaderFixture = `class alignas(16) LocalVocabEntry
    : public ad_utility::triple_component::LiteralOrIri {
 public:
  using Base = ad_utility::triple_component::LiteralOrIri;

  static constexpr ad_utility::IndexTag proxyTag = "LveIdProxy";
  using IdProxy = ad_utility::TypedIndex<uint64_t, proxyTag>;

  FRIEND_TEST(TripleComponent, toValueId);

 private:
  // Pointer to keep this object assignable.
  const LocalVocabContext* context_;
  // The cache for the position in the vocabulary. As usual, the \`lowerBound\` is
  // inclusive, the \`upperBound\` is not, so if \`lowerBound == upperBound\`, then
  // the entry is not part of the globalVocabulary, and \`lowerBound\` points to
  // the first *larger* word in the vocabulary. Note: we store the cache as
  // three separate atomics to avoid mutexes. The downside is, that in parallel
  // code multiple threads might look up the position concurrently, which wastes
  // a bit of resources. However, we don't consider this case to be likely.
  mutable ad_utility::CopyableAtomic<IdProxy> lowerBoundInVocab_;
  mutable ad_utility::CopyableAtomic<IdProxy> upperBoundInVocab_;
  mutable ad_utility::CopyableAtomic<bool> positionInVocabKnown_ = false;

 public:
  LocalVocabEntry(const LocalVocabEntry&) = default;
};
`;


const upstreamExecuteUpdateHeaderFixture = `class ExecuteUpdate {
 public:
  using CancellationHandle = ad_utility::SharedCancellationHandle;
  using IdOrVariableIndex = std::variant<Id, ColumnIndex>;
  using TransformedTriple = std::array<IdOrVariableIndex, 4>;

  // Execute an update. This function is comparable to
  // \`ExportQueryExecutionTrees::computeResult\` for queries.
  static UpdateMetadata executeUpdate(
      const Index& index, const ParsedQuery& query,
      const QueryExecutionTree& qet, DeltaTriples& deltaTriples,
      const CancellationHandle& cancellationHandle,
      ad_utility::timer::TimeTracer& tracer =
          ad_utility::timer::DEFAULT_TIME_TRACER);

 private:
  // Resolve all \`TripleComponent\`s and \`Graph\`s in a vector of
  // \`SparqlTripleSimpleWithGraph\` into \`Variable\`s or \`Id\`s.
  static std::pair<std::vector<ExecuteUpdate::TransformedTriple>, LocalVocab>
  transformTriplesTemplate(
      const IndexImpl& index, const VariableToColumnMap& variableColumns,
      const std::vector<SparqlTripleSimpleWithGraph>& triples);
  FRIEND_TEST(ExecuteUpdate, transformTriplesTemplate);

  struct IdTriplesAndLocalVocab {
    std::vector<IdTriple<>> idTriples_;
    LocalVocab localVocab_;
  };
  static std::pair<IdTriplesAndLocalVocab, IdTriplesAndLocalVocab>
  computeGraphUpdateQuads(const Index& index, const ParsedQuery& query,
                          const Result& result,
                          const VariableToColumnMap& variableColumns,
                          const CancellationHandle& cancellationHandle,
                          UpdateMetadata& metadata,
                          ad_utility::timer::TimeTracer& tracer =
                              ad_utility::timer::DEFAULT_TIME_TRACER);
};
`;


const upstreamGraphStoreProtocolHeaderFixture = `// Transform SPARQL Graph Store Protocol requests to their equivalent
// ParsedQuery (SPARQL Query or Update).
class GraphStoreProtocol {
 private:
  // Extract the mediatype from a request.
  CPP_template_2(typename RequestT)(requires ad_utility::httpUtils::HttpRequest<
                                    RequestT>) static ad_utility::MediaType
      extractMediatype(const RequestT& rawRequest) {
    return {};
  }

 public:
  // Every Graph Store Protocol request has equivalent SPARQL Query or Update.
  static std::vector<ParsedQuery> transformGraphStoreProtocol();
};
`;

describe('QLever upstream IndexScan patch asset', () => {
  it('applies to the upstream-shaped IndexScan source and only preserves QLever fallback when no Xpod index is injected', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'xpod-qlever-indexscan-patch-'));
    try {
      const qleverSource = path.join(root, 'qlever');
      const { indexScanPath, indexScanHeaderPath } = await writeIndexScanPatchFixtures(qleverSource);

      execFileSync('node', [
        patchScript,
        '--qlever-source',
        qleverSource,
        '--patch',
        patchPath,
        '--apply',
      ], { stdio: 'pipe' });
      execFileSync('node', [
        patchScript,
        '--qlever-source',
        qleverSource,
        '--patch',
        nativeValueOrderPatchPath,
        '--apply',
      ], { stdio: 'pipe' });

      const patched = await readFile(indexScanPath, 'utf8');
      const patchedHeader = await readFile(indexScanHeaderPath, 'utf8');
      expect(patched).toContain('"XpodQleverPhysicalIndexScanContextBridge.hpp"');
      expect(patchedHeader).toContain('xpodPhysicalBlockMetadata_');
      expect(patchedHeader).toContain('xpodPhysicalBlockMetadataVersion_');
      expect(patched).toContain('xpod::qlever::physicalIndexFromContext(*_executionContext) != nullptr');
      expect(patched).toContain(
        'if (xpod::qlever::physicalIndexFromContext(*_executionContext) != nullptr) {\n    return {};\n  }',
      );
      expect(patched).toContain('xpod::qlever::materializedScanFromQleverScanSpecAndBlocks');
      expect(patched).toContain('xpod::qlever::qleverPhysicalScanLimitOffset(getLimitOffset())');
      expect(patched).toContain('xpodIndexScanProjectedSlots(');
      expect(patched).toContain('auto xpodNeededSlots = xpodIndexScanProjectedSlots(');
      expect(patched).toContain('scanSpecAndBlocks_,\n            getPermutedTriple(),\n            xpodNeededSlots');
      expect(patched).toContain('xpodLimitOffset.limit, xpodLimitOffset.offset');
      expect(patched).toContain('xpodMaterializedScan.status != XPOD_RDF_STATUS_OK');
      expect(patched).toContain('xpodThrowPhysicalScanStatus("materialized scan", xpodMaterializedScan.status);');
      expect(patched).not.toContain('AD_CONTRACT_CHECK(xpodMaterializedScan.status == XPOD_RDF_STATUS_OK);');
      expect(patched).toContain('xpod::qlever::sizeEstimateFromQleverScanSpecAndBlocks');
      expect(patched).toContain('AD_CONTRACT_CHECK(xpodSizeEstimate.status == XPOD_RDF_STATUS_OK);');
      expect(patched).toContain('xpod::qlever::exactSizeFromQleverScanSpecAndBlocks');
      expect(patched).toContain('xpodExactSize.status == XPOD_RDF_STATUS_OK');
      expect(patched).toContain('AD_CONTRACT_CHECK(xpodExactSize.status == XPOD_RDF_STATUS_OK);');
      expect(patched).toContain('xpod::qlever::multiplicitiesFromQleverScanSpecAndBlocks');
      expect(patched).toContain('xpodMultiplicities.status == XPOD_RDF_STATUS_OK');
      expect(patched).toContain('AD_CONTRACT_CHECK(xpodMultiplicities.status == XPOD_RDF_STATUS_OK);');
      expect(patched).toContain('xpod::qlever::canUsePhysicalScanSpecAndBlocks');
      expect(patched).toContain('BlockMetadataRanges{}');
      expect(patched).toContain('xpod::qlever::lazyScanRangeFromQleverScanSpecAndBlocks');
      expect(patched).toContain('xpod::qlever::metadataForScanFromQleverScanSpecAndBlocks');
      expect(patched).toContain(
        'xpodPhysicalBlockMetadataVersion_ =\n        xpodMetadata.metadata_version_storage;',
      );
      expect(patched).toContain(
        'xpod_rdf_bytes{xpodPhysicalBlockMetadataVersion_.data(),',
      );
      expect(patched).toContain(
        'xpodPhysicalBlockMetadataVersion_.size()}',
      );
      expect(patched).toContain('!scanSpecAndBlocksIsPrefiltered_');
      expect(patched).toContain('xpodLazyScan.status != XPOD_RDF_STATUS_OK');
      expect(patched).not.toContain(`XPOD_RDF_SLOT_SUBJECT | XPOD_RDF_SLOT_PREDICATE |
                XPOD_RDF_SLOT_OBJECT,
            xpod_rdf_bytes{}`);
      expect(patched).toContain('xpodThrowPhysicalScanStatus("lazy scan", xpodLazyScan.status);');
      expect(patched).not.toContain('AD_CONTRACT_CHECK(xpodLazyScan.status == XPOD_RDF_STATUS_OK);');
      expect(patched).toContain('permutation().getSizeEstimateForScan(');
      expect(patched).toContain('permutation().getResultSizeOfScan(');
      expect(patched).toContain('idx.getMultiplicities(permutation())');
      expect(patched).toContain('permutation().getScanSpecAndBlocks(');
      expect(patched).toContain('permutation().scan(');
      expect(patched).toContain('permutation().lazyScan(');
      expect(patched).toContain('permutation().getMetadataAndBlocks(');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('accepts an already patched IndexScan source as valid', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'xpod-qlever-indexscan-patched-'));
    try {
      const qleverSource = path.join(root, 'qlever');
      await writeIndexScanPatchFixtures(qleverSource);

      execFileSync('node', [
        patchScript,
        '--qlever-source',
        qleverSource,
        '--patch',
        patchPath,
        '--apply',
      ], { stdio: 'pipe' });
      execFileSync('node', [
        patchScript,
        '--qlever-source',
        qleverSource,
        '--patch',
        patchPath,
      ], { stdio: 'pipe' });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('patches GraphFilter with a physical-scope accessor', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'xpod-qlever-graph-filter-patch-'));
    try {
      const qleverSource = path.join(root, 'qlever');
      const graphFilterPath = path.join(qleverSource, 'src/index/GraphFilter.h');
      await mkdir(path.dirname(graphFilterPath), { recursive: true });
      await writeFile(graphFilterPath, upstreamGraphFilterFixture, 'utf8');

      execFileSync('node', [
        patchScript,
        '--qlever-source',
        qleverSource,
        '--patch',
        graphFilterPatchPath,
        '--apply',
      ], { stdio: 'pipe' });

      const patched = await readFile(graphFilterPath, 'utf8');
      expect(patched).toContain('const FilterType& xpodPhysicalFilterType() const');
      expect(patched).toContain('return filter_;');
      expect(patched).toContain('without consulting QLever');
      expect(patched).toContain('bool areAllGraphsAllowed() const;');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('patches ScanSpecification with a physical local-vocab accessor', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'xpod-qlever-scan-spec-patch-'));
    try {
      const qleverSource = path.join(root, 'qlever');
      const scanSpecificationPath = path.join(qleverSource, 'src/index/ScanSpecification.h');
      await mkdir(path.dirname(scanSpecificationPath), { recursive: true });
      await writeFile(scanSpecificationPath, upstreamScanSpecificationFixture, 'utf8');

      execFileSync('node', [
        patchScript,
        '--qlever-source',
        qleverSource,
        '--patch',
        scanSpecificationPatchPath,
        '--apply',
      ], { stdio: 'pipe' });

      const patched = await readFile(scanSpecificationPath, 'utf8');
      expect(patched).toContain('const LocalVocab& xpodPhysicalLocalVocab() const');
      expect(patched).toContain('return *localVocab_;');
      expect(patched).toContain('graph filters from FROM clauses');
      expect(patched).toContain('size_t firstFreeColIndex() const');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('patches ExistsJoin with a narrow upstream-test accessor', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'xpod-qlever-exists-join-accessor-'));
    try {
      const qleverSource = path.join(root, 'qlever');
      const existsJoinPath = path.join(qleverSource, 'src/engine/ExistsJoin.h');
      await mkdir(path.dirname(existsJoinPath), { recursive: true });
      await writeFile(existsJoinPath, upstreamExistsJoinHeaderFixture, 'utf8');

      execFileSync('node', [
        patchScript,
        '--qlever-source',
        qleverSource,
        '--patch',
        existsJoinAccessorPatchPath,
        '--apply',
      ], { stdio: 'pipe' });

      const patched = await readFile(existsJoinPath, 'utf8');
      expect(patched).toContain('xpodTestJoinColumns');
      expect(patched).toContain('return joinColumns_;');
      expect(patched).toContain('Product code must not use this as a planner');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('patches ExistsJoinTest away from private-field access', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'xpod-qlever-exists-join-test-'));
    try {
      const qleverSource = path.join(root, 'qlever');
      const existsJoinTestPath = path.join(qleverSource, 'test/engine/ExistsJoinTest.cpp');
      await mkdir(path.dirname(existsJoinTestPath), { recursive: true });
      await writeFile(existsJoinTestPath, upstreamExistsJoinTestFixture, 'utf8');

      execFileSync('node', [
        patchScript,
        '--qlever-source',
        qleverSource,
        '--patch',
        existsJoinTestPatchPath,
        '--apply',
      ], { stdio: 'pipe' });

      const patched = await readFile(existsJoinTestPath, 'utf8');
      expect(patched).toContain('EXPECT_THAT(existsJoin.xpodTestJoinColumns(),');
      expect(patched).not.toContain('EXPECT_THAT(existsJoin.joinColumns_,');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('patches TransitivePath hardcoded side ids through the Xpod physical dictionary', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'xpod-qlever-transitive-patch-'));
    try {
      const qleverSource = path.join(root, 'qlever');
      const transitivePathImplPath = path.join(qleverSource, 'src/engine/TransitivePathImpl.h');
      await mkdir(path.dirname(transitivePathImplPath), { recursive: true });
      await writeFile(transitivePathImplPath, upstreamTransitivePathImplFixture, 'utf8');

      execFileSync('node', [
        patchScript,
        '--qlever-source',
        qleverSource,
        '--patch',
        transitivePathPatchPath,
        '--apply',
      ], { stdio: 'pipe' });

      const patched = await readFile(transitivePathImplPath, 'utf8');
      expect(patched).toContain('"XpodQleverPhysicalTransitivePathContextBridge.hpp"');
      expect(patched).toContain('xpod::qlever::physicalTransitivePathSideIdFromContext');
      expect(patched).toContain('if (!targetId.has_value())');
      expect(patched).toContain('physicalStartId.value_or');
      expect(patched).toContain('TripleComponent{startSide.value_}.toValueId(getIndex(), helperVocab)');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('patches Values constants through the Xpod physical dictionary', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'xpod-qlever-values-patch-'));
    try {
      const qleverSource = path.join(root, 'qlever');
      const valuesPath = path.join(qleverSource, 'src/engine/Values.cpp');
      await mkdir(path.dirname(valuesPath), { recursive: true });
      await writeFile(valuesPath, upstreamValuesFixture, 'utf8');

      execFileSync('node', [
        patchScript,
        '--qlever-source',
        qleverSource,
        '--patch',
        valuesPatchPath,
        '--apply',
      ], { stdio: 'pipe' });

      const patched = await readFile(valuesPath, 'utf8');
      expect(patched).toContain('"XpodQleverPhysicalValuesContextBridge.hpp"');
      expect(patched).toContain('xpod::qlever::physicalValuesIdFromContext');
      expect(patched).toContain('physicalId.value_or');
      expect(patched).toContain('TripleComponent{tc}.toValueId(getIndex(), *localVocab)');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('patches Describe direct IRIs through the Xpod physical dictionary', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'xpod-qlever-describe-patch-'));
    try {
      const qleverSource = path.join(root, 'qlever');
      const describePath = path.join(qleverSource, 'src/engine/Describe.cpp');
      await mkdir(path.dirname(describePath), { recursive: true });
      await writeFile(describePath, upstreamDescribeFixture, 'utf8');

      execFileSync('node', [
        patchScript,
        '--qlever-source',
        qleverSource,
        '--patch',
        describePatchPath,
        '--apply',
      ], { stdio: 'pipe' });

      const patched = await readFile(describePath, 'utf8');
      expect(patched).toContain('"XpodQleverPhysicalDescribeContextBridge.hpp"');
      expect(patched).toContain('xpod::qlever::physicalDescribeIdFromContext');
      expect(patched).toContain('*getExecutionContext(), TripleComponent{iri}');
      expect(patched).toContain('physicalId.value_or');
      expect(patched).toContain('TripleComponent{iri}.toValueId(getIndex(), localVocab)');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('patches prefix REGEX evaluation through the Xpod physical dictionary', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'xpod-qlever-regex-prefix-patch-'));
    try {
      const qleverSource = path.join(root, 'qlever');
      const regexExpressionPath = path.join(qleverSource, 'src/engine/sparqlExpressions/RegexExpression.cpp');
      await mkdir(path.dirname(regexExpressionPath), { recursive: true });
      await writeFile(regexExpressionPath, upstreamRegexExpressionFixture, 'utf8');

      execFileSync('node', [
        patchScript,
        '--qlever-source',
        qleverSource,
        '--patch',
        regexPrefixPatchPath,
        '--apply',
      ], { stdio: 'pipe' });

      const patched = await readFile(regexExpressionPath, 'utf8');
      expect(patched).toContain('"XpodQleverPhysicalIndex.hpp"');
      expect(patched).toContain('xpodPhysicalPrefixRegexMatch');
      expect(patched).toContain('context->_qec.xpodPhysicalIndex()');
      expect(patched).toContain('physicalIndex->decodeQleverId');
      expect(patched).toContain('physicalIndex->resolveTerms');
      expect(patched).toContain('!childIsStrExpression && term.kind != XPOD_RDF_TERM_LITERAL');
      expect(patched).toContain('ql::starts_with(value, prefixRegex)');
      expect(patched).toContain('detail::xpodPhysicalPrefixRegexMatch(');
      expect(patched).toContain('ql::ranges::any_of(lowerAndUpperIds');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('patches RegexExpression with narrow upstream-test accessors', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'xpod-qlever-regex-accessor-patch-'));
    try {
      const qleverSource = path.join(root, 'qlever');
      const regexExpressionHeaderPath = path.join(qleverSource, 'src/engine/sparqlExpressions/RegexExpression.h');
      await mkdir(path.dirname(regexExpressionHeaderPath), { recursive: true });
      await writeFile(regexExpressionHeaderPath, upstreamRegexExpressionHeaderFixture, 'utf8');

      execFileSync('node', [
        patchScript,
        '--qlever-source',
        qleverSource,
        '--patch',
        regexExpressionAccessorPatchPath,
        '--apply',
      ], { stdio: 'pipe' });

      const patched = await readFile(regexExpressionHeaderPath, 'utf8');
      expect(patched).toContain('xpodTestGetPrefixRegex');
      expect(patched).toContain('xpodTestPrefixRegex');
      expect(patched).toContain('xpodTestVariable');
      expect(patched).toContain('Product code must not use');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('patches RegexExpressionTest away from private-field access', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'xpod-qlever-regex-test-patch-'));
    try {
      const qleverSource = path.join(root, 'qlever');
      const regexExpressionTestPath = path.join(qleverSource, 'test/RegexExpressionTest.cpp');
      await mkdir(path.dirname(regexExpressionTestPath), { recursive: true });
      await writeFile(regexExpressionTestPath, upstreamRegexExpressionTestFixture, 'utf8');

      execFileSync('node', [
        patchScript,
        '--qlever-source',
        qleverSource,
        '--patch',
        regexExpressionTestPatchPath,
        '--apply',
      ], { stdio: 'pipe' });

      const patched = await readFile(regexExpressionTestPath, 'utf8');
      expect(patched).toContain('PrefixRegexExpression::xpodTestGetPrefixRegex');
      expect(patched).toContain('Property(&PrefixRegexExpression::xpodTestPrefixRegex');
      expect(patched).toContain('Property(&PrefixRegexExpression::xpodTestVariable');
      expect(patched).not.toContain('AD_FIELD(PrefixRegexExpression, prefixRegex_');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('patches Operation with narrow upstream-test accessors', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'xpod-qlever-operation-accessor-patch-'));
    try {
      const qleverSource = path.join(root, 'qlever');
      const operationHeaderPath = path.join(qleverSource, 'src/engine/Operation.h');
      await mkdir(path.dirname(operationHeaderPath), { recursive: true });
      await writeFile(operationHeaderPath, upstreamOperationHeaderFixture, 'utf8');

      execFileSync('node', [
        patchScript,
        '--qlever-source',
        qleverSource,
        '--patch',
        operationAccessorPatchPath,
        '--apply',
      ], { stdio: 'pipe' });

      const patched = await readFile(operationHeaderPath, 'utf8');
      expect(patched).toContain('xpodTestSetExternalLimitApplied');
      expect(patched).toContain('xpodTestUpdateRuntimeStats');
      expect(patched).toContain('xpodTestRunComputation');
      expect(patched).toContain('xpodTestRunComputationAndPrepareForCache');
      expect(patched).toContain('Product code must not use');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('patches OperationTest away from private-member access', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'xpod-qlever-operation-test-patch-'));
    try {
      const qleverSource = path.join(root, 'qlever');
      const operationTestPath = path.join(qleverSource, 'test/OperationTest.cpp');
      await mkdir(path.dirname(operationTestPath), { recursive: true });
      await writeFile(operationTestPath, upstreamOperationTestFixture, 'utf8');

      execFileSync('node', [
        patchScript,
        '--qlever-source',
        qleverSource,
        '--patch',
        operationTestPatchPath,
        '--apply',
      ], { stdio: 'pipe' });

      const patched = await readFile(operationTestPath, 'utf8');
      expect(patched).toContain('xpodTestSetExternalLimitApplied(false)');
      expect(patched).toContain('xpodTestSetExternalLimitApplied(true)');
      expect(patched).toContain('xpodTestUpdateRuntimeStats(false, 11, 13, 17ms)');
      expect(patched).toContain('xpodTestRunComputation(timer, ComputationMode::LAZY_IF_SUPPORTED)');
      expect(patched).toContain('xpodTestRunComputationAndPrepareForCache(');
      expect(patched).not.toContain('externalLimitApplied_ =');
      expect(patched).not.toContain('.runComputation(timer');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('patches LazyGroupBy with a narrow upstream-test accessor', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'xpod-qlever-lazy-group-by-accessor-patch-'));
    try {
      const qleverSource = path.join(root, 'qlever');
      const lazyGroupByHeaderPath = path.join(qleverSource, 'src/engine/LazyGroupBy.h');
      await mkdir(path.dirname(lazyGroupByHeaderPath), { recursive: true });
      await writeFile(lazyGroupByHeaderPath, upstreamLazyGroupByHeaderFixture, 'utf8');

      execFileSync('node', [
        patchScript,
        '--qlever-source',
        qleverSource,
        '--patch',
        lazyGroupByAccessorPatchPath,
        '--apply',
      ], { stdio: 'pipe' });

      const patched = await readFile(lazyGroupByHeaderPath, 'utf8');
      expect(patched).toContain('xpodTestAggregationData');
      expect(patched).toContain('Product code must not use');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('patches LazyGroupByTest away from private-field access', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'xpod-qlever-lazy-group-by-test-patch-'));
    try {
      const qleverSource = path.join(root, 'qlever');
      const lazyGroupByTestPath = path.join(qleverSource, 'test/engine/LazyGroupByTest.cpp');
      await mkdir(path.dirname(lazyGroupByTestPath), { recursive: true });
      await writeFile(lazyGroupByTestPath, upstreamLazyGroupByTestFixture, 'utf8');

      execFileSync('node', [
        patchScript,
        '--qlever-source',
        qleverSource,
        '--patch',
        lazyGroupByTestPatchPath,
        '--apply',
      ], { stdio: 'pipe' });

      const patched = await readFile(lazyGroupByTestPath, 'utf8');
      expect(patched).toContain('lazyGroupBy.xpodTestAggregationData().getAggregationDataVariant(0)');
      expect(patched).not.toContain('lazyGroupBy.aggregationData_');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('patches SparqlQleverVisitor with a narrow upstream-test graph-pattern accessor', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'xpod-qlever-sparql-antlr-accessor-patch-'));
    try {
      const qleverSource = path.join(root, 'qlever');
      const visitorHeaderPath = path.join(qleverSource, 'src/parser/sparqlParser/SparqlQleverVisitor.h');
      await mkdir(path.dirname(visitorHeaderPath), { recursive: true });
      await writeFile(visitorHeaderPath, upstreamSparqlQleverVisitorFixture, 'utf8');

      execFileSync('node', [
        patchScript,
        '--qlever-source',
        qleverSource,
        '--patch',
        sparqlAntlrVisitorAccessorPatchPath,
        '--apply',
      ], { stdio: 'pipe' });

      const patched = await readFile(visitorHeaderPath, 'utf8');
      expect(patched).toContain('xpodTestToGraphPattern');
      expect(patched).toContain('Product code must not use');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('patches SparqlAntlrParserTest away from private toGraphPattern access', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'xpod-qlever-sparql-antlr-test-patch-'));
    try {
      const qleverSource = path.join(root, 'qlever');
      const parserTestPath = path.join(qleverSource, 'test/parser/SparqlAntlrParserTest.cpp');
      await mkdir(path.dirname(parserTestPath), { recursive: true });
      await writeFile(parserTestPath, upstreamSparqlAntlrParserTestFixture, 'utf8');

      execFileSync('node', [
        patchScript,
        '--qlever-source',
        qleverSource,
        '--patch',
        sparqlAntlrParserTestPatchPath,
        '--apply',
      ], { stdio: 'pipe' });

      const patched = await readFile(parserTestPath, 'utf8');
      expect(patched).toContain('visitor.xpodTestToGraphPattern');
      expect(patched).not.toContain('visitor.toGraphPattern');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });


  it('patches ConstructTripleGenerator with narrow upstream-test accessors', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'xpod-qlever-construct-generator-accessor-patch-'));
    try {
      const qleverSource = path.join(root, 'qlever');
      const headerPath = path.join(qleverSource, 'src/engine/ConstructTripleGenerator.h');
      await mkdir(path.dirname(headerPath), { recursive: true });
      await writeFile(headerPath, upstreamConstructTripleGeneratorHeaderFixture, 'utf8');

      execFileSync('node', [
        patchScript,
        '--qlever-source',
        qleverSource,
        '--patch',
        constructTripleGeneratorAccessorPatchPath,
        '--apply',
      ], { stdio: 'pipe' });

      const patched = await readFile(headerPath, 'utf8');
      expect(patched).toContain('xpodTestMakeIdCache');
      expect(patched).toContain('xpodTestEvaluateTables');
      expect(patched).toContain('Product code must not use');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('patches ConstructTripleGeneratorTest away from private static-member access', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'xpod-qlever-construct-generator-test-patch-'));
    try {
      const qleverSource = path.join(root, 'qlever');
      const testPath = path.join(qleverSource, 'test/ConstructTripleGeneratorTest.cpp');
      await mkdir(path.dirname(testPath), { recursive: true });
      await writeFile(testPath, upstreamConstructTripleGeneratorTestFixture, 'utf8');

      execFileSync('node', [
        patchScript,
        '--qlever-source',
        qleverSource,
        '--patch',
        constructTripleGeneratorTestPatchPath,
        '--apply',
      ], { stdio: 'pipe' });

      const patched = await readFile(testPath, 'utf8');
      expect(patched).toContain('ConstructTripleGenerator::xpodTestEvaluateTables(');
      expect(patched).toContain('ConstructTripleGenerator::xpodTestMakeIdCache(tmpl)');
      expect(patched).not.toContain('ConstructTripleGenerator::evaluateTables(');
      expect(patched).not.toContain('ConstructTripleGenerator::makeIdCache(tmpl)');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });


  it('patches ExportQueryExecutionTrees with narrow upstream-test accessors', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'xpod-qlever-export-trees-accessor-patch-'));
    try {
      const qleverSource = path.join(root, 'qlever');
      const headerPath = path.join(qleverSource, 'src/engine/ExportQueryExecutionTrees.h');
      await mkdir(path.dirname(headerPath), { recursive: true });
      await writeFile(headerPath, upstreamExportQueryExecutionTreesHeaderFixture, 'utf8');

      execFileSync('node', [
        patchScript,
        '--qlever-source',
        qleverSource,
        '--patch',
        exportQueryExecutionTreesAccessorPatchPath,
        '--apply',
      ], { stdio: 'pipe' });

      const patched = await readFile(headerPath, 'utf8');
      expect(patched).toContain('xpodTestGetIdTables');
      expect(patched).toContain('xpodTestComputeResultAsQLeverJSON');
      expect(patched).toContain('xpodTestCompensateForLimitOffsetClause');
      expect(patched).toContain('Product code must not use');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('patches ExportQueryExecutionTreesTest away from private static-member access', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'xpod-qlever-export-trees-test-patch-'));
    try {
      const qleverSource = path.join(root, 'qlever');
      const testPath = path.join(qleverSource, 'test/ExportQueryExecutionTreesTest.cpp');
      await mkdir(path.dirname(testPath), { recursive: true });
      await writeFile(testPath, upstreamExportQueryExecutionTreesTestFixture, 'utf8');

      execFileSync('node', [
        patchScript,
        '--qlever-source',
        qleverSource,
        '--patch',
        exportQueryExecutionTreesTestPatchPath,
        '--apply',
      ], { stdio: 'pipe' });

      const patched = await readFile(testPath, 'utf8');
      expect(patched).toContain('ExportQueryExecutionTrees::xpodTestGetIdTables(result)');
      expect(patched).toContain('ExportQueryExecutionTrees::xpodTestComputeResultAsQLeverJSON(');
      expect(patched).toContain('ExportQueryExecutionTrees::xpodTestCompensateForLimitOffsetClause(limit, *qet1)');
      expect(patched).not.toContain('ExportQueryExecutionTrees::getIdTables(result)');
      expect(patched).not.toContain('ExportQueryExecutionTrees::computeResultAsQLeverJSON(');
      expect(patched).not.toContain('ExportQueryExecutionTrees::compensateForLimitOffsetClause(');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });


  it('patches Service with a narrow upstream-test sibling-info accessor', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'xpod-qlever-service-accessor-patch-'));
    try {
      const qleverSource = path.join(root, 'qlever');
      const headerPath = path.join(qleverSource, 'src/engine/Service.h');
      await mkdir(path.dirname(headerPath), { recursive: true });
      await writeFile(headerPath, upstreamServiceHeaderFixture, 'utf8');

      execFileSync('node', [
        patchScript,
        '--qlever-source',
        qleverSource,
        '--patch',
        serviceAccessorPatchPath,
        '--apply',
      ], { stdio: 'pipe' });

      const patched = await readFile(headerPath, 'utf8');
      expect(patched).toContain('xpodTestSiblingInfo');
      expect(patched).toContain('Product code must not use');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('patches ServiceTest away from private sibling-info access', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'xpod-qlever-service-test-patch-'));
    try {
      const qleverSource = path.join(root, 'qlever');
      const testPath = path.join(qleverSource, 'test/ServiceTest.cpp');
      await mkdir(path.dirname(testPath), { recursive: true });
      await writeFile(testPath, upstreamServiceTestFixture, 'utf8');

      execFileSync('node', [
        patchScript,
        '--qlever-source',
        qleverSource,
        '--patch',
        serviceTestPatchPath,
        '--apply',
      ], { stdio: 'pipe' });

      const patched = await readFile(testPath, 'utf8');
      expect(patched).toContain('xpodTestSiblingInfo().emplace(');
      expect(patched).toContain('xpodTestSiblingInfo().has_value()');
      expect(patched).toContain('xpodTestSiblingInfo().reset()');
      expect(patched).not.toContain('siblingInfo_');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('patches MaterializedView with a narrow upstream-test parsed-query accessor', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'xpod-qlever-materialized-view-accessor-patch-'));
    try {
      const qleverSource = path.join(root, 'qlever');
      const headerPath = path.join(qleverSource, 'src/engine/MaterializedViews.h');
      await mkdir(path.dirname(headerPath), { recursive: true });
      await writeFile(headerPath, upstreamMaterializedViewsHeaderFixture, 'utf8');

      execFileSync('node', [
        patchScript,
        '--qlever-source',
        qleverSource,
        '--patch',
        materializedViewsAccessorPatchPath,
        '--apply',
      ], { stdio: 'pipe' });

      const patched = await readFile(headerPath, 'utf8');
      expect(patched).toContain('xpodTestParsedQuery');
      expect(patched).toContain('Product code must not use');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('patches Server with narrow upstream-test materialized-view accessors', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'xpod-qlever-materialized-server-accessor-patch-'));
    try {
      const qleverSource = path.join(root, 'qlever');
      const headerPath = path.join(qleverSource, 'src/engine/Server.h');
      await mkdir(path.dirname(headerPath), { recursive: true });
      await writeFile(headerPath, upstreamServerHeaderFixture, 'utf8');

      execFileSync('node', [
        patchScript,
        '--qlever-source',
        qleverSource,
        '--patch',
        materializedViewsServerAccessorPatchPath,
        '--apply',
      ], { stdio: 'pipe' });

      const patched = await readFile(headerPath, 'utf8');
      expect(patched).toContain('xpodTestWriteMaterializedView');
      expect(patched).toContain('xpodTestQlever');
      expect(patched).toContain('Product code must not use');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('patches MaterializedViewsTest away from private-member access', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'xpod-qlever-materialized-views-test-patch-'));
    try {
      const qleverSource = path.join(root, 'qlever');
      const testPath = path.join(qleverSource, 'test/MaterializedViewsTest.cpp');
      await mkdir(path.dirname(testPath), { recursive: true });
      await writeFile(testPath, upstreamMaterializedViewsTestFixture, 'utf8');

      execFileSync('node', [
        patchScript,
        '--qlever-source',
        qleverSource,
        '--patch',
        materializedViewsTestPatchPath,
        '--apply',
      ], { stdio: 'pipe' });

      const patched = await readFile(testPath, 'utf8');
      expect(patched).toContain('view->xpodTestParsedQuery() = std::nullopt;');
      expect(patched).toContain('server.xpodTestWriteMaterializedView(');
      expect(patched).toContain('server.xpodTestQlever().materializedViewsManager()');
      expect(patched).not.toContain('parsedQuery_');
      expect(patched).not.toContain('server.qlever_');
      expect(patched).not.toContain('server.writeMaterializedView(');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });


  it('patches GraphStoreProtocol with an Xpod-build-only upstream-test access section', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'xpod-qlever-graph-store-accessor-patch-'));
    try {
      const qleverSource = path.join(root, 'qlever');
      const headerPath = path.join(qleverSource, 'src/engine/GraphStoreProtocol.h');
      await mkdir(path.dirname(headerPath), { recursive: true });
      await writeFile(headerPath, upstreamGraphStoreProtocolHeaderFixture, 'utf8');

      execFileSync('node', [
        patchScript,
        '--qlever-source',
        qleverSource,
        '--patch',
        graphStoreProtocolAccessorPatchPath,
        '--apply',
      ], { stdio: 'pipe' });

      const patched = await readFile(headerPath, 'utf8');
      expect(patched).toContain('XPOD_QLEVER_ADAPTER_ENABLE_QLEVER');
      expect(patched).toContain('Product code must not use these as graph-store seams');
      expect(patched).toContain('#else\n private:\n#endif');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });


  it('patches ExecuteUpdate with an Xpod-build-only upstream-test access section', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'xpod-qlever-execute-update-accessor-patch-'));
    try {
      const qleverSource = path.join(root, 'qlever');
      const headerPath = path.join(qleverSource, 'src/engine/ExecuteUpdate.h');
      await mkdir(path.dirname(headerPath), { recursive: true });
      await writeFile(headerPath, upstreamExecuteUpdateHeaderFixture, 'utf8');

      execFileSync('node', [
        patchScript,
        '--qlever-source',
        qleverSource,
        '--patch',
        executeUpdateAccessorPatchPath,
        '--apply',
      ], { stdio: 'pipe' });

      const patched = await readFile(headerPath, 'utf8');
      expect(patched).toContain('XPOD_QLEVER_ADAPTER_ENABLE_QLEVER');
      expect(patched).toContain('Product code must not use these as update');
      expect(patched).toContain('execution seams');
      expect(patched).toContain('#else\n private:\n#endif');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });


  it('patches ParsedRequestBuilder with an Xpod-build-only upstream-test access section', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'xpod-qlever-parsed-request-builder-accessor-patch-'));
    try {
      const qleverSource = path.join(root, 'qlever');
      const headerPath = path.join(qleverSource, 'src/engine/ParsedRequestBuilder.h');
      await mkdir(path.dirname(headerPath), { recursive: true });
      await writeFile(headerPath, upstreamParsedRequestBuilderHeaderFixture, 'utf8');

      execFileSync('node', [
        patchScript,
        '--qlever-source',
        qleverSource,
        '--patch',
        parsedRequestBuilderAccessorPatchPath,
        '--apply',
      ], { stdio: 'pipe' });

      const patched = await readFile(headerPath, 'utf8');
      expect(patched).toContain('XPOD_QLEVER_ADAPTER_ENABLE_QLEVER');
      expect(patched).toContain('Product code must not use these as request parsing');
      expect(patched).toContain('seams');
      expect(patched).toContain('#else\n private:\n#endif');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('patches SparqlProtocol with an Xpod-build-only upstream-test access section', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'xpod-qlever-sparql-protocol-accessor-patch-'));
    try {
      const qleverSource = path.join(root, 'qlever');
      const headerPath = path.join(qleverSource, 'src/engine/SparqlProtocol.h');
      await mkdir(path.dirname(headerPath), { recursive: true });
      await writeFile(headerPath, upstreamSparqlProtocolHeaderFixture, 'utf8');

      execFileSync('node', [
        patchScript,
        '--qlever-source',
        qleverSource,
        '--patch',
        sparqlProtocolAccessorPatchPath,
        '--apply',
      ], { stdio: 'pipe' });

      const patched = await readFile(headerPath, 'utf8');
      expect(patched).toContain('XPOD_QLEVER_ADAPTER_ENABLE_QLEVER');
      expect(patched).toContain('Product code must not use these as protocol parsing');
      expect(patched).toContain('seams');
      expect(patched).toContain('#else\n private:\n#endif');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('patches IndexImpl with an Xpod-build-only upstream-test access section', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'xpod-qlever-index-impl-accessor-patch-'));
    try {
      const qleverSource = path.join(root, 'qlever');
      const headerPath = path.join(qleverSource, 'src/index/IndexImpl.h');
      await mkdir(path.dirname(headerPath), { recursive: true });
      await writeFile(headerPath, upstreamIndexImplHeaderFixture, 'utf8');

      execFileSync('node', [
        patchScript,
        '--qlever-source',
        qleverSource,
        '--patch',
        indexImplAccessorPatchPath,
        '--apply',
      ], { stdio: 'pipe' });

      const patched = await readFile(headerPath, 'utf8');
      expect(patched).toContain('XPOD_QLEVER_ADAPTER_ENABLE_QLEVER');
      expect(patched).toContain('Product code must not use');
      expect(patched).toContain('index-internal state seams');
      expect(patched).toContain('#else\n protected:\n#endif');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('patches GraphNameManager with an Xpod-build-only upstream-test access section', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'xpod-qlever-graph-name-manager-accessor-patch-'));
    try {
      const qleverSource = path.join(root, 'qlever');
      const headerPath = path.join(qleverSource, 'src/index/GraphNameManager.h');
      await mkdir(path.dirname(headerPath), { recursive: true });
      await writeFile(headerPath, upstreamGraphNameManagerHeaderFixture, 'utf8');

      execFileSync('node', [
        patchScript,
        '--qlever-source',
        qleverSource,
        '--patch',
        graphNameManagerAccessorPatchPath,
        '--apply',
      ], { stdio: 'pipe' });

      const patched = await readFile(headerPath, 'utf8');
      expect(patched).toContain('XPOD_QLEVER_ADAPTER_ENABLE_QLEVER');
      expect(patched).toContain('Product code must not use these as graph-name-manager');
      expect(patched).toContain('state seams');
      expect(patched).toContain('#else\n private:\n#endif');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('patches LocatedTriplesPerBlock with an Xpod-build-only upstream-test access section', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'xpod-qlever-located-triples-accessor-patch-'));
    try {
      const qleverSource = path.join(root, 'qlever');
      const headerPath = path.join(qleverSource, 'src/index/LocatedTriples.h');
      await mkdir(path.dirname(headerPath), { recursive: true });
      await writeFile(headerPath, upstreamLocatedTriplesHeaderFixture, 'utf8');

      execFileSync('node', [
        patchScript,
        '--qlever-source',
        qleverSource,
        '--patch',
        locatedTriplesAccessorPatchPath,
        '--apply',
      ], { stdio: 'pipe' });

      const patched = await readFile(headerPath, 'utf8');
      expect(patched).toContain('XPOD_QLEVER_ADAPTER_ENABLE_QLEVER');
      expect(patched).toContain('Product code must not use');
      expect(patched).toContain('state seams');
      expect(patched).toContain('#else\n private:\n#endif');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('patches DeltaTriples with Xpod-build-only upstream-test access sections', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'xpod-qlever-delta-triples-accessor-patch-'));
    try {
      const qleverSource = path.join(root, 'qlever');
      const headerPath = path.join(qleverSource, 'src/index/DeltaTriples.h');
      await mkdir(path.dirname(headerPath), { recursive: true });
      await writeFile(headerPath, upstreamDeltaTriplesHeaderFixture, 'utf8');

      execFileSync('node', [
        patchScript,
        '--qlever-source',
        qleverSource,
        '--patch',
        deltaTriplesAccessorPatchPath,
        '--apply',
      ], { stdio: 'pipe' });

      const patched = await readFile(headerPath, 'utf8');
      expect(patched).toContain('XPOD_QLEVER_ADAPTER_ENABLE_QLEVER');
      expect(patched).toContain('Product code must not use');
      expect(patched).toContain('delta-triples state seams');
      expect(patched).toContain('#else\n private:\n#endif');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('patches LocalVocabEntry with an Xpod-build-only upstream-test access section', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'xpod-qlever-local-vocab-entry-accessor-patch-'));
    try {
      const qleverSource = path.join(root, 'qlever');
      const headerPath = path.join(qleverSource, 'src/index/LocalVocabEntry.h');
      await mkdir(path.dirname(headerPath), { recursive: true });
      await writeFile(headerPath, upstreamLocalVocabEntryHeaderFixture, 'utf8');

      execFileSync('node', [
        patchScript,
        '--qlever-source',
        qleverSource,
        '--patch',
        localVocabEntryAccessorPatchPath,
        '--apply',
      ], { stdio: 'pipe' });

      const patched = await readFile(headerPath, 'utf8');
      expect(patched).toContain('XPOD_QLEVER_ADAPTER_ENABLE_QLEVER');
      expect(patched).toContain('Product code must not use');
      expect(patched).toContain('local-vocab-entry cache seams');
      expect(patched).toContain('#else\n private:\n#endif');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

});
