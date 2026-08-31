import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'bun:test';

const repoRoot = path.resolve(__dirname, '../..');
const patchScript = path.join(repoRoot, 'qlever/scripts/check-qlever-upstream-patches.cjs');
const patchPath = path.join(
  repoRoot,
  'qlever/patches/qlever-groupby-physical-disable-native-optimization.patch',
);

const upstreamGroupByFixture = `#include "engine/GroupByImpl.h"
#include "engine/IndexScan.h"
#include "engine/Join.h"

Result GroupByImpl::computeResult(bool requestLaziness) {
  AD_LOG_DEBUG << "GroupBy result computation..." << std::endl;

  if (auto idTable = computeOptimizedGroupByIfPossible()) {
    // Note: The optimized group bys currently all include index scans and thus
    // can never produce local vocab entries. If this should ever change, then
    // we also have to take care of the local vocab here.
    return {std::move(idTable).value(), resultSortedOn(), LocalVocab{}};
  }

  std::vector<Aggregate> aggregates;
  return Result{IdTable{0, getExecutionContext()->getAllocator()}, resultSortedOn(), LocalVocab{}};
}
`;

describe('QLever upstream GroupBy patch asset', () => {
  it('applies to GroupBy so Xpod-backed contexts skip QLever-native index optimizations', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'xpod-qlever-groupby-patch-'));
    try {
      const qleverSource = path.join(root, 'qlever');
      const sourcePath = path.join(qleverSource, 'src/engine/GroupByImpl.cpp');
      await mkdir(path.dirname(sourcePath), { recursive: true });
      await writeFile(sourcePath, upstreamGroupByFixture, 'utf8');

      execFileSync('node', [
        patchScript,
        '--qlever-source',
        qleverSource,
        '--patch',
        patchPath,
        '--apply',
      ], { stdio: 'pipe' });

      const patched = await readFile(sourcePath, 'utf8');
      expect(patched).toContain('"XpodQleverPhysicalIndexScanContextBridge.hpp"');
      expect(patched).toContain('xpod::qlever::physicalIndexFromContext(*getExecutionContext()) == nullptr');
      expect(patched).toContain('computeOptimizedGroupByIfPossible()');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('accepts an already patched GroupBy source as valid', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'xpod-qlever-groupby-patched-'));
    try {
      const qleverSource = path.join(root, 'qlever');
      const sourcePath = path.join(qleverSource, 'src/engine/GroupByImpl.cpp');
      await mkdir(path.dirname(sourcePath), { recursive: true });
      await writeFile(sourcePath, upstreamGroupByFixture, 'utf8');

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
