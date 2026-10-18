import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { buildWithBun } from '../scripts/bun-build-api';
import { apiTestRepoRoot } from './repo-root';

/** Supply real CJS originals at the paths retained by the bundled pack fixture. */
export async function writeApiPackFixture(root: string): Promise<string> {
  const tool = await buildWithBun({ entrypoints: [path.join(apiTestRepoRoot, 'packages/xpod-api/scripts/pack.ts')], target: 'node', format: 'esm' });
  assert(tool.success, String(tool.logs));
  const packageRoot = path.join(root, 'packages/xpod-api');
  mkdirSync(path.join(packageRoot, 'scripts'), { recursive: true });
  for (const name of ['prepare-package-manifest.cjs', 'platform-binaries.cjs']) {
    copyFileSync(path.join(apiTestRepoRoot, 'scripts', name), path.join(packageRoot, name));
  }
  // Bundled createRequire retains ../prepare-package-manifest.cjs relative to
  // pack.mjs. Keep pack's real three-level root derivation and supply that
  // module plus its actual relative dependency; never replace either with stubs.
  // The fixture's own root package.json remains the catalog authority.
  const filename = path.join(packageRoot, 'scripts', 'pack.mjs');
  writeFileSync(filename, await tool.outputs[0].text());
  return filename;
}
