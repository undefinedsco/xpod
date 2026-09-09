import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { jsEntrypointArgs, resolveJsRuntime } from '../../src/runtime/js-runtime';

describe('Bun-first service runtime', () => {
  it('reuses the current Bun executable without probing Node or PATH', () => {
    expect(resolveJsRuntime({ isBun: true, execPath: '/runtime/bun', findBun: () => { throw new Error('unexpected probe'); } }))
      .toEqual({ command: '/runtime/bun', isBun: true });
  });
  it('prefers installed Bun even when launched through Node', () => {
    expect(resolveJsRuntime({ isBun: false, execPath: '/runtime/node', findBun: () => '/runtime/bun' }))
      .toEqual({ command: '/runtime/bun', isBun: true });
  });
  it('keeps a Node-only compatibility path when Bun is absent', () => {
    expect(resolveJsRuntime({ isBun: false, execPath: '/runtime/node', findBun: () => undefined }))
      .toEqual({ command: '/runtime/node', isBun: false });
  });
  it('loads TypeScript directly in Bun, only preloading ts-node for Node', () => {
    expect(jsEntrypointArgs('/app/api.ts', true)).toEqual(['/app/api.ts']);
    expect(jsEntrypointArgs('/app/api.ts', false)).toEqual(['-r', expect.stringContaining('ts-node'), '/app/api.ts']);
    expect(jsEntrypointArgs('/app/api.js', false)).toEqual(['/app/api.js']);
  });
  it('routes both supervised entrypoints through the shared runtime and CSS adapter', () => {
    for (const entry of ['src/main.ts', 'src/cli/commands/start.ts']) {
      const source = readFileSync(entry, 'utf8');
      expect(source).toContain('resolveJsRuntime()');
      expect(source).toContain("cssBinary: '__internal-css'");
      expect(source).not.toContain('XPOD_NODE_BINARY');
    }
    const cli = readFileSync('src/cli/index.ts', 'utf8');
    expect(cli).toContain('ensureBunUndiciCompat()');
    expect(cli).toContain('ensureBunCommunitySolidServerJwkCompat(css)');
  });
});
