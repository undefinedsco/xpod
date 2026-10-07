// Root policy-write regression: actual HTTP + native SPARQL evaluation over named
// canonical/policy graphs. CSS authorization/locks and Gateway are separate gates.
import { describe, expect, it } from 'vitest';
import { DataFactory, Parser, Store, Writer } from 'n3';
import { CanonicalMembershipSource } from '../../../src/api/matrix/canonicalMembershipSource';
import { applyMembershipReadDelta } from '../../../src/api/matrix/membershipPolicyMutation';
import { membershipPolicyFixture } from '../../helpers/MembershipPolicyFixture';

type Fixture = Parameters<Parameters<typeof membershipPolicyFixture>[0]>[0];
const ACL = 'http://www.w3.org/ns/auth/acl#';
const media = 'application/vnd.xpod.guarded-sparql-update+json';
async function pending(f: Fixture): Promise<void> {
  const port = await new CanonicalMembershipSource(f.observationOptions).openForJoin(f.roomId, f.actorContext);
  await port.reserveJoin(await port.readCurrent(), { operationId: '$root-delta-join', createdAt: 20 });
}
function nativePolicyHandler(f: Fixture, before: () => void = () => {}, after: () => void = () => {}): void {
  const policy = new Store(new Parser({ baseIRI: f.roomPolicy }).parse(f.replies.get(`GET ${f.roomPolicy}`)?.body ?? '')
    .map(q => DataFactory.quad(q.subject, q.predicate, q.object, DataFactory.namedNode(f.roomPolicy))));
  f.onGuardedPost(async (request, response) => {
    expect(request.headers['content-type']).toBe(media);
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const envelope = JSON.parse(Buffer.concat(chunks).toString()) as { update: string };
    before();
    const live = new Store([...f.graph.getQuads(null, null, null, null), ...policy.getQuads(null, null, null, null)]);
    await f.engine.queryVoid(envelope.update, { sources: [live], destination: live });
    const quads = live.getQuads(null, null, null, DataFactory.namedNode(f.roomPolicy));
    policy.removeQuads(policy.getQuads(null, null, null, null)); policy.addQuads(quads);
    const writer = new Writer(); writer.addQuads(quads.map(q => DataFactory.quad(q.subject, q.predicate, q.object)));
    const body = await new Promise<string>((resolve, reject) => writer.end((error, text) => error ? reject(error) : resolve(text)));
    f.set('GET', f.roomPolicy, { status: 200, body });
    after(); response.writeHead(204); response.end();
  });
}

describe('root membership ACL write source fence and physical deadline', () => {
  it.each(['operation', 'extra raw quad'] as const)('has no ACL effects when canonical %s changes after preflight and before execution', async changed => {
    await membershipPolicyFixture(async f => {
      await pending(f);
      nativePolicyHandler(f, () => {
        const old = f.graph.getQuads(null, null, null, null).find(q => q.predicate.value.endsWith('protocols'))!;
        if (changed === 'extra raw quad') {
          f.graph.addQuad(DataFactory.quad(old.subject, DataFactory.namedNode('urn:root:late-source-property'),
            DataFactory.literal('late'), old.graph));
          return;
        }
        if (old.object.termType !== 'Literal') throw new Error('Fixture protocols must be JSON');
        const value = JSON.parse(old.object.value);
        value.matrix.membershipOperation.operationId = '$root-new-operation';
        f.graph.removeQuad(old);
        f.graph.addQuad(DataFactory.quad(old.subject, old.predicate,
          DataFactory.literal(JSON.stringify(value), old.object.datatype), old.graph));
      });
      let error: unknown;
      try { await applyMembershipReadDelta(f.observationOptions, f.roomId, f.actorContext,
        { kind: 'join', operationId: '$root-delta-join' }); } catch (caught) { error = caught; }
      const body = f.replies.get(`GET ${f.roomPolicy}`)?.body ?? '';
      expect(new Parser({ baseIRI: f.roomPolicy }).parse(body)
        .some(q => q.predicate.value === `${ACL}agent` && q.object.value === f.actor)).toBe(false);
      expect(error).toBeDefined();
    });
  });

  it.each([500, 1500])('cancels a stalled post-write policy body within the trusted %ims physical deadline', async physicalMs => {
    await membershipPolicyFixture(async f => {
      await pending(f);
      let bodyStarted = 0;
      nativePolicyHandler(f, undefined, () => {
        f.set('GET', f.roomPolicy, { status: 200, stall: 'body', releaseAfterMs: physicalMs + 300,
          before: () => { bodyStarted = performance.now(); } });
      });
      const options = { ...f.observationOptions, limits: { requestTimeoutMs: physicalMs } };
      let error: unknown;
      try { await applyMembershipReadDelta(options, f.roomId, f.actorContext,
        { kind: 'join', operationId: '$root-delta-join' }); } catch (caught) { error = caught; }
      const elapsed = performance.now() - bodyStarted;
      expect(bodyStarted).toBeGreaterThan(0);
      expect(error).toMatchObject({ status: 503 });
      expect(elapsed).toBeLessThan(physicalMs + 250);
      expect(f.closedStalls).toContain(f.roomPolicy);
    });
  });
  it('rejects an oversized readback before a later small postflight can hide it', async () => {
    await membershipPolicyFixture(async f => {
      await pending(f);
      nativePolicyHandler(f, undefined, () => {
        const valid = f.replies.get(`GET ${f.roomPolicy}`)?.body ?? '';
        f.set('GET', f.roomPolicy, { status: 200, body: valid + '\n#' + 'x'.repeat(128 * 1024),
          before: () => f.set('GET', f.roomPolicy, { status: 200, body: valid }) });
      });
      await expect(applyMembershipReadDelta({ ...f.observationOptions, limits: { bytes: 64 * 1024 } },
        f.roomId, f.actorContext, { kind: 'join', operationId: '$root-delta-join' }))
        .rejects.toMatchObject({ status: 503 });
    });
  });

  it.each(['status', 'media'] as const)('rejects readback with invalid %s despite matching grant RDF', async changed => {
    await membershipPolicyFixture(async f => {
      await pending(f);
      nativePolicyHandler(f, undefined, () => {
        const valid = f.replies.get(`GET ${f.roomPolicy}`)?.body ?? '';
        f.set('GET', f.roomPolicy, { status: changed === 'status' ? 404 : 200, body: valid,
          type: changed === 'media' ? 'application/json' : 'text/turtle',
          before: () => f.set('GET', f.roomPolicy, { status: 200, body: valid }) });
      });
      await expect(applyMembershipReadDelta(f.observationOptions, f.roomId, f.actorContext,
        { kind: 'join', operationId: '$root-delta-join' })).rejects.toMatchObject({ status: 503 });
    });
  });

});
