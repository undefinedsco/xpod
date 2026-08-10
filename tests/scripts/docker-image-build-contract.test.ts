import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

const readDockerfile = async (): Promise<string> =>
  readFile(new URL('../../Dockerfile', import.meta.url), 'utf8');

describe('Docker image build contract', () => {
  it('keeps the server as the default image target', async () => {
    const dockerfile = await readDockerfile();
    const stages = [ ...dockerfile.matchAll(/^FROM\s+\S+(?:\s+AS\s+(\S+))?/gmi) ];

    expect(stages.at(-1)?.[1]).toBe('server');
  });

  it('separates optional agent dependencies from the server', async () => {
    const [ dockerfile, packageJson ] = await Promise.all([
      readDockerfile(),
      readFile(new URL('../../package.json', import.meta.url), 'utf8'),
    ]);
    const manifest = JSON.parse(packageJson) as {
      peerDependencies: Record<string, string>;
      peerDependenciesMeta: Record<string, { optional?: boolean }>;
    };

    expect(dockerfile).toMatch(/FROM\s+\S+\s+AS\s+server-deps[\s\S]*bun install --production --omit optional --omit peer --frozen-lockfile/i);
    expect(dockerfile).toMatch(/FROM\s+\S+\s+AS\s+agent-deps[\s\S]*bun install --production --frozen-lockfile/i);
    expect(dockerfile).toMatch(/FROM\s+\S+\s+AS\s+agent-runner/i);
    expect(Object.keys(manifest.peerDependencies).every((dependency) =>
      manifest.peerDependenciesMeta[dependency]?.optional === true)).toBe(true);
  });

  it('uses BuildKit package caches and does not reinstall inside ui', async () => {
    const [ dockerfile, packageJson ] = await Promise.all([
      readDockerfile(),
      readFile(new URL('../../package.json', import.meta.url), 'utf8'),
    ]);
    const manifest = JSON.parse(packageJson) as { scripts: Record<string, string> };

    expect(dockerfile).toContain('--mount=type=cache,target=/root/.bun/install/cache');
    expect(dockerfile).toMatch(/apt-get install[^\n]*python3 make g\+\+ cmake node-gyp/);
    expect(manifest.scripts['build:ui']).toBe('bun run --cwd ui build:all');
    expect(manifest.scripts['build:ui']).not.toContain('bun install');
  });

  it('builds the server target with persistent CI layer caching', async () => {
    const workflow = await readFile(new URL('../../.github/workflows/release.yml', import.meta.url), 'utf8');
    const buildJob = workflow.slice(workflow.indexOf('  build-and-push:'), workflow.indexOf('  publish-npm:'));

    expect(buildJob).not.toContain('continue-on-error: true');
    expect(buildJob).toContain('uses: docker/setup-buildx-action@v3');
    expect(buildJob).toMatch(/uses: docker\/build-push-action@v6[\s\S]*?target: server/);
    expect(buildJob).toContain('cache-from: type=gha,scope=xpod-server');
    expect(buildJob).toContain('cache-to: type=gha,mode=max,scope=xpod-server');
  });
});
