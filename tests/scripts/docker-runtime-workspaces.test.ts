import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

describe('Docker runtime workspace packaging', () => {
  it('copies built workspace packages needed by runtime node_modules links', async () => {
    const dockerfile = await readFile(new URL('../../Dockerfile', import.meta.url), 'utf8');
    const runtimeStage = dockerfile.slice(dockerfile.indexOf('FROM qlever-local-runtime AS runtime-base'));

    expect(runtimeStage).toContain('COPY --from=build /app/packages ./packages');
    expect(runtimeStage).toContain('XPOD_QLEVER_LOCAL_RUNTIME_COMMAND=/opt/xpod/qlever/bin/xpod_qlever_local_runtime');
  });

  it('assembles each runtime from its dedicated production dependencies', async () => {
    const dockerfile = await readFile(new URL('../../Dockerfile', import.meta.url), 'utf8');

    expect(dockerfile).toContain('COPY --from=server-deps /app/node_modules ./node_modules');
    expect(dockerfile).toContain('COPY --from=agent-deps /app/node_modules ./node_modules');
    expect(dockerfile).not.toContain('rm -rf /app/node_modules');
  });
});
