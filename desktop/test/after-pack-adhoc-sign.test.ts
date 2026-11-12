import { describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

/**
 * A real fixture project: `<projectDir>/runtime/modules/...` is the staged seed,
 * `<appOutDir>/Xpod.app/Contents/Resources` is where the pack writes resources.
 * `getResourcesDir` mirrors app-builder-lib's platformPackager implementation.
 */
const TEST_DATA = path.join(import.meta.dir, '..', '..', '.test-data');

function fixture() {
  // AGENTS: suite data lives under the repository's .test-data, never os.tmpdir.
  mkdirSync(TEST_DATA, { recursive: true });
  const root = mkdtempSync(path.join(TEST_DATA, 'after-pack-adhoc-sign-'));
  const projectDir = path.join(root, 'desktop');
  const appOutDir = path.join(root, 'release', 'mac-arm64');
  const resources = path.join(appOutDir, 'Xpod.app', 'Contents', 'Resources');
  const seed = path.join(projectDir, 'runtime', 'modules', 'css', 'darwin-arm64', '1.0.0', 'package');
  mkdirSync(path.join(seed, 'node_modules', 'tr46', 'lib'), { recursive: true });
  mkdirSync(path.join(seed, 'sub', 'node_modules', 'inner'), { recursive: true });
  // The exact shapes builder-util drops, plus ordinary payload.
  writeFileSync(path.join(seed, 'node_modules', 'tr46', 'lib', '.gitkeep'), '');
  writeFileSync(path.join(seed, 'sub', 'node_modules', 'inner', '.gitkeep'), '');
  writeFileSync(path.join(seed, '.DS_Store'), 'not-empty-ds-store');   // NOT assumed zero byte
  writeFileSync(path.join(seed, '.nojekyll'), '');
  writeFileSync(path.join(seed, 'empty.txt'), '');
  writeFileSync(path.join(seed, 'payload.js'), 'module.exports = 1;\n', { mode: 0o755 });
  const manifestBytes = `${JSON.stringify({ name: '@undefineds.co/xpod-css-darwin-arm64', version: '1.0.0', xpodModule: { files: [{ path: 'node_modules/tr46/lib/.gitkeep', size: 0 }] } }, null, 2)}\n`;
  writeFileSync(path.join(seed, 'package.json'), manifestBytes);
  mkdirSync(resources, { recursive: true });
  return { root, projectDir, appOutDir, resources, seed, manifestBytes };
}

/**
 * Runs inside the mocked codesign call to prove the seed was ALREADY restored at
 * the moment the signature is produced (the ordering the fix claims).
 */
function checksInsideSign(signedAppPath: string, f: ReturnType<typeof fixture>, packed: string): number {
  const restored = existsSync(path.join(packed, 'node_modules', 'tr46', 'lib', '.gitkeep'))
    && existsSync(path.join(packed, 'sub', 'node_modules', 'inner', '.gitkeep'))
    && readFileSync(path.join(packed, '.DS_Store'), 'utf8') === 'not-empty-ds-store'
    && readFileSync(path.join(packed, 'package.json'), 'utf8') === f.manifestBytes
    && (statSync(path.join(packed, 'payload.js')).mode & 0o111) !== 0;
  const signedCorrectBundle = signedAppPath === path.join(f.appOutDir, 'Xpod.app');
  return restored && signedCorrectBundle ? 1 : 0;
}

function loadHook(onSign: (appPath: string, command: string, args: string[]) => void) {
  const module = { exports: {} as unknown };
  vm.runInNewContext(readFileSync(path.join(import.meta.dir, '../scripts/after-pack-adhoc-sign.cjs'), 'utf8'), {
    module,
    require: (name: string) => {
      if (name === 'node:path') return path;
      if (name === './after-pack-preserve-seed.cjs') {
        // Load the REAL helper so the test exercises its copy semantics.
        const helperModule = { exports: {} as unknown };
        vm.runInNewContext(readFileSync(path.join(import.meta.dir, '../scripts/after-pack-preserve-seed.cjs'), 'utf8'), {
          module: helperModule, exports: helperModule.exports,
          require: (dep: string) => dep === 'node:path' ? path : require(dep),
          console: { log() {} },
        });
        return helperModule.exports;
      }
      return {
        execFileSync: (command: string, args: string[]) =>
          onSign(args[args.length - 1]!, command, args),
      };
    },
    console: { log() {} },
  });
  return module.exports as (context: unknown) => Promise<void>;
}

function context(f: ReturnType<typeof fixture>) {
  return {
    electronPlatformName: 'darwin',
    appOutDir: f.appOutDir,
    packager: {
      appInfo: { productFilename: 'Xpod' },
      projectDir: f.projectDir,
      getResourcesDir: (outDir: string) => path.join(outDir, 'Xpod.app', 'Contents', 'Resources'),
    },
  };
}

describe('packaged capability seed survives the pack', () => {
  test('the REAL builder-util copier drops .gitkeep/.DS_Store, and the hook restores exact bytes', async () => {
    const f = fixture();
    try {
      // 1. Produce the REAL damage with the INSTALLED copier, not a hand-made tree.
      const { copyDir } = require('builder-util/out/fs.js') as {
        copyDir: (from: string, to: string, filter?: unknown, transformer?: unknown) => Promise<void>;
      };
      const packedModules = path.join(f.resources, 'runtime', 'modules');
      mkdirSync(packedModules, { recursive: true });
      await copyDir(path.join(f.projectDir, 'runtime', 'modules'), packedModules);

      const packed = path.join(packedModules, 'css', 'darwin-arm64', '1.0.0', 'package');
      // builder-util's walker skipped these names BEFORE any filter ran.
      expect(existsSync(path.join(packed, 'node_modules', 'tr46', 'lib', '.gitkeep'))).toBe(false);
      expect(existsSync(path.join(packed, 'sub', 'node_modules', 'inner', '.gitkeep'))).toBe(false);
      // A non-empty .DS_Store is dropped as well: the skip is name-based, not size-based.
      expect(existsSync(path.join(packed, '.DS_Store'))).toBe(false);
      // Everything else survived the copier.
      expect(existsSync(path.join(packed, 'payload.js'))).toBe(true);

      // 2. The hook must restore EXACT staged bytes/modes/nesting before signing.
      let restoredInsideSign = -1;
      await loadHook((signedAppPath) => {
        restoredInsideSign = checksInsideSign(signedAppPath, f, packed);
      })(context(f));

      // The sign callback observed an ALREADY-restored tree (order proof).
      expect(restoredInsideSign).toBe(1);
      expect(readFileSync(path.join(packed, '.DS_Store'), 'utf8')).toBe('not-empty-ds-store');
      expect(readFileSync(path.join(packed, 'package.json'), 'utf8')).toBe(f.manifestBytes);
      expect(statSync(path.join(packed, 'payload.js')).mode & 0o111).not.toBe(0);
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  });

  test('fails loudly when the packaged seed is missing instead of manufacturing one', async () => {
    const f = fixture();
    try {
      rmSync(path.join(f.projectDir, 'runtime'), { recursive: true, force: true });
      let signed = false;
      await expect(loadHook(() => { signed = true })(context(f))).rejects.toThrow(/staged capability seed missing/u);
      expect(signed).toBe(false);
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  });

  test('restores on every platform and never signs off darwin', async () => {
    const f = fixture();
    try {
      const packedModules = path.join(f.resources, 'runtime', 'modules');
      let signed = false;
      await loadHook(() => { signed = true })({ ...context(f), electronPlatformName: 'linux' });
      expect(existsSync(path.join(packedModules, 'css', 'darwin-arm64', '1.0.0', 'package', 'node_modules', 'tr46', 'lib', '.gitkeep'))).toBe(true);
      expect(existsSync(path.join(packedModules, 'css', 'darwin-arm64', '1.0.0', 'package', '.DS_Store'))).toBe(true);
      expect(signed).toBe(false);
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  });

  test('signs then strictly verifies with the exact canonical argument arrays', async () => {
    const f = fixture();
    try {
      const calls: Array<[string, string[]]> = [];
      await loadHook((_appPath, command, args) => { calls.push([command, args]) })(context(f));
      const app = path.join(f.appOutDir, 'Xpod.app');
      expect(calls).toEqual([
        ['/usr/bin/codesign', ['--force', '--deep', '--sign', '-', app]],
        ['/usr/bin/codesign', ['--verify', '--deep', '--strict', '--verbose=2', app]],
      ]);
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  });
});
