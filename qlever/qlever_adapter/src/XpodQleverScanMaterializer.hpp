#ifndef XPOD_QLEVER_SCAN_MATERIALIZER_HPP
#define XPOD_QLEVER_SCAN_MATERIALIZER_HPP

#include "XpodPhysicalBackend.hpp"
#include "xpod_rdf_physical_backend.h"

#include <cerrno>
#include <cstdlib>
#include <optional>
#include <string>
#include <string_view>
#include <type_traits>
#include <unordered_set>
#include <utility>
#include <vector>

#if XPOD_QLEVER_ADAPTER_ENABLE_QLEVER
#if __has_include("global/Id.h")
#include "global/Id.h"
#define XPOD_QLEVER_HAS_ID 1
#else
#define XPOD_QLEVER_HAS_ID 0
#endif
#include "index/Permutation.h"
#if __has_include("global/Constants.h") && \
    __has_include("rdfTypes/GeoPoint.h") && \
    __has_include("rdfTypes/Iri.h") && \
    __has_include("rdfTypes/Literal.h")
#include "global/Constants.h"
#include "rdfTypes/GeoPoint.h"
#include "rdfTypes/Iri.h"
#include "rdfTypes/Literal.h"
#define XPOD_QLEVER_HAS_INLINE_GEO_POINT 1
#else
#define XPOD_QLEVER_HAS_INLINE_GEO_POINT 0
#endif
#if __has_include("util/DateYearDuration.h")
#include "util/DateYearDuration.h"
#define XPOD_QLEVER_HAS_INLINE_DATE 1
#else
#define XPOD_QLEVER_HAS_INLINE_DATE 0
#endif

namespace xpod::qlever {

template <typename IdT, typename = void>
struct HasQleverMakeFromInt : std::false_type {};

template <typename IdT>
struct HasQleverMakeFromInt<
    IdT,
    std::void_t<decltype(IdT::makeFromInt(std::declval<int64_t>()))>>
    : std::true_type {};

template <typename IdT, typename = void>
struct HasQleverMakeFromDouble : std::false_type {};

template <typename IdT>
struct HasQleverMakeFromDouble<
    IdT,
    std::void_t<decltype(IdT::makeFromDouble(std::declval<double>()))>>
    : std::true_type {};

template <typename IdT, typename = void>
struct HasQleverMakeFromBool : std::false_type {};

template <typename IdT>
struct HasQleverMakeFromBool<
    IdT,
    std::void_t<decltype(IdT::makeFromBool(std::declval<bool>()))>>
    : std::true_type {};

template <typename IdT>
std::optional<uint64_t> qleverInlineIntBits(int64_t value) {
  if constexpr (HasQleverMakeFromInt<IdT>::value) {
    return IdT::makeFromInt(value).getBits();
  }
  return std::nullopt;
}

template <typename IdT>
std::optional<uint64_t> qleverInlineDoubleBits(double value) {
  if constexpr (HasQleverMakeFromDouble<IdT>::value) {
    return IdT::makeFromDouble(value).getBits();
  }
  return std::nullopt;
}

template <typename IdT>
std::optional<uint64_t> qleverInlineBoolBits(bool value) {
  if constexpr (HasQleverMakeFromBool<IdT>::value) {
    return IdT::makeFromBool(value).getBits();
  }
  return std::nullopt;
}

struct ScanRowBuffer {
  uint32_t width = 3;
  size_t row_count = 0;
  std::vector<xpod_rdf_term_key> rows;
};

struct QleverIdRowBuffer {
  uint32_t width = 3;
  size_t row_count = 0;
  std::vector<uint64_t> rows;
};

inline std::string_view materializerBytesView(xpod_rdf_bytes bytes) noexcept {
  if (bytes.data == nullptr || bytes.size == 0) {
    return {};
  }
  return {bytes.data, bytes.size};
}

inline bool parseInt64Literal(std::string_view value, int64_t& out) {
  std::string text(value);
  char* end = nullptr;
  errno = 0;
  long long parsed = std::strtoll(text.c_str(), &end, 10);
  if (errno != 0 || end != text.c_str() + text.size()) {
    return false;
  }
  out = static_cast<int64_t>(parsed);
  return true;
}

inline bool parseDoubleLiteral(std::string_view value, double& out) {
  std::string text(value);
  char* end = nullptr;
  errno = 0;
  double parsed = std::strtod(text.c_str(), &end);
  if (errno != 0 || end != text.c_str() + text.size()) {
    return false;
  }
  out = parsed;
  return true;
}

inline std::optional<uint64_t> inlineTypedLiteralBits(
    const xpod_rdf_term& term) {
#if !XPOD_QLEVER_HAS_ID
  static_cast<void>(term);
  return std::nullopt;
#else
  if (term.kind != XPOD_RDF_TERM_LITERAL) {
    return std::nullopt;
  }
  constexpr std::string_view xsd =
      "http://www.w3.org/2001/XMLSchema#";
  constexpr std::string_view boolean_datatype =
      "http://www.w3.org/2001/XMLSchema#boolean";
  const std::string_view value = materializerBytesView(term.value);
  const std::string_view datatype = materializerBytesView(term.datatype_iri);
  const std::string_view local_datatype =
      datatype.size() >= xsd.size() && datatype.substr(0, xsd.size()) == xsd
          ? datatype.substr(xsd.size())
          : std::string_view{};
  const bool is_integer =
      local_datatype == "int" || local_datatype == "integer" ||
      local_datatype == "nonPositiveInteger" ||
      local_datatype == "negativeInteger" || local_datatype == "long" ||
      local_datatype == "short" || local_datatype == "byte" ||
      local_datatype == "nonNegativeInteger" ||
      local_datatype == "unsignedLong" ||
      local_datatype == "unsignedInt" ||
      local_datatype == "unsignedShort" ||
      local_datatype == "positiveInteger";
  if (is_integer) {
    int64_t parsed = 0;
    if (!parseInt64Literal(value, parsed)) {
      return std::nullopt;
    }
    return qleverInlineIntBits<Id>(parsed);
  }
  if (local_datatype == "decimal" || local_datatype == "double" ||
      local_datatype == "float") {
    double parsed = 0;
    if (!parseDoubleLiteral(value, parsed)) {
      return std::nullopt;
    }
    return qleverInlineDoubleBits<Id>(parsed);
  }
  if (datatype == boolean_datatype) {
    if (value == "true" || value == "1") {
      return qleverInlineBoolBits<Id>(true);
    }
    if (value == "false" || value == "0") {
      return qleverInlineBoolBits<Id>(false);
    }
  }
#if XPOD_QLEVER_HAS_INLINE_GEO_POINT
  if (datatype == GEO_WKT_LITERAL) {
    try {
      using ad_utility::triple_component::Iri;
      using ad_utility::triple_component::Literal;
      auto literal = Literal::literalWithoutQuotes(value);
      literal.addDatatype(Iri::fromIrirefWithoutBrackets(GEO_WKT_LITERAL));
      if (auto point = GeoPoint::parseFromLiteral(literal);
          point.has_value()) {
        return Id::makeFromGeoPoint(*point).getBits();
      }
    } catch (...) {
      return std::nullopt;
    }
  }
#endif
#if XPOD_QLEVER_HAS_INLINE_DATE
  if (local_datatype == "date") {
    if (auto parsed = DateYearOrDuration::parseXsdDateGetOptDate(value);
        parsed.has_value()) {
      return Id::makeFromDate(*parsed).getBits();
    }
  }
  if (local_datatype == "dateTime") {
    if (auto parsed = DateYearOrDuration::parseXsdDatetimeGetOptDate(value);
        parsed.has_value()) {
      return Id::makeFromDate(*parsed).getBits();
    }
  }
#endif
  return std::nullopt;
#endif
}

#if XPOD_QLEVER_HAS_INLINE_DATE && !defined(QLEVER_REDUCED_FEATURE_SET_FOR_CPP17)
inline std::optional<DateYearOrDuration> normalizeDateForComparison(
    DateYearOrDuration value) {
  if (!value.isDate()) {
    return value;
  }
  auto epoch = value.getDateUnchecked().toEpoch();
  if (!epoch.has_value()) {
    return std::nullopt;
  }
  return DateYearOrDuration::makeFromEpoch(*epoch, Date::TimeZoneZ{});
}
#endif

#if XPOD_QLEVER_HAS_ID
inline std::optional<Id> normalizeInlineIdForComparison(Id id) {
#if XPOD_QLEVER_HAS_INLINE_DATE && !defined(QLEVER_REDUCED_FEATURE_SET_FOR_CPP17)
  if (id.getDatatype() == Datatype::Date) {
    auto normalized = normalizeDateForComparison(id.getDate());
    if (!normalized.has_value()) {
      return std::nullopt;
    }
    return Id::makeFromDate(*normalized);
  }
#endif
  return id;
}
#endif

inline std::optional<uint64_t> inlineTypedLiteralComparisonBits(
    const xpod_rdf_term& term) {
#if !XPOD_QLEVER_HAS_ID
  static_cast<void>(term);
  return std::nullopt;
#else
  auto bits = inlineTypedLiteralBits(term);
  if (!bits.has_value()) {
    return std::nullopt;
  }
  auto normalized = normalizeInlineIdForComparison(Id::fromBits(*bits));
  if (!normalized.has_value()) {
    return std::nullopt;
  }
  return normalized->getBits();
#endif
}

inline xpod_rdf_status encodePhysicalTermAsQleverId(
    const xpod::rdf::PhysicalBackend& backend,
    xpod_rdf_term_key term,
    const xpod_rdf_snapshot* snapshot,
    uint64_t& out_bits) {
  static_cast<void>(snapshot);
  return backend.encodeQleverId(term, out_bits);
}

inline xpod_rdf_term_key slotValue(
    const xpod_rdf_quad_key& row,
    char slot) noexcept {
  switch (slot) {
    case 'S':
      return row.subject;
    case 'P':
      return row.predicate;
    case 'O':
      return row.object;
    case 'G':
      return row.graph;
    default:
      return 0;
  }
}

inline const char* permutationSlots(Permutation::Enum permutation) noexcept {
  switch (permutation) {
    case Permutation::Enum::PSO:
      return "PSOG";
    case Permutation::Enum::POS:
      return "POSG";
    case Permutation::Enum::SPO:
      return "SPOG";
    case Permutation::Enum::SOP:
      return "SOPG";
    case Permutation::Enum::OPS:
      return "OPSG";
    case Permutation::Enum::OSP:
      return "OSPG";
  }
  return "SPOG";
}

inline uint32_t slotMask(char slot) noexcept {
  switch (slot) {
    case 'S':
      return XPOD_RDF_SLOT_SUBJECT;
    case 'P':
      return XPOD_RDF_SLOT_PREDICATE;
    case 'O':
      return XPOD_RDF_SLOT_OBJECT;
    case 'G':
      return XPOD_RDF_SLOT_GRAPH;
    default:
      return 0;
  }
}

inline uint32_t normalizeNeededSlots(uint32_t needed_slots) noexcept {
  return needed_slots;
}

inline uint32_t countNeededSlots(uint32_t needed_slots) noexcept {
  uint32_t normalized = normalizeNeededSlots(needed_slots);
  uint32_t count = 0;
  for (uint32_t slot : {
           XPOD_RDF_SLOT_SUBJECT,
           XPOD_RDF_SLOT_PREDICATE,
           XPOD_RDF_SLOT_OBJECT,
           XPOD_RDF_SLOT_GRAPH,
       }) {
    if ((normalized & slot) != 0) {
      ++count;
    }
  }
  return count;
}

inline void appendBatch(
    ScanRowBuffer& buffer,
    Permutation::Enum permutation,
    uint32_t needed_slots,
    const xpod_rdf_quad_batch& batch) {
  const char* slots = permutationSlots(permutation);
  uint32_t normalized_needed_slots = normalizeNeededSlots(needed_slots);
  buffer.width = countNeededSlots(normalized_needed_slots);
  buffer.row_count += batch.row_count;
  buffer.rows.reserve(buffer.rows.size() + batch.row_count * buffer.width);
  for (size_t i = 0; i < batch.row_count; ++i) {
    const xpod_rdf_quad_key& row = batch.rows[i];
    for (const char* slot = slots; *slot != '\0'; ++slot) {
      if ((normalized_needed_slots & slotMask(*slot)) == 0) {
        continue;
      }
      buffer.rows.push_back(slotValue(row, *slot));
    }
  }
}

inline void appendBatch(
    ScanRowBuffer& buffer,
    Permutation::Enum permutation,
    const xpod_rdf_quad_batch& batch) {
  appendBatch(
      buffer, permutation,
      XPOD_RDF_SLOT_SUBJECT | XPOD_RDF_SLOT_PREDICATE |
          XPOD_RDF_SLOT_OBJECT,
      batch);
}

inline xpod_rdf_status encodePhysicalValueAsQleverId(
    const xpod::rdf::PhysicalBackend& backend,
    xpod_rdf_term_key term,
    uint64_t& bits,
    const xpod_rdf_snapshot* snapshot = nullptr,
    uint32_t slot = 0) {
  if (slot == XPOD_RDF_SLOT_OBJECT) {
    return encodePhysicalTermAsQleverId(backend, term, snapshot, bits);
  }
  return backend.encodeQleverId(term, bits);
}

inline xpod_rdf_status preloadPhysicalTermsForBatch(
    const xpod::rdf::PhysicalBackend& backend,
    Permutation::Enum permutation,
    uint32_t needed_slots,
    const xpod_rdf_quad_batch& batch,
    const xpod_rdf_snapshot* snapshot = nullptr) {
  const char* slots = permutationSlots(permutation);
  const uint32_t normalized_needed_slots = normalizeNeededSlots(needed_slots);
  std::unordered_set<xpod_rdf_term_key> seen;
  std::vector<xpod_rdf_term_key> keys;
  keys.reserve(batch.row_count * countNeededSlots(normalized_needed_slots));
  for (size_t row = 0; row < batch.row_count; ++row) {
    for (const char* slot = slots; *slot != '\0'; ++slot) {
      if ((normalized_needed_slots & slotMask(*slot)) == 0) {
        continue;
      }
      const xpod_rdf_term_key key = slotValue(batch.rows[row], *slot);
      if (seen.insert(key).second) {
        keys.push_back(key);
      }
    }
  }
  if (keys.empty()) {
    return XPOD_RDF_STATUS_OK;
  }
  const xpod_rdf_snapshot empty_snapshot = {};
  const xpod_rdf_snapshot& effective_snapshot =
      snapshot == nullptr ? empty_snapshot : *snapshot;
  const xpod_rdf_status prefetch_status = backend.prefetchQleverIds(
      keys.data(), keys.size(), effective_snapshot);
  if (prefetch_status == XPOD_RDF_STATUS_OK) {
    return XPOD_RDF_STATUS_OK;
  }
  if (prefetch_status != XPOD_RDF_STATUS_UNSUPPORTED) {
    return prefetch_status;
  }
  std::vector<xpod_rdf_term> terms(keys.size());
  std::vector<xpod_rdf_status> statuses(keys.size());
  const xpod_rdf_status status = backend.resolveTerms(
      keys.data(), keys.size(), effective_snapshot,
      terms.data(), statuses.data());
  if (status == XPOD_RDF_STATUS_UNSUPPORTED) {
    return XPOD_RDF_STATUS_OK;
  }
  if (status != XPOD_RDF_STATUS_OK) {
    return status;
  }
  for (const xpod_rdf_status term_status : statuses) {
    if (term_status != XPOD_RDF_STATUS_OK) {
      return term_status;
    }
  }
  return XPOD_RDF_STATUS_OK;
}

inline xpod_rdf_status appendEncodedValue(
    QleverIdRowBuffer& buffer,
    const xpod::rdf::PhysicalBackend& backend,
    xpod_rdf_term_key term,
    const xpod_rdf_snapshot* snapshot = nullptr,
    uint32_t slot = 0) {
  uint64_t bits = 0;
  xpod_rdf_status status = encodePhysicalValueAsQleverId(
      backend, term, bits, snapshot, slot);
  if (status != XPOD_RDF_STATUS_OK) {
    return status;
  }
  buffer.rows.push_back(bits);
  return XPOD_RDF_STATUS_OK;
}

inline xpod_rdf_status appendEncodedBatch(
    QleverIdRowBuffer& buffer,
    const xpod::rdf::PhysicalBackend& backend,
    Permutation::Enum permutation,
    uint32_t needed_slots,
    const xpod_rdf_quad_batch& batch,
    const xpod_rdf_snapshot* snapshot = nullptr) {
  const char* slots = permutationSlots(permutation);
  const uint32_t normalized_needed_slots = normalizeNeededSlots(needed_slots);
  const uint32_t width = countNeededSlots(normalized_needed_slots);
  if (width != 0) {
    std::vector<xpod_rdf_term_key> terms;
    terms.reserve(batch.row_count * width);
    for (size_t row = 0; row < batch.row_count; ++row) {
      for (const char* slot = slots; *slot != '\0'; ++slot) {
        if ((normalized_needed_slots & slotMask(*slot)) != 0) {
          terms.push_back(slotValue(batch.rows[row], *slot));
        }
      }
    }
    std::vector<uint64_t> encoded(terms.size());
    const xpod_rdf_snapshot empty_snapshot = {};
    const xpod_rdf_status batch_status = backend.encodeQleverIds(
        terms.data(), terms.size(),
        snapshot == nullptr ? empty_snapshot : *snapshot, encoded.data());
    if (batch_status == XPOD_RDF_STATUS_OK) {
      buffer.width = width;
      buffer.row_count += batch.row_count;
      buffer.rows.insert(buffer.rows.end(), encoded.begin(), encoded.end());
      return XPOD_RDF_STATUS_OK;
    }
    if (batch_status != XPOD_RDF_STATUS_UNSUPPORTED) {
      return batch_status;
    }
  }
  const xpod_rdf_status preload_status = preloadPhysicalTermsForBatch(
      backend, permutation, needed_slots, batch, snapshot);
  if (preload_status != XPOD_RDF_STATUS_OK) {
    return preload_status;
  }
  buffer.width = countNeededSlots(normalized_needed_slots);
  buffer.row_count += batch.row_count;
  buffer.rows.reserve(buffer.rows.size() + batch.row_count * buffer.width);
  for (size_t i = 0; i < batch.row_count; ++i) {
    const xpod_rdf_quad_key& row = batch.rows[i];
    for (const char* slot = slots; *slot != '\0'; ++slot) {
      if ((normalized_needed_slots & slotMask(*slot)) == 0) {
        continue;
      }
      xpod_rdf_status status =
          appendEncodedValue(
              buffer, backend, slotValue(row, *slot), snapshot,
              slotMask(*slot));
      if (status != XPOD_RDF_STATUS_OK) {
        return status;
      }
    }
  }
  return XPOD_RDF_STATUS_OK;
}

inline xpod_rdf_status appendEncodedBatch(
    QleverIdRowBuffer& buffer,
    const xpod::rdf::PhysicalBackend& backend,
    Permutation::Enum permutation,
    const xpod_rdf_quad_batch& batch,
    const xpod_rdf_snapshot* snapshot = nullptr) {
  return appendEncodedBatch(
      buffer, backend, permutation,
      XPOD_RDF_SLOT_SUBJECT | XPOD_RDF_SLOT_PREDICATE |
          XPOD_RDF_SLOT_OBJECT,
      batch, snapshot);
}

}  // namespace xpod::qlever
#endif

#endif
