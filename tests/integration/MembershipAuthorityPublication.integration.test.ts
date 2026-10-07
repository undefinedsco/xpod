import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { Parser, Store } from 'n3';
import { messageResource } from '@undefineds.co/models';
import { describe, expect, it, vi } from 'vitest';
import { OwnerPodAccess } from '../../src/api/ai-gateway/pod/OwnerPodAccess';
import { CanonicalRoomSource } from '../../src/api/matrix/canonicalRoomSource';
import { PodMatrixStore } from '../../src/api/matrix/PodMatrixStore';
import { InMemoryMatrixEventJournal } from '../../src/api/matrix/MatrixEventJournal';
import { MembershipAuthorityPublisher } from '../../src/api/matrix/membershipAuthorityPublication';
import { MembershipAuthorityResolver, isMembershipAuthorityProof } from '../../src/api/matrix/membershipAuthorityResolver';
import { MembershipAuthorityLocator } from '../../src/api/matrix/membershipAuthorityLocator';
import * as destinations from '../../src/api/matrix/federation/destinations';
import { MatrixOutbox } from '../../src/api/matrix/federation/outboundQueue';
import { PodMatrixOutboundStore } from '../../src/api/matrix/federation/podOutboundStore';
import type { MatrixPodWrite } from '../../src/api/matrix/podAccess';
import { matrixPodWriteFor } from '../../src/api/matrix/podAccess';
import type { MatrixEventRecord, MatrixStoreContext } from '../../src/api/matrix/types';
import { createTaskCredentialSource, TaskCredentialStore } from '../../src/api/tasks/TaskCredentialStore';
import { getTaskCredentialDatabase, resetTaskCredentialDatabases } from '../../src/api/tasks/TaskCredentialDatabase';
import { PodLookupRepository } from '../../src/identity/drizzle/PodLookupRepository';
import { closeAllIdentityConnections, getIdentityDatabase } from '../../src/identity/drizzle/db';
import { DeploymentRootKeyProvider, SecretCellVault } from '../../src/security/secret-cell';
import { createTestSolidSessions } from '../helpers/solidSessions';
import { setupAccount } from './helpers/solidAccount';

const suite = process.env.XPOD_RUN_INTEGRATION_TESTS === 'true' ? describe : describe.skip;
const type = 'co.undefineds.membership.authority';

// Runs against the integration runner's actual Gateway/CSS and real registered Pod. This is
// separate evidence from owned HTTP/Comunica fixtures and from the user's current Gateway.
suite('root membership publication native Pod projection and recovery', () => {
  it('preserves the first PDU through lost projection response, rotated authority and Store reopen', async() => {
    const baseUrl = (process.env.CSS_BASE_URL ?? 'http://localhost:5739').replace(/\/$/, '');
    // This suite writes real outbound control records; it needs its own actual Pod so other
    // suites enumerating the default integration Pod cannot observe these in-flight batches.
    const account = await setupAccount(baseUrl, 'root-membership-publication');
    const identityDbUrl = process.env.XPOD_INTEGRATION_IDENTITY_DB_URL;
    if (!account || !identityDbUrl) throw new Error('Native publisher acceptance requires current runner account and Pod registry');
    const directoryBase = path.resolve('.test-data/solid-multiparty-acceptance/provider-b/root-review/native-publication');
    await mkdir(directoryBase, { recursive: true });
    const directory = await mkdtemp(path.join(directoryBase, 'owned-'));
    const mutations: { url: string; method: string }[] = [];
    const podAccess = new OwnerPodAccess({ sessions: createTestSolidSessions({
      tokenEndpoint: `${account.issuer.replace(/\/$/, '')}/.oidc/token`, publicBaseUrl: account.issuer }),
    fetch: async(input, init) => {
      const method = init?.method ?? (input instanceof Request ? input.method : 'GET');
      if (![ 'GET', 'HEAD', 'OPTIONS' ].includes(method)) mutations.push({
        url: input instanceof Request ? input.url : String(input), method });
      return fetch(input, init);
    } });
    const context: MatrixStoreContext = { webId: account.webId, podUrl: account.podUrl,
      auth: { type: 'solid', webId: account.webId, accountId: account.webId,
        clientId: account.clientId, clientSecret: account.clientSecret, viaApiKey: true, tokenType: 'DPoP' } };
    const source = new CanonicalRoomSource({ pods: new PodLookupRepository(getIdentityDatabase(identityDbUrl)),
      callerFetchFor: async(caller, beforeRequest) => {
        const transport = await podAccess.getPodFetch(caller.webId, { auth: caller.auth, beforeRequest });
        if (!transport) throw new Error('Native caller transport unavailable');
        return transport;
      } });
    // Route selection is fixed to isolate the real publisher/queue carrier. No fake peer is
    // contacted, and this suite does not claim peer membership, receipt or two-Gateway acceptance.
    vi.spyOn(destinations, 'eventDestinations').mockReturnValue([ 'root-publication-peer.example' ]);
    const credentials = new TaskCredentialStore({
      database: getTaskCredentialDatabase(`sqlite:${path.join(directory, 'tasks.sqlite')}`),
      vault: new SecretCellVault({ rootKeys: new DeploymentRootKeyProvider({ activeKeyId: 'root-test',
        keys: { 'root-test': Buffer.alloc(32, 11) } }) }) });
    try {
      const grant = await credentials.grant({ ownerWebId: account.webId, issuer: account.issuer,
        clientId: account.clientId, clientSecret: account.clientSecret, status: 'active' });
      const binding = { purpose: 'membership' as const, credentialRef: grant.credentialRef,
        version: grant.version, issuer: account.issuer };
      const publisher = new MembershipAuthorityPublisher({ canonicalSource: source, credentials,
        podAccess, issuer: account.issuer });
      let interrupted = false;
      let originalRecord: MatrixEventRecord | undefined;
      const genericEnqueue = vi.fn(async() => { throw new Error('Publication borrowed the generic outbox'); });
      let queueEnabled = false;
      const carrierFor = (write: MatrixPodWrite, caller: MatrixStoreContext) => new PodMatrixOutboundStore({
        handleFor: async(scope) => scope === account.podUrl ? { scope, write } : undefined,
        publicationCaller: caller,
      });
      const makeStore = (interrupt = false) => new PodMatrixStore({ canonicalSource: source, podAccess,
        deliverAsActor: true, ...(queueEnabled ? { outbound: { enqueue: genericEnqueue } } : {}),
        publicationOutboxFor: (write, caller) => new MatrixOutbox({ store: carrierFor(write, caller),
          send: async() => { throw new Error('Native publication acceptance does not send to a fake peer'); } }),
        journal: new InMemoryMatrixEventJournal(), membershipAuthorityPublisher: interrupt ? {
          publish: async(roomId, value, caller, project) => publisher.publish(roomId, value, caller,
            async(input) => {
              const record = await project!(input);
              if (!interrupted) { originalRecord = record; interrupted = true; throw new Error('Root lost native projection response'); }
              return record;
            }),
        } : publisher });
      const firstStore = makeStore(true);
      const room = await firstStore.createRoom({}, context);
      queueEnabled = true;
      (firstStore as unknown as { outbound: { enqueue: typeof genericEnqueue } }).outbound = { enqueue: genericEnqueue };
      await expect(firstStore.setState(room.roomId, type, '', binding, context))
        .rejects.toThrow('Root lost native projection response');
      const old = await source.read(room.roomId, context);
      expect(old.membershipAuthority).toEqual(binding);
      expect(old.membershipAuthorityPublication?.state).toBe('pending');
      const pending = old.membershipAuthorityPublication!;
      await credentials.rotate(grant.credentialRef, { clientId: account.clientId,
        clientSecret: account.clientSecret, expectedVersion: grant.version });
      const reopened = makeStore();
      const countBefore = mutations.length;
      await expect(reopened.setState(room.roomId, type, '', binding, context)).rejects.toMatchObject({ status: 403 });
      expect(mutations.length).toBe(countBefore);
      const next = { ...binding, version: grant.version + 1 };
      const record = await reopened.setState(room.roomId, type, '', next, context);
      expect(record.eventId).not.toBe(pending.eventId);
      expect(record.event?.sender).toBe(account.webId);
      const complete = await source.read(room.roomId, context);
      expect(complete.membershipAuthority).toEqual(next);
      expect(complete.membershipAuthorityPublication).toEqual({ eventId: record.eventId,
        createdAt: record.originServerTs, state: 'complete' });
      const retry = await makeStore().setState(room.roomId, type, '', next, context);
      expect(retry.event).toEqual(record.event);
      expect(genericEnqueue).not.toHaveBeenCalled();
      const write = await matrixPodWriteFor(context, podAccess);
      const batches = await carrierFor(write, context).pending(account.podUrl);
      const relevant = batches.filter(batch => batch.pdus.some(event => {
        const id = (event as { event_id?: string }).event_id;
        return id === pending.eventId || id === record.eventId;
      }));
      expect(relevant).toHaveLength(2);
      for (const batch of relevant) {
        expect(batch.pdus).toHaveLength(1);
        expect(batch.actor).toEqual({ webId: account.webId, podUrl: account.podUrl, taskCredential: next });
      }
      expect(originalRecord?.resourceId).toBeTruthy();
      const document = messageResource.buildIri(account.podUrl, { id: originalRecord!.resourceId! }).split('#')[0];
      const response = await write.fetch(document, { headers: { Accept: 'text/turtle' } });
      expect(response.status).toBe(200);
      const graph = new Store(new Parser({ baseIRI: document }).parse(await response.text()));
      const matches = graph.getQuads(null, null, null, null).flatMap(q => {
        if (q.object.termType !== 'Literal' || !q.predicate.value.endsWith('protocols')) return [];
        try {
          const event = JSON.parse(q.object.value)?.matrix?.event;
          return event?.event_id === pending.eventId ? [ { subject: q.subject.value, event } ] : [];
        } catch { return []; }
      });
      expect(matches).toHaveLength(1);
      expect(matches[0].event).toMatchObject({ event_id: pending.eventId, room_id: room.roomId,
        sender: account.webId, type, state_key: '', origin_server_ts: pending.createdAt, content: binding });
      expect(Object.keys(matches[0].event.content).sort()).toEqual([ 'credentialRef', 'issuer', 'purpose', 'version' ]);

      // Exercise the separate named reader with actual task-vault credentials and DPoP against
      // the same owned native Pod. This remains owner re-bootstrap evidence, not Bob join/ACL.
      const namedRequests: string[] = [];
      const taskAccess = new OwnerPodAccess({ sessions: createTestSolidSessions({
        tokenEndpoint: `${account.issuer.replace(/\/$/, '')}/.oidc/token`, publicBaseUrl: account.issuer }),
      taskCredentials: createTaskCredentialSource({ store: credentials, issuer: account.issuer }),
      fetch: async(input, init) => {
        const method = init?.method ?? (input instanceof Request ? input.method : 'GET');
        expect(method).toBe('GET');
        namedRequests.push(input instanceof Request ? input.url : String(input));
        return fetch(input, init);
      } });
      const locator = new MembershipAuthorityLocator(getIdentityDatabase(`sqlite:${path.join(directory, 'locator.sqlite')}`));
      const resolver = new MembershipAuthorityResolver({ canonicalSource: source, locator, credentials,
        podAccess: taskAccess, issuer: account.issuer });
      await resolver.readAsCaller(room.roomId, context);
      const proof = await resolver.resolveForMembership(room.roomId, context);
      expect(isMembershipAuthorityProof(proof)).toBe(true);
      expect(proof).toMatchObject({ actorWebId: account.webId, transportOwnerWebId: account.webId,
        binding: next, facts: { sourceIri: complete.sourceIri } });
      expect(namedRequests).toEqual([ complete.sourceIri.split('#')[0] ]);
      await locator.wipe(); namedRequests.length = 0;
      await expect(resolver.resolveForMembership(room.roomId, context)).rejects.toMatchObject({ status: 403 });
      expect(namedRequests).toEqual([]);
      await resolver.readAsCaller(room.roomId, context);
      await expect(resolver.resolveForMembership(room.roomId, context)).resolves.toMatchObject({ binding: next });
      await credentials.revoke(next.credentialRef); namedRequests.length = 0;
      const lastMutationCount = mutations.length;
      await expect(resolver.resolveForMembership(room.roomId, context)).rejects.toMatchObject({ status: 403 });
      expect(namedRequests).toEqual([]);
      expect(mutations.length).toBe(lastMutationCount);
    } finally {
      vi.restoreAllMocks();
      resetTaskCredentialDatabases();
      await closeAllIdentityConnections();
      await rm(directory, { recursive: true, force: true });
    }
  }, 180_000);
});
