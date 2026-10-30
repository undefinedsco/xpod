# Mirrors absl/strings/CMakeLists.txt: target declared in this directory.
file(GLOB str_srcs "${CMAKE_CURRENT_SOURCE_DIR}/*.cc")
fake_absl_cc_library(strings ${str_srcs})
