import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(__dirname, '../..');
const patchScript = path.join(repoRoot, 'scripts/check-qlever-upstream-patches.cjs');
const patchPath = path.join(
  repoRoot,
  'native/postgres/qlever_adapter/patches/qlever-text-indexscan-entity-physical-text-search.patch',
);

const upstreamTextIndexScanForEntityFixture = `// Copyright 2023, University of Freiburg,
//                  Chair of Algorithms and Data Structures.
//  Author: Nick Göckel <nick.goeckel@students.uni-freiburg.de>

#include "engine/TextIndexScanForEntity.h"

// _____________________________________________________________________________
Result TextIndexScanForEntity::computeResult(
    [[maybe_unused]] bool requestLaziness) {
  std::ostringstream oss;
  oss << config_;
  runtimeInfo().addDetail("text-index-scan-for-entity-config", oss.str());
  IdTable idTable = getExecutionContext()->getIndex().getEntityMentionsForWord(
      config_.word_, getExecutionContext()->getAllocator());

  std::vector<ColumnIndex> cols{0};
  if (hasFixedEntity()) {
    auto beginErase = ql::ranges::remove_if(idTable, [this](const auto& row) {
      return row[1].getVocabIndex() != getVocabIndexOfFixedEntity();
    });
    idTable.erase(beginErase.begin(), idTable.end());
  } else {
    cols.push_back(1);
  }
  if (config_.scoreVar_.has_value()) {
    cols.push_back(2);
  }
  idTable.setColumnSubset(cols);

  if (hasFixedEntity()) {
    runtimeInfo().addDetail("fixed entity: ", fixedEntity());
  } else {
    runtimeInfo().addDetail("entity var: ", entityVariable().name());
  }
  runtimeInfo().addDetail("word: ", config_.word_);

  return {std::move(idTable), resultSortedOn(), LocalVocab{}};
}

size_t TextIndexScanForEntity::getCostEstimate() {
  if (hasFixedEntity()) {
    return 2 * getExecutionContext()->getIndex().getSizeOfTextBlocksSum(
                   config_.word_, TextScanMode::EntityScan);
  } else {
    return getExecutionContext()->getIndex().getSizeOfTextBlocksSum(
        config_.word_, TextScanMode::EntityScan);
  }
}

uint64_t TextIndexScanForEntity::getSizeEstimateBeforeLimit() {
  if (hasFixedEntity()) {
    return static_cast<uint64_t>(
        getExecutionContext()->getIndex().getAverageNofEntityContexts());
  } else {
    return getExecutionContext()->getIndex().getSizeOfTextBlocksSum(
        config_.word_, TextScanMode::EntityScan);
  }
}

bool TextIndexScanForEntity::knownEmptyResult() {
  return getExecutionContext()->getIndex().getSizeOfTextBlocksSum(
             config_.word_, TextScanMode::EntityScan) == 0;
}
`;

describe('QLever upstream TextIndexScanForEntity patch asset', () => {
  it('applies to the upstream-shaped TextIndexScanForEntity source and avoids QLever entity postings when Xpod index is present', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'xpod-qlever-text-entity-patch-'));
    try {
      const qleverSource = path.join(root, 'qlever');
      const sourcePath = path.join(qleverSource, 'src/engine/TextIndexScanForEntity.cpp');
      await mkdir(path.dirname(sourcePath), { recursive: true });
      await writeFile(sourcePath, upstreamTextIndexScanForEntityFixture, 'utf8');

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
      expect(patched).toContain('xpod::qlever::textEntityResultFromContext');
      expect(patched).toContain('xpod::qlever::textEntitySizeEstimateFromContext');
      expect(patched).toContain('xpodText.status == XPOD_RDF_STATUS_OK');
      expect(patched).toContain('return std::move(xpodText.result);');
      expect(patched).toContain('getEntityMentionsForWord');
      expect(patched).toContain('getAverageNofEntityContexts');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('accepts an already patched TextIndexScanForEntity source as valid', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'xpod-qlever-text-entity-patched-'));
    try {
      const qleverSource = path.join(root, 'qlever');
      const sourcePath = path.join(qleverSource, 'src/engine/TextIndexScanForEntity.cpp');
      await mkdir(path.dirname(sourcePath), { recursive: true });
      await writeFile(sourcePath, upstreamTextIndexScanForEntityFixture, 'utf8');

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
