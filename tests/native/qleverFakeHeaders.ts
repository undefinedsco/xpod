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

export const fakeIndexScanHeader = `
#pragma once
#include <string>
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
        permutation_(Permutation::Enum::SPO) {}
  const TripleComponent& subject() const { return subject_; }
  const TripleComponent& predicate() const { return predicate_; }
  const TripleComponent& object() const { return object_; }
  const Permutation& permutation() const { return permutation_; }
  std::string getDescriptor() const override { return "IndexScan SPO ?s ?p ?o"; }
  size_t getResultWidth() const override { return 3; }
 protected:
  std::vector<ColumnIndex> resultSortedOn() const override { return {0}; }
 private:
  TripleComponent subject_;
  TripleComponent predicate_;
  TripleComponent object_;
  Permutation permutation_;
};
`;

export const fakePermissiveSparqlParserHeader = '#pragma once\n#include <string>\n#include "parser/ParsedQuery.h"\nclass SparqlParser { public: static ParsedQuery parseQuery(const void*, std::string query) { if (query.find("<urn:type>") != std::string::npos) return ParsedQuery::subjectFilterSelect(); if (query.find("<urn:p>") != std::string::npos) return ParsedQuery::predicateIriSelect(); return ParsedQuery::minimalSelect(); } };\n';

export const fakeThrowingSparqlParserHeader = '#pragma once\n#include <stdexcept>\n#include <string>\n#include "parser/ParsedQuery.h"\nclass SparqlParser { public: static ParsedQuery parseQuery(const void*, std::string query) { if (query.find("BROKEN") != std::string::npos) throw std::runtime_error("synthetic parse failure"); if (query.find("<urn:type>") != std::string::npos) return ParsedQuery::subjectFilterSelect(); if (query.find("<urn:p>") != std::string::npos) return ParsedQuery::predicateIriSelect(); if (query.find("SELECT") != std::string::npos) return ParsedQuery::minimalSelect(); ParsedQuery parsed; parsed.select_ = false; return parsed; } };\n';

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
