import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'bun:test';
import { fakeExistsExpressionHeader, fakeParsedQueryHeader, fakeSparqlTripleHeader } from './qleverFakeHeaders';

const repoRoot = path.resolve(__dirname, '../..');
const planHeader = path.join(repoRoot, 'qlever/qlever_adapter/src/XpodQleverPlanBridge.hpp');

function hasCxx(): boolean {
  try {
    execFileSync('/usr/bin/env', ['c++', '--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

const nativeIt = (name: string, fn: () => Promise<void> | void): void => {
  it(name, fn, 30_000);
};

describe('QLever parsed plan bridge', () => {
  nativeIt('builds an executable Xpod scan plan from a QLever ParsedQuery BGP', async () => {
    expect(hasCxx(), 'c++ compiler is required for native plan bridge check').toBe(true);

    const root = await mkdtemp(path.join(os.tmpdir(), 'xpod-qlever-plan-'));
    try {
      const qleverSource = path.join(root, 'qlever');
      await mkdir(path.join(qleverSource, 'src/engine/sparqlExpressions'), { recursive: true });
      await mkdir(path.join(qleverSource, 'src/parser'), { recursive: true });
      await mkdir(path.join(qleverSource, 'src/index'), { recursive: true });
      await mkdir(path.join(qleverSource, 'src/global'), { recursive: true });
      await writeFile(
        path.join(qleverSource, 'src/engine/sparqlExpressions/ExistsExpression.h'),
        fakeExistsExpressionHeader,
        'utf8',
      );
      await writeFile(path.join(qleverSource, 'src/parser/ParsedQuery.h'), fakeParsedQueryHeader, 'utf8');
      await writeFile(path.join(qleverSource, 'src/parser/SparqlTriple.h'), fakeSparqlTripleHeader, 'utf8');
      await writeFile(path.join(qleverSource, 'src/global/Id.h'), '#pragma once\n#include <cstdint>\nusing ColumnIndex = uint64_t;\nclass Id { public: static Id fromBits(uint64_t bits) { return Id(bits); } uint64_t getBits() const { return bits_; } private: explicit Id(uint64_t bits) : bits_(bits) {} uint64_t bits_; };\n', 'utf8');
      await writeFile(path.join(qleverSource, 'src/index/Permutation.h'), `
#pragma once
class Permutation {
 public:
  enum struct Enum { PSO, POS, SPO, SOP, OPS, OSP };
};
`, 'utf8');

      const smoke = path.join(root, 'plan_bridge_smoke.cpp');
      const binary = path.join(root, 'plan_bridge_smoke');
      await writeFile(smoke, `
#include "XpodQleverPlanBridge.hpp"

int main() {
  ParsedQuery parsed = ParsedQuery::minimalSelect();
  auto plan = xpod::qlever::planParsedQuery(parsed);
  if (!plan.has_value()) return 1;
  if (plan->descriptor != "xpod scan ?s ?p ?o") return 2;
  if (plan->result_width != 3) return 3;
  if (plan->sorted_by.size() != 1 || plan->sorted_by[0] != 0) return 4;
  if (plan->scan.permutation != Permutation::Enum::SPO) return 5;
  if (plan->scan.needed_slots !=
      (XPOD_RDF_SLOT_SUBJECT | XPOD_RDF_SLOT_PREDICATE | XPOD_RDF_SLOT_OBJECT)) return 6;

  ParsedQuery chain;
  parsedQuery::BasicGraphPattern chain_basic;
  chain_basic._triples.emplace_back(
      TripleComponent{Variable{"?task"}},
      TripleComponent{TripleComponent::Iri{"<urn:run>"}},
      TripleComponent{Variable{"?run"}});
  chain_basic._triples.emplace_back(
      TripleComponent{Variable{"?run"}},
      TripleComponent{TripleComponent::Iri{"<urn:step>"}},
      TripleComponent{Variable{"?step"}});
  chain_basic._triples.emplace_back(
      TripleComponent{Variable{"?step"}},
      TripleComponent{TripleComponent::Iri{"<urn:status>"}},
      TripleComponent{Variable{"?status"}});
  chain._rootGraphPattern._graphPatterns.emplace_back(std::move(chain_basic));
  chain.select_clause_.setSelected(
      {Variable{"?task"}, Variable{"?run"}, Variable{"?step"}, Variable{"?status"}});
  auto chain_plan = xpod::qlever::planParsedQuery(chain);
  if (!chain_plan.has_value()) return 7;
  if (chain_plan->root.kind != xpod::qlever::BridgeOperationKind::MultiColumnJoin) return 8;
  if (chain_plan->child_plans.size() != 2) return 9;
  if (chain_plan->child_plans[0].root.kind !=
      xpod::qlever::BridgeOperationKind::MultiColumnJoin) return 10;
  if (chain_plan->child_plans[1].root.kind !=
      xpod::qlever::BridgeOperationKind::PermutationScan) return 11;
  if (chain_plan->root.matched_columns.size() != 1) return 12;
  if (chain_plan->output_variables !=
      std::vector<std::string>{"task", "run", "step", "status"}) return 13;
  return 0;
}
`, 'utf8');

      execFileSync('c++', [
        '-std=c++17',
        '-Wall',
        '-Wextra',
        '-Werror',
        '-DXPOD_QLEVER_ADAPTER_ENABLE_QLEVER=1',
        '-I', path.dirname(planHeader),
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
  });

  nativeIt('binds parsed IRI constants through the native term dictionary into the scan pattern', async () => {
    expect(hasCxx(), 'c++ compiler is required for native plan bridge check').toBe(true);

    const root = await mkdtemp(path.join(os.tmpdir(), 'xpod-qlever-plan-bind-'));
    try {
      const qleverSource = path.join(root, 'qlever');
      await mkdir(path.join(qleverSource, 'src/parser'), { recursive: true });
      await mkdir(path.join(qleverSource, 'src/index'), { recursive: true });
      await mkdir(path.join(qleverSource, 'src/global'), { recursive: true });
      await writeFile(path.join(qleverSource, 'src/parser/ParsedQuery.h'), fakeParsedQueryHeader, 'utf8');
      await writeFile(path.join(qleverSource, 'src/parser/SparqlTriple.h'), fakeSparqlTripleHeader, 'utf8');
      await writeFile(path.join(qleverSource, 'src/global/Id.h'), '#pragma once\n#include <cstdint>\nusing ColumnIndex = uint64_t;\nclass Id { public: static Id fromBits(uint64_t bits) { return Id(bits); } uint64_t getBits() const { return bits_; } private: explicit Id(uint64_t bits) : bits_(bits) {} uint64_t bits_; };\n', 'utf8');
      await writeFile(path.join(qleverSource, 'src/index/Permutation.h'), `
#pragma once
class Permutation {
 public:
  enum struct Enum { PSO, POS, SPO, SOP, OPS, OSP };
};
`, 'utf8');

      const smoke = path.join(root, 'plan_bridge_bind_smoke.cpp');
      const binary = path.join(root, 'plan_bridge_bind_smoke');
      await writeFile(smoke, `
#include <string_view>
#include "XpodQleverPlanBridge.hpp"

static xpod_rdf_status lookup_terms(
    void*,
    const xpod_rdf_term* terms,
    size_t term_count,
    const xpod_rdf_snapshot*,
    xpod_rdf_term_key* out_keys,
    xpod_rdf_status* out_statuses) {
  for (size_t index = 0; index < term_count; ++index) {
    if (terms[index].kind != XPOD_RDF_TERM_IRI) return XPOD_RDF_STATUS_BACKEND_ERROR;
    const std::string_view value(terms[index].value.data, terms[index].value.size);
    if (value == "urn:p") {
      out_keys[index] = 20;
    } else if (value == xpod::qlever::QleverDefaultGraphIri) {
      out_keys[index] = 1;
    } else {
      return XPOD_RDF_STATUS_BACKEND_ERROR;
    }
    out_statuses[index] = XPOD_RDF_STATUS_OK;
  }
  return XPOD_RDF_STATUS_OK;
}

int main() {
  ParsedQuery parsed = ParsedQuery::predicateIriSelect();
  auto plan = xpod::qlever::planParsedQuery(parsed);
  if (!plan.has_value()) return 1;
  if (plan->term_bindings.size() != 1) return 2;
  if (plan->term_bindings[0].slot != XPOD_RDF_SLOT_PREDICATE) return 3;
  if (plan->term_bindings[0].kind != XPOD_RDF_TERM_IRI) return 4;
  if (plan->term_bindings[0].value != "urn:p") return 5;
  if (plan->scan.needed_slots !=
      (XPOD_RDF_SLOT_SUBJECT | XPOD_RDF_SLOT_OBJECT)) return 10;
  if (plan->scan.permutation != Permutation::Enum::PSO) return 14;
  if (plan->result_width != 2) return 11;
  if (plan->output_variables.size() != 2) return 12;
  if (plan->output_variables[0] != "s" || plan->output_variables[1] != "o") return 13;

  xpod_rdf_backend_v1 backend = {};
  backend.abi_version = XPOD_RDF_PHYSICAL_BACKEND_ABI_VERSION;
  backend.struct_size = sizeof(xpod_rdf_backend_v1);
  backend.lookup_terms = lookup_terms;
  xpod::rdf::PhysicalBackend physical(&backend);
  xpod_rdf_snapshot snapshot = {};
  std::string error;
  xpod_rdf_status status = xpod::qlever::bindPlanTerms(physical, snapshot, *plan, error);
  if (status != XPOD_RDF_STATUS_OK) return 6;
  if (!plan->scan.pattern.has_predicate) return 7;
  if (plan->scan.pattern.predicate != 20) return 8;
  if (plan->scan.pattern.has_subject || plan->scan.pattern.has_object) return 9;
  return 0;
}
`, 'utf8');

      execFileSync('c++', [
        '-std=c++17',
        '-Wall',
        '-Wextra',
        '-Werror',
        '-DXPOD_QLEVER_ADAPTER_ENABLE_QLEVER=1',
        '-I', path.dirname(planHeader),
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
  });

  nativeIt('binds parsed GRAPH IRIs through the native term dictionary into the scan graph pattern', async () => {
    expect(hasCxx(), 'c++ compiler is required for native graph plan bridge check').toBe(true);

    const root = await mkdtemp(path.join(os.tmpdir(), 'xpod-qlever-plan-graph-'));
    try {
      const qleverSource = path.join(root, 'qlever');
      await mkdir(path.join(qleverSource, 'src/parser'), { recursive: true });
      await mkdir(path.join(qleverSource, 'src/index'), { recursive: true });
      await mkdir(path.join(qleverSource, 'src/global'), { recursive: true });
      await writeFile(path.join(qleverSource, 'src/parser/ParsedQuery.h'), fakeParsedQueryHeader, 'utf8');
      await writeFile(path.join(qleverSource, 'src/parser/SparqlTriple.h'), fakeSparqlTripleHeader, 'utf8');
      await writeFile(path.join(qleverSource, 'src/global/Id.h'), '#pragma once\n#include <cstdint>\nusing ColumnIndex = uint64_t;\nclass Id { public: static Id fromBits(uint64_t bits) { return Id(bits); } uint64_t getBits() const { return bits_; } private: explicit Id(uint64_t bits) : bits_(bits) {} uint64_t bits_; };\n', 'utf8');
      await writeFile(path.join(qleverSource, 'src/index/Permutation.h'), `
#pragma once
class Permutation {
 public:
  enum struct Enum { PSO, POS, SPO, SOP, OPS, OSP };
};
`, 'utf8');

      const smoke = path.join(root, 'plan_bridge_graph_smoke.cpp');
      const binary = path.join(root, 'plan_bridge_graph_smoke');
      await writeFile(smoke, `
#include <string_view>
#include "XpodQleverPlanBridge.hpp"

static xpod_rdf_status lookup_terms(
    void*,
    const xpod_rdf_term* terms,
    size_t term_count,
    const xpod_rdf_snapshot*,
    xpod_rdf_term_key* out_keys,
    xpod_rdf_status* out_statuses) {
  if (term_count != 1) return XPOD_RDF_STATUS_BACKEND_ERROR;
  if (terms[0].kind != XPOD_RDF_TERM_IRI) return XPOD_RDF_STATUS_BACKEND_ERROR;
  if (std::string_view(terms[0].value.data, terms[0].value.size) != "urn:g") return XPOD_RDF_STATUS_BACKEND_ERROR;
  out_keys[0] = 40;
  out_statuses[0] = XPOD_RDF_STATUS_OK;
  return XPOD_RDF_STATUS_OK;
}

int main() {
  ParsedQuery parsed = ParsedQuery::graphIriSelect();
  auto plan = xpod::qlever::planParsedQuery(parsed);
  if (!plan.has_value()) return 1;
  if (plan->term_bindings.size() != 1) return 2;
  if (plan->term_bindings[0].slot != XPOD_RDF_SLOT_GRAPH) return 3;
  if (plan->term_bindings[0].kind != XPOD_RDF_TERM_IRI) return 4;
  if (plan->term_bindings[0].value != "urn:g") return 5;
  if (plan->scan.needed_slots !=
      (XPOD_RDF_SLOT_SUBJECT | XPOD_RDF_SLOT_PREDICATE | XPOD_RDF_SLOT_OBJECT)) return 6;
  if (plan->result_width != 3) return 7;

  xpod_rdf_backend_v1 backend = {};
  backend.abi_version = XPOD_RDF_PHYSICAL_BACKEND_ABI_VERSION;
  backend.struct_size = sizeof(xpod_rdf_backend_v1);
  backend.lookup_terms = lookup_terms;
  xpod::rdf::PhysicalBackend physical(&backend);
  xpod_rdf_snapshot snapshot = {};
  std::string error;
  xpod_rdf_status status = xpod::qlever::bindPlanTerms(physical, snapshot, *plan, error);
  if (status != XPOD_RDF_STATUS_OK) return 8;
  if (!plan->scan.pattern.has_graph || plan->scan.pattern.graph != 40) return 9;
  if (plan->scan.pattern.has_subject || plan->scan.pattern.has_predicate || plan->scan.pattern.has_object) return 10;
  return 0;
}
`, 'utf8');

      execFileSync('c++', [
        '-std=c++17',
        '-Wall',
        '-Wextra',
        '-Werror',
        '-DXPOD_QLEVER_ADAPTER_ENABLE_QLEVER=1',
        '-I', path.dirname(planHeader),
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
  });

  nativeIt('projects parsed GRAPH variables as the scan graph slot', async () => {
    expect(hasCxx(), 'c++ compiler is required for native graph variable plan bridge check').toBe(true);

    const root = await mkdtemp(path.join(os.tmpdir(), 'xpod-qlever-plan-graph-var-'));
    try {
      const qleverSource = path.join(root, 'qlever');
      await mkdir(path.join(qleverSource, 'src/parser'), { recursive: true });
      await mkdir(path.join(qleverSource, 'src/index'), { recursive: true });
      await mkdir(path.join(qleverSource, 'src/global'), { recursive: true });
      await writeFile(path.join(qleverSource, 'src/parser/ParsedQuery.h'), fakeParsedQueryHeader, 'utf8');
      await writeFile(path.join(qleverSource, 'src/parser/SparqlTriple.h'), fakeSparqlTripleHeader, 'utf8');
      await writeFile(path.join(qleverSource, 'src/global/Id.h'), '#pragma once\n#include <cstdint>\nusing ColumnIndex = uint64_t;\nclass Id { public: static Id fromBits(uint64_t bits) { return Id(bits); } uint64_t getBits() const { return bits_; } private: explicit Id(uint64_t bits) : bits_(bits) {} uint64_t bits_; };\n', 'utf8');
      await writeFile(path.join(qleverSource, 'src/index/Permutation.h'), `
#pragma once
class Permutation {
 public:
  enum struct Enum { PSO, POS, SPO, SOP, OPS, OSP };
};
`, 'utf8');

      const smoke = path.join(root, 'plan_bridge_graph_variable_smoke.cpp');
      const binary = path.join(root, 'plan_bridge_graph_variable_smoke');
      await writeFile(smoke, `
#include "XpodQleverPlanBridge.hpp"

int main() {
  ParsedQuery parsed = ParsedQuery::graphVariableSelect();
  auto plan = xpod::qlever::planParsedQuery(parsed);
  if (!plan.has_value()) return 1;
  if (!plan->term_bindings.empty()) return 2;
  if (plan->scan.needed_slots !=
      (XPOD_RDF_SLOT_SUBJECT | XPOD_RDF_SLOT_PREDICATE | XPOD_RDF_SLOT_OBJECT | XPOD_RDF_SLOT_GRAPH)) return 3;
  if (plan->result_width != 4) return 4;
  if (plan->output_variables.size() != 4) return 5;
  if (plan->output_variables[0] != "s") return 6;
  if (plan->output_variables[1] != "p") return 7;
  if (plan->output_variables[2] != "o") return 8;
  if (plan->output_variables[3] != "g") return 9;

  xpod::qlever::BridgePhysicalPlan physical =
      xpod::qlever::toBridgePhysicalPlan(*plan);
  if (physical.scans.size() != 1) return 10;
  if (physical.scans[0].scan.needed_slots != plan->scan.needed_slots) return 11;
  if (physical.scans[0].result_width != 4) return 12;
  return 0;
}
`, 'utf8');

      execFileSync('c++', [
        '-std=c++17',
        '-Wall',
        '-Wextra',
        '-Werror',
        '-DXPOD_QLEVER_ADAPTER_ENABLE_QLEVER=1',
        '-I', path.dirname(planHeader),
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
  });

  nativeIt('joins parsed GRAPH variable groups on subject and graph slots', async () => {
    expect(hasCxx(), 'c++ compiler is required for native graph variable join plan bridge check').toBe(true);

    const root = await mkdtemp(path.join(os.tmpdir(), 'xpod-qlever-plan-graph-var-join-'));
    try {
      const qleverSource = path.join(root, 'qlever');
      await mkdir(path.join(qleverSource, 'src/parser'), { recursive: true });
      await mkdir(path.join(qleverSource, 'src/index'), { recursive: true });
      await mkdir(path.join(qleverSource, 'src/global'), { recursive: true });
      await writeFile(path.join(qleverSource, 'src/parser/ParsedQuery.h'), fakeParsedQueryHeader, 'utf8');
      await writeFile(path.join(qleverSource, 'src/parser/SparqlTriple.h'), fakeSparqlTripleHeader, 'utf8');
      await writeFile(path.join(qleverSource, 'src/global/Id.h'), '#pragma once\n#include <cstdint>\nusing ColumnIndex = uint64_t;\nclass Id { public: static Id fromBits(uint64_t bits) { return Id(bits); } uint64_t getBits() const { return bits_; } private: explicit Id(uint64_t bits) : bits_(bits) {} uint64_t bits_; };\n', 'utf8');
      await writeFile(path.join(qleverSource, 'src/index/Permutation.h'), `
#pragma once
class Permutation {
 public:
  enum struct Enum { PSO, POS, SPO, SOP, OPS, OSP };
};
`, 'utf8');

      const smoke = path.join(root, 'plan_bridge_graph_variable_join_smoke.cpp');
      const binary = path.join(root, 'plan_bridge_graph_variable_join_smoke');
      await writeFile(smoke, `
#include "XpodQleverPlanBridge.hpp"

int main() {
  ParsedQuery parsed = ParsedQuery::graphVariableSubjectFilterSelect();
  auto plan = xpod::qlever::planParsedQuery(parsed);
  if (!plan.has_value()) return 1;
  if (plan->root.kind != xpod::qlever::BridgeOperationKind::HashJoin) return 2;
  if (plan->root.scan_indexes.size() != 2) return 3;
  if (plan->filter_scans.size() != 1) return 4;
  if (plan->scan.needed_slots !=
      (XPOD_RDF_SLOT_SUBJECT | XPOD_RDF_SLOT_PREDICATE | XPOD_RDF_SLOT_OBJECT | XPOD_RDF_SLOT_GRAPH)) return 5;
  if (plan->filter_scans[0].scan.needed_slots !=
      (XPOD_RDF_SLOT_SUBJECT | XPOD_RDF_SLOT_PREDICATE | XPOD_RDF_SLOT_OBJECT | XPOD_RDF_SLOT_GRAPH)) return 6;
  if (plan->root.join_key_slots.size() != 2) return 7;
  if (plan->root.join_key_slots[0].size() != 2 ||
      plan->root.join_key_slots[0][0] != XPOD_RDF_SLOT_SUBJECT ||
      plan->root.join_key_slots[0][1] != XPOD_RDF_SLOT_GRAPH) return 8;
  if (plan->root.join_key_slots[1].size() != 2 ||
      plan->root.join_key_slots[1][0] != XPOD_RDF_SLOT_SUBJECT ||
      plan->root.join_key_slots[1][1] != XPOD_RDF_SLOT_GRAPH) return 9;
  if (plan->root.scan_project_slots.size() != 2) return 10;
  if (plan->root.scan_project_slots[0].size() != 4) return 11;
  if (!plan->root.scan_project_slots[1].empty()) return 12;
  if (plan->output_variables.size() != 4 || plan->output_variables[3] != "g") return 13;

  xpod::qlever::BridgePhysicalPlan physical =
      xpod::qlever::toBridgePhysicalPlan(*plan);
  if (physical.scans.size() != 2) return 14;
  if (physical.root.join_key_slots.size() != 2) return 15;
  if (physical.root.scan_project_slots.size() != 2) return 16;
  return 0;
}
`, 'utf8');

      execFileSync('c++', [
        '-std=c++17',
        '-Wall',
        '-Wextra',
        '-Werror',
        '-DXPOD_QLEVER_ADAPTER_ENABLE_QLEVER=1',
        '-I', path.dirname(planHeader),
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
  });


  nativeIt('binds parsed literal constants through the native term dictionary into the scan pattern', async () => {
    expect(hasCxx(), 'c++ compiler is required for native plan bridge check').toBe(true);

    const root = await mkdtemp(path.join(os.tmpdir(), 'xpod-qlever-plan-literal-'));
    try {
      const qleverSource = path.join(root, 'qlever');
      await mkdir(path.join(qleverSource, 'src/parser'), { recursive: true });
      await mkdir(path.join(qleverSource, 'src/index'), { recursive: true });
      await mkdir(path.join(qleverSource, 'src/global'), { recursive: true });
      await writeFile(path.join(qleverSource, 'src/parser/ParsedQuery.h'), fakeParsedQueryHeader, 'utf8');
      await writeFile(path.join(qleverSource, 'src/parser/SparqlTriple.h'), fakeSparqlTripleHeader, 'utf8');
      await writeFile(path.join(qleverSource, 'src/global/Id.h'), '#pragma once\n#include <cstdint>\nusing ColumnIndex = uint64_t;\nclass Id { public: static Id fromBits(uint64_t bits) { return Id(bits); } uint64_t getBits() const { return bits_; } private: explicit Id(uint64_t bits) : bits_(bits) {} uint64_t bits_; };\n', 'utf8');
      await writeFile(path.join(qleverSource, 'src/index/Permutation.h'), `
#pragma once
class Permutation {
 public:
  enum struct Enum { PSO, POS, SPO, SOP, OPS, OSP };
};
`, 'utf8');

      const smoke = path.join(root, 'plan_bridge_literal_smoke.cpp');
      const binary = path.join(root, 'plan_bridge_literal_smoke');
      await writeFile(smoke, `
#include <string_view>
#include "XpodQleverPlanBridge.hpp"

static xpod_rdf_status lookup_terms(
    void*,
    const xpod_rdf_term* terms,
    size_t term_count,
    const xpod_rdf_snapshot*,
    xpod_rdf_term_key* out_keys,
    xpod_rdf_status* out_statuses) {
  for (size_t index = 0; index < term_count; ++index) {
    const std::string_view value(terms[index].value.data, terms[index].value.size);
    if (terms[index].kind == XPOD_RDF_TERM_LITERAL && value == "value" &&
        terms[index].datatype_iri.size == 0 && terms[index].language.size == 0) {
      out_keys[index] = 30;
    } else if (terms[index].kind == XPOD_RDF_TERM_IRI &&
               value == xpod::qlever::QleverDefaultGraphIri) {
      out_keys[index] = 1;
    } else {
      return XPOD_RDF_STATUS_BACKEND_ERROR;
    }
    out_statuses[index] = XPOD_RDF_STATUS_OK;
  }
  return XPOD_RDF_STATUS_OK;
}

int main() {
  ParsedQuery parsed = ParsedQuery::objectLiteralSelect();
  auto plan = xpod::qlever::planParsedQuery(parsed);
  if (!plan.has_value()) return 1;
  if (plan->term_bindings.size() != 1) return 2;
  if (plan->term_bindings[0].slot != XPOD_RDF_SLOT_OBJECT) return 3;
  if (plan->term_bindings[0].kind != XPOD_RDF_TERM_LITERAL) return 4;
  if (plan->term_bindings[0].value != "value") return 5;
  if (plan->scan.needed_slots !=
      (XPOD_RDF_SLOT_SUBJECT | XPOD_RDF_SLOT_PREDICATE)) return 10;
  if (plan->result_width != 2) return 11;
  if (plan->output_variables.size() != 2) return 12;
  if (plan->output_variables[0] != "s" || plan->output_variables[1] != "p") return 13;

  xpod_rdf_backend_v1 backend = {};
  backend.abi_version = XPOD_RDF_PHYSICAL_BACKEND_ABI_VERSION;
  backend.struct_size = sizeof(xpod_rdf_backend_v1);
  backend.lookup_terms = lookup_terms;
  xpod::rdf::PhysicalBackend physical(&backend);
  xpod_rdf_snapshot snapshot = {};
  std::string error;
  xpod_rdf_status status = xpod::qlever::bindPlanTerms(physical, snapshot, *plan, error);
  if (status != XPOD_RDF_STATUS_OK) return 6;
  if (!plan->scan.pattern.has_object) return 7;
  if (plan->scan.pattern.object != 30) return 8;
  if (plan->scan.pattern.has_subject || plan->scan.pattern.has_predicate) return 9;
  return 0;
}
`, 'utf8');

      execFileSync('c++', [
        '-std=c++17',
        '-Wall',
        '-Wextra',
        '-Werror',
        '-DXPOD_QLEVER_ADAPTER_ENABLE_QLEVER=1',
        '-I', path.dirname(planHeader),
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
  });


  nativeIt('exposes a QLever-like operation root for single scan and hash join plans', async () => {
    expect(hasCxx(), 'c++ compiler is required for native plan bridge check').toBe(true);

    const root = await mkdtemp(path.join(os.tmpdir(), 'xpod-qlever-operation-root-'));
    try {
      const qleverSource = path.join(root, 'qlever');
      await mkdir(path.join(qleverSource, 'src/parser'), { recursive: true });
      await mkdir(path.join(qleverSource, 'src/index'), { recursive: true });
      await mkdir(path.join(qleverSource, 'src/global'), { recursive: true });
      await writeFile(path.join(qleverSource, 'src/parser/ParsedQuery.h'), fakeParsedQueryHeader, 'utf8');
      await writeFile(path.join(qleverSource, 'src/parser/SparqlTriple.h'), fakeSparqlTripleHeader, 'utf8');
      await writeFile(path.join(qleverSource, 'src/global/Id.h'), '#pragma once\n#include <cstdint>\nusing ColumnIndex = uint64_t;\nclass Id { public: static Id fromBits(uint64_t bits) { return Id(bits); } uint64_t getBits() const { return bits_; } private: explicit Id(uint64_t bits) : bits_(bits) {} uint64_t bits_; };\n', 'utf8');
      await writeFile(path.join(qleverSource, 'src/index/Permutation.h'), `
#pragma once
class Permutation {
 public:
  enum struct Enum { PSO, POS, SPO, SOP, OPS, OSP };
};
`, 'utf8');

      const smoke = path.join(root, 'operation_root_smoke.cpp');
      const binary = path.join(root, 'operation_root_smoke');
      await writeFile(smoke, `
#include "XpodQleverPlanBridge.hpp"

int main() {
  auto single = xpod::qlever::planParsedQuery(ParsedQuery::minimalSelect());
  if (!single.has_value()) return 1;
  if (single->root.kind != xpod::qlever::BridgeOperationKind::PermutationScan) return 2;
  if (single->root.scan_indexes.size() != 1 || single->root.scan_indexes[0] != 0) return 3;
  if (xpod::qlever::profileKind(single->root.kind) != std::string_view("PermutationScan")) return 4;

  auto joined = xpod::qlever::planParsedQuery(ParsedQuery::subjectFilterSelect());
  if (!joined.has_value()) return 5;
  if (joined->root.kind != xpod::qlever::BridgeOperationKind::HashJoin) return 6;
  if (joined->root.join_slot != XPOD_RDF_SLOT_SUBJECT) return 7;
  if (joined->root.scan_indexes.size() != 2) return 8;
  if (joined->root.scan_indexes[0] != 0 || joined->root.scan_indexes[1] != 1) return 9;
  if (xpod::qlever::profileKind(joined->root.kind) != std::string_view("HashJoin")) return 10;
  auto physical = xpod::qlever::toBridgePhysicalPlan(*joined);
  if (physical.root.profile_node != 1) return 11;
  if (physical.scans.size() != 2) return 12;
  if (physical.scans[0].profile_node != 2 || physical.scans[0].parent_profile_node != 1) return 13;
  if (physical.scans[1].profile_node != 3 || physical.scans[1].parent_profile_node != 1) return 14;
  return 0;
}
`, 'utf8');

      execFileSync('c++', [
        '-std=c++17',
        '-Wall',
        '-Wextra',
        '-Werror',
        '-DXPOD_QLEVER_ADAPTER_ENABLE_QLEVER=1',
        '-I', path.dirname(planHeader),
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
  });

  nativeIt('pushes parsed not-equals IRI filters into bounded physical scans', async () => {
    expect(hasCxx(), 'c++ compiler is required for native filter plan bridge check').toBe(true);

    const root = await mkdtemp(path.join(os.tmpdir(), 'xpod-qlever-plan-filter-'));
    try {
      const qleverSource = path.join(root, 'qlever');
      await mkdir(path.join(qleverSource, 'src/engine/sparqlExpressions'), { recursive: true });
      await mkdir(path.join(qleverSource, 'src/parser'), { recursive: true });
      await mkdir(path.join(qleverSource, 'src/index'), { recursive: true });
      await mkdir(path.join(qleverSource, 'src/global'), { recursive: true });
      await writeFile(
        path.join(qleverSource, 'src/engine/sparqlExpressions/ExistsExpression.h'),
        fakeExistsExpressionHeader,
        'utf8',
      );
      await writeFile(path.join(qleverSource, 'src/parser/ParsedQuery.h'), fakeParsedQueryHeader, 'utf8');
      await writeFile(path.join(qleverSource, 'src/parser/SparqlTriple.h'), fakeSparqlTripleHeader, 'utf8');
      await writeFile(path.join(qleverSource, 'src/global/Id.h'), '#pragma once\n#include <cstdint>\nusing ColumnIndex = uint64_t;\nclass Id { public: static Id fromBits(uint64_t bits) { return Id(bits); } uint64_t getBits() const { return bits_; } private: explicit Id(uint64_t bits) : bits_(bits) {} uint64_t bits_; };\n', 'utf8');
      await writeFile(path.join(qleverSource, 'src/index/Permutation.h'), `
#pragma once
class Permutation {
 public:
  enum struct Enum { PSO, POS, SPO, SOP, OPS, OSP };
};
`, 'utf8');

      const smoke = path.join(root, 'plan_bridge_filter_smoke.cpp');
      const binary = path.join(root, 'plan_bridge_filter_smoke');
      await writeFile(smoke, `
#include <string_view>
#include "XpodQleverPlanBridge.hpp"

static bool lookup_one_term(const xpod_rdf_term& term, xpod_rdf_term_key& out_key) {
  std::string_view value(term.value.data, term.value.size);
  if (term.kind == XPOD_RDF_TERM_IRI && value == "urn:s") {
    out_key = 10;
  } else if (term.kind == XPOD_RDF_TERM_IRI && value == "urn:p") {
    out_key = 20;
  } else if (term.kind == XPOD_RDF_TERM_IRI && value == "urn:tail") {
    out_key = 70;
  } else if (term.kind == XPOD_RDF_TERM_IRI && value == "urn:o") {
    out_key = 30;
  } else if (term.kind == XPOD_RDF_TERM_IRI && value == "urn:p2") {
    out_key = 40;
  } else if (term.kind == XPOD_RDF_TERM_IRI && value == "urn:missing-p") {
    out_key = 170;
  } else if (term.kind == XPOD_RDF_TERM_IRI && value == "urn:literal-s") {
    out_key = 15;
  } else if (term.kind == XPOD_RDF_TERM_IRI && value == "urn:missing") {
    out_key = 160;
  } else if (term.kind == XPOD_RDF_TERM_LITERAL && value == "literal-value") {
    out_key = 80;
  } else if (term.kind == XPOD_RDF_TERM_LITERAL &&
             value == "1" &&
             std::string_view(term.datatype_iri.data, term.datatype_iri.size) ==
                 "http://www.w3.org/2001/XMLSchema#integer") {
    out_key = 110;
  } else if (term.kind == XPOD_RDF_TERM_LITERAL &&
             value == "2" &&
             std::string_view(term.datatype_iri.data, term.datatype_iri.size) ==
                 "http://www.w3.org/2001/XMLSchema#integer") {
    out_key = 120;
  } else if (term.kind == XPOD_RDF_TERM_LITERAL &&
             value == "false" &&
             std::string_view(term.datatype_iri.data, term.datatype_iri.size) ==
                 "http://www.w3.org/2001/XMLSchema#boolean") {
    out_key = 130;
  } else if (term.kind == XPOD_RDF_TERM_IRI &&
             value == xpod::qlever::QleverDefaultGraphIri) {
    out_key = 1;
  } else {
    return false;
  }
  return true;
}

static xpod_rdf_status lookup_terms(
    void*,
    const xpod_rdf_term* terms,
    size_t term_count,
    const xpod_rdf_snapshot*,
    xpod_rdf_term_key* out_keys,
    xpod_rdf_status* out_statuses) {
  for (size_t index = 0; index < term_count; ++index) {
    if (!lookup_one_term(terms[index], out_keys[index])) {
      return XPOD_RDF_STATUS_BACKEND_ERROR;
    }
    out_statuses[index] = XPOD_RDF_STATUS_OK;
  }
  return XPOD_RDF_STATUS_OK;
}
static xpod_rdf_status encode_qlever_id(void*, xpod_rdf_term_key term, uint64_t* out_bits) {
  *out_bits = term + 1000;
  return XPOD_RDF_STATUS_OK;
}
static uint32_t backend_feature_mask = XPOD_RDF_BACKEND_FEATURE_SCAN_FILTER;
static xpod_rdf_status get_capabilities(
    void*, xpod_rdf_backend_capabilities* out) {
  *out = {};
  out->features = backend_feature_mask;
  return XPOD_RDF_STATUS_OK;
}

int main() {
  ParsedQuery parsed = ParsedQuery::filterObjectNotTailSelect();
  auto plan = xpod::qlever::planParsedQuery(parsed);
  if (!plan.has_value()) return 1;
  if (plan->root.result_modifiers.size() != 2) return 2;
  if (plan->root.result_modifiers[0].kind !=
      xpod::qlever::BridgeResultModifierKind::NotEqualTerm) return 3;
  if (plan->root.result_modifiers[1].kind !=
      xpod::qlever::BridgeResultModifierKind::Project) return 52;
  if (plan->root.result_modifiers[1].columns.size() != 2 ||
      plan->root.result_modifiers[1].columns[0] != 0 ||
      plan->root.result_modifiers[1].columns[1] != 2) return 53;
  if (plan->modifier_term_bindings.size() != 1) return 5;
  if (plan->scan.filters.size() != 1 ||
      plan->scan.filters[0].slot != XPOD_RDF_SLOT_OBJECT ||
      plan->scan.filters[0].kind !=
          XPOD_RDF_SCAN_FILTER_TERM_NOT_EQUAL) return 6;
  if (plan->scan_filter_term_bindings.size() != 1 ||
      plan->scan_filter_term_bindings[0].term.value != "urn:tail") return 7;
  if (plan->descriptor.find("Filter") == std::string::npos) return 8;

  xpod_rdf_backend_v1 backend = {};
  backend.abi_version = XPOD_RDF_PHYSICAL_BACKEND_ABI_VERSION;
  backend.struct_size = sizeof(xpod_rdf_backend_v1);
  backend.lookup_terms = lookup_terms;
  backend.encode_qlever_id = encode_qlever_id;
  backend.get_capabilities = get_capabilities;
  xpod::rdf::PhysicalBackend physical(&backend);
  xpod_rdf_snapshot snapshot = {};
  std::string error;
  xpod_rdf_status status = xpod::qlever::bindPlanTerms(physical, snapshot, *plan, error);
  if (status != XPOD_RDF_STATUS_OK) return 9;
  if (plan->scan.filters[0].term != 70) return 11;
  if (!plan->root.result_modifiers[0].has_term_id_bits ||
      plan->root.result_modifiers[0].term_id_bits != 1070) return 10;

  auto fallback_plan =
      xpod::qlever::planParsedQuery(ParsedQuery::filterObjectNotTailSelect());
  if (!fallback_plan.has_value()) return 301;
  backend.get_capabilities = nullptr;
  status = xpod::qlever::bindPlanTerms(
      physical, snapshot, *fallback_plan, error);
  if (status != XPOD_RDF_STATUS_OK) return 302;
  if (!fallback_plan->scan.filters.empty()) return 303;
  if (!fallback_plan->root.result_modifiers[0].has_term_id_bits ||
      fallback_plan->root.result_modifiers[0].term_id_bits != 1070) return 304;
  backend.get_capabilities = get_capabilities;

  auto equal_plan = xpod::qlever::planParsedQuery(ParsedQuery::filterObjectEqualsOSelect());
  if (!equal_plan.has_value()) return 12;
  if (equal_plan->root.result_modifiers.size() != 1) return 13;
  if (equal_plan->root.result_modifiers[0].kind !=
      xpod::qlever::BridgeResultModifierKind::Project) return 14;
  if (!equal_plan->modifier_term_bindings.empty()) return 15;
  if (equal_plan->term_bindings.size() != 1) return 16;
  if (equal_plan->term_bindings[0].slot != XPOD_RDF_SLOT_OBJECT ||
      equal_plan->term_bindings[0].value != "urn:o") return 17;
  status = xpod::qlever::bindPlanTerms(physical, snapshot, *equal_plan, error);
  if (status != XPOD_RDF_STATUS_OK) return 18;
  if (!equal_plan->scan.pattern.has_object) return 19;
  if (equal_plan->scan.pattern.object != 30) return 20;

  auto in_plan = xpod::qlever::planParsedQuery(ParsedQuery::filterObjectInSelect());
  if (!in_plan.has_value()) return 71;
  if (in_plan->root.result_modifiers.size() != 2) return 72;
  const auto& in_modifier = in_plan->root.result_modifiers[0];
  if (in_modifier.kind != xpod::qlever::BridgeResultModifierKind::InTerm) return 73;
  if (in_modifier.columns.size() != 1 || in_modifier.columns[0] != 2) return 74;
  if (in_plan->modifier_term_bindings.size() != 2) return 75;
  if (in_plan->modifier_term_bindings[0].modifier_index != 0 ||
      in_plan->modifier_term_bindings[1].modifier_index != 0) return 76;
  if (in_plan->modifier_term_bindings[0].term.value != "urn:o") return 77;
  if (in_plan->modifier_term_bindings[1].term.value != "urn:tail") return 78;
  status = xpod::qlever::bindPlanTerms(physical, snapshot, *in_plan, error);
  if (status != XPOD_RDF_STATUS_OK) return 79;
  if (in_plan->root.result_modifiers[0].term_id_bits_list.size() != 2) return 80;
  if (in_plan->root.result_modifiers[0].term_id_bits_list[0] != 1030) return 81;
  if (in_plan->root.result_modifiers[0].term_id_bits_list[1] != 1070) return 82;

  auto not_in_plan = xpod::qlever::planParsedQuery(ParsedQuery::filterObjectNotInSelect());
  if (!not_in_plan.has_value()) return 83;
  if (not_in_plan->root.result_modifiers.size() != 2) return 84;
  const auto& not_in_modifier = not_in_plan->root.result_modifiers[0];
  if (not_in_modifier.kind != xpod::qlever::BridgeResultModifierKind::NotInTerm) return 85;
  if (not_in_modifier.columns.size() != 1 || not_in_modifier.columns[0] != 2) return 86;
  if (not_in_plan->modifier_term_bindings.size() != 1) return 87;
  if (not_in_plan->modifier_term_bindings[0].modifier_index != 0) return 88;
  if (not_in_plan->modifier_term_bindings[0].term.value != "urn:tail") return 89;
  status = xpod::qlever::bindPlanTerms(physical, snapshot, *not_in_plan, error);
  if (status != XPOD_RDF_STATUS_OK) return 90;
  if (not_in_plan->root.result_modifiers[0].term_id_bits_list.size() != 1) return 91;
  if (not_in_plan->root.result_modifiers[0].term_id_bits_list[0] != 1070) return 92;

  auto integer_in_plan = xpod::qlever::planParsedQuery(ParsedQuery::filterObjectInIntegerSelect());
  if (!integer_in_plan.has_value()) return 93;
  if (integer_in_plan->root.result_modifiers.size() != 2) return 94;
  const auto& integer_in_modifier = integer_in_plan->root.result_modifiers[0];
  if (integer_in_modifier.kind != xpod::qlever::BridgeResultModifierKind::InTerm) return 95;
  if (integer_in_modifier.columns.size() != 1 || integer_in_modifier.columns[0] != 2) return 96;
  if (integer_in_plan->modifier_term_bindings.size() != 2) return 97;
  if (integer_in_plan->modifier_term_bindings[0].term.kind != XPOD_RDF_TERM_LITERAL ||
      integer_in_plan->modifier_term_bindings[0].term.value != "1" ||
      integer_in_plan->modifier_term_bindings[0].term.datatype_iri !=
          "http://www.w3.org/2001/XMLSchema#integer") return 98;
  if (integer_in_plan->modifier_term_bindings[1].term.kind != XPOD_RDF_TERM_LITERAL ||
      integer_in_plan->modifier_term_bindings[1].term.value != "2" ||
      integer_in_plan->modifier_term_bindings[1].term.datatype_iri !=
          "http://www.w3.org/2001/XMLSchema#integer") return 99;
  status = xpod::qlever::bindPlanTerms(physical, snapshot, *integer_in_plan, error);
  if (status != XPOD_RDF_STATUS_OK) return 100;
  if (integer_in_plan->root.result_modifiers[0].term_id_bits_list.size() != 2) return 101;
  if (integer_in_plan->root.result_modifiers[0].term_id_bits_list[0] != 1110) return 102;
  if (integer_in_plan->root.result_modifiers[0].term_id_bits_list[1] != 1120) return 103;

  auto bool_not_in_plan = xpod::qlever::planParsedQuery(ParsedQuery::filterObjectNotInBoolSelect());
  if (!bool_not_in_plan.has_value()) return 104;
  if (bool_not_in_plan->root.result_modifiers.size() != 2) return 105;
  const auto& bool_not_in_modifier = bool_not_in_plan->root.result_modifiers[0];
  if (bool_not_in_modifier.kind != xpod::qlever::BridgeResultModifierKind::NotInTerm) return 106;
  if (bool_not_in_modifier.columns.size() != 1 || bool_not_in_modifier.columns[0] != 2) return 107;
  if (bool_not_in_plan->modifier_term_bindings.size() != 1) return 108;
  if (bool_not_in_plan->modifier_term_bindings[0].term.kind != XPOD_RDF_TERM_LITERAL ||
      bool_not_in_plan->modifier_term_bindings[0].term.value != "false" ||
      bool_not_in_plan->modifier_term_bindings[0].term.datatype_iri !=
          "http://www.w3.org/2001/XMLSchema#boolean") return 109;
  status = xpod::qlever::bindPlanTerms(physical, snapshot, *bool_not_in_plan, error);
  if (status != XPOD_RDF_STATUS_OK) return 110;
  if (bool_not_in_plan->root.result_modifiers[0].term_id_bits_list.size() != 1) return 111;
  if (bool_not_in_plan->root.result_modifiers[0].term_id_bits_list[0] != 1130) return 112;

  auto greater_than_plan =
      xpod::qlever::planParsedQuery(ParsedQuery::filterObjectGreaterThanIntegerSelect());
  if (!greater_than_plan.has_value()) return 113;
  if (greater_than_plan->root.result_modifiers.size() != 2) return 114;
  const auto& greater_than_modifier = greater_than_plan->root.result_modifiers[0];
  if (greater_than_modifier.kind !=
      xpod::qlever::BridgeResultModifierKind::GreaterThanTerm) return 115;
  if (greater_than_modifier.columns.size() != 1 ||
      greater_than_modifier.columns[0] != 2) return 116;
  if (greater_than_plan->modifier_term_bindings.size() != 1) return 117;
  if (greater_than_plan->modifier_term_bindings[0].term.kind != XPOD_RDF_TERM_LITERAL ||
      greater_than_plan->modifier_term_bindings[0].term.value != "1" ||
      greater_than_plan->modifier_term_bindings[0].term.datatype_iri !=
          "http://www.w3.org/2001/XMLSchema#integer") return 118;
  if (greater_than_plan->scan.filters.size() != 1 ||
      greater_than_plan->scan.filters[0].slot != XPOD_RDF_SLOT_OBJECT ||
      greater_than_plan->scan.filters[0].kind !=
          XPOD_RDF_SCAN_FILTER_VALUE_GREATER_THAN) return 1181;
  xpod_rdf_scan_request greater_request =
      xpod::qlever::makeScanRequest(greater_than_plan->scan);
  if (!greater_request.filters[0].has_operand ||
      std::string_view(
          greater_request.filters[0].operand.value.data,
          greater_request.filters[0].operand.value.size) != "1" ||
      std::string_view(
          greater_request.filters[0].operand.datatype_iri.data,
          greater_request.filters[0].operand.datatype_iri.size) !=
          "http://www.w3.org/2001/XMLSchema#integer") return 1182;
  status = xpod::qlever::bindPlanTerms(physical, snapshot, *greater_than_plan, error);
  if (status != XPOD_RDF_STATUS_OK) return 119;
  if (!greater_than_plan->scan.filters.empty()) return 1191;
  if (!greater_than_plan->root.result_modifiers[0].has_term_id_bits) return 120;
  if (greater_than_plan->root.result_modifiers[0].term_id_bits != 1110) return 121;

  auto and_plan = xpod::qlever::planParsedQuery(
      ParsedQuery::filterObjectGreaterAndSubjectLiteralSelect());
  if (!and_plan.has_value()) return 122;
  if (and_plan->root.result_modifiers.size() != 2) return 123;
  const auto& and_greater_modifier = and_plan->root.result_modifiers[0];
  if (and_greater_modifier.kind !=
      xpod::qlever::BridgeResultModifierKind::GreaterThanTerm) return 124;
  if (and_greater_modifier.columns.size() != 1 ||
      and_greater_modifier.columns[0] != 2) return 125;
  if (and_plan->root.result_modifiers[1].kind !=
      xpod::qlever::BridgeResultModifierKind::Project) return 128;
  if (and_plan->modifier_term_bindings.size() != 1) return 129;
  if (and_plan->modifier_term_bindings[0].modifier_index != 0 ||
      and_plan->modifier_term_bindings[0].term.value != "1") return 130;
  if (and_plan->term_bindings.size() != 1 ||
      and_plan->term_bindings[0].slot != XPOD_RDF_SLOT_SUBJECT ||
      and_plan->term_bindings[0].value != "urn:literal-s") return 131;
  status = xpod::qlever::bindPlanTerms(physical, snapshot, *and_plan, error);
  if (status != XPOD_RDF_STATUS_OK) return 132;
  if (!and_plan->root.result_modifiers[0].has_term_id_bits ||
      and_plan->root.result_modifiers[0].term_id_bits != 1110) return 133;
  if (!and_plan->scan.pattern.has_subject ||
      and_plan->scan.pattern.subject != 15) return 134;

  auto or_plan = xpod::qlever::planParsedQuery(
      ParsedQuery::filterObjectTailOrOSelect());
  if (!or_plan.has_value()) return 135;
  if (or_plan->root.result_modifiers.size() != 2) return 136;
  const auto& or_modifier = or_plan->root.result_modifiers[0];
  if (or_modifier.kind != xpod::qlever::BridgeResultModifierKind::AnyOf) return 137;
  if (or_modifier.child_modifiers.size() != 2) return 138;
  if (or_modifier.child_modifiers[0].kind !=
      xpod::qlever::BridgeResultModifierKind::EqualTerm) return 139;
  if (or_modifier.child_modifiers[1].kind !=
      xpod::qlever::BridgeResultModifierKind::EqualTerm) return 140;
  if (or_modifier.child_modifiers[0].columns.size() != 1 ||
      or_modifier.child_modifiers[0].columns[0] != 2) return 141;
  if (or_modifier.child_modifiers[1].columns.size() != 1 ||
      or_modifier.child_modifiers[1].columns[0] != 2) return 142;
  if (or_plan->modifier_term_bindings.size() != 2) return 143;
  if (or_plan->modifier_term_bindings[0].modifier_index != 0 ||
      or_plan->modifier_term_bindings[0].child_indexes.size() != 1 ||
      or_plan->modifier_term_bindings[0].child_indexes[0] != 0 ||
      or_plan->modifier_term_bindings[0].term.value != "urn:tail") return 144;
  if (or_plan->modifier_term_bindings[1].modifier_index != 0 ||
      or_plan->modifier_term_bindings[1].child_indexes.size() != 1 ||
      or_plan->modifier_term_bindings[1].child_indexes[0] != 1 ||
      or_plan->modifier_term_bindings[1].term.value != "urn:o") return 145;
  status = xpod::qlever::bindPlanTerms(physical, snapshot, *or_plan, error);
  if (status != XPOD_RDF_STATUS_OK) return 146;
  if (!or_plan->root.result_modifiers[0].child_modifiers[0].has_term_id_bits ||
      or_plan->root.result_modifiers[0].child_modifiers[0].term_id_bits != 1070) return 147;
  if (!or_plan->root.result_modifiers[0].child_modifiers[1].has_term_id_bits ||
      or_plan->root.result_modifiers[0].child_modifiers[1].term_id_bits != 1030) return 148;

  auto exists_or_plan = xpod::qlever::planParsedQuery(
      ParsedQuery::filterObjectTailOrExistsSelect());
  if (!exists_or_plan.has_value()) return 176;
  if (exists_or_plan->root.result_modifiers.size() != 2) return 177;
  const auto& exists_or_modifier = exists_or_plan->root.result_modifiers[0];
  if (exists_or_modifier.kind !=
      xpod::qlever::BridgeResultModifierKind::AnyOf) return 178;
  if (exists_or_modifier.child_modifiers.size() != 2) return 179;
  if (exists_or_modifier.child_modifiers[0].kind !=
      xpod::qlever::BridgeResultModifierKind::EqualTerm) return 180;
  if (exists_or_modifier.child_modifiers[1].kind !=
      xpod::qlever::BridgeResultModifierKind::Exists) return 181;
  if (exists_or_modifier.child_modifiers[1].exists_child_index != 0) return 182;
  if (exists_or_modifier.child_modifiers[1].exists_negated) return 183;
  if (exists_or_modifier.child_modifiers[1].matched_columns.size() != 1 ||
      exists_or_modifier.child_modifiers[1].matched_columns[0][0] != 2 ||
      exists_or_modifier.child_modifiers[1].matched_columns[0][1] != 0) return 184;
  if (exists_or_plan->child_plans.size() != 1) return 185;
  if (exists_or_plan->child_plans[0].term_bindings.size() != 1 ||
      exists_or_plan->child_plans[0].term_bindings[0].slot != XPOD_RDF_SLOT_PREDICATE ||
      exists_or_plan->child_plans[0].term_bindings[0].value != "urn:p2") return 186;
  if (exists_or_plan->modifier_term_bindings.size() != 1 ||
      exists_or_plan->modifier_term_bindings[0].modifier_index != 0 ||
      exists_or_plan->modifier_term_bindings[0].child_indexes.size() != 1 ||
      exists_or_plan->modifier_term_bindings[0].child_indexes[0] != 0 ||
      exists_or_plan->modifier_term_bindings[0].term.value != "urn:tail") return 187;
  status = xpod::qlever::bindPlanTerms(physical, snapshot, *exists_or_plan, error);
  if (status != XPOD_RDF_STATUS_OK) return 188;
  if (!exists_or_plan->root.result_modifiers[0]
           .child_modifiers[0].has_term_id_bits ||
      exists_or_plan->root.result_modifiers[0]
           .child_modifiers[0].term_id_bits != 1070) return 189;
  if (!exists_or_plan->child_plans[0].scan.pattern.has_predicate ||
      exists_or_plan->child_plans[0].scan.pattern.predicate != 40) return 190;

  auto two_exists_plan = xpod::qlever::planParsedQuery(
      ParsedQuery::filterTwoExistsSelect());
  if (!two_exists_plan.has_value()) return 221;
  if (two_exists_plan->root.result_modifiers.size() != 2) return 222;
  const auto& two_exists_modifier = two_exists_plan->root.result_modifiers[0];
  if (two_exists_modifier.kind !=
      xpod::qlever::BridgeResultModifierKind::AnyOf) return 223;
  if (two_exists_modifier.child_modifiers.size() != 2) return 224;
  if (two_exists_modifier.child_modifiers[0].kind !=
      xpod::qlever::BridgeResultModifierKind::Exists) return 225;
  if (two_exists_modifier.child_modifiers[1].kind !=
      xpod::qlever::BridgeResultModifierKind::Exists) return 226;
  if (two_exists_modifier.child_modifiers[0].exists_child_index != 0) return 227;
  if (two_exists_modifier.child_modifiers[1].exists_child_index != 1) return 228;
  if (two_exists_modifier.child_modifiers[0].matched_columns.size() != 1 ||
      two_exists_modifier.child_modifiers[0].matched_columns[0][0] != 2 ||
      two_exists_modifier.child_modifiers[0].matched_columns[0][1] != 0) return 229;
  if (two_exists_modifier.child_modifiers[1].matched_columns.size() != 1 ||
      two_exists_modifier.child_modifiers[1].matched_columns[0][0] != 2 ||
      two_exists_modifier.child_modifiers[1].matched_columns[0][1] != 0) return 230;
  if (two_exists_plan->child_plans.size() != 2) return 231;
  if (two_exists_plan->child_plans[0].term_bindings.size() != 1 ||
      two_exists_plan->child_plans[0].term_bindings[0].slot != XPOD_RDF_SLOT_PREDICATE ||
      two_exists_plan->child_plans[0].term_bindings[0].value != "urn:p2") return 232;
  if (two_exists_plan->child_plans[1].term_bindings.size() != 1 ||
      two_exists_plan->child_plans[1].term_bindings[0].slot != XPOD_RDF_SLOT_PREDICATE ||
      two_exists_plan->child_plans[1].term_bindings[0].value != "urn:missing-p") return 233;
  status = xpod::qlever::bindPlanTerms(physical, snapshot, *two_exists_plan, error);
  if (status != XPOD_RDF_STATUS_OK) return 234;
  if (!two_exists_plan->child_plans[0].scan.pattern.has_predicate ||
      two_exists_plan->child_plans[0].scan.pattern.predicate != 40) return 235;
  if (!two_exists_plan->child_plans[1].scan.pattern.has_predicate ||
      two_exists_plan->child_plans[1].scan.pattern.predicate != 170) return 236;

  auto exists_and_plan = xpod::qlever::planParsedQuery(
      ParsedQuery::filterObjectOAndExistsSelect());
  if (!exists_and_plan.has_value()) return 191;
  if (exists_and_plan->root.result_modifiers.size() != 2) return 192;
  if (exists_and_plan->root.result_modifiers[0].kind !=
      xpod::qlever::BridgeResultModifierKind::Exists) return 194;
  if (exists_and_plan->root.result_modifiers[0].exists_child_index != 0) return 195;
  if (exists_and_plan->root.result_modifiers[0].matched_columns.size() != 1 ||
      exists_and_plan->root.result_modifiers[0].matched_columns[0][0] != 2 ||
      exists_and_plan->root.result_modifiers[0].matched_columns[0][1] != 0) return 196;
  if (exists_and_plan->root.result_modifiers[1].kind !=
      xpod::qlever::BridgeResultModifierKind::Project) return 197;
  if (exists_and_plan->child_plans.size() != 1) return 198;
  if (!exists_and_plan->modifier_term_bindings.empty() ||
      exists_and_plan->term_bindings.size() != 1 ||
      exists_and_plan->term_bindings[0].slot != XPOD_RDF_SLOT_OBJECT ||
      exists_and_plan->term_bindings[0].value != "urn:o") return 199;
  status = xpod::qlever::bindPlanTerms(physical, snapshot, *exists_and_plan, error);
  if (status != XPOD_RDF_STATUS_OK) return 200;
  if (!exists_and_plan->scan.pattern.has_object ||
      exists_and_plan->scan.pattern.object != 30) return 201;
  if (!exists_and_plan->child_plans[0].scan.pattern.has_predicate ||
      exists_and_plan->child_plans[0].scan.pattern.predicate != 40) return 202;

  auto nested_exists_or_plan = xpod::qlever::planParsedQuery(
      ParsedQuery::filterObjectOAndExistsOrMissingSubjectSelect());
  if (!nested_exists_or_plan.has_value()) return 203;
  if (nested_exists_or_plan->root.result_modifiers.size() != 2) return 204;
  const auto& nested_exists_or_modifier =
      nested_exists_or_plan->root.result_modifiers[0];
  if (nested_exists_or_modifier.kind !=
      xpod::qlever::BridgeResultModifierKind::AnyOf) return 205;
  if (nested_exists_or_modifier.child_modifiers.size() != 2) return 206;
  if (nested_exists_or_modifier.child_modifiers[0].kind !=
      xpod::qlever::BridgeResultModifierKind::AllOf) return 207;
  if (nested_exists_or_modifier.child_modifiers[0].child_modifiers.size() != 2) return 208;
  if (nested_exists_or_modifier.child_modifiers[0].child_modifiers[0].kind !=
      xpod::qlever::BridgeResultModifierKind::EqualTerm) return 209;
  if (nested_exists_or_modifier.child_modifiers[0].child_modifiers[1].kind !=
      xpod::qlever::BridgeResultModifierKind::Exists) return 210;
  if (nested_exists_or_modifier.child_modifiers[0]
          .child_modifiers[1].exists_child_index != 0) return 211;
  if (nested_exists_or_modifier.child_modifiers[1].kind !=
      xpod::qlever::BridgeResultModifierKind::EqualTerm) return 212;
  if (nested_exists_or_plan->child_plans.size() != 1) return 213;
  if (nested_exists_or_plan->modifier_term_bindings.size() != 2) return 214;
  if (nested_exists_or_plan->modifier_term_bindings[0].modifier_index != 0 ||
      nested_exists_or_plan->modifier_term_bindings[0].child_indexes.size() != 2 ||
      nested_exists_or_plan->modifier_term_bindings[0].child_indexes[0] != 0 ||
      nested_exists_or_plan->modifier_term_bindings[0].child_indexes[1] != 0 ||
      nested_exists_or_plan->modifier_term_bindings[0].term.value != "urn:o") return 215;
  if (nested_exists_or_plan->modifier_term_bindings[1].modifier_index != 0 ||
      nested_exists_or_plan->modifier_term_bindings[1].child_indexes.size() != 1 ||
      nested_exists_or_plan->modifier_term_bindings[1].child_indexes[0] != 1 ||
      nested_exists_or_plan->modifier_term_bindings[1].term.value != "urn:missing") return 216;
  status = xpod::qlever::bindPlanTerms(physical, snapshot, *nested_exists_or_plan, error);
  if (status != XPOD_RDF_STATUS_OK) return 217;
  if (!nested_exists_or_plan->root.result_modifiers[0]
           .child_modifiers[0].child_modifiers[0].has_term_id_bits ||
      nested_exists_or_plan->root.result_modifiers[0]
           .child_modifiers[0].child_modifiers[0].term_id_bits != 1030) return 218;
  if (!nested_exists_or_plan->root.result_modifiers[0]
           .child_modifiers[1].has_term_id_bits ||
      nested_exists_or_plan->root.result_modifiers[0]
           .child_modifiers[1].term_id_bits != 1160) return 219;
  if (!nested_exists_or_plan->child_plans[0].scan.pattern.has_predicate ||
      nested_exists_or_plan->child_plans[0].scan.pattern.predicate != 40) return 220;

  auto unbound_or_plan = xpod::qlever::planParsedQuery(
      ParsedQuery::filterConstantSubjectOAndExistsOrMissingSubjectSelect());
  if (!unbound_or_plan.has_value()) return 234;
  if (unbound_or_plan->root.result_modifiers.size() != 1) return 235;
  const auto& unbound_or_modifier =
      unbound_or_plan->root.result_modifiers[0];
  if (unbound_or_modifier.kind !=
      xpod::qlever::BridgeResultModifierKind::AnyOf) return 236;
  if (unbound_or_modifier.child_modifiers.size() != 2) return 237;
  if (unbound_or_modifier.child_modifiers[0].kind !=
      xpod::qlever::BridgeResultModifierKind::AllOf) return 238;
  if (unbound_or_modifier.child_modifiers[0].child_modifiers.size() != 2) return 239;
  if (unbound_or_modifier.child_modifiers[0].child_modifiers[0].kind !=
      xpod::qlever::BridgeResultModifierKind::EqualTerm) return 240;
  if (unbound_or_modifier.child_modifiers[0].child_modifiers[1].kind !=
      xpod::qlever::BridgeResultModifierKind::Exists) return 241;
  if (unbound_or_modifier.child_modifiers[1].kind !=
      xpod::qlever::BridgeResultModifierKind::AlwaysFalse) return 242;
  if (unbound_or_plan->child_plans.size() != 1) return 243;
  if (unbound_or_plan->modifier_term_bindings.size() != 1) return 244;
  if (unbound_or_plan->modifier_term_bindings[0].modifier_index != 0 ||
      unbound_or_plan->modifier_term_bindings[0].child_indexes.size() != 2 ||
      unbound_or_plan->modifier_term_bindings[0].child_indexes[0] != 0 ||
      unbound_or_plan->modifier_term_bindings[0].child_indexes[1] != 0 ||
      unbound_or_plan->modifier_term_bindings[0].term.value != "urn:o") return 245;
  status = xpod::qlever::bindPlanTerms(physical, snapshot, *unbound_or_plan, error);
  if (status != XPOD_RDF_STATUS_OK) return 246;
  if (!unbound_or_plan->scan.pattern.has_subject ||
      unbound_or_plan->scan.pattern.subject != 10) return 247;
  if (!unbound_or_plan->scan.pattern.has_predicate ||
      unbound_or_plan->scan.pattern.predicate != 20) return 248;
  if (!unbound_or_plan->root.result_modifiers[0]
           .child_modifiers[0].child_modifiers[0].has_term_id_bits ||
      unbound_or_plan->root.result_modifiers[0]
           .child_modifiers[0].child_modifiers[0].term_id_bits != 1030) return 249;
  if (!unbound_or_plan->child_plans[0].scan.pattern.has_predicate ||
      unbound_or_plan->child_plans[0].scan.pattern.predicate != 40) return 250;

  auto nested_or_plan = xpod::qlever::planParsedQuery(
      ParsedQuery::filterObjectTailAndMissingSubjectOrOSelect());
  if (!nested_or_plan.has_value()) return 149;
  if (nested_or_plan->root.result_modifiers.size() != 2) return 150;
  const auto& nested_or_modifier = nested_or_plan->root.result_modifiers[0];
  if (nested_or_modifier.kind !=
      xpod::qlever::BridgeResultModifierKind::AnyOf) return 151;
  if (nested_or_modifier.child_modifiers.size() != 2) return 152;
  if (nested_or_modifier.child_modifiers[0].kind !=
      xpod::qlever::BridgeResultModifierKind::AllOf) return 153;
  if (nested_or_modifier.child_modifiers[0].child_modifiers.size() != 2) return 154;
  if (nested_or_modifier.child_modifiers[0].child_modifiers[0].kind !=
      xpod::qlever::BridgeResultModifierKind::EqualTerm) return 155;
  if (nested_or_modifier.child_modifiers[0].child_modifiers[1].kind !=
      xpod::qlever::BridgeResultModifierKind::EqualTerm) return 156;
  if (nested_or_modifier.child_modifiers[1].kind !=
      xpod::qlever::BridgeResultModifierKind::EqualTerm) return 157;
  if (nested_or_plan->modifier_term_bindings.size() != 3) return 158;
  if (nested_or_plan->modifier_term_bindings[0].modifier_index != 0 ||
      nested_or_plan->modifier_term_bindings[0].child_indexes.size() != 2 ||
      nested_or_plan->modifier_term_bindings[0].child_indexes[0] != 0 ||
      nested_or_plan->modifier_term_bindings[0].child_indexes[1] != 0 ||
      nested_or_plan->modifier_term_bindings[0].term.value != "urn:tail") return 159;
  if (nested_or_plan->modifier_term_bindings[1].modifier_index != 0 ||
      nested_or_plan->modifier_term_bindings[1].child_indexes.size() != 2 ||
      nested_or_plan->modifier_term_bindings[1].child_indexes[0] != 0 ||
      nested_or_plan->modifier_term_bindings[1].child_indexes[1] != 1 ||
      nested_or_plan->modifier_term_bindings[1].term.value != "urn:literal-s") return 160;
  if (nested_or_plan->modifier_term_bindings[2].modifier_index != 0 ||
      nested_or_plan->modifier_term_bindings[2].child_indexes.size() != 1 ||
      nested_or_plan->modifier_term_bindings[2].child_indexes[0] != 1 ||
      nested_or_plan->modifier_term_bindings[2].term.value != "urn:o") return 161;
  status = xpod::qlever::bindPlanTerms(physical, snapshot, *nested_or_plan, error);
  if (status != XPOD_RDF_STATUS_OK) return 162;
  if (!nested_or_plan->root.result_modifiers[0]
           .child_modifiers[0].child_modifiers[0].has_term_id_bits ||
      nested_or_plan->root.result_modifiers[0]
           .child_modifiers[0].child_modifiers[0].term_id_bits != 1070) return 163;
  if (!nested_or_plan->root.result_modifiers[0]
           .child_modifiers[0].child_modifiers[1].has_term_id_bits ||
      nested_or_plan->root.result_modifiers[0]
           .child_modifiers[0].child_modifiers[1].term_id_bits != 1015) return 164;
  if (!nested_or_plan->root.result_modifiers[0]
           .child_modifiers[1].has_term_id_bits ||
      nested_or_plan->root.result_modifiers[0]
           .child_modifiers[1].term_id_bits != 1030) return 165;

  auto not_plan = xpod::qlever::planParsedQuery(
      ParsedQuery::filterNotObjectEqualsTailSelect());
  if (!not_plan.has_value()) return 166;
  if (not_plan->root.result_modifiers.size() != 2) return 167;
  const auto& not_modifier = not_plan->root.result_modifiers[0];
  if (not_modifier.kind != xpod::qlever::BridgeResultModifierKind::Not) return 168;
  if (not_modifier.child_modifiers.size() != 1) return 169;
  if (not_modifier.child_modifiers[0].kind !=
      xpod::qlever::BridgeResultModifierKind::EqualTerm) return 170;
  if (not_modifier.child_modifiers[0].columns.size() != 1 ||
      not_modifier.child_modifiers[0].columns[0] != 2) return 171;
  if (not_plan->modifier_term_bindings.size() != 1) return 172;
  if (not_plan->modifier_term_bindings[0].modifier_index != 0 ||
      not_plan->modifier_term_bindings[0].child_indexes.size() != 1 ||
      not_plan->modifier_term_bindings[0].child_indexes[0] != 0 ||
      not_plan->modifier_term_bindings[0].term.value != "urn:tail") return 173;
  status = xpod::qlever::bindPlanTerms(physical, snapshot, *not_plan, error);
  if (status != XPOD_RDF_STATUS_OK) return 174;
  if (!not_plan->root.result_modifiers[0]
           .child_modifiers[0].has_term_id_bits ||
      not_plan->root.result_modifiers[0]
           .child_modifiers[0].term_id_bits != 1070) return 175;

  auto literal_plan = xpod::qlever::planParsedQuery(ParsedQuery::filterObjectEqualsLiteralSelect());
  if (!literal_plan.has_value()) return 21;
  if (literal_plan->root.result_modifiers.size() != 1 ||
      literal_plan->root.result_modifiers[0].kind !=
          xpod::qlever::BridgeResultModifierKind::Project) return 22;
  if (!literal_plan->modifier_term_bindings.empty() ||
      literal_plan->term_bindings.size() != 1) return 25;
  if (literal_plan->term_bindings[0].slot != XPOD_RDF_SLOT_OBJECT ||
      literal_plan->term_bindings[0].kind != XPOD_RDF_TERM_LITERAL) return 26;
  if (literal_plan->term_bindings[0].value != "literal-value") return 27;
  status = xpod::qlever::bindPlanTerms(physical, snapshot, *literal_plan, error);
  if (status != XPOD_RDF_STATUS_OK) return 28;
  if (!literal_plan->scan.pattern.has_object ||
      literal_plan->scan.pattern.object != 80) return 30;

  auto literal_left_plan = xpod::qlever::planParsedQuery(ParsedQuery::filterLiteralEqualsObjectSelect());
  if (!literal_left_plan.has_value()) return 31;
  if (literal_left_plan->root.result_modifiers.size() != 1 ||
      literal_left_plan->root.result_modifiers[0].kind !=
          xpod::qlever::BridgeResultModifierKind::Project) return 32;
  if (!literal_left_plan->modifier_term_bindings.empty() ||
      literal_left_plan->term_bindings.size() != 1) return 35;
  if (literal_left_plan->term_bindings[0].slot != XPOD_RDF_SLOT_OBJECT ||
      literal_left_plan->term_bindings[0].kind != XPOD_RDF_TERM_LITERAL) return 36;
  if (literal_left_plan->term_bindings[0].value != "literal-value") return 37;
  status = xpod::qlever::bindPlanTerms(physical, snapshot, *literal_left_plan, error);
  if (status != XPOD_RDF_STATUS_OK) return 38;
  if (!literal_left_plan->scan.pattern.has_object ||
      literal_left_plan->scan.pattern.object != 80) return 40;

  auto filtered_projection_plan =
      xpod::qlever::planParsedQuery(ParsedQuery::filterObjectEqualsOSelectSubjectOnly());
  if (!filtered_projection_plan.has_value()) return 41;
  if (filtered_projection_plan->output_variables.size() != 1 ||
      filtered_projection_plan->output_variables[0] != "s") return 42;
  if (filtered_projection_plan->root.result_modifiers.size() != 1) return 43;
  if (filtered_projection_plan->root.result_modifiers[0].kind !=
      xpod::qlever::BridgeResultModifierKind::Project) return 45;
  if (filtered_projection_plan->root.result_modifiers[0].columns.size() != 1 ||
      filtered_projection_plan->root.result_modifiers[0].columns[0] != 0) return 47;
  status = xpod::qlever::bindPlanTerms(physical, snapshot, *filtered_projection_plan, error);
  if (status != XPOD_RDF_STATUS_OK) return 48;
  if (!filtered_projection_plan->scan.pattern.has_object ||
      filtered_projection_plan->scan.pattern.object != 30) return 50;

  auto string_filter_plan =
      xpod::qlever::planParsedQuery(ParsedQuery::filterSubjectStrstartsSelectObjectOnly());
  if (!string_filter_plan.has_value()) return 251;
  if (string_filter_plan->output_variables.size() != 1 ||
      string_filter_plan->output_variables[0] != "o") return 252;
  if (string_filter_plan->root.result_modifiers.size() != 2) return 253;
  const auto& string_filter_modifier =
      string_filter_plan->root.result_modifiers[0];
  if (string_filter_modifier.kind !=
      xpod::qlever::BridgeResultModifierKind::StringPredicate) return 254;
  if (string_filter_modifier.columns.size() != 1 ||
      string_filter_modifier.columns[0] != 0) return 255;
  if (string_filter_modifier.string_filter !=
      xpod::qlever::BridgeStringFilterKind::Prefix) return 256;
  if (string_filter_modifier.string_value != "urn:s") return 257;
  if (string_filter_plan->scan.filters.size() != 1 ||
      string_filter_plan->scan.filters[0].slot != XPOD_RDF_SLOT_SUBJECT ||
      string_filter_plan->scan.filters[0].kind !=
          XPOD_RDF_SCAN_FILTER_STRING_PREFIX) return 2571;
  xpod_rdf_scan_request string_filter_request =
      xpod::qlever::makeScanRequest(string_filter_plan->scan);
  if (std::string_view(
          string_filter_request.filters[0].value.data,
          string_filter_request.filters[0].value.size) != "urn:s") return 2572;
  if (string_filter_plan->root.result_modifiers[1].kind !=
      xpod::qlever::BridgeResultModifierKind::Project) return 258;
  if (string_filter_plan->root.result_modifiers[1].columns.size() != 1 ||
      string_filter_plan->root.result_modifiers[1].columns[0] != 2) return 259;
  if (!string_filter_plan->modifier_term_bindings.empty()) return 260;

  auto contains_filter_plan =
      xpod::qlever::planParsedQuery(ParsedQuery::filterSubjectContainsSelectObjectOnly());
  if (!contains_filter_plan.has_value()) return 261;
  if (contains_filter_plan->root.result_modifiers.size() != 2) return 262;
  const auto& contains_filter_modifier =
      contains_filter_plan->root.result_modifiers[0];
  if (contains_filter_modifier.kind !=
      xpod::qlever::BridgeResultModifierKind::StringPredicate) return 263;
  if (contains_filter_modifier.columns.size() != 1 ||
      contains_filter_modifier.columns[0] != 0) return 264;
  if (contains_filter_modifier.string_filter !=
      xpod::qlever::BridgeStringFilterKind::Contains) return 265;
  if (contains_filter_modifier.string_value != "literal") return 266;
  if (contains_filter_plan->scan.filters.size() != 1 ||
      contains_filter_plan->scan.filters[0].kind !=
          XPOD_RDF_SCAN_FILTER_STRING_CONTAINS) return 2661;
  if (contains_filter_plan->physical_filter_fallback.has_value()) return 2662;
  if (contains_filter_plan->root.result_modifiers[1].kind !=
      xpod::qlever::BridgeResultModifierKind::Project) return 267;
  if (contains_filter_plan->root.result_modifiers[1].columns.size() != 1 ||
      contains_filter_plan->root.result_modifiers[1].columns[0] != 2) return 268;
  if (!contains_filter_plan->modifier_term_bindings.empty()) return 269;

  ParsedQuery raw_contains_query =
      ParsedQuery::filterSubjectContainsSelectObjectOnly();
  raw_contains_query._rootGraphPattern._filters[0].expression_ =
      sparqlExpression::SparqlExpressionPimpl{
          "CONTAINS(?s, \\"literal\\")"};
  auto raw_contains_filter_plan =
      xpod::qlever::planParsedQuery(raw_contains_query);
  if (!raw_contains_filter_plan.has_value()) return 2681;
  if (raw_contains_filter_plan->root.result_modifiers.size() != 2) return 2682;
  const auto& raw_contains_filter_modifier =
      raw_contains_filter_plan->root.result_modifiers[0];
  if (raw_contains_filter_modifier.kind !=
      xpod::qlever::BridgeResultModifierKind::StringPredicate) return 2683;
  if (raw_contains_filter_modifier.columns.size() != 1 ||
      raw_contains_filter_modifier.columns[0] != 0) return 2684;
  if (raw_contains_filter_modifier.string_filter !=
      xpod::qlever::BridgeStringFilterKind::Contains) return 2685;
  if (raw_contains_filter_modifier.string_transform !=
      xpod::qlever::BridgeStringValueTransform::None) return 2686;
  if (raw_contains_filter_modifier.string_value != "literal") return 2687;
  if (raw_contains_filter_plan->scan.filters.size() != 1 ||
      raw_contains_filter_plan->scan.filters[0].slot != XPOD_RDF_SLOT_SUBJECT ||
      raw_contains_filter_plan->scan.filters[0].kind !=
          XPOD_RDF_SCAN_FILTER_STRING_CONTAINS) return 2688;
  if (raw_contains_filter_plan->physical_filter_fallback.has_value()) return 2689;

  auto language_filter_plan = xpod::qlever::planParsedQuery(
      ParsedQuery::filterObjectLanguageEnglishSelectSubjectOnly());
  if (!language_filter_plan.has_value()) return 2691;
  if (language_filter_plan->root.result_modifiers.size() != 2 ||
      language_filter_plan->root.result_modifiers[0].kind !=
          xpod::qlever::BridgeResultModifierKind::LanguageEqual ||
      language_filter_plan->root.result_modifiers[0].string_value != "en")
    return 2692;
  if (language_filter_plan->scan.filters.size() != 1 ||
      language_filter_plan->scan.filters[0].slot != XPOD_RDF_SLOT_OBJECT ||
      language_filter_plan->scan.filters[0].kind !=
          XPOD_RDF_SCAN_FILTER_LANGUAGE_EQUAL) return 2693;
  if (language_filter_plan->physical_filter_fallback.has_value()) return 26931;

  auto datatype_filter_plan = xpod::qlever::planParsedQuery(
      ParsedQuery::filterObjectDatatypeStringSelectSubjectOnly());
  if (!datatype_filter_plan.has_value()) return 2694;
  if (datatype_filter_plan->root.result_modifiers.size() != 2 ||
      datatype_filter_plan->root.result_modifiers[0].kind !=
          xpod::qlever::BridgeResultModifierKind::DatatypeEqual ||
      datatype_filter_plan->root.result_modifiers[0].string_value !=
          "http://www.w3.org/2001/XMLSchema#string") return 2695;
  if (datatype_filter_plan->scan.filters.size() != 1 ||
      datatype_filter_plan->scan.filters[0].kind !=
          XPOD_RDF_SCAN_FILTER_DATATYPE_EQUAL) return 2696;
  if (datatype_filter_plan->physical_filter_fallback.has_value()) return 26961;

  auto integer_datatype_filter_plan = xpod::qlever::planParsedQuery(
      ParsedQuery::filterObjectDatatypeIntegerSelectSubjectOnly());
  if (!integer_datatype_filter_plan.has_value()) return 26962;
  if (integer_datatype_filter_plan->root.result_modifiers[0].string_value !=
      "http://www.w3.org/2001/XMLSchema#integer") return 26963;
  if (integer_datatype_filter_plan->scan.filter_values.size() != 1 ||
      !integer_datatype_filter_plan->scan.filter_values[0].has_value() ||
      *integer_datatype_filter_plan->scan.filter_values[0] !=
          "http://www.w3.org/2001/XMLSchema#int") return 26964;

  auto strends_filter_plan =
      xpod::qlever::planParsedQuery(ParsedQuery::filterSubjectStrendsSelectObjectOnly());
  if (!strends_filter_plan.has_value()) return 270;
  if (strends_filter_plan->root.result_modifiers.size() != 2) return 271;
  const auto& strends_filter_modifier =
      strends_filter_plan->root.result_modifiers[0];
  if (strends_filter_modifier.kind !=
      xpod::qlever::BridgeResultModifierKind::StringPredicate) return 272;
  if (strends_filter_modifier.columns.size() != 1 ||
      strends_filter_modifier.columns[0] != 0) return 273;
  if (strends_filter_modifier.string_filter !=
      xpod::qlever::BridgeStringFilterKind::Suffix) return 274;
  if (strends_filter_modifier.string_value != "literal-s") return 275;
  if (strends_filter_plan->scan.filters.size() != 1 ||
      strends_filter_plan->scan.filters[0].kind !=
          XPOD_RDF_SCAN_FILTER_STRING_SUFFIX) return 2751;
  if (strends_filter_plan->root.result_modifiers[1].kind !=
      xpod::qlever::BridgeResultModifierKind::Project) return 276;
  if (strends_filter_plan->root.result_modifiers[1].columns.size() != 1 ||
      strends_filter_plan->root.result_modifiers[1].columns[0] != 2) return 277;
  if (!strends_filter_plan->modifier_term_bindings.empty()) return 278;

  auto lcase_filter_plan =
      xpod::qlever::planParsedQuery(ParsedQuery::filterSubjectLcaseEqualsSelectObjectOnly());
  if (!lcase_filter_plan.has_value()) return 279;
  if (lcase_filter_plan->root.result_modifiers.size() != 2) return 280;
  const auto& lcase_filter_modifier =
      lcase_filter_plan->root.result_modifiers[0];
  if (lcase_filter_modifier.kind !=
      xpod::qlever::BridgeResultModifierKind::StringPredicate) return 281;
  if (lcase_filter_modifier.columns.size() != 1 ||
      lcase_filter_modifier.columns[0] != 0) return 282;
  if (lcase_filter_modifier.string_filter !=
      xpod::qlever::BridgeStringFilterKind::Equals) return 283;
  if (lcase_filter_modifier.string_transform !=
      xpod::qlever::BridgeStringValueTransform::Lowercase) return 284;
  if (lcase_filter_modifier.string_value != "urn:s") return 285;
  if (!lcase_filter_plan->scan.filters.empty()) return 2851;
  if (!lcase_filter_plan->physical_filter_fallback.has_value()) return 2852;
  if (lcase_filter_plan->physical_filter_fallback->reason !=
      "string-transform-lowercase-unsupported") return 2853;
  if (lcase_filter_plan->physical_filter_fallback->expression.find("LCASE") ==
      std::string::npos) return 2854;
  if (lcase_filter_plan->root.result_modifiers[1].kind !=
      xpod::qlever::BridgeResultModifierKind::Project) return 286;
  if (lcase_filter_plan->root.result_modifiers[1].columns.size() != 1 ||
      lcase_filter_plan->root.result_modifiers[1].columns[0] != 2) return 287;
  if (!lcase_filter_plan->modifier_term_bindings.empty()) return 288;

  auto lcase_not_filter_plan =
      xpod::qlever::planParsedQuery(ParsedQuery::filterSubjectLcaseNotEqualsLiteralSelectObjectOnly());
  if (!lcase_not_filter_plan.has_value()) return 309;
  if (lcase_not_filter_plan->root.result_modifiers.size() != 2) return 310;
  const auto& lcase_not_filter_modifier =
      lcase_not_filter_plan->root.result_modifiers[0];
  if (lcase_not_filter_modifier.kind !=
      xpod::qlever::BridgeResultModifierKind::StringPredicate) return 311;
  if (lcase_not_filter_modifier.columns.size() != 1 ||
      lcase_not_filter_modifier.columns[0] != 0) return 312;
  if (lcase_not_filter_modifier.string_filter !=
      xpod::qlever::BridgeStringFilterKind::Equals) return 313;
  if (lcase_not_filter_modifier.string_transform !=
      xpod::qlever::BridgeStringValueTransform::Lowercase) return 314;
  if (!lcase_not_filter_modifier.string_negated) return 315;
  if (lcase_not_filter_modifier.string_value != "urn:literal-s") return 316;
  if (!lcase_not_filter_plan->physical_filter_fallback.has_value()) return 3161;
  if (lcase_not_filter_plan->physical_filter_fallback->reason !=
      "string-transform-lowercase-unsupported") return 3162;
  if (lcase_not_filter_plan->physical_filter_fallback->expression.find("LCASE") ==
      std::string::npos) return 3163;
  if (lcase_not_filter_plan->root.result_modifiers[1].kind !=
      xpod::qlever::BridgeResultModifierKind::Project) return 317;
  if (lcase_not_filter_plan->root.result_modifiers[1].columns.size() != 1 ||
      lcase_not_filter_plan->root.result_modifiers[1].columns[0] != 2) return 318;
  if (!lcase_not_filter_plan->modifier_term_bindings.empty()) return 319;

  auto ucase_filter_plan =
      xpod::qlever::planParsedQuery(ParsedQuery::filterSubjectUcaseEqualsSelectObjectOnly());
  if (!ucase_filter_plan.has_value()) return 289;
  if (ucase_filter_plan->root.result_modifiers.size() != 2) return 290;
  const auto& ucase_filter_modifier =
      ucase_filter_plan->root.result_modifiers[0];
  if (ucase_filter_modifier.kind !=
      xpod::qlever::BridgeResultModifierKind::StringPredicate) return 291;
  if (ucase_filter_modifier.columns.size() != 1 ||
      ucase_filter_modifier.columns[0] != 0) return 292;
  if (ucase_filter_modifier.string_filter !=
      xpod::qlever::BridgeStringFilterKind::Equals) return 293;
  if (ucase_filter_modifier.string_transform !=
      xpod::qlever::BridgeStringValueTransform::Uppercase) return 294;
  if (ucase_filter_modifier.string_value != "URN:S") return 295;
  if (!ucase_filter_plan->physical_filter_fallback.has_value()) return 2951;
  if (ucase_filter_plan->physical_filter_fallback->reason !=
      "string-transform-uppercase-unsupported") return 2952;
  if (ucase_filter_plan->physical_filter_fallback->expression.find("UCASE") ==
      std::string::npos) return 2953;
  if (ucase_filter_plan->root.result_modifiers[1].kind !=
      xpod::qlever::BridgeResultModifierKind::Project) return 296;
  if (ucase_filter_plan->root.result_modifiers[1].columns.size() != 1 ||
      ucase_filter_plan->root.result_modifiers[1].columns[0] != 2) return 297;
  if (!ucase_filter_plan->modifier_term_bindings.empty()) return 298;

  auto numeric_filter_plan =
      xpod::qlever::planParsedQuery(ParsedQuery::filterObjectGreaterThanIntegerSelect());
  if (!numeric_filter_plan.has_value()) return 320;
  backend_feature_mask = XPOD_RDF_BACKEND_FEATURE_SCAN_FILTER;
  if (xpod::qlever::canUsePhysicalFilterBridge(physical, *numeric_filter_plan)) return 321;
  if (!xpod::qlever::canUsePhysicalFilterBridge(physical, *string_filter_plan)) return 322;
  if (!xpod::qlever::canUsePhysicalFilterBridge(physical, *contains_filter_plan)) return 323;
  if (!xpod::qlever::canUsePhysicalFilterBridge(physical, *language_filter_plan)) return 324;
  if (!xpod::qlever::canUsePhysicalFilterBridge(physical, *datatype_filter_plan)) return 325;
  if (xpod::qlever::canUsePhysicalFilterBridge(physical, *lcase_filter_plan)) return 326;
  if (xpod::qlever::canUsePhysicalFilterBridge(physical, *ucase_filter_plan)) return 327;
  backend_feature_mask =
      XPOD_RDF_BACKEND_FEATURE_SCAN_FILTER |
      XPOD_RDF_BACKEND_FEATURE_SCAN_VALUE_RANGE;
  if (!xpod::qlever::canUsePhysicalFilterBridge(physical, *numeric_filter_plan)) return 328;
  backend_feature_mask = 0;
  if (xpod::qlever::canUsePhysicalFilterBridge(physical, *string_filter_plan)) return 329;
  backend_feature_mask = XPOD_RDF_BACKEND_FEATURE_SCAN_FILTER;

  auto regex_prefix_filter_plan =
      xpod::qlever::planParsedQuery(ParsedQuery::filterSubjectRegexPrefixSelectObjectOnly());
  if (!regex_prefix_filter_plan.has_value()) return 299;
  if (regex_prefix_filter_plan->root.result_modifiers.size() != 2) return 300;
  const auto& regex_prefix_filter_modifier =
      regex_prefix_filter_plan->root.result_modifiers[0];
  if (regex_prefix_filter_modifier.kind !=
      xpod::qlever::BridgeResultModifierKind::StringPredicate) return 301;
  if (regex_prefix_filter_modifier.columns.size() != 1 ||
      regex_prefix_filter_modifier.columns[0] != 0) return 302;
  if (regex_prefix_filter_modifier.string_filter !=
      xpod::qlever::BridgeStringFilterKind::Prefix) return 303;
  if (regex_prefix_filter_modifier.string_transform !=
      xpod::qlever::BridgeStringValueTransform::None) return 304;
  if (regex_prefix_filter_modifier.string_value != "urn:literal") return 305;
  if (regex_prefix_filter_plan->physical_filter_fallback.has_value()) return 3051;
  if (regex_prefix_filter_plan->root.result_modifiers[1].kind !=
      xpod::qlever::BridgeResultModifierKind::Project) return 306;
  if (regex_prefix_filter_plan->root.result_modifiers[1].columns.size() != 1 ||
      regex_prefix_filter_plan->root.result_modifiers[1].columns[0] != 2) return 307;
  if (!regex_prefix_filter_plan->modifier_term_bindings.empty()) return 308;

  ParsedQuery lcase_regex_prefix_query =
      ParsedQuery::filterSubjectRegexPrefixSelectObjectOnly();
  lcase_regex_prefix_query._rootGraphPattern._filters[0].expression_ =
      sparqlExpression::SparqlExpressionPimpl{
          "REGEX(LCASE(STR(?s)), \\"^urn:literal\\")"};
  auto lcase_regex_prefix_filter_plan =
      xpod::qlever::planParsedQuery(lcase_regex_prefix_query);
  if (!lcase_regex_prefix_filter_plan.has_value()) return 330;
  if (lcase_regex_prefix_filter_plan->root.result_modifiers.size() != 2) return 331;
  const auto& lcase_regex_prefix_filter_modifier =
      lcase_regex_prefix_filter_plan->root.result_modifiers[0];
  if (lcase_regex_prefix_filter_modifier.kind !=
      xpod::qlever::BridgeResultModifierKind::StringPredicate) return 332;
  if (lcase_regex_prefix_filter_modifier.columns.size() != 1 ||
      lcase_regex_prefix_filter_modifier.columns[0] != 0) return 333;
  if (lcase_regex_prefix_filter_modifier.string_filter !=
      xpod::qlever::BridgeStringFilterKind::Prefix) return 334;
  if (lcase_regex_prefix_filter_modifier.string_transform !=
      xpod::qlever::BridgeStringValueTransform::Lowercase) return 335;
  if (lcase_regex_prefix_filter_modifier.string_value != "urn:literal") return 336;
  if (!lcase_regex_prefix_filter_plan->scan.filters.empty()) return 337;
  if (!lcase_regex_prefix_filter_plan->physical_filter_fallback.has_value()) return 338;
  if (lcase_regex_prefix_filter_plan->physical_filter_fallback->reason !=
      "string-transform-lowercase-unsupported") return 339;
  if (lcase_regex_prefix_filter_plan->physical_filter_fallback->expression !=
      "REGEX(LCASE(STR(?s)), \\"^urn:literal\\")") return 340;

  ParsedQuery ucase_regex_prefix_query =
      ParsedQuery::filterSubjectRegexPrefixSelectObjectOnly();
  ucase_regex_prefix_query._rootGraphPattern._filters[0].expression_ =
      sparqlExpression::SparqlExpressionPimpl{
          "REGEX(UCASE(STR(?s)), \\"^URN:LITERAL\\")"};
  auto ucase_regex_prefix_filter_plan =
      xpod::qlever::planParsedQuery(ucase_regex_prefix_query);
  if (!ucase_regex_prefix_filter_plan.has_value()) return 341;
  if (ucase_regex_prefix_filter_plan->root.result_modifiers.size() != 2) return 342;
  const auto& ucase_regex_prefix_filter_modifier =
      ucase_regex_prefix_filter_plan->root.result_modifiers[0];
  if (ucase_regex_prefix_filter_modifier.kind !=
      xpod::qlever::BridgeResultModifierKind::StringPredicate) return 343;
  if (ucase_regex_prefix_filter_modifier.columns.size() != 1 ||
      ucase_regex_prefix_filter_modifier.columns[0] != 0) return 344;
  if (ucase_regex_prefix_filter_modifier.string_filter !=
      xpod::qlever::BridgeStringFilterKind::Prefix) return 345;
  if (ucase_regex_prefix_filter_modifier.string_transform !=
      xpod::qlever::BridgeStringValueTransform::Uppercase) return 346;
  if (ucase_regex_prefix_filter_modifier.string_value != "URN:LITERAL") return 347;
  if (!ucase_regex_prefix_filter_plan->scan.filters.empty()) return 348;
  if (!ucase_regex_prefix_filter_plan->physical_filter_fallback.has_value()) return 349;
  if (ucase_regex_prefix_filter_plan->physical_filter_fallback->reason !=
      "string-transform-uppercase-unsupported") return 350;
  if (ucase_regex_prefix_filter_plan->physical_filter_fallback->expression !=
      "REGEX(UCASE(STR(?s)), \\"^URN:LITERAL\\")") return 351;

  if (xpod::qlever::planParsedQuery(ParsedQuery::unsupportedFilterSelect()).has_value()) return 51;
  return 0;
}
`, 'utf8');

      execFileSync('c++', [
        '-std=c++17',
        '-Wall',
        '-Wextra',
        '-Werror',
        '-DXPOD_QLEVER_ADAPTER_ENABLE_QLEVER=1',
        '-I', path.dirname(planHeader),
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
  });

  nativeIt('plans parsed cross-slot two-triple joins with right-side projections', async () => {
    expect(hasCxx(), 'c++ compiler is required for native cross-slot plan bridge check').toBe(true);

    const root = await mkdtemp(path.join(os.tmpdir(), 'xpod-qlever-plan-cross-slot-join-'));
    try {
      const qleverSource = path.join(root, 'qlever');
      await mkdir(path.join(qleverSource, 'src/parser'), { recursive: true });
      await mkdir(path.join(qleverSource, 'src/index'), { recursive: true });
      await mkdir(path.join(qleverSource, 'src/global'), { recursive: true });
      await writeFile(path.join(qleverSource, 'src/parser/ParsedQuery.h'), fakeParsedQueryHeader, 'utf8');
      await writeFile(path.join(qleverSource, 'src/parser/SparqlTriple.h'), fakeSparqlTripleHeader, 'utf8');
      await writeFile(path.join(qleverSource, 'src/global/Id.h'), '#pragma once\n#include <cstdint>\nusing ColumnIndex = uint64_t;\nclass Id { public: static Id fromBits(uint64_t bits) { return Id(bits); } uint64_t getBits() const { return bits_; } private: explicit Id(uint64_t bits) : bits_(bits) {} uint64_t bits_; };\n', 'utf8');
      await writeFile(path.join(qleverSource, 'src/index/Permutation.h'), `
#pragma once
class Permutation {
 public:
  enum struct Enum { PSO, POS, SPO, SOP, OPS, OSP };
};
`, 'utf8');

      const smoke = path.join(root, 'plan_bridge_cross_slot_join_smoke.cpp');
      const binary = path.join(root, 'plan_bridge_cross_slot_join_smoke');
      await writeFile(smoke, `
#include "XpodQleverPlanBridge.hpp"

int main() {
  ParsedQuery parsed = ParsedQuery::objectSubjectJoinSelect();
  auto plan = xpod::qlever::planParsedQuery(parsed);
  if (!plan.has_value()) return 1;
  if (plan->root.kind != xpod::qlever::BridgeOperationKind::HashJoin) return 2;
  if (plan->filter_scans.size() != 1) return 3;
  if (plan->root.join_slots.size() != 2) return 4;
  if (plan->root.join_slots[0] != XPOD_RDF_SLOT_OBJECT) return 5;
  if (plan->root.join_slots[1] != XPOD_RDF_SLOT_SUBJECT) return 6;
  if (plan->root.join_key_slots.size() != 2) return 7;
  if (plan->root.join_key_slots[0].size() != 1 ||
      plan->root.join_key_slots[0][0] != XPOD_RDF_SLOT_OBJECT) return 8;
  if (plan->root.join_key_slots[1].size() != 1 ||
      plan->root.join_key_slots[1][0] != XPOD_RDF_SLOT_SUBJECT) return 9;
  if (plan->root.scan_project_slots.size() != 2) return 10;
  if (plan->root.scan_project_slots[0].size() != 1) return 11;
  if (plan->root.scan_project_slots[1].size() != 1) return 12;
  if (plan->root.scan_project_slots[0][0] != XPOD_RDF_SLOT_SUBJECT) return 13;
  if (plan->root.scan_project_slots[1][0] != XPOD_RDF_SLOT_OBJECT) return 14;
  if (plan->output_variables.size() != 2) return 15;
  if (plan->output_variables[0] != "s") return 16;
  if (plan->output_variables[1] != "tail") return 17;
  if (plan->result_width != 2) return 18;
  return 0;
}
`, 'utf8');

      execFileSync('c++', [
        '-std=c++17',
        '-Wall',
        '-Wextra',
        '-Werror',
        '-DXPOD_QLEVER_ADAPTER_ENABLE_QLEVER=1',
        '-I', path.dirname(planHeader),
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
  });

  nativeIt('plans a two-triple BGP as a primary scan plus subject filter scan', async () => {
    expect(hasCxx(), 'c++ compiler is required for native plan bridge check').toBe(true);

    const root = await mkdtemp(path.join(os.tmpdir(), 'xpod-qlever-plan-join-'));
    try {
      const qleverSource = path.join(root, 'qlever');
      await mkdir(path.join(qleverSource, 'src/parser'), { recursive: true });
      await mkdir(path.join(qleverSource, 'src/index'), { recursive: true });
      await mkdir(path.join(qleverSource, 'src/global'), { recursive: true });
      await writeFile(path.join(qleverSource, 'src/parser/ParsedQuery.h'), fakeParsedQueryHeader, 'utf8');
      await writeFile(path.join(qleverSource, 'src/parser/SparqlTriple.h'), fakeSparqlTripleHeader, 'utf8');
      await writeFile(path.join(qleverSource, 'src/global/Id.h'), '#pragma once\n#include <cstdint>\nusing ColumnIndex = uint64_t;\nclass Id { public: static Id fromBits(uint64_t bits) { return Id(bits); } uint64_t getBits() const { return bits_; } private: explicit Id(uint64_t bits) : bits_(bits) {} uint64_t bits_; };\n', 'utf8');
      await writeFile(path.join(qleverSource, 'src/index/Permutation.h'), `
#pragma once
class Permutation {
 public:
  enum struct Enum { PSO, POS, SPO, SOP, OPS, OSP };
};
`, 'utf8');

      const smoke = path.join(root, 'plan_bridge_join_smoke.cpp');
      const binary = path.join(root, 'plan_bridge_join_smoke');
      await writeFile(smoke, `
#include "XpodQleverPlanBridge.hpp"

int main() {
  ParsedQuery parsed = ParsedQuery::subjectFilterSelect();
  auto plan = xpod::qlever::planParsedQuery(parsed);
  if (!plan.has_value()) return 1;
  if (plan->filter_scans.size() != 1) return 2;
  if (plan->term_bindings.size() != 0) return 3;
  const auto& filter = plan->filter_scans[0];
  if (filter.join_slot != XPOD_RDF_SLOT_SUBJECT) return 4;
  if (filter.term_bindings.size() != 2) return 5;
  if (filter.term_bindings[0].slot != XPOD_RDF_SLOT_PREDICATE) return 6;
  if (filter.term_bindings[0].value != "urn:type") return 7;
  if (filter.term_bindings[1].slot != XPOD_RDF_SLOT_OBJECT) return 8;
  if (filter.term_bindings[1].value != "urn:Thing") return 9;
  if (filter.scan.permutation != Permutation::Enum::POS) return 10;
  return 0;
}
`, 'utf8');

      execFileSync('c++', [
        '-std=c++17',
        '-Wall',
        '-Wextra',
        '-Werror',
        '-DXPOD_QLEVER_ADAPTER_ENABLE_QLEVER=1',
        '-I', path.dirname(planHeader),
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
  });


  nativeIt('restores QLever postprocessed LANG predicates into base predicate scans with language filters', async () => {
    expect(hasCxx(), 'c++ compiler is required for native language plan bridge check').toBe(true);

    const root = await mkdtemp(path.join(os.tmpdir(), 'xpod-qlever-plan-lang-postprocessed-'));
    try {
      const qleverSource = path.join(root, 'qlever');
      await mkdir(path.join(qleverSource, 'src/parser'), { recursive: true });
      await mkdir(path.join(qleverSource, 'src/index'), { recursive: true });
      await mkdir(path.join(qleverSource, 'src/global'), { recursive: true });
      await writeFile(path.join(qleverSource, 'src/parser/ParsedQuery.h'), fakeParsedQueryHeader, 'utf8');
      await writeFile(path.join(qleverSource, 'src/parser/SparqlTriple.h'), fakeSparqlTripleHeader, 'utf8');
      await writeFile(path.join(qleverSource, 'src/global/Id.h'), '#pragma once\n#include <cstdint>\nusing ColumnIndex = uint64_t;\nclass Id { public: static Id fromBits(uint64_t bits) { return Id(bits); } uint64_t getBits() const { return bits_; } private: explicit Id(uint64_t bits) : bits_(bits) {} uint64_t bits_; };\n', 'utf8');
      await writeFile(path.join(qleverSource, 'src/index/Permutation.h'), `
#pragma once
class Permutation {
 public:
  enum struct Enum { PSO, POS, SPO, SOP, OPS, OSP };
};
`, 'utf8');

      const smoke = path.join(root, 'plan_bridge_lang_postprocessed_smoke.cpp');
      const binary = path.join(root, 'plan_bridge_lang_postprocessed_smoke');
      await writeFile(smoke, `
#include <string_view>
#include "XpodQleverPlanBridge.hpp"

static xpod_rdf_status lookup_terms(
    void*,
    const xpod_rdf_term* terms,
    size_t term_count,
    const xpod_rdf_snapshot*,
    xpod_rdf_term_key* out_keys,
    xpod_rdf_status* out_statuses) {
  for (size_t index = 0; index < term_count; ++index) {
    if (terms[index].kind != XPOD_RDF_TERM_IRI) return XPOD_RDF_STATUS_BACKEND_ERROR;
    const std::string_view value(terms[index].value.data, terms[index].value.size);
    if (value == "urn:p0-filter/label") {
      out_keys[index] = 91;
    } else if (value == xpod::qlever::QleverDefaultGraphIri) {
      out_keys[index] = 1;
    } else {
      return XPOD_RDF_STATUS_BACKEND_ERROR;
    }
    out_statuses[index] = XPOD_RDF_STATUS_OK;
  }
  return XPOD_RDF_STATUS_OK;
}

static xpod_rdf_status encode_qlever_id(void*, xpod_rdf_term_key term, uint64_t* out_bits) {
  *out_bits = term + 1000;
  return XPOD_RDF_STATUS_OK;
}

static xpod_rdf_status get_capabilities(
    void*, xpod_rdf_backend_capabilities* out) {
  *out = {};
  out->features = XPOD_RDF_BACKEND_FEATURE_SCAN_FILTER;
  return XPOD_RDF_STATUS_OK;
}

int main() {
  auto plan = xpod::qlever::planParsedQuery(
      ParsedQuery::postprocessedLanguagePredicateSelectSubjectOnly());
  if (!plan.has_value()) return 1;
  if (plan->term_bindings.size() != 1) return 2;
  if (plan->term_bindings[0].slot != XPOD_RDF_SLOT_PREDICATE) return 3;
  if (plan->term_bindings[0].kind != XPOD_RDF_TERM_IRI) return 4;
  if (plan->term_bindings[0].value != "urn:p0-filter/label") return 5;
  if (plan->scan.filters.size() != 1) return 6;
  if (plan->scan.filters[0].slot != XPOD_RDF_SLOT_OBJECT) return 7;
  if (plan->scan.filters[0].kind != XPOD_RDF_SCAN_FILTER_LANGUAGE_EQUAL) return 8;
  xpod_rdf_scan_request request = xpod::qlever::makeScanRequest(plan->scan);
  if (request.filter_count != 1) return 9;
  if (std::string_view(request.filters[0].value.data, request.filters[0].value.size) !=
      "en") return 10;
  if (plan->root.result_modifiers.empty()) return 11;
  if (plan->root.result_modifiers[0].kind !=
      xpod::qlever::BridgeResultModifierKind::LanguageEqual) return 12;
  if (plan->root.result_modifiers[0].string_value != "en") return 13;
  if ((plan->scan.needed_slots & XPOD_RDF_SLOT_OBJECT) == 0) return 14;

  xpod_rdf_backend_v1 backend = {};
  backend.abi_version = XPOD_RDF_PHYSICAL_BACKEND_ABI_VERSION;
  backend.struct_size = sizeof(xpod_rdf_backend_v1);
  backend.lookup_terms = lookup_terms;
  backend.encode_qlever_id = encode_qlever_id;
  backend.get_capabilities = get_capabilities;
  xpod::rdf::PhysicalBackend physical(&backend);
  if (!xpod::qlever::canUsePhysicalFilterBridge(physical, *plan)) return 15;
  xpod_rdf_snapshot snapshot = {};
  std::string error;
  xpod_rdf_status status = xpod::qlever::bindPlanTerms(physical, snapshot, *plan, error);
  if (status != XPOD_RDF_STATUS_OK) return 16;
  if (!plan->scan.pattern.has_predicate || plan->scan.pattern.predicate != 91) return 17;

  auto malformed_plan = xpod::qlever::planParsedQuery(
      ParsedQuery::malformedLanguagePredicateSelectSubjectOnly());
  if (!malformed_plan.has_value()) return 18;
  if (malformed_plan->term_bindings.size() != 1) return 19;
  if (malformed_plan->term_bindings[0].value != "@en@urn:p0-filter/label") return 20;
  if (!malformed_plan->scan.filters.empty()) return 21;
  return 0;
}
`, 'utf8');

      execFileSync('c++', [
        '-std=c++17',
        '-Wall',
        '-Wextra',
        '-Werror',
        '-DXPOD_QLEVER_ADAPTER_ENABLE_QLEVER=1',
        '-I', path.dirname(planHeader),
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
  });


  nativeIt('executes postprocessed LANG predicates with hidden object columns before projecting visible subjects', async () => {
    expect(hasCxx(), 'c++ compiler is required for native language execution bridge check').toBe(true);

    const root = await mkdtemp(path.join(os.tmpdir(), 'xpod-qlever-plan-lang-exec-'));
    try {
      const qleverSource = path.join(root, 'qlever');
      await mkdir(path.join(qleverSource, 'src/parser'), { recursive: true });
      await mkdir(path.join(qleverSource, 'src/index'), { recursive: true });
      await mkdir(path.join(qleverSource, 'src/global'), { recursive: true });
      await mkdir(path.join(qleverSource, 'src/engine/idTable'), { recursive: true });
      await mkdir(path.join(qleverSource, 'src/engine'), { recursive: true });
      await writeFile(path.join(qleverSource, 'src/parser/ParsedQuery.h'), fakeParsedQueryHeader, 'utf8');
      await writeFile(path.join(qleverSource, 'src/parser/SparqlTriple.h'), fakeSparqlTripleHeader, 'utf8');
      await writeFile(path.join(qleverSource, 'src/global/Id.h'), `
#pragma once
#include <cstdint>
#include <limits>
using ColumnIndex = uint64_t;
enum class Datatype { Undefined, LocalVocabIndex };
class TextRecordIndex {
 public:
  static TextRecordIndex make(uint64_t value) { return TextRecordIndex(value); }
  uint64_t get() const { return value_; }
 private:
  explicit TextRecordIndex(uint64_t value) : value_(value) {}
  uint64_t value_;
};
class Id {
 public:
  static Id fromBits(uint64_t bits) { return Id(bits); }
  static Id makeUndefined() { return Id(UINT64_MAX); }
  static Id makeFromTextRecordIndex(TextRecordIndex index) {
    return Id(500000 + index.get());
  }
  uint64_t getBits() const { return bits_; }
  Datatype getDatatype() const { return Datatype::Undefined; }
  uint64_t getLocalVocabIndex() const { return bits_; }
  bool isInt() const { return false; }
  bool isDouble() const { return false; }
  int64_t getInt() const { return 0; }
  double getDouble() const { return 0; }
  friend bool operator<(const Id& left, const Id& right) {
    return left.bits_ < right.bits_;
  }
 private:
  explicit Id(uint64_t bits) : bits_(bits) {}
  uint64_t bits_;
};
`, 'utf8');
      await writeFile(path.join(qleverSource, 'src/global/ValueId.h'), `
#pragma once
#include "global/Id.h"
`, 'utf8');
      await writeFile(path.join(qleverSource, 'src/index/LocalVocab.h'), `
#pragma once
#include <string_view>
class FakeLocalVocabWord {
 public:
  bool isIri() const { return false; }
  bool isLiteral() const { return false; }
  std::string_view getIriContent() const { return {}; }
  std::string_view getLiteralContent() const { return {}; }
  bool hasLanguageTag() const { return false; }
  bool hasDatatype() const { return false; }
  std::string_view getLanguageTag() const { return {}; }
  std::string_view getDatatype() const { return {}; }
};
class LocalVocab {
 public:
  LocalVocab clone() const { return *this; }
  const FakeLocalVocabWord& getWord(uint64_t) const {
    static const FakeLocalVocabWord word;
    return word;
  }
};
`, 'utf8');
      await writeFile(path.join(qleverSource, 'src/index/Permutation.h'), `
#pragma once
class Permutation {
 public:
  enum struct Enum { PSO, POS, SPO, SOP, OPS, OSP };
};
`, 'utf8');
      await writeFile(path.join(qleverSource, 'src/engine/idTable/IdTable.h'), `
#pragma once
#include <cstddef>
#include <vector>
#include "global/Id.h"
class IdTable {
 public:
  explicit IdTable(size_t width) : width_(width) {}
  size_t numColumns() const { return width_; }
  size_t numRows() const { return rows_.size(); }
  void push_back(const std::vector<Id>& row) { rows_.push_back(row); }
  const Id& operator()(size_t row, size_t column) const { return rows_[row][column]; }
 private:
  size_t width_;
  std::vector<std::vector<Id>> rows_;
};
`, 'utf8');
      await writeFile(path.join(qleverSource, 'src/engine/Result.h'), `
#pragma once
#include <utility>
#include <vector>
#include "engine/idTable/IdTable.h"
#include "global/Id.h"
#include "index/LocalVocab.h"
class Result {
 public:
  Result(IdTable table, std::vector<ColumnIndex> sortedBy, LocalVocab&&)
      : table_(std::move(table)), sortedBy_(std::move(sortedBy)) {}
  const IdTable& idTable() const { return table_; }
  const std::vector<ColumnIndex>& sortedBy() const { return sortedBy_; }
 private:
  IdTable table_;
  std::vector<ColumnIndex> sortedBy_;
};
`, 'utf8');

      const smoke = path.join(root, 'plan_bridge_lang_exec_smoke.cpp');
      const binary = path.join(root, 'plan_bridge_lang_exec_smoke');
      await writeFile(smoke, `
#include <string_view>
#include "XpodQleverPlanBridge.hpp"
#include "XpodQleverOperationExecutor.hpp"

static xpod_rdf_status lookup_terms(
    void*,
    const xpod_rdf_term* terms,
    size_t term_count,
    const xpod_rdf_snapshot*,
    xpod_rdf_term_key* out_keys,
    xpod_rdf_status* out_statuses) {
  for (size_t index = 0; index < term_count; ++index) {
    if (terms[index].kind != XPOD_RDF_TERM_IRI) return XPOD_RDF_STATUS_BACKEND_ERROR;
    const std::string_view value(terms[index].value.data, terms[index].value.size);
    if (value == "urn:p0-filter/label") {
      out_keys[index] = 91;
    } else if (value == xpod::qlever::QleverDefaultGraphIri) {
      out_keys[index] = 1;
    } else {
      return XPOD_RDF_STATUS_BACKEND_ERROR;
    }
    out_statuses[index] = XPOD_RDF_STATUS_OK;
  }
  return XPOD_RDF_STATUS_OK;
}

static xpod_rdf_status encode_qlever_id(
    void*, xpod_rdf_term_key term, uint64_t* out_bits) {
  *out_bits = term + 1000;
  return XPOD_RDF_STATUS_OK;
}

static xpod_rdf_status decode_qlever_id(
    void*, uint64_t bits, xpod_rdf_term_key* out_term) {
  *out_term = bits - 1000;
  return XPOD_RDF_STATUS_OK;
}

static xpod_rdf_status resolve_terms(
    void*,
    const xpod_rdf_term_key* keys,
    size_t key_count,
    const xpod_rdf_snapshot*,
    xpod_rdf_term* out_terms,
    xpod_rdf_status* out_statuses) {
  for (size_t index = 0; index < key_count; ++index) {
    out_terms[index] = {};
    out_statuses[index] = XPOD_RDF_STATUS_OK;
    if (keys[index] == 101) {
      out_terms[index].kind = XPOD_RDF_TERM_LITERAL;
      out_terms[index].value = {"hello", 5};
      out_terms[index].language = {"en", 2};
    } else if (keys[index] == 102) {
      out_terms[index].kind = XPOD_RDF_TERM_LITERAL;
      out_terms[index].value = {"bonjour", 7};
      out_terms[index].language = {"fr", 2};
    } else {
      out_terms[index].kind = XPOD_RDF_TERM_IRI;
      out_terms[index].value = {"urn:subject", 11};
    }
  }
  return XPOD_RDF_STATUS_OK;
}

static xpod_rdf_status scan_permutation(
    void*,
    const xpod_rdf_scan_request* request,
    xpod_rdf_quad_batch_callback on_batch,
    void* callback_user_data) {
  if (request->needed_slots !=
      (XPOD_RDF_SLOT_SUBJECT | XPOD_RDF_SLOT_OBJECT)) {
    return XPOD_RDF_STATUS_BACKEND_ERROR;
  }
  if (!request->pattern.has_predicate || request->pattern.predicate != 91) {
    return XPOD_RDF_STATUS_BACKEND_ERROR;
  }
  if (request->filter_count != 1 || request->filters == nullptr) {
    return XPOD_RDF_STATUS_BACKEND_ERROR;
  }
  const xpod_rdf_scan_filter& filter = request->filters[0];
  if (filter.slot != XPOD_RDF_SLOT_OBJECT ||
      filter.kind != XPOD_RDF_SCAN_FILTER_LANGUAGE_EQUAL ||
      filter.negated != 0 ||
      std::string_view(filter.value.data, filter.value.size) != "en") {
    return XPOD_RDF_STATUS_BACKEND_ERROR;
  }
  xpod_rdf_quad_key rows[1] = {{10, 91, 101, 0}};
  xpod_rdf_quad_batch batch = {};
  batch.rows = rows;
  batch.row_count = 1;
  return on_batch(callback_user_data, &batch);
}

static xpod_rdf_status get_capabilities(
    void*, xpod_rdf_backend_capabilities* out) {
  *out = {};
  out->supported_permutations = XPOD_RDF_PERM_CAP_PSOG;
  out->features = XPOD_RDF_BACKEND_FEATURE_SCAN_FILTER;
  return XPOD_RDF_STATUS_OK;
}

int main() {
  auto plan = xpod::qlever::planParsedQuery(
      ParsedQuery::postprocessedLanguagePredicateSelectSubjectOnly());
  if (!plan.has_value()) return 1;
  xpod_rdf_backend_v1 backend = {};
  backend.abi_version = XPOD_RDF_PHYSICAL_BACKEND_ABI_VERSION;
  backend.struct_size = sizeof(xpod_rdf_backend_v1);
  backend.lookup_terms = lookup_terms;
  backend.encode_qlever_id = encode_qlever_id;
  backend.decode_qlever_id = decode_qlever_id;
  backend.resolve_terms = resolve_terms;
  backend.scan_permutation = scan_permutation;
  backend.get_capabilities = get_capabilities;
  xpod::rdf::PhysicalBackend physical(&backend);
  xpod_rdf_snapshot snapshot = {};
  std::string error;
  xpod_rdf_status status = xpod::qlever::bindPlanTerms(physical, snapshot, *plan, error);
  if (status != XPOD_RDF_STATUS_OK) return 2;
  xpod::qlever::BridgePhysicalPlan physical_plan =
      xpod::qlever::toBridgePhysicalPlan(*plan);

  auto result = xpod::qlever::executeBridgeOperationPlan(physical, physical_plan);
  if (result.status != XPOD_RDF_STATUS_OK) return 3;
  const IdTable& table = result.result.idTable();
  if (table.numColumns() != 1) return 4;
  if (table.numRows() != 1) return 5;
  if (table(0, 0).getBits() != 1010) return 6;
  if (physical_plan.scans.size() != 1) return 7;
  if (physical_plan.scans[0].result_width != 2) return 8;
  return 0;
}
`, 'utf8');

      execFileSync('c++', [
        '-std=c++17',
        '-Wall',
        '-Wextra',
        '-Werror',
        '-DXPOD_QLEVER_ADAPTER_ENABLE_QLEVER=1',
        '-I', path.dirname(planHeader),
        '-I', path.join(repoRoot, 'qlever/include'),
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
  });


  nativeIt('binds prefix term constraints through prefixRange into scan slot ranges', async () => {
    expect(hasCxx(), 'c++ compiler is required for native prefix range plan bridge check').toBe(true);

    const root = await mkdtemp(path.join(os.tmpdir(), 'xpod-qlever-plan-prefix-range-'));
    try {
      const qleverSource = path.join(root, 'qlever');
      await mkdir(path.join(qleverSource, 'src/parser'), { recursive: true });
      await mkdir(path.join(qleverSource, 'src/index'), { recursive: true });
      await mkdir(path.join(qleverSource, 'src/global'), { recursive: true });
      await writeFile(path.join(qleverSource, 'src/parser/ParsedQuery.h'), fakeParsedQueryHeader, 'utf8');
      await writeFile(path.join(qleverSource, 'src/parser/SparqlTriple.h'), fakeSparqlTripleHeader, 'utf8');
      await writeFile(path.join(qleverSource, 'src/global/Id.h'), '#pragma once\n#include <cstdint>\nusing ColumnIndex = uint64_t;\nclass Id { public: static Id fromBits(uint64_t bits) { return Id(bits); } uint64_t getBits() const { return bits_; } private: explicit Id(uint64_t bits) : bits_(bits) {} uint64_t bits_; };\n', 'utf8');
      await writeFile(path.join(qleverSource, 'src/index/Permutation.h'), `
#pragma once
class Permutation {
 public:
  enum struct Enum { PSO, POS, SPO, SOP, OPS, OSP };
};
`, 'utf8');

      const smoke = path.join(root, 'plan_bridge_prefix_range_smoke.cpp');
      const binary = path.join(root, 'plan_bridge_prefix_range_smoke');
      await writeFile(smoke, `
#include <string_view>
#include "XpodQleverPlanBridge.hpp"

static xpod_rdf_status prefix_range(
    void*,
    const xpod_rdf_prefix_range_request* request,
    xpod_rdf_term_range_batch_callback on_batch,
    void* callback_user_data) {
  if (!request->has_kind || request->kind != XPOD_RDF_TERM_IRI) return XPOD_RDF_STATUS_BACKEND_ERROR;
  if (std::string_view(request->prefix.data, request->prefix.size) != "urn:doc/") return XPOD_RDF_STATUS_BACKEND_ERROR;
  xpod_rdf_term_range ranges[2] = {};
  ranges[0].lower = 100;
  ranges[0].upper = 200;
  ranges[0].has_lower = 1;
  ranges[0].has_upper = 1;
  ranges[0].lower_inclusive = 1;
  ranges[0].upper_exclusive = 1;
  ranges[1].lower = 300;
  ranges[1].upper = 400;
  ranges[1].has_lower = 1;
  ranges[1].has_upper = 1;
  ranges[1].lower_inclusive = 1;
  ranges[1].upper_exclusive = 1;
  xpod_rdf_term_range_batch batch = {};
  batch.ranges = ranges;
  batch.range_count = 2;
  batch.collation = XPOD_RDF_TERM_COLLATION_BYTEWISE;
  return on_batch(callback_user_data, &batch);
}

int main() {
  xpod::qlever::BridgeQueryPlan plan;
  xpod::qlever::BridgeTermBinding binding;
  binding.slot = XPOD_RDF_SLOT_SUBJECT;
  binding.kind = XPOD_RDF_TERM_IRI;
  binding.value = "urn:doc/";
  binding.is_prefix = true;
  plan.term_bindings.push_back(binding);

  xpod_rdf_backend_v1 backend = {};
  backend.abi_version = XPOD_RDF_PHYSICAL_BACKEND_ABI_VERSION;
  backend.struct_size = sizeof(xpod_rdf_backend_v1);
  backend.prefix_range = prefix_range;
  xpod::rdf::PhysicalBackend physical(&backend);
  xpod_rdf_snapshot snapshot = {};
  std::string error;
  xpod_rdf_status status = xpod::qlever::bindPlanTerms(physical, snapshot, plan, error);
  if (status != XPOD_RDF_STATUS_OK) return 1;
  if (plan.known_empty) return 2;
  if (plan.scan.pattern.has_subject) return 3;
  if (plan.scan.slot_ranges.size() != 2) return 4;
  if (plan.scan.slot_ranges[0].slot != XPOD_RDF_SLOT_SUBJECT) return 5;
  if (plan.scan.slot_ranges[0].range.lower != 100 || plan.scan.slot_ranges[1].range.upper != 400) return 6;
  if (plan.scan.slot_ranges[0].collation != XPOD_RDF_TERM_COLLATION_BYTEWISE) return 7;
  return 0;
}
`, 'utf8');

      execFileSync('c++', [
        '-std=c++17',
        '-Wall',
        '-Wextra',
        '-Werror',
        '-DXPOD_QLEVER_ADAPTER_ENABLE_QLEVER=1',
        '-I', path.dirname(planHeader),
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
  });

}, 30_000);
