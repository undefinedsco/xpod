export const fakeParsedQueryHeader = `
#pragma once
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
  bool isVariable() const { return kind_ == Kind::Variable; }
  const Variable& getVariable() const { return variable_; }
  bool isIri() const { return kind_ == Kind::Iri; }
  const Iri& getIri() const { return iri_; }
  bool isLiteral() const { return kind_ == Kind::Literal; }
  const Literal& getLiteral() const { return literal_; }
 private:
  enum class Kind { Variable, Iri, Literal };
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
namespace parsedQuery {
struct BasicGraphPattern {
  std::vector<SparqlTriple> _triples;
};
using GraphPatternOperationVariant = std::variant<BasicGraphPattern>;
struct GraphPatternOperation : public GraphPatternOperationVariant {
  using GraphPatternOperationVariant::GraphPatternOperationVariant;
};
struct GraphPattern {
  std::vector<GraphPatternOperation> _graphPatterns;
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
  bool hasSelectClause() const { return select_; }
  const std::vector<parsedQuery::GraphPatternOperation>& children() const {
    return _rootGraphPattern._graphPatterns;
  }
  parsedQuery::GraphPattern _rootGraphPattern;
  bool select_ = true;
};
`;

export const fakeSparqlTripleHeader = '#pragma once\n#include "parser/ParsedQuery.h"\n';

export const fakePermissiveSparqlParserHeader = '#pragma once\n#include <string>\n#include "parser/ParsedQuery.h"\nclass SparqlParser { public: static ParsedQuery parseQuery(const void*, std::string query) { if (query.find("<urn:type>") != std::string::npos) return ParsedQuery::subjectFilterSelect(); if (query.find("<urn:p>") != std::string::npos) return ParsedQuery::predicateIriSelect(); return ParsedQuery::minimalSelect(); } };\n';

export const fakeThrowingSparqlParserHeader = '#pragma once\n#include <stdexcept>\n#include <string>\n#include "parser/ParsedQuery.h"\nclass SparqlParser { public: static ParsedQuery parseQuery(const void*, std::string query) { if (query.find("BROKEN") != std::string::npos) throw std::runtime_error("synthetic parse failure"); if (query.find("<urn:type>") != std::string::npos) return ParsedQuery::subjectFilterSelect(); if (query.find("<urn:p>") != std::string::npos) return ParsedQuery::predicateIriSelect(); if (query.find("SELECT") != std::string::npos) return ParsedQuery::minimalSelect(); ParsedQuery parsed; parsed.select_ = false; return parsed; } };\n';
