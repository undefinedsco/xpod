import { makeRuntimeFixture } from './bun-runtime-fixture';
import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { stageDesktopRuntime, promoteDesktopRuntime } from '../scripts/stage-runtime';

test('normal packed CLI resolves its installed client after temporary archives are removed', () => {
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
    stageDesktopRuntime(root, undefined, runtimeInput);
    const entry = path.join(root, 'desktop/runtime/node_modules/@undefineds.co/xpod-cli/dist/xpod.mjs');
    const result = spawnSync('bun', [entry], { cwd: root });
    expect(result.status).toBe(0);
    expect(result.stdout.toString().trim()).toBe('42');
    expect(existsSync(path.join(root, 'desktop/runtime/package.json'))).toBe(false);
    writeFileSync(path.join(root, 'desktop/runtime/sentinel'), 'previous runtime');
    expect(() => stageDesktopRuntime(root, () => { throw new Error('build failed'); }, runtimeInput)).toThrow('build failed');
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
