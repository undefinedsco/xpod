cmake_minimum_required(VERSION 3.20)

project(xpod_qlever_adapter LANGUAGES CXX)

option(XPOD_QLEVER_ADAPTER_BUILD_SHARED "Build xpod_qlever_adapter as a shared library" OFF)
option(XPOD_QLEVER_ADAPTER_ENABLE_QLEVER "Build the adapter against an upstream QLever source tree" OFF)
set(XPOD_QLEVER_SOURCE_DIR "" CACHE PATH "Path to the upstream QLever source tree")

if(XPOD_QLEVER_ADAPTER_BUILD_SHARED)
  set(XPOD_QLEVER_ADAPTER_LIBRARY_TYPE SHARED)
else()
  set(XPOD_QLEVER_ADAPTER_LIBRARY_TYPE STATIC)
endif()

set(XPOD_QLEVER_ADAPTER_SOURCES
  src/xpod_qlever_adapter.cpp
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
    "${XPOD_QLEVER_SOURCE_DIR}/src/engine/QueryExecutionContext.h"
    "${XPOD_QLEVER_SOURCE_DIR}/src/engine/RuntimeInformation.h"
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

  target_compile_definitions(xpod_qlever_adapter PRIVATE XPOD_QLEVER_ADAPTER_ENABLE_QLEVER=1)
  target_include_directories(xpod_qlever_adapter PRIVATE "${XPOD_QLEVER_SOURCE_DIR}/src")
else()
  target_compile_definitions(xpod_qlever_adapter PRIVATE XPOD_QLEVER_ADAPTER_ENABLE_QLEVER=0)
endif()
