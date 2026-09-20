import type {
  NotificationChannelStorage,
  WebSocket2023HandlerInput,
  WebSocketMap,
} from '@solid/community-server';
import { WebSocket2023Storer, createErrorMessage } from '@solid/community-server';

/**
 * WebSocket2023Storer 的等位替换：保留 CSS 原有行为（把 socket 存进 map、socket 关闭时从 map 移除、
 * 定期关掉已过期通道的 socket），并补上缺失的一环——最后一个 socket 关闭或出错时回收通道记录。
 *
 * CSS 默认实现只在 `close`/`error` 时调用 `socketMap.deleteEntry(...)`，通道记录会一直留在
 * `SubscriptionStorage` 里直到 `endAt` 过期（`NotificationSubscriber` 默认把它压到 2 周后），
 * 因此每次页面刷新、HMR、崩溃都会留下一个再也不会被使用的通道。
 *
 * 只有当该通道名下的 socket 全部消失时才删除：同一个通道允许多个 socket（例如两个标签页共用一次订阅），
 * 只要还有 socket 存活就必须保留通道，否则会静默掐断仍在监听的客户端。
 */
export class ReclaimingWebSocket2023Storer extends WebSocket2023Storer {
  private readonly channelStorage: NotificationChannelStorage;
  private readonly liveSockets: WebSocketMap;
  /**
   * 一次 socket 终止可能先 `error` 再 `close`，这里保证同一个通道只回收一次。
   * 通道 id 由 `randomUUID()` 生成且永不复用，因此不需要清理已回收的 id。
   */
  private readonly reclaiming = new Set<string>();

  public constructor(
    storage: NotificationChannelStorage,
    socketMap: WebSocketMap,
    cleanupTimer?: number,
  ) {
    super(storage, socketMap, cleanupTimer);
    this.channelStorage = storage;
    this.liveSockets = socketMap;
  }

  public override async handle(input: WebSocket2023HandlerInput): Promise<void> {
    await super.handle(input);
    const { channel, webSocket } = input;
    // 基类的监听器先注册，所以这里运行时 map 已经反映了本次关闭后的真实状态。
    // socket 事件回调不能把 rejection 抛回事件循环：删除失败只记日志，交给清扫器和 endAt 兜底。
    const reclaim = (): void => {
      this.reclaim(channel.id).catch((error: unknown) => {
        this.logger.error(`Failed to reclaim notification channel ${channel.id}: ${createErrorMessage(error)}`);
      });
    };
    webSocket.on('close', reclaim);
    webSocket.on('error', reclaim);
  }

  private async reclaim(id: string): Promise<void> {
    if (this.liveSockets.has(id) || this.reclaiming.has(id)) {
      return;
    }
    this.reclaiming.add(id);
    try {
      if (await this.channelStorage.delete(id)) {
        this.logger.info(`Reclaimed notification channel ${id}: its last WebSocket closed`);
      }
    } finally {
      this.reclaiming.delete(id);
    }
  }
}
