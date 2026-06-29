#ifndef XPOD_QLEVER_OPERATION_EXECUTOR_HPP
#define XPOD_QLEVER_OPERATION_EXECUTOR_HPP

#include "XpodBackedIndexScan.hpp"
#include "XpodQleverOperationBridge.hpp"
#include "XpodQleverResultBridge.hpp"
#include "XpodQleverScanMaterializer.hpp"

#include <cstddef>
#include <utility>
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
    uint32_t slot) noexcept {
  char target = slotToPermutationChar(slot);
  const char* slots = permutationSlots(permutation);
  for (size_t column = 0; column < 3; ++column) {
    if (slots[column] == target) {
      return column;
    }
  }
  return 0;
}

inline QleverResultWithStatus makeEmptyOperationResult(
    xpod_rdf_status status,
    size_t width = 0,
    std::vector<ColumnIndex> sorted_by = {}) {
  return toQleverResult({status, IdTable(width)}, std::move(sorted_by));
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

inline QleverResultWithStatus executeBridgeHashJoin(
    xpod::rdf::PhysicalBackend backend,
    const BridgePhysicalPlan& plan) {
  if (plan.root.scan_indexes.size() < 2) {
    return makeEmptyOperationResult(XPOD_RDF_STATUS_UNSUPPORTED);
  }
  size_t left_index = plan.root.scan_indexes[0];
  if (left_index >= plan.scans.size()) {
    return makeEmptyOperationResult(XPOD_RDF_STATUS_UNSUPPORTED);
  }

  const BridgePhysicalScan& left_scan = plan.scans[left_index];
  std::unordered_set<xpod_rdf_term_key> allowed_keys;
  for (size_t i = 1; i < plan.root.scan_indexes.size(); ++i) {
    size_t right_index = plan.root.scan_indexes[i];
    if (right_index >= plan.scans.size()) {
      return makeEmptyOperationResult(XPOD_RDF_STATUS_UNSUPPORTED);
    }
    const BridgePhysicalScan& right_scan = plan.scans[right_index];
    QleverResultWithStatus right = executeBridgePhysicalScan(backend, right_scan);
    if (right.status != XPOD_RDF_STATUS_OK) {
      return right;
    }
    std::unordered_set<xpod_rdf_term_key> filter_keys;
    xpod_rdf_status status = collectJoinKeys(
        backend, right.result.idTable(),
        columnForSlot(right_scan.scan.permutation, plan.root.join_slot),
        filter_keys);
    if (status != XPOD_RDF_STATUS_OK) {
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
    return left;
  }

  IdTable output(left.result.idTable().numColumns());
  xpod_rdf_status status = filterTableByJoinKeys(
      backend, left.result.idTable(),
      columnForSlot(left_scan.scan.permutation, plan.root.join_slot),
      allowed_keys, output);
  if (status != XPOD_RDF_STATUS_OK) {
    return makeEmptyOperationResult(status, left_scan.result_width,
                                    left_scan.sorted_by);
  }
  return toQleverResult({XPOD_RDF_STATUS_OK, std::move(output)},
                        left_scan.sorted_by);
}

inline QleverResultWithStatus executeBridgeOperationPlan(
    xpod::rdf::PhysicalBackend backend,
    const BridgePhysicalPlan& plan) {
  if (plan.root.kind == BridgeOperationKind::PermutationScan) {
    if (plan.root.scan_indexes.size() != 1) {
      return makeEmptyOperationResult(XPOD_RDF_STATUS_UNSUPPORTED);
    }
    size_t scan_index = plan.root.scan_indexes.front();
    if (scan_index >= plan.scans.size()) {
      return makeEmptyOperationResult(XPOD_RDF_STATUS_UNSUPPORTED);
    }
    return executeBridgePhysicalScan(backend, plan.scans[scan_index]);
  }
  if (plan.root.kind == BridgeOperationKind::HashJoin) {
    return executeBridgeHashJoin(backend, plan);
  }
  return makeEmptyOperationResult(XPOD_RDF_STATUS_UNSUPPORTED);
}

}  // namespace xpod::qlever
#endif

#endif
