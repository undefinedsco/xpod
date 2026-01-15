# Xpod Components Guide

This document provides a comprehensive overview of all custom components developed for Xpod, extending the Community Solid Server (CSS) framework.

## 等位替换对照表

Xpod 遵循**等位替换原则**：用自定义组件替换 CSS 同层级的默认组件，保持接口兼容，不破坏 CSS 调用链。

| CSS 默认组件 | Xpod 替换组件 | 功能区别 |
|-------------|--------------|----------|
| `DataAccessorBasedStore` | `SparqlUpdateResourceStore` | 拦截 PATCH 操作，能处理的直接执行 SPARQL UPDATE，不能处理的抛出 `NotImplementedHttpError` 让 CSS 回落到 get-patch-set |
| `RepresentationConvertingStore` | `RepresentationPartialConvertingStore` | **能转尽量转，不能转保留原始**。CSS 默认遇到不能转换的会报错；我们的实现让 JSON、二进制等非 RDF 内容直接通过 |
| `FileDataAccessor` | `MixDataAccessor` | 混合存储：RDF 结构化数据走 Quadstore，非结构化文件走 FileSystem/MinIO |
| `SparqlDataAccessor` | `QuadstoreSparqlDataAccessor` | 基于 Quadstore + SQLUp 的 SPARQL 存储，支持 SQLite/PostgreSQL/MySQL |
| `BaseLoginAccountStorage` | `DrizzleIndexedStorage` | 数据库存储账户信息，支持集群部署，替代 CSS 的文件存储 |
| `PassthroughStore` | `UsageTrackingStore` | 包装 Store，添加带宽/存储用量追踪和限速功能 |
| `HttpHandler` (HandlerServerConfigurator.handler) | `MainHttpHandler` (ChainedHttpHandler) | 用链式中间件替换单一 handler，支持洋葱模型。包含 `TracingMiddleware` (请求追踪) 和可选的 `SignalAwareHttpHandler` (集群模式) |

### Store 调用链对照

```
CSS 默认链:
MonitoringStore → BinarySliceResourceStore → IndexRepresentationStore
  → LockingResourceStore → PatchingStore → RepresentationConvertingStore
    → DataAccessorBasedStore → FileDataAccessor

Xpod 等位替换后:
MonitoringStore → BinarySliceResourceStore → IndexRepresentationStore
  → LockingResourceStore → PatchingStore → RepresentationPartialConvertingStore [替换]
    → SparqlUpdateResourceStore [替换] → MixDataAccessor [替换]
                                           ├─ QuadstoreSparqlDataAccessor (RDF)
                                           └─ FileDataAccessor/MinioDataAccessor (非RDF)
```

## Table of Contents

- [Storage Components](#storage-components)
- [Identity & Authentication](#identity--authentication)
- [Quota & Usage Management](#quota--usage-management)
- [Edge & Cloud Coordination](#edge--cloud-coordination)
- [HTTP Handlers](#http-handlers)
- [Utility Components](#utility-components)

## Storage Components

### MixDataAccessor
- **Path**: `src/storage/accessors/MixDataAccessor.ts`
- **Purpose**: Unified storage interface combining structured and unstructured data access
- **Functionality**: Routes structured resources (RDF, JSON-LD) to Quadstore, unstructured files to MinIO/FileSystem
- **Configuration**: Uses `sparqlEndpoint` for structured data, `unstructuredDataAccessor` for files
- **Deployment**: All modes (local uses FileDataAccessor, server uses MinioDataAccessor)

### MinioDataAccessor
- **Path**: `src/storage/accessors/MinioDataAccessor.ts`
- **Purpose**: S3-compatible object storage backend
- **Environment Variables**: 
  - `CSS_MINIO_ENDPOINT` - MinIO server endpoint
  - `CSS_MINIO_ACCESS_KEY` - Access key for authentication
  - `CSS_MINIO_SECRET_KEY` - Secret key for authentication
  - `CSS_MINIO_BUCKET_NAME` - Bucket name for storage
- **Functionality**: Handles file upload, download, deletion with S3 API
- **Deployment**: Server mode only

### QuadstoreSparqlDataAccessor
- **Path**: `src/storage/accessors/QuadstoreSparqlDataAccessor.ts`
- **Purpose**: SPARQL query capabilities over RDF data stored in relational databases
- **Environment Variables**: `CSS_SPARQL_ENDPOINT` (supports SQLite, PostgreSQL, MySQL)
- **Functionality**: Converts RDF resources to quads for database storage, supports SPARQL queries
- **Deployment**: All modes (SQLite locally, PostgreSQL in server)

### RepresentationPartialConvertingStore
- **Path**: `src/storage/RepresentationPartialConvertingStore.ts`
- **Purpose**: Content-type conversion for storage compatibility
- **Functionality**: Converts incoming representations to quads for quadstore-backed resources
- **Integration**: Used in ResourceStore chains for both local and server modes

### UsageTrackingStore
- **Path**: `src/storage/quota/UsageTrackingStore.ts`
- **Purpose**: Bandwidth and storage usage monitoring wrapper
- **Functionality**: 
  - Tracks ingress/egress bytes for all resource operations
  - Records usage in `identity_account_usage` and `identity_pod_usage` tables
  - Applies bandwidth throttling via `createBandwidthThrottleTransform`
- **Deployment**: Server mode only

## Identity & Authentication

### DrizzleAccountLoginStorage
- **Path**: `src/identity/drizzle/DrizzleAccountLoginStorage.ts`
- **Purpose**: Database-backed account authentication and management
- **Schema**: `src/identity/drizzle/schema.ts`
- **Tables**:
  - `identity_account` - User accounts with login credentials
  - `identity_account_role` - Role-based access control (admin, user, etc.)
  - `identity_pod` - Pod metadata and ownership mapping
- **Functionality**: Account creation, authentication, role management
- **Deployment**: Server mode (PostgreSQL), also available for local testing

### DrizzleAccountStorage
- **Path**: `src/identity/drizzle/DrizzleAccountStorage.ts`
- **Purpose**: Account data persistence layer for clustered deployments
- **Integration**: Replaces CSS file-based account storage in server mode
- **Functionality**: CRUD operations for accounts, pods, and roles

## Quota & Usage Management

### PerAccountQuotaStrategy
- **Path**: `src/storage/quota/PerAccountQuotaStrategy.ts`
- **Purpose**: Per-account storage quota enforcement
- **Configuration**: 
  - `defaultAccountQuotaBytes` - Default quota (10GB in server mode)
  - `quotaService` - Service for custom quota logic
- **Functionality**: Checks available quota before writes, rejects over-quota operations
- **Deployment**: Server mode only

### DefaultQuotaService / DrizzleQuotaService / NoopQuotaService
- **Path**: `src/quota/`
- **Purpose**: Different quota enforcement strategies
- **DefaultQuotaService**: In-memory quota tracking with configurable defaults
- **DrizzleQuotaService**: Database-backed quota with per-account overrides
- **NoopQuotaService**: Disabled quota checking (local mode)

### createBandwidthThrottleTransform
- **Path**: `src/util/stream/BandwidthThrottleTransform.ts`
- **Purpose**: Factory returning一个用于限速的 `Transform`
- **Parameters**: `bytesPerSecond`、`measure`、`objectMode`
- **Functionality**: 根据传入配置延迟 `Transform` 输出，常用于 Service/Handler 里的限速逻辑

## Edge & Cloud Coordination

### EdgeNodeAgent
- **Path**: `src/edge/EdgeNodeAgent.ts`
- **Purpose**: Coordinates local nodes with server instances
- **Functionality**: 
  - Heartbeat reporting to server
  - Certificate management integration
  - Tunnel configuration synchronization
- **Deployment**: Local mode with edge coordination enabled

### EdgeNodeDnsCoordinator
- **Path**: `src/edge/EdgeNodeDnsCoordinator.ts`
- **Purpose**: Dynamic DNS management for edge nodes
- **Integration**: Works with DNS providers (Tencent, Cloudflare, etc.)
- **Functionality**: Automatic A/AAAA record updates for node IP changes

### Dns01CertificateProvisioner
- **Path**: `src/edge/Dns01CertificateProvisioner.ts`
- **Purpose**: Automatic ACME certificate management with DNS-01 challenge
- **Functionality**: 
  - Certificate issuance and renewal
  - DNS challenge automation
  - Certificate distribution to edge nodes

### FrpTunnelManager
- **Path**: `src/edge/FrpTunnelManager.ts`
- **Purpose**: FRP tunnel management for nodes behind NAT
- **Functionality**: 
  - Automatic frpc configuration generation
  - Tunnel health monitoring
  - Fallback routing for unreachable nodes

## HTTP Handlers

> **注**：旧版 Admin Console Handler 已移除，如需后台 UI 请基于现有 API 自行实现。

### QuotaAdminHttpHandler
- **Path**: `src/http/quota/QuotaAdminHttpHandler.ts`
- **Purpose**: RESTful quota management API
- **Endpoints**: `/api/quota/*` for quota CRUD operations
- **Authentication**: Admin Bearer token required for write operations
- **Deployment**: Server mode only

### EdgeNodeSignalHttpHandler
- **Path**: `src/http/admin/EdgeNodeSignalHttpHandler.ts`
- **Purpose**: Edge node coordination API
- **Endpoints**: `/signal/*` for node registration and configuration
- **Functionality**: 
  - Node heartbeat handling
  - Configuration distribution
  - Status monitoring
- **Deployment**: Server mode with edge coordination

### SubgraphSparqlHttpHandler
- **Path**: `src/http/SubgraphSparqlHttpHandler.ts`
- **Purpose**: Per-account SPARQL endpoints with usage tracking
- **Endpoints**: `/{pod}/sparql` (container), `/{resource}.sparql` (resource)
- **Functionality**:
  - SELECT, ASK, CONSTRUCT, DESCRIBE queries (GET/POST)
  - SPARQL UPDATE (POST only)
  - WAC-based authorization (read/append/delete)
  - Graph scope validation
- **Deployment**: All modes
- **Documentation**: See [docs/sparql-support.md](sparql-support.md) for full details

### EdgeNodeProxyHttpHandler
- **Path**: `src/http/EdgeNodeProxyHttpHandler.ts`
- **Purpose**: 反向代理 proxy 模式下的 Pod 流量
- **Functionality**:
  - 根据节点 metadata 选择直连或隧道入口
  - 在响应头中暴露 `X-Xpod-*` 诊断信息
- **Deployment**: Server / mix 模式

### EdgeNodeRedirectHttpHandler
- **Path**: `src/http/EdgeNodeRedirectHttpHandler.ts`
- **Purpose**: 调试阶段的 307 跳转
- **Notes**: 默认关闭；仅在需要手动验证节点入口时启用

### ChainedHttpHandler
- **Path**: `src/http/ChainedHttpHandler.ts`
- **Purpose**: 链式 HTTP 处理器，支持洋葱模型中间件
- **Functionality**:
  - 支持透传型中间件（实现 `MiddlewareHttpHandler` 接口，有 `before()`/`after()` 钩子）
  - 支持拦截型 Handler（标准 `HttpHandler`，通过 `canHandle()` 决定是否处理）
  - 洋葱模型执行：`before()` 顺序执行，`after()` 逆序执行
- **Configuration**: 通过 `handlers` 数组配置链中的处理器
- **Deployment**: All modes
- **Documentation**: See [docs/chained-http-handler.md](chained-http-handler.md) for full details

### RouterHttpHandler
- **Path**: `src/http/RouterHttpHandler.ts`
- **Purpose**: 按路径前缀路由 HTTP 请求（单 baseUrl 模式）
- **Functionality**:
  - 依次匹配 `routes`，命中后转发给对应 handler
  - 未命中时走 `fallback`
- **Configuration**: `routes` + `fallback`
- **Deployment**: All modes (when routing multiple internal handlers)

### RequestIdHttpHandler (TracingMiddleware)
- **Path**: `src/http/RequestIdHttpHandler.ts`
- **Purpose**: 请求追踪中间件，为每个请求分配唯一 ID
- **Functionality**:
  - 读取或生成 `X-Request-ID` 请求头
  - 在响应头中返回 `X-Request-ID`
  - 将 ID 注入 AsyncLocalStorage，供日志系统使用
  - 记录请求耗时和状态码
- **Interface**: 实现 `MiddlewareHttpHandler`，需配合 `ChainedHttpHandler` 使用
- **Configuration ID**: `urn:undefineds:xpod:TracingMiddleware`
- **Deployment**: All modes

## Utility Components

### ConfigurableLoggerFactory
- **Path**: `src/logging/ConfigurableLoggerFactory.ts`
- **Purpose**: Enhanced logging with configurable output formats
- **Configuration**: `config/logging/configurable.json`
- **Features**: JSON structured logging, custom formatters, log level control

### PostgresKeyValueStorage
- **Path**: `src/storage/keyvalue/PostgresKeyValueStorage.ts`
- **Purpose**: PostgreSQL-backed key-value store for clustering
- **Design**: Uses TEXT columns with JSON strings for cross-database compatibility
- **Deployment**: Server mode for session storage and caching

## Configuration Architecture

### Component Loading
All components follow CSS's Components.js dependency injection pattern:

1. **Component Discovery**: TypeScript decorators define injectable components
2. **Context Registration**: `dist/components/context.jsonld` maps simplified names
3. **Configuration**: JSON-LD files in `config/` wire dependencies
4. **Environment Variables**: `urn:solid-server:default:variable:*` pattern maps to `CSS_*` env vars

### Deployment Mode Differences

| Component | Local Mode | Server Mode |
|-----------|------------|-------------|
| Storage | SQLite + FileSystem | PostgreSQL + MinIO |
| Authentication | File-based accounts | Database accounts |
| Quota | NoopQuotaService | PerAccountQuotaStrategy |
| Usage Tracking | Disabled | Full bandwidth/storage monitoring |
| Edge Features | Optional via Agent | Built-in coordination |

### Key Configuration Files

- `config/main.json` - Core CSS imports and overrides
- `config/xpod.base.json` - Common component definitions
- `config/local.json` - Development entry point
- `config/cloud.json` - Production entry point
- `config/xpod.cluster.json` - Cluster-specific components

## Data Layer Architecture

### Database Technology Strategy

Xpod uses a **layered database approach** that combines different ORMs for optimal performance and maintainability:

#### Bottom Layer: Knex.js (Infrastructure)
**Purpose**: High-performance, cross-database infrastructure components
**Use Cases**:
- **SQLUp**: Universal key-value storage supporting SQLite/PostgreSQL/MySQL
- **Quadstore Backend**: RDF data storage with binary/streaming requirements
- **Performance-critical paths**: Large data processing, streaming operations
- **Cross-database compatibility**: Components that need to work across different databases

**Characteristics**:
- Direct SQL control for maximum performance
- Mature cross-database abstraction layer
- Handles complex data types (binary, RDF quads)
- Minimal abstraction overhead

```typescript
// Example: SQLUp infrastructure component
class SQLUp<T extends TFormat> extends AbstractLevel<T> {
  private db: Knex; // Direct SQL for performance
  
  async _put(key: T, value: T) {
    await this.db.insert({key, value}).into(this.tableName);
  }
}
```

#### Top Layer: Drizzle ORM (Business Logic)
**Purpose**: Type-safe business entity management with rich relationships
**Use Cases**:
- **Account Management**: Users, roles, permissions
- **Pod Management**: Pod metadata, ownership mapping
- **Admin Operations**: Complex business queries with joins
- **API Endpoints**: HTTP handler data operations

**Characteristics**:
- Full TypeScript type safety
- Automatic relationship handling
- Schema migrations and validation
- Developer-friendly APIs

```typescript
// Example: Business logic component
class AccountRepository {
  constructor(private db: DrizzleDatabase) {}
  
  async createAccountWithRole(data: CreateAccountData, role: string) {
    return this.db.transaction(async (tx) => {
      const account = await tx.insert(identityAccount).values(data);
      await tx.insert(identityAccountRole).values({accountId: account.id, role});
      return account;
    });
  }
}
```

### Technology Selection Guidelines

| Criteria | Use Knex.js | Use Drizzle ORM |
|----------|-------------|-----------------|
| **Data Complexity** | Simple key-value, binary data | Structured business objects |
| **Performance Needs** | High-throughput, streaming | Standard CRUD operations |
| **Type Safety** | Infrastructure (stable APIs) | Business logic (frequent changes) |
| **Cross-DB Support** | Must work on SQLite+PostgreSQL | PostgreSQL primary, SQLite optional |
| **Development Team** | Framework maintainers | Business feature developers |
| **Query Complexity** | Custom SQL, optimized queries | Standard relationships, joins |

### Migration Strategy

**Bottom-up approach**: Infrastructure components can gradually adopt Drizzle without breaking existing functionality:

1. **Keep stable infrastructure on Knex**: SQLUp, Quadstore backends
2. **New business features use Drizzle**: Account management, admin APIs
3. **Gradual migration**: Move business logic from Knex to Drizzle as needed
4. **No forced unification**: Mixed approach is acceptable long-term

This strategy provides **performance where needed** and **developer experience where it matters most**.

## Development Guidelines

### Adding New Components

1. **Choose appropriate data layer**:
   - Infrastructure/performance-critical → Knex.js
   - Business logic/type-safety critical → Drizzle ORM
2. **Create TypeScript class** with appropriate CSS decorators
3. **Add to context** by running `yarn build:components`
4. **Configure in JSON-LD** using simplified component names
5. **Add environment variables** following CSS variable naming pattern
6. **Update documentation** in this file and CLAUDE.md

### Testing Components

- **Unit tests**: Test individual component logic
- **Integration tests**: Test component interactions with CSS framework
- **Deployment tests**: Verify components work in target deployment modes
- **Database tests**: Test both Knex and Drizzle components with appropriate databases

### Common Patterns

- **Store Wrappers**: Extend CSS store interfaces for additional functionality
- **Handler Chains**: Use WaterfallHandler pattern for request processing
- **Override Pattern**: Replace default CSS components with Xpod implementations
- **Environment Integration**: Use Variable types for configuration flexibility
- **Layered Data Access**: Infrastructure uses Knex, business logic uses Drizzle
