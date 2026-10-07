import { describe, expect, it } from 'vitest';
import { Parser as SparqlParser } from 'sparqljs';
import { Writer, DataFactory } from 'n3';
import { drizzle } from '@undefineds.co/drizzle-solid';
import { messageResource, chatResource, MessageRole, MessageStatus } from '@undefineds.co/models';
import { PodMatrixStore } from '../../../src/api/matrix/PodMatrixStore';
import { roomChatIri } from '../../../src/api/matrix/roomResources';
import { withProtocolMetadata } from '../../../src/api/protocol-metadata';

/**
 * The committed-winner guard must validate the protected modeled facts of a single Message record
 * before a conditional write is confirmed. These cases are the documented installed-ORM gap: the ORM
 * decoder can retain only the first value of a scalar, so cardinality, type and content-consistency
 * checks must run on the RDF authority, not on a decoded row.
 */
const POD = 'https://probe.invalid/alice/';
const ROOM = '!probe:probe.invalid';
const EVENT_ID = '$guard-regression';
const CONTEXT = { webId: `${POD}profile/card#me`, podUrl: POD };
const PARENT = roomChatIri(POD, ROOM);
const TIMESTAMP = Date.parse('2026-10-02T00:00:00.000Z');

function buildGuard() {
  const id = messageResource.buildId({ id: 'guard-fragment', parent: PARENT, createdAt: new Date(TIMESTAMP).toISOString() });
  const iri = messageResource.buildIri(POD, { id });
  const subject = DataFactory.namedNode(iri);
  const event = {
    event_id: EVENT_ID, room_id: ROOM, type: 'm.room.message', sender: '@alice:probe.invalid',
    origin_server_ts: TIMESTAMP, content: { body: 'root-valid-shape' },
  };
  const db = drizzle(
    { fetch: async() => new Response(null, { status: 204 }), info: { webId: CONTEXT.webId, isLoggedIn: true, podUrl: POD } },
    { podUrl: POD, schema: { chat: chatResource, message: messageResource }, resourcePreparation: 'off' },
  );
  const row = {
    id, parent: PARENT, chat: PARENT, maker: CONTEXT.webId, role: MessageRole.USER, status: MessageStatus.SENT,
    content: event.content.body, createdAt: new Date(TIMESTAMP).toISOString(), updatedAt: new Date(TIMESTAMP).toISOString(),
    metadata: withProtocolMetadata({ '@id': `${iri}/metadata` }, 'matrix', { event, senderWebId: CONTEXT.webId }),
  };
  const parsed = new SparqlParser().parse(db.insert(messageResource).values(row).toSPARQL().query) as any;
  const collect = (patterns: any[]): any[] => patterns.flatMap(p => p.type === 'bgp'
    ? p.triples
    : p.type === 'graph' ? collect(p.patterns ?? [{ type: 'bgp', triples: p.triples ?? [] }]) : []);
  const quads = parsed.updates.flatMap((u: any) => collect(u.insert ?? []))
    .map((t: any) => DataFactory.quad(t.subject, t.predicate, t.object));
  const protocolQuad = quads.find((q: any) => q.object.termType === 'Literal' && q.predicate.value.endsWith('#protocols'));
  if (!protocolQuad) throw new Error('ORM produced no protocol literal');
  const predicate = (name: string): any => DataFactory.namedNode(
    String((messageResource as any)[name].getPredicate(messageResource.config.namespace)),
  );
  const replace = (qs: any[], pred: any, value: any): any[] => qs.map((q: any) =>
    (q.subject.equals(subject) && q.predicate.equals(pred) ? DataFactory.quad(q.subject, q.predicate, value) : q));
  const protocolVariant = (changed: any): any[] => quads.map((q: any) => q === protocolQuad
    ? DataFactory.quad(q.subject, q.predicate, DataFactory.literal(JSON.stringify({ matrix: { event: changed, senderWebId: CONTEXT.webId } })))
    : q);
  const instance: any = Object.create(PodMatrixStore.prototype);
  instance.scope = (): string => POD;
  return { iri, subject, quads, predicate, protocolQuad, replace, protocolVariant, instance };
}

async function confirm(quads: any[]): Promise<boolean> {
  const { instance } = buildGuard();
  const writer = new Writer();
  writer.addQuads(quads);
  const ttl = await new Promise<string>((resolve, reject) =>
    writer.end((error, text) => (error ? reject(error) : resolve(text))));
  instance.podWriteFor = async() => ({ fetch: async() => new Response(ttl, { headers: { 'Content-Type': 'text/turtle' } }) });
  const id = messageResource.buildId({ id: 'guard-fragment', parent: PARENT, createdAt: new Date(TIMESTAMP).toISOString() });
  const confirmed = await instance.readCommittedMessageFromPod(CONTEXT, id, ROOM, EVENT_ID, '@alice:probe.invalid');
  return Boolean(confirmed);
}

describe('committed winner modeled-fact guard', () => {
  it('accepts the exact typed ORM record and a lawful mentions array', async() => {
    const { quads, predicate, subject } = buildGuard();
    expect(await confirm(quads)).toBe(true);
    expect(await confirm([
      ...quads,
      DataFactory.quad(subject, predicate('mentions'), DataFactory.namedNode('https://probe.invalid/bob/card#me')),
      DataFactory.quad(subject, predicate('mentions'), DataFactory.namedNode('https://probe.invalid/carol/card#me')),
    ])).toBe(true);
  });

  it.each([
    [ 'rdf:type has Literal spelling of the model class', (b: ReturnType<typeof buildGuard>) =>
      b.replace(b.quads, DataFactory.namedNode('http://www.w3.org/1999/02/22-rdf-syntax-ns#type'),
        DataFactory.literal(String(messageResource.config.type))) ],
    [ 'duplicate scalar content', (b: ReturnType<typeof buildGuard>) =>
      [ ...b.quads, DataFactory.quad(b.subject, b.predicate('content'), DataFactory.literal('competing')) ] ],
    [ 'duplicate scalar richContent', (b: ReturnType<typeof buildGuard>) =>
      [ ...b.quads,
        DataFactory.quad(b.subject, b.predicate('richContent'), DataFactory.literal('rich-a')),
        DataFactory.quad(b.subject, b.predicate('richContent'), DataFactory.literal('rich-b')) ] ],
    [ 'content disagrees with protocol body', (b: ReturnType<typeof buildGuard>) =>
      b.replace(b.quads, b.predicate('content'), DataFactory.literal('wrong single body')) ],
    [ 'missing RDF createdAt', (b: ReturnType<typeof buildGuard>) =>
      b.quads.filter((q: any) => !(q.subject.equals(b.subject) && q.predicate.equals(b.predicate('createdAt')))) ],
    [ 'createdAt has NamedNode type', (b: ReturnType<typeof buildGuard>) =>
      b.replace(b.quads, b.predicate('createdAt'), DataFactory.namedNode('urn:not-a-date')) ],
    [ 'createdAt disagrees with protocol time', (b: ReturnType<typeof buildGuard>) =>
      b.replace(b.quads, b.predicate('createdAt'), DataFactory.literal('2026-10-03T00:00:00.000Z', DataFactory.namedNode('http://www.w3.org/2001/XMLSchema#dateTime'))) ],
    [ 'inverse chat competitor', (b: ReturnType<typeof buildGuard>) =>
      [ ...b.quads, DataFactory.quad(DataFactory.namedNode(roomChatIri(POD, '!other:probe.invalid')), b.predicate('chat'), b.subject) ] ],
    [ 'protocol state_key is a number', (b: ReturnType<typeof buildGuard>) =>
      b.protocolVariant({ event_id: EVENT_ID, room_id: ROOM, type: 'm.room.message', sender: '@alice:probe.invalid',
        origin_server_ts: TIMESTAMP, content: { body: 'root-valid-shape' }, state_key: 1 }) ],
  ])('rejects a malformed record: %s', async(_name, mutate) => {
    expect(await confirm(mutate(buildGuard()))).toBe(false);
  });

  it('treats a missing state_key and an empty-string state_key as different shapes', () => {
    const instance: any = Object.create(PodMatrixStore.prototype);
    const base = { sender: '@alice:probe.invalid', type: 'm.room.name', content: { name: 'name' } };
    expect(instance.sameEventSemantics(base, { ...base })).toBe(true);
    expect(instance.sameEventSemantics(base, { ...base, stateKey: '' })).toBe(false);
    expect(instance.sameEventSemantics({ ...base, stateKey: '' }, base)).toBe(false);
    expect(instance.sameEventSemantics(base, { ...base, stateKey: '@alice:probe.invalid' })).toBe(false);
  });

  it('rejects a createdAt literal that is the right ISO text but the wrong xsd datatype', async() => {
    const { quads, predicate } = buildGuard();
    // The value parses to the protocol instant, but the literal is xsd:string, not xsd:dateTime.
    const wrongTyped = quads.map((q: any) => (q.subject.value === messageResource.buildIri(POD, {
      id: messageResource.buildId({ id: 'guard-fragment', parent: PARENT, createdAt: new Date(TIMESTAMP).toISOString() }),
    }) && q.predicate.equals(predicate('createdAt'))
      ? DataFactory.quad(q.subject, q.predicate, DataFactory.literal(new Date(TIMESTAMP).toISOString()))
      : q));
    expect(await confirm(wrongTyped)).toBe(false);
    // A valid literal with the dateTime datatype and an offset value is accepted.
    expect(await confirm(quads.map((q: any) => (q.predicate.equals(predicate('createdAt'))
      ? DataFactory.quad(q.subject, q.predicate, DataFactory.literal('2026-10-02T00:00:00.000+00:00', DataFactory.namedNode('http://www.w3.org/2001/XMLSchema#dateTime')))
      : q)))).toBe(true);
  });

  it('distinguishes a real inverse NamedNode edge from a literal spelling of the same IRI', async() => {
    const { quads, subject, predicate } = buildGuard();
    const chatIri = roomChatIri(POD, ROOM);
    // Replace the real `<chat> wf:message <messageIRI>` edge with a literal spelling.
    const literalised = quads.map((q: any) =>
      (q.predicate.equals(predicate('chat')) && q.object.equals(subject)
        ? DataFactory.quad(q.subject, q.predicate, DataFactory.literal(subject.value))
        : q));
    expect(await confirm(literalised)).toBe(false);
    // An unrelated chat asserting a literal <messageIRI> must not be counted as a competitor.
    expect(await confirm([
      ...quads,
      DataFactory.quad(DataFactory.namedNode(roomChatIri(POD, '!other:probe.invalid')), predicate('chat'), DataFactory.literal(subject.value)),
    ])).toBe(true);
  });

  it('accepts a legitimate duplicate of an exact RDF quad as a set member', async() => {
    const { quads } = buildGuard();
    // RDF is a set: the exact same quad appended again is not a competing second value.
    expect(await confirm([ ...quads, ...quads ])).toBe(true);
    // A different competing scalar value is still rejected.
    const { quads: fresh, subject, predicate } = buildGuard();
    expect(await confirm([
      ...fresh,
      DataFactory.quad(subject, predicate('content'), DataFactory.literal('competing')),
    ])).toBe(false);
  });
});
