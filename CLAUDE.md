<!-- OPENSPEC:START -->
# OpenSpec Instructions

These instructions are for AI assistants working in this project.

Always open `@/openspec/AGENTS.md` when the request:
- Mentions planning or proposals (words like proposal, spec, change, plan)
- Introduces new capabilities, breaking changes, architecture shifts, or big performance/security work
- Sounds ambiguous and you need the authoritative spec before coding

Use `@/openspec/AGENTS.md` to learn:
- How to create and apply change proposals
- Spec format and conventions
- Project structure and guidelines

Keep this managed block so 'openspec update' can refresh the instructions.

<!-- OPENSPEC:END -->

# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Xpod is an extended Community Solid Server (CSS) offering rich-feature, production-level Solid Pod and identity management. It supports multiple deployment modes: normal (experience only), local (desktop/single-machine), server (centralized deployment), and dev (development/debugging).

## Community Solid Server (CSS) Architecture

### Dependency Injection Framework
Community Solid Server uses **Components.js** for dependency injection with JSON-LD configuration:
- Components are defined in TypeScript classes with decorators
- Configuration files (`config/*.json`) wire dependencies together
- **Initialization sequence**: Component discovery → Registration → Configuration parsing → Instantiation
- **Handler chains**: Waterfall pattern where each handler can accept/reject requests via `canHandle()`

### Core Handler Pattern
```typescript
class MyHandler extends HttpHandler {
  async canHandle(input: HttpHandlerInput): Promise<void> {
    // Throw error if cannot handle, return void if can handle
    if (!this.matchesCondition(input)) {
      throw new NotImplementedHttpError('Cannot handle this request');
    }
  }
  
  async handle(input: HttpHandlerInput): Promise<void> {
    // Process the request
  }
}
```

### Configuration Architecture
- **JSON-LD based**: Uses semantic web standards for component wiring
- **Environment variables**: Injected via `urn:solid-server:default:variable:` pattern
- **Override pattern**: Replace default CSS components with custom implementations
- **Import chains**: Base configurations import specialized configurations
- **Context mapping**: Simplified component names mapped to full IRIs in `context.jsonld`

### Storage Abstraction
- **DataAccessor interface**: Abstract storage operations (read/write/delete)
- **Store layers**: Higher-level operations (ResourceStore, RepresentationStore)
- **Identifier mapping**: URLs to storage paths via IdentifierStrategy
- **Metadata handling**: Auxiliary resources, content types, permissions

### Request Processing Pipeline
1. **HTTP Server** receives request
2. **HttpHandler chain** processes via waterfall pattern
3. **Authentication/Authorization** extracts and validates credentials
4. **Resource operations** via Store abstractions
5. **Response generation** with appropriate headers/content

### Key Extension Points
- **HttpHandlers**: Custom request processing logic
- **DataAccessors**: Custom storage backends
- **Stores**: Business logic layers
- **Initializers**: Startup/teardown procedures
- **Authentication**: Custom auth mechanisms

### ⚠️ Xpod 扩展原则：等位替换

**核心原则**：不修改 CSS 原始架构，采用**等位替换**方式扩展功能。

- **等位替换**：用自定义组件替换 CSS 同层级的默认组件，保持接口兼容
- **好处**：大部分 CSS 配置无需修改，降低维护成本，便于升级
- **详细文档**：参见 `docs/COMPONENTS.md` 的"等位替换对照表"
- **示例**：
  - `SparqlUpdateResourceStore` 替换 `DataAccessorBasedStore`（拦截 PATCH）
  - `RepresentationPartialConvertingStore` 替换 `RepresentationConvertingStore`（能转尽量转，不能转保留原始）
  - `MixDataAccessor` 替换 `FileDataAccessor`（混合存储）

```
CSS 调用链（保持不变）:
MonitoringStore → IndexRepresentationStore → LockingResourceStore
    → PatchingStore → RepresentationConvertingStore → [我们替换这里]

Xpod 替换点:
- DataAccessorBasedStore → SparqlUpdateResourceStore（拦截 PATCH）
- FileDataAccessor → MixDataAccessor / QuadstoreSparqlDataAccessor
```

**PATCH 处理策略**：
```
PatchingStore.modifyResource(patch):
  1. 先问 Store: "你能处理这个 patch 吗？" (store.modifyResource)
  2. 如果 Store 能处理 → 直接让 Store 执行
  3. 如果 Store 不能处理 → 回落到通用逻辑 (get → patch → set)
```

这就是为什么 `SparqlUpdateResourceStore.modifyResource()` 可以拦截 PATCH：
- 能处理的（SPARQL UPDATE）→ 直接执行 SPARQL
- 不能处理的 → 抛出 `NotImplementedHttpError`，CSS 自动回落到 read-modify-write

**禁止**：
- ❌ 修改 CSS 中间层逻辑
- ❌ 在非标准位置插入处理逻辑
- ❌ 破坏 CSS 的 Handler 链顺序

### Xpod's Community Solid Server Extensions

**Storage Enhancements:**
- `MixDataAccessor`: Hybrid storage (structured data in database, files in MinIO)
- `MinioDataAccessor`: S3-compatible object storage backend
- `PostgresKeyValueStorage`: PostgreSQL-backed key-value store for clustering
- `UsageTrackingStore`: Bandwidth monitoring wrapper around stores

**Identity & Multi-tenancy:**
- `DrizzleAccountLoginStorage`: Database-backed account management
- Role-based access control via `identity_account_role` table
- Pod-level resource isolation and quota enforcement

**Management & Monitoring:**
- Legacy Admin Console 已移除；所有管理操作需通过公开 API/Portal
- `QuotaAdminHttpHandler`: Quota management API
- `SubgraphSparqlHttpHandler`: Per-account SPARQL endpoints with usage tracking

**Edge Computing:**
- `EdgeNodeSignalHttpHandler`: Coordinate distributed edge nodes
- `EdgeNodeDnsCoordinator`: Dynamic DNS management
- `Dns01CertificateProvisioner`: Automatic ACME certificate provisioning
- `FrpTunnelManager`: NAT traversal via FRP tunnels

**Feature Toggle Pattern:**
```typescript
// Components load regardless of config, but check enabled flag at runtime
async canHandle(input: HttpHandlerInput): Promise<void> {
  if (!this.enabled) {
    throw new NotImplementedHttpError('Feature disabled');
  }
  // ... normal canHandle logic
}
```

## Common Commands

### Build Commands
```bash
yarn build           # Full backend build (TypeScript + Components)
yarn build:ts        # TypeScript compilation only
yarn build:ui        # UI build using Vite
yarn build:components # Generate Components.js files
```

### Run Commands
```bash
yarn start          # Normal mode (SQLite + local files, immediate start)
yarn dev            # Dev mode (no auth, SQLite + MinIO for API/frontend debugging)
yarn local          # Local mode (SQLite + local disk, quotas disabled)
yarn server         # Server mode (PostgreSQL + MinIO + Redis, cloud-edge capabilities)
```

### Development Commands
```bash
yarn watch:css      # Auto-rebuild and restart local mode on file changes
yarn watch:css:dev  # Auto-rebuild and restart dev mode on file changes
yarn watch:css:server # Auto-rebuild and restart server mode on file changes
```

### Testing
```bash
yarn test           # Run tests in watch mode
yarn test:run       # Run tests once (no watch mode)  
yarn test:coverage  # Run tests with coverage report
yarn test:integration # Run all tests including integration tests
yarn test:all       # Run all tests with coverage
```

**Test Categories:**
- **Unit Tests**: Always run, test individual components
- **Integration Tests**: Require `XPOD_RUN_INTEGRATION_TESTS=true` and database
- **Server Login Tests**: Require `XPOD_RUN_SERVER_INTEGRATION=true` and running server

**Current Test Status:**
- 116+ tests total (113+ passing)
- ✅ **Storage**: PostgresKeyValueStorage, Redis, MixDataAccessor, Quota systems
- ✅ **HTTP Handlers**: Admin, Quota, Edge node APIs
- ✅ **UI Components**: React component tests
- ✅ **Identity Management**: Account repositories, roles
- ✅ **Server Login**: Database-backed authentication (NEW)
- ❌ **Missing**: End-to-end CRUD, multi-mode startup testing

**Integration Test Requirements:**
- PostgreSQL database running for DrizzleAccountLoginStorage tests
- Server running at localhost:3000 for ServerLogin tests
- Set environment variables: `XPOD_RUN_INTEGRATION_TESTS=true XPOD_RUN_SERVER_INTEGRATION=true`

**Seed Account Setup for Testing:**
For integration tests that require test accounts, enable seed configuration:
- **All modes**: Uncomment `CSS_SEED_CONFIG=./config/seeds/test.json` in your env file (`.env.server`, `.env.local`, etc.)

This creates a test account (`test-integration@example.com`) for authentication flows without manual account creation.

### Environment Setup
Copy and configure environment files based on deployment mode:
```bash
cp example.env .env.local   # For local/dev modes
cp example.env .env.server  # For server/production mode
```

## Architecture Overview

### Core Components

**Storage Layer:**
- `MinioDataAccessor` - Handles object storage using MinIO (src/storage/accessors/MinioDataAccessor.ts)
- `QuadstoreSparqlDataAccessor` - SPARQL query capabilities over data stored in Quadstore (src/storage/accessors/QuadstoreSparqlDataAccessor.ts)
- `MixDataAccessor` - Unified interface integrating multiple data access methods; structured resources in databases, unstructured in MinIO (src/storage/accessors/MixDataAccessor.ts)
- `RepresentationPartialConvertingStore` - Converts resources for compatibility across storage formats (src/storage/RepresentationPartialConvertingStore.ts)

**Identity & Authentication:**
- `DrizzleAccountLoginStorage` - Database-backed account authentication using Drizzle ORM (src/identity/drizzle/)
- Account roles stored in `identity_account_role` table with admin authorization checks

**Quota & Usage Management:**
- `DefaultQuotaService` / `DrizzleQuotaService` / `NoopQuotaService` - Different quota enforcement strategies (src/quota/)
- `PerAccountQuotaStrategy` - Per-account quota limits (src/storage/quota/PerAccountQuotaStrategy.ts)
- `UsageTrackingStore` - Tracks bandwidth usage with ingress/egress metrics (src/storage/quota/UsageTrackingStore.ts)
- `createBandwidthThrottleTransform` - Network bandwidth limiting helper (src/util/stream/BandwidthThrottleTransform.ts)

**Edge & Cloud Coordination:**
- `EdgeNodeAgent` - Coordinates local nodes with server instances (src/edge/EdgeNodeAgent.ts)
- `EdgeNodeDnsCoordinator` - DNS management for edge nodes (src/edge/EdgeNodeDnsCoordinator.ts)
- `Dns01CertificateProvisioner` - Automatic ACME certificate management (src/edge/Dns01CertificateProvisioner.ts)
- `FrpTunnelManager` - FRP tunnel management for nodes behind NAT (src/edge/FrpTunnelManager.ts)

**HTTP Handlers:**
- `QuotaAdminHttpHandler` - Quota management API (src/http/quota/QuotaAdminHttpHandler.ts)
- `EdgeNodeSignalHttpHandler` - Edge node coordination API (src/http/admin/EdgeNodeSignalHttpHandler.ts)
- `EdgeNodeProxyHttpHandler` / `EdgeNodeRedirectHttpHandler` - Pod proxy & debugging redirect (src/http/**)
- `SubgraphSparqlHttpHandler` - SPARQL query endpoint with usage tracking (src/http/SubgraphSparqlHttpHandler.ts)

### Configuration Architecture

The project uses JSON-LD configuration files in `config/` directory:
- `main.json` / `main.dev.json` / `main.local.json` / `main.server.json` - Core server configurations
- `extensions.json` / `extensions.dev.json` / `extensions.local.json` / `extensions.server.json` - Extension configurations
- Configuration follows CSS (Community Solid Server) dependency injection patterns

### Database Schema

Uses Drizzle ORM with support for SQLite (local/dev) and PostgreSQL (server):
- Account management in `src/identity/drizzle/schema.ts`
- Usage tracking tables for bandwidth monitoring
- Role-based access control via `identity_account_role` table

### KeyValueStorage Design Decision

Xpod implements `KeyValueStorage` with unified TEXT-based JSON storage for maximum database compatibility:

**Design Choice: TEXT vs JSONB**
- **Decision**: Use `TEXT` columns storing JSON strings instead of PostgreSQL's `JSONB`
- **Rationale**: 
  - **Cross-database compatibility**: Works with SQLite, PostgreSQL, MySQL
  - **Simplified data handling**: Consistent JSON.parse/stringify across all databases
  - **Deployment flexibility**: Same codebase works in local (SQLite) and production (PostgreSQL) modes
  - **Performance acceptable**: KeyValueStorage used for sessions/config, not complex queries

**Implementation Pattern**:
```typescript
// Schema (compatible with both PostgreSQL and SQLite)
CREATE TABLE internal_kv (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,  -- JSON string, not JSONB
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

// Data handling
set(key, value) { 
  const payload = JSON.stringify(value);
  // Store as TEXT
}
get(key) {
  const raw = /* SELECT value */;
  return JSON.parse(raw); // Always parse from string
}
```

**Trade-offs Accepted**:
- ❌ No PostgreSQL JSON operators (`@>`, `?`, etc.)  
- ❌ No JSON-specific indexing capabilities
- ✅ Universal database support
- ✅ Simplified deployment and testing
- ✅ Consistent behavior across environments

This design prioritizes **operational simplicity** over **query performance** for Xpod's use cases.

### Deployment Modes

**Local Mode:** SQLite + local filesystem, no external dependencies, quotas disabled by default
**Server Mode:** PostgreSQL + MinIO + Redis, supports horizontal scaling, full quota enforcement
**Dev Mode:** SQLite + MinIO, no authentication, designed for API/frontend development

### Admin and Security

- Admin roles stored in database `identity_account_role` table
- Bearer token authentication required for admin endpoints
- Reserved pod names: `admin`, `quota`, `signal` (prevented during creation)
- Admin seed configuration via `CSS_SEED_CONFIG` or `--seedConfig`

## Development Notes

- Uses TypeScript with strict configuration
- Component generation via `componentsjs-generator` for dependency injection
- UI built with React, Vite, and Tailwind CSS
- Testing with Vitest, supports both Node.js and jsdom environments
- Environment-specific configurations allow same codebase to run in different modes
- Cloud-edge coordination enables dynamic DNS, certificate management, and tunneling

### Database Architecture Strategy

Xpod employs a **layered database approach** combining different ORMs:

**Infrastructure Layer (Knex.js)**:
- SQLUp universal key-value storage (SQLite/PostgreSQL/MySQL)
- Quadstore RDF backend with binary/streaming support  
- Performance-critical components requiring direct SQL control
- Cross-database compatibility for deployment flexibility

**Business Logic Layer (Drizzle ORM)**:
- Account and identity management with full type safety
- Pod metadata and relationship handling
- Admin APIs with complex business queries
- New feature development with TypeScript-first approach

**Selection Criteria**: Use Knex for infrastructure/performance, Drizzle for business logic/type safety. See `docs/COMPONENTS.md` for detailed guidelines.

## JSON-LD Configuration Guidelines

**CRITICAL**: When modifying component configurations in `config/*.json` files, follow these rules:

### Component Type Names
- Use **simplified** type names (e.g., `"@type": "TencentDnsProvider"`)
- **NOT** full paths (e.g., `"@type": "npmd:@undefineds/xpod/^0.0.0/dist/dns/tencent/TencentDnsProvider.jsonld#TencentDnsProvider"`)

### Parameter Names
- Use **constructor argument names** from the component definition (e.g., `"tokenId"`, `"provider"`)
- **NOT** parameter IDs (e.g., `"options_tokenId"`, `"ComponentName:parameterName"`)
- Check `dist/components/context.jsonld` for the correct mapping

### Common Configuration Patterns
```json
{
  "@type": "TencentDnsProvider",
  "tokenId": { "@id": "urn:...", "@type": "Variable" },
  "token": { "@id": "urn:...", "@type": "Variable" }
}
```

### Environment Variable Mapping
When adding new environment variables, ensure the variable names match exactly:
- Configuration uses: `"@id": "urn:solid-server:default:variable:xpodTencentDnsTokenId"`
- Environment file needs: `CSS_XPOD_TENCENT_DNS_TOKEN_ID=value`
- Pattern: `urn:solid-server:default:variable:` prefix maps to `CSS_` prefix
- CamelCase in config → SCREAMING_SNAKE_CASE in env file

### Debugging JSON-LD Errors
1. "Invalid predicate IRI" → Check parameter names against component context
2. "Undefined variable" → Add missing environment variables to `.env.*` files  
3. Component type not found → Use simplified type name from context.jsonld
4. Variable name mismatch → Verify env var name matches config exactly (case-sensitive)

### Common Configuration Mistakes
1. **Wrong parameter format**: Using `"ComponentName:parameterName"` instead of `"parameterName"`
2. **Environment variable case mismatch**: `tokenId` in config must be `TOKEN_ID` in env (not `token_id`)
3. **Missing Variable type**: Forgot `"@type": "Variable"` for environment variables
4. **Full vs simplified type names**: Using complete jsonld path instead of context-defined name
5. **Incorrect @id format**: Environment variables must follow `urn:solid-server:default:variable:` pattern

## 新组件导出步骤 (Components.js)

当添加新的组件类时，必须按以下步骤确保 Components.js 能够自动发现：

### 1. 创建组件类
```typescript
// src/http/MyNewHandler.ts
export class MyNewHandler extends HttpHandler {
  // 组件实现
}
```

### 2. 【关键】添加到主导出文件
```typescript
// src/index.ts
import { MyNewHandler } from './http/MyNewHandler';

export { 
    // ... 其他导出
    MyNewHandler,  // 必须添加到导出列表
    // ... 其他导出
};
```

### 3. 重新构建
```bash
yarn build:ts          # TypeScript编译
yarn build:components   # 生成Components.js配置
```

### 4. 配置中使用简化名称
```json
{
  "@type": "MyNewHandler", 
  "identityDbUrl": {
    "@id": "urn:solid-server:default:variable:identityDbUrl",
    "@type": "Variable"
  }
}
```

### 常见错误
- **忘记添加到 `src/index.ts`** → 组件不会被发现，配置时出现 "Invalid predicate IRI" 错误
- **手动修改 `dist/` 下文件** → 构建时被覆盖
- **使用 `options_` 前缀** → 应使用简化参数名（如 `identityDbUrl` 而不是 `options_identityDbUrl`）

### 验证成功
- `dist/components/components.jsonld` 包含组件导入
- `dist/components/context.jsonld` 包含参数映射  
- 服务器启动无 "Invalid predicate IRI" 错误

### Seed Account Management
- Seed accounts are controlled by `SeededAccountInitializer` in the initialization sequence
- Remove from `config/xpod.json` handlers array to disable automatic seeding
- Seed files are in `config/seeds/` but won't be used without the initializer
