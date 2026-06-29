# ngrok User Tunnel Verification

日期：2026-06-29

本文记录 Xpod local runtime 对 ngrok `user-tunnel` provider 的验收方式和当前本机结果。

## 设计边界

ngrok 是用户自带的 tunnel provider：

- Xpod Cloud 不托管 ngrok 账号、不保存 `NGROK_AUTHTOKEN`，也不默认承接数据面流量。
- 这与 Cloudflare Tunnel / SakuraFRP 的边界一致：第三方隧道账号和数据面成本归用户所有，Xpod 只编排本机 provider、上报状态和维护 canonical route 语义。
- xpod local 只负责读取本机配置、启动 `ngrok http`、发现 ngrok endpoint，并把它作为 `user-tunnel` route。
- 免费 `*.ngrok-free.*` dev domain 可用于 native/debug/临时验收；它不是 `node-*.undefineds.co` 的 canonical Solid browser origin。
- 如果浏览器/Inrupt SDK 要正式访问 `https://node-*.undefineds.co/`，ngrok 账号必须拥有对应 custom domain，Cloud 只能在校验 node 归属后写 DNS CNAME。

## 配置

支持的本机配置：

```bash
# 可选：显式选择 ngrok。即使 token 已写入 ngrok config 文件，也可以只设置这个。
export XPOD_TUNNEL_PROVIDER=ngrok

# 可选：不持久化到 Cloud，只传给本机 ngrok 进程。
export NGROK_AUTHTOKEN=...

# 可选：固定 ngrok dev domain 或 custom domain。
export NGROK_URL=https://ravioli-basics-throbbing.ngrok-free.dev

# 可选：自定义 ngrok binary。
export NGROK_BIN=/opt/homebrew/bin/ngrok
```

local provider 选择规则：

1. 若 `XPOD_TUNNEL_PROVIDER=ngrok`，注册 ngrok provider，可复用已有 ngrok config 文件。
2. 未显式指定时，按 ngrok → Cloudflare → SakuraFRP 选择首个已配置 provider。
3. 同一 local runtime 只启用一个 tunnel provider。

## 验收命令

### 1. Dry-run，不需要 ngrok 账号

```bash
bun run smoke:tunnel:ngrok -- \
  --dry-run \
  --ngrok-url https://ravioli-basics-throbbing.ngrok-free.dev \
  --local-port 3000
```

期望输出：

- `kind = "ngrok-user-tunnel-smoke"`
- `provider = "ngrok"`
- `route.kind = "user-tunnel"`
- `route.targetUrl` 为传入的 ngrok URL，且规范化带 `/`
- 未传 `--canonical-url` 时，`route.canonicalUrl = "about:blank"`，避免把免费 ngrok dev domain 误当成 Solid canonical origin。

### 2. Live smoke，需要已登录 ngrok

```bash
bun run smoke:tunnel:ngrok -- \
  --test-server \
  --local-port 35075 \
  --timeout-ms 30000
```

如果要验证 canonical route 映射，可显式传入：

```bash
bun run smoke:tunnel:ngrok -- \
  --test-server \
  --local-port 35075 \
  --canonical-url https://node-0000.undefineds.co/
```

成功时要求：

- `smokeOk = true`
- `provider = "ngrok"`
- `route.kind = "user-tunnel"`
- `tunnelStatus.connected = true`
- 通过 ngrok endpoint GET 到本地 test server，HTTP status 为 2xx

如果要指定固定 ngrok 域名：

```bash
bun run smoke:tunnel:ngrok -- \
  --test-server \
  --local-port 35075 \
  --ngrok-url https://ravioli-basics-throbbing.ngrok-free.dev
```

### 3. 真实 Pod 读写 smoke，需要已登录 ngrok

该命令启动一个真实 local Xpod runtime，把 ngrok 公网 endpoint 作为本次验收的临时 `CSS_BASE_URL`，然后通过公网 endpoint 完成账号、Pod、client credentials、资源 PUT/GET/DELETE：

```bash
bun run smoke:tunnel:ngrok:pod -- \
  --ngrok-url https://ravioli-basics-throbbing.ngrok-free.dev \
  --timeout-ms 45000
```

成功时要求：

- `smokeOk = true`
- `stages` 包含 `public-status-ok`、`account-pod-created`、`client-credentials-login-ok`、`public-write-ok`、`public-read-ok`
- `write.status` 为 `200`/`201`/`204`
- `read.status = 200` 且读回内容与写入内容一致
- 验收结束后没有残留 ngrok 进程

### 4. 浏览器 smoke，需要已登录 ngrok

该命令在真实 Chromium 浏览器上下文里打开 ngrok 公网 endpoint，并在浏览器 JavaScript 环境中完成账号、Pod、client credentials、资源 PUT/GET/DELETE：

```bash
bun run smoke:tunnel:ngrok:browser -- \
  --ngrok-url https://ravioli-basics-throbbing.ngrok-free.dev \
  --timeout-ms 45000
```

成功时要求：

- `smokeOk = true`
- `stages` 包含 `browser-opened-public-endpoint`、`browser-status-ok`、`browser-account-created`、`browser-password-login-created`、`browser-pod-created`、`browser-token-ok`、`browser-write-ok`、`browser-read-ok`
- `browser.write.status` 为 `200`/`201`/`204`
- `browser.read.status = 200` 且读回内容与写入内容一致

边界：

- 该验收覆盖真实浏览器执行环境、HTTPS、浏览器 fetch、same-origin Pod 读写。
- 免费 ngrok dev domain 对浏览器 UA 会返回 interstitial warning；脚本会带 `ngrok-skip-browser-warning` 头绕过该 warning 页面。
- 它为了最小化自动验收成本，使用 client credentials 在浏览器里换 token；这只是 smoke-test shortcut，不代表正式 Web 登录方案。
- 正式 Web 登录仍应补 OIDC redirect/PKCE 或 Inrupt SDK 登录验收。
- `node-*.undefineds.co` canonical 域名验收还需要 tunnel provider 支持对应 Host/SNI，不能用免费 ngrok dev domain redirect 替代。


### 5. 正式 Inrupt OIDC redirect/PKCE smoke

该命令使用真实 Chromium + `@inrupt/solid-client-authn-browser`，不是 client credentials shortcut。验收内容包括：

- Inrupt SDK 发起 authorization-code redirect flow；
- authorization request 带 `code_challenge` 和 `code_challenge_method=S256`；
- 浏览器完成 CSS password login、WebID 选择和 consent；
- redirect 回 `/app/inrupt-smoke.html` 时带 `code`；
- token request 使用 `grant_type=authorization_code` 且带 `code_verifier`；
- `session.info.isLoggedIn = true`；
- `session.fetch` 可读 WebID profile；
- drizzle-solid 使用 Inrupt session 对 Pod RDF 资源执行 write/read/delete。

本地 loopback 验收（不依赖 ngrok，用于单独证明正式 OIDC/PKCE）：

```bash
bun run smoke:tunnel:ngrok:inrupt --   --local-only   --timeout-ms 90000
```

ngrok 公网验收（需要固定 ngrok endpoint 实际在线）：

```bash
bun run smoke:tunnel:ngrok:inrupt --   --ngrok-url https://ravioli-basics-throbbing.ngrok-free.dev   --timeout-ms 90000
```

边界：

- `--local-only` 只证明正式 Inrupt OIDC redirect/PKCE 和 Pod 读写链路，不证明公网 tunnel 可达。
- ngrok 免费 dev domain 会对浏览器 UA 返回 interstitial warning；脚本会带 `ngrok-skip-browser-warning` 头。
- `node-*.undefineds.co` canonical 域名验收仍要求 tunnel provider 支持该 Host/SNI，不能用 redirect 替代。
- local-only 使用 `http://localhost:<port>/`，不能使用 `127.0.0.1`；CSS DPoP WebID 校验只把带端口的 `localhost` loopback HTTP WebID 当作安全 URI。

## 当前本机验收结果

当前机器有 ngrok binary：

```text
/opt/homebrew/bin/ngrok
ngrok version 3.39.8
```

本机 ngrok config 已有效：

```text
ngrok config check
Valid configuration file at /Users/ganlu/Library/Application Support/ngrok/ngrok.yml
```

当前 live smoke 已通过：

```text
bun run smoke:tunnel:ngrok -- --test-server --timeout-ms 30000 --local-port 35078 --ngrok-url https://ravioli-basics-throbbing.ngrok-free.dev
```

关键结果：

```json
{
  "smokeOk": true,
  "endpoint": "https://ravioli-basics-throbbing.ngrok-free.dev/",
  "status": 200
}
```

真实 Pod 读写 smoke 也已通过：

```text
bun run smoke:tunnel:ngrok:pod -- --ngrok-url https://ravioli-basics-throbbing.ngrok-free.dev --timeout-ms 45000
```

关键结果：

```json
{
  "smokeOk": true,
  "statusCheck": {
    "status": 200,
    "attempts": 2
  },
  "write": {
    "status": 201
  },
  "read": {
    "status": 200,
    "body": "ngrok pod readwrite smoke 1782663302053"
  },
  "delete": {
    "status": 205
  }
}
```

浏览器 smoke 已补为正式验收命令；运行时需要本机 Playwright Chromium 可用。

本机浏览器 smoke 已通过；首次运行前已执行：

```text
bunx playwright install chromium
```

验收命令：

```text
bun run smoke:tunnel:ngrok:browser -- --ngrok-url https://ravioli-basics-throbbing.ngrok-free.dev --timeout-ms 45000
```

关键结果：

```json
{
  "smokeOk": true,
  "stages": [
    "browser-opened-public-endpoint",
    "browser-status-ok",
    "browser-account-created",
    "browser-password-login-created",
    "browser-pod-created",
    "browser-client-credentials-created",
    "browser-token-ok",
    "browser-write-ok",
    "browser-read-ok"
  ],
  "browser": {
    "write": { "status": 201 },
    "read": {
      "status": 200,
      "body": "ngrok browser pod smoke 1782664245922"
    },
    "delete": { "status": 205 }
  }
}
```

验收后已检查无残留 `ngrok` 进程。


正式 Inrupt OIDC redirect/PKCE 已完成 local-only 验收：

```text
bun run smoke:tunnel:ngrok:inrupt -- --local-only --timeout-ms 90000
```

关键结果：

```json
{
  "smokeOk": true,
  "endpoint": "http://localhost:5600/",
  "stages": [
    "inrupt-session-logged-in",
    "pkce-observed",
    "session-fetch-discovery-ok",
    "webid-storage-discovered",
    "drizzle-solid-readwrite-ok"
  ],
  "oidc": {
    "authCodeChallenge": true,
    "authCodeChallengeMethodS256": true,
    "redirectCode": true,
    "tokenGrantAuthorizationCode": true,
    "tokenCodeVerifier": true,
    "tokenRequestUrl": "http://localhost:5600/.oidc/token"
  },
  "browser": {
    "session": {
      "isLoggedIn": true,
      "webId": "http://localhost:5600/inrupt-mqyoccr8/profile/card#me"
    },
    "storage": {
      "storageUrl": "http://localhost:5600/inrupt-mqyoccr8/"
    },
    "drizzleSolid": {
      "ok": true,
      "storagePath": ".data/inrupt-smoke/probe.ttl#this"
    }
  }
}
```

ngrok 公网同一脚本当前未能继续到 OIDC 阶段：本机 ngrok config 已有 authtoken 且 `ngrok config check` 有效，但当前网络无法直连 ngrok agent 出口，`ngrok diagnose` 返回 `ERR_NGROK_8001`；尝试通过本机 HTTP/S 代理运行 ngrok agent 会触发免费版限制 `ERR_NGROK_9009`。该项属于本机网络连通性问题，不是 token、Xpod tunnel provider 或 Inrupt OIDC/PKCE 逻辑问题。

## 已有自动化覆盖

```bash
bun run test \
  tests/tunnel/NgrokTunnelProvider.test.ts \
  tests/scripts/ngrok-tunnel-smoke.test.ts \
  tests/scripts/ngrok-pod-readwrite-smoke.test.ts \
  tests/scripts/ngrok-browser-pod-smoke.test.ts \
  tests/scripts/ngrok-inrupt-oidc-smoke.test.ts \
  tests/scripts/ngrok-env-contract.test.ts \
  tests/api/container/local.test.ts
```

覆盖：

- ngrok provider 使用固定 endpoint 启动 `ngrok http --url ...`。
- 未配置固定 URL 时，从 ngrok Agent API 发现生成的 public endpoint。
- ngrok 错误文档 / dashboard URL 不会被误识别为 tunnel endpoint。
- ngrok JSON `err` 字段会作为失败原因保留。
- local runtime 可注册 ngrok provider，并把 DDNS provider hint 设置为 `ngrok`。
- 显式 `XPOD_TUNNEL_PROVIDER=ngrok` 可复用已有 ngrok config 文件，不强制 env token/url。
