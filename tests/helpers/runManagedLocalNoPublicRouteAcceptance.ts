import { spawn, spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile, chmod } from 'node:fs/promises';
import path from 'node:path';
import { getFreePortForWildcard } from '../../src/runtime/port-finder';
import { XpodTestStack } from './XpodTestStack';
import { hasObjectStore, objectStoreContainerArgs, OBJECT_STORE_PORT } from './dockerObjectStore';

// Isolated real deployments, never the installed user's Gateway or desktop data.
const nativeCommand = process.env.XPOD_QLEVER_LOCAL_RUNTIME_COMMAND;
if (!nativeCommand) throw new Error('Set XPOD_QLEVER_LOCAL_RUNTIME_COMMAND to a real native QLever runtime');
await mkdir(path.resolve('.test-data'), { recursive: true });
const root = await mkdtemp(path.resolve('.test-data/managed-local-no-public-route-'));
await chmod(root, 0o700);
const cloud = new XpodTestStack();
const local = new XpodTestStack();
const containers: string[] = [];
function docker(args: string[]): void {
  if (spawnSync('docker', args, { stdio: 'pipe' }).status !== 0) throw new Error(`Acceptance Docker ${args[0]} failed`);
}
function container(label: string, args: string[]): string {
  const name = `xpod-no-public-${label}-${process.pid}`;
  docker(['run', '--rm', '-d', '--name', name, ...args]);
  containers.push(name);
  return name;
}
async function ready(check: () => Promise<boolean>): Promise<void> {
  for (let attempt = 0; attempt < 120; attempt++) {
    if (await check().catch(() => false)) return;
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  throw new Error('Acceptance infrastructure not ready');
}
try {
  const pgPort = await getFreePortForWildcard(27100);
  const s3Port = await getFreePortForWildcard(pgPort + 1);
  const redisPort = await getFreePortForWildcard(s3Port + 1);
  const pg = container('pg', ['-p', `127.0.0.1:${pgPort}:5432`, '-e', 'POSTGRES_USER=xpod', '-e', 'POSTGRES_PASSWORD=xpod', '-e', 'POSTGRES_DB=no_public', 'postgres:16-alpine']);
  container('s3', ['-p', `127.0.0.1:${s3Port}:${OBJECT_STORE_PORT}`, ...objectStoreContainerArgs('no-public')]);
  const redis = container('redis', ['-p', `127.0.0.1:${redisPort}:6379`, 'redis:7-alpine', 'redis-server', '--save', '', '--appendonly', 'no']);
  await ready(async () => spawnSync('docker', ['exec', pg, 'pg_isready', '-h', '127.0.0.1', '-U', 'xpod', '-d', 'no_public'], { stdio: 'ignore' }).status === 0);
  await ready(() => hasObjectStore(s3Port, 'no-public'));
  await ready(async () => spawnSync('docker', ['exec', redis, 'redis-cli', 'ping'], { stdio: 'ignore' }).status === 0);
  const cloudPort = await getFreePortForWildcard(42100);
  const localPort = await getFreePortForWildcard(43100);
  const canonicalPort = await getFreePortForWildcard(44100);
  const canonical = `http://localhost:${canonicalPort}/`;
  const pgUrl = `postgres://xpod:xpod@localhost:${pgPort}/no_public`;
  await cloud.start('cloud', {
    transport: 'port', baseUrl: `http://localhost:${cloudPort}/`, gatewayPort: cloudPort,
    authMode: 'acp', open: false, apiOpen: false, logLevel: 'warn', envFile: undefined,
    runtimeRoot: path.join(root, 'cloud'), identityDbUrl: pgUrl, sparqlEndpoint: pgUrl,
    env: {
      XPOD_NODE_ID: `no-public-cloud-${process.pid}`, XPOD_LOCAL_SETUP_PATH: path.join(root, 'cloud-state.json'),
      XPOD_GATEWAY_LOCATOR_SECRET: 'disposable-no-public-route-locator',
      CSS_REDIS_CLIENT: `127.0.0.1:${redisPort}`, CSS_REDIS_USERNAME: '', CSS_REDIS_PASSWORD: '',
      CSS_MINIO_ENDPOINT: `http://localhost:${s3Port}`, CSS_MINIO_ACCESS_KEY: 'minioadmin', CSS_MINIO_SECRET_KEY: 'minioadmin', CSS_MINIO_BUCKET_NAME: 'no-public',
      CSS_EMAIL_CONFIG_HOST: '', CSS_EMAIL_CONFIG_PORT: '587', CSS_EMAIL_CONFIG_AUTH_USER: '', CSS_EMAIL_CONFIG_AUTH_PASS: '',
      CSS_ALLOWED_HOSTS: 'localhost,127.0.0.1', XPOD_EDGE_NODES_ENABLED: 'false',
    },
  });
  await local.start('local', {
    transport: 'port', baseUrl: `http://localhost:${localPort}/`, gatewayPort: localPort,
    authMode: 'acp', open: false, apiOpen: false, logLevel: 'warn', envFile: undefined,
    runtimeRoot: path.join(root, 'local'),
    env: { XPOD_NODE_ID: `no-public-local-${process.pid}`, SOLID_OIDC_ISSUER: cloud.baseUrl,
      XPOD_PUBLIC_URL: canonical, XPOD_LOCAL_SETUP_PATH: path.join(root, 'local-state.json'),
      XPOD_QLEVER_LOCAL_RUNTIME_COMMAND: nativeCommand },
  });
  // The canonical data identity has no listener from runtime startup onward.
  // Cloud identity/profile preparation and Local provisioning use their actual
  // private endpoints; no public relay, route interception, or forged receipt.
  let canonicalUnavailableFromStartup = false;
  try {
    await fetch(canonical, { signal: AbortSignal.timeout(2_000) });
  } catch (error) {
    const pending: unknown[] = [error];
    while (pending.length) {
      const candidate = pending.shift() as { code?: string; cause?: unknown; errors?: unknown[] } | undefined;
      if (!candidate || typeof candidate !== 'object') continue;
      // Node and Bun expose different codes for the same refused TCP connection.
      if (candidate.code === 'ECONNREFUSED' || candidate.code === 'ConnectionRefused') canonicalUnavailableFromStartup = true;
      if (candidate.cause) pending.push(candidate.cause);
      if (candidate.errors) pending.push(...candidate.errors);
    }
  }
  if (!canonicalUnavailableFromStartup) throw new Error('Canonical Local data URL must refuse connections before provisioning');
  const localStates = JSON.parse(await readFile(path.join(root, 'local-state.json'), 'utf8')) as Record<string, { serviceToken?: string }>;
  const serviceToken = Object.values(localStates).find(state => state.serviceToken)?.serviceToken;
  if (!serviceToken) throw new Error('Actual Local registration did not persist its service token');
  const suffix = `${process.pid}-${Date.now().toString(36)}`;
  const manifestPath = path.join(root, 'private-manifest.json');
  await writeFile(manifestPath, JSON.stringify({ baseUrl: local.baseUrl, canonical, issuer: cloud.baseUrl,
    canonicalUnavailableFromStartup, serviceToken, localRuntimeRoot: path.join(root, 'local'), runnerBunVersion: process.versions.bun, runnerExecPath: process.execPath, runnerCwd: process.cwd(),
    account: { email: `no-public-${suffix}@example.com`, password: `Acceptance-${suffix}-Pass123!`, username: `np-${suffix}` },
  }), { mode: 0o600 });
  const output = path.join(root, 'evidence');
  await mkdir(output, { mode: 0o700 });
  const exit = await new Promise<number>((resolve, reject) => {
    const child = spawn('bunx', ['playwright', 'test', 'tests/e2e/managed-local-no-public-route.spec.ts', '--workers=1', '--max-failures=1', '--reporter=line,json', '--output', output], {
      stdio: 'inherit', env: { ...process.env, XPOD_E2E_NO_PUBLIC_ROUTE_MANIFEST: manifestPath,
        PLAYWRIGHT_JSON_OUTPUT_FILE: path.join(output, 'report.json') },
    });
    child.once('error', reject);
    child.once('exit', code => resolve(code ?? 1));
  });
  await writeFile(path.join(root, 'safe-result.json'), JSON.stringify({ exit, runnerBunVersion: process.versions.bun,
    realCloud: true, realNativeLocal: true, isolatedFixture: true, realUpstreamChat: false }), { mode: 0o600 });
  process.exitCode = exit;
  console.log(`Isolated no-public-route acceptance exit=${exit}; evidence=${root}`);
} finally {
  await local.stop();
  await cloud.stop();
  if (containers.length) spawnSync('docker', ['stop', ...containers], { stdio: 'ignore' });
}
process.exit(process.exitCode ?? 0);
