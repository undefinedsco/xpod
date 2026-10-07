import { chatResource, type ChatMemberRole } from '@undefineds.co/models';
import type { SolidDatabase } from '@undefineds.co/drizzle-solid';
import { DataFactory, type Quad } from 'n3';
import { Generator, Parser } from 'sparqljs';
import type { CanonicalRoomSnapshot } from './canonicalRoomSource';
import { canonicalSourceFencePatterns } from './canonicalSourceFence';
import { MatrixError } from './MatrixError';

export interface CanonicalRoomChanges {
  protocols?: Record<string, unknown>;
  participants?: readonly string[];
  memberRoles?: Record<string, ChatMemberRole> | null;
}
const unavailable = (): MatrixError => new MatrixError(500, 'M_UNKNOWN', 'ORM canonical target serialization is unavailable');

/** Approved exact-CAS adapter; see docs/issues/drizzle-solid-canonical-protocol-cas.md. */
export function buildCanonicalRoomCas(db: SolidDatabase, snapshot: CanonicalRoomSnapshot, next: CanonicalRoomChanges): string {
  const has = (key: keyof CanonicalRoomChanges): boolean => Object.prototype.hasOwnProperty.call(next, key);
  const metadataPredicate = chatResource.getColumn('metadata')!.getPredicate(chatResource.config.namespace);
  const namespace = metadataPredicate.slice(0, Math.max(metadataPredicate.lastIndexOf('#'), metadataPredicate.lastIndexOf('/')) + 1);
  const participantPredicate = chatResource.getColumn('participants')!.getPredicate(chatResource.config.namespace);
  const rolesPredicate = `${namespace}memberRoles`;
  const metadata: Record<string, unknown> = { '@id': snapshot.metadataIri };
  const values: Record<string, unknown> = {};
  if (has('protocols')) metadata.protocols = next.protocols;
  if (has('memberRoles')) metadata.memberRoles = next.memberRoles;
  if (has('protocols') || has('memberRoles')) values.metadata = metadata;
  if (has('participants')) values.participants = next.participants;
  if (!Object.keys(values).length) throw unavailable();
  const compiled = db.update(chatResource).set(values as never).whereByIri(snapshot.facts.sourceIri).toSPARQL().query;
  const parsed = new Parser().parse(compiled) as unknown as { updates: Array<{ insert?: unknown[] }> };
  const triples: Quad[] = [];
  const collect = (entries: unknown[]): void => {
    for (const value of entries) {
      const entry = value as { triples?: Quad[]; patterns?: unknown[] };
      triples.push(...entry.triples ?? []);
      if (entry.patterns) collect(entry.patterns);
    }
  };
  for (const update of parsed.updates) collect(update.insert ?? []);
  const targets: Array<[string, string]> = [];
  const emitted: Quad[] = [];
  const jsonTarget = (predicate: string, expected: unknown): void => {
    targets.push([snapshot.metadataIri, predicate]);
    const found = triples.filter(q => q.subject.value === snapshot.metadataIri && q.predicate.value === predicate);
    if (expected === null) { if (found.length) throw unavailable(); return; }
    if (found.length !== 1 || found[0].object.termType !== 'Literal'
      || found[0].object.datatype.value !== 'http://www.w3.org/2001/XMLSchema#json'
      || found[0].object.value !== JSON.stringify(expected)) throw unavailable();
    emitted.push(...found);
  };
  if (has('protocols')) jsonTarget(snapshot.protocolsQuad.predicate.value, next.protocols);
  if (has('memberRoles')) jsonTarget(rolesPredicate, next.memberRoles);
  if (has('participants')) {
    if (!Array.isArray(next.participants) || new Set(next.participants).size !== next.participants.length) throw unavailable();
    targets.push([snapshot.facts.sourceIri, participantPredicate]);
    const found = triples.filter(q => q.subject.value === snapshot.facts.sourceIri && q.predicate.value === participantPredicate);
    if (found.length !== next.participants.length || found.some(q => q.object.termType !== 'NamedNode'
      || !next.participants!.includes(q.object.value))) throw unavailable();
    emitted.push(...found);
  }
  const nn = DataFactory.namedNode;
  const document = snapshot.facts.sourceIri.split('#')[0];
  // Full-term raw-source fence: the same sealed raw state the private precheck reads must still be
  // exact at native execution, so a quad/title changed after precheck cannot commit the CAS. This
  // subsumes the former per-group positive/anti-extra comparisons: the shared helper requires every
  // sealed quad with full term identity (named-node subject/predicate, named-node/literal object,
  // the physical source document graph) and then rejects any new subject, a new predicate on a
  // sealed subject, or a changed/added object for a sealed subject+predicate. Because the full-graph
  // anti-extra guard rejects a new predicate on any sealed subject, an absent participant or
  // memberRoles record is already covered and no per-group copy is kept here.
  const where: unknown[] = [ ...canonicalSourceFencePatterns(snapshot) ];
  const removed = snapshot.quads.filter(q => targets.some(([subject, predicate]) => q.subject.value === subject && q.predicate.value === predicate));
  return new Generator().stringify({ type: 'update', prefixes: {}, updates: [ {
    updateType: 'insertdelete', delete: [ { type: 'graph', name: nn(document), triples: removed } ],
    insert: [ { type: 'graph', name: nn(document), triples: emitted } ], where,
  } ] } as never);
}
