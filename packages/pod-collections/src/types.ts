import type { Collection, InsertConfig, Transaction } from '@tanstack/db';
import type { AnyPodTable, SolidDatabase } from '@undefineds.co/drizzle-solid';
import type {
  PodModelDescriptor,
  PodModelFieldDescriptor,
  PodModelFieldType,
} from '@undefineds.co/models';

/**
 * descriptor 字段类型 → TS 类型（`docs/pod-collections.md` §2.1）。
 * `array: true` 必须先于标量判断。
 *
 * 与 §2.1 代码块的唯一差别是最后两行：`@undefineds.co/models@0.2.57` 仍然把 descriptor
 * 声明成 `PodModelDescriptor`（`fields: Record<string, PodModelFieldDescriptor>`，
 * 见 `dist/pod-storage-descriptor.d.ts:13-34` / `:95`），字段字面量类型没有随包导出，
 * 所以官方 descriptor 的 `{ type: ... }` 是**联合类型**而不是单个字面量 —— 0.2.57 补的是
 * credential 的字段（19 个），没有把字段类型变精确。此时若沿用 §2.1 的 `: string` 兜底，
 * `RowOf<typeof credentialDescriptor>` 会把 `expiresAt` / `createdAt` 等 `timestamp` 字段
 * 也标成 `string`，而运行时它们是 `Date` —— 类型说谎。这里对「类型未被收窄」的情形返回
 * `unknown`：字面量 descriptor（测试与将来的 models 发版）仍得到 §2.1 的精确类型，
 * 官方 descriptor 得到诚实的 `unknown`，绝不静默收窄或放宽成表列类型。
 *
 * 附带后果：`keyof Record<string, …>` 是 `string | number`，所以 `RowOf<官方 descriptor>`
 * 带索引签名，字段名不会被静态校验 —— 这正是 `test/guards.test.ts` 用运行时清单
 * （36 字段 / 36 列 / `uniqueBy`）而不是类型来守漂移的原因。
 */
export type PodFieldValue<F extends PodModelFieldDescriptor> =
  F extends { array: true } ? PodFieldValue<Omit<F, 'array'>>[]
  : F extends { type: 'number' } ? number
  : F extends { type: 'boolean' } ? boolean
  : F extends { type: 'timestamp' } ? Date
  : F extends { type: 'json' } ? unknown
  : F extends { type: 'string' | 'text' | 'uri' } ? string
  : F extends { type: PodModelFieldType } ? unknown
  : string;

/**
 * 行 = descriptor 的 fields 投影 + 行标识（§2.1）。
 *
 * 行标识只有 `id`（`resourceIdPattern` 的 `{id}` slot，§2.7 的键取法）与 `@id`
 * （主语 IRI）。**不从 drizzle 表列推导行类型**：表列与 descriptor 不一致时由
 * `test/guards.test.ts` 报错，而不是悄悄把行类型放宽到表列。
 */
export type RowOf<D extends PodModelDescriptor> =
  { [K in keyof D['fields']]: PodFieldValue<D['fields'][K]> }
  & { id: string; '@id'?: string };

/**
 * drizzle-solid `select()` 返回的「主语行」：列名 → 已解码值，外加虚列
 * `id`（base-relative resource id）、`@id` / `uri` / `subject`（主语 IRI）。
 * 形状由 `packages/pod-collections/.test-data` 探针实测，
 * 见 `read.ts` 的 ETag 说明。
 */
export type PodSubjectRow = Record<string, unknown>;

/**
 * 一次文档读的结果（§8.2 的 `conditionalDocumentRead`）。
 *
 * `etag` 只有在读路径能拿到文档 validator 时才有值；drizzle-solid 0.3.24 的读
 * 路径拿不到（证据见 `read.ts`），所以实际实现恒为 `undefined`，同步退化为
 * 「每个合并窗口全量读 + 投影 diff」（§8.7-2 的出口）。字段保留是为了将来读原语
 * 能给出 ETag 时不必改签名。
 */
export interface PodDocumentRead {
  etag: string | undefined;
  subjects: PodSubjectRow[];
}

/**
 * 变更 feed 端口（§2.2）：只声明集合层用到的那一面，结构上由
 * `SolidNotificationsCapability` 满足。集合层不实现任何传输。
 */
export interface PodDocumentFeed {
  watch(topicUrl: string, listener: (signal: { topic: string }) => void): () => void;
}

/** 该 key 上未确认的本地写与服务端行的冲突（§4.5，server wins + 标记）。 */
export interface PodRowConflict<R extends object> {
  key: string;
  /** 服务端当前行（已生效）。 */
  server: R;
  /** 本地未确认写入的意图。 */
  local: R;
  at: number;
}

/** 同步状态：`live` = feed 可用；`unavailable` = 只读一次 + 显式 `refresh()`（N1）。 */
export type PodSyncState = 'initializing' | 'live' | 'unavailable' | 'degraded';

/**
 * TanStack 的 Collection + 我们加的观测面（§2.2）。
 * TanStack 的类型不出现在 applet 签名里，换引擎时改动面锁在包内。
 */
export interface PodCollection<R extends { id: string } = Record<string, unknown> & { id: string }>
  extends Collection<R, string> {
  /**
   * 写入负载收窄成「descriptor 字段的一部分 + 行标识」。
   *
   * 为什么不能直接用 `RowOf<D>` 当插入输入：`secret: true` 的字段不从行里投影出去
   * （§2.1），所以行类型拿不到、也读不回这些字段，而写入必须能提供它们。缺的字段
   * 由 drizzle-solid 的列默认值补齐；确认协议按「意图里**可读**的字段」逐字段比对，
   * 不用整行相等（否则带默认值的服务端行永远无法与部分意图相等）。
   *
   * 只写字段（`secret: true`）写得到、读不回，因此**不参与**确认比对，也不会因为
   * 它们被判冲突：它们的证据是写入调用本身成功。规则与理由见 `diff.projectionCovers()`
   * 与 `docs/pod-collections.md` §9-7。
   */
  insert: (
    data: (Partial<R> & { id: string }) | Array<Partial<R> & { id: string }>,
    config?: InsertConfig,
  ) => Transaction<Record<string, unknown>>;
  /** 表所在文档的绝对 URL（§2.3 的 topic 推导结果）。 */
  readonly tableDocument: string;
  /** 有未确认本地写的 key。sync 不会用服务端行覆盖它们的 insert/delete 判定（§3、§4.4）。 */
  readonly pendingKeys: ReadonlySet<string>;
  /** 记录到的外部冲突（最近优先）。 */
  readonly conflicts: readonly PodRowConflict<R>[];
  /** 显式条件重读；mutation handler 的确认协议内部也用它（§4.2）。 */
  refresh(): Promise<void>;
}

export interface PodCollectionOptions<D extends PodModelDescriptor> {
  /** drizzle-solid 表：I/O 走它。 */
  table: AnyPodTable;
  database: SolidDatabase;
  podUrl: string;
  /** 变更 feed（脏信号）。缺省 = 无 live：只读一次，之后只能显式 refresh()（N1）。 */
  feed?: PodDocumentFeed;
  /**
   * 表所在文档。单文档表可由 `storage.base` 推导（缺省）；
   * 跨文档表（模型行按 provider 分文档）必须给，或用 scope 选一个文档。
   */
  document?: string;
  scope?: { provider?: string; instanceId?: string };
  /** 变更合并窗口，沿用现网 75ms。 */
  coalesceMs?: number;
  onConflict?: (conflict: PodRowConflict<RowOf<D>>) => void;
  /** 确认协议的重试次数（写入后未读回意图时再等一个合并窗口），默认 2（§4.2）。 */
  confirmRetries?: number;
}

/** 集合层错误：都带稳定 code，调用方按 code 分派，不解析 message。 */
export class PodCollectionError extends Error {
  readonly code: string;
  /** 原始错误（`Error.cause` 是 ES2022；本包 target ES2020，自己挂字段）。 */
  readonly cause?: unknown;

  constructor(code: string, message: string, options?: { cause?: unknown }) {
    super(message);
    this.name = 'PodCollectionError';
    this.code = code;
    this.cause = options?.cause;
  }
}

export type { PodModelDescriptor, PodModelFieldDescriptor };
