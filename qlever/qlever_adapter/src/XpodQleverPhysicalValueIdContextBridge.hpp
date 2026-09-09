#ifndef XPOD_QLEVER_PHYSICAL_VALUE_ID_CONTEXT_BRIDGE_HPP
#define XPOD_QLEVER_PHYSICAL_VALUE_ID_CONTEXT_BRIDGE_HPP

#include "XpodQleverPhysicalIndex.hpp"
#include "XpodQleverScanMaterializer.hpp"
#include "XpodQleverValueIdBridge.hpp"
#include "engine/sparqlExpressions/SparqlExpressionTypes.h"
#include "global/ValueIdComparators.h"

#include <optional>
#include <string>
#include <string_view>
#include <variant>

#if XPOD_QLEVER_ADAPTER_ENABLE_QLEVER

namespace xpod::qlever {

template <typename Component>
inline std::optional<Id> physicalComponentIdFromContext(
    const QueryExecutionContext& context,
    const Component& component) {
  const XpodQleverPhysicalIndex* index = context.xpodPhysicalIndex();
  if (index == nullptr || detail::qleverComponentIsVariable(component)) {
    return std::nullopt;
  }

  const PlannerRequestContext& planner_context =
      index->plannerRequestContext();
  xpod_rdf_term_key term = 0;
  xpod_rdf_status status =
      qleverComponentToPhysicalTermKey(planner_context, component, term);
  if (status != XPOD_RDF_STATUS_OK) {
    return std::nullopt;
  }

  const xpod_rdf_snapshot* snapshot =
      planner_context.request == nullptr
          ? nullptr
          : &planner_context.request->snapshot;
  uint64_t bits = 0;
  status = encodePhysicalTermAsQleverId(
      planner_context.backend, term, snapshot, bits);
  if (status != XPOD_RDF_STATUS_OK) {
    return std::nullopt;
  }
  return toQleverId(bits);
}

#if XPOD_QLEVER_HAS_EXPORT_ID_LOOKUP
inline std::optional<Id> physicalLiteralOrIriIdFromContext(
    const QueryExecutionContext& context,
    const ad_utility::triple_component::LiteralOrIri& value) {
  const XpodQleverPhysicalIndex* index = context.xpodPhysicalIndex();
  if (index == nullptr) {
    return std::nullopt;
  }

  const PlannerRequestContext& planner_context =
      index->plannerRequestContext();
  xpod_rdf_term_key term = 0;
  if (lookupResolvedLiteralOrIri(planner_context, value, term) !=
      XPOD_RDF_STATUS_OK) {
    return std::nullopt;
  }

  const xpod_rdf_snapshot* snapshot =
      planner_context.request == nullptr
          ? nullptr
          : &planner_context.request->snapshot;
  uint64_t bits = 0;
  if (encodePhysicalTermAsQleverId(
          planner_context.backend, term, snapshot, bits) !=
      XPOD_RDF_STATUS_OK) {
    return std::nullopt;
  }
  return toQleverId(bits);
}
#endif

inline std::optional<LocalVocabEntry> physicalValueIdEntry(
    const Id& id,
    const XpodQleverPhysicalIndex* index,
    const LocalVocabContext& context) {
  using enum Datatype;
  // Inline value projections are many-to-one and must never be decoded as
  // physical RDF term identities through the backend reverse cache.
  if (index == nullptr ||
      (id.getDatatype() != VocabIndex &&
       id.getDatatype() != BlankNodeIndex)) {
    return std::nullopt;
  }
  xpod_rdf_term_key key = 0;
  if (index->decodeQleverId(id.getBits(), key) != XPOD_RDF_STATUS_OK) {
    return std::nullopt;
  }
  auto resolved = index->resolveTerms(&key, 1);
  if (resolved.status != XPOD_RDF_STATUS_OK || resolved.terms.size() != 1 ||
      resolved.statuses.size() != 1 ||
      resolved.statuses[0] != XPOD_RDF_STATUS_OK) {
    return std::nullopt;
  }
  const xpod_rdf_term& term = resolved.terms[0];
  using Iri = ad_utility::triple_component::Iri;
  using LiteralOrIri = ad_utility::triple_component::LiteralOrIri;
  const std::string value(
      term.value.data == nullptr ? "" : term.value.data, term.value.size);
  if (term.kind == XPOD_RDF_TERM_IRI) {
    return LocalVocabEntry{
        LiteralOrIri::iriref("<" + value + ">"), context};
  }
  if (term.kind != XPOD_RDF_TERM_LITERAL) {
    return std::nullopt;
  }
  const std::string datatype(
      term.datatype_iri.data == nullptr ? "" : term.datatype_iri.data,
      term.datatype_iri.size);
  const std::string language(
      term.language.data == nullptr ? "" : term.language.data,
      term.language.size);
  std::optional<std::variant<Iri, std::string>> descriptor;
  if (!language.empty()) {
    descriptor = language;
  } else if (!datatype.empty()) {
    descriptor = Iri::fromIrirefWithoutBrackets(datatype);
  }
  return LocalVocabEntry{
      LiteralOrIri::literalWithoutQuotes(value, std::move(descriptor)),
      context};
}

inline std::optional<LocalVocabEntry> qleverValueIdEntry(
    const Id& id,
    const Index& qlever_index,
    const LocalVocab& local_vocab,
    const LocalVocabContext& context) {
  using enum Datatype;
  if (id.getDatatype() != VocabIndex &&
      id.getDatatype() != LocalVocabIndex &&
      id.getDatatype() != EncodedVal) {
    return std::nullopt;
  }
  return LocalVocabEntry{
      ql::exportIds::getLiteralOrIriFromVocabIndex(
          qlever_index.getImpl(), id, local_vocab),
      context};
}

inline std::optional<int32_t> comparePhysicalValueIds(
    const Id& left,
    const Id& right,
    const XpodQleverPhysicalIndex* index) {
  if (index == nullptr) {
    return std::nullopt;
  }
  xpod_rdf_term_key left_key = 0;
  xpod_rdf_term_key right_key = 0;
  if (index->decodeQleverId(left.getBits(), left_key) !=
          XPOD_RDF_STATUS_OK ||
      index->decodeQleverId(right.getBits(), right_key) !=
          XPOD_RDF_STATUS_OK) {
    return std::nullopt;
  }
  int32_t compare = 0;
  if (index->compareQleverIds(left.getBits(), right.getBits(), compare) !=
      XPOD_RDF_STATUS_OK) {
    return std::nullopt;
  }
  return compare;
}

inline std::optional<Id> inlineTypedLiteralIdFromEntry(
    const LocalVocabEntry& entry) {
  const auto& value = entry.asLiteralOrIri();
  if (!value.isLiteral()) {
    return std::nullopt;
  }
  const std::string_view lexical =
      asStringViewUnsafe(value.getLiteralContent());
  const std::string_view datatype = value.hasDatatype()
      ? asStringViewUnsafe(value.getDatatype())
      : std::string_view{};
  const std::string_view language = value.hasLanguageTag()
      ? asStringViewUnsafe(value.getLanguageTag())
      : std::string_view{};
  const xpod_rdf_term term = {
      XPOD_RDF_TERM_LITERAL,
      {lexical.data(), lexical.size()},
      {datatype.data(), datatype.size()},
      {language.data(), language.size()},
  };
  if (const auto bits = inlineTypedLiteralComparisonBits(term);
      bits.has_value()) {
    return Id::fromBits(*bits);
  }
  return std::nullopt;
}

using RelationalValue = std::variant<Id, LocalVocabEntry>;

// Relational operators compare RDF values, while scanned IDs and sameTerm keep
// the exact physical RDF term identity.
inline RelationalValue relationalValueFromEntry(LocalVocabEntry entry) {
  if (auto inline_id = inlineTypedLiteralIdFromEntry(entry);
      inline_id.has_value()) {
    return *inline_id;
  }
  return entry;
}

inline std::optional<RelationalValue> relationalValueFromPhysicalId(
    const Id& id,
    const XpodQleverPhysicalIndex* index,
    const LocalVocabContext& context) {
  auto entry = physicalValueIdEntry(id, index, context);
  if (!entry.has_value()) {
    return std::nullopt;
  }
  return relationalValueFromEntry(std::move(*entry));
}

inline std::optional<RelationalValue> relationalValueFromQleverId(
    const Id& id,
    const Index& qlever_index,
    const LocalVocab& local_vocab,
    const LocalVocabContext& context) {
  using enum Datatype;
  if (id.getDatatype() != VocabIndex &&
      id.getDatatype() != LocalVocabIndex &&
      id.getDatatype() != EncodedVal) {
    auto normalized_id = normalizeInlineIdForComparison(id);
    if (!normalized_id.has_value()) {
      return std::nullopt;
    }
    return RelationalValue{*normalized_id};
  }
  auto entry = qleverValueIdEntry(
      id, qlever_index, local_vocab, context);
  if (!entry.has_value()) {
    return std::nullopt;
  }
  return relationalValueFromEntry(std::move(*entry));
}

template <valueIdComparators::ComparisonForIncompatibleTypes mode>
inline valueIdComparators::ComparisonResult compareRelationalValues(
    const RelationalValue& left,
    const RelationalValue& right,
    valueIdComparators::Comparison comparison) {
  const auto as_id = [](const RelationalValue& value) {
    if (const auto* id = std::get_if<Id>(&value)) {
      return *id;
    }
    return Id::makeFromLocalVocabIndex(
        &std::get<LocalVocabEntry>(value));
  };
  return valueIdComparators::compareIds<mode>(
      as_id(left), as_id(right), comparison);
}

inline int32_t compareRelationalValueOrder(
    const RelationalValue& left,
    const RelationalValue& right) {
  if (toBoolNotUndef(compareRelationalValues<
                    valueIdComparators::ComparisonForIncompatibleTypes::
                        CompareByType>(
          left, right, valueIdComparators::Comparison::LT))) {
    return -1;
  }
  if (toBoolNotUndef(compareRelationalValues<
                    valueIdComparators::ComparisonForIncompatibleTypes::
                        CompareByType>(
          left, right, valueIdComparators::Comparison::GT))) {
    return 1;
  }
  return 0;
}

inline std::optional<int32_t> comparePhysicalValueIds(
    const Id& left,
    const Id& right,
    const XpodQleverPhysicalIndex* index,
    const Index& qlever_index,
    const LocalVocab& local_vocab,
    const LocalVocabContext& context) {
  auto left_physical = relationalValueFromPhysicalId(left, index, context);
  auto right_physical = relationalValueFromPhysicalId(right, index, context);
  if (!left_physical.has_value() && !right_physical.has_value()) {
    return std::nullopt;
  }
  auto left_value = left_physical.has_value()
      ? std::move(left_physical)
      : relationalValueFromQleverId(left, qlever_index, local_vocab, context);
  auto right_value = right_physical.has_value()
      ? std::move(right_physical)
      : relationalValueFromQleverId(right, qlever_index, local_vocab, context);
  if (!left_value.has_value() || !right_value.has_value()) {
    return std::nullopt;
  }
  return compareRelationalValueOrder(*left_value, *right_value);
}

inline std::optional<int32_t> comparePhysicalValueIds(
    const Id& left,
    const Id& right,
    const sparqlExpression::EvaluationContext* context) {
  if (context == nullptr) {
    return std::nullopt;
  }
  return comparePhysicalValueIds(
      left, right, context->_qec.xpodPhysicalIndex(),
      context->_qec.getIndex(), context->_localVocab,
      context->_qec.getLocalVocabContext());
}

template <valueIdComparators::ComparisonForIncompatibleTypes mode>
inline std::optional<valueIdComparators::ComparisonResult>
comparePhysicalValueIdsForRelational(
    const Id& left,
    const Id& right,
    valueIdComparators::Comparison comparison,
    const sparqlExpression::EvaluationContext* context) {
  if (context == nullptr) {
    return std::nullopt;
  }
  const auto* index = context->_qec.xpodPhysicalIndex();
  const auto& local_context = context->_qec.getLocalVocabContext();
  auto left_physical =
      relationalValueFromPhysicalId(left, index, local_context);
  auto right_physical =
      relationalValueFromPhysicalId(right, index, local_context);
  const bool has_physical_value =
      left_physical.has_value() || right_physical.has_value();
  auto left_value = left_physical.has_value()
      ? std::move(left_physical)
      : relationalValueFromQleverId(
            left, context->_qec.getIndex(), context->_localVocab,
            local_context);
  auto right_value = right_physical.has_value()
      ? std::move(right_physical)
      : relationalValueFromQleverId(
            right, context->_qec.getIndex(), context->_localVocab,
            local_context);
  if (!left_value.has_value() || !right_value.has_value()) {
    return std::nullopt;
  }
  const auto was_normalized_to_inline = [](const Id& original,
                                           const RelationalValue& value) {
    const auto* normalized = std::get_if<Id>(&value);
    return normalized != nullptr &&
           normalized->getBits() != original.getBits();
  };
  if (!has_physical_value &&
      !was_normalized_to_inline(left, *left_value) &&
      !was_normalized_to_inline(right, *right_value)) {
    return std::nullopt;
  }
  return compareRelationalValues<mode>(
      *left_value, *right_value, comparison);
}

}  // namespace xpod::qlever

#endif

#endif
