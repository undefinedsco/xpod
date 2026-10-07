import path from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { allocateFullInfrastructure, createFullInfrastructure, composePortsOverride, readDockerPublishedTcpPorts, hasTcpService, hasWritableRedis, commandExitCode, probeMinio, runIntegrationWithCompletionGuard,
  type FullIntegrationInfrastructure } from '../tests/helpers/fullIntegrationInfrastructure';

import { spawn } from 'node:child_process';
import { findGatewayIngressPort, getFreePort } from '../src/runtime/port-finder';
import { startXpodRuntime, type XpodRuntimeHandle } from '../src/runtime/XpodRuntime';
import { createFakeQleverRuntimeCommand } from '../tests/helpers/qleverRuntime';
import {
  OBJECT_STORE_ACCESS_KEY,
  OBJECT_STORE_BUCKET,
  OBJECT_STORE_SECRET_KEY,
} from '../tests/helpers/dockerObjectStore';

const DEFAULT_CLOUD_PORT = Number(process.env.CLOUD_PORT || '6300');
const DEFAULT_CLOUD_B_PORT = Number(process.env.CLOUD_B_PORT || '6400');
const DEFAULT_LOCAL_PORT = Number(process.env.LOCAL_PORT || '5737');
const DEFAULT_STANDALONE_PORT = Number(process.env.STANDALONE_PORT || '5739');
const TEST_SECRET_CELL_KEY = Buffer.alloc(32, 3).toString('base64');
const TEST_GATEWAY_ENV = {
  // Cloud Gateway keys require one stable value shared by all replicas. Keep
  // the full integration matrix hermetic instead of inheriting a developer's
  // local environment or weakening the production requirement.
  XPOD_GATEWAY_LOCATOR_SECRET: 'integration-full-stable-gateway-locator-secret',
  XPOD_SECRET_CELL_KEY_ID: 'integration-full',
  XPOD_SECRET_CELL_KEY: TEST_SECRET_CELL_KEY,
  XPOD_SECRET_CELL_PREVIOUS_KEYS: JSON.stringify({
    'previous-id': Buffer.alloc(32, 4).toString('base64'),
  }),
};
const defaultTargets = [
  'tests/integration/DockerCluster.integration.test.ts',
  'tests/integration/MultiNodeCluster.integration.test.ts',
  'tests/integration/DockerClusterProvisionFlow.integration.test.ts',
  'tests/integration/CloudQuotaBusinessToken.integration.test.ts',
];

interface RuntimePorts {
  gateway: number;
  css: number;
  api: number;
  ingress: number;
}

interface FullRuntimePorts {
  cloud: RuntimePorts;
  cloudB: RuntimePorts;
  local: RuntimePorts;
  standalone: RuntimePorts;
}

function runCommand(
  command: string,
  args: string[],
  options: { env?: NodeJS.ProcessEnv; allowFailure?: boolean } = {},
): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: 'inherit',
      env: {
        ...process.env,
        ...options.env,
      },
    });

    child.on('close', (code) => {
      const exitCode = code ?? 1;
      if (exitCode !== 0 && !options.allowFailure) {
        reject(new Error(`${command} ${args.join(' ')} exited with code ${exitCode}`));
        return;
      }
      resolve(exitCode);
    });
    child.on('error', reject);
  });
}

async function waitForInfraServices(infra: FullIntegrationInfrastructure, maxRetries = 60, delayMs = 1000): Promise<void> {
  let lastStatus = '';
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    const [postgresReady, redisReady, postgresHostReady, redisHostReady, redisWritable, minio] = await Promise.all([
      commandExitCode('docker', [...infra.composeArgs, 'exec', '-T', 'postgres', 'pg_isready', '-U', 'xpod', '-d', 'xpod']),
      commandExitCode('docker', [...infra.composeArgs, 'exec', '-T', 'redis', 'redis-cli', 'ping']),
      hasTcpService(infra.ports.postgres),
      hasTcpService(infra.ports.redis),
      hasWritableRedis(infra.ports.redis),
      probeMinio(infra.ports.objectStore),
    ]);
    const minioReady = minio.ok;

    if (postgresReady === 0 && redisReady === 0 && postgresHostReady && redisHostReady && redisWritable && minioReady) {
      await new Promise((resolve) => setTimeout(resolve, 500));
      console.log('[full] postgres/redis/minio ready.');
      return;
    }
    lastStatus = [
      `postgres=${postgresReady}`,
      `redis=${redisReady}`,
      `postgresHost=${postgresHostReady}`,
      `redisHost=${redisHostReady}`,
      `redisWritable=${redisWritable}`,
      // The object store's own words, so a timeout says "code ECONNRESET" or
      // "Access Denied" instead of only "minio=false".
      `minio=${minioReady ? 'true' : minio.detail}`,
    ].join(' ');

    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }

  throw new Error(`[full] postgres/redis/minio did not become ready in time (${lastStatus})`);
}

async function allocatePort(preferredPort: number, reserved: Set<number>, host = '127.0.0.1'): Promise<number> {
  let candidate = preferredPort;
  while (true) {
    while (reserved.has(candidate) || await hasTcpService(candidate, host, 250)) {
      candidate += 1;
    }

    const port = await getFreePort(candidate, host);
    if (!reserved.has(port) && !await hasTcpService(port, host, 250)) {
      reserved.add(port);
      return port;
    }
    candidate = Math.max(candidate + 1, port + 1);
  }
}

async function allocateRuntimePorts(preferredGatewayPort: number, reserved: Set<number>): Promise<RuntimePorts> {
  const gateway = await allocatePort(preferredGatewayPort, reserved);
  const css = await allocatePort(preferredGatewayPort + 10, reserved);
  const api = await allocatePort(preferredGatewayPort + 11, reserved);
  const ingress = await findGatewayIngressPort(gateway, reserved);
  reserved.add(ingress);
  return { gateway, css, api, ingress };
}

async function resolveFullRuntimePorts(reserved: Set<number>): Promise<FullRuntimePorts> {
  return {
    cloud: await allocateRuntimePorts(DEFAULT_CLOUD_PORT, reserved),
    cloudB: await allocateRuntimePorts(DEFAULT_CLOUD_B_PORT, reserved),
    local: await allocateRuntimePorts(DEFAULT_LOCAL_PORT, reserved),
    standalone: await allocateRuntimePorts(DEFAULT_STANDALONE_PORT, reserved),
  };
}

async function waitForService(name: string, baseUrl: string, maxRetries = 90, delayMs = 2000): Promise<void> {
  const statusUrl = `${baseUrl.replace(/\/$/, '')}/service/status`;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    const controller = new AbortController();
    const deadline = setTimeout(() => controller.abort(), 3000);
    try {
      const response = await fetch(statusUrl, {
        method: 'GET',
        signal: controller.signal,
      });

      if (response.ok) {
        const body = await response.json().catch(() => null) as Array<{ name?: string }> | null;
        if (Array.isArray(body)) {
          const names = new Set(body.map((entry) => entry?.name).filter(Boolean));
          if (names.has('css') && names.has('api')) {
            console.log(`[full] ${name} ready at ${baseUrl}`);
            return;
          }
        }
      }
    } catch {
      // not ready yet
    } finally { clearTimeout(deadline); controller.abort(); }

    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }

  throw new Error(`[full] ${name} not ready: ${statusUrl}`);
}

async function startFullRuntimes(
  ports: FullRuntimePorts,
  qleverRuntimeCommand: string,
  infra: FullIntegrationInfrastructure,
  runtimes: XpodRuntimeHandle[],
): Promise<void> {
  const runtimeRoot = infra.runtimeRoot;
  const commonCloudEnv = {
    ...TEST_GATEWAY_ENV,
    CSS_BASE_STORAGE_DOMAIN: 'undefineds.site',
    CSS_REDIS_CLIENT: infra.redisAddress,
    CSS_REDIS_USERNAME: '',
    CSS_REDIS_PASSWORD: '',
    CSS_MINIO_ENDPOINT: infra.objectStoreEndpoint,
    CSS_MINIO_ACCESS_KEY: OBJECT_STORE_ACCESS_KEY,
    CSS_MINIO_SECRET_KEY: OBJECT_STORE_SECRET_KEY,
    CSS_MINIO_BUCKET_NAME: OBJECT_STORE_BUCKET,
    CSS_EMAIL_CONFIG_HOST: '',
    CSS_EMAIL_CONFIG_PORT: '587',
    CSS_EMAIL_CONFIG_AUTH_USER: '',
    CSS_EMAIL_CONFIG_AUTH_PASS: '',
    CSS_ALLOWED_HOSTS: 'localhost,cloud,cloud_b,host.docker.internal',
    CSS_SEED_CONFIG: path.resolve('config/seed.dev.json'),
    XPOD_EDGE_NODES_ENABLED: 'false',
    XPOD_BUSINESS_TOKEN: 'svc-testservicetokenforintegration',
    XPOD_INNGEST_EVENT_KEY: 'integration-event-key',
    XPOD_INNGEST_SIGNING_KEY: 'signkey-test-integration-signing-key',
  };

  runtimes.push(await startXpodRuntime({
    mode: 'cloud',
    transport: 'port',
    gatewayPort: ports.cloud.gateway,
    cssPort: ports.cloud.css,
    apiPort: ports.cloud.api,
    ingressPort: ports.cloud.ingress,
    baseUrl: `http://localhost:${ports.cloud.gateway}/`,
    runtimeRoot: path.join(runtimeRoot, 'cloud'),
    rootFilePath: path.join(runtimeRoot, 'cloud', 'data'),
    sparqlEndpoint: infra.pgUrl,
    identityDbUrl: infra.pgUrl,
    env: { ...commonCloudEnv, XPOD_NODE_ID: 'cloud-a' },
  }));

  runtimes.push(await startXpodRuntime({
    mode: 'cloud',
    transport: 'port',
    gatewayPort: ports.cloudB.gateway,
    cssPort: ports.cloudB.css,
    apiPort: ports.cloudB.api,
    ingressPort: ports.cloudB.ingress,
    baseUrl: `http://localhost:${ports.cloudB.gateway}/`,
    runtimeRoot: path.join(runtimeRoot, 'cloud_b'),
    rootFilePath: path.join(runtimeRoot, 'cloud_b', 'data'),
    sparqlEndpoint: infra.pgUrl,
    identityDbUrl: infra.pgUrl,
    env: { ...commonCloudEnv, XPOD_NODE_ID: 'cloud-b' },
  }));

  runtimes.push(await startXpodRuntime({
    mode: 'local',
    transport: 'port',
    gatewayPort: ports.local.gateway,
    cssPort: ports.local.css,
    apiPort: ports.local.api,
    ingressPort: ports.local.ingress,
    baseUrl: `http://localhost:${ports.local.gateway}/`,
    runtimeRoot: path.join(runtimeRoot, 'local'),
    rootFilePath: path.join(runtimeRoot, 'local', 'data'),
    sparqlEndpoint: path.join(runtimeRoot, 'local', 'local-managed.sqlite'),
    identityDbUrl: path.join(runtimeRoot, 'local', 'local-managed-identity.sqlite'),
    env: {
      ...TEST_GATEWAY_ENV,
      SOLID_OIDC_ISSUER: `http://localhost:${ports.cloud.gateway}`,
      XPOD_NODE_ID: 'local-managed-node',
      XPOD_SERVICE_TOKEN: 'svc-testservicetokenforintegration',
      XPOD_QLEVER_LOCAL_RUNTIME_COMMAND: qleverRuntimeCommand,
      CSS_ALLOWED_HOSTS: 'localhost,host.docker.internal',
      CSS_SEED_CONFIG: path.resolve('config/seed.dev.json'),
    },
  }));

  runtimes.push(await startXpodRuntime({
    mode: 'local',
    transport: 'port',
    gatewayPort: ports.standalone.gateway,
    cssPort: ports.standalone.css,
    apiPort: ports.standalone.api,
    ingressPort: ports.standalone.ingress,
    baseUrl: `http://localhost:${ports.standalone.gateway}/`,
    runtimeRoot: path.join(runtimeRoot, 'standalone'),
    rootFilePath: path.join(runtimeRoot, 'standalone', 'data'),
    sparqlEndpoint: path.join(runtimeRoot, 'standalone', 'local-standalone.sqlite'),
    identityDbUrl: path.join(runtimeRoot, 'standalone', 'local-standalone-identity.sqlite'),
    env: {
      ...TEST_GATEWAY_ENV,
      // Standalone 节点自身就是 IdP：显式把 issuer 指向自身 baseUrl，
      // 退出 XpodRuntime 对 local 模式的默认官方云接管（DEFAULT_LOCAL_OIDC_ISSUER），
      // 否则测试运行会向真实 id.undefineds.co 注册节点并把 Pod 建到不可解析的 nodes.undefineds.co 域。
      SOLID_OIDC_ISSUER: `http://localhost:${ports.standalone.gateway}/`,
      XPOD_QLEVER_LOCAL_RUNTIME_COMMAND: qleverRuntimeCommand,
      CSS_ALLOWED_HOSTS: 'localhost,host.docker.internal',
      CSS_SEED_CONFIG: path.resolve('config/seed.dev.json'),
    },
  }));

}

async function waitForFullPorts(ports: FullRuntimePorts): Promise<void> {
  await Promise.all([
    waitForService('cloud', `http://localhost:${ports.cloud.gateway}`),
    waitForService('cloud_b', `http://localhost:${ports.cloudB.gateway}`),
    waitForService('local', `http://localhost:${ports.local.gateway}`),
    waitForService('standalone', `http://localhost:${ports.standalone.gateway}`),
  ]);
}

let cleanupOwnedRun: () => Promise<void> = async() => undefined;

async function main(): Promise<void> {
  const targets = process.argv.slice(2);
  const testTargets = targets.length > 0 ? targets : defaultTargets;
  const reserved = await readDockerPublishedTcpPorts();
  const infra = createFullInfrastructure(await allocateFullInfrastructure(reserved), {
    projectPrefix: process.env.XPOD_FULL_PROJECT, runPrefix: process.env.XPOD_FULL_RUN_ID });
  await mkdir(infra.runtimeRoot, { recursive: true });
  await writeFile(infra.overridePath, composePortsOverride(infra.ports));
  await writeFile(path.join(infra.runtimeRoot, 'infrastructure.json'), JSON.stringify({ projectName: infra.projectName, ports: infra.ports }, null, 2));
  const ports = await resolveFullRuntimePorts(reserved);
  const sharedEnv = {
    ...infra.testEnv,
    CSS_BASE_URL: `http://localhost:${ports.standalone.gateway}`,
    CLOUD_PORT: String(ports.cloud.gateway),
    CLOUD_API_PORT: String(ports.cloud.api),
    CLOUD_B_PORT: String(ports.cloudB.gateway),
    CLOUD_B_API_PORT: String(ports.cloudB.api),
    LOCAL_PORT: String(ports.local.gateway),
    LOCAL_API_PORT: String(ports.local.api),
    STANDALONE_PORT: String(ports.standalone.gateway),
    STANDALONE_API_PORT: String(ports.standalone.api),
  };
  const runtimes: XpodRuntimeHandle[] = [];
  let testExitCode = 1;
  const qleverRuntimeFixture = createFakeQleverRuntimeCommand();
  let cleanupPromise: Promise<void> | undefined;
  cleanupOwnedRun = () => cleanupPromise ??= (async() => {
    const stopped = await Promise.allSettled(runtimes.map(runtime => runtime.stop()));
    let down = 0;
    try {
      if (process.env.XPOD_FULL_KEEP_RUNNING !== 'true') {
        down = await runCommand('docker', [...infra.composeArgs, 'down', '-v', '--remove-orphans'], { allowFailure: true });
      }
    } finally { qleverRuntimeFixture.cleanup(); }
    if (down !== 0 || stopped.some(result => result.status === 'rejected')) throw new Error('[full] Owned infrastructure cleanup failed');
    console.log('[full] Owned cleanup complete.');
  })();
  try {
    await runCommand('docker', [...infra.composeArgs, 'config', '--quiet']);
    await runCommand('docker', [...infra.composeArgs, 'up', '-d', 'postgres', 'redis', 'minio']);
    await waitForInfraServices(infra);
    await startFullRuntimes(ports, qleverRuntimeFixture.command, infra, runtimes);
    await waitForFullPorts(ports);

    await runCommand('bun', ['run', 'test:setup'], { env: sharedEnv });

    testExitCode = await runCommand(
      'bun',
      [
        'run',
        'vitest',
        '--run',
        ...testTargets,
        '--no-file-parallelism',
      ],
      {
        env: {
          ...sharedEnv,
          XPOD_RUN_INTEGRATION_TESTS: 'true',
          CSS_SEED_CONFIG: `${process.cwd()}/config/seeds/test.json`,
        },
        allowFailure: true,
      },
    );
    console.log(`[full] Docker integration tests completed with exit ${testExitCode}.`);
  } finally {
    await cleanupOwnedRun();
  }

  process.exit(testExitCode);
}

runIntegrationWithCompletionGuard(main, () => cleanupOwnedRun()).catch((error) => {
  console.error(error);
  process.exit(1);
});
