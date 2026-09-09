import { execFile as execFileCallback } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';

const execFile = promisify(execFileCallback);
const repoRoot = path.resolve(__dirname, '../..');
const scriptPath = path.join(repoRoot, 'scripts/patch-shared-inngest-rc.cjs');
const roots: string[] = [];

async function patch(input: Record<string, any>): Promise<Record<string, any>> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'xpod-inngest-rc-'));
  roots.push(root);
  const inputPath = path.join(root, 'input.json');
  const outputPath = path.join(root, 'output.json');
  await writeFile(inputPath, JSON.stringify(input));
  await execFile('node', [ scriptPath, '--input', inputPath, '--output', outputPath, '--secret-name', 'runtime-rc' ], { cwd: repoRoot });
  return JSON.parse(await readFile(outputPath, 'utf8'));
}

describe('shared Inngest RC patch', () => {
  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  it('adds one RC event key and SDK URL without replacing production configuration', async () => {
    const source = {
      apiVersion: 'apps/v1', kind: 'Deployment', metadata: { name: 'xpod-inngest', namespace: 'assigned' },
      spec: { template: { spec: { containers: [{
        name: 'inngest',
        args: [ 'start', '--event-key', '$(XPOD_INNGEST_EVENT_KEY)', '--sdk-url', 'http://xpod/api/inngest' ],
        env: [{ name: 'KEEP_ME', value: 'yes' }],
      }] } } },
    };

    const once = await patch(source);
    const twice = await patch(once);
    const container = twice.spec.template.spec.containers[0];
    expect(container.env).toEqual(expect.arrayContaining([
      { name: 'KEEP_ME', value: 'yes' },
      { name: 'XPOD_RC_INNGEST_EVENT_KEY', valueFrom: { secretKeyRef: { name: 'runtime-rc', key: 'XPOD_INNGEST_EVENT_KEY' } } },
    ]));
    expect(container.env.filter((entry: any) => entry.name === 'XPOD_RC_INNGEST_EVENT_KEY')).toHaveLength(1);
    expect(container.args).toEqual(expect.arrayContaining([
      '--event-key', '$(XPOD_INNGEST_EVENT_KEY)',
      '--sdk-url', 'http://xpod/api/inngest',
      '$(XPOD_RC_INNGEST_EVENT_KEY)', 'http://xpod-rc/api/inngest',
    ]));
    expect(container.args.filter((arg: string) => arg === '$(XPOD_RC_INNGEST_EVENT_KEY)')).toHaveLength(1);
    expect(container.args.filter((arg: string) => arg === 'http://xpod-rc/api/inngest')).toHaveLength(1);
  });
});
