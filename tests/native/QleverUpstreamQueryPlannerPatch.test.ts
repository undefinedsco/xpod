import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(__dirname, '../..');
const patchScript = path.join(repoRoot, 'scripts/check-qlever-upstream-patches.cjs');
const patchPath = path.join(
  repoRoot,
  'native/postgres/qlever_adapter/patches/qlever-queryplanner-physical-index.patch',
);

const upstreamQueryPlannerFixture = `#include "engine/QueryPlanner.h"

void QueryPlanner::indexScanThreeVarsCase(
    const SparqlTripleSimple& triple,
    const AddedIndexScanFunction& addIndexScan, const AddedFilter& addFilter) {
  using enum Permutation::Enum;
  AD_CONTRACT_CHECK(!_qec || _qec->getIndex().hasAllPermutations(),
                    "With only 2 permutations registered (no -a option), "
                    "triples should have at most two variables.");
  addIndexScan(OPS);
  addIndexScan(OSP);
  addIndexScan(PSO);
  addIndexScan(POS);
  addIndexScan(SPO);
  addIndexScan(SOP);
}

auto QueryPlanner::seedWithScansAndText(
    const QueryPlanner::TripleGraph& tg,
    const vector<vector<SubtreePlan>>& children,
    TextLimitMap& textLimits) -> PlansAndFilters {
  PlansAndFilters result;
  for (size_t i = 0; i < tg._nodeMap.size(); ++i) {
    const TripleGraph::Node& node = *tg._nodeMap.find(i)->second;
    if (_qec && !_qec->getIndex().hasAllPermutations() &&
        node.triple_.getPredicateVariable().has_value()) {
      AD_THROW(
          "The query contains a predicate variable, but only the PSO "
          "and POS permutations were loaded. Rerun the server without "
          "the option --only-pso-and-pos-permutations and if "
          "necessary also rebuild the index");
    }
  }
  return result;
}
`;

describe('QLever upstream QueryPlanner patch asset', () => {
  it('applies to planner permutation guards so Xpod-backed contexts do not require QLever native permutations', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'xpod-qlever-queryplanner-patch-'));
    try {
      const qleverSource = path.join(root, 'qlever');
      const queryPlannerPath = path.join(qleverSource, 'src/engine/QueryPlanner.cpp');
      await mkdir(path.dirname(queryPlannerPath), { recursive: true });
      await writeFile(queryPlannerPath, upstreamQueryPlannerFixture, 'utf8');

      execFileSync('node', [
        patchScript,
        '--qlever-source',
        qleverSource,
        '--patch',
        patchPath,
        '--apply',
      ], { stdio: 'pipe' });

      const patched = await readFile(queryPlannerPath, 'utf8');
      expect(patched).toContain('"XpodQleverPhysicalIndexScanContextBridge.hpp"');
      expect(patched).toContain('xpod::qlever::physicalIndexFromContext(*_qec) == nullptr');
      expect(patched).toContain('xpod::qlever::physicalIndexFromContext(*_qec) != nullptr');
      expect(patched).toContain('triples should have at most two variables');
      expect(patched).toContain('The query contains a predicate variable');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('accepts an already patched QueryPlanner source as valid', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'xpod-qlever-queryplanner-patched-'));
    try {
      const qleverSource = path.join(root, 'qlever');
      const queryPlannerPath = path.join(qleverSource, 'src/engine/QueryPlanner.cpp');
      await mkdir(path.dirname(queryPlannerPath), { recursive: true });
      await writeFile(queryPlannerPath, upstreamQueryPlannerFixture, 'utf8');

      execFileSync('node', [
        patchScript,
        '--qlever-source',
        qleverSource,
        '--patch',
        patchPath,
        '--apply',
      ], { stdio: 'pipe' });
      execFileSync('node', [
        patchScript,
        '--qlever-source',
        qleverSource,
        '--patch',
        patchPath,
      ], { stdio: 'pipe' });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
