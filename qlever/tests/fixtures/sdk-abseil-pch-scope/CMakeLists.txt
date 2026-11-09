cmake_minimum_required(VERSION 3.20)
project(sdkabseilpchscope CXX)
# Fixture root used ONLY by qlever/tests/test_sdk_abseil_pch_scope.py.
# It mounts the fake abseil stand-in and then runs the REAL recipe block extracted
# from qlever/patches/qlever-antlr-scoped-pch-and-server-pch-reuse.patch, so the
# control flow under test is the shipped one, not a hand-written mirror.
set(ABSL_ENABLE_INSTALL ON CACHE BOOL "")
add_subdirectory(fake-abseil)
set(abseil_SOURCE_DIR "${CMAKE_CURRENT_SOURCE_DIR}/fake-abseil")
if (NOT DEFINED USE_PRECOMPILED_HEADERS)
  set(USE_PRECOMPILED_HEADERS ON)
endif ()
# The real tree places the abseil recipe INSIDE `if (USE_PRECOMPILED_HEADERS)`, so
# the fixture must reproduce that guard or the "global switch OFF" case would
# wrongly still run the block.
if (USE_PRECOMPILED_HEADERS)
  include("${CMAKE_CURRENT_SOURCE_DIR}/recipe-block.cmake")
endif ()
