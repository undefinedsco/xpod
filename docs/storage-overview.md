# Xpod 存储结构概览

Xpod 基于 Community Solid Server（CSS）扩展了一套分层存储模型：Pod 资源走 RDF/对象存储，身份、配额等结构化数据落 PostgreSQL，所有临时态/票据统一进入 PostgreSQL `internal_kv` 或 Redis。自 v0.1 起，不再需要共享 `.internal` 目录即可完成无盘集群部署。

## 1. 存储组件概览

| 类型 | 主要用途 | 默认后端 | 关键环境变量 |
| --- | --- | --- | --- |
| Pod 资源 (LDP/RDF) | 用户数据、ACL/ACP | Quadstore/PostgreSQL + MinIO | `CSS_SPARQL_ENDPOINT`、MinIO 四件套 |
| 身份/配额/边缘节点 | 账户、登录索引、配额、节点登记 | PostgreSQL (`identity_*` 表) | `CSS_IDENTITY_DB_URL` |
| 内部元数据 (`/.internal`) | setup 状态、keystore、临时令牌 | PostgreSQL `internal_kv` + Redis | `CSS_IDENTITY_DB_URL`、Redis 三件套 |

所有实例只要连接到同一套 PostgreSQL / Redis / MinIO，即可实现无盘运行。

## 2. `/.internal` 状态映射

| 原始路径 | 现有去向 | 说明 |
| --- | --- | --- |
| `/.internal/setup/**`、`/.internal/idp/keys/**` 等 | PostgreSQL `internal_kv`（经 `PostgresKeyValueStorage`） | 通过 Components.js 覆盖的 `RegexRouterRule` + KeyValueStorage 链条自动写入，无需额外维护文件 |
| 账户、Pod、登录索引 (`/.internal/accounts/**`) | PostgreSQL `identity_*` 表（Drizzle 仓储） | `DrizzleAccountLoginStorage`、`AccountRoleRepository` 等组件直接写入结构化表，不再落盘 |
| `/.internal/idp/adapter/**` | Redis `/.internal/idp/adapter/…` 命名空间 | OIDC 授权码、Refresh Token、Device Code 启用 TTL |
| `/.internal/accounts/forgot-password/**`、`/.internal/accounts/cookies/**` | Redis | 忘记密码与登录 Cookie 皆走 `WrappedExpiringStorage` + Redis |
| 其余 CSS 模板/静态文件 | 包含在容器镜像/源码中 | 默认不会在运行期落盘；如需自定义模板，可直接在配置目录管理 |

因此，多节点部署时无需挂载共享磁盘；只要确保数据库与 Redis 正常即可。

## 3. 集群部署流程（无盘）

1. **准备共享服务**
   - PostgreSQL：创建 `identity_*`、`internal_kv` 所在数据库；保证账号具有 `CREATE TABLE`、`ALTER TABLE`、`INSERT/UPDATE/DELETE` 权限。
   - Redis：提供 5.x+ 实例，开启持久化（AOF/RDB）以便重启后保留票据信息。
   - MinIO/S3：按原有对象存储要求配置。
2. **环境变量**（示例）
   ```bash
   CSS_IDENTITY_DB_URL=postgresql://user:pass@pg-host:5432/xpod_identity
   CSS_REDIS_CLIENT=redis-host:6379
   CSS_REDIS_USERNAME=default
   CSS_REDIS_PASSWORD=******                # 如无 ACL，可留空
   CSS_SPARQL_ENDPOINT=postgresql://...      # Quadstore 或外部 SPARQL
   MINIO_* 变量同原有说明
   ```
3. **编译组件**：`yarn build && yarn build:components`
4. **启动任意实例**：`yarn server`（或 `community-solid-server -c config/main.server.json …`）。所有实例指向同一套 PostgreSQL/Redis 后即可水平扩展。

> 说明：旧版本遗留的 `css_internal_kv` 表可在验证无误后删除。

## 4. 跨区域场景

- **数据层多活**：PostgreSQL 与 Redis 可使用自身的主从/集群方案。MinIO 推荐使用同 REGION 部署或开启联邦复制。
- **Pod 资源传输**：跨区域时，优先使用边缘节点能力（见《edge-node-control-plane.md》）就近下发；必要时可对 `CSS_SPARQL_ENDPOINT` 做读写分离。
- **备份与审计**：建议定期导出 `identity_*`、`internal_kv` 与 Redis Snapshot，保证 OIDC keystore 等关键信息可恢复。

## 5. 后续演进方向

- engine 层进一步抽象 Pod 模板等静态资源，完全消除对 `.internal/pods/*` 的隐式依赖。
- 评估 OIDC keystore 外部托管（KMS/Secrets Manager），降低数据库压力。
- 将集群部署脚本与 Terraform/Helm 模板同步维护，确保默认即为无盘配置。

> 小贴士：应用层不要直接访问 `/.internal`，请复用已暴露的 API 或仓储类；如需扩展，建议新增 KeyValue/ResourceStore 组件，避免重新引入本地文件依赖。
