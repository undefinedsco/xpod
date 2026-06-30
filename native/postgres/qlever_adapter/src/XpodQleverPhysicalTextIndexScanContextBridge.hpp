#ifndef XPOD_QLEVER_PHYSICAL_TEXT_INDEX_SCAN_CONTEXT_BRIDGE_HPP
#define XPOD_QLEVER_PHYSICAL_TEXT_INDEX_SCAN_CONTEXT_BRIDGE_HPP

#include "XpodQleverPhysicalIndexScanContextBridge.hpp"
#include "XpodQleverResultBridge.hpp"

#include <string_view>
#include <vector>

#if XPOD_QLEVER_ADAPTER_ENABLE_QLEVER

namespace xpod::qlever {

struct QleverTextSizeEstimateResult {
  xpod_rdf_status status = XPOD_RDF_STATUS_UNSUPPORTED;
  bool exact = false;
  size_t rows = 0;
  size_t cost = 0;
};

inline QleverIdTableResult textCandidatesToQleverTextRecordTable(
    const xpod::rdf::PhysicalBackend& backend,
    const xpod::rdf::CandidateBuffer& candidates) {
  IdTable table = makeQleverIdTable(1);
  std::vector<Id> row;
  row.reserve(1);
  for (const xpod::rdf::CandidateRow& candidate : candidates.rows) {
    if (!candidate.has_retrieval_point) {
      return {XPOD_RDF_STATUS_UNSUPPORTED, makeQleverIdTable(1)};
    }
    uint64_t bits = 0;
    xpod_rdf_status status = backend.encodeQleverId(
        candidate.retrieval_point, bits);
    if (status != XPOD_RDF_STATUS_OK) {
      return {status, makeQleverIdTable(1)};
    }
    row.clear();
    row.push_back(Id::fromBits(bits));
    table.push_back(row);
  }
  return {XPOD_RDF_STATUS_OK, std::move(table)};
}

template <typename Context>
QleverTextSizeEstimateResult textWordSizeEstimateFromContext(
    const Context& context,
    std::string_view word,
    bool is_prefix,
    bool has_score) {
  if (is_prefix || has_score) {
    return {};
  }

  const XpodQleverPhysicalIndex* index = physicalIndexFromContext(context);
  if (index == nullptr) {
    return {};
  }

  xpod_rdf_text_search_request request = {};
  request.query = {word.data(), word.size()};
  XpodBackedCandidateEstimate estimate =
      index->textSearch(request, "Xpod TextIndexScanForWord")
          .estimate();
  if (estimate.status != XPOD_RDF_STATUS_OK) {
    return {estimate.status, false, 0, 0};
  }
  double cost = estimate.estimate.startup_cost + estimate.estimate.cpu_cost +
                estimate.estimate.io_cost;
  size_t rows = static_cast<size_t>(estimate.estimate.rows);
  size_t cost_value =
      cost <= 0 ? rows : static_cast<size_t>(cost);
  return {
      XPOD_RDF_STATUS_OK,
      estimate.estimate.confidence == XPOD_RDF_ESTIMATE_EXACT,
      rows,
      cost_value};
}

template <typename Context>
QleverResultWithStatus textWordResultFromContext(
    const Context& context,
    std::string_view word,
    bool is_prefix,
    bool has_score,
    std::vector<ColumnIndex> sorted_by = {ColumnIndex{0}}) {
  if (is_prefix || has_score) {
    return toQleverResult(
        {XPOD_RDF_STATUS_UNSUPPORTED, makeQleverIdTable(
            1 + static_cast<size_t>(is_prefix) +
            static_cast<size_t>(has_score))},
        std::move(sorted_by));
  }

  const XpodQleverPhysicalIndex* index = physicalIndexFromContext(context);
  if (index == nullptr) {
    return toQleverResult(
        {XPOD_RDF_STATUS_UNSUPPORTED, makeQleverIdTable(1)},
        std::move(sorted_by));
  }

  xpod_rdf_text_search_request request = {};
  request.query = {word.data(), word.size()};
  XpodBackedCandidateResult candidates =
      index->textSearch(request, "Xpod TextIndexScanForWord").computeResult(false);
  if (candidates.status != XPOD_RDF_STATUS_OK) {
    return toQleverResult(
        {candidates.status, makeQleverIdTable(1)}, std::move(sorted_by));
  }

  QleverIdTableResult table = textCandidatesToQleverTextRecordTable(
      index->context().backend, candidates.candidates);
  return toQleverResult(std::move(table), std::move(sorted_by));
}

}  // namespace xpod::qlever

#endif  // XPOD_QLEVER_ADAPTER_ENABLE_QLEVER

#endif  // XPOD_QLEVER_PHYSICAL_TEXT_INDEX_SCAN_CONTEXT_BRIDGE_HPP
