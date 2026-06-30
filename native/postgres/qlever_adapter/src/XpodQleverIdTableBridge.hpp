#ifndef XPOD_QLEVER_ID_TABLE_BRIDGE_HPP
#define XPOD_QLEVER_ID_TABLE_BRIDGE_HPP

#include "XpodQleverScanBridge.hpp"
#include "XpodQleverScanMaterializer.hpp"
#include "XpodQleverValueIdBridge.hpp"

#include <vector>
#include <type_traits>

#if XPOD_QLEVER_ADAPTER_ENABLE_QLEVER
#include "engine/idTable/IdTable.h"
#if __has_include("util/AllocatorWithLimit.h")
#include "util/AllocatorWithLimit.h"
#define XPOD_QLEVER_HAS_ALLOCATOR_WITH_LIMIT 1
#else
#define XPOD_QLEVER_HAS_ALLOCATOR_WITH_LIMIT 0
#endif

namespace xpod::qlever {

struct QleverIdTableResult {
  xpod_rdf_status status;
  IdTable table;
};

struct QleverIdTableBlocksResult {
  xpod_rdf_status status;
  std::vector<IdTable> blocks;
};

inline IdTable makeQleverIdTable(size_t width) {
#if XPOD_QLEVER_HAS_ALLOCATOR_WITH_LIMIT
  return IdTable(width, ad_utility::makeUnlimitedAllocator<Id>());
#else
  return IdTable(width);
#endif
}

inline IdTable toQleverIdTable(const QleverIdRowBuffer& buffer) {
  IdTable table = makeQleverIdTable(buffer.width);
  std::vector<Id> row;
  row.reserve(buffer.width);
  if (buffer.width == 0) {
    for (size_t i = 0; i < buffer.row_count; ++i) {
      table.push_back(row);
    }
    return table;
  }
  for (size_t offset = 0; offset < buffer.rows.size();
       offset += buffer.width) {
    row.clear();
    for (uint32_t column = 0; column < buffer.width; ++column) {
      row.push_back(toQleverId(buffer.rows[offset + column]));
    }
    table.push_back(row);
  }
  return table;
}

struct ScanToQleverIdTableBlocksState {
  std::vector<IdTable>* blocks;
  const xpod::rdf::PhysicalBackend* backend;
  Permutation::Enum permutation;
  uint32_t needed_slots;
};

inline xpod_rdf_status appendQleverIdTableBlockCallback(
    void* callback_user_data,
    const xpod_rdf_quad_batch* batch) {
  if (callback_user_data == nullptr || batch == nullptr) {
    return XPOD_RDF_STATUS_BACKEND_ERROR;
  }
  auto* state = static_cast<ScanToQleverIdTableBlocksState*>(
      callback_user_data);
  QleverIdRowBuffer rows;
  xpod_rdf_status status = appendEncodedBatch(
      rows, *state->backend, state->permutation, state->needed_slots, *batch);
  if (status != XPOD_RDF_STATUS_OK) {
    return status;
  }
  state->blocks->push_back(toQleverIdTable(rows));
  return XPOD_RDF_STATUS_OK;
}

inline QleverIdTableResult executeScanToQleverIdTable(
    const xpod::rdf::PhysicalBackend& backend,
    const ScanRequestInput& input) {
  QleverIdRowBuffer rows;
  rows.width = 3;
  xpod_rdf_status status = executeScanToQleverIds(backend, input, rows);
  if (status != XPOD_RDF_STATUS_OK) {
    return {status, makeQleverIdTable(rows.width)};
  }
  return {XPOD_RDF_STATUS_OK, toQleverIdTable(rows)};
}

inline QleverIdTableBlocksResult executeScanToQleverIdTableBlocks(
    const xpod::rdf::PhysicalBackend& backend,
    const ScanRequestInput& input) {
  QleverIdTableBlocksResult result = {};
  ScanToQleverIdTableBlocksState state{
      &result.blocks, &backend, input.permutation, input.needed_slots};
  result.status = executeScan(
      backend, input, appendQleverIdTableBlockCallback, &state);
  if (result.status != XPOD_RDF_STATUS_OK) {
    result.blocks.clear();
  }
  return result;
}

}  // namespace xpod::qlever
#endif

#endif
