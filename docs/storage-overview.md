# Xpod 存储架构概览

Xpod 采用分层混合存储模型，支持 **Local (本地单机)** 和 **Server (集群/云端)** 两种部署模式。这两种模式共享相同的代码逻辑（基于 Drizzle 和 Xpod RDF 索引/查询组件），但在底层存储介质的选择上有所不同，以适应不同的部署需求。

## 1. 部署模式对比

### 1.1 Local 模式 (单机自包含)
**目标**：零依赖，开箱即用，所有数据存储在本地文件系统。

| 数据类型 | 存储内容 | 存储介质 | 实现组件 |
| :--- | :--- | :--- | :--- |
| **Pod 资源 (LDP RDF)** | `.ttl`, `.jsonld` 等可按行处理的 RDF 文件 | **本地文件系统权威 + SQLite 索引** | `MixDataAccessor` -> `FileDataAccessor` + `QuadstoreSparqlDataAccessor` |
| **Pod 资源 (LDP Binary)** | 图片、视频、二进制文件 | **本地文件系统 (FS)** | `FileDataAccessor` |
| **身份数据 (Identity)** | 账号、密码哈希 | **SQLite 文件** | `BaseAccountStore` -> `DrizzleIndexedStorage` |
| **临时会话 (Session)** | 登录状态、Token | **SQLite 文件** | `BaseAccountStore` -> `DrizzleIndexedStorage` (同上) |
| **使用量 (Usage)** | 配额、带宽统计 | **SQLite 文件** | `UsageRepository` -> `Drizzle` |
| **资源锁 (Locks)** | 并发控制锁 | **内存 (In-Memory)** | `WrappedExpiringReadWriteLocker` |

> **说明**：虽然 Local 模式使用了 SQL (SQLite)，但其本质只是读写 `data/` 目录下的 `.db` 文件，不需要安装任何数据库服务。

### 1.2 Server 模式 (集群/无盘化)
**目标**：水平扩展，无状态服务，数据持久化分离。

| 数据类型 | 存储内容 | 存储介质 | 实现组件 |
| :--- | :--- | :--- | :--- |
| **Pod 资源 (LDP RDF)** | `.ttl`, `.jsonld` 等可按行处理的 RDF 文件 | **持久 workspace 文件权威 + PostgreSQL/SPARQL 索引** | `MixDataAccessor` -> `rdfFileDataAccessor` (`FileDataAccessor`) + `QuadstoreSparqlDataAccessor` |
| **Pod 资源 (LDP Binary)** | 图片、视频、二进制文件 | **S3 / MinIO** | `MinioDataAccessor` |
| **身份数据 (Identity)** | 账号、密码哈希 | **PostgreSQL** | `BaseAccountStore` -> `DrizzleIndexedStorage` |
| **临时会话 (Session)** | OIDC状态、Cookies、重置令牌 | **Redis** | `RedisKeyValueStorage` (配置于 `xpod.cluster.json`) |
| **使用量 (Usage)** | 配额、带宽统计 | **PostgreSQL** | `UsageRepository` -> `Drizzle` |
| **资源锁 (Locks)** | 并发控制锁 | **Redis** | `WrappedExpiringReadWriteLocker` |

## 2. 核心组件解析

### 2.1 身份存储 (Identity Storage)
我们移除了旧的 `DrizzleAccountLoginStorage` 继承类，采用了更灵活的 **组合 (Composition)** 模式：
*   **逻辑层**：使用 CSS 原生的 `BaseLoginAccountStorage` (负责过期逻辑) 和 `BaseAccountStore` (负责账号逻辑)。
*   **数据层**：使用 `DrizzleIndexedStorage`。这是一个通用的 Key-Value 存储适配器，支持 SQLite 和 PostgreSQL。
    *   **单表策略**：所有身份相关数据存储在单一的大表（如 `identity_store`）中，通过 `container` 字段区分数据类型（如 'account', 'session'）。这解决了动态 Key 导致的建表崩溃问题。
    *   **角色边界**：账号角色存放在 `identity_store` 的 `account` payload 中，不再创建独立的 role 表。
*   **用量边界**：配额与流量只存 `identity_usage`，通过 `scope_type` / `scope_id` 区分 account 与 pod，不拆分成多张 usage 表，也不存 storage URL 或节点归属。
*   **控制面边界**：Local 单节点/设备状态归属本机 setup（`XPOD_LOCAL_SETUP_PATH` keyed by `XPOD_PROVIDER_ID`），不应写成集群表。Cloud 需要唯一性、索引和并发约束的控制面状态归属 Cloud cluster 表，目前收敛为 `cluster_node`、`cluster_ddns_record`、`cluster_service_token`。这些都不属于用户 Pod 业务数据，也不应挂在 identity 业务语义下。

### 2.2 混合数据访问 (MixDataAccessor)
Pod 数据存储采用“文件权威 + 索引派生”策略：
*   **RDF by-line 文件**：`.ttl` / `.jsonld` 先写入真实本地文件，作为内容权威事实；系统再解析并刷新 Quadstore / PostgreSQL 等 structured index，供 SPARQL、关系查询和检索使用。
*   **CSS 内部 RDF 流**：`MixDataAccessor.getData()` 对 RDF 仍保留 `internal/quads` 语义，服务于 CSS 转换链；HTTP/local-first 读取通过 `getLocalRdfDocument()` / Store 层优先返回真实 RDF 文件。
*   **非结构化数据 (Binary)**：进入文件系统或对象存储 (S3)，以获得最佳的 I/O 性能和成本效益。

Cloud 配置里这两条后端是故意分开的：`rdfFileDataAccessor` 固定指向本地 `FileDataAccessor`，保证 `.ttl` / `.jsonld` 是运行端可搜索、可编辑的真实文件；`unstructuredDataAccessor` 才指向 `RemoteDataAccessor` / MinIO，用于普通对象和 302 直出。

DB/Quadstore 不再是 `.ttl` / `.jsonld` 的唯一事实源。Agent、bash、`rg`、`grep`、`cat` 等工具进入 workspace 前必须能看到真实文件；索引只能加速查询，不能替代文件内容。

RDF 查询引擎的目标边界见 [Xpod RDF Engine Spec](rdf-engine-spec.md)：Xpod-owned Pod 的 server 端主路径应逐步切到本地 `SolidRdfEngine`，Comunica 组件只保留为兼容层、测试 oracle 或 client-side external provider/federation 插件。

### 2.3 SPARQL Sidecar (`/-/sparql`)
Xpod 为每个资源提供了一个 SPARQL 查询端点。
*   **Scope**：查询自动限定在当前资源（文档或容器）的范围内。
*   **Document Scope**：修复了尾部斜杠问题，现在可以直接查询文档 URL 的 `/-/sparql` 获取其内容。
*   **Permission**：目前的实现基于父目录权限继承，尚不支持细粒度的子资源 ACL 过滤（Known Issue）。

## 3. 关键环境变量

| 变量名 | 用途 | 示例 (Local) | 示例 (Server) |
| :--- | :--- | :--- | :--- |
| `CSS_IDENTITY_DB_URL` | 身份/配额数据库 | `sqlite:./data/identity.db` | `postgresql://user:pass@host:5432/db` |
| `CSS_SPARQL_ENDPOINT` | RDF/SPARQL 索引存储 | `sqlite:./data/quadstore.db` | `postgresql://...` 或 HTTP 端点 |
| `CSS_REDIS_CLIENT` | Redis 连接 (Server模式) | (未使用) | `redis-host:6379` |
| `MINIO_*` | S3 存储配置 | (未使用) | (见 S3 配置文档) |

## 4. 迁移指南

如果您从旧版本升级，由于身份存储架构已经收敛为 `identity_store` + scoped control-plane tables，旧的 SQLite/Postgres 数据不会在启动路径做隐式兼容迁移。
*   **开发环境**：建议直接删除 `data/*.db` 文件，重启服务器重新注册。
*   **生产环境**：需要执行显式、可审计的离线迁移脚本，把账号事实迁入 `identity_store`，不要在运行时 bootstrap 中保留旧表别名或旧字段修补逻辑。
