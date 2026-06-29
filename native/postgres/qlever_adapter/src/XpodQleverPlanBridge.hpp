#ifndef XPOD_QLEVER_PLAN_BRIDGE_HPP
#define XPOD_QLEVER_PLAN_BRIDGE_HPP

#include "XpodQleverOperationBridge.hpp"
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

struct BridgeTextRequiredEntityBinding {
  size_t text_source_index = 0;
  BridgeTermBinding term;
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
  std::vector<std::string> output_variables;
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

inline xpod_rdf_status bindTermBindings(
    const xpod::rdf::PhysicalBackend& backend,
    const xpod_rdf_snapshot& snapshot,
    const std::vector<BridgeTermBinding>& bindings,
    TripleKeyPattern& pattern,
    bool& known_empty,
    std::string& error_storage) {
  if (bindings.empty()) {
    return XPOD_RDF_STATUS_OK;
  }

  std::vector<xpod_rdf_term> terms;
  terms.reserve(bindings.size());
  for (const BridgeTermBinding& binding : bindings) {
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
      known_empty = true;
      return XPOD_RDF_STATUS_OK;
    }
    if (statuses[i] != XPOD_RDF_STATUS_OK) {
      error_storage = "failed to lookup one or more QLever bridge constants";
      return statuses[i];
    }
    bindPatternSlot(pattern, bindings[i].slot, keys[i]);
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

inline xpod_rdf_status bindPlanTerms(
    const xpod::rdf::PhysicalBackend& backend,
    const xpod_rdf_snapshot& snapshot,
    BridgeQueryPlan& plan,
    std::string& error_storage) {
  xpod_rdf_status status = bindTermBindings(
      backend, snapshot, plan.term_bindings, plan.scan.pattern,
      plan.known_empty, error_storage);
  if (status != XPOD_RDF_STATUS_OK || plan.known_empty) {
    return status;
  }
  for (BridgeFilterScan& filter : plan.filter_scans) {
    status = bindTermBindings(
        backend, snapshot, filter.term_bindings, filter.scan.pattern,
        filter.known_empty, error_storage);
    if (status != XPOD_RDF_STATUS_OK) {
      return status;
    }
    if (filter.known_empty) {
      plan.known_empty = true;
      return XPOD_RDF_STATUS_OK;
    }
  }
  return bindTextRequiredEntities(backend, snapshot, plan, error_storage);
}

inline void applyBridgeRequestContext(
    BridgeQueryPlan& plan,
    const xpod_rdf_snapshot& snapshot,
    const xpod_rdf_source_scope& source_scope,
    const xpod_rdf_access_scope* access_scope) noexcept {
  plan.scan.snapshot = &snapshot;
  plan.scan.source_scope = &source_scope;
  plan.scan.access_scope = access_scope;
  for (BridgeFilterScan& filter : plan.filter_scans) {
    filter.scan.snapshot = &snapshot;
    filter.scan.source_scope = &source_scope;
    filter.scan.access_scope = access_scope;
  }
  for (BridgeTextCandidateSource& source : plan.text_sources) {
    source.request.snapshot = snapshot;
    source.request.source_scope = source_scope;
    source.request.access_scope = access_scope;
  }
  for (BridgeVectorCandidateSource& source : plan.vector_sources) {
    source.request.snapshot = snapshot;
    source.request.source_scope = source_scope;
    source.request.access_scope = access_scope;
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
  if (!bindableComponent(triple.s_, "?s", XPOD_RDF_SLOT_SUBJECT, plan) ||
      !bindableComponent(triple.p_, "?p", XPOD_RDF_SLOT_PREDICATE, plan) ||
      !bindableComponent(triple.o_, "?o", XPOD_RDF_SLOT_OBJECT, plan)) {
    return std::nullopt;
  }
  initializeScanPlan(plan, triple);
  return plan;
}

inline bool planSubjectFilterTriple(
    const SparqlTripleSimple& triple,
    BridgeFilterScan& filter) {
  BridgeQueryPlan scratch;
  if (!bindableComponent(triple.s_, "?s", XPOD_RDF_SLOT_SUBJECT, scratch) ||
      !bindableComponent(triple.p_, "?p", XPOD_RDF_SLOT_PREDICATE, scratch) ||
      !bindableComponent(triple.o_, "?o", XPOD_RDF_SLOT_OBJECT, scratch)) {
    return false;
  }
  if (scratch.term_bindings.empty()) {
    return false;
  }
  initializeFilterScan(filter);
  filter.term_bindings = std::move(scratch.term_bindings);
  return true;
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
  if (basic == nullptr || basic->_triples.empty() || basic->_triples.size() > 2) {
    return std::nullopt;
  }

  try {
    SparqlTripleSimple first = basic->_triples.front().getSimple();
    auto plan = planSingleTriple(first);
    if (!plan.has_value()) {
      return std::nullopt;
    }
    if (basic->_triples.size() == 2) {
      SparqlTripleSimple second = basic->_triples[1].getSimple();
      BridgeFilterScan filter;
      if (!planSubjectFilterTriple(second, filter)) {
        return std::nullopt;
      }
      plan->filter_scans.push_back(std::move(filter));
      plan->descriptor = "xpod scan ?s ?p ?o with subject filter";
      plan->root.kind = BridgeOperationKind::HashJoin;
      plan->root.scan_indexes = {0, 1};
      plan->root.join_slot = XPOD_RDF_SLOT_SUBJECT;
      plan->root.join_slots = {
          XPOD_RDF_SLOT_SUBJECT,
          XPOD_RDF_SLOT_SUBJECT,
      };
    }
    return plan;
  } catch (...) {
    return std::nullopt;
  }
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
  return physical;
}

}  // namespace xpod::qlever
#endif

#endif
