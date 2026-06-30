import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(__dirname, '../..');
const patchScript = path.join(repoRoot, 'scripts/check-qlever-upstream-patches.cjs');
const patchPath = path.join(
  repoRoot,
  'native/postgres/qlever_adapter/patches/qlever-indexscan-physical-lazy-scan.patch',
);

const upstreamIndexScanFixture = String.raw`// Copyright 2015, University of Freiburg,
// Chair of Algorithms and Data Structures.
// Author: Björn Buchhold (buchhold@informatik.uni-freiburg.de)

#include "engine/IndexScan.h"

#include <absl/container/inlined_vector.h>
#include <absl/strings/str_join.h>

#include <sstream>
#include <string>
#include <utility>

#include "engine/MaterializedViews.h"
#include "engine/QueryExecutionTree.h"
#include "engine/VariableToColumnMap.h"
#include "index/IndexImpl.h"
#include "parser/ParsedQuery.h"
#include "util/Exception.h"
#include "util/InputRangeUtils.h"
#include "util/Iterators.h"

using std::string;
using LazyScanMetadata = CompressedRelationReader::LazyScanMetadata;

CompressedRelationReader::IdTableGeneratorInputRange IndexScan::getLazyScan(
    std::optional<std::vector<CompressedBlockMetadata>> blocks) const {
  // If there is a LIMIT or OFFSET clause that constrains the scan
  // (which can happen with an explicit subquery), we cannot use the prefiltered
  // blocks, as we currently have no mechanism to include limits and offsets
  // into the prefiltering (\`std::nullopt\` means \`scan all blocks\`).
  auto filteredBlocks =
      getLimitOffset().isUnconstrained() ? std::move(blocks) : std::nullopt;
  auto lazyScanAllCols = permutation().lazyScan(
      scanSpecAndBlocks_, filteredBlocks, additionalColumns(),
      cancellationHandle_, locatedTriplesState(), getLimitOffset());
  return CompressedRelationReader::IdTableGeneratorInputRange{
      ad_utility::CachingTransformInputRange<
          ad_utility::OwningView<
              CompressedRelationReader::IdTableGeneratorInputRange>,
          decltype(makeApplyColumnSubset()), LazyScanMetadata>{
          std::move(lazyScanAllCols), makeApplyColumnSubset()}};
};
`;

describe('QLever upstream IndexScan patch asset', () => {
  it('applies to the upstream-shaped IndexScan getLazyScan source and preserves QLever fallback', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'xpod-qlever-indexscan-patch-'));
    try {
      const qleverSource = path.join(root, 'qlever');
      const indexScanPath = path.join(qleverSource, 'src/engine/IndexScan.cpp');
      await mkdir(path.dirname(indexScanPath), { recursive: true });
      await writeFile(indexScanPath, upstreamIndexScanFixture, 'utf8');

      execFileSync('node', [
        patchScript,
        '--qlever-source',
        qleverSource,
        '--patch',
        patchPath,
        '--apply',
      ], { stdio: 'pipe' });

      const patched = await readFile(indexScanPath, 'utf8');
      expect(patched).toContain('"XpodQleverPhysicalIndexScanContextBridge.hpp"');
      expect(patched).toContain('xpod::qlever::lazyScanRangeFromQleverScanSpecAndBlocks');
      expect(patched).toContain('xpodLazyScan.status == XPOD_RDF_STATUS_OK');
      expect(patched).toContain('permutation().lazyScan(');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('accepts an already patched IndexScan source as valid', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'xpod-qlever-indexscan-patched-'));
    try {
      const qleverSource = path.join(root, 'qlever');
      const indexScanPath = path.join(qleverSource, 'src/engine/IndexScan.cpp');
      await mkdir(path.dirname(indexScanPath), { recursive: true });
      await writeFile(indexScanPath, upstreamIndexScanFixture, 'utf8');

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
