cmake_minimum_required(VERSION 3.20)
project(fakeabseil CXX)
# Minimal stand-in that reproduces the ONE property the real abseil target has and
# the PCH block depends on: AbseilHelpers names the target from ABSL_ENABLE_INSTALL
# and always publishes the absl::<name> ALIAS.
set(ABSL_ENABLE_INSTALL "${ABSL_ENABLE_INSTALL}" CACHE BOOL "" )
function(fake_absl_cc_library name)
  if (ABSL_ENABLE_INSTALL)
    set(_NAME "${name}")
  else ()
    set(_NAME "absl_${name}")
  endif ()
  add_library("${_NAME}" STATIC ${ARGN})
  target_include_directories("${_NAME}" PUBLIC "${CMAKE_CURRENT_SOURCE_DIR}")
  add_library("absl::${name}" ALIAS "${_NAME}")
endfunction()
add_subdirectory(absl/synchronization)
add_subdirectory(absl/strings)
