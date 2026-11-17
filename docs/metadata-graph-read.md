# 元数据图（`meta:`）显式读契约

本文只定义**读**：`/-/sparql` 如何显式读取资源的元数据图。它不改变默认数据集、不改变写边界。

## 背景

资源的 `.meta`（LDP 辅助资源）由 `SolidRdfDataAccessor` 存进图 `meta:<resource>`，subject 是资源本身。`.meta` GET 一直可读，但 SPARQL 的容器读作用域是资源数据前缀 `basePath`，`meta:<basePath>` 不在其中，所以普通查询看不到元数据；集合发现也无法预知资源 IRI。

## 支持的形状

端点 base 记作 `{base}`（如 `/alice/agents/` 端点对应 `https://pod/alice/agents/`），有界命名空间是字符串 `meta:{base}`。

**单资源显式图：**

```sparql
SELECT ?name WHERE {
  GRAPH <meta:https://pod/alice/agents/key/> {
    <https://pod/alice/agents/key/> <http://xmlns.com/foaf/0.1/name> ?name
  }
}
```

**集合发现（graph 变量 + 有界过滤）：**

```sparql
SELECT ?subject ?metadataGraph ?name WHERE {
  GRAPH ?metadataGraph { ?subject <http://xmlns.com/foaf/0.1/name> ?name }
  FILTER(STRSTARTS(STR(?metadataGraph), "meta:https://pod/alice/agents/"))
  FILTER(STR(?subject) = STRAFTER(STR(?metadataGraph), "meta:"))
}
```

**变量名是结构性的，不是契约的一部分。** `?subject`/`?metadataGraph` 只是示例；服务端从 `GRAPH <var>` 模式、`STRSTARTS` 命名空间过滤、`STR(...) = STRAFTER(...)` 归属过滤这个形状推导 subject 与 graph 变量，所以 alpha-renamed 查询（如 `?res`/`?g`）语义完全相同。查询必须投影这两个变量，且归属过滤必须在 `ORDER BY`/`LIMIT`/`OFFSET`/聚合之前作为查询级过滤生效——客户端事后过滤会让排序靠前的越界行吃掉 `LIMIT 1`。

Xpod 不接受只靠 `VALUES` 或客户端改名去猜图的形状；缺归属绑定的集合查询返回明确 400。

**归属过滤必须是查询级（顶层）的。** 如果 `FILTER` 只写在某个 `UNION`/`OPTIONAL` 分支里，它只约束那个分支，不能证明其它分支也满足 `graph == "meta:" + subject`。这类形状一律 400，而不是返回可能错误的空结果；这保证 `ORDER BY ... LIMIT 1` 不会因为排序靠前的“他人关于本资源的 triple”而丢掉本资源自己的 facet 行。

**聚合/分组是允许的。** `SELECT ?col (COUNT(...) AS ?n) ... GROUP BY ?col` 不必投影 graph/subject 变量（SPARQL 禁止未分组的投影变量）。此时仍要求顶层归属过滤与已授权图的物理快照，二者都在 `GROUP BY` 之前生效，所以聚合只看本资源 facet，不会把他人 facet 的行计入。

## 语义

- **精确图**：facet IRI 因其 subject 是容器而以 `/` 结尾，但它永远是精确图，不会展开到子资源。`<meta:.../key/>` 不匹配 `<meta:.../key/child/>`。
- **默认数据集不变**：`scopedUnion`、`physical`、`exactSource` 对普通数据查询的含义完全不变；元数据不会被隐式并入无名字查询。
- **混合查询拒绝**：元数据图模式与无名字数据模式、或与非 `meta:` 具名图混用，返回明确 400，不返回部分结果。
- **opt-in**：只有命名在端点元数据命名空间内的图，或带精确 `STRSTARTS` 有界过滤的单个 graph 变量，才进入该路径；普通 graph 变量查询保持原数据语义。
- **授权**：去掉 `meta:` 前缀后的 subject 资源按普通 Read 判定，与 `.meta` GET 同一权限。subject 被拒绝则其 facet 一并拒绝；子资源 ACR override 只影响自己的 facet；跨 Pod、sibling、`meta:meta:` 一律出界。
- **快照固定**：集合读在授权后把 native 物理作用域 `allowedGraphUrls` 固定为本次已授权的精确图快照。授权后才出现的图不会进入查询再靠行过滤补救；快照为空时直接返回 200 空结果（fail closed），不会退化成无限制读取。
- **别名拒绝**：ACL 里对 `meta:<resource>` 或对 `<resource>` 的显式 deny 互相等价，命中任一形式都拒绝；这只作用于读，写守卫仍是字面图匹配。
- **普通查询严格隔离**：`meta:` 别名只在“显式元数据读请求”使用的元数据 scope（base 为 `meta:<base>`）内可见。普通数据 scope（base 为 `<base>`）沿用字面图匹配，因此 `ASK`/`CONSTRUCT`/嵌套 `SELECT`/`GRAPH ?g` 都不会读到 facet。
- **无逐资源授权的形状 fail closed**：`ASK`/`CONSTRUCT`/`DESCRIBE` 或分类器未接受的 `SELECT`（含嵌套子查询里的 `GRAPH <meta:...>`）返回明确 400，不会退化成普通查询执行。

## 实现位置

- `src/http/SubgraphSparqlHttpHandler.ts`：`classifyMetadataRead` / `executeMetadataSelect` 做形状校验、逐 subject 授权、graph↔subject 绑定过滤。
- `src/storage/rdf/RdfAccessScope.ts`：`rdfReadGraphAllowed` 是**读**谓词（字面前缀或精确 facet）；`rdfAccessGraphAllowed` 保持字面匹配，继续作为写守卫。facet IRI 不再按容器前缀处理。
- `RdfQuerySparqlEngine`（Cloud/JS）与 `QleverSparqlEngine`（Local/native）各自提供 `queryMetadataBindings` / `listMetadataGraphs`。
- native：元数据 quad 不带 source 归属，若用 `meta:` 作为 `basePath` 会触发 source join 而丢行；因此元数据专用读使用空 `basePath`（graph scope ALL）+ **必填有限 ACL scope**（`basePath = meta:{base}`），由既有 `allowedGraphPrefixes` 收窄扫描。缺少该 scope 直接报错，不存在无约束回退。没有新增 ABI 或 wire 选项。

## 不改变的部分

- SPARQL UPDATE 到 `meta:` 图仍然关闭（字面 graph 校验 + 写 ACL）。
- CSS `ImmutableMetadataPatcher` 对 `dcterms:modified` 的 409 保护不变。
- 没有元数据索引、图重命名、迁移、Models 改动或隐式默认并集。

## 验证

- 单测：`tests/storage/rdf/MetadataReadScope.test.ts`、`tests/storage/rdf/MetadataReadEngine.test.ts`、`tests/http/SubgraphSparqlMetadataRead.test.ts`。
- 回归：`tests/http/SubgraphSparqlHttpHandler.test.ts`、`tests/storage/rdf/RdfQuerySparqlEngine.test.ts`、`tests/storage/rdf/RdfSourceAccessScope.test.ts`。
- 真实本地 self-boot 栈：`tests/integration/ExplicitMetadataRead.integration.test.ts`（`bun scripts/run-integration-lite-local.ts tests/integration/ExplicitMetadataRead.integration.test.ts`）。

## 真实 Gateway 限定验收（正常 Cloud/Postgres 路径）

除隔离测试栈外，读路径已在私有正常 Cloud/Postgres 栈（cloud edition + `PostgresRdfEngine`，PG17.12 镜像
`…@sha256:ba4a58e3…`，`xpod_rdf 0.2.0` / `xpod_qlever 0.4.0`）上用真实账号 + client-credentials DPoP 会话
验证过：写后立刻读、集合 own-facet 相关、fresh client、跨 Pod 不可读、真实非 owner 被私有子资源 ACR 拒绝
（直接子资源 403，facet 在 exact/collection 中被排除，ASK/CONSTRUCT 明确 400），以及 `dcterms:modified`
仍 409、可写 name 成功、metadata SPARQL UPDATE 关闭且数据不变。证据与状态码记录在
`.test-data/release-coordination/metadata-current-pg-final-qualification/`。这是正常 PG 路径限定，不是
production/RC 通过声明；ORM 5 例与 LinX 3 例由各自 owner 用正式版本运行。
