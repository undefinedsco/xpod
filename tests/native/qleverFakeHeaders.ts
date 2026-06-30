export const fakeEncodedIriManagerHeader = '#pragma once\nclass EncodedIriManager {};\n';

export const fakeParsedQueryHeader = `
#pragma once
#include <cstddef>
#include <string>
#include <utility>
#include <variant>
#include <vector>
class Variable {
 public:
  explicit Variable(std::string name) : name_(std::move(name)) {}
  const std::string& name() const { return name_; }
 private:
  std::string name_;
};
class TripleComponent {
 public:
  class UNDEF {};
  class Iri {
   public:
    explicit Iri(std::string value) : value_(std::move(value)) {}
    const std::string& toStringRepresentation() const { return value_; }
   private:
    std::string value_;
  };
  class Literal {
   public:
    explicit Literal(std::string value) : value_(std::move(value)) {}
    const std::string& toStringRepresentation() const { return value_; }
   private:
    std::string value_;
  };
  explicit TripleComponent(Variable variable) : kind_(Kind::Variable), variable_(std::move(variable)) {}
  explicit TripleComponent(Iri iri) : kind_(Kind::Iri), iri_(std::move(iri)) {}
  explicit TripleComponent(Literal literal) : kind_(Kind::Literal), literal_(std::move(literal)) {}
  explicit TripleComponent(UNDEF) : kind_(Kind::Undef) {}
  bool isVariable() const { return kind_ == Kind::Variable; }
  const Variable& getVariable() const { return variable_; }
  bool isIri() const { return kind_ == Kind::Iri; }
  const Iri& getIri() const { return iri_; }
  bool isLiteral() const { return kind_ == Kind::Literal; }
  const Literal& getLiteral() const { return literal_; }
  bool isUndef() const { return kind_ == Kind::Undef; }
 private:
  enum class Kind { Variable, Iri, Literal, Undef };
  Kind kind_ = Kind::Variable;
  Variable variable_{""};
  Iri iri_{""};
  Literal literal_{""};
};
class SparqlTripleSimple {
 public:
  SparqlTripleSimple(TripleComponent s, TripleComponent p, TripleComponent o)
      : s_(std::move(s)), p_(std::move(p)), o_(std::move(o)) {}
  TripleComponent s_;
  TripleComponent p_;
  TripleComponent o_;
};
class SparqlTriple {
 public:
  SparqlTriple(TripleComponent s, TripleComponent p, TripleComponent o)
      : s_(std::move(s)), p_(std::move(p)), o_(std::move(o)) {}
  SparqlTripleSimple getSimple() const { return {s_, p_, o_}; }
 private:
  TripleComponent s_;
  TripleComponent p_;
  TripleComponent o_;
};
class SelectClause {
 public:
  bool isAsterisk() const { return asterisk_; }
  const std::vector<Variable>& getSelectedVariables() const {
    return selected_;
  }
  void setSelected(std::vector<Variable> variables) {
    asterisk_ = false;
    selected_ = std::move(variables);
  }
 private:
  bool asterisk_ = true;
  std::vector<Variable> selected_;
};
namespace sparqlExpression {
class SparqlExpressionPimpl {
 public:
  SparqlExpressionPimpl() = default;
  explicit SparqlExpressionPimpl(std::string descriptor)
      : descriptor_(std::move(descriptor)) {}
  const std::string& getDescriptor() const { return descriptor_; }
 private:
  std::string descriptor_;
};
}
class SparqlFilter {
 public:
  sparqlExpression::SparqlExpressionPimpl expression_;
};
namespace parsedQuery {
struct GraphPatternOperation;
struct GraphPattern {
  GraphPattern();
  GraphPattern(const GraphPattern&);
  GraphPattern(GraphPattern&&) noexcept;
  GraphPattern& operator=(const GraphPattern&);
  GraphPattern& operator=(GraphPattern&&) noexcept;
  ~GraphPattern();
  std::vector<SparqlFilter> _filters;
  std::vector<GraphPatternOperation> _graphPatterns;
};
struct BasicGraphPattern {
  std::vector<SparqlTriple> _triples;
};
struct SparqlValues {
  std::vector<Variable> _variables;
  std::vector<std::vector<TripleComponent>> _values;
};
struct Values {
  SparqlValues _inlineValues;
  size_t _id = static_cast<size_t>(-1);
};
struct GroupGraphPattern {
  GraphPattern _child;
  enum class GraphVariableBehaviour { ALL, NAMED };
  using GraphVar = std::pair<Variable, GraphVariableBehaviour>;
  using GraphSpec = std::variant<std::monostate, TripleComponent::Iri, GraphVar>;
  GraphSpec graphSpec_ = std::monostate{};
  explicit GroupGraphPattern(GraphPattern child) : _child{std::move(child)} {}
  GroupGraphPattern(GraphPattern child, TripleComponent::Iri graphIri)
      : _child{std::move(child)}, graphSpec_{std::move(graphIri)} {}
  GroupGraphPattern(GraphPattern child, Variable graphVariable, GraphVariableBehaviour behaviour)
      : _child{std::move(child)}, graphSpec_{GraphVar{std::move(graphVariable), behaviour}} {}
};
using GraphPatternOperationVariant = std::variant<BasicGraphPattern, Values, GroupGraphPattern>;
struct GraphPatternOperation : public GraphPatternOperationVariant {
  using GraphPatternOperationVariant::GraphPatternOperationVariant;
};
inline GraphPattern::GraphPattern() = default;
inline GraphPattern::GraphPattern(const GraphPattern&) = default;
inline GraphPattern::GraphPattern(GraphPattern&&) noexcept = default;
inline GraphPattern& GraphPattern::operator=(const GraphPattern&) = default;
inline GraphPattern& GraphPattern::operator=(GraphPattern&&) noexcept = default;
inline GraphPattern::~GraphPattern() = default;
}
class ParsedQuery {
 public:
  static ParsedQuery minimalSelect() {
    ParsedQuery query;
    parsedQuery::BasicGraphPattern basic;
    basic._triples.emplace_back(
        TripleComponent{Variable{"?s"}},
        TripleComponent{Variable{"?p"}},
        TripleComponent{Variable{"?o"}});
    query._rootGraphPattern._graphPatterns.emplace_back(std::move(basic));
    return query;
  }
  static ParsedQuery minimalAsk() {
    ParsedQuery query = minimalSelect();
    query.select_ = false;
    query.ask_ = true;
    return query;
  }
  static ParsedQuery graphIriSelect() {
    ParsedQuery query;
    parsedQuery::BasicGraphPattern basic;
    basic._triples.emplace_back(
        TripleComponent{Variable{"?s"}},
        TripleComponent{Variable{"?p"}},
        TripleComponent{Variable{"?o"}});
    parsedQuery::GraphPattern child;
    child._graphPatterns.emplace_back(std::move(basic));
    query._rootGraphPattern._graphPatterns.emplace_back(
        parsedQuery::GroupGraphPattern{
            std::move(child),
            TripleComponent::Iri{"<urn:g>"}});
    return query;
  }
  static ParsedQuery graphVariableSelect() {
    ParsedQuery query;
    parsedQuery::BasicGraphPattern basic;
    basic._triples.emplace_back(
        TripleComponent{Variable{"?s"}},
        TripleComponent{Variable{"?p"}},
        TripleComponent{Variable{"?o"}});
    parsedQuery::GraphPattern child;
    child._graphPatterns.emplace_back(std::move(basic));
    query._rootGraphPattern._graphPatterns.emplace_back(
        parsedQuery::GroupGraphPattern{
            std::move(child),
            Variable{"?g"},
            parsedQuery::GroupGraphPattern::GraphVariableBehaviour::NAMED});
    return query;
  }
  static ParsedQuery graphVariableSubjectFilterSelect() {
    ParsedQuery query;
    parsedQuery::BasicGraphPattern basic;
    basic._triples.emplace_back(
        TripleComponent{Variable{"?s"}},
        TripleComponent{Variable{"?p"}},
        TripleComponent{Variable{"?o"}});
    basic._triples.emplace_back(
        TripleComponent{Variable{"?s"}},
        TripleComponent{TripleComponent::Iri{"<urn:type>"}},
        TripleComponent{TripleComponent::Iri{"<urn:Thing>"}});
    parsedQuery::GraphPattern child;
    child._graphPatterns.emplace_back(std::move(basic));
    query._rootGraphPattern._graphPatterns.emplace_back(
        parsedQuery::GroupGraphPattern{
            std::move(child),
            Variable{"?g"},
            parsedQuery::GroupGraphPattern::GraphVariableBehaviour::NAMED});
    return query;
  }
  static ParsedQuery predicateIriSelect() {
    ParsedQuery query;
    parsedQuery::BasicGraphPattern basic;
    basic._triples.emplace_back(
        TripleComponent{Variable{"?s"}},
        TripleComponent{TripleComponent::Iri{"<urn:p>"}},
        TripleComponent{Variable{"?o"}});
    query._rootGraphPattern._graphPatterns.emplace_back(std::move(basic));
    return query;
  }
  static ParsedQuery objectLiteralSelect() {
    ParsedQuery query;
    parsedQuery::BasicGraphPattern basic;
    basic._triples.emplace_back(
        TripleComponent{Variable{"?s"}},
        TripleComponent{Variable{"?p"}},
        TripleComponent{TripleComponent::Literal{"\\"value\\""}});
    query._rootGraphPattern._graphPatterns.emplace_back(std::move(basic));
    return query;
  }
  static ParsedQuery subjectFilterSelect() {
    ParsedQuery query;
    parsedQuery::BasicGraphPattern basic;
    basic._triples.emplace_back(
        TripleComponent{Variable{"?s"}},
        TripleComponent{Variable{"?p"}},
        TripleComponent{Variable{"?o"}});
    basic._triples.emplace_back(
        TripleComponent{Variable{"?s"}},
        TripleComponent{TripleComponent::Iri{"<urn:type>"}},
        TripleComponent{TripleComponent::Iri{"<urn:Thing>"}});
    query._rootGraphPattern._graphPatterns.emplace_back(std::move(basic));
    return query;
  }
  static ParsedQuery objectSubjectJoinSelect() {
    ParsedQuery query;
    parsedQuery::BasicGraphPattern basic;
    basic._triples.emplace_back(
        TripleComponent{Variable{"?s"}},
        TripleComponent{Variable{"?p"}},
        TripleComponent{Variable{"?o"}});
    basic._triples.emplace_back(
        TripleComponent{Variable{"?o"}},
        TripleComponent{Variable{"?p2"}},
        TripleComponent{Variable{"?tail"}});
    query.select_clause_.setSelected({Variable{"?s"}, Variable{"?tail"}});
    query._rootGraphPattern._graphPatterns.emplace_back(std::move(basic));
    return query;
  }
  static ParsedQuery filterObjectNotTailSelect() {
    ParsedQuery query;
    parsedQuery::BasicGraphPattern basic;
    basic._triples.emplace_back(
        TripleComponent{Variable{"?s"}},
        TripleComponent{Variable{"?p"}},
        TripleComponent{Variable{"?o"}});
    query.select_clause_.setSelected({Variable{"?s"}, Variable{"?o"}});
    SparqlFilter filter;
    filter.expression_ = sparqlExpression::SparqlExpressionPimpl{"(?o != <urn:tail>)"};
    query._rootGraphPattern._filters.push_back(std::move(filter));
    query._rootGraphPattern._graphPatterns.emplace_back(std::move(basic));
    return query;
  }
  static ParsedQuery filterObjectEqualsOSelect() {
    ParsedQuery query = filterObjectNotTailSelect();
    query._rootGraphPattern._filters[0].expression_ =
        sparqlExpression::SparqlExpressionPimpl{"(?o = <urn:o>)"};
    return query;
  }
  static ParsedQuery filterObjectEqualsOSelectSubjectOnly() {
    ParsedQuery query = filterObjectEqualsOSelect();
    query.select_clause_.setSelected({Variable{"?s"}});
    return query;
  }
  static ParsedQuery filterObjectEqualsLiteralSelect() {
    ParsedQuery query = filterObjectNotTailSelect();
    query._rootGraphPattern._filters[0].expression_ =
        sparqlExpression::SparqlExpressionPimpl{"(?o = \\"literal-value\\")"};
    return query;
  }
  static ParsedQuery filterLiteralEqualsObjectSelect() {
    ParsedQuery query = filterObjectNotTailSelect();
    query._rootGraphPattern._filters[0].expression_ =
        sparqlExpression::SparqlExpressionPimpl{"(\\"literal-value\\" = ?o)"};
    return query;
  }
  static ParsedQuery unsupportedFilterSelect() {
    ParsedQuery query = filterObjectNotTailSelect();
    query._rootGraphPattern._filters[0].expression_ =
        sparqlExpression::SparqlExpressionPimpl{"(?o < <urn:tail>)"};
    return query;
  }
  bool hasSelectClause() const { return select_; }
  bool hasAskClause() const { return ask_; }
  const SelectClause& selectClause() const { return select_clause_; }
  const std::vector<parsedQuery::GraphPatternOperation>& children() const {
    return _rootGraphPattern._graphPatterns;
  }
  parsedQuery::GraphPattern _rootGraphPattern;
  bool select_ = true;
  bool ask_ = false;
  SelectClause select_clause_;
};
`;

export const fakeSparqlTripleHeader = '#pragma once\n#include "parser/ParsedQuery.h"\n';

export const fakeQueryExecutionTreeHeader = `
#pragma once
#include <cstddef>
#include <memory>
#include <string>
#include <vector>
#include "global/Id.h"
class Operation;
class QueryExecutionTree {
 public:
  QueryExecutionTree() = default;
  explicit QueryExecutionTree(std::shared_ptr<Operation> root) : root_(root) {}
  bool isEmpty() const { return root_ == nullptr; }
  std::shared_ptr<Operation> getRootOperation() const { return root_; }
  const std::string& getDescriptor() const { return descriptor_; }
  size_t getResultWidth() const { return 0; }
  std::vector<ColumnIndex> resultSortedOn() const { return {}; }
 private:
  std::shared_ptr<Operation> root_;
  std::string descriptor_;
};
`;

export const fakeQueryPlannerHeader = `
#pragma once
#include <memory>
#include "engine/IndexScan.h"
#include "engine/QueryExecutionTree.h"
#include "parser/ParsedQuery.h"
class QueryPlanner {
 public:
  QueryPlanner() = default;
  void setReturnEmpty(bool value) { return_empty_ = value; }
  QueryExecutionTree createExecutionTree(ParsedQuery&, bool = false) {
    if (return_empty_) {
      return QueryExecutionTree();
    }
    return QueryExecutionTree(std::make_shared<IndexScan>());
  }
 private:
  bool return_empty_ = false;
};
`;

export const fakeJoinHeader = `
#pragma once
#include <memory>
#include <string>
#include <vector>
#include "engine/Operation.h"
#include "engine/QueryExecutionTree.h"
class Join final : public Operation {
 public:
  Join(std::shared_ptr<QueryExecutionTree> left,
       std::shared_ptr<QueryExecutionTree> right)
      : left_(std::move(left)), right_(std::move(right)) {}
  std::string getDescriptor() const override { return "Join on ?s"; }
  size_t getResultWidth() const override { return 3; }
  std::vector<QueryExecutionTree*> getChildren() override {
    return {left_.get(), right_.get()};
  }
  std::vector<const QueryExecutionTree*> getChildren() const {
    return {left_.get(), right_.get()};
  }
 protected:
  std::vector<ColumnIndex> resultSortedOn() const override { return {0}; }
 private:
  std::shared_ptr<QueryExecutionTree> left_;
  std::shared_ptr<QueryExecutionTree> right_;
};
`;


export const fakeDistinctHeader = `
#pragma once
#include <memory>
#include <string>
#include <vector>
#include "engine/Operation.h"
#include "engine/QueryExecutionTree.h"
class QueryExecutionContext;
class Distinct final : public Operation {
 public:
  Distinct(QueryExecutionContext*,
           std::shared_ptr<QueryExecutionTree> child,
           const std::vector<ColumnIndex>& distinct_columns)
      : child_(std::move(child)), distinct_columns_(distinct_columns) {}
  Distinct(std::shared_ptr<QueryExecutionTree> child,
           std::vector<ColumnIndex> distinct_columns)
      : child_(std::move(child)), distinct_columns_(std::move(distinct_columns)) {}
  std::string getDescriptor() const override { return "Distinct"; }
  size_t getResultWidth() const override {
    return child_ == nullptr ? 0 : child_->getRootOperation()->getResultWidth();
  }
  const std::vector<ColumnIndex>& getDistinctColumns() const {
    return distinct_columns_;
  }
  std::vector<QueryExecutionTree*> getChildren() override {
    return {child_.get()};
  }
  std::vector<const QueryExecutionTree*> getChildren() const {
    return {child_.get()};
  }
 protected:
  std::vector<ColumnIndex> resultSortedOn() const override {
    return child_ == nullptr ? std::vector<ColumnIndex>{}
                             : child_->getRootOperation()->getResultSortedOn();
  }
 private:
  std::shared_ptr<QueryExecutionTree> child_;
  std::vector<ColumnIndex> distinct_columns_;
};
`;


export const fakeGroupByHeader = `
#pragma once
#include <memory>
#include <string>
#include <utility>
#include <vector>
#include "engine/Operation.h"
#include "engine/QueryExecutionTree.h"
#include "parser/ParsedQuery.h"
class QueryExecutionContext;
class Alias {};
class GroupBy final : public Operation {
 public:
  using Aliases = std::vector<Alias>;
  GroupBy(QueryExecutionContext*,
          std::shared_ptr<QueryExecutionTree> child,
          std::vector<Variable> group_by_variables,
          Aliases aliases = {})
      : child_(std::move(child)),
        group_by_variables_(std::move(group_by_variables)),
        aliases_(std::move(aliases)) {}
  GroupBy(std::shared_ptr<QueryExecutionTree> child,
          std::vector<Variable> group_by_variables,
          Aliases aliases = {})
      : child_(std::move(child)),
        group_by_variables_(std::move(group_by_variables)),
        aliases_(std::move(aliases)) {}
  std::string getDescriptor() const override { return "GroupBy"; }
  size_t getResultWidth() const override {
    return group_by_variables_.size() + aliases_.size();
  }
  const std::vector<Variable>& groupByVariables() const {
    return group_by_variables_;
  }
  const Aliases& aliases() const { return aliases_; }
  std::vector<QueryExecutionTree*> getChildren() override {
    return {child_.get()};
  }
  std::vector<const QueryExecutionTree*> getChildren() const {
    return {child_.get()};
  }
 protected:
  std::vector<ColumnIndex> resultSortedOn() const override { return {}; }
 private:
  std::shared_ptr<QueryExecutionTree> child_;
  std::vector<Variable> group_by_variables_;
  Aliases aliases_;
};
`;

export const fakeMultiColumnJoinHeader = `
#pragma once
#include <memory>
#include <string>
#include <utility>
#include <vector>
#include "engine/Operation.h"
#include "engine/QueryExecutionTree.h"
class QueryExecutionContext;
class MultiColumnJoin final : public Operation {
 public:
  MultiColumnJoin(QueryExecutionContext*,
                  std::shared_ptr<QueryExecutionTree> left,
                  std::shared_ptr<QueryExecutionTree> right,
                  size_t result_width)
      : left_(std::move(left)),
        right_(std::move(right)),
        result_width_(result_width) {}
  MultiColumnJoin(std::shared_ptr<QueryExecutionTree> left,
                  std::shared_ptr<QueryExecutionTree> right,
                  size_t result_width)
      : left_(std::move(left)),
        right_(std::move(right)),
        result_width_(result_width) {}
  std::string getDescriptor() const override { return "MultiColumnJoin"; }
  size_t getResultWidth() const override { return result_width_; }
  std::vector<QueryExecutionTree*> getChildren() override {
    return {left_.get(), right_.get()};
  }
  std::vector<const QueryExecutionTree*> getChildren() const {
    return {left_.get(), right_.get()};
  }
 protected:
  std::vector<ColumnIndex> resultSortedOn() const override { return {}; }
 private:
  std::shared_ptr<QueryExecutionTree> left_;
  std::shared_ptr<QueryExecutionTree> right_;
  size_t result_width_;
};
`;


export const fakeFilterHeader = `
#pragma once
#include <memory>
#include <string>
#include <utility>
#include <vector>
#include "engine/Operation.h"
#include "engine/QueryExecutionTree.h"
#include "parser/ParsedQuery.h"
class QueryExecutionContext;
class Filter final : public Operation {
 public:
  Filter(QueryExecutionContext*,
         std::shared_ptr<QueryExecutionTree> child,
         sparqlExpression::SparqlExpressionPimpl expression)
      : child_(std::move(child)), expression_(std::move(expression)) {}
  Filter(std::shared_ptr<QueryExecutionTree> child,
         sparqlExpression::SparqlExpressionPimpl expression)
      : child_(std::move(child)), expression_(std::move(expression)) {}
  std::string getDescriptor() const override {
    return "Filter " + expression_.getDescriptor();
  }
  size_t getResultWidth() const override { return child_->getResultWidth(); }
  std::vector<QueryExecutionTree*> getChildren() override {
    return {child_.get()};
  }
  std::vector<const QueryExecutionTree*> getChildren() const {
    return {child_.get()};
  }
 protected:
  std::vector<ColumnIndex> resultSortedOn() const override {
    return child_ == nullptr ? std::vector<ColumnIndex>{}
                             : child_->resultSortedOn();
  }
 private:
  std::shared_ptr<QueryExecutionTree> child_;
  sparqlExpression::SparqlExpressionPimpl expression_;
};
`;


export const fakeOrderByHeader = `
#pragma once
#include <memory>
#include <string>
#include <utility>
#include <vector>
#include "engine/Operation.h"
#include "engine/QueryExecutionTree.h"
#include "parser/ParsedQuery.h"
class QueryExecutionContext;
class OrderBy final : public Operation {
 public:
  using SortIndices = std::vector<std::pair<ColumnIndex, bool>>;
  enum class AscOrDesc { Asc, Desc };
  using SortedVariables = std::vector<std::pair<Variable, AscOrDesc>>;
  OrderBy(QueryExecutionContext*,
          std::shared_ptr<QueryExecutionTree> child,
          SortIndices sort_indices)
      : child_(std::move(child)), sort_indices_(std::move(sort_indices)) {}
  OrderBy(std::shared_ptr<QueryExecutionTree> child,
          SortedVariables sorted_variables)
      : child_(std::move(child)), sorted_variables_(std::move(sorted_variables)) {}
  std::string getDescriptor() const override { return "OrderBy"; }
  size_t getResultWidth() const override {
    return child_ == nullptr ? 0 : child_->getRootOperation()->getResultWidth();
  }
  SortedVariables getSortedVariables() const { return sorted_variables_; }
  std::vector<QueryExecutionTree*> getChildren() override {
    return {child_.get()};
  }
  std::vector<const QueryExecutionTree*> getChildren() const {
    return {child_.get()};
  }
 protected:
  std::vector<ColumnIndex> resultSortedOn() const override { return {}; }
 private:
  std::shared_ptr<QueryExecutionTree> child_;
  SortIndices sort_indices_;
  SortedVariables sorted_variables_;
};
`;

export const fakeSortHeader = `
#pragma once
#include <memory>
#include <string>
#include <utility>
#include <vector>
#include "engine/Operation.h"
#include "engine/QueryExecutionTree.h"
class QueryExecutionContext;
class Sort final : public Operation {
 public:
  Sort(QueryExecutionContext*,
       std::shared_ptr<QueryExecutionTree> child,
       std::vector<ColumnIndex> sort_column_indices)
      : child_(std::move(child)),
        sort_column_indices_(std::move(sort_column_indices)) {}
  Sort(std::shared_ptr<QueryExecutionTree> child,
       std::vector<ColumnIndex> sort_column_indices)
      : child_(std::move(child)),
        sort_column_indices_(std::move(sort_column_indices)) {}
  std::string getDescriptor() const override { return "Sort"; }
  size_t getResultWidth() const override {
    return child_ == nullptr ? 0 : child_->getRootOperation()->getResultWidth();
  }
  std::vector<QueryExecutionTree*> getChildren() override {
    return {child_.get()};
  }
  std::vector<const QueryExecutionTree*> getChildren() const {
    return {child_.get()};
  }
  std::vector<ColumnIndex> resultSortedOn() const override {
    return sort_column_indices_;
  }
 private:
  std::shared_ptr<QueryExecutionTree> child_;
  std::vector<ColumnIndex> sort_column_indices_;
};
`;

export const fakeLimitOffsetHeader = `
#pragma once
#include <memory>
#include <string>
#include <vector>
#include "engine/Operation.h"
#include "engine/QueryExecutionTree.h"
class LimitOffset final : public Operation {
 public:
  LimitOffset(std::shared_ptr<QueryExecutionTree> child,
              size_t limit,
              size_t offset)
      : child_(std::move(child)), limit_(limit), offset_(offset) {}
  std::string getDescriptor() const override { return "LimitOffset"; }
  size_t getResultWidth() const override {
    return child_ == nullptr ? 0 : child_->getRootOperation()->getResultWidth();
  }
  size_t limit() const { return limit_; }
  size_t offset() const { return offset_; }
  std::vector<QueryExecutionTree*> getChildren() override {
    return {child_.get()};
  }
  std::vector<const QueryExecutionTree*> getChildren() const {
    return {child_.get()};
  }
 protected:
  std::vector<ColumnIndex> resultSortedOn() const override {
    return child_ == nullptr ? std::vector<ColumnIndex>{}
                             : child_->getRootOperation()->getResultSortedOn();
  }
 private:
  std::shared_ptr<QueryExecutionTree> child_;
  size_t limit_;
  size_t offset_;
};
`;

export const fakeIndexScanHeader = `
#pragma once
#include <string>
#include <utility>
#include <vector>
#include "engine/Operation.h"
#include "index/Permutation.h"
#include "parser/SparqlTriple.h"
class IndexScan final : public Operation {
 public:
  IndexScan()
      : subject_(Variable{"?s"}),
        predicate_(Variable{"?p"}),
        object_(Variable{"?o"}),
        permutation_(Permutation::Enum::SPO),
        descriptor_("IndexScan SPO ?s ?p ?o"),
        result_width_(3),
        sorted_({0}) {}
  IndexScan(
      TripleComponent subject,
      TripleComponent predicate,
      TripleComponent object,
      Permutation::Enum permutation,
      std::string descriptor,
      size_t result_width,
      std::vector<ColumnIndex> sorted)
      : subject_(std::move(subject)),
        predicate_(std::move(predicate)),
        object_(std::move(object)),
        permutation_(permutation),
        descriptor_(std::move(descriptor)),
        result_width_(result_width),
        sorted_(std::move(sorted)) {}
  const TripleComponent& subject() const { return subject_; }
  const TripleComponent& predicate() const { return predicate_; }
  const TripleComponent& object() const { return object_; }
  const Permutation& permutation() const { return permutation_; }
  std::string getDescriptor() const override { return descriptor_; }
  size_t getResultWidth() const override { return result_width_; }
 protected:
  std::vector<ColumnIndex> resultSortedOn() const override { return sorted_; }
 private:
  TripleComponent subject_;
  TripleComponent predicate_;
  TripleComponent object_;
  Permutation permutation_;
  std::string descriptor_;
  size_t result_width_;
  std::vector<ColumnIndex> sorted_;
};
`;

export const fakePermissiveSparqlParserHeader = '#pragma once\n#include <string>\n#include "parser/ParsedQuery.h"\nclass SparqlParser { public: static ParsedQuery parseQuery(const void*, std::string query) { if (query.find("<urn:type>") != std::string::npos) return ParsedQuery::subjectFilterSelect(); if (query.find("<urn:p>") != std::string::npos) return ParsedQuery::predicateIriSelect(); return ParsedQuery::minimalSelect(); } };\n';

export const fakeThrowingSparqlParserHeader = '#pragma once\n#include <stdexcept>\n#include <string>\n#include "parser/ParsedQuery.h"\nclass SparqlParser { public: static ParsedQuery parseQuery(const void*, std::string query) { if (query.find("BROKEN") != std::string::npos) throw std::runtime_error("synthetic parse failure"); if (query.find("<urn:type>") != std::string::npos) return ParsedQuery::subjectFilterSelect(); if (query.find("<urn:p>") != std::string::npos) return ParsedQuery::predicateIriSelect(); if (query.find("ASK") != std::string::npos) return ParsedQuery::minimalAsk(); if (query.find("SELECT") != std::string::npos) return ParsedQuery::minimalSelect(); ParsedQuery parsed; parsed.select_ = false; return parsed; } };\n';

export const fakeTextIndexScanForWordHeader = `
#pragma once
#include <string>
#include <utility>
#include <vector>
#include "engine/Operation.h"
#include "parser/ParsedQuery.h"
class TextIndexScanForWord final : public Operation {
 public:
  explicit TextIndexScanForWord(std::string word) : word_(std::move(word)) {}
  const Variable& textRecordVar() const { return text_record_var_; }
  const std::string& word() const { return word_; }
  std::string getDescriptor() const override { return "TextIndexScanForWord " + word_; }
  size_t getResultWidth() const override { return 1; }
 protected:
  std::vector<ColumnIndex> resultSortedOn() const override { return {}; }
 private:
  std::string word_;
  Variable text_record_var_{"?text"};
};
`;

export const fakeTextIndexScanForEntityHeader = `
#pragma once
#include <string>
#include <utility>
#include <vector>
#include "engine/Operation.h"
#include "parser/ParsedQuery.h"
class TextIndexScanForEntity final : public Operation {
 public:
  TextIndexScanForEntity(std::string word, std::string fixed_entity)
      : word_(std::move(word)), fixed_entity_(std::move(fixed_entity)), has_fixed_entity_(true) {}
  explicit TextIndexScanForEntity(std::string word)
      : word_(std::move(word)), has_fixed_entity_(false) {}
  bool hasFixedEntity() const { return has_fixed_entity_; }
  const std::string& fixedEntity() const { return fixed_entity_; }
  const Variable& entityVariable() const { return entity_var_; }
  const Variable& textRecordVar() const { return text_record_var_; }
  const std::string& word() const { return word_; }
  std::string getDescriptor() const override { return "TextIndexScanForEntity " + word_; }
  size_t getResultWidth() const override { return has_fixed_entity_ ? 1 : 2; }
 protected:
  std::vector<ColumnIndex> resultSortedOn() const override { return {}; }
 private:
  std::string word_;
  std::string fixed_entity_;
  bool has_fixed_entity_;
  Variable text_record_var_{"?text"};
  Variable entity_var_{"?entity"};
};
`;

export const fakeTextLimitHeader = `
#pragma once
#include <memory>
#include <string>
#include <utility>
#include <vector>
#include "engine/Operation.h"
#include "engine/QueryExecutionTree.h"
#include "parser/ParsedQuery.h"
class QueryExecutionContext;
class TextLimit final : public Operation {
 public:
  TextLimit(QueryExecutionContext*,
            size_t limit,
            std::shared_ptr<QueryExecutionTree> child,
            ColumnIndex text_record_column,
            std::vector<ColumnIndex> entity_columns,
            std::vector<ColumnIndex> score_columns)
      : limit_(limit),
        child_(std::move(child)),
        entity_columns_(std::move(entity_columns)),
        score_columns_(std::move(score_columns)) {
    (void)text_record_column;
  }
  TextLimit(size_t limit, std::shared_ptr<QueryExecutionTree> child)
      : limit_(limit), child_(std::move(child)) {}
  std::string getDescriptor() const override { return "TextLimit"; }
  size_t getResultWidth() const override {
    return child_ == nullptr ? 0 : child_->getRootOperation()->getResultWidth();
  }
  size_t getTextLimit() const { return limit_; }
  std::vector<QueryExecutionTree*> getChildren() override {
    return {child_.get()};
  }
 protected:
  std::vector<ColumnIndex> resultSortedOn() const override {
    return child_ == nullptr ? std::vector<ColumnIndex>{}
                             : child_->getRootOperation()->getResultSortedOn();
  }
 private:
  size_t limit_;
  std::shared_ptr<QueryExecutionTree> child_;
  std::vector<ColumnIndex> entity_columns_;
  std::vector<ColumnIndex> score_columns_;
};
`;

export const fakeNeutralElementOperationHeader = `
#pragma once
#include <string>
#include <vector>
#include "engine/Operation.h"
class NeutralElementOperation final : public Operation {
 public:
  std::vector<QueryExecutionTree*> getChildren() override { return {}; }
  std::string getDescriptor() const override { return "Neutral element"; }
  size_t getResultWidth() const override { return 0; }
 protected:
  std::vector<ColumnIndex> resultSortedOn() const override { return {}; }
};
`;

export const fakeUnionHeader = `
#pragma once
#include <array>
#include <memory>
#include <optional>
#include <string>
#include <utility>
#include <vector>
#include "engine/Operation.h"
#include "engine/QueryExecutionTree.h"
class QueryExecutionContext;
class Union final : public Operation {
 public:
  static constexpr size_t NO_COLUMN = static_cast<size_t>(-1);
  Union(QueryExecutionContext*,
        const std::shared_ptr<QueryExecutionTree>& left,
        const std::shared_ptr<QueryExecutionTree>& right,
        std::vector<ColumnIndex> target_order = {})
      : left_(left), right_(right), target_order_(std::move(target_order)) {
    size_t width = getResultWidth();
    column_origins_.resize(width);
    for (size_t column = 0; column < width; ++column) {
      column_origins_[column] = {column, column};
    }
  }
  Union(std::shared_ptr<QueryExecutionTree> left,
        std::shared_ptr<QueryExecutionTree> right,
        std::vector<std::array<size_t, 2>> column_origins,
        std::vector<ColumnIndex> target_order = {})
      : left_(std::move(left)),
        right_(std::move(right)),
        column_origins_(std::move(column_origins)),
        target_order_(std::move(target_order)) {}
  std::string getDescriptor() const override { return "Union"; }
  size_t getResultWidth() const override {
    if (!column_origins_.empty()) return column_origins_.size();
    return left_ == nullptr ? 0 : left_->getRootOperation()->getResultWidth();
  }
  std::vector<QueryExecutionTree*> getChildren() override {
    return {left_.get(), right_.get()};
  }
  std::vector<const QueryExecutionTree*> getChildren() const {
    return {left_.get(), right_.get()};
  }
  const std::shared_ptr<QueryExecutionTree>& leftChild() const { return left_; }
  const std::shared_ptr<QueryExecutionTree>& rightChild() const { return right_; }
  std::optional<ColumnIndex> getOriginalColumn(bool left_child, ColumnIndex union_column) const {
    if (union_column >= column_origins_.size()) return std::nullopt;
    size_t column = column_origins_[union_column][left_child ? 0 : 1];
    if (column == NO_COLUMN) return std::nullopt;
    return static_cast<ColumnIndex>(column);
  }
 protected:
  std::vector<ColumnIndex> resultSortedOn() const override { return target_order_; }
 private:
  std::shared_ptr<QueryExecutionTree> left_;
  std::shared_ptr<QueryExecutionTree> right_;
  std::vector<std::array<size_t, 2>> column_origins_;
  std::vector<ColumnIndex> target_order_;
};
`;

export const fakeCartesianProductJoinHeader = `
#pragma once
#include <memory>
#include <string>
#include <utility>
#include <vector>
#include "engine/Operation.h"
#include "engine/QueryExecutionTree.h"
class QueryExecutionContext;
class CartesianProductJoin final : public Operation {
 public:
  using Children = std::vector<std::shared_ptr<QueryExecutionTree>>;
  CartesianProductJoin(QueryExecutionContext*, Children children, size_t = 1000000)
      : children_(std::move(children)) {}
  explicit CartesianProductJoin(Children children)
      : children_(std::move(children)) {}
  std::vector<QueryExecutionTree*> getChildren() override {
    std::vector<QueryExecutionTree*> children;
    for (const auto& child : children_) {
      children.push_back(child.get());
    }
    return children;
  }
  std::string getDescriptor() const override { return "Cartesian Product Join"; }
  size_t getResultWidth() const override {
    size_t width = 0;
    for (const auto& child : children_) {
      width += child->getRootOperation()->getResultWidth();
    }
    return width;
  }
 protected:
  std::vector<ColumnIndex> resultSortedOn() const override { return {}; }
 private:
  Children children_;
};
`;

export const fakeMinusHeader = `
#pragma once
#include <memory>
#include <string>
#include <utility>
#include <vector>
#include "engine/Operation.h"
#include "engine/QueryExecutionTree.h"
class QueryExecutionContext;
class Minus final : public Operation {
 public:
  Minus(QueryExecutionContext*,
        std::shared_ptr<QueryExecutionTree> left,
        std::shared_ptr<QueryExecutionTree> right)
      : left_(std::move(left)), right_(std::move(right)) {}
  Minus(std::shared_ptr<QueryExecutionTree> left,
        std::shared_ptr<QueryExecutionTree> right)
      : left_(std::move(left)), right_(std::move(right)) {}
  std::vector<QueryExecutionTree*> getChildren() override {
    return {left_.get(), right_.get()};
  }
  std::string getDescriptor() const override { return "Minus"; }
  size_t getResultWidth() const override {
    return left_ == nullptr ? 0 : left_->getRootOperation()->getResultWidth();
  }
 protected:
  std::vector<ColumnIndex> resultSortedOn() const override {
    return left_ == nullptr ? std::vector<ColumnIndex>{}
                            : left_->getRootOperation()->getResultSortedOn();
  }
 private:
  std::shared_ptr<QueryExecutionTree> left_;
  std::shared_ptr<QueryExecutionTree> right_;
};
`;

export const fakeOptionalJoinHeader = `
#pragma once
#include <memory>
#include <string>
#include <utility>
#include <vector>
#include "engine/Operation.h"
#include "engine/QueryExecutionTree.h"
class QueryExecutionContext;
class OptionalJoin final : public Operation {
 public:
  OptionalJoin(QueryExecutionContext*,
               std::shared_ptr<QueryExecutionTree> left,
               std::shared_ptr<QueryExecutionTree> right,
               bool = true)
      : left_(std::move(left)), right_(std::move(right)) {}
  OptionalJoin(std::shared_ptr<QueryExecutionTree> left,
               std::shared_ptr<QueryExecutionTree> right)
      : left_(std::move(left)), right_(std::move(right)) {}
  std::vector<QueryExecutionTree*> getChildren() override {
    return {left_.get(), right_.get()};
  }
  std::string getDescriptor() const override { return "OptionalJoin"; }
  size_t getResultWidth() const override {
    if (left_ == nullptr || right_ == nullptr) return 0;
    return left_->getRootOperation()->getResultWidth() +
           right_->getRootOperation()->getResultWidth() - 1;
  }
 protected:
  std::vector<ColumnIndex> resultSortedOn() const override {
    return left_ == nullptr ? std::vector<ColumnIndex>{}
                            : left_->getRootOperation()->getResultSortedOn();
  }
 private:
  std::shared_ptr<QueryExecutionTree> left_;
  std::shared_ptr<QueryExecutionTree> right_;
};
`;
