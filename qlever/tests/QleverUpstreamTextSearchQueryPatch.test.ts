import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'bun:test';

const repoRoot = path.resolve(__dirname, '../..');
const patchScript = path.join(repoRoot, 'qlever/scripts/check-qlever-upstream-patches.cjs');
const patchPath = path.join(
  repoRoot,
  'qlever/patches/qlever-text-search-query-physical-fixed-entity.patch',
);

const upstreamTextSearchQueryFixture = `// Copyright 2025, University of Freiburg,
// Chair of Algorithms and Data Structures.
// Author: Felix Meisen (fesemeisen@outlook.de)

#include "parser/TextSearchQuery.h"

#include <absl/strings/str_split.h>

#include "backports/StartsWithAndEndsWith.h"
#include "parser/MagicServiceIriConstants.h"
#include "parser/SparqlTriple.h"

std::variant<Variable, FixedEntity> VarOrFixedEntity::makeEntityVariant(
    const QueryExecutionContext* qec,
    std::variant<Variable, std::string> entity) {
  if (std::holds_alternative<std::string>(entity)) {
    VocabIndex index;
    std::string fixedEntity = std::move(std::get<std::string>(entity));
    bool success = qec->getIndex().getVocab().getId(fixedEntity, &index);
    if (!success) {
      throw std::runtime_error(
          "The entity " + fixedEntity +
          " is not part of the underlying knowledge graph and can "
          "therefore not be used as the object of ql:contains-entity");
    }
    return FixedEntity(std::move(fixedEntity), std::move(index));
  }
  return std::get<Variable>(entity);
};

std::vector<std::variant<TextIndexScanForWordConfiguration,
                         TextIndexScanForEntityConfiguration>>
TextSearchQuery::toConfigs(const QueryExecutionContext* qec) const {
  ad_utility::HashMap<Variable, std::vector<std::string>>
      potentialTermsForTextVar;
  ad_utility::HashMap<Variable, std::string> optTermForTextVar;
  // Get the correct words for entity scans
  for (const auto& [textVar, potentialTerms] : potentialTermsForTextVar) {
    optTermForTextVar[textVar] =
        potentialTerms[qec->getIndex().getIndexOfBestSuitedElTerm(
            potentialTerms)];
  }

  // Second pass to create all configs
  return {};
}
`;

describe('QLever upstream TextSearchQuery patch asset', () => {
  it('applies to fixed-entity validation so Xpod-backed text search does not consult QLever native vocab', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'xpod-qlever-text-query-patch-'));
    try {
      const qleverSource = path.join(root, 'qlever');
      const sourcePath = path.join(qleverSource, 'src/parser/TextSearchQuery.cpp');
      await mkdir(path.dirname(sourcePath), { recursive: true });
      await writeFile(sourcePath, upstreamTextSearchQueryFixture, 'utf8');

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
      expect(patched).toContain('qec != nullptr');
      expect(patched).toContain('xpod::qlever::physicalIndexFromContext(*qec) != nullptr');
      expect(patched).toContain('return FixedEntity(std::move(fixedEntity), VocabIndex{});');
      expect(patched).toContain('getVocab().getId(fixedEntity, &index)');
      expect(patched).toContain('bestPhysicalTextTermIndexFromContext');
      expect(patched).toContain('physicalBestTerm.has_value()');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('accepts an already patched TextSearchQuery source as valid', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'xpod-qlever-text-query-patched-'));
    try {
      const qleverSource = path.join(root, 'qlever');
      const sourcePath = path.join(qleverSource, 'src/parser/TextSearchQuery.cpp');
      await mkdir(path.dirname(sourcePath), { recursive: true });
      await writeFile(sourcePath, upstreamTextSearchQueryFixture, 'utf8');

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
