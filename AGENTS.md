# Repository Guidelines

## Project Structure & Module Organization
Core TypeScript modules live in `src/`: `storage/` contains data accessors, `logging/` wraps Winston, and `util/` extends Community Solid Server helpers. CSS configuration templates reside in `config/`, paired by environment (for example `config/main.dev.json` with `extensions.dev.json`). Builds emit generated JavaScript and Components.js manifests into `dist/`; treat it as read-only. Runtime folders like `logs/` and `local/` should stay untracked, while utility scripts in `scripts/` handle storage smoke tests such as `node scripts/testInsert.js`.

## Build, Test, and Development Commands
- `yarn install` — Sync dependencies after pulling changes.
- `yarn build` — Run TypeScript compilation and regenerate Components.js output.
- `yarn build:ts` / `yarn build:components` — Execute each build stage independently during debugging.
- `yarn start` — Boot the production profile defined by `config/main.json`.
- `yarn dev` / `yarn local` / `yarn server` — Launch CSS against dev, MinIO-backed local, or PostgreSQL-backed server stacks（分别加载 `.env.local` / `.env.local` / `.env.server`，建议由 `example.env` 模板复制）。
- `yarn clean` — Reset local SQLite data and CSS internals.
- 需要新增 CLI 参数时，直接在 `config/cli.json` 的 `YargsCliExtractor.parameters` 数组里追加 `YargsParameter` 条目（示例字段：`name`、`options.type`、`options.describe`）。Components.js 会自动把这些字段暴露为 `community-solid-server` 的命令行开关，例如我们现有的 MinIO、Redis、Email、`identityDbUrl` 等参数就是这样挂载的。

## Coding Style & Naming Conventions
Strict TypeScript is enforced; keep code ES2021-compatible and prefer async/await. Use PascalCase for classes (`ConfigurableLoggerFactory`), camelCase for functions and variables, and mirror existing JSON key casing. Default to single quotes in imports, follow the prevailing two-space indentation, and expose shared symbols via `src/index.ts`. When instrumenting behavior, rely on CSS logging helpers (`getLoggerFor`) instead of raw `console` calls.

## Testing Guidelines
There is no dedicated test runner yet: use `yarn build:ts` for a fast type-only safety net, and add focused Node scripts under `scripts/` when validating storage or database logic. For end-to-end checks, start the relevant profile (`yarn dev` is the quickest loop) and exercise endpoints at `http://localhost:3000`. Capture manual verification steps, sample payloads, or curl commands in your PR notes.

## Commit & Pull Request Guidelines
History favors emoji-prefixed, imperative commit titles such as `🐛 Fix quadstore writes`; follow that format and keep changes cohesive. PRs should summarise intent, call out config or environment updates, and link to tracking issues. Attach screenshots or log excerpts when altering runtime behavior, and confirm which build or run command you executed.

## Security & Configuration Tips
Do not commit secrets; generate `.env.local` / `.env.server` from `example.env` and keep credentials local. When adding components, update both the relevant `config/*.json` and `extensions.*.json`, and list any new environment variables so deployments stay synchronised.

### ACME 与隧道（frp）集成备忘
- cluster 侧已支持通过 `Dns01CertificateProvisioner` 写入/移除 `_acme-challenge` 记录；节点配合 `EdgeNodeAgent` 的 `acme` 配置即可自动申请/续签证书。
  - 环境变量：`XPOD_TENCENT_DNS_TOKEN_ID`/`XPOD_TENCENT_DNS_TOKEN`、`XPOD_DNS_ROOT_DOMAIN`、`XPOD_DNS_RECORD_TTL` 等需在 cluster 配好。
  - Agent 需提供 `acme.email`、`acme.domains`、证书/账号私钥存放路径；成功后可直接把 PEM 文件交给 CSS 或本地反代。
- FRP 兜底通过 `FrpTunnelManager` 实现，配置项位于 `XPOD_FRP_*` 系列（server host/port/token、自定义域后缀、remote port 计算等）。未配置时默认禁用，保持纯直连。
- 心跳响应含 `metadata.tunnel.config`，Agent 可据此生成 `frpc.ini` 或调用自定义脚本；如果不想让数据流量经过 cluster，请勿启用 frp 相关变量。
- 管理端策略：cluster 端的运维管理更倾向于独立的外部系统（不在现有 Admin Console 内扩展 ACME/FRP 面板）；local 端若推出桌面版，可在桌面客户端整合这些配置与状态展示。

### 带宽配额与限速
- Server / Mix 配置默认启用带宽统计：`UsageTrackingStore` 负责资源读写、`SubgraphSparqlHttpHandler` 负责 `.sparql` 入口，均会更新 `identity_account_usage` / `identity_pod_usage` 表中的 `ingress_bytes`、`egress_bytes`。
- 默认限速 10 MiB/s（`config/extensions.server.json` 与 `config/extensions.mix.json` 中的 `options_defaultAccountBandwidthLimitBps`），设置为 0 或删除该字段即表示不限速。
- `identity_account_usage.storage_limit_bytes` / `bandwidth_limit_bps` 以及对应的 Pod 字段用于存储配额与带宽上限；未来 Admin/桌面端可直接更新这些列完成覆写。

## Communication
- 与用户互动时默认使用中文进行回复，除非用户另有明确要求。
