import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

describe('Docker runtime workspace packaging', () => {
  it('copies built workspace packages needed by runtime node_modules links', async () => {
    const dockerfile = await readFile(new URL('../../Dockerfile', import.meta.url), 'utf8');
    const runtimeStage = dockerfile.slice(dockerfile.indexOf('FROM node:22-alpine'));

    expect(runtimeStage).toContain('COPY --from=build /app/packages ./packages');
  });

  it('removes build-only dependencies before assembling the runtime image', async () => {
    const dockerfile = await readFile(new URL('../../Dockerfile', import.meta.url), 'utf8');
    const buildStage = dockerfile.slice(0, dockerfile.indexOf('FROM node:22-alpine'));

    expect(buildStage).toContain('rm -rf /app/node_modules');
    expect(buildStage).toContain('bun install --production --frozen-lockfile');
    expect(buildStage.indexOf('bun run build:ui')).toBeLessThan(buildStage.indexOf('bun install --production'));
  });
});
