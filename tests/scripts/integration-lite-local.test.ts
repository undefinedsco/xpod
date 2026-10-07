import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = path.resolve(__dirname, '../..');

describe('lite integration local runtime isolation', () => {
  it('regenerates Components.js metadata before starting the runtime', async () => {
    const script = await readFile(path.join(root, 'scripts/run-integration-lite-local.ts'), 'utf8');

    const buildIndex = script.indexOf("runCommand('bun', [ 'run', 'build:components' ]");
    const startIndex = script.indexOf("stack.start('local'");

    expect(buildIndex).toBeGreaterThanOrEqual(0);
    expect(buildIndex).toBeLessThan(startIndex);
  });

  it('uses absence of oidcIssuer to keep the lite stack standalone', async () => {
    const script = await readFile(path.join(root, 'scripts/run-integration-lite-local.ts'), 'utf8');

    expect(script).not.toContain('oidcIssuer');
    expect(script).not.toContain('XPOD_LOCAL_AUTO_PROVISION');
    expect(script).toContain('stack.start(');
    expect(script).not.toMatch(/await\s+stack\.start\(\s*\)/);
  });

  it('distinguishes managed and standalone full-runtime nodes by SOLID_OIDC_ISSUER', async () => {
    const script = await readFile(path.join(root, 'scripts/run-integration-full.ts'), 'utf8');

    const localManagedBlock = script.slice(
      script.indexOf("runtimeRoot: path.join(runtimeRoot, 'local')"),
      script.indexOf("runtimeRoot: path.join(runtimeRoot, 'standalone')"),
    );
    const standaloneBlock = script.slice(script.indexOf("runtimeRoot: path.join(runtimeRoot, 'standalone')"));

    expect(localManagedBlock).toContain('SOLID_OIDC_ISSUER');
    expect(localManagedBlock).not.toContain('XPOD_CLOUD_API_ENDPOINT');
    expect(standaloneBlock).toContain('SOLID_OIDC_ISSUER');
    expect(standaloneBlock).toContain('ports.standalone.gateway');
    expect(standaloneBlock).not.toContain('XPOD_LOCAL_AUTO_PROVISION');
  });

  it('provides a stable Gateway locator secret to the hermetic Cloud runtimes', async () => {
    const script = await readFile(path.join(root, 'scripts/run-integration-full.ts'), 'utf8');

    expect(script).toContain("XPOD_GATEWAY_LOCATOR_SECRET: 'integration-full-stable-gateway-locator-secret'");
    expect(script).toContain('env: { ...commonCloudEnv');
  });

  it('uses one owned full-run infrastructure configuration without reusing external listeners', async () => {
    const script = await readFile(path.join(root, 'scripts/run-integration-full.ts'), 'utf8');
    const { createFullInfrastructure } = await import('../helpers/fullIntegrationInfrastructure');
    const requested = { projectPrefix: 'existing-foreign-project', runPrefix: 'existing-run' };
    const ports = { postgres: 15432, redis: 16379, objectStore: 19000 };
    const first = createFullInfrastructure(ports, requested);
    const second = createFullInfrastructure(ports, requested);
    expect(first.projectName).not.toBe(requested.projectPrefix);
    expect(first.projectName).not.toBe(second.projectName);
    expect(first.runtimeRoot).not.toBe(second.runtimeRoot);
    expect(first.testEnv.XPOD_FULL_PG_URL).toBe(first.pgUrl);
    expect(script).not.toContain('XPOD_FULL_USE_EXISTING_INFRA');
    expect(script).not.toContain('hasHealthyComposeInfra');
    expect(script).toContain('const reserved = await readDockerPublishedTcpPorts()');
    expect(script.indexOf('await readDockerPublishedTcpPorts()')).toBeLessThan(script.indexOf('await allocateFullInfrastructure(reserved)'));
    expect(script).toContain('allocateFullInfrastructure(reserved)');
    expect(script).toContain('resolveFullRuntimePorts(reserved)');
    expect(script).toContain('...infra.testEnv');
    expect(script).toContain('CSS_REDIS_CLIENT: infra.redisAddress');
    expect(script).toContain('CSS_MINIO_ENDPOINT: infra.objectStoreEndpoint');
    expect(script).toContain('identityDbUrl: infra.pgUrl');
    expect(script).toContain("infra.composeArgs, 'exec', '-T', 'postgres', 'pg_isready'");
    expect(script).toContain("infra.composeArgs, 'exec', '-T', 'redis', 'redis-cli', 'ping'");
    expect(script).toContain('hasTcpService(infra.ports.postgres)');
    expect(script).toContain('hasWritableRedis(infra.ports.redis)');
    expect(script).toContain('probeMinio(infra.ports.objectStore)');
  });

});
