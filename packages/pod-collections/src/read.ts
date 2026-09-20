import type { AnyPodTable, SolidDatabase } from '@undefineds.co/drizzle-solid';
import type { PodModelDescriptor } from '@undefineds.co/models';
import type { PodDocumentRead, PodSubjectRow } from './types.js';
import { rowBelongsToDocument } from './layout.js';

/**
 * 唯一的读原语（§8.2）：`conditionalDocumentRead(document, { ifNoneMatch })`
 * → `{ etag, subjects }`。
 *
 * ## 文档 ETag：P1 第一件事的结论（§8.7-2 / §9-6）
 *
 * **drizzle-solid 0.3.24 的读路径拿不到文档 ETag**，所以本原语恒返回
 * `etag: undefined`，同步按 §8.7-2 的出口降级为「每个合并窗口全量读 + 投影 diff，
 * 只写真正变化的行」，仍然零轮询（N1）。证据：
 *
 * 1. 类型面上没有任何 ETag 载体：`QueryResourceHelper.findMany/findFirst/find/findById`
 *    返回 `Promise<T[]>`（`node_modules/@undefineds.co/drizzle-solid/dist/core/pod-database.d.ts`
 *    的 `QueryResourceHelper`）、`ExecutionStrategy.executeSelect` 返回 `unknown[]`
 *    （`dist/core/execution/types.d.ts`）、`ComunicaSPARQLExecutor.executeSelect` 同样
 *    （`dist/core/sparql-executor.d.ts:22`）。
 * 2. 实现面上只有写路径读 ETag：整个 `dist/`（CJS 与 ESM 两份）里只有
 *    `core/sparql-executor.js:301` / `:344` 两处 `headers.get('ETag')`，都在
 *    `executeUpdate()` 里为 PATCH 组装 `If-Match`，从不返回给调用方；
 *    `executeDirectSparqlQuery()`（同文件 `:704-745`）只取 `payload.results.bindings`。
 * 3. 读并不落在文档上：`credentialResource` 声明了 `sparqlEndpoint: '/settings/-/sparql'`
 *    （`@undefineds.co/models@0.2.57` 的 `dist/credential.schema.js:74`，与 0.2.56 同行同值 ——
 *    该版本改动的是 `credentialDescriptor.fields` / `uniqueBy`，没有动表的 endpoint），
 *    `SparqlStrategy.executeSelect()`（`dist/core/execution/sparql-strategy.js:66-82`）
 *    把查询发给该 endpoint，`resolveTargetGraph(table, true)`（`forSelect`）对 document
 *    模式返回 `undefined`，实测生成的查询没有 `GRAPH`/`FROM` 子句：
 *    `SELECT ?subject … WHERE { ?subject rdf:type <…/ns#Credential>. … }`。
 *    `.test-data/etag-probe/probe.ts` 的记录显示这次读期间**文档本身没有被请求**
 *    （只打到 `/settings/-/sparql?query=…`），所以文档 ETag 不是这次读的 validator：
 *    即便能拿到它，也无法用来判定「这次读的结果是否变了」。
 * 4. 唯一能拿到 ETag 的路径是绕过读 API：`database.getDialect().config.session.fetch`
 *    是注入的认证 fetch（实测 `HEAD <document>` → `200 ETag: "v1"`，带 `If-None-Match`
 *    的条件 GET → `304`）。它属于 drizzle-solid 的内部接线（`PodDialect.config.session`），
 *    与 §3.2 想要的「条件**读**」不是同一个资源（见第 3 点），因此本层不依赖它，
 *    也不据此伪造 `metadata.collection.etag`。
 *
 * `ifNoneMatch` 因此只是签名上的兼容位：本实现无法用它短路读，读者应把
 * `etag === undefined` 当作「条件读不可用」的信号（§8.7-2、§9-6）。
 */

export interface PodDocumentReadSource<D extends PodModelDescriptor> {
  descriptor: D;
  table: AnyPodTable;
  database: SolidDatabase;
  /** 表所在文档的绝对 URL（`resolveTableDocument()` 的结果）。 */
  document: string;
  podUrl: string;
}

export interface PodDocumentReadRequest {
  /** 上一次读到的文档 ETag。当前读路径无法使用它（见文件头）。 */
  ifNoneMatch?: string;
}

/** drizzle-solid `select().from(table).execute()`；首次读前确保表已 init。 */
async function selectSubjectRows(
  table: AnyPodTable,
  database: SolidDatabase,
): Promise<PodSubjectRow[]> {
  const initialized = typeof table.isInitialized === 'function' ? table.isInitialized() : true;
  if (!initialized) await database.init?.(table);
  const rows = await database.select().from(table).execute();
  return rows as PodSubjectRow[];
}

/**
 * 读一个文档的全部主语行。行由 drizzle-solid 的读给出（它已经按表的 `type`
 * 施加类过滤：查询里带 `?subject rdf:type <descriptor.class>`），这里再按文档收敛，
 * 因为该读不是文档作用域的（见文件头第 3 点）。
 */
export async function conditionalDocumentRead<D extends PodModelDescriptor>(
  source: PodDocumentReadSource<D>,
  _request: PodDocumentReadRequest = {},
): Promise<PodDocumentRead> {
  const subjects = await selectSubjectRows(source.table, source.database);
  return {
    etag: undefined,
    subjects: subjects.filter((subject) => rowBelongsToDocument(
      source.descriptor,
      source.document,
      source.podUrl,
      subject,
    )),
  };
}

/**
 * 认证 fetch：drizzle-solid 没有公开的 session fetch 访问器，`PodDialect.config.session`
 * 是唯一可达路径，且就是它自己用的那个 fetch（`sparql-executor.js:296/:319` 的 HEAD/PATCH）。
 * 仅 §4.1 的 `array + uri` PATCH 旁路需要它；拿不到时抛明确错误而不是静默跳过写。
 */
export function sessionFetchOf(database: SolidDatabase): typeof fetch | undefined {
  const dialect = (database as unknown as {
    getDialect?: () => { config?: { session?: { fetch?: unknown } } };
  }).getDialect?.();
  const candidate = dialect?.config?.session?.fetch;
  return typeof candidate === 'function' ? (candidate as typeof fetch) : undefined;
}
