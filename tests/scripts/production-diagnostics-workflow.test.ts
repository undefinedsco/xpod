import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

describe('production diagnostics workflow', () => {
  it('captures pod state and previous container logs without mutating the cluster', async () => {
    const workflow = await readFile(new URL('../../.github/workflows/diagnose-production.yml', import.meta.url), 'utf8');

    expect(workflow).toContain('kubectl -n "$SEALOS_NAMESPACE" get deploy,rs,pods -o wide');
    expect(workflow).toContain('--previous');
    expect(workflow).not.toContain('kubectl apply');
  });
});
