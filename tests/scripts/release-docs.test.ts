import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(__dirname, '../..');
const releaseDocPath = path.join(repoRoot, 'docs/RELEASE.md');

async function loadReleaseDoc(): Promise<string> {
  return readFile(releaseDocPath, 'utf8');
}

describe('release lifecycle documentation', () => {
  it('documents RC setup, isolation, acceptance evidence, and digest-only promotion', async () => {
    const text = await loadReleaseDoc();

    for (const expected of [
      'release/<version>',
      'npm `next`',
      '0.3.68-rc.',
      'https://rc.id.undefineds.co',
      'GitHub Environment `rc`',
      '`KUBE_CONFIG_DATA`',
      '`APP_ENV_FILE`',
      '`SEALOS_NAMESPACE`',
      '`XPOD_RUNTIME_SECRET_NAME`',
      '`XPOD_RC_SCALE_TO_ZERO`',
      '`XPOD_SETTINGS_E2E_ALICE_STATE`',
      '`XPOD_SETTINGS_E2E_BOB_STATE`',
      '`XPOD_SETTINGS_E2E_ALICE_POD_URL`',
      '`XPOD_SETTINGS_E2E_TEST_API_KEY`',
      '`xpod-rc`',
      '`xpod-rc-secret`',
      'physical PostgreSQL',
      'logical database or schema',
      'Redis DB',
      'object bucket',
      'Ingress',
      'Do not reuse the production `APP_ENV_FILE`',
      'release-acceptance-${GITHUB_SHA}.json',
      '`deployed-digest`',
      'accepted digest',
      'stable tag',
      'exact commit',
      'rollback',
      'scale-to-zero',
      'diagnostics',
    ]) {
      expect(text).toContain(expected);
    }

    expect(text).toContain('ghcr.io/undefinedsco/xpod@sha256:');
    expect(text).toContain('git tag -s v0.3.68 <accepted-sha>');
    expect(text).toContain('git push origin v0.3.68');
    expect(text).not.toContain('npm version patch');
    expect(text).not.toContain('npm version minor');
    expect(text).not.toContain('npm version major');
  });
});
