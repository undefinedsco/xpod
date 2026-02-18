# [discovery] Solid 生态发现服务

## 背景

Solid 生态中存在大量需要"发现"的实体：AI provider、MCP server、agent、vocab/ontology、服务端点等。当前各处依赖硬编码或人工维护的配置，缺乏统一的发现机制。

## 核心定位

发现服务是 **Solid 生态的知识基础设施**，职责类比 schema.org + DNS + 搜索引擎的组合：

- **语义权威**：定义并维护 xpod vocabulary（predicate、class、shape），是全网 xpod 数据的语义治理中心
- **实体发现**：持续发现、索引 Solid 生态中的各类实体（provider、agent、服务、vocab 等）
- **能力推理**：内置 AI agent，对无法通过规则判断的场景进行推理（如自定义端点能力探测）
- **Linked Data 发布**：将发现结果以 RDF 发布，任何 Solid app 均可通过 WebID 查询

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
- **Vocabulary / Ontology**：predicate 定义、class 层级、shape 约束
- **Solid 服务端点**：storage、identity、notification 等

## Predicate 治理

发现服务同时承担 xpod vocabulary 的治理职责：

- 定义 `xpod:` namespace 下的所有 predicate 和 class
- 管理版本演化、废弃、迁移路径
- 确保跨 Pod 数据的语义一致性

## 架构要点

- 发现结果存储在公共 Pod 或 SPARQL endpoint，以 Linked Data 形式暴露
- 内置 AI agent 处理需要推理的场景（规则无法覆盖所有变量）
- 支持增量更新，provider/agent 可主动推送能力变更
