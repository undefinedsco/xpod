/**
 * Watching every Pod this deployment serves.
 *
 * A `MatrixRoomChangeTracker` watches one Pod. A deployment serves several — every participant
 * whose Pod is registered here is a server of its own (`participantRoutes.ts`) — so this is the
 * piece that turns "which Pods do we serve" into "which rooms of those Pods are we watching". A
 * deployment does not have to be told, and a participant who appears, leaves or moves Pods is
 * picked up by the next reconciliation instead of by configuration.
 *
 * It is also the `MatrixRoomChangeSource` the store consults: `sync` asks by scope, and this routes
 * the question to that Pod's watcher. **A scope with no watcher answers `trust: 'all'`** — "read
 * every room" — because that is what an unwatched Pod needs; answering "nothing changed" would be
 * the one wrong answer, and it would lose events silently.
 *
 * Reconciliation is periodic for the same reason the outbox has a fallback pass: the set of served
 * Pods is derived from registrations that change while the process runs, and a watcher that was
 * never started is a Pod whose changes nobody hears about.
 */
import type { MatrixRoomChangeSource } from '../PodMatrixStore';
import type { MatrixServerRoute } from '../participantRoutes';

/** A watcher for one Pod: a change source that can be stopped. */
export interface MatrixRoomWatch {
  pending(input: { scope: string }): Promise<{ trust: 'all' | 'changed'; rooms: readonly string[] }>;
  settle(input: { scope: string; rooms: readonly string[] }): Promise<void>;
  stop(): void;
}

export interface MatrixRoomWatchServiceOptions {
  /** The Pods this deployment serves, with the participant each belongs to. */
  routes: () => Promise<readonly MatrixServerRoute[]>;
  /** The rooms to watch in one of those Pods. */
  rooms: (route: MatrixServerRoute) => Promise<readonly string[]>;
  /**
   * Start watching one Pod. Production builds a `MatrixRoomChangeTracker`; a test passes a fake so
   * nothing opens a socket. Absent means this deployment watches nothing at all.
   */
  watch?: (input: {
    route: MatrixServerRoute;
    /** The Pod's notification channel endpoint, derived from its root. */
    endpoint: string;
    rooms: () => Promise<readonly string[]>;
  }) => Promise<MatrixRoomWatch>;
  /** How often to look for Pods that appeared or went away; `0` disables the timer. */
  intervalMs?: number;
  /** Reported rather than thrown: one Pod's failure must not stop the others. */
  onError?: (error: Error) => void;
  now?: () => number;
}

/** The channel endpoint of a Pod, as Solid notifications define it: relative to the Pod root. */
export function notificationEndpointOf(podUrl: string): string {
  return new URL('.notifications/WebSocketChannel2023/', podUrl).toString();
}

export class MatrixRoomWatchService implements MatrixRoomChangeSource {
  private readonly options: MatrixRoomWatchServiceOptions;
  private readonly watches = new Map<string, MatrixRoomWatch>();
  private timer?: ReturnType<typeof setInterval>;
  private pass?: Promise<void>;
  private stopped = true;

  public constructor(options: MatrixRoomWatchServiceOptions) {
    this.options = options;
  }

  public get watchedScopes(): string[] {
    return [ ...this.watches.keys() ].sort();
  }

  public get isRunning(): boolean {
    return !this.stopped;
  }

  /** Watch every served Pod once, then keep looking for changes to that set. */
  public async start(): Promise<void> {
    this.stopped = false;
    const interval = this.options.intervalMs ?? 30_000;
    // Reconciled before the timer so the first sync after a restart is already bounded.
    await this.reconcile();
    if (interval > 0 && this.timer === undefined) {
      this.timer = setInterval(() => { void this.reconcile(); }, interval);
      this.timer.unref?.();
    }
  }

  public stop(): void {
    this.stopped = true;
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    for (const watch of this.watches.values()) watch.stop();
    this.watches.clear();
  }

  /** Start watching Pods that appeared, stop watching ones that went away. */
  public async reconcile(): Promise<void> {
    // One pass at a time: a slow Pod must not have two of its watchers racing.
    const previous = this.pass ?? Promise.resolve();
    const pass = previous.then(async () => {
      if (this.stopped) return;
      const routes = await this.options.routes();
      const served = new Map(routes.map(route => [ route.podUrl, route ]));

      for (const [ scope, watch ] of this.watches) {
        if (served.has(scope)) continue;
        watch.stop();
        this.watches.delete(scope);
      }
      if (!this.options.watch) return;
      for (const [ scope, route ] of served) {
        if (this.watches.has(scope)) continue;
        try {
          const watch = await this.options.watch({
            route,
            endpoint: notificationEndpointOf(scope),
            rooms: async () => await this.options.rooms(route),
          });
          // A pass that finished while this Pod was being watched must not add it anyway.
          if (this.stopped) {
            watch.stop();
            return;
          }
          this.watches.set(scope, watch);
        } catch (error) {
          // One Pod that cannot be watched leaves the others watched; it keeps answering
          // `trust: 'all'` until a later pass gets it.
          this.report(error);
        }
      }
    }).catch(error => { this.report(error); });
    this.pass = pass;
    await pass;
  }

  /**
   * What changed in a Pod, or "read everything" when this deployment is not watching it.
   *
   * The `scope` is the Pod root, which is the same thing the store keys its answers by, so a
   * context that selects another Pod cannot read this one's answers.
   */
  public async pending(input: { scope: string }): Promise<{ trust: 'all' | 'changed'; rooms: readonly string[] }> {
    const watch = this.watches.get(input.scope);
    if (!watch) return { trust: 'all', rooms: [] };
    return await watch.pending(input);
  }

  /** A pass read those rooms; a Pod nobody is watching has nothing to settle. */
  public async settle(input: { scope: string; rooms: readonly string[] }): Promise<void> {
    await this.watches.get(input.scope)?.settle(input);
  }

  private report(error: unknown): void {
    this.options.onError?.(error instanceof Error ? error : new Error(String(error)));
  }
}

export function createMatrixRoomWatchService(options: MatrixRoomWatchServiceOptions): MatrixRoomWatchService {
  return new MatrixRoomWatchService(options);
}
