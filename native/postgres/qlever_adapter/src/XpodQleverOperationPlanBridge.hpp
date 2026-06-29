#ifndef XPOD_QLEVER_OPERATION_PLAN_BRIDGE_HPP
#define XPOD_QLEVER_OPERATION_PLAN_BRIDGE_HPP

#include "XpodQleverPlanBridge.hpp"
#include "XpodQleverPlannerRequestContext.hpp"

#include <array>
#include <optional>
#include <string_view>
#include <type_traits>
#include <utility>

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

inline bool bindIndexScanComponent(
    const TripleComponent& component,
    uint32_t slot,
    BridgeQueryPlan& plan) {
  if (component.isVariable()) {
    return true;
  }
  return bindableComponent(component, std::string_view{}, slot, plan);
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
  std::vector<std::string> output_variables;
  output_variables.reserve(scan.getResultWidth());
  for (char slot : indexScanPermutationSlots(scan.permutation().permutation())) {
    appendIndexScanOutputVariable(output_variables, slot, scan);
  }
  return output_variables;
}

inline void initializeIndexScanOperationPlan(
    BridgeQueryPlan& plan,
    const IndexScan& scan) {
  plan.scan.permutation = scan.permutation().permutation();
  plan.scan.needed_slots = 0;
  if (scan.subject().isVariable()) {
    plan.scan.needed_slots |= XPOD_RDF_SLOT_SUBJECT;
  }
  if (scan.predicate().isVariable()) {
    plan.scan.needed_slots |= XPOD_RDF_SLOT_PREDICATE;
  }
  if (scan.object().isVariable()) {
    plan.scan.needed_slots |= XPOD_RDF_SLOT_OBJECT;
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
      !bindIndexScanComponent(scan.object(), XPOD_RDF_SLOT_OBJECT, plan)) {
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
  BridgeQueryPlan plan;
  BridgeTextCandidateSource source;
  source.setQuery(scan.word());
  source.descriptor = scan.getDescriptor();
  appendTextCandidateOutput(
      plan, source, scan.textRecordVar(),
      BridgeCandidateColumnKind::RetrievalPoint);
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

  index_plan->text_sources = std::move(text_plan->text_sources);
  index_plan->text_required_entities =
      std::move(text_plan->text_required_entities);
  index_plan->descriptor = descriptor;
  index_plan->filter_scans.clear();
  index_plan->root.kind = BridgeOperationKind::HashJoin;
  index_plan->root.use_candidate_join = true;
  index_plan->root.candidate_index = 0;
  index_plan->root.candidate_join_column =
      BridgeCandidateColumnKind::ResourceTerm;
  index_plan->root.scan_indexes = {0};
  index_plan->root.join_slot = *join_slot;
  index_plan->root.join_slots = {*join_slot};
  return index_plan;
}

inline std::optional<BridgeQueryPlan> planTextJoinOperation(
    const Join& join) {
  std::vector<const QueryExecutionTree*> children = join.getChildren();
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
  std::vector<const QueryExecutionTree*> children = join->getChildren();
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

inline std::optional<BridgeQueryPlan> planJoinOperation(const Join& join) {
#if XPOD_QLEVER_HAS_TEXT_INDEX_SCAN_FOR_WORD && \
    XPOD_QLEVER_HAS_TEXT_INDEX_SCAN_FOR_ENTITY
  auto text_plan = planTextJoinOperation(join);
  if (text_plan.has_value()) {
    return text_plan;
  }
#endif
  std::vector<const QueryExecutionTree*> children = join.getChildren();
  if (children.size() != 2) {
    return std::nullopt;
  }
  std::vector<const IndexScan*> scans;
  if (!collectIndexScanLeaves(children[0], scans) ||
      !collectIndexScanLeaves(children[1], scans)) {
    return std::nullopt;
  }
  auto join_slots = inferCommonVariableJoinSlots(scans);
  if (!join_slots.has_value()) {
    return std::nullopt;
  }

  auto left_plan = planIndexScanOperation(*scans.front());
  if (!left_plan.has_value()) {
    return std::nullopt;
  }

  left_plan->filter_scans.clear();
  left_plan->root.scan_indexes = {0};
  for (size_t i = 1; i < scans.size(); ++i) {
    auto right_plan = planIndexScanOperation(*scans[i]);
    if (!right_plan.has_value()) {
      return std::nullopt;
    }
    BridgeFilterScan filter;
    filter.scan = right_plan->scan;
    filter.term_bindings = std::move(right_plan->term_bindings);
    filter.join_slot = (*join_slots)[i];
    filter.descriptor = right_plan->descriptor;
    left_plan->filter_scans.push_back(std::move(filter));
    left_plan->root.scan_indexes.push_back(i);
  }
  left_plan->descriptor = join.getDescriptor();
  left_plan->root.kind = BridgeOperationKind::HashJoin;
  left_plan->root.join_slot = join_slots->front();
  left_plan->root.join_slots = *join_slots;
  return left_plan;
}

inline std::optional<BridgeQueryPlan> planQleverOperation(
    const Operation& operation) {
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

inline std::optional<BridgeQueryPlan> planQleverParsedQueryWithPlanner(
    QueryPlanner& planner,
    ParsedQuery& parsed) {
  QueryExecutionTree tree = planner.createExecutionTree(parsed);
  return planQleverExecutionTree(tree);
}

namespace detail {

#if XPOD_QLEVER_HAS_CANCELLATION_HANDLE
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
    Planner planner(context, ad_utility::SharedCancellationHandle{});
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
    Planner planner(qec, ad_utility::SharedCancellationHandle{});
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
