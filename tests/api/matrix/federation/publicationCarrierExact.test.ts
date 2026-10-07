import { describe, expect, it } from 'vitest';
import { drizzle } from '@undefineds.co/drizzle-solid';
import { taskResource } from '@undefineds.co/models';
import { QueryEngine } from '@comunica/query-sparql';
import { DataFactory, Store, Writer } from 'n3';
import { controlRecordAddress, deletePublicationControlRecordExactly, transitionPublicationControlRecordExactly, readControlRecord } from '../../../../src/api/matrix/controlRecords';
import { encodeOutboundBatch } from '../../../../src/api/matrix/federation/outboundBatches';
import type { MatrixStoreContext } from '../../../../src/api/matrix/types';

async function carrier() {
  const scope = 'https://pod.example/publication-carrier/';
  const owner = `${scope}profile/card#me`;
  const caller: MatrixStoreContext = { webId: owner, podUrl: scope,
    auth: { type: 'solid', webId: owner, accessToken: 'fixture', tokenType: 'Bearer' } };
  const at = Date.parse('2026-10-03T00:00:00Z');
  const address = controlRecordAddress(scope, 'outbound', 'fixture-key', '2026/10/03');
  const batch = { txnId: 'fixture-txn', origin: 'pod.example', destination: 'peer.example', createdAt: at, attempts: 0,
    edus: [], pdus: [ { event_id: '$fixture', type: 'co.undefineds.membership.authority', state_key: '', sender: owner,
      content: { purpose: 'membership', credentialRef: 'taskcred_fixture', version: 1, issuer: 'https://issuer.example/' } } ],
    actor: { webId: owner, podUrl: scope, taskCredential: { purpose: 'membership' as const,
      credentialRef: 'taskcred_fixture', version: 1, issuer: 'https://issuer.example/' } } };
  const graph = new Store();
  const engine = new QueryEngine();
  let beforePost: (() => void) | undefined;
  let loseResponse = false;
  let acceptOnly = false;
  const transport: typeof fetch = async(input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    if (init?.method === 'POST') {
      beforePost?.(); beforePost = undefined;
      if (!acceptOnly) await engine.queryVoid(String(init.body), { sources: [ graph ], destination: graph });
      if (loseResponse) throw new Error('Fixture lost DELETE response');
      return new Response(null, { status: 204 });
    }
    expect(url.startsWith(`${scope}.data/task/2026/10/03/`)).toBe(true);
    const writer = new Writer();
    writer.addQuads(graph.getQuads(null, null, null, DataFactory.namedNode(url)).map(q => DataFactory.quad(q.subject, q.predicate, q.object)));
    const ttl = await new Promise<string>((resolve, reject) => writer.end((error, body) => error ? reject(error) : resolve(body)));
    const response = new Response(ttl, { headers: { 'Content-Type': 'text/turtle' } });
    Object.defineProperty(response, 'url', { value: url });
    return response;
  };
  const db = drizzle({ fetch: transport, info: { webId: owner, podUrl: scope, isLoggedIn: true } } as never,
    { podUrl: scope, resourcePreparation: 'off', disableInteropDiscovery: true });
  const encoded = encodeOutboundBatch(batch);
  await engine.queryVoid(db.insert(taskResource).values({ id: address.id, instruction: encoded.instruction,
    workspace: scope, status: encoded.status, metadata: encoded.metadata,
    createdAt: new Date(at), updatedAt: new Date(at),
  } as never).toSPARQL().query, { sources: [ graph ], destination: graph });
  const sentinel = DataFactory.quad(DataFactory.namedNode(`${address.resource}#other`),
    DataFactory.namedNode('https://example.test/untouched'), DataFactory.literal('preserve'), DataFactory.namedNode(address.resource));
  graph.addQuad(sentinel);
  const target = { scope, write: { db, fetch: transport } };
  const record = await readControlRecord(target, 'outbound', 'fixture-key', { at, days: 0 });
  if (!record) throw new Error('Actual public ORM fixture did not read the control record');
  return { caller, target, record, graph, sentinel, address, batch,
    race: () => { beforePost = () => graph.addQuad(DataFactory.quad(DataFactory.namedNode(address.subject),
      DataFactory.namedNode('https://example.test/concurrent'), DataFactory.literal('preserve'), DataFactory.namedNode(address.resource))); },
    removeBeforePost: () => { beforePost = () => graph.removeQuads(graph.getQuads(DataFactory.namedNode(address.subject), null, null, null)); },
    lose: () => { loseResponse = true; }, acceptWithoutDelete: () => { acceptOnly = true; } };
}

describe('publication exact-delete public ORM and raw RDF adapter', () => {
  it('deletes only the unchanged target root and preserves unrelated RDF', async() => {
    const fixture = await carrier();
    await deletePublicationControlRecordExactly(fixture.target, fixture.record, fixture.caller);
    expect(fixture.graph.getQuads(DataFactory.namedNode(fixture.address.subject), null, null, null)).toHaveLength(0);
    expect(fixture.graph.has(fixture.sentinel)).toBe(true);
  });

  it('refuses a concurrent extra root fact with an exact raw !sameTerm guard', async() => {
    const fixture = await carrier(); fixture.race();
    await expect(deletePublicationControlRecordExactly(fixture.target, fixture.record, fixture.caller)).rejects.toMatchObject({ status: 409 });
    expect(fixture.graph.getQuads(DataFactory.namedNode(fixture.address.subject), null, null, null).length).toBeGreaterThan(0);
    expect(fixture.graph.has(fixture.sentinel)).toBe(true);
  });

  it('confirms deletion after a lost response without deleting any other root', async() => {
    const fixture = await carrier(); fixture.lose();
    await deletePublicationControlRecordExactly(fixture.target, fixture.record, fixture.caller);
    expect(fixture.graph.has(fixture.sentinel)).toBe(true);
    expect(fixture.graph.getQuads(DataFactory.namedNode(fixture.address.subject), null, null, null)).toHaveLength(0);
  });

  it('does not accept 204 when the exact record is still present', async() => {
    const fixture = await carrier(); fixture.acceptWithoutDelete();
    await expect(deletePublicationControlRecordExactly(fixture.target, fixture.record, fixture.caller)).rejects.toMatchObject({ status: 409 });
  });
});


describe('publication conditional delivery transition', () => {
  it('updates deferred bookkeeping only while the exact old record exists', async() => {
    const f = await carrier();
    const next = { ...f.batch, attempts: 1, lastReason: '503' };
    expect(await transitionPublicationControlRecordExactly(f.target, f.record, {
      kind: 'outbound', key: f.record.key, at: f.batch.createdAt, ...encodeOutboundBatch(next),
    }, f.caller)).toBe(true);
    const row = await readControlRecord(f.target, 'outbound', f.record.key, { at: f.batch.createdAt, days: 0 });
    expect(row?.metadata.attempts).toBe(1);
    expect(f.graph.has(f.sentinel)).toBe(true);
  });

  it('does not replace a root changed before the conditional server phase', async() => {
    const f = await carrier();
    // The captured client read still sees the old snapshot; the server update does not.
    f.race();
    expect(await transitionPublicationControlRecordExactly(f.target, f.record, {
      kind: 'outbound', key: f.record.key, at: f.batch.createdAt, ...encodeOutboundBatch({ ...f.batch, attempts: 1 }),
    }, f.caller)).toBe(false);
    expect(f.graph.getQuads(DataFactory.namedNode(f.address.subject), DataFactory.namedNode('https://example.test/concurrent'), null, null)).toHaveLength(1);
  });

  it('moves a refused PDU to a new transaction in the original day and confirms lost response', async() => {
    const f = await carrier(); f.lose();
    const key = 'new-transaction';
    expect(await transitionPublicationControlRecordExactly(f.target, f.record, {
      kind: 'outbound', key, at: f.batch.createdAt, ...encodeOutboundBatch({ ...f.batch, txnId: 'new', attempts: 1 }),
    }, f.caller)).toBe(true);
    expect(f.graph.getQuads(DataFactory.namedNode(f.address.subject), null, null, null)).toHaveLength(0);
    expect((await readControlRecord(f.target, 'outbound', key, { at: f.batch.createdAt, days: 0 }))?.metadata.txnId).toBe('new');
    expect(f.graph.has(f.sentinel)).toBe(true);
  });
});


it('a server-side deletion before CAS returns false without recreating old or new transaction', async() => {
  for (const key of [ 'fixture-key', 'new-transaction' ]) {
    const f = await carrier(); f.removeBeforePost();
    expect(await transitionPublicationControlRecordExactly(f.target, f.record, {
      kind: 'outbound', key, at: f.batch.createdAt, ...encodeOutboundBatch({ ...f.batch, txnId: key, attempts: 1 }),
    }, f.caller)).toBe(false);
    expect(f.graph.getQuads(DataFactory.namedNode(f.address.subject), null, null, null)).toHaveLength(0);
    const next = controlRecordAddress(f.target.scope, 'outbound', key, f.record.bucket);
    expect(f.graph.getQuads(DataFactory.namedNode(next.subject), null, null, null)).toHaveLength(0);
    expect(f.graph.has(f.sentinel)).toBe(true);
  }
});
