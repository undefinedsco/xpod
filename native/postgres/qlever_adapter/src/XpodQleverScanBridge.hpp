#ifndef XPOD_QLEVER_SCAN_BRIDGE_HPP
#define XPOD_QLEVER_SCAN_BRIDGE_HPP

#include "XpodPhysicalBackend.hpp"
#include "XpodQleverPermutationMap.hpp"
#include "XpodQleverScanMaterializer.hpp"
#include "xpod_rdf_physical_backend.h"

#include <vector>

#if XPOD_QLEVER_ADAPTER_ENABLE_QLEVER

namespace xpod::qlever {

struct TripleKeyPattern {
  bool has_subject = false;
  bool has_predicate = false;
  bool has_object = false;
  bool has_graph = false;
  xpod_rdf_term_key subject = 0;
  xpod_rdf_term_key predicate = 0;
  xpod_rdf_term_key object = 0;
  xpod_rdf_term_key graph = 0;
};

struct ScanRequestInput {
  const xpod_rdf_snapshot* snapshot = nullptr;
  Permutation::Enum permutation = Permutation::Enum::SPO;
  TripleKeyPattern pattern;
  const xpod_rdf_source_scope* source_scope = nullptr;
  const xpod_rdf_access_scope* access_scope = nullptr;
  uint64_t limit = 0;
  uint64_t offset = 0;
  uint32_t batch_size = 0;
  uint32_t needed_slots = XPOD_RDF_SLOT_SUBJECT | XPOD_RDF_SLOT_PREDICATE |
                          XPOD_RDF_SLOT_OBJECT;
  std::vector<xpod_rdf_slot_term_range> slot_ranges;
};

inline xpod_rdf_quad_pattern toXpodQuadPattern(
    const TripleKeyPattern& pattern) noexcept {
  xpod_rdf_quad_pattern out = {};
  out.has_subject = pattern.has_subject ? 1 : 0;
  out.has_predicate = pattern.has_predicate ? 1 : 0;
  out.has_object = pattern.has_object ? 1 : 0;
  out.has_graph = pattern.has_graph ? 1 : 0;
  out.subject = pattern.subject;
  out.predicate = pattern.predicate;
  out.object = pattern.object;
  out.graph = pattern.graph;
  return out;
}

inline xpod_rdf_scan_request makeScanRequest(
    const ScanRequestInput& input) noexcept {
  xpod_rdf_scan_request request = {};
  if (input.snapshot != nullptr) {
    request.snapshot = *input.snapshot;
  }
  request.permutation = toXpodPermutation(input.permutation);
  request.pattern = toXpodQuadPattern(input.pattern);
  request.graph_scope.kind = XPOD_RDF_GRAPH_SCOPE_ALL;
  if (input.source_scope != nullptr) {
    request.source_scope = *input.source_scope;
  }
  request.access_scope = input.access_scope;
  request.order.kind = XPOD_RDF_SCAN_ORDER_NATIVE;
  request.slot_ranges = input.slot_ranges.data();
  request.slot_range_count = input.slot_ranges.size();
  request.limit = input.limit;
  request.offset = input.offset;
  request.batch_size = input.batch_size;
  request.needed_slots = input.needed_slots;
  return request;
}

inline xpod_rdf_status executeScan(
    const xpod::rdf::PhysicalBackend& backend,
    const ScanRequestInput& input,
    xpod_rdf_quad_batch_callback on_batch,
    void* callback_user_data) noexcept {
  xpod_rdf_scan_request request = makeScanRequest(input);
  return backend.scanPermutation(request, on_batch, callback_user_data);
}

struct ScanToRowsState {
  ScanRowBuffer* rows;
  Permutation::Enum permutation;
  uint32_t needed_slots;
};

inline xpod_rdf_status appendRowsCallback(
    void* callback_user_data,
    const xpod_rdf_quad_batch* batch) {
  if (callback_user_data == nullptr || batch == nullptr) {
    return XPOD_RDF_STATUS_BACKEND_ERROR;
  }
  auto* state = static_cast<ScanToRowsState*>(callback_user_data);
  appendBatch(
      *state->rows, state->permutation, state->needed_slots, *batch);
  return XPOD_RDF_STATUS_OK;
}

inline xpod_rdf_status executeScanToRows(
    const xpod::rdf::PhysicalBackend& backend,
    const ScanRequestInput& input,
    ScanRowBuffer& rows) noexcept {
  ScanToRowsState state{&rows, input.permutation, input.needed_slots};
  return executeScan(backend, input, appendRowsCallback, &state);
}

struct ScanToQleverIdsState {
  QleverIdRowBuffer* rows;
  const xpod::rdf::PhysicalBackend* backend;
  Permutation::Enum permutation;
  uint32_t needed_slots;
};

inline xpod_rdf_status appendQleverIdsCallback(
    void* callback_user_data,
    const xpod_rdf_quad_batch* batch) {
  if (callback_user_data == nullptr || batch == nullptr) {
    return XPOD_RDF_STATUS_BACKEND_ERROR;
  }
  auto* state = static_cast<ScanToQleverIdsState*>(callback_user_data);
  return appendEncodedBatch(
      *state->rows, *state->backend, state->permutation,
      state->needed_slots, *batch);
}

inline xpod_rdf_status executeScanToQleverIds(
    const xpod::rdf::PhysicalBackend& backend,
    const ScanRequestInput& input,
    QleverIdRowBuffer& rows) noexcept {
  ScanToQleverIdsState state{
      &rows, &backend, input.permutation, input.needed_slots};
  return executeScan(backend, input, appendQleverIdsCallback, &state);
}

}  // namespace xpod::qlever

#endif

#endif
