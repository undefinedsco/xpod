cmake_minimum_required(VERSION 3.20)

project(xpod_qlever_adapter LANGUAGES CXX)

option(XPOD_QLEVER_ADAPTER_ENABLE_QLEVER "Build the adapter against an upstream QLever source tree" OFF)
option(XPOD_QLEVER_ADAPTER_ENABLE_VECTOR "Enable the QLever vector operation leaf" ON)
set(XPOD_QLEVER_SOURCE_DIR "" CACHE PATH "Path to the upstream QLever source tree")
set(XPOD_QLEVER_DEPENDENCY_INCLUDE_DIRS "" CACHE STRING "Additional include directories for upstream QLever dependencies")
set(XPOD_QLEVER_DEPENDENCY_COMPILE_DEFINITIONS "" CACHE STRING "Compile definitions inherited from the upstream QLever build")

set(XPOD_QLEVER_ADAPTER_SOURCES
  src/xpod_qlever_adapter.cpp
  src/XpodQleverExecutor.cpp
)

if(XPOD_QLEVER_ADAPTER_ENABLE_QLEVER)
  list(APPEND XPOD_QLEVER_ADAPTER_SOURCES
    src/XpodQleverBridge.cpp
  )
endif()

add_library(xpod_qlever_adapter STATIC
  ${XPOD_QLEVER_ADAPTER_SOURCES}
)

target_compile_features(xpod_qlever_adapter PUBLIC cxx_std_17)

target_include_directories(xpod_qlever_adapter
  PUBLIC
    ${CMAKE_CURRENT_SOURCE_DIR}/include
    ${CMAKE_CURRENT_SOURCE_DIR}/../rdf_protocol/include
  PRIVATE
    ${CMAKE_CURRENT_SOURCE_DIR}/../include
)

target_compile_options(xpod_qlever_adapter
  PRIVATE
    $<$<CXX_COMPILER_ID:Clang,AppleClang,GNU>:-Wall -Wextra -Werror>
)

if(XPOD_QLEVER_ADAPTER_ENABLE_QLEVER)
  if(XPOD_QLEVER_DEPENDENCY_COMPILE_DEFINITIONS)
    target_compile_definitions(xpod_qlever_adapter PRIVATE ${XPOD_QLEVER_DEPENDENCY_COMPILE_DEFINITIONS})
  endif()
  if(NOT XPOD_QLEVER_SOURCE_DIR)
    message(FATAL_ERROR "XPOD_QLEVER_SOURCE_DIR is required when XPOD_QLEVER_ADAPTER_ENABLE_QLEVER=ON")
  endif()

  get_filename_component(XPOD_QLEVER_SOURCE_DIR "${XPOD_QLEVER_SOURCE_DIR}" ABSOLUTE)
  set(XPOD_QLEVER_REQUIRED_HEADERS
    "${XPOD_QLEVER_SOURCE_DIR}/src/libqlever/Qlever.h"
    "${XPOD_QLEVER_SOURCE_DIR}/src/parser/SparqlParser.h"
    "${XPOD_QLEVER_SOURCE_DIR}/src/parser/ParsedQuery.h"
    "${XPOD_QLEVER_SOURCE_DIR}/src/parser/SparqlTriple.h"
    "${XPOD_QLEVER_SOURCE_DIR}/src/engine/IndexScan.h"
    "${XPOD_QLEVER_SOURCE_DIR}/src/engine/idTable/IdTable.h"
    "${XPOD_QLEVER_SOURCE_DIR}/src/engine/Join.h"
    "${XPOD_QLEVER_SOURCE_DIR}/src/engine/Operation.h"
    "${XPOD_QLEVER_SOURCE_DIR}/src/engine/QueryExecutionContext.h"
    "${XPOD_QLEVER_SOURCE_DIR}/src/engine/QueryExecutionTree.h"
    "${XPOD_QLEVER_SOURCE_DIR}/src/engine/QueryPlanner.h"
    "${XPOD_QLEVER_SOURCE_DIR}/src/engine/Result.h"
    "${XPOD_QLEVER_SOURCE_DIR}/src/engine/RuntimeInformation.h"
    "${XPOD_QLEVER_SOURCE_DIR}/src/global/Id.h"
    "${XPOD_QLEVER_SOURCE_DIR}/src/index/GraphFilter.h"
    "${XPOD_QLEVER_SOURCE_DIR}/src/index/Index.h"
    "${XPOD_QLEVER_SOURCE_DIR}/src/index/LocalVocab.h"
    "${XPOD_QLEVER_SOURCE_DIR}/src/index/Permutation.h"
    "${XPOD_QLEVER_SOURCE_DIR}/src/index/ScanSpecification.h"
    "${XPOD_QLEVER_SOURCE_DIR}/src/util/CancellationHandle.h"
  )

  set(XPOD_QLEVER_MISSING_HEADERS "")
  foreach(XPOD_QLEVER_REQUIRED_HEADER IN LISTS XPOD_QLEVER_REQUIRED_HEADERS)
    if(NOT EXISTS "${XPOD_QLEVER_REQUIRED_HEADER}")
      list(APPEND XPOD_QLEVER_MISSING_HEADERS "${XPOD_QLEVER_REQUIRED_HEADER}")
    endif()
  endforeach()

  if(XPOD_QLEVER_MISSING_HEADERS)
    string(REPLACE ";" "\n  " XPOD_QLEVER_MISSING_HEADERS_MESSAGE "${XPOD_QLEVER_MISSING_HEADERS}")
    message(FATAL_ERROR "XPOD_QLEVER_SOURCE_DIR does not look like an upstream QLever source tree; missing:\n  ${XPOD_QLEVER_MISSING_HEADERS_MESSAGE}")
  endif()

  set(XPOD_QLEVER_INDEX_SCAN_SOURCE "${XPOD_QLEVER_SOURCE_DIR}/src/engine/IndexScan.cpp")
  if(NOT EXISTS "${XPOD_QLEVER_INDEX_SCAN_SOURCE}")
    message(FATAL_ERROR "XPOD_QLEVER_SOURCE_DIR does not include src/engine/IndexScan.cpp; cannot verify the Xpod lazy-scan overlay")
  endif()
  file(READ "${XPOD_QLEVER_INDEX_SCAN_SOURCE}" XPOD_QLEVER_INDEX_SCAN_SOURCE_TEXT)
  string(FIND "${XPOD_QLEVER_INDEX_SCAN_SOURCE_TEXT}" "materializedScanFromQleverScanSpecAndBlocks" XPOD_QLEVER_INDEX_SCAN_MATERIALIZED_OVERLAY_POS)
  string(FIND "${XPOD_QLEVER_INDEX_SCAN_SOURCE_TEXT}" "xpodIndexScanProjectedSlots" XPOD_QLEVER_INDEX_SCAN_PROJECTED_SLOTS_POS)
  string(FIND "${XPOD_QLEVER_INDEX_SCAN_SOURCE_TEXT}" "lazyScanRangeFromQleverScanSpecAndBlocks" XPOD_QLEVER_INDEX_SCAN_OVERLAY_POS)
  string(FIND "${XPOD_QLEVER_INDEX_SCAN_SOURCE_TEXT}" "!scanSpecAndBlocksIsPrefiltered_" XPOD_QLEVER_INDEX_SCAN_BROAD_OVERLAY_POS)
  string(FIND "${XPOD_QLEVER_INDEX_SCAN_SOURCE_TEXT}" "sizeEstimateFromQleverScanSpecAndBlocks" XPOD_QLEVER_INDEX_SCAN_SIZE_OVERLAY_POS)
  string(FIND "${XPOD_QLEVER_INDEX_SCAN_SOURCE_TEXT}" "exactSizeFromQleverScanSpecAndBlocks" XPOD_QLEVER_INDEX_SCAN_EXACT_SIZE_OVERLAY_POS)
  string(FIND "${XPOD_QLEVER_INDEX_SCAN_SOURCE_TEXT}" "canUsePhysicalScanSpecAndBlocks" XPOD_QLEVER_INDEX_SCAN_SPEC_OVERLAY_POS)
  if(XPOD_QLEVER_INDEX_SCAN_MATERIALIZED_OVERLAY_POS EQUAL -1 OR XPOD_QLEVER_INDEX_SCAN_PROJECTED_SLOTS_POS EQUAL -1 OR XPOD_QLEVER_INDEX_SCAN_OVERLAY_POS EQUAL -1 OR XPOD_QLEVER_INDEX_SCAN_BROAD_OVERLAY_POS EQUAL -1 OR XPOD_QLEVER_INDEX_SCAN_SIZE_OVERLAY_POS EQUAL -1 OR XPOD_QLEVER_INDEX_SCAN_EXACT_SIZE_OVERLAY_POS EQUAL -1 OR XPOD_QLEVER_INDEX_SCAN_SPEC_OVERLAY_POS EQUAL -1)
    message(FATAL_ERROR "IndexScan.cpp is not patched with the Xpod lazy-scan overlay. Run node ${CMAKE_CURRENT_SOURCE_DIR}/../scripts/check-qlever-upstream-patches.cjs --qlever-source ${XPOD_QLEVER_SOURCE_DIR} --apply")
  endif()

  set(XPOD_QLEVER_QUERY_EXECUTION_CONTEXT_HEADER "${XPOD_QLEVER_SOURCE_DIR}/src/engine/QueryExecutionContext.h")
  file(READ "${XPOD_QLEVER_QUERY_EXECUTION_CONTEXT_HEADER}" XPOD_QLEVER_QUERY_EXECUTION_CONTEXT_TEXT)
  string(FIND "${XPOD_QLEVER_QUERY_EXECUTION_CONTEXT_TEXT}" "setXpodPhysicalIndex" XPOD_QLEVER_CONTEXT_SETTER_POS)
  string(FIND "${XPOD_QLEVER_QUERY_EXECUTION_CONTEXT_TEXT}" "xpodPhysicalIndex() const" XPOD_QLEVER_CONTEXT_GETTER_POS)
  if(XPOD_QLEVER_CONTEXT_SETTER_POS EQUAL -1 OR XPOD_QLEVER_CONTEXT_GETTER_POS EQUAL -1)
    message(FATAL_ERROR "QueryExecutionContext.h is not patched with the Xpod physical-index overlay. Run node ${CMAKE_CURRENT_SOURCE_DIR}/../scripts/check-qlever-upstream-patches.cjs --qlever-source ${XPOD_QLEVER_SOURCE_DIR} --apply")
  endif()

  set(XPOD_QLEVER_QUERY_PLANNER_SOURCE "${XPOD_QLEVER_SOURCE_DIR}/src/engine/QueryPlanner.cpp")
  if(NOT EXISTS "${XPOD_QLEVER_QUERY_PLANNER_SOURCE}")
    message(FATAL_ERROR "XPOD_QLEVER_SOURCE_DIR does not include src/engine/QueryPlanner.cpp; cannot verify the Xpod QueryPlanner physical-index overlay")
  endif()
  file(READ "${XPOD_QLEVER_QUERY_PLANNER_SOURCE}" XPOD_QLEVER_QUERY_PLANNER_SOURCE_TEXT)
  string(FIND "${XPOD_QLEVER_QUERY_PLANNER_SOURCE_TEXT}" "XpodQleverPhysicalPathSearchContextBridge.hpp" XPOD_QLEVER_QUERY_PLANNER_PATH_SEARCH_INCLUDE_POS)
  string(FIND "${XPOD_QLEVER_QUERY_PLANNER_SOURCE_TEXT}" "XpodQleverPhysicalIndexScanContextBridge.hpp" XPOD_QLEVER_QUERY_PLANNER_INCLUDE_POS)
  string(FIND "${XPOD_QLEVER_QUERY_PLANNER_SOURCE_TEXT}" "xpod::qlever::physicalIndexFromContext(*_qec) != nullptr" XPOD_QLEVER_QUERY_PLANNER_ALLOW_POS)
  string(FIND "${XPOD_QLEVER_QUERY_PLANNER_SOURCE_TEXT}" "xpod::qlever::physicalIndexFromContext(*_qec) == nullptr" XPOD_QLEVER_QUERY_PLANNER_GUARD_POS)
  string(FIND "${XPOD_QLEVER_QUERY_PLANNER_SOURCE_TEXT}" "_enablePatternTrick && !xpodPhysicalIndex" XPOD_QLEVER_QUERY_PLANNER_PATTERN_TRICK_GUARD_POS)
  string(FIND "${XPOD_QLEVER_QUERY_PLANNER_SOURCE_TEXT}" "physicalPathSearchConfigurationFromContext(*qec_, pathQuery)" XPOD_QLEVER_QUERY_PLANNER_PATH_SEARCH_POS)
  if(XPOD_QLEVER_QUERY_PLANNER_PATH_SEARCH_INCLUDE_POS EQUAL -1 OR XPOD_QLEVER_QUERY_PLANNER_INCLUDE_POS EQUAL -1 OR XPOD_QLEVER_QUERY_PLANNER_ALLOW_POS EQUAL -1 OR XPOD_QLEVER_QUERY_PLANNER_GUARD_POS EQUAL -1 OR XPOD_QLEVER_QUERY_PLANNER_PATTERN_TRICK_GUARD_POS EQUAL -1 OR XPOD_QLEVER_QUERY_PLANNER_PATH_SEARCH_POS EQUAL -1)
    message(FATAL_ERROR "QueryPlanner.cpp is not patched with the Xpod physical-index overlay. Run node ${CMAKE_CURRENT_SOURCE_DIR}/../scripts/check-qlever-upstream-patches.cjs --qlever-source ${XPOD_QLEVER_SOURCE_DIR} --apply")
  endif()

  function(xpod_qlever_require_overlay_token relative_source token overlay_label)
    set(source_path "${XPOD_QLEVER_SOURCE_DIR}/${relative_source}")
    if(NOT EXISTS "${source_path}")
      message(FATAL_ERROR "XPOD_QLEVER_SOURCE_DIR does not include ${relative_source}; cannot verify the ${overlay_label}")
    endif()
    file(READ "${source_path}" source_text)
    string(FIND "${source_text}" "${token}" token_pos)
    if(token_pos EQUAL -1)
      message(FATAL_ERROR "${relative_source} is not patched with the ${overlay_label}. Run node ${CMAKE_CURRENT_SOURCE_DIR}/../scripts/check-qlever-upstream-patches.cjs --qlever-source ${XPOD_QLEVER_SOURCE_DIR} --apply")
    endif()
  endfunction()

  xpod_qlever_require_overlay_token(
    "src/engine/Filter.cpp"
    "physicalFilterResultFromContext"
    "Xpod Filter bounded-expression overlay")
  xpod_qlever_require_overlay_token(
    "src/parser/sparqlParser/SparqlQleverVisitor.cpp"
    "visitFilterConjuncts"
    "Xpod FILTER conjunction pushdown overlay")

  xpod_qlever_require_overlay_token(
    "src/engine/GroupByImpl.cpp"
    "physicalIndexFromContext(*getExecutionContext()) == nullptr"
    "Xpod GroupBy physical-index optimization guard")
  xpod_qlever_require_overlay_token(
    "src/engine/OptionalJoin.cpp"
    "physicalIndexFromContext(*getExecutionContext()) == nullptr"
    "Xpod OptionalJoin physical-index prefilter guard")
  xpod_qlever_require_overlay_token(
    "src/engine/HasPredicateScan.cpp"
    "physicalHasPredicateResultFromContext"
    "Xpod HasPredicateScan physical distinct overlay")
  xpod_qlever_require_overlay_token(
    "src/engine/HasPredicateScan.cpp"
    "physicalHasPredicateSizeEstimateFromContext"
    "Xpod HasPredicateScan physical estimate overlay")
  xpod_qlever_require_overlay_token(
    "src/engine/QueryPlanner.cpp"
    "xpod::qlever::physicalIndexFromContext(*context) != nullptr"
    "Xpod HasPredicate physical-index planner guard")
  xpod_qlever_require_overlay_token(
    "src/engine/QueryPlanner.cpp"
    "bestPhysicalTextTermIndexFromContext"
    "Xpod physical text-anchor planner overlay")
  xpod_qlever_require_overlay_token(
    "src/engine/TransitivePathImpl.h"
    "physicalTransitivePathSideIdFromContext"
    "Xpod TransitivePath physical-id overlay")
  xpod_qlever_require_overlay_token(
    "src/engine/Values.cpp"
    "physicalValuesIdFromContext"
    "Xpod Values physical-id overlay")
  xpod_qlever_require_overlay_token(
    "src/engine/Describe.cpp"
    "physicalDescribeIdFromContext"
    "Xpod Describe physical-id overlay")
  xpod_qlever_require_overlay_token(
    "src/index/GraphFilter.h"
    "xpodPhysicalFilterType"
    "Xpod GraphFilter physical-scope overlay")
  xpod_qlever_require_overlay_token(
    "src/index/ScanSpecification.h"
    "xpodPhysicalLocalVocab"
    "Xpod ScanSpecification physical-local-vocab overlay")
  xpod_qlever_require_overlay_token(
    "src/engine/sparqlExpressions/SparqlExpressionValueGetters.cpp"
    "xpodPhysicalStringForId"
    "Xpod expression string-value overlay")
  xpod_qlever_require_overlay_token(
    "src/engine/sparqlExpressions/SparqlExpressionValueGetters.cpp"
    "inlineTypedLiteralIdFromEntry"
    "Xpod expression typed-literal overlay")
  xpod_qlever_require_overlay_token(
    "src/engine/sparqlExpressions/SparqlExpressionValueGetters.cpp"
    "DateValueGetter::Opt DateValueGetter::operator()"
    "Xpod expression physical-date overlay")
  xpod_qlever_require_overlay_token(
    "src/engine/sparqlExpressions/SparqlExpressionValueGetters.cpp"
    "physicalEntry->asLiteralOrIri()"
    "Xpod expression geometry-value overlay")
  xpod_qlever_require_overlay_token(
    "src/engine/sparqlExpressions/SparqlExpressionValueGetters.cpp"
    "physicalLiteralOrIriIdFromContext"
    "Xpod expression physical-id canonicalization overlay")
  xpod_qlever_require_overlay_token(
    "src/engine/sparqlExpressions/StringExpressions.cpp"
    "Xpod may canonicalize the generated IRI to a physical dictionary Id."
    "Xpod IRI/URI physical-id propagation overlay")
  xpod_qlever_require_overlay_token(
    "src/index/IndexImpl.cpp"
    "blankNodeManager_ = std::make_unique<ad_utility::BlankNodeManager>(0)"
    "Xpod empty-index blank-node manager overlay")
  xpod_qlever_require_overlay_token(
    "src/engine/sparqlExpressions/AggregateExpression.h"
    "comparePhysicalValueIds"
    "Xpod aggregate physical comparator overlay")
  xpod_qlever_require_overlay_token(
    "src/engine/sparqlExpressions/LiteralExpression.h"
    "physicalComponentIdFromContext"
    "Xpod literal-expression physical-id overlay")
  xpod_qlever_require_overlay_token(
    "src/engine/sparqlExpressions/RelationalExpressionHelpers.h"
    "comparePhysicalValueIds"
    "Xpod relational-expression physical comparator overlay")
  xpod_qlever_require_overlay_token(
    "src/engine/sparqlExpressions/RelationalExpressions.cpp"
    "context->_qec.xpodPhysicalIndex() == nullptr"
    "Xpod relational-expression physical binary-search guard")
  xpod_qlever_require_overlay_token(
    "src/engine/OrderBy.cpp"
    "comparePhysicalValueIds"
    "Xpod OrderBy physical comparator overlay")
  xpod_qlever_require_overlay_token(
    "src/engine/Sort.cpp"
    "IdTableUtils::sort(idTable, sortColumnIndices_);"
    "QLever internal Sort ValueId identity contract")
  xpod_qlever_require_overlay_token(
    "src/engine/SpatialJoinAlgorithms.cpp"
    "physicalWktLiteralFromContext"
    "Xpod SpatialJoin physical-WKT overlay")
  xpod_qlever_require_overlay_token(
    "src/engine/SpatialJoinParser.cpp"
    "std::move(preResolvedWkt)"
    "Xpod SpatialJoin physical-WKT worker handoff overlay")
  xpod_qlever_require_overlay_token(
    "src/engine/SpatialJoinParser.h"
    "std::string preResolvedWkt = {}"
    "Xpod SpatialJoin physical-WKT queue overlay")

  xpod_qlever_require_overlay_token(
    "src/engine/sparqlExpressions/RegexExpression.cpp"
    "xpodPhysicalPrefixRegexMatch"
    "Xpod prefix REGEX physical-string overlay")
  xpod_qlever_require_overlay_token(
    "src/engine/Service.cpp"
    "SERVICE federation is disabled"
    "Xpod physical-backend SERVICE boundary")
  xpod_qlever_require_overlay_token(
    "src/engine/Operation.h"
    "physicalCancellationRequested(_executionContext)"
    "Xpod physical-backend cancellation polling overlay")

  xpod_qlever_require_overlay_token(
    "src/engine/TextIndexScanForWord.cpp"
    "textWordResultFromContext"
    "Xpod text-index word overlay")
  xpod_qlever_require_overlay_token(
    "src/engine/TextIndexScanForWord.cpp"
    "textWordSizeEstimateFromContext"
    "Xpod text-index word overlay")
  xpod_qlever_require_overlay_token(
    "src/engine/TextIndexScanForEntity.cpp"
    "textEntityResultFromContext"
    "Xpod text-index entity overlay")
  xpod_qlever_require_overlay_token(
    "src/engine/TextIndexScanForEntity.cpp"
    "textEntitySizeEstimateFromContext"
    "Xpod text-index entity overlay")
  xpod_qlever_require_overlay_token(
    "src/parser/TextSearchQuery.cpp"
    "bestPhysicalTextTermIndexFromContext"
    "Xpod TextSearchQuery physical text-anchor overlay")

  xpod_qlever_require_overlay_token(
    "src/parser/NormalizedString.h"
    "using NormalizedString = std::string;"
    "Xpod libc++ compatibility overlay")
  xpod_qlever_require_overlay_token(
    "src/parser/NormalizedString.h"
    "using NormalizedStringView = std::string_view;"
    "Xpod libc++ compatibility overlay")
  xpod_qlever_require_overlay_token(
    "src/index/StringSortComparator.h"
    "using U8String = std::string;"
    "Xpod libc++ compatibility overlay")
  xpod_qlever_require_overlay_token(
    "src/index/StringSortComparator.h"
    "using SortKey = SortKeyImpl<std::string>;"
    "Xpod libc++ compatibility overlay")
  xpod_qlever_require_overlay_token(
    "src/util/StringUtils.h"
    "const volatile unsigned char* bytes1"
    "Xpod libc++ compatibility overlay")

  target_compile_definitions(xpod_qlever_adapter PRIVATE XPOD_QLEVER_ADAPTER_ENABLE_QLEVER=1)
  if(XPOD_QLEVER_ADAPTER_ENABLE_VECTOR)
    target_compile_definitions(xpod_qlever_adapter PRIVATE XPOD_QLEVER_ADAPTER_ENABLE_VECTOR=1)
  else()
    target_compile_definitions(xpod_qlever_adapter PRIVATE XPOD_QLEVER_ADAPTER_ENABLE_VECTOR=0)
  endif()
  target_compile_features(xpod_qlever_adapter PRIVATE cxx_std_20)
  if((CMAKE_CXX_COMPILER_ID STREQUAL "Clang" OR CMAKE_CXX_COMPILER_ID STREQUAL "AppleClang") AND
      CMAKE_CXX_COMPILER_VERSION VERSION_LESS "17.0.0")
    target_compile_definitions(xpod_qlever_adapter PRIVATE QLEVER_CPP_17 CPP_CXX_CONCEPTS=0)
  else()
    target_compile_definitions(xpod_qlever_adapter PRIVATE RANGE_V3_COMBINE_WITH_STD)
  endif()
  target_include_directories(xpod_qlever_adapter PRIVATE "${XPOD_QLEVER_SOURCE_DIR}/src" "${CMAKE_CURRENT_SOURCE_DIR}/src")
  if(XPOD_QLEVER_DEPENDENCY_INCLUDE_DIRS)
    target_include_directories(xpod_qlever_adapter
      SYSTEM
      PRIVATE
        ${XPOD_QLEVER_DEPENDENCY_INCLUDE_DIRS})
  endif()
else()
  target_compile_definitions(xpod_qlever_adapter PRIVATE XPOD_QLEVER_ADAPTER_ENABLE_QLEVER=0)
endif()
