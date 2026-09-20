/**
 * 投影哈希与三向 diff（§3.2、§3.3）。
 *
 * 两个设计点：
 *
 * 1. **`metadata.row` 存的是投影哈希，不是 per-row ETag**：一个 Solid 文档只有一个
 *    ETag，文档内的主语没有独立 validator（§3.2）。哈希按谓词排序的字段顺序计算
 *    （`mapping.projectionFieldOrder()`），与字段声明顺序无关。
 * 2. **update 的判定用「上次服务端投影哈希」，insert/delete 的判定用「集合当前呈现
 *    的行」**，且带未确认写的 key 不参与 insert/delete 判定。理由：乐观写期间
 *    `collection.state` 里那一行已经是写入后的值，若用呈现行做 update 判定，自回声
 *    会被判成 0 次写，服务端行永远进不了 syncedData，乐观层一撤就回退到旧值
 *    （实测 `@tanstack/db@0.9.0` 的 `CollectionStateManager.get()` = 乐观覆盖层 ??
 *    syncedData；事务完成时乐观层被丢弃）。用 `metadata.row` 的哈希判定 update，
 *    服务端行会写进 syncedData，而库自己的冗余抑制
 *    （`dist/esm/collection/state.js:885-905` 的 `isRedundantSync`）保证呈现值不变时
 *    不产生事件 —— 这才是「无闪烁」的机制。
 */

export interface PodProjectionEntry<R extends object> {
  key: string;
  row: R;
}

/** 默认「没有只写字段」：不传 `writeOnly` 的调用方语义与改动前一致。 */
const EMPTY_FIELDS: ReadonlySet<string> = new Set<string>();

export interface PodDocumentDiff<R extends object> {
  inserts: PodProjectionEntry<R>[];
  updates: PodProjectionEntry<R>[];
  deletes: PodProjectionEntry<R>[];
}

/**
 * 去掉 TanStack 的虚属性（`$synced` / `$origin` / `$key` / `$collectionId`）。
 * 按约定前缀 `$` 判定：`@tanstack/db@0.9.0` 的 `virtual-props.d.ts` 明确「用户 schema
 * 不应含 `$` 前缀字段，保留给虚属性」，且 `VIRTUAL_PROP_NAMES` 没有从包入口导出。
 */
export function stripVirtualProps<R extends object>(row: R): R {
  const source = row as Record<string, unknown>;
  const stripped: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(source)) {
    if (key.startsWith('$')) continue;
    stripped[key] = value;
  }
  return stripped as R;
}

function canonicalValue(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map((item) => canonicalValue(item));
  if (value && typeof value === 'object') {
    if (value instanceof Set) return [...value].map((item) => canonicalValue(item));
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
    return Object.fromEntries(entries.map(([key, item]) => [key, canonicalValue(item)]));
  }
  return value;
}

/**
 * 行的投影哈希：只包含行标识 `id` 与 descriptor 声明的字段（按谓词顺序）、
 * 递归排序对象键、`undefined` 不参与。
 *
 * 两点取舍：
 * - **不含 `@id`**：主语 IRI 由 `id` + 文档推导（`subjectIriForRow`），带上它只会让
 *   写入意图（applet 给的行常常没有 `@id`）与服务端投影不可比；身份已经由 `id` 表达。
 * - **不含 descriptor 之外的键**：集合的行就是 descriptor 投影，多出来的键既不会
 *   出现在服务端读里，也不该让「未变」被误判成「变了」。
 */
export function projectionHash<R extends object>(
  row: R,
  fieldOrder: readonly string[],
): string {
  const source = stripVirtualProps(row) as Record<string, unknown>;
  const ordered: Record<string, unknown> = {};
  if (source.id !== undefined) ordered.id = canonicalValue(source.id);
  for (const field of fieldOrder) {
    if (source[field] !== undefined) ordered[field] = canonicalValue(source[field]);
  }
  return JSON.stringify(ordered);
}

function canonicalEquals(left: unknown, right: unknown): boolean {
  if (left === undefined || right === undefined) return left === right;
  return JSON.stringify(canonicalValue(left)) === JSON.stringify(canonicalValue(right));
}

/**
 * 服务端投影是否覆盖了写入意图：意图里**每个可读字段**（`@id` 与只写字段除外）都相等。
 *
 * 逐字段而不是整行哈希：插入意图通常只带一部分字段，其余由列默认值补齐；
 * 服务端行也可能带读取侧才有的字段（`@id`）。
 *
 * ## 只写字段（`secret: true`）为什么不参与比对
 *
 * 确认协议必须只承诺能读回来的东西。`secret: true` 的字段按 §2.1 被排除在投影之外
 * （`mapping.writeOnlyFields()` 是那条规则的唯一来源），**任何读取路径都不可能返回它们**，
 * 所以「服务端行里等于意图值」这个条件对它们永远不可能成立：
 *
 * - 把它们算进比对 ⇒ 带 secret 的意图永远无法确认（旧缺陷：随后落进
 *   `hashOf(server) !== beforeHash` 分支，被误判成 `write_conflict`）；
 * - 反过来把「读不到」当成冲突同样是错的：它不是「服务端值和我们写的不一样」，
 *   而是「这一层看不见」。
 *
 * 选定规则：**只写字段被排除在确认比对之外；它们的唯一证据是写入调用本身成功**
 * （`mutations.createMutationHandlers()` 只在 `insert/updateById` 或 `array+uri` 的
 * PATCH resolve 之后才进入确认循环；写入抛错会直接回滚，根本不走到这里），
 * 集合行则始终是投影行 —— 不假装把 secret 读了回来。
 *
 * 措辞边界：这不削弱**可读**字段的确认。意图里出现的每个非 secret 字段（包括
 * descriptor 声明了、但当前没有承载列因而读不回来的字段，§2.7 的漂移面）仍然逐字段
 * 比对；任何一个对不上，`reconcilePendingWrites()` 依旧判 `write_conflict`。
 */
export function projectionCovers<R extends object>(
  row: R | undefined,
  intent: R,
  writeOnly: ReadonlySet<string> = EMPTY_FIELDS,
): boolean {
  if (row === undefined) return false;
  const source = stripVirtualProps(row) as Record<string, unknown>;
  const target = stripVirtualProps(intent) as Record<string, unknown>;
  for (const [key, value] of Object.entries(target)) {
    if (key === '@id' || value === undefined) continue;
    if (writeOnly.has(key)) continue;
    if (!canonicalEquals(source[key], value)) return false;
  }
  return true;
}

export interface PodDocumentDiffInput<R extends object> {
  /** 服务端（文档）当前投影，按行键。 */
  next: ReadonlyMap<string, R>;
  /** 集合当前呈现的行键（含乐观覆盖层）。 */
  presentKeys: Iterable<string>;
  /** 有未确认本地写的 key：不参与 insert/delete 判定（§3.4、§4.4）。 */
  pendingKeys: ReadonlySet<string>;
  /** 上一次服务端投影哈希（`metadata.row`）。 */
  knownHash: (key: string) => string | undefined;
  hashOf: (row: R) => string;
  /** 已从文档消失的行的原值，供 `write({type:'delete', value})` 使用。 */
  presentRow?: (key: string) => R | undefined;
}

export function computeDocumentDiff<R extends object>(
  input: PodDocumentDiffInput<R>,
): PodDocumentDiff<R> {
  const present = new Set(input.presentKeys);
  const inserts: PodProjectionEntry<R>[] = [];
  const updates: PodProjectionEntry<R>[] = [];
  const deletes: PodProjectionEntry<R>[] = [];

  /**
   * The projection the collection should already hold for `key`.
   *
   * Row metadata is the fast path, but a store/library combination without it
   * would otherwise answer `undefined` for every key and make every sync pass
   * rewrite every present row - our own echo would replace rows that did not
   * change. Falling back to the row we last applied answers the same question
   * ("did this projection change?") from data we always have.
   */
  const baselineHash = (key: string): string | undefined => {
    const known = input.knownHash(key);
    if (known !== undefined) return known;
    const held = input.presentRow?.(key);
    return held === undefined ? undefined : input.hashOf(held);
  };

  for (const [key, row] of input.next) {
    if (input.pendingKeys.has(key)) {
      // 未确认的本地写：服务端行仍要进 syncedData（否则乐观层撤不掉），
      // 但不能据此判定 insert（那会在乐观行还在时插入同一 key）。
      if (present.has(key) && baselineHash(key) !== input.hashOf(row)) {
        updates.push({ key, row });
      }
      continue;
    }
    if (!present.has(key)) {
      inserts.push({ key, row });
      continue;
    }
    if (baselineHash(key) !== input.hashOf(row)) updates.push({ key, row });
  }

  for (const key of present) {
    if (input.next.has(key)) continue;
    if (input.pendingKeys.has(key)) continue;
    const row = input.presentRow?.(key);
    if (row === undefined) continue;
    deletes.push({ key, row });
  }

  return { inserts, updates, deletes };
}
