#ifndef XPOD_NUMERIC_LITERAL_COMPARE_HPP
#define XPOD_NUMERIC_LITERAL_COMPARE_HPP

#include <algorithm>
#include <cerrno>
#include <cctype>
#include <cmath>
#include <cstdlib>
#include <limits>
#include <string>
#include <string_view>
#include <utility>

namespace xpod::qlever::numeric_literal {

struct CompareResult {
  bool applicable = false;
  int compare = 0;
};

namespace detail {

enum class XsdNumericKind {
  kNone,
  kInteger,
  kDecimal,
  kFloating,
};

enum class NumericCategory {
  kInvalid,
  kValid,
  kNaN,
};

struct NormalizedDecimal {
  bool negative = false;
  std::string whole = "0";
  std::string fractional;
};

struct ParsedNumericLiteral {
  NumericCategory category = NumericCategory::kInvalid;
  NormalizedDecimal exact;
  long double floating = 0;
};

inline int compareStrings(std::string_view left, std::string_view right) {
  if (left < right) {
    return -1;
  }
  if (right < left) {
    return 1;
  }
  return 0;
}

inline std::string_view xsdDatatypeLocalName(std::string_view datatype) {
  constexpr std::string_view xsd = "http://www.w3.org/2001/XMLSchema#";
  if (datatype.compare(0, xsd.size(), xsd) != 0) {
    return {};
  }
  return datatype.substr(xsd.size());
}

inline XsdNumericKind xsdNumericKind(std::string_view datatype) {
  const std::string_view local = xsdDatatypeLocalName(datatype);
  if (local.empty()) {
    return XsdNumericKind::kNone;
  }
  if (local == "double" || local == "float") {
    return XsdNumericKind::kFloating;
  }
  if (local == "decimal") {
    return XsdNumericKind::kDecimal;
  }
  if (local == "integer" || local == "nonPositiveInteger" ||
      local == "negativeInteger" || local == "long" || local == "int" ||
      local == "short" || local == "byte" ||
      local == "nonNegativeInteger" || local == "unsignedLong" ||
      local == "unsignedInt" || local == "unsignedShort" ||
      local == "unsignedByte" || local == "positiveInteger") {
    return XsdNumericKind::kInteger;
  }
  return XsdNumericKind::kNone;
}

inline int numericCategoryRank(NumericCategory category) {
  switch (category) {
    case NumericCategory::kInvalid:
      return 1;
    case NumericCategory::kValid:
      return 2;
    case NumericCategory::kNaN:
      return 3;
  }
  return 4;
}

inline int compareNormalizedDecimals(
    const NormalizedDecimal& left,
    const NormalizedDecimal& right) {
  const bool left_zero = left.whole == "0" && left.fractional.empty();
  const bool right_zero = right.whole == "0" && right.fractional.empty();
  if (left_zero && right_zero) {
    return 0;
  }
  if (left.negative != right.negative) {
    return left.negative ? -1 : 1;
  }
  int magnitude = 0;
  if (left.whole.size() != right.whole.size()) {
    magnitude = left.whole.size() < right.whole.size() ? -1 : 1;
  } else if (const int whole = compareStrings(left.whole, right.whole);
             whole != 0) {
    magnitude = whole;
  } else {
    const size_t width =
        std::max(left.fractional.size(), right.fractional.size());
    for (size_t index = 0; index < width; ++index) {
      const char left_digit =
          index < left.fractional.size() ? left.fractional[index] : '0';
      const char right_digit =
          index < right.fractional.size() ? right.fractional[index] : '0';
      if (left_digit != right_digit) {
        magnitude = left_digit < right_digit ? -1 : 1;
        break;
      }
    }
  }
  return left.negative ? -magnitude : magnitude;
}

inline bool normalizeIntegerLexical(
    std::string_view value,
    NormalizedDecimal& out_value) {
  if (value.empty()) {
    return false;
  }
  size_t cursor = 0;
  bool negative = false;
  if (value[cursor] == '+' || value[cursor] == '-') {
    negative = value[cursor] == '-';
    ++cursor;
  }
  if (cursor == value.size()) {
    return false;
  }
  for (size_t index = cursor; index < value.size(); ++index) {
    if (!std::isdigit(static_cast<unsigned char>(value[index]))) {
      return false;
    }
  }
  size_t first_non_zero = cursor;
  while (first_non_zero < value.size() && value[first_non_zero] == '0') {
    ++first_non_zero;
  }
  out_value.whole = first_non_zero == value.size()
                        ? "0"
                        : std::string(value.substr(first_non_zero));
  out_value.fractional.clear();
  out_value.negative = negative && out_value.whole != "0";
  return true;
}

inline bool normalizedIntegerInRange(
    const NormalizedDecimal& value,
    const char* minimum,
    const char* maximum) {
  NormalizedDecimal min_value;
  NormalizedDecimal max_value;
  return normalizeIntegerLexical(minimum, min_value) &&
         normalizeIntegerLexical(maximum, max_value) &&
         compareNormalizedDecimals(value, min_value) >= 0 &&
         compareNormalizedDecimals(value, max_value) <= 0;
}

inline bool normalizedIntegerSatisfiesDatatype(
    const NormalizedDecimal& value,
    std::string_view local) {
  const bool zero = value.whole == "0" && value.fractional.empty();
  if (local == "integer") {
    return true;
  }
  if (local == "nonPositiveInteger") {
    return value.negative || zero;
  }
  if (local == "negativeInteger") {
    return value.negative && !zero;
  }
  if (local == "nonNegativeInteger") {
    return !value.negative;
  }
  if (local == "positiveInteger") {
    return !value.negative && !zero;
  }
  if (local == "long") {
    return normalizedIntegerInRange(
        value, "-9223372036854775808", "9223372036854775807");
  }
  if (local == "int") {
    return normalizedIntegerInRange(value, "-2147483648", "2147483647");
  }
  if (local == "short") {
    return normalizedIntegerInRange(value, "-32768", "32767");
  }
  if (local == "byte") {
    return normalizedIntegerInRange(value, "-128", "127");
  }
  if (local == "unsignedLong") {
    return normalizedIntegerInRange(value, "0", "18446744073709551615");
  }
  if (local == "unsignedInt") {
    return normalizedIntegerInRange(value, "0", "4294967295");
  }
  if (local == "unsignedShort") {
    return normalizedIntegerInRange(value, "0", "65535");
  }
  if (local == "unsignedByte") {
    return normalizedIntegerInRange(value, "0", "255");
  }
  return false;
}

inline bool normalizeIntegerLiteral(
    std::string_view value,
    std::string_view datatype,
    NormalizedDecimal& out_value) {
  return normalizeIntegerLexical(value, out_value) &&
         normalizedIntegerSatisfiesDatatype(
             out_value, xsdDatatypeLocalName(datatype));
}

inline bool normalizeDecimalLiteral(
    std::string_view value,
    NormalizedDecimal& out_value) {
  if (value.empty()) {
    return false;
  }
  size_t cursor = 0;
  bool negative = false;
  if (value[cursor] == '+' || value[cursor] == '-') {
    negative = value[cursor] == '-';
    ++cursor;
  }
  if (cursor == value.size()) {
    return false;
  }
  std::string whole;
  std::string fractional;
  bool seen_dot = false;
  bool seen_digit = false;
  for (; cursor < value.size(); ++cursor) {
    const char character = value[cursor];
    if (character == '.') {
      if (seen_dot) {
        return false;
      }
      seen_dot = true;
      continue;
    }
    if (!std::isdigit(static_cast<unsigned char>(character))) {
      return false;
    }
    seen_digit = true;
    if (seen_dot) {
      fractional.push_back(character);
    } else {
      whole.push_back(character);
    }
  }
  if (!seen_digit) {
    return false;
  }
  size_t whole_cursor = 0;
  while (whole_cursor < whole.size() && whole[whole_cursor] == '0') {
    ++whole_cursor;
  }
  out_value.whole =
      whole_cursor == whole.size() ? "0" : whole.substr(whole_cursor);
  while (!fractional.empty() && fractional.back() == '0') {
    fractional.pop_back();
  }
  out_value.fractional = std::move(fractional);
  out_value.negative =
      negative && !(out_value.whole == "0" && out_value.fractional.empty());
  return true;
}

inline bool isFloatLexical(std::string_view value) {
  if (value.empty() || value == "+" || value == "-") {
    return false;
  }
  size_t cursor = 0;
  if (value[cursor] == '+' || value[cursor] == '-') {
    ++cursor;
  }
  bool seen_digit = false;
  bool seen_dot = false;
  for (; cursor < value.size(); ++cursor) {
    const char character = value[cursor];
    if (std::isdigit(static_cast<unsigned char>(character))) {
      seen_digit = true;
      continue;
    }
    if (character == '.') {
      if (seen_dot) {
        return false;
      }
      seen_dot = true;
      continue;
    }
    break;
  }
  if (!seen_digit) {
    return false;
  }
  if (cursor == value.size()) {
    return true;
  }
  if (value[cursor] != 'e' && value[cursor] != 'E') {
    return false;
  }
  ++cursor;
  if (cursor < value.size() && (value[cursor] == '+' || value[cursor] == '-')) {
    ++cursor;
  }
  const size_t exponent_start = cursor;
  for (; cursor < value.size(); ++cursor) {
    if (!std::isdigit(static_cast<unsigned char>(value[cursor]))) {
      return false;
    }
  }
  return cursor != exponent_start;
}

inline bool parseXsdFloatingLiteral(
    std::string_view value,
    long double& out_value) {
  if (value == "INF") {
    out_value = std::numeric_limits<long double>::infinity();
    return true;
  }
  if (value == "-INF") {
    out_value = -std::numeric_limits<long double>::infinity();
    return true;
  }
  if (value == "NaN") {
    out_value = std::numeric_limits<long double>::quiet_NaN();
    return true;
  }
  if (!isFloatLexical(value)) {
    return false;
  }
  const std::string storage(value);
  errno = 0;
  char* end = nullptr;
  const long double parsed = std::strtold(storage.c_str(), &end);
  if (end != storage.c_str() + storage.size() || errno == ERANGE) {
    return false;
  }
  out_value = parsed;
  return true;
}

inline bool parseNumericAsFloating(
    XsdNumericKind kind,
    std::string_view value,
    long double& out_value) {
  if (kind == XsdNumericKind::kFloating) {
    return parseXsdFloatingLiteral(value, out_value);
  }
  NormalizedDecimal normalized;
  const bool valid = kind == XsdNumericKind::kInteger
                         ? normalizeIntegerLexical(value, normalized)
                         : normalizeDecimalLiteral(value, normalized);
  if (!valid) {
    return false;
  }
  const std::string storage(value);
  errno = 0;
  char* end = nullptr;
  const long double parsed = std::strtold(storage.c_str(), &end);
  if (end != storage.c_str() + storage.size()) {
    return false;
  }
  out_value = parsed;
  return true;
}

inline ParsedNumericLiteral parseNumericLiteral(
    std::string_view value,
    std::string_view datatype,
    XsdNumericKind kind) {
  ParsedNumericLiteral parsed;
  if (kind == XsdNumericKind::kInteger) {
    if (normalizeIntegerLiteral(value, datatype, parsed.exact)) {
      parsed.category = NumericCategory::kValid;
    }
    return parsed;
  }
  if (kind == XsdNumericKind::kDecimal) {
    if (normalizeDecimalLiteral(value, parsed.exact)) {
      parsed.category = NumericCategory::kValid;
    }
    return parsed;
  }
  if (kind == XsdNumericKind::kFloating) {
    if (!parseXsdFloatingLiteral(value, parsed.floating)) {
      return parsed;
    }
    parsed.category = std::isnan(parsed.floating) ? NumericCategory::kNaN
                                                  : NumericCategory::kValid;
    return parsed;
  }
  return parsed;
}

}  // namespace detail

inline bool isNaN(std::string_view value, std::string_view datatype) {
  const detail::XsdNumericKind kind = detail::xsdNumericKind(datatype);
  if (kind != detail::XsdNumericKind::kFloating) {
    return false;
  }
  return detail::parseNumericLiteral(value, datatype, kind).category ==
         detail::NumericCategory::kNaN;
}

inline CompareResult compare(
    std::string_view left_value,
    std::string_view left_datatype,
    std::string_view right_value,
    std::string_view right_datatype) {
  const detail::XsdNumericKind left_kind =
      detail::xsdNumericKind(left_datatype);
  const detail::XsdNumericKind right_kind =
      detail::xsdNumericKind(right_datatype);
  if (left_kind == detail::XsdNumericKind::kNone ||
      right_kind == detail::XsdNumericKind::kNone) {
    return {};
  }
  const detail::ParsedNumericLiteral left =
      detail::parseNumericLiteral(left_value, left_datatype, left_kind);
  const detail::ParsedNumericLiteral right =
      detail::parseNumericLiteral(right_value, right_datatype, right_kind);
  if (left.category != right.category) {
    return {
        true,
        detail::numericCategoryRank(left.category) <
                detail::numericCategoryRank(right.category)
            ? -1
            : 1};
  }
  if (left.category == detail::NumericCategory::kInvalid) {
    return {};
  }
  if (left.category == detail::NumericCategory::kNaN) {
    return {true, 0};
  }
  if (left_kind != detail::XsdNumericKind::kFloating &&
      right_kind != detail::XsdNumericKind::kFloating) {
    return {true, detail::compareNormalizedDecimals(left.exact, right.exact)};
  }
  long double left_number = 0;
  long double right_number = 0;
  if (!detail::parseNumericAsFloating(left_kind, left_value, left_number) ||
      !detail::parseNumericAsFloating(right_kind, right_value, right_number)) {
    return {};
  }
  if (std::isnan(left_number) || std::isnan(right_number)) {
    return {true, 0};
  }
  if (left_number < right_number) {
    return {true, -1};
  }
  if (right_number < left_number) {
    return {true, 1};
  }
  return {true, 0};
}

}  // namespace xpod::qlever::numeric_literal

#endif  // XPOD_NUMERIC_LITERAL_COMPARE_HPP
