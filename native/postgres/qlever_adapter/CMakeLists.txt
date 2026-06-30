cmake_minimum_required(VERSION 3.20)

project(xpod_qlever_adapter LANGUAGES CXX)

option(XPOD_QLEVER_ADAPTER_BUILD_SHARED "Build xpod_qlever_adapter as a shared library" OFF)
option(XPOD_QLEVER_ADAPTER_ENABLE_QLEVER "Build the adapter against an upstream QLever source tree" OFF)
set(XPOD_QLEVER_SOURCE_DIR "" CACHE PATH "Path to the upstream QLever source tree")
set(XPOD_QLEVER_DEPENDENCY_INCLUDE_DIRS "" CACHE STRING "Additional include directories for upstream QLever dependencies")

if(XPOD_QLEVER_ADAPTER_BUILD_SHARED)
  set(XPOD_QLEVER_ADAPTER_LIBRARY_TYPE SHARED)
else()
  set(XPOD_QLEVER_ADAPTER_LIBRARY_TYPE STATIC)
endif()

set(XPOD_QLEVER_ADAPTER_SOURCES
  src/xpod_qlever_adapter.cpp
  src/XpodQleverExecutor.cpp
)

if(XPOD_QLEVER_ADAPTER_ENABLE_QLEVER)
  list(APPEND XPOD_QLEVER_ADAPTER_SOURCES
    src/XpodQleverBridge.cpp
  )
endif()

add_library(xpod_qlever_adapter ${XPOD_QLEVER_ADAPTER_LIBRARY_TYPE}
  ${XPOD_QLEVER_ADAPTER_SOURCES}
)

target_compile_features(xpod_qlever_adapter PUBLIC cxx_std_17)

target_include_directories(xpod_qlever_adapter
  PUBLIC
    ${CMAKE_CURRENT_SOURCE_DIR}/include
    ${CMAKE_CURRENT_SOURCE_DIR}/../rdf_protocol/include
)

target_compile_options(xpod_qlever_adapter
  PRIVATE
    $<$<CXX_COMPILER_ID:Clang,AppleClang,GNU>:-Wall -Wextra -Werror>
)

if(XPOD_QLEVER_ADAPTER_ENABLE_QLEVER)
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
    "${XPOD_QLEVER_SOURCE_DIR}/src/index/Index.h"
    "${XPOD_QLEVER_SOURCE_DIR}/src/index/LocalVocab.h"
    "${XPOD_QLEVER_SOURCE_DIR}/src/index/Permutation.h"
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
  string(FIND "${XPOD_QLEVER_INDEX_SCAN_SOURCE_TEXT}" "lazyScanRangeFromQleverScanSpecAndBlocks" XPOD_QLEVER_INDEX_SCAN_OVERLAY_POS)
  string(FIND "${XPOD_QLEVER_INDEX_SCAN_SOURCE_TEXT}" "!scanSpecAndBlocksIsPrefiltered_" XPOD_QLEVER_INDEX_SCAN_BROAD_OVERLAY_POS)
  if(XPOD_QLEVER_INDEX_SCAN_OVERLAY_POS EQUAL -1 OR XPOD_QLEVER_INDEX_SCAN_BROAD_OVERLAY_POS EQUAL -1)
    message(FATAL_ERROR "IndexScan.cpp is not patched with the Xpod lazy-scan overlay. Run node ${CMAKE_CURRENT_SOURCE_DIR}/../../../scripts/check-qlever-upstream-patches.cjs --qlever-source ${XPOD_QLEVER_SOURCE_DIR} --apply")
  endif()

  set(XPOD_QLEVER_QUERY_EXECUTION_CONTEXT_HEADER "${XPOD_QLEVER_SOURCE_DIR}/src/engine/QueryExecutionContext.h")
  file(READ "${XPOD_QLEVER_QUERY_EXECUTION_CONTEXT_HEADER}" XPOD_QLEVER_QUERY_EXECUTION_CONTEXT_TEXT)
  string(FIND "${XPOD_QLEVER_QUERY_EXECUTION_CONTEXT_TEXT}" "setXpodPhysicalIndex" XPOD_QLEVER_CONTEXT_SETTER_POS)
  string(FIND "${XPOD_QLEVER_QUERY_EXECUTION_CONTEXT_TEXT}" "xpodPhysicalIndex() const" XPOD_QLEVER_CONTEXT_GETTER_POS)
  if(XPOD_QLEVER_CONTEXT_SETTER_POS EQUAL -1 OR XPOD_QLEVER_CONTEXT_GETTER_POS EQUAL -1)
    message(FATAL_ERROR "QueryExecutionContext.h is not patched with the Xpod physical-index overlay. Run node ${CMAKE_CURRENT_SOURCE_DIR}/../../../scripts/check-qlever-upstream-patches.cjs --qlever-source ${XPOD_QLEVER_SOURCE_DIR} --apply")
  endif()

  function(xpod_qlever_require_overlay_token relative_source token overlay_label)
    set(source_path "${XPOD_QLEVER_SOURCE_DIR}/${relative_source}")
    if(NOT EXISTS "${source_path}")
      message(FATAL_ERROR "XPOD_QLEVER_SOURCE_DIR does not include ${relative_source}; cannot verify the ${overlay_label}")
    endif()
    file(READ "${source_path}" source_text)
    string(FIND "${source_text}" "${token}" token_pos)
    if(token_pos EQUAL -1)
      message(FATAL_ERROR "${relative_source} is not patched with the ${overlay_label}. Run node ${CMAKE_CURRENT_SOURCE_DIR}/../../../scripts/check-qlever-upstream-patches.cjs --qlever-source ${XPOD_QLEVER_SOURCE_DIR} --apply")
    endif()
  endfunction()

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
  target_compile_features(xpod_qlever_adapter PRIVATE cxx_std_20)
  if((CMAKE_CXX_COMPILER_ID STREQUAL "Clang" OR CMAKE_CXX_COMPILER_ID STREQUAL "AppleClang") AND
      CMAKE_CXX_COMPILER_VERSION VERSION_LESS "17.0.0")
    target_compile_definitions(xpod_qlever_adapter PRIVATE QLEVER_CPP_17 CPP_CXX_CONCEPTS=0)
  else()
    target_compile_definitions(xpod_qlever_adapter PRIVATE RANGE_V3_COMBINE_WITH_STD)
  endif()
  target_include_directories(xpod_qlever_adapter PRIVATE "${XPOD_QLEVER_SOURCE_DIR}/src" "${CMAKE_CURRENT_SOURCE_DIR}/src")
  if(XPOD_QLEVER_DEPENDENCY_INCLUDE_DIRS)
    target_include_directories(xpod_qlever_adapter PRIVATE ${XPOD_QLEVER_DEPENDENCY_INCLUDE_DIRS})
  endif()
else()
  target_compile_definitions(xpod_qlever_adapter PRIVATE XPOD_QLEVER_ADAPTER_ENABLE_QLEVER=0)
endif()
