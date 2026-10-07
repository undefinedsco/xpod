# drizzle-solid 公开 exact 读取丢失 Chat 精确 RDF 形状

状态：2026-10-03 独立审查发现（B48 issue-first）。安装版本 `@undefineds.co/drizzle-solid@0.3.24`，
共享模型 `@undefineds.co/models@0.2.59`。C2 read port 尚未验收；本记录先于 adapter 实现。

## 场景与复现

`PodDatabase.findByIri(chatResource, canonicalChatIri)` 是公开的 exact 读取入口。它先尝试
`findByIriViaExactResource`（文档内直接读），失败则回退 `whereByIri(iri).limit(1)`。返回的行由
`mapPredicateObjectRows`（`dist/core/pod-database.js:856`）构造。审查该函数确认三处精确形状缺口：

1. **不要求 `rdf:type`**：`hasType` 仅在谓词等于 `rdf-syntax-ns#type` 且对象等于 `resource.config.type`
   时置真，但返回条件只看 `if (!hasType && !hasAnyMappedPredicate) return null`。因此只要有任意映射列，
   即使没有任何 `rdf:type`、或 `rdf:type` 是别的类型/字面量，仍会返回一行。调用方无法据此确认这是
   `chatResource` 的精确类型资源。

2. **折叠 NamedNode/Literal**：循环取 `result.o ?? result.object` 的字符串值，写入 `row[key]` 时不保留
   `termType`。若 `author` 是被写成字面量 `"https://alice/card#me"` 而非 NamedNode，返回值与合法
   NamedNode 作者**完全无法区分**；参与者/创作者的真实 RDF term 身份丢失。

3. **标量取首值**：非数组列 `if (row[key] === undefined) row[key] = object`，只保留第一个对象。多个竞争
   创作者（同名 predicate 两个不同 NamedNode）会被静默折叠成第一个，调用方看不到竞争，无法拒绝。

`whereByIri` 的 SQL 投影同样只回传映射字段，不能补回这三类证据。

## 影响

`CanonicalRoomSource` 需要“这是精确的 canonical Chat 资源、creator 是一个 NamedNode 完整 URI、
participants 是 NamedNode 当前 URI 数组、无竞争标量”这些**精确 RDF 事实**。仅靠公开 ORM 行无法证明，
尤其无法区分字面量作者与 NamedNode 作者，也无法发现 competing scalar。

## 处理边界

- 不复制共享 Chat 布局/日期规则/私有 schema 字段；不新增依赖；不改 models/schema。
- 公开 `drizzle-solid` 仍作为数据读取通道；缺口用**issue 链接的临时窄 adapter** 补齐：仅在捕获到的
  canonical 文档 GET 响应体上，用既有 `n3` 解析 + 公开 `chatResource.config.type`、列
  `getPredicate/getInverse()/dataType` 证明精确形状。不新增全局 fetch、不切换端点、不并行 TTL 读取器。
- 需要一个“同一 GET 的响应体”同时喂给 ORM 与 RDF 形状证明；不得为证明再发第二次网络请求。
- RDF 是集合：完全相同的 quad 去重后可重复；竞争真值（不同 creator/participant/type）必须拒绝；
  `rdf:type` 是字面量必须拒绝；datetime 若校验需正确 datatype。
- 若未来公开 SDK 提供保留 term 的 exact 读取，应改用公开契约，删除临时 adapter。

## 已核对的公开 API 行

- `pod-database.js:99` `findByIri<T>(iri, options?)` / `pod-database.d.ts:251` `findByIri(resource, iri)`。
- `pod-database.js:856` `mapPredicateObjectRows(resource, iri, rows)`：`hasType` 计算但不强制；`row[key]`
  折叠 term 且标量取首值。
- `chatResource` 公开列：`author`/`participants`(uri array)/`metadata`(object)；`metadata.memberRoles`
  为 `Record<string, 'owner'|'admin'|'member'>`（`models/chat.schema.d.ts`）。

本记录只描述缺口与临时方案边界，不声明 C2 或读取端口已实现。

## 追加实测：participants 数组元素被序列化为带引号的字面量（2026-10-03，B48）

用真实公开 ORM（`drizzle` + `models` Chat TripleBuilder）构建一个合法 Chat 行并取
`db.insert(chatResource).values(row).toSPARQL().query`，实得：

```
<subject> <http://www.w3.org/2005/01/wf/flow-1.0#participant> "\"https://pod-a.example/alice/profile/card#me\"" ;
```

即 `participants` 列声明为 `dataType:'array'`、`elementType:'uri'`、`options.baseType:'uri'`，但
`ColumnBuilder.formatValue`（`core/schema/columns.js:27`）的 `effectiveType = options.isArray && elementType ?
elementType : dataType` 只看 `options.isArray`（仅 `baseType` 有值），于是落回 `default` 分支
`"${String(value).replace(/"/g,'\"')}"`，把 URI 包成**带引号的字面量**（值本身含前后引号），而非
声明的 NamedNode `<...>`。`author`（标量 uri）则正确输出 `<...>`。

因此读取端不能只接受 NamedNode participants；必须在 issue 链接的窄 proof 里接受“安装模型实际输出”的
字面量形式（剥离一层外层引号后要求绝对 HTTP(S) URI），并拒绝真正的非 URI 字面量（如 `"alice"`）。这不是
复制共享 schema，而是对已核对的实际契约缺口的显式适配；一旦依赖修复数组元素类型，应改回只用 NamedNode。

本缺口不改变 `rdf:type`/`author`/`metadata.protocols.roomId` 的严格 proof，也不声明 C2 完成。

## B51 更正：安装补丁后的实际形状 + 角色命名空间（2026-10-03）

> 本节**更正并取代上文 B48「追加实测」的 participants 字面量结论**，并记录读端口必须遵守的真实契约。

1. **uri 数组现在是独立 NamedNode**：root 官方的既有 `drizzle-solid@0.3.24` Bun 补丁已完整生效，CJS 与
   ESM 两套构建实测同输出。用真实公开 ORM（`drizzle` + models Chat TripleBuilder）生成：

   ```
   <subject> a <http://www.w3.org/ns/pim/meeting#LongChat> ;
       <http://purl.org/dc/terms/creator> <https://pod.alice/profile/card#me> ;
       <http://www.w3.org/2005/01/wf/flow-1.0#participant> <webid-a>, <webid-b> ;
       <https://undefineds.co/ns#metadata> <...#metadata-1>.
   <...#metadata-1> <https://undefineds.co/ns#memberRoles> "{...}"^^xsd:json ;
       <https://undefineds.co/ns#protocols> "{\"matrix\":{\"roomId\":\"...\"}}"^^xsd:json.
   ```

   即 participants 数组元素是**独立 NamedNode**，不再是有引号的字面量。因此读端必须只接受 NamedNode，
   并拒绝 URI 形状字面量与自定义 datatype 字面量；B48 的「剥离一层引号后接受字面量」兼容路径**作废**。
   测试正例不得改写 ORM RDF，必须原样使用真实 ORM 生成文档（仅隔离 HTTP transport）。

2. **角色在 root metadata，不在 protocols.matrix**：`ChatMetadata.memberRoles` 是 metadata 对象的
   **root 键**（`models/chat.schema.d.ts`），序列化为 `<metadata命名空间>memberRoles` 的 JSON 字面量；
   `protocols.matrix` 只承载协议字段（`roomId`）。读端从 public `metadata` 谓词的命名空间派生 root 角色
   谓词，绝不读 `protocols.matrix.memberRoles`；后者即使存在也不能授予/提升角色。角色键必须是完整
   WebID、值 ∈ `owner/admin/member`，缺失即无显式角色，不从缺失/历史提升默认。

3. **JSON 值必须是 `xsd:json`，且 null 语义受限**：内联对象的值只有带 `xsd:json` datatype 才是事实；
   读端对 plain/custom/language 字面量（即使文本是 JSON）以及 present 的 `"null"^^xsd:json` 一律拒绝。
   但**写入侧无法表达“显式 null 对象属性”**：`inline.js#buildChildTriples` 对 `raw === undefined || raw === null`
   直接跳过，`{ memberRoles: null }` 与 `{}` 生成**逐字节等价** RDF。因此 RDF-only 读取无法区分“显式 null”与
   “缺失”。若需要区分，必须由 models/drizzle 先定义 null 的 RDF 表达（例如写入 `"null"^^xsd:json`）。
   root 已据此修正验收夹具（先写真值再替换为 `"null"^^xsd:json`），读端口现正确 403；**真缺失仍为 `{}`**，
   不得改为拒绝。

4. **B52 补充：同一次读取的 ORM/RDF agreement**（`docs/solid-multiparty-implementation-evidence.md` §9.26）。
   ORM 行与 raw RDF 必须在**同一次捕获 GET** 上一致（participants 集合、root memberRoles map、
   protocols.matrix.roomId），全部一致才接受；raw RDF proof 仍是 term/cardinality 权威（ORM 会折叠）。
   这不是第二次 fetch，也不是伪造 seam；具体命令与计数见证据 §9.26。本记录仍不声明 C2/task 完成。
