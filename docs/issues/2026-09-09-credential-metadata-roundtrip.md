# Credential 元数据在已发布依赖中未往返保存

## 实际复现

2026-09-09，已安装 Xpod 的真实账号拖动两个 OpenAI 订阅凭据后，页面显示顺序已保存；使用同一 Pod 的 drizzle-solid `findById` 与凭据列表重新读取，二者的 priority 仍回退为 100，metadata 为 undefined。keyVersion 已更新，说明不是整个请求未执行。

## 根因与 owning source

1. Xpod 将 priority 等适配配置放在 Credential metadata 中，但消费的 models 0.2.53 发布 schema 没有 metadata，ORM 不会保存未声明的列。
2. models 拥有仓库已有 `credentialResource.metadata = json(...).predicate(UDFS.metadata)` 与模型测试，消费包尚未包含。
3. drizzle-solid 0.3.24 仍把 json 列交给 inline object 处理器，产生子节点。owning ORM 源码已有 atomic JSON 修复；必须同时携带，否则仅添加 schema 不能保证对象与读取结果相同。

## 修复边界

在已有 Bun patches 中精确 backport owning source 的 Credential metadata 和 atomic JSON 相关修改；不复制模型到 Xpod，不添加新依赖，不绕过 ORM。保留 object 的原有嵌套节点行为，JSON 数组仍作为正确的 JSON 值/数组元素处理。覆盖 ESM 与 CommonJS，以及展开的类型声明。

这项修改用于排序等持久配置。额度查询结果仍只存在页面内存，未增加额度持久化。

## 回归

`tests/drizzle-solid/credential-metadata-roundtrip.test.ts` 使用消费的真实 Credential schema、真实 triple builder/handler 和 N3 Parser→Writer→Parser，检查 metadata priority、enabled、health、嵌套数组、JSON 数组、删除边界与 object 行为。补丁应用前六项失败。

安装版还需验证：拖动 → ORM 重新读取 → 页面重载后顺序保持。不能用 mock 合并对象的成功代替该证据。

## 第二阶段：列表读取与更新分支

添加 schema 与底层 atomic JSON 处理器后，真实安装版 `findById` 已读到 priority 10/20，但列表仍返回 100。`listProviders` 使用 collection `select().from(...).execute()`；其 `isInlineObjectColumn` 仍包含 json，后续 hydration 把已解码的 metadata 当子节点 URI 处理并覆盖。这解释了 exact read 正常而页面重载顺序复原。

修复进一步覆盖 ESM/CJS 的 SelectQueryBuilder、PodDatabase、LdpExecutor 与 SPARQL UpdateBuilder：仅 object 走子节点 hydration/递归删除；JSON 更新删除父节点的旧谓词值，再由 TripleBuilder 写原子 JSON literal。SPARQL 插入仍使用 TripleBuilder，避免普通值格式化将 JSON 对象变成 `[object Object]`。

新增路径回归先得到 6 失败/6 通过，再得到 12/12 通过：真实 collection query builder 执行不会覆盖 RDF 解码后的 metadata；LDP patch 删除旧 literal；SPARQL 更新不含子节点删除且写入 JSON literal。collection 测试控制 session 返回的 RDF 解码行，不能替代真实 Gateway 验收；安装版重载排序仍由实际运行链路验证。

## 安装版最终验收

2026-09-09，已替换 `/Applications/Xpod.app` 运行文件，实际 Gateway 3000、当前账号 Pod 上验证：鼠标拖动两条订阅凭据后重新加载页面，顺序保持，上下移动按钮数量为 0。此次验证将原有两条凭据恢复到最初展示顺序。最终 runtime SHA256 为 `afa8e25ce0a3abe8da328dfce815448649f30f1a3693982e1e4c8bd7fbaf6cfe`。

同一安装版的 Pod 文件读取、Gateway Key 创建/list/reveal、`/v1/models` 与真实 `gpt-5.5` Chat 均通过，响应严格匹配 `XPOD_DRAG_OK`。临时 Key 删除后返回 401，临时模型选择已恢复。原有 `gpt-5.4-mini` 订阅模型被上游拒绝，不计入可用 Chat 验收。完整集成测试 194 通过、6 跳过；JSON 路径回归 12 通过。
