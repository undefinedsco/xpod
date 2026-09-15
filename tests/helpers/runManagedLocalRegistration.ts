import { spawn, spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { getFreePort } from '../../src/runtime/port-finder';
import { XpodTestStack } from './XpodTestStack';

// Run the same browser acceptance against two real, disposable services.
// Cloud uses PostgreSQL/Redis/MinIO; Local uses the configured native QLever.
const nativeCommand = process.env.XPOD_QLEVER_LOCAL_RUNTIME_COMMAND;
if (!nativeCommand) throw new Error('Set XPOD_QLEVER_LOCAL_RUNTIME_COMMAND to the installed native QLever runtime');
const cloud = new XpodTestStack();
const local = new XpodTestStack();
const containers: string[] = [];
await mkdir(path.resolve('.test-data'), { recursive: true });
const root = await mkdtemp(path.resolve('.test-data/managed-local-stack-'));

function docker(args: string[]): void {
  const result = spawnSync('docker', args, { stdio: 'pipe' });
  if (result.status !== 0) throw new Error(`Docker ${args[0]} failed for the managed registration fixture`);
}

async function waitReady(check: () => Promise<boolean>): Promise<void> {
  for (let attempt = 0; attempt < 120; attempt++) {
    if (await check().catch(() => false)) return;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error('Managed registration fixture dependency did not become ready');
}

function startContainer(service: string, args: string[]): void {
  const name = `xpod-registration-${service}-${process.pid}`;
  docker(['run', '--rm', '-d', '--name', name, ...args]);
  containers.push(name);
}

try {
  const pgPort = await getFreePort(26988);
  const minioPort = await getFreePort(pgPort + 1);
  const redisPort = await getFreePort(minioPort + 1);
  startContainer('pg', ['-p', `127.0.0.1:${pgPort}:5432`, '-e', 'POSTGRES_USER=xpod', '-e', 'POSTGRES_PASSWORD=xpod', '-e', 'POSTGRES_DB=registration', 'postgres:16-alpine']);
  startContainer('minio', ['-p', `127.0.0.1:${minioPort}:9000`, '--entrypoint', 'sh', 'minio/minio:latest', '-c', 'mkdir -p /data/registration && exec minio server /data']);
  startContainer('redis', ['-p', `127.0.0.1:${redisPort}:6379`, 'redis:7-alpine', 'redis-server', '--save', '', '--appendonly', 'no']);
  await waitReady(async () => spawnSync('docker', ['exec', containers[0], 'pg_isready', '-U', 'xpod'], { stdio: 'ignore' }).status === 0);
  await waitReady(async () => (await fetch(`http://localhost:${minioPort}/minio/health/live`)).ok);
  await waitReady(async () => spawnSync('docker', ['exec', containers[2], 'redis-cli', 'ping'], { stdio: 'ignore' }).status === 0);

  const pgUrl = `postgres://xpod:xpod@localhost:${pgPort}/registration`;
  await cloud.start('cloud', {
    transport: 'port', open: false, apiOpen: false, logLevel: 'error',
    runtimeRoot: path.join(root, 'cloud'), identityDbUrl: pgUrl, sparqlEndpoint: pgUrl,
    env: {
      XPOD_NODE_ID: `registration-cloud-${process.pid}`,
      XPOD_LOCAL_SETUP_PATH: path.join(root, 'cloud-state.json'),
      XPOD_GATEWAY_LOCATOR_SECRET: 'managed-registration-test-secret',
      CSS_REDIS_CLIENT: `127.0.0.1:${redisPort}`, CSS_REDIS_USERNAME: '', CSS_REDIS_PASSWORD: '',
      CSS_MINIO_ENDPOINT: `http://localhost:${minioPort}`, CSS_MINIO_ACCESS_KEY: 'minioadmin',
      CSS_MINIO_SECRET_KEY: 'minioadmin', CSS_MINIO_BUCKET_NAME: 'registration',
      CSS_EMAIL_CONFIG_HOST: '', CSS_EMAIL_CONFIG_PORT: '587', CSS_EMAIL_CONFIG_AUTH_USER: '', CSS_EMAIL_CONFIG_AUTH_PASS: '',
      CSS_ALLOWED_HOSTS: 'localhost,127.0.0.1', XPOD_EDGE_NODES_ENABLED: 'false',
    },
  });
  const localPort = await getFreePort(39991);
  const baseUrl = `http://127.0.0.1:${localPort}/`;
  await local.start('local', {
    transport: 'port', baseUrl, gatewayPort: localPort, open: false, apiOpen: false,
    runtimeRoot: path.join(root, 'local'), logLevel: 'error',
    env: {
      XPOD_NODE_ID: `registration-local-${process.pid}`,
      SOLID_OIDC_ISSUER: cloud.baseUrl,
      XPOD_PUBLIC_URL: baseUrl,
      XPOD_LOCAL_SETUP_PATH: path.join(root, 'local-state.json'),
      XPOD_QLEVER_LOCAL_RUNTIME_COMMAND: nativeCommand,
    },
  });
  const status = await fetch(`${baseUrl}provision/status`).then((response) => response.json()) as { managed?: boolean; registered?: boolean; provisionCode?: string };
  if (!status.managed || !status.registered || !status.provisionCode) throw new Error('The real Local node did not register with the real Cloud');
  const exitCode = await new Promise<number>((resolve, reject) => {
    const child = spawn('bunx', ['playwright', 'test', 'tests/e2e/managed-local-registration.spec.ts', '--workers=1'], {
      stdio: 'inherit',
      env: { ...process.env, XPOD_E2E_LIVE_URL: baseUrl },
    });
    child.once('error', reject);
    child.once('exit', (code) => resolve(code ?? 1));
  });
  process.exitCode = exitCode;
} finally {
  await local.stop();
  await cloud.stop();
  if (containers.length) spawnSync('docker', ['stop', ...containers], { stdio: 'ignore' });
  await rm(root, { recursive: true, force: true });
}

// Match the integration runner: shared database maintenance timers can remain
// after all fixture services and containers have been explicitly stopped.
process.exit(process.exitCode ?? 0);
