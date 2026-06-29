#ifndef XPOD_BACKED_INDEX_SCAN_HPP
#define XPOD_BACKED_INDEX_SCAN_HPP

#include "XpodQleverIdTableBridge.hpp"
#include "XpodQleverResultBridge.hpp"

#include <cstddef>
#include <string>
#include <utility>
#include <vector>

#if XPOD_QLEVER_ADAPTER_ENABLE_QLEVER

namespace xpod::qlever {

class XpodBackedIndexScan {
 public:
  XpodBackedIndexScan(
      xpod::rdf::PhysicalBackend backend,
      ScanRequestInput input,
      std::vector<ColumnIndex> sorted_by = {},
      size_t result_width = 3,
      std::string descriptor = "XpodBackedIndexScan") noexcept
      : backend_(backend),
        input_(input),
        sorted_by_(std::move(sorted_by)),
        result_width_(result_width),
        descriptor_(std::move(descriptor)) {}

  const std::string& getDescriptor() const noexcept { return descriptor_; }

  size_t getResultWidth() const noexcept { return result_width_; }

  const std::vector<ColumnIndex>& resultSortedOn() const noexcept {
    return sorted_by_;
  }

  QleverIdTableResult execute() const {
    return executeScanToQleverIdTable(backend_, input_);
  }

  QleverResultWithStatus executeResult() const {
    return toQleverResult(execute(), sorted_by_);
  }

  QleverResultWithStatus executeResult(
      std::vector<ColumnIndex> sorted_by) const {
    return toQleverResult(execute(), std::move(sorted_by));
  }

  QleverResultWithStatus computeResult(bool request_laziness) const {
    (void)request_laziness;
    return executeResult();
  }

 private:
  xpod::rdf::PhysicalBackend backend_;
  ScanRequestInput input_;
  std::vector<ColumnIndex> sorted_by_;
  size_t result_width_;
  std::string descriptor_;
};

}  // namespace xpod::qlever

#endif

#endif
