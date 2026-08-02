import { execFile as execFileCallback } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';
import { parseAllDocuments } from 'yaml';
import { describe, expect, it } from 'vitest';

const execFile = promisify(execFileCallback);
const repoRoot = path.resolve(__dirname, '../..');
const rcOverlayPath = path.join(repoRoot, 'deploy/sealos/rc');

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

async function runKustomize(): Promise<string> {
  const commands = [
    { file: 'kubectl', args: [ 'kustomize', rcOverlayPath ] },
    { file: 'kustomize', args: [ 'build', rcOverlayPath ] },
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
      'Deployment/xpod-inngest',
      'Deployment/xpod-rc',
      'Namespace/xpod-rc',
      'Service/xpod',
      'Service/xpod-inngest',
    ]);
    expect(objects.every((object) => object.kind === 'Namespace' || object.metadata?.namespace === 'xpod-rc')).toBe(true);

    const configMap = findOne(objects, 'ConfigMap', 'xpod-rc-config');
    expect(configMap.data).toMatchObject({
      NODE_ENV: 'production',
      XPOD_EDITION: 'cloud',
      CSS_BASE_URL: 'https://rc.id.undefineds.co',
      CSS_ALLOWED_HOSTS: 'rc.id.undefineds.co',
      CSS_BASE_STORAGE_DOMAIN: 'rc.id.undefineds.co',
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
      CSS_BASE_URL: 'https://rc.id.undefineds.co',
      CSS_ALLOWED_HOSTS: 'rc.id.undefineds.co',
      CSS_BASE_STORAGE_DOMAIN: 'rc.id.undefineds.co',
      XPOD_EDGE_NODES_ENABLED: 'true',
    });
    expect(xpodContainer.envFrom).toEqual([
      { configMapRef: { name: 'xpod-rc-config', optional: true }},
      { secretRef: { name: 'xpod-rc-secret' }},
    ]);
    expect(xpodContainer.env).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'XPOD_INNGEST_ENABLED', value: 'true' }),
      expect.objectContaining({ name: 'XPOD_INNGEST_MODE', value: 'managed' }),
      expect.objectContaining({ name: 'XPOD_INNGEST_BASE_URL', value: 'http://xpod-inngest:8288' }),
      expect.objectContaining({ name: 'XPOD_API_BASE_URL', value: 'http://xpod' }),
    ]));
    expect(xpodContainer.readinessProbe?.httpGet?.path).toBe('/service/status');
    expect(xpodContainer.livenessProbe?.httpGet?.path).toBe('/service/status');
    expect(xpodContainer.startupProbe?.httpGet?.path).toBe('/service/status');

    const xpodService = findOne(objects, 'Service', 'xpod');
    expect(xpodService.spec?.selector).toEqual({ app: 'xpod-rc' });
    expect(xpodService.spec?.selector).toEqual(xpodDeployment.spec?.template?.metadata?.labels);
    expectDeploymentSelectorsMatchTemplate(xpodDeployment);
    expectPodSecurityBaseline(xpodDeployment);

    const inngestDeployment = findOne(objects, 'Deployment', 'xpod-inngest');
    const inngestContainer = inngestDeployment.spec?.template?.spec?.containers?.find((container: any) => container.name === 'inngest');
    expect(inngestContainer?.envFrom).toEqual([
      { secretRef: { name: 'xpod-rc-secret' }},
    ]);
    expect(inngestContainer?.args).toEqual(expect.arrayContaining([
      '--postgres-uri',
      '$(CSS_IDENTITY_DB_URL)',
      '--redis-uri',
      '$(CSS_REDIS_CLIENT)',
    ]));
    const inngestService = findOne(objects, 'Service', 'xpod-inngest');
    expect(inngestService.spec?.selector).toEqual({ app: 'xpod-inngest' });
    expect(inngestService.spec?.selector).toEqual(inngestDeployment.spec?.template?.metadata?.labels);
    expectDeploymentSelectorsMatchTemplate(inngestDeployment);
    expectPodSecurityBaseline(inngestDeployment);

    expect(objects.some((object) => object.kind === 'Ingress')).toBe(false);
    expect(objects.some((object) => object.kind === 'StatefulSet' || object.kind === 'PersistentVolumeClaim')).toBe(false);
  });
});
