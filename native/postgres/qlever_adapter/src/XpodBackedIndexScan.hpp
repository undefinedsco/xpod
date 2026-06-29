#ifndef XPOD_BACKED_INDEX_SCAN_HPP
#define XPOD_BACKED_INDEX_SCAN_HPP

#include "XpodQleverIdTableBridge.hpp"

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

 private:
  xpod::rdf::PhysicalBackend backend_;
  ScanRequestInput input_;
};

}  // namespace xpod::qlever

#endif

#endif
