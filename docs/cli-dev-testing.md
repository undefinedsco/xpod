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

### 常见启动问题

| 错误 | 原因 | 解决 |
|------|------|------|
| `Cannot find module '@undefineds.co/xpod'` | Components.js 清单未生成 | `bun run build:components` |
| `Cannot find module 'src/api/main.js'` | ts-node 模式下 API fork 路径不对 | 用 `dist/main.js` 而非 `bun run local` |
| CSS 第一次启动失败，第二次成功 | Components.js 模块发现时序 | 正常现象，Supervisor 会自动重试 |

## 申请 Client Credentials

服务启动后，通过 CSS Account API 申请凭据：

```bash
node scripts/setup_creds.js
```

该脚本执行：
1. 用 seed 账号登录获取 account token
2. 创建 client credentials（绑定 webId）
3. 保存到 `~/.xpod/config.json` + `~/.xpod/secrets.json`

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
| API Key | xpod API 调用（LLM 代理等） | `sk-base64(clientId:clientSecret)` Bearer token |

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
