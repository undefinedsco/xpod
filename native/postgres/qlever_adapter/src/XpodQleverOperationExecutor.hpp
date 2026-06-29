#ifndef XPOD_QLEVER_OPERATION_EXECUTOR_HPP
#define XPOD_QLEVER_OPERATION_EXECUTOR_HPP

#include "XpodBackedIndexScan.hpp"
#include "XpodBackedTextSearch.hpp"
#include "XpodBackedVectorSearch.hpp"
#include "XpodQleverOperationBridge.hpp"
#include "XpodQleverResultBridge.hpp"
#include "XpodQleverScanMaterializer.hpp"

#include <algorithm>
#include <cstddef>
#include <optional>
#include <set>
#include <string_view>
#include <utility>
#include <unordered_map>
#include <unordered_set>
#include <vector>

#if XPOD_QLEVER_ADAPTER_ENABLE_QLEVER

namespace xpod::qlever {

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
  return 0;
}

inline QleverResultWithStatus makeEmptyOperationResult(
    xpod_rdf_status status,
    size_t width = 0,
    std::vector<ColumnIndex> sorted_by = {}) {
  return toQleverResult({status, IdTable(width)}, std::move(sorted_by));
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
    case BridgeOperationKind::HashJoin:
      return XPOD_RDF_PROFILE_RDF_JOIN;
    case BridgeOperationKind::TextSearch:
      return XPOD_RDF_PROFILE_TEXT_SEARCH;
    case BridgeOperationKind::VectorSearch:
      return XPOD_RDF_PROFILE_VECTOR_SEARCH;
    case BridgeOperationKind::PermutationScan:
    default:
      return XPOD_RDF_PROFILE_PERMUTATION_SCAN;
  }
}

inline void emitOperationProfileEvent(
    xpod::rdf::PhysicalBackend backend,
    const BridgeOperationPlan& root,
    xpod_rdf_profile_status status,
    uint64_t output_rows = 0) noexcept {
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
  backend.emitProfileEvent(event);
}

inline bool candidateRowHasOutputColumn(
    const xpod::rdf::CandidateRow& row,
    BridgeCandidateColumnKind kind) noexcept {
  switch (kind) {
    case BridgeCandidateColumnKind::RetrievalPoint:
      return row.has_retrieval_point;
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
  return adapter.computeResult(false);
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

inline QleverResultWithStatus executeBridgePhysicalScan(
    xpod::rdf::PhysicalBackend backend,
    const BridgePhysicalScan& scan) {
  XpodBackedIndexScan adapter(
      backend, scan.scan, scan.sorted_by, scan.result_width, scan.descriptor,
      scan.profile_node, scan.parent_profile_node);
  return adapter.computeResult(false);
}

inline xpod_rdf_status collectJoinKeys(
    xpod::rdf::PhysicalBackend backend,
    const IdTable& table,
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

inline xpod_rdf_status filterTableByJoinKeys(
    xpod::rdf::PhysicalBackend backend,
    const IdTable& input,
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

inline xpod_rdf_status appendScanProjection(
    const BridgePhysicalScan& scan,
    const IdTable& table,
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

inline xpod_rdf_status decodeJoinKey(
    xpod::rdf::PhysicalBackend backend,
    const BridgePhysicalScan& scan,
    const IdTable& table,
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

inline xpod_rdf_status collectProjectedScanRowsByJoinKey(
    xpod::rdf::PhysicalBackend backend,
    const BridgePhysicalScan& scan,
    const IdTable& table,
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

inline void appendProjectedCombinations(
    const std::vector<const std::vector<ProjectedScanRow>*>& groups,
    size_t group_index,
    std::vector<Id>& row,
    IdTable& output) {
  if (group_index >= groups.size()) {
    output.push_back(row);
    return;
  }
  for (const ProjectedScanRow& projected : *groups[group_index]) {
    size_t before = row.size();
    row.insert(row.end(), projected.begin(), projected.end());
    appendProjectedCombinations(groups, group_index + 1, row, output);
    while (row.size() > before) {
      row.pop_back();
    }
  }
}

inline xpod_rdf_status joinTableWithProjectedScanRows(
    xpod::rdf::PhysicalBackend backend,
    const BridgePhysicalScan& left_scan,
    const IdTable& left_table,
    const std::vector<uint32_t>& left_join_slots,
    const std::vector<uint32_t>& left_project_slots,
    const std::vector<ProjectedRowsByKey>& filter_rows_by_key,
    IdTable& output) {
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
    appendProjectedCombinations(matching_groups, 0, row, output);
  }
  return XPOD_RDF_STATUS_OK;
}

inline xpod_rdf_status appendCandidateProjection(
    const xpod::rdf::PhysicalBackend& backend,
    const xpod::rdf::CandidateRow& candidate,
    const std::vector<BridgeCandidateOutputColumn>& columns,
    std::vector<Id>& row) {
  for (const BridgeCandidateOutputColumn& column : columns) {
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

inline xpod_rdf_status joinTableWithCandidateRows(
    xpod::rdf::PhysicalBackend backend,
    const IdTable& input,
    size_t join_column,
    const std::unordered_map<
        xpod_rdf_term_key,
        std::vector<const xpod::rdf::CandidateRow*>>& rows_by_key,
    const std::vector<BridgeCandidateOutputColumn>& project_columns,
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
          backend, *candidate, project_columns, row);
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
  IdTable output(scan_result.result.idTable().numColumns() + projected_columns);
  status = joinTableWithCandidateRows(
      backend, scan_result.result.idTable(),
      columnForSlot(
          scan.scan.permutation, scan.scan.needed_slots,
          joinSlotForScan(plan.root, 0)),
      candidate_rows_by_key, plan.root.candidate_project_columns, output);
  if (status != XPOD_RDF_STATUS_OK) {
    emitOperationProfileEvent(
        backend, plan.root, XPOD_RDF_PROFILE_FAILED);
    return makeEmptyOperationResult(status, scan.result_width,
                                    scan.sorted_by);
  }
  emitOperationProfileEvent(
      backend, plan.root, XPOD_RDF_PROFILE_COMPLETED, output.numRows());
  return toQleverResult({XPOD_RDF_STATUS_OK, std::move(output)},
                        shiftSortedBy(scan.sorted_by, projected_columns));
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
    const std::vector<uint32_t>& project_slots) {
  std::vector<ColumnIndex> sorted_by;
  for (ColumnIndex sorted_column : scan.sorted_by) {
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
        break;
      }
    }
  }
  return sorted_by;
}

inline QleverResultWithStatus executeBridgeProjectedHashJoin(
    xpod::rdf::PhysicalBackend backend,
    const BridgePhysicalPlan& plan) {
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
        backend, right_scan, right.result.idTable(),
        joinKeySlotsForScan(plan.root, i),
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

  IdTable output(output_width);
  xpod_rdf_status status = joinTableWithProjectedScanRows(
      backend, left_scan, left.result.idTable(),
      joinKeySlotsForScan(plan.root, 0),
      plan.root.scan_project_slots[0], filter_rows_by_key, output);
  if (status != XPOD_RDF_STATUS_OK) {
    emitOperationProfileEvent(
        backend, plan.root, XPOD_RDF_PROFILE_FAILED);
    return makeEmptyOperationResult(status, output_width);
  }
  emitOperationProfileEvent(
      backend, plan.root, XPOD_RDF_PROFILE_COMPLETED, output.numRows());
  return toQleverResult(
      {XPOD_RDF_STATUS_OK, std::move(output)},
      projectedSortedBy(left_scan, plan.root.scan_project_slots[0]));
}

inline QleverResultWithStatus executeBridgeHashJoin(
    xpod::rdf::PhysicalBackend backend,
    const BridgePhysicalPlan& plan) {
  if (plan.root.use_candidate_join) {
    return executeBridgeCandidateHashJoin(backend, plan);
  }
  if (!plan.root.scan_project_slots.empty()) {
    return executeBridgeProjectedHashJoin(backend, plan);
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
        backend, right.result.idTable(),
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

  IdTable output(left.result.idTable().numColumns());
  xpod_rdf_status status = filterTableByJoinKeys(
      backend, left.result.idTable(),
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

  const IdTable& input = result.result.idTable();
  IdTable output(input.numColumns());
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

  const IdTable& input = result.result.idTable();
  for (ColumnIndex column : modifier.columns) {
    if (column >= input.numColumns()) {
      return makeEmptyOperationResult(
          XPOD_RDF_STATUS_UNSUPPORTED, input.numColumns(),
          result.result.sortedBy());
    }
  }

  IdTable output(input.numColumns());
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

inline QleverResultWithStatus applyBridgeOrderBy(
    const BridgeResultModifier& modifier,
    QleverResultWithStatus result) {
  if (result.status != XPOD_RDF_STATUS_OK) {
    return result;
  }
  if (modifier.columns.size() != modifier.descending.size()) {
    return makeEmptyOperationResult(XPOD_RDF_STATUS_UNSUPPORTED);
  }

  const IdTable& input = result.result.idTable();
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
  std::stable_sort(
      row_order.begin(), row_order.end(),
      [&input, &modifier](size_t left, size_t right) {
        for (size_t index = 0; index < modifier.columns.size(); ++index) {
          ColumnIndex column = modifier.columns[index];
          uint64_t left_bits = input(left, column).getBits();
          uint64_t right_bits = input(right, column).getBits();
          if (left_bits == right_bits) {
            continue;
          }
          return modifier.descending[index] ? left_bits > right_bits
                                            : left_bits < right_bits;
        }
        return false;
      });

  IdTable output(input.numColumns());
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

inline QleverResultWithStatus applyBridgeInternalSort(
    const BridgeResultModifier& modifier,
    QleverResultWithStatus result) {
  if (result.status != XPOD_RDF_STATUS_OK) {
    return result;
  }

  const IdTable& input = result.result.idTable();
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
  std::stable_sort(
      row_order.begin(), row_order.end(),
      [&input, &modifier](size_t left, size_t right) {
        for (ColumnIndex column : modifier.columns) {
          uint64_t left_bits = input(left, column).getBits();
          uint64_t right_bits = input(right, column).getBits();
          if (left_bits == right_bits) {
            continue;
          }
          return left_bits < right_bits;
        }
        return false;
      });

  IdTable output(input.numColumns());
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

inline QleverResultWithStatus applyBridgeResultModifier(
    const BridgeResultModifier& modifier,
    QleverResultWithStatus result) {
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
    return applyBridgeOrderBy(modifier, std::move(result));
  }
  if (modifier.kind == BridgeResultModifierKind::InternalSort) {
    return applyBridgeInternalSort(modifier, std::move(result));
  }
  return result;
}

inline QleverResultWithStatus applyBridgeResultModifiers(
    const BridgeOperationPlan& root,
    QleverResultWithStatus result) {
  if (!root.result_modifiers.empty()) {
    for (const BridgeResultModifier& modifier : root.result_modifiers) {
      result = applyBridgeResultModifier(modifier, std::move(result));
      if (result.status != XPOD_RDF_STATUS_OK) {
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

inline xpod_rdf_status appendBridgeUnionRows(
    const IdTable& input,
    size_t child_index,
    const std::vector<std::array<size_t, 2>>& column_origins,
    IdTable& output) {
  std::vector<Id> row;
  row.reserve(column_origins.size());
  for (size_t input_row = 0; input_row < input.numRows(); ++input_row) {
    row.clear();
    for (const auto& origin : column_origins) {
      size_t input_column = origin[child_index];
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

  IdTable output(root.column_origins.size());
  xpod_rdf_status status = appendBridgeUnionRows(
      left.result.idTable(), 0, root.column_origins, output);
  if (status == XPOD_RDF_STATUS_OK) {
    status = appendBridgeUnionRows(
        right.result.idTable(), 1, root.column_origins, output);
  }
  if (status != XPOD_RDF_STATUS_OK) {
    emitOperationProfileEvent(backend, root, XPOD_RDF_PROFILE_FAILED);
    return makeEmptyOperationResult(status, root.column_origins.size());
  }
  emitOperationProfileEvent(
      backend, root, XPOD_RDF_PROFILE_COMPLETED, output.numRows());
  return applyBridgeResultModifiers(
      root, toQleverResult({XPOD_RDF_STATUS_OK, std::move(output)},
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
    IdTable output(0);
    std::vector<Id> row;
    output.push_back(row);
    return applyBridgeResultModifiers(
        root, toQleverResult({XPOD_RDF_STATUS_OK, std::move(output)}, {}));
  }
  if (root.kind == BridgeOperationKind::PermutationScan) {
    if (root.scan_indexes.size() != 1) {
      return makeEmptyOperationResult(XPOD_RDF_STATUS_UNSUPPORTED);
    }
    size_t scan_index = root.scan_indexes.front();
    if (scan_index >= plan.scans.size()) {
      return makeEmptyOperationResult(XPOD_RDF_STATUS_UNSUPPORTED);
    }
    result = executeBridgePhysicalScan(backend, plan.scans[scan_index]);
    return applyBridgeResultModifiers(root, std::move(result));
  }
  if (root.kind == BridgeOperationKind::HashJoin) {
    result = executeBridgeHashJoin(backend, rooted_plan);
    return applyBridgeResultModifiers(root, std::move(result));
  }
  if (root.kind == BridgeOperationKind::Union) {
    return executeBridgeUnion(backend, plan, root);
  }
  return makeEmptyOperationResult(XPOD_RDF_STATUS_UNSUPPORTED);
}

inline QleverResultWithStatus executeBridgeOperationPlan(
    xpod::rdf::PhysicalBackend backend,
    const BridgePhysicalPlan& plan) {
  return executeBridgeOperationRoot(backend, plan, plan.root);
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
