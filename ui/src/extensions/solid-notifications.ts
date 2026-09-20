import type {
  SolidLiveUpdateSignal,
  SolidLiveUpdateState,
  SolidNotificationsCapability,
} from '@undefineds.co/extension-sdk/web';

/**
 * Session-scoped live updates for Pod table documents.
 *
 * One subscription per table document, never per row: a table is one RDF
 * document, so the document is the topic. Listeners of the same topic share a
 * single notification channel and a single socket, and the last listener to
 * leave closes both.
 *
 * This is a transport primitive and stays policy-free. A notification is a
 * dirty signal: the payload is never read as data, and nothing here mutates or
 * interprets table rows. Ordering metadata travels with each signal so the
 * consumer can reconcile; deciding what a change means is the consumer's job.
 *
 * Resource rules: nothing connects while the tab is hidden, nothing reconnects
 * after the session ends or the page unmounts, and a failed subscribe degrades
 * to "no live updates" instead of throwing into the page.
 *
 * An exhausted attempt budget is not a dead end. The signals that say the
 * environment itself changed - the tab became visible again, the browser came
 * back online, the window regained focus - hand every watched topic a fresh,
 * still bounded budget and try again, so a transient outage does not degrade
 * the page until the next remount. Those signals are coalesced (see
 * `REARM_COALESCE_MS`) and are the only re-arm path: nothing here polls.
 */

/** The WebSocketChannel2023 subscription service, relative to the topic origin. */
const CHANNEL_ENDPOINT_PATH = '/.notifications/WebSocketChannel2023/';
const CHANNEL_TYPE = 'http://www.w3.org/ns/solid/notifications#WebSocketChannel2023';
const NOTIFICATION_CONTEXT = 'https://www.w3.org/ns/solid/notification/v1';

/** `WebSocket.OPEN`; kept local so a fake socket only has to answer `readyState`. */
const SOCKET_OPEN = 1;

export interface SolidNotificationSocket {
  readonly readyState: number;
  onopen: ((event: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onerror: ((event: unknown) => void) | null;
  onclose: ((event: { code?: number }) => void) | null;
  close(code?: number, reason?: string): void;
}

export interface SolidNotificationsVisibilitySource {
  readonly visibilityState: DocumentVisibilityState;
  addEventListener(type: 'visibilitychange', listener: () => void): void;
  removeEventListener(type: 'visibilitychange', listener: () => void): void;
}

/** Tab close, reload or bfcache entry: the page stops being able to listen. */
export interface SolidNotificationsPageLifecycleSource {
  addEventListener(type: 'pagehide', listener: () => void): void;
  removeEventListener(type: 'pagehide', listener: () => void): void;
}

export interface SolidNotificationsSessionSource {
  getSnapshot(): { status: string };
  subscribe(listener: (snapshot: { status: string }) => void): () => void;
}

/**
 * Window-level signals that say "the environment may have changed": the browser
 * is back online, or the window was focused again. Both come from the OS or the
 * user, never from a timer.
 */
export interface SolidNotificationsEnvironmentSource {
  addEventListener(type: 'online' | 'focus', listener: () => void): void;
  removeEventListener(type: 'online' | 'focus', listener: () => void): void;
}

export interface SolidNotificationsBackoff {
  initialMs: number;
  factor: number;
  maxMs: number;
}

export interface CreateSolidNotificationsOptions {
  /** The session's authenticated fetch, the same one the applet reads with. */
  fetch: typeof fetch;
  /** Left out (rather than passed as `null`) to disable visibility pausing. */
  document?: SolidNotificationsVisibilitySource | null;
  /** Left out (rather than passed as `null`) to disable pagehide teardown. */
  page?: SolidNotificationsPageLifecycleSource | null;
  /**
   * Back-online and window-focus signals: the re-arm triggers besides becoming
   * visible again. Left out (rather than passed as `null`) to disable them.
   */
  environment?: SolidNotificationsEnvironmentSource | null;
  /** Live updates stop while the session is not authenticated. */
  session?: SolidNotificationsSessionSource;
  /** Injectable for tests; defaults to the platform `WebSocket`. */
  createSocket?: (url: string) => SolidNotificationSocket;
  /** Injectable subscription service URL for one topic. */
  channelEndpoint?: (topicUrl: string) => string;
  /**
   * Rewrites the `receiveFrom` URL of a subscription to the origin this host
   * can actually reach (see `XpodSolidRuntimeCore.resolveLocalUrl`). The socket
   * is opened with a raw `WebSocket`, so it is the one request here that cannot
   * travel through the session's fetch transport. Left out when the UI and the
   * Pod share an origin, which is the case this transport was written for.
   *
   * The subscription POST is deliberately not rewritten: the session signs it,
   * and its DPoP proof must bind the Pod's canonical URL. The canonical URL is
   * what the transport routes, once the channel path is a known local route.
   */
  resolveLocalUrl?: (url: string) => string;
  backoff?: SolidNotificationsBackoff;
  /** Attempts per arming (a topic that is re-watched or un-paused re-arms). */
  maxAttempts?: number;
  /**
   * Minimum spacing between two event-driven re-arms; defaults to
   * `REARM_COALESCE_MS`. Injectable because it is the same policy knob as
   * `backoff`, but only the *budget* is coalesced: becoming visible again always
   * re-subscribes, because hiding released the channel.
   */
  rearmCoalesceMs?: number;
}

const DEFAULT_BACKOFF: SolidNotificationsBackoff = { initialMs: 1_000, factor: 2, maxMs: 30_000 };
const DEFAULT_MAX_ATTEMPTS = 5;

/**
 * Minimum spacing between two event-driven re-arms, in milliseconds.
 *
 * Each re-arm hands every watched topic a fresh `maxAttempts` budget, and one
 * user action can produce several signals at once (`focus` and
 * `visibilitychange` land in the same frame when a tab is activated, `online`
 * follows a reconnect). Coalescing them into one re-arm is what keeps signals
 * from stacking budgets into an unbounded retry loop.
 *
 * 1s is the policy's own backoff floor (`DEFAULT_BACKOFF.initialMs`), so a
 * re-arm can never out-pace the fastest retry the bounded policy would schedule
 * by itself. It is also far shorter than the time an exhausted budget takes to
 * form (the sum of the backoff delays: ~31s with the defaults), so a genuine
 * "the environment changed" signal is never swallowed by a stale window.
 */
export const REARM_COALESCE_MS = 1_000;

interface TopicEntry {
  readonly topic: string;
  readonly listeners: Set<(signal: SolidLiveUpdateSignal) => void>;
  socket?: SolidNotificationSocket;
  channelId?: string;
  retryTimer?: ReturnType<typeof setTimeout>;
  attempts: number;
  opening: boolean;
  /** Set once a socket has opened, so a re-open knows it missed a window. */
  settled: boolean;
}

/**
 * A row IRI watches its document: `settings/credentials.ttl#openai` and
 * `settings/credentials.ttl` are one topic.
 */
export function tableDocumentTopic(topicUrl: string): string {
  const hash = topicUrl.indexOf('#');
  return hash < 0 ? topicUrl : topicUrl.slice(0, hash);
}

/**
 * The subscription response names its socket on the Pod that issued it
 * (`wss://<canonical host>/...`), and a socket is opened with a raw `WebSocket`
 * that never passes through the app's fetch transport. The rewrite rules are
 * written for fetch URLs, so the URL is offered as its `http(s)` equivalent and
 * mapped back to `ws(s)` afterwards. Everything after the scheme is preserved
 * byte for byte, so a resolver that leaves the URL alone returns the exact URL
 * the server chose, protocol included.
 *
 * Only the socket is rewritten. The subscription POST stays canonical because
 * the session signs it: rewriting before the signer binds the DPoP proof to the
 * local origin, and the Pod rejects it with a 401 (`htu` mismatch).
 */
function resolveSocketUrl(url: string, resolveLocalUrl: (url: string) => string): string {
  const fetchUrl = fetchEquivalentUrl(url);
  if (!fetchUrl) return url;
  return socketEquivalentUrl(resolveLocalUrl(fetchUrl)) ?? url;
}

function fetchEquivalentUrl(url: string): string | undefined {
  const scheme = schemeOf(url);
  if (scheme === 'wss:') return `https:${url.slice(scheme.length)}`;
  if (scheme === 'ws:') return `http:${url.slice(scheme.length)}`;
  return scheme === 'http:' || scheme === 'https:' ? url : undefined;
}

function socketEquivalentUrl(url: string): string | undefined {
  const scheme = schemeOf(url);
  if (scheme === 'https:') return `wss:${url.slice(scheme.length)}`;
  if (scheme === 'http:') return `ws:${url.slice(scheme.length)}`;
  return undefined;
}

function schemeOf(url: string): string | undefined {
  return /^[a-z][a-z\d+.-]*:/iu.exec(url)?.[0].toLowerCase();
}

/**
 * `window` when it is an event target (a browser), `null` in a test or server
 * runtime. Used for the window-scoped signals, which are the re-arm triggers
 * and the pagehide teardown.
 */
function defaultGlobalSource<T>(): T | null {
  const candidate = globalThis as { addEventListener?: unknown; removeEventListener?: unknown };
  return typeof candidate.addEventListener === 'function' && typeof candidate.removeEventListener === 'function'
    ? globalThis as unknown as T
    : null;
}

export function createSolidNotificationsCapability(
  options: CreateSolidNotificationsOptions,
): SolidNotificationsCapability {
  const authenticatedFetch = options.fetch;
  const visibilitySource = options.document === undefined
    ? (typeof document === 'undefined' ? null : document)
    : options.document;
  const pageSource = options.page === undefined
    ? defaultGlobalSource<SolidNotificationsPageLifecycleSource>()
    : options.page;
  const environmentSource = options.environment === undefined
    ? defaultGlobalSource<SolidNotificationsEnvironmentSource>()
    : options.environment;
  const createSocket = options.createSocket
    ?? ((url: string) => new WebSocket(url) as unknown as SolidNotificationSocket);
  const channelEndpoint = options.channelEndpoint
    ?? ((topicUrl: string) => new URL(CHANNEL_ENDPOINT_PATH, topicUrl).toString());
  const resolveLocalUrl = options.resolveLocalUrl;
  const localReceiveFrom = (receiveFrom: string): string => resolveLocalUrl
    ? resolveSocketUrl(receiveFrom, resolveLocalUrl)
    : receiveFrom;
  const backoff = options.backoff ?? DEFAULT_BACKOFF;
  const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const rearmCoalesceMs = options.rearmCoalesceMs ?? REARM_COALESCE_MS;

  const entries = new Map<string, TopicEntry>();
  /**
   * Signals handed to each topic so far. Kept for the lifetime of the
   * capability, not of one subscription, so a sequence never goes backwards
   * when a topic is dropped and watched again.
   */
  const deliveredByTopic = new Map<string, number>();
  const stateListeners = new Set<(state: SolidLiveUpdateState) => void>();
  let state: SolidLiveUpdateState = 'idle';
  let disposed = false;
  let authenticated = options.session ? options.session.getSnapshot().status === 'authenticated' : true;
  /** When the budget was last re-armed; `-Infinity` so the first signal lands. */
  let lastRearmAt = Number.NEGATIVE_INFINITY;
  /** The environment is observed only while at least one topic is watched. */
  let observing = false;
  let unsubscribeSession: (() => void) | undefined;

  const isVisible = (): boolean => visibilitySource?.visibilityState !== 'hidden';

  /** Still wanted: registered, visible, authenticated and not disposed. */
  const isWanted = (entry: TopicEntry): boolean => !disposed
    && authenticated
    && isVisible()
    && entries.get(entry.topic) === entry
    && entry.listeners.size > 0;

  function publish(): void {
    const next = currentState();
    if (next === state) return;
    state = next;
    for (const listener of [...stateListeners]) listener(state);
  }

  function currentState(): SolidLiveUpdateState {
    if (entries.size === 0 || disposed || !authenticated || !isVisible()) return 'idle';
    let live = false;
    let exhausted = false;
    for (const entry of entries.values()) {
      if (entry.socket?.readyState === SOCKET_OPEN) live = true;
      else if (entry.attempts >= maxAttempts) exhausted = true;
    }
    return live ? 'live' : exhausted ? 'unavailable' : 'idle';
  }

  /**
   * Hands one dirty signal to a topic's listeners.
   *
   * The sequence is per topic and strictly increasing, so a consumer can order
   * signals; `receivedAt` is when this client saw it. Whether a local write was
   * in flight is not part of the signal: the write path and the notification
   * channel are not correlated, so this transport cannot tell and does not
   * guess - a consumer correlates with its own write windows instead.
   */
  function notify(entry: TopicEntry): void {
    const sequence = (deliveredByTopic.get(entry.topic) ?? 0) + 1;
    deliveredByTopic.set(entry.topic, sequence);
    const signal: SolidLiveUpdateSignal = {
      topic: entry.topic,
      sequence,
      receivedAt: Date.now(),
    };
    for (const listener of [...entry.listeners]) listener(signal);
  }

  async function createChannel(topic: string): Promise<{ receiveFrom: string; id?: string }> {
    const response = await authenticatedFetch(channelEndpoint(topic), {
      method: 'POST',
      headers: {
        'content-type': 'application/ld+json',
        accept: 'application/ld+json',
      },
      body: JSON.stringify({
        '@context': NOTIFICATION_CONTEXT,
        '@type': CHANNEL_TYPE,
        topic,
      }),
    });
    if (!response.ok) {
      throw new Error(`Notification subscription failed with status ${response.status}`);
    }
    const channel = await response.json() as { receiveFrom?: unknown; id?: unknown; '@id'?: unknown };
    const receiveFrom = typeof channel.receiveFrom === 'string' ? channel.receiveFrom : undefined;
    if (!receiveFrom) {
      throw new Error('Notification subscription response carried no receiveFrom');
    }
    const id = typeof channel.id === 'string'
      ? channel.id
      : typeof channel['@id'] === 'string' ? channel['@id'] : undefined;
    return { receiveFrom, id };
  }

  async function deleteChannel(channelId: string | undefined): Promise<void> {
    if (!channelId) return;
    try {
      // `keepalive` lets the unsubscribe survive a pagehide/unload, so a closed
      // tab does not leave a channel behind; the server also expires channels.
      await authenticatedFetch(channelId, { method: 'DELETE', keepalive: true });
    } catch {
      // Expired or already gone.
    }
  }

  function closeSocket(entry: TopicEntry): void {
    const socket = entry.socket;
    entry.socket = undefined;
    if (!socket) return;
    socket.onopen = null;
    socket.onmessage = null;
    socket.onerror = null;
    socket.onclose = null;
    socket.close(1000, 'client unsubscribe');
  }

  /** Drops the socket, the channel and any pending retry, keeping the listeners. */
  function stop(entry: TopicEntry): void {
    if (entry.retryTimer !== undefined) {
      clearTimeout(entry.retryTimer);
      entry.retryTimer = undefined;
    }
    closeSocket(entry);
    const channelId = entry.channelId;
    entry.channelId = undefined;
    void deleteChannel(channelId);
  }

  function scheduleRetry(entry: TopicEntry): void {
    if (entry.retryTimer !== undefined) return;
    if (entry.attempts >= maxAttempts || !isWanted(entry)) {
      // Out of attempts: stay `unavailable` until the topic is re-armed by a
      // new watch, by the tab becoming visible again, or by an environment
      // signal (`online`/`focus`). Timers stop here - nothing polls.
      publish();
      return;
    }
    const delay = Math.min(
      backoff.initialMs * backoff.factor ** (entry.attempts - 1),
      backoff.maxMs,
    );
    entry.retryTimer = setTimeout(() => {
      entry.retryTimer = undefined;
      void start(entry);
    }, delay);
    publish();
  }

  function openSocket(entry: TopicEntry, receiveFrom: string): void {
    const socket = createSocket(receiveFrom);
    entry.socket = socket;
    socket.onopen = () => {
      if (entry.socket !== socket) return;
      entry.attempts = 0;
      // Only a re-open can have missed writes: re-read once to cover the gap.
      // `settled` stays set through closes and pauses, so coming back from a
      // dropped socket, a hidden tab or a bfcache restore all re-read.
      if (entry.settled) notify(entry);
      entry.settled = true;
      publish();
    };
    // A notification only says "this document changed"; the payload is not data.
    socket.onmessage = () => {
      if (entry.socket !== socket) return;
      notify(entry);
    };
    socket.onerror = () => undefined;
    socket.onclose = () => {
      if (entry.socket !== socket) return;
      entry.socket = undefined;
      const channelId = entry.channelId;
      entry.channelId = undefined;
      // A socket belongs to exactly one channel, and re-creating the
      // subscription also covers a channel the server has expired.
      void deleteChannel(channelId);
      if (!isWanted(entry)) {
        publish();
        return;
      }
      entry.attempts += 1;
      scheduleRetry(entry);
    };
  }

  async function start(entry: TopicEntry): Promise<void> {
    if (disposed || entry.opening || entry.socket || entry.retryTimer !== undefined) return;
    if (!authenticated || !isVisible() || entry.listeners.size === 0) return;
    entry.opening = true;
    publish();
    let channel: { receiveFrom: string; id?: string };
    try {
      channel = await createChannel(entry.topic);
    } catch {
      entry.opening = false;
      if (!isWanted(entry)) return;
      entry.attempts += 1;
      scheduleRetry(entry);
      return;
    }
    entry.opening = false;
    if (!isWanted(entry)) {
      void deleteChannel(channel.id);
      return;
    }
    entry.channelId = channel.id;
    openSocket(entry, localReceiveFrom(channel.receiveFrom));
  }

  function watch(
    topicUrl: string,
    listener: (signal: SolidLiveUpdateSignal) => void,
  ): () => void {
    const topic = tableDocumentTopic(topicUrl);
    let entry = entries.get(topic);
    if (!entry) {
      entry = { topic, listeners: new Set(), attempts: 0, opening: false, settled: false };
      entries.set(topic, entry);
    }
    entry.listeners.add(listener);
    startObserving();
    if (!entry.socket && !entry.opening && entry.retryTimer === undefined) {
      entry.attempts = 0;
      void start(entry);
    }
    publish();
    return () => {
      const current = entries.get(topic);
      if (!current || !current.listeners.delete(listener)) return;
      if (current.listeners.size === 0) {
        entries.delete(topic);
        stop(current);
        if (entries.size === 0) stopObserving();
      }
      publish();
    };
  }

  /** Hidden tab: hold no sockets and no server-side subscriptions. */
  function pause(): void {
    for (const entry of entries.values()) stop(entry);
    publish();
  }

  /**
   * Hands every watched topic a fresh, still bounded attempt budget, at most
   * once per `rearmCoalesceMs`. Returns whether the budget was actually
   * refreshed, so a caller can tell a re-arm from a coalesced duplicate signal.
   */
  function armBudget(): boolean {
    if (entries.size === 0) return false;
    const now = Date.now();
    if (now - lastRearmAt < rearmCoalesceMs) return false;
    lastRearmAt = now;
    for (const entry of entries.values()) entry.attempts = 0;
    return true;
  }

  /**
   * The environment changed - back online or focused again - so the retry
   * schedule computed for the old environment is stale: drop it and try now
   * with a fresh budget. Only a topic with no channel is touched, so a live or
   * in-flight one keeps its single channel, and a burst of signals collapses
   * into one re-arm instead of stacking attempts.
   */
  function rearm(): void {
    if (!armBudget()) return;
    for (const entry of entries.values()) {
      if (entry.socket !== undefined || entry.opening) continue;
      if (entry.retryTimer !== undefined) {
        clearTimeout(entry.retryTimer);
        entry.retryTimer = undefined;
      }
      void start(entry);
    }
    publish();
  }

  /**
   * Foreground (or authenticated) again: hiding released the channels, so every
   * watched topic re-subscribes unconditionally - this is a reconnect, not a
   * retry - while the budget behind it is refreshed only as often as the
   * coalescing window allows.
   */
  function resume(): void {
    armBudget();
    for (const entry of entries.values()) void start(entry);
    publish();
  }

  const handleVisibilityChange = (): void => {
    if (isVisible()) resume();
    else pause();
  };
  /** Back online or focused again: the environment changed, so try again. */
  const handleEnvironmentSignal = (): void => {
    rearm();
  };

  /**
   * The environment is observed only while a topic is watched: with nothing
   * registered there is nothing to pause, resume or re-arm, so the handlers are
   * detached and an idle capability costs nothing and leaks nothing.
   */
  function startObserving(): void {
    if (observing || disposed) return;
    observing = true;
    // Nothing ran while unobserved, so the session is re-read rather than
    // assumed to still be the one the capability was built with.
    authenticated = options.session ? options.session.getSnapshot().status === 'authenticated' : true;
    visibilitySource?.addEventListener('visibilitychange', handleVisibilityChange);
    // A page being hidden away is not watching anything any more. Pausing
    // (rather than disposing) also covers a bfcache restore, which resumes on
    // visible. `pagehide` is not a re-arm trigger: it never announces a return.
    pageSource?.addEventListener('pagehide', pause);
    environmentSource?.addEventListener('online', handleEnvironmentSignal);
    environmentSource?.addEventListener('focus', handleEnvironmentSignal);
    unsubscribeSession = options.session?.subscribe((snapshot) => {
      const next = snapshot.status === 'authenticated';
      if (next === authenticated) return;
      authenticated = next;
      if (authenticated) resume();
      else pause();
    });
  }

  function stopObserving(): void {
    if (!observing) return;
    observing = false;
    visibilitySource?.removeEventListener('visibilitychange', handleVisibilityChange);
    pageSource?.removeEventListener('pagehide', pause);
    environmentSource?.removeEventListener('online', handleEnvironmentSignal);
    environmentSource?.removeEventListener('focus', handleEnvironmentSignal);
    unsubscribeSession?.();
    unsubscribeSession = undefined;
  }

  return {
    watch,
    getState: () => state,
    subscribeState(listener) {
      stateListeners.add(listener);
      return () => {
        stateListeners.delete(listener);
      };
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      stopObserving();
      for (const entry of entries.values()) stop(entry);
      entries.clear();
      publish();
    },
  };
}
