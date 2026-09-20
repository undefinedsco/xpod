import type { SolidDatabase } from '@undefineds.co/drizzle-solid';
import type { FakeDocument } from './fakeDocument.js';

/**
 * 假 drizzle-solid database（doc §8.2）：记录调用、可编程失败，写落到 fake document。
 *
 * 调用记录用来断言 §4.1 的映射（哪张表、哪个 base-relative resource id、哪些列），
 * 以及 §4.2 的读次数（确认协议读几次）。
 */
export interface FakeWriteCall {
  table: string;
  values?: Record<string, unknown>;
  id?: string;
  changes?: Record<string, unknown>;
}

export interface FakeDatabase {
  database: SolidDatabase;
  calls: {
    select: number;
    init: number;
    insert: FakeWriteCall[];
    updateById: FakeWriteCall[];
    deleteById: FakeWriteCall[];
  };
  /** 注入下一次写失败（模拟服务端拒绝）。 */
  failNextWrite(error: Error): void;
  /** 认证 fetch 的调用记录（§4.1 的 array+uri PATCH 旁路）。 */
  fetchCalls: Array<{ url: string; method: string; body: string }>;
  /** 注入 PATCH 失败。 */
  failNextPatch(status: number): void;
  /** 让下一次读挂起，直到 `releaseReads()`（用于「读期间缓冲并重放」的断言）。 */
  holdReads(): void;
  releaseReads(): void;
}

export interface FakeDatabaseOptions {
  document: FakeDocument;
  /** 表名（`table.config.name`）。 */
  tableName: string;
  /** 行键 → 文档里的列值（由 resource id 反查）。 */
  keyOfResourceId: (resourceId: string) => string | undefined;
  /** 谓词 → 列名：PATCH（array+uri 旁路）落到 fake document 时要还原成列值。 */
  columnOfPredicate?: (predicate: string) => string | undefined;
  /** subject IRI → 行键（PATCH 的目标行）。 */
  keyOfSubjectIri?: (iri: string) => string | undefined;
  /** 调用顺序日志（先订阅后读的断言用）。 */
  log?: string[];
  authenticatedFetch?: boolean;
}

export function createFakeDatabase(options: FakeDatabaseOptions): FakeDatabase {
  const { document } = options;
  const calls: FakeDatabase['calls'] = { select: 0, init: 0, insert: [], updateById: [], deleteById: [] };
  const fetchCalls: FakeDatabase['fetchCalls'] = [];
  let nextWriteError: Error | undefined;
  let nextPatchStatus: number | undefined;
  let readGate: Promise<void> | undefined;
  let releaseGate: (() => void) | undefined;

  const keyFrom = (resourceId: string): string => {
    const key = options.keyOfResourceId(resourceId);
    if (key === undefined) throw new Error(`fake_database_unknown_resource_id:${resourceId}`);
    return key;
  };

  const applyPatch = (_url: string, body: string): void => {
    if (!options.columnOfPredicate) return;
    // PATCH 的 body 是 `DELETE DATA { <s> <p> <o> . } ; INSERT DATA { … }`：
    // 逐条三元组按 subject 找到行，再按谓词还原成列值（array+uri 字段）。
    const updates = new Map<string, { mode: 'insert' | 'delete'; column: string; object: string }[]>();
    for (const statement of body.split(';')) {
      const mode = statement.includes('DELETE DATA')
        ? 'delete'
        : statement.includes('INSERT DATA')
          ? 'insert'
          : undefined;
      if (!mode) continue;
      for (const match of statement.matchAll(/<([^>]+)>\s+<([^>]+)>\s+<([^>]+)>\s*\./gu)) {
        const [, subject, predicate, object] = match as unknown as [string, string, string, string];
        const column = options.columnOfPredicate(predicate);
        if (column === undefined) continue;
        const list = updates.get(subject) ?? [];
        list.push({ mode, column, object });
        updates.set(subject, list);
      }
    }
    for (const [subject, triples] of updates) {
      const key = options.keyOfSubjectIri?.(subject);
      if (key === undefined) continue;
      const current = { ...(document.rows().get(key) ?? {}) };
      delete current.id;
      delete current['@id'];
      for (const { mode, column, object } of triples) {
        const values = new Set<string>(Array.isArray(current[column]) ? (current[column] as string[]) : []);
        if (mode === 'insert') values.add(object);
        else values.delete(object);
        const next = [...values];
        if (next.length > 0) current[column] = next;
        else delete current[column];
      }
      document.applyWrite(key, current);
    }
  };

  const authenticatedFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    options.log?.push(`patch:${url}`);
    fetchCalls.push({ url, method: init?.method ?? 'GET', body: String(init?.body ?? '') });
    if (nextPatchStatus !== undefined) {
      const status = nextPatchStatus;
      nextPatchStatus = undefined;
      return new Response('patch failed', { status });
    }
    applyPatch(url, String(init?.body ?? ''));
    return new Response(null, { status: 200 });
  }) as typeof fetch;

  const database = {
    async init() {
      calls.init += 1;
    },
    select() {
      return {
        from() {
          return {
            async execute() {
              calls.select += 1;
              options.log?.push('select');
              if (readGate) await readGate;
              const current = document.read();
              return current.map((row) => ({ ...row }));
            },
          };
        },
      };
    },
    insert(table: { config?: { name?: string } }) {
      return {
        values(values: Record<string, unknown>) {
          return {
            async execute() {
              if (nextWriteError) {
                const error = nextWriteError;
                nextWriteError = undefined;
                throw error;
              }
              options.log?.push('insert');
              calls.insert.push({ table: table.config?.name ?? options.tableName, values: { ...values } });
              document.applyWrite(keyFrom(String(values.id)), values);
              return [values];
            },
          };
        },
      };
    },
    async updateById(table: { config?: { name?: string } }, id: string, changes: Record<string, unknown>) {
      if (nextWriteError) {
        const error = nextWriteError;
        nextWriteError = undefined;
        throw error;
      }
      options.log?.push('updateById');
      calls.updateById.push({ table: table.config?.name ?? options.tableName, id, changes: { ...changes } });
      const key = keyFrom(id);
      const current = { ...(document.rows().get(key) ?? {}) };
      delete current.id;
      delete current['@id'];
      const next = { ...current, ...changes };
      document.applyWrite(key, next);
      return { id, '@id': id, ...next };
    },
    async deleteById(table: { config?: { name?: string } }, id: string) {
      if (nextWriteError) {
        const error = nextWriteError;
        nextWriteError = undefined;
        throw error;
      }
      options.log?.push('deleteById');
      calls.deleteById.push({ table: table.config?.name ?? options.tableName, id });
      const key = keyFrom(id);
      const existed = document.rows().has(key);
      document.applyDelete(key);
      return existed;
    },
    getDialect() {
      return { config: { session: { fetch: authenticatedFetch } } };
    },
  };

  return {
    database: database as unknown as SolidDatabase,
    calls,
    fetchCalls,
    failNextWrite: (error) => {
      nextWriteError = error;
    },
    failNextPatch: (status) => {
      nextPatchStatus = status;
    },
    holdReads: () => {
      readGate = new Promise<void>((resolve) => {
        releaseGate = resolve;
      });
    },
    releaseReads: () => {
      releaseGate?.();
      releaseGate = undefined;
      readGate = undefined;
    },
  };
}
