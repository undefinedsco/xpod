# CLI 本地开发测试指南

## 启动全栈 xpod 服务

### 前置条件

```bash
bun run build:ts          # 编译 TypeScript
bun run build:components  # 生成 Components.js 清单（CSS 依赖）
```

### 启动方式

使用 `dist/main.js` 启动全栈服务（Gateway + CSS + API）：

```bash
# 清理旧数据
bun run clean

# 带 seed 启动（自动创建 test/alice/bob 账号）
CSS_BASE_URL=http://localhost:3000/ \
CSS_SEED_CONFIG=$PWD/config/seed.dev.json \
node dist/main.js --port 3000 --mode local --env .env.local
```

seed 账号定义在 `config/seed.dev.json`，默认包含：
- `test@dev.local` / `test123456` → Pod: `/test/`
- `alice@dev.local` / `alice123456` → Pod: `/alice/`
- `bob@dev.local` / `bob123456` → Pod: `/bob/`

### 启动守卫：CSS_BASE_URL 校验

`CSS_BASE_URL` 必须等于网关公开入口（上文启动命令显式设为
`http://localhost:3000/`）。启动时 `main.ts` 会校验：若显式设置的
`CSS_BASE_URL` 是回环地址（localhost/127.0.0.1/::1）但端口与网关端口不一致，
进程会以退出码 20 拒绝启动并给出修复指引——回环地址上不会有其他进程提供
服务，OIDC discovery/authorize 必然失败，且旧端口下创建的 Pod 会被
consent 的 WebID 过滤（ScopedPickWebIdHandler 的 authority 比对含端口）
静默隐藏。未设置时自动派生为 `http://<host>:<gatewayPort>/`，天然一致。
公网域名（cloud / 隧道场景）不受此限制。

注意：集成测试的 `setup-test-credentials` 每次会把 `.env.local` 的
`CSS_BASE_URL` 改写为当次测试栈的动态端口（vitest 以 `override` 方式加载
`.env.local`，依赖该值指向存活测试栈），这是预期行为。`bun run local`
已在脚本层将 `CSS_BASE_URL` 固定为 `http://localhost:3000/`（可用
`CSS_BASE_URL=... bun run local` 显式覆盖，覆盖值仍会过启动校验），
因此测试改写不会再影响本地启动；其余变量如需自定义仍以 `.env.local` 为准。

### 验证服务就绪

```bash
curl -s -o /dev/null -w "%{http_code}" http://localhost:3000/test/
# 期望: 200
```

### 打开 Xpod Dashboard

Dashboard 是 Xpod Web runtime 的静态页面，不需要第二个服务壳。先启动本地
Xpod host，再打开 canonical 入口：

```bash
bun run settings:open
```

默认打开 `http://localhost:3000/ai-connections`。如 host 不在默认端口，可用
`XPOD_SETTINGS_URL`、`XPOD_DASHBOARD_URL`、`CSS_BASE_URL` 或 `XPOD_BASE_URL`
指定已有 Xpod 地址；脚本会规范化为 `/ai-connections`，只接受 `http`/`https`
URL，并在 host 不可达或系统 GUI open 命令失败时输出结构化 JSON 错误。

Canonical Dashboard routes:

| Surface | Route |
|---------|-------|
| Status overview | `/status/overview` |
| Network | `/network` |
| AI Connections | `/ai-connections` |
| Model assignments | `/ai-config/model-assignments` |
| Pod settings | `/settings/pod` |

Legacy `/settings/models` remains only as a compatibility redirect to
`/ai-connections`. New integrations should open or emit canonical URLs directly,
not legacy `/settings/models`.

开发 Dashboard UI 时可单独启动 Vite：

```bash
bun run settings:dev
```

这只服务前端调试页面，不负责启动 Xpod。桌面版或托盘壳的边界也是如此：壳层可以
调用 `settings:open` 或自己的 `openExternal`，并按需提供 client-config / 文件系统
能力；Web host 的主要入口应使用 `/status/overview`、`/network`、
`/ai-connections`、`/ai-config/model-assignments` 和 `/settings/pod`。
兼容 redirect 可以接收旧 URL，但新集成不要主动发送 legacy URL。

### 桌面开发包验收

当前桌面产物是 Apple Silicon 开发包：

| Artifact | SHA256 |
|----------|--------|
| `desktop/release/Xpod-0.1.0-arm64.dmg` | `8ea366581eeee8029c80b20b87e3b3cdd233573eab330a6ec5e7eb7530b2f2e7` |
| `desktop/release/Xpod-0.1.0-arm64-mac.zip` | `db4cacae782b5c48cd93e9c5f090cae52664dfe168c1591c5bf430d348d6a57c` |

`hdiutil verify desktop/release/Xpod-0.1.0-arm64.dmg` 已验证为 valid。
该 DMG/ZIP 未签名、未公证；它们只适合开发验收，不应声明为正式签名发布包。

桌面壳用标准 macOS LaunchServices 打开和退出。运行时生命周期规则：

- 如果本机已有可达 Xpod runtime，桌面壳把它视为 external runtime，退出时不停止该进程。
- 如果桌面壳自行启动 runtime，它把该进程视为 owned runtime，退出时负责清理。
- 实包 smoke 已验证默认进入 `/network/overview`，canonical rail、Account/WebID/local auth 边界、原生 3/3 tray、诊断 API 和 quit cleanup 均正常。

### 常见启动问题

| 错误 | 原因 | 解决 |
|------|------|------|
| `Cannot find module '@undefineds.co/xpod'` | Components.js 清单未生成 | `bun run build:components` |
| `Cannot find module 'src/api/main.js'` | ts-node 模式下 API fork 路径不对 | 用 `dist/main.js` 而非 `bun run local` |
| CSS 第一次启动失败，第二次成功 | Components.js 模块发现时序 | 正常现象，Supervisor 会自动重试 |

## 申请 Client Credentials

服务启动后，通过 xpod auth 命令申请并保存 Solid client credentials：

```bash
bun src/cli/index.ts auth login --url http://localhost:3000 --email test@dev.local --password test123456
```

该命令执行：
1. 用 seed 账号登录获取 account token
2. 创建 client credentials（绑定 webId）
3. 保存到 `$SOLID_HOME/auth/credentials.json`（默认 `~/.solid/auth/credentials.json`）

`~/.xpod/config.json` 和 `~/.xpod/secrets.json` 是旧 app-local 文件，不是
Solid auth source；只有这些旧文件时 CLI 应视为未登录。

手动申请（如脚本不可用）：

```bash
# 1. 登录
curl -X POST http://localhost:3000/.account/login/password/ \
  -H 'Content-Type: application/json' \
  -d '{"email":"test@dev.local","password":"test123456"}'
# 返回 { "authorization": "<token>" }

# 2. 创建凭据
curl -X POST http://localhost:3000/.account/account/<account-id>/client-credentials/ \
  -H 'Authorization: CSS-Account-Token <token>' \
  -H 'Content-Type: application/json' \
  -d '{"name":"CLI-Test","webId":"http://localhost:3000/test/profile/card#me"}'
# 返回 { "id": "...", "secret": "..." }
```

## 认证架构

CLI 使用双通道认证：

| 通道 | 用途 | 方式 |
|------|------|------|
| Session | Pod 数据读写（drizzle-solid） | `@inrupt/solid-client-authn-node` Session.login() |
| CSS client credentials wrapper | xpod API 调用（LLM 代理等） | `sk-base64(clientId:clientSecret)` Bearer token |

## 运行 CLI 测试脚本

```bash
# 端到端线程测试（创建 Chat → Thread → 查询）
node scripts/test_e2e_thread.js

# SPARQL FILTER 位置测试
node scripts/test_sparql_filter.js

# 列出线程测试
node scripts/test_list_threads.js
```

## 已知问题

### SPARQL FILTER 在 OPTIONAL 内部

drizzle-solid 生成的 SELECT 查询中，`eq()` 产生的 FILTER 被放在 OPTIONAL 块内部：

```sparql
SELECT ?subject ?chatId WHERE {
  GRAPH ?g {
    ?subject rdf:type sioc:Thread.
    OPTIONAL { ?subject sioc:has_parent ?chatId. }
    FILTER(?chatId = <...>)  -- 在 OPTIONAL 内部，语义不正确
  }
}
```

SPARQL 语义下，FILTER 在 OPTIONAL 内部时，未绑定的变量会导致整行被丢弃。
正确位置应在 OPTIONAL 之外。

状态：待 drizzle-solid 修复 FILTER 放置逻辑。
