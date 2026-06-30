#ifndef XPOD_PHYSICAL_BACKEND_HPP
#define XPOD_PHYSICAL_BACKEND_HPP

#include "xpod_rdf_physical_backend.h"

#include <cstddef>
#include <cstdint>

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

  bool preservesQleverTermOrder() const noexcept {
    if (!valid()) {
      return false;
    }
    if (hasField(offsetof(xpod_rdf_backend_v1, qlever_term_ordering),
                 sizeof(backend_->qlever_term_ordering)) &&
        backend_->qlever_term_ordering ==
            XPOD_RDF_QLEVER_TERM_ORDER_PRESERVED) {
      return true;
    }
    return hasField(offsetof(xpod_rdf_backend_v1, term_key_encoding),
                    sizeof(backend_->term_key_encoding)) &&
           backend_->term_key_encoding ==
               XPOD_RDF_TERM_KEY_ENCODING_QLEVER_VALUE_ID_BITS;
  }

  bool hasField(size_t offset, size_t size) const noexcept {
    return valid() && backend_->struct_size >= offset + size;
  }

  template <typename Callback>
  bool hasCallback(size_t offset, Callback callback) const noexcept {
    return hasField(offset, sizeof(callback)) && callback != nullptr;
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

  xpod_rdf_status compareQleverIds(
      uint64_t left_qlever_id_bits,
      uint64_t right_qlever_id_bits,
      int32_t& out_compare) const noexcept {
    if (valid() &&
        hasField(offsetof(xpod_rdf_backend_v1, compare_qlever_ids),
                 sizeof(backend_->compare_qlever_ids)) &&
        backend_->compare_qlever_ids != nullptr) {
      return backend_->compare_qlever_ids(
          backend_->backend_user_data, left_qlever_id_bits,
          right_qlever_id_bits, &out_compare);
    }
    out_compare = left_qlever_id_bits < right_qlever_id_bits
                      ? -1
                      : (left_qlever_id_bits > right_qlever_id_bits ? 1 : 0);
    return XPOD_RDF_STATUS_OK;
  }

  xpod_rdf_status getCapabilities(
      xpod_rdf_backend_capabilities& out_capabilities) const noexcept {
    if (!valid() ||
        !hasCallback(offsetof(xpod_rdf_backend_v1, get_capabilities),
                     backend_->get_capabilities)) {
      return XPOD_RDF_STATUS_UNSUPPORTED;
    }
    return backend_->get_capabilities(
        backend_->backend_user_data, &out_capabilities);
  }

  xpod_rdf_status lookupTerm(
      const xpod_rdf_term& term,
      const xpod_rdf_snapshot& snapshot,
      xpod_rdf_term_key& out_key) const noexcept {
    if (!valid() ||
        !hasCallback(offsetof(xpod_rdf_backend_v1, lookup_term),
                     backend_->lookup_term)) {
      return XPOD_RDF_STATUS_UNSUPPORTED;
    }
    return backend_->lookup_term(
        backend_->backend_user_data, &term, &snapshot, &out_key);
  }

  xpod_rdf_status resolveTerm(
      xpod_rdf_term_key key,
      const xpod_rdf_snapshot& snapshot,
      xpod_rdf_term& out_term) const noexcept {
    if (!valid() ||
        !hasCallback(offsetof(xpod_rdf_backend_v1, resolve_term),
                     backend_->resolve_term)) {
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

  xpod_rdf_status prefixRange(
      const xpod_rdf_prefix_range_request& request,
      xpod_rdf_term_range_batch_callback on_batch,
      void* callback_user_data,
      xpod_rdf_term_collation& out_collation) const noexcept {
    if (!valid() ||
        !hasField(offsetof(xpod_rdf_backend_v1, prefix_range),
                  sizeof(backend_->prefix_range)) ||
        backend_->prefix_range == nullptr) {
      return XPOD_RDF_STATUS_UNSUPPORTED;
    }
    out_collation = XPOD_RDF_TERM_COLLATION_UNKNOWN;

    struct CallbackState {
      xpod_rdf_term_range_batch_callback downstream;
      void* downstream_user_data;
      xpod_rdf_term_collation* collation;
    };

    CallbackState state{on_batch, callback_user_data, &out_collation};
    auto forwarding_callback = [](
        void* user_data,
        const xpod_rdf_term_range_batch* batch) -> xpod_rdf_status {
      CallbackState* state = static_cast<CallbackState*>(user_data);
      if (batch != nullptr && state->collation != nullptr) {
        *state->collation = batch->collation;
      }
      if (state->downstream == nullptr) {
        return XPOD_RDF_STATUS_OK;
      }
      return state->downstream(state->downstream_user_data, batch);
    };

    return backend_->prefix_range(
        backend_->backend_user_data, &request, forwarding_callback, &state);
  }

  xpod_rdf_status scanPermutation(
      const xpod_rdf_scan_request& request,
      xpod_rdf_quad_batch_callback on_batch,
      void* callback_user_data) const noexcept {
    if (!valid() ||
        !hasCallback(offsetof(xpod_rdf_backend_v1, scan_permutation),
                     backend_->scan_permutation)) {
      return XPOD_RDF_STATUS_UNSUPPORTED;
    }
    return backend_->scan_permutation(
        backend_->backend_user_data, &request, on_batch, callback_user_data);
  }

  xpod_rdf_status scanBlockMetadata(
      const xpod_rdf_scan_request& request,
      xpod_rdf_scan_block_metadata_batch_callback on_batch,
      void* callback_user_data,
      xpod_rdf_bytes& out_metadata_version) const noexcept {
    if (!valid() ||
        !hasCallback(offsetof(xpod_rdf_backend_v1, scan_block_metadata),
                     backend_->scan_block_metadata)) {
      return XPOD_RDF_STATUS_UNSUPPORTED;
    }
    out_metadata_version = {nullptr, 0};

    struct CallbackState {
      xpod_rdf_scan_block_metadata_batch_callback downstream;
      void* downstream_user_data;
      xpod_rdf_bytes* metadata_version;
    };

    CallbackState state{on_batch, callback_user_data, &out_metadata_version};
    auto forwarding_callback = [](
        void* user_data,
        const xpod_rdf_scan_block_metadata_batch* batch) -> xpod_rdf_status {
      CallbackState* state = static_cast<CallbackState*>(user_data);
      if (batch != nullptr && state->metadata_version != nullptr) {
        *state->metadata_version = batch->metadata_version;
      }
      if (state->downstream == nullptr) {
        return XPOD_RDF_STATUS_OK;
      }
      return state->downstream(state->downstream_user_data, batch);
    };

    return backend_->scan_block_metadata(
        backend_->backend_user_data, &request, forwarding_callback, &state);
  }

  xpod_rdf_status countScan(
      const xpod_rdf_scan_request& request,
      xpod_rdf_count_result& out_result) const noexcept {
    if (!valid() ||
        !hasCallback(offsetof(xpod_rdf_backend_v1, count_scan),
                     backend_->count_scan)) {
      return XPOD_RDF_STATUS_UNSUPPORTED;
    }
    return backend_->count_scan(
        backend_->backend_user_data, &request, &out_result);
  }

  xpod_rdf_status distinctScan(
      const xpod_rdf_distinct_request& request,
      xpod_rdf_term_tuple_batch_callback on_batch,
      void* callback_user_data) const noexcept {
    if (!valid() ||
        !hasCallback(offsetof(xpod_rdf_backend_v1, distinct_scan),
                     backend_->distinct_scan)) {
      return XPOD_RDF_STATUS_UNSUPPORTED;
    }
    return backend_->distinct_scan(
        backend_->backend_user_data, &request, on_batch, callback_user_data);
  }

  xpod_rdf_status estimateDistinct(
      const xpod_rdf_distinct_request& request,
      xpod_rdf_estimate& out_estimate) const noexcept {
    if (!valid() ||
        !hasCallback(offsetof(xpod_rdf_backend_v1, estimate_distinct),
                     backend_->estimate_distinct)) {
      return XPOD_RDF_STATUS_UNSUPPORTED;
    }
    return backend_->estimate_distinct(
        backend_->backend_user_data, &request, &out_estimate);
  }

  xpod_rdf_status estimateScan(
      const xpod_rdf_scan_request& request,
      xpod_rdf_estimate& out_estimate) const noexcept {
    if (!valid() ||
        !hasCallback(offsetof(xpod_rdf_backend_v1, estimate_scan),
                     backend_->estimate_scan)) {
      return XPOD_RDF_STATUS_UNSUPPORTED;
    }
    return backend_->estimate_scan(
        backend_->backend_user_data, &request, &out_estimate);
  }

  xpod_rdf_status estimateJoinFanout(
      const xpod_rdf_join_fanout_request& request,
      xpod_rdf_estimate& out_estimate) const noexcept {
    if (!valid() ||
        !hasCallback(offsetof(xpod_rdf_backend_v1, estimate_join_fanout),
                     backend_->estimate_join_fanout)) {
      return XPOD_RDF_STATUS_UNSUPPORTED;
    }
    return backend_->estimate_join_fanout(
        backend_->backend_user_data, &request, &out_estimate);
  }

  xpod_rdf_status histogramHints(
      const xpod_rdf_histogram_request& request,
      xpod_rdf_histogram_hint_batch_callback on_batch,
      void* callback_user_data,
      xpod_rdf_bytes& out_stats_version) const noexcept {
    if (!valid() ||
        !hasCallback(offsetof(xpod_rdf_backend_v1, histogram_hints),
                     backend_->histogram_hints)) {
      return XPOD_RDF_STATUS_UNSUPPORTED;
    }
    out_stats_version = {nullptr, 0};

    struct CallbackState {
      xpod_rdf_histogram_hint_batch_callback downstream;
      void* downstream_user_data;
      xpod_rdf_bytes* stats_version;
    };

    CallbackState state{on_batch, callback_user_data, &out_stats_version};
    auto forwarding_callback = [](
        void* user_data,
        const xpod_rdf_histogram_hint_batch* batch) -> xpod_rdf_status {
      CallbackState* state = static_cast<CallbackState*>(user_data);
      if (batch != nullptr && state->stats_version != nullptr) {
        *state->stats_version = batch->stats_version;
      }
      if (state->downstream == nullptr) {
        return XPOD_RDF_STATUS_OK;
      }
      return state->downstream(state->downstream_user_data, batch);
    };

    return backend_->histogram_hints(
        backend_->backend_user_data, &request, forwarding_callback, &state);
  }

  xpod_rdf_status textSearch(
      const xpod_rdf_text_search_request& request,
      xpod_rdf_candidate_batch_callback on_batch,
      void* callback_user_data) const noexcept {
    if (!valid() ||
        !hasCallback(offsetof(xpod_rdf_backend_v1, text_search),
                     backend_->text_search)) {
      return XPOD_RDF_STATUS_UNSUPPORTED;
    }
    return backend_->text_search(
        backend_->backend_user_data, &request, on_batch, callback_user_data);
  }

  xpod_rdf_status estimateTextSearch(
      const xpod_rdf_text_search_request& request,
      xpod_rdf_estimate& out_estimate) const noexcept {
    if (!valid() ||
        !hasCallback(offsetof(xpod_rdf_backend_v1, estimate_text_search),
                     backend_->estimate_text_search)) {
      return XPOD_RDF_STATUS_UNSUPPORTED;
    }
    return backend_->estimate_text_search(
        backend_->backend_user_data, &request, &out_estimate);
  }

  xpod_rdf_status vectorSearch(
      const xpod_rdf_vector_search_request& request,
      xpod_rdf_candidate_batch_callback on_batch,
      void* callback_user_data) const noexcept {
    if (!valid() ||
        !hasCallback(offsetof(xpod_rdf_backend_v1, vector_search),
                     backend_->vector_search)) {
      return XPOD_RDF_STATUS_UNSUPPORTED;
    }
    return backend_->vector_search(
        backend_->backend_user_data, &request, on_batch, callback_user_data);
  }

  xpod_rdf_status estimateVectorSearch(
      const xpod_rdf_vector_search_request& request,
      xpod_rdf_estimate& out_estimate) const noexcept {
    if (!valid() ||
        !hasCallback(offsetof(xpod_rdf_backend_v1, estimate_vector_search),
                     backend_->estimate_vector_search)) {
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
    if (!valid() ||
        !hasCallback(offsetof(xpod_rdf_backend_v1, resolve_access_scope),
                     backend_->resolve_access_scope)) {
      return XPOD_RDF_STATUS_UNSUPPORTED;
    }
    return backend_->resolve_access_scope(
        backend_->backend_user_data, &principal, mode, &snapshot, &out_scope);
  }

  xpod_rdf_status estimateAccessScope(
      const xpod_rdf_access_scope& access_scope,
      const xpod_rdf_source_scope& source_scope,
      xpod_rdf_estimate& out_estimate) const noexcept {
    if (!valid() ||
        !hasCallback(offsetof(xpod_rdf_backend_v1, estimate_access_scope),
                     backend_->estimate_access_scope)) {
      return XPOD_RDF_STATUS_UNSUPPORTED;
    }
    return backend_->estimate_access_scope(
        backend_->backend_user_data, &access_scope, &source_scope,
        &out_estimate);
  }

  xpod_rdf_status estimateSourceScope(
      const xpod_rdf_source_scope& source_scope,
      const xpod_rdf_snapshot& snapshot,
      xpod_rdf_estimate& out_estimate) const noexcept {
    if (!valid() ||
        !hasField(offsetof(xpod_rdf_backend_v1, estimate_source_scope),
                  sizeof(backend_->estimate_source_scope)) ||
        backend_->estimate_source_scope == nullptr) {
      return XPOD_RDF_STATUS_UNSUPPORTED;
    }
    return backend_->estimate_source_scope(
        backend_->backend_user_data, &source_scope, &snapshot, &out_estimate);
  }

  xpod_rdf_status resolveSourceScope(
      const xpod_rdf_source_scope& source_scope,
      const xpod_rdf_snapshot& snapshot,
      xpod_rdf_resolved_source_scope& out_scope) const noexcept {
    if (!valid() ||
        !hasCallback(offsetof(xpod_rdf_backend_v1, resolve_source_scope),
                     backend_->resolve_source_scope)) {
      return XPOD_RDF_STATUS_UNSUPPORTED;
    }
    return backend_->resolve_source_scope(
        backend_->backend_user_data, &source_scope, &snapshot, &out_scope);
  }

  void emitProfileEvent(const xpod_rdf_profile_event& event) const noexcept {
    if (valid() &&
        hasCallback(offsetof(xpod_rdf_backend_v1, on_profile_event),
                    backend_->on_profile_event)) {
      backend_->on_profile_event(backend_->profile_user_data, &event);
    }
  }

 private:
  xpod_rdf_backend_v1* backend_;
};

}  // namespace xpod::rdf

#endif
