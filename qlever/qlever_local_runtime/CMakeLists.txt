cmake_minimum_required(VERSION 3.20)

project(xpod_qlever_local_runtime LANGUAGES CXX)

set(XPOD_QLEVER_SOURCE_DIR "" CACHE PATH "Path to the upstream QLever source tree")
set(XPOD_QLEVER_BUILD_DIR "" CACHE PATH "Path to the upstream QLever build tree")
set(XPOD_QLEVER_DEPENDENCY_INCLUDE_DIRS "" CACHE STRING
  "Additional include directories inherited from the upstream QLever build")
set(CMAKE_POSITION_INDEPENDENT_CODE ON)

if(NOT XPOD_QLEVER_SOURCE_DIR)
  message(FATAL_ERROR "XPOD_QLEVER_SOURCE_DIR is required")
endif()
if(NOT XPOD_QLEVER_BUILD_DIR)
  message(FATAL_ERROR "XPOD_QLEVER_BUILD_DIR is required")
endif()

set(XPOD_QLEVER_ADAPTER_ENABLE_QLEVER ON CACHE BOOL "" FORCE)

find_package(Threads REQUIRED)

include(${CMAKE_CURRENT_SOURCE_DIR}/../cmake/XpodQleverRuntime.cmake)
xpod_qlever_collect_runtime_link_items(
  XPOD_QLEVER_RUNTIME_LINK_ITEMS
  "${XPOD_QLEVER_BUILD_DIR}"
)

add_subdirectory(
  ${CMAKE_CURRENT_SOURCE_DIR}/../qlever_adapter
  ${CMAKE_CURRENT_BINARY_DIR}/qlever_adapter
)
add_subdirectory(
  ${CMAKE_CURRENT_SOURCE_DIR}/../rdf_sqlite_backend
  ${CMAKE_CURRENT_BINARY_DIR}/rdf_sqlite_backend
)

target_link_libraries(xpod_qlever_adapter PRIVATE
  ${CMAKE_DL_LIBS}
  ${XPOD_QLEVER_RUNTIME_LINK_ITEMS}
)

add_executable(xpod_qlever_local_runtime
  src/xpod_qlever_local_runtime.cpp
)

target_compile_features(xpod_qlever_local_runtime PRIVATE cxx_std_20)
target_compile_options(xpod_qlever_local_runtime PRIVATE
  $<$<CXX_COMPILER_ID:Clang,AppleClang,GNU>:-Wall -Wextra -Werror>
)
target_include_directories(xpod_qlever_local_runtime SYSTEM PRIVATE
  ${XPOD_QLEVER_SOURCE_DIR}/src
  ${XPOD_QLEVER_DEPENDENCY_INCLUDE_DIRS}
)

target_link_libraries(xpod_qlever_local_runtime PRIVATE
  xpod_qlever_adapter
  xpod_rdf_sqlite_backend
  Threads::Threads
  ${XPOD_QLEVER_RUNTIME_LINK_ITEMS}
  ${CMAKE_DL_LIBS}
)

install(TARGETS
  xpod_qlever_local_runtime
  RUNTIME DESTINATION bin
)
