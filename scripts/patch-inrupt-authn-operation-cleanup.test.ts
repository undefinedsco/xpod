import { afterEach, expect, test } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { patchBundle, patchInstalledPackage, patchSource } from './patch-inrupt-authn-operation-cleanup.js';

const created: string[] = [];
afterEach(() => { for (const directory of created.splice(0)) rmSync(directory, { recursive: true, force: true }); });

const source = `  private tokenRequestInProgress = false;
    this.events.on(EVENTS.ERROR, () => this.internalLogout(false));
    const sessionInfo = await this.clientAuthentication.handleIncomingRedirect(
      url,
      this.events,
    );`;
const bundle = `    tokenRequestInProgress = false;
        this.events.on(EVENTS.ERROR, () => this.internalLogout(false));
        const sessionInfo = await this.clientAuthentication.handleIncomingRedirect(url, this.events);`;

function fixture(version = '3.1.1', esm = bundle) {
  const base = path.resolve('.test-data');
  mkdirSync(base, { recursive: true });
  const directory = mkdtempSync(path.join(base, 'inrupt-cleanup-patch-'));
  created.push(directory);
  const pkg = path.join(directory, 'node_modules/@inrupt/solid-client-authn-browser');
  mkdirSync(path.join(pkg, 'src'), { recursive: true });
  mkdirSync(path.join(pkg, 'dist'), { recursive: true });
  writeFileSync(path.join(pkg, 'package.json'), JSON.stringify({ version }));
  writeFileSync(path.join(pkg, 'src/Session.ts'), source);
  writeFileSync(path.join(pkg, 'dist/index.js'), bundle.replace('EVENTS.ERROR', 'solidClientAuthnCore.EVENTS.ERROR'));
  writeFileSync(path.join(pkg, 'dist/index.mjs'), esm);
  return { directory, pkg };
}

test('patches original source, CJS and ESM exactly once', () => {
  const { directory } = fixture();
  expect(patchInstalledPackage(directory)).toEqual({ patched: 3, alreadyPatched: 0 });
  expect(patchInstalledPackage(directory)).toEqual({ patched: 0, alreadyPatched: 3 });
  expect(patchSource(source)).toContain('await this.xpodErrorLogout;');
  expect(patchBundle(bundle)).toContain('this.xpodErrorLogout = this.xpodErrorLogout.then(');
});

test('rejects version drift before mutation', () => {
  const { directory, pkg } = fixture('3.2.0');
  expect(() => patchInstalledPackage(directory)).toThrow('Unsupported');
  expect(readFileSync(path.join(pkg, 'src/Session.ts'), 'utf8')).toBe(source);
});

test('validates all bundle shapes before mutating any target', () => {
  const { directory, pkg } = fixture('3.1.1', 'upstream changed');
  expect(() => patchInstalledPackage(directory)).toThrow('Expected one');
  expect(readFileSync(path.join(pkg, 'src/Session.ts'), 'utf8')).toBe(source);
});

test('rejects duplicate targets and corrupted idempotence markers', () => {
  expect(() => patchSource(`${source}\n${source}`)).toThrow('found 2');
  expect(() => patchBundle(patchBundle(bundle).replace('await this.xpodErrorLogout;', ''))).toThrow('Incomplete');
});

test('installed source and both module formats retain the complete patch', () => {
  const pkg = path.resolve('node_modules/@inrupt/solid-client-authn-browser');
  for (const [relative, patcher] of [
    ['src/Session.ts', patchSource], ['dist/index.js', patchBundle], ['dist/index.mjs', patchBundle],
  ] as const) {
    const installed = readFileSync(path.join(pkg, relative), 'utf8');
    expect(patcher(installed)).toBe(installed);
    expect(installed).toContain('await this.xpodErrorLogout;');
  }
});
