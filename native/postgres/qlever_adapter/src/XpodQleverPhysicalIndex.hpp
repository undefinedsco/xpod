#ifndef XPOD_QLEVER_PHYSICAL_INDEX_HPP
#define XPOD_QLEVER_PHYSICAL_INDEX_HPP

#include "XpodBackedIndexScan.hpp"
#include "XpodQleverPlannerScanInput.hpp"

#include <cstdint>
#include <string>
#include <string_view>
#include <vector>

#if XPOD_QLEVER_ADAPTER_ENABLE_QLEVER

namespace xpod::qlever {

struct XpodQleverPrefixRangeResult {
  xpod_rdf_status status;
  std::vector<xpod_rdf_term_range> ranges;
  xpod_rdf_term_collation collation = XPOD_RDF_TERM_COLLATION_UNKNOWN;
};

struct XpodQleverLookupTermsResult {
  xpod_rdf_status status;
  std::vector<xpod_rdf_term_key> keys;
  std::vector<xpod_rdf_status> statuses;
};

struct XpodQleverResolveTermsResult {
  xpod_rdf_status status;
  std::vector<xpod_rdf_term> terms;
  std::vector<xpod_rdf_status> statuses;
};

struct XpodQleverCountResult {
  xpod_rdf_status status;
  xpod_rdf_count_result result;
};

struct XpodQleverDistinctTermsResult {
  xpod_rdf_status status;
  std::vector<xpod_rdf_term_key> terms;
  size_t row_count = 0;
  uint32_t tuple_width = 0;
};

struct XpodQleverDistinctEstimateResult {
  xpod_rdf_status status;
  xpod_rdf_estimate estimate;
};

inline xpod_rdf_status collectPrefixRangeBatch(
    void* callback_user_data,
    const xpod_rdf_term_range_batch* batch) {
  if (callback_user_data == nullptr || batch == nullptr) {
    return XPOD_RDF_STATUS_BACKEND_ERROR;
  }
  auto* ranges =
      static_cast<std::vector<xpod_rdf_term_range>*>(callback_user_data);
  ranges->insert(ranges->end(), batch->ranges, batch->ranges + batch->range_count);
  return XPOD_RDF_STATUS_OK;
}

inline xpod_rdf_status collectDistinctTermsBatch(
    void* callback_user_data,
    const xpod_rdf_term_tuple_batch* batch) {
  if (callback_user_data == nullptr || batch == nullptr) {
    return XPOD_RDF_STATUS_BACKEND_ERROR;
  }
  auto* result =
      static_cast<XpodQleverDistinctTermsResult*>(callback_user_data);
  if (result->tuple_width == 0) {
    result->tuple_width = batch->tuple_width;
  } else if (result->tuple_width != batch->tuple_width) {
    return XPOD_RDF_STATUS_BACKEND_ERROR;
  }
  result->row_count += batch->row_count;
  result->terms.insert(
      result->terms.end(),
      batch->terms,
      batch->terms + batch->row_count * batch->tuple_width);
  return XPOD_RDF_STATUS_OK;
}

inline std::string_view qleverPermutationName(
    Permutation::Enum permutation) noexcept {
  switch (permutation) {
    case Permutation::Enum::PSO:
      return "PSO";
    case Permutation::Enum::POS:
      return "POS";
    case Permutation::Enum::SPO:
      return "SPO";
    case Permutation::Enum::SOP:
      return "SOP";
    case Permutation::Enum::OPS:
      return "OPS";
    case Permutation::Enum::OSP:
      return "OSP";
  }
  return "SPO";
}

inline std::string physicalPermutationDescriptor(
    Permutation::Enum permutation) {
  std::string descriptor = "XpodQleverPhysicalPermutation ";
  descriptor += qleverPermutationName(permutation);
  return descriptor;
}

class XpodQleverPhysicalPermutation {
 public:
  XpodQleverPhysicalPermutation(
      PlannerRequestContext context,
      Permutation::Enum permutation) noexcept
      : context_(context), permutation_(permutation) {}

  Permutation::Enum permutation() const noexcept { return permutation_; }

  XpodBackedScanEstimate estimate(
      TripleKeyPattern pattern = {},
      uint32_t needed_slots = XPOD_RDF_SLOT_SUBJECT |
                              XPOD_RDF_SLOT_PREDICATE |
                              XPOD_RDF_SLOT_OBJECT) const {
    return makeBackedScan(pattern, needed_slots).estimate();
  }

  QleverIdTableResult scan(
      TripleKeyPattern pattern = {},
      uint32_t needed_slots = XPOD_RDF_SLOT_SUBJECT |
                              XPOD_RDF_SLOT_PREDICATE |
                              XPOD_RDF_SLOT_OBJECT) const {
    return makeBackedScan(pattern, needed_slots).execute();
  }

  XpodQleverCountResult count(
      TripleKeyPattern pattern = {},
      uint32_t needed_slots = XPOD_RDF_SLOT_SUBJECT |
                              XPOD_RDF_SLOT_PREDICATE |
                              XPOD_RDF_SLOT_OBJECT) const {
    XpodQleverCountResult result = {};
    const ScanRequestInput input = makeScanInput(pattern, needed_slots);
    const xpod_rdf_scan_request request = makeScanRequest(input);
    result.status = context_.backend.countScan(request, result.result);
    return result;
  }

  XpodQleverDistinctTermsResult distinct(
      TripleKeyPattern pattern,
      uint32_t distinct_slots,
      uint32_t needed_slots = XPOD_RDF_SLOT_SUBJECT |
                              XPOD_RDF_SLOT_PREDICATE |
                              XPOD_RDF_SLOT_OBJECT) const {
    XpodQleverDistinctTermsResult result = {};
    const xpod_rdf_distinct_request request =
        makeDistinctRequest(pattern, distinct_slots, needed_slots);
    result.status = context_.backend.distinctScan(
        request, collectDistinctTermsBatch, &result);
    return result;
  }

  XpodQleverDistinctEstimateResult estimateDistinct(
      TripleKeyPattern pattern,
      uint32_t distinct_slots,
      uint32_t needed_slots = XPOD_RDF_SLOT_SUBJECT |
                              XPOD_RDF_SLOT_PREDICATE |
                              XPOD_RDF_SLOT_OBJECT) const {
    XpodQleverDistinctEstimateResult result = {};
    const xpod_rdf_distinct_request request =
        makeDistinctRequest(pattern, distinct_slots, needed_slots);
    result.status =
        context_.backend.estimateDistinct(request, result.estimate);
    return result;
  }

 private:
  ScanRequestInput makeScanInput(
      TripleKeyPattern pattern,
      uint32_t needed_slots) const {
    ScanRequestInput input =
        makeScanRequestInput(context_, permutation_, pattern);
    input.needed_slots = needed_slots;
    return input;
  }

  xpod_rdf_distinct_request makeDistinctRequest(
      TripleKeyPattern pattern,
      uint32_t distinct_slots,
      uint32_t needed_slots) const {
    const ScanRequestInput input = makeScanInput(pattern, needed_slots);
    xpod_rdf_distinct_request request = {};
    request.scan = makeScanRequest(input);
    request.distinct_slots = distinct_slots;
    return request;
  }

  XpodBackedIndexScan makeBackedScan(
      TripleKeyPattern pattern,
      uint32_t needed_slots) const {
    ScanRequestInput input = makeScanInput(pattern, needed_slots);
    return XpodBackedIndexScan(
        context_.backend,
        input,
        {},
        countNeededSlots(needed_slots),
        physicalPermutationDescriptor(permutation_));
  }

  PlannerRequestContext context_;
  Permutation::Enum permutation_;
};

class XpodQleverPhysicalIndex {
 public:
  explicit XpodQleverPhysicalIndex(
      PlannerRequestContext context) noexcept
      : context_(context) {}

  XpodQleverPhysicalPermutation permutation(
      Permutation::Enum permutation) const noexcept {
    return {context_, permutation};
  }

  XpodBackedScanEstimate estimate(
      Permutation::Enum permutation,
      TripleKeyPattern pattern = {},
      uint32_t needed_slots = XPOD_RDF_SLOT_SUBJECT |
                              XPOD_RDF_SLOT_PREDICATE |
                              XPOD_RDF_SLOT_OBJECT) const {
    return this->permutation(permutation).estimate(pattern, needed_slots);
  }

  QleverIdTableResult scan(
      Permutation::Enum permutation,
      TripleKeyPattern pattern = {},
      uint32_t needed_slots = XPOD_RDF_SLOT_SUBJECT |
                              XPOD_RDF_SLOT_PREDICATE |
                              XPOD_RDF_SLOT_OBJECT) const {
    return this->permutation(permutation).scan(pattern, needed_slots);
  }

  xpod_rdf_status lookupTerm(
      const xpod_rdf_term& term,
      xpod_rdf_term_key& out_key) const noexcept {
    return context_.backend.lookupTerm(term, snapshot(), out_key);
  }

  xpod_rdf_status resolveTerm(
      xpod_rdf_term_key key,
      xpod_rdf_term& out_term) const noexcept {
    return context_.backend.resolveTerm(key, snapshot(), out_term);
  }

  xpod_rdf_status encodeQleverId(
      xpod_rdf_term_key term,
      uint64_t& out_qlever_id_bits) const noexcept {
    return context_.backend.encodeQleverId(term, out_qlever_id_bits);
  }

  xpod_rdf_status decodeQleverId(
      uint64_t qlever_id_bits,
      xpod_rdf_term_key& out_term) const noexcept {
    return context_.backend.decodeQleverId(qlever_id_bits, out_term);
  }

  xpod_rdf_status compareQleverIds(
      uint64_t left_qlever_id_bits,
      uint64_t right_qlever_id_bits,
      int32_t& out_compare) const noexcept {
    return context_.backend.compareQleverIds(
        left_qlever_id_bits, right_qlever_id_bits, out_compare);
  }

  XpodQleverLookupTermsResult lookupTerms(
      const xpod_rdf_term* terms,
      size_t term_count) const {
    XpodQleverLookupTermsResult result = {};
    result.keys.resize(term_count);
    result.statuses.resize(term_count);
    if (term_count == 0) {
      result.status = XPOD_RDF_STATUS_OK;
      return result;
    }
    result.status = context_.backend.lookupTerms(
        terms, term_count, snapshot(), result.keys.data(),
        result.statuses.data());
    return result;
  }

  XpodQleverResolveTermsResult resolveTerms(
      const xpod_rdf_term_key* keys,
      size_t key_count) const {
    XpodQleverResolveTermsResult result = {};
    result.terms.resize(key_count);
    result.statuses.resize(key_count);
    if (key_count == 0) {
      result.status = XPOD_RDF_STATUS_OK;
      return result;
    }
    result.status = context_.backend.resolveTerms(
        keys, key_count, snapshot(), result.terms.data(),
        result.statuses.data());
    return result;
  }

  XpodQleverPrefixRangeResult prefixRanges(
      xpod_rdf_bytes prefix,
      xpod_rdf_term_kind kind,
      bool has_kind = true) const {
    xpod_rdf_prefix_range_request request = {};
    request.snapshot = snapshot();
    request.cancellation = context_.cancellation;
    request.prefix = prefix;
    request.kind = kind;
    request.has_kind = has_kind ? 1 : 0;

    XpodQleverPrefixRangeResult result = {};
    result.status = context_.backend.prefixRange(
        request, collectPrefixRangeBatch, &result.ranges, result.collation);
    return result;
  }

  const PlannerRequestContext& context() const noexcept { return context_; }

 private:
  xpod_rdf_snapshot snapshot() const noexcept {
    return context_.request == nullptr
               ? xpod_rdf_snapshot{}
               : context_.request->snapshot;
  }

  PlannerRequestContext context_;
};

}  // namespace xpod::qlever

#endif

#endif
