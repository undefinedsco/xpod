import type { Collection, SyncConfig } from '@tanstack/db';
import type { AnyPodTable, SolidDatabase } from '@undefineds.co/drizzle-solid';
import type { PodModelDescriptor } from '@undefineds.co/models';
import { conditionalDocumentRead } from './read.js';
import { mapSubjectRows, projectionFieldOrder, writeOnlyFields } from './mapping.js';
import { computeDocumentDiff, projectionHash, stripVirtualProps } from './diff.js';
import { subscribeDocumentFeed } from './feed.js';
import type { PodFeedSubscription } from './feed.js';
import { reconcilePendingWrites } from './mutations.js';
import type { PodPendingWrites } from './mutations.js';
import { PodCollectionError } from './types.js';
import type { PodDocumentFeed, PodSyncState, RowOf } from './types.js';

/**
 * TanStack sync 实现（§3）。
 *
 * 时序不可换（§3.1）：
 *
 * ```
 * feed.watch(document) ──► 首次整表读（一次 drizzle-solid select）
 *        │                        │
 *        │  读期间到达的脏信号 → 缓冲
 *        ▼                        ▼
 *   投递脏信号 ◄──────────── markReady()
 *        │
 *        ▼
 *   合并窗口（75ms）──► 重读 ──► diff ──► begin/write/commit 增量
 * ```
 *
 * 与 §3.2 伪代码的三处**实测修正**（@tanstack/db@0.9.0）：
 *
 * 1. `metadata.row.set()` 必须在事务**打开期间**调用：
 *    `dist/esm/collection/sync.js:272-280` 的 `getActivePendingSyncTransaction()` 在
 *    没有未提交事务时抛 `NoPendingSyncTransactionWriteError`，所以伪代码里 `commit()`
 *    之后再 `set` 会直接抛错。这里改成 `write → metadata.row.set → commit`。
 * 2. `commit()` 返回 `true | Promise<void>`（同步可见性收据），必须 `await`：
 *    存在 persisting 的用户事务时，普通 sync 事务会被排队
 *    （`dist/esm/collection/state.js:593` 的 `!hasPersistingTransaction || …`），
 *    等待收据就会一直挂住。因此本实现统一用 `begin({ immediate: true })`
 *    —— 这正是库为「需要立刻写入 syncedData 的写操作」提供的开关。
 * 3. `metadata.collection` 的 ETag 无法获得（见 `read.ts` 的结论），
 *    所以每个脏信号都是「读 + 投影 diff」，未变的行 0 次 `write()`（§8.7-2 的出口）。
 */

/** 变更合并窗口，沿用现网 `TABLE_CHANGE_COALESCE_MS`（§3.2）。 */
export const DEFAULT_COALESCE_MS = 75;
/** §4.2：确认未满足时再等一个合并窗口重试，默认 2 次后抛错。 */
export const DEFAULT_CONFIRM_RETRIES = 2;

type SyncParams<R extends object> = Parameters<SyncConfig<R, string>['sync']>[0];

export interface PodSyncOptions<D extends PodModelDescriptor> {
  descriptor: D;
  table: AnyPodTable;
  database: SolidDatabase;
  podUrl: string;
  document: string;
  feed?: PodDocumentFeed;
  coalesceMs?: number;
  confirmRetries?: number;
  pending: PodPendingWrites<RowOf<D>>;
  /** 创建后回填的集合引用（`refresh()` 在 sync 启动前被调用时用它拉起 preload）。 */
  collection: () => Collection<RowOf<D>, string> | undefined;
}

export interface PodSyncEngine<R extends object> {
  /** 交给 `createCollection({ sync: { sync } })` 的函数。 */
  sync: SyncConfig<R, string>['sync'];
  /** 显式重读（`PodCollection.refresh()`）。 */
  refresh(): Promise<void>;
  /** §4.2 的确认协议：写后立刻重读，未满足则等一个合并窗口重试。 */
  confirmPending(key: string): Promise<void>;
  state(): PodSyncState;
  /** 释放订阅与定时器（页面卸载/登出；宿主 capability 的 `dispose()`）。 */
  dispose(): void;
  /** @internal 测试钩子：调用库的 `truncate()`（清空 syncedData 与 row metadata）。 */
  truncate(): void;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export function createPodSync<D extends PodModelDescriptor>(
  options: PodSyncOptions<D>,
): PodSyncEngine<RowOf<D>> {
  const { descriptor, table, database, document, podUrl, pending } = options;
  const coalesceMs = options.coalesceMs ?? DEFAULT_COALESCE_MS;
  const confirmRetries = options.confirmRetries ?? DEFAULT_CONFIRM_RETRIES;
  const fieldOrder = projectionFieldOrder(descriptor);
  // `secret: true` 的字段读不回来，确认协议要按这条规则把它们排除在比对之外（§4.2、§9-7）。
  const writeOnly = writeOnlyFields(descriptor);
  const hashOf = (row: RowOf<D>): string => projectionHash(row, fieldOrder);

  let params: SyncParams<RowOf<D>> | undefined;
  let subscription: PodFeedSubscription | undefined;
  let feedAvailable = false;
  let ready = false;
  let failureReported = false;
  let syncState: PodSyncState = 'initializing';
  let timer: ReturnType<typeof setTimeout> | undefined;
  let bufferedSignals: Array<{ topic: string }> = [];
  let running: Promise<void> | undefined;
  let rerunRequested = false;
  let disposed = false;
  let lastEtag: string | undefined;

  async function ensureParams(): Promise<SyncParams<RowOf<D>>> {
    if (params) return params;
    const collection = options.collection();
    if (!collection) {
      throw new PodCollectionError('sync_not_started', 'collection has not started syncing yet');
    }
    await collection.preload();
    if (!params) {
      throw new PodCollectionError('sync_not_started', 'collection sync did not start');
    }
    return params;
  }

  function schedulePass(): void {
    if (disposed || timer !== undefined) return;
    timer = setTimeout(() => {
      timer = undefined;
      void runPass().catch(() => {
        // 脏信号驱动的读失败：保持现有行，状态标降级（§3.4），等下一次信号或显式 refresh()。
        syncState = 'degraded';
      });
    }, coalesceMs);
  }

  /**
   * 串行化的「读 + diff + 写」：正在跑的一轮会吸收新请求（合并成一轮重跑），
   * 空闲时立刻开一轮。sync 事务一律用 `immediate` 开始（见文件头修正 2）。
   *
   * `running` 必须在**本轮循环结束时同步清掉**（内层 `finally`），不能挂在返回
   * promise 的 `.finally()` 上：后者要等一个额外的微任务，那段时间里 `running`
   * 仍是已完成的旧 promise，调用方会拿到「什么都没做」的旧 promise
   * （实测：首读失败后紧接着 refresh() 不会产生新读）。
   */
  function runPass(): Promise<void> {
    if (running) {
      rerunRequested = true;
      return running;
    }
    const task = (async () => {
      try {
        do {
          rerunRequested = false;
          await passOnce();
        } while (rerunRequested && !disposed);
      } finally {
        running = undefined;
      }
    })();
    running = task;
    return task;
  }

  async function passOnce(): Promise<void> {
    const sync = await ensureParams();
    if (disposed) return;

    let read;
    try {
      read = await conditionalDocumentRead(
        { descriptor, table, database, document, podUrl },
        { ifNoneMatch: lastEtag },
      );
    } catch (error) {
      // 读失败 → 不动集合，只标降级（§3.4）；首读失败必须给库一个结论，否则 live query 永不
      // resolve，所以报一次 markError。之后成功的读会把它带回 ready（库允许 error → ready），
      // 因此这里**不**把 `ready` 置真。
      syncState = 'degraded';
      if (!ready && !failureReported) {
        failureReported = true;
        sync.markError(error);
      }
      return;
    }
    if (read.etag !== undefined) lastEtag = read.etag;

    const rows = mapSubjectRows(descriptor, table, read.subjects);
    const next = new Map<string, RowOf<D>>(rows.map((row) => [String(row.id), row]));
    const presentKeys = [...sync.collection.keys()].map((key) => String(key));
    const knownHash = (key: string): string | undefined => {
      const entry = sync.metadata?.row.get(key) as { hash?: string } | undefined;
      return entry?.hash;
    };
    const diff = computeDocumentDiff<RowOf<D>>({
      next,
      presentKeys,
      pendingKeys: pending.keys,
      knownHash,
      hashOf,
      presentRow: (key) => sync.collection.get(key) as RowOf<D> | undefined,
    });

    if (diff.inserts.length + diff.updates.length + diff.deletes.length > 0) {
      // immediate：库在存在 persisting 用户事务时会把普通 sync 事务排队，
      // 那会让 §4.4 的自回声与 §4.2 的确认永远等不到应用（见文件头修正 2）。
      sync.begin({ immediate: true });
      for (const entry of diff.inserts) {
        sync.write({ type: 'insert', value: stripVirtualProps(entry.row) });
      }
      for (const entry of diff.updates) {
        // `rowUpdateMode: 'full'`：整行替换，键由库用 `getKey(value)` 取（行里有 id）。
        sync.write({ type: 'update', value: stripVirtualProps(entry.row) });
      }
      for (const entry of diff.deletes) {
        // §3.2 要求 delete 带上前一行；0.9.0 的 `ChangeMessageOrDeleteKeyMessage` 联合类型
        // 不允许 delete 携带 value（运行时允许且不使用），因此在这里做一次局部放宽。
        (sync.write as (message: unknown) => void)({
          type: 'delete',
          key: entry.key,
          value: stripVirtualProps(entry.row),
        });
      }
      for (const entry of [...diff.inserts, ...diff.updates]) {
        // 投影哈希写进 row metadata（delete 的 row metadata 由库自动删除，§3.2）。
        sync.metadata?.row.set(entry.key, { hash: hashOf(entry.row) });
      }
      await sync.commit();
    }

    if (!ready) {
      ready = true;
      failureReported = false;
      sync.markReady();
    }
    reconcilePendingWrites(pending, next, hashOf, writeOnly);
    syncState = feedAvailable ? 'live' : 'unavailable';
  }

  async function confirmPending(key: string): Promise<void> {
    const entry = pending.entries.get(key);
    if (!entry) return;
    for (let attempt = 0; ; attempt += 1) {
      await runPass();
      if (entry.settled) {
        if (entry.error) throw entry.error;
        return;
      }
      if (attempt >= confirmRetries) {
        throw new PodCollectionError(
          'write_unconfirmed',
          `write to ${key} was not visible in the document after ${confirmRetries + 1} reads`,
        );
      }
      await sleep(coalesceMs);
    }
  }

  const sync: SyncConfig<RowOf<D>, string>['sync'] = (syncParams) => {
    if (disposed) return () => {};
    params = syncParams;
    subscription = subscribeDocumentFeed(options.feed, document, () => {
      if (!ready) {
        bufferedSignals.push({ topic: document });
        return;
      }
      schedulePass();
    });
    feedAvailable = subscription.available;

    void runPass()
      .then(() => {
        if (disposed) return;
        // 状态由 passOnce 写（成功 = live/unavailable，失败 = degraded），这里只重放缓冲信号。
        const replay = bufferedSignals;
        bufferedSignals = [];
        if (replay.length > 0) schedulePass();
      })
      .catch(() => {
        syncState = 'degraded';
      });

    return () => {
      dispose();
    };
  };

  function dispose(): void {
    if (disposed) return;
    disposed = true;
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
    subscription?.unsubscribe();
    subscription = undefined;
    bufferedSignals = [];
  }

  return {
    sync,
    refresh: () => runPass(),
    confirmPending,
    state: () => syncState,
    dispose,
    truncate: () => {
      if (!params || disposed) return;
      params.begin({ immediate: true });
      params.truncate();
      void Promise.resolve(params.commit()).catch(() => {});
    },
  };
}
