import { execFileSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'bun:test';

const repoRoot = path.resolve(__dirname, '../..');
const adapterSourceDirectory = path.join(repoRoot, 'qlever/qlever_adapter/src');

function hasCxx(): boolean {
  try {
    execFileSync('/usr/bin/env', ['c++', '--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

describe('QLever physical term syntax', () => {
  it('rejects residual boolean expressions in IRI and literal suffix tokens', async () => {
    expect(hasCxx(), 'c++ compiler is required for the physical term syntax check').toBe(true);
    const root = await mkdtemp(path.join(os.tmpdir(), 'xpod-qlever-term-syntax-'));
    const binary = path.join(root, 'term-syntax');
    try {
      execFileSync('c++', [
        '-std=c++17',
        '-Wall',
        '-Wextra',
        '-Werror',
        '-I', adapterSourceDirectory,
        '-x', 'c++',
        '-',
        '-o', binary,
      ], {
        input: `
#include <string_view>
#include "XpodQleverPhysicalTermSyntax.hpp"

int main() {
  using namespace xpod::qlever;
  if (!physicalIriRefValueIsValid("urn:o")) return 1;
  if (physicalIriRefValueIsValid("urn:tail> || ?o = <urn:o")) return 2;
  if (physicalLanguageFromSuffix("@en-US") != std::string_view{"en-US"}) return 3;
  if (physicalLanguageFromSuffix("@en || ?o = \\"y\\"").has_value()) return 4;
  if (physicalDatatypeIriFromSuffix("^^<urn:t>") != std::string_view{"urn:t"}) return 5;
  if (physicalDatatypeIriFromSuffix(
          "^^<urn:t> || ?o = \\"y\\"^^<urn:t>").has_value()) return 6;
  return 0;
}
`,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      expect(() => execFileSync(binary, [], { stdio: 'pipe' })).not.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
