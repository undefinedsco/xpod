import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'bun:test';

const repoRoot = path.resolve(__dirname, '../..');
const patchScript = path.join(repoRoot, 'qlever/scripts/check-qlever-upstream-patches.cjs');
const patchPath = path.join(
  repoRoot,
  'qlever/patches/qlever-queryplanner-physical-index.patch',
);
const defaultGraphPatchPath = path.join(
  repoRoot,
  'qlever/patches/qlever-queryplanner-physical-default-graph.patch',
);
const pathSearchPatchPath = path.join(
  repoRoot,
  'qlever/patches/qlever-queryplanner-physical-path-search.patch',
);
const textAnchorPatchPath = path.join(
  repoRoot,
  'qlever/patches/qlever-queryplanner-physical-text-anchor.patch',
);

const upstreamQueryPlannerFixture = `#include "engine/QueryPlanner.h"

std::vector<SubtreePlan> QueryPlanner::createExecutionTrees(ParsedQuery& pq,
                                                            bool isSubquery) {

  using checkUsePatternTrick::PatternTrickTuple;
  const auto patternTrickTuple =
      _enablePatternTrick ? checkUsePatternTrick::checkUsePatternTrick(&pq)
                          : std::nullopt;
  return {};
}

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

void QueryPlanner::seedTextTerms() {
  for (const auto& [cvar, terms] : potentialTermsForCvar) {
    optTermForCvar[cvar] =
        terms[_qec->getIndex().getIndexOfBestSuitedElTerm(terms)];
  }
}

void QueryPlanner::GraphPatternPlanner::visitPathSearch(
    parsedQuery::PathQuery& pathQuery) {
  auto config = pathQuery.toPathSearchConfiguration(planner_._qec->getIndex());
}
`;

const upstreamGetActiveGraphsFixture = `#include "engine/QueryPlanner.h"
#include "XpodQleverPhysicalIndexScanContextBridge.hpp"

qlever::index::GraphFilter<TripleComponent> QueryPlanner::getActiveGraphs()
    const {
  using Filter = qlever::index::GraphFilter<TripleComponent>;
  auto activeGraphs = activeDatasetClauses_.activeDefaultGraphs();
  if (activeGraphs.has_value()) {
    return Filter::Whitelist(std::move(activeGraphs).value());
  }
  if (defaultGraphBehaviour_ ==
      parsedQuery::GroupGraphPattern::GraphVariableBehaviour::NAMED) {
    return Filter::Blacklist(TripleComponent{
        ad_utility::triple_component::Iri::fromIriref(DEFAULT_GRAPH_IRI)});
  }
  return Filter::All();
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
      execFileSync('node', [
        patchScript,
        '--qlever-source',
        qleverSource,
        '--patch',
        textAnchorPatchPath,
        '--apply',
      ], { stdio: 'pipe' });
      const patched = await readFile(queryPlannerPath, 'utf8');
      expect(patched).toContain('"XpodQleverPhysicalIndexScanContextBridge.hpp"');
      expect(patched).toContain('xpod::qlever::physicalIndexFromContext(*_qec) == nullptr');
      expect(patched).toContain('xpod::qlever::physicalIndexFromContext(*_qec) != nullptr');
      expect(patched).toContain('_enablePatternTrick && !xpodPhysicalIndex');
      expect(patched).toContain(
        'const bool xpodPhysicalIndex =\n      _qec != nullptr &&\n      xpod::qlever::physicalIndexFromContext(*_qec) != nullptr;',
      );
      expect(patched).toContain('triples should have at most two variables');
      expect(patched).toContain('The query contains a predicate variable');
      expect(patched).toContain('"XpodQleverPhysicalPathSearchContextBridge.hpp"');
      expect(patched).toContain('bestPhysicalTextTermIndexFromContext');
      expect(patched).toContain('physicalBestTerm.has_value()');
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

  it('patches physical QueryPlanner root default graph scans without changing GRAPH named scope', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'xpod-qlever-queryplanner-default-graph-patch-'));
    try {
      const qleverSource = path.join(root, 'qlever');
      const queryPlannerPath = path.join(qleverSource, 'src/engine/QueryPlanner.cpp');
      await mkdir(path.dirname(queryPlannerPath), { recursive: true });
      await writeFile(queryPlannerPath, upstreamGetActiveGraphsFixture, 'utf8');

      execFileSync('node', [
        patchScript,
        '--qlever-source',
        qleverSource,
        '--patch',
        defaultGraphPatchPath,
        '--apply',
      ], { stdio: 'pipe' });

      const patched = await readFile(queryPlannerPath, 'utf8');
      expect(patched).toContain('activeDatasetClauses_.activeDefaultGraphs()');
      expect(patched).toMatch(
        /activeGraphs\.has_value\(\)[\s\S]*?Filter::Whitelist\(std::move\(activeGraphs\)\.value\(\)\)/,
      );
      expect(patched).toMatch(
        /GraphVariableBehaviour::NAMED[\s\S]*?Filter::Blacklist\(TripleComponent\{/,
      );
      expect(patched).toContain('xpod::qlever::physicalIndexFromContext(*_qec) != nullptr');
      expect(patched).toContain('ad_utility::HashSet<TripleComponent> defaultGraphs');
      expect(patched).toContain('defaultGraphs.emplace(TripleComponent{');
      expect(patched).toContain('Filter::Whitelist(std::move(defaultGraphs))');
      expect(patched).toContain('ad_utility::triple_component::Iri::fromIriref(DEFAULT_GRAPH_IRI)');
      expect(patched).toMatch(
        /physicalIndexFromContext\(\*_qec\) != nullptr[\s\S]*?Filter::Whitelist[\s\S]*?return Filter::All\(\);/,
      );
      execFileSync('node', [
        patchScript,
        '--qlever-source',
        qleverSource,
        '--patch',
        defaultGraphPatchPath,
      ], { stdio: 'pipe' });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('routes PathSearch constant endpoints through the physical dictionary', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'xpod-qlever-path-search-patch-'));
    try {
      const qleverSource = path.join(root, 'qlever');
      const queryPlannerPath = path.join(qleverSource, 'src/engine/QueryPlanner.cpp');
      await mkdir(path.dirname(queryPlannerPath), { recursive: true });
      const fixture = `${'\n'.repeat(3272)}// _______________________________________________________________
void QueryPlanner::GraphPatternPlanner::visitPathSearch(
    parsedQuery::PathQuery& pathQuery) {
  auto config = pathQuery.toPathSearchConfiguration(planner_._qec->getIndex());

`;
      await writeFile(queryPlannerPath, fixture, 'utf8');

      execFileSync('node', [
        patchScript,
        '--qlever-source',
        qleverSource,
        '--patch',
        pathSearchPatchPath,
        '--apply',
      ], { stdio: 'pipe' });

      const patched = await readFile(queryPlannerPath, 'utf8');
      expect(patched).toContain(
        'physicalPathSearchConfigurationFromContext(*qec_, pathQuery)',
      );
      execFileSync('node', [
        patchScript,
        '--qlever-source',
        qleverSource,
        '--patch',
        pathSearchPatchPath,
      ], { stdio: 'pipe' });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
