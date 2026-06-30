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

struct XpodBackedScanEstimate {
  xpod_rdf_status status;
  xpod_rdf_estimate estimate;
};

class XpodBackedIndexScan {
 public:
  XpodBackedIndexScan(
      xpod::rdf::PhysicalBackend backend,
      ScanRequestInput input,
      std::vector<ColumnIndex> sorted_by = {},
      size_t result_width = 3,
      std::string descriptor = "XpodBackedIndexScan",
      xpod_rdf_profile_node_key profile_node = 0,
      xpod_rdf_profile_node_key parent_profile_node = 0) noexcept
      : backend_(backend),
        input_(input),
        sorted_by_(std::move(sorted_by)),
        result_width_(result_width),
        descriptor_(std::move(descriptor)),
        profile_node_(profile_node),
        parent_profile_node_(parent_profile_node),
        has_parent_profile_node_(parent_profile_node != 0) {}

  const std::string& getDescriptor() const noexcept { return descriptor_; }

  size_t getResultWidth() const noexcept { return result_width_; }

  const std::vector<ColumnIndex>& resultSortedOn() const noexcept {
    return effectiveSortedBy();
  }

  XpodBackedScanEstimate estimate() const {
    xpod_rdf_status capability_status = validatePermutationCapability();
    if (capability_status != XPOD_RDF_STATUS_OK) {
      return {capability_status, {}};
    }
    xpod_rdf_estimate estimate = {};
    xpod_rdf_scan_request request = makeScanRequest(input_);
    return {backend_.estimateScan(request, estimate), estimate};
  }

  size_t getSizeEstimate() const {
    XpodBackedScanEstimate result = estimate();
    if (result.status != XPOD_RDF_STATUS_OK) {
      return 0;
    }
    return static_cast<size_t>(result.estimate.rows);
  }

  size_t getCostEstimate() const {
    XpodBackedScanEstimate result = estimate();
    if (result.status != XPOD_RDF_STATUS_OK) {
      return 0;
    }
    double cost = result.estimate.startup_cost + result.estimate.cpu_cost +
                  result.estimate.io_cost;
    if (cost <= 0) {
      return static_cast<size_t>(result.estimate.rows);
    }
    return static_cast<size_t>(cost);
  }

  bool knownEmptyResult() const {
    XpodBackedScanEstimate result = estimate();
    return result.status == XPOD_RDF_STATUS_OK &&
           result.estimate.confidence == XPOD_RDF_ESTIMATE_EXACT &&
           result.estimate.rows == 0;
  }

  QleverIdTableResult execute() const {
    xpod_rdf_status capability_status = validatePermutationCapability();
    if (capability_status != XPOD_RDF_STATUS_OK) {
      return {capability_status, makeQleverIdTable(result_width_)};
    }
    return executeScanToQleverIdTable(backend_, input_);
  }

  QleverResultWithStatus executeResult() const {
    return toQleverResult(execute(), effectiveSortedBy());
  }

  QleverResultWithStatus executeResult(
      std::vector<ColumnIndex> sorted_by) const {
    if (!backend_.preservesQleverTermOrder()) {
      sorted_by.clear();
    }
    return toQleverResult(execute(), std::move(sorted_by));
  }

  QleverResultWithStatus computeResult(bool request_laziness) const {
    (void)request_laziness;
    XpodBackedScanEstimate estimate_result = estimate();
    emitProfileEvent(XPOD_RDF_PROFILE_RUNNING, estimate_result, 0);

    QleverResultWithStatus result = executeResult();
    uint64_t output_rows = result.status == XPOD_RDF_STATUS_OK
                               ? result.result.idTable().numRows()
                               : 0;
    emitProfileEvent(
        result.status == XPOD_RDF_STATUS_OK ? XPOD_RDF_PROFILE_COMPLETED
                                            : XPOD_RDF_PROFILE_FAILED,
        estimate_result, output_rows);
    return result;
  }

 private:
  xpod_rdf_status validatePermutationCapability() const noexcept {
    xpod_rdf_backend_capabilities capabilities = {};
    xpod_rdf_status status = backend_.getCapabilities(capabilities);
    if (status == XPOD_RDF_STATUS_UNSUPPORTED) {
      return XPOD_RDF_STATUS_OK;
    }
    if (status != XPOD_RDF_STATUS_OK) {
      return status;
    }
    if ((capabilities.supported_permutations &
         toXpodPermutationCapability(input_.permutation)) == 0) {
      return XPOD_RDF_STATUS_UNSUPPORTED;
    }
    if (!input_.block_metadata.empty() &&
        (capabilities.features &
         XPOD_RDF_BACKEND_FEATURE_BLOCK_RESTRICTED_SCAN) == 0) {
      return XPOD_RDF_STATUS_UNSUPPORTED;
    }
    return XPOD_RDF_STATUS_OK;
  }

  const std::vector<ColumnIndex>& effectiveSortedBy() const noexcept {
    if (backend_.preservesQleverTermOrder()) {
      return sorted_by_;
    }
    static const std::vector<ColumnIndex> empty;
    return empty;
  }

  void emitProfileEvent(
      xpod_rdf_profile_status status,
      const XpodBackedScanEstimate& estimate_result,
      uint64_t output_rows) const noexcept {
    xpod_rdf_profile_event event = {};
    event.node = profile_node_;
    event.parent = parent_profile_node_;
    event.has_parent = has_parent_profile_node_ ? 1 : 0;
    event.kind = XPOD_RDF_PROFILE_PERMUTATION_SCAN;
    event.status = status;
    event.descriptor = {descriptor_.data(), descriptor_.size()};
    if (estimate_result.status == XPOD_RDF_STATUS_OK) {
      event.estimate = estimate_result.estimate;
    }
    event.output_rows = output_rows;
    backend_.emitProfileEvent(event);
  }

  xpod::rdf::PhysicalBackend backend_;
  ScanRequestInput input_;
  std::vector<ColumnIndex> sorted_by_;
  size_t result_width_;
  std::string descriptor_;
  xpod_rdf_profile_node_key profile_node_;
  xpod_rdf_profile_node_key parent_profile_node_;
  bool has_parent_profile_node_;
};

}  // namespace xpod::qlever

#endif

#endif
