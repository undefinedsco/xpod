import { readFile } from 'node:fs/promises';
import { parseDocument } from 'yaml';
import { describe, expect, it } from 'vitest';

const workflowUrl = new URL('../../.github/workflows/release.yml', import.meta.url);

async function loadWorkflow() {
  const text = await readFile(workflowUrl, 'utf8');
  return {
    text,
    parsed: parseDocument(text).toJSON() as any,
  };
}

function runText(job: any): string {
  return (job.steps ?? [])
    .map((step: any) => step.run)
    .filter((run: unknown): run is string => typeof run === 'string')
    .join('\n');
}

describe('stable release promotion workflow', () => {
  it('validates exact-SHA release candidate acceptance before publishing', async () => {
    const { parsed } = await loadWorkflow();
    const guard = parsed.jobs.promotion_guard;
    const text = runText(guard);

    expect(parsed.on.push.tags).toEqual([ 'v*' ]);
    expect(guard.permissions).toEqual({
      actions: 'read',
      contents: 'read',
    });
    expect(text).toContain('gh run list');
    expect(text).toContain('--workflow "Release Candidate"');
    expect(text).toContain('--commit "$TAG_SHA"');
    expect(text).toContain('release-acceptance-${TAG_SHA}');
    expect(text).toContain('release-acceptance.json');
    expect(text).toContain('node scripts/release-acceptance-manifest.cjs validate');
    expect(text).toContain('--source-ref "$TAG_SHA"');
    expect(text).toContain('--xpod-image-digest "$XPOD_IMAGE_REF"');
    expect(text).not.toContain('--require-postgres-image');
    expect(guard.outputs).toMatchObject({
      version: expect.stringContaining('version'),
      image_digest: expect.stringContaining('image_digest'),
    });
  });

  it('promotes the accepted GHCR digest without rebuilding the server image', async () => {
    const { parsed } = await loadWorkflow();
    const promote = parsed.jobs.promote_image;
    const text = runText(promote);

    expect(promote.needs).toEqual([
      'promotion_guard',
      'publish_npm_latest',
      'verify_npm_consumer_node',
      'verify_npm_consumer_bun',
    ]);
    expect(text).toContain('docker buildx imagetools create');
    expect(text).toContain('ghcr.io/undefinedsco/xpod@${ACCEPTED_IMAGE_DIGEST}');
    expect(text).toContain('--tag "ghcr.io/undefinedsco/xpod:${TAG_VERSION}"');
    expect(text).toContain('--tag "ghcr.io/undefinedsco/xpod:latest"');
    expect(text).not.toMatch(/docker build\b|docker\/build-push-action/);
  });

  it('keeps npm latest checks but does not auto-deploy public or enterprise production', async () => {
    const { text, parsed } = await loadWorkflow();
    const publish = parsed.jobs.publish_npm_latest;

    expect(runText(publish)).toContain('bun run check:platform-package-version');
    expect(runText(publish)).toContain('bun run build');
    expect(runText(publish)).toContain('node scripts/publish-release.cjs --skip-build');
    expect(parsed.jobs.deploy_production_co).toBeUndefined();
    expect(text).not.toContain('./.github/workflows/deploy.yml');
    expect(text).not.toMatch(/cloud\.enterprise|ccr\.ccs\.tencentyun\.com|xpod-rdf-postgres|TCR/i);
  });
});
