import { afterEach, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { getLoggerFor } from 'global-logger-factory';
import { bootstrapStartRuntime } from '../src/commands/start';
import { autoProvisionFirstRunLocal } from '../../../src/provision/first-run-registration';

/**
 * CAUSAL contract regression for the modular launcher bootstrap.
 *
 * Unlike the stubbed cases in start-bootstrap.test.ts, this file runs the REAL
 * bootstrapStartRuntime with the REAL autoProvisionFirstRunLocal (no injected
 * provision stub, no fetch mock): a local Bun.serve fixture answers
 * POST /provision/nodes. It therefore fails if the launcher stops passing the
 * resolved nodeId / provider-scoped setup path, which is exactly the defect that
 * once made first-run registration a silent no-op.
 *
 * This is unit/contract coverage only — NOT Xpod acceptance, and it never
 * contacts an external origin.
 */

const base = path.resolve('.test-data', 'rc421-bootstrap-http');
const ENV_KEYS = [
  'SOLID_OIDC_ISSUER', 'XPOD_PUBLIC_URL', 'CSS_BASE_URL', 'XPOD_NODE_ID',
  'XPOD_NODE_TOKEN', 'XPOD_SERVICE_TOKEN', 'XPOD_PROVISION_CODE', 'XPOD_SP_DOMAIN',
  'XPOD_LOCAL_SETUP_PATH', 'XPOD_PROVIDER_ID', 'XPOD_TUNNEL_PROVIDER',
  'XPOD_PROVISION_URL', 'XPOD_API_BASE_URL', 'CSS_ROOT_FILE_PATH',
] as const;

/** The slice of the Bun server API this fixture uses (the repo does not install
 * @types/bun, so global APIs are declared at the point of use). */
declare const Bun: {
  serve(options: {
    port: number;
    hostname?: string;
    fetch(request: Request): Response | Promise<Response>;
  }): { port: number; stop(force?: boolean): void };
};

const saved = new Map<string, string | undefined>();
const roots: string[] = [];
let server: ReturnType<typeof Bun.serve> | undefined;

const managedProvisionCode = (): string => {
  // Shape the extracted function accepts for a managed route: base64url payload
  // before the first '.', fresh expiries, nodeId + signalApiUrl + route token.
  const payload = {
    spUrl: 'https://device.example/',
    serviceAccessToken: 'sat-fixture-value',
    serviceAccessTokenExp: Math.floor(Date.now() / 1000) + 3600,
    signalApiUrl: 'https://api.example/',
    routeAccessToken: 'route-fixture-value',
    routeAccessTokenExp: Math.floor(Date.now() / 1000) + 3600,
    nodeId: 'placeholder',
    spDomain: 'device.example',
    exp: Math.floor(Date.now() / 1000) + 3600,
  };
  return `${Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')}.fixture-signature`;
};

const setEnv = (values: Record<string, string>): void => {
  for (const [key, value] of Object.entries(values)) process.env[key] = value;
};

const makeRoot = async (): Promise<string> => {
  await mkdir(base, { recursive: true });
  const dir = await mkdtemp(path.join(base, 'case-'));
  roots.push(dir);
  return dir;
};

afterEach(async () => {
  for (const key of ENV_KEYS) {
    const previous = saved.get(key);
    if (previous === undefined) delete process.env[key];
    else process.env[key] = previous;
  }
  saved.clear();
  try { server?.stop(true); } catch { /* already stopped */ }
  server = undefined;
  for (const dir of roots.splice(0)) await rm(dir, { recursive: true, force: true });
});

/** Records the exact incoming request the real function sends. */
const startProvisionServer = (): { url: string; bodies: Array<Record<string, unknown>> } => {
  const bodies: Array<Record<string, unknown>> = [];
  server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    async fetch(request) {
      const url = new URL(request.url);
      if (request.method !== 'POST' || url.pathname !== '/provision/nodes') {
        return new Response('not found', { status: 404 });
      }
      bodies.push(await request.json() as Record<string, unknown>);
      return Response.json({
        nodeId: 'device-fixture-node',
        nodeToken: 'node-token-fixture',
        serviceToken: 'service-token-fixture',
        provisionCode: managedProvisionCode(),
        publicUrl: 'https://device.example/',
        spDomain: 'device.example',
      }, { status: 201 });
    },
  });
  return { url: `http://127.0.0.1:${server.port}`, bodies };
};

test('real first-run registration sends the resolved device id and persists provider state under --data', async () => {
  for (const key of ENV_KEYS) saved.set(key, process.env[key]);
  const dir = await makeRoot();
  const data = path.join(dir, 'data');
  const elsewhere = path.join(dir, 'elsewhere-root');
  await mkdir(data, { recursive: true });
  await mkdir(elsewhere, { recursive: true });

  // Deliberately point the global child root ELSEWHERE: the launcher must still
  // resolve device identity and setup state under its own resolved --data.
  setEnv({
    CSS_ROOT_FILE_PATH: elsewhere,
    SOLID_OIDC_ISSUER: 'https://id.example/',
    XPOD_TUNNEL_PROVIDER: 'none',
  });
  delete process.env.XPOD_PUBLIC_URL;
  delete process.env.XPOD_NODE_ID;
  delete process.env.XPOD_LOCAL_SETUP_PATH;
  delete process.env.XPOD_PROVIDER_ID;
  delete process.env.XPOD_NODE_TOKEN;
  delete process.env.XPOD_SERVICE_TOKEN;
  delete process.env.XPOD_PROVISION_CODE;
  delete process.env.XPOD_SP_DOMAIN;
  delete process.env.CSS_BASE_URL;
  delete process.env.XPOD_API_BASE_URL;

  // The fixture origin is the Cloud API endpoint; issuing it here keeps the
  // request local. cloudApiEndpointFromIssuer/issuer stay untouched.
  const fixture = startProvisionServer();
  const port = 3000;

  const first = await bootstrapStartRuntime({
    ids: ['css', 'api'], mode: 'local', host: '127.0.0.1', port,
    configuredBaseUrl: `http://127.0.0.1:${port}/`, data,
  }, { ...process.env, XPOD_CLOUD_API_ENDPOINT: fixture.url }, (config) => {
    // REAL function; only its own documented cloudApiEndpoint field is pointed at
    // the local fixture origin. No stub, no mocked response, no fetch mock.
    return autoProvisionFirstRunLocal(
      { ...config, cloudApiEndpoint: fixture.url },
      getLoggerFor('BootstrapHttpTest'),
    );
  });

  const deviceId = (await readFile(path.join(data, '.device-id'), 'utf8')).trim();
  expect(deviceId).not.toBe('');
  // The device id was generated under the launcher's --data, not CSS_ROOT_FILE_PATH.
  await expect(readFile(path.join(elsewhere, '.device-id'), 'utf8')).rejects.toThrow();

  expect(fixture.bodies).toHaveLength(1);
  expect(fixture.bodies[0]!.nodeId).toBe(deviceId);
  expect(first.baseUrl).toBe('https://device.example/');
  expect(first.childIdentity).toMatchObject({
    nodeId: 'device-fixture-node',
    nodeToken: 'node-token-fixture',
    serviceToken: 'service-token-fixture',
    publicUrl: 'https://device.example/',
    spDomain: 'device.example',
    localSetupPath: path.join(data, '.xpod-cloud-registration.json'),
  });

  // Provider-scoped state was persisted under the resolved --data root.
  const statePath = path.join(data, '.xpod-cloud-registration.json');
  const persisted = JSON.parse(await readFile(statePath, 'utf8')) as Record<string, { publicUrl?: string }>;
  expect(persisted.local?.publicUrl).toBe('https://device.example/');

  // Warm restart keeps the same identity and canonical authority, and the same
  // device id is reused rather than regenerated.
  const second = await bootstrapStartRuntime({
    ids: ['css', 'api'], mode: 'local', host: '127.0.0.1', port,
    configuredBaseUrl: `http://127.0.0.1:${port}/`, data,
  }, { ...process.env, XPOD_CLOUD_API_ENDPOINT: fixture.url, XPOD_PUBLIC_URL: 'https://device.example/' },
    (config) => Promise.resolve(config));

  expect(second.childIdentity.nodeId).toBe('device-fixture-node');
  expect(second.baseUrl).toBe('https://device.example/');
  expect((await readFile(path.join(data, '.device-id'), 'utf8')).trim()).toBe(deviceId);
});

test('omitting the resolved nodeId makes the real registration a no-op (guards the causal defect)', async () => {
  for (const key of ENV_KEYS) saved.set(key, process.env[key]);
  const dir = await makeRoot();
  const data = path.join(dir, 'data');
  await mkdir(data, { recursive: true });
  setEnv({ SOLID_OIDC_ISSUER: 'https://id.example/', XPOD_TUNNEL_PROVIDER: 'none' });
  delete process.env.XPOD_NODE_ID;
  delete process.env.XPOD_PUBLIC_URL;
  delete process.env.CSS_BASE_URL;
  delete process.env.XPOD_API_BASE_URL;

  const fixture = startProvisionServer();
  const logger = getLoggerFor('BootstrapHttpTest');

  // Directly exercise the REAL function with the identity the launcher would
  // pass if it forgot nodeId: no request may be sent.
  const result = await autoProvisionFirstRunLocal({
    edition: 'local', host: '127.0.0.1', port: 3000,
    baseUrl: 'http://127.0.0.1:3000/', solidBaseUrl: 'http://127.0.0.1:3000/',
    rootDir: data, publicUrl: undefined,
    cloudApiEndpoint: fixture.url, oidcIssuer: 'https://id.example/',
  }, logger);

  expect(fixture.bodies).toHaveLength(0);
  expect(result.publicUrl).toBeUndefined();
});

test('cloud mode keeps its configured base URL and never adopts an env publicUrl', async () => {
  for (const key of ENV_KEYS) saved.set(key, process.env[key]);
  const dir = await makeRoot();
  const data = path.join(dir, 'data');
  await mkdir(data, { recursive: true });

  // The env publicUrl is a DIFFERENT origin from the configured Cloud authority.
  setEnv({
    SOLID_OIDC_ISSUER: 'https://id.example/',
    XPOD_PUBLIC_URL: 'https://other.example/',
    XPOD_TUNNEL_PROVIDER: 'none',
  });
  delete process.env.XPOD_NODE_ID;
  delete process.env.CSS_BASE_URL;
  delete process.env.XPOD_API_BASE_URL;

  const fixture = startProvisionServer();
  const first = await bootstrapStartRuntime({
    ids: ['css', 'api'], mode: 'cloud', host: '127.0.0.1', port: 3000,
    configuredBaseUrl: 'https://cloud.example/', data,
  }, { ...process.env, XPOD_CLOUD_API_ENDPOINT: fixture.url }, (config) => {
    return autoProvisionFirstRunLocal(
      { ...config, cloudApiEndpoint: fixture.url },
      getLoggerFor('BootstrapHttpTest'),
    );
  });

  // No registration may be attempted for a Cloud runtime.
  expect(fixture.bodies).toHaveLength(0);
  // The explicit Cloud authority wins over the env publicUrl.
  expect(first.baseUrl).toBe('https://cloud.example/');
  // The resolved identity value is still carried to children unchanged.
  expect(first.childIdentity.publicUrl).toBe('https://other.example/');
});
