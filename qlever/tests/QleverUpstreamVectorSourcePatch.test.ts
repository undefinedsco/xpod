import { execFileSync } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'bun:test';

const repoRoot = path.resolve(__dirname, '../..');
const patchPath = path.join(
  repoRoot,
  'qlever/patches/qlever-queryplanner-physical-vector-source.patch',
);
const seriesPath = path.join(repoRoot, 'qlever/patches/series');
const patchCheckerPath = path.join(
  repoRoot,
  'qlever/scripts/check-qlever-upstream-patches.cjs',
);

const upstreamQueryPlannerFixture = `// Copyright 2024, University of Freiburg,
// Chair of Algorithms and Data Structures.

#include "engine/QueryPlanner.h"

#include <memory>

#include "engine/ExternalValues.h"

namespace p = parsedQuery;
namespace {

using SubtreePlan = QueryPlanner::SubtreePlan;

template <typename Operation, typename... Args>
SubtreePlan makeSubtreePlan(QueryExecutionContext* qec, Args&&... args) {
  return {qec, std::make_shared<Operation>(qec, AD_FWD(args)...)};
}

template <typename Op>
SubtreePlan makeSubtreePlan(std::shared_ptr<Op> operation) {
  auto* qec = operation->getExecutionContext();
  return {qec, std::move(operation)};
}

}  // namespace

// _______________________________________________________________
void QueryPlanner::GraphPatternPlanner::visitExternalValues(
    const parsedQuery::ExternalValuesQuery& externalValuesQuery) {
  auto externalValues =
      std::make_shared<ExternalValues>(qec_, externalValuesQuery);
  auto candidate = makeSubtreePlan<ExternalValues>(std::move(externalValues));
  visitGroupOptionalOrMinus(std::vector{std::move(candidate)});
}
`;

async function writeFixture(
  root: string,
  source = upstreamQueryPlannerFixture,
): Promise<string> {
  const sourcePath = path.join(root, 'src/engine/QueryPlanner.cpp');
  await mkdir(path.dirname(sourcePath), { recursive: true });
  await writeFile(sourcePath, source, 'utf8');
  execFileSync('git', [ 'init', '-q' ], { cwd: root, stdio: 'pipe' });
  return sourcePath;
}

describe('QLever upstream QueryPlanner vector-source patch asset', () => {
  it('is listed, only patches QueryPlanner.cpp, and dispatches only the reserved ExternalValues source', async () => {
    await access(patchPath);

    const patch = await readFile(patchPath, 'utf8');
    const series = (await readFile(seriesPath, 'utf8')).split(/\r?\n/);
    const patchChecker = await readFile(patchCheckerPath, 'utf8');
    expect(series).toContain('qlever-queryplanner-physical-vector-source.patch');
    expect(patchChecker).toContain(
      "path.join(patchesRoot, 'qlever-queryplanner-physical-vector-source.patch')",
    );

    const patchedFiles = [
      ...patch.matchAll(/^diff --git a\/(.+) b\/(.+)$/gm),
    ].map((match) => [ match[1], match[2] ]);
    expect(patchedFiles).toEqual([
      [ 'src/engine/QueryPlanner.cpp', 'src/engine/QueryPlanner.cpp' ],
    ]);
    expect(patch).toContain('#include "XpodQleverVectorIndexScan.hpp"');

    const root = await mkdtemp(
      path.join(os.tmpdir(), 'xpod-qlever-vector-source-patch-'),
    );
    try {
      const sourcePath = await writeFixture(root);
      execFileSync('git', [ 'apply', '--check', patchPath ], {
        cwd: root,
        stdio: 'pipe',
      });
      execFileSync('git', [ 'apply', patchPath ], {
        cwd: root,
        stdio: 'pipe',
      });

      const patched = await readFile(sourcePath, 'utf8');
      expect(patched).toContain('#include "XpodQleverVectorIndexScan.hpp"');
      const dispatch = `if (xpod::qlever::XpodQleverVectorIndexScan::canHandle(
          qec_, externalValuesQuery)) {
    candidate = makeSubtreePlan<xpod::qlever::XpodQleverVectorIndexScan>(
        qec_, externalValuesQuery);
  } else {
    candidate =
        makeSubtreePlan<ExternalValues>(qec_, externalValuesQuery);
  }`;
      expect(patched).toContain(dispatch);
      expect(patched.match(/XpodQleverVectorIndexScan::canHandle/g)).toHaveLength(1);
      expect(patched).not.toContain(
        'std::make_shared<ExternalValues>(qec_, externalValuesQuery)',
      );
      expect(patched).not.toContain('externalValuesQuery.name_ ==');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rejects a clean source that no longer exposes the ExternalValues dispatch marker', async () => {
    await access(patchPath);

    const root = await mkdtemp(
      path.join(os.tmpdir(), 'xpod-qlever-vector-source-marker-'),
    );
    try {
      await writeFixture(
        root,
        upstreamQueryPlannerFixture.replace(
          'visitExternalValues(',
          'visitRenamedExternalValues(',
        ),
      );
      expect(() => execFileSync('git', [ 'apply', '--check', patchPath ], {
        cwd: root,
        stdio: 'pipe',
      })).toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
