import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'bun:test';

const repoRoot = path.resolve(__dirname, '../..');
const patchScript = path.join(repoRoot, 'qlever/scripts/check-qlever-upstream-patches.cjs');
const patchPath = path.join(
  repoRoot,
  'qlever/patches/qlever-optionaljoin-physical-disable-prefilter.patch',
);

const upstreamOptionalJoinFixture = `// Copyright 2016, University of Freiburg,
// Chair of Algorithms and Data Structures.
// Author: Björn Buchhold (buchhold@informatik.uni-freiburg.de)
//         Florian Kramer (florian.kramer@netpun.uni-freiburg.de)

#include "engine/OptionalJoin.h"

#include "engine/AddCombinedRowToTable.h"
#include "engine/CallFixedSize.h"
#include "engine/IndexScan.h"

Result OptionalJoin::computeResult(bool requestLaziness) {
  const bool isTwoColumnSpecialOptionalJoin =
      implementation_ == Implementation::OnlyUndefInLastJoinColumnOfLeft &&
      _joinColumns.size() == 2;
  if (getRuntimeParameter<&RuntimeParameters::prefilteredOptionalJoin_>() &&
      (_joinColumns.size() == 1 || isTwoColumnSpecialOptionalJoin)) {
    if (auto indexScan =
            std::dynamic_pointer_cast<IndexScan>(_right->getRootOperation())) {
      return optionalJoinWithIndexScan(_left->getResult(true),
                                       std::move(indexScan), requestLaziness);
    }
  }

  IdTable idTable{getResultWidth(), getExecutionContext()->getAllocator()};
  return {std::move(idTable), resultSortedOn(), LocalVocab{}};
}
`;

describe('QLever upstream OptionalJoin patch asset', () => {
  it('applies to OptionalJoin so physical-index contexts skip block-metadata prefiltered optional join', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'xpod-qlever-optionaljoin-patch-'));
    try {
      const qleverSource = path.join(root, 'qlever');
      const sourcePath = path.join(qleverSource, 'src/engine/OptionalJoin.cpp');
      await mkdir(path.dirname(sourcePath), { recursive: true });
      await writeFile(sourcePath, upstreamOptionalJoinFixture, 'utf8');

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
      expect(patched).toContain('prefilteredOptionalJoin_');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('accepts an already patched OptionalJoin source as valid', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'xpod-qlever-optionaljoin-patched-'));
    try {
      const qleverSource = path.join(root, 'qlever');
      const sourcePath = path.join(qleverSource, 'src/engine/OptionalJoin.cpp');
      await mkdir(path.dirname(sourcePath), { recursive: true });
      await writeFile(sourcePath, upstreamOptionalJoinFixture, 'utf8');

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
