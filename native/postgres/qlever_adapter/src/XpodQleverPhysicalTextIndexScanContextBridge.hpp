#ifndef XPOD_QLEVER_PHYSICAL_TEXT_INDEX_SCAN_CONTEXT_BRIDGE_HPP
#define XPOD_QLEVER_PHYSICAL_TEXT_INDEX_SCAN_CONTEXT_BRIDGE_HPP

#include "XpodQleverPhysicalIndexScanContextBridge.hpp"
#include "XpodQleverResultBridge.hpp"

#include <string>
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

inline std::string_view stripFixedEntityBrackets(
    std::string_view fixed_entity) noexcept {
  if (fixed_entity.size() >= 2 && fixed_entity.front() == '<' &&
      fixed_entity.back() == '>') {
    return fixed_entity.substr(1, fixed_entity.size() - 2);
  }
  return fixed_entity;
}

inline Id scoreToQleverId(double score) {
  if constexpr (requires { Id::makeFromDouble(score); }) {
    return Id::makeFromDouble(score);
  } else {
    return Id::fromBits(static_cast<uint64_t>(score * 1000000));
  }
}

inline xpod_rdf_status bindFixedEntity(
    const XpodQleverPhysicalIndex& index,
    bool has_fixed_entity,
    std::string_view fixed_entity,
    std::vector<xpod_rdf_term_key>& required_entities) {
  if (!has_fixed_entity) {
    return XPOD_RDF_STATUS_OK;
  }
  std::string_view iri = stripFixedEntityBrackets(fixed_entity);
  if (iri.empty()) {
    return XPOD_RDF_STATUS_UNSUPPORTED;
  }
  xpod_rdf_term term = {};
  term.kind = XPOD_RDF_TERM_IRI;
  term.value = {iri.data(), iri.size()};
  xpod_rdf_term_key key = 0;
  xpod_rdf_status status = index.lookupTerm(term, key);
  if (status != XPOD_RDF_STATUS_OK) {
    return status;
  }
  required_entities.push_back(key);
  return XPOD_RDF_STATUS_OK;
}

inline QleverIdTableResult textCandidatesToQleverEntityTable(
    const xpod::rdf::PhysicalBackend& backend,
    const xpod::rdf::CandidateBuffer& candidates,
    bool has_fixed_entity,
    bool has_score) {
  const size_t width = (has_fixed_entity ? 1 : 2) +
                       static_cast<size_t>(has_score);
  IdTable table = makeQleverIdTable(width);
  std::vector<Id> row;
  row.reserve(width);
  for (const xpod::rdf::CandidateRow& candidate : candidates.rows) {
    if (!candidate.has_retrieval_point ||
        (!has_fixed_entity && !candidate.has_resource_term)) {
      return {XPOD_RDF_STATUS_UNSUPPORTED, makeQleverIdTable(width)};
    }
    uint64_t text_bits = 0;
    xpod_rdf_status status = backend.encodeQleverId(
        candidate.retrieval_point, text_bits);
    if (status != XPOD_RDF_STATUS_OK) {
      return {status, makeQleverIdTable(width)};
    }
    row.clear();
    row.push_back(Id::fromBits(text_bits));
    if (!has_fixed_entity) {
      uint64_t entity_bits = 0;
      status = backend.encodeQleverId(candidate.resource_term, entity_bits);
      if (status != XPOD_RDF_STATUS_OK) {
        return {status, makeQleverIdTable(width)};
      }
      row.push_back(Id::fromBits(entity_bits));
    }
    if (has_score) {
      row.push_back(scoreToQleverId(candidate.score));
    }
    table.push_back(row);
  }
  return {XPOD_RDF_STATUS_OK, std::move(table)};
}

inline QleverIdTableResult textCandidatesToQleverTextRecordTable(
    const xpod::rdf::PhysicalBackend& backend,
    const xpod::rdf::CandidateBuffer& candidates,
    bool has_score) {
  const size_t width = 1 + static_cast<size_t>(has_score);
  IdTable table = makeQleverIdTable(width);
  std::vector<Id> row;
  row.reserve(width);
  for (const xpod::rdf::CandidateRow& candidate : candidates.rows) {
    if (!candidate.has_retrieval_point) {
      return {XPOD_RDF_STATUS_UNSUPPORTED, makeQleverIdTable(width)};
    }
    uint64_t bits = 0;
    xpod_rdf_status status = backend.encodeQleverId(
        candidate.retrieval_point, bits);
    if (status != XPOD_RDF_STATUS_OK) {
      return {status, makeQleverIdTable(width)};
    }
    row.clear();
    row.push_back(Id::fromBits(bits));
    if (has_score) {
      row.push_back(scoreToQleverId(candidate.score));
    }
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
  if (is_prefix) {
    return {};
  }
  (void)has_score;

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
  if (is_prefix) {
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
      index->context().backend, candidates.candidates, has_score);
  return toQleverResult(std::move(table), std::move(sorted_by));
}

template <typename Context>
QleverTextSizeEstimateResult textEntitySizeEstimateFromContext(
    const Context& context,
    std::string_view word,
    bool has_fixed_entity,
    std::string_view fixed_entity,
    bool has_score) {
  (void)has_score;

  const XpodQleverPhysicalIndex* index = physicalIndexFromContext(context);
  if (index == nullptr) {
    return {};
  }

  std::vector<xpod_rdf_term_key> required_entities;
  xpod_rdf_status bind_status = bindFixedEntity(
      *index, has_fixed_entity, fixed_entity, required_entities);
  if (bind_status != XPOD_RDF_STATUS_OK) {
    return {bind_status, false, 0, 0};
  }

  xpod_rdf_text_search_request request = {};
  request.query = {word.data(), word.size()};
  request.required_entities = required_entities.data();
  request.required_entities_size = required_entities.size();
  XpodBackedCandidateEstimate estimate =
      index->textSearch(request, "Xpod TextIndexScanForEntity")
          .estimate();
  if (estimate.status != XPOD_RDF_STATUS_OK) {
    return {estimate.status, false, 0, 0};
  }
  double cost = estimate.estimate.startup_cost + estimate.estimate.cpu_cost +
                estimate.estimate.io_cost;
  size_t rows = static_cast<size_t>(estimate.estimate.rows);
  size_t cost_value = cost <= 0 ? rows : static_cast<size_t>(cost);
  return {
      XPOD_RDF_STATUS_OK,
      estimate.estimate.confidence == XPOD_RDF_ESTIMATE_EXACT,
      rows,
      cost_value};
}

template <typename Context>
QleverResultWithStatus textEntityResultFromContext(
    const Context& context,
    std::string_view word,
    bool has_fixed_entity,
    std::string_view fixed_entity,
    bool has_score,
    std::vector<ColumnIndex> sorted_by = {ColumnIndex{0}}) {
  const size_t width =
      1 + static_cast<size_t>(!has_fixed_entity) +
      static_cast<size_t>(has_score);

  const XpodQleverPhysicalIndex* index = physicalIndexFromContext(context);
  if (index == nullptr) {
    return toQleverResult(
        {XPOD_RDF_STATUS_UNSUPPORTED, makeQleverIdTable(width)},
        std::move(sorted_by));
  }

  std::vector<xpod_rdf_term_key> required_entities;
  xpod_rdf_status bind_status = bindFixedEntity(
      *index, has_fixed_entity, fixed_entity, required_entities);
  if (bind_status != XPOD_RDF_STATUS_OK) {
    return toQleverResult(
        {bind_status, makeQleverIdTable(width)}, std::move(sorted_by));
  }

  xpod_rdf_text_search_request request = {};
  request.query = {word.data(), word.size()};
  request.required_entities = required_entities.data();
  request.required_entities_size = required_entities.size();
  XpodBackedCandidateResult candidates =
      index->textSearch(request, "Xpod TextIndexScanForEntity")
          .computeResult(false);
  if (candidates.status != XPOD_RDF_STATUS_OK) {
    return toQleverResult(
        {candidates.status, makeQleverIdTable(width)}, std::move(sorted_by));
  }

  QleverIdTableResult table = textCandidatesToQleverEntityTable(
      index->context().backend, candidates.candidates, has_fixed_entity,
      has_score);
  return toQleverResult(std::move(table), std::move(sorted_by));
}

}  // namespace xpod::qlever

#endif  // XPOD_QLEVER_ADAPTER_ENABLE_QLEVER

#endif  // XPOD_QLEVER_PHYSICAL_TEXT_INDEX_SCAN_CONTEXT_BRIDGE_HPP
