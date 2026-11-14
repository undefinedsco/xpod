import { it, expect } from 'bun:test';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { assembleCssNativeRuntime, type CssNativeRuntimeInput } from '../scripts/native-runtime-material';

function fixture(test: (product: string, input: CssNativeRuntimeInput) => void): void {
  const base = path.resolve(import.meta.dir, '../../../.test-data/css-native-assembly-tests');
  mkdirSync(base, { recursive: true });
  const root = mkdtempSync(path.join(base, 'case-'));
  const product = path.join(root, 'product'), runtimeRoot = path.join(root, 'runtime'), materialsRoot = path.join(root, 'materials');
  for (const dir of [product, runtimeRoot, materialsRoot]) mkdirSync(dir);
  const make = (name: string) => {
    const bytes = Buffer.from('deliberately invalid original fixture');
    writeFileSync(path.join(materialsRoot, name), bytes);
    return { path: name, sizeBytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
  };
  const input: CssNativeRuntimeInput = { runtimeRoot, materialsRoot, manifest: { path: 'manifest.json', sizeBytes: 0, sha256: '0'.repeat(64) },
    archive: make('runtime.tar.gz'), originalZip: make('original.zip'), acceptance: make('acceptance.json'), sourceSha: 'a'.repeat(40) };
  try { test(product, input); expect(existsSync(path.join(product, 'native'))).toBe(false); }
  finally { rmSync(root, { recursive: true }); }
}

it('rejects runtime symlinks before product writes', () => fixture((product, input) => {
  symlinkSync(path.join(input.materialsRoot, 'acceptance.json'), path.join(input.runtimeRoot, 'unexpected'));
  expect(() => assembleCssNativeRuntime(product, 'darwin-arm64', input)).toThrow('symlink');
}));
it('rejects missing/drifting original raw bindings before product writes', () => fixture((product, input) => {
  writeFileSync(path.join(input.materialsRoot, 'acceptance.json'), 'changed original');
  expect(() => assembleCssNativeRuntime(product, 'darwin-arm64', input)).toThrow('Source kit drift');
}));
it('rejects overlapping product/material roots', () => fixture((product, input) => {
  input.materialsRoot = product;
  expect(() => assembleCssNativeRuntime(product, 'darwin-arm64', input)).toThrow('external');
}));
it('rejects unknown and malformed targets through the shared module catalog before writes', () => fixture((product, input) => {
  for (const target of ['win32-x64', 'linux-arm64-extra', 'linux-']) {
    expect(() => assembleCssNativeRuntime(product, target, input)).toThrow('Unsupported CSS native target');
  }
}));
