# Mirrors absl/synchronization/CMakeLists.txt: the target is declared in THIS
# directory, so its SOURCE_DIR is absl/synchronization and its sources are named
# relative to it (internal/win32_waiter.cc stays relative).
file(GLOB sync_srcs "${CMAKE_CURRENT_SOURCE_DIR}/*.cc"
                    "${CMAKE_CURRENT_SOURCE_DIR}/internal/*.cc")
fake_absl_cc_library(synchronization ${sync_srcs})
