import path from 'node:path';

import net from 'node:net';
import { spawn } from 'node:child_process';
import Redis from 'ioredis';
import { Client } from 'pg';
import { getFreePort } from '../src/runtime/port-finder';
import { startXpodRuntime, type XpodRuntimeHandle } from '../src/runtime/XpodRuntime';

const DEFAULT_CLOUD_PORT = Number(process.env.CLOUD_PORT || '6300');
const DEFAULT_CLOUD_B_PORT = Number(process.env.CLOUD_B_PORT || '6400');
const DEFAULT_LOCAL_PORT = Number(process.env.LOCAL_PORT || '5737');
const DEFAULT_STANDALONE_PORT = Number(process.env.STANDALONE_PORT || '5739');
const DEFAULT_POSTGRES_PORT = Number(process.env.POSTGRES_PORT || '5432');
const DEFAULT_REDIS_PORT = Number(process.env.REDIS_PORT || '6379');
const DEFAULT_MINIO_PORT = Number(process.env.MINIO_PORT || '9000');
const DEFAULT_MINIO_CONSOLE_PORT = Number(process.env.MINIO_CONSOLE_PORT || '9001');
const COMPOSE_PROJECT = process.env.XPOD_FULL_PROJECT || 'xpod-full-test';
const composeArgs = [
  'compose',
  '-p',
  COMPOSE_PROJECT,
  '-f',
  'docker-compose.cluster.yml',
  '-f',
  'docker-compose.cluster.integration.yml',
];
const runtimeRoot = path.resolve('.test-data/full-runtime', process.env.XPOD_FULL_RUN_ID || `${Date.now()}-${process.pid}`);
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
}

interface FullRuntimePorts {
  cloud: RuntimePorts;
  cloudB: RuntimePorts;
  local: RuntimePorts;
  standalone: RuntimePorts;
}

interface InfraPorts {
  postgres: number;
  redis: number;
  minio: number;
  minioConsole: number;
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

function commandExitCode(command: string, args: string[]): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      stdio: 'ignore',
      env: process.env,
    });

    child.on('close', (code) => resolve(code ?? 1));
    child.on('error', () => resolve(1));
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

async function hasMinio(port = DEFAULT_MINIO_PORT): Promise<boolean> {
  try {
    const response = await fetch(`http://localhost:${port}/minio/health/live`, {
      signal: AbortSignal.timeout(1500),
    });
    return response.ok;
  } catch {
    return false;
  }
}

async function canUseExistingPostgres(port: number): Promise<boolean> {
  const client = new Client({
    user: 'xpod',
    password: 'xpod',
    host: 'localhost',
    database: 'xpod',
    port,
    connectionTimeoutMillis: 1500,
  });

  try {
    await client.connect();
    await client.query('SELECT 1');
    return true;
  } catch {
    return false;
  } finally {
    await client.end().catch(() => undefined);
  }
}

async function canUseExistingRedis(port: number): Promise<boolean> {
  const redis = new Redis(port, '127.0.0.1', {
    lazyConnect: true,
    connectTimeout: 1500,
    commandTimeout: 1500,
    maxRetriesPerRequest: 0,
    retryStrategy: null,
  });
  redis.on('error', () => {
    // Probe failures only mean the existing Redis is not the test instance.
  });

  try {
    await redis.connect();
    return await redis.ping() === 'PONG';
  } catch {
    return false;
  } finally {
    redis.disconnect(false);
  }
}

async function shouldReuseExistingInfra(infraPorts: InfraPorts): Promise<boolean> {
  const [postgresReady, redisReady, minioReady] = await Promise.all([
    canUseExistingPostgres(infraPorts.postgres),
    canUseExistingRedis(infraPorts.redis),
    hasMinio(infraPorts.minio),
  ]);
  return postgresReady && redisReady && minioReady;
}

async function waitForInfraServices(infraPorts: InfraPorts, maxRetries = 60, delayMs = 1000): Promise<void> {
  let lastStatus = '';
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    const [postgresReady, redisReady, postgresHostReady, redisHostReady, minioReady] = await Promise.all([
      commandExitCode('docker', [...composeArgs, 'exec', '-T', 'postgres', 'pg_isready', '-U', 'xpod', '-d', 'xpod']),
      commandExitCode('docker', [...composeArgs, 'exec', '-T', 'redis', 'redis-cli', 'ping']),
      hasTcpService(infraPorts.postgres),
      hasTcpService(infraPorts.redis),
      hasMinio(infraPorts.minio),
    ]);

    if (postgresReady === 0 && redisReady === 0 && postgresHostReady && redisHostReady && minioReady) {
      await new Promise((resolve) => setTimeout(resolve, 500));
      console.log('[full] postgres/redis/minio ready.');
      return;
    }
    lastStatus = [
      `postgres=${postgresReady}`,
      `redis=${redisReady}`,
      `postgresHost=${postgresHostReady}`,
      `redisHost=${redisHostReady}`,
      `minio=${minioReady}`,
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
  return { gateway, css, api };
}

async function resolveFullRuntimePorts(): Promise<FullRuntimePorts> {
  const reserved = new Set<number>();
  return {
    cloud: await allocateRuntimePorts(DEFAULT_CLOUD_PORT, reserved),
    cloudB: await allocateRuntimePorts(DEFAULT_CLOUD_B_PORT, reserved),
    local: await allocateRuntimePorts(DEFAULT_LOCAL_PORT, reserved),
    standalone: await allocateRuntimePorts(DEFAULT_STANDALONE_PORT, reserved),
  };
}

async function resolveInfraPorts(reuseExistingInfra: boolean): Promise<InfraPorts> {
  if (reuseExistingInfra) {
    return {
      postgres: DEFAULT_POSTGRES_PORT,
      redis: DEFAULT_REDIS_PORT,
      minio: DEFAULT_MINIO_PORT,
      minioConsole: DEFAULT_MINIO_CONSOLE_PORT,
    };
  }

  const reserved = new Set<number>();
  return {
    postgres: await allocatePort(DEFAULT_POSTGRES_PORT, reserved),
    redis: await allocatePort(DEFAULT_REDIS_PORT, reserved),
    minio: await allocatePort(DEFAULT_MINIO_PORT, reserved),
    minioConsole: await allocatePort(DEFAULT_MINIO_CONSOLE_PORT, reserved),
  };
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
            console.log(`[full] ${name} ready at ${baseUrl}`);
            return;
          }
        }
      }
    } catch {
      // not ready yet
    }

    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }

  throw new Error(`[full] ${name} not ready: ${statusUrl}`);
}

async function startFullRuntimes(ports: FullRuntimePorts, infraPorts: InfraPorts): Promise<XpodRuntimeHandle[]> {
  const runtimes: XpodRuntimeHandle[] = [];
  const cloudDb = process.env.XPOD_FULL_PG_URL || `postgres://xpod:xpod@localhost:${infraPorts.postgres}/xpod`;
  const commonCloudEnv = {
    CSS_BASE_STORAGE_DOMAIN: 'undefineds.site',
    CSS_REDIS_CLIENT: `localhost:${infraPorts.redis}`,
    CSS_REDIS_USERNAME: '',
    CSS_REDIS_PASSWORD: '',
    CSS_MINIO_ENDPOINT: `http://localhost:${infraPorts.minio}`,
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
    XPOD_INNGEST_EVENT_KEY: 'integration-event-key',
    XPOD_INNGEST_SIGNING_KEY: 'signkey-test-integration-signing-key',
  };

  runtimes.push(await startXpodRuntime({
    mode: 'cloud',
    transport: 'port',
    gatewayPort: ports.cloud.gateway,
    cssPort: ports.cloud.css,
    apiPort: ports.cloud.api,
    baseUrl: `http://localhost:${ports.cloud.gateway}/`,
    runtimeRoot: path.join(runtimeRoot, 'cloud'),
    rootFilePath: path.join(runtimeRoot, 'cloud', 'data'),
    sparqlEndpoint: cloudDb,
    identityDbUrl: cloudDb,
    env: { ...commonCloudEnv, XPOD_NODE_ID: 'cloud-a' },
  }));

  runtimes.push(await startXpodRuntime({
    mode: 'cloud',
    transport: 'port',
    gatewayPort: ports.cloudB.gateway,
    cssPort: ports.cloudB.css,
    apiPort: ports.cloudB.api,
    baseUrl: `http://localhost:${ports.cloudB.gateway}/`,
    runtimeRoot: path.join(runtimeRoot, 'cloud_b'),
    rootFilePath: path.join(runtimeRoot, 'cloud_b', 'data'),
    sparqlEndpoint: cloudDb,
    identityDbUrl: cloudDb,
    env: { ...commonCloudEnv, XPOD_NODE_ID: 'cloud-b' },
  }));

  runtimes.push(await startXpodRuntime({
    mode: 'local',
    transport: 'port',
    gatewayPort: ports.local.gateway,
    cssPort: ports.local.css,
    apiPort: ports.local.api,
    baseUrl: `http://localhost:${ports.local.gateway}/`,
    runtimeRoot: path.join(runtimeRoot, 'local'),
    rootFilePath: path.join(runtimeRoot, 'local', 'data'),
    sparqlEndpoint: path.join(runtimeRoot, 'local', 'local-managed.sqlite'),
    identityDbUrl: path.join(runtimeRoot, 'local', 'local-managed-identity.sqlite'),
    env: {
      oidcIssuer: `http://localhost:${ports.cloud.gateway}`,
      XPOD_CLOUD_API_ENDPOINT: `http://localhost:${ports.cloud.gateway}`,
      XPOD_NODE_ID: 'local-managed-node',
      XPOD_SERVICE_TOKEN: 'svc-testservicetokenforintegration',
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
    baseUrl: `http://localhost:${ports.standalone.gateway}/`,
    runtimeRoot: path.join(runtimeRoot, 'standalone'),
    rootFilePath: path.join(runtimeRoot, 'standalone', 'data'),
    sparqlEndpoint: path.join(runtimeRoot, 'standalone', 'local-standalone.sqlite'),
    identityDbUrl: path.join(runtimeRoot, 'standalone', 'local-standalone-identity.sqlite'),
    env: {
      XPOD_LOCAL_AUTO_PROVISION: 'false',
      CSS_ALLOWED_HOSTS: 'localhost,host.docker.internal',
      CSS_SEED_CONFIG: path.resolve('config/seed.dev.json'),
    },
  }));

  return runtimes;
}

async function waitForFullPorts(ports: FullRuntimePorts): Promise<void> {
  await Promise.all([
    waitForService('cloud', `http://localhost:${ports.cloud.gateway}`),
    waitForService('cloud_b', `http://localhost:${ports.cloudB.gateway}`),
    waitForService('local', `http://localhost:${ports.local.gateway}`),
    waitForService('standalone', `http://localhost:${ports.standalone.gateway}`),
  ]);
}

async function main(): Promise<void> {
  const targets = process.argv.slice(2);
  const testTargets = targets.length > 0 ? targets : defaultTargets;
  const ports = await resolveFullRuntimePorts();
  const defaultInfraPorts = {
    postgres: DEFAULT_POSTGRES_PORT,
    redis: DEFAULT_REDIS_PORT,
    minio: DEFAULT_MINIO_PORT,
    minioConsole: DEFAULT_MINIO_CONSOLE_PORT,
  };
  const reuseExistingInfra = process.env.XPOD_FULL_USE_EXISTING_INFRA === 'true' || await shouldReuseExistingInfra(defaultInfraPorts);
  const infraPorts = await resolveInfraPorts(reuseExistingInfra);
  const sharedEnv = {
    CSS_BASE_URL: `http://localhost:${ports.standalone.gateway}`,
    POSTGRES_PORT: String(infraPorts.postgres),
    REDIS_PORT: String(infraPorts.redis),
    MINIO_PORT: String(infraPorts.minio),
    MINIO_CONSOLE_PORT: String(infraPorts.minioConsole),
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
  const startedInfra = !reuseExistingInfra;

  if (startedInfra) {
    await runCommand('docker', [...composeArgs, 'down', '-v', '--remove-orphans'], { allowFailure: true });
  } else {
    console.log('[full] Reusing existing postgres/redis/minio on localhost.');
  }

  let testExitCode = 1;
  try {
    if (startedInfra) {
      await runCommand('docker', [...composeArgs, 'up', '-d', 'postgres', 'redis', 'minio'], { env: sharedEnv });
      await waitForInfraServices(infraPorts);
    }
    runtimes.push(...await startFullRuntimes(ports, infraPorts));
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
  } finally {
    await Promise.allSettled(runtimes.map((runtime) => runtime.stop()));
    if (startedInfra && process.env.XPOD_FULL_KEEP_RUNNING !== 'true') {
      await runCommand('docker', [...composeArgs, 'down', '-v', '--remove-orphans'], { allowFailure: true });
    }
  }

  process.exit(testExitCode);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
