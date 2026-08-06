# AI Connection 功能验收矩阵

更新时间：2026-08-06

## 验收结论

AI Connection 的本地产品路径、Pod 持久化、模型发现与 Pick、标准网关协议、四类编码客户端配置，以及五家供应商的 API Key Connect 已完成自动化和本地真实 Xpod 验证。

以下两项依赖外部凭证，当前不能标记完成：

- 各供应商浏览器 OAuth 的真实外部注册与回调。
- 使用真实供应商凭证运行 Codex CLI 并产生一次真实模型响应。

因此当前结论为：**本地功能验收通过，外部联调验收未完成，不具备无条件正式发布结论。**

## 功能矩阵

| 验收项 | 状态 | 权威证据 |
| --- | --- | --- |
| 本地完整 Xpod 启动 | 通过 | `GET /service/status` 返回 200，CSS/API 均为 `running`；`GET /settings/models` 返回 200。 |
| Solid OIDC 登录与用户隔离 | 通过 | `tests/e2e/xpod-settings.spec.ts` 使用 Alice/Bob 两组真实 OIDC storage state 验证 Pod 隔离；完整集成测试通过。 |
| 裸路径 Local seed 复用已有 Pod | 通过 | `tests/e2e/local-seeded-consent.spec.ts` 使用裸 `CSS_IDENTITY_DB_URL`/`DATABASE_URL` 文件路径启动全新 Local runtime；Account API 返回 seed Pod/WebID，Consent 直接列出该 WebID（无 `Create your first storage`），启动日志无 PostgreSQL/迁移/连接错误，Authorize 后无 AuthBoundary、可见真实 OpenAI Settings 内容且无 `Solid login failed`。 |
| API Key Connect：OpenAI | 通过 | 本地 Xpod 真实 Connect 请求返回 200；重启后从 Pod 重新读取；响应不泄露密钥。 |
| API Key Connect：Anthropic | 通过（同类契约） | `ProviderConnectAdapters.test.ts` 覆盖请求、持久化与错误映射；与五家 API Key 共用同一持久化路径。 |
| API Key Connect：Kimi | 通过 | 本地 Xpod 真实 Connect 请求返回 200；API Key 刷新不进入 OAuth reauth 路径。 |
| API Key Connect：Bailian | 通过（同类契约） | `ProviderConnectAdapters.test.ts` 覆盖请求、持久化与错误映射；与五家 API Key 共用同一持久化路径。 |
| API Key Connect：DeepSeek | 通过 | 本地 Xpod 真实 Connect 请求返回 200；注册表能力为 `browserAssistedApiKey`。 |
| Kimi device-code OAuth 契约 | 通过 | `ProviderConnectAdapters.test.ts` 覆盖 device-code 启动、轮询、错误与缺少 client id 的稳定错误。 |
| 五家浏览器 OAuth 外部联调 | 未完成 | 尚未提供各供应商注册的 OAuth client、回调配置和可审计的外部成功记录；禁止用 mock 替代。 |
| 凭证写入当前用户 Pod | 通过 | 本地 Xpod Connect 后重启仍可读；Hosted Pod PATCH/PUT 使用带鉴权请求并限制请求体为 1 MiB。 |
| 不感知 local/cloud | 通过 | Applet 和 AI Connection service access 根据当前会话与 Pod 自表达定位数据，不读取 deployment 类型。 |
| 供应商模型自动发现 | 通过 | 真实本地 Xpod + 可变 OpenAI-compatible fixture 的 Playwright 门禁通过。 |
| Pick 后持久化 | 通过 | UI Pick、页面重载后仍存在；Bob 不可见 Alice 的 Pick。 |
| 仅投影已 Pick 模型 | 通过 | `/v1/models` 只返回当前用户已激活 Pick；未 Pick 模型不进入 Gateway。 |
| 已失效模型仍展示 | 通过 | fixture 删除上游模型并刷新后，Settings 保留已选项并标记 unavailable；Gateway 排除它。 |
| OpenAI Models API | 通过 | `ModelRouter.test.ts`、`AiGatewayService.test.ts` 和协议集成测试通过。 |
| OpenAI Responses API | 通过 | `ProtocolFrontends.test.ts` 与流式集成测试覆盖请求、SSE、工具调用、usage、取消和错误映射。 |
| Anthropic Messages API | 通过 | 同上，覆盖 Messages 解析与序列化。 |
| OpenAI Chat Completions API | 通过 | 同上，覆盖 Chat Completions 解析与序列化。 |
| Codex 配置 apply/verify/restore | 通过 | `AiClientConfigurationHandler.test.ts`；TOML 修改限制在 root，保留 profile 表内模型配置。 |
| Claude Code 配置 apply/verify/restore | 通过 | `AiClientConfigurationHandler.test.ts`。 |
| Pi 配置 apply/verify/restore | 通过 | `AiClientConfigurationHandler.test.ts`。 |
| CodeBuddy 配置 apply/verify/restore | 通过 | `AiClientConfigurationHandler.test.ts`。 |
| 真实 Codex 调用真实模型 | 未完成 | 需要真实 Solid client credentials、已存供应商凭证和可调用模型；`ai-gateway-codex-smoke.ts --real-codex-cli` 不接受 fixture 冒充。 |
| 剩余额度状态 | 通过（契约） | `ProviderQuotaAdapters.test.ts` 覆盖 available、stale/error、unsupported；不伪造百分比。 |
| 桌面与窄屏 Settings 布局 | 通过 | Playwright 真实 Xpod 截图与 SDK geometry assertions 已运行。 |

## 本轮验证记录

以下命令均在 `codex/connections-acceptance` 工作树运行：

```text
bun run build:ts
bun run build:packages
bun run test:packages
bun run test -- <21 个 Connections/ownership/handler 核心测试文件>
bunx playwright test tests/e2e/local-seeded-consent.spec.ts --reporter=line --workers=1
bun run test:integration:lite
bun run test:integration:full
bun scripts/accept-xpod-settings.ts --allow-incomplete
```

结果：

- TypeScript 构建通过（9.68s）。
- Packages 构建通过（2.86s）；packages 测试通过：`solid-sdk` 26、`shared-ui` 4、`extension-sdk` 61、`ai-connection` 101，共 192 个测试。
- ownership/Connections 核心回归：21 个测试文件，345 个通过、1 个跳过（`AiGatewayPodIsolation.integration.test.ts` 在当前无专用集成开关时跳过），无失败（6.31s）。其中包含默认开启 Connect 与显式关闭 Connect 两种配置断言。
- 裸路径 seed→Consent 浏览器验收：1 个通过（11.49s）；使用 fresh runtime，Authorize 后额外确认没有登录边界/登录失败提示并出现真实 OpenAI Settings 内容。
- 完整集成回归：lite 22 个测试文件、128 个通过、5 个跳过（47.70s）；Docker full 4 个测试文件、40 个全部通过（30.68s）。
- 验收器：`pass=3`、`notComplete=6`、`fail=0`、`complete=false`；没有提供外部门禁变量时会如实保留未完成状态。
- `git diff --check release/0.3.71...HEAD` 通过。
- 提交差异未包含 `.env`、私钥或真实供应商密钥；检出的 `sk-*` 均为测试夹具常量。

## 正式发布前剩余门禁

1. 为计划支持浏览器 OAuth 的供应商准备 Xpod 自有 OAuth client，逐家完成授权、回调、过期和刷新验证，并保存脱敏证据。
2. 在本地或 RC Xpod 中使用真实 Solid client credentials 和已 Pick 模型运行：

   ```text
   bun scripts/ai-gateway-codex-smoke.ts --real-codex-cli \
     --base-url "$XPOD_ACCEPTANCE_XPOD_BASE_URL" \
     --model "$XPOD_ACCEPTANCE_MODEL" \
     --api-key-stdin
   ```

3. 两项外部门禁通过后，不带 `--allow-incomplete` 运行 `bun scripts/accept-xpod-settings.ts`，要求 `complete=true`。
