import { describe, expect, it } from 'vitest';
import type { SolidDatabase } from '@undefineds.co/drizzle-solid';
import { conditionalDocumentRead, sessionFetchOf } from '../src/read.js';
import type { PodSubjectRow } from '../src/types.js';
import { WIDGET_DOCUMENT, createWidgetTable, widgetDescriptor } from './helpers/harness.js';

/**
 * 读原语与 §8.7-2 / §9-6 的结论：drizzle-solid 的读路径拿不到文档 ETag，
 * 所以 `conditionalDocumentRead()` 返回 `etag: undefined`，`ifNoneMatch` 无法短路读。
 * 这里用「有 ETag 的文档」证明我们**没有**假装条件读可用。
 */

const POD_URL = 'https://pod.test/alice/';
const FOREIGN_DOCUMENT = `${POD_URL}settings/providers/openai.ttl`;

interface ReadHarness {
  source: Parameters<typeof conditionalDocumentRead>[0];
  calls: { select: number; init: number };
  rows: PodSubjectRow[];
}

function createReadHarness(options: { etag?: string; initialized?: boolean } = {}): ReadHarness {
  const rows: PodSubjectRow[] = [
    {
      id: 'widgets.ttl#w1',
      '@id': `${WIDGET_DOCUMENT}#w1`,
      uri: `${WIDGET_DOCUMENT}#w1`,
      label: 'First',
    },
    {
      id: 'providers/openai.ttl#this',
      '@id': `${FOREIGN_DOCUMENT}#this`,
      uri: `${FOREIGN_DOCUMENT}#this`,
      label: 'Foreign',
    },
  ];
  const calls = { select: 0, init: 0 };
  const table = {
    ...(createWidgetTable() as unknown as Record<string, unknown>),
    isInitialized: () => options.initialized ?? true,
  };
  const database = {
    async init() {
      calls.init += 1;
    },
    select: () => ({
      from: () => ({
        async execute() {
          calls.select += 1;
          return rows.map((row) => ({ ...row }));
        },
      }),
    }),
    getDialect: () => ({
      config: { session: { fetch: async () => new Response(null, { status: 200 }) } },
    }),
  };
  return {
    source: {
      descriptor: widgetDescriptor,
      table: table as never,
      database: database as unknown as SolidDatabase,
      document: WIDGET_DOCUMENT,
      podUrl: POD_URL,
    },
    calls,
    rows,
  };
}

describe('conditionalDocumentRead (§8.2)', () => {
  it('returns only the rows of the table document', async () => {
    const harness = createReadHarness();
    const read = await conditionalDocumentRead(harness.source);
    expect(read.subjects.map((row) => row.id)).toEqual(['widgets.ttl#w1']);
  });

  it('never claims a document etag, even when the document has one', async () => {
    // 假文档带 ETag（"v1"），读路径也拿不到它：返回的 etag 必须是 undefined。
    const harness = createReadHarness({ etag: '"v1"' });
    const read = await conditionalDocumentRead(harness.source);
    expect(read.etag).toBeUndefined();
    expect(Object.keys(read)).toEqual(['etag', 'subjects']);
  });

  it('ignores ifNoneMatch: there is no conditional read to short-circuit', async () => {
    const harness = createReadHarness({ etag: '"v1"' });
    await conditionalDocumentRead(harness.source, { ifNoneMatch: '"v1"' });
    await conditionalDocumentRead(harness.source, { ifNoneMatch: '"v1"' });
    // 没有 304 分支：每次都真的读（同步层据此做全量 diff，见 §8.7-2 的出口）。
    expect(harness.calls.select).toBe(2);
  });

  it('initialises the table once when the table reports itself uninitialised', async () => {
    const pending = createReadHarness({ initialized: false });
    await conditionalDocumentRead(pending.source);
    expect(pending.calls.init).toBe(1);
    const ready = createReadHarness({ initialized: true });
    await conditionalDocumentRead(ready.source);
    expect(ready.calls.init).toBe(0);
  });

  it('propagates read failures to the caller (sync degrades, it does not wipe rows)', async () => {
    const harness = createReadHarness();
    const broken = {
      ...harness.source,
      database: {
        ...(harness.source.database as unknown as Record<string, unknown>),
        select: () => ({
          from: () => ({
            async execute() {
              throw new Error('fake_document_http_403');
            },
          }),
        }),
      } as unknown as SolidDatabase,
    };
    await expect(conditionalDocumentRead(broken)).rejects.toThrow('fake_document_http_403');
  });
});

describe('sessionFetchOf', () => {
  it('finds the authenticated session fetch drizzle-solid itself uses', () => {
    const harness = createReadHarness();
    expect(typeof sessionFetchOf(harness.source.database)).toBe('function');
  });

  it('returns undefined when the session fetch is not reachable', () => {
    const harness = createReadHarness();
    const stripped = {
      ...(harness.source.database as unknown as Record<string, unknown>),
      getDialect: () => ({ config: {} }),
    } as unknown as SolidDatabase;
    expect(sessionFetchOf(stripped)).toBeUndefined();
  });
});
