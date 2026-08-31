import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

const readWorkflow = async (): Promise<string> =>
  readFile(new URL('../../.github/workflows/rdf-installed-image-conformance.yml', import.meta.url), 'utf8');

describe('RDF installed image conformance workflow', () => {
  it('accepts only immutable public image inputs without publish authority', async () => {
    const workflow = await readWorkflow();

    expect(workflow).toContain('qlever-local-runtime-image');
    expect(workflow).toContain('pg17-public-image');
    expect(workflow).toContain('docker.io/pgvector/pgvector@sha256:7ae6051efd0e60444282c27c7e141af07f322ce033300e727a49c3dd11075e38');
    expect(workflow).toContain('[A-Za-z0-9._:/-]+@sha256:[a-f0-9]{64}');
    expect(workflow).toContain('contents: read');
    expect(workflow).not.toContain('packages: write');
    expect(workflow).not.toContain('NPM_TOKEN');
    expect(workflow).not.toContain('NODE_AUTH_TOKEN');
    expect(workflow).not.toContain('publish-release');
    expect(workflow).not.toContain("docker pull '${{ inputs.");
    expect(workflow).toContain('docker pull "${QLEVER_LOCAL_RUNTIME_IMAGE}"');
    expect(workflow).toContain('docker pull "${PG17_PUBLIC_IMAGE}"');
  });

  it('builds the current server only into a runner-local immutable image', async () => {
    const workflow = await readWorkflow();

    expect(workflow).toContain('localhost:5000/xpod-installed:${{ github.sha }}');
    expect(workflow).toContain('ARTIFACT_DIR: /tmp/rdf-installed-image-conformance');
    expect(workflow).not.toContain('${{ runner.temp }}');
    expect(workflow).toContain('registry:2@sha256:');
    expect(workflow).toContain('docker push "${LOCAL_XPOD_IMAGE}"');
    expect(workflow).toContain('target: server');
    expect(workflow).toContain('load: true');
    expect(workflow).toContain('push: false');
    expect(workflow).toContain('cache-from: type=gha,scope=xpod-server-rdf-installed-conformance');
    expect(workflow).toContain('XPOD_QLEVER_LOCAL_RUNTIME_IMAGE=${{ inputs.qlever-local-runtime-image }}');
    expect(workflow).not.toContain('ghcr.io/undefinedsco/xpod:');
  });

  it('runs the installed public Local/Cloud gate and uploads its evidence', async () => {
    const workflow = await readWorkflow();

    expect(workflow).toContain('bun scripts/check-rdf-installed-image-conformance.ts');
    expect(workflow).toContain('XPOD_INSTALLED_IMAGE_REF: ${{ steps.local-image.outputs.ref }}');
    expect(workflow).toContain('XPOD_PG17_PUBLIC_IMAGE_REF: ${{ inputs.pg17-public-image }}');
    expect(workflow).toContain('qlever/tests/fixtures/qlever-semantic-conformance.cjs');
    expect(workflow).toContain('installed-image-conformance.json');
    expect(workflow).toContain('actions/upload-artifact@');
    expect(workflow).not.toContain('pg17-qlever-image');
    expect(workflow).not.toContain('xpod-rdf-postgres');
    expect(workflow).not.toContain('XPOD_PG17_QLEVER_IMAGE_REF');
  });

  it('pins every external action to an immutable commit', async () => {
    const workflow = await readWorkflow();
    const uses = workflow.split('\n').filter((line) => line.includes('uses:'));

    expect(uses.length).toBeGreaterThan(0);
    for (const line of uses) {
      const revision = line.split('@', 2)[1]?.trim().split(/\s+/, 1)[0];
      expect(revision, line).toMatch(/^[a-f0-9]{40}$/);
    }
  });
});
