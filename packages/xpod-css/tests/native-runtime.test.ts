import { it, expect } from 'bun:test';
import { mkdirSync, mkdtempSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import path from 'node:path';
import { bindPackagedCssNativeRuntime } from '../../../src/runtime/css-native-runtime';

it('selects only a declared regular packaged runtime and keeps an explicit deployment binding', () => {
  const base = path.resolve(import.meta.dir, '../../../.test-data/css-module-resources');
  mkdirSync(base, { recursive: true });
  const root = mkdtempSync(path.join(base, 'native-'));
  const relative = 'native/qlever/bin/xpod_qlever_local_runtime';
  try {
    writeFileSync(path.join(root, 'package.json'), JSON.stringify({ xpodModule: { id: 'css', files: [] } }));
    expect(() => bindPackagedCssNativeRuntime(root, {})).toThrow('not declared');
    const override = { XPOD_QLEVER_LOCAL_RUNTIME_COMMAND: '/deployment/runtime' };
    bindPackagedCssNativeRuntime(root, override);
    expect(override.XPOD_QLEVER_LOCAL_RUNTIME_COMMAND).toBe('/deployment/runtime');
    writeFileSync(path.join(root, 'package.json'), JSON.stringify({ xpodModule: { id: 'css', files: [{ path: relative }] } }));
    mkdirSync(path.dirname(path.join(root, relative)), { recursive: true });
    writeFileSync(path.join(root, relative), 'controlled native file');
    const env: NodeJS.ProcessEnv = {};
    bindPackagedCssNativeRuntime(root, env);
    expect(env.XPOD_QLEVER_LOCAL_RUNTIME_COMMAND).toBe(path.join(root, relative));
    rmSync(path.join(root, relative));
    symlinkSync(path.join(root, 'package.json'), path.join(root, relative));
    expect(() => bindPackagedCssNativeRuntime(root, {})).toThrow('not regular');
  } finally { rmSync(root, { recursive: true }); }
});

it('rejects a declared runtime escaping through an ancestor directory', () => {
  const base = path.resolve(import.meta.dir, '../../../.test-data/css-module-resources');
  mkdirSync(base, { recursive: true });
  const scratch = mkdtempSync(path.join(base, 'native-escape-'));
  const root = path.join(scratch, 'package');
  try {
    mkdirSync(path.join(root, 'native'), { recursive: true });
    mkdirSync(path.join(scratch, 'outside/bin'), { recursive: true });
    writeFileSync(path.join(scratch, 'outside/bin/xpod_qlever_local_runtime'), 'controlled outside file');
    symlinkSync(path.join(scratch, 'outside'), path.join(root, 'native/qlever'));
    writeFileSync(path.join(root, 'package.json'), JSON.stringify({ xpodModule: { id: 'css', files: [{ path: 'native/qlever/bin/xpod_qlever_local_runtime' }] } }));
    expect(() => bindPackagedCssNativeRuntime(root, {})).toThrow('outside its package');
  } finally { rmSync(scratch, { recursive: true }); }
});
