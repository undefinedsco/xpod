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
import { roomDirectoryIri, roomMessagesDocumentIri } from '../roomResources';
import type { MatrixRoomChangeSource } from '../PodMatrixStore';

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
  private readonly dirty = new Set<string>();
  /** Topics currently watched, by resource IRI. */
  private readonly subscriptions = new Map<string, SolidNotificationSubscription>();
  /** Watched resource IRI to the room it belongs to. */
  private readonly roomByTopic = new Map<string, string>();
  /** Room directory IRI to room id, so any changed resource under it can be placed. */
  private readonly roomByDirectory = new Map<string, string>();
  private trust: 'all' | 'changed' = 'all';
  private stopped = true;

  public constructor(options: MatrixRoomChangeTrackerOptions) {
    this.options = options;
  }

  /**
   * Subscribe to every room's current day document. Resolves when the first attempt is done;
   * a topic that could not be subscribed leaves the source answering `trust: 'all'`.
   */
  public async start(): Promise<void> {
    this.stopped = false;
    await this.refresh();
  }

  /** Stop watching and forget what was pending. */
  public stop(): void {
    this.stopped = true;
    for (const subscription of this.subscriptions.values()) subscription.stop();
    this.subscriptions.clear();
    this.roomByTopic.clear();
    this.roomByDirectory.clear();
    this.dirty.clear();
    this.trust = 'all';
  }

  /**
   * Bring the watched topics in line with the rooms that exist and the day that is current.
   * Call this when a room appears, when a day rolls over, or after a failure.
   */
  public async refresh(): Promise<void> {
    if (this.stopped) return;
    const rooms = await this.options.rooms();
    const wanted = new Map<string, string>();
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
        onReady: () => { this.reconsiderTrust(wanted); },
        // A gap, even a clean one, is a window in which a change can be missed.
        onDisconnect: () => { this.trust = 'all'; },
        onError: error => { this.trust = 'all'; this.options.onError?.(error); },
        ...(this.options.initialRetryDelayMs === undefined ? {} : { initialRetryDelayMs: this.options.initialRetryDelayMs }),
        ...(this.options.maxRetryDelayMs === undefined ? {} : { maxRetryDelayMs: this.options.maxRetryDelayMs }),
        ...(this.options.sleep === undefined ? {} : { sleep: this.options.sleep }),
      });
      try {
        await subscription.start();
      } catch (error) {
        // One topic we cannot watch is enough to make the whole answer incomplete.
        this.trust = 'all';
        this.options.onError?.(error instanceof Error ? error : new Error(String(error)));
        continue;
      }
      this.subscriptions.set(topic, subscription);
      this.roomByTopic.set(topic, roomId);
    }
    this.reconsiderTrust(wanted);
  }

  /** What changed and has not been read by a pass. */
  public async pending(_input: { scope: string }): Promise<{ trust: 'all' | 'changed'; rooms: readonly string[] }> {
    return { trust: this.trust, rooms: [ ...this.dirty ] };
  }

  /** The pass has read those rooms, so their changes may be forgotten. */
  public async settle(input: { scope: string; rooms: readonly string[] }): Promise<void> {
    for (const roomId of input.rooms) this.dirty.delete(roomId);
  }

  /** Only claim completeness while every wanted topic is watched. */
  private reconsiderTrust(wanted: ReadonlyMap<string, string>): void {
    if (this.stopped) return;
    this.trust = [ ...wanted.keys() ].every(topic => this.subscriptions.has(topic)) ? 'changed' : 'all';
  }

  /**
   * Record a change. The notification names the resource that changed, which is a document or
   * a container inside a room's directory; anything we cannot place means we no longer know
   * what changed, so the source stops claiming completeness.
   */
  private mark(notification: SolidChangeNotification): void {
    const changed = notification.object ?? notification.target;
    if (!changed) {
      this.trust = 'all';
      return;
    }
    const direct = this.roomByTopic.get(changed);
    if (direct) {
      this.dirty.add(direct);
      return;
    }
    for (const [ directory, roomId ] of this.roomByDirectory) {
      if (changed.startsWith(directory)) {
        this.dirty.add(roomId);
        return;
      }
    }
    this.trust = 'all';
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }
}
