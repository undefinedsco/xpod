#ifndef XPOD_QLEVER_PHYSICAL_TEXT_INDEX_SCAN_CONTEXT_BRIDGE_HPP
#define XPOD_QLEVER_PHYSICAL_TEXT_INDEX_SCAN_CONTEXT_BRIDGE_HPP

#include "XpodQleverPhysicalIndexScanContextBridge.hpp"
#include "XpodQleverResultBridge.hpp"

#include <string>
#include <string_view>
#include <optional>
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

inline Id retrievalPointToQleverId(xpod_rdf_retrieval_point_key key) {
  return Id::makeFromTextRecordIndex(TextRecordIndex::make(key));
}

inline Id textTermToQleverWordId(xpod_rdf_text_term_key key) {
  return Id::makeFromWordVocabIndex(WordVocabIndex::make(key));
}

inline xpod_rdf_status validateMatchedTextTermCapability(
    const XpodQleverPhysicalIndex& index) noexcept {
  if (index.capabilitiesStatus() != XPOD_RDF_STATUS_OK) {
    return index.capabilitiesStatus();
  }
  return (index.capabilities().features &
          XPOD_RDF_BACKEND_FEATURE_TEXT_MATCHED_TERM) != 0
             ? XPOD_RDF_STATUS_OK
             : XPOD_RDF_STATUS_UNSUPPORTED;
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
  XpodQleverLookupTermsResult lookup = index.lookupTerms(&term, 1);
  if (lookup.status != XPOD_RDF_STATUS_OK) {
    return lookup.status;
  }
  if (lookup.statuses.empty() || lookup.statuses[0] != XPOD_RDF_STATUS_OK) {
    return lookup.statuses.empty() ? XPOD_RDF_STATUS_NOT_FOUND
                                   : lookup.statuses[0];
  }
  required_entities.push_back(lookup.keys[0]);
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
    row.clear();
    row.push_back(retrievalPointToQleverId(candidate.retrieval_point));
    if (!has_fixed_entity) {
      uint64_t entity_bits = 0;
      xpod_rdf_status status =
          backend.encodeQleverId(candidate.resource_term, entity_bits);
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
    const xpod::rdf::CandidateBuffer& candidates,
    bool is_prefix,
    bool has_score) {
  const size_t width = 1 + static_cast<size_t>(is_prefix) +
                       static_cast<size_t>(has_score);
  IdTable table = makeQleverIdTable(width);
  std::vector<Id> row;
  row.reserve(width);
  for (const xpod::rdf::CandidateRow& candidate : candidates.rows) {
    if (!candidate.has_retrieval_point ||
        (is_prefix && !candidate.has_matched_term)) {
      return {XPOD_RDF_STATUS_UNSUPPORTED, makeQleverIdTable(width)};
    }
    row.clear();
    row.push_back(retrievalPointToQleverId(candidate.retrieval_point));
    if (is_prefix) {
      row.push_back(textTermToQleverWordId(candidate.matched_term));
    }
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
  (void)is_prefix;
  (void)has_score;

  const XpodQleverPhysicalIndex* index = physicalIndexFromContext(context);
  if (index == nullptr) {
    return {};
  }
  if (is_prefix) {
    const xpod_rdf_status capability_status =
        validateMatchedTextTermCapability(*index);
    if (capability_status != XPOD_RDF_STATUS_OK) {
      return {capability_status, false, 0, 0};
    }
  }

  xpod_rdf_text_search_request request = {};
  request.query = {word.data(), word.size()};
  request.candidate_kind = XPOD_RDF_TEXT_CANDIDATE_RECORD;
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
std::optional<size_t> bestPhysicalTextTermIndexFromContext(
    const Context& context,
    const std::vector<std::string>& terms) {
  if (terms.empty() || physicalIndexFromContext(context) == nullptr) {
    return std::nullopt;
  }

  std::optional<size_t> best_index;
  size_t best_rows = 0;
  for (size_t index = 0; index < terms.size(); ++index) {
    const std::string& term = terms[index];
    const bool is_prefix = !term.empty() && term.back() == '*';
    QleverTextSizeEstimateResult estimate =
        textWordSizeEstimateFromContext(context, term, is_prefix, false);
    if (estimate.status == XPOD_RDF_STATUS_OK &&
        (!best_index.has_value() || estimate.rows < best_rows)) {
      best_index = index;
      best_rows = estimate.rows;
    }
  }
  return best_index.value_or(0);
}

template <typename Context>
QleverResultWithStatus textWordResultFromContext(
    const Context& context,
    std::string_view word,
    bool is_prefix,
    bool has_score,
    std::vector<ColumnIndex> sorted_by = {ColumnIndex{0}}) {
  const size_t width = 1 + static_cast<size_t>(is_prefix) +
                       static_cast<size_t>(has_score);

  const XpodQleverPhysicalIndex* index = physicalIndexFromContext(context);
  if (index == nullptr) {
    return toQleverResult(
        {XPOD_RDF_STATUS_UNSUPPORTED, makeQleverIdTable(width)},
        std::move(sorted_by));
  }
  if (is_prefix) {
    const xpod_rdf_status capability_status =
        validateMatchedTextTermCapability(*index);
    if (capability_status != XPOD_RDF_STATUS_OK) {
      return toQleverResult(
          {capability_status, makeQleverIdTable(width)},
          std::move(sorted_by));
    }
  }

  xpod_rdf_text_search_request request = {};
  request.query = {word.data(), word.size()};
  request.candidate_kind = XPOD_RDF_TEXT_CANDIDATE_RECORD;
  XpodBackedCandidateResult candidates =
      index->textSearch(request, "Xpod TextIndexScanForWord").computeResult(false);
  if (candidates.status != XPOD_RDF_STATUS_OK) {
    return toQleverResult(
        {candidates.status, makeQleverIdTable(width)}, std::move(sorted_by));
  }

  QleverIdTableResult table =
      textCandidatesToQleverTextRecordTable(
          candidates.candidates, is_prefix, has_score);
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
  request.candidate_kind = XPOD_RDF_TEXT_CANDIDATE_ENTITY;
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
  request.candidate_kind = XPOD_RDF_TEXT_CANDIDATE_ENTITY;
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
