import type {
  Finalizable,
  KeyValueStorage,
  NotificationChannel,
  NotificationChannelStorage,
  WebSocketMap,
} from '@solid/community-server';
import { Initializer, setSafeInterval } from '@solid/community-server';
import { getLoggerFor } from 'global-logger-factory';

/** 默认清扫间隔（分钟）。同时是“新建但尚未连上 socket”的通道的宽限期。 */
export const NOTIFICATION_CHANNEL_SWEEP_INTERVAL_MINUTES = 5;

function isNotificationChannel(value: unknown): value is NotificationChannel {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const candidate = value as { id?: unknown; topic?: unknown };
  return typeof candidate.id === 'string' && typeof candidate.topic === 'string';
}

/**
 * 回收没有活动 socket 的通知通道。
 *
 * 背景：CSS 的 `WebSocket2023Storer` 只在 socket 关闭时把它从内存 map 中移除，通道记录留在
 * `SubscriptionStorage` 里直到 `endAt` 过期（默认 2 周）；客户端 DELETE 失败、页面崩溃、
 * 进程被强杀等情况都会留下再也无人使用、也无人回收的通道。`ReclaimingWebSocket2023Storer`
 * 覆盖了正常关闭的路径，本组件负责其余部分：
 *
 * 1. 启动时清扫一次：进程刚起来，内存 map 必然为空，任何持久化的通道都不可能还有活动 socket；
 * 2. 之后每 {@link NOTIFICATION_CHANNEL_SWEEP_INTERVAL_MINUTES} 分钟清扫一次：无 socket 的通道
 *    需要连续两次被判定为孤儿才删除，避免误删“刚 POST 出来、socket 还在握手”的通道。
 *
 * 只回收本实例 `baseUrl` 下的通道：通道 id 由本实例的订阅路由生成，Cloud 集群中共享
 * `internal_kv` 的其他节点（若存在）的通道由各自实例负责，这里不做跨实例删除。
 * 与 socket 归属相关的限制（同一个 baseUrl 被多个 CSS 进程共享时无法判断通道是否在别的进程里存活）
 * 见 `docs/COMPONENTS.md`。
 */
export class NotificationChannelSweeper extends Initializer implements Finalizable {
  protected readonly logger = getLoggerFor(this);
  private readonly channelStorage: NotificationChannelStorage;
  private readonly channelIndex: KeyValueStorage<string, unknown>;
  private readonly socketMap: WebSocketMap;
  private readonly baseUrl: string;
  private readonly intervalMs: number;
  /** 见过一次、但当时没有活动 socket 的通道 id；下一次仍是孤儿才回收。 */
  private readonly awaitingSecondLook = new Set<string>();
  private timer?: NodeJS.Timeout;
  private sweeping = false;

  public constructor(
    storage: NotificationChannelStorage,
    channelIndex: KeyValueStorage<string, unknown>,
    socketMap: WebSocketMap,
    baseUrl: string,
    intervalMinutes: number = NOTIFICATION_CHANNEL_SWEEP_INTERVAL_MINUTES,
  ) {
    super();
    this.channelStorage = storage;
    this.channelIndex = channelIndex;
    this.socketMap = socketMap;
    // 通道 id 是 `<baseUrl>/.notifications/...`；补上结尾斜杠，避免 `https://pod.example`
    // 匹配到 `https://pod.example.evil/...`。
    this.baseUrl = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;
    this.intervalMs = intervalMinutes * 60 * 1000;
  }

  /**
   * CSS 启动序列的一部分（在 HTTP server 开始监听之前执行）：先做一次启动清扫，再挂上有界的周期任务。
   *
   * 实测同一次 CSS 启动里本方法会被调用两次（配置图里只出现一次）。这里做成幂等：重复调用既不重复清扫，
   * 也不重复注册定时器——两个定时器会让“连续两次判定”退化成相隔几百毫秒的两次判定，等于没有宽限期。
   */
  public override async handle(): Promise<void> {
    if (this.timer) {
      this.logger.debug('Notification channel sweep is already scheduled; ignoring duplicate initializer call');
      return;
    }
    await this.sweep(true);
    this.timer = setSafeInterval(
      this.logger,
      'Failed to reclaim orphaned notification channels',
      async() => {
        await this.sweep(false);
      },
      this.intervalMs,
    );
    // 不阻止进程退出：清扫只是运维兜底，不是常驻工作。
    this.timer.unref();
    this.logger.info(`Notification channel sweep scheduled every ${this.intervalMs / 60_000} minute(s)`);
  }

  public async finalize(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  /**
   * 执行一次清扫，返回被回收的通道数量。
   *
   * @param initial - 启动清扫：内存中还没有任何 socket，因此无 socket 的通道一律视为孤儿。
   */
  public async sweep(initial = false): Promise<number> {
    if (this.sweeping) {
      return 0;
    }
    this.sweeping = true;
    try {
      const channels = await this.listOwnedChannels();
      const reclaimed: string[] = [];
      for (const channel of channels.values()) {
        if (this.socketMap.has(channel.id)) {
          this.awaitingSecondLook.delete(channel.id);
          continue;
        }
        if (!initial && !this.awaitingSecondLook.has(channel.id)) {
          this.awaitingSecondLook.add(channel.id);
          continue;
        }
        if (await this.channelStorage.delete(channel.id)) {
          reclaimed.push(channel.id);
        }
        this.awaitingSecondLook.delete(channel.id);
      }
      // 已经被其他路径删除的通道不必再留在这里。
      for (const id of [...this.awaitingSecondLook]) {
        if (!channels.has(id)) {
          this.awaitingSecondLook.delete(id);
        }
      }
      if (reclaimed.length > 0) {
        this.logger.info(`Reclaimed ${reclaimed.length} notification channel(s) without a live WebSocket`);
        this.logger.debug(`Reclaimed notification channels: ${reclaimed.join(', ')}`);
      } else {
        this.logger.debug(`Notification channel sweep found no orphan among ${channels.size} channel(s)`);
      }
      return reclaimed.length;
    } finally {
      this.sweeping = false;
    }
  }

  /** 枚举本实例 baseUrl 下的通道记录。topic 索引行（值是 id 数组）不是通道，跳过。 */
  private async listOwnedChannels(): Promise<Map<string, NotificationChannel>> {
    const channels = new Map<string, NotificationChannel>();
    for await (const [, value] of this.channelIndex.entries()) {
      if (!isNotificationChannel(value) || !value.id.startsWith(this.baseUrl)) {
        continue;
      }
      channels.set(value.id, value);
    }
    return channels;
  }
}
