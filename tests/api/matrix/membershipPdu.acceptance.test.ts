import { describe, expect, it, vi } from 'vitest';
import { DataFactory, type Quad } from 'n3';
import { messageResource } from '@undefineds.co/models';
import type { MembershipInviteProjectEvent } from '../../../src/api/matrix/membershipLifecycle';
import { MatrixError } from '../../../src/api/matrix/MatrixError';
import { membershipPduFixture } from '../../helpers/MembershipPduFixture';

type Fixture = Parameters<Parameters<typeof membershipPduFixture>[0]>[0];
function project(f: Fixture, input: Partial<Parameters<MembershipInviteProjectEvent>[0]> = {}) {
  const store = f.storeFor() as unknown as { projectMembershipInvite: MembershipInviteProjectEvent };
  return store.projectMembershipInvite({ roomId: f.roomId, operation: f.operation, actor: f.actorContext,
    existingOnly: true, validateCommitted: async() => undefined, ...input });
}
function predicate(name: string): string {
  return String((messageResource as any)[name].getPredicate(messageResource.config.namespace));
}
function changeTerm(f: Fixture, name: string, transform: (q: Quad) => Quad): void {
  const quad = f.graph.getQuads(DataFactory.namedNode(f.iriFor()), DataFactory.namedNode(predicate(name)), null, null)[0];
  if (!quad) throw new Error(`Root fixture lacks ${name}`);
  f.graph.removeQuad(quad); f.graph.addQuad(transform(quad));
}
function changeProtocols(f: Fixture, transform: (value: any) => any, datatype?: string): void {
  const quad = f.graph.getQuads(DataFactory.namedNode(`${f.iriFor()}/metadata`), null, null, null)
    .find(q => q.predicate.value.endsWith('protocols'));
  if (!quad || quad.object.termType !== 'Literal') throw new Error('Root fixture protocol missing');
  f.graph.removeQuad(quad); f.graph.addQuad(DataFactory.quad(quad.subject, quad.predicate,
    DataFactory.literal(JSON.stringify(transform(JSON.parse(quad.object.value))), datatype
      ? DataFactory.namedNode(datatype) : quad.object.datatype), quad.graph));
}
function noSideEffects(f: Fixture): void {
  expect(f.requests.filter(r => r.method !== 'GET')).toHaveLength(0);
  expect(f.registerReference).not.toHaveBeenCalled(); expect(f.registerEvents).not.toHaveBeenCalled();
  expect(f.outbound.enqueue).not.toHaveBeenCalled();
}

describe('root independent original actor invitation PDU', () => {
  it('reads Bob original RDF through Alice caller transport without journal or owner-task authority', async() => {
    await membershipPduFixture(async f => {
      await f.seed();
      const validator = vi.fn(async() => undefined);
      const result = await project(f, { actor: f.ownerContext, validateCommitted: validator });
      expect(result.event).toEqual(f.eventFor());
      expect(result.resourceId).toBe(f.iriFor());
      expect(validator).toHaveBeenCalled();
      expect(f.podAccess.getPodFetch).toHaveBeenCalledWith(f.owner, expect.objectContaining({ podBaseUrl: f.ownerPod,
        auth: expect.objectContaining({ webId: f.owner }) }));
      expect(f.requests).toEqual([{ url: f.iriFor().split('#')[0], method: 'GET', principal: f.owner }]);
      noSideEffects(f);
    });
  });

  it('retains complete first body and parents after a next-day head and reopened store', async() => {
    await membershipPduFixture(async f => {
      await f.seed();
      const first = await project(f);
      const laterOperation = { ...f.operation, operationId: '$root-later-head',
        event: { ...f.operation.event, createdAt: f.operation.event.createdAt + 2000 } };
      await f.seed(laterOperation, { ...f.eventFor(laterOperation), prev_events: [f.operation.operationId], depth: 8 });
      const second = await project(f, { actor: { ...f.actorContext } });
      expect(second.event).toEqual(first.event); expect(second.originServerTs).toBe(f.operation.event.createdAt);
      expect(second.resourceId).toBe(first.resourceId); noSideEffects(f);
    });
  });

  it.each([
    ['wrong RDF maker', (f: Fixture) => changeTerm(f, 'maker', q => DataFactory.quad(q.subject, q.predicate, DataFactory.namedNode(f.owner), q.graph))],
    ['missing protocol author', (f: Fixture) => changeProtocols(f, value => { delete value.matrix.senderWebId; return value; })],
    ['wrong protocol author', (f: Fixture) => changeProtocols(f, value => { value.matrix.senderWebId = f.owner; return value; })],
    ['string protocol datatype', (f: Fixture) => changeProtocols(f, value => value, 'http://www.w3.org/2001/XMLSchema#string')],
    ['wrong target state key', (f: Fixture) => changeProtocols(f, value => { value.matrix.event.state_key = f.owner; return value; })],
    ['absent state key', (f: Fixture) => changeProtocols(f, value => { delete value.matrix.event.state_key; return value; })],
    ['different event timestamp', (f: Fixture) => changeProtocols(f, value => { value.matrix.event.origin_server_ts++; return value; })],
    ['wrong metadata subject', (f: Fixture) => changeTerm(f, 'metadata', q => DataFactory.quad(q.subject, q.predicate, DataFactory.namedNode(`${f.iriFor()}/foreign`), q.graph))],
    ['duplicate protected maker', (f: Fixture) => { const q = f.graph.getQuads(DataFactory.namedNode(f.iriFor()), DataFactory.namedNode(predicate('maker')), null, null)[0];
      f.graph.addQuad(DataFactory.quad(q.subject, q.predicate, DataFactory.namedNode(f.owner), q.graph)); }],
  ] as const)('rejects %s despite matching JSON intent without bookkeeping', async(_name, mutate) => {
    await membershipPduFixture(async f => {
      await f.seed(); mutate(f);
      await expect(project(f)).rejects.toMatchObject({ status: 409 }); noSideEffects(f);
    });
  });

  it.each([
    ['private', { status: 403 }], ['missing', { status: 404 }], ['empty successful body', { status: 200, body: '' }],
    ['malformed successful RDF', { status: 200, body: 'not turtle <' }], ['lost GET response', { status: 200, drop: true }],
  ] as const)('existingOnly %s never appends or creates references', async(_name, override) => {
    await membershipPduFixture(async f => {
      f.responses.set(f.iriFor().split('#')[0], override);
      await expect(project(f, { actor: f.ownerContext })).rejects.toMatchObject({ status: override.status === 403 || 'drop' in override ? 403 : 409 }); noSideEffects(f);
    });
  });

  it('refuses a redirect before fetching another document', async() => {
    await membershipPduFixture(async f => {
      f.responses.set(f.iriFor().split('#')[0], { status: 302, location: `${f.ownerPod}foreign.ttl` });
      await expect(project(f, { actor: f.ownerContext })).rejects.toMatchObject({ status: 403 });
      expect(f.requests).toHaveLength(1); noSideEffects(f);
    });
  });

  it('does not reuse injected database/fetch/memo from the caller', async() => {
    await membershipPduFixture(async f => {
      await f.seed();
      const hostile = vi.fn(async() => { throw new Error('Injected authority must not be used'); });
      const caller: any = { ...f.ownerContext, _matrixDb: { init: hostile }, _matrixPodFetch: hostile };
      caller[Symbol.for('xpod.matrix.podWrite')] = { db: { init: hostile }, fetch: hostile };
      expect((await project(f, { actor: caller })).event).toEqual(f.eventFor());
      expect(hostile).not.toHaveBeenCalled(); noSideEffects(f);
    });
  });

  it('does not journal even a valid winner after current validator rejection', async() => {
    await membershipPduFixture(async f => {
      await f.seed();
      await expect(project(f, { validateCommitted: async() => { throw Object.assign(new Error('Current operation changed'), { status: 409 }); } }))
        .rejects.toMatchObject({ status: 409 }); noSideEffects(f);
    });
  });

  it('normal original actor recovery validates the first winner before a single reference and never queues', async() => {
    await membershipPduFixture(async f => {
      await f.seed();
      const validateCommitted = vi.fn(async() => { expect(f.registerReference).not.toHaveBeenCalled(); });
      const result = await project(f, { existingOnly: false, validateCommitted });
      expect(result.event).toEqual(f.eventFor()); expect(result.resourceId).toBe(f.iriFor());
      expect(validateCommitted).toHaveBeenCalledOnce(); expect(f.registerReference).toHaveBeenCalledOnce();
      expect(f.registerEvents).not.toHaveBeenCalled(); expect(f.outbound.enqueue).not.toHaveBeenCalled();
      expect(f.requests).toEqual([{ url: f.iriFor().split('#')[0], method: 'GET', principal: f.actor }]);
    });
  });

  it('normal recovery rejects a changed current operation before registering an existing winner', async() => {
    await membershipPduFixture(async f => {
      await f.seed();
      await expect(project(f, { existingOnly: false, validateCommitted: async() => {
        throw Object.assign(new Error('Authority changed'), { status: 409 });
      } })).rejects.toMatchObject({ status: 409 }); noSideEffects(f);
    });
  });

  it('missing local Chat anchor never turns a zero-row acknowledgement into a winner or journal', async() => {
    await membershipPduFixture(async f => {
      await expect(project(f, { existingOnly: false })).rejects.toMatchObject({ status: 503 });
      expect(f.graph.getQuads(DataFactory.namedNode(f.iriFor()), null, null, null)).toHaveLength(0);
      expect(f.registerReference).not.toHaveBeenCalled(); expect(f.registerEvents).not.toHaveBeenCalled();
      expect(f.outbound.enqueue).not.toHaveBeenCalled();
    });
  });

  it('first original actor persistence uses public ORM and real conditional RDF update without generic queue', async() => {
    await membershipPduFixture(async f => {
      f.seedAnchor();
      const result = await project(f, { existingOnly: false });
      expect(result.resourceId).toBe(f.iriFor());
      expect(result.event).toMatchObject({ event_id: f.operation.operationId, origin_server_ts: f.operation.event.createdAt,
        sender: f.actor, state_key: f.target, content: { membership: 'invite' } });
      expect(f.graph.getQuads(DataFactory.namedNode(f.iriFor()), DataFactory.namedNode(predicate('maker')), null, null))
        .toHaveLength(1);
      expect(f.requests.some(r => r.method === 'POST')).toBe(true);
      expect(f.requests.every(r => r.principal === f.actor)).toBe(true);
      expect(f.registerReference).toHaveBeenCalledOnce(); expect(f.registerEvents).not.toHaveBeenCalled();
      expect(f.outbound.enqueue).not.toHaveBeenCalled();
    });
  });

  it('a partial 206 daily document does not prove absence or permit append', async() => {
    await membershipPduFixture(async f => {
      f.seedAnchor();
      f.responses.set(f.iriFor().split('#')[0], { status: 206, body: '<urn:unrelated> <urn:value> "partial" .' });
      await expect(project(f, { existingOnly: false })).rejects.toBeInstanceOf(MatrixError);
      expect(f.requests.filter(r => r.method === 'POST')).toHaveLength(0);
      expect(f.registerReference).not.toHaveBeenCalled(); expect(f.registerEvents).not.toHaveBeenCalled();
      expect(f.outbound.enqueue).not.toHaveBeenCalled();
    });
  });

  it('lost conditional response adopts the exact first persisted body and reopened recovery retains it', async() => {
    await membershipPduFixture(async f => {
      f.seedAnchor();
      // The body commits, then the source socket closes before sending its acknowledgement.
      f.losePostResponse(true);
      const first = await project(f, { existingOnly: false });
      f.losePostResponse(false);
      const before = f.requests.filter(r => r.method === 'POST').length;
      const second = await project(f, { existingOnly: false, actor: { ...f.actorContext } });
      expect(second.event).toEqual(first.event); expect(second.resourceId).toBe(first.resourceId);
      expect(f.requests.filter(r => r.method === 'POST')).toHaveLength(before);
      expect(f.outbound.enqueue).not.toHaveBeenCalled(); expect(f.registerEvents).not.toHaveBeenCalled();
    });
  });

  it('adopts the strict first full body when another HTTP writer wins after absence was observed', async() => {
    await membershipPduFixture(async f => {
      f.seedAnchor();
      const firstBody = { ...f.eventFor(), prev_events: ['$root-competing-head'], depth: 11 };
      f.beforePost(async() => { f.beforePost(); await f.seed(f.operation, firstBody, true); });
      const result = await project(f, { existingOnly: false });
      expect(f.requests.filter(r => r.method === 'POST')).toHaveLength(2);
      expect(result.event).toEqual(firstBody); expect(result.resourceId).toBe(f.iriFor());
      expect(f.registerReference).toHaveBeenCalledOnce(); expect(f.registerEvents).not.toHaveBeenCalled();
      expect(f.outbound.enqueue).not.toHaveBeenCalled();
      expect(f.graph.getQuads(DataFactory.namedNode(f.iriFor()), DataFactory.namedNode(predicate('maker')), null, null)).toHaveLength(1);
    });
  });

  it('refuses normal recovery by another actor before network or journal', async() => {
    await membershipPduFixture(async f => {
      await f.seed();
      await expect(project(f, { actor: f.ownerContext, existingOnly: false })).rejects.toMatchObject({ status: 403 });
      expect(f.requests).toHaveLength(0); noSideEffects(f);
    });
  });

  it('rejects ambiguous historical actor Pod registration before any GET', async() => {
    await membershipPduFixture(async f => {
      f.pods.push({ podId: 'root-duplicate-bob', baseUrl: f.actorPod, webId: f.actor });
      await expect(project(f, { actor: f.ownerContext })).rejects.toMatchObject({ status: 403 });
      expect(f.requests).toHaveLength(0); noSideEffects(f);
    });
  });

  it.each(['forged auth', 'service grant'] as const)('rejects %s instead of borrowing deployment authority', async mode => {
    await membershipPduFixture(async f => {
      const caller = mode === 'forged auth' ? { ...f.ownerContext, auth: f.actorContext.auth }
        : { ...f.ownerContext, service: { taskCredential: { credentialRef: 'root-forbidden', version: 1 } } };
      await expect(project(f, { actor: caller })).rejects.toMatchObject({ status: 403 });
      expect(f.requests).toHaveLength(0); noSideEffects(f);
    });
  });
});
