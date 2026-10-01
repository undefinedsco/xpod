import { expect, test } from 'bun:test';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { copyNativeDeclarations, type NativeDeclarationIndex } from '../src/native-declarations';
import { sha256File } from '../src/manifest';
import type { NativeNoticeIndex } from '../src/native-notices';

test('bundles pinned declarations and standard terms with exact bytes; rejects drift before output', () => {
  const source = path.resolve(import.meta.dir, '../licenses/native/declarations');
  const root = path.resolve('.test-data/xpod-cli/native-declarations');
  mkdirSync(root, { recursive: true });
  const work = mkdtempSync(path.join(root, 'copy-'));
  try {
    const input = path.join(work, 'input');
    cpSync(source, input, { recursive: true });
    const filename = path.join(input, 'index.json');
    const original = readFileSync(filename, 'utf8');
    const index = JSON.parse(original) as NativeDeclarationIndex;
    const inventory = JSON.parse(readFileSync(path.resolve(import.meta.dir, '../licenses/native/collection/darwin-arm64.json'), 'utf8')) as NativeNoticeIndex;
    const output = path.join(work, 'output');
    const files = copyNativeDeclarations(input, output, index.engine, inventory);
    expect(files.length).toBe(7);
    for (const file of files) { expect(readFileSync(path.join(output, file))).toEqual(readFileSync(path.join(input, file))); }
    expect(index.packages.map((entry) => entry.chosenLicense)).toEqual(Array(5).fill('MIT'));
    const refused = path.join(work, 'refused');
    const reject = (change: (data: NativeDeclarationIndex) => void, message: string): void => {
      const data = JSON.parse(original) as NativeDeclarationIndex;
      change(data);
      writeFileSync(filename, JSON.stringify(data));
      expect(() => copyNativeDeclarations(input, refused, index.engine, inventory)).toThrow(message);
      expect(existsSync(refused)).toBe(false);
    };
    reject((data) => { data.engine.commit = 'a'.repeat(40); }, 'engine pin');
    reject((data) => { data.packages[0].source.commit = 'a'.repeat(40); }, 'source differs');
    reject((data) => { data.packages[0].source.url = 'https://example.com/unrelated'; }, 'source URL differs');
    reject((data) => { data.packages[1].declaration = data.packages[2].declaration; }, 'package identity mismatch');
    reject((data) => {
      data.packages[1].declaration = data.packages[0].declaration;
      data.packages[1].declarationKind = 'project-readme';
    }, 'kind mismatch');
    reject((data) => { data.packages[1].version = '0.0.0'; }, 'package identity mismatch');
    reject((data) => { data.packages[0].declaredLicense = 'Apache-2.0'; }, 'Unproven license alternative');
    reject((data) => { data.packages[0].declaredLicense = 'MIT OR Apache-2.0'; }, 'text mismatch');
    reject((data) => { data.packages[0].declaredLicense = 'MIT AND Apache-2.0'; }, 'Unproven license alternative');
    reject((data) => { data.packages[0].declaration.object = '../../outside'; }, 'Unsafe declaration');
    reject((data) => { data.packages.push(data.packages[0]); }, 'duplicate');
    reject((data) => { data.packages.splice(1, 1); }, 'SDK declarations');
    writeFileSync(filename, original);
    const wrongInventory = { ...inventory, packages: inventory.packages.filter((entry) => entry.name !== 'genawaiter') };
    expect(() => copyNativeDeclarations(input, refused, index.engine, wrongInventory)).toThrow('version absent');
    expect(existsSync(refused)).toBe(false);
    const template = path.join(input, index.licenses[0].object);
    expect(sha256File(template)).toBe(index.licenses[0].sha256);
    writeFileSync(template, 'invented notice');
    expect(() => copyNativeDeclarations(input, refused, index.engine)).toThrow('hash mismatch');
    expect(existsSync(refused)).toBe(false);
  } finally { rmSync(work, { recursive: true, force: true }); }
});
