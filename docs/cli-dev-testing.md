# CLI 本地开发测试指南

## 启动全栈 xpod 服务

### 前置条件

```bash
bun run build:ts          # 编译 TypeScript
bun run build:components  # 生成 Components.js 清单（CSS 依赖）
```

### 启动方式

使用 canonical `bun run dev:seed` 启动全栈服务（Gateway + CSS + API）：

```bash
# 清理旧数据
bun run clean

# 带 seed 启动（自动创建 test/alice/bob 账号；读取 .env.local）
bun run dev:seed
```

`dev:seed` 是本地开发的默认入口；需要在测试中隔离数据目录时，使用同一套
runtime 的直接入口，并把 seed 文件显式传给 `src/main.ts`：

```bash
seed_root="$PWD/.test-data/cli-dev-testing"
mkdir -p "$seed_root"
CSS_BASE_URL=http://127.0.0.1:3000/ \
CSS_IDENTITY_DB_URL="$seed_root/identity.sqlite" \
DATABASE_URL="$seed_root/identity.sqlite" \
CSS_ROOT_FILE_PATH="$seed_root/data" \
CSS_SPARQL_ENDPOINT="$seed_root/quadstore.sqlite" \
CSS_RDF_INDEX_PATH="$seed_root/rdf-index.sqlite" \
bun src/main.ts --mode local --host 127.0.0.1 --port 3000 \
  --seedConfig "$PWD/config/seed.dev.json"
```

`CSS_IDENTITY_DB_URL` 和 `DATABASE_URL` 可以填写裸 filesystem 路径（不要手动加
`sqlite:`）。Xpod runtime 会在启动 CSS/API 子进程前统一规范化为绝对 SQLite URL；
因此该方式不会因为父进程和子进程的数据库 URL 表示不同而误连 PostgreSQL。

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

## 真实 Xpod 集成验收（不可用隔离测试替代）

当任务要求“集成测试”“真实 Xpod”“实际账号/Pod”或验证桌面端完整链路时，
必须连接**当前正在运行、用户实际使用的 Xpod Gateway**。`bun run
test:integration`、Vitest 临时端口、mock server 和临时数据目录只属于自动化回归，
即使全部通过，也不能据此宣称真实 Xpod 已验收通过。

验收前先记录实际 Gateway URL，并通过 `/service/status` 确认 Gateway、CSS 和 API
来自同一套运行时。不得为了方便另起一套服务后称其为“真实 Xpod”；不得把动态测试
端口或测试 Pod 的结果替代用户当前运行实例的结果。

### 强制证据链

真实验收必须逐层执行并分别报告结果，后一层通过不能反推前一层，前一层通过也不能
代表后一层通过：

1. **运行时**：实际 Gateway 可达，CSS 与 API 状态正常。
2. **身份**：在该运行时注册或登录真实测试账号，记录非敏感的 WebID 与 Pod URL。
3. **Pod 数据**：使用该身份向实际 Pod 写入独立验收资源，再读取并比较内容；报告实际
   资源 URL 与 HTTP 状态。不要只验证内存对象、mock adapter 或本地临时数据库。
   对 Cloud-managed Local 还必须从 Cloud canonical Pod URL 发起至少一次读取，并记录
   SDK 最终交给网络层的目标 URL；只有目标被改写为当前 Local Gateway 且返回真实 Pod
   内容，才能证明命中本地最优路径。仅用 localhost Pod、只测 URL helper，或仅证明
   canonical URL 可访问，都不能作为最优路径验收。
4. **客户端认证**：通过已登录的 CSS Account 控制端点创建绑定当前 WebID 的 client
   credentials，取得 `{id, secret, resource}`，构造 `sk-` + Base64(`id:secret`)。
   再用当前 Solid Session 调用 `POST /api/ai/gateway/keys`，提交
   `{name, apiKey, credentialResource: resource}`，登记已有凭据；服务端必须验证凭据
   所属 WebID 与当前调用者一致，不能另行生成随机 Key。使用该 `sk-` wrapper 调用
   `/v1/models` 与 `/v1/chat/completions`。真实验收还必须通过 list/reveal 证明配置
   已保存到当前 Pod，且恢复的明文与原 wrapper 完全相同。结束时先撤销 CSS credential，
   再删除 Pod 登记，并验证 wrapper 已无法认证；仅删除 Pod 配置不等于撤销凭据。
5. **AI Connections**：先确认当前测试 Pod 中存在可用的 Provider credential 与模型。
   新账号的空 Pod 默认没有 AI Connection。
6. **Models**：实际调用 `/v1/models`。`200` 但 `data: []` 只说明认证和路由已通，
   不代表模型或 Chat 可用。
7. **Chat**：实际调用 `/v1/chat/completions`，并校验 HTTP 2xx、响应结构和预期内容。
   `credential_unavailable` 表示该 Pod 没有目标模型的可用凭证，必须报告为 Chat 未通过。

OpenAI API Platform 与 ChatGPT Codex Subscription 是两种 offering，模型目录不可混用：
API Key 连接使用 OpenAI `/v1/models`；本机导入的 ChatGPT 订阅必须使用
`/backend-api/codex/models?client_version=...`，携带订阅 access token、可用时携带
`ChatGPT-Account-Id`，并过滤 `visibility=hide` 的内部模型。不得用 ModelsDev 或通用
OpenAI 静态目录替代订阅目录，否则会向用户暴露 Codex 后端实际拒绝的模型。

### 结论与安全规则

- 报告使用“运行时 / 身份 / Pod 读写 / Gateway 认证 / Models / Chat”分项结论，禁止用
  “集成测试通过”概括部分成功。
- 只有真实 Chat 请求获得并校验有效响应，才可以说“Chat 已打通”。
- 不在日志、终端输出、截图或报告中打印 client secret、`sk-` 凭证、access token、
  refresh token 或 Provider API Key。
- 测试账号和验收资源必须使用可识别的 acceptance 前缀，便于后续清理；清理属于
  破坏性动作，按任务授权执行，不得擅自删除用户数据。
- 如果真实账号的 Pod 尚未配置 AI Connection，应明确报告这是 Chat 验收的前置条件，
  不得借用其他用户的 Provider 凭证，也不得把预期的 403 改写为成功。

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
# 返回 { "id": "...", "secret": "...", "resource": "<credential-resource-url>" }
```

## 认证架构

CLI 使用 Solid Session 读写 Pod，并将同一类 CSS client credentials 包装成客户端 API Key：

| 通道 | 用途 | 方式 |
|------|------|------|
| Solid Session | Pod 数据读写（drizzle-solid）与 API Key 登记管理 | `@inrupt/solid-client-authn-node` Session.login() |
| Xpod API Key | `/v1/models`、`/v1/chat/completions` 等客户端兼容入口 | `Authorization: Bearer sk-<Base64(client_id:client_secret)>` |

CSS 是凭据创建、验证与撤销的权威。Base64 使用 UTF-8 编码的 `id:secret`，其中 `id`
是 CSS 创建响应中的客户端标识，不是 credential resource URL 的最后一个路径段。
`POST /api/ai/gateway/keys` 只登记现有 wrapper，不再发行 `xpod_gw_v1_*`。旧格式记录
仍可读取和删除，但不作为新 Key 的生成方式。

登记使用已有 Pod 私有 `.data/ai/gateway/access-key-secrets.json` companion 保存
wrapper、名称和 CSS credential resource，供列表、复制、重新应用与 reveal 使用；
不建立额外的 RDF 认证记录。列表只返回非敏感元数据及配置指纹，明文由显式 reveal
返回。日志和验收证据不得保存 wrapper 或 client secret。Pod companion 写入依赖
强 ETag 条件请求，冲突时重读重试，避免并发登记互相覆盖。

API Keys 页面“新建”只创建和登记；列表的客户端下拉菜单勾选即应用，取消勾选即撤回，
Key 列表采用单行布局：名称、掩码、复制完整 Key、已应用客户端图标、最后使用时间、固定“应用”下拉及管理操作；窄窗口优先隐藏最后使用时间。
每个客户端独立提供复制配置操作。勾选直接应用，不再要求输入确认码；前端仍提交计划返回的 token 和目标哈希，以保留冲突检查。应用只执行本地配置备份、冲突检查、文件写入和本地校验；
写入成功即完成勾选，不查询模型目录，不触发 Gateway 网络验证，也不因网络异常回滚。
Codex 的模型选择器还需要本地 `model_catalog_json`。页面在后台单独加载真实 Gateway
`/v1/models` 快照，应用时将已有快照随配置原子写入 `~/.codex/xpod-model-catalog.json`，
并设置目录路径；不可用 Pod 中的全部模型或 provider discovery 列表替代可路由目录。
目录未加载成功时不编造模型，不阻塞凭据配置；若 Gateway 明确返回空目录，则拒绝生成
会导致 Codex 无法启动的空目录文件，保留原配置并报告无可用模型。目录由 Codex 启动时读取；验收必须检查
Codex `model/list` 确实返回目标模型，仅 `/v1/models` 或指定模型调用成功不足以证明选择器生效。
没有显式选择模型时保留客户端现有模型设置。应用期间显示“应用中…”。
操作结果使用浮动提示，新建 Key 使用弹窗，不在列表头部插入内容。宿主已有 Toaster 时，
通过 `createAiConnectionsExtension({ renderToaster: false })` 避免重复提示。撤回应用恢复客户端此前的
配置，不撤销 Key。Codex 将 Xpod Key 写入 `[model_providers.xpod].experimental_bearer_token`，
并设置 `requires_openai_auth = false`；原生订阅登录的 `auth.json` 保持独立，应用、刷新和撤回都不切换全局登录模式。
旧版曾由 Xpod 管理的 `auth.json` 在首次重新应用时按所有权指纹及备份迁移，仅恢复 Xpod 改动的字段，
保留当前 OAuth token 和用户重新登录后的状态。新投影不再跟踪认证文件，订阅 token 自动刷新不会导致配置漂移。
CSS credential 不支持通过 Pod 的停用标记实现暂停/恢复，
不得把这样的状态变化算作认证验收成功。

本机配置管理请求使用当前宿主入口，不能让携带 invocation Bearer 的浏览器请求
绕回 Pod 公网域名。service-access 授权仍由 Solid Session 对 canonical URL 签名，
经现有本地路由发送；这与配置写入的管理请求、写入文件的推理地址是不同边界。

本机 `local-filesystem` 应用和刷新使用当前桌面宿主实际运行的 origin，保留实际分配的端口，
由各客户端 adapter 添加所需的 `/v1` 等协议路径。不得硬编码端口，也不能使用可能已经过期的节点 DNS 地址。
每个已应用客户端旁的刷新按钮沿用当前 Key，重新生成并写入配置；Account、WebID 与 Pod 保持 canonical 身份。
没有宿主入口的集成沿用调用方提供的 endpoint；手动复制配置目前仍使用 Pod 的 canonical Gateway 入口。
验收必须通过最终写入客户端的地址执行真实请求；本机验收不代表节点域名或公网可达。

明确限定为本机的专项验收可以使用独立 Codex profile，将同一个 Xpod provider 指向
当前实例的本机 origin 加 `/v1`（端口取实际运行值），共用当前账号的 Gateway Key，通过 `--model` 分别选择
Gateway 实际列出的 GPT 与 DeepSeek 模型。这只证明本机链路，不证明 DNS 或公网回退。
除普通文本响应外，必须让两种模型分别执行一次工具调用并消费工具结果；随后使用
`codex exec resume <session-id> --model <另一模型>` 验证同一会话的历史延续。
仅第一轮发出工具调用、模型列表成功或脚本直接请求 Chat 成功，都不能算 Codex 验收通过。
回归应覆盖 assistant 文本的 Responses `output_text` 类型，以及工具调用与说明文字
交错时 Chat 消息中的调用/结果配对。模型能力目录更新后，还应验证已创建的 provider
runtime 使用更新后的模型能力，避免列表声明支持而实际调用仍拒绝。

删除时先校验 CSS resource 详情中的 `id` 与 `webId`，使用 Account 登录撤销真实
credential，再清理 Pod 登记；任一步失败都必须明确报告。验收脚本使用独立的 API Key
credential，避免撤销它后影响用于清理 Pod 的 Solid 管理 Session。

`scripts/accept-live-gateway-login-chat.ts` 按上述流程执行真实验收。它会创建测试账号、
Pod 和 Provider 配置，仅在任务已授权这些操作时运行；通过 `XPOD_LIVE_GATEWAY_URL`
指定当前实际入口，Cloud 分配的二级域名不能由默认 localhost 结果替代。

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
