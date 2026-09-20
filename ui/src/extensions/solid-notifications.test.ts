import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import {
  createSolidNotificationsCapability,
  tableDocumentTopic,
  REARM_COALESCE_MS,
  type SolidNotificationSocket,
  type SolidNotificationsBackoff,
  type SolidNotificationsEnvironmentSource,
  type SolidNotificationsPageLifecycleSource,
  type SolidNotificationsSessionSource,
  type SolidNotificationsVisibilitySource,
} from './solid-notifications';

const POD_ORIGIN = 'https://pod.example';
const CHANNEL_BASE = `${POD_ORIGIN}/.notifications/WebSocketChannel2023/`;
const CREDENTIALS = `${POD_ORIGIN}/alice/settings/credentials.ttl`;
const OPENAI = `${POD_ORIGIN}/alice/settings/providers/openai.ttl`;
const CHANNEL_TYPE = 'http://www.w3.org/ns/solid/notifications#WebSocketChannel2023';

class FakeSocket implements SolidNotificationSocket {
  readyState = 0;
  onopen: ((event: unknown) => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  onclose: ((event: { code?: number }) => void) | null = null;
  closed: { code?: number; reason?: string } | undefined;

  constructor(readonly url: string) {}

  /** The browser hands control to the app once the handshake finished. */
  open(): void {
    this.readyState = 1;
    this.onopen?.({});
  }

  deliver(payload = '{"type":"Update"}'): void {
    this.onmessage?.({ data: payload });
  }

  /** Connection lost without the client asking for it (1006). */
  drop(): void {
    this.readyState = 3;
    this.onclose?.({ code: 1006 });
  }

  close(code?: number, reason?: string): void {
    this.closed = { code, reason };
    this.readyState = 3;
  }
}

interface RecordedRequest {
  url: string;
  method: string;
  body?: Record<string, unknown>;
  keepalive?: boolean;
}

class FakeVisibility implements SolidNotificationsVisibilitySource {
  visibilityState: DocumentVisibilityState = 'visible';
  private readonly listeners = new Set<() => void>();

  addEventListener(_type: 'visibilitychange', listener: () => void): void {
    this.listeners.add(listener);
  }

  removeEventListener(_type: 'visibilitychange', listener: () => void): void {
    this.listeners.delete(listener);
  }

  set(state: DocumentVisibilityState): void {
    this.visibilityState = state;
    for (const listener of [...this.listeners]) listener();
  }

  listenerCount(): number {
    return this.listeners.size;
  }
}

class FakePage implements SolidNotificationsPageLifecycleSource {
  private readonly listeners = new Set<() => void>();

  addEventListener(_type: 'pagehide', listener: () => void): void {
    this.listeners.add(listener);
  }

  removeEventListener(_type: 'pagehide', listener: () => void): void {
    this.listeners.delete(listener);
  }

  hide(): void {
    for (const listener of [...this.listeners]) listener();
  }

  listenerCount(): number {
    return this.listeners.size;
  }
}

/** Back-online and window-focus signals, as `window` delivers them. */
class FakeEnvironment implements SolidNotificationsEnvironmentSource {
  private readonly listeners = new Map<'online' | 'focus', Set<() => void>>();

  addEventListener(type: 'online' | 'focus', listener: () => void): void {
    const listeners = this.listeners.get(type) ?? new Set<() => void>();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: 'online' | 'focus', listener: () => void): void {
    this.listeners.get(type)?.delete(listener);
  }

  online(): void {
    this.emit('online');
  }

  focus(): void {
    this.emit('focus');
  }

  listenerCount(): number {
    let count = 0;
    for (const listeners of this.listeners.values()) count += listeners.size;
    return count;
  }

  private emit(type: 'online' | 'focus'): void {
    for (const listener of [...(this.listeners.get(type) ?? [])]) listener();
  }
}

class FakeSession implements SolidNotificationsSessionSource {
  private status = 'authenticated';
  private readonly listeners = new Set<(snapshot: { status: string }) => void>();

  getSnapshot(): { status: string } {
    return { status: this.status };
  }

  subscribe(listener: (snapshot: { status: string }) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  set(status: string): void {
    this.status = status;
    for (const listener of [...this.listeners]) listener({ status });
  }

  listenerCount(): number {
    return this.listeners.size;
  }
}

let visibility: FakeVisibility;
let page: FakePage;
let environment: FakeEnvironment;
let session: FakeSession;

function createHarness(options: {
  failSubscriptions?: boolean;
  status?: number;
  resolveLocalUrl?: (url: string) => string;
  backoff?: SolidNotificationsBackoff;
  maxAttempts?: number;
} = {}) {
  const requests: RecordedRequest[] = [];
  const sockets: FakeSocket[] = [];
  let channels = 0;
  let failed = options.failSubscriptions ?? false;
  const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    const body = typeof init?.body === 'string'
      ? JSON.parse(init.body) as Record<string, unknown>
      : undefined;
    requests.push({ url, method, body, keepalive: init?.keepalive });
    if (method === 'POST') {
      if (failed) return new Response('nope', { status: options.status ?? 500 });
      channels += 1;
      const id = `${CHANNEL_BASE}channel-${channels}`;
      return Response.json({
        '@context': ['https://www.w3.org/ns/solid/notification/v1'],
        id,
        type: CHANNEL_TYPE,
        topic: body?.topic,
        receiveFrom: id.replace('https://', 'wss://'),
      });
    }
    return new Response(null, { status: 205 });
  }) as unknown as typeof fetch;

  const capability = createSolidNotificationsCapability({
    fetch: fetchImpl,
    document: visibility,
    page,
    environment,
    session,
    ...(options.resolveLocalUrl ? { resolveLocalUrl: options.resolveLocalUrl } : {}),
    createSocket: (url) => {
      const socket = new FakeSocket(url);
      sockets.push(socket);
      return socket;
    },
    backoff: options.backoff ?? { initialMs: 1_000, factor: 2, maxMs: 30_000 },
    maxAttempts: options.maxAttempts ?? 3,
  });

  const posts = () => requests.filter((request) => request.method === 'POST');
  const deletes = () => requests.filter((request) => request.method === 'DELETE');
  const channelUrl = (index: number) => `${CHANNEL_BASE}channel-${index}`;
  return {
    capability,
    requests,
    sockets,
    posts,
    deletes,
    channelUrl,
    /** The transport heals (or breaks) mid-test; the page does not remount. */
    setFailSubscriptions(value: boolean) {
      failed = value;
    },
  };
}

/** Let the subscription POST and the socket handshake settle. */
async function settle(): Promise<void> {
  for (let index = 0; index < 12; index += 1) await Promise.resolve();
}

/** Burns the harness' default three-attempt budget (1s + 2s apart): `unavailable`. */
async function exhaustBudget(harness: ReturnType<typeof createHarness>): Promise<void> {
  await settle();
  await vi.advanceTimersByTimeAsync(1_000);
  await settle();
  await vi.advanceTimersByTimeAsync(2_000);
  await settle();
}

beforeEach(() => {
  vi.useFakeTimers();
  visibility = new FakeVisibility();
  page = new FakePage();
  environment = new FakeEnvironment();
  session = new FakeSession();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('Solid notification subscriptions', () => {
  test('shares one channel and one socket between two watchers of a table document', async () => {
    const harness = createHarness();
    const first = vi.fn();
    const second = vi.fn();

    const releaseFirst = harness.capability.watch(CREDENTIALS, first);
    const releaseSecond = harness.capability.watch(CREDENTIALS, second);
    await settle();

    expect(harness.posts()).toHaveLength(1);
    expect(harness.posts()[0]!.url).toBe(CHANNEL_BASE);
    expect(harness.posts()[0]!.body).toEqual({
      '@context': 'https://www.w3.org/ns/solid/notification/v1',
      '@type': CHANNEL_TYPE,
      topic: CREDENTIALS,
    });
    expect(harness.sockets).toHaveLength(1);

    harness.sockets[0]!.open();
    expect(harness.capability.getState()).toBe('live');

    harness.sockets[0]!.deliver();
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);
    // Delivery metadata travels with the signal, per topic and ordered.
    expect(first).toHaveBeenCalledWith({
      topic: CREDENTIALS,
      sequence: 1,
      receivedAt: expect.any(Number),
    });

    // One listener leaving must not disturb the shared channel.
    releaseFirst();
    harness.sockets[0]!.deliver();
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(2);
    expect(second.mock.calls[1]![0]).toMatchObject({ topic: CREDENTIALS, sequence: 2 });
    expect(harness.sockets[0]!.closed).toBeUndefined();
    expect(harness.deletes()).toHaveLength(0);

    // The last one closes the socket and deletes the subscription.
    releaseSecond();
    await settle();
    expect(harness.sockets[0]!.closed).toEqual({ code: 1000, reason: 'client unsubscribe' });
    expect(harness.deletes().map((request) => request.url)).toEqual([harness.channelUrl(1)]);
    expect(harness.deletes()[0]!.keepalive).toBe(true);
    expect(harness.capability.getState()).toBe('idle');
  });

  test('watches one document per table, never one subscription per row', async () => {
    const harness = createHarness();
    const releaseRow = harness.capability.watch(`${CREDENTIALS}#openai-primary`, vi.fn());
    const releaseDocument = harness.capability.watch(CREDENTIALS, vi.fn());
    await settle();

    expect(tableDocumentTopic(`${CREDENTIALS}#openai-primary`)).toBe(CREDENTIALS);
    expect(harness.posts()).toHaveLength(1);
    expect(harness.posts()[0]!.body).toMatchObject({ topic: CREDENTIALS });

    releaseRow();
    releaseDocument();
    await settle();
  });

  test('keeps one socket per document, so two tables cost two channels', async () => {
    const harness = createHarness();
    const releaseCredentials = harness.capability.watch(CREDENTIALS, vi.fn());
    const releaseProvider = harness.capability.watch(OPENAI, vi.fn());
    await settle();

    expect(harness.posts().map((request) => request.body?.topic)).toEqual([CREDENTIALS, OPENAI]);
    expect(harness.sockets).toHaveLength(2);

    harness.sockets[0]!.open();
    harness.sockets[1]!.open();
    expect(harness.capability.getState()).toBe('live');

    releaseCredentials();
    await settle();
    expect(harness.sockets[0]!.closed).toBeDefined();
    expect(harness.sockets[1]!.closed).toBeUndefined();
    // The provider document is still watched, so live updates stay on.
    expect(harness.capability.getState()).toBe('live');

    releaseProvider();
    await settle();
    expect(harness.capability.getState()).toBe('idle');
  });

  test('recreates the subscription after an unexpected close, with a bounded delay', async () => {
    const harness = createHarness();
    const listener = vi.fn();
    const release = harness.capability.watch(CREDENTIALS, listener);
    await settle();
    harness.sockets[0]!.open();
    expect(listener).not.toHaveBeenCalled();

    harness.sockets[0]!.drop();
    expect(harness.capability.getState()).toBe('idle');
    // A socket belongs to exactly one channel: the dead one is dropped.
    await settle();
    expect(harness.deletes().map((request) => request.url)).toEqual([harness.channelUrl(1)]);

    await vi.advanceTimersByTimeAsync(999);
    expect(harness.posts()).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    await settle();
    expect(harness.posts()).toHaveLength(2);
    expect(harness.sockets).toHaveLength(2);
    expect(harness.sockets[1]!.url).toBe('wss://pod.example/.notifications/WebSocketChannel2023/channel-2');

    harness.sockets[1]!.open();
    expect(harness.capability.getState()).toBe('live');
    // Reconnecting may have missed writes, so the page is told to re-read once.
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener.mock.calls[0]![0]).toMatchObject({ topic: CREDENTIALS, sequence: 1 });

    release();
    await settle();
  });

  test('gives up after a bounded number of attempts and reports unavailable', async () => {
    const harness = createHarness({ failSubscriptions: true });
    const listener = vi.fn();
    const release = harness.capability.watch(CREDENTIALS, listener);

    // Three attempts (the harness limit), each one backoff window apart.
    await settle();
    expect(harness.posts()).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1_000);
    await settle();
    expect(harness.posts()).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(2_000);
    await settle();
    expect(harness.posts()).toHaveLength(3);
    expect(harness.capability.getState()).toBe('unavailable');

    // Bounded: nothing retries afterwards, and no timer is left running.
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    await settle();
    expect(harness.posts()).toHaveLength(3);
    expect(harness.sockets).toHaveLength(0);
    expect(listener).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);

    release();
    expect(harness.capability.getState()).toBe('idle');
  });

  test('re-arms an exhausted budget when the tab becomes visible again', async () => {
    const harness = createHarness({ failSubscriptions: true });
    const listener = vi.fn();
    const states: string[] = [];
    const unsubscribeState = harness.capability.subscribeState((state) => states.push(state));
    const release = harness.capability.watch(CREDENTIALS, listener);
    await exhaustBudget(harness);
    expect(harness.posts()).toHaveLength(3);
    expect(harness.capability.getState()).toBe('unavailable');
    expect(states).toEqual(['unavailable']);

    visibility.set('hidden');
    await settle();
    expect(harness.capability.getState()).toBe('idle');

    // The transport recovered while the tab was away; the page never remounted.
    harness.setFailSubscriptions(false);
    visibility.set('visible');
    await settle();
    expect(harness.posts()).toHaveLength(4);
    expect(harness.sockets).toHaveLength(1);

    harness.sockets[0]!.open();
    expect(harness.capability.getState()).toBe('live');
    // The chip clears without a remount: the observer saw the recovery.
    expect(states).toEqual(['unavailable', 'idle', 'live']);

    release();
    await settle();
    expect(harness.deletes().map((request) => request.url)).toEqual([harness.channelUrl(1)]);
    unsubscribeState();
  });

  test('re-arms an exhausted budget when the browser comes back online', async () => {
    const harness = createHarness({ failSubscriptions: true });
    const release = harness.capability.watch(CREDENTIALS, vi.fn());
    await exhaustBudget(harness);
    expect(harness.capability.getState()).toBe('unavailable');

    harness.setFailSubscriptions(false);
    environment.online();
    await settle();
    // Exactly one fresh attempt, and it creates the topic's channel.
    expect(harness.posts()).toHaveLength(4);
    expect(harness.sockets).toHaveLength(1);

    harness.sockets[0]!.open();
    expect(harness.capability.getState()).toBe('live');

    release();
    await settle();
    expect(harness.deletes().map((request) => request.url)).toEqual([harness.channelUrl(1)]);
  });

  test('coalesces a burst of environment signals into a single re-arm', async () => {
    // A 3s backoff keeps the coalescing window strictly inside a retry delay,
    // so the attempt counts below isolate the signals from the retry timer.
    const harness = createHarness({
      failSubscriptions: true,
      backoff: { initialMs: 3_000, factor: 2, maxMs: 30_000 },
    });
    const release = harness.capability.watch(CREDENTIALS, vi.fn());
    await settle();
    await vi.advanceTimersByTimeAsync(3_000);
    await settle();
    await vi.advanceTimersByTimeAsync(6_000);
    await settle();
    expect(harness.posts()).toHaveLength(3);
    expect(harness.capability.getState()).toBe('unavailable');

    // One user action fires focus, online and visibility together.
    environment.focus();
    environment.online();
    environment.focus();
    visibility.set('visible');
    await settle();
    expect(harness.posts()).toHaveLength(4);

    // Still inside the window: the duplicates do not stack a second attempt.
    environment.online();
    visibility.set('visible');
    await settle();
    expect(harness.posts()).toHaveLength(4);

    // The window expires, so the next signal re-arms again - and it replaces
    // the retry that was scheduled for the environment that has now changed.
    await vi.advanceTimersByTimeAsync(REARM_COALESCE_MS);
    await settle();
    expect(harness.posts()).toHaveLength(4);
    environment.focus();
    await settle();
    expect(harness.posts()).toHaveLength(5);

    // The replaced retry never fires on its own: one attempt per re-arm.
    await vi.advanceTimersByTimeAsync(2_000);
    await settle();
    expect(harness.posts()).toHaveLength(5);

    release();
    await settle();
    expect(vi.getTimerCount()).toBe(0);
  });

  test('re-arms with a bounded budget, not an unbounded loop', async () => {
    const harness = createHarness({ failSubscriptions: true });
    const states: string[] = [];
    const unsubscribeState = harness.capability.subscribeState((state) => states.push(state));
    const release = harness.capability.watch(CREDENTIALS, vi.fn());
    await exhaustBudget(harness);
    expect(harness.capability.getState()).toBe('unavailable');

    // A re-arm hands the same three attempts back, not an endless supply.
    environment.online();
    await settle();
    expect(harness.posts()).toHaveLength(4);
    await vi.advanceTimersByTimeAsync(1_000);
    await settle();
    expect(harness.posts()).toHaveLength(5);
    await vi.advanceTimersByTimeAsync(2_000);
    await settle();
    expect(harness.posts()).toHaveLength(6);
    expect(harness.capability.getState()).toBe('unavailable');
    expect(states).toEqual(['unavailable', 'idle', 'unavailable']);

    // The fresh budget runs out exactly like the first one: no timer is left.
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    await settle();
    expect(harness.posts()).toHaveLength(6);
    expect(vi.getTimerCount()).toBe(0);

    // And a later signal re-arms again: `unavailable` is never a latch.
    environment.focus();
    await settle();
    expect(harness.posts()).toHaveLength(7);

    release();
    await settle();
    unsubscribeState();
  });

  test('keeps exactly one channel per topic across a re-arm', async () => {
    const harness = createHarness({ failSubscriptions: true });
    const listener = vi.fn();
    const release = harness.capability.watch(CREDENTIALS, listener);
    await exhaustBudget(harness);
    expect(harness.capability.getState()).toBe('unavailable');

    harness.setFailSubscriptions(false);
    environment.online();
    await settle();
    expect(harness.posts().map((request) => request.body?.topic)).toEqual([
      CREDENTIALS,
      CREDENTIALS,
      CREDENTIALS,
      CREDENTIALS,
    ]);
    expect(harness.sockets).toHaveLength(1);
    harness.sockets[0]!.open();
    expect(harness.capability.getState()).toBe('live');

    // A topic that is live keeps its one channel: a later re-arm adds nothing.
    await vi.advanceTimersByTimeAsync(REARM_COALESCE_MS);
    environment.focus();
    visibility.set('visible');
    await settle();
    expect(harness.posts()).toHaveLength(4);
    expect(harness.sockets).toHaveLength(1);

    // The one channel still carries signals, and releasing deletes it.
    harness.sockets[0]!.deliver();
    expect(listener).toHaveBeenCalledTimes(1);
    release();
    await settle();
    expect(harness.sockets[0]!.closed).toEqual({ code: 1000, reason: 'client unsubscribe' });
    expect(harness.deletes().map((request) => request.url)).toEqual([harness.channelUrl(1)]);
  });

  test('never throws into the page when subscribing fails', async () => {
    const harness = createHarness({ failSubscriptions: true, status: 503 });
    const listener = vi.fn();

    expect(() => harness.capability.watch(CREDENTIALS, listener)).not.toThrow();
    await settle();
    await vi.advanceTimersByTimeAsync(10_000);
    await settle();

    expect(harness.capability.getState()).toBe('unavailable');
    expect(listener).not.toHaveBeenCalled();
  });

  test('holds no socket while the tab is hidden, and resumes on visible', async () => {
    const harness = createHarness();
    const listener = vi.fn();
    const release = harness.capability.watch(CREDENTIALS, listener);
    await settle();
    harness.sockets[0]!.open();
    expect(harness.capability.getState()).toBe('live');

    visibility.set('hidden');
    await settle();
    expect(harness.sockets[0]!.closed).toEqual({ code: 1000, reason: 'client unsubscribe' });
    expect(harness.deletes().map((request) => request.url)).toEqual([harness.channelUrl(1)]);
    expect(harness.capability.getState()).toBe('idle');
    expect(harness.sockets).toHaveLength(1);

    // Nothing is polled while hidden: no request at all, even much later.
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    await settle();
    expect(harness.requests).toHaveLength(2);

    visibility.set('visible');
    await settle();
    expect(harness.posts()).toHaveLength(2);
    expect(harness.sockets).toHaveLength(2);

    harness.sockets[1]!.open();
    expect(harness.capability.getState()).toBe('live');
    // The hidden window may have contained writes, so the page re-reads once.
    expect(listener).toHaveBeenCalledTimes(1);

    release();
    await settle();
  });

  test('does not leave a channel behind when the page goes away', async () => {
    const harness = createHarness();
    const release = harness.capability.watch(CREDENTIALS, vi.fn());
    await settle();
    harness.sockets[0]!.open();

    page.hide();
    await settle();
    expect(harness.deletes().map((request) => request.url)).toEqual([harness.channelUrl(1)]);
    expect(harness.capability.getState()).toBe('idle');

    release();
    await settle();
  });

  test('stops reconnecting once the session is gone, and resumes with a new one', async () => {
    const harness = createHarness();
    const release = harness.capability.watch(CREDENTIALS, vi.fn());
    await settle();
    harness.sockets[0]!.open();
    expect(harness.capability.getState()).toBe('live');

    session.set('anonymous');
    await settle();
    expect(harness.sockets[0]!.closed).toBeDefined();
    expect(harness.capability.getState()).toBe('idle');

    // No requests and no retries at all while the session is gone.
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    await settle();
    expect(harness.requests).toHaveLength(2);

    session.set('authenticated');
    await settle();
    expect(harness.posts()).toHaveLength(2);
    harness.sockets[1]!.open();
    expect(harness.capability.getState()).toBe('live');

    release();
    await settle();
  });

  test('creates no polling timers: a live socket stays idle until it speaks', async () => {
    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval');
    const harness = createHarness();
    const listener = vi.fn();
    const release = harness.capability.watch(CREDENTIALS, listener);
    await settle();
    harness.sockets[0]!.open();
    expect(vi.getTimerCount()).toBe(0);

    // The re-arm signals are events, not a schedule: they cost nothing while
    // idle and never disturb a topic that is already live.
    environment.online();
    environment.focus();
    visibility.set('visible');
    await settle();

    await vi.advanceTimersByTimeAsync(30 * 60_000);
    await settle();

    expect(harness.requests).toHaveLength(1);
    expect(harness.sockets).toHaveLength(1);
    expect(listener).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    expect(setIntervalSpy).not.toHaveBeenCalled();

    // Only a real signal triggers the page.
    harness.sockets[0]!.deliver();
    expect(listener).toHaveBeenCalledTimes(1);

    release();
    await settle();
    expect(vi.getTimerCount()).toBe(0);
    setIntervalSpy.mockRestore();
  });

  test('detaches its environment listeners on the last unsubscribe and on dispose', async () => {
    const harness = createHarness();
    // Nothing is watched yet, so nothing is observed.
    expect(visibility.listenerCount()).toBe(0);
    expect(page.listenerCount()).toBe(0);
    expect(environment.listenerCount()).toBe(0);
    expect(session.listenerCount()).toBe(0);

    const release = harness.capability.watch(CREDENTIALS, vi.fn());
    await settle();
    expect(visibility.listenerCount()).toBe(1);
    expect(page.listenerCount()).toBe(1);
    expect(environment.listenerCount()).toBe(2);
    expect(session.listenerCount()).toBe(1);

    // The last listener leaving leaves no handler behind.
    release();
    await settle();
    expect(visibility.listenerCount()).toBe(0);
    expect(page.listenerCount()).toBe(0);
    expect(environment.listenerCount()).toBe(0);
    expect(session.listenerCount()).toBe(0);

    // Watching again attaches exactly one handler per signal, never two.
    const releaseAgain = harness.capability.watch(CREDENTIALS, vi.fn());
    await settle();
    expect(visibility.listenerCount()).toBe(1);
    expect(page.listenerCount()).toBe(1);
    expect(environment.listenerCount()).toBe(2);
    expect(session.listenerCount()).toBe(1);

    harness.capability.dispose();
    await settle();
    expect(visibility.listenerCount()).toBe(0);
    expect(page.listenerCount()).toBe(0);
    expect(environment.listenerCount()).toBe(0);
    expect(session.listenerCount()).toBe(0);
    expect(vi.getTimerCount()).toBe(0);

    releaseAgain();
  });

  test('dispose closes every socket, deletes every channel and detaches its listeners', async () => {
    const harness = createHarness();
    const releaseCredentials = harness.capability.watch(CREDENTIALS, vi.fn());
    const releaseProvider = harness.capability.watch(OPENAI, vi.fn());
    await settle();
    harness.sockets.forEach((socket) => socket.open());

    harness.capability.dispose();
    await settle();

    expect(harness.sockets.every((socket) => socket.closed !== undefined)).toBe(true);
    expect(harness.deletes().map((request) => request.url)).toEqual([
      harness.channelUrl(1),
      harness.channelUrl(2),
    ]);
    expect(harness.capability.getState()).toBe('idle');
    expect(visibility.listenerCount()).toBe(0);

    // Disposed means disposed: a late watch does not reopen anything.
    const late = harness.capability.watch(CREDENTIALS, vi.fn());
    await settle();
    expect(harness.posts()).toHaveLength(2);
    late();
    releaseCredentials();
    releaseProvider();
  });

  test('keeps a per-topic signal sequence that never goes backwards', async () => {
    const harness = createHarness();
    const first = vi.fn();
    const releaseFirst = harness.capability.watch(CREDENTIALS, first);
    await settle();
    harness.sockets[0]!.open();
    harness.sockets[0]!.deliver();
    expect(first.mock.calls[0]![0]).toMatchObject({ sequence: 1 });

    // Losing the last listener and watching the same document again must not
    // restart the sequence: a consumer orders signals by it.
    releaseFirst();
    await settle();
    const second = vi.fn();
    const releaseSecond = harness.capability.watch(CREDENTIALS, second);
    await settle();
    harness.sockets[1]!.open();
    harness.sockets[1]!.deliver();
    expect(second.mock.calls[0]![0]).toMatchObject({ topic: CREDENTIALS, sequence: 2 });

    releaseSecond();
    await settle();
  });

  test('reports state changes to observers', async () => {
    const harness = createHarness();
    const states: string[] = [];
    const unsubscribe = harness.capability.subscribeState((state) => states.push(state));

    const release = harness.capability.watch(CREDENTIALS, vi.fn());
    await settle();
    harness.sockets[0]!.open();
    expect(states).toEqual(['live']);

    release();
    await settle();
    expect(states).toEqual(['live', 'idle']);

    unsubscribe();
  });
});

describe('Solid notification local routing', () => {
  const toLocalOrigin = (url: string): string => url.replace(`${POD_ORIGIN}/`, 'http://127.0.0.1:3000/');

  test('connects through the local origin when a resolver is injected', async () => {
    const harness = createHarness({ resolveLocalUrl: toLocalOrigin });
    const release = harness.capability.watch(CREDENTIALS, vi.fn());
    await settle();

    // The subscription POST stays canonical: the session signs it, so the DPoP
    // proof must bind the Pod's URL. The transport routes the canonical URL.
    expect(harness.posts()).toHaveLength(1);
    expect(harness.posts()[0]!.url).toBe(CHANNEL_BASE);
    expect(harness.posts()[0]!.body).toMatchObject({ topic: CREDENTIALS });

    // The server named `wss://pod.example/...`; the socket follows the rewrite,
    // because a raw WebSocket never passes through the transport.
    expect(harness.sockets).toHaveLength(1);
    expect(harness.sockets[0]!.url).toBe('ws://127.0.0.1:3000/.notifications/WebSocketChannel2023/channel-1');
    harness.sockets[0]!.open();
    expect(harness.capability.getState()).toBe('live');

    release();
    await settle();
    expect(harness.sockets[0]!.closed).toEqual({ code: 1000, reason: 'client unsubscribe' });
  });

  test('never pre-rewrites the subscription POST, even with a resolver injected', async () => {
    const resolveLocalUrl = vi.fn(toLocalOrigin);
    const harness = createHarness({ resolveLocalUrl });
    const release = harness.capability.watch(CREDENTIALS, vi.fn());
    await settle();

    // The session signs the POST, so the DPoP proof must bind the canonical
    // URL: resolving it first would move the request outside the transport's
    // canonical routes and the Pod would reject it as unauthenticated.
    expect(harness.posts().map((request) => request.url)).toEqual([CHANNEL_BASE]);
    // The resolver only ever sees what the socket needs: the subscription's
    // `receiveFrom`, offered as its fetch-scheme equivalent.
    expect(resolveLocalUrl.mock.calls.map(([url]) => url)).toEqual([
      'https://pod.example/.notifications/WebSocketChannel2023/channel-1',
    ]);

    release();
    await settle();
  });

  test('keeps the canonical channel URL and the wss: socket without a resolver', async () => {
    const harness = createHarness();
    const release = harness.capability.watch(CREDENTIALS, vi.fn());
    await settle();

    expect(harness.posts()[0]!.url).toBe(CHANNEL_BASE);
    expect(harness.sockets[0]!.url).toBe('wss://pod.example/.notifications/WebSocketChannel2023/channel-1');

    release();
    await settle();
  });

  test('keeps the server-chosen wss: socket when the resolver passes the URL through', async () => {
    const harness = createHarness({ resolveLocalUrl: (url) => url });
    const release = harness.capability.watch(CREDENTIALS, vi.fn());
    await settle();

    expect(harness.posts()[0]!.url).toBe(CHANNEL_BASE);
    // A resolver is a pure translation: no match must not silently downgrade
    // the protocol the Pod chose.
    expect(harness.sockets[0]!.url).toBe('wss://pod.example/.notifications/WebSocketChannel2023/channel-1');

    release();
    await settle();
  });
});
