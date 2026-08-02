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
      'CSS_REDIS_CLIENT=.../<nonzero>',
      'nonzero Redis DB index',
      'Redis DB 0',
      'object bucket',
      'Ingress',
      'Do not reuse the production `APP_ENV_FILE`',
      'release-acceptance-${GITHUB_SHA}',
      'release-acceptance.json',
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

  it('locks exact RC version, artifact, and required environment variable wording', async () => {
    const text = await loadReleaseDoc();

    expect(text).toContain('首次运行格式为 `0.3.68-rc.<run-number>`');
    expect(text).toContain('rerun 格式为 `0.3.68-rc.<run-number>.<run-attempt>`');
    expect(text).toContain('例如 `0.3.68-rc.41`，rerun 示例为 `0.3.68-rc.41.2`');
    expect(text).not.toContain('+<sha>');
    expect(text).not.toContain('+abcdef');
    expect(text).not.toMatch(/0\.3\.68-rc\.[^`\s]*\+sha/);

    expect(text).toContain('artifact name 是 `release-acceptance-${GITHUB_SHA}`');
    expect(text).toContain('artifact 内文件是 `release-acceptance.json`');
    expect(text).not.toContain('release-acceptance-${GITHUB_SHA}.json');

    expect(text).toContain('| Variable | `SEALOS_NAMESPACE` | 必填变量，推荐值 `xpod-rc` |');
    expect(text).toContain('| Variable | `XPOD_RUNTIME_SECRET_NAME` | 必填变量，推荐值 `xpod-rc-secret` |');
    expect(text).not.toContain('| Variable | `SEALOS_NAMESPACE` | 默认 `xpod-rc` |');
    expect(text).not.toContain('| Variable | `XPOD_RUNTIME_SECRET_NAME` | 默认 `xpod-rc-secret` |');
    expect(text).not.toContain('默认在 namespace `xpod-rc`');
  });
});
