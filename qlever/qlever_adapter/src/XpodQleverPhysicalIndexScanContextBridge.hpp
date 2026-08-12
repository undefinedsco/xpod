#ifndef XPOD_QLEVER_PHYSICAL_INDEX_SCAN_CONTEXT_BRIDGE_HPP
#define XPOD_QLEVER_PHYSICAL_INDEX_SCAN_CONTEXT_BRIDGE_HPP

#include "XpodQleverPhysicalIndex.hpp"

#include <algorithm>
#include <optional>
#include <cstdio>
#include <cstdlib>
#include <string>
#include <string_view>
#include <type_traits>
#include <utility>
#include <vector>

#if XPOD_QLEVER_ADAPTER_ENABLE_QLEVER

namespace xpod::qlever {
struct QleverSizeEstimateResult {
  xpod_rdf_status status = XPOD_RDF_STATUS_UNSUPPORTED;
  bool exact = false;
  size_t rows = 0;
};

struct QleverExactSizeResult {
  xpod_rdf_status status = XPOD_RDF_STATUS_UNSUPPORTED;
  size_t rows = 0;
};

struct QleverMultiplicityEstimateResult {
  xpod_rdf_status status = XPOD_RDF_STATUS_UNSUPPORTED;
  std::vector<float> values;
};

struct QleverMetadataForScanResult {
  xpod_rdf_status status = XPOD_RDF_STATUS_UNSUPPORTED;
  std::optional<Permutation::MetadataAndBlocks> metadata;
  std::string metadata_version_storage;
  xpod_rdf_bytes metadata_version = {};
};

namespace detail {

template <typename Context, typename = void>
struct HasXpodPhysicalIndexGetter : std::false_type {};

template <typename Context>
struct HasXpodPhysicalIndexGetter<
    Context,
    decltype(void(std::declval<const Context&>().xpodPhysicalIndex()))>
    : std::true_type {};

template <typename GetterResult>
const XpodQleverPhysicalIndex* normalizePhysicalIndexGetterResult(
    const GetterResult& result) noexcept {
  if constexpr (std::is_pointer_v<std::decay_t<GetterResult>>) {
    return result;
  } else {
    return &result;
  }
}

template <typename ScanSpecAndBlocks, typename = void>
struct HasScanSpecMember : std::false_type {};

template <typename ScanSpecAndBlocks>
struct HasScanSpecMember<
    ScanSpecAndBlocks,
    decltype(void(std::declval<const ScanSpecAndBlocks&>().scanSpec_))>
    : std::true_type {};

template <typename ScanSpecAndBlocks>
decltype(auto) scanSpecificationFromScanSpecAndBlocks(
    const ScanSpecAndBlocks& scan_spec_and_blocks) noexcept {
  if constexpr (HasScanSpecMember<ScanSpecAndBlocks>::value) {
    return (scan_spec_and_blocks.scanSpec_);
  } else {
    return (scan_spec_and_blocks);
  }
}

template <typename ScanSpecAndBlocks, typename = void>
struct HasBlockMetadataView : std::false_type {};

template <typename ScanSpecAndBlocks>
struct HasBlockMetadataView<
    ScanSpecAndBlocks,
    decltype(void(std::declval<const ScanSpecAndBlocks&>()
                      .getBlockMetadataView()))> : std::true_type {};

inline void setQuadSlot(
    xpod_rdf_quad_key& quad,
    char slot,
    xpod_rdf_term_key key) noexcept {
  switch (slot) {
    case 'S':
      quad.subject = key;
      break;
    case 'P':
      quad.predicate = key;
      break;
    case 'O':
      quad.object = key;
      break;
    case 'G':
      quad.graph = key;
      break;
    default:
      break;
  }
}

template <typename QleverPermutedTriple>
xpod_rdf_quad_key quadFromQleverPermutedTriple(
    Permutation::Enum permutation,
    const QleverPermutedTriple& triple) noexcept {
  xpod_rdf_quad_key quad = {};
  const char* slots = permutationSlots(permutation);
  setQuadSlot(quad, slots[0], qleverIdToTermKey(triple.col0Id_));
  setQuadSlot(quad, slots[1], qleverIdToTermKey(triple.col1Id_));
  setQuadSlot(quad, slots[2], qleverIdToTermKey(triple.col2Id_));
  setQuadSlot(quad, 'G', qleverIdToTermKey(triple.graphId_));
  return quad;
}

template <typename QleverBlockMetadata>
xpod_rdf_scan_block_metadata blockMetadataFromQlever(
    Permutation::Enum permutation,
    const QleverBlockMetadata& block) noexcept {
  xpod_rdf_scan_block_metadata metadata = {};
  metadata.block_id = static_cast<uint64_t>(block.blockIndex_);
  metadata.row_count = static_cast<uint64_t>(block.numRows_);
  metadata.first_quad =
      quadFromQleverPermutedTriple(permutation, block.firstTriple_);
  metadata.last_quad =
      quadFromQleverPermutedTriple(permutation, block.lastTriple_);
  return metadata;
}

template <typename QleverId>
QleverId qleverIdFromTermKey(xpod_rdf_term_key key) noexcept {
  return QleverId::fromBits(static_cast<uint64_t>(key));
}

inline xpod_rdf_term_key quadTermKeyForSlot(
    const xpod_rdf_quad_key& quad,
    char slot) noexcept {
  switch (slot) {
    case 'S':
      return quad.subject;
    case 'P':
      return quad.predicate;
    case 'O':
      return quad.object;
    case 'G':
      return quad.graph;
    default:
      return 0;
  }
}

template <typename QleverPermutedTriple>
QleverPermutedTriple qleverPermutedTripleFromQuad(
    Permutation::Enum permutation,
    const xpod_rdf_quad_key& quad) noexcept {
  QleverPermutedTriple triple{};
  const char* slots = permutationSlots(permutation);
  using QleverId = std::decay_t<decltype(triple.col0Id_)>;
  triple.col0Id_ =
      qleverIdFromTermKey<QleverId>(quadTermKeyForSlot(quad, slots[0]));
  triple.col1Id_ =
      qleverIdFromTermKey<QleverId>(quadTermKeyForSlot(quad, slots[1]));
  triple.col2Id_ =
      qleverIdFromTermKey<QleverId>(quadTermKeyForSlot(quad, slots[2]));
  triple.graphId_ = qleverIdFromTermKey<QleverId>(quad.graph);
  return triple;
}

template <typename QleverBlockMetadata>
QleverBlockMetadata blockMetadataFromPhysical(
    Permutation::Enum permutation,
    const xpod_rdf_scan_block_metadata& metadata) noexcept {
  QleverBlockMetadata block{};
  block.blockIndex_ = static_cast<size_t>(metadata.block_id);
  block.numRows_ = static_cast<size_t>(metadata.row_count);
  using QleverPermutedTriple = std::decay_t<decltype(block.firstTriple_)>;
  block.firstTriple_ =
      qleverPermutedTripleFromQuad<QleverPermutedTriple>(
          permutation, metadata.first_quad);
  block.lastTriple_ =
      qleverPermutedTripleFromQuad<QleverPermutedTriple>(
          permutation, metadata.last_quad);
  return block;
}

template <typename QleverBlockMetadataStorage>
BlockMetadataRanges blockMetadataRangesFromStorage(
    const QleverBlockMetadataStorage& storage) {
  BlockMetadataRanges ranges;
  if (storage.empty()) {
    return ranges;
  }
  if constexpr (std::is_constructible_v<BlockMetadataRange,
                                        decltype(storage.begin()),
                                        decltype(storage.end())>) {
    ranges.emplace_back(storage.begin(), storage.end());
  } else {
    BlockMetadataSpan span{storage.data(), storage.size()};
    ranges.emplace_back(span.begin(), span.end());
  }
  return ranges;
}

template <typename QleverScanSpecAndBlocks, typename QleverBlockMetadataStorage>
QleverScanSpecAndBlocks scanSpecAndBlocksWithPhysicalMetadata(
    const QleverScanSpecAndBlocks& scan_spec_and_blocks,
    const QleverBlockMetadataStorage& block_metadata_storage) {
  return QleverScanSpecAndBlocks{
      scanSpecificationFromScanSpecAndBlocks(scan_spec_and_blocks),
      blockMetadataRangesFromStorage(block_metadata_storage)};
}

template <typename QleverBlockMetadata>
std::vector<xpod_rdf_scan_block_metadata> blockMetadataFromQlever(
    Permutation::Enum permutation,
    const std::vector<QleverBlockMetadata>& blocks) {
  std::vector<xpod_rdf_scan_block_metadata> result;
  result.reserve(blocks.size());
  for (const auto& block : blocks) {
    result.push_back(blockMetadataFromQlever(permutation, block));
  }
  return result;
}

template <typename QleverBlockMetadataRange>
std::vector<xpod_rdf_scan_block_metadata> blockMetadataFromQleverRange(
    Permutation::Enum permutation,
    const QleverBlockMetadataRange& blocks) {
  std::vector<xpod_rdf_scan_block_metadata> result;
  for (const auto& block : blocks) {
    result.push_back(blockMetadataFromQlever(permutation, block));
  }
  return result;
}

template <typename QleverScanSpecAndBlocks>
std::vector<xpod_rdf_scan_block_metadata>
blockMetadataFromQleverScanSpecAndBlocks(
    Permutation::Enum permutation,
    const QleverScanSpecAndBlocks& scan_spec_and_blocks) {
  if constexpr (HasBlockMetadataView<QleverScanSpecAndBlocks>::value) {
    return blockMetadataFromQleverRange(
        permutation,
        scan_spec_and_blocks.getBlockMetadataView());
  } else {
    return {};
  }
}

template <typename Context, typename = void>
struct HasAllocatorGetter : std::false_type {};

template <typename Context>
struct HasAllocatorGetter<
    Context,
    std::void_t<decltype(std::declval<const Context&>().getAllocator())>>
    : std::true_type {};

}  // namespace detail

struct QleverPhysicalScanLimitOffset {
  uint64_t limit = 0;
  uint64_t offset = 0;
};

template <typename QleverLimitOffset>
QleverPhysicalScanLimitOffset qleverPhysicalScanLimitOffset(
    const QleverLimitOffset& limit_offset) {
  if (limit_offset.isUnconstrained()) {
    return {};
  }
  return {
      static_cast<uint64_t>(limit_offset.limitOrDefault()),
      static_cast<uint64_t>(limit_offset._offset)};
}

inline void applyPhysicalScanLimitOffset(
    XpodQleverScanSpecAndBlocks& scan_spec_and_blocks,
    uint64_t limit,
    uint64_t offset) noexcept {
  scan_spec_and_blocks.limit = limit;
  scan_spec_and_blocks.offset = offset;
}

template <typename Context, typename PhysicalPermutation>
QleverIdTableResult scanWithContextAllocator(
    const Context& context,
    const PhysicalPermutation& permutation,
    const XpodQleverScanSpecAndBlocks& scan_spec_and_blocks) {
  if constexpr (detail::HasAllocatorGetter<Context>::value) {
    return permutation.scan(scan_spec_and_blocks, context.getAllocator());
  }
  return permutation.scan(scan_spec_and_blocks);
}

template <typename Context, typename PhysicalPermutation>
QleverLazyScanRangeResult lazyScanRangeWithContextAllocator(
    const Context& context,
    const PhysicalPermutation& permutation,
    const XpodQleverScanSpecAndBlocks& scan_spec_and_blocks) {
  if constexpr (detail::HasAllocatorGetter<Context>::value) {
    return permutation.lazyScanRange(
        scan_spec_and_blocks, context.getAllocator());
  }
  return permutation.lazyScanRange(scan_spec_and_blocks);
}

template <typename Context, typename PhysicalPermutation>
QleverLazyScanRangeResult lazyScanRangeWithContextAllocator(
    const Context& context,
    const PhysicalPermutation& permutation,
    const XpodQleverScanSpecAndBlocks& scan_spec_and_blocks,
    const std::vector<xpod_rdf_scan_block_metadata>& blocks,
    xpod_rdf_bytes block_metadata_version) {
  if constexpr (detail::HasAllocatorGetter<Context>::value) {
    return permutation.lazyScanRange(
        scan_spec_and_blocks, blocks, block_metadata_version,
        context.getAllocator());
  }
  return permutation.lazyScanRange(
      scan_spec_and_blocks, blocks, block_metadata_version);
}

template <typename Context>
const XpodQleverPhysicalIndex* physicalIndexFromContext(
    const Context& context) noexcept {
  if constexpr (detail::HasXpodPhysicalIndexGetter<Context>::value) {
    return detail::normalizePhysicalIndexGetterResult(
        context.xpodPhysicalIndex());
  }
  return nullptr;
}

inline void setIntersectedGraphScope(
    std::vector<xpod_rdf_term_key> graph_terms,
    XpodQleverScanSpecAndBlocks& result) {
  std::sort(graph_terms.begin(), graph_terms.end());
  graph_terms.erase(
      std::unique(graph_terms.begin(), graph_terms.end()), graph_terms.end());
  if (graph_terms.empty()) {
    result.always_empty = true;
    result.graph_scope = {XPOD_RDF_GRAPH_SCOPE_ALL, 0, {}, nullptr, 0};
    result.graph_scope_storage.clear();
    return;
  }
  result.always_empty = false;
  if (graph_terms.size() == 1) {
    result.graph_scope = {
        XPOD_RDF_GRAPH_SCOPE_EXACT, graph_terms.front(), {}, nullptr, 0};
    result.graph_scope_storage.clear();
    return;
  }
  result.graph_scope_storage = std::move(graph_terms);
  result.graph_scope = {XPOD_RDF_GRAPH_SCOPE_SET, 0, {}, nullptr, 0};
  result.refreshGraphScope();
}

inline xpod_rdf_status intersectRequestGraphScope(
    const XpodQleverPhysicalIndex& index,
    const xpod_rdf_graph_scope& request_scope,
    XpodQleverScanSpecAndBlocks& result) {
  std::vector<xpod_rdf_term_key> query_graphs;
  if (result.graph_scope.kind == XPOD_RDF_GRAPH_SCOPE_EXACT) {
    query_graphs.push_back(result.graph_scope.exact_graph);
  } else if (result.graph_scope.kind == XPOD_RDF_GRAPH_SCOPE_SET) {
    if (result.graph_scope.graph_set_size > 0 &&
        result.graph_scope.graph_set == nullptr) {
      return XPOD_RDF_STATUS_BACKEND_ERROR;
    }
    if (result.graph_scope.graph_set_size > 0) {
      query_graphs.assign(
          result.graph_scope.graph_set,
          result.graph_scope.graph_set + result.graph_scope.graph_set_size);
    }
  } else {
    return XPOD_RDF_STATUS_UNSUPPORTED;
  }

  std::vector<xpod_rdf_term_key> intersection;
  switch (request_scope.kind) {
    case XPOD_RDF_GRAPH_SCOPE_ALL:
      intersection = std::move(query_graphs);
      break;
    case XPOD_RDF_GRAPH_SCOPE_EXACT:
      if (std::find(query_graphs.begin(), query_graphs.end(),
                    request_scope.exact_graph) != query_graphs.end()) {
        intersection.push_back(request_scope.exact_graph);
      }
      break;
    case XPOD_RDF_GRAPH_SCOPE_SET:
      if (request_scope.graph_set_size > 0 &&
          request_scope.graph_set == nullptr) {
        return XPOD_RDF_STATUS_BACKEND_ERROR;
      }
      if (request_scope.graph_set_size > 0) {
        for (xpod_rdf_term_key graph : query_graphs) {
          if (std::find(request_scope.graph_set,
                        request_scope.graph_set + request_scope.graph_set_size,
                        graph) !=
              request_scope.graph_set + request_scope.graph_set_size) {
            intersection.push_back(graph);
          }
        }
      }
      break;
    case XPOD_RDF_GRAPH_SCOPE_PREFIX:
      for (xpod_rdf_term_key graph : query_graphs) {
        xpod_rdf_term resolved = {};
        xpod_rdf_status status = index.resolveTerm(graph, resolved);
        if (status != XPOD_RDF_STATUS_OK) {
          return status;
        }
        const bool prefix_matches =
            resolved.kind == XPOD_RDF_TERM_IRI &&
            resolved.value.size >= request_scope.iri_prefix.size &&
            (request_scope.iri_prefix.size == 0 ||
             std::string_view(
                 resolved.value.data, request_scope.iri_prefix.size) ==
                 std::string_view(
                     request_scope.iri_prefix.data,
                     request_scope.iri_prefix.size));
        if (prefix_matches) {
          intersection.push_back(graph);
        }
      }
      break;
    default:
      return XPOD_RDF_STATUS_UNSUPPORTED;
  }
  setIntersectedGraphScope(std::move(intersection), result);
  return XPOD_RDF_STATUS_OK;
}

template <typename QleverScanSpecification>
XpodQleverScanSpecAndBlocks physicalScanSpecAndBlocks(
    const XpodQleverPhysicalIndex& index,
    Permutation::Enum permutation,
    const QleverScanSpecification& scan_specification,
    uint32_t needed_slots) {
  auto result = index.permutation(permutation).getScanSpecAndBlocks(
      scan_specification, needed_slots);
  const PlannerRequestContext& context = index.plannerRequestContext();
  if (result.status != XPOD_RDF_STATUS_UNSUPPORTED ||
      context.request == nullptr ||
      context.request->graph_scope.kind == XPOD_RDF_GRAPH_SCOPE_ALL) {
    return result;
  }

  const xpod_rdf_graph_scope request_scope = context.request->graph_scope;
  xpod_qlever_query_request unrestricted_request = *context.request;
  unrestricted_request.graph_scope = {
      XPOD_RDF_GRAPH_SCOPE_ALL, 0, {}, nullptr, 0};
  PlannerRequestContext unrestricted_context = context;
  unrestricted_context.request = &unrestricted_request;
  XpodQleverPhysicalIndex unrestricted_index(unrestricted_context);
  result = unrestricted_index.permutation(permutation).getScanSpecAndBlocks(
      scan_specification, needed_slots);
  if (result.status == XPOD_RDF_STATUS_OK) {
    result.status = intersectRequestGraphScope(index, request_scope, result);
  }
  return result;
}

template <typename QleverScanSpecification, typename QleverPermutedTriple>
XpodQleverScanSpecAndBlocks physicalScanSpecAndBlocks(
    const XpodQleverPhysicalIndex& index,
    Permutation::Enum permutation,
    const QleverScanSpecification& scan_specification,
    const QleverPermutedTriple& permuted_triple,
    uint32_t needed_slots) {
  auto result = index.permutation(permutation).getScanSpecAndBlocks(
      scan_specification, permuted_triple, needed_slots);
  const PlannerRequestContext& context = index.plannerRequestContext();
  if (result.status != XPOD_RDF_STATUS_UNSUPPORTED ||
      context.request == nullptr ||
      context.request->graph_scope.kind == XPOD_RDF_GRAPH_SCOPE_ALL) {
    return result;
  }

  const xpod_rdf_graph_scope request_scope = context.request->graph_scope;
  xpod_qlever_query_request unrestricted_request = *context.request;
  unrestricted_request.graph_scope = {
      XPOD_RDF_GRAPH_SCOPE_ALL, 0, {}, nullptr, 0};
  PlannerRequestContext unrestricted_context = context;
  unrestricted_context.request = &unrestricted_request;
  XpodQleverPhysicalIndex unrestricted_index(unrestricted_context);
  result = unrestricted_index.permutation(permutation).getScanSpecAndBlocks(
      scan_specification, permuted_triple, needed_slots);
  if (result.status == XPOD_RDF_STATUS_OK) {
    result.status = intersectRequestGraphScope(index, request_scope, result);
  }
  return result;
}

template <typename Context, typename QleverScanSpecification>
bool canUsePhysicalScanSpecAndBlocks(
    const Context& context,
    Permutation::Enum permutation,
    const QleverScanSpecification& scan_specification) {
  const XpodQleverPhysicalIndex* index = physicalIndexFromContext(context);
  if (index == nullptr) {
    return false;
  }
  auto physical_permutation = index->permutation(permutation);
  auto scan_spec_and_blocks = physicalScanSpecAndBlocks(
      *index, permutation, scan_specification,
      XPOD_RDF_SLOT_SUBJECT | XPOD_RDF_SLOT_PREDICATE |
          XPOD_RDF_SLOT_OBJECT);
  xpod_rdf_status capability_status =
      physical_permutation.indexScanConstructionCapabilityStatus();
  if (std::getenv("XPOD_QLEVER_RUNTIME_TRACE") != nullptr) {
    std::fprintf(
        stderr,
        "xpod canUse scanSpec status=%u capability=%u permutation=%u\n",
        static_cast<unsigned>(scan_spec_and_blocks.status),
        static_cast<unsigned>(capability_status),
        static_cast<unsigned>(permutation));
  }
  return scan_spec_and_blocks.status == XPOD_RDF_STATUS_OK &&
         capability_status == XPOD_RDF_STATUS_OK;
}

template <typename Context, typename QleverScanSpecification,
          typename QleverPermutedTriple>
bool canUsePhysicalScanSpecAndBlocks(
    const Context& context,
    Permutation::Enum permutation,
    const QleverScanSpecification& scan_specification,
    const QleverPermutedTriple& permuted_triple) {
  const XpodQleverPhysicalIndex* index = physicalIndexFromContext(context);
  if (index == nullptr) {
    return false;
  }
  auto physical_permutation = index->permutation(permutation);
  auto scan_spec_and_blocks = physicalScanSpecAndBlocks(
      *index, permutation, scan_specification, permuted_triple,
      XPOD_RDF_SLOT_SUBJECT | XPOD_RDF_SLOT_PREDICATE |
          XPOD_RDF_SLOT_OBJECT);
  xpod_rdf_status capability_status =
      physical_permutation.indexScanConstructionCapabilityStatus();
  if (std::getenv("XPOD_QLEVER_RUNTIME_TRACE") != nullptr) {
    std::fprintf(
        stderr,
        "xpod canUse scanSpec+triple status=%u capability=%u "
        "permutation=%u\n",
        static_cast<unsigned>(scan_spec_and_blocks.status),
        static_cast<unsigned>(capability_status),
        static_cast<unsigned>(permutation));
  }
  return scan_spec_and_blocks.status == XPOD_RDF_STATUS_OK &&
         capability_status == XPOD_RDF_STATUS_OK;
}

template <typename Context, typename QleverScanSpecAndBlocks>
QleverSizeEstimateResult sizeEstimateFromQleverScanSpecAndBlocks(
    const Context& context,
    Permutation::Enum permutation,
    const QleverScanSpecAndBlocks& scan_spec_and_blocks,
    uint32_t needed_slots = XPOD_RDF_SLOT_SUBJECT |
                            XPOD_RDF_SLOT_PREDICATE |
                            XPOD_RDF_SLOT_OBJECT) {
  const XpodQleverPhysicalIndex* index = physicalIndexFromContext(context);
  if (index == nullptr) {
    return {};
  }
  const auto& scan_specification =
      detail::scanSpecificationFromScanSpecAndBlocks(scan_spec_and_blocks);
  auto physical_permutation = index->permutation(permutation);
  auto physical_scan_spec_and_blocks = physicalScanSpecAndBlocks(
      *index, permutation, scan_specification, needed_slots);
  auto estimate =
      physical_permutation.getSizeEstimateForScan(physical_scan_spec_and_blocks);
  if (estimate.status != XPOD_RDF_STATUS_OK) {
    return {estimate.status, false, 0};
  }
  return {
      XPOD_RDF_STATUS_OK,
      estimate.exact,
      estimate.lower + (estimate.upper - estimate.lower) / 2};
}

template <typename Context, typename QleverScanSpecAndBlocks,
          typename QleverPermutedTriple>
QleverSizeEstimateResult sizeEstimateFromQleverScanSpecAndBlocks(
    const Context& context,
    Permutation::Enum permutation,
    const QleverScanSpecAndBlocks& scan_spec_and_blocks,
    const QleverPermutedTriple& permuted_triple,
    uint32_t needed_slots = XPOD_RDF_SLOT_SUBJECT |
                            XPOD_RDF_SLOT_PREDICATE |
                            XPOD_RDF_SLOT_OBJECT) {
  const XpodQleverPhysicalIndex* index = physicalIndexFromContext(context);
  if (index == nullptr) {
    return {};
  }
  const auto& scan_specification =
      detail::scanSpecificationFromScanSpecAndBlocks(scan_spec_and_blocks);
  auto physical_permutation = index->permutation(permutation);
  auto physical_scan_spec_and_blocks = physicalScanSpecAndBlocks(
      *index, permutation, scan_specification, permuted_triple, needed_slots);
  auto estimate =
      physical_permutation.getSizeEstimateForScan(physical_scan_spec_and_blocks);
  if (estimate.status != XPOD_RDF_STATUS_OK) {
    return {estimate.status, false, 0};
  }
  return {
      XPOD_RDF_STATUS_OK,
      estimate.exact,
      estimate.lower + (estimate.upper - estimate.lower) / 2};
}

template <typename Context, typename QleverScanSpecAndBlocks>
QleverExactSizeResult exactSizeFromQleverScanSpecAndBlocks(
    const Context& context,
    Permutation::Enum permutation,
    const QleverScanSpecAndBlocks& scan_spec_and_blocks,
    uint32_t needed_slots = XPOD_RDF_SLOT_SUBJECT |
                            XPOD_RDF_SLOT_PREDICATE |
                            XPOD_RDF_SLOT_OBJECT) {
  const XpodQleverPhysicalIndex* index = physicalIndexFromContext(context);
  if (index == nullptr) {
    return {};
  }
  const auto& scan_specification =
      detail::scanSpecificationFromScanSpecAndBlocks(scan_spec_and_blocks);
  auto physical_permutation = index->permutation(permutation);
  auto physical_scan_spec_and_blocks = physicalScanSpecAndBlocks(
      *index, permutation, scan_specification, needed_slots);
  auto count =
      physical_permutation.getResultSizeOfScan(physical_scan_spec_and_blocks);
  if (count.status != XPOD_RDF_STATUS_OK) {
    return {count.status, 0};
  }
  return {XPOD_RDF_STATUS_OK, static_cast<size_t>(count.result.count)};
}

template <typename Context, typename QleverScanSpecAndBlocks,
          typename QleverPermutedTriple>
QleverExactSizeResult exactSizeFromQleverScanSpecAndBlocks(
    const Context& context,
    Permutation::Enum permutation,
    const QleverScanSpecAndBlocks& scan_spec_and_blocks,
    const QleverPermutedTriple& permuted_triple,
    uint32_t needed_slots = XPOD_RDF_SLOT_SUBJECT |
                            XPOD_RDF_SLOT_PREDICATE |
                            XPOD_RDF_SLOT_OBJECT) {
  const XpodQleverPhysicalIndex* index = physicalIndexFromContext(context);
  if (index == nullptr) {
    return {};
  }
  const auto& scan_specification =
      detail::scanSpecificationFromScanSpecAndBlocks(scan_spec_and_blocks);
  auto physical_permutation = index->permutation(permutation);
  auto physical_scan_spec_and_blocks = physicalScanSpecAndBlocks(
      *index, permutation, scan_specification, permuted_triple, needed_slots);
  auto count =
      physical_permutation.getResultSizeOfScan(physical_scan_spec_and_blocks);
  if (count.status != XPOD_RDF_STATUS_OK) {
    return {count.status, 0};
  }
  return {XPOD_RDF_STATUS_OK, static_cast<size_t>(count.result.count)};
}

template <typename Context, typename QleverScanSpecAndBlocks>
QleverMultiplicityEstimateResult multiplicitiesFromQleverScanSpecAndBlocks(
    const Context& context,
    Permutation::Enum permutation,
    const QleverScanSpecAndBlocks& scan_spec_and_blocks,
    const std::vector<uint32_t>& projected_slots) {
  QleverMultiplicityEstimateResult result = {};
  const XpodQleverPhysicalIndex* index = physicalIndexFromContext(context);
  if (index == nullptr) {
    return result;
  }
  const auto& scan_specification =
      detail::scanSpecificationFromScanSpecAndBlocks(scan_spec_and_blocks);
  uint32_t needed_slots = 0;
  for (uint32_t slot : projected_slots) {
    needed_slots |= slot;
  }
  if (needed_slots == 0) {
    result.status = XPOD_RDF_STATUS_OK;
    return result;
  }

  auto physical_permutation = index->permutation(permutation);
  auto physical_scan_spec_and_blocks = physicalScanSpecAndBlocks(
      *index, permutation, scan_specification, needed_slots);
  auto size_estimate =
      physical_permutation.getSizeEstimateForScan(physical_scan_spec_and_blocks);
  if (size_estimate.status != XPOD_RDF_STATUS_OK) {
    result.status = size_estimate.status;
    return result;
  }
  const uint64_t rows = size_estimate.upper;

  result.values.reserve(projected_slots.size());
  for (uint32_t slot : projected_slots) {
    XpodQleverDistinctEstimateResult distinct =
        physical_permutation.estimateDistinct(
            physical_scan_spec_and_blocks.pattern, slot, needed_slots);
    if (distinct.status != XPOD_RDF_STATUS_OK) {
      result.status = distinct.status;
      result.values.clear();
      return result;
    }
    const uint64_t distinct_rows = distinct.estimate.rows;
    result.values.push_back(distinct_rows == 0
                                ? 1.0f
                                : static_cast<float>(
                                      static_cast<double>(rows) /
                                      static_cast<double>(distinct_rows)));
  }
  result.status = XPOD_RDF_STATUS_OK;
  return result;
}

template <typename Context, typename QleverScanSpecAndBlocks,
          typename QleverPermutedTriple>
QleverMultiplicityEstimateResult multiplicitiesFromQleverScanSpecAndBlocks(
    const Context& context,
    Permutation::Enum permutation,
    const QleverScanSpecAndBlocks& scan_spec_and_blocks,
    const QleverPermutedTriple& permuted_triple,
    const std::vector<uint32_t>& projected_slots) {
  QleverMultiplicityEstimateResult result = {};
  const XpodQleverPhysicalIndex* index = physicalIndexFromContext(context);
  if (index == nullptr) {
    return result;
  }
  const auto& scan_specification =
      detail::scanSpecificationFromScanSpecAndBlocks(scan_spec_and_blocks);
  uint32_t needed_slots = 0;
  for (uint32_t slot : projected_slots) {
    needed_slots |= slot;
  }
  if (needed_slots == 0) {
    result.status = XPOD_RDF_STATUS_OK;
    return result;
  }

  auto physical_permutation = index->permutation(permutation);
  auto physical_scan_spec_and_blocks = physicalScanSpecAndBlocks(
      *index, permutation, scan_specification, permuted_triple, needed_slots);
  auto size_estimate =
      physical_permutation.getSizeEstimateForScan(physical_scan_spec_and_blocks);
  if (size_estimate.status != XPOD_RDF_STATUS_OK) {
    result.status = size_estimate.status;
    return result;
  }
  const uint64_t rows = size_estimate.upper;

  result.values.reserve(projected_slots.size());
  for (uint32_t slot : projected_slots) {
    XpodQleverDistinctEstimateResult distinct =
        physical_permutation.estimateDistinct(
            physical_scan_spec_and_blocks.pattern, slot, needed_slots);
    if (distinct.status != XPOD_RDF_STATUS_OK) {
      result.status = distinct.status;
      result.values.clear();
      return result;
    }
    const uint64_t distinct_rows = distinct.estimate.rows;
    result.values.push_back(distinct_rows == 0
                                ? 1.0f
                                : static_cast<float>(
                                      static_cast<double>(rows) /
                                      static_cast<double>(distinct_rows)));
  }
  result.status = XPOD_RDF_STATUS_OK;
  return result;
}

template <typename Context, typename QleverScanSpecAndBlocks,
          typename QleverPermutedTriple, typename QleverBlockMetadataStorage>
QleverMetadataForScanResult metadataForScanFromQleverScanSpecAndBlocks(
    const Context& context,
    Permutation::Enum permutation,
    const QleverScanSpecAndBlocks& scan_spec_and_blocks,
    const QleverPermutedTriple& permuted_triple,
    QleverBlockMetadataStorage& block_metadata_storage,
    uint32_t needed_slots = XPOD_RDF_SLOT_SUBJECT |
                            XPOD_RDF_SLOT_PREDICATE |
                            XPOD_RDF_SLOT_OBJECT) {
  QleverMetadataForScanResult result = {};
  const XpodQleverPhysicalIndex* index = physicalIndexFromContext(context);
  if (index == nullptr) {
    return result;
  }
  const auto& scan_specification =
      detail::scanSpecificationFromScanSpecAndBlocks(scan_spec_and_blocks);
  auto physical_permutation = index->permutation(permutation);
  auto physical_scan_spec_and_blocks = physicalScanSpecAndBlocks(
      *index, permutation, scan_specification, permuted_triple, needed_slots);
  auto physical_metadata =
      physical_permutation.getMetadataAndBlocks(physical_scan_spec_and_blocks);
  if (physical_metadata.status == XPOD_RDF_STATUS_UNSUPPORTED) {
    result.status = XPOD_RDF_STATUS_OK;
    return result;
  }
  result.status = physical_metadata.status;
  if (physical_metadata.metadata_version.size > 0 &&
      physical_metadata.metadata_version.data != nullptr) {
    result.metadata_version_storage.assign(
        physical_metadata.metadata_version.data,
        physical_metadata.metadata_version.size);
    result.metadata_version = {
        result.metadata_version_storage.data(),
        result.metadata_version_storage.size()};
  }
  if (result.status != XPOD_RDF_STATUS_OK ||
      !physical_metadata.has_metadata ||
      physical_metadata.blocks.empty()) {
    return result;
  }

  using QleverBlockMetadata =
      typename std::decay_t<QleverBlockMetadataStorage>::value_type;
  block_metadata_storage.clear();
  block_metadata_storage.reserve(physical_metadata.blocks.size());
  for (const auto& block : physical_metadata.blocks) {
    block_metadata_storage.push_back(
        detail::blockMetadataFromPhysical<QleverBlockMetadata>(
            permutation, block));
  }

  auto qlever_scan_spec_and_blocks =
      detail::scanSpecAndBlocksWithPhysicalMetadata(
          scan_spec_and_blocks, block_metadata_storage);
  typename Permutation::MetadataAndBlocks::FirstAndLastTriple bounds{
      block_metadata_storage.front().firstTriple_,
      block_metadata_storage.back().lastTriple_};
  result.metadata.emplace(
      std::move(qlever_scan_spec_and_blocks), std::move(bounds));
  return result;
}

template <typename Context, typename QleverScanSpecAndBlocks>
QleverIdTableResult materializedScanFromQleverScanSpecAndBlocks(
    const Context& context,
    Permutation::Enum permutation,
    const QleverScanSpecAndBlocks& scan_spec_and_blocks,
    uint32_t needed_slots = XPOD_RDF_SLOT_SUBJECT |
                            XPOD_RDF_SLOT_PREDICATE |
                            XPOD_RDF_SLOT_OBJECT,
    uint64_t limit = 0,
    uint64_t offset = 0) {
  const XpodQleverPhysicalIndex* index = physicalIndexFromContext(context);
  if (index == nullptr) {
    return {
        XPOD_RDF_STATUS_UNSUPPORTED,
        makeQleverIdTable(countNeededSlots(needed_slots))};
  }
  const auto& scan_specification =
      detail::scanSpecificationFromScanSpecAndBlocks(scan_spec_and_blocks);
  auto physical_permutation = index->permutation(permutation);
  auto physical_scan_spec_and_blocks = physicalScanSpecAndBlocks(
      *index, permutation, scan_specification, needed_slots);
  applyPhysicalScanLimitOffset(
      physical_scan_spec_and_blocks, limit, offset);
  return scanWithContextAllocator(
      context, physical_permutation, physical_scan_spec_and_blocks);
}

template <typename Context, typename QleverScanSpecAndBlocks,
          typename QleverPermutedTriple>
QleverIdTableResult materializedScanFromQleverScanSpecAndBlocks(
    const Context& context,
    Permutation::Enum permutation,
    const QleverScanSpecAndBlocks& scan_spec_and_blocks,
    const QleverPermutedTriple& permuted_triple,
    uint32_t needed_slots = XPOD_RDF_SLOT_SUBJECT |
                            XPOD_RDF_SLOT_PREDICATE |
                            XPOD_RDF_SLOT_OBJECT,
    uint64_t limit = 0,
    uint64_t offset = 0) {
  const XpodQleverPhysicalIndex* index = physicalIndexFromContext(context);
  if (index == nullptr) {
    return {
        XPOD_RDF_STATUS_UNSUPPORTED,
        makeQleverIdTable(countNeededSlots(needed_slots))};
  }
  const auto& scan_specification =
      detail::scanSpecificationFromScanSpecAndBlocks(scan_spec_and_blocks);
  auto physical_permutation = index->permutation(permutation);
  auto physical_scan_spec_and_blocks = physicalScanSpecAndBlocks(
      *index, permutation, scan_specification, permuted_triple, needed_slots);
  applyPhysicalScanLimitOffset(
      physical_scan_spec_and_blocks, limit, offset);
  return scanWithContextAllocator(
      context, physical_permutation, physical_scan_spec_and_blocks);
}

template <typename Context, typename QleverScanSpecification>
QleverLazyScanRangeResult lazyScanRangeFromContext(
    const Context& context,
    Permutation::Enum permutation,
    const QleverScanSpecification& scan_specification,
    const std::vector<xpod_rdf_scan_block_metadata>& blocks,
    uint32_t needed_slots = XPOD_RDF_SLOT_SUBJECT |
                            XPOD_RDF_SLOT_PREDICATE |
                            XPOD_RDF_SLOT_OBJECT,
    xpod_rdf_bytes block_metadata_version = {},
    uint64_t limit = 0,
    uint64_t offset = 0) {
  const XpodQleverPhysicalIndex* index = physicalIndexFromContext(context);
  if (index == nullptr) {
    return {XPOD_RDF_STATUS_UNSUPPORTED, {}};
  }
  auto physical_permutation = index->permutation(permutation);
  auto scan_spec_and_blocks = physicalScanSpecAndBlocks(
      *index, permutation, scan_specification, needed_slots);
  applyPhysicalScanLimitOffset(scan_spec_and_blocks, limit, offset);
  return physical_permutation.lazyScanRange(
      scan_spec_and_blocks, blocks, block_metadata_version);
}

template <typename Context, typename QleverScanSpecAndBlocks,
          typename QleverBlockMetadata>
QleverLazyScanRangeResult lazyScanRangeFromQleverScanSpecAndBlocks(
    const Context& context,
    Permutation::Enum permutation,
    const QleverScanSpecAndBlocks& scan_spec_and_blocks,
    std::optional<std::vector<QleverBlockMetadata>> blocks,
    uint32_t needed_slots = XPOD_RDF_SLOT_SUBJECT |
                            XPOD_RDF_SLOT_PREDICATE |
                            XPOD_RDF_SLOT_OBJECT,
    xpod_rdf_bytes block_metadata_version = {},
    bool allow_unrestricted_when_no_metadata = false,
    uint64_t limit = 0,
    uint64_t offset = 0) {
  std::vector<xpod_rdf_scan_block_metadata> selected_blocks =
      blocks.has_value()
          ? detail::blockMetadataFromQlever(permutation, blocks.value())
          : detail::blockMetadataFromQleverScanSpecAndBlocks(
                permutation, scan_spec_and_blocks);
  const auto& scan_specification =
      detail::scanSpecificationFromScanSpecAndBlocks(scan_spec_and_blocks);
  const XpodQleverPhysicalIndex* index = physicalIndexFromContext(context);
  if (index == nullptr) {
    return {XPOD_RDF_STATUS_UNSUPPORTED, {}};
  }
  auto physical_permutation = index->permutation(permutation);
  auto physical_scan_spec_and_blocks = physicalScanSpecAndBlocks(
      *index, permutation, scan_specification, needed_slots);
  applyPhysicalScanLimitOffset(
      physical_scan_spec_and_blocks, limit, offset);
  if (selected_blocks.empty()) {
    if (blocks.has_value()) {
      if (allow_unrestricted_when_no_metadata) {
        return lazyScanRangeWithContextAllocator(
            context, physical_permutation, physical_scan_spec_and_blocks);
      }
      return {XPOD_RDF_STATUS_OK, {}};
    }
    if (!allow_unrestricted_when_no_metadata) {
      return {XPOD_RDF_STATUS_UNSUPPORTED, {}};
    }
    return lazyScanRangeWithContextAllocator(
        context, physical_permutation, physical_scan_spec_and_blocks);
  }
  return lazyScanRangeWithContextAllocator(
      context, physical_permutation, physical_scan_spec_and_blocks,
      selected_blocks, block_metadata_version);
}

template <typename Context, typename QleverScanSpecAndBlocks,
          typename QleverPermutedTriple, typename QleverBlockMetadata>
QleverLazyScanRangeResult lazyScanRangeFromQleverScanSpecAndBlocks(
    const Context& context,
    Permutation::Enum permutation,
    const QleverScanSpecAndBlocks& scan_spec_and_blocks,
    const QleverPermutedTriple& permuted_triple,
    std::optional<std::vector<QleverBlockMetadata>> blocks,
    uint32_t needed_slots = XPOD_RDF_SLOT_SUBJECT |
                            XPOD_RDF_SLOT_PREDICATE |
                            XPOD_RDF_SLOT_OBJECT,
    xpod_rdf_bytes block_metadata_version = {},
    bool allow_unrestricted_when_no_metadata = false,
    uint64_t limit = 0,
    uint64_t offset = 0) {
  std::vector<xpod_rdf_scan_block_metadata> selected_blocks =
      blocks.has_value()
          ? detail::blockMetadataFromQlever(permutation, blocks.value())
          : detail::blockMetadataFromQleverScanSpecAndBlocks(
                permutation, scan_spec_and_blocks);
  const auto& scan_specification =
      detail::scanSpecificationFromScanSpecAndBlocks(scan_spec_and_blocks);
  const XpodQleverPhysicalIndex* index = physicalIndexFromContext(context);
  if (index == nullptr) {
    return {XPOD_RDF_STATUS_UNSUPPORTED, {}};
  }
  auto physical_permutation = index->permutation(permutation);
  auto physical_scan_spec_and_blocks = physicalScanSpecAndBlocks(
      *index, permutation, scan_specification, permuted_triple, needed_slots);
  applyPhysicalScanLimitOffset(
      physical_scan_spec_and_blocks, limit, offset);
  if (selected_blocks.empty()) {
    if (blocks.has_value()) {
      if (allow_unrestricted_when_no_metadata) {
        return lazyScanRangeWithContextAllocator(
            context, physical_permutation, physical_scan_spec_and_blocks);
      }
      return {XPOD_RDF_STATUS_OK, {}};
    }
    if (!allow_unrestricted_when_no_metadata) {
      return {XPOD_RDF_STATUS_UNSUPPORTED, {}};
    }
    return lazyScanRangeWithContextAllocator(
        context, physical_permutation, physical_scan_spec_and_blocks);
  }
  return lazyScanRangeWithContextAllocator(
      context, physical_permutation, physical_scan_spec_and_blocks,
      selected_blocks, block_metadata_version);
}

}  // namespace xpod::qlever

#endif  // XPOD_QLEVER_ADAPTER_ENABLE_QLEVER

#endif  // XPOD_QLEVER_PHYSICAL_INDEX_SCAN_CONTEXT_BRIDGE_HPP
