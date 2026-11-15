import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

describe('Docker runtime workspace packaging', () => {
  it('includes authentication postinstall patches before installing dependencies', async () => {
    const dockerfile = await readFile(new URL('../../Dockerfile', import.meta.url), 'utf8');
    const ignore = await readFile(new URL('../../.dockerignore', import.meta.url), 'utf8');
    const manifest = JSON.parse(await readFile(new URL('../../package.json', import.meta.url), 'utf8'));
    const installStage = dockerfile.slice(0, dockerfile.indexOf('bun install --frozen-lockfile'));

    // Postinstall helpers live in TWO namespaces with DIFFERENT delivery rules:
    //   scripts/<file> -> needs its own COPY + its own .dockerignore re-include
    //   patches/<file> -> covered by the existing `COPY patches ./patches` and `!patches/**`
    // Each helper must be present in the build context BEFORE `bun install` runs.
    const postinstallScripts = [...manifest.scripts.postinstall.matchAll(/\bbun\s+((?:scripts|patches)\/[^\s;&|]+)/gu)]
      .map((match) => match[1]);
    expect(postinstallScripts.length).toBeGreaterThan(0);
    const patchScripts = postinstallScripts.filter(script => script.startsWith('scripts/'));
    const patchDirScripts = postinstallScripts.filter(script => script.startsWith('patches/'));
    expect(patchScripts.length).toBeGreaterThan(0);
    expect(patchDirScripts.length).toBeGreaterThan(0);
    for (const script of postinstallScripts) {
      expect(existsSync(path.join(process.cwd(), script)), `${script} must exist on disk`).toBe(true);
      expect(installStage, `${script} must be supplied before install runs`)
        .toContain('COPY patches ./patches');
    }
    for (const script of patchScripts) {
      expect(installStage, `${script} must exist before postinstall runs`).toContain(`COPY ${script} ./${script}`);
      expect(ignore, `${script} must be included in the Docker build context`).toContain(`!${script}`);
    }
    for (const script of patchDirScripts) {
      // delivered by the directory COPY, allowed by the patches/ re-include
      expect(installStage).not.toContain(`COPY ${script}`);
      expect(ignore).toContain('!patches/**');
    }
    expect(installStage).toContain('COPY patches ./patches');
    expect(ignore).toContain('!patches/**');
    expect(installStage).toContain('COPY desktop/package.json ./desktop/package.json');
    expect(ignore).toContain('!desktop/package.json');
  });

  it('installs the service workspace closure before copying it into the runtime image', async () => {
    const dockerfile = await readFile(new URL('../../Dockerfile', import.meta.url), 'utf8');
    expect(dockerfile).toContain('FROM node:22-bookworm AS build');
    expect(dockerfile).toContain('FROM qlever-local-runtime AS runtime');
    expect(dockerfile).toContain('COPY --from=bun /usr/local/bin/bun /usr/local/bin/bun');
    expect(dockerfile).toContain('bun --no-env-file dist/runtime/service-entry.js start');
    const runtimeStage = dockerfile.slice(dockerfile.indexOf('FROM qlever-local-runtime AS runtime'));

    expect(dockerfile).toContain('service-pack-cache service');
    expect(dockerfile).toContain('cd /service && bun install --production');
    expect(dockerfile).toContain('--dependency-root /service --runtime-only');
    expect(runtimeStage).toContain('COPY --from=build /service ./');
    expect(runtimeStage).not.toContain('COPY --from=build /app/packages');
    expect(runtimeStage).not.toContain('COPY --from=build /app/desktop');
    expect(runtimeStage).not.toContain('COPY --from=build /app/ui');
    expect(runtimeStage).toContain('XPOD_QLEVER_LOCAL_RUNTIME_COMMAND=/opt/xpod/qlever/bin/xpod_qlever_local_runtime');
  });

  it('includes every exact normal SDK cold/incremental COPY source in the build context', async () => {
    const ignore = await readFile(new URL('../../.dockerignore', import.meta.url), 'utf8');
    const lines = ignore.split(/\r?\n/u);
    expect(lines.includes('!scripts/')).toBe(false);
    expect(lines.includes('!scripts/**')).toBe(false);
    for (const file of [
      '.dockerignore',
      'scripts/lib/module-artifact-limits.json',
      'scripts/lib/independent-admission/normal-sdk-gates.json',
      'scripts/agentfs-native-ci/supervise.py',
      'docker/qlever-runtime-sdk/Dockerfile.normal',
      'docker/qlever-runtime-sdk/Dockerfile.normal.incremental',
      'docker/qlever-local-runtime/Dockerfile',
    ]) {
      expect(existsSync(path.join(new URL('../../', import.meta.url).pathname, file)), file).toBe(true);
      expect(lines.filter(line => line === `!${file}`), file).toHaveLength(1);
    }
    expect(lines).toContain('!qlever/');
    const dockerfiles = await Promise.all(['Dockerfile.normal', 'Dockerfile.normal.incremental'].map(file =>
      readFile(new URL(`../../docker/qlever-runtime-sdk/${file}`, import.meta.url), 'utf8')));
    for (const dockerfile of dockerfiles) {
      expect(dockerfile).toContain('COPY scripts/lib/independent-admission/normal-sdk-gates.json');
      expect(dockerfile).toContain('COPY scripts/lib/module-artifact-limits.json');
      expect(dockerfile).toContain('COPY scripts/agentfs-native-ci/supervise.py');
    }
  });

  it('starts compose services through Bun instead of Node', async () => {
    const composeFiles = await Promise.all([
      readFile(new URL('../../docker-compose.acceptance.yml', import.meta.url), 'utf8'),
      readFile(new URL('../../docker-compose.cluster.yml', import.meta.url), 'utf8'),
      readFile(new URL('../../docker-compose.standalone.yml', import.meta.url), 'utf8'),
    ]);

    for (const compose of composeFiles) {
      expect(compose).toContain('bun');
      expect(compose).not.toMatch(/\bnode dist\/(?:main|cli\/index)\.js/u);
    }
  });

  it('keeps standalone acceptance on its own issuer and the same service image', async () => {
    const compose = await readFile(new URL('../../docker-compose.acceptance.yml', import.meta.url), 'utf8');
    const standalone = compose.split('\n  standalone:\n')[1]?.split('\n  acceptance:\n')[0];

    expect(standalone).toBeDefined();
    expect(standalone).toContain('image: xpod:local-cloud-acceptance-current');
    expect(standalone).toContain('CSS_BASE_URL: http://standalone.localhost:16320/');
    expect(standalone).toContain('SOLID_OIDC_ISSUER: http://standalone.localhost:16320/');
    expect(standalone).not.toContain('depends_on:');
    expect(compose).not.toContain('XPOD_AUTH_MODE: open');
    expect(compose).not.toContain("XPOD_RDF_NATIVE_SPARQL_ENABLED: 'true'");
  });
});
