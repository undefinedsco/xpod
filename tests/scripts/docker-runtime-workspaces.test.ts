import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

describe('Docker runtime workspace packaging', () => {
  it('copies built workspace packages needed by runtime node_modules links', async () => {
    const dockerfile = await readFile(new URL('../../Dockerfile', import.meta.url), 'utf8');
    const runtimeStage = dockerfile.slice(dockerfile.indexOf('FROM node:22-alpine AS runtime-base'));

    expect(runtimeStage).toContain('COPY --from=build /app/packages ./packages');
  });

  it('assembles each runtime from its dedicated production dependencies', async () => {
    const dockerfile = await readFile(new URL('../../Dockerfile', import.meta.url), 'utf8');

    expect(dockerfile).toContain('COPY --from=server-deps /app/node_modules ./node_modules');
    expect(dockerfile).toContain('COPY --from=agent-deps /app/node_modules ./node_modules');
    expect(dockerfile).not.toContain('rm -rf /app/node_modules');
  });
});
