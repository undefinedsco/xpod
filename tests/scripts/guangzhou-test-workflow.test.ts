import { readFile } from 'node:fs/promises';
import { parseDocument } from 'yaml';
import { describe, expect, it } from 'vitest';

describe('Guangzhou test deployment workflow', () => {
  it('serializes only runs from the same workflow and branch', async () => {
    const workflow = await readFile(new URL('../../.github/workflows/guangzhou-test.yml', import.meta.url), 'utf8');
    const parsed = parseDocument(workflow).toJSON() as any;

    expect(parsed.concurrency).toEqual({
      group: 'deploy-${{ github.workflow }}-${{ github.ref }}',
      'cancel-in-progress': false,
    });
  });

  it('keeps the non-root Xpod runtime on its writable data mount', async () => {
    const workflow = await readFile(new URL('../../.github/workflows/guangzhou-test.yml', import.meta.url), 'utf8');
    const parsed = parseDocument(workflow).toJSON() as any;
    const deploy = parsed.jobs.deploy.steps.find((step: any) => step.name === 'Deploy immutable image');

    expect(deploy?.run).toContain('patch "deployment/$GZ_DEPLOYMENT"');
    expect(deploy?.run).toContain("name: 'CSS_ROOT_FILE_PATH'");
    expect(deploy?.run).toContain("'/app/data'");
    expect(deploy?.run.indexOf('patch "deployment/$GZ_DEPLOYMENT"'))
      .toBeLessThan(deploy?.run.indexOf('set image "deployment/$GZ_DEPLOYMENT"'));
  });

  it('keeps R2 credentials in the existing Guangzhou runtime secret', async () => {
    const workflow = await readFile(new URL('../../.github/workflows/guangzhou-test.yml', import.meta.url), 'utf8');
    const parsed = parseDocument(workflow).toJSON() as any;
    const validate = parsed.jobs.deploy.steps.find((step: any) => step.name === 'Validate deployment boundary');

    expect(parsed.env.GZ_STORAGE_SECRET).toBe('xpod-rc-secret');
    expect(validate?.run).toContain('storage_secret_refs=');
    expect(validate?.run).toContain('grep -Fxq "$GZ_STORAGE_SECRET"');
    expect(validate?.run).toContain('xpod-data:/app/data');
    expect(workflow).not.toContain('CSS_MINIO_SECRET_KEY:');
    expect(workflow).not.toContain('CSS_MINIO_ACCESS_KEY:');
  });
});
