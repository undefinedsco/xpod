import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = path.resolve(__dirname, '../..');
const require = createRequire(import.meta.url);
const loadGenerator = () => require('../../packages/solid-sdk/scripts/build-bun-entries.cjs') as {
  writeBunEntry(directory: string): void;
};

function fixture(run: (directory: string) => void): void {
  const parent = path.join(root, '.test-data/solid-sdk-bun-entries');
  mkdirSync(parent, { recursive: true });
  const directory = mkdtempSync(path.join(parent, 'case-'));
  try {
    writeFileSync(path.join(directory, 'session.cjs'), 'exports.createSolidSessionRuntime = () => ({});\n');
    run(directory);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

describe('Solid SDK Bun distribution entries', () => {
  it('derives the Bun root from existing reexports without changing the ESM root', () => fixture((directory) => {
    const source = "export * from './session.js';\nexport * from './react.js';\nexport * from './future-entry.js';\n";
    writeFileSync(path.join(directory, 'index.js'), source);
    loadGenerator().writeBunEntry(directory);
    expect(readFileSync(path.join(directory, 'index.js'), 'utf8')).toBe(source);
    expect(readFileSync(path.join(directory, 'index.bun.js'), 'utf8')).toBe(
      source.replace("'./session.js'", "'./session.cjs'"),
    );
  }));

  it.each([
    "export * from './react.js';\n",
    "export * from './session.js';\nexport * from './session.js';\n",
  ])('refuses an absent or repeated session reexport before writing a wrapper', (source) => fixture((directory) => {
    writeFileSync(path.join(directory, 'index.js'), source);
    expect(() => loadGenerator().writeBunEntry(directory)).toThrow('exactly one session reexport');
    expect(existsSync(path.join(directory, 'index.bun.js'))).toBe(false);
  }));

  it('requires the session CJS artifact before publishing the Bun wrapper', () => fixture((directory) => {
    writeFileSync(path.join(directory, 'index.js'), "export * from './session.js';\n");
    rmSync(path.join(directory, 'session.cjs'));
    expect(() => loadGenerator().writeBunEntry(directory)).toThrow();
    expect(existsSync(path.join(directory, 'index.bun.js'))).toBe(false);
  }));

  it('preserves Node, browser and type entries while sharing one Bun session artifact', () => {
    const manifest = JSON.parse(readFileSync(path.join(root, 'packages/solid-sdk/package.json'), 'utf8'));
    expect(manifest.exports['.']).toEqual({
      types: './dist/index.d.ts', bun: './dist/index.bun.js',
      import: './dist/index.js', require: './dist/index.cjs',
    });
    expect(manifest.exports['./session']).toEqual({
      types: './dist/session.d.ts', bun: './dist/session.cjs', import: './dist/session.js',
    });
    expect(Object.keys(manifest.exports['.'])).toEqual(['types', 'bun', 'import', 'require']);
    expect(Object.keys(manifest.exports['./session'])).toEqual(['types', 'bun', 'import']);
    expect(manifest.exports['./react'].import).toBe('./dist/react.js');
    expect(manifest.exports['./login-store'].import).toBe('./dist/login-store.js');
    expect(manifest.scripts.build).toContain('bun build src/session.ts --target=node --format=cjs --outfile=dist/session.cjs');
    expect(manifest.scripts.build).toContain('bun scripts/build-bun-entries.cjs');
  });
});
