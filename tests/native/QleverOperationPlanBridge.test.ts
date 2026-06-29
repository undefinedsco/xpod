import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { fakeDistinctHeader, fakeIndexScanHeader, fakeJoinHeader, fakeLimitOffsetHeader, fakeOrderByHeader, fakeParsedQueryHeader, fakeQueryExecutionTreeHeader, fakeQueryPlannerHeader, fakeSparqlTripleHeader, fakeTextIndexScanForWordHeader, fakeTextIndexScanForEntityHeader } from './qleverFakeHeaders';

const repoRoot = path.resolve(__dirname, '../..');
const operationPlanHeader = path.join(repoRoot, 'native/postgres/qlever_adapter/src/XpodQleverOperationPlanBridge.hpp');

function hasCxx(): boolean {
  try {
    execFileSync('/usr/bin/env', ['c++', '--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

describe('QLever operation plan bridge', () => {
  it('plans with a native request context when QLever exposes a native planner constructor', async () => {
    expect(hasCxx(), 'c++ compiler is required for native operation plan bridge check').toBe(true);

    const root = await mkdtemp(path.join(os.tmpdir(), 'xpod-qlever-native-context-plan-'));
    try {
      const qleverSource = path.join(root, 'qlever');
      await mkdir(path.join(qleverSource, 'src/parser'), { recursive: true });
      await mkdir(path.join(qleverSource, 'src/index'), { recursive: true });
      await mkdir(path.join(qleverSource, 'src/global'), { recursive: true });
      await mkdir(path.join(qleverSource, 'src/engine'), { recursive: true });
      await mkdir(path.join(qleverSource, 'src/util'), { recursive: true });
      await writeFile(path.join(qleverSource, 'src/parser/ParsedQuery.h'), fakeParsedQueryHeader, 'utf8');
      await writeFile(path.join(qleverSource, 'src/parser/SparqlTriple.h'), fakeSparqlTripleHeader, 'utf8');
      await writeFile(path.join(qleverSource, 'src/global/Id.h'), '#pragma once\n#include <cstdint>\nusing ColumnIndex = uint64_t;\n', 'utf8');
      await writeFile(path.join(qleverSource, 'src/index/Permutation.h'), `
#pragma once
class Permutation {
 public:
  enum struct Enum { PSO, POS, SPO, SOP, OPS, OSP };
  explicit Permutation(Enum value = Enum::SPO) : value_(value) {}
  Enum permutation() const { return value_; }
 private:
  Enum value_;
};
`, 'utf8');
      await writeFile(path.join(qleverSource, 'src/util/CancellationHandle.h'), '#pragma once\nnamespace ad_utility { struct SharedCancellationHandle {}; }\n', 'utf8');
      await writeFile(path.join(qleverSource, 'src/engine/QueryExecutionContext.h'), '#pragma once\nclass QueryExecutionContext {};\n', 'utf8');
      await writeFile(path.join(qleverSource, 'src/engine/QueryExecutionTree.h'), fakeQueryExecutionTreeHeader, 'utf8');
      await writeFile(path.join(qleverSource, 'src/engine/Operation.h'), `
#pragma once
#include <string>
#include <vector>
#include "engine/QueryExecutionTree.h"
#include "global/Id.h"
class Operation {
 public:
  virtual ~Operation() = default;
  virtual std::string getDescriptor() const = 0;
  virtual size_t getResultWidth() const = 0;
  const std::vector<ColumnIndex>& getResultSortedOn() const {
    sorted_cache_ = resultSortedOn();
    return sorted_cache_;
  }
  virtual std::vector<QueryExecutionTree*> getChildren() { return {}; }
 protected:
  virtual std::vector<ColumnIndex> resultSortedOn() const = 0;
 private:
  mutable std::vector<ColumnIndex> sorted_cache_;
};
`, 'utf8');
      await writeFile(path.join(qleverSource, 'src/engine/Join.h'), fakeJoinHeader, 'utf8');
      await writeFile(path.join(qleverSource, 'src/engine/IndexScan.h'), `
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
  std::string getDescriptor() const override { return "native request context planner scan"; }
  size_t getResultWidth() const override { return 3; }
 protected:
  std::vector<ColumnIndex> resultSortedOn() const override { return {0}; }
 private:
  TripleComponent subject_;
  TripleComponent predicate_;
  TripleComponent object_;
  Permutation permutation_;
};
`, 'utf8');
      await writeFile(path.join(qleverSource, 'src/engine/QueryPlanner.h'), `
#pragma once
#include <memory>
#include <string_view>
#include "xpod_qlever_adapter.h"
#include "XpodQleverPlannerRequestContext.hpp"
#include "engine/IndexScan.h"
#include "engine/QueryExecutionTree.h"
#include "parser/ParsedQuery.h"
#include "util/CancellationHandle.h"
class QueryPlanner {
 public:
  QueryPlanner(const xpod::qlever::PlannerRequestContext* context,
               ad_utility::SharedCancellationHandle)
      : context_(context) {}
  QueryExecutionTree createExecutionTree(ParsedQuery&, bool = false) {
    if (context_ == nullptr || !context_->backend.valid() ||
        context_->request == nullptr ||
        std::string_view(context_->request->snapshot.facts_version.data,
                         context_->request->snapshot.facts_version.size) != "facts-v1") {
      return QueryExecutionTree();
    }
    return QueryExecutionTree(std::make_shared<IndexScan>());
  }
 private:
  const xpod::qlever::PlannerRequestContext* context_;
};
`, 'utf8');

      const smoke = path.join(root, 'native_context_operation_plan_smoke.cpp');
      const binary = path.join(root, 'native_context_operation_plan_smoke');
      await writeFile(smoke, `
#include <string_view>
#include "XpodQleverOperationPlanBridge.hpp"

int main() {
  xpod_rdf_backend_v1 raw_backend = {};
  raw_backend.abi_version = XPOD_RDF_PHYSICAL_BACKEND_ABI_VERSION;
  raw_backend.struct_size = sizeof(xpod_rdf_backend_v1);
  xpod::rdf::PhysicalBackend physical(&raw_backend);

  static const char facts_version[] = "facts-v1";
  xpod_qlever_query_request request = {};
  request.snapshot.facts_version = {facts_version, 8};
  xpod::qlever::PlannerRequestContext native_context{physical, &request};
  xpod::qlever::PlannerContextHandle handle{nullptr, &native_context};

  ParsedQuery parsed = ParsedQuery::minimalSelect();
  auto plan = xpod::qlever::planQleverParsedQueryWithAvailablePlanner(handle, parsed);
  if (!plan.has_value()) return 1;
  if (plan->descriptor != "native request context planner scan") return 2;
  if (plan->root.kind != xpod::qlever::BridgeOperationKind::PermutationScan) return 3;
  return 0;
}
`, 'utf8');

      execFileSync('c++', [
        '-std=c++17',
        '-Wall',
        '-Wextra',
        '-Werror',
        '-DXPOD_QLEVER_ADAPTER_ENABLE_QLEVER=1',
        '-I', path.dirname(operationPlanHeader),
        '-I', path.join(repoRoot, 'native/postgres/rdf_protocol/include'),
        '-I', path.join(repoRoot, 'native/postgres/qlever_adapter/include'),
        '-I', path.join(qleverSource, 'src'),
        smoke,
        '-o',
        binary,
      ], { stdio: 'pipe' });
      execFileSync(binary, [], { stdio: 'pipe' });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('builds a bridge query plan from a real QLever IndexScan operation shape', async () => {
    expect(hasCxx(), 'c++ compiler is required for native operation plan bridge check').toBe(true);

    const root = await mkdtemp(path.join(os.tmpdir(), 'xpod-qlever-operation-plan-'));
    try {
      const qleverSource = path.join(root, 'qlever');
      await mkdir(path.join(qleverSource, 'src/parser'), { recursive: true });
      await mkdir(path.join(qleverSource, 'src/index'), { recursive: true });
      await mkdir(path.join(qleverSource, 'src/global'), { recursive: true });
      await mkdir(path.join(qleverSource, 'src/engine'), { recursive: true });
      await writeFile(path.join(qleverSource, 'src/parser/ParsedQuery.h'), fakeParsedQueryHeader, 'utf8');
      await writeFile(path.join(qleverSource, 'src/parser/SparqlTriple.h'), fakeSparqlTripleHeader, 'utf8');
      await writeFile(path.join(qleverSource, 'src/global/Id.h'), '#pragma once\n#include <cstdint>\nusing ColumnIndex = uint64_t;\n', 'utf8');
      await writeFile(path.join(qleverSource, 'src/index/Permutation.h'), `
#pragma once
class Permutation {
 public:
  enum struct Enum { PSO, POS, SPO, SOP, OPS, OSP };
  explicit Permutation(Enum value = Enum::SPO) : value_(value) {}
  Enum permutation() const { return value_; }
 private:
  Enum value_;
};
`, 'utf8');
      await writeFile(path.join(qleverSource, 'src/engine/QueryExecutionTree.h'), fakeQueryExecutionTreeHeader, 'utf8');
      await writeFile(path.join(qleverSource, 'src/engine/QueryPlanner.h'), fakeQueryPlannerHeader, 'utf8');
      await writeFile(path.join(qleverSource, 'src/engine/Operation.h'), `
#pragma once
#include <string>
#include <vector>
#include "engine/QueryExecutionTree.h"
#include "global/Id.h"
class Operation {
 public:
  virtual ~Operation() = default;
  virtual std::string getDescriptor() const = 0;
  virtual size_t getResultWidth() const = 0;
  const std::vector<ColumnIndex>& getResultSortedOn() const {
    sorted_cache_ = resultSortedOn();
    return sorted_cache_;
  }
  virtual std::vector<QueryExecutionTree*> getChildren() { return {}; }
 protected:
  virtual std::vector<ColumnIndex> resultSortedOn() const = 0;
 private:
  mutable std::vector<ColumnIndex> sorted_cache_;
};
`, 'utf8');
      await writeFile(path.join(qleverSource, 'src/engine/Join.h'), fakeJoinHeader, 'utf8');
      await writeFile(path.join(qleverSource, 'src/engine/Distinct.h'), fakeDistinctHeader, 'utf8');
      await writeFile(path.join(qleverSource, 'src/engine/OrderBy.h'), fakeOrderByHeader, 'utf8');
      await writeFile(path.join(qleverSource, 'src/engine/LimitOffset.h'), fakeLimitOffsetHeader, 'utf8');
      await writeFile(path.join(qleverSource, 'src/engine/TextIndexScanForWord.h'), fakeTextIndexScanForWordHeader, 'utf8');
      await writeFile(path.join(qleverSource, 'src/engine/TextIndexScanForEntity.h'), fakeTextIndexScanForEntityHeader, 'utf8');
      await writeFile(path.join(qleverSource, 'src/engine/IndexScan.h'), `
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
        predicate_(TripleComponent::Iri{"<urn:p>"}),
        object_(Variable{"?o"}),
        permutation_(Permutation::Enum::POS),
        descriptor_("IndexScan POS ?s <urn:p> ?o"),
        result_width_(2),
        sorted_({0, 1}) {}
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
`, 'utf8');

      const smoke = path.join(root, 'operation_plan_bridge_smoke.cpp');
      const binary = path.join(root, 'operation_plan_bridge_smoke');
      await writeFile(smoke, `
#include <cstring>
#include <memory>
#include <string>
#include <string_view>
#include "engine/Join.h"
#include "engine/Distinct.h"
#include "engine/OrderBy.h"
#include "engine/LimitOffset.h"
#include "engine/TextIndexScanForEntity.h"
#include "engine/TextIndexScanForWord.h"
#include "XpodQleverOperationPlanBridge.hpp"

static xpod_rdf_status lookup_terms(
    void*,
    const xpod_rdf_term* terms,
    size_t term_count,
    const xpod_rdf_snapshot*,
    xpod_rdf_term_key* out_keys,
    xpod_rdf_status* out_statuses) {
  if (term_count != 1) return XPOD_RDF_STATUS_BACKEND_ERROR;
  if (terms[0].kind != XPOD_RDF_TERM_IRI) return XPOD_RDF_STATUS_BACKEND_ERROR;
  if (std::string_view(terms[0].value.data, terms[0].value.size) != "urn:entity") return XPOD_RDF_STATUS_BACKEND_ERROR;
  out_keys[0] = 77;
  out_statuses[0] = XPOD_RDF_STATUS_OK;
  return XPOD_RDF_STATUS_OK;
}

int main() {
  IndexScan scan;
  auto plan = xpod::qlever::planIndexScanOperation(scan);
  if (!plan.has_value()) return 1;
  if (plan->descriptor != "IndexScan POS ?s <urn:p> ?o") return 2;
  if (plan->result_width != 2) return 3;
  if (plan->sorted_by.size() != 2 || plan->sorted_by[0] != 0 || plan->sorted_by[1] != 1) return 4;
  if (plan->scan.permutation != Permutation::Enum::POS) return 5;
  if (plan->scan.needed_slots !=
      (XPOD_RDF_SLOT_SUBJECT | XPOD_RDF_SLOT_OBJECT)) return 6;
  if (plan->output_variables.size() != 2) return 61;
  if (plan->output_variables[0] != "o" || plan->output_variables[1] != "s") return 62;
  if (plan->term_bindings.size() != 1) return 7;
  if (plan->term_bindings[0].slot != XPOD_RDF_SLOT_PREDICATE) return 8;
  if (plan->term_bindings[0].kind != XPOD_RDF_TERM_IRI) return 9;
  if (plan->term_bindings[0].value != "urn:p") return 10;
  if (plan->root.kind != xpod::qlever::BridgeOperationKind::PermutationScan) return 11;
  if (plan->root.scan_indexes.size() != 1 || plan->root.scan_indexes[0] != 0) return 12;
  const Operation& operation = scan;
  auto generic_plan = xpod::qlever::planQleverOperation(operation);
  if (!generic_plan.has_value()) return 13;
  if (generic_plan->descriptor != plan->descriptor) return 14;
  if (generic_plan->term_bindings.size() != 1) return 15;
  QueryExecutionTree tree(std::make_shared<IndexScan>());
  auto tree_plan = xpod::qlever::planQleverExecutionTree(tree);
  if (!tree_plan.has_value()) return 16;
  if (tree_plan->descriptor != plan->descriptor) return 17;
  if (tree_plan->term_bindings.size() != 1) return 18;
  QueryExecutionTree empty_tree;
  if (xpod::qlever::planQleverExecutionTree(empty_tree).has_value()) return 19;
  ParsedQuery parsed = ParsedQuery::minimalSelect();
  QueryPlanner planner;
  auto planner_plan = xpod::qlever::planQleverParsedQueryWithPlanner(planner, parsed);
  if (!planner_plan.has_value()) return 20;
  if (planner_plan->descriptor != plan->descriptor) return 21;
  if (planner_plan->term_bindings.size() != 1) return 22;
  planner.setReturnEmpty(true);
  if (xpod::qlever::planQleverParsedQueryWithPlanner(planner, parsed).has_value()) return 23;
  auto left = std::make_shared<QueryExecutionTree>(std::make_shared<IndexScan>());
  auto right = std::make_shared<QueryExecutionTree>(std::make_shared<IndexScan>());
  Join join(left, right);
  auto join_plan = xpod::qlever::planQleverOperation(join);
  if (!join_plan.has_value()) return 24;
  if (join_plan->root.kind != xpod::qlever::BridgeOperationKind::HashJoin) return 25;
  if (join_plan->filter_scans.size() != 1) return 26;
  if (join_plan->root.join_slot != XPOD_RDF_SLOT_SUBJECT) return 27;
  auto join_tree = std::make_shared<QueryExecutionTree>(std::make_shared<Join>(left, right));
  auto third = std::make_shared<QueryExecutionTree>(std::make_shared<IndexScan>());
  Join nested_join(join_tree, third);
  auto nested_join_plan = xpod::qlever::planQleverOperation(nested_join);
  if (!nested_join_plan.has_value()) return 28;
  if (nested_join_plan->root.kind != xpod::qlever::BridgeOperationKind::HashJoin) return 29;
  if (nested_join_plan->filter_scans.size() != 2) return 30;
  if (nested_join_plan->root.scan_indexes.size() != 3) return 31;
  if (nested_join_plan->root.join_slot != XPOD_RDF_SLOT_SUBJECT) return 32;
  TextIndexScanForWord text_scan("native-first");
  const Operation& text_operation = text_scan;
  auto text_plan = xpod::qlever::planQleverOperation(text_operation);
  if (!text_plan.has_value()) return 33;
  if (text_plan->root.kind != xpod::qlever::BridgeOperationKind::TextSearch) return 34;
  if (text_plan->root.candidate_index != 0) return 35;
  if (!text_plan->root.scan_indexes.empty()) return 36;
  if (text_plan->text_sources.size() != 1) return 37;
  const auto& source = text_plan->text_sources[0];
  if (source.request.query.size != std::strlen("native-first")) return 38;
  if (std::string(source.request.query.data, source.request.query.size) != "native-first") return 39;
  if (source.descriptor != "TextIndexScanForWord native-first") return 40;
  auto physical = xpod::qlever::toBridgePhysicalPlan(*text_plan);
  if (physical.root.kind != xpod::qlever::BridgeOperationKind::TextSearch) return 41;
  if (physical.root.candidate_index != 0) return 42;
  if (!physical.scans.empty()) return 43;
  if (physical.text_sources.size() != 1) return 44;
  if (std::string(physical.text_sources[0].request.query.data, physical.text_sources[0].request.query.size) != "native-first") return 45;

  TextIndexScanForEntity fixed_entity_scan("native-first", "<urn:entity>");
  const Operation& fixed_entity_operation = fixed_entity_scan;
  auto entity_plan = xpod::qlever::planQleverOperation(fixed_entity_operation);
  if (!entity_plan.has_value()) return 46;
  if (entity_plan->root.kind != xpod::qlever::BridgeOperationKind::TextSearch) return 47;
  if (entity_plan->text_sources.size() != 1) return 48;
  if (entity_plan->text_required_entities.size() != 1) return 49;
  if (entity_plan->text_required_entities[0].text_source_index != 0) return 50;
  if (entity_plan->text_required_entities[0].term.kind != XPOD_RDF_TERM_IRI) return 51;
  if (entity_plan->text_required_entities[0].term.value != "urn:entity") return 52;

  xpod_rdf_backend_v1 backend = {};
  backend.abi_version = XPOD_RDF_PHYSICAL_BACKEND_ABI_VERSION;
  backend.struct_size = sizeof(xpod_rdf_backend_v1);
  backend.lookup_terms = lookup_terms;
  xpod::rdf::PhysicalBackend physical_backend(&backend);
  xpod_rdf_snapshot snapshot = {};
  std::string error;
  xpod_rdf_status bind_status = xpod::qlever::bindPlanTerms(physical_backend, snapshot, *entity_plan, error);
  if (bind_status != XPOD_RDF_STATUS_OK) return 53;
  if (entity_plan->text_sources[0].request.required_entities_size != 1) return 54;
  if (entity_plan->text_sources[0].request.required_entities[0] != 77) return 55;
  auto entity_physical = xpod::qlever::toBridgePhysicalPlan(*entity_plan);
  if (entity_physical.text_sources.size() != 1) return 56;
  if (entity_physical.text_sources[0].request.required_entities_size != 1) return 57;
  if (entity_physical.text_sources[0].request.required_entities[0] != 77) return 58;

  TextIndexScanForEntity variable_entity_scan("native-first");
  const Operation& variable_entity_operation = variable_entity_scan;
  auto variable_entity_plan = xpod::qlever::planQleverOperation(variable_entity_operation);
  if (!variable_entity_plan.has_value()) return 59;
  if (variable_entity_plan->root.kind != xpod::qlever::BridgeOperationKind::TextSearch) return 66;
  if (variable_entity_plan->text_sources.size() != 1) return 67;
  if (!variable_entity_plan->text_required_entities.empty()) return 68;
  if (variable_entity_plan->result_width != 2) return 69;
  if (variable_entity_plan->output_variables.size() != 2) return 70;
  if (variable_entity_plan->output_variables[0] != "text") return 71;
  if (variable_entity_plan->output_variables[1] != "entity") return 72;
  if (variable_entity_plan->text_sources[0].output_columns.size() != 2) return 73;
  if (variable_entity_plan->text_sources[0].output_columns[0].variable != "text") return 74;
  if (variable_entity_plan->text_sources[0].output_columns[0].kind !=
      xpod::qlever::BridgeCandidateColumnKind::RetrievalPoint) return 75;
  if (variable_entity_plan->text_sources[0].output_columns[1].variable != "entity") return 76;
  if (variable_entity_plan->text_sources[0].output_columns[1].kind !=
      xpod::qlever::BridgeCandidateColumnKind::ResourceTerm) return 77;
  auto variable_entity_physical = xpod::qlever::toBridgePhysicalPlan(*variable_entity_plan);
  if (variable_entity_physical.text_sources.size() != 1) return 78;
  if (variable_entity_physical.text_sources[0].output_columns.size() != 2) return 79;

  auto text_entity_tree = std::make_shared<QueryExecutionTree>(
      std::make_shared<TextIndexScanForEntity>("native-first"));
  auto entity_scan_tree = std::make_shared<QueryExecutionTree>(
      std::make_shared<IndexScan>(
          TripleComponent{Variable{"?entity"}},
          TripleComponent{TripleComponent::Iri{"<urn:label>"}},
          TripleComponent{Variable{"?label"}},
          Permutation::Enum::SPO,
          "IndexScan SPO ?entity <urn:label> ?label",
          2,
          std::vector<ColumnIndex>{0}));
  Join text_rdf_join(text_entity_tree, entity_scan_tree);
  auto text_rdf_join_plan = xpod::qlever::planQleverOperation(text_rdf_join);
  if (!text_rdf_join_plan.has_value()) return 87;
  if (text_rdf_join_plan->root.kind != xpod::qlever::BridgeOperationKind::HashJoin) return 88;
  if (!text_rdf_join_plan->root.use_candidate_join) return 89;
  if (text_rdf_join_plan->root.candidate_index != 0) return 90;
  if (text_rdf_join_plan->root.candidate_join_column !=
      xpod::qlever::BridgeCandidateColumnKind::ResourceTerm) return 91;
  if (text_rdf_join_plan->root.scan_indexes.size() != 1) return 92;
  if (text_rdf_join_plan->root.scan_indexes[0] != 0) return 93;
  if (text_rdf_join_plan->root.join_slots.size() != 1) return 94;
  if (text_rdf_join_plan->root.join_slots[0] != XPOD_RDF_SLOT_SUBJECT) return 95;
  if (text_rdf_join_plan->text_sources.size() != 1) return 96;
  if (text_rdf_join_plan->filter_scans.size() != 0) return 97;
  if (text_rdf_join_plan->root.candidate_project_columns.size() != 1) return 98;
  if (text_rdf_join_plan->root.candidate_project_columns[0].variable != "text") return 99;
  if (text_rdf_join_plan->root.candidate_project_columns[0].kind !=
      xpod::qlever::BridgeCandidateColumnKind::RetrievalPoint) return 100;
  if (text_rdf_join_plan->output_variables.size() != 3) return 108;
  if (text_rdf_join_plan->output_variables[0] != "text") return 109;
  if (text_rdf_join_plan->output_variables[1] != "entity") return 110;
  if (text_rdf_join_plan->output_variables[2] != "label") return 111;
  auto text_rdf_physical = xpod::qlever::toBridgePhysicalPlan(*text_rdf_join_plan);
  if (text_rdf_physical.root.profile_node != 1) return 101;
  if (text_rdf_physical.text_sources.size() != 1) return 102;
  if (text_rdf_physical.text_sources[0].profile_node != 2) return 103;
  if (text_rdf_physical.text_sources[0].parent_profile_node != 1) return 104;
  if (text_rdf_physical.scans.size() != 1) return 105;
  if (text_rdf_physical.scans[0].profile_node != 3) return 106;
  if (text_rdf_physical.scans[0].parent_profile_node != 1) return 107;

  auto word_tree = std::make_shared<QueryExecutionTree>(
      std::make_shared<TextIndexScanForWord>("native-first"));
  auto fixed_entity_tree = std::make_shared<QueryExecutionTree>(
      std::make_shared<TextIndexScanForEntity>("native-first", "<urn:entity>"));
  Join text_join(word_tree, fixed_entity_tree);
  auto text_join_plan = xpod::qlever::planQleverOperation(text_join);
  if (!text_join_plan.has_value()) return 60;
  if (text_join_plan->root.kind != xpod::qlever::BridgeOperationKind::TextSearch) return 61;
  if (text_join_plan->text_sources.size() != 1) return 62;
  if (std::string(text_join_plan->text_sources[0].request.query.data, text_join_plan->text_sources[0].request.query.size) != "native-first") return 63;
  if (text_join_plan->text_required_entities.size() != 1) return 64;
  if (text_join_plan->text_required_entities[0].term.value != "urn:entity") return 65;

  auto cross_left = std::make_shared<QueryExecutionTree>(
      std::make_shared<IndexScan>(
          TripleComponent{Variable{"?s"}},
          TripleComponent{Variable{"?p"}},
          TripleComponent{Variable{"?mid"}},
          Permutation::Enum::SPO,
          "IndexScan SPO ?s ?p ?mid",
          3,
          std::vector<ColumnIndex>{0}));
  auto cross_right = std::make_shared<QueryExecutionTree>(
      std::make_shared<IndexScan>(
          TripleComponent{Variable{"?mid"}},
          TripleComponent{TripleComponent::Iri{"<urn:type>"}},
          TripleComponent{TripleComponent::Iri{"<urn:Thing>"}},
          Permutation::Enum::SPO,
          "IndexScan SPO ?mid <urn:type> <urn:Thing>",
          1,
          std::vector<ColumnIndex>{0}));
  Join cross_slot_join(cross_left, cross_right);
  auto cross_slot_plan = xpod::qlever::planQleverOperation(cross_slot_join);
  if (!cross_slot_plan.has_value()) return 80;
  if (cross_slot_plan->root.kind != xpod::qlever::BridgeOperationKind::HashJoin) return 81;
  if (cross_slot_plan->root.scan_indexes.size() != 2) return 82;
  if (cross_slot_plan->root.join_slots.size() != 2) return 83;
  if (cross_slot_plan->root.join_slots[0] != XPOD_RDF_SLOT_OBJECT) return 84;
  if (cross_slot_plan->root.join_slots[1] != XPOD_RDF_SLOT_SUBJECT) return 85;
  if (cross_slot_plan->root.join_slot != XPOD_RDF_SLOT_OBJECT) return 86;

  auto rdf_projection_left = std::make_shared<QueryExecutionTree>(
      std::make_shared<IndexScan>(
          TripleComponent{Variable{"?entity"}},
          TripleComponent{TripleComponent::Iri{"<urn:label>"}},
          TripleComponent{Variable{"?label"}},
          Permutation::Enum::SPO,
          "IndexScan SPO ?entity <urn:label> ?label",
          2,
          std::vector<ColumnIndex>{0}));
  auto rdf_projection_right = std::make_shared<QueryExecutionTree>(
      std::make_shared<IndexScan>(
          TripleComponent{Variable{"?entity"}},
          TripleComponent{TripleComponent::Iri{"<urn:type>"}},
          TripleComponent{Variable{"?type"}},
          Permutation::Enum::SPO,
          "IndexScan SPO ?entity <urn:type> ?type",
          2,
          std::vector<ColumnIndex>{0}));
  Join rdf_projection_join(rdf_projection_left, rdf_projection_right);
  auto rdf_projection_plan = xpod::qlever::planQleverOperation(rdf_projection_join);
  if (!rdf_projection_plan.has_value()) return 112;
  if (rdf_projection_plan->result_width != 3) return 113;
  if (rdf_projection_plan->output_variables.size() != 3) return 114;
  if (rdf_projection_plan->output_variables[0] != "entity") return 115;
  if (rdf_projection_plan->output_variables[1] != "label") return 116;
  if (rdf_projection_plan->output_variables[2] != "type") return 117;
  if (rdf_projection_plan->root.scan_project_slots.size() != 2) return 118;
  if (rdf_projection_plan->root.scan_project_slots[0].size() != 2) return 119;
  if (rdf_projection_plan->root.scan_project_slots[0][0] != XPOD_RDF_SLOT_SUBJECT) return 120;
  if (rdf_projection_plan->root.scan_project_slots[0][1] != XPOD_RDF_SLOT_OBJECT) return 121;
  if (rdf_projection_plan->root.scan_project_slots[1].size() != 1) return 122;
  if (rdf_projection_plan->root.scan_project_slots[1][0] != XPOD_RDF_SLOT_OBJECT) return 123;

  auto multi_key_left = std::make_shared<QueryExecutionTree>(
      std::make_shared<IndexScan>(
          TripleComponent{Variable{"?s"}},
          TripleComponent{Variable{"?p"}},
          TripleComponent{Variable{"?o"}},
          Permutation::Enum::SPO,
          "IndexScan SPO ?s ?p ?o",
          3,
          std::vector<ColumnIndex>{0, 1}));
  auto multi_key_right = std::make_shared<QueryExecutionTree>(
      std::make_shared<IndexScan>(
          TripleComponent{Variable{"?s"}},
          TripleComponent{Variable{"?p"}},
          TripleComponent{Variable{"?type"}},
          Permutation::Enum::SPO,
          "IndexScan SPO ?s ?p ?type",
          3,
          std::vector<ColumnIndex>{0, 1}));
  Join multi_key_join(multi_key_left, multi_key_right);
  auto multi_key_plan = xpod::qlever::planQleverOperation(multi_key_join);
  if (!multi_key_plan.has_value()) return 124;
  if (multi_key_plan->result_width != 4) return 125;
  if (multi_key_plan->output_variables.size() != 4) return 126;
  if (multi_key_plan->output_variables[0] != "s") return 127;
  if (multi_key_plan->output_variables[1] != "p") return 128;
  if (multi_key_plan->output_variables[2] != "o") return 129;
  if (multi_key_plan->output_variables[3] != "type") return 130;
  if (multi_key_plan->root.join_key_slots.size() != 2) return 131;
  if (multi_key_plan->root.join_key_slots[0].size() != 2) return 132;
  if (multi_key_plan->root.join_key_slots[0][0] != XPOD_RDF_SLOT_SUBJECT) return 133;
  if (multi_key_plan->root.join_key_slots[0][1] != XPOD_RDF_SLOT_PREDICATE) return 134;
  if (multi_key_plan->root.join_key_slots[1].size() != 2) return 135;
  if (multi_key_plan->root.join_key_slots[1][0] != XPOD_RDF_SLOT_SUBJECT) return 136;
  if (multi_key_plan->root.join_key_slots[1][1] != XPOD_RDF_SLOT_PREDICATE) return 137;
  if (multi_key_plan->root.scan_project_slots.size() != 2) return 138;
  if (multi_key_plan->root.scan_project_slots[0].size() != 3) return 139;
  if (multi_key_plan->root.scan_project_slots[1].size() != 1) return 140;
  if (multi_key_plan->root.scan_project_slots[1][0] != XPOD_RDF_SLOT_OBJECT) return 141;

  auto limited_tree = std::make_shared<QueryExecutionTree>(
      std::make_shared<IndexScan>(
          TripleComponent{Variable{"?s"}},
          TripleComponent{Variable{"?p"}},
          TripleComponent{Variable{"?o"}},
          Permutation::Enum::SPO,
          "IndexScan SPO ?s ?p ?o",
          3,
          std::vector<ColumnIndex>{0}));
  LimitOffset limit_operation(limited_tree, 1, 2);
  auto limit_plan = xpod::qlever::planQleverOperation(limit_operation);
  if (!limit_plan.has_value()) return 142;
  if (limit_plan->root.kind != xpod::qlever::BridgeOperationKind::PermutationScan) return 143;
  if (!limit_plan->root.has_limit) return 144;
  if (limit_plan->root.limit != 1) return 145;
  if (limit_plan->root.offset != 2) return 146;
  if (limit_plan->output_variables.size() != 3) return 147;
  if (limit_plan->output_variables[0] != "s") return 148;
  if (limit_plan->output_variables[1] != "p") return 149;
  if (limit_plan->output_variables[2] != "o") return 150;

  auto distinct_tree = std::make_shared<QueryExecutionTree>(
      std::make_shared<IndexScan>(
          TripleComponent{Variable{"?s"}},
          TripleComponent{Variable{"?p"}},
          TripleComponent{Variable{"?o"}},
          Permutation::Enum::SPO,
          "IndexScan SPO ?s ?p ?o",
          3,
          std::vector<ColumnIndex>{0}));
  Distinct distinct_operation(distinct_tree, std::vector<ColumnIndex>{0, 2});
  auto distinct_plan = xpod::qlever::planQleverOperation(distinct_operation);
  if (!distinct_plan.has_value()) return 151;
  if (distinct_plan->root.kind != xpod::qlever::BridgeOperationKind::PermutationScan) return 152;
  if (!distinct_plan->root.has_distinct) return 153;
  if (distinct_plan->root.distinct_columns.size() != 2) return 154;
  if (distinct_plan->root.distinct_columns[0] != 0) return 155;
  if (distinct_plan->root.distinct_columns[1] != 2) return 156;
  if (distinct_plan->root.result_modifiers.size() != 1) return 157;
  if (distinct_plan->root.result_modifiers[0].kind !=
      xpod::qlever::BridgeResultModifierKind::Distinct) return 158;
  if (distinct_plan->root.result_modifiers[0].columns.size() != 2) return 159;
  if (distinct_plan->output_variables.size() != 3) return 160;
  if (distinct_plan->output_variables[0] != "s") return 161;
  if (distinct_plan->output_variables[1] != "p") return 162;
  if (distinct_plan->output_variables[2] != "o") return 163;

  auto order_tree = std::make_shared<QueryExecutionTree>(
      std::make_shared<IndexScan>(
          TripleComponent{Variable{"?s"}},
          TripleComponent{Variable{"?p"}},
          TripleComponent{Variable{"?o"}},
          Permutation::Enum::SPO,
          "IndexScan SPO ?s ?p ?o",
          3,
          std::vector<ColumnIndex>{0}));
  OrderBy order_operation(order_tree, OrderBy::SortedVariables{
      {Variable{"?o"}, OrderBy::AscOrDesc::Desc},
      {Variable{"?s"}, OrderBy::AscOrDesc::Asc},
  });
  auto order_plan = xpod::qlever::planQleverOperation(order_operation);
  if (!order_plan.has_value()) return 164;
  if (order_plan->root.kind != xpod::qlever::BridgeOperationKind::PermutationScan) return 165;
  if (order_plan->root.result_modifiers.size() != 1) return 166;
  if (order_plan->root.result_modifiers[0].kind !=
      xpod::qlever::BridgeResultModifierKind::OrderBy) return 167;
  if (order_plan->root.result_modifiers[0].columns.size() != 2) return 168;
  if (order_plan->root.result_modifiers[0].columns[0] != 2) return 169;
  if (order_plan->root.result_modifiers[0].columns[1] != 0) return 170;
  if (order_plan->root.result_modifiers[0].descending.size() != 2) return 171;
  if (!order_plan->root.result_modifiers[0].descending[0]) return 172;
  if (order_plan->root.result_modifiers[0].descending[1]) return 173;
  if (!order_plan->sorted_by.empty()) return 174;
  if (order_plan->output_variables.size() != 3) return 175;
  if (order_plan->output_variables[0] != "s") return 176;
  if (order_plan->output_variables[1] != "p") return 177;
  if (order_plan->output_variables[2] != "o") return 178;
  return 0;
}
`, 'utf8');

      execFileSync('c++', [
        '-std=c++17',
        '-Wall',
        '-Wextra',
        '-Werror',
        '-DXPOD_QLEVER_ADAPTER_ENABLE_QLEVER=1',
        '-I', path.dirname(operationPlanHeader),
        '-I', path.join(repoRoot, 'native/postgres/rdf_protocol/include'),
        '-I', path.join(qleverSource, 'src'),
        smoke,
        '-o',
        binary,
      ], { stdio: 'pipe' });
      execFileSync(binary, [], { stdio: 'pipe' });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('can build a bridge plan from a QueryPlanner constructed with QueryExecutionContext', async () => {
    expect(hasCxx(), 'c++ compiler is required for native QEC planner bridge check').toBe(true);

    const root = await mkdtemp(path.join(os.tmpdir(), 'xpod-qlever-qec-plan-'));
    try {
      const qleverSource = path.join(root, 'qlever');
      await mkdir(path.join(qleverSource, 'src/parser'), { recursive: true });
      await mkdir(path.join(qleverSource, 'src/index'), { recursive: true });
      await mkdir(path.join(qleverSource, 'src/global'), { recursive: true });
      await mkdir(path.join(qleverSource, 'src/engine'), { recursive: true });
      await mkdir(path.join(qleverSource, 'src/util'), { recursive: true });
      await writeFile(path.join(qleverSource, 'src/parser/ParsedQuery.h'), fakeParsedQueryHeader, 'utf8');
      await writeFile(path.join(qleverSource, 'src/parser/SparqlTriple.h'), fakeSparqlTripleHeader, 'utf8');
      await writeFile(path.join(qleverSource, 'src/global/Id.h'), '#pragma once\n#include <cstdint>\nusing ColumnIndex = uint64_t;\n', 'utf8');
      await writeFile(path.join(qleverSource, 'src/index/Permutation.h'), `
#pragma once
class Permutation {
 public:
  enum struct Enum { PSO, POS, SPO, SOP, OPS, OSP };
  explicit Permutation(Enum value = Enum::SPO) : value_(value) {}
  Enum permutation() const { return value_; }
 private:
  Enum value_;
};
`, 'utf8');
      await writeFile(path.join(qleverSource, 'src/util/CancellationHandle.h'), `
#pragma once
namespace ad_utility {
struct SharedCancellationHandle {};
}
`, 'utf8');
      await writeFile(path.join(qleverSource, 'src/engine/QueryExecutionContext.h'), `
#pragma once
class QueryExecutionContext {
 public:
  bool ready = true;
};
`, 'utf8');
      await writeFile(path.join(qleverSource, 'src/engine/QueryExecutionTree.h'), fakeQueryExecutionTreeHeader, 'utf8');
      await writeFile(path.join(qleverSource, 'src/engine/Operation.h'), `
#pragma once
#include <string>
#include <vector>
#include "engine/QueryExecutionTree.h"
#include "global/Id.h"
class Operation {
 public:
  virtual ~Operation() = default;
  virtual std::string getDescriptor() const = 0;
  virtual size_t getResultWidth() const = 0;
  const std::vector<ColumnIndex>& getResultSortedOn() const {
    sorted_cache_ = resultSortedOn();
    return sorted_cache_;
  }
  virtual std::vector<QueryExecutionTree*> getChildren() { return {}; }
 protected:
  virtual std::vector<ColumnIndex> resultSortedOn() const = 0;
 private:
  mutable std::vector<ColumnIndex> sorted_cache_;
};
`, 'utf8');
      await writeFile(path.join(qleverSource, 'src/engine/IndexScan.h'), fakeIndexScanHeader, 'utf8');
      await writeFile(path.join(qleverSource, 'src/engine/Join.h'), fakeJoinHeader, 'utf8');
      await writeFile(path.join(qleverSource, 'src/engine/QueryPlanner.h'), `
#pragma once
#include <memory>
#include "engine/IndexScan.h"
#include "engine/QueryExecutionContext.h"
#include "engine/QueryExecutionTree.h"
#include "parser/ParsedQuery.h"
#include "util/CancellationHandle.h"
class QueryPlanner {
 public:
  QueryPlanner(QueryExecutionContext* qec, ad_utility::SharedCancellationHandle)
      : qec_(qec) {}
  QueryExecutionTree createExecutionTree(ParsedQuery&, bool = false) {
    if (qec_ == nullptr || !qec_->ready) {
      return QueryExecutionTree();
    }
    return QueryExecutionTree(std::make_shared<IndexScan>());
  }
 private:
  QueryExecutionContext* qec_;
};
`, 'utf8');

      const smoke = path.join(root, 'qec_operation_plan_bridge_smoke.cpp');
      const binary = path.join(root, 'qec_operation_plan_bridge_smoke');
      await writeFile(smoke, `
#include "XpodQleverOperationPlanBridge.hpp"

int main() {
  ParsedQuery parsed = ParsedQuery::minimalSelect();
  QueryExecutionContext qec;
  auto plan = xpod::qlever::planQleverParsedQueryWithContext(&qec, parsed);
  if (!plan.has_value()) return 1;
  if (plan->root.kind != xpod::qlever::BridgeOperationKind::PermutationScan) return 2;
  if (plan->descriptor != "IndexScan SPO ?s ?p ?o") return 3;
  auto selected_plan = xpod::qlever::planQleverParsedQueryWithAvailablePlanner(&qec, parsed);
  if (!selected_plan.has_value()) return 6;
  if (selected_plan->descriptor != plan->descriptor) return 7;
  qec.ready = false;
  if (xpod::qlever::planQleverParsedQueryWithContext(&qec, parsed).has_value()) return 4;
  if (xpod::qlever::planQleverParsedQueryWithContext(nullptr, parsed).has_value()) return 5;
  return 0;
}
`, 'utf8');

      execFileSync('c++', [
        '-std=c++17',
        '-Wall',
        '-Wextra',
        '-Werror',
        '-DXPOD_QLEVER_ADAPTER_ENABLE_QLEVER=1',
        '-I', path.dirname(operationPlanHeader),
        '-I', path.join(repoRoot, 'native/postgres/rdf_protocol/include'),
        '-I', path.join(qleverSource, 'src'),
        smoke,
        '-o',
        binary,
      ], { stdio: 'pipe' });
      execFileSync(binary, [], { stdio: 'pipe' });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
