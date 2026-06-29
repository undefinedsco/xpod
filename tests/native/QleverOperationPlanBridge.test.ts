import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { fakeIndexScanHeader, fakeJoinHeader, fakeParsedQueryHeader, fakeQueryExecutionTreeHeader, fakeQueryPlannerHeader, fakeSparqlTripleHeader, fakeTextIndexScanForWordHeader, fakeTextIndexScanForEntityHeader } from './qleverFakeHeaders';

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
      await writeFile(path.join(qleverSource, 'src/engine/TextIndexScanForWord.h'), fakeTextIndexScanForWordHeader, 'utf8');
      await writeFile(path.join(qleverSource, 'src/engine/TextIndexScanForEntity.h'), fakeTextIndexScanForEntityHeader, 'utf8');
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
        predicate_(TripleComponent::Iri{"<urn:p>"}),
        object_(Variable{"?o"}),
        permutation_(Permutation::Enum::POS) {}
  const TripleComponent& subject() const { return subject_; }
  const TripleComponent& predicate() const { return predicate_; }
  const TripleComponent& object() const { return object_; }
  const Permutation& permutation() const { return permutation_; }
  std::string getDescriptor() const override { return "IndexScan POS ?s <urn:p> ?o"; }
  size_t getResultWidth() const override { return 2; }
 protected:
  std::vector<ColumnIndex> resultSortedOn() const override { return {0, 1}; }
 private:
  TripleComponent subject_;
  TripleComponent predicate_;
  TripleComponent object_;
  Permutation permutation_;
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
  if (xpod::qlever::planQleverOperation(variable_entity_operation).has_value()) return 59;

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
