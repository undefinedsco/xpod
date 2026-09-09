#ifndef XPOD_CANDIDATE_BRIDGE_HPP
#define XPOD_CANDIDATE_BRIDGE_HPP

#include "XpodPhysicalBackend.hpp"

#include <string>
#include <utility>
#include <vector>

namespace xpod::rdf {

inline std::string copyBytes(xpod_rdf_bytes bytes) {
  if (bytes.data == nullptr || bytes.size == 0) {
    return {};
  }
  return std::string(bytes.data, bytes.size);
}

struct CandidateRow {
  xpod_rdf_source_node_key source_node = 0;
  bool has_source_node = false;
  xpod_rdf_retrieval_point_key retrieval_point = 0;
  bool has_retrieval_point = false;
  std::string source_key;
  bool has_source_key = false;
  std::string retrieval_point_key;
  bool has_retrieval_point_key = false;
  xpod_rdf_term_key resource_term = 0;
  bool has_resource_term = false;
  xpod_rdf_text_term_key matched_term = 0;
  bool has_matched_term = false;
  double score = 0;
  xpod_rdf_source_range range = {};
  std::string scorer;
};

struct CandidateBuffer {
  std::vector<CandidateRow> rows;
  uint64_t scanned_rows = 0;
  std::string scorer;
};

inline void appendCandidateBatch(
    CandidateBuffer& buffer,
    const xpod_rdf_candidate_batch& batch,
    bool supports_matched_term = false) {
  buffer.scanned_rows += batch.scanned_rows;
  if (buffer.scorer.empty()) {
    buffer.scorer = copyBytes(batch.scorer);
  }
  buffer.rows.reserve(buffer.rows.size() + batch.row_count);
  for (size_t i = 0; i < batch.row_count; ++i) {
    const xpod_rdf_candidate& in = batch.rows[i];
    CandidateRow out;
    out.source_node = in.source_node;
    out.has_source_node = in.has_source_node != 0;
    out.retrieval_point = in.retrieval_point;
    out.has_retrieval_point = in.has_retrieval_point != 0;
    out.source_key = copyBytes(in.source_key);
    out.has_source_key = in.has_source_key != 0;
    out.retrieval_point_key = copyBytes(in.retrieval_point_key);
    out.has_retrieval_point_key = in.has_retrieval_point_key != 0;
    out.resource_term = in.resource_term;
    out.has_resource_term = in.has_resource_term != 0;
    if (supports_matched_term && batch.matched_terms != nullptr &&
        batch.has_matched_terms != nullptr) {
      out.matched_term = batch.matched_terms[i];
      out.has_matched_term = batch.has_matched_terms[i] != 0;
    }
    out.score = in.score;
    out.range = in.range;
    out.scorer = copyBytes(in.scorer);
    buffer.rows.push_back(std::move(out));
  }
}

inline xpod_rdf_status appendCandidatesCallback(
    void* callback_user_data,
    const xpod_rdf_candidate_batch* batch) {
  if (callback_user_data == nullptr || batch == nullptr) {
    return XPOD_RDF_STATUS_BACKEND_ERROR;
  }
  appendCandidateBatch(
      *static_cast<CandidateBuffer*>(callback_user_data), *batch);
  return XPOD_RDF_STATUS_OK;
}

inline xpod_rdf_status executeTextSearchToCandidates(
    const PhysicalBackend& backend,
    const xpod_rdf_text_search_request& request,
    CandidateBuffer& out) noexcept {
  xpod_rdf_backend_capabilities capabilities = {};
  xpod_rdf_status capability_status = backend.getCapabilities(capabilities);
  if (capability_status != XPOD_RDF_STATUS_OK) {
    return capability_status;
  }
  struct CallbackState {
    CandidateBuffer* buffer;
    bool supports_matched_term;
  } state{
      &out,
      (capabilities.features &
       XPOD_RDF_BACKEND_FEATURE_TEXT_MATCHED_TERM) != 0};
  auto callback = [](
      void* callback_user_data,
      const xpod_rdf_candidate_batch* batch) -> xpod_rdf_status {
    if (callback_user_data == nullptr || batch == nullptr) {
      return XPOD_RDF_STATUS_BACKEND_ERROR;
    }
    auto* state = static_cast<CallbackState*>(callback_user_data);
    appendCandidateBatch(
        *state->buffer, *batch, state->supports_matched_term);
    return XPOD_RDF_STATUS_OK;
  };
  return backend.textSearch(request, callback, &state);
}

inline xpod_rdf_status executeVectorSearchToCandidates(
    const PhysicalBackend& backend,
    const xpod_rdf_vector_search_request& request,
    CandidateBuffer& out) noexcept {
  return backend.vectorSearch(request, appendCandidatesCallback, &out);
}

}  // namespace xpod::rdf

#endif
