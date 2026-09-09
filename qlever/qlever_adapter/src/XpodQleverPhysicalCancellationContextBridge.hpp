#ifndef XPOD_QLEVER_PHYSICAL_CANCELLATION_CONTEXT_BRIDGE_HPP
#define XPOD_QLEVER_PHYSICAL_CANCELLATION_CONTEXT_BRIDGE_HPP

#include "XpodQleverPhysicalIndexScanContextBridge.hpp"

#if XPOD_QLEVER_ADAPTER_ENABLE_QLEVER

namespace xpod::qlever {

template <typename Context>
inline bool physicalCancellationRequested(const Context* context) noexcept {
  if (context == nullptr) {
    return false;
  }
  const XpodQleverPhysicalIndex* index = physicalIndexFromContext(*context);
  if (index == nullptr) {
    return false;
  }
  const xpod_rdf_cancellation* cancellation =
      index->plannerRequestContext().cancellation;
  return cancellation != nullptr && cancellation->is_cancelled != nullptr &&
         cancellation->is_cancelled(cancellation->cancellation_user_data) != 0;
}

}  // namespace xpod::qlever

#endif

#endif
