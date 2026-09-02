import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'bun:test';
import { fakeBindHeader, fakeCartesianProductJoinHeader, fakeDistinctHeader, fakeExistsJoinHeader, fakeFilterHeader, fakeGroupByHeader, fakeIndexScanHeader, fakeJoinHeader, fakeLimitOffsetHeader, fakeMinusHeader, fakeMultiColumnJoinHeader, fakeNeutralElementOperationHeader, fakeOptionalJoinHeader, fakeOrderByHeader, fakeParsedQueryHeader, fakeQueryExecutionTreeHeader, fakeQueryPlannerHeader, fakeSortHeader, fakeSparqlTripleHeader, fakeTextIndexScanForWordHeader, fakeTextIndexScanForEntityHeader, fakeTextLimitHeader, fakeUnionHeader } from './qleverFakeHeaders';

const repoRoot = path.resolve(__dirname, '../..');
const operationPlanHeader = path.join(repoRoot, 'qlever/qlever_adapter/src/XpodQleverOperationPlanBridge.hpp');

const fakeQleverIdHeader = `
#pragma once
#include <cstdint>
using ColumnIndex = uint64_t;
class Id {
 public:
  static Id fromBits(uint64_t bits) { return Id(bits); }
  static Id makeFromInt(int64_t value) { return Id(9000000ULL + static_cast<uint64_t>(value)); }
  static Id makeFromDouble(double value) { return Id(9100000ULL + static_cast<uint64_t>(value * 10)); }
  static Id makeFromBool(bool value) { return Id(value ? 9200001ULL : 9200000ULL); }
  uint64_t getBits() const { return bits_; }
 private:
  explicit Id(uint64_t bits) : bits_(bits) {}
  uint64_t bits_;
};
`;

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
      await writeFile(path.join(qleverSource, 'src/global/Id.h'), fakeQleverIdHeader, 'utf8');
      await writeFile(path.join(qleverSource, 'src/index/Permutation.h'), `
#pragma once
constexpr inline int ADDITIONAL_COLUMN_GRAPH_ID = 3;
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
#include <memory>
namespace ad_utility {
enum class CancellationState { MANUAL };
class CancellationHandle {
 public:
  void cancel(CancellationState = CancellationState::MANUAL) { cancelled_ = true; }
  bool isCancelled() const { return cancelled_; }
 private:
  bool cancelled_ = false;
};
using SharedCancellationHandle = std::shared_ptr<CancellationHandle>;
}
`, 'utf8');
      await writeFile(path.join(qleverSource, 'src/engine/QueryExecutionContext.h'), '#pragma once\nclass QueryExecutionContext {};\n', 'utf8');
      await writeFile(path.join(qleverSource, 'src/engine/QueryExecutionTree.h'), fakeQueryExecutionTreeHeader, 'utf8');
      await writeFile(path.join(qleverSource, 'src/engine/Operation.h'), `
#pragma once
#include <string>
#include <utility>
#include <vector>
#include "engine/QueryExecutionTree.h"
#include "global/Id.h"
#include "parser/ParsedQuery.h"
struct ColumnIndexAndTypeInfo { ColumnIndex columnIndex_; };
using VariableToColumnMap = std::vector<std::pair<Variable, ColumnIndexAndTypeInfo>>;
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
  virtual const VariableToColumnMap& getExternallyVisibleVariableColumns() const {
    static const VariableToColumnMap empty{};
    return empty;
  }
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
#include <variant>
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
        permutation_(Permutation::Enum::SPO) {}
  const TripleComponent& subject() const { return subject_; }
  const TripleComponent& predicate() const { return predicate_; }
  const TripleComponent& object() const { return object_; }
  const Permutation& permutation() const { return permutation_; }
  const std::vector<ColumnIndex>& additionalColumns() const { return additional_columns_; }
  const std::vector<Variable>& additionalVariables() const { return additional_variables_; }
  const GraphFilter& graphsToFilter() const { return graph_filter_; }
  std::string getDescriptor() const override { return "native request context planner scan"; }
  size_t getResultWidth() const override { return 3; }
 protected:
  std::vector<ColumnIndex> resultSortedOn() const override { return {0}; }
 private:
  TripleComponent subject_;
  TripleComponent predicate_;
  TripleComponent object_;
  Permutation permutation_;
  std::vector<ColumnIndex> additional_columns_;
  std::vector<Variable> additional_variables_;
  GraphFilter graph_filter_;
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
               ad_utility::SharedCancellationHandle cancellation)
      : context_(context), cancellation_(std::move(cancellation)) {}
  QueryExecutionTree createExecutionTree(ParsedQuery&, bool = false) {
    if (context_ == nullptr || !context_->backend.valid() ||
        context_->request == nullptr || cancellation_ == nullptr ||
        !cancellation_->isCancelled() ||
        std::string_view(context_->request->snapshot.facts_version.data,
                         context_->request->snapshot.facts_version.size) != "facts-v1") {
      return QueryExecutionTree();
    }
    return QueryExecutionTree(std::make_shared<IndexScan>());
  }
 private:
  const xpod::qlever::PlannerRequestContext* context_;
  ad_utility::SharedCancellationHandle cancellation_;
};
`, 'utf8');

      const smoke = path.join(root, 'native_context_operation_plan_smoke.cpp');
      const binary = path.join(root, 'native_context_operation_plan_smoke');
      await writeFile(smoke, `
#include <string_view>
#include "XpodQleverOperationPlanBridge.hpp"

uint8_t always_cancelled(void*) { return 1; }

int main() {
  xpod_rdf_backend_v1 raw_backend = {};
  raw_backend.abi_version = XPOD_RDF_PHYSICAL_BACKEND_ABI_VERSION;
  raw_backend.struct_size = sizeof(xpod_rdf_backend_v1);
  xpod::rdf::PhysicalBackend physical(&raw_backend);

  static const char facts_version[] = "facts-v1";
  xpod_rdf_cancellation cancellation = {};
  cancellation.is_cancelled = always_cancelled;
  xpod_qlever_query_request request = {};
  request.snapshot.facts_version = {facts_version, 8};
  request.cancellation = &cancellation;
  xpod::qlever::PlannerRequestContext native_context{physical, &request, request.cancellation};
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
        '-I', path.join(repoRoot, 'qlever/rdf_protocol/include'),
        '-I', path.join(repoRoot, 'qlever/qlever_adapter/include'),
        '-I', path.join(qleverSource, 'src'),
        smoke,
        '-o',
        binary,
      ], { stdio: 'pipe' });
      execFileSync(binary, [], { stdio: 'pipe' });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 30_000);

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
      await writeFile(path.join(qleverSource, 'src/global/Id.h'), fakeQleverIdHeader, 'utf8');
      await writeFile(path.join(qleverSource, 'src/index/Permutation.h'), `
#pragma once
constexpr inline int ADDITIONAL_COLUMN_GRAPH_ID = 3;
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
#include <utility>
#include <variant>
#include <vector>
#include "engine/QueryExecutionTree.h"
#include "global/Id.h"
#include "parser/ParsedQuery.h"
struct ColumnIndexAndTypeInfo { ColumnIndex columnIndex_; };
using VariableToColumnMap = std::vector<std::pair<Variable, ColumnIndexAndTypeInfo>>;
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
  virtual const VariableToColumnMap& getExternallyVisibleVariableColumns() const {
    static const VariableToColumnMap empty{};
    return empty;
  }
 protected:
  virtual std::vector<ColumnIndex> resultSortedOn() const = 0;
 private:
  mutable std::vector<ColumnIndex> sorted_cache_;
};
`, 'utf8');
      await writeFile(path.join(qleverSource, 'src/engine/Join.h'), fakeJoinHeader, 'utf8');
      await writeFile(path.join(qleverSource, 'src/engine/CartesianProductJoin.h'), fakeCartesianProductJoinHeader, 'utf8');
      await writeFile(path.join(qleverSource, 'src/engine/Minus.h'), fakeMinusHeader, 'utf8');
      await writeFile(path.join(qleverSource, 'src/engine/MultiColumnJoin.h'), fakeMultiColumnJoinHeader, 'utf8');
      await writeFile(path.join(qleverSource, 'src/engine/ExistsJoin.h'), fakeExistsJoinHeader, 'utf8');
      await writeFile(path.join(qleverSource, 'src/engine/OptionalJoin.h'), fakeOptionalJoinHeader, 'utf8');
      await writeFile(path.join(qleverSource, 'src/engine/Distinct.h'), fakeDistinctHeader, 'utf8');
      await writeFile(path.join(qleverSource, 'src/engine/Filter.h'), fakeFilterHeader, 'utf8');
      await writeFile(path.join(qleverSource, 'src/engine/Bind.h'), fakeBindHeader, 'utf8');
      await writeFile(path.join(qleverSource, 'src/engine/GroupBy.h'), fakeGroupByHeader, 'utf8');
      await writeFile(path.join(qleverSource, 'src/engine/OrderBy.h'), fakeOrderByHeader, 'utf8');
      await writeFile(path.join(qleverSource, 'src/engine/Sort.h'), fakeSortHeader, 'utf8');
      await writeFile(path.join(qleverSource, 'src/engine/LimitOffset.h'), fakeLimitOffsetHeader, 'utf8');
      await writeFile(path.join(qleverSource, 'src/engine/NeutralElementOperation.h'), fakeNeutralElementOperationHeader, 'utf8');
      await writeFile(path.join(qleverSource, 'src/engine/Union.h'), fakeUnionHeader, 'utf8');
      await writeFile(path.join(qleverSource, 'src/engine/TextIndexScanForWord.h'), fakeTextIndexScanForWordHeader, 'utf8');
      await writeFile(path.join(qleverSource, 'src/engine/TextIndexScanForEntity.h'), fakeTextIndexScanForEntityHeader, 'utf8');
      await writeFile(path.join(qleverSource, 'src/engine/TextLimit.h'), fakeTextLimitHeader, 'utf8');
      await writeFile(path.join(qleverSource, 'src/engine/IndexScan.h'), `
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
`, 'utf8');

      const smoke = path.join(root, 'operation_plan_bridge_smoke.cpp');
      const binary = path.join(root, 'operation_plan_bridge_smoke');
      await writeFile(smoke, `
#include <cstring>
#include <memory>
#include <string>
#include <string_view>
#include "engine/Join.h"
#include "engine/CartesianProductJoin.h"
#include "engine/Minus.h"
#include "engine/MultiColumnJoin.h"
#include "engine/ExistsJoin.h"
#include "engine/OptionalJoin.h"
#include "engine/Distinct.h"
#include "engine/Filter.h"
#include "engine/Bind.h"
#include "engine/GroupBy.h"
#include "engine/OrderBy.h"
#include "engine/Sort.h"
#include "engine/LimitOffset.h"
#include "engine/NeutralElementOperation.h"
#include "engine/Union.h"
#include "engine/TextIndexScanForEntity.h"
#include "engine/TextIndexScanForWord.h"
#include "engine/TextLimit.h"
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
  std::string_view value(terms[0].value.data, terms[0].value.size);
  if (value == "urn:entity") {
    out_keys[0] = 77;
  } else if (value == "urn:p") {
    out_keys[0] = 31;
  } else if (value == "urn:o") {
    out_keys[0] = 30;
  } else if (value == "http://qlever.cs.uni-freiburg.de/builtin-functions/default-graph") {
    out_keys[0] = 99;
  } else {
    return XPOD_RDF_STATUS_BACKEND_ERROR;
  }
  out_statuses[0] = XPOD_RDF_STATUS_OK;
  return XPOD_RDF_STATUS_OK;
}

static xpod_rdf_status encode_qlever_id(
    void*,
    xpod_rdf_term_key term,
    uint64_t* out_bits) {
  *out_bits = term + 1000;
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
  if (plan->graph_scope_bindings.size() != 1) return 356;
  if (plan->graph_scope_bindings[0].slot != XPOD_RDF_SLOT_GRAPH) return 357;
  if (plan->graph_scope_bindings[0].kind != XPOD_RDF_TERM_IRI) return 358;
  if (plan->graph_scope_bindings[0].value !=
      "http://qlever.cs.uni-freiburg.de/builtin-functions/default-graph") return 359;
  IndexScan graph_scan(
      TripleComponent{TripleComponent::Iri{"<urn:s>"}},
      TripleComponent{TripleComponent::Iri{"<urn:p>"}},
      TripleComponent{TripleComponent::Iri{"<urn:o>"}},
      Permutation::Enum::SPO,
      "IndexScan SPO <urn:s> <urn:p> <urn:o> ?g",
      1,
      std::vector<ColumnIndex>{0},
      std::vector<ColumnIndex>{ADDITIONAL_COLUMN_GRAPH_ID},
      std::vector<Variable>{Variable{"?g"}});
  auto graph_plan = xpod::qlever::planIndexScanOperation(graph_scan);
  if (!graph_plan.has_value()) return 63;
  if (graph_plan->result_width != 1) return 64;
  if (graph_plan->scan.needed_slots != XPOD_RDF_SLOT_GRAPH) return 65;
  if (graph_plan->output_variables.size() != 1) return 66;
  if (graph_plan->output_variables[0] != "g") return 67;
  if (!graph_plan->graph_scope_bindings.empty()) return 360;
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
  auto task_scan = std::make_shared<QueryExecutionTree>(
      std::make_shared<IndexScan>(
          TripleComponent{Variable{"?task"}},
          TripleComponent{TripleComponent::Iri{"<urn:run>"}},
          TripleComponent{Variable{"?run"}},
          Permutation::Enum::SPO,
          "IndexScan SPO ?task <urn:run> ?run",
          2,
          std::vector<ColumnIndex>{0}));
  auto run_scan = std::make_shared<QueryExecutionTree>(
      std::make_shared<IndexScan>(
          TripleComponent{Variable{"?run"}},
          TripleComponent{TripleComponent::Iri{"<urn:step>"}},
          TripleComponent{Variable{"?step"}},
          Permutation::Enum::SPO,
          "IndexScan SPO ?run <urn:step> ?step",
          2,
          std::vector<ColumnIndex>{0}));
  auto step_scan = std::make_shared<QueryExecutionTree>(
      std::make_shared<IndexScan>(
          TripleComponent{Variable{"?step"}},
          TripleComponent{TripleComponent::Iri{"<urn:status>"}},
          TripleComponent{Variable{"?status"}},
          Permutation::Enum::SPO,
          "IndexScan SPO ?step <urn:status> ?status",
          2,
          std::vector<ColumnIndex>{0}));
  auto task_run_tree = std::make_shared<QueryExecutionTree>(
      std::make_shared<Join>(
          task_scan, run_scan, 3,
          VariableToColumnMap{
              {Variable{"?task"}, {0}},
              {Variable{"?run"}, {1}},
              {Variable{"?step"}, {2}}},
          "Join on ?run"));
  Join task_run_step_join(
      task_run_tree, step_scan, 4,
      VariableToColumnMap{
          {Variable{"?task"}, {0}},
          {Variable{"?run"}, {1}},
          {Variable{"?step"}, {2}},
          {Variable{"?status"}, {3}}},
      "Join on ?step");
  auto task_run_step_plan =
      xpod::qlever::planQleverOperation(task_run_step_join);
  if (!task_run_step_plan.has_value()) return 346;
  if (task_run_step_plan->root.kind !=
      xpod::qlever::BridgeOperationKind::HashJoin) return 347;
  if (task_run_step_plan->root.native_result_only) return 348;
  if (task_run_step_plan->child_plans.size() != 2) return 349;
  if (task_run_step_plan->root.matched_columns.size() != 1) return 350;
  auto task_run_step_physical =
      xpod::qlever::toBridgePhysicalPlan(*task_run_step_plan);
  if (task_run_step_physical.scans.size() != 3) return 351;
  if (task_run_step_physical.root.children.size() != 2) return 353;
  if (task_run_step_physical.root.children[1].kind !=
      xpod::qlever::BridgeOperationKind::PermutationScan) return 352;
  auto limited_step_scan = std::make_shared<QueryExecutionTree>(
      std::make_shared<LimitOffset>(step_scan, 1, 0));
  Join limited_task_run_step_join(
      task_run_tree, limited_step_scan, 4,
      VariableToColumnMap{
          {Variable{"?task"}, {0}},
          {Variable{"?run"}, {1}},
          {Variable{"?step"}, {2}},
          {Variable{"?status"}, {3}}},
      "Join on ?step");
  auto limited_task_run_step_plan =
      xpod::qlever::planQleverOperation(limited_task_run_step_join);
  if (!limited_task_run_step_plan.has_value()) return 354;
  if (!limited_task_run_step_plan->root.native_result_only) return 355;
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
  if (source.request.candidate_kind != XPOD_RDF_TEXT_CANDIDATE_RECORD) return 323;
  if (source.descriptor != "TextIndexScanForWord native-first") return 40;
  auto physical = xpod::qlever::toBridgePhysicalPlan(*text_plan);
  if (physical.root.kind != xpod::qlever::BridgeOperationKind::TextSearch) return 41;
  if (physical.root.candidate_index != 0) return 42;
  if (!physical.scans.empty()) return 43;
  if (physical.text_sources.size() != 1) return 44;
  if (std::string(physical.text_sources[0].request.query.data, physical.text_sources[0].request.query.size) != "native-first") return 45;

  TextIndexScanForWord prefix_text_scan("run*");
  auto prefix_text_plan = xpod::qlever::planQleverOperation(prefix_text_scan);
  if (!prefix_text_plan.has_value()) return 371;
  if (prefix_text_plan->result_width != 2) return 372;
  if (prefix_text_plan->output_variables.size() != 2) return 373;
  if (prefix_text_plan->output_variables[0] != "text") return 374;
  if (prefix_text_plan->output_variables[1] != "match") return 375;

  auto limited_text_tree = std::make_shared<QueryExecutionTree>(
      std::make_shared<TextIndexScanForWord>("native-first"));
  TextLimit text_limit(5, limited_text_tree);
  auto text_limit_plan = xpod::qlever::planQleverOperation(text_limit);
  if (!text_limit_plan.has_value()) return 193;
  if (text_limit_plan->root.kind != xpod::qlever::BridgeOperationKind::TextSearch) return 194;
  if (text_limit_plan->text_sources.size() != 1) return 195;
  if (text_limit_plan->text_sources[0].request.limit != 5) return 196;
  auto text_limit_physical = xpod::qlever::toBridgePhysicalPlan(*text_limit_plan);
  if (text_limit_physical.text_sources.size() != 1) return 197;
  if (text_limit_physical.text_sources[0].request.limit != 5) return 198;

  NeutralElementOperation neutral_operation;
  auto neutral_plan = xpod::qlever::planQleverOperation(neutral_operation);
  if (!neutral_plan.has_value()) return 199;
  if (neutral_plan->root.kind != xpod::qlever::BridgeOperationKind::NeutralElement) return 200;
  if (neutral_plan->result_width != 0) return 201;
  if (!neutral_plan->output_variables.empty()) return 202;
  auto neutral_physical = xpod::qlever::toBridgePhysicalPlan(*neutral_plan);
  if (neutral_physical.root.kind != xpod::qlever::BridgeOperationKind::NeutralElement) return 203;
  if (!neutral_physical.scans.empty()) return 204;

  auto union_left = std::make_shared<QueryExecutionTree>(std::make_shared<IndexScan>());
  auto union_right = std::make_shared<QueryExecutionTree>(std::make_shared<IndexScan>());
  Union union_operation(nullptr, union_left, union_right, std::vector<ColumnIndex>{0});
  auto union_plan = xpod::qlever::planQleverOperation(union_operation);
  if (!union_plan.has_value()) return 205;
  if (union_plan->root.kind != xpod::qlever::BridgeOperationKind::Union) return 206;
  if (union_plan->child_plans.size() != 2) return 207;
  if (union_plan->root.children.size() != 0) return 208;
  if (union_plan->root.column_origins.size() != 2) return 209;
  if (union_plan->root.column_origins[0][0] != 0 || union_plan->root.column_origins[0][1] != 0) return 210;
  if (union_plan->root.column_origins[1][0] != 1 || union_plan->root.column_origins[1][1] != 1) return 211;
  if (union_plan->sorted_by.size() != 1 || union_plan->sorted_by[0] != 0) return 212;
  auto union_physical = xpod::qlever::toBridgePhysicalPlan(*union_plan);
  if (union_physical.root.kind != xpod::qlever::BridgeOperationKind::Union) return 213;
  if (union_physical.root.children.size() != 2) return 214;
  if (union_physical.scans.size() != 2) return 215;
  if (union_physical.root.children[0].scan_indexes.size() != 1 ||
      union_physical.root.children[0].scan_indexes[0] != 0) return 216;
  if (union_physical.root.children[1].scan_indexes.size() != 1 ||
      union_physical.root.children[1].scan_indexes[0] != 1) return 217;

  auto sparse_union_left = std::make_shared<QueryExecutionTree>(
      std::make_shared<IndexScan>(
          TripleComponent{Variable{"?entity"}},
          TripleComponent{TripleComponent::Iri{"<urn:name>"}},
          TripleComponent{Variable{"?name"}},
          Permutation::Enum::SPO,
          "IndexScan SPO ?entity <urn:name> ?name",
          2,
          std::vector<ColumnIndex>{0}));
  auto sparse_union_right = std::make_shared<QueryExecutionTree>(
      std::make_shared<IndexScan>(
          TripleComponent{Variable{"?entity"}},
          TripleComponent{TripleComponent::Iri{"<urn:nick>"}},
          TripleComponent{Variable{"?nick"}},
          Permutation::Enum::SPO,
          "IndexScan SPO ?entity <urn:nick> ?nick",
          2,
          std::vector<ColumnIndex>{0}));
  Union sparse_union_operation(
      sparse_union_left,
      sparse_union_right,
      std::vector<std::array<size_t, 2>>{
          {0, 0},
          {1, Union::NO_COLUMN},
          {Union::NO_COLUMN, 1},
      },
      std::vector<ColumnIndex>{0});
  auto sparse_union_plan = xpod::qlever::planQleverOperation(sparse_union_operation);
  if (!sparse_union_plan.has_value()) return 259;
  if (sparse_union_plan->root.kind != xpod::qlever::BridgeOperationKind::Union) return 260;
  if (sparse_union_plan->result_width != 3) return 261;
  if (sparse_union_plan->output_variables.size() != 3) return 262;
  if (sparse_union_plan->output_variables[0] != "entity") return 263;
  if (sparse_union_plan->output_variables[1] != "name") return 264;
  if (sparse_union_plan->output_variables[2] != "nick") return 265;
  if (sparse_union_plan->root.column_origins.size() != 3) return 266;
  if (sparse_union_plan->root.column_origins[0][0] != 0 ||
      sparse_union_plan->root.column_origins[0][1] != 0) return 267;
  if (sparse_union_plan->root.column_origins[1][0] != 1 ||
      sparse_union_plan->root.column_origins[1][1] != xpod::qlever::BRIDGE_NO_COLUMN) return 268;
  if (sparse_union_plan->root.column_origins[2][0] != xpod::qlever::BRIDGE_NO_COLUMN ||
      sparse_union_plan->root.column_origins[2][1] != 1) return 269;
  auto sparse_union_physical = xpod::qlever::toBridgePhysicalPlan(*sparse_union_plan);
  if (sparse_union_physical.root.kind != xpod::qlever::BridgeOperationKind::Union) return 270;
  if (sparse_union_physical.root.children.size() != 2) return 271;
  if (sparse_union_physical.scans.size() != 2) return 272;

  CartesianProductJoin cartesian_operation(nullptr, {
      std::make_shared<QueryExecutionTree>(std::make_shared<IndexScan>()),
      std::make_shared<QueryExecutionTree>(std::make_shared<IndexScan>())});
  auto cartesian_plan = xpod::qlever::planQleverOperation(cartesian_operation);
  if (!cartesian_plan.has_value()) return 218;
  if (cartesian_plan->root.kind != xpod::qlever::BridgeOperationKind::CartesianProductJoin) return 219;
  if (cartesian_plan->child_plans.size() != 2) return 220;
  if (cartesian_plan->result_width != 4) return 221;
  if (cartesian_plan->output_variables.size() != 4) return 222;
  auto cartesian_physical = xpod::qlever::toBridgePhysicalPlan(*cartesian_plan);
  if (cartesian_physical.root.kind != xpod::qlever::BridgeOperationKind::CartesianProductJoin) return 223;
  if (cartesian_physical.root.children.size() != 2) return 224;
  if (cartesian_physical.scans.size() != 2) return 225;
  if (cartesian_physical.root.children[0].scan_indexes[0] != 0) return 226;
  if (cartesian_physical.root.children[1].scan_indexes[0] != 1) return 227;

  auto minus_left = std::make_shared<QueryExecutionTree>(
      std::make_shared<IndexScan>(
          TripleComponent{Variable{"?entity"}},
          TripleComponent{TripleComponent::Iri{"<urn:label>"}},
          TripleComponent{Variable{"?label"}},
          Permutation::Enum::SPO,
          "IndexScan SPO ?entity <urn:label> ?label",
          2,
          std::vector<ColumnIndex>{0}));
  auto minus_right = std::make_shared<QueryExecutionTree>(
      std::make_shared<IndexScan>(
          TripleComponent{Variable{"?entity"}},
          TripleComponent{TripleComponent::Iri{"<urn:archived>"}},
          TripleComponent{Variable{"?archived"}},
          Permutation::Enum::SPO,
          "IndexScan SPO ?entity <urn:archived> ?archived",
          2,
          std::vector<ColumnIndex>{0}));
  Minus minus_operation(nullptr, minus_left, minus_right);
  auto minus_plan = xpod::qlever::planQleverOperation(minus_operation);
  if (!minus_plan.has_value()) return 228;
  if (minus_plan->root.kind != xpod::qlever::BridgeOperationKind::Minus) return 229;
  if (minus_plan->child_plans.size() != 2) return 230;
  if (minus_plan->result_width != 2) return 231;
  if (minus_plan->output_variables.size() != 2) return 232;
  if (minus_plan->output_variables[0] != "entity") return 233;
  if (minus_plan->output_variables[1] != "label") return 234;
  if (minus_plan->root.matched_columns.size() != 1) return 235;
  if (minus_plan->root.matched_columns[0][0] != 0 ||
      minus_plan->root.matched_columns[0][1] != 0) return 236;
  auto minus_physical = xpod::qlever::toBridgePhysicalPlan(*minus_plan);
  if (minus_physical.root.kind != xpod::qlever::BridgeOperationKind::Minus) return 237;
  if (minus_physical.root.children.size() != 2) return 238;
  if (minus_physical.scans.size() != 2) return 239;
  if (minus_physical.root.children[0].scan_indexes[0] != 0) return 240;
  if (minus_physical.root.children[1].scan_indexes[0] != 1) return 241;

  auto optional_left = std::make_shared<QueryExecutionTree>(
      std::make_shared<IndexScan>(
          TripleComponent{Variable{"?entity"}},
          TripleComponent{TripleComponent::Iri{"<urn:name>"}},
          TripleComponent{Variable{"?name"}},
          Permutation::Enum::SPO,
          "IndexScan SPO ?entity <urn:name> ?name",
          2,
          std::vector<ColumnIndex>{0}));
  auto optional_right = std::make_shared<QueryExecutionTree>(
      std::make_shared<IndexScan>(
          TripleComponent{Variable{"?entity"}},
          TripleComponent{TripleComponent::Iri{"<urn:nick>"}},
          TripleComponent{Variable{"?nick"}},
          Permutation::Enum::SPO,
          "IndexScan SPO ?entity <urn:nick> ?nick",
          2,
          std::vector<ColumnIndex>{0}));
  OptionalJoin optional_operation(nullptr, optional_left, optional_right);
  auto optional_plan = xpod::qlever::planQleverOperation(optional_operation);
  if (!optional_plan.has_value()) return 242;
  if (optional_plan->root.kind != xpod::qlever::BridgeOperationKind::OptionalJoin) return 243;
  if (optional_plan->child_plans.size() != 2) return 244;
  if (optional_plan->result_width != 3) return 245;
  if (optional_plan->output_variables.size() != 3) return 246;
  if (optional_plan->output_variables[0] != "entity") return 247;
  if (optional_plan->output_variables[1] != "name") return 248;
  if (optional_plan->output_variables[2] != "nick") return 249;
  if (optional_plan->root.matched_columns.size() != 1) return 250;
  if (optional_plan->root.matched_columns[0][0] != 0 ||
      optional_plan->root.matched_columns[0][1] != 0) return 251;
  if (optional_plan->root.right_projection_columns.size() != 1) return 252;
  if (optional_plan->root.right_projection_columns[0] != 1) return 253;
  auto optional_physical = xpod::qlever::toBridgePhysicalPlan(*optional_plan);
  if (optional_physical.root.kind != xpod::qlever::BridgeOperationKind::OptionalJoin) return 254;
  if (optional_physical.root.children.size() != 2) return 255;
  if (optional_physical.scans.size() != 2) return 256;
  if (optional_physical.root.children[0].scan_indexes[0] != 0) return 257;
  if (optional_physical.root.children[1].scan_indexes[0] != 1) return 258;

  auto multi_left = std::make_shared<QueryExecutionTree>(
      std::make_shared<IndexScan>(
          TripleComponent{Variable{"?entity"}},
          TripleComponent{Variable{"?category"}},
          TripleComponent{Variable{"?name"}},
          Permutation::Enum::SPO,
          "IndexScan SPO ?entity ?category ?name",
          3,
          std::vector<ColumnIndex>{0, 1}));
  auto multi_right = std::make_shared<QueryExecutionTree>(
      std::make_shared<IndexScan>(
          TripleComponent{Variable{"?entity"}},
          TripleComponent{Variable{"?category"}},
          TripleComponent{Variable{"?score"}},
          Permutation::Enum::SPO,
          "IndexScan SPO ?entity ?category ?score",
          3,
          std::vector<ColumnIndex>{0, 1}));
  MultiColumnJoin multi_operation(nullptr, multi_left, multi_right, 4);
  auto multi_plan = xpod::qlever::planQleverOperation(multi_operation);
  if (!multi_plan.has_value()) return 283;
  if (multi_plan->root.kind != xpod::qlever::BridgeOperationKind::MultiColumnJoin) return 284;
  if (multi_plan->child_plans.size() != 2) return 285;
  if (multi_plan->result_width != 4) return 286;
  if (multi_plan->output_variables.size() != 4) return 287;
  if (multi_plan->output_variables[0] != "entity") return 288;
  if (multi_plan->output_variables[1] != "category") return 289;
  if (multi_plan->output_variables[2] != "name") return 290;
  if (multi_plan->output_variables[3] != "score") return 291;
  if (multi_plan->root.matched_columns.size() != 2) return 292;
  if (multi_plan->root.matched_columns[0][0] != 0 ||
      multi_plan->root.matched_columns[0][1] != 0) return 293;
  if (multi_plan->root.matched_columns[1][0] != 1 ||
      multi_plan->root.matched_columns[1][1] != 1) return 294;
  if (multi_plan->root.right_projection_columns.size() != 1 ||
      multi_plan->root.right_projection_columns[0] != 2) return 295;
  auto multi_physical = xpod::qlever::toBridgePhysicalPlan(*multi_plan);
  if (multi_physical.root.kind != xpod::qlever::BridgeOperationKind::MultiColumnJoin) return 296;
  if (multi_physical.root.children.size() != 2) return 297;
  if (multi_physical.scans.size() != 2) return 298;

  auto exists_left = std::make_shared<QueryExecutionTree>(
      std::make_shared<IndexScan>());
  auto exists_right = std::make_shared<QueryExecutionTree>(
      std::make_shared<IndexScan>(
          TripleComponent{Variable{"?s"}},
          TripleComponent{TripleComponent::Iri{"<urn:p2>"}},
          TripleComponent{Variable{"?tail"}},
          Permutation::Enum::SPO,
          "IndexScan SPO ?s <urn:p2> ?tail",
          2,
          std::vector<ColumnIndex>{0}));
  ExistsJoin exists_operation(nullptr, exists_left, exists_right, Variable{"?_exists"});
  auto exists_plan = xpod::qlever::planQleverOperation(exists_operation);
  if (!exists_plan.has_value()) return 401;
  if (exists_plan->root.kind != xpod::qlever::BridgeOperationKind::ExistsJoin) return 402;
  if (!exists_plan->root.native_result_only) return 403;
  if (exists_plan->child_plans.size() != 2) return 404;
  if (exists_plan->result_width != 3) return 405;
  if (exists_plan->output_variables.size() != 3) return 406;
  if (exists_plan->output_variables[0] != "o") return 407;
  if (exists_plan->output_variables[1] != "s") return 408;
  if (exists_plan->output_variables[2] != "_exists") return 409;
  auto exists_physical = xpod::qlever::toBridgePhysicalPlan(*exists_plan);
  if (exists_physical.root.kind != xpod::qlever::BridgeOperationKind::ExistsJoin) return 410;
  if (!exists_physical.root.native_result_only) return 411;
  if (exists_physical.root.children.size() != 2) return 412;
  if (exists_physical.scans.size() != 2) return 413;

  auto group_child = std::make_shared<QueryExecutionTree>(
      std::make_shared<IndexScan>(
          TripleComponent{Variable{"?entity"}},
          TripleComponent{TripleComponent::Iri{"<urn:category>"}},
          TripleComponent{Variable{"?category"}},
          Permutation::Enum::POS,
          "IndexScan POS ?entity <urn:category> ?category",
          2,
          std::vector<ColumnIndex>{0}));
  GroupBy group_operation(nullptr, group_child, std::vector<Variable>{Variable{"?category"}});
  auto group_plan = xpod::qlever::planQleverOperation(group_operation);
  if (!group_plan.has_value()) return 273;
  if (group_plan->root.kind != xpod::qlever::BridgeOperationKind::GroupBy) return 274;
  if (group_plan->child_plans.size() != 1) return 275;
  if (group_plan->result_width != 1) return 276;
  if (group_plan->output_variables.size() != 1 ||
      group_plan->output_variables[0] != "category") return 277;
  if (group_plan->root.projection_columns.size() != 1 ||
      group_plan->root.projection_columns[0] != 0) return 278;
  auto group_physical = xpod::qlever::toBridgePhysicalPlan(*group_plan);
  if (group_physical.root.kind != xpod::qlever::BridgeOperationKind::GroupBy) return 279;
  if (group_physical.root.children.size() != 1) return 280;
  if (group_physical.scans.size() != 1) return 281;
  if (group_physical.root.children[0].scan_indexes[0] != 0) return 282;

  GroupBy scalar_group_operation(
      nullptr,
      group_child,
      std::vector<Variable>{},
      GroupBy::Aliases{Alias{Variable{"?count"}}});
  auto scalar_group_plan =
      xpod::qlever::planQleverOperation(scalar_group_operation);
  if (!scalar_group_plan.has_value()) return 299;
  if (scalar_group_plan->root.kind != xpod::qlever::BridgeOperationKind::GroupBy) return 300;
  if (!scalar_group_plan->root.native_result_only) return 301;
  if (!scalar_group_plan->root.projection_columns.empty()) return 302;
  if (scalar_group_plan->output_variables.size() != 1 ||
      scalar_group_plan->output_variables[0] != "count") return 303;
  if (scalar_group_plan->result_width != 1) return 304;

  auto scalar_group_tree = std::make_shared<QueryExecutionTree>(
      std::make_shared<GroupBy>(
          nullptr,
          group_child,
          std::vector<Variable>{},
          GroupBy::Aliases{Alias{Variable{"?count"}}}));
  Filter aggregate_filter_operation(
      scalar_group_tree,
      sparqlExpression::SparqlExpressionPimpl{"(COUNT(?o) > 1)"});
  auto aggregate_filter_plan =
      xpod::qlever::planQleverOperation(aggregate_filter_operation);
  if (!aggregate_filter_plan.has_value()) return 313;
  if (aggregate_filter_plan->root.kind != xpod::qlever::BridgeOperationKind::GroupBy) return 314;
  if (!aggregate_filter_plan->root.native_result_only) return 315;
  if (aggregate_filter_plan->output_variables.size() != 1 ||
      aggregate_filter_plan->output_variables[0] != "count") return 316;
  if (aggregate_filter_plan->descriptor.find("Filter") == std::string::npos) return 317;

  auto bind_child = std::make_shared<QueryExecutionTree>(
      std::make_shared<IndexScan>());
  Bind bind_operation(
      bind_child,
      parsedQuery::Bind{
          sparqlExpression::SparqlExpressionPimpl{"?s"},
          Variable{"?copy"}});
  auto bind_plan = xpod::qlever::planQleverOperation(bind_operation);
  if (!bind_plan.has_value()) return 318;
  if (bind_plan->output_variables.size() != 3) return 319;
  if (bind_plan->output_variables[0] != "o" ||
      bind_plan->output_variables[1] != "s" ||
      bind_plan->output_variables[2] != "copy") return 320;
  if (bind_plan->result_width != 3) return 321;
  if (bind_plan->descriptor.find("BIND") == std::string::npos) return 322;

  TextIndexScanForEntity fixed_entity_scan("native-first", "<urn:entity>");
  const Operation& fixed_entity_operation = fixed_entity_scan;
  auto entity_plan = xpod::qlever::planQleverOperation(fixed_entity_operation);
  if (!entity_plan.has_value()) return 46;
  if (entity_plan->root.kind != xpod::qlever::BridgeOperationKind::TextSearch) return 47;
  if (entity_plan->text_sources.size() != 1) return 48;
  if (entity_plan->text_sources[0].request.candidate_kind !=
      XPOD_RDF_TEXT_CANDIDATE_ENTITY) return 324;
  if (entity_plan->text_required_entities.size() != 1) return 49;
  if (entity_plan->text_required_entities[0].text_source_index != 0) return 50;
  if (entity_plan->text_required_entities[0].term.kind != XPOD_RDF_TERM_IRI) return 51;
  if (entity_plan->text_required_entities[0].term.value != "urn:entity") return 52;

  xpod_rdf_backend_v1 backend = {};
  backend.abi_version = XPOD_RDF_PHYSICAL_BACKEND_ABI_VERSION;
  backend.struct_size = sizeof(xpod_rdf_backend_v1);
  backend.lookup_terms = lookup_terms;
  backend.encode_qlever_id = encode_qlever_id;
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
  xpod_rdf_status scan_bind_status =
      xpod::qlever::bindPlanTerms(physical_backend, snapshot, *plan, error);
  if (scan_bind_status != XPOD_RDF_STATUS_OK) return 361;
  if (plan->scan.graph_scope.kind != XPOD_RDF_GRAPH_SCOPE_EXACT) return 362;
  if (plan->scan.graph_scope.exact_graph != 99) return 363;
  auto scan_physical = xpod::qlever::toBridgePhysicalPlan(*plan);
  if (scan_physical.scans.size() != 1) return 364;
  if (scan_physical.scans[0].scan.graph_scope.kind !=
      XPOD_RDF_GRAPH_SCOPE_EXACT) return 365;
  if (scan_physical.scans[0].scan.graph_scope.exact_graph != 99) return 366;
  auto filter_child = std::make_shared<QueryExecutionTree>(
      std::make_shared<IndexScan>(
          TripleComponent{Variable{"?s"}},
          TripleComponent{Variable{"?p"}},
          TripleComponent{Variable{"?o"}},
          Permutation::Enum::SPO,
          "IndexScan SPO ?s ?p ?o",
          3,
          std::vector<ColumnIndex>{0}));
  Filter filter_operation(
      filter_child,
      sparqlExpression::SparqlExpressionPimpl{"(?o = <urn:o>)"});
  auto filter_plan = xpod::qlever::planQleverOperation(filter_operation);
  if (!filter_plan.has_value()) return 301;
  if (filter_plan->root.kind != xpod::qlever::BridgeOperationKind::PermutationScan) return 302;
  if (filter_plan->root.result_modifiers.size() != 1) return 303;
  if (filter_plan->root.result_modifiers[0].kind !=
      xpod::qlever::BridgeResultModifierKind::EqualTerm) return 304;
  if (filter_plan->root.result_modifiers[0].columns.size() != 1 ||
      filter_plan->root.result_modifiers[0].columns[0] != 2) return 305;
  if (filter_plan->modifier_term_bindings.size() != 1) return 306;
  if (filter_plan->modifier_term_bindings[0].modifier_index != 0) return 307;
  if (filter_plan->modifier_term_bindings[0].term.kind != XPOD_RDF_TERM_IRI) return 308;
  if (filter_plan->modifier_term_bindings[0].term.value != "urn:o") return 309;
  bind_status = xpod::qlever::bindPlanTerms(physical_backend, snapshot, *filter_plan, error);
  if (bind_status != XPOD_RDF_STATUS_OK) return 310;
  if (!filter_plan->root.result_modifiers[0].has_term_id_bits) return 311;
  if (filter_plan->root.result_modifiers[0].term_id_bits != 1030) return 312;

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
  if (limit_plan->root.has_limit) return 144;
  if (limit_plan->root.result_modifiers.size() != 1) return 145;
  if (limit_plan->root.result_modifiers[0].kind !=
      xpod::qlever::BridgeResultModifierKind::LimitOffset) return 146;
  if (limit_plan->root.result_modifiers[0].limit != 1) return 299;
  if (limit_plan->root.result_modifiers[0].offset != 2) return 300;
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
  if (distinct_plan->root.has_distinct) return 153;
  if (!distinct_plan->root.distinct_columns.empty()) return 154;
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

  auto sort_tree = std::make_shared<QueryExecutionTree>(
      std::make_shared<IndexScan>(
          TripleComponent{Variable{"?s"}},
          TripleComponent{Variable{"?p"}},
          TripleComponent{Variable{"?o"}},
          Permutation::Enum::SPO,
          "IndexScan SPO ?s ?p ?o",
          3,
          std::vector<ColumnIndex>{0}));
  Sort sort_operation(sort_tree, std::vector<ColumnIndex>{2, 0});
  auto sort_plan = xpod::qlever::planQleverOperation(sort_operation);
  if (!sort_plan.has_value()) return 179;
  if (sort_plan->root.kind != xpod::qlever::BridgeOperationKind::PermutationScan) return 180;
  if (sort_plan->root.result_modifiers.size() != 1) return 181;
  if (sort_plan->root.result_modifiers[0].kind !=
      xpod::qlever::BridgeResultModifierKind::InternalSort) return 182;
  if (sort_plan->root.result_modifiers[0].columns.size() != 2) return 183;
  if (sort_plan->root.result_modifiers[0].columns[0] != 2) return 184;
  if (sort_plan->root.result_modifiers[0].columns[1] != 0) return 185;
  if (sort_plan->sorted_by.size() != 2) return 186;
  if (sort_plan->sorted_by[0] != 2) return 187;
  if (sort_plan->sorted_by[1] != 0) return 188;
  if (sort_plan->output_variables.size() != 3) return 189;
  if (sort_plan->output_variables[0] != "s") return 190;
  if (sort_plan->output_variables[1] != "p") return 191;
  if (sort_plan->output_variables[2] != "o") return 192;
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
        '-I', path.join(repoRoot, 'qlever/rdf_protocol/include'),
        '-I', path.join(qleverSource, 'src'),
        smoke,
        '-o',
        binary,
      ], { stdio: 'pipe' });
      execFileSync(binary, [], { stdio: 'pipe' });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 30_000);

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
      await writeFile(path.join(qleverSource, 'src/global/Id.h'), fakeQleverIdHeader, 'utf8');
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
#include <utility>
#include <vector>
#include "engine/QueryExecutionTree.h"
#include "global/Id.h"
#include "parser/ParsedQuery.h"
struct ColumnIndexAndTypeInfo { ColumnIndex columnIndex_; };
using VariableToColumnMap = std::vector<std::pair<Variable, ColumnIndexAndTypeInfo>>;
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
  virtual const VariableToColumnMap& getExternallyVisibleVariableColumns() const {
    static const VariableToColumnMap empty{};
    return empty;
  }
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
        '-I', path.join(repoRoot, 'qlever/rdf_protocol/include'),
        '-I', path.join(qleverSource, 'src'),
        smoke,
        '-o',
        binary,
      ], { stdio: 'pipe' });
      execFileSync(binary, [], { stdio: 'pipe' });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 30_000);
});
