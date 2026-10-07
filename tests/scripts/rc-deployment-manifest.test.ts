import { execFile as execFileCallback } from 'node:child_process';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { promisify } from 'node:util';
import { parseAllDocuments } from 'yaml';
import { describe, expect, it } from 'vitest';

const execFile = promisify(execFileCallback);
const repoRoot = path.resolve(__dirname, '../..');
const rcOverlayPath = path.join(repoRoot, 'deploy/sealos/rc');
const rcPostgresOverlayPath = path.join(repoRoot, 'deploy/sealos/rc-postgres');

type KubernetesObject = {
  apiVersion?: string;
  kind?: string;
  metadata?: {
    name?: string;
    namespace?: string;
  };
  spec?: Record<string, any>;
  data?: Record<string, string>;
};

async function runKustomize(overlayPath = rcOverlayPath): Promise<string> {
  const commands = [
    { file: 'kubectl', args: [ 'kustomize', overlayPath ] },
    { file: 'kustomize', args: [ 'build', overlayPath ] },
  ];
  const errors: string[] = [];

  for (const command of commands) {
    try {
      const { stdout } = await execFile(command.file, command.args, { cwd: repoRoot });
      return stdout;
    } catch (error: any) {
      errors.push(`${command.file} ${command.args.join(' ')}: ${error.code ?? 'unknown'} ${error.stderr ?? error.message}`);
      if (error.code !== 'ENOENT') {
        throw error;
      }
    }
  }

  throw new Error(`kubectl and kustomize are unavailable; cannot audit RC overlay.\n${errors.join('\n')}`);
}

function renderObjects(manifest: string): KubernetesObject[] {
  return parseAllDocuments(manifest)
    .map((document) => document.toJSON() as KubernetesObject | null)
    .filter((object): object is KubernetesObject => Boolean(object?.kind));
}

function findOne(objects: KubernetesObject[], kind: string, name: string): KubernetesObject {
  const matches = objects.filter((object) => object.kind === kind && object.metadata?.name === name);
  expect(matches, `${kind}/${name}`).toHaveLength(1);
  return matches[0];
}

function envMap(container: any): Record<string, string> {
  return Object.fromEntries((container.env ?? []).map((entry: { name: string; value: string }) => [ entry.name, entry.value ]));
}

function expectDeploymentSelectorsMatchTemplate(deployment: KubernetesObject): void {
  expect(deployment.spec?.selector?.matchLabels).toEqual(deployment.spec?.template?.metadata?.labels);
}

function expectPodSecurityBaseline(deployment: KubernetesObject): void {
  const podSpec = deployment.spec?.template?.spec;
  expect(podSpec?.automountServiceAccountToken).toBe(false);
  expect(podSpec?.securityContext?.seccompProfile).toEqual({ type: 'RuntimeDefault' });
  for (const container of podSpec?.containers ?? []) {
    expect(container.securityContext).toMatchObject({
      allowPrivilegeEscalation: false,
      capabilities: { drop: [ 'ALL' ]},
    });
  }
}

describe('RC Sealos deployment manifest', () => {
  it('cannot render the removed disposable database overlay', async () => {
    await expect(runKustomize(rcPostgresOverlayPath)).rejects.toThrow();
  });

  it('renders an isolated Xpod RC overlay without production-only resources or secrets', async () => {
    const manifest = await runKustomize();
    const objects = renderObjects(manifest);

    expect(manifest).not.toContain('xpod-cloud-secret');
    expect(manifest).not.toContain('namespace: xpod-cloud');
    expect(manifest).not.toContain('https://id.undefineds.co');
    expect(manifest).not.toMatch(/host:\s*id\.undefineds\.co/);
    expect(manifest).not.toContain('XPOD_REDIS_PREFIX');
    expect(manifest).not.toContain('XPOD_OBJECT_PREFIX');
    expect(manifest).not.toMatch(/your-password|your-project-ref|sk-[A-Za-z0-9_-]+/);

    expect(objects.map((object) => `${object.kind}/${object.metadata?.name}`).sort()).toEqual([
      'ConfigMap/xpod-rc-config',
      'Deployment/xpod-rc',
      'Service/xpod-rc',
    ]);
    expect(objects.every((object) => object.metadata?.namespace === 'xpod-rc')).toBe(true);

    const configMap = findOne(objects, 'ConfigMap', 'xpod-rc-config');
    expect(configMap.data).toMatchObject({
      NODE_ENV: 'production',
      XPOD_EDITION: 'cloud',
      CSS_BASE_URL: 'https://undefineds-gz-rc-id.sealosgzg.site',
      CSS_ALLOWED_HOSTS: 'undefineds-gz-rc-id.sealosgzg.site,undefineds-gz-rc-pods.sealosgzg.site,undefineds-gz-rc-api.sealosgzg.site',
    });

    const deployments = objects.filter((object) => object.kind === 'Deployment');
    const xpodDeployments = deployments.filter((object) =>
      object.spec?.template?.spec?.containers?.some((container: any) => container.name === 'xpod'));
    expect(xpodDeployments).toHaveLength(1);

    const xpodDeployment = findOne(objects, 'Deployment', 'xpod-rc');
    const xpodContainer = xpodDeployment.spec?.template?.spec?.containers?.find((container: any) => container.name === 'xpod');
    expect(xpodContainer).toBeDefined();
    expect(xpodContainer.image).toBe('ghcr.io/undefinedsco/xpod:replace-me');
    expect(envMap(xpodContainer)).toMatchObject({
      NODE_ENV: 'production',
      XPOD_EDITION: 'cloud',
      XPOD_PORT: '3000',
      CSS_PORT: '6300',
      API_PORT: '6301',
      CSS_LOGGING_LEVEL: 'info',
      CSS_BASE_URL: 'https://undefineds-gz-rc-id.sealosgzg.site',
      CSS_ALLOWED_HOSTS: 'undefineds-gz-rc-id.sealosgzg.site,undefineds-gz-rc-pods.sealosgzg.site,undefineds-gz-rc-api.sealosgzg.site',
      XPOD_PUBLIC_API_URL: 'https://undefineds-gz-rc-api.sealosgzg.site',
      XPOD_EDGE_NODES_ENABLED: 'false',
    });
    expect(xpodContainer.envFrom).toEqual([
      { configMapRef: { name: 'xpod-rc-config', optional: true }},
      { secretRef: { name: 'xpod-rc-secret' }},
    ]);
    expect(xpodContainer.env).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'XPOD_INNGEST_ENABLED', value: 'true' }),
      expect.objectContaining({ name: 'XPOD_INNGEST_MODE', value: 'managed' }),
      expect.objectContaining({ name: 'XPOD_INNGEST_BASE_URL', value: 'http://xpod-inngest:8288' }),
      expect.objectContaining({ name: 'XPOD_API_BASE_URL', value: 'http://xpod-rc' }),
      expect.objectContaining({ name: 'XPOD_INNGEST_SOURCE', value: 'rc' }),
    ]));
    expect((xpodContainer.env ?? []).map((entry: any) => entry.name)).not.toEqual(expect.arrayContaining([
      'CSS_MINIO_ENDPOINT',
      'CSS_MINIO_BUCKET_NAME',
      'CSS_MINIO_ACCESS_KEY',
      'CSS_MINIO_SECRET_KEY',
    ]));
    expect(xpodContainer.readinessProbe?.httpGet?.path).toBe('/service/status');
    expect(xpodContainer.livenessProbe?.httpGet?.path).toBe('/service/status');
    expect(xpodContainer.startupProbe?.httpGet?.path).toBe('/service/status');
    expect(xpodContainer.resources).toEqual({
      requests: { cpu: '500m', memory: '1Gi' },
      limits: { cpu: '4', memory: '2Gi' },
    });

    const xpodService = findOne(objects, 'Service', 'xpod-rc');
    expect(xpodService.spec?.selector).toEqual({ app: 'xpod-rc' });
    expect(xpodService.spec?.selector).toEqual(xpodDeployment.spec?.template?.metadata?.labels);
    expectDeploymentSelectorsMatchTemplate(xpodDeployment);
    expectPodSecurityBaseline(xpodDeployment);

    expect(objects.some(object => ['Ingress','Certificate','Issuer'].includes(object.kind ?? ''))).toBe(false);
    expect(objects.some(object => object.metadata?.name === 'xpod-rc-gateway')).toBe(false);
    expect(objects.some((object) => object.kind === 'StatefulSet')).toBe(false);
    expect(objects.some((object) => object.kind === 'PersistentVolumeClaim')).toBe(false);
    expect(objects.some((object) => object.metadata?.name?.startsWith('xpod-rc-minio'))).toBe(false);
  });
});


describe('fresh native pull template', () => {
  it('uses the same exact PG image and existing pull authorization without business volumes', () => {
    const job = findOne(renderObjects(readFileSync(path.join(rcPostgresOverlayPath, 'pull-preflight.yaml'), 'utf8')), 'Job', 'xpod-rc-pg-preflight');
    const pod = job.spec?.template.spec;
    const container = pod.containers[0];
    expect(container.image).toBe(require('../../scripts/verify-gz-rc-prerequisites.cjs').PG_IMAGE);
    expect(container.imagePullPolicy).toBe('Always');
    expect(pod.imagePullSecrets).toEqual([{ name: 'tcr-creds' }]);
    expect(pod.volumes).toBeUndefined();
    expect(container.volumeMounts).toBeUndefined();
    expect(pod.restartPolicy).toBe('Never');
    expect(job.spec?.backoffLimit).toBe(0);
    for (const extension of ['vector', 'xpod_rdf', 'xpod_qlever']) expect(container.args[0]).toContain(`${extension}.control`);
    expectPodSecurityBaseline(job);
  });

  it('uses the explicit cloud native override while retaining gateway launch arguments', () => {
    const deployment = findOne(renderObjects(readFileSync(path.join(rcOverlayPath, 'deployment.yaml'), 'utf8')), 'Deployment', 'xpod-rc');
    expect(deployment.spec?.template.spec.containers[0].command).toEqual(['bun']);
    expect(deployment.spec?.template.spec.containers[0].args).toEqual(['--no-env-file','dist/cli/index.js','start','--mode','cloud','--config','config/cloud.qlever.json','--port','3000','--host','0.0.0.0']);
  });
});
