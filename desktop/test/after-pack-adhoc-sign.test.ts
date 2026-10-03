import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

describe('packaged macOS resource seal', () => {
  test('signs and strictly verifies the completed bundle after packing', async () => {
    const calls: Array<[string, string[]]> = [];
    const module = { exports: {} as unknown };
    vm.runInNewContext(readFileSync(path.join(import.meta.dir, '../scripts/after-pack-adhoc-sign.cjs'), 'utf8'), {
      module,
      require: (name: string) => name === 'node:path' ? path : { execFileSync: (command: string, args: string[]) => calls.push([command, args]) },
      console: { log() {} },
    });
    const hook = module.exports as (context: unknown) => Promise<void>;
    const context = { electronPlatformName: 'darwin', appOutDir: '/output with spaces', packager: { appInfo: { productFilename: 'Xpod' } } };
    await hook(context);
    expect(calls).toEqual([
      ['/usr/bin/codesign', ['--force', '--deep', '--sign', '-', '/output with spaces/Xpod.app']],
      ['/usr/bin/codesign', ['--verify', '--deep', '--strict', '--verbose=2', '/output with spaces/Xpod.app']],
    ]);
    await hook({ ...context, electronPlatformName: 'linux' });
    expect(calls).toHaveLength(2);
  });
});
