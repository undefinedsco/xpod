import { describe, expect, it } from 'vitest';
import { DataFactory, Store, type Quad } from 'n3';
import { QueryEngine } from '@comunica/query-sparql';
import { Generator } from 'sparqljs';
import { canonicalSourceFencePatterns } from '../../../src/api/matrix/canonicalSourceFence';
import type { CanonicalRoomSnapshot } from '../../../src/api/matrix/canonicalRoomSource';
import { MatrixError } from '../../../src/api/matrix/MatrixError';

const DOC = 'https://pod.example/cas/room';
const SOURCE = `${DOC}#chat`;
const META = `${SOURCE}/metadata`;
const OWNER = 'https://pod.example/profile/card#me';
const BOB = 'https://bob.example/profile/card#me';
const NS = 'https://undefineds.co/ns#';
const RDF = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#';
const XSD = 'http://www.w3.org/2001/XMLSchema#';

const nn = DataFactory.namedNode;
const lit = DataFactory.literal;
const q = (subject: string, predicate: string, object: Quad['object'], graph: Quad['graph'] = nn(DOC)): Quad =>
  DataFactory.quad(nn(subject), nn(predicate), object, graph);

function makeSnapshot(quads: readonly Quad[]): CanonicalRoomSnapshot {
  return {
    facts: { roomId: 'fixture', sourceIri: SOURCE, sourcePodId: 'cas', sourcePodUrl: 'https://pod.example/cas/',
      authorWebId: OWNER, participants: [], memberRoles: {} },
    quads: [ ...quads ], metadataIri: META, protocolsQuad: quads[0] as Quad, protocols: {},
  };
}

const base = (): Quad[] => [
  q(SOURCE, `${RDF}type`, nn(`${NS}Chat`)),
  q(SOURCE, `${NS}author`, nn(OWNER)),
  q(SOURCE, `${NS}metadata`, nn(META)),
  q(SOURCE, `${NS}participants`, nn(OWNER)),
  q(META, `${NS}protocols`, lit('{"matrix":{"roomId":"fixture"}}', nn(`${XSD}json`))),
  q(META, `${NS}memberRoles`, lit(`{"${OWNER}":"owner"}`, nn(`${XSD}json`))),
  q(META, `${NS}label`, lit('hello', 'en')),
  q(META, `${NS}count`, lit('1', nn(`${XSD}integer`))),
];

const without = (quads: readonly Quad[], predicate: string): Quad[] =>
  quads.filter(quad => quad.predicate.value !== predicate);

const replaceObject = (quads: readonly Quad[], predicate: string, object: Quad['object']): Quad[] =>
  quads.map(quad => quad.predicate.value === predicate
    ? DataFactory.quad(quad.subject, quad.predicate, object, quad.graph) : quad);

function fenceQuery(snapshot: CanonicalRoomSnapshot): string {
  return new Generator().stringify({ type: 'query', queryType: 'SELECT',
    variables: [ { termType: 'Wildcard', value: '*' } ],
    where: canonicalSourceFencePatterns(snapshot) } as never);
}

async function fenceHolds(sealed: CanonicalRoomSnapshot, current: readonly Quad[]): Promise<boolean> {
  const stream = await new QueryEngine().queryBindings(fenceQuery(sealed),
    { sources: [ new Store([ ...current ]) ] });
  return (await stream.toArray()).length > 0;
}

function expectUnsupported(quads: Quad[]): void {
  let error: unknown;
  try { canonicalSourceFencePatterns(makeSnapshot(quads)); } catch (caught) { error = caught; }
  expect(error).toBeInstanceOf(MatrixError);
  expect((error as MatrixError).status).toBe(415);
}

describe('canonicalSourceFence raw term validation', () => {
  it('accepts the physical source document graph and the parser-normalized default graph', () => {
    expect(() => canonicalSourceFencePatterns(makeSnapshot([ q(SOURCE, `${NS}p`, lit('x'), nn(DOC)) ]))).not.toThrow();
    expect(() => canonicalSourceFencePatterns(makeSnapshot([ q(SOURCE, `${NS}p`, lit('x'), DataFactory.defaultGraph()) ])))
      .not.toThrow();
  });

  it('refuses a blank-node subject rather than coercing subject.value into a named node', () => {
    expectUnsupported([
      DataFactory.quad(DataFactory.blankNode('sealed'), nn(`${NS}p`), nn(`${NS}o`), nn(DOC)),
    ]);
  });

  it('refuses a blank-node object', () => {
    expectUnsupported([
      DataFactory.quad(nn(SOURCE), nn(`${NS}p`), DataFactory.blankNode('sealed'), nn(DOC)),
    ]);
  });

  it('refuses an RDF-star quoted-triple subject or object', () => {
    const quoted = DataFactory.quad(nn(SOURCE), nn(`${NS}star`), nn(`${NS}o`), nn(DOC));
    expectUnsupported([
      DataFactory.quad(quoted as unknown as Quad['subject'], nn(`${NS}p`), lit('x'), nn(DOC)),
    ]);
    expectUnsupported([
      DataFactory.quad(nn(SOURCE), nn(`${NS}p`), quoted as unknown as Quad['object'], nn(DOC)),
    ]);
  });

  it('refuses a quad outside the admitted physical source document graph', () => {
    expectUnsupported([
      DataFactory.quad(nn(SOURCE), nn(`${NS}p`), lit('x'), nn('https://foreign.example/graph')),
    ]);
  });
});

describe('canonicalSourceFence full term identity', () => {
  it('matches the exact sealed raw source', async () => {
    const sealed = makeSnapshot(base());
    expect(await fenceHolds(sealed, base())).toBe(true);
  });

  it('rejects a changed language tag, datatype or lexical literal form', async () => {
    const sealed = makeSnapshot(base());
    expect(await fenceHolds(sealed, replaceObject(base(), `${NS}label`, lit('hello', 'fr')))).toBe(false);
    expect(await fenceHolds(sealed, replaceObject(base(), `${NS}count`, lit('1', nn(`${XSD}string`))))).toBe(false);
    expect(await fenceHolds(sealed, replaceObject(base(), `${NS}count`, lit('01', nn(`${XSD}integer`))))).toBe(false);
  });

  it('rejects a missing sealed term', async () => {
    const sealed = makeSnapshot(base());
    expect(await fenceHolds(sealed, without(base(), `${NS}protocols`))).toBe(false);
  });

  it('rejects a fresh subject', async () => {
    const sealed = makeSnapshot(base());
    expect(await fenceHolds(sealed, [ ...base(), q(`${DOC}#intruder`, `${NS}p`, lit('x')) ])).toBe(false);
  });

  it('rejects a new predicate on a sealed subject', async () => {
    const sealed = makeSnapshot(base());
    expect(await fenceHolds(sealed, [ ...base(), q(SOURCE, `${NS}foreign`, lit('x')) ])).toBe(false);
  });

  it('rejects a changed object on a sealed subject and predicate', async () => {
    const sealed = makeSnapshot(base());
    expect(await fenceHolds(sealed, replaceObject(base(), `${NS}author`, nn(BOB)))).toBe(false);
  });

  it('keeps rejecting an absent participant or memberRoles record added after sealing', async () => {
    expect(await fenceHolds(makeSnapshot(without(base(), `${NS}participants`)), base())).toBe(false);
    expect(await fenceHolds(makeSnapshot(without(base(), `${NS}memberRoles`)), base())).toBe(false);
  });
});
