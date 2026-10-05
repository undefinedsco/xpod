import { readFileSync, mkdtempSync, writeFileSync, existsSync, rmSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, it, vi } from 'vitest';
import { parseFullIntegrationInfra, fullIntegrationInfraEnv, checkFullIntegrationInfra, loadFullIntegrationInfra } from '../../scripts/helpers/full-integration-infra';

const text = `XPOD_FULL_PG_URL=postgres://fixture:secret@127.0.0.1:15432/fixture
CSS_REDIS_CLIENT=127.0.0.1:16379
CSS_REDIS_USERNAME=
CSS_REDIS_PASSWORD=
CSS_MINIO_ENDPOINT=http://127.0.0.1:19000
CSS_MINIO_ACCESS_KEY=fixture
CSS_MINIO_SECRET_KEY=secret
CSS_MINIO_BUCKET_NAME=fixture`;

describe('explicit external full integration infrastructure', () => {
  it('fails closed before Compose for an explicitly incomplete file in the real runner', () => {
    mkdirSync('.test-data/full-integration-infra', { recursive: true });
    const root = mkdtempSync(path.resolve('.test-data/full-integration-infra/case-'));
    const marker = path.join(root, 'docker-called');
    try {
      const file = path.join(root, 'infra.env');
      writeFileSync(file, 'CSS_MINIO_BUCKET_NAME=fixture');
      writeFileSync(path.join(root, 'docker'), `#!/bin/sh\ntouch '${marker}'\nexit 97\n`, { mode: 0o700 });
      const result = spawnSync('bun', ['--no-env-file', 'scripts/run-integration-full.ts'], {
        env: { ...process.env, XPOD_FULL_INFRA_ENV_FILE: file, PATH: `${root}:${process.env.PATH}` },
        encoding: 'utf8', timeout: 20000,
      });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('Full integration external configuration invalid');
      expect(existsSync(marker)).toBe(false);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  it('binds both replicas and child test environments while preserving the default Compose branch', () => {
    const source = readFileSync('scripts/run-integration-full.ts', 'utf8');
    expect(source).toContain('const startedInfra = !externalInfra && !reuseExistingInfra;');
    expect(source).toContain('!externalInfra && reuseRequested && await hasHealthyComposeInfra()');
    expect(source.match(/sparqlEndpoint: runtimeCloudDb/g)).toHaveLength(2);
    expect(source.match(/identityDbUrl: runtimeCloudDb/g)).toHaveLength(2);
    expect(source).toContain('...(externalInfra ? fullIntegrationInfraEnv(externalInfra) : {})');
    expect(source.indexOf('if (externalInfra) await checkFullIntegrationInfra(externalInfra)')).toBeLessThan(source.indexOf("await runCommand('docker', [...composeArgs, 'down'"));
  });
  it('maps one validated configuration to runtimes and test clients', () => {
    const config = parseFullIntegrationInfra(text);
    const env = fullIntegrationInfraEnv(config);
    expect(env.XPOD_FULL_PG_URL).toBe(config.XPOD_FULL_PG_URL);
    expect(env.XPOD_AGENT_DIRECTORY_TEST_REDIS_URL).toBe('redis://127.0.0.1:16379');
    expect(env.CSS_MINIO_BUCKET_NAME).toBe('fixture');
  });
  it.each([
    text.replace('CSS_MINIO_BUCKET_NAME=fixture', ''),
    text.replace('CSS_REDIS_PASSWORD=', ''),
    text + '\nUNRELATED=secret',
    text.replace('http://127.0.0.1:19000', 'file:///secret'),
  ])('rejects invalid input without exposing its contents', (input) => {
    expect(() => parseFullIntegrationInfra(input)).toThrow('Full integration external configuration invalid');
  });
  it('does not read ambient service values without an explicit file', async () => {
    await expect(loadFullIntegrationInfra(undefined)).resolves.toBeUndefined();
    await expect(loadFullIntegrationInfra('/missing/test-only-infra.env')).rejects.toThrow('Full integration external configuration invalid');
  });
  it('accepts three healthy services without any provisioning callback', async () => {
    const probes = { postgres: vi.fn().mockResolvedValue(true), redis: vi.fn().mockResolvedValue(true), s3: vi.fn().mockResolvedValue(true) };
    await expect(checkFullIntegrationInfra(parseFullIntegrationInfra(text), probes)).resolves.toBeUndefined();
    expect(probes.s3).toHaveBeenCalledOnce();
  });
  it('preserves authenticated Redis settings in the test URL', () => {
    const config = parseFullIntegrationInfra(text.replace('CSS_REDIS_USERNAME=', 'CSS_REDIS_USERNAME=user').replace('CSS_REDIS_PASSWORD=', 'CSS_REDIS_PASSWORD=p@ss'));
    const env = fullIntegrationInfraEnv(config);
    expect(env.XPOD_AGENT_DIRECTORY_TEST_REDIS_URL).toBe('redis://user:p%40ss@127.0.0.1:16379');
    expect(env.CSS_REDIS_CLIENT).toBe(env.XPOD_AGENT_DIRECTORY_TEST_REDIS_URL);
  });
  it('clears URL credentials when explicit authentication fields are empty', () => {
    const config = parseFullIntegrationInfra(text.replace('CSS_REDIS_CLIENT=127.0.0.1:16379', 'CSS_REDIS_CLIENT=redis://old:obsolete@127.0.0.1:16379'));
    const env = fullIntegrationInfraEnv(config);
    expect(env.CSS_REDIS_CLIENT).toBe('redis://127.0.0.1:16379');
    expect(env.CSS_REDIS_CLIENT).toBe(env.XPOD_AGENT_DIRECTORY_TEST_REDIS_URL);
  });
  it('fails closed with a fixed category and does not expose upstream errors', async () => {
    const probes = { postgres: vi.fn().mockRejectedValue(new Error('secret server details')), redis: vi.fn(), s3: vi.fn() };
    await expect(checkFullIntegrationInfra(parseFullIntegrationInfra(text), probes)).rejects.toThrow('Full integration external postgres unhealthy');
    expect(probes.redis).not.toHaveBeenCalled();
    expect(probes.s3).not.toHaveBeenCalled();
  });
  it('requires all three probes and rejects a missing bucket', async () => {
    const probes = { postgres: vi.fn().mockResolvedValue(true), redis: vi.fn().mockResolvedValue(true), s3: vi.fn().mockResolvedValue(false) };
    await expect(checkFullIntegrationInfra(parseFullIntegrationInfra(text), probes)).rejects.toThrow('Full integration external s3 unhealthy');
    expect(probes.postgres).toHaveBeenCalledOnce();
    expect(probes.redis).toHaveBeenCalledOnce();
  });
});
