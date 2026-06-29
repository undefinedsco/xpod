#ifndef XPOD_BACKED_CANDIDATE_OPERATION_HPP
#define XPOD_BACKED_CANDIDATE_OPERATION_HPP

#include "XpodCandidateBridge.hpp"

namespace xpod::qlever {

struct XpodBackedCandidateEstimate {
  xpod_rdf_status status = XPOD_RDF_STATUS_UNSUPPORTED;
  xpod_rdf_estimate estimate = {};
};

struct XpodBackedCandidateResult {
  xpod_rdf_status status = XPOD_RDF_STATUS_UNSUPPORTED;
  xpod::rdf::CandidateBuffer candidates = {};
};

inline xpod_rdf_status validateBackendFeatureCapability(
    const xpod::rdf::PhysicalBackend& backend,
    uint32_t feature) noexcept {
  xpod_rdf_backend_capabilities capabilities = {};
  xpod_rdf_status status = backend.getCapabilities(capabilities);
  if (status == XPOD_RDF_STATUS_UNSUPPORTED) {
    return XPOD_RDF_STATUS_OK;
  }
  if (status != XPOD_RDF_STATUS_OK) {
    return status;
  }
  return (capabilities.features & feature) != 0
             ? XPOD_RDF_STATUS_OK
             : XPOD_RDF_STATUS_UNSUPPORTED;
}

}  // namespace xpod::qlever

#endif
