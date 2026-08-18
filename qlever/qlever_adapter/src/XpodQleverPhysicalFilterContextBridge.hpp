#ifndef XPOD_QLEVER_PHYSICAL_FILTER_CONTEXT_BRIDGE_HPP
#define XPOD_QLEVER_PHYSICAL_FILTER_CONTEXT_BRIDGE_HPP

#include "XpodQleverPhysicalIndexScanContextBridge.hpp"
#include "XpodQleverNumericLiteralCompare.hpp"
#include "XpodQleverResultBridge.hpp"
#include "xpod_rdf_physical_backend.h"

#include <algorithm>
#include <cctype>
#include <optional>
#include <string>
#include <string_view>
#include <utility>
#include <vector>

#if XPOD_QLEVER_ADAPTER_ENABLE_QLEVER
#include "engine/QueryExecutionContext.h"
#include "engine/Result.h"
#include "engine/VariableToColumnMap.h"
#include "engine/sparqlExpressions/SparqlExpression.h"
#if __has_include("global/ValueId.h")
#include "global/ValueId.h"
#define XPOD_QLEVER_PHYSICAL_FILTER_HAS_VALUE_ID_DATATYPE 1
#else
#define XPOD_QLEVER_PHYSICAL_FILTER_HAS_VALUE_ID_DATATYPE 0
#endif
#include "rdfTypes/Variable.h"

namespace xpod::qlever {

struct XpodQleverPhysicalFilterResult {
  xpod_rdf_status status;
  Result result;
};

struct XpodQleverBoundedFilterTerm {
  xpod_rdf_term term = {};
  std::string value;
  std::string datatype_iri;
  std::string language;

  void refreshViews() noexcept {
    term.value = {value.data(), value.size()};
    term.datatype_iri = {datatype_iri.data(), datatype_iri.size()};
    term.language = {language.data(), language.size()};
  }
};

enum class XpodQleverPhysicalFilterKind {
  TermMembership,
  StringPredicate,
  MetadataPredicate,
};

enum class XpodQleverStringFilterKind {
  Prefix,
  Contains,
  Suffix,
  Equals,
};

enum class XpodQleverStringValueTransform {
  None,
  Lowercase,
  Uppercase,
};

struct XpodQleverBoundedFilterExpression {
  XpodQleverPhysicalFilterKind kind =
      XpodQleverPhysicalFilterKind::TermMembership;
  bool equals = true;
  ColumnIndex column = 0;
  std::vector<XpodQleverBoundedFilterTerm> terms;
  XpodQleverStringFilterKind string_filter =
      XpodQleverStringFilterKind::Prefix;
  std::string string_prefix;
  XpodQleverStringValueTransform string_value_transform =
      XpodQleverStringValueTransform::None;
  xpod_rdf_scan_filter_kind metadata_filter =
      XPOD_RDF_SCAN_FILTER_LANGUAGE_EQUAL;
};

inline XpodQleverPhysicalFilterResult unsupportedPhysicalFilterResult(
    QueryExecutionContext& context) {
  return {
      XPOD_RDF_STATUS_UNSUPPORTED,
      Result{IdTable{0, context.getAllocator()}, {}, LocalVocab{}}};
}

inline std::string_view trimPhysicalFilterToken(
    std::string_view token) noexcept {
  while (!token.empty() &&
         std::isspace(static_cast<unsigned char>(token.front()))) {
    token.remove_prefix(1);
  }
  while (!token.empty() &&
         std::isspace(static_cast<unsigned char>(token.back()))) {
    token.remove_suffix(1);
  }
  return token;
}

inline std::string_view stripPhysicalFilterParens(
    std::string_view expression) noexcept {
  expression = trimPhysicalFilterToken(expression);
  if (expression.size() >= 2 && expression.front() == '(' &&
      expression.back() == ')') {
    return trimPhysicalFilterToken(expression.substr(1, expression.size() - 2));
  }
  return expression;
}

inline std::optional<XpodQleverBoundedFilterTerm> physicalIriTermFromToken(
    std::string_view token) {
  token = trimPhysicalFilterToken(token);
  if (token.size() < 3 || token.front() != '<' || token.back() != '>') {
    return std::nullopt;
  }
  XpodQleverBoundedFilterTerm term;
  term.term.kind = XPOD_RDF_TERM_IRI;
  term.value = std::string(token.substr(1, token.size() - 2));
  term.refreshViews();
  return term;
}

inline std::optional<XpodQleverBoundedFilterTerm> physicalLiteralTermFromToken(
    std::string_view token) {
  token = trimPhysicalFilterToken(token);
  if (token.empty() || token.front() != '"') {
    return std::nullopt;
  }

  size_t end = 1;
  bool escaped = false;
  for (; end < token.size(); ++end) {
    char c = token[end];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (c == '\\') {
      escaped = true;
      continue;
    }
    if (c == '"') {
      break;
    }
  }
  if (end >= token.size()) {
    return std::nullopt;
  }

  XpodQleverBoundedFilterTerm term;
  term.term.kind = XPOD_RDF_TERM_LITERAL;
  term.value = std::string(token.substr(1, end - 1));
  std::string_view suffix(token.data() + end + 1, token.size() - end - 1);
  if (!suffix.empty() && suffix.front() == '@') {
    term.language = std::string(suffix.substr(1));
  } else if (suffix.size() >= 4 && suffix.substr(0, 3) == "^^<" &&
             suffix.back() == '>') {
    term.datatype_iri = std::string(suffix.substr(3, suffix.size() - 4));
  } else if (!suffix.empty()) {
    return std::nullopt;
  }
  term.refreshViews();
  return term;
}

inline bool physicalFilterIsDigit(char value) noexcept {
  return value >= '0' && value <= '9';
}

inline std::optional<XpodQleverBoundedFilterTerm>
physicalInlineTypedLiteralTermFromToken(std::string_view token) {
  token = trimPhysicalFilterToken(token);
  if (token == "true" || token == "false") {
    XpodQleverBoundedFilterTerm term;
    term.term.kind = XPOD_RDF_TERM_LITERAL;
    term.value = std::string(token);
    term.datatype_iri = "http://www.w3.org/2001/XMLSchema#boolean";
    term.refreshViews();
    return term;
  }

  size_t index = 0;
  if (index < token.size() && (token[index] == '+' || token[index] == '-')) {
    ++index;
  }

  bool saw_digit = false;
  while (index < token.size() && physicalFilterIsDigit(token[index])) {
    saw_digit = true;
    ++index;
  }

  bool is_double = false;
  if (index < token.size() && token[index] == '.') {
    is_double = true;
    ++index;
    while (index < token.size() && physicalFilterIsDigit(token[index])) {
      saw_digit = true;
      ++index;
    }
  }

  if (index < token.size() && (token[index] == 'e' || token[index] == 'E')) {
    is_double = true;
    ++index;
    if (index < token.size() && (token[index] == '+' || token[index] == '-')) {
      ++index;
    }
    bool saw_exponent_digit = false;
    while (index < token.size() && physicalFilterIsDigit(token[index])) {
      saw_exponent_digit = true;
      ++index;
    }
    if (!saw_exponent_digit) {
      return std::nullopt;
    }
  }

  if (!saw_digit || index != token.size()) {
    return std::nullopt;
  }

  XpodQleverBoundedFilterTerm term;
  term.term.kind = XPOD_RDF_TERM_LITERAL;
  term.value = std::string(token);
  term.datatype_iri = is_double
      ? "http://www.w3.org/2001/XMLSchema#double"
      : "http://www.w3.org/2001/XMLSchema#integer";
  term.refreshViews();
  return term;
}

inline std::optional<XpodQleverBoundedFilterTerm> physicalTermFromToken(
    std::string_view token) {
  if (auto iri = physicalIriTermFromToken(token); iri.has_value()) {
    return iri;
  }
  if (auto literal = physicalLiteralTermFromToken(token); literal.has_value()) {
    return literal;
  }
  return physicalInlineTypedLiteralTermFromToken(token);
}

inline std::vector<std::string_view> splitPhysicalFilterTermList(
    std::string_view terms) {
  std::vector<std::string_view> result;
  size_t start = 0;
  bool in_string = false;
  bool in_iri = false;
  bool escaping = false;
  for (size_t index = 0; index < terms.size(); ++index) {
    char c = terms[index];
    if (escaping) {
      escaping = false;
      continue;
    }
    if (in_string && c == '\\') {
      escaping = true;
      continue;
    }
    if (!in_iri && c == '"') {
      in_string = !in_string;
      continue;
    }
    if (!in_string && c == '<') {
      in_iri = true;
      continue;
    }
    if (!in_string && c == '>') {
      in_iri = false;
      continue;
    }
    if (!in_string && !in_iri && c == ',') {
      result.push_back(trimPhysicalFilterToken(
          terms.substr(start, index - start)));
      start = index + 1;
    }
  }
  result.push_back(trimPhysicalFilterToken(terms.substr(start)));
  return result;
}

inline bool physicalFilterStartsWith(
    std::string_view value,
    std::string_view prefix) noexcept {
  return value.size() >= prefix.size() &&
         value.substr(0, prefix.size()) == prefix;
}

inline std::optional<ColumnIndex> physicalFilterColumnForVariable(
    const VariableToColumnMap& columns,
    std::string_view variable_token) {
  variable_token = trimPhysicalFilterToken(variable_token);
  if (variable_token.size() < 2 || variable_token.front() != '?') {
    return std::nullopt;
  }
  auto it = columns.find(Variable{std::string(variable_token)});
  if (it == columns.end()) {
    return std::nullopt;
  }
  return it->second.columnIndex_;
}

inline std::optional<XpodQleverBoundedFilterExpression>
physicalBoundedFilterFromExpression(
    const VariableToColumnMap& columns,
    std::string_view descriptor) {
  descriptor = stripPhysicalFilterParens(descriptor);
  bool equals = true;
  size_t separator = descriptor.find(" = ");
  size_t operator_size = 3;
  if (separator == std::string_view::npos) {
    separator = descriptor.find(" != ");
    operator_size = 4;
    equals = false;
  }
  if (separator == std::string_view::npos) {
    return std::nullopt;
  }

  std::string_view left =
      trimPhysicalFilterToken(descriptor.substr(0, separator));
  std::string_view right = trimPhysicalFilterToken(
      descriptor.substr(separator + operator_size));

  auto bind = [&](std::string_view variable_token, std::string_view term_token)
      -> std::optional<XpodQleverBoundedFilterExpression> {
    auto column = physicalFilterColumnForVariable(columns, variable_token);
    auto term = physicalTermFromToken(term_token);
    if (!column.has_value() || !term.has_value()) {
      return std::nullopt;
    }
    std::vector<XpodQleverBoundedFilterTerm> terms;
    terms.push_back(std::move(*term));
    XpodQleverBoundedFilterExpression expression;
    expression.equals = equals;
    expression.column = *column;
    expression.terms = std::move(terms);
    return expression;
  };

  if (auto result = bind(left, right); result.has_value()) {
    return result;
  }
  return bind(right, left);
}

inline std::optional<XpodQleverBoundedFilterExpression>
physicalInFilterFromExpression(
    const VariableToColumnMap& columns,
    std::string_view descriptor) {
  descriptor = stripPhysicalFilterParens(descriptor);
  bool equals = true;
  std::string_view separator = " NOT IN ";
  size_t separator_index = descriptor.find(separator);
  if (separator_index != std::string_view::npos) {
    equals = false;
  } else {
    separator = " IN ";
    separator_index = descriptor.find(separator);
  }
  if (separator_index == std::string_view::npos) {
    return std::nullopt;
  }

  std::string_view variable_token =
      trimPhysicalFilterToken(descriptor.substr(0, separator_index));
  std::string_view terms_token = trimPhysicalFilterToken(
      descriptor.substr(separator_index + separator.size()));
  terms_token = stripPhysicalFilterParens(terms_token);
  auto column = physicalFilterColumnForVariable(columns, variable_token);
  if (!column.has_value() || terms_token.empty()) {
    return std::nullopt;
  }

  std::vector<XpodQleverBoundedFilterTerm> terms;
  for (std::string_view term_token : splitPhysicalFilterTermList(terms_token)) {
    auto term = physicalTermFromToken(term_token);
    if (!term.has_value()) {
      return std::nullopt;
    }
    terms.push_back(std::move(*term));
  }
  if (terms.empty()) {
    return std::nullopt;
  }
  XpodQleverBoundedFilterExpression expression;
  expression.equals = equals;
  expression.column = *column;
  expression.terms = std::move(terms);
  return expression;
}

inline std::optional<XpodQleverBoundedFilterExpression>
physicalStringFilterFromExpression(
    const VariableToColumnMap& columns,
    std::string_view descriptor,
    std::string_view function_name,
    XpodQleverStringFilterKind string_filter) {
  descriptor = stripPhysicalFilterParens(descriptor);
  if (!physicalFilterStartsWith(descriptor, function_name) ||
      descriptor.back() != ')') {
    return std::nullopt;
  }
  std::string_view args = descriptor.substr(
      function_name.size(), descriptor.size() - function_name.size() - 1);
  std::vector<std::string_view> parts = splitPhysicalFilterTermList(args);
  if (parts.size() != 2) {
    return std::nullopt;
  }

  std::string_view variable_token = trimPhysicalFilterToken(parts[0]);
  constexpr std::string_view str_function_name = "STR(";
  if (physicalFilterStartsWith(variable_token, str_function_name) &&
      variable_token.back() == ')') {
    variable_token = trimPhysicalFilterToken(variable_token.substr(
        str_function_name.size(),
        variable_token.size() - str_function_name.size() - 1));
  }

  auto column = physicalFilterColumnForVariable(columns, variable_token);
  auto prefix = physicalLiteralTermFromToken(parts[1]);
  if (!column.has_value() || !prefix.has_value() ||
      prefix->term.kind != XPOD_RDF_TERM_LITERAL) {
    return std::nullopt;
  }

  XpodQleverBoundedFilterExpression expression;
  expression.kind = XpodQleverPhysicalFilterKind::StringPredicate;
  expression.column = *column;
  expression.string_filter = string_filter;
  expression.string_prefix = std::move(prefix->value);
  return expression;
}

inline std::optional<
    std::pair<ColumnIndex, XpodQleverStringValueTransform>>
physicalStringValueColumnFromToken(
    const VariableToColumnMap& columns,
    std::string_view token) {
  token = trimPhysicalFilterToken(token);
  XpodQleverStringValueTransform transform =
      XpodQleverStringValueTransform::None;
  constexpr std::string_view lcase_function_name = "LCASE(";
  constexpr std::string_view ucase_function_name = "UCASE(";
  std::string_view case_function_name = {};
  if (physicalFilterStartsWith(token, lcase_function_name)) {
    transform = XpodQleverStringValueTransform::Lowercase;
    case_function_name = lcase_function_name;
  } else if (physicalFilterStartsWith(token, ucase_function_name)) {
    transform = XpodQleverStringValueTransform::Uppercase;
    case_function_name = ucase_function_name;
  }
  if (!case_function_name.empty() &&
      token.back() == ')') {
    std::string_view inner = trimPhysicalFilterToken(token.substr(
        case_function_name.size(),
        token.size() - case_function_name.size() - 1));
    constexpr std::string_view str_function_name = "STR(";
    if (!physicalFilterStartsWith(inner, str_function_name) ||
        inner.back() != ')') {
      return std::nullopt;
    }
    std::string_view variable_token = trimPhysicalFilterToken(inner.substr(
        str_function_name.size(),
        inner.size() - str_function_name.size() - 1));
    auto column = physicalFilterColumnForVariable(columns, variable_token);
    if (!column.has_value()) {
      return std::nullopt;
    }
    return std::pair<ColumnIndex, XpodQleverStringValueTransform>{
        *column, transform};
  }

  constexpr std::string_view str_function_name = "STR(";
  if (physicalFilterStartsWith(token, str_function_name) &&
      token.back() == ')') {
    token = trimPhysicalFilterToken(token.substr(
        str_function_name.size(),
        token.size() - str_function_name.size() - 1));
  }
  auto column = physicalFilterColumnForVariable(columns, token);
  if (!column.has_value()) {
    return std::nullopt;
  }
  return std::pair<ColumnIndex, XpodQleverStringValueTransform>{
      *column, XpodQleverStringValueTransform::None};
}

inline std::optional<XpodQleverBoundedFilterExpression>
physicalStringEqualsFilterFromExpression(
    const VariableToColumnMap& columns,
    std::string_view descriptor) {
  descriptor = stripPhysicalFilterParens(descriptor);
  bool equals = true;
  size_t separator = descriptor.find(" = ");
  size_t operator_size = 3;
  if (separator == std::string_view::npos) {
    separator = descriptor.find(" != ");
    operator_size = 4;
    equals = false;
  }
  if (separator == std::string_view::npos) {
    return std::nullopt;
  }

  std::string_view left =
      trimPhysicalFilterToken(descriptor.substr(0, separator));
  std::string_view right = trimPhysicalFilterToken(
      descriptor.substr(separator + operator_size));

  auto bind = [&](std::string_view value_token,
                  std::string_view literal_token)
      -> std::optional<XpodQleverBoundedFilterExpression> {
    auto column = physicalStringValueColumnFromToken(columns, value_token);
    auto literal = physicalLiteralTermFromToken(literal_token);
    if (!column.has_value() || !literal.has_value() ||
        literal->term.kind != XPOD_RDF_TERM_LITERAL) {
      return std::nullopt;
    }
    XpodQleverBoundedFilterExpression expression;
    expression.kind = XpodQleverPhysicalFilterKind::StringPredicate;
    expression.equals = equals;
    expression.column = column->first;
    expression.string_filter = XpodQleverStringFilterKind::Equals;
    expression.string_prefix = std::move(literal->value);
    expression.string_value_transform = column->second;
    return expression;
  };

  if (auto result = bind(left, right); result.has_value()) {
    return result;
  }
  return bind(right, left);
}

inline std::optional<XpodQleverBoundedFilterExpression>
physicalMetadataFilterFromExpression(
    const VariableToColumnMap& columns,
    std::string_view descriptor) {
  descriptor = stripPhysicalFilterParens(descriptor);
  bool equals = true;
  size_t separator = descriptor.find(" = ");
  size_t operator_size = 3;
  if (separator == std::string_view::npos) {
    separator = descriptor.find(" != ");
    operator_size = 4;
    equals = false;
  }
  if (separator == std::string_view::npos) {
    return std::nullopt;
  }

  std::string_view left =
      trimPhysicalFilterToken(descriptor.substr(0, separator));
  std::string_view right = trimPhysicalFilterToken(
      descriptor.substr(separator + operator_size));

  auto bind = [&](std::string_view function_token,
                  std::string_view expected_token)
      -> std::optional<XpodQleverBoundedFilterExpression> {
    constexpr std::string_view language_function = "LANG(";
    constexpr std::string_view datatype_function = "DATATYPE(";
    xpod_rdf_scan_filter_kind kind = XPOD_RDF_SCAN_FILTER_LANGUAGE_EQUAL;
    std::string_view function_name = language_function;
    bool language = true;
    if (physicalFilterStartsWith(function_token, datatype_function)) {
      kind = XPOD_RDF_SCAN_FILTER_DATATYPE_EQUAL;
      function_name = datatype_function;
      language = false;
    } else if (!physicalFilterStartsWith(function_token, language_function)) {
      return std::nullopt;
    }
    if (function_token.back() != ')') {
      return std::nullopt;
    }

    std::string_view variable_token = trimPhysicalFilterToken(
        function_token.substr(
            function_name.size(),
            function_token.size() - function_name.size() - 1));
    auto column = physicalFilterColumnForVariable(columns, variable_token);
    if (!column.has_value()) {
      return std::nullopt;
    }

    std::string expected;
    if (language) {
      auto literal = physicalLiteralTermFromToken(expected_token);
      if (!literal.has_value() ||
          literal->term.kind != XPOD_RDF_TERM_LITERAL ||
          !literal->datatype_iri.empty() || !literal->language.empty()) {
        return std::nullopt;
      }
      expected = std::move(literal->value);
    } else {
      auto iri = physicalIriTermFromToken(expected_token);
      if (!iri.has_value()) {
        return std::nullopt;
      }
      expected = std::move(iri->value);
    }

    XpodQleverBoundedFilterExpression expression;
    expression.kind = XpodQleverPhysicalFilterKind::MetadataPredicate;
    expression.equals = equals;
    expression.column = *column;
    expression.string_prefix = std::move(expected);
    expression.metadata_filter = kind;
    return expression;
  };

  if (auto result = bind(left, right); result.has_value()) {
    return result;
  }
  return bind(right, left);
}

inline std::optional<XpodQleverBoundedFilterExpression>
physicalFilterFromExpression(
    const VariableToColumnMap& columns,
    std::string_view descriptor) {
  if (auto bounded = physicalBoundedFilterFromExpression(columns, descriptor);
      bounded.has_value()) {
    return bounded;
  }
  if (auto in = physicalInFilterFromExpression(columns, descriptor);
      in.has_value()) {
    return in;
  }
  if (auto strstarts = physicalStringFilterFromExpression(
          columns, descriptor, "STRSTARTS(",
          XpodQleverStringFilterKind::Prefix);
      strstarts.has_value()) {
    return strstarts;
  }
  if (auto contains = physicalStringFilterFromExpression(
          columns, descriptor, "CONTAINS(",
          XpodQleverStringFilterKind::Contains);
      contains.has_value()) {
    return contains;
  }
  if (auto strends = physicalStringFilterFromExpression(
      columns, descriptor, "STRENDS(",
      XpodQleverStringFilterKind::Suffix);
      strends.has_value()) {
    return strends;
  }
  if (auto metadata = physicalMetadataFilterFromExpression(columns, descriptor);
      metadata.has_value()) {
    return metadata;
  }
  return physicalStringEqualsFilterFromExpression(columns, descriptor);
}

template <typename TableT>
inline IdTable physicalMembershipFilterIdTable(
    QueryExecutionContext& context,
    const TableT& input,
    const XpodQleverBoundedFilterExpression& filter,
    const std::vector<uint64_t>& term_id_bits) {
  IdTable output{input.numColumns(), context.getAllocator()};
  if (filter.column >= input.numColumns()) {
    return output;
  }

  std::vector<Id> row;
  row.reserve(input.numColumns());
  for (size_t input_row = 0; input_row < input.numRows(); ++input_row) {
    uint64_t actual_bits = input(input_row, filter.column).getBits();
    bool matches = false;
    for (uint64_t bits : term_id_bits) {
      if (actual_bits == bits) {
        matches = true;
        break;
      }
    }
    if (filter.equals != matches) {
      continue;
    }
    row.clear();
    for (size_t column = 0; column < input.numColumns(); ++column) {
      row.push_back(input(input_row, column));
    }
    output.push_back(row);
  }
  return output;
}

template <typename TableT>
inline std::optional<IdTable> physicalStringPrefixFilterIdTable(
    QueryExecutionContext& context,
    const XpodQleverPhysicalIndex& physical_index,
    const TableT& input,
    const LocalVocab* local_vocab,
    const XpodQleverBoundedFilterExpression& filter) {
  IdTable output{input.numColumns(), context.getAllocator()};
  if (filter.column >= input.numColumns()) {
    return output;
  }

  std::vector<Id> row;
  row.reserve(input.numColumns());
  for (size_t input_row = 0; input_row < input.numRows(); ++input_row) {
    bool matches = false;
    bool has_value = false;
    std::string local_value;
    std::string_view value;
#if XPOD_QLEVER_PHYSICAL_FILTER_HAS_VALUE_ID_DATATYPE
    const Id& id = input(input_row, filter.column);
    if (local_vocab != nullptr &&
        id.getDatatype() == Datatype::LocalVocabIndex) {
      const auto& word = local_vocab->getWord(id.getLocalVocabIndex());
      if (word.isIri()) {
        local_value = std::string(word.getIriContent());
        value = local_value;
        has_value = true;
      } else if (word.isLiteral()) {
        local_value = std::string(word.getLiteralContent());
        value = local_value;
        has_value = true;
      }
    }
#else
    (void)local_vocab;
#endif
    if (!has_value) {
      xpod_rdf_term_key key = 0;
      if (physical_index.decodeQleverId(
              input(input_row, filter.column).getBits(), key) !=
          XPOD_RDF_STATUS_OK) {
        return std::nullopt;
      }

      auto resolved = physical_index.resolveTerms(&key, 1);
      if (resolved.status != XPOD_RDF_STATUS_OK ||
          resolved.statuses.size() != 1 ||
          resolved.terms.size() != 1) {
        return std::nullopt;
      }
      if (resolved.statuses[0] == XPOD_RDF_STATUS_OK) {
        value = std::string_view(
            resolved.terms[0].value.data, resolved.terms[0].value.size);
        has_value = true;
      } else if (resolved.statuses[0] != XPOD_RDF_STATUS_NOT_FOUND) {
        return std::nullopt;
      }
    }
    if (has_value) {
      std::string transformed_value;
      if (filter.string_value_transform !=
          XpodQleverStringValueTransform::None) {
        transformed_value = std::string(value);
        if (filter.string_value_transform ==
            XpodQleverStringValueTransform::Lowercase) {
          std::transform(
              transformed_value.begin(), transformed_value.end(),
              transformed_value.begin(), [](unsigned char c) {
                return static_cast<char>(std::tolower(c));
              });
        } else {
          std::transform(
              transformed_value.begin(), transformed_value.end(),
              transformed_value.begin(), [](unsigned char c) {
                return static_cast<char>(std::toupper(c));
              });
        }
        value = transformed_value;
      }
      if (filter.string_filter == XpodQleverStringFilterKind::Prefix) {
        matches = physicalFilterStartsWith(value, filter.string_prefix);
      } else if (filter.string_filter == XpodQleverStringFilterKind::Contains) {
        matches = value.find(filter.string_prefix) != std::string_view::npos;
      } else if (filter.string_filter == XpodQleverStringFilterKind::Suffix) {
        matches = value.size() >= filter.string_prefix.size() &&
                  value.substr(value.size() - filter.string_prefix.size()) ==
                      filter.string_prefix;
      } else {
        matches = value == filter.string_prefix;
      }
    }

    if (filter.equals != matches) {
      continue;
    }
    row.clear();
    for (size_t column = 0; column < input.numColumns(); ++column) {
      row.push_back(input(input_row, column));
    }
    output.push_back(row);
  }
  return output;
}

inline std::string_view physicalFilterBytesView(
    xpod_rdf_bytes bytes) noexcept {
  return bytes.data == nullptr ? std::string_view{}
                               : std::string_view{bytes.data, bytes.size};
}

template <typename IdT, typename = void>
struct XpodPhysicalFilterHasIntValue : std::false_type {};

template <typename IdT, typename = void>
struct XpodPhysicalFilterHasUndefinedValue : std::false_type {};

template <typename IdT>
struct XpodPhysicalFilterHasUndefinedValue<
    IdT,
    std::void_t<decltype(IdT::makeUndefined())>>
    : std::true_type {};

template <typename IdT>
struct XpodPhysicalFilterHasIntValue<
    IdT,
    std::void_t<decltype(IdT::makeFromInt(std::declval<const IdT&>().getInt()))>>
    : std::true_type {};

template <typename IdT, typename = void>
struct XpodPhysicalFilterHasDoubleValue : std::false_type {};

template <typename IdT>
struct XpodPhysicalFilterHasDoubleValue<
    IdT,
    std::void_t<decltype(IdT::makeFromDouble(
        std::declval<const IdT&>().getDouble()))>>
    : std::true_type {};

template <typename IdT, typename = void>
struct XpodPhysicalFilterHasBoolValue : std::false_type {};

template <typename IdT>
struct XpodPhysicalFilterHasBoolValue<
    IdT,
    std::void_t<decltype(IdT::makeFromBool(std::declval<const IdT&>().getBool()))>>
    : std::true_type {};

template <typename IdT, typename = void>
struct XpodPhysicalFilterHasZeroOneBoolValue : std::false_type {};

template <typename IdT>
struct XpodPhysicalFilterHasZeroOneBoolValue<
    IdT,
    std::void_t<decltype(IdT::makeBoolFromZeroOrOne(
        std::declval<const IdT&>().getBool()))>>
    : std::true_type {};

inline xpod_rdf_status physicalFilterTermMetadataFromId(
    const XpodQleverPhysicalIndex& physical_index,
    const Id& id,
    std::string& out_language,
    std::string& out_datatype,
    bool& out_is_literal) {
  out_language.clear();
  out_datatype.clear();
  out_is_literal = false;

  if constexpr (XpodPhysicalFilterHasUndefinedValue<Id>::value) {
    if (Id::makeUndefined().getBits() == id.getBits()) {
      return XPOD_RDF_STATUS_OK;
    }
  }
  if constexpr (XpodPhysicalFilterHasIntValue<Id>::value) {
    const int64_t value = id.getInt();
    if (Id::makeFromInt(value).getBits() == id.getBits()) {
      out_is_literal = true;
      out_datatype = "http://www.w3.org/2001/XMLSchema#integer";
      return XPOD_RDF_STATUS_OK;
    }
  }
  if constexpr (XpodPhysicalFilterHasDoubleValue<Id>::value) {
    const double value = id.getDouble();
    if (Id::makeFromDouble(value).getBits() == id.getBits()) {
      out_is_literal = true;
      out_datatype = "http://www.w3.org/2001/XMLSchema#double";
      return XPOD_RDF_STATUS_OK;
    }
  }
  if constexpr (XpodPhysicalFilterHasBoolValue<Id>::value) {
    const bool value = id.getBool();
    bool is_bool = Id::makeFromBool(value).getBits() == id.getBits();
    if constexpr (XpodPhysicalFilterHasZeroOneBoolValue<Id>::value) {
      is_bool = is_bool ||
                Id::makeBoolFromZeroOrOne(value).getBits() == id.getBits();
    }
    if (is_bool) {
      out_is_literal = true;
      out_datatype = "http://www.w3.org/2001/XMLSchema#boolean";
      return XPOD_RDF_STATUS_OK;
    }
  }

  xpod_rdf_term_key key = 0;
  if (physical_index.decodeQleverId(id.getBits(), key) != XPOD_RDF_STATUS_OK) {
    return XPOD_RDF_STATUS_UNSUPPORTED;
  }
  auto resolved = physical_index.resolveTerms(&key, 1);
  if (resolved.status != XPOD_RDF_STATUS_OK ||
      resolved.statuses.size() != 1 ||
      resolved.terms.size() != 1) {
    return XPOD_RDF_STATUS_UNSUPPORTED;
  }
  if (resolved.statuses[0] == XPOD_RDF_STATUS_NOT_FOUND) {
    return XPOD_RDF_STATUS_OK;
  }
  if (resolved.statuses[0] != XPOD_RDF_STATUS_OK) {
    return resolved.statuses[0];
  }

  const xpod_rdf_term& term = resolved.terms[0];
  if (term.kind != XPOD_RDF_TERM_LITERAL) {
    return XPOD_RDF_STATUS_OK;
  }
  out_is_literal = true;
  out_language = std::string(physicalFilterBytesView(term.language));
  if (!out_language.empty()) {
    out_datatype =
        "http://www.w3.org/1999/02/22-rdf-syntax-ns#langString";
  } else if (term.datatype_iri.size != 0) {
    out_datatype = std::string(physicalFilterBytesView(term.datatype_iri));
  } else {
    out_datatype = "http://www.w3.org/2001/XMLSchema#string";
  }
  return XPOD_RDF_STATUS_OK;
}

inline void physicalFilterLowercaseAscii(std::string& value) {
  std::transform(
      value.begin(), value.end(), value.begin(), [](unsigned char c) {
        return static_cast<char>(std::tolower(c));
      });
}

template <typename TableT>
inline std::optional<IdTable> physicalMetadataFilterIdTable(
    QueryExecutionContext& context,
    const XpodQleverPhysicalIndex& physical_index,
    const TableT& input,
    const XpodQleverBoundedFilterExpression& filter) {
  IdTable output{input.numColumns(), context.getAllocator()};
  if (filter.column >= input.numColumns()) {
    return output;
  }

  std::vector<Id> row;
  row.reserve(input.numColumns());
  for (size_t input_row = 0; input_row < input.numRows(); ++input_row) {
    std::string language;
    std::string datatype;
    bool is_literal = false;
    const xpod_rdf_status status = physicalFilterTermMetadataFromId(
        physical_index, input(input_row, filter.column),
        language, datatype, is_literal);
    if (status != XPOD_RDF_STATUS_OK) {
      return std::nullopt;
    }

    if (!is_literal) {
      continue;
    }

    bool matches = false;
    if (filter.metadata_filter == XPOD_RDF_SCAN_FILTER_LANGUAGE_EQUAL) {
      physicalFilterLowercaseAscii(language);
      std::string expected = filter.string_prefix;
      physicalFilterLowercaseAscii(expected);
      matches = language == expected;
    } else {
      matches = datatype == filter.string_prefix;
    }
    if (filter.equals != matches) {
      continue;
    }

    row.clear();
    for (size_t column = 0; column < input.numColumns(); ++column) {
      row.push_back(input(input_row, column));
    }
    output.push_back(row);
  }
  return output;
}

template <typename TableT>
inline std::optional<IdTable> physicalFilterIdTable(
    QueryExecutionContext& context,
    const XpodQleverPhysicalIndex& physical_index,
    const TableT& input,
    const LocalVocab* local_vocab,
    const XpodQleverBoundedFilterExpression& filter,
    const std::vector<uint64_t>& term_id_bits) {
  if (filter.kind == XpodQleverPhysicalFilterKind::StringPredicate) {
    return physicalStringPrefixFilterIdTable(
        context, physical_index, input, local_vocab, filter);
  }
  if (filter.kind == XpodQleverPhysicalFilterKind::MetadataPredicate) {
    return physicalMetadataFilterIdTable(
        context, physical_index, input, filter);
  }
  return physicalMembershipFilterIdTable(
      context, input, filter, term_id_bits);
}

inline size_t physicalFilterResultWidth(
    const VariableToColumnMap& columns) noexcept {
  size_t width = 0;
  for (const auto& [_, column] : columns) {
    width = std::max(width, static_cast<size_t>(column.columnIndex_) + 1);
  }
  return width;
}

inline Id remapPhysicalFilterLocalVocabId(
    const Id& id,
    const LocalVocab& source_vocab,
    LocalVocab& target_vocab) {
#if XPOD_QLEVER_PHYSICAL_FILTER_HAS_VALUE_ID_DATATYPE
  if (id.getDatatype() == Datatype::LocalVocabIndex) {
    const auto& word = source_vocab.getWord(id.getLocalVocabIndex());
    return Id::makeFromLocalVocabIndex(
        target_vocab.getIndexAndAddIfNotContained(word));
  }
#else
  (void)source_vocab;
  (void)target_vocab;
#endif
  return id;
}

inline void appendPhysicalFilterRows(
    IdTable& target,
    const IdTable& source,
    const LocalVocab& source_vocab,
    LocalVocab& target_vocab) {
  std::vector<Id> row;
  row.reserve(source.numColumns());
  for (size_t row_index = 0; row_index < source.numRows(); ++row_index) {
    row.clear();
    for (size_t column = 0; column < source.numColumns(); ++column) {
      row.push_back(remapPhysicalFilterLocalVocabId(
          source(row_index, column), source_vocab, target_vocab));
    }
    target.push_back(row);
  }
}

inline XpodQleverPhysicalFilterResult physicalFilterResultFromContext(
    QueryExecutionContext& context,
    const VariableToColumnMap& columns,
    const sparqlExpression::SparqlExpressionPimpl& expression,
    const Result& sub_result,
    std::vector<ColumnIndex> sorted_by) {
  const XpodQleverPhysicalIndex* physical_index =
      physicalIndexFromContext(context);
  if (physical_index == nullptr) {
    return unsupportedPhysicalFilterResult(context);
  }

  auto filter = physicalFilterFromExpression(
      columns, expression.getDescriptor());
  if (!filter.has_value()) {
    return unsupportedPhysicalFilterResult(context);
  }
  for (const auto& term : filter->terms) {
    const std::string_view value = physicalFilterBytesView(term.term.value);
    const std::string_view datatype =
        physicalFilterBytesView(term.term.datatype_iri);
    if (numeric_literal::compare(value, datatype, value, datatype).applicable) {
      return unsupportedPhysicalFilterResult(context);
    }
  }
  std::vector<xpod_rdf_term> lookup_terms;
  lookup_terms.reserve(filter->terms.size());
  for (auto& term : filter->terms) {
    term.refreshViews();
    lookup_terms.push_back(term.term);
  }

  auto lookup = physical_index->lookupTerms(
      lookup_terms.data(), lookup_terms.size());
  if (lookup.status != XPOD_RDF_STATUS_OK) {
    return unsupportedPhysicalFilterResult(context);
  }
  if (lookup.statuses.size() != lookup_terms.size() ||
      lookup.keys.size() != lookup_terms.size()) {
    return unsupportedPhysicalFilterResult(context);
  }

  std::vector<uint64_t> term_id_bits;
  term_id_bits.reserve(lookup_terms.size());
  for (size_t index = 0; index < lookup_terms.size(); ++index) {
    if (lookup.statuses[index] == XPOD_RDF_STATUS_NOT_FOUND) {
      continue;
    }
    if (lookup.statuses[index] != XPOD_RDF_STATUS_OK) {
      return unsupportedPhysicalFilterResult(context);
    }
    const PlannerRequestContext& planner_context =
        physical_index->plannerRequestContext();
    const xpod_rdf_snapshot* snapshot =
        planner_context.request == nullptr
            ? nullptr
            : &planner_context.request->snapshot;
    uint64_t bits = 0;
    if (encodePhysicalTermAsQleverId(
            planner_context.backend, lookup.keys[index], snapshot, bits) !=
        XPOD_RDF_STATUS_OK) {
      return unsupportedPhysicalFilterResult(context);
    }
    term_id_bits.push_back(bits);
  }

  if (sub_result.isFullyMaterialized()) {
    const auto& input = qleverResultTable(sub_result);
    if (filter->column >= input.numColumns()) {
      return unsupportedPhysicalFilterResult(context);
    }
    auto output = physicalFilterIdTable(
        context, *physical_index, input, &sub_result.localVocab(), *filter,
        term_id_bits);
    if (!output.has_value()) {
      return unsupportedPhysicalFilterResult(context);
    }
    return {
        XPOD_RDF_STATUS_OK,
        Result{std::move(*output), std::move(sorted_by),
               sub_result.getSharedLocalVocab()}};
  }

  if (filter->column >= physicalFilterResultWidth(columns)) {
    return unsupportedPhysicalFilterResult(context);
  }

  IdTable output{physicalFilterResultWidth(columns), context.getAllocator()};
  LocalVocab output_local_vocab{};
  for (Result::IdTableVocabPair& pair : sub_result.idTables()) {
    auto filtered = physicalFilterIdTable(
        context, *physical_index, pair.idTable_, &pair.localVocab_, *filter,
        term_id_bits);
    if (!filtered.has_value()) {
      return unsupportedPhysicalFilterResult(context);
    }
    appendPhysicalFilterRows(output, *filtered, pair.localVocab_,
                             output_local_vocab);
  }

  return {
      XPOD_RDF_STATUS_OK,
      Result{std::move(output), std::move(sorted_by),
             std::move(output_local_vocab)}};
}

}  // namespace xpod::qlever
#endif

#endif
