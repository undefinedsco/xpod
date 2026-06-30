import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { fakeParsedQueryHeader, fakeSparqlTripleHeader } from './qleverFakeHeaders';

const repoRoot = path.resolve(__dirname, '../..');
const planHeader = path.join(repoRoot, 'native/postgres/qlever_adapter/src/XpodQleverPlanBridge.hpp');

function hasCxx(): boolean {
  try {
    execFileSync('/usr/bin/env', ['c++', '--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

describe('QLever parsed plan bridge', () => {
  it('builds an executable Xpod scan plan from a QLever ParsedQuery BGP', async () => {
    expect(hasCxx(), 'c++ compiler is required for native plan bridge check').toBe(true);

    const root = await mkdtemp(path.join(os.tmpdir(), 'xpod-qlever-plan-'));
    try {
      const qleverSource = path.join(root, 'qlever');
      await mkdir(path.join(qleverSource, 'src/parser'), { recursive: true });
      await mkdir(path.join(qleverSource, 'src/index'), { recursive: true });
      await mkdir(path.join(qleverSource, 'src/global'), { recursive: true });
      await writeFile(path.join(qleverSource, 'src/parser/ParsedQuery.h'), fakeParsedQueryHeader, 'utf8');
      await writeFile(path.join(qleverSource, 'src/parser/SparqlTriple.h'), fakeSparqlTripleHeader, 'utf8');
      await writeFile(path.join(qleverSource, 'src/global/Id.h'), '#pragma once\n#include <cstdint>\nusing ColumnIndex = uint64_t;\n', 'utf8');
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

  it('binds parsed IRI constants through the native term dictionary into the scan pattern', async () => {
    expect(hasCxx(), 'c++ compiler is required for native plan bridge check').toBe(true);

    const root = await mkdtemp(path.join(os.tmpdir(), 'xpod-qlever-plan-bind-'));
    try {
      const qleverSource = path.join(root, 'qlever');
      await mkdir(path.join(qleverSource, 'src/parser'), { recursive: true });
      await mkdir(path.join(qleverSource, 'src/index'), { recursive: true });
      await mkdir(path.join(qleverSource, 'src/global'), { recursive: true });
      await writeFile(path.join(qleverSource, 'src/parser/ParsedQuery.h'), fakeParsedQueryHeader, 'utf8');
      await writeFile(path.join(qleverSource, 'src/parser/SparqlTriple.h'), fakeSparqlTripleHeader, 'utf8');
      await writeFile(path.join(qleverSource, 'src/global/Id.h'), '#pragma once\n#include <cstdint>\nusing ColumnIndex = uint64_t;\n', 'utf8');
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
  if (term_count != 1) return XPOD_RDF_STATUS_BACKEND_ERROR;
  if (terms[0].kind != XPOD_RDF_TERM_IRI) return XPOD_RDF_STATUS_BACKEND_ERROR;
  if (std::string_view(terms[0].value.data, terms[0].value.size) != "urn:p") return XPOD_RDF_STATUS_BACKEND_ERROR;
  out_keys[0] = 20;
  out_statuses[0] = XPOD_RDF_STATUS_OK;
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

  it('binds parsed GRAPH IRIs through the native term dictionary into the scan graph pattern', async () => {
    expect(hasCxx(), 'c++ compiler is required for native graph plan bridge check').toBe(true);

    const root = await mkdtemp(path.join(os.tmpdir(), 'xpod-qlever-plan-graph-'));
    try {
      const qleverSource = path.join(root, 'qlever');
      await mkdir(path.join(qleverSource, 'src/parser'), { recursive: true });
      await mkdir(path.join(qleverSource, 'src/index'), { recursive: true });
      await mkdir(path.join(qleverSource, 'src/global'), { recursive: true });
      await writeFile(path.join(qleverSource, 'src/parser/ParsedQuery.h'), fakeParsedQueryHeader, 'utf8');
      await writeFile(path.join(qleverSource, 'src/parser/SparqlTriple.h'), fakeSparqlTripleHeader, 'utf8');
      await writeFile(path.join(qleverSource, 'src/global/Id.h'), '#pragma once\n#include <cstdint>\nusing ColumnIndex = uint64_t;\n', 'utf8');
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

  it('projects parsed GRAPH variables as the scan graph slot', async () => {
    expect(hasCxx(), 'c++ compiler is required for native graph variable plan bridge check').toBe(true);

    const root = await mkdtemp(path.join(os.tmpdir(), 'xpod-qlever-plan-graph-var-'));
    try {
      const qleverSource = path.join(root, 'qlever');
      await mkdir(path.join(qleverSource, 'src/parser'), { recursive: true });
      await mkdir(path.join(qleverSource, 'src/index'), { recursive: true });
      await mkdir(path.join(qleverSource, 'src/global'), { recursive: true });
      await writeFile(path.join(qleverSource, 'src/parser/ParsedQuery.h'), fakeParsedQueryHeader, 'utf8');
      await writeFile(path.join(qleverSource, 'src/parser/SparqlTriple.h'), fakeSparqlTripleHeader, 'utf8');
      await writeFile(path.join(qleverSource, 'src/global/Id.h'), '#pragma once\n#include <cstdint>\nusing ColumnIndex = uint64_t;\n', 'utf8');
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

  it('joins parsed GRAPH variable groups on subject and graph slots', async () => {
    expect(hasCxx(), 'c++ compiler is required for native graph variable join plan bridge check').toBe(true);

    const root = await mkdtemp(path.join(os.tmpdir(), 'xpod-qlever-plan-graph-var-join-'));
    try {
      const qleverSource = path.join(root, 'qlever');
      await mkdir(path.join(qleverSource, 'src/parser'), { recursive: true });
      await mkdir(path.join(qleverSource, 'src/index'), { recursive: true });
      await mkdir(path.join(qleverSource, 'src/global'), { recursive: true });
      await writeFile(path.join(qleverSource, 'src/parser/ParsedQuery.h'), fakeParsedQueryHeader, 'utf8');
      await writeFile(path.join(qleverSource, 'src/parser/SparqlTriple.h'), fakeSparqlTripleHeader, 'utf8');
      await writeFile(path.join(qleverSource, 'src/global/Id.h'), '#pragma once\n#include <cstdint>\nusing ColumnIndex = uint64_t;\n', 'utf8');
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


  it('binds parsed literal constants through the native term dictionary into the scan pattern', async () => {
    expect(hasCxx(), 'c++ compiler is required for native plan bridge check').toBe(true);

    const root = await mkdtemp(path.join(os.tmpdir(), 'xpod-qlever-plan-literal-'));
    try {
      const qleverSource = path.join(root, 'qlever');
      await mkdir(path.join(qleverSource, 'src/parser'), { recursive: true });
      await mkdir(path.join(qleverSource, 'src/index'), { recursive: true });
      await mkdir(path.join(qleverSource, 'src/global'), { recursive: true });
      await writeFile(path.join(qleverSource, 'src/parser/ParsedQuery.h'), fakeParsedQueryHeader, 'utf8');
      await writeFile(path.join(qleverSource, 'src/parser/SparqlTriple.h'), fakeSparqlTripleHeader, 'utf8');
      await writeFile(path.join(qleverSource, 'src/global/Id.h'), '#pragma once\n#include <cstdint>\nusing ColumnIndex = uint64_t;\n', 'utf8');
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
  if (term_count != 1) return XPOD_RDF_STATUS_BACKEND_ERROR;
  if (terms[0].kind != XPOD_RDF_TERM_LITERAL) return XPOD_RDF_STATUS_BACKEND_ERROR;
  if (std::string_view(terms[0].value.data, terms[0].value.size) != "value") return XPOD_RDF_STATUS_BACKEND_ERROR;
  if (terms[0].datatype_iri.size != 0 || terms[0].language.size != 0) return XPOD_RDF_STATUS_BACKEND_ERROR;
  out_keys[0] = 30;
  out_statuses[0] = XPOD_RDF_STATUS_OK;
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


  it('exposes a QLever-like operation root for single scan and hash join plans', async () => {
    expect(hasCxx(), 'c++ compiler is required for native plan bridge check').toBe(true);

    const root = await mkdtemp(path.join(os.tmpdir(), 'xpod-qlever-operation-root-'));
    try {
      const qleverSource = path.join(root, 'qlever');
      await mkdir(path.join(qleverSource, 'src/parser'), { recursive: true });
      await mkdir(path.join(qleverSource, 'src/index'), { recursive: true });
      await mkdir(path.join(qleverSource, 'src/global'), { recursive: true });
      await writeFile(path.join(qleverSource, 'src/parser/ParsedQuery.h'), fakeParsedQueryHeader, 'utf8');
      await writeFile(path.join(qleverSource, 'src/parser/SparqlTriple.h'), fakeSparqlTripleHeader, 'utf8');
      await writeFile(path.join(qleverSource, 'src/global/Id.h'), '#pragma once\n#include <cstdint>\nusing ColumnIndex = uint64_t;\n', 'utf8');
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

  it('plans parsed not-equals IRI filters as bounded result modifiers', async () => {
    expect(hasCxx(), 'c++ compiler is required for native filter plan bridge check').toBe(true);

    const root = await mkdtemp(path.join(os.tmpdir(), 'xpod-qlever-plan-filter-'));
    try {
      const qleverSource = path.join(root, 'qlever');
      await mkdir(path.join(qleverSource, 'src/parser'), { recursive: true });
      await mkdir(path.join(qleverSource, 'src/index'), { recursive: true });
      await mkdir(path.join(qleverSource, 'src/global'), { recursive: true });
      await writeFile(path.join(qleverSource, 'src/parser/ParsedQuery.h'), fakeParsedQueryHeader, 'utf8');
      await writeFile(path.join(qleverSource, 'src/parser/SparqlTriple.h'), fakeSparqlTripleHeader, 'utf8');
      await writeFile(path.join(qleverSource, 'src/global/Id.h'), '#pragma once\n#include <cstdint>\nusing ColumnIndex = uint64_t;\n', 'utf8');
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
  if (value == "urn:tail") {
    out_keys[0] = 70;
  } else if (value == "urn:o") {
    out_keys[0] = 30;
  } else {
    return XPOD_RDF_STATUS_BACKEND_ERROR;
  }
  out_statuses[0] = XPOD_RDF_STATUS_OK;
  return XPOD_RDF_STATUS_OK;
}

static xpod_rdf_status encode_qlever_id(void*, xpod_rdf_term_key term, uint64_t* out_bits) {
  *out_bits = term + 1000;
  return XPOD_RDF_STATUS_OK;
}

int main() {
  ParsedQuery parsed = ParsedQuery::filterObjectNotTailSelect();
  auto plan = xpod::qlever::planParsedQuery(parsed);
  if (!plan.has_value()) return 1;
  if (plan->root.result_modifiers.size() != 1) return 2;
  const auto& modifier = plan->root.result_modifiers[0];
  if (modifier.kind != xpod::qlever::BridgeResultModifierKind::NotEqualTerm) return 3;
  if (modifier.columns.size() != 1 || modifier.columns[0] != 1) return 4;
  if (plan->modifier_term_bindings.size() != 1) return 5;
  if (plan->modifier_term_bindings[0].modifier_index != 0) return 6;
  if (plan->modifier_term_bindings[0].term.value != "urn:tail") return 7;
  if (plan->descriptor.find("Filter") == std::string::npos) return 8;

  xpod_rdf_backend_v1 backend = {};
  backend.abi_version = XPOD_RDF_PHYSICAL_BACKEND_ABI_VERSION;
  backend.struct_size = sizeof(xpod_rdf_backend_v1);
  backend.lookup_terms = lookup_terms;
  backend.encode_qlever_id = encode_qlever_id;
  xpod::rdf::PhysicalBackend physical(&backend);
  xpod_rdf_snapshot snapshot = {};
  std::string error;
  xpod_rdf_status status = xpod::qlever::bindPlanTerms(physical, snapshot, *plan, error);
  if (status != XPOD_RDF_STATUS_OK) return 9;
  if (!plan->root.result_modifiers[0].has_term_id_bits) return 10;
  if (plan->root.result_modifiers[0].term_id_bits != 1070) return 11;

  auto equal_plan = xpod::qlever::planParsedQuery(ParsedQuery::filterObjectEqualsOSelect());
  if (!equal_plan.has_value()) return 12;
  if (equal_plan->root.result_modifiers.size() != 1) return 13;
  const auto& equal_modifier = equal_plan->root.result_modifiers[0];
  if (equal_modifier.kind != xpod::qlever::BridgeResultModifierKind::EqualTerm) return 14;
  if (equal_modifier.columns.size() != 1 || equal_modifier.columns[0] != 1) return 15;
  if (equal_plan->modifier_term_bindings.size() != 1) return 16;
  if (equal_plan->modifier_term_bindings[0].term.value != "urn:o") return 17;
  status = xpod::qlever::bindPlanTerms(physical, snapshot, *equal_plan, error);
  if (status != XPOD_RDF_STATUS_OK) return 18;
  if (!equal_plan->root.result_modifiers[0].has_term_id_bits) return 19;
  if (equal_plan->root.result_modifiers[0].term_id_bits != 1030) return 20;
  if (xpod::qlever::planParsedQuery(ParsedQuery::unsupportedFilterSelect()).has_value()) return 21;
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

  it('plans parsed cross-slot two-triple joins with right-side projections', async () => {
    expect(hasCxx(), 'c++ compiler is required for native cross-slot plan bridge check').toBe(true);

    const root = await mkdtemp(path.join(os.tmpdir(), 'xpod-qlever-plan-cross-slot-join-'));
    try {
      const qleverSource = path.join(root, 'qlever');
      await mkdir(path.join(qleverSource, 'src/parser'), { recursive: true });
      await mkdir(path.join(qleverSource, 'src/index'), { recursive: true });
      await mkdir(path.join(qleverSource, 'src/global'), { recursive: true });
      await writeFile(path.join(qleverSource, 'src/parser/ParsedQuery.h'), fakeParsedQueryHeader, 'utf8');
      await writeFile(path.join(qleverSource, 'src/parser/SparqlTriple.h'), fakeSparqlTripleHeader, 'utf8');
      await writeFile(path.join(qleverSource, 'src/global/Id.h'), '#pragma once\n#include <cstdint>\nusing ColumnIndex = uint64_t;\n', 'utf8');
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

  it('plans a two-triple BGP as a primary scan plus subject filter scan', async () => {
    expect(hasCxx(), 'c++ compiler is required for native plan bridge check').toBe(true);

    const root = await mkdtemp(path.join(os.tmpdir(), 'xpod-qlever-plan-join-'));
    try {
      const qleverSource = path.join(root, 'qlever');
      await mkdir(path.join(qleverSource, 'src/parser'), { recursive: true });
      await mkdir(path.join(qleverSource, 'src/index'), { recursive: true });
      await mkdir(path.join(qleverSource, 'src/global'), { recursive: true });
      await writeFile(path.join(qleverSource, 'src/parser/ParsedQuery.h'), fakeParsedQueryHeader, 'utf8');
      await writeFile(path.join(qleverSource, 'src/parser/SparqlTriple.h'), fakeSparqlTripleHeader, 'utf8');
      await writeFile(path.join(qleverSource, 'src/global/Id.h'), '#pragma once\n#include <cstdint>\nusing ColumnIndex = uint64_t;\n', 'utf8');
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


  it('binds prefix term constraints through prefixRange into scan slot ranges', async () => {
    expect(hasCxx(), 'c++ compiler is required for native prefix range plan bridge check').toBe(true);

    const root = await mkdtemp(path.join(os.tmpdir(), 'xpod-qlever-plan-prefix-range-'));
    try {
      const qleverSource = path.join(root, 'qlever');
      await mkdir(path.join(qleverSource, 'src/parser'), { recursive: true });
      await mkdir(path.join(qleverSource, 'src/index'), { recursive: true });
      await mkdir(path.join(qleverSource, 'src/global'), { recursive: true });
      await writeFile(path.join(qleverSource, 'src/parser/ParsedQuery.h'), fakeParsedQueryHeader, 'utf8');
      await writeFile(path.join(qleverSource, 'src/parser/SparqlTriple.h'), fakeSparqlTripleHeader, 'utf8');
      await writeFile(path.join(qleverSource, 'src/global/Id.h'), '#pragma once\n#include <cstdint>\nusing ColumnIndex = uint64_t;\n', 'utf8');
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
