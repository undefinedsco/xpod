import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'bun:test';

const repoRoot = path.resolve(__dirname, '../..');
const patchScript = path.join(repoRoot, 'qlever/scripts/check-qlever-upstream-patches.cjs');
const patchPath = path.join(
  repoRoot,
  'qlever/patches/qlever-sort-physical-comparator.patch',
);

const upstreamSortFixture = `// Copyright 2015 - 2026 The QLever Authors

#include "engine/Sort.h"
#include "engine/CallFixedSize.h"
#include "engine/QueryExecutionTree.h"
#include "engine/idTable/CompressedExternalIdTable.h"
#include "global/RuntimeParameters.h"
#include "index/ExternalSortFunctors.h"
#include "index/IdTableUtils.h"
#include "util/Algorithm.h"
#include "util/Random.h"

Result Sort::computeResultInMemory(IdTable idTable,
                                   LocalVocab localVocab) const {
  runtimeInfo().addDetail("is-external", "false");

  getExecutionContext()->getSortPerformanceEstimator().throwIfEstimateTooLong(
      idTable.numRows(), idTable.numColumns(), deadline_, "Sort operation");

  IdTableUtils::sort(idTable, sortColumnIndices_);

  // Don't report missed timeout check because the in-memory sort is currently
  // not cancellable.
  cancellationHandle_->resetWatchDogState();
  checkCancellation();

  return {std::move(idTable), resultSortedOn(), std::move(localVocab)};
}
`;

describe('QLever upstream Sort patch asset', () => {
  it('uses the physical backend comparator for internal in-memory sorts', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'xpod-qlever-sort-patch-'));
    try {
      const qleverSource = path.join(root, 'qlever');
      const sourcePath = path.join(qleverSource, 'src/engine/Sort.cpp');
      await mkdir(path.dirname(sourcePath), { recursive: true });
      await writeFile(sourcePath, upstreamSortFixture, 'utf8');

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
      expect(patched).toContain('"global/ValueIdComparators.h"');
      expect(patched).toContain('comparePhysicalValueIds(');
      expect(patched).toContain('getExecutionContext()->xpodPhysicalIndex()');
      expect(patched).toContain('getExecutionContext()->getLocalVocabContext()');
      expect(patched).toContain('valueIdComparators::compareIds<');
      expect(patched).toContain('IdTableUtils::sort<I>(&idTable, comparison)');
      expect(patched).not.toContain('IdTableUtils::sort(idTable, sortColumnIndices_);');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('accepts an already patched Sort source as valid', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'xpod-qlever-sort-patched-'));
    try {
      const qleverSource = path.join(root, 'qlever');
      const sourcePath = path.join(qleverSource, 'src/engine/Sort.cpp');
      await mkdir(path.dirname(sourcePath), { recursive: true });
      await writeFile(sourcePath, upstreamSortFixture, 'utf8');

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
