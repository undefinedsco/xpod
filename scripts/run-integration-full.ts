import path from 'node:path';
import { loadFullIntegrationInfra, checkFullIntegrationInfra, fullIntegrationInfraEnv, type FullIntegrationInfra } from './helpers/full-integration-infra';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';

import net from 'node:net';
import { spawn } from 'node:child_process';
import { resolveFullIntegrationInfra } from '../tests/helpers/fullIntegrationInfra';
import { RESERVED_PORTS_ENV } from '../src/runtime/port-reservations';
import { getFreePortForWildcard, requireFreePortForWildcard } from '../src/runtime/port-finder';
import { startXpodRuntime, type XpodRuntimeHandle } from '../src/runtime/XpodRuntime';
import { createFakeQleverRuntimeCommand } from '../tests/helpers/qleverRuntime';
import {
  OBJECT_STORE_ACCESS_KEY,
  OBJECT_STORE_BUCKET,
  OBJECT_STORE_PORT,
  OBJECT_STORE_SECRET_KEY,
  probeObjectStore,
} from '../tests/helpers/dockerObjectStore';

const DEFAULT_CLOUD_PORT = Number(process.env.CLOUD_PORT || '6300');
const DEFAULT_CLOUD_B_PORT = Number(process.env.CLOUD_B_PORT || '6400');
const DEFAULT_LOCAL_PORT = Number(process.env.LOCAL_PORT || '5737');
const DEFAULT_STANDALONE_PORT = Number(process.env.STANDALONE_PORT || '5739');
const COMPOSE_PROJECT = process.env.XPOD_FULL_PROJECT || 'xpod-full-test';
const TEST_SECRET_CELL_KEY = Buffer.alloc(32, 3).toString('base64');
const TEST_GATEWAY_ENV = {
  XPOD_SECRET_CELL_KEY_ID: 'integration-full',
  XPOD_SECRET_CELL_KEY: TEST_SECRET_CELL_KEY,
  XPOD_SECRET_CELL_PREVIOUS_KEYS: JSON.stringify({
    'previous-id': Buffer.alloc(32, 4).toString('base64'),
  }),
};
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
let infrastructurePorts: InfrastructurePorts = { postgres: 5432, redis: 6379, minio: OBJECT_STORE_PORT };
const defaultTargets = [
  'tests/integration/CloudClientCredentialVisibility.integration.test.ts',
  'tests/integration/AgentDirectoryProtocol.integration.test.ts',
  'tests/integration/RedisLockOwnership.integration.test.ts',
  'tests/integration/DockerCluster.integration.test.ts',
  'tests/integration/MultiNodeCluster.integration.test.ts',
  'tests/integration/DockerClusterProvisionFlow.integration.test.ts',
  'tests/integration/CloudQuotaBusinessToken.integration.test.ts',
  'tests/integration/CloudManagedPodDeletion.integration.test.ts',
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

export interface InfrastructurePorts {
  postgres: number;
  redis: number;
  minio: number;
}

export function fullInfrastructureConnections(ports: InfrastructurePorts, postgresUrl?: string): {
  postgresUrl: string; redisUrl: string; minioUrl: string;
} {
  let selected: ReturnType<typeof resolveFullIntegrationInfra>;
  try {
    selected = resolveFullIntegrationInfra({ XPOD_FULL_POSTGRES_PORT: String(ports.postgres),
      XPOD_FULL_REDIS_PORT: String(ports.redis), XPOD_FULL_OBJECT_STORE_PORT: String(ports.minio), XPOD_FULL_PG_URL: postgresUrl });
  } catch { throw new Error('XPOD_FULL_PG_URL must use this Compose project owned PostgreSQL host port.'); }
  return { postgresUrl: selected.postgresUrl, redisUrl: `redis://localhost:${ports.redis}`, minioUrl: `http://localhost:${ports.minio}` };
}

export async function createFullInfrastructureOverlay(ports: InfrastructurePorts, directory = runtimeRoot): Promise<{
  path: string; cleanup(): Promise<void>;
}> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const privateDirectory = await mkdtemp(path.join(directory, 'compose-ports-'));
  await chmod(privateDirectory, 0o700);
  const overlayPath = path.join(privateDirectory, 'ports.yml');
  const mappings = [['postgres', ports.postgres, 5432], ['redis', ports.redis, 6379], ['minio', ports.minio, OBJECT_STORE_PORT]];
  const content = `services:\n${mappings.map(([service, published, target]) =>
    `  ${service}:\n    ports: !override\n      - "127.0.0.1:${published}:${target}"\n`).join('')}`;
  await writeFile(overlayPath, content, { mode: 0o600 });
  return { path: overlayPath, cleanup: () => rm(privateDirectory, { recursive: true, force: true }) };
}

async function readOwnedInfrastructurePorts(): Promise<InfrastructurePorts | undefined> {
  const ports: number[] = [];
  for (const [service, target] of [['postgres', 5432], ['redis', 6379], ['minio', OBJECT_STORE_PORT]] as const) {
    const output = await new Promise<string>((resolve) => {
      const child = spawn('docker', [...composeArgs, 'port', service, String(target)], { stdio: ['ignore', 'pipe', 'ignore'] });
      let value = '';
      child.stdout.on('data', chunk => { value += chunk.toString(); });
      child.on('error', () => resolve(''));
      child.on('close', code => resolve(code === 0 ? value : ''));
    });
    const matches = [...output.matchAll(/:(\d+)\s*$/gmu)].map(match => Number(match[1]));
    if (!matches.length || new Set(matches).size !== 1 || !Number.isInteger(matches[0]) || matches[0] < 1 || matches[0] > 65535) return undefined;
    ports.push(matches[0]);
  }
  if (new Set(ports).size !== 3) return undefined;
  return { postgres: ports[0], redis: ports[1], minio: ports[2] };
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


async function hasOwnedPublication(service: string, containerPort: number, hostPort: number): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn('docker', [...composeArgs, 'port', service, String(containerPort)], {
      stdio: ['ignore', 'pipe', 'ignore'], env: process.env,
    });
    let output = '';
    child.stdout.on('data', (chunk: Buffer) => { output = (output + chunk.toString('utf8')).slice(0, 4096); });
    child.on('error', () => resolve(false));
    child.on('close', (code) => resolve(code === 0 && output.trim().split(/\r?\n/u).some((line) =>
      new RegExp(`^(?:0\\.0\\.0\\.0|127\\.0\\.0\\.1|\\[::\\]|\\[::1\\]):${hostPort}$`, 'u').test(line))));
  });
}

async function probeMinio(): Promise<{ ok: boolean; detail: string }> {
  // The Compose service is still named `minio`, but it is VersityGW now, so the
  // MinIO-only /minio/health/live path is gone. Probe what the tests actually
  // need instead: an authenticated request for the test bucket. The probe never
  // throws, so a container that is still starting is a retry, not a crash.
  return await probeObjectStore(resolveFullIntegrationInfra().ports.objectStore, OBJECT_STORE_BUCKET);
}

async function hasMinio(): Promise<boolean> {
  return (await probeMinio()).ok;
}

async function hasOwnedInfraPublications(ports: ReturnType<typeof resolveFullIntegrationInfra>['ports']): Promise<boolean> {
  const owned = await Promise.all([
    hasOwnedPublication('postgres', 5432, ports.postgres),
    hasOwnedPublication('redis', 6379, ports.redis),
    hasOwnedPublication('minio', 9000, ports.objectStore),
  ]);
  return owned.every(Boolean);
}

export async function hasHealthyComposeInfra(): Promise<boolean> {
  const { ports } = resolveFullIntegrationInfra();
  const [postgresReady, redisReady, publicationsOwned] = await Promise.all([
    commandExitCode('docker', [...composeArgs, 'exec', '-T', 'postgres', 'pg_isready', '-U', 'xpod', '-d', 'xpod']),
    commandExitCode('docker', [...composeArgs, 'exec', '-T', 'redis', 'redis-cli', 'ping']),
    hasOwnedInfraPublications(ports),
  ]);
  if (postgresReady !== 0 || redisReady !== 0 || !publicationsOwned) return false;
  const [postgresHostReady, redisHostReady, redisWritable, minioReady] = await Promise.all([
    hasTcpService(ports.postgres),
    hasTcpService(ports.redis),
    // Writability is checked inside our Compose service, never foreign host Redis.
    commandExitCode('docker', [...composeArgs, 'exec', '-T', 'redis', 'redis-cli', '-e', 'SET', 'xpod:full:healthcheck', 'ok', 'EX', '30']),
    hasMinio(),
  ]);
  return postgresHostReady && redisHostReady && redisWritable === 0 && minioReady;
}

export async function waitForInfraServices(maxRetries = 60, delayMs = 1000): Promise<void> {
  const { ports } = resolveFullIntegrationInfra();
  let lastStatus = '';
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    if (!await hasOwnedInfraPublications(ports)) {
      lastStatus = 'host publications do not match the selected Compose project';
      await new Promise(resolve => setTimeout(resolve, delayMs)); continue;
    }
    const [postgresReady, redisReady, postgresHostReady, redisHostReady, minio] = await Promise.all([
      commandExitCode('docker', [...composeArgs, 'exec', '-T', 'postgres', 'pg_isready', '-h', '127.0.0.1', '-p', '5432', '-U', 'xpod', '-d', 'xpod']),
      commandExitCode('docker', [...composeArgs, 'exec', '-T', 'redis', 'redis-cli', 'ping']),
      hasTcpService(ports.postgres),
      hasTcpService(ports.redis),
      probeMinio(),
    ]);
    const minioReady = minio.ok;

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

    const port = await getFreePortForWildcard(candidate, undefined, reserved);
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
  // Include ingress in the same plan before allocating another runtime: an
  // earlier runtime must not choose a later instance's future gateway.
  const ingress = await allocatePort(gateway + 3, reserved);
  return { gateway, css, api, ingress };
}

export async function resolveFullInfrastructurePorts(
  reserved = new Set<number>(),
  preferred: InfrastructurePorts = { postgres: 5432, redis: 6379, minio: OBJECT_STORE_PORT },
): Promise<InfrastructurePorts> {
  const explicit = resolveFullIntegrationInfra();
  const definitions = [['postgres', 'XPOD_FULL_POSTGRES_PORT', explicit.ports.postgres],
    ['redis', 'XPOD_FULL_REDIS_PORT', explicit.ports.redis], ['minio', 'XPOD_FULL_OBJECT_STORE_PORT', explicit.ports.objectStore]] as const;
  const result = {} as InfrastructurePorts;
  for (const [name, key, selected] of definitions) {
    if (process.env[key] !== undefined) {
      if (reserved.has(selected)) throw new Error('Explicit infrastructure port overlaps another planned listener');
      result[name] = await requireFreePortForWildcard(selected); reserved.add(selected);
    } else result[name] = await allocatePort(preferred[name], reserved);
  }
  return result;
}

export async function resolveFullRuntimePorts(reserved = new Set<number>()): Promise<FullRuntimePorts> {
  return {
    cloud: await allocateRuntimePorts(DEFAULT_CLOUD_PORT, reserved),
    cloudB: await allocateRuntimePorts(DEFAULT_CLOUD_B_PORT, reserved),
    local: await allocateRuntimePorts(DEFAULT_LOCAL_PORT, reserved),
    standalone: await allocateRuntimePorts(DEFAULT_STANDALONE_PORT, reserved),
  };
}

export async function selectFullInfrastructurePorts(reuseRequested: boolean, reserved: Set<number>): Promise<InfrastructurePorts> {
  const requested = resolveFullIntegrationInfra();
  const owned = reuseRequested ? await readOwnedInfrastructurePorts() : undefined;
  if (owned) {
    for (const [name, key, expected] of [['postgres', 'XPOD_FULL_POSTGRES_PORT', requested.ports.postgres],
      ['redis', 'XPOD_FULL_REDIS_PORT', requested.ports.redis], ['minio', 'XPOD_FULL_OBJECT_STORE_PORT', requested.ports.objectStore]] as const) {
      if (process.env[key] !== undefined && owned[name] !== expected) {
        throw new Error('Explicit infrastructure port conflicts with the selected Compose project owned publication');
      }
    }
    Object.values(owned).forEach(port => reserved.add(port)); return owned;
  }
  return resolveFullInfrastructurePorts(reserved, { postgres: requested.ports.postgres, redis: requested.ports.redis, minio: requested.ports.objectStore });
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

type RuntimeStartPorts = { [K in keyof FullRuntimePorts]: Omit<RuntimePorts, 'ingress'> & { ingress?: number } };

async function withPlannedPortReservations<T>(ports: RuntimeStartPorts, infrastructure: InfrastructurePorts, work: () => Promise<T>): Promise<T> {
  const previous = process.env[RESERVED_PORTS_ENV];
  const planned = [...Object.values(infrastructure), ...Object.values(ports).flatMap(runtime => Object.values(runtime))];
  process.env[RESERVED_PORTS_ENV] = [previous, ...planned].filter(value => value !== undefined && value !== '').join(',');
  try { return await work(); } finally {
    if (previous === undefined) delete process.env[RESERVED_PORTS_ENV]; else process.env[RESERVED_PORTS_ENV] = previous;
  }
}

export async function startFullRuntimes(ports: RuntimeStartPorts, qleverRuntimeCommand: string, infrastructure?: InfrastructurePorts, externalInfra?: FullIntegrationInfra): Promise<XpodRuntimeHandle[]> {
  const selected = resolveFullIntegrationInfra();
  const resolved = infrastructure ?? { postgres: selected.ports.postgres, redis: selected.ports.redis, minio: selected.ports.objectStore };
  return withPlannedPortReservations(ports, resolved, () => startFullRuntimesReserved(ports, qleverRuntimeCommand, resolved, externalInfra));
}

async function startFullRuntimesReserved(ports: RuntimeStartPorts, qleverRuntimeCommand: string, infrastructure: InfrastructurePorts, externalInfra?: FullIntegrationInfra): Promise<XpodRuntimeHandle[]> {
  const connections = fullInfrastructureConnections(infrastructure, process.env.XPOD_FULL_PG_URL);
  const cloudDb = connections.postgresUrl;
  const runtimes: XpodRuntimeHandle[] = [];
  const commonCloudEnv = {
    ...TEST_GATEWAY_ENV,
    [RESERVED_PORTS_ENV]: process.env[RESERVED_PORTS_ENV],
    CSS_BASE_STORAGE_DOMAIN: 'undefineds.site',
    CSS_REDIS_CLIENT: `localhost:${infrastructure.redis}`,
    CSS_REDIS_USERNAME: '',
    CSS_REDIS_PASSWORD: '',
    CSS_MINIO_ENDPOINT: connections.minioUrl,
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

  if (externalInfra) Object.assign(commonCloudEnv, fullIntegrationInfraEnv(externalInfra));
  const runtimeCloudDb = externalInfra?.XPOD_FULL_PG_URL ?? cloudDb;

  try {
    runtimes.push(await startXpodRuntime({
      mode: 'cloud',
      transport: 'port',
      open: false,
      apiOpen: false,
      authMode: 'acp',
      gatewayPort: ports.cloud.gateway,
      cssPort: ports.cloud.css,
      apiPort: ports.cloud.api,
      ingressPort: ports.cloud.ingress,
      baseUrl: `http://localhost:${ports.cloud.gateway}/`,
      runtimeRoot: path.join(runtimeRoot, 'cloud'),
      rootFilePath: path.join(runtimeRoot, 'cloud', 'data'),
      sparqlEndpoint: runtimeCloudDb,
      identityDbUrl: runtimeCloudDb,
      env: { ...commonCloudEnv, XPOD_NODE_ID: 'cloud-a' },
    }));

    runtimes.push(await startXpodRuntime({
      mode: 'cloud',
      transport: 'port',
      open: false,
      apiOpen: false,
      authMode: 'acp',
      gatewayPort: ports.cloudB.gateway,
      cssPort: ports.cloudB.css,
      apiPort: ports.cloudB.api,
      ingressPort: ports.cloudB.ingress,
      baseUrl: `http://localhost:${ports.cloudB.gateway}/`,
      runtimeRoot: path.join(runtimeRoot, 'cloud_b'),
      rootFilePath: path.join(runtimeRoot, 'cloud_b', 'data'),
      sparqlEndpoint: runtimeCloudDb,
      identityDbUrl: runtimeCloudDb,
      env: { ...commonCloudEnv, XPOD_NODE_ID: 'cloud-b' },
    }));

    runtimes.push(await startXpodRuntime({
      mode: 'local',
      transport: 'port',
      open: false,
      apiOpen: false,
      authMode: 'acp',
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
        [RESERVED_PORTS_ENV]: process.env[RESERVED_PORTS_ENV],
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
      open: false,
      apiOpen: false,
      authMode: 'acp',
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
        [RESERVED_PORTS_ENV]: process.env[RESERVED_PORTS_ENV],
        // Standalone 节点自身就是 IdP：显式把 issuer 指向自身 baseUrl，
        // 退出 XpodRuntime 对 local 模式的默认官方云接管（DEFAULT_LOCAL_OIDC_ISSUER），
        // 否则测试运行会向真实 id.undefineds.co 注册节点并把 Pod 建到不可解析的 nodes.undefineds.co 域。
        SOLID_OIDC_ISSUER: `http://localhost:${ports.standalone.gateway}/`,
        XPOD_QLEVER_LOCAL_RUNTIME_COMMAND: qleverRuntimeCommand,
        CSS_ALLOWED_HOSTS: 'localhost,host.docker.internal',
        CSS_SEED_CONFIG: path.resolve('config/seed.dev.json'),
      },
    }));

    return runtimes;
  } catch (error) {
    // Preserve the startup cause before infra teardown can terminate pending PG work.
    console.error('[full] Runtime startup failed:', externalInfra ? 'external runtime startup failed' : error);
    await Promise.allSettled(runtimes.map((runtime) => runtime.stop()));
    throw error;
  }
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
  // Validate and probe before any Compose action: external failures never recreate infrastructure.
  const externalInfra = await loadFullIntegrationInfra(process.env.XPOD_FULL_INFRA_ENV_FILE);
  if (externalInfra) await checkFullIntegrationInfra(externalInfra);
  resolveFullIntegrationInfra();
  const targets = process.argv.slice(2);
  const testTargets = targets.length > 0 ? targets : defaultTargets;
  const reuseRequested = process.env.XPOD_FULL_USE_EXISTING_INFRA === 'true';
  const reserved = new Set<number>();
  infrastructurePorts = await selectFullInfrastructurePorts(reuseRequested, reserved);
  const connections = fullInfrastructureConnections(infrastructurePorts, process.env.XPOD_FULL_PG_URL);
  const oldEnv = Object.fromEntries(['XPOD_FULL_POSTGRES_PORT', 'XPOD_FULL_REDIS_PORT', 'XPOD_FULL_OBJECT_STORE_PORT'].map(key => [key, process.env[key]]));
  Object.assign(process.env, { XPOD_FULL_POSTGRES_PORT: String(infrastructurePorts.postgres), XPOD_FULL_REDIS_PORT: String(infrastructurePorts.redis), XPOD_FULL_OBJECT_STORE_PORT: String(infrastructurePorts.minio) });
  try {
  const ports = await resolveFullRuntimePorts(reserved);
  const overlay = await createFullInfrastructureOverlay(infrastructurePorts);
  composeArgs.push('-f', overlay.path);
  const reuseExistingInfra = !externalInfra && reuseRequested && await hasHealthyComposeInfra();
  const startedInfra = !externalInfra && !reuseExistingInfra;
  const sharedEnv = {
    ...resolveFullIntegrationInfra().hostEnv,
    [RESERVED_PORTS_ENV]: [...(process.env[RESERVED_PORTS_ENV] ? [process.env[RESERVED_PORTS_ENV]] : []), ...Object.values(infrastructurePorts), ...Object.values(ports).flatMap(runtime => Object.values(runtime))].join(','),
    XPOD_FULL_PG_URL: connections.postgresUrl,
    XPOD_AGENT_DIRECTORY_TEST_CLOUD_URL: `http://localhost:${ports.cloud.gateway}/`,
    XPOD_AGENT_DIRECTORY_TEST_REDIS_URL: connections.redisUrl,
    CSS_BASE_URL: `http://localhost:${ports.standalone.gateway}`,
    CLOUD_PORT: String(ports.cloud.gateway),
    CLOUD_API_PORT: String(ports.cloud.api),
    CLOUD_B_PORT: String(ports.cloudB.gateway),
    CLOUD_B_API_PORT: String(ports.cloudB.api),
    LOCAL_PORT: String(ports.local.gateway),
    LOCAL_API_PORT: String(ports.local.api),
    STANDALONE_PORT: String(ports.standalone.gateway),
    STANDALONE_API_PORT: String(ports.standalone.api),
    SOLID_ENV_FILE: path.resolve('.test-data', 'integration', 'full.env'),
    ...(externalInfra ? fullIntegrationInfraEnv(externalInfra) : {}),
  };
  const runtimes: XpodRuntimeHandle[] = [];

  let testExitCode = 1;
  const qleverRuntimeFixture = createFakeQleverRuntimeCommand();
  try {
    if (startedInfra) {
      if (reuseRequested) {
        console.log('[full] Existing Compose infrastructure is unhealthy; recreating it.');
      }
      await runCommand('docker', [...composeArgs, 'down', '-v', '--remove-orphans'], { allowFailure: true });
    } else if (!externalInfra) {
      console.log('[full] Reusing healthy Compose postgres/redis/minio on localhost.');
    }

    if (startedInfra) {
      await runCommand('docker', [...composeArgs, 'up', '-d', 'postgres', 'redis', 'minio']);
      await waitForInfraServices();
    }
    runtimes.push(...await startFullRuntimes(ports, qleverRuntimeFixture.command, infrastructurePorts, externalInfra));
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
    try {
      if (startedInfra && process.env.XPOD_FULL_KEEP_RUNNING !== 'true') {
        await runCommand('docker', [...composeArgs, 'down', '-v', '--remove-orphans'], { allowFailure: true });
      }
    } finally {
      qleverRuntimeFixture.cleanup();
      await overlay.cleanup();
    }
  }

  process.exitCode = testExitCode;
  } finally {
    for (const [key, value] of Object.entries(oldEnv)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  }
}

if (import.meta.main) main().catch((error) => {
  if (process.env.XPOD_FULL_INFRA_ENV_FILE !== undefined) {
    const category = error instanceof Error && /^Full integration external (configuration invalid|postgres unhealthy|redis unhealthy|s3 unhealthy)$/u.test(error.message)
      ? error.message : 'Full integration external execution failed';
    console.error(category);
  } else {
    console.error(error);
  }
  process.exit(1);
});
