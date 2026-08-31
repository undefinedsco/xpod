import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'bun:test';

const repoRoot = path.resolve(__dirname, '../..');
const adapterCmakePath = path.join(repoRoot, 'qlever/qlever_adapter/CMakeLists.txt');
const patchDirectory = path.join(repoRoot, 'qlever/patches');
const seriesPath = path.join(patchDirectory, 'series');

const upstreamContracts = new Map([
  [
    'src/engine/Sort.cpp',
    new Set(['IdTableUtils::sort(idTable, sortColumnIndices_);']),
  ],
]);

function parseOverlayRequirements(cmake: string): Array<{
  relativeSource: string;
  token: string;
  label: string;
}> {
  const pattern = /xpod_qlever_require_overlay_token\(\s*"([^"]+)"\s*"([^"]+)"\s*"([^"]+)"\)/g;
  return [...cmake.matchAll(pattern)].map((match) => ({
    relativeSource: match[1],
    token: match[2],
    label: match[3],
  }));
}

function collectPatchedSources(patches: string[]): Map<string, string> {
  const sources = new Map<string, string[]>();
  for (const patch of patches) {
    let currentSource: string | undefined;
    for (const line of patch.split(/\r?\n/)) {
      if (line.startsWith('+++ b/')) {
        currentSource = line.slice('+++ b/'.length).split('\t', 1)[0];
        if (!sources.has(currentSource)) sources.set(currentSource, []);
        continue;
      }
      if (line.startsWith('diff --git ') || line.startsWith('--- a/')) {
        currentSource = undefined;
        continue;
      }
      if (currentSource && (line.startsWith('+') || line.startsWith(' '))) {
        sources.get(currentSource)?.push(line.slice(1));
      }
    }
  }
  return new Map(
    [...sources].map(([relativeSource, lines]) => [relativeSource, lines.join('\n')]),
  );
}

function findStaleRequirements(cmake: string, patches: string[]) {
  const patchedSources = collectPatchedSources(patches);
  return parseOverlayRequirements(cmake).filter(({ relativeSource, token }) => {
    const isExplicitUpstreamContract = upstreamContracts.get(relativeSource)?.has(token) ?? false;
    return !isExplicitUpstreamContract && !patchedSources.get(relativeSource)?.includes(token);
  });
}

describe('QLever adapter overlay contract', () => {
  it('keeps every CMake source requirement backed by an active patch or explicit upstream contract', async () => {
    const [cmake, series] = await Promise.all([
      readFile(adapterCmakePath, 'utf8'),
      readFile(seriesPath, 'utf8'),
    ]);
    const patchNames = series
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith('#'));
    const patches = await Promise.all(
      patchNames.map((patchName) => readFile(path.join(patchDirectory, patchName), 'utf8')),
    );
    const requirements = parseOverlayRequirements(cmake);
    expect(requirements.length).toBeGreaterThan(0);
    expect(findStaleRequirements(cmake, patches)).toEqual([]);
  });

  it('rejects a token supplied only by a patch for a different source file', () => {
    const staleCmake = `xpod_qlever_require_overlay_token(
      "src/engine/Sort.cpp"
      "comparePhysicalValueIds"
      "stale Sort semantic comparator")`;
    const orderByOnlyPatch = `--- a/src/engine/OrderBy.cpp
+++ b/src/engine/OrderBy.cpp
@@ -1 +1,2 @@
 existingOrderByCode();
+comparePhysicalValueIds();`;

    expect(findStaleRequirements(staleCmake, [orderByOnlyPatch])).toEqual([
      {
        relativeSource: 'src/engine/Sort.cpp',
        token: 'comparePhysicalValueIds',
        label: 'stale Sort semantic comparator',
      },
    ]);
  });
});
