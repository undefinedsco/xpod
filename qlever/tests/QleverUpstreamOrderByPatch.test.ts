import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'bun:test';

const repoRoot = path.resolve(__dirname, '../..');
const patchScript = path.join(repoRoot, 'qlever/scripts/check-qlever-upstream-patches.cjs');
const patchPath = path.join(
  repoRoot,
  'qlever/patches/qlever-orderby-physical-comparator.patch',
);

const upstreamOrderByFixture = `// Copyright 2015, University of Freiburg,

#include "engine/OrderBy.h"

#include <sstream>

#include "engine/CallFixedSize.h"
#include "engine/QueryExecutionTree.h"
#include "global/RuntimeParameters.h"
#include "global/ValueIdComparators.h"
#include "index/IdTableUtils.h"
#include "util/TransparentFunctors.h"

Result OrderBy::computeResult([[maybe_unused]] bool requestLaziness) {
  std::shared_ptr<const Result> subRes = subtree_->getResult();
  IdTable idTable = subRes->cloneIdTable();
  size_t width = idTable.numColumns();

  // Return true iff \`rowA\` comes before \`rowB\` in the sort order specified by
  // \`sortIndices_\`.
  auto comparison = [this](const auto& row1, const auto& row2) -> bool {
    for (auto& [column, isDescending] : sortIndices_) {
      if (row1[column] == row2[column]) {
        continue;
      }
      bool isLessThan =
          toBoolNotUndef(valueIdComparators::compareIds<
                         valueIdComparators::ComparisonForIncompatibleTypes::
                             CompareByType>(
              row1[column], row2[column], valueIdComparators::Comparison::LT));
      return isLessThan != isDescending;
    }
    return false;
  };

  ad_utility::callFixedSizeVi(width, [&idTable, &comparison](auto I) {
    IdTableUtils::sort<I>(&idTable, comparison);
  });
  return {std::move(idTable), resultSortedOn(), subRes->getSharedLocalVocab()};
}
`;

describe('QLever upstream OrderBy patch asset', () => {
  it('uses the physical backend comparator for opaque term ids before QLever fallback ordering', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'xpod-qlever-orderby-patch-'));
    try {
      const qleverSource = path.join(root, 'qlever');
      const sourcePath = path.join(qleverSource, 'src/engine/OrderBy.cpp');
      await mkdir(path.dirname(sourcePath), { recursive: true });
      await writeFile(sourcePath, upstreamOrderByFixture, 'utf8');

      execFileSync('node', [
        patchScript,
        '--qlever-source',
        qleverSource,
        '--patch',
        patchPath,
        '--apply',
      ], { stdio: 'pipe' });

      const patched = await readFile(sourcePath, 'utf8');
      expect(patched).toContain('"XpodQleverPhysicalValueIdContextBridge.hpp"');
      expect(patched).toContain('comparePhysicalValueIds(');
      expect(patched).toContain('getExecutionContext()->xpodPhysicalIndex()');
      expect(patched).toContain('getExecutionContext()->getLocalVocabContext()');
      expect(patched).toContain('subRes->localVocab()');
      expect(patched).toContain('auto comparison = [this, &subRes]');
      expect(patched).toContain('valueIdComparators::compareIds<');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('accepts an already patched OrderBy source as valid', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'xpod-qlever-orderby-patched-'));
    try {
      const qleverSource = path.join(root, 'qlever');
      const sourcePath = path.join(qleverSource, 'src/engine/OrderBy.cpp');
      await mkdir(path.dirname(sourcePath), { recursive: true });
      await writeFile(sourcePath, upstreamOrderByFixture, 'utf8');

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
