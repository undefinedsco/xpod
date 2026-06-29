#ifndef XPOD_QLEVER_PLANNER_SCAN_INPUT_HPP
#define XPOD_QLEVER_PLANNER_SCAN_INPUT_HPP

#include "XpodQleverPlannerRequestContext.hpp"
#include "XpodQleverScanBridge.hpp"
#include "xpod_qlever_adapter.h"

#if XPOD_QLEVER_ADAPTER_ENABLE_QLEVER

namespace xpod::qlever {

inline ScanRequestInput makeScanRequestInput(
    const PlannerRequestContext& context,
    Permutation::Enum permutation,
    TripleKeyPattern pattern = {}) noexcept {
  ScanRequestInput input = {};
  input.snapshot =
      context.request == nullptr ? nullptr : &context.request->snapshot;
  input.permutation = permutation;
  input.pattern = pattern;
  if (context.request != nullptr) {
    input.graph_scope = context.request->graph_scope;
  }
  input.source_scope =
      context.request == nullptr ? nullptr : &context.request->source_scope;
  input.access_scope =
      context.request == nullptr ? nullptr : context.request->access_scope;
  return input;
}

}  // namespace xpod::qlever

#endif

#endif
