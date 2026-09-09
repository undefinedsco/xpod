#ifndef XPOD_QLEVER_OPERATION_BRIDGE_HPP
#define XPOD_QLEVER_OPERATION_BRIDGE_HPP

#include "XpodQleverScanBridge.hpp"
#include "xpod_rdf_physical_backend.h"

#include <array>
#include <cstddef>
#include <cstdint>
#include <string>
#include <string_view>
#include <utility>
#include <vector>

#if XPOD_QLEVER_ADAPTER_ENABLE_QLEVER
#include "global/Id.h"

namespace xpod::qlever {

inline constexpr size_t BRIDGE_NO_COLUMN = static_cast<size_t>(-1);

enum class BridgeOperationKind {
  NativeQleverTree,
  PermutationScan,
  HashJoin,
  TextSearch,
  VectorSearch,
  Values,
  NeutralElement,
  Union,
  CartesianProductJoin,
  Minus,
  OptionalJoin,
  MultiColumnJoin,
  ExistsJoin,
  GroupBy,
  TransitivePath,
  HasPredicateScan,
  Describe,
  Project,
};

enum class BridgeCandidateColumnKind {
  RetrievalPoint,
  SourceKey,
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
  Project,
  NotEqualTerm,
  EqualTerm,
  InTerm,
  NotInTerm,
  GreaterThanTerm,
  GreaterThanOrEqualTerm,
  LessThanTerm,
  LessThanOrEqualTerm,
  AlwaysFalse,
  AnyOf,
  AllOf,
  Not,
  Exists,
  StringPredicate,
  LanguageEqual,
  DatatypeEqual,
};

enum class BridgeStringFilterKind {
  Prefix,
  Contains,
  Suffix,
  Equals,
};

enum class BridgeStringValueTransform {
  None,
  Lowercase,
  Uppercase,
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
  uint64_t term_id_bits = 0;
  bool has_term_id_bits = false;
  std::vector<uint64_t> term_id_bits_list;
  std::vector<BridgeResultModifier> child_modifiers;
  bool exists_negated = false;
  size_t exists_child_index = BRIDGE_NO_COLUMN;
  std::vector<std::array<size_t, 2>> matched_columns;
  BridgeStringFilterKind string_filter = BridgeStringFilterKind::Prefix;
  BridgeStringValueTransform string_transform =
      BridgeStringValueTransform::None;
  bool string_negated = false;
  std::string string_value;
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
  std::vector<std::array<size_t, 2>> matched_columns;
  bool exists_join_negated = false;
  std::vector<size_t> right_projection_columns;
  std::vector<ColumnIndex> projection_columns;
  std::vector<std::vector<uint64_t>> value_id_rows;
  size_t value_width = 0;
  std::vector<BridgeOperationPlan> children;
  std::vector<BridgeResultModifier> result_modifiers;
  bool native_result_only = false;
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
  std::vector<BridgeCandidateOutputColumn> output_columns;
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
    case BridgeOperationKind::NativeQleverTree:
      return "QLever";
    case BridgeOperationKind::Union:
      return "Union";
    case BridgeOperationKind::CartesianProductJoin:
      return "CartesianProductJoin";
    case BridgeOperationKind::Minus:
      return "Minus";
    case BridgeOperationKind::OptionalJoin:
      return "OptionalJoin";
    case BridgeOperationKind::MultiColumnJoin:
      return "MultiColumnJoin";
    case BridgeOperationKind::ExistsJoin:
      return "ExistsJoin";
    case BridgeOperationKind::GroupBy:
      return "GroupBy";
    case BridgeOperationKind::TransitivePath:
      return "TransitivePath";
    case BridgeOperationKind::HasPredicateScan:
      return "HasPredicateScan";
    case BridgeOperationKind::Describe:
      return "Describe";
    case BridgeOperationKind::HashJoin:
      return "HashJoin";
    case BridgeOperationKind::TextSearch:
      return "TextSearch";
    case BridgeOperationKind::VectorSearch:
      return "VectorSearch";
    case BridgeOperationKind::Values:
      return "Values";
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
