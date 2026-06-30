#ifndef XPOD_QLEVER_PHYSICAL_INDEX_SCAN_CONTEXT_BRIDGE_HPP
#define XPOD_QLEVER_PHYSICAL_INDEX_SCAN_CONTEXT_BRIDGE_HPP

#include "XpodQleverPhysicalIndex.hpp"

#include <type_traits>
#include <utility>
#include <vector>

#if XPOD_QLEVER_ADAPTER_ENABLE_QLEVER

namespace xpod::qlever {
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

}  // namespace xpod::qlever

#endif  // XPOD_QLEVER_ADAPTER_ENABLE_QLEVER

#endif  // XPOD_QLEVER_PHYSICAL_INDEX_SCAN_CONTEXT_BRIDGE_HPP
