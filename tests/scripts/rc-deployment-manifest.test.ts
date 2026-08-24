import { execFile as execFileCallback } from 'node:child_process';
import path from 'node:path';
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

async function runKustomize(overlayPath: string): Promise<string> {
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
    const manifest = [
      await runKustomize(rcPostgresOverlayPath),
      await runKustomize(rcOverlayPath),
    ].join('\n---\n');
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
      'Deployment/xpod-rc-inngest',
      'Ingress/xpod-rc-api',
      'Ingress/xpod-rc-id',
      'Ingress/xpod-rc-pods',
      'Issuer/xpod-rc-letsencrypt',
      'Service/xpod-rc',
      'Service/xpod-rc-gateway',
      'Service/xpod-rc-inngest',
      'Service/xpod-rc-postgres',
      'StatefulSet/xpod-rc-postgres',
    ]);
    expect(objects.every((object) => object.metadata?.namespace === 'xpod-rc')).toBe(true);

    const configMap = findOne(objects, 'ConfigMap', 'xpod-rc-config');
    expect(configMap.data).toMatchObject({
      NODE_ENV: 'production',
      XPOD_EDITION: 'cloud',
      CSS_BASE_URL: 'https://id-rc.undefineds.co',
      CSS_ALLOWED_HOSTS: 'id-rc.undefineds.co,pods-rc.undefineds.co,api-rc.undefineds.co',
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
      CSS_BASE_URL: 'https://id-rc.undefineds.co',
      CSS_ALLOWED_HOSTS: 'id-rc.undefineds.co,pods-rc.undefineds.co,api-rc.undefineds.co',
      XPOD_PUBLIC_API_URL: 'https://api-rc.undefineds.co',
      XPOD_EDGE_NODES_ENABLED: 'false',
    });
    expect(xpodContainer.envFrom).toEqual([
      { configMapRef: { name: 'xpod-rc-config', optional: true }},
      { secretRef: { name: 'xpod-rc-secret' }},
    ]);
    expect(xpodContainer.env).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'XPOD_INNGEST_ENABLED', value: 'true' }),
      expect.objectContaining({ name: 'XPOD_INNGEST_MODE', value: 'managed' }),
      expect.objectContaining({ name: 'XPOD_INNGEST_BASE_URL', value: 'http://xpod-rc-inngest:8288' }),
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

    const xpodService = findOne(objects, 'Service', 'xpod-rc');
    expect(xpodService.spec?.selector).toEqual({ app: 'xpod-rc' });
    expect(xpodService.spec?.selector).toEqual(xpodDeployment.spec?.template?.metadata?.labels);
    expectDeploymentSelectorsMatchTemplate(xpodDeployment);
    expectPodSecurityBaseline(xpodDeployment);

    const inngestDeployment = findOne(objects, 'Deployment', 'xpod-rc-inngest');
    const inngestContainer = inngestDeployment.spec?.template?.spec?.containers?.find((container: any) => container.name === 'inngest');
    expect(inngestContainer?.args).toEqual(expect.arrayContaining([
      '--sdk-url', 'http://xpod-rc/api/inngest',
      '--postgres-uri', '$(CSS_IDENTITY_DB_URL)',
      '--redis-uri', '$(CSS_REDIS_CLIENT)',
    ]));
    expect(inngestContainer?.envFrom).toEqual([{ secretRef: { name: 'xpod-rc-secret' } }]);
    expectDeploymentSelectorsMatchTemplate(inngestDeployment);
    expectPodSecurityBaseline(inngestDeployment);

    const inngestService = findOne(objects, 'Service', 'xpod-rc-inngest');
    expect(inngestService.spec?.selector).toEqual({ app: 'xpod-rc-inngest' });
    expect(inngestService.spec?.selector).toEqual(inngestDeployment.spec?.template?.metadata?.labels);

    const postgresService = findOne(objects, 'Service', 'xpod-rc-postgres');
    expect(postgresService.spec?.selector).toEqual({ app: 'xpod-rc-postgres' });
    expect(postgresService.spec?.ports).toEqual([
      expect.objectContaining({ name: 'postgres', port: 5432, targetPort: 5432 }),
    ]);

    const postgresStatefulSet = findOne(objects, 'StatefulSet', 'xpod-rc-postgres');
    const postgresContainer = postgresStatefulSet.spec?.template?.spec?.containers?.find((container: any) => container.name === 'postgres');
    expect(postgresStatefulSet.spec?.serviceName).toBe('xpod-rc-postgres');
    expect(postgresStatefulSet.spec?.selector?.matchLabels).toEqual(postgresStatefulSet.spec?.template?.metadata?.labels);
    expect(postgresStatefulSet.spec?.template?.spec?.securityContext).toMatchObject({
      runAsNonRoot: true,
      runAsUser: 999,
      runAsGroup: 999,
      fsGroup: 999,
      seccompProfile: { type: 'RuntimeDefault' },
    });
    expect(postgresContainer?.image).toBe('docker.io/pgvector/pgvector@sha256:7ae6051efd0e60444282c27c7e141af07f322ce033300e727a49c3dd11075e38');
    expect(postgresContainer?.resources).toEqual({
      requests: {
        cpu: '100m',
        memory: '256Mi',
      },
      limits: {
        cpu: '1',
        memory: '1Gi',
      },
    });
    expect(postgresContainer?.env).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'POSTGRES_DB', valueFrom: { secretKeyRef: { name: 'xpod-rc-postgres-secret', key: 'POSTGRES_DB' } } }),
      expect.objectContaining({ name: 'POSTGRES_USER', valueFrom: { secretKeyRef: { name: 'xpod-rc-postgres-secret', key: 'POSTGRES_USER' } } }),
      expect.objectContaining({ name: 'POSTGRES_PASSWORD', valueFrom: { secretKeyRef: { name: 'xpod-rc-postgres-secret', key: 'POSTGRES_PASSWORD' } } }),
    ]));
    expect(postgresStatefulSet.spec?.volumeClaimTemplates).toEqual([
      expect.objectContaining({
        metadata: expect.objectContaining({
          name: 'data',
          labels: { app: 'xpod-rc-postgres' },
        }),
      }),
    ]);

    const gatewayService = findOne(objects, 'Service', 'xpod-rc-gateway');
    expect(gatewayService.spec?.selector).toEqual({ app: 'gateway' });
    expect(gatewayService.spec?.ports).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'api', port: 8081, targetPort: 8081 }),
      expect.objectContaining({ name: 'id', port: 8082, targetPort: 8082 }),
      expect.objectContaining({ name: 'pods', port: 8083, targetPort: 8083 }),
    ]));

    for (const [ name, host, secretName, port ] of [
      [ 'xpod-rc-id', 'id-rc.undefineds.co', 'xpod-rc-id-tls', 'id' ],
      [ 'xpod-rc-pods', 'pods-rc.undefineds.co', 'xpod-rc-pods-tls', 'pods' ],
      [ 'xpod-rc-api', 'api-rc.undefineds.co', 'xpod-rc-api-tls', 'api' ],
    ]) {
      const ingress = findOne(objects, 'Ingress', name);
      expect(ingress.spec?.tls).toEqual([{ hosts: [ host ], secretName }]);
      expect(ingress.spec?.rules?.[0]).toMatchObject({
        host,
        http: { paths: [{ backend: { service: { name: 'xpod-rc-gateway', port: { name: port } } } }] },
      });
    }
    expect(objects.some((object) => object.kind === 'PersistentVolumeClaim')).toBe(false);
    expect(objects.some((object) => object.metadata?.name?.startsWith('xpod-rc-minio'))).toBe(false);
  });
});
