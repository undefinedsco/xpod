#ifndef XPOD_QLEVER_ID_TABLE_BRIDGE_HPP
#define XPOD_QLEVER_ID_TABLE_BRIDGE_HPP

#include "XpodQleverScanBridge.hpp"
#include "XpodQleverScanMaterializer.hpp"
#include "XpodQleverValueIdBridge.hpp"

#include <exception>
#include <vector>
#include <type_traits>

#if XPOD_QLEVER_ADAPTER_ENABLE_QLEVER
#include "engine/idTable/IdTable.h"
#if __has_include("util/AllocatorWithLimit.h")
#include "util/AllocatorWithLimit.h"
#define XPOD_QLEVER_HAS_ALLOCATOR_WITH_LIMIT 1
#else
#define XPOD_QLEVER_HAS_ALLOCATOR_WITH_LIMIT 0
namespace ad_utility {
template <typename T>
class AllocatorWithLimit {};

template <typename T>
AllocatorWithLimit<T> makeUnlimitedAllocator() {
  return {};
}
}  // namespace ad_utility
#endif

namespace xpod::qlever {

struct QleverDiagnosticsHooks {
  uint64_t (*stage_start)() noexcept;
  void (*stage_finish)(const char* stage, uint64_t started_at_ns) noexcept;
  void (*record_scan_batch)(const xpod_rdf_quad_batch& batch) noexcept;
  void (*record_scan_invocation)() noexcept;
  void (*record_bytes)(uint64_t bytes) noexcept;
};

inline QleverDiagnosticsHooks*& activeQleverDiagnosticsHooks() noexcept {
  thread_local QleverDiagnosticsHooks* hooks = nullptr;
  return hooks;
}

inline uint64_t qleverDiagnosticsStageStart() noexcept {
  QleverDiagnosticsHooks* hooks = activeQleverDiagnosticsHooks();
  return hooks == nullptr ? 0 : hooks->stage_start();
}

inline void qleverDiagnosticsStageFinish(
    const char* stage,
    uint64_t started_at_ns) noexcept {
  QleverDiagnosticsHooks* hooks = activeQleverDiagnosticsHooks();
  if (hooks != nullptr) {
    hooks->stage_finish(stage, started_at_ns);
  }
}

inline void recordQleverBackendScanBatch(
    const xpod_rdf_quad_batch& batch) noexcept {
  QleverDiagnosticsHooks* hooks = activeQleverDiagnosticsHooks();
  if (hooks != nullptr) {
    hooks->record_scan_batch(batch);
  }
}

inline void recordQleverBackendScanInvocation() noexcept {
  QleverDiagnosticsHooks* hooks = activeQleverDiagnosticsHooks();
  if (hooks != nullptr) {
    hooks->record_scan_invocation();
  }
}

inline void recordQleverBackendBytes(uint64_t bytes) noexcept {
  QleverDiagnosticsHooks* hooks = activeQleverDiagnosticsHooks();
  if (hooks != nullptr) {
    hooks->record_bytes(bytes);
  }
}

class ScopedQleverDiagnosticsStage {
 public:
  explicit ScopedQleverDiagnosticsStage(const char* stage) noexcept
      : stage_(stage), started_at_ns_(qleverDiagnosticsStageStart()) {}

  ~ScopedQleverDiagnosticsStage() {
    qleverDiagnosticsStageFinish(stage_, started_at_ns_);
  }

 private:
  const char* stage_;
  uint64_t started_at_ns_;
};

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

inline IdTable makeQleverIdTable(
    size_t width,
    const ad_utility::AllocatorWithLimit<Id>& allocator) {
#if XPOD_QLEVER_HAS_ALLOCATOR_WITH_LIMIT
  return IdTable(width, allocator);
#else
  (void)allocator;
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

inline IdTable toQleverIdTable(
    const QleverIdRowBuffer& buffer,
    const ad_utility::AllocatorWithLimit<Id>& allocator) {
  IdTable table = makeQleverIdTable(buffer.width, allocator);
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

struct ScanToQleverIdTableState {
  IdTable* table;
  const xpod::rdf::PhysicalBackend* backend;
  const xpod_rdf_snapshot* snapshot;
  Permutation::Enum permutation;
  uint32_t needed_slots;
  std::exception_ptr exception;
};

inline xpod_rdf_status appendQleverIdTableCallback(
    void* callback_user_data,
    const xpod_rdf_quad_batch* batch) noexcept {
  if (callback_user_data == nullptr || batch == nullptr) {
    return XPOD_RDF_STATUS_BACKEND_ERROR;
  }
  auto* state = static_cast<ScanToQleverIdTableState*>(callback_user_data);
  try {
    recordQleverBackendScanBatch(*batch);
    ScopedQleverDiagnosticsStage materialization_stage(
        "id-table-materialization");
    const xpod_rdf_status preload_status = preloadPhysicalTermsForBatch(
        *state->backend, state->permutation, state->needed_slots, *batch,
        state->snapshot);
    if (preload_status != XPOD_RDF_STATUS_OK) {
      return preload_status;
    }
    const char* slots = permutationSlots(state->permutation);
    const uint32_t needed_slots = normalizeNeededSlots(state->needed_slots);
    std::vector<Id> row;
    row.reserve(countNeededSlots(needed_slots));
    for (size_t i = 0; i < batch->row_count; ++i) {
      row.clear();
      const xpod_rdf_quad_key& quad = batch->rows[i];
      for (const char* slot = slots; *slot != '\0'; ++slot) {
        const uint32_t slot_mask = slotMask(*slot);
        if ((needed_slots & slot_mask) == 0) {
          continue;
        }
        uint64_t bits = 0;
        xpod_rdf_status status = encodePhysicalValueAsQleverId(
            *state->backend, slotValue(quad, *slot), bits,
            state->snapshot, slot_mask);
        if (status != XPOD_RDF_STATUS_OK) {
          return status;
        }
        row.push_back(toQleverId(bits));
      }
      state->table->push_back(row);
    }
    return XPOD_RDF_STATUS_OK;
  } catch (...) {
    state->exception = std::current_exception();
    return XPOD_RDF_STATUS_BACKEND_ERROR;
  }
}

inline QleverIdTableResult executeScanToQleverIdTable(
    const xpod::rdf::PhysicalBackend& backend,
    const ScanRequestInput& input,
    const ad_utility::AllocatorWithLimit<Id>& allocator) {
  IdTable table = makeQleverIdTable(
      countNeededSlots(normalizeNeededSlots(input.needed_slots)), allocator);
  ScanToQleverIdTableState state{
      &table, &backend, input.snapshot, input.permutation, input.needed_slots,
      {}};
  recordQleverBackendScanInvocation();
  xpod_rdf_status status = executeScan(
      backend, input, appendQleverIdTableCallback, &state);
  if (state.exception != nullptr) {
    std::rethrow_exception(state.exception);
  }
  return {status, std::move(table)};
}

struct ScanToQleverIdTableBlocksState {
  std::vector<IdTable>* blocks;
  const xpod::rdf::PhysicalBackend* backend;
  Permutation::Enum permutation;
  uint32_t needed_slots;
  const ad_utility::AllocatorWithLimit<Id>* allocator;
  std::exception_ptr exception;
};

inline xpod_rdf_status appendQleverIdTableBlockCallback(
    void* callback_user_data,
    const xpod_rdf_quad_batch* batch) {
  if (callback_user_data == nullptr || batch == nullptr) {
    return XPOD_RDF_STATUS_BACKEND_ERROR;
  }
  auto* state = static_cast<ScanToQleverIdTableBlocksState*>(
      callback_user_data);
  try {
    recordQleverBackendScanBatch(*batch);
    ScopedQleverDiagnosticsStage materialization_stage(
        "id-table-materialization");
    QleverIdRowBuffer rows;
    xpod_rdf_status status = appendEncodedBatch(
        rows, *state->backend, state->permutation, state->needed_slots, *batch);
    if (status != XPOD_RDF_STATUS_OK) {
      return status;
    }
    state->blocks->push_back(
        toQleverIdTable(rows, *state->allocator));
    return XPOD_RDF_STATUS_OK;
  } catch (...) {
    state->exception = std::current_exception();
    return XPOD_RDF_STATUS_BACKEND_ERROR;
  }
}

inline QleverIdTableResult executeScanToQleverIdTable(
    const xpod::rdf::PhysicalBackend& backend,
    const ScanRequestInput& input) {
  QleverIdRowBuffer rows;
  rows.width = 3;
  recordQleverBackendScanInvocation();
  xpod_rdf_status status = executeScanToQleverIds(backend, input, rows);
  if (status != XPOD_RDF_STATUS_OK) {
    return {status, makeQleverIdTable(rows.width)};
  }
  return {XPOD_RDF_STATUS_OK, toQleverIdTable(rows)};
}

inline QleverIdTableBlocksResult executeScanToQleverIdTableBlocks(
    const xpod::rdf::PhysicalBackend& backend,
    const ScanRequestInput& input,
    const ad_utility::AllocatorWithLimit<Id>& allocator) {
  QleverIdTableBlocksResult result = {};
  ScanToQleverIdTableBlocksState state{
      &result.blocks, &backend, input.permutation, input.needed_slots,
      &allocator, {}};
  recordQleverBackendScanInvocation();
  result.status = executeScan(
      backend, input, appendQleverIdTableBlockCallback, &state);
  if (state.exception != nullptr) {
    std::rethrow_exception(state.exception);
  }
  if (result.status != XPOD_RDF_STATUS_OK) {
    result.blocks.clear();
  }
  return result;
}

inline QleverIdTableBlocksResult executeScanToQleverIdTableBlocks(
    const xpod::rdf::PhysicalBackend& backend,
    const ScanRequestInput& input) {
  auto allocator = ad_utility::makeUnlimitedAllocator<Id>();
  return executeScanToQleverIdTableBlocks(backend, input, allocator);
}

}  // namespace xpod::qlever
#endif

#endif
