import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { defaultXpodEnvPath, resolveXpodEnvPath } from '../../src/runtime/user-env';

describe('Xpod user env path', () => {
  it('uses the shared macOS Application Support config by default', () => {
    expect(defaultXpodEnvPath({ platform: 'darwin', homeDir: '/Users/alice', env: {} })).toBe(
      '/Users/alice/Library/Application Support/Xpod/.env',
    );
  });

  it('prefers an explicit file and then XPOD_ENV_FILE', () => {
    expect(resolveXpodEnvPath('./dev.env', { XPOD_ENV_FILE: '/shared/.env' })).toBe(path.resolve('./dev.env'));
    expect(resolveXpodEnvPath(undefined, { XPOD_ENV_FILE: '/shared/.env' })).toBe('/shared/.env');
  });
});
