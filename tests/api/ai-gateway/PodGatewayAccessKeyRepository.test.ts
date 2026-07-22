import { describe, expect, it, vi } from 'vitest';
import { gatewayAccessKeyResource } from '@undefineds.co/models';

import {
  createGatewayApiKey,
} from '../../../src/api/ai-gateway/auth/GatewayApiKey';
import {
  GatewayApiKeyAuthenticator,
} from '../../../src/api/ai-gateway/auth/GatewayApiKeyAuthenticator';
import {
  PodGatewayAccessKeyRepository,
} from '../../../src/api/ai-gateway/auth/PodGatewayAccessKeyRepository';
import {
  AesGatewayKeyLocatorCodec,
  createGatewayKeyLocator,
} from '../../../src/api/ai-gateway/auth/GatewayKeyLocatorCodec';
import type { AuthContext } from '../../../src/api/auth/AuthContext';

const ALICE = 'https://id.example/alice/profile/card#me';
const BOB = 'https://id.example/bob/profile/card#me';

type Row = Record<string, any>;

function createPodBackedDbFactory() {
  const pods = new Map<string, Map<string, Row>>();
  const calls: Array<{ owner: string; auth?: AuthContext; op: string; resource?: unknown; id?: string; patch?: unknown }> = [];

  function pod(owner: string): Map<string, Row> {
    let store = pods.get(owner);
    if (!store) {
      store = new Map();
      pods.set(owner, store);
    }
    return store;
  }

  const dbFactory = vi.fn(async ({ owner, auth }: { owner: string; auth?: AuthContext }) => {
    const store = pod(owner);
    return {
      async init(...resources: unknown[]) {
        calls.push({ owner, auth, op: 'init', resource: resources[0] });
      },
      insert(resource: unknown) {
        calls.push({ owner, auth, op: 'insert', resource });
        return {
          values(value: Row) {
            calls.push({ owner, auth, op: 'values', resource });
            return {
              async execute() {
                store.set(value.id, clone(value));
                return [clone(value)];
              },
            };
          },
        };
      },
      select() {
        return {
          from(resource: unknown) {
            calls.push({ owner, auth, op: 'from', resource });
            return {
              where(_condition: unknown) {
                return {
                  async execute() {
                    return [...store.values()].filter((row) => row.owner === owner).map(clone);
                  },
                };
              },
            };
          },
        };
      },
      async findById(resource: unknown, id: string) {
        calls.push({ owner, auth, op: 'findById', resource, id });
        return clone(store.get(id));
      },
      async findByIri(resource: unknown, id: string) {
        calls.push({ owner, auth, op: 'findByIri', resource, id });
        return clone(store.get(id));
      },
      async updateById(resource: unknown, id: string, patch: Row) {
        calls.push({ owner, auth, op: 'updateById', resource, id, patch });
        const row = store.get(id);
        if (!row) {
          return null;
        }
        Object.assign(row, patch);
        return clone(row);
      },
      async updateByIri(resource: unknown, id: string, patch: Row) {
        calls.push({ owner, auth, op: 'updateByIri', resource, id, patch });
        const row = store.get(id);
        if (!row) {
          return null;
        }
        Object.assign(row, patch);
        return clone(row);
      },
    };
  });

  return { dbFactory, calls, pods };
}

function createInternalPodAccess() {
  return {
    fetch: vi.fn(fetch),
    provider: {
      getTrustedFetch: vi.fn(async () => fetch),
    },
  };
}

describe('PodGatewayAccessKeyRepository', () => {
  const codec = new AesGatewayKeyLocatorCodec('test-locator-secret');

  it('keeps key locators opaque and bound to the platform secret', () => {
    const locator = createGatewayKeyLocator(ALICE, 'cloud', codec);
    const wrongCodec = new AesGatewayKeyLocatorCodec('wrong-secret');
    const parts = locator.split('.');
    parts[2] = `${parts[2].slice(0, 4)}${parts[2][4] === 'A' ? 'B' : 'A'}${parts[2].slice(5)}`;
    const tampered = parts.join('.');

    expect(locator).not.toContain(ALICE);
    expect(Buffer.from(locator).toString('utf8')).not.toContain(ALICE);
    expect(wrongCodec.decode(locator)).toBeUndefined();
    expect(codec.decode(tampered)).toBeUndefined();
    expect(codec.decode(locator)).toMatchObject({
      owner: ALICE,
      deployment: 'cloud',
    });
  });

  it('persists access keys through the models gatewayAccessKeyResource without storing plaintext', async () => {
    const { dbFactory, calls, pods } = createPodBackedDbFactory();
    const internal = createInternalPodAccess();
    const repository = new PodGatewayAccessKeyRepository({
      dbFactory,
      locatorCodec: codec,
      internalPodAccess: internal.provider,
    });
    const keyId = createGatewayKeyLocator(ALICE, 'cloud', codec);
    const issued = await createGatewayApiKey({ deployment: 'cloud', keyId });

    await repository.create({
      ...issued.record,
      owner: ALICE,
      scopes: ['models:read', 'inference:write'],
      createdAt: new Date('2026-07-23T00:00:00.000Z'),
    }, {
      auth: {
        type: 'solid',
        webId: ALICE,
        accessToken: 'solid-access-token',
        tokenType: 'Bearer',
      },
    });

    const serializedPod = JSON.stringify([...pods.values()].map((pod) => [...pod.values()]));
    expect(serializedPod).not.toContain(issued.plaintext);
    expect(serializedPod).not.toContain(issued.secret);
    expect(serializedPod).toContain('scrypt$');
    expect(calls).toEqual(expect.arrayContaining([
      expect.objectContaining({ op: 'init', resource: gatewayAccessKeyResource }),
      expect.objectContaining({ op: 'insert', resource: gatewayAccessKeyResource }),
    ]));
  });

  it('authenticates after repository restart by resolving the owner Pod from the opaque key locator', async () => {
    const backing = createPodBackedDbFactory();
    const internal = createInternalPodAccess();
    const keyId = createGatewayKeyLocator(ALICE, 'local', codec);
    const issued = await createGatewayApiKey({ deployment: 'local', keyId });
    const writer = new PodGatewayAccessKeyRepository({
      dbFactory: backing.dbFactory,
      locatorCodec: codec,
      internalPodAccess: internal.provider,
    });
    await writer.create({
      ...issued.record,
      owner: ALICE,
      scopes: ['models:read', 'inference:write'],
      createdAt: new Date('2026-07-23T00:00:00.000Z'),
    });

    const restartedRepository = new PodGatewayAccessKeyRepository({
      dbFactory: backing.dbFactory,
      locatorCodec: codec,
      internalPodAccess: internal.provider,
    });
    const authenticator = new GatewayApiKeyAuthenticator({
      repository: restartedRepository,
      deployment: 'local',
      now: () => new Date('2026-07-23T01:00:00.000Z'),
    });

    await expect(authenticator.authenticate({
      headers: { authorization: `Bearer ${issued.plaintext}` },
    } as any)).resolves.toMatchObject({
      success: true,
      context: {
        webId: ALICE,
        scopes: ['models:read', 'inference:write'],
      },
    });
  });

  it('keeps WebID Pods isolated even when another Pod contains the same local id', async () => {
    const backing = createPodBackedDbFactory();
    const internal = createInternalPodAccess();
    const aliceKeyId = createGatewayKeyLocator(ALICE, 'cloud', codec);
    const bobKeyId = createGatewayKeyLocator(BOB, 'cloud', codec);
    const aliceKey = await createGatewayApiKey({ deployment: 'cloud', keyId: aliceKeyId });
    const bobKey = await createGatewayApiKey({ deployment: 'cloud', keyId: bobKeyId });
    const repository = new PodGatewayAccessKeyRepository({
      dbFactory: backing.dbFactory,
      locatorCodec: codec,
      internalPodAccess: internal.provider,
    });
    await repository.create({ ...aliceKey.record, owner: ALICE, scopes: ['models:read', 'inference:write'], createdAt: new Date() });
    await repository.create({ ...bobKey.record, owner: BOB, scopes: ['models:read', 'inference:write'], createdAt: new Date() });

    await expect(repository.findById(aliceKeyId)).resolves.toMatchObject({ owner: ALICE });
    await expect(repository.findById(bobKeyId)).resolves.toMatchObject({ owner: BOB });
    await expect(repository.listByOwner(ALICE)).resolves.toEqual([expect.objectContaining({ owner: ALICE })]);
  });

  it('writes revoke and lastUsedAt back to the Pod resource', async () => {
    const backing = createPodBackedDbFactory();
    const internal = createInternalPodAccess();
    const keyId = createGatewayKeyLocator(ALICE, 'cloud', codec);
    const issued = await createGatewayApiKey({ deployment: 'cloud', keyId });
    const repository = new PodGatewayAccessKeyRepository({
      dbFactory: backing.dbFactory,
      locatorCodec: codec,
      internalPodAccess: internal.provider,
    });
    await repository.create({
      ...issued.record,
      owner: ALICE,
      scopes: ['models:read', 'inference:write'],
      createdAt: new Date('2026-07-23T00:00:00.000Z'),
    });

    await repository.touchLastUsed(keyId, new Date('2026-07-23T01:00:00.000Z'));
    await repository.revoke(keyId, new Date('2026-07-23T02:00:00.000Z'));

    await expect(repository.findById(keyId)).resolves.toMatchObject({
      lastUsedAt: new Date('2026-07-23T01:00:00.000Z'),
      revokedAt: new Date('2026-07-23T02:00:00.000Z'),
    });
    expect(backing.calls).toEqual(expect.arrayContaining([
      expect.objectContaining({ op: 'updateById', resource: gatewayAccessKeyResource, id: keyId }),
    ]));
  });

  it('fails closed without trusted internal access and does not issue anonymous Pod reads', async () => {
    const backing = createPodBackedDbFactory();
    const anonymousFetch = vi.spyOn(globalThis, 'fetch');
    const keyId = createGatewayKeyLocator(ALICE, 'cloud', codec);
    const repository = new PodGatewayAccessKeyRepository({
      dbFactory: backing.dbFactory,
      locatorCodec: codec,
    });

    await expect(repository.findById(keyId)).resolves.toBeUndefined();

    expect(backing.dbFactory).not.toHaveBeenCalled();
    expect(anonymousFetch).not.toHaveBeenCalled();
    anonymousFetch.mockRestore();
  });
});

function clone<T>(value: T): T {
  if (value === undefined || value === null) {
    return value;
  }
  return structuredClone(value);
}
