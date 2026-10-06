import { afterEach, expect, it } from 'vitest';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const load = createRequire(import.meta.url);
const roots: string[] = [];
afterEach(() => roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })));

it.each([
  ['matching import/require builds', 'node/cjs', 'node/esm', true],
  ['ESM selected by require', 'node/esm', 'node/esm', false],
  ['CJS selected by import', 'node/cjs', 'node/cjs', false],
  ['browser selected by import', 'node/cjs', 'browser', false],
] as const)('validates the packaged JOSE contract: %s', (_name, requireBuild, importBuild, passes) => {
  const base = path.resolve('.test-data/packaged-auth-probe');
  mkdirSync(base, { recursive: true });
  const root = mkdtempSync(path.join(base, 'case-'));
  roots.push(root);
  const jose = path.join(root, 'node_modules/jose');
  cpSync(path.dirname(load.resolve('jose/package.json')), jose, { recursive: true });
  const manifestPath = path.join(jose, 'package.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  manifest.exports['.'].bun = {
    import: `./dist/${importBuild}/index.js`,
    require: `./dist/${requireBuild}/index.js`,
  };
  writeFileSync(manifestPath, JSON.stringify(manifest));
  const caller = path.join(root, 'package.json');
  writeFileSync(caller, '{}');
  const probe = path.resolve('tests/scripts/packaged-auth-probe.cjs');
  const child = spawnSync('bun', ['--no-env-file', '--no-install', '-e', `
    const { verifyBunJoseBuilds } = require(${JSON.stringify(probe)});
    await verifyBunJoseBuilds(${JSON.stringify(caller)}, ${JSON.stringify(root)});
  `], { encoding: 'utf8', timeout: 15_000 });
  expect(child.error).toBeUndefined();
  if (passes) expect(child.status, child.stderr).toBe(0);
  else {
    expect(child.status).not.toBe(0);
    expect(child.stderr).toContain('AssertionError');
  }
}, 20_000);
