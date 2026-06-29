#ifndef XPOD_QLEVER_OPERATION_BRIDGE_HPP
#define XPOD_QLEVER_OPERATION_BRIDGE_HPP

#include "xpod_rdf_physical_backend.h"

#include <cstddef>
#include <string_view>
#include <vector>

#if XPOD_QLEVER_ADAPTER_ENABLE_QLEVER

namespace xpod::qlever {

enum class BridgeOperationKind {
  PermutationScan,
  HashJoin,
};

struct BridgeOperationPlan {
  BridgeOperationKind kind = BridgeOperationKind::PermutationScan;
  std::vector<size_t> scan_indexes;
  uint32_t join_slot = XPOD_RDF_SLOT_SUBJECT;
};

inline std::string_view profileKind(BridgeOperationKind kind) noexcept {
  switch (kind) {
    case BridgeOperationKind::HashJoin:
      return "HashJoin";
    case BridgeOperationKind::PermutationScan:
    default:
      return "PermutationScan";
  }
}

}  // namespace xpod::qlever
#endif

#endif
