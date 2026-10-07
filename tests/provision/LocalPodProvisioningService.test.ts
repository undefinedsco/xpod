import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { LocalPodProvisioningService } from '../../src/provision/LocalPodProvisioningService';
import { getSqliteRuntime } from '../../src/storage/SqliteRuntime';
import { rowToQuad } from '../../src/storage/quint/serialization';
import { PodDeletionOperationRepository } from '../../src/identity/drizzle/PodDeletionOperationRepository';
import { createTestDir } from '../utils/sqlite';

describe('LocalPodProvisioningService', () => {
  const createdDirs: string[] = [];
  const sqliteRuntime = getSqliteRuntime();

  afterEach(() => {
    for (const dir of createdDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('preserves Standalone profiles, metadata and identity indexes for its own issuer', async () => {
    const rootDir = createTestDir('local-pod-provisioning');
    createdDirs.push(rootDir);
    const sparqlPath = path.join(rootDir, 'quadstore.sqlite');
    const identityPath = path.join(rootDir, 'identity.sqlite');
    const service = new LocalPodProvisioningService({
      baseUrl: 'https://node-0000.undefineds.co/',
      rootDir: path.join(rootDir, 'data'),
      sparqlEndpoint: `sqlite:${sparqlPath}`,
      identityDbUrl: `sqlite:${identityPath}`,
      oidcIssuer: 'https://node-0000.undefineds.co/',
    });

    const result = await service.createPod({
      podName: 'alice',
      webId: 'https://node-0000.undefineds.co/alice/profile/card#me',
    });

    expect(result.podUrl).toBe('https://node-0000.undefineds.co/alice/');
    expect(result.webId).toBe('https://node-0000.undefineds.co/alice/profile/card#me');
    expect(fs.existsSync(path.join(rootDir, 'data', 'alice', 'profile'))).toBe(true);

    const quadsDb = sqliteRuntime.openDatabase(sparqlPath, { readonly: true });
    try {
      const rows = quadsDb.prepare<{
        graph: string;
        subject: string;
        predicate: string;
        object: string;
      }>('SELECT graph, subject, predicate, object FROM quints').all();
      const quads = rows.map(rowToQuad);
      const hasQuad = (subject: string, predicate: string, object: string): boolean =>
        quads.some((quad) =>
          quad.subject.value === subject &&
          quad.predicate.value === predicate &&
          quad.object.value === object);

      expect(hasQuad(
        'https://node-0000.undefineds.co/',
        'http://www.w3.org/ns/ldp#contains',
        'https://node-0000.undefineds.co/alice/',
      )).toBe(true);
      expect(hasQuad(
        'https://node-0000.undefineds.co/alice/',
        'http://www.w3.org/ns/ldp#contains',
        'https://node-0000.undefineds.co/alice/profile/',
      )).toBe(true);
      expect(hasQuad(
        'https://node-0000.undefineds.co/alice/profile/',
        'http://www.w3.org/ns/ldp#contains',
        'https://node-0000.undefineds.co/alice/profile/.acr',
      )).toBe(true);
      expect(hasQuad(
        'https://node-0000.undefineds.co/alice/profile/card',
        'http://xmlns.com/foaf/0.1/primaryTopic',
        'https://node-0000.undefineds.co/alice/profile/card#me',
      )).toBe(true);
      expect(hasQuad(
        'https://node-0000.undefineds.co/alice/profile/card#me',
        'http://www.w3.org/ns/solid/terms#oidcIssuer',
        'https://node-0000.undefineds.co/',
      )).toBe(true);
      expect(hasQuad(
        'https://node-0000.undefineds.co/alice/profile/card#me',
        'http://www.w3.org/ns/solid/terms#storage',
        'https://node-0000.undefineds.co/alice/',
      )).toBe(true);
      expect(hasQuad(
        'https://node-0000.undefineds.co/alice/.acr#root',
        'http://www.w3.org/ns/solid/acp#resource',
        'https://node-0000.undefineds.co/alice/',
      )).toBe(true);
      expect(hasQuad(
        'https://node-0000.undefineds.co/alice/profile/.acr#profile',
        'http://www.w3.org/ns/solid/acp#resource',
        'https://node-0000.undefineds.co/alice/profile/',
      )).toBe(true);
      expect(hasQuad(
        'https://node-0000.undefineds.co/alice/profile/.acr#profile',
        'http://www.w3.org/ns/solid/acp#accessControl',
        'https://node-0000.undefineds.co/alice/profile/.acr#publicReadAccess',
      )).toBe(true);
    } finally {
      quadsDb.close();
    }

    const identityDb = sqliteRuntime.openDatabase(identityPath, { readonly: true });
    try {
      const rows = identityDb.prepare<{ key: string; value: string }>(
        'SELECT key, value FROM internal_kv ORDER BY key',
      ).all();
      const keys = rows.map((row) => row.key);

      expect(keys).toContain(`accounts/index/pod/baseUrl/${encodeURIComponent('https://node-0000.undefineds.co/alice/')}`);
      expect(keys).toContain(`accounts/index/webIdLink/webId/${encodeURIComponent('https://node-0000.undefineds.co/alice/profile/card#me')}`);
      expect(keys.some((key) => key.startsWith('accounts/data/'))).toBe(true);
      expect(keys.some((key) => key.startsWith('accounts/index/owner/'))).toBe(true);
    } finally {
      identityDb.close();
    }
  });

  it.each(['acp', 'acl'] as const)('uses the exact Cloud WebID as %s owner without creating a Local profile', async (authMode) => {
    const rootDir = createTestDir(`local-pod-cloud-owner-${authMode}`);
    createdDirs.push(rootDir);
    const sparqlPath = path.join(rootDir, 'quadstore.sqlite');
    const identityPath = path.join(rootDir, 'identity.sqlite');
    const service = new LocalPodProvisioningService({
      baseUrl: 'https://node-0000.undefineds.co/',
      rootDir: path.join(rootDir, 'data'),
      sparqlEndpoint: `sqlite:${sparqlPath}`,
      identityDbUrl: `sqlite:${identityPath}`,
      oidcIssuer: 'https://id.undefineds.co/identity/',
      authMode,
    });
    // Validation may parse this URL, but must not normalize the signed identity string.
    const webId = 'https://ID.undefineds.co:443/identity/alice/profile/card?view=public#Me';
    const result = await service.createPod({
      podName: 'alice', webId, initialResources: { 'notes/readme.txt': 'Local Pod data' },
    });

    expect(result.podUrl).toBe('https://node-0000.undefineds.co/alice/');
    expect(result.webId).toBe(webId);
    expect(fs.existsSync(path.join(rootDir, 'data', 'alice', 'profile'))).toBe(false);
    expect(fs.readFileSync(path.join(rootDir, 'data', 'alice', 'notes', 'readme.txt'), 'utf8')).toBe('Local Pod data');

    const quadsDb = sqliteRuntime.openDatabase(sparqlPath, { readonly: true });
    try {
      const rows = quadsDb.prepare<{
        graph: string; subject: string; predicate: string; object: string;
      }>('SELECT graph, subject, predicate, object FROM quints').all();
      const quads = rows.map(rowToQuad);
      const ownerPredicate = authMode === 'acl'
        ? 'http://www.w3.org/ns/auth/acl#agent'
        : 'http://www.w3.org/ns/solid/acp#agent';
      const rootAuthorizationUrl = `${result.podUrl}.${authMode === 'acl' ? 'acl' : 'acr'}`;
      expect(quads.filter((entry) => entry.predicate.value === ownerPredicate &&
        entry.object.value !== 'http://www.w3.org/ns/solid/acp#PublicAgent')
        .map((entry) => entry.object.value)).toEqual([webId]);
      expect(quads.some((entry) => entry.graph.value === rootAuthorizationUrl)).toBe(true);
      expect(quads.some((entry) => authMode === 'acl'
        ? entry.subject.value === `${rootAuthorizationUrl}#owner` &&
          entry.predicate.value === 'http://www.w3.org/ns/auth/acl#default' && entry.object.value === result.podUrl
        : entry.subject.value === `${rootAuthorizationUrl}#root` &&
          entry.predicate.value === 'http://www.w3.org/ns/solid/acp#memberAccessControl' &&
          entry.object.value === `${rootAuthorizationUrl}#fullOwnerAccess`)).toBe(true);
      expect(quads.some((entry) => entry.graph.value === `${result.podUrl}.settings/privateTypeIndex.ttl`)).toBe(true);
      expect(quads.some((entry) => [entry.graph.value, entry.subject.value, entry.object.value]
        .some((value) => value.includes(`${result.podUrl}profile/`)))).toBe(false);
      expect(quads.some((entry) => entry.predicate.value.startsWith('http://xmlns.com/foaf/0.1/'))).toBe(false);
      expect(quads.some((entry) => entry.subject.value === webId)).toBe(false);
    } finally {
      quadsDb.close();
    }

    const identityDb = sqliteRuntime.openDatabase(identityPath, { readonly: true });
    try {
      const accountRow = identityDb.prepare<{ value: string }>('SELECT value FROM internal_kv WHERE key = ?')
        .get(`accounts/data/${result.accountId}`);
      expect(accountRow).toBeTruthy();
      const account = JSON.parse(accountRow!.value);
      expect(account['**pod**'][result.podId].baseUrl).toBe(result.podUrl);
      expect(Object.values(account['**pod**'][result.podId]['**owner**'])).toEqual([
        expect.objectContaining({ podId: result.podId, webId }),
      ]);
      expect(Object.values(account['**webIdLink**'])).toEqual([
        expect.objectContaining({ accountId: result.accountId, webId }),
      ]);
      expect(identityDb.prepare<{ value: string }>('SELECT value FROM internal_kv WHERE key = ?')
        .get(`accounts/index/webIdLink/webId/${encodeURIComponent(webId)}`)).toBeTruthy();
      expect(identityDb.prepare<{ value: string }>('SELECT value FROM internal_kv WHERE key = ?')
        .get(`accounts/index/webIdLink/webId/${encodeURIComponent(`${result.podUrl}profile/card#me`)}`)).toBeUndefined();
    } finally {
      identityDb.close();
    }

    await expect(service.createPod({ podName: 'alice', webId })).rejects.toThrow('already exists');
    await expect(service.createPod({ podName: 'alice', webId: 'https://id.undefineds.co/identity/bob/profile/card#me' }))
      .rejects.toThrow('already exists');
    const unchangedDb = sqliteRuntime.openDatabase(identityPath, { readonly: true });
    try {
      expect(JSON.parse(unchangedDb.prepare<{ value: string }>('SELECT value FROM internal_kv WHERE key = ?')
        .get(`accounts/index/pod/baseUrl/${encodeURIComponent(result.podUrl)}`)!.value)).toEqual([result.accountId]);
      expect(unchangedDb.prepare<{ value: string }>('SELECT value FROM internal_kv WHERE key = ?')
        .get(`accounts/index/webIdLink/webId/${encodeURIComponent('https://id.undefineds.co/identity/bob/profile/card#me')}`)).toBeUndefined();
    } finally {
      unchangedDb.close();
    }
  });

  it.each([
    undefined,
    '',
    'https://node-0000.undefineds.co/alice/profile/card#me',
    'https://other.undefineds.co/identity/alice/profile/card#me',
    'http://id.undefineds.co/identity/alice/profile/card#me',
    'https://id.undefineds.co/identity-sibling/alice/profile/card#me',
    'https://id.undefineds.co/identity/../alice/profile/card#me',
    'https://id.undefineds.co/identity/%2e%2e/alice/profile/card#me',
    'https://user:password@id.undefineds.co/identity/alice/profile/card#me',
    ' https://id.undefineds.co/identity/alice/profile/card#me',
    'https://id.undefineds.co/identity/alice/profile/card#me\n',
    '/identity/alice/profile/card#me',
    'https:id.undefineds.co/identity/alice/profile/card#me',
    'https:////id.undefineds.co/identity/alice/profile/card#me',
    'https:\\id.undefineds.co/identity/alice/profile/card#me',
    'not a URL',
  ])('rejects missing or out-of-issuer managed WebID %j before creating storage', async (webId) => {
    const rootDir = createTestDir('local-pod-provisioning-invalid-webid');
    createdDirs.push(rootDir);
    const service = new LocalPodProvisioningService({
      baseUrl: 'https://node-0000.undefineds.co/',
      rootDir: path.join(rootDir, 'data'),
      sparqlEndpoint: `sqlite:${path.join(rootDir, 'quadstore.sqlite')}`,
      identityDbUrl: `sqlite:${path.join(rootDir, 'identity.sqlite')}`,
      oidcIssuer: 'https://id.undefineds.co/identity/',
    });

    await expect(service.createPod({ podName: 'alice', webId })).rejects.toThrow('Cloud issuer');
    expect(fs.existsSync(path.join(rootDir, 'data', 'alice'))).toBe(false);
    expect(fs.existsSync(path.join(rootDir, 'quadstore.sqlite'))).toBe(false);
    expect(fs.existsSync(path.join(rootDir, 'identity.sqlite'))).toBe(false);
  });

  it('does not rewrite a previously stored node-origin identity when managed creation rejects it', async () => {
    const rootDir = createTestDir('local-pod-legacy-owner');
    createdDirs.push(rootDir);
    const options = {
      baseUrl: 'https://node.test/', rootDir: path.join(rootDir, 'data'),
      sparqlEndpoint: `sqlite:${path.join(rootDir, 'rdf.sqlite')}`,
      identityDbUrl: `sqlite:${path.join(rootDir, 'identity.sqlite')}`,
    };
    const original = await new LocalPodProvisioningService(options).createPod({ podName: 'alice' });
    const managed = new LocalPodProvisioningService({ ...options, oidcIssuer: 'https://id.test/' });
    await expect(managed.createPod({ podName: 'alice', webId: original.webId })).rejects.toThrow('Cloud issuer');
    const identityDb = sqliteRuntime.openDatabase(path.join(rootDir, 'identity.sqlite'), { readonly: true });
    try {
      const account = JSON.parse(identityDb.prepare<{ value: string }>('SELECT value FROM internal_kv WHERE key = ?')
        .get(`accounts/data/${original.accountId}`)!.value);
      expect(Object.values(account['**pod**'][original.podId]['**owner**'])).toEqual([
        expect.objectContaining({ webId: original.webId }),
      ]);
    } finally {
      identityDb.close();
    }
  });

  it('gives a recreated Pod a fresh generation and does not overwrite a concurrent creation', async () => {
    const rootDir = createTestDir('local-pod-generations');
    createdDirs.push(rootDir);
    const service = new LocalPodProvisioningService({
      baseUrl: 'https://node.test/', rootDir: path.join(rootDir, 'data'),
      sparqlEndpoint: `sqlite:${path.join(rootDir, 'rdf.sqlite')}`,
      identityDbUrl: `sqlite:${path.join(rootDir, 'identity.sqlite')}`,
    });
    const first = await service.createPod({ podName: 'alice' });
    await expect(service.createPod({ podName: 'alice' })).rejects.toThrow('already exists');
    fs.rmSync(path.join(rootDir, 'data', 'alice'), { recursive: true });
    const second = await service.createPod({ podName: 'alice' });
    expect(second.podId).not.toBe(first.podId);
    expect(second.accountId).toBe(first.accountId);
    expect(second.webId).toBe(first.webId);
    const operations = new PodDeletionOperationRepository(`sqlite:${path.join(rootDir, 'identity.sqlite')}`);
    await operations.reserveStorage('https://node.test/bob/', 'deleting', 'delete');
    await expect(service.createPod({ podName: 'bob' })).rejects.toThrow('already in progress');
    expect(fs.existsSync(path.join(rootDir, 'data', 'bob'))).toBe(false);
  });

});
