#ifndef XPOD_QLEVER_OPERATION_EXECUTOR_HPP
#define XPOD_QLEVER_OPERATION_EXECUTOR_HPP

#include "XpodBackedIndexScan.hpp"
#include "XpodBackedTextSearch.hpp"
#include "XpodBackedVectorSearch.hpp"
#include "XpodNumericLiteralCompare.hpp"
#include "XpodQleverOperationBridge.hpp"
#include "XpodQleverResultBridge.hpp"
#include "XpodQleverScanMaterializer.hpp"
#include "XpodQleverValueIdBridge.hpp"

#include <algorithm>
#include <cctype>
#include <cmath>
#include <cstdint>
#include <cstddef>
#include <iomanip>
#include <limits>
#include <map>
#include <optional>
#include <set>
#include <sstream>
#include <string>
#include <string_view>
#include <type_traits>
#include <utility>
#include <unordered_map>
#include <unordered_set>
#include <vector>

#if XPOD_QLEVER_ADAPTER_ENABLE_QLEVER
#if __has_include("global/ValueId.h")
#include "global/ValueId.h"
#define XPOD_QLEVER_OPERATION_HAS_VALUE_ID_DATATYPE 1
#else
#define XPOD_QLEVER_OPERATION_HAS_VALUE_ID_DATATYPE 0
#endif

namespace xpod::qlever {

template <typename T, typename = void>
struct BridgeHasMakeUndefined : std::false_type {};

template <typename T>
struct BridgeHasMakeUndefined<
    T,
    std::void_t<decltype(T::makeUndefined())>> : std::true_type {};

template <
    typename T,
    typename std::enable_if<BridgeHasMakeUndefined<T>::value, int>::type = 0>
inline T bridgeUndefinedIdFor() {
  return T::makeUndefined();
}

template <
    typename T,
    typename std::enable_if<!BridgeHasMakeUndefined<T>::value, int>::type = 0>
inline T bridgeUndefinedIdFor() {
  return T::fromBits(UINT64_MAX);
}

inline Id bridgeUndefinedId() {
  return bridgeUndefinedIdFor<Id>();
}

inline char slotToPermutationChar(uint32_t slot) noexcept {
  switch (slot) {
    case XPOD_RDF_SLOT_SUBJECT:
      return 'S';
    case XPOD_RDF_SLOT_PREDICATE:
      return 'P';
    case XPOD_RDF_SLOT_OBJECT:
      return 'O';
    default:
      return '\0';
  }
}

inline size_t columnForSlot(
    Permutation::Enum permutation,
    uint32_t needed_slots,
    uint32_t slot) noexcept {
  char target = slotToPermutationChar(slot);
  const char* slots = permutationSlots(permutation);
  uint32_t normalized_needed_slots = normalizeNeededSlots(needed_slots);
  size_t output_column = 0;
  for (size_t column = 0; column < 3; ++column) {
    uint32_t current_slot = slotMask(slots[column]);
    if ((normalized_needed_slots & current_slot) == 0) {
      continue;
    }
    if (slots[column] == target) {
      return output_column;
    }
    ++output_column;
  }
  if (slot == XPOD_RDF_SLOT_GRAPH &&
      (needed_slots & XPOD_RDF_SLOT_GRAPH) != 0) {
    return output_column;
  }
  return 0;
}

inline uint32_t slotForColumn(
    Permutation::Enum permutation,
    uint32_t needed_slots,
    size_t target_column) noexcept {
  const char* slots = permutationSlots(permutation);
  uint32_t normalized_needed_slots = normalizeNeededSlots(needed_slots);
  size_t output_column = 0;
  for (size_t column = 0; column < 3; ++column) {
    uint32_t current_slot = slotMask(slots[column]);
    if ((normalized_needed_slots & current_slot) == 0) {
      continue;
    }
    if (output_column == target_column) {
      return current_slot;
    }
    ++output_column;
  }
  if ((needed_slots & XPOD_RDF_SLOT_GRAPH) != 0 &&
      output_column == target_column) {
    return XPOD_RDF_SLOT_GRAPH;
  }
  return 0;
}

inline bool canPushSemanticOrderPage(
    const xpod::rdf::PhysicalBackend& backend,
    const BridgeOperationPlan& root) noexcept {
  if (root.result_modifiers.size() < 2 ||
      root.result_modifiers[0].kind != BridgeResultModifierKind::OrderBy ||
      root.result_modifiers[1].kind != BridgeResultModifierKind::LimitOffset ||
      root.result_modifiers[0].columns.empty() ||
      root.result_modifiers[0].columns.size() >
          XPOD_RDF_SCAN_ORDER_MAX_SLOTS ||
      root.result_modifiers[0].columns.size() !=
          root.result_modifiers[0].descending.size()) {
    return false;
  }
  for (size_t index = 2; index < root.result_modifiers.size(); ++index) {
    const BridgeResultModifier& modifier = root.result_modifiers[index];
    if (modifier.kind != BridgeResultModifierKind::Project) {
      return false;
    }
  }
  xpod_rdf_backend_capabilities capabilities = {};
  if (backend.getCapabilities(capabilities) != XPOD_RDF_STATUS_OK) {
    return false;
  }
  constexpr uint64_t required =
      XPOD_RDF_BACKEND_FEATURE_SEMANTIC_ORDER_SCAN |
      XPOD_RDF_BACKEND_FEATURE_SCAN_LIMIT |
      XPOD_RDF_BACKEND_FEATURE_SCAN_OFFSET;
  return (capabilities.features & required) == required;
}

inline bool hasExactConstraintOutsideSemanticOrder(
    const BridgePhysicalScan& scan,
    const BridgeResultModifier& order_by) noexcept {
  uint32_t order_slots = 0;
  for (ColumnIndex column : order_by.columns) {
    const uint32_t order_slot =
        slotForColumn(scan.scan.permutation, scan.scan.needed_slots, column);
    if (order_slot == 0) {
      return true;
    }
    order_slots |= order_slot;
  }

  const TripleKeyPattern& pattern = scan.scan.pattern;
  return (pattern.has_subject && (order_slots & XPOD_RDF_SLOT_SUBJECT) == 0) ||
         (pattern.has_predicate &&
          (order_slots & XPOD_RDF_SLOT_PREDICATE) == 0) ||
         (pattern.has_object && (order_slots & XPOD_RDF_SLOT_OBJECT) == 0);
}

inline bool canPushSemanticOrderPage(
    const xpod::rdf::PhysicalBackend& backend,
    const BridgeOperationPlan& root,
    const BridgePhysicalScan& scan) noexcept {
  if (!canPushSemanticOrderPage(backend, root)) {
    return false;
  }
  return !hasExactConstraintOutsideSemanticOrder(
      scan, root.result_modifiers[0]);
}

inline QleverResultWithStatus makeEmptyOperationResult(
    xpod_rdf_status status,
    size_t width = 0,
    std::vector<ColumnIndex> sorted_by = {}) {
  return toQleverResult({status, makeQleverIdTable(width)}, std::move(sorted_by));
}


inline XpodBackedCandidateResult makeEmptyCandidateOperationResult(
    xpod_rdf_status status) {
  return {status, {}};
}

inline xpod_rdf_profile_kind profileEventKind(
    BridgeOperationKind kind) noexcept {
  switch (kind) {
    case BridgeOperationKind::Union:
      return XPOD_RDF_PROFILE_RDF_JOIN;
    case BridgeOperationKind::CartesianProductJoin:
      return XPOD_RDF_PROFILE_RDF_JOIN;
    case BridgeOperationKind::Minus:
      return XPOD_RDF_PROFILE_RDF_JOIN;
    case BridgeOperationKind::OptionalJoin:
      return XPOD_RDF_PROFILE_RDF_JOIN;
    case BridgeOperationKind::MultiColumnJoin:
      return XPOD_RDF_PROFILE_RDF_JOIN;
    case BridgeOperationKind::ExistsJoin:
      return XPOD_RDF_PROFILE_RDF_JOIN;
    case BridgeOperationKind::GroupBy:
      return XPOD_RDF_PROFILE_MATERIALIZED_RESULT;
    case BridgeOperationKind::TransitivePath:
      return XPOD_RDF_PROFILE_RDF_JOIN;
    case BridgeOperationKind::Describe:
      return XPOD_RDF_PROFILE_MATERIALIZED_RESULT;
    case BridgeOperationKind::HashJoin:
      return XPOD_RDF_PROFILE_RDF_JOIN;
    case BridgeOperationKind::TextSearch:
      return XPOD_RDF_PROFILE_TEXT_SEARCH;
    case BridgeOperationKind::VectorSearch:
      return XPOD_RDF_PROFILE_VECTOR_SEARCH;
    case BridgeOperationKind::Values:
      return XPOD_RDF_PROFILE_MATERIALIZED_RESULT;
    case BridgeOperationKind::PermutationScan:
    default:
      return XPOD_RDF_PROFILE_PERMUTATION_SCAN;
  }
}

inline void emitOperationProfileEvent(
    xpod::rdf::PhysicalBackend backend,
    const BridgeOperationPlan& root,
    xpod_rdf_profile_status status,
    uint64_t output_rows = 0,
    std::string_view details_json = {}) noexcept {
  if (root.profile_node == 0) {
    return;
  }
  xpod_rdf_profile_event event = {};
  event.node = root.profile_node;
  event.parent = root.parent_profile_node;
  event.has_parent = root.parent_profile_node != 0 ? 1 : 0;
  event.kind = profileEventKind(root.kind);
  event.status = status;
  std::string_view descriptor = profileKind(root.kind);
  event.descriptor = {descriptor.data(), descriptor.size()};
  event.output_rows = output_rows;
  event.details_json = {details_json.data(), details_json.size()};
  backend.emitProfileEvent(event);
}

inline std::string joinDiagnosticsDetailsJson(
    bool parameterized,
    uint64_t seed_rows,
    uint64_t unique_join_tuples,
    uint64_t dependent_backend_rows,
    std::string_view fallback_reason,
    uint64_t seed_batches = 0,
    uint64_t peak_seed_rows = 0) {
  std::ostringstream json;
  json << "{\"parameterized\":" << (parameterized ? "true" : "false")
       << ",\"seedRows\":" << seed_rows
       << ",\"uniqueJoinTuples\":" << unique_join_tuples
       << ",\"dependentBackendRows\":" << dependent_backend_rows
       << ",\"fallbackReason\":";
  if (fallback_reason.empty()) {
    json << "null";
  } else {
    json << '"';
    for (char c : fallback_reason) {
      if (c == '"' || c == '\\') {
        json << '\\';
      }
      json << c;
    }
    json << '"';
  }
  if (seed_batches != 0) {
    json << ",\"seedBatches\":" << seed_batches
         << ",\"peakSeedRows\":" << peak_seed_rows;
  }
  json << '}';
  return json.str();
}

inline std::string& lastBridgeOperationDetailsJson() noexcept {
  thread_local std::string details;
  return details;
}

inline void clearBridgeOperationDetailsJson() {
  lastBridgeOperationDetailsJson().clear();
}

inline void storeBridgeOperationDetailsJson(std::string details) {
  lastBridgeOperationDetailsJson() = std::move(details);
}

inline std::string_view bridgeOperationDetailsJson() noexcept {
  return lastBridgeOperationDetailsJson();
}

inline void emitCompletedOperationProfileEvent(
    xpod::rdf::PhysicalBackend backend,
    const BridgeOperationPlan& root,
    uint64_t output_rows,
    std::string details_json) {
  storeBridgeOperationDetailsJson(details_json);
  emitOperationProfileEvent(
      backend, root, XPOD_RDF_PROFILE_COMPLETED, output_rows,
      bridgeOperationDetailsJson());
}

inline bool candidateRowHasOutputColumn(
    const xpod::rdf::CandidateRow& row,
    BridgeCandidateColumnKind kind) noexcept {
  switch (kind) {
    case BridgeCandidateColumnKind::RetrievalPoint:
      return row.has_retrieval_point_key;
    case BridgeCandidateColumnKind::SourceKey:
      return row.has_source_key;
    case BridgeCandidateColumnKind::ResourceTerm:
      return row.has_resource_term;
  }
  return false;
}

inline xpod_rdf_status validateCandidateOutputColumns(
    const xpod::rdf::CandidateBuffer& candidates,
    const std::vector<BridgeCandidateOutputColumn>& columns) noexcept {
  if (columns.empty()) {
    return XPOD_RDF_STATUS_OK;
  }
  for (const xpod::rdf::CandidateRow& row : candidates.rows) {
    for (const BridgeCandidateOutputColumn& column : columns) {
      if (!candidateRowHasOutputColumn(row, column.kind)) {
        return XPOD_RDF_STATUS_UNSUPPORTED;
      }
    }
  }
  return XPOD_RDF_STATUS_OK;
}

enum class BridgePhysicalResultKind {
  RdfRows,
  CandidateRows,
};

struct BridgePhysicalResult {
  xpod_rdf_status status = XPOD_RDF_STATUS_UNSUPPORTED;
  BridgePhysicalResultKind kind = BridgePhysicalResultKind::RdfRows;
  std::optional<QleverResultWithStatus> rdf_rows;
  std::optional<XpodBackedCandidateResult> candidates;
};

inline XpodBackedCandidateResult executeBridgeTextCandidateSource(
    xpod::rdf::PhysicalBackend backend,
    const BridgeTextCandidateSource& source) {
  XpodBackedTextSearch adapter(
      backend, source.request, source.descriptor, source.profile_node,
      source.parent_profile_node);
  XpodBackedCandidateResult result = adapter.computeResult(false);
  if (result.status == XPOD_RDF_STATUS_OK) {
    xpod_rdf_status validation_status = validateCandidateOutputColumns(
        result.candidates, source.output_columns);
    if (validation_status != XPOD_RDF_STATUS_OK) {
      result.status = validation_status;
    }
  }
  return result;
}

inline XpodBackedCandidateResult executeBridgeVectorCandidateSource(
    xpod::rdf::PhysicalBackend backend,
    const BridgeVectorCandidateSource& source) {
  XpodBackedVectorSearch adapter(
      backend, source.request, source.descriptor, source.profile_node,
      source.parent_profile_node);
  XpodBackedCandidateResult result = adapter.computeResult(false);
  if (result.status == XPOD_RDF_STATUS_OK) {
    xpod_rdf_status validation_status = validateCandidateOutputColumns(
        result.candidates, source.output_columns);
    if (validation_status != XPOD_RDF_STATUS_OK) {
      result.status = validation_status;
    }
  }
  return result;
}

inline XpodBackedCandidateResult executeBridgeCandidateSource(
    xpod::rdf::PhysicalBackend backend,
    const BridgePhysicalPlan& plan) {
  if (plan.root.candidate_source == BridgeCandidateSourceKind::Text) {
    if (plan.root.candidate_index >= plan.text_sources.size()) {
      return makeEmptyCandidateOperationResult(XPOD_RDF_STATUS_UNSUPPORTED);
    }
    return executeBridgeTextCandidateSource(
        backend, plan.text_sources[plan.root.candidate_index]);
  }
  if (plan.root.candidate_source == BridgeCandidateSourceKind::Vector) {
    if (plan.root.candidate_index >= plan.vector_sources.size()) {
      return makeEmptyCandidateOperationResult(XPOD_RDF_STATUS_UNSUPPORTED);
    }
    return executeBridgeVectorCandidateSource(
        backend, plan.vector_sources[plan.root.candidate_index]);
  }
  return makeEmptyCandidateOperationResult(XPOD_RDF_STATUS_UNSUPPORTED);
}

inline XpodBackedCandidateResult executeBridgeCandidateOperationPlan(
    xpod::rdf::PhysicalBackend backend,
    const BridgePhysicalPlan& plan) {
  if (plan.root.kind == BridgeOperationKind::TextSearch) {
    if (plan.root.candidate_index >= plan.text_sources.size()) {
      return makeEmptyCandidateOperationResult(XPOD_RDF_STATUS_UNSUPPORTED);
    }
    return executeBridgeTextCandidateSource(
        backend, plan.text_sources[plan.root.candidate_index]);
  }
  if (plan.root.kind == BridgeOperationKind::VectorSearch) {
    if (plan.root.candidate_index >= plan.vector_sources.size()) {
      return makeEmptyCandidateOperationResult(XPOD_RDF_STATUS_UNSUPPORTED);
    }
    return executeBridgeVectorCandidateSource(
        backend, plan.vector_sources[plan.root.candidate_index]);
  }
  return makeEmptyCandidateOperationResult(XPOD_RDF_STATUS_UNSUPPORTED);
}

struct BridgeOwnedTermTupleFilter {
  std::vector<uint32_t> slots;
  std::vector<xpod_rdf_term_key> terms;
  xpod_rdf_term_tuple_filter view = {};

  void refreshView() noexcept {
    view.slots = slots.data();
    view.slot_count = slots.size();
    view.terms = terms.data();
    view.row_count = slots.empty() ? 0 : terms.size() / slots.size();
  }
};

inline QleverResultWithStatus executeBridgePhysicalScan(
    xpod::rdf::PhysicalBackend backend,
    const BridgePhysicalScan& scan) {
  XpodBackedIndexScan adapter(
      backend, scan.scan, scan.sorted_by, scan.result_width, scan.descriptor,
      scan.profile_node, scan.parent_profile_node);
  return adapter.computeResult(false);
}

template <typename TableT>
inline xpod_rdf_status collectJoinKeys(
    xpod::rdf::PhysicalBackend backend,
    const TableT& table,
    size_t join_column,
    std::unordered_set<xpod_rdf_term_key>& keys) {
  for (size_t row = 0; row < table.numRows(); ++row) {
    xpod_rdf_term_key key = 0;
    xpod_rdf_status status = backend.decodeQleverId(
        table(row, join_column).getBits(), key);
    if (status != XPOD_RDF_STATUS_OK) {
      return status;
    }
    keys.insert(key);
  }
  return XPOD_RDF_STATUS_OK;
}

inline bool candidateRowValue(
    const xpod::rdf::CandidateRow& row,
    BridgeCandidateColumnKind column,
    xpod_rdf_term_key& out_key) noexcept {
  switch (column) {
    case BridgeCandidateColumnKind::ResourceTerm:
      if (!row.has_resource_term) {
        return false;
      }
      out_key = row.resource_term;
      return true;
    case BridgeCandidateColumnKind::SourceKey:
      return false;
    case BridgeCandidateColumnKind::RetrievalPoint:
      if (!row.has_retrieval_point) {
        return false;
      }
      out_key = static_cast<xpod_rdf_term_key>(row.retrieval_point);
      return true;
  }
  return false;
}

inline xpod_rdf_status collectCandidateJoinRows(
    const xpod::rdf::CandidateBuffer& candidates,
    BridgeCandidateColumnKind join_column,
    std::unordered_map<
        xpod_rdf_term_key,
        std::vector<const xpod::rdf::CandidateRow*>>& rows_by_key) {
  for (const xpod::rdf::CandidateRow& row : candidates.rows) {
    xpod_rdf_term_key key = 0;
    if (!candidateRowValue(row, join_column, key)) {
      return XPOD_RDF_STATUS_UNSUPPORTED;
    }
    rows_by_key[key].push_back(&row);
  }
  return XPOD_RDF_STATUS_OK;
}

inline std::vector<ColumnIndex> shiftSortedBy(
    const std::vector<ColumnIndex>& sorted_by,
    size_t offset) {
  std::vector<ColumnIndex> shifted;
  shifted.reserve(sorted_by.size());
  for (ColumnIndex column : sorted_by) {
    shifted.push_back(column + offset);
  }
  return shifted;
}

template <typename TableT>
inline xpod_rdf_status filterTableByJoinKeys(
    xpod::rdf::PhysicalBackend backend,
    const TableT& input,
    size_t join_column,
    const std::unordered_set<xpod_rdf_term_key>& allowed_keys,
    IdTable& output) {
  std::vector<Id> row;
  row.reserve(input.numColumns());
  for (size_t input_row = 0; input_row < input.numRows(); ++input_row) {
    xpod_rdf_term_key key = 0;
    xpod_rdf_status status = backend.decodeQleverId(
        input(input_row, join_column).getBits(), key);
    if (status != XPOD_RDF_STATUS_OK) {
      return status;
    }
    if (allowed_keys.find(key) == allowed_keys.end()) {
      continue;
    }
    row.clear();
    for (size_t column = 0; column < input.numColumns(); ++column) {
      row.push_back(input(input_row, column));
    }
    output.push_back(row);
  }
  return XPOD_RDF_STATUS_OK;
}

inline bool scanIncludesSlot(
    const BridgePhysicalScan& scan,
    uint32_t slot) noexcept {
  return (normalizeNeededSlots(scan.scan.needed_slots) & slot) != 0;
}

template <typename TableT>
inline xpod_rdf_status appendScanProjection(
    const BridgePhysicalScan& scan,
    const TableT& table,
    size_t input_row,
    const std::vector<uint32_t>& project_slots,
    std::vector<Id>& row) {
  for (uint32_t slot : project_slots) {
    if (!scanIncludesSlot(scan, slot)) {
      return XPOD_RDF_STATUS_UNSUPPORTED;
    }
    size_t column = columnForSlot(
        scan.scan.permutation, scan.scan.needed_slots, slot);
    if (column >= table.numColumns()) {
      return XPOD_RDF_STATUS_UNSUPPORTED;
    }
    row.push_back(table(input_row, column));
  }
  return XPOD_RDF_STATUS_OK;
}

using ProjectedScanRow = std::vector<Id>;

struct JoinKey {
  std::vector<xpod_rdf_term_key> values;

  bool operator==(const JoinKey& other) const {
    return values == other.values;
  }
};

struct JoinKeyHash {
  size_t operator()(const JoinKey& key) const noexcept {
    size_t seed = key.values.size();
    for (xpod_rdf_term_key value : key.values) {
      seed ^= std::hash<xpod_rdf_term_key>{}(value) + 0x9e3779b97f4a7c15ULL +
              (seed << 6) + (seed >> 2);
    }
    return seed;
  }
};

using ProjectedRowsByKey =
    std::unordered_map<JoinKey, std::vector<ProjectedScanRow>, JoinKeyHash>;

inline std::vector<uint32_t> joinKeySlotsForScan(
    const BridgeOperationPlan& root,
    size_t scan_position) {
  if (root.join_key_slots.size() == root.scan_indexes.size() &&
      scan_position < root.join_key_slots.size()) {
    return root.join_key_slots[scan_position];
  }
  if (root.join_slots.size() == root.scan_indexes.size() &&
      scan_position < root.join_slots.size()) {
    return {root.join_slots[scan_position]};
  }
  return {root.join_slot};
}

inline std::vector<uint32_t> fallbackJoinKeySlotsForScan(
    const BridgeOperationPlan& root,
    size_t scan_position) {
  std::vector<uint32_t> slots = joinKeySlotsForScan(root, scan_position);
  if (!slots.empty()) {
    return slots;
  }
  if (root.join_slots.size() == root.scan_indexes.size() &&
      scan_position < root.join_slots.size()) {
    return {root.join_slots[scan_position]};
  }
  return {root.join_slot};
}

inline std::string_view projectedHashJoinFallbackReason(
    const BridgeOperationPlan& root,
    bool backend_supports_tuple_filter) {
  if (!backend_supports_tuple_filter) {
    return "backend-missing-term-tuple-filter";
  }
  const std::vector<uint32_t> left_join_slots =
      joinKeySlotsForScan(root, 0);
  if (left_join_slots.empty()) {
    return "join-key-slots-empty";
  }
  if (left_join_slots.size() > 4) {
    return "join-key-width-exceeds-four";
  }
  for (size_t scan_position = 1;
       scan_position < root.scan_indexes.size(); ++scan_position) {
    const std::vector<uint32_t> right_join_slots =
        joinKeySlotsForScan(root, scan_position);
    if (right_join_slots.empty()) {
      return "join-key-slots-empty";
    }
    if (left_join_slots.size() != right_join_slots.size()) {
      return "join-key-arity-mismatch";
    }
    if (right_join_slots.size() > 4) {
      return "join-key-width-exceeds-four";
    }
  }
  return {};
}

template <typename TableT>
inline xpod_rdf_status decodeJoinKey(
    xpod::rdf::PhysicalBackend backend,
    const BridgePhysicalScan& scan,
    const TableT& table,
    size_t input_row,
    const std::vector<uint32_t>& key_slots,
    JoinKey& out_key) {
  if (key_slots.empty()) {
    return XPOD_RDF_STATUS_UNSUPPORTED;
  }
  out_key.values.clear();
  out_key.values.reserve(key_slots.size());
  for (uint32_t slot : key_slots) {
    if (!scanIncludesSlot(scan, slot)) {
      return XPOD_RDF_STATUS_UNSUPPORTED;
    }
    size_t column = columnForSlot(
        scan.scan.permutation, scan.scan.needed_slots, slot);
    if (column >= table.numColumns()) {
      return XPOD_RDF_STATUS_UNSUPPORTED;
    }
    xpod_rdf_term_key key = 0;
    xpod_rdf_status status = backend.decodeQleverId(
        table(input_row, column).getBits(), key);
    if (status != XPOD_RDF_STATUS_OK) {
      return status;
    }
    out_key.values.push_back(key);
  }
  return XPOD_RDF_STATUS_OK;
}

template <typename TableT>
inline xpod_rdf_status collectProjectedScanRowsByJoinKey(
    xpod::rdf::PhysicalBackend backend,
    const BridgePhysicalScan& scan,
    const TableT& table,
    const std::vector<uint32_t>& join_slots,
    const std::vector<uint32_t>& project_slots,
    ProjectedRowsByKey& rows_by_key) {
  JoinKey key;
  std::vector<Id> projected_row;
  projected_row.reserve(project_slots.size());
  for (size_t input_row = 0; input_row < table.numRows(); ++input_row) {
    xpod_rdf_status status = decodeJoinKey(
        backend, scan, table, input_row, join_slots, key);
    if (status != XPOD_RDF_STATUS_OK) {
      return status;
    }
    projected_row.clear();
    status = appendScanProjection(
        scan, table, input_row, project_slots, projected_row);
    if (status != XPOD_RDF_STATUS_OK) {
      return status;
    }
    rows_by_key[key].push_back(projected_row);
  }
  return XPOD_RDF_STATUS_OK;
}

inline bool appendProjectedCombinations(
    const std::vector<const std::vector<ProjectedScanRow>*>& groups,
    size_t group_index,
    std::vector<Id>& row,
    IdTable& output,
    size_t max_output_rows = std::numeric_limits<size_t>::max()) {
  if (output.numRows() >= max_output_rows) {
    return true;
  }
  if (group_index >= groups.size()) {
    output.push_back(row);
    return output.numRows() >= max_output_rows;
  }
  for (const ProjectedScanRow& projected : *groups[group_index]) {
    size_t before = row.size();
    row.insert(row.end(), projected.begin(), projected.end());
    const bool full = appendProjectedCombinations(
        groups, group_index + 1, row, output, max_output_rows);
    while (row.size() > before) {
      row.pop_back();
    }
    if (full) {
      return true;
    }
  }
  return false;
}

template <typename TableT>
inline xpod_rdf_status joinTableWithProjectedScanRows(
    xpod::rdf::PhysicalBackend backend,
    const BridgePhysicalScan& left_scan,
    const TableT& left_table,
    const std::vector<uint32_t>& left_join_slots,
    const std::vector<uint32_t>& left_project_slots,
    const std::vector<ProjectedRowsByKey>& filter_rows_by_key,
    IdTable& output,
    size_t max_output_rows = std::numeric_limits<size_t>::max()) {
  std::vector<Id> row;
  row.reserve(output.numColumns());
  std::vector<const std::vector<ProjectedScanRow>*> matching_groups;
  matching_groups.reserve(filter_rows_by_key.size());
  JoinKey key;
  for (size_t input_row = 0; input_row < left_table.numRows(); ++input_row) {
    xpod_rdf_status status = decodeJoinKey(
        backend, left_scan, left_table, input_row, left_join_slots, key);
    if (status != XPOD_RDF_STATUS_OK) {
      return status;
    }
    matching_groups.clear();
    bool matched = true;
    for (const ProjectedRowsByKey& rows_by_key : filter_rows_by_key) {
      auto found = rows_by_key.find(key);
      if (found == rows_by_key.end()) {
        matched = false;
        break;
      }
      matching_groups.push_back(&found->second);
    }
    if (!matched) {
      continue;
    }

    row.clear();
    status = appendScanProjection(
        left_scan, left_table, input_row, left_project_slots, row);
    if (status != XPOD_RDF_STATUS_OK) {
      return status;
    }
    if (appendProjectedCombinations(
            matching_groups, 0, row, output, max_output_rows)) {
      break;
    }
  }
  return XPOD_RDF_STATUS_OK;
}

inline xpod_rdf_status appendCandidateProjection(
    const xpod::rdf::PhysicalBackend& backend,
    const xpod::rdf::CandidateRow& candidate,
    const std::vector<BridgeCandidateOutputColumn>& columns,
    LocalVocab& local_vocab,
    std::vector<Id>& row) {
  (void)local_vocab;
  for (const BridgeCandidateOutputColumn& column : columns) {
    if (column.kind == BridgeCandidateColumnKind::RetrievalPoint ||
        column.kind == BridgeCandidateColumnKind::SourceKey) {
#if XPOD_QLEVER_OPERATION_HAS_VALUE_ID_DATATYPE
      const std::string& value =
          column.kind == BridgeCandidateColumnKind::RetrievalPoint
              ? candidate.retrieval_point_key
              : candidate.source_key;
      const bool has_value =
          column.kind == BridgeCandidateColumnKind::RetrievalPoint
              ? candidate.has_retrieval_point_key
              : candidate.has_source_key;
      if (!has_value) {
        return XPOD_RDF_STATUS_UNSUPPORTED;
      }
      std::optional<Id> id = bridgeLocalVocabLiteralId(local_vocab, value);
      if (!id.has_value()) {
        return XPOD_RDF_STATUS_UNSUPPORTED;
      }
      row.push_back(*id);
      continue;
#else
      return XPOD_RDF_STATUS_UNSUPPORTED;
#endif
    }
    xpod_rdf_term_key key = 0;
    if (!candidateRowValue(candidate, column.kind, key)) {
      return XPOD_RDF_STATUS_UNSUPPORTED;
    }
    uint64_t bits = 0;
    xpod_rdf_status status = backend.encodeQleverId(key, bits);
    if (status != XPOD_RDF_STATUS_OK) {
      return status;
    }
    row.push_back(Id::fromBits(bits));
  }
  return XPOD_RDF_STATUS_OK;
}

template <typename TableT>
inline xpod_rdf_status joinTableWithCandidateRows(
    xpod::rdf::PhysicalBackend backend,
    const TableT& input,
    size_t join_column,
    const std::unordered_map<
        xpod_rdf_term_key,
        std::vector<const xpod::rdf::CandidateRow*>>& rows_by_key,
    const std::vector<BridgeCandidateOutputColumn>& project_columns,
    LocalVocab& local_vocab,
    IdTable& output) {
  std::vector<Id> row;
  row.reserve(input.numColumns() + project_columns.size());
  for (size_t input_row = 0; input_row < input.numRows(); ++input_row) {
    xpod_rdf_term_key key = 0;
    xpod_rdf_status status = backend.decodeQleverId(
        input(input_row, join_column).getBits(), key);
    if (status != XPOD_RDF_STATUS_OK) {
      return status;
    }
    auto candidates = rows_by_key.find(key);
    if (candidates == rows_by_key.end()) {
      continue;
    }
    for (const xpod::rdf::CandidateRow* candidate : candidates->second) {
      row.clear();
      status = appendCandidateProjection(
          backend, *candidate, project_columns, local_vocab, row);
      if (status != XPOD_RDF_STATUS_OK) {
        return status;
      }
      for (size_t column = 0; column < input.numColumns(); ++column) {
        row.push_back(input(input_row, column));
      }
      output.push_back(row);
    }
  }
  return XPOD_RDF_STATUS_OK;
}

inline void intersectJoinKeys(
    std::unordered_set<xpod_rdf_term_key>& keys,
    const std::unordered_set<xpod_rdf_term_key>& filter_keys) {
  for (auto it = keys.begin(); it != keys.end();) {
    if (filter_keys.find(*it) == filter_keys.end()) {
      it = keys.erase(it);
    } else {
      ++it;
    }
  }
}

inline uint32_t joinSlotForScan(
    const BridgeOperationPlan& root,
    size_t scan_position) noexcept {
  if (root.join_slots.size() == root.scan_indexes.size() &&
      scan_position < root.join_slots.size()) {
    return root.join_slots[scan_position];
  }
  return root.join_slot;
}

inline QleverResultWithStatus executeBridgeCandidateHashJoin(
    xpod::rdf::PhysicalBackend backend,
    const BridgePhysicalPlan& plan) {
  if (plan.root.scan_indexes.size() != 1) {
    return makeEmptyOperationResult(XPOD_RDF_STATUS_UNSUPPORTED);
  }
  size_t scan_index = plan.root.scan_indexes.front();
  if (scan_index >= plan.scans.size()) {
    return makeEmptyOperationResult(XPOD_RDF_STATUS_UNSUPPORTED);
  }

  const BridgePhysicalScan& scan = plan.scans[scan_index];
  emitOperationProfileEvent(
      backend, plan.root, XPOD_RDF_PROFILE_RUNNING);
  XpodBackedCandidateResult candidates = executeBridgeCandidateSource(
      backend, plan);
  if (candidates.status != XPOD_RDF_STATUS_OK) {
    emitOperationProfileEvent(
        backend, plan.root, XPOD_RDF_PROFILE_FAILED);
    return makeEmptyOperationResult(candidates.status, scan.result_width,
                                    scan.sorted_by);
  }

  std::unordered_map<
      xpod_rdf_term_key,
      std::vector<const xpod::rdf::CandidateRow*>> candidate_rows_by_key;
  xpod_rdf_status status = collectCandidateJoinRows(
      candidates.candidates, plan.root.candidate_join_column,
      candidate_rows_by_key);
  if (status != XPOD_RDF_STATUS_OK) {
    emitOperationProfileEvent(
        backend, plan.root, XPOD_RDF_PROFILE_FAILED);
    return makeEmptyOperationResult(status, scan.result_width,
                                    scan.sorted_by);
  }

  QleverResultWithStatus scan_result = executeBridgePhysicalScan(backend, scan);
  if (scan_result.status != XPOD_RDF_STATUS_OK) {
    emitOperationProfileEvent(
        backend, plan.root, XPOD_RDF_PROFILE_FAILED);
    return scan_result;
  }

  const size_t projected_columns = plan.root.candidate_project_columns.size();
  IdTable output = makeQleverIdTable(qleverResultTable(scan_result.result).numColumns() + projected_columns);
  LocalVocab local_vocab;
  status = joinTableWithCandidateRows(
      backend, qleverResultTable(scan_result.result),
      columnForSlot(
          scan.scan.permutation, scan.scan.needed_slots,
          joinSlotForScan(plan.root, 0)),
      candidate_rows_by_key, plan.root.candidate_project_columns, local_vocab,
      output);
  if (status != XPOD_RDF_STATUS_OK) {
    emitOperationProfileEvent(
        backend, plan.root, XPOD_RDF_PROFILE_FAILED);
    return makeEmptyOperationResult(status, scan.result_width,
                                    scan.sorted_by);
  }
  emitOperationProfileEvent(
      backend, plan.root, XPOD_RDF_PROFILE_COMPLETED, output.numRows());
  return toQleverResult({XPOD_RDF_STATUS_OK, std::move(output)},
                        shiftSortedBy(scan.sorted_by, projected_columns),
                        std::move(local_vocab));
}

inline size_t projectedHashJoinWidth(
    const BridgeOperationPlan& root) noexcept {
  size_t width = 0;
  for (const std::vector<uint32_t>& slots : root.scan_project_slots) {
    width += slots.size();
  }
  return width;
}

inline std::vector<ColumnIndex> projectedSortedBy(
    const BridgePhysicalScan& scan,
    const std::vector<ColumnIndex>& actual_sorted_by,
    const std::vector<uint32_t>& project_slots) {
  std::vector<ColumnIndex> sorted_by;
  for (ColumnIndex sorted_column : actual_sorted_by) {
    bool mapped = false;
    for (size_t output_column = 0; output_column < project_slots.size();
         ++output_column) {
      uint32_t slot = project_slots[output_column];
      if (!scanIncludesSlot(scan, slot)) {
        continue;
      }
      if (columnForSlot(
              scan.scan.permutation, scan.scan.needed_slots, slot) ==
          sorted_column) {
        sorted_by.push_back(output_column);
        mapped = true;
        break;
      }
    }
    if (!mapped) {
      break;
    }
  }
  return sorted_by;
}

inline bool canPageProjectedJoinSeed(
    const xpod::rdf::PhysicalBackend& backend) noexcept {
  xpod_rdf_backend_capabilities capabilities = {};
  if (backend.getCapabilities(capabilities) != XPOD_RDF_STATUS_OK) {
    return false;
  }
  constexpr uint64_t required =
      XPOD_RDF_BACKEND_FEATURE_SCAN_LIMIT |
      XPOD_RDF_BACKEND_FEATURE_SCAN_OFFSET;
  return (capabilities.features & required) == required;
}

inline const BridgeResultModifier* boundedProjectedJoinOrder(
    const BridgeOperationPlan& root) noexcept {
  if (root.result_modifiers.size() < 2 ||
      root.result_modifiers[0].kind != BridgeResultModifierKind::OrderBy ||
      root.result_modifiers[1].kind !=
          BridgeResultModifierKind::LimitOffset) {
    return nullptr;
  }
  for (size_t index = 2; index < root.result_modifiers.size(); ++index) {
    if (root.result_modifiers[index].kind !=
        BridgeResultModifierKind::Project) {
      return nullptr;
    }
  }
  return &root.result_modifiers[0];
}

inline const BridgeResultModifier* boundedProjectedJoinPage(
    const BridgeOperationPlan& root) noexcept {
  return boundedProjectedJoinOrder(root) == nullptr
      ? nullptr
      : &root.result_modifiers[1];
}

inline bool projectedJoinOrderIsSeedPrefix(
    const BridgeResultModifier& order,
    const std::vector<ColumnIndex>& seed_sorted_by) noexcept {
  if (order.columns.empty() ||
      order.columns.size() > seed_sorted_by.size() ||
      order.columns.size() != order.descending.size()) {
    return false;
  }
  for (size_t index = 0; index < order.columns.size(); ++index) {
    if (order.descending[index] ||
        order.columns[index] != seed_sorted_by[index]) {
      return false;
    }
  }
  return true;
}

template <typename TableT>
inline void appendTableRows(const TableT& input, IdTable& output) {
  std::vector<Id> row;
  row.reserve(input.numColumns());
  for (size_t input_row = 0; input_row < input.numRows(); ++input_row) {
    row.clear();
    for (size_t column = 0; column < input.numColumns(); ++column) {
      row.push_back(input(input_row, column));
    }
    output.push_back(row);
  }
}

inline QleverResultWithStatus applyBridgeOrderByLimitOffset(
    const xpod::rdf::PhysicalBackend& backend,
    const BridgeResultModifier& order_by,
    const BridgeResultModifier& page,
    QleverResultWithStatus result,
    const LocalVocab* local_vocab);

inline QleverResultWithStatus executeBridgeProjectedHashJoin(
    xpod::rdf::PhysicalBackend backend,
    const BridgePhysicalPlan& plan) {
  clearBridgeOperationDetailsJson();
  if (plan.root.scan_indexes.size() < 2 ||
      plan.root.scan_project_slots.size() != plan.root.scan_indexes.size()) {
    return makeEmptyOperationResult(XPOD_RDF_STATUS_UNSUPPORTED);
  }
  size_t left_index = plan.root.scan_indexes[0];
  if (left_index >= plan.scans.size()) {
    return makeEmptyOperationResult(XPOD_RDF_STATUS_UNSUPPORTED);
  }

  const BridgePhysicalScan& left_scan = plan.scans[left_index];
  const size_t output_width = projectedHashJoinWidth(plan.root);
  std::vector<ProjectedRowsByKey> filter_rows_by_key;
  filter_rows_by_key.reserve(plan.root.scan_indexes.size() - 1);

  emitOperationProfileEvent(
      backend, plan.root, XPOD_RDF_PROFILE_RUNNING);
  const bool backend_supports_tuple_filter = backend.supportsTermTupleFilter();
  const std::string_view fallback_reason =
      projectedHashJoinFallbackReason(plan.root, backend_supports_tuple_filter);
  if (fallback_reason.empty()) {
    const std::vector<uint32_t> left_join_slots =
        joinKeySlotsForScan(plan.root, 0);
    if (!left_join_slots.empty() && left_join_slots.size() <= 4) {
      uint64_t dependent_backend_rows = 0;
      const size_t tuple_filter_batch_size =
          backend.termTupleFilterBatchSize();
      const bool page_seed = canPageProjectedJoinSeed(backend);
      const BridgeResultModifier* bounded_order =
          boundedProjectedJoinOrder(plan.root);
      const BridgeResultModifier* bounded_page =
          boundedProjectedJoinPage(plan.root);
      if (bounded_page != nullptr && bounded_page->limit == 0) {
        const std::string details = joinDiagnosticsDetailsJson(
            true, 0, 0, 0, {});
        emitCompletedOperationProfileEvent(
            backend, plan.root, 0, details);
        return toQleverResult(
            {XPOD_RDF_STATUS_OK, makeQleverIdTable(output_width)}, {});
      }
      size_t retained_rows = 0;
      if (bounded_page != nullptr) {
        retained_rows = bounded_page->offset >
                std::numeric_limits<size_t>::max() - bounded_page->limit
            ? std::numeric_limits<size_t>::max()
            : bounded_page->offset + bounded_page->limit;
      }
      IdTable output = makeQleverIdTable(output_width);
      std::unordered_set<JoinKey, JoinKeyHash> all_seen_keys;
      std::vector<ColumnIndex> output_sorted_by;
      uint64_t seed_rows = 0;
      uint64_t seed_batches = 0;
      uint64_t peak_seed_rows = 0;
      size_t seed_offset = 0;
      bool stopped_on_ordered_page = false;
      while (true) {
        BridgePhysicalScan seed_scan = left_scan;
        if (page_seed) {
          const size_t original_limit =
              static_cast<size_t>(left_scan.scan.limit);
          if (original_limit != 0 && seed_offset >= original_limit) {
            break;
          }
          const size_t remaining =
              original_limit == 0
              ? tuple_filter_batch_size
              : std::min(
                    tuple_filter_batch_size, original_limit - seed_offset);
          seed_scan.scan.limit = remaining;
          seed_scan.scan.offset =
              left_scan.scan.offset >
                      std::numeric_limits<uint64_t>::max() - seed_offset
              ? std::numeric_limits<uint64_t>::max()
              : left_scan.scan.offset + seed_offset;
        }
        QleverResultWithStatus left =
            executeBridgePhysicalScan(backend, seed_scan);
        if (left.status != XPOD_RDF_STATUS_OK) {
          emitOperationProfileEvent(
              backend, plan.root, XPOD_RDF_PROFILE_FAILED);
          return left;
        }
        const auto& left_table = qleverResultTable(left.result);
        if (left_table.numRows() == 0) {
          break;
        }
        ++seed_batches;
        seed_rows += static_cast<uint64_t>(left_table.numRows());
        peak_seed_rows = std::max(
            peak_seed_rows, static_cast<uint64_t>(left_table.numRows()));
        if (output_sorted_by.empty()) {
          output_sorted_by = projectedSortedBy(
              left_scan, left.result.sortedBy(),
              plan.root.scan_project_slots[0]);
        }

        std::vector<JoinKey> unique_keys;
        unique_keys.reserve(left_table.numRows());
        std::unordered_set<JoinKey, JoinKeyHash> batch_seen_keys;
        JoinKey key;
        for (size_t row = 0; row < left_table.numRows(); ++row) {
          xpod_rdf_status status = decodeJoinKey(
              backend, left_scan, left_table, row, left_join_slots, key);
          if (status != XPOD_RDF_STATUS_OK) {
            emitOperationProfileEvent(
                backend, plan.root, XPOD_RDF_PROFILE_FAILED);
            return makeEmptyOperationResult(status, output_width);
          }
          all_seen_keys.insert(key);
          if (batch_seen_keys.insert(key).second) {
            unique_keys.push_back(key);
          }
        }

        filter_rows_by_key.clear();
        for (size_t scan_position = 1;
             scan_position < plan.root.scan_indexes.size(); ++scan_position) {
          const size_t right_index = plan.root.scan_indexes[scan_position];
          if (right_index >= plan.scans.size()) {
            emitOperationProfileEvent(
                backend, plan.root, XPOD_RDF_PROFILE_FAILED);
            return makeEmptyOperationResult(
                XPOD_RDF_STATUS_UNSUPPORTED, output_width);
          }
          const std::vector<uint32_t> right_join_slots =
              joinKeySlotsForScan(plan.root, scan_position);
          ProjectedRowsByKey rows_by_key;
          for (size_t batch_begin = 0; batch_begin < unique_keys.size();
               batch_begin += tuple_filter_batch_size) {
            const size_t batch_end = std::min(
                unique_keys.size(), batch_begin + tuple_filter_batch_size);
            BridgeOwnedTermTupleFilter filter;
            filter.slots = right_join_slots;
            filter.terms.reserve(
                (batch_end - batch_begin) * filter.slots.size());
            for (size_t key_index = batch_begin; key_index < batch_end;
                 ++key_index) {
              const JoinKey& unique_key = unique_keys[key_index];
              filter.terms.insert(
                  filter.terms.end(), unique_key.values.begin(),
                  unique_key.values.end());
            }
            filter.refreshView();

            BridgePhysicalScan right_scan = plan.scans[right_index];
            right_scan.scan.term_tuple_filter = &filter.view;
            QleverResultWithStatus right =
                executeBridgePhysicalScan(backend, right_scan);
            if (right.status != XPOD_RDF_STATUS_OK) {
              emitOperationProfileEvent(
                  backend, plan.root, XPOD_RDF_PROFILE_FAILED);
              return right;
            }
            dependent_backend_rows += static_cast<uint64_t>(
                qleverResultTable(right.result).numRows());
            xpod_rdf_status status = collectProjectedScanRowsByJoinKey(
                backend, right_scan, qleverResultTable(right.result),
                right_join_slots,
                plan.root.scan_project_slots[scan_position], rows_by_key);
            if (status != XPOD_RDF_STATUS_OK) {
              emitOperationProfileEvent(
                  backend, plan.root, XPOD_RDF_PROFILE_FAILED);
              return makeEmptyOperationResult(status, output_width);
            }
          }
          filter_rows_by_key.push_back(std::move(rows_by_key));
        }

        const bool seed_ordered_page =
            bounded_order != nullptr && bounded_page != nullptr &&
            projectedJoinOrderIsSeedPrefix(
                *bounded_order, output_sorted_by);
        const size_t joined_batch_limit =
            seed_ordered_page && retained_rows > output.numRows()
            ? retained_rows - output.numRows()
            : (seed_ordered_page
                   ? 0
                   : std::numeric_limits<size_t>::max());
        IdTable joined_batch = makeQleverIdTable(output_width);
        xpod_rdf_status status = joinTableWithProjectedScanRows(
            backend, left_scan, left_table, left_join_slots,
            plan.root.scan_project_slots[0], filter_rows_by_key,
            joined_batch, joined_batch_limit);
        if (status != XPOD_RDF_STATUS_OK) {
          emitOperationProfileEvent(
              backend, plan.root, XPOD_RDF_PROFILE_FAILED);
          return makeEmptyOperationResult(status, output_width);
        }
        if (bounded_order == nullptr || bounded_page == nullptr) {
          appendTableRows(joined_batch, output);
        } else if (seed_ordered_page) {
          appendTableRows(joined_batch, output);
          if (output.numRows() >= retained_rows) {
            stopped_on_ordered_page = true;
          }
        } else if (retained_rows != 0) {
          IdTable candidates = makeQleverIdTable(output_width);
          appendTableRows(output, candidates);
          appendTableRows(joined_batch, candidates);
          BridgeResultModifier retained_page = *bounded_page;
          retained_page.offset = 0;
          retained_page.limit = retained_rows;
          QleverResultWithStatus retained = applyBridgeOrderByLimitOffset(
              backend, *bounded_order, retained_page,
              toQleverResult(
                  {XPOD_RDF_STATUS_OK, std::move(candidates)}, {}),
              nullptr);
          if (retained.status != XPOD_RDF_STATUS_OK) {
            emitOperationProfileEvent(
                backend, plan.root, XPOD_RDF_PROFILE_FAILED);
            return retained;
          }
          output = makeQleverIdTable(output_width);
          appendTableRows(qleverResultTable(retained.result), output);
          output_sorted_by.clear();
        }

        if (stopped_on_ordered_page) {
          break;
        }
        if (!page_seed ||
            left_table.numRows() <
                static_cast<size_t>(seed_scan.scan.limit)) {
          break;
        }
        seed_offset += left_table.numRows();
      }
      const std::string details = joinDiagnosticsDetailsJson(
          true, seed_rows, static_cast<uint64_t>(all_seen_keys.size()),
          dependent_backend_rows, {},
          page_seed ? seed_batches : 0,
          page_seed ? peak_seed_rows : 0);
      emitCompletedOperationProfileEvent(
          backend, plan.root, output.numRows(), details);
      return toQleverResult(
          {XPOD_RDF_STATUS_OK, std::move(output)},
          std::move(output_sorted_by));
    }
  }
  for (size_t i = 1; i < plan.root.scan_indexes.size(); ++i) {
    size_t right_index = plan.root.scan_indexes[i];
    if (right_index >= plan.scans.size()) {
      emitOperationProfileEvent(
          backend, plan.root, XPOD_RDF_PROFILE_FAILED);
      return makeEmptyOperationResult(
          XPOD_RDF_STATUS_UNSUPPORTED, output_width);
    }
    const BridgePhysicalScan& right_scan = plan.scans[right_index];
    QleverResultWithStatus right = executeBridgePhysicalScan(backend, right_scan);
    if (right.status != XPOD_RDF_STATUS_OK) {
      emitOperationProfileEvent(
          backend, plan.root, XPOD_RDF_PROFILE_FAILED);
      return right;
    }
    ProjectedRowsByKey rows_by_key;
    xpod_rdf_status status = collectProjectedScanRowsByJoinKey(
        backend, right_scan, qleverResultTable(right.result),
        fallbackJoinKeySlotsForScan(plan.root, i),
        plan.root.scan_project_slots[i], rows_by_key);
    if (status != XPOD_RDF_STATUS_OK) {
      emitOperationProfileEvent(
          backend, plan.root, XPOD_RDF_PROFILE_FAILED);
      return makeEmptyOperationResult(status, output_width);
    }
    filter_rows_by_key.push_back(std::move(rows_by_key));
  }

  QleverResultWithStatus left = executeBridgePhysicalScan(backend, left_scan);
  if (left.status != XPOD_RDF_STATUS_OK) {
    emitOperationProfileEvent(
        backend, plan.root, XPOD_RDF_PROFILE_FAILED);
    return left;
  }

  IdTable output = makeQleverIdTable(output_width);
  xpod_rdf_status status = joinTableWithProjectedScanRows(
      backend, left_scan, qleverResultTable(left.result),
      fallbackJoinKeySlotsForScan(plan.root, 0),
      plan.root.scan_project_slots[0], filter_rows_by_key, output);
  if (status != XPOD_RDF_STATUS_OK) {
    emitOperationProfileEvent(
        backend, plan.root, XPOD_RDF_PROFILE_FAILED);
    return makeEmptyOperationResult(status, output_width);
  }
  const std::string details = joinDiagnosticsDetailsJson(
      false, 0, 0, 0, fallback_reason);
  emitCompletedOperationProfileEvent(
      backend, plan.root, output.numRows(), details);
  return toQleverResult(
      {XPOD_RDF_STATUS_OK, std::move(output)},
      projectedSortedBy(
          left_scan, left.result.sortedBy(),
          plan.root.scan_project_slots[0]));
}

inline QleverResultWithStatus executeBridgeChildHashJoin(
    xpod::rdf::PhysicalBackend backend,
    const BridgePhysicalPlan& plan,
    const BridgeOperationPlan& root);

inline QleverResultWithStatus executeBridgeHashJoin(
    xpod::rdf::PhysicalBackend backend,
    const BridgePhysicalPlan& plan) {
  if (plan.root.use_candidate_join) {
    return executeBridgeCandidateHashJoin(backend, plan);
  }
  if (!plan.root.scan_project_slots.empty()) {
    return executeBridgeProjectedHashJoin(backend, plan);
  }
  if (!plan.root.children.empty()) {
    return executeBridgeChildHashJoin(backend, plan, plan.root);
  }
  if (plan.root.scan_indexes.size() < 2) {
    return makeEmptyOperationResult(XPOD_RDF_STATUS_UNSUPPORTED);
  }
  size_t left_index = plan.root.scan_indexes[0];
  if (left_index >= plan.scans.size()) {
    return makeEmptyOperationResult(XPOD_RDF_STATUS_UNSUPPORTED);
  }

  const BridgePhysicalScan& left_scan = plan.scans[left_index];
  std::unordered_set<xpod_rdf_term_key> allowed_keys;
  emitOperationProfileEvent(
      backend, plan.root, XPOD_RDF_PROFILE_RUNNING);
  for (size_t i = 1; i < plan.root.scan_indexes.size(); ++i) {
    size_t right_index = plan.root.scan_indexes[i];
    if (right_index >= plan.scans.size()) {
      emitOperationProfileEvent(
          backend, plan.root, XPOD_RDF_PROFILE_FAILED);
      return makeEmptyOperationResult(XPOD_RDF_STATUS_UNSUPPORTED);
    }
    const BridgePhysicalScan& right_scan = plan.scans[right_index];
    QleverResultWithStatus right = executeBridgePhysicalScan(backend, right_scan);
    if (right.status != XPOD_RDF_STATUS_OK) {
      emitOperationProfileEvent(
          backend, plan.root, XPOD_RDF_PROFILE_FAILED);
      return right;
    }
    std::unordered_set<xpod_rdf_term_key> filter_keys;
    xpod_rdf_status status = collectJoinKeys(
        backend, qleverResultTable(right.result),
        columnForSlot(
            right_scan.scan.permutation, right_scan.scan.needed_slots,
            joinSlotForScan(plan.root, i)),
        filter_keys);
    if (status != XPOD_RDF_STATUS_OK) {
      emitOperationProfileEvent(
          backend, plan.root, XPOD_RDF_PROFILE_FAILED);
      return makeEmptyOperationResult(status, left_scan.result_width,
                                      left_scan.sorted_by);
    }
    if (i == 1) {
      allowed_keys = std::move(filter_keys);
    } else {
      intersectJoinKeys(allowed_keys, filter_keys);
    }
  }

  QleverResultWithStatus left = executeBridgePhysicalScan(backend, left_scan);
  if (left.status != XPOD_RDF_STATUS_OK) {
    emitOperationProfileEvent(
        backend, plan.root, XPOD_RDF_PROFILE_FAILED);
    return left;
  }

  IdTable output = makeQleverIdTable(qleverResultTable(left.result).numColumns());
  xpod_rdf_status status = filterTableByJoinKeys(
      backend, qleverResultTable(left.result),
      columnForSlot(
          left_scan.scan.permutation, left_scan.scan.needed_slots,
          joinSlotForScan(plan.root, 0)),
      allowed_keys, output);
  if (status != XPOD_RDF_STATUS_OK) {
    emitOperationProfileEvent(
        backend, plan.root, XPOD_RDF_PROFILE_FAILED);
    return makeEmptyOperationResult(status, left_scan.result_width,
                                    left_scan.sorted_by);
  }
  emitOperationProfileEvent(
      backend, plan.root, XPOD_RDF_PROFILE_COMPLETED, output.numRows());
  return toQleverResult({XPOD_RDF_STATUS_OK, std::move(output)},
                        left_scan.sorted_by);
}

inline QleverResultWithStatus applyBridgeLimitOffset(
    const BridgeOperationPlan& root,
    QleverResultWithStatus result) {
  if (!root.has_limit || result.status != XPOD_RDF_STATUS_OK) {
    return result;
  }

  const auto& input = qleverResultTable(result.result);
  IdTable output = makeQleverIdTable(input.numColumns());
  const size_t row_count = input.numRows();
  const size_t start = root.offset < row_count ? root.offset : row_count;
  size_t end = start + root.limit;
  if (end < start || end > row_count) {
    end = row_count;
  }

  std::vector<Id> row;
  row.reserve(input.numColumns());
  for (size_t input_row = start; input_row < end; ++input_row) {
    row.clear();
    for (size_t column = 0; column < input.numColumns(); ++column) {
      row.push_back(input(input_row, column));
    }
    output.push_back(row);
  }

  return toQleverResult(
      {XPOD_RDF_STATUS_OK, std::move(output)}, result.result.sortedBy());
}

inline QleverResultWithStatus applyBridgeDistinct(
    const BridgeResultModifier& modifier,
    QleverResultWithStatus result) {
  if (result.status != XPOD_RDF_STATUS_OK) {
    return result;
  }

  const auto& input = qleverResultTable(result.result);
  for (ColumnIndex column : modifier.columns) {
    if (column >= input.numColumns()) {
      return makeEmptyOperationResult(
          XPOD_RDF_STATUS_UNSUPPORTED, input.numColumns(),
          result.result.sortedBy());
    }
  }

  IdTable output = makeQleverIdTable(input.numColumns());
  std::set<std::vector<uint64_t>> seen;
  std::vector<uint64_t> key;
  std::vector<Id> row;
  key.reserve(modifier.columns.size());
  row.reserve(input.numColumns());
  for (size_t input_row = 0; input_row < input.numRows(); ++input_row) {
    key.clear();
    for (ColumnIndex column : modifier.columns) {
      key.push_back(input(input_row, column).getBits());
    }
    if (!seen.insert(key).second) {
      continue;
    }
    row.clear();
    for (size_t column = 0; column < input.numColumns(); ++column) {
      row.push_back(input(input_row, column));
    }
    output.push_back(row);
  }

  return toQleverResult(
      {XPOD_RDF_STATUS_OK, std::move(output)}, result.result.sortedBy());
}

inline std::string_view bridgeBytesView(xpod_rdf_bytes bytes) noexcept {
  if (bytes.data == nullptr) {
    return {};
  }
  return {bytes.data, bytes.size};
}

#if XPOD_QLEVER_OPERATION_HAS_VALUE_ID_DATATYPE
struct BridgeNumericLiteral {
  std::string value;
  std::string datatype;
};

template <typename IdT, typename = void>
struct BridgeHasQleverIntValue : std::false_type {};

template <typename IdT>
struct BridgeHasQleverIntValue<
    IdT,
    std::void_t<decltype(IdT::makeFromInt(std::declval<const IdT&>().getInt()))>>
    : std::true_type {};

template <typename IdT, typename = void>
struct BridgeHasQleverDoubleValue : std::false_type {};

template <typename IdT>
struct BridgeHasQleverDoubleValue<
    IdT,
    std::void_t<decltype(IdT::makeFromDouble(
        std::declval<const IdT&>().getDouble()))>>
    : std::true_type {};

template <typename IdT>
inline std::optional<BridgeNumericLiteral> inlineNumericLiteralFromId(
    const IdT& id) {
  if constexpr (BridgeHasQleverIntValue<IdT>::value) {
    const int64_t value = id.getInt();
    if (IdT::makeFromInt(value).getBits() == id.getBits()) {
      return BridgeNumericLiteral{
          std::to_string(value),
          "http://www.w3.org/2001/XMLSchema#integer"};
    }
  }
  if constexpr (BridgeHasQleverDoubleValue<IdT>::value) {
    const double value = id.getDouble();
    if (IdT::makeFromDouble(value).getBits() == id.getBits()) {
      std::string lexical;
      if (std::isinf(value)) {
        lexical = value < 0 ? "-INF" : "INF";
      } else if (std::isnan(value)) {
        lexical = "NaN";
      } else {
        std::ostringstream out;
        out << std::setprecision(17) << value;
        lexical = out.str();
      }
      return BridgeNumericLiteral{
          std::move(lexical),
          "http://www.w3.org/2001/XMLSchema#double"};
    }
  }
  return std::nullopt;
}

inline std::optional<BridgeNumericLiteral> physicalNumericLiteralFromId(
    const xpod::rdf::PhysicalBackend& backend,
    const Id& id) {
  xpod_rdf_term_key key = 0;
  if (backend.decodeQleverId(id.getBits(), key) != XPOD_RDF_STATUS_OK) {
    return std::nullopt;
  }
  xpod_rdf_term term = {};
  xpod_rdf_snapshot snapshot = {};
  if (backend.resolveTerm(key, snapshot, term) != XPOD_RDF_STATUS_OK ||
      term.kind != XPOD_RDF_TERM_LITERAL) {
    return std::nullopt;
  }
  BridgeNumericLiteral literal{
      std::string(bridgeBytesView(term.value)),
      std::string(bridgeBytesView(term.datatype_iri))};
  const numeric_literal::CompareResult probe =
      numeric_literal::compare(
          literal.value, literal.datatype, literal.value, literal.datatype);
  return probe.applicable ? std::optional<BridgeNumericLiteral>{literal}
                          : std::nullopt;
}

inline std::optional<BridgeNumericLiteral> numericLiteralForBridgeId(
    const xpod::rdf::PhysicalBackend& backend,
    const Id& id,
    const std::optional<BridgeNumericLiteral>& inline_literal) {
  if (inline_literal.has_value()) {
    return inline_literal;
  }
  return physicalNumericLiteralFromId(backend, id);
}

inline std::optional<BridgeNumericLiteral> localVocabNumericLiteralFromId(
    const LocalVocab* local_vocab,
    const Id& id) {
  if (local_vocab == nullptr ||
      id.getDatatype() != Datatype::LocalVocabIndex) {
    return std::nullopt;
  }
  const auto& word = local_vocab->getWord(id.getLocalVocabIndex());
  if (!word.isLiteral() || !word.hasDatatype()) {
    return std::nullopt;
  }
  BridgeNumericLiteral literal{
      std::string(word.getLiteralContent()),
      std::string(word.getDatatype())};
  const numeric_literal::CompareResult probe =
      numeric_literal::compare(
          literal.value, literal.datatype, literal.value, literal.datatype);
  return probe.applicable ? std::optional<BridgeNumericLiteral>{literal}
                          : std::nullopt;
}
#endif

inline xpod_rdf_status compareBridgeIds(
    const xpod::rdf::PhysicalBackend& backend,
    const Id& left,
    const Id& right,
    const LocalVocab* local_vocab,
    int32_t& out_compare) {
#if XPOD_QLEVER_OPERATION_HAS_VALUE_ID_DATATYPE
  auto localVocabSortKey = [local_vocab](
      const Id& id) -> std::optional<std::string> {
    if (local_vocab == nullptr ||
        id.getDatatype() != Datatype::LocalVocabIndex) {
      return std::nullopt;
    }
    const auto& word = local_vocab->getWord(id.getLocalVocabIndex());
    if (word.isIri()) {
      return std::string(word.getIriContent());
    }
    if (word.isLiteral()) {
      return std::string(word.getLiteralContent());
    }
    return std::nullopt;
  };
  std::optional<BridgeNumericLiteral> left_numeric_hint =
      inlineNumericLiteralFromId(left);
  if (!left_numeric_hint.has_value()) {
    left_numeric_hint = localVocabNumericLiteralFromId(local_vocab, left);
  }
  std::optional<BridgeNumericLiteral> right_numeric_hint =
      inlineNumericLiteralFromId(right);
  if (!right_numeric_hint.has_value()) {
    right_numeric_hint = localVocabNumericLiteralFromId(local_vocab, right);
  }
  if (left_numeric_hint.has_value() || right_numeric_hint.has_value()) {
    std::optional<BridgeNumericLiteral> left_numeric =
        numericLiteralForBridgeId(backend, left, left_numeric_hint);
    std::optional<BridgeNumericLiteral> right_numeric =
        numericLiteralForBridgeId(backend, right, right_numeric_hint);
    if (left_numeric.has_value() && right_numeric.has_value()) {
      const numeric_literal::CompareResult numeric_compare =
          numeric_literal::compare(
              left_numeric->value, left_numeric->datatype,
              right_numeric->value, right_numeric->datatype);
      if (numeric_compare.applicable) {
        out_compare = numeric_compare.compare;
        return XPOD_RDF_STATUS_OK;
      }
    }
  }
  std::optional<std::string> left_key = localVocabSortKey(left);
  std::optional<std::string> right_key = localVocabSortKey(right);
  if (left_key.has_value() && right_key.has_value()) {
    out_compare =
        *left_key < *right_key ? -1 : (*left_key > *right_key ? 1 : 0);
    return XPOD_RDF_STATUS_OK;
  }
  if (left_key.has_value() != right_key.has_value()) {
    const Id& physical_id = left_key.has_value() ? right : left;
    xpod_rdf_term_key physical_key = 0;
    if (backend.decodeQleverId(physical_id.getBits(), physical_key) ==
        XPOD_RDF_STATUS_OK) {
      xpod_rdf_term physical_term = {};
      xpod_rdf_snapshot snapshot = {};
      if (backend.resolveTerm(physical_key, snapshot, physical_term) ==
          XPOD_RDF_STATUS_OK) {
        const Id& local_id = left_key.has_value() ? left : right;
        const auto& local = local_vocab->getWord(local_id.getLocalVocabIndex());
        auto kindRank = [](xpod_rdf_term_kind kind) {
          if (kind == XPOD_RDF_TERM_BLANK) return 1;
          if (kind == XPOD_RDF_TERM_IRI) return 2;
          if (kind == XPOD_RDF_TERM_LITERAL) return 3;
          return 4;
        };
        const xpod_rdf_term_kind local_kind =
            local.isIri() ? XPOD_RDF_TERM_IRI : XPOD_RDF_TERM_LITERAL;
        const std::string local_value = local.isIri()
            ? std::string(local.getIriContent())
            : std::string(local.getLiteralContent());
        const std::string local_language =
            local.isLiteral() && local.hasLanguageTag()
                ? std::string(local.getLanguageTag())
                : std::string{};
        const std::string local_datatype =
            local.isLiteral() && local.hasDatatype()
                ? std::string(local.getDatatype())
                : std::string{};
        const std::string_view physical_value(
            physical_term.value.data, physical_term.value.size);
        const std::string_view physical_language(
            physical_term.language.data == nullptr ? ""
                                                   : physical_term.language.data,
            physical_term.language.size);
        const std::string_view physical_datatype(
            physical_term.datatype_iri.data == nullptr
                ? ""
                : physical_term.datatype_iri.data,
            physical_term.datatype_iri.size);
        auto compareStrings = [](std::string_view a, std::string_view b) {
          return a < b ? -1 : (a > b ? 1 : 0);
        };
        int compare = kindRank(local_kind) - kindRank(physical_term.kind);
        if (compare == 0) compare = compareStrings(local_value, physical_value);
        if (compare == 0) {
          compare = compareStrings(local_language, physical_language);
        }
        if (compare == 0) {
          compare = compareStrings(local_datatype, physical_datatype);
        }
        out_compare = left_key.has_value() ? compare : -compare;
        return XPOD_RDF_STATUS_OK;
      }
    }
    out_compare = left < right ? -1 : (right < left ? 1 : 0);
    return XPOD_RDF_STATUS_OK;
  }
#else
  (void)local_vocab;
#endif
  return backend.compareQleverIds(
      left.getBits(), right.getBits(), out_compare);
}

inline const xpod_rdf_snapshot* bridgePlanSnapshot(
    const BridgePhysicalPlan* plan) noexcept {
  if (plan == nullptr) {
    return nullptr;
  }
  for (const BridgePhysicalScan& scan : plan->scans) {
    if (scan.scan.snapshot != nullptr) {
      return scan.scan.snapshot;
    }
  }
  return nullptr;
}

inline bool bridgeStringPredicateMatches(
    BridgeStringFilterKind kind,
    std::string_view value,
    std::string_view expected) noexcept {
  switch (kind) {
    case BridgeStringFilterKind::Prefix:
      return value.size() >= expected.size() &&
             value.substr(0, expected.size()) == expected;
    case BridgeStringFilterKind::Contains:
      return value.find(expected) != std::string_view::npos;
    case BridgeStringFilterKind::Suffix:
      return value.size() >= expected.size() &&
             value.substr(value.size() - expected.size()) == expected;
    case BridgeStringFilterKind::Equals:
      return value == expected;
  }
  return false;
}

inline void bridgeApplyStringTransform(
    BridgeStringValueTransform transform,
    std::string& value) {
  switch (transform) {
    case BridgeStringValueTransform::None:
      return;
    case BridgeStringValueTransform::Lowercase:
      std::transform(
          value.begin(), value.end(), value.begin(),
          [](unsigned char c) { return static_cast<char>(std::tolower(c)); });
      return;
    case BridgeStringValueTransform::Uppercase:
      std::transform(
          value.begin(), value.end(), value.begin(),
          [](unsigned char c) { return static_cast<char>(std::toupper(c)); });
      return;
  }
}

inline bool bridgeIsUndefinedId(const Id& id) {
  return id.getBits() == bridgeUndefinedId().getBits();
}

inline xpod_rdf_status bridgeStringValueFromId(
    const xpod::rdf::PhysicalBackend& backend,
    const Id& id,
    const LocalVocab* local_vocab,
    const BridgePhysicalPlan* plan,
    std::string& out_value,
    bool& out_has_value) {
  out_has_value = false;
  out_value.clear();
  if (bridgeIsUndefinedId(id)) {
    return XPOD_RDF_STATUS_OK;
  }
#if XPOD_QLEVER_OPERATION_HAS_VALUE_ID_DATATYPE
  if (local_vocab != nullptr &&
      id.getDatatype() == Datatype::LocalVocabIndex) {
    const auto& word = local_vocab->getWord(id.getLocalVocabIndex());
    if (word.isIri()) {
      out_value = std::string(word.getIriContent());
      out_has_value = true;
      return XPOD_RDF_STATUS_OK;
    }
    if (word.isLiteral()) {
      out_value = std::string(word.getLiteralContent());
      out_has_value = true;
      return XPOD_RDF_STATUS_OK;
    }
    return XPOD_RDF_STATUS_OK;
  }
#else
  (void)local_vocab;
#endif

  xpod_rdf_term_key key = 0;
  xpod_rdf_status status = backend.decodeQleverId(id.getBits(), key);
  if (status != XPOD_RDF_STATUS_OK) {
    return status;
  }

  xpod_rdf_snapshot empty_snapshot = {};
  const xpod_rdf_snapshot* snapshot = bridgePlanSnapshot(plan);
  if (snapshot == nullptr) {
    snapshot = &empty_snapshot;
  }

  xpod_rdf_term term = {};
  xpod_rdf_status term_status = XPOD_RDF_STATUS_OK;
  status = backend.resolveTerms(&key, 1, *snapshot, &term, &term_status);
  if (status != XPOD_RDF_STATUS_OK) {
    return status;
  }
  if (term_status == XPOD_RDF_STATUS_NOT_FOUND) {
    return XPOD_RDF_STATUS_OK;
  }
  if (term_status != XPOD_RDF_STATUS_OK) {
    return term_status;
  }
  out_value = std::string(bridgeBytesView(term.value));
  out_has_value = true;
  return XPOD_RDF_STATUS_OK;
}

inline xpod_rdf_status bridgeTermMetadataFromId(
    const xpod::rdf::PhysicalBackend& backend,
    const Id& id,
    const BridgePhysicalPlan* plan,
    std::string& out_language,
    std::string& out_datatype,
    bool& out_is_literal) {
  out_language.clear();
  out_datatype.clear();
  out_is_literal = false;
  if (bridgeIsUndefinedId(id)) {
    return XPOD_RDF_STATUS_OK;
  }
#if XPOD_QLEVER_OPERATION_HAS_VALUE_ID_DATATYPE
  if (std::optional<BridgeNumericLiteral> inline_literal =
          inlineNumericLiteralFromId(id);
      inline_literal.has_value()) {
    out_datatype = std::move(inline_literal->datatype);
    out_is_literal = true;
    return XPOD_RDF_STATUS_OK;
  }
#endif
  xpod_rdf_term_key key = 0;
  xpod_rdf_status status = backend.decodeQleverId(id.getBits(), key);
  if (status != XPOD_RDF_STATUS_OK) {
    return status;
  }
  xpod_rdf_snapshot empty_snapshot = {};
  const xpod_rdf_snapshot* snapshot = bridgePlanSnapshot(plan);
  if (snapshot == nullptr) {
    snapshot = &empty_snapshot;
  }
  xpod_rdf_term term = {};
  xpod_rdf_status term_status = XPOD_RDF_STATUS_OK;
  status = backend.resolveTerms(&key, 1, *snapshot, &term, &term_status);
  if (status != XPOD_RDF_STATUS_OK) {
    return status;
  }
  if (term_status == XPOD_RDF_STATUS_NOT_FOUND) {
    return XPOD_RDF_STATUS_OK;
  }
  if (term_status != XPOD_RDF_STATUS_OK) {
    return term_status;
  }
  if (term.kind != XPOD_RDF_TERM_LITERAL) {
    return XPOD_RDF_STATUS_OK;
  }
  out_is_literal = true;
  out_language = std::string(bridgeBytesView(term.language));
  if (!out_language.empty()) {
    out_datatype =
        "http://www.w3.org/1999/02/22-rdf-syntax-ns#langString";
  } else if (term.datatype_iri.size != 0) {
    out_datatype = std::string(bridgeBytesView(term.datatype_iri));
  } else {
    out_datatype = "http://www.w3.org/2001/XMLSchema#string";
  }
  return XPOD_RDF_STATUS_OK;
}

inline QleverResultWithStatus applyBridgeOrderBy(
    const xpod::rdf::PhysicalBackend& backend,
    const BridgeResultModifier& modifier,
    QleverResultWithStatus result,
    const LocalVocab* local_vocab) {
  if (result.status != XPOD_RDF_STATUS_OK) {
    return result;
  }
  if (modifier.columns.size() != modifier.descending.size()) {
    return makeEmptyOperationResult(XPOD_RDF_STATUS_UNSUPPORTED);
  }

  const auto& input = qleverResultTable(result.result);
  for (ColumnIndex column : modifier.columns) {
    if (column >= input.numColumns()) {
      return makeEmptyOperationResult(
          XPOD_RDF_STATUS_UNSUPPORTED, input.numColumns(), {});
    }
  }
  std::vector<size_t> row_order;
  row_order.reserve(input.numRows());
  for (size_t row = 0; row < input.numRows(); ++row) {
    row_order.push_back(row);
  }
  xpod_rdf_status sort_status = XPOD_RDF_STATUS_OK;
  std::stable_sort(
      row_order.begin(), row_order.end(),
      [&backend, &input, &modifier, &sort_status, local_vocab](
          size_t left, size_t right) {
        if (sort_status != XPOD_RDF_STATUS_OK) {
          return false;
        }
        for (size_t index = 0; index < modifier.columns.size(); ++index) {
          ColumnIndex column = modifier.columns[index];
          int32_t compare = 0;
          sort_status = compareBridgeIds(
              backend, input(left, column), input(right, column),
              local_vocab, compare);
          if (sort_status != XPOD_RDF_STATUS_OK) {
            return false;
          }
          if (compare == 0) {
            continue;
          }
          return modifier.descending[index] ? compare > 0 : compare < 0;
        }
        return false;
      });
  if (sort_status != XPOD_RDF_STATUS_OK) {
    return makeEmptyOperationResult(sort_status, input.numColumns(), {});
  }

  IdTable output = makeQleverIdTable(input.numColumns());
  std::vector<Id> row;
  row.reserve(input.numColumns());
  for (size_t input_row : row_order) {
    row.clear();
    for (size_t column = 0; column < input.numColumns(); ++column) {
      row.push_back(input(input_row, column));
    }
    output.push_back(row);
  }

  return toQleverResult({XPOD_RDF_STATUS_OK, std::move(output)}, {});
}

template <typename Table>
inline xpod_rdf_status preloadBridgeOrderTerms(
    const xpod::rdf::PhysicalBackend& backend,
    const Table& input,
    const std::vector<ColumnIndex>& columns) {
  std::unordered_set<xpod_rdf_term_key> seen;
  std::vector<xpod_rdf_term_key> keys;
  keys.reserve(input.numRows());
  for (size_t row = 0; row < input.numRows(); ++row) {
    for (ColumnIndex column : columns) {
      xpod_rdf_term_key key = 0;
      if (backend.decodeQleverId(input(row, column).getBits(), key) !=
          XPOD_RDF_STATUS_OK) {
        continue;
      }
      if (seen.insert(key).second) {
        keys.push_back(key);
      }
    }
  }

  constexpr size_t batch_size = 4096;
  xpod_rdf_snapshot snapshot = {};
  for (size_t offset = 0; offset < keys.size(); offset += batch_size) {
    const size_t count = std::min(batch_size, keys.size() - offset);
    std::vector<xpod_rdf_term> terms(count);
    std::vector<xpod_rdf_status> statuses(count);
    const xpod_rdf_status status = backend.resolveTerms(
        keys.data() + offset, count, snapshot, terms.data(), statuses.data());
    if (status == XPOD_RDF_STATUS_UNSUPPORTED) {
      return XPOD_RDF_STATUS_OK;
    }
    if (status != XPOD_RDF_STATUS_OK) {
      return status;
    }
    for (xpod_rdf_status term_status : statuses) {
      if (term_status != XPOD_RDF_STATUS_OK &&
          term_status != XPOD_RDF_STATUS_NOT_FOUND &&
          term_status != XPOD_RDF_STATUS_UNSUPPORTED) {
        return term_status;
      }
    }
  }
  return XPOD_RDF_STATUS_OK;
}

inline QleverResultWithStatus applyBridgeOrderByLimitOffset(
    const xpod::rdf::PhysicalBackend& backend,
    const BridgeResultModifier& order_by,
    const BridgeResultModifier& page,
    QleverResultWithStatus result,
    const LocalVocab* local_vocab) {
  if (result.status != XPOD_RDF_STATUS_OK) {
    return result;
  }
  if (order_by.columns.size() != order_by.descending.size()) {
    return makeEmptyOperationResult(XPOD_RDF_STATUS_UNSUPPORTED);
  }

  const auto& input = qleverResultTable(result.result);
  for (ColumnIndex column : order_by.columns) {
    if (column >= input.numColumns()) {
      return makeEmptyOperationResult(
          XPOD_RDF_STATUS_UNSUPPORTED, input.numColumns(), {});
    }
  }
  const xpod_rdf_status preload_status =
      preloadBridgeOrderTerms(backend, input, order_by.columns);
  if (preload_status != XPOD_RDF_STATUS_OK) {
    return makeEmptyOperationResult(preload_status, input.numColumns(), {});
  }

  const size_t row_count = input.numRows();
  const size_t start = std::min(page.offset, row_count);
  size_t end = row_count;
  if (page.limit <= row_count - start) {
    end = start + page.limit;
  }

  std::vector<size_t> row_order(row_count);
  for (size_t row = 0; row < row_count; ++row) {
    row_order[row] = row;
  }
  xpod_rdf_status sort_status = XPOD_RDF_STATUS_OK;
  auto less = [&backend, &input, &order_by, &sort_status, local_vocab](
                  size_t left, size_t right) {
    if (sort_status != XPOD_RDF_STATUS_OK) {
      return false;
    }
    for (size_t index = 0; index < order_by.columns.size(); ++index) {
      int32_t compare = 0;
      sort_status = compareBridgeIds(
          backend, input(left, order_by.columns[index]),
          input(right, order_by.columns[index]), local_vocab, compare);
      if (sort_status != XPOD_RDF_STATUS_OK) {
        return false;
      }
      if (compare != 0) {
        return order_by.descending[index] ? compare > 0 : compare < 0;
      }
    }
    return false;
  };
  if (end < row_count) {
    std::partial_sort(row_order.begin(), row_order.begin() + end,
                      row_order.end(), less);
  } else {
    std::stable_sort(row_order.begin(), row_order.end(), less);
  }
  if (sort_status != XPOD_RDF_STATUS_OK) {
    return makeEmptyOperationResult(sort_status, input.numColumns(), {});
  }

  IdTable output = makeQleverIdTable(input.numColumns());
  std::vector<Id> row;
  row.reserve(input.numColumns());
  for (size_t input_row = start; input_row < end; ++input_row) {
    row.clear();
    for (size_t column = 0; column < input.numColumns(); ++column) {
      row.push_back(input(row_order[input_row], column));
    }
    output.push_back(row);
  }
  return toQleverResult({XPOD_RDF_STATUS_OK, std::move(output)}, {});
}

inline QleverResultWithStatus applyBridgeInternalSort(
    const xpod::rdf::PhysicalBackend& backend,
    const BridgeResultModifier& modifier,
    QleverResultWithStatus result,
    const LocalVocab* local_vocab) {
  if (result.status != XPOD_RDF_STATUS_OK) {
    return result;
  }

  const auto& input = qleverResultTable(result.result);
  for (ColumnIndex column : modifier.columns) {
    if (column >= input.numColumns()) {
      return makeEmptyOperationResult(
          XPOD_RDF_STATUS_UNSUPPORTED, input.numColumns(),
          result.result.sortedBy());
    }
  }

  std::vector<size_t> row_order;
  row_order.reserve(input.numRows());
  for (size_t row = 0; row < input.numRows(); ++row) {
    row_order.push_back(row);
  }
  xpod_rdf_status sort_status = XPOD_RDF_STATUS_OK;
  std::stable_sort(
      row_order.begin(), row_order.end(),
      [&backend, &input, &modifier, &sort_status, local_vocab](
          size_t left, size_t right) {
        if (sort_status != XPOD_RDF_STATUS_OK) {
          return false;
        }
        for (ColumnIndex column : modifier.columns) {
          int32_t compare = 0;
          sort_status = compareBridgeIds(
              backend, input(left, column), input(right, column),
              local_vocab, compare);
          if (sort_status != XPOD_RDF_STATUS_OK) {
            return false;
          }
          if (compare == 0) {
            continue;
          }
          return compare < 0;
        }
        return false;
      });
  if (sort_status != XPOD_RDF_STATUS_OK) {
    return makeEmptyOperationResult(
        sort_status, input.numColumns(), result.result.sortedBy());
  }

  IdTable output = makeQleverIdTable(input.numColumns());
  std::vector<Id> row;
  row.reserve(input.numColumns());
  for (size_t input_row : row_order) {
    row.clear();
    for (size_t column = 0; column < input.numColumns(); ++column) {
      row.push_back(input(input_row, column));
    }
    output.push_back(row);
  }

  return toQleverResult(
      {XPOD_RDF_STATUS_OK, std::move(output)}, modifier.columns);
}

inline std::vector<ColumnIndex> projectedSortedColumns(
    const std::vector<ColumnIndex>& input_sorted_by,
    const std::vector<ColumnIndex>& projection_columns) {
  std::vector<ColumnIndex> sorted_by;
  for (ColumnIndex sorted_column : input_sorted_by) {
    for (size_t projected_column = 0;
         projected_column < projection_columns.size();
         ++projected_column) {
      if (projection_columns[projected_column] == sorted_column) {
        sorted_by.push_back(static_cast<ColumnIndex>(projected_column));
        break;
      }
    }
  }
  return sorted_by;
}

inline LocalVocab cloneBridgeLocalVocab(const LocalVocab* local_vocab) {
  return local_vocab == nullptr ? LocalVocab{} : local_vocab->clone();
}

inline QleverResultWithStatus applyBridgeProject(
    const BridgeResultModifier& modifier,
    QleverResultWithStatus result,
    const LocalVocab* local_vocab = nullptr) {
  if (result.status != XPOD_RDF_STATUS_OK) {
    return result;
  }
  const auto& input = qleverResultTable(result.result);
  for (ColumnIndex column : modifier.columns) {
    if (column >= input.numColumns()) {
      return makeEmptyOperationResult(
          XPOD_RDF_STATUS_UNSUPPORTED, modifier.columns.size());
    }
  }

  IdTable output = makeQleverIdTable(modifier.columns.size());
  std::vector<Id> row;
  row.reserve(modifier.columns.size());
  for (size_t input_row = 0; input_row < input.numRows(); ++input_row) {
    row.clear();
    for (ColumnIndex column : modifier.columns) {
      row.push_back(input(input_row, column));
    }
    output.push_back(row);
  }
  return toQleverResult(
      {XPOD_RDF_STATUS_OK, std::move(output)},
      projectedSortedColumns(result.result.sortedBy(), modifier.columns),
      cloneBridgeLocalVocab(local_vocab));
}

inline QleverResultWithStatus applyBridgeNotEqualTerm(
    const BridgeResultModifier& modifier,
    QleverResultWithStatus result) {
  if (result.status != XPOD_RDF_STATUS_OK) {
    return result;
  }
  if (modifier.columns.size() != 1) {
    return makeEmptyOperationResult(XPOD_RDF_STATUS_UNSUPPORTED);
  }
  const auto& input = qleverResultTable(result.result);
  ColumnIndex column = modifier.columns.front();
  if (column >= input.numColumns()) {
    return makeEmptyOperationResult(
        XPOD_RDF_STATUS_UNSUPPORTED, input.numColumns(),
        result.result.sortedBy());
  }
  if (!modifier.has_term_id_bits) {
    return result;
  }

  IdTable output = makeQleverIdTable(input.numColumns());
  std::vector<Id> row;
  row.reserve(input.numColumns());
  for (size_t input_row = 0; input_row < input.numRows(); ++input_row) {
    if (input(input_row, column).getBits() == modifier.term_id_bits) {
      continue;
    }
    row.clear();
    for (size_t output_column = 0; output_column < input.numColumns();
         ++output_column) {
      row.push_back(input(input_row, output_column));
    }
    output.push_back(row);
  }
  return toQleverResult(
      {XPOD_RDF_STATUS_OK, std::move(output)}, result.result.sortedBy());
}

inline bool bridgeModifierContainsTermId(
    const BridgeResultModifier& modifier,
    uint64_t bits) {
  for (uint64_t candidate : modifier.term_id_bits_list) {
    if (candidate == bits) {
      return true;
    }
  }
  return false;
}

inline QleverResultWithStatus applyBridgeNotInTerm(
    const BridgeResultModifier& modifier,
    QleverResultWithStatus result) {
  if (result.status != XPOD_RDF_STATUS_OK) {
    return result;
  }
  if (modifier.columns.size() != 1) {
    return makeEmptyOperationResult(XPOD_RDF_STATUS_UNSUPPORTED);
  }
  const auto& input = qleverResultTable(result.result);
  ColumnIndex column = modifier.columns.front();
  if (column >= input.numColumns()) {
    return makeEmptyOperationResult(
        XPOD_RDF_STATUS_UNSUPPORTED, input.numColumns(),
        result.result.sortedBy());
  }

  IdTable output = makeQleverIdTable(input.numColumns());
  std::vector<Id> row;
  row.reserve(input.numColumns());
  for (size_t input_row = 0; input_row < input.numRows(); ++input_row) {
    if (bridgeModifierContainsTermId(
            modifier, input(input_row, column).getBits())) {
      continue;
    }
    row.clear();
    for (size_t output_column = 0; output_column < input.numColumns();
         ++output_column) {
      row.push_back(input(input_row, output_column));
    }
    output.push_back(row);
  }
  return toQleverResult(
      {XPOD_RDF_STATUS_OK, std::move(output)}, result.result.sortedBy());
}

inline QleverResultWithStatus applyBridgeInTerm(
    const BridgeResultModifier& modifier,
    QleverResultWithStatus result) {
  if (result.status != XPOD_RDF_STATUS_OK) {
    return result;
  }
  if (modifier.columns.size() != 1) {
    return makeEmptyOperationResult(XPOD_RDF_STATUS_UNSUPPORTED);
  }
  const auto& input = qleverResultTable(result.result);
  ColumnIndex column = modifier.columns.front();
  if (column >= input.numColumns()) {
    return makeEmptyOperationResult(
        XPOD_RDF_STATUS_UNSUPPORTED, input.numColumns(),
        result.result.sortedBy());
  }

  IdTable output = makeQleverIdTable(input.numColumns());
  if (modifier.term_id_bits_list.empty()) {
    return toQleverResult(
        {XPOD_RDF_STATUS_OK, std::move(output)}, result.result.sortedBy());
  }

  std::vector<Id> row;
  row.reserve(input.numColumns());
  for (size_t input_row = 0; input_row < input.numRows(); ++input_row) {
    if (!bridgeModifierContainsTermId(
            modifier, input(input_row, column).getBits())) {
      continue;
    }
    row.clear();
    for (size_t output_column = 0; output_column < input.numColumns();
         ++output_column) {
      row.push_back(input(input_row, output_column));
    }
    output.push_back(row);
  }
  return toQleverResult(
      {XPOD_RDF_STATUS_OK, std::move(output)}, result.result.sortedBy());
}

inline QleverResultWithStatus applyBridgeEqualTerm(
    const BridgeResultModifier& modifier,
    QleverResultWithStatus result) {
  if (result.status != XPOD_RDF_STATUS_OK) {
    return result;
  }
  if (modifier.columns.size() != 1) {
    return makeEmptyOperationResult(XPOD_RDF_STATUS_UNSUPPORTED);
  }
  const auto& input = qleverResultTable(result.result);
  ColumnIndex column = modifier.columns.front();
  if (column >= input.numColumns()) {
    return makeEmptyOperationResult(
        XPOD_RDF_STATUS_UNSUPPORTED, input.numColumns(),
        result.result.sortedBy());
  }

  IdTable output = makeQleverIdTable(input.numColumns());
  if (!modifier.has_term_id_bits) {
    return toQleverResult(
        {XPOD_RDF_STATUS_OK, std::move(output)}, result.result.sortedBy());
  }

  std::vector<Id> row;
  row.reserve(input.numColumns());
  for (size_t input_row = 0; input_row < input.numRows(); ++input_row) {
    if (input(input_row, column).getBits() != modifier.term_id_bits) {
      continue;
    }
    row.clear();
    for (size_t output_column = 0; output_column < input.numColumns();
         ++output_column) {
      row.push_back(input(input_row, output_column));
    }
    output.push_back(row);
  }
  return toQleverResult(
      {XPOD_RDF_STATUS_OK, std::move(output)}, result.result.sortedBy());
}

inline bool bridgeComparisonMatches(
    BridgeResultModifierKind kind,
    int32_t compare) noexcept {
  switch (kind) {
    case BridgeResultModifierKind::GreaterThanTerm:
      return compare > 0;
    case BridgeResultModifierKind::GreaterThanOrEqualTerm:
      return compare >= 0;
    case BridgeResultModifierKind::LessThanTerm:
      return compare < 0;
    case BridgeResultModifierKind::LessThanOrEqualTerm:
      return compare <= 0;
    default:
      return false;
  }
}

inline QleverResultWithStatus applyBridgeComparisonTerm(
    const xpod::rdf::PhysicalBackend& backend,
    const BridgeResultModifier& modifier,
    QleverResultWithStatus result,
    const LocalVocab* local_vocab) {
  if (result.status != XPOD_RDF_STATUS_OK) {
    return result;
  }
  if (modifier.columns.size() != 1) {
    return makeEmptyOperationResult(XPOD_RDF_STATUS_UNSUPPORTED);
  }
  const auto& input = qleverResultTable(result.result);
  ColumnIndex column = modifier.columns.front();
  if (column >= input.numColumns()) {
    return makeEmptyOperationResult(
        XPOD_RDF_STATUS_UNSUPPORTED, input.numColumns(),
        result.result.sortedBy());
  }
  if (!modifier.has_term_id_bits) {
    return makeEmptyOperationResult(
        XPOD_RDF_STATUS_UNSUPPORTED, input.numColumns(),
        result.result.sortedBy());
  }

  IdTable output = makeQleverIdTable(input.numColumns());
  Id term = Id::fromBits(modifier.term_id_bits);
  std::vector<Id> row;
  row.reserve(input.numColumns());
  for (size_t input_row = 0; input_row < input.numRows(); ++input_row) {
    int32_t compare = 0;
    xpod_rdf_status compare_status = compareBridgeIds(
        backend, input(input_row, column), term, local_vocab, compare);
    if (compare_status != XPOD_RDF_STATUS_OK) {
      return makeEmptyOperationResult(
          compare_status, input.numColumns(), result.result.sortedBy());
    }
    if (!bridgeComparisonMatches(modifier.kind, compare)) {
      continue;
    }
    row.clear();
    for (size_t output_column = 0; output_column < input.numColumns();
         ++output_column) {
      row.push_back(input(input_row, output_column));
    }
    output.push_back(row);
  }
  return toQleverResult(
      {XPOD_RDF_STATUS_OK, std::move(output)}, result.result.sortedBy());
}

inline QleverResultWithStatus executeBridgeOperationRoot(
    xpod::rdf::PhysicalBackend backend,
    const BridgePhysicalPlan& plan,
    const BridgeOperationPlan& root);

template <typename LeftTableT, typename RightTableT>
inline bool bridgeExistsJoinHasMatch(
    const LeftTableT& left_table,
    size_t left_row,
    const RightTableT& right_table,
    const std::vector<std::array<size_t, 2>>& matched_columns);

template <typename IdTableLike>
inline xpod_rdf_status bridgeModifierMatchesRow(
    const xpod::rdf::PhysicalBackend& backend,
    const BridgeResultModifier& modifier,
    const IdTableLike& input,
    size_t input_row,
    const LocalVocab* local_vocab,
    const BridgePhysicalPlan* plan,
    const BridgeOperationPlan* root,
    std::unordered_map<size_t, QleverResultWithStatus>* exists_cache,
    bool& matches) {
  auto single_column = [&]() -> std::optional<ColumnIndex> {
    if (modifier.columns.size() != 1) {
      return std::nullopt;
    }
    ColumnIndex column = modifier.columns.front();
    if (column >= input.numColumns()) {
      return std::nullopt;
    }
    return column;
  };

  switch (modifier.kind) {
    case BridgeResultModifierKind::EqualTerm: {
      std::optional<ColumnIndex> column = single_column();
      if (!column.has_value()) {
        return XPOD_RDF_STATUS_UNSUPPORTED;
      }
      matches = modifier.has_term_id_bits &&
          input(input_row, *column).getBits() == modifier.term_id_bits;
      return XPOD_RDF_STATUS_OK;
    }
    case BridgeResultModifierKind::NotEqualTerm: {
      std::optional<ColumnIndex> column = single_column();
      if (!column.has_value()) {
        return XPOD_RDF_STATUS_UNSUPPORTED;
      }
      matches = !modifier.has_term_id_bits ||
          input(input_row, *column).getBits() != modifier.term_id_bits;
      return XPOD_RDF_STATUS_OK;
    }
    case BridgeResultModifierKind::InTerm: {
      std::optional<ColumnIndex> column = single_column();
      if (!column.has_value()) {
        return XPOD_RDF_STATUS_UNSUPPORTED;
      }
      matches = bridgeModifierContainsTermId(
          modifier, input(input_row, *column).getBits());
      return XPOD_RDF_STATUS_OK;
    }
    case BridgeResultModifierKind::NotInTerm: {
      std::optional<ColumnIndex> column = single_column();
      if (!column.has_value()) {
        return XPOD_RDF_STATUS_UNSUPPORTED;
      }
      matches = !bridgeModifierContainsTermId(
          modifier, input(input_row, *column).getBits());
      return XPOD_RDF_STATUS_OK;
    }
    case BridgeResultModifierKind::GreaterThanTerm:
    case BridgeResultModifierKind::GreaterThanOrEqualTerm:
    case BridgeResultModifierKind::LessThanTerm:
    case BridgeResultModifierKind::LessThanOrEqualTerm: {
      std::optional<ColumnIndex> column = single_column();
      if (!column.has_value() || !modifier.has_term_id_bits) {
        return XPOD_RDF_STATUS_UNSUPPORTED;
      }
      int32_t compare = 0;
      xpod_rdf_status status = compareBridgeIds(
          backend, input(input_row, *column), Id::fromBits(modifier.term_id_bits),
          local_vocab, compare);
      if (status != XPOD_RDF_STATUS_OK) {
        return status;
      }
      matches = bridgeComparisonMatches(modifier.kind, compare);
      return XPOD_RDF_STATUS_OK;
    }
    case BridgeResultModifierKind::AlwaysFalse:
      matches = false;
      return XPOD_RDF_STATUS_OK;
    case BridgeResultModifierKind::StringPredicate: {
      std::optional<ColumnIndex> column = single_column();
      if (!column.has_value()) {
        return XPOD_RDF_STATUS_UNSUPPORTED;
      }
      std::string value;
      bool has_value = false;
      xpod_rdf_status status = bridgeStringValueFromId(
          backend, input(input_row, *column), local_vocab, plan, value,
          has_value);
      if (status != XPOD_RDF_STATUS_OK) {
        return status;
      }
      bridgeApplyStringTransform(modifier.string_transform, value);
      if (!has_value) {
        matches = false;
        return XPOD_RDF_STATUS_OK;
      }
      matches = bridgeStringPredicateMatches(
          modifier.string_filter, value, modifier.string_value);
      if (modifier.string_negated) {
        matches = !matches;
      }
      return XPOD_RDF_STATUS_OK;
    }
    case BridgeResultModifierKind::LanguageEqual:
    case BridgeResultModifierKind::DatatypeEqual: {
      std::optional<ColumnIndex> column = single_column();
      if (!column.has_value()) {
        return XPOD_RDF_STATUS_UNSUPPORTED;
      }
      std::string language;
      std::string datatype;
      bool is_literal = false;
      xpod_rdf_status status = bridgeTermMetadataFromId(
          backend, input(input_row, *column), plan,
          language, datatype, is_literal);
      if (status != XPOD_RDF_STATUS_OK) {
        return status;
      }
      if (!is_literal) {
        matches = false;
        return XPOD_RDF_STATUS_OK;
      }
      if (modifier.kind == BridgeResultModifierKind::LanguageEqual) {
        std::transform(
            language.begin(), language.end(), language.begin(),
            [](unsigned char c) {
              return static_cast<char>(std::tolower(c));
            });
        std::string expected = modifier.string_value;
        std::transform(
            expected.begin(), expected.end(), expected.begin(),
            [](unsigned char c) {
              return static_cast<char>(std::tolower(c));
            });
        matches = language == expected;
      } else {
        matches = datatype == modifier.string_value;
      }
      if (modifier.string_negated) {
        matches = !matches;
      }
      return XPOD_RDF_STATUS_OK;
    }
    case BridgeResultModifierKind::AnyOf: {
      matches = false;
      for (const BridgeResultModifier& child : modifier.child_modifiers) {
        bool child_matches = false;
        xpod_rdf_status status = bridgeModifierMatchesRow(
            backend, child, input, input_row, local_vocab, plan, root,
            exists_cache, child_matches);
        if (status != XPOD_RDF_STATUS_OK) {
          return status;
        }
        if (child_matches) {
          matches = true;
          return XPOD_RDF_STATUS_OK;
        }
      }
      return XPOD_RDF_STATUS_OK;
    }
    case BridgeResultModifierKind::AllOf: {
      matches = true;
      for (const BridgeResultModifier& child : modifier.child_modifiers) {
        bool child_matches = false;
        xpod_rdf_status status = bridgeModifierMatchesRow(
            backend, child, input, input_row, local_vocab, plan, root,
            exists_cache, child_matches);
        if (status != XPOD_RDF_STATUS_OK) {
          return status;
        }
        if (!child_matches) {
          matches = false;
          return XPOD_RDF_STATUS_OK;
        }
      }
      return XPOD_RDF_STATUS_OK;
    }
    case BridgeResultModifierKind::Not: {
      if (modifier.child_modifiers.size() != 1) {
        return XPOD_RDF_STATUS_UNSUPPORTED;
      }
      bool child_matches = false;
      xpod_rdf_status status = bridgeModifierMatchesRow(
          backend, modifier.child_modifiers.front(), input, input_row,
          local_vocab, plan, root, exists_cache, child_matches);
      if (status != XPOD_RDF_STATUS_OK) {
        return status;
      }
      matches = !child_matches;
      return XPOD_RDF_STATUS_OK;
    }
    case BridgeResultModifierKind::Exists: {
      if (plan == nullptr || root == nullptr ||
          modifier.exists_child_index >= root->children.size()) {
        return XPOD_RDF_STATUS_UNSUPPORTED;
      }
      const QleverResultWithStatus* right = nullptr;
      if (exists_cache != nullptr) {
        auto existing = exists_cache->find(modifier.exists_child_index);
        if (existing != exists_cache->end()) {
          right = &existing->second;
        }
      }
      QleverResultWithStatus local_right =
          makeEmptyOperationResult(XPOD_RDF_STATUS_UNSUPPORTED);
      if (right == nullptr) {
        local_right = executeBridgeOperationRoot(
            backend, *plan, root->children[modifier.exists_child_index]);
        if (local_right.status != XPOD_RDF_STATUS_OK) {
          return local_right.status;
        }
        if (exists_cache != nullptr) {
          auto inserted = exists_cache->emplace(
              modifier.exists_child_index, std::move(local_right));
          right = &inserted.first->second;
        } else {
          right = &local_right;
        }
      }
      bool has_match = bridgeExistsJoinHasMatch(
          input, input_row, qleverResultTable(right->result),
          modifier.matched_columns);
      matches = modifier.exists_negated ? !has_match : has_match;
      return XPOD_RDF_STATUS_OK;
    }
    default:
      return XPOD_RDF_STATUS_UNSUPPORTED;
  }
}

inline QleverResultWithStatus applyBridgePredicateModifier(
    const xpod::rdf::PhysicalBackend& backend,
    const BridgeResultModifier& modifier,
    QleverResultWithStatus result,
    const LocalVocab* local_vocab,
    const BridgePhysicalPlan* plan = nullptr,
    const BridgeOperationPlan* root = nullptr) {
  if (result.status != XPOD_RDF_STATUS_OK) {
    return result;
  }
  const auto& input = qleverResultTable(result.result);
  IdTable output = makeQleverIdTable(input.numColumns());
  std::unordered_map<size_t, QleverResultWithStatus> exists_cache;
  std::vector<Id> row;
  row.reserve(input.numColumns());
  for (size_t input_row = 0; input_row < input.numRows(); ++input_row) {
    bool matches = false;
    xpod_rdf_status status = bridgeModifierMatchesRow(
        backend, modifier, input, input_row, local_vocab, plan, root,
        &exists_cache, matches);
    if (status != XPOD_RDF_STATUS_OK) {
      return makeEmptyOperationResult(
          status, input.numColumns(), result.result.sortedBy());
    }
    if (!matches) {
      continue;
    }
    row.clear();
    for (size_t output_column = 0; output_column < input.numColumns();
         ++output_column) {
      row.push_back(input(input_row, output_column));
    }
    output.push_back(row);
  }
  return toQleverResult(
      {XPOD_RDF_STATUS_OK, std::move(output)}, result.result.sortedBy());
}

inline QleverResultWithStatus applyBridgeResultModifier(
    const xpod::rdf::PhysicalBackend& backend,
    const BridgeResultModifier& modifier,
    QleverResultWithStatus result,
    const LocalVocab* local_vocab = nullptr,
    const BridgePhysicalPlan* plan = nullptr,
    const BridgeOperationPlan* root = nullptr) {
  if (modifier.kind == BridgeResultModifierKind::LimitOffset) {
    BridgeOperationPlan limit_root;
    limit_root.has_limit = true;
    limit_root.limit = modifier.limit;
    limit_root.offset = modifier.offset;
    return applyBridgeLimitOffset(limit_root, std::move(result));
  }
  if (modifier.kind == BridgeResultModifierKind::Distinct) {
    return applyBridgeDistinct(modifier, std::move(result));
  }
  if (modifier.kind == BridgeResultModifierKind::OrderBy) {
    return applyBridgeOrderBy(
        backend, modifier, std::move(result), local_vocab);
  }
  if (modifier.kind == BridgeResultModifierKind::InternalSort) {
    return applyBridgeInternalSort(
        backend, modifier, std::move(result), local_vocab);
  }
  if (modifier.kind == BridgeResultModifierKind::Project) {
    return applyBridgeProject(modifier, std::move(result), local_vocab);
  }
  if (modifier.kind == BridgeResultModifierKind::NotEqualTerm) {
    return applyBridgeNotEqualTerm(modifier, std::move(result));
  }
  if (modifier.kind == BridgeResultModifierKind::EqualTerm) {
    return applyBridgeEqualTerm(modifier, std::move(result));
  }
  if (modifier.kind == BridgeResultModifierKind::InTerm) {
    return applyBridgeInTerm(modifier, std::move(result));
  }
  if (modifier.kind == BridgeResultModifierKind::NotInTerm) {
    return applyBridgeNotInTerm(modifier, std::move(result));
  }
  if (modifier.kind == BridgeResultModifierKind::GreaterThanTerm ||
      modifier.kind == BridgeResultModifierKind::GreaterThanOrEqualTerm ||
      modifier.kind == BridgeResultModifierKind::LessThanTerm ||
      modifier.kind == BridgeResultModifierKind::LessThanOrEqualTerm) {
    return applyBridgeComparisonTerm(
        backend, modifier, std::move(result), local_vocab);
  }
  if (modifier.kind == BridgeResultModifierKind::AnyOf ||
      modifier.kind == BridgeResultModifierKind::AllOf ||
      modifier.kind == BridgeResultModifierKind::Not ||
      modifier.kind == BridgeResultModifierKind::Exists ||
      modifier.kind == BridgeResultModifierKind::AlwaysFalse ||
      modifier.kind == BridgeResultModifierKind::StringPredicate ||
      modifier.kind == BridgeResultModifierKind::LanguageEqual ||
      modifier.kind == BridgeResultModifierKind::DatatypeEqual) {
    return applyBridgePredicateModifier(
        backend, modifier, std::move(result), local_vocab, plan, root);
  }
  return result;
}

inline std::optional<xpod_rdf_scan_filter_kind>
physicalScanFilterKindForModifier(
    const BridgeResultModifier& modifier) noexcept {
  switch (modifier.kind) {
    case BridgeResultModifierKind::NotEqualTerm:
      return XPOD_RDF_SCAN_FILTER_TERM_NOT_EQUAL;
    case BridgeResultModifierKind::GreaterThanTerm:
      return XPOD_RDF_SCAN_FILTER_VALUE_GREATER_THAN;
    case BridgeResultModifierKind::GreaterThanOrEqualTerm:
      return XPOD_RDF_SCAN_FILTER_VALUE_GREATER_THAN_OR_EQUAL;
    case BridgeResultModifierKind::LessThanTerm:
      return XPOD_RDF_SCAN_FILTER_VALUE_LESS_THAN;
    case BridgeResultModifierKind::LessThanOrEqualTerm:
      return XPOD_RDF_SCAN_FILTER_VALUE_LESS_THAN_OR_EQUAL;
    case BridgeResultModifierKind::LanguageEqual:
      return XPOD_RDF_SCAN_FILTER_LANGUAGE_EQUAL;
    case BridgeResultModifierKind::DatatypeEqual:
      return XPOD_RDF_SCAN_FILTER_DATATYPE_EQUAL;
    case BridgeResultModifierKind::StringPredicate:
      if (modifier.string_transform != BridgeStringValueTransform::None) {
        return std::nullopt;
      }
      switch (modifier.string_filter) {
        case BridgeStringFilterKind::Prefix:
          return XPOD_RDF_SCAN_FILTER_STRING_PREFIX;
        case BridgeStringFilterKind::Contains:
          return XPOD_RDF_SCAN_FILTER_STRING_CONTAINS;
        case BridgeStringFilterKind::Suffix:
          return XPOD_RDF_SCAN_FILTER_STRING_SUFFIX;
        case BridgeStringFilterKind::Equals:
          return XPOD_RDF_SCAN_FILTER_STRING_EQUAL;
      }
      return std::nullopt;
    default:
      return std::nullopt;
  }
}

inline bool physicalScanSatisfiesModifier(
    const BridgePhysicalPlan* plan,
    const BridgeOperationPlan& root,
    const BridgeResultModifier& modifier) noexcept {
  if (plan == nullptr || root.kind != BridgeOperationKind::PermutationScan ||
      root.scan_indexes.size() != 1 || modifier.columns.size() != 1) {
    return false;
  }
  const size_t scan_index = root.scan_indexes.front();
  if (scan_index >= plan->scans.size()) {
    return false;
  }
  const ScanRequestInput& scan = plan->scans[scan_index].scan;
  const uint32_t slot = slotForColumn(
      scan.permutation, scan.needed_slots, modifier.columns.front());
  const std::optional<xpod_rdf_scan_filter_kind> expected_kind =
      physicalScanFilterKindForModifier(modifier);
  if (slot == 0 || !expected_kind.has_value()) {
    return false;
  }
  return std::any_of(
      scan.filters.begin(), scan.filters.end(),
      [&](const xpod_rdf_scan_filter& filter) {
        if (filter.slot != slot || filter.kind != *expected_kind) {
          return false;
        }
        if (modifier.kind == BridgeResultModifierKind::StringPredicate ||
            modifier.kind == BridgeResultModifierKind::LanguageEqual ||
            modifier.kind == BridgeResultModifierKind::DatatypeEqual) {
          return filter.negated == (modifier.string_negated ? 1 : 0);
        }
        return true;
      });
}

inline QleverResultWithStatus applyBridgeResultModifiers(
    const xpod::rdf::PhysicalBackend& backend,
    const BridgeOperationPlan& root,
    QleverResultWithStatus result,
    const LocalVocab* local_vocab = nullptr,
    const BridgePhysicalPlan* plan = nullptr) {
  if (!root.result_modifiers.empty()) {
    for (size_t index = 0; index < root.result_modifiers.size(); ++index) {
      const BridgeResultModifier& modifier = root.result_modifiers[index];
      if (physicalScanSatisfiesModifier(plan, root, modifier)) {
        continue;
      }
      if (modifier.kind == BridgeResultModifierKind::OrderBy &&
          index + 1 < root.result_modifiers.size() &&
          root.result_modifiers[index + 1].kind ==
              BridgeResultModifierKind::LimitOffset) {
        result = applyBridgeOrderByLimitOffset(
            backend, modifier, root.result_modifiers[index + 1],
            std::move(result), local_vocab);
        ++index;
      } else {
        result = applyBridgeResultModifier(
            backend, modifier, std::move(result), local_vocab, plan, &root);
      }
      if (result.status != XPOD_RDF_STATUS_OK) {
        if (std::getenv("XPOD_QLEVER_RUNTIME_TRACE") != nullptr) {
          std::fprintf(stderr,
                       "xpod bridge result modifier failed: index=%zu kind=%d "
                       "status=%d\n",
                       index, static_cast<int>(modifier.kind),
                       static_cast<int>(result.status));
        }
        return result;
      }
    }
    return result;
  }
  if (root.has_distinct) {
    BridgeResultModifier modifier;
    modifier.kind = BridgeResultModifierKind::Distinct;
    modifier.columns = root.distinct_columns;
    result = applyBridgeDistinct(modifier, std::move(result));
  }
  return applyBridgeLimitOffset(root, std::move(result));
}

inline QleverResultWithStatus executeBridgeOperationRoot(
    xpod::rdf::PhysicalBackend backend,
    const BridgePhysicalPlan& plan,
    const BridgeOperationPlan& root);

inline QleverResultWithStatus executeBridgeValues(
    xpod::rdf::PhysicalBackend backend,
    const BridgeOperationPlan& root) {
  size_t width = root.value_width;
  if (!root.value_id_rows.empty()) {
    width = root.value_id_rows.front().size();
  }
  IdTable output = makeQleverIdTable(width);
  std::vector<Id> row;
  row.reserve(width);

  emitOperationProfileEvent(backend, root, XPOD_RDF_PROFILE_RUNNING);
  for (size_t row_index = 0; row_index < root.value_id_rows.size();
       ++row_index) {
    const auto& ids = root.value_id_rows[row_index];
    if (ids.size() != width) {
      emitOperationProfileEvent(backend, root, XPOD_RDF_PROFILE_FAILED);
      return makeEmptyOperationResult(XPOD_RDF_STATUS_UNSUPPORTED, width);
    }
    row.clear();
    for (size_t column = 0; column < width; ++column) {
      row.push_back(Id::fromBits(ids[column]));
    }
    output.push_back(row);
  }

  emitOperationProfileEvent(
      backend, root, XPOD_RDF_PROFILE_COMPLETED, output.numRows());
  return applyBridgeResultModifiers(
      backend, root, toQleverResult({XPOD_RDF_STATUS_OK, std::move(output)},
                           root.sorted_by));
}

template <typename TableT>
inline xpod_rdf_status appendBridgeUnionRows(
    const TableT& input,
    size_t child_index,
    const std::vector<std::array<size_t, 2>>& column_origins,
    IdTable& output) {
  std::vector<Id> row;
  row.reserve(column_origins.size());
  for (size_t input_row = 0; input_row < input.numRows(); ++input_row) {
    row.clear();
    for (const auto& origin : column_origins) {
      size_t input_column = origin[child_index];
      if (input_column == BRIDGE_NO_COLUMN) {
        row.push_back(bridgeUndefinedId());
        continue;
      }
      if (input_column >= input.numColumns()) {
        return XPOD_RDF_STATUS_UNSUPPORTED;
      }
      row.push_back(input(input_row, input_column));
    }
    output.push_back(row);
  }
  return XPOD_RDF_STATUS_OK;
}

inline QleverResultWithStatus executeBridgeUnion(
    xpod::rdf::PhysicalBackend backend,
    const BridgePhysicalPlan& plan,
    const BridgeOperationPlan& root) {
  if (root.children.size() != 2 || root.column_origins.empty()) {
    return makeEmptyOperationResult(XPOD_RDF_STATUS_UNSUPPORTED);
  }

  emitOperationProfileEvent(backend, root, XPOD_RDF_PROFILE_RUNNING);
  QleverResultWithStatus left =
      executeBridgeOperationRoot(backend, plan, root.children[0]);
  if (left.status != XPOD_RDF_STATUS_OK) {
    emitOperationProfileEvent(backend, root, XPOD_RDF_PROFILE_FAILED);
    return left;
  }
  QleverResultWithStatus right =
      executeBridgeOperationRoot(backend, plan, root.children[1]);
  if (right.status != XPOD_RDF_STATUS_OK) {
    emitOperationProfileEvent(backend, root, XPOD_RDF_PROFILE_FAILED);
    return right;
  }

  IdTable output = makeQleverIdTable(root.column_origins.size());
  xpod_rdf_status status = appendBridgeUnionRows(
      qleverResultTable(left.result), 0, root.column_origins, output);
  if (status == XPOD_RDF_STATUS_OK) {
    status = appendBridgeUnionRows(
        qleverResultTable(right.result), 1, root.column_origins, output);
  }
  if (status != XPOD_RDF_STATUS_OK) {
    emitOperationProfileEvent(backend, root, XPOD_RDF_PROFILE_FAILED);
    return makeEmptyOperationResult(status, root.column_origins.size());
  }
  emitOperationProfileEvent(
      backend, root, XPOD_RDF_PROFILE_COMPLETED, output.numRows());
  return applyBridgeResultModifiers(
      backend, root, toQleverResult({XPOD_RDF_STATUS_OK, std::move(output)},
                           root.sorted_by));
}

inline void appendBridgeCartesianProductRows(
    const std::vector<const QleverResultTable*>& inputs,
    size_t input_index,
    std::vector<Id>& row,
    IdTable& output) {
  if (input_index >= inputs.size()) {
    output.push_back(row);
    return;
  }
  const QleverResultTable& input = *inputs[input_index];
  for (size_t input_row = 0; input_row < input.numRows(); ++input_row) {
    size_t before = row.size();
    for (size_t column = 0; column < input.numColumns(); ++column) {
      row.push_back(input(input_row, column));
    }
    appendBridgeCartesianProductRows(
        inputs, input_index + 1, row, output);
    while (row.size() > before) {
      row.pop_back();
    }
  }
}

inline QleverResultWithStatus executeBridgeCartesianProductJoin(
    xpod::rdf::PhysicalBackend backend,
    const BridgePhysicalPlan& plan,
    const BridgeOperationPlan& root) {
  if (root.children.empty()) {
    return makeEmptyOperationResult(XPOD_RDF_STATUS_UNSUPPORTED);
  }

  emitOperationProfileEvent(backend, root, XPOD_RDF_PROFILE_RUNNING);
  std::vector<QleverResultWithStatus> child_results;
  child_results.reserve(root.children.size());
  size_t output_width = 0;
  for (const BridgeOperationPlan& child : root.children) {
    QleverResultWithStatus child_result =
        executeBridgeOperationRoot(backend, plan, child);
    if (child_result.status != XPOD_RDF_STATUS_OK) {
      emitOperationProfileEvent(backend, root, XPOD_RDF_PROFILE_FAILED);
      return child_result;
    }
    output_width += qleverResultTable(child_result.result).numColumns();
    child_results.push_back(std::move(child_result));
  }

  std::vector<const QleverResultTable*> inputs;
  inputs.reserve(child_results.size());
  for (const QleverResultWithStatus& child_result : child_results) {
    inputs.push_back(&qleverResultTable(child_result.result));
  }

  IdTable output = makeQleverIdTable(output_width);
  std::vector<Id> row;
  row.reserve(output_width);
  appendBridgeCartesianProductRows(inputs, 0, row, output);
  emitOperationProfileEvent(
      backend, root, XPOD_RDF_PROFILE_COMPLETED, output.numRows());
  return applyBridgeResultModifiers(
      backend, root, toQleverResult({XPOD_RDF_STATUS_OK, std::move(output)},
                           root.sorted_by));
}

template <typename LeftTableT, typename RightTableT>
inline bool bridgeMinusRowsMatch(
    const LeftTableT& left,
    size_t left_row,
    const RightTableT& right,
    size_t right_row,
    const std::vector<std::array<size_t, 2>>& matched_columns) {
  for (const auto& columns : matched_columns) {
    if (columns[0] >= left.numColumns() || columns[1] >= right.numColumns()) {
      return false;
    }
    if (left(left_row, columns[0]).getBits() !=
        right(right_row, columns[1]).getBits()) {
      return false;
    }
  }
  return true;
}

template <typename LeftTableT, typename RightTableT>
inline bool bridgeMinusRowHasMatch(
    const LeftTableT& left,
    size_t left_row,
    const RightTableT& right,
    const std::vector<std::array<size_t, 2>>& matched_columns) {
  for (size_t right_row = 0; right_row < right.numRows(); ++right_row) {
    if (bridgeMinusRowsMatch(
            left, left_row, right, right_row, matched_columns)) {
      return true;
    }
  }
  return false;
}

inline QleverResultWithStatus executeBridgeMinus(
    xpod::rdf::PhysicalBackend backend,
    const BridgePhysicalPlan& plan,
    const BridgeOperationPlan& root) {
  if (root.children.size() != 2) {
    return makeEmptyOperationResult(XPOD_RDF_STATUS_UNSUPPORTED);
  }

  emitOperationProfileEvent(backend, root, XPOD_RDF_PROFILE_RUNNING);
  QleverResultWithStatus left =
      executeBridgeOperationRoot(backend, plan, root.children[0]);
  if (left.status != XPOD_RDF_STATUS_OK) {
    emitOperationProfileEvent(backend, root, XPOD_RDF_PROFILE_FAILED);
    return left;
  }
  QleverResultWithStatus right =
      executeBridgeOperationRoot(backend, plan, root.children[1]);
  if (right.status != XPOD_RDF_STATUS_OK) {
    emitOperationProfileEvent(backend, root, XPOD_RDF_PROFILE_FAILED);
    return right;
  }

  const auto& left_table = qleverResultTable(left.result);
  const auto& right_table = qleverResultTable(right.result);
  IdTable output = makeQleverIdTable(left_table.numColumns());
  std::vector<Id> row;
  row.reserve(left_table.numColumns());
  for (size_t left_row = 0; left_row < left_table.numRows(); ++left_row) {
    if (!root.matched_columns.empty() &&
        bridgeMinusRowHasMatch(
            left_table, left_row, right_table, root.matched_columns)) {
      continue;
    }
    row.clear();
    for (size_t column = 0; column < left_table.numColumns(); ++column) {
      row.push_back(left_table(left_row, column));
    }
    output.push_back(row);
  }
  emitOperationProfileEvent(
      backend, root, XPOD_RDF_PROFILE_COMPLETED, output.numRows());
  return applyBridgeResultModifiers(
      backend, root, toQleverResult({XPOD_RDF_STATUS_OK, std::move(output)},
                           root.sorted_by));
}

template <typename LeftTableT, typename RightTableT>
inline xpod_rdf_status appendBridgeOptionalRow(
    const LeftTableT& left,
    size_t left_row,
    const RightTableT* right,
    size_t right_row,
    const std::vector<size_t>& right_projection_columns,
    IdTable& output) {
  std::vector<Id> row;
  row.reserve(left.numColumns() + right_projection_columns.size());
  for (size_t column = 0; column < left.numColumns(); ++column) {
    row.push_back(left(left_row, column));
  }
  if (right == nullptr) {
    for (size_t i = 0; i < right_projection_columns.size(); ++i) {
      row.push_back(bridgeUndefinedId());
    }
  } else {
    for (size_t right_column : right_projection_columns) {
      if (right_column >= right->numColumns()) {
        return XPOD_RDF_STATUS_UNSUPPORTED;
      }
      row.push_back((*right)(right_row, right_column));
    }
  }
  output.push_back(row);
  return XPOD_RDF_STATUS_OK;
}

inline QleverResultWithStatus executeBridgeOptionalJoin(
    xpod::rdf::PhysicalBackend backend,
    const BridgePhysicalPlan& plan,
    const BridgeOperationPlan& root) {
  if (root.children.size() != 2) {
    return makeEmptyOperationResult(XPOD_RDF_STATUS_UNSUPPORTED);
  }

  emitOperationProfileEvent(backend, root, XPOD_RDF_PROFILE_RUNNING);
  QleverResultWithStatus left =
      executeBridgeOperationRoot(backend, plan, root.children[0]);
  if (left.status != XPOD_RDF_STATUS_OK) {
    emitOperationProfileEvent(backend, root, XPOD_RDF_PROFILE_FAILED);
    return left;
  }
  QleverResultWithStatus right =
      executeBridgeOperationRoot(backend, plan, root.children[1]);
  if (right.status != XPOD_RDF_STATUS_OK) {
    emitOperationProfileEvent(backend, root, XPOD_RDF_PROFILE_FAILED);
    return right;
  }

  const auto& left_table = qleverResultTable(left.result);
  const auto& right_table = qleverResultTable(right.result);
  IdTable output = makeQleverIdTable(left_table.numColumns() +
                 root.right_projection_columns.size());
  xpod_rdf_status status = XPOD_RDF_STATUS_OK;

  for (size_t left_row = 0; left_row < left_table.numRows(); ++left_row) {
    bool matched = false;
    for (size_t right_row = 0; right_row < right_table.numRows();
         ++right_row) {
      if (!root.matched_columns.empty() &&
          !bridgeMinusRowsMatch(
              left_table, left_row, right_table, right_row,
              root.matched_columns)) {
        continue;
      }
      matched = true;
      status = appendBridgeOptionalRow(
          left_table, left_row, &right_table, right_row,
          root.right_projection_columns, output);
      if (status != XPOD_RDF_STATUS_OK) {
        emitOperationProfileEvent(backend, root, XPOD_RDF_PROFILE_FAILED);
        return makeEmptyOperationResult(status, output.numColumns());
      }
    }
    if (!matched) {
      status = appendBridgeOptionalRow(
          left_table, left_row,
          static_cast<const std::remove_reference_t<decltype(right_table)>*>(
              nullptr),
          0, root.right_projection_columns,
          output);
      if (status != XPOD_RDF_STATUS_OK) {
        emitOperationProfileEvent(backend, root, XPOD_RDF_PROFILE_FAILED);
        return makeEmptyOperationResult(status, output.numColumns());
      }
    }
  }

  emitOperationProfileEvent(
      backend, root, XPOD_RDF_PROFILE_COMPLETED, output.numRows());
  return applyBridgeResultModifiers(
      backend, root, toQleverResult({XPOD_RDF_STATUS_OK, std::move(output)},
                           root.sorted_by));
}

template <typename LeftTableT, typename RightTableT>
inline xpod_rdf_status appendBridgeMultiColumnJoinRow(
    const LeftTableT& left,
    size_t left_row,
    const RightTableT& right,
    size_t right_row,
    const std::vector<size_t>& right_projection_columns,
    IdTable& output) {
  std::vector<Id> row;
  row.reserve(left.numColumns() + right_projection_columns.size());
  for (size_t column = 0; column < left.numColumns(); ++column) {
    row.push_back(left(left_row, column));
  }
  for (size_t right_column : right_projection_columns) {
    if (right_column >= right.numColumns()) {
      return XPOD_RDF_STATUS_UNSUPPORTED;
    }
    row.push_back(right(right_row, right_column));
  }
  output.push_back(row);
  return XPOD_RDF_STATUS_OK;
}

template <typename TableT>
inline bool bridgeMultiColumnJoinKey(
    const TableT& table,
    size_t row,
    size_t side,
    const std::vector<std::array<size_t, 2>>& matched_columns,
    std::vector<uint64_t>& key) {
  key.clear();
  key.reserve(matched_columns.size());
  for (const auto& columns : matched_columns) {
    size_t column = columns[side];
    if (column >= table.numColumns()) {
      return false;
    }
    key.push_back(table(row, column).getBits());
  }
  return true;
}

inline bool canExecuteParameterizedChildJoin(
    const xpod::rdf::PhysicalBackend& backend,
    const BridgeOperationPlan& root) {
  if (root.children.size() != 2 || root.matched_columns.empty()) {
    return false;
  }
  const BridgeOperationPlan& right_root = root.children[1];
  return right_root.kind == BridgeOperationKind::PermutationScan &&
      right_root.scan_indexes.size() == 1 &&
      right_root.result_modifiers.empty() &&
      !right_root.has_limit &&
      !right_root.has_distinct &&
      right_root.children.empty() &&
      backend.supportsTermTupleFilter();
}

inline QleverResultWithStatus executeBridgeChildHashJoin(
    xpod::rdf::PhysicalBackend backend,
    const BridgePhysicalPlan& plan,
    const BridgeOperationPlan& root) {
  if (!canExecuteParameterizedChildJoin(backend, root)) {
    return makeEmptyOperationResult(XPOD_RDF_STATUS_UNSUPPORTED);
  }
  const BridgeOperationPlan& right_root = root.children[1];
  const size_t right_scan_index = right_root.scan_indexes.front();
  if (right_scan_index >= plan.scans.size()) {
    return makeEmptyOperationResult(XPOD_RDF_STATUS_UNSUPPORTED);
  }

  emitOperationProfileEvent(backend, root, XPOD_RDF_PROFILE_RUNNING);
  QleverResultWithStatus left =
      executeBridgeOperationRoot(backend, plan, root.children[0]);
  if (left.status != XPOD_RDF_STATUS_OK) {
    emitOperationProfileEvent(backend, root, XPOD_RDF_PROFILE_FAILED);
    return left;
  }
  const auto& left_table = qleverResultTable(left.result);
  if (left_table.numRows() == 0) {
    const std::string details = joinDiagnosticsDetailsJson(
        true, 0, 0, 0, {});
    emitCompletedOperationProfileEvent(backend, root, 0, details);
    return toQleverResult(
        {XPOD_RDF_STATUS_OK,
         makeQleverIdTable(
             left_table.numColumns() + root.right_projection_columns.size())},
        root.sorted_by);
  }

  BridgePhysicalScan right_scan = plan.scans[right_scan_index];
  BridgeOwnedTermTupleFilter filter;
  filter.slots.reserve(root.matched_columns.size());
  for (const auto& columns : root.matched_columns) {
    const uint32_t slot = slotForColumn(
        right_scan.scan.permutation, right_scan.scan.needed_slots,
        columns[1]);
    if (slot == 0 || columns[0] >= left_table.numColumns()) {
      emitOperationProfileEvent(backend, root, XPOD_RDF_PROFILE_FAILED);
      return makeEmptyOperationResult(XPOD_RDF_STATUS_UNSUPPORTED);
    }
    filter.slots.push_back(slot);
  }
  if (filter.slots.size() > 4) {
    emitOperationProfileEvent(backend, root, XPOD_RDF_PROFILE_FAILED);
    return makeEmptyOperationResult(XPOD_RDF_STATUS_UNSUPPORTED);
  }

  std::vector<JoinKey> unique_keys;
  unique_keys.reserve(left_table.numRows());
  std::unordered_set<JoinKey, JoinKeyHash> seen_keys;
  JoinKey key;
  key.values.reserve(root.matched_columns.size());
  for (size_t row = 0; row < left_table.numRows(); ++row) {
    key.values.clear();
    for (const auto& columns : root.matched_columns) {
      xpod_rdf_term_key term = 0;
      xpod_rdf_status status = backend.decodeQleverId(
          left_table(row, columns[0]).getBits(), term);
      if (status != XPOD_RDF_STATUS_OK) {
        emitOperationProfileEvent(backend, root, XPOD_RDF_PROFILE_FAILED);
        return makeEmptyOperationResult(status);
      }
      key.values.push_back(term);
    }
    if (seen_keys.insert(key).second) {
      unique_keys.push_back(key);
    }
  }
  for (const JoinKey& unique_key : unique_keys) {
    filter.terms.insert(
        filter.terms.end(), unique_key.values.begin(), unique_key.values.end());
  }
  filter.refreshView();
  right_scan.scan.term_tuple_filter = &filter.view;

  QleverResultWithStatus right =
      executeBridgePhysicalScan(backend, right_scan);
  if (right.status != XPOD_RDF_STATUS_OK) {
    emitOperationProfileEvent(backend, root, XPOD_RDF_PROFILE_FAILED);
    return right;
  }
  const auto& right_table = qleverResultTable(right.result);
  std::map<std::vector<uint64_t>, std::vector<size_t>> right_rows_by_key;
  std::vector<uint64_t> table_key;
  for (size_t right_row = 0; right_row < right_table.numRows(); ++right_row) {
    if (!bridgeMultiColumnJoinKey(
            right_table, right_row, 1, root.matched_columns, table_key)) {
      emitOperationProfileEvent(backend, root, XPOD_RDF_PROFILE_FAILED);
      return makeEmptyOperationResult(XPOD_RDF_STATUS_UNSUPPORTED);
    }
    right_rows_by_key[table_key].push_back(right_row);
  }

  IdTable output = makeQleverIdTable(
      left_table.numColumns() + root.right_projection_columns.size());
  for (size_t left_row = 0; left_row < left_table.numRows(); ++left_row) {
    if (!bridgeMultiColumnJoinKey(
            left_table, left_row, 0, root.matched_columns, table_key)) {
      emitOperationProfileEvent(backend, root, XPOD_RDF_PROFILE_FAILED);
      return makeEmptyOperationResult(XPOD_RDF_STATUS_UNSUPPORTED);
    }
    const auto matches = right_rows_by_key.find(table_key);
    if (matches == right_rows_by_key.end()) {
      continue;
    }
    for (size_t right_row : matches->second) {
      xpod_rdf_status status = appendBridgeMultiColumnJoinRow(
          left_table, left_row, right_table, right_row,
          root.right_projection_columns, output);
      if (status != XPOD_RDF_STATUS_OK) {
        emitOperationProfileEvent(backend, root, XPOD_RDF_PROFILE_FAILED);
        return makeEmptyOperationResult(status, output.numColumns());
      }
    }
  }

  const std::string details = joinDiagnosticsDetailsJson(
      true, static_cast<uint64_t>(left_table.numRows()),
      static_cast<uint64_t>(unique_keys.size()),
      static_cast<uint64_t>(right_table.numRows()), {});
  emitCompletedOperationProfileEvent(
      backend, root, output.numRows(), details);
  return toQleverResult(
      {XPOD_RDF_STATUS_OK, std::move(output)}, root.sorted_by);
}

inline QleverResultWithStatus executeBridgeMultiColumnJoin(
    xpod::rdf::PhysicalBackend backend,
    const BridgePhysicalPlan& plan,
    const BridgeOperationPlan& root) {
  if (canExecuteParameterizedChildJoin(backend, root)) {
    return applyBridgeResultModifiers(
        backend, root,
        executeBridgeChildHashJoin(backend, plan, root), nullptr,
        &plan);
  }
  if (root.children.size() != 2 || root.matched_columns.empty()) {
    return makeEmptyOperationResult(XPOD_RDF_STATUS_UNSUPPORTED);
  }

  emitOperationProfileEvent(backend, root, XPOD_RDF_PROFILE_RUNNING);
  QleverResultWithStatus left =
      executeBridgeOperationRoot(backend, plan, root.children[0]);
  if (left.status != XPOD_RDF_STATUS_OK) {
    emitOperationProfileEvent(backend, root, XPOD_RDF_PROFILE_FAILED);
    return left;
  }
  QleverResultWithStatus right =
      executeBridgeOperationRoot(backend, plan, root.children[1]);
  if (right.status != XPOD_RDF_STATUS_OK) {
    emitOperationProfileEvent(backend, root, XPOD_RDF_PROFILE_FAILED);
    return right;
  }

  const auto& left_table = qleverResultTable(left.result);
  const auto& right_table = qleverResultTable(right.result);
  std::map<std::vector<uint64_t>, std::vector<size_t>> right_rows_by_key;
  std::vector<uint64_t> key;
  for (size_t right_row = 0; right_row < right_table.numRows();
       ++right_row) {
    if (!bridgeMultiColumnJoinKey(
            right_table, right_row, 1, root.matched_columns, key)) {
      emitOperationProfileEvent(backend, root, XPOD_RDF_PROFILE_FAILED);
      return makeEmptyOperationResult(XPOD_RDF_STATUS_UNSUPPORTED);
    }
    right_rows_by_key[key].push_back(right_row);
  }

  IdTable output = makeQleverIdTable(left_table.numColumns() +
                 root.right_projection_columns.size());
  for (size_t left_row = 0; left_row < left_table.numRows(); ++left_row) {
    if (!bridgeMultiColumnJoinKey(
            left_table, left_row, 0, root.matched_columns, key)) {
      emitOperationProfileEvent(backend, root, XPOD_RDF_PROFILE_FAILED);
      return makeEmptyOperationResult(XPOD_RDF_STATUS_UNSUPPORTED);
    }
    auto matching_right_rows = right_rows_by_key.find(key);
    if (matching_right_rows == right_rows_by_key.end()) {
      continue;
    }
    for (size_t right_row : matching_right_rows->second) {
      xpod_rdf_status status = appendBridgeMultiColumnJoinRow(
          left_table, left_row, right_table, right_row,
          root.right_projection_columns, output);
      if (status != XPOD_RDF_STATUS_OK) {
        emitOperationProfileEvent(backend, root, XPOD_RDF_PROFILE_FAILED);
        return makeEmptyOperationResult(status, output.numColumns());
      }
    }
  }

  emitOperationProfileEvent(
      backend, root, XPOD_RDF_PROFILE_COMPLETED, output.numRows());
  return applyBridgeResultModifiers(
      backend, root, toQleverResult({XPOD_RDF_STATUS_OK, std::move(output)},
                           root.sorted_by));
}

template <typename LeftTableT, typename RightTableT>
inline bool bridgeExistsJoinHasMatch(
    const LeftTableT& left_table,
    size_t left_row,
    const RightTableT& right_table,
    const std::vector<std::array<size_t, 2>>& matched_columns) {
  if (matched_columns.empty()) {
    return right_table.numRows() > 0;
  }
  for (size_t right_row = 0; right_row < right_table.numRows(); ++right_row) {
    if (bridgeMinusRowsMatch(
            left_table, left_row, right_table, right_row, matched_columns)) {
      return true;
    }
  }
  return false;
}

inline QleverResultWithStatus executeBridgeExistsJoin(
    xpod::rdf::PhysicalBackend backend,
    const BridgePhysicalPlan& plan,
    const BridgeOperationPlan& root) {
  if (root.children.size() != 2) {
    return makeEmptyOperationResult(XPOD_RDF_STATUS_UNSUPPORTED);
  }

  emitOperationProfileEvent(backend, root, XPOD_RDF_PROFILE_RUNNING);
  QleverResultWithStatus left =
      executeBridgeOperationRoot(backend, plan, root.children[0]);
  if (left.status != XPOD_RDF_STATUS_OK) {
    emitOperationProfileEvent(backend, root, XPOD_RDF_PROFILE_FAILED);
    return left;
  }
  QleverResultWithStatus right =
      executeBridgeOperationRoot(backend, plan, root.children[1]);
  if (right.status != XPOD_RDF_STATUS_OK) {
    emitOperationProfileEvent(backend, root, XPOD_RDF_PROFILE_FAILED);
    return right;
  }

  const auto& left_table = qleverResultTable(left.result);
  const auto& right_table = qleverResultTable(right.result);
  IdTable output = makeQleverIdTable(left_table.numColumns());
  std::vector<Id> row;
  row.reserve(left_table.numColumns());
  for (size_t left_row = 0; left_row < left_table.numRows(); ++left_row) {
    bool has_match = bridgeExistsJoinHasMatch(
        left_table, left_row, right_table, root.matched_columns);
    if (root.exists_join_negated ? has_match : !has_match) {
      continue;
    }
    row.clear();
    for (size_t column = 0; column < left_table.numColumns(); ++column) {
      row.push_back(left_table(left_row, column));
    }
    output.push_back(row);
  }

  emitOperationProfileEvent(
      backend, root, XPOD_RDF_PROFILE_COMPLETED, output.numRows());
  return applyBridgeResultModifiers(
      backend, root, toQleverResult({XPOD_RDF_STATUS_OK, std::move(output)},
                           root.sorted_by));
}

inline QleverResultWithStatus executeBridgeGroupBy(
    xpod::rdf::PhysicalBackend backend,
    const BridgePhysicalPlan& plan,
    const BridgeOperationPlan& root) {
  if (root.children.size() != 1 || root.projection_columns.empty()) {
    return makeEmptyOperationResult(XPOD_RDF_STATUS_UNSUPPORTED);
  }

  emitOperationProfileEvent(backend, root, XPOD_RDF_PROFILE_RUNNING);
  QleverResultWithStatus child =
      executeBridgeOperationRoot(backend, plan, root.children[0]);
  if (child.status != XPOD_RDF_STATUS_OK) {
    emitOperationProfileEvent(backend, root, XPOD_RDF_PROFILE_FAILED);
    return child;
  }

  const auto& input = qleverResultTable(child.result);
  for (ColumnIndex column : root.projection_columns) {
    if (column >= input.numColumns()) {
      emitOperationProfileEvent(backend, root, XPOD_RDF_PROFILE_FAILED);
      return makeEmptyOperationResult(
          XPOD_RDF_STATUS_UNSUPPORTED, root.projection_columns.size());
    }
  }

  IdTable output = makeQleverIdTable(root.projection_columns.size());
  std::set<std::vector<uint64_t>> seen;
  std::vector<uint64_t> key;
  std::vector<Id> row;
  key.reserve(root.projection_columns.size());
  row.reserve(root.projection_columns.size());
  for (size_t input_row = 0; input_row < input.numRows(); ++input_row) {
    key.clear();
    row.clear();
    for (ColumnIndex column : root.projection_columns) {
      const Id& value = input(input_row, column);
      key.push_back(value.getBits());
      row.push_back(value);
    }
    if (seen.insert(key).second) {
      output.push_back(row);
    }
  }

  emitOperationProfileEvent(
      backend, root, XPOD_RDF_PROFILE_COMPLETED, output.numRows());
  return applyBridgeResultModifiers(
      backend, root, toQleverResult({XPOD_RDF_STATUS_OK, std::move(output)},
                           root.sorted_by));
}

inline QleverResultWithStatus executeBridgeOperationRoot(
    xpod::rdf::PhysicalBackend backend,
    const BridgePhysicalPlan& plan,
    const BridgeOperationPlan& root) {
  BridgePhysicalPlan rooted_plan = plan;
  rooted_plan.root = root;
  QleverResultWithStatus result =
      makeEmptyOperationResult(XPOD_RDF_STATUS_UNSUPPORTED);
  if (root.kind == BridgeOperationKind::NeutralElement) {
    IdTable output = makeQleverIdTable(0);
    std::vector<Id> row;
    output.push_back(row);
    return applyBridgeResultModifiers(
        backend, root,
        toQleverResult({XPOD_RDF_STATUS_OK, std::move(output)}, {}),
        nullptr, &plan);
  }
  if (root.native_result_only) {
    return makeEmptyOperationResult(XPOD_RDF_STATUS_UNSUPPORTED);
  }
  if (root.kind == BridgeOperationKind::PermutationScan) {
    if (root.scan_indexes.size() != 1) {
      return makeEmptyOperationResult(XPOD_RDF_STATUS_UNSUPPORTED);
    }
    size_t scan_index = root.scan_indexes.front();
    if (scan_index >= plan.scans.size()) {
      return makeEmptyOperationResult(XPOD_RDF_STATUS_UNSUPPORTED);
    }
    const BridgePhysicalScan& base_scan = plan.scans[scan_index];
    if (canPushSemanticOrderPage(backend, root, base_scan)) {
      BridgePhysicalScan scan = base_scan;
      const BridgeResultModifier& order_by = root.result_modifiers[0];
      const BridgeResultModifier& page = root.result_modifiers[1];
      bool supported_order = true;
      scan.scan.order.count = order_by.columns.size();
      for (size_t index = 0; index < order_by.columns.size(); ++index) {
        const uint32_t order_slot = slotForColumn(
            scan.scan.permutation, scan.scan.needed_slots,
            order_by.columns[index]);
        if (order_slot == 0) {
          supported_order = false;
          break;
        }
        scan.scan.order.slots[index] = order_slot;
        scan.scan.order.kinds[index] = order_by.descending[index]
            ? XPOD_RDF_SCAN_ORDER_DESC
            : XPOD_RDF_SCAN_ORDER_ASC;
      }
      if (supported_order) {
        scan.scan.limit = page.limit;
        scan.scan.offset = page.offset;
        scan.sorted_by = order_by.columns;
        QleverResultWithStatus ordered_page =
            executeBridgePhysicalScan(backend, scan);
        if (ordered_page.status != XPOD_RDF_STATUS_OK ||
            root.result_modifiers.size() == 2) {
          return ordered_page;
        }
        BridgeOperationPlan remaining_modifiers = root;
        remaining_modifiers.result_modifiers.erase(
            remaining_modifiers.result_modifiers.begin(),
            remaining_modifiers.result_modifiers.begin() + 2);
        return applyBridgeResultModifiers(
            backend, remaining_modifiers, std::move(ordered_page), nullptr,
            &plan);
      }
    }
    result = executeBridgePhysicalScan(backend, base_scan);
    return applyBridgeResultModifiers(
        backend, root, std::move(result), nullptr, &plan);
  }
  if (root.kind == BridgeOperationKind::Values) {
    return executeBridgeValues(backend, root);
  }
  if (root.kind == BridgeOperationKind::HashJoin) {
    result = executeBridgeHashJoin(backend, rooted_plan);
    return applyBridgeResultModifiers(
        backend, root, std::move(result), nullptr, &plan);
  }
  if (root.kind == BridgeOperationKind::Union) {
    return executeBridgeUnion(backend, plan, root);
  }
  if (root.kind == BridgeOperationKind::CartesianProductJoin) {
    return executeBridgeCartesianProductJoin(backend, plan, root);
  }
  if (root.kind == BridgeOperationKind::Minus) {
    return executeBridgeMinus(backend, plan, root);
  }
  if (root.kind == BridgeOperationKind::OptionalJoin) {
    return executeBridgeOptionalJoin(backend, plan, root);
  }
  if (root.kind == BridgeOperationKind::MultiColumnJoin) {
    return executeBridgeMultiColumnJoin(backend, plan, root);
  }
  if (root.kind == BridgeOperationKind::ExistsJoin) {
    return executeBridgeExistsJoin(backend, plan, root);
  }
  if (root.kind == BridgeOperationKind::GroupBy) {
    return executeBridgeGroupBy(backend, plan, root);
  }
  return makeEmptyOperationResult(XPOD_RDF_STATUS_UNSUPPORTED);
}

inline QleverResultWithStatus executeBridgeOperationPlan(
    xpod::rdf::PhysicalBackend backend,
    const BridgePhysicalPlan& plan) {
  clearBridgeOperationDetailsJson();
  QleverResultWithStatus result =
      executeBridgeOperationRoot(backend, plan, plan.root);
  if (plan.root.kind != BridgeOperationKind::HashJoin &&
      plan.root.kind != BridgeOperationKind::MultiColumnJoin) {
    clearBridgeOperationDetailsJson();
  }
  return result;
}

inline BridgePhysicalResult executeBridgePhysicalPlan(
    xpod::rdf::PhysicalBackend backend,
    const BridgePhysicalPlan& plan) {
  BridgePhysicalResult result;
  if (isBridgeCandidateRoot(plan.root.kind)) {
    result.kind = BridgePhysicalResultKind::CandidateRows;
    result.candidates = executeBridgeCandidateOperationPlan(backend, plan);
    result.status = result.candidates->status;
    return result;
  }

  result.kind = BridgePhysicalResultKind::RdfRows;
  result.rdf_rows = executeBridgeOperationPlan(backend, plan);
  result.status = result.rdf_rows->status;
  return result;
}

}  // namespace xpod::qlever
#endif

#endif
