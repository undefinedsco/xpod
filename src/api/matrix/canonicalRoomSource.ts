/**
 * The current canonical Chat read port.
 *
 * A room is addressed by a source-bound room id (`canonicalRoomIdentity`). This port turns that id
 * into *current* room facts by reading the **exact canonical Chat resource** the id names, using the
 * caller's own authenticated fetch. It never uses a request hint, a mirror, a SQL room reverse map or
 * history to decide authority: the room id is the only source, and a legacy/unknown id fails closed.
 *
 * The reader returns the verified current facts (`sourceIri`, source Pod identity, the author's full
 * WebID, participants and member roles) even when the caller is not a participant, so an explicit
 * policy layer can distinguish "confirmed non-member" from "unreadable". It exposes no events.
 *
 * Creation and explicit owner membership-authority publication use this port. Membership/Agent
 * gates remain a later slice; reading these facts does not authorize background deployment work.
 */
import { getLoggerFor } from 'global-logger-factory';
import { chatResource, type ChatMemberRole } from '@undefineds.co/models';
import { drizzle, type SolidDatabase } from '@undefineds.co/drizzle-solid';
import { DataFactory, Parser as N3Parser, termFromId, termToId, type Quad } from 'n3';
import { isSolidAuth } from '../auth/AuthContext';
import type { PodLookupRepository, PodLookupResult } from '../../identity/drizzle/PodLookupRepository';
import type { MatrixStoreContext } from './types';
import { MatrixError } from './MatrixError';
import { namedCanonicalTransport, type NamedCanonicalRead } from './namedCanonicalRead';
import { parseMembershipInvitations, parseMembershipOperation,
  type MembershipInvitations, type MembershipOperation } from './membershipOperation';
import { parseMembershipReadGrants, type MembershipReadGrants } from './membershipReadGrant';
import {
  decodeSourceBoundRoomId,
  validateCanonicalChatIri,
} from './canonicalRoomIdentity';

/** The public columns this port proves on the exact Chat subject. */
const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
/** The only datatype the inline metadata object serializer emits for JSON values. */
const XSD_JSON = 'http://www.w3.org/2001/XMLSchema#json';
/** The installed public model's allowed chat member roles. */
const MEMBER_ROLES: readonly ChatMemberRole[] = [ 'owner', 'admin', 'member' ];

/** Nonsecret owner-published metadata; reading it does not grant background authority. */
export interface MembershipAuthorityBinding {
  purpose: 'membership';
  credentialRef: string;
  version: number;
  issuer: string;
}

export interface MembershipAuthorityPublication {
  eventId: string;
  createdAt: number;
  state: 'pending' | 'complete';
}

export function parseMembershipAuthorityPublication(value: unknown): MembershipAuthorityPublication | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const keys = Reflect.ownKeys(value);
  if (keys.length !== 3 || keys.some(key => ![ 'eventId', 'createdAt', 'state' ].includes(String(key)))) return undefined;
  const record = value as Record<string, unknown>;
  if (typeof record.eventId !== 'string' || record.eventId.trim().length === 0
    || typeof record.createdAt !== 'number' || !Number.isSafeInteger(record.createdAt) || record.createdAt < 0
    || (record.state !== 'pending' && record.state !== 'complete')) return undefined;
  return { eventId: record.eventId, createdAt: record.createdAt, state: record.state };
}

/** Internal CAS evidence retained from the exact same authenticated read as the facts. */
export interface CanonicalRoomSnapshot {
  facts: CanonicalRoomFacts;
  quads: readonly Quad[];
  metadataIri: string;
  protocolsQuad: Quad;
  protocols: Record<string, unknown>;
}

/** Internal defensive evidence copy; RDF terms retain their public N3 equals semantics. */
export function copyImmutableCanonicalRoomSnapshot(snapshot: CanonicalRoomSnapshot): CanonicalRoomSnapshot {
  const copyQuad = (quad: Quad): Quad => DataFactory.quad(
    termFromId(termToId(quad.subject), DataFactory) as Quad['subject'],
    termFromId(termToId(quad.predicate), DataFactory) as Quad['predicate'],
    termFromId(termToId(quad.object), DataFactory) as Quad['object'],
    termFromId(termToId(quad.graph), DataFactory) as Quad['graph'],
  );
  const freeze = <T>(value: T): T => {
    if (value && typeof value === 'object') {
      for (const nested of Object.values(value)) freeze(nested);
      Object.freeze(value);
    }
    return value;
  };
  return freeze({ ...snapshot, facts: structuredClone(snapshot.facts), protocols: structuredClone(snapshot.protocols),
    quads: snapshot.quads.map(copyQuad), protocolsQuad: copyQuad(snapshot.protocolsQuad) });
}

export function parseMembershipAuthorityBinding(value: unknown): MembershipAuthorityBinding | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  const fields = [ 'purpose', 'credentialRef', 'version', 'issuer' ];
  const keys = Reflect.ownKeys(value);
  if (keys.length !== fields.length || keys.some(key => typeof key !== 'string' || !fields.includes(key))) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  if (record.purpose !== 'membership' || typeof record.credentialRef !== 'string' || record.credentialRef.trim().length === 0
    || typeof record.issuer !== 'string' || record.issuer.trim().length === 0
    || typeof record.version !== 'number' || !Number.isSafeInteger(record.version) || record.version <= 0) {
    return undefined;
  }
  return { purpose: 'membership', credentialRef: record.credentialRef, version: record.version, issuer: record.issuer };
}

/** Current, verified room facts. Never events, never authority derived from the caller. */
export interface CanonicalRoomFacts {
  roomId: string;
  sourceIri: string;
  sourcePodId: string;
  sourcePodUrl: string;
  /** The source author's full WebID, exactly as stored. */
  authorWebId: string;
  participants: readonly string[];
  memberRoles: Readonly<Record<string, ChatMemberRole>>;
  membershipAuthority?: MembershipAuthorityBinding;
  membershipAuthorityPublication?: MembershipAuthorityPublication;
  membershipInvitations?: MembershipInvitations;
  membershipOperation?: MembershipOperation;
  membershipReadGrants?: MembershipReadGrants;
}

/**
 * Where the port reads registration facts from: the identity store, the same repository the routing
 * layer uses. Only these two lookups are used, and they are registration facts, not room truth.
 */
export interface CanonicalRoomSourceDeps {
  pods: Pick<PodLookupRepository, 'findByResourceIdentifier' | 'findAllByWebId'>;
  /** Resolve the *caller's* authenticated fetch (never the source author's). */
  callerFetchFor(context: MatrixStoreContext, beforeRequest?: () => Promise<void>): Promise<typeof fetch>;
}

/** A fetch wrapper that seals after its one allowed canonical request, so the SDK cannot retry. */
class SealedCanonicalFetch {
  private served = false;
  private failed: Error | undefined;

  public constructor(
    private readonly callerFetch: typeof fetch,
    private readonly documentIri: string,
    private readonly onBody: (turtle: string) => void,
  ) {}

  public readonly fetch: typeof fetch = async (input, init) => {
    if (this.failed) {
      throw this.failed;
    }
    // Normalize the input exactly: a string is its own URL, a URL its `href`, a Request its `url`.
    // The effective method is an explicit init override, else the Request's own method, else GET.
    const url = typeof input === 'string'
      ? input
      : input instanceof URL
        ? input.href
        : (input as Request).url;
    const isRequest = typeof input === 'object' && input !== null && 'url' in input && 'method' in input;
    const method = String(init?.method ?? (isRequest ? (input as Request).method : 'GET')).toUpperCase();
    // Pre-network checks: the one allowed request is exactly this GET of the canonical document.
    if (this.served) {
      this.failed = new MatrixError(403, 'M_FORBIDDEN', 'The canonical source allows only one document read');
      throw this.failed;
    }
    if (url !== this.documentIri) {
      this.failed = new MatrixError(403, 'M_FORBIDDEN', 'The canonical source read targeted another resource');
      throw this.failed;
    }
    if (method !== 'GET') {
      this.failed = new MatrixError(403, 'M_FORBIDDEN', 'The canonical source read must be a GET');
      throw this.failed;
    }
    this.served = true;
    // Preserve the caller's Request options (headers/credentials/…) while forcing no-redirect GET.
    const baseInit: RequestInit = isRequest
      ? {
          method: 'GET',
          headers: (input as Request).headers,
          ...((input as Request).credentials ? { credentials: (input as Request).credentials } : {}),
        }
      : {};
    const response = await this.callerFetch(this.documentIri, { ...baseInit, ...init, method: 'GET', redirect: 'error' });
    if (response.status >= 300 && response.status < 400) {
      this.failed = new MatrixError(403, 'M_FORBIDDEN', 'The canonical document must not redirect');
      throw this.failed;
    }
    if (response.redirected) {
      this.failed = new MatrixError(403, 'M_FORBIDDEN', 'The canonical document was redirected');
      throw this.failed;
    }
    if (!response.ok) {
      this.failed = new MatrixError(403, 'M_FORBIDDEN', 'The canonical document was unreadable');
      throw this.failed;
    }
    // A real transport always reports the exact final URL; a missing or different one is refused.
    if (typeof response.url !== 'string' || response.url.length === 0 || response.url !== this.documentIri) {
      this.failed = new MatrixError(403, 'M_FORBIDDEN', 'The canonical document response URL did not match');
      throw this.failed;
    }
    const clone = response.clone();
    const turtle = await clone.text();
    this.onBody(turtle);
    return response;
  };
}

export class CanonicalRoomSource {
  private readonly logger = getLoggerFor(this);

  public constructor(private readonly deps: CanonicalRoomSourceDeps) {}

  /**
   * Read the current canonical facts for a room id. Fails closed with a `MatrixError` for a
   * legacy/unknown id, an unregistered or ambiguous source Pod, a non-caller session, or a resource
   * whose exact RDF shape cannot be proven.
   */
  public async read(roomId: string, context: MatrixStoreContext): Promise<CanonicalRoomFacts> {
    return (await this.readSnapshot(roomId, context)).facts;
  }

  public async readSnapshot(roomId: string, context: MatrixStoreContext, beforeRequest?: () => Promise<void>): Promise<CanonicalRoomSnapshot> {
    // Caller-session only, checked before any network fetch. Publication fences this caller's
    // transport with an explicit named lease; a service/task principal still cannot read as owner.
    const auth = context.auth;
    if (context.service || !auth || !isSolidAuth(auth) || typeof auth.webId !== 'string' || auth.webId !== context.webId) {
      throw new MatrixError(403, 'M_FORBIDDEN', 'The canonical source is read with the caller session only');
    }
    return await this.readCapturedSnapshot(roomId, context.webId,
      async() => await this.deps.callerFetchFor(context, beforeRequest), beforeRequest);
  }

  /** Separate internal named task read. The original caller-only entrypoints never accept it. */
  public async readNamedSnapshot(roomId: string, capability: NamedCanonicalRead): Promise<CanonicalRoomSnapshot> {
    const transport = namedCanonicalTransport(capability);
    return await this.readCapturedSnapshot(roomId, capability.ownerWebId,
      async() => transport.fetch, transport.beforeRequest, capability);
  }

  private async readCapturedSnapshot(roomId: string, transportWebId: string,
    fetchFor: () => Promise<typeof fetch>, beforeRequest?: () => Promise<void>, expected?: NamedCanonicalRead): Promise<CanonicalRoomSnapshot> {
    // 1. The room id is the only source; a legacy/unknown id fails closed.
    const decoded = decodeSourceBoundRoomId(roomId);
    if (decoded.status !== 'source-bound') {
      throw new MatrixError(403, 'M_FORBIDDEN', 'This room id is not source-bound');
    }
    const sourceIri = decoded.canonicalChatIri;
    const documentIri = sourceIri.split('#')[0];
    // 2. Registry lookup for the source Pod, then prove exactly one canonical root.
    const registered = await this.deps.pods.findByResourceIdentifier(documentIri);
    const sourceRoot = this.canonicalSourceRoot(registered, sourceIri);
    if (!registered || !sourceRoot) {
      throw new MatrixError(403, 'M_FORBIDDEN', 'The room source Pod is not registered');
    }

    if (expected && (expected.sourceIri !== sourceIri || expected.sourcePodId !== registered.podId
      || expected.sourceRoot !== sourceRoot)) {
      throw new MatrixError(403, 'M_FORBIDDEN', 'The named candidate differs from the registered source');
    }

    // 3. Exactly one authenticated GET of the exact canonical document, then the exact proof.
    const capturedTurtle = { value: '' };
    await beforeRequest?.();
    const callerFetch = await fetchFor();
    const sealed = new SealedCanonicalFetch(callerFetch, documentIri, turtle => { capturedTurtle.value = turtle; });
    const db: SolidDatabase = drizzle(
      { fetch: sealed.fetch, info: { webId: transportWebId, isLoggedIn: true, podUrl: sourceRoot } } as never,
      { podUrl: sourceRoot } as never,
    );
    let row: Record<string, unknown> | null = null;
    try {
      await db.init(chatResource);
      row = (await db.findByIri(chatResource, sourceIri) as Record<string, unknown> | null) ?? null;
    } catch (error) {
      // Any sealed failure is an authority failure; do not fall through to a fabricated row.
      this.logger.debug(`Canonical Chat ORM read failed: ${String(error)}`);
      row = null;
    }
    const rdf = this.proveExactChatShape(capturedTurtle.value, sourceIri, documentIri, roomId);
    if (!rdf) {
      throw new MatrixError(403, 'M_FORBIDDEN', 'The room source did not prove its exact canonical shape');
    }

    // 4. The ORM row (same captured read) must agree with the raw RDF facts: author, participants,
    // root memberRoles and protocols.matrix.roomId. The ORM loses RDF term/cardinality evidence (see
    // the linked issue), so the raw proof stays authoritative; this is a same-body cross-check.
    const ormAuthor = row && typeof row.author === 'string' ? row.author : null;
    if (!ormAuthor || ormAuthor !== rdf.authorWebId || (expected && expected.ownerWebId !== ormAuthor)) {
      throw new MatrixError(403, 'M_FORBIDDEN', 'The room author could not be verified');
    }
    if (!this.sameBodyAgrees(row, roomId, rdf)) {
      throw new MatrixError(403, 'M_FORBIDDEN', 'The ORM row did not agree with the raw room facts');
    }
    // 5. The author's full WebID must own the exact source Pod (registration facts, exact full WebID).
    const authorPods = await this.deps.pods.findAllByWebId(ormAuthor);
    if (!authorPods.some(pod => pod.podId === registered.podId && this.podRoots(pod).includes(sourceRoot))) {
      throw new MatrixError(403, 'M_FORBIDDEN', 'The room author does not own the source Pod');
    }
    const facts: CanonicalRoomFacts = {
      roomId,
      sourceIri,
      sourcePodId: registered.podId,
      sourcePodUrl: sourceRoot,
      authorWebId: ormAuthor,
      participants: rdf.participants,
      memberRoles: rdf.memberRoles,
      ...(rdf.membershipAuthority ? { membershipAuthority: rdf.membershipAuthority } : {}),
      ...(rdf.membershipAuthorityPublication ? { membershipAuthorityPublication: rdf.membershipAuthorityPublication } : {}),
      ...(rdf.membershipInvitations ? { membershipInvitations: rdf.membershipInvitations } : {}),
      ...(rdf.membershipOperation ? { membershipOperation: rdf.membershipOperation } : {}),
      ...(rdf.membershipReadGrants ? { membershipReadGrants: rdf.membershipReadGrants } : {}),
    };
    const unique = new Map<string, Quad>();
    for (const quad of new N3Parser({ baseIRI: documentIri }).parse(capturedTurtle.value)) {
      unique.set(`${termToId(quad.subject)}|${termToId(quad.predicate)}|${termToId(quad.object)}|${termToId(quad.graph)}`, quad);
    }
    const quads = [ ...unique.values() ];
    const metadataPredicate = chatResource.getColumn('metadata')!.getPredicate(chatResource.config.namespace);
    const metadataIri = quads.find(q => q.subject.value === sourceIri && q.predicate.value === metadataPredicate)!.object.value;
    const namespaceEnd = Math.max(metadataPredicate.lastIndexOf('#'), metadataPredicate.lastIndexOf('/'));
    const protocolsQuad = quads.find(q => q.subject.value === metadataIri
      && q.predicate.value === `${metadataPredicate.slice(0, namespaceEnd + 1)}protocols`)!;
    return { facts, quads, metadataIri, protocolsQuad, protocols: JSON.parse(protocolsQuad.object.value) };
  }

  /**
   * The same-body agreement between the ORM row and the raw RDF proof, over the one captured read.
   * The ORM folds terms and picks scalars, so this is only a consistency cross-check: the returned
   * facts remain the raw RDF facts. Participants are compared as exact full-WebID sets
   * (order-insensitive), the protocol room id must equal the requested/proven id, and the ORM root
   * `memberRoles` must equal the raw map with full keys, valid values and no extra entries
   * (true absence is `{}` on both sides). Any malformed ORM shape fails closed.
   */
  private sameBodyAgrees(
    row: Record<string, unknown> | null,
    requestedRoomId: string,
    rdf: { participants: string[]; memberRoles: Record<string, ChatMemberRole>; membershipAuthority?: MembershipAuthorityBinding;
      membershipAuthorityPublication?: MembershipAuthorityPublication;
      membershipInvitations?: MembershipInvitations; membershipOperation?: MembershipOperation;
      membershipReadGrants?: MembershipReadGrants },
  ): boolean {
    if (!row) {
      return false;
    }
    // Participants: exact full-WebID set equality. An absent ORM array is the empty set.
    const ormParticipants = row.participants;
    const rawParticipants = new Set(rdf.participants);
    let ormParticipantSet: Set<string>;
    if (ormParticipants === undefined) {
      ormParticipantSet = new Set();
    } else if (Array.isArray(ormParticipants)) {
      for (const participant of ormParticipants) {
        if (typeof participant !== 'string' || !isAbsoluteHttpIri(participant)) {
          return false;
        }
      }
      ormParticipantSet = new Set(ormParticipants as string[]);
    } else {
      return false;
    }
    if (ormParticipantSet.size !== rawParticipants.size) {
      return false;
    }
    for (const participant of rawParticipants) {
      if (!ormParticipantSet.has(participant)) {
        return false;
      }
    }
    // The same-body metadata object must be present and hydrated.
    const metadata = row.metadata;
    if (metadata === null || typeof metadata !== 'object' || Array.isArray(metadata)) {
      return false;
    }
    const metadataRecord = metadata as Record<string, unknown>;
    // Root memberRoles: absent on both sides is the empty map; any present record is validated.
    const ormRoles = metadataRecord.memberRoles === undefined
      ? {}
      : this.parseMemberRoles(metadataRecord.memberRoles);
    if (ormRoles === undefined) {
      return false;
    }
    const rawRoleKeys = Object.keys(rdf.memberRoles).sort();
    const ormRoleKeys = Object.keys(ormRoles).sort();
    if (rawRoleKeys.length !== ormRoleKeys.length) {
      return false;
    }
    for (let index = 0; index < rawRoleKeys.length; index++) {
      const key = rawRoleKeys[index];
      if (key !== ormRoleKeys[index] || rdf.memberRoles[key] !== ormRoles[key]) {
        return false;
      }
    }
    // protocols.matrix.roomId must equal the requested (and raw-proven) room id.
    const protocols = metadataRecord.protocols;
    if (protocols === null || typeof protocols !== 'object' || Array.isArray(protocols)) {
      return false;
    }
    const matrix = (protocols as Record<string, unknown>).matrix;
    if (matrix === null || typeof matrix !== 'object' || Array.isArray(matrix)) {
      return false;
    }
    const matrixRecord = matrix as Record<string, unknown>;
    if (matrixRecord.roomId !== requestedRoomId) {
      return false;
    }
    const recovery = this.readRecoveryRecords(matrixRecord);
    if (!recovery || !sameJsonValue(recovery.membershipInvitations, rdf.membershipInvitations)
      || !sameJsonValue(recovery.membershipOperation, rdf.membershipOperation)
      || !sameJsonValue(recovery.membershipReadGrants, rdf.membershipReadGrants)) return false;
    const present = Object.prototype.hasOwnProperty.call(matrixRecord, 'membershipAuthority');
    const binding = present ? parseMembershipAuthorityBinding(matrixRecord.membershipAuthority) : undefined;
    if (present && !binding) {
      return false;
    }
    const publicationPresent = Object.prototype.hasOwnProperty.call(matrixRecord, 'membershipAuthorityPublication');
    const publication = publicationPresent ? parseMembershipAuthorityPublication(matrixRecord.membershipAuthorityPublication) : undefined;
    if (publicationPresent && (!publication || !binding)) return false;
    if (publication?.eventId !== rdf.membershipAuthorityPublication?.eventId
      || publication?.createdAt !== rdf.membershipAuthorityPublication?.createdAt
      || publication?.state !== rdf.membershipAuthorityPublication?.state) return false;
    if (!binding || !rdf.membershipAuthority) {
      return binding === rdf.membershipAuthority;
    }
    return binding.purpose === rdf.membershipAuthority.purpose
      && binding.credentialRef === rdf.membershipAuthority.credentialRef
      && binding.version === rdf.membershipAuthority.version
      && binding.issuer === rdf.membershipAuthority.issuer;
  }

  /**
   * Prove that `context` is the current owner of a *new* canonical Chat resource before any write.
   *
   * A caller-session only (the same rule as `read`), the caller's full WebID must itself be
   * registered as owning the chosen Pod, and the source IRI must resolve to exactly one canonical
   * root among the Pod's registered base/storage URLs. The source document is brand new and does not
   * exist yet, so this is **registration facts only**: it makes no network request, mints nothing and
   * writes nothing. It returns the chosen canonical root so the caller can prove its `podUrl` is the
   * same exact root instead of silently moving Pods.
   */
  public async assertCreationOwner(sourceIri: string, context: MatrixStoreContext): Promise<{ sourceRoot: string }> {
    const auth = context.auth;
    if (context.service || !auth || !isSolidAuth(auth) || typeof auth.webId !== 'string' || auth.webId !== context.webId) {
      throw new MatrixError(403, 'M_FORBIDDEN', 'A new canonical room is created with the caller session only');
    }
    // The author the room will carry must be a full absolute HTTP(S) WebID with no credentials
    // (a WebID need not carry a fragment). Otherwise the canonical reader could never accept the
    // created document, so this is refused before any effect.
    if (!isAbsoluteHttpIri(auth.webId)) {
      throw new MatrixError(403, 'M_FORBIDDEN', 'The new room author is not a full HTTP(S) WebID');
    }
    const documentIri = sourceIri.split('#')[0];
    const registered = await this.deps.pods.findByResourceIdentifier(documentIri);
    const sourceRoot = this.canonicalSourceRoot(registered, sourceIri);
    if (!registered || !sourceRoot) {
      throw new MatrixError(403, 'M_FORBIDDEN', 'The new room source Pod is not registered');
    }
    // The exact full caller WebID must own this exact registered root (registration facts).
    const ownedPods = await this.deps.pods.findAllByWebId(context.webId);
    if (!ownedPods.some(pod => pod.podId === registered.podId && this.podRoots(pod).includes(sourceRoot))) {
      throw new MatrixError(403, 'M_FORBIDDEN', 'The caller does not own the new room source Pod');
    }
    return { sourceRoot };
  }

  /** Registration of the original event actor's selected Pod, independent of the source author. */
  public async assertActorPod(context: MatrixStoreContext): Promise<{ podUrl: string }> {
    if (context.service || !context.auth || !isSolidAuth(context.auth)
      || context.auth.webId !== context.webId || !isAbsoluteHttpIri(context.webId)
      || !context.podUrl || !isAbsoluteHttpIri(context.podUrl)) {
      throw new MatrixError(403, 'M_FORBIDDEN', 'A registered original actor Pod is required');
    }
    return await this.assertRegisteredActorPod({ webId: context.webId, podUrl: context.podUrl });
  }

  /** Target registration only. This does not authenticate or impersonate the historical actor. */
  public async assertRegisteredActorPod(actor: { webId: string; podUrl: string }): Promise<{ podUrl: string }> {
    if (!isAbsoluteHttpIri(actor.webId) || !isAbsoluteHttpIri(actor.podUrl)
      || actor.webId.trim() !== actor.webId || actor.podUrl.trim() !== actor.podUrl) {
      throw new MatrixError(403, 'M_FORBIDDEN', 'An exact registered actor Pod is required');
    }
    const owned = await this.deps.pods.findAllByWebId(actor.webId);
    const matching = owned.filter(pod => this.podRoots(pod).includes(actor.podUrl));
    if (matching.length !== 1) throw new MatrixError(403, 'M_FORBIDDEN', 'The actor Pod registration is missing or ambiguous');
    return { podUrl: actor.podUrl };
  }

  /**
   * The one canonical root for the source IRI: `baseUrl`/`storageUrl` are registration hints, and the
   * IRI must pass the strict codec root validator against exactly one of them. Two distinct valid
   * roots are ambiguous and refused.
   */
  private canonicalSourceRoot(registered: PodLookupResult | undefined, sourceIri: string): string | null {
    if (!registered) {
      return null;
    }
    const candidates = [ ...new Set(this.podRoots(registered)) ];
    const valid = candidates.filter(root => validateCanonicalChatIri(sourceIri, root) !== null);
    return valid.length === 1 ? valid[0] : null;
  }

  private podRoots(pod: Pick<PodLookupResult, 'baseUrl' | 'storageUrl'>): string[] {
    return [ pod.baseUrl, pod.storageUrl ]
      .filter((value): value is string => typeof value === 'string' && value.length > 0);
  }

  /**
   * The narrow exact-shape proof over the captured Turtle. This exists because the installed public
   * ORM drops `rdf:type`, folds NamedNode/Literal and keeps the first scalar (see
   * `docs/issues/drizzle-solid-canonical-chat-exact-shape.md`). It uses only the public model's
   * `config.type` and column `getPredicate`/`dataType`, plus the installed `n3` parser.
   */
  private proveExactChatShape(ttl: string, sourceIri: string, documentIri: string, roomId: string): {
    authorWebId: string;
    participants: string[];
    memberRoles: Record<string, ChatMemberRole>;
    membershipAuthority?: MembershipAuthorityBinding;
    membershipAuthorityPublication?: MembershipAuthorityPublication;
    membershipInvitations?: MembershipInvitations;
    membershipOperation?: MembershipOperation;
    membershipReadGrants?: MembershipReadGrants;
  } | null {
    if (ttl.length === 0) {
      return null;
    }
    let quads: Quad[];
    try {
      quads = new N3Parser({ baseIRI: documentIri }).parse(ttl);
    } catch {
      return null;
    }
    // RDF is a set: identical quads full-term identity are deduplicated before cardinality.
    const unique = new Map<string, Quad>();
    for (const quad of quads) {
      unique.set(`${termToId(quad.subject)}|${termToId(quad.predicate)}|${termToId(quad.object)}|${termToId(quad.graph)}`, quad);
    }
    const set = [ ...unique.values() ];
    const columns = chatResource as unknown as Record<string, { getPredicate?: (ns: unknown) => string; dataType?: string }>;
    const predicateOf = (name: string): string => {
      const predicate = columns[name]?.getPredicate?.(chatResource.config.namespace);
      if (typeof predicate !== 'string') {
        throw new MatrixError(500, 'M_UNKNOWN', `The models chat column ${name} is unavailable`);
      }
      return predicate;
    };
    const outgoing = (predicate: string): Quad[] =>
      set.filter(quad => quad.subject.termType === 'NamedNode' && quad.subject.value === sourceIri && quad.predicate.value === predicate);

    // Exactly one rdf:type, a NamedNode, exactly the Chat class.
    const types = outgoing(RDF_TYPE);
    if (types.length !== 1 || types[0].object.termType !== 'NamedNode'
      || types[0].object.value !== String(chatResource.config.type)) {
      return null;
    }
    // Exactly one author, a NamedNode absolute full WebID; a literal spelling is not identity.
    const authors = outgoing(predicateOf('author'));
    if (authors.length !== 1 || authors[0].object.termType !== 'NamedNode'
      || !isAbsoluteHttpIri(authors[0].object.value)) {
      return null;
    }
    const authorWebId = authors[0].object.value;
    // Participants: the public uri array column. NamedNode only — a URI-shaped literal (even a custom
    // typed one) is a different RDF term and must fail closed.
    const participantsColumn = columns.participants;
    if (participantsColumn?.dataType !== 'array') {
      throw new MatrixError(500, 'M_UNKNOWN', 'The models chat participants column is not an array');
    }
    const participantQuads = outgoing(predicateOf('participants'));
    const participants: string[] = [];
    for (const quad of participantQuads) {
      if (quad.object.termType !== 'NamedNode' || !isAbsoluteHttpIri(quad.object.value)) {
        return null;
      }
      participants.push(quad.object.value);
    }
    // The protocol payload carries the exact requested room id.
    const metadata = this.readMetadataFacts(set, sourceIri, predicateOf('metadata'));
    if (metadata === undefined || metadata.roomId !== roomId) {
      return null;
    }
    return { authorWebId, participants, memberRoles: metadata.memberRoles,
      ...(metadata.membershipAuthority ? { membershipAuthority: metadata.membershipAuthority } : {}),
      ...(metadata.membershipAuthorityPublication ? { membershipAuthorityPublication: metadata.membershipAuthorityPublication } : {}),
      ...(metadata.membershipInvitations ? { membershipInvitations: metadata.membershipInvitations } : {}),
      ...(metadata.membershipOperation ? { membershipOperation: metadata.membershipOperation } : {}),
      ...(metadata.membershipReadGrants ? { membershipReadGrants: metadata.membershipReadGrants } : {}) };
  }

  /**
   * The `metadata` object column's current facts: the exact `matrix.roomId` from the protocol
   * payload, and the current `memberRoles` record read from the **root** metadata object
   * (`ChatMetadata.memberRoles`), never from `protocols.matrix`.
   *
   * The inline object serializer writes each root metadata key as a predicate in the metadata
   * column's own namespace, so the role predicate is derived from the public `metadata` predicate's
   * namespace and the public `memberRoles` key — no copied schema. A malformed, ambiguous or
   * wrong-namespace role record fails closed; an absent role record means no explicit role and is
   * never promoted to a default.
   */
  private readMetadataFacts(
    set: Quad[],
    subject: string,
    metadataPredicate: string,
  ): { roomId: string; memberRoles: Record<string, ChatMemberRole>; membershipAuthority?: MembershipAuthorityBinding;
    membershipAuthorityPublication?: MembershipAuthorityPublication;
    membershipInvitations?: MembershipInvitations; membershipOperation?: MembershipOperation;
    membershipReadGrants?: MembershipReadGrants } | undefined {
    const metadataEdges = set.filter(quad => quad.subject.termType === 'NamedNode'
      && quad.subject.value === subject && quad.predicate.value === metadataPredicate);
    if (metadataEdges.length !== 1 || metadataEdges[0].object.termType !== 'NamedNode') {
      return undefined;
    }
    const metadataSubject = metadataEdges[0].object.value;
    // The public `metadata` predicate is `<namespace>metadata`; its namespace is where the inline
    // object's root keys live. Derive it from the predicate itself, not a copied namespace literal.
    const namespaceEnd = Math.max(metadataPredicate.lastIndexOf('#'), metadataPredicate.lastIndexOf('/'));
    if (namespaceEnd < 0) {
      return undefined;
    }
    const namespace = metadataPredicate.slice(0, namespaceEnd + 1);
    const protocolsPredicate = `${namespace}protocols`;
    const memberRolesPredicate = `${namespace}memberRoles`;
    const protocols = set.filter(quad => quad.subject.termType === 'NamedNode'
      && quad.subject.value === metadataSubject && quad.predicate.value === protocolsPredicate);
    // The inline object serializer emits JSON values as `xsd:json`. A plain/custom/language literal
    // that merely contains JSON-shaped text is a different RDF term and must not be parsed as facts.
    if (protocols.length !== 1 || protocols[0].object.termType !== 'Literal'
      || protocols[0].object.datatype.value !== XSD_JSON) {
      return undefined;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(protocols[0].object.value);
    } catch {
      return undefined;
    }
    // JSON `null`/scalar/array is not a protocol object; refuse rather than crash on property access.
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return undefined;
    }
    const matrix = (parsed as { matrix?: unknown }).matrix;
    if (matrix === null || typeof matrix !== 'object' || Array.isArray(matrix)
      || typeof (matrix as { roomId?: unknown }).roomId !== 'string') {
      return undefined;
    }
    const matrixRoomId = (matrix as { roomId: string }).roomId;
    const recovery = this.readRecoveryRecords(matrix as Record<string, unknown>);
    if (!recovery) return undefined;
    const hasBinding = Object.prototype.hasOwnProperty.call(matrix, 'membershipAuthority');
    const binding = hasBinding
      ? parseMembershipAuthorityBinding((matrix as Record<string, unknown>).membershipAuthority)
      : undefined;
    if (hasBinding && !binding) {
      return undefined;
    }
    const publicationPresent = Object.prototype.hasOwnProperty.call(matrix, 'membershipAuthorityPublication');
    const publication = publicationPresent
      ? parseMembershipAuthorityPublication((matrix as Record<string, unknown>).membershipAuthorityPublication) : undefined;
    if (publicationPresent && (!publication || !binding)) return undefined;
    // The roles are a root metadata fact, distinct from `protocols.matrix`. Roles placed only under
    // `protocols.matrix.memberRoles` are not root facts and cannot grant a role here.
    const roleEdges = set.filter(quad => quad.subject.termType === 'NamedNode'
      && quad.subject.value === metadataSubject && quad.predicate.value === memberRolesPredicate);
    if (roleEdges.length === 0) {
      return { roomId: matrixRoomId, memberRoles: {}, ...(binding ? { membershipAuthority: binding } : {}),
        ...(publication ? { membershipAuthorityPublication: publication } : {}), ...recovery };
    }
    // Roles are JSON facts: a non-`xsd:json` literal (plain/custom/language) is not the contract.
    if (roleEdges.length !== 1 || roleEdges[0].object.termType !== 'Literal'
      || roleEdges[0].object.datatype.value !== XSD_JSON) {
      return undefined;
    }
    let rawRoles: unknown;
    try {
      rawRoles = JSON.parse(roleEdges[0].object.value);
    } catch {
      return undefined;
    }
    const memberRoles = this.parseMemberRoles(rawRoles);
    if (memberRoles === undefined) {
      return undefined;
    }
    return { roomId: matrixRoomId, memberRoles, ...(binding ? { membershipAuthority: binding } : {}),
        ...(publication ? { membershipAuthorityPublication: publication } : {}), ...recovery };
  }

  private readRecoveryRecords(matrix: Record<string, unknown>): {
    membershipInvitations?: MembershipInvitations; membershipOperation?: MembershipOperation;
    membershipReadGrants?: MembershipReadGrants;
  } | undefined {
    const result: { membershipInvitations?: MembershipInvitations; membershipOperation?: MembershipOperation;
      membershipReadGrants?: MembershipReadGrants } = {};
    if (Object.prototype.hasOwnProperty.call(matrix, 'membershipInvitations')) {
      const parsed = parseMembershipInvitations(matrix.membershipInvitations);
      if (!parsed) return undefined;
      result.membershipInvitations = parsed;
    }
    if (Object.prototype.hasOwnProperty.call(matrix, 'membershipOperation')) {
      const parsed = parseMembershipOperation(matrix.membershipOperation);
      if (!parsed) return undefined;
      result.membershipOperation = parsed;
    }
    if (Object.prototype.hasOwnProperty.call(matrix, 'membershipReadGrants')) {
      const parsed = parseMembershipReadGrants(matrix.membershipReadGrants);
      if (!parsed) return undefined;
      result.membershipReadGrants = parsed;
    }
    return result;
  }

  /**
   * The current member roles for a *present* role record: an object whose keys are full WebIDs and
   * whose values are one of `owner`/`admin`/`member`. The caller only invokes this for an existing
   * role edge, so JSON `null` (an explicit but invalid record) and every other non-record shape is
   * malformed and fails closed; a missing role is never promoted to a default.
   */
  private parseMemberRoles(raw: unknown): Record<string, ChatMemberRole> | undefined {
    if (raw === null || raw === undefined || typeof raw !== 'object' || Array.isArray(raw)) {
      return undefined;
    }
    const roles: Record<string, ChatMemberRole> = {};
    for (const [ key, value ] of Object.entries(raw as Record<string, unknown>)) {
      if (!isAbsoluteHttpIri(key)) {
        return undefined;
      }
      if (typeof value !== 'string' || !MEMBER_ROLES.includes(value as ChatMemberRole)) {
        return undefined;
      }
      roles[key] = value as ChatMemberRole;
    }
    return roles;
  }
}

/** An absolute HTTP(S) URI: the only shape a NamedNode author/participant may take. */
/** Object key order is not evidence; complete values and array order are. */
function sameJsonValue(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (!left || !right || typeof left !== 'object' || typeof right !== 'object') return false;
  if (Array.isArray(left) || Array.isArray(right)) return Array.isArray(left) && Array.isArray(right)
    && left.length === right.length && left.every((value, index) => sameJsonValue(value, right[index]));
  const a = Object.keys(left); const b = Object.keys(right);
  return a.length === b.length && a.every(key => Object.prototype.hasOwnProperty.call(right, key)
    && sameJsonValue((left as Record<string, unknown>)[key], (right as Record<string, unknown>)[key]));
}

function isAbsoluteHttpIri(value: string): boolean {
  try {
    const url = new URL(value);
    return (url.protocol === 'https:' || url.protocol === 'http:') && url.username === '' && url.password === '';
  } catch {
    return false;
  }
}
