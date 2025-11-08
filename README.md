# Xpod

Xpod is an extended [Community Solid Server (CSS)](https://github.com/solid/community-server), offering rich-feature, production-level Solid Pod and identity management.

Solid is a web decentralization project led by Tim Berners-Lee, the inventor of the World Wide Web. It aims to give individuals control over their data and enhance privacy by allowing data to be stored in personal online data stores (Pods). Solid promotes data interoperability and user empowerment. For more information, visit the [Solid project website](https://solidproject.org/).

## Table of Contents

- [Installation](#installation)
- [Quick Start](#quick-start)
- [Components](#components)
- [Database Performance Optimization](#database-performance-optimization)
- [Documentation](#documentation)
- [Roadmap](#roadmap)
- [Contributing](#contributing)
- [License](#license)

## Installation
To install Xpod, ensure you have [Node.js](https://nodejs.org/) and [Yarn](https://yarnpkg.com/) installed. Then run the following command:

```bash
yarn install
```

Before starting the application, you need to build the project. Run the following command:

```bash
yarn build
```

## Quick Start
选择合适的运行模式后启动 Xpod：

- **Normal mode**：即开即用，仅用于体验（SQLite + 本地文件）。
  ```bash
  yarn start
  ```

- **Local mode**：面向桌面/单机场景，默认使用 SQLite + 本地磁盘，配额与云边能力关闭，可通过 `.env.local` 按需启用。
  ```bash
  yarn local
  ```

- **Server mode**：面向集中式部署，默认使用 PostgreSQL + MinIO + Redis，可按需开启信令、DNS、证书、隧道等云边协同能力，需配置 `.env.server`。
  ```bash
  yarn server
  ```

- **Dev mode**：无鉴权的开发模式（SQLite + MinIO），用于调试 API/前端。
  ```bash
  yarn dev
  ```

启动后访问 [http://localhost:3000/](http://localhost:3000/) 查看首页。

### Profile 差异概览

| 能力 | `local` | `server` |
| --- | --- | --- |
| 数据与依赖 | SQLite + 本地磁盘；无 Redis/MinIO 依赖（可选） | PostgreSQL + MinIO + Redis，支持水平扩展 |
| 配额策略 | `NoopQuotaService`，默认不校验 | `PerAccountQuotaStrategy`，可配置默认/自定义上限 |
| 云边协同 | 关闭，Agent 可自定义扩展 | 内置 `EdgeNodeSignal`、DNS-01、用量统计，配置 env 后启用 |
| 隧道兜底 | 关闭 | 可配置 `XPOD_FRP_*` + Agent `frp` 自动守护 `frpc` |
| 证书自动化 | 需手动配置或通过桌面端触发 | 支持 ACME + DNS-01 自动续签，并下发给节点 |
| 带宽配额 | 不统计、不限速 | `identity_account_usage` / `identity_pod_usage` 表内的 `ingress_bytes` / `egress_bytes` 字段累计上下行，用 `UsageTrackingStore` + `SubgraphSparqlHttpHandler` 统一记录，默认限速 10 MiB/s（可在 `config/extensions.server.json` 调整） |
| 典型场景 | 个人开发、测试、桌面客户端 | 生产部署、与 local 节点组成云边一体 |

> 云边协同步骤：在 server 环境设置 Signal/DNS/ACME/FRP 相关变量，local 节点运行 `EdgeNodeAgent`（详见 `docs/edge-node-agent.md`），即可实现动态 DNS、证书与隧道编排。

### Local 版三种运维方式

1. **自管 HTTPS（完全自托管）**：节点自行维护证书与 443 监听，`EdgeNodeAgent` 不参与证书/隧道逻辑。适合熟悉 TLS、拥有固定公网的用户。
2. **直连 + 自动证书**：节点能开放 443，但不想手动跑 ACME。通过 `EdgeNodeAgent` 的 `acme` 配置请求 server 端 DNS-01，拿到证书后本地部署即可。
3. **无法开放 443**：使用 FRP 隧道兜底，Agent 根据 server 下发的配置自动守护 `frpc`，客户端访问由 server 的 frps 转发。适合家庭宽带、移动网络等难以暴露端口的场景。

> 桌面版客户端将整合上述能力（证书申请、隧道开关、日志查看等），当前仓库提供底层接口与示例脚本。

#### 与 Server 的协同方式

- **Local-1（自管 HTTPS） ↔ Server**：Server 仅提供账号管理与心跳登记；用量统计可由节点自管或按需汇总到 server，DNS 指向节点自有的 HTTPS 入口，其余云边扩展（ACME、隧道）可保持关闭。
- **Local-2（直连 + 自动证书） ↔ Server**：Server 负责 DNS-01 challenge 协调及心跳登记；节点本地续签证书并自行维护用量数据，DNS 仍指向节点公网 IP。
- **Local-3（隧道兜底） ↔ Server**：Server 需启用 DNS、FRP 等组件，负责分配隧道入口、下发 `frpc` 配置，并在直连不可用时自动回落到隧道流量。

同一个 Server 实例可以同时管理多种 Local 节点，只需根据节点类型设置对应的环境变量/Agent 配置。

### Optional: Configure Environment Variables

For modes that require environment variables, you need to configure them as follows:

1. 复制环境模板生成不同模式的配置：
   ```bash
   cp example.env .env.local     # 本地 / 开发
   cp example.env .env.server    # Server / 生产
   ```

2. 根据运行模式分别编辑 `.env.local` 或 `.env.server`；根目录 `.env` 可保留用于兼容旧脚本。

### 管理员初始化与权限

- **种子文件**：复制 `config/seeds/admin.example.json`，根据环境调整邮箱、密码、Pod 名称与 `webId`，并通过 `CSS_SEED_CONFIG` 或 `--seedConfig` 传入。首次启动会自动创建管理员账号及其 Pod；若条目中包含 `roles`（例如 `["admin"]`），系统会同步写入 `identity_account_role` 表。
- **角色字段**：管理员角色现在存储在 `identity_account_role(account_id, role)`，可通过 SQL 或脚本直接维护；`payload` 中的旧字段（`roles` / `isAdmin` 等）不再参与授权判定，仅用于兼容历史数据。
- **存储实现**：`yarn local`、`yarn dev` 等本地配置仍使用 `.internal/accounts` 文件存储账号；`yarn server`（集群/生产）在 `config/extensions.server.json` 中覆盖为 PostgreSQL。两种模式都会使用数据库中的 `identity_account_role` 表保存管理员角色。
- **写操作校验**：`AdminConsoleHttpHandler`、`QuotaAdminHttpHandler` 等写接口会读取访问令牌中的 WebID → 查表确认是否含有 `admin` 角色，仅管理员可执行修改（默认配置已关闭这两项 Handler）。
- **配额接口**：`/api/quota/...` 现在必须携带管理员 Bearer Token；所有 `PUT/DELETE` 调用会拒绝非管理员身份。
- **网络用量统计**：Server 模式会在 `identity_account_usage` / `identity_pod_usage` 的 `ingress_bytes`、`egress_bytes` 字段累计上下行流量，并对资源写入、读取（含 `.sparql` 查询）统一采集。默认限速 10 MiB/s，可在 `config/extensions.server.json` 或 `config/extensions.mix.json` 中覆盖 `options_defaultAccountBandwidthLimitBps`；将该字段设为 0 或删除表项即可关闭限速。
- **数据归档**：如需离线审计，可将管理员脚本输出写入 `.internal/accounts/` 目录，保留快照而不影响主数据库。
- **Pod 名称保留**：为避免与控制台路由冲突，`admin`、`quota`、`signal` 被保留，创建 Pod 时会拒绝这些名称（大小写与符号归一化后也会触发）。

## Database Performance Optimization

### Recommended Indexes

For production deployments with PostgreSQL, it's highly recommended to create the following indexes to improve query performance:

```sql
-- Quadstore backend optimization
-- Quadstore uses a key-value storage model where RDF quads are encoded into keys.
-- The 'key' column stores encoded representations of (Graph, Subject, Predicate, Object) combinations.
-- A B-tree index on 'key' already exists (created automatically), but you may want to tune it:
-- Note: The default index on 'key' column in the quadstore table is usually sufficient.
-- For very large datasets, consider partitioning or using a BRIN index instead of B-tree.

-- Pod usage queries by account
CREATE INDEX IF NOT EXISTS idx_pod_usage_account_id ON identity_pod_usage (account_id);

-- Pod lookup by baseUrl (JSONB index)
-- These GIN indexes significantly speed up JSON field queries used for resource-to-pod mapping
CREATE INDEX IF NOT EXISTS idx_pod_base_url ON identity_pod USING GIN ((payload->'baseUrl'));
CREATE INDEX IF NOT EXISTS idx_pod_account_id ON identity_pod USING GIN ((payload->'accountId'));

-- Edge node pod lookup
CREATE INDEX IF NOT EXISTS idx_edge_node_pod_base_url ON identity_edge_node_pod (base_url);

-- Optional: If you experience slow LIKE queries on baseUrl, create a trigram index
-- Requires the pg_trgm extension
-- CREATE EXTENSION IF NOT EXISTS pg_trgm;
-- CREATE INDEX IF NOT EXISTS idx_pod_base_url_trgm ON identity_pod USING GIN ((payload->>'baseUrl') gin_trgm_ops);
```

These indexes significantly improve:
- SPARQL query performance: Quadstore internally implements a "full index" approach by encoding quads into multiple sorted keys. The default `key` index is usually sufficient.
- Pod usage aggregation by account: Speeds up queries that sum storage/bandwidth by account.
- Resource identifier to Pod/Account mapping: GIN indexes on JSONB fields enable fast lookups.
- Edge node routing performance: Direct index on `base_url` for fast prefix matching.

### Quadstore Index Architecture

Quadstore uses a key-value storage model where:
- Each RDF quad (Graph, Subject, Predicate, Object) is encoded into multiple keys with different orderings
- The `quadstore` table has a simple schema: `(id, key, value)`
- The `key` column stores binary-encoded representations that naturally support different access patterns
- A single B-tree index on `key` enables efficient range scans for all SPARQL query patterns

This design is more efficient than traditional RDBMS approaches with separate GSPO, GPOS, etc. tables.

## Components

### MinioDataAccessor
- **Path**: `src/storage/accessors/MinioDataAccessor.ts`
- **Implements**: `DataAccessor`.
- **Environment Variables**: `CSS_MINIO_ENDPOINT`, `CSS_MINIO_ACCESS_KEY`, `CSS_MINIO_SECRET_KEY`.
- **Main Functionality**: Handles storage and retrieval of resources using MinIO.

### QuadstoreSparqlDataAccessor
- **Path**: `src/storage/accessors/QuadstoreSparqlDataAccessor.ts`
- **Implements**: `DataAccessor`.
- **Environment Variables**: `CSS_SPARQL_ENDPOINT`.
- **Main Functionality**: Provides SPARQL query capabilities over data stored in Quadstore. Data must be able to convert to SPO triples. Supports mysql, sqlite, postgresql backend.

### MixDataAccessor
- **Path**: `src/storage/accessors/MixDataAccessor.ts`
- **Implements**: `DataAccessor`.
- **Main Functionality**: Integrates multiple data access methods to provide a unified interface. Structured resources stored in databases, unstructured resources stored in MinIO.

### RepresentationPartialConvertingStore
- **Path**: `src/storage/RepresentationPartialConvertingStore.ts`
- **Implements**: `ResourceStore`.
- **Main Functionality**: Converts resources to ensure compatibility across different storage formats.

## Roadmap

- [ ] **DB-Based Identity Provider**: Enables authentication providers to store data in the database, facilitating secure identity management and data storage.
- [ ] **Fine-Grained Pod Capacity Management**: Provides detailed control over the storage capacity of individual Pods, allowing for efficient resource allocation and management.
- [ ] **Vector Retrieval Support for AI Applications**: Enhances AI capabilities by enabling efficient vector-based data retrieval, supporting advanced AI and machine learning applications.
- [ ] **Attribute-Based Access Control（ABAC）**: Supports attribute-based access control, allowing for fine-grained control over resource access. Zero-knowledge proof is used to verify that users meet ABAC requirements without revealing sensitive information.
- [ ] **Feature Store Support**: Allows applications to define ETL (Extract, Transform, Load) logic for feature production. Ensures privacy-safe feature production, supporting Attribute-Based Access Control (ABAC) and federated learning.

## Documentation

### For Developers
- **[CLAUDE.md](CLAUDE.md)** - Project overview, CSS architecture, and development guidelines
- **[docs/COMPONENTS.md](docs/COMPONENTS.md)** - Complete component reference and database architecture
- **Environment Setup** - Configuration examples in `.env.*` files and `example.env`

### For Contributors
- **Database Design** - Layered approach using Knex.js (infrastructure) + Drizzle ORM (business logic)
- **Testing Strategy** - Unit, integration, and deployment mode testing
- **Configuration** - JSON-LD component wiring and environment variable patterns

### For Operators  
- **Deployment Modes** - Local, server, dev, and cluster configurations
- **Performance Tuning** - Database indexes and optimization recommendations below
- **Cloud-Edge Coordination** - DNS, certificates, and tunnel management

## Contributing

Contributions are welcome! Please read the [CONTRIBUTING.md](CONTRIBUTING.md) to understand how to contribute to the project.

## License

Xpod is licensed under the MIT License. See the [LICENSE](LICENSE) file for more details.
