import { createRequire } from 'node:module';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const launcher = require('../../bin/xpod.js') as {
  resolveJsCliLaunch(options: {
    execPath: string
    isBun: boolean
    findBunExecutable: () => Promise<string | undefined>
  }): Promise<{ command: string; args: string[]; isBun: boolean }>
};

describe('xpod bin launcher', () => {
  it('runs the JS CLI through the current Bun runtime', async () => {
    await expect(launcher.resolveJsCliLaunch({
      execPath: '/runtime/bun',
      isBun: true,
      findBunExecutable: async () => { throw new Error('unexpected Bun probe'); },
    })).resolves.toEqual({
      command: '/runtime/bun',
      args: [path.resolve(process.cwd(), 'dist/cli/index.js')],
      isBun: true,
    });
  });

  it('prefers an installed Bun runtime for JS CLI fallback when invoked by Node', async () => {
    await expect(launcher.resolveJsCliLaunch({
      execPath: '/runtime/node',
      isBun: false,
      findBunExecutable: async () => '/usr/local/bin/bun',
    })).resolves.toEqual({
      command: '/usr/local/bin/bun',
      args: [path.resolve(process.cwd(), 'dist/cli/index.js')],
      isBun: true,
    });
  });

  it('uses Node for JS CLI fallback only when Bun is unavailable', async () => {
    await expect(launcher.resolveJsCliLaunch({
      execPath: '/runtime/node',
      isBun: false,
      findBunExecutable: async () => undefined,
    })).resolves.toEqual({
      command: '/runtime/node',
      args: [path.resolve(process.cwd(), 'dist/cli/index.js')],
      isBun: false,
    });
  });
});
