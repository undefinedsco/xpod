/**
 * Subscribing to a Pod resource's changes through the Solid notification protocol.
 *
 * This is the client half of `WebSocketChannel2023`: create a channel for one topic, connect
 * to the URL it answers with, and read the notifications it pushes. The topic has to be the
 * resource that actually changes — CSS only reports a parent container when a resource is
 * *created* (`DataAccessorBasedStore.writeData` guards that with `!exists`), so a container
 * subscription never sees a document being updated.
 *
 * What this module deliberately does not do: decide which topics are worth watching, or what
 * to do with a change. Callers own that, and the socket factory is injected so the reconnect
 * and parse behaviour is testable without a network.
 *
 * A notification body is
 * `{ type: Create|Update|Delete|Add|Remove, object: <changed resource>, target: <topic>,
 *    state: <etag>, published: <timestamp> }`.
 */

/** The fields of a notification this deployment acts on. */
export interface SolidChangeNotification {
  /** The resource that changed. */
  object?: string;
  /** The topic the notification was delivered for. */
  target?: string;
  type?: string;
  state?: string;
  published?: string;
}

/** The socket surface needed here, so a test can supply a plain object. */
export interface NotificationSocket {
  send(data: string): void;
  close(): void;
  addEventListener(event: 'message', listener: (event: { data: unknown }) => void): void;
  addEventListener(event: 'close' | 'error', listener: () => void): void;
}

export interface SolidNotificationSubscriptionOptions {
  /** The channel endpoint, e.g. `https://pod.example/.notifications/WebSocketChannel2023/`. */
  endpoint: string;
  /** The resource IRI to watch. Must be the resource that changes, not a container. */
  topic: string;
  fetch: typeof fetch;
  /** Opens the socket for the URL the channel answers with. */
  openSocket: (url: string) => NotificationSocket;
  /** Called for every notification that carries a changed resource. */
  onChange: (notification: SolidChangeNotification) => void;
  /** Reported when the channel could not be created, or the socket failed. */
  onError?: (error: Error) => void;
  /**
   * Reported every time a channel is established — including after a reconnect. A caller that
   * decides whether it can account for every change needs to know when it is watching again.
   */
  onReady?: () => void;
  /**
   * Reported when a socket goes away, before the reconnect. A clean close is not an error, but
   * changes during the gap are missed, so a caller that trusts this signal has to stop.
   */
  onDisconnect?: () => void;
  /** How long to wait before re-subscribing after a drop. Defaults to 1s, doubling to 30s. */
  initialRetryDelayMs?: number;
  maxRetryDelayMs?: number;
  /** Injectable so tests do not wait. */
  sleep?: (ms: number) => Promise<void>;
  /** Extra fields for the channel request, e.g. a rate limit. */
  channel?: Record<string, unknown>;
}

export const WEB_SOCKET_CHANNEL_2023 = 'http://www.w3.org/ns/solid/notifications#WebSocketChannel2023';

/**
 * One topic's subscription, kept alive across socket drops.
 *
 * `start()` resolves once the channel is created and the socket is connected; the
 * subscription then runs in the background until `stop()`. A drop is retried with backoff
 * rather than silently giving up: a signal that quietly stopped is worse than no signal,
 * because callers would trust it.
 */
export class SolidNotificationSubscription {
  private readonly options: SolidNotificationSubscriptionOptions;
  private socket?: NotificationSocket;
  private stopped = true;
  private running?: Promise<void>;
  private channelId?: string;
  private retryDelayMs: number;

  public constructor(options: SolidNotificationSubscriptionOptions) {
    this.options = options;
    this.retryDelayMs = options.initialRetryDelayMs ?? 1_000;
  }

  /** The channel this subscription created, once it has one. */
  public get id(): string | undefined {
    return this.channelId;
  }

  /** Create the channel and connect. Rejects when the channel cannot be created at all. */
  public async start(): Promise<void> {
    if (!this.stopped) return;
    this.stopped = false;
    const receiveFrom = await this.createChannel();
    this.connect(receiveFrom);
  }

  /** Stop watching. Idempotent. */
  public stop(): void {
    this.stopped = true;
    this.socket?.close();
    this.socket = undefined;
  }

  /** Ask the channel endpoint for a WebSocket URL for this topic. */
  private async createChannel(): Promise<string> {
    const response = await this.options.fetch(this.options.endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/ld+json', accept: 'application/ld+json' },
      body: JSON.stringify({
        '@context': [ 'https://www.w3.org/ns/solid/notification/v1' ],
        type: WEB_SOCKET_CHANNEL_2023,
        topic: this.options.topic,
        ...(this.options.channel ?? {}),
      }),
    });
    if (!response.ok) {
      throw new Error(`Could not subscribe to ${this.options.topic}: the channel endpoint answered ${response.status}`);
    }
    const body = await response.json() as Record<string, unknown>;
    const receiveFrom = body.receiveFrom;
    if (typeof receiveFrom !== 'string' || receiveFrom.length === 0) {
      throw new Error(`Could not subscribe to ${this.options.topic}: the channel has no receiveFrom URL`);
    }
    if (typeof body.id === 'string') this.channelId = body.id;
    this.options.onReady?.();
    return receiveFrom;
  }

  /** Connect, and keep reconnecting until stopped. */
  private connect(receiveFrom: string): void {
    this.running = this.run(receiveFrom);
  }

  private async run(receiveFrom: string): Promise<void> {
    while (!this.stopped) {
      try {
        await this.listen(receiveFrom);
      } catch (error) {
        this.options.onError?.(error instanceof Error ? error : new Error(String(error)));
      }
      if (this.stopped) return;
      this.options.onDisconnect?.();
      // A dropped socket means the channel may be gone (it is reclaimed when its last socket
      // closes), so the next attempt creates a fresh channel rather than reusing this URL.
      await (this.options.sleep ?? defaultSleep)(this.retryDelayMs);
      this.retryDelayMs = Math.min(this.retryDelayMs * 2, this.options.maxRetryDelayMs ?? 30_000);
      if (this.stopped) return;
      try {
        receiveFrom = await this.createChannel();
      } catch (error) {
        this.options.onError?.(error instanceof Error ? error : new Error(String(error)));
        continue;
      }
    }
  }

  /** One socket's lifetime: resolve when it closes or errors. */
  private async listen(receiveFrom: string): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      let socket: NotificationSocket;
      try {
        socket = this.options.openSocket(receiveFrom);
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)));
        return;
      }
      this.socket = socket;
      socket.addEventListener('message', event => {
        const notification = parseNotification(event.data);
        if (notification) this.options.onChange(notification);
      });
      socket.addEventListener('close', () => resolve());
      socket.addEventListener('error', () => reject(new Error(`The notification socket for ${this.options.topic} failed`)));
    });
  }
}

/** Read a notification body, ignoring anything that is not one. */
export function parseNotification(data: unknown): SolidChangeNotification | undefined {
  const text = typeof data === 'string'
    ? data
    : data instanceof Uint8Array
      ? Buffer.from(data).toString('utf8')
      : undefined;
  if (text === undefined) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined;
  const record = parsed as Record<string, unknown>;
  const notification: SolidChangeNotification = {};
  for (const field of [ 'object', 'target', 'type', 'state', 'published' ] as const) {
    if (typeof record[field] === 'string') notification[field] = record[field];
  }
  // A body with no changed resource tells us nothing we can act on.
  return notification.object === undefined && notification.target === undefined ? undefined : notification;
}

async function defaultSleep(ms: number): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, ms));
}
