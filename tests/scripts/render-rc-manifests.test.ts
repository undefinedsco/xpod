import { execFile as execFileCallback, execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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
  const currentPath = path.join(root, 'current.json');
  await writeFile(currentPath, JSON.stringify({kind:'Deployment',metadata:{name:'xpod-rc',namespace:'ns-iknkxtc8',uid:'rc-uid',resourceVersion:'42'}}));
  const admissionPath=path.join(root,'admission.json');
  await writeFile(admissionPath,JSON.stringify({status:'ok',sourceSha:execFileSync('git',['rev-parse','HEAD'],{cwd:repoRoot,encoding:'utf8'}).trim(),namespace:'ns-iknkxtc8',identities:[{kind:'Deployment',name:'xpod-rc',uid:'rc-uid',resourceVersion:'42'},{kind:'Service',name:'xpod-rc',uid:'svc-uid',resourceVersion:'43'},{kind:'ConfigMap',name:'xpod-rc-config',uid:'cm-uid',resourceVersion:'44'}]}));
  const ownershipPath=path.join(root,'ownership.json');
  const previous={nonce:'previous-owner',secrets:[{name:'previous-runtime',uid:'previous-runtime-uid'}],executor:{name:'xpod-rc-inngest-122-1',status:'ready',serviceUID:'previous-service-uid',deploymentUID:'previous-deploy-uid'}};
  await writeFile(ownershipPath,JSON.stringify({sourceSha:execFileSync('git',['rev-parse','HEAD'],{cwd:repoRoot,encoding:'utf8'}).trim(),nonce:'run-nonce',previous,secrets:[{name:secretName,uid:'runtime-uid'},{name:seedSecretName,uid:'seed-uid'}],executor:{name:'xpod-rc-inngest-123-1',status:'ready',serviceUID:'exec-service-uid',deploymentUID:'exec-deploy-uid'}}));
  await execFile('node', [
    scriptPath,
    '--overlay', overlayPath,
    '--output', outputPath,
    '--namespace', namespace,
    '--secret-name', secretName,
    '--seed-secret-name', seedSecretName,
    '--image', immutableImage,
    '--current-deployment', currentPath,
    '--admission', admissionPath,
    '--run-ownership', ownershipPath,
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
    const manifest = await render('ns-iknkxtc8', 'custom-secret', 'custom-seed');
    const objects = parseAllDocuments(manifest)
      .map((document) => document.toJSON() as any)
      .filter(Boolean);

    expect(objects.some((object) => object.kind === 'Namespace' && object.metadata?.name === 'xpod-rc')).toBe(false);
    expect(objects.every((object) => object.kind === 'Namespace' || object.metadata?.namespace === 'ns-iknkxtc8')).toBe(true);
    expect(manifest).not.toContain('namespace: xpod-rc');
    expect(manifest).not.toContain('name: xpod-rc-secret');
    expect(manifest).toContain('namespace: ns-iknkxtc8');
    expect(manifest).toContain('name: custom-secret');
    expect(manifest).toContain('secretName: custom-seed');
    expect(manifest).toContain('secretRef:');
    expect(manifest).not.toContain('ghcr.io/undefinedsco/xpod:replace-me');
    const deployment = objects.find((object) => object.kind === 'Deployment' && object.metadata?.name === 'xpod-rc');
    const container = deployment?.spec?.template?.spec?.containers?.find((entry: any) => entry.name === 'xpod');
    expect(container?.image).toBe(immutableImage);
    expect(container?.env).toContainEqual({name:'XPOD_INNGEST_BASE_URL',value:'http://xpod-rc-inngest-123-1:8288'});
    expect(JSON.parse(deployment.metadata.annotations['xpod.undefineds.co/rc-run-ownership']).executor.deploymentUID).toBe('exec-deploy-uid');
    expect(JSON.parse(deployment.metadata.annotations['xpod.undefineds.co/rc-run-ownership']).previous.nonce).toBe('previous-owner');
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
    expect(objects.map(object => object.kind).sort()).toEqual(['ConfigMap', 'Deployment', 'Service']);
    expect(deployment.metadata).toMatchObject({uid:'rc-uid',resourceVersion:'42'});

  });

  it('rejects a PostgreSQL overlay before initialization or replacement', async () => {
    await expect(renderPostgres('ns-iknkxtc8')).rejects.toMatchObject({stderr:expect.stringContaining('cannot initialize or replace PostgreSQL')});
  });

  it('rejects a foreign namespace even when it is a syntactically valid name', async () => {
    await expect(render('other-ns','runtime')).rejects.toMatchObject({stderr:expect.stringContaining('assigned GZ namespace')});
  });

  it('rejects an application overlay when any required replacement is omitted', async () => {
    const outputPath = path.join(os.tmpdir(), 'unused.yaml');
    const currentPath = path.join(repoRoot,'.test-data/gz-rc-release/current-test.json');
    await writeFile(currentPath,JSON.stringify({kind:'Deployment',metadata:{name:'xpod-rc',namespace:'ns-iknkxtc8',uid:'uid',resourceVersion:'1'}}));
    const admissionPath=path.join(repoRoot,'.test-data/gz-rc-release/admission-test.json');
    await writeFile(admissionPath,JSON.stringify({status:'ok',sourceSha:execFileSync('git',['rev-parse','HEAD'],{cwd:repoRoot,encoding:'utf8'}).trim(),namespace:'ns-iknkxtc8',identities:[{kind:'Deployment',name:'xpod-rc',uid:'uid',resourceVersion:'1'}]}));
    await expect(execFile('node', [
      scriptPath,
      '--overlay', overlayPath,
      '--output', outputPath,
      '--namespace', 'ns-iknkxtc8',
      '--current-deployment', currentPath,
      '--admission', admissionPath,
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
    const manifest = await render('ns-iknkxtc8', 'xpod-rc-secret');
    expect(manifest).toContain('namespace: ns-iknkxtc8');
    expect(manifest).toContain('name: xpod-rc-secret');
  });

  it('rejects mutable images and unsafe seed secret names before rendering', async () => {
    const outputPath = path.join(os.tmpdir(), 'unused.yaml');
    const currentPath = path.join(repoRoot,'.test-data/gz-rc-release/current-test.json');
    await writeFile(currentPath,JSON.stringify({kind:'Deployment',metadata:{name:'xpod-rc',namespace:'ns-iknkxtc8',uid:'uid',resourceVersion:'1'}}));
    const admissionPath=path.join(repoRoot,'.test-data/gz-rc-release/admission-test.json');
    await writeFile(admissionPath,JSON.stringify({status:'ok',sourceSha:execFileSync('git',['rev-parse','HEAD'],{cwd:repoRoot,encoding:'utf8'}).trim(),namespace:'ns-iknkxtc8',identities:[{kind:'Deployment',name:'xpod-rc',uid:'uid',resourceVersion:'1'}]}));
    await expect(execFile('node', [
      scriptPath,
      '--overlay', overlayPath,
      '--output', outputPath,
      '--namespace', 'ns-iknkxtc8',
      '--current-deployment', currentPath,
      '--admission', admissionPath,
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
      '--namespace', 'ns-iknkxtc8',
      '--current-deployment', currentPath,
      '--admission', admissionPath,
      '--secret-name', 'custom-secret',
      '--seed-secret-name', 'custom-seed',
      '--image', 'ghcr.io/undefinedsco/xpod:latest',
    ], { cwd: repoRoot })).rejects.toMatchObject({
      stderr: expect.stringContaining('immutable sha256 digest'),
    });
  });
});
