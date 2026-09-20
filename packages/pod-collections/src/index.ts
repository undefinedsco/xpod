import { createCollection } from '@tanstack/db';
import type { Collection } from '@tanstack/db';
import type { PodModelDescriptor } from '@undefineds.co/models';
import { resolveTableDocument } from './layout.js';
import { assertDescriptorTableAlignment } from './mapping.js';
import { createMutationHandlers, createPendingWrites } from './mutations.js';
import { createPodSync } from './sync.js';
import type { PodSyncEngine } from './sync.js';
import type {
  PodCollection,
  PodCollectionOptions,
  PodDocumentFeed,
  PodRowConflict,
  PodSyncState,
  RowOf,
} from './types.js';
import { PodCollectionError } from './types.js';

export type {
  PodCollection,
  PodCollectionOptions,
  PodDocumentFeed,
  PodRowConflict,
  PodSyncState,
  PodSubjectRow,
  PodFieldValue,
  RowOf,
} from './types.js';
export type { PodLayoutInput, PodLayoutScope } from './layout.js';
export type { PodRdfTerm } from './mapping.js';
export { PodCollectionError } from './types.js';
export type { PodFieldBinding } from './mapping.js';
export { DEFAULT_COALESCE_MS, DEFAULT_CONFIRM_RETRIES } from './sync.js';

/**
 * 声明一个 Pod 表集合（§2）。
 *
 * 表是一个**文档**，行是文档里的**主语**：schema 全部来自 models 的 descriptor
 * （`storage.base` / `resourceIdPattern` / `fields` / `class`），消费方不手写 topic、
 * 不手写字段映射、不手写 refetch。集合定义本身就是「开启订阅」的声明（D3），
 * 所以这里 `startSync: true`：配置了 feed 就是活表，没有 feed 就退化为
 * 「读一次 + 显式 `refresh()`」，永不轮询（N1）。
 */
export function definePodCollection<D extends PodModelDescriptor>(
  descriptor: D,
  options: PodCollectionOptions<D>,
): PodCollection<RowOf<D>> {
  assertDescriptorTableAlignment(descriptor, options.table);
  const document = resolveTableDocument(descriptor, {
    podUrl: options.podUrl,
    document: options.document,
    scope: options.scope,
  });

  const pending = createPendingWrites<RowOf<D>>(options.onConflict);
  let collection: Collection<RowOf<D>, string> | undefined;
  const engine: PodSyncEngine<RowOf<D>> = createPodSync<D>({
    descriptor,
    table: options.table,
    database: options.database,
    podUrl: options.podUrl,
    document,
    feed: options.feed as PodDocumentFeed | undefined,
    coalesceMs: options.coalesceMs,
    confirmRetries: options.confirmRetries,
    pending,
    collection: () => collection,
  });

  const handlers = createMutationHandlers<D>({
    descriptor,
    table: options.table,
    database: options.database,
    podUrl: options.podUrl,
    document,
    pending,
    confirm: (key) => engine.confirmPending(key),
  });

  const created = createCollection<RowOf<D>, string>({
    // 集合 id 由 descriptor 与文档决定：一个表一个文档就是一个集合。
    id: `pod-collection:${descriptor.uri}:${document}`,
    // §2.7：键取行标识（`resourceIdPattern` 的键 slot），不取 `uniqueBy` ——
    // 后者是语义唯一键，与存储布局的键 slot 不保证同形（`aiModelDescriptor`：
    // `uniqueBy: ['id']` 但键 slot 是 `key`）。
    getKey: (row) => row.id,
    // §3.2：diff 的产物是整行投影，`partial` 表达不了「谓词被移除」。
    sync: { sync: engine.sync, rowUpdateMode: 'full' },
    startSync: true,
    onInsert: handlers.onInsert,
    onUpdate: handlers.onUpdate,
    onDelete: handlers.onDelete,
  });
  collection = created as unknown as Collection<RowOf<D>, string>;

  return Object.assign(created, {
    tableDocument: document,
    pendingKeys: pending.keys,
    conflicts: pending.conflicts,
    refresh: (): Promise<void> => engine.refresh(),
    /**
     * @internal 同步状态（§1.5 N1 的 `unavailable` / §3.4 的降级）。
     * 不进 `PodCollection` 接口：宿主能力的接线在下一期（§6.4）。
     */
    syncState: (): PodSyncState => engine.state(),
    /** @internal 释放订阅与定时器（宿主 capability 的 `dispose()`，§6.4-6）。 */
    dispose: (): void => engine.dispose(),
    /** @internal 测试钩子：库的 `truncate()`。 */
    truncateForTest: (): void => engine.truncate(),
  }) as PodCollection<RowOf<D>>;
}

/** 行键冲突类型再导出，便于 applet 写 `onConflict` 回调签名。 */
export type PodConflict<R extends object> = PodRowConflict<R>;

export { conditionalDocumentRead, sessionFetchOf } from './read.js';
export { resolveTableDocument, rowKeyOf, subjectIriForRow, resourceIdForRow } from './layout.js';
export {
  coerceFieldValue,
  descriptorFieldsWithoutColumn,
  fieldBindings,
  mapSubjectRows,
  projectionFieldOrder,
  tableColumnsWithoutDescriptorField,
  valueToTerm,
  writeOnlyFields,
} from './mapping.js';
export { computeDocumentDiff, projectionHash, stripVirtualProps } from './diff.js';

/**
 * 内部观测面（不在 `PodCollection` 接口里）：宿主能力用它读取同步状态，
 * 测试用它驱动库的 `truncate()`。类型上显式标注，避免 applet 依赖。
 */
export interface PodCollectionInternals {
  syncState(): PodSyncState;
  dispose(): void;
  /** @internal 仅测试：调用库的 `truncate()`（清空 syncedData 与 row metadata）。 */
  truncateForTest(): void;
}

export function podCollectionInternals<R extends { id: string }>(
  collection: PodCollection<R>,
): PodCollectionInternals {
  const internals = collection as unknown as Partial<PodCollectionInternals>;
  if (typeof internals.syncState !== 'function' || typeof internals.dispose !== 'function') {
    throw new PodCollectionError(
      'collection_not_from_define',
      'collection was not created by definePodCollection()',
    );
  }
  return internals as PodCollectionInternals;
}
