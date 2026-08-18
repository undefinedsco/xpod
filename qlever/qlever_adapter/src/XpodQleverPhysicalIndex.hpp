#ifndef XPOD_QLEVER_PHYSICAL_INDEX_HPP
#define XPOD_QLEVER_PHYSICAL_INDEX_HPP

#include "XpodBackedIndexScan.hpp"
#include "XpodBackedTextSearch.hpp"
#include "XpodBackedVectorSearch.hpp"
#include "XpodQleverLazyScanBridge.hpp"
#include "XpodQleverPlannerScanInput.hpp"

#include <algorithm>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <iomanip>
#include <optional>
#include <sstream>
#include <string>
#include <string_view>
#include <type_traits>
#include <utility>
#include <variant>
#include <vector>

#if XPOD_QLEVER_ADAPTER_ENABLE_QLEVER

#if __has_include("engine/QueryExecutionContext.h") && \
    __has_include("index/ExportIds.h") && \
    __has_include("index/LocalVocab.h") && \
    __has_include("util/Conversions.h")
#include "engine/QueryExecutionContext.h"
#include "index/ExportIds.h"
#include "index/LocalVocab.h"
#include "util/Conversions.h"
#define XPOD_QLEVER_HAS_EXPORT_ID_LOOKUP 1
#else
#define XPOD_QLEVER_HAS_EXPORT_ID_LOOKUP 0
#endif

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

struct XpodQleverScanSpecAndBlocks {
  xpod_rdf_status status = XPOD_RDF_STATUS_OK;
  TripleKeyPattern pattern = {};
  xpod_rdf_graph_scope graph_scope = {XPOD_RDF_GRAPH_SCOPE_ALL, 0, {}, nullptr, 0};
  std::vector<xpod_rdf_term_key> graph_scope_storage;
  mutable xpod_rdf_access_scope access_scope_override = {};
  std::vector<xpod_rdf_term_key> denied_graph_storage;
  bool has_access_scope_override = false;
  uint32_t needed_slots = XPOD_RDF_SLOT_SUBJECT |
                          XPOD_RDF_SLOT_PREDICATE |
                          XPOD_RDF_SLOT_OBJECT;
  uint64_t limit = 0;
  uint64_t offset = 0;
  bool always_empty = false;
  bool virtual_has_pattern = false;
  uint32_t virtual_has_pattern_distinct_slots = 0;

  void refreshGraphScope() noexcept {
    if (graph_scope.kind == XPOD_RDF_GRAPH_SCOPE_SET) {
      graph_scope.graph_set = graph_scope_storage.data();
      graph_scope.graph_set_size = graph_scope_storage.size();
    }
  }

  const xpod_rdf_access_scope* accessScopeOverride() const noexcept {
    if (!has_access_scope_override) {
      return nullptr;
    }
    access_scope_override.denied_graphs = denied_graph_storage.data();
    access_scope_override.denied_graphs_size = denied_graph_storage.size();
    return &access_scope_override;
  }
};

struct XpodQleverScanSizeBoundsResult {
  xpod_rdf_status status = XPOD_RDF_STATUS_OK;
  uint64_t lower = 0;
  uint64_t upper = 0;
  bool exact = false;
  xpod_rdf_estimate_confidence confidence = XPOD_RDF_ESTIMATE_HEURISTIC;
};

struct XpodQleverMetadataAndBlocksResult {
  xpod_rdf_status status = XPOD_RDF_STATUS_OK;
  bool has_metadata = false;
  std::vector<xpod_rdf_scan_block_metadata> blocks;
  uint64_t total_blocks = 0;
  std::string metadata_version_storage;
  xpod_rdf_bytes metadata_version = {};
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

struct XpodQleverJoinFanoutEstimateResult {
  xpod_rdf_status status;
  xpod_rdf_estimate estimate;
};

struct XpodQleverAccessScopeResult {
  xpod_rdf_status status;
  xpod_rdf_access_scope scope;
};

struct XpodQleverScopeEstimateResult {
  xpod_rdf_status status;
  xpod_rdf_estimate estimate;
};

struct XpodQleverResolvedSourceScopeResult {
  xpod_rdf_status status;
  xpod_rdf_resolved_source_scope scope;
};

struct XpodQleverHistogramHintsResult {
  xpod_rdf_status status;
  std::vector<xpod_rdf_histogram_hint> hints;
  xpod_rdf_bytes stats_version;
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

inline xpod_rdf_status collectHistogramHintsBatch(
    void* callback_user_data,
    const xpod_rdf_histogram_hint_batch* batch) {
  if (callback_user_data == nullptr || batch == nullptr) {
    return XPOD_RDF_STATUS_BACKEND_ERROR;
  }
  auto* result =
      static_cast<XpodQleverHistogramHintsResult*>(callback_user_data);
  result->stats_version = batch->stats_version;
  result->hints.insert(
      result->hints.end(), batch->rows, batch->rows + batch->row_count);
  return XPOD_RDF_STATUS_OK;
}

inline xpod_rdf_status collectScanBlockMetadataBatch(
    void* callback_user_data,
    const xpod_rdf_scan_block_metadata_batch* batch) {
  if (callback_user_data == nullptr || batch == nullptr) {
    return XPOD_RDF_STATUS_BACKEND_ERROR;
  }
  auto* result =
      static_cast<XpodQleverMetadataAndBlocksResult*>(callback_user_data);
  if (batch->rows != nullptr && batch->row_count > 0) {
    result->blocks.insert(
        result->blocks.end(), batch->rows, batch->rows + batch->row_count);
    result->has_metadata = true;
  }
  result->total_blocks = batch->total_blocks;
  if (batch->metadata_version.data != nullptr &&
      batch->metadata_version.size > 0) {
    result->metadata_version_storage.assign(
        batch->metadata_version.data, batch->metadata_version.size);
    result->metadata_version = {
        result->metadata_version_storage.data(),
        result->metadata_version_storage.size()};
  }
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

inline void setPatternSlot(
    TripleKeyPattern& pattern,
    char slot,
    xpod_rdf_term_key key) noexcept {
  switch (slot) {
    case 'S':
      pattern.has_subject = true;
      pattern.subject = key;
      break;
    case 'P':
      pattern.has_predicate = true;
      pattern.predicate = key;
      break;
    case 'O':
      pattern.has_object = true;
      pattern.object = key;
      break;
    case 'G':
      pattern.has_graph = true;
      pattern.graph = key;
      break;
    default:
      break;
  }
}

struct XpodQleverPatternResult {
  xpod_rdf_status status = XPOD_RDF_STATUS_OK;
  TripleKeyPattern pattern = {};
  bool always_empty = false;
  bool virtual_has_pattern = false;
  uint32_t virtual_has_pattern_distinct_slots = 0;
};

namespace detail {

inline std::string stripQleverAngles(std::string value) {
  if (value.size() >= 2 && value.front() == '<' && value.back() == '>') {
    return value.substr(1, value.size() - 2);
  }
  return value;
}

template <typename Component, typename = void>
struct HasIsVariable : std::false_type {};

template <typename Component>
struct HasIsVariable<
    Component,
    decltype(void(std::declval<const Component&>().isVariable()))>
    : std::true_type {};

template <typename Component, typename = void>
struct HasIsIri : std::false_type {};

template <typename Component>
struct HasIsIri<
    Component,
    decltype(void(std::declval<const Component&>().isIri()))>
    : std::true_type {};

template <typename Component, typename = void>
struct HasGetIri : std::false_type {};

template <typename Component>
struct HasGetIri<
    Component,
    decltype(void(std::declval<const Component&>().getIri()))>
    : std::true_type {};

template <typename Component, typename = void>
struct HasIsString : std::false_type {};

template <typename Component>
struct HasIsString<
    Component,
    decltype(void(std::declval<const Component&>().isString()))>
    : std::true_type {};

template <typename Component, typename = void>
struct HasGetString : std::false_type {};

template <typename Component>
struct HasGetString<
    Component,
    decltype(void(std::declval<const Component&>().getString()))>
    : std::true_type {};

template <typename Component, typename = void>
struct HasIsInt : std::false_type {};

template <typename Component>
struct HasIsInt<
    Component,
    decltype(void(std::declval<const Component&>().isInt()))>
    : std::true_type {};

template <typename Component, typename = void>
struct HasGetInt : std::false_type {};

template <typename Component>
struct HasGetInt<
    Component,
    decltype(void(std::declval<const Component&>().getInt()))>
    : std::true_type {};

template <typename Component, typename = void>
struct HasIsDouble : std::false_type {};

template <typename Component>
struct HasIsDouble<
    Component,
    decltype(void(std::declval<const Component&>().isDouble()))>
    : std::true_type {};

template <typename Component, typename = void>
struct HasGetDouble : std::false_type {};

template <typename Component>
struct HasGetDouble<
    Component,
    decltype(void(std::declval<const Component&>().getDouble()))>
    : std::true_type {};

template <typename Component, typename = void>
struct HasIsBool : std::false_type {};

template <typename Component>
struct HasIsBool<
    Component,
    decltype(void(std::declval<const Component&>().isBool()))>
    : std::true_type {};

template <typename Component, typename = void>
struct HasGetBool : std::false_type {};

template <typename Component>
struct HasGetBool<
    Component,
    decltype(void(std::declval<const Component&>().getBool()))>
    : std::true_type {};

template <typename Component, typename = void>
struct HasIsLiteral : std::false_type {};

template <typename Component>
struct HasIsLiteral<
    Component,
    decltype(void(std::declval<const Component&>().isLiteral()))>
    : std::true_type {};

template <typename Component, typename = void>
struct HasGetLiteral : std::false_type {};

template <typename Component>
struct HasGetLiteral<
    Component,
    decltype(void(std::declval<const Component&>().getLiteral()))>
    : std::true_type {};

template <typename Literal, typename = void>
struct HasLiteralGetContent : std::false_type {};

template <typename Literal>
struct HasLiteralGetContent<
    Literal,
    decltype(void(std::declval<const Literal&>().getContent()))>
    : std::true_type {};

template <typename Literal, typename = void>
struct HasLiteralHasDatatype : std::false_type {};

template <typename Literal>
struct HasLiteralHasDatatype<
    Literal,
    decltype(void(std::declval<const Literal&>().hasDatatype()))>
    : std::true_type {};

template <typename Literal, typename = void>
struct HasLiteralGetDatatype : std::false_type {};

template <typename Literal>
struct HasLiteralGetDatatype<
    Literal,
    decltype(void(std::declval<const Literal&>().getDatatype()))>
    : std::true_type {};

template <typename Literal, typename = void>
struct HasLiteralHasLanguageTag : std::false_type {};

template <typename Literal>
struct HasLiteralHasLanguageTag<
    Literal,
    decltype(void(std::declval<const Literal&>().hasLanguageTag()))>
    : std::true_type {};

template <typename Literal, typename = void>
struct HasLiteralGetLanguageTag : std::false_type {};

template <typename Literal>
struct HasLiteralGetLanguageTag<
    Literal,
    decltype(void(std::declval<const Literal&>().getLanguageTag()))>
    : std::true_type {};

template <typename T, typename = void>
struct HasGetBits : std::false_type {};

template <typename T>
struct HasGetBits<T, decltype(void(std::declval<const T&>().getBits()))>
    : std::true_type {};

template <typename Iri>
std::string qleverIriValue(const Iri& iri) {
  return stripQleverAngles(std::string(iri.toStringRepresentation()));
}

template <typename T>
using EnableIfPermutedTripleArgument = std::enable_if_t<
    !std::is_integral<std::decay_t<T>>::value &&
        !std::is_enum<std::decay_t<T>>::value,
    int>;

template <typename Component>
bool qleverComponentIsVariable(const Component& component) {
  if constexpr (HasIsVariable<Component>::value) {
    return component.isVariable();
  }
  return false;
}

inline constexpr std::string_view QleverHasPatternIri =
    "http://qlever.cs.uni-freiburg.de/builtin-functions/has-pattern";
inline constexpr std::string_view QleverDefaultGraphIri =
    "http://qlever.cs.uni-freiburg.de/builtin-functions/default-graph";
inline constexpr uint64_t QleverDefaultGraphIdBits = 3;

struct QleverComponentTerm {
  xpod_rdf_term term = {};
  std::string value;
  std::string datatype;
  std::string language;
  bool has_value = false;

  void bindTermViews() noexcept {
    term.value = {value.data(), value.size()};
    term.datatype_iri = datatype.empty()
                            ? xpod_rdf_bytes{nullptr, 0}
                            : xpod_rdf_bytes{datatype.data(), datatype.size()};
    term.language = language.empty()
                        ? xpod_rdf_bytes{nullptr, 0}
                        : xpod_rdf_bytes{language.data(), language.size()};
  }
};

template <typename Literal>
void applyQleverLiteralTerm(QleverComponentTerm& result,
                            const Literal& literal) {
  if constexpr (HasLiteralGetContent<Literal>::value) {
    result.value = std::string(literal.getContent());
    result.term.kind = XPOD_RDF_TERM_LITERAL;
    result.term.value = {result.value.data(), result.value.size()};
    if constexpr (HasLiteralHasDatatype<Literal>::value &&
                  HasLiteralGetDatatype<Literal>::value) {
      if (literal.hasDatatype()) {
        result.datatype = stripQleverAngles(std::string(literal.getDatatype()));
        result.term.datatype_iri =
            {result.datatype.data(), result.datatype.size()};
      }
    }
    if constexpr (HasLiteralHasLanguageTag<Literal>::value &&
                  HasLiteralGetLanguageTag<Literal>::value) {
      if (literal.hasLanguageTag()) {
        result.language = std::string(literal.getLanguageTag());
        result.term.language = {result.language.data(), result.language.size()};
      }
    }
    result.has_value = true;
  }
}

template <typename Component>
QleverComponentTerm termFromQleverComponent(const Component& component) {
  QleverComponentTerm result = {};
  if constexpr (HasIsIri<Component>::value && HasGetIri<Component>::value) {
    if (component.isIri()) {
      result.value = qleverIriValue(component.getIri());
      result.term.kind = XPOD_RDF_TERM_IRI;
      result.term.value = {result.value.data(), result.value.size()};
      result.has_value = true;
      return result;
    }
  }
  if constexpr (HasIsInt<Component>::value && HasGetInt<Component>::value) {
    if (component.isInt()) {
      result.value = std::to_string(component.getInt());
      result.datatype = "http://www.w3.org/2001/XMLSchema#integer";
      result.term.kind = XPOD_RDF_TERM_LITERAL;
      result.term.value = {result.value.data(), result.value.size()};
      result.term.datatype_iri =
          {result.datatype.data(), result.datatype.size()};
      result.has_value = true;
      return result;
    }
  }
  if constexpr (HasIsDouble<Component>::value &&
                HasGetDouble<Component>::value) {
    if (component.isDouble()) {
      std::ostringstream out;
      out << std::setprecision(17) << component.getDouble();
      result.value = out.str();
      result.datatype = "http://www.w3.org/2001/XMLSchema#double";
      result.term.kind = XPOD_RDF_TERM_LITERAL;
      result.term.value = {result.value.data(), result.value.size()};
      result.term.datatype_iri =
          {result.datatype.data(), result.datatype.size()};
      result.has_value = true;
      return result;
    }
  }
  if constexpr (HasIsBool<Component>::value && HasGetBool<Component>::value) {
    if (component.isBool()) {
      result.value = component.getBool() ? "true" : "false";
      result.datatype = "http://www.w3.org/2001/XMLSchema#boolean";
      result.term.kind = XPOD_RDF_TERM_LITERAL;
      result.term.value = {result.value.data(), result.value.size()};
      result.term.datatype_iri =
          {result.datatype.data(), result.datatype.size()};
      result.has_value = true;
      return result;
    }
  }
  if constexpr (HasIsLiteral<Component>::value &&
                HasGetLiteral<Component>::value) {
    if (component.isLiteral()) {
      applyQleverLiteralTerm(result, component.getLiteral());
      if (result.has_value) {
        return result;
      }
    }
  }
  if constexpr (HasIsString<Component>::value && HasGetString<Component>::value) {
    if (component.isString()) {
      result.value = stripQleverAngles(std::string(component.getString()));
      result.term.kind = XPOD_RDF_TERM_IRI;
      result.term.value = {result.value.data(), result.value.size()};
      result.has_value = true;
      return result;
    }
  }
  return result;
}

template <typename Component>
bool qleverComponentIsHasPatternPredicate(const Component& component) {
  if (qleverComponentIsVariable(component)) {
    return false;
  }
  auto term = termFromQleverComponent(component);
  return term.has_value && term.term.kind == XPOD_RDF_TERM_IRI &&
         term.value == QleverHasPatternIri;
}

template <typename GraphValue>
bool qleverGraphFilterValueIsInternalDefaultGraph(
    const GraphValue& value) {
  if constexpr (HasGetBits<GraphValue>::value) {
    return value.getBits() == QleverDefaultGraphIdBits;
  } else {
    auto term = termFromQleverComponent(value);
    return term.has_value && term.term.kind == XPOD_RDF_TERM_IRI &&
           term.value == QleverDefaultGraphIri;
  }
}

}  // namespace detail

template <typename QleverId>
xpod_rdf_term_key qleverIdToTermKey(const QleverId& id) noexcept {
  return static_cast<xpod_rdf_term_key>(id.getBits());
}

template <typename QleverId>
xpod_rdf_status decodeQleverIdToTermKey(
    const xpod::rdf::PhysicalBackend& backend,
    const QleverId& id,
    xpod_rdf_term_key& out_term) noexcept {
  return backend.decodeQleverId(
      static_cast<uint64_t>(id.getBits()),
      out_term);
}

#if XPOD_QLEVER_HAS_EXPORT_ID_LOOKUP
inline xpod_rdf_bytes bytesFromStringView(std::string_view value) noexcept {
  return {value.data(), value.size()};
}

template <typename ResolvedLiteralOrIri>
xpod_rdf_status lookupResolvedLiteralOrIri(
    const PlannerRequestContext& context,
    const ResolvedLiteralOrIri& resolved,
    xpod_rdf_term_key& out_term) {
  xpod_rdf_term term = {};
  std::string value_storage;
  std::string datatype_storage;
  std::string language_storage;
  if (resolved.isIri()) {
    term.kind = XPOD_RDF_TERM_IRI;
    value_storage =
        std::string(asStringViewUnsafe(resolved.getIriContent()));
  } else if (resolved.isLiteral()) {
    term.kind = XPOD_RDF_TERM_LITERAL;
    value_storage =
        std::string(asStringViewUnsafe(resolved.getLiteralContent()));
    if (resolved.hasDatatype()) {
      datatype_storage =
          std::string(asStringViewUnsafe(resolved.getDatatype()));
      term.datatype_iri = bytesFromStringView(datatype_storage);
    }
    if (resolved.hasLanguageTag()) {
      language_storage =
          std::string(asStringViewUnsafe(resolved.getLanguageTag()));
      term.language = bytesFromStringView(language_storage);
    }
  } else {
    return XPOD_RDF_STATUS_UNSUPPORTED;
  }

  term.value = bytesFromStringView(value_storage);
  xpod_rdf_snapshot empty_snapshot = {};
  const xpod_rdf_snapshot& snapshot =
      context.request == nullptr ? empty_snapshot : context.request->snapshot;
  return context.backend.lookupTerm(term, snapshot, out_term);
}

template <typename QleverId>
xpod_rdf_status lookupQleverIdTermKey(
    const PlannerRequestContext& context,
    const QleverId& id,
    bool& resolved_id,
    xpod_rdf_term_key& out_term) {
  resolved_id = false;
  if (context.qec == nullptr) {
    return XPOD_RDF_STATUS_UNSUPPORTED;
  }

  LocalVocab local_vocab;
  auto resolved = ql::exportIds::idToLiteralOrIri(
      context.qec->getIndex().getImpl(), id, local_vocab);
  if (!resolved.has_value()) {
    return XPOD_RDF_STATUS_NOT_FOUND;
  }

  resolved_id = true;
  return lookupResolvedLiteralOrIri(context, *resolved, out_term);
}

template <typename QleverId>
xpod_rdf_status lookupQleverIdTermKey(
    const PlannerRequestContext& context,
    const QleverId& id,
    const LocalVocab& local_vocab,
    bool& resolved_id,
    xpod_rdf_term_key& out_term) {
  resolved_id = false;
  if (context.qec == nullptr) {
    return XPOD_RDF_STATUS_UNSUPPORTED;
  }

  auto resolved = ql::exportIds::idToLiteralOrIri(
      context.qec->getIndex().getImpl(), id, local_vocab);
  if (!resolved.has_value()) {
    return XPOD_RDF_STATUS_NOT_FOUND;
  }
  resolved_id = true;
  return lookupResolvedLiteralOrIri(context, *resolved, out_term);
}
#endif

template <typename Component>
xpod_rdf_status qleverComponentToPhysicalTermKey(
    const PlannerRequestContext& context,
    const Component& component,
    xpod_rdf_term_key& out_term) {
  auto term = detail::termFromQleverComponent(component);
  if (!term.has_value) {
    return XPOD_RDF_STATUS_UNSUPPORTED;
  }
  term.bindTermViews();
  xpod_rdf_snapshot empty_snapshot = {};
  const xpod_rdf_snapshot& snapshot =
      context.request == nullptr ? empty_snapshot : context.request->snapshot;
  return context.backend.lookupTerm(term.term, snapshot, out_term);
}

template <typename QleverId>
xpod_rdf_status qleverIdToPhysicalTermKey(
    const PlannerRequestContext& context,
    const QleverId& id,
    xpod_rdf_term_key& out_term) {
#if XPOD_QLEVER_HAS_EXPORT_ID_LOOKUP
  bool resolved_id = false;
  xpod_rdf_status lookup_status =
      lookupQleverIdTermKey(context, id, resolved_id, out_term);
  if (resolved_id) {
    return lookup_status;
  }
#endif
  return decodeQleverIdToTermKey(context.backend, id, out_term);
}

#if XPOD_QLEVER_HAS_EXPORT_ID_LOOKUP
template <typename QleverId>
xpod_rdf_status qleverIdToPhysicalTermKey(
    const PlannerRequestContext& context,
    const QleverId& id,
    const LocalVocab* local_vocab,
    xpod_rdf_term_key& out_term) {
  if (local_vocab != nullptr) {
    bool resolved_id = false;
    xpod_rdf_status lookup_status =
        lookupQleverIdTermKey(
            context, id, *local_vocab, resolved_id, out_term);
    if (resolved_id) {
      return lookup_status;
    }
  }
  return qleverIdToPhysicalTermKey(context, id, out_term);
}
#endif

template <typename QleverOptionalId>
[[nodiscard]] xpod_rdf_status applyQleverScanSpecColumn(
    TripleKeyPattern& pattern,
    const PlannerRequestContext& context,
    char slot,
    const QleverOptionalId& id) {
  if (id.has_value()) {
    xpod_rdf_term_key term = 0;
    xpod_rdf_status status =
        qleverIdToPhysicalTermKey(context, *id, term);
    if (status != XPOD_RDF_STATUS_OK) {
      return status;
    }
    setPatternSlot(pattern, slot, term);
  }
  return XPOD_RDF_STATUS_OK;
}

template <typename QleverOptionalId, typename Component>
[[nodiscard]] xpod_rdf_status applyQleverScanSpecColumn(
    TripleKeyPattern& pattern,
    const PlannerRequestContext& context,
    char slot,
    const QleverOptionalId& id,
    const Component* component) {
  xpod_rdf_term_key term = 0;
  if (component != nullptr && !detail::qleverComponentIsVariable(*component)) {
    xpod_rdf_status status =
        qleverComponentToPhysicalTermKey(context, *component, term);
    if (status == XPOD_RDF_STATUS_OK) {
      setPatternSlot(pattern, slot, term);
      return XPOD_RDF_STATUS_OK;
    }
    if (status != XPOD_RDF_STATUS_UNSUPPORTED &&
        status != XPOD_RDF_STATUS_NOT_FOUND) {
      return status;
    }
    if (status == XPOD_RDF_STATUS_NOT_FOUND && !id.has_value()) {
      return status;
    }
  }
  if (!id.has_value()) {
    return XPOD_RDF_STATUS_OK;
  }
  xpod_rdf_status status =
      qleverIdToPhysicalTermKey(context, *id, term);
  if (status != XPOD_RDF_STATUS_OK) {
    return status;
  }
  setPatternSlot(pattern, slot, term);
  return XPOD_RDF_STATUS_OK;
}

inline bool markEmptyScanIfTermNotFound(
    XpodQleverPatternResult& result) noexcept {
  if (result.status != XPOD_RDF_STATUS_NOT_FOUND) {
    return false;
  }
  result.status = XPOD_RDF_STATUS_OK;
  result.always_empty = true;
  result.pattern = {};
  return true;
}

inline bool markEmptyScanIfTermNotFound(
    XpodQleverScanSpecAndBlocks& result) noexcept {
  if (result.status != XPOD_RDF_STATUS_NOT_FOUND) {
    return false;
  }
  result.status = XPOD_RDF_STATUS_OK;
  result.always_empty = true;
  result.pattern = {};
  result.graph_scope = {XPOD_RDF_GRAPH_SCOPE_ALL, 0, {}, nullptr, 0};
  result.graph_scope_storage.clear();
  return true;
}

template <typename QleverScanSpecification>
XpodQleverPatternResult scanSpecificationPattern(
    const PlannerRequestContext& context,
    Permutation::Enum permutation,
    const QleverScanSpecification& scan_specification) {
  XpodQleverPatternResult result = {};
  const char* slots = permutationSlots(permutation);
  result.status = applyQleverScanSpecColumn(
      result.pattern, context, slots[0], scan_specification.col0Id());
  if (markEmptyScanIfTermNotFound(result) ||
      result.status != XPOD_RDF_STATUS_OK) {
    return result;
  }
  result.status = applyQleverScanSpecColumn(
      result.pattern, context, slots[1], scan_specification.col1Id());
  if (markEmptyScanIfTermNotFound(result) ||
      result.status != XPOD_RDF_STATUS_OK) {
    return result;
  }
  result.status = applyQleverScanSpecColumn(
      result.pattern, context, slots[2], scan_specification.col2Id());
  markEmptyScanIfTermNotFound(result);
  return result;
}

template <typename QleverScanSpecification, typename QleverPermutedTriple,
          detail::EnableIfPermutedTripleArgument<QleverPermutedTriple> = 0>
XpodQleverPatternResult scanSpecificationPattern(
    const PlannerRequestContext& context,
    Permutation::Enum permutation,
    const QleverScanSpecification& scan_specification,
    const QleverPermutedTriple& permuted_triple) {
  XpodQleverPatternResult result = {};
  const char* slots = permutationSlots(permutation);
  bool has_pattern_predicate = false;
  for (size_t i = 0; i < 3; ++i) {
    if (slots[i] == 'P' &&
        detail::qleverComponentIsHasPatternPredicate(*permuted_triple[i])) {
      has_pattern_predicate = true;
      break;
    }
  }
  if (has_pattern_predicate) {
    result.virtual_has_pattern = true;
    result.virtual_has_pattern_distinct_slots = XPOD_RDF_SLOT_PREDICATE;
    for (size_t i = 0; i < 3; ++i) {
      if (slots[i] == 'P') {
        continue;
      }
      const char actual_slot = slots[i] == 'O' ? 'P' : slots[i];
      if (i == 0) {
        result.status = applyQleverScanSpecColumn(
            result.pattern, context, actual_slot,
            scan_specification.col0Id(), permuted_triple[0]);
      } else if (i == 1) {
        result.status = applyQleverScanSpecColumn(
            result.pattern, context, actual_slot,
            scan_specification.col1Id(), permuted_triple[1]);
      } else {
        result.status = applyQleverScanSpecColumn(
            result.pattern, context, actual_slot,
            scan_specification.col2Id(), permuted_triple[2]);
      }
      if (markEmptyScanIfTermNotFound(result) ||
          result.status != XPOD_RDF_STATUS_OK) {
        return result;
      }
    }
    return result;
  }
  result.status = applyQleverScanSpecColumn(
      result.pattern, context, slots[0], scan_specification.col0Id(),
      permuted_triple[0]);
  if (markEmptyScanIfTermNotFound(result) ||
      result.status != XPOD_RDF_STATUS_OK) {
    return result;
  }
  result.status = applyQleverScanSpecColumn(
      result.pattern, context, slots[1], scan_specification.col1Id(),
      permuted_triple[1]);
  if (markEmptyScanIfTermNotFound(result) ||
      result.status != XPOD_RDF_STATUS_OK) {
    return result;
  }
  result.status = applyQleverScanSpecColumn(
      result.pattern, context, slots[2], scan_specification.col2Id(),
      permuted_triple[2]);
  markEmptyScanIfTermNotFound(result);
  return result;
}

template <typename QleverScanSpecification, typename = void>
struct HasQleverGraphFilterAllAllowed : std::false_type {};

template <typename QleverScanSpecification>
struct HasQleverGraphFilterAllAllowed<
    QleverScanSpecification,
    decltype(void(std::declval<const QleverScanSpecification&>()
                      .graphFilter()
                      .areAllGraphsAllowed()))> : std::true_type {};

template <typename QleverGraphFilter, typename = void>
struct HasQleverGraphFilterPhysicalAccess : std::false_type {};

template <typename QleverGraphFilter>
struct HasQleverGraphFilterPhysicalAccess<
    QleverGraphFilter,
    decltype(void(std::declval<const QleverGraphFilter&>()
                      .xpodPhysicalFilterType()))> : std::true_type {};

template <typename T, typename = void>
struct HasBeginEnd : std::false_type {};

template <typename T>
struct HasBeginEnd<
    T,
    decltype(void(std::declval<const T&>().begin()),
                  void(std::declval<const T&>().end()))> : std::true_type {};

template <typename QleverScanSpecification, typename = void>
struct HasXpodPhysicalLocalVocab : std::false_type {};

template <typename QleverScanSpecification>
struct HasXpodPhysicalLocalVocab<
    QleverScanSpecification,
    decltype(void(std::declval<const QleverScanSpecification&>()
                      .xpodPhysicalLocalVocab()))> : std::true_type {};

#if XPOD_QLEVER_HAS_EXPORT_ID_LOOKUP
template <typename ResolvedLiteralOrIri>
bool resolvedLiteralOrIriIsDefaultGraph(
    const ResolvedLiteralOrIri& resolved) {
  if (!resolved.isIri()) {
    return false;
  }
  return std::string_view(asStringViewUnsafe(resolved.getIriContent())) ==
         detail::QleverDefaultGraphIri;
}

template <typename QleverId>
bool qleverIdResolvesToDefaultGraph(
    const PlannerRequestContext& context,
    const QleverId& id) {
  if (context.qec == nullptr) {
    return false;
  }
  LocalVocab local_vocab;
  auto resolved = ql::exportIds::idToLiteralOrIri(
      context.qec->getIndex().getImpl(), id, local_vocab);
  return resolved.has_value() &&
         resolvedLiteralOrIriIsDefaultGraph(*resolved);
}

template <typename QleverId, typename QleverScanSpecification>
bool qleverIdResolvesToDefaultGraph(
    const PlannerRequestContext& context,
    const QleverId& id,
    const QleverScanSpecification& scan_specification) {
  if (context.qec == nullptr) {
    return false;
  }
  if constexpr (HasXpodPhysicalLocalVocab<
                    QleverScanSpecification>::value) {
    auto resolved = ql::exportIds::idToLiteralOrIri(
        context.qec->getIndex().getImpl(),
        id,
        scan_specification.xpodPhysicalLocalVocab());
    return resolved.has_value() &&
           resolvedLiteralOrIriIsDefaultGraph(*resolved);
  } else {
    return qleverIdResolvesToDefaultGraph(context, id);
  }
}
#endif

template <typename GraphValue, typename QleverScanSpecification>
bool qleverGraphFilterValueIsDefaultGraph(
    const PlannerRequestContext& context,
    const GraphValue& value,
    const QleverScanSpecification& scan_specification) {
  const bool raw_default =
      detail::qleverGraphFilterValueIsInternalDefaultGraph(value);
  if (raw_default) {
    return true;
  }
#if XPOD_QLEVER_HAS_EXPORT_ID_LOOKUP
  if constexpr (detail::HasGetBits<GraphValue>::value) {
    const bool resolved_default = qleverIdResolvesToDefaultGraph(
        context, value, scan_specification);
    if (std::getenv("XPOD_QLEVER_RUNTIME_TRACE") != nullptr) {
      std::fprintf(
          stderr,
          "xpod graph filter blacklist bits=%llu qec=%p rawDefault=%d "
          "resolvedDefault=%d\n",
          static_cast<unsigned long long>(value.getBits()),
          static_cast<void*>(context.qec),
          raw_default ? 1 : 0,
          resolved_default ? 1 : 0);
    }
    return resolved_default;
  }
#endif
  (void)context;
  (void)scan_specification;
  return false;
}

template <typename QleverScanSpecification>
bool scanSpecificationGraphFilterSupported(
    const QleverScanSpecification& scan_specification) {
  if constexpr (HasQleverGraphFilterAllAllowed<
                    QleverScanSpecification>::value) {
    return scan_specification.graphFilter().areAllGraphsAllowed();
  }
  return true;
}

inline xpod_rdf_status applyGraphFilterScope(
    const xpod_rdf_graph_scope& base_scope,
    const std::vector<xpod_rdf_term_key>& graph_terms,
    XpodQleverScanSpecAndBlocks& result) {
  if (graph_terms.empty()) {
    return XPOD_RDF_STATUS_UNSUPPORTED;
  }
  if (base_scope.kind != XPOD_RDF_GRAPH_SCOPE_ALL) {
    return XPOD_RDF_STATUS_UNSUPPORTED;
  }
  if (graph_terms.size() == 1) {
    result.graph_scope.kind = XPOD_RDF_GRAPH_SCOPE_EXACT;
    result.graph_scope.exact_graph = graph_terms.front();
    return XPOD_RDF_STATUS_OK;
  }
  result.graph_scope_storage = graph_terms;
  result.graph_scope.kind = XPOD_RDF_GRAPH_SCOPE_SET;
  result.refreshGraphScope();
  return XPOD_RDF_STATUS_OK;
}

inline void copyGraphScope(
    const xpod_rdf_graph_scope& scope,
    XpodQleverScanSpecAndBlocks& result) {
  result.graph_scope = scope;
  result.graph_scope_storage.clear();
  if (scope.kind == XPOD_RDF_GRAPH_SCOPE_SET &&
      scope.graph_set != nullptr && scope.graph_set_size != 0) {
    result.graph_scope_storage.assign(
        scope.graph_set, scope.graph_set + scope.graph_set_size);
  }
  result.refreshGraphScope();
}

inline xpod_rdf_status applyGraphBlacklistAccessScope(
    const PlannerRequestContext& context,
    xpod_rdf_term_key denied_graph,
    XpodQleverScanSpecAndBlocks& result) {
  if (context.request != nullptr && context.request->access_scope != nullptr) {
    result.access_scope_override = *context.request->access_scope;
    const xpod_rdf_access_scope& base = *context.request->access_scope;
    if (base.denied_graphs_size > 0) {
      result.denied_graph_storage.assign(
          base.denied_graphs, base.denied_graphs + base.denied_graphs_size);
    }
  }
  if (std::find(
          result.denied_graph_storage.begin(),
          result.denied_graph_storage.end(), denied_graph) ==
      result.denied_graph_storage.end()) {
    result.denied_graph_storage.push_back(denied_graph);
  }
  result.has_access_scope_override = true;
  return XPOD_RDF_STATUS_OK;
}

inline xpod_rdf_status defaultGraphPhysicalTermKey(
    const PlannerRequestContext& context,
    xpod_rdf_term_key& out_term) {
  xpod_rdf_term term = {};
  term.kind = XPOD_RDF_TERM_IRI;
  term.value = {
      detail::QleverDefaultGraphIri.data(),
      detail::QleverDefaultGraphIri.size()};
  xpod_rdf_snapshot empty_snapshot = {};
  const xpod_rdf_snapshot& snapshot =
      context.request == nullptr ? empty_snapshot : context.request->snapshot;
  return context.backend.lookupTerm(term, snapshot, out_term);
}

template <typename GraphValue, typename QleverScanSpecification>
xpod_rdf_status graphFilterValueToPhysicalTermKey(
    const PlannerRequestContext& context,
    const GraphValue& graph_value,
    const QleverScanSpecification& scan_specification,
    xpod_rdf_term_key& out_term) {
  if constexpr (detail::HasGetBits<GraphValue>::value) {
#if XPOD_QLEVER_HAS_EXPORT_ID_LOOKUP
    if constexpr (HasXpodPhysicalLocalVocab<QleverScanSpecification>::value) {
      return qleverIdToPhysicalTermKey(
          context, graph_value, &scan_specification.xpodPhysicalLocalVocab(),
          out_term);
    } else {
      return qleverIdToPhysicalTermKey(context, graph_value, out_term);
    }
#else
    (void)scan_specification;
    return qleverIdToPhysicalTermKey(context, graph_value, out_term);
#endif
  } else {
    (void)scan_specification;
    return qleverComponentToPhysicalTermKey(context, graph_value, out_term);
  }
}

template <typename QleverScanSpecification>
xpod_rdf_status applyQleverGraphFilterScope(
    const PlannerRequestContext& context,
    const QleverScanSpecification& scan_specification,
    XpodQleverScanSpecAndBlocks& result) {
  const auto& graph_filter = scan_specification.graphFilter();
  if (graph_filter.areAllGraphsAllowed()) {
    if (context.request != nullptr) {
      copyGraphScope(context.request->graph_scope, result);
    }
    return XPOD_RDF_STATUS_OK;
  }
  if constexpr (!HasQleverGraphFilterPhysicalAccess<
                    std::decay_t<decltype(graph_filter)>>::value) {
    return XPOD_RDF_STATUS_UNSUPPORTED;
  } else {
    using GraphFilter = std::decay_t<decltype(graph_filter)>;
    const auto& filter = graph_filter.xpodPhysicalFilterType();
    return std::visit(
        [&](const auto& value) -> xpod_rdf_status {
          using Value = std::decay_t<decltype(value)>;
          if constexpr (std::is_same_v<Value,
                                        typename GraphFilter::AllTag>) {
            if (context.request != nullptr) {
              copyGraphScope(context.request->graph_scope, result);
            }
            return XPOD_RDF_STATUS_OK;
          } else if constexpr (HasBeginEnd<Value>::value) {
            std::vector<xpod_rdf_term_key> graph_terms;
            bool includes_default_graph = false;
            for (const auto& graph_id : value) {
              if (qleverGraphFilterValueIsDefaultGraph(
                      context, graph_id, scan_specification)) {
                includes_default_graph = true;
                continue;
              }
              xpod_rdf_term_key graph_term = 0;
              xpod_rdf_status status = graphFilterValueToPhysicalTermKey(
                  context, graph_id, scan_specification, graph_term);
              if (status == XPOD_RDF_STATUS_NOT_FOUND) {
                continue;
              }
              if (status != XPOD_RDF_STATUS_OK) {
                return status;
              }
              graph_terms.push_back(graph_term);
            }
            if (includes_default_graph) {
              if (!graph_terms.empty()) {
                return XPOD_RDF_STATUS_UNSUPPORTED;
              }
              if (context.request != nullptr) {
                copyGraphScope(context.request->graph_scope, result);
              }
              return XPOD_RDF_STATUS_OK;
            }
            if (graph_terms.empty()) {
              result.always_empty = true;
              result.graph_scope = {
                  XPOD_RDF_GRAPH_SCOPE_ALL, 0, {}, nullptr, 0};
              return XPOD_RDF_STATUS_OK;
            }
            xpod_rdf_graph_scope base_scope =
                context.request == nullptr
                    ? xpod_rdf_graph_scope{XPOD_RDF_GRAPH_SCOPE_ALL, 0, {},
                                           nullptr, 0}
                    : context.request->graph_scope;
            return applyGraphFilterScope(base_scope, graph_terms, result);
          } else {
            if (context.request != nullptr) {
              copyGraphScope(context.request->graph_scope, result);
            }
            xpod_rdf_term_key denied_graph = 0;
            xpod_rdf_status status =
                qleverGraphFilterValueIsDefaultGraph(
                    context, value, scan_specification)
                    ? defaultGraphPhysicalTermKey(context, denied_graph)
                    : graphFilterValueToPhysicalTermKey(
                          context, value, scan_specification, denied_graph);
            if (status == XPOD_RDF_STATUS_NOT_FOUND) {
              return XPOD_RDF_STATUS_OK;
            }
            if (status != XPOD_RDF_STATUS_OK) {
              return status;
            }
            return applyGraphBlacklistAccessScope(
                context, denied_graph, result);
          }
        },
        filter);
  }
}

class XpodQleverPhysicalPermutation {
 public:
  XpodQleverPhysicalPermutation(
      PlannerRequestContext context,
      Permutation::Enum permutation) noexcept
      : context_(context), permutation_(permutation) {}

  Permutation::Enum permutation() const noexcept { return permutation_; }

  xpod_rdf_status indexScanConstructionCapabilityStatus() const noexcept {
    if (!context_.backend.hasScanPermutation() ||
        !context_.backend.hasEstimateScan()) {
      return XPOD_RDF_STATUS_UNSUPPORTED;
    }
    return validatePermutationScanCapability();
  }

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

  QleverIdTableResult scan(
      const XpodQleverScanSpecAndBlocks& scan_spec_and_blocks) const {
    return scan(
        scan_spec_and_blocks,
        ad_utility::makeUnlimitedAllocator<Id>());
  }

  QleverIdTableResult scan(
      const XpodQleverScanSpecAndBlocks& scan_spec_and_blocks,
      const ad_utility::AllocatorWithLimit<Id>& allocator) const {
    if (scan_spec_and_blocks.status != XPOD_RDF_STATUS_OK) {
      return {
          scan_spec_and_blocks.status,
          makeQleverIdTable(
              countNeededSlots(scan_spec_and_blocks.needed_slots), allocator)};
    }
    if (scan_spec_and_blocks.always_empty) {
      return {
          XPOD_RDF_STATUS_OK,
          makeQleverIdTable(
              countNeededSlots(scan_spec_and_blocks.needed_slots), allocator)};
    }
    if (scan_spec_and_blocks.virtual_has_pattern) {
      return scanVirtualHasPattern(scan_spec_and_blocks);
    }
    return XpodBackedIndexScan(
        context_.backend,
        makeScanInput(scan_spec_and_blocks),
        allocator,
        {},
        countNeededSlots(scan_spec_and_blocks.needed_slots),
        physicalPermutationDescriptor(permutation_))
        .execute();
  }

  QleverIdTableResult scanSelectedBlocks(
      const XpodQleverScanSpecAndBlocks& scan_spec_and_blocks,
      const std::vector<xpod_rdf_scan_block_metadata>& blocks,
      xpod_rdf_bytes block_metadata_version = {}) const {
    if (scan_spec_and_blocks.status != XPOD_RDF_STATUS_OK) {
      return {
          scan_spec_and_blocks.status,
          makeQleverIdTable(countNeededSlots(scan_spec_and_blocks.needed_slots))};
    }
    if (scan_spec_and_blocks.always_empty) {
      return {
          XPOD_RDF_STATUS_OK,
          makeQleverIdTable(countNeededSlots(scan_spec_and_blocks.needed_slots))};
    }
    if (blocks.empty()) {
      return {
          XPOD_RDF_STATUS_OK,
          makeQleverIdTable(countNeededSlots(scan_spec_and_blocks.needed_slots))};
    }

    ScanRequestInput input = makeSelectedBlockScanInput(
        scan_spec_and_blocks, blocks, block_metadata_version);

    return XpodBackedIndexScan(
        context_.backend,
        input,
        {},
        countNeededSlots(input.needed_slots),
        physicalPermutationDescriptor(permutation_))
        .execute();
  }

  QleverIdTableBlocksResult lazyScan(
      const XpodQleverScanSpecAndBlocks& scan_spec_and_blocks,
      const std::vector<xpod_rdf_scan_block_metadata>& blocks,
      xpod_rdf_bytes block_metadata_version = {}) const {
    return lazyScan(
        scan_spec_and_blocks, blocks, block_metadata_version,
        ad_utility::makeUnlimitedAllocator<Id>());
  }

  QleverIdTableBlocksResult lazyScan(
      const XpodQleverScanSpecAndBlocks& scan_spec_and_blocks,
      const std::vector<xpod_rdf_scan_block_metadata>& blocks,
      xpod_rdf_bytes block_metadata_version,
      const ad_utility::AllocatorWithLimit<Id>& allocator) const {
    if (scan_spec_and_blocks.status != XPOD_RDF_STATUS_OK) {
      return {scan_spec_and_blocks.status, {}};
    }
    if (scan_spec_and_blocks.always_empty) {
      return {XPOD_RDF_STATUS_OK, {}};
    }
    if (blocks.empty()) {
      return {XPOD_RDF_STATUS_OK, {}};
    }
    xpod_rdf_status capability_status =
        validateSelectedBlockScanCapability();
    if (capability_status != XPOD_RDF_STATUS_OK) {
      return {capability_status, {}};
    }

    ScanRequestInput input = makeSelectedBlockScanInput(
        scan_spec_and_blocks, blocks, block_metadata_version);

    return executeScanToQleverIdTableBlocks(
        context_.backend, input, allocator);
  }

  QleverIdTableBlocksResult lazyScanAll(
      const XpodQleverScanSpecAndBlocks& scan_spec_and_blocks) const {
    return lazyScanAll(
        scan_spec_and_blocks,
        ad_utility::makeUnlimitedAllocator<Id>());
  }

  QleverIdTableBlocksResult lazyScanAll(
      const XpodQleverScanSpecAndBlocks& scan_spec_and_blocks,
      const ad_utility::AllocatorWithLimit<Id>& allocator) const {
    if (scan_spec_and_blocks.status != XPOD_RDF_STATUS_OK) {
      return {scan_spec_and_blocks.status, {}};
    }
    if (scan_spec_and_blocks.always_empty) {
      return {XPOD_RDF_STATUS_OK, {}};
    }
    if (scan_spec_and_blocks.virtual_has_pattern) {
      QleverIdTableResult table = scanVirtualHasPattern(scan_spec_and_blocks);
      if (table.status != XPOD_RDF_STATUS_OK) {
        return {table.status, {}};
      }
      QleverIdTableBlocksResult blocks = {};
      blocks.status = XPOD_RDF_STATUS_OK;
      if (table.table.numRows() > 0) {
        blocks.blocks.push_back(std::move(table.table));
      }
      return blocks;
    }
    xpod_rdf_status capability_status = validatePermutationScanCapability();
    if (capability_status != XPOD_RDF_STATUS_OK) {
      return {capability_status, {}};
    }

    ScanRequestInput input = makeScanInput(scan_spec_and_blocks);
    return executeScanToQleverIdTableBlocks(
        context_.backend, input, allocator);
  }

#if __has_include("index/CompressedRelation.h")
  QleverLazyScanRangeResult lazyScanRange(
      const XpodQleverScanSpecAndBlocks& scan_spec_and_blocks,
      const std::vector<xpod_rdf_scan_block_metadata>& blocks,
      xpod_rdf_bytes block_metadata_version = {}) const {
    if (context_.backend.hasScanCursor()) {
      return lazyScanRange(
          scan_spec_and_blocks, blocks, block_metadata_version,
          ad_utility::makeUnlimitedAllocator<Id>());
    }
    return toQleverLazyScanRange(
        lazyScan(scan_spec_and_blocks, blocks, block_metadata_version));
  }

  QleverLazyScanRangeResult lazyScanRange(
      const XpodQleverScanSpecAndBlocks& scan_spec_and_blocks,
      const std::vector<xpod_rdf_scan_block_metadata>& blocks,
      xpod_rdf_bytes block_metadata_version,
      const ad_utility::AllocatorWithLimit<Id>& allocator) const {
    if (context_.backend.hasScanCursor()) {
      if (scan_spec_and_blocks.status != XPOD_RDF_STATUS_OK) {
        return {scan_spec_and_blocks.status, {}};
      }
      if (scan_spec_and_blocks.always_empty || blocks.empty()) {
        return {XPOD_RDF_STATUS_OK, {}};
      }
      xpod_rdf_status capability_status =
          validateSelectedBlockScanCapability();
      if (capability_status != XPOD_RDF_STATUS_OK) {
        return {capability_status, {}};
      }
      ScanRequestInput input = makeSelectedBlockScanInput(
          scan_spec_and_blocks, blocks, block_metadata_version);
      return toQleverLazyScanRange(context_.backend, input, allocator);
    }
    return toQleverLazyScanRange(
        lazyScan(
            scan_spec_and_blocks, blocks, block_metadata_version,
            allocator));
  }

  QleverLazyScanRangeResult lazyScanRange(
      const XpodQleverScanSpecAndBlocks& scan_spec_and_blocks) const {
    if (context_.backend.hasScanCursor()) {
      return lazyScanRange(
          scan_spec_and_blocks, ad_utility::makeUnlimitedAllocator<Id>());
    }
    return toQleverLazyScanRange(lazyScanAll(scan_spec_and_blocks));
  }


  QleverLazyScanRangeResult lazyScanRange(
      const XpodQleverScanSpecAndBlocks& scan_spec_and_blocks,
      const ad_utility::AllocatorWithLimit<Id>& allocator) const {
    if (context_.backend.hasScanCursor()) {
      if (scan_spec_and_blocks.status != XPOD_RDF_STATUS_OK) {
        return {scan_spec_and_blocks.status, {}};
      }
      if (scan_spec_and_blocks.always_empty) {
        return {XPOD_RDF_STATUS_OK, {}};
      }
      if (scan_spec_and_blocks.virtual_has_pattern) {
        return toQleverLazyScanRange(
            lazyScanAll(scan_spec_and_blocks, allocator));
      }
      xpod_rdf_status capability_status = validatePermutationScanCapability();
      if (capability_status != XPOD_RDF_STATUS_OK) {
        return {capability_status, {}};
      }
      ScanRequestInput input = makeScanInput(scan_spec_and_blocks);
      return toQleverLazyScanRange(context_.backend, input, allocator);
    }
    return toQleverLazyScanRange(
        lazyScanAll(scan_spec_and_blocks, allocator));
  }
#endif

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

  template <typename QleverScanSpecification>
  XpodQleverScanSpecAndBlocks getScanSpecAndBlocks(
      const QleverScanSpecification& scan_specification,
      uint32_t needed_slots = XPOD_RDF_SLOT_SUBJECT |
                              XPOD_RDF_SLOT_PREDICATE |
                              XPOD_RDF_SLOT_OBJECT) const {
    XpodQleverScanSpecAndBlocks result = {};
    result.needed_slots = needed_slots;
    if constexpr (HasQleverGraphFilterAllAllowed<
                      QleverScanSpecification>::value) {
      result.status = applyQleverGraphFilterScope(
          context_, scan_specification, result);
      if (markEmptyScanIfTermNotFound(result) ||
          result.status != XPOD_RDF_STATUS_OK) {
        return result;
      }
    } else if (!scanSpecificationGraphFilterSupported(scan_specification)) {
      result.status = XPOD_RDF_STATUS_UNSUPPORTED;
      return result;
    }
    auto pattern_result = scanSpecificationPattern(
        context_, permutation_, scan_specification);
    result.status = pattern_result.status;
    result.pattern = pattern_result.pattern;
    result.always_empty = result.always_empty || pattern_result.always_empty;
    result.virtual_has_pattern = pattern_result.virtual_has_pattern;
    result.virtual_has_pattern_distinct_slots =
        pattern_result.virtual_has_pattern_distinct_slots;
    return result;
  }

  template <typename QleverScanSpecification, typename QleverPermutedTriple,
            detail::EnableIfPermutedTripleArgument<QleverPermutedTriple> = 0>
  XpodQleverScanSpecAndBlocks getScanSpecAndBlocks(
      const QleverScanSpecification& scan_specification,
      const QleverPermutedTriple& permuted_triple,
      uint32_t needed_slots = XPOD_RDF_SLOT_SUBJECT |
                              XPOD_RDF_SLOT_PREDICATE |
                              XPOD_RDF_SLOT_OBJECT) const {
    XpodQleverScanSpecAndBlocks result = {};
    result.needed_slots = needed_slots;
    if constexpr (HasQleverGraphFilterAllAllowed<
                      QleverScanSpecification>::value) {
      result.status = applyQleverGraphFilterScope(
          context_, scan_specification, result);
      if (markEmptyScanIfTermNotFound(result) ||
          result.status != XPOD_RDF_STATUS_OK) {
        return result;
      }
    } else if (!scanSpecificationGraphFilterSupported(scan_specification)) {
      result.status = XPOD_RDF_STATUS_UNSUPPORTED;
      return result;
    }
    auto pattern_result = scanSpecificationPattern(
        context_, permutation_, scan_specification, permuted_triple);
    result.status = pattern_result.status;
    result.pattern = pattern_result.pattern;
    result.always_empty = result.always_empty || pattern_result.always_empty;
    result.virtual_has_pattern = pattern_result.virtual_has_pattern;
    result.virtual_has_pattern_distinct_slots =
        pattern_result.virtual_has_pattern_distinct_slots;
    return result;
  }

  XpodQleverScanSizeBoundsResult getSizeEstimateForScan(
      const XpodQleverScanSpecAndBlocks& scan_spec_and_blocks) const {
    XpodQleverScanSizeBoundsResult result = {};
    result.status = scan_spec_and_blocks.status;
    if (result.status != XPOD_RDF_STATUS_OK) {
      return result;
    }
    if (scan_spec_and_blocks.always_empty) {
      result.lower = 0;
      result.upper = 0;
      result.exact = true;
      result.confidence = XPOD_RDF_ESTIMATE_EXACT;
      return result;
    }
    if (scan_spec_and_blocks.virtual_has_pattern) {
      uint32_t actual_slots =
          virtualHasPatternActualSlots(scan_spec_and_blocks.needed_slots);
      if (actual_slots == 0 && scan_spec_and_blocks.needed_slots != 0) {
        result.status = XPOD_RDF_STATUS_UNSUPPORTED;
        return result;
      }
      XpodQleverDistinctEstimateResult estimate =
          estimateDistinct(scan_spec_and_blocks, actual_slots, actual_slots);
      result.status = estimate.status;
      if (result.status != XPOD_RDF_STATUS_OK) {
        return result;
      }
      result.upper = estimate.estimate.rows;
      result.confidence = estimate.estimate.confidence;
      result.exact = estimate.estimate.confidence ==
                     XPOD_RDF_ESTIMATE_EXACT;
      result.lower = result.exact ? result.upper : 0;
      return result;
    }

    const XpodBackedScanEstimate estimate_result = XpodBackedIndexScan(
        context_.backend,
        makeScanInput(scan_spec_and_blocks),
        {},
        countNeededSlots(scan_spec_and_blocks.needed_slots),
        physicalPermutationDescriptor(permutation_))
        .estimate();
    result.status = estimate_result.status;
    if (result.status != XPOD_RDF_STATUS_OK) {
      return result;
    }

    result.upper = estimate_result.estimate.rows;
    result.confidence = estimate_result.estimate.confidence;
    result.exact = estimate_result.estimate.confidence ==
                   XPOD_RDF_ESTIMATE_EXACT;
    result.lower = result.exact ? result.upper : 0;
    return result;
  }

  XpodQleverCountResult getResultSizeOfScan(
      const XpodQleverScanSpecAndBlocks& scan_spec_and_blocks) const {
    if (scan_spec_and_blocks.status != XPOD_RDF_STATUS_OK) {
      return {scan_spec_and_blocks.status, {}};
    }
    if (scan_spec_and_blocks.always_empty) {
      xpod_rdf_count_result count_result = {};
      count_result.count = 0;
      count_result.confidence = XPOD_RDF_ESTIMATE_EXACT;
      return {XPOD_RDF_STATUS_OK, count_result};
    }
    if (scan_spec_and_blocks.virtual_has_pattern) {
      QleverIdTableResult table = scanVirtualHasPattern(scan_spec_and_blocks);
      if (table.status != XPOD_RDF_STATUS_OK) {
        return {table.status, {}};
      }
      xpod_rdf_count_result count_result = {};
      count_result.count = table.table.numRows();
      count_result.confidence = XPOD_RDF_ESTIMATE_EXACT;
      return {XPOD_RDF_STATUS_OK, count_result};
    }
    XpodQleverCountResult result = {};
    const ScanRequestInput input = makeScanInput(scan_spec_and_blocks);
    const xpod_rdf_scan_request request = makeScanRequest(input);
    result.status = context_.backend.countScan(request, result.result);
    return result;
  }

  XpodQleverMetadataAndBlocksResult getMetadataAndBlocks(
      const XpodQleverScanSpecAndBlocks& scan_spec_and_blocks) const {
    XpodQleverMetadataAndBlocksResult result = {};
    result.status = scan_spec_and_blocks.status;
    if (result.status != XPOD_RDF_STATUS_OK) {
      return result;
    }
    if (scan_spec_and_blocks.always_empty) {
      return result;
    }
    if (context_.capabilities_status == XPOD_RDF_STATUS_OK &&
        (context_.capabilities.features &
         XPOD_RDF_BACKEND_FEATURE_BLOCK_METADATA) == 0) {
      result.status = XPOD_RDF_STATUS_UNSUPPORTED;
      return result;
    }
    if (context_.capabilities_status != XPOD_RDF_STATUS_OK &&
        context_.capabilities_status != XPOD_RDF_STATUS_UNSUPPORTED) {
      result.status = context_.capabilities_status;
      return result;
    }

    const ScanRequestInput input = makeScanInput(scan_spec_and_blocks);
    const xpod_rdf_scan_request request = makeScanRequest(input);
    xpod_rdf_bytes metadata_version = {};
    result.status = context_.backend.scanBlockMetadata(
        request, collectScanBlockMetadataBatch, &result, metadata_version);
    if (result.metadata_version.size == 0 &&
        metadata_version.data != nullptr &&
        metadata_version.size > 0) {
      result.metadata_version_storage.assign(
          metadata_version.data, metadata_version.size);
      result.metadata_version = {
          result.metadata_version_storage.data(),
          result.metadata_version_storage.size()};
    }
    result.has_metadata = result.has_metadata || !result.blocks.empty();
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

  XpodQleverDistinctTermsResult distinct(
      const XpodQleverScanSpecAndBlocks& scan_spec_and_blocks,
      uint32_t distinct_slots,
      uint32_t needed_slots = XPOD_RDF_SLOT_SUBJECT |
                              XPOD_RDF_SLOT_PREDICATE |
                              XPOD_RDF_SLOT_OBJECT) const {
    XpodQleverDistinctTermsResult result = {};
    if (scan_spec_and_blocks.status != XPOD_RDF_STATUS_OK) {
      result.status = scan_spec_and_blocks.status;
      return result;
    }
    if (scan_spec_and_blocks.always_empty) {
      result.status = XPOD_RDF_STATUS_OK;
      result.tuple_width = countNeededSlots(distinct_slots);
      return result;
    }
    const ScanRequestInput input = makeScanInput(
        scan_spec_and_blocks, needed_slots);
    xpod_rdf_distinct_request request = {};
    request.scan = makeScanRequest(input);
    request.distinct_slots = distinct_slots;
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

  XpodQleverDistinctEstimateResult estimateDistinct(
      const XpodQleverScanSpecAndBlocks& scan_spec_and_blocks,
      uint32_t distinct_slots,
      uint32_t needed_slots = XPOD_RDF_SLOT_SUBJECT |
                              XPOD_RDF_SLOT_PREDICATE |
                              XPOD_RDF_SLOT_OBJECT) const {
    XpodQleverDistinctEstimateResult result = {};
    if (scan_spec_and_blocks.status != XPOD_RDF_STATUS_OK) {
      result.status = scan_spec_and_blocks.status;
      return result;
    }
    if (scan_spec_and_blocks.always_empty) {
      result.status = XPOD_RDF_STATUS_OK;
      result.estimate.rows = 0;
      result.estimate.confidence = XPOD_RDF_ESTIMATE_EXACT;
      return result;
    }
    const ScanRequestInput input = makeScanInput(
        scan_spec_and_blocks, needed_slots);
    xpod_rdf_distinct_request request = {};
    request.scan = makeScanRequest(input);
    request.distinct_slots = distinct_slots;
    result.status =
        context_.backend.estimateDistinct(request, result.estimate);
    return result;
  }

 private:
  xpod_rdf_status validatePermutationScanCapability() const noexcept {
    if (context_.capabilities_status == XPOD_RDF_STATUS_UNSUPPORTED) {
      return XPOD_RDF_STATUS_OK;
    }
    if (context_.capabilities_status != XPOD_RDF_STATUS_OK) {
      return context_.capabilities_status;
    }
    if ((context_.capabilities.supported_permutations &
         toXpodPermutationCapability(permutation_)) == 0) {
      return XPOD_RDF_STATUS_UNSUPPORTED;
    }
    return XPOD_RDF_STATUS_OK;
  }

  xpod_rdf_status validateSelectedBlockScanCapability() const noexcept {
    xpod_rdf_status capability_status = validatePermutationScanCapability();
    if (capability_status != XPOD_RDF_STATUS_OK ||
        context_.capabilities_status == XPOD_RDF_STATUS_UNSUPPORTED) {
      return capability_status;
    }
    if ((context_.capabilities.features &
         XPOD_RDF_BACKEND_FEATURE_BLOCK_RESTRICTED_SCAN) == 0) {
      return XPOD_RDF_STATUS_UNSUPPORTED;
    }
    return XPOD_RDF_STATUS_OK;
  }

  xpod_rdf_snapshot snapshot() const noexcept {
    return context_.request == nullptr
               ? xpod_rdf_snapshot{}
               : context_.request->snapshot;
  }

  ScanRequestInput makeSelectedBlockScanInput(
      const XpodQleverScanSpecAndBlocks& scan_spec_and_blocks,
      const std::vector<xpod_rdf_scan_block_metadata>& blocks,
      xpod_rdf_bytes block_metadata_version) const {
    ScanRequestInput input = makeScanInput(scan_spec_and_blocks);
    input.block_metadata = blocks;
    if (block_metadata_version.data != nullptr &&
        block_metadata_version.size > 0) {
      input.block_metadata_version_storage.assign(
          block_metadata_version.data, block_metadata_version.size);
      input.block_metadata_version = {
          input.block_metadata_version_storage.data(),
          input.block_metadata_version_storage.size()};
    }
    return input;
  }

  ScanRequestInput makeScanInput(
      const XpodQleverScanSpecAndBlocks& scan_spec_and_blocks) const {
    return makeScanInput(
        scan_spec_and_blocks,
        scan_spec_and_blocks.needed_slots);
  }

  ScanRequestInput makeScanInput(
      const XpodQleverScanSpecAndBlocks& scan_spec_and_blocks,
      uint32_t needed_slots) const {
    ScanRequestInput input = makeScanInput(
        scan_spec_and_blocks.pattern, needed_slots);
    if (scan_spec_and_blocks.graph_scope.kind != XPOD_RDF_GRAPH_SCOPE_ALL) {
      input.graph_scope = scan_spec_and_blocks.graph_scope;
      if (input.graph_scope.kind == XPOD_RDF_GRAPH_SCOPE_SET) {
        input.graph_scope.graph_set =
            scan_spec_and_blocks.graph_scope_storage.data();
        input.graph_scope.graph_set_size =
            scan_spec_and_blocks.graph_scope_storage.size();
      }
    }
    if (const xpod_rdf_access_scope* access_scope =
            scan_spec_and_blocks.accessScopeOverride();
        access_scope != nullptr) {
      input.access_scope = access_scope;
    }
    input.limit = scan_spec_and_blocks.limit;
    input.offset = scan_spec_and_blocks.offset;
    return input;
  }

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

  uint32_t virtualHasPatternActualSlots(uint32_t virtual_slots) const noexcept {
    if ((virtual_slots & (XPOD_RDF_SLOT_PREDICATE | XPOD_RDF_SLOT_GRAPH)) != 0) {
      return 0;
    }
    uint32_t actual_slots = 0;
    if ((virtual_slots & XPOD_RDF_SLOT_SUBJECT) != 0) {
      actual_slots |= XPOD_RDF_SLOT_SUBJECT;
    }
    if ((virtual_slots & XPOD_RDF_SLOT_OBJECT) != 0) {
      actual_slots |= XPOD_RDF_SLOT_PREDICATE;
    }
    return actual_slots;
  }

  static xpod_rdf_status tupleValueForSlot(
      const XpodQleverDistinctTermsResult& distinct,
      size_t row,
      uint32_t actual_slots,
      uint32_t wanted_slot,
      xpod_rdf_term_key& out_value) noexcept {
    size_t column = 0;
    for (uint32_t slot : {
             XPOD_RDF_SLOT_SUBJECT,
             XPOD_RDF_SLOT_PREDICATE,
             XPOD_RDF_SLOT_OBJECT,
             XPOD_RDF_SLOT_GRAPH,
         }) {
      if ((actual_slots & slot) == 0) {
        continue;
      }
      if (slot == wanted_slot) {
        if (column >= distinct.tuple_width) {
          return XPOD_RDF_STATUS_BACKEND_ERROR;
        }
        out_value = distinct.terms[row * distinct.tuple_width + column];
        return XPOD_RDF_STATUS_OK;
      }
      ++column;
    }
    return XPOD_RDF_STATUS_UNSUPPORTED;
  }

  QleverIdTableResult scanVirtualHasPattern(
      const XpodQleverScanSpecAndBlocks& scan_spec_and_blocks) const {
    uint32_t actual_slots =
        virtualHasPatternActualSlots(scan_spec_and_blocks.needed_slots);
    const size_t result_width = countNeededSlots(scan_spec_and_blocks.needed_slots);
    if (actual_slots == 0 && scan_spec_and_blocks.needed_slots != 0) {
      return {XPOD_RDF_STATUS_UNSUPPORTED, makeQleverIdTable(result_width)};
    }
    XpodQleverDistinctTermsResult distinct_result =
        distinct(scan_spec_and_blocks, actual_slots, actual_slots);
    if (distinct_result.status != XPOD_RDF_STATUS_OK) {
      return {distinct_result.status, makeQleverIdTable(result_width)};
    }

    QleverIdRowBuffer rows;
    rows.width = static_cast<uint32_t>(result_width);
    rows.row_count = distinct_result.row_count;
    rows.rows.reserve(distinct_result.row_count * result_width);
    const char* slots = permutationSlots(permutation_);
    xpod_rdf_snapshot snapshot_value = snapshot();
    for (size_t row = 0; row < distinct_result.row_count; ++row) {
      for (const char* slot = slots; *slot != '\0'; ++slot) {
        uint32_t virtual_slot = slotMask(*slot);
        if ((scan_spec_and_blocks.needed_slots & virtual_slot) == 0) {
          continue;
        }
        uint32_t actual_slot = virtual_slot;
        if (virtual_slot == XPOD_RDF_SLOT_OBJECT) {
          actual_slot = XPOD_RDF_SLOT_PREDICATE;
        }
        xpod_rdf_term_key value = 0;
        xpod_rdf_status status = tupleValueForSlot(
            distinct_result, row, actual_slots, actual_slot, value);
        if (status != XPOD_RDF_STATUS_OK) {
          return {status, makeQleverIdTable(result_width)};
        }
        status = appendEncodedValue(
            rows, context_.backend, value, &snapshot_value, actual_slot);
        if (status != XPOD_RDF_STATUS_OK) {
          return {status, makeQleverIdTable(result_width)};
        }
      }
    }
    return {XPOD_RDF_STATUS_OK, toQleverIdTable(rows)};
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

  const PlannerRequestContext& plannerRequestContext() const noexcept {
    return context_;
  }

  XpodQleverPhysicalPermutation permutation(
      Permutation::Enum permutation) const noexcept {
    return {context_, permutation};
  }

  xpod_rdf_status indexScanConstructionCapabilityStatus(
      Permutation::Enum permutation) const noexcept {
    return this->permutation(permutation)
        .indexScanConstructionCapabilityStatus();
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

  template <typename QleverScanSpecification>
  XpodBackedScanEstimate estimateScanSpecification(
      Permutation::Enum permutation,
      const QleverScanSpecification& scan_specification,
      uint32_t needed_slots = XPOD_RDF_SLOT_SUBJECT |
                              XPOD_RDF_SLOT_PREDICATE |
                              XPOD_RDF_SLOT_OBJECT) const {
    auto physical_permutation = this->permutation(permutation);
    auto scan_spec_and_blocks = physical_permutation.getScanSpecAndBlocks(
        scan_specification, needed_slots);
    auto estimate = physical_permutation.getSizeEstimateForScan(
        scan_spec_and_blocks);
    xpod_rdf_estimate backend_estimate = {};
    backend_estimate.rows = estimate.upper;
    backend_estimate.confidence = estimate.confidence;
    return {estimate.status, backend_estimate};
  }

  template <typename QleverScanSpecification>
  QleverIdTableResult scanScanSpecification(
      Permutation::Enum permutation,
      const QleverScanSpecification& scan_specification,
      uint32_t needed_slots = XPOD_RDF_SLOT_SUBJECT |
                              XPOD_RDF_SLOT_PREDICATE |
                              XPOD_RDF_SLOT_OBJECT) const {
    auto physical_permutation = this->permutation(permutation);
    return physical_permutation.scan(
        physical_permutation.getScanSpecAndBlocks(
            scan_specification, needed_slots));
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

  xpod_rdf_status resolveRetrievalPoint(
      xpod_rdf_retrieval_point_key key,
      std::string& out_content) const {
    xpod_rdf_bytes content = {};
    xpod_rdf_status point_status = XPOD_RDF_STATUS_UNSUPPORTED;
    xpod_rdf_snapshot snapshot_value = snapshot();
    xpod_rdf_status status = context_.backend.resolveRetrievalPoints(
        &key, 1, snapshot_value, &content, &point_status);
    if (status != XPOD_RDF_STATUS_OK) {
      return status;
    }
    if (point_status != XPOD_RDF_STATUS_OK) {
      return point_status;
    }
    out_content.assign(
        content.data == nullptr ? "" : content.data, content.size);
    return XPOD_RDF_STATUS_OK;
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

  XpodQleverHistogramHintsResult histogramHints(
      TripleKeyPattern pattern,
      uint32_t slots,
      uint32_t max_buckets) const {
    XpodQleverHistogramHintsResult result = {};
    xpod_rdf_status capability_status = validateFeatureCapability(
        XPOD_RDF_BACKEND_FEATURE_HISTOGRAM_HINTS);
    if (capability_status != XPOD_RDF_STATUS_OK) {
      result.status = capability_status;
      return result;
    }

    xpod_rdf_histogram_request request = {};
    request.snapshot = snapshot();
    request.cancellation = context_.cancellation;
    request.pattern = toXpodQuadPattern(pattern);
    if (context_.request != nullptr) {
      request.graph_scope = context_.request->graph_scope;
      request.source_scope = context_.request->source_scope;
      request.access_scope = context_.request->access_scope;
    }
    request.slots = slots;
    request.max_buckets = max_buckets;

    result.status = context_.backend.histogramHints(
        request, collectHistogramHintsBatch, &result, result.stats_version);
    return result;
  }

  XpodQleverJoinFanoutEstimateResult estimateJoinFanout(
      const std::vector<TripleKeyPattern>& patterns,
      uint32_t bound_slots) const {
    std::vector<xpod_rdf_quad_pattern> request_patterns;
    request_patterns.reserve(patterns.size());
    for (const auto& pattern : patterns) {
      request_patterns.push_back(toXpodQuadPattern(pattern));
    }

    xpod_rdf_join_fanout_request request = {};
    request.snapshot = snapshot();
    request.cancellation = context_.cancellation;
    request.patterns = request_patterns.data();
    request.pattern_count = request_patterns.size();
    request.bound_slots = bound_slots;
    if (context_.request != nullptr) {
      request.graph_scope = context_.request->graph_scope;
      request.source_scope = context_.request->source_scope;
      request.access_scope = context_.request->access_scope;
    }

    XpodQleverJoinFanoutEstimateResult result = {};
    result.status = context_.backend.estimateJoinFanout(
        request, result.estimate);
    return result;
  }

  XpodQleverAccessScopeResult resolveAccessScope(
      xpod_rdf_bytes principal,
      xpod_rdf_access_mode mode) const {
    XpodQleverAccessScopeResult result = {};
    xpod_rdf_status capability_status = validateFeatureCapability(
        XPOD_RDF_BACKEND_FEATURE_ACCESS_SCOPE);
    if (capability_status != XPOD_RDF_STATUS_OK) {
      result.status = capability_status;
      return result;
    }

    result.status = context_.backend.resolveAccessScope(
        principal, mode, snapshot(), result.scope);
    return result;
  }

  XpodQleverScopeEstimateResult estimateAccessScope(
      const xpod_rdf_access_scope& access_scope,
      const xpod_rdf_source_scope& source_scope) const {
    XpodQleverScopeEstimateResult result = {};
    xpod_rdf_status capability_status = validateFeatureCapability(
        XPOD_RDF_BACKEND_FEATURE_ACCESS_SCOPE);
    if (capability_status != XPOD_RDF_STATUS_OK) {
      result.status = capability_status;
      return result;
    }

    result.status = context_.backend.estimateAccessScope(
        access_scope, source_scope, result.estimate);
    return result;
  }

  XpodQleverScopeEstimateResult estimateSourceScope(
      const xpod_rdf_source_scope& source_scope) const {
    XpodQleverScopeEstimateResult result = {};
    xpod_rdf_status capability_status = validateFeatureCapability(
        XPOD_RDF_BACKEND_FEATURE_SOURCE_SCOPE);
    if (capability_status != XPOD_RDF_STATUS_OK) {
      result.status = capability_status;
      return result;
    }

    result.status = context_.backend.estimateSourceScope(
        source_scope, snapshot(), result.estimate);
    return result;
  }

  XpodQleverResolvedSourceScopeResult resolveSourceScope(
      const xpod_rdf_source_scope& source_scope) const {
    XpodQleverResolvedSourceScopeResult result = {};
    xpod_rdf_status capability_status = validateFeatureCapability(
        XPOD_RDF_BACKEND_FEATURE_SOURCE_SCOPE);
    if (capability_status != XPOD_RDF_STATUS_OK) {
      result.status = capability_status;
      return result;
    }

    result.status = context_.backend.resolveSourceScope(
        source_scope, snapshot(), result.scope);
    return result;
  }

  XpodBackedTextSearch textSearch(
      xpod_rdf_text_search_request request,
      std::string descriptor = "XpodQleverPhysicalTextSearch") const {
    applyCandidateContext(request);
    return {context_.backend, request, std::move(descriptor)};
  }

  XpodBackedVectorSearch vectorSearch(
      xpod_rdf_vector_search_request request,
      std::string descriptor = "XpodQleverPhysicalVectorSearch") const {
    applyCandidateContext(request);
    return {context_.backend, request, std::move(descriptor)};
  }

  const PlannerRequestContext& context() const noexcept { return context_; }

  xpod_rdf_status capabilitiesStatus() const noexcept {
    return context_.capabilities_status;
  }

  const xpod_rdf_backend_capabilities& capabilities() const noexcept {
    return context_.capabilities;
  }

 private:
  xpod_rdf_status validateFeatureCapability(uint32_t feature) const noexcept {
    if (context_.capabilities_status == XPOD_RDF_STATUS_UNSUPPORTED) {
      return XPOD_RDF_STATUS_OK;
    }
    if (context_.capabilities_status != XPOD_RDF_STATUS_OK) {
      return context_.capabilities_status;
    }
    return (context_.capabilities.features & feature) != 0
               ? XPOD_RDF_STATUS_OK
               : XPOD_RDF_STATUS_UNSUPPORTED;
  }

  xpod_rdf_snapshot snapshot() const noexcept {
    return context_.request == nullptr
               ? xpod_rdf_snapshot{}
               : context_.request->snapshot;
  }

  void applyCandidateContext(xpod_rdf_text_search_request& request) const
      noexcept {
    request.snapshot = snapshot();
    request.cancellation = context_.cancellation;
    if (context_.request != nullptr) {
      request.graph_scope = context_.request->graph_scope;
      request.source_scope = context_.request->source_scope;
      request.access_scope = context_.request->access_scope;
    }
  }

  void applyCandidateContext(xpod_rdf_vector_search_request& request) const
      noexcept {
    request.snapshot = snapshot();
    request.cancellation = context_.cancellation;
    if (context_.request != nullptr) {
      request.graph_scope = context_.request->graph_scope;
      request.source_scope = context_.request->source_scope;
      request.access_scope = context_.request->access_scope;
    }
  }

  PlannerRequestContext context_;
};

}  // namespace xpod::qlever

#endif

#endif
