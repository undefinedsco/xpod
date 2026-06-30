import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(__dirname, '../..');
const patchScript = path.join(repoRoot, 'scripts/check-qlever-upstream-patches.cjs');
const patchPath = path.join(
  repoRoot,
  'native/postgres/qlever_adapter/patches/qlever-filter-physical-bounded-expression.patch',
);

const upstreamFilterFixture = `#include "engine/Filter.h"

#include <sstream>

#include "engine/QueryExecutionTree.h"
#include "engine/sparqlExpressions/SparqlExpression.h"

Result Filter::computeResult(bool requestLaziness) {
  std::shared_ptr<const Result> subRes = _subtree->getResult(true);
  checkCancellation();

  if (subRes->isFullyMaterialized()) {
    IdTable result = filterIdTable(subRes->sortedBy(), subRes->idTableView());
    return {std::move(result), resultSortedOn(), subRes->getSharedLocalVocab()};
  }

  if (requestLaziness) {
    return {Result::LazyResult{}, subRes->sortedBy()};
  }

  size_t width = getSubtree().get()->getResultWidth();
  IdTable result{width, getExecutionContext()->getAllocator()};
  return {std::move(result), resultSortedOn(), LocalVocab{}};
}
`;

describe('QLever upstream Filter patch asset', () => {
  it('applies to Filter computeResult so bounded expressions can use Xpod physical term ids', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'xpod-qlever-filter-patch-'));
    try {
      const qleverSource = path.join(root, 'qlever');
      const sourcePath = path.join(qleverSource, 'src/engine/Filter.cpp');
      await mkdir(path.dirname(sourcePath), { recursive: true });
      await writeFile(sourcePath, upstreamFilterFixture, 'utf8');

      execFileSync('node', [
        patchScript,
        '--qlever-source',
        qleverSource,
        '--patch',
        patchPath,
        '--apply',
      ], { stdio: 'pipe' });

      const patched = await readFile(sourcePath, 'utf8');
      expect(patched).toContain('"XpodQleverPhysicalFilterContextBridge.hpp"');
      expect(patched).toContain('xpod::qlever::physicalFilterResultFromContext');
      expect(patched).toContain('xpodFilter.status == XPOD_RDF_STATUS_OK');
      expect(patched).toContain('return std::move(xpodFilter.result);');
      expect(patched).toContain('filterIdTable(subRes->sortedBy(), subRes->idTableView())');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('accepts an already patched Filter source as valid', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'xpod-qlever-filter-patched-'));
    try {
      const qleverSource = path.join(root, 'qlever');
      const sourcePath = path.join(qleverSource, 'src/engine/Filter.cpp');
      await mkdir(path.dirname(sourcePath), { recursive: true });
      await writeFile(sourcePath, upstreamFilterFixture, 'utf8');

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

  it('does not fail closed to the bridge fallback for bounded Filter modifiers', async () => {
    const bridge = await readFile(
      path.join(repoRoot, 'native/postgres/qlever_adapter/src/XpodQleverBridge.cpp'),
      'utf8',
    );

    expect(bridge).not.toContain('hasBridgeTermFilterModifier');
  });
});
