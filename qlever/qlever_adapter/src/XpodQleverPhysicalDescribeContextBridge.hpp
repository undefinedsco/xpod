#ifndef XPOD_QLEVER_PHYSICAL_DESCRIBE_CONTEXT_BRIDGE_HPP
#define XPOD_QLEVER_PHYSICAL_DESCRIBE_CONTEXT_BRIDGE_HPP

#include "XpodQleverPhysicalIndexScanContextBridge.hpp"
#include "XpodQleverValueIdBridge.hpp"

#include <optional>

#if XPOD_QLEVER_ADAPTER_ENABLE_QLEVER

namespace xpod::qlever {

template <typename Component>
std::optional<Id> physicalDescribeIdFromContext(
    const QueryExecutionContext& context,
    const Component& component) {
  const XpodQleverPhysicalIndex* index = physicalIndexFromContext(context);
  if (index == nullptr || detail::qleverComponentIsVariable(component)) {
    return std::nullopt;
  }

  const PlannerRequestContext& planner_context =
      index->plannerRequestContext();
  xpod_rdf_term_key term = 0;
  xpod_rdf_status status =
      qleverComponentToPhysicalTermKey(planner_context, component, term);
  if (status != XPOD_RDF_STATUS_OK) {
    return std::nullopt;
  }

  uint64_t bits = 0;
  status = planner_context.backend.encodeQleverId(term, bits);
  if (status != XPOD_RDF_STATUS_OK) {
    return std::nullopt;
  }
  return toQleverId(bits);
}

}  // namespace xpod::qlever

#endif

#endif
