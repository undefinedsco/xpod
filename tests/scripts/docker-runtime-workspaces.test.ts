import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

describe('Docker runtime workspace packaging', () => {
  it('includes authentication postinstall patches before installing dependencies', async () => {
    const dockerfile = await readFile(new URL('../../Dockerfile', import.meta.url), 'utf8');
    const ignore = await readFile(new URL('../../.dockerignore', import.meta.url), 'utf8');
    const installStage = dockerfile.slice(0, dockerfile.indexOf('bun install --frozen-lockfile'));

    expect(installStage).toContain('COPY scripts/patch-inrupt-authn-refresh.js ./scripts/patch-inrupt-authn-refresh.js');
    expect(installStage).toContain('COPY scripts/patch-inrupt-authn-transport.js ./scripts/patch-inrupt-authn-transport.js');
    expect(installStage).toContain('COPY patches ./patches');
    expect(ignore).toContain('!patches/**');
    expect(ignore).toContain('!scripts/patch-inrupt-authn-refresh.js');
    expect(ignore).toContain('!scripts/patch-inrupt-authn-transport.js');
    expect(installStage).toContain('COPY desktop/package.json ./desktop/package.json');
    expect(ignore).toContain('!desktop/package.json');
  });

  it('copies built workspace packages needed by runtime node_modules links', async () => {
    const dockerfile = await readFile(new URL('../../Dockerfile', import.meta.url), 'utf8');
    expect(dockerfile).toContain('FROM node:22-bookworm AS build');
    expect(dockerfile).toContain('FROM qlever-local-runtime AS runtime');
    expect(dockerfile).toContain('COPY --from=bun /usr/local/bin/bun /usr/local/bin/bun');
    expect(dockerfile).toContain('bun --no-env-file dist/cli/index.js start');
    const runtimeStage = dockerfile.slice(dockerfile.indexOf('FROM qlever-local-runtime AS runtime'));

    expect(runtimeStage).toContain('COPY --from=build /app/packages ./packages');
    expect(runtimeStage).toContain('COPY --from=build /app/desktop/package.json ./desktop/package.json');
    expect(runtimeStage).toContain('COPY --from=build /app/ui/package.json ./ui/package.json');
    expect(runtimeStage).toContain('XPOD_QLEVER_LOCAL_RUNTIME_COMMAND=/opt/xpod/qlever/bin/xpod_qlever_local_runtime');
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
