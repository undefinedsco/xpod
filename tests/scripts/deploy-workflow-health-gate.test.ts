import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

describe('production deployment workflow', () => {
  it('installs and verifies pgvector with the new image and runtime secret before rollout', async () => {
    const workflow = await readFile(new URL('../../.github/workflows/deploy.yml', import.meta.url), 'utf8');
    const job = await readFile(new URL('../../deploy/sealos/cloud/pgvector-job.yaml', import.meta.url), 'utf8');

    expect(workflow.match(/deploy\/sealos\/cloud\/pgvector-job\.yaml/g)).toHaveLength(2);
    expect(workflow.match(/MIGRATION_IMAGE_TAG/g)).toHaveLength(2);
    expect(workflow.indexOf('deploy/sealos/cloud/pgvector-job.yaml')).toBeLessThan(workflow.indexOf('kubectl apply -f /tmp/xpod-configmap.yaml'));
    expect(job).toContain('kind: Job');
    expect(job).toContain('image: ghcr.io/undefinedsco/xpod:MIGRATION_IMAGE_TAG');
    expect(job).toContain('name: CSS_SPARQL_ENDPOINT');
    expect(job).toContain('secretKeyRef:');
    expect(job).toContain('name: xpod-cloud-secret');
    expect(job).toContain('CREATE EXTENSION IF NOT EXISTS vector');
    expect(job).toContain("SELECT extversion FROM pg_extension WHERE extname = 'vector'");
    expect(workflow).not.toContain('console.log(process.env.CSS_SPARQL_ENDPOINT)');
    expect(job).not.toContain('console.log(process.env.CSS_SPARQL_ENDPOINT)');
  });

  it('checks each public service after the Kubernetes rollout', async () => {
    const workflow = await readFile(new URL('../../.github/workflows/deploy.yml', import.meta.url), 'utf8');

    expect(workflow.match(/name: Verify public service/g)).toHaveLength(2);
    expect(workflow).toContain('https://id.undefineds.co/service/status');
    expect(workflow).toContain('https://id.undefineds.cn/service/status');
  });
});
