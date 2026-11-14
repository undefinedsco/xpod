cmake_minimum_required(VERSION 3.25)
project(ActualAllBuildInputs LANGUAGES CXX)
file(WRITE "${CMAKE_CURRENT_BINARY_DIR}/generated.h" "#define VALUE 17\n")
