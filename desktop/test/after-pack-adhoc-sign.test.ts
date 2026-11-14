import { describe, expect, test } from 'bun:test';
import { cpSync, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
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

function loadHook(
  onSign: (appPath: string, command: string, args: string[]) => void,
  fsOverrides: Partial<typeof import('node:fs')> = {},
) {
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
          require: (dep: string) => dep === 'node:path' ? path
            : dep === 'node:fs' ? { ...require(dep), ...fsOverrides } : require(dep),
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

  test('rebuilds the seed when the pack hard-linked dest files to the source', async () => {
    // builder-util MAY hard-link on CI (observed sameIno:false on this host, so it
    // is a possibility, not a universal fact). When it does, copying onto that
    // destination throws "src and dest cannot be the same"; the hook must still
    // restore every dropped member and leave the source untouched.
    const f = fixture();
    try {
      const srcPkg = path.join(f.projectDir, 'runtime', 'modules', 'css', 'darwin-arm64', '1.0.0', 'package');
      const dstPkg = path.join(f.resources, 'runtime', 'modules', 'css', 'darwin-arm64', '1.0.0', 'package');
      mkdirSync(dstPkg, { recursive: true });
      for (const rel of ['payload.js', 'empty.txt', 'package.json']) {
        linkSync(path.join(srcPkg, rel), path.join(dstPkg, rel));
      }
      const before = statSync(path.join(srcPkg, 'payload.js'));
      expect(statSync(path.join(dstPkg, 'payload.js')).ino).toBe(before.ino);
      expect(() => cpSync(path.join(srcPkg, 'payload.js'), path.join(dstPkg, 'payload.js'), { force: true })).toThrow();

      await loadHook(() => {})(context(f));

      expect(existsSync(path.join(dstPkg, 'node_modules', 'tr46', 'lib', '.gitkeep'))).toBe(true);
      expect(readFileSync(path.join(dstPkg, '.DS_Store'), 'utf8')).toBe('not-empty-ds-store');
      expect(existsSync(path.join(dstPkg, '.nojekyll'))).toBe(true);
      expect(readFileSync(path.join(dstPkg, 'package.json'), 'utf8')).toBe(f.manifestBytes);
      expect(statSync(path.join(srcPkg, 'payload.js')).ino).toBe(before.ino);
      expect(statSync(path.join(srcPkg, 'payload.js')).size).toBe(before.size);
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  });

  test('copies into a resources root whose runtime directory does not exist yet', async () => {
    // A not-yet-created target tail must not be collapsed to an ancestor and
    // rejected: an ordinary disjoint layout has to succeed.
    const f = fixture();
    try {
      rmSync(path.join(f.resources, 'runtime'), { recursive: true, force: true });
      await loadHook(() => {})(context(f));
      const dstPkg = path.join(f.resources, 'runtime', 'modules', 'css', 'darwin-arm64', '1.0.0', 'package');
      expect(readFileSync(path.join(dstPkg, '.DS_Store'), 'utf8')).toBe('not-empty-ds-store');
      expect(existsSync(path.join(dstPkg, 'node_modules', 'tr46', 'lib', '.gitkeep'))).toBe(true);
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  });

  test('keeps a relative symlink verbatim instead of absolutising it', async () => {
    const f = fixture();
    try {
      const srcPkg = path.join(f.projectDir, 'runtime', 'modules', 'css', 'darwin-arm64', '1.0.0', 'package');
      symlinkSync('payload.js', path.join(srcPkg, 'alias.js'));
      await loadHook(() => {})(context(f));
      const dstAlias = path.join(f.resources, 'runtime', 'modules', 'css', 'darwin-arm64', '1.0.0', 'package', 'alias.js');
      expect(lstatSync(dstAlias).isSymbolicLink()).toBe(true);
      expect(readlinkSync(dstAlias)).toBe('payload.js');
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  });

  test('refuses when resources/runtime escapes to an external owned directory', async () => {
    const f = fixture();
    try {
      const external = path.join(f.root, 'external-owned');
      mkdirSync(path.join(external, 'modules'), { recursive: true });
      writeFileSync(path.join(external, 'modules', 'keep.txt'), 'external');
      rmSync(path.join(f.resources, 'runtime'), { recursive: true, force: true });
      symlinkSync(external, path.join(f.resources, 'runtime'));
      let signed = false;
      await expect(loadHook(() => { signed = true })(context(f))).rejects.toThrow();
      expect(signed).toBe(false);
      // Neither the external tree nor the staged source may be damaged.
      expect(readFileSync(path.join(external, 'modules', 'keep.txt'), 'utf8')).toBe('external');
      expect(existsSync(path.join(f.projectDir, 'runtime', 'modules', 'css', 'darwin-arm64', '1.0.0', 'package', 'payload.js'))).toBe(true);
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  });

  test('refuses a symlinked resources root without changing the external tree', async () => {
    const f = fixture();
    try {
      const external = path.join(f.root, 'external-resources');
      mkdirSync(path.join(external, 'runtime', 'modules'), { recursive: true });
      const keep = path.join(external, 'runtime', 'modules', 'keep.txt');
      writeFileSync(keep, 'external');
      rmSync(f.resources, { recursive: true });
      symlinkSync(external, f.resources);
      let signed = false;
      await expect(loadHook(() => { signed = true })(context(f))).rejects.toThrow();
      expect(signed).toBe(false);
      expect(readFileSync(keep, 'utf8')).toBe('external');
      expect(readFileSync(path.join(f.seed, 'payload.js'), 'utf8')).toBe('module.exports = 1;\n');
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  });

  test('refuses a target that resolves inside the staged seed', async () => {
    const f = fixture();
    try {
      const inside = { ...context(f), packager: { ...context(f).packager,
        getResourcesDir: () => path.join(f.projectDir, 'runtime', 'modules') } };
      let signed = false;
      await expect(loadHook(() => { signed = true })(inside)).rejects.toThrow();
      expect(signed).toBe(false);
      expect(existsSync(path.join(f.projectDir, 'runtime', 'modules', 'css', 'darwin-arm64', '1.0.0', 'package', 'payload.js'))).toBe(true);
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  });

  test('removes only its own staging directory when publishing fails', async () => {
    const f = fixture();
    try {
      const runtime = path.join(f.resources, 'runtime');
      mkdirSync(path.join(runtime, 'modules'), { recursive: true });
      writeFileSync(path.join(runtime, 'modules', 'old.txt'), 'old');
      let copyAttempts = 0;
      let signed = false;
      const failure = Object.assign(new Error('injected copy failure'), { code: 'EIO' });
      await expect(loadHook(() => { signed = true }, {
        cpSync: (_source, destination) => {
          copyAttempts++;
          expect(statSync(path.dirname(String(destination))).isDirectory()).toBe(true);
          throw failure;
        },
      })(context(f))).rejects.toThrow('injected copy failure');
      expect(copyAttempts).toBe(1);
      expect(signed).toBe(false);
      expect(readFileSync(path.join(runtime, 'modules', 'old.txt'), 'utf8')).toBe('old');
      expect(readdirSync(runtime).filter((n) => n.startsWith('.modules-restore-'))).toEqual([]);
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
