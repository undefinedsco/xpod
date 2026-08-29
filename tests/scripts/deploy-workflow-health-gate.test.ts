import { readFile } from 'node:fs/promises';
import { parseDocument } from 'yaml';
import { describe, expect, it } from 'vitest';

describe('production deployment workflow', () => {
  it('is a manual digest-only recovery entry for non-enterprise .cn', async () => {
    const workflow = await readFile(new URL('../../.github/workflows/deploy.yml', import.meta.url), 'utf8');
    const parsed = parseDocument(workflow).toJSON() as any;

    expect(parsed.on.workflow_dispatch).toBeDefined();
    expect(parsed.on.workflow_call).toBeUndefined();
    expect(parsed.on.workflow_run).toBeUndefined();
    expect(parsed.on.workflow_dispatch.inputs.environment.options).toEqual([ 'cn' ]);
    expect(Object.keys(parsed.jobs)).toEqual([ 'deploy-cn' ]);
    expect(parsed.jobs['deploy-cn'].permissions.actions).toBe('read');
    expect(workflow).toContain('ghcr.io/undefinedsco/xpod@${{ inputs.image-digest }}');
    expect(workflow).toContain('gh run list');
    expect(workflow).toContain('Release Candidate');
    expect(workflow).toContain('release-acceptance-${TAG_SHA}');
    expect(workflow).toContain('node scripts/release-acceptance-manifest.cjs validate');
    expect(workflow).toContain('--xpod-image-digest "$TARGET_IMAGE"');
    expect(workflow).not.toMatch(/ghcr\.io\/undefinedsco\/xpod:(latest|\$\{\{ inputs\.version \}\})/);
  });

  it('checks the .cn public service after the Kubernetes rollout', async () => {
    const workflow = await readFile(new URL('../../.github/workflows/deploy.yml', import.meta.url), 'utf8');

    expect(workflow.match(/name: Verify public service/g)).toHaveLength(1);
    expect(workflow).toContain('PUBLIC_BASE_URL: https://id.undefineds.cn');
    expect(workflow).toContain('service_url="$PUBLIC_BASE_URL/service/status"');
    expect(workflow.match(/all\(\.status == "running"\)/g)).toHaveLength(1);
    expect(workflow.match(/\(map\(\.name\) \| sort\) == \["api", "css"\]/g)).toHaveLength(1);
    expect(workflow).toContain('/.well-known/openid-configuration');
    expect(workflow).toContain('/dashboard/');
    expect(workflow).toContain('/settings/');
    expect(workflow).toContain('/api/pod/settings/status');
    expect(workflow).toContain('deployment image does not match requested digest');
    expect(workflow).toContain('ready pod imageID does not contain requested digest');
  });

  it('does not expose public control over .co enterprise production or private assets', async () => {
    const workflow = await readFile(new URL('../../.github/workflows/deploy.yml', import.meta.url), 'utf8');

    expect(workflow).not.toContain('undefineds.co');
    expect(workflow).not.toContain('environment: co');
    expect(workflow).not.toMatch(/deploy-co|cloud\.enterprise|ccr\.ccs\.tencentyun\.com|xpod-rdf-postgres|TCR/i);
  });
});
