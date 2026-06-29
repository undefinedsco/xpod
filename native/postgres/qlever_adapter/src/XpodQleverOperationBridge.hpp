#ifndef XPOD_QLEVER_OPERATION_BRIDGE_HPP
#define XPOD_QLEVER_OPERATION_BRIDGE_HPP

#include "XpodQleverScanBridge.hpp"
#include "xpod_rdf_physical_backend.h"

#include <array>
#include <cstddef>
#include <string>
#include <string_view>
#include <utility>
#include <vector>

#if XPOD_QLEVER_ADAPTER_ENABLE_QLEVER
#include "global/Id.h"

namespace xpod::qlever {

enum class BridgeOperationKind {
  PermutationScan,
  HashJoin,
  TextSearch,
  VectorSearch,
  NeutralElement,
  Union,
  CartesianProductJoin,
};

enum class BridgeCandidateColumnKind {
  RetrievalPoint,
  ResourceTerm,
};

enum class BridgeCandidateSourceKind {
  Text,
  Vector,
};

enum class BridgeResultModifierKind {
  LimitOffset,
  Distinct,
  OrderBy,
  InternalSort,
};

struct BridgeCandidateOutputColumn {
  std::string variable;
  BridgeCandidateColumnKind kind = BridgeCandidateColumnKind::RetrievalPoint;
};

struct BridgeResultModifier {
  BridgeResultModifierKind kind = BridgeResultModifierKind::LimitOffset;
  size_t limit = 0;
  size_t offset = 0;
  std::vector<ColumnIndex> columns;
  std::vector<bool> descending;
};

struct BridgeOperationPlan {
  BridgeOperationKind kind = BridgeOperationKind::PermutationScan;
  std::vector<size_t> scan_indexes;
  size_t candidate_index = 0;
  BridgeCandidateSourceKind candidate_source = BridgeCandidateSourceKind::Text;
  bool use_candidate_join = false;
  BridgeCandidateColumnKind candidate_join_column =
      BridgeCandidateColumnKind::ResourceTerm;
  std::vector<BridgeCandidateOutputColumn> candidate_project_columns;
  uint32_t join_slot = XPOD_RDF_SLOT_SUBJECT;
  std::vector<uint32_t> join_slots;
  std::vector<std::vector<uint32_t>> join_key_slots;
  std::vector<std::vector<uint32_t>> scan_project_slots;
  bool has_limit = false;
  size_t limit = 0;
  size_t offset = 0;
  bool has_distinct = false;
  std::vector<ColumnIndex> distinct_columns;
  std::vector<ColumnIndex> sorted_by;
  std::vector<std::array<size_t, 2>> column_origins;
  std::vector<BridgeOperationPlan> children;
  std::vector<BridgeResultModifier> result_modifiers;
  xpod_rdf_profile_node_key profile_node = 0;
  xpod_rdf_profile_node_key parent_profile_node = 0;
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
  bool owns_query = false;
  bool owns_required_entities = false;
  std::string query_storage;
  std::vector<xpod_rdf_term_key> required_entities_storage;
  std::vector<BridgeCandidateOutputColumn> output_columns;
  std::string descriptor = "XpodBackedTextSearch";
  xpod_rdf_profile_node_key profile_node = 0;
  xpod_rdf_profile_node_key parent_profile_node = 0;

  BridgeTextCandidateSource() = default;

  BridgeTextCandidateSource(const BridgeTextCandidateSource& other)
      : request(other.request),
        owns_query(other.owns_query),
        owns_required_entities(other.owns_required_entities),
        query_storage(other.query_storage),
        required_entities_storage(other.required_entities_storage),
        output_columns(other.output_columns),
        descriptor(other.descriptor),
        profile_node(other.profile_node),
        parent_profile_node(other.parent_profile_node) {
    refreshViews();
  }

  BridgeTextCandidateSource& operator=(
      const BridgeTextCandidateSource& other) {
    if (this == &other) {
      return *this;
    }
    request = other.request;
    owns_query = other.owns_query;
    owns_required_entities = other.owns_required_entities;
    query_storage = other.query_storage;
    required_entities_storage = other.required_entities_storage;
    output_columns = other.output_columns;
    descriptor = other.descriptor;
    profile_node = other.profile_node;
    parent_profile_node = other.parent_profile_node;
    refreshViews();
    return *this;
  }

  BridgeTextCandidateSource(BridgeTextCandidateSource&& other) noexcept
      : request(other.request),
        owns_query(other.owns_query),
        owns_required_entities(other.owns_required_entities),
        query_storage(std::move(other.query_storage)),
        required_entities_storage(std::move(other.required_entities_storage)),
        output_columns(std::move(other.output_columns)),
        descriptor(std::move(other.descriptor)),
        profile_node(other.profile_node),
        parent_profile_node(other.parent_profile_node) {
    refreshViews();
  }

  BridgeTextCandidateSource& operator=(
      BridgeTextCandidateSource&& other) noexcept {
    if (this == &other) {
      return *this;
    }
    request = other.request;
    owns_query = other.owns_query;
    owns_required_entities = other.owns_required_entities;
    query_storage = std::move(other.query_storage);
    required_entities_storage = std::move(other.required_entities_storage);
    output_columns = std::move(other.output_columns);
    descriptor = std::move(other.descriptor);
    profile_node = other.profile_node;
    parent_profile_node = other.parent_profile_node;
    refreshViews();
    return *this;
  }

  void setQuery(std::string query) {
    query_storage = std::move(query);
    owns_query = true;
    refreshViews();
  }

  void setRequiredEntities(std::vector<xpod_rdf_term_key> keys) {
    required_entities_storage = std::move(keys);
    owns_required_entities = true;
    refreshViews();
  }

  void refreshViews() noexcept {
    if (owns_query) {
      request.query = {query_storage.data(), query_storage.size()};
    }
    if (owns_required_entities) {
      request.required_entities = required_entities_storage.data();
      request.required_entities_size = required_entities_storage.size();
    }
  }
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
    case BridgeOperationKind::Union:
      return "Union";
    case BridgeOperationKind::CartesianProductJoin:
      return "CartesianProductJoin";
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

inline bool isBridgeCandidateRoot(BridgeOperationKind kind) noexcept {
  return kind == BridgeOperationKind::TextSearch ||
         kind == BridgeOperationKind::VectorSearch;
}

}  // namespace xpod::qlever
#endif

#endif
