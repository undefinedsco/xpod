#ifndef XPOD_QLEVER_LAZY_SCAN_BRIDGE_HPP
#define XPOD_QLEVER_LAZY_SCAN_BRIDGE_HPP

#include "XpodQleverIdTableBridge.hpp"

#include <memory>
#include <optional>
#include <utility>
#include <vector>

#if XPOD_QLEVER_ADAPTER_ENABLE_QLEVER && __has_include("index/CompressedRelation.h")
#include "index/CompressedRelation.h"

namespace xpod::qlever {

struct QleverLazyScanRangeResult {
  xpod_rdf_status status;
  CompressedRelationReader::IdTableGeneratorInputRange blocks;
};

class XpodQleverVectorLazyScanRange
    : public ad_utility::InputRangeFromGet<
          IdTable,
          CompressedRelationReader::LazyScanMetadata> {
 public:
  explicit XpodQleverVectorLazyScanRange(std::vector<IdTable> blocks)
      : blocks_(std::move(blocks)) {
    details().numBlocksAll_ = blocks_.size();
  }

  std::optional<IdTable> get() override {
    if (next_block_ >= blocks_.size()) {
      return std::nullopt;
    }
    IdTable block = std::move(blocks_[next_block_]);
    ++next_block_;

    details().numBlocksRead_ = next_block_;
    details().numElementsRead_ += block.numRows();
    details().numElementsYielded_ += block.numRows();
    return block;
  }

 private:
  std::vector<IdTable> blocks_;
  size_t next_block_ = 0;
};

inline QleverLazyScanRangeResult toQleverLazyScanRange(
    QleverIdTableBlocksResult lower_result) {
  if (lower_result.status != XPOD_RDF_STATUS_OK) {
    return {lower_result.status, {}};
  }
  if (lower_result.blocks.empty()) {
    return {XPOD_RDF_STATUS_OK, {}};
  }
  auto generator = std::make_unique<XpodQleverVectorLazyScanRange>(
      std::move(lower_result.blocks));
  return {
      XPOD_RDF_STATUS_OK,
      CompressedRelationReader::IdTableGeneratorInputRange{
          std::move(generator)}};
}

}  // namespace xpod::qlever
#endif

#endif
