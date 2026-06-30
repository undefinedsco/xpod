import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(__dirname, '../..');
const patchScript = path.join(repoRoot, 'scripts/check-qlever-upstream-patches.cjs');
const patchPath = path.join(
  repoRoot,
  'native/postgres/qlever_adapter/patches/qlever-queryexecutioncontext-physical-index.patch',
);

const makePadding = (prefix: string, count: number) =>
  Array.from({ length: count }, (_, index) => `  void ${prefix}${index}();`).join('\n');

const upstreamQueryExecutionContextFixture = `#ifndef QLEVER_SRC_ENGINE_QUERYEXECUTIONCONTEXT_H
#define QLEVER_SRC_ENGINE_QUERYEXECUTIONCONTEXT_H

#include <gtest/gtest_prod.h>

#include <chrono>
#include <memory>
#include <string>

#include "backports/three_way_comparison.h"
#include "engine/QueryPlanningCostFactors.h"
#include "engine/Result.h"
#include "engine/RuntimeInformation.h"
#include "engine/SortPerformanceEstimator.h"
#include "global/Id.h"
#include "index/DeltaTriples.h"
#include "index/Index.h"
#include "util/Cache.h"
#include "util/ConcurrentCache.h"

class QueryExecutionContext {
 public:
${makePadding('publicPadding', 90)}

  [[nodiscard]] const Index& getIndex() const { return *_index; }

  const LocatedTriplesState& locatedTriplesState() const {
    AD_CORRECTNESS_CHECK(locatedTriplesSharedState_ != nullptr);
    return *locatedTriplesSharedState_;
  }

 private:
${makePadding('privatePadding', 82)}

  // Shared pointer to the \`Index\` to ensure that it stays alive as long as
  // this context is alive.
  std::shared_ptr<const Index> _index;

  // When the \`QueryExecutionContext\` is constructed, get a stable read-only
  // snapshot of the current (located) delta triples. These can then be used
  // by the respective query without interfering with further incoming
};

#endif
`;

describe('QLever upstream QueryExecutionContext patch asset', () => {
  it('applies a physical-index injection point to the upstream-shaped context header', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'xpod-qlever-qec-patch-'));
    try {
      const qleverSource = path.join(root, 'qlever');
      const qecPath = path.join(qleverSource, 'src/engine/QueryExecutionContext.h');
      await mkdir(path.dirname(qecPath), { recursive: true });
      await writeFile(qecPath, upstreamQueryExecutionContextFixture, 'utf8');

      execFileSync('node', [
        patchScript,
        '--qlever-source',
        qleverSource,
        '--patch',
        patchPath,
        '--apply',
      ], { stdio: 'pipe' });

      const patched = await readFile(qecPath, 'utf8');
      expect(patched).toContain('"XpodQleverPhysicalIndex.hpp"');
      expect(patched).toContain('setXpodPhysicalIndex');
      expect(patched).toContain('xpodPhysicalIndex() const');
      expect(patched).toContain('std::optional<xpod::qlever::XpodQleverPhysicalIndex>');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
