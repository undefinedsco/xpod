import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, access } from 'node:fs/promises';
import path from 'node:path';
import { expect, it } from 'vitest';
import { Client } from 'pg';
import { Client as ObjectStoreClient } from 'minio';
import { XpodTestStack } from '../helpers/XpodTestStack';
import { getFreePortForWildcard } from '../../src/runtime/port-finder';
import { hasObjectStore, objectStoreContainerArgs, OBJECT_STORE_PORT } from '../helpers/dockerObjectStore';
import {
  provisionOwnedExternalResources,
  withTestInfra,
  type CleanupFailure,
  type ObjectStoreClientConfig,
} from '../helpers/externalInfraFixture';
import { fullIntegrationInfraEnv } from '../../scripts/helpers/full-integration-infra';
import { setupAccount, loginWithClientCredentials } from './helpers/solidAccount';
import { deriveProvisionReceiptSecret, verifyProvisionReceipt } from '../../src/provision/ProvisionReceiptCodec';
import { createServiceAccessToken } from '../../src/provision/ServiceAccessTokenCodec';
import { getSqliteRuntime } from '../../src/storage/SqliteRuntime';

/** Bound every synchronous Docker call so a stuck daemon cannot hang the runner. */
const DOCKER_TIMEOUT_MS = 30_000;
const DOCKER_READY_TIMEOUT_MS = 10_000;

interface FixtureInfra {
  external: boolean;
  postgresUrl: string;
  redis: { url: string; username: string; password: string };
  objectStore: ObjectStoreClientConfig;
  bucket: string;
  cleanup(): Promise<CleanupFailure[]>;
}

function docker(args: string[], timeout = DOCKER_TIMEOUT_MS): string {
  const result = spawnSync('docker', args, { encoding: 'utf8', timeout, killSignal: 'SIGKILL' });
  if (result.error) throw new Error(`Pod deletion fixture Docker ${args[0]} failed: ${result.error.message}`);
  if (result.status !== 0) throw new Error(`Pod deletion fixture Docker ${args[0]} failed: ${result.stderr ?? ''}`);
  return result.stdout.trim();
}

async function startDockerInfra(): Promise<FixtureInfra> {
  const containers: string[] = [];
  const start = (name: string, args: string[]) => {
    const id = `pod-delete-${name}-${process.pid}`;
    docker(['run', '--rm', '-d', '--name', id, ...args]);
    containers.push(id);
    return id;
  };
  const ready = async (check: () => Promise<boolean>) => {
    for (let attempt = 0; attempt < 100; attempt++) {
      if (await check().catch(() => false)) { return; }
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    throw new Error('Pod deletion fixture dependency not ready');
  };
  const pgPort = await getFreePortForWildcard(28001);
  const s3Port = await getFreePortForWildcard(pgPort + 1);
  const redisPort = await getFreePortForWildcard(s3Port + 1);
  const pgName = start('pg', ['-p', `127.0.0.1:${pgPort}:5432`, '-e', 'POSTGRES_USER=xpod', '-e', 'POSTGRES_PASSWORD=xpod', '-e', 'POSTGRES_DB=pod_delete', 'postgres:16-alpine']);
  start('s3', ['-p', `127.0.0.1:${s3Port}:${OBJECT_STORE_PORT}`, ...objectStoreContainerArgs('pod-delete')]);
  const redisName = start('redis', ['-p', `127.0.0.1:${redisPort}:6379`, 'redis:7-alpine', 'redis-server', '--save', '', '--appendonly', 'no']);
  // The image's initialization server accepts Unix sockets before the final TCP server starts.
  await ready(async () => spawnSync('docker', ['exec', pgName, 'pg_isready', '-h', '127.0.0.1', '-p', '5432', '-U', 'xpod', '-d', 'pod_delete'], { encoding: 'utf8', timeout: DOCKER_READY_TIMEOUT_MS, killSignal: 'SIGKILL' }).status === 0);
  await ready(async () => hasObjectStore(s3Port, 'pod-delete'));
  await ready(async () => spawnSync('docker', ['exec', redisName, 'redis-cli', 'ping'], { encoding: 'utf8', timeout: DOCKER_READY_TIMEOUT_MS, killSignal: 'SIGKILL' }).status === 0);
  return {
    external: false,
    postgresUrl: `postgres://xpod:xpod@localhost:${pgPort}/pod_delete`,
    redis: { url: `127.0.0.1:${redisPort}`, username: '', password: '' },
    objectStore: { endPoint: 'localhost', port: s3Port, useSSL: false, accessKey: 'minioadmin', secretKey: 'minioadmin' },
    bucket: 'pod-delete',
    cleanup: async () => {
      if (containers.length) spawnSync('docker', ['stop', ...containers], { stdio: 'ignore', timeout: DOCKER_TIMEOUT_MS, killSignal: 'SIGKILL' });
      return [];
    },
  };
}

it.runIf(process.env.XPOD_RUN_INTEGRATION_TESTS === 'true')('deletes Cloud and managed Local Pods through actual grant callbacks and protects a recreated Local generation', async () => {
  const cloud = new XpodTestStack();
  const local = new XpodTestStack();
  await mkdir(path.resolve('.test-data'), { recursive: true });
  const root = await mkdtemp(path.resolve('.test-data/cloud-managed-pod-deletion-'));
  let infra: FixtureInfra | undefined;
  let pg: Client | undefined;
  let bodyError: unknown;
  const cleanupFailures: CleanupFailure[] = [];
  const jsonHeaders = { accept: 'application/json', 'content-type': 'application/json' };
  try {
    const selected = await withTestInfra<FixtureInfra>({
      env: process.env,
      startDocker: startDockerInfra,
      provisionExternal: async (config) => {
        const owned = await provisionOwnedExternalResources(config);
        const env = fullIntegrationInfraEnv(config);
        return {
          external: true,
          postgresUrl: owned.postgresUrl,
          redis: { url: env.CSS_REDIS_CLIENT, username: config.CSS_REDIS_USERNAME, password: config.CSS_REDIS_PASSWORD },
          objectStore: owned.objectStore,
          bucket: owned.bucket,
          cleanup: owned.cleanup,
        };
      },
    });
    infra = selected;
    const session = selected;
    pg = new Client({ connectionString: session.postgresUrl }); await pg.connect();
    const cloudPort = await getFreePortForWildcard(38501);
    await cloud.start('cloud', {
      transport: 'port', baseUrl: `http://localhost:${cloudPort}/`, gatewayPort: cloudPort,
      open: false, apiOpen: false,
      runtimeRoot: path.join(root, 'cloud'), identityDbUrl: session.postgresUrl, sparqlEndpoint: session.postgresUrl, logLevel: 'warn',
      env: {
        XPOD_NODE_ID: `pod-delete-cloud-${process.pid}`, XPOD_LOCAL_SETUP_PATH: path.join(root, 'cloud-state.json'),
        XPOD_GATEWAY_LOCATOR_SECRET: 'disposable-pod-delete-fixture',
        CSS_REDIS_CLIENT: session.redis.url, CSS_REDIS_USERNAME: session.redis.username, CSS_REDIS_PASSWORD: session.redis.password,
        CSS_MINIO_ENDPOINT: `${session.objectStore.useSSL ? 'https' : 'http'}://${session.objectStore.endPoint}:${session.objectStore.port}`,
        CSS_MINIO_ACCESS_KEY: session.objectStore.accessKey, CSS_MINIO_SECRET_KEY: session.objectStore.secretKey, CSS_MINIO_BUCKET_NAME: session.bucket,
        CSS_EMAIL_CONFIG_HOST: '', CSS_EMAIL_CONFIG_PORT: '587', CSS_EMAIL_CONFIG_AUTH_USER: '', CSS_EMAIL_CONFIG_AUTH_PASS: '',
        CSS_ALLOWED_HOSTS: 'localhost,127.0.0.1', XPOD_EDGE_NODES_ENABLED: 'false',
      },
    });
    const localPort = await getFreePortForWildcard(38601);
    const localStatePath = path.join(root, 'local-state.json');
    await local.start('local', {
      transport: 'port', baseUrl: `http://localhost:${localPort}/`, gatewayPort: localPort,
      open: false, apiOpen: false,
      runtimeRoot: path.join(root, 'local'), logLevel: 'warn',
      env: {
        XPOD_NODE_ID: `pod-delete-local-${process.pid}`, SOLID_OIDC_ISSUER: cloud.baseUrl,
        XPOD_PUBLIC_URL: `http://localhost:${localPort}/`, XPOD_LOCAL_SETUP_PATH: localStatePath,
        ...(process.env.XPOD_QLEVER_LOCAL_RUNTIME_COMMAND ? { XPOD_QLEVER_LOCAL_RUNTIME_COMMAND: process.env.XPOD_QLEVER_LOCAL_RUNTIME_COMMAND } : {}),
      },
    });
    const status = await fetch(new URL('provision/status', local.baseUrl)).then((r) => r.json()) as { provisionCode: string; managed: boolean };
    expect(status.managed).toBe(true);
    const localStates = JSON.parse(await readFile(localStatePath, 'utf8')) as Record<string, { serviceToken: string }>;
    const serviceToken = Object.values(localStates).find((state) => state.serviceToken)?.serviceToken;
    expect(serviceToken).toBeTruthy();
    const account = await setupAccount(cloud.baseUrl, 'delete-cloud');
    expect(account).toBeTruthy();
    const login = await fetch(new URL('.account/login/password/', cloud.baseUrl), { method: 'POST', headers: jsonHeaders, body: JSON.stringify({ email: account!.email, password: account!.password }) });
    expect(login.ok).toBe(true);
    const accountHeaders = { accept: 'application/json', cookie: login.headers.getSetCookie().map((cookie) => cookie.split(';', 1)[0]).join('; ') };
    const index = await fetch(new URL('.account/', cloud.baseUrl), { headers: accountHeaders }).then((r) => r.json()) as { controls: { account: { pod: string; profile: string; clientCredentials: string } } };
    const inventory = () => fetch(index.controls.account.pod, { headers: accountHeaders }).then((r) => r.json()) as Promise<{ pods: Record<string, string>; podDeletionControls: Record<string, string>; podDeletionAuthorizationControls: Record<string, string> }>;
    const localFacts = (storageUrl: string) => {
      const db = getSqliteRuntime().openDatabase(path.join(root, 'local/rdf-index.sqlite'), { readonly: true });
      const mirror = getSqliteRuntime().openDatabase(path.join(root, 'local/quadstore.sqlite'), { readonly: true });
      try { return {
        sources: db.prepare<{ count: number }>('SELECT count(*) AS count FROM rdf_sources WHERE source LIKE ?').get(`${storageUrl}%`)!.count,
        quads: db.prepare<{ count: number }>('SELECT count(*) AS count FROM rdf_quads q JOIN rdf_terms t ON t.id=q.graph_id WHERE t.value LIKE ?').get(`${storageUrl}%`)!.count,
        mirror: mirror.prepare<{ count: number }>('SELECT count(*) AS count FROM quints WHERE graph LIKE ?').get(`${storageUrl}%`)!.count,
      }; } finally { db.close(); mirror.close(); }
    };
    expect(index.controls.account.profile).toBeTruthy();
    const prepare = async (podName = 'managed-delete') => {
      const profileResponse = await fetch(index.controls.account.profile, {
        method: 'POST', headers: { ...accountHeaders, 'content-type': 'application/json' },
        body: JSON.stringify({ podName }),
      });
      const profile = await profileResponse.json() as { webId: string };
      expect(profileResponse.ok, JSON.stringify(profile)).toBe(true);
      expect(new URL(profile.webId).origin).toBe(new URL(cloud.baseUrl).origin);
      expect(new URL(profile.webId).origin).not.toBe(new URL(local.baseUrl).origin);
      const response = await fetch(new URL('provision/pods', local.baseUrl), { method: 'POST', headers: { ...jsonHeaders, authorization: `Bearer ${serviceToken}` }, body: JSON.stringify({ podName, webId: profile.webId }) });
      const body = await response.json() as { podUrl: string; webId: string; provisionReceipt: string };
      expect(response.ok, JSON.stringify(body)).toBe(true);
      expect(body.webId).toBe(profile.webId);
      return body;
    };
    const prepared = await prepare();
    const linked = await fetch(index.controls.account.pod, { method: 'POST', headers: { ...accountHeaders, 'content-type': 'application/json' }, body: JSON.stringify({ name: 'managed-delete', settings: { provisionCode: status.provisionCode, provisionReceipt: prepared.provisionReceipt, webId: prepared.webId } }) });
    expect(await linked.text()).toContain('podResource'); expect(linked.ok).toBe(true);
    // Represent a pre-upgrade binding: the Cloud Pod exists but has no trusted Local generation.
    const fresh = await inventory();
    expect(fresh.podDeletionControls[prepared.podUrl]).toBeTruthy();
    await pg.query('DELETE FROM pod_remote_generation WHERE storage_url=$1', [prepared.podUrl]);
    const legacy = await inventory();
    expect(legacy.podDeletionControls[prepared.podUrl]).toBeUndefined();
    const authorizationControl = legacy.podDeletionAuthorizationControls[prepared.podUrl];
    expect(authorizationControl).toBeTruthy();
    const begin = await fetch(authorizationControl, { method: 'POST', headers: { ...accountHeaders, 'content-type': 'application/json' }, body: JSON.stringify({ action: 'requestDeletionAuthorization' }) });
    const started = await begin.json() as { deletionAuthorization: { challenge: string; podName: string; localManagementUrl: string } };
    expect(begin.ok, JSON.stringify(started)).toBe(true);
    const task = started.deletionAuthorization;
    expect(new URL(task.localManagementUrl).origin).toBe(new URL(local.baseUrl).origin);
    const operator = (action: string, extra: object = {}, headers: Record<string, string> = {}) => fetch(new URL('provision/pods', local.baseUrl), {
      method: 'POST', headers: { ...jsonHeaders, origin: new URL(local.baseUrl).origin, ...headers },
      body: JSON.stringify({ action, challenge: task.challenge, podName: task.podName, ...extra }),
    });
    const sat = createServiceAccessToken({ serviceToken: serviceToken!, scopes: ['network:read', 'network:connect'], ttlSeconds: 300 });
    const existingPreparation = await fetch(new URL('provision/pods', local.baseUrl), { method: 'POST', headers: { ...jsonHeaders, authorization: `Bearer ${sat}` }, body: JSON.stringify({ podName: task.podName, webId: prepared.webId }) });
    expect(existingPreparation.ok).toBe(true);
    const existingReceipt = verifyProvisionReceipt((await existingPreparation.json() as { provisionReceipt: string }).provisionReceipt, { secret: deriveProvisionReceiptSecret(serviceToken!) });
    expect(existingReceipt.valid).toBe(true);
    expect(existingReceipt.valid && existingReceipt.payload.podId).toBeUndefined();
    expect((await operator('inspectDeletionAuthorization', {}, { authorization: `Bearer ${sat}` })).status).toBe(403);
    expect((await operator('inspectDeletionAuthorization', {}, { origin: 'https://attacker.test' })).status).toBe(403);
    const inspected = await operator('inspectDeletionAuthorization');
    const inspectedBody = await inspected.json() as { deletionAuthorization: { currentLocalPodId: string; cloudAccountId: string; storageUrl: string } };
    expect(inspected.ok, JSON.stringify(inspectedBody)).toBe(true);
    expect(inspectedBody.deletionAuthorization.storageUrl).toBe(prepared.podUrl);
    expect((await inventory()).podDeletionControls[prepared.podUrl]).toBeUndefined();
    expect((await operator('authorizeDeletion', { expectedLocalPodId: 'stale-generation' })).status).toBe(409);
    const authorizations = await Promise.all([1, 2].map(() => operator('authorizeDeletion', { expectedLocalPodId: inspectedBody.deletionAuthorization.currentLocalPodId })));
    expect(authorizations.map((response) => response.status).sort()).toEqual([200, 409]);
    const authorized = authorizations.find((response) => response.ok)!;
    expect(await authorized.text()).toContain('success');
    expect((await pg.query('SELECT count(*)::int AS count FROM pod_remote_generation WHERE storage_url=$1', [prepared.podUrl])).rows[0].count).toBe(1);
    expect((await operator('authorizeDeletion', { expectedLocalPodId: inspectedBody.deletionAuthorization.currentLocalPodId })).status).toBe(409);
    const before = await inventory();
    expect(before.podDeletionControls[prepared.podUrl]).toBeTruthy();
    const credentials = await fetch(index.controls.account.clientCredentials, { method: 'POST', headers: { ...accountHeaders, 'content-type': 'application/json' }, body: JSON.stringify({ name: 'managed-delete-test', webId: prepared.webId }) });
    const credential = await credentials.json() as { id: string; secret: string };
    expect(credentials.ok).toBe(true);
    const localSession = await loginWithClientCredentials({ ...account!, podUrl: prepared.podUrl, webId: prepared.webId, clientId: credential.id, clientSecret: credential.secret });
    const nested = new URL('nested/', prepared.podUrl).href;
    expect((await localSession.fetch(nested, { method: 'PUT', headers: { 'content-type': 'text/turtle' }, body: '' })).ok).toBe(true);
    expect((await localSession.fetch(new URL('nested/binary', prepared.podUrl), { method: 'PUT', headers: { 'content-type': 'application/octet-stream' }, body: new Uint8Array([1, 2, 3]) })).ok).toBe(true);
    expect((await localSession.fetch(new URL('nested/data.ttl', prepared.podUrl), { method: 'PUT', headers: { 'content-type': 'text/turtle' }, body: '<#x> <https://example.test/p> "managed".' })).ok).toBe(true);
    const kept = await prepare('managed-keep');
    const keptCredentials = await fetch(index.controls.account.clientCredentials, {
      method: 'POST', headers: { ...accountHeaders, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'managed-keep-test', webId: kept.webId }),
    });
    expect(keptCredentials.ok).toBe(true);
    const keptCredential = await keptCredentials.json() as { id: string; secret: string };
    const keptSession = await loginWithClientCredentials({
      ...account!, podUrl: kept.podUrl, webId: kept.webId,
      clientId: keptCredential.id, clientSecret: keptCredential.secret,
    });
    const keptResource = new URL('private-preserved.ttl', kept.podUrl);
    const keptBody = '<#kept> <https://example.test/p> "private Local data survives another Pod deletion".';
    expect((await keptSession.fetch(keptResource, { method: 'PUT', headers: { 'content-type': 'text/turtle' }, body: keptBody })).ok).toBe(true);
    const keptRead = await keptSession.fetch(keptResource);
    expect(keptRead.ok).toBe(true);
    const keptRepresentation = await keptRead.text();
    expect(keptRepresentation).toContain('private Local data survives another Pod deletion');
    expect([401, 403]).toContain((await fetch(keptResource)).status);
    const keptBefore = localFacts(kept.podUrl);
    expect(keptBefore.sources).toBeGreaterThan(0);
    expect(keptBefore.quads).toBeGreaterThan(0);
    expect(keptBefore.mirror).toBeGreaterThan(0);
    const unauthenticatedDelete = await fetch(new URL('provision/pods/managed-delete', local.baseUrl), { method: 'DELETE' });
    expect(unauthenticatedDelete.status, await unauthenticatedDelete.text()).toBe(401);
    const wrongServiceToken = await fetch(new URL('provision/pods/managed-delete', local.baseUrl), { method: 'DELETE', headers: { authorization: 'Bearer wrong-disposable-fixture-token' } });
    expect(wrongServiceToken.status, await wrongServiceToken.text()).toBe(401);
    const targetBefore = localFacts(prepared.podUrl);
    expect(targetBefore.sources).toBeGreaterThan(0);
    expect(targetBefore.quads).toBeGreaterThan(0);
    expect(targetBefore.mirror).toBeGreaterThan(0);
    const beforeOperations = await pg.query('SELECT count(*)::int AS count FROM pod_deletion_operation');
    const deletion = await fetch(before.podDeletionControls[prepared.podUrl], { method: 'DELETE', headers: accountHeaders });
    expect(await deletion.text()).toContain('success'); expect(deletion.ok).toBe(true);
    expect((await inventory()).pods).not.toHaveProperty(prepared.podUrl);
    await expect(access(path.join(root, 'local/data/managed-delete'))).rejects.toThrow();
    const residualDb = getSqliteRuntime().openDatabase(path.join(root, 'local/rdf-index.sqlite'), { readonly: true });
    const residual = residualDb.prepare('SELECT g.value AS graph, s.value AS subject, p.value AS predicate, o.value AS object FROM rdf_quads q JOIN rdf_terms g ON g.id=q.graph_id JOIN rdf_terms s ON s.id=q.subject_id JOIN rdf_terms p ON p.id=q.predicate_id JOIN rdf_terms o ON o.id=q.object_id WHERE g.value LIKE ?').all(`${prepared.podUrl}%`);
    residualDb.close();
    const targetAfter = localFacts(prepared.podUrl);
    expect(targetAfter, JSON.stringify(residual)).toEqual({ sources: 0, quads: 0, mirror: 0 });
    expect(localFacts(kept.podUrl)).toEqual(keptBefore);
    const keptAfter = await keptSession.fetch(keptResource);
    expect(keptAfter.ok).toBe(true);
    expect(await keptAfter.text()).toBe(keptRepresentation);
    expect([401, 403]).toContain((await fetch(keptResource)).status);
    // Deletion also removes the ACL: authorization can deny before storage
    // reports absence. The inventory, filesystem and three data counts above
    // independently prove removal; an authentication failure is not sufficient.
    expect([403, 404]).toContain((await localSession.fetch(new URL('nested/data.ttl', prepared.podUrl))).status);
    const done = await pg.query('SELECT payload FROM pod_deletion_operation');
    expect(done.rows.length).toBe(beforeOperations.rows[0].count + 1);
    expect(JSON.parse(done.rows[0].payload).state).toBe('completed');
    const recreated = await prepare();
    expect(recreated.podUrl).toBe(prepared.podUrl);
    expect(recreated.webId).toBe(prepared.webId);
    const oldCommandReplay = await fetch(before.podDeletionControls[prepared.podUrl], { method: 'DELETE', headers: accountHeaders });
    expect(oldCommandReplay.ok).toBe(true);
    await access(path.join(root, 'local/data/managed-delete'));
    // The remaining Cloud Pod uses the same lifecycle with its actual PostgreSQL/S3 accessors.
    const cloudSession = await loginWithClientCredentials(account!);
    const objects = new ObjectStoreClient(session.objectStore);
    const countObjects = async (): Promise<number> => {
      let count = 0;
      for await (const _object of objects.listObjectsV2(session.bucket, new URL(account!.podUrl).pathname.slice(1), true)) { count++; }
      return count;
    };
    expect((await cloudSession.fetch(new URL('cloud.bin', account!.podUrl), { method: 'PUT', headers: { 'content-type': 'application/octet-stream' }, body: new Uint8Array([5, 6, 7]) })).ok).toBe(true);
    expect(await countObjects()).toBeGreaterThan(0);
    expect((await cloudSession.fetch(new URL('cloud-data.ttl', account!.podUrl), { method: 'PUT', headers: { 'content-type': 'text/turtle' }, body: '<#x> <https://example.test/p> "cloud".' })).ok).toBe(true);
    const cloudFacts = async () => {
      const sources = await pg!.query('SELECT count(*)::int AS count FROM rdf_sources WHERE source LIKE $1', [`${account!.podUrl}%`]);
      const quads = await pg!.query('SELECT count(*)::int AS count FROM rdf_quads q JOIN rdf_terms t ON t.id=q.graph_id WHERE t.value LIKE $1', [`${account!.podUrl}%`]);
      return { sources: sources.rows[0].count, quads: quads.rows[0].count };
    };
    const cloudBefore = await cloudFacts();
    expect(cloudBefore.sources).toBeGreaterThan(0); expect(cloudBefore.quads).toBeGreaterThan(0);
    const cloudDelete = await fetch((await inventory()).podDeletionControls[account!.podUrl], { method: 'DELETE', headers: accountHeaders });
    expect(await cloudDelete.text()).toContain('success'); expect(cloudDelete.ok).toBe(true);
    // Cloud uses the native PostgreSQL RDF authority, not Local provisioning's legacy mirror.
    const mirrorTable = await pg.query("SELECT to_regclass('public.quints') AS name");
    expect(mirrorTable.rows[0].name).toBeNull();
    const remainingObjects: string[] = [];
    for await (const object of objects.listObjectsV2(session.bucket, new URL(account!.podUrl).pathname.slice(1), true)) { remainingObjects.push(object.name ?? ''); }
    expect(remainingObjects).toEqual([]);
    expect(await cloudFacts()).toEqual({ sources: 0, quads: 0 });
    const relogin = await fetch(new URL('.account/login/password/', cloud.baseUrl), { method: 'POST', headers: jsonHeaders, body: JSON.stringify({ email: account!.email, password: account!.password }) });
    expect(relogin.ok).toBe(true);
    console.info('Pod deletion storage evidence', JSON.stringify({
      localBefore: targetBefore, localAfter: targetAfter,
      preservedLocal: keptBefore, cloudBefore, cloudAfter: await cloudFacts(),
      cloudObjectsAfter: await countObjects(),
      localNativeCommand: process.env.XPOD_QLEVER_LOCAL_RUNTIME_COMMAND ?? 'fixture-default',
    }));
  } catch (error) {
    bodyError = error;
  } finally {
    // Run every cleanup step and record failures; never throw from `finally`,
    // so the original body failure is preserved and all cleanup errors are kept.
    const record = async (step: string, action: () => Promise<unknown>) => {
      try { await action(); } catch (error) { cleanupFailures.push({ step, error }); }
    };
    // The test-owned Local/Cloud runtimes and the direct PG client must stop
    // before the owned database can be dropped.
    await record('stop-local', () => local.stop());
    await record('stop-cloud', () => cloud.stop());
    await record('close-pg', () => pg?.end() ?? Promise.resolve());
    if (infra) await record('infra-cleanup', async () => { cleanupFailures.push(...await infra!.cleanup()); });
    await record('remove-root', () => rm(root, { recursive: true, force: true }));
  }
  if (bodyError) {
    if (cleanupFailures.length) {
      console.error('[cloud-managed-pod-deletion] cleanup failed after body error', JSON.stringify(cleanupFailures.map(({ step, error }) => ({ step, message: error instanceof Error ? error.message : String(error) }))));
    }
    throw bodyError;
  }
  if (cleanupFailures.length) {
    throw new Error(`Pod deletion fixture cleanup failed: ${cleanupFailures.map(({ step }) => step).join(', ')}`);
  }
}, 300_000);
