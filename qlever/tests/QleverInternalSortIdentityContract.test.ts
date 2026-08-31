import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'bun:test';

const repoRoot = path.resolve(__dirname, '../..');
const patchScript = path.join(repoRoot, 'qlever/scripts/check-qlever-upstream-patches.cjs');
const seriesPath = path.join(repoRoot, 'qlever/patches/series');
const adapterCmakePath = path.join(repoRoot, 'qlever/qlever_adapter/CMakeLists.txt');
const orderByPatchPath = path.join(
  repoRoot,
  'qlever/patches/qlever-orderby-physical-comparator.patch',
);

const upstreamSortFixture = `// Copyright 2015 - 2026 The QLever Authors

#include "engine/Sort.h"
#include "index/IdTableUtils.h"

Result Sort::computeResultInMemory(IdTable idTable,
                                   LocalVocab localVocab) const {
  IdTableUtils::sort(idTable, sortColumnIndices_);
  return {std::move(idTable), resultSortedOn(), std::move(localVocab)};
}
`;

const semanticInternalSortFixture = `// Copyright 2015 - 2026 The QLever Authors

#include "engine/Sort.h"
#include "XpodQleverPhysicalValueIdContextBridge.hpp"
#include "index/IdTableUtils.h"

Result Sort::computeResultInMemory(IdTable idTable,
                                   LocalVocab localVocab) const {
  auto comparison = [this](const auto& row1, const auto& row2) {
    return comparePhysicalValueIds(
      getExecutionContext()->xpodPhysicalIndex(), row1[0], row2[0]);
  };
  IdTableUtils::sort<0>(&idTable, comparison);
  return {std::move(idTable), resultSortedOn(), std::move(localVocab)};
}
`;

async function writeSortFixture(source: string): Promise<{
  root: string;
  qleverSource: string;
}> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'xpod-qlever-sort-contract-'));
  const qleverSource = path.join(root, 'qlever');
  const sourcePath = path.join(qleverSource, 'src/engine/Sort.cpp');
  await mkdir(path.dirname(sourcePath), { recursive: true });
  await writeFile(sourcePath, source, 'utf8');
  return { root, qleverSource };
}

function checkInternalSort(qleverSource: string): void {
  execFileSync('node', [
    patchScript,
    '--qlever-source',
    qleverSource,
    '--check-internal-sort-identity',
  ], { stdio: 'pipe' });
}

describe('QLever internal Sort identity contract', () => {
  it('keeps structural Sort on stable ValueId identity while OrderBy owns RDF semantics', async () => {
    const [series, adapterCmake, orderByPatch] = await Promise.all([
      readFile(seriesPath, 'utf8'),
      readFile(adapterCmakePath, 'utf8'),
      readFile(orderByPatchPath, 'utf8'),
    ]);

    expect(series).not.toContain('qlever-sort-physical-comparator.patch');
    expect(adapterCmake).toContain('IdTableUtils::sort(idTable, sortColumnIndices_);');
    expect(adapterCmake).not.toContain('Xpod Sort physical comparator overlay');
    expect(adapterCmake).not.toContain('IdTableUtils::sort<I>(&idTable, comparison)');
    expect(orderByPatch).toContain('comparePhysicalValueIds');
  });

  it('accepts the upstream identity sort used by Join and other structural operators', async () => {
    const { root, qleverSource } = await writeSortFixture(upstreamSortFixture);
    try {
      expect(() => checkInternalSort(qleverSource)).not.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rejects RDF-semantic comparison inside internal Sort before compiling QLever', async () => {
    const { root, qleverSource } = await writeSortFixture(semanticInternalSortFixture);
    try {
      expect(() => checkInternalSort(qleverSource)).toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
