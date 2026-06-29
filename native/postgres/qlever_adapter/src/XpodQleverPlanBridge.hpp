#ifndef XPOD_QLEVER_PLAN_BRIDGE_HPP
#define XPOD_QLEVER_PLAN_BRIDGE_HPP

#include "XpodQleverScanBridge.hpp"
#include "xpod_rdf_physical_backend.h"

#include <optional>
#include <string>
#include <string_view>
#include <vector>

#if XPOD_QLEVER_ADAPTER_ENABLE_QLEVER
#include "global/Id.h"
#include "parser/ParsedQuery.h"
#include "parser/SparqlTriple.h"

namespace xpod::qlever {

struct BridgeQueryPlan {
  ScanRequestInput scan;
  std::vector<ColumnIndex> sorted_by;
  size_t result_width = 0;
  std::string descriptor;
};

inline bool variableNamed(
    const TripleComponent& component,
    std::string_view name) {
  return component.isVariable() && component.getVariable().name() == name;
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
    if (!variableNamed(triple.s_, "?s") ||
        !variableNamed(triple.p_, "?p") ||
        !variableNamed(triple.o_, "?o")) {
      return std::nullopt;
    }
  } catch (...) {
    return std::nullopt;
  }

  BridgeQueryPlan plan;
  plan.scan.permutation = Permutation::Enum::SPO;
  plan.scan.needed_slots = XPOD_RDF_SLOT_SUBJECT | XPOD_RDF_SLOT_PREDICATE |
                           XPOD_RDF_SLOT_OBJECT;
  plan.sorted_by = {0};
  plan.result_width = 3;
  plan.descriptor = "xpod scan ?s ?p ?o";
  return plan;
}

}  // namespace xpod::qlever
#endif

#endif
