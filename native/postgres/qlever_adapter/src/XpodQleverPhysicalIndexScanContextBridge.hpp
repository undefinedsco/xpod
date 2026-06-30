#ifndef XPOD_QLEVER_PHYSICAL_INDEX_SCAN_CONTEXT_BRIDGE_HPP
#define XPOD_QLEVER_PHYSICAL_INDEX_SCAN_CONTEXT_BRIDGE_HPP

#include "XpodQleverPhysicalIndex.hpp"

#include <optional>
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

}  // namespace detail

template <typename Context>
const XpodQleverPhysicalIndex* physicalIndexFromContext(
    const Context& context) noexcept {
  if constexpr (detail::HasXpodPhysicalIndexGetter<Context>::value) {
    return detail::normalizePhysicalIndexGetterResult(
        context.xpodPhysicalIndex());
  }
  return nullptr;
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
  auto scan_spec_and_blocks = physical_permutation.getScanSpecAndBlocks(
      scan_specification);
  return scan_spec_and_blocks.status == XPOD_RDF_STATUS_OK &&
         physical_permutation.indexScanConstructionCapabilityStatus() ==
             XPOD_RDF_STATUS_OK;
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
  auto physical_scan_spec_and_blocks = physical_permutation.getScanSpecAndBlocks(
      scan_specification, needed_slots);
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

template <typename Context, typename QleverScanSpecification>
QleverLazyScanRangeResult lazyScanRangeFromContext(
    const Context& context,
    Permutation::Enum permutation,
    const QleverScanSpecification& scan_specification,
    const std::vector<xpod_rdf_scan_block_metadata>& blocks,
    uint32_t needed_slots = XPOD_RDF_SLOT_SUBJECT |
                            XPOD_RDF_SLOT_PREDICATE |
                            XPOD_RDF_SLOT_OBJECT,
    xpod_rdf_bytes block_metadata_version = {}) {
  const XpodQleverPhysicalIndex* index = physicalIndexFromContext(context);
  if (index == nullptr) {
    return {XPOD_RDF_STATUS_UNSUPPORTED, {}};
  }
  auto physical_permutation = index->permutation(permutation);
  auto scan_spec_and_blocks = physical_permutation.getScanSpecAndBlocks(
      scan_specification, needed_slots);
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
    bool allow_unrestricted_when_no_metadata = false) {
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
  auto physical_scan_spec_and_blocks = physical_permutation.getScanSpecAndBlocks(
      scan_specification, needed_slots);
  if (selected_blocks.empty()) {
    if (blocks.has_value()) {
      return {XPOD_RDF_STATUS_OK, {}};
    }
    if (!allow_unrestricted_when_no_metadata) {
      return {XPOD_RDF_STATUS_UNSUPPORTED, {}};
    }
    return physical_permutation.lazyScanRange(physical_scan_spec_and_blocks);
  }
  return physical_permutation.lazyScanRange(
      physical_scan_spec_and_blocks, selected_blocks, block_metadata_version);
}

}  // namespace xpod::qlever

#endif  // XPOD_QLEVER_ADAPTER_ENABLE_QLEVER

#endif  // XPOD_QLEVER_PHYSICAL_INDEX_SCAN_CONTEXT_BRIDGE_HPP
