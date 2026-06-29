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

});
