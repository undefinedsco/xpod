import { expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { bootstrapStartRuntime } from '../src/commands/start';
import { loadOrGenerateDeviceId } from '../../../src/provision/device-id';
import { loadRuntimeIdentity } from '../../../src/provision/local-identity';

/**
 * The modular launcher must establish the SAME identity authority the API child
 * loads, BEFORE it creates CSS. These cases pin the completion of that config
 * (node id, provider-scoped state, canonical public URL) and the mode gates.
 */

const base = path.resolve('.test-data/cli-bootstrap');
const roots: string[] = [];
const root = async(): Promise<string> => {
  await mkdir(base, { recursive: true });
  const dir = await mkdtemp(path.join(base, 'case-'));
  roots.push(dir);
  return dir;
};
const cleanup = async(): Promise<void> => {
  for (const dir of roots.splice(0)) await rm(dir, { recursive: true, force: true });
};
const managedCode = (nodeId = 'local-device-id'): string => {
  const payload = {
    spUrl: 'https://node-0000.undefineds.co/',
    serviceAccessToken: 'sat-test',
    serviceAccessTokenExp: Math.floor(Date.now() / 1000) + 3600,
    signalApiUrl: 'https://api.undefineds.co/',
    routeAccessToken: 'route-once',
    routeAccessTokenExp: Math.floor(Date.now() / 1000) + 3600,
    nodeId,
    spDomain: 'node-0000.undefineds.co',
    exp: Math.floor(Date.now() / 1000) + 3600,
  };
  return `${Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')}.signature`;
};
const publicResponse = (nodeId: string, publicUrl: string): Response => Response.json({
  nodeId,
  nodeToken: 'node-token-issued',
  serviceToken: 'service-token-issued',
  provisionCode: managedCode(nodeId),
  publicUrl,
  spDomain: new URL(publicUrl).hostname,
}, { status: 201 });

test('cold ENV-only issuer generates a stable device id and registers before children', async() => {
  const dir = await root();
  const data = path.join(dir, 'data');
  await mkdir(data, { recursive: true });
  const env = { SOLID_OIDC_ISSUER: 'https://cloud.example/' };
  const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
  const provision = (async(_config: unknown) => {
    // The shared implementation's request body is built from the SAME identity.
    const identity = loadRuntimeIdentity(env, 'local', data);
    calls.push({ url: 'https://cloud.example/provision/nodes', body: { nodeId: identity.nodeId! } });
    return {
      edition: 'local', host: '127.0.0.1', port: 3000,
      nodeId: identity.nodeId, nodeToken: 'node-token-issued', serviceToken: 'service-token-issued',
      provisionCode: managedCode(identity.nodeId!), publicUrl: 'https://node-0000.undefineds.co/',
      spDomain: 'node-0000.undefineds.co', oidcIssuer: 'https://cloud.example/',
    };
  }) as unknown as typeof import('../../../src/provision/first-run-registration').autoProvisionFirstRunLocal;

  const first = await bootstrapStartRuntime({
    ids: ['css', 'api'], mode: 'local', host: '127.0.0.1', port: 3000,
    configuredBaseUrl: 'http://127.0.0.1:3000/', data,
  }, env, provision);

  const persisted = (await readFile(path.join(data, '.device-id'), 'utf8')).trim();
  expect(persisted).not.toBe('');
  expect(calls).toHaveLength(1);
  expect(calls[0]!.body.nodeId).toBe(persisted);
  expect(first.baseUrl).toBe('https://node-0000.undefineds.co/');
  expect(first.externalOidcIssuer).toBe('https://cloud.example/');
  expect(first.childIdentity).toMatchObject({
    nodeId: persisted, nodeToken: 'node-token-issued', serviceToken: 'service-token-issued',
    publicUrl: 'https://node-0000.undefineds.co/', localSetupPath: path.join(data, '.xpod-cloud-registration.json'),
  });

  // A warm start reuses the SAME device id and the SAME provider-scoped record.
  const second = await bootstrapStartRuntime({
    ids: ['css', 'api'], mode: 'local', host: '127.0.0.1', port: 3000,
    configuredBaseUrl: 'http://127.0.0.1:3000/', data,
  }, env, provision);
  expect(second.childIdentity.nodeId).toBe(persisted);
  await cleanup();
});

test('a persisted public URL is the CSS authority on a warm start', async() => {
  const dir = await root();
  const data = path.join(dir, 'data');
  const setupPath = path.join(dir, 'registration.json');
  await mkdir(data, { recursive: true });
  await writeFile(setupPath, JSON.stringify({ local: {
    nodeId: 'warm-node', nodeToken: 'warm-token', serviceToken: 'warm-service',
    provisionCode: managedCode('warm-node'),
    publicUrl: 'https://warm-node.undefineds.co/', spDomain: 'warm-node.undefineds.co',
    cloudIdentityUrl: 'https://id.undefineds.co/', cloudApiUrl: 'https://api.undefineds.co/',
  } }));
  const env = { XPOD_LOCAL_SETUP_PATH: setupPath, SOLID_OIDC_ISSUER: 'https://id.undefineds.co/' };
  let provisioned = 0;
  const provision = (async(config: unknown) => { provisioned++; return config; }) as unknown as typeof import('../../../src/provision/first-run-registration').autoProvisionFirstRunLocal;

  const result = await bootstrapStartRuntime({
    ids: ['css', 'api'], mode: 'local', host: '127.0.0.1', port: 3000,
    configuredBaseUrl: 'http://127.0.0.1:3000/', data,
  }, env, provision);

  // A complete fresh registration still runs (the shared function decides), but
  // the canonical authority is the persisted public URL, never the loopback flag.
  expect(provisioned).toBe(1);
  expect(result.baseUrl).toBe('https://warm-node.undefineds.co/');
  expect(result.childIdentity).toMatchObject({
    nodeId: 'warm-node', publicUrl: 'https://warm-node.undefineds.co/', localSetupPath: setupPath,
  });
  await cleanup();
});

test('provider-scoped state is not silently reused across provider ids', async() => {
  const dir = await root();
  const data = path.join(dir, 'data');
  const setupPath = path.join(dir, 'registration.json');
  await mkdir(data, { recursive: true });
  await writeFile(setupPath, JSON.stringify({ alpha: { nodeId: 'alpha-node', publicUrl: 'https://alpha.example/' } }));
  const provision = (async(config: { publicUrl?: string }) => ({ ...config, publicUrl: undefined })) as unknown as typeof import('../../../src/provision/first-run-registration').autoProvisionFirstRunLocal;

  const alpha = await bootstrapStartRuntime({
    ids: ['css'], mode: 'local', host: '127.0.0.1', port: 3000, data,
  }, { XPOD_LOCAL_SETUP_PATH: setupPath, XPOD_PROVIDER_ID: 'alpha' }, provision);
  const beta = await bootstrapStartRuntime({
    ids: ['css'], mode: 'local', host: '127.0.0.1', port: 3000, data,
  }, { XPOD_LOCAL_SETUP_PATH: setupPath, XPOD_PROVIDER_ID: 'beta' }, provision);

  expect(alpha.baseUrl).toBe('https://alpha.example/');
  expect(beta.baseUrl).toBe('http://localhost:3000/');
  await cleanup();
});

test('standalone, cloud and API-only runtimes do not bootstrap a managed Local identity', async() => {
  const dir = await root();
  const data = path.join(dir, 'data');
  await mkdir(data, { recursive: true });
  const calls: string[] = [];
  const provision = (async(config: { edition: string; oidcIssuer?: string }) => {
    calls.push(`${config.edition}:${config.oidcIssuer ?? '-'}`);
    return config;
  }) as unknown as typeof import('../../../src/provision/first-run-registration').autoProvisionFirstRunLocal;

  // Standalone: no issuer configured anywhere, so no Cloud contact and no issuer.
  const standalone = await bootstrapStartRuntime({
    ids: ['css', 'api'], mode: 'local', host: '127.0.0.1', port: 3000, data,
  }, {}, provision);
  expect(standalone.baseUrl).toBe('http://localhost:3000/');
  expect(standalone.externalOidcIssuer).toBeUndefined();

  // Cloud edition keeps the explicit authority and never adopts a Local default.
  const cloud = await bootstrapStartRuntime({
    ids: ['css', 'api'], mode: 'cloud', host: '127.0.0.1', port: 3000,
    configuredBaseUrl: 'https://cloud.example/', data,
  }, { SOLID_OIDC_ISSUER: 'https://id.undefineds.co/' }, provision);
  expect(cloud.baseUrl).toBe('https://cloud.example/');

  // API-only keeps the explicit base URL and still requires an independent issuer.
  const apiOnly = await bootstrapStartRuntime({
    ids: ['api'], mode: 'local', host: '127.0.0.1', port: 3000,
    configuredBaseUrl: 'https://api.example/', data, oidcIssuer: 'https://identity.example/',
  }, {}, provision);
  expect(apiOnly.apiOnly).toBe(true);
  expect(apiOnly.baseUrl).toBe('https://api.example/');
  expect(apiOnly.externalOidcIssuer).toBe('https://identity.example/');
  await expect(bootstrapStartRuntime({
    ids: ['api'], mode: 'local', host: '127.0.0.1', port: 3000,
    configuredBaseUrl: 'https://api.example/', data,
  }, {}, provision)).rejects.toThrow('API-only runtime requires an independent OIDC issuer');

  // The bootstrap never invented a managed issuer for standalone/cloud/API-only.
  expect(calls.some(call => call.startsWith('local:https://id.undefineds.co/'))).toBe(false);
  await cleanup();
});

test('explicit loopback issuer still wins, while remembered loopback residue does not', async() => {
  const dir = await root();
  const data = path.join(dir, 'data');
  await mkdir(data, { recursive: true });
  const setupPath = path.join(dir, 'state.json');
  await writeFile(setupPath, JSON.stringify({ local: {
    nodeId: 'stale', cloudIdentityUrl: 'http://127.0.0.1:41300/',
  } }));
  const provision = (async(config: unknown) => config) as unknown as typeof import('../../../src/provision/first-run-registration').autoProvisionFirstRunLocal;

  const explicit = await bootstrapStartRuntime({
    ids: ['css'], mode: 'local', host: '127.0.0.1', port: 3000, data, oidcIssuer: 'http://127.0.0.1:41300/',
  }, {}, provision);
  expect(explicit.externalOidcIssuer).toBe('http://127.0.0.1:41300/');

  const residue = await bootstrapStartRuntime({
    ids: ['css'], mode: 'local', host: '127.0.0.1', port: 3000, data,
  }, { XPOD_LOCAL_SETUP_PATH: setupPath }, provision);
  // A remembered loopback issuer is never adopted; standalone keeps none.
  expect(residue.externalOidcIssuer).toBeUndefined();
  await cleanup();
});

test('device id is generated once under the resolved data root and reused', async() => {
  const dir = await root();
  const data = path.join(dir, 'data');
  const first = loadOrGenerateDeviceId(undefined, data);
  const second = loadOrGenerateDeviceId(undefined, data);
  expect(first).toBeTruthy();
  expect(second).toBe(first);
  expect((await readFile(path.join(data, '.device-id'), 'utf8')).trim()).toBe(first!);
  // An explicit node identity always wins over the persisted file.
  expect(loadOrGenerateDeviceId('pinned-node', data)).toBe('pinned-node');
  await cleanup();
});
