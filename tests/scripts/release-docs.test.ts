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
      '0.4.0-rc.',
      'npm `rc`',
      'npm `next`',
      '`stable-staging`',
      'npm `latest`',
      '`@undefineds.co/xpod-darwin-arm64`',
      'macOS ARM64',
      'RDF、FTS、VEC Local conformance',
      'https://id-rc.undefineds.co',
      'https://pods-rc.undefineds.co',
      'https://api-rc.undefineds.co',
      'GitHub Environment `rc`',
      '`KUBE_CONFIG_DATA`',
      '`APP_ENV_FILE`',
      '`XPOD_RC_SEED_CONFIG`',
      '`XPOD_LIVE_PROVIDER_API_KEY_CONFIG`',
      '`XPOD_AI_PROXY_URL`',
      '`NPM_TOKEN`',
      '未签名、未 notarize',
      '`SEALOS_NAMESPACE`',
      '`XPOD_RUNTIME_SECRET_NAME`',
      '`XPOD_RC_SCALE_TO_ZERO`',
      '`xpod-rc`',
      '`xpod-rc-secret`',
      '`xpod-rc-seed`',
      '`CSS_SEED_CONFIG=/app/config/seeds/rc.json`',
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
      '`pod-read-write`',
      '`gateway-key`',
      '`ai-connections`',
      'accepted digest',
      'stable tag',
      'exact commit',
      'rollback',
      'scale-to-zero',
      'diagnostics',
    ]) {
      expect(text).toContain(expected);
    }

    expect(text).toContain('不要配置 `XPOD_SETTINGS_E2E_ALICE_STATE`');
    expect(text).toContain('不要配置 `XPOD_SETTINGS_E2E_BOB_STATE`');
    expect(text).not.toContain('XPOD_SETTINGS_E2E_ALICE_POD_URL');
    expect(text).not.toContain('XPOD_SETTINGS_E2E_TEST_API_KEY');

    expect(text).toContain('ghcr.io/undefinedsco/xpod@sha256:');
    expect(text).toContain('git tag -s v0.4.0 <accepted-sha>');
    expect(text).toContain('git push origin v0.4.0');
    expect(text).not.toContain('npm version patch');
    expect(text).not.toContain('npm version minor');
    expect(text).not.toContain('npm version major');
    expect(text).not.toContain('RC 不发布 npm');
  });

  it('locks exact RC version, artifact, and required environment variable wording', async () => {
    const text = await loadReleaseDoc();

    expect(text).toContain('首次运行格式为 `0.4.0-rc.<run-number>`');
    expect(text).toContain('rerun 格式为 `0.4.0-rc.<run-number>.<run-attempt>`');
    expect(text).toContain('例如 `0.4.0-rc.41`，rerun 示例为 `0.4.0-rc.41.2`');
    expect(text).not.toContain('+<sha>');
    expect(text).not.toContain('+abcdef');
    expect(text).not.toMatch(/0\.4\.0-rc\.[^`\s]*\+sha/);

    expect(text).toContain('artifact name 是 `release-acceptance-${GITHUB_SHA}`');
    expect(text).toContain('artifact 内文件是 `release-acceptance.json`');
    expect(text).not.toContain('release-acceptance-${GITHUB_SHA}.json');

    expect(text).toContain('| Variable | `SEALOS_NAMESPACE` | 必填变量，填写 kubeconfig 的固定 namespace，例如 `ns-1yl0rye9` |');
    expect(text).toContain('| Variable | `XPOD_RUNTIME_SECRET_NAME` | 必填变量，推荐值 `xpod-rc-secret` |');
    expect(text).toContain('| Secret | `XPOD_RC_SEED_CONFIG` | 固定 RC seed JSON，必须包含 Alice 和 Bob 账号及 Pod 名称 |');
    expect(text).toContain('| Secret | `XPOD_LIVE_PROVIDER_API_KEY_CONFIG` | 真实 AI Provider 验收配置，格式同 `scripts/live-provider-api-key.example`；用于证明 `/v1/chat/completions` 真可用 |');
    expect(text).not.toContain('| Variable | `SEALOS_NAMESPACE` | 默认 `xpod-rc` |');
    expect(text).not.toContain('| Variable | `XPOD_RUNTIME_SECRET_NAME` | 默认 `xpod-rc-secret` |');
    expect(text).not.toContain('默认在 namespace `xpod-rc`');
    expect(text).not.toContain('推荐值 `xpod-rc`');
  });

  it('treats managed Local provisioning, Account UI, and Gateway key recovery as one release contract', async () => {
    const text = await loadReleaseDoc();

    for (const expected of [
      '`static/app`',
      '`signalApiUrl`',
      '`routeAccessToken`',
      '`cluster_node.pod_base_urls`',
      '`cluster_node.connectivity_status`',
      '`cluster_service_token`',
      '`XPOD_GATEWAY_LOCATOR_SECRET`',
      '同一个镜像',
      '不得只替换静态文件',
    ]) {
      expect(text).toContain(expected);
    }
  });
});
