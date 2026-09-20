# @undefineds.co/pod-collections

声明式 **Pod 表集合** adapter：一个 Pod 表（同一 RDF 文档内的一类主语）用一条声明描述，
消费方拿到的是活数据 —— 按 key 增量更新、带乐观写入与回滚。

设计权威：[`docs/pod-collections.md`](../../docs/pod-collections.md)（§2 声明、§3 同步算法、
§4 乐观契约、§8 分期）。本包是那份设计的 P1 落地。

```ts
import { credentialDescriptor, credentialResource } from '@undefineds.co/models';
import { definePodCollection } from '@undefineds.co/pod-collections';

const credentials = definePodCollection(credentialDescriptor, {
  table: credentialResource,
  database,
  podUrl,
  feed: solidNotifications, // 宿主注入的脏信号能力（结构上满足 PodDocumentFeed）
});

credentials.tableDocument; // `${podUrl}settings/credentials.ttl`（由 storage.base 推导）
await credentials.preload();
const row = credentials.get('openai-1'); // RowOf<typeof credentialDescriptor>
await credentials.update('openai-1', (draft) => { draft.label = 'Renamed'; }).isPersisted.promise;
```

## 定位（做什么）

- **schema 只来自 models 的 descriptor**：`storage.base` / `resourceIdPattern` 推导文档（topic），
  `fields[*].predicate` 决定字段落在哪一列，`class` 决定行准入。本包不写表清单、不写字段映射表、
  不写布局常量（守卫测试 `test/guards.test.ts` 会失败）。
- **读**：`conditionalDocumentRead()` 是唯一读原语，走 drizzle-solid 的 `select()`；脏信号驱动
  合并窗口（默认 75ms）后的重读 + 投影 diff，只写真正变化的行（`begin/write/commit`），
  未变的行不产生新对象，组件身份与乐观状态都不被整表替换动摇。
- **写**：`onInsert` / `onUpdate` / `onDelete` → `insert().values()` / `updateById()` / `deleteById()`；
  `array: true` + `type: 'uri'` 字段走一次认证过的 SPARQL PATCH（单一入口 `writeField()`），
  不进 ORM。
- **乐观**：写入后立刻重读确认，确认条件满足前 handler 不 resolve；服务端拒绝或读不到意图 →
  抛错，由 TanStack DB 自动回滚；外部冲突 server wins + `conflicts` 标记 + `onConflict` 回调。
  确认只承诺**读得回来**的东西：只写字段（`secret: true`，不进投影）不参与比对，也不会
  因为它们判冲突 —— 它们的证据是写入调用本身成功；可读字段一个都不放宽（`§9-7`）。
- **不轮询**：没有 feed 就只读一次，之后只能显式 `refresh()`，同步状态为 `unavailable`；
  源码里没有 `setInterval`（守卫测试断言）。

## 边界（不做什么）

- **不做 schema 副本**：字段、谓词、布局、日期分桶、exact id 规则都以 `@undefineds.co/models`
  为权威；发现 descriptor 与 drizzle 表漂移时本包**报错**而不是就地补一份映射。
  `@undefineds.co/models@0.2.57` 起 `credentialDescriptor.fields` 与 credential 表的
  36 个列**逐谓词完全对齐**（0.2.56 曾缺 18 个 by-predicate 表列、多一个无承载列的
  `secretType`），`uniqueBy` 也改成真实列 `['id']` —— 见 `test/guards.test.ts` 里锁定的
  双向空集与精确计数（任何未来的漂移都会让那组断言失败）。
- **不做传输**：`PodDocumentFeed` 只有 `watch(topic, listener)`，是宿主能力的窄端口，
  不实现 websocket / 订阅生命周期。
- **不做行级文档表**（`base = '/.data/'` + `{id}`，一行一文档，如 gateway access key）：
  topic 语义是容器订阅，不在本期（§1.2）。
- **不做 `loadSubset` 谓词下推**（§8.1 的 P5）。
- **P1 未覆盖**：宿主能力接线与 pilot 页面（`ui/src/**`、`packages/extension-sdk`、
  `packages/ai-connections`）属于下一期；`./react` 入口只保证签名与编译。

## 文档 ETag 的结论（P1 第一件事）

drizzle-solid 0.3.24 的读路径**拿不到文档 ETag**，因此 `conditionalDocumentRead()` 恒返回
`etag: undefined`，同步按设计文档 §8.7-2 的出口降级（每个合并窗口全量读 + 投影 diff，
零轮询），`metadata.collection` 不写任何伪造的 ETag。证据与请求实测见 `src/read.ts` 文件头
与 `.test-data/etag-probe/probe.ts`。

## 脚本

- `bun run test`：`vitest run test --config ../../vitest.packages.config.mts`
- `bun run typecheck`：`tsc --noEmit -p tsconfig.test.json`（含测试与 `RowOf` 的类型级断言）
- `bun run build`：`tsc -p tsconfig.json` → `dist/`（ESM + 类型声明）
