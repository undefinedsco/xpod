import { sql } from 'drizzle-orm';
import { chatResource } from '@undefineds.co/models';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PodLookupRepository } from '../../../src/identity/drizzle/PodLookupRepository';
import { closeAllIdentityConnections, executeStatement, getIdentityDatabase } from '../../../src/identity/drizzle/db';
import { CanonicalRoomSource } from '../../../src/api/matrix/canonicalRoomSource';
import { PodMatrixStore } from '../../../src/api/matrix/PodMatrixStore';
import type { MatrixStoreContext } from '../../../src/api/matrix/types';

const alice = 'https://id.example/alice/card#me';
const scope = 'https://pod.example/alice/';
afterEach(async() => { await closeAllIdentityConnections(); });

async function fixture(options: { owner?: string; root?: string; unregistered?: boolean; storageRoot?: string } = {}) {
  const root = options.root ?? scope;
  const identityDb = getIdentityDatabase(`sqlite::memory:canonical-create-${crypto.randomUUID()}`);
  await executeStatement(identityDb, sql`CREATE TABLE internal_kv (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER)`);
  await executeStatement(identityDb, sql`CREATE TABLE identity_store (container TEXT NOT NULL, id TEXT NOT NULL, payload TEXT NOT NULL, PRIMARY KEY(container,id))`);
  if (!options.unregistered) {
    const pod = { accountId: 'account', baseUrl: root, ...(options.storageRoot ? { storage: options.storageRoot } : {}) };
    await executeStatement(identityDb, sql`INSERT INTO identity_store VALUES ('pod','source',${JSON.stringify(pod)})`);
    await executeStatement(identityDb, sql`INSERT INTO identity_store VALUES ('owner','source-owner',${JSON.stringify({ podId: 'source', webId: options.owner ?? alice })})`);
  }
  const init = vi.fn(async() => undefined);
  const write = vi.fn(async() => undefined);
  const fetch = vi.fn(async() => { throw new Error('A refused creation must not reach the Pod'); });
  const identity = vi.fn(async() => undefined);
  const callerFetchFor = vi.fn(async() => fetch as unknown as typeof globalThis.fetch);
  const port = new CanonicalRoomSource({ pods: new PodLookupRepository(identityDb), callerFetchFor });
  const context = {
    webId: alice, podUrl: root, auth: { type: 'solid', webId: alice, clientId: 'fixture-caller' },
    _matrixDb: { init, insert: () => ({ values: write }) }, _matrixPodFetch: fetch,
  } as unknown as MatrixStoreContext;
  const store = new PodMatrixStore({ canonicalSource: port, participantIdentity: { ensureParticipantIdentity: identity } });
  const zeroEffects = () => {
    expect(init).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
    expect(identity).not.toHaveBeenCalled();
    expect(callerFetchFor).not.toHaveBeenCalled();
  };
  return { port, context, store, zeroEffects };
}

// Actual SQLite registration facts; deliberately no HTTP server or real-Pod acceptance claim.
describe('independent canonical creation qualification before effects', () => {
  it('qualifies the exact explicit owner without reading the not-yet-created source', async() => {
    const f = await fixture();
    await expect(f.port.assertCreationOwner(chatResource.buildIri(scope, { id: 'new-room' }), f.context))
      .resolves.toMatchObject({ sourceRoot: scope });
    f.zeroEffects();
  });

  it('qualifies an exactly registered HTTP WebID without inventing a fragment requirement', async() => {
    const webId = 'https://id.example/alice';
    const f = await fixture({ owner: webId });
    const context = { ...f.context, webId, auth: { type: 'solid' as const, webId, clientId: 'fixture-caller' } };
    await expect(f.port.assertCreationOwner(chatResource.buildIri(scope, { id: 'new-room' }), context))
      .resolves.toMatchObject({ sourceRoot: scope });
    f.zeroEffects();
  });

  it.each([
    'https://id.example/alice/card#other',
    'https://id.example/alice/card',
  ])('refuses a different complete registered owner %s with zero effects', async owner => {
    const f = await fixture({ owner });
    await expect(f.store.createRoom({}, f.context)).rejects.toMatchObject({ status: 403 });
    f.zeroEffects();
  });

  it('refuses an unknown Pod before database initialization', async() => {
    const f = await fixture({ unregistered: true });
    await expect(f.store.createRoom({}, f.context)).rejects.toMatchObject({ status: 403 });
    f.zeroEffects();
  });

  it('refuses a noncanonical chosen Pod root before initialization rather than writing mismatched parents', async() => {
    const f = await fixture();
    const context = { ...f.context, podUrl: scope.slice(0, -1) };
    await expect(f.store.createRoom({}, context)).rejects.toMatchObject({ status: 403 });
    f.zeroEffects();
  });

  it('refuses caller/context identity disagreement before minting an identity', async() => {
    const f = await fixture();
    const context = { ...f.context, webId: 'https://id.example/bob/card#me' };
    await expect(f.store.createRoom({}, context)).rejects.toMatchObject({ status: 403 });
    f.zeroEffects();
  });

  it.each([
    'urn:uuid:12345678-1234-1234-1234-123456789abc',
    'https://user:pass@id.example/alice#me',
    'https://[bad/card#me',
  ])('refuses an author the canonical reader cannot accept: %s', async webId => {
    const f = await fixture({ owner: webId });
    const context = { ...f.context, webId, auth: { type: 'solid' as const, webId, clientId: 'fixture-caller' } };
    await expect(f.store.createRoom({}, context)).rejects.toMatchObject({ status: 403 });
    f.zeroEffects();
  });

  it('refuses a service context instead of treating it as caller creation authority', async() => {
    const f = await fixture();
    const context = { ...f.context, service: { taskCredential: { credentialRef: 'taskcred_fixture', version: 1 } } };
    await expect(f.store.createRoom({}, context)).rejects.toMatchObject({ status: 403 });
    f.zeroEffects();
  });

  it('refuses missing creation authority instead of falling back to an injected database', async() => {
    const f = await fixture();
    const store = new PodMatrixStore({});
    await expect(store.createRoom({}, f.context)).rejects.toMatchObject({ status: 403 });
    f.zeroEffects();
  });

  it('refuses an overlong source-bound room id before any write', async() => {
    const f = await fixture({ root: `https://pod.example/${'x'.repeat(210)}/` });
    await expect(f.store.createRoom({}, f.context)).rejects.toMatchObject({ status: 400 });
    f.zeroEffects();
  });
});
