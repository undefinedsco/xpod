#ifndef XPOD_QLEVER_PHYSICAL_SPATIAL_CONTEXT_BRIDGE_HPP
#define XPOD_QLEVER_PHYSICAL_SPATIAL_CONTEXT_BRIDGE_HPP

#include "XpodQleverPhysicalValueIdContextBridge.hpp"

#include <optional>
#include <string>

#if XPOD_QLEVER_ADAPTER_ENABLE_QLEVER
#include "engine/QueryExecutionContext.h"
#include "global/Constants.h"
#include "parser/NormalizedString.h"

namespace xpod::qlever {

inline std::optional<std::string> physicalWktLiteralFromContext(
    const Id& id,
    const QueryExecutionContext& context) {
  auto entry = physicalValueIdEntry(
      id, context.xpodPhysicalIndex(), context.getLocalVocabContext());
  if (!entry.has_value() || !entry->isLiteral()) {
    return std::nullopt;
  }
  const auto& literal = entry->getLiteral();
  if (!literal.hasDatatype() ||
      asStringViewUnsafe(literal.getDatatype()) != GEO_WKT_LITERAL) {
    return std::nullopt;
  }
  return std::string(asStringViewUnsafe(literal.getContent()));
}

}  // namespace xpod::qlever
#endif

#endif
