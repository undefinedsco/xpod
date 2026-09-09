#ifndef XPOD_QLEVER_PHYSICAL_HAS_PREDICATE_CONTEXT_BRIDGE_HPP
#define XPOD_QLEVER_PHYSICAL_HAS_PREDICATE_CONTEXT_BRIDGE_HPP

#include "XpodQleverPhysicalIndexScanContextBridge.hpp"

#include <optional>
#include <cstdio>
#include <cstdlib>
#include <vector>

#if XPOD_QLEVER_ADAPTER_ENABLE_QLEVER
#include "engine/HasPredicateScan.h"

namespace xpod::qlever {

struct XpodQleverPhysicalHasPredicatePlan {
  const XpodQleverPhysicalIndex* index = nullptr;
  TripleKeyPattern pattern = {};
  uint32_t distinct_slots = 0;
  Permutation::Enum permutation = Permutation::Enum::SPO;
  bool always_empty = false;
};

inline std::optional<XpodQleverPhysicalHasPredicatePlan>
physicalHasPredicatePlanFromContext(
    QueryExecutionContext& context,
    HasPredicateScan::ScanType type,
    const TripleComponent& subject,
    const TripleComponent& object) {
  const XpodQleverPhysicalIndex* index = physicalIndexFromContext(context);
  if (index == nullptr || type == HasPredicateScan::ScanType::SUBQUERY_S) {
    return std::nullopt;
  }

  XpodQleverPhysicalHasPredicatePlan plan;
  plan.index = index;
  const PlannerRequestContext& request_context = index->plannerRequestContext();
  if (type == HasPredicateScan::ScanType::FREE_O) {
    xpod_rdf_term_key subject_key = 0;
    xpod_rdf_status status =
        qleverComponentToPhysicalTermKey(request_context, subject, subject_key);
    if (status == XPOD_RDF_STATUS_NOT_FOUND) {
      plan.always_empty = true;
      return plan;
    }
    if (status != XPOD_RDF_STATUS_OK) {
      return std::nullopt;
    }
    plan.pattern.has_subject = true;
    plan.pattern.subject = subject_key;
    plan.distinct_slots = XPOD_RDF_SLOT_PREDICATE;
  } else if (type == HasPredicateScan::ScanType::FREE_S) {
    xpod_rdf_term_key predicate_key = 0;
    xpod_rdf_status status =
        qleverComponentToPhysicalTermKey(request_context, object, predicate_key);
    if (status == XPOD_RDF_STATUS_NOT_FOUND) {
      plan.always_empty = true;
      return plan;
    }
    if (status != XPOD_RDF_STATUS_OK) {
      return std::nullopt;
    }
    plan.pattern.has_predicate = true;
    plan.pattern.predicate = predicate_key;
    plan.distinct_slots = XPOD_RDF_SLOT_SUBJECT;
    plan.permutation = Permutation::Enum::PSO;
  } else if (type == HasPredicateScan::ScanType::FULL_SCAN) {
    plan.distinct_slots = XPOD_RDF_SLOT_SUBJECT | XPOD_RDF_SLOT_PREDICATE;
  } else {
    return std::nullopt;
  }
  return plan;
}

inline std::optional<uint64_t> physicalHasPredicateSizeEstimateFromContext(
    QueryExecutionContext& context,
    HasPredicateScan::ScanType type,
    const TripleComponent& subject,
    const TripleComponent& object) {
  auto plan = physicalHasPredicatePlanFromContext(
      context, type, subject, object);
  if (!plan.has_value()) {
    return std::nullopt;
  }
  if (plan->always_empty) {
    return 0;
  }
  auto physical = plan->index->permutation(plan->permutation);
  XpodQleverDistinctEstimateResult estimate = physical.estimateDistinct(
      plan->pattern, plan->distinct_slots, plan->distinct_slots);
  if (estimate.status != XPOD_RDF_STATUS_OK) {
    return std::nullopt;
  }
  return estimate.estimate.rows;
}

inline std::optional<float> physicalHasPredicateMultiplicityFromContext(
    QueryExecutionContext& context,
    HasPredicateScan::ScanType type) {
  if (physicalIndexFromContext(context) == nullptr ||
      type == HasPredicateScan::ScanType::SUBQUERY_S) {
    return std::nullopt;
  }
  return 1.0F;
}

inline std::optional<Result> physicalHasPredicateResultFromContext(
    QueryExecutionContext& context,
    HasPredicateScan::ScanType type,
    const TripleComponent& subject,
    const TripleComponent& object,
    const std::vector<ColumnIndex>& sorted_on) {
  if (std::getenv("XPOD_QLEVER_RUNTIME_TRACE") != nullptr) {
    std::fprintf(
        stderr, "xpod has-predicate enter type=%d index=%p\n",
        static_cast<int>(type),
        static_cast<const void*>(physicalIndexFromContext(context)));
  }
  auto plan = physicalHasPredicatePlanFromContext(
      context, type, subject, object);
  if (!plan.has_value()) {
    return std::nullopt;
  }
  if (plan->always_empty) {
    return Result{
        makeQleverIdTable(
            countNeededSlots(plan->distinct_slots), context.getAllocator()),
        sorted_on,
        LocalVocab{}};
  }

  auto physical = plan->index->permutation(plan->permutation);
  XpodQleverDistinctTermsResult distinct =
      physical.distinct(
          plan->pattern, plan->distinct_slots, plan->distinct_slots);
  if (distinct.status != XPOD_RDF_STATUS_OK) {
    return std::nullopt;
  }
  const uint32_t expected_width = countNeededSlots(plan->distinct_slots);
  if (std::getenv("XPOD_QLEVER_RUNTIME_TRACE") != nullptr) {
    std::fprintf(
        stderr,
        "xpod has-predicate distinct rows=%zu width=%u expected=%u terms=%zu\n",
        distinct.row_count, distinct.tuple_width, expected_width,
        distinct.terms.size());
  }
  if (distinct.tuple_width != expected_width ||
      distinct.terms.size() != distinct.row_count * expected_width) {
    throw std::runtime_error("invalid physical has-predicate distinct result shape");
  }

  QleverIdRowBuffer rows;
  rows.width = distinct.tuple_width;
  rows.row_count = distinct.row_count;
  rows.rows.reserve(distinct.terms.size());
  for (xpod_rdf_term_key term : distinct.terms) {
    xpod_rdf_status status = appendEncodedValue(
        rows, plan->index->plannerRequestContext().backend, term);
    if (status != XPOD_RDF_STATUS_OK) {
      return std::nullopt;
    }
  }
  return Result{
      toQleverIdTable(rows, context.getAllocator()), sorted_on, LocalVocab{}};
}

}  // namespace xpod::qlever

#endif  // XPOD_QLEVER_ADAPTER_ENABLE_QLEVER

#endif  // XPOD_QLEVER_PHYSICAL_HAS_PREDICATE_CONTEXT_BRIDGE_HPP
