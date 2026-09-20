import type { PodDocumentFeed } from './types.js';

/**
 * 变更 feed 端口与无 feed 时的降级（§2.2、§1.5 N1）。
 *
 * 传输层不在本包：`PodDocumentFeed` 只是宿主注入的**脏信号**端口，结构上由
 * `SolidNotificationsCapability` 满足。没有 feed 时**不装任何轮询**：只读一次，
 * 之后只能显式 `refresh()`，同步状态显式为 `unavailable`。
 */

export interface PodFeedSubscription {
  /** feed 是否真的建立（无 feed / watch 抛错时为 false）。 */
  readonly available: boolean;
  unsubscribe(): void;
}

const NOOP_SUBSCRIPTION: PodFeedSubscription = {
  available: false,
  unsubscribe: () => {},
};

/** 订阅文档脏信号；无 feed 或订阅失败时返回不可用订阅，调用方据此标注状态。 */
export function subscribeDocumentFeed(
  feed: PodDocumentFeed | undefined,
  topicUrl: string,
  listener: (signal: { topic: string }) => void,
): PodFeedSubscription {
  if (!feed || typeof feed.watch !== 'function') return NOOP_SUBSCRIPTION;
  try {
    const unsubscribe = feed.watch(topicUrl, listener);
    if (typeof unsubscribe !== 'function') return NOOP_SUBSCRIPTION;
    let active = true;
    return {
      available: true,
      unsubscribe: () => {
        if (!active) return;
        active = false;
        unsubscribe();
      },
    };
  } catch {
    return NOOP_SUBSCRIPTION;
  }
}
