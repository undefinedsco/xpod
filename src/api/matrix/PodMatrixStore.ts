import { createHash, randomBytes } from 'node:crypto';
import { getLoggerFor } from 'global-logger-factory';
import { drizzle, alias, eq, and, or, gt, lt, lte, asc, desc, resolveRowSubject } from '@undefineds.co/drizzle-solid';
import { Parser as N3Parser, termToId, type Quad } from 'n3';
import {
  chatResource,
  messageResource,
  MessageRole,
  MessageStatus,
  threadResource,
  runResource,
  runStepResource,
  deliveryResource,
} from '@undefineds.co/models';
import {
  normalizeAgentUris,
  normalizeReconcilerOwner,
  reconcilerCoordinationMetadata,
  type ReconcilerOwner,
  type ServerGroupReconcilerService,
} from '../reconciler';
import { getProtocolMetadata, withProtocolMetadata, type ProtocolMetadata } from '../protocol-metadata';
import { MatrixError } from './MatrixError';
import { isDeepStrictEqual } from 'node:util';
import { parseMembershipOperation, type MembershipOperation } from './membershipOperation';
import type { MembershipInviteProjectEvent } from './membershipLifecycle';
import { inboundWriteAuthority } from './inboundAuthority';
import { eventIdForWrite, generateEventId } from './eventIdentity';
import { MEMBERSHIP_AUTHORITY_EVENT_TYPE, type MembershipAuthorityPublisher } from './membershipAuthorityPublication';
import { matrixPodWriteFor, type MatrixPodWrite } from './podAccess';
import type { MatrixControlRecordTarget } from './controlRecords';
import type { MatrixFederationActor } from './federation/outboundTransaction';
import {
  InMemoryMatrixEventJournal,
  parseReconcileCycleView,
  type MatrixEventJournal,
  type MatrixEventReference,
  type MatrixReconcileCheckpoint,
  type MatrixReconcileCycleView,
  type MatrixTransactionReservation,
} from './MatrixEventJournal';
import { buildPersistedEvent, readPersistedEvent, type PersistedEventInput, type PersistedMatrixEvent } from './persistedEvent';
import { roomGraphPosition } from './protocol/roomGraph';
import { storedGraphEvent, storedProtocolEvent } from './storedEvent';
import { MatrixRoomState, MatrixRoomStateReplay, resolveRoomState } from './roomState';
import { serverNameOf, SUPPORTED_ROOM_VERSION } from './protocol/authRules';
import { eventDestinations } from './federation/destinations';
import type { RemoteJoinOutcome } from './federation/remoteJoin';
import { matrixUserIdFor, webIdServerName } from './protocol/serverName';
import {
  roomChatIri,
  roomDirectoryIri,
  roomMessagesDocumentIri,
  roomSurfaceId,
  roomThreadIri,
} from './roomResources';
import {
  canonicalChatResourceId,
  decodeSourceBoundRoomId,
  encodeSourceBoundRoomId,
} from './canonicalRoomIdentity';
import type { CanonicalRoomSource } from './canonicalRoomSource';
import {
  buildConditionalEventWrite,
  canWriteConditionally,
  executeConditionalEventWrite,
  type ConditionalWriteDatabase,
} from './conditionalEventWrite';
import type { MatrixSigningIdentitySource } from './identityRegistry';
import { computeEventId } from './protocol/eventIntegrity';
import type { MatrixServiceIdentity } from './protocol/serviceIdentity';
import type { PodAccessFetchProvider } from '../ai-gateway/pod/OwnerPodAccess';
import type { SharedWakeAgentJob } from '../reconciler/coordination';
import { sharedWakeAgentJobId, type WakeAgentQueue } from '../reconciler/WakeAgentQueue';
import { isSolidAuth, type AuthContext } from '../auth/AuthContext';
import type {
  MatrixAccountInfo,
  MatrixClientEvent,
  MatrixCreateRoomRequest,
  MatrixEventRecord,
  MatrixRoomRecord,
  MatrixSendEventRequest,
  MatrixStoreContext,
  MatrixSyncResponse,
} from './types';

const schema = {
  chat: chatResource,
  thread: threadResource,
  message: messageResource,
  run: runResource,
  runStep: runStepResource,
  delivery: deliveryResource,
};

/** The tables a Matrix Pod handle registers, in one place for the store and its callers. */
const MATRIX_TABLES = [ chatResource, threadResource, runResource, runStepResource, deliveryResource, messageResource ];

/** One protected message column, derived once from the installed public models metadata. */
interface MessageColumnGuard {
  name: string;
  predicate: string;
  inverse: boolean;
  dataType: string;
}

let messageGuardColumns: MessageColumnGuard[] | undefined;
let messageGuardByName: Map<string, MessageColumnGuard> | undefined;

/**
 * The message columns and their declared predicate, direction and cardinality, read from the
 * installed public models metadata (`getPredicate`, `dataType`, `isInverse()`). Cached because the
 * winner guard runs on every conditional write.
 */
function messageColumnGuards(): { all: MessageColumnGuard[]; byName: Map<string, MessageColumnGuard> } {
  if (!messageGuardColumns || !messageGuardByName) {
    const all: MessageColumnGuard[] = [];
    const byName = new Map<string, MessageColumnGuard>();
    const namespace = messageResource.config.namespace;
    for (const [ name, column ] of Object.entries(messageResource as unknown as Record<string, {
      getPredicate?: (namespace: unknown) => string;
      dataType?: string;
      isInverse?: () => boolean;
    }>)) {
      if (!column || typeof column.getPredicate !== 'function' || typeof column.dataType !== 'string') {
        continue;
      }
      const guard: MessageColumnGuard = {
        name,
        predicate: String(column.getPredicate(namespace)),
        inverse: typeof column.isInverse === 'function' && Boolean(column.isInverse()),
        dataType: column.dataType,
      };
      if (guard.predicate === '@id') {
        continue;
      }
      all.push(guard);
      byName.set(name, guard);
    }
    messageGuardColumns = all;
    messageGuardByName = byName;
  }
  return { all: messageGuardColumns, byName: messageGuardByName };
}

/**
 * Provisioning a participant's own signing identity when they enter a room.
 *
 * Which participants a deployment serves as their own server is a deployment policy;
 * *when* it happens follows from the data: a participant becomes part of a room's
 * history with their join event, and that event is signed by the server in their
 * `sender`. Provisioning after the fact would leave the same person with two MXIDs in
 * one room, so this runs before their first membership event is written.
 */
export interface MatrixParticipantIdentityRequest {
  /** The participant about to enter the room. */
  webId: string;
  /** The Pod this write targets; their own Pod may differ when a shared room Pod is selected. */
  targetPodUrl?: string;
  context: MatrixStoreContext;
}

export interface MatrixParticipantIdentityProvider {
  /**
   * Make sure the participant has a signing identity this deployment may use, or return
   * without one when this deployment does not serve them (they stay on the deployment's
   * own server name). Throwing aborts the write: a join recorded under one identity and
   * later moved to another is worse than a refused join.
   */
  ensureParticipantIdentity(input: MatrixParticipantIdentityRequest): Promise<void>;
}

/**
 * Provisioning must not come later than the first time this deployment *names* the
 * participant. A Matrix user id is `@localpart:server`, and only the server half depends
 * on provisioning (the localpart is a hash of the WebID), so a participant named before
 * their key exists is named under the deployment's server — and an invite addressed to
 * that name would no longer match once they are provisioned. Provisioning therefore runs
 * before `getAccount` reports an MXID and before any event of theirs is written.
 *
 * Rooms recorded under an earlier name are history: their membership state keeps the
 * MXID it was written with. Serving those rooms again needs a per-room identity choice,
 * which is the legacy boundary rather than something provisioning can undo.
 */

/**
 * What changed in a Pod since the last indexing pass, when the deployment can tell.
 *
 * `sync` reads every room because a row written straight into the Pod has no journal sequence
 * until a read registers it, and a room's own watermark cannot say whether that happened. A
 * deployment that watches the Pod's resources (Solid notifications) *can* say, and then only
 * the rooms that changed have to be read. Absent means "cannot tell", and every room is read.
 */
export interface MatrixRoomDocumentChange {
  roomId: string;
  documentIri: string;
}

export interface MatrixRoomChangeSnapshot {
  trust: 'all' | 'changed';
  rooms: readonly string[];
  /** Exact document hints; absence never proves that other documents did not change. */
  documentChanges?: readonly MatrixRoomDocumentChange[];
  /** Rooms needing reconciliation beyond the document hints, such as a connection gap. */
  reconcileRooms?: readonly string[];
  /**
   * An opaque observation owned by the source, acknowledged after its reads succeed. A production
   * source hands back a serialized, authenticated token (a string); a custom test source may hand
   * back an object it keeps in memory.
   */
  snapshot?: string | object;
}

export interface MatrixRoomChangeSource {
  /**
   * The rooms with a change to pick up. `trust: 'all'` means the source cannot account for
   * everything (not watching, just started, dropped) and every room has to be read.
   */
  pending(input: { scope: string }): Promise<MatrixRoomChangeSnapshot>;
  /**
   * The pass has read those rooms. A source keeps reporting a change until this is called, so
   * a change that arrives while a pass runs is not forgotten.
   */
  settle(input: { scope: string; rooms: readonly string[]; documentChanges?: readonly MatrixRoomDocumentChange[]; reconcileRooms?: readonly string[]; snapshot?: string | object; full?: boolean }): Promise<void>;
}

/**
 * Where a locally written event goes so the other servers in the room learn about it.
 *
 * A port rather than the concrete queue: the store decides *what* the room's other servers
 * are, and the federation layer decides how a transaction reaches them. `MatrixOutbox`
 * satisfies this.
 */
export interface MatrixFederationOutbox {
  /**
   * `actor` is the participant whose authority the batch travels under (O1): a reference to the
   * WebID/Pod the live grant is resolved from at send time, never a credential.
   */
  enqueue(input: {
    scope: string;
    origin: string;
    destination: string;
    pdus: readonly unknown[];
    actor?: MatrixFederationActor;
  }): Promise<unknown>;
}

export interface PodMatrixStoreOptions {
  membershipAuthorityPublisher?: Pick<MembershipAuthorityPublisher, 'publish'>;
  publicationOutboxFor?: (write: MatrixPodWrite, context: MatrixStoreContext) => MatrixFederationOutbox;
  podAccess?: PodAccessFetchProvider;
  journal?: MatrixEventJournal;
  serverName?: string;
  serverGroupReconcilerService?: ServerGroupReconcilerService;
  /**
   * Signing identities by server name; absent means stored events carry no signature.
   * Every event is signed by the identity of the server named in its `sender`.
   */
  identities?: MatrixSigningIdentitySource;
  /**
   * How many rooms keep a resolved state in memory. `0` disables the cache, which
   * trades repeat replays for memory; the default bounds it at 64 rooms.
   */
  stateCacheLimit?: number;
  /** Supplies a participant's own signing identity as they enter a room. */
  participantIdentity?: MatrixParticipantIdentityProvider;
  /** Queues a written event for the other servers in the room; absent means local only. */
  outbound?: MatrixFederationOutbox;
  /** Tells `sync` which rooms changed; absent means every room is read every pass. */
  roomChanges?: MatrixRoomChangeSource;
  /**
   * How to join a room another deployment hosts: the specification's handshake, ending with the
   * room's state and auth chain for the caller to store. Absent means this deployment cannot ask a
   * resident server, and a remote join falls back to writing the membership event locally and
   * letting delivery carry it.
   */
  remoteJoin?: (request: {
    roomId: string;
    userId: string;
    /** The server named by the room id: the resident to ask. */
    destination: string;
    context: MatrixStoreContext;
    /**
     * The id and timestamp this join was first attempted with, persisted before the handshake.
     * A retry that lost the first response reuses them, so the room sees one join event and one
     * creation time rather than a second membership event under a fresh identity.
     */
    pending?: { eventId: string; originServerTs: number };
  }) => Promise<RemoteJoinOutcome | undefined>;
  /**
   * Resolving a room alias this deployment does not hold, by asking the server the alias names
   * (the specification's `/query/directory`). Absent means a remote alias is simply unknown here.
   */
  directoryQuery?: (request: {
    roomAlias: string;
    /** The server named by the alias: the one that can answer. */
    destination: string;
    context: MatrixStoreContext;
  }) => Promise<string | undefined>;
  /**
   * How often every room is read anyway, so a change the source missed is picked up. Defaults
   * to five minutes; `0` makes every pass a full one, i.e. the source is never trusted.
   */
  roomChangeFullPassMs?: number;
  /**
   * The clock that stamps events and decides their day bucket, in epoch milliseconds.
   *
   * Defaults to `Date.now`. A test that needs to cross a day boundary injects this rather than
   * faking global time: faking `Date` also backdates the DPoP proof on the authenticated fetch
   * (`iat`), which the issuer rightly refuses, so the fix belongs at the storage clock — auth
   * keeps the real time. Queues and lease deadlines deliberately keep using wall time.
   */
  clock?: () => number;
  /**
   * Queue each outbound batch with the participant whose authority it travels under (O1).
   *
   * Enabled in the production wiring, where the outbound sender resolves that participant's live
   * grant. Off by default so in-memory harnesses that exercise the legacy signed transport keep
   * their established behaviour; it changes only *what is queued*, never the local write.
   */
  deliverAsActor?: boolean;
  /**
   * The canonical source port, used **before any write** to prove the caller owns the exact
   * registered Pod a new room's canonical Chat will live in (`assertCreationOwner`). Absent means the
   * store cannot qualify creation and refuses it rather than writing under an unproven owner.
   */
  canonicalSource?: Pick<CanonicalRoomSource, 'assertCreationOwner'> & Partial<Pick<CanonicalRoomSource, 'assertActorPod' | 'assertRegisteredActorPod'>>;
}

type Db = any;
type JsonObjectSource = string | Record<string, unknown> | null | undefined;

interface MatrixRoomSource {
  id: string;
  title?: string | null;
  description?: string | null;
  author?: string | null;
  participants?: string[] | null;
  createdAt?: string | Date | null;
  metadata?: JsonObjectSource;
}

interface MatrixEventSource {
  id: string;
  parent?: string;
  maker?: string | null;
  content?: JsonObjectSource;
  role?: string;
  mentions?: string[] | null;
  routeTargetAgent?: string | null;
  createdAt?: string | Date | null;
  metadata?: JsonObjectSource;
}

interface MatrixRoomContext {
  metadata?: Record<string, unknown>;
  participants: string[];
}

export interface MatrixAgentGrant {
  agent: string;
  executor: string;
  workspace: string;
  allowedActors: string[];
  handoffTo: string[];
}

/** Whether a sync result carries anything a client has to be told about. */
function hasSyncNews(result: MatrixSyncResponse): boolean {
  return Object.values(result.rooms.join).some(room => room.timeline.events.length)
    || Object.keys(result.rooms.invite ?? {}).length > 0;
}

/** How many rooms keep a replay to answer repeat reads and extend on append. */
const STATE_CACHE_LIMIT = 64;

/** A plain object, as JSON fields must be. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export class PodMatrixStore {
  private readonly podAccess?: PodAccessFetchProvider;
  private readonly journal: MatrixEventJournal;
  private readonly identities?: MatrixSigningIdentitySource;
  private readonly participantIdentity?: MatrixParticipantIdentityProvider;
  private readonly outbound?: MatrixFederationOutbox;
  private readonly roomChanges?: MatrixRoomChangeSource;
  private readonly remoteJoin?: PodMatrixStoreOptions['remoteJoin'];
  private readonly directoryQuery?: PodMatrixStoreOptions['directoryQuery'];
  private readonly roomChangeFullPassMs: number;
  /** The watermark the last pass indexed: a caller at or above it is caught up. */
  private readonly indexedAt = new Map<string, number>();
  private readonly lastFullPassAt = new Map<string, number>();
  private readonly stateCache = new Map<string, MatrixRoomStateReplay>();
  private readonly stateCacheLimit: number;
  /**
   * In-process write locks keyed by logical event `(scope, roomId, eventId)`.
   *
   * A **partial** mitigation only, not the G03 guarantee. The read-then-insert sequence is not atomic
   * on its own: two concurrent requests served by *this* store instance for one logical key can both
   * miss the timeline read and both write, and the Solid insert then keeps each attempt's object value
   * as a separate triple under the same subject. The lock makes the second request served here read
   * back the first instead of inserting again. It does **not** cover a second store/process writing the
   * same Pod, and must never be described as if a deployment were the only writer of its Pod — that is
   * not accepted protocol design (root finding R08). The durable cross-writer guarantee requires the
   * upstream contract in `docs/issues/drizzle-solid-matrix-atomicity.md`; this map is only a
   * single-instance defense and is held just for the write decision.
   */
  private readonly eventWriteLocks = new Map<string, Promise<void>>();
  private readonly logger = getLoggerFor(this);
  private readonly serverName?: string;
  private readonly serverGroupReconcilerService?: ServerGroupReconcilerService;
  private readonly clock: () => number;
  private readonly deliverAsActor: boolean;
  private readonly canonicalSource?: Pick<CanonicalRoomSource, 'assertCreationOwner'> & Partial<Pick<CanonicalRoomSource, 'assertActorPod' | 'assertRegisteredActorPod'>>;
  private readonly membershipAuthorityPublisher?: Pick<MembershipAuthorityPublisher, 'publish'>;
  private readonly publicationOutboxFor?: PodMatrixStoreOptions['publicationOutboxFor'];

  public constructor(options: PodMatrixStoreOptions) {
    this.serverName = options.serverName;
    this.clock = options.clock ?? Date.now;
    this.deliverAsActor = options.deliverAsActor ?? false;
    this.canonicalSource = options.canonicalSource;
    this.membershipAuthorityPublisher = options.membershipAuthorityPublisher;
    this.publicationOutboxFor = options.publicationOutboxFor;
    this.podAccess = options.podAccess;
    this.journal = options.journal ?? new InMemoryMatrixEventJournal();
    this.identities = options.identities;
    this.participantIdentity = options.participantIdentity;
    this.outbound = options.outbound;
    this.roomChanges = options.roomChanges;
    this.remoteJoin = options.remoteJoin;
    this.directoryQuery = options.directoryQuery;
    this.roomChangeFullPassMs = options.roomChangeFullPassMs ?? 5 * 60 * 1000;
    this.stateCacheLimit = options.stateCacheLimit ?? STATE_CACHE_LIMIT;
    if (!Number.isSafeInteger(this.stateCacheLimit) || this.stateCacheLimit < 0) {
      throw new MatrixError(500, 'M_UNKNOWN', 'stateCacheLimit must be a non-negative integer');
    }
    this.serverGroupReconcilerService = options.serverGroupReconcilerService;
  }

  /** The storage/event clock. Auth, queues and lease deadlines keep wall time (see `clock`). */
  private now(): number {
    return this.clock();
  }

  /**
   * Run `task` while holding the in-process lock for one logical event.
   *
   * Calls for the same key run one after another in arrival order; calls for different keys stay
   * concurrent. Rejections from an earlier holder do not leak into a later waiter: the queue only
   * carries the gate, and the task's own result is returned to its own caller.
   */
  private async runExclusive<T>(key: string, task: () => Promise<T>): Promise<T> {
    const previous = this.eventWriteLocks.get(key) ?? Promise.resolve();
    let release: () => void = () => undefined;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const queued = previous.then(() => gate);
    this.eventWriteLocks.set(key, queued);
    await previous.catch(() => undefined);
    try {
      return await task();
    } finally {
      release();
      if (this.eventWriteLocks.get(key) === queued) this.eventWriteLocks.delete(key);
    }
  }

  public async getAccount(context: MatrixStoreContext): Promise<MatrixAccountInfo> {
    // The MXID reported here is the one others will invite, so it has to be final before
    // it is handed out — never the deployment-name fallback that provisioning would move.
    await this.ensureParticipantIdentity(context);
    const matrixUserId = this.getMatrixUserId(context);
    return {
      userId: matrixUserId,
      deviceId: this.deviceId(context),
      displayName: this.displayNameFromUserId(matrixUserId),
    };
  }

  public async createRoom(input: MatrixCreateRoomRequest, context: MatrixStoreContext): Promise<MatrixRoomRecord> {
    // Qualification precedes *any* effect: no getDb/init, no participant-identity mint, no Pod write.
    // The caller must be a Solid session matching the context, and must own the exact registered Pod
    // the new canonical Chat will live in. The chosen scope must be that exact registered root.
    if (!context.podUrl) {
      throw new MatrixError(403, 'M_FORBIDDEN', 'A new canonical room needs the caller Pod');
    }
    const canonicalSource = this.canonicalSource;
    if (!canonicalSource) {
      throw new MatrixError(403, 'M_FORBIDDEN', 'Canonical room creation is not available');
    }
    const scope = this.scope(context);
    // A random storage key -> exact public Chat IRI -> source-bound room id, validated (255 bytes)
    // before any write so an over-long id never reaches the Pod.
    const storageKey = this.randomId(18);
    const sourceIri = chatResource.buildIri(scope, { id: storageKey });
    // The exact public id that addresses this source. A null here means the chosen scope is not a
    // strict canonical Chat root the public builder reproduces: fail closed *before* any effect
    // rather than silently writing a hashed mirror while naming the room by its source.
    const chatId = canonicalChatResourceId(sourceIri, scope);
    if (chatId === null) {
      throw new MatrixError(403, 'M_FORBIDDEN', 'The new room scope is not a canonical Chat root');
    }
    let roomId: string;
    try {
      roomId = encodeSourceBoundRoomId(sourceIri);
    } catch {
      throw new MatrixError(400, 'M_BAD_JSON', 'The new room identity could not be encoded');
    }
    const { sourceRoot } = await canonicalSource.assertCreationOwner(sourceIri, context);
    // The context Pod must be *exactly* the chosen registered canonical root; a spelling that
    // normalisation would equate (e.g. a missing trailing slash) must not silently move the Pod.
    if (scope !== sourceRoot) {
      throw new MatrixError(403, 'M_FORBIDDEN', 'The new room must be created in the chosen registered Pod');
    }

    for (const state of input.initial_state ?? []) {
      if (['m.room.create', 'm.room.member', 'm.room.encryption'].includes(state.type)) {
        throw new MatrixError(400, 'M_BAD_JSON', 'Unsupported initial state event');
      }
      if (state.type === 'co.undefineds.agents') this.validateAgentGrants(state.content ?? {});
    }
    if (input.creation_content?.room_version && input.creation_content.room_version !== SUPPORTED_ROOM_VERSION) {
      throw new MatrixError(400, 'M_UNSUPPORTED_ROOM_VERSION', `Only room version ${SUPPORTED_ROOM_VERSION} is supported`);
    }
    // Absent `m.federate` means the room federates, as the create event defines it. A
    // room whose participants are on different servers (the distributed target) must
    // not opt out, so only an explicit `false` is written.
    const federate = input.creation_content?.['m.federate'] !== false;
    const db = await this.getDb(context);
    await this.ensureParticipantIdentity(context);
    const sender = this.getMatrixUserId(context);
    const now = this.now();
    const threadId = this.threadResourceId(roomId, scope);
    const reconcilerOwner = 'server' as const;
    const coordination = reconcilerCoordinationMetadata(reconcilerOwner);

    await db.insert(chatResource).values({
      id: chatId,
      title: input.name ?? roomId,
      description: input.topic ?? null,
      author: context.webId,
      status: 'active',
      participants: [context.webId],
      metadata: withProtocolMetadata({
        '@id': `${this.chatIri(roomId, context)}/metadata`,
        protocol: 'matrix',
        // The shared ChatMetadata role map is the sole generic role truth: the creator is owner.
        memberRoles: { [context.webId]: 'owner' },
        ...coordination,
      }, 'matrix', {
        roomId,
        canonicalAlias: input.room_alias_name ? `#${input.room_alias_name}:${this.getServerName(context)}` : null,
        visibility: input.visibility === 'public' ? 'public' : 'private',
        roomVersion: String(input.creation_content?.room_version ?? SUPPORTED_ROOM_VERSION),
        federate,
        preset: input.preset,
        invite: input.invite ?? [],
      }),
      createdAt: new Date(now).toISOString(),
      updatedAt: new Date(now).toISOString(),
    });
    await db.insert(threadResource).values({
      id: threadId,
      parent: this.chatIri(roomId, context),
      title: input.name ?? roomId,
      status: 'active',
      metadata: withProtocolMetadata({
        '@id': `${this.threadIri(roomId, context)}/metadata`,
        protocol: 'matrix',
        commandKind: 'chat',
        surface_id: this.surfaceIdFromRoomId(roomId),
        ...coordination,
      }, 'matrix', { roomId }),
      createdAt: new Date(now).toISOString(),
      updatedAt: new Date(now).toISOString(),
    });

    // The setup events form the start of the room's event graph: each one is
    // appended against what this call has already appended, so building a room
    // costs one Pod read fewer per event instead of re-reading the room each time.
    const appended: MatrixEventRecord[] = [];
    const append = async (event: {
      type: string;
      originServerTs: number;
      stateKey?: string;
      content: Record<string, unknown>;
    }): Promise<void> => {
      appended.push(await this.appendEvent(db, { roomId, reconcilerOwner, sender, ...event }, context, appended));
    };

    await append({
      type: 'm.room.create',
      originServerTs: now,
      stateKey: '',
      content: {
        // Room version 11 removed `creator` from create events (MSC3820); the
        // sender is the creator, and clients read it from there.
        room_version: String(input.creation_content?.room_version ?? SUPPORTED_ROOM_VERSION),
        type: input.creation_content?.type,
        ...(federate ? {} : { 'm.federate': false }),
      },
    });
    await append({
      type: 'm.room.member',
      originServerTs: now + 1,
      stateKey: sender,
      content: {
        membership: 'join',
        displayname: this.displayNameFromUserId(sender),
      },
    });
    if (input.name) {
      await append({ type: 'm.room.name', originServerTs: now + 2, stateKey: '', content: { name: input.name } });
    }
    if (input.topic) {
      await append({ type: 'm.room.topic', originServerTs: now + 3, stateKey: '', content: { topic: input.topic } });
    }
    // Who may join is a Matrix state fact, not a directory setting: without a join rule a room is
    // invite-only (the room version's default), so a "public" room that never says so is one nobody
    // can join — including a peer asking over federation. The preset decides it, and — as the
    // client-server API defines it — visibility decides the preset when the caller gave none.
    const declaredJoinRules = (input.initial_state ?? []).some(state => state.type === 'm.room.join_rules');
    if (!declaredJoinRules) {
      const isPublic = input.preset === 'public_chat'
        || (input.preset === undefined && input.visibility === 'public');
      await append({
        type: 'm.room.join_rules',
        originServerTs: now + 4,
        stateKey: '',
        content: { join_rule: isPublic ? 'public' : 'invite' },
      });
    }
    for (const state of input.initial_state ?? []) {
      await append({
        type: state.type,
        originServerTs: this.now(),
        stateKey: state.state_key ?? '',
        content: state.content ?? {},
      });
    }
    for (const invitee of input.invite ?? []) {
      // Each invite follows the previous one: the list passed in is the graph as it
      // stands, and the result is added to it for the next append.
      appended.push(await this.appendMembershipEvent(db, roomId, invitee, 'invite', context,
        { sender, reconcilerOwner, observed: appended }));
    }

    return {
      roomId,
      canonicalAlias: input.room_alias_name ? `#${input.room_alias_name}:${this.getServerName(context)}` : undefined,
      name: input.name,
      topic: input.topic,
      creator: sender,
      reconcilerOwner: coordination.reconcilerOwner,
      createdAt: now,
    };
  }

  public async joinRoom(roomIdOrAlias: string, context: MatrixStoreContext): Promise<{ roomId: string }> {
    const db = await this.getDb(context);
    const roomId = await this.resolveRoomId(db, roomIdOrAlias, context);
    const before = this.getMatrixUserId(context);
    let existing = await this.findLatestStateEvent(db, roomId, 'm.room.member', before, context);
    if (existing?.content.membership === 'join') return { roomId };

    // Entering the room is what makes the participant part of its history, so their own
    // signing identity has to exist before the join event names them — and provisioning
    // can *change* the MXID they are known by, so membership is looked up again under the
    // identity the event will actually carry.
    await this.ensureParticipantIdentity(context);
    const sender = this.getMatrixUserId(context);
    const banned = existing?.content.membership === 'ban';
    if (sender !== before) existing = await this.findLatestStateEvent(db, roomId, 'm.room.member', sender, context);
    if (existing?.content.membership === 'join') return { roomId };
    // A ban under either identity still blocks: provisioning must not be a way around one.
    if (banned || existing?.content.membership === 'ban') throw new MatrixError(403, 'M_FORBIDDEN', 'Banned from room');

    // A room this deployment does not host is joined the way the specification says: ask a
    // resident for a template, sign it, submit it, and take the room's state with it. This runs
    // before the local room record is required, because a room we have never heard of has none —
    // the resident's answer is what creates it here. Without a way to ask (no federation client),
    // the local path below still applies: the membership event is written here and delivery carries
    // it to the room's servers.
    const destination = serverNameOf(roomId);
    if (destination !== undefined && destination !== this.getServerName(context)) {
      if (await this.joinRemoteRoom(db, roomId, sender, destination, context)) return { roomId };
    }

    const room = await this.roomSource(db, roomId, context);
    if (existing?.content.membership !== 'invite' && room.author !== context.webId) {
      throw new MatrixError(403, 'M_FORBIDDEN', 'An invitation is required');
    }
    await this.appendMembershipEvent(db, roomId, sender, 'join', context);
    return { roomId };
  }

  /**
   * Join a room a resident server holds, and keep what the resident sends back.
   *
   * The state and auth chain that come with the join are stored the way any received event is —
   * verbatim, marked as received — because they are copies of somebody else's events, and they are
   * what lets this Pod authorise the room's later events. Our own join is not a copy: it is written
   * through the local path with the event we actually submitted (the resident's signature included),
   * so the row belongs to this participant rather than looking like a stranger's event.
   *
   * `false` means this deployment cannot do the handshake at all, and the caller falls back.
   */
  private async joinRemoteRoom(
    db: Db,
    roomId: string,
    userId: string,
    destination: string,
    context: MatrixStoreContext,
  ): Promise<boolean> {
    const remoteJoin = this.remoteJoin;
    if (!remoteJoin) return false;
    const existing = await this.findLatestStateEvent(db, roomId, 'm.room.member', userId, context);
    if (existing?.content.membership === 'join') return true;
    if (existing?.content.membership === 'ban') throw new MatrixError(403, 'M_FORBIDDEN', 'Banned from room');

    // The pending join is named before the handshake and kept under a key that only names the
    // logical join — the room and the participant. A response lost after the resident accepted the
    // join is then retried with the same id and timestamp, so the room never sees two membership
    // events for one join. Naming a fresh id on each attempt is what the previous code did, and it
    // cannot be fixed by a comment: the reservation is what makes the retry reuse it.
    const pendingKey = JSON.stringify([ 'remote-join', roomId, userId ]);
    const pending = await this.journal.reserveTransaction(
      this.scope(context),
      pendingKey,
      {
        eventId: eventIdForWrite(undefined),
        createdAt: this.now(),
        contentHash: this.hash(this.canonicalJson([ 'remote-join', roomId, userId, destination ])),
      },
      await this.reservationAuthority(context),
    );
    const outcome = await remoteJoin({
      roomId, userId, destination, context,
      pending: { eventId: pending.eventId, originServerTs: pending.createdAt },
    });
    if (!outcome) return false;
    if (outcome.status !== 'joined') {
      throw outcome.status === 'rejected'
        ? new MatrixError(403, 'M_FORBIDDEN', outcome.reason)
        : new MatrixError(503, 'M_UNKNOWN', outcome.reason);
    }

    // Oldest first, so the create event exists before anything that authorises against it.
    for (const event of [ ...outcome.authChain, ...outcome.state ]) {
      await this.acceptReceivedEvent({ event, context });
    }
    await this.appendEvent(db, {
      roomId,
      type: 'm.room.member',
      sender: userId,
      originServerTs: Number(outcome.event.origin_server_ts ?? this.now()),
      stateKey: userId,
      content: (isRecord(outcome.event.content) ? outcome.event.content : { membership: 'join' }),
      event: outcome.event as PersistedMatrixEvent,
    // The resident's own join event names the auth events it was accepted against, and those were
    // just accepted into this Pod, so the local timeline is what resolves them. Passing the
    // resident's whole state instead would hand the rules auth events the event never named — which
    // is exactly what rule 2.2 refuses.
    }, context, await this.listEvents(db, roomId, context));
    return true;
  }

  /** Internal membership projection adapter; not an HTTP action or a source-owner capability. */
  public async projectMembershipInvite(input: Parameters<MembershipInviteProjectEvent>[0]): Promise<MatrixEventRecord> {
    const operation = parseMembershipOperation(input.operation);
    if (!operation || operation.kind !== 'invite' || !['committed', 'complete'].includes(operation.phase)
      || typeof input.validateCommitted !== 'function') throw new MatrixError(400, 'M_INVALID_PARAM', 'A strict invitation operation is required');
    const caller = input.actor;
    const source = this.canonicalSource;
    if (caller.service || !caller.auth || !isSolidAuth(caller.auth) || caller.auth.webId !== caller.webId
      || !source?.assertActorPod || !source.assertRegisteredActorPod || !this.podAccess) {
      throw new MatrixError(403, 'M_FORBIDDEN', 'Original caller membership transport is required');
    }
    const selected = await source.assertActorPod(caller);
    await source.assertRegisteredActorPod(operation.actor);
    if (!input.existingOnly && (operation.actor.webId !== caller.webId || operation.actor.podUrl !== selected.podUrl)) {
      throw new MatrixError(403, 'M_FORBIDDEN', 'Only the original actor may persist or register this invitation');
    }
    const context: MatrixStoreContext = { webId: caller.webId, podUrl: selected.podUrl, auth: { ...caller.auth } };
    const callerFetch = await this.podAccess.getPodFetch(context.webId, { auth: context.auth, podBaseUrl: context.podUrl });
    if (!callerFetch) throw new MatrixError(403, 'M_FORBIDDEN', 'The original caller transport is unavailable');
    const resourceId = this.messageResourceId(input.roomId, operation.operationId, operation.event.createdAt, operation.actor.podUrl);
    const confirmWinner = async(): Promise<MatrixEventRecord | undefined> => await this.readCommittedMessageFromPod(
      context, resourceId, input.roomId, operation.operationId, operation.actor.webId, { operation, fetch: callerFetch });
    const register = async(winner: MatrixEventRecord): Promise<MatrixEventRecord> => {
      await input.validateCommitted(winner);
      const reference = await this.journal.registerReference(selected.podUrl, { roomId: input.roomId,
        eventId: operation.operationId, createdAt: operation.event.createdAt,
        messageIri: messageResource.buildIri(operation.actor.podUrl, { id: resourceId }) });
      winner.depth = reference.sequence;
      return winner;
    };
    const existing = await confirmWinner();
    if (existing) {
      if (input.existingOnly) { await input.validateCommitted(existing); return existing; }
      return await register(existing);
    }
    if (input.existingOnly) throw new MatrixError(409, 'M_CONFLICT', 'The exact original actor invitation is absent');
    // Absence is now proven. Only the actor's own fresh caller context resolves a write handle.
    const write = await matrixPodWriteFor(context, { getPodFetch: async() => callerFetch });
    if (!canWriteConditionally(write.db)) throw new MatrixError(500, 'M_UNKNOWN', 'Membership persistence requires conditional Pod writes');
    const observed = await this.listEvents(write.db, input.roomId, context, { registerJournal: false });
    return await this.appendEvent(write.db, { roomId: input.roomId, type: 'm.room.member', stateKey: operation.targetWebId,
      sender: operation.actor.webId, maker: operation.actor.webId, eventId: operation.operationId,
      originServerTs: operation.event.createdAt, content: { ...operation.event.content },
      validateCommitted: input.validateCommitted, suppressQueue: true, confirmWinner }, context, observed);
  }

  public async inviteUser(roomId: string, userId: string, context: MatrixStoreContext): Promise<void> {
    const db = await this.getDb(context);
    await this.requireRoomOwner(db, roomId, context);
    // New membership keys are WebIDs. The `@localpart:server` form still appears in stored history
    // and is understood where history is read, but a *new* invite must name a WebID: writing an
    // MXID into member state would create a participant no Solid identity can authorise, which is
    // exactly the identity this protocol removed. History is read, never rewritten.
    if (webIdServerName(userId) === undefined) {
      throw new MatrixError(400, 'M_BAD_JSON', 'A new invite must name a WebID');
    }
    await this.appendMembershipEvent(db, roomId, userId, 'invite', context);
  }

  public async leaveRoom(roomId: string, context: MatrixStoreContext): Promise<void> {
    const db = await this.getDb(context);
    await this.requireJoined(db, roomId, context);
    await this.appendMembershipEvent(db, roomId, this.getMatrixUserId(context), 'leave', context);
  }

  public async sendEvent(roomId: string, eventType: string, txnId: string, content: MatrixSendEventRequest,
    context: MatrixStoreContext, options: { msgid?: string } = {}): Promise<MatrixEventRecord> {
    const db = await this.getDb(context);
    // The writer's id names this attempt before anything is read, so the per-key lock can be taken
    // ahead of the timeline read: a concurrent request for the same logical key then waits and sees
    // the first attempt's row instead of inserting a second copy under the same deterministic id.
    const writerEventId = eventIdForWrite(options.msgid);
    const lockKey = `${this.scope(context)}|${roomId}|${writerEventId}`;
    return this.runExclusive(lockKey, () =>
      this.sendEventLocked(db, roomId, eventType, txnId, content, context, writerEventId));
  }

  private async sendEventLocked(db: Db, roomId: string, eventType: string, txnId: string,
    content: MatrixSendEventRequest, context: MatrixStoreContext, writerEventId: string): Promise<MatrixEventRecord> {
    // Membership and grant checks share one timeline read; each extra read is a
    // full Pod document fetch with its own authorization cost.
    const events = await this.listEvents(db, roomId, context);
    await this.requireJoined(db, roomId, context, events);
    if (eventType !== 'm.room.message') throw new MatrixError(400, 'M_UNRECOGNIZED', 'Only m.room.message timeline events are supported');
    await this.authorizeTargets(db, roomId, content, context, events);
    const sender = this.getMatrixUserId(context);
    const contentHash = this.hash(this.canonicalJson(['user',context.webId,eventType,content]));
    // The logical key is `(roomId, eventId)`: a retry is the same event whatever transaction carried
    // it and whatever day it lands on. The room's own timeline is the authority, so the writer's id
    // is looked up there — not in a resource id rebuilt from the current clock, which is what put a
    // cross-day retry into a second document. `eventIdForWrite` names this attempt when the caller
    // did not, so an unnamed send can never collide with a stored event.
    const claimed = events.find(event => event.eventId === writerEventId);
    if (claimed) {
      const claimedHash = this.hash(this.canonicalJson(['user',claimed.senderWebId,claimed.type,claimed.content]));
      if (claimedHash !== contentHash) {
        throw new MatrixError(409, 'M_CONFLICT', 'Event id already names different content');
      }
      // Answering from the stored event must not run the wake chain again; `reconcileEvent` reads
      // the stored transaction's own receipt, so an already-delivered trigger stays delivered.
      claimed.depth = await this.journal.registerEvent(this.scope(context),roomId,claimed.eventId);
      await this.reconcileEvent(db, claimed, context, events);
      return claimed;
    }
    // The graph position is part of the event, so it is fixed before the id is
    // reserved — including on a replay, which therefore has to attach to the same
    // place as the first attempt rather than to whatever the room looks like now.
    const eventInput = {
      roomId, type: eventType, sender, content,
      // The writer names its own event: a client picks an id (random is fine) and reuses it on every
      // retry, which is what makes a replay land on the first attempt's event without a reservation
      // having to remember it. Without one the deployment names the event itself.
      eventId: writerEventId,
      ...this.graphPosition(events, { type: eventType, sender, content }),
    };
    const transactionKey = JSON.stringify([this.deviceId(context), roomId, eventType, txnId]);
    const { reservation } = await this.reserveEventTransaction(context, transactionKey, eventInput, contentHash);
    if (reservation.contentHash !== contentHash) {
      throw new MatrixError(409, 'M_CONFLICT', 'Transaction already reserved with different content');
    }
    // Idempotency is the logical key `(roomId, eventId)`, so it cannot be pinned to the transaction:
    // a retry carried by another txn, or a concurrent attempt that missed the timeline read above on
    // both sides, must still adopt the first attempt's id and creation time. Reserving the event id
    // itself is what makes that true; the transaction reservation above stays as the receipt the
    // wake path reads. Without this the first timestamp would depend on which txn happened to win.
    const identityKey = JSON.stringify([ 'event', roomId, reservation.eventId ]);
    const identity = await this.journal.reserveTransaction(this.scope(context), identityKey, {
      eventId: reservation.eventId, createdAt: reservation.createdAt, contentHash,
    }, await this.reservationAuthority(context));
    if (identity.contentHash !== contentHash) {
      throw new MatrixError(409, 'M_CONFLICT', 'Event id already names different content');
    }
    // A retry whose first attempt completed is answered from the Pod: the event is
    // already there, so nothing is rebuilt, re-signed or written again.
    const source = await db.findById(messageResource,this.messageResourceId(roomId,identity.eventId,identity.createdAt,this.scope(context)));
    if (source) {
      const existing = this.eventSourceToRecord(source,roomId,context);
      if (identity.contentHash !== this.hash(this.canonicalJson(['user',existing.senderWebId,existing.type,existing.content]))) {
        throw new MatrixError(409,'M_CONFLICT','Stored event no longer matches its receipt');
      }
      existing.depth = await this.journal.registerEvent(this.scope(context),roomId,existing.eventId);
      await this.reconcileEvent(db, existing, context);
      return existing;
    }
    const event = await this.eventForReservation(eventInput, identity, context);
    return this.appendEvent(db, { roomId, type: eventType, sender, txnId, txnDevice: this.deviceId(context),
      eventId: identity.eventId, originServerTs: identity.createdAt, content, event },
    context, events);
  }

  /**
   * The identity that signs for this caller's server, or `undefined` when events are
   * written unsigned. A registry in use answers only for the server names it holds
   * keys for, so asking for another name fails instead of mis-attributing the event.
   */
  private async signingIdentity(context: MatrixStoreContext): Promise<MatrixServiceIdentity | undefined> {
    if (!this.identities) return undefined;
    return this.identities.identityFor(this.getServerName(context));
  }

  private async reserveEventTransaction(
    context: MatrixStoreContext,
    key: string,
    input: Omit<PersistedEventInput, 'originServerTs' | 'eventId'>,
    contentHash: string,
  ): Promise<{ reservation: MatrixTransactionReservation; proposal: PersistedMatrixEvent }> {
    const identity = await this.signingIdentity(context);
    const proposal = buildPersistedEvent({ ...input, originServerTs: this.now() }, identity);
    const reservation = await this.journal.reserveTransaction(this.scope(context), key, {
      eventId: proposal.event_id!, createdAt: proposal.origin_server_ts as number, contentHash,
    }, await this.reservationAuthority(context));
    return { reservation, proposal };
  }

  /**
   * Build the event a reservation pins.
   *
   * The reservation owns the id and the timestamp: a retry that reserved a moment later, or under
   * another transaction, must still land on the event the first attempt reserved, so the event is
   * rebuilt from the reservation instead of from the clock. The id is the writer's to choose, so
   * there is no content-derived assertion to satisfy — a reservation simply names the event that
   * will exist.
   */
  private async eventForReservation(
    input: Omit<PersistedEventInput, 'originServerTs' | 'eventId'>,
    reservation: MatrixTransactionReservation,
    context: MatrixStoreContext,
  ): Promise<PersistedMatrixEvent> {
    return buildPersistedEvent({
      ...input,
      originServerTs: reservation.createdAt,
      eventId: reservation.eventId,
    }, await this.signingIdentity(context));
  }

  public async setState(roomId: string, eventType: string, stateKey: string, content: Record<string, unknown>,
    context: MatrixStoreContext): Promise<MatrixEventRecord> {
    if (eventType === MEMBERSHIP_AUTHORITY_EVENT_TYPE) {
      if (stateKey !== '' || !this.membershipAuthorityPublisher || (this.outbound && !this.publicationOutboxFor)) {
        throw new MatrixError(403, 'M_FORBIDDEN', 'Explicit membership publication is unavailable');
      }
      return await this.membershipAuthorityPublisher.publish(roomId, content, context, async input => {
        const { publication, binding, write, context: caller } = input;
        if (input.existingOnly) {
          const resourceId = this.messageResourceId(roomId, publication.eventId, publication.createdAt, this.scope(caller));
          const existing = await this.awaitCommittedWinner(write.db, resourceId, roomId, publication.eventId, caller, caller.webId);
          if (!existing) throw new MatrixError(409, 'M_CONFLICT', 'Completed publication has no persisted event');
          await input.validateCommitted(existing);
          if (input.queueOnly && this.outbound) {
            const timeline = await this.listEvents(write.db, roomId, caller);
            await this.queueFederationDelivery(roomId, caller, timeline, existing.event as unknown as PersistedMatrixEvent, {
              outbox: this.publicationOutboxFor!(write, caller),
              actor: { webId: caller.webId, podUrl: caller.podUrl, taskCredential: { ...input.authorityBinding } },
            });
          }
          return existing;
        }
        return await this.appendEvent(write.db, { roomId, type: eventType, stateKey: '',
          sender: caller.webId, maker: caller.webId, eventId: publication.eventId,
          originServerTs: publication.createdAt, content: { ...binding }, validateCommitted: input.validateCommitted,
          suppressQueue: true }, caller);
      });
    }
    const db = await this.getDb(context);
    await this.requireJoined(db, roomId, context);
    await this.requireRoomOwner(db, roomId, context);
    if (['m.room.create', 'm.room.member', 'm.room.encryption'].includes(eventType)) {
      throw new MatrixError(403, 'M_FORBIDDEN', 'Use membership operations; immutable/encrypted state is unsupported');
    }
    if (eventType === 'co.undefineds.agents') this.validateAgentGrants(content);
    // The grant state as it was *before* this write: the diff has to be against the previous
    // version, which is why it is read here and not after the new state exists.
    const previousGrants = eventType === 'co.undefineds.agents' && stateKey === ''
      ? await this.findLatestStateEvent(db, roomId, eventType, '', context)
      : undefined;
    const alreadyGranted = eventType === 'co.undefineds.agents' && stateKey === ''
      ? (previousGrants ? this.validateAgentGrants(previousGrants.content ?? {}) : []).map(grant => grant.agent)
      : undefined;
    const record = await this.appendEvent(db, {roomId, type: eventType, sender: this.getMatrixUserId(context), stateKey,
      originServerTs: this.now(), content}, context);
    // Granting an agent is what makes it a member: the grant state is set through an ordinary state
    // write, and an agent with execution rights but no membership would be an agent the write path
    // has to special-case for ever. The two events are the ordinary membership pair — an invite by
    // the member who granted it, and the agent's own join — signed by this deployment because the
    // agent's MXID lives under its server name (`matrixUserIdFor`).
    if (alreadyGranted !== undefined) {
      await this.admitGrantedAgents(db, roomId, content, context, alreadyGranted);
    }
    return record;
  }

  /**
   * The membership events that make a newly granted agent a room member.
   *
   * Diffed against the previous grant state rather than re-deriving every time: an agent that was
   * already granted is already a member, and writing its membership again would append room history
   * for nothing. Agents that *lost* their grant keep it simple here — the grant state is what
   * authorises execution, and a member without a grant cannot execute; revoking membership as well
   * is a separate decision (recorded in the register) rather than something to guess at here.
   */
  private async admitGrantedAgents(
    db: Db,
    roomId: string,
    content: Record<string, unknown>,
    context: MatrixStoreContext,
    knownAgents: readonly string[],
  ): Promise<void> {
    const known = new Set(knownAgents);
    const pending = this.validateAgentGrants(content).map(grant => grant.agent).filter(agent => !known.has(agent));
    if (pending.length === 0) return;
    const granter = this.getMatrixUserId(context);
    const state = this.resolvedState(roomId, context, await this.listEvents(db, roomId, context));
    for (const agent of pending) {
      // The agent's identity is its own URI, stated by the grant: no derivation, no server name.
      const agentUserId = agent;
      const membership = state.get('m.room.member', agentUserId)?.content.membership;
      // Write only the step that is missing. A re-grant after a revocation leaves an agent that is
      // still a member, and a second invite would be history for nothing — the room's own rules
      // refuse it (v11-4.4.3), which is how this was found.
      //
      // A banned agent is not restored here: undoing a ban is the room owner's decision, not a side
      // effect of handing out execution rights. Granting it stops at the grant.
      if (membership === 'join' || membership === 'ban') continue;
      if (membership !== 'invite') {
        await this.appendMembershipEvent(db, roomId, agentUserId, 'invite', context, { sender: granter });
      }
      await this.appendMembershipEvent(db, roomId, agentUserId, 'join', context, { sender: agentUserId });
    }
  }

  public async sync(context: MatrixStoreContext, options: { since?: string; limit?: number; timeout?: number; signal?: AbortSignal } = {}): Promise<MatrixSyncResponse> {
    const deadline = Date.now() + Math.min(Math.max(options.timeout ?? 0, 0), 30_000);
    const scope = this.scope(context);
    const cursor = this.parseSyncCursor(options.since);
    const since = cursor ? cursor.position : this.parseSyncToken(options.since);
    let firstRead = true;
    const read = async (): Promise<MatrixSyncResponse> => {
      // Without a notification source, retain the bounded journal polling after this call's
      // initial authoritative indexing pass. The next call still starts by reading the Pod.
      if (!this.roomChanges && !firstRead) return await this.syncOnce(context, options, { indexed: true });
      // Observe before every read, including forced full passes. Each call owns its observation
      // so concurrent syncs cannot acknowledge each other's newer notifications.
      const pending = await this.roomChanges?.pending({ scope });
      const indexed = this.indexedAt.get(scope);
      const lastFull = this.lastFullPassAt.get(scope);
      const due = lastFull === undefined || Date.now() - lastFull >= this.roomChangeFullPassMs;
      // An unavailable source requires a full pull at the start of every sync and when the
      // safety net is due, not on every 500ms wait. Reconnect/unknown-change observations carry
      // rooms and still trigger authoritative reads immediately; local journal news can wake
      // an otherwise quiet poll. A subsequent request always pulls again while untrusted.
      if (!firstRead && pending?.trust === 'all' && pending.rooms.length === 0 && !due) {
        return await this.syncOnce(context, options, { indexed: true });
      }
      const full = !pending || pending.trust === 'all' || indexed === undefined || since < indexed ||
        due;
      const rooms = full ? undefined : pending.rooms;
      // Each completed room's cycle carries the observation it was observed under. Rooms observed
      // under different cycles are settled under their own observation, never under the request's
      // latest pending — a completed old cycle must not clear a newer hint it never read.
      const completed = new Map<string | object, { rooms: string[]; sameAsRequest: boolean }>();
      const requestedObservation = pending?.snapshot;
      let allSameAsRequest = true;
      let completedFull = false;
      const discover = async(roomIds: readonly string[]): Promise<boolean> => {
        const db = await this.getDb(context);
        let complete = true;
        for (const roomId of roomIds) {
          const scan = await this.discoverRoomReferences(db, context, roomId, requestedObservation);
          if (!scan.completed) { complete = false; continue; }
          // A source with no observation settles by rooms; a source with one groups by its cycle
          // observation (which may differ from the request's latest pending).
          if (requestedObservation === undefined) {
            const legacy = completed.get('legacy') ?? { rooms: [], sameAsRequest: true };
            legacy.rooms.push(roomId);
            completed.set('legacy', legacy);
            continue;
          }
          if (scan.observation === undefined) { complete = false; continue; }
          const observation = scan.observation;
          const sameAsRequest = observation === requestedObservation;
          if (!sameAsRequest) allSameAsRequest = false;
          const key = typeof observation === 'string' ? observation : observation as object;
          const group = completed.get(key) ?? { rooms: [], sameAsRequest };
          group.rooms.push(roomId);
          completed.set(key, group);
        }
        return complete;
      };
      if (!full && pending) {
        const hints = new Set([...pending.rooms, ...(pending.reconcileRooms ?? []),
          ...(pending.documentChanges ?? []).map(change => change.roomId)]);
        await discover([...hints]);
      } else {
        const published = await this.journal.getPublishedReferenceWatermark(scope);
        const hasKnownRefs = cursor !== undefined && published > cursor.position;
        // Known API references may serve a normal page, but cannot postpone a due safety pull.
        if (pending || (firstRead && (!hasKnownRefs || due))) {
          const db = await this.getDb(context);
          completedFull = await discover((await this.listRooms(db)).map(room => room.roomId));
        }
      }
      // A discovery pass never constructs a client response; hydrate the selected window once.
      const result = await this.syncOnce(context, options, { rooms });
      firstRead = false;
      // `full:true` clears uncertainty only when the whole actual scope was completed AND every room
      // was observed under this request's SAME observation. A mixed-cycle full pass stays conservative.
      // A source that carries no observation at all keeps the legacy room-based settlement.
      const observes = requestedObservation !== undefined;
      const canClearFull = completedFull && (!observes || allSameAsRequest);
      if (canClearFull) this.lastFullPassAt.set(scope, Date.now());
      if (pending) {
        if (canClearFull) {
          await this.roomChanges?.settle({ scope, rooms: pending.rooms, ...(observes ? { snapshot: pending.snapshot } : {}), full: true });
        } else {
          for (const [ observation, group ] of completed) {
            if ((group.sameAsRequest || !observes) && group.rooms.length > 0) {
              await this.roomChanges?.settle({ scope, rooms: group.rooms, snapshot: observation, full: false });
            }
          }
        }
      }
      return result;
    };

    let result = await read();
    while (!hasSyncNews(result) && !options.signal?.aborted && Date.now() < deadline) {
      await new Promise<void>((resolve) => {
        const done = (): void => { clearTimeout(timer); options.signal?.removeEventListener('abort', done); resolve(); };
        const timer = setTimeout(done, Math.min(500, Math.max(0, deadline - Date.now())));
        options.signal?.addEventListener('abort', done, { once: true });
      });
      result = await read();
    }
    return result;
  }

  private async syncOnce(
    context: MatrixStoreContext,
    options: { since?: string; limit?: number },
    state: { indexed?: boolean; rooms?: readonly string[] } = {},
  ): Promise<MatrixSyncResponse> {
    const db = await this.getDb(context);
    const scope = this.scope(context);
    const cursor = this.parseSyncCursor(options.since);
    const since = cursor ? cursor.position : this.parseSyncToken(options.since);
    const snapshot = await this.journal.getHighWatermark(scope);
    let limit = 50;
    if (options.limit !== undefined) {
      if (!Number.isFinite(options.limit) || options.limit < 1 || !Number.isSafeInteger(options.limit)) {
        throw new MatrixError(400, 'M_INVALID_PARAM', 'limit must be a positive integer');
      }
      limit = Math.min(options.limit, 1000);
    }
    // The cursor path runs first and independently of the notification room hints: empty hints are
    // discovery news, never a filter over the client's existing reference backlog.
    if (cursor) {
      return await this.syncFromCursor(context, db, cursor, limit);
    }
    // `state.rooms` is the caller's decision, already made against what the last pass indexed:
    // an empty list means nothing changed anywhere, and a list means only those rooms can hold
    // anything the caller does not have.
    const restricted = state.rooms;
    if (restricted && restricted.length === 0) {
      // Nothing changed anywhere, so no room needs reading at all. The token is positioned at the
      // current published watermark, so a later poll can extend past it when new refs appear.
      const published = await this.journal.getPublishedReferenceWatermark(scope);
      return {
        next_batch: this.encodeSyncCursor(await this.journal.getEpoch(scope), published, published),
        rooms: { join: {}, invite: {}, leave: {} },
      };
    }
    // Every event that could be reported has a sequence at or below the watermark, and
    // everything above `since` has already been read and indexed by an earlier pass.
    if (state.indexed && since >= snapshot) {
      return { next_batch: await this.nextSyncCursor(scope, since), rooms: { join: {}, invite: {}, leave: {} } };
    }
    const join: MatrixSyncResponse['rooms']['join'] = {};
    const invite: NonNullable<MatrixSyncResponse['rooms']['invite']> = {};
    const leave: NonNullable<MatrixSyncResponse['rooms']['leave']> = {};
    const batches: Array<{room: MatrixRoomRecord; events: MatrixEventRecord[]}> = [];
    const roomsToRead = restricted === undefined
      ? await this.listRooms(db)
      : (await this.listRooms(db)).filter(room => restricted.includes(room.roomId));
    for (const room of roomsToRead) {
      const events = (await this.listEvents(db, room.roomId, context)).filter(e=>e.depth! <= snapshot);
      const membership = this.resolvedState(room.roomId, context, events).get('m.room.member', this.getMatrixUserId(context));
      if (membership?.content.membership === 'invite') {
        if ((membership.depth ?? 0) > since) invite[room.roomId] = { invite_state: { events: [this.toClientEvent(membership)] } };
        continue;
      }
      if (membership?.content.membership === 'leave' || membership?.content.membership === 'ban') {
        if ((membership.depth ?? 0) > since) leave[room.roomId] = {timeline: {events: [this.toClientEvent(membership)], limited: false}};
        continue;
      }
      if (membership?.content.membership !== 'join' && room.creator !== context.webId) continue;
      batches.push({room, events});
    }
    const candidates = batches.flatMap(b => b.events).filter(e => (e.depth ?? 0) > since)
      .sort((a,b) => (a.depth ?? 0) - (b.depth ?? 0));
    const selected = candidates.slice(0, limit);
    const ids = new Set(selected.map(e => e.eventId));
    for (const {room, events} of batches) {
      const page = events.filter(e => ids.has(e.eventId));
      const firstSequence = page[0]?.depth ?? since;
      // State at the start of this timeline; events in the timeline apply after it.
      // Resolving the prefix rather than taking the last event per slot matters when
      // the history before the page contains a fork.
      // The page-start state is a different event list, so it is memoized under its own
      // key rather than displacing the room's current state.
      const state = this.resolvedState(`${room.roomId}@${firstSequence}`, context,
        events.filter(event => (event.depth ?? 0) < firstSequence));
      join[room.roomId] = {state: {events: state.events().map(e=>this.toClientEvent(e))},
        timeline: {events: page.map(e=>this.toClientEvent(e)), limited: candidates.length > selected.length,
          ...(page.length ? {prev_batch: this.encodeSyncToken((page[0].depth ?? 1) - 1)} : {})},
        'co.undefineds.coordination': {reconcilerOwner: room.reconcilerOwner}};
    }
    // The pass has indexed everything the Pod held at this watermark, so a caller at or above
    // it is caught up and the change source can be trusted for the next one.
    this.indexedAt.set(this.scope(context), snapshot);
    const transitionPositions = [...Object.values(invite).flatMap(r=>r.invite_state.events), ...Object.values(leave).flatMap(r=>r.timeline.events)];
    // When a joined timeline has backlog, do not advance past its last delivered event.
    const next = selected.length ? selected[selected.length-1].depth! : since;
    const high = candidates.length === 0 && transitionPositions.length ? snapshot : next;
    return {next_batch: await this.nextSyncCursor(scope, high), rooms: {join, invite, leave}};
  }

  /**
   * The normal incremental read over a fixed published-reference window. It reads ONE scope-level
   * reference page (never per notification room, never the room history), hydrates each selected
   * reference by its exact IRI only, and verifies the canonical owner Chat before exposing events.
   * Discovery has already published native references. An empty window therefore returns an empty
   * response without reopening historical rows.
   */
  private async syncFromCursor(
    context: MatrixStoreContext,
    db: Db,
    cursor: { epoch: string; through: number; position: number },
    limit: number,
  ): Promise<MatrixSyncResponse> {
    const scope = this.scope(context);
    const epoch = await this.journal.getEpoch(scope);
    if (epoch !== cursor.epoch) {
      throw new MatrixError(400, 'M_UNKNOWN_POS', 'Cursor operational-index epoch changed; resync required');
    }
    const published = await this.journal.getPublishedReferenceWatermark(scope);
    if (cursor.through > published || cursor.position > published) {
      throw new MatrixError(400, 'M_UNKNOWN_POS', 'Cursor window exceeds the published source index');
    }
    // While backlog remains, keep the original fixed upper bound. Once the page reaches it, the next
    // poll may extend to a newer published watermark (so a late event is discovered).
    const through = cursor.position >= cursor.through ? published : cursor.through;
    const references = await this.journal.listReferences(scope, {
      afterSequence: cursor.position, throughSequence: through, limit: limit + 1,
    });
    if (references.length === 0) {
      return { next_batch: this.encodeSyncCursor(epoch, through, through),
        rooms: { join: {}, invite: {}, leave: {} } };
    }
    const selected = references.slice(0, limit);
    const rooms = [ ...new Set(selected.map(reference => reference.roomId)) ];
    for (const roomId of rooms) {
      await this.requireCanonicalOwnRoom(db, context, roomId);
    }
    const eventsByRoom = new Map<string, MatrixEventRecord[]>();
    for (const reference of selected) {
      if (!reference.messageIri) {
        throw new MatrixError(503, 'M_UNKNOWN', `Cursor reference ${reference.eventId} has no exact IRI`);
      }
      const findByIri = (db as { findByIri?: (table: unknown, iri: string) => Promise<MatrixEventSource | undefined> }).findByIri;
      const source = findByIri ? await findByIri.call(db, messageResource, reference.messageIri) : undefined;
      if (!source) {
        // Fail closed: the cursor must not advance past an event the caller cannot receive, and a
        // failed read must not acknowledge the discovery hint.
        throw new MatrixError(503, 'M_UNKNOWN', `Cursor reference ${reference.eventId} could not be resolved`);
      }
      const list = eventsByRoom.get(reference.roomId) ?? [];
      list.push(this.eventSourceToRecord(source, reference.roomId, context));
      eventsByRoom.set(reference.roomId, list);
    }
    const join: MatrixSyncResponse['rooms']['join'] = {};
    for (const [ roomId, events ] of eventsByRoom) {
      join[roomId] = {
        state: { events: [] },
        timeline: {
          events: events.map(event => this.toClientEvent(event)),
          limited: references.length > selected.length,
        },
      };
    }
    const position = selected.length ? selected[selected.length - 1].sequence : cursor.position;
    const nextThrough = position >= through ? published : through;
    return {
      next_batch: this.encodeSyncCursor(epoch, nextThrough, position),
      rooms: { join, invite: {}, leave: {} },
    };
  }

  /**
   * Bounded, durable, resumable discovery of one room's message references from the room directory.
   *
   * It reads ONE source page per call at the checkpoint's `(createdAt, sourceIri)` keyset, using the
   * room's scoped directory endpoint, and publishes the exact references plus the advanced
   * checkpoint in a single journal transaction. A brand-new (or rotated-complete) cycle starts from
   * the beginning; a page that has not exhausted the source leaves the room incomplete, so its hint
   * is retained and the next request resumes exactly at the next source row. A lost CAS publishes
   * nothing and leaves the room incomplete. The exact-document fast path is a later slice.
   */
  private async discoverRoomReferences(
    db: Db,
    context: MatrixStoreContext,
    roomId: string,
    observation?: string | object,
    pageSize = 500,
  ): Promise<{ completed: boolean; observation?: string | object }> {
    const scope = this.scope(context);
    const chatIri = this.chatIri(roomId, context);
    const pod = new URL(scope);
    const podPath = pod.pathname.endsWith('/') ? pod.pathname : `${pod.pathname}/`;
    const directory = roomDirectoryIri(scope, roomId);
    const epoch = await this.journal.getEpoch(scope);

    // Begin (or reset) only when there is no usable checkpoint: a new cycle, or one finished by an
    // earlier complete page. A stale-epoch checkpoint is intentionally left alone here — the caller's
    // explicit resync (bumpEpoch) is what invalidates old tokens; we never silently reset a live one.
    let checkpoint = await this.journal.getReconcileCheckpoint(scope, directory);
    if (!checkpoint || checkpoint.epoch !== epoch) {
      checkpoint = await this.journal.beginReconcileScan(scope, { sourceUri: directory, epoch });
    }
    const cursor = checkpoint.lastCreatedAt !== undefined && checkpoint.lastSourceIri !== undefined
      ? { at: new Date(checkpoint.lastCreatedAt), iri: checkpoint.lastSourceIri }
      : undefined;

    // LDP applies ORDER/LIMIT independently per document. A scoped endpoint orders the
    // room's daily graphs together using the same public shared schema and caller fetch.
    const sourceTable = alias(messageResource, 'room_source_messages').$schema.table('room_source_messages', {
      base: directory, resourceMode: 'sparql', sparqlEndpoint: `${directory}-/sparql`, autoRegister: false,
    });
    const positionOf = (row: MatrixEventSource): { at: Date; iri: string } => {
      const iri = resolveRowSubject(row as unknown as Record<string, unknown>);
      let source: URL;
      try { source = new URL(iri ?? ''); } catch {
        throw new MatrixError(503, 'M_UNKNOWN', 'Source discovery did not return an absolute resource IRI');
      }
      const at = new Date(row.createdAt as string);
      if (!iri || !['http:', 'https:'].includes(source.protocol) || source.origin !== pod.origin ||
        !source.pathname.startsWith(podPath) || source.username || source.password || source.search || !source.hash ||
        row.parent !== chatIri || !Number.isFinite(at.getTime())) {
        throw new MatrixError(503, 'M_UNKNOWN', 'Source discovery returned an invalid message identity');
      }
      return { at, iri };
    };
    const compare = (a: { at: Date; iri: string }, b: { at: Date; iri: string }): number =>
      a.at.getTime() - b.at.getTime() || (a.iri < b.iri ? -1 : a.iri > b.iri ? 1 : 0);

    // Recover the cycle view: the bound one, or capture a fresh one on the first page of a cycle.
    let view: MatrixReconcileCycleView | undefined;
    let bindView: string | undefined;
    if (checkpoint.view !== undefined) {
      view = parseReconcileCycleView(checkpoint.view);
    } else if (cursor === undefined && checkpoint.roomCursor === undefined && checkpoint.bucketCursor === undefined) {
      // The fixed upper source keyset is captured with the SAME public scoped alias, DESC LIMIT 1 —
      // never Date.now — so a cycle is finite even with rows appended while it runs.
      // Notifications affect settlement, not whether the source cycle has a fixed bound.
      let upper: { createdAt: number; sourceIri: string } | null = null;
      const boundary = await db.select().from(sourceTable).where(eq(sourceTable.parent, chatIri))
        .orderBy(desc('createdAt'), desc('id')).limit(1) as MatrixEventSource[];
      if (boundary.length > 1) {
        throw new MatrixError(503, 'M_UNKNOWN', 'Source discovery exceeded its boundary read bound');
      }
      if (boundary.length > 0) {
        const top = positionOf(boundary[0]);
        upper = { createdAt: top.at.getTime(), sourceIri: top.iri };
      }
      view = { version: 1, upper, observation: typeof observation === 'string' ? observation : null };
      bindView = JSON.stringify(view);
    }
    // A first page whose cycle is bounded by an upper keyset must not read past it.
    const upper = view?.upper ?? null;

    const query = db.select().from(sourceTable).where(eq(sourceTable.parent, chatIri));
    if (cursor) {
      query.whereCursor(or(gt(sourceTable.createdAt, cursor.at),
        and(eq(sourceTable.createdAt, cursor.at), gt(sourceTable.id, cursor.iri))));
    }
    if (upper) {
      query.whereCursor(or(lt(sourceTable.createdAt, new Date(upper.createdAt)),
        and(eq(sourceTable.createdAt, new Date(upper.createdAt)), lte(sourceTable.id, upper.sourceIri))));
    }
    // An empty captured source belongs to this cycle; later appends belong to the next one.
    const sources = view?.upper === null ? []
      : await query.orderBy(asc('createdAt'), asc('id')).limit(pageSize) as MatrixEventSource[];
    // The backend must never return more than the declared page bound; reject before any publish.
    if (sources.length > pageSize) {
      throw new MatrixError(503, 'M_UNKNOWN', 'Source discovery exceeded its declared page bound');
    }

    // Validate the whole page before publishing anything: a malformed later row exposes no prefix.
    const references: Omit<MatrixEventReference, 'scope' | 'sequence'>[] = [];
    let previous = cursor;
    for (const row of sources) {
      const position = positionOf(row);
      if (previous && compare(position, previous) <= 0) {
        throw new MatrixError(503, 'M_UNKNOWN', 'Source cursor did not advance in its declared order');
      }
      if (upper && compare(position, { at: new Date(upper.createdAt), iri: upper.sourceIri }) > 0) {
        throw new MatrixError(503, 'M_UNKNOWN', 'Source row exceeds the cycle upper keyset');
      }
      const record = this.eventSourceToRecord(row, roomId, context);
      if (record.roomId !== roomId || record.originServerTs !== position.at.getTime()) {
        throw new MatrixError(503, 'M_UNKNOWN', 'Source event identity disagrees with its RDF row');
      }
      references.push({
        roomId, eventId: record.eventId, messageIri: position.iri, createdAt: position.at.getTime(),
      });
      previous = position;
    }

    // A short (exhausted) page completes the cycle; a full page advances the keyset to its last
    // source row — the last SOURCE row even when every reference was already known.
    const complete = sources.length < pageSize;
    const published = await this.journal.publishReferencePage(scope, {
      sourceUri: directory,
      epoch: checkpoint.epoch,
      scanGeneration: checkpoint.scanGeneration,
      revision: checkpoint.revision,
      references,
      ...(complete || !previous
        ? {}
        : { next: { roomId, last: { createdAt: previous.at.getTime(), sourceIri: previous.iri } } }),
      complete,
      ...(bindView === undefined ? {} : { view: bindView }),
    });
    if (!published.advanced) {
      // A lost CAS (or a stale epoch) publishes nothing: keep the hint so a later request retries.
      return { completed: false };
    }
    if (!complete) {
      return { completed: false };
    }
    // The cycle's ORIGINAL observation settles it, taken from the view that was bound BEFORE this
    // page advanced (completion rotates the generation and clears the view). A serialized (string)
    // observation comes from the bound view; a single-page custom object observation may settle now,
    // but a resumed page must never settle a freshly supplied snapshot.
    const cycleObservation = view?.observation ?? undefined;
    const finalObservation = cycleObservation ?? (bindView !== undefined ? observation : undefined);
    return { completed: true, ...(finalObservation === undefined ? {} : { observation: finalObservation }) };
  }

  /**
   * Verify the canonical owner Chat for a room before its events are exposed. An unknown, unreadable
   * or non-owner authority fails closed (the temporary remote gap; the C2 read port is a later step).
   */
  private async requireCanonicalOwnRoom(db: Db, context: MatrixStoreContext, roomId: string): Promise<void> {
    const scope = this.scope(context);
    const chatIri = roomChatIri(scope, roomId);
    const findByIri = (db as { findByIri?: (table: unknown, iri: string) => Promise<MatrixEventSource | undefined> }).findByIri;
    const chat = (findByIri ? await findByIri.call(db, chatResource, chatIri) : undefined)
      ?? await db.findById(chatResource, this.chatResourceId(roomId, scope));
    if (!chat) {
      throw new MatrixError(403, 'M_FORBIDDEN', `Room ${roomId} authority is unavailable`);
    }
    const metadata = this.parseJsonObject(chat.metadata) ?? {};
    const matrix = getProtocolMetadata(metadata, 'matrix') ?? {};
    if (this.stringValue(matrix.roomId) !== roomId) {
      throw new MatrixError(403, 'M_FORBIDDEN', `Room ${roomId} authority does not match the hint`);
    }
    if (chat.author !== context.webId) {
      throw new MatrixError(403, 'M_FORBIDDEN', `Room ${roomId} is not owned by the caller`);
    }
  }

  private async nextSyncCursor(scope: string, position: number): Promise<string> {
    return this.encodeSyncCursor(
      await this.journal.getEpoch(scope),
      await this.journal.getPublishedReferenceWatermark(scope),
      position,
    );
  }

  public async listJoinedRooms(context: MatrixStoreContext): Promise<string[]> {
    const db = await this.getDb(context);
    return (await this.listJoinedRoomRecords(db, context)).map((room) => room.roomId);
  }

  public async getMembers(roomId: string, context: MatrixStoreContext): Promise<MatrixClientEvent[]> {
    const db = await this.getDb(context);
    await this.requireJoined(db, roomId, context);
    const state = await this.currentState(roomId, context);
    return state.events()
      .filter(event => event.type === 'm.room.member' && event.stateKey !== undefined)
      .sort((left, right) => (left.originServerTs - right.originServerTs) || ((left.depth ?? 0) - (right.depth ?? 0)))
      .map((event) => this.toClientEvent(event));
  }

  public async listMessages(roomId: string, context: MatrixStoreContext,
    options: { limit?: number; dir?: 'b' | 'f'; from?: string } = {}): Promise<{chunk: MatrixClientEvent[];start?:string;end:string}> {
    const db = await this.getDb(context);
    await this.requireJoined(db, roomId, context);
    const snapshot = await this.journal.getHighWatermark(this.scope(context));
    const all = (await this.listEvents(db, roomId, context)).filter(e=>e.depth! <= snapshot);
    const forward = options.dir === 'f';
    const from = options.from ? this.parseSyncToken(options.from) : (forward ? 0 : Number.MAX_SAFE_INTEGER);
    const events = all.filter(e=>forward ? e.depth! > from : e.depth! <= from);
    if (!forward) events.reverse();
    const page = events.slice(0,Math.min(Math.max(options.limit ?? 50,1),1000));
    const boundary = page.length ? page[page.length-1].depth! - (forward ? 0 : 1) : (forward ? from : 0);
    return {chunk:page.map(e=>this.toClientEvent(e)),start:options.from,end:this.encodeSyncToken(boundary)};
  }

  public async getEvent(roomId: string, eventId: string, context: MatrixStoreContext): Promise<MatrixClientEvent> {
    const db = await this.getDb(context);
    await this.requireJoined(db, roomId, context);
    const event = await this.findEventById(db, roomId, eventId, context);
    if (!event) {
      throw new MatrixError(404, 'M_NOT_FOUND', 'Event not found');
    }
    return this.toClientEvent(event);
  }

  public async getState(
    roomId: string,
    eventType: string,
    stateKey: string,
    context: MatrixStoreContext,
  ): Promise<Record<string, unknown>> {
    const db = await this.getDb(context);
    await this.requireJoined(db, roomId, context);
    // Resolved state, so a fork cannot make a stale or banned state event the answer.
    const event = (await this.currentState(roomId, context)).get(eventType, stateKey);
    if (!event) {
      throw new MatrixError(404, 'M_NOT_FOUND', 'State not found');
    }
    return event.content;
  }

  /**
   * The room a Pod holds under a room alias.
   *
   * This is what makes an alias answerable without a directory service: the room's own record is
   * the index and the alias is a field on it. No membership check, because the caller is a peer
   * asking which room an alias names — not a user reading a room they are not in.
   */
  public async findRoomByAlias(alias: string, context: MatrixStoreContext): Promise<MatrixRoomRecord | undefined> {
    const db = await this.getDb(context);
    return (await this.listRooms(db)).find(room => room.canonicalAlias === alias);
  }

  /**
   * The servers with a joined member in a room: who a peer should talk to about it.
   *
   * Derived from the room's resolved state by the same selection the outbound path uses, so an
   * answer about a room and a delivery to that room cannot disagree about who is in it.
   */
  public async roomServers(roomId: string, context: MatrixStoreContext): Promise<string[]> {
    return eventDestinations({ state: await this.currentState(roomId, context) });
  }

  /**
   * The room's events as protocol PDUs.
   *
   * This is the read federation answers are built from: an inbound transaction resolves the
   * `auth_events` a PDU names from here, and the read endpoints (`/state`, `/backfill`,
   * `/event_auth`) answer with the same events. It is deliberately not a client read — no
   * membership is required, because the caller is the deployment serving a peer on a Pod it
   * already holds events for, not a user reading somebody's room.
   *
   * Each PDU is returned with the id this store derived for it (the content hash, reference hash
   * and signature do not cover `event_id`, which is why attaching it is safe and why a row written
   * before the graph existed still carries one).
   */
  public async protocolEvents(roomId: string, context: MatrixStoreContext): Promise<Record<string, unknown>[]> {
    const db = await this.getDb(context);
    const records = await this.listEvents(db, roomId, context);
    return records.map(record => ({ ...storedProtocolEvent(record), event_id: record.eventId }));
  }

  /**
   * The queue the runtime and this store's reconciler already share. Exposed so
   * the API container does not have to resolve the same collaborator twice.
   */
  public getQueue(): WakeAgentQueue | undefined {
    return this.serverGroupReconcilerService?.getQueue();
  }

  /**
   * The queue written events are handed to, for whoever drives delivery (a notification, a
   * worker, an operator). Absent when this deployment does not federate.
   */
  public getOutbox(): MatrixFederationOutbox | undefined {
    return this.outbound;
  }

  /**
   * What tells a sync which rooms changed. Exposed for the same reason the queue is: a source the
   * store was never given makes every sync read every room, and nothing else would notice.
   */
  public getRoomChanges(): MatrixRoomChangeSource | undefined {
    return this.roomChanges;
  }

  /**
   * The database this store writes through, resolved by the one module that decides who a Matrix
   * write is done as (`podAccess.ts`). Everything that writes to a Pod in this subsystem goes
   * through that decision, including the control records, which need the same authority plus the
   * fetch underneath it.
   */
  private async getDb(context: MatrixStoreContext): Promise<Db> {
    const { db } = await matrixPodWriteFor(context, this.podAccess, {
      schema,
      tables: MATRIX_TABLES,
    });
    return db;
  }

  /**
   * The authorized Pod handle itself, for a caller that has to make its own HTTP write.
   *
   * A control-record reservation is a conditional request (`If-None-Match: *`), which is the one
   * write drizzle-solid cannot express — see `controlRecords.ts`. Handing out the fetch the
   * database was built over keeps that write under exactly the authority a store write has.
   */
  public async podWriteFor(context: MatrixStoreContext): Promise<MatrixPodWrite> {
    return await matrixPodWriteFor(context, this.podAccess, { schema, tables: MATRIX_TABLES });
  }

  /**
   * The handle a Pod-backed control-record store writes with: which Pod, and with whose authority.
   *
   * The two halves are resolved together on purpose. A record with a scope but no authority, or
   * authority for a different Pod, is the kind of mismatch that would put one participant's receipt
   * in another's Pod, so a context that does not name a Pod is refused here rather than defaulted.
   */
  public async controlRecordHandleFor(context: MatrixStoreContext): Promise<MatrixControlRecordTarget> {
    const scope = context.podUrl;
    if (!scope) {
      throw new MatrixError(400, 'M_INVALID_PARAM', 'A Matrix control record needs the Pod it belongs to');
    }
    return { scope, write: await this.podWriteFor(context) };
  }

  /**
   * Where the new event attaches: its parents, the events that authorise it, and
   * its depth. Read from the events the caller already has, so appending costs no
   * extra Pod read on the send path.
   */
  private graphPosition(
    events: readonly MatrixEventRecord[],
    input: { type: string; sender: string; stateKey?: string; content: Record<string, unknown> },
  ): { prevEvents: string[]; authEvents: string[]; depth: number } {
    return roomGraphPosition(events.map(storedGraphEvent), input);
  }

  private async appendEvent(
    db: Db,
    input: {
      roomId: string;
      type: string;
      sender: string;
      originServerTs: number;
      content: Record<string, unknown>;
      stateKey?: string;
      txnId?: string;
      /** The device whose reservation produced this event; see `MatrixEventRecord`. */
      txnDevice?: string;
      reconcilerOwner?: ReconcilerOwner;
      eventId?: string;
      role?: string;
      maker?: string;
      /** Already-built protocol event, so a caller that reserved an id can reuse it. */
      event?: PersistedMatrixEvent;
      /** Publication alone requires full winner identity/time proof before bookkeeping. */
      validateCommitted?: (record: MatrixEventRecord) => Promise<void>;
      /** Publication queues only after its canonical complete phase is confirmed. */
      suppressQueue?: true;
      /** Membership alone confirms its fixed original-actor RDF subject, without history fallback. */
      confirmWinner?: () => Promise<MatrixEventRecord | undefined>;

    },
    context: MatrixStoreContext,
    /** Events already read from this room; loaded here when the caller has none. */
    observed?: readonly MatrixEventRecord[],
  ): Promise<MatrixEventRecord> {
    if (input.confirmWinner && !canWriteConditionally(db)) throw new MatrixError(500, 'M_UNKNOWN', 'Membership persistence requires conditional Pod writes');
    const depth = 0;
    // One read answers the graph position and, when federation is on, who the room's other
    // servers are; both need the same timeline and neither may see a stale one.
    const timeline = observed ?? await this.listEvents(db, input.roomId, context);
    // The protocol event is built first: its content-derived id is the event's
    // identity, and the stored copy carries the hashes and signature that make
    // the event verifiable from the Pod alone.
    // An event this deployment initiates is named by this deployment, not by its content: a
    // content-derived id was the old self-proving shape, and it also made a replay depend on
    // rebuilding the exact same bytes. `input.event` is a peer's copy and keeps the id its author
    // gave it.
    const built = input.event ?? buildPersistedEvent({
      roomId: input.roomId,
      type: input.type,
      sender: input.sender,
      originServerTs: input.originServerTs,
      content: input.content,
      ...(input.stateKey === undefined ? {} : { stateKey: input.stateKey }),
      eventId: input.eventId ?? generateEventId(),
      ...this.graphPosition(timeline, input),
    }, await this.signingIdentity(context));
    // A caller-provided event can come from a peer — a resident's copy of our join — and carries no
    // id of its own. The id is derived here, and an event whose stated id disagrees with its content
    // is refused rather than stored under two identities.
    // An event's id is its writer's to choose — a client's `msgid`, or one the deployment generated
    // for an event it initiates. It is *not* derived from the content any more, so there is nothing
    // to compare it against here; what a copy is worth is decided by who wrote it and, for copies
    // read from elsewhere, by comparing with the author's own Pod.
    const derivedId = built.event_id ?? computeEventId(built);
    const persistedEvent = built.event_id === derivedId ? built : { ...built, event_id: derivedId };
    const eventId = derivedId;
    // What this protocol asks of a local write is membership and role, and both were checked by the
    // caller before it got here (`requireJoined`, `requireRoomOwner`, `authorizeTargets`). The room
    // version's rule set — power levels, auth-event chains, state resolution — is deliberately not
    // applied here: it belongs to the Matrix-shaped surface a peer may still speak, and enforcing it
    // on our own writes was the last thing making those rules load-bearing for this protocol.
    const originIso = new Date(input.originServerTs).toISOString();
    const needsRoomMetadata = input.reconcilerOwner === undefined
      || (input.type === 'm.room.message' && this.serverGroupReconcilerService !== undefined);
    const roomContext = needsRoomMetadata ? await this.getRoomContext(db, input.roomId, context) : undefined;
    const roomMetadata = roomContext?.metadata;
    const reconcilerOwner = input.reconcilerOwner ?? this.reconcilerOwnerFromRoomMetadata(roomMetadata);
    const coordination = reconcilerCoordinationMetadata(reconcilerOwner);
    const messageResourceId = this.messageResourceId(input.roomId, eventId, input.originServerTs, this.scope(context));
    const thread = this.threadIri(input.roomId, context);
    const contentText = this.messageContentFromMatrixEvent(input.type, input.content);
    const mentions = this.mentionsFromMatrixContent(input.content);
    const routeTargetAgent = this.routeTargetAgentFromMatrixContent(input.content);
    const record = {
      eventId,
      roomId: input.roomId,
      type: input.type,
      sender: input.sender,
      senderWebId: input.maker ?? context.webId,
      originServerTs: input.originServerTs,
      depth,
      role: input.role ?? (input.type === 'm.room.message' ? MessageRole.USER : MessageRole.SYSTEM),
      resourceId: messageResourceId,
      txnId: input.txnId ?? undefined,
      txnDevice: input.txnDevice ?? undefined,
      stateKey: input.stateKey ?? undefined,
      content: input.content,
      createdAt: originIso,
      event: persistedEvent as unknown as Record<string, unknown>,
    };
    const row = {
      id: messageResourceId,
      parent: this.chatIri(input.roomId, context),
      chat: this.chatIri(input.roomId, context),
      thread,
      maker: input.maker ?? context.webId,
      role: input.role ?? (input.type === 'm.room.message' ? MessageRole.USER : MessageRole.SYSTEM),
      content: contentText,
      status: MessageStatus.SENT,
      mentions,
      routeTargetAgent: routeTargetAgent ?? null,
      replyTo: typeof input.content['co.undefineds.replyTo'] === 'string' ? input.content['co.undefineds.replyTo'] : null,
      metadata: withProtocolMetadata({
        '@id': `${messageResource.buildIri(this.scope(context),{id:messageResourceId})}/metadata`,
        protocol: 'matrix',
        commandKind: 'chat',
        surface_id: this.surfaceIdFromRoomId(input.roomId),
        ...coordination,
      }, 'matrix', {
        // Verifiable protocol fact: hashes and signatures live in here.
        event: persistedEvent as unknown as ProtocolMetadata,
        // Application bookkeeping that is deliberately not part of the event:
        // putting it inside would change the canonical form and the event id.
        senderWebId: input.maker ?? context.webId,
        txnId: input.txnId ?? null,
        // The device whose reservation produced this event, so the event alone can lead back to it.
        txnDevice: input.txnDevice ?? null,
      }),
      createdAt: originIso,
      updatedAt: originIso,
    };
    // The row is written as a conditional first-writer insert against the room's canonical Chat
    // anchor, so two independent stores/processes racing the same logical `(roomId, eventId)` cannot
    // both create it. On a real Pod the ORM serializes the row and the authenticated scoped POST
    // carries the guard; the in-memory harness (no Pod) keeps the plain insert.
    let recovered: MatrixEventRecord | undefined;
    let usedConditional: boolean;
    try {
      usedConditional = await this.writeMessageRow(db, {
        roomId: input.roomId, eventId, originServerTs: input.originServerTs, row, context,
      });
    } catch (error) {
      if (!input.confirmWinner) throw error;
      // Only this exact strict subject may resolve an unknown write outcome. No room-wide search.
      recovered = await input.confirmWinner();
      if (!recovered) throw error;
      usedConditional = true;
    }
    let committed: MatrixEventRecord = record;
    if (usedConditional) {
      const winner = recovered ?? (input.confirmWinner ? await input.confirmWinner()
        : await this.awaitCommittedWinner(db, messageResourceId, input.roomId, eventId, context, input.sender));
      if (!winner) {
        throw new MatrixError(503, 'M_UNKNOWN', 'The event write could not be confirmed');
      }
      if (!this.sameEventSemantics(winner, record)) {
        throw new MatrixError(409, 'M_CONFLICT', 'Event id already names different content');
      }
      committed = winner;
    }

    if (!committed.event) throw new MatrixError(409, 'M_CONFLICT', 'Committed event has no persisted PDU');
    await input.validateCommitted?.(committed);

    const reference = await this.journal.registerReference(this.scope(context), {
      roomId: input.roomId,
      eventId,
      messageIri: messageResource.buildIri(this.scope(context), { id: messageResourceId }),
      createdAt: input.originServerTs,
    });
    committed.depth = reference.sequence;
    if (committed.role === MessageRole.USER) await this.reconcileEvent(db, committed, context);
    if (!input.suppressQueue) await this.queueFederationDelivery(input.roomId, context, timeline, committed.event as unknown as PersistedMatrixEvent);

    return committed;
  }

  /**
   * Read the committed copy of a conditional write, tolerating a short index-visibility lag.
   *
   * The sidecar commits the RDF authority and its read projection before releasing its lock, but a
   * concurrent writer's read can still race that projection by a few milliseconds. The write is
   * confirmed by a bounded re-read of the document-addressed row, then a room-wide fallback; if
   * neither ever shows the row the write is reported as unconfirmed rather than as success.
   */
  private async awaitCommittedWinner(
    db: Db,
    messageResourceId: string,
    roomId: string,
    eventId: string,
    context: MatrixStoreContext,
    expectedSender?: string,
  ): Promise<MatrixEventRecord | undefined> {
    // The committed RDF authority is the only place the protected scalar/relationship cardinality is
    // still visible; the ORM decoder can discard competing values before a row reaches us. There is
    // exactly ONE way to confirm a winner: the strict typed document guard. The ORM projection is
    // never trusted on its own.
    const direct = await this.readCommittedMessageFromPod(context, messageResourceId, roomId, eventId, expectedSender);
    if (direct) {
      return direct;
    }
    // The write may have lost to another day's document. Find the exact winner IRI with the room-wide
    // authoritative read, then validate THAT document with the same guard (never a repeated
    // candidate-day poll, and never the decoded row).
    const winner = await this.findEventById(db, roomId, eventId, context);
    if (winner?.resourceId) {
      return await this.readCommittedMessageFromPod(context, winner.resourceId, roomId, eventId, expectedSender);
    }
    return undefined;
  }

  /**
   * The committed message as the RDF authority holds it, read directly from its document.
   *
   * This is the strict guard: it requires the exact typed Message subject, exactly one models
   * metadata edge to exactly the expected metadata subject, exactly one literal `protocols` payload,
   * exactly one parent/maker/content term, the canonical room parent, maker/protocol provenance, and
   * all required protocol fields with their types. A malformed competitor — duplicate scalar, wrong
   * parent, extra edge, wrong provenance or missing field — must not confirm a winner.
   */
  private async readCommittedMessageFromPod(
    context: MatrixStoreContext,
    messageResourceId: string,
    roomId: string,
    eventId: string,
    expectedSender?: string,
    membership?: { operation: MembershipOperation; fetch: typeof fetch },
  ): Promise<MatrixEventRecord | undefined> {
    const scope = membership?.operation.actor.podUrl ?? this.scope(context);
    const invalid = (): undefined => {
      if (membership) throw new MatrixError(409, 'M_CONFLICT', 'The exact original actor PDU is malformed or differs');
      return undefined;
    };
    const messageIri = messageResource.buildIri(scope, { id: messageResourceId });
    const url = new URL(messageIri);
    url.hash = '';
    const readFetch = membership?.fetch ?? (await this.podWriteFor(context)).fetch;
    let response: Response;
    try {
      response = await readFetch(url.href, { headers: { Accept: 'text/turtle' }, ...(membership ? { redirect: 'error' as const } : {}) });
    } catch {
      if (membership) throw new MatrixError(403, 'M_FORBIDDEN', 'The original actor PDU could not be read');
      return undefined;
    }
    if (membership && (response.redirected || response.url !== url.href)) return invalid();
    if (membership && response.status === 404) return undefined;
    if (membership && response.status !== 200) {
      throw new MatrixError(403, 'M_FORBIDDEN', 'The complete original actor PDU document is unavailable');
    }
    if (!response.ok) {
      if (membership) throw new MatrixError(403, 'M_FORBIDDEN', 'The original actor PDU is unavailable');
      return undefined;
    }
    const ttl = await response.text();
    if (membership && !ttl.trim()) return invalid();
    const rdfType = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
    const guards = messageColumnGuards();
    const metadataGuard = guards.byName.get('metadata');
    if (!metadataGuard) {
      throw new MatrixError(500, 'M_UNKNOWN', 'The models message column metadata is unavailable');
    }
    const protocolsPredicate = `${metadataGuard.predicate.slice(0, metadataGuard.predicate.lastIndexOf('metadata'))}protocols`;
    // One parse pass, index outgoing (subject) and incoming (object) quads by predicate so every
    // guard check is a map lookup instead of a repeated store query. RDF is a set: identical quads
    // (same full term identity including literal datatype/language) are deduplicated before any
    // cardinality decision, so appending the exact same payload quad again is not a competitor. An
    // incoming edge only counts for identity when its object is a real NamedNode: a literal spelling
    // of the same IRI is a different term and never a subject-identity edge.
    const parsedQuads: Quad[] = [];
    const seenQuads = new Set<string>();
    let bodyQuads: Quad[];
    try { bodyQuads = new N3Parser({ baseIRI: url.href }).parse(ttl); } catch (error) {
      if (membership) return invalid();
      throw error;
    }
    for (const quad of bodyQuads) {
      const identity = `${termToId(quad.subject)}|${termToId(quad.predicate)}|${termToId(quad.object)}|${termToId(quad.graph)}`;
      if (seenQuads.has(identity)) {
        continue;
      }
      seenQuads.add(identity);
      parsedQuads.push(quad);
    }
    if (membership && !parsedQuads.some(q => q.subject.value === messageIri || q.subject.value === `${messageIri}/metadata`
      || (q.object.termType === 'NamedNode' && [messageIri, `${messageIri}/metadata`].includes(q.object.value)))) return undefined;
    const outgoing = new Map<string, Quad[]>();
    const incoming = new Map<string, Quad[]>();
    for (const quad of parsedQuads) {
      if (quad.subject.termType === 'NamedNode' && quad.subject.value === messageIri) {
        const list = outgoing.get(quad.predicate.value) ?? [];
        list.push(quad);
        outgoing.set(quad.predicate.value, list);
      }
      if (quad.object.termType === 'NamedNode' && quad.object.value === messageIri) {
        const list = incoming.get(quad.predicate.value) ?? [];
        list.push(quad);
        incoming.set(quad.predicate.value, list);
      }
    }
    const subjectQuads = (predicate: string): Quad[] => outgoing.get(predicate) ?? [];

    // Exactly one Message type on the exact subject.
    if (subjectQuads(rdfType).filter(quad => quad.object.termType === 'NamedNode'
      && quad.object.value === String(messageResource.config.type)).length !== 1) {
      return invalid();
    }
    // Exactly one metadata edge, and it must reach this resource's own metadata subject.
    const metadataEdges = subjectQuads(metadataGuard.predicate);
    if (metadataEdges.length !== 1 || metadataEdges[0].object.termType !== 'NamedNode'
      || metadataEdges[0].object.value !== `${messageIri}/metadata`) {
      return invalid();
    }
    // Exactly one literal protocol payload (a NamedNode or literal competitor fails closed).
    const metadataSubject = metadataEdges[0].object.value;
    const protocolTerms = parsedQuads.filter(quad =>
      quad.subject.value === metadataSubject && quad.predicate.value === protocolsPredicate);
    if (protocolTerms.length !== 1 || protocolTerms[0].object.termType !== 'Literal') {
      return invalid();
    }
    if (membership && (protocolTerms[0].object.termType !== 'Literal'
      || protocolTerms[0].object.datatype.value !== 'http://www.w3.org/2001/XMLSchema#json')) return invalid();
    let parsed: { matrix?: Record<string, unknown> };
    try {
      parsed = JSON.parse(protocolTerms[0].object.value) as { matrix?: Record<string, unknown> };
    } catch {
      return invalid();
    }
    const matrix = parsed.matrix;
    const event = matrix?.event as Record<string, unknown> | undefined;
    if (!event) {
      return invalid();
    }
    // Required protocol fields with types; no defaulted authority.
    if (typeof event.event_id !== 'string' || event.event_id !== eventId) {
      return invalid();
    }
    if (typeof event.room_id !== 'string' || event.room_id !== roomId) {
      return invalid();
    }
    if (typeof event.type !== 'string' || event.type.length === 0) {
      return invalid();
    }
    if (typeof event.sender !== 'string' || event.sender.length === 0) {
      return invalid();
    }
    if (expectedSender !== undefined && event.sender !== expectedSender) {
      return invalid();
    }
    if (typeof event.origin_server_ts !== 'number' || !Number.isFinite(event.origin_server_ts)) {
      return invalid();
    }
    if (!isRecord(event.content)) {
      return invalid();
    }
    // `state_key` is optional, but when present it must be a string (a numeric scalar is malformed).
    if ('state_key' in event && event.state_key !== undefined && typeof event.state_key !== 'string') {
      return invalid();
    }

    // Cardinality comes from the installed public models column metadata, not a field-name whitelist:
    // `dataType: 'array'` allows many values; every other column is single-valued. Inverse columns
    // (`isInverse()`) are stored as `<container> predicate <subject>`, so they are counted through the
    // subject's position and validated against the canonical relation.
    const termsFor = (guard: MessageColumnGuard): Quad[] =>
      guard.inverse ? (incoming.get(guard.predicate) ?? []) : (outgoing.get(guard.predicate) ?? []);
    for (const guard of guards.all) {
      if (guard.dataType === 'array') {
        continue;
      }
      if (termsFor(guard).length > 1) {
        return invalid();
      }
    }

    // Required RDF facts, each derived from the same models columns.
    const quadsOf = (name: string): Quad[] => {
      const guard = guards.byName.get(name);
      if (!guard) {
        throw new MatrixError(500, 'M_UNKNOWN', `The models message column ${name} is unavailable`);
      }
      return termsFor(guard);
    };
    const contentQuads = quadsOf('content');
    const expectedContent = this.messageContentFromMatrixEvent(String(event.type), event.content);
    if (contentQuads.length !== 1 || contentQuads[0].object.termType !== 'Literal'
      || contentQuads[0].object.value !== String(expectedContent)) {
      return invalid();
    }
    const makerQuads = quadsOf('maker');
    if (makerQuads.length !== 1 || makerQuads[0].object.termType !== 'NamedNode') {
      return invalid();
    }
    const parentQuads = quadsOf('parent');
    if (parentQuads.length !== 1 || parentQuads[0].object.termType !== 'NamedNode'
      || parentQuads[0].object.value !== roomChatIri(scope, roomId)) {
      return invalid();
    }
    const metadataQuads = quadsOf('metadata');
    if (metadataQuads.length !== 1 || metadataQuads[0].object.termType !== 'NamedNode'
      || metadataQuads[0].object.value !== `${messageIri}/metadata`) {
      return invalid();
    }
    // The canonical inverse chat relation must exist exactly once and point from this room's chat.
    const chatQuads = quadsOf('chat');
    if (chatQuads.length !== 1 || chatQuads[0].subject.termType !== 'NamedNode'
      || chatQuads[0].subject.value !== roomChatIri(scope, roomId)) {
      return invalid();
    }
    // Required datetime: one literal carrying the model's xsd:dateTime datatype, parseable, and
    // exactly the protocol event instant. A right-looking ISO string typed as xsd:string (or any
    // other datatype) is a different RDF term and must not confirm a winner.
    const createdAtGuard = guards.byName.get('createdAt');
    if (!createdAtGuard || createdAtGuard.dataType !== 'datetime') {
      throw new MatrixError(500, 'M_UNKNOWN', 'The models message column createdAt is not a datetime');
    }
    const createdQuads = quadsOf('createdAt');
    if (createdQuads.length !== 1 || createdQuads[0].object.termType !== 'Literal') {
      return invalid();
    }
    if (createdQuads[0].object.datatype.value !== 'http://www.w3.org/2001/XMLSchema#dateTime') {
      return invalid();
    }
    const createdMillis = Date.parse(createdQuads[0].object.value);
    if (!Number.isFinite(createdMillis) || createdMillis !== Number(event.origin_server_ts)) {
      return invalid();
    }
    // Provenance: the RDF maker must agree with the protocol's verified author WebID when present.
    const senderWebId = matrix?.senderWebId;
    if (typeof senderWebId === 'string' && senderWebId.length > 0 && makerQuads[0].object.value !== senderWebId) {
      return invalid();
    }

    if (membership) {
      const operation = membership.operation;
      if (makerQuads[0].object.value !== operation.actor.webId || senderWebId !== operation.actor.webId
        || event.type !== 'm.room.member' || event.sender !== operation.actor.webId
        || event.state_key !== operation.targetWebId || event.origin_server_ts !== operation.event.createdAt
        || !isDeepStrictEqual(event.content, operation.event.content)) return invalid();
    }
    const type = String(event.type);
    return {
      eventId,
      roomId,
      type,
      sender: String(event.sender),
      originServerTs: Number(event.origin_server_ts),
      role: type === 'm.room.message' ? MessageRole.USER : MessageRole.SYSTEM,
      resourceId: membership ? messageIri : messageResourceId,
      ...(membership ? { senderWebId: makerQuads[0].object.value } : {}),
      content: event.content,
      ...(typeof event.state_key === 'string' ? { stateKey: event.state_key } : {}),
      event,
    } as MatrixEventRecord;
  }

  /**
   * Write one message row as a conditional first-writer insert when the Pod handle supports it.
   *
   * Returns whether the conditional path was used. The in-memory test harness has no real Pod and no
   * dialect transport, so it keeps the plain insert; a deployment always goes through the guarded
   * scoped POST. A capability failure falls back rather than silently dropping the event.
   */
  private async writeMessageRow(
    db: Db,
    input: { roomId: string; eventId: string; originServerTs: number; row: Record<string, unknown>;
      context: MatrixStoreContext },
  ): Promise<boolean> {
    const dialectFactory = (db as { getDialect?: unknown }).getDialect;
    if (typeof dialectFactory !== 'function') {
      // Not a Pod-backed database (the in-memory test adapter has no dialect/transport). There is no
      // conditional capability to lose, so the plain in-memory insert is the whole implementation.
      await db.insert(messageResource).values(input.row);
      return false;
    }
    if (!canWriteConditionally(db)) {
      // A real Pod database that cannot express an authenticated conditional insert must fail rather
      // than silently downgrade to an unconditional write that reintroduces the race.
      throw new MatrixError(500, 'M_UNKNOWN',
        'The Pod database cannot execute a conditional event insert; refusing an unconditional write');
    }
    const scope = this.scope(input.context);
    const builder = db.insert(messageResource).values(input.row) as { toSPARQL?: () => { query: string } };
    if (typeof builder.toSPARQL !== 'function') {
      throw new MatrixError(500, 'M_UNKNOWN',
        'The ORM insert builder does not expose toSPARQL; refusing an unconditional write');
    }
    const messageIri = messageResource.buildIri(scope, { id: String(input.row.id) });
    const write = buildConditionalEventWrite({
      insertQuery: builder.toSPARQL().query,
      messageIri,
      chatIri: this.chatIri(input.roomId, input.context),
      roomDirectory: roomDirectoryIri(scope, input.roomId),
      chatType: String(chatResource.config.type),
      messageType: String(messageResource.config.type),
      parentPredicate: String(messageResource.parent.getPredicate(messageResource.config.namespace)),
    });
    // No catch: a refused, timed-out or unknown-outcome conditional POST must propagate. A lost
    // response still leaves the committed winner to be read back by the caller.
    await executeConditionalEventWrite(db as unknown as ConditionalWriteDatabase, write);
    // The raw scoped POST bypasses the ORM's ordinary LDP write path, so its transport cache must be
    // told the one document changed. Scoped to that document: clearing the whole engine cache would
    // turn every later read into a refetch storm.
    await this.invalidateTransportCache(db, write.document);
    return true;
  }

  /** Drop the ORM transport's cached copy of one document after a raw scoped POST changed it. */
  private async invalidateTransportCache(db: Db, document: string): Promise<void> {
    try {
      const executor = (db as {
        getDialect?: () => { getSPARQLExecutor?: () => { invalidateHttpCache?: (url?: string) => Promise<void> } };
      }).getDialect?.().getSPARQLExecutor?.();
      await executor?.invalidateHttpCache?.(document);
    } catch (error) {
      // Cache invalidation is best-effort; the authority file is already committed.
      this.logger.debug(`Could not invalidate the transport cache: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /** The semantic fields a retry has to agree on; bookkeeping (txn, time, bucket) is not identity. */
  private sameEventSemantics(left: MatrixEventRecord, right: MatrixEventRecord): boolean {
    // `state_key` is optional but its absence and an empty string are different Matrix event shapes,
    // so compare it exactly rather than collapsing both to ''.
    const leftStateKey = left.stateKey;
    const rightStateKey = right.stateKey;
    if (leftStateKey !== undefined && typeof leftStateKey !== 'string') {
      return false;
    }
    if (rightStateKey !== undefined && typeof rightStateKey !== 'string') {
      return false;
    }
    return left.sender === right.sender
      && left.type === right.type
      && leftStateKey === rightStateKey
      && this.canonicalJson(left.content) === this.canonicalJson(right.content);
  }

  /**
   * Make a room this Pod has only heard about visible in it.
   *
   * A received event for an unknown room arrives with no chat record, and without one the
   * room is invisible: `listRooms` does not report it, so a client never sees the invite
   * that would let its user join, and joining fails because the room cannot be read. The
   * record is therefore created from the event, not from a local decision to open a room:
   * the room id is the remote one and the author is the create event's sender, never the
   * local Pod owner — a received event must not make the owner look like the room's
   * creator, which would read as "already a member".
   *
   * Idempotent: an existing record is left exactly as it is.
   */
  private async materializeReceivedRoom(db: Db, roomId: string, context: MatrixStoreContext): Promise<void> {
    const chatId = this.chatResourceId(roomId, this.scope(context));
    if (await db.findById(chatResource, chatId)) return;
    const timeline = await this.listEvents(db, roomId, context);
    const create = timeline.find(record => record.type === 'm.room.create');
    const nowIso = new Date().toISOString();
    const coordination = reconcilerCoordinationMetadata('server');
    await db.insert(chatResource).values({
      id: chatId,
      title: roomId,
      description: null,
      // The remote creator's MXID, not the local owner: see above.
      author: create?.sender ?? null,
      status: 'active',
      participants: [],
      metadata: withProtocolMetadata({
        '@id': `${this.chatIri(roomId, context)}/metadata`,
        protocol: 'matrix',
        ...coordination,
      }, 'matrix', {
        roomId,
        roomVersion: String((create?.content?.room_version as string | undefined) ?? SUPPORTED_ROOM_VERSION),
        federate: create?.content?.['m.federate'] !== false,
        members: [],
      }),
      createdAt: nowIso,
      updatedAt: nowIso,
    });
    await db.insert(threadResource).values({
      id: this.threadResourceId(roomId, this.scope(context)),
      parent: this.chatIri(roomId, context),
      title: roomId,
      status: 'active',
      metadata: withProtocolMetadata({
        '@id': `${this.threadIri(roomId, context)}/metadata`,
        protocol: 'matrix',
        commandKind: 'chat',
        surface_id: this.surfaceIdFromRoomId(roomId),
        ...coordination,
      }, 'matrix', { roomId }),
      createdAt: nowIso,
      updatedAt: nowIso,
    });
  }

  /**
   * Store an event received from another server exactly as it arrived.
   *
   * Deliberately not the writer above: an event we author is built and signed here,
   * while a received one already carries its own derived id, hashes and signatures —
   * rebuilding or re-signing it would destroy the material a verifier checks, and
   * adding our signature would claim authorship we do not have. The Pod keeps the
   * received event verbatim under `metadata.protocols.matrix.event`, with `received`
   * marking it so the row's owner is not mistaken for its author.
   *
   * Idempotent by event id: accepting the same event again returns the stored record
   * without a second write, which is what a peer's transaction replay needs.
   */
  /**
   * Whether an inbound event may be written for this Pod's participant.
   *
   * The grant is already proven by the time anything is written (the Pod handle was built with it,
   * and `getDb` refuses without one), so what is left is membership. Resolved state answers it,
   * rather than a latest-slot lookup: under a fork the slot can say something the room has already
   * resolved against, and being wrong here means either writing into a room the participant left or
   * refusing one they are in. `inboundAuthority.ts` says why membership *changes* and a membership
   * this Pod has not established yet are not refusals.
   */
  private async requireInboundAuthority(
    db: Db,
    roomId: string,
    type: string,
    context: MatrixStoreContext,
  ): Promise<void> {
    let membership: 'join' | 'invite' | 'leave' | 'ban' | 'knock' | undefined;
    if (type !== 'm.room.member') {
      const events = await this.listEvents(db, roomId, context);
      const own = this.resolvedState(roomId, context, events).get('m.room.member', this.getMatrixUserId(context));
      const value = own?.content.membership;
      membership = typeof value === 'string' ? value as typeof membership : undefined;
    }
    const authority = inboundWriteAuthority({ grant: true, type, ...(membership === undefined ? {} : { membership }) });
    if (!authority.allowed) throw new MatrixError(403, 'M_FORBIDDEN', authority.reason);
  }

  public async acceptReceivedEvent(input: {
    event: Record<string, unknown>;
    context: MatrixStoreContext;
  }): Promise<MatrixEventRecord> {
    const event = input.event;
    const roomId = String(event.room_id ?? '');
    const type = String(event.type ?? '');
    const sender = String(event.sender ?? '');
    const originServerTs = Number(event.origin_server_ts ?? Number.NaN);
    const content = isRecord(event.content) ? event.content : {};
    if (!roomId || !type || !sender || !Number.isSafeInteger(originServerTs)) {
      throw new MatrixError(400, 'M_BAD_JSON', 'A received event needs room_id, type, sender and origin_server_ts');
    }
    // The writer's own id when the event carries one: this protocol lets whoever writes an event
    // name it, and keeping that name is what makes the same event recognisable in every Pod it
    // reaches. An event without one (a Matrix-shaped peer's, whose id *is* the reference hash) is
    // named here as it always was.
    const statedId = typeof event.event_id === 'string' && event.event_id.length > 0 ? event.event_id : undefined;
    const eventId = statedId ?? computeEventId(event);
    // The identity is attached here when it was not sent; it is safe because neither the content
    // hash, the reference hash nor the signature covers `event_id`.
    const storedEvent: Record<string, unknown> = { ...event, event_id: eventId };
    const messageResourceId = this.messageResourceId(roomId, eventId, originServerTs, this.scope(input.context));
    // The semantic comparison is what "same logical event" means, so it is computed before either
    // lookup. `(roomId, eventId)` is the logical key; the resource id merely happens to be a fast
    // way to reach one row. A resource-id hit alone only proves the row exists — not that it says
    // the same thing — so it runs the same sender/type/state_key/content check the timeline path
    // does. Returning the first row for a same-key/different-content write would accept a conflict
    // as a harmless duplicate and silently keep content the author did not send.
    const receivedHash = this.receivedContentHash(sender, type, event.state_key, content);
    // Serialize with a concurrent local send for the same logical key: both would otherwise miss the
    // timeline read and insert, and the Solid insert would keep each attempt's object value as a
    // second triple on the same subject.
    return this.runExclusive(`${this.scope(input.context)}|${roomId}|${eventId}`, () =>
      this.acceptReceivedEventLocked(input.context, {
        roomId, type, sender, originServerTs, content, eventId, storedEvent, messageResourceId, receivedHash,
      }));
  }

  private async acceptReceivedEventLocked(context: MatrixStoreContext, parsed: {
    roomId: string; type: string; sender: string; originServerTs: number;
    content: Record<string, unknown>; eventId: string; storedEvent: Record<string, unknown>;
    messageResourceId: string; receivedHash: string;
  }): Promise<MatrixEventRecord> {
    const db = await this.getDb(context);
    const { roomId, type, sender, originServerTs, content, eventId, storedEvent, messageResourceId, receivedHash } = parsed;
    const fast = await db.findById(messageResource, messageResourceId);
    if (fast) {
      const existing = this.eventSourceToRecord(fast, roomId, context);
      if (this.receivedContentHash(existing.sender, existing.type, existing.stateKey, existing.content) !== receivedHash) {
        throw new MatrixError(409, 'M_CONFLICT', 'Event id already names different content');
      }
      return existing;
    }
    await this.materializeReceivedRoom(db, roomId, context);
    // The logical key is `(roomId, eventId)`, so the room's own timeline is what decides whether
    // this event is already here. The resource id also carries the day bucket and the arrival
    // timestamp, and a retry that lands on another day (or with a recomputed timestamp) would
    // build a second resource id for the same event; looking the id up in the timeline is what
    // keeps one logical event to one row.
    const claimedEvent = (await this.listEvents(db, roomId, context)).find(candidate => candidate.eventId === eventId);
    if (claimedEvent) {
      if (this.receivedContentHash(claimedEvent.sender, claimedEvent.type, claimedEvent.stateKey, claimedEvent.content) !== receivedHash) {
        throw new MatrixError(409, 'M_CONFLICT', 'Event id already names different content');
      }
      return claimedEvent;
    }
    // The room exists here now, so "is our participant in it" is answerable — and that is what
    // decides whether this event belongs in their Pod at all.
    await this.requireInboundAuthority(db, roomId, type, context);

    const originIso = new Date(originServerTs).toISOString();
    const role = type === 'm.room.message' ? MessageRole.USER : MessageRole.SYSTEM;
    const coordination = reconcilerCoordinationMetadata(
      this.reconcilerOwnerFromRoomMetadata((await this.getRoomContext(db, roomId, context))?.metadata));
    const row = {
      id: messageResourceId,
      parent: this.chatIri(roomId, context),
      chat: this.chatIri(roomId, context),
      thread: this.threadIri(roomId, context),
      maker: context.webId,
      role,
      content: this.messageContentFromMatrixEvent(type, content),
      status: MessageStatus.SENT,
      mentions: this.mentionsFromMatrixContent(content),
      routeTargetAgent: this.routeTargetAgentFromMatrixContent(content) ?? null,
      replyTo: typeof content['co.undefineds.replyTo'] === 'string' ? content['co.undefineds.replyTo'] : null,
      metadata: withProtocolMetadata({
        '@id': `${messageResource.buildIri(this.scope(context),{id:messageResourceId})}/metadata`,
        protocol: 'matrix',
        commandKind: 'chat',
        surface_id: this.surfaceIdFromRoomId(roomId),
        ...coordination,
      }, 'matrix', {
        // The event as received: its own hashes and signatures, nothing re-signed, with
        // the id this server derived attached.
        event: storedEvent as unknown as ProtocolMetadata,
        // This row's owner is not the author; the author is the event's `sender`.
        received: true,
      }),
      createdAt: originIso,
      updatedAt: originIso,
    };
    const usedConditional = await this.writeMessageRow(db, { roomId, eventId, originServerTs, row, context });

    const record: MatrixEventRecord = {
      eventId,
      roomId,
      type,
      sender,
      originServerTs,
      role,
      resourceId: messageResourceId,
      content,
      event: storedEvent,
      ...(typeof storedEvent.state_key === 'string' ? { stateKey: storedEvent.state_key } : {}),
    };
    if (usedConditional) {
      const winner = await this.awaitCommittedWinner(db, messageResourceId, roomId, eventId, context, sender);
      if (!winner) {
        throw new MatrixError(503, 'M_UNKNOWN', 'The received event write could not be confirmed');
      }
      if (this.receivedContentHash(winner.sender, winner.type, winner.stateKey, winner.content) !== receivedHash) {
        throw new MatrixError(409, 'M_CONFLICT', 'Event id already names different content');
      }
      const reference = await this.journal.registerReference(this.scope(context), {
        roomId, eventId, createdAt: originServerTs,
        messageIri: messageResource.buildIri(this.scope(context), { id: messageResourceId }),
      });
      winner.depth = reference.sequence;
      return winner;
    }
    const reference = await this.journal.registerReference(this.scope(context), {
      roomId, eventId, createdAt: originServerTs,
      messageIri: messageResource.buildIri(this.scope(context), { id: messageResourceId }),
    });
    record.depth = reference.sequence;
    return record;
  }

  private async appendMembershipEvent(
    db: Db,
    roomId: string,
    memberUserId: string,
    membership: 'invite' | 'join' | 'leave' | 'ban',
    context: MatrixStoreContext,
    options: { sender?: string; reconcilerOwner?: ReconcilerOwner; observed?: readonly MatrixEventRecord[] } = {},
  ): Promise<MatrixEventRecord> {
    const sender = options.sender ?? this.getMatrixUserId(context);
    return this.appendEvent(db, {
      roomId,
      reconcilerOwner: options.reconcilerOwner,
      type: 'm.room.member',
      sender,
      originServerTs: this.now(),
      stateKey: memberUserId,
      content: {
        membership,
        displayname: this.displayNameFromUserId(memberUserId),
      },
    }, context, options.observed);
  }

  private async listRooms(db: Db): Promise<MatrixRoomRecord[]> {
    const rooms = await db.select().from(chatResource) as MatrixRoomSource[];
    return rooms
      .map((room) => this.chatSourceToRoomRecord(room))
      .filter((room): room is MatrixRoomRecord => room !== undefined);
  }

  private async listJoinedRoomRecords(db: Db, context: MatrixStoreContext): Promise<MatrixRoomRecord[]> {
    const rooms = await this.listRooms(db);
    const matrixUserId = this.getMatrixUserId(context);
    const joined: MatrixRoomRecord[] = [];
    for (const room of rooms) {
      const membership = await this.findLatestStateEvent(db, room.roomId, 'm.room.member', matrixUserId, context);
      if (membership?.content.membership === 'join' || (!membership && room.creator === context.webId)) {
        joined.push(room);
      }
    }
    return joined;
  }

  /**
   * A room id, resolving an alias locally first and then at the server the alias names.
   *
   * An alias belongs to one server — the one after the colon — and that server is the only one that
   * can say which room it names. Local rooms are still looked up first, because that costs nothing
   * and is what a room this deployment holds is reached by.
   */
  private async resolveRoomId(db: Db, roomIdOrAlias: string, context: MatrixStoreContext): Promise<string> {
    if (!roomIdOrAlias.startsWith('#')) {
      return roomIdOrAlias;
    }
    const rooms = await this.listRooms(db);
    const room = rooms.find((candidate) => candidate.canonicalAlias === roomIdOrAlias);
    if (room) return room.roomId;

    const destination = serverNameOf(roomIdOrAlias);
    if (destination !== undefined && this.directoryQuery) {
      const resolved = await this.directoryQuery({ roomAlias: roomIdOrAlias, destination, context });
      if (resolved) return resolved;
    }
    throw new MatrixError(404, 'M_NOT_FOUND', 'Room alias not found');
  }

  private async listEvents(
    db: Db,
    roomId: string,
    context: MatrixStoreContext,
    options: { newestFirst?: boolean; registerJournal?: false } = {},
  ): Promise<MatrixEventRecord[]> {
    const sources = await db.select().from(messageResource)
      .where(eq(messageResource.thread, this.threadIri(roomId, context))) as MatrixEventSource[];
    sources.sort((a,b) => (this.isoToMillis(a.createdAt) ?? 0) - (this.isoToMillis(b.createdAt) ?? 0) || a.id.localeCompare(b.id));
    // One journal round trip per page instead of one per event: the per-event
    // form made every read cost O(history) SQL calls.
    const records = sources.map(source => this.eventSourceToRecord(source, roomId, context));
    if (options.registerJournal === false) return records;
    const sequences = await this.journal.registerEvents(this.scope(context), roomId, records.map(record => record.eventId));
    records.forEach((record, index) => { record.depth = sequences[index]; });
    const events = records;
    events.sort((a,b)=>a.depth! - b.depth!);
    return options.newestFirst ? events.reverse() : events;
  }

  private async findEventById(db: Db, roomId: string, eventId: string, context: MatrixStoreContext): Promise<MatrixEventRecord | undefined> {
    const records = await this.listEvents(db, roomId, context);
    return records.find((record) => record.eventId === eventId);
  }

  private async findLatestStateEvent(
    db: Db,
    roomId: string,
    eventType: string,
    stateKey: string,
    context: MatrixStoreContext,
  ): Promise<MatrixEventRecord | undefined> {
    const records = await this.listEvents(db, roomId, context, { newestFirst: true });
    return records.find((record) => record.type === eventType && (record.stateKey ?? '') === stateKey);
  }

  private eventSourceToRecord(source: MatrixEventSource, roomId: string, context: MatrixStoreContext): MatrixEventRecord {
    const metadata = this.parseJsonObject(source.metadata) ?? {};
    const matrix = getProtocolMetadata(metadata, 'matrix') ?? {};
    const stored = readPersistedEvent(matrix);
    const content = this.parseJsonObject(stored?.content as JsonObjectSource)
      ?? this.parseJsonObject(matrix.content as JsonObjectSource)
      ?? this.parseJsonObject(metadata.content as JsonObjectSource)
      ?? {msgtype: 'm.text', body: typeof source.content === 'string' ? source.content : JSON.stringify(source.content ?? '')};
    const unsigned = this.parseJsonObject(stored?.unsigned as JsonObjectSource)
      ?? this.parseJsonObject(matrix.unsigned as JsonObjectSource)
      ?? this.parseJsonObject(metadata.unsigned as JsonObjectSource);
    const stateKey = this.stringValue(stored?.state_key ?? matrix.stateKey ?? matrix.state_key ?? metadata.stateKey);
    const txnId = this.stringValue(matrix.txnId ?? matrix.txn_id ?? metadata.txnId);
    // The device whose reservation produced this event: stored on the row so the event alone leads
    // back to it, which is what a Pod-side reservation record needs (its key names the device).
    const txnDevice = this.stringValue(matrix.txnDevice ?? metadata.txnDevice);
    return {
      eventId: this.stringValue(stored?.event_id ?? matrix.eventId ?? matrix.event_id ?? metadata.eventId) ?? `$${this.hash(source.id)}:${this.getServerName(context)}`,
      roomId: this.stringValue(stored?.room_id ?? matrix.roomId ?? matrix.room_id ?? metadata.roomId) ?? roomId,
      type: this.stringValue(stored?.type ?? matrix.eventType ?? matrix.event_type ?? metadata.eventType) ?? 'm.room.message',
      sender: this.stringValue(stored?.sender ?? matrix.sender ?? metadata.sender) ?? this.getMatrixUserId({...context, webId: source.maker ?? context.webId}),
      // A received event's row is owned by this Pod's user, not by its author: the
      // remote author's WebID is not derivable from their MXID, so it stays unknown
      // until the sender's own binding can be consulted.
      senderWebId: this.stringValue(matrix.senderWebId ?? matrix.sender_web_id ?? metadata.senderWebId)
        ?? (matrix.received === true ? undefined : source.maker ?? undefined),
      originServerTs: this.numberValue(stored?.origin_server_ts ?? matrix.originServerTs ?? matrix.origin_server_ts ?? metadata.originServerTs) ?? this.isoToMillis(source.createdAt) ?? this.now(),
      depth: this.numberValue(stored?.depth ?? matrix.depth ?? metadata.depth),
      role: source.role,
      resourceId: source.id,
      txnId: txnId ?? undefined,
      txnDevice: txnDevice ?? undefined,
      content,
      stateKey: stateKey ?? undefined,
      unsigned,
      ...(stored === undefined ? {} : { event: stored as unknown as Record<string, unknown> }),
    };
  }

  private chatSourceToRoomRecord(source: MatrixRoomSource): MatrixRoomRecord | undefined {
    const metadata = this.parseJsonObject(source.metadata) ?? {};
    if (metadata.protocol !== 'matrix') {
      return undefined;
    }
    const matrix = getProtocolMetadata(metadata, 'matrix') ?? {};
    const roomId = this.stringValue(matrix.roomId ?? matrix.room_id ?? metadata.roomId);
    if (!roomId) {
      return undefined;
    }
    const reconcilerOwner = normalizeReconcilerOwner(metadata.reconcilerOwner, 'server');
    const coordination = reconcilerCoordinationMetadata(reconcilerOwner);
    return {
      roomId,
      canonicalAlias: this.stringValue(matrix.canonicalAlias ?? matrix.canonical_alias ?? metadata.canonicalAlias),
      name: source.title ?? undefined,
      topic: source.description ?? undefined,
      creator: source.author ?? '',
      reconcilerOwner: coordination.reconcilerOwner,
      createdAt: this.isoToMillis(source.createdAt) ?? 0,
    };
  }

  private toClientEvent(event: MatrixEventRecord): MatrixClientEvent {
    return {
      event_id: event.eventId,
      room_id: event.roomId,
      type: event.type,
      sender: event.sender,
      origin_server_ts: event.originServerTs,
      content: event.content,
      ...(event.stateKey !== undefined ? { state_key: event.stateKey } : {}),
      ...(event.unsigned ? { unsigned: event.unsigned } : {}),
    };
  }

  private scope(context: MatrixStoreContext): string {
    if (!context.podUrl) throw new MatrixError(400, 'M_BAD_JSON', 'A resolved Pod URL is required');
    return context.podUrl;
  }

  private hash(value: string): string { return createHash('sha256').update(value).digest('hex'); }

  private canonicalJson(value: unknown): string {
    if (Array.isArray(value)) return `[${value.map(item=>this.canonicalJson(item)).join(',')}]`;
    if (value && typeof value === 'object') return `{${Object.entries(value).filter(([,v])=>v!==undefined).sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>`${JSON.stringify(k)}:${this.canonicalJson(v)}`).join(',')}}`;
    return JSON.stringify(value) ?? 'null';
  }

  private chatIri(roomId: string, context: MatrixStoreContext): string {
    return roomChatIri(this.scope(context), roomId);
  }

  private threadIri(roomId: string, context: MatrixStoreContext): string {
    return roomThreadIri(this.scope(context), roomId);
  }

  /**
   * The room record is written once by `createRoom` and never mutated on the
   * Matrix path, so one lookup per request serves membership, owner, metadata
   * and grant checks. Each extra lookup is a full chat-resource SPARQL SELECT.
   * The cache lives on the request context, not on this container singleton.
   */
  private async findRoomSource(db: Db, roomId: string, context: MatrixStoreContext): Promise<MatrixRoomSource | undefined> {
    const holder = context as MatrixStoreContext & { _roomSources?: Map<string, MatrixRoomSource | undefined> };
    holder._roomSources ??= new Map();
    // `chatResourceId` already chooses the exact own source, or the hashed display layout for a
    // legacy/foreign id. A missing row is a missing room — never a hashed replacement for an own
    // source, which would let a mirror stand in for the room's authority.
    const key = this.chatResourceId(roomId, this.scope(context));
    if (!holder._roomSources.has(key)) {
      holder._roomSources.set(key, await db.findById(chatResource, key) as MatrixRoomSource | undefined);
    }
    return holder._roomSources.get(key);
  }

  private async roomSource(db: Db, roomId: string, context: MatrixStoreContext): Promise<MatrixRoomSource> {
    const room = await this.findRoomSource(db, roomId, context);
    if (!room) throw new MatrixError(404,'M_NOT_FOUND','Room not found');
    return room;
  }

  /**
   * The auth events a built event names, as the rules read them.
   *
   * Missing ones are simply absent: the rules decide what that means, rather than this guessing on
   * their behalf.
   */


  /**
   * The authority a reservation is written with: the caller's own.
   *
   * Reservations are written on the caller's path, so this is the same handle a Matrix write uses —
   * a caller's session for their own Pod, the deployment's grant when it works on a participant's
   * behalf. `undefined` when the context cannot produce one (the SQL carrier needs none); a carrier
   * that does need it then refuses with its own reason rather than writing under authority nobody
   * granted.
   */
  private async reservationAuthority(context: MatrixStoreContext): Promise<MatrixControlRecordTarget | undefined> {
    try {
      return await this.controlRecordHandleFor(context);
    } catch {
      return undefined;
    }
  }

  private async requireRoomOwner(db: Db, roomId: string, context: MatrixStoreContext): Promise<void> {
    if ((await this.roomSource(db,roomId,context)).author !== context.webId) throw new MatrixError(403,'M_FORBIDDEN','Room owner authority is required');
  }

  private async requireJoined(db: Db, roomId: string, context: MatrixStoreContext, events?: MatrixEventRecord[]): Promise<void> {
    const room = await this.roomSource(db,roomId,context);
    // A fork makes "the latest member event by local order" and "the member the room
    // resolved to" different events, so the resolved state decides whether the caller
    // is in the room.
    const state = events
      ? this.resolvedState(roomId, context, events).get('m.room.member', this.getMatrixUserId(context))
      : await this.findLatestStateEvent(db,roomId,'m.room.member',this.getMatrixUserId(context),context);
    if (state?.content.membership === 'join' || (!state && room.author === context.webId)) return;
    throw new MatrixError(403,'M_FORBIDDEN','Join the room before accessing its timeline');
  }

  /** The room's current state, resolved across forks. */
  public async currentState(roomId: string, context: MatrixStoreContext, events?: MatrixEventRecord[]): Promise<MatrixRoomState> {
    const db = await this.getDb(context);
    return this.resolvedState(roomId, context, events ?? await this.listEvents(db, roomId, context));
  }

  /**
   * The resolved state of a room, memoized per Pod and room.
   *
   * Replaying a room costs O(events × state) and one operation asks for the same answer
   * several times — a write checks membership and agent grants against the same
   * timeline, a sync loop re-reads every room it did not change. The cache is keyed by
   * the events it was built from, so an appended event changes the key and no caller
   * can read a state that predates its write. Entries hold references to the records
   * the caller already has; the map is bounded and evicts the least recently used room.
   */
  private resolvedState(roomId: string, context: MatrixStoreContext, events: readonly MatrixEventRecord[]): MatrixRoomState {
    if (this.stateCacheLimit === 0) return resolveRoomState(events);
    const key = `${this.scope(context)}::${roomId}`;
    const cached = this.stateCache.get(key);
    // An appended list extends the cached replay, so a write costs the new events
    // rather than the room. Anything else is replayed in full.
    const extended = cached?.extend(events);
    const replay = extended ?? MatrixRoomStateReplay.from(events);
    // Refresh the insertion order so the least recently used room is evicted first.
    this.stateCache.delete(key);
    this.stateCache.set(key, replay);
    while (this.stateCache.size > this.stateCacheLimit) {
      const oldest = this.stateCache.keys().next().value;
      if (oldest === undefined) break;
      this.stateCache.delete(oldest);
    }
    return replay.state;
  }

  private validateAgentGrants(content: Record<string, unknown>): MatrixAgentGrant[] {
    if (!Array.isArray(content.agents) || content.agents.length > 32) throw new MatrixError(400,'M_BAD_JSON','agents must be an array of at most 32 grants');
    const uri = (value: unknown): value is string => {
      if (typeof value !== 'string') return false;
      try { const url = new URL(value); return ['http:','https:'].includes(url.protocol) && !url.username && !url.password; } catch { return false; }
    };
    const grants: MatrixAgentGrant[] = [];
    for (const value of content.agents) {
      const grant = value as MatrixAgentGrant;
      if (!grant || !uri(grant.agent) || !uri(grant.executor) || !uri(grant.workspace)
        || !Array.isArray(grant.allowedActors) || !grant.allowedActors.every(uri)
        || !Array.isArray(grant.handoffTo) || !grant.handoffTo.every(uri)
        || grant.allowedActors.length > 32 || grant.handoffTo.length > 32
        || grants.some(g=>g.agent===grant.agent)) throw new MatrixError(400,'M_BAD_JSON','Invalid or duplicate agent grant');
      grants.push(grant);
    }
    if (grants.some(g=>g.handoffTo.some(target=>!grants.some(candidate=>candidate.agent===target)))) {
      throw new MatrixError(400,'M_BAD_JSON','Handoff targets must be registered agents');
    }
    return grants;
  }

  private async agentGrants(db: Db, roomId: string, context: MatrixStoreContext, events?: MatrixEventRecord[]): Promise<MatrixAgentGrant[]> {
    const state = events
      ? this.resolvedState(roomId, context, events).get('co.undefineds.agents')
      : await this.findLatestStateEvent(db,roomId,'co.undefineds.agents','',context);
    return state ? this.validateAgentGrants(state.content) : [];
  }

  private async authorizeTargets(db: Db, roomId: string, content: Record<string,unknown>, context: MatrixStoreContext, events?: MatrixEventRecord[]): Promise<string[]> {
    const target = this.routeTargetAgentFromMatrixContent(content);
    const targets = target ? [target] : this.mentionsFromMatrixContent(content);
    if (!targets.length) return [];
    const grants = await this.agentGrants(db,roomId,context,events);
    if (targets.some(agent=>!grants.some(g=>g.agent===agent && g.allowedActors.includes(context.webId)))) {
      throw new MatrixError(403,'M_FORBIDDEN','Agent execution is not granted to this actor');
    }
    return targets;
  }

  private async reconcileEvent(db: Db, event: MatrixEventRecord, context: MatrixStoreContext, events?: MatrixEventRecord[],
    knownReceipt?: MatrixTransactionReservation): Promise<void> {
    if (!this.serverGroupReconcilerService || event.type !== 'm.room.message' || event.role !== MessageRole.USER) return;
    const actor = event.senderWebId;
    if (!actor) return;
    const receipt = knownReceipt ?? await this.journal.findReservation(this.scope(context),event, await this.reservationAuthority(context));
    if (!receipt || receipt.contentHash !== this.hash(this.canonicalJson(['user',actor,event.type,event.content]))) return;
    const targets = await this.authorizeTargets(db,event.roomId,event.content,{...context,webId:actor},events);
    const pending: string[] = [];
    for (const target of targets) if (await this.ensureDelivery(db,event,target,context)) pending.push(target);
    if (!pending.length) return;
    const room = await this.roomSource(db,event.roomId,context);
    await this.reconcileGroupUserMessage({thread:this.threadIri(event.roomId,context),
      triggerMessage:messageResource.buildIri(this.scope(context),{id:event.resourceId!}), actor, role:'user',
      content:typeof event.content.body==='string' ? event.content.body : '', createdAt:new Date(event.originServerTs).toISOString(),
      reconcilerOwner:this.reconcilerOwnerFromRoomMetadata(this.parseJsonObject(room.metadata)),
      mentions:pending,participants:pending});
  }

  /** Runtime principals must have both Pod access and an explicit room execution grant. */
  public async authorize(roomId: string, agent: string, context: MatrixStoreContext): Promise<{thread:string}> {
    const db = await this.getDb(context);
    const events = await this.listEvents(db,roomId,context);
    await this.requireJoined(db,roomId,context,events);
    const grant = (await this.agentGrants(db,roomId,context,events)).find(g=>g.agent===agent && g.executor===context.webId);
    if (!grant) throw new MatrixError(403,'M_FORBIDDEN','No execution grant for this agent');
    return {thread:this.threadIri(roomId,context)};
  }

  /** Rebuild operational work from Pod facts after an interrupted write or queue restart. */
  public async recover(roomId: string, context: MatrixStoreContext): Promise<void> {
    const db = await this.getDb(context);
    const events = await this.listEvents(db,roomId,context);
    await this.requireJoined(db,roomId,context,events);
    // Recovery asks for one receipt per scanned event; fetch them as a page.
    const receipts = await this.journal.findReservations(this.scope(context), events, await this.reservationAuthority(context));
    for (const event of events) {
      if (event.role === MessageRole.USER) {
        try { await this.reconcileEvent(db,event,context,events,receipts.get(event.eventId)); }
        catch (error) { if (!(error instanceof MatrixError && error.status === 403)) throw error; }
      }
      if (event.role === MessageRole.ASSISTANT) await this.reconcileHandoff(db,event,context,events);
    }
  }

  public async loadInput(roomId: string, job: SharedWakeAgentJob, context: MatrixStoreContext): Promise<{content:string;[key:string]:unknown}> {
    const db = await this.getDb(context);
    const events = await this.listEvents(db,roomId,context);
    await this.requireJoined(db,roomId,context,events);
    if (!(await this.agentGrants(db,roomId,context,events)).some(g=>g.agent===job.agent && g.executor===context.webId)) {
      throw new MatrixError(403,'M_FORBIDDEN','No execution grant for this agent');
    }
    const event = events.find(e=>messageResource.buildIri(this.scope(context),{id:e.resourceId!})===job.triggerMessage);
    if (!event) throw new MatrixError(404,'M_NOT_FOUND','Trigger message not found');
    const grant = (await this.agentGrants(db,roomId,context,events)).find(g=>g.agent===job.agent)!;
    await this.validateTrigger(db,event,job,context,events);
    const values = {id:job.id,thread:job.thread,createdAt:job.createdAt};
    const delivery = await db.findById(deliveryResource,deliveryResource.buildId(values));
    const previous = await db.findById(runResource,runResource.buildId(values));
    if (['completed','failed','cancelled'].includes(delivery?.status) || this.runAttempts(previous) >= 3) {
      throw new MatrixError(409,'M_CONFLICT','Execution is terminal or its retry budget is exhausted');
    }
    const run = await this.materializeRun(db,roomId,job,context,'running',undefined,undefined,grant.workspace);
    return {content:typeof event.content.body==='string' ? event.content.body : '', thread:job.thread,
      triggerMessage:job.triggerMessage, agent:job.agent, workspace:grant.workspace, run,
      history:events.filter(e=>e.type==='m.room.message').slice(-50).map(e=>({role:e.role,body:e.content.body,eventId:e.eventId}))};
  }

  public async commitResult(roomId: string, job: SharedWakeAgentJob,
    result: {body:string;handoffTo?:string;evidence?:string[]}, context: MatrixStoreContext): Promise<{eventId:string;run:string}> {
    const db = await this.getDb(context);
    const events = await this.listEvents(db,roomId,context);
    await this.requireJoined(db,roomId,context,events);
    // A completed wake is a durable fact: its first full output is replayed/returned before any
    // current grant or lease is consulted. This is a read of the committed result, not new
    // execution, so a later revoked grant cannot erase it — but it grants no new side effects.
    const runValues = { id: job.id, thread: job.thread, createdAt: job.createdAt };
    const completedRun = await db.findById(runResource, runResource.buildId(runValues));
    if (completedRun?.status === 'completed') {
      const runIri = runResource.buildIri(this.scope(context), runValues);
      const runMetadata = this.parseJsonObject(completedRun.metadata) ?? {};
      const runMatrix = getProtocolMetadata(runMetadata, 'matrix') ?? {};
      // The completed Run must bind to this exact wake: same room, job, thread and trigger.
      if (this.stringValue(runMatrix.roomId) !== roomId
        || this.stringValue(runMatrix.jobId) !== job.id
        || this.stringValue(completedRun.thread) !== job.thread
        || this.stringValue(completedRun.input) !== job.triggerMessage) {
        throw new MatrixError(503, 'M_UNKNOWN', 'The completed run does not bind to this wake');
      }
      const committedEventId = this.stringValue(runMatrix.eventId);
      const committed = committedEventId ? events.find(event => event.eventId === committedEventId) : undefined;
      if (!committed) {
        throw new MatrixError(503, 'M_UNKNOWN', 'The completed result could not be read back from the Pod');
      }
      const execution = this.parseJsonObject(committed.content['co.undefineds.execution'] as JsonObjectSource) ?? {};
      // The output must be the ASSISTANT result of this job/agent/trigger, not an unrelated
      // same-agent/same-body room message the Run metadata might have been pointed at.
      const same = committed.role === MessageRole.ASSISTANT
        && committed.type === 'm.room.message'
        && committed.roomId === roomId
        && committed.sender === this.getMatrixUserId({ ...context, webId: job.agent })
        && committed.content.body === result.body
        && committed.content['co.undefineds.replyTo'] === job.triggerMessage
        && String(execution.jobId) === job.id
        && String(execution.agent) === job.agent
        && (execution.handoffTo ?? undefined) === (result.handoffTo ?? undefined)
        && JSON.stringify(execution.evidence ?? []) === JSON.stringify(result.evidence ?? []);
      if (!same) {
        throw new MatrixError(409, 'M_CONFLICT', 'A different result was already committed for this wake');
      }
      return { eventId: committed.eventId, run: runIri };
    }
    if (!(await this.agentGrants(db,roomId,context,events)).some(g=>g.agent===job.agent && g.executor===context.webId)) {
      throw new MatrixError(403,'M_FORBIDDEN','No execution grant for this agent');
    }
    const grant = (await this.agentGrants(db,roomId,context,events)).find(g=>g.agent===job.agent)!;
    const trigger = events.find(e=>messageResource.buildIri(this.scope(context),{id:e.resourceId!})===job.triggerMessage);
    if (!trigger) throw new MatrixError(404,'M_NOT_FOUND','Trigger message not found');
    await this.validateTrigger(db,trigger,job,context,events);
    const prior = trigger.role === MessageRole.ASSISTANT
      ? this.parseJsonObject(trigger.content['co.undefineds.execution'] as JsonObjectSource) : undefined;
    const hops = typeof prior?.hops === 'number' ? prior.hops + 1 : 1;
    if (result.handoffTo && (!grant.handoffTo.includes(result.handoffTo) || hops >= 8)) {
      throw new MatrixError(403,'M_FORBIDDEN','Handoff is not granted or its hop limit was reached');
    }
    const content = {msgtype:'m.text',body:result.body,'co.undefineds.replyTo':job.triggerMessage,
      'm.relates_to':{'m.in_reply_to':{event_id:trigger.eventId}},
      'co.undefineds.execution':{jobId:job.id,agent:job.agent,hops,handoffTo:result.handoffTo,
        root:prior?.root ?? job.triggerMessage,evidence:result.evidence ?? []}};
    const contentHash = this.hash(this.canonicalJson(['assistant',job.agent,'m.room.message',content]));
    const key = JSON.stringify(['wake-result',job.id]);
    const resultSender = this.getMatrixUserId({...context,webId:job.agent});
    // One wake owns exactly one result identity: naming it from the job id makes a retry of the
    // same wake land on the same event rather than on a second one.
    const resultEventId = eventIdForWrite(`$wake-${this.hash(job.id)}`);
    const resultInput = {
      roomId, type: 'm.room.message', sender: resultSender, content,
      eventId: resultEventId,
      ...this.graphPosition(events, { type: 'm.room.message', sender: resultSender, content }),
    };
    const { reservation, proposal } = await this.reserveEventTransaction(context, key, resultInput, contentHash);
    let active = reservation;
    if (reservation.contentHash !== contentHash) {
      // A crashed executor can leave a reservation whose output never reached the
      // Pod. Its absence proves nothing is committed, so the current attempt takes
      // the reservation over — id included, since an event's id is derived from
      // the event and this attempt's content derives its own.
      const dangling = !events.some(event => event.eventId === reservation.eventId);
      if (!dangling) throw new MatrixError(409,'M_CONFLICT','A different result was already reserved for this wake');
      active = { eventId: proposal.event_id!, createdAt: proposal.origin_server_ts as number, contentHash };
      await this.journal.replaceReservation(this.scope(context), key, active, await this.reservationAuthority(context));
    }
    const pendingResult = await this.eventForReservation(resultInput, active, context);
    let output = events.find(e=>e.eventId===active.eventId);
    if (!output) {
      // The reservation that is actually in force is `active`: after a takeover it
      // names a different event with a different time, and the row has to match it.
      output = await this.appendEvent(db,{roomId,type:'m.room.message',sender:resultSender,
        maker:job.agent,role:MessageRole.ASSISTANT,eventId:active.eventId,originServerTs:active.createdAt,content,
        event:pendingResult},context,events);
    } else if (this.hash(this.canonicalJson(['assistant',job.agent,output.type,output.content])) !== reservation.contentHash) {
      throw new MatrixError(409,'M_CONFLICT','Stored result no longer matches its receipt');
    }
    const run = await this.materializeRun(db,roomId,job,context,'completed',output.eventId,undefined,grant.workspace);
    const deliveryId = deliveryResource.buildId({id:job.id,thread:job.thread,createdAt:job.createdAt});
    await db.updateById(deliveryResource,deliveryId,{status:'completed',completedAt:new Date().toISOString()});
    await this.reconcileHandoff(db,output,context,events);
    return {eventId:output.eventId,run};
  }

  private async validateTrigger(db: Db, event: MatrixEventRecord, job: SharedWakeAgentJob, context: MatrixStoreContext, events: MatrixEventRecord[]): Promise<void> {
    const receipt = await this.journal.findReservation(this.scope(context),event, await this.reservationAuthority(context));
    let valid = false;
    if (event.role === MessageRole.USER && event.senderWebId) {
      valid = receipt?.contentHash === this.hash(this.canonicalJson(['user',event.senderWebId,event.type,event.content]));
      if (valid) valid = (await this.authorizeTargets(db,event.roomId,event.content,{...context,webId:event.senderWebId},events)).includes(job.agent);
    } else if (event.role === MessageRole.ASSISTANT) {
      const execution = this.parseJsonObject(event.content['co.undefineds.execution'] as JsonObjectSource);
      if (execution && typeof execution.agent === 'string' && execution.handoffTo === job.agent &&
          typeof execution.hops === 'number' && execution.hops < 8) {
        valid = receipt?.contentHash === this.hash(this.canonicalJson(['assistant',execution.agent,event.type,event.content]));
        if (valid) valid = (await this.agentGrants(db,event.roomId,context,events)).some(g=>g.agent===execution.agent && g.handoffTo.includes(job.agent));
      }
    }
    if (!valid || job.thread !== this.threadIri(event.roomId,context)) {
      throw new MatrixError(403,'M_FORBIDDEN','Trigger receipt or current execution authorization is invalid');
    }
  }

  /**
   * Whether the Pod still holds work for this job. The queue is only a working
   * set: it can spend its own in-flight attempts on claims that crashed before
   * any execution happened, so a queue-terminal job is not evidence of a
   * terminal execution. Pod facts stay authoritative.
   */
  public async isJobActionable(thread: string, job: SharedWakeAgentJob, context: MatrixStoreContext): Promise<boolean> {
    const db = await this.getDb(context);
    const values = { id: job.id, thread, createdAt: job.createdAt };
    const delivery = await db.findById(deliveryResource, deliveryResource.buildId(values));
    if (delivery && ['completed', 'failed', 'cancelled'].includes(String(delivery.status))) return false;
    const run = await db.findById(runResource, runResource.buildId(values));
    if (run?.status === 'completed' || run?.status === 'failed') return false;
    return this.runAttempts(run) < 3;
  }

  public async recordFailure(roomId: string, job: SharedWakeAgentJob,
    failure: {error?:string;retry:boolean}, context: MatrixStoreContext): Promise<void> {
    const db = await this.getDb(context);
    const values = {id:job.id,thread:job.thread,createdAt:job.createdAt};
    const existing = await db.findById(runResource,runResource.buildId(values));
    const terminal = !failure.retry || this.runAttempts(existing) >= 3;
    if (existing?.status === 'completed') return;
    await this.materializeRun(db,roomId,job,context,terminal?'failed':'queued',undefined,failure.error);
    await db.updateById(deliveryResource,deliveryResource.buildId(values),{
      status:terminal?'failed':'pending',updatedAt:new Date().toISOString(),
      ...(terminal?{completedAt:new Date().toISOString()}:{}),
    });
  }

  private runAttempts(row: {metadata?:JsonObjectSource} | null | undefined): number {
    const metadata = this.parseJsonObject(row?.metadata);
    const protocols = this.parseJsonObject(metadata?.protocols as JsonObjectSource);
    const matrix = this.parseJsonObject(protocols?.matrix as JsonObjectSource);
    return typeof matrix?.attempts === 'number' ? matrix.attempts : 0;
  }

  private async reconcileHandoff(db: Db, event: MatrixEventRecord, context: MatrixStoreContext, events?: MatrixEventRecord[]): Promise<void> {
    const execution = this.parseJsonObject(event.content['co.undefineds.execution'] as JsonObjectSource);
    if (!execution?.handoffTo || typeof execution.agent!=='string' || typeof execution.handoffTo!=='string'
      || typeof execution.hops!=='number' || execution.hops>=8 || !this.serverGroupReconcilerService) return;
    const receipt = await this.journal.findReservation(this.scope(context),event, await this.reservationAuthority(context));
    if (!receipt || receipt.contentHash !== this.hash(this.canonicalJson(['assistant',execution.agent,event.type,event.content]))) return;
    const grants = await this.agentGrants(db,event.roomId,context,events);
    if (!grants.some(g=>g.agent===execution.agent && g.handoffTo.includes(execution.handoffTo as string))) return;
    if (!await this.ensureDelivery(db,event,execution.handoffTo,context)) return;
    // Only output with an API-issued receipt can trigger a handoff; direct Pod writes cannot.
    await this.serverGroupReconcilerService.reconcileThreadMessage({thread:this.threadIri(event.roomId,context),
      triggerMessage:messageResource.buildIri(this.scope(context),{id:event.resourceId!}),actor:execution.agent,
      role:'user',createdAt:new Date(event.originServerTs).toISOString(),reconcilerOwner:'server',routeTargetAgent:execution.handoffTo,participants:grants.map(g=>g.agent)});
  }

  private async ensureDelivery(db: Db, event: MatrixEventRecord, agent: string, context: MatrixStoreContext): Promise<boolean> {
    const thread = this.threadIri(event.roomId,context);
    const triggerMessage = messageResource.buildIri(this.scope(context),{id:event.resourceId!});
    const jobId = sharedWakeAgentJobId({thread,triggerMessage,agent});
    const createdAt = new Date(event.originServerTs).toISOString();
    const id = deliveryResource.buildId({id:jobId,thread,createdAt});
    const existing = await db.findById(deliveryResource,id);
    if (existing?.status==='completed' || existing?.status==='cancelled' || existing?.status==='failed') return false;
    // Complete a write interrupted after the result Message but before Run/Delivery ACK.
    // The result is looked up through its own record rather than a derived id: the
    // id now depends on the result content, which only the record knows.
    const records = await this.listEvents(db, event.roomId, context);
    const stored = records.find(record => record.role === MessageRole.ASSISTANT &&
      this.parseJsonObject(record.content['co.undefineds.execution'] as JsonObjectSource)?.jobId === jobId);
    const receipt = stored === undefined ? undefined : await this.journal.findReservation(this.scope(context), stored, await this.reservationAuthority(context));
    const resultEventId = stored?.eventId;
    if (receipt && resultEventId) {
      const source = await db.findById(messageResource,this.messageResourceId(event.roomId,resultEventId,receipt.createdAt,this.scope(context)));
      if (source) {
        const output = this.eventSourceToRecord(source,event.roomId,context);
        if (receipt.contentHash === this.hash(this.canonicalJson(['assistant',agent,output.type,output.content]))) {
          await this.materializeRun(db,event.roomId,{id:jobId,thread,triggerMessage,agent,createdAt,status:'completed',reason:'mention'},context,'completed',resultEventId);
          await db.updateById(deliveryResource,id,{status:'completed',completedAt:new Date().toISOString()});
          return false;
        }
      }
    }
    const run = await db.findById(runResource,runResource.buildId({id:jobId,thread,createdAt}));
    if (this.runAttempts(run) >= 3) {
      const active = await this.serverGroupReconcilerService?.getQueue().listQueued(thread,agent);
      if (active?.some(job=>job.id===jobId && job.status==='leased' && Date.parse(job.leaseExpiresAt ?? '') > Date.now())) return false;
      if (!run.leaseExpiresAt || Date.parse(run.leaseExpiresAt) <= Date.now()) {
        await this.recordFailure(event.roomId,{id:jobId,thread,triggerMessage,agent,createdAt,status:'failed',reason:'mention'},
          {retry:false,error:'Execution lease exhausted its retry budget'},context);
      }
      return false;
    }
    if (!existing) await db.insert(deliveryResource).values({id,thread,chat:this.chatIri(event.roomId,context),
      source:triggerMessage,object:triggerMessage,target:agent,actor:event.senderWebId,
      kind:event.role===MessageRole.ASSISTANT?'runtime_followup':'mention_dispatch',status:'pending',
      createdAt,updatedAt:createdAt});
    return true;
  }

  private async materializeRun(db: Db, roomId: string, job: SharedWakeAgentJob, context: MatrixStoreContext,
    status: 'running'|'completed'|'failed'|'queued', eventId?: string, error?:string, workspace?:string): Promise<string> {
    const runWorkspace = workspace ?? (await this.agentGrants(db,roomId,context)).find(g=>g.agent===job.agent)?.workspace;
    const values = {id:job.id,thread:job.thread,createdAt:job.createdAt};
    const id = runResource.buildId(values);
    const iri = runResource.buildIri(this.scope(context),values);
    const existing = await db.findById(runResource,id);
    if (existing?.status==='completed') return iri;
    const now = new Date().toISOString();
    const row = {id,thread:job.thread,input:job.triggerMessage,delivery:deliveryResource.buildIri(this.scope(context),values),workspace:runWorkspace,runner:'external',status,
      leaseOwner:job.leaseOwner,leaseExpiresAt:job.leaseExpiresAt,createdAt:job.createdAt,updatedAt:now,
      ...(['completed','failed'].includes(status)?{completedAt:now}: {startedAt:now}),
      metadata:{'@id':`${iri}/metadata`,protocols:{matrix:{roomId,jobId:job.id,eventId,fencingToken:job.fencingToken,attempts:this.runAttempts(existing)+(status==='running'?1:0),error}}}};
    if (existing) await db.updateById(runResource,id,row); else await db.insert(runResource).values(row);
    const stepId = runStepResource.buildId({id:`${job.id}-${status}`,run:iri,createdAt:now});
    if (!await db.findById(runStepResource,stepId)) await db.insert(runStepResource).values({id:stepId,run:iri,
      stepType:status==='running'?'run.started':`run.${status}`,createdAt:now,payload:{'@id':`${runStepResource.buildIri(this.scope(context),{id:stepId})}/payload`,agent:job.agent,eventId}});
    return iri;
  }

  private parseJsonObject(value: JsonObjectSource): Record<string, unknown> | undefined {
    if (!value) {
      return undefined;
    }
    if (typeof value === 'object' && !Array.isArray(value)) {
      return value;
    }
    if (typeof value !== 'string') {
      return undefined;
    }
    try {
      const parsed = JSON.parse(value) as unknown;
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? parsed as Record<string, unknown>
        : undefined;
    } catch {
      return undefined;
    }
  }

  private stringValue(value: unknown): string | undefined {
    return typeof value === 'string' ? value : undefined;
  }

  private numberValue(value: unknown): number | undefined {
    if (typeof value !== 'number') {
      return undefined;
    }
    return Number.isFinite(value) ? value : undefined;
  }

  private async getRoomContext(db: Db, roomId: string, context: MatrixStoreContext): Promise<MatrixRoomContext> {
    const room = await this.findRoomSource(db, roomId, context);
    return {
      metadata: this.parseJsonObject(room?.metadata),
      participants: normalizeAgentUris(room?.participants),
    };
  }

  private reconcilerOwnerFromRoomMetadata(metadata: Record<string, unknown> | undefined): ReconcilerOwner {
    return normalizeReconcilerOwner(metadata?.reconcilerOwner, 'server');
  }

  private async reconcileGroupUserMessage(input: {
    thread: string;
    triggerMessage: string;
    actor: string;
    role: string;
    content: string;
    createdAt?: string;
    reconcilerOwner: ReconcilerOwner;
    mentions?: string[];
    routeTargetAgent?: string;
    participants?: string[];
  }): Promise<void> {
    if (!this.serverGroupReconcilerService || input.role !== MessageRole.USER) {
      return;
    }
    try {
      await this.serverGroupReconcilerService.reconcileThreadMessage({
        thread: input.thread,
        triggerMessage: input.triggerMessage,
        actor: input.actor,
        role: 'user',
        content: input.content,
        createdAt: input.createdAt,
        reconcilerOwner: input.reconcilerOwner,
        mentions: input.mentions,
        routeTargetAgent: input.routeTargetAgent,
        participants: input.participants,
      });
    } catch (error) {
      this.logger.warn(`Failed to enqueue Matrix group Reconciler wake: ${error}`);
      throw new MatrixError(503, 'M_UNKNOWN', 'Message stored; wake delivery pending. Retry the same transaction.');
    }
  }

  private messageContentFromMatrixEvent(eventType: string, content: Record<string, unknown>): string {
    if (eventType === 'm.room.message' && typeof content.body === 'string') {
      return content.body;
    }
    return JSON.stringify(content);
  }

  private mentionsFromMatrixContent(content: Record<string, unknown>): string[] {
    const matrixMentions = this.parseJsonObject(content['m.mentions'] as JsonObjectSource);
    return normalizeAgentUris([
      ...normalizeAgentUris(content.mentions),
      ...normalizeAgentUris(content['co.undefineds.mentions']),
      ...normalizeAgentUris(matrixMentions?.agents),
    ]);
  }

  private routeTargetAgentFromMatrixContent(content: Record<string, unknown>): string | undefined {
    return this.stringValue(content.routeTargetAgent)
      ?? this.stringValue(content['co.undefineds.routeTargetAgent'])
      ?? this.stringValue(content['co.undefineds.route_target_agent']);
  }

  /**
   * Let the deployment supply this participant's own signing identity before any event
   * of theirs is written. Absent hook means "the deployment serves nobody individually",
   * which keeps single-identity deployments exactly as they were.
   */
  private async ensureParticipantIdentity(context: MatrixStoreContext): Promise<void> {
    if (!this.participantIdentity) return;
    await this.participantIdentity.ensureParticipantIdentity({
      webId: context.webId,
      targetPodUrl: context.podUrl,
      context,
    });
  }

  /**
   * Hand a written event to the servers that have a member in the room.
   *
   * Deliberately outside the write's cost: a federation round trip must not sit inside a
   * local write, and a peer that is down is absorbed by the queue instead of the caller.
   * The PDU is the *persisted protocol event* — with its hashes and signature — because
   * that is what a peer verifies, and the origin is the sender's own server, so the
   * transaction is signed by the identity whose event it is.
   */
  private async queueFederationDelivery(
    roomId: string,
    context: MatrixStoreContext,
    timeline: readonly MatrixEventRecord[],
    event: PersistedMatrixEvent,
    publication?: { outbox: MatrixFederationOutbox; actor: MatrixFederationActor },
  ): Promise<void> {
    const outbox = publication?.outbox ?? this.outbound;
    if (!outbox) return;
    const origin = serverNameOf(typeof event.sender === 'string' ? event.sender : undefined);
    if (!origin) return;
    const destinations = eventDestinations({
      state: this.resolvedState(roomId, context, timeline),
      ourServerName: origin,
      event: {
        type: typeof event.type === 'string' ? event.type : '',
        ...(typeof event.state_key === 'string' ? { stateKey: event.state_key } : {}),
      },
    });
    for (const destination of destinations) {
      // The batch remembers *who* it is from, so the background send rechecks that participant's
      // current grant instead of signing with a deployment key (O1). Only the reference is queued.
      await outbox.enqueue({
        scope: this.scope(context),
        origin,
        destination,
        pdus: [ event ],
        ...(publication ? { actor: publication.actor } : this.deliverAsActor
          ? { actor: {
            webId: context.webId,
            ...(context.podUrl === undefined ? {} : { podUrl: context.podUrl }),
            // The caller's explicit named grant travels with the reference so a background send
            // rechecks *that* grant (ref/version) instead of silently taking another active one.
            ...(context.service?.taskCredential === undefined
              ? {}
              : { taskCredential: context.service.taskCredential }),
          } }
          : {}),
      });
    }
  }

  private getMatrixUserId(context: MatrixStoreContext): string {
    // The identity in an event is the participant's WebID itself. No MXID, no hash derivation, no
    // server name: `sender` and `state_key` are the WebID, so the same participant is the same
    // string in every Pod, and there is nothing to keep in step when a Pod moves.
    return context.webId;
  }

  /**
   * The MXID a WebID has under a server name: the derivation itself, so a reader that has to
   * recognise one of our users (a peer asking about a profile, say) compares against the same rule
   * instead of keeping a second copy of it. There is no table of MXIDs anywhere, which is why the
   * question "is this user ours" is answered by computing, not by looking up.
   */
  public matrixUserIdFor(webId: string, serverName: string): string {
    return matrixUserIdFor(webId, serverName);
  }

  /**
   * The server this caller's events belong to.
   *
   * A participant is their own server when this deployment holds that identity's key,
   * and only then: attributing an event to a server we cannot sign for would either
   * fail the write or, worse, sign it under a name that never signed it. So the
   * WebID host wins when it is signable, and the deployment's own name is the
   * fallback for everyone this deployment serves under one identity.
   */
  private getServerName(context: MatrixStoreContext): string {
    const host = webIdServerName(context.webId);
    if (host && (this.identities?.serverNames?.() ?? []).includes(host)) return host;
    if (this.serverName) return this.serverName;
    return host ?? 'localhost';
  }

  private displayNameFromUserId(matrixUserId: string): string {
    return matrixUserId.replace(/^@/, '').split(':')[0] || matrixUserId;
  }

  private generateRoomId(context: MatrixStoreContext): string {
    return `!${this.randomId(24)}:${this.getServerName(context)}`;
  }

  private generateEventId(context: MatrixStoreContext): string {
    return `$${this.randomId(24)}:${this.getServerName(context)}`;
  }

  private deviceId(context: MatrixStoreContext): string {
    const auth = context.auth;
    return `XPOD${this.hash(JSON.stringify([context.webId, auth?.type === 'solid' ? auth.clientId ?? auth.gatewayKeyId ?? 'solid' : 'solid'])).slice(0,24).toUpperCase()}`;
  }

  private randomId(size: number): string {
    return randomBytes(size).toString('base64url');
  }

  private surfaceIdFromRoomId(roomId: string): string {
    return roomSurfaceId(roomId);
  }

  /**
   * The public `id` that addresses a room's canonical Chat under `scope`. For a source-bound own
   * room this is the exact original source id (`canonicalChatResourceId`, which preserves percent
   * escapes and requires the public builder to reproduce the exact IRI); a foreign/legacy room uses
   * the hashed display surface. No layout is copied here.
   */
  private chatResourceId(roomId: string, scope: string): string {
    const decoded = decodeSourceBoundRoomId(roomId);
    if (decoded.status === 'source-bound') {
      const exact = canonicalChatResourceId(decoded.canonicalChatIri, scope);
      if (exact !== null) {
        return exact;
      }
    }
    return chatResource.buildId({ id: this.surfaceIdFromRoomId(roomId) });
  }

  /** The parent Chat IRI the thread/message rows attach to: the actual local Chat, exact or hashed. */
  private localChatParentIri(roomId: string, scope: string): string {
    return roomChatIri(scope, roomId);
  }

  private threadResourceId(roomId: string, scope: string): string {
    return threadResource.buildId({ id: 'thread', parent: this.localChatParentIri(roomId, scope) });
  }

  private messageResourceId(roomId: string, eventId: string, ts: number, scope: string): string {
    return messageResource.buildId({ id: this.hash(eventId),
      parent: this.localChatParentIri(roomId, scope),
      createdAt: new Date(ts).toISOString() });
  }

  /**
   * The semantic content of a received event, for the `(roomId, eventId)` conflict check.
   *
   * Retry comparison covers the fields an event is about — `sender`, `type`, `state_key`,
   * `content` — so a peer cannot keep a logical id while changing what it says, and a retry that
   * only re-arrives with a different arrival day or bookkeeping is still the same event.
   */
  private receivedContentHash(sender: string, type: string, stateKey: unknown, content: Record<string, unknown>): string {
    return this.hash(this.canonicalJson(['inbound', sender, type, typeof stateKey === 'string' ? stateKey : null, content]));
  }

  private isoToMillis(value: string | Date | null | undefined): number | undefined {
    if (!value) {
      return undefined;
    }
    const date = value instanceof Date ? value : new Date(value);
    const time = date.getTime();
    return Number.isFinite(time) ? time : undefined;
  }

  private encodeSyncToken(ts: number): string {
    return `v2_${Math.max(0, Math.floor(ts))}`;
  }

  private parseSyncToken(token: string | undefined): number {
    if (!token) {
      return 0;
    }
    if (!/^v2_\d+$/u.test(token)) throw new MatrixError(400, 'M_UNKNOWN_POS', 'Cursor version changed; start a fresh sync');
    const parsed = Number(token.slice(3));
    if (!Number.isSafeInteger(parsed)) throw new MatrixError(400, 'M_UNKNOWN_POS', 'Invalid cursor');
    return parsed;
  }

  /**
   * The opaque incremental cursor: version, operational-index epoch, the fixed page upper bound and
   * the last processed position. Bounded regardless of history size; an old epoch is an explicit
   * resync, never silently reused.
   */
  private encodeSyncCursor(epoch: string, through: number, position: number): string {
    return `v3.${epoch}.${through}.${position}`;
  }

  private parseSyncCursor(token: string | undefined): { epoch: string; through: number; position: number } | undefined {
    if (token === undefined) {
      // Only a caller with no token bootstraps; every provided token must be a valid v3 cursor.
      return undefined;
    }
    if (token.length > 128) {
      throw new MatrixError(400, 'M_UNKNOWN_POS', 'Cursor is too long; start a fresh sync');
    }
    const match = /^v3\.([0-9a-fA-F-]{36})\.(\d+)\.(\d+)$/u.exec(token);
    if (!match) {
      throw new MatrixError(400, 'M_UNKNOWN_POS', 'Cursor version changed; start a fresh sync');
    }
    const through = Number(match[2]);
    const position = Number(match[3]);
    if (!Number.isSafeInteger(through) || !Number.isSafeInteger(position) || through < 0 || position < 0) {
      throw new MatrixError(400, 'M_UNKNOWN_POS', 'Invalid cursor position');
    }
    if (position > through) {
      throw new MatrixError(400, 'M_UNKNOWN_POS', 'Cursor position is beyond its snapshot');
    }
    return { epoch: match[1], through, position };
  }
}
