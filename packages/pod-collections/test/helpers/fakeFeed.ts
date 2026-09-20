import type { PodDocumentFeed } from '../../src/types.js';

/**
 * 可手动投递脏信号的假 feed（doc §8.2）：只有 `watch` 一个方法，与
 * `SolidNotificationsCapability` 结构一致；不实现任何传输。
 */
export interface FakeFeed extends PodDocumentFeed {
  emit(topic?: string): void;
  readonly watched: string[];
  readonly activeWatchers: number;
  /** watch 抛错：模拟传输不可用。 */
  failWatch(error: Error): void;
}

export interface FakeFeedOptions {
  log?: string[];
}

export function createFakeFeed(options: FakeFeedOptions = {}): FakeFeed {
  const listeners = new Set<(signal: { topic: string }) => void>();
  const watched: string[] = [];
  let watchError: Error | undefined;

  return {
    watch(topicUrl, listener) {
      if (watchError) throw watchError;
      options.log?.push(`watch:${topicUrl}`);
      watched.push(topicUrl);
      listeners.add(listener);
      let active = true;
      return () => {
        if (!active) return;
        active = false;
        listeners.delete(listener);
      };
    },
    emit(topic) {
      options.log?.push(`signal:${topic ?? ''}`);
      for (const listener of [...listeners]) {
        listener({ topic: topic ?? watched[0] ?? '' });
      }
    },
    get watched() {
      return watched;
    },
    get activeWatchers() {
      return listeners.size;
    },
    failWatch(error) {
      watchError = error;
    },
  };
}
