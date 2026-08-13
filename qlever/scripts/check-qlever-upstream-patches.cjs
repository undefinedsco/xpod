#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const repoRoot = path.resolve(__dirname, '..');
const patchesRoot = path.join(repoRoot, 'patches');
const patchSpecs = [
  {
    patchPath: path.join(patchesRoot, 'qlever-indexscan-physical-lazy-scan.patch'),
    target: 'src/engine/IndexScan.cpp',
    patchTokens: [
      'XpodQleverPhysicalIndexScanContextBridge.hpp',
      'xpodIndexScanProjectedSlots',
      'xpod::qlever::physicalIndexFromContext(*_executionContext) != nullptr',
      'materializedScanFromQleverScanSpecAndBlocks',
      'scanSpecAndBlocks_,\n+            getPermutedTriple(),\n+            xpodNeededSlots',
      'xpodThrowPhysicalScanStatus("materialized scan",',
      'sizeEstimateFromQleverScanSpecAndBlocks',
      'AD_CONTRACT_CHECK(xpodSizeEstimate.status == XPOD_RDF_STATUS_OK);',
      'exactSizeFromQleverScanSpecAndBlocks',
      'AD_CONTRACT_CHECK(xpodExactSize.status == XPOD_RDF_STATUS_OK);',
      'multiplicitiesFromQleverScanSpecAndBlocks',
      'AD_CONTRACT_CHECK(xpodMultiplicities.status == XPOD_RDF_STATUS_OK);',
      'canUsePhysicalScanSpecAndBlocks',
      'BlockMetadataRanges{}',
      'lazyScanRangeFromQleverScanSpecAndBlocks',
      'xpodThrowPhysicalScanStatus("lazy scan", xpodLazyScan.status);',
      '!scanSpecAndBlocksIsPrefiltered_',
      'permutation().lazyScan(',
    ],
    anchors: [
      'IndexScan::getLazyScan(',
      'IndexScan::materializedIndexScan()',
      'IndexScan::computeSizeEstimate()',
      'IndexScan::getExactSize()',
      'IndexScan::getScanSpecAndBlocks()',
      'permutation().scan(',
      'auto filteredBlocks =',
      'permutation().lazyScan(',
      'permutation().getSizeEstimateForScan(',
      'permutation().getResultSizeOfScan(',
      'permutation().getScanSpecAndBlocks(',
      'scanSpecAndBlocks_',
    ],
    appliedTokens: [
      'XpodQleverPhysicalIndexScanContextBridge.hpp',
      'xpodIndexScanProjectedSlots',
      'xpod::qlever::physicalIndexFromContext(*_executionContext) != nullptr',
      'xpod::qlever::materializedScanFromQleverScanSpecAndBlocks',
      'scanSpecAndBlocks_,\n            getPermutedTriple(),\n            xpodNeededSlots',
      'xpod::qlever::qleverPhysicalScanLimitOffset(getLimitOffset())',
      'xpodLimitOffset.limit, xpodLimitOffset.offset',
      'xpodThrowPhysicalScanStatus("materialized scan",',
      'xpod::qlever::sizeEstimateFromQleverScanSpecAndBlocks',
      'AD_CONTRACT_CHECK(xpodSizeEstimate.status == XPOD_RDF_STATUS_OK);',
      'xpod::qlever::exactSizeFromQleverScanSpecAndBlocks',
      'AD_CONTRACT_CHECK(xpodExactSize.status == XPOD_RDF_STATUS_OK);',
      'xpod::qlever::multiplicitiesFromQleverScanSpecAndBlocks',
      'AD_CONTRACT_CHECK(xpodMultiplicities.status == XPOD_RDF_STATUS_OK);',
      'xpod::qlever::canUsePhysicalScanSpecAndBlocks',
      'BlockMetadataRanges{}',
      'xpod::qlever::lazyScanRangeFromQleverScanSpecAndBlocks',
      '!scanSpecAndBlocksIsPrefiltered_',
      'xpodThrowPhysicalScanStatus("lazy scan", xpodLazyScan.status);',
      'permutation().lazyScan(',
    ],
    alreadyPatchedMessage: 'already contains the Xpod IndexScan lazy-scan overlay',
  },
  {
    patchPath: path.join(patchesRoot, 'qlever-indexscan-native-value-order.patch'),
    target: 'src/engine/IndexScan.cpp',
    patchTokens: [
      'IndexScan::resultSortedOn() const {\n+  if (xpod::qlever::physicalIndexFromContext(*_executionContext) != nullptr)',
    ],
    anchors: [
      'IndexScan::resultSortedOn() const',
      'std::vector<ColumnIndex> result;',
    ],
    appliedTokens: [
      'IndexScan::resultSortedOn() const {\n  if (xpod::qlever::physicalIndexFromContext(*_executionContext) != nullptr) {\n    return {};',
    ],
    alreadyPatchedMessage: 'already marks request-native physical scans as unordered',
  },

  {
    patchPath: path.join(patchesRoot, 'qlever-graph-filter-physical-scope.patch'),
    target: 'src/index/GraphFilter.h',
    patchTokens: [
      'xpodPhysicalFilterType',
      'const FilterType&',
      'without consulting QLever',
    ],
    anchors: [
      'class GraphFilter',
      'using FilterType = std::variant<AllTag, ad_utility::HashSet<T>, T>;',
      'bool areAllGraphsAllowed() const;',
      'QL_DEFINE_DEFAULTED_EQUALITY_OPERATOR_LOCAL(GraphFilter, filter_)',
    ],
    appliedTokens: [
      'xpodPhysicalFilterType',
      'const FilterType& xpodPhysicalFilterType() const',
    ],
    alreadyPatchedMessage: 'already contains the Xpod GraphFilter physical-scope overlay',
  },

  {
    patchPath: path.join(patchesRoot, 'qlever-scan-specification-physical-local-vocab.patch'),
    target: 'src/index/ScanSpecification.h',
    patchTokens: [
      'xpodPhysicalLocalVocab',
      'const LocalVocab&',
      'graph filters from FROM clauses',
    ],
    anchors: [
      'class ScanSpecification',
      'std::shared_ptr<const LocalVocab> localVocab_;',
      'const T& col2Id() const',
      'size_t firstFreeColIndex() const',
    ],
    appliedTokens: [
      'xpodPhysicalLocalVocab',
      'const LocalVocab& xpodPhysicalLocalVocab() const',
    ],
    alreadyPatchedMessage: 'already contains the Xpod ScanSpecification physical-local-vocab overlay',
  },

  {
    patchPath: path.join(patchesRoot, 'qlever-text-indexscan-physical-text-search.patch'),
    target: 'src/engine/TextIndexScanForWord.cpp',
    patchTokens: [
      'XpodQleverPhysicalTextIndexScanContextBridge.hpp',
      'xpod::qlever::physicalIndexFromContext(*getExecutionContext())',
      'xpod::qlever::textWordResultFromContext',
      'xpod::qlever::textWordSizeEstimateFromContext',
      'xpodText.status == XPOD_RDF_STATUS_OK',
      'return std::move(xpodText.result);',
      'getWordPostingsForTerm',
      'getSizeOfTextBlocksSum',
    ],
    anchors: [
      'TextIndexScanForWord::computeResult(',
      'TextIndexScanForWord::getCostEstimate()',
      'TextIndexScanForWord::getSizeEstimateBeforeLimit()',
      'getWordPostingsForTerm',
      'getSizeOfTextBlocksSum',
    ],
    appliedTokens: [
      'XpodQleverPhysicalTextIndexScanContextBridge.hpp',
      'xpod::qlever::physicalIndexFromContext(*getExecutionContext())',
      'xpod::qlever::textWordResultFromContext',
      'xpod::qlever::textWordSizeEstimateFromContext',
      'xpodText.status == XPOD_RDF_STATUS_OK',
      'return std::move(xpodText.result);',
    ],
    alreadyPatchedMessage: 'already contains the Xpod text-index word overlay',
  },
  {
    patchPath: path.join(patchesRoot, 'qlever-text-indexscan-entity-physical-text-search.patch'),
    target: 'src/engine/TextIndexScanForEntity.cpp',
    patchTokens: [
      'XpodQleverPhysicalTextIndexScanContextBridge.hpp',
      'xpod::qlever::physicalIndexFromContext(*getExecutionContext())',
      'xpod::qlever::textEntityResultFromContext',
      'xpod::qlever::textEntitySizeEstimateFromContext',
      'xpodText.status == XPOD_RDF_STATUS_OK',
      'return std::move(xpodText.result);',
      'getEntityMentionsForWord',
    ],
    anchors: [
      'TextIndexScanForEntity::computeResult(',
      'TextIndexScanForEntity::getCostEstimate()',
      'TextIndexScanForEntity::getSizeEstimateBeforeLimit()',
      'TextIndexScanForEntity::knownEmptyResult()',
      'getEntityMentionsForWord',
      'getAverageNofEntityContexts',
    ],
    appliedTokens: [
      'XpodQleverPhysicalTextIndexScanContextBridge.hpp',
      'xpod::qlever::physicalIndexFromContext(*getExecutionContext())',
      'xpod::qlever::textEntityResultFromContext',
      'xpod::qlever::textEntitySizeEstimateFromContext',
      'xpodText.status == XPOD_RDF_STATUS_OK',
      'return std::move(xpodText.result);',
    ],
    alreadyPatchedMessage: 'already contains the Xpod text-index entity overlay',
  },
  {
    patchPath: path.join(patchesRoot, 'qlever-text-search-query-physical-fixed-entity.patch'),
    target: 'src/parser/TextSearchQuery.cpp',
    patchTokens: [
      'XpodQleverPhysicalIndexScanContextBridge.hpp',
      'XpodQleverPhysicalTextIndexScanContextBridge.hpp',
      'qec != nullptr',
      'xpod::qlever::physicalIndexFromContext(*qec) != nullptr',
      'return FixedEntity(std::move(fixedEntity), VocabIndex{});',
      'bestPhysicalTextTermIndexFromContext',
      'physicalBestTerm.has_value()',
    ],
    anchors: [
      '#include "parser/TextSearchQuery.h"',
      'VarOrFixedEntity::makeEntityVariant(',
      'std::string fixedEntity = std::move(std::get<std::string>(entity));',
      'bool success = qec->getIndex().getVocab().getId(fixedEntity, &index);',
      'therefore not be used as the object of ql:contains-entity',
      'potentialTerms[qec->getIndex().getIndexOfBestSuitedElTerm(',
    ],
    appliedTokens: [
      'XpodQleverPhysicalIndexScanContextBridge.hpp',
      'XpodQleverPhysicalTextIndexScanContextBridge.hpp',
      'qec != nullptr',
      'xpod::qlever::physicalIndexFromContext(*qec) != nullptr',
      'return FixedEntity(std::move(fixedEntity), VocabIndex{});',
      'bestPhysicalTextTermIndexFromContext',
      'physicalBestTerm.has_value()',
    ],
    alreadyPatchedMessage: 'already contains the Xpod TextSearchQuery fixed-entity overlay',
  },

  {
    patchPath: path.join(patchesRoot, 'qlever-queryplanner-physical-vector-source.patch'),
    target: 'src/engine/QueryPlanner.cpp',
    patchTokens: [
      'XpodQleverVectorIndexScan.hpp',
      'XpodQleverVectorIndexScan::canHandle',
      'makeSubtreePlan<xpod::qlever::XpodQleverVectorIndexScan>',
    ],
    anchors: [
      '#include "engine/QueryPlanner.h"',
      'QueryPlanner::GraphPatternPlanner::visitExternalValues(',
      'std::make_shared<ExternalValues>(qec_, externalValuesQuery)',
    ],
    appliedTokens: [
      'XpodQleverVectorIndexScan.hpp',
      'XpodQleverVectorIndexScan::canHandle',
      'makeSubtreePlan<xpod::qlever::XpodQleverVectorIndexScan>',
    ],
    alreadyPatchedMessage: 'already routes the reserved vector source to the Xpod vector scan',
  },

  {
    patchPath: path.join(patchesRoot, 'qlever-filter-physical-bounded-expression.patch'),
    target: 'src/engine/Filter.cpp',
    patchTokens: [
      'XpodQleverPhysicalFilterContextBridge.hpp',
      'xpod::qlever::physicalFilterResultFromContext',
      'xpodFilter.status == XPOD_RDF_STATUS_OK',
      'return std::move(xpodFilter.result);',
      'LocalVocab localVocab = subRes->getCopyOfLocalVocab();',
      'LocalVocab& localVocab',
    ],
    anchors: [
      '#include "engine/Filter.h"',
      'Filter::computeResult(',
      'std::shared_ptr<const Result> subRes = _subtree->getResult(true);',
      'checkCancellation();',
      'filterIdTable(subRes->sortedBy(), subRes->idTableView())',
    ],
    appliedTokens: [
      'XpodQleverPhysicalFilterContextBridge.hpp',
      'xpod::qlever::physicalFilterResultFromContext',
      'xpodFilter.status == XPOD_RDF_STATUS_OK',
      'return std::move(xpodFilter.result);',
      'LocalVocab localVocab = subRes->getCopyOfLocalVocab();',
    ],
    alreadyPatchedMessage: 'already contains the Xpod Filter bounded-expression overlay',
  },

  {
    patchPath: path.join(patchesRoot, 'qlever-filter-physical-bounded-expression.patch'),
    target: 'src/engine/Filter.h',
    patchTokens: [
      'LocalVocab& localVocab',
      'filterIdTable(std::vector<ColumnIndex> sortedBy, Table&& idTable,',
    ],
    anchors: [
      'computeFilterImpl(IdTable& dynamicResultTable',
      'filterIdTable(std::vector<ColumnIndex> sortedBy, Table&& idTable) const',
    ],
    appliedTokens: [
      'LocalVocab& localVocab',
      'filterIdTable(std::vector<ColumnIndex> sortedBy, Table&& idTable,',
    ],
    alreadyPatchedMessage: 'already contains the Xpod Filter local-vocab signature overlay',
  },

  {
    patchPath: path.join(patchesRoot, 'qlever-filter-split-conjunctions.patch'),
    target: 'src/parser/sparqlParser/SparqlQleverVisitor.cpp',
    patchTokens: [
      'visitFilterConjuncts',
      'conjunctions.size() == 1',
      'visitExpressionPimpl(conjunct)',
      'result.push_back(visit(filterContext))',
    ],
    anchors: [
      'Visitor::OperationsAndFilters Visitor::visit(',
      'Parser::GroupGraphPatternSubContext* ctx)',
      'visitVector(ctx->graphPatternNotTriplesAndMaybeTriples())',
    ],
    appliedTokens: [
      'visitFilterConjuncts',
      'conjunctions.size() == 1',
      'visitExpressionPimpl(conjunct)',
      'result.push_back(visit(filterContext))',
    ],
    alreadyPatchedMessage: 'already splits top-level FILTER conjunctions for planner pushdown',
  },

  {
    patchPath: path.join(patchesRoot, 'qlever-optionaljoin-physical-disable-prefilter.patch'),
    target: 'src/engine/OptionalJoin.cpp',
    patchTokens: [
      'XpodQleverPhysicalIndexScanContextBridge.hpp',
      'xpod::qlever::physicalIndexFromContext(*getExecutionContext()) == nullptr',
      'prefilteredOptionalJoin_',
    ],
    anchors: [
      '#include "engine/OptionalJoin.h"',
      'Result OptionalJoin::computeResult(bool requestLaziness)',
      'getRuntimeParameter<&RuntimeParameters::prefilteredOptionalJoin_>()',
      'optionalJoinWithIndexScan(_left->getResult(true)',
    ],
    appliedTokens: [
      'XpodQleverPhysicalIndexScanContextBridge.hpp',
      'xpod::qlever::physicalIndexFromContext(*getExecutionContext()) == nullptr',
      'prefilteredOptionalJoin_',
    ],
    alreadyPatchedMessage: 'already contains the Xpod OptionalJoin physical-index prefilter guard',
  },

  {
    patchPath: path.join(patchesRoot, 'qlever-groupby-physical-disable-native-optimization.patch'),
    target: 'src/engine/GroupByImpl.cpp',
    patchTokens: [
      'XpodQleverPhysicalIndexScanContextBridge.hpp',
      'xpod::qlever::physicalIndexFromContext(*getExecutionContext()) == nullptr',
      'computeOptimizedGroupByIfPossible()',
    ],
    anchors: [
      '#include "engine/GroupByImpl.h"',
      'Result GroupByImpl::computeResult(bool requestLaziness)',
      'if (auto idTable = computeOptimizedGroupByIfPossible())',
      'return {std::move(idTable).value(), resultSortedOn(), LocalVocab{}};',
    ],
    appliedTokens: [
      'XpodQleverPhysicalIndexScanContextBridge.hpp',
      'xpod::qlever::physicalIndexFromContext(*getExecutionContext()) == nullptr',
      'computeOptimizedGroupByIfPossible()',
    ],
    alreadyPatchedMessage: 'already contains the Xpod GroupBy physical-index optimization guard',
  },

  {
    patchPath: path.join(patchesRoot, 'qlever-has-predicate-physical-distinct.patch'),
    target: 'src/engine/HasPredicateScan.cpp',
    patchTokens: [
      'XpodQleverPhysicalHasPredicateContextBridge.hpp',
      'physicalHasPredicateMultiplicityFromContext',
      'physicalHasPredicateSizeEstimateFromContext',
      'physicalHasPredicateResultFromContext',
      'const CompactVectorOfStrings<Id>& patterns = getIndex().getPatterns();',
    ],
    anchors: [
      '#include "engine/HasPredicateScan.h"',
      'float HasPredicateScan::getMultiplicity',
      'uint64_t HasPredicateScan::getSizeEstimateBeforeLimit',
      'Result HasPredicateScan::computeResult',
      'idTable.setNumColumns(getResultWidth());',
      'const CompactVectorOfStrings<Id>& patterns = getIndex().getPatterns();',
    ],
    appliedTokens: [
      'XpodQleverPhysicalHasPredicateContextBridge.hpp',
      'physicalHasPredicateMultiplicityFromContext',
      'physicalHasPredicateSizeEstimateFromContext',
      'physicalHasPredicateResultFromContext',
    ],
    alreadyPatchedMessage: 'already contains the Xpod HasPredicateScan physical distinct overlay',
  },

  {
    patchPath: path.join(patchesRoot, 'qlever-exists-join-test-accessor.patch'),
    target: 'src/engine/ExistsJoin.h',
    patchTokens: [
      'xpodTestJoinColumns',
      'upstream-test overlay',
      'Product code must not use this as a planner',
    ],
    anchors: [
      'class ExistsJoin : public Operation',
      'std::vector<std::array<ColumnIndex, 2>> joinColumns_;',
      'ExistsJoin(QueryExecutionContext* qec,',
      'Variable existsVariable);',
    ],
    appliedTokens: [
      'xpodTestJoinColumns',
      'return joinColumns_;',
    ],
    alreadyPatchedMessage: 'already contains the Xpod ExistsJoin upstream-test accessor overlay',
  },

  {
    patchPath: path.join(patchesRoot, 'qlever-exists-join-test-access.patch'),
    target: 'test/engine/ExistsJoinTest.cpp',
    patchTokens: [
      'xpodTestJoinColumns',
      'existsJoin.joinColumns_',
    ],
    anchors: [
      'TEST(ExistsJoin, addExistsJoinsToSubtreeDoesntCollideForHiddenVariables)',
      'const ExistsJoin& existsJoin',
      'EXPECT_THAT(existsJoin.joinColumns_,',
    ],
    appliedTokens: [
      'EXPECT_THAT(existsJoin.xpodTestJoinColumns(),',
    ],
    alreadyPatchedMessage: 'already contains the Xpod ExistsJoinTest private-field access overlay',
  },

  {
    patchPath: path.join(patchesRoot, 'qlever-transitive-path-physical-id.patch'),
    target: 'src/engine/TransitivePathImpl.h',
    patchTokens: [
      'XpodQleverPhysicalTransitivePathContextBridge.hpp',
      'physicalTransitivePathSideIdFromContext',
      'if (!targetId.has_value())',
      'TripleComponent{startSide.value_}.toValueId(getIndex(), helperVocab)',
    ],
    anchors: [
      '#include "engine/TransitivePathBase.h"',
      'TransitivePathImpl',
      'transitiveHull(T edges, LocalVocab edgesVocab, Node startNodes,',
      'std::optional{std::move(target).toValueId(index, targetHelper)}',
      'setupNodes(const IdTableView<0>& sub,',
      'LocalVocab helperVocab;',
      'TripleComponent{startSide.value_}.toValueId(getIndex(), helperVocab)',
    ],
    appliedTokens: [
      'XpodQleverPhysicalTransitivePathContextBridge.hpp',
      'physicalTransitivePathSideIdFromContext',
      'if (!targetId.has_value())',
      'physicalStartId.value_or',
    ],
    alreadyPatchedMessage: 'already contains the Xpod TransitivePath physical-id overlay',
  },

  {
    patchPath: path.join(patchesRoot, 'qlever-values-physical-id.patch'),
    target: 'src/engine/Values.cpp',
    patchTokens: [
      'XpodQleverPhysicalValuesContextBridge.hpp',
      'physicalValuesIdFromContext',
      'TripleComponent{tc}.toValueId(getIndex(), *localVocab)',
    ],
    anchors: [
      '#include "engine/CallFixedSize.h"',
      'Values::writeValues',
      'const TripleComponent& tc = row[colIdx];',
      'TripleComponent{tc}.toValueId(getIndex(), *localVocab)',
    ],
    appliedTokens: [
      'XpodQleverPhysicalValuesContextBridge.hpp',
      'physicalValuesIdFromContext',
      'physicalId.value_or',
    ],
    alreadyPatchedMessage: 'already contains the Xpod Values physical-id overlay',
  },

  {
    patchPath: path.join(patchesRoot, 'qlever-describe-physical-id.patch'),
    target: 'src/engine/Describe.cpp',
    patchTokens: [
      'XpodQleverPhysicalDescribeContextBridge.hpp',
      'physicalDescribeIdFromContext',
      'TripleComponent{std::get<TripleComponent::Iri>(resource)}.toValueId(',
    ],
    anchors: [
      '#include "engine/Describe.h"',
      'Describe::getIdsToDescribe',
      'TripleComponent{std::get<TripleComponent::Iri>(resource)}.toValueId(',
    ],
    appliedTokens: [
      'XpodQleverPhysicalDescribeContextBridge.hpp',
      'physicalDescribeIdFromContext',
      'physicalId.value_or',
    ],
    alreadyPatchedMessage: 'already contains the Xpod Describe physical-id overlay',
  },

  {
    patchPath: path.join(patchesRoot, 'qlever-libcxx-normalized-string.patch'),
    target: 'src/parser/NormalizedString.h',
    patchTokens: [
      'constexpr operator char() const noexcept',
      'using NormalizedString = std::string;',
      'using NormalizedStringView = std::string_view;',
    ],
    anchors: [
      'using NormalizedString = std::basic_string<NormalizedChar>;',
      'using NormalizedStringView = std::basic_string_view<NormalizedChar>;',
      'reinterpret_cast<const NormalizedChar*>',
    ],
    appliedTokens: [
      'constexpr operator char() const noexcept',
      'using NormalizedString = std::string;',
      'using NormalizedStringView = std::string_view;',
      'return normalizedStringView;',
      'return input;',
    ],
    alreadyPatchedMessage: 'already contains the libc++ normalized-string overlay',
  },
  {
    patchPath: path.join(patchesRoot, 'qlever-libcxx-string-sort-comparator.patch'),
    target: 'src/index/StringSortComparator.h',
    patchTokens: [
      'using U8String = std::string;',
      'using U8StringView = std::string_view;',
      'using SortKey = SortKeyImpl<std::string>;',
      'using SortKeyView = SortKeyImpl<std::string_view>;',
    ],
    anchors: [
      'using U8String = std::basic_string<uint8_t>;',
      'using U8StringView = std::basic_string_view<uint8_t>;',
      'using SortKey = SortKeyImpl<std::basic_string<uint8_t>>;',
      'using SortKeyView = SortKeyImpl<std::basic_string_view<uint8_t>>;',
    ],
    appliedTokens: [
      'using U8String = std::string;',
      'using U8StringView = std::string_view;',
      'using SortKey = SortKeyImpl<std::string>;',
      'using SortKeyView = SortKeyImpl<std::string_view>;',
    ],
    alreadyPatchedMessage: 'already contains the libc++ byte-string sort-key overlay',
  },
  {
    patchPath: path.join(patchesRoot, 'qlever-libcxx-string-utils.patch'),
    target: 'src/util/StringUtils.h',
    patchTokens: [
      'const volatile unsigned char* bytes1',
      'const volatile unsigned char* bytes2',
      'volatile unsigned char mismatchFound',
    ],
    anchors: [
      'std::basic_string_view<volatile std::byte>',
      'volatile std::byte mismatchFound',
      'return impl(toVolatile(view1), toVolatile(view2));',
    ],
    appliedTokens: [
      'const volatile unsigned char* bytes1',
      'const volatile unsigned char* bytes2',
      'volatile unsigned char mismatchFound',
    ],
    alreadyPatchedMessage: 'already contains the libc++ constant-time compare overlay',
  },
  {
    patchPath: path.join(patchesRoot, 'qlever-queryplanner-physical-index.patch'),
    target: 'src/engine/QueryPlanner.cpp',
    patchTokens: [
      'XpodQleverPhysicalPathSearchContextBridge.hpp',
      'XpodQleverPhysicalIndexScanContextBridge.hpp',
      'xpod::qlever::physicalIndexFromContext(*_qec) != nullptr',
      'xpod::qlever::physicalIndexFromContext(*_qec) == nullptr',
      'getIndex().hasAllPermutations()',
      '_enablePatternTrick && !xpodPhysicalIndex',
    ],
    anchors: [
      '#include "engine/QueryPlanner.h"',
      'QueryPlanner::indexScanThreeVarsCase(',
      'AD_CONTRACT_CHECK(!_qec || _qec->getIndex().hasAllPermutations(),',
      'triples should have at most two variables.',
      'QueryPlanner::seedWithScansAndText(',
      'node.triple_.getPredicateVariable().has_value()',
      'The query contains a predicate variable',
    ],
    appliedTokens: [
      'XpodQleverPhysicalPathSearchContextBridge.hpp',
      'XpodQleverPhysicalIndexScanContextBridge.hpp',
      'xpod::qlever::physicalIndexFromContext(*_qec) != nullptr',
      'xpod::qlever::physicalIndexFromContext(*_qec) == nullptr',
      '_enablePatternTrick && !xpodPhysicalIndex',
    ],
    alreadyPatchedMessage: 'already contains the Xpod QueryPlanner physical-index overlay',
  },

  {
    patchPath: path.join(patchesRoot, 'qlever-queryplanner-physical-default-graph.patch'),
    target: 'src/engine/QueryPlanner.cpp',
    patchTokens: [
      'xpod::qlever::physicalIndexFromContext(*_qec) != nullptr',
      'ad_utility::HashSet<TripleComponent> defaultGraphs',
      'defaultGraphs.emplace(TripleComponent{',
      'Filter::Whitelist(std::move(defaultGraphs))',
      'ad_utility::triple_component::Iri::fromIriref(DEFAULT_GRAPH_IRI)',
      'return Filter::All();',
    ],
    anchors: [
      'QueryPlanner::getActiveGraphs()',
      'activeDatasetClauses_.activeDefaultGraphs()',
      'GraphVariableBehaviour::NAMED',
      'return Filter::Blacklist(TripleComponent{',
      'return Filter::All();',
    ],
    appliedTokens: [
      'xpod::qlever::physicalIndexFromContext(*_qec) != nullptr',
      'ad_utility::HashSet<TripleComponent> defaultGraphs',
      'defaultGraphs.emplace(TripleComponent{',
      'Filter::Whitelist(std::move(defaultGraphs))',
      'ad_utility::triple_component::Iri::fromIriref(DEFAULT_GRAPH_IRI)',
    ],
    alreadyPatchedMessage: 'already contains the Xpod QueryPlanner physical default-graph overlay',
  },

  {
    patchPath: path.join(patchesRoot, 'qlever-queryplanner-physical-text-anchor.patch'),
    target: 'src/engine/QueryPlanner.cpp',
    patchTokens: [
      'XpodQleverPhysicalTextIndexScanContextBridge.hpp',
      'bestPhysicalTextTermIndexFromContext(*_qec, terms)',
      'physicalBestTerm.has_value()',
      'getIndexOfBestSuitedElTerm(terms)',
    ],
    anchors: [
      'for (const auto& [cvar, terms] : potentialTermsForCvar)',
      'terms[_qec->getIndex().getIndexOfBestSuitedElTerm(terms)]',
    ],
    appliedTokens: [
      'XpodQleverPhysicalTextIndexScanContextBridge.hpp',
      'bestPhysicalTextTermIndexFromContext(*_qec, terms)',
      'physicalBestTerm.has_value()',
    ],
    alreadyPatchedMessage: 'already contains the Xpod physical text-anchor overlay',
  },

  {
    patchPath: path.join(patchesRoot, 'qlever-queryplanner-physical-path-search.patch'),
    target: 'src/engine/QueryPlanner.cpp',
    patchTokens: [
      'physicalPathSearchConfigurationFromContext(*qec_, pathQuery)',
      'pathQuery.toPathSearchConfiguration(planner_._qec->getIndex())',
    ],
    anchors: [
      'QueryPlanner::GraphPatternPlanner::visitPathSearch(',
      'pathQuery.toPathSearchConfiguration(planner_._qec->getIndex())',
    ],
    appliedTokens: [
      'physicalPathSearchConfigurationFromContext(*qec_, pathQuery)',
    ],
    alreadyPatchedMessage: 'already contains the Xpod PathSearch physical-id overlay',
  },
  {
    patchPath: path.join(patchesRoot, 'qlever-queryplanner-physical-has-predicate.patch'),
    target: 'src/engine/QueryPlanner.cpp',
    patchTokens: [
      'createJoinWithHasPredicateScan',
      'physicalIndexFromContext(*context) != nullptr',
      'return std::nullopt;',
    ],
    anchors: [
      'QueryPlanner::createJoinWithHasPredicateScan(',
      'const JoinColumns& jcs) -> std::optional<SubtreePlan> {',
      'Check if one of the two operations is a HAS_PREDICATE_SCAN',
    ],
    appliedTokens: [
      'createJoinWithHasPredicateScan',
      'physicalIndexFromContext(*context) != nullptr',
    ],
    alreadyPatchedMessage: 'already disables the upstream HasPredicate pattern-index join for physical backends',
  },

  {
    patchPath: path.join(patchesRoot, 'qlever-queryexecutioncontext-physical-index.patch'),
    target: 'src/engine/QueryExecutionContext.h',
    patchTokens: [
      'class XpodQleverPhysicalIndex',
      'setXpodPhysicalIndex',
      'xpodPhysicalIndex() const',
    ],
    anchors: [
      'class QueryExecutionContext',
      '[[nodiscard]] const Index& getIndex() const',
      'std::shared_ptr<const Index> _index',
    ],
    appliedTokens: [
      'class XpodQleverPhysicalIndex',
      'setXpodPhysicalIndex',
      'xpodPhysicalIndex() const',
      'std::shared_ptr<const xpod::qlever::XpodQleverPhysicalIndex>',
    ],
    alreadyPatchedMessage: 'already contains the Xpod physical-index context overlay',
  },
  {
    patchPath: path.join(patchesRoot, 'qlever-regex-prefix-physical-string.patch'),
    target: 'src/engine/sparqlExpressions/RegexExpression.cpp',
    patchTokens: [
      'XpodQleverPhysicalIndex.hpp',
      'xpodPhysicalPrefixRegexMatch',
      'context->_qec.xpodPhysicalIndex()',
      'physicalIndex->decodeQleverId',
      'physicalIndex->resolveTerms',
      'PrefixRegexExpression::evaluate',
    ],
    anchors: [
      '#include "engine/sparqlExpressions/RegexExpression.h"',
      'PrefixRegexExpression::makePrefixRegexExpressionIfPossible',
      'PrefixRegexExpression::evaluate',
      'context->_qec.getIndex().prefixRanges(prefix)',
    ],
    appliedTokens: [
      'XpodQleverPhysicalIndex.hpp',
      'xpodPhysicalPrefixRegexMatch',
      'context->_qec.xpodPhysicalIndex()',
      'physicalIndex->decodeQleverId',
      'physicalIndex->resolveTerms',
    ],
    alreadyPatchedMessage: 'already contains the Xpod prefix REGEX physical-string overlay',
  },

  {
    patchPath: path.join(patchesRoot, 'qlever-regex-expression-test-accessor.patch'),
    target: 'src/engine/sparqlExpressions/RegexExpression.h',
    patchTokens: [
      'xpodTestGetPrefixRegex',
      'xpodTestPrefixRegex',
      'xpodTestVariable',
      'upstream-test overlay',
    ],
    anchors: [
      'class PrefixRegexExpression',
      'std::string prefixRegex_;',
      'Variable variable_;',
      'static std::optional<std::string> getPrefixRegex(std::string regex);',
      'FRIEND_TEST(RegexExpression, getPrefixRegex);',
    ],
    appliedTokens: [
      'xpodTestGetPrefixRegex',
      'xpodTestPrefixRegex',
      'xpodTestVariable',
    ],
    alreadyPatchedMessage: 'already contains the Xpod RegexExpression upstream-test accessor overlay',
  },

  {
    patchPath: path.join(patchesRoot, 'qlever-regex-expression-test-access.patch'),
    target: 'test/RegexExpressionTest.cpp',
    patchTokens: [
      'xpodTestGetPrefixRegex',
      'xpodTestPrefixRegex',
      'xpodTestVariable',
      'PrefixRegexExpression::getPrefixRegex',
      'AD_FIELD(PrefixRegexExpression, prefixRegex_',
    ],
    anchors: [
      'TEST(RegexExpression, getPrefixRegex)',
      'PrefixRegexExpression::getPrefixRegex("alpha")',
      'AD_FIELD(PrefixRegexExpression, prefixRegex_, Eq(prefix))',
      'AD_FIELD(PrefixRegexExpression, variable_,',
    ],
    appliedTokens: [
      'PrefixRegexExpression::xpodTestGetPrefixRegex',
      'Property(&PrefixRegexExpression::xpodTestPrefixRegex',
      'Property(&PrefixRegexExpression::xpodTestVariable',
    ],
    alreadyPatchedMessage: 'already contains the Xpod RegexExpressionTest private-access overlay',
  },

  {
    patchPath: path.join(patchesRoot, 'qlever-operation-test-accessor.patch'),
    target: 'src/engine/Operation.h',
    patchTokens: [
      'xpodTestSetExternalLimitApplied',
      'xpodTestUpdateRuntimeStats',
      'xpodTestRunComputation',
      'xpodTestRunComputationAndPrepareForCache',
      'upstream-test overlay',
    ],
    anchors: [
      'class Operation',
      'externalLimitApplied_',
      'updateRuntimeStats',
      'runComputation(',
      'runComputationAndPrepareForCache',
    ],
    appliedTokens: [
      'xpodTestSetExternalLimitApplied',
      'xpodTestUpdateRuntimeStats',
      'xpodTestRunComputation',
      'xpodTestRunComputationAndPrepareForCache',
    ],
    alreadyPatchedMessage: 'already contains the Xpod Operation upstream-test accessor overlay',
  },

  {
    patchPath: path.join(patchesRoot, 'qlever-operation-test-access.patch'),
    target: 'test/OperationTest.cpp',
    patchTokens: [
      'xpodTestSetExternalLimitApplied',
      'xpodTestUpdateRuntimeStats',
      'xpodTestRunComputation',
      'xpodTestRunComputationAndPrepareForCache',
      'externalLimitApplied_',
      'runComputationAndPrepareForCache',
    ],
    anchors: [
      'TEST(Operation, updateRuntimeStatsWorksCorrectly)',
      'valuesForTesting.externalLimitApplied_ = false;',
      'valuesForTesting.updateRuntimeStats(false, 11, 13, 17ms);',
      'operation.runComputation(timer, ComputationMode::LAZY_IF_SUPPORTED)',
      'valuesForTesting.runComputationAndPrepareForCache(',
    ],
    appliedTokens: [
      'xpodTestSetExternalLimitApplied(false)',
      'xpodTestSetExternalLimitApplied(true)',
      'xpodTestUpdateRuntimeStats(false, 11, 13, 17ms)',
      'xpodTestRunComputation(timer, ComputationMode::LAZY_IF_SUPPORTED)',
      'xpodTestRunComputationAndPrepareForCache(',
    ],
    alreadyPatchedMessage: 'already contains the Xpod OperationTest private-access overlay',
  },

  {
    patchPath: path.join(patchesRoot, 'qlever-lazy-group-by-test-accessor.patch'),
    target: 'src/engine/LazyGroupBy.h',
    patchTokens: [
      'xpodTestAggregationData',
      'upstream-test overlay',
      'Product code must not use',
    ],
    anchors: [
      'class LazyGroupBy',
      'HashMapAggregationData<0> aggregationData_',
      'void commitRow',
    ],
    appliedTokens: [
      'xpodTestAggregationData',
      'return aggregationData_;',
    ],
    alreadyPatchedMessage: 'already contains the Xpod LazyGroupBy upstream-test accessor overlay',
  },

  {
    patchPath: path.join(patchesRoot, 'qlever-lazy-group-by-test-access.patch'),
    target: 'test/engine/LazyGroupByTest.cpp',
    patchTokens: [
      'xpodTestAggregationData',
      'aggregationData_',
    ],
    anchors: [
      'TEST(LazyGroupBy, verifyGroupConcatIsCorrectlyInitialized)',
      'lazyGroupBy.aggregationData_.getAggregationDataVariant(0)',
    ],
    appliedTokens: [
      'lazyGroupBy.xpodTestAggregationData().getAggregationDataVariant(0)',
    ],
    alreadyPatchedMessage: 'already contains the Xpod LazyGroupByTest private-access overlay',
  },

  {
    patchPath: path.join(patchesRoot, 'qlever-sparql-antlr-parser-test-accessor.patch'),
    target: 'src/parser/sparqlParser/SparqlQleverVisitor.h',
    patchTokens: [
      'xpodTestToGraphPattern',
      'upstream-test overlay',
      'Product code must not use',
    ],
    anchors: [
      'class SparqlQleverVisitor',
      'reportNotSupported',
      'toGraphPattern',
      'const ad_utility::sparql_types::Triples& triples',
    ],
    appliedTokens: [
      'xpodTestToGraphPattern',
      'return toGraphPattern(triples);',
    ],
    alreadyPatchedMessage: 'already contains the Xpod SparqlQleverVisitor upstream-test accessor overlay',
  },

  {
    patchPath: path.join(patchesRoot, 'qlever-sparql-antlr-parser-test-access.patch'),
    target: 'test/parser/SparqlAntlrParserTest.cpp',
    patchTokens: [
      'xpodTestToGraphPattern',
      'visitor.toGraphPattern',
    ],
    anchors: [
      'TEST(SparqlParser, ensureExceptionOnInvalidGraphTerm)',
      'visitor.toGraphPattern({{Var{"?a"}, BlankNode{true, "0"}, Var{"?b"}}})',
      'visitor.toGraphPattern({{Var{"?a"}, Literal{"\\"Abc\\""}, Var{"?b"}}})',
    ],
    appliedTokens: [
      'visitor.xpodTestToGraphPattern',
    ],
    alreadyPatchedMessage: 'already contains the Xpod SparqlAntlrParserTest private-access overlay',
  },


  {
    patchPath: path.join(patchesRoot, 'qlever-construct-triple-generator-test-accessor.patch'),
    target: 'src/engine/ConstructTripleGenerator.h',
    patchTokens: [
      'xpodTestMakeIdCache',
      'xpodTestEvaluateTables',
      'upstream-test overlay',
      'Product code must not use',
    ],
    anchors: [
      'class ConstructTripleGenerator',
      'generateStringTriples',
      'static IdCache makeIdCache',
      'static InputRangeTypeErased<EvaluatedTriple> evaluateTables',
    ],
    appliedTokens: [
      'xpodTestMakeIdCache',
      'xpodTestEvaluateTables',
    ],
    alreadyPatchedMessage: 'already contains the Xpod ConstructTripleGenerator upstream-test accessor overlay',
  },

  {
    patchPath: path.join(patchesRoot, 'qlever-construct-triple-generator-test-access.patch'),
    target: 'test/ConstructTripleGeneratorTest.cpp',
    patchTokens: [
      'xpodTestMakeIdCache',
      'xpodTestEvaluateTables',
      'ConstructTripleGenerator::evaluateTables',
      'ConstructTripleGenerator::makeIdCache',
    ],
    anchors: [
      'TEST_F(ConstructTripleGeneratorTest, rowOffsetAccumulatesAcrossTables)',
      'ConstructTripleGenerator::evaluateTables(',
      'ConstructTripleGenerator::makeIdCache(tmpl)',
    ],
    appliedTokens: [
      'ConstructTripleGenerator::xpodTestEvaluateTables(',
      'ConstructTripleGenerator::xpodTestMakeIdCache(tmpl)',
    ],
    alreadyPatchedMessage: 'already contains the Xpod ConstructTripleGeneratorTest private-access overlay',
  },


  {
    patchPath: path.join(patchesRoot, 'qlever-export-query-execution-trees-test-accessor.patch'),
    target: 'src/engine/ExportQueryExecutionTrees.h',
    patchTokens: [
      'xpodTestGetIdTables',
      'xpodTestComputeResultAsQLeverJSON',
      'xpodTestCompensateForLimitOffsetClause',
      'upstream-test overlay',
      'Product code must not use',
    ],
    anchors: [
      'class ExportQueryExecutionTrees',
      'computeResultAsQLeverJSON',
      'static ad_utility::InputRangeTypeErased<TableConstRefWithVocab> getIdTables',
      'static void compensateForLimitOffsetClause',
      'static ad_utility::InputRangeTypeErased<TableWithRange> getRowIndices',
    ],
    appliedTokens: [
      'xpodTestGetIdTables',
      'xpodTestComputeResultAsQLeverJSON',
      'xpodTestCompensateForLimitOffsetClause',
    ],
    alreadyPatchedMessage: 'already contains the Xpod ExportQueryExecutionTrees upstream-test accessor overlay',
  },

  {
    patchPath: path.join(patchesRoot, 'qlever-export-query-execution-trees-test-access.patch'),
    target: 'test/ExportQueryExecutionTreesTest.cpp',
    patchTokens: [
      'xpodTestGetIdTables',
      'xpodTestComputeResultAsQLeverJSON',
      'xpodTestCompensateForLimitOffsetClause',
      'ExportQueryExecutionTrees::getIdTables',
      'ExportQueryExecutionTrees::computeResultAsQLeverJSON',
      'ExportQueryExecutionTrees::compensateForLimitOffsetClause',
    ],
    anchors: [
      'TEST(ExportQueryExecutionTrees, getIdTablesReturnsSingletonIterator)',
      'ExportQueryExecutionTrees::getIdTables(result)',
      'ExportQueryExecutionTrees::computeResultAsQLeverJSON(',
      'ExportQueryExecutionTrees::compensateForLimitOffsetClause(limit, *qet1)',
    ],
    appliedTokens: [
      'ExportQueryExecutionTrees::xpodTestGetIdTables(result)',
      'ExportQueryExecutionTrees::xpodTestComputeResultAsQLeverJSON(',
      'ExportQueryExecutionTrees::xpodTestCompensateForLimitOffsetClause(limit, *qet1)',
    ],
    alreadyPatchedMessage: 'already contains the Xpod ExportQueryExecutionTreesTest private-access overlay',
  },


  {
    patchPath: path.join(patchesRoot, 'qlever-service-test-accessor.patch'),
    target: 'src/engine/Service.h',
    patchTokens: [
      'xpodTestSiblingInfo',
      'upstream-test overlay',
      'Product code must not use',
    ],
    anchors: [
      'class Service : public Operation',
      'std::optional<SiblingInfo> siblingInfo_;',
      'precomputeSiblingResult',
    ],
    appliedTokens: [
      'xpodTestSiblingInfo',
      'return siblingInfo_;',
    ],
    alreadyPatchedMessage: 'already contains the Xpod Service upstream-test sibling-info accessor overlay',
  },

  {
    patchPath: path.join(patchesRoot, 'qlever-service-test-access.patch'),
    target: 'test/ServiceTest.cpp',
    patchTokens: [
      'xpodTestSiblingInfo',
      'siblingInfo_',
    ],
    anchors: [
      'serviceOperation5.siblingInfo_.emplace',
      'service->siblingInfo_.has_value()',
      'service->siblingInfo_.reset()',
    ],
    appliedTokens: [
      'xpodTestSiblingInfo().emplace',
      'xpodTestSiblingInfo().has_value()',
      'xpodTestSiblingInfo().reset()',
    ],
    alreadyPatchedMessage: 'already contains the Xpod ServiceTest private-access overlay',
  },

  {
    patchPath: path.join(patchesRoot, 'qlever-located-triples-test-accessor.patch'),
    target: 'src/index/LocatedTriples.h',
    patchTokens: [
      'XPOD_QLEVER_ADAPTER_ENABLE_QLEVER',
      'upstream-test overlay',
      'Product code must not use',
    ],
    anchors: [
      'class LocatedTriplesPerBlock',
      'private:',
      'numTriples_',
      'map_',
      'FRIEND_TEST(LocatedTriplesTest, numTriplesInBlock)',
    ],
    appliedTokens: [
      'XPOD_QLEVER_ADAPTER_ENABLE_QLEVER',
      'Product code must not use',
      'state seams',
      'public:',
      'private:',
    ],
    alreadyPatchedMessage: 'already contains the Xpod LocatedTriples upstream-test access overlay',
  },

  {
    patchPath: path.join(patchesRoot, 'qlever-delta-triples-test-accessor.patch'),
    target: 'src/index/DeltaTriples.h',
    patchTokens: [
      'XPOD_QLEVER_ADAPTER_ENABLE_QLEVER',
      'upstream-test overlay',
      'Product code must not use',
    ],
    anchors: [
      'class DeltaTriples',
      'TriplesToHandles',
      'rewriteLocalVocabEntriesAndBlankNodes',
      'class DeltaTriplesManager',
      'deltaTriples_',
    ],
    appliedTokens: [
      'XPOD_QLEVER_ADAPTER_ENABLE_QLEVER',
      'Product code must not use',
      'delta-triples state seams',
      'manager state',
      '#ifdef XPOD_QLEVER_ADAPTER_ENABLE_QLEVER\n public:\n#else\n private:\n#endif\n  // Remap the `Id`',
      'Id& id);\n#endif\n\n#ifdef XPOD_QLEVER_ADAPTER_ENABLE_QLEVER',
      'public:',
      'private:',
    ],
    alreadyPatchedMessage: 'already contains the Xpod DeltaTriples upstream-test access overlay',
  },

  {
    patchPath: path.join(patchesRoot, 'qlever-local-vocab-entry-test-accessor.patch'),
    target: 'src/index/LocalVocabEntry.h',
    patchTokens: [
      'XPOD_QLEVER_ADAPTER_ENABLE_QLEVER',
      'upstream-test overlay',
      'Product code must not use',
    ],
    anchors: [
      'class alignas(16) LocalVocabEntry',
      'FRIEND_TEST(TripleComponent, toValueId)',
      'lowerBoundInVocab_',
      'upperBoundInVocab_',
      'positionInVocabKnown_',
    ],
    appliedTokens: [
      'XPOD_QLEVER_ADAPTER_ENABLE_QLEVER',
      'Product code must not use',
      'local-vocab-entry cache seams',
      'public:',
      'private:',
    ],
    alreadyPatchedMessage: 'already contains the Xpod LocalVocabEntry upstream-test access overlay',
  },

  {
    patchPath: path.join(patchesRoot, 'qlever-index-impl-test-accessor.patch'),
    target: 'src/index/IndexImpl.h',
    patchTokens: [
      'XPOD_QLEVER_ADAPTER_ENABLE_QLEVER',
      'upstream-test overlay',
      'Product code must not use',
    ],
    anchors: [
      'class IndexImpl',
      'protected:',
      'configurationJson_',
      'avgNumDistinctPredicatesPerSubject_',
      'numSubjects_',
    ],
    appliedTokens: [
      'XPOD_QLEVER_ADAPTER_ENABLE_QLEVER',
      'Product code must not use',
      'index-internal state seams',
      'public:',
      'protected:',
    ],
    alreadyPatchedMessage: 'already contains the Xpod IndexImpl upstream-test access overlay',
  },

  {
    patchPath: path.join(patchesRoot, 'qlever-graph-name-manager-test-accessor.patch'),
    target: 'src/index/GraphNameManager.h',
    patchTokens: [
      'XPOD_QLEVER_ADAPTER_ENABLE_QLEVER',
      'upstream-test overlay',
      'Product code must not use',
    ],
    anchors: [
      'class GraphNameManager',
      'prefixWithoutBraces_',
      'nextUnallocatedGraph_',
      'FRIEND_TEST(IndexImpl, graphNameManagerIntegration)',
    ],
    appliedTokens: [
      'XPOD_QLEVER_ADAPTER_ENABLE_QLEVER',
      'Product code must not use',
      'graph-name-manager state seams',
      'public:',
      'private:',
    ],
    alreadyPatchedMessage: 'already contains the Xpod GraphNameManager upstream-test access overlay',
  },

  {
    patchPath: path.join(patchesRoot, 'qlever-sparql-protocol-test-accessor.patch'),
    target: 'src/engine/SparqlProtocol.h',
    patchTokens: [
      'XPOD_QLEVER_ADAPTER_ENABLE_QLEVER',
      'upstream-test overlay',
      'Product code must not use',
    ],
    anchors: [
      'class SparqlProtocol',
      'parseGET',
      'parseUrlencodedPOST',
      'parseSPARQLPOST',
      'parseGraphStoreProtocolDirect',
    ],
    appliedTokens: [
      'XPOD_QLEVER_ADAPTER_ENABLE_QLEVER',
      'Product code must not use these as protocol parsing',
      'seams',
      'public:',
      'private:',
    ],
    alreadyPatchedMessage: 'already contains the Xpod SparqlProtocol upstream-test access overlay',
  },

  {
    patchPath: path.join(patchesRoot, 'qlever-parsed-request-builder-test-accessor.patch'),
    target: 'src/engine/ParsedRequestBuilder.h',
    patchTokens: [
      'XPOD_QLEVER_ADAPTER_ENABLE_QLEVER',
      'upstream-test overlay',
      'Product code must not use',
    ],
    anchors: [
      'struct ParsedRequestBuilder',
      'private:',
      'parameterIsContainedExactlyOnce',
      'extractTargetGraph',
      'determineAccessToken',
    ],
    appliedTokens: [
      'XPOD_QLEVER_ADAPTER_ENABLE_QLEVER',
      'Product code must not use these as request parsing',
      'seams',
      'public:',
      'private:',
    ],
    alreadyPatchedMessage: 'already contains the Xpod ParsedRequestBuilder upstream-test access overlay',
  },


  {
    patchPath: path.join(patchesRoot, 'qlever-execute-update-test-accessor.patch'),
    target: 'src/engine/ExecuteUpdate.h',
    patchTokens: [
      'XPOD_QLEVER_ADAPTER_ENABLE_QLEVER',
      'upstream-test overlay',
      'Product code must not use',
    ],
    anchors: [
      'class ExecuteUpdate',
      'private:',
      'transformTriplesTemplate',
      'computeGraphUpdateQuads',
    ],
    appliedTokens: [
      'XPOD_QLEVER_ADAPTER_ENABLE_QLEVER',
      'Product code must not use these as update',
      'execution seams',
      'public:',
      'private:',
    ],
    alreadyPatchedMessage: 'already contains the Xpod ExecuteUpdate upstream-test access overlay',
  },


  {
    patchPath: path.join(patchesRoot, 'qlever-graph-store-protocol-test-accessor.patch'),
    target: 'src/engine/GraphStoreProtocol.h',
    patchTokens: [
      'XPOD_QLEVER_ADAPTER_ENABLE_QLEVER',
      'upstream-test overlay',
      'Product code must not use',
    ],
    anchors: [
      'class GraphStoreProtocol',
      'private:',
      'extractMediatype',
      'transformGraphStoreProtocol',
    ],
    appliedTokens: [
      'XPOD_QLEVER_ADAPTER_ENABLE_QLEVER',
      'Product code must not use these as graph-store seams',
      'public:',
      'private:',
    ],
    alreadyPatchedMessage: 'already contains the Xpod GraphStoreProtocol upstream-test access overlay',
  },


  {
    patchPath: path.join(patchesRoot, 'qlever-materialized-views-test-accessor.patch'),
    target: 'src/engine/MaterializedViews.h',
    patchTokens: [
      'xpodTestParsedQuery',
      'upstream-test overlay',
      'Product code must not use',
    ],
    anchors: [
      'class MaterializedView',
      'std::optional<ParsedQuery> parsedQuery_;',
      'const std::optional<ParsedQuery>& parsedQuery() const',
    ],
    appliedTokens: [
      'xpodTestParsedQuery',
      'return parsedQuery_;',
    ],
    alreadyPatchedMessage: 'already contains the Xpod MaterializedView upstream-test parsed-query accessor overlay',
  },

  {
    patchPath: path.join(patchesRoot, 'qlever-materialized-views-server-test-accessor.patch'),
    target: 'src/engine/Server.h',
    patchTokens: [
      'xpodTestWriteMaterializedView',
      'xpodTestQlever',
      'Product code must not use',
    ],
    anchors: [
      'class Server',
      'qlever::Qlever qlever_;',
      'void writeMaterializedView(',
    ],
    appliedTokens: [
      'xpodTestWriteMaterializedView',
      'xpodTestQlever',
      'return qlever_;',
    ],
    alreadyPatchedMessage: 'already contains the Xpod Server upstream-test materialized-view accessor overlay',
  },

  {
    patchPath: path.join(patchesRoot, 'qlever-materialized-views-test-access.patch'),
    target: 'test/MaterializedViewsTest.cpp',
    patchTokens: [
      'xpodTestParsedQuery',
      'xpodTestWriteMaterializedView',
      'xpodTestQlever',
    ],
    anchors: [
      'view->parsedQuery_ = std::nullopt;',
      'server.writeMaterializedView("testViewFromServer", query, requestTimer,',
      'server.qlever_.materializedViewsManager()->isViewLoaded(',
    ],
    appliedTokens: [
      'view->xpodTestParsedQuery() = std::nullopt;',
      'server.xpodTestWriteMaterializedView("testViewFromServer", query, requestTimer,',
      'server.xpodTestQlever().materializedViewsManager()->isViewLoaded(',
    ],
    alreadyPatchedMessage: 'already contains the Xpod MaterializedViewsTest private-access overlay',
  },


  {
    patchPath: path.join(patchesRoot, 'qlever-expression-value-getters-physical-string.patch'),
    target: 'src/engine/sparqlExpressions/SparqlExpressionValueGetters.cpp',
    patchTokens: [
      'XpodQleverPhysicalIndex.hpp',
      'XpodQleverPhysicalValueIdContextBridge.hpp',
      'xpodPhysicalStringForId',
      'xpodPhysicalTermKindForId',
      'context->_qec.xpodPhysicalIndex()',
      'physicalIndex->decodeQleverId',
      'physicalIndex->resolveTerms',
      'XPOD_RDF_TERM_LITERAL',
      'physicalValueIdEntry',
      'physicalEntry->asLiteralOrIri()',
      'physicalLiteralOrIriIdFromContext',
      'ql::exportIds::idToStringAndType<true>',
    ],
    anchors: [
      '#include "engine/sparqlExpressions/SparqlExpressionValueGetters.h"',
      'using namespace sparqlExpression::detail;',
      'StringValueGetter::operator()',
      'ql::exportIds::idToStringAndType<true>',
    ],
    appliedTokens: [
      'XpodQleverPhysicalIndex.hpp',
      'XpodQleverPhysicalValueIdContextBridge.hpp',
      'xpodPhysicalStringForId',
      'xpodPhysicalTermKindForId',
      'context->_qec.xpodPhysicalIndex()',
      'physicalIndex->decodeQleverId',
      'physicalIndex->resolveTerms',
      'XPOD_RDF_TERM_LITERAL',
      'physicalValueIdEntry',
      'physicalEntry->asLiteralOrIri()',
      'physicalLiteralOrIriIdFromContext',
    ],
    alreadyPatchedMessage: 'already contains the Xpod expression string-value overlay',
  },
  {
    patchPath: path.join(patchesRoot, 'qlever-string-expressions-physical-iri.patch'),
    target: 'src/engine/sparqlExpressions/StringExpressions.cpp',
    patchTokens: [
      'Xpod may canonicalize the generated IRI to a physical dictionary Id.',
    ],
    anchors: [
      'AD_CORRECTNESS_CHECK(std::get<Id>(iri).isUndefined());',
      'return std::get<Id>(iri);',
    ],
    appliedTokens: [
      'Xpod may canonicalize the generated IRI to a physical dictionary Id.',
    ],
    alreadyPatchedMessage: 'already accepts canonical physical ids from IRI/URI expressions',
  },
  {
    patchPath: path.join(patchesRoot, 'qlever-service-physical-disabled.patch'),
    target: 'src/engine/Service.cpp',
    patchTokens: [
      'XpodQleverPhysicalIndexScanContextBridge.hpp',
      'physicalIndexFromContext(*getExecutionContext())',
      'SERVICE federation is disabled',
    ],
    anchors: [
      '#include "engine/Service.h"',
      'Result Service::computeResult(bool requestLaziness)',
      'return computeResultImpl(requestLaziness);',
    ],
    appliedTokens: [
      'XpodQleverPhysicalIndexScanContextBridge.hpp',
      'physicalIndexFromContext(*getExecutionContext())',
      'SERVICE federation is disabled',
    ],
    alreadyPatchedMessage: 'already disables external SERVICE for physical backends',
  },
  {
    patchPath: path.join(patchesRoot, 'qlever-operation-physical-cancellation.patch'),
    target: 'src/engine/Operation.h',
    patchTokens: [
      'XpodQleverPhysicalCancellationContextBridge.hpp',
      'physicalCancellationRequested(_executionContext)',
      'CancellationState::MANUAL',
    ],
    anchors: [
      '#include "engine/Result.h"',
      'cancellationHandle_->throwIfCancelled(location,',
    ],
    appliedTokens: [
      'XpodQleverPhysicalCancellationContextBridge.hpp',
      'physicalCancellationRequested(_executionContext)',
      'CancellationState::MANUAL',
    ],
    alreadyPatchedMessage: 'already polls Xpod physical cancellation from QLever operations',
  },
  {
    patchPath: path.join(patchesRoot, 'qlever-index-default-blank-node-manager.patch'),
    target: 'src/index/IndexImpl.cpp',
    patchTokens: [
      'IndexImpl::IndexImpl',
      'blankNodeManager_ = std::make_unique<ad_utility::BlankNodeManager>(0)',
    ],
    anchors: [
      'IndexImpl::IndexImpl(ad_utility::AllocatorWithLimit<Id> allocator)',
      'deltaTriples_.emplace(*this);',
    ],
    appliedTokens: [
      'blankNodeManager_ = std::make_unique<ad_utility::BlankNodeManager>(0)',
    ],
    alreadyPatchedMessage: 'already initializes the empty QLever Index blank-node manager',
  },
  {
    patchPath: path.join(patchesRoot, 'qlever-aggregate-physical-comparator.patch'),
    target: 'src/engine/sparqlExpressions/AggregateExpression.h',
    patchTokens: [
      'XpodQleverPhysicalValueIdContextBridge.hpp',
      'comparePhysicalValueIds',
      'physicalCompare',
    ],
    anchors: [
      '#include "engine/sparqlExpressions/LiteralExpression.h"',
      'struct MinMaxLambdaForAllTypes',
      'return std::get<Id>(actualImpl(a, b));',
    ],
    appliedTokens: [
      'XpodQleverPhysicalValueIdContextBridge.hpp',
      'comparePhysicalValueIds',
      'physicalCompare',
    ],
    alreadyPatchedMessage: 'already contains the Xpod aggregate physical comparator overlay',
  },
  {
    patchPath: path.join(patchesRoot, 'qlever-relational-expression-physical-id.patch'),
    target: 'src/engine/sparqlExpressions/LiteralExpression.h',
    patchTokens: [
      'XpodQleverPhysicalValueIdContextBridge.hpp',
      'physicalComponentIdFromContext',
      'IdOrLocalVocabEntry{*physicalId}',
    ],
    anchors: [
      '#include "engine/sparqlExpressions/SparqlExpression.h"',
      'class LiteralExpression : public SparqlExpression',
      'TripleComponent tc{s};',
      'tc.toValueId(context->_qec.getIndex())',
    ],
    appliedTokens: [
      'XpodQleverPhysicalValueIdContextBridge.hpp',
      'physicalComponentIdFromContext',
      'IdOrLocalVocabEntry{*physicalId}',
    ],
    alreadyPatchedMessage: 'already contains the Xpod literal-expression physical-id overlay',
  },
  {
    patchPath: path.join(patchesRoot, 'qlever-relational-expression-physical-id.patch'),
    target: 'src/engine/sparqlExpressions/RelationalExpressionHelpers.h',
    patchTokens: [
      'XpodQleverPhysicalValueIdContextBridge.hpp',
      'comparePhysicalValueIdsForRelational',
      'comparisonForIncompatibleTypes>(x, y, Comp, ctx)',
      'return *physicalResult',
    ],
    anchors: [
      '#include "engine/sparqlExpressions/SparqlExpression.h"',
      'inline const auto compareIdsOrStrings',
      'auto x = makeValueId(a, ctx);',
      'valueIdComparators::compareIds<',
    ],
    appliedTokens: [
      'XpodQleverPhysicalValueIdContextBridge.hpp',
      'comparePhysicalValueIdsForRelational',
    ],
    alreadyPatchedMessage: 'already contains the Xpod relational-expression physical comparator overlay',
  },
  {
    patchPath: path.join(patchesRoot, 'qlever-relational-expression-physical-id.patch'),
    target: 'src/engine/sparqlExpressions/RelationalExpressions.cpp',
    patchTokens: [
      'XpodQleverPhysicalValueIdContextBridge.hpp',
      'context->_qec.xpodPhysicalIndex() == nullptr',
    ],
    anchors: [
      '#include "engine/sparqlExpressions/RelationalExpressions.h"',
      'evaluateWithBinarySearch',
      'context->_columnsByWhichResultIsSorted',
    ],
    appliedTokens: [
      'XpodQleverPhysicalValueIdContextBridge.hpp',
      'context->_qec.xpodPhysicalIndex() == nullptr',
    ],
    alreadyPatchedMessage: 'already contains the Xpod relational-expression physical binary-search guard',
  },
  {
    patchPath: path.join(patchesRoot, 'qlever-orderby-physical-comparator.patch'),
    target: 'src/engine/OrderBy.cpp',
    patchTokens: [
      'XpodQleverPhysicalValueIdContextBridge.hpp',
      'comparePhysicalValueIds',
      'getExecutionContext()->xpodPhysicalIndex()',
      'getExecutionContext()->getLocalVocabContext()',
      'subRes->localVocab()',
      'auto comparison = [this, &subRes]',
      'valueIdComparators::compareIds<',
    ],
    anchors: [
      '#include "engine/OrderBy.h"',
      'Result OrderBy::computeResult',
      'valueIdComparators::compareIds<',
      'return isLessThan != isDescending;',
    ],
    appliedTokens: [
      'XpodQleverPhysicalValueIdContextBridge.hpp',
      'comparePhysicalValueIds',
      'getExecutionContext()->xpodPhysicalIndex()',
      'getExecutionContext()->getLocalVocabContext()',
      'subRes->localVocab()',
      'auto comparison = [this, &subRes]',
    ],
    alreadyPatchedMessage: 'already contains the Xpod OrderBy physical comparator overlay',
  },
  {
    patchPath: path.join(patchesRoot, 'qlever-spatial-join-physical-wkt.patch'),
    target: 'src/engine/SpatialJoinAlgorithms.cpp',
    patchTokens: [
      'XpodQleverPhysicalSpatialContextBridge.hpp',
      'physicalWktLiteralFromContext',
      'preResolvedWkt',
      'value.has_value()',
    ],
    anchors: [
      '#include "engine/SpatialJoinAlgorithms.h"',
      'SpatialJoinAlgorithms::getAnyGeometry(',
      'ql::exportIds::idToStringAndType(',
    ],
    appliedTokens: [
      'XpodQleverPhysicalSpatialContextBridge.hpp',
      'physicalWktLiteralFromContext',
      'std::move(physicalWkt)',
    ],
    alreadyPatchedMessage: 'already contains the Xpod SpatialJoin physical-WKT overlay',
  },
  {
    patchPath: path.join(patchesRoot, 'qlever-spatial-join-physical-wkt.patch'),
    target: 'src/engine/SpatialJoinParser.cpp',
    patchTokens: [
      'if (!job.wkt.empty())',
      'std::move(preResolvedWkt)',
    ],
    anchors: [
      'void WKTParser::processQueue(size_t t)',
      'void WKTParser::addValueIdToQueue(',
      '_curBatch.push_back({valueId, rowIndex, side, "", std::move(boundingBox)})',
    ],
    appliedTokens: [
      'if (!job.wkt.empty())',
      'std::move(preResolvedWkt)',
    ],
    alreadyPatchedMessage: 'already accepts pre-resolved physical WKT before parser worker dispatch',
  },
  {
    patchPath: path.join(patchesRoot, 'qlever-spatial-join-physical-wkt.patch'),
    target: 'src/engine/SpatialJoinParser.h',
    patchTokens: [
      'std::string preResolvedWkt = {}',
    ],
    anchors: [
      'class WKTParser',
      'void addValueIdToQueue(ValueId valueId, size_t rowIndex, bool side,',
      'std::optional<BoundingBox> boundingBox);',
    ],
    appliedTokens: [
      'std::string preResolvedWkt = {}',
    ],
    alreadyPatchedMessage: 'already exposes pre-resolved physical WKT queue input',
  },
];

function fail(message, error) {
  console.error(`[qlever-upstream-patches] ${message}`);
  if (error) {
    console.error(error instanceof Error ? error.message : String(error));
  }
  process.exit(1);
}

function readArg(name) {
  const index = process.argv.indexOf(name);
  if (index === -1) {
    return undefined;
  }
  return process.argv[index + 1];
}

function gitApplyEnvironment(sourceDir) {
  const ceiling = path.dirname(sourceDir);
  const existingCeilings = process.env.GIT_CEILING_DIRECTORIES;
  return {
    ...process.env,
    GIT_CEILING_DIRECTORIES: existingCeilings
      ? `${ceiling}${path.delimiter}${existingCeilings}`
      : ceiling,
  };
}

const qleverSourceInput = readArg('--qlever-source') || process.env.XPOD_QLEVER_SOURCE_DIR;
const qleverSource = qleverSourceInput ? path.resolve(qleverSourceInput) : '';
const patchInput = readArg('--patch');
const shouldApply = process.argv.includes('--apply');

if (!qleverSource) {
  fail('missing --qlever-source or XPOD_QLEVER_SOURCE_DIR');
}
const specs = patchInput
  ? patchSpecs.filter((spec) => path.resolve(spec.patchPath) === path.resolve(patchInput))
  : patchSpecs;
if (specs.length === 0) {
  fail(`unknown QLever upstream patch asset: ${patchInput}`);
}

let checked = 0;
const gitEnv = gitApplyEnvironment(qleverSource);
for (const spec of specs) {
  const patchPath = path.resolve(spec.patchPath);
  if (!fs.existsSync(patchPath)) {
    fail(`missing patch asset: ${path.relative(repoRoot, patchPath)}`);
  }
  const targetPath = path.join(qleverSource, spec.target);
  if (!fs.existsSync(targetPath)) {
    fail(`missing upstream source file: ${targetPath}`);
  }

  const patch = fs.readFileSync(patchPath, 'utf8');
  for (const required of spec.patchTokens) {
    if (!patch.includes(required)) {
      fail(`patch asset is missing required token: ${required}`);
    }
  }

  const source = fs.readFileSync(targetPath, 'utf8');
  const alreadyPatched = spec.appliedTokens.every((token) => source.includes(token));
  if (alreadyPatched) {
    console.log(`[qlever-upstream-patches] OK: ${targetPath} ${spec.alreadyPatchedMessage}.`);
    checked += 1;
    continue;
  }
  for (const required of spec.anchors) {
    if (!source.includes(required)) {
      fail(`upstream ${spec.target} does not expose expected patch anchor: ${required}`);
    }
  }

  try {
    execFileSync('git', [
      'apply',
      '--check',
      patchPath,
    ], { cwd: qleverSource, stdio: 'pipe', env: gitEnv });
    if (shouldApply) {
      execFileSync('git', [
        'apply',
        patchPath,
      ], { cwd: qleverSource, stdio: 'pipe', env: gitEnv });
      const appliedSource = fs.readFileSync(targetPath, 'utf8');
      if (!spec.appliedTokens.every((token) => appliedSource.includes(token))) {
        fail(`QLever upstream patch command completed but ${spec.target} does not contain the expected overlay`);
      }
    }
  } catch (error) {
    fail(`QLever upstream patch does not apply cleanly: ${path.relative(repoRoot, patchPath)}`, error);
  }

  console.log(
    `[qlever-upstream-patches] OK: ${path.relative(repoRoot, patchPath)} applies to ${targetPath}`,
  );
  checked += 1;
}

console.log(`[qlever-upstream-patches] OK: checked ${checked} patch(es).`);
