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

 private:
  XpodBackedIndexScan makeBackedScan(
      TripleKeyPattern pattern,
      uint32_t needed_slots) const {
    ScanRequestInput input =
        makeScanRequestInput(context_, permutation_, pattern);
    input.needed_slots = needed_slots;
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
