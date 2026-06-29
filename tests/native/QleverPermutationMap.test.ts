import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(__dirname, '../..');
const mapHeader = path.join(repoRoot, 'native/postgres/qlever_adapter/src/XpodQleverPermutationMap.hpp');

function hasCxx(): boolean {
  try {
    execFileSync('/usr/bin/env', ['c++', '--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

describe('QLever permutation map', () => {
  it('maps QLever triple permutations to Xpod graph-aware physical permutations', async () => {
    expect(hasCxx(), 'c++ compiler is required for native permutation map check').toBe(true);

    const root = await mkdtemp(path.join(os.tmpdir(), 'xpod-qlever-permutation-map-'));
    try {
      const qleverSource = path.join(root, 'qlever');
      await mkdir(path.join(qleverSource, 'src/index'), { recursive: true });
      await writeFile(path.join(qleverSource, 'src/index/Permutation.h'), `
#pragma once
class Permutation {
 public:
  enum struct Enum { PSO, POS, SPO, SOP, OPS, OSP };
};
`, 'utf8');

      const smoke = path.join(root, 'permutation_map_smoke.cpp');
      const binary = path.join(root, 'permutation_map_smoke');
      await writeFile(smoke, `
#include "XpodQleverPermutationMap.hpp"

int main() {
  if (xpod::qlever::toXpodPermutation(Permutation::Enum::PSO) != XPOD_RDF_PERM_PSOG) return 1;
  if (xpod::qlever::toXpodPermutation(Permutation::Enum::POS) != XPOD_RDF_PERM_POSG) return 2;
  if (xpod::qlever::toXpodPermutation(Permutation::Enum::SPO) != XPOD_RDF_PERM_SPOG) return 3;
  if (xpod::qlever::toXpodPermutation(Permutation::Enum::SOP) != XPOD_RDF_PERM_SOPG) return 4;
  if (xpod::qlever::toXpodPermutation(Permutation::Enum::OPS) != XPOD_RDF_PERM_OPSG) return 5;
  if (xpod::qlever::toXpodPermutation(Permutation::Enum::OSP) != XPOD_RDF_PERM_OSPG) return 6;
  if (xpod::qlever::toXpodPermutationCapability(Permutation::Enum::PSO) != XPOD_RDF_PERM_CAP_PSOG) return 7;
  if (xpod::qlever::toXpodPermutationCapability(Permutation::Enum::POS) != XPOD_RDF_PERM_CAP_POSG) return 8;
  if (xpod::qlever::toXpodPermutationCapability(Permutation::Enum::SPO) != XPOD_RDF_PERM_CAP_SPOG) return 9;
  if (xpod::qlever::toXpodPermutationCapability(Permutation::Enum::SOP) != XPOD_RDF_PERM_CAP_SOPG) return 10;
  if (xpod::qlever::toXpodPermutationCapability(Permutation::Enum::OPS) != XPOD_RDF_PERM_CAP_OPSG) return 11;
  if (xpod::qlever::toXpodPermutationCapability(Permutation::Enum::OSP) != XPOD_RDF_PERM_CAP_OSPG) return 12;
  return 0;
}
`, 'utf8');

      execFileSync('c++', [
        '-std=c++17',
        '-Wall',
        '-Wextra',
        '-Werror',
        '-DXPOD_QLEVER_ADAPTER_ENABLE_QLEVER=1',
        '-I', path.dirname(mapHeader),
        '-I', path.join(repoRoot, 'native/postgres/rdf_protocol/include'),
        '-I', path.join(qleverSource, 'src'),
        smoke,
        '-o',
        binary,
      ], { stdio: 'pipe' });
      execFileSync(binary, [], { stdio: 'pipe' });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
