#ifndef XPOD_QLEVER_PLAN_BRIDGE_HPP
#define XPOD_QLEVER_PLAN_BRIDGE_HPP

#include "XpodQleverScanBridge.hpp"
#include "xpod_rdf_physical_backend.h"

#include <optional>
#include <string>
#include <string_view>
#include <utility>
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
};

struct BridgeQueryPlan {
  ScanRequestInput scan;
  std::vector<ColumnIndex> sorted_by;
  size_t result_width = 0;
  std::string descriptor;
  std::vector<BridgeTermBinding> term_bindings;
  bool known_empty = false;
};

inline std::string iriValueFromComponent(const TripleComponent& component) {
  std::string iri = std::string(component.getIri().toStringRepresentation());
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
  }
}

inline xpod_rdf_status bindPlanTerms(
    const xpod::rdf::PhysicalBackend& backend,
    const xpod_rdf_snapshot& snapshot,
    BridgeQueryPlan& plan,
    std::string& error_storage) {
  if (plan.term_bindings.empty()) {
    return XPOD_RDF_STATUS_OK;
  }

  std::vector<xpod_rdf_term> terms;
  terms.reserve(plan.term_bindings.size());
  for (const BridgeTermBinding& binding : plan.term_bindings) {
    terms.push_back(toNativeTerm(binding));
  }

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
      plan.known_empty = true;
      return XPOD_RDF_STATUS_OK;
    }
    if (statuses[i] != XPOD_RDF_STATUS_OK) {
      error_storage = "failed to lookup one or more QLever bridge constants";
      return statuses[i];
    }
    bindPatternSlot(plan.scan.pattern, plan.term_bindings[i].slot, keys[i]);
  }
  return XPOD_RDF_STATUS_OK;
}

inline std::optional<BridgeQueryPlan> planParsedQuery(
    const ParsedQuery& parsed) {
  if (!parsed.hasSelectClause()) {
    return std::nullopt;
  }
  const auto& children = parsed.children();
  if (children.size() != 1) {
    return std::nullopt;
  }
  const auto& operation = children.front();
  const auto* basic = std::get_if<parsedQuery::BasicGraphPattern>(
      &static_cast<const parsedQuery::GraphPatternOperationVariant&>(operation));
  if (basic == nullptr || basic->_triples.size() != 1) {
    return std::nullopt;
  }

  try {
    SparqlTripleSimple triple = basic->_triples.front().getSimple();
    BridgeQueryPlan plan;
    if (!bindableComponent(triple.s_, "?s", XPOD_RDF_SLOT_SUBJECT, plan) ||
        !bindableComponent(triple.p_, "?p", XPOD_RDF_SLOT_PREDICATE, plan) ||
        !bindableComponent(triple.o_, "?o", XPOD_RDF_SLOT_OBJECT, plan)) {
      return std::nullopt;
    }
    plan.scan.permutation = Permutation::Enum::SPO;
    plan.scan.needed_slots = XPOD_RDF_SLOT_SUBJECT | XPOD_RDF_SLOT_PREDICATE |
                             XPOD_RDF_SLOT_OBJECT;
    plan.sorted_by = {0};
    plan.result_width = 3;
    plan.descriptor = "xpod scan ?s ?p ?o";
    return plan;
  } catch (...) {
    return std::nullopt;
  }
}

}  // namespace xpod::qlever
#endif

#endif
