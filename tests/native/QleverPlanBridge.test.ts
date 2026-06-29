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
});
