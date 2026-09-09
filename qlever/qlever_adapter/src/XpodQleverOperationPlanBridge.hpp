#ifndef XPOD_QLEVER_OPERATION_PLAN_BRIDGE_HPP
#define XPOD_QLEVER_OPERATION_PLAN_BRIDGE_HPP

#include "XpodQleverPlanBridge.hpp"
#include "XpodQleverPlannerRequestContext.hpp"

#include <algorithm>
#include <array>
#include <memory>
#include <optional>
#include <string>
#include <string_view>
#include <type_traits>
#include <utility>
#include <vector>

#if XPOD_QLEVER_ADAPTER_ENABLE_QLEVER
#include "engine/IndexScan.h"
#include "engine/Join.h"
#include "engine/Operation.h"
#include "engine/QueryExecutionTree.h"
#include "engine/QueryPlanner.h"

#if __has_include("engine/TextIndexScanForWord.h")
#include "engine/TextIndexScanForWord.h"
#define XPOD_QLEVER_HAS_TEXT_INDEX_SCAN_FOR_WORD 1
#else
#define XPOD_QLEVER_HAS_TEXT_INDEX_SCAN_FOR_WORD 0
#endif

#if __has_include("engine/TextIndexScanForEntity.h")
#include "engine/TextIndexScanForEntity.h"
#define XPOD_QLEVER_HAS_TEXT_INDEX_SCAN_FOR_ENTITY 1
#else
#define XPOD_QLEVER_HAS_TEXT_INDEX_SCAN_FOR_ENTITY 0
#endif

#if __has_include("engine/TextLimit.h")
#include "engine/TextLimit.h"
#define XPOD_QLEVER_HAS_TEXT_LIMIT 1
#else
#define XPOD_QLEVER_HAS_TEXT_LIMIT 0
#endif

#if __has_include("engine/LimitOffset.h")
#include "engine/LimitOffset.h"
#define XPOD_QLEVER_HAS_LIMIT_OFFSET 1
#else
#define XPOD_QLEVER_HAS_LIMIT_OFFSET 0
#endif

#if __has_include("engine/NeutralElementOperation.h")
#include "engine/NeutralElementOperation.h"
#define XPOD_QLEVER_HAS_NEUTRAL_ELEMENT 1
#else
#define XPOD_QLEVER_HAS_NEUTRAL_ELEMENT 0
#endif

#if __has_include("engine/Union.h")
#include "engine/Union.h"
#define XPOD_QLEVER_HAS_UNION 1
#else
#define XPOD_QLEVER_HAS_UNION 0
#endif

#if __has_include("engine/CartesianProductJoin.h")
#include "engine/CartesianProductJoin.h"
#define XPOD_QLEVER_HAS_CARTESIAN_PRODUCT_JOIN 1
#else
#define XPOD_QLEVER_HAS_CARTESIAN_PRODUCT_JOIN 0
#endif

#if __has_include("engine/Minus.h")
#include "engine/Minus.h"
#define XPOD_QLEVER_HAS_MINUS 1
#else
#define XPOD_QLEVER_HAS_MINUS 0
#endif

#if __has_include("engine/OptionalJoin.h")
#include "engine/OptionalJoin.h"
#define XPOD_QLEVER_HAS_OPTIONAL_JOIN 1
#else
#define XPOD_QLEVER_HAS_OPTIONAL_JOIN 0
#endif

#if __has_include("engine/MultiColumnJoin.h")
#include "engine/MultiColumnJoin.h"
#define XPOD_QLEVER_HAS_MULTI_COLUMN_JOIN 1
#else
#define XPOD_QLEVER_HAS_MULTI_COLUMN_JOIN 0
#endif

#if __has_include("engine/ExistsJoin.h")
#include "engine/ExistsJoin.h"
#define XPOD_QLEVER_HAS_EXISTS_JOIN 1
#else
#define XPOD_QLEVER_HAS_EXISTS_JOIN 0
#endif

#if __has_include("engine/GroupBy.h")
#include "engine/GroupBy.h"
#define XPOD_QLEVER_HAS_GROUP_BY 1
#else
#define XPOD_QLEVER_HAS_GROUP_BY 0
#endif

#if __has_include("engine/HasPredicateScan.h")
#include "engine/HasPredicateScan.h"
#define XPOD_QLEVER_HAS_HAS_PREDICATE_SCAN 1
#else
#define XPOD_QLEVER_HAS_HAS_PREDICATE_SCAN 0
#endif

#if __has_include("engine/TransitivePathBase.h")
#include "engine/TransitivePathBase.h"
#define XPOD_QLEVER_HAS_TRANSITIVE_PATH 1
#else
#define XPOD_QLEVER_HAS_TRANSITIVE_PATH 0
#endif

#if __has_include("engine/Distinct.h")
#include "engine/Distinct.h"
#define XPOD_QLEVER_HAS_DISTINCT 1
#else
#define XPOD_QLEVER_HAS_DISTINCT 0
#endif

#if __has_include("engine/Filter.h")
#include "engine/Filter.h"
#define XPOD_QLEVER_HAS_FILTER 1
#else
#define XPOD_QLEVER_HAS_FILTER 0
#endif

#if __has_include("engine/Bind.h")
#include "engine/Bind.h"
#define XPOD_QLEVER_HAS_BIND 1
#else
#define XPOD_QLEVER_HAS_BIND 0
#endif

#if __has_include("engine/OrderBy.h")
#include "engine/OrderBy.h"
#define XPOD_QLEVER_HAS_ORDER_BY 1
#else
#define XPOD_QLEVER_HAS_ORDER_BY 0
#endif

#if __has_include("engine/Sort.h")
#include "engine/Sort.h"
#define XPOD_QLEVER_HAS_SORT 1
#else
#define XPOD_QLEVER_HAS_SORT 0
#endif

#if __has_include("engine/Values.h")
#include "engine/Values.h"
#define XPOD_QLEVER_HAS_VALUES 1
#else
#define XPOD_QLEVER_HAS_VALUES 0
#endif

#if __has_include("engine/Describe.h")
#include "engine/Describe.h"
#define XPOD_QLEVER_HAS_DESCRIBE 1
#else
#define XPOD_QLEVER_HAS_DESCRIBE 0
#endif

#if __has_include("engine/QueryExecutionContext.h")
#include "engine/QueryExecutionContext.h"
#define XPOD_QLEVER_HAS_QUERY_EXECUTION_CONTEXT 1
#else
#define XPOD_QLEVER_HAS_QUERY_EXECUTION_CONTEXT 0
#endif

class QueryExecutionContext;

#if __has_include("util/CancellationHandle.h")
#include "util/CancellationHandle.h"
#define XPOD_QLEVER_HAS_CANCELLATION_HANDLE 1
#else
#define XPOD_QLEVER_HAS_CANCELLATION_HANDLE 0
#endif

namespace xpod::qlever {

constexpr ColumnIndex XpodQleverGraphAdditionalColumn = 3;

inline std::vector<const QueryExecutionTree*> qleverOperationChildren(
    const Operation& operation) {
  std::vector<QueryExecutionTree*> mutable_children =
      const_cast<Operation&>(operation).getChildren();
  return {
      mutable_children.begin(),
      mutable_children.end(),
  };
}

template <typename OperationT>
inline std::optional<std::vector<std::string>>
visibleOutputVariablesFromOperation(const OperationT& operation) {
  std::vector<std::pair<ColumnIndex, std::string>> columns;
  const auto& variable_columns =
      operation.getExternallyVisibleVariableColumns();
  columns.reserve(variable_columns.size());
  for (const auto& [variable, info] : variable_columns) {
    if (info.columnIndex_ >= operation.getResultWidth()) {
      return std::nullopt;
    }
    columns.emplace_back(info.columnIndex_, bridgeVariableName(variable));
  }
  std::sort(
      columns.begin(), columns.end(),
      [](const auto& left, const auto& right) {
        return left.first < right.first;
      });

  std::vector<std::string> output_variables;
  output_variables.reserve(columns.size());
  ColumnIndex expected_column = 0;
  for (auto& [column, variable] : columns) {
    if (column != expected_column) {
      return std::nullopt;
    }
    output_variables.push_back(std::move(variable));
    ++expected_column;
  }
  if (output_variables.size() != operation.getResultWidth()) {
    return std::nullopt;
  }
  return output_variables;
}

inline std::optional<BridgeQueryPlan> planQleverOperation(
    const Operation& operation);

inline std::optional<BridgeQueryPlan> planQleverExecutionTree(
    const QueryExecutionTree& tree);

inline bool bindIndexScanComponent(
    const TripleComponent& component,
    uint32_t slot,
    BridgeQueryPlan& plan) {
  if (component.isVariable()) {
    return true;
  }
  return bindableComponent(component, std::string_view{}, slot, plan);
}

inline bool appendIndexScanGraphScope(
    const IndexScan& scan,
    BridgeQueryPlan& plan) {
  const auto& graph_filter = scan.graphsToFilter();
  if (graph_filter.areAllGraphsAllowed()) {
    if (std::find(
            scan.additionalColumns().begin(),
            scan.additionalColumns().end(),
            XpodQleverGraphAdditionalColumn) != scan.additionalColumns().end()) {
      return true;
    }
    std::optional<BridgeGraphScope> default_graph = defaultGraphBridgeScope();
    if (!default_graph.has_value()) {
      return false;
    }
    plan.graph_scope_bindings = std::move(default_graph->graph_scope_bindings);
    return true;
  }
  using GraphFilter = std::decay_t<decltype(graph_filter)>;
  return std::visit(
      [&](const auto& value) -> bool {
        using Value = std::decay_t<decltype(value)>;
        if constexpr (std::is_same_v<
                          Value, typename GraphFilter::AllTag>) {
          return true;
        } else if constexpr (std::is_same_v<Value, TripleComponent>) {
          // A QLever blacklist needs a deny-list access scope, which this
          // operation-plan representation cannot express yet.
          return false;
        } else {
          for (const TripleComponent& graph : value) {
            auto binding = termBindingFromValuesComponent(graph);
            if (!binding.has_value() ||
                binding->kind != XPOD_RDF_TERM_IRI) {
              return false;
            }
            binding->slot = XPOD_RDF_SLOT_GRAPH;
            plan.graph_scope_bindings.push_back(std::move(*binding));
          }
          return !plan.graph_scope_bindings.empty();
        }
      },
      graph_filter.xpodPhysicalFilterType());
}

inline void appendIndexScanOutputVariable(
    std::vector<std::string>& output_variables,
    char slot,
    const IndexScan& scan) {
  const TripleComponent* component = nullptr;
  if (slot == 'S') {
    component = &scan.subject();
  } else if (slot == 'P') {
    component = &scan.predicate();
  } else if (slot == 'O') {
    component = &scan.object();
  }
  if (component != nullptr && component->isVariable()) {
    output_variables.push_back(bridgeComponentVariableName(*component));
  }
}

inline std::array<char, 3> indexScanPermutationSlots(
    Permutation::Enum permutation) noexcept {
  switch (permutation) {
    case Permutation::Enum::PSO:
      return {'P', 'S', 'O'};
    case Permutation::Enum::POS:
      return {'P', 'O', 'S'};
    case Permutation::Enum::SPO:
      return {'S', 'P', 'O'};
    case Permutation::Enum::SOP:
      return {'S', 'O', 'P'};
    case Permutation::Enum::OPS:
      return {'O', 'P', 'S'};
    case Permutation::Enum::OSP:
      return {'O', 'S', 'P'};
  }
  return {'S', 'P', 'O'};
}

inline std::vector<std::string> indexScanOutputVariables(
    const IndexScan& scan) {
  std::optional<std::vector<std::string>> visible_variables =
      visibleOutputVariablesFromOperation(scan);
  if (visible_variables.has_value()) {
    return *visible_variables;
  }

  std::vector<std::string> output_variables;
  output_variables.reserve(scan.getResultWidth());
  for (char slot : indexScanPermutationSlots(scan.permutation().permutation())) {
    appendIndexScanOutputVariable(output_variables, slot, scan);
  }
  for (const Variable& variable : scan.additionalVariables()) {
    output_variables.push_back(bridgeVariableName(variable));
  }
  return output_variables;
}

inline uint32_t indexScanSlotMask(char slot) noexcept {
  switch (slot) {
    case 'S':
      return XPOD_RDF_SLOT_SUBJECT;
    case 'P':
      return XPOD_RDF_SLOT_PREDICATE;
    case 'O':
      return XPOD_RDF_SLOT_OBJECT;
    default:
      return 0;
  }
}

inline void appendIndexScanOutputSlot(
    std::vector<uint32_t>& output_slots,
    char slot,
    const IndexScan& scan) {
  const TripleComponent* component = nullptr;
  if (slot == 'S') {
    component = &scan.subject();
  } else if (slot == 'P') {
    component = &scan.predicate();
  } else if (slot == 'O') {
    component = &scan.object();
  }
  if (component != nullptr && component->isVariable()) {
    output_slots.push_back(indexScanSlotMask(slot));
  }
}

inline std::vector<uint32_t> indexScanOutputSlots(
    const IndexScan& scan) {
  std::vector<uint32_t> output_slots;
  output_slots.reserve(scan.getResultWidth());
  for (char slot : indexScanPermutationSlots(scan.permutation().permutation())) {
    appendIndexScanOutputSlot(output_slots, slot, scan);
  }
  for (ColumnIndex column : scan.additionalColumns()) {
    if (column == XpodQleverGraphAdditionalColumn) {
      output_slots.push_back(XPOD_RDF_SLOT_GRAPH);
    }
  }
  return output_slots;
}

inline void initializeIndexScanOperationPlan(
    BridgeQueryPlan& plan,
    const IndexScan& scan) {
  plan.scan.permutation = scan.permutation().permutation();
  plan.scan.needed_slots = 0;
  for (uint32_t slot : indexScanOutputSlots(scan)) {
    plan.scan.needed_slots |= slot;
  }
  plan.sorted_by = scan.getResultSortedOn();
  plan.result_width = scan.getResultWidth();
  plan.output_variables = indexScanOutputVariables(scan);
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
      !bindIndexScanComponent(scan.object(), XPOD_RDF_SLOT_OBJECT, plan) ||
      !appendIndexScanGraphScope(scan, plan)) {
    return std::nullopt;
  }
  initializeIndexScanOperationPlan(plan, scan);
  return plan;
}

inline void appendTextCandidateOutput(
    BridgeQueryPlan& plan,
    BridgeTextCandidateSource& source,
    const Variable& variable,
    BridgeCandidateColumnKind kind) {
  BridgeCandidateOutputColumn column;
  column.variable = bridgeVariableName(variable);
  column.kind = kind;
  plan.output_variables.push_back(column.variable);
  source.output_columns.push_back(std::move(column));
}

#if XPOD_QLEVER_HAS_TEXT_INDEX_SCAN_FOR_WORD
inline std::optional<BridgeQueryPlan> planTextIndexScanForWordOperation(
    const TextIndexScanForWord& scan) {
  auto output_variables = visibleOutputVariablesFromOperation(scan);
  if (!output_variables.has_value() || output_variables->empty() ||
      output_variables->front() != bridgeVariableName(scan.textRecordVar())) {
    return std::nullopt;
  }
  BridgeQueryPlan plan;
  BridgeTextCandidateSource source;
  source.request.candidate_kind = XPOD_RDF_TEXT_CANDIDATE_RECORD;
  source.setQuery(scan.word());
  source.descriptor = scan.getDescriptor();
  appendTextCandidateOutput(
      plan, source, scan.textRecordVar(),
      BridgeCandidateColumnKind::RetrievalPoint);
  plan.output_variables = std::move(*output_variables);
  plan.text_sources.push_back(std::move(source));
  plan.descriptor = scan.getDescriptor();
  plan.result_width = scan.getResultWidth();
  plan.root.kind = BridgeOperationKind::TextSearch;
  plan.root.candidate_index = 0;
  return plan;
}
#endif

inline std::optional<BridgeTermBinding> textEntityBindingFromString(
    std::string_view entity) {
  if (entity.empty()) {
    return std::nullopt;
  }
  BridgeTermBinding binding;
  binding.kind = XPOD_RDF_TERM_IRI;
  if (entity.size() >= 2 && entity.front() == '<' && entity.back() == '>') {
    binding.value = std::string(entity.substr(1, entity.size() - 2));
  } else {
    binding.value = std::string(entity);
  }
  return binding;
}

#if XPOD_QLEVER_HAS_TEXT_INDEX_SCAN_FOR_ENTITY
inline std::optional<BridgeQueryPlan> planTextIndexScanForEntityOperation(
    const TextIndexScanForEntity& scan) {
  BridgeQueryPlan plan;
  BridgeTextCandidateSource source;
  source.request.candidate_kind = XPOD_RDF_TEXT_CANDIDATE_ENTITY;
  source.setQuery(scan.word());
  source.descriptor = scan.getDescriptor();
  appendTextCandidateOutput(
      plan, source, scan.textRecordVar(),
      BridgeCandidateColumnKind::RetrievalPoint);
  if (!scan.hasFixedEntity()) {
    appendTextCandidateOutput(
        plan, source, scan.entityVariable(),
        BridgeCandidateColumnKind::ResourceTerm);
  }
  plan.text_sources.push_back(std::move(source));
  if (scan.hasFixedEntity()) {
    auto entity = textEntityBindingFromString(scan.fixedEntity());
    if (!entity.has_value()) {
      return std::nullopt;
    }
    BridgeTextRequiredEntityBinding required_entity;
    required_entity.text_source_index = 0;
    required_entity.term = std::move(*entity);
    plan.text_required_entities.push_back(std::move(required_entity));
  }
  plan.descriptor = scan.getDescriptor();
  plan.result_width = scan.getResultWidth();
  plan.root.kind = BridgeOperationKind::TextSearch;
  plan.root.candidate_index = 0;
  return plan;
}
#endif

#if XPOD_QLEVER_HAS_TEXT_INDEX_SCAN_FOR_WORD && \
    XPOD_QLEVER_HAS_TEXT_INDEX_SCAN_FOR_ENTITY
inline std::optional<BridgeQueryPlan> planTextWordEntityJoinPair(
    const TextIndexScanForWord& word_scan,
    const TextIndexScanForEntity& entity_scan,
    const std::string& descriptor,
    size_t result_width) {
  if (!entity_scan.hasFixedEntity()) {
    return std::nullopt;
  }
  if (word_scan.word() != entity_scan.word()) {
    return std::nullopt;
  }
  if (word_scan.textRecordVar().name() !=
      entity_scan.textRecordVar().name()) {
    return std::nullopt;
  }
  auto entity = textEntityBindingFromString(entity_scan.fixedEntity());
  if (!entity.has_value()) {
    return std::nullopt;
  }

  BridgeQueryPlan plan;
  BridgeTextCandidateSource source;
  source.request.candidate_kind = XPOD_RDF_TEXT_CANDIDATE_ENTITY;
  source.setQuery(word_scan.word());
  source.descriptor = descriptor;
  appendTextCandidateOutput(
      plan, source, word_scan.textRecordVar(),
      BridgeCandidateColumnKind::RetrievalPoint);
  plan.text_sources.push_back(std::move(source));
  BridgeTextRequiredEntityBinding required_entity;
  required_entity.text_source_index = 0;
  required_entity.term = std::move(*entity);
  plan.text_required_entities.push_back(std::move(required_entity));
  plan.descriptor = descriptor;
  plan.result_width = result_width;
  plan.root.kind = BridgeOperationKind::TextSearch;
  plan.root.candidate_index = 0;
  return plan;
}

inline std::optional<uint32_t> indexScanSlotForVariable(
    const IndexScan& scan,
    std::string_view variable);

inline std::optional<BridgeQueryPlan> planTextEntityRdfJoinPair(
    const TextIndexScanForEntity& entity_scan,
    const IndexScan& index_scan,
    const std::string& descriptor) {
  if (entity_scan.hasFixedEntity()) {
    return std::nullopt;
  }
  std::optional<uint32_t> join_slot = indexScanSlotForVariable(
      index_scan, bridgeVariableName(entity_scan.entityVariable()));
  if (!join_slot.has_value()) {
    return std::nullopt;
  }

  auto text_plan = planTextIndexScanForEntityOperation(entity_scan);
  auto index_plan = planIndexScanOperation(index_scan);
  if (!text_plan.has_value() || !index_plan.has_value()) {
    return std::nullopt;
  }

  std::vector<BridgeCandidateOutputColumn> candidate_project_columns;
  std::vector<std::string> output_variables;
  for (const BridgeCandidateOutputColumn& column :
       text_plan->text_sources[0].output_columns) {
    if (!containsOutputVariable(index_plan->output_variables, column.variable)) {
      candidate_project_columns.push_back(column);
      output_variables.push_back(column.variable);
    }
  }
  for (const std::string& variable : index_plan->output_variables) {
    output_variables.push_back(variable);
  }

  index_plan->text_sources = std::move(text_plan->text_sources);
  index_plan->text_required_entities =
      std::move(text_plan->text_required_entities);
  index_plan->descriptor = descriptor;
  index_plan->output_variables = std::move(output_variables);
  index_plan->result_width = index_plan->output_variables.size();
  index_plan->filter_scans.clear();
  index_plan->root.kind = BridgeOperationKind::HashJoin;
  index_plan->root.use_candidate_join = true;
  index_plan->root.candidate_index = 0;
  index_plan->root.candidate_join_column =
      BridgeCandidateColumnKind::ResourceTerm;
  index_plan->root.candidate_project_columns =
      std::move(candidate_project_columns);
  index_plan->root.scan_indexes = {0};
  index_plan->root.join_slot = *join_slot;
  index_plan->root.join_slots = {*join_slot};
  return index_plan;
}

inline std::optional<BridgeQueryPlan> planTextJoinOperation(
    const Join& join) {
  std::vector<const QueryExecutionTree*> children =
      qleverOperationChildren(join);
  if (children.size() != 2 || children[0] == nullptr ||
      children[1] == nullptr) {
    return std::nullopt;
  }
  auto left = children[0]->getRootOperation();
  auto right = children[1]->getRootOperation();
  if (left == nullptr || right == nullptr) {
    return std::nullopt;
  }

  const auto* left_word = dynamic_cast<const TextIndexScanForWord*>(left.get());
  const auto* right_word =
      dynamic_cast<const TextIndexScanForWord*>(right.get());
  const auto* left_entity =
      dynamic_cast<const TextIndexScanForEntity*>(left.get());
  const auto* right_entity =
      dynamic_cast<const TextIndexScanForEntity*>(right.get());
  const auto* left_index = dynamic_cast<const IndexScan*>(left.get());
  const auto* right_index = dynamic_cast<const IndexScan*>(right.get());
  if (left_word != nullptr && right_entity != nullptr) {
    return planTextWordEntityJoinPair(
        *left_word, *right_entity, join.getDescriptor(),
        join.getResultWidth());
  }
  if (right_word != nullptr && left_entity != nullptr) {
    return planTextWordEntityJoinPair(
        *right_word, *left_entity, join.getDescriptor(),
        join.getResultWidth());
  }
  if (left_entity != nullptr && right_index != nullptr) {
    return planTextEntityRdfJoinPair(
        *left_entity, *right_index, join.getDescriptor());
  }
  if (right_entity != nullptr && left_index != nullptr) {
    return planTextEntityRdfJoinPair(
        *right_entity, *left_index, join.getDescriptor());
  }
  return std::nullopt;
}
#endif

inline std::optional<BridgeQueryPlan> planGenericJoinOperation(
    const Join& join) {
  std::vector<const QueryExecutionTree*> children =
      qleverOperationChildren(join);
  if (children.size() != 2 || children[0] == nullptr ||
      children[1] == nullptr) {
    return std::nullopt;
  }
  auto left_plan = planQleverExecutionTree(*children[0]);
  auto right_plan = planQleverExecutionTree(*children[1]);
  if (!left_plan.has_value() || !right_plan.has_value()) {
    return std::nullopt;
  }

  BridgeQueryPlan plan;
  plan.descriptor = join.getDescriptor();
  plan.result_width = join.getResultWidth();
  plan.sorted_by = join.getResultSortedOn();
  plan.root.kind = BridgeOperationKind::HashJoin;
  plan.root.sorted_by = plan.sorted_by;
  auto output_variables = visibleOutputVariablesFromOperation(join);
  if (output_variables.has_value()) {
    plan.output_variables = std::move(*output_variables);
  } else {
    plan.output_variables = left_plan->output_variables;
  }
  plan.root.matched_columns = matchedOutputVariableColumns(
      left_plan->output_variables, right_plan->output_variables);
  if (plan.root.matched_columns.empty()) {
    return std::nullopt;
  }
  plan.root.right_projection_columns = rightProjectionColumns(
      left_plan->output_variables, right_plan->output_variables);
  if (!output_variables.has_value()) {
    for (size_t column : plan.root.right_projection_columns) {
      if (column >= right_plan->output_variables.size()) {
        return std::nullopt;
      }
      plan.output_variables.push_back(right_plan->output_variables[column]);
    }
  }
  if (plan.output_variables.size() != plan.result_width) {
    return std::nullopt;
  }
  plan.root.native_result_only =
      right_plan->root.kind != BridgeOperationKind::PermutationScan ||
      right_plan->root.scan_indexes.size() != 1 ||
      !right_plan->root.result_modifiers.empty() ||
      right_plan->root.has_limit ||
      right_plan->root.has_distinct ||
      !right_plan->child_plans.empty() ||
      plan.root.matched_columns.size() > 4;
  plan.child_plans.push_back(std::move(*left_plan));
  plan.child_plans.push_back(std::move(*right_plan));
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

inline bool collectIndexScanLeaves(
    const QueryExecutionTree* tree,
    std::vector<const IndexScan*>& scans) {
  if (tree == nullptr || tree->isEmpty()) {
    return false;
  }
  auto operation = tree->getRootOperation();
  if (operation == nullptr) {
    return false;
  }
  const auto* scan = dynamic_cast<const IndexScan*>(operation.get());
  if (scan != nullptr) {
    scans.push_back(scan);
    return true;
  }
  const auto* join = dynamic_cast<const Join*>(operation.get());
  if (join == nullptr) {
    return false;
  }
  std::vector<const QueryExecutionTree*> children =
      qleverOperationChildren(*join);
  if (children.size() != 2) {
    return false;
  }
  return collectIndexScanLeaves(children[0], scans) &&
         collectIndexScanLeaves(children[1], scans);
}

inline std::optional<uint32_t> indexScanSlotForVariable(
    const IndexScan& scan,
    std::string_view variable) {
  for (uint32_t slot : {
           XPOD_RDF_SLOT_SUBJECT,
           XPOD_RDF_SLOT_PREDICATE,
           XPOD_RDF_SLOT_OBJECT,
       }) {
    const TripleComponent& component = indexScanComponentForSlot(scan, slot);
    if (component.isVariable() &&
        bridgeComponentVariableName(component) == variable) {
      return slot;
    }
  }
  return std::nullopt;
}

inline std::optional<std::vector<uint32_t>> inferCommonVariableJoinSlots(
    const std::vector<const IndexScan*>& scans) {
  if (scans.size() < 2) {
    return std::nullopt;
  }
  for (uint32_t slot : {
           XPOD_RDF_SLOT_SUBJECT,
           XPOD_RDF_SLOT_PREDICATE,
           XPOD_RDF_SLOT_OBJECT,
       }) {
    const TripleComponent& first_component =
        indexScanComponentForSlot(*scans.front(), slot);
    if (!first_component.isVariable()) {
      continue;
    }
    std::string variable = bridgeComponentVariableName(first_component);
    std::vector<uint32_t> join_slots;
    join_slots.reserve(scans.size());
    join_slots.push_back(slot);
    for (size_t i = 1; i < scans.size(); ++i) {
      std::optional<uint32_t> join_slot =
          indexScanSlotForVariable(*scans[i], variable);
      if (!join_slot.has_value()) {
        join_slots.clear();
        break;
      }
      join_slots.push_back(*join_slot);
    }
    if (join_slots.size() == scans.size()) {
      return join_slots;
    }
  }
  return std::nullopt;
}

inline std::optional<std::vector<std::vector<uint32_t>>>
inferCommonVariableJoinKeySlots(
    const std::vector<const IndexScan*>& scans) {
  if (scans.size() < 2) {
    return std::nullopt;
  }
  std::vector<std::vector<uint32_t>> join_key_slots(scans.size());
  for (uint32_t first_slot : {
           XPOD_RDF_SLOT_SUBJECT,
           XPOD_RDF_SLOT_PREDICATE,
           XPOD_RDF_SLOT_OBJECT,
       }) {
    const TripleComponent& first_component =
        indexScanComponentForSlot(*scans.front(), first_slot);
    if (!first_component.isVariable()) {
      continue;
    }
    std::string variable = bridgeComponentVariableName(first_component);
    std::vector<uint32_t> slots_for_variable;
    slots_for_variable.reserve(scans.size());
    slots_for_variable.push_back(first_slot);
    for (size_t i = 1; i < scans.size(); ++i) {
      std::optional<uint32_t> join_slot =
          indexScanSlotForVariable(*scans[i], variable);
      if (!join_slot.has_value()) {
        slots_for_variable.clear();
        break;
      }
      slots_for_variable.push_back(*join_slot);
    }
    if (slots_for_variable.size() != scans.size()) {
      continue;
    }
    for (size_t i = 0; i < scans.size(); ++i) {
      join_key_slots[i].push_back(slots_for_variable[i]);
    }
  }
  if (join_key_slots.front().empty()) {
    return std::nullopt;
  }
  return join_key_slots;
}

inline std::optional<BridgeQueryPlan> planJoinOperation(const Join& join) {
#if XPOD_QLEVER_HAS_TEXT_INDEX_SCAN_FOR_WORD && \
    XPOD_QLEVER_HAS_TEXT_INDEX_SCAN_FOR_ENTITY
  auto text_plan = planTextJoinOperation(join);
  if (text_plan.has_value()) {
    return text_plan;
  }
#endif
  std::vector<const QueryExecutionTree*> children =
      qleverOperationChildren(join);
  if (children.size() != 2) {
    return std::nullopt;
  }
  std::vector<const IndexScan*> scans;
  if (!collectIndexScanLeaves(children[0], scans) ||
      !collectIndexScanLeaves(children[1], scans)) {
    return planGenericJoinOperation(join);
  }
  auto join_key_slots = inferCommonVariableJoinKeySlots(scans);
  if (!join_key_slots.has_value()) {
    return planGenericJoinOperation(join);
  }
  std::vector<uint32_t> legacy_join_slots;
  legacy_join_slots.reserve(join_key_slots->size());
  for (const std::vector<uint32_t>& slots_for_scan : *join_key_slots) {
    if (slots_for_scan.empty()) {
      return std::nullopt;
    }
    legacy_join_slots.push_back(slots_for_scan.front());
  }

  auto left_plan = planIndexScanOperation(*scans.front());
  if (!left_plan.has_value()) {
    return std::nullopt;
  }

  std::vector<std::vector<uint32_t>> scan_project_slots;
  scan_project_slots.reserve(scans.size());
  scan_project_slots.push_back(indexScanOutputSlots(*scans.front()));

  left_plan->filter_scans.clear();
  left_plan->root.scan_indexes = {0};
  for (size_t i = 1; i < scans.size(); ++i) {
    auto right_plan = planIndexScanOperation(*scans[i]);
    if (!right_plan.has_value()) {
      return std::nullopt;
    }
    std::vector<uint32_t> right_output_slots =
        indexScanOutputSlots(*scans[i]);
    std::vector<uint32_t> right_project_slots;
    right_project_slots.reserve(right_output_slots.size());
    for (size_t column = 0;
         column < right_plan->output_variables.size() &&
         column < right_output_slots.size();
         ++column) {
      const std::string& variable = right_plan->output_variables[column];
      if (containsOutputVariable(left_plan->output_variables, variable)) {
        continue;
      }
      left_plan->output_variables.push_back(variable);
      right_project_slots.push_back(right_output_slots[column]);
    }
    scan_project_slots.push_back(std::move(right_project_slots));
    BridgeFilterScan filter;
    filter.scan = right_plan->scan;
    filter.term_bindings = std::move(right_plan->term_bindings);
    filter.join_slot = legacy_join_slots[i];
    filter.descriptor = right_plan->descriptor;
    left_plan->filter_scans.push_back(std::move(filter));
    left_plan->root.scan_indexes.push_back(i);
  }
  left_plan->descriptor = join.getDescriptor();
  left_plan->root.kind = BridgeOperationKind::HashJoin;
  left_plan->root.join_slot = legacy_join_slots.front();
  left_plan->root.join_slots = std::move(legacy_join_slots);
  left_plan->root.join_key_slots = std::move(*join_key_slots);
  left_plan->root.scan_project_slots = std::move(scan_project_slots);
  left_plan->result_width = left_plan->output_variables.size();
  return left_plan;
}

#if XPOD_QLEVER_HAS_LIMIT_OFFSET
inline std::optional<BridgeQueryPlan> planLimitOffsetOperation(
    const LimitOffset& operation) {
  std::vector<const QueryExecutionTree*> children = operation.getChildren();
  if (children.size() != 1 || children[0] == nullptr) {
    return std::nullopt;
  }
  auto plan = planQleverExecutionTree(*children[0]);
  if (!plan.has_value()) {
    return std::nullopt;
  }
  BridgeResultModifier modifier;
  modifier.kind = BridgeResultModifierKind::LimitOffset;
  modifier.limit = operation.limit();
  modifier.offset = operation.offset();
  plan->root.result_modifiers.push_back(std::move(modifier));
  return plan;
}
#endif

#if XPOD_QLEVER_HAS_DISTINCT
inline std::optional<BridgeQueryPlan> planDistinctOperation(
    const Distinct& operation) {
  std::vector<QueryExecutionTree*> mutable_children =
      const_cast<Distinct&>(operation).getChildren();
  std::vector<const QueryExecutionTree*> children;
  children.reserve(mutable_children.size());
  for (QueryExecutionTree* child : mutable_children) {
    children.push_back(child);
  }
  if (children.size() != 1 || children[0] == nullptr) {
    return std::nullopt;
  }
  auto plan = planQleverExecutionTree(*children[0]);
  if (!plan.has_value()) {
    return std::nullopt;
  }
  BridgeResultModifier modifier;
  modifier.kind = BridgeResultModifierKind::Distinct;
  modifier.columns = operation.getDistinctColumns();
  plan->root.result_modifiers.push_back(std::move(modifier));
  return plan;
}
#endif

#if XPOD_QLEVER_HAS_FILTER
inline std::optional<BridgeQueryPlan> planFilterOperation(Filter& operation) {
  std::vector<QueryExecutionTree*> children = operation.getChildren();
  if (children.size() != 1 || children[0] == nullptr) {
    return std::nullopt;
  }
  auto plan = planQleverExecutionTree(*children[0]);
  if (!plan.has_value()) {
    return std::nullopt;
  }

  std::string descriptor = operation.getDescriptor();
  constexpr std::string_view prefix = "Filter ";
  if (descriptor.rfind(prefix, 0) != 0) {
    return std::nullopt;
  }
  std::string_view expression(
      descriptor.data() + prefix.size(), descriptor.size() - prefix.size());
  if (!applyNotEqualFilterDescriptor(*plan, expression) &&
      !applyEqualFilterDescriptor(*plan, expression)) {
    plan->descriptor = descriptor + " -> " + plan->descriptor;
    plan->root.native_result_only = true;
  }
  return plan;
}
#endif

#if XPOD_QLEVER_HAS_BIND
inline std::optional<BridgeQueryPlan> planBindOperation(Bind& operation) {
  std::vector<QueryExecutionTree*> children = operation.getChildren();
  if (children.size() != 1 || children[0] == nullptr) {
    return std::nullopt;
  }
  auto plan = planQleverExecutionTree(*children[0]);
  if (!plan.has_value()) {
    return std::nullopt;
  }
  if (operation.getResultWidth() != plan->output_variables.size() + 1) {
    return std::nullopt;
  }
  plan->descriptor = operation.getDescriptor() + " -> " + plan->descriptor;
  plan->output_variables.push_back(bridgeVariableName(operation.bind()._target));
  plan->result_width = plan->output_variables.size();
  plan->root.native_result_only = true;
  return plan;
}
#endif

#if XPOD_QLEVER_HAS_ORDER_BY
inline std::optional<BridgeQueryPlan> planOrderByOperation(
    const OrderBy& operation) {
  std::vector<QueryExecutionTree*> children =
      const_cast<OrderBy&>(operation).getChildren();
  if (children.size() != 1 || children[0] == nullptr) {
    return std::nullopt;
  }
  auto plan = planQleverExecutionTree(*children[0]);
  if (!plan.has_value()) {
    return std::nullopt;
  }

  BridgeResultModifier modifier;
  modifier.kind = BridgeResultModifierKind::OrderBy;
  auto sorted_variables = operation.getSortedVariables();
  modifier.columns.reserve(sorted_variables.size());
  modifier.descending.reserve(sorted_variables.size());
  for (const auto& sorted_variable : sorted_variables) {
    auto column = outputColumnForVariable(
        plan->output_variables,
        bridgeVariableName(sorted_variable.first));
    if (!column.has_value()) {
      return std::nullopt;
    }
    modifier.columns.push_back(*column);
    modifier.descending.push_back(
        sorted_variable.second == OrderBy::AscOrDesc::Desc);
  }
  plan->sorted_by.clear();
  plan->root.result_modifiers.push_back(std::move(modifier));
  return plan;
}
#endif

#if XPOD_QLEVER_HAS_SORT
inline std::optional<BridgeQueryPlan> planSortOperation(
    const Sort& operation) {
  std::vector<QueryExecutionTree*> children =
      const_cast<Sort&>(operation).getChildren();
  if (children.size() != 1 || children[0] == nullptr) {
    return std::nullopt;
  }
  auto plan = planQleverExecutionTree(*children[0]);
  if (!plan.has_value()) {
    return std::nullopt;
  }

  BridgeResultModifier modifier;
  modifier.kind = BridgeResultModifierKind::InternalSort;
  modifier.columns = operation.resultSortedOn();
  plan->sorted_by = modifier.columns;
  plan->root.result_modifiers.push_back(std::move(modifier));
  return plan;
}
#endif

#if XPOD_QLEVER_HAS_VALUES
inline std::optional<BridgeQueryPlan> planValuesOperation(
    const Values& operation) {
  auto output_variables = visibleOutputVariablesFromOperation(operation);
  if (!output_variables.has_value()) {
    return std::nullopt;
  }

  BridgeQueryPlan plan;
  plan.descriptor = operation.getDescriptor();
  plan.result_width = operation.getResultWidth();
  plan.sorted_by = operation.getResultSortedOn();
  plan.output_variables = std::move(*output_variables);
  plan.root.kind = BridgeOperationKind::Values;
  plan.root.sorted_by = plan.sorted_by;
  plan.root.native_result_only = true;
  return plan;
}
#endif

#if XPOD_QLEVER_HAS_DESCRIBE
inline std::optional<BridgeQueryPlan> planDescribeOperation(
    Describe& operation) {
  std::vector<QueryExecutionTree*> children = operation.getChildren();
  if (children.size() != 1 || children[0] == nullptr) {
    return std::nullopt;
  }

  auto child_plan = planQleverExecutionTree(*children[0]);
  if (!child_plan.has_value()) {
    return std::nullopt;
  }

  BridgeQueryPlan plan;
  plan.descriptor = operation.getDescriptor();
  plan.result_width = operation.getResultWidth();
  plan.sorted_by = operation.getResultSortedOn();
  plan.output_variables =
      visibleOutputVariablesFromOperation(operation).value_or(
          std::vector<std::string>{});
  if (plan.output_variables.size() != plan.result_width) {
    if (plan.result_width != 3) {
      return std::nullopt;
    }
    plan.output_variables = {"subject", "predicate", "object"};
  }
  plan.root.kind = BridgeOperationKind::Describe;
  plan.root.sorted_by = plan.sorted_by;
  plan.root.native_result_only = true;
  plan.child_plans.push_back(std::move(*child_plan));
  return plan;
}
#endif

#if XPOD_QLEVER_HAS_TEXT_LIMIT
inline std::optional<BridgeQueryPlan> planTextLimitOperation(
    const TextLimit& operation) {
  std::vector<QueryExecutionTree*> children =
      const_cast<Operation&>(static_cast<const Operation&>(operation))
          .getChildren();
  if (children.size() != 1 || children[0] == nullptr) {
    return std::nullopt;
  }
  auto plan = planQleverExecutionTree(*children[0]);
  if (!plan.has_value() || plan->root.kind != BridgeOperationKind::TextSearch ||
      plan->root.candidate_index >= plan->text_sources.size()) {
    return std::nullopt;
  }
  plan->text_sources[plan->root.candidate_index].request.limit =
      operation.getTextLimit();
  return plan;
}
#endif

#if XPOD_QLEVER_HAS_NEUTRAL_ELEMENT
inline std::optional<BridgeQueryPlan> planNeutralElementOperation(
    const NeutralElementOperation& operation) {
  BridgeQueryPlan plan;
  plan.root.kind = BridgeOperationKind::NeutralElement;
  plan.result_width = 0;
  plan.descriptor = operation.getDescriptor();
  return plan;
}
#endif

#if XPOD_QLEVER_HAS_UNION
inline std::optional<BridgeQueryPlan> planUnionOperation(
    const Union& operation) {
  if (operation.leftChild() == nullptr || operation.rightChild() == nullptr) {
    return std::nullopt;
  }
  auto left_plan = planQleverExecutionTree(*operation.leftChild());
  auto right_plan = planQleverExecutionTree(*operation.rightChild());
  if (!left_plan.has_value() || !right_plan.has_value()) {
    return std::nullopt;
  }

  BridgeQueryPlan plan;
  plan.descriptor = operation.getDescriptor();
  plan.result_width = operation.getResultWidth();
  plan.sorted_by = operation.getResultSortedOn();
  plan.root.kind = BridgeOperationKind::Union;
  plan.root.sorted_by = plan.sorted_by;
  plan.child_plans.push_back(std::move(*left_plan));
  plan.child_plans.push_back(std::move(*right_plan));

  if (plan.result_width == 0) {
    return std::nullopt;
  }

  for (size_t column = 0; column < plan.result_width; ++column) {
    auto left_column = operation.getOriginalColumn(true, column);
    auto right_column = operation.getOriginalColumn(false, column);
    if (!left_column.has_value() && !right_column.has_value()) {
      return std::nullopt;
    }

    std::optional<std::string> output_variable;
    if (left_column.has_value()) {
      if (*left_column >= plan.child_plans[0].output_variables.size()) {
        return std::nullopt;
      }
      output_variable = plan.child_plans[0].output_variables[*left_column];
    }
    if (right_column.has_value()) {
      if (*right_column >= plan.child_plans[1].output_variables.size()) {
        return std::nullopt;
      }
      const std::string& right_variable =
          plan.child_plans[1].output_variables[*right_column];
      if (output_variable.has_value() && *output_variable != right_variable) {
        return std::nullopt;
      }
      output_variable = right_variable;
    }
    if (!output_variable.has_value()) {
      return std::nullopt;
    }

    plan.output_variables.push_back(*output_variable);
    plan.root.column_origins.push_back({
        left_column.has_value() ? *left_column : BRIDGE_NO_COLUMN,
        right_column.has_value() ? *right_column : BRIDGE_NO_COLUMN,
    });
  }
  return plan;
}
#endif

#if XPOD_QLEVER_HAS_CARTESIAN_PRODUCT_JOIN
inline std::optional<BridgeQueryPlan> planCartesianProductJoinOperation(
    CartesianProductJoin& operation) {
  std::vector<QueryExecutionTree*> children = operation.getChildren();
  if (children.empty()) {
    return std::nullopt;
  }

  BridgeQueryPlan plan;
  plan.descriptor = operation.getDescriptor();
  plan.result_width = operation.getResultWidth();
  plan.sorted_by = operation.getResultSortedOn();
  plan.root.kind = BridgeOperationKind::CartesianProductJoin;
  plan.root.sorted_by = plan.sorted_by;

  for (QueryExecutionTree* child : children) {
    if (child == nullptr) {
      return std::nullopt;
    }
    auto child_plan = planQleverExecutionTree(*child);
    if (!child_plan.has_value()) {
      return std::nullopt;
    }
    plan.output_variables.insert(
        plan.output_variables.end(),
        child_plan->output_variables.begin(),
        child_plan->output_variables.end());
    plan.child_plans.push_back(std::move(*child_plan));
  }
  if (plan.output_variables.size() != plan.result_width) {
    return std::nullopt;
  }
  return plan;
}
#endif

#if XPOD_QLEVER_HAS_MINUS
inline std::optional<BridgeQueryPlan> planMinusOperation(Minus& operation) {
  std::vector<QueryExecutionTree*> children = operation.getChildren();
  if (children.size() != 2 || children[0] == nullptr ||
      children[1] == nullptr) {
    return std::nullopt;
  }

  auto left_plan = planQleverExecutionTree(*children[0]);
  auto right_plan = planQleverExecutionTree(*children[1]);
  if (!left_plan.has_value() || !right_plan.has_value()) {
    return std::nullopt;
  }

  BridgeQueryPlan plan;
  plan.descriptor = operation.getDescriptor();
  plan.result_width = operation.getResultWidth();
  plan.sorted_by = operation.getResultSortedOn();
  plan.root.kind = BridgeOperationKind::Minus;
  plan.root.sorted_by = plan.sorted_by;
  plan.output_variables = left_plan->output_variables;
  plan.root.matched_columns = matchedOutputVariableColumns(
      left_plan->output_variables, right_plan->output_variables);
  plan.child_plans.push_back(std::move(*left_plan));
  plan.child_plans.push_back(std::move(*right_plan));

  if (plan.output_variables.size() != plan.result_width) {
    return std::nullopt;
  }
  return plan;
}
#endif

#if XPOD_QLEVER_HAS_OPTIONAL_JOIN
inline std::optional<BridgeQueryPlan> planOptionalJoinOperation(
    OptionalJoin& operation) {
  std::vector<QueryExecutionTree*> children = operation.getChildren();
  if (children.size() != 2 || children[0] == nullptr ||
      children[1] == nullptr) {
    return std::nullopt;
  }

  auto left_plan = planQleverExecutionTree(*children[0]);
  auto right_plan = planQleverExecutionTree(*children[1]);
  if (!left_plan.has_value() || !right_plan.has_value()) {
    return std::nullopt;
  }

  BridgeQueryPlan plan;
  plan.descriptor = operation.getDescriptor();
  plan.result_width = operation.getResultWidth();
  plan.sorted_by = operation.getResultSortedOn();
  plan.root.kind = BridgeOperationKind::OptionalJoin;
  plan.root.sorted_by = plan.sorted_by;
  plan.output_variables = left_plan->output_variables;
  plan.root.matched_columns = matchedOutputVariableColumns(
      left_plan->output_variables, right_plan->output_variables);
  plan.root.right_projection_columns = rightProjectionColumns(
      left_plan->output_variables, right_plan->output_variables);
  for (size_t column : plan.root.right_projection_columns) {
    if (column >= right_plan->output_variables.size()) {
      return std::nullopt;
    }
    plan.output_variables.push_back(right_plan->output_variables[column]);
  }
  plan.child_plans.push_back(std::move(*left_plan));
  plan.child_plans.push_back(std::move(*right_plan));

  if (plan.output_variables.size() != plan.result_width) {
    return std::nullopt;
  }
  return plan;
}
#endif

#if XPOD_QLEVER_HAS_MULTI_COLUMN_JOIN
inline std::optional<BridgeQueryPlan> planMultiColumnJoinOperation(
    MultiColumnJoin& operation) {
  std::vector<QueryExecutionTree*> children = operation.getChildren();
  if (children.size() != 2 || children[0] == nullptr ||
      children[1] == nullptr) {
    return std::nullopt;
  }

  auto left_plan = planQleverExecutionTree(*children[0]);
  auto right_plan = planQleverExecutionTree(*children[1]);
  if (!left_plan.has_value() || !right_plan.has_value()) {
    return std::nullopt;
  }

  BridgeQueryPlan plan;
  plan.descriptor = operation.getDescriptor();
  plan.result_width = operation.getResultWidth();
  plan.sorted_by = operation.getResultSortedOn();
  plan.root.kind = BridgeOperationKind::MultiColumnJoin;
  plan.root.sorted_by = plan.sorted_by;
  plan.output_variables = left_plan->output_variables;
  plan.root.matched_columns = matchedOutputVariableColumns(
      left_plan->output_variables, right_plan->output_variables);
  if (plan.root.matched_columns.empty()) {
    return std::nullopt;
  }
  plan.root.right_projection_columns = rightProjectionColumns(
      left_plan->output_variables, right_plan->output_variables);
  for (size_t column : plan.root.right_projection_columns) {
    if (column >= right_plan->output_variables.size()) {
      return std::nullopt;
    }
    plan.output_variables.push_back(right_plan->output_variables[column]);
  }
  plan.child_plans.push_back(std::move(*left_plan));
  plan.child_plans.push_back(std::move(*right_plan));

  if (plan.output_variables.size() != plan.result_width) {
    return std::nullopt;
  }
  return plan;
}
#endif

#if XPOD_QLEVER_HAS_EXISTS_JOIN
inline std::optional<BridgeQueryPlan> planExistsJoinOperation(
    ExistsJoin& operation) {
  std::vector<QueryExecutionTree*> children = operation.getChildren();
  if (children.size() != 2 || children[0] == nullptr ||
      children[1] == nullptr) {
    return std::nullopt;
  }

  auto left_plan = planQleverExecutionTree(*children[0]);
  auto right_plan = planQleverExecutionTree(*children[1]);
  if (!left_plan.has_value() || !right_plan.has_value()) {
    return std::nullopt;
  }
  auto output_variables = visibleOutputVariablesFromOperation(operation);
  if (!output_variables.has_value()) {
    return std::nullopt;
  }

  BridgeQueryPlan plan;
  plan.descriptor = operation.getDescriptor();
  plan.result_width = operation.getResultWidth();
  plan.sorted_by = operation.getResultSortedOn();
  plan.output_variables = std::move(*output_variables);
  plan.root.kind = BridgeOperationKind::ExistsJoin;
  plan.root.sorted_by = plan.sorted_by;
  plan.root.native_result_only = true;
  plan.child_plans.push_back(std::move(*left_plan));
  plan.child_plans.push_back(std::move(*right_plan));
  return plan;
}
#endif

#if XPOD_QLEVER_HAS_HAS_PREDICATE_SCAN
inline std::optional<BridgeQueryPlan> planHasPredicateScanOperation(
    const HasPredicateScan& operation) {
  BridgeQueryPlan plan;
  plan.descriptor = operation.getDescriptor();
  plan.result_width = operation.getResultWidth();
  plan.sorted_by = operation.getResultSortedOn();
  plan.output_variables =
      visibleOutputVariablesFromOperation(operation).value_or(
          std::vector<std::string>{});
  if (plan.output_variables.size() != plan.result_width) {
    return std::nullopt;
  }
  plan.root.kind = BridgeOperationKind::HasPredicateScan;
  plan.root.sorted_by = plan.sorted_by;
  plan.root.native_result_only = true;
  return plan;
}
#endif

#if XPOD_QLEVER_HAS_TRANSITIVE_PATH
inline std::optional<BridgeQueryPlan> planTransitivePathOperation(
    TransitivePathBase& operation) {
  std::vector<QueryExecutionTree*> children = operation.getChildren();

  BridgeQueryPlan plan;
  plan.descriptor = operation.getDescriptor();
  plan.result_width = operation.getResultWidth();
  plan.sorted_by = operation.getResultSortedOn();
  plan.output_variables.reserve(plan.result_width);
  for (size_t column = 0; column < plan.result_width; ++column) {
    plan.output_variables.push_back(
        "__xpod_qlever_internal_" + std::to_string(column));
  }
  const auto& variable_columns =
      operation.getExternallyVisibleVariableColumns();
  for (const auto& [variable, info] : variable_columns) {
    if (info.columnIndex_ >= plan.output_variables.size()) {
      return std::nullopt;
    }
    plan.output_variables[info.columnIndex_] = bridgeVariableName(variable);
  }
  plan.root.kind = BridgeOperationKind::TransitivePath;
  plan.root.sorted_by = plan.sorted_by;
  plan.root.native_result_only = true;

  for (QueryExecutionTree* child : children) {
    if (child == nullptr) {
      return std::nullopt;
    }
    auto child_plan = planQleverExecutionTree(*child);
    if (!child_plan.has_value()) {
      return std::nullopt;
    }
    plan.child_plans.push_back(std::move(*child_plan));
  }
  return plan;
}
#endif

#if XPOD_QLEVER_HAS_GROUP_BY
template <typename AliasT, typename = void>
struct HasAliasTargetName : std::false_type {};

template <typename AliasT>
struct HasAliasTargetName<
    AliasT,
    std::void_t<decltype(std::declval<const AliasT&>()._target.name())>>
    : std::true_type {};

template <typename AliasT,
          typename std::enable_if<HasAliasTargetName<AliasT>::value, int>::type = 0>
inline std::optional<std::string> aliasTargetVariableNameImpl(
    const AliasT& alias) {
  return bridgeVariableName(alias._target);
}

template <typename AliasT,
          typename std::enable_if<!HasAliasTargetName<AliasT>::value, int>::type = 0>
inline std::optional<std::string> aliasTargetVariableNameImpl(
    const AliasT&) {
  return std::nullopt;
}

inline std::optional<std::string> aliasTargetVariableName(const Alias& alias) {
  return aliasTargetVariableNameImpl(alias);
}

inline std::optional<BridgeQueryPlan> planGroupByOperation(
    GroupBy& operation) {
  std::vector<QueryExecutionTree*> children = operation.getChildren();
  if (children.size() != 1 || children[0] == nullptr) {
    return std::nullopt;
  }
  auto child_plan = planQleverExecutionTree(*children[0]);
  if (!child_plan.has_value()) {
    return std::nullopt;
  }

  BridgeQueryPlan plan;
  plan.descriptor = operation.getDescriptor();
  plan.result_width = operation.getResultWidth();
  plan.sorted_by = operation.getResultSortedOn();
  plan.root.kind = BridgeOperationKind::GroupBy;
  plan.root.sorted_by = plan.sorted_by;

  const std::vector<Variable>& variables = operation.groupByVariables();
  const std::vector<Alias>& aliases = operation.aliases();
  if ((variables.empty() && aliases.empty()) ||
      plan.result_width != variables.size() + aliases.size()) {
    return std::nullopt;
  }
  plan.output_variables.reserve(variables.size() + aliases.size());
  plan.root.projection_columns.reserve(variables.size());
  for (const Variable& variable : variables) {
    std::string name = bridgeVariableName(variable);
    auto column = outputColumnForVariable(child_plan->output_variables, name);
    if (!column.has_value()) {
      return std::nullopt;
    }
    plan.output_variables.push_back(std::move(name));
    plan.root.projection_columns.push_back(*column);
  }
  for (const Alias& alias : aliases) {
    std::optional<std::string> name = aliasTargetVariableName(alias);
    if (!name.has_value()) {
      return std::nullopt;
    }
    plan.output_variables.push_back(std::move(*name));
  }
  if (!aliases.empty()) {
    plan.root.native_result_only = true;
  }

  plan.child_plans.push_back(std::move(*child_plan));
  return plan;
}
#endif

inline std::optional<BridgeQueryPlan> planQleverOperation(
    const Operation& operation) {
#if XPOD_QLEVER_HAS_DESCRIBE
  auto* describe = dynamic_cast<Describe*>(const_cast<Operation*>(&operation));
  if (describe != nullptr) {
    return planDescribeOperation(*describe);
  }
#endif
#if XPOD_QLEVER_HAS_NEUTRAL_ELEMENT
  const auto* neutral =
      dynamic_cast<const NeutralElementOperation*>(&operation);
  if (neutral != nullptr) {
    return planNeutralElementOperation(*neutral);
  }
#endif
#if XPOD_QLEVER_HAS_UNION
  const auto* union_operation = dynamic_cast<const Union*>(&operation);
  if (union_operation != nullptr) {
    return planUnionOperation(*union_operation);
  }
#endif
#if XPOD_QLEVER_HAS_CARTESIAN_PRODUCT_JOIN
  auto* cartesian = dynamic_cast<CartesianProductJoin*>(
      const_cast<Operation*>(&operation));
  if (cartesian != nullptr) {
    return planCartesianProductJoinOperation(*cartesian);
  }
#endif
#if XPOD_QLEVER_HAS_MINUS
  auto* minus = dynamic_cast<Minus*>(const_cast<Operation*>(&operation));
  if (minus != nullptr) {
    return planMinusOperation(*minus);
  }
#endif
#if XPOD_QLEVER_HAS_OPTIONAL_JOIN
  auto* optional_join =
      dynamic_cast<OptionalJoin*>(const_cast<Operation*>(&operation));
  if (optional_join != nullptr) {
    return planOptionalJoinOperation(*optional_join);
  }
#endif
#if XPOD_QLEVER_HAS_MULTI_COLUMN_JOIN
  auto* multi_column_join =
      dynamic_cast<MultiColumnJoin*>(const_cast<Operation*>(&operation));
  if (multi_column_join != nullptr) {
    return planMultiColumnJoinOperation(*multi_column_join);
  }
#endif
#if XPOD_QLEVER_HAS_EXISTS_JOIN
  auto* exists_join =
      dynamic_cast<ExistsJoin*>(const_cast<Operation*>(&operation));
  if (exists_join != nullptr) {
    return planExistsJoinOperation(*exists_join);
  }
#endif
#if XPOD_QLEVER_HAS_GROUP_BY
  auto* group_by = dynamic_cast<GroupBy*>(const_cast<Operation*>(&operation));
  if (group_by != nullptr) {
    return planGroupByOperation(*group_by);
  }
#endif
#if XPOD_QLEVER_HAS_HAS_PREDICATE_SCAN
  const auto* has_predicate =
      dynamic_cast<const HasPredicateScan*>(&operation);
  if (has_predicate != nullptr) {
    return planHasPredicateScanOperation(*has_predicate);
  }
#endif
#if XPOD_QLEVER_HAS_TRANSITIVE_PATH
  auto* transitive_path =
      dynamic_cast<TransitivePathBase*>(const_cast<Operation*>(&operation));
  if (transitive_path != nullptr) {
    return planTransitivePathOperation(*transitive_path);
  }
#endif
#if XPOD_QLEVER_HAS_LIMIT_OFFSET
  const auto* limit_offset = dynamic_cast<const LimitOffset*>(&operation);
  if (limit_offset != nullptr) {
    return planLimitOffsetOperation(*limit_offset);
  }
#endif
#if XPOD_QLEVER_HAS_TEXT_LIMIT
  const auto* text_limit = dynamic_cast<const TextLimit*>(&operation);
  if (text_limit != nullptr) {
    return planTextLimitOperation(*text_limit);
  }
#endif
#if XPOD_QLEVER_HAS_SORT
  const auto* sort = dynamic_cast<const Sort*>(&operation);
  if (sort != nullptr) {
    return planSortOperation(*sort);
  }
#endif
#if XPOD_QLEVER_HAS_VALUES
  const auto* values = dynamic_cast<const Values*>(&operation);
  if (values != nullptr) {
    return planValuesOperation(*values);
  }
#endif
#if XPOD_QLEVER_HAS_ORDER_BY
  const auto* order_by = dynamic_cast<const OrderBy*>(&operation);
  if (order_by != nullptr) {
    return planOrderByOperation(*order_by);
  }
#endif
#if XPOD_QLEVER_HAS_DISTINCT
  const auto* distinct = dynamic_cast<const Distinct*>(&operation);
  if (distinct != nullptr) {
    return planDistinctOperation(*distinct);
  }
#endif
#if XPOD_QLEVER_HAS_FILTER
  auto* filter = dynamic_cast<Filter*>(const_cast<Operation*>(&operation));
  if (filter != nullptr) {
    return planFilterOperation(*filter);
  }
#endif
#if XPOD_QLEVER_HAS_BIND
  auto* bind = dynamic_cast<Bind*>(const_cast<Operation*>(&operation));
  if (bind != nullptr) {
    return planBindOperation(*bind);
  }
#endif
#if XPOD_QLEVER_HAS_TEXT_INDEX_SCAN_FOR_WORD
  const auto* text_scan = dynamic_cast<const TextIndexScanForWord*>(&operation);
  if (text_scan != nullptr) {
    return planTextIndexScanForWordOperation(*text_scan);
  }
#endif
#if XPOD_QLEVER_HAS_TEXT_INDEX_SCAN_FOR_ENTITY
  const auto* entity_scan =
      dynamic_cast<const TextIndexScanForEntity*>(&operation);
  if (entity_scan != nullptr) {
    return planTextIndexScanForEntityOperation(*entity_scan);
  }
#endif
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

inline std::optional<BridgeQueryPlan> planNativeQleverResultTree(
    const QueryExecutionTree& tree) {
  if (tree.isEmpty()) {
    return std::nullopt;
  }
  auto operation = tree.getRootOperation();
  if (operation == nullptr) {
    return std::nullopt;
  }
  auto output_variables = visibleOutputVariablesFromOperation(*operation);
  if (!output_variables.has_value()) {
    return std::nullopt;
  }
  BridgeQueryPlan plan;
  plan.descriptor = operation->getDescriptor();
  plan.result_width = operation->getResultWidth();
  plan.output_variables = std::move(*output_variables);
  plan.sorted_by = operation->getResultSortedOn();
  plan.root.kind = BridgeOperationKind::NativeQleverTree;
  plan.root.native_result_only = true;
  return plan;
}

inline bool applySelectedProjectionModifier(
    BridgeQueryPlan& plan,
    const ParsedQuery& parsed) {
  std::optional<std::vector<std::string>> selected =
      selectedVariablesFromParsedQuery(parsed);
  if (!selected.has_value()) {
    return true;
  }

  BridgeResultModifier modifier;
  modifier.kind = BridgeResultModifierKind::Project;
  modifier.columns.reserve(selected->size());
  for (const std::string& variable : *selected) {
    std::optional<ColumnIndex> column =
        outputColumnForVariable(plan.output_variables, variable);
    if (!column.has_value()) {
      return false;
    }
    modifier.columns.push_back(*column);
  }

  bool identity_projection =
      modifier.columns.size() == plan.output_variables.size();
  if (identity_projection) {
    for (size_t column = 0; column < modifier.columns.size(); ++column) {
      if (modifier.columns[column] != column) {
        identity_projection = false;
        break;
      }
    }
  }
  plan.output_variables = std::move(*selected);
  plan.result_width = plan.output_variables.size();
  if (!identity_projection) {
    plan.root.result_modifiers.push_back(std::move(modifier));
  }
  return true;
}

inline std::optional<BridgeQueryPlan> planQleverParsedQueryWithPlanner(
    QueryPlanner& planner,
    ParsedQuery& parsed) {
  QueryExecutionTree tree = planner.createExecutionTree(parsed);
  std::optional<BridgeQueryPlan> plan = planQleverExecutionTree(tree);
  if (!plan.has_value()) {
    return std::nullopt;
  }
  if (!applySelectedProjectionModifier(*plan, parsed)) {
    return std::nullopt;
  }
  return plan;
}

namespace detail {

#if XPOD_QLEVER_HAS_CANCELLATION_HANDLE
inline bool isXpodCancellationRequested(
    const xpod_rdf_cancellation* cancellation) noexcept {
  return cancellation != nullptr && cancellation->is_cancelled != nullptr &&
         cancellation->is_cancelled(cancellation->cancellation_user_data) != 0;
}

template <typename Handle>
auto cancelQleverHandle(Handle& handle, int)
    -> decltype(handle->cancel(), void()) {
  if (handle != nullptr) {
    handle->cancel();
  }
}

template <typename Handle>
void cancelQleverHandle(Handle&, long) {}

template <typename Handle, typename = void>
struct QleverCancellationHandleFactory {
  static Handle make(const xpod_rdf_cancellation*) {
    return Handle{};
  }
};

template <typename Handle>
struct QleverCancellationHandleFactory<
    Handle,
    std::void_t<typename Handle::element_type>> {
  static Handle make(const xpod_rdf_cancellation* cancellation) {
    auto handle = std::make_shared<typename Handle::element_type>();
    if (isXpodCancellationRequested(cancellation)) {
      cancelQleverHandle(handle, 0);
    }
    return handle;
  }
};

inline ad_utility::SharedCancellationHandle makeQleverCancellationHandle(
    const xpod_rdf_cancellation* cancellation) {
  return QleverCancellationHandleFactory<
      ad_utility::SharedCancellationHandle>::make(cancellation);
}

template <typename Planner, bool IsNativeContextConstructible =
                                std::is_constructible<
                                    Planner,
                                    const PlannerRequestContext*,
                                    ad_utility::SharedCancellationHandle>::value>
struct NativeContextQueryPlannerBridge {
  static std::optional<BridgeQueryPlan> plan(
      const PlannerRequestContext* context,
      ParsedQuery& parsed) {
    (void)context;
    (void)parsed;
    return std::nullopt;
  }
};

template <typename Planner>
struct NativeContextQueryPlannerBridge<Planner, true> {
  static std::optional<BridgeQueryPlan> plan(
      const PlannerRequestContext* context,
      ParsedQuery& parsed) {
    if (context == nullptr) {
      return std::nullopt;
    }
    Planner planner(
        context, makeQleverCancellationHandle(
                     context->cancellation));
    return planQleverParsedQueryWithPlanner(planner, parsed);
  }
};

template <typename Planner, bool IsContextConstructible =
                                std::is_constructible<
                                    Planner,
                                    QueryExecutionContext*,
                                    ad_utility::SharedCancellationHandle>::value>
struct ContextQueryPlannerBridge {
  static std::optional<BridgeQueryPlan> plan(
      QueryExecutionContext* qec,
      ParsedQuery& parsed) {
    (void)qec;
    (void)parsed;
    return std::nullopt;
  }
};

template <typename Planner>
struct ContextQueryPlannerBridge<Planner, true> {
  static std::optional<BridgeQueryPlan> plan(
      QueryExecutionContext* qec,
      ParsedQuery& parsed) {
    Planner planner(qec, makeQleverCancellationHandle(nullptr));
    return planQleverParsedQueryWithPlanner(planner, parsed);
  }
};
#endif

template <typename Planner, bool IsDefaultConstructible =
                                std::is_default_constructible<Planner>::value>
struct DefaultQueryPlannerBridge {
  static std::optional<BridgeQueryPlan> plan(ParsedQuery& parsed) {
    (void)parsed;
    return std::nullopt;
  }
};

template <typename Planner>
struct DefaultQueryPlannerBridge<Planner, true> {
  static std::optional<BridgeQueryPlan> plan(ParsedQuery& parsed) {
    Planner planner;
    return planQleverParsedQueryWithPlanner(planner, parsed);
  }
};

}  // namespace detail

inline std::optional<BridgeQueryPlan> planQleverParsedQueryWithContext(
    QueryExecutionContext* qec,
    ParsedQuery& parsed) {
  if (!parsed.hasSelectClause()) {
    return std::nullopt;
  }
  if (qec == nullptr) {
    return std::nullopt;
  }
#if XPOD_QLEVER_HAS_CANCELLATION_HANDLE
  return detail::ContextQueryPlannerBridge<QueryPlanner>::plan(qec, parsed);
#else
  (void)qec;
  (void)parsed;
  return std::nullopt;
#endif
}

inline std::optional<BridgeQueryPlan> planQleverParsedQueryWithAvailablePlanner(
    PlannerContextHandle context,
    ParsedQuery& parsed) {
  if (!parsed.hasSelectClause()) {
    return std::nullopt;
  }
#if XPOD_QLEVER_HAS_CANCELLATION_HANDLE
  if (context.native != nullptr) {
    auto native_plan =
        detail::NativeContextQueryPlannerBridge<QueryPlanner>::plan(
            context.native, parsed);
    if (native_plan.has_value()) {
      return native_plan;
    }
  }
#endif
  if (context.qec != nullptr) {
    return planQleverParsedQueryWithContext(context.qec, parsed);
  }
  return detail::DefaultQueryPlannerBridge<QueryPlanner>::plan(parsed);
}

inline std::optional<BridgeQueryPlan> planQleverParsedQueryWithAvailablePlanner(
    QueryExecutionContext* qec,
    ParsedQuery& parsed) {
  return planQleverParsedQueryWithAvailablePlanner({qec, nullptr}, parsed);
}

}  // namespace xpod::qlever
#endif

#endif
