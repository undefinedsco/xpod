# Xpod Components Guide

This document provides a comprehensive overview of all custom components developed for Xpod, extending the Community Solid Server (CSS) framework.

## 等位替换对照表

Xpod 遵循**等位替换原则**：用自定义组件替换 CSS 同层级的默认组件，保持接口兼容，不破坏 CSS 调用链。

| CSS 默认组件 | Xpod 替换组件 | 功能区别 |
|-------------|--------------|----------|
| `DataAccessorBasedStore` | `SparqlUpdateResourceStore` | 拦截 PATCH 操作，能处理的直接执行 SPARQL UPDATE，不能处理的抛出 `NotImplementedHttpError` 让 CSS 回落到 get-patch-set |
| `RepresentationConvertingStore` | `RepresentationPartialConvertingStore` | **能转尽量转，不能转保留原始**。CSS 默认遇到不能转换的会报错；我们的实现让 JSON、二进制等非 RDF 内容直接通过 |
| `FileDataAccessor` | `MixDataAccessor` | 混合存储：`.ttl` / `.jsonld` 先落真实本地文件作为权威事实，再同步 Quadstore/SPARQL 索引；非结构化文件走 FileSystem/MinIO |
| RDF `DataAccessor` (Local/Standalone) | `SolidRdfDataAccessor` | 从主 RDF 引擎读写；首次启用空索引时先完成旧 quints 数据迁移，再允许 CSS 读取资源及 ACR 元数据 |
| `SparqlDataAccessor` | `QuadstoreSparqlDataAccessor` | 基于 Quadstore + SQLUp 的 SPARQL 存储，支持 SQLite/PostgreSQL/MySQL |
| `BaseLoginAccountStorage` | `DrizzleIndexedStorage` | 数据库存储账户信息，支持集群部署，替代 CSS 的文件存储 |
| `DPoPWebIdExtractor` | `ConfiguredLoopbackDPoPWebIdExtractor` | 保留 issuer、签名、audience/expiry 与完整 DPoP 校验；仅为与 CSS `baseUrl` 完全同源的 HTTP `127/8` 或 `::1` 桌面回环地址放开 upstream 的 localhost-only URI 限制 |
| `PassthroughStore` | `UsageTrackingStore` | 包装 Store，添加带宽/存储用量追踪和限速功能 |
| `ResourceStore` 写入通知边界 | `ObservableResourceStore` + `PostgresDerivedIndexJournal` | Cloud 写成功后、响应返回前追加一条 Pod 级持久化 outbox；FTS/VEC 异步消费且 Pod 内保序。Local 继续复用 SolidFS 文件 journal |
| `HttpHandler` (HandlerServerConfigurator.handler) | `MainHttpHandler` (ChainedHttpHandler) | 用链式中间件替换单一 handler，支持洋葱模型。包含 `TracingMiddleware` (请求追踪) 和可选的 `SignalAwareHttpHandler` (集群模式) |
| `StaticAssetHandler` (`/app/*`) | `AppStaticAssetHandler` | 保留 CSS Account UI 的同源静态路径；内置小型 bundle 不依赖共享异步文件池，以完整 Buffer 响应并等待 HTTP `finish`，避免登录并发期间出现悬空模块请求 |
| `BaseHttpHandler` pipeline extension | `InternalPodDataHttpHandler` | 位于 public CSS handlers 之前，仅接受 loopback + runtime HMAC intent 的 `/.internal/pod-data`，把 allowlisted AI Connection Pod 文档原样委托给 `ResourceStore` |
| `PickWebIdHandler` | `ScopedPickWebIdHandler` | OIDC consent 选择 WebID 时只展示当前 SP 可解析的 Pod，避免 Cloud IdP + Local SP 登录选回 Cloud Pod |
| `PodCreator` | `ProvisionPodCreator` | 保留 CSS 原生 Pod/Profile/授权资源创建，在创建完成后同步 `solid:storage`，canonical storage URL 留在 CSS account Pod 数据中 |

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
                                           ├─ rdfFileDataAccessor → FileDataAccessor (.ttl/.jsonld 权威文件)
                                           ├─ unstructuredDataAccessor → FileDataAccessor/RemoteDataAccessor (普通对象内容)
                                           └─ structuredDataAccessor → QuadstoreSparqlDataAccessor (RDF/SPARQL 索引)
```

## Table of Contents

- [Storage Components](#storage-components)
- [Identity & Authentication](#identity--authentication)
- [Quota & Usage Management](#quota--usage-management)
- [Edge & Cloud Coordination](#edge--cloud-coordination)
- [HTTP Handlers](#http-handlers)
- [Utility Components](#utility-components)

## Storage Components

### SolidRdfDataAccessor / ShadowRdfQuintStore
- **Paths**: `src/storage/accessors/SolidRdfDataAccessor.ts`, `src/storage/rdf/ShadowRdfQuintStore.ts`
- **Deployment**: Local/Standalone 的 `local.json` / `bun.json` 将现有 `QuintStore` 作为可选 `legacyIndex` 注入。Cloud 的 PostgreSQL 存储链不变。
- **Initialization**: 主引擎打开后，等待旧索引迁移完成，才刷新派生索引并响应资源读写；并发初始化共享同一个 Promise。权限检查仍由 CSS 执行，不补写或放宽 ACL/ACR。
- **Recovery boundary**: 自动迁移只填充从未写入的主索引，不清空已有索引。持久化的 `migration:legacy-quints` 状态允许中断后重试；已完成迁移或用户有意删空的索引不得重新导入旧数据。显式管理 backfill 与自动启动迁移分开。
- **Durability**: 默认索引必须随配置的 SQLite 数据目录持久化，不能落入容器临时 runtime 目录。显式索引路径继续优先；详见 `docs/issues/2026-08-28-local-rdf-index-persistence.md`。

### MixDataAccessor
- **Path**: `src/storage/accessors/MixDataAccessor.ts`
- **Purpose**: Unified storage interface combining structured and unstructured data access
- **Functionality**: Keeps line-addressable RDF resources (`.ttl`, `.jsonld`) as real local files first, then parses them into the structured RDF index; routes binary/object content to MinIO/FileSystem
- **Configuration**: Uses `rdfFileDataAccessor` for RDF authority files, `unstructuredDataAccessor` for ordinary object content, and `structuredDataAccessor` for RDF/SPARQL index state
- **Deployment**: All modes. Local can let `rdfFileDataAccessor` default to the same `FileDataAccessor`; cloud pins `rdfFileDataAccessor` to `FileDataAccessor` while `unstructuredDataAccessor` points at `RemoteDataAccessor`

`MixDataAccessor.getData()` intentionally keeps CSS's internal RDF contract by returning `internal/quads` for RDF resources. User-facing HTTP reads and SolidFS/tool reads use the explicit local RDF path (`getLocalRdfDocument()` through `SparqlUpdateResourceStore`) so `cat`, `rg`, `grep`, and editors operate on real `.ttl` / `.jsonld` files instead of hidden DB rows.

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
- **Purpose**: SPARQL query capabilities over the derived RDF index stored in relational databases
- **Environment Variables**: `CSS_SPARQL_ENDPOINT` (supports SQLite, PostgreSQL, MySQL)
- **Functionality**: Stores parsed quads as query/index state, supports SPARQL queries
- **Deployment**: All modes (SQLite locally, PostgreSQL in server)

### RepresentationPartialConvertingStore
- **Path**: `src/storage/RepresentationPartialConvertingStore.ts`
- **Purpose**: Content-type conversion for storage compatibility
- **Functionality**: Converts incoming RDF representations to quads for the CSS internal store path while skipping unnecessary conversions when the representation already satisfies requested preferences
- **Integration**: Used in ResourceStore chains for both local and server modes

### UsageTrackingStore
- **Path**: `src/storage/quota/UsageTrackingStore.ts`
- **Purpose**: Bandwidth and storage usage monitoring wrapper
- **Functionality**: 
  - Tracks ingress/egress bytes for all resource operations
  - Records account/pod-scoped usage in `identity_usage`
  - Applies bandwidth throttling via `createBandwidthThrottleTransform`
- **Deployment**: Server mode only

### PostgresDerivedIndexJournal
- **Path**: `src/storage/PostgresDerivedIndexJournal.ts`
- **Purpose**: CSS subscribe 写入口到 FTS/VEC 派生索引的持久化 outbox
- **Ordering**: 顺序边界是 `(consumerId, Pod)`；同一消费者失败会阻止该 Pod 后续事件，但不重复其他已成功消费者，也不阻止其他 Pod
- **Recovery**: processing lease 超时后只重置对应 consumer delivery；`reconcilePod` 的参数必须是一个 Pod 的完整权威清单，当前路径生成 repair update，已消失路径生成 delete tombstone
- **Consumer**: `RdfDerivedIndexingListener` 使用稳定 ID `rdf-fts-vec-v1`，对每个事件只读取一次资源权威内容，随后更新 `PostgresRdfTextIndex` 与 `PostgresRdfVectorIndex`；两者都成功后才完成该消费者的 delivery
- **Durability**: `derived_index_change_journal` 保存单份不可变事件；`derived_index_consumers` / `derived_index_event_deliveries` 保存独立 retry、lease、done 状态；`derived_index_resource_checkpoints` 保存成功应用到资源的最后事件
- **Delivery**: 采用 at-least-once 语义，因此 FTS/VEC 的 source replace/delete 必须保持幂等
- **Deployment**: Cloud 使用 PostgreSQL；Local 不创建第二份日志，继续由 `SqliteSolidFsSyncJournal` 驱动 composite RDF/text/vector syncer

## Identity & Authentication

### ConfiguredLoopbackDPoPWebIdExtractor
- **Path**: `src/authentication/ConfiguredLoopbackDPoPWebIdExtractor.ts`
- **Purpose**: 让以 `http://127.x.x.x` 或 `http://[::1]` 运行的本地桌面 Xpod 可以使用标准 Solid DPoP access token 访问 Pod。
- **Security boundary**: 仅当 token 的 `webid` 与 `iss`、以及 DPoP 请求 URL 都与 CSS 当前 `baseUrl` 的 HTTP loopback origin 完全一致时启用例外；LAN、不同端口和不同 loopback origin 均拒绝。
- **Verification retained**: 继续验证 WebID 声明的可信 issuer、issuer JWKS 签名、`aud=solid`、token 时间约束、DPoP 公钥 thumbprint、HTTP method/URI、JTI 防重放以及可选 `ath`。
- **Fallback**: HTTPS 与 `localhost` 配置直接使用 upstream `createSolidTokenVerifier()`，不改变现有行为。

### DrizzleIndexedStorage
- **Path**: `src/identity/drizzle/DrizzleIndexedStorage.ts`
- **Purpose**: CSS IndexedStorage adapter for account authentication and management
- **Table**: `identity_store(container, id, payload)`
- **Containers**:
  - `account` - User account payload, including account-level role flags.
  - `pod` - Pod metadata and ownership mapping.
  - `owner` / `webIdLink` - CSS account links used to resolve WebID and storage relationships.
- **Functionality**: Account creation, authentication, Pod links, and role lookup without side tables.
- **Deployment**: Server mode (PostgreSQL) and local testing (SQLite).

### ScopedPickWebIdHandler
- **Path**: `src/identity/oidc/ScopedPickWebIdHandler.ts`
- **Purpose**: Keep OIDC WebID selection scoped to the selected storage provider.
- **Functionality**:
  - Standard Cloud/Standalone login: filters linked WebIDs by Pods known to the current issuer/storage provider.
  - Cloud IdP + Local SP login: decodes `provisionCode`, calls the Local SP `/provision/webids` endpoint with the service token, and only returns WebIDs that the Local SP can resolve.
  - Rejects submitted WebIDs that belong to the account but are not resolvable by the current SP.
- **Boundary**: `/{pod}/profile/card` remains CSS-native. Xpod does not proxy WebID profile documents through the API server.

### CssPodOwnershipResolver
- **Path**: `src/identity/oidc/PodOwnershipResolver.ts`
- **Purpose**: Resolve account WebID ownership through the CSS `WebIdStore` and `PodStore` already managed by the current runtime.
- **Functionality**:
  - Lists WebIDs linked to the account and matches them to Pods owned by that account.
  - Verifies local Pod placement against the selected storage root without opening a second identity database connection.
  - Verifies remote Pod ownership through the provision lookup endpoint when a lookup URL and service token are supplied.
- **Boundary**: The resolver only returns ownership entries that can be established by the CSS stores or authenticated remote lookup; it does not inspect Pod files directly.
- **Deployment**: All modes through `config/xpod.base.json`.

### ProvisionPodCreator
- **Path**: `src/provision/ProvisionPodCreator.ts`
- **Purpose**: Extend CSS Pod creation without replacing the account/consent flow.
- **Functionality**:
  - Leaves `PodResourcesGenerator` untouched so the installed CSS version is the sole owner of native Pod files and the public `profile/card` ACP/WAC rules.
  - After CSS finishes creating a same-origin Pod, adds or updates only the Xpod-specific `solid:storage` relation in the CSS-native profile card.
  - Keeps `solid:oidcIssuer` under CSS ownership. In Cloud WebID + Local SP mode the WebID subject and issuer stay on Cloud, while `solid:storage` points at the selected Local SP.
  - In remote provisioning, verifies the signed receipt from the Pod that the Account UI prepared on the selected SP before entering CSS's Account resource lock, then records the canonical Cloud-issued storage URL in CSS account Pod data. The creator performs no cross-service network call and no remote profile read/write while that lock is held.
  - Removes `provisionCode` before handing settings to CSS Pod storage.
- **Deployment**: All modes through `config/xpod.base.json`.

### ProvisionStatusHandler
- **Path**: `src/api/handlers/ProvisionHandler.ts`
- **Purpose**: Expose the selected Local SP provision status to LinX and refresh short-lived `provisionCode` values.
- **First-run behavior**: Local starts with the official Cloud API default (`https://api.undefineds.co`). If no `nodeToken`/`serviceToken` is configured or restored, API startup auto-registers the Local node with Cloud `/provision/nodes`, persists the returned `nodeId`/`nodeToken`/`serviceToken`/`provisionCode`, and then registers Local provision routes in the same process. The request is bounded by `XPOD_LOCAL_AUTO_PROVISION_TIMEOUT_MS` (default 5000ms) and can be disabled with `XPOD_LOCAL_AUTO_PROVISION=false` for hermetic standalone/test runs.
- **Boundary**: Long-lived Local setup/provision state is a single local setup JSON. `XPOD_LOCAL_SETUP_PATH` can override the path; otherwise it defaults to `${CSS_ROOT_FILE_PATH}/.xpod-cloud-registration.json`. `XPOD_PROVIDER_ID` can override the key; otherwise it defaults to `local`. `XPOD_ENV_PATH` is only the runtime input file for process startup; it must not become a second persistent authority for node credentials, canonical SP URL, or refreshed provision tokens.
- **Storage split**: Local stores its own setup/provision state in that setup file. Cloud stores cluster-coordinated state that needs uniqueness/indexes/concurrency in Cloud cluster tables (`cluster_node`, `cluster_ddns_record`, `cluster_service_token`). Do not persist Local setup-only state into Cloud cluster tables, and do not model Cloud cluster records as identity business tables.

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

### EdgeNodeSignalHandler (API Server)
- **Path**: `src/api/handlers/EdgeNodeSignalHandler.ts`
- **Purpose**: Edge node heartbeat API (nodeToken + WebID 双认证)
- **Endpoints**: `POST /v1/signal`
- **Functionality**:
  - Node heartbeat handling (nodeToken / WebID 认证)
  - 健康检查 → DNS 同步
  - Status monitoring
- **Deployment**: API Server (cloud + local)

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

### InternalPodDataHttpHandler
- **Path**: `src/http/InternalPodDataHttpHandler.ts`
- **Purpose**: Hosted-Pod-only internal data channel for AI Connection Credential, Provider, and QuotaSnapshot documents
- **Endpoint**: `/.internal/pod-data`
- **Functionality**:
  - Requires loopback transport and the runtime-generated `XPOD_GATEWAY_ADMIN_PROXY_AUTH_SECRET`
  - Verifies HMAC intent bound to owner WebID, method, resource URL, principal kind, scopes, timestamp, and nonce
  - Rejects missing, forged, expired, replayed, non-loopback, owner-mismatched, or non-allowlisted requests with 404
  - Delegates GET/PUT/DELETE bodies to `ResourceStore` without logging payload fields such as `secretPayload`; PATCH is parsed by CSS `PatchBodyParser` before `modifyResource`
  - Authorized internal operations use request-scoped direct data reads, so object-storage JSON bodies are streamed instead of becoming browser presigned-download redirects; public download redirects and owner/scope checks remain unchanged
- **Pipeline position**: First handler in local/cloud `BaseHttpHandler` waterfall, before public SPARQL, terminal, static, OIDC, and LDP handling
- **Deployment**: Local and cloud hosted Pods only

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
    const account = await this.identityStore.createAccount({
      ...data,
      roles: [role],
    });
    return account;
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
