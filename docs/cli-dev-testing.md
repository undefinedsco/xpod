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

### 验证服务就绪

```bash
curl -s -o /dev/null -w "%{http_code}" http://localhost:3000/test/
# 期望: 200
```

### 打开 Settings Dashboard

Dashboard 是 Xpod Web runtime 的静态页面，不需要第二个服务壳。先启动本地
Xpod host，再打开 settings 入口：

```bash
bun run settings:open
```

默认打开 `http://localhost:3000/settings/models`。如 host 不在默认端口，可用
`XPOD_SETTINGS_URL`、`XPOD_DASHBOARD_URL`、`CSS_BASE_URL` 或 `XPOD_BASE_URL`
指定已有 Xpod 地址；脚本会规范化为 `/settings/models`，只接受 `http`/`https`
URL，并在 host 不可达或系统 GUI open 命令失败时输出结构化 JSON 错误。

开发 Dashboard UI 时可单独启动 Vite：

```bash
bun run settings:dev
```

这只服务前端调试页面，不负责启动 Xpod。桌面版或托盘壳的边界也是如此：壳层可以
调用 `settings:open` 或自己的 `openExternal`，并按需提供 client-config / 文件系统
能力；Web host 的配置入口可独立访问 `/settings/models`、`/settings/pod`、
`/settings/network` 和 `/settings/services`，状态入口为 `/dashboard/overview`。当前任务不伪造
托盘能力。

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

## 真实 Cloud + Local Xpod 集成验收

当任务要求“真实 Xpod”“集成测试”“实际账号/Pod”或完整桌面链路时，临时端口、mock、
Vitest 与 provider fixture 只能作为前置回归，不能替代以下证据。测试日志与最终报告不得
输出 account token、service token、client secret 或 API Key 明文。

### 1. 运行时与绑定

1. 确认 Local Xpod 的 `/provision/status` 返回 `registered: true`、未过期的
   `provisionCode`、`nodeId` 与 canonical `spDomain/publicUrl`。
2. 从 Local 返回的 `provisionUrl` 发起 Cloud account 登录；不要手工拼接或复用旧
   provisioning code。
3. 完成后读取 Cloud account controls 的 Pod endpoint，验证 Pod 列表保存的是
   `https://<local-canonical-domain>/<pod>/`，而不是 Cloud 占位 URL、loopback URL 或
   signaling URL。
4. 重启 Cloud account 进程或命中另一实例后再次读取，确认记录由 identity DB 持久化。

### 2. Pod 读写

使用登录会话或为该 WebID 创建的 CSS client credentials，对 account API 返回的
canonical Pod URL 做一次真实写入和读取。必须记录 HTTP 状态、资源 URL 与内容摘要；
不得只读取 WebID profile 就声称 Pod 读写通过。

### 3. Provider BYOK、调用凭据与模型

这里有两类不同凭据，不得混为“Gateway API Key”：

1. 在 Web Settings 的 AI Connections 页面录入 Provider BYOK（例如 OpenAI API Key
   与自定义 Base URL）。它由浏览器 Solid Session 直接写入当前用户 Pod；重新打开页面后
   必须能读回“已配置”状态，页面、日志与最终报告不得回显明文。
2. 在 CSS account 页面或 CLI 为该 WebID 创建 client credentials。Xpod API 只接受
   `sk-base64(client_id:client_secret)` 传输包装，并在服务端换取新的 Solid Session；
   Xpod 不创建、不保存另一张 Gateway Key 表。

先真实读取 Pod 中的 provider、credential 与 model 记录（只记录资源地址、模型 ID 和
脱敏摘要），再使用 CSS client credentials 包装分别验证：

```bash
curl -fsS "$XPOD_GATEWAY_URL/v1/models" \
  -H "Authorization: Bearer $XPOD_CSS_CLIENT_CREDENTIALS_WRAPPER"

curl -fsS "$XPOD_GATEWAY_URL/v1/chat/completions" \
  -H "Authorization: Bearer $XPOD_CSS_CLIENT_CREDENTIALS_WRAPPER" \
  -H 'Content-Type: application/json' \
  -d '{"model":"<real-model>","messages":[{"role":"user","content":"Reply with XPOD_OK"}]}'
```

`/v1/models` 返回 200 或空数组都不能证明 Chat 可用。只有真实
`/v1/chat/completions` 返回 2xx，且 assistant 内容有效，才能报告 Chat 已打通。

### 4. 浏览器边界

- Account/Consent/First Pod 页面只调用 Cloud account endpoints，不得从浏览器直接
  请求 Local `/provision/pods` 或 `/provision/webids`。
- managed route token 不代表 Local P2P listener 已启动；真实验收必须保留并观察
  direct/user-tunnel fallback。
- 浏览器不得显示原生 `fetch failed` alert。网络或 Local 不可达时应显示内联、可恢复的
  产品提示，并保留重试/修复入口。
- “WebID 已存在但当前 Local Pod 记录缺失”按异常修复态处理；不允许用“正在同步”掩盖
  缺失的 Cloud account binding。

最终报告按“账号/绑定、Pod 写入、Pod 读取、Provider BYOK、调用凭据、models、chat”
七项逐项给出结果；任何一项未执行都必须明确标记为未验收。

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
