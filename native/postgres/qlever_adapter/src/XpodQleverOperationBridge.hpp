#ifndef XPOD_QLEVER_OPERATION_BRIDGE_HPP
#define XPOD_QLEVER_OPERATION_BRIDGE_HPP

#include "XpodQleverScanBridge.hpp"
#include "xpod_rdf_physical_backend.h"

#include <cstddef>
#include <string>
#include <string_view>
#include <vector>

#if XPOD_QLEVER_ADAPTER_ENABLE_QLEVER
#include "global/Id.h"

namespace xpod::qlever {

enum class BridgeOperationKind {
  PermutationScan,
  HashJoin,
  TextSearch,
  VectorSearch,
};

struct BridgeOperationPlan {
  BridgeOperationKind kind = BridgeOperationKind::PermutationScan;
  std::vector<size_t> scan_indexes;
  size_t candidate_index = 0;
  uint32_t join_slot = XPOD_RDF_SLOT_SUBJECT;
};

struct BridgePhysicalScan {
  ScanRequestInput scan;
  std::vector<ColumnIndex> sorted_by;
  size_t result_width = 3;
  std::string descriptor = "XpodBackedIndexScan";
  xpod_rdf_profile_node_key profile_node = 0;
  xpod_rdf_profile_node_key parent_profile_node = 0;
};

struct BridgeTextCandidateSource {
  xpod_rdf_text_search_request request = {};
  std::string descriptor = "XpodBackedTextSearch";
  xpod_rdf_profile_node_key profile_node = 0;
  xpod_rdf_profile_node_key parent_profile_node = 0;
};

struct BridgeVectorCandidateSource {
  xpod_rdf_vector_search_request request = {};
  std::string descriptor = "XpodBackedVectorSearch";
  xpod_rdf_profile_node_key profile_node = 0;
  xpod_rdf_profile_node_key parent_profile_node = 0;
};

struct BridgePhysicalPlan {
  std::vector<BridgePhysicalScan> scans;
  std::vector<BridgeTextCandidateSource> text_sources;
  std::vector<BridgeVectorCandidateSource> vector_sources;
  BridgeOperationPlan root;
};

inline std::string_view profileKind(BridgeOperationKind kind) noexcept {
  switch (kind) {
    case BridgeOperationKind::HashJoin:
      return "HashJoin";
    case BridgeOperationKind::TextSearch:
      return "TextSearch";
    case BridgeOperationKind::VectorSearch:
      return "VectorSearch";
    case BridgeOperationKind::PermutationScan:
    default:
      return "PermutationScan";
  }
}

}  // namespace xpod::qlever
#endif

#endif
