# Cloud / Local / Standalone 服务验收

## 范围与执行顺序

本分支验证 Bun 优先启动和 AI Connections 服务链路；QLever 保持关闭，由独立分支验收。三种模式必须使用同一份源码构建的镜像，不能用不同 worktree 或旧镜像的成功结果拼成一个发布结论。脏工作树必须记录镜像 digest，不能只用 Git HEAD 声称源码一致。

三种模式共用一个服务镜像，不按模式重复构建。产物、运行依赖、桌面壳与数据库扩展的归属遵循 [Xpod 镜像边界](../docker-image-boundaries.md)。

本轮调整计划：

1. 用回归测试锁定验收目标：Local 必须经过 Cloud account provisioning，Cloud / Standalone 必须使用各自的账号与存储；不能把“有任意一个 Pod”当作本机绑定成功。
2. 扩展现有真实 Gateway 验收脚本，仅按部署模式选择账号/Pod 创建路径；Pod、API Key、models、Chat 的检查保持共用。证据分模式保存，不能相互覆盖。
3. 修复矩阵实际暴露的运行时/配置问题，不以硬编码可达地址、关闭认证、延长超时或 mock 代替修复。
4. 重建同一镜像并依次验收，再运行完整集成回归。Web/桌面会话恢复另列实测，client credentials 登录不能替代浏览器 OIDC/refresh 验收。

修复迭代可叠加 `docker-compose.acceptance.dev.yml`，将同一份 `dist` 和已锁定 SDK 补丁只读挂载到三种服务，不重装/重复打包依赖。此结果仅用于定位回归；发布证据必须去掉该 override 后，以同一新镜像重新执行全部检查。

## 必须覆盖的矩阵

| 项目 | Cloud | Local + Cloud | Standalone |
| --- | --- | --- | --- |
| 存储部署 | PostgreSQL / Redis / MinIO | 本机 SQLite / 文件 | SQLite / 文件 |
| 身份来源 | 自身 IdP | 同源测试 Cloud IdP | 自身 IdP，不依赖外部 Cloud |
| Pod 创建 | Cloud account API | Cloud account API 携带 Local provision code | 本机 account API |
| Pod 规范地址 | Cloud 返回的地址 | Cloud 分配的 managed SP 地址 | 明确配置的本站地址 |
| 实际读写路径 | Cloud Gateway | SDK 选择 Local Gateway，规范地址不变 | Standalone Gateway |
| CSS / API 运行时 | 验证实际子进程 | 验证实际子进程 | 验证实际子进程 |
| 认证负例 | 未认证拒绝 | 未认证拒绝 | 未认证拒绝 |
| API Key 生命周期 | 创建、列表、恢复明文、停用/启用、删除 | 同左 | 同左 |
| AI 配置 | Provider 凭据和模型写入 Pod 后重新读取 | 同左 | 同左 |
| Models | 已选模型非空且与 Pod 一致 | 同左 | 同左 |
| Chat | 实际请求并校验响应，不只检查 HTTP 200 | 同左 | 同左 |
| 会话恢复 | 单独验证 OIDC/refresh | 单独验证 OIDC/refresh | 单独验证 OIDC/refresh |

## 证据规则

- 测试入口连接已运行的真实 Xpod，不在脚本内部悄悄创建替代栈。
- Docker 测试 Cloud 与现网 Cloud 是不同验收对象；本轮不部署现网。
- Pod 读写、客户端 API Key 认证、models 和 Chat 是独立层级，任何一项失败都不能报告“全通”。
- 缺少真实 Provider 凭据时，Chat 必须标为未完成；协议 fixture 只能证明接口兼容，不能代替真实上游推理。
- P2P listener smoke 不代表生产 simultaneous-open 路径通过。必须验证实际 EdgeNodeAgent 路径并记录使用的 transport。
- 日志与报告不得包含密码、client secret、access/refresh token、provision code 或完整 API Key。

## 当前执行状态

2026-08-28，已去掉开发 override；修复 OIDC provision code 与开发代理入口处理后，10:45 再次以同一镜像完成三种模式的真实 Provider / Chat 接口验收：

- 三个运行容器的镜像 ID 均为 `sha256:a67d5393b311b527028b78000459475eac09f69ae0fa0a8a67f03a767f7b7836`。
- 三个服务仅挂载各自的具名数据卷，没有源码、`dist` 或 `node_modules` bind mount；`XPOD_RDF_NATIVE_SPARQL_ENABLED=false`。
- 分别读取实际 Gateway / CSS / API 进程的 `/proc/<pid>/exe`，九个进程均为 `/usr/local/bin/bun`，镜像内 Bun 版本为 `1.3.8`。
- 验收 runner 来自宿主工作树，不冒充镜像内客户端；runner、lock、Dockerfile 与依赖补丁的 SHA-256 单独记录。

这是本地隔离 Docker 矩阵，不是现网 Cloud 或正式发布结论。

| 检查 | Cloud | Local + Cloud | Standalone |
| --- | --- | --- | --- |
| 启动与身份 / Pod 创建 | 通过 | 通过，Cloud 身份 + managed SP | 通过，独立 IdP |
| 规范 Pod 地址读写 | 通过 | 通过，观察到 SDK 走 `127.0.0.1:16310` | 通过 |
| Key 创建、列表、恢复明文 | 通过 | 通过 | 通过 |
| 停用拒绝、重新启用、删除后拒绝 | 通过 | 通过 | 通过 |
| Provider 凭据写入 Pod / 重新读取 | 通过，DeepSeek API Platform | 通过，同左 | 通过，同左 |
| 非空 models / 真实 Chat | 通过，2 个已选模型；Chat 精确返回 `XPOD_OK` | 通过，同左 | 通过，同左 |
| Web 表单录入 / 刷新持久化 | 未完成 | 未完成 | 未完成 |
| 浏览器 OIDC / refresh 恢复 | 未完成 | 未完成 | 未完成 |

证据文件：

- `.test-data/acceptance/matrix-image-evidence-20260828.json`：旧 `027a2c24` 镜像的挂载、QLever 开关和源码校验值，不能当作最新镜像快照；当前三个容器的镜像 ID 与仅含具名数据卷的挂载已用 `docker inspect` 重新核对。
- `.test-data/acceptance/matrix-runtime-evidence-20260828.json`：01:37 左右的实际运行时、分层结果和 Key 删除后的检查；该历史快照早于提供测试 Provider 凭据，不能覆盖下列新报告。
- `.test-data/acceptance/live-gateway-login-chat-{cloud,local,standalone}.json`：10:45 三模式分别生成的真实请求报告；对应日志为 `matrix-{mode}-origin-fix.log`，三个命令均退出 `0`。08:38–08:40 的历史日志保留为 `live-matrix-{mode}-deepseek.log`，此前缺凭据的记录留在 `live-matrix-{mode}-image.log`。
- 先前开发挂载结果另存为 `live-gateway-login-chat-{mode}.dev-mount.json`，不能与本次镜像证据混用。
- `.test-data/acceptance/integration-binding-web-final.log`：11:51–11:53 对当前宿主源码执行完整 `test:integration`，lite 为 142 通过 / 5 跳过，full 为 40 通过，命令退出 `0`。该回归不是镜像内执行，也不替代下述真实 Provider / 浏览器验收。

报告中的 `gatewayAuth.ok` 只证明 Key 认证和生命周期；空 `models` 不算 AI 可用。新一轮在写入 DeepSeek 凭据后实际发现 3 个模型，选择 `deepseek-v4-flash` / `deepseek-v4-pro`；三个 Gateway 的 `/v1/models` 均返回这 2 个已选模型，`/v1/chat/completions` 均用 `deepseek-v4-flash` 返回 HTTP 200，且脚本断言正文精确等于 `XPOD_OK`。Provider 写入失败时，即使旧模型列表非空，也不能标记 AI 配置或 Chat 通过。

这轮使用的是既有 runner 创建的独立测试账号，通过 caller-owned Pod store / drizzle-solid 保存凭据，不是浏览器表单录入。没有把它计入 Web 登录、Web 表单保存或浏览器会话恢复。

Local 的本次规范 Pod 为 `https://acceptance-local.nodes.acceptance.test/a-local-2d45d4fe/`，WebID 来自测试 Cloud 的 `http://cloud.localhost:16300/a-local-2d45d4fe/profile/card#me`；PUT / GET 观察到的实际目标为 `http://127.0.0.1:16310/a-local-2d45d4fe/…`。规范身份和存储地址没有改写为 loopback。

本轮已修复 Cloud 内部数据读取的预签名重定向、有效 Gateway Key 缺少运行权限上下文，以及实际安装的 shared models 缺少 `disabledAt` 导致停用更新被忽略的问题。模型契约与临时补丁边界见 [问题记录](../issues/2026-08-28-models-gateway-key-disabled-at.md)。

Web 开发入口继续使用 `http://127.0.0.1:5173/settings/`，后端指向本机 Local Gateway。另外已在浏览器打开镜像自带的 `http://127.0.0.1:16310/settings/pod` 和 `/settings/runtime`：匿名 Pod 设置只显示连接卡片，不挂载主框架；本机 Runtime 设置不要求 WebID，实际加载出设置页面。此页面检查不替代已登录后的 Pod 配置读写或浏览器会话恢复。

本次镜像的 TypeScript、Components.js、packages 和全部 Web bundle 编译成功。BuildKit 完整导出镜像后，本机 Docker 的 16 GB 虚拟磁盘在解包阶段不足；清理本任务已用完的编译缓存后，用保留的同一镜像归档重新加载，`docker image load` 成功，随后完成上述运行验证。保留 `image-build-20260828-retry.log` 和 `image-load-20260828.log`，不把第一次解包失败的退出状态改写成成功。旧验收镜像已备份到宿主机，账号和 Pod 数据卷未删除。

三模式真实 Provider / Chat 接口层已经通过，但 Web 表单录入、浏览器登录 / 会话恢复仍未收口；镜像依赖边界的已知偏差也仍以 [镜像边界文档](../docker-image-boundaries.md) 为准，不能据此发布。

## Web 验收过程中的 Loading 修复（2026-08-28）

Xpod 的 `LoadingScreen` 原先没有传入 `AuthSurface` 的 `compact` 配置，
因此初始化使用了宽卡片，登录后又切换为小卡片。现已复用公共组件的尺寸、
Xpod 品牌组件和宿主判断，不改 shared-ui 的默认表现，也不添加独立尺寸规则。

- 真实浏览器分别测量源代码组件预览与当前测试 Cloud 登录卡片，两者均为
  `280 × 400`；预览无内部滚动条。结构化记录为
  `.test-data/acceptance/loading-layout-20260828.json`。
- 新增两个回归用例，覆盖 Web 小卡片和桌面窗口铺满；连同既有登录边界和
  公共卡片测试共 14 项通过，日志为 `loading-screen-green.log`。
- 根 TypeScript、UI TypeScript、变更文件 ESLint、Account UI bundle 构建通过。
  构建仅输出到 `.test-data/acceptance/loading-app-build`，运行中的 Docker
  镜像没有替换；不能把组件预览当作已部署界面或登录验收。
- 完整集成首轮为 140 通过 / 5 跳过 / 2 失败，失败是通知 GET 和 POST
  验证的 1 秒性能阈值（实际 1396ms、2245ms），见
  `loading-integration-20260828.log`。没有放宽阈值；构建结束后完整重跑
  `bun run test:integration` 退出 `0`，lite 为 142 通过 / 5 跳过，full
  为 40 通过，见 `loading-integration-20260828-retry.log`。首轮失败记录保留，
  不因重跑成功而删除；性能用例仍需注意并行构建造成的资源竞争。

用户已授权 Web 表单验收，并已通过浏览器创建独立账号
`accept-web-mtcam75t@test.com`。它的 WebID 为
`http://cloud.localhost:16300/accept-web-mtcam75t/profile/card#me`，Profile
实际声明 `solid:storage` 为
`https://acceptance-local.nodes.acceptance.test/accept-web-mtcam75t/`；服务
重建后再次读取仍存在，后续登录直接进入授权，不再创建 Pod。

这不代表 Web 数据链路完成：当前开发代理经 Docker bridge 到 Gateway，
不被识别为 loopback；Gateway 按安全边界移除了 local-route headers。
Inrupt 对已改写的本地请求 URL 签名，而 CSS 使用 canonical URL 验证，
Pod SPARQL 因此返回 DPoP URI 不匹配。它是路由与认证顺序的问题，不是
Profile 缺失绑定，也不能用再次创建 Pod 或放宽令牌校验修复。

源码已另补 Unix socket 场景下的内部签名证明回归，但当前 Docker 服务
实际使用 TCP；该修复不等于 Docker bridge 问题已解决，且尚未包含在
上述镜像。Web Provider 表单写入、同一 Web 账号的 API Key / Chat 和
浏览器会话恢复仍未完成，不复用 runner 账号的通过结果替代。
