# Xpod Admin 架构总览

本文梳理当前 Admin Console/相关 Handler 提供的能力：账号巡检、节点心跳查看、Quota 配置、静态前端托管等，便于理解 CSS 侧的装配和依赖链路。后续在做功能拆分或迁移时，可据此识别哪些逻辑需要同步调整。

---

## 1. CSS 组件装配总览

1. **入口配置 (`config/main*.json`)**
   - 每个环境（`main.json`、`main.local.json`、`main.dev.json`、`main.server.json`）都先引入 CSS 官方的 `css:config/**` 片段，再引用我们定义的 `./logging/configurable.json`（统一日志工厂）以及运行时扩展包（`config/extensions*.json`）。
2. **环境扩展 (`config/extensions*.json`)**
   - 所有扩展文件都会 `import "./xpod.json"`，以加载 Xpod 自定义组件。
   - 按环境再叠加额外 Override，例如 `extensions.local.json` 把 SPARQL 后端切换到 Quadstore、`extensions.dev.json` 覆盖 MinIO 配置。
3. **核心扩展 (`config/xpod.json`)**
   - 定义自研的数据访问器、HTTP 处理器、以及一个 `Override` 覆盖 `urn:solid-server:default:BaseHttpHandler` 的 handler 链。
- 自定义 handler 被插入在 CSS 默认链路前，从而优先拦截 `/admin/**`、`.sparql` 等路径；未命中的请求仍会落到 CSS 原生的 OIDC、LDP 处理器。

> **BaseHttpHandler 链顺序（覆盖后）**
> **注意：** 当前默认配置已禁用 `AdminConsoleHttpHandler` 与 `QuotaAdminHttpHandler`，如需启用请在自定义扩展中重新挂载。

> 1. `AdminConsoleHttpHandler`（默认禁用；`/admin`）
> 2. `EdgeNodeSignalHttpHandler`（默认未启用；`/signal`）
> 3. `QuotaAdminHttpHandler`（默认禁用；`/api/quota/**`）
> 4. `SubgraphSparqlHttpHandler`（`*.sparql`）
> 5. CSS 默认链：Static → OIDC → Notifications → StorageDescription → AuthResource → IdentityProvider → EdgeNodeRedirect（默认禁用，仅调试用途）→ LDP

---

## 2. 自定义组件一览

| 组件类型 | 标识 | 关键实现 | 作用 |
| --- | --- | --- | --- |
| 数据访问 | `QuadstoreSparqlDataAccessor`, `MinioDataAccessor`, `MixDataAccessor` | `src/storage/accessors/**` | 统一结构化（Quadstore/SQLite/Postgres）与非结构化（MinIO）资源访问 |
| 数据装饰 | `RepresentationPartialConvertingStore`, `UsageTrackingStore`, `PerAccountQuotaStrategy` | `src/storage/**` | 支持 RDF 转换、配额统计、账号配额策略 |
| HTTP Handler | `AdminConsoleHttpHandler`（默认禁用）、`EdgeNodeSignalHttpHandler`（默认禁用）、`QuotaAdminHttpHandler`（默认禁用）、`EdgeNodeRedirectHttpHandler`（默认禁用，仅调试）、`SubgraphSparqlHttpHandler` | `src/http/**` | 暴露管理/边缘节点/子图能力；默认仅启用子图与基础链路 |
| 工具 | `ConfigurableLoggerFactory`, `DebugRedisLocker`, `SubgraphQueryEngine` | `src/logging/**`, `src/util/**`, `src/storage/sparql/**` | 自定义日志、调试锁器、包装 Comunica 查询引擎 |

---

## 3. Admin Console HTTP 流程

文件参考：`src/http/admin/AdminConsoleHttpHandler.ts`

1. **匹配逻辑**
- `canHandle`：路径命中 `/admin` 或其子路径才会处理，否则抛出 `NotImplementedHttpError` 交回给后续 handler。
   - 构造函数中会读取：
     - `identityDbUrl`：通过 `getIdentityDatabase` 建立 SQLite / Postgres 链接。
     - `credentialsExtractor`、`permissionReader`、`authorizer`：沿用 CSS 认证授权链。
     - `staticDirectory`：默认 `dist/ui/admin`，用于托管前端构建产物。
     - `edition`、`signalEndpoint`、`edgeNodesEnabled`：通过 CLI/ENV 注入，用于 UI 配置。

2. **API 端点**
- `/admin/config`：返回 UI 启动需要的元信息（部署模式、特性开关、公共 baseUrl、信令端点）。
- `/admin/accounts`、`/admin/pods`：调用 `AdminConsoleRepository` 查询账号/Pod 概览。
- `/admin/nodes`：
     - `GET`：列出已注册边缘节点。
     - `POST`：创建新的边缘节点记录，需要 `write` 权限。
   - 所有 API 都要求通过 CSS 授权检查 (`authorize()`)，确保只有拥有对应权限的认证客户端才可访问。

3. **静态资源托管**
   - 未命中 API 时通过 `serveStatic` 返回 `dist/ui/admin` 内的静态文件，且显式写入 `200` 状态码，避免 CSS 默认的 404 覆盖。
   - 支持 SPA fallback：找不到具体文件时自动退回 `index.html`，给前端路由使用。
   - 为保证安全，`sanitize` + `path.resolve` 防止目录穿越。
   - 调整前端静态页后，请依次执行 `yarn build:ui && yarn build:ts && yarn build:components`，再重启 CSS。若静态目录为空或未重建，会表现为 404 或空白页。
   - 注意：控制台默认受管理员角色保护。若未登录或账号无 `admin` 角色，将收到 403。测试或本地调试时，请先按照 6.3 所述在数据库中写入 `roles`。

---

## 4. 前端交互与构建

1. **源码结构**：位于 `ui/admin/`
   - 入口：`src/main.tsx` → React 18 + React Router。
   - 国际化：`src/modules/i18n.ts` 使用 `react-i18next`，默认语言 `en`，支持切换 `zh`。
   - 主题切换：`src/components/ThemeToggle.tsx`，`localStorage[xpod-theme]` 持久化。
   - 页面 & 导航：
- `App.tsx` 首屏 `useEffect` 拉取 `/admin/config`。
     - 根据配置动态挂载导航；`/nodes` 仅在 `features.nodes` 为真时可见。
     - 其余页面（Accounts/Pods/Quota/Security/Logs）目前占位或展示基础信息，可在对应文件扩展。

2. **构建流程**
   - `vite.config.ts`：根目录指向 `ui/admin`，输出产物写入 `dist/ui/admin`。
   - `package.json`：`build:ui = vite build --config vite.config.ts`，总 `build` 脚本会按顺序执行 `build:ts → build:ui → build:components`。
   - 样式：Tailwind（`tailwind.config.ts`）+ PostCSS（`postcss.config.cjs`）。
   - 运行 `yarn build:ui` 后，`AdminConsoleHttpHandler` 才能返回更新后的 UI。

3. **常见现象**
   - UI 未更新：通常是未执行 `yarn build:ui` 或 build 失败；检查输出目录是否存在新文件。
   - 静态资源 404：确认 `dist/ui/admin/index.html` 可访问，以及 handler 未抛出 `NotImplementedHttpError`（检查 `basePath` 配置）。

---

## 5. 其它后端处理器

| Handler | 基础路径 / 行为 | 依赖组件 / 数据表 |
| --- | --- | --- |
| `QuotaAdminHttpHandler` (`src/http/quota/QuotaAdminHttpHandler.ts`) | `/api/quota/accounts/{id}` / `pods/{id}`，支持 `GET/PUT/DELETE` 管理配额；需携带管理员 Bearer Token | 使用 `AccountRepository` 更新配额，并通过 `AccountRoleRepository` 校验 `identity_account.payload.roles` 是否包含 `admin` |
| `EdgeNodeSignalHttpHandler` (`src/http/admin/EdgeNodeSignalHttpHandler.ts`) | `POST /api/signal`，边缘节点上报心跳、元数据、Pod 列表；若 `edgeNodesEnabled=false` 则拒绝 | 验证 token，调用 `EdgeNodeRepository` 更新记录 |
| `EdgeNodeRedirectHttpHandler` (`src/http/EdgeNodeRedirectHttpHandler.ts`) | 调试场景下可手动启用，用于验证节点元数据中的目标地址；生产不再返回 307 给终端用户 | 读取节点元数据与 Pod 映射 |
| `SubgraphSparqlHttpHandler` (`src/http/SubgraphSparqlHttpHandler.ts`) | 匹配 `.sparql` 结尾路径；基于 Comunica 执行子图查询 / 写入，扩展 quota 更新逻辑 | `SubgraphQueryEngine` + `UsageRepository`，对写操作做权限校验、配额刷新 |

---

## 6. 变量、CLI 与环境注入

### 6.1 变量解析链

1. **CLI 定义 (`config/cli.json`)**
   - 通过 `YargsCliExtractor` 新增参数，如 `xpodEdition`、`xpodSignalEndpoint`。
- CSS 启动时可直接 `community-solid-server --xpodEdition server ...`。

2. **变量解析 (`config/resolver.json`)**
   - `CombinedShorthandResolver` 把 CLI / 环境对象映射到 `urn:solid-server:default:variable:*`。
   - 我们为以下变量提供默认值：
     - `identityDbUrl` → `sqlite:./identity.sqlite`
    - `xpodEdition` → `server`
     - `xpodSignalEndpoint` → `""`
     - `xpodEdgeNodesEnabled` → `false`

3. **环境覆盖 (`config/extensions.*.json`)**
   - 若某环境需要强制值（例如本地模式关闭边缘节点），可在对应扩展文件新增 `Literal` Override 或直接通过 `.env` 提供。

### 6.2 常用变量速查表

| 变量 ID | CLI 参数 | 环境变量示例 | 默认值 | 影响范围 |
| --- | --- | --- | --- | --- |
| `identityDbUrl` | `--identityDbUrl` | `CSS_IDENTITY_DB_URL` | `sqlite:./identity.sqlite` | 所有 Drizzle 仓储、Admin/Quota handler |
| `sparqlEndpoint` | `--sparqlEndpoint` | `CSS_SPARQL_ENDPOINT` | `sqlite:./quadstore.sqlite` | Quadstore / MixDataAccessor |
| `xpodEdition` | `--xpodEdition` | `XPOD_EDITION` | `server` | Admin UI 特性开关（quota 模块） |
| `xpodSignalEndpoint` | `--xpodSignalEndpoint` | `XPOD_SIGNAL_ENDPOINT` | `""` | Admin UI 显示边缘信令地址 |
| `xpodEdgeNodesEnabled` | `--xpodEdgeNodesEnabled` | `XPOD_EDGE_NODES_ENABLED` | `false` | Signal 与 Redirect handler 是否启用 |
| `xpodTencentDnsTokenId` | `--xpodTencentDnsTokenId` | `XPOD_TENCENT_DNS_TOKEN_ID` | `""` | DNSPod API Token ID（空值即禁用 DNS 编排） |
| `xpodTencentDnsToken` | `--xpodTencentDnsToken` | `XPOD_TENCENT_DNS_TOKEN` | `""` | DNSPod API Token Secret |
| `xpodTencentDnsBaseUrl` | `--xpodTencentDnsBaseUrl` | `XPOD_TENCENT_DNS_BASE_URL` | `https://dnsapi.cn` | DNSPod API 根地址 |
| `xpodTencentDnsDefaultLineId` | `--xpodTencentDnsDefaultLineId` | `XPOD_TENCENT_DNS_LINE_ID` | `0` | DNSPod 线路 ID（默认「默认」线路） |
| `xpodDnsRootDomain` | `--xpodDnsRootDomain` | `XPOD_DNS_ROOT_DOMAIN` | `""` | 集群托管的根域名（为空跳过 DNS 自动化） |
| `xpodDnsRecordTtl` | `--xpodDnsRecordTtl` | `XPOD_DNS_RECORD_TTL` | `300` | 自动创建记录的 TTL（秒） |
| `xpodFrpServerHost` | `--xpodFrpServerHost` | `XPOD_FRP_SERVER_HOST` | `""` | frps 服务端地址（为空则禁用隧道） |
| `xpodFrpServerPort` | `--xpodFrpServerPort` | `XPOD_FRP_SERVER_PORT` | `7000` | frps 服务端端口 |
| `xpodFrpToken` | `--xpodFrpToken` | `XPOD_FRP_TOKEN` | `""` | frps 认证 Token |
| `xpodFrpProtocol` | `--xpodFrpProtocol` | `XPOD_FRP_PROTOCOL` | `tcp` | frp 代理类型（tcp/http 等） |
| `xpodFrpCustomDomainSuffix` | `--xpodFrpCustomDomainSuffix` | `XPOD_FRP_CUSTOM_DOMAIN_SUFFIX` | `""` | HTTP/HTTPS 自定义域名后缀 |
| `xpodFrpPublicScheme` | `--xpodFrpPublicScheme` | `XPOD_FRP_PUBLIC_SCHEME` | `https` | 隧道入口对外协议 |
| `xpodFrpRemotePortBase` | `--xpodFrpRemotePortBase` | `XPOD_FRP_REMOTE_PORT_BASE` | `""` | （可选）frp 端口分配起点 |
| `xpodFrpRemotePortStep` | `--xpodFrpRemotePortStep` | `XPOD_FRP_REMOTE_PORT_STEP` | `1` | frp 端口分配步长 |
| `xpodTunnelEntrypoints` | `--xpodTunnelEntrypoints` | `XPOD_TUNNEL_ENTRYPOINTS` | `""` | 逗号分隔的隧道入口列表（为空跳过隧道编排） |
| `xpodEdgeHealthProbesEnabled` | `--xpodEdgeHealthProbesEnabled` | `XPOD_EDGE_HEALTH_PROBES_ENABLED` | `false` | 是否启用节点连通性探测 |
| `xpodEdgeHealthProbeTimeout` | `--xpodEdgeHealthProbeTimeout` | `XPOD_EDGE_HEALTH_PROBE_TIMEOUT` | `3000` | 连通性探测超时时间（毫秒） |

### 6.3 管理员角色维护

- 管理员账号来源于 `seedConfig` 初始化或后续人工创建。创建后，请在 `identity_account.payload` JSON 中追加 `roles: ["admin"]`（或 `isAdmin: true`），并写入 `webId` 字段。
- `AdminConsoleHttpHandler`、`QuotaAdminHttpHandler` 会读取访问令牌中的 WebID，通过 `AccountRoleRepository` 查表确认是否具备 `admin` 角色；无权限时返回 403。
- 如需批量管理，可编写脚本定期同步角色配置，并将快照写入 `.internal/accounts/` 目录便于审计。
- 为避免控制台路由与 Pod URL 冲突，`ReservedSuffixIdentifierGenerator` 会拒绝 `admin`、`quota`、`signal` 等保留 slug。
  - 自定义控制台页面时，可直接替换 `ui/admin` 中的 React/Vite 工程；构建产物会托管在 `dist/ui/admin`，并由 handler 自动注入正确的 `200` 响应和缓存 Header。

---

## 7. 组件覆盖策略与最佳实践

1. **保持 CSS 结构化**：自定义组件都放在 `config/xpod.json`，避免直接改动 CSS 原始配置，利于升级。
2. **Override 顺序**：在改写 `BaseHttpHandler` 时注意保留原有 handlers，否则会影响 Solid 核心能力。
3. **新环境接入**：创建 `config/extensions.<env>.json` 时，先 `import "./xpod.json"`，再追加特定 Override，避免缺少核心组件。
4. **变量/CLI 扩展**：新增 CLI 参数时同时更新 `config/cli.json`、`config/resolver.json`，并在文档留痕。
5. **打包流程**：任何 UI 变更务必执行 `yarn build:ui`，并确保 `dist/ui/admin` 已提交或部署。

---

## 8. 前后端联调流程建议

1. **初始化环境**
   ```bash
   cp example.env.local .env.local
   yarn install
   yarn build:ui
   yarn build
   yarn local   # 本地模式
   ```
   如果在受限环境遇到 `listen EPERM 0.0.0.0:3000`，换用具备端口权限的机器或调整 `--port`。

2. **验证要点**
- 访问 `http://localhost:3000/admin`：确认前端能拉到配置接口。
- 使用管理员 Bearer Token 调用 `/api/quota/accounts/{id}` 等 API（需要确保对应账号的 `roles` 包含 `admin`）。
- 在边缘节点脚本中调用 `/api/signal`，检查 Admin UI 是否能显示节点状态。

3. **排错常见项**
   - `UI 未刷新` → 是否重新构建 Vite、静态目录是否正确。
   - `组件未装配` → 检查 `config/xpod.json` 是否被环境文件导入、`componentsjs-generator` 是否成功执行。
   - `变量值缺失` → 确认 CLI/ENV 是否传入，`config/resolver.json` 是否包含对应 Key。

---

## 9. 参考文件索引

| 功能 | 路径 |
| --- | --- |
| Handler 链装配 | `config/xpod.json` |
| 各环境入口 | `config/main*.json` |
| 环境扩展 | `config/extensions*.json` |
| CLI 参数表 | `config/cli.json` |
| 变量解析 | `config/resolver.json` |
| Admin 数据层 | `src/identity/drizzle/**` |
| Admin HTTP | `src/http/admin/AdminConsoleHttpHandler.ts` |
| 前端入口 | `ui/admin/src/App.tsx`、`ui/admin/src/main.tsx` |
| 构建脚本 | `package.json` (`build:ui`)、`vite.config.ts` |

---

## 后续规划

- **cluster 运维**：未来会交由独立的外部管理系统承载，与日志、告警、成本/计费等平台整合，仓库内的 `/admin` SPA 将逐步裁撤。
- **local / 桌面端**：对于桌面版或自托管场景，计划在客户端内提供轻量控制面（证书、隧道等设置），不再复用当前 Admin Console。
- 上述拆分完成后，可清理相关前端/Handler 代码，仅保留底层 API 与依赖注入，以简化核心 CSS 配置。

---

如需继续扩展 Xpod 功能，可在上述模块基础上新增组件与配置。建议在提交前对照本文逐项核查，确保前后端、配置与 CLI 参数保持一致。完成定制后，欢迎在文档中继续补充经验，形成团队共享的知识库。***
