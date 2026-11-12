import { makeRuntimeFixture } from './bun-runtime-fixture';
import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { stageDesktopRuntime, promoteDesktopRuntime } from '../scripts/stage-runtime';

test('normal packed CLI resolves its installed client after temporary archives are removed', async () => {
  const base = path.resolve(import.meta.dir, '../../.test-data/desktop-runtime-test');
  mkdirSync(base, { recursive: true });
  const root = mkdtempSync(path.join(base, 'case-'));
  try {
    for (const name of ['xpod-client', 'xpod-cli']) {
      const directory = path.join(root, 'packages', name);
      mkdirSync(directory, { recursive: true });
      writeFileSync(path.join(directory, 'package.json'), JSON.stringify({
        name: `@undefineds.co/${name}`, version: '0.0.1', type: 'module', files: ['dist'],
        scripts: { build: 'bun build.ts', ...(name === 'xpod-cli' ? { 'build:tools': 'bun tools.ts' } : {}) },
        ...(name === 'xpod-client' ? { exports: './dist/index.mjs' }
          : { dependencies: { '@undefineds.co/xpod-client': '0.0.1' } }),
      }));
      writeFileSync(path.join(directory, 'build.ts'), name === 'xpod-cli'
        ? "import { mkdirSync, writeFileSync } from 'node:fs'; mkdirSync('dist',{recursive:true}); writeFileSync('dist/xpod.mjs',\"import { value } from '@undefineds.co/xpod-client'; console.log(value);\");"
        : "import { mkdirSync, writeFileSync } from 'node:fs'; const tools = await import('@undefineds.co/xpod-cli/build-tools'); mkdirSync('dist',{recursive:true}); writeFileSync('dist/index.mjs','export const value = '+tools.value+';');");
      if (name === 'xpod-cli') {
        writeFileSync(path.join(directory, 'tools.ts'), "import { mkdirSync, writeFileSync } from 'node:fs'; mkdirSync('dist',{recursive:true}); writeFileSync('dist/tools.mjs','export const value = 42;');");
        const metadata = JSON.parse(readFileSync(path.join(directory, 'package.json'), 'utf8'));
        metadata.exports = { './build-tools': './dist/tools.mjs' };
        writeFileSync(path.join(directory, 'package.json'), JSON.stringify(metadata));
      }
    }
    // Normal workspace resolution; all dist directories are absent before staging.
    const links = path.join(root, 'packages/xpod-client/node_modules/@undefineds.co');
    mkdirSync(links, { recursive: true });
    symlinkSync(path.join(root, 'packages/xpod-cli'), path.join(links, 'xpod-cli'));
    expect(existsSync(path.join(root, 'packages/xpod-cli/dist'))).toBe(false);
    expect(existsSync(path.join(root, 'packages/xpod-client/dist'))).toBe(false);
    mkdirSync(path.join(root, 'desktop'));
    const runtimeInput = makeRuntimeFixture(root);
    await stageDesktopRuntime(root, undefined, runtimeInput, nativeStage());
    const entry = path.join(root, 'desktop/runtime/node_modules/@undefineds.co/xpod-cli/dist/xpod.mjs');
    const result = spawnSync('bun', [entry], { cwd: root });
    expect(result.status).toBe(0);
    expect(result.stdout.toString().trim()).toBe('42');
    expect(existsSync(path.join(root, 'desktop/runtime/package.json'))).toBe(false);
    writeFileSync(path.join(root, 'desktop/runtime/sentinel'), 'previous runtime');
    await expect(stageDesktopRuntime(root, () => { throw new Error('build failed'); }, runtimeInput,
      nativeStage())).rejects.toThrow('build failed');
    expect(readFileSync(path.join(root, 'desktop/runtime/sentinel'), 'utf8')).toBe('previous runtime');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

for (const failure of ['promotion', 'cleanup', 'rollback'] as const) {
  test(`runtime ${failure} failure preserves the previous runtime or its recovery backup`, () => {
    const base = path.resolve(import.meta.dir, '../../.test-data/desktop-runtime-test');
    mkdirSync(base, { recursive: true });
    const root = mkdtempSync(path.join(base, 'swap-'));
    const previous = path.join(root, 'runtime');
    const incoming = path.join(root, 'incoming');
    mkdirSync(previous); mkdirSync(incoming);
    writeFileSync(path.join(previous, 'sentinel'), 'previous');
    writeFileSync(path.join(incoming, 'sentinel'), 'new');
    try {
      expect(() => promoteDesktopRuntime(incoming, previous, {
        rename: (source, destination) => {
          if ((failure === 'promotion' || failure === 'rollback') && source === incoming) throw new Error('promotion denied');
          if (failure === 'rollback' && source.includes('.previous-')) throw new Error('rollback denied');
          renameSync(source, destination);
        },
        remove: () => { throw new Error('cleanup denied'); },
      })).toThrow(failure === 'cleanup' ? 'cleanup failed' : failure === 'rollback' ? 'rollback failed' : 'promotion denied');
      if (failure === 'promotion') {
        expect(readFileSync(path.join(previous, 'sentinel'), 'utf8')).toBe('previous');
        expect(readFileSync(path.join(incoming, 'sentinel'), 'utf8')).toBe('new');
        expect(readdirSync(root).filter(name => name.includes('.previous-'))).toHaveLength(0);
      } else {
        const backups = readdirSync(root).filter(name => name.startsWith('runtime.previous-'));
        expect(backups).toHaveLength(1);
        expect(readFileSync(path.join(root, backups[0], 'sentinel'), 'utf8')).toBe('previous');
        if (failure === 'cleanup') expect(readFileSync(path.join(previous, 'sentinel'), 'utf8')).toBe('new');
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}

/**
 * Native platform staging is exercised through the injected producer. The real
 * producer builds an entire Bun single binary and is covered by the shared
 * producer's own budget tests; here we assert the desktop wiring contract.
 */
function nativeStage(options: { readonly omitManifest?: boolean } = {}) {
  return async (stageDir: string) => {
    mkdirSync(stageDir, { recursive: true });
    const qleverRoot = path.join(stageDir, 'qlever');
    mkdirSync(path.join(qleverRoot, 'bin'), { recursive: true });
    writeFileSync(path.join(qleverRoot, 'bin', 'xpod_qlever_local_runtime'), 'native');
    if (!options.omitManifest) writeFileSync(path.join(qleverRoot, 'manifest.json'), '{"kind":"fixture"}');
    writeFileSync(`${stageDir}-pack.json`, '[{"name":"@undefineds.co/xpod-darwin-arm64","version":"0.0.1","size":123}]');
    const budgetPath = `${stageDir}-pack-budget.json`;
    writeFileSync(budgetPath, '{"kind":"platform-package-publication-budget","ok":true,"packedBytes":123}');
    return { stageDir, qleverRuntimeOutputPath: path.join(qleverRoot, 'bin', 'xpod_qlever_local_runtime'), publicationBudgetPath: budgetPath };
  };
}

/**
 * The real packed-CLI path is proven by the test above. These cases focus on the
 * native platform wiring, so the workspace build/pack/install steps are supplied
 * deterministically; the runtime fixtures (Bun archive, authority, descriptor)
 * stay real.
 */
function simulatedWorkspaceRun(root: string) {
  return (command: string[], cwd: string) => {
    if (command[0] !== 'bun') throw new Error(`unexpected command: ${command.join(' ')}`);
    if (command[1] === 'pm') {
      const destination = command[command.indexOf('--destination') + 1];
      if (!destination) throw new Error('pack destination missing');
      writeFileSync(path.join(destination, 'package.tgz'), 'packed');
    }
    if (command[1] === 'install') {
      const cli = path.join(cwd, 'node_modules/@undefineds.co/xpod-cli/dist');
      mkdirSync(cli, { recursive: true });
      writeFileSync(path.join(cli, 'xpod.mjs'), 'export {}');
    }
    void root;
  };
}

function stageCase() {
  const base = path.resolve(import.meta.dir, '../../.test-data/desktop-runtime-test');
  mkdirSync(base, { recursive: true });
  const root = mkdtempSync(path.join(base, 'native-'));
  for (const name of ['xpod-client', 'xpod-cli']) {
    const packageRoot = path.join(root, 'packages', name);
    mkdirSync(packageRoot, { recursive: true });
    writeFileSync(path.join(packageRoot, 'package.json'), JSON.stringify({ name: `@undefineds.co/${name}`, version: '0.0.1' }));
  }
  mkdirSync(path.join(root, 'desktop'));
  return { root, runtimeInput: makeRuntimeFixture(root), run: simulatedWorkspaceRun(root) };
}

test('stage folds the accepted native platform package into the promoted runtime and retains measured evidence', async () => {
  const { root, runtimeInput, run } = stageCase();
  try {
    await stageDesktopRuntime(root, run, runtimeInput, nativeStage());
    const runtime = path.join(root, 'desktop/runtime');
    // Public CLI/client architecture is preserved, not replaced by the old server runtime.
    expect(existsSync(path.join(runtime, 'node_modules/@undefineds.co/xpod-cli/dist/xpod.mjs'))).toBe(true);
    expect(existsSync(path.join(runtime, 'bin/bun'))).toBe(true);
    // The accepted native payload and its manifest are part of the promoted runtime.
    expect(readFileSync(path.join(runtime, 'qlever/bin/xpod_qlever_local_runtime'), 'utf8')).toBe('native');
    expect(existsSync(path.join(runtime, 'qlever/manifest.json'))).toBe(true);
    // The producer's actual measured bytes are published beside the desktop build.
    expect(JSON.parse(readFileSync(path.join(root, 'desktop/runtime-pack.json'), 'utf8'))[0].size).toBe(123);
    expect(JSON.parse(readFileSync(path.join(root, 'desktop/runtime-pack-budget.json'), 'utf8')).packedBytes).toBe(123);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

const rejections = {
  // The producer's own verifyPlatformPackageBudget throws this message; the
  // desktop stage must surface it rather than publish a success budget.
  overbudget: async () => { throw new Error('Platform package exceeds project publication budget: tarball=213600000'); },
  'missing-artifact': async () => { throw new Error('QLever local runtime artifact does not exist'); },
  'missing-manifest': nativeStage({ omitManifest: true }),
} as const;

for (const [name, producer] of Object.entries(rejections)) {
  test(`native platform ${name} fails the desktop stage and never promotes or publishes a budget`, async () => {
    const { root, runtimeInput, run } = stageCase();
    // Pre-existing runtime must survive a failed stage.
    mkdirSync(path.join(root, 'desktop/runtime'), { recursive: true });
    writeFileSync(path.join(root, 'desktop/runtime/sentinel'), 'previous runtime');
    try {
      await expect(stageDesktopRuntime(root, run, runtimeInput, producer)).rejects.toThrow(
        name === 'missing-manifest' ? 'manifest' : name === 'missing-artifact' ? 'does not exist' : 'exceeds');
      // No progression: previous runtime intact and no success evidence on disk.
      expect(readFileSync(path.join(root, 'desktop/runtime/sentinel'), 'utf8')).toBe('previous runtime');
      expect(existsSync(path.join(root, 'desktop/runtime/qlever'))).toBe(false);
      expect(existsSync(path.join(root, 'desktop/runtime-pack.json'))).toBe(false);
      expect(existsSync(path.join(root, 'desktop/runtime-pack-budget.json'))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}
