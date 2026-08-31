import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'bun:test';

const repoRoot = path.resolve(__dirname, '../..');
const patchScript = path.join(repoRoot, 'qlever/scripts/check-qlever-upstream-patches.cjs');
const patchPath = path.join(
  repoRoot,
  'qlever/patches/qlever-text-indexscan-physical-text-search.patch',
);

const upstreamTextIndexScanForWordFixture = `// Copyright 2023, University of Freiburg,
//                  Chair of Algorithms and Data Structures.
//  Author: Nick Göckel <nick.goeckel@students.uni-freiburg.de>

#include "engine/TextIndexScanForWord.h"

#include "backports/StartsWithAndEndsWith.h"

Result TextIndexScanForWord::computeResult(
    [[maybe_unused]] bool requestLaziness) {
  std::ostringstream oss;
  oss << config_;
  runtimeInfo().addDetail("text-index-scan-for-word-config", oss.str());
  IdTable idTable = getExecutionContext()->getIndex().getWordPostingsForTerm(
      config_.word_, getExecutionContext()->getAllocator());

  std::vector<ColumnIndex> cols{0};
  if (config_.isPrefix_) {
    cols.push_back(1);
  }
  if (config_.scoreVar_.has_value()) {
    cols.push_back(2);
  }
  idTable.setColumnSubset(cols);

  runtimeInfo().addDetail("word: ", config_.word_);

  return {std::move(idTable), resultSortedOn(), LocalVocab{}};
}

size_t TextIndexScanForWord::getCostEstimate() {
  return getExecutionContext()->getIndex().getSizeOfTextBlocksSum(
      config_.word_, TextScanMode::WordScan);
}

uint64_t TextIndexScanForWord::getSizeEstimateBeforeLimit() {
  return getExecutionContext()->getIndex().getSizeOfTextBlocksSum(
      config_.word_, TextScanMode::WordScan);
}
`;

describe('QLever upstream TextIndexScanForWord patch asset', () => {
  it('applies to the upstream-shaped TextIndexScanForWord source and avoids QLever postings when Xpod index is present', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'xpod-qlever-text-word-patch-'));
    try {
      const qleverSource = path.join(root, 'qlever');
      const sourcePath = path.join(qleverSource, 'src/engine/TextIndexScanForWord.cpp');
      await mkdir(path.dirname(sourcePath), { recursive: true });
      await writeFile(sourcePath, upstreamTextIndexScanForWordFixture, 'utf8');

      execFileSync('node', [
        patchScript,
        '--qlever-source',
        qleverSource,
        '--patch',
        patchPath,
        '--apply',
      ], { stdio: 'pipe' });

      const patched = await readFile(sourcePath, 'utf8');
      expect(patched).toContain('"XpodQleverPhysicalTextIndexScanContextBridge.hpp"');
      expect(patched).toContain('xpod::qlever::physicalIndexFromContext(*getExecutionContext())');
      expect(patched).toContain('xpod::qlever::textWordResultFromContext');
      expect(patched).toContain('xpod::qlever::textWordSizeEstimateFromContext');
      expect(patched).toContain('xpodText.status == XPOD_RDF_STATUS_OK');
      expect(patched).toContain('return std::move(xpodText.result);');
      expect(patched).toContain('getWordPostingsForTerm');
      expect(patched).toContain('getSizeOfTextBlocksSum');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('accepts an already patched TextIndexScanForWord source as valid', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'xpod-qlever-text-word-patched-'));
    try {
      const qleverSource = path.join(root, 'qlever');
      const sourcePath = path.join(qleverSource, 'src/engine/TextIndexScanForWord.cpp');
      await mkdir(path.dirname(sourcePath), { recursive: true });
      await writeFile(sourcePath, upstreamTextIndexScanForWordFixture, 'utf8');

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
