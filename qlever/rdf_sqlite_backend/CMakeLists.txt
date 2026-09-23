cmake_minimum_required(VERSION 3.20)

project(xpod_rdf_sqlite_backend LANGUAGES CXX)

set(XPOD_QLEVER_SOURCE_DIR "" CACHE PATH
  "Path to the upstream QLever source tree for its shared JSON dependency")
set(XPOD_QLEVER_DEPENDENCY_INCLUDE_DIRS "" CACHE STRING
  "Additional include directories inherited from the upstream QLever build")
# The packaged Local runtime links this backend statically. Set this to build a
# loadable plugin instead, so the physical provider can be exercised without the
# QLever engine and without rebuilding the runtime binary.
option(XPOD_RDF_SQLITE_BACKEND_SHARED
  "Build the RDF SQLite backend as a loadable shared plugin" OFF)

find_package(SQLite3 REQUIRED)
find_package(OpenSSL REQUIRED)

if(XPOD_RDF_SQLITE_BACKEND_SHARED)
  set(XPOD_RDF_SQLITE_BACKEND_LIBRARY_TYPE SHARED)
else()
  set(XPOD_RDF_SQLITE_BACKEND_LIBRARY_TYPE STATIC)
endif()

add_library(xpod_rdf_sqlite_backend STATIC
  src/xpod_rdf_sqlite_backend.cpp
)
if(XPOD_RDF_SQLITE_BACKEND_SHARED)
  # Same target and sources; only the artifact kind changes so a host can
  # dlopen the physical provider without the QLever engine.
  set_target_properties(xpod_rdf_sqlite_backend PROPERTIES
    STATIC_LIBRARY_OPTIONS ""
  )
  add_library(xpod_rdf_sqlite_backend_plugin SHARED
    src/xpod_rdf_sqlite_backend.cpp
  )
  target_link_libraries(xpod_rdf_sqlite_backend_plugin PRIVATE SQLite::SQLite3 OpenSSL::Crypto)
  set_target_properties(xpod_rdf_sqlite_backend_plugin PROPERTIES
    OUTPUT_NAME "xpod_rdf_sqlite_backend"
    POSITION_INDEPENDENT_CODE ON
    CXX_VISIBILITY_PRESET default
    VISIBILITY_INLINES_HIDDEN OFF
  )
  target_compile_features(xpod_rdf_sqlite_backend_plugin PRIVATE cxx_std_20)
  target_compile_options(xpod_rdf_sqlite_backend_plugin PRIVATE
    $<$<CXX_COMPILER_ID:Clang,AppleClang,GNU>:-Wall -Wextra -Werror>
  )
  target_include_directories(xpod_rdf_sqlite_backend_plugin
    PUBLIC
      ${CMAKE_CURRENT_SOURCE_DIR}/include
      ${CMAKE_CURRENT_SOURCE_DIR}/../rdf_protocol/include
    PRIVATE
      ${CMAKE_CURRENT_SOURCE_DIR}/../include
  )
  if(XPOD_QLEVER_SOURCE_DIR)
    target_include_directories(xpod_rdf_sqlite_backend_plugin SYSTEM PRIVATE
      ${XPOD_QLEVER_SOURCE_DIR}/src
    )
  endif()
  if(XPOD_QLEVER_DEPENDENCY_INCLUDE_DIRS)
    target_include_directories(xpod_rdf_sqlite_backend_plugin SYSTEM PRIVATE
      ${XPOD_QLEVER_DEPENDENCY_INCLUDE_DIRS}
    )
  endif()
endif()

set_target_properties(xpod_rdf_sqlite_backend PROPERTIES
  OUTPUT_NAME "xpod_rdf_sqlite_backend"
  POSITION_INDEPENDENT_CODE ON
  CXX_VISIBILITY_PRESET default
  VISIBILITY_INLINES_HIDDEN OFF
)

target_compile_features(xpod_rdf_sqlite_backend PRIVATE cxx_std_20)
target_compile_options(xpod_rdf_sqlite_backend PRIVATE
  $<$<CXX_COMPILER_ID:Clang,AppleClang,GNU>:-Wall -Wextra -Werror>
)
target_include_directories(xpod_rdf_sqlite_backend
  PUBLIC
    ${CMAKE_CURRENT_SOURCE_DIR}/include
    ${CMAKE_CURRENT_SOURCE_DIR}/../rdf_protocol/include
  PRIVATE
    ${CMAKE_CURRENT_SOURCE_DIR}/../include
)
if(XPOD_QLEVER_SOURCE_DIR)
  target_include_directories(xpod_rdf_sqlite_backend SYSTEM PRIVATE
    ${XPOD_QLEVER_SOURCE_DIR}/src
  )
endif()
if(XPOD_QLEVER_DEPENDENCY_INCLUDE_DIRS)
  target_include_directories(xpod_rdf_sqlite_backend SYSTEM PRIVATE
    ${XPOD_QLEVER_DEPENDENCY_INCLUDE_DIRS}
  )
endif()
target_link_libraries(xpod_rdf_sqlite_backend PRIVATE SQLite::SQLite3 OpenSSL::Crypto)
