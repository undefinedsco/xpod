import { spawn, spawnSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { getFreePortForWildcard } from '../../src/runtime/port-finder';
import { deriveProvisionReceiptSecret, verifyProvisionReceipt } from '../../src/provision/ProvisionReceiptCodec';
import { bootstrapAccountPasswordLogin } from '../../ui/src/utils/registration-flow';
import { prepareProvisionedPod } from '../../ui/src/utils/provision-scope';
import { XpodTestStack } from './XpodTestStack';
import { hasObjectStore, objectStoreContainerArgs, OBJECT_STORE_PORT } from './dockerObjectStore';
import type { DesktopRememberDeployment } from '../e2e/desktop-account-remember.spec';

const nativeCommand = process.env.XPOD_QLEVER_LOCAL_RUNTIME_COMMAND;
if (!nativeCommand) throw new Error('Set XPOD_QLEVER_LOCAL_RUNTIME_COMMAND to a real native QLever runtime');
await mkdir(path.resolve('.test-data'), { recursive: true });
const root = await mkdtemp(path.resolve('.test-data/desktop-account-remember-acceptance-'));
await chmod(root, 0o700);
const cloud = new XpodTestStack();
const local = new XpodTestStack();
const containers: string[] = [];
const safeBootstrap: Array<Record<string, unknown>> = [];
function docker(args: string[]): void {
  if (spawnSync('docker', args, { stdio: 'pipe' }).status !== 0) throw new Error(`Remember fixture Docker ${args[0]} failed`);
}
function container(label: string, args: string[]): string {
  const name = `xpod-remember-${label}-${process.pid}`;
  docker(['run', '--rm', '-d', '--name', name, ...args]);
  containers.push(name);
  return name;
}
async function waitReady(check: () => Promise<boolean>): Promise<void> {
  for (let attempt = 0; attempt < 120; attempt++) {
    if (await check().catch(() => false)) return;
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  throw new Error('Remember fixture infrastructure did not become ready');
}
// Reuse the product's Account bootstrap and Cloud-profile/Local-receipt
// preparation APIs. This fetch only preserves private failed response bodies;
// it never manufactures an authentication response or browser state.
const fixtureFetch: typeof fetch = async (input, init) => {
  const response = await fetch(input, { ...init, redirect: 'error', signal: AbortSignal.timeout(30_000) });
  if (!response.ok) {
    await writeFile(path.join(root, `private-failed-response-${randomUUID()}.json`), JSON.stringify({
      status: response.status, body: await response.clone().text(),
    }), { mode: 0o600 });
    throw new Error(`Remember fixture HTTP ${response.status}`);
  }
  return response;
};
try {
  const pgPort = await getFreePortForWildcard(28100);
  const s3Port = await getFreePortForWildcard(pgPort + 1);
  const redisPort = await getFreePortForWildcard(s3Port + 1);
  const pg = container('pg', ['-p', `127.0.0.1:${pgPort}:5432`, '-e', 'POSTGRES_USER=xpod', '-e', 'POSTGRES_PASSWORD=xpod', '-e', 'POSTGRES_DB=remember', 'postgres:16-alpine']);
  container('s3', ['-p', `127.0.0.1:${s3Port}:${OBJECT_STORE_PORT}`, ...objectStoreContainerArgs('remember')]);
  const redis = container('redis', ['-p', `127.0.0.1:${redisPort}:6379`, 'redis:7-alpine', 'redis-server', '--save', '', '--appendonly', 'no']);
  await waitReady(async () => spawnSync('docker', ['exec', pg, 'pg_isready', '-h', '127.0.0.1', '-U', 'xpod', '-d', 'remember'], { stdio: 'ignore' }).status === 0);
  await waitReady(() => hasObjectStore(s3Port, 'remember'));
  await waitReady(async () => spawnSync('docker', ['exec', redis, 'redis-cli', 'ping'], { stdio: 'ignore' }).status === 0);
  const cloudPort = await getFreePortForWildcard(45100);
  const localPort = await getFreePortForWildcard(46100);
  const pgUrl = `postgres://xpod:xpod@localhost:${pgPort}/remember`;
  await cloud.start('cloud', { transport: 'port', baseUrl: `http://localhost:${cloudPort}/`, gatewayPort: cloudPort,
    authMode: 'acp', open: false, apiOpen: false, logLevel: 'warn', envFile: undefined,
    runtimeRoot: path.join(root, 'cloud'), identityDbUrl: pgUrl, sparqlEndpoint: pgUrl,
    env: { XPOD_NODE_ID: `remember-cloud-${process.pid}`, XPOD_LOCAL_SETUP_PATH: path.join(root, 'cloud-state.json'),
      XPOD_GATEWAY_LOCATOR_SECRET: 'disposable-remember-locator',
      CSS_REDIS_CLIENT: `127.0.0.1:${redisPort}`, CSS_REDIS_USERNAME: '', CSS_REDIS_PASSWORD: '',
      CSS_MINIO_ENDPOINT: `http://localhost:${s3Port}`, CSS_MINIO_ACCESS_KEY: 'minioadmin', CSS_MINIO_SECRET_KEY: 'minioadmin', CSS_MINIO_BUCKET_NAME: 'remember',
      CSS_EMAIL_CONFIG_HOST: '', CSS_EMAIL_CONFIG_PORT: '587', CSS_EMAIL_CONFIG_AUTH_USER: '', CSS_EMAIL_CONFIG_AUTH_PASS: '',
      CSS_ALLOWED_HOSTS: 'localhost,127.0.0.1', XPOD_EDGE_NODES_ENABLED: 'false' },
  });
  const localBaseUrl = `http://127.0.0.1:${localPort}/`;
  await local.start('local', { transport: 'port', baseUrl: localBaseUrl, gatewayPort: localPort,
    authMode: 'acp', open: false, apiOpen: false, logLevel: 'warn', envFile: undefined, runtimeRoot: path.join(root, 'local'),
    env: { XPOD_NODE_ID: `remember-local-${process.pid}`, SOLID_OIDC_ISSUER: cloud.baseUrl, XPOD_PUBLIC_URL: localBaseUrl,
      XPOD_LOCAL_SETUP_PATH: path.join(root, 'local-state.json'), XPOD_QLEVER_LOCAL_RUNTIME_COMMAND: nativeCommand },
  });
  const status = await (await fixtureFetch(new URL('/provision/status', local.baseUrl))).json() as { managed: boolean; registered: boolean; oidcIssuer: string; provisionCode: string };
  if (!status.managed || !status.registered || status.oidcIssuer !== cloud.baseUrl || !status.provisionCode) throw new Error('Remember fixture is not registered to its Cloud');
  const states = JSON.parse(await readFile(path.join(root, 'local-state.json'), 'utf8')) as Record<string, { serviceToken?: string }>;
  const serviceToken = Object.values(states).find(state => state.serviceToken)?.serviceToken;
  if (!serviceToken) throw new Error('Remember fixture has no actual Local registration token');
  const manifest: DesktopRememberDeployment = { baseUrl: local.baseUrl, issuer: cloud.baseUrl, accounts: [] };
  for (const choice of [{ remember: false }, { remember: true }, { remember: true, role: 'alice' as const }, { remember: true, role: 'bob' as const }]) {
    const { remember } = choice;
    const role = 'role' in choice ? choice.role : undefined;
    const suffix = `${process.pid}-${role ?? (remember ? 'checked' : 'unchecked')}`;
    const account = { remember, ...(role ? { role } : {}), email: `remember-${suffix}@example.com`, password: `Remember-${randomUUID()}-Pass123!`, username: `rm-${suffix}` };
    const bootstrap = await bootstrapAccountPasswordLogin({ accountCreateUrl: new URL('/.account/account/', cloud.baseUrl).href,
      email: account.email, password: account.password, fetchImpl: fixtureFetch });
    const headers = { Accept: 'application/json', Authorization: `CSS-Account-Token ${bootstrap.accountToken}` };
    const index = await (await fixtureFetch(new URL('/.account/', cloud.baseUrl), { headers })).json() as { controls: { account: { profile: string; pod: string; bindings: string } } };
    const control = (value: string) => {
      const url = new URL(value, cloud.baseUrl);
      if (url.origin !== new URL(cloud.baseUrl).origin) throw new Error('Remember Account control escaped Cloud');
      return url.href;
    };
    const prepared = await prepareProvisionedPod(fixtureFetch, account.username, status.provisionCode,
      { profileUrl: control(index.controls.account.profile), headers });
    if (!prepared?.provisionReceipt || !prepared.preparedWebId) throw new Error('Remember preparation did not return Cloud identity and Local receipt');
    const podUrl = new URL(`${account.username}/`, local.baseUrl).href;
    const receipt = verifyProvisionReceipt(prepared.provisionReceipt, { secret: deriveProvisionReceiptSecret(serviceToken) });
    if (!receipt.valid || receipt.payload.webId !== prepared.preparedWebId || receipt.payload.podUrl !== podUrl
      || receipt.payload.podName !== account.username || !receipt.payload.podId) throw new Error('Remember Local receipt identity mismatch');
    const finalized = await (await fixtureFetch(control(index.controls.account.pod), { method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ name: account.username, settings: {
        webId: prepared.preparedWebId, provisionCode: status.provisionCode, provisionReceipt: prepared.provisionReceipt,
      } }) })).json() as { pod: string; webId: string };
    if (finalized.pod !== podUrl || finalized.webId !== prepared.preparedWebId || new URL(finalized.webId).origin !== new URL(cloud.baseUrl).origin) throw new Error('Remember Cloud finalization identity mismatch');
    const bindings = await (await fixtureFetch(control(index.controls.account.bindings), { headers })).json() as { bindings: Array<{ webId: string; storageUrl: string }> };
    if (bindings.bindings.length !== 1 || bindings.bindings[0].webId !== finalized.webId || bindings.bindings[0].storageUrl !== podUrl) throw new Error('Remember Cloud binding mismatch');
    manifest.accounts.push({ ...account, webId: finalized.webId, podUrl });
    safeBootstrap.push({ remember, ...(role ? { role } : {}), cloudIdentity: true, localReceiptVerified: true, exactBinding: true });
  }
  const manifestPath = path.join(root, 'private-manifest.json');
  await writeFile(manifestPath, JSON.stringify(manifest), { mode: 0o600 });
  const evidenceRoot = path.join(root, 'evidence');
  await mkdir(evidenceRoot, { mode: 0o700 });
  const exit = await new Promise<number>((resolve, reject) => {
    const child = spawn('bunx', ['playwright', 'test', 'tests/e2e/desktop-account-remember.spec.ts', '--workers=1', '--reporter=line,json', '--output', evidenceRoot], {
      stdio: 'inherit', env: { ...process.env, XPOD_E2E_DESKTOP_REMEMBER_MANIFEST: manifestPath,
        PLAYWRIGHT_JSON_OUTPUT_FILE: path.join(evidenceRoot, 'report.json') },
    });
    child.once('error', reject);
    child.once('exit', code => resolve(code ?? 1));
  });
  process.exitCode = exit;
  await writeFile(path.join(root, 'safe-result.json'), JSON.stringify({ exit, crossSite: true, realNativeLocal: true,
    realCloud: true, isolatedFixture: true, checkedAccountCookieOnlyReauthorization: exit === 0, bootstrap: safeBootstrap }), { mode: 0o600 });
  console.log(`Isolated cross-site Account remember acceptance exit=${exit}; evidence=${root}`);
} finally {
  await local.stop();
  await cloud.stop();
  if (containers.length) spawnSync('docker', ['stop', ...containers], { stdio: 'ignore' });
}
process.exit(process.exitCode ?? 0);
