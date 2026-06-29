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

}  // namespace xpod::qlever

#endif
