import { execFile as execFileCallback } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { parseAllDocuments } from 'yaml';
import { afterEach, describe, expect, it } from 'vitest';

const execFile = promisify(execFileCallback);
const repoRoot = path.resolve(__dirname, '../..');
const scriptPath = path.join(repoRoot, 'scripts/render-rc-manifests.cjs');
const overlayPath = path.join(repoRoot, 'deploy/sealos/rc');
const tempRoots: string[] = [];

async function render(namespace: string, secretName: string): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'xpod-rc-render-'));
  tempRoots.push(root);
  const outputPath = path.join(root, 'rendered.yaml');
  await execFile('node', [
    scriptPath,
    '--overlay', overlayPath,
    '--output', outputPath,
    '--namespace', namespace,
    '--secret-name', secretName,
  ], { cwd: repoRoot });
  return readFile(outputPath, 'utf8');
}

describe('RC manifest renderer', () => {
  afterEach(async () => {
    await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  it('renders the RC overlay into a custom namespace and secret without xpod-rc residue', async () => {
    const manifest = await render('custom-rc', 'custom-secret');
    const objects = parseAllDocuments(manifest)
      .map((document) => document.toJSON() as any)
      .filter(Boolean);

    expect(objects.some((object) => object.kind === 'Namespace' && object.metadata?.name === 'xpod-rc')).toBe(false);
    expect(objects.every((object) => object.kind === 'Namespace' || object.metadata?.namespace === 'custom-rc')).toBe(true);
    expect(manifest).not.toContain('namespace: xpod-rc');
    expect(manifest).not.toContain('name: xpod-rc-secret');
    expect(manifest).toContain('namespace: custom-rc');
    expect(manifest).toContain('name: custom-secret');
    expect(manifest).toContain('secretRef:');
  });

  it('rejects unsafe Kubernetes names before rendering', async () => {
    await expect(execFile('node', [
      scriptPath,
      '--overlay', overlayPath,
      '--output', path.join(os.tmpdir(), 'unused.yaml'),
      '--namespace', 'Bad_Name',
      '--secret-name', 'custom-secret',
    ], { cwd: repoRoot })).rejects.toMatchObject({
      stderr: expect.stringContaining('valid Kubernetes name'),
    });
  });
});
