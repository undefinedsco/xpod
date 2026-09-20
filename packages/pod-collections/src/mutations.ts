import type { AnyPodTable, SolidDatabase } from '@undefineds.co/drizzle-solid';
import type { PodModelDescriptor } from '@undefineds.co/models';
import type { InsertMutationFn, UpdateMutationFn, DeleteMutationFn } from '@tanstack/db';
import type { PodRowConflict, RowOf } from './types.js';
import { PodCollectionError } from './types.js';
import {
  descriptorRowToColumnValues,
  fieldBindings,
  isUriArrayField,
  projectionFieldOrder,
} from './mapping.js';
import { documentOfIri, resourceIdForRow, subjectIriForRow } from './layout.js';
import { sessionFetchOf } from './read.js';
import { projectionCovers, projectionHash } from './diff.js';

/**
 * mutation → drizzle-solid 映射（§4.1）+ 乐观时长协议（§4.2）。
 *
 * | handler     | 落盘                                              |
 * |-------------|---------------------------------------------------|
 * | `onInsert`  | `database.insert(table).values(row).execute()`     |
 * | `onUpdate`  | `database.updateById(table, resourceId, changes)`  |
 * | `onDelete`  | `database.deleteById(table, resourceId)`           |
 * | `array:true` + `type:'uri'` 字段 | 一次认证过的 SPARQL PATCH（`writeField()`）|
 *
 * PATCH 是这类字段**这次写的全部**，不是 ORM 写之后的修补：drizzle-solid 0.3.24 的
 * 更新构建器把数组当标量，先删掉该谓词全部三元组再写一个字面量，两条语句都发会留下
 * 清不掉的脏字面量（`docs/drizzle-solid-link-array-update-todo.md` 的复现与根因）。
 */

interface Deferred {
  promise: Promise<void>;
  resolve: () => void;
}

function createDeferred(): Deferred {
  let resolve!: () => void;
  const promise = new Promise<void>((settle) => {
    resolve = () => settle();
  });
  return { promise, resolve };
}

/**
 * 未确认的本地写。`sync` 每轮读回文档后调用 `reconcilePendingWrites()`：
 * 读回意图 → 确认；读回第三方值 → 冲突（server wins + 标记）；仍未见意图 → 继续等。
 */
export interface PodPendingWrite<R extends object> {
  key: string;
  /** 写入意图；删除时为 `undefined`。 */
  intent: R | undefined;
  /** 本地认为的行（删除时为删除前的行），仅用于冲突呈现。 */
  localRow: R | undefined;
  /** 写前的服务端投影哈希；`undefined` = 该行此前不在文档里。 */
  beforeHash: string | undefined;
  settled: boolean;
  error: Error | undefined;
  settledPromise: Promise<void>;
  resolveSettled: () => void;
}

export interface RegisterPendingWriteInput<R extends object> {
  key: string;
  intent: R | undefined;
  localRow: R | undefined;
  beforeHash: string | undefined;
}

export interface PodPendingWrites<R extends object> {
  /** 有未确认写的 key（同一个 Set 直接暴露给 `PodCollection.pendingKeys`）。 */
  readonly keys: ReadonlySet<string>;
  readonly entries: ReadonlyMap<string, PodPendingWrite<R>>;
  readonly conflicts: readonly PodRowConflict<R>[];
  register(input: RegisterPendingWriteInput<R>): PodPendingWrite<R>;
  clear(key: string): void;
  /** 该 key 的写是否已确认（意图已出现在服务端投影里）。 */
  isConfirmed(key: string): boolean;
  /** @internal 记录一次冲突（server wins + 标记 + 事务失败）。 */
  recordConflict(conflict: PodRowConflict<R>): void;
  /** @internal 结束一个未确认写：`error` 为空表示确认。 */
  settle(entry: PodPendingWrite<R>, error?: Error): void;
}

export function createPendingWrites<R extends object>(
  onConflict?: (conflict: PodRowConflict<R>) => void,
): PodPendingWrites<R> {
  const keys = new Set<string>();
  const entries = new Map<string, PodPendingWrite<R>>();
  const conflicts: PodRowConflict<R>[] = [];

  const clear = (key: string): void => {
    keys.delete(key);
    entries.delete(key);
  };

  const settle = (entry: PodPendingWrite<R>, error?: Error): void => {
    if (entry.settled) return;
    entry.error = error;
    entry.settled = true;
    entry.resolveSettled();
  };

  const register = (input: RegisterPendingWriteInput<R>): PodPendingWrite<R> => {
    // 同一 key 上只允许一个未确认写（库的乐观层也只展示最后一个）；后者取代前者。
    clear(input.key);
    const deferred = createDeferred();
    const entry: PodPendingWrite<R> = {
      ...input,
      settled: false,
      error: undefined,
      settledPromise: deferred.promise,
      resolveSettled: deferred.resolve,
    };
    entries.set(input.key, entry);
    keys.add(input.key);
    return entry;
  };

  return {
    keys,
    entries,
    conflicts,
    register,
    clear,
    settle,
    isConfirmed: (key) => entries.get(key)?.settled === true && entries.get(key)?.error === undefined,
    recordConflict: (conflict) => {
      conflicts.push(conflict);
      onConflict?.(conflict);
    },
  };
}

/** 冲突标记：记录 + 回调 + 让写事务失败（§4.5）。 */
export function markConflict<R extends object>(
  pending: PodPendingWrites<R>,
  entry: PodPendingWrite<R>,
  server: R,
): void {
  pending.recordConflict({
    key: entry.key,
    server,
    local: (entry.localRow ?? entry.intent ?? server) as R,
    at: Date.now(),
  });
  pending.settle(entry, new PodCollectionError(
    'write_conflict',
    `row ${entry.key} was changed by someone else; server wins`,
  ));
}

/**
 * 每轮读回文档后调和未确认写（§4.2、§4.4、§4.5）。
 * - 服务端投影覆盖了意图的**可读**字段：确认（handler 可以 resolve，乐观层被同值服务端行替换）。
 * - 服务端投影 ∉ {意图, 写前值}：外部冲突，server wins + 标记 + 事务失败。
 * - 服务端还没有该行：继续等下一轮（写可能还在索引后面）。
 *
 * `writeOnly` 是 `mapping.writeOnlyFields(descriptor)`：`secret: true` 的字段读不回来，
 * 因此**不参与**「覆盖」判定，也不会因为它们而判冲突 —— 规则与理由见
 * `diff.projectionCovers()`。可读字段的比对一字未松：意图里任何一个非 secret 字段
 * 在服务端行里对不上，仍然走冲突分支。
 */
export function reconcilePendingWrites<R extends object>(
  pending: PodPendingWrites<R>,
  next: ReadonlyMap<string, R>,
  hashOf: (row: R) => string,
  writeOnly: ReadonlySet<string> = EMPTY_WRITE_ONLY,
): void {
  for (const entry of pending.entries.values()) {
    if (entry.settled) continue;
    const server = next.get(entry.key);
    if (entry.intent === undefined) {
      // 删除意图：行不在了就是确认。
      if (server === undefined) {
        pending.settle(entry);
        continue;
      }
      if (entry.beforeHash !== undefined && hashOf(server) !== entry.beforeHash) {
        markConflict(pending, entry, server);
      }
      continue;
    }
    if (projectionCovers(server, entry.intent, writeOnly)) {
      // 意图的可读字段都在服务端行里（插入意图可能只带一部分字段；带 secret 的意图
      // 只按可读部分确认，secret 的证据是写调用已经成功）。
      pending.settle(entry);
      continue;
    }
    if (server !== undefined && hashOf(server) !== entry.beforeHash) {
      markConflict(pending, entry, server);
      continue;
    }
    if (server === undefined && entry.beforeHash !== undefined) {
      // 我们想改的行已经不在文档里：外部删除，服务端状态已是「不存在」。
      pending.settle(entry, new PodCollectionError(
        'write_conflict',
        `row ${entry.key} disappeared before the write was confirmed; server wins`,
      ));
    }
  }
}

/** 默认「没有只写字段」，与 `projectionCovers()` 的默认值同义。 */
const EMPTY_WRITE_ONLY: ReadonlySet<string> = new Set<string>();

export interface PodMutationContext<D extends PodModelDescriptor> {
  descriptor: D;
  table: AnyPodTable;
  database: SolidDatabase;
  podUrl: string;
  document: string;
  pending: PodPendingWrites<RowOf<D>>;
  /** §4.2 的确认协议；由 sync 提供（立刻重读 + 至多 N 次合并窗口重试）。 */
  confirm: (key: string) => Promise<void>;
  /** PATCH 用的认证 fetch；缺省时从 database 的 session 取（见 `sessionFetchOf`）。 */
  authenticatedFetch?: typeof fetch;
}

function absoluteUri(value: unknown, base: string): string | undefined {
  if (typeof value !== 'string' || value.length === 0) return undefined;
  if (/^[a-z][a-z0-9+.-]*:/iu.test(value)) return value;
  return new URL(value, base).toString();
}

/**
 * `array: true` + `type: 'uri'` 字段的唯一写入口（§4.1）：一次 SPARQL PATCH，
 * 先删旧值再插新值。`array + uri` 之外字段不允许走这里。
 */
export async function writeField<D extends PodModelDescriptor>(
  context: PodMutationContext<D>,
  fieldName: string,
  options: { subjectIri: string; previous: unknown; next: unknown },
): Promise<void> {
  const field = context.descriptor.fields[fieldName];
  if (!field || !isUriArrayField(field)) {
    throw new PodCollectionError(
      'write_field_not_uri_array',
      `field ${fieldName} is not array+uri; it must go through the ORM`,
    );
  }
  const documentUrl = documentOfIri(context.document);
  const previous = (Array.isArray(options.previous) ? options.previous : [options.previous])
    .map((value) => absoluteUri(value, documentUrl))
    .filter((value): value is string => value !== undefined);
  const next = (Array.isArray(options.next) ? options.next : [options.next])
    .map((value) => absoluteUri(value, documentUrl))
    .filter((value): value is string => value !== undefined);

  const triples = (iris: readonly string[]): string => iris
    .map((iri) => `<${options.subjectIri}> <${field.predicate}> <${iri}> .`)
    .join('\n');
  const operations = [
    previous.length > 0 ? `DELETE DATA { ${triples(previous)} }` : undefined,
    next.length > 0 ? `INSERT DATA { ${triples(next)} }` : undefined,
  ].filter((operation): operation is string => operation !== undefined);
  if (operations.length === 0) return;

  const fetchFn = context.authenticatedFetch ?? sessionFetchOf(context.database);
  if (!fetchFn) {
    throw new PodCollectionError(
      'write_field_no_fetch',
      'array+uri fields need an authenticated fetch (SolidAuthSession.fetch); none available',
    );
  }
  const response = await fetchFn(documentUrl, {
    method: 'PATCH',
    headers: { 'content-type': 'application/sparql-update' },
    body: operations.join(';\n'),
  });
  if (!response.ok) {
    throw new PodCollectionError(
      'write_field_rejected',
      `SPARQL PATCH for ${fieldName} failed with HTTP ${response.status}`,
    );
  }
}

export interface PodMutationHandlers<D extends PodModelDescriptor> {
  onInsert: InsertMutationFn<RowOf<D>, string>;
  onUpdate: UpdateMutationFn<RowOf<D>, string>;
  onDelete: DeleteMutationFn<RowOf<D>, string>;
}

export function createMutationHandlers<D extends PodModelDescriptor>(
  context: PodMutationContext<D>,
): PodMutationHandlers<D> {
  const { descriptor, table, pending } = context;
  const fieldOrder = projectionFieldOrder(descriptor);
  const hashOf = (row: RowOf<D>): string => projectionHash(row, fieldOrder);
  const uriArrayFieldNames = new Set(
    Object.entries(descriptor.fields)
      .filter(([, field]) => isUriArrayField(field))
      .map(([name]) => name),
  );
  const columnBindings = fieldBindings(descriptor, table);
  const columnOf = (field: string): string | undefined => columnBindings.get(field)?.column;

  const runWrite = async (key: string, write: () => Promise<void>): Promise<void> => {
    try {
      await write();
    } catch (error) {
      pending.clear(key);
      throw error instanceof Error
        ? error
        : new PodCollectionError('write_failed', String(error), { cause: error });
    }
    try {
      await context.confirm(key);
    } finally {
      pending.clear(key);
    }
  };

  return {
    onInsert: async ({ transaction }) => {
      for (const mutation of transaction.mutations) {
        const row = mutation.modified as RowOf<D>;
        const key = String(mutation.key);
        const resourceId = resourceIdForRow(descriptor, context.document, context.podUrl, key);
        const subjectIri = subjectIriForRow(descriptor, context.document, key);
        pending.register({
          key,
          intent: row,
          localRow: row,
          beforeHash: undefined,
        });
        await runWrite(key, async () => {
          const values = descriptorRowToColumnValues(descriptor, table, row as Record<string, unknown>, {
            resourceId,
            includeField: (field) => !uriArrayFieldNames.has(field),
          });
          await context.database.insert(table).values(values as never).execute();
          await writeUriArrayFields(context, row as Record<string, unknown>, subjectIri, undefined, row as Record<string, unknown>);
        });
      }
    },

    onUpdate: async ({ transaction }) => {
      for (const mutation of transaction.mutations) {
        const key = String(mutation.key);
        const original = mutation.original as RowOf<D>;
        const modified = mutation.modified as RowOf<D>;
        const changes = mutation.changes as Record<string, unknown>;
        const resourceId = resourceIdForRow(descriptor, context.document, context.podUrl, key);
        const subjectIri = subjectIriForRow(descriptor, context.document, key);
        const beforeHash = original && Object.keys(original).length > 0 ? hashOf(original) : undefined;
        pending.register({
          key,
          intent: modified,
          localRow: modified,
          beforeHash,
        });
        await runWrite(key, async () => {
          const columnChanges: Record<string, unknown> = {};
          for (const [field, value] of Object.entries(changes)) {
            if (uriArrayFieldNames.has(field)) continue;
            const column = columnOf(field);
            if (column === undefined) continue;
            columnChanges[column] = value;
          }
          if (Object.keys(columnChanges).length > 0) {
            const updated = await context.database.updateById(table, resourceId, columnChanges as never);
            if (!updated) {
              throw new PodCollectionError(
                'write_rejected',
                `drizzle-solid did not update ${resourceId}`,
              );
            }
          }
          await writeUriArrayFields(context, changes, subjectIri, original as Record<string, unknown>, modified);
        });
      }
    },

    onDelete: async ({ transaction }) => {
      for (const mutation of transaction.mutations) {
        const key = String(mutation.key);
        const original = mutation.original as RowOf<D>;
        const resourceId = resourceIdForRow(descriptor, context.document, context.podUrl, key);
        pending.register({
          key,
          intent: undefined,
          localRow: original,
          beforeHash: original && Object.keys(original).length > 0 ? hashOf(original) : undefined,
        });
        await runWrite(key, async () => {
          // 返回 false = 该行本来就不在：意图（行不存在）已经满足，交给确认协议判定。
          await context.database.deleteById(table, resourceId);
        });
      }
    },
  };
}

/** 遍历本次写涉及的 `array + uri` 字段，逐个走 §4.1 的 PATCH 旁路。 */
async function writeUriArrayFields<D extends PodModelDescriptor>(
  context: PodMutationContext<D>,
  changed: Record<string, unknown>,
  subjectIri: string,
  previousRow: Record<string, unknown> | undefined,
  nextRow: Record<string, unknown>,
): Promise<void> {
  for (const [field, fieldDescriptor] of Object.entries(context.descriptor.fields)) {
    if (!isUriArrayField(fieldDescriptor)) continue;
    if (!(field in changed)) continue;
    await writeField(context, field, {
      subjectIri,
      previous: previousRow?.[field],
      next: nextRow?.[field],
    });
  }
}
