export const fakeEncodedIriManagerHeader = '#pragma once\nclass EncodedIriManager {};\n';

export const fakeExportIdsHeader = `
#pragma once
#include <optional>
#include <string>
#include <utility>

namespace ql::exportIds {
template <typename IdT>
inline std::optional<std::pair<std::string, const char*>>
idToStringAndTypeForEncodedValue(const IdT&) {
  return std::nullopt;
}
}
`;

export const fakeRdfParserHeader = `
#pragma once
#include <string_view>
#include <vector>
#include "index/EncodedIriManager.h"
#include "parser/ParsedQuery.h"
template <typename Tokenizer>
class NQuadParser {};
template <typename Tokenizer>
class TurtleParser {};
class TurtleTriple {
 public:
  TripleComponent subject_{TripleComponent::UNDEF{}};
  TripleComponent predicate_{TripleComponent::UNDEF{}};
  TripleComponent object_{TripleComponent::UNDEF{}};
};
template <typename Parser>
class RdfStringParser {
 public:
  explicit RdfStringParser(const EncodedIriManager*) {}
  void setInputStream(std::string_view) {}
  std::vector<TurtleTriple> parseAndReturnAllTriples() { return {}; }
};
`;

export const fakeTokenizerCtreHeader = '#pragma once\nclass TokenizerCtre {};\n';

export const fakeCancellationHandleHeader = `
#pragma once
#include <stdexcept>
namespace ad_utility {
struct SharedCancellationHandle {};
class CancellationException : public std::runtime_error {
 public:
  CancellationException() : std::runtime_error("cancelled") {}
};
namespace detail {
class AllocationExceedsLimitException : public std::runtime_error {
 public:
  AllocationExceedsLimitException() : std::runtime_error("memory limit") {}
};
}
}
`;

export const fakeExistsExpressionHeader = `
#pragma once
class ParsedQuery;
namespace sparqlExpression {
class SparqlExpression {
 public:
  virtual ~SparqlExpression() = default;
};
class ExistsExpression : public SparqlExpression {
 public:
  explicit ExistsExpression(const ParsedQuery* argument)
      : argument_(argument) {}
  const ParsedQuery& argument() const {
    return *argument_;
  }
 private:
  const ParsedQuery* argument_ = nullptr;
};
}
`;

export const fakeParsedQueryHeader = `
#pragma once
#include <array>
#include <cstddef>
#include <memory>
#include <optional>
#include <string>
#include <utility>
#include <variant>
#include <vector>
#include "global/Id.h"
#if __has_include("engine/sparqlExpressions/ExistsExpression.h")
#include "engine/sparqlExpressions/ExistsExpression.h"
#define FAKE_QLEVER_HAS_EXISTS_EXPRESSION 1
#else
#define FAKE_QLEVER_HAS_EXISTS_EXPRESSION 0
#endif
class Variable {
 public:
  explicit Variable(std::string name) : name_(std::move(name)) {}
  const std::string& name() const { return name_; }
 private:
  std::string name_;
};
class GeoPoint {
 public:
  std::pair<std::string, std::string> toStringAndType() const {
    return {"POINT(0 0)", "http://www.opengis.net/ont/geosparql#wktLiteral"};
  }
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
  bool isString() const { return false; }
  std::string getString() const { return ""; }
  bool isUndef() const { return kind_ == Kind::Undef; }
  bool isId() const { return false; }
  Id getId() const { return Id::fromBits(0); }
  const std::variant<GeoPoint>& getVariant() const { return variant_; }
 private:
  enum class Kind { Variable, Iri, Literal, Undef };
  Kind kind_ = Kind::Variable;
  Variable variable_{""};
  Iri iri_{""};
  Literal literal_{""};
  std::variant<GeoPoint> variant_{GeoPoint{}};
};
class SparqlTripleSimple {
 public:
  SparqlTripleSimple(TripleComponent s, TripleComponent p, TripleComponent o)
      : s_(std::move(s)), p_(std::move(p)), o_(std::move(o)) {}
  TripleComponent s_;
  TripleComponent p_;
  TripleComponent o_;
};
class SparqlTripleSimpleWithGraph {
 public:
  using Graph = std::variant<std::monostate, TripleComponent::Iri>;
  SparqlTripleSimpleWithGraph(TripleComponent s, TripleComponent p,
                              TripleComponent o, Graph g = std::monostate{})
      : s_(std::move(s)), p_(std::move(p)), o_(std::move(o)), g_(std::move(g)) {}
  TripleComponent s_;
  TripleComponent p_;
  TripleComponent o_;
  Graph g_;
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
class GraphTerm {
 public:
  GraphTerm() : component_(TripleComponent::UNDEF{}) {}
  explicit GraphTerm(TripleComponent component) : component_(std::move(component)) {}
  TripleComponent toTripleComponent() const { return component_; }
  std::string toSparql() const { return ""; }
 private:
  TripleComponent component_;
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
#if !FAKE_QLEVER_HAS_EXISTS_EXPRESSION
class SparqlExpression {
 public:
  virtual ~SparqlExpression() = default;
};
#endif
class SparqlExpressionPimpl {
 public:
  SparqlExpressionPimpl() = default;
  explicit SparqlExpressionPimpl(std::string descriptor)
      : descriptor_(std::move(descriptor)) {}
  const std::string& getDescriptor() const { return descriptor_; }
  std::vector<const SparqlExpression*> getExistsExpressions() const {
    std::vector<const SparqlExpression*> expressions;
    expressions.reserve(exists_expressions_.size());
    for (const auto& expression : exists_expressions_) {
      expressions.push_back(expression.get());
    }
    return expressions;
  }
  void setExistsExpression(std::shared_ptr<SparqlExpression> expression) {
    exists_expressions_.clear();
    exists_expressions_.push_back(std::move(expression));
  }
  void addExistsExpression(std::shared_ptr<SparqlExpression> expression) {
    exists_expressions_.push_back(std::move(expression));
  }
 private:
  std::string descriptor_;
  std::vector<std::shared_ptr<SparqlExpression>> exists_expressions_;
};
}
class SparqlFilter {
 public:
  sparqlExpression::SparqlExpressionPimpl expression_;
};
class ParsedQuery;
namespace parsedQuery {
struct ConstructClause {
  std::vector<std::array<GraphTerm, 3>> triples_;
};
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
struct Bind {
  sparqlExpression::SparqlExpressionPimpl _expression;
  Variable _target;
  Bind(sparqlExpression::SparqlExpressionPimpl expression, Variable target)
      : _expression(std::move(expression)), _target(std::move(target)) {}
  std::string getDescriptor() const {
    return "BIND (" + _expression.getDescriptor() + " AS " + _target.name() + ")";
  }
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
struct Optional {
  GraphPattern _child;
  explicit Optional(GraphPattern child) : _child{std::move(child)} {}
};
struct Minus {
  GraphPattern _child;
  explicit Minus(GraphPattern child) : _child{std::move(child)} {}
};
struct Union {
  GraphPattern _child1;
  GraphPattern _child2;
  Union(GraphPattern left, GraphPattern right)
      : _child1{std::move(left)}, _child2{std::move(right)} {}
};
struct DescribeSubquery {
  const ParsedQuery* query = nullptr;
  const ParsedQuery& get() const { return *query; }
};
struct Describe {
  DescribeSubquery whereClause_;
};
using GraphPatternOperationVariant = std::variant<BasicGraphPattern, Values, Bind, GroupGraphPattern, Optional, Minus, Union, Describe>;
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
namespace updateClause {
struct UpdateTriples {
  std::vector<SparqlTripleSimpleWithGraph> triples_;
};
struct GraphUpdate {
  UpdateTriples toDelete_;
  UpdateTriples toInsert_;
};
struct Update {
  GraphUpdate op_;
};
}
namespace ad_utility {
class BlankNodeManager {
 public:
  class LocalBlankNodeManager {
   public:
    explicit LocalBlankNodeManager(BlankNodeManager&) {}
    explicit LocalBlankNodeManager(BlankNodeManager*) {}
    size_t getId() const { return 0; }
  };
};
}
namespace parsedQuery {
struct LimitOffsetClause {
  bool isUnconstrained() const { return true; }
  size_t limitOrDefault() const { return 0; }
  size_t _offset = 0;
};
struct OrderKey {
  Variable variable_;
  bool isDescending_ = false;
};
struct DatasetClauses {
  using Graphs = std::optional<std::vector<TripleComponent::Iri>>;
  const Graphs& activeDefaultGraphs() const { return active_default_graphs_; }
  const Graphs& namedGraphs() const { return named_graphs_; }
  Graphs active_default_graphs_;
  Graphs named_graphs_;
};
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
  static ParsedQuery objectPredicateTailSelect() {
    ParsedQuery query;
    parsedQuery::BasicGraphPattern basic;
    basic._triples.emplace_back(
        TripleComponent{Variable{"?o"}},
        TripleComponent{TripleComponent::Iri{"<urn:p2>"}},
        TripleComponent{Variable{"?tail"}});
    query.select_clause_.setSelected({Variable{"?o"}, Variable{"?tail"}});
    query._rootGraphPattern._graphPatterns.emplace_back(std::move(basic));
    return query;
  }
  static ParsedQuery objectMissingPredicateTailSelect() {
    ParsedQuery query;
    parsedQuery::BasicGraphPattern basic;
    basic._triples.emplace_back(
        TripleComponent{Variable{"?o"}},
        TripleComponent{TripleComponent::Iri{"<urn:missing-p>"}},
        TripleComponent{Variable{"?tail2"}});
    query.select_clause_.setSelected({Variable{"?o"}, Variable{"?tail2"}});
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
  static ParsedQuery filterSubjectStrstartsSelectObjectOnly() {
    ParsedQuery query = filterObjectNotTailSelect();
    query.select_clause_.setSelected({Variable{"?o"}});
    query._rootGraphPattern._filters[0].expression_ =
        sparqlExpression::SparqlExpressionPimpl{
            "STRSTARTS(STR(?s), \\"urn:s\\")"};
    return query;
  }
  static ParsedQuery filterSubjectContainsSelectObjectOnly() {
    ParsedQuery query = filterObjectNotTailSelect();
    query.select_clause_.setSelected({Variable{"?o"}});
    query._rootGraphPattern._filters[0].expression_ =
        sparqlExpression::SparqlExpressionPimpl{
            "CONTAINS(STR(?s), \\"literal\\")"};
    return query;
  }
  static ParsedQuery filterObjectLanguageEnglishSelectSubjectOnly() {
    ParsedQuery query = filterObjectNotTailSelect();
    query.select_clause_.setSelected({Variable{"?s"}});
    query._rootGraphPattern._filters[0].expression_ =
        sparqlExpression::SparqlExpressionPimpl{
            "LANG(?o) = \\"en\\""};
    return query;
  }
  static ParsedQuery postprocessedLanguagePredicateSelectSubjectOnly() {
    ParsedQuery query;
    parsedQuery::BasicGraphPattern basic;
    basic._triples.emplace_back(
        TripleComponent{Variable{"?s"}},
        TripleComponent{TripleComponent::Iri{"@en@<urn:p0-filter/label>"}},
        TripleComponent{Variable{"?label"}});
    query.select_clause_.setSelected({Variable{"?s"}});
    query._rootGraphPattern._graphPatterns.emplace_back(std::move(basic));
    return query;
  }
  static ParsedQuery malformedLanguagePredicateSelectSubjectOnly() {
    ParsedQuery query;
    parsedQuery::BasicGraphPattern basic;
    basic._triples.emplace_back(
        TripleComponent{Variable{"?s"}},
        TripleComponent{TripleComponent::Iri{"@en@urn:p0-filter/label"}},
        TripleComponent{Variable{"?label"}});
    query.select_clause_.setSelected({Variable{"?s"}});
    query._rootGraphPattern._graphPatterns.emplace_back(std::move(basic));
    return query;
  }
  static ParsedQuery filterObjectDatatypeStringSelectSubjectOnly() {
    ParsedQuery query = filterObjectNotTailSelect();
    query.select_clause_.setSelected({Variable{"?s"}});
    query._rootGraphPattern._filters[0].expression_ =
        sparqlExpression::SparqlExpressionPimpl{
            "DATATYPE(?o) = <http://www.w3.org/2001/XMLSchema#string>"};
    return query;
  }
  static ParsedQuery filterObjectDatatypeIntegerSelectSubjectOnly() {
    ParsedQuery query = filterObjectNotTailSelect();
    query.select_clause_.setSelected({Variable{"?s"}});
    query._rootGraphPattern._filters[0].expression_ =
        sparqlExpression::SparqlExpressionPimpl{
            "DATATYPE(?o) = <http://www.w3.org/2001/XMLSchema#integer>"};
    return query;
  }
  static ParsedQuery filterSubjectStrendsSelectObjectOnly() {
    ParsedQuery query = filterObjectNotTailSelect();
    query.select_clause_.setSelected({Variable{"?o"}});
    query._rootGraphPattern._filters[0].expression_ =
        sparqlExpression::SparqlExpressionPimpl{
            "STRENDS(STR(?s), \\"literal-s\\")"};
    return query;
  }
  static ParsedQuery filterSubjectLcaseEqualsSelectObjectOnly() {
    ParsedQuery query = filterObjectNotTailSelect();
    query.select_clause_.setSelected({Variable{"?o"}});
    query._rootGraphPattern._filters[0].expression_ =
        sparqlExpression::SparqlExpressionPimpl{
            "LCASE(STR(?s)) = \\"urn:s\\""};
    return query;
  }
  static ParsedQuery filterSubjectLcaseNotEqualsLiteralSelectObjectOnly() {
    ParsedQuery query = filterObjectNotTailSelect();
    query.select_clause_.setSelected({Variable{"?o"}});
    query._rootGraphPattern._filters[0].expression_ =
        sparqlExpression::SparqlExpressionPimpl{
            "LCASE(STR(?s)) != \\"urn:literal-s\\""};
    return query;
  }
  static ParsedQuery filterSubjectUcaseEqualsSelectObjectOnly() {
    ParsedQuery query = filterObjectNotTailSelect();
    query.select_clause_.setSelected({Variable{"?o"}});
    query._rootGraphPattern._filters[0].expression_ =
        sparqlExpression::SparqlExpressionPimpl{
            "UCASE(STR(?s)) = \\"URN:S\\""};
    return query;
  }
  static ParsedQuery filterSubjectRegexPrefixSelectObjectOnly() {
    ParsedQuery query = filterObjectNotTailSelect();
    query.select_clause_.setSelected({Variable{"?o"}});
    query._rootGraphPattern._filters[0].expression_ =
        sparqlExpression::SparqlExpressionPimpl{
            "REGEX(STR(?s), \\"^urn:literal\\")"};
    return query;
  }
  static ParsedQuery filterObjectEqualsLiteralSelect() {
    ParsedQuery query = filterObjectNotTailSelect();
    query._rootGraphPattern._filters[0].expression_ =
        sparqlExpression::SparqlExpressionPimpl{"(?o = \\"literal-value\\")"};
    return query;
  }
  static ParsedQuery filterObjectInSelect() {
    ParsedQuery query = filterObjectNotTailSelect();
    query._rootGraphPattern._filters[0].expression_ =
        sparqlExpression::SparqlExpressionPimpl{"(?o IN (<urn:o>, <urn:tail>))"};
    return query;
  }
  static ParsedQuery filterObjectNotInSelect() {
    ParsedQuery query = filterObjectNotTailSelect();
    query._rootGraphPattern._filters[0].expression_ =
        sparqlExpression::SparqlExpressionPimpl{"(?o NOT IN (<urn:tail>))"};
    return query;
  }
  static ParsedQuery filterObjectInIntegerSelect() {
    ParsedQuery query = filterObjectNotTailSelect();
    query._rootGraphPattern._filters[0].expression_ =
        sparqlExpression::SparqlExpressionPimpl{"(?o IN (1, 2))"};
    return query;
  }
  static ParsedQuery filterObjectNotInBoolSelect() {
    ParsedQuery query = filterObjectNotTailSelect();
    query._rootGraphPattern._filters[0].expression_ =
        sparqlExpression::SparqlExpressionPimpl{"(?o NOT IN (false))"};
    return query;
  }
  static ParsedQuery filterObjectGreaterThanIntegerSelect() {
    ParsedQuery query = filterObjectNotTailSelect();
    query._rootGraphPattern._filters[0].expression_ =
        sparqlExpression::SparqlExpressionPimpl{"(?o > 1)"};
    return query;
  }
  static ParsedQuery filterObjectGreaterAndSubjectLiteralSelect() {
    ParsedQuery query = filterObjectNotTailSelect();
    query._rootGraphPattern._filters[0].expression_ =
        sparqlExpression::SparqlExpressionPimpl{
            "((?o > 1) && (?s = <urn:literal-s>))"};
    return query;
  }
  static ParsedQuery filterObjectTailOrOSelect() {
    ParsedQuery query = filterObjectNotTailSelect();
    query._rootGraphPattern._filters[0].expression_ =
        sparqlExpression::SparqlExpressionPimpl{
            "((?o = <urn:tail>) || (?o = <urn:o>))"};
    return query;
  }
#if FAKE_QLEVER_HAS_EXISTS_EXPRESSION
  static ParsedQuery filterObjectTailOrExistsSelect() {
    ParsedQuery query = filterObjectNotTailSelect();
    static ParsedQuery exists_argument = objectPredicateTailSelect();
    query._rootGraphPattern._filters[0].expression_ =
        sparqlExpression::SparqlExpressionPimpl{
            "((?o = <urn:tail>) || EXISTS { ?o <urn:p2> ?tail })"};
    query._rootGraphPattern._filters[0].expression_.setExistsExpression(
        std::make_shared<sparqlExpression::ExistsExpression>(&exists_argument));
    return query;
  }
  static ParsedQuery filterObjectOAndExistsSelect() {
    ParsedQuery query = filterObjectNotTailSelect();
    static ParsedQuery exists_argument = objectPredicateTailSelect();
    query._rootGraphPattern._filters[0].expression_ =
        sparqlExpression::SparqlExpressionPimpl{
            "((?o = <urn:o>) && EXISTS { ?o <urn:p2> ?tail })"};
    query._rootGraphPattern._filters[0].expression_.setExistsExpression(
        std::make_shared<sparqlExpression::ExistsExpression>(&exists_argument));
    return query;
  }
  static ParsedQuery filterObjectOAndExistsOrMissingSubjectSelect() {
    ParsedQuery query = filterObjectNotTailSelect();
    static ParsedQuery exists_argument = objectPredicateTailSelect();
    query._rootGraphPattern._filters[0].expression_ =
        sparqlExpression::SparqlExpressionPimpl{
            "(((?o = <urn:o>) && EXISTS { ?o <urn:p2> ?tail }) || "
            "(?s = <urn:missing>))"};
    query._rootGraphPattern._filters[0].expression_.setExistsExpression(
        std::make_shared<sparqlExpression::ExistsExpression>(&exists_argument));
    return query;
  }
  static ParsedQuery filterConstantSubjectOAndExistsOrMissingSubjectSelect() {
    ParsedQuery query;
    parsedQuery::BasicGraphPattern basic;
    basic._triples.emplace_back(
        TripleComponent{TripleComponent::Iri{"<urn:s>"}},
        TripleComponent{TripleComponent::Iri{"<urn:p>"}},
        TripleComponent{Variable{"?o"}});
    query.select_clause_.setSelected({Variable{"?o"}});
    SparqlFilter filter;
    static ParsedQuery exists_argument = objectPredicateTailSelect();
    filter.expression_ = sparqlExpression::SparqlExpressionPimpl{
        "(((?o = <urn:o>) && EXISTS { ?o <urn:p2> ?tail }) || "
        "(?s = <urn:missing>))"};
    filter.expression_.setExistsExpression(
        std::make_shared<sparqlExpression::ExistsExpression>(&exists_argument));
    query._rootGraphPattern._filters.push_back(std::move(filter));
    query._rootGraphPattern._graphPatterns.emplace_back(std::move(basic));
    return query;
  }
  static ParsedQuery filterTwoExistsSelect() {
    ParsedQuery query = filterObjectNotTailSelect();
    static ParsedQuery exists_argument = objectPredicateTailSelect();
    static ParsedQuery missing_exists_argument = objectMissingPredicateTailSelect();
    query._rootGraphPattern._filters[0].expression_ =
        sparqlExpression::SparqlExpressionPimpl{
            "(EXISTS { ?o <urn:p2> ?tail } || "
            "EXISTS { ?o <urn:missing-p> ?tail2 })"};
    query._rootGraphPattern._filters[0].expression_.setExistsExpression(
        std::make_shared<sparqlExpression::ExistsExpression>(&exists_argument));
    query._rootGraphPattern._filters[0].expression_.addExistsExpression(
        std::make_shared<sparqlExpression::ExistsExpression>(&missing_exists_argument));
    return query;
  }
#endif
  static ParsedQuery filterObjectTailAndMissingSubjectOrOSelect() {
    ParsedQuery query = filterObjectNotTailSelect();
    query._rootGraphPattern._filters[0].expression_ =
        sparqlExpression::SparqlExpressionPimpl{
            "(((?o = <urn:tail>) && (?s = <urn:literal-s>)) || "
            "(?o = <urn:o>))"};
    return query;
  }
  static ParsedQuery filterNotObjectEqualsTailSelect() {
    ParsedQuery query = filterObjectNotTailSelect();
    query._rootGraphPattern._filters[0].expression_ =
        sparqlExpression::SparqlExpressionPimpl{"(!(?o = <urn:tail>))"};
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
  static ParsedQuery insertDataUpdate(bool named_graph = false) {
    ParsedQuery query;
    query.select_ = false;
    query.has_update_clause_ = true;
    updateClause::UpdateTriples& triples = query.update_clause_.op_.toInsert_;
    triples.triples_.emplace_back(
        TripleComponent{TripleComponent::Iri{"<urn:s>"}},
        TripleComponent{TripleComponent::Iri{"<urn:p>"}},
        TripleComponent{TripleComponent::Iri{"<urn:o>"}},
        named_graph
            ? SparqlTripleSimpleWithGraph::Graph{TripleComponent::Iri{"<urn:g>"}}
            : SparqlTripleSimpleWithGraph::Graph{std::monostate{}});
    return query;
  }
  static ParsedQuery deleteDataUpdate(bool named_graph = false) {
    ParsedQuery query;
    query.select_ = false;
    query.has_update_clause_ = true;
    updateClause::UpdateTriples& triples = query.update_clause_.op_.toDelete_;
    triples.triples_.emplace_back(
        TripleComponent{TripleComponent::Iri{"<urn:s>"}},
        TripleComponent{TripleComponent::Iri{"<urn:p>"}},
        TripleComponent{TripleComponent::Iri{"<urn:o>"}},
        named_graph
            ? SparqlTripleSimpleWithGraph::Graph{TripleComponent::Iri{"<urn:g>"}}
            : SparqlTripleSimpleWithGraph::Graph{std::monostate{}});
    return query;
  }
  bool hasSelectClause() const { return select_; }
  bool hasAskClause() const { return ask_; }
  bool hasConstructClause() const { return false; }
  bool hasUpdateClause() const { return has_update_clause_; }
  const updateClause::Update& updateClause() const { return update_clause_; }
  const SelectClause& selectClause() const { return select_clause_; }
  const parsedQuery::ConstructClause& constructClause() const {
    return construct_clause_;
  }
  const std::vector<parsedQuery::GraphPatternOperation>& children() const {
    return _rootGraphPattern._graphPatterns;
  }
  parsedQuery::GraphPattern _rootGraphPattern;
  std::vector<parsedQuery::OrderKey> _orderBy;
  parsedQuery::LimitOffsetClause _limitOffset;
  bool select_ = true;
  bool ask_ = false;
  bool has_update_clause_ = false;
  SelectClause select_clause_;
  parsedQuery::ConstructClause construct_clause_;
  updateClause::Update update_clause_;
  parsedQuery::DatasetClauses datasetClauses_;
};
`;

export const fakeExternalValuesParsedQueryHeader = fakeParsedQueryHeader
  .replace(
    '  explicit TripleComponent(UNDEF) : kind_(Kind::Undef) {}',
    '  explicit TripleComponent(UNDEF) : kind_(Kind::Undef) {}\n  explicit TripleComponent(Id id) : kind_(Kind::Id), id_(id) {}',
  )
  .replace(
    '  enum class Kind { Variable, Iri, Literal, Undef };',
    '  enum class Kind { Variable, Iri, Literal, Undef, Id };',
  )
  .replace(
    '  std::variant<GeoPoint> variant_{GeoPoint{}};',
    '  std::variant<GeoPoint> variant_{GeoPoint{}};\n  Id id_{Id::fromBits(0)};',
  )
  .replace(
    'struct Values {\n  SparqlValues _inlineValues;\n  size_t _id = static_cast<size_t>(-1);\n};',
    'struct Values {\n  SparqlValues _inlineValues;\n  size_t _id = static_cast<size_t>(-1);\n};\nstruct ExternalValuesQuery {\n  std::string name_;\n  std::vector<Variable> variables_;\n};',
  )
  .replace(
    'using GraphPatternOperationVariant = std::variant<BasicGraphPattern, Values, Bind, GroupGraphPattern, Optional, Minus, Union, Describe>;',
    'using GraphPatternOperationVariant = std::variant<BasicGraphPattern, Values, ExternalValuesQuery, Bind, GroupGraphPattern, Optional, Minus, Union, Describe>;',
  );

export const fakeExternalValuesHeader = `
#pragma once
#include <string>
#include <utility>
#include "parser/ExternalValuesQuery.h"
class ExternalValues {
 public:
  const std::string& getName() const { return name_; }
  void updateValues(parsedQuery::SparqlValues newValues) {
    values_ = std::move(newValues);
  }
 private:
  std::string name_;
  parsedQuery::SparqlValues values_;
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
enum class LimitOffsetHandling { NONE };
class QueryExecutionTree {
 public:
  QueryExecutionTree() = default;
  explicit QueryExecutionTree(std::shared_ptr<Operation> root) : root_(root) {}
  bool isEmpty() const { return root_ == nullptr; }
  std::shared_ptr<Operation> getRootOperation() const { return root_; }
  const std::string& getDescriptor() const { return descriptor_; }
  size_t getResultWidth() const { return 0; }
  std::vector<ColumnIndex> resultSortedOn() const { return {}; }
  LimitOffsetHandling handlesLimitOffset() const {
    return LimitOffsetHandling::NONE;
  }
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
  Join(std::shared_ptr<QueryExecutionTree> left,
       std::shared_ptr<QueryExecutionTree> right,
       size_t result_width,
       VariableToColumnMap variable_columns,
       std::string descriptor)
      : left_(std::move(left)),
        right_(std::move(right)),
        result_width_(result_width),
        configured_variable_columns_(std::move(variable_columns)),
        descriptor_(std::move(descriptor)) {}
  std::string getDescriptor() const override { return descriptor_; }
  size_t getResultWidth() const override { return result_width_; }
  std::vector<QueryExecutionTree*> getChildren() override {
    return {left_.get(), right_.get()};
  }
  std::vector<const QueryExecutionTree*> getChildren() const {
    return {left_.get(), right_.get()};
  }
  const VariableToColumnMap& getExternallyVisibleVariableColumns() const override {
    if (!configured_variable_columns_.empty()) {
      return configured_variable_columns_;
    }
    variable_columns_.clear();
    variable_columns_.push_back({Variable{"?s"}, {0}});
    variable_columns_.push_back({Variable{"?p"}, {1}});
    variable_columns_.push_back({Variable{"?o"}, {2}});
    return variable_columns_;
  }
 protected:
  std::vector<ColumnIndex> resultSortedOn() const override { return {0}; }
 private:
  std::shared_ptr<QueryExecutionTree> left_;
  std::shared_ptr<QueryExecutionTree> right_;
  size_t result_width_ = 3;
  VariableToColumnMap configured_variable_columns_;
  std::string descriptor_ = "Join on ?s";
  mutable VariableToColumnMap variable_columns_;
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
#include <variant>
#include <vector>
#include "engine/Operation.h"
#include "engine/QueryExecutionTree.h"
#include "parser/ParsedQuery.h"
class QueryExecutionContext;
class Alias {
 public:
  explicit Alias(Variable target = Variable{"?alias"}) : _target(std::move(target)) {}
  Variable _target;
};
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

export const fakeExistsJoinHeader = `
#pragma once
#include <memory>
#include <string>
#include <utility>
#include <vector>
#include "engine/Operation.h"
#include "engine/QueryExecutionTree.h"
#include "parser/ParsedQuery.h"
class QueryExecutionContext;
class ExistsJoin final : public Operation {
 public:
  ExistsJoin(QueryExecutionContext*,
             std::shared_ptr<QueryExecutionTree> left,
             std::shared_ptr<QueryExecutionTree> right,
             Variable exists_variable)
      : left_(std::move(left)),
        right_(std::move(right)),
        exists_variable_(std::move(exists_variable)) {}
  ExistsJoin(std::shared_ptr<QueryExecutionTree> left,
             std::shared_ptr<QueryExecutionTree> right,
             Variable exists_variable)
      : left_(std::move(left)),
        right_(std::move(right)),
        exists_variable_(std::move(exists_variable)) {}
  std::vector<QueryExecutionTree*> getChildren() override {
    return {left_.get(), right_.get()};
  }
  std::string getDescriptor() const override { return "Exists Join"; }
  size_t getResultWidth() const override {
    return left_ == nullptr ? 1 : left_->getRootOperation()->getResultWidth() + 1;
  }
  const VariableToColumnMap& getExternallyVisibleVariableColumns() const override {
    variable_columns_.clear();
    variable_columns_.push_back({Variable{"?o"}, {0}});
    variable_columns_.push_back({Variable{"?s"}, {1}});
    variable_columns_.push_back({exists_variable_, {2}});
    return variable_columns_;
  }
 protected:
  std::vector<ColumnIndex> resultSortedOn() const override {
    return left_ == nullptr ? std::vector<ColumnIndex>{}
                            : left_->getRootOperation()->getResultSortedOn();
  }
 private:
  std::shared_ptr<QueryExecutionTree> left_;
  std::shared_ptr<QueryExecutionTree> right_;
  Variable exists_variable_;
  mutable VariableToColumnMap variable_columns_;
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

export const fakeBindHeader = `
#pragma once
#include <memory>
#include <string>
#include <utility>
#include <vector>
#include "engine/Operation.h"
#include "engine/QueryExecutionTree.h"
#include "parser/ParsedQuery.h"
class QueryExecutionContext;
class Bind final : public Operation {
 public:
  Bind(QueryExecutionContext*,
       std::shared_ptr<QueryExecutionTree> child,
       parsedQuery::Bind bind)
      : child_(std::move(child)), bind_(std::move(bind)) {}
  Bind(std::shared_ptr<QueryExecutionTree> child,
       parsedQuery::Bind bind)
      : child_(std::move(child)), bind_(std::move(bind)) {}
  const parsedQuery::Bind& bind() const { return bind_; }
  std::string getDescriptor() const override {
    return bind_.getDescriptor();
  }
  size_t getResultWidth() const override {
    return child_ == nullptr ? 1 : child_->getRootOperation()->getResultWidth() + 1;
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
                             : child_->resultSortedOn();
  }
 private:
  std::shared_ptr<QueryExecutionTree> child_;
  parsedQuery::Bind bind_;
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
class GraphFilter {
 public:
  struct AllTag {};
  using FilterType =
      std::variant<AllTag, TripleComponent, std::vector<TripleComponent>>;
  bool areAllGraphsAllowed() const { return true; }
  const FilterType& xpodPhysicalFilterType() const { return filter_; }
 private:
  FilterType filter_{AllTag{}};
};
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
      std::vector<ColumnIndex> sorted,
      std::vector<ColumnIndex> additional_columns = {},
      std::vector<Variable> additional_variables = {})
      : subject_(std::move(subject)),
        predicate_(std::move(predicate)),
        object_(std::move(object)),
        permutation_(permutation),
        descriptor_(std::move(descriptor)),
        result_width_(result_width),
        sorted_(std::move(sorted)),
        additional_columns_(std::move(additional_columns)),
        additional_variables_(std::move(additional_variables)) {}
  const TripleComponent& subject() const { return subject_; }
  const TripleComponent& predicate() const { return predicate_; }
  const TripleComponent& object() const { return object_; }
  const Permutation& permutation() const { return permutation_; }
  const std::vector<ColumnIndex>& additionalColumns() const { return additional_columns_; }
  const std::vector<Variable>& additionalVariables() const { return additional_variables_; }
  const GraphFilter& graphsToFilter() const { return graph_filter_; }
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
  std::vector<ColumnIndex> additional_columns_;
  std::vector<Variable> additional_variables_;
  GraphFilter graph_filter_;
};
`;

export const fakePermissiveSparqlParserHeader = '#pragma once\n#include <string>\n#include <vector>\n#include "parser/ParsedQuery.h"\nclass EncodedIriManager;\nclass SparqlParser { public: static ParsedQuery parseQuery(const void*, std::string query) { if (query.find("<urn:type>") != std::string::npos) return ParsedQuery::subjectFilterSelect(); if (query.find("<urn:p>") != std::string::npos) return ParsedQuery::predicateIriSelect(); return ParsedQuery::minimalSelect(); } static std::vector<ParsedQuery> parseUpdate(ad_utility::BlankNodeManager*, EncodedIriManager*, std::string query) { const bool named_graph = query.find("GRAPH") != std::string::npos; if (query.find("DELETE") != std::string::npos) return {ParsedQuery::deleteDataUpdate(named_graph)}; return {ParsedQuery::insertDataUpdate(named_graph)}; } };\n';

export const fakeThrowingSparqlParserHeader = '#pragma once\n#include <stdexcept>\n#include <string>\n#include <vector>\n#include "parser/ParsedQuery.h"\nclass EncodedIriManager;\nclass SparqlParser { public: static ParsedQuery parseQuery(const void*, std::string query) { if (query.find("BROKEN") != std::string::npos) throw std::runtime_error("synthetic parse failure"); if (query.find("<urn:type>") != std::string::npos) return ParsedQuery::subjectFilterSelect(); if (query.find("<urn:p>") != std::string::npos) return ParsedQuery::predicateIriSelect(); if (query.find("ASK") != std::string::npos) return ParsedQuery::minimalAsk(); if (query.find("SELECT") != std::string::npos) return ParsedQuery::minimalSelect(); ParsedQuery parsed; parsed.select_ = false; return parsed; } static std::vector<ParsedQuery> parseUpdate(ad_utility::BlankNodeManager*, EncodedIriManager*, std::string query) { const bool named_graph = query.find("GRAPH") != std::string::npos; if (query.find("DELETE") != std::string::npos) return {ParsedQuery::deleteDataUpdate(named_graph)}; return {ParsedQuery::insertDataUpdate(named_graph)}; } };\n';

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
  size_t getResultWidth() const override { return isPrefix() ? 2 : 1; }
  const VariableToColumnMap& getExternallyVisibleVariableColumns() const override {
    variable_columns_.clear();
    variable_columns_.push_back({text_record_var_, {0}});
    if (isPrefix()) variable_columns_.push_back({match_var_, {1}});
    return variable_columns_;
  }
 protected:
  std::vector<ColumnIndex> resultSortedOn() const override { return {}; }
 private:
  bool isPrefix() const { return !word_.empty() && word_.back() == '*'; }
  std::string word_;
  Variable text_record_var_{"?text"};
  Variable match_var_{"?match"};
  mutable VariableToColumnMap variable_columns_;
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
