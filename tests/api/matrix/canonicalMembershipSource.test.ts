import { describe, expect, it, vi } from 'vitest';
import { drizzle } from '@undefineds.co/drizzle-solid';
import { chatResource } from '@undefineds.co/models';
import { QueryEngine } from '@comunica/query-sparql';
import { DataFactory, Parser, Store, Writer } from 'n3';
import { CanonicalMembershipSource } from '../../../src/api/matrix/canonicalMembershipSource';
import { MembershipAuthorityResolver } from '../../../src/api/matrix/membershipAuthorityResolver';
import { MembershipLifecycle } from '../../../src/api/matrix/membershipLifecycle';
import { applyMembershipReadDelta } from '../../../src/api/matrix/membershipPolicyMutation';
import { CanonicalRoomSource } from '../../../src/api/matrix/canonicalRoomSource';
import { encodeSourceBoundRoomId } from '../../../src/api/matrix/canonicalRoomIdentity';
import { membershipPolicyFixture } from '../../helpers/MembershipPolicyFixture';
import type { MembershipOperation } from '../../../src/api/matrix/membershipOperation';
import type { MatrixEventRecord, MatrixStoreContext } from '../../../src/api/matrix/types';

type RealFixture = Parameters<Parameters<typeof membershipPolicyFixture>[0]>[0];
const GUARDED_MEDIA = 'application/vnd.xpod.guarded-sparql-update+json';
const serializePolicy = (store: Store, graph: string): string => store.getQuads(null, null, null, DataFactory.namedNode(graph))
  .map(quad => `<${quad.subject.value}> <${quad.predicate.value}> <${quad.object.value}> .`).join('\n');
function guardedPolicyReplyFor(f: RealFixture, loseCanonicalResponse = false): { posts: () => number } {
  const store = new Store();
  const body = f.replies.get(`GET ${f.roomPolicy}`)?.body ?? '';
  if (body) for (const quad of new Parser({ baseIRI: f.roomPolicy, format: 'Turtle' }).parse(body)) {
    store.addQuad(DataFactory.quad(quad.subject, quad.predicate, quad.object, DataFactory.namedNode(f.roomPolicy)));
  }
  let posts = 0;
  f.onGuardedPost(async(request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const raw = Buffer.concat(chunks).toString(); posts++;
    if (request.headers['content-type'] !== GUARDED_MEDIA) {
      await f.engine.queryVoid(raw, { sources: [ f.graph ], destination: f.graph });
      response.writeHead(204); response.end(); return;
    }
    const envelope = JSON.parse(raw) as { update: string };
    // The canonical phase CAS carries the source graph, not the policy write graph.
    if (!envelope.update.includes(`GRAPH <${f.roomPolicy}>`)) {
      await f.engine.queryVoid(envelope.update, { sources: [ f.graph ], destination: f.graph });
      if (loseCanonicalResponse) { request.socket.destroy(); return; }
      response.writeHead(204); response.end(); return;
    }
    const live = new Store([ ...f.graph.getQuads(null, null, null, null), ...store.getQuads(null, null, null, null) ]);
    await f.engine.queryVoid(envelope.update, { sources: [ live ], destination: live });
    store.removeQuads(store.getQuads(null, null, null, null));
    store.addQuads(live.getQuads(null, null, null, DataFactory.namedNode(f.roomPolicy)));
    f.set('GET', f.roomPolicy, { status: 200, body: serializePolicy(store, f.roomPolicy) });
    response.writeHead(204); response.end();
  });
  return { posts: () => posts };
}

async function fixture(roles?: Record<string, 'owner' | 'admin' | 'member'>, named = false) {
  const podUrl = 'https://invite.example/pod/';
  const owner = `${podUrl}profile/card#me`; const target = 'https://target.example/card#me';
  const actor: MatrixStoreContext = { webId: owner, podUrl, auth: { type: 'solid', webId: owner } };
  const binding = { purpose: 'membership' as const, credentialRef: 'explicit-grant', version: 1, issuer: 'https://issuer.example/' };
  const joinActor: MatrixStoreContext = { webId: target, podUrl: 'https://target.example/pod/', auth: { type: 'solid', webId: target } };
  const graph = new Store(); const engine = new QueryEngine();
  const sourceIri = chatResource.buildIri(podUrl, { id: 'invite-foundation' });
  const roomId = encodeSourceBoundRoomId(sourceIri); const document = sourceIri.split('#')[0];
  const compiler = drizzle({ info: { webId: owner, podUrl, isLoggedIn: true }, fetch: async() => { throw new Error('No compiler network'); } } as never,
    { podUrl, disableInteropDiscovery: true, resourcePreparation: 'off' });
  await engine.queryVoid(compiler.insert(chatResource).values({ id: chatResource.buildId({ id: 'invite-foundation' }),
    author: owner, participants: [owner], title: 'unchanged', metadata: { '@id': `${sourceIri}/metadata`,
      ...(roles === undefined ? {} : { memberRoles: roles }), other: 'retained',
      protocols: { custom: { unchanged: true }, matrix: { roomId, ...(named ? { membershipAuthority: binding, membershipAuthorityPublication: { eventId: '$binding', createdAt: 1, state: 'complete' }, membershipInvitations: { [target]: { id: '$invite', inviterWebId: owner, createdAt: 2 } } } : {}) } } } } as never).toSPARQL().query,
  { sources: [graph], destination: graph });
  let posts = 0; let noWrite = false; let lost = false;
  const transport: typeof fetch = async(input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    if (init?.method === 'POST') {
      posts++;
      if (!noWrite) await engine.queryVoid(String(init.body), { sources: [graph], destination: graph });
      if (lost) throw new Error('Lost response');
      return new Response(null, { status: 204 });
    }
    expect(url).toBe(document);
    const writer = new Writer(); writer.addQuads(graph.getQuads(null, null, null, null).map(q => DataFactory.quad(q.subject, q.predicate, q.object)));
    const body = await new Promise<string>((resolve, reject) => writer.end((error, ttl) => error ? reject(error) : resolve(ttl)));
    const response = new Response(body, { headers: { 'Content-Type': 'text/turtle' } });
    Object.defineProperty(response, 'url', { value: document }); return response;
  };
  const pod = { podId: 'invite', baseUrl: podUrl, webId: owner, webIds: [owner] };
  const source = new CanonicalRoomSource({ pods: { findByResourceIdentifier: async() => pod,
    findAllByWebId: async(webId: string) => webId === owner ? [pod] : webId === target ? [{ podId: 'target', baseUrl: joinActor.podUrl!, webId: target }] : [] } as never, callerFetchFor: async() => transport });
  let revoked = false;
  const credentials = { lease: vi.fn(async() => { if (!named || revoked) throw new Error('No current named lease'); return { ...binding, ownerWebId: owner }; }) };
  const podAccess = { getPodFetch: vi.fn(async() => transport) };
  const resolver = { readAsCaller: async(room: string, context: MatrixStoreContext) => await source.read(room, context), resolveForMembership: vi.fn(async() => { throw new Error('No inferred binding'); }) };
  const namedResolver = new MembershipAuthorityResolver({ canonicalSource: source, credentials: credentials as never, podAccess, issuer: binding.issuer, locator: { find: async() => ({ sourceIri, sourcePodId: 'invite', sourceRoot: podUrl, ownerWebId: owner, binding }), remember: async() => {}, forget: async() => {} } });
  const factory = new CanonicalMembershipSource({ canonicalSource: source, credentials: credentials as never, resolver: named ? namedResolver : resolver,
    podAccess, issuer: binding.issuer });
  const stable = () => graph.getQuads(null, null, null, null).filter(q => q.object.termType !== 'Literal' || !q.object.value.includes('"roomId"'))
    .map(q => `${q.subject.value}|${q.predicate.value}|${q.object.value}`).sort();
  return { factory, source, roomId, actor, joinActor, owner, target, graph, stable, credentials, resolver: named ? namedResolver : resolver, revoke: () => { revoked = true; },
    posts: () => posts, noWrite: () => { noWrite = true; }, loseResponse: () => { lost = true; } };
}

describe('invite source actual public ORM / in-memory RDF CAS (not native HTTP/ACL)', () => {
  it.each(['absent', 'empty'] as const)('preserves unrelated RDF and %s roles through reserve and complete', async roles => {
    const f = await fixture(roles === 'empty' ? {} : undefined); const before = f.stable();
    const port = await f.factory.open(f.roomId, f.actor); const expected = await port.readCurrent();
    expect(Object.isFrozen(expected.facts.participants)).toBe(true);
    const reserved = await port.reserveInvite(expected, { operationId: '$invite', createdAt: 12, targetWebId: f.target });
    expect(reserved.facts.membershipOperation?.expected.memberRoles).toEqual(roles === 'empty' ? {} : null);
    const completed = await port.completeInvite(reserved, '$invite');
    expect(completed.facts.membershipOperation?.phase).toBe('complete'); expect(f.stable()).toEqual(before);
    expect(completed.facts.participants).toEqual([f.owner]); expect(f.credentials.lease).not.toHaveBeenCalled();
  });
  it('rejects fabricated and cross-port evidence before any POST', async() => {
    const f = await fixture(); const one = await f.factory.open(f.roomId, f.actor); const two = await f.factory.open(f.roomId, f.actor);
    const evidence = await one.readCurrent(); const intent = { operationId: '$invite', createdAt: 12, targetWebId: f.target };
    await expect(one.reserveInvite({ facts: structuredClone(evidence.facts) }, intent)).rejects.toMatchObject({ status: 409 });
    await expect(two.reserveInvite(evidence, intent)).rejects.toMatchObject({ status: 409 }); expect(f.posts()).toBe(0);
  });
  it('204 without strict winner readback is rejected', async() => {
    const f = await fixture(); const port = await f.factory.open(f.roomId, f.actor); f.noWrite();
    await expect(port.reserveInvite(await port.readCurrent(), { operationId: '$invite', createdAt: 12, targetWebId: f.target }))
      .rejects.toMatchObject({ status: 409 });
    expect((await port.readCurrent()).facts.membershipOperation).toBeUndefined();
  });
  it('recovers a successful CAS with a lost response via exact readback', async() => {
    const f = await fixture(); const port = await f.factory.open(f.roomId, f.actor); f.loseResponse();
    const result = await port.reserveInvite(await port.readCurrent(), { operationId: '$invite', createdAt: 12, targetWebId: f.target });
    expect(result.facts.membershipOperation?.operationId).toBe('$invite'); expect(f.posts()).toBe(1);
  });
  it('stale evidence cannot replace a concurrent reserved intent', async() => {
    const f = await fixture(); const first = await f.factory.open(f.roomId, f.actor); const second = await f.factory.open(f.roomId, f.actor);
    const old = await second.readCurrent();
    await first.reserveInvite(await first.readCurrent(), { operationId: '$first', createdAt: 12, targetWebId: f.target });
    await expect(second.reserveInvite(old, { operationId: '$second', createdAt: 13, targetWebId: 'https://another.example/#me' }))
      .rejects.toMatchObject({ status: 409 });
    expect((await first.readCurrent()).facts.membershipOperation?.operationId).toBe('$first');
  });
  it('fresh confirmation distinguishes absent and newly present empty roles before projection', async() => {
    const f = await fixture(); const port = await f.factory.open(f.roomId, f.actor);
    const reserved = await port.reserveInvite(await port.readCurrent(), { operationId: '$invite', createdAt: 12, targetWebId: f.target });
    const metadataPredicate = chatResource.getColumn('metadata')!.getPredicate(chatResource.config.namespace);
    const rolesPredicate = `${metadataPredicate.replace(/[^/#]*$/, '')}memberRoles`;
    const metadata = f.graph.getQuads(DataFactory.namedNode(reserved.facts.sourceIri), DataFactory.namedNode(metadataPredicate), null, null)[0].object;
    f.graph.addQuad(DataFactory.quad(metadata as never, DataFactory.namedNode(rolesPredicate),
      DataFactory.literal('{}', DataFactory.namedNode('http://www.w3.org/2001/XMLSchema#json')),
      DataFactory.namedNode(reserved.facts.sourceIri.split('#')[0])));
    await expect(port.confirmOperation(reserved, '$invite')).rejects.toMatchObject({ status: 409 });
    expect(f.posts()).toBe(1);
  });
  it('forged caller and unregistered actor Pod are rejected before source mutation or leases', async() => {
    const f = await fixture();
    await expect(f.factory.open(f.roomId, { ...f.actor, webId: f.target })).rejects.toMatchObject({ status: 403 });
    await expect(f.factory.open(f.roomId, { ...f.actor, podUrl: 'https://foreign.example/pod/' })).rejects.toMatchObject({ status: 403 });
    expect(f.posts()).toBe(0); expect(f.credentials.lease).not.toHaveBeenCalled();
  });
});


describe('join/leave source phase primitives with mandatory actual Read-delta proof', () => {
  const sourceFor = (f: RealFixture) => new CanonicalMembershipSource(f.observationOptions);
  const record = (roomId: string, op: Readonly<MembershipOperation>): MatrixEventRecord => ({
    eventId: op.operationId, roomId, type: 'm.room.member', sender: op.actor.webId,
    originServerTs: op.event.createdAt, stateKey: op.targetWebId, content: { ...op.event.content },
    event: { event_id: op.operationId, room_id: roomId, type: 'm.room.member', sender: op.actor.webId,
      state_key: op.targetWebId, origin_server_ts: op.event.createdAt, content: { ...op.event.content } },
  });
  const prepare = async(f: RealFixture, roles: 'absent' | 'empty'): Promise<void> => {
    await f.reset({ participants: [ f.owner ], roles });
    const lifecycle = new MembershipLifecycle({ source: sourceFor(f), eventId: () => '$prepare', now: () => 10 });
    await lifecycle.invite(f.roomId, f.actor, f.ownerContext, async input => record(input.roomId, input.operation));
    f.requests.length = 0;
  };
  it.each(['absent', 'empty'] as const)('joins then leaves with %s original roles and preserves frozen intention', async mode => {
    await membershipPolicyFixture(async f => {
      const guard = guardedPolicyReplyFor(f);
      await prepare(f, mode);
      const join = await sourceFor(f).openForJoin(f.roomId, f.actorContext);
      const reserved = await join.reserveJoin(await join.readCurrent(), { operationId: '$join', createdAt: 3 });
      expect(reserved.facts.membershipOperation?.expected.memberRoles).toEqual(mode === 'empty' ? {} : null);
      expect(reserved.facts.participants).toEqual(expect.arrayContaining([ f.owner, f.actor ]));
      expect(reserved.facts.memberRoles[f.actor]).toBe('member');
      expect(reserved.facts.membershipInvitations?.[f.actor]).toBeUndefined();
      await expect(join.completeJoin(reserved, '$join')).rejects.toMatchObject({ status: 409 });
      const reopened = await sourceFor(f).openForJoin(f.roomId, f.actorContext);
      const current = await reopened.confirmOperation(await reopened.readCurrent(), '$join');
      const evidence = await applyMembershipReadDelta(f.observationOptions, f.roomId, f.actorContext, { operationId: '$join', kind: 'join' });
      const committed = await reopened.markJoinReadGranted(current, '$join', evidence);
      const complete = await reopened.completeJoin(committed, '$join');
      expect(complete.facts.membershipOperation?.event.createdAt).toBe(3);
      const leave = await sourceFor(f).openForLeave(f.roomId, f.actorContext);
      const pending = await leave.reserveLeave(await leave.readCurrent(), { operationId: '$leave', createdAt: 4 });
      await expect(leave.commitLeaveRoster(pending, '$leave')).rejects.toMatchObject({ status: 409 });
      const removed = await leave.markLeaveReadRemoved(pending, '$leave',
        await applyMembershipReadDelta(f.observationOptions, f.roomId, f.actorContext, { operationId: '$leave', kind: 'leave' }));
      expect(removed.facts.participants).toContain(f.actor);
      const roster = await leave.commitLeaveRoster(removed, '$leave');
      expect(roster.facts.participants).toEqual([ f.owner ]); expect(roster.facts.memberRoles[f.actor]).toBeUndefined();
      expect((await leave.completeLeave(roster, '$leave')).facts.membershipOperation?.phase).toBe('complete');
      expect((await leave.readCurrent()).facts.membershipOperation?.expected.participants).toContain(f.actor);
      expect(guard.posts()).toBeGreaterThan(0);
    });
  });
  it('rejects forged, cross-port, stale phase and revoked lease without extra writes', async() => {
    await membershipPolicyFixture(async f => {
      guardedPolicyReplyFor(f);
      await prepare(f, 'empty');
      const one = await sourceFor(f).openForJoin(f.roomId, f.actorContext);
      const two = await sourceFor(f).openForJoin(f.roomId, f.actorContext); const before = await one.readCurrent();
      await expect(two.reserveJoin(before, { operationId: '$cross', createdAt: 3 })).rejects.toMatchObject({ status: 409 });
      await expect(one.reserveJoin({ facts: before.facts }, { operationId: '$forged', createdAt: 3 })).rejects.toMatchObject({ status: 409 });
      const pending = await one.reserveJoin(before, { operationId: '$join', createdAt: 3 });
      const evidence = await applyMembershipReadDelta(f.observationOptions, f.roomId, f.actorContext, { operationId: '$join', kind: 'join' });
      const committed = await one.markJoinReadGranted(pending, '$join', evidence);
      await one.completeJoin(committed, '$join');
      await expect(one.markJoinReadGranted(pending, '$join', evidence)).rejects.toBeDefined();
      await f.credentials.revoke(f.binding.credentialRef);
      await expect(one.completeJoin(committed, '$join')).rejects.toMatchObject({ status: 403 });
    });
  });
  it.each([undefined, null, false])('rejects malformed named proof %s without caller bootstrap or physical source reads', async malformed => {
    const f = await fixture({}, true);
    const resolve = vi.spyOn(f.resolver, 'resolveForMembership').mockResolvedValue(malformed as never);
    const bootstrap = vi.spyOn(f.resolver, 'readAsCaller');
    const namedRead = vi.spyOn(f.source, 'readNamedSnapshot');
    await expect(f.factory.openForJoin(f.roomId, f.joinActor)).rejects.toMatchObject({ status: 403 });
    expect(resolve).toHaveBeenCalledTimes(1); expect(bootstrap).not.toHaveBeenCalled();
    expect(namedRead).not.toHaveBeenCalled(); expect(f.posts()).toBe(0);
  });
  it('rejects immutable author leave and missing named binding', async() => {
    const f = await fixture({}, true); const port = await f.factory.openForLeave(f.roomId, f.actor);
    await expect(port.reserveLeave(await port.readCurrent(), { operationId: '$leave', createdAt: 4 })).rejects.toMatchObject({ status: 403 });
    expect(f.posts()).toBe(0);
    const noBinding = await fixture();
    await expect(noBinding.factory.openForJoin(noBinding.roomId, noBinding.joinActor)).rejects.toBeDefined(); expect(noBinding.posts()).toBe(0);
  });
  it('rejects an unconfirmed read-mark as 503 and recovers from the committed phase on fresh reopen', async() => {
    await membershipPolicyFixture(async f => {
      await prepare(f, 'empty');
      const port = await sourceFor(f).openForJoin(f.roomId, f.actorContext);
      const pending = await port.reserveJoin(await port.readCurrent(), { operationId: '$join', createdAt: 3 });
      expect(pending.facts.membershipOperation?.phase).toBe('join-read-pending');
      guardedPolicyReplyFor(f, true);
      const evidence = await applyMembershipReadDelta(f.observationOptions, f.roomId, f.actorContext, { operationId: '$join', kind: 'join' });
      await expect(port.markJoinReadGranted(pending, '$join', evidence)).rejects.toMatchObject({ status: 503 });
      const reopened = await sourceFor(f).openForJoin(f.roomId, f.actorContext);
      let state = await reopened.readCurrent();
      expect(state.facts.membershipOperation).toMatchObject({ operationId: '$join', phase: 'committed',
        event: { createdAt: 3 }, expected: { invitation: { id: '$prepare' } } });
      state = await reopened.completeJoin(state, '$join');
      expect(state.facts.membershipOperation?.phase).toBe('complete');
      expect(state.facts.membershipOperation?.event.createdAt).toBe(3);
      expect(state.facts.participants).toEqual(expect.arrayContaining([ f.owner, f.actor ]));
      expect(state.facts.memberRoles[f.actor]).toBe('member');
    });
  });
});
