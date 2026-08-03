import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

describe('production deployment workflow', () => {
  it('checks each public service after the Kubernetes rollout', async () => {
    const workflow = await readFile(new URL('../../.github/workflows/deploy.yml', import.meta.url), 'utf8');

    expect(workflow.match(/name: Verify public service/g)).toHaveLength(2);
    expect(workflow).toContain('https://id.undefineds.co/service/status');
    expect(workflow).toContain('https://id.undefineds.cn/service/status');
    expect(workflow.match(/all\(\.status == "running"\)/g)).toHaveLength(2);
    expect(workflow.match(/\(map\(\.name\) \| sort\) == \["api", "css"\]/g)).toHaveLength(2);
  });
});
