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

describe('QLever bridge plan request context', () => {
  it('applies snapshot, graph scope, source scope, and access scope to scan and candidate sources', async () => {
    expect(hasCxx(), 'c++ compiler is required for native plan request context check').toBe(true);

    const root = await mkdtemp(path.join(os.tmpdir(), 'xpod-qlever-plan-context-'));
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

      const smoke = path.join(root, 'plan_request_context_smoke.cpp');
      const binary = path.join(root, 'plan_request_context_smoke');
      await writeFile(smoke, `
#include <string>
#include "XpodQleverPlanBridge.hpp"

static bool bytes_equal(xpod_rdf_bytes actual, const char* expected) {
  return std::string(actual.data, actual.size) == expected;
}

int main() {
  xpod::qlever::BridgeQueryPlan plan;
  xpod::qlever::BridgeFilterScan filter;
  plan.filter_scans.push_back(filter);

  xpod::qlever::BridgeTextCandidateSource text;
  text.request.limit = 3;
  plan.text_sources.push_back(text);

  double values[2] = {0.1, 0.2};
  xpod::qlever::BridgeVectorCandidateSource vector;
  vector.request.vector = values;
  vector.request.dimensions = 2;
  plan.vector_sources.push_back(vector);

  xpod_rdf_snapshot snapshot = {};
  snapshot.facts_version = {"facts-v1", 8};
  xpod_rdf_source_scope source_scope = {};
  source_scope.local_path_prefix = {"/workspace/docs/", 16};
  xpod_rdf_graph_scope graph_scope = {};
  graph_scope.kind = XPOD_RDF_GRAPH_SCOPE_EXACT;
  graph_scope.exact_graph = 99;
  xpod_rdf_access_scope access_scope = {};
  access_scope.permission_version = {"perm-v1", 7};

  xpod::qlever::applyBridgeRequestContext(
      plan, snapshot, graph_scope, source_scope, &access_scope);

  if (plan.scan.snapshot != &snapshot) return 1;
  if (plan.scan.source_scope != &source_scope) return 2;
  if (plan.scan.access_scope != &access_scope) return 3;
  if (plan.scan.graph_scope.kind != XPOD_RDF_GRAPH_SCOPE_EXACT) return 31;
  if (plan.scan.graph_scope.exact_graph != 99) return 32;
  if (plan.filter_scans[0].scan.snapshot != &snapshot) return 4;
  if (plan.filter_scans[0].scan.source_scope != &source_scope) return 5;
  if (plan.filter_scans[0].scan.access_scope != &access_scope) return 6;
  if (plan.filter_scans[0].scan.graph_scope.kind != XPOD_RDF_GRAPH_SCOPE_EXACT) return 61;
  if (plan.filter_scans[0].scan.graph_scope.exact_graph != 99) return 62;
  if (!bytes_equal(plan.text_sources[0].request.snapshot.facts_version, "facts-v1")) return 7;
  if (!bytes_equal(plan.text_sources[0].request.source_scope.local_path_prefix, "/workspace/docs/")) return 8;
  if (plan.text_sources[0].request.access_scope != &access_scope) return 9;
  if (plan.text_sources[0].request.graph_scope.kind != XPOD_RDF_GRAPH_SCOPE_EXACT) return 91;
  if (plan.text_sources[0].request.graph_scope.exact_graph != 99) return 92;
  if (!bytes_equal(plan.vector_sources[0].request.snapshot.facts_version, "facts-v1")) return 10;
  if (!bytes_equal(plan.vector_sources[0].request.source_scope.local_path_prefix, "/workspace/docs/")) return 11;
  if (plan.vector_sources[0].request.access_scope != &access_scope) return 12;
  if (plan.vector_sources[0].request.graph_scope.kind != XPOD_RDF_GRAPH_SCOPE_EXACT) return 121;
  if (plan.vector_sources[0].request.graph_scope.exact_graph != 99) return 122;
  if (plan.text_sources[0].request.limit != 3) return 13;
  if (plan.vector_sources[0].request.vector != values) return 14;
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
