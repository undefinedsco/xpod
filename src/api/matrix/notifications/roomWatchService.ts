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
import type { MatrixRoomChangeSnapshot, MatrixRoomChangeSource } from '../PodMatrixStore';
import type { MatrixServerRoute } from '../participantRoutes';
import { parseLinkHeader } from '@solid/community-server';
import { DataFactory, Parser, Store } from 'n3';
import jsonld from 'jsonld';
import { WEB_SOCKET_CHANNEL_2023 } from './roomChangeSubscription';

/** A watcher for one Pod: a change source that can be stopped. */
export interface MatrixRoomWatch extends MatrixRoomChangeSource {
  refresh?(): Promise<void>;
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
    rooms: () => Promise<readonly string[]>;
  }) => Promise<MatrixRoomWatch>;
  /** How often to look for Pods that appeared or went away; `0` disables the timer. */
  intervalMs?: number;
  /** Reported rather than thrown: one Pod's failure must not stop the others. */
  onError?: (error: Error) => void;
  now?: () => number;
}

/** Discover the service advertised by the resource server; a Pod path does not locate it. */
export async function notificationEndpointOf(resourceUrl: string, fetch: typeof globalThis.fetch): Promise<string> {
  const resource = await fetch(resourceUrl, { method: 'HEAD' });
  if (!resource.ok) throw new Error(`Notification discovery denied: ${resource.status}`);
  const description = parseLinkHeader(resource.headers.get('link') ?? undefined).find(link =>
    link.parameters.rel?.split(/\s+/u).includes('http://www.w3.org/ns/solid/terms#storageDescription'));
  if (!description) throw new Error('The resource advertises no storage description');
  const descriptionUrl = new URL(description.target, resource.url || resourceUrl).href;
  const response = await fetch(descriptionUrl, { headers: { accept: 'text/turtle, application/ld+json;q=0.9' } });
  if (!response.ok) throw new Error(`Notification description denied: ${response.status}`);
  const body = await response.text();
  const baseIRI = response.url || descriptionUrl;
  const isJsonLd = response.headers.get('content-type')?.includes('application/ld+json');
  const text = isJsonLd ? await jsonld.toRDF(JSON.parse(body), { base: baseIRI, format: 'application/n-quads' }) as string : body;
  const store = new Store(new Parser({ baseIRI, format: isJsonLd ? 'N-Quads' : 'Turtle' }).parse(text));
  const { namedNode } = DataFactory;
  const notify = 'http://www.w3.org/ns/solid/notifications#';
  for (const subscription of store.getQuads(null, namedNode(`${notify}subscription`), null, null)) {
    if (subscription.object.termType !== 'NamedNode') continue;
    if (store.countQuads(subscription.object, namedNode(`${notify}channelType`), namedNode(WEB_SOCKET_CHANNEL_2023), null) === 0) continue;
    const endpoint = new URL(subscription.object.value);
    if (endpoint.protocol === 'https:' || endpoint.protocol === 'http:') return endpoint.href;
  }
  throw new Error('The storage description advertises no WebSocketChannel2023 service');
}

export class MatrixRoomWatchService implements MatrixRoomChangeSource {
  private readonly options: MatrixRoomWatchServiceOptions;
  private readonly watches = new Map<string, MatrixRoomWatch>();
  private readonly identities = new Map<string, string>();
  /** Pods whose last watch attempt failed, so the same failure is reported once. */
  private readonly failing = new Set<string>();
  private timer?: ReturnType<typeof setInterval>;
  private pass?: Promise<void>;
  private stopped = true;
  private routesUnavailable = false;
  private lifecycle = 0;

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
    if (!this.stopped) return;
    this.stopped = false;
    const lifecycle = ++this.lifecycle;
    const interval = this.options.intervalMs ?? 30_000;
    // Reconciled before the timer so the first sync after a restart is already bounded.
    await this.reconcile();
    if (this.active(lifecycle) && interval > 0 && this.timer === undefined) {
      this.timer = setInterval(() => { void this.reconcile(); }, interval);
      this.timer.unref?.();
    }
  }

  public stop(): void {
    this.stopped = true;
    this.lifecycle++;
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    for (const watch of this.watches.values()) watch.stop();
    this.watches.clear();
    this.identities.clear();
  }

  /** Start watching Pods that appeared, stop watching ones that went away. */
  public async reconcile(): Promise<void> {
    const lifecycle = this.lifecycle;
    // One pass at a time: a slow Pod must not have two of its watchers racing.
    const previous = this.pass ?? Promise.resolve();
    const pass = previous.then(async () => {
      if (!this.active(lifecycle)) return;
      let routes: readonly MatrixServerRoute[];
      try {
        routes = await this.options.routes();
        if (this.active(lifecycle)) this.routesUnavailable = false;
      } catch (error) {
        if (this.active(lifecycle)) this.routesUnavailable = true;
        throw error;
      }
      if (!this.active(lifecycle)) return;
      const served = new Map(routes.map(route => [ route.podUrl, route ]));

      for (const [ scope, watch ] of this.watches) {
        if (served.get(scope)?.webId === this.identities.get(scope)) continue;
        watch.stop();
        this.watches.delete(scope);
        this.identities.delete(scope);
      }
      for (const scope of [ ...this.failing ]) {
        if (!served.has(scope)) this.failing.delete(scope);
      }
      if (!this.options.watch) return;
      for (const [ scope, route ] of served) {
        if (!this.active(lifecycle)) return;
        try {
          const existing = this.watches.get(scope);
          if (existing) {
            await existing.refresh?.();
            if (!this.active(lifecycle)) return;
            this.failing.delete(scope);
            continue;
          }
          const watch = await this.options.watch({
            route,
            rooms: async () => await this.options.rooms(route),
          });
          // A pass that finished while this Pod was being watched must not add it anyway.
          if (!this.active(lifecycle)) {
            watch.stop();
            return;
          }
          this.watches.set(scope, watch);
          this.identities.set(scope, route.webId);
          this.failing.delete(scope);
        } catch (error) {
          if (!this.active(lifecycle)) return;
          this.watches.get(scope)?.stop();
          this.watches.delete(scope);
          this.identities.delete(scope);
          // One Pod that cannot be watched leaves the others watched; it keeps answering
          // `trust: 'all'` until a later pass gets it. A Pod that keeps failing is reported once
          // rather than on every pass — a log that repeats itself every 30 seconds hides the rest.
          if (!this.failing.has(scope)) {
            this.failing.add(scope);
            this.report(error);
          }
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
  public async pending(input: { scope: string }): Promise<MatrixRoomChangeSnapshot> {
    const watch = this.watches.get(input.scope);
    if (!watch || this.routesUnavailable || this.failing.has(input.scope)) return { trust: 'all', rooms: [] };
    return await watch.pending(input);
  }

  /** A pass read those rooms; a Pod nobody is watching has nothing to settle. */
  public async settle(input: Parameters<MatrixRoomChangeSource['settle']>[0]): Promise<void> {
    await this.watches.get(input.scope)?.settle(input);
  }

  private report(error: unknown): void {
    this.options.onError?.(error instanceof Error ? error : new Error(String(error)));
  }

  private active(lifecycle: number): boolean {
    return !this.stopped && lifecycle === this.lifecycle;
  }
}

export function createMatrixRoomWatchService(options: MatrixRoomWatchServiceOptions): MatrixRoomWatchService {
  return new MatrixRoomWatchService(options);
}
