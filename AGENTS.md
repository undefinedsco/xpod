# Repository Guidelines

**AGENTS.md 编写原则**：本文件只放原则、流程指引和关键配置说明，具体细节（如代码示例、配置格式）放到 `docs/` 下的专题文档。

## Pod 数据读写原则

Pod 内数据的读写**第一优先级使用 drizzle-solid** 进行操作：
1. **优先 drizzle-solid**：所有 RDF 数据的 CRUD 操作首选 drizzle-solid API
2. **绕过前先报告**：如遇 drizzle-solid 无法解决的问题，**第一时间整理 issue 报告**，记录问题场景、复现步骤和根因分析
3. **持续改进**：通过 issue 驱动 drizzle-solid 的迭代，持续提高其易用性和健壮性
4. **临时绕过**：仅在 issue 已记录且确实阻塞开发时，才考虑使用原生 SPARQL 或其他方式绕过

## Project Structure & Module Organization
Core TypeScript modules live in `src/`: `storage/` contains data accessors, `logging/` wraps Winston, and `util/` extends Community Solid Server helpers. CSS configuration templates reside in `config/` with two main entry points: `local.json` for development and `cloud.json` for production. Builds emit generated JavaScript and Components.js manifests into `dist/`; treat it as read-only. Runtime folders like `logs/` and `local/` should stay untracked, while utility scripts in `scripts/` handle storage smoke tests such as `node scripts/testInsert.js`.

## 组件开发位置决策

开发新组件前，**先明确其职责**，再决定放置位置：

### 架构概览

```
Gateway (3000) - 统一入口
  ├── CSS (内部端口) - Solid Server，Components.js 管理
  └── API (内部端口) - 独立 API 服务，普通 TypeScript
```

### 决策流程

| 职责类型 | 放置位置 | 技术栈 | 示例 |
|----------|----------|--------|------|
| Solid 协议相关（LDP、SPARQL、认证） | CSS (`src/http/`, `src/storage/`) | Components.js + jsonld | `SubgraphSparqlHttpHandler`, `MixDataAccessor` |
| 管理/运维 API | API Server (`src/api/handlers/`) | 普通 TypeScript 路由 | `SubdomainHandler`, `NodeHandler`, `ApiKeyHandler` |
| 数据访问/存储 | 共享 (`src/identity/`, `src/dns/`) | 可被两边复用 | `EdgeNodeRepository`, `TencentDnsProvider` |
| 业务逻辑服务 | 共享 (`src/subdomain/`, `src/service/`) | 可被两边复用 | `SubdomainService`, `PodMigrationService` |

### 判断标准

**放 CSS (Components.js)**：
- 需要拦截/扩展 Solid 请求处理链
- 需要替换 CSS 默认组件（等位替换）
- 需要 CSS 的 DI 容器管理生命周期

**放 API Server**：
- 管理功能（用户管理、节点管理、配额管理）
- 与 Solid 协议无关的 REST API
- 需要简单路由，不想折腾 Components.js

**放共享模块**：
- 纯业务逻辑，无 HTTP 层
- 可能被 CSS 和 API 两边调用
- 数据库访问、外部服务集成

## Build, Test, and Development Commands
- `bun install` — Sync dependencies after pulling changes.
- `bun run build` — Run TypeScript compilation and regenerate Components.js output.
- `bun run build:ts` / `bun run build:components` — Execute each build stage independently during debugging.
- `bun run start` — Boot the production profile defined by `config/main.json`.
- `bun run dev` / `bun run local` / `bun run cloud` — Launch CSS against dev, local, or cloud stacks（分别加载 `.env.local` / `.env.local` / `.env.cloud`，建议由 `example.env` 模板复制）。
- `bun run clean` — Reset local SQLite data and CSS internals.
- 需要新增 CLI 参数时，直接在 `config/cli.json` 的 `YargsCliExtractor.parameters` 数组里追加 `YargsParameter` 条目（示例字段：`name`、`options.type`、`options.describe`）。Components.js 会自动把这些字段暴露为 `community-solid-server` 的命令行开关，例如我们现有的 MinIO、Redis、Email、`identityDbUrl` 等参数就是这样挂载的。
- **环境变量分类规范**：新增配置变量前，务必参照 `docs/CONFIG_STRATEGY.md` 的三层分类——CLI 参数（只放核心模式开关如 `edition`、`edgeNodesEnabled`）、ENV 参数（用 EnvExtractor 直接读 `process.env`，不进 cli.json）、推导值（从 baseUrl 等已有变量在组件构造函数里推导）。
- **Docker 构建问题**：如遇 `bun install` SSL 握手失败、磁盘空间不足等问题，参考 `docs/docker-build-troubleshooting.md`。

## Coding Style & Naming Conventions
Strict TypeScript is enforced; keep code ES2021-compatible and prefer async/await. Use PascalCase for classes (`ConfigurableLoggerFactory`), camelCase for functions and variables, and mirror existing JSON key casing. Default to single quotes in imports, follow the prevailing two-space indentation, and expose shared symbols via `src/index.ts`. When instrumenting behavior, rely on CSS logging helpers (`getLoggerFor`) instead of raw `console` calls.
- JSON-LD 配置里引用自研组件参数时，先在 `@context` 里声明短别名，再用短名键（如 `UsageTrackingStore_source`），不要直接写长 IRI。

## 代码品味 (Code Taste)
- **消除重复**：发现两处以上相同逻辑时立即抽取，不等"以后再说"。复制粘贴是设计缺失的信号。
- **单一职责的初始化**：连接、认证、客户端实例等资源的创建只应出现一次，通过工厂函数或构造器提供给消费方。
- **先审视再动手**：写完一个模块后，回头通读一遍，检查是否有可合并的路径、多余的参数传递、或本该内聚的逻辑散落在调用方。
- **最小惊讶**：API 的签名和行为应符合使用者的直觉，不要让调用方做本该由被调用方承担的工作。

## 等位替换原则 (Component Override Principle)
Xpod 采用**等位替换**策略扩展 CSS：用自定义组件替换 CSS 同层级的默认组件，保持接口兼容，不破坏 CSS 调用链。

### 核心原则
1. **接口兼容**：替换组件必须实现与被替换组件相同的接口/基类
2. **行为扩展**：只增强功能，不删减 CSS 原有能力
3. **配置隔离**：通过 `config/xpod.base.json` 定义通用组件，`local.json` 和 `cloud.json` 按需 Override

### 当前等位替换清单
| CSS 默认组件 | Xpod 替换组件 | 功能区别 |
|-------------|--------------|----------|
| `DataAccessorBasedStore` | `SparqlUpdateResourceStore` | 拦截 PATCH 操作，能处理的直接执行 SPARQL UPDATE |
| `RepresentationConvertingStore` | `RepresentationPartialConvertingStore` | 能转尽量转，不能转保留原始 |
| `FileDataAccessor` | `MixDataAccessor` | 混合存储：RDF 走 Quadstore，非结构化走 FileSystem/MinIO |
| `BaseLoginAccountStorage` | `DrizzleIndexedStorage` | 数据库存储账户信息，支持集群部署 |
| `PassthroughStore` | `UsageTrackingStore` | 添加带宽/存储用量追踪和限速功能 |
| `HttpHandler` (HandlerServerConfigurator.handler) | `MainHttpHandler` (ChainedHttpHandler) | 链式中间件，支持洋葱模型 |

### 新增组件开发流程
1. **创建组件**：在 `src/` 下创建 TypeScript 类，继承/实现 CSS 对应接口
2. **导出组件**：在 `src/index.ts` 中导出新组件
3. **生成定义**：运行 `bun run build:components` 生成 `.jsonld` 定义文件
4. **配置组件**：在 `config/xpod.base.json` 或 `local.json`/`cloud.json` 中配置
5. **CLI 参数**（如需要）：在 `config/cli.json` 添加参数定义，在 `config/resolver.json` 添加变量映射
6. **更新文档**：在 `docs/COMPONENTS.md` 等位替换表中添加记录
7. **验证配置**：确保 local 和 cloud 模式配置可正常加载

### 文档对位原则
- **新增组件必须同步更新文档**：`docs/COMPONENTS.md` 的等位替换表和组件说明
- **复杂组件单独文档**：如 `docs/chained-http-handler.md` 详细说明中间件系统

## Testing Guidelines
- `bun run build:ts` — 快速类型检查。
- `bun run test:integration` — 完整集成测试。
- 针对存储或数据库逻辑，可在 `scripts/` 下编写专项 Node 脚本验证。
- 端到端检查：启动对应配置（`bun run dev` 最快），访问 `http://localhost:3000` 验证。
- **CLI 本地开发测试**：全栈启动、凭据申请、认证架构等详见 [`docs/cli-dev-testing.md`](docs/cli-dev-testing.md)。

### 必须执行的回归检查
1. **修复后**：实现修复并通过单元/集成测试后，**必须**运行完整集成测试 `bun run test:integration`，防止局部修复引入全局副作用（如 Auth、Quota、单例状态）。
2. **提交前**：在完成任务或提交代码前，**必须**再次运行完整集成测试，确保代码库处于全部通过状态。

### 常见问题
- 如果集成测试出现 `invalid_client` (401)，通常是 `.env.local` 凭据与运行中的服务器不同步（数据库被清理/重启导致），需更新凭据。
- PR 描述中应包含手动验证步骤、示例请求或 curl 命令。

### 测试数据存放规范
测试产生的中间数据（如 SQLite 数据库、临时文件等）必须归类存放，**禁止直接放在项目根目录**。统一使用 `.test-data/` 目录，按测试套件分子目录存放，例如：
- `.test-data/server-mode-root/`
- `.test-data/vector-store/`

测试结束后应在 `afterAll` 中清理这些临时数据。

## Commit & Pull Request Guidelines
History favors emoji-prefixed, imperative commit titles such as `🐛 Fix quadstore writes`; follow that format and keep changes cohesive. PRs should summarise intent, call out config or environment updates, and link to tracking issues. Attach screenshots or log excerpts when altering runtime behavior, and confirm which build or run command you executed.

### Git Add 规范
- **谨慎使用 `git add -A` 或 `git add .`**：容易误提交临时文件、测试数据、密钥文件、IDE 配置等。
- **使用前必须检查**：运行 `git status` 确认没有临时文件、`.env` 文件、密钥、测试数据等敏感或无关文件。
- **推荐做法**：明确指定要提交的文件或目录，例如：
  ```bash
  git add src/api/handlers/NewHandler.ts tests/api/handlers/NewHandler.test.ts
  git add config/cli.json config/resolver.json
  ```
- **提交前检查**：始终运行 `git diff --cached` 确认暂存区内容正确。

### 版本发布
发布新版本的详细流程参见 `docs/RELEASE.md`。

## Security & Configuration Tips
Do not commit secrets; generate `.env.local` / `.env.server` from `example.env` and keep credentials local. When adding components, update both the relevant `config/*.json` and `extensions.*.json`, and list any new environment variables so deployments stay synchronised.

### ACME 与隧道（frp）集成备忘
- cluster 侧已支持通过 `Dns01CertificateProvisioner` 写入/移除 `_acme-challenge` 记录；节点配合 `EdgeNodeAgent` 的 `acme` 配置即可自动申请/续签证书。
- 环境变量：`XPOD_TENCENT_DNS_TOKEN_ID`/`XPOD_TENCENT_DNS_TOKEN`、`XPOD_DNS_RECORD_TTL` 等需在 cluster 配好；DNS 根域名默认取自 CSS `baseUrl`。
  - Agent 需提供 `acme.email`、`acme.domains`、证书/账号私钥存放路径；成功后可直接把 PEM 文件交给 CSS 或本地反代。
- FRP 兜底通过 `FrpTunnelManager` 实现，配置项位于 `XPOD_FRP_*` 系列（server host/port/token、自定义域后缀、remote port 计算等）。未配置时默认禁用，保持纯直连。
- 心跳响应含 `metadata.tunnel.config`，Agent 可据此生成 `frpc.ini` 或调用自定义脚本；如果不想让数据流量经过 cluster，请勿启用 frp 相关变量。
- 管理端策略：cluster 侧运维入口完全依赖外部系统/门户（旧 Admin Console 已退场，不会在仓库内扩展 UI）；local 端若推出桌面版，可在桌面客户端整合这些配置与状态展示。

### 带宽配额与限速
- Cloud 配置默认启用带宽统计：`UsageTrackingStore` 负责资源读写、`SubgraphSparqlHttpHandler` 负责 `.sparql` 入口，均会更新 `identity_account_usage` / `identity_pod_usage` 表中的 `ingress_bytes`、`egress_bytes`。
- 默认限速 10 MiB/s（`config/cloud.json` 中的 `options_defaultAccountBandwidthLimitBps`），设置为 0 或删除该字段即表示不限速。
- `identity_account_usage.storage_limit_bytes` / `bandwidth_limit_bps` 以及对应的 Pod 字段用于存储配额与带宽上限；未来 Admin/桌面端可直接更新这些列完成覆写。

### AI Provider 配置原则
- **禁止使用环境变量配置用户级 AI 参数**：AI provider 的 API Key、Base URL、Proxy URL 等配置**必须存储在用户 Pod** 中，而非服务器环境变量。
- **原因**：用户无法管理服务器环境变量，每个用户的 AI 配置（包括代理）应由用户自行在 Pod 设置中录入。
- **Pod 配置位置**：`modelProviderTable` schema，字段包括 `baseUrl`、`apiKey`、`proxy`、`defaultModel` 等。
- **回退顺序**：Pod 配置 > 环境变量（仅用于开发/测试兜底） > 默认值（如 Ollama localhost）。
- **代理配置**：用户在配置 AI provider 时一并填写 `proxyUrl`，代码中**不要为代理添加环境变量支持**。

### 生态集成原则
- **优先对接生态，不重复造轮子**：通用基础设施能力优先复用成熟生态；Xpod 优先提供兼容 API、Backend、Adapter 或 Provider，而不是 Fork 或重写对方内核。
- **优先封装知名协议 API 以降低迁移成本**：如生态已形成稳定主流协议，优先在 Pod 边界提供兼容 API，让外部系统可用熟悉协议接入 Xpod。
- **协议插件作为次一级扩展机制**：非一等原生能力应通过协议插件或带路径前缀的兼容入口提供支持，并保持产品抽象独立于具体后端。

## Package Manager
- **主线使用 bun**：根目录默认使用 Bun 管理依赖并执行脚本。
- **Node 22+ 仍然必需**：发布产物、CSS 子进程和部分兼容路径仍依赖 Node 运行时；`engines` 当前放宽到 `<27`，为未来 Node 26 预留兼容范围。
- **禁止 npm**：不要使用 `npm install`，避免生成 `package-lock.json`。
- Lock 文件：以 `bun.lock` 为主；`yarn.lock` 若仍存在，仅视为过渡兼容产物，不作为主线来源。

## 网络代理
npm、git、docker、bun 等工具拉取外部资源时，如遇网络问题应使用代理：
- **bun/npm**：`bun pm config set --global registry https://registry.npmjs.org && npm config set proxy http://127.0.0.1:7890 && npm config set https-proxy http://127.0.0.1:7890`
- **git**：`git config --global http.proxy http://127.0.0.1:7890`
- **docker**：配置 `~/.docker/config.json` 中的 `proxies` 或 `HTTPS_PROXY` 环境变量
- 代理地址以本机实际配置为准，上述端口仅为示例。

## Communication
- 与用户互动时默认使用中文进行回复，除非用户另有明确要求。
