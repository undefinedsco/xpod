import type { AnyPodTable, SolidDatabase } from '@undefineds.co/drizzle-solid';
import type { PodModelDescriptor } from '@undefineds.co/models';
import { definePodCollection, podCollectionInternals } from '../../src/index.js';
import type { PodCollectionInternals } from '../../src/index.js';
import type { PodCollection, PodRowConflict, PodSyncState, RowOf } from '../../src/types.js';
import { createFakeDatabase } from './fakeDatabase.js';
import type { FakeDatabase } from './fakeDatabase.js';
import { createFakeDocument } from './fakeDocument.js';
import type { FakeDocument } from './fakeDocument.js';
import { createFakeFeed } from './fakeFeed.js';
import type { FakeFeed } from './fakeFeed.js';

/**
 * 测试夹具：一个合成 descriptor（字面量类型）+ 一张合成表 + 假文档/假库/假 feed。
 *
 * 合成 descriptor **不是** schema 规则的第二份副本：它是测试用的假 schema
 * （`https://example.test/ns#`），N2 的守卫只针对 `src/` 里的生产代码。
 * 字面量类型让 `RowOf<D>` 的逐字段精度可以被类型级断言覆盖。
 */

const NS = 'https://example.test/ns#';

export const widgetDescriptor = {
  uri: `${NS}Widget`,
  version: '1.0.0',
  source: 'developer',
  trustLevel: 'low',
  namespace: NS,
  class: `${NS}Widget`,
  resourceKind: 'widget',
  description: 'synthetic test descriptor',
  storage: { base: '/settings/widgets.ttl', resourceIdPattern: '#{id}' },
  fields: {
    id: { type: 'string', predicate: `${NS}id`, required: true },
    label: { type: 'string', predicate: `${NS}label` },
    // 字段名与列名不同：列名必须按谓词找（§2.4）。
    providerId: { type: 'string', predicate: `${NS}provider` },
    // 表里没有这一列（§2.7 的漂移面）。
    secretType: { type: 'string', predicate: `${NS}secretType` },
    apiKey: { type: 'string', predicate: `${NS}apiKey`, secret: true },
    scopes: { type: 'text', predicate: `${NS}scopes`, array: true },
    expiresAt: { type: 'timestamp', predicate: `${NS}expiresAt` },
    enabled: { type: 'boolean', predicate: `${NS}enabled` },
    priority: { type: 'number', predicate: `${NS}priority` },
    metadata: { type: 'json', predicate: `${NS}metadata` },
    home: { type: 'uri', predicate: `${NS}home` },
    hasModel: { type: 'uri', predicate: `${NS}hasModel`, array: true },
  },
  uniqueBy: ['providerId'],
  writableFields: ['label', 'priority'],
  mergePolicy: 'upsert',
  examples: [],
} as const satisfies PodModelDescriptor;

export type WidgetDescriptor = typeof widgetDescriptor;
export type WidgetRow = RowOf<WidgetDescriptor>;

/** 合成表：列名 → 谓词，与 models 的表同构（`getMapping()` 是映射的唯一入口）。 */
export function createWidgetTable(): AnyPodTable {
  const columns: Record<string, string> = {
    id: '@id',
    label: `${NS}label`,
    provider: `${NS}provider`,
    apiKey: `${NS}apiKey`,
    scopes: `${NS}scopes`,
    expiresAt: `${NS}expiresAt`,
    enabled: `${NS}enabled`,
    priority: `${NS}priority`,
    metadata: `${NS}metadata`,
    home: `${NS}home`,
    hasModel: `${NS}hasModel`,
  };
  return {
    config: { name: 'widget', base: '/settings/' },
    getType: () => widgetDescriptor.class,
    isInitialized: () => true,
    getMapping: () => ({
      name: 'widget',
      type: widgetDescriptor.class,
      columns: Object.fromEntries(
        Object.entries(columns).map(([column, predicate]) => [
          column,
          { column, predicate, kind: 'datatype' as const },
        ]),
      ),
    }),
  } as unknown as AnyPodTable;
}

export const POD_URL = 'https://pod.test/alice/';
export const WIDGET_DOCUMENT = `${POD_URL}settings/widgets.ttl`;

export interface Harness {
  descriptor: typeof widgetDescriptor;
  table: AnyPodTable;
  podUrl: string;
  documentUrl: string;
  fakeDocument: FakeDocument;
  fakeDatabase: FakeDatabase;
  feed: FakeFeed | undefined;
  collection: PodCollection<WidgetRow>;
  internals: PodCollectionInternals;
  log: string[];
  conflicts: PodRowConflict<WidgetRow>[];
  syncState(): PodSyncState;
  selectCount(): number;
}

export interface HarnessOptions {
  rows?: Record<string, Record<string, unknown>>;
  withFeed?: boolean;
  coalesceMs?: number;
  confirmRetries?: number;
  onConflict?: (conflict: PodRowConflict<WidgetRow>) => void;
}

export function createHarness(options: HarnessOptions = {}): Harness {
  const log: string[] = [];
  const conflicts: PodRowConflict<WidgetRow>[] = [];
  const documentUrl = WIDGET_DOCUMENT;
  const fakeDocument = createFakeDocument({
    descriptor: widgetDescriptor,
    podUrl: POD_URL,
    document: documentUrl,
    rows: options.rows ?? defaultRows(),
  });
  const table = createWidgetTable();
  const predicateToColumn = new Map(
    Object.entries(table.getMapping().columns).map(([column, entry]) => [entry.predicate, column]),
  );
  const fakeDatabase = createFakeDatabase({
    document: fakeDocument,
    tableName: 'widget',
    log,
    keyOfResourceId: (resourceId) => {
      const hash = resourceId.indexOf('#');
      return hash < 0 ? resourceId : resourceId.slice(hash + 1);
    },
    columnOfPredicate: (predicate) => predicateToColumn.get(predicate),
    keyOfSubjectIri: (iri) => {
      const hash = iri.indexOf('#');
      return hash < 0 ? undefined : iri.slice(hash + 1);
    },
  });
  const feed = options.withFeed === false ? undefined : createFakeFeed({ log });
  const collection = definePodCollection(widgetDescriptor, {
    table,
    database: fakeDatabase.database as SolidDatabase,
    podUrl: POD_URL,
    document: documentUrl,
    feed,
    coalesceMs: options.coalesceMs ?? 5,
    confirmRetries: options.confirmRetries,
    onConflict: (conflict) => {
      conflicts.push(conflict);
      options.onConflict?.(conflict);
    },
  });
  return {
    descriptor: widgetDescriptor,
    table,
    podUrl: POD_URL,
    documentUrl,
    fakeDocument,
    fakeDatabase,
    feed,
    collection,
    internals: podCollectionInternals(collection),
    log,
    conflicts,
    syncState: () => podCollectionInternals(collection).syncState(),
    selectCount: () => fakeDatabase.calls.select,
  };
}

/** 两行初始文档：`w1` 完整，`w2` 只有必填列。 */
export function defaultRows(): Record<string, Record<string, unknown>> {
  return {
    w1: {
      label: 'First',
      provider: `${NS}openai`,
      apiKey: 'sk-secret',
      scopes: ['read', 'write'],
      expiresAt: '2027-01-01T00:00:00.000Z',
      enabled: true,
      priority: 3,
      metadata: '{"priority":7}',
      home: 'https://example.test/home',
      hasModel: [`${POD_URL}settings/models/a.ttl#a`, `${POD_URL}settings/models/b.ttl#b`],
    },
    w2: { label: 'Second', enabled: false, priority: 1 },
  };
}

/** 等一个断言成立（测试内轮询，不用固定 sleep 猜调度）。 */
export async function waitUntil(
  predicate: () => boolean,
  message: string,
  timeoutMs = 2000,
): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error(`waitUntil timeout: ${message}`);
    await new Promise((resolve) => {
      setTimeout(resolve, 2);
    });
  }
}

export function tick(ms = 0): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
