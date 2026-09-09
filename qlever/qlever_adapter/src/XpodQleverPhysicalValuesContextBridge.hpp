#ifndef XPOD_QLEVER_PHYSICAL_VALUES_CONTEXT_BRIDGE_HPP
#define XPOD_QLEVER_PHYSICAL_VALUES_CONTEXT_BRIDGE_HPP

#include "XpodQleverPhysicalValueIdContextBridge.hpp"

#include <optional>

#if XPOD_QLEVER_ADAPTER_ENABLE_QLEVER

namespace xpod::qlever {

template <typename Component>
std::optional<Id> physicalValuesIdFromContext(
    const QueryExecutionContext& context,
    const Component& component) {
  return physicalComponentIdFromContext(context, component);
}

}  // namespace xpod::qlever

#endif

#endif
