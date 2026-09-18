import { afterEach, describe, expect, test } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const script = path.resolve(testDirectory, '../../scripts/check-dependency-state.ts');
const fixtures: string[] = [];
const testRoot = path.resolve(testDirectory, '../../.test-data/dependency-state-checker');
const original = Array.from({ length: 6 }, (_, index) => `declare Alias${index} {\ncreatedAt: optional;\n}`).join('\n') + '\n';
const patch = '--- a/types.d.ts\n+++ b/types.d.ts\n' + Array.from({ length: 6 }, (_, index) =>
  `@@ -${index * 3 + 2},2 +${index * 3 + 2},2 @@\n-createdAt: required;\n+createdAt: optional;\n }\n`).join('');

function fixture(content = original) {
  mkdirSync(testRoot, { recursive: true });
  const root = mkdtempSync(path.join(testRoot, 'fixture-'));
  fixtures.push(root);
  const packageDir = path.join(root, 'node_modules', 'example');
  mkdirSync(packageDir, { recursive: true });
  writeFileSync(path.join(root, 'package.json'), JSON.stringify({ patchedDependencies: { 'example@1.0.0': 'example.patch' } }));
  writeFileSync(path.join(packageDir, 'package.json'), JSON.stringify({ version: '1.0.0' }));
  writeFileSync(path.join(root, 'example.patch'), patch);
  const target = path.join(packageDir, 'types.d.ts');
  writeFileSync(target, content);
  return { root, target };
}

async function run(root: string, repair = false) {
  const child = spawnSync('bun', ['--no-env-file', script, ...(repair ? ['--repair'] : [])], {
    cwd: root, encoding: 'utf8', timeout: 10_000,
  });
  if (child.error) throw child.error;
  return { code: child.status, output: child.stdout + child.stderr };
}

afterEach(() => {
  for (const root of fixtures.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('patched dependency state', () => {
  test.each([false, true])('accepts six distinct aliases sharing an identical hunk, repair=%s', async (repair) => {
    const f = fixture();
    expect((await run(f.root, repair)).code).toBe(0);
    expect(readFileSync(f.target, 'utf8')).toBe(original);
  });

  test('uses final target coordinates after earlier insertions and deletions', async () => {
    const content = 'start\ninserted\nalpha\nmiddle\nchanged\nend\n';
    const f = fixture(content);
    writeFileSync(path.join(f.root, 'example.patch'),
      '--- a/types.d.ts\n+++ b/types.d.ts\n' +
      '@@ -1,2 +1,3 @@\n start\n+inserted\n alpha\n' +
      '@@ -4,4 +5,2 @@\n-delete1\n-delete2\n-omega\n+changed\n end\n');
    expect((await run(f.root)).code).toBe(0);
    expect(readFileSync(f.target, 'utf8')).toBe(content);
  });

  test('accepts a zero-line source insertion using the new-file target range', async () => {
    const f = fixture('first\nsecond\n');
    writeFileSync(path.join(f.root, 'example.patch'),
      '--- /dev/null\n+++ b/types.d.ts\n@@ -0,0 +1,2 @@\n+first\n+second\n');
    expect((await run(f.root, true)).code).toBe(0);
    expect(readFileSync(f.target, 'utf8')).toBe('first\nsecond\n');
  });

  const corruptions = {
    'additional full alias': original + 'declare Extra {\ncreatedAt: optional;\n}\n',
    'missing hunk': original.replace('createdAt: optional;', 'createdAt: required;'),
    'misplaced hunk with unchanged total count': original.replace('createdAt: optional;', 'createdAt: required;') + 'declare Wrong {\ncreatedAt: optional;\n}\n',
    'adjacent duplicate addition': original.replace('createdAt: optional;', 'createdAt: optional;\ncreatedAt: optional;'),
    'all hunks shifted': '// unexpected insertion\n' + original,
  };
  for (const [name, content] of Object.entries(corruptions)) {
    test.each([false, true])(`rejects ${name} without modifying package bytes, repair=%s`, async (repair) => {
      const f = fixture(content);
      const result = await run(f.root, repair);
      expect(result.code).toBe(1);
      expect(result.output).toContain('bun install');
      expect(readFileSync(f.target, 'utf8')).toBe(content);
    });
  }
});

describe('postinstall authentication patch state', () => {
  test('rejects a clean reinstall that skipped the browser transport postinstall', async () => {
    const f = fixture();
    const manifest = JSON.parse(readFileSync(path.join(f.root, 'package.json'), 'utf8'));
    manifest.scripts = { postinstall: 'bun scripts/patch-inrupt-authn-transport.js' };
    writeFileSync(path.join(f.root, 'package.json'), JSON.stringify(manifest));
    const browser = path.join(f.root, 'node_modules/@inrupt/solid-client-authn-browser');
    mkdirSync(path.join(browser, 'dist'), { recursive: true });
    writeFileSync(path.join(browser, 'package.json'), JSON.stringify({ version: '3.1.1' }));
    const clean = 'export interface ISessionOptions { clientAuthentication: unknown; }';
    writeFileSync(path.join(browser, 'dist/Session.d.ts'), clean);
    const result = await run(f.root);
    expect(result.code).toBe(1);
    expect(result.output).toContain('bun run postinstall');
    expect(readFileSync(path.join(browser, 'dist/Session.d.ts'), 'utf8')).toBe(clean);
  });
});

const transportFiles = [
  'src/Session.ts', 'src/dependencies.ts',
  'src/login/oidc/incomingRedirectHandler/AuthCodeRedirectHandler.ts',
  'dist/index.js', 'dist/index.mjs', 'dist/Session.d.ts', 'dist/dependencies.d.ts',
  'dist/login/oidc/incomingRedirectHandler/AuthCodeRedirectHandler.d.ts',
];
test.each([
  [undefined, undefined, 'all'],
  ['dist/Session.d.ts', 'fetch?: typeof fetch;', 'all'],
  ['dist/index.js', 'fetch: this.fetch', 'all'],
  ['dist/index.mjs', 'fetch: sessionOptions.fetch', 'all'],
  ['src/login/oidc/incomingRedirectHandler/AuthCodeRedirectHandler.ts', 'this.fetch = fetch;', 'first'],
  ['dist/index.js', 'this.fetch = fetch;', 'first'],
  ['dist/index.mjs', 'this.fetch = fetch;', 'first'],
  ['src/Session.ts', 'fetch: sessionOptions.fetch', 'first'],
  ['src/Session.ts', 'fetch: sessionOptions.fetch', 'last'],
  ['dist/index.js', 'fetch: sessionOptions.fetch', 'first'],
  ['dist/index.js', 'fetch: sessionOptions.fetch', 'last'],
  ['dist/index.mjs', 'fetch: sessionOptions.fetch', 'first'],
  ['dist/index.mjs', 'fetch: sessionOptions.fetch', 'last'],

] as const)('checks declaration and executable transport hooks: %s / %s / %s', async (file, hook, occurrence) => {
  const f = fixture();
  const manifest = JSON.parse(readFileSync(path.join(f.root, 'package.json'), 'utf8'));
  manifest.scripts = { postinstall: 'bun scripts/patch-inrupt-authn-transport.js' };
  writeFileSync(path.join(f.root, 'package.json'), JSON.stringify(manifest));
  const relative = 'node_modules/@inrupt/solid-client-authn-browser';
  for (const entry of ['package.json', ...transportFiles]) {
    const target = path.join(f.root, relative, entry);
    mkdirSync(path.dirname(target), { recursive: true });
    const content = readFileSync(path.resolve(testDirectory, '../..', relative, entry), 'utf8');
    let updated = content;
    if (entry === file) {
      expect(content).toContain(hook!);
      if (occurrence === 'all') updated = content.split(hook!).join('REMOVED_HOOK');
      else {
        const offset = occurrence === 'last' ? content.lastIndexOf(hook!) : content.indexOf(hook!);
        updated = content.slice(0, offset) + 'REMOVED_HOOK' + content.slice(offset + hook!.length);
      }
    }
    writeFileSync(target, updated);
  }
  const result = await run(f.root);
  expect(result.code).toBe(file ? 1 : 0);
  if (file) expect(result.output).toContain(file);
});
