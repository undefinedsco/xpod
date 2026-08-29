#ifndef XPOD_QLEVER_PLAN_BRIDGE_HPP
#define XPOD_QLEVER_PLAN_BRIDGE_HPP

#include "XpodQleverOperationBridge.hpp"
#include "XpodQleverScanBridge.hpp"
#include "xpod_rdf_physical_backend.h"

#include <algorithm>
#include <cctype>
#include <iomanip>
#include <limits>
#include <optional>
#include <iterator>
#include <sstream>
#include <string>
#include <string_view>
#include <type_traits>
#include <utility>
#include <variant>
#include <vector>

#if XPOD_QLEVER_ADAPTER_ENABLE_QLEVER
#if __has_include("engine/sparqlExpressions/ExistsExpression.h")
#include "engine/sparqlExpressions/ExistsExpression.h"
#define XPOD_QLEVER_HAS_EXISTS_EXPRESSION 1
#else
#define XPOD_QLEVER_HAS_EXISTS_EXPRESSION 0
#endif
#include "global/Id.h"
#include "parser/ParsedQuery.h"
#include "parser/SparqlTriple.h"

namespace xpod::qlever {

inline constexpr std::string_view QleverDefaultGraphIri =
    "http://qlever.cs.uni-freiburg.de/builtin-functions/default-graph";

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
  std::vector<size_t> child_indexes;
  BridgeTermBinding term;
};

struct BridgeScanFilterTermBinding {
  size_t filter_index = 0;
  BridgeTermBinding term;
};

struct BridgeGraphScope {
  std::optional<BridgeTermBinding> binding;
  std::optional<std::string> variable;
  std::vector<BridgeTermBinding> graph_scope_bindings;
  bool graph_scope_known_empty = false;
  bool implicit_default_graph = false;
};

inline std::optional<BridgeGraphScope> defaultGraphBridgeScope() {
  BridgeGraphScope scope;
  BridgeTermBinding binding;
  binding.slot = XPOD_RDF_SLOT_GRAPH;
  binding.kind = XPOD_RDF_TERM_IRI;
  binding.value = std::string(QleverDefaultGraphIri);
  scope.graph_scope_bindings.push_back(std::move(binding));
  scope.implicit_default_graph = true;
  return scope;
}

struct BridgePhysicalFilterFallback {
  std::string reason;
  std::string expression;
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
  std::vector<BridgeScanFilterTermBinding> scan_filter_term_bindings;
  std::vector<BridgeTermBinding> graph_scope_bindings;
  std::vector<xpod_rdf_term_key> graph_scope_storage;
  std::vector<std::string> output_variables;
  std::vector<BridgeQueryPlan> child_plans;
  BridgeOperationPlan root;
  std::optional<BridgePhysicalFilterFallback> physical_filter_fallback;
  bool allow_scan_filter_pushdown = false;
  bool known_empty = false;
};

template <typename Component, typename = void>
struct HasInlineIntComponent : std::false_type {};

template <typename Component>
struct HasInlineIntComponent<
    Component,
    std::void_t<decltype(std::declval<const Component&>().isInt()),
                decltype(std::declval<const Component&>().getInt())>>
    : std::true_type {};

template <typename Component, typename = void>
struct HasInlineDoubleComponent : std::false_type {};

template <typename Component>
struct HasInlineDoubleComponent<
    Component,
    std::void_t<decltype(std::declval<const Component&>().isDouble()),
                decltype(std::declval<const Component&>().getDouble())>>
    : std::true_type {};

template <typename Component, typename = void>
struct HasInlineBoolComponent : std::false_type {};

template <typename Component>
struct HasInlineBoolComponent<
    Component,
    std::void_t<decltype(std::declval<const Component&>().isBool()),
                decltype(std::declval<const Component&>().getBool())>>
    : std::true_type {};

inline std::string iriValueFromComponent(const TripleComponent& component) {
  std::string iri = std::string(component.getIri().toStringRepresentation());
  if (iri.size() >= 2 && iri.front() == '<' && iri.back() == '>') {
    return iri.substr(1, iri.size() - 2);
  }
  return iri;
}

inline std::optional<std::pair<std::string, std::string>>
languagePredicateFromIriValue(std::string_view iri) {
  if (iri.size() < 5 || iri.front() != '@') {
    return std::nullopt;
  }
  size_t language_end = iri.find('@', 1);
  if (language_end == std::string_view::npos || language_end == 1) {
    return std::nullopt;
  }
  std::string_view language = iri.substr(1, language_end - 1);
  for (char c : language) {
    const unsigned char ch = static_cast<unsigned char>(c);
    if (std::isalnum(ch) == 0 && c != '-') {
      return std::nullopt;
    }
  }
  std::string_view predicate = iri.substr(language_end + 1);
  if (predicate.size() < 3 || predicate.front() != '<' ||
      predicate.back() != '>') {
    return std::nullopt;
  }
  return std::make_pair(
      std::string(language),
      std::string(predicate.substr(1, predicate.size() - 2)));
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

inline BridgeTermBinding typedLiteralBinding(
    uint32_t slot,
    std::string value,
    std::string datatype_iri) {
  BridgeTermBinding binding;
  binding.slot = slot;
  binding.kind = XPOD_RDF_TERM_LITERAL;
  binding.value = std::move(value);
  binding.datatype_iri = std::move(datatype_iri);
  return binding;
}

template <typename Component>
inline std::optional<BridgeTermBinding> inlineValueBindingFromComponent(
    const Component& component,
    uint32_t slot) {
  if constexpr (HasInlineIntComponent<Component>::value) {
    if (component.isInt()) {
      return typedLiteralBinding(
          slot,
          std::to_string(component.getInt()),
          "http://www.w3.org/2001/XMLSchema#integer");
    }
  }
  if constexpr (HasInlineDoubleComponent<Component>::value) {
    if (component.isDouble()) {
      std::ostringstream out;
      out << std::setprecision(17) << component.getDouble();
      return typedLiteralBinding(
          slot,
          out.str(),
          "http://www.w3.org/2001/XMLSchema#double");
    }
  }
  if constexpr (HasInlineBoolComponent<Component>::value) {
    if (component.isBool()) {
      return typedLiteralBinding(
          slot,
          component.getBool() ? "true" : "false",
          "http://www.w3.org/2001/XMLSchema#boolean");
    }
  }
  return std::nullopt;
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
  return inlineValueBindingFromComponent(component, 0);
}

inline bool appendConstantBinding(
    const TripleComponent& component,
    uint32_t slot,
    BridgeQueryPlan& plan) {
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
  auto inline_binding = inlineValueBindingFromComponent(component, slot);
  if (inline_binding.has_value()) {
    plan.term_bindings.push_back(std::move(*inline_binding));
    return true;
  }
  return false;
}

inline bool bindableComponent(
    const TripleComponent& component,
    std::string_view expected_variable,
    uint32_t slot,
    BridgeQueryPlan& plan) {
  if (component.isVariable()) {
    return component.getVariable().name() == expected_variable;
  }
  return appendConstantBinding(component, slot, plan);
}

inline bool bindableAnyComponent(
    const TripleComponent& component,
    uint32_t slot,
    BridgeQueryPlan& plan) {
  if (component.isVariable()) {
    return true;
  }
  return appendConstantBinding(component, slot, plan);
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

inline void applyPlanGraphScope(BridgeQueryPlan& plan) noexcept {
  for (BridgeFilterScan& filter : plan.filter_scans) {
    filter.scan.graph_scope = plan.scan.graph_scope;
  }
  for (BridgeTextCandidateSource& source : plan.text_sources) {
    source.request.graph_scope = plan.scan.graph_scope;
  }
  for (BridgeVectorCandidateSource& source : plan.vector_sources) {
    source.request.graph_scope = plan.scan.graph_scope;
  }
}

inline xpod_rdf_status bindGraphScopeBindings(
    const xpod::rdf::PhysicalBackend& backend,
    const xpod_rdf_snapshot& snapshot,
    BridgeQueryPlan& plan,
    std::string& error_storage) {
  if (plan.graph_scope_bindings.empty()) {
    return XPOD_RDF_STATUS_OK;
  }
  if (plan.scan.graph_scope.kind != XPOD_RDF_GRAPH_SCOPE_ALL) {
    error_storage = "unsupported overlapping QLever graph scopes";
    return XPOD_RDF_STATUS_UNSUPPORTED;
  }

  std::vector<xpod_rdf_term> terms;
  terms.reserve(plan.graph_scope_bindings.size());
  for (const BridgeTermBinding& binding : plan.graph_scope_bindings) {
    terms.push_back(toNativeTerm(binding));
  }

  std::vector<xpod_rdf_term_key> keys(terms.size());
  std::vector<xpod_rdf_status> statuses(terms.size());
  xpod_rdf_status status = backend.lookupTerms(
      terms.data(), terms.size(), snapshot, keys.data(), statuses.data());
  if (status != XPOD_RDF_STATUS_OK) {
    error_storage = "failed to lookup QLever graph scope constants";
    return status;
  }

  plan.graph_scope_storage.clear();
  for (size_t index = 0; index < statuses.size(); ++index) {
    if (statuses[index] == XPOD_RDF_STATUS_NOT_FOUND) {
      continue;
    }
    if (statuses[index] != XPOD_RDF_STATUS_OK) {
      error_storage = "failed to lookup one or more QLever graph scope constants";
      return statuses[index];
    }
    plan.graph_scope_storage.push_back(keys[index]);
  }
  if (plan.graph_scope_storage.empty()) {
    plan.known_empty = true;
    return XPOD_RDF_STATUS_OK;
  }
  if (plan.graph_scope_storage.size() == 1) {
    plan.scan.graph_scope = {
        XPOD_RDF_GRAPH_SCOPE_EXACT,
        plan.graph_scope_storage.front(),
        {},
        nullptr,
        0,
    };
  } else {
    plan.scan.graph_scope = {
        XPOD_RDF_GRAPH_SCOPE_SET,
        0,
        {},
        plan.graph_scope_storage.data(),
        plan.graph_scope_storage.size(),
    };
  }
  applyPlanGraphScope(plan);
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
  plan.root.value_width = plan.output_variables.size();
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
    BridgeResultModifier* modifier =
        &plan.root.result_modifiers[binding.modifier_index];
    for (size_t child_index : binding.child_indexes) {
      if (child_index >= modifier->child_modifiers.size()) {
        error_storage =
            "QLever filter modifier binding references missing child modifier";
        return XPOD_RDF_STATUS_UNSUPPORTED;
      }
      modifier = &modifier->child_modifiers[child_index];
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
      if (std::optional<uint64_t> inline_bits =
              inlineTypedLiteralBits(term);
          inline_bits.has_value()) {
        if (modifier->kind == BridgeResultModifierKind::InTerm ||
            modifier->kind == BridgeResultModifierKind::NotInTerm) {
          modifier->term_id_bits_list.push_back(*inline_bits);
        } else {
          modifier->term_id_bits = *inline_bits;
          modifier->has_term_id_bits = true;
        }
      }
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
    if (modifier->kind == BridgeResultModifierKind::InTerm ||
        modifier->kind == BridgeResultModifierKind::NotInTerm) {
      modifier->term_id_bits_list.push_back(bits);
    } else {
      modifier->term_id_bits = bits;
      modifier->has_term_id_bits = true;
    }
  }
  return XPOD_RDF_STATUS_OK;
}

inline bool isValueRangeScanFilter(xpod_rdf_scan_filter_kind kind) noexcept {
  return kind == XPOD_RDF_SCAN_FILTER_VALUE_GREATER_THAN ||
         kind == XPOD_RDF_SCAN_FILTER_VALUE_GREATER_THAN_OR_EQUAL ||
         kind == XPOD_RDF_SCAN_FILTER_VALUE_LESS_THAN ||
         kind == XPOD_RDF_SCAN_FILTER_VALUE_LESS_THAN_OR_EQUAL;
}

inline bool canUsePhysicalFilterBridge(
    const xpod::rdf::PhysicalBackend& backend,
    const BridgeQueryPlan& plan) noexcept {
  if (plan.root.kind != BridgeOperationKind::PermutationScan ||
      !plan.child_plans.empty() || plan.scan.filters.empty() ||
      !backend.supportsScanFilter()) {
    return false;
  }
  return std::none_of(
      plan.scan.filters.begin(),
      plan.scan.filters.end(),
      [&](const xpod_rdf_scan_filter& filter) {
        return isValueRangeScanFilter(filter.kind) &&
               !backend.supportsScanValueRange();
      });
}

inline xpod_rdf_status bindScanFilterTermBindings(
    const xpod::rdf::PhysicalBackend& backend,
    const xpod_rdf_snapshot& snapshot,
    BridgeQueryPlan& plan,
    std::string& error_storage) {
  if (!backend.supportsScanFilter()) {
    plan.scan.filters.clear();
    plan.scan.filter_operands.clear();
    plan.scan.filter_values.clear();
    plan.scan_filter_term_bindings.clear();
    return XPOD_RDF_STATUS_OK;
  }
  if (!backend.supportsScanValueRange()) {
    std::vector<xpod_rdf_scan_filter> retained_filters;
    std::vector<std::optional<ScanFilterOperandStorage>> retained_operands;
    std::vector<std::optional<std::string>> retained_values;
    std::vector<size_t> remapped_indexes(
        plan.scan.filters.size(), std::numeric_limits<size_t>::max());
    retained_filters.reserve(plan.scan.filters.size());
    retained_operands.reserve(plan.scan.filters.size());
    retained_values.reserve(plan.scan.filters.size());
    for (size_t index = 0; index < plan.scan.filters.size(); ++index) {
      const xpod_rdf_scan_filter_kind kind = plan.scan.filters[index].kind;
      if (isValueRangeScanFilter(kind)) {
        continue;
      }
      remapped_indexes[index] = retained_filters.size();
      retained_filters.push_back(plan.scan.filters[index]);
      retained_operands.push_back(
          index < plan.scan.filter_operands.size()
              ? plan.scan.filter_operands[index]
              : std::optional<ScanFilterOperandStorage>{});
      retained_values.push_back(
          index < plan.scan.filter_values.size()
              ? plan.scan.filter_values[index]
              : std::optional<std::string>{});
    }
    for (BridgeScanFilterTermBinding& binding :
         plan.scan_filter_term_bindings) {
      if (binding.filter_index < remapped_indexes.size()) {
        binding.filter_index = remapped_indexes[binding.filter_index];
      }
    }
    plan.scan.filters = std::move(retained_filters);
    plan.scan.filter_operands = std::move(retained_operands);
    plan.scan.filter_values = std::move(retained_values);
  }
  if (plan.scan_filter_term_bindings.empty()) {
    return XPOD_RDF_STATUS_OK;
  }
  std::vector<bool> remove_filter(plan.scan.filters.size(), false);
  for (const BridgeScanFilterTermBinding& binding :
       plan.scan_filter_term_bindings) {
    if (binding.filter_index >= plan.scan.filters.size()) {
      error_storage = "QLever scan filter binding references missing filter";
      return XPOD_RDF_STATUS_UNSUPPORTED;
    }
    xpod_rdf_term term = toNativeTerm(binding.term);
    xpod_rdf_term_key key = 0;
    xpod_rdf_status term_status = XPOD_RDF_STATUS_OK;
    const xpod_rdf_status status = backend.lookupTerms(
        &term, 1, snapshot, &key, &term_status);
    if (status != XPOD_RDF_STATUS_OK) {
      error_storage = "failed to lookup QLever scan filter constant";
      return status;
    }
    if (term_status == XPOD_RDF_STATUS_NOT_FOUND) {
      remove_filter[binding.filter_index] = true;
      continue;
    }
    if (term_status != XPOD_RDF_STATUS_OK) {
      error_storage = "failed to lookup QLever scan filter constant";
      return term_status;
    }
    plan.scan.filters[binding.filter_index].term = key;
  }
  if (std::find(remove_filter.begin(), remove_filter.end(), true) !=
      remove_filter.end()) {
    std::vector<xpod_rdf_scan_filter> retained;
    std::vector<std::optional<ScanFilterOperandStorage>> retained_operands;
    std::vector<std::optional<std::string>> retained_values;
    retained.reserve(plan.scan.filters.size());
    retained_operands.reserve(plan.scan.filters.size());
    retained_values.reserve(plan.scan.filters.size());
    for (size_t index = 0; index < plan.scan.filters.size(); ++index) {
      if (!remove_filter[index]) {
        retained.push_back(plan.scan.filters[index]);
        retained_operands.push_back(
            index < plan.scan.filter_operands.size()
                ? plan.scan.filter_operands[index]
                : std::optional<ScanFilterOperandStorage>{});
        retained_values.push_back(
            index < plan.scan.filter_values.size()
                ? plan.scan.filter_values[index]
                : std::optional<std::string>{});
      }
    }
    plan.scan.filters = std::move(retained);
    plan.scan.filter_operands = std::move(retained_operands);
    plan.scan.filter_values = std::move(retained_values);
  }
  return XPOD_RDF_STATUS_OK;
}

inline void replacePlanWithEmptyValues(BridgeQueryPlan& plan) {
  BridgeQueryPlan empty;
  empty.descriptor = "Empty " + plan.descriptor;
  empty.output_variables = std::move(plan.output_variables);
  empty.result_width = empty.output_variables.size();
  empty.root.kind = BridgeOperationKind::Values;
  empty.root.value_width = empty.result_width;
  plan = std::move(empty);
}

inline bool knownEmptyChildCanStayLocal(
    BridgeOperationKind parent_kind,
    size_t child_index) {
  if (parent_kind == BridgeOperationKind::Union) {
    return true;
  }
  if (child_index == 1 &&
      (parent_kind == BridgeOperationKind::Minus ||
       parent_kind == BridgeOperationKind::OptionalJoin ||
       parent_kind == BridgeOperationKind::ExistsJoin)) {
    return true;
  }
  return false;
}

inline bool resultModifierReferencesExistsChild(
    const BridgeResultModifier& modifier,
    size_t child_index) {
  if (modifier.kind == BridgeResultModifierKind::Exists &&
      modifier.exists_child_index == child_index) {
    return true;
  }
  for (const BridgeResultModifier& child : modifier.child_modifiers) {
    if (resultModifierReferencesExistsChild(child, child_index)) {
      return true;
    }
  }
  return false;
}

inline bool resultModifiersReferenceExistsChild(
    const std::vector<BridgeResultModifier>& modifiers,
    size_t child_index) {
  for (const BridgeResultModifier& modifier : modifiers) {
    if (resultModifierReferencesExistsChild(modifier, child_index)) {
      return true;
    }
  }
  return false;
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
  status = bindGraphScopeBindings(backend, snapshot, plan, error_storage);
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
  status = bindScanFilterTermBindings(
      backend, snapshot, plan, error_storage);
  if (status != XPOD_RDF_STATUS_OK) {
    return status;
  }
  status = bindModifierTermBindings(backend, snapshot, plan, error_storage);
  if (status != XPOD_RDF_STATUS_OK) {
    return status;
  }
  for (size_t child_index = 0; child_index < plan.child_plans.size();
       ++child_index) {
    BridgeQueryPlan& child = plan.child_plans[child_index];
    status = bindPlanTerms(backend, snapshot, child, error_storage);
    if (status != XPOD_RDF_STATUS_OK) {
      return status;
    }
    if (child.known_empty) {
      if (knownEmptyChildCanStayLocal(plan.root.kind, child_index) ||
          resultModifiersReferenceExistsChild(
              plan.root.result_modifiers, child_index)) {
        replacePlanWithEmptyValues(child);
        continue;
      }
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

inline Permutation::Enum fallbackPermutationForTriple(
    const SparqlTripleSimple& triple,
    uint32_t preferred_variable_slot = 0) {
  const bool fixed_subject = !triple.s_.isVariable();
  const bool fixed_predicate = !triple.p_.isVariable();
  const bool fixed_object = !triple.o_.isVariable();
  if (fixed_subject && fixed_predicate) {
    return Permutation::Enum::SPO;
  }
  if (fixed_subject && fixed_object) {
    return Permutation::Enum::SOP;
  }
  if (fixed_predicate && fixed_object) {
    return Permutation::Enum::POS;
  }
  if (fixed_predicate) {
    return preferred_variable_slot == XPOD_RDF_SLOT_OBJECT
        ? Permutation::Enum::POS
        : Permutation::Enum::PSO;
  }
  if (fixed_subject) {
    return preferred_variable_slot == XPOD_RDF_SLOT_OBJECT
        ? Permutation::Enum::SOP
        : Permutation::Enum::SPO;
  }
  if (fixed_object) {
    return preferred_variable_slot == XPOD_RDF_SLOT_PREDICATE
        ? Permutation::Enum::OPS
        : Permutation::Enum::OSP;
  }
  return Permutation::Enum::SPO;
}

inline void initializeScanPlan(
    BridgeQueryPlan& plan,
    const SparqlTripleSimple& triple) {
  plan.scan.permutation = fallbackPermutationForTriple(triple);
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
  plan.allow_scan_filter_pushdown = true;
}

inline void initializeFilterScan(
    BridgeFilterScan& filter,
    const SparqlTripleSimple& triple,
    uint32_t join_slot) {
  filter.scan.permutation = fallbackPermutationForTriple(triple, join_slot);
  filter.scan.needed_slots = XPOD_RDF_SLOT_SUBJECT | XPOD_RDF_SLOT_PREDICATE |
                             XPOD_RDF_SLOT_OBJECT;
  filter.join_slot = XPOD_RDF_SLOT_SUBJECT;
  filter.descriptor = "xpod subject filter scan";
}

inline std::optional<BridgeQueryPlan> planSingleTriple(
    const SparqlTripleSimple& triple) {
  if (triple.p_.isIri() && triple.o_.isVariable()) {
    std::optional<std::pair<std::string, std::string>> language_predicate =
        languagePredicateFromIriValue(iriValueFromComponent(triple.p_));
    if (language_predicate.has_value()) {
      BridgeQueryPlan plan;
      if (!bindableAnyComponent(triple.s_, XPOD_RDF_SLOT_SUBJECT, plan)) {
        return std::nullopt;
      }
      BridgeTermBinding predicate;
      predicate.slot = XPOD_RDF_SLOT_PREDICATE;
      predicate.kind = XPOD_RDF_TERM_IRI;
      predicate.value = std::move(language_predicate->second);
      plan.term_bindings.push_back(std::move(predicate));
      initializeScanPlan(plan, triple);

      xpod_rdf_scan_filter filter = {};
      filter.slot = XPOD_RDF_SLOT_OBJECT;
      filter.kind = XPOD_RDF_SCAN_FILTER_LANGUAGE_EQUAL;
      const size_t filter_index = plan.scan.filters.size();
      plan.scan.filters.push_back(filter);
      setScanFilterValue(plan.scan, filter_index, language_predicate->first);

      BridgeResultModifier modifier;
      modifier.kind = BridgeResultModifierKind::LanguageEqual;
      std::optional<ColumnIndex> column = outputColumnForVariable(
          plan.output_variables, bridgeComponentVariableName(triple.o_));
      if (!column.has_value()) {
        return std::nullopt;
      }
      modifier.columns.push_back(*column);
      modifier.string_value = std::move(language_predicate->first);
      plan.root.result_modifiers.push_back(std::move(modifier));
      if (plan.descriptor.find("Filter") == std::string::npos) {
        plan.descriptor += " + Filter";
      }
      return plan;
    }
  }
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
  initializeFilterScan(filter, second, second_join_slots.front());
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

inline void appendGraphScopeProjection(
    BridgeQueryPlan& plan,
    const BridgeGraphScope& graph_scope);

inline std::optional<BridgeQueryPlan> planSingleTripleFallback(
    const SparqlTripleSimple& triple,
    const std::optional<BridgeGraphScope>& graph_scope) {
  auto plan = planSingleTriple(triple);
  if (!plan.has_value()) {
    return std::nullopt;
  }
  if (graph_scope.has_value() && graph_scope->binding.has_value()) {
    plan->term_bindings.push_back(*graph_scope->binding);
  }
  if (graph_scope.has_value() &&
      !graph_scope->graph_scope_bindings.empty()) {
    plan->graph_scope_bindings = graph_scope->graph_scope_bindings;
  }
  if (graph_scope.has_value() && graph_scope->graph_scope_known_empty) {
    plan->known_empty = true;
  }
  if (graph_scope.has_value()) {
    appendGraphScopeProjection(*plan, *graph_scope);
  }
  return plan;
}

inline std::optional<BridgeQueryPlan> appendBasicPatternJoin(
    BridgeQueryPlan left,
    BridgeQueryPlan right) {
  BridgeQueryPlan plan;
  plan.descriptor =
      "MultiColumnJoin (" + left.descriptor + ", " + right.descriptor + ")";
  plan.sorted_by = left.sorted_by;
  plan.root.kind = BridgeOperationKind::MultiColumnJoin;
  plan.root.sorted_by = plan.sorted_by;
  plan.root.matched_columns = matchedOutputVariableColumns(
      left.output_variables, right.output_variables);
  if (plan.root.matched_columns.empty()) {
    return std::nullopt;
  }
  plan.root.right_projection_columns = rightProjectionColumns(
      left.output_variables, right.output_variables);
  plan.output_variables = left.output_variables;
  for (size_t column : plan.root.right_projection_columns) {
    if (column >= right.output_variables.size()) {
      return std::nullopt;
    }
    plan.output_variables.push_back(right.output_variables[column]);
  }
  plan.result_width = plan.output_variables.size();
  plan.child_plans.push_back(std::move(left));
  plan.child_plans.push_back(std::move(right));
  return plan;
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

inline std::optional<BridgeGraphScope> mergeBridgeGraphScopes(
    const std::optional<BridgeGraphScope>& inherited,
    const std::optional<BridgeGraphScope>& local) {
  if (!inherited.has_value()) {
    return local;
  }
  if (!local.has_value()) {
    return inherited;
  }

  BridgeGraphScope merged = *inherited;
  if (local->binding.has_value()) {
    if (merged.binding.has_value()) {
      return std::nullopt;
    }
    merged.binding = local->binding;
  }
  if (local->variable.has_value()) {
    if (merged.variable.has_value() &&
        *merged.variable != *local->variable) {
      return std::nullopt;
    }
    merged.variable = local->variable;
  }
  if (!local->graph_scope_bindings.empty()) {
    if (!merged.graph_scope_bindings.empty()) {
      return std::nullopt;
    }
    merged.graph_scope_bindings = local->graph_scope_bindings;
  }
  merged.graph_scope_known_empty =
      merged.graph_scope_known_empty || local->graph_scope_known_empty;
  merged.implicit_default_graph = false;
  return merged;
}

inline std::optional<BridgeGraphScope> graphScopeForLocalGroup(
    const std::optional<BridgeGraphScope>& inherited,
    const std::optional<BridgeGraphScope>& local) {
  if (!local.has_value()) {
    return inherited;
  }
  if (inherited.has_value() && inherited->implicit_default_graph) {
    return local;
  }
  return mergeBridgeGraphScopes(inherited, local);
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

inline const parsedQuery::Optional* optionalFromOperation(
    const parsedQuery::GraphPatternOperation& operation) {
  return std::get_if<parsedQuery::Optional>(
      &static_cast<const parsedQuery::GraphPatternOperationVariant&>(operation));
}

inline const parsedQuery::Minus* minusFromOperation(
    const parsedQuery::GraphPatternOperation& operation) {
  return std::get_if<parsedQuery::Minus>(
      &static_cast<const parsedQuery::GraphPatternOperationVariant&>(operation));
}

inline const parsedQuery::Union* unionFromOperation(
    const parsedQuery::GraphPatternOperation& operation) {
  return std::get_if<parsedQuery::Union>(
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
  plan.root.value_width = plan.result_width;

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

inline bool outerFilterParensWrapWholeExpression(std::string_view value) {
  value = trimFilterToken(value);
  if (value.size() < 2 || value.front() != '(' || value.back() != ')') {
    return false;
  }

  int paren_depth = 0;
  int iri_depth = 0;
  bool in_string = false;
  bool escaped = false;
  for (size_t index = 0; index < value.size(); ++index) {
    char c = value[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (in_string) {
      if (c == '\\') {
        escaped = true;
      } else if (c == '"') {
        in_string = false;
      }
      continue;
    }
    if (c == '"') {
      in_string = true;
      continue;
    }
    if (c == '<') {
      ++iri_depth;
      continue;
    }
    if (c == '>' && iri_depth > 0) {
      --iri_depth;
      continue;
    }
    if (iri_depth > 0) {
      continue;
    }
    if (c == '(') {
      ++paren_depth;
      continue;
    }
    if (c == ')') {
      --paren_depth;
      if (paren_depth == 0 && index + 1 < value.size()) {
        return false;
      }
    }
  }
  return paren_depth == 0 && !in_string && iri_depth == 0;
}

inline std::string_view stripOuterFilterParens(std::string_view value) {
  value = trimFilterToken(value);
  while (outerFilterParensWrapWholeExpression(value)) {
    value.remove_prefix(1);
    value.remove_suffix(1);
    value = trimFilterToken(value);
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

inline std::optional<BridgeTermBinding> literalFilterBindingFromToken(
    std::string_view token) {
  token = trimFilterToken(token);
  if (token.empty() || token.front() != '"') {
    return std::nullopt;
  }

  size_t end = 1;
  bool escaped = false;
  for (; end < token.size(); ++end) {
    char c = token[end];
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
  if (end >= token.size()) {
    return std::nullopt;
  }

  BridgeTermBinding binding;
  binding.kind = XPOD_RDF_TERM_LITERAL;
  binding.value = std::string(token.substr(1, end - 1));

  std::string_view suffix(token.data() + end + 1, token.size() - end - 1);
  if (suffix.empty()) {
    return binding;
  }
  if (suffix.front() == '@') {
    binding.language = std::string(suffix.substr(1));
    return binding;
  }
  if (suffix.size() >= 4 && suffix.substr(0, 3) == "^^<" &&
      suffix.back() == '>') {
    binding.datatype_iri = std::string(suffix.substr(3, suffix.size() - 4));
    return binding;
  }
  return std::nullopt;
}

inline bool isFilterIntegerToken(std::string_view token) {
  token = trimFilterToken(token);
  if (token.empty()) {
    return false;
  }
  size_t index = 0;
  if (token.front() == '+' || token.front() == '-') {
    index = 1;
  }
  if (index == token.size()) {
    return false;
  }
  for (; index < token.size(); ++index) {
    if (std::isdigit(static_cast<unsigned char>(token[index])) == 0) {
      return false;
    }
  }
  return true;
}

inline bool isFilterDoubleToken(std::string_view token) {
  token = trimFilterToken(token);
  if (token.empty()) {
    return false;
  }
  size_t index = 0;
  if (token.front() == '+' || token.front() == '-') {
    index = 1;
  }
  bool saw_digit = false;
  bool saw_dot = false;
  bool saw_exponent = false;
  for (; index < token.size(); ++index) {
    char c = token[index];
    if (std::isdigit(static_cast<unsigned char>(c)) != 0) {
      saw_digit = true;
      continue;
    }
    if (c == '.' && !saw_dot && !saw_exponent) {
      saw_dot = true;
      continue;
    }
    if ((c == 'e' || c == 'E') && saw_digit && !saw_exponent) {
      saw_exponent = true;
      if (index + 1 < token.size() &&
          (token[index + 1] == '+' || token[index + 1] == '-')) {
        ++index;
      }
      if (index + 1 == token.size()) {
        return false;
      }
      continue;
    }
    return false;
  }
  return saw_digit && (saw_dot || saw_exponent);
}

inline std::optional<BridgeTermBinding> inlineFilterBindingFromToken(
    std::string_view token) {
  token = trimFilterToken(token);
  if (token == "true" || token == "false") {
    return typedLiteralBinding(
        XPOD_RDF_SLOT_OBJECT,
        std::string(token),
        "http://www.w3.org/2001/XMLSchema#boolean");
  }
  if (isFilterIntegerToken(token)) {
    return typedLiteralBinding(
        XPOD_RDF_SLOT_OBJECT,
        std::string(token),
        "http://www.w3.org/2001/XMLSchema#integer");
  }
  if (isFilterDoubleToken(token)) {
    return typedLiteralBinding(
        XPOD_RDF_SLOT_OBJECT,
        std::string(token),
        "http://www.w3.org/2001/XMLSchema#double");
  }
  return std::nullopt;
}

inline std::optional<BridgeTermBinding> filterBindingFromToken(
    std::string_view token) {
  if (auto iri = iriFilterBindingFromToken(token); iri.has_value()) {
    return iri;
  }
  if (auto literal = literalFilterBindingFromToken(token);
      literal.has_value()) {
    return literal;
  }
  return inlineFilterBindingFromToken(token);
}

inline bool filterKnownFalseUnboundVariableTerm(
    const BridgeQueryPlan& plan,
    std::string_view left,
    std::string_view right) {
  auto variable_side_is_known_false =
      [&plan](std::string_view variable_token,
              std::string_view term_token) -> bool {
    variable_token = trimFilterToken(variable_token);
    term_token = trimFilterToken(term_token);
    if (variable_token.size() < 2 || variable_token.front() != '?') {
      return false;
    }
    std::string variable(variable_token.substr(1));
    if (outputColumnForVariable(plan.output_variables, variable).has_value()) {
      return false;
    }
    return filterBindingFromToken(term_token).has_value();
  };

  return variable_side_is_known_false(left, right) ||
      variable_side_is_known_false(right, left);
}

inline void appendAlwaysFalseFilterModifier(BridgeQueryPlan& plan) {
  BridgeResultModifier modifier;
  modifier.kind = BridgeResultModifierKind::AlwaysFalse;
  plan.root.result_modifiers.push_back(std::move(modifier));
  if (plan.descriptor.find("Filter") == std::string::npos) {
    plan.descriptor += " + Filter";
  }
}

inline bool modifierContainsAlwaysFalse(
    const BridgeResultModifier& modifier) {
  if (modifier.kind == BridgeResultModifierKind::AlwaysFalse) {
    return true;
  }
  for (const BridgeResultModifier& child : modifier.child_modifiers) {
    if (modifierContainsAlwaysFalse(child)) {
      return true;
    }
  }
  return false;
}

inline bool filterVariableAndTerm(
    const BridgeQueryPlan& plan,
    std::string_view left,
    std::string_view right,
    ColumnIndex& column,
    BridgeTermBinding& term) {
  auto bind_variable_side =
      [&](std::string_view variable_token,
          std::string_view term_token) -> bool {
    if (variable_token.size() < 2 || variable_token.front() != '?') {
      return false;
    }
    std::string variable(variable_token.substr(1));
    std::optional<ColumnIndex> maybe_column =
        outputColumnForVariable(plan.output_variables, variable);
    std::optional<BridgeTermBinding> maybe_term =
        filterBindingFromToken(term_token);
    if (!maybe_column.has_value() || !maybe_term.has_value()) {
      return false;
    }
    column = *maybe_column;
    term = std::move(*maybe_term);
    return true;
  };

  return bind_variable_side(left, right) || bind_variable_side(right, left);
}

inline std::vector<std::string_view> splitFilterTermList(
    std::string_view list) {
  std::vector<std::string_view> terms;
  size_t start = 0;
  bool in_string = false;
  bool escaped = false;
  int iri_depth = 0;
  for (size_t index = 0; index < list.size(); ++index) {
    char c = list[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (in_string) {
      if (c == '\\') {
        escaped = true;
      } else if (c == '"') {
        in_string = false;
      }
      continue;
    }
    if (c == '"') {
      in_string = true;
      continue;
    }
    if (c == '<') {
      ++iri_depth;
      continue;
    }
    if (c == '>' && iri_depth > 0) {
      --iri_depth;
      continue;
    }
    if (c == ',' && iri_depth == 0) {
      terms.push_back(trimFilterToken(list.substr(start, index - start)));
      start = index + 1;
    }
  }
  terms.push_back(trimFilterToken(list.substr(start)));
  return terms;
}

inline bool filterVariableAndTermList(
    const BridgeQueryPlan& plan,
    std::string_view left,
    std::string_view right,
    ColumnIndex& column,
    std::vector<BridgeTermBinding>& terms) {
  if (left.size() < 2 || left.front() != '?') {
    return false;
  }
  std::string variable(left.substr(1));
  std::optional<ColumnIndex> maybe_column =
      outputColumnForVariable(plan.output_variables, variable);
  if (!maybe_column.has_value()) {
    return false;
  }
  right = trimFilterToken(right);
  if (right.size() < 2 || right.front() != '(' || right.back() != ')') {
    return false;
  }
  std::vector<BridgeTermBinding> parsed_terms;
  for (std::string_view term_token :
       splitFilterTermList(right.substr(1, right.size() - 2))) {
    if (term_token.empty()) {
      return false;
    }
    std::optional<BridgeTermBinding> term =
        filterBindingFromToken(term_token);
    if (!term.has_value()) {
      return false;
    }
    parsed_terms.push_back(std::move(*term));
  }
  if (parsed_terms.empty()) {
    return false;
  }
  column = *maybe_column;
  terms = std::move(parsed_terms);
  return true;
}

inline std::optional<std::pair<ColumnIndex, BridgeStringValueTransform>>
filterStringValueColumnAndTransformFromToken(
    const BridgeQueryPlan& plan,
    std::string_view token,
    bool allow_raw_variable) {
  token = trimFilterToken(token);
  BridgeStringValueTransform transform = BridgeStringValueTransform::None;
  constexpr std::string_view lcase_prefix = "LCASE(";
  constexpr std::string_view ucase_prefix = "UCASE(";
  std::string_view case_prefix = {};
  if (token.rfind(lcase_prefix, 0) == 0) {
    transform = BridgeStringValueTransform::Lowercase;
    case_prefix = lcase_prefix;
  } else if (token.rfind(ucase_prefix, 0) == 0) {
    transform = BridgeStringValueTransform::Uppercase;
    case_prefix = ucase_prefix;
  }
  if (!case_prefix.empty()) {
    if (token.size() <= case_prefix.size() || token.back() != ')') {
      return std::nullopt;
    }
    token = trimFilterToken(token.substr(
        case_prefix.size(), token.size() - case_prefix.size() - 1));
    constexpr std::string_view str_prefix = "STR(";
    if (token.rfind(str_prefix, 0) != 0 || token.size() <= str_prefix.size() ||
        token.back() != ')') {
      return std::nullopt;
    }
    token = trimFilterToken(
        token.substr(str_prefix.size(), token.size() - str_prefix.size() - 1));
  } else {
    bool had_str_function = false;
    constexpr std::string_view str_prefix = "STR(";
    if (token.rfind(str_prefix, 0) == 0 && token.size() > str_prefix.size() &&
        token.back() == ')') {
      had_str_function = true;
      token = trimFilterToken(
          token.substr(str_prefix.size(), token.size() - str_prefix.size() - 1));
    }
    if (!had_str_function && !allow_raw_variable) {
      return std::nullopt;
    }
  }
  if (token.size() < 2 || token.front() != '?') {
    return std::nullopt;
  }
  std::optional<ColumnIndex> column = outputColumnForVariable(
      plan.output_variables, std::string(token.substr(1)));
  if (!column.has_value()) {
    return std::nullopt;
  }
  return std::pair<ColumnIndex, BridgeStringValueTransform>{
      *column, transform};
}

inline uint32_t scanSlotForFilterColumn(
    const BridgeQueryPlan& plan,
    ColumnIndex column) noexcept;

inline std::optional<xpod_rdf_scan_filter_kind> scanFilterKindForString(
    BridgeStringFilterKind kind) noexcept {
  switch (kind) {
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
}

inline bool tryPushStringPredicate(
    BridgeQueryPlan& plan,
    ColumnIndex column,
    BridgeStringFilterKind kind,
    BridgeStringValueTransform transform,
    bool negated,
    const std::string& value) {
  const uint32_t slot = scanSlotForFilterColumn(plan, column);
  const std::optional<xpod_rdf_scan_filter_kind> filter_kind =
      scanFilterKindForString(kind);
  if (slot == 0 || !filter_kind.has_value() ||
      transform != BridgeStringValueTransform::None) {
    return false;
  }
  xpod_rdf_scan_filter filter = {};
  filter.slot = slot;
  filter.kind = *filter_kind;
  filter.negated = negated ? 1 : 0;
  const size_t filter_index = plan.scan.filters.size();
  plan.scan.filters.push_back(filter);
  setScanFilterValue(plan.scan, filter_index, value);
  return true;
}

inline std::optional<std::string_view> physicalFallbackReasonForTransform(
    BridgeStringValueTransform transform) noexcept {
  switch (transform) {
    case BridgeStringValueTransform::Lowercase:
      return std::string_view{"string-transform-lowercase-unsupported"};
    case BridgeStringValueTransform::Uppercase:
      return std::string_view{"string-transform-uppercase-unsupported"};
    case BridgeStringValueTransform::None:
      return std::nullopt;
  }
  return std::nullopt;
}

inline void recordPhysicalFilterFallbackIfFirst(
    BridgeQueryPlan& plan,
    BridgeStringValueTransform transform,
    std::string_view expression) {
  if (plan.physical_filter_fallback.has_value()) {
    return;
  }
  std::optional<std::string_view> reason =
      physicalFallbackReasonForTransform(transform);
  if (!reason.has_value()) {
    return;
  }
  plan.physical_filter_fallback = BridgePhysicalFilterFallback{
      std::string(*reason), std::string(expression)};
}

inline void movePhysicalFilterFallbackIfFirst(
    BridgeQueryPlan& target,
    BridgeQueryPlan& source) {
  if (!target.physical_filter_fallback.has_value() &&
      source.physical_filter_fallback.has_value()) {
    target.physical_filter_fallback =
        std::move(source.physical_filter_fallback);
  }
}

inline bool applyStringEqualsFilterDescriptor(
    BridgeQueryPlan& plan,
    std::string_view descriptor) {
  std::string_view original_descriptor = descriptor;
  descriptor = stripOuterFilterParens(descriptor);
  size_t separator = descriptor.find(" = ");
  bool negated = false;
  size_t operator_size = 3;
  if (separator == std::string_view::npos) {
    separator = descriptor.find(" != ");
    negated = true;
    operator_size = 4;
  }
  if (separator == std::string_view::npos) {
    return false;
  }
  std::string_view left = trimFilterToken(descriptor.substr(0, separator));
  std::string_view right =
      trimFilterToken(descriptor.substr(separator + operator_size));

  auto bind = [&](std::string_view value_token,
                  std::string_view literal_token) -> bool {
    std::optional<std::pair<ColumnIndex, BridgeStringValueTransform>> column =
        filterStringValueColumnAndTransformFromToken(
            plan, value_token, false);
    std::optional<BridgeTermBinding> literal =
        literalFilterBindingFromToken(literal_token);
    if (!column.has_value() || !literal.has_value() ||
        literal->kind != XPOD_RDF_TERM_LITERAL ||
        !literal->datatype_iri.empty() || !literal->language.empty()) {
      return false;
    }

    const bool pushed = tryPushStringPredicate(
        plan,
        column->first,
        BridgeStringFilterKind::Equals,
        column->second,
        negated,
        literal->value);
    if (!pushed) {
      recordPhysicalFilterFallbackIfFirst(
          plan, column->second, original_descriptor);
    }

    BridgeResultModifier modifier;
    modifier.kind = BridgeResultModifierKind::StringPredicate;
    modifier.columns.push_back(column->first);
    modifier.string_filter = BridgeStringFilterKind::Equals;
    modifier.string_transform = column->second;
    modifier.string_negated = negated;
    modifier.string_value = std::move(literal->value);
    plan.root.result_modifiers.push_back(std::move(modifier));
    if (plan.descriptor.find("Filter") == std::string::npos) {
      plan.descriptor += " + Filter";
    }
    return true;
  };

  return bind(left, right) || bind(right, left);
}


inline bool applyStringPredicateFilterDescriptor(
    BridgeQueryPlan& plan,
    std::string_view descriptor,
    std::string_view function_name,
    BridgeStringFilterKind filter_kind) {
  std::string_view original_descriptor = descriptor;
  descriptor = stripOuterFilterParens(descriptor);
  if (descriptor.rfind(function_name, 0) != 0 || descriptor.empty() ||
      descriptor.back() != ')') {
    return false;
  }

  std::string_view args = descriptor.substr(
      function_name.size(), descriptor.size() - function_name.size() - 1);
  std::vector<std::string_view> parts = splitFilterTermList(args);
  if (parts.size() != 2) {
    return false;
  }

  std::optional<std::pair<ColumnIndex, BridgeStringValueTransform>> column =
      filterStringValueColumnAndTransformFromToken(
          plan, parts[0], true);
  std::optional<BridgeTermBinding> literal =
      literalFilterBindingFromToken(parts[1]);
  if (!column.has_value() || !literal.has_value() ||
      literal->kind != XPOD_RDF_TERM_LITERAL ||
      !literal->datatype_iri.empty() || !literal->language.empty()) {
    return false;
  }

  const bool pushed = tryPushStringPredicate(
      plan,
      column->first,
      filter_kind,
      column->second,
      false,
      literal->value);
  if (!pushed) {
    recordPhysicalFilterFallbackIfFirst(
        plan, column->second, original_descriptor);
  }

  BridgeResultModifier modifier;
  modifier.kind = BridgeResultModifierKind::StringPredicate;
  modifier.columns.push_back(column->first);
  modifier.string_filter = filter_kind;
  modifier.string_transform = column->second;
  modifier.string_value = std::move(literal->value);
  plan.root.result_modifiers.push_back(std::move(modifier));
  if (plan.descriptor.find("Filter") == std::string::npos) {
    plan.descriptor += " + Filter";
  }
  return true;
}

inline std::optional<ColumnIndex> filterFunctionColumn(
    const BridgeQueryPlan& plan,
    std::string_view token,
    std::string_view function_name) {
  token = trimFilterToken(token);
  if (token.rfind(function_name, 0) != 0 ||
      token.size() <= function_name.size() || token.back() != ')') {
    return std::nullopt;
  }
  std::string_view variable = trimFilterToken(token.substr(
      function_name.size(), token.size() - function_name.size() - 1));
  if (variable.size() < 2 || variable.front() != '?') {
    return std::nullopt;
  }
  return outputColumnForVariable(
      plan.output_variables, std::string(variable.substr(1)));
}

inline bool applyTermMetadataFilterDescriptor(
    BridgeQueryPlan& plan,
    std::string_view descriptor,
    std::string_view function_name,
    BridgeResultModifierKind modifier_kind,
    xpod_rdf_scan_filter_kind scan_filter_kind) {
  descriptor = stripOuterFilterParens(descriptor);
  size_t separator = descriptor.find(" = ");
  bool negated = false;
  size_t operator_size = 3;
  if (separator == std::string_view::npos) {
    separator = descriptor.find(" != ");
    negated = true;
    operator_size = 4;
  }
  if (separator == std::string_view::npos) {
    return false;
  }
  std::string_view left = trimFilterToken(descriptor.substr(0, separator));
  std::string_view right =
      trimFilterToken(descriptor.substr(separator + operator_size));

  auto bind = [&](std::string_view function_token,
                  std::string_view expected_token) -> bool {
    std::optional<ColumnIndex> column =
        filterFunctionColumn(plan, function_token, function_name);
    std::optional<BridgeTermBinding> expected =
        filterBindingFromToken(expected_token);
    if (!column.has_value() || !expected.has_value()) {
      return false;
    }
    if (modifier_kind == BridgeResultModifierKind::LanguageEqual) {
      if (expected->kind != XPOD_RDF_TERM_LITERAL ||
          !expected->datatype_iri.empty() || !expected->language.empty()) {
        return false;
      }
    } else if (expected->kind != XPOD_RDF_TERM_IRI) {
      return false;
    }

    const uint32_t slot = scanSlotForFilterColumn(plan, *column);
    if (slot != 0) {
      xpod_rdf_scan_filter filter = {};
      filter.slot = slot;
      filter.kind = scan_filter_kind;
      filter.negated = negated ? 1 : 0;
      const size_t filter_index = plan.scan.filters.size();
      plan.scan.filters.push_back(filter);
      std::string physical_value = expected->value;
      if (modifier_kind == BridgeResultModifierKind::DatatypeEqual &&
          physical_value ==
              "http://www.w3.org/2001/XMLSchema#integer") {
        physical_value = "http://www.w3.org/2001/XMLSchema#int";
      }
      setScanFilterValue(plan.scan, filter_index, std::move(physical_value));
    }

    BridgeResultModifier modifier;
    modifier.kind = modifier_kind;
    modifier.columns.push_back(*column);
    modifier.string_negated = negated;
    modifier.string_value = std::move(expected->value);
    plan.root.result_modifiers.push_back(std::move(modifier));
    if (plan.descriptor.find("Filter") == std::string::npos) {
      plan.descriptor += " + Filter";
    }
    return true;
  };

  return bind(left, right) || bind(right, left);
}

inline bool applyLanguageFilterDescriptor(
    BridgeQueryPlan& plan,
    std::string_view descriptor) {
  return applyTermMetadataFilterDescriptor(
      plan,
      descriptor,
      "LANG(",
      BridgeResultModifierKind::LanguageEqual,
      XPOD_RDF_SCAN_FILTER_LANGUAGE_EQUAL);
}

inline bool applyDatatypeFilterDescriptor(
    BridgeQueryPlan& plan,
    std::string_view descriptor) {
  return applyTermMetadataFilterDescriptor(
      plan,
      descriptor,
      "DATATYPE(",
      BridgeResultModifierKind::DatatypeEqual,
      XPOD_RDF_SCAN_FILTER_DATATYPE_EQUAL);
}

inline std::optional<std::string> regexPrefixLiteralToPlainPrefix(
    std::string_view pattern) {
  if (pattern.size() < 2 || pattern.front() != '^') {
    return std::nullopt;
  }
  std::string_view prefix = pattern.substr(1);
  for (char c : prefix) {
    switch (c) {
      case '.':
      case '^':
      case '$':
      case '*':
      case '+':
      case '?':
      case '(':
      case ')':
      case '[':
      case ']':
      case '{':
      case '}':
      case '|':
      case '\\':
        return std::nullopt;
      default:
        break;
    }
  }
  return std::string(prefix);
}

inline bool applyRegexPrefixFilterDescriptor(
    BridgeQueryPlan& plan,
    std::string_view descriptor) {
  std::string_view original_descriptor = descriptor;
  descriptor = stripOuterFilterParens(descriptor);
  constexpr std::string_view function_name = "REGEX(";
  if (descriptor.rfind(function_name, 0) != 0 || descriptor.empty() ||
      descriptor.back() != ')') {
    return false;
  }

  std::string_view args = descriptor.substr(
      function_name.size(), descriptor.size() - function_name.size() - 1);
  std::vector<std::string_view> parts = splitFilterTermList(args);
  if (parts.size() != 2) {
    return false;
  }

  std::optional<std::pair<ColumnIndex, BridgeStringValueTransform>> column =
      filterStringValueColumnAndTransformFromToken(
          plan, parts[0], false);
  std::optional<BridgeTermBinding> literal =
      literalFilterBindingFromToken(parts[1]);
  if (!column.has_value() || !literal.has_value() ||
      literal->kind != XPOD_RDF_TERM_LITERAL ||
      !literal->datatype_iri.empty() || !literal->language.empty()) {
    return false;
  }
  std::optional<std::string> prefix =
      regexPrefixLiteralToPlainPrefix(literal->value);
  if (!prefix.has_value()) {
    return false;
  }

  BridgeResultModifier modifier;
  modifier.kind = BridgeResultModifierKind::StringPredicate;
  modifier.columns.push_back(column->first);
  modifier.string_filter = BridgeStringFilterKind::Prefix;
  modifier.string_transform = column->second;
  modifier.string_value = std::move(*prefix);
  if (column->second != BridgeStringValueTransform::None) {
    recordPhysicalFilterFallbackIfFirst(
        plan, column->second, original_descriptor);
  }
  plan.root.result_modifiers.push_back(std::move(modifier));
  if (plan.descriptor.find("Filter") == std::string::npos) {
    plan.descriptor += " + Filter";
  }
  return true;
}

inline bool tryPushTermNotEqual(
    BridgeQueryPlan& plan,
    ColumnIndex column,
    BridgeTermBinding term);

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
  ColumnIndex column = 0;
  BridgeTermBinding term;
  if (!filterVariableAndTerm(plan, left, right, column, term)) {
    if (filterKnownFalseUnboundVariableTerm(plan, left, right)) {
      appendAlwaysFalseFilterModifier(plan);
      return true;
    }
    return false;
  }

  (void)tryPushTermNotEqual(plan, column, term);

  BridgeResultModifier modifier;
  modifier.kind = BridgeResultModifierKind::NotEqualTerm;
  modifier.columns.push_back(column);
  size_t modifier_index = plan.root.result_modifiers.size();
  plan.root.result_modifiers.push_back(std::move(modifier));
  plan.modifier_term_bindings.push_back(
      BridgeModifierTermBinding{modifier_index, {}, std::move(term)});
  if (plan.descriptor.find("Filter") == std::string::npos) {
    plan.descriptor += " + Filter";
  }
  return true;
}

inline uint32_t scanSlotForFilterColumn(
    const BridgeQueryPlan& plan,
    ColumnIndex column) noexcept {
  if (plan.root.kind != BridgeOperationKind::PermutationScan ||
      !plan.allow_scan_filter_pushdown || !plan.child_plans.empty()) {
    return 0;
  }
  const char* slots = permutationSlots(plan.scan.permutation);
  const uint32_t needed_slots = normalizeNeededSlots(plan.scan.needed_slots);
  size_t output_column = 0;
  for (size_t index = 0; index < 3; ++index) {
    const uint32_t slot = slotMask(slots[index]);
    if ((needed_slots & slot) == 0) {
      continue;
    }
    if (output_column == column) {
      return slot;
    }
    ++output_column;
  }
  if ((plan.scan.needed_slots & XPOD_RDF_SLOT_GRAPH) != 0 &&
      output_column == column) {
    return XPOD_RDF_SLOT_GRAPH;
  }
  return 0;
}

inline bool tryPushTermNotEqual(
    BridgeQueryPlan& plan,
    ColumnIndex column,
    BridgeTermBinding term) {
  const uint32_t slot = scanSlotForFilterColumn(plan, column);
  if (slot == 0 || term.is_prefix) {
    return false;
  }
  xpod_rdf_scan_filter filter = {};
  filter.slot = slot;
  filter.kind = XPOD_RDF_SCAN_FILTER_TERM_NOT_EQUAL;
  const size_t filter_index = plan.scan.filters.size();
  plan.scan.filters.push_back(filter);
  plan.scan_filter_term_bindings.push_back(
      BridgeScanFilterTermBinding{filter_index, std::move(term)});
  if (plan.descriptor.find("Filter") == std::string::npos) {
    plan.descriptor += " + Filter";
  }
  return true;
}

inline bool tryPushExactTermEquality(
    BridgeQueryPlan& plan,
    ColumnIndex column,
    BridgeTermBinding term) {
  const uint32_t slot = scanSlotForFilterColumn(plan, column);
  if (slot == 0 || term.is_prefix) {
    return false;
  }
  for (const BridgeTermBinding& existing : plan.term_bindings) {
    if (existing.slot == slot) {
      return false;
    }
  }
  term.slot = slot;
  plan.term_bindings.push_back(std::move(term));
  if (plan.descriptor.find("Filter") == std::string::npos) {
    plan.descriptor += " + Filter";
  }
  return true;
}

inline bool applyEqualFilterDescriptor(
    BridgeQueryPlan& plan,
    std::string_view descriptor) {
  descriptor = stripOuterFilterParens(descriptor);
  size_t separator = descriptor.find(" = ");
  if (separator == std::string_view::npos) {
    return false;
  }
  std::string_view left = trimFilterToken(descriptor.substr(0, separator));
  std::string_view right = trimFilterToken(descriptor.substr(separator + 3));
  ColumnIndex column = 0;
  BridgeTermBinding term;
  if (!filterVariableAndTerm(plan, left, right, column, term)) {
    if (filterKnownFalseUnboundVariableTerm(plan, left, right)) {
      appendAlwaysFalseFilterModifier(plan);
      return true;
    }
    return false;
  }

  if (tryPushExactTermEquality(plan, column, term)) {
    return true;
  }

  BridgeResultModifier modifier;
  modifier.kind = BridgeResultModifierKind::EqualTerm;
  modifier.columns.push_back(column);
  size_t modifier_index = plan.root.result_modifiers.size();
  plan.root.result_modifiers.push_back(std::move(modifier));
  plan.modifier_term_bindings.push_back(
      BridgeModifierTermBinding{modifier_index, {}, std::move(term)});
  if (plan.descriptor.find("Filter") == std::string::npos) {
    plan.descriptor += " + Filter";
  }
  return true;
}

inline bool filterVariableAndTermForComparison(
    const BridgeQueryPlan& plan,
    std::string_view left,
    std::string_view right,
    BridgeResultModifierKind left_kind,
    BridgeResultModifierKind right_kind,
    ColumnIndex& column,
    BridgeTermBinding& term,
    BridgeResultModifierKind& kind) {
  auto bind_variable_side = [&plan, &column, &term, &kind](
      std::string_view variable_token,
      std::string_view term_token,
      BridgeResultModifierKind comparison_kind) -> bool {
    variable_token = trimFilterToken(variable_token);
    term_token = trimFilterToken(term_token);
    if (variable_token.empty() || variable_token.front() != '?') {
      return false;
    }
    std::string variable(variable_token.substr(1));
    std::optional<ColumnIndex> maybe_column =
        outputColumnForVariable(plan.output_variables, variable);
    std::optional<BridgeTermBinding> maybe_term =
        filterBindingFromToken(term_token);
    if (!maybe_column.has_value() || !maybe_term.has_value() ||
        maybe_term->kind != XPOD_RDF_TERM_LITERAL) {
      return false;
    }
    column = *maybe_column;
    term = std::move(*maybe_term);
    kind = comparison_kind;
    return true;
  };

  return bind_variable_side(left, right, left_kind) ||
      bind_variable_side(right, left, right_kind);
}

inline bool isRangePushdownDatatype(std::string_view datatype) noexcept {
  constexpr std::string_view xsd =
      "http://www.w3.org/2001/XMLSchema#";
  if (datatype.compare(0, xsd.size(), xsd) != 0) {
    return false;
  }
  const std::string_view local = datatype.substr(xsd.size());
  return local == "integer" || local == "decimal" ||
      local == "date" || local == "dateTime";
}

inline bool isAsciiDigit(char value) noexcept {
  return value >= '0' && value <= '9';
}

inline bool canonicalDateLexical(std::string_view value) noexcept {
  if (value.size() != 10 || value[4] != '-' || value[7] != '-') {
    return false;
  }
  constexpr size_t date_digit_positions[] = {0, 1, 2, 3, 5, 6, 8, 9};
  for (size_t index : date_digit_positions) {
    if (!isAsciiDigit(value[index])) {
      return false;
    }
  }
  const unsigned month =
      static_cast<unsigned>((value[5] - '0') * 10 + value[6] - '0');
  const unsigned day =
      static_cast<unsigned>((value[8] - '0') * 10 + value[9] - '0');
  return month >= 1 && month <= 12 && day >= 1 && day <= 31;
}

inline bool canonicalUtcDateTimeLexical(std::string_view value) noexcept {
  if (value.size() < 20 || value[10] != 'T' || value.back() != 'Z' ||
      !canonicalDateLexical(value.substr(0, 10)) ||
      value[13] != ':' || value[16] != ':') {
    return false;
  }
  constexpr size_t time_digit_positions[] = {11, 12, 14, 15, 17, 18};
  for (size_t index : time_digit_positions) {
    if (!isAsciiDigit(value[index])) {
      return false;
    }
  }
  if (value.size() > 20) {
    if (value[19] != '.') {
      return false;
    }
    for (size_t index = 20; index + 1 < value.size(); ++index) {
      if (!isAsciiDigit(value[index])) {
        return false;
      }
    }
  }
  return true;
}

inline bool canonicalExactNumericLexical(
    std::string_view value,
    bool allow_decimal_point) noexcept {
  if (value.empty() || value.size() > 300) {
    return false;
  }
  size_t index = 0;
  if (value[index] == '+' || value[index] == '-') {
    ++index;
  }
  bool saw_digit = false;
  bool saw_point = false;
  for (; index < value.size(); ++index) {
    if (isAsciiDigit(value[index])) {
      saw_digit = true;
      continue;
    }
    if (allow_decimal_point && value[index] == '.' && !saw_point) {
      saw_point = true;
      continue;
    }
    return false;
  }
  return saw_digit;
}

inline bool isRangePushdownOperand(
    const BridgeTermBinding& term) noexcept {
  if (!isRangePushdownDatatype(term.datatype_iri)) {
    return false;
  }
  constexpr std::string_view xsd =
      "http://www.w3.org/2001/XMLSchema#";
  const std::string_view local =
      std::string_view{term.datatype_iri}.substr(xsd.size());
  if (local == "date") {
    return canonicalDateLexical(term.value);
  }
  if (local == "dateTime") {
    return canonicalUtcDateTimeLexical(term.value);
  }
  return canonicalExactNumericLexical(
      term.value, local == "decimal");
}

inline std::optional<xpod_rdf_scan_filter_kind> scanFilterKindForComparison(
    BridgeResultModifierKind kind) noexcept {
  switch (kind) {
    case BridgeResultModifierKind::GreaterThanTerm:
      return XPOD_RDF_SCAN_FILTER_VALUE_GREATER_THAN;
    case BridgeResultModifierKind::GreaterThanOrEqualTerm:
      return XPOD_RDF_SCAN_FILTER_VALUE_GREATER_THAN_OR_EQUAL;
    case BridgeResultModifierKind::LessThanTerm:
      return XPOD_RDF_SCAN_FILTER_VALUE_LESS_THAN;
    case BridgeResultModifierKind::LessThanOrEqualTerm:
      return XPOD_RDF_SCAN_FILTER_VALUE_LESS_THAN_OR_EQUAL;
    default:
      return std::nullopt;
  }
}

inline bool tryPushValueComparison(
    BridgeQueryPlan& plan,
    ColumnIndex column,
    const BridgeTermBinding& term,
    BridgeResultModifierKind kind) {
  const uint32_t slot = scanSlotForFilterColumn(plan, column);
  const std::optional<xpod_rdf_scan_filter_kind> filter_kind =
      scanFilterKindForComparison(kind);
  if (slot == 0 || !filter_kind.has_value() ||
      term.kind != XPOD_RDF_TERM_LITERAL ||
      !isRangePushdownOperand(term)) {
    return false;
  }
  xpod_rdf_scan_filter filter = {};
  filter.slot = slot;
  filter.kind = *filter_kind;
  const size_t filter_index = plan.scan.filters.size();
  plan.scan.filters.push_back(filter);
  setScanFilterOperand(
      plan.scan,
      filter_index,
      term.kind,
      term.value,
      term.datatype_iri,
      term.language);
  return true;
}

inline bool applyComparisonFilterDescriptor(
    BridgeQueryPlan& plan,
    std::string_view descriptor,
    std::string_view separator,
    BridgeResultModifierKind left_kind,
    BridgeResultModifierKind right_kind) {
  descriptor = stripOuterFilterParens(descriptor);
  size_t separator_index = descriptor.find(separator);
  if (separator_index == std::string_view::npos) {
    return false;
  }
  std::string_view left =
      trimFilterToken(descriptor.substr(0, separator_index));
  std::string_view right = trimFilterToken(
      descriptor.substr(separator_index + separator.size()));
  ColumnIndex column = 0;
  BridgeTermBinding term;
  BridgeResultModifierKind kind = left_kind;
  if (!filterVariableAndTermForComparison(
          plan, left, right, left_kind, right_kind, column, term, kind)) {
    return false;
  }

  (void)tryPushValueComparison(plan, column, term, kind);

  BridgeResultModifier modifier;
  modifier.kind = kind;
  modifier.columns.push_back(column);
  size_t modifier_index = plan.root.result_modifiers.size();
  plan.root.result_modifiers.push_back(std::move(modifier));
  plan.modifier_term_bindings.push_back(
      BridgeModifierTermBinding{modifier_index, {}, std::move(term)});
  if (plan.descriptor.find("Filter") == std::string::npos) {
    plan.descriptor += " + Filter";
  }
  return true;
}

inline bool applyGreaterOrEqualFilterDescriptor(
    BridgeQueryPlan& plan,
    std::string_view descriptor) {
  return applyComparisonFilterDescriptor(
      plan, descriptor, " >= ",
      BridgeResultModifierKind::GreaterThanOrEqualTerm,
      BridgeResultModifierKind::LessThanOrEqualTerm);
}

inline bool applyLessOrEqualFilterDescriptor(
    BridgeQueryPlan& plan,
    std::string_view descriptor) {
  return applyComparisonFilterDescriptor(
      plan, descriptor, " <= ",
      BridgeResultModifierKind::LessThanOrEqualTerm,
      BridgeResultModifierKind::GreaterThanOrEqualTerm);
}

inline bool applyGreaterThanFilterDescriptor(
    BridgeQueryPlan& plan,
    std::string_view descriptor) {
  return applyComparisonFilterDescriptor(
      plan, descriptor, " > ",
      BridgeResultModifierKind::GreaterThanTerm,
      BridgeResultModifierKind::LessThanTerm);
}

inline bool applyLessThanFilterDescriptor(
    BridgeQueryPlan& plan,
    std::string_view descriptor) {
  return applyComparisonFilterDescriptor(
      plan, descriptor, " < ",
      BridgeResultModifierKind::LessThanTerm,
      BridgeResultModifierKind::GreaterThanTerm);
}

inline bool applyNotInFilterDescriptor(
    BridgeQueryPlan& plan,
    std::string_view descriptor) {
  descriptor = stripOuterFilterParens(descriptor);
  size_t separator = descriptor.find(" NOT IN ");
  if (separator == std::string_view::npos) {
    return false;
  }
  std::string_view left = trimFilterToken(descriptor.substr(0, separator));
  std::string_view right = trimFilterToken(descriptor.substr(separator + 8));
  ColumnIndex column = 0;
  std::vector<BridgeTermBinding> terms;
  if (!filterVariableAndTermList(plan, left, right, column, terms)) {
    return false;
  }

  BridgeResultModifier modifier;
  modifier.kind = BridgeResultModifierKind::NotInTerm;
  modifier.columns.push_back(column);
  size_t modifier_index = plan.root.result_modifiers.size();
  plan.root.result_modifiers.push_back(std::move(modifier));
  for (BridgeTermBinding& term : terms) {
    plan.modifier_term_bindings.push_back(
      BridgeModifierTermBinding{modifier_index, {}, std::move(term)});
  }
  if (plan.descriptor.find("Filter") == std::string::npos) {
    plan.descriptor += " + Filter";
  }
  return true;
}

inline bool applyInFilterDescriptor(
    BridgeQueryPlan& plan,
    std::string_view descriptor) {
  descriptor = stripOuterFilterParens(descriptor);
  size_t separator = descriptor.find(" IN ");
  if (separator == std::string_view::npos) {
    return false;
  }
  std::string_view left = trimFilterToken(descriptor.substr(0, separator));
  std::string_view right = trimFilterToken(descriptor.substr(separator + 4));
  ColumnIndex column = 0;
  std::vector<BridgeTermBinding> terms;
  if (!filterVariableAndTermList(plan, left, right, column, terms)) {
    return false;
  }

  BridgeResultModifier modifier;
  modifier.kind = BridgeResultModifierKind::InTerm;
  modifier.columns.push_back(column);
  size_t modifier_index = plan.root.result_modifiers.size();
  plan.root.result_modifiers.push_back(std::move(modifier));
  for (BridgeTermBinding& term : terms) {
    plan.modifier_term_bindings.push_back(
      BridgeModifierTermBinding{modifier_index, {}, std::move(term)});
  }
  if (plan.descriptor.find("Filter") == std::string::npos) {
    plan.descriptor += " + Filter";
  }
  return true;
}

inline std::optional<BridgeQueryPlan> planParsedGraphPatternFallback(
    const ParsedQuery& parsed,
    const parsedQuery::GraphPattern& graph_pattern,
    const std::optional<BridgeGraphScope>& graph_scope,
    bool apply_selected_projection = true);

struct BridgeFilterLoweringContext {
  const std::optional<BridgeGraphScope>* graph_scope = nullptr;
#if XPOD_QLEVER_HAS_EXISTS_EXPRESSION
  std::vector<const sparqlExpression::SparqlExpression*> exists_expressions;
  size_t next_exists_expression = 0;
#endif
};

#if XPOD_QLEVER_HAS_EXISTS_EXPRESSION
struct BridgeExistsFilter {
  const sparqlExpression::ExistsExpression* expression = nullptr;
  bool negated = false;
};

inline BridgeFilterLoweringContext makeBridgeFilterLoweringContext(
    const SparqlFilter& filter,
    const std::optional<BridgeGraphScope>& graph_scope) {
  BridgeFilterLoweringContext context;
  context.graph_scope = &graph_scope;
  context.exists_expressions = filter.expression_.getExistsExpressions();
  return context;
}

inline bool descriptorStartsWithExists(
    std::string_view descriptor,
    bool& negated) {
  descriptor = stripOuterFilterParens(descriptor);
  descriptor = trimFilterToken(descriptor);
  negated = false;
  if (descriptor.rfind("EXISTS", 0) == 0) {
    return true;
  }
  if (descriptor.rfind("NOT EXISTS", 0) == 0 ||
      descriptor.rfind("NOTEXISTS", 0) == 0 ||
      descriptor.rfind("!EXISTS", 0) == 0 ||
      descriptor.rfind("! EXISTS", 0) == 0 ||
      descriptor.rfind("(!EXISTS", 0) == 0 ||
      descriptor.rfind("(! EXISTS", 0) == 0) {
    negated = true;
    return true;
  }
  return false;
}

inline std::optional<BridgeExistsFilter> singleExistsFilter(
    const SparqlFilter& filter) {
  std::vector<const sparqlExpression::SparqlExpression*> expressions =
      filter.expression_.getExistsExpressions();
  if (expressions.size() != 1 || expressions.front() == nullptr) {
    return std::nullopt;
  }
  std::string_view descriptor = trimFilterToken(
      filter.expression_.getDescriptor());
  bool is_exists = descriptor.rfind("EXISTS", 0) == 0;
  bool is_not_exists = descriptor.rfind("NOT EXISTS", 0) == 0 ||
      descriptor.rfind("NOTEXISTS", 0) == 0 ||
      descriptor.rfind("!EXISTS", 0) == 0 ||
      descriptor.rfind("! EXISTS", 0) == 0 ||
      descriptor.rfind("(!EXISTS", 0) == 0 ||
      descriptor.rfind("(! EXISTS", 0) == 0;
  if (!is_exists && !is_not_exists) {
    return std::nullopt;
  }
  const auto* expression = dynamic_cast<const sparqlExpression::ExistsExpression*>(
      expressions.front());
  if (expression == nullptr) {
    return std::nullopt;
  }
  return BridgeExistsFilter{expression, is_not_exists};
}

inline std::optional<BridgeExistsFilter> consumeExistsFilter(
    BridgeFilterLoweringContext* context,
    bool negated) {
  if (context == nullptr ||
      context->next_exists_expression >= context->exists_expressions.size()) {
    return std::nullopt;
  }
  const auto* expression = dynamic_cast<const sparqlExpression::ExistsExpression*>(
      context->exists_expressions[context->next_exists_expression]);
  if (expression == nullptr) {
    return std::nullopt;
  }
  ++context->next_exists_expression;
  return BridgeExistsFilter{expression, negated};
}

inline bool lowerExistsFilterDescriptor(
    BridgeQueryPlan& plan,
    std::string_view descriptor,
    BridgeResultModifier& modifier,
    BridgeFilterLoweringContext* context) {
  bool negated = false;
  if (!descriptorStartsWithExists(descriptor, negated)) {
    return false;
  }
  std::optional<BridgeExistsFilter> exists_filter =
      consumeExistsFilter(context, negated);
  if (!exists_filter.has_value()) {
    return false;
  }

  const ParsedQuery& exists_argument = exists_filter->expression->argument();
  std::optional<BridgeGraphScope> no_scope;
  const std::optional<BridgeGraphScope>& graph_scope =
      context != nullptr && context->graph_scope != nullptr
          ? *context->graph_scope
          : no_scope;
  auto right_plan = planParsedGraphPatternFallback(
      exists_argument, exists_argument._rootGraphPattern, graph_scope, false);
  if (!right_plan.has_value()) {
    return false;
  }

  modifier.kind = BridgeResultModifierKind::Exists;
  modifier.exists_negated = exists_filter->negated;
  modifier.exists_child_index = plan.child_plans.size();
  modifier.matched_columns = matchedOutputVariableColumns(
      plan.output_variables, right_plan->output_variables);
  plan.child_plans.push_back(std::move(*right_plan));
  return true;
}

inline bool applyExistsFilter(
    BridgeQueryPlan& plan,
    const SparqlFilter& filter,
    const std::optional<BridgeGraphScope>& graph_scope) {
  std::optional<BridgeExistsFilter> exists_filter =
      singleExistsFilter(filter);
  if (!exists_filter.has_value()) {
    return false;
  }

  const ParsedQuery& exists_argument = exists_filter->expression->argument();
  auto right_plan = planParsedGraphPatternFallback(
      exists_argument, exists_argument._rootGraphPattern, graph_scope, false);
  if (!right_plan.has_value()) {
    return false;
  }

  BridgeQueryPlan exists_plan;
  exists_plan.descriptor = "Filter + Exists (" + plan.descriptor + ", " +
      right_plan->descriptor + ")";
  exists_plan.sorted_by = plan.sorted_by;
  exists_plan.output_variables = plan.output_variables;
  exists_plan.result_width = exists_plan.output_variables.size();
  exists_plan.root.kind = BridgeOperationKind::ExistsJoin;
  exists_plan.root.exists_join_negated = exists_filter->negated;
  exists_plan.root.sorted_by = exists_plan.sorted_by;
  exists_plan.root.matched_columns = matchedOutputVariableColumns(
      plan.output_variables, right_plan->output_variables);
  exists_plan.child_plans.push_back(std::move(plan));
  exists_plan.child_plans.push_back(std::move(*right_plan));
  plan = std::move(exists_plan);
  return true;
}
#else
inline BridgeFilterLoweringContext makeBridgeFilterLoweringContext(
    const SparqlFilter&,
    const std::optional<BridgeGraphScope>& graph_scope) {
  BridgeFilterLoweringContext context;
  context.graph_scope = &graph_scope;
  return context;
}

inline bool lowerExistsFilterDescriptor(
    BridgeQueryPlan&,
    std::string_view,
    BridgeResultModifier&,
    BridgeFilterLoweringContext*) {
  return false;
}

inline bool applyExistsFilter(
    BridgeQueryPlan&,
    const SparqlFilter&,
    const std::optional<BridgeGraphScope>&) {
  return false;
}
#endif

inline std::optional<size_t> findTopLevelFilterOperator(
    std::string_view descriptor,
    std::string_view op) {
  descriptor = stripOuterFilterParens(descriptor);
  int paren_depth = 0;
  int iri_depth = 0;
  bool in_string = false;
  bool escaped = false;
  for (size_t index = 0; index < descriptor.size(); ++index) {
    char c = descriptor[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (in_string) {
      if (c == '\\') {
        escaped = true;
      } else if (c == '"') {
        in_string = false;
      }
      continue;
    }
    if (c == '"') {
      in_string = true;
      continue;
    }
    if (c == '<') {
      ++iri_depth;
      continue;
    }
    if (c == '>' && iri_depth > 0) {
      --iri_depth;
      continue;
    }
    if (iri_depth > 0) {
      continue;
    }
    if (c == '(') {
      ++paren_depth;
      continue;
    }
    if (c == ')' && paren_depth > 0) {
      --paren_depth;
      continue;
    }
    if (paren_depth == 0 &&
        descriptor.substr(index, op.size()) == op) {
      return index;
    }
  }
  return std::nullopt;
}

inline bool applySimpleFilterDescriptor(
    BridgeQueryPlan& plan,
    std::string_view descriptor) {
  return applyNotEqualFilterDescriptor(plan, descriptor) ||
      applyEqualFilterDescriptor(plan, descriptor) ||
      applyLanguageFilterDescriptor(plan, descriptor) ||
      applyDatatypeFilterDescriptor(plan, descriptor) ||
      applyStringEqualsFilterDescriptor(plan, descriptor) ||
      applyStringPredicateFilterDescriptor(
          plan, descriptor, "STRSTARTS(", BridgeStringFilterKind::Prefix) ||
      applyStringPredicateFilterDescriptor(
          plan, descriptor, "CONTAINS(", BridgeStringFilterKind::Contains) ||
      applyStringPredicateFilterDescriptor(
          plan, descriptor, "STRENDS(", BridgeStringFilterKind::Suffix) ||
      applyRegexPrefixFilterDescriptor(plan, descriptor) ||
      applyGreaterOrEqualFilterDescriptor(plan, descriptor) ||
      applyLessOrEqualFilterDescriptor(plan, descriptor) ||
      applyGreaterThanFilterDescriptor(plan, descriptor) ||
      applyLessThanFilterDescriptor(plan, descriptor) ||
      applyNotInFilterDescriptor(plan, descriptor) ||
      applyInFilterDescriptor(plan, descriptor);
}

inline bool applyFilterDescriptor(
    BridgeQueryPlan& plan,
    std::string_view descriptor,
    BridgeFilterLoweringContext* context = nullptr);

inline void offsetExistsChildIndexes(
    BridgeResultModifier& modifier,
    size_t offset) {
  if (offset == 0) {
    return;
  }
  if (modifier.kind == BridgeResultModifierKind::Exists &&
      modifier.exists_child_index != BRIDGE_NO_COLUMN) {
    modifier.exists_child_index += offset;
  }
  for (BridgeResultModifier& child : modifier.child_modifiers) {
    offsetExistsChildIndexes(child, offset);
  }
}

inline void moveNestedFilterChildPlans(
    BridgeQueryPlan& plan,
    BridgeQueryPlan& nested_plan,
    BridgeResultModifier& modifier) {
  if (nested_plan.child_plans.empty()) {
    return;
  }
  size_t child_plan_offset = plan.child_plans.size();
  offsetExistsChildIndexes(modifier, child_plan_offset);
  plan.child_plans.reserve(
      plan.child_plans.size() + nested_plan.child_plans.size());
  for (BridgeQueryPlan& child_plan : nested_plan.child_plans) {
    plan.child_plans.push_back(std::move(child_plan));
  }
}

inline bool lowerFilterDescriptorAsSinglePredicate(
    BridgeQueryPlan& plan,
    std::string_view descriptor,
    BridgeResultModifier& modifier,
    std::vector<BridgeModifierTermBinding>& bindings,
    BridgeFilterLoweringContext* context = nullptr) {
  if (lowerExistsFilterDescriptor(plan, descriptor, modifier, context)) {
    bindings.clear();
    return true;
  }

  BridgeQueryPlan nested_plan;
  nested_plan.output_variables = plan.output_variables;
  nested_plan.descriptor = plan.descriptor;
  if (!applyFilterDescriptor(nested_plan, descriptor, context) ||
      nested_plan.root.result_modifiers.empty()) {
    return false;
  }
  if (nested_plan.root.result_modifiers.size() == 1) {
    modifier = std::move(nested_plan.root.result_modifiers.front());
    moveNestedFilterChildPlans(plan, nested_plan, modifier);
    movePhysicalFilterFallbackIfFirst(plan, nested_plan);
    bindings = std::move(nested_plan.modifier_term_bindings);
    return true;
  }

  modifier.kind = BridgeResultModifierKind::AllOf;
  modifier.child_modifiers = std::move(nested_plan.root.result_modifiers);
  moveNestedFilterChildPlans(plan, nested_plan, modifier);
  movePhysicalFilterFallbackIfFirst(plan, nested_plan);
  bindings.clear();
  bindings.reserve(nested_plan.modifier_term_bindings.size());
  for (BridgeModifierTermBinding& binding :
       nested_plan.modifier_term_bindings) {
    if (binding.modifier_index >= modifier.child_modifiers.size()) {
      return false;
    }
    BridgeModifierTermBinding remapped;
    remapped.modifier_index = 0;
    remapped.child_indexes.push_back(binding.modifier_index);
    remapped.child_indexes.insert(
        remapped.child_indexes.end(),
        binding.child_indexes.begin(), binding.child_indexes.end());
    remapped.term = std::move(binding.term);
    bindings.push_back(std::move(remapped));
  }
  return true;
}

inline bool applyOrFilterDescriptor(
    BridgeQueryPlan& plan,
    std::string_view descriptor,
    BridgeFilterLoweringContext* context = nullptr) {
  descriptor = stripOuterFilterParens(descriptor);
  std::optional<size_t> op_index =
      findTopLevelFilterOperator(descriptor, "||");
  if (!op_index.has_value()) {
    return false;
  }
  std::string_view left =
      trimFilterToken(descriptor.substr(0, *op_index));
  std::string_view right =
      trimFilterToken(descriptor.substr(*op_index + 2));
  if (left.empty() || right.empty()) {
    return false;
  }

  BridgeResultModifier left_modifier;
  BridgeResultModifier right_modifier;
  std::vector<BridgeModifierTermBinding> left_bindings;
  std::vector<BridgeModifierTermBinding> right_bindings;
  if (!lowerFilterDescriptorAsSinglePredicate(
          plan, left, left_modifier, left_bindings, context) ||
      !lowerFilterDescriptorAsSinglePredicate(
          plan, right, right_modifier, right_bindings, context)) {
    return false;
  }

  BridgeResultModifier modifier;
  modifier.kind = BridgeResultModifierKind::AnyOf;
  modifier.child_modifiers.push_back(std::move(left_modifier));
  modifier.child_modifiers.push_back(std::move(right_modifier));
  size_t modifier_index = plan.root.result_modifiers.size();
  plan.root.result_modifiers.push_back(std::move(modifier));

  for (BridgeModifierTermBinding& binding : left_bindings) {
    BridgeModifierTermBinding remapped;
    remapped.modifier_index = modifier_index;
    remapped.child_indexes.push_back(0);
    remapped.child_indexes.insert(
        remapped.child_indexes.end(),
        binding.child_indexes.begin(), binding.child_indexes.end());
    remapped.term = std::move(binding.term);
    plan.modifier_term_bindings.push_back(std::move(remapped));
  }
  for (BridgeModifierTermBinding& binding : right_bindings) {
    BridgeModifierTermBinding remapped;
    remapped.modifier_index = modifier_index;
    remapped.child_indexes.push_back(1);
    remapped.child_indexes.insert(
        remapped.child_indexes.end(),
        binding.child_indexes.begin(), binding.child_indexes.end());
    remapped.term = std::move(binding.term);
    plan.modifier_term_bindings.push_back(std::move(remapped));
  }
  if (plan.descriptor.find("Filter") == std::string::npos) {
    plan.descriptor += " + Filter";
  }
  return true;
}

inline bool applyAndFilterDescriptor(
    BridgeQueryPlan& plan,
    std::string_view descriptor,
    BridgeFilterLoweringContext* context = nullptr) {
  descriptor = stripOuterFilterParens(descriptor);
  std::optional<size_t> op_index =
      findTopLevelFilterOperator(descriptor, "&&");
  if (!op_index.has_value()) {
    return false;
  }
  std::string_view left =
      trimFilterToken(descriptor.substr(0, *op_index));
  std::string_view right =
      trimFilterToken(descriptor.substr(*op_index + 2));
  if (left.empty() || right.empty()) {
    return false;
  }
  return applyFilterDescriptor(plan, left, context) &&
      applyFilterDescriptor(plan, right, context);
}

inline bool applyNotFilterDescriptor(
    BridgeQueryPlan& plan,
    std::string_view descriptor,
    BridgeFilterLoweringContext* context = nullptr) {
  descriptor = stripOuterFilterParens(descriptor);
  if (descriptor.empty()) {
    return false;
  }

  std::string_view child_descriptor;
  if (descriptor.front() == '!') {
    child_descriptor = trimFilterToken(descriptor.substr(1));
  } else {
    constexpr std::string_view not_prefix = "NOT ";
    if (descriptor.rfind(not_prefix, 0) != 0) {
      return false;
    }
    child_descriptor = trimFilterToken(descriptor.substr(not_prefix.size()));
  }
  if (child_descriptor.empty()) {
    return false;
  }

  BridgeResultModifier child_modifier;
  std::vector<BridgeModifierTermBinding> child_bindings;
  if (!lowerFilterDescriptorAsSinglePredicate(
          plan, child_descriptor, child_modifier, child_bindings, context) ||
      modifierContainsAlwaysFalse(child_modifier)) {
    return false;
  }

  BridgeResultModifier modifier;
  modifier.kind = BridgeResultModifierKind::Not;
  modifier.child_modifiers.push_back(std::move(child_modifier));
  size_t modifier_index = plan.root.result_modifiers.size();
  plan.root.result_modifiers.push_back(std::move(modifier));

  for (BridgeModifierTermBinding& binding : child_bindings) {
    BridgeModifierTermBinding remapped;
    remapped.modifier_index = modifier_index;
    remapped.child_indexes.push_back(0);
    remapped.child_indexes.insert(
        remapped.child_indexes.end(),
        binding.child_indexes.begin(), binding.child_indexes.end());
    remapped.term = std::move(binding.term);
    plan.modifier_term_bindings.push_back(std::move(remapped));
  }
  if (plan.descriptor.find("Filter") == std::string::npos) {
    plan.descriptor += " + Filter";
  }
  return true;
}

inline bool applyExistsFilterDescriptor(
    BridgeQueryPlan& plan,
    std::string_view descriptor,
    BridgeFilterLoweringContext* context = nullptr) {
  BridgeResultModifier modifier;
  if (!lowerExistsFilterDescriptor(plan, descriptor, modifier, context)) {
    return false;
  }
  plan.root.result_modifiers.push_back(std::move(modifier));
  if (plan.descriptor.find("Filter") == std::string::npos) {
    plan.descriptor += " + Filter";
  }
  return true;
}

inline bool applyFilterDescriptor(
    BridgeQueryPlan& plan,
    std::string_view descriptor,
    BridgeFilterLoweringContext* context) {
  return applyOrFilterDescriptor(plan, descriptor, context) ||
      applyAndFilterDescriptor(plan, descriptor, context) ||
      applyNotFilterDescriptor(plan, descriptor, context) ||
      applyExistsFilterDescriptor(plan, descriptor, context) ||
      applySimpleFilterDescriptor(plan, descriptor);
}

inline bool applyGraphPatternFilters(
    BridgeQueryPlan& plan,
    const std::vector<SparqlFilter>& filters,
    const std::optional<BridgeGraphScope>& graph_scope) {
  for (const SparqlFilter& filter : filters) {
    std::string_view descriptor = filter.expression_.getDescriptor();
    if (applyExistsFilter(plan, filter, graph_scope)) {
      continue;
    }
    BridgeFilterLoweringContext context =
        makeBridgeFilterLoweringContext(filter, graph_scope);
    if (!applyFilterDescriptor(plan, descriptor, &context)) {
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
  if (basic._triples.empty()) {
    return std::nullopt;
  }

  try {
    SparqlTripleSimple first = basic._triples.front().getSimple();
    auto plan = planSingleTripleFallback(first, graph_scope);
    if (!plan.has_value()) {
      return std::nullopt;
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
    } else if (basic._triples.size() > 2) {
      for (size_t index = 1; index < basic._triples.size(); ++index) {
        auto right = planSingleTripleFallback(
            basic._triples[index].getSimple(), graph_scope);
        if (!right.has_value()) {
          return std::nullopt;
        }
        plan = appendBasicPatternJoin(
            std::move(*plan), std::move(*right));
        if (!plan.has_value()) {
          return std::nullopt;
        }
      }
      if (apply_selected_projection &&
          !applySelectedProjectionByOutputVariables(*plan, parsed)) {
        return std::nullopt;
      }
    } else if (apply_selected_projection) {
      if (!plan->root.result_modifiers.empty()) {
        if (!applySelectedProjectionByOutputVariables(*plan, parsed)) {
          return std::nullopt;
        }
      } else if (!applySelectedProjection(
          *plan, parsed, first, std::nullopt, graph_scope)) {
        return std::nullopt;
      }
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

inline std::optional<BridgeQueryPlan> planParsedOptionalJoinFallback(
    BridgeQueryPlan left_plan,
    BridgeQueryPlan right_plan,
    bool apply_selected_projection,
    const ParsedQuery& parsed) {
  BridgeQueryPlan plan;
  plan.descriptor =
      "OptionalJoin (" + left_plan.descriptor + ", " + right_plan.descriptor + ")";
  plan.sorted_by = left_plan.sorted_by;
  plan.root.kind = BridgeOperationKind::OptionalJoin;
  plan.root.sorted_by = plan.sorted_by;
  plan.output_variables = left_plan.output_variables;
  plan.root.matched_columns = matchedOutputVariableColumns(
      left_plan.output_variables, right_plan.output_variables);
  plan.root.right_projection_columns = rightProjectionColumns(
      left_plan.output_variables, right_plan.output_variables);
  for (size_t column : plan.root.right_projection_columns) {
    if (column >= right_plan.output_variables.size()) {
      return std::nullopt;
    }
    plan.output_variables.push_back(right_plan.output_variables[column]);
  }
  plan.result_width = plan.output_variables.size();
  plan.child_plans.push_back(std::move(left_plan));
  plan.child_plans.push_back(std::move(right_plan));

  if (apply_selected_projection &&
      !applySelectedProjectionByOutputVariables(plan, parsed)) {
    return std::nullopt;
  }
  return plan;
}

inline std::optional<BridgeQueryPlan> planParsedMinusFallback(
    BridgeQueryPlan left_plan,
    BridgeQueryPlan right_plan,
    bool apply_selected_projection,
    const ParsedQuery& parsed) {
  BridgeQueryPlan plan;
  plan.descriptor =
      "Minus (" + left_plan.descriptor + ", " + right_plan.descriptor + ")";
  plan.sorted_by = left_plan.sorted_by;
  plan.root.kind = BridgeOperationKind::Minus;
  plan.root.sorted_by = plan.sorted_by;
  plan.output_variables = left_plan.output_variables;
  plan.root.matched_columns = matchedOutputVariableColumns(
      left_plan.output_variables, right_plan.output_variables);
  plan.result_width = plan.output_variables.size();
  plan.child_plans.push_back(std::move(left_plan));
  plan.child_plans.push_back(std::move(right_plan));

  if (apply_selected_projection &&
      !applySelectedProjectionByOutputVariables(plan, parsed)) {
    return std::nullopt;
  }
  return plan;
}

inline std::optional<BridgeQueryPlan> planParsedUnionFallback(
    BridgeQueryPlan left_plan,
    BridgeQueryPlan right_plan,
    bool apply_selected_projection,
    const ParsedQuery& parsed) {
  BridgeQueryPlan plan;
  plan.descriptor =
      "Union (" + left_plan.descriptor + ", " + right_plan.descriptor + ")";
  plan.root.kind = BridgeOperationKind::Union;

  plan.output_variables = left_plan.output_variables;
  for (const std::string& variable : right_plan.output_variables) {
    if (!containsOutputVariable(plan.output_variables, variable)) {
      plan.output_variables.push_back(variable);
    }
  }
  if (plan.output_variables.empty()) {
    return std::nullopt;
  }

  for (const std::string& variable : plan.output_variables) {
    std::optional<ColumnIndex> left_column =
        outputColumnForVariable(left_plan.output_variables, variable);
    std::optional<ColumnIndex> right_column =
        outputColumnForVariable(right_plan.output_variables, variable);
    if (!left_column.has_value() && !right_column.has_value()) {
      return std::nullopt;
    }
    plan.root.column_origins.push_back({
        left_column.has_value() ? *left_column : BRIDGE_NO_COLUMN,
        right_column.has_value() ? *right_column : BRIDGE_NO_COLUMN,
    });
  }

  plan.result_width = plan.output_variables.size();
  plan.child_plans.push_back(std::move(left_plan));
  plan.child_plans.push_back(std::move(right_plan));

  if (apply_selected_projection &&
      !applySelectedProjectionByOutputVariables(plan, parsed)) {
    return std::nullopt;
  }
  return plan;
}

inline const parsedQuery::Describe* describeFromOperation(
    const parsedQuery::GraphPatternOperation& operation) {
  return std::get_if<parsedQuery::Describe>(
      &static_cast<const parsedQuery::GraphPatternOperationVariant&>(operation));
}

inline std::optional<BridgeQueryPlan> planDescribeFallback(
    const parsedQuery::Describe& describe) {
  const ParsedQuery& where = describe.whereClause_.get();
  auto child_plan = planParsedGraphPatternFallback(
      where, where._rootGraphPattern, std::nullopt, false);
  if (!child_plan.has_value()) {
    return std::nullopt;
  }

  BridgeQueryPlan plan;
  plan.descriptor = "Describe + " + child_plan->descriptor;
  plan.result_width = 3;
  plan.output_variables = {"subject", "predicate", "object"};
  plan.root.kind = BridgeOperationKind::Describe;
  plan.root.native_result_only = true;
  plan.child_plans.push_back(std::move(*child_plan));
  return plan;
}

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
        nested_scope = graphScopeForLocalGroup(nested_scope, local_scope);
        if (!nested_scope.has_value()) {
          return std::nullopt;
        }
      }
      return planParsedGraphPatternFallback(
          parsed, group->_child, nested_scope, apply_selected_projection);
    }
    const auto* describe = describeFromOperation(children.front());
    if (describe != nullptr) {
      return planDescribeFallback(*describe);
    }
    const auto* union_operation = unionFromOperation(children.front());
    if (union_operation != nullptr) {
      auto left_plan = planParsedGraphPatternFallback(
          parsed, union_operation->_child1, graph_scope, false);
      auto right_plan = planParsedGraphPatternFallback(
          parsed, union_operation->_child2, graph_scope, false);
      if (!left_plan.has_value() || !right_plan.has_value()) {
        return std::nullopt;
      }
      return planParsedUnionFallback(
          std::move(*left_plan), std::move(*right_plan),
          apply_selected_projection, parsed);
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
    const parsedQuery::Optional* optional = optionalFromOperation(children[0]);
    size_t left_child_index = 1;
    if (optional == nullptr) {
      optional = optionalFromOperation(children[1]);
      left_child_index = 0;
    }
    if (optional != nullptr) {
      std::vector<parsedQuery::GraphPatternOperation> left_children;
      left_children.push_back(children[left_child_index]);
      auto left_plan = planParsedChildrenFallback(
          parsed, left_children, graph_scope, false);
      auto right_plan = planParsedGraphPatternFallback(
          parsed, optional->_child, graph_scope, false);
      if (!left_plan.has_value() || !right_plan.has_value()) {
        return std::nullopt;
      }
      return planParsedOptionalJoinFallback(
          std::move(*left_plan), std::move(*right_plan),
          apply_selected_projection, parsed);
    }
    const parsedQuery::Minus* minus = minusFromOperation(children[0]);
    left_child_index = 1;
    if (minus == nullptr) {
      minus = minusFromOperation(children[1]);
      left_child_index = 0;
    }
    if (minus != nullptr) {
      std::vector<parsedQuery::GraphPatternOperation> left_children;
      left_children.push_back(children[left_child_index]);
      auto left_plan = planParsedChildrenFallback(
          parsed, left_children, graph_scope, false);
      auto right_plan = planParsedGraphPatternFallback(
          parsed, minus->_child, graph_scope, false);
      if (!left_plan.has_value() || !right_plan.has_value()) {
        return std::nullopt;
      }
      return planParsedMinusFallback(
          std::move(*left_plan), std::move(*right_plan),
          apply_selected_projection, parsed);
    }
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
  bool defer_projection_for_filters =
      apply_selected_projection && !graph_pattern._filters.empty();
  auto plan = planParsedChildrenFallback(
      parsed, graph_pattern._graphPatterns, graph_scope,
      defer_projection_for_filters ? false : apply_selected_projection);
  if (!plan.has_value()) {
    return std::nullopt;
  }
  if (!applyGraphPatternFilters(*plan, graph_pattern._filters, graph_scope)) {
    return std::nullopt;
  }
  if (defer_projection_for_filters &&
      !applySelectedProjectionByOutputVariables(*plan, parsed)) {
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
      parsed, parsed._rootGraphPattern, defaultGraphBridgeScope());
}

inline std::optional<BridgeQueryPlan> planParsedAskQuery(
    const ParsedQuery& parsed) {
  if (!parsed.hasAskClause()) {
    return std::nullopt;
  }
  auto plan = planParsedGraphPatternFallback(
      parsed, parsed._rootGraphPattern, defaultGraphBridgeScope(), false);
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
  if (plan.child_plans.empty() &&
      (plan.root.kind == BridgeOperationKind::PermutationScan ||
       plan.root.kind == BridgeOperationKind::HashJoin)) {
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
    primary.result_width =
        countNeededSlots(normalizeNeededSlots(primary.scan.needed_slots));
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
  for (BridgeTextCandidateSource& source : physical.text_sources) {
    source.refreshViews();
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
