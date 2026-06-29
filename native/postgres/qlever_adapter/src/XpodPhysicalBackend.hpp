#ifndef XPOD_PHYSICAL_BACKEND_HPP
#define XPOD_PHYSICAL_BACKEND_HPP

#include "xpod_rdf_physical_backend.h"

#include <cstddef>

namespace xpod::rdf {

class PhysicalBackend {
 public:
  explicit PhysicalBackend(xpod_rdf_backend_v1* backend) noexcept
      : backend_(backend) {}

  bool valid() const noexcept {
    return backend_ != nullptr &&
           backend_->abi_version == XPOD_RDF_PHYSICAL_BACKEND_ABI_VERSION;
  }

  xpod_rdf_backend_v1* raw() const noexcept { return backend_; }

  bool hasField(size_t offset, size_t size) const noexcept {
    return valid() && backend_->struct_size >= offset + size;
  }

  xpod_rdf_status encodeQleverId(
      xpod_rdf_term_key term,
      uint64_t& out_qlever_id_bits) const noexcept {
    if (!valid()) {
      return XPOD_RDF_STATUS_UNSUPPORTED;
    }
    if (hasField(offsetof(xpod_rdf_backend_v1, encode_qlever_id),
                 sizeof(backend_->encode_qlever_id)) &&
        backend_->encode_qlever_id != nullptr) {
      return backend_->encode_qlever_id(
          backend_->backend_user_data, term, &out_qlever_id_bits);
    }
    if (hasField(offsetof(xpod_rdf_backend_v1, term_key_encoding),
                 sizeof(backend_->term_key_encoding)) &&
        backend_->term_key_encoding ==
            XPOD_RDF_TERM_KEY_ENCODING_QLEVER_VALUE_ID_BITS) {
      out_qlever_id_bits = term;
      return XPOD_RDF_STATUS_OK;
    }
    return XPOD_RDF_STATUS_UNSUPPORTED;
  }

  xpod_rdf_status decodeQleverId(
      uint64_t qlever_id_bits,
      xpod_rdf_term_key& out_term) const noexcept {
    if (!valid()) {
      return XPOD_RDF_STATUS_UNSUPPORTED;
    }
    if (hasField(offsetof(xpod_rdf_backend_v1, decode_qlever_id),
                 sizeof(backend_->decode_qlever_id)) &&
        backend_->decode_qlever_id != nullptr) {
      return backend_->decode_qlever_id(
          backend_->backend_user_data, qlever_id_bits, &out_term);
    }
    if (hasField(offsetof(xpod_rdf_backend_v1, term_key_encoding),
                 sizeof(backend_->term_key_encoding)) &&
        backend_->term_key_encoding ==
            XPOD_RDF_TERM_KEY_ENCODING_QLEVER_VALUE_ID_BITS) {
      out_term = qlever_id_bits;
      return XPOD_RDF_STATUS_OK;
    }
    return XPOD_RDF_STATUS_UNSUPPORTED;
  }

  xpod_rdf_status lookupTerm(
      const xpod_rdf_term& term,
      const xpod_rdf_snapshot& snapshot,
      xpod_rdf_term_key& out_key) const noexcept {
    if (!valid() || backend_->lookup_term == nullptr) {
      return XPOD_RDF_STATUS_UNSUPPORTED;
    }
    return backend_->lookup_term(
        backend_->backend_user_data, &term, &snapshot, &out_key);
  }

  xpod_rdf_status resolveTerm(
      xpod_rdf_term_key key,
      const xpod_rdf_snapshot& snapshot,
      xpod_rdf_term& out_term) const noexcept {
    if (!valid() || backend_->resolve_term == nullptr) {
      return XPOD_RDF_STATUS_UNSUPPORTED;
    }
    return backend_->resolve_term(
        backend_->backend_user_data, key, &snapshot, &out_term);
  }

  xpod_rdf_status lookupTerms(
      const xpod_rdf_term* terms,
      size_t term_count,
      const xpod_rdf_snapshot& snapshot,
      xpod_rdf_term_key* out_keys,
      xpod_rdf_status* out_statuses) const noexcept {
    if (!valid() ||
        !hasField(offsetof(xpod_rdf_backend_v1, lookup_terms),
                  sizeof(backend_->lookup_terms)) ||
        backend_->lookup_terms == nullptr) {
      return XPOD_RDF_STATUS_UNSUPPORTED;
    }
    return backend_->lookup_terms(
        backend_->backend_user_data, terms, term_count, &snapshot, out_keys,
        out_statuses);
  }

  xpod_rdf_status resolveTerms(
      const xpod_rdf_term_key* keys,
      size_t key_count,
      const xpod_rdf_snapshot& snapshot,
      xpod_rdf_term* out_terms,
      xpod_rdf_status* out_statuses) const noexcept {
    if (!valid() ||
        !hasField(offsetof(xpod_rdf_backend_v1, resolve_terms),
                  sizeof(backend_->resolve_terms)) ||
        backend_->resolve_terms == nullptr) {
      return XPOD_RDF_STATUS_UNSUPPORTED;
    }
    return backend_->resolve_terms(
        backend_->backend_user_data, keys, key_count, &snapshot, out_terms,
        out_statuses);
  }

  xpod_rdf_status scanPermutation(
      const xpod_rdf_scan_request& request,
      xpod_rdf_quad_batch_callback on_batch,
      void* callback_user_data) const noexcept {
    if (!valid() || backend_->scan_permutation == nullptr) {
      return XPOD_RDF_STATUS_UNSUPPORTED;
    }
    return backend_->scan_permutation(
        backend_->backend_user_data, &request, on_batch, callback_user_data);
  }

  xpod_rdf_status countScan(
      const xpod_rdf_scan_request& request,
      xpod_rdf_count_result& out_result) const noexcept {
    if (!valid() || backend_->count_scan == nullptr) {
      return XPOD_RDF_STATUS_UNSUPPORTED;
    }
    return backend_->count_scan(
        backend_->backend_user_data, &request, &out_result);
  }

  xpod_rdf_status distinctScan(
      const xpod_rdf_distinct_request& request,
      xpod_rdf_term_tuple_batch_callback on_batch,
      void* callback_user_data) const noexcept {
    if (!valid() || backend_->distinct_scan == nullptr) {
      return XPOD_RDF_STATUS_UNSUPPORTED;
    }
    return backend_->distinct_scan(
        backend_->backend_user_data, &request, on_batch, callback_user_data);
  }

  xpod_rdf_status estimateScan(
      const xpod_rdf_scan_request& request,
      xpod_rdf_estimate& out_estimate) const noexcept {
    if (!valid() || backend_->estimate_scan == nullptr) {
      return XPOD_RDF_STATUS_UNSUPPORTED;
    }
    return backend_->estimate_scan(
        backend_->backend_user_data, &request, &out_estimate);
  }

  xpod_rdf_status estimateJoinFanout(
      const xpod_rdf_join_fanout_request& request,
      xpod_rdf_estimate& out_estimate) const noexcept {
    if (!valid() || backend_->estimate_join_fanout == nullptr) {
      return XPOD_RDF_STATUS_UNSUPPORTED;
    }
    return backend_->estimate_join_fanout(
        backend_->backend_user_data, &request, &out_estimate);
  }

  xpod_rdf_status textSearch(
      const xpod_rdf_text_search_request& request,
      xpod_rdf_candidate_batch_callback on_batch,
      void* callback_user_data) const noexcept {
    if (!valid() || backend_->text_search == nullptr) {
      return XPOD_RDF_STATUS_UNSUPPORTED;
    }
    return backend_->text_search(
        backend_->backend_user_data, &request, on_batch, callback_user_data);
  }

  xpod_rdf_status estimateTextSearch(
      const xpod_rdf_text_search_request& request,
      xpod_rdf_estimate& out_estimate) const noexcept {
    if (!valid() || backend_->estimate_text_search == nullptr) {
      return XPOD_RDF_STATUS_UNSUPPORTED;
    }
    return backend_->estimate_text_search(
        backend_->backend_user_data, &request, &out_estimate);
  }

  xpod_rdf_status vectorSearch(
      const xpod_rdf_vector_search_request& request,
      xpod_rdf_candidate_batch_callback on_batch,
      void* callback_user_data) const noexcept {
    if (!valid() || backend_->vector_search == nullptr) {
      return XPOD_RDF_STATUS_UNSUPPORTED;
    }
    return backend_->vector_search(
        backend_->backend_user_data, &request, on_batch, callback_user_data);
  }

  xpod_rdf_status estimateVectorSearch(
      const xpod_rdf_vector_search_request& request,
      xpod_rdf_estimate& out_estimate) const noexcept {
    if (!valid() || backend_->estimate_vector_search == nullptr) {
      return XPOD_RDF_STATUS_UNSUPPORTED;
    }
    return backend_->estimate_vector_search(
        backend_->backend_user_data, &request, &out_estimate);
  }

  xpod_rdf_status resolveAccessScope(
      const xpod_rdf_bytes& principal,
      xpod_rdf_access_mode mode,
      const xpod_rdf_snapshot& snapshot,
      xpod_rdf_access_scope& out_scope) const noexcept {
    if (!valid() || backend_->resolve_access_scope == nullptr) {
      return XPOD_RDF_STATUS_UNSUPPORTED;
    }
    return backend_->resolve_access_scope(
        backend_->backend_user_data, &principal, mode, &snapshot, &out_scope);
  }

  xpod_rdf_status estimateAccessScope(
      const xpod_rdf_access_scope& access_scope,
      const xpod_rdf_source_scope& source_scope,
      xpod_rdf_estimate& out_estimate) const noexcept {
    if (!valid() || backend_->estimate_access_scope == nullptr) {
      return XPOD_RDF_STATUS_UNSUPPORTED;
    }
    return backend_->estimate_access_scope(
        backend_->backend_user_data, &access_scope, &source_scope,
        &out_estimate);
  }

  void emitProfileEvent(const xpod_rdf_profile_event& event) const noexcept {
    if (valid() && backend_->on_profile_event != nullptr) {
      backend_->on_profile_event(backend_->profile_user_data, &event);
    }
  }

 private:
  xpod_rdf_backend_v1* backend_;
};

}  // namespace xpod::rdf

#endif
