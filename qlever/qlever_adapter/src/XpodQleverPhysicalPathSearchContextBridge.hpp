#ifndef XPOD_QLEVER_PHYSICAL_PATH_SEARCH_CONTEXT_BRIDGE_HPP
#define XPOD_QLEVER_PHYSICAL_PATH_SEARCH_CONTEXT_BRIDGE_HPP

#include "XpodQleverPhysicalValuesContextBridge.hpp"

#include "parser/PathQuery.h"

#include <optional>
#include <variant>
#include <vector>

#if XPOD_QLEVER_ADAPTER_ENABLE_QLEVER

namespace xpod::qlever {

inline std::optional<PathSearchConfiguration>
physicalPathSearchConfigurationFromContext(
    const QueryExecutionContext& context,
    const parsedQuery::PathQuery& path_query) {
  if (physicalIndexFromContext(context) == nullptr) {
    return std::nullopt;
  }

  auto search_side = [&context](
                         const std::vector<TripleComponent>& components)
      -> std::variant<Variable, std::vector<Id>> {
    if (components.size() == 1 && components.front().isVariable()) {
      return components.front().getVariable();
    }
    std::vector<Id> ids;
    ids.reserve(components.size());
    for (const TripleComponent& component : components) {
      if (component.isVariable()) {
        throw parsedQuery::PathSearchException(
            "Only one variable is allowed per search side");
      }
      auto id = physicalValuesIdFromContext(context, component);
      if (!id.has_value()) {
        throw parsedQuery::PathSearchException(
            "No vocabulary entry for " + component.toString());
      }
      ids.push_back(*id);
    }
    return ids;
  };

  if (!path_query.start_.has_value()) {
    throw parsedQuery::PathSearchException(
        "Missing parameter <start> in path search.");
  }
  if (!path_query.end_.has_value()) {
    throw parsedQuery::PathSearchException(
        "Missing parameter <end> in path search.");
  }
  if (!path_query.pathColumn_.has_value()) {
    throw parsedQuery::PathSearchException(
        "Missing parameter <pathColumn> in path search.");
  }
  if (!path_query.edgeColumn_.has_value()) {
    throw parsedQuery::PathSearchException(
        "Missing parameter <edgeColumn> in path search.");
  }

  return PathSearchConfiguration{
      path_query.algorithm_,
      search_side(path_query.sources_),
      search_side(path_query.targets_),
      *path_query.start_,
      *path_query.end_,
      *path_query.pathColumn_,
      *path_query.edgeColumn_,
      path_query.edgeProperties_,
      path_query.cartesian_,
      path_query.numPathsPerTarget_};
}

}  // namespace xpod::qlever

#endif

#endif
