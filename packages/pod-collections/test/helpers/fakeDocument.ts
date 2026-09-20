import type { PodModelDescriptor } from '@undefineds.co/models';
import { resourceIdForRow, subjectIriForRow } from '../../src/layout.js';
import type { PodSubjectRow } from '../../src/types.js';

/**
 * 可编程文档（doc §8.2）：主语行 + ETag + 404/403 注入。
 *
 * 注意：本 fake 的 `etag` **故意不被读路径使用** —— drizzle-solid 0.3.24 的读路径
 * 拿不到文档 ETag（结论与证据见 `src/read.ts`），所以 `conditionalDocumentRead()`
 * 对它必须返回 `etag: undefined`。`etag` 字段留着就是为了断言这一点，而不是假装
 * 条件读可用。`holdWrites`/`flush` 模拟「ORM 写了、索引还没读到」的时间差，用来驱动
 * §4.2 的重试与 §4.5 的冲突。
 */
export interface FakeDocument {
  readonly etag: string;
  markChanged(): void;
  /** 文档当前的主语行，形状与 drizzle-solid `select()` 的返回一致。 */
  read(): PodSubjectRow[];
  /** ORM 写落地的位置（受 `holdWrites` 影响）。 */
  applyWrite(key: string, values: Record<string, unknown>): void;
  applyDelete(key: string): void;
  /** 直接改文档（模拟别人写）：立即可见，不受 hold 影响。 */
  putRow(key: string, values: Record<string, unknown>): void;
  removeRow(key: string): void;
  rows(): ReadonlyMap<string, Record<string, unknown>>;
  /** 注入一次 HTTP 404/403（网络/权限），或设置持续失败。 */
  failNextRead(status: number): void;
  failReads(status: number | undefined): void;
  /** true = 写落到 fake database 但不进入文档，直到 `flush()`（模拟索引滞后）。 */
  holdWrites(hold: boolean): void;
  flush(): void;
  readCount(): number;
}

export interface FakeDocumentOptions {
  descriptor: PodModelDescriptor;
  podUrl: string;
  document: string;
  etag?: string;
  rows?: Record<string, Record<string, unknown>>;
}

export function createFakeDocument(options: FakeDocumentOptions): FakeDocument {
  const stored = new Map<string, Record<string, unknown>>(Object.entries(options.rows ?? {}));
  const held = new Map<string, Record<string, unknown> | null>();
  let holding = false;
  let nextReadError: number | undefined;
  let persistentReadError: number | undefined;
  let reads = 0;
  let version = 1;

  const bump = (): void => {
    version += 1;
  };

  const materialize = (key: string, values: Record<string, unknown>): PodSubjectRow => {
    const iri = subjectIriForRow(options.descriptor, options.document, key);
    return {
      id: resourceIdForRow(options.descriptor, options.document, options.podUrl, key),
      '@id': iri,
      uri: iri,
      subject: iri,
      ...values,
    } as PodSubjectRow;
  };

  const write = (key: string, values: Record<string, unknown>, visible: boolean): void => {
    bump();
    if (visible) stored.set(key, values);
    else held.set(key, values);
  };

  const remove = (key: string, visible: boolean): void => {
    bump();
    if (visible) stored.delete(key);
    else held.set(key, null);
  };

  return {
    get etag() {
      return `"v${version}"`;
    },
    markChanged: bump,
    read() {
      reads += 1;
      const error = nextReadError ?? persistentReadError;
      nextReadError = undefined;
      if (error !== undefined) throw new Error(`fake_document_http_${error}`);
      return [...stored.entries()].map(([key, values]) => materialize(key, values));
    },
    applyWrite: (key, values) => write(key, { ...values }, !holding),
    applyDelete: (key) => remove(key, !holding),
    putRow: (key, values) => write(key, { ...values }, true),
    removeRow: (key) => remove(key, true),
    rows: () => stored,
    failNextRead: (status) => {
      nextReadError = status;
    },
    failReads: (status) => {
      persistentReadError = status;
    },
    holdWrites: (hold) => {
      holding = hold;
    },
    flush: () => {
      for (const [key, values] of held) {
        if (values === null) stored.delete(key);
        else stored.set(key, values);
      }
      held.clear();
    },
    readCount: () => reads,
  };
}
