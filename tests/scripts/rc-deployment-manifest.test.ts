import { execFile as execFileCallback } from 'node:child_process';
import path from 'node:path';
import { readFileSync } from 'node:fs';
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
      'Certificate/xpod-rc-api',
      'Certificate/xpod-rc-id',
      'Certificate/xpod-rc-pods',
      'ConfigMap/xpod-rc-config',
      'Deployment/xpod-rc',
      'Ingress/xpod-rc-api',
      'Ingress/xpod-rc-id',
      'Ingress/xpod-rc-pods',
      'Issuer/xpod-rc-letsencrypt',
      'Service/xpod-rc',
      'Service/xpod-rc-gateway',
    ]);
    expect(objects.every((object) => object.metadata?.namespace === 'xpod-rc')).toBe(true);

    const configMap = findOne(objects, 'ConfigMap', 'xpod-rc-config');
    // 环境相关的值由 APP_ENV_FILE 提供；configmap 只放结构性常量，
    // 因此这里断言它们**不在** configmap 里（避免又被写回来覆盖 secret）。
    expect(configMap.data).toMatchObject({
      NODE_ENV: 'production',
      XPOD_EDITION: 'cloud',
    });
    expect(configMap.data).not.toHaveProperty('CSS_BASE_URL');
    expect(configMap.data).not.toHaveProperty('CSS_ALLOWED_HOSTS');
    expect(configMap.data).not.toHaveProperty('XPOD_PUBLIC_API_URL');

    const deployments = objects.filter((object) => object.kind === 'Deployment');
    const xpodDeployments = deployments.filter((object) =>
      object.spec?.template?.spec?.containers?.some((container: any) => container.name === 'xpod'));
    expect(xpodDeployments).toHaveLength(1);

    const xpodDeployment = findOne(objects, 'Deployment', 'xpod-rc');
    const xpodContainer = xpodDeployment.spec?.template?.spec?.containers?.find((container: any) => container.name === 'xpod');
    expect(xpodContainer).toBeDefined();
    expect(xpodContainer.image).toBe('ghcr.io/undefinedsco/xpod:replace-me');
    // 行内 env 只留结构性常量；随环境变化的值（域名、开关、端口分配）
    // 一律由 APP_ENV_FILE → secret 提供，不能写回清单，否则会盖掉 secret。
    expect(envMap(xpodContainer)).toMatchObject({
      NODE_ENV: 'production',
      XPOD_EDITION: 'cloud',
      XPOD_PORT: '3000',
      CSS_LOGGING_LEVEL: 'info',
    });
    expect(envMap(xpodContainer)).not.toHaveProperty('CSS_BASE_URL');
    expect(envMap(xpodContainer)).not.toHaveProperty('CSS_ALLOWED_HOSTS');
    expect(envMap(xpodContainer)).not.toHaveProperty('XPOD_PUBLIC_API_URL');
    expect(envMap(xpodContainer)).not.toHaveProperty('XPOD_EDGE_NODES_ENABLED');
    expect(envMap(xpodContainer)).not.toHaveProperty('CSS_PORT');
    expect(envMap(xpodContainer)).not.toHaveProperty('API_PORT');
    expect(xpodContainer.envFrom).toEqual([
      { configMapRef: { name: 'xpod-rc-config', optional: true }},
      { secretRef: { name: 'xpod-rc-secret' }},
    ]);
    expect(xpodContainer.env).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'XPOD_INNGEST_ENABLED', value: 'true' }),
      expect.objectContaining({ name: 'XPOD_INNGEST_MODE', value: 'managed' }),
      expect.objectContaining({ name: 'XPOD_INNGEST_BASE_URL', value: 'http://xpod-inngest:8288' }),
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

    const gatewayService = findOne(objects, 'Service', 'xpod-rc-gateway');
    expect(gatewayService.spec?.selector).toEqual({ app: 'gateway' });
    expect(gatewayService.spec?.ports).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'api', port: 8081, targetPort: 8081 }),
      expect.objectContaining({ name: 'id', port: 8082, targetPort: 8082 }),
      expect.objectContaining({ name: 'pods', port: 8083, targetPort: 8083 }),
    ]));

    for (const [ name, host, secretName, port ] of [
      [ 'xpod-rc-id', 'id-rc.undefineds.cn', 'xpod-rc-id-tls', 'id' ],
      [ 'xpod-rc-pods', 'pods-rc.undefineds.cn', 'xpod-rc-pods-tls', 'pods' ],
      [ 'xpod-rc-api', 'api-rc.undefineds.cn', 'xpod-rc-api-tls', 'api' ],
    ]) {
      const ingress = findOne(objects, 'Ingress', name);
      expect(ingress.spec?.tls).toEqual([{ hosts: [ host ], secretName }]);
      expect(ingress.spec?.rules?.[0]).toMatchObject({
        host,
        http: { paths: [{ backend: { service: { name: 'xpod-rc-gateway', port: { name: port } } } }] },
      });
    }
    expect(objects.some((object) => object.kind === 'StatefulSet')).toBe(false);
    expect(objects.some((object) => object.kind === 'PersistentVolumeClaim')).toBe(false);
    expect(objects.some((object) => object.metadata?.name?.startsWith('xpod-rc-minio'))).toBe(false);
  });
});


describe('fresh native pull template', () => {
  it('uses a digest-pinned PG image and replaceable pull authorization without business volumes', () => {
    const job = findOne(renderObjects(readFileSync(path.join(rcOverlayPath, 'pull-preflight.yaml'), 'utf8')), 'Job', 'xpod-rc-pg-preflight');
    const pod = job.spec?.template.spec;
    const container = pod.containers[0];
    expect(container.image).toMatch(/^ccr\.ccs\.tencentyun\.com\/undefineds\/xpod-rdf-postgres@sha256:[a-f0-9]{64}$/);
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
    expect(deployment.spec?.template.spec.containers[0].args).toEqual(['node', 'dist/main.js', '-c', 'config/cloud.qlever.json', '-p', '3000']);
  });
});
