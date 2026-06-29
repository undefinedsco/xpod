#ifndef XPOD_QLEVER_OPERATION_PLAN_BRIDGE_HPP
#define XPOD_QLEVER_OPERATION_PLAN_BRIDGE_HPP

#include "XpodQleverPlanBridge.hpp"

#include <optional>
#include <string_view>

#if XPOD_QLEVER_ADAPTER_ENABLE_QLEVER
#include "engine/IndexScan.h"
#include "engine/Join.h"
#include "engine/Operation.h"
#include "engine/QueryExecutionTree.h"
#include "engine/QueryPlanner.h"

namespace xpod::qlever {

inline bool bindIndexScanComponent(
    const TripleComponent& component,
    uint32_t slot,
    BridgeQueryPlan& plan) {
  if (component.isVariable()) {
    return true;
  }
  return bindableComponent(component, std::string_view{}, slot, plan);
}

inline void initializeIndexScanOperationPlan(
    BridgeQueryPlan& plan,
    const IndexScan& scan) {
  plan.scan.permutation = scan.permutation().permutation();
  plan.scan.needed_slots = XPOD_RDF_SLOT_SUBJECT | XPOD_RDF_SLOT_PREDICATE |
                           XPOD_RDF_SLOT_OBJECT;
  plan.sorted_by = scan.getResultSortedOn();
  plan.result_width = scan.getResultWidth();
  plan.descriptor = scan.getDescriptor();
  plan.root.kind = BridgeOperationKind::PermutationScan;
  plan.root.scan_indexes = {0};
  plan.root.join_slot = XPOD_RDF_SLOT_SUBJECT;
}

inline std::optional<BridgeQueryPlan> planIndexScanOperation(
    const IndexScan& scan) {
  BridgeQueryPlan plan;
  if (!bindIndexScanComponent(scan.subject(), XPOD_RDF_SLOT_SUBJECT, plan) ||
      !bindIndexScanComponent(scan.predicate(), XPOD_RDF_SLOT_PREDICATE, plan) ||
      !bindIndexScanComponent(scan.object(), XPOD_RDF_SLOT_OBJECT, plan)) {
    return std::nullopt;
  }
  initializeIndexScanOperationPlan(plan, scan);
  return plan;
}

inline const TripleComponent& indexScanComponentForSlot(
    const IndexScan& scan,
    uint32_t slot) {
  if (slot == XPOD_RDF_SLOT_SUBJECT) {
    return scan.subject();
  }
  if (slot == XPOD_RDF_SLOT_PREDICATE) {
    return scan.predicate();
  }
  return scan.object();
}

inline std::optional<uint32_t> inferSameVariableJoinSlot(
    const IndexScan& left,
    const IndexScan& right) {
  for (uint32_t slot : {
           XPOD_RDF_SLOT_SUBJECT,
           XPOD_RDF_SLOT_PREDICATE,
           XPOD_RDF_SLOT_OBJECT,
       }) {
    const TripleComponent& left_component = indexScanComponentForSlot(left, slot);
    const TripleComponent& right_component = indexScanComponentForSlot(right, slot);
    if (left_component.isVariable() && right_component.isVariable() &&
        left_component.getVariable().name() ==
            right_component.getVariable().name()) {
      return slot;
    }
  }
  return std::nullopt;
}

inline const IndexScan* rootIndexScan(const QueryExecutionTree* tree) {
  if (tree == nullptr || tree->isEmpty()) {
    return nullptr;
  }
  auto operation = tree->getRootOperation();
  return operation == nullptr ? nullptr
                              : dynamic_cast<const IndexScan*>(operation.get());
}

inline std::optional<BridgeQueryPlan> planJoinOperation(const Join& join) {
  std::vector<const QueryExecutionTree*> children = join.getChildren();
  if (children.size() != 2) {
    return std::nullopt;
  }
  const IndexScan* left_scan = rootIndexScan(children[0]);
  const IndexScan* right_scan = rootIndexScan(children[1]);
  if (left_scan == nullptr || right_scan == nullptr) {
    return std::nullopt;
  }
  auto join_slot = inferSameVariableJoinSlot(*left_scan, *right_scan);
  if (!join_slot.has_value()) {
    return std::nullopt;
  }

  auto left_plan = planIndexScanOperation(*left_scan);
  auto right_plan = planIndexScanOperation(*right_scan);
  if (!left_plan.has_value() || !right_plan.has_value()) {
    return std::nullopt;
  }

  BridgeFilterScan filter;
  filter.scan = right_plan->scan;
  filter.term_bindings = std::move(right_plan->term_bindings);
  filter.join_slot = *join_slot;
  filter.descriptor = right_plan->descriptor;
  left_plan->filter_scans.push_back(std::move(filter));
  left_plan->descriptor = join.getDescriptor();
  left_plan->root.kind = BridgeOperationKind::HashJoin;
  left_plan->root.scan_indexes = {0, 1};
  left_plan->root.join_slot = *join_slot;
  return left_plan;
}

inline std::optional<BridgeQueryPlan> planQleverOperation(
    const Operation& operation) {
  const auto* scan = dynamic_cast<const IndexScan*>(&operation);
  if (scan != nullptr) {
    return planIndexScanOperation(*scan);
  }
  const auto* join = dynamic_cast<const Join*>(&operation);
  if (join != nullptr) {
    return planJoinOperation(*join);
  }
  return std::nullopt;
}

inline std::optional<BridgeQueryPlan> planQleverExecutionTree(
    const QueryExecutionTree& tree) {
  if (tree.isEmpty()) {
    return std::nullopt;
  }
  auto operation = tree.getRootOperation();
  if (operation == nullptr) {
    return std::nullopt;
  }
  return planQleverOperation(*operation);
}

inline std::optional<BridgeQueryPlan> planQleverParsedQueryWithPlanner(
    QueryPlanner& planner,
    ParsedQuery& parsed) {
  QueryExecutionTree tree = planner.createExecutionTree(parsed);
  return planQleverExecutionTree(tree);
}

}  // namespace xpod::qlever
#endif

#endif
