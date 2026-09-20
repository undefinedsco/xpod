# Pod 表集合（Pod Collections）设计：声明式集合 + 乐观写入

> 状态：**P1 已实现（`packages/pod-collections`：骨架、同步算法、mutation 层与乐观契约，依赖按 §7.2 锁定）；本轮完成宿主能力接线（`podCollections`）与凭据列表 pilot，即 §8.1 的 P3 页面部分**。P4（provider / 模型表）等 models 补 descriptor（§2.6）。P1 的实测偏差与两处被测试抓到的真实缺陷记录在 **§8.9**（实现记录）；实现与设计不一致之处以该节为准。
> 口径：三项关键决策已由用户确认，见 **§1.4**；设计边界三条禁止见 **§1.5**。
> 上游关系：实现 [`ai-connections-storage-model.md`](ai-connections-storage-model.md) §11 末尾「排期：表级 subscribe（§12）先落地」中的 **§12**（该文写到 §11 为止，§12 即本文）。
> 版本声明：实现针对 **`@tanstack/db` 0.9.0 / `@tanstack/react-db` 0.3.8**（npm registry 实测 §7.2）；设计引用的 API 事实读自 **0.6.7** 随包 skill 文档（其 frontmatter 标注 `library_version: '0.6.0'`），对锁定版本的逐条复验结果见 **§8.9**。
> 实测口径：本文所有「运行时行为」结论都有仓库内证据（测试名或源码路径）；隔离测试栈通过**不等于**真实实例通过（§8.6）。

## 1. 目标与非目标

### 1.1 目标

1. 一个 Pod 表（同一 RDF 文档内的一类主语集合）用一个**声明**描述：schema、行键、行↔RDF 映射、topic 全部来自 `@undefineds.co/models` 的 descriptor，消费方不手写任何一个。
2. 消费方拿到**活数据**：文档变更后按 key 增量更新，页面不再写「进页面读一次 + 收到信号整表重读」。
3. 写入有**乐观更新**：本地立即生效、服务端确认后转正、被拒自动回滚；外部冲突显式暴露，不静默覆盖。
4. 现网这套手写机制被集合层**替代**而不是并存：`credentialsTableDocument()` / `providerTableDocument()` / `TABLE_CHANGE_COALESCE_MS` / `liveRevision`。

### 1.2 非目标

- 不重新实现通道与 socket 管理：集合消费已存在的传输原语（`ui/src/extensions/solid-notifications.ts`，契约 `SolidNotificationsCapability` 见 `packages/extension-sdk/src/web.ts`）。
- 不在本仓库维护 schema 规则的第二份副本（AGENTS.md「建模规则」条：schema、URI 字段、日期分桶、exact id 操作以 `@undefineds.co/models` 为权威）。
- **行级文档表不在本期范围**：`gatewayAccessKeyDescriptor` 的布局是 `base = '/.data/'` + `resourceIdPattern = '{id}'`（一行一个文档），topic 语义是容器订阅而非文档订阅，与本文「一个表 = 一个文档」的前提不同，单独立项。
- 不做跨表事务、不做关系查询优化；`loadSubset` 谓词下推不进第一期（§8.1）。
- 不做离线写入队列、不做多写者自动合并（Pod 是唯一真相，server wins）。

### 1.3 归属裁决（一句话）

> **schema（表、列、谓词、行标识、可写字段）进 `@undefineds.co/models`；通用集合 adapter 与类型推导进新包 `packages/pod-collections`；页面行为（展示投影、动作、状态机）留 applet。**

| 层 | 拥有 | 不拥有 |
|---|---|---|
| `@undefineds.co/models` | descriptor（`storage.base` / `resourceIdPattern` / `fields` / `uniqueBy` / `writableFields` / `mergePolicy`）与 drizzle 表 | 任何运行时行为、topic 字符串、订阅开关、展示语义 |
| `packages/pod-collections`（新） | 声明 API、类型推导 `RowOf<D>`、topic 推导、同步算法、diff、乐观/回滚/冲突 | schema 规则、表清单、展示字段 |
| applet（如 `@undefineds.co/ai-connections`） | 用哪些表（= 声明哪些集合）、怎么展示、动作是什么 | 手写 topic、手写 refetch、手写乐观补丁 |

判据沿用 [`catalog-ownership.md`](catalog-ownership.md)：能被机械消费、影响行为的事实（布局、键、可写字段）→ models 与集合层；给人看或描述「怎么接入」的 → applet。

### 1.4 已定决策（用户确认，不再作为开放问题）

| # | 决策 | 含义与落点 |
|---|---|---|
| **D1** | **真依赖 `@tanstack/db` + `@tanstack/react-db`**（UI 用 React hooks） | 不手写模仿该 API 的内核。两个包作为 `packages/pod-collections` 的真依赖，版本**精确锁定**，升级走显式 PR（§7.2） |
| **D2** | **放置在新包 `packages/pod-collections`**，发布名 **`@undefineds.co/pod-collections`** | 不放 `packages/solid-sdk`、不放 `packages/shared-ui`（否决理由 §6.3）。命名与发布沿用 `packages/*` 既有约定（§6.2） |
| **D3** | **「统一开启」= 集合定义本身即声明** | models 的 descriptor **不加任何订阅/通知开关**；是不是活表由 applet 是否 `definePodCollection` 决定；topic 由 `storage.base` + `resourceIdPattern` 推导（§2.3）。models 仍然只管 schema（§1.3） |

### 1.5 三条禁止（设计边界，写成守卫测试）

| # | 禁止 | 理由与守卫 |
|---|---|---|
| **N1** | **禁止轮询兜底** | feed 不可用时只允许「读一次 + 显式 `refresh()`」，同步状态显式为 `unavailable`，不装任何周期性定时器。守卫测试断言主入口源码不出现 `setInterval`（传输层已有同款守卫：`ui/src/extensions/solid-notifications.test.ts:421-443`） |
| **N2** | **禁止在本仓库出现第二份 schema 规则** | 集合层只**读** descriptor 与 drizzle 表：不写表清单、不写字段映射表、不写布局常量（对比：现网 `CREDENTIAL_DOCUMENT_ID` 这类从 descriptor 派生的写法是正确形态，`XpodAiConnectionsPodStore.ts:47`）。守卫测试见 §8.5 |
| **N3** | **禁止在 models 里加订阅/通知标志** | `PodModelDescriptor` 不新增 `subscribe` / `notification` / `live` 之类的字段；「统一开启」不靠 schema 开关实现（D3） |

## 2. 声明：`definePodCollection`

### 2.1 类型推导：`RowOf<D>`

```ts
import type { PodModelDescriptor, PodModelFieldDescriptor } from '@undefineds.co/models'
import type { Collection } from '@tanstack/db'

/** descriptor 字段类型 → TS 类型。`array: true` 必须先于标量判断。 */
type ValueOf<F extends PodModelFieldDescriptor> =
  F extends { array: true } ? ValueOf<Omit<F, 'array'>>[]
  : F extends { type: 'number' } ? number
  : F extends { type: 'boolean' } ? boolean
  : F extends { type: 'timestamp' } ? Date
  : F extends { type: 'json' } ? unknown
  : string                                   // 'string' | 'text' | 'uri'

/** 行 = descriptor 的 fields 投影 + 行标识。 */
export type RowOf<D extends PodModelDescriptor> =
  { [K in keyof D['fields']]: ValueOf<D['fields'][K]> }
  & { id: string; '@id'?: string }
```

- `PodModelFieldType = 'string' | 'text' | 'number' | 'boolean' | 'timestamp' | 'uri' | 'json'`，字段描述符为 `{ type, predicate, required?, secret?, array?, description? }`（`node_modules/@undefineds.co/models/dist/pod-storage-descriptor.d.ts:3-12`）。
- `secret: true` 的字段默认**不从集合行投影出去**（凭据表今天就是这样：页面拿到的是 `AiProviderCredentialSummary`，不是 `encryptedSecret`）。

### 2.2 声明接口

```ts
export interface PodDocumentFeed {
  /** 结构上由 SolidNotificationsCapability 满足；只声明集合层用到的那一面。 */
  watch(topicUrl: string, listener: (signal: { topic: string }) => void): () => void
}

export interface PodCollectionOptions<D extends PodModelDescriptor> {
  /** drizzle-solid 表：I/O 走它。 */
  table: AnyPodTable
  database: SolidDatabase
  podUrl: string
  /** 变更 feed（脏信号）。缺省 = 无 live：只读一次，之后只能显式 refresh()（禁止轮询，N1）。 */
  feed?: PodDocumentFeed
  /**
   * 表所在文档。单文档表可由 storage.base 推导（缺省）；
   * 跨文档表（模型行按 provider 分文档）必须给，或用 scope 选一个文档。
   */
  document?: string
  scope?: { provider?: string; instanceId?: string }
  /** 变更合并窗口，沿用现网 75ms。 */
  coalesceMs?: number
  onConflict?: (conflict: PodRowConflict<RowOf<D>>) => void
}

export declare function definePodCollection<D extends PodModelDescriptor>(
  descriptor: D,
  options: PodCollectionOptions<D>,
): PodCollection<RowOf<D>>

/** TanStack 的 Collection + 我们加的三个观测面。 */
export interface PodCollection<R> extends Collection<R, string> {
  readonly tableDocument: string
  readonly pendingKeys: ReadonlySet<string>
  readonly conflicts: readonly PodRowConflict<R>[]
  /** 显式条件重读；mutation handler 的确认协议内部也用它（§4.2）。 */
  refresh(): Promise<void>
}

export interface PodRowConflict<R> {
  key: string
  /** 服务端当前行（已生效）。 */
  server: R
  /** 本地未确认写入的意图。 */
  local: R
  at: number
}
```

设计约束：**接口是我们自己的**。`definePodCollection` 的返回类型收窄为 `PodCollection<R>`，TanStack 的类型不出现在 applet 的签名里（换引擎或大版本升级时改动面锁在包内，§7.2）。

### 2.3 topic 推导规则（D3 的落点）

表是一个**文档**，行是文档里的**主语**，所以 topic 只有一个来源：descriptor 的布局。三种形状（取值均为 `@undefineds.co/models@0.2.56` 实测）：

| `storage.base` | `resourceIdPattern` | topic | 现网实例 |
|---|---|---|---|
| 文档（`.ttl`）+ `#{id}` | `/settings/credentials.ttl` + `#{id}` | **base 本身** | 凭据表 `…/settings/credentials.ttl` |
| 容器 + `{key}.ttl` | `/settings/providers/` + `{key}.ttl` | `base + key + '.ttl'` | provider 表 `…/settings/providers/openai.ttl` |
| 容器 + `{isProvidedBy.doc}#{key}` | `/settings/providers/` + `{isProvidedBy.doc}#{key}` | **行所属 provider 的文档**（由 scope 决定） | 模型表（同 provider 文档内的模型主语） |

第 3 行是关键：**「模型表」不是一个文档，而是每个 provider 一个文档**。所以 `document` 必须是可选显式输入；凭据表能只看 `storage.base`，是因为它恰好是单文档布局。现网已经在手工做同一件事（`ui/src/extensions/XpodAiConnectionsPodStore.ts:47` 的 `CREDENTIAL_DOCUMENT_ID`，`:92` 的 `providerTableDocument()`）——集合层把这段逻辑收敛成一条规则、一处实现。

> 第四种形状（`base = '/.data/'` + `{id}`，一行一文档，如 `gatewayAccessKeyDescriptor`）不在本期范围，见 §1.2。

### 2.4 行 ↔ RDF 映射规则

映射不重新定义，落在 descriptor 字段与 drizzle 列上。字面量 datatype 取自 `node_modules/@undefineds.co/drizzle-solid/dist/esm/core/sparql/helpers.js`：

| descriptor `type` | drizzle 列 | RDF 形态 |
|---|---|---|
| `uri` | `uri()` | 宾语为 named node |
| `uri` + `array: true` | `uri().array()` | 每个元素一条三元组 ⚠️ 写入端有缺陷，见 §4.1 |
| `string` / `text` | `string()` / `text()` | 字面量；`text` 可重复 |
| `number` | `integer()` / `real()` | 整数 `xsd:integer`，否则 `xsd:decimal` |
| `boolean` | `boolean()` | `"true"/"false"^^xsd:boolean` |
| `timestamp` | `timestamp()` | `"…"^^xsd:dateTime` |
| `json` | `json()` | 单个字面量；JSON 序列化细节以 drizzle-solid 为准，本设计不复制 |

两条必须写下来的边界：

1. **`string` 字段的值若以 `http(s)://` 开头，会被写成 named node**（同文件 `buildLiteralTerm`）。所以「字符串 vs URI」不只由列声明决定；反过来，映射回行时**不能靠 term 类型反推字段类型**，必须按 descriptor 的字段声明解析。
2. 行的准入以 descriptor 的 `class` 为准（表 options 的 `type`，如 `UDFS.Credential`，见 `node_modules/@undefineds.co/models/dist/credential.schema.js`）：文档里不属于该 class 的主语不产生行。今天这个判定混在行形状里（`providerSummariesFromPodRows()`，`ui/src/extensions/XpodAiConnectionsPodStore.ts:547`），集合层要把它显式化。

### 2.5 例子 A：凭据表（今天就能编译，P1 的靶子）

```ts
import { credentialDescriptor, credentialResource } from '@undefineds.co/models'
import { definePodCollection } from '@undefineds.co/pod-collections'

export const credentials = definePodCollection(credentialDescriptor, {
  table: credentialResource,
  database,
  podUrl,
  feed: solidNotifications,   // 宿主注入的能力，结构上满足 PodDocumentFeed
})
// credentials.tableDocument === `${podUrl}settings/credentials.ttl`（由 storage.base 推导）
// credentials 的元素类型 === RowOf<typeof credentialDescriptor>
```

`credentialDescriptor` 实测：`storage.base = '/settings/credentials.ttl'`、`resourceIdPattern = '#{id}'`、`fields` 含 `id/label/authMode/encryptedSecret/scopes…`（`scopes` 是 `text` + `array: true`）。

### 2.6 例子 B：provider / 模型表（今天**不能**编译，缺 descriptor）

```ts
import { aiProviderResource, aiModelResource } from '@undefineds.co/models'
import { definePodCollection } from '@undefineds.co/pod-collections'

// 目标形态（models 发布 aiProviderDescriptor 之后）
export const providers = definePodCollection(aiProviderDescriptor, {
  table: aiProviderResource, database, podUrl, feed: solidNotifications,
})

// 模型行按 provider 分文档，所以要给 scope（§2.3 第 3 行）
export function modelsFor(provider: string, instanceId?: string) {
  return definePodCollection(aiModelDescriptor, {
    table: aiModelResource, database, podUrl, feed: solidNotifications,
    document: providerDocumentOf(provider, instanceId),
  })
}
```

**为什么今天不能编译（已核实，不是猜测）**：`@undefineds.co/models@0.2.56` 的 `officialPodModelDescriptors`（`node_modules/@undefineds.co/models/dist/pod-storage-descriptor.d.ts:120`）里**没有** provider / 模型项——25 个 descriptor 是 credential、gateway-access-key、quota-snapshot、contact、chat、thread、message、…、input-request。provider 与模型只有 drizzle 表（`node_modules/@undefineds.co/models/dist/ai-provider.schema.js`、`ai-model.schema.js`）。
按 AGENTS.md「schema 进 models」（也是 D3），正确修法是**在 models 补两个 descriptor**，不是在本仓库给 provider 另写一份布局。因此 P1–P3 只声明凭据表（§8.1）。

### 2.7 已核实的两处 schema 漂移（会直接影响实现，先记下来）

| # | 事实 | 证据（models 0.2.56 逐字段比对） | 对本设计的影响 |
|---|---|---|---|
| 1 | `credentialDescriptor.uniqueBy = ['service','providerId','secretType']`，其中 `providerId`、`secretType` **不是** `credentialResource` 的列（表里叫 `provider`，也没有 `secretType`） | descriptor 独有字段：`providerId`、`secretType`；表独有 19 列：`provider`、`offeringId`、`baseUrl`、`proxyUrl`、`metadata`… | **`getKey` 不能取 `uniqueBy`**：它引用不存在的字段；且凭据池允许同一 provider 多条凭据（`ui/src/extensions/XpodAiConnectionsPodStore.ts:128` 用 `${provider}-${uuid}` 生成 id）→ 天然不唯一。**`getKey` 取行标识**（`resourceIdPattern` 的 `{id}` ↔ drizzle `id` 列），`uniqueBy` 只作业务/合并键 |
| 2 | `credentialDescriptor.fields` 是 `credentialResource` 列的**子集**：`offeringId`、`baseUrl`、`proxyUrl`、`metadata` 等 19 列不在 descriptor 里 | 同上 | `RowOf<D>` 若只从 descriptor 推导，会漏掉页面已经在用的字段（`offeringId`、`metadata.priority`）。因此集合的行类型 = descriptor 投影与表列的**显式取舍**；实现期加守卫测试断言「集合暴露的字段两边都能找到」（§8.5） |

> 这两条是 models 仓库**内部**的漂移，属 schema 归属范围内的问题。按 AGENTS.md「绕过前先报告」，应报给 models 而不是在 Xpod 绕（处置见 §9）。

## 3. 同步算法

### 3.1 时序（顺序不可换）

```
feed.watch(document) ──► 首次整表读（一次 drizzle-solid select）
       │                        │
       │  读期间到达的脏信号 → 缓冲
       ▼                        ▼
  投递脏信号 ◄──────────── markReady()
       │
       ▼
  合并窗口（75ms）──► 条件重读 ──► diff ──► begin/write/commit 增量
```

三条硬约束（均出自 0.6.7 的 custom-adapter skill 文档，见文末引用）：

- **先订阅、后读**：先读后订阅会丢掉读窗口内发生的变更；
- **读期间缓冲、读后重放**；
- **必须 `markReady()`**：否则 live query 永不 resolve。

### 3.2 每次脏信号：条件重读 + diff

```ts
async function conditionalReread() {
  const known = metadata.collection.get('etag') as string | undefined
  const { etag, subjects } = await readDocument(document, { ifNoneMatch: known })
  if (etag !== undefined && etag === known) return          // 文档未变：0 次 write()
  metadata.collection.set('etag', etag)

  const next = mapSubjects(subjects)                         // §2.4 的映射
  const prev = new Map(currentRows().map((r) => [getKey(r), r]))
  const inserts = [...next].filter(([k]) => !prev.has(k))
  const updates = [...next].filter(([k, r]) => prev.has(k) && hash(r) !== metadata.row.get(k)?.hash)
  const deletes = [...prev].filter(([k]) => !next.has(k))
  if (inserts.length + updates.length + deletes.length === 0) return

  begin()
  for (const [, row] of inserts) write({ type: 'insert', value: row })
  for (const [k, row] of updates) write({ type: 'update', key: k, value: row })  // rowUpdateMode: 'full'
  for (const [k, row] of deletes) write({ type: 'delete', key: k, value: row })
  commit()
  for (const [k, row] of [...inserts, ...updates]) metadata.row.set(k, { hash: hash(row) })
}
```

要点与依据：

- **文档 ETag 存 `metadata.collection`**：`readDocument` 带 `If-None-Match` 发条件请求，304 直接返回——**未变的文档 0 次行写入**。
- **`metadata.row` 存的是「投影哈希」，不是 per-row ETag**：一个 Solid 文档只有**一个** ETag，文档内的主语没有独立 validator（HTTP/LDP 语义如此，RDF 层面不存在 per-subject ETag）。因此 per-row 状态是 `hash(映射后的行)`（字段按谓词排序后哈希），diff 靠它判「这一行真的变了」。**这是对「`metadata.row` 存 per-row ETag」这一表述的修正**，理由即上述语义。
- **`rowUpdateMode: 'full'`**：diff 的产物是整行映射结果而非字段补丁；用 `'partial'` 无法表达「谓词被移除」（`array` 字段尤其）。
- **`metadata.row` 的清理交给库**：skill 文档明确「行被 `delete` 时其 row metadata 自动删除」；每次重读后重新 `set` 哈希。
- **合并窗口 75ms** 沿用现网常量 `TABLE_CHANGE_COALESCE_MS`（`packages/ai-connections/src/controller.tsx:70`）。

### 3.3 为什么是 diff 增量，而不是整表 `refetch()`

1. **整表替换会作废 per-row 状态**：若实现成 `truncate()` + 重新插入，每个 key 都变成新行，`metadata.row` 的哈希失去意义，下次 diff 又要全量比较——省了读、丢了跳跃的判定依据。渐进式 `write` 才是让 per-row 状态有用的唯一写法。
2. **只有增量能保住组件身份**：live query 下游按 key 订阅，未变的 key 不产生新行对象，列表不整段重渲染；整表替换让每行都是新对象。
3. **乐观状态不再被无谓清空**：整表替换会动摇正在进行的乐观覆盖层，把 §4.4 想消灭的闪烁变成常态。现网已经为此写了手工守卫——`AiGatewayKeysSection.tsx:122-124` 的注释就写着「别处做的变更只需要新行：不能丢掉本会话仍在展示的 wrapper 副本，也不能闪 loading」。
4. 现网的 `liveRevision` + `loadProviders()` 就是整表重读：`packages/ai-connections/src/AiConnectionsMain.tsx:50` 在 revision 变化时重跑整个 `listProviders()`（内部三次 `select()`，`ui/src/extensions/XpodAiConnectionsPodStore.ts:108-123`）。这是要替换掉的行为。

### 3.4 行从文档里消失

`write({ type: 'delete', key, value: prevRow })`，且必须与「读了但被过滤掉」区分开：

- 主语被删、或不再满足 descriptor 的 `class` → **delete**；
- **读取失败**（网络/权限）→ **不动集合**，只把同步状态标成降级（`SolidLiveUpdateState` 已有 `unavailable`，`packages/extension-sdk/src/web.ts:269`），避免把一次读失败当成「所有行都没了」，也**不退回轮询**（N1）；
- **模型表的整文档消失**：provider 文档被删 → 该文档下的全部模型行 delete。文档级与行级在集合层是同一件事（一个 topic 一组行），不需要额外语义。

## 4. 乐观契约

### 4.1 mutation → drizzle-solid

| TanStack handler | 落盘 | 现网用法 |
|---|---|---|
| `onInsert({ transaction })` | `database.insert(table).values(row).execute()` | `ui/src/extensions/XpodAiConnectionsPodStore.ts:165`、`:200` |
| `onUpdate({ transaction })` | `database.updateById(table, key, changes)`；需要看渲染出的 SPARQL 时用 `db.session.update(table).set(...).whereByIri(...).toSPARQL()` | `:272`、`:329`、`:456`、`:894`；builder 路径见 [`drizzle-solid-link-array-update-todo.md`](drizzle-solid-link-array-update-todo.md) 的 `toSPARQL()` 用例 |
| `onDelete({ transaction })` | `database.deleteById(table, key)` | `:386` |
| **`array: true` + `type: 'uri'` 字段** | **不走 ORM**：一次认证过的 SPARQL PATCH | `persistModelSelectionLinks()`，`:476` |

阵列 URI 字段（现在只有 `aiProvider.hasModel`）为什么特殊：drizzle-solid 0.3.24 的更新构建器把数组当标量，`DELETE` 模板删掉该主语**所有**该谓词的三元组，`INSERT` 写**一个字面量**（逗号拼接、转义后的 URI 串）。上游复现与根因写在 [`drizzle-solid-link-array-update-todo.md`](drizzle-solid-link-array-update-todo.md)；同一份文档也定了纪律：**PATCH 是这次写的全部，不是 ORM 写之后的修补**（两者都发会留下清不掉的脏字面量）。

集合层的处理：把它收敛进**一个** mutation 映射点——`writeField(field, value)`：字段是 `array` + `uri` → 走 PATCH；否则走 ORM。调用方（applet）不知道这条绕过的存在；删除条件满足时只改这一处。

### 4.2 乐观时长策略：**id 追踪 + 文档 ETag 确认**（本设计的选定）

skill 文档给了 5 种策略（refetch / transaction id / id 追踪 / version-timestamp / provider `waitForPendingWrites`），并有一条硬要求：**handler 不能在服务端变更同步回集合之前 resolve**。我们的 feed 是**纯脏信号**（不带 payload、不带 txid、不带版本，见 `packages/extension-sdk/src/web.ts:271-291` 对 `SolidLiveUpdateSignal` 的说明），逐个排除：

- **transaction id** ✗：服务端不返回，feed 也不携带；
- **version / timestamp** ✗：没有可用的 per-row 版本（同 §3.2）；
- **provider `waitForPendingWrites`** ✗：Pod 侧没有这样的方法，只有我们自己的读；
- **纯 `utils.refetch()`** ✗：它等的是「一次读完成」，而我们的读是**合并窗口 + 条件重读**，handler 可能在一次**早于**自己写入的读之后 resolve；
- **纯 id 追踪** ✗：只等「这个 key 出现在流里」不够——key 本来就在，改的是内容。

**选定：id 追踪 + 文档 ETag 确认。** mutation handler 的收尾：

```ts
const before = metadata.collection.get('etag')   // 写前记下
await writeThroughDrizzleSolid(...)              // §4.1
// 立刻条件重读（把合并窗口压到 0，不等通知——通知可能被合并、被丢弃）
// 确认条件：文档 ETag 已前进 且 该 key 的投影 == 我们写进去的意图
await confirmWrite(key, intended, before)        // 未满足则再等一个合并窗口重试，默认 2 次后抛错
```

- 代价：**每次写 +1 次文档读**（已计入 §5 的账）。
- 收益：handler 的 resolve 与「集合里已是服务端状态」严格同义，乐观覆盖层不会提前掉落（不掉落就不闪）。超时抛错 → 自动回滚（§4.3）。
- 为什么不等通知再读：通知与写路径**不相关**（传输层注释明确它无法知道本地是否有写在飞），且阵列 URI 字段的写走 PATCH，不能假定它与 ORM 写产生同样的通知时序。

### 4.3 失败与回滚

- handler 抛错 → TanStack **自动回滚**乐观状态并把事务置为 `failed`（mutations 文档）；我们**不额外写补偿逻辑**。
- 已知边界（文档明确）：**库不会自动重试**。可重试错误（`409/412`、网络抖动）在 handler 内部决定是否重试——建议只重试一次，其余直接失败，避免把「服务端拒绝」伪装成延迟成功。
- 事务对象暴露 `state`（`pending` → `persisting` → `completed` / `failed`）与 `isPersisted.promise`；页面要「保存中/已保存/失败」就读它，**不要自己维护第二个状态机**（现网 `providerLoadGeneration`、`oauthCredentialSaves` 就是这类手写产物：`packages/ai-connections/src/controller.tsx:143`、`ui/src/extensions/XpodAiConnectionsPodStore.ts:41`）。

### 4.4 自回声（我们自己的写触发的通知）

传输层**明确不做**这个判定：`SolidLiveUpdateSignal` 注释写着「applet 的写不经过通知通道，所以传输层无法知道本地是否有写在飞，也不猜」——消费者要用自己的写窗口去关联。

集合层的做法是**让自回声变成空操作**：

1. 我们的写已经乐观地把行改成目标状态；
2. 自回声触发条件重读，读回的投影与乐观行**逐字段相同**；
3. 因此 diff 产出 **0 条 insert/update/delete**，只更新 `metadata.collection` 的 ETag；
4. handler 的确认条件满足 → 乐观覆盖层被**同值**的服务端行替换 → 无可观察变化、无闪烁。

关键实现细节：**diff 的比较对象必须是「集合对外呈现的行」（含乐观覆盖层），不是「上一次服务端读回的行」**。否则自回声会被判成 update，产生一次多余行写入，乐观层被服务端行顶掉——这正是闪烁的来源。

### 4.5 外部冲突（server wins + 标记）

他人（或其他页面/设备）改了同一行时：

1. 条件重读拿到的服务端行**覆盖**集合（server wins，Pod 是唯一真相）；
2. 该 key 上若有未确认的本地写，**同时**记入 `conflicts` 并触发 `onConflict` 回调；
3. 该写的事务**失败**（抛错 → 回滚乐观状态），而不是让乐观层继续压着服务端行假装成功——否则用户看到的是一份永远不会落盘的状态；
4. 页面据 `onConflict` 给出可操作提示（「这条凭据已被其他设备修改，已显示最新值，请重试」），下次渲染丢掉本地补丁。

**不选**「静默覆盖」（丢用户输入且不可见）与「阻塞用户选择」（给凭据列表这种高频表引入阻塞对话框）。标记是折中，且不需要任何新的服务端能力——文档 ETag 就够了。

## 5. 资源账

前提：一个页面同时挂载的表文档 = 凭据文档 + 当前打开的 provider 文档（与现网 `pageTableDocuments()` 一致，`packages/ai-connections/src/controller.tsx:167`）。

| 状态 | 通道 | WebSocket | 读 | 写 | 说明 |
|---|---|---|---|---|---|
| 空闲（可见、无写入） | 每表 1 条（现网 2 条） | 每表 1 条 | 0（**零轮询**） | 0 | 之后没有任何定时器驱动读（N1） |
| 单次写 | 不变 | 不变 | 1 次条件读（`If-None-Match`；未变即 304） | 1 次 ORM 写 | handler 的确认读就是这一次（§4.2）；`array+uri` 字段另有 1 次 PATCH |
| 突发 B 次写（<75ms 窗口内） | 不变 | 不变 | **1 次** | B 次 | 合并窗口吸收 B 条通知；常量见 `packages/ai-connections/src/controller.tsx:70` |
| 文档未变的条件重读 | 不变 | 不变 | 1 次 304 | **0** | ETag 跳过：0 行写入 |
| 标签页隐藏 / pagehide | **0**（全部释放） | **0** | 0 | — | 传输层在 `visibilitychange` / `pagehide` 上 pause，socket 与订阅都关（`ui/src/extensions/solid-notifications.ts:350-371`） |
| 未登录 / 页面卸载 | 0 | 0 | 0 | — | 同上；session 变化即 pause，`dispose()` 清空 |

服务端侧：订阅落 KV 存储（cluster 为 PostgreSQL `internal_kv`，`config/xpod.cluster.json:44`；机制见 [`notification-subscription.md`](notification-subscription.md)）。通道建立的证据是 CSS 侧日志 `Accepted WebSocket connection listening to changes on <topic>`（`node_modules/@solid/community-server/dist/server/notifications/WebSocketChannel2023/WebSocket2023Listener.js`）。

## 6. 接口与放置

### 6.1 定案（D2）

新包 **`packages/pod-collections`**，发布名 **`@undefineds.co/pod-collections`**。理由（按权重）：

1. **依赖方向天然无环**：`pod-collections → @undefineds.co/models + @undefineds.co/drizzle-solid + @tanstack/db`；**不依赖 extension-sdk**。
2. **feed 用结构化端口，不复制契约**：`PodDocumentFeed` 只声明 `watch(topic, listener)` 一个方法，`SolidNotificationsCapability`（`packages/extension-sdk/src/web.ts:300`）结构上满足它。这是**更窄的端口**，不是第二份契约（AGENTS.md 禁止的是副本，不是窄接口；N2）。
3. **与「schema 进 models、adapter 在本仓库」一致**：它是通用 adapter，不含任何表清单或 schema 规则。
4. **可测且与 React 解耦**：单测能直接喂假 feed + 假 database（现网已有同款形态：`ui/src/extensions/ai-connections-live-updates.test.tsx` 用假 socket 驱动真实现）。
5. 发布与 applet 依赖解耦：先只在仓库内 `workspace:*` 消费（§6.2）。

公开面：`@undefineds.co/pod-collections`（主入口，无 React）+ `@undefineds.co/pod-collections/react`（React hooks）。

### 6.2 命名与发布：沿用 `packages/*` 既有约定（已核对）

| 约定 | 现网证据 | 新包的落点 |
|---|---|---|
| 包名 = `@undefineds.co/<目录名>`，`private: false` | `packages/solid-sdk/package.json` → `@undefineds.co/solid-sdk@0.1.0`；`shared-ui` → `@undefineds.co/shared-ui@0.1.1-rc.0`；`extension-sdk`、`ai-connections` 同 | `packages/pod-collections` → `@undefineds.co/pod-collections` |
| 子路径导出 | `extension-sdk`：`. / ./manifest / ./react / ./web / ./testing`；`solid-sdk`：`. / ./react / ./session …` | `.`（引擎）与 `./react`（hooks） |
| 构建脚本形状 | `packages/solid-sdk/package.json` 的 `build`：`rm -rf dist && tsc -p tsconfig.json && bun ../../scripts/fix-dist-js-imports.mjs dist && bun build … --outfile=dist/index.cjs` | 抄同一形状（ESM + CJS 双产物） |
| 测试脚本形状 | 同上：`vitest run test --config ../../vitest.packages.config.mts` | 同上；root `test:packages` 是 `bun run --filter './packages/*' test`，**新包自带脚本即可，root 无需改** |
| 仓库内消费 | `ui/package.json`、`packages/ai-connections/package.json` 一律 `workspace:*` | 同 |
| 发布 | `scripts/publish-package.cjs <pkg-dir>`：把 `workspace:*` 改写成 `^<该包当前版本>`，并**拒绝发布 RC 版本**（`assertPublishable`） | 沿用；首发版本须是非 RC |
| 数据层依赖的版本风格 | 精确版本、无 `^`：`ui/package.json` 与 root 都是 `@undefineds.co/models@0.2.56`、`@undefineds.co/drizzle-solid@0.3.24` | `@tanstack/db` / `@tanstack/react-db` 同风格（§7.2） |

### 6.3 被否决的两个候选

| 候选 | 现状 | 否决理由 |
|---|---|---|
| `packages/solid-sdk` | session / pod-runtime / webid-auth / storage-selection / login-store；依赖 `@inrupt/solid-client-authn-browser` + `zustand`，**不依赖 models、不依赖 drizzle-solid**（`packages/solid-sdk/package.json`） | ① 集合层必须以 models 的 descriptor 为 schema 权威、以 drizzle-solid 为 I/O，塞进来会把「Solid 会话 SDK」变成「Pod 数据栈」；② **依赖环**：`packages/extension-sdk` 已 `workspace:*` 依赖 solid-sdk（`packages/extension-sdk/package.json`），而集合层要消费宿主注入的 feed 能力（契约在 extension-sdk 的 `web.ts`）；③ 引入 React 数据层会改变它「无数据层」的对外形象 |
| `packages/shared-ui` | 纯视觉组件（radix + tailwind，`packages/shared-ui/src/*.tsx`，依赖里没有任何数据/协议包） | 与协议/数据无关；放进去等于把组件库变成数据层 |

（另有「放进 `packages/ai-connections`」：通用层进单个 applet，第二个 applet 要么复制、要么反向依赖，直接违反 N2 的精神。）

### 6.4 宿主如何暴露给 applet

1. `packages/extension-sdk/src/manifest.ts` 的 `HOST_CAPABILITY_NAMES` 加 `'podCollections'`（现为 3 项：`navigation.openExternal`、`aiClientConfiguration`、`solidNotifications`）。
2. `packages/extension-sdk/src/web.ts` 的 `WebExtensionHostCapabilities` 加 `podCollections?: PodCollectionsCapability`（现为 4 项）；`PodCollectionsCapability = { define<D>(descriptor: D, scope?): PodCollection<RowOf<D>>; dispose(): void }`，类型由 pod-collections 提供（`import type`）。
3. 新增 `ui/src/extensions/pod-collections-host.ts`（与 `solid-notifications.ts` 同层）：`createPodCollectionsCapability({ database, podUrl, feed })` —— 集合实例按 `(descriptor.uri, document)` 缓存，`dispose()` 释放。
4. `ui/src/extensions/ai-connections-host.ts` 在 `capabilities` 段注入该能力（与现网注入 `solidNotifications`、`aiConnectionsPodStore` 同一位置）。
5. `packages/ai-connections/src/manifest.ts` 的 `hostCapabilities` 加 `'podCollections'`（applet 显式声明需要它；现为 `navigation.openExternal`、`aiClientConfiguration`、`solidNotifications`）。
6. 生命周期：页面卸载/登出 → 集合 `dispose()`，与传输层的 pause 对齐（§5）。

### 6.5 页面如何消费

```tsx
// packages/ai-connections/src/AiCredentialPoolSection.tsx（示意：替换 liveRevision 那套）
import { useLiveQuery } from '@undefineds.co/pod-collections/react'

// useLiveQuery 的调用签名按 0.6.7 文档写作，0.9.0 需按 §7.6-5 复验
const { data: credentialRows, status } = useLiveQuery({
  query: (q) => q.from({ credential: collections.credentials }),
})
// credentialRows: RowOf<typeof credentialDescriptor>[]，已含乐观行；status 覆盖 loading/ready

// 写入：乐观更新由集合 mutation 层负责，页面不写补丁
collections.credentials.update(credentialId, (draft) => { draft.status = 'disabled' })
```

applet 保留的**行为**：`RowOf<D>[]` → `AiProviderSummary` 的投影（现网 `providerSummariesFromPodRows()`，`ui/src/extensions/XpodAiConnectionsPodStore.ts:547`）、按钮/对话框/状态机，全部留在 applet。集合层只给行与写入原语。

**P3 实际落点（与上面示意的一处差别）**：pilot 没有用 `./react` 的 `useLiveQuery`，而是把集合的行读成控制器快照（`collection.subscribeChanges()` / `status:change` → `credentialRows`），页面用 `useSyncExternalStore` 订阅它（`packages/ai-connections/src/collections.ts` 的 `useCredentialRows()`）。原因与实测见 §9-9：整表读不需要派生查询，而懒加载的 hook 会把整个有状态面板重挂一次；这正是 §7.4-4 / §8.7-5 写下的体积出口。`./react` 入口保留给将来需要派生查询的消费方。

### 6.6 被替换掉的旧机制（一处入口，不留副本）

| 现网机制 | 位置 | 去向 |
|---|---|---|
| `credentialsTableDocument()` / `providerTableDocument()`（手写 topic） | `ui/src/extensions/XpodAiConnectionsPodStore.ts:84`、`:92` | 规则移入 §2.3 的 topic 推导 |
| `TABLE_CHANGE_COALESCE_MS`、`scheduleLiveRefresh()`、`liveRevision`、`watchPageTables()` | `packages/ai-connections/src/controller.tsx:70`、`:157`、`:237` | 合并与订阅移入集合层；页面的 `useEffect([liveRevision])` 整表重读删除 |
| `listProviders()` 的三连整表 `select()` | `packages/ai-connections/src/controller.tsx:299`、`ui/src/extensions/XpodAiConnectionsPodStore.ts:108-123` | 首读由集合的 `sync` 完成 |

删除条件：新路径在真实实例上验收通过（§8.6），且旧路径不再是任何页面的唯一读法。

## 7. 依赖决策（D1：已定）

### 7.1 决策

**装**：`packages/pod-collections` 的 `dependencies` 含 `@tanstack/db` 与 `@tanstack/react-db`（后者只被 `./react` 入口引用）。**接口是我们自己的**：`definePodCollection` 返回收窄的 `PodCollection<R>`，live query、乐观覆盖层、事务生命周期交给库。**不手写模仿该 API 的内核**（用户已否决，理由见 §7.4）。（P3 实测后的落点见 §9-9：凭据列表用的是引擎 + `PodCollection` 自身的变更流，`./react` 入口保留、但不在前端入口图里 —— 这就是 §7.4-4 预写的那条出口。）

React 依赖的放法：`react` 仍是 `peerDependencies: ^19.2.0`（与 `packages/*` 其余包一致：`packages/solid-sdk/package.json`、`extension-sdk`、`shared-ui`、`ai-connections` 全部如此）；`@tanstack/react-db` 作为 `dependencies` 而不是 peer —— 它是一个薄适配层（registry 实测 `unpackedSize ≈ 304 735 B`），且**硬依赖 `@tanstack/db@0.9.0`**，作为依赖可以让两者天然同版本，避免消费方各自装出两个 db 版本。

### 7.2 版本锁定与升级策略

- **锁定**：`@tanstack/db@0.9.0`、`@tanstack/react-db@0.3.8`（npm registry 实测；react-db 0.3.8 依赖 `@tanstack/db@0.9.0`，成对）。
- **写法**：在 `packages/pod-collections/package.json` 用**精确版本、不带 `^`**，与仓库对数据层依赖的既有做法一致（`ui/package.json` 与 root 都是 `@undefineds.co/models@0.2.56`、`@undefineds.co/drizzle-solid@0.3.24`）。`bun.lock` 是唯一版本事实来源；设计阶段**不安装**（本次任务不改依赖）。
- **升级策略**：① 只接受 `@tanstack/db` + `@tanstack/react-db` **成对升级**，同一个 PR；② 升级 PR 必须附 §7.6 复验清单的逐条勾选 + 体积复测；③ 不使用 `latest` 或 `^`；④ 复验发现破坏性变更时，**退回上一对锁定版本**而不是就地适配——避免把上游 API 漂移带进本仓库；⑤ 上游 0.x 阶段不追新，只在下游需要某个能力时升级。

### 7.3 理由

1. **生态集成原则**（AGENTS.md「生态集成原则」：通用基础设施优先复用成熟生态，Xpod 提供兼容 API / Backend / Adapter，而不是重写对方内核）。乐观覆盖层 + 回滚 + 按 key 的响应式查询正是通用基础设施。
2. **手写这部分正是现网复杂度的来源**：为绕开乐观层，现网维护了 `providerLoadGeneration`（`packages/ai-connections/src/controller.tsx:143`）这类手工陈旧性守卫、`oauthCredentialSaves` WeakMap 串行化（`ui/src/extensions/XpodAiConnectionsPodStore.ts:41`）、以及「不能闪 loading」的手工注释（`AiGatewayKeysSection.tsx:122-124`）——都是在手工做库该做的事。
3. **自研的真实成本在库那半边**：按 key 的增量订阅、乐观覆盖层、回滚、事务状态机；而本期真正的差异化（topic 推导、RDF 映射、条件重读、ETag 跳过）与库无关，装不装都要写。
4. **迁移成本被接口吸收**：applet 只依赖 `PodCollection` 与少数几个方法；换引擎或退回自研，改动面锁在包内。

### 7.4 被否决的替代方案：只对齐 API、不装依赖

该方案（自己实现同名 API 的薄内核）被否决，理由：

1. **等于重写对方内核**，直接违反 AGENTS.md「生态集成原则」与本次决策 D1；
2. **省下的不是难点**：真正难的是乐观覆盖层与按 key 的增量订阅（自回声、回滚、冲突、身份稳定），而这正是要复用库的部分；
3. **会长期维护一个 API 兼容层**：为了「以后能换成真库」而保持签名一致，等于把两者的差异变成永久的适配负担；
4. **唯一的实际顾虑（体积/版本）已经有更小代价的出口**：只用 `@tanstack/db` 引擎、不用 `react-db` 的 hook（`useSyncExternalStore` 手接），或按 §7.2-④ 退回锁定版本。

### 7.5 风险（逐条，含缓解）

| 风险 | 事实 / 证据 | 缓解 |
|---|---|---|
| **版本 churn** | 读到的 API 文档是 0.6.7（frontmatter `library_version: '0.6.0'`），npm 最新已是 **0.9.0**；`@tanstack/react-db` 最新 **0.3.8**，硬依赖 `@tanstack/db@0.9.0` | §7.2 的锁定与升级策略；`bun.lock` 锁精确版本 |
| **包体积** | `@tanstack/db@0.9.0` 的 npm 元数据 `unpackedSize ≈ 7 280 156 B`（含类型与多格式产物，**不等于**打进前端的字节数）；运行时依赖 `@tanstack/db-ivm`、`@tanstack/pacer-lite`、`@standard-schema/spec`；`@tanstack/react-db@0.3.8` `unpackedSize ≈ 304 735 B`，另依赖 `use-sync-external-store` | 依赖只进 `pod-collections`，不进 `shared-ui`；引入时量一次真实 gzip 体积（**未验证项**）；必要时只用引擎不用 hook |
| **服务端误用** | `@tanstack/react-db` 的 peer 是 react `>=16.8.0` | 主入口不导出 React；守卫测试断言 `pod-collections` 主入口在无 `window`/`document` 的 node 环境可 import（§8.5） |
| **乐观语义仍要我们实现** | 文档把「handler 不得在同步回来之前 resolve」定为**调用方**义务 | §4.2 的确认协议是我们的代码，必须独立单测；不要以为装了库就自动正确 |
| **`write` 的 per-message metadata 支持面** | skill 文档只明确「insert 时从 `message.metadata` 设置 row metadata」 | 统一用 `metadata.row.set()` 显式写入，不依赖 message metadata（**待复验**） |
| **文档与最新版的 API 漂移** | 0.6.7 文档 vs 0.9.0 包 | 见 §7.6 |

### 7.6 实现前复验清单（针对锁定版本逐条打勾）

1. `createCollection` 的 config 字段（`getKey` / `sync` / `onInsert` / `onUpdate` / `onDelete` / `rowUpdateMode`）是否与 0.6.7 文档一致；
2. `sync.sync(...)` 返回清理函数、`markReady()` 的必要性、`truncate()` 对 **row metadata** 的确切行为；
3. `write({ type: 'update', key, value })` 在 `rowUpdateMode: 'full'` 下是否整行替换；
4. `metadata.row` / `metadata.collection` 的持久化语义（本设计的 ETag 跳过**依赖它在会话内有效**）；
5. `useLiveQuery` 的真实调用签名（本文按 0.6.7 文档写作）；
6. `@tanstack/react-db` 是否必需（若 `@tanstack/db` 自带可用订阅原语，可少一个依赖）。

## 8. 分期与第一期实现计划

### 8.1 分期总览（含每期门禁）

| 期 | 交付 | 前置 | 出口门禁（Gate） |
|---|---|---|---|
| **P1** | `packages/pod-collections` 骨架 + 同步算法（订阅优先/缓冲/`markReady()`/条件重读/diff 增量），只读消费；**先做 §8.7-2 的读原语验证** | models 现有 descriptor（**凭据表**）+ 传输原语 | §8.5 的同步/映射/守卫三类单测全绿；`bun run build:ts`；`bun run test:packages` |
| **P2** | mutation 层（insert/update/delete → drizzle-solid）+ §4.2 确认协议 + `array+uri` PATCH 单一入口 + 回滚与冲突标记 | P1 | 乐观/回滚/自回声/冲突单测全绿；`bun run test:integration` |
| **P3** | **凭据列表**页面改用集合，删掉该页的 `liveRevision` 整表重读 | P2 | §8.5 守卫测试；§8.6 真实实例验收；页面无回归（现网 `packages/ai-connections` 测试集 + `bunx playwright test tests/e2e/xpod-settings.spec.ts`） |
| **P4** | provider / 模型表接入（需 models 补 descriptor，§2.6）；跨文档 scope | models 发版 | 同 P1–P3 的门禁，加「文档切换时不残留旧文档订阅」的断言 |
| **P5**（可选） | `loadSubset` 谓词下推（`parseLoadSubsetOptions` / `extractSimpleComparisons` / `parseOrderByExpression`），只在表大到需要按需加载时做 | P4 | 按需加载不产生整表读：读量与子集大小同阶 |

**先落地什么**：P1 + P3 的最小闭环 = **凭据表一张表 + 凭据列表一个页面**。它同时验证「零手写 topic」和「信号驱动的增量」。

**为什么 pilot 不是 API KEYS 页（`AiGatewayKeysSection`）**：那张表是 `gatewayAccessKeyDescriptor`（`base = '/.data/'` + `{id}`，**一行一文档**），topic 语义是容器订阅，不在本期范围（§1.2）。

### 8.2 P1 文件清单（`packages/pod-collections`）

```
packages/pod-collections/
├── package.json            新建（§8.3）
├── tsconfig.json           新建，抄 packages/solid-sdk/tsconfig.json
├── README.md               两段：定位（通用 Pod 表集合 adapter）+ 边界（不做 schema 副本，N2）
├── src/
│   ├── index.ts            公开入口：definePodCollection + 全部类型；**不引 React**
│   ├── types.ts            ValueOf / RowOf、PodCollection、PodRowConflict、PodDocumentFeed、PodCollectionOptions
│   ├── layout.ts           topic 推导（§2.3 三行规则）+ 行 IRI ↔ 键（resourceIdPattern 的 {id}）
│   ├── mapping.ts          主语批 → 行、值 ↔ term：只读 descriptor.fields（§2.4），含 class 过滤
│   ├── read.ts             唯一的读原语：conditionalDocumentRead(document, { ifNoneMatch }) → { etag, subjects }；
│   │                       取不到 ETag 时返回 etag: undefined（不假装有，§8.7-2）
│   ├── diff.ts             投影哈希 + insert/update/delete 三向 diff（§3.2）
│   ├── sync.ts             TanStack sync 实现：watch → buffer → 首读 → markReady → 合并窗口 → 条件重读 → begin/write/commit
│   ├── mutations.ts        onInsert/onUpdate/onDelete 映射（§4.1）+ writeField() 的 array+uri PATCH 单一入口 + §4.2 确认协议
│   └── feed.ts             PodDocumentFeed 端口 + 无 feed 时的降级（只允许显式 refresh()，不装定时器，N1）
├── src/react.ts            ./react 入口：usePodCollection + useLiveQuery 再导出；@tanstack/react-db 只在这里 import
└── test/
    ├── helpers/fakeFeed.ts       可手动投递脏信号的假 feed
    ├── helpers/fakeDocument.ts   可编程文档（ETag + 主语 + 304/404/403 注入）
    ├── helpers/fakeDatabase.ts   记录调用的假 drizzle-solid database
    ├── layout.test.ts            §2.3 三种形状 + §2.7 的键取法
    ├── mapping.test.ts           §2.4 往返（array / URL 字符串 / timestamp / class 过滤）
    ├── sync.test.ts              §3：先订阅后读、缓冲重放、markReady、304 → 0 write、burst → 1 read
    ├── mutations.test.ts         §4：确认协议、回滚、自回声 0 行写入、外部冲突
    └── guards.test.ts            ① 字段漂移守卫（§2.7）② node 环境 import 主入口 ③ 源码无 setInterval
```

### 8.3 依赖与构建编辑清单（精确到文件）

| 文件 | 编辑 | 理由 |
|---|---|---|
| `packages/pod-collections/package.json` | **新建**：`name: @undefineds.co/pod-collections`、`private: false`、`type: module`、`sideEffects: false`、`exports: { ".": …, "./react": … }`、`files: ["dist","README.md"]`、`scripts.build` / `scripts.test` 抄 `packages/solid-sdk/package.json` | §6.2 |
| 同上 `dependencies` | `@undefineds.co/models: 0.2.56`、`@undefineds.co/drizzle-solid: 0.3.24`（精确，与 `ui/package.json` 对齐）、`@tanstack/db: 0.9.0`、`@tanstack/react-db: 0.3.8` | D1 + §7.2 |
| 同上 `peerDependencies` | `react: ^19.2.0`（与其余 `packages/*` 一致） | §7.1 |
| `packages/pod-collections/tsconfig.json` | **新建**，抄 `packages/solid-sdk/tsconfig.json` | §6.2 |
| root `package.json` → `build:packages` | 在 `@undefineds.co/extension-sdk` **之前**插入 `bun run --filter '@undefineds.co/pod-collections' build` | extension-sdk 将 `import type` 它，必须先构建 |
| `packages/extension-sdk/package.json` | `dependencies` 加 `"@undefineds.co/pod-collections": "workspace:*"` | 只为 `web.ts` 的能力类型（`import type`） |
| `packages/extension-sdk/src/manifest.ts` | `HOST_CAPABILITY_NAMES` 加 `'podCollections'` | §6.4-1 |
| `packages/extension-sdk/src/web.ts` | `WebExtensionHostCapabilities` 加 `podCollections?: PodCollectionsCapability` | §6.4-2 |
| `ui/package.json` | `dependencies` 加 `"@undefineds.co/pod-collections": "workspace:*"` | 宿主实现要 import |
| `packages/ai-connections/package.json` | `dependencies` 加 `"@undefineds.co/pod-collections": "workspace:*"` | 页面用 `./react` 入口 |
| `packages/ai-connections/src/manifest.ts` | `hostCapabilities` 加 `'podCollections'` | §6.4-5 |
| root `vitest.packages.config.mts` | **不改** | `test:packages` 是 `bun run --filter './packages/*' test`，新包自带 `test` 脚本即可 |
| root `bun.lock` | 由 `bun install` 更新 | 唯一版本事实来源（§7.2） |

### 8.4 宿主与 applet 接线（P1–P3）

1. **宿主能力**：新增 `ui/src/extensions/pod-collections-host.ts` —— `createPodCollectionsCapability({ database, podUrl, feed })`；`feed` 就是 `createSolidNotificationsCapability(...)` 的返回值（结构满足 `PodDocumentFeed`）。在 `ui/src/extensions/ai-connections-host.ts` 的 `capabilities` 段注入（现网同段已有 `solidNotifications` 与 `aiConnectionsPodStore`）。**P3 跟进后**：注入的是按需加载的前端 `ui/src/extensions/pod-collections-lazy-host.ts`（§9-9），它在第一次 `load()` 时动态 import 上面那个实现；实现模块仍由 `pod-collections-host.test.ts` 直接驱动，前端有自己的 `pod-collections-lazy-host.test.ts`。
2. **applet 侧集合声明**：`packages/ai-connections/src/collections.ts`（新）—— 从 host 能力 `define` 出 `credentials`（§2.5），作为唯一的表声明点；页面不得各自 `define`。**P3 跟进后拆成两个文件**（§9-9）：`collections.ts` 只留行类型与纯函数（`CredentialRow`、摘要投影、`credentialCarriers()` / `withLiveCredentials()`、`useCredentialRows()`），声明/读/写这些需要引擎的部分在 `collection-runtime.ts`，由 `credentialCollectionRuntime()` 动态 import 一次。
3. **pilot 页面**：`packages/ai-connections/src/AiCredentialPoolSection.tsx` / `AiCredentialRow.tsx` 改为从 `collections.credentials` 读行（`useLiveQuery`），凭据的写入动作（enable/priority/delete）改走集合的 mutation 方法。
4. **暂时保留**：`providerSummaries` 的 provider / 模型部分仍走 `controller.loadProviders()` 到 P4；`AiConnectionsMain.tsx:50` 的 `useEffect([liveRevision])` 收窄为「只刷模型」（P4 删除）。
5. **删除**：该页对凭据的整表重读路径（§6.6 表格的三行），删除条件 = §8.6 验收通过。

### 8.5 测试策略

| 层 | 手段 | 参照 |
|---|---|---|
| 单元：同步算法 | 假 feed（可手动投递脏信号）+ 假 database（可编程返回 ETag 与行）；断言：先订阅后读、读期间缓冲并被重放、`markReady()` 被调用、304 时 **0 次 write**、突发 B 次 → **1 次读** | 现网形态 `ui/src/extensions/solid-notifications.test.ts`（假 socket 驱动真 transport） |
| 单元：映射 | descriptor 字段 ↔ RDF term ↔ 行的往返，覆盖 `array: true`、`string` 但值是 URL、`timestamp`、`class` 过滤 | §2.4 |
| 单元：乐观 | handler resolve 前集合里已是服务端值；抛错 → 回滚到写前；自回声 → **0 次行写入**且无状态抖动；外部冲突 → server wins + `conflicts` 有记录 + 事务 `failed` | §4 |
| 单元：守卫（N1/N2/D3） | ① `RowOf<D>` 暴露的字段在 descriptor 与 drizzle 表两边都能找到（抓 §2.7 的漂移）；② 主入口在无 `window`/`document` 的 node 环境可 import；③ 主入口源码不出现 `setInterval`（合并窗口用一次性 `setTimeout`，与传输层守卫同款）；④ 包内不出现表清单/布局常量（只允许出现 descriptor 的读取） | §1.5、§2.7、§7.5 |
| 集成 | `bun run test:integration`（真 CSS + 通知子系统） | AGENTS.md「必须执行的回归检查」 |
| 真实实例 | 见 §8.6 | `tests/e2e/subscribe-verification.spec.ts`（现成的同款脚本） |
| 表述边界 | 隔离栈 / Vitest / 临时端口通过，**不得**表述为真实实例通过；报告按「运行时 / 身份 / Pod 读写 / …」分项 | [`cli-dev-testing.md`](cli-dev-testing.md) §真实 Xpod 集成验收 |

### 8.6 真实实例验收路径（P3 的出口）

1. `bun run build:packages && bun run build:ui`；
2. 启动并确认当前实例（`bun run dev` → `http://localhost:3000`），记录实际 Gateway URL，用 `/service/status` 确认 Gateway / CSS / API 同源；
3. seed 账号登录，打开 AI Connections 的凭据列表，确认订阅已建立（CSS 日志出现 `Accepted WebSocket connection…`，页面状态为 live）；
4. 在**第二个上下文**写同一文档（另一浏览器上下文，或对同一 `settings/credentials.ttl` 发认证 PATCH）；
5. 断言第一页**不做整表重读**就更新了该行（计量本次写入引起的读次数：应为 1 次条件读），且没有新增 socket；
6. 断言**无轮询**：静置 60s 内该页对该文档的读次数为 0（N1 的现场证据）；
7. **反向验收**：绕过 store 直接改 `.ttl` 文件必须**不产生通知**——确认我们依赖的是 store 通道而不是文件（结论见 [`ai-connections-storage-model.md`](ai-connections-storage-model.md) §11）。

### 8.7 什么会证伪本设计

1. **`metadata` 在同一会话内不可靠**：若条件重读拿不到上次的 ETag，「ETag 跳过」失效（每次脏信号都全量 diff），本设计的主要收益消失。
2. ~~**条件读当前不可用**~~ **已证实（P1）**：`select().from().execute()` 只返回行，类型上没有任何 ETag 载体（`node_modules/@undefineds.co/drizzle-solid/dist/core/pod-database.d.ts` 的 `QueryResourceHelper`）。P1 的第一件事就是验证 §3.2 的读原语扩展是否可行，结论是**不可行且不需要**：
   - 读并不落在文档上：`credentialResource` 声明 `sparqlEndpoint: '/settings/-/sparql'`，`SparqlStrategy.executeSelect()` 把查询发给该 endpoint，且生成的查询没有 `GRAPH`/`FROM` 子句，整个读期间**文档本身没有被请求**——即便能拿到文档 ETag，它也不是这次读的 validator（证据与请求记录见 `packages/pod-collections/src/read.ts` 文件头与 `.test-data/etag-probe/probe.ts`）。
   - 实现面上只有写路径读 ETag（`core/sparql-executor.js` 的 `executeUpdate()` 两处 `headers.get('ETag')`，用于 PATCH 的 `If-Match`），从不返回给调用方。
   - 唯一的 ETag 来源是绕过读 API（`getDialect().config.session.fetch` → HEAD/条件 GET），属于 drizzle-solid 内部接线，与「条件**读**」不是同一个资源，因此本层不依赖它。
   出口即 §8.7-2 预先写下的降级：`read.ts` 恒返回 `etag: undefined`，每个合并窗口全量读 + 投影 diff，只写真正变化的行，**零轮询**（N1 不变）；`metadata.collection` 不写任何伪造的 ETag。
3. **`rowUpdateMode` 的 partial/full 语义与整行 diff 不兼容**，或 per-message metadata 不可用。
4. **真实实例上通知延迟远大于合并窗口**（例如自回声在数百毫秒后才到），页面出现「先乐观、再回退、再前进」的抖动。
5. **包体积**：若打进前端的真实 gzip 体积不可接受，按 §7.4-④ 只用引擎不用 hook，或退回上一对锁定版本；此时 §2/§3/§4 仍然成立，只有实现方式变化。

### 8.8 通知覆盖边界（写入路径 ↔ 脏信号）

集合层的脏信号来自 CSS 通知通道（`ListeningActivityHandler` + WebSocketChannel2023，§8.4-1）。这条通道的上游只有一个：`MonitoringStore` 在 `ResourceStore` 链上发出的 `changed` 活动。因此「哪条写入路径会通知」完全由「谁经过 store 链」决定：

| 写入路径 | 是否通知 | 说明 |
|---|---|---|
| LDP 写入（`PUT`/`PATCH`/`DELETE`/`POST`） | ✅ | 经过 `ResourceStore` 链，`MonitoringStore.emitChanged` 按资源发出 `as:Create`/`as:Update`/`as:Delete`（容器成员变化另发 `as:Add`/`as:Remove`） |
| `PATCH` 带 `application/sparql-update` | ✅ | `SparqlUpdateResourceStore.modifyResource` 在 store 层返回 `as:Update` change，仍走同一条通道 |
| **`/-/sparql` sidecar 写入**（drizzle-solid、app、脚本实际走的入口） | ✅（本次补齐） | 此前 `SubgraphSparqlHttpHandler` 直接调 `updateAuthority.executeSparqlUpdate`，绕过 store 链、不发任何活动；现改为写入成功后按「受影响的文档」各发一次与 store 写入同形的活动 |
| 直接改磁盘上的 `.ttl` 文件 | ❌ | 绕过 store 与 sidecar，无任何 store 活动（§8.6-7 的反向验收结论不变） |
| Cloud 的 `ObservableResourceStore` / 设备通知 / 派生索引 outbox | ❌（另一条通道） | 它是 store 链上的独立包装，sidecar 写入不经过它；需要设备通知或派生索引覆盖 `.sparql` 写入时，得另行把活动接进该通道 |

`.sparql` 写入的活动映射（每个受影响文档恰好一次，按操作取最接近的 ActivityStream 术语）：

| SPARQL 操作 | 活动 |
|---|---|
| `INSERT DATA` / `INSERT … WHERE` / `LOAD` / `ADD` / `COPY`（目标图） | 文档原本不存在 → `as:Create`；已存在 → `as:Update` |
| `DELETE DATA` / `DELETE WHERE` / `INSERT … DELETE … WHERE` | `as:Update`（部分删除，文档本身仍在） |
| `CLEAR GRAPH` / `DROP GRAPH` / `MOVE` 的源图 | `as:Update`（**裁定**：`MixDataAccessor` 把图重写成**空文档**而非删除资源，重读是 200 空体不是 404，其可观察结果等同"`DELETE DATA` 删光所有三元组"，而后者映射为 `as:Update`；`as:Delete` 因此**刻意不用**，只有等某个 accessor 真的删除文档时才成立） |
| 删除类操作指向不存在的文档、`CREATE` 指向已存在的图、空 `LOAD`、写入失败 | 不发（SPARQL 意义上的 no-op） |

两条需知边界：① 粒度是**文档**而非三元组——`DELETE DATA` 里没有任何一条命中时仍会发一次 `as:Update`；② `.sparql` 写入不更新父容器的 containment，因此不会发容器的 `as:Add`/`as:Remove`，订阅容器 topic 收不到子文档写入（订阅文档 topic 才收得到）。通道侧 `ActivityNotificationGenerator` 会重新读 store 计算 `state`（ETag），而 `ui/src/extensions/solid-notifications.ts` 的订阅请求不带 `state`，所以脏信号不依赖 ETag 是否变化。

## 8.9 P1 实现记录（实测偏差，与设计不一致处以本节为准）

P1 把 §8.2 的文件清单落成了 `packages/pod-collections`（`src/` 各文件与设计同名：`index` / `types` / `layout` / `mapping` / `read` / `diff` / `sync` / `mutations` / `feed` / `react`）。以下是**对锁定版本 `@tanstack/db@0.9.0` 逐条复验**（§7.6）后与设计不同的地方，每条都有测试或源码位置：

| # | 设计原文 | 实测结论（落地形态） |
|---|---|---|
| 1 | §3.2 伪代码：`commit()` 之后再写 `metadata.row` | **必须在事务打开期间调用**：`dist/esm/collection/sync.js:272-280` 的 `getActivePendingSyncTransaction()` 在没有未提交事务时抛 `NoPendingSyncTransactionWriteError`。实现改为 `write → metadata.row.set → commit`（`src/sync.ts:203-223`） |
| 2 | §3.2 伪代码：`begin()` + `await commit()` | **sync 事务一律 `begin({ immediate: true })`**：`commit()` 返回 `true \| Promise<void>`，存在 persisting 的用户事务时普通 sync 事务会被排队（`dist/esm/collection/state.js:593` 的 `!hasPersistingTransaction \|\| …`），等收据就会挂住——自回声（§4.4）与确认协议（§4.2）都永远等不到应用。`immediate` 正是库为「需要立刻写入 `syncedData`」提供的开关 |
| 3 | §3.2：`delete` 带 `value`；§4.1：`update` 的落盘 | `0.9.0` 的 `ChangeMessageOrDeleteKeyMessage` 联合类型不允许 delete 携带 value（运行时允许且不使用），实现里做了一次局部类型放宽（`src/sync.ts:211-217`）；`update` 写的是**整行投影**（`rowUpdateMode: 'full'`，§3.2 的 diff 产物表达不了「谓词被移除」） |
| 4 | §2.2 声明接口的写入负载类型 | `PodCollection.insert` 取 **`Partial<R> & { id: string }`**，而不是 `RowOf<D>`：`secret: true` 字段不从行里投影出去（§2.1），行类型拿不到这些字段，而写入必须能提供它们。缺的字段由 drizzle-solid 的列默认值补齐；确认协议按「意图里**可读**的字段」逐字段比对（只写字段的规则见 §9-7） |
| 5 | §2.1 `ValueOf`：类型未收窄时 `: string` 兜底 | 改为**返回 `unknown`**：`@undefineds.co/models@0.2.56` 把 descriptor 声明成 `PodModelDescriptor`（`fields: Record<string, PodModelFieldDescriptor>`），字段字面量类型没有随包导出，所以官方 descriptor 的 `{ type: … }` 是**联合类型**；沿用 `: string` 兜底会把运行时的 `Date`（`expiresAt`）标成 `string`——类型说谎。字面量 descriptor（测试）仍得到 §2.1 的精确类型。要恢复官方 descriptor 的逐字段精度：models 侧给 `PodModelDescriptor<F>` 泛型参数，或导出字段字面量类型 |
| 6 | §8.5 的测试清单 | 测试抓到两个真实缺陷（已修）：① **模板 → 正则的转义顺序**——「先整体转义再替换变量」会把变量前的转义反斜杠留在原处、生成非法正则，必须**先切字面量再转义**（`compileRowKeyPattern()`，`src/layout.ts:218-237`）；② **`running` 清得太晚**——挂在返回 promise 的 `.finally()` 上要等一个额外微任务，那段时间里调用方拿到的是已完成的旧 promise，于是**首读失败后紧接着 `refresh()` 什么也没做**，必须在循环结束的内层 `finally` 同步清掉（`src/sync.ts:141-158`） |

**本轮（P3 页面部分）落地形态**：宿主能力 `podCollections`（`packages/extension-sdk/src/web.ts` 的类型、`ui/src/extensions/pod-collections-host.ts` 的实现）把 applet 的表声明接到 Pod 数据库与 §8.8 的通知原语上；凭据表在 `packages/ai-connections/src/collections.ts` 里**声明一次**，凭据列表页由集合的变更流行读（控制器快照 + `useSyncExternalStore`，P3 跟进后取代了 `usePodCollection`，见 §6.5 与 §9-9）、由集合的 `insert/update/delete` 写。表归属因此收敛为：

| 文档 | 刷新路径（本轮之后） |
|---|---|
| `settings/credentials.ttl` | **集合的 sync 引擎**（宿主有 `podCollections` 时）；宿主没有该能力时退回控制器的 `liveRevision` 观察 |
| `settings/providers/<provider>.ttl`（含模型行） | 仍是控制器的 `liveRevision` 观察（P4 迁移） |

§8.4-5 的「删除条件 = §8.6 验收通过」不变；本轮**已经**删掉的是凭据表在控制器里的那份观察（`pageTableDocuments()` 在集合存在时不再纳入凭据文档），**尚未删**的是 `podStore.credentialsTableDocument()` 本身、`AiConnectionsPanel` 的凭据整表重读（`listProviders()` 仍带凭据）与 `liveRevision`（后者要等 provider/模型表也迁到集合）。

**本轮（P3 跟进）落地形态**：§9-7 的冻结层缺陷修复 + §9-9 的按需加载（集合层不再落在 ModelsPage chunk）。三条结论，逐条带证据：

1. **确认只承诺读得回来的东西**（§9-7 已修复）。`diff.projectionCovers(row, intent, writeOnly)` 只比对意图里**可读**的键：`@id`、`undefined` 与 `secret: true` 字段都不参与；`mapping.writeOnlyFields()` 是「哪些字段只写」的唯一来源，`mapSubjectRows()` 的投影与确认协议同源，不存在第二份判断。只写字段的证据是**写入调用本身成功**（`mutations.createMutationHandlers()` 只在 drizzle-solid 的 insert/updateById 或 `array+uri` 的 PATCH resolve 之后才进入 `confirm()`），不是「把 secret 读了回来」；集合行始终是投影行，行里不会凭空出现 secret。可读字段的比对一字未松：意图里任何非 secret 字段（包括 §2.7 里声明了、但没有承载列因而读不回来的字段）在服务端行里对不上，仍然 `write_conflict`。测试见 `packages/pod-collections/test/mutations.test.ts` 的 `pod collection write confirmation and write-only fields` 与 `pod collection inserts that carry write-only fields`（带 secret 的插入确认且不回滚 / 只有 secret 的意图同样确认 / 可读字段读不回仍然冲突）。
2. **P2 的规避保留，但理由换成了归属**。`packages/ai-connections` 仍然分两笔写：集合写 descriptor 声明的普通列，store 在同一个 user action 里补 secret 与未声明列。这不是因为确认协议不支持带 secret 的意图（现在支持了）：`encryptedSecret` 的信封由 store 的加密路径生成（`XpodAiConnectionsPodStore.createApiKeyCredential` → `plaintextEnvelope`），而 `offeringId` / `metadata` / `baseUrl` / `proxyUrl` 是 descriptor **没有**声明的表列（§2.7、§9-8），集合的插入负载里根本没有这些字段，也构造不出信封。把 secret 塞进集合意图只会让落进 Pod 的内容变成页面自己拼的信封（或明文），与 store 现在写的不一致 —— 删除条件因此不是「§9-7 修复」，而是 §9-8 的 models 侧排期（descriptor 声明这些列）加上「加密归 store」这条归属不变量。代码里的说明：`packages/ai-connections/src/collection-runtime.ts` 的 `newCredentialRow`。
3. **集合层改成按需加载，实测见 §9-9**（`cd ui && BUILD_TARGET=settings bunx vite build`；同一工作区里另有未提交改动在并行编辑 applet，受影响的是 ModelsPage / settings 两个 chunk，集合层的 `pod-collections-host-*.js` 在两次实测里逐字节相同）：

| chunk | 改前 | 改后 | 说明 |
|---|---|---|---|
| `ModelsPage-*.js` | 588,436 B / 206.94 kB gzip | **292,609 B / 122.52 kB gzip** | 挂 applet 的路由 chunk；无集合时的基线是 286,459 B / 120.59 kB gzip（即回到基线 +6,150 B / +1.93 kB gzip） |
| `pod-collections-host-*.js` | — | 128,643 B / 35.49 kB gzip | 新：宿主能力实现 + `@tanstack/db`，只有走到凭据列表路径才取 |
| `collection-runtime-*.js` | — | 2,878 B / 1.17 kB gzip | 新：applet 侧的集合读写（动态 import 一次） |
| `layout-*.js` | — | 3,055 B / 1.30 kB gzip | 新：`pod-collections` 的布局模块（上面两个共享） |
| `ai-connections-*.js` | 29,334 B / 8.51 kB gzip | 29,334 B / 8.51 kB gzip（逐字节相同） | applet 本体 |
| `settings-*.js`（共享） | 1,944.17 kB / 520.30 kB gzip | 1,945.75 kB / 520.68 kB gzip | 懒加载接线 + 并行工作区的其他改动 |

`@tanstack/react-db` 已不在 settings 产物里（`grep -rl "useLiveQuery\|liveQueryCollection" static/settings/assets` 为空），`@tanstack/db` 只出现在 `pod-collections-host` chunk（`grep -rl tanstack static/settings/assets` 只命中它）；ModelsPage chunk 对这两个新 chunk 只有 `import()`、没有静态 import，所以初始（非 live）加载只比无集合时多 6,150 B / 1.93 kB gzip。`static/settings/**` 是跟踪的构建产物，本轮构建顺带再生成了它的 chunk 文件名。

## 9. 尚未决 / 待验证

| # | 项 | 性质 | 建议 / 处理 |
|---|---|---|---|
| 1 | **models 缺 provider / 模型 descriptor**（§2.6，已核实） | models 侧排期，不是设计分歧 | 按 AGENTS.md 与 D3 由 models 补 `aiProviderDescriptor` / `aiModelDescriptor` 并发版；P1–P3 不阻塞，P4 等它 |
| 2 | **`uniqueBy` 引用了不存在的列，且不唯一**（§2.7 事实 1） | models 侧数据/声明缺陷 | 本设计取行标识作 `getKey`（§2.7），`uniqueBy` 只作业务键；同时在 models 立 issue：把 `uniqueBy` 修到真实列上，或拆成 `rowKey` / `naturalKey` |
| 3 | **冲突呈现强度**（§4.5） | 产品取舍 | 先用「server wins + 行标记 + 事务失败」；出现真实多设备并发场景再考虑更重的交互 |
| 4 | **`array + uri` 的 PATCH 绕过何时能删**（§4.1） | 取决于 drizzle-solid 修复 | 保留单一入口 `writeField()` + 「绕过入口只有一个」的守卫测试；删除条件沿用 [`drizzle-solid-link-array-update-todo.md`](drizzle-solid-link-array-update-todo.md) |
| 5 | **新包首发是否对外发布、首发版本号** | 发布排期 | 先只走仓库内 `workspace:*`；P3 验收通过后再决定是否纳入 `scripts/publish-package.cjs`（注意它**拒绝发布 RC 版本**，首发须为非 RC） |
| 6 | **条件读能否拿到文档 ETag**（§8.7-2） | **已验证：拿不到，且不是本次读的 validator** | P1 结论与证据见 §8.7-2 的修订条目：`read.ts` 恒返回 `etag: undefined`，按出口降级为「每个合并窗口全量读 + 投影 diff」，仍不引入轮询（N1）。不再作为待验证项 |
| 7 | **写意图带 `secret: true` 字段时确认协议永远不成立**（P2/P3 落地时发现） | **已修复**（冻结层，改了 `packages/pod-collections/src/**`） | 缺陷原形：`reconcilePendingWrites()` 用 `projectionCovers(server, intent)` 判定确认，而 `server` 是**投影行**（`mapSubjectRows()` 按 §2.1 跳过 `secret: true` 字段），`intent` 却是调用方给的整行 —— 插入带 `encryptedSecret` 的行时 `server.encryptedSecret === undefined` → 不覆盖 → 紧接着 `hashOf(server) !== beforeHash(undefined)` → 误判 `write_conflict`，于是 `insert` 的 `Partial<R> & { id: string }` 签名对 secret 字段是句谎话。**选定的规则：确认只承诺读得回来的东西** —— 覆盖判定只在**投影意图键**上进行（`@id`、`undefined`、`secret: true` 字段都不参与比对）；`mapping.writeOnlyFields()` 是「哪些字段只写」的唯一来源（`mapSubjectRows()` 的投影与确认协议同源）；只写字段的证据是**写入调用本身成功**（`mutations.createMutationHandlers()` 只在 insert/updateById 或 `array+uri` 的 PATCH resolve 之后才进入 `confirm()`，写调用抛错会直接回滚、根本走不到确认），集合行始终是投影行 —— **不假装把 secret 读了回来，也不拿「读不到」当冲突**。**为什么不选「让 insert 的意图显式排除 secret 字段」**：那会把「哪些字段可写」压进调用方，`Partial<R>` 里能给的字段却写不进去，等于把缺陷挪到签名上；而且 update 的意图来自 TanStack 的 `modified` 整行，本来就不由我们收窄。**可读字段的守卫没有被削弱**：意图里任何非 secret 字段（包括 §2.7 里声明了但没有承载列、因而读不回来的字段）在服务端行里对不上，仍然 `write_conflict`（`test/mutations.test.ts` 的两条直接用例 + 一条集合级用例锁定）。测试：`packages/pod-collections/test/mutations.test.ts` 的 `pod collection write confirmation and write-only fields`（规则本身）与 `pod collection inserts that carry write-only fields`（带 secret 的插入确认且不回滚 / 只有 secret 的意图同样确认 / 可读字段读不回仍然冲突） |
| 8 | **`offeringId` / `metadata` / `baseUrl` / `proxyUrl` 不可投影**（models 漂移，§2.7） | models 侧排期 | 集合只能读写 descriptor 声明的列。当前读用宿主 store 的同 id 摘要补全（`credentialCarriers()`），写交给 store（创建时以集合写入的 id 补全整行）。删除条件：models 在 `credentialDescriptor.fields` 里声明这些列 |
| 9 | **集合层把设置入口的 chunk 撑大**（P3 跟进，实测） | **已修复**（按需加载 + 只用引擎） | 现象：`BUILD_TARGET=settings` 构建里 ModelsPage chunk 从 286,459 B / 120.59 kB gzip 涨到 588,436 B / 206.94 kB gzip（+301,977 B / +86.35 kB gzip），`@tanstack/db` + `@tanstack/react-db` + `packages/pod-collections` 全落在挂 applet 的那个 chunk 里。做法三条：① 宿主能力 `podCollections` 换成**按需加载的前端**（`ui/src/extensions/pod-collections-lazy-host.ts` 动态 import `pod-collections-host.ts`），接口新增可选 `load()`（`packages/extension-sdk/src/web.ts`）—— `define()` 保持同步语义，未加载时报 `pod_collections_not_loaded`，缓存/同步状态订阅在未加载时也照常工作；② applet 侧 `packages/ai-connections/src/collections.ts` 只留类型与纯函数，引擎相关部分移到 `collection-runtime.ts`，由 `credentialCollectionRuntime()` 动态 import 一次；③ 行读取改用**集合自身变更流上的 `useSyncExternalStore`**（控制器快照 `credentialRows`），而不是 `@tanstack/react-db` 的 `useLiveQuery` —— 懒加载 hook 会强制整个有状态面板重挂，而整表读不需要派生查询，这正是 §7.4-4 / §8.7-5 预写的出口。结果与完整表见 §8.9 的「本轮（P3 跟进）」：初始加载 292,609 B / 122.52 kB gzip（比无集合基线 286,459 B / 120.59 kB 只多 6,150 B / 1.93 kB gzip），集合层 128,643 B / 35.49 kB gzip 只在走到凭据列表路径时才取；`@tanstack/react-db` 不再出现在 settings 产物里。验收测试：`ui/src/extensions/pod-collections-lazy-host.test.ts`（加载前报预留、加载后 `define()`/`load()` 同一个集合、同步状态跨加载转发、dispose 释放）与 `packages/ai-connections/test/pod-collections.test.tsx` 的两条新用例（层未落地时与「宿主没有该能力」完全同形，落地后升级为 live 行并释放凭据文档的兜底观察；层取不到时保持 store 自己读） |

## 引用

**TanStack DB**（每条 API 事实的出处；不复制其文档正文）：

- 变更消息与同步生命周期（`begin` → `write` → `commit`、`markReady()`、`metadata.row` / `metadata.collection`、`rowUpdateMode`、`loadSubset`、`parseLoadSubsetOptions` / `extractSimpleComparisons` / `parseOrderByExpression`、清理函数）：<https://unpkg.com/@tanstack/db@0.6.7/skills/db-core/custom-adapter/SKILL.md>
- 乐观更新、mutation handler 义务（不得在同步回来前 resolve）、自动回滚、不自动重试、事务状态与 `isPersisted.promise`、`insert/update/delete` 与 `optimistic: false`、`useLiveQuery` 用法：<https://tanstack.com/db/latest/docs/guides/mutations.md>
- `createCollection` 与基本用法：<https://github.com/TanStack/db/blob/main/docs/quick-start.md>
- 版本与体积（`0.9.0`：`unpackedSize` 7 280 156 B，依赖 `@tanstack/db-ivm` / `@tanstack/pacer-lite` / `@standard-schema/spec`）：<https://registry.npmjs.org/@tanstack/db/latest>
- 版本与体积（`0.3.8`：`unpackedSize` 304 735 B，硬依赖 `@tanstack/db@0.9.0`，peer `react >=16.8.0`）：<https://registry.npmjs.org/@tanstack/react-db/latest>

**Xpod 事实**：本文所有 Xpod 结论都带仓库内路径（`packages/`、`ui/src/`、`config/`、`docs/`）；对 `@undefineds.co/models` 与 `@undefineds.co/drizzle-solid` 的结论标注到 `node_modules/@undefineds.co/...` 的具体文件。
