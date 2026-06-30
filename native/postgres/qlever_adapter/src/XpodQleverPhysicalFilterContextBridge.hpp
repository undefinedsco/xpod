#ifndef XPOD_QLEVER_PHYSICAL_FILTER_CONTEXT_BRIDGE_HPP
#define XPOD_QLEVER_PHYSICAL_FILTER_CONTEXT_BRIDGE_HPP

#include "XpodQleverPhysicalIndexScanContextBridge.hpp"
#include "xpod_rdf_physical_backend.h"

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

struct XpodQleverBoundedFilterExpression {
  bool equals = true;
  ColumnIndex column = 0;
  XpodQleverBoundedFilterTerm term;
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

inline std::optional<XpodQleverBoundedFilterTerm> physicalTermFromToken(
    std::string_view token) {
  if (auto iri = physicalIriTermFromToken(token); iri.has_value()) {
    return iri;
  }
  return physicalLiteralTermFromToken(token);
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
    return XpodQleverBoundedFilterExpression{equals, *column, std::move(*term)};
  };

  if (auto result = bind(left, right); result.has_value()) {
    return result;
  }
  return bind(right, left);
}

inline XpodQleverPhysicalFilterResult physicalFilterResultFromContext(
    QueryExecutionContext& context,
    const VariableToColumnMap& columns,
    const sparqlExpression::SparqlExpressionPimpl& expression,
    const Result& sub_result,
    std::vector<ColumnIndex> sorted_by) {
  const XpodQleverPhysicalIndex* physical_index =
      physicalIndexFromContext(context);
  if (physical_index == nullptr || !sub_result.isFullyMaterialized()) {
    return unsupportedPhysicalFilterResult(context);
  }

  auto filter = physicalBoundedFilterFromExpression(
      columns, expression.getDescriptor());
  if (!filter.has_value()) {
    return unsupportedPhysicalFilterResult(context);
  }

  filter->term.refreshViews();

  xpod_rdf_term_key key = 0;
  auto lookup = physical_index->lookupTerms(&filter->term.term, 1);
  if (lookup.status != XPOD_RDF_STATUS_OK) {
    return unsupportedPhysicalFilterResult(context);
  }
  bool has_bound_key = lookup.statuses.size() == 1 &&
                       lookup.statuses[0] == XPOD_RDF_STATUS_OK;
  if (has_bound_key) {
    key = lookup.keys[0];
  } else if (lookup.statuses.size() != 1 ||
             lookup.statuses[0] != XPOD_RDF_STATUS_NOT_FOUND) {
    return unsupportedPhysicalFilterResult(context);
  }

  uint64_t term_id_bits = 0;
  if (has_bound_key &&
      physical_index->encodeQleverId(key, term_id_bits) != XPOD_RDF_STATUS_OK) {
    return unsupportedPhysicalFilterResult(context);
  }

  const IdTable& input = sub_result.idTable();
  if (filter->column >= input.numColumns()) {
    return unsupportedPhysicalFilterResult(context);
  }

  IdTable output{input.numColumns(), context.getAllocator()};
  std::vector<Id> row;
  row.reserve(input.numColumns());
  for (size_t input_row = 0; input_row < input.numRows(); ++input_row) {
    bool matches = has_bound_key &&
                   input(input_row, filter->column).getBits() == term_id_bits;
    if (filter->equals != matches) {
      continue;
    }
    row.clear();
    for (size_t column = 0; column < input.numColumns(); ++column) {
      row.push_back(input(input_row, column));
    }
    output.push_back(row);
  }

  return {
      XPOD_RDF_STATUS_OK,
      Result{std::move(output), std::move(sorted_by),
             sub_result.getSharedLocalVocab()}};
}

}  // namespace xpod::qlever
#endif

#endif
