# AI Connections 能力盘点

> 审计日期：2026-08-08
>
> 范围：CC Switch、OpenCodex、LinX 模型管理、Xpod AI Connections 当前本地工作树。
>
> 状态口径：`完整` = 产品可实际使用；`部分` = 仅部分供应商/客户端或只有底层能力；`缺失` = 没有产品入口或没有实现；`表象` = UI/接口名称存在，但不能完成对应产品任务。

## 结论

Xpod 已完成 Provider-first 的 AI Connections 主链路：Provider/Offering/Auth Mode 正交建模、Pod 多凭据池、聚合模型发现、凭据级连接测试、标准 Gateway 路由和统一管理界面已经贯通。与 CC Switch 和 OpenCodex 的主要差距转为自定义 Provider、运行观测、成本统计、自动故障转移策略和桌面快捷操作。

当前最严重的四个认知偏差：

1. “浏览器登录”大部分实际是打开厂商控制台后粘贴 API Key，不是 OAuth。
2. “添加 Connection”现在会在供应商下新增独立凭据；自定义 Provider 仍未形成产品闭环。
3. “额度”只有 Kimi、DeepSeek 可真实查询；OpenAI、Anthropic、百炼返回 `unsupported`。
4. 模型拉取、凭据级 `/models` 连接验证和自定义模型已存在，但仍缺少最小推理、延迟、TTFB、使用量和成本闭环。

因此下一阶段不应继续围绕页面细节零散补功能，应先把 AI Connections 定义为：

> **Pod 所有的 AI Provider、凭据、模型目录和客户端接入的统一控制面；Xpod Gateway 是其标准数据面。**

## 横向能力矩阵

| 能力 | CC Switch | OpenCodex | LinX | Xpod AI Connections | 判断 |
| --- | --- | --- | --- | --- | --- |
| Provider 目录 | 50+ preset，支持通用 Provider | 66 个 preset（55 key、7 OAuth、3 local、1 forward） | 固定目录 | 固定 7 项（5 家，百炼拆 3 套） | **明显缺失** |
| 自定义 Provider | 完整，支持通用兼容 Provider | 完整，可增删改、禁用、设默认 | 数据模型可表达，UI 当前以固定目录为主 | Registry 类型允许 string，但 UI/安全 Base URL/运行时均固定 | **缺失产品闭环** |
| Base URL | 可编辑 | 可编辑 | 可编辑并写 Pod | 当前 UI 可随 API Key 保存 Base URL，但只允许注册的安全地址 | **部分** |
| 出站代理 | 全局 outbound proxy | Provider/全局 proxy | schema 有 `proxyUrl`，旧管理尚未完整暴露 | 无 AI Connections 产品入口 | **缺失** |
| API Key | 完整 | 完整，多 Key Pool、启停和 alias | 完整，写 Pod credential | Provider 下支持多 Key、标签、优先级、启停、测试和撤销 | **具备** |
| OAuth / 浏览器登录 | Claude/Codex/Gemini 等官方登录 | 7 类 OAuth、多账号、切换、退出 | 无统一 Provider OAuth 产品 | Kimi OAuth 状态机与凭据共存已实现；真实签发 client id 待外部验收 | **部分** |
| 多账号 / 多凭据 | Provider 配置可复制/排序 | 完整，多账号与 Key Pool | schema 可扩展，UI未形成产品 | 同一 Provider 支持 OAuth/API Key 多凭据、排序和独立状态 | **具备** |
| 凭据归属 | 本机 SQLite/目标配置文件 | 本机 auth JSON/account store | 用户 Pod | 用户 Pod + Solid 权限 | **Xpod 优势** |
| 模型发现 | `/v1/models` + OAuth backend | live discovery、缓存、allowlist | 在线拉取并写 Pod | 服务端 refresh，五家适配器 | **基本具备** |
| Pick 后对应用可见 | 主要按客户端配置切换 | selectedModels / visible models | enabled 模型 | Gateway `/v1/models` 只投影选中模型，并保留失效状态 | **Xpod 优势** |
| 自定义模型 | 支持 | 支持 | 增删改、能力标注 | 当前本地工作树已有增删改接口和 UI | **具备，待验收** |
| 模型元数据 | 基础模型与定价 | context/capabilities/custom caps | 基础 capabilities | registry 有能力字段，发现结果较薄 | **部分** |
| 连接测试 | Fetch Models + Stream Check | `/models` 测试为主 | Fetch Models 被当作连接验证 | 对指定已存凭据执行真实 `/models` 探测，不接收临时明文 Key | **基本具备** |
| 延迟 / TTFB | 完整 | Provider test/health | 无 | 无 | **缺失** |
| 故障转移 / 断路器 | 完整、按客户端队列 | combos/pools/sidecars 等路由能力 | 无管理面 | Router 有候选与 session affinity，UI 无策略管理 | **底层部分，产品缺失** |
| 标准 API | Anthropic、Chat、Responses 转换 | Responses、Chat、Messages 等 | 主要消费 Xpod/runtime | `/v1/responses`、`/v1/chat/completions`、`/v1/messages`、`/v1/models` | **具备** |
| Gateway 调用 Key | 本地代理接管 | `ocx_data_*` admission key | 可使用 Xpod API | Pod Gateway Key，可创建/列出/撤销 | **具备** |
| 编码客户端 Apply | 多客户端写原生配置 | 部分一键、部分 export/manual merge | CLI/desktop 有自己的运行时接入 | Codex、Claude Code、Pi、CodeBuddy 的 plan/apply/verify/restore | **具备，需真机验收** |
| 用量 / Token / 成本 | 完整 dashboard、日志、定价 | JSONL、7d/30d、provider/model、估算成本 | 无统一管理面 | 网关能透传 usage，但无持久化产品视图 | **缺失** |
| 剩余额度 | 官方订阅 + 可配置脚本 | 按 Provider 能力返回，未知不伪造 | 无 | Kimi、DeepSeek 完整；其余 unsupported | **部分** |
| 请求日志 | 完整 | 完整 | 无统一管理面 | 无 AI Connections 请求日志产品 | **缺失** |
| 导入现有配置 | 完整 | 部分客户端 import/export | CLI/Pod 已有数据 | 无从 Codex/Claude/Pi/CodeBuddy 反向导入 | **缺失** |
| 备份 / 同步 | SQLite backup、WebDAV/S3 | 本地配置与存储维护 | 天然 Pod 同步 | Provider 数据在 Pod，但没有导出/迁移/冲突产品 | **部分，Pod 是优势** |
| 桌面 / 托盘 | 跨平台 Tauri、托盘 quick switch | Windows tray，其他平台不完整 | LinX/Xpod desktop shell 已存在 | AI Connections 无托盘状态与快捷操作 | **缺失** |
| 权限与身份 | 本机权限 | 本机 management/data-plane auth | Solid OIDC | Solid OIDC + Pod Agent Access + scoped invocation | **Xpod 优势，但 UX 未完成** |

## 各产品可借鉴的核心

### CC Switch

CC Switch 的产品闭环是“配置 → 切换 → 代理接管 → 验证 → 观测 → 故障转移 → 备份”。应借鉴：

- Provider preset 与通用 Provider 创建器；
- Stream Check，而不仅是请求 `/models`；
- 延迟、TTFB、健康状态和 failover 队列；
- 请求日志、Token、成本、额度脚本；
- 托盘 quick switch、轻量模式、导入导出。

一手资料：[README](https://github.com/farion1231/cc-switch/blob/main/README.md)、[Add Provider](https://github.com/farion1231/cc-switch/blob/main/docs/user-manual/en/2-providers/2.1-add.md)、[Proxy Service](https://github.com/farion1231/cc-switch/blob/main/docs/user-manual/en/4-proxy/4.1-service.md)、[Model Test](https://github.com/farion1231/cc-switch/blob/main/docs/user-manual/en/4-proxy/4.5-model-test.md)、[Usage Query](https://github.com/farion1231/cc-switch/blob/main/docs/user-manual/en/2-providers/2.5-usage-query.md)。

### OpenCodex

OpenCodex 的核心优势是 Provider/Auth/Model 管理深度：大量 preset、OAuth 多账号、Key Pool、live model catalog、管理面与数据面分离。应借鉴：

- Provider descriptor 统一表达 key/OAuth/local/forward；
- 多账号、多 Key Pool、启停与选择；
- OAuth begin/status/cancel/logout 的完整状态机；
- selectedModels、disabledModels、customModels、context/capability metadata；
- 用量未知时明确显示 unknown，不伪造成 0；
- management plane 与 `/v1/*` data plane 清晰分离。

一手资料：[Provider 文档](https://github.com/lidge-jun/opencodex/blob/8a9c0efa795faf6e600fba2269303e4fe56c7361/docs-site/src/content/docs/guides/providers.md#L31-L233)、[管理 API](https://github.com/lidge-jun/opencodex/blob/8a9c0efa795faf6e600fba2269303e4fe56c7361/structure/05_gui-and-management-api.md#L13-L107)、[Provider Registry](https://github.com/lidge-jun/opencodex/blob/8a9c0efa795faf6e600fba2269303e4fe56c7361/src/providers/registry.ts#L570-L1478)、[OAuth](https://github.com/lidge-jun/opencodex/blob/8a9c0efa795faf6e600fba2269303e4fe56c7361/src/oauth/index.ts#L148-L242)、[Usage/Quota](https://github.com/lidge-jun/opencodex/blob/8a9c0efa795faf6e600fba2269303e4fe56c7361/src/providers/quota.ts#L1-L260)。

### LinX

LinX 当前模型管理虽不完整，但已有能力不能丢：

- `@undefineds.co/models` 的 Provider/Credential/Model mutation plan；
- drizzle-solid collections 水化与 Pod CRUD；
- API Key、Base URL、启用状态；
- 在线拉模型、手工增删改模型、能力标注；
- CLI `ai connect/disconnect/status` 与 Pod 会话。

相关实现：

- `/Users/ganlu/develop/linx/apps/web/src/modules/model-services/hooks/useModelServices.ts`
- `/Users/ganlu/develop/linx/apps/web/src/modules/model-services/ModelServicesContentPane.tsx`
- `/Users/ganlu/develop/linx/apps/web/src/modules/model-services/services/model-fetcher.ts`
- `/Users/ganlu/develop/linx/apps/cli/src/lib/ai-command.ts`

AI Connections 应成为这套能力的升级和统一宿主；Linx 后续只消费同一 applet/SDK/Pod 数据，不再维护第二套模型管理业务。

## Xpod 当前真实能力

### 已有且应保留

- Solid OIDC 会话与 Pod Agent Access；
- Provider 凭据、模型选择、额度快照存入用户 Pod；
- OpenAI Responses、Chat Completions、Anthropic Messages、Models 四类入口；
- Provider Runtime Adapter、模型路由、session affinity；
- Provider 模型发现、选中模型投影、失效模型保留；
- 自定义模型增删改（当前本地工作树）；
- Pod Gateway Key 创建、列出、撤销；
- Codex、Claude Code、Pi、CodeBuddy 配置 plan/apply/verify/restore；
- Kimi、DeepSeek 的真实余额查询。

关键实现：

- `src/api/handlers/AiGatewayHandler.ts`
- `src/api/handlers/AiGatewayManagementHandler.ts`
- `src/api/ai-gateway/AiGatewayService.ts`
- `src/api/ai-gateway/providers/ProviderRegistry.ts`
- `src/api/ai-gateway/connect/index.ts`
- `src/api/ai-gateway/models/ProviderModelsService.ts`
- `src/api/ai-gateway/models/ProviderCustomModelsService.ts`
- `src/api/ai-gateway/auth/PodGatewayAccessKeyRepository.ts`
- `src/api/service/AiClientConfigurationService.ts`
- `packages/ai-connections/src/`

### 目前只是部分或表象

- 固定 Provider：前端固定 7 个条目，无法新增自定义 Provider；
- OAuth：Kimi OAuth 已实现 begin/poll/refresh/disconnect 和服务端 integration provenance 校验，但真实 Xpod/Moonshot 签发的 client id 尚未验收；
- Connect 验证：指定凭据的 `/models` 可真实验证，但仍不等于 Chat/Responses/Messages 最小推理已验证；
- 额度：OpenAI、Anthropic、百炼无真实 API，产品只能显示 unsupported；
- Base URL：可编辑但受 registry safe URL 限制，不能表达任意兼容网关；
- 客户端配置：代码完整，但需要在真实安装的四个客户端上验收；
- 自定义模型：本地工作树已有实现，尚不能等同已发布、已生产验收；
- 凭据加密：当前产品决策是先使用 Pod ACL/授权边界；应用层加密不计入本阶段完成范围，需另立安全设计后实施。

## 必做能力清单

### P0：先形成可信产品闭环

1. **统一 Provider 数据模型**：preset 与 custom 使用同一 descriptor；将 Provider、Offering、Auth Mode、Protocol、Endpoint 正交建模，支持 models URL、quota strategy、capabilities。
2. **真正的新增 Connection（已实现）**：加号在 Provider 下创建独立凭据，并支持多凭据管理。
3. **修正认证语义（已实现）**：明确区分 API Key、OAuth 与 Offering；Token Plan/Coding Plan 不再被当作认证方式。
4. **真实连接验证**：保存前后执行最小 `/models` + 最小推理检查；展示延迟、TTFB、协议与失败原因。
5. **吸收 LinX 模型管理（主链路已实现）**：API Key、在线拉取、模型增删改、Pod CRUD 统一进入 AI Connections；任意自定义 Base URL 仍受安全策略限制。
6. **发布态验收**：自定义模型、Gateway Key、四客户端 Apply、Kimi/DeepSeek 额度必须用真实本地 Xpod + Pod 登录验证。

### P1：达到可替代 CC Switch/OpenCodex 的日常管理水平

1. Provider preset catalog，至少覆盖 OpenAI-compatible、Anthropic-compatible、Google、Azure、OpenRouter、Ollama/local、forward gateway；
2. 多凭据/多账号的自动轮换、权重和可视化 fallback 策略（基础启停、标签、优先级已实现）；
3. 扩展更多供应商 OAuth；Kimi 已具备 begin/device poll、refresh、logout/expired 基础状态机；
4. 健康状态、延迟、TTFB、最近错误、自动重试；
5. 请求日志、Token usage、按 Provider/Model/时间统计、成本估算；
6. 额度 adapter/plugin，unsupported/unknown/error 清晰区分；
7. 从 Codex、Claude Code、Pi、CodeBuddy 检测并导入现有配置；
8. 代理 URL、TLS/网络安全策略与 SSRF 防护；
9. 模型元数据：context、输入模态、tools、reasoning、价格、别名；
10. Gateway routing UI：默认模型、fallback、优先级、熔断与 session affinity。

### P2：体现 Xpod / Solid 的独有价值

1. Provider、Credential、Model、Selection、Usage、Quota 全部是 Pod 中可迁移、可审计的数据；
2. Applet 与 Agent 通过 Solid permissions 获得最小授权，不复制用户凭据；
3. LinX、Xpod desktop、其他 applet 共享同一 AI Connections 与登录会话；
4. 支持个人 Pod、团队共享 Provider、组织策略三层作用域；
5. 托盘轻量状态：当前 Gateway、健康、额度、默认模型与快速打开；
6. 长期任务使用独立委托授权，不复用浏览器短期会话。

## 验收口径

任何能力只有满足以下三层才标记为“完整”：

1. **数据层**：Pod schema、drizzle-solid CRUD、权限与迁移可验证；
2. **服务层**：management API 与 data-plane 行为有集成测试；
3. **产品层**：真实登录/真实 Provider/真实客户端完成端到端验收。

只有 TypeScript 类型、mock 测试、按钮或返回 `unsupported`，不能计为产品完成。

## 建议的下一份设计文档

下一步应先写 `AI Connections Provider Descriptor & Lifecycle`，冻结以下内容后再继续开发：

- Provider、Offering、Account、Credential、Connection、Model、Selection 的边界；
- API Key / OAuth / Device Code / Local 四类认证状态机；
- Token Plan/Coding Plan 是 Offering，不是 Auth Mode；同一套餐可以按厂商分别采用 OAuth 或专属 API Key；
- OAuth `client_id`、endpoint、scope 属于 Xpod/preset 集成配置，不向最终用户暴露；
- preset 与 custom provider 的统一表达；
- 模型发现、手动模型、失效模型、pick 投影规则；
- health、quota、usage、routing 的 adapter 接口；
- LinX 与 Xpod desktop 的宿主职责和 SDK 能力。
