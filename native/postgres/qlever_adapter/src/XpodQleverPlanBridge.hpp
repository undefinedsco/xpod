#ifndef XPOD_QLEVER_PLAN_BRIDGE_HPP
#define XPOD_QLEVER_PLAN_BRIDGE_HPP

#include "XpodQleverOperationBridge.hpp"
#include "XpodQleverScanBridge.hpp"
#include "xpod_rdf_physical_backend.h"

#include <cctype>
#include <optional>
#include <iterator>
#include <string>
#include <string_view>
#include <utility>
#include <variant>
#include <vector>

#if XPOD_QLEVER_ADAPTER_ENABLE_QLEVER
#include "global/Id.h"
#include "parser/ParsedQuery.h"
#include "parser/SparqlTriple.h"

namespace xpod::qlever {

struct BridgeTermBinding {
  uint32_t slot = 0;
  xpod_rdf_term_kind kind = XPOD_RDF_TERM_IRI;
  std::string value;
  std::string datatype_iri;
  std::string language;
  bool is_prefix = false;
};

struct BridgeTextRequiredEntityBinding {
  size_t text_source_index = 0;
  BridgeTermBinding term;
};

struct BridgeModifierTermBinding {
  size_t modifier_index = 0;
  BridgeTermBinding term;
};

struct BridgeGraphScope {
  std::optional<BridgeTermBinding> binding;
  std::optional<std::string> variable;
};

struct BridgeFilterScan {
  ScanRequestInput scan;
  std::vector<BridgeTermBinding> term_bindings;
  uint32_t join_slot = XPOD_RDF_SLOT_SUBJECT;
  std::string descriptor;
  bool known_empty = false;
};

struct BridgeQueryPlan {
  ScanRequestInput scan;
  std::vector<ColumnIndex> sorted_by;
  size_t result_width = 0;
  std::string descriptor;
  std::vector<BridgeTermBinding> term_bindings;
  std::vector<BridgeFilterScan> filter_scans;
  std::vector<BridgeTextCandidateSource> text_sources;
  std::vector<BridgeVectorCandidateSource> vector_sources;
  std::vector<BridgeTextRequiredEntityBinding> text_required_entities;
  std::vector<std::vector<BridgeTermBinding>> value_rows;
  std::vector<BridgeModifierTermBinding> modifier_term_bindings;
  std::vector<std::string> output_variables;
  std::vector<BridgeQueryPlan> child_plans;
  BridgeOperationPlan root;
  bool known_empty = false;
};

inline std::string iriValueFromComponent(const TripleComponent& component) {
  std::string iri = std::string(component.getIri().toStringRepresentation());
  if (iri.size() >= 2 && iri.front() == '<' && iri.back() == '>') {
    return iri.substr(1, iri.size() - 2);
  }
  return iri;
}

inline std::string iriValueFromIri(const TripleComponent::Iri& component) {
  std::string iri = std::string(component.toStringRepresentation());
  if (iri.size() >= 2 && iri.front() == '<' && iri.back() == '>') {
    return iri.substr(1, iri.size() - 2);
  }
  return iri;
}

inline std::optional<BridgeTermBinding> literalBindingFromComponent(
    const TripleComponent& component,
    uint32_t slot) {
  std::string literal =
      std::string(component.getLiteral().toStringRepresentation());
  BridgeTermBinding binding;
  binding.slot = slot;
  binding.kind = XPOD_RDF_TERM_LITERAL;

  if (literal.empty() || literal.front() != '"') {
    binding.value = std::move(literal);
    return binding;
  }

  size_t end = 1;
  bool escaped = false;
  for (; end < literal.size(); ++end) {
    char c = literal[end];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (c == '\\') {
      escaped = true;
      continue;
    }
    if (c == '"') {
      break;
    }
  }
  if (end >= literal.size()) {
    return std::nullopt;
  }

  binding.value = literal.substr(1, end - 1);
  std::string_view suffix(literal.data() + end + 1, literal.size() - end - 1);
  if (!suffix.empty() && suffix.front() == '@') {
    binding.language = std::string(suffix.substr(1));
  } else if (suffix.size() >= 4 && suffix.substr(0, 3) == "^^<" &&
             suffix.back() == '>') {
    binding.datatype_iri = std::string(suffix.substr(3, suffix.size() - 4));
  }
  return binding;
}

inline std::optional<BridgeTermBinding> termBindingFromValuesComponent(
    const TripleComponent& component) {
  if (component.isIri()) {
    BridgeTermBinding binding;
    binding.kind = XPOD_RDF_TERM_IRI;
    binding.value = iriValueFromComponent(component);
    return binding;
  }
  if (component.isLiteral()) {
    auto binding = literalBindingFromComponent(
        component, XPOD_RDF_SLOT_SUBJECT);
    if (!binding.has_value()) {
      return std::nullopt;
    }
    binding->slot = 0;
    return binding;
  }
  return std::nullopt;
}

inline bool bindableComponent(
    const TripleComponent& component,
    std::string_view expected_variable,
    uint32_t slot,
    BridgeQueryPlan& plan) {
  if (component.isVariable()) {
    return component.getVariable().name() == expected_variable;
  }
  if (component.isIri()) {
    BridgeTermBinding binding;
    binding.slot = slot;
    binding.kind = XPOD_RDF_TERM_IRI;
    binding.value = iriValueFromComponent(component);
    plan.term_bindings.push_back(std::move(binding));
    return true;
  }
  if (component.isLiteral()) {
    auto binding = literalBindingFromComponent(component, slot);
    if (!binding.has_value()) {
      return false;
    }
    plan.term_bindings.push_back(std::move(*binding));
    return true;
  }
  return false;
}

inline bool bindableAnyComponent(
    const TripleComponent& component,
    uint32_t slot,
    BridgeQueryPlan& plan) {
  if (component.isVariable()) {
    return true;
  }
  if (component.isIri()) {
    BridgeTermBinding binding;
    binding.slot = slot;
    binding.kind = XPOD_RDF_TERM_IRI;
    binding.value = iriValueFromComponent(component);
    plan.term_bindings.push_back(std::move(binding));
    return true;
  }
  if (component.isLiteral()) {
    auto binding = literalBindingFromComponent(component, slot);
    if (!binding.has_value()) {
      return false;
    }
    plan.term_bindings.push_back(std::move(*binding));
    return true;
  }
  return false;
}

inline xpod_rdf_term toNativeTerm(const BridgeTermBinding& binding) noexcept {
  xpod_rdf_term term = {};
  term.kind = binding.kind;
  term.value = {binding.value.data(), binding.value.size()};
  term.datatype_iri = {binding.datatype_iri.data(), binding.datatype_iri.size()};
  term.language = {binding.language.data(), binding.language.size()};
  return term;
}

inline void bindPatternSlot(
    TripleKeyPattern& pattern,
    uint32_t slot,
    xpod_rdf_term_key key) noexcept {
  if (slot == XPOD_RDF_SLOT_SUBJECT) {
    pattern.has_subject = true;
    pattern.subject = key;
  } else if (slot == XPOD_RDF_SLOT_PREDICATE) {
    pattern.has_predicate = true;
    pattern.predicate = key;
  } else if (slot == XPOD_RDF_SLOT_OBJECT) {
    pattern.has_object = true;
    pattern.object = key;
  } else if (slot == XPOD_RDF_SLOT_GRAPH) {
    pattern.has_graph = true;
    pattern.graph = key;
  }
}

struct BridgePrefixRangeState {
  std::vector<xpod_rdf_slot_term_range>* slot_ranges = nullptr;
  uint32_t slot = 0;
};

inline xpod_rdf_status appendBridgePrefixRanges(
    void* callback_user_data,
    const xpod_rdf_term_range_batch* batch) {
  if (callback_user_data == nullptr || batch == nullptr) {
    return XPOD_RDF_STATUS_BACKEND_ERROR;
  }
  BridgePrefixRangeState* state =
      static_cast<BridgePrefixRangeState*>(callback_user_data);
  for (size_t i = 0; i < batch->range_count; ++i) {
    xpod_rdf_slot_term_range slot_range = {};
    slot_range.slot = state->slot;
    slot_range.range = batch->ranges[i];
    slot_range.collation = batch->collation;
    state->slot_ranges->push_back(slot_range);
  }
  return XPOD_RDF_STATUS_OK;
}

inline xpod_rdf_status bindPrefixTermBinding(
    const xpod::rdf::PhysicalBackend& backend,
    const xpod_rdf_snapshot& snapshot,
    const BridgeTermBinding& binding,
    std::vector<xpod_rdf_slot_term_range>& slot_ranges,
    bool& known_empty,
    std::string& error_storage) {
  xpod_rdf_prefix_range_request request = {};
  request.snapshot = snapshot;
  request.prefix = {binding.value.data(), binding.value.size()};
  request.kind = binding.kind;
  request.has_kind = 1;
  BridgePrefixRangeState state{&slot_ranges, binding.slot};
  const size_t before = slot_ranges.size();
  xpod_rdf_term_collation collation = XPOD_RDF_TERM_COLLATION_UNKNOWN;
  xpod_rdf_status status = backend.prefixRange(
      request, appendBridgePrefixRanges, &state, collation);
  if (status != XPOD_RDF_STATUS_OK) {
    error_storage = "failed to resolve QLever bridge prefix range";
    return status;
  }
  if (slot_ranges.size() == before) {
    known_empty = true;
  }
  return XPOD_RDF_STATUS_OK;
}

inline xpod_rdf_status bindTermBindings(
    const xpod::rdf::PhysicalBackend& backend,
    const xpod_rdf_snapshot& snapshot,
    const std::vector<BridgeTermBinding>& bindings,
    TripleKeyPattern& pattern,
    std::vector<xpod_rdf_slot_term_range>& slot_ranges,
    bool& known_empty,
    std::string& error_storage) {
  if (bindings.empty()) {
    return XPOD_RDF_STATUS_OK;
  }

  std::vector<xpod_rdf_term> terms;
  std::vector<const BridgeTermBinding*> exact_bindings;
  terms.reserve(bindings.size());
  exact_bindings.reserve(bindings.size());
  for (const BridgeTermBinding& binding : bindings) {
    if (binding.is_prefix) {
      continue;
    }
    terms.push_back(toNativeTerm(binding));
    exact_bindings.push_back(&binding);
  }

  if (!terms.empty()) {
    std::vector<xpod_rdf_term_key> keys(terms.size());
    std::vector<xpod_rdf_status> statuses(terms.size());
    xpod_rdf_status status = backend.lookupTerms(
        terms.data(), terms.size(), snapshot, keys.data(), statuses.data());
    if (status != XPOD_RDF_STATUS_OK) {
      error_storage = "failed to lookup QLever bridge constants";
      return status;
    }

    for (size_t i = 0; i < statuses.size(); ++i) {
      if (statuses[i] == XPOD_RDF_STATUS_NOT_FOUND) {
        known_empty = true;
        return XPOD_RDF_STATUS_OK;
      }
      if (statuses[i] != XPOD_RDF_STATUS_OK) {
        error_storage = "failed to lookup one or more QLever bridge constants";
        return statuses[i];
      }
      bindPatternSlot(pattern, exact_bindings[i]->slot, keys[i]);
    }
  }

  for (const BridgeTermBinding& binding : bindings) {
    if (!binding.is_prefix) {
      continue;
    }
    xpod_rdf_status status = bindPrefixTermBinding(
        backend, snapshot, binding, slot_ranges, known_empty, error_storage);
    if (status != XPOD_RDF_STATUS_OK || known_empty) {
      return status;
    }
  }
  return XPOD_RDF_STATUS_OK;
}

inline std::string bridgeVariableName(const Variable& variable) {
  std::string name = variable.name();
  if (!name.empty() && name.front() == '?') {
    name.erase(name.begin());
  }
  return name;
}

inline std::string bridgeComponentVariableName(
    const TripleComponent& component) {
  return bridgeVariableName(component.getVariable());
}

inline bool containsOutputVariable(
    const std::vector<std::string>& variables,
    const std::string& variable) {
  for (const std::string& existing : variables) {
    if (existing == variable) {
      return true;
    }
  }
  return false;
}

inline std::vector<std::array<size_t, 2>> matchedOutputVariableColumns(
    const std::vector<std::string>& left_variables,
    const std::vector<std::string>& right_variables) {
  std::vector<std::array<size_t, 2>> matched_columns;
  for (size_t left_column = 0; left_column < left_variables.size();
       ++left_column) {
    for (size_t right_column = 0; right_column < right_variables.size();
         ++right_column) {
      if (left_variables[left_column] == right_variables[right_column]) {
        matched_columns.push_back({left_column, right_column});
        break;
      }
    }
  }
  return matched_columns;
}

inline std::vector<size_t> rightProjectionColumns(
    const std::vector<std::string>& left_variables,
    const std::vector<std::string>& right_variables) {
  std::vector<size_t> projection_columns;
  for (size_t right_column = 0; right_column < right_variables.size();
       ++right_column) {
    if (!containsOutputVariable(left_variables, right_variables[right_column])) {
      projection_columns.push_back(right_column);
    }
  }
  return projection_columns;
}

inline std::optional<ColumnIndex> outputColumnForVariable(
    const std::vector<std::string>& variables,
    const std::string& variable) {
  for (size_t column = 0; column < variables.size(); ++column) {
    if (variables[column] == variable) {
      return static_cast<ColumnIndex>(column);
    }
  }
  return std::nullopt;
}

inline void appendParsedOutputVariable(
    BridgeQueryPlan& plan,
    const TripleComponent& component,
    uint32_t slot) {
  if (!component.isVariable()) {
    return;
  }
  plan.scan.needed_slots |= slot;
  plan.output_variables.push_back(bridgeComponentVariableName(component));
}

inline xpod_rdf_status bindTextRequiredEntities(
    const xpod::rdf::PhysicalBackend& backend,
    const xpod_rdf_snapshot& snapshot,
    BridgeQueryPlan& plan,
    std::string& error_storage) {
  if (plan.text_required_entities.empty()) {
    return XPOD_RDF_STATUS_OK;
  }

  std::vector<std::vector<xpod_rdf_term_key>> keys_by_source(
      plan.text_sources.size());
  for (const BridgeTextRequiredEntityBinding& binding :
       plan.text_required_entities) {
    if (binding.text_source_index >= plan.text_sources.size()) {
      error_storage = "text required entity binding references missing source";
      return XPOD_RDF_STATUS_UNSUPPORTED;
    }

    xpod_rdf_term term = toNativeTerm(binding.term);
    xpod_rdf_term_key key = 0;
    xpod_rdf_status term_status = XPOD_RDF_STATUS_OK;
    xpod_rdf_status status = backend.lookupTerms(
        &term, 1, snapshot, &key, &term_status);
    if (status != XPOD_RDF_STATUS_OK) {
      error_storage = "failed to lookup QLever text required entity";
      return status;
    }
    if (term_status == XPOD_RDF_STATUS_NOT_FOUND) {
      plan.known_empty = true;
      return XPOD_RDF_STATUS_OK;
    }
    if (term_status != XPOD_RDF_STATUS_OK) {
      error_storage = "failed to lookup QLever text required entity";
      return term_status;
    }
    keys_by_source[binding.text_source_index].push_back(key);
  }

  for (size_t i = 0; i < keys_by_source.size(); ++i) {
    if (!keys_by_source[i].empty()) {
      plan.text_sources[i].setRequiredEntities(std::move(keys_by_source[i]));
    }
  }
  return XPOD_RDF_STATUS_OK;
}

inline xpod_rdf_status bindValuesRows(
    const xpod::rdf::PhysicalBackend& backend,
    const xpod_rdf_snapshot& snapshot,
    BridgeQueryPlan& plan,
    std::string& error_storage) {
  if (plan.value_rows.empty()) {
    return XPOD_RDF_STATUS_OK;
  }

  plan.root.value_id_rows.clear();
  for (const auto& input_row : plan.value_rows) {
    std::vector<uint64_t> output_ids(input_row.size(), 0);
    std::vector<xpod_rdf_term> terms;
    terms.reserve(input_row.size());

    for (const BridgeTermBinding& binding : input_row) {
      terms.push_back(toNativeTerm(binding));
    }

    bool skip_row = false;
    std::vector<xpod_rdf_term_key> keys(terms.size());
    std::vector<xpod_rdf_status> statuses(terms.size());
    xpod_rdf_status status = backend.lookupTerms(
        terms.data(), terms.size(), snapshot, keys.data(), statuses.data());
    if (status != XPOD_RDF_STATUS_OK) {
      error_storage = "failed to lookup QLever VALUES constants";
      return status;
    }

    for (size_t index = 0; index < statuses.size(); ++index) {
      if (statuses[index] == XPOD_RDF_STATUS_NOT_FOUND) {
        skip_row = true;
        break;
      }
      if (statuses[index] != XPOD_RDF_STATUS_OK) {
        error_storage = "failed to lookup one or more QLever VALUES constants";
        return statuses[index];
      }
      uint64_t bits = 0;
      status = backend.encodeQleverId(keys[index], bits);
      if (status != XPOD_RDF_STATUS_OK) {
        error_storage = "failed to encode QLever VALUES constants";
        return status;
      }
      output_ids[index] = bits;
    }
    if (!skip_row) {
      plan.root.value_id_rows.push_back(std::move(output_ids));
    }
  }
  if (plan.root.value_id_rows.empty()) {
    plan.known_empty = true;
  }
  return XPOD_RDF_STATUS_OK;
}

inline xpod_rdf_status bindModifierTermBindings(
    const xpod::rdf::PhysicalBackend& backend,
    const xpod_rdf_snapshot& snapshot,
    BridgeQueryPlan& plan,
    std::string& error_storage) {
  for (const BridgeModifierTermBinding& binding :
       plan.modifier_term_bindings) {
    if (binding.modifier_index >= plan.root.result_modifiers.size()) {
      error_storage = "QLever filter modifier binding references missing modifier";
      return XPOD_RDF_STATUS_UNSUPPORTED;
    }

    xpod_rdf_term term = toNativeTerm(binding.term);
    xpod_rdf_term_key key = 0;
    xpod_rdf_status term_status = XPOD_RDF_STATUS_OK;
    xpod_rdf_status status = backend.lookupTerms(
        &term, 1, snapshot, &key, &term_status);
    if (status != XPOD_RDF_STATUS_OK) {
      error_storage = "failed to lookup QLever filter constant";
      return status;
    }
    if (term_status == XPOD_RDF_STATUS_NOT_FOUND) {
      continue;
    }
    if (term_status != XPOD_RDF_STATUS_OK) {
      error_storage = "failed to lookup QLever filter constant";
      return term_status;
    }

    uint64_t bits = 0;
    status = backend.encodeQleverId(key, bits);
    if (status != XPOD_RDF_STATUS_OK) {
      error_storage = "failed to encode QLever filter constant";
      return status;
    }
    BridgeResultModifier& modifier =
        plan.root.result_modifiers[binding.modifier_index];
    modifier.term_id_bits = bits;
    modifier.has_term_id_bits = true;
  }
  return XPOD_RDF_STATUS_OK;
}

inline xpod_rdf_status bindPlanTerms(
    const xpod::rdf::PhysicalBackend& backend,
    const xpod_rdf_snapshot& snapshot,
    BridgeQueryPlan& plan,
    std::string& error_storage) {
  xpod_rdf_status status = bindTermBindings(
      backend, snapshot, plan.term_bindings, plan.scan.pattern,
      plan.scan.slot_ranges, plan.known_empty, error_storage);
  if (status != XPOD_RDF_STATUS_OK || plan.known_empty) {
    return status;
  }
  for (BridgeFilterScan& filter : plan.filter_scans) {
    status = bindTermBindings(
        backend, snapshot, filter.term_bindings, filter.scan.pattern,
        filter.scan.slot_ranges, filter.known_empty, error_storage);
    if (status != XPOD_RDF_STATUS_OK) {
      return status;
    }
    if (filter.known_empty) {
      plan.known_empty = true;
      return XPOD_RDF_STATUS_OK;
    }
  }
  status = bindTextRequiredEntities(backend, snapshot, plan, error_storage);
  if (status != XPOD_RDF_STATUS_OK || plan.known_empty) {
    return status;
  }
  status = bindValuesRows(backend, snapshot, plan, error_storage);
  if (status != XPOD_RDF_STATUS_OK || plan.known_empty) {
    return status;
  }
  status = bindModifierTermBindings(backend, snapshot, plan, error_storage);
  if (status != XPOD_RDF_STATUS_OK) {
    return status;
  }
  for (BridgeQueryPlan& child : plan.child_plans) {
    status = bindPlanTerms(backend, snapshot, child, error_storage);
    if (status != XPOD_RDF_STATUS_OK) {
      return status;
    }
    if (child.known_empty) {
      plan.known_empty = true;
      return XPOD_RDF_STATUS_OK;
    }
  }
  return XPOD_RDF_STATUS_OK;
}

inline void applyBridgeRequestContext(
    BridgeQueryPlan& plan,
    const xpod_rdf_snapshot& snapshot,
    const xpod_rdf_cancellation* cancellation,
    const xpod_rdf_graph_scope& graph_scope,
    const xpod_rdf_source_scope& source_scope,
    const xpod_rdf_access_scope* access_scope) noexcept {
  plan.scan.snapshot = &snapshot;
  plan.scan.cancellation = cancellation;
  plan.scan.graph_scope = graph_scope;
  plan.scan.source_scope = &source_scope;
  plan.scan.access_scope = access_scope;
  for (BridgeFilterScan& filter : plan.filter_scans) {
    filter.scan.snapshot = &snapshot;
    filter.scan.cancellation = cancellation;
    filter.scan.graph_scope = graph_scope;
    filter.scan.source_scope = &source_scope;
    filter.scan.access_scope = access_scope;
  }
  for (BridgeTextCandidateSource& source : plan.text_sources) {
    source.request.snapshot = snapshot;
    source.request.cancellation = cancellation;
    source.request.graph_scope = graph_scope;
    source.request.source_scope = source_scope;
    source.request.access_scope = access_scope;
  }
  for (BridgeVectorCandidateSource& source : plan.vector_sources) {
    source.request.snapshot = snapshot;
    source.request.cancellation = cancellation;
    source.request.graph_scope = graph_scope;
    source.request.source_scope = source_scope;
    source.request.access_scope = access_scope;
  }
  for (BridgeQueryPlan& child : plan.child_plans) {
    applyBridgeRequestContext(
        child, snapshot, cancellation, graph_scope, source_scope, access_scope);
  }
}

inline void initializeScanPlan(
    BridgeQueryPlan& plan,
    const SparqlTripleSimple& triple) {
  plan.scan.permutation = Permutation::Enum::SPO;
  plan.scan.needed_slots = 0;
  plan.output_variables.clear();
  appendParsedOutputVariable(plan, triple.s_, XPOD_RDF_SLOT_SUBJECT);
  appendParsedOutputVariable(plan, triple.p_, XPOD_RDF_SLOT_PREDICATE);
  appendParsedOutputVariable(plan, triple.o_, XPOD_RDF_SLOT_OBJECT);
  plan.sorted_by = {0};
  plan.result_width = plan.output_variables.size();
  plan.descriptor = "xpod scan ?s ?p ?o";
  plan.root.kind = BridgeOperationKind::PermutationScan;
  plan.root.scan_indexes = {0};
  plan.root.join_slot = XPOD_RDF_SLOT_SUBJECT;
}

inline void initializeFilterScan(BridgeFilterScan& filter) {
  filter.scan.permutation = Permutation::Enum::SPO;
  filter.scan.needed_slots = XPOD_RDF_SLOT_SUBJECT | XPOD_RDF_SLOT_PREDICATE |
                             XPOD_RDF_SLOT_OBJECT;
  filter.join_slot = XPOD_RDF_SLOT_SUBJECT;
  filter.descriptor = "xpod subject filter scan";
}

inline std::optional<BridgeQueryPlan> planSingleTriple(
    const SparqlTripleSimple& triple) {
  BridgeQueryPlan plan;
  if (!bindableAnyComponent(triple.s_, XPOD_RDF_SLOT_SUBJECT, plan) ||
      !bindableAnyComponent(triple.p_, XPOD_RDF_SLOT_PREDICATE, plan) ||
      !bindableAnyComponent(triple.o_, XPOD_RDF_SLOT_OBJECT, plan)) {
    return std::nullopt;
  }
  initializeScanPlan(plan, triple);
  return plan;
}

struct BridgeVariableSlot {
  std::string variable;
  uint32_t slot = 0;
};

struct BridgeProjectionSlot {
  std::string variable;
  size_t scan_position = 0;
  uint32_t slot = 0;
};

inline void appendVariableSlot(
    std::vector<BridgeVariableSlot>& slots,
    const TripleComponent& component,
    uint32_t slot) {
  if (!component.isVariable()) {
    return;
  }
  slots.push_back({bridgeComponentVariableName(component), slot});
}

inline std::vector<BridgeVariableSlot> variableSlotsForTriple(
    const SparqlTripleSimple& triple) {
  std::vector<BridgeVariableSlot> slots;
  appendVariableSlot(slots, triple.s_, XPOD_RDF_SLOT_SUBJECT);
  appendVariableSlot(slots, triple.p_, XPOD_RDF_SLOT_PREDICATE);
  appendVariableSlot(slots, triple.o_, XPOD_RDF_SLOT_OBJECT);
  return slots;
}

inline std::optional<uint32_t> slotForVariable(
    const std::vector<BridgeVariableSlot>& slots,
    std::string_view variable) {
  for (const BridgeVariableSlot& slot : slots) {
    if (slot.variable == variable) {
      return slot.slot;
    }
  }
  return std::nullopt;
}

inline bool containsProjectionVariable(
    const std::vector<BridgeProjectionSlot>& slots,
    std::string_view variable) {
  for (const BridgeProjectionSlot& slot : slots) {
    if (slot.variable == variable) {
      return true;
    }
  }
  return false;
}

inline void appendProjectionSlot(
    std::vector<BridgeProjectionSlot>& slots,
    const TripleComponent& component,
    size_t scan_position,
    uint32_t slot) {
  if (!component.isVariable()) {
    return;
  }
  std::string variable = bridgeComponentVariableName(component);
  if (containsProjectionVariable(slots, variable)) {
    return;
  }
  slots.push_back({std::move(variable), scan_position, slot});
}

inline void appendProjectionSlotsForTriple(
    std::vector<BridgeProjectionSlot>& slots,
    const SparqlTripleSimple& triple,
    size_t scan_position) {
  appendProjectionSlot(
      slots, triple.s_, scan_position, XPOD_RDF_SLOT_SUBJECT);
  appendProjectionSlot(
      slots, triple.p_, scan_position, XPOD_RDF_SLOT_PREDICATE);
  appendProjectionSlot(
      slots, triple.o_, scan_position, XPOD_RDF_SLOT_OBJECT);
}

inline std::optional<BridgeProjectionSlot> projectionSlotForVariable(
    const std::vector<BridgeProjectionSlot>& slots,
    std::string_view variable) {
  for (const BridgeProjectionSlot& slot : slots) {
    if (slot.variable == variable) {
      return slot;
    }
  }
  return std::nullopt;
}

inline bool appendTripleTermBindings(
    const SparqlTripleSimple& triple,
    std::vector<BridgeTermBinding>& bindings) {
  BridgeQueryPlan scratch;
  if (!bindableAnyComponent(triple.s_, XPOD_RDF_SLOT_SUBJECT, scratch) ||
      !bindableAnyComponent(triple.p_, XPOD_RDF_SLOT_PREDICATE, scratch) ||
      !bindableAnyComponent(triple.o_, XPOD_RDF_SLOT_OBJECT, scratch)) {
    return false;
  }
  for (BridgeTermBinding& binding : scratch.term_bindings) {
    bindings.push_back(std::move(binding));
  }
  return true;
}

inline std::optional<std::vector<std::string>> selectedVariablesFromParsedQuery(
    const ParsedQuery& parsed) {
  const auto& select = parsed.selectClause();
  if (select.isAsterisk()) {
    return std::nullopt;
  }
  std::vector<std::string> variables;
  for (const Variable& variable : select.getSelectedVariables()) {
    variables.push_back(bridgeVariableName(variable));
  }
  return variables;
}

inline bool applySelectedProjection(
    BridgeQueryPlan& plan,
    const ParsedQuery& parsed,
    const SparqlTripleSimple& first,
    const std::optional<SparqlTripleSimple>& second,
    const std::optional<BridgeGraphScope>& graph_scope) {
  std::optional<std::vector<std::string>> selected =
      selectedVariablesFromParsedQuery(parsed);
  if (!selected.has_value()) {
    return true;
  }

  std::vector<BridgeProjectionSlot> available;
  appendProjectionSlotsForTriple(available, first, 0);
  if (second.has_value()) {
    appendProjectionSlotsForTriple(available, *second, 1);
  }
  if (graph_scope.has_value() && graph_scope->variable.has_value() &&
      !containsProjectionVariable(available, *graph_scope->variable)) {
    available.push_back({
        *graph_scope->variable,
        0,
        XPOD_RDF_SLOT_GRAPH,
    });
  }

  std::vector<std::string> output_variables;
  std::vector<std::vector<uint32_t>> project_slots(
      second.has_value() ? 2 : 1);
  for (const std::string& variable : *selected) {
    std::optional<BridgeProjectionSlot> slot =
        projectionSlotForVariable(available, variable);
    if (!slot.has_value() || slot->scan_position >= project_slots.size()) {
      return false;
    }
    output_variables.push_back(variable);
    project_slots[slot->scan_position].push_back(slot->slot);
  }

  plan.output_variables = std::move(output_variables);
  plan.result_width = plan.output_variables.size();
  if (second.has_value()) {
    plan.root.scan_project_slots = std::move(project_slots);
    return true;
  }

  plan.scan.needed_slots = 0;
  for (uint32_t slot : project_slots.front()) {
    plan.scan.needed_slots |= slot;
  }
  plan.sorted_by.clear();
  for (size_t column = 0; column < project_slots.front().size(); ++column) {
    if (project_slots.front()[column] == XPOD_RDF_SLOT_SUBJECT) {
      plan.sorted_by = {static_cast<ColumnIndex>(column)};
      break;
    }
  }
  return true;
}

inline bool appendSecondTripleJoin(
    BridgeQueryPlan& plan,
    const SparqlTripleSimple& first,
    const SparqlTripleSimple& second,
    const std::optional<BridgeGraphScope>& graph_scope) {
  const std::vector<BridgeVariableSlot> first_slots = variableSlotsForTriple(first);
  const std::vector<BridgeVariableSlot> second_slots = variableSlotsForTriple(second);
  std::vector<uint32_t> first_join_slots;
  std::vector<uint32_t> second_join_slots;
  std::vector<uint32_t> first_project_slots;
  std::vector<uint32_t> second_project_slots;

  for (const BridgeVariableSlot& slot : first_slots) {
    first_project_slots.push_back(slot.slot);
  }
  for (const BridgeVariableSlot& second_slot : second_slots) {
    std::optional<uint32_t> first_slot = slotForVariable(
        first_slots, second_slot.variable);
    if (first_slot.has_value()) {
      first_join_slots.push_back(*first_slot);
      second_join_slots.push_back(second_slot.slot);
      continue;
    }
    plan.output_variables.push_back(second_slot.variable);
    second_project_slots.push_back(second_slot.slot);
  }

  if (first_join_slots.empty()) {
    return false;
  }

  BridgeFilterScan filter;
  initializeFilterScan(filter);
  filter.join_slot = second_join_slots.front();
  if (!appendTripleTermBindings(second, filter.term_bindings)) {
    return false;
  }
  if (graph_scope.has_value() && graph_scope->binding.has_value()) {
    filter.term_bindings.push_back(*graph_scope->binding);
  }
  if (graph_scope.has_value() && graph_scope->variable.has_value()) {
    filter.scan.needed_slots |= XPOD_RDF_SLOT_GRAPH;
    first_join_slots.push_back(XPOD_RDF_SLOT_GRAPH);
    second_join_slots.push_back(XPOD_RDF_SLOT_GRAPH);
    first_project_slots.push_back(XPOD_RDF_SLOT_GRAPH);
  }

  plan.filter_scans.push_back(std::move(filter));
  plan.descriptor = "xpod scan ?s ?p ?o with join";
  plan.result_width = plan.output_variables.size();
  plan.root.kind = BridgeOperationKind::HashJoin;
  plan.root.scan_indexes = {0, 1};
  plan.root.join_slot = first_join_slots.front();
  plan.root.join_slots = {
      first_join_slots.front(),
      second_join_slots.front(),
  };
  plan.root.join_key_slots = {
      std::move(first_join_slots),
      std::move(second_join_slots),
  };
  plan.root.scan_project_slots = {
      std::move(first_project_slots),
      std::move(second_project_slots),
  };
  return true;
}

inline const parsedQuery::BasicGraphPattern* basicPatternFromOperation(
    const parsedQuery::GraphPatternOperation& operation) {
  return std::get_if<parsedQuery::BasicGraphPattern>(
      &static_cast<const parsedQuery::GraphPatternOperationVariant&>(operation));
}

inline std::optional<BridgeGraphScope> graphScopeFromGroup(
    const parsedQuery::GroupGraphPattern& group) {
  BridgeGraphScope scope;
  if (const auto* graph_iri =
          std::get_if<TripleComponent::Iri>(&group.graphSpec_);
      graph_iri != nullptr) {
    BridgeTermBinding binding;
    binding.slot = XPOD_RDF_SLOT_GRAPH;
    binding.kind = XPOD_RDF_TERM_IRI;
    binding.value = iriValueFromIri(*graph_iri);
    scope.binding = std::move(binding);
    return scope;
  }
  if (const auto* graph_var =
          std::get_if<parsedQuery::GroupGraphPattern::GraphVar>(
              &group.graphSpec_);
      graph_var != nullptr) {
    scope.variable = bridgeVariableName(graph_var->first);
    return scope;
  }
  return std::nullopt;
}

inline const parsedQuery::BasicGraphPattern* scopedBasicPatternFromOperation(
    const parsedQuery::GraphPatternOperation& operation,
    std::optional<BridgeGraphScope>& graph_scope) {
  const parsedQuery::BasicGraphPattern* basic = basicPatternFromOperation(operation);
  if (basic != nullptr) {
    return basic;
  }
  const auto* group = std::get_if<parsedQuery::GroupGraphPattern>(
      &static_cast<const parsedQuery::GraphPatternOperationVariant&>(operation));
  if (group == nullptr) {
    return nullptr;
  }
  graph_scope = graphScopeFromGroup(*group);
  if (!graph_scope.has_value() || group->_child._graphPatterns.size() != 1) {
    return nullptr;
  }
  return basicPatternFromOperation(group->_child._graphPatterns.front());
}

inline void appendGraphScopeProjection(
    BridgeQueryPlan& plan,
    const BridgeGraphScope& graph_scope) {
  if (!graph_scope.variable.has_value()) {
    return;
  }
  plan.scan.needed_slots |= XPOD_RDF_SLOT_GRAPH;
  plan.output_variables.push_back(*graph_scope.variable);
  plan.result_width = plan.output_variables.size();
}

inline const parsedQuery::Values* valuesFromOperation(
    const parsedQuery::GraphPatternOperation& operation) {
  return std::get_if<parsedQuery::Values>(
      &static_cast<const parsedQuery::GraphPatternOperationVariant&>(operation));
}

inline const parsedQuery::GroupGraphPattern* groupFromOperation(
    const parsedQuery::GraphPatternOperation& operation) {
  return std::get_if<parsedQuery::GroupGraphPattern>(
      &static_cast<const parsedQuery::GraphPatternOperationVariant&>(operation));
}

inline std::optional<BridgeQueryPlan> planValuesOperation(
    const parsedQuery::Values& values) {
  const auto& inline_values = values._inlineValues;
  if (inline_values._variables.empty()) {
    return std::nullopt;
  }

  BridgeQueryPlan plan;
  plan.root.kind = BridgeOperationKind::Values;
  plan.descriptor = "Values";
  plan.output_variables.reserve(inline_values._variables.size());
  for (const Variable& variable : inline_values._variables) {
    plan.output_variables.push_back(bridgeVariableName(variable));
  }
  plan.result_width = plan.output_variables.size();

  plan.value_rows.reserve(inline_values._values.size());
  for (const auto& input_row : inline_values._values) {
    if (input_row.size() != inline_values._variables.size()) {
      return std::nullopt;
    }
    std::vector<BridgeTermBinding> output_row;
    output_row.reserve(input_row.size());
    for (const TripleComponent& component : input_row) {
      if (component.isUndef()) {
        return std::nullopt;
      }
      auto binding = termBindingFromValuesComponent(component);
      if (!binding.has_value()) {
        return std::nullopt;
      }
      output_row.push_back(std::move(*binding));
    }
    plan.value_rows.push_back(std::move(output_row));
  }
  return plan;
}

inline bool applySelectedProjectionByOutputVariables(
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

inline bool valuesVariablesAllJoinBGP(
    const BridgeQueryPlan& values_plan,
    const BridgeQueryPlan& bgp_plan) {
  for (const std::string& variable : values_plan.output_variables) {
    if (!containsOutputVariable(bgp_plan.output_variables, variable)) {
      return false;
    }
  }
  return true;
}

inline std::string_view trimFilterToken(std::string_view value) {
  while (!value.empty() &&
         std::isspace(static_cast<unsigned char>(value.front())) != 0) {
    value.remove_prefix(1);
  }
  while (!value.empty() &&
         std::isspace(static_cast<unsigned char>(value.back())) != 0) {
    value.remove_suffix(1);
  }
  return value;
}

inline std::string_view stripOuterFilterParens(std::string_view value) {
  value = trimFilterToken(value);
  if (value.size() >= 2 && value.front() == '(' && value.back() == ')') {
    value.remove_prefix(1);
    value.remove_suffix(1);
    return trimFilterToken(value);
  }
  return value;
}

inline std::optional<BridgeTermBinding> iriFilterBindingFromToken(
    std::string_view token) {
  token = trimFilterToken(token);
  if (token.size() < 3 || token.front() != '<' || token.back() != '>') {
    return std::nullopt;
  }
  BridgeTermBinding binding;
  binding.kind = XPOD_RDF_TERM_IRI;
  binding.value = std::string(token.substr(1, token.size() - 2));
  return binding;
}

inline bool applyNotEqualFilterDescriptor(
    BridgeQueryPlan& plan,
    std::string_view descriptor) {
  descriptor = stripOuterFilterParens(descriptor);
  size_t separator = descriptor.find(" != ");
  if (separator == std::string_view::npos) {
    return false;
  }
  std::string_view left = trimFilterToken(descriptor.substr(0, separator));
  std::string_view right = trimFilterToken(descriptor.substr(separator + 4));
  if (left.size() < 2 || left.front() != '?') {
    return false;
  }
  std::string variable(left.substr(1));
  std::optional<ColumnIndex> column =
      outputColumnForVariable(plan.output_variables, variable);
  if (!column.has_value()) {
    return false;
  }
  std::optional<BridgeTermBinding> term = iriFilterBindingFromToken(right);
  if (!term.has_value()) {
    return false;
  }

  BridgeResultModifier modifier;
  modifier.kind = BridgeResultModifierKind::NotEqualTerm;
  modifier.columns.push_back(*column);
  size_t modifier_index = plan.root.result_modifiers.size();
  plan.root.result_modifiers.push_back(std::move(modifier));
  plan.modifier_term_bindings.push_back({modifier_index, std::move(*term)});
  if (plan.descriptor.find("Filter") == std::string::npos) {
    plan.descriptor += " + Filter";
  }
  return true;
}

inline bool applyGraphPatternFilters(
    BridgeQueryPlan& plan,
    const std::vector<SparqlFilter>& filters) {
  for (const SparqlFilter& filter : filters) {
    if (!applyNotEqualFilterDescriptor(
            plan, filter.expression_.getDescriptor())) {
      return false;
    }
  }
  return true;
}

inline std::optional<BridgeQueryPlan> planBasicPatternFallback(
    const ParsedQuery& parsed,
    const parsedQuery::BasicGraphPattern& basic,
    const std::optional<BridgeGraphScope>& graph_scope,
    bool apply_selected_projection = true) {
  if (basic._triples.empty() || basic._triples.size() > 2) {
    return std::nullopt;
  }

  try {
    SparqlTripleSimple first = basic._triples.front().getSimple();
    auto plan = planSingleTriple(first);
    if (!plan.has_value()) {
      return std::nullopt;
    }
    if (graph_scope.has_value() && graph_scope->binding.has_value()) {
      plan->term_bindings.push_back(*graph_scope->binding);
    }
    if (graph_scope.has_value()) {
      appendGraphScopeProjection(*plan, *graph_scope);
    }
    if (basic._triples.size() == 2) {
      SparqlTripleSimple second = basic._triples[1].getSimple();
      if (!appendSecondTripleJoin(*plan, first, second, graph_scope)) {
        return std::nullopt;
      }
      if (apply_selected_projection &&
          !applySelectedProjection(*plan, parsed, first, second, graph_scope)) {
        return std::nullopt;
      }
    } else if (apply_selected_projection &&
        !applySelectedProjection(*plan, parsed, first, std::nullopt, graph_scope)) {
      return std::nullopt;
    }
    return plan;
  } catch (...) {
    return std::nullopt;
  }
}

inline std::optional<BridgeQueryPlan> planValuesBasicJoinFallback(
    const ParsedQuery& parsed,
    const parsedQuery::Values& values,
    const parsedQuery::BasicGraphPattern& basic,
    const std::optional<BridgeGraphScope>& graph_scope,
    bool apply_selected_projection = true) {
  auto values_plan = planValuesOperation(values);
  auto bgp_plan = planBasicPatternFallback(
      parsed, basic, graph_scope, false);
  if (!values_plan.has_value() || !bgp_plan.has_value() ||
      !valuesVariablesAllJoinBGP(*values_plan, *bgp_plan)) {
    return std::nullopt;
  }

  BridgeQueryPlan plan;
  plan.descriptor = "Values + " + bgp_plan->descriptor;
  plan.root.kind = BridgeOperationKind::MultiColumnJoin;
  plan.root.matched_columns = matchedOutputVariableColumns(
      values_plan->output_variables, bgp_plan->output_variables);
  if (plan.root.matched_columns.empty()) {
    return std::nullopt;
  }
  plan.root.right_projection_columns = rightProjectionColumns(
      values_plan->output_variables, bgp_plan->output_variables);
  plan.output_variables = values_plan->output_variables;
  for (size_t column : plan.root.right_projection_columns) {
    if (column >= bgp_plan->output_variables.size()) {
      return std::nullopt;
    }
    plan.output_variables.push_back(bgp_plan->output_variables[column]);
  }
  plan.result_width = plan.output_variables.size();
  plan.child_plans.push_back(std::move(*values_plan));
  plan.child_plans.push_back(std::move(*bgp_plan));

  if (apply_selected_projection &&
      !applySelectedProjectionByOutputVariables(plan, parsed)) {
    return std::nullopt;
  }
  return plan;
}

inline std::optional<BridgeQueryPlan> planParsedGraphPatternFallback(
    const ParsedQuery& parsed,
    const parsedQuery::GraphPattern& graph_pattern,
    const std::optional<BridgeGraphScope>& graph_scope,
    bool apply_selected_projection = true);

inline std::optional<BridgeQueryPlan> planParsedChildrenFallback(
    const ParsedQuery& parsed,
    const std::vector<parsedQuery::GraphPatternOperation>& children,
    const std::optional<BridgeGraphScope>& graph_scope,
    bool apply_selected_projection = true) {
  if (children.size() == 1) {
    const auto* group = groupFromOperation(children.front());
    if (group != nullptr) {
      std::optional<BridgeGraphScope> nested_scope = graph_scope;
      std::optional<BridgeGraphScope> local_scope = graphScopeFromGroup(*group);
      if (local_scope.has_value()) {
        if (nested_scope.has_value()) {
          return std::nullopt;
        }
        nested_scope = std::move(local_scope);
      }
      return planParsedGraphPatternFallback(
          parsed, group->_child, nested_scope, apply_selected_projection);
    }
    const auto* basic = basicPatternFromOperation(children.front());
    if (basic == nullptr) {
      return std::nullopt;
    }
    return planBasicPatternFallback(
        parsed, *basic, graph_scope, apply_selected_projection);
  }
  if (children.size() == 2) {
    std::optional<BridgeGraphScope> effective_scope = graph_scope;
    const parsedQuery::Values* values = valuesFromOperation(children[0]);
    const auto* basic = basicPatternFromOperation(children[1]);
    if (values == nullptr || basic == nullptr) {
      effective_scope = graph_scope;
      values = valuesFromOperation(children[1]);
      basic = basicPatternFromOperation(children[0]);
    }
    if (values == nullptr || basic == nullptr) {
      return std::nullopt;
    }
    return planValuesBasicJoinFallback(
        parsed, *values, *basic, effective_scope, apply_selected_projection);
  }
  return std::nullopt;
}

inline std::optional<BridgeQueryPlan> planParsedGraphPatternFallback(
    const ParsedQuery& parsed,
    const parsedQuery::GraphPattern& graph_pattern,
    const std::optional<BridgeGraphScope>& graph_scope,
    bool apply_selected_projection) {
  auto plan = planParsedChildrenFallback(
      parsed, graph_pattern._graphPatterns, graph_scope,
      apply_selected_projection);
  if (!plan.has_value()) {
    return std::nullopt;
  }
  if (!applyGraphPatternFilters(*plan, graph_pattern._filters)) {
    return std::nullopt;
  }
  return plan;
}

inline std::optional<BridgeQueryPlan> planParsedQuery(
    const ParsedQuery& parsed) {
  if (!parsed.hasSelectClause()) {
    return std::nullopt;
  }
  return planParsedGraphPatternFallback(
      parsed, parsed._rootGraphPattern, std::nullopt);
}

inline std::optional<BridgeQueryPlan> planParsedAskQuery(
    const ParsedQuery& parsed) {
  if (!parsed.hasAskClause()) {
    return std::nullopt;
  }
  auto plan = planParsedGraphPatternFallback(
      parsed, parsed._rootGraphPattern, std::nullopt, false);
  if (plan.has_value() && plan->descriptor.find("Ask") == std::string::npos) {
    plan->descriptor = "Ask + " + plan->descriptor;
  }
  return plan;
}

inline void offsetBridgeOperationIndexes(
    BridgeOperationPlan& root,
    size_t scan_offset,
    size_t text_offset,
    size_t vector_offset) {
  for (size_t& scan_index : root.scan_indexes) {
    scan_index += scan_offset;
  }
  if ((root.kind == BridgeOperationKind::TextSearch ||
       root.use_candidate_join) &&
      root.candidate_source == BridgeCandidateSourceKind::Text) {
    root.candidate_index += text_offset;
  }
  if ((root.kind == BridgeOperationKind::VectorSearch ||
       root.use_candidate_join) &&
      root.candidate_source == BridgeCandidateSourceKind::Vector) {
    root.candidate_index += vector_offset;
  }
  for (BridgeOperationPlan& child : root.children) {
    offsetBridgeOperationIndexes(
        child, scan_offset, text_offset, vector_offset);
  }
}

inline void appendChildPhysicalPlan(
    BridgePhysicalPlan& physical,
    BridgePhysicalPlan child_physical) {
  size_t scan_offset = physical.scans.size();
  size_t text_offset = physical.text_sources.size();
  size_t vector_offset = physical.vector_sources.size();
  offsetBridgeOperationIndexes(
      child_physical.root, scan_offset, text_offset, vector_offset);
  physical.root.children.push_back(std::move(child_physical.root));
  physical.scans.insert(
      physical.scans.end(),
      std::make_move_iterator(child_physical.scans.begin()),
      std::make_move_iterator(child_physical.scans.end()));
  physical.text_sources.insert(
      physical.text_sources.end(),
      std::make_move_iterator(child_physical.text_sources.begin()),
      std::make_move_iterator(child_physical.text_sources.end()));
  physical.vector_sources.insert(
      physical.vector_sources.end(),
      std::make_move_iterator(child_physical.vector_sources.begin()),
      std::make_move_iterator(child_physical.vector_sources.end()));
}

inline BridgePhysicalPlan toBridgePhysicalPlan(const BridgeQueryPlan& plan) {
  BridgePhysicalPlan physical;
  physical.root = plan.root;
  bool copied_text_sources = false;
  if (plan.root.kind == BridgeOperationKind::PermutationScan ||
      plan.root.kind == BridgeOperationKind::HashJoin) {
    xpod_rdf_profile_node_key profile_node = 1;
    xpod_rdf_profile_node_key parent_profile_node = 0;
    if (plan.root.kind == BridgeOperationKind::HashJoin) {
      physical.root.profile_node = profile_node++;
      parent_profile_node = physical.root.profile_node;
      if (plan.root.use_candidate_join) {
        physical.text_sources = plan.text_sources;
        if (plan.root.candidate_index < physical.text_sources.size()) {
          physical.text_sources[plan.root.candidate_index].profile_node =
              profile_node++;
          physical.text_sources[plan.root.candidate_index]
              .parent_profile_node = parent_profile_node;
        }
        copied_text_sources = true;
      }
    }

    BridgePhysicalScan primary;
    primary.scan = plan.scan;
    primary.sorted_by = plan.sorted_by;
    primary.result_width = plan.result_width;
    primary.descriptor = plan.descriptor;
    primary.profile_node = profile_node++;
    primary.parent_profile_node = parent_profile_node;
    physical.scans.push_back(std::move(primary));

    for (const BridgeFilterScan& filter : plan.filter_scans) {
      BridgePhysicalScan scan;
      scan.scan = filter.scan;
      scan.sorted_by = {0};
      scan.result_width = 3;
      scan.descriptor = filter.descriptor;
      scan.profile_node = profile_node++;
      scan.parent_profile_node = parent_profile_node;
      physical.scans.push_back(std::move(scan));
    }
  }

  if (!copied_text_sources) {
    physical.text_sources = plan.text_sources;
  }
  physical.vector_sources = plan.vector_sources;
  for (const BridgeQueryPlan& child : plan.child_plans) {
    appendChildPhysicalPlan(physical, toBridgePhysicalPlan(child));
  }
  return physical;
}

}  // namespace xpod::qlever
#endif

#endif
