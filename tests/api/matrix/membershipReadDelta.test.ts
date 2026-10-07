import { describe, expect, it } from 'vitest';
import { DataFactory, Parser, Store } from 'n3';
import { CanonicalMembershipSource } from '../../../src/api/matrix/canonicalMembershipSource';
import { applyMembershipReadDelta } from '../../../src/api/matrix/membershipPolicyMutation';
import { membershipPolicyFixture } from '../../helpers/MembershipPolicyFixture';

// Unit scope: guarded actual room policy delta through counted loopback HTTP/public ORM RDF,
// not real CSS WAC enforcement or DPoP. The policy reply is updated by the guarded POST handler.
const ACL = 'http://www.w3.org/ns/auth/acl#';
const RDF = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#';

function serialize(store: Store, graph: string): string {
  return store.getQuads(null, null, null, DataFactory.namedNode(graph))
    .map(quad => `<${quad.subject.value}> <${quad.predicate.value}> <${quad.object.value}> .`).join('\n');
}
function seed(f: { policyFor: (resource: string) => string; replies: Map<string, { body?: string }> }, iri: string): Store {
  const store = new Store();
  const body = f.replies.get(`GET ${iri}`)?.body ?? '';
  if (body) for (const quad of new Parser({ baseIRI: iri, format: 'Turtle' }).parse(body)) {
    store.addQuad(DataFactory.quad(quad.subject, quad.predicate, quad.object, DataFactory.namedNode(iri)));
  }
  return store;
}

type Fixture = Parameters<Parameters<typeof membershipPolicyFixture>[0]>[0];
const GUARDED = 'application/vnd.xpod.guarded-sparql-update+json';
function guardPolicyReply(f: Fixture): void {
  const store = seed(f, f.roomPolicy);
  f.onGuardedPost(async(request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = Buffer.concat(chunks).toString();
    // Plain source phase CAS still travels through the same endpoint.
    if (request.headers['content-type'] !== GUARDED) {
      await f.engine.queryVoid(body, { sources: [ f.graph ], destination: f.graph });
      response.writeHead(204); response.end(); return;
    }
    const envelope = JSON.parse(body) as { update: string };
    // The canonical phase CAS carries the source graph, not the policy write graph.
    if (!envelope.update.includes(`GRAPH <${f.roomPolicy}>`)) {
      await f.engine.queryVoid(envelope.update, { sources: [ f.graph ], destination: f.graph });
      response.writeHead(204); response.end(); return;
    }
    // The real ACL delta names its policy write graph and fences the real source graph.
    const live = new Store([ ...f.graph.getQuads(null, null, null, null), ...store.getQuads(null, null, null, null) ]);
    await f.engine.queryVoid(envelope.update, { sources: [ live ], destination: live });
    store.removeQuads(store.getQuads(null, null, null, null));
    store.addQuads(live.getQuads(null, null, null, DataFactory.namedNode(f.roomPolicy)));
    f.set('GET', f.roomPolicy, { status: 200, body: serialize(store, f.roomPolicy) });
    response.writeHead(204); response.end();
  });
}
const sourceFor = (f: Fixture) => new CanonicalMembershipSource(f.observationOptions);

describe('bounded actual room Read delta with mandatory post-delta evidence', () => {
  it('joins by adding a direct room grant, proving Read everywhere and committing the phase', async() => {
    await membershipPolicyFixture(async f => {
      guardPolicyReply(f);
      const port = await sourceFor(f).openForJoin(f.roomId, f.actorContext);
      const pending = await port.reserveJoin(await port.readCurrent(), { operationId: '$join', createdAt: 20 });
      const evidence = await applyMembershipReadDelta(f.observationOptions, f.roomId, f.actorContext,
        { operationId: '$join', kind: 'join' });
      const committed = await port.markJoinReadGranted(pending, '$join', evidence);
      expect(committed.facts.membershipOperation?.phase).toBe('committed');
      expect((await port.completeJoin(committed, '$join')).facts.membershipOperation?.phase).toBe('complete');
    });
  });

  it('leaves by removing only the operation-owned grant and proving no residual Read', async() => {
    await membershipPolicyFixture(async f => {
      guardPolicyReply(f);
      const join = await sourceFor(f).openForJoin(f.roomId, f.actorContext);
      const pendingJoin = await join.reserveJoin(await join.readCurrent(), { operationId: '$join', createdAt: 20 });
      const joinEvidence = await applyMembershipReadDelta(f.observationOptions, f.roomId, f.actorContext,
        { operationId: '$join', kind: 'join' });
      await join.completeJoin(await join.markJoinReadGranted(pendingJoin, '$join', joinEvidence), '$join');
      const leave = await sourceFor(f).openForLeave(f.roomId, f.actorContext);
      const pendingLeave = await leave.reserveLeave(await leave.readCurrent(), { operationId: '$leave', createdAt: 40 });
      const leaveEvidence = await applyMembershipReadDelta(f.observationOptions, f.roomId, f.actorContext,
        { operationId: '$leave', kind: 'leave' });
      const removed = await leave.markLeaveReadRemoved(pendingLeave, '$leave', leaveEvidence);
      expect(removed.facts.participants).toContain(f.actor);
      expect((await leave.commitLeaveRoster(removed, '$leave')).facts.participants).toEqual([ f.owner ]);
    });
  });

  it('creates the first direct room ACL by preserving inherited owner and public rights', async() => {
    await membershipPolicyFixture(async f => {
      const ancestor = new URL('../', f.room).href;
      const ancestorPolicy = f.policyFor(ancestor);
      const node = `${ancestorPolicy}#owner`;
      const pub = `${ancestorPolicy}#public`;
      const body = [
        `<${node}> <${RDF}type> <${ACL}Authorization> . <${node}> <${ACL}accessTo> <${ancestor}> .`,
        `<${node}> <${ACL}default> <${ancestor}> . <${node}> <${ACL}mode> <${ACL}Read> .`,
        `<${node}> <${ACL}mode> <${ACL}Write> . <${node}> <${ACL}mode> <${ACL}Control> .`,
        `<${node}> <${ACL}agent> <${f.owner}> .`,
        `<${pub}> <${RDF}type> <${ACL}Authorization> . <${pub}> <${ACL}default> <${ancestor}> .`,
        `<${pub}> <${ACL}agentClass> <http://xmlns.com/foaf/0.1/Agent> . <${pub}> <${ACL}mode> <${ACL}Read> .`,
      ].join('\n');
      f.set('GET', f.roomPolicy, { status: 404 });
      f.set('GET', ancestorPolicy, { status: 200, body });
      const store = seed(f, ancestorPolicy);
      f.onGuardedPost(async(request, response) => {
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(Buffer.from(chunk));
        const raw = Buffer.concat(chunks).toString();
        if (request.headers['content-type'] !== GUARDED) {
          await f.engine.queryVoid(raw, { sources: [ f.graph ], destination: f.graph });
          response.writeHead(204); response.end(); return;
        }
        const envelope = JSON.parse(raw) as { update: string };
        if (!envelope.update.includes(`GRAPH <${f.roomPolicy}>`)) {
          await f.engine.queryVoid(envelope.update, { sources: [ f.graph ], destination: f.graph });
          response.writeHead(204); response.end(); return;
        }
        const live = new Store([ ...f.graph.getQuads(null, null, null, null), ...store.getQuads(null, null, null, null) ]);
        await f.engine.queryVoid(envelope.update, { sources: [ live ], destination: live });
        store.removeQuads(store.getQuads(null, null, null, null));
        store.addQuads(live.getQuads(null, null, null, DataFactory.namedNode(f.roomPolicy)));
        f.set('GET', f.roomPolicy, { status: 200, body: serialize(store, f.roomPolicy) });
        response.writeHead(204); response.end();
      });
      const port = await sourceFor(f).openForJoin(f.roomId, f.actorContext);
      const pending = await port.reserveJoin(await port.readCurrent(), { operationId: '$join', createdAt: 20 });
      const evidence = await applyMembershipReadDelta(f.observationOptions, f.roomId, f.actorContext,
        { operationId: '$join', kind: 'join' });
      await port.markJoinReadGranted(pending, '$join', evidence);
      const created = new Parser({ baseIRI: f.roomPolicy, format: 'Turtle' })
        .parse(f.replies.get(`GET ${f.roomPolicy}`)!.body ?? '');
      const agents = created.filter(q => q.predicate.value === `${ACL}agent`).map(q => q.object.value);
      const classes = created.filter(q => q.predicate.value === `${ACL}agentClass`).map(q => q.object.value);
      expect(agents).toContain(f.owner);
      expect(classes).toContain('http://xmlns.com/foaf/0.1/Agent');
      expect(created.some(q => q.predicate.value === `${ACL}mode` && q.object.value === `${ACL}Control`)).toBe(true);
    });
  });

  it('keeps leave pending when a residual public grant still allows Read', async() => {
    await membershipPolicyFixture(async f => {
      const owner = `${f.roomPolicy}#owner`;
      const publicRule = `${f.roomPolicy}#public`;
      f.set('GET', f.roomPolicy, { status: 200, body: [
        `<${owner}> <${RDF}type> <${ACL}Authorization> . <${owner}> <${ACL}accessTo> <${f.room}> .`,
        `<${owner}> <${ACL}default> <${f.room}> . <${owner}> <${ACL}mode> <${ACL}Read> . <${owner}> <${ACL}agent> <${f.owner}> .`,
        `<${publicRule}> <${RDF}type> <${ACL}Authorization> . <${publicRule}> <${ACL}accessTo> <${f.room}> .`,
        `<${publicRule}> <${ACL}default> <${f.room}> . <${publicRule}> <${ACL}agentClass> <http://xmlns.com/foaf/0.1/Agent> .`,
        `<${publicRule}> <${ACL}mode> <${ACL}Read> .`,
      ].join('\n') });
      guardPolicyReply(f);
      const join = await sourceFor(f).openForJoin(f.roomId, f.actorContext);
      const pendingJoin = await join.reserveJoin(await join.readCurrent(), { operationId: '$join', createdAt: 20 });
      const joinEvidence = await applyMembershipReadDelta(f.observationOptions, f.roomId, f.actorContext,
        { operationId: '$join', kind: 'join' });
      await join.completeJoin(await join.markJoinReadGranted(pendingJoin, '$join', joinEvidence), '$join');
      const leave = await sourceFor(f).openForLeave(f.roomId, f.actorContext);
      const pendingLeave = await leave.reserveLeave(await leave.readCurrent(), { operationId: '$leave', createdAt: 40 });
      await expect(applyMembershipReadDelta(f.observationOptions, f.roomId, f.actorContext,
        { operationId: '$leave', kind: 'leave' })).rejects.toMatchObject({ status: 409 });
      expect(pendingLeave.facts.membershipOperation?.phase).toBe('leave-read-pending');
    });
  });

  it('rejects a plain phase bypass without post-delta evidence', async() => {
    await membershipPolicyFixture(async f => {
      const port = await sourceFor(f).openForJoin(f.roomId, f.actorContext);
      const pending = await port.reserveJoin(await port.readCurrent(), { operationId: '$join', createdAt: 20 });
      await expect(port.markJoinReadGranted(pending, '$join', {})).rejects.toMatchObject({ status: 409 });
    });
  });

  it('does not treat an HTTP204 without the exact write as a receipt and keeps the operation pending', async() => {
    await membershipPolicyFixture(async f => {
      const port = await sourceFor(f).openForJoin(f.roomId, f.actorContext);
      const pending = await port.reserveJoin(await port.readCurrent(), { operationId: '$join', createdAt: 20 });
      f.onGuardedPost(async(request, response) => {
        for await (const _chunk of request) { /* drain */ }
        response.writeHead(204); response.end();
      });
      await expect(applyMembershipReadDelta(f.observationOptions, f.roomId, f.actorContext,
        { operationId: '$join', kind: 'join' })).rejects.toMatchObject({ status: 503 });
      expect((await port.readCurrent()).facts.membershipOperation?.phase).toBe('join-read-pending');
    });
  });

  it('treats an unknown guarded result as unavailable and never as a source receipt', async() => {
    await membershipPolicyFixture(async f => {
      const port = await sourceFor(f).openForJoin(f.roomId, f.actorContext);
      const pending = await port.reserveJoin(await port.readCurrent(), { operationId: '$join', createdAt: 20 });
      f.onGuardedPost(async(request, response) => {
        for await (const _chunk of request) { /* drain */ }
        response.writeHead(503); response.end();
      });
      await expect(applyMembershipReadDelta(f.observationOptions, f.roomId, f.actorContext,
        { operationId: '$join', kind: 'join' })).rejects.toMatchObject({ status: 503 });
      expect(pending.facts.membershipOperation?.phase).toBe('join-read-pending');
    });
  });
});
