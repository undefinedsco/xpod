# Local 文档强版本（Document Version）合同

状态：已接线于 Local（`config/local.json`），仅覆盖**本地文件权威的完整 `text/turtle` 文档**这一条 lane。
本文档是该 lane 的行为合同与边界说明，不声称通用 MIME、Cloud/共享数据库、原生 C++/Mac 交付或整包发布通过。

## 1. 版本 token 的形状

```
dv1.<stateHash>.<representationId>.<byteDigest>
```

- `stateHash`：对受保护物理权威状态取 sha256（资源布局 path、表示身份、正文字节摘要、以及相关权威 sidecar 字节摘要）。
- `representationId`：净化后的表示身份（content type）。
- `byteDigest`：实际交付表示字节的 sha256。

刻意是**内容/状态摘要**，不是墙上时钟、索引新鲜度或客户端 marker。它只表达“当前状态相等”，不是操作历史、持久性证明或提交溯源。

## 2. 内部溯源（防伪造）

metadata bag 是 quad-only，客户端可以把同形状字面量持久化到同一 public predicate 下。因此：

- `writeDocumentVersion` 写入的是 `<token>~<seal>`，seal 是本进程私有 key（`randomBytes(32)`，进程生命周期内固定、**从不导出/持久化/配置**）对 `<resourcePath>\0<token>` 的 HMAC-SHA256。
- `readDocumentVersion` 只在 seal 校验通过时返回裸 token；客户端字面量、畸形字面量、或另一资源的 token replay 一律忽略。
- `getETag` 只把裸 token 放上线，seal 永不出现在响应或 sidecar RDF 中。
- 真 token 通过正常 metadata clone 保留（Root provenance oracle 覆盖）。

## 3. 捕获与绑定边界

- GET/HEAD 的 body 与版本在同一次物理操作边界内捕获；`body`/`version` 不一致不返回强版本。
- eligible 的权威捕获失败必须**传播**，不得回退到秒级校验器。
- 真正的“资源不存在 = 创建语义”仍返回未 qualified（不抛错）；mapper 错误、stat 错误、已存在资源缺失物理权威则传播。
- 相关权威 **sidecar** 字节参与 `stateHash`：sidecar 任意有效变化产生新 token；还原后恢复原 token。不使用索引/跟踪器新鲜度代替实际状态。
- warm metadata cache / 派生索引恢复不得复活旧 token：每次 `attachDocumentVersion` 都按当前物理字节重算。

## 4. 大于 16 MiB

不设“超出即静默回退秒级校验器”的能力悬崖：

- `getMetadata` 路径用有界流式 sha256（从不整篇缓冲），任何大小的 eligible Turtle 都保持 qualified。
- `getLocalRdfDocument` 小于等于 16 MiB 时缓冲精确字节做 in-memory replay；超过时用有界流式 digest，并交付未被消费的原始文件 producer（bounded memory）。
- 两种路径都保持 qualified，因此大文档的条件写仍是完整 token 比较，不退化为不安全的遗留条件写。

## 5. 表示转换（内容协商）

转换后字节/MIME 改变时，不能再复用原始 Turtle 强 token：

- 若转换产物与原始 token 的字节 + contentType **完全一致**（如 identity round-trip、默认 `*/*` 落到 `text/turtle`），重新挂回**同一个**精确 token，保证默认/协商 GET 不丢 ETag。
- 否则挂 internal 的**密封抑制指令**（`dv0~<seal>`）：`getETag` 返回 `undefined`（显式省略校验器），`matchesETag` fail-closed 返回 false。
- 不把秒级强校验器当作“正确的强表示版本”。
- 不信任客户端 `dv0` 字面量（未密封即忽略）。

## 6. 流与生命周期

- 原始 producer 在消费前先注册 admission；等待其**真实 close**，再在持有的 operation lifetime 内交接 replay，不留 drain gap。
- 取消/出错时同样清理所有自有 producer 与临时文件；消费者取消 replay 不泄漏独占物理 admission（Own 回归覆盖）。

## 7. 明确不做

- 不新增 journal、版本表、第二套版本比较表、共享 models schema 或部署 env 键。
- 不把 Index/tracker freshness 或客户端 marker 当版本。
- 不把 qualification 泛化到所有 MIME/存储模式，也不由此推断 Cloud/原生/Mac 交付合格。
- 强 ETag 只是状态校验器，不是受信提交回执、崩溃持久性证明或客户端所有权证明。
