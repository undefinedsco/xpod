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
const postgresOverlayPath = path.join(repoRoot, 'deploy/sealos/rc-postgres');
const tempRoots: string[] = [];
const immutableImage = `ghcr.io/undefinedsco/xpod@sha256:${'a'.repeat(64)}`;

async function render(namespace: string, secretName: string, seedSecretName = 'custom-seed'): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'xpod-rc-render-'));
  tempRoots.push(root);
  const outputPath = path.join(root, 'rendered.yaml');
  await execFile('node', [
    scriptPath,
    '--overlay', overlayPath,
    '--output', outputPath,
    '--namespace', namespace,
    '--secret-name', secretName,
    '--seed-secret-name', seedSecretName,
    '--image', immutableImage,
  ], { cwd: repoRoot });
  return readFile(outputPath, 'utf8');
}

async function renderPostgres(namespace: string): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'xpod-rc-postgres-render-'));
  tempRoots.push(root);
  const outputPath = path.join(root, 'rendered.yaml');
  await execFile('node', [
    scriptPath,
    '--overlay', postgresOverlayPath,
    '--output', outputPath,
    '--namespace', namespace,
  ], { cwd: repoRoot });
  return readFile(outputPath, 'utf8');
}

describe('RC manifest renderer', () => {
  afterEach(async () => {
    await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  it('renders the RC overlay into a custom namespace and secret without xpod-rc residue', async () => {
    const manifest = await render('custom-rc', 'custom-secret', 'custom-seed');
    const objects = parseAllDocuments(manifest)
      .map((document) => document.toJSON() as any)
      .filter(Boolean);

    expect(objects.some((object) => object.kind === 'Namespace' && object.metadata?.name === 'xpod-rc')).toBe(false);
    expect(objects.every((object) => object.kind === 'Namespace' || object.metadata?.namespace === 'custom-rc')).toBe(true);
    expect(manifest).not.toContain('namespace: xpod-rc');
    expect(manifest).not.toContain('name: xpod-rc-secret');
    expect(manifest).toContain('namespace: custom-rc');
    expect(manifest).toContain('name: custom-secret');
    expect(manifest).toContain('secretName: custom-seed');
    expect(manifest).toContain('secretRef:');
    expect(manifest).not.toContain('ghcr.io/undefinedsco/xpod:replace-me');
    const deployment = objects.find((object) => object.kind === 'Deployment' && object.metadata?.name === 'xpod-rc');
    const container = deployment?.spec?.template?.spec?.containers?.find((entry: any) => entry.name === 'xpod');
    expect(container?.image).toBe(immutableImage);
    expect(container?.env).toContainEqual({
      name: 'CSS_SEED_CONFIG',
      value: '/app/config/seeds/rc.json',
    });
    expect(container?.volumeMounts).toContainEqual({
      name: 'xpod-rc-seed',
      mountPath: '/app/config/seeds',
      readOnly: true,
    });
    expect(deployment?.spec?.template?.spec?.volumes).toContainEqual({
      name: 'xpod-rc-seed',
      secret: { secretName: 'custom-seed' },
    });
    const ingresses = objects.filter((object) => object.kind === 'Ingress');
    expect(ingresses.map((ingress) => ingress.metadata?.name).sort()).toEqual([
      'xpod-rc-api', 'xpod-rc-id', 'xpod-rc-pods',
    ]);
    expect(ingresses.every((ingress) => ingress.metadata?.namespace === 'custom-rc')).toBe(true);
    expect(ingresses.map((ingress) => ingress.spec?.rules?.[0]?.host).sort()).toEqual([
      'api-rc.undefineds.co', 'id-rc.undefineds.co', 'pods-rc.undefineds.co',
    ]);
  });

  it('renders the placeholder-free PostgreSQL overlay without weakening application placeholders', async () => {
    const manifest = await renderPostgres('custom-rc');
    expect(manifest).toContain('name: xpod-rc-postgres');
    expect(manifest).toContain('namespace: custom-rc');
    expect(manifest).not.toContain('namespace: xpod-rc');
    expect(manifest).not.toContain('ghcr.io/undefinedsco/xpod:replace-me');
  });

  it('rejects an application overlay when any required replacement is omitted', async () => {
    const outputPath = path.join(os.tmpdir(), 'unused.yaml');
    await expect(execFile('node', [
      scriptPath,
      '--overlay', overlayPath,
      '--output', outputPath,
      '--namespace', 'assigned-ns',
    ], { cwd: repoRoot })).rejects.toMatchObject({
      stderr: expect.stringContaining('xpod-rc-secret'),
    });
  });

  it('rejects unsafe Kubernetes names before rendering', async () => {
    await expect(execFile('node', [
      scriptPath,
      '--overlay', overlayPath,
      '--output', path.join(os.tmpdir(), 'unused.yaml'),
      '--namespace', 'Bad_Name',
      '--secret-name', 'custom-secret',
      '--seed-secret-name', 'custom-seed',
      '--image', immutableImage,
    ], { cwd: repoRoot })).rejects.toMatchObject({
      stderr: expect.stringContaining('valid Kubernetes name'),
    });
  });

  it('accepts the documented xpod-rc-secret runtime name in an assigned namespace', async () => {
    const manifest = await render('assigned-ns', 'xpod-rc-secret');
    expect(manifest).toContain('namespace: assigned-ns');
    expect(manifest).toContain('name: xpod-rc-secret');
  });

  it('rejects mutable images and unsafe seed secret names before rendering', async () => {
    const outputPath = path.join(os.tmpdir(), 'unused.yaml');
    await expect(execFile('node', [
      scriptPath,
      '--overlay', overlayPath,
      '--output', outputPath,
      '--namespace', 'assigned-ns',
      '--secret-name', 'custom-secret',
      '--seed-secret-name', 'Bad_Seed',
      '--image', immutableImage,
    ], { cwd: repoRoot })).rejects.toMatchObject({
      stderr: expect.stringContaining('valid Kubernetes name'),
    });
    await expect(execFile('node', [
      scriptPath,
      '--overlay', overlayPath,
      '--output', outputPath,
      '--namespace', 'assigned-ns',
      '--secret-name', 'custom-secret',
      '--seed-secret-name', 'custom-seed',
      '--image', 'ghcr.io/undefinedsco/xpod:latest',
    ], { cwd: repoRoot })).rejects.toMatchObject({
      stderr: expect.stringContaining('immutable sha256 digest'),
    });
  });
});
