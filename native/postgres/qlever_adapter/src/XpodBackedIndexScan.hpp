#ifndef XPOD_BACKED_INDEX_SCAN_HPP
#define XPOD_BACKED_INDEX_SCAN_HPP

#include "XpodQleverIdTableBridge.hpp"
#include "XpodQleverResultBridge.hpp"

#include <utility>
#include <vector>

#if XPOD_QLEVER_ADAPTER_ENABLE_QLEVER

namespace xpod::qlever {

class XpodBackedIndexScan {
 public:
  XpodBackedIndexScan(
      xpod::rdf::PhysicalBackend backend,
      ScanRequestInput input) noexcept
      : backend_(backend), input_(input) {}

  QleverIdTableResult execute() const {
    return executeScanToQleverIdTable(backend_, input_);
  }

  QleverResultWithStatus executeResult(
      std::vector<ColumnIndex> sorted_by = {}) const {
    return toQleverResult(execute(), std::move(sorted_by));
  }

 private:
  xpod::rdf::PhysicalBackend backend_;
  ScanRequestInput input_;
};

}  // namespace xpod::qlever

#endif

#endif
