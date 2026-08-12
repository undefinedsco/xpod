#ifndef XPOD_BACKED_TEXT_SEARCH_HPP
#define XPOD_BACKED_TEXT_SEARCH_HPP

#include "XpodBackedCandidateOperation.hpp"

#include <string>
#include <utility>

namespace xpod::qlever {

class XpodBackedTextSearch {
 public:
  XpodBackedTextSearch(
      xpod::rdf::PhysicalBackend backend,
      xpod_rdf_text_search_request request,
      std::string descriptor = "XpodBackedTextSearch",
      xpod_rdf_profile_node_key profile_node = 0,
      xpod_rdf_profile_node_key parent_profile_node = 0) noexcept
      : backend_(backend),
        request_(request),
        descriptor_(std::move(descriptor)),
        profile_node_(profile_node),
        parent_profile_node_(parent_profile_node),
        has_parent_profile_node_(parent_profile_node != 0) {}

  const std::string& getDescriptor() const noexcept { return descriptor_; }

  XpodBackedCandidateEstimate estimate() const {
    xpod_rdf_status capability_status = validateBackendFeatureCapability(
        backend_, XPOD_RDF_BACKEND_FEATURE_TEXT_SEARCH);
    if (capability_status != XPOD_RDF_STATUS_OK) {
      return {capability_status, {}};
    }
    xpod_rdf_estimate estimate = {};
    return {backend_.estimateTextSearch(request_, estimate), estimate};
  }

  size_t getSizeEstimate() const {
    XpodBackedCandidateEstimate result = estimate();
    if (result.status != XPOD_RDF_STATUS_OK) {
      return 0;
    }
    return static_cast<size_t>(result.estimate.rows);
  }

  size_t getCostEstimate() const {
    XpodBackedCandidateEstimate result = estimate();
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

  XpodBackedCandidateResult execute() const {
    xpod_rdf_status capability_status = validateBackendFeatureCapability(
        backend_, XPOD_RDF_BACKEND_FEATURE_TEXT_SEARCH);
    if (capability_status != XPOD_RDF_STATUS_OK) {
      return {capability_status, {}};
    }
    xpod::rdf::CandidateBuffer candidates;
    xpod_rdf_status status =
        xpod::rdf::executeTextSearchToCandidates(backend_, request_, candidates);
    return {status, std::move(candidates)};
  }

  XpodBackedCandidateResult computeResult(bool request_laziness) const {
    (void)request_laziness;
    XpodBackedCandidateEstimate estimate_result = estimate();
    emitProfileEvent(XPOD_RDF_PROFILE_RUNNING, estimate_result, 0, 0);

    XpodBackedCandidateResult result = execute();
    uint64_t output_rows = result.status == XPOD_RDF_STATUS_OK
                               ? result.candidates.rows.size()
                               : 0;
    uint64_t scanned_rows = result.status == XPOD_RDF_STATUS_OK
                               ? result.candidates.scanned_rows
                               : 0;
    emitProfileEvent(
        result.status == XPOD_RDF_STATUS_OK ? XPOD_RDF_PROFILE_COMPLETED
                                            : XPOD_RDF_PROFILE_FAILED,
        estimate_result, output_rows, scanned_rows);
    return result;
  }

 private:
  void emitProfileEvent(
      xpod_rdf_profile_status status,
      const XpodBackedCandidateEstimate& estimate_result,
      uint64_t output_rows,
      uint64_t scanned_rows) const noexcept {
    xpod_rdf_profile_event event = {};
    event.node = profile_node_;
    event.parent = parent_profile_node_;
    event.has_parent = has_parent_profile_node_ ? 1 : 0;
    event.kind = XPOD_RDF_PROFILE_TEXT_SEARCH;
    event.status = status;
    event.descriptor = {descriptor_.data(), descriptor_.size()};
    if (estimate_result.status == XPOD_RDF_STATUS_OK) {
      event.estimate = estimate_result.estimate;
    }
    event.output_rows = output_rows;
    event.scanned_rows = scanned_rows;
    backend_.emitProfileEvent(event);
  }

  xpod::rdf::PhysicalBackend backend_;
  xpod_rdf_text_search_request request_;
  std::string descriptor_;
  xpod_rdf_profile_node_key profile_node_;
  xpod_rdf_profile_node_key parent_profile_node_;
  bool has_parent_profile_node_;
};

}  // namespace xpod::qlever

#endif
