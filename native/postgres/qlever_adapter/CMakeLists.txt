cmake_minimum_required(VERSION 3.20)

project(xpod_qlever_adapter LANGUAGES CXX)

option(XPOD_QLEVER_ADAPTER_BUILD_SHARED "Build xpod_qlever_adapter as a shared library" OFF)

if(XPOD_QLEVER_ADAPTER_BUILD_SHARED)
  set(XPOD_QLEVER_ADAPTER_LIBRARY_TYPE SHARED)
else()
  set(XPOD_QLEVER_ADAPTER_LIBRARY_TYPE STATIC)
endif()

add_library(xpod_qlever_adapter ${XPOD_QLEVER_ADAPTER_LIBRARY_TYPE}
  src/xpod_qlever_adapter.cpp
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
