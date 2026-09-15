# 登录状态与路径审计（2026-09-15）

执行批次跨 2026-09-15 至 2026-09-16；证据目录沿用批次起始日期。

后续针对失败回退的实现、独立窗口尺寸与新增验收见 [交互恢复设计与验收](login-interaction-recovery.md)。

本轮以当前工作区为基线，继承 [登录状态矩阵](login-state-matrix.md) 与
[认证权威边界](../superpowers/specs/2026-08-30-xpod-auth-authority-boundaries.md)。
Account、WebID、Pod 的状态独立；不引入第三种合成会话。

## 工作范围与顺序

1. 梳理浏览器、Account 页面、桌面与 CLI/API 客户端入口。
2. 对可复现的错误先补失败回归，再作最小修复；保留现有未提交修改。
3. 验证登录、恢复、过期、取消、退出与切换账户；单独确认失败是否跨越身份边界。
4. 执行完整后端集成、真实浏览器与 Electron 回归，并连接当前 Gateway 验收。

## 状态与路径地图

| 入口 | 路径与状态 | 权威与验收点 |
| --- | --- | --- |
| Account 登录 | `/.account/` → password → controls → Account 路由 | CSS controls 必须确认 account；错误不等于匿名 |
| 注册 | register → 邮箱/密码关联 → 首 Pod → consent 或原应用 | 不重复提交密码；保留原 interaction 与 returnTo |
| 密码恢复 | forgot-password → 邮件链接 → reset-password → 原登录入口 | 请求必须发往当前 Account authority；失败可重试 |
| WebID 登录 | 受保护页面 → authorize（state/PKCE）→ CSS interaction → consent → `/auth/callback` | Inrupt 兑换 code；拒绝错配 state/client/issuer 与重放 |
| applet 发起 | 内置 applet / 独立 host → `host.solid.requireLogin` → 身份服务 → applet callback → 原 applet 路由 | applet 只消费 host 身份能力；独立 origin 也验证 PKCE、WebID 与鉴权 Pod 请求 |
| Pod 就绪 | WebID → storage discovery → 精确绑定 → 实际鉴权请求 | 不用 Account cookie 或公开 profile 代替私有数据权限 |
| 路由切换 | Status ↔ AI Connections / AI Config ↔ Network | 分别要求 Account、WebID/Pod、本机权限；无全局联合登录门 |
| 刷新与冷启动 | SDK restore → 已认证或显式重新登录入口 | 有效会话复用；失败不无限 silent login；公开记住信息不是凭据 |
| 双标签页 | 各自 interaction → 独立 state/client/PKCE → 各自 callback | 取消或返回一个事务不能消耗另一事务 |
| 产品退出 | WebID cleanup → CSS logout → 已确认匿名 | 每层失败可重试；迟到 controls 不得恢复旧身份 |
| 切换账户 | 完成旧身份退出 → 新登录 → 新 Pod | 旧异步结果与旧 Pod 不能覆盖新用户 |
| 桌面 | 原窗口登录回调；关闭到托盘；完整退出再启动 | 业务窗口关闭保留 document；仅登录页面执行取消 |
| CLI | password login → CSS client credentials → SDK session → logout；另支持读取已保存的 OIDC 会话 | 当前 CLI 没有发起浏览器登录的命令；退出清理凭据入口与 SDK 恢复材料 |
| API 客户端 | `sk-` wrapper → CSS 校验 → WebID principal | 错误 secret 不得复用同 client ID 的缓存；过期后重新校验 |

## 本轮修复

- Account 退出开始和完成时淘汰在途 controls/consent 请求，避免旧响应恢复身份。
- Account 匿名状态以 CSS 响应为依据，连续退出失败仍保留恢复入口。
- 桌面同源 Cloud/Standalone 的业务窗口关闭只隐藏，不触发登录取消或重载。
- 可选客户端凭据缓存同时绑定 secret 与 token endpoint，使用摘要键；过期后重新校验 CSS。
- CLI 退出清理 Inrupt 持久恢复资料，避免仅删除 credentials 后仍可恢复会话。
- 未知 Account 状态退出时重新发现并获取 CSS controls；损坏响应不能当作匿名成功。
- 找回/重置密码复用 Account authority 地址解析；返回登录保留原应用 `returnTo`，不携带重置令牌。
- Account controls 刷新返回明确认证状态；密码表单只在 CSS 确认 authenticated 后继续，unknown/error 不当作登录成功。
- 只有 WebID 已登录时也展示用户卡，允许退出与切换；不挪用已记住的 Account 身份作为当前用户。
- 切换账号显式传递标准 `login` 重新认证意图，初始化时不自动恢复旧会话，并保留 Strict Mode 下的一次性切换意图。当前 Cloud 不支持 `select_account`，已用真实响应验证后修正。
- 上游 OIDC 授权错误单独呈现，仍经过 SDK 校验/清理；明确错误回调不接受已有身份，不显示未经信任的 error_description。
- applet host 的会话 getter/subscription 直接委托 SDK Session，删除创建时 runtime 快照的重复投影；退出/过期立即停止通知连接，重订阅不复活旧身份。
- Account 表单新增独立“记住账号”选项，默认勾选；取消传入 CSS `remember: false`，失败重试保持选择，提交期间禁用。服务端持久/会话 Cookie 属性不被前端同步覆盖，与“记住应用”分开。
- 有效 WebID 与 Account 属于不同人时，用户卡的姓名、用户名、资料失败回退与复制目标都取该 WebID；Account-only 仍展示 Account，避免显示 B 却复制 A。
- 应用 grant 刚过期但仍在 Provider 时间容差内时，以新无授权 scope 的 grant 进入 consent；不延长旧 grant，避免重新确认后 code 兑换仍被旧过期 grant 拒绝。
- 将现有 Bun 构建/运行版本统一到已验证的 1.3.12，修复旧 1.3.8 下大脚本响应中断导致的空白或回调加载挂起；独立 64 次完整性回归有版本红绿对照，详见 [传输回归](bun-http-response-completeness.md)。没有修改 Gateway 流逻辑或全局 Bun。
- WebSocket 尚在等待上游握手时，客户端退出或断网会立即清理连接；不再等待上游成功后才监听客户端关闭。该竞态已在两个 Bun 版本复现并修复，避免对已失效的 Request 继续 upgrade。
- 内置桌面 client 在共享 Provider 工厂中正式注册，服务端、UI 与公开 metadata 产物读取同一份 JSON；Standalone 授权不再为已知 client 等待公网 metadata。已有显式 client 配置保留，其他 client 仍走 CSS adapter。
- 同意页面停留期间 grant 到期时，返回 Provider 重新计算授权要求，再由用户明确确认；容差内原来的 token 400、容差外原来的 consent 500 均有红例。拒绝不兑换 token，也不保存记住授权。

### 修复文件

| 范围 | 实现 | 回归 |
| --- | --- | --- |
| Account 状态与退出 | `ui/src/context/AuthContext.tsx`、`AuthContextValue.ts`、`ui/src/auth/XpodAccountCredentials.tsx` | `ui/src/auth/AuthContext.test.tsx`、`XpodAccountCredentials.test.tsx`、`XpodProductLogoutBoundary.test.tsx`、`tests/e2e/shared-login.spec.ts` |
| WebID 用户卡与切换 | `ui/src/layout/XpodUserCard.tsx`、`ui/src/solid/WebIdAuthBoundary.tsx`、`ui/src/auth/xpod-login-recovery.ts` | 对应用户卡、边界回归与真实 Alice → Bob 浏览器用例 |
| 密码恢复 | `ui/src/pages/ForgotPasswordPage.tsx`、`ResetPasswordPage.tsx` | `PasswordRecovery.test.tsx`、`AuthPages.test.tsx` |
| 桌面关闭 | `desktop/src/main.ts`、`login-recovery.ts` | `desktop/test/login-recovery.test.ts`、`tests/e2e/desktop-login-lifecycle.spec.ts` |
| 客户端凭据缓存 | `src/api/auth/ClientCredentialsAuthenticator.ts` | `tests/api/ClientCredentialsAuthenticator.test.ts` |
| CLI 退出 | `src/cli/commands/auth.ts` | `tests/cli/auth-credentials-store.test.ts`、`tests/integration/CliPasswordLogin.integration.test.ts` |
| applet 会话事件 | `ui/src/extensions/ai-connections-host.ts` | `ai-connections-host.test.ts`，结合通知通道回归 |
| 上游授权错误 | `ui/src/solid/XpodOidcCallbackApp.tsx`、`packages/solid-sdk/src/webid-auth.ts` 协议类型 | callback 单元与 shared-login 的真实 IdP 错误负例 |
| 记住账号 | `ui/src/auth/XpodAccountViews.tsx`、`XpodAccountCredentials.tsx`、`ui/src/pages/WelcomePage.tsx` | `AccountRememberChoice.test.tsx`、`tests/ui/account-session.test.ts`、`AccountCookieMemory.integration.test.ts`；Account 相关 15 文件 170/170 |
| 跨身份资料展示 | `ui/src/profile/useXpodProfileCardIdentity.ts`、`ui/src/layout/XpodUserCard.tsx` | profile、用户卡与新增真实 hook 组合测试 20/20；红例 3 项先证实原缺陷 |
| 应用授权到期 | `src/identity/oidc/RememberedClientPromptFactory.ts`、`RememberedConsentHandler.ts` | 最终 `RememberedClientGrantHttp.test.ts` 16/16、`RememberedClientGrant.test.ts` 17/17；包含同意页停留到期与拒绝、真实 SDK 2 秒 access token 后台 refresh 与 UserInfo |
| 桌面客户端离线声明 | `SessionBoundIdentityProviderFactory.ts`、`src/identity/oidc/xpod-desktop-client.json`、`ui/vite.config.ts`、UI client ID 读取 | 阻断公网 metadata 的真实 CSS adapter 授权红→绿，纳入最终 HTTP 16/16；工厂 13/13、metadata 1/1、Vite 10/10、UI runtime 64/64 |
| Bun 传输基线 | 根目录与 UI `package.json`、`Dockerfile`、现有 8 个 workflow 与 `scripts/docker-managed-p2p-e2e-smoke.ts` 的版本值 | `proxy-response-completeness.spec.ts` + 独立内存上游；旧版失败，新版 64/64 长度、SHA-256、执行标记通过 |
| 退出时取消未完成连接 | `src/runtime/upgrade/BunNativeUpgradeRelay.ts` | 真实延迟握手/提前关闭红例；Bun 1.3.12 与 1.3.8 各 9/9、Node 协议回归 25/25；不代替通知产品端到端 |

复用已有 controls 获取、authority 解析和 SDK storage 清理入口，没有新增依赖或认证模型。

### 测试门禁修正

`tests/http/ServerLogin.integration.test.ts` 原有部分断言允许废弃注册路径的 404、
未验证凭据的“成功”响应或受保护资源的 404。本轮改为动态 CSS controls 与精确 Account ID：
登录必须返回有效 authorization/cookie，两者分别读取同一个受保护账户并得到原邮箱；
错误密码和不存在的邮箱必须 403 且无认证产物，匿名账户 API 必须 401。
第二个新账户占用既有邮箱必须 400，第二账户仍无 password login，原账户身份不变。
强化后的文件实际 HTTP 验收 12/12 通过，日志 `server-login-strengthened.log`。

新增浏览器测试访问复用 `tests/helpers/browserXpodRuntime.ts`，只读取当前已提交的 React provider，
调用现有 SDK/Account/Pod 实例。回归先复现初始 Fiber/alternate 读到旧身份的问题，
再验证 A→B→第二 Pod→匿名始终读取最新值（1/1）。部署退出还须重读退出前的真实 Account control 并收到 401/403，
不能只检查前端匿名或原本就被拒绝的匿名 Pod 请求。

`browserSolidOidc.ts` 通用按钮驱动曾在密码表单刚挂载时跳过填入凭据，直接空提交。
真实 trace 证实请求邮箱/密码均为空。修复先排除密码表单，再将表单检查与同一 DOM 节点点击
合并到一次浏览器任务，避免 Locator 二次解析时换成另一表单；确定性竞态回归先红，最终 9/9。
没有增加自动重试、等待或超时。旧 48 项尝试中该失败为 46 通过、1 失败、1 未运行，
日志 `browser-final-bun1312.log` 保留；最终整轮另记，不能将历史尝试改写为全部通过。

### 边界

- 当前生产容器没有注入可选 token cache；启用缓存时，已缓存 token 的撤销生效仍受其有效期约束。
- CSS 原生邮件恢复负责 `forgot/ → EmailSender → reset/?rid=…`，重置记录一次性消费；当前产品没有独立注册邮箱验证页面。本轮页面和协议测试不证明真实邮箱投递。
- Account 登录用于身份服务账户操作，WebID 登录用于 applet/产品获取 Pod 访问能力；两者可以使用不同尺寸。尺寸差异本身不是缺陷，不要求统一；本轮验收以各自职责与完整交互为准。

## 验收记录

证据根目录：`.test-data/login-audit-20260915/`。结果区分单元测试、隔离服务回归、
故障注入与当前实例，不将其中一种通过扩称为全部部署通过。

### 重跑入口

使用仓库声明的 Bun 1.3.12，先执行 `bun run build:ts`、`cd ui && bun run build:all`，以及
`cd desktop && bun run build`。三模式矩阵还需 Docker、可运行 Electron 的桌面环境，
并通过 `XPOD_QLEVER_LOCAL_RUNTIME_COMMAND` 指向安装版原生 QLever；不能用测试替身替代。

```sh
# 完整后端集成（lite + full）；跳过项单独报告
bun run test:integration

# 常规浏览器认证回归
bun run test:integration:auth

# 隔离 Cloud / Managed Local / Standalone：浏览器 6 项后串行桌面 3 项
XPOD_PLAYWRIGHT_SYSTEM_CHROME=1 bun run test:integration:auth:matrix
```

矩阵 runner 维护一次三服务生命周期与私有 manifest；两组测试使用独立输出目录，
成功或失败均回收自己创建的服务、容器与测试数据，不连接或改动现有 Gateway。

| 层级 | 已取得的证据 |
| --- | --- |
| UI / SDK / 桌面单元回归 | Host 29 文件 / 359 项、SDK 74、Account 页面 76、桌面 137；后端凭据/CLI 定向 14 |
| 最终认证 / Pod 组合 | 51/51 同轮通过、零重试（10.8 分钟）：跨 origin 3、外部 applet 5、原生 Pod HTTP/SDK 5、shared-login 38；最新后端与原子按钮 helper；日志 `browser-verified-final.log` |
| 加载后的浏览器离线 | shared-login `@offline` 4 项全部纳入最终 51/51：Account 提交失败后恢复（不创建 WebID）、有效会话私有 Pod 断网/恢复、离线退出部分失败后重试、callback 断网后新 code 成功；安装版 QLever，系统 Chrome；最初定向 4/4 另记 `offline-first.log` |
| 三部署 / 两个正式 applet | 最终联合 runner 中 `login-deployment-matrix.spec.ts` 6/6（Bun 1.3.12）：Cloud、独立 Cloud issuer + Managed Local、Standalone 各从 AI Connections / AI Config 完成注册或登录、原路由、私有 Pod、刷新、断网恢复、Account 身份与离线退出重试；原 Account control 注销后 401/403；日志 `deployment-matrix-nine-final.log` |
| 当前 Gateway 的边角复验 | 保持原 3000 进程，生产 UI → 公共 Cloud OIDC → 精确原有 Pod；PUT 201、GET 200/正文一致、整页网络关闭后同一身份恢复、刷新后再读、DELETE 205、产品退出清理；`live-edge.json` / `live-edge-run.log` |
| 原生 Pod HTTP / SDK | `real-pod.spec.ts` 5/5；使用安装版 QLever与正式客户端凭据 Session 鉴权读写；由 Playwright 调度但不操作浏览器 UI |
| 外部 applet | `external-applet-login.spec.ts` 5/5 同轮通过，审查强化后 2/2 复验；独立 host origin → 真实 Xpod Account/consent → 原路由、DPoP Pod GET 200、A→B、刷新恢复/退出、拒绝授权与 state 篡改；退出后等待 SDK 恢复结束并确认无新授权/token 请求，错 state 在 token POST 前被拒绝 |
| 跨 origin 协议 | 3/3；真实浏览器/OIDC，picker/consent 页面为协议夹具，不代表生产 Cloud UI |
| 跨 issuer 协议 | `issuer-isolation.integration.test.ts` 3/3；两个真实 provider、独立存储、真实 Inrupt；A 正控、B code → A token endpoint 拒绝、B 签名 token 的 issuer 拒绝；不冒称 Host Pod/UI 负例 |
| Electron 三部署 | 同一联合 runner 中 3/3（29.5 秒）：精确 WebID/Pod/issuer、Account controls 归属、私有 PUT/GET 与匿名拒绝、托盘同 document/renderer/session、第二实例唤回、完全退出后读取原私有文件。每格密码提交严格为 1 次；独立 Standalone 基线另 1/1 |
| 密码恢复 HTTP | `PasswordRecovery.integration.test.ts` 1/1；真实 CSS 密码与 token store，仅捕获外发邮件；新密码成功、旧密码 403、token 重放/篡改/过期 400、未知邮箱不泄露是否注册 |
| CLI 跨进程 | `CliPasswordLogin.integration.test.ts` 1/1；正式 password login、独立进程私有文件写入/读回，匿名 401/403；正式 logout 后新进程读取返回 `auth_required`，退出码 2；使用独立 Xpod 与原生 QLever |
| Cloud + Managed Local 注册 | 双实例 runner 1/1，退出 0；注册后不再提交密码，Local 原生 Pod 创建、consent/token 200，返回原 AI Connections 且精确绑定/实际 profile 读取通过 |
| 后端完整集成 | 最新同意页到期修复后连续两次完整命令退出 0：`integration-final-2-bun1312-retry.log`、`integration-final-3-bun1312.log`；每轮 lite 151 通过、6 跳过，full 45/45，覆盖 Cloud、Cloud B、Local、Standalone；各自容器/卷均清理，原 Gateway 3000 返回 200 |
| 构建与静态检查 | 最新后端 `build:ts`、UI 四入口完整构建（`ui-final-build.log`）、desktop 构建及变更范围 lint/diff 检查通过；UI/后端定向严格类型检查通过，根测试类型问题见下文 |

外部 applet 测试的客户端是通过公开 host/SDK 边界构造的真实协议消费者；预置 Pod binding 与恢复策略属于测试 host。
仓库没有另一份独立生产 applet 客户端，不把此测试扩称为生产 Pod discovery、Bob 对 Alice 私有数据的隔离或全局 SSO 退出。
内置 applet 的 AI Connections/AI Config 入口另由 shared-login 覆盖；跨账号私有数据拒绝由 real-pod 专项提供独立证据。

密码恢复日志为 `.test-data/password-recovery-http.log`，CLI 日志为 `.test-data/cli-password-login.log`；
外部 applet 的全套结果为证据根目录中的 `external-verified.log`，强化断言为 `external-review-assertions.log`。
其余记录也在上述证据根目录。
测试中创建的 Pod 文件、临时 client credentials、独立 CSS 数据和桌面 profile 均在结束时清理。

最终三部署的结构化结果为 `.test-data/login-deployment-results-32744/browser/report.json`
和 `desktop/report.json`，分别 6 项（43.2 秒）、3 项（29.5 秒）。浏览器和桌面共用同一组
隔离 Cloud / Managed Local / Standalone 服务；后者以真实浏览器注册出的账号登录。
桌面结果没有分别记录自动恢复和点击记住入口的分支，不能凭通过结果虚构该分支；
两条分支都须最终真实读取原私有文件且不再提交密码，后续附件已补充恢复分支字段。

收尾完整集成曾有一次 ChatKit 15 秒超时（`integration-completion.log`）；同文件不改门限复验
22/22 通过，最终独占完整命令也已通过。失败日志保留，不把重跑后的结果追写成首次通过。
后续与浏览器并发的 `integration-final-2-bun1312.log` 又出现两个 ChatKit 15 秒超时：
lite 149 通过、2 失败、6 跳过，full 因命令链失败未启动。日志显示多次本地 Pod 请求耗时
约 2–5 秒；没有据此认定为登录或公网 AI 故障，也没有修改超时或添加产品重试。
原门限独立复验 `chatkit-final2-isolated-retry.log` 为 22/22（文件测试 11.37 秒），
随后上述最新源码两次完整回归均通过。这项负载敏感性保留为测试运行风险。
标准 lite/full 使用测试 QLever 替身，CLI 在该轮继承测试 runtime command；安装版原生 QLever
的 CLI、浏览器与 Pod 证据分别记录，不能混称。

两次完整回归各有 6 个配置跳过：NativeRdfProductHttp 3 项、localQleverCredentialRepository 1 项、
MatrixCloudLocalSeed 1 项、ChatPodE2E 1 项。跳过不计为通过，原生 Pod、浏览器与三模式矩阵
通过独立命令验收。源码与隔离实例通过不代表已更新公共 Cloud；当前 Gateway 的原进程和全局 Bun 均未替换。

当前实例：`http://127.0.0.1:3000/`，Managed Local；CSS 与 API 状态 running，
issuer 为 `https://id.undefineds.co/`。规范节点域名的直接 TLS 请求出现连接重置；
本机最优路径与公网可达性需分别报告。

真实当前实例的开发 UI（5173 → Gateway 3000）与生产 UI（3000）均完成密码登录、
PKCE/code 回调、精确 WebID/storage 选择、刷新恢复和产品退出。开发 UI 使用已认证 SDK
向当前 Pod 创建文件（201）、读回核对（200）并删除（205）；请求走本机 Gateway，保留规范 Pod URL。

两种 UI 均另外用当前 Cloud Account 创建临时 CSS client credentials，访问当前 Gateway
`/v1/models` 得到 200；同 ID 错误 secret 返回 401；撤销凭据后原凭据返回 401。
模型列表为空，证据仅说明 Gateway 客户端认证和 models 入口可用，没有执行 Chat 请求。

当前浏览器跨站条件下，产品退出清除了 WebID/Pod，CSS controls 确认当前请求为匿名；
Cloud 顶层 SSO cookie 仍存在，因此不能把产品退出表述为退出整个 IdP SSO。

真实开发 UI 与生产 UI 均完成无请求拦截的切换验收：产品发出标准 `prompt=login`，Cloud 展示换账号入口，
点击后实际 CSS logout 200，邮箱和密码可编辑；证据 `live-switch-dev.json`、`live-switch-production.json`。

根目录 `typecheck:test` 仍存在独立工具链问题：TypeScript 5.5 无法解析当前 Vite 插件的
`"module.exports"` 声明。使用工作区已有 TypeScript 5.9 诊断时，还暴露根测试配置的
DOM/Buffer 与 UI 环境类型问题；未据此升级依赖或扩大修改范围，各模块原生构建和定向类型检查分别执行。
