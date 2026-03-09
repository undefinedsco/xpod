import path from 'node:path';

import net from 'node:net';
import { spawn } from 'node:child_process';
import { startXpodRuntime, type XpodRuntimeHandle } from '../src/runtime/XpodRuntime';

const CLOUD_PORT = Number(process.env.CLOUD_PORT || '6300');
const CLOUD_B_PORT = Number(process.env.CLOUD_B_PORT || '6400');
const LOCAL_PORT = Number(process.env.LOCAL_PORT || '5737');
const STANDALONE_PORT = Number(process.env.STANDALONE_PORT || '5739');
const COMPOSE_PROJECT = process.env.XPOD_CLUSTER_PROJECT || 'xpod-cluster-test';
const composeArgs = ['compose', '-p', COMPOSE_PROJECT, '-f', 'docker-compose.cluster.yml'];
const runtimeRoot = path.resolve('.test-data/cluster-runtime');
const cloudDb = process.env.XPOD_CLUSTER_PG_URL || 'postgres://xpod:xpod@localhost:5432/xpod';
const defaultTargets = [
  'tests/integration/DockerCluster.integration.test.ts',
  'tests/integration/MultiNodeCluster.integration.test.ts',
  'tests/integration/ProvisionFlow.integration.test.ts',
  'tests/integration/CloudQuotaBusinessToken.integration.test.ts',
];

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


async function hasTcpService(port: number, host = '127.0.0.1', timeoutMs = 1500): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('error', () => {
      socket.destroy();
      resolve(false);
    });
    socket.once('timeout', () => {
      socket.destroy();
      resolve(false);
    });
    socket.connect(port, host);
  });
}

async function hasMinio(): Promise<boolean> {
  try {
    const response = await fetch('http://localhost:9000/minio/health/live', {
      signal: AbortSignal.timeout(1500),
    });
    return response.ok;
  } catch {
    return false;
  }
}

async function shouldReuseExistingInfra(): Promise<boolean> {
  const [postgresReady, redisReady, minioReady] = await Promise.all([
    hasTcpService(5432),
    hasTcpService(6379),
    hasMinio(),
  ]);
  return postgresReady && redisReady && minioReady;
}

async function waitForService(name: string, baseUrl: string, maxRetries = 90, delayMs = 2000): Promise<void> {
  const statusUrl = `${baseUrl.replace(/\/$/, '')}/service/status`;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const response = await fetch(statusUrl, {
        method: 'GET',
        signal: AbortSignal.timeout(3000),
      });

      if (response.ok) {
        const body = await response.json().catch(() => null) as Array<{ name?: string }> | null;
        if (Array.isArray(body)) {
          const names = new Set(body.map((entry) => entry?.name).filter(Boolean));
          if (names.has('css') && names.has('api')) {
            console.log(`[cluster] ${name} ready at ${baseUrl}`);
            return;
          }
        }
      }
    } catch {
      // not ready yet
    }

    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }

  throw new Error(`[cluster] ${name} not ready: ${statusUrl}`);
}

async function startClusterRuntimes(): Promise<XpodRuntimeHandle[]> {
  const runtimes: XpodRuntimeHandle[] = [];
  const commonCloudEnv = {
    CSS_BASE_STORAGE_DOMAIN: 'undefineds.site',
    CSS_REDIS_CLIENT: 'localhost:6379',
    CSS_REDIS_USERNAME: '',
    CSS_REDIS_PASSWORD: '',
    CSS_MINIO_ENDPOINT: 'http://localhost:9000',
    CSS_MINIO_ACCESS_KEY: 'minioadmin',
    CSS_MINIO_SECRET_KEY: 'minioadmin',
    CSS_MINIO_BUCKET_NAME: 'xpod',
    CSS_EMAIL_CONFIG_HOST: '',
    CSS_EMAIL_CONFIG_PORT: '587',
    CSS_EMAIL_CONFIG_AUTH_USER: '',
    CSS_EMAIL_CONFIG_AUTH_PASS: '',
    CSS_ALLOWED_HOSTS: 'localhost,cloud,cloud_b,host.docker.internal',
    CSS_SEED_CONFIG: path.resolve('config/seed.dev.json'),
    XPOD_EDGE_NODES_ENABLED: 'false',
    XPOD_BUSINESS_TOKEN: 'svc-testservicetokenforintegration',
  };

  runtimes.push(await startXpodRuntime({
    mode: 'cloud',
    transport: 'port',
    gatewayPort: CLOUD_PORT,
    cssPort: CLOUD_PORT + 10,
    apiPort: CLOUD_PORT + 11,
    baseUrl: `http://localhost:${CLOUD_PORT}/`,
    runtimeRoot: path.join(runtimeRoot, 'cloud'),
    rootFilePath: path.join(runtimeRoot, 'cloud', 'data'),
    sparqlEndpoint: cloudDb,
    identityDbUrl: cloudDb,
    env: { ...commonCloudEnv, XPOD_NODE_ID: 'cloud-a' },
  }));

  runtimes.push(await startXpodRuntime({
    mode: 'cloud',
    transport: 'port',
    gatewayPort: CLOUD_B_PORT,
    cssPort: CLOUD_B_PORT + 10,
    apiPort: CLOUD_B_PORT + 11,
    baseUrl: `http://localhost:${CLOUD_B_PORT}/`,
    runtimeRoot: path.join(runtimeRoot, 'cloud_b'),
    rootFilePath: path.join(runtimeRoot, 'cloud_b', 'data'),
    sparqlEndpoint: cloudDb,
    identityDbUrl: cloudDb,
    env: { ...commonCloudEnv, XPOD_NODE_ID: 'cloud-b' },
  }));

  runtimes.push(await startXpodRuntime({
    mode: 'local',
    transport: 'port',
    gatewayPort: LOCAL_PORT,
    cssPort: LOCAL_PORT + 10,
    apiPort: LOCAL_PORT + 11,
    baseUrl: `http://localhost:${LOCAL_PORT}/`,
    runtimeRoot: path.join(runtimeRoot, 'local'),
    rootFilePath: path.join(runtimeRoot, 'local', 'data'),
    sparqlEndpoint: path.join(runtimeRoot, 'local', 'local-managed.sqlite'),
    identityDbUrl: path.join(runtimeRoot, 'local', 'local-managed-identity.sqlite'),
    env: {
      CSS_IDP_URL: `http://localhost:${CLOUD_PORT}`,
      XPOD_CLOUD_API_ENDPOINT: `http://localhost:${CLOUD_PORT}`,
      XPOD_NODE_ID: 'local-managed-node',
      XPOD_SERVICE_TOKEN: 'svc-testservicetokenforintegration',
      CSS_ALLOWED_HOSTS: 'localhost,host.docker.internal',
      CSS_SEED_CONFIG: path.resolve('config/seed.dev.json'),
    },
  }));

  runtimes.push(await startXpodRuntime({
    mode: 'local',
    transport: 'port',
    gatewayPort: STANDALONE_PORT,
    cssPort: STANDALONE_PORT + 10,
    apiPort: STANDALONE_PORT + 11,
    baseUrl: `http://localhost:${STANDALONE_PORT}/`,
    runtimeRoot: path.join(runtimeRoot, 'standalone'),
    rootFilePath: path.join(runtimeRoot, 'standalone', 'data'),
    sparqlEndpoint: path.join(runtimeRoot, 'standalone', 'local-standalone.sqlite'),
    identityDbUrl: path.join(runtimeRoot, 'standalone', 'local-standalone-identity.sqlite'),
    env: {
      CSS_ALLOWED_HOSTS: 'localhost,host.docker.internal',
      CSS_SEED_CONFIG: path.resolve('config/seed.dev.json'),
    },
  }));

  return runtimes;
}

async function waitForClusterPorts(): Promise<void> {
  await Promise.all([
    waitForService('cloud', `http://localhost:${CLOUD_PORT}`),
    waitForService('cloud_b', `http://localhost:${CLOUD_B_PORT}`),
    waitForService('local', `http://localhost:${LOCAL_PORT}`),
    waitForService('standalone', `http://localhost:${STANDALONE_PORT}`),
  ]);
}

async function main(): Promise<void> {
  const targets = process.argv.slice(2);
  const testTargets = targets.length > 0 ? targets : defaultTargets;
  const sharedEnv = {
    CSS_BASE_URL: `http://localhost:${STANDALONE_PORT}`,
  };
  const runtimes: XpodRuntimeHandle[] = [];
  const reuseExistingInfra = process.env.XPOD_CLUSTER_USE_EXISTING_INFRA === 'true' || await shouldReuseExistingInfra();
  const startedInfra = !reuseExistingInfra;

  if (startedInfra) {
    await runCommand('docker', [...composeArgs, 'down', '-v', '--remove-orphans'], { allowFailure: true });
  } else {
    console.log('[cluster] Reusing existing postgres/redis/minio on localhost.');
  }

  let testExitCode = 1;
  try {
    if (startedInfra) {
      await runCommand('docker', [...composeArgs, 'up', '-d', 'postgres', 'redis', 'minio']);
    }
    runtimes.push(...await startClusterRuntimes());
    await waitForClusterPorts();

    await runCommand('yarn', ['test:setup'], { env: sharedEnv });

    testExitCode = await runCommand(
      'yarn',
      [
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
  } finally {
    await Promise.allSettled(runtimes.map((runtime) => runtime.stop()));
    if (startedInfra && process.env.XPOD_CLUSTER_KEEP_RUNNING !== 'true') {
      await runCommand('docker', [...composeArgs, 'down', '-v', '--remove-orphans'], { allowFailure: true });
    }
  }

  process.exit(testExitCode);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
