import { afterEach, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
const { verifyInstalledBundles } = createRequire(import.meta.url)('../../scripts/verify-installed-bundles.cjs');
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
function fixture() {
  fs.mkdirSync('.test-data', { recursive: true });
  const root = fs.mkdtempSync(path.resolve('.test-data/bundle-proof-unit-')); roots.push(root);
  const source = path.join(root, 'package');
  for (const name of ['ai-connections', 'extension-sdk', 'shared-ui', 'solid-sdk', 'drizzle-solid', 'extensions']) {
    const dir = path.join(source, 'node_modules/@undefineds.co', name); fs.mkdirSync(path.join(dir, 'dist'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: `@undefineds.co/${name}`, version: '1.0.0' }));
    fs.writeFileSync(path.join(dir, 'dist/index.js'), 'export const fresh = true;');
  }
  const tarball = path.join(root, 'artifact.tgz'); execFileSync('tar', ['czf', tarball, '-C', root, 'package']);
  const installed = path.join(root, 'installed'); fs.cpSync(source, installed, { recursive: true });
  return { root, tarball, installed, sdk: path.join(installed, 'node_modules/@undefineds.co/solid-sdk') };
}
it('proves every file in all six bundles and removes scratch extraction', () => {
  const f = fixture(); const proof = verifyInstalledBundles(f.tarball, f.installed, f.root);
  expect(proof).toHaveLength(6); expect(proof.every((entry: any) => entry.files === 2 && entry.bytesMatched && entry.containedInInstalledXpod)).toBe(true);
  expect(fs.readdirSync(f.root).some((name) => name.startsWith('bundle-proof-'))).toBe(false);
});
it('rejects an older build with identical package version and exports', () => {
  const f = fixture(); fs.writeFileSync(path.join(f.sdk, 'dist/index.js'), 'export const fresh = false;');
  expect(() => verifyInstalledBundles(f.tarball, f.installed, f.root)).toThrow('bytes differ');
});
it('rejects external realpath even when package bytes match', () => {
  const f = fixture(); const outside = path.join(f.root, 'external-sdk'); fs.renameSync(f.sdk, outside); fs.symlinkSync(outside, f.sdk, 'junction');
  expect(() => verifyInstalledBundles(f.tarball, f.installed, f.root)).toThrow('escaped Xpod');
});
it('allows matching links whose realpath stays inside installed Xpod', () => {
  const f = fixture(); const inside = path.join(f.installed, 'private-sdk'); fs.renameSync(f.sdk, inside); fs.symlinkSync(inside, f.sdk, 'junction');
  expect(verifyInstalledBundles(f.tarball, f.installed, f.root)).toHaveLength(6);
});
it('rejects missing bundled files', () => {
  const f = fixture(); fs.rmSync(path.join(f.sdk, 'dist/index.js'));
  expect(() => verifyInstalledBundles(f.tarball, f.installed, f.root)).toThrow('Missing installed bundle file');
});
