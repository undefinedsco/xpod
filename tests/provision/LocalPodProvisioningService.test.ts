import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { LocalPodProvisioningService } from '../../src/provision/LocalPodProvisioningService';
import { getSqliteRuntime } from '../../src/storage/SqliteRuntime';
import { rowToQuad } from '../../src/storage/quint/serialization';
import { createTestDir } from '../utils/sqlite';

describe('LocalPodProvisioningService', () => {
  const createdDirs: string[] = [];
  const sqliteRuntime = getSqliteRuntime();

  afterEach(() => {
    for (const dir of createdDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('creates CSS-compatible local Pod metadata and identity indexes', async () => {
    const rootDir = createTestDir('local-pod-provisioning');
    createdDirs.push(rootDir);
    const sparqlPath = path.join(rootDir, 'quadstore.sqlite');
    const identityPath = path.join(rootDir, 'identity.sqlite');
    const service = new LocalPodProvisioningService({
      baseUrl: 'https://node-0000.undefineds.co/',
      rootDir: path.join(rootDir, 'data'),
      sparqlEndpoint: `sqlite:${sparqlPath}`,
      identityDbUrl: `sqlite:${identityPath}`,
      oidcIssuer: 'https://id.undefineds.co/',
    });

    const result = await service.createPod({
      podName: 'alice',
      webId: 'https://id.undefineds.co/alice/profile/card#me',
    });

    expect(result.podUrl).toBe('https://node-0000.undefineds.co/alice/');
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
        'https://id.undefineds.co/alice/profile/card#me',
      )).toBe(true);
      expect(hasQuad(
        'https://id.undefineds.co/alice/profile/card#me',
        'http://www.w3.org/ns/solid/terms#oidcIssuer',
        'https://id.undefineds.co/',
      )).toBe(true);
      expect(hasQuad(
        'https://id.undefineds.co/alice/profile/card#me',
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
      expect(keys).toContain(`accounts/index/webIdLink/webId/${encodeURIComponent('https://id.undefineds.co/alice/profile/card#me')}`);
      expect(keys.some((key) => key.startsWith('accounts/data/'))).toBe(true);
      expect(keys.some((key) => key.startsWith('accounts/index/owner/'))).toBe(true);
    } finally {
      identityDb.close();
    }
  });

  it('uses Cloud issuer WebID as owner when provision callback omits webId', async () => {
    const rootDir = createTestDir('local-pod-provisioning-fallback-webid');
    createdDirs.push(rootDir);
    const sparqlPath = path.join(rootDir, 'quadstore.sqlite');
    const identityPath = path.join(rootDir, 'identity.sqlite');
    const service = new LocalPodProvisioningService({
      baseUrl: 'https://node-0000.undefineds.co/',
      rootDir: path.join(rootDir, 'data'),
      sparqlEndpoint: `sqlite:${sparqlPath}`,
      identityDbUrl: `sqlite:${identityPath}`,
      oidcIssuer: 'https://id.undefineds.co/',
    });

    await service.createPod({ podName: 'alice' });

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
        'https://node-0000.undefineds.co/alice/profile/card',
        'http://xmlns.com/foaf/0.1/primaryTopic',
        'https://id.undefineds.co/alice/profile/card#me',
      )).toBe(true);
      expect(hasQuad(
        'https://id.undefineds.co/alice/profile/card#me',
        'http://www.w3.org/ns/solid/terms#oidcIssuer',
        'https://id.undefineds.co/',
      )).toBe(true);
      expect(hasQuad(
        'https://id.undefineds.co/alice/profile/card#me',
        'http://www.w3.org/ns/solid/terms#storage',
        'https://node-0000.undefineds.co/alice/',
      )).toBe(true);
      expect(hasQuad(
        'https://node-0000.undefineds.co/alice/.acr#root',
        'http://www.w3.org/ns/solid/acp#resource',
        'https://node-0000.undefineds.co/alice/',
      )).toBe(true);
      expect(hasQuad(
        'https://node-0000.undefineds.co/alice/.acr#root',
        'http://www.w3.org/ns/solid/acp#memberAccessControl',
        'https://node-0000.undefineds.co/alice/.acr#fullOwnerAccess',
      )).toBe(true);
      expect(quads.some((quad) =>
        quad.predicate.value === 'http://www.w3.org/ns/solid/acp#agent' &&
        quad.object.value === 'https://id.undefineds.co/alice/profile/card#me')).toBe(true);
      expect(quads.some((quad) =>
        quad.predicate.value === 'http://www.w3.org/ns/solid/acp#agent' &&
        quad.object.value === 'https://node-0000.undefineds.co/alice/profile/card#me')).toBe(false);
    } finally {
      quadsDb.close();
    }

    const identityDb = sqliteRuntime.openDatabase(identityPath, { readonly: true });
    try {
      const webIdIndex = identityDb.prepare<{ value: string }>(
        'SELECT value FROM internal_kv WHERE key = ?',
      ).get(`accounts/index/webIdLink/webId/${encodeURIComponent('https://id.undefineds.co/alice/profile/card#me')}`);

      expect(webIdIndex).toBeTruthy();
    } finally {
      identityDb.close();
    }
  });

  it('can create WebACL authorization resources when authMode is acl', async () => {
    const rootDir = createTestDir('local-pod-provisioning-acl');
    createdDirs.push(rootDir);
    const sparqlPath = path.join(rootDir, 'quadstore.sqlite');
    const identityPath = path.join(rootDir, 'identity.sqlite');
    const service = new LocalPodProvisioningService({
      baseUrl: 'https://node-0000.undefineds.co/',
      rootDir: path.join(rootDir, 'data'),
      sparqlEndpoint: `sqlite:${sparqlPath}`,
      identityDbUrl: `sqlite:${identityPath}`,
      oidcIssuer: 'https://id.undefineds.co/',
      authMode: 'acl',
    });

    await service.createPod({
      podName: 'alice',
      webId: 'https://id.undefineds.co/alice/profile/card#me',
    });

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
        'https://node-0000.undefineds.co/alice/.acl#owner',
        'http://www.w3.org/ns/auth/acl#accessTo',
        'https://node-0000.undefineds.co/alice/',
      )).toBe(true);
      expect(hasQuad(
        'https://node-0000.undefineds.co/alice/.acl#owner',
        'http://www.w3.org/ns/auth/acl#default',
        'https://node-0000.undefineds.co/alice/',
      )).toBe(true);
      expect(hasQuad(
        'https://node-0000.undefineds.co/alice/profile/card.acl#public',
        'http://www.w3.org/ns/auth/acl#accessTo',
        'https://node-0000.undefineds.co/alice/profile/card',
      )).toBe(true);
      expect(hasQuad(
        'https://node-0000.undefineds.co/alice/profile/.acl#public',
        'http://www.w3.org/ns/auth/acl#accessTo',
        'https://node-0000.undefineds.co/alice/profile/',
      )).toBe(true);
      expect(quads.some((quad) =>
        quad.predicate.value === 'http://www.w3.org/ns/solid/acp#resource')).toBe(false);
    } finally {
      quadsDb.close();
    }
  });
});
