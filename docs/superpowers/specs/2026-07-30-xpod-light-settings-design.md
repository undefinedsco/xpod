# Xpod 轻量设置界面设计

## 决策

Xpod 不再被定义为“完全无界面的 Gateway 后端”。Xpod 仍以后台服务为主体，但安装后提供一个可从托盘或本地入口打开的轻量设置界面。它与 Linx 使用同一套 Applet SDK、布局、认证展示和业务 applet；区别只在 host 入口和 host capability。

本设计覆盖并替代 `2026-07-23-pod-ai-gateway-design.md` 中“Xpod 无界面、第一期不新增用户可见 Xpod 应用”的产品边界。Gateway 的安全、协议、Pod 持久化和 Provider 约束保持不变。

## 产品目标

用户安装并启动 Xpod 后，不需要同时安装 Linx 就能完成 Xpod 的核心设置：

- 登录当前 Solid 身份并查看当前 WebID/Pod。
- 管理 AI Provider、Credential、模型和剩余额度。
- 查看 Pod、Network 和 Services 状态。
- 创建 Gateway Key。
- 将 Xpod Gateway 应用为 Codex、Claude Code、Pi 或 CodeBuddy 的后端。
- 使用 `/v1/models`、`/v1/responses`、`/v1/messages` 和 `/v1/chat/completions`。

Linx 仍可发现并承载相同 applet。Applet 不感知 host 是 Xpod 还是 Linx，也不感知 deployment 是 local 还是 cloud。

## 产品形态

### 运行方式

Xpod 的服务进程保持现有生命周期。桌面封装存在时，启动后收进系统托盘；浏览器部署或开发模式使用本地 Dashboard URL。两种入口打开同一个轻量设置应用，不复制业务代码。

第一阶段以现有 `ui/` Dashboard 作为可执行 host，保留未来桌面托盘壳的 capability 边界。托盘壳只负责窗口生命周期、系统浏览器、客户端配置文件和安全存储等桌面能力。

### 信息架构

设置应用使用 SDK 的 `AppLayout` 和 `TwoPaneLayout`：

- 左侧导航：
  - `Models`
  - `Pod`
  - `Network`
  - `Services`
- 右侧主区：当前模块内容。
- 搜索位于 AppLayout header，而不是 applet 自己的内容区。
- 窄屏使用 SDK stack navigation；选择列表项进入详情，返回恢复列表和焦点。

Xpod 的入口是“设置展开态”；Linx 可从发现/扩展入口打开同一 applet。视觉 token、间距、控件和认证展示均来自共享 SDK/shared-ui。

## Host 与 Applet 边界

### Host 拥有

- `AppLayout` 外框与四个一级入口。
- Solid session 生命周期、OIDC redirect 恢复和当前 WebID。
- Xpod API endpoint。
- 桌面能力：打开系统浏览器、托盘、文件配置、安全存储。
- Network/Services 的管理 API capability。
- 错误边界、路由、历史和全局搜索。

### Applet 拥有

- 自己的 workspace descriptor 和 slots。
- 模块内列表、详情、表单和空状态。
- 通过 capability 调用 Pod、Gateway 或桌面功能。
- 不读取 host 环境变量，不判断 local/cloud，不创建第二套 Solid session。

### 共享 SDK

- `AppLayout`
- `SinglePaneLayout` / `TwoPaneLayout` / `ThreePaneLayout`
- `AppletLayoutDescriptor`
- `AuthBoundary` / `LoginView`
- stack navigation、焦点和 host-owned history adapter

## 四个设置模块

### Models

Models 使用 AI Connection applet，是旧 Model 管理的升级版。

Provider 矩阵：

| Provider | 浏览器 Connect | API Key |
| --- | --- | --- |
| OpenAI / Codex | 支持 | 支持 |
| Anthropic / Claude | 支持 | 支持 |
| Kimi | 支持 | 支持 |
| 阿里云百炼 | 支持 | 支持 |
| DeepSeek | 官方第三方 OAuth 不可用时显示不支持 | 支持 |

页面展示两类独立状态：

- `已配置`：存在可用配置或 Credential。
- `已连接`：浏览器 Connect 产生的 Credential 当前有效。

两种认证模式不可静默回退或互换。浏览器 Connect 只允许 Xpod/Provider 正式注册的 OAuth client；不得复用官方 CLI client id，不得抓 Cookie。

Models 还提供：

- 默认模型和模型目录。
- Credential 健康状态、重新授权和删除。
- Provider 官方支持的余额/额度窗口；不支持时显示 `unsupported`。
- Gateway Key 的创建、撤销和一次性明文展示。
- Codex、Claude Code、Pi、CodeBuddy 的检测、预览、应用、验证与恢复。

编码客户端只获得 Gateway Key，不获得 Provider Credential。

### Pod

Pod 模块展示和管理：

- 当前 WebID、Pod URL、issuer 和登录状态。
- 存储健康、已用空间和配额。
- AI Connection 数据容器和最后同步状态。
- 重新登录、退出和打开 Pod。

Pod 数据使用 drizzle-solid 与 `@undefineds.co/models`。Host 只提供当前 authenticated fetch/session；组件不创建 Session。

### Network

Network 模块通过 Xpod 管理 API 展示：

- 当前可访问 endpoint。
- 本机、局域网、公网地址。
- HTTP/HTTPS 端口。
- TLS 证书状态和过期时间。
- DNS/DDNS、隧道和连接诊断。

UI 不根据 `deployment: local | cloud` 分支渲染；服务端返回 capability/status，自描述哪些操作可用。

### Services

Services 模块整合现有运维页面：

- Xpod runtime
- Solid server
- AI Gateway
- 存储与数据库
- 后台 worker
- 日志
- RDF 状态

默认只读展示健康和版本。仅当 host capability 明确允许时显示启动、停止、重启或修复操作。现有 `/dashboard/status`、`/dashboard/logs`、`/dashboard/rdf` 能力保留并迁入此入口，不删除后端 API。

## 数据与认证流

### Solid 登录

Xpod host 只维护一套 Solid session：

1. 启动时恢复 redirect/session。
2. `AuthBoundary` 接收 `loading | anonymous | authenticated | error`。
3. `LoginView` 收集 issuer 并调用 host 的 login。
4. Applet 通过统一 runtime hook 获得 WebID、Pod 和 authenticated fetch。
5. Token 过期由 Solid OIDC session 刷新或重新登录，不保存浏览器 Bearer/DPoP 作为服务端回退。

### Provider Credential

1. 用户选择 Connect 或 API Key。
2. Host/Gateway 校验当前 WebID。
3. Gateway 使用 envelope encryption 封装 secret。
4. 密文、wrapped key 和 metadata 写入当前 WebID 的 Pod。
5. 明文仅在交换、刷新或上游调用期间存在于内存。

加密是 Pod 凭证资源的统一数据要求，不由 UI 选择。Applet 不感知 Keychain/KMS；它只看到 Credential 状态。

### Gateway 推理

编码客户端使用 `Authorization: Bearer xpod_...` 调用 Xpod。Gateway Key 定位当前 WebID，并从其 Pod 读取 Provider/模型/Credential。标准协议前端统一投影到 Gateway core，再由 Provider adapter 调用上游。

## API 与 Capability

轻量设置 host 需要以下稳定 capability：

- `session`: 当前 WebID、issuer、Pod、authenticated fetch、login/logout。
- `pod`: 读写模型资源、Pod 状态和配额。
- `aiConnection`: Provider、Credential、Connect、quota、models、Gateway Key。
- `aiClientConfiguration`: detect/plan/apply/verify/restore。
- `network`: status/diagnose 和允许的管理动作。
- `services`: health/logs/rdf 和允许的生命周期动作。
- `navigation`: workspace、history、open external URL。

Capability 返回 `supported`/`unsupported` 和原因，避免 applet 猜测部署类型。

## 错误、安全和恢复

- Provider、Gateway Key、OAuth code、Cookie 和 DPoP 材料不得写入日志。
- 所有用户级 AI 配置写 Pod，不用服务器环境变量作为产品配置。
- OAuth client registration 属于部署配置，不属于用户 Credential；缺失时 UI 显示明确的 `not_configured` 指引。
- API Key 保存失败必须返回结构化错误，不显示泛化的 HTML 500。
- 客户端配置修改前生成计划与备份，验证失败自动回滚。
- Network/Services 的破坏性操作要求 host capability 和二次确认。
- Pod、包装密钥或认证不可用时 fail closed。

## 独立测试与验收

### 单元与组件

- 四种 layout 与窄屏焦点/history。
- AuthBoundary 单 session 行为。
- 四个设置模块的 loading/empty/error/unsupported。
- 五家 Provider 的认证矩阵。
- API Key 录入同类 Provider 至少一条真实实现契约，其余按 adapter 合同覆盖。

### 集成

- Solid OIDC redirect/session 恢复。
- drizzle-solid 对 Provider/Credential/Gateway Key/Quota Snapshot 的 CRUD。
- Pod 中无明文，跨 WebID 不可读。
- Connect callback/device flow 与过期处理。
- Network/Services 管理 API。
- 四个编码客户端的 plan/apply/verify/restore。

### 端到端完成门槛

- Xpod 设置应用可独立启动并通过真实登录进入。
- Models、Pod、Network、Services 四个入口均展示真实数据，不使用产品 mock。
- API Key 可保存、重载和删除。
- 至少一种已配置 OAuth client 的浏览器 Connect 完成真实授权；其他 Connect adapter 通过 provider contract 测试，并在缺少 client registration 时准确显示 `not_configured`。
- `/v1/models` 返回当前 WebID 可用模型。
- Codex 通过 Xpod 完成一次流式回答和一次工具调用。
- `bun run build:ts`、UI 测试、相关专项测试和 `bun run test:integration` 全部通过。
- 可生成一份不含 secret 的手工验收记录。

## 实施顺序

1. 将已完成的 Extension SDK 合入可供 Xpod 消费的共享包。
2. 建立 Xpod 轻量设置 host 和四入口信息架构。
3. 接入统一 Solid session 与 AuthBoundary。
4. 接入 AI Connection applet 和 Gateway 管理 API。
5. 接入 Pod、Network、Services capability。
6. 接入编码客户端配置能力和桌面/本地桥。
7. 补单元、集成和真实端到端验证。
