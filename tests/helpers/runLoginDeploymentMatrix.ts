import { spawn, spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { getFreePort } from '../../src/runtime/port-finder';
import { XpodTestStack } from './XpodTestStack';

// Three real deployment topologies; no fake QLever or open authentication.
// Standalone is the local edition with its own issuer, as in the shipped
// docker-compose.acceptance.yml. Managed Local is a distinct service using Cloud.
console.log(`Login deployment matrix Bun runtime: ${process.versions.bun ?? 'not-bun'}`);
const nativeCommand = process.env.XPOD_QLEVER_LOCAL_RUNTIME_COMMAND;
if (!nativeCommand) throw new Error('Set XPOD_QLEVER_LOCAL_RUNTIME_COMMAND to the installed native QLever runtime');
await mkdir(path.resolve('.test-data'), { recursive: true });
const root = await mkdtemp(path.resolve('.test-data/login-deployment-matrix-'));
const cloud = new XpodTestStack();
const managed = new XpodTestStack();
const standalone = new XpodTestStack();
const containers: string[] = [];

function docker(args: string[]): void {
  if (spawnSync('docker', args, { stdio: 'pipe' }).status !== 0) throw new Error(`Matrix Docker ${args[0]} failed`);
}
function startContainer(service: string, args: string[]): string {
  const name = `xpod-login-matrix-${service}-${process.pid}`;
  docker(['run', '--rm', '-d', '--name', name, ...args]);
  containers.push(name);
  return name;
}
async function waitReady(check: () => Promise<boolean>): Promise<void> {
  for (let attempt = 0; attempt < 120; attempt++) {
    if (await check().catch(() => false)) return;
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  throw new Error('Matrix infrastructure did not become ready');
}

try {
  const pgPort = await getFreePort(26988);
  const minioPort = await getFreePort(pgPort + 1);
  const redisPort = await getFreePort(minioPort + 1);
  const pg = startContainer('pg', ['-p', `127.0.0.1:${pgPort}:5432`, '-e', 'POSTGRES_USER=xpod', '-e', 'POSTGRES_PASSWORD=xpod', '-e', 'POSTGRES_DB=login_matrix', 'postgres:16-alpine']);
  startContainer('minio', ['-p', `127.0.0.1:${minioPort}:9000`, '--entrypoint', 'sh', 'minio/minio:latest', '-c', 'mkdir -p /data/login-matrix && exec minio server /data']);
  const redis = startContainer('redis', ['-p', `127.0.0.1:${redisPort}:6379`, 'redis:7-alpine', 'redis-server', '--save', '', '--appendonly', 'no']);
  await waitReady(async () => spawnSync('docker', ['exec', pg, 'pg_isready', '-U', 'xpod'], { stdio: 'ignore' }).status === 0);
  await waitReady(async () => (await fetch(`http://localhost:${minioPort}/minio/health/live`)).ok);
  await waitReady(async () => spawnSync('docker', ['exec', redis, 'redis-cli', 'ping'], { stdio: 'ignore' }).status === 0);
  const pgUrl = `postgres://xpod:xpod@localhost:${pgPort}/login_matrix`;
  const cloudPort = await getFreePort(39001);
  await cloud.start('cloud', {
    // Upstream Solid permits HTTP localhost for development issuers. A remote
    // production Cloud uses HTTPS; a different HTTP 127/8 origin is intentionally rejected.
    transport: 'port', baseUrl: `http://localhost:${cloudPort}/`, gatewayPort: cloudPort,
    open: false, apiOpen: false, logLevel: 'error', envFile: undefined,
    runtimeRoot: path.join(root, 'cloud'), identityDbUrl: pgUrl, sparqlEndpoint: pgUrl,
    env: {
      XPOD_NODE_ID: `matrix-cloud-${process.pid}`, XPOD_LOCAL_SETUP_PATH: path.join(root, 'cloud-state.json'),
      XPOD_GATEWAY_LOCATOR_SECRET: 'disposable-login-matrix-locator',
      CSS_REDIS_CLIENT: `127.0.0.1:${redisPort}`, CSS_REDIS_USERNAME: '', CSS_REDIS_PASSWORD: '',
      CSS_MINIO_ENDPOINT: `http://localhost:${minioPort}`, CSS_MINIO_ACCESS_KEY: 'minioadmin',
      CSS_MINIO_SECRET_KEY: 'minioadmin', CSS_MINIO_BUCKET_NAME: 'login-matrix',
      CSS_EMAIL_CONFIG_HOST: '', CSS_EMAIL_CONFIG_PORT: '587', CSS_EMAIL_CONFIG_AUTH_USER: '', CSS_EMAIL_CONFIG_AUTH_PASS: '',
      CSS_ALLOWED_HOSTS: 'localhost,127.0.0.1', XPOD_EDGE_NODES_ENABLED: 'false',
    },
  });
  for (const [name, stack] of [['managed-local', managed], ['standalone', standalone]] as const) {
    const port = await getFreePort(name === 'managed-local' ? 39991 : 40991);
    const baseUrl = `http://localhost:${port}/`;
    await stack.start('local', {
      transport: 'port', baseUrl, gatewayPort: port, open: false, apiOpen: false,
      runtimeRoot: path.join(root, name), logLevel: 'error', envFile: undefined,
      env: {
        XPOD_NODE_ID: `matrix-${name}-${process.pid}`,
        SOLID_OIDC_ISSUER: name === 'managed-local' ? cloud.baseUrl : baseUrl,
        XPOD_PUBLIC_URL: baseUrl, XPOD_LOCAL_SETUP_PATH: path.join(root, `${name}-state.json`),
        XPOD_QLEVER_LOCAL_RUNTIME_COMMAND: nativeCommand,
      },
    });
  }
  const provision = await fetch(new URL('/provision/status', managed.baseUrl)).then(response => response.json()) as {
    managed?: boolean; registered?: boolean; oidcIssuer?: string; provisionCode?: string;
  };
  if (!provision.managed || !provision.registered || !provision.provisionCode
    || new URL(provision.oidcIssuer!).origin !== new URL(cloud.baseUrl).origin
    || new URL(managed.baseUrl).origin === new URL(cloud.baseUrl).origin) {
    throw new Error('Managed Local must be registered to the distinct Cloud issuer');
  }
  const manifest = ['cloud', 'managed-local', 'standalone'].map((mode, index) => {
    const stack = [cloud, managed, standalone][index];
    const suffix = `${process.pid}-${index}-${Date.now().toString(36)}`;
    return {
      mode, runnerBunVersion: process.versions.bun, baseUrl: stack.baseUrl, issuer: mode === 'managed-local' ? cloud.baseUrl : stack.baseUrl,
      account: { email: `matrix-${suffix}@example.com`, password: `Matrix-${suffix}-Pass123!`, username: `mx-${suffix}` },
    };
  });
  const manifestPath = path.join(root, 'private-manifest.json');
  await writeFile(manifestPath, JSON.stringify(manifest), { mode: 0o600 });
  // Reuse these exact deployments and browser-created accounts for Electron.
  // Separate artifact roots prevent a later Playwright run deleting an earlier failure trace.
  const evidenceRoot = path.resolve(`.test-data/login-deployment-results-${process.pid}`);
  await mkdir(evidenceRoot, { recursive: true, mode: 0o700 });
  for (const [name, spec] of [
    ['browser', 'tests/e2e/login-deployment-matrix.spec.ts'],
    ['desktop', 'tests/e2e/desktop-login-lifecycle.spec.ts'],
  ]) {
    process.exitCode = await new Promise<number>((resolve, reject) => {
      const child = spawn('bunx', ['playwright', 'test', spec, '--workers=1', '--max-failures=1', '--reporter=line,json', '--output', path.join(evidenceRoot, name)], {
        stdio: 'inherit', env: { ...process.env, XPOD_E2E_LOGIN_MATRIX_MANIFEST: manifestPath,
          PLAYWRIGHT_JSON_OUTPUT_FILE: path.join(evidenceRoot, name, 'report.json') },
      });
      child.once('error', reject);
      child.once('exit', code => resolve(code ?? 1));
    });
    if (process.exitCode !== 0) break;
  }
} finally {
  await standalone.stop();
  await managed.stop();
  await cloud.stop();
  if (containers.length) spawnSync('docker', ['stop', ...containers], { stdio: 'ignore' });
  await rm(root, { recursive: true, force: true });
}
process.exit(process.exitCode ?? 0);
