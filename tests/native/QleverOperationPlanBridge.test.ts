import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { fakeParsedQueryHeader, fakeQueryExecutionTreeHeader, fakeSparqlTripleHeader } from './qleverFakeHeaders';

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
#include <memory>
#include "XpodQleverOperationPlanBridge.hpp"

int main() {
  IndexScan scan;
  auto plan = xpod::qlever::planIndexScanOperation(scan);
  if (!plan.has_value()) return 1;
  if (plan->descriptor != "IndexScan POS ?s <urn:p> ?o") return 2;
  if (plan->result_width != 2) return 3;
  if (plan->sorted_by.size() != 2 || plan->sorted_by[0] != 0 || plan->sorted_by[1] != 1) return 4;
  if (plan->scan.permutation != Permutation::Enum::POS) return 5;
  if (plan->scan.needed_slots !=
      (XPOD_RDF_SLOT_SUBJECT | XPOD_RDF_SLOT_PREDICATE | XPOD_RDF_SLOT_OBJECT)) return 6;
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
