# [discovery] Solid 生态发现服务

## 背景

Solid 生态中存在大量需要"发现"的实体：AI provider、MCP server、agent、vocab/ontology、服务端点等。当前各处依赖硬编码或人工维护的配置，缺乏统一的发现机制。

## 核心定位

发现服务是 **Solid 生态的索引、解析与匹配基础设施**，职责类比带有
Linked Data 描述能力的 DNS + 搜索引擎。它不是所有领域的事实源，也不拥有
共享 durable semantics：

- **权威投影**：索引由各领域 owner 发布的 model、vocab、manifest、capability、endpoint 与版本信息，并保留来源、时间、版本和置信度
- **实体发现**：持续发现、索引 Solid 生态中的各类实体（provider、agent、服务、vocab、Applet 等）
- **兼容性匹配**：根据声明的模型、协议、权限、extension point 和 host capability 判断消费者与提供者是否兼容
- **能力推理**：对规则无法覆盖的场景生成候选事实（如自定义端点能力探测）；推理结果必须可追溯，不能静默成为共享语义或用户设置
- **Linked Data 发布**：将发现结果以 RDF 发布，供 Solid App、Host 和 Agent 查询

社区 vocabulary/ontology 的 canonical term 由原发布社区或标准组织维护；
`@undefineds.co/models` 维护 UDFS 自有词汇，以及我们采用社区术语形成的 application
profile、RDF resource schema、URI/id helper 和迁移规则。Applet manifest 由
extension/host 契约维护，用户设置由用户 Pod 维护，运行时能力由相应 runtime
registry 维护。Discovery 只索引、验证、缓存、匹配和投影这些事实。

## 消费方使用方式

应用方只需关联实体的 **WebID**，即可获取其完整描述，无需硬编码任何配置：

```ts
// 查询 AI provider 能力
const caps = await fetchCapabilities(providerWebId);

// 查询 MCP server 端点
const endpoint = await fetchEndpoint(mcpServerWebId);

// 查询 vocab predicate 定义
const shape = await fetchShape(xpodVocabUri);
```

## 发现范围（非穷举）

- **AI Provider**：支持的 API 协议、模型列表、端点、认证方式
- **MCP Server**：工具列表、端点、协议版本
- **Agent**：能力描述、支持的任务类型、依赖的 provider/MCP
- **Vocabulary / Ontology**：社区和项目自有的 namespace、predicate、class、shape、application profile、版本、许可、废弃与映射关系
- **Solid 服务端点**：storage、identity、notification 等

## Vocabulary 与 Predicate 边界

Discovery 不治理或直接修改共享 vocabulary。它负责让外部社区与内部语义 owner
发布的内容可发现：

- 从社区目录、标准组织和可解引用 namespace 发现已有 vocabulary、ontology、shape 与 application profile
- 对每个来源记录 canonical URI、publisher、license、版本/发布日期、状态、依赖、映射、抓取时间与内容摘要
- 从 `@undefineds.co/models` 索引采用的社区术语、UDFS 自有 namespace、application profile、resource schema、版本、废弃和迁移描述
- 校验实体声明引用的 vocabulary/version 是否存在且兼容
- 将相同来源的更新增量投影到查询索引
- 对冲突或未知语义报告来源和诊断，不自行创造一个“修正后的”全局定义

Discovery 的广谱目录用于回答“社区里是否已经存在合适语义”；
`@undefineds.co/models` 中经过选择和测试的 application profile 用于回答“本平台
具体采用哪些术语和约束”。跨 Pod 数据语义的一致性通过这些 profile、UDFS
治理、版本与契约测试保障；Discovery 负责暴露、比较和匹配这些结果。

### 社区 Vocabulary Discovery

社区词汇发现至少覆盖以下来源类型：

- [Solid Vocabulary](https://solid.github.io/vocab/) 中列出的 Solid 核心及推荐词汇
- W3C 发布的 RDF、OWL、SHACL、DCAT、LDP 等标准词汇与规范
- [Linked Open Vocabularies](https://lov.linkeddata.es/dataset/about) 等社区目录，作为搜索和候选来源
- Dublin Core、Schema.org、FOAF、vCard 等词汇的 canonical publisher
- 领域社区发布的 ontology、shape 和 application profile

LOV 或其他聚合目录不是最终 authority。Discovery 找到候选后，应回源到 canonical
namespace/publisher，并保存：

- namespace、prefix、canonical distribution 与 publisher
- license、版本 IRI、发布时间、废弃状态和兼容关系
- imports、依赖、equivalent/mapping 关系
- term label/description、domain/range，以及发布的 shape/profile
- `retrievedAt`、内容摘要、来源信任等级和缓存过期策略

Discovery 可以保存不可变快照以支持离线搜索、审计和上游失效恢复，但查询结果必须
同时标明 canonical source 与 snapshot，不得把缓存地址伪装成原词汇的 namespace。
发现一个外部词汇也不等于平台已经采用它：采用决定进入
`@undefineds.co/models` application profile，并由 SHACL/资源 schema、映射和测试
表达 Xpod/Linx 的具体约束。

## 架构要点

- 发现结果存储在公共 Pod 或 SPARQL endpoint，以 Linked Data 形式暴露
- 每条派生结果记录 authority/source、抓取时间、版本、置信度和过期策略
- 内置 AI agent 可以处理需要推理的场景，但只产生可审查的候选事实
- 支持增量更新，provider/agent 可主动推送能力变更
- 不把 Marketplace UI、Pod 数据检索、OAuth discovery 和 Agent tool discovery 混成一个无边界 API；它们共享索引协议，但保留各自类型与 owner

总架构与分层边界见
[Pod-native Applet Platform Architecture](../../superpowers/specs/2026-08-12-pod-native-applet-platform-architecture.md)。

相关标准与目录：

- [RDF 1.1 Concepts](https://www.w3.org/TR/rdf11-concepts/)
- [OWL 2 Structural Specification](https://www.w3.org/TR/owl2-syntax/)
- [Shapes Constraint Language (SHACL)](https://www.w3.org/TR/shacl/)
- [Profiles Vocabulary](https://www.w3.org/TR/dx-prof/)
- [Data Catalog Vocabulary (DCAT) 3](https://www.w3.org/TR/vocab-dcat-3/)
