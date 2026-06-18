# 生态关注项目

本文件记录与 Xpod 定位接近、值得持续关注的外部项目。目的不是做竞品表，而是沉淀可复用的产品表达、协议形状和实现边界。

## 关注原则

- 关注与 Xpod 共享问题域的项目：AI Coding 后端、Agent Runtime、个人/项目数据层、协议兼容层、Memory、函数/任务/部署控制面。
- 优先记录“它怎么暴露 API、怎么给 Agent 调用、怎么组织数据边界”，不只记录功能清单。
- 不因为对方已有能力就直接复制模型；Xpod 的长期边界仍是 Pod 数据主权、Solid/RDF、`@undefineds.co/models`、协议 adapter 和 Agent Runtime。

## Nubase

- 官网：https://nubase.ai
- 仓库：https://github.com/OtterMind/Nubase
- 文章：https://www.mxphp.com/post/nubase-ai
- 首次记录：2026-06-18
- 关注级别：高

### 定位

Nubase 是一个面向 AI Coding / AI Agent 的开源、自托管后端与部署层。它把 Database、Auth、Storage、Assets、Functions、AI Gateway、Memory、cron 和 MCP 工具放在一个平台里，目标是让 AI 生成的应用从 demo 走到可访问、可运行、可维护。

### 与 Xpod 的相似点

两者都是：

```text
底层存储 / 运行时能力
  -> 平台服务层
  -> 面向前端和 Agent 的 API / 工具投影
```

Nubase 不是 PostgreSQL 原生提供 HTTP API，而是在 Spring Boot 服务层实现 PostgREST-compatible `/rest/v1/*`，再通过 JDBC 路由到项目 PostgreSQL。这个模式与 Xpod 在 Solid Pod 之上提供 `/-/sparql`、协议 adapter、ChatKit / Matrix / Run API 的思路相近：底层存储不直接等于产品 API，平台负责把底层能力投影成可用接口。

### 关键差异

| 维度 | Nubase | Xpod |
| --- | --- | --- |
| 抽象中心 | project / app | user / WebID / Pod |
| 主数据边界 | 每项目独立 PostgreSQL | 用户 Pod，Solid Resource / RDF / Binary |
| API 风格 | Supabase / PostgREST-compatible，`/rest/v1`、`/auth/v1`、`/storage/v1`、`/mem/v1`、Functions / Assets / cron | Solid sidecar `/-/{service}`、协议 adapter、Chat / Thread / Message / Run 模型 |
| Agent 接入 | MCP tools 直接操作项目后端能力 | 协议入口写入 durable model，经 Reconciler / Wake / Agent Runtime 执行 |
| 产品表达 | generate → live，让 AI 写出的应用上线 | 数据归用户所有，跨客户端 / Agent 共享人的事务和运行产物 |

### 持续关注点

1. **PostgREST-compatible API 的产品形状**
   关注它如何把普通数据库表暴露成 AI 和前端都容易使用的 REST API，包括 select/filter/order/range/insert/update/upsert/delete/RPC。

2. **MCP 工具分层**
   关注 Nubase 如何把数据库、Auth、Storage、Assets、Functions、Memory、cron 包装成 Agent 可调用工具，以及哪些操作需要 human-in-the-loop。

3. **Memory 作为一等基础设施**
   关注它的 Memory API、事实抽取、向量检索、全文检索、实体增强和历史记录组织方式。Xpod 应对比哪些部分应该进入 Pod durable model，哪些只是运行时索引。

4. **Assets / Functions / cron 的上线链路**
   关注它如何把 AI 生成的前端、后端函数和定时任务组合成“可上线应用”。这对 Xpod 的 sidecar `/-/jobs`、`/-/responses`、workspace / deployment 设计有参考价值。

5. **多项目隔离和 token 模型**
   关注它的 metadata database + project database、`apikey` + Bearer JWT 两层 token 模型。Xpod 不照搬 project-centered 模型，但可借鉴“控制面身份”和“用户身份”分层表达。

### 对 Xpod 的启发

- 可以借鉴 Nubase 的产品叙事，把 Xpod 的能力表达成更清晰的闭环，而不是只列底层组件。
- 可以把 sidecar / protocol adapter / Agent Runtime 的边界讲得更直观：不是“存储天然有 API”，而是“平台把用户授权的数据和运行能力投影成 Agent 可调用接口”。
- 不能把 Xpod 退化成 project database BaaS。Xpod 的差异化仍应保持在 Pod 数据主权、Linked Data、跨客户端可解释模型和 Reconciler / Agent Runtime 协作边界上。
