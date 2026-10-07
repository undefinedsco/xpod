/**
 * Watching a Pod's rooms so `sync` only reads what changed.
 *
 * One subscription per room per *current day's messages document* — the resource that changes
 * when an event is appended. A container would be cheaper, but CSS only reports a parent
 * container when a resource is created (`DataAccessorBasedStore.writeData` guards that with
 * `!exists`), so a container subscription never sees a document being updated.
 *
 * The trade-off is honest and deliberate: watching a Pod of R rooms costs R channels and R
 * sockets, which buys `sync` not reading every room's whole timeline on every call. A
 * deployment that would rather not pay that simply does not configure a source, and `sync`
 * behaves as before.
 *
 * Trust is the important part. The source answers `trust: 'all'` — meaning "read every room" —
 * whenever it cannot account for everything: before it has subscribed, after a subscription
 * failed, after a socket dropped, or when a notification names a resource it cannot place. It
 * only answers `trust: 'changed'` while every room's topic is watched. A source that quietly
 * claimed completeness would be worse than no source, because a missed change would be lost.
 */
import {
  SolidNotificationSubscription,
  type NotificationSocket,
  type SolidChangeNotification,
} from './roomChangeSubscription';
import { createHmac, randomBytes } from 'node:crypto';
import { roomDirectoryIri, roomMessagesDocumentIri } from '../roomResources';
import type { MatrixRoomChangeSnapshot, MatrixRoomChangeSource } from '../PodMatrixStore';

export interface MatrixRoomChangeTrackerOptions {
  /** The Pod being watched; also the scope the answers are keyed by. */
  scope: string;
  /** The Pod's notification channel endpoint. */
  endpoint: string;
  fetch: typeof fetch;
  openSocket: (url: string) => NotificationSocket;
  /** The rooms to watch right now. */
  rooms: () => Promise<readonly string[]>;
  now?: () => number;
  /** Reported so a deployment can see why it stopped trusting its own signal. */
  onError?: (error: Error) => void;
  /** Passed through to the subscription, mostly so tests do not wait. */
  initialRetryDelayMs?: number;
  maxRetryDelayMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

export class MatrixRoomChangeTracker implements MatrixRoomChangeSource {
  private readonly options: MatrixRoomChangeTrackerOptions;
  /** Rooms with a change that no pass has read yet. */
  private readonly dirty = new Map<string, number>();
  private readonly documents = new Map<string, { roomId: string; revision: number }>();
  private readonly reconcileRooms = new Map<string, number>();
  private revision = 0;
  /**
   * A per-source secret. The observation token is a constant-sized authenticated string built from
   * the change counters at `pending` time; the tracker does not keep a per-token Map of rooms or
   * documents, so there is no unbounded token history. A tampered/wrong-scope/wrong-incarnation
   * token is rejected and clears nothing.
   */
  private readonly secret = randomBytes(32);
  private readonly incarnation = randomBytes(16).toString('hex');
  /** Topics currently watched, by resource IRI. */
  private readonly subscriptions = new Map<string, SolidNotificationSubscription>();
  /** Watched resource IRI to the room it belongs to. */
  private readonly roomByTopic = new Map<string, string>();
  /** Room directory IRI to room id, so any changed resource under it can be placed. */
  private readonly roomByDirectory = new Map<string, string>();
  private trust: 'all' | 'changed' = 'all';
  private stopped = true;
  private readonly wanted = new Map<string, string>();
  private refreshPass: Promise<void> = Promise.resolve();
  private lifecycle = 0;
  private uncertainty = 0;

  public constructor(options: MatrixRoomChangeTrackerOptions) {
    this.options = options;
  }

  /**
   * Subscribe to every room's current day document. Resolves when the first attempt is done;
   * a topic that could not be subscribed leaves the source answering `trust: 'all'`.
   */
  public async start(): Promise<void> {
    if (!this.stopped) return;
    this.stopped = false;
    this.lifecycle++;
    await this.refresh();
  }

  /** Stop watching and forget what was pending. */
  public stop(): void {
    this.stopped = true;
    this.lifecycle++;
    for (const subscription of this.subscriptions.values()) subscription.stop();
    this.subscriptions.clear();
    this.roomByTopic.clear();
    this.roomByDirectory.clear();
    this.dirty.clear();
    this.documents.clear();
    this.reconcileRooms.clear();
    this.wanted.clear();
    this.uncertainty = 0;
    this.trust = 'all';
  }

  /**
   * Bring the watched topics in line with the rooms that exist and the day that is current.
   * Call this when a room appears, when a day rolls over, or after a failure.
   */
  public async refresh(): Promise<void> {
    const lifecycle = this.lifecycle;
    const pass = this.refreshPass.then(async () => await this.refreshTopics(lifecycle));
    this.refreshPass = pass.catch(() => undefined);
    await pass;
  }

  private async refreshTopics(lifecycle: number): Promise<void> {
    if (this.stopped || lifecycle !== this.lifecycle) return;
    let rooms: readonly string[];
    try {
      rooms = await this.options.rooms();
    } catch (error) {
      if (!this.stopped && lifecycle === this.lifecycle) {
        this.trust = 'all';
        this.markUnknown();
      }
      throw error;
    }
    if (this.stopped || lifecycle !== this.lifecycle) return;
    const wanted = this.wanted;
    wanted.clear();
    this.roomByDirectory.clear();
    for (const roomId of rooms) {
      this.roomByDirectory.set(roomDirectoryIri(this.options.scope, roomId), roomId);
      const topic = roomMessagesDocumentIri(this.options.scope, roomId, new Date(this.now()));
      wanted.set(topic, roomId);
    }

    // A topic that is no longer wanted (yesterday's document, a room that is gone) is dropped.
    for (const [ topic, subscription ] of this.subscriptions) {
      if (wanted.has(topic)) continue;
      subscription.stop();
      this.subscriptions.delete(topic);
      this.roomByTopic.delete(topic);
    }

    // Until every wanted topic is watched, this source cannot account for every change.
    this.trust = 'all';
    for (const [ topic, roomId ] of wanted) {
      if (this.subscriptions.has(topic)) continue;
      const subscription = new SolidNotificationSubscription({
        endpoint: this.options.endpoint,
        topic,
        fetch: this.options.fetch,
        openSocket: this.options.openSocket,
        onChange: notification => { this.mark(notification); },
        onReady: () => {
          this.markRoom(roomId);
          this.reconsiderTrust();
        },
        // A gap, even a clean one, is a window in which a change can be missed.
        onDisconnect: () => { this.markRoom(roomId); this.trust = 'all'; },
        onError: error => { this.trust = 'all'; this.options.onError?.(error); },
        ...(this.options.initialRetryDelayMs === undefined ? {} : { initialRetryDelayMs: this.options.initialRetryDelayMs }),
        ...(this.options.maxRetryDelayMs === undefined ? {} : { maxRetryDelayMs: this.options.maxRetryDelayMs }),
        ...(this.options.sleep === undefined ? {} : { sleep: this.options.sleep }),
      });
      try {
        await subscription.start();
      } catch (error) {
        subscription.stop();
        // One topic we cannot watch is enough to make the whole answer incomplete.
        this.trust = 'all';
        this.options.onError?.(error instanceof Error ? error : new Error(String(error)));
        continue;
      }
      if (this.stopped || lifecycle !== this.lifecycle) {
        subscription.stop();
        return;
      }
      this.subscriptions.set(topic, subscription);
      this.roomByTopic.set(topic, roomId);
    }
    this.reconsiderTrust();
  }

  /** What changed and has not been read by a pass. */
  public async pending(input: { scope: string }): Promise<MatrixRoomChangeSnapshot> {
    if (input.scope !== this.options.scope || this.stopped) return { trust: 'all', rooms: [] };
    // The token is a cut-off: everything recorded at or below this revision may be settled by the
    // pass that acknowledges this exact token. A change recorded later is above the cut-off and
    // survives the settle, so a hint that arrives while a pass runs is never lost.
    const cutoff = this.revision;
    return {
      trust: this.trust, rooms: [ ...this.dirty.keys() ], snapshot: this.observation(cutoff),
      documentChanges: [ ...this.documents ].map(([ documentIri, change ]) => ({ roomId: change.roomId, documentIri })),
      reconcileRooms: [ ...this.reconcileRooms.keys() ],
    };
  }

  /** The pass has read those rooms, so their changes may be forgotten. */
  public async settle(input: Parameters<MatrixRoomChangeSource['settle']>[0]): Promise<void> {
    if (input.scope !== this.options.scope || input.snapshot === undefined || this.stopped) return;
    const token = this.verify(input.snapshot);
    if (!token) return;
    const readRooms = new Set(input.full ? token.rooms : input.rooms);
    const readDocuments = new Map((input.documentChanges ?? []).map(change => [ change.documentIri, change.roomId ]));
    // A document-only settlement clears only the named document, never a room-wide reconcile marker.
    for (const [ documentIri, observed ] of this.documents) {
      if ((readRooms.has(observed.roomId) || readDocuments.get(documentIri) === observed.roomId)
        && observed.revision <= token.cutoff) {
        this.documents.delete(documentIri);
      }
    }
    for (const roomId of readRooms) {
      const observed = this.reconcileRooms.get(roomId);
      if (observed !== undefined && observed <= token.cutoff) this.reconcileRooms.delete(roomId);
    }
    const pendingDocumentRooms = new Set([ ...this.documents.values() ].map(change => change.roomId));
    for (const roomId of readRooms) {
      const observed = this.dirty.get(roomId);
      if (observed !== undefined && observed <= token.cutoff && !pendingDocumentRooms.has(roomId)
        && !this.reconcileRooms.has(roomId)) {
        this.dirty.delete(roomId);
      }
    }
    if (input.full && token.uncertainty !== null && token.uncertainty === this.uncertainty) this.uncertainty = 0;
    this.reconsiderTrust();
  }

  /**
   * Serialize the observation as a constant-sized authenticated token. Content is canonical scope,
   * incarnation, lifecycle, revision cut-off and uncertainty — never the per-room/document maps.
   */
  private observation(cutoff: number): string {
    const body = JSON.stringify({
      scope: this.options.scope, incarnation: this.incarnation, lifecycle: this.lifecycle,
      cutoff, uncertainty: this.uncertainty === 0 ? null : this.uncertainty,
    });
    const encoded = Buffer.from(body, 'utf8').toString('base64url');
    return `${encoded}.${this.sign(encoded)}`;
  }

  /** Verify a token's signature and bind it to this source's scope/incarnation/lifecycle. */
  private verify(snapshot: string | object): { cutoff: number; uncertainty: number | null; rooms: readonly string[] } | undefined {
    if (typeof snapshot !== 'string') return undefined;
    const dot = snapshot.lastIndexOf('.');
    if (dot <= 0) return undefined;
    const encoded = snapshot.slice(0, dot);
    const signature = snapshot.slice(dot + 1);
    if (signature !== this.sign(encoded)) return undefined;
    let body: { scope?: unknown; incarnation?: unknown; lifecycle?: unknown; cutoff?: unknown; uncertainty?: unknown };
    try {
      body = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
    } catch {
      return undefined;
    }
    if (body.scope !== this.options.scope || body.incarnation !== this.incarnation
      || body.lifecycle !== this.lifecycle || typeof body.cutoff !== 'number' || !Number.isSafeInteger(body.cutoff)) {
      return undefined;
    }
    const uncertainty = body.uncertainty === null ? null
      : typeof body.uncertainty === 'number' && Number.isSafeInteger(body.uncertainty) ? body.uncertainty : undefined;
    if (uncertainty === undefined) return undefined;
    return { cutoff: body.cutoff, uncertainty, rooms: [ ...this.wanted.values() ] };
  }

  private sign(value: string): string {
    return createHmac('sha256', this.secret).update(value).digest('base64url');
  }

  /** Only claim completeness while every wanted topic is watched. */
  private reconsiderTrust(): void {
    if (this.stopped) return;
    this.trust = this.uncertainty === 0 && [ ...this.wanted.keys() ].every(topic => this.subscriptions.get(topic)?.isConnected)
      ? 'changed' : 'all';
  }

  /**
   * Record a change. The notification names the resource that changed, which is a document or
   * a container inside a room's directory; anything we cannot place means we no longer know
   * what changed, so the source stops claiming completeness.
   */
  private mark(notification: SolidChangeNotification): void {
    const changed = (notification.object ?? notification.target)?.split('#')[0];
    if (!changed) {
      this.markUnknown();
      return;
    }
    const direct = this.roomByTopic.get(changed);
    if (direct) {
      this.markRoom(direct, changed);
      return;
    }
    for (const [ directory, roomId ] of this.roomByDirectory) {
      if (changed.startsWith(directory)) {
        this.markRoom(roomId, changed.endsWith('/') ? undefined : changed);
        return;
      }
    }
    this.markUnknown();
  }

  private markUnknown(): void {
    this.trust = 'all';
    this.uncertainty = ++this.revision;
    // An unplaced notification needs an immediate full pull, even during an existing poll.
    for (const roomId of this.wanted.values()) this.markRoom(roomId);
  }

  private markRoom(roomId: string, documentIri?: string): void {
    const revision = ++this.revision;
    this.dirty.set(roomId, revision);
    if (documentIri) this.documents.set(documentIri, { roomId, revision });
    else this.reconcileRooms.set(roomId, revision);
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }
}
