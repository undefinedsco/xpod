import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { expect, it } from 'vitest';
const require = createRequire(import.meta.url);
const {patchPackageManifest, patchInstalledPackages} = require('../../scripts/patch-jose.js');
it('reuses the exact original jose manifest transform and remains idempotent', () => {
  for (const entry of ['browser/index.js', 'node/esm/jwk/import.js']) {
    const value = '{"exports":{"bun": "./dist/' + entry + '"}}';
    const old = value.replace(/"bun": "\.\/dist\/(?:browser|node\/esm)\/([^"\n]+)"/g,
      (_match, name) => `"bun": { "import": "./dist/node/esm/${name}", "require": "./dist/node/cjs/${name}" }`);
    expect(patchPackageManifest(value)).toBe(old);
    expect(patchPackageManifest(old)).toBe(old);
  }
  const root = mkdtempSync(path.resolve('.test-data/jose-pure-'));
  try {
    const pkg = path.join(root, 'node_modules/jose'); mkdirSync(path.join(pkg, 'dist/node/esm'), {recursive: true});
    writeFileSync(path.join(pkg, 'dist/node/esm/index.js'), '');
    const manifest = '{"name":"jose","exports":{"bun": "./dist/browser/index.js"}}'; writeFileSync(path.join(pkg, 'package.json'), manifest);
    expect(patchInstalledPackages(root)).toEqual({patched: 1, alreadyPatched: 0, skipped: 0});
    expect(readFileSync(path.join(pkg, 'package.json'), 'utf8')).toBe(patchPackageManifest(manifest));
    expect(patchInstalledPackages(root)).toEqual({patched: 0, alreadyPatched: 1, skipped: 0});
  } finally { rmSync(root, {recursive: true}); }
});
