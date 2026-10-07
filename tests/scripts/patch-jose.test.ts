import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, copyFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })));
it.each(['browser', 'node/esm'])('patches jose %s exports for mixed ESM/CJS loading exactly once', (oldTarget) => {
  const base = path.resolve('.test-data/patch-jose');
  mkdirSync(base, { recursive: true });
  const root = mkdtempSync(path.join(base, 'case-'));
  roots.push(root);
  mkdirSync(path.join(root, 'scripts'));
  copyFileSync('scripts/patch-jose.js', path.join(root, 'scripts/patch-jose.js'));
  const jose = path.join(root, 'node_modules/jose');
  for (const format of ['esm', 'cjs']) {
    mkdirSync(path.join(jose, 'dist/node', format), { recursive: true });
    writeFileSync(path.join(jose, 'dist/node', format, 'index.js'), '');
  }
  const manifest = path.join(jose, 'package.json');
  writeFileSync(manifest, JSON.stringify({ exports: { '.': {
    bun: `./dist/${oldTarget}/index.js`, import: './dist/node/esm/index.js', require: './dist/node/cjs/index.js',
  } } }, null, 2));
  const run = () => spawnSync(process.execPath, [path.join(root, 'scripts/patch-jose.js')], { encoding: 'utf8' });
  expect(run().status).toBe(0);
  const patched = readFileSync(manifest, 'utf8');
  expect(JSON.parse(patched).exports['.'].bun).toEqual({ import: './dist/node/esm/index.js', require: './dist/node/cjs/index.js' });
  expect(run().status).toBe(0);
  expect(readFileSync(manifest, 'utf8')).toBe(patched);
});

it('loads the real Solid runtime graph alongside JOSE and preserves exportable signing keys on Bun', () => {
  const child = spawnSync('bun', ['--no-env-file', '-e', `
    import { XpodTestStack } from './tests/helpers/XpodTestStack';
    import { generateKeyPair, exportJWK } from 'jose';
    if (typeof XpodTestStack !== 'function') throw new Error('Missing runtime');
    const { privateKey } = await generateKeyPair('ES256');
    if ((await exportJWK(privateKey)).kty !== 'EC') throw new Error('Signing key is not exportable');
  `], { encoding: 'utf8', timeout: 15_000 });
  expect(child.error).toBeUndefined();
  expect(child.status, child.stderr).toBe(0);
}, 20_000);
