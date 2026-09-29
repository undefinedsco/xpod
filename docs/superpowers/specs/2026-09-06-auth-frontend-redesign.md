# 登录前端整体审查与重设计

状态：2026-09-06 审查与实施记录；规范部分于 2026-09-27 对齐。9 月 6 日记录的 Web Account 布局、注册修复及回归只代表当时工作区，不能据此推断当前版本或发布状态。

历史审查基线：`codex/account-provisioning-latest`，HEAD
`b25d0eeef9f4755c04bd07887f707086beb733b1`，包含当时工作树未提交的 Web Account UI 与 provisioning 修复。
本文不是该 HEAD 已包含全部修复的声明。

本次只修正文档：§2、§8 保留历史证据，未重新检查代码或执行其测试。现行登录、身份、产品退出协调与显式 Pod 创建以 [9 月 19 日 canonical](2026-09-19-xpod-login-and-host-design.md) 为准；跨模块展示、等待反馈与任务续接按 [产品体验 spec §4–§6](2026-09-27-xpod-product-experience-spec.md)。以下保留 9 月 6 日用户确认的短流程小窗与完整 Account 文档分工，不以新品牌改变其适用范围。

## 1. 结论与范围

反复出现的登录卡片拉伸、嵌套、遮挡，不是再调整一个 padding 能解决的问题。
9 月 6 日审查记录的根因是 **Account 业务、WebID 业务、展示容器和宿主窗口有多个决策者**；当时实现及初稿错误地把 WebID 小窗规范套到了 Xpod 自己的 Account Web 页面。
当时还记录了注册与授权流程中需要单独修复的状态错误；这些是下文历史证据，不是本次重新检查实现后的结论。

用户于 2026-09-06 明确：旧的小窗规范指 WebID 登录部分，不包括 Xpod 自己的 Web 页面。旧文档的宽泛措辞不能作为扩大适用范围的依据；本次规范校正继续保留这一原产品要求。

后续实施依照下述已校正规范及领域 canonical 推进，按目标版本重新收集验收证据。§8 的历史 RC 状态不构成本轮发布指令；不要以整体重设计为由重置其他人的工作树修改。

继续沿用 [认证边界规范](2026-08-30-xpod-auth-authority-boundaries.md) 的 authority 决策：

- CSS 独占 Account session；Account 页面消费 CSS 原生 controls。
- Inrupt 独占 WebID session；SDK 只补充发现、路由优化和事务关联。
- 不新增组合会话、万能 `XpodAuthProvider`、Account-to-WebID token 转换。
- 产品级退出可复用 9 月 19 日 canonical 第一部分 §3.4 已定义的协调器，依次调用两方原生退出；协调动作不创造组合 session，不改变两方 authority。
- shared-ui 的登录业务只负责 WebID 登录；Xpod 的注册、Account 登录、找回密码、CSS 授权和 Pod 管理/创建页面属于 Xpod。
- 基础 Button/Input、无业务的视觉 primitive 可以共享；“不使用 shared-ui Account 业务”不等于复制一套基础组件。

本文澄清旧规范 §7 与 §11 展示规则的适用范围：WebID 登录沿用原小窗要求，Xpod Account Web 页面不在其范围内；**不改变原会话隔离和协议要求**。

## 2. 审查时发现（修复前快照）

下表行号与问题描述记录 2026-09-06 修复前证据，不代表当前实现仍保留这些缺口；当时落地记录见 §8。表中旧创建流程的安全结论继续适用，但注册自动准备/创建的编排已由 9 月 19 日 canonical 替代，不能按历史证据重新实施。

### 当时发布前必须处理

| 优先级 | 问题与证据 | 后果 / 目标 |
| --- | --- | --- |
| P1 | `ui/src/utils/registration-flow.ts:160-189`：Pod/WebID 查询非成功返回 `false`，部分无效 JSON 也归为空结果；`:385-398` 据此创建 Pod | 查询未知不能等于明确不存在。失败停止在查询阶段，重试只能重查，不得隐式创建。 |
| P1 | `registration-flow.ts:298-363`：ready 等待会返回 `false`；`:385-387`、`:412-414` 忽略结果并返回 `createdPod: true` | 创建成功不代表绑定可用。超时保留“已创建，尚未确认可用”，不得重建或宣告全部完成。 |
| P1 | `ui/src/pages/ConsentPage.tsx:373-405`：切换 WebID 后 follow-up fetch 不检查结果，随后提交 consent | 客户端缺少失败闭合。需核对 CSS pick control 的真实提交语义，并以真实双 WebID 用例证明最终身份一致；目前只能确认客户端缺口，不能声称已复现错身份签发。 |
| P1 | 实现把 WebID 登录的小窗规则套用到了 Xpod Account Web；本轮初稿也误将其解释为旧规范的全局要求 | 恢复原适用范围：WebID 登录沿用小窗，Xpod Account Web 保持自有页面布局。 |
| P2 | `XpodAuthSurface.tsx`、`xpod-auth-surface-host.ts:16-23`、`WebAccountLayout.tsx:30-33` 都参与窗口模式切换 | mount/cleanup 能互相覆盖；窗口由宿主路由层唯一管理，布局本身无 IPC 副作用。 |
| P2 | `ConsentPage.tsx:133-139`、`FirstPodPage.tsx:62-65` 根据宿主选择不同业务视图，shared views 又自带卡片/滚动 | 同一业务两套内容实现，造成文案、状态和布局漂移。保留一个 Xpod Account body，只换外层容器。 |
| P2 | `WelcomePage.tsx:290` 的 `toggleMode` 只变内部状态，不变路由；路由又用 `initialIsRegister` 初始化 | URL、返回/刷新和当前表单可能不一致。登录/注册使用实际路由导航，保留合法事务上下文。 |
| P2 | `XpodAccountViews.tsx:214-220` 把 confirmation 非 undefined 当成已交互，初值为空字符串 | 用户刚输入密码就出现确认密码错误。按 touched/blur/submit 显示校验，不在首次输入时误报。 |
| P2 | `App.tsx:17-21` 初始化错误替代所有 Account routes；`ErrorScreen.tsx` 只有英文技术错误和 reload | 无法区分服务不可用、未登录、创建失败、绑定未知。保留页面意图和步骤，明确错误来源及恢复动作。 |

### 不应误判为违规的情况

- 单独 Account logout 后仍保有 Inrupt session，是会话隔离允许的状态，不据此判定认证错误。当前产品级“退出 Xpod”可按 9 月 19 日 canonical 第一部分 §3.4 协调两层原生退出；不沿用本稿旧版禁止 coordinator 的结论。
- 当时的 `XpodUserCard.tsx:117-136` 与 `WebIdAuthBoundary.tsx:81-84` 操作不同 authority；文案必须区分单层退出与产品级退出。协调退出的进度、部分失败及重试使用 canonical 已定义的行为，不合并状态权威。
- 当时 `ErrorScreen` 曾实际显示 Account controls HTTP 500；截图测试里的注册表单通过不能证明该真实入口可用。
- 开发服务器对 HTML 导航与 JSON controls 分别路由是正常机制，仅凭二者不同不能判定代理设计有 bug。

## 3. 目标组件边界

| 所属层 | 唯一职责 | 明确不负责 |
| --- | --- | --- |
| CSS Account 服务及现有 Account adapter | Account session、controls、Account 业务请求 | Inrupt 恢复、Pod authenticated fetch、窗口大小 |
| Xpod Account 页面/controller | 登录、注册、找回/重设、CSS consent、Pod 管理的显式创建表单和业务步骤 | WebID token 刷新、通用供应商选择、SDK 会话重实现；注册或 consent 隐式创建 Pod |
| Xpod Web Account layout | Web 文档的左说明 / 右表单，以及窄屏布局 | IPC、认证判定、创建 Pod、请求重试 |
| Xpod App 宿主 | 路由对应的窗口几何、焦点、返回工作区 | 用组件挂载推断登录完成，合并 Account/WebID session |
| shared-ui WebID 视图 | WebID 登录入口、恢复/跳转/回调等待、协议错误展示 | Xpod 注册、Account 密码表单、CSS 服务端授权业务 |
| solid-sdk / Inrupt adapter | WebID 事务、Inrupt Session、规范 Pod 发现与访问优化 | JSX、窗口控制、CSS Account readiness 门禁 |

这不是要新增上述每一层的抽象。优先把现有文件归位、删除重复 wrapper；只有现有 owner 缺失时才补最小实现。

### 现有组件处置

- `XpodAccountViews`：保留 Xpod Account 表单；收敛为无外框 body，不让业务调用者选择 `frame/showHeader/presentation` 的任意组合。
- `WebAccountViews`：与 Account 自有视图收口；授权和 Pod 管理/创建的同一份内容供不同宿主使用，不再保留按宿主切换的 shared 业务副本。
- `WebAccountLayout`：Web 文档唯一外框；删除其 `setWindowMode` effect。
- `XpodAccountPageSurface`：在路由适配边界选择已确定的容器；不得因为窗口较窄就换业务组件。
- `XpodAuthSurface`：用于 App 认证小窗和 WebID 入口；不把 CSS Account Web 文档强制映射成 compact。
- `AccountAuthBoundary` 与 `WebIdAuthBoundary`：保留独立 authority；只显示各自真正缺失的状态。
- shared-ui `OidcConsentView`：Xpod 不再使用它实现 CSS Account consent；兼容导出是否删除需先核对其他消费者。
- shared-ui `StorageBootstrapView`：可以服务于通用 WebID 资源发现，但不能调用或决定 Xpod Account 的 Pod 创建业务。
- shared-ui `LoginModal/LoginView/LoginCardShell`：存在 LinX/extension 消费面，不在本次 Xpod 清理中直接破坏导出；Xpod 禁止回流使用，跨仓迁出单独记录。
- 不删除 CSS 原有 controls，也不把服务器端初始化/等位替换组件与 UI 清理混为一谈。

## 4. 固定展示契约

### A. 直接访问 Xpod Web Account

- 宽屏左边产品说明、右边最大 448px 的表单区；窄于该宽度时随容器收缩，不铺满宽屏输入框。
- 窄屏单列，同一表单；顶部简洁品牌，不重复标题和卡片。
- 直接访问的登录、注册、找回、重设、完整授权，以及独立 Account 场景中的 Pod 管理共用这一文档容器。工作区内 /settings/pod 由 存储空间 Content 承载同一业务 body，入口场景与刷新规则按主 spec §5.1；不得嵌套两种外框。
- 文档允许纵向滚动；表单不再套 Card/ScrollArea；不得因为固定高度遮住提交、错误或返回链接。
- Loading/错误保留同一个右侧面板宽度与上下文；不强制所有页面同一高度，也不把短等待页拉成长空白。

### B. Xpod App 的认证小窗

- 当前主题画布铺满小窗，使用公共语义 token；浅色映射到选定纸色，跟随主题行为保留，不硬编码白底或叠加灰色遮罩与另一张卡片。
- 简短 Account 登录或 WebID 登录/等待/回调沿用 280×400 compact 基线。
- 注册、完整授权和独立 Account 场景的 Pod 管理/创建属于 Account 文档流程，**不塞进 280×400**。从 App 短认证进入时由宿主提升为完整 Account 文档窗口；工作区内的 Pod 管理仍由 存储空间 Content 承载。不要由注册表单自己调用 workspace IPC。
- 浏览器内 App 入口可使用受限认证对话框；宿主已有小窗时使用其内容视口。不能把普通全屏浏览器当作“已有小窗”。
- 小窗与普通页面是显式入口语义，不由 localhost、视口宽度或登录状态猜测。
- 长错误、字体放大、软键盘场景允许必要滚动；“正常短表单无多余滚动”不能演变为强制裁剪。

### C. 一份内容，一个外框，一个窗口 owner

Account form 不渲染外框；layout 不操作宿主；页面不传随意尺寸；宿主按路由场景切换一次窗口模式。
无须新增部署环境变量。保留现有宿主 bridge 和路由作为输入。

### D. 页面内容与主动作

| 页面 | 正文只保留 | 主动作 / 次动作 |
| --- | --- | --- |
| Account 登录 | 邮箱、密码；明确正在登录的 Xpod 账号服务 | 登录 / 创建账号、忘记密码 |
| 注册 | Account 实际要求的名称（若有）、邮箱、密码、确认密码；名称说明仅限账号用途，Pod 名称不属于注册字段 | 创建账号 / 返回登录；不再嵌初始化或 Pod 创建卡片 |
| 找回密码 | 邮箱、提交后的中性反馈，不暴露账号是否存在 | 发送重置链接 / 返回登录 |
| 重设密码 | 新密码、确认密码；链接过期有独立状态 | 保存新密码 / 重新申请链接 |
| CSS 授权 | 应用名称、选择的 WebID 与目标存储摘要、记住授权选项 | 批准 / 拒绝；唯一合法绑定无下拉选择 |
| Pod 管理/创建 | 已绑定 Pod；无 Pod 空态；明确选择的 Cloud 或有管理权机器、条件检查和 Pod 名称（若需） | 用户确认后开始创建；进行中/结果不明时查询原任务与绑定，不另建任务 |
| 恢复/回调 | 单个进度标题、简短说明 | 正常不重复显示登录按钮；等待反馈遵循主 spec，只有真实失败才提供对应阶段恢复 |
| 失败 | 一处标题和解释，默认收起技术详情 | 对应步骤重试 / 安全返回，不默认清会话 |

Web 产品说明与功能表单的语言保持一致；复用现有国际化输入，不用混杂中英文临时硬编码。
不得为了减少表单行数擅自删除 Account 真正要求的注册字段；也不得把旧创建流程依赖的 Pod 名称留作注册前置条件。原任务明确选择并经验证的目标可续接展示，由用户确认创建；没有明确目标时必须选择，不能根据账号、localhost、唯一机器或默认部署猜测创建位置。

## 5. 状态与恢复设计

Account session、WebID session、Pod 可用性各自保留状态，以下是业务流程，不是新的全局 auth state。

### 注册与显式 Pod 创建

| 当前阶段 | 成功后 | 失败后的唯一恢复动作 |
| --- | --- | --- |
| 读取 CSS controls | 显示可用注册方式 | 原步骤重试 controls；不要显示密码错误 |
| 注册 Account / 密码 | Account 注册完成，进入账号管理或经验证的原授权事务；不 prepare、不创建 Pod | 明确 Account 成功与失败；不让 Pod 可用性成为注册成功前提 |
| 原授权任务确认无可用绑定 | 显示“前往 Pod 管理”与“取消授权”；由用户前往 `/settings/pod` | 清单读取失败或已有 Pod 不可达时提供相应恢复，不能当作无 Pod |
| 进入 Pod 管理 | 展示列表/空态，选择 Cloud 或有管理权的机器；校验目标条件，需要启动时由用户明确操作 | 读取或条件检查失败停留原步骤；进入页面或刷新不创建 |
| 确认创建 | 用户确认选定目标及所需名称后，提交被守卫的创建事务 | 结果不确定先查询原任务与权威 Pod 清单；不得自动另建任务 |
| 确认目标 binding 可用 | 重查精确 WebID × storage 及服务健康；有效 OIDC 事务回授权再续接原任务，否则留在 Pod 管理 | 等待/失败保留已完成的创建事实，恢复只重查原事务与绑定，不重新注册/创建 |

`absent`、`unknown/error`、`created but awaiting readiness` 不得压成一个 boolean。
创建/绑定已确认与 Pod 已就绪分别表达。Ready 须符合 9/19 的精确 WebID × storage 配对、会话一致及实际鉴权读写证据；不能拿账户中任意另一个 Pod 作为完成证据，也不能将 WebID 资源验证变为 Account 注册成功前提。
不把 provision code 放进日志、截图或错误细节。

续接状态必须有时限，并绑定当前 Account、原 interaction 与已验证返回目标。切号、事务到期或目标不匹配时不复用旧续接；返回后重新验证，不凭跳转视为授权已完成。取消等待不撤销已经提交的创建，取消授权按协议认可的返回路径结束授权；不得声称同时删除或回滚 Pod。

### WebID 登录与授权

1. App 需要 WebID 能力时，先使用 Inrupt 已有有效会话；恢复中只显示等待，不先闪登录。
2. 确需认证时发起 Inrupt OIDC；CSS 决定是否需要 Account 登录。
3. CSS Account 已登录时直接继续事务；不由 App 再询问一遍邮箱密码。
4. 授权页显示应用、身份及确有必要的存储选择。唯一绑定显示摘要而不是空下拉框；多个合法绑定才要求选择。
   无可用绑定时只提供前往 Pod 管理与取消；授权页不嵌创建表单，不自动准备或创建。
5. 切换 WebID 失败、目标绑定未知或事务失效时不允许提交同意。先按 CSS 原生 control 完成并验证选择，避免重复实现服务端授权逻辑。
6. 回调由 Inrupt 完成；Pod 暂时不可读只影响资源状态，不清 Account 或有效 Inrupt session。
7. 返回发起页面，不无条件跳 Dashboard。路由变更保留且校验 returnTo/事务，不接受任意外部跳转。

### Cloud / Local / Standalone

- Cloud：使用 Cloud controls 和规范身份/存储地址，不盲查 Local Gateway `/provision/status`。
- Local + Cloud：在 Pod 管理中明确选择有管理权的机器；合法的原任务目标可续接，但不能由 provisioning 上下文自动触发创建。绑定写入成功后通过持久化事实发现，不让每次登录重走初始化。
- Standalone：使用该部署的 CSS controls 和配置规范地址，不强制 Cloud provisioning。
- 有本机上下文但读取失败是 unknown，不退化成无上下文 Cloud 创建。
- 网络最优路径是传输选择，不能把 canonical WebID/storage 改成当前 dev-server 或 loopback 地址。

### 操作文字与失败隔离

- 单层退出用“退出管理账号”“断开 WebID 会话”，只影响对应 authority。产品级切换账号按 9/19 X-1 先隔离/清理旧 WebID 和 Pod，不能把它当成保留旧绑定的单层退出。产品级退出明确协调两层的范围，不混同停止服务。
- 产品级退出复用 9 月 19 日 canonical 第一部分 §3.4 已定义的 coordinator，保留 `idle/running/error` 与当前步骤；某层失败只重试失败层，已完成层不重复执行。两层都确认后才显示完成；不得把协调结果转成新的组合 session。canonical 登记的切换账号/失败退出并发缺口须按对应交互规范收口，不能由本模块另造规则。
- 只显示一处主要错误；技术细节默认收起，包含安全的阶段/状态码，不暴露凭据。
- “账号服务暂时不可用”“存储状态无法确认”“授权已失效”必须区分；不能统称密码错误或要求重登录。
- loading 有可访问状态提示；短暂恢复不闪登录，持续等待按主 spec §4–§6 的显示阈值渐进反馈与提供安全出口。显示计时不改变 Account/WebID/Pod 状态，不制造认证超时、不自动清会话或重新提交。提交防重复；离开页面取消可取消的读取或忽略过时响应，不声称撤销已提交事务。
- 确认密码在该字段失焦或提交后才显示 mismatch；错误关联字段，首个错误可聚焦。

## 6. 实施顺序与清理计划

1. **先锁行为**：注册成功零 Pod 且 prepare/create 调用为零；授权及页面进入不自动创建；清单非 2xx/无效数据、等待过久、结果不明重试不得另建任务；consent 切换失败不得 consent；登录/注册返回刷新与延迟校验。
2. **修业务状态缺口**：保持 CSS controls 接口，查清 pick control 实际语义；补 exact binding readiness，不新增认证器。
3. **收口容器**：Account body 唯一实现，Web 外框唯一，宿主窗口切换唯一；移除 Xpod Account 对 shared 业务视图的运行时依赖。
4. **收紧 API 自由度**：删除 Xpod 调用面不需要的 frame/host/style props，补 lint/静态守卫辅助防回流；不以字符串守卫替代行为测试。
5. **实现后的 Web 验收**：验证 controls、注册零 Pod、显式选择与创建、授权续接、回调及 exact binding。测试与文档审查分开记录，不以这份设计稿宣称运行通过。
6. **桌面验收**：同一代码验证窗口切换、短/长流程、返回工作区和 rail；构建不等于桌面验收。
7. **新 RC**：最终源码与镜像 digest 绑定，同一镜像跑 Cloud/Local/Standalone；不能复用修改前或 mock 的结论。

每一步保持可审查 diff，先删重复实现，不引入新依赖或通用状态库。
Account/WebID authority、shared SDK 消费者兼容性、canonical URL 是回归红线。

## 7. 验收门禁

### UI 与交互（可用夹具，但标注 fixture）

- 1440、768、390 宽 Web：左/右与单列正确，输入框宽度有上限，无横向溢出。
- App 280×400 短流程；完整 Account 文档窗口；缩小/200% 字体/长错误时按钮和返回入口仍可访问。
- 登录、注册、找回、重设、授权、初始化、恢复、失败全部截图，不只拍 happy path。
- 不嵌套卡片/滚动；Tab 顺序、Enter、防双击、焦点恢复、前进后退/刷新均有行为断言。
- 任意状态切换不由多个组件交替触发 auth/workspace。

### 真实服务（不得用 UI mock 代替）

- 明确前端 worktree/SHA、实际后端路径/版本、模式、issuer 与 canonical SP，不能混用另一个桌面包却报告当前分支通过。
- 注册实际账号且不创建 Pod；进入 Pod 管理、明确选择并确认创建后才产生绑定；绑定持久化后再次登录不重新初始化。
- 覆盖原任务续接、取消授权、创建结果不明、读取失败、过期及切号；失败和页面刷新不自动重建。
- 双 WebID/多绑定授权与失败用例：最终 Inrupt WebID 等于用户选中身份，目标存储不串用。
- Account-only Status数据；Inrupt-only AI Connections；导航来回切换不登出；一方失败不清另一方会话。
- Pod API Key 写入与重读、Gateway 客户端认证、models、真实 Chat 分项记录。写入地址须是 canonical SP 下的资源，实际连接路径单独记录。
- Cloud/Local/Standalone 同 digest 的各项通过才允许声明完整后端验收。

## 8. 历史证据与当时未完成项

本节原样保留 2026-09-06 的实施事实与测试数字；“注册复用 prepare”“FirstPod”等是当时编排，不再作为现行创建入口要求。现行流程见 §5 和 9 月 19 日 canonical；本节成功、失败、尚未部署与待验收均限于记录时点，不代表当前发布状态，2026-09-27 未重跑这些验证。

### 2026-09-06 真实注册追加发现与落地

真实 Gateway 的本机准备已返回 201，Cloud 原生 Pod 创建/关联返回 200；原生 WebID 和 Pod 列表均包含 Cloud 分配的 `*.nodes.undefineds.co` 规范地址，但 Account bindings 返回空数组，前端等待超时。因此不得把本次接口创建成功报告为整条注册验收通过。

以下修复已落地，并增加失败闭合与恢复行为测试；没有新增环境变量或认证能力：

1. 注册复用已有 `prepareProvisionedPod`，取得 receipt 后再提交 CSS；手动添加 Pod 同样复用。
2. 身份归属来自已认证 Account controls，不假设 WebID 与 IdP 同域。目标匹配使用 canonical SP/storage，短期 code 过期只能保留目标元数据，不能用于授权。
3. `AccountStorageBindingsHandler` 的 Cloud/server 路径返回该 Account 在 PodStore 中持有的远端规范绑定；使用已有 edition 区分 Local 的本机范围过滤，不新增部署配置。保留账号隔离及 URL 安全检查。
4. FirstPod 成功读取空 bindings 时仍读取原生 WebID candidates，再向明确的目标 SP 查询；任何读取失败均不创建。
5. 使用同一真实测试账号重新走恢复流程，已进入 `/.account/account/` Dashboard；恢复过程中没有再次 POST 创建 Pod。实际 Gateway 是另一桌面 runtime，不能据此宣称当前分支三模式 RC 通过。
6. FirstPod 先读持久化 exact binding：过期 nodeA code 对应 durable nodeA 时直接就绪，不 lookup/create；对应 nodeB 时不误判就绪。过期 code 仅作非授权目标元数据。
7. 宿主初始化 `/provision/status` 的 500、网络失败、无效 JSON 或无效 managed issuer 进入可重试错误，不能把账号表单切到另一个 authority。明确 404 / managed:false 仍支持 Standalone；非 loopback Cloud 不做该探测。

- Account Web 已使用唯一 Xpod 自有文档外框与视图；布局不操作窗口 IPC；App 路由管理完整 Account 文档窗口。shared-ui WebID 视图未被改造成 Account 注册业务。
- 登录/注册使用实际路由；确认密码延迟校验；Consent 选择失败不提交授权；readiness 重试只查询、不重复创建或登录。
- 当前完整集成基线：lite 149 pass/6 skip，full 45 pass；属于隔离集成栈，不替代同 SHA 三模式真实验收。最终验证数字在配套 [验收记录](../plans/2026-09-05-web-account-rc.md) 更新。
- 真实规范 Pod：`https://e333626390203a88630a8cc987268072.nodes.undefineds.co/acceptance-auth-1788631726638/`；WebID 是该 Pod 下 `profile/card#me`，不是 loopback。证据保存在忽略目录 `.test-data/auth-redesign-live/after-scope-result.json` 与 `after-scope-fix.png`，不含密码或 token。
- 真实创建与恢复是分阶段验证，不是新账号一次不中断注册通过。新的 Cloud/server bindings 修复尚未部署线上；真实恢复同时验证了对旧服务 bindings 空列表的兼容查询路径。
- 尚未完成：新 RC 同 SHA/digest 的 Cloud/Local/Standalone、双 WebID 最终签发身份、真实桌面窗口/rail、API Key Pod 写读/Gateway 认证/models/Chat 分项端到端。不得用布局夹具或旧 runtime 替代这些证据。
- 原左侧英文介绍已保留，表单中文的语言统一仍是待处理产品文案项，不声称本轮完成全部国际化。
- 此记录形成于新 RC 启动前；提交及候选状态以对应 Git/workflow 证据为准。本轮不移动 npm stable/latest、不操作生产。
