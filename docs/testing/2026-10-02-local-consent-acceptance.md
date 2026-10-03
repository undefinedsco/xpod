# Local 与 Consent 验收记录（2026-10-02）

> **最新架构纠正（2026-10-03，优先于下方历史通过结论）**：Cloud 与 managed Local 的独立 `profile/card` 始终在 Cloud，用于身份与 Pod 发现；实际用户数据存放在所选 Cloud/Local Pod。Local 公网数据入口不影响 Cloud card 的可读性。当前代码及部分 fixture 将身份派生到 Local Pod，仍待修复；这些测试的请求事实和退出码保留，但不证明正确 Cloud-card 拓扑已经通过。Draft PR #29 暂缓，前轮上线确认作废。
> 目标依据见 [架构 V2](../architecture-v2.md)、[共享登录 spec §13.14](../superpowers/specs/2026-09-29-shared-ui-pod-sign-in-design.md) 与 [锁边界](../locking-strategy.md)。本次是文档修正，未声称产品或现网已修复。

## 浏览器连接入口与订阅错误跟进（2026-10-03）

用户报告“浏览器打开，但落地页不对，没有授权”。代码与实际能力审计确认两处问题：API Key 控制台和 OAuth 共用“浏览器登录”名称；控制台发起时丢失 Offering，服务端统一选择 API 平台目标。现在真正 OAuth 保留“浏览器登录”，API Key 操作改为“打开控制台”；多个控制台先选 Offering，明确创建 Key 后返回填写。服务端从可信共享目录按 Offering 解析地址；Kimi Code 改为 `/code/console`，并防止旧 discovery `/code` 覆盖此内容。没有添加厂商身份 UI 分支或新依赖。

订阅错误解析另补嵌套 `error.code` 和 `invalid_token`：失效码可触发现有重新授权提示，未知或敏感错误仍归安全通用码，不透传原始描述。这是有红绿回归的解析缺口修正，不能据此认定是用户实际刷新失败的唯一根因。

- UI 全包 27 文件 / 425 项、服务端专项 4 文件 / 177 项均通过，实际子进程 exit 0；服务/包/UI 构建、UI lint 和冻结后的测试类型检查通过。冻结源码 1104 文件无漂移。
- 首轮完整集成正常 exit 0（北京时间 03:49:35–03:57:33）；由于期间仍修正目录优先级，另运行冻结后的最终完整门禁，03:57:45–04:08:00 正常 exit 0：运行时 30/30、Lite 157 通过 / 6 原条件跳过、Full 46/46。冻结后的测试类型检查及 diff 检查通过；源码 1104 文件再次校验无漂移。
- 修复候选已更新 `/Applications/Xpod.app`，使用原有 userData。签名严格核验通过；asar SHA-256 `902323e3b16926b4ae169e7ce9555c931a8cc2cd55dff8cc3f4cd6824d9e3e51`，runtime SHA-256 `208061c6cfa1fc51320b6473de850f25e338a1c9bf74e3804674408e2e6c2ea6`。旧包备份在私有 `replaced-before-browser-fix/Xpod.app`。
- 新安装包冷启动实际恢复 authenticated session；本机 `/api/ai/gateway/keys` 仍返回 `403 service_access_missing`。Cloud Account GET 200 仍只有 `controls.account.create`，携带 DPoP 也未返回 `clientCredentials`；没有凭据创建 POST。本机 Account 使用同一 DPoP 则返回 `bindings/clientCredentials/logout/pod/webId`，两处 authority 行为不同。托管 Local 的 token issuer 仍为中央，不能拿本机 Account 控件冒充中央凭据。此处是当前中央权限引导失败，不能将 Account HTTP 200 当作服务凭据恢复。
- 更新前实测 OpenAI 已到默认 Chrome 的账户选择页“继续前往 Codex”；没有代用户完成授权。更新后的实际 UI 点击受 Mac 锁屏阻挡，控制台落地与授权回调继续待验；订阅刷新、凭据保存和真实 Chat 未声称通过。
- 中央只读诊断 workflow `37058178929` 成功完成，fresh 日志覆盖 UTC 19:57:44–19:59:30：8 次 DPoP token 验证错误，均为 `BunFetchSocketClosed`，0 次验证成功；与本次网络记录的 8 次中央 DPoP Account 请求对应。这是服务器出站验证阶段的网络失败，尚不能确定具体是 WebID、OIDC discovery 还是 JWKS 请求，也不支持“缺 Account token / client allowlist / WebID 链接”的结论。未部署或修改生产环境。

本轮源码涉及 `packages/ai-connections` 的入口文案、凭据操作与对话框，服务端 `connect/index.ts`、`container/common.ts`、`ProviderRegistry.ts`，及对应回归。私有安全探针只记录状态/控件键名/认证方式布尔值，不读取成功签发凭据的响应体。日志、冻结清单与 fresh 网络证据在 `.test-data/subscription-refresh-followup/`，真实退出码在 `release-unified-results.jsonl`。未提交、未发布；历史结论以下保留。

调试捕获已正常结束（exit 0），随后恢复普通启动的 Xpod，本机 Gateway 3000 正常监听。最终页面交互仍受锁屏阻挡；中央 fetch 目标需要同 runtime 的只读网络探测，既有诊断 workflow 只能获取 Kubernetes 状态与日志，不能据此声称已修复该网络故障。

最新状态：当前源码三部署追加会话复用矩阵 browser 30/30、Electron 9/9；独立 Local 的实际桌面短期令牌专项 2/2。最终完整集成正常 exit 0：运行时 30/30、Lite 157 通过 / 6 原条件跳过、Full 46/46。测试类型检查、UI lint 与 diff 检查通过。本轮只补充测试与文档；之前 logo + info、登录版式及实际安装的证据分别保留在下方，历史失败不删除。未提交、未发布，不扩大为用户生产公网或 AI Chat 全面验收。

## 三部署与会话复用追加验收（2026-10-03）

用户要求核对几种部署及会话复用。本轮沿用当前产品实现，只扩充实际浏览器、Electron 与令牌生命周期测试；没有新增依赖、重新打包或改动已安装用户资料。

| 拓扑 | 注册 / Consent / 私有 Pod | 浏览器会话复用 | 桌面托盘 / 完全退出恢复 / 退出隔离 |
| --- | --- | --- | --- |
| Cloud | 通过 | 完整 IdP 会话及仅 Account cookie 均通过 | 通过，自动冷启动恢复 |
| 托管 Local，中央 Cloud issuer（历史错误 profile 拓扑） | 历史行为通过，Cloud-card 架构待复验 | 两类历史行为通过；当时身份位于节点 Pod，违反 Cloud-card 设计 | 历史行为通过，Cloud-card 架构待复验 |
| 独立 Local，自身 issuer | 通过 | 两类均通过 | 通过，自动冷启动恢复 |

- 更新后的矩阵 browser **30/30**、Electron **9/9**，零跳过、零 flaky，runner 正常 exit 0。北京时间 03:11:23–03:14:05；证据 `.test-data/login-deployment-results-15237/{browser,desktop}/report.json` 与 `.test-data/login-card-comfort/deployment-session-reuse-matrix.log`。三个真实 Gateway、Cloud PostgreSQL / 对象存储 / Redis、Local 原生 QLever 及浏览器新建的同一批账号用于后续桌面测试，没有 mock 授权或开放私有 Pod。
- 浏览器新增 6 条：每部署完整 IdP 会话及仅 Account cookie 各 1 条。恢复密码 POST 增量均为 0；完整会话 WebID 选择增量 0，仅 Account cookie 增量 1。每条同时校验新 state、正确 issuer / WebID、交换授权码后私有 Pod 内容、显式 Consent，以及新上下文要求密码且拒绝私有访问。
- 外部 native 客户端按服务器规则仍要求再次 Consent，恢复与显式 Consent 各提交 1 次；不能把账号复用等同于所有客户端免授权。实际 Xpod 桌面则明确记住首次授权，三部署均只有首次密码 POST 1 次，托盘及冷启动密码增量 0、Consent 增量 0，冷启动后实际私有读取 200 且内容正确。关闭到托盘保留同一 renderer 和 document；完整退出确认正常 exit 0 后重新启动。现有测试保留有效的一次点击记住账号恢复分支，本次三模式实际均走自动恢复。
- 桌面矩阵另含每部署离线退出与延迟 provider 数据，共 6 条，均保持退出后的身份边界。AI Gateway 的首次 `service_access_missing` 拒绝后取得会话凭据并重试成功，只证明该分项认证和模型列表读取；没有据此声称上游同步或 Chat 已通过。
- 首轮 browser 24/24 后 Cloud 桌面退出等待超时；诊断确认产品已发送 quit，但 Playwright Node inspector 尚未断开。测试先发真实应用退出，再用 `app.close()` 释放 inspector，并在关闭前保存 ChildProcess 核验 exit 0 / 无 signal。中间专项因关闭后调用已释放的 `app.process()` 失败，修正引用保存顺序后本轮三模式全过；未用强杀冒充正常退出，未改变产品退出行为。

变更范围：`tests/e2e/login-deployment-matrix.spec.ts` 新增协议会话复用；`tests/e2e/desktop-login-lifecycle.spec.ts` 明确记住 Consent、断言恢复零新增授权并修正测试 inspector 清理；`tests/e2e/browser-session-refresh.spec.ts` 将已经退场的重 Web 页面测试迁入实际 Electron。短期令牌专项实际 Electron **2/2**、零跳过、零 flaky，正常 exit 0；测试类型检查和 diff 检查通过。证据 `.test-data/login-lead/desktop-session-renewal-{verified.log,report-verified.json,results-verified/}`。覆盖独立 Local fixture，未将此专项扩大为三种部署或用户原资料均已验证：

- 自动续期：access TTL 30 秒、refresh TTL 180 秒，授权码交换 200 仅 1 次，refresh 200；跨过原始 access 完整寿命后仍为 authenticated，原私有 Pod 返回 200 且内容正确。
- 过期恢复：refresh TTL 5 秒，到期后实际 refresh 返回 400 / `invalid_grant`，桌面出现“登录已过期，需要重新确认”，点击“重新登录”后第二次授权码交换 200，同一私有 Pod 复读 200。两项均先验证实际 PUT 201、owner ACL 与匿名 401/403。
- 迁移首轮选择器只找 `type=email`，但当前共享 EmailInput 为兼容 Chrome 使用 `type=text/name=email`，导致登录未提交；清理中的关闭后 process 引用又遮盖主错误。随后实际过期文案与旧 Web 专属断言不同。统一沿用已有公共邮箱定位及真实桌面过期页操作，并保留原始失败/页面证据，再重跑通过；未修改产品、fixture host 或超时去迁就测试。

最终完整 `bun run test:integration` 正常 exit 0（北京时间 03:15:48–03:26:25）：运行时 30/30、Lite 157 通过 / 6 原条件跳过、Full 46/46。日志 `.test-data/login-card-comfort/deployment-session-integration.log`，真实退出记录 `.test-data/login-lead/release-unified-results.jsonl`；UI lint、最终测试类型检查和 diff 检查均通过。产品尺寸/共享登录源码冻结清单 6 文件无漂移，安装的 asar SHA-256 仍为 `902323e3b16926b4ae169e7ce9555c931a8cc2cd55dff8cc3f4cd6824d9e3e51`，本轮无需重新安装。上述专项没有重新执行上游模型同步或真实 Chat，也没有借隔离实例替代用户原资料的现场验收。

## 登录版式舒适度（2026-10-03）

用户要求放松紧凑比例。本轮复用共享登录外框和控件：桌面认证窗口默认 440×620（最小 320×480）、页面与弹层 body 上限 480px、弹层舒适高度 440px；22px 标题、48px 输入和主操作、24/32px 响应式边距。矮窗口收紧留白，避免记住账号和独立部署入口被操作区裁切。认证、颜色、logo/info 与桌面专属管理边界沿用现有实现，没有增加依赖或第二套组件。

变更文件：`desktop/src/window-mode.ts`；`packages/shared-ui/src/pod-sign-in/{PodSignInFrame,parts,IdpChrome,IdpViews}.tsx`、`packages/shared-ui/src/theme.css`；`ui/src/auth/WebAccountLayout.tsx` 的尺寸注释。对应桌面单元、共享组件、Account 版式、桌面生命周期与 Consent 测试同步尺寸断言；主 spec §4–5 与 §13.11 留档。

- 18 个组件截图覆盖明暗主题、默认/最小窗口、弹层、宽窄页面及登录/注册/记住账号；最终视觉判定 93/100、pass，存于 `.omx/state/login-card-comfort/ralph-progress.json`。
- 共享组件 156/156、桌面尺寸 14/14、Account 页面交互 22/22；测试类型检查、UI lint、三入口 UI 构建、桌面构建和打包均 exit 0。最小窗口新增实际 checkbox 可点击且位于操作区上方的断言，仍保留输入选择、错误恢复和 200% 文字测试。
- 原生 Electron 验证授权失败可信取消返回、关闭到托盘及完全退出后的恢复边界，2/2。首轮误用了已删除 runtime 目录的历史 wrapper，两个夹具启动失败；改用当前打包的真实 QLever 二进制后通过。生产实现没有为此改变。
- `/Applications/Xpod.app` 已更新，保留原用户数据。实际正常启动恢复 `glocal`，AI Connections 完成读取并显示 OpenAI 已连接；未执行上游同步或 Chat，本条不扩大既有 AI 验收结论。
- 安装的 asar SHA-256：`902323e3b16926b4ae169e7ce9555c931a8cc2cd55dff8cc3f4cd6824d9e3e51`；runtime SHA-256：`b24d1223326478bdfc0a56e8b45ba417fe0f1c1f48b9853b57e8f2704d84e79b`。签名严格核验通过，未提交、未发布。

两轮完整 `bun run test:integration` 均正常 exit 0：北京时间 02:39:09–02:48:28、02:49:11–02:55:51；每轮运行时 30/30、Lite 157 通过 / 6 原条件跳过、Full 46/46。两轮期间产品源码与已安装 bundle 无漂移。

截图、交互报告和本轮日志在 `.test-data/login-card-comfort/`；真实子进程退出记录在 `release-unified-results.jsonl`，安装备份及 manifest 在 `.test-data/installed-local-debug/`。剩余边界：本轮没有重新验收上游订阅同步和真实 Chat；此前记录的问题继续按对应条目跟踪。

## 当前安装版恢复登录跟进（2026-10-02 晚间）

用户报告实际桌面停留在“alice / 正在恢复登录”。使用原有用户资料复现：本机 Gateway 正常响应，SDK 请求节点公网域名的 OIDC discovery 后连接关闭，45 秒后仍未退出恢复。当前 Gateway 的预配状态明确声明托管模式、Cloud 账号 issuer；显示 hint 也是 Cloud，但 Inrupt `currentSession` 指向旧 loopback issuer 记录。旧 hint 正确并不能证明实际恢复记录正确。

修正先核对 Gateway 权威与 SDK 当前记录，不匹配时禁止该次静默恢复，保留用户资料；不改写 issuer、不绕过 callback 验证，也不扩大 OIDC 网络路由。SDK 加入 15 秒公开等待截止、底层隔离与 dispose 结算；迟到 ERROR 同样不能覆盖有效登录或退出。

- SDK 8 文件 146/146；登录与授权 UI 31 文件 447/447；完整构建、UI lint、测试类型检查正常 exit 0。
- 扩大 UI 回归最初 6 条失败来自既有展示 metadata GET、部署详情按钮及 SVG 品牌的旧断言；测试按唯一密码 POST 和可访问动作名修正，未放宽认证。
- 修复版已更新 `/Applications/Xpod.app`，继续使用原 Xpod userData；旧安装包保留在私有验收目录。已核对实际运行 Gateway 正在提供修复代码，CSS/API 正常运行。
- 本轮最终完整集成正常 exit 0：运行时 30/30，Lite 157 通过 / 6 原条件跳过，Full 46/46。实际窗口验收受到 Mac 锁屏阻挡，当前不能声称恢复后的用户桌面登录、Pod 读写或 Gateway Chat 已通过。
- 追加当前源码三部署矩阵正常 exit 0：browser 24/24、Electron 9/9，包含冷启动恢复和退出重登。矩阵使用隔离账号与原生 Local QLever；桌面报告显示每种部署 `/v1/models` 两轮均先 403、取得会话凭据后重试 200，因此日志中的 `service_access_missing` 是初次拒绝而非最终失败。模型列表 HTTP 成功仍不证明上游模型同步或 Chat 可用，更不能替代用户原桌面会话的验收。
- 当前源码 Consent 复验 7/7，含桌面可信取消桥。首轮为 6/7：旧测试要求取消 query 长期保留，但边界会一次性消费并清理；修正为验证原生导航确实交付取消意图、持久化取消选择、回到干净原地址，并继续要求零 token POST、零服务端取消 POST、零 Pod-ready。产品代码未为此调整。
- 收尾完整集成再次正常 exit 0（北京时间 21:04:07–21:13:59），同样为运行时 30/30、Lite 157 通过 / 6 跳过、Full 46/46。打包后的产品代码无漂移；四个测试文件的收尾断言更新已单独记录，并通过类型检查。最终现场工具仍报告 Mac 锁定，用户原窗口的结果继续保持待验。

私有证据在 `.test-data/installed-local-debug/`：`restore-network/evidence.json`、`installed-authority-manifest.json`、`restore-sdk-review-{red,green}.log`、`authority-ui-final.log`、`authority-final-typecheck.log`、`authority-final-integration.log`。原始会话、密钥和授权 token 不入文档或版本控制。

## 实际桌面复验：身份恢复与服务授权仍有断层

解除锁屏后，直接检查原 `/Applications/Xpod.app`（0.4.20 / Electron 33.4.11）与原用户资料。多次完整退出再启动可恢复 Cloud issuer 的 Solid session，实际 glocal profile 与本机配置 SPARQL 返回 200；OpenAI 连接及 6 个模型可显示。这只能证明该时刻的身份及配置读取，不能覆盖用户报告的间歇性加载失败，也不是 Pod 写入或 Chat 通过。

实际 Gateway 的 `/api/ai/gateway/keys` 与 `/v1/models` 首次返回 `403 service_access_missing`。前端随后读取 Account controls，但携带 Solid Authorization 的 Cloud Account GET 仍返回匿名结构（`controls.account` 只有 `create`），没有 `clientCredentials`，没有凭据创建 POST，也没有原请求重试。使用同一已登录 session 只读请求本机 Account index，同样仅返回匿名结构。不能把 HTTP 200 或“Pod connected”视为 Account 权限已恢复；当前整体真实验收仍未通过。

独立操作的结果：OpenAI 模型刷新 `502 provider_models_fetch_failed`，随后订阅刷新 `502 oauth_refresh_failed`；额度刷新 HTTP 200，但载荷为 `status: error / metadata.reason: provider_quota_request_failed`。这些操作确实抵达服务端，不能全部归因于最初的 `service_access_missing`。订阅刷新绕过宿主机代理的缺口已修正：Connect adapters 注入共享 transport，保留表单、响应状态和取消语义，避免自动重放 token rotation。更新后的实际安装包仍复现上述失败，因此不能仅凭代理修正声明订阅刷新通过。

2026-10-03 追加只读核验：Gateway 日志确认恢复 session 的 DPoP、glocal WebID 与固定桌面 client ID 验证成功。本机与 Cloud Account index 在禁用缓存、使用唯一 query 的请求中仍只有 `account.create`。实际 Local Components.js 配置解析也确认 Account handler 的 `sessionExtractor` 已连接共享提取器。以上证据排除了“没有本地 session”、请求缓存和参数遗漏。构建中另发现 Xpod 与 CSS 分别内嵌日志工厂；共享工厂修复已用真实 bundle 夹具先失败再通过，完整测试类型检查通过。更新实际安装后可见 Account 拒绝原因 `webid_missing`，CSS 具体原因归类为 `HttpUriVerificationError`：本地 Account 请求地址被 Gateway 规范化为节点地址，却缺少可信原始地址供 DPoP 验证。已按原有签名传输机制补齐；Gateway 自行推导并签名可信原始 loopback URL，剥离外部伪造路由头，未放宽用户身份与 proof 验证。专项真实 DPoP/Unix socket 回归 3 文件 40 项、服务与测试类型检查通过；包含直接 Account、开发代理、伪造本地地址及远程 ingress 拒绝。Cloud Account 匿名响应保持独立待查。

本轮专项回归 6 文件 166 项、测试类型检查、服务及组件构建通过；完整集成正常 exit 0（运行时 30/30、Lite 157 通过 / 6 跳过、Full 46/46）。安装 runtime SHA-256 为 `934d94c17fecd36797a29971b5b860eef1eadbf82b2e626126859eef34c706dc`；安装和退出重启均保留原用户资料，未发布。随后日志共享安装 runtime 为 `f4609741ac6d207d2b4f2138d1dcd945d1d14322c0be7242abde4c4eac631b5b`，收尾完整集成再次正常 exit 0（30/30、157 通过 / 6 跳过、46/46）。实际恢复后的服务权限、订阅刷新及 Chat 继续判定为未通过。

2026-10-03 00:57 实际安装复验：完全退出并重新启动原应用，原 glocal session 自动恢复，未输入密码。修复后 `http://127.0.0.1:3000/.account/` 返回 `bindings`、`clientCredentials`、`pod`、`webId`、`logout`；节点规范 HTTPS 地址也返回同样的已登录 controls。中央 `https://id.undefineds.co/.account/` 仍只有 `create`。节点 profile 的 `solid:oidcIssuer` 仅为中央，Managed Local 的 API token endpoint 也归中央，因此没有将本机凭据作为 fallback 或签发任何新凭据。中央实际 adapter、验证及精确 WebID→Account 链接尚待定位，不能凭匿名响应判定为某一项。最新 runtime SHA-256 为 `d23b5a7df10c09d9f8e6291308a92075f14401e55e34c7490d58659de7edaf47`；原用户资料保留、未发布。安装及消毒只读证据为 `installed-account-route-manifest.json`、`account-stdio-probe/canonical-account-probe.json`。 修复后完整集成 `installed-account-route-integration` 正常 exit 0（运行时 30/30、Lite 157 通过 / 6 跳过、Full 46/46）；北京时间 00:48:19–00:59:02。完成前复跑 `installed-account-route-final-integration` 再次正常 exit 0（30/30、157 通过 / 6 跳过、46/46）；北京时间 00:59:36–01:11:51。此门禁覆盖本机 Account 路由修复，后续客户端多路径改动另验。

中央只读生产诊断 workflow `37037464518` 正常完成，仅执行 Kubernetes get/describe/logs，未修改部署。镜像为 `ghcr.io/undefinedsco/xpod@sha256:404bbb315d66f12ed3d979345e977b401ec400b23ef63e130acd37148e632839`。最近日志中 23 条 `ConfiguredLoopbackDPoPWebIdExtractor` 验证失败均为 Bun fetch 的 socket 意外关闭；时间覆盖原会话复验窗口。这是中央验证网络失败的证据，尚不足以确定失败的 dereference 目标或实际 Bun 版本，不应直接归因于权限策略改变。 另行对节点 profile 执行未经过 SDK local routing 的公网 GET：直连连接重置（errno 54），显式宿主代理 7897 超时；同机中央 discovery 为 200。本机 Gateway 运行中且 provision 状态 registered/managed 为 true；已登记不代表公网路由可用，SDK 本机读 200 不能证明中央能够 dereference。消毒摘要保存在 `central-account-diagnosis/{safe-summary,verification-causes}.json`；原始生产日志仅存私有忽略目录。

客户端边界按用户最新要求核对：canonical 公网 URL 是稳定身份，访问路径通过共享 SDK 的 loopback/LAN/public/P2P/tunnel 目录探活选择；公网候选不可用不代表本机不可用，不自动开启 Cloud relay。修复认证前路由准备、已记住 Pod 的首次接入和显式服务 key 重试的路由缺口；复用单次 provision 查询及同一底层 transport，不再在打开 Pod 后重复查询。中央 Account 与 token endpoint 保持中央 authority，不能借节点路由改写。本地 Inrupt localStorage 仅存恢复元数据，敏感会话材料在内存，冷启动通过 IdP 静默恢复；API 会话请求凭据也只在内存，当前没有桌面安全存储跨冷启动恢复通道。页面阶段切换不等于两次密码登录。

2026-10-03 01:37 安装客户端多路径修订，原资料保留，未发布。runtime SHA-256 为 `9e074d05679b2646e787c218199790878718b001ab0a7ede7ea388d824fb085f`，安装清单 `installed-client-multipath-manifest.json`。原 glocal 会话冷启动后以 canonical 公网 URL 读取 profile，返回 200 / 1382 字节；网络证据确认目标为 `http://127.0.0.1:3000/glocal/profile/card`，携带 canonical URL/host、Authorization 与 DPoP。本机和节点 canonical Account 均返回已登录 controls，中央 Account 仍只有 `create`。随后正常启动原应用，真实 AI Connections 页面完成配置读取并显示 OpenAI 已连接及 6 个模型。这证明本机读取已接入可用路径，不代表上游模型同步、中央服务凭据或 Chat 已通过。

追加内容校验：本机 profile 为 `text/turtle`，包含 canonical WebID、中央 issuer 与 `oidcIssuer` 属性，不是 HTML 登录页；只保存布尔校验与字节数，不保存 profile 正文。当前应用以正常模式运行，未保留诊断启动参数。

多路径宿主回归 8 文件 202 项、SDK 回归 8 文件 149 项通过；UI lint、测试类型检查、SDK/三入口 UI/平台 runtime/桌面构建及严格签名检查通过。专项先失败再修复，覆盖恢复首读、已记住 Pod、显式 key 请求体与授权头保留、中央 IdP 隔离、写操作不自动重放，以及瞬时故障后用户主动重试。读取故障只在当前请求中排除失败候选，避免永久失效状态；未覆盖 URL 不触发节点探活。完整集成结果与首轮失败记录见下方。

正常安装版 UI 点击“刷新模型”后恢复可操作状态，显示“订阅登录态自动刷新失败，请稍后重试。”；保留原模型及连接，不能将配置加载成功扩展为订阅刷新通过。第一轮完整集成 `client-multipath-integration` exit 1：运行时 30/30；Lite 156 通过、6 跳过、Matrix 创建房间 500 导致 1 失败，Full 尚未执行。单独复查结果见下方，未绕过集成门禁。

随后原 Matrix 夹具直接运行 `client-multipath-matrix-diagnostic-ready` 正常 exit 0：两个 runtime、63/63 事件、10 页同步；HTTP 500 未再现。调用链使用 `OwnerPodAccess` → `HostedPodRoute` → SDK `local-route-fetch`，不经过本轮 `access-route` 或 UI 改动。原始异常被现有 handler 统一转换为 `M_UNKNOWN`，原包装器未保留 stdout 且夹具已清理，当前证据不足以确定根因；不将孤立通过表述为问题已修复。随后完整集成重跑结果见下方。

完整重跑 `client-multipath-integration-rerun` 正常 exit 0（北京时间 01:50:48–02:00:42）：运行时 30/30、Lite 157 通过 / 6 原条件跳过、Full 46/46，包含 Matrix。收尾完整门禁 `client-multipath-final-integration` 同样正常 exit 0（北京时间 02:01:01–02:07:12），结果相同。两轮均包含 Matrix；结束后源码冻结清单 1707 文件无漂移，实际安装 runtime 哈希与清单一致。首轮 Matrix 500 的根因仍未确定，不声称其已修复。

本轮客户端改动位置：

| 文件 | 职责与简化 |
| --- | --- |
| `packages/solid-sdk/src/access-route.ts` | 仅处理覆盖目标；读取切换路径、写入不重放；删除跨请求永久失效状态 |
| `ui/src/solid/XpodSolidRuntime.ts` | 同一次恢复预检准备资源路由，暴露已有底层 transport |
| `ui/src/solid/XpodSolidRuntimeProvider.tsx` | 已记住 Pod 首读同样预路由，复用预检结果，显式 key 重试共用 transport |
| `ui/src/solid/xpod-local-route.ts` | 集中保护中央 issuer，避免三处分别判定 |
| `ui/src/extensions/ai-connections-host.ts` | invocation 保留凭据并使用同一 transport |

对应测试在 SDK `test/access-route.test.ts`、UI 的上述同名测试与 `XpodSolidRuntimeProvider.test.tsx`；未增加依赖、未改变版本、未提交或发布。

安全证据保存在忽略目录 `current-session-network/` 与 `current-account-controls/`：只记录去除 query 的 URL、状态、稳定错误分类、授权头/账号 cookie 是否存在及 controls 的属性名。未记录 token、密码、API Key、Cookie 内容或原始认证头；未清理用户登录记录、账号或 Pod，也未修改生产云端策略。

## 最新 logo + info 呈现

`BrandInfo` 是 shared-ui 的纯展示组件，只接收任意 logo/info 与可访问名称；`XpodDeploymentIdentity` 保留服务元数据请求、验证和部署文案。移除独立 tag，将 Xpod 主标加小下标与 info 放入既有服务栏；WebID 首屏和回调替换品牌插槽，避免双 logo。桌面内嵌 Account 登录也接入。信息查询是公共只读 GET，认证、Pod 预配和 Consent 提交边界不变。

专项任意品牌/无 info/hover/click/Escape/outside/二次 pointer 手势/选区测试 5/5；最终 shared-ui 156/156、宿主 115/115，合并运行 22 文件 271/271。通用组件复用已声明的 Radix `TooltipPortal`，无新增依赖；三入口 UI 构建、test types、UI lint 和依赖状态检查通过。

宿主初轮 3 条旧断言失败：两条把公共部署元数据 GET 也当作禁止的业务提交，一条仍要求不带下标的旧 source mark 文本；改为禁止所有非展示请求并验证单个品牌与可访问 info。Portal 收尾初轮测试误与 shared-ui 构建并行，构建清理产物时 4 个宿主文件无法收集；等待构建完成后重跑 271 项全部通过，未改产品或放宽断言。

| 最新 logo 门禁 | 实际结果与证据 |
| --- | --- |
| 最终原生三部署 | `logo-info-portal-three-deployments` exit 0，browser 24/24、Electron 9/9；最后 Portal 版本，360px 默认/详情截图已人工复核。北京时间 16:07:34–16:09:34 |
| 最终 Consent 恢复 | `logo-info-final-consent` exit 0，7/7；真实 Local 原生 QLever、1280×800 / 360×540 与 Electron 取消桥；北京时间 16:10:01–16:10:26 |
| 最终组件与宿主回归 | `logo-info-portal-unit-ready` exit 0，22 文件 271/271 |
| 最终构建与静态检查 | `logo-info-portal-shared-build`、`logo-info-portal-ui-build`、`logo-info-portal-types`、`logo-info-portal-ui-lint`、`logo-info-final-dependencies` 均 exit 0 |
| 最终完整集成 | `logo-info-final-integration` 正常 exit 0，运行时 29/29、Lite 157 通过 / 6 原条件跳过、Full 46/46；北京时间 16:10:54–16:15:26，含 Cloud→Managed Local 删除回归 |

产品、前端产物与测试收尾快照保存在 `.test-data/login-lead/logo-info-final-source-freeze.json`（260 文件，SHA-256 `c4539548f34f595c704e6ce8782d57f7e96c5b3012c88344564c4d34ddf80893`）；最终矩阵、Consent 和完整集成完成后核对无漂移。该快照不含随后更新的验收文档。

最终截图与报告在 `.test-data/login-deployment-results-70955/` 和 `.test-data/login-lead/logo-info-final-consent-artifacts/`；视觉复核记录保存于 `.omx/state/login-deployment-identity/ralph-progress.json`，保留旧 tag 判定作为历史。三种部署使用实际隔离 Gateway 与原生 Local 存储，并未更新用户生产实例。

## tag 版本修正与验收（2026-10-02，前一版基线）

- `XpodProductEntry` 按可信 preload bridge 收敛 dashboard/settings/callback。浏览器只显示轻量桌面指引，账号入口依据已发现的 issuer；保留单任务 Local 删除授权，不加载完整工作台。Consent 续接仍验证同 Account、精确 interaction 和有效期，并要求明确授权。
- 登录品牌复用正式 `XpodMark`。部署信息默认仅一个墨水紫 tag 和 info 图标，hover/focus/click 展开类型和地址，重复点击、Escape、外部点击关闭。Account 与桌面首次登录共用组件；未分配的地址不以本机监听回退冒充。
- Bun 1.3.8/1.3.12 的 HTTP 流与正常 WebSocket 关闭缺陷先独立重现；相同产品代码在 Bun 1.4.2 分别通过 3,600 次资源传输和 12 项关闭回归。最低版本、CI、镜像与启动门禁统一为 1.4.2，旧 Bun 明确拒绝启动；没有更换为 Node 兜底。既有 JOSE 安装补丁区分 Bun ESM import 与 CJS require，保持 Node crypto 和可导出密钥，依赖状态检查覆盖补丁漂移。
- 三部署浏览器用真实外部 RP 执行 OIDC/PKCE 和私有 Pod PUT/GET；退出、断网和迟到 provider 响应的工作台覆盖迁至真实 Electron。断网请求禁用缓存，并验证实际网络失败，避免合法缓存响应掩盖离线行为。

| 最新门禁 | 实际结果与证据 |
| --- | --- |
| 原生三部署 | `final-tag-visual-three-deployments-race-fixed` exit 0；browser 24/24、Electron 9/9；含服务元数据、远端账号 href、首次登录默认/详情截图与 360px 弹层边界。此前 `final-tag-three-deployments` 也 exit 0 |
| Consent 异常恢复 | `final-tag-consent` exit 0，7/7；1280×800、360×540 和真实 Electron 返回应用，Local 使用原生 QLever |
| Cloud→Local 原生删除 | `final-tag-native-deletion-tcp-ready` exit 0，1/1；真实文件/RDF/ACL、旧绑定授权与重建代次保护 |
| UI 与安全回归 | `final-tag-ui-unit` exit 0，8 文件 101/101；部署详情、重复点击、选区、入口与安全续接 |
| 服务元数据与预配 | `final-tag-backend-unit` exit 0，4 文件 73/73；含分配地址来源和 JOSE 完整依赖图 |
| OIDC 辅助动作竞态 | `oidc-stale-action-red` 复现；修复后 `oidc-stale-action-green` 真实浏览器 1/1、`oidc-stale-action-unit` 安全守卫 36/36，均 exit 0 |
| 构建与静态门禁 | 最新 service TS、三入口 UI、test types、UI lint 与依赖状态均正常 exit 0 |
| 最终完整集成 | `final-all-integration` 正常 exit 0；运行时专项 29/29、Lite 157 通过 / 6 原条件跳过、Full 46/46。北京时间 11:34:25–11:41:00；收尾冻结复跑另记 |

证据保存在忽略目录 `.test-data/login-lead/` 和 `.test-data/login-deployment-results-{28524,55543}/`；原始 Electron trace 和账号 fixture 不作为公开附件。最终默认/详情截图及 360×540 Consent 失败页已经人工复核，视觉判定保存在 `.omx/state/login-deployment-identity/ralph-progress.json`。

本轮保留的失败：一次完整集成跨越合盖睡眠 927 秒，删除测试未执行就超过 300 秒，唤醒后的 S3 请求出现时钟偏差；诊断分别保存于 `full-deletion-sleep-diagnosis/` 与 `full-integration-clock-evidence.json`。单独删除复验先因未指定隔离环境文件而未收集测试，随后 PostgreSQL 初始化临时 Unix socket 服务导致连接提前通过后中断；测试探针改为最终 TCP 服务及实际数据库，未增加超时或删断言。最终重跑结果另行补记，失败不抹除。

追加截图复验的 `final-tag-visual-three-deployments` 首个 Cloud 用例失败：实际授权已到外部 callback，辅助函数对上一页按钮的 `Locator.evaluate` 却无局部期限，越过登录循环截止时间到 240 秒失败。本轮没有资产停顿证据。新增无服务栈的真实浏览器回归先红后绿；动作使用 Playwright 原生 1 秒可取消期限，仅把 `TimeoutError` 作为候选消失返回重新检查页面，其余异常继续抛。未使用可能留下迟到点击的 `Promise.race`，原同节点密码/取消/退出守卫不变。全矩阵重新运行，最终 browser 24/24、Electron 9/9，整个 runner 正常 exit 0。

## 初轮验收（历史，保留原结果）

初轮结论：Local 浏览器功能、Consent 恢复和真实 Local 删除链通过；仍有登录导航停顿，整体稳定性不通过。当时“Web 永远轻量、重管理仅桌面”尚待实现，旧工作台测试通过不代表该边界完成。该状态已由上述后续实现更新。

## 验收对象与限制

- 分支 `codex/login-acceptance-followup`，基线 `32f0034da68c56781b400337b91b9cf64f44457c`，包含本地未提交修正；未发布。
- 当前工作树重新构建服务端、Components.js、三个前端入口和桌面壳；Bun 1.3.8。
- Cloud 使用隔离 PostgreSQL/S3/Redis；Managed Local 与 Cloud 是不同 origin；Standalone 使用自己的 issuer。Local 存储显式使用真实 `xpod_qlever_local_runtime`，不以 fake QLever 证明存储能力。
- 当时未发现用户当前运行的 Xpod Gateway，因此本记录是当前源码的隔离实例验收，不是用户生产实例验收。测试账号、Pod 和容器均为一次性测试资源。
- Consent 故障恢复用例故意将一次 WebID 选择 POST 返回 503，其余登录、存储和授权使用实际 Xpod。跨源 OIDC 的三个用例为独立协议 fixture，另行统计。

## 已通过分项

| 分项 | 结果 | 证明的行为 |
| --- | --- | --- |
| Consent/首次 Pod 的页面与安全守卫 | 10 文件 / 114 用例，通过，exit 0 | 同 UID 续接、账号切换、过期、绑定重读失败与重试等边界 |
| Managed Local + Standalone 浏览器矩阵 | 6/6，通过 | 两个产品入口；从缺 Pod Consent 快速创建再回原 UID；真实 code/state/PKCE token；精确 WebID/Pod；私有 PUT 201 / GET 200、匿名拒绝；刷新、断网恢复、退出与迟到请求隔离 |
| Managed Local 桌面完整生命周期 | 1/1，通过 | 账号登录、私有 Pod 读写、同 renderer 关闭到托盘、完全退出及冷启动恢复；Account 使用 Cloud authority |
| Standalone 单独复查 | 浏览器 3/3、桌面 1/1，通过，runner exit 0 | 独立 issuer 与私有存储；桌面完整生命周期。本轮成功不抹除下述前轮失败 |
| Consent 异常恢复 | 7/7，通过，exit 0 | 1280×800 与 360×540 的重试、返回授权、取消授权；保留已选绑定和记住选项；重试不自动提交授权；取消不签发 token；Electron 经可信取消桥返回应用 |
| 跨源 OIDC 协议对照 | 3/3，通过 | 原生导航交付可兑换的 code/state；不自动批准新授权请求；旧 fetch 的 CORS 失败对照。不是完整产品部署验收 |
| Cloud→Managed Local 删除链 | 1/1，通过，exit 0 | 真正删除文件/RDF/ACL 与绑定；保留其他 Pod；管理员恢复旧绑定删除能力；重放和旧代次不能删除同地址重建的新 Pod |
| 构建与静态检查 | 服务 TS、Components.js、UI、desktop、测试类型、UI lint、依赖状态均通过 | 当前构建可用；不证明完整集成或生产部署通过 |
| 完整集成门禁 | Lite 157 通过 / 6 条件跳过，Full 46 通过，整个命令 exit 0 | 本次完整运行正常结束；不能覆盖浏览器/Electron 已观察到的间歇性导航失败 |

已检查窄屏浏览器与 Electron 的失败页截图：重试、返回授权、取消/返回应用均在视口内；使用页面内墨水紫操作和中文文案。

## 未通过与待实现项

1. **Cloud 浏览器重新登录停顿**：完整三部署 runner 的 Cloud 前两项通过，第三项在 WebID POST 200 后回到账号文档，未完成授权 callback，60 秒超时。页面正文为空；该次浏览器对 `main.js` 的请求缺少完成响应记录，独立客户端随后可以获取同资源。这些观测不能单独证明根因。
2. **Standalone 桌面回调停顿**：Local 矩阵里 Managed Local 桌面通过，Standalone 在 `/auth/callback` 空页面超时。消毒网络记录显示 callback 文档与入口脚本完成，但 `settings/assets/global-0ykqUq1N.js` 只有请求、没有响应或结束事件。随后同源码、全新测试栈单独复查通过。它仍是间歇性稳定性问题，不能把单次重跑成功当作修复，也不能仅凭该网络现象确定根因。
3. **Web/桌面入口边界未收敛**：当前 Account、Consent 和快速创建中的“自己的部署”仍可进入浏览器工作台。本轮只验当前实现，未实现新的桌面独占重管理要求；最终入口规则见主 spec §13.1。
4. **残留旧品牌**：`ui/src/auth/XpodLoginBrand.tsx` 仍引用旧 `xpod-shield.svg`，属于未完成项。本轮没有宣称所有品牌已统一。
5. **独立的 Bun WebSocket 关闭缺口**：此前已发现正常连接替换/心跳关闭的红回归，当前未继续改产品源码。本次完整集成退出成功，不能替代那些专项回归通过，也不代表该缺口已修复。

## 本轮测试修正

- `tests/e2e/desktop-login-lifecycle.spec.ts`：按可访问名称“邮箱”定位公共邮箱输入框，不依赖已变更的 HTML type。
- `tests/e2e/consent-recovery.spec.ts`：操作用户可见的 WebID 单选卡，展开“请求详情”后操作记住选项；继续严格验证原绑定、记住状态、请求数量、token 与私有读写。没有绕过授权，也没有修改产品来迁就旧测试。
- 本轮产品源码未修改；前端产物由正式构建脚本生成。主 spec 同步记录已确认但尚未实现的桌面边界。

## 私有证据索引

证据在忽略目录 `.test-data/` 中；Electron 原始 trace 可能包含会话信息，不作为公开附件。

- 构建、114 项守卫、类型和 lint：`.test-data/login-lead/local-consent-*.log`；真实子进程退出码见 `release-unified-results.jsonl`。
- 首轮完整矩阵失败：`.test-data/login-deployment-results-28186/browser/report.json`。
- Local 浏览器全绿、Managed Local 桌面通过与 Standalone 失败：`.test-data/login-deployment-results-34365/{browser,desktop}/report.json`。
- Standalone 单独复查通过：`.test-data/login-deployment-results-37901/{browser,desktop}/report.json`。
- Consent 最终恢复：`.test-data/login-lead/local-consent-native-recovery-final-report.json`，截图在同名前缀的 `*-artifacts/`。
- 真实存储删除：`.test-data/login-lead/local-consent-native-deletion.log`。
- 完整集成：`.test-data/login-lead/local-consent-full-integration.log`，2026-10-02 02:55:18–03:01:59（北京时间），Lite 157 通过 / 6 条件跳过、Full 46 通过，整个命令正常 exit 0。此前未退出的轮次仍不视为通过。

本记录不把构建成功、协议 fixture、单项测试或重跑成功提升为整体发布通过，也不证明实际 AI Chat 可用。

## 2026-10-03 无公网路由前轮验收（拓扑前提已撤回）

**用户纠正后的结论：Cloud 与 managed Local 的独立 `profile/card` 始终在 Cloud，负责身份与 Pod 发现；Local 只存放 Pod 数据及其访问控制。前轮 fixture 却从 Local `podUrl` 拼 WebID，并关闭该 profile 地址后测试 Account-only 验证；因此 1/1、HTTP 状态与全量退出码只证明该错误拓扑下的实现行为，不证明正确产品架构。Draft PR #29 已标记暂缓，前轮上线确认作废。**

设计依据是 `docs/architecture-v2.md` §3.2；`docs/acceptance/runtime-mode-matrix.md` 的 2026-08-28 真实 Local 验收也使用 Cloud WebID 与独立 Local Pod URL。当前偏差已定位：`LocalPodProvisioningService.createPod` 强制 Local profile、`ProvisionPodCreator.handle` 远程分支强制 receipt WebID 等于 Local storage profile、`ProvisionPodStore.create` 远程分支仅记录绑定而不创建 Cloud profile。Git 历史中 `1dac88bde` 的 2026-09-02 squash 已包含该变化；此处不据 squash 元数据断言实际修改人或原始修改时间。

正确复验须在 Local 公网数据入口不可达时仍匿名读到 Cloud profile HTTP 200，核对 Cloud issuer、Local storage 指针，以及 Account、授权、token、native session、Local ACL owner 的精确 Cloud WebID 一致性。旧 node-origin WebID 不能未经迁移决策改写。还须验证只托管 card 而没有额外 Cloud 存储 Pod，card 公共读/owner 管理可用且不开放身份目录任意文件写入；首次创建须在没有 Local 公网数据入口的条件下完成，不能依靠临时 public relay 创建后再关闭来代替。旧身份不自动迁移，多 Pod 发现关系与失败重试不得被单次创建吞掉。下面保留前轮过程与失败事实用于审计，所有“通过”均受上述拓扑限制。

前轮诊断曾把“不可达的 Local profile 导致中央验证失败”作为修复前提，因此选择 Account-only 验证。该前提和发布方向已撤回：正确目标是恢复独立 Cloud card 的创建与 Pod 发现关系，不能把 Local 数据入口的可达性变成身份验证的前提。以下仅保留错误拓扑下的历史诊断及请求事实。契约见共享登录 spec §13.14；[Account host 会话授权](../account-host-session-authorization.md) 已标为暂缓审计方案。

新增验收使用隔离的真实 Cloud 数据服务、原生 Local QLever 和 Electron。注册、创建 Pod 后停在 Consent，撤销 canonical 地址的临时 provisioning 传输，再开始第一次桌面授权；新中央进程不曾缓存该 WebID 的 profile 校验。`ECONNREFUSED`、公网路由不可用、本机 canonical 身份登录成功和无 Cookie 的中央 Account 请求分别记录。它不使用用户安装版的数据，也不替代现网验收。

修复中的端到端回归发生在 `.test-data/managed-local-no-public-route-cCHmGy/`：本机登录成功，中央 Account 返回 400。追加安全 metadata 的复现 `.test-data/managed-local-no-public-route-Zx8piI/` 确认 issuer、audience、host client、URL 与 method 正确，而 proof 未形成有效的 access-token hash；当时的布尔 metadata 不能区分字段缺失与空字符串，不能单独断言缺少字段。原始 Inrupt signer 的缺字段行为另由真实 signer 回归证明，浏览器 sender 空 hash 则由后续阶段定位。客户端签名层补齐 token 绑定；接收端保留既有完整 DPoP 校验和已发行旧客户端的缺字段兼容，提供了 `ath` 时严格校验类型及哈希。此轮曾新加的强制字段门槛产生兼容回归，已决定撤除；未来全面强制需要独立客户端迁移，旧版兼容不等于最新 RFC 合规。此前生成组件尚未构建、测试 native wrapper 缺失及 provisioning relay 重复关闭属于夹具初始化失败，不记作产品 red。

最终冻结版 `.test-data/managed-local-no-public-route-l4ZCnY/` 于 2026-10-03 07:15:12 UTC 开始，Electron 测试 1/1 通过，零跳过、零重试，runner 实际 exit 0。公网 profile 真实 `ECONNREFUSED`，`publicRoute.configured=false`、`available=false`；同一 native host 两次无 Cookie 的中央 Account GET 均 HTTP 200，证明第二次使用新 proof，且实际 `ath` 为非空字符串。中央凭据签发及 token 交换均 200，token WebID 等于当前 canonical 身份。私有 Pod PUT 201、GET 200 且内容一致；providers API 200。现场读取的 27 项公开 JS 响应 SHA256 与工作区静态文件逐项相同，没有把未加载的源码当作产品证明。

中间新 sender 曾把 WebCrypto 的 `ArrayBuffer` 直接交给 JOSE，Node 编码器接受它，浏览器编码器却返回空字符串；`.test-data/managed-local-no-public-route-SlVhd5/` 的安全拒绝阶段为 `proof-claims`。真实浏览器编码器回归先 red，再通过 `Uint8Array` 修复 green，最终 native wire 证明非空 hash，未通过放宽空值检查掩盖失败。此前“浏览器内嵌另一份 signer”的判断已撤回：现场资源、实际依赖和被动请求发起栈证明源码与加载版本一致，差别发生在编码器运行环境。

| 验收层 | 最终证据 |
| --- | --- |
| 真实隔离 Pod 读写 | PUT 201 / GET 200，内容匹配 |
| Gateway 客户端认证 | 正确中央凭据、token、WebID；providers API 200 |
| `/v1/models` | 本 fixture 未请求，不由 providers 200 推导 |
| 真实上游 Chat | 本 fixture 未请求，不作可用声明 |
| Account / SDK 回归 | 84 / 176 项通过，sender 专项 27 项；真实 CSS URL extractor、browser Session、JOSE browser 编码器均覆盖 |
| 构建 / 类型 / 依赖 | TS、Components、三个 UI 目标、测试类型检查、SDK 四个新增测试单独严格 TS、依赖一致性、diff 检查均 exit 0 |

中央端候选补丁最初只涉及自身 Account 验证、配置与对应测试文档；独立验证后增加已有 JOSE 安装补丁的 loader 修复、窄依赖守卫及 3 项对应回归，最终为 11 文件，不含 SDK sender 增强。补丁已相对 `origin/main` 的 `9c88a0ac2003998f15b7ad466328759dd9a35d64` 分离并通过 `git apply --cached --check`，未混入工作区其他改动。在独立 `codex/account-host-no-public-route` 主线分支中，锁定安装、工作区包构建、服务 TS、组件生成、测试类型、依赖状态与 84 项 Account 专项均 exit 0，包括真实 Local / Cloud 组件图与旧 Inrupt proof 兼容。独立分支不包含 SDK sender 增强，也不以主工作区的全量结果冒充它的全量结果。SDK signer 增强另随客户端发布；中央保留已有无 `ath` 会话的兼容，因此不能以要求用户重装或重新输密码代替服务端修复。

全量集成首次通过于 2026-10-03 07:16:24–07:22:24 UTC，整个 `bun run test:integration` 实际 exit 0：运行时 30/30、Lite 157 通过 / 6 条件跳过、Full 46/46。完成前第二轮于 2026-10-03 07:22:46–07:30:03 UTC 结束，整个命令实际 exit 0；同样为运行时 30/30、Lite 157 通过 / 6 条件跳过、Full 46/46。源码冻结检查 2201 文件、零漂移，依赖状态及 diff 检查再次通过。独立中央候选首次全量于 2026-10-03 07:30:37–07:31:41 UTC 实际 exit 1：Lite 154 通过 / 6 条件跳过，CLI 会话恢复一项未收到 JSON envelope；Full 未执行。候选专项及构建通过不等于其全量通过。定向复现的 CLI exit 1、stdout 长度 0，私有 stderr 确认 `require() async module .../jose/dist/node/esm/index.js is unsupported`；不是 JSON 字段断言问题。已有 JOSE 安装补丁把 Bun 的 CJS 和 ESM 都指向 ESM，候选已补入主工作区已有的按加载器区分实现与窄依赖检查。两项补丁导出回归先 red，修复后 JOSE 3 项与真实 CLI 生命周期 1 项 green、整个命令 exit 0。最初一条诊断命令误把 executable wrapper 当作目录，属于夹具错误，不计产品 red；正确 wrapper 的失败及随后 green 均保留。最终 11 文件候选首次全量绿于 2026-10-03 07:36:50–07:38:51 UTC，Lite 155 通过 / 6 条件跳过、Full 46/46，整个命令 exit 0；完成前的独立复跑于 2026-10-03 07:39:39–07:41:45 UTC 再次整个命令 exit 0，同样 Lite 155 通过 / 6 原条件跳过、Full 46/46。最终依赖与 staged diff 检查通过，11 文件零漂移；独立提交 `9e60a7fae`，已提交 [Draft PR #29](https://github.com/undefinedsco/xpod/pull/29)。PR 只包含上述 11 文件，不是生产部署证明；中央服务仍待 RC / stable 发布。现网中央仍未更新，本机安装实例没有本轮完整链路结论；无公网冷启动恢复也未在该 fixture 新增验收。原始私有日志保留在忽略目录，不公开 token、DPoP proof 或账号密码。

## 2026-10-03 授权返回页、空闲续期与安装版复验

本节是上述历史轮次后的增量验收。授权返回页采用正式折角主标、墨水紫和暖底色，四种状态分别说明已接收、链接失效、未完成与接收失败。静态按钮 `xpod://ai-connections` 只负责导航，不携带 OAuth 参数。源文件为 `src/api/ai-gateway/connect/AuthorizationCallbackPage.ts`，呈现快照见[设计留档](../design-history/2026-10-03-authorization-callback/README.md)，行为见[共享登录 spec §13.13](../superpowers/specs/2026-09-29-shared-ui-pod-sign-in-design.md)。

### 安装版和真实 UI

验收对象是 `/Applications/Xpod.app`，版本 0.4.20 / Electron 33.4.11，使用原有用户资料目录，未清理账号、Pod 或订阅凭据。最终包签名检查通过；`app.asar` SHA256 为 `5d4004b3dc4d1822ae26a63d87a2c6fd5ec2bb6c04c6f5ca1ea290c660c9f3cd`，服务运行产物 SHA256 为 `1dfe57edc7a1dbfb22924f0bed6cebd68a693d8567906bfeed6d907fe434ba17`。安装清单及可恢复的前版备份索引在 `.test-data/gpt61-callback-page/installed-final-manifest.json`。

- Chrome 的真实订阅回调已显示正式“已接收”页面；页面本身不证明后续保存成功。人工授权步骤不计为代理点击验收。
- 从无授权参数的失效页预览点击返回，经 Chrome 系统“打开 Xpod”弹窗，两次均唤回安装版。安全事件记录中的两次 renderer id 均为 1，证明返回复用已有窗口；不根据监听器建立前的空数组推断启动窗口数量。未设置浏览器“始终允许”。
- 最终安装版正常冷启动到 `/ai-connections`，自动恢复 `glocal`，显示 OpenAI 已连接和实时 Pod 数据，未输入账号密码。结束诊断捕获后，再次普通启动也恢复到相同页面；应用留在正常运行状态。
- 此前真实 OpenAI 模型同步 HTTP 200，目录 6 项、选用 3 项、失效 1 项；它不等于实际 Chat 通过。Kimi 订阅的控制台落在 `/code/console`，未创建或复制 API Key；Kimi API 平台入口本轮没有实际 UI 结论。

### 空闲续期和回调重试

SDK 补丁在原令牌持有层按真实到期时间检查首次认证请求，计时器与请求共用续期，依赖状态要求补丁恰好应用一次。补丁回归 9/9；原生 Electron 短期令牌专项 2/2。access token 30 秒、refresh token 180 秒的场景中暂停一个主动续期计时器；空闲期间只有 3 次匿名 `/service/status` 轮询，零认证请求。第一个过期后的私有 Pod GET 在 31.604 秒发起，先 refresh 200，再 Pod 200，授权码登录与密码提交均未增加。refresh 已失效的场景得到 `invalid_grant`，显式重新登录取得新授权码，密码提交仍总计一次，复用账号会话。

这是短期生命周期的真实 Electron 证明，**不是用户原安装资料实际等待六小时的验收**；完全零网络空闲仅在单元测试中覆盖。此前七次夹具执行失败保留，不作为产品 red。

另一个可重复故障是 SDK 完成交换后清理浏览器 URL，随后 profile 暂时读取失败。旧页面重试重新取清理后的 URL，触发 `oidc-state-invalid`。现在组件挂载时保留原始回调地址；因果 red 已记录，修复后 57/57，交换一次、不退出、不重新登录。身份、state、时效与目标路由检查保留。最终安装版成功恢复，但没有人为向用户真实 profile 注入 503；该失败重试路径的证据是组件回归。

### 门禁与保留失败

| 层级 | 最终证据 |
| --- | --- |
| 回调页单元 / 视觉 | 115 项检查；四状态 × 两主题 × 两宽度共 16 场景，含焦点、对比度、溢出、CSP 和零外部资源 |
| 合并服务单元 | 155/155，exit 0 |
| 桌面单元 | 174/174，exit 0 |
| Solid SDK | 149/149，exit 0 |
| 冻结后的 UI 全量 | 107 文件、1059/1059，exit 0 |
| 最终类型 / lint / 依赖 | `build:ts`、`typecheck:test`、UI lint 与依赖状态检查 exit 0 |
| 完整集成首次最终绿 | 2026-10-03 03:57:46–04:08:47 UTC，整个命令 exit 0；运行时 30/30、Lite 157 通过 / 6 原条件跳过、Full 46/46 |
| 收尾完整复跑 | 2026-10-03 04:10:06–04:17:12 UTC，整个命令 exit 0；运行时 30/30、Lite 157 通过 / 6 原条件跳过、Full 46/46 |

此前两次完整集成正常退出但失败：一次运行时资产压力夹具达到原 30 秒限时；一次 Lite Pod 删除达到原 180 秒限时。当时有并发构建/测试负载，不能据此断言唯一根因。删除在正确隔离环境独立复跑 1/1，通过后低负载完整集成通过；未放宽断言或延长限时。另一次独立删除命令缺少隔离 ENV，未收集测试，不算产品失败。

UI 全量暴露五份过时断言与一处异步夹具竞态，均修测试，不改产品迁就断言。邮箱通过可访问标签定位，普通 Pod 管理仍走现有边界；仅允许确切的公共 `GET /api/service-info`，账号/Pod 零读写断言保留；异步授权夹具先结算初读、等待可用，再验证切换身份后零凭据 POST。公开测试类型门禁通过；扩大到所有 UI 测试源码的直接检查仍有既有 239 项类型错误，本轮差额为零，不能称整个 UI 测试类型债已清除。

### 中央服务访问仍未通过

真实中央容器的只读 profile 探针中，Bun 1.3.12 与 Node 22.23.3 均解析到 IPv4，随后在 HTTP 响应头前 `ECONNRESET`，没有状态码；没有继续执行 discovery/JWKS。第一次探针虽然 workflow 因 continue-on-error 显示成功，实际脚本执行失败，已排除为网络证据。有效复查为 [V3 实际运行](https://github.com/undefinedsco/xpod/actions/runs/37094044995)。只读诊断分支不部署产品、不修改权限。

用户节点的真实 `/provision/status` 为已注册、已托管，但 `publicRoute.configured=false`、`available=false`。分配了 canonical URL 不代表公网路由可达。本机客户端通过多路径能读取私有 Pod；中央 issuer 仍需从公网验证该 WebID，本次实际错误发生在权限绑定之前。宿主实际代理为 `127.0.0.1:7897`，主机直连 profile TLS 失败、代理读取超时；不以示例 7890 的连接拒绝充当实际代理结论。

因此该历史轮次中 `service_access_missing`、Gateway 签发 API Key 与真实 Chat 链路仍未验收通过。**这不是“本机使用必须先配置公网路由”的产品条件**：上述中央 Account 用通用资源验证器读取远端 profile，正是须修复的依赖。最新契约见[共享登录 spec §13.14](../superpowers/specs/2026-09-29-shared-ui-pod-sign-in-design.md)。本机 Pod 验证已有内部路径；中央 Account 应验证自身签发的 host 会话及自身账号绑定，资源权限验证仍保持独立。历史探针不证明配置公网是唯一或必要修复。没有降低 DPoP/WebID 验证，也没有自动启用公网中继。这里的出站错误脱敏诊断不改变网络策略；中央生产尚未更新该诊断代码。

私有证据：`.test-data/gpt61-callback-page/`（页面、回调重试、安装版、完整门禁），`.test-data/gpt61-idle-session/acceptance-summary.json`，`.test-data/gpt61-readonly-probe/actual-v{2,3}-run-safe.json`，`.test-data/gpt61-ui-regression/report-safe.json` 与 `.test-data/gpt61-background-pod-regression/report-safe.json`。原始 trace 可能含会话信息，不公开附上。效果与效率的限定比较另见 [worker 观察记录](2026-10-03-worker-comparison.md)。


## 2026-10-03 Cloud card 拓扑与账号恢复验收（进行中）

本节记录候选 0.4.23 的当前状态，时间统一为 UTC。上节末尾“中央 Account 应验证自身签发的 host 会话”的 Account-only 验证方向已撤回；`customAccountHost` extractor 原型不纳入本次发布。当前采用标准 DPoP/WebID 验证与 Cloud card 拓扑，不以自定义 host 会话替代 Solid 身份证明，也不要求本机先开公网。

Managed Local 的独立 profile/card 永远由 Cloud 承载，用于身份与 Pod 发现；数据 Pod 保持 Local canonical storage。Local 从首次启动即无公网路由，认证客户端通过已有本机传输读取私有数据。Cloud card 可读不等于 Local 数据公开，也不能代替 Local 私有数据读写与匿名拒绝验证。

| 当前专项 | 实际结果与边界 | 时段（UTC） |
| --- | --- | --- |
| Candidate fresh NoPublic | 1/1，actual exit 0；Cloud identity 与 Local 私有访问通过。当前 namespace `GET` 拒绝状态为 403；新增 Cloud 身份命名空间任意文件 `PUT` 拒绝门禁尚未运行，不能据此声称该新增检查通过 | 2026-10-03 11:16:43.583–11:17:15.178 |
| Candidate remember / Cookie | 2/2，actual exit 0；unchecked 完全退出后须再次提交密码，checked 冷恢复零新增密码；另一次新 OIDC 通过已有 Account Cookie 复用。Account Cookie 与 WebID Consent 记忆分别验证，不通过复制 Cookie 或注入选择取得结果 | 2026-10-03 11:10:05.806–11:10:42.825 |
| Candidate session refresh | 3/3，actual exit 0；各用例密码 POST 总计 1，覆盖短 TTL 续期、私有读取与失效后重新授权。短 TTL 验证不是实际等待六小时，也不是原安装资料的六小时验收 | 2026-10-03 10:43:07.267–10:45:16.155 |
| Candidate 三部署 Matrix | 浏览器 30/30、Cloud Electron 3/3 通过；完整命令 actual exit 1。Managed Local 首项失败，Account UI 状态持续 anonymous；其余 5 项未运行 | 2026-10-03 11:18:51.004–11:21:01.351 |

Matrix 的三部署浏览器各两项复用场景，密码 POST 分别为初次 1、复用 0、显式 Consent 0。密码 authority 为 Cloud / Managed Local 的 `localhost:39001` 与 Standalone 的 `localhost:40991`。Cloud Electron 主生命周期密码总计 1，托盘保持同一 document，完全退出后同 userData 自动恢复并真实读取原私有数据；Consent 初次 1、托盘恢复 0、冷恢复 0。另两项 Cloud 用例验证离线失败退出后重试与延迟 provider 的退出边界；它们没有独立密码计数附件，不能补称密码次数已逐项证明。

Managed 失败发生在 WebID 与完整 Models 页面已经就绪之后：Local `127.0.0.1:39991` 跨站请求 Cloud Account，无 Cookie 的请求返回匿名 controls；随后带认证的 Account 请求返回完整 controls，创建 client credentials 也返回 200，但 Account UI 状态仍未同步为 authenticated。失败证据保留，未降低身份断言、伪造 Cookie 或重试用例掩盖问题，具体产品根因仍在定位。

安全证据位置（均为本地私有记录，不公开原始 token、Cookie 值或 trace）：

- 根工作区 `.test-data/login-lead/release-unified-results.jsonl`：上述 gate 的实际退出码与起止时间。
- 候选工作区 `.test-data/no-public-route/gates/candidate-cloud-card-native-no-public-final.log` 及 `.log.stderr`。
- 候选工作区 `.test-data/desktop-account-remember-gates/candidate-desktop-account-remember-v3.log` 及 `.log.stderr`。
- 根工作区 `.test-data/no-public-route/gates/candidate-session-refresh-final-frozen.log` 及 `.log.stderr`。
- 根工作区 `.test-data/no-public-route/gates/candidate-login-matrix-navigation-final.log` 及 `.log.stderr`；候选 `.test-data/login-deployment-results-26470/{browser,desktop}/report.json`。
- 根工作区 `.test-data/no-public-route/release-selection/managed-account-matrix-failure-evidence.json`：脱敏的请求时序、失败边界、已通过项与清理记录。原始 Managed trace 位于候选结果目录的 `desktop/e2e-desktop-login-lifecycl-b5a81-lls-back-safely-when-needed-chromium/electron-context-private.zip`，含会话材料，不公开附上。

**本轮尚未整体通过。** 最新 closure 的完整集成、RC 与 stable 尚未通过；上文历史全量绿只证明当时版本，不能作为此次 closure 的完成证据。原安装版 `glocal` 尚未用最新候选完整复验，fresh fixture 通过也不能证明旧安装资料的双密码与账号恢复问题已解决。后续全绿后另行追加结果，不覆盖本节失败记录。


### 2026-10-03 后续 Account source 与展示缓存修订（仍在验收）

前述 Managed anonymous 失败保留。随后修复以当前标准 SDK authenticated fetch 确认 Account，并保持已确认 Cookie Account 优先、请求来源撤销和独立身份边界；候选核心 focused 141/141、根工作区 129/129，实际 exit 0。候选正式 Matrix 在 2026-10-03 11:45:35.910–11:47:57.076 UTC 实际 exit 0，浏览器 30/30、Electron 9/9，未重试。三部署主生命周期均密码 POST 总计 1，托盘与冷恢复零新增 Consent，精确身份 / storage binding、私有写读、匿名拒绝与冷恢复私有读取通过；离线退出和延迟 provider 边界也通过。其安全证据是根工作区 `.test-data/no-public-route/release-selection/candidate-login-matrix-sdk-account-final-safe.json`，原始本轮报告为候选 `.test-data/login-deployment-results-51756/{browser,desktop}/report.json`，不使用前轮截图代替本轮 UI 证据。

同一 Account source 版本的后续候选专项也实际 exit 0：NoPublic Cloud namespace 新增私有 `PUT` 拒绝门禁（11:49:45.366–11:50:05.014 UTC）、remember / Cookie（11:50:49.525–11:51:19.343 UTC）与 refresh 3/3（11:53:27.940–11:55:24.225 UTC）。日志分别为候选 `.test-data/no-public-route/gates/candidate-account-source-cloud-put-final.log`、候选 `.test-data/desktop-account-remember-gates/candidate-account-source-remember-final.log`，以及根工作区 `.test-data/no-public-route/gates/candidate-account-source-session-refresh-final.log`，均另有 `.log.stderr`；实际退出码 / 时段在根工作区 `.test-data/login-lead/release-unified-results.jsonl`。这些记录属于展示缓存修订之前的 UI。

随后发现 Account-only 展示缺口：真实 sanitized Bob 记住记录遇到仅含 Alice id 的服务器身份，会错误补上 Bob 的名称 / 用户名；真实 sanitizer 不保留 `account.webId`，未据此声称 WebID 泄漏。修复按[spec §13.17](../superpowers/specs/2026-09-29-shared-ui-pod-sign-in-design.md)仅让历史 Account 展示缓存在 issuer + 服务器权威 Account id 精确匹配时补齐，无可靠 id 不借用；服务器字段与本次 pending 邮箱保留，Cookie Account / SDK WebID 独立。

该展示修复已通过真实 sanitize 路径的因果 red → green：两树各 93/93 相关测试、`typecheck:test`、两文件 lint 与 diff 检查实际 exit 0。回归覆盖不同 / 缺失缓存 id、仅 controls URL 提供权威 id、未知权威 id、同 id 补齐与当前 pending 邮箱；独立 Account Bob / SDK Alice 的已有回归保留。安全记录为根工作区 `.test-data/no-public-route/release-selection/account-card-cache-scope-evidence.json`。

**最新展示修复尚未完成新构建后的原生重验。** 上述 30+9 与专项原生通过是该修订前的证据，不能代替当前 UI 验收；后续新 artifact 结果另行追加。旧安装 0.4.20 的 `glocal` 双密码 / 记住问题仍未按最新候选完整复验，不能声明已修复安装版；短 TTL refresh 也不等于实际六小时验收。最新 closure 的完整集成与 RC / stable 发布结论仍须独立确认。


### 2026-10-03 展示修复复验与两项后续缺口（进行中）

展示修复的 UI 在两树 12:00:05–12:00:55 UTC 重新构建并冻结后，候选新 artifact 正式 Matrix 于 12:01:16.606–12:03:40.167 UTC actual exit 0：浏览器 30/30、Electron 9/9，原强断言、无用例重试。三部署主生命周期密码各 1 次，托盘 / 冷恢复零新增 Consent，精确身份与 bindings、私有读取和匿名拒绝通过；所属 runner / 原生应用 / 矩阵容器完成清理。安全证据为根工作区 `.test-data/no-public-route/release-selection/candidate-account-display-login-matrix-final-safe.json`，私有本轮报告为候选 `.test-data/login-deployment-results-68616/{browser,desktop}/report.json`。这条后续结果补齐上一节“展示修复尚未原生重验”的当时状态，旧失败记录仍保留。

同一展示版本的候选 NoPublic PUT 门禁于 12:05:48.124–12:06:05.883 UTC、remember / Cookie 于 12:06:33.560–12:07:02.882 UTC 实际 exit 0。对应候选日志为 `.test-data/no-public-route/gates/candidate-account-display-cloud-put-final.log` 与 `.test-data/desktop-account-remember-gates/candidate-account-display-remember-final.log`，另有各自 `.log.stderr`；实际时段 / 退出码见根工作区 `.test-data/login-lead/release-unified-results.jsonl`。这些结果与两树 93/93 展示缓存回归都是已发生的历史证据，不能覆盖以下两项后续 source 修复。

随后独立 review 确认两个 P2 缺口，已由 Lead 纳入修复：SDK Account 探测的 503 / 非法 200 不能被当成匿名成功而跳过可重试错误；Cookie Bob + SDK Alice 的 on-demand 路径不能拿 Bob 的凭据 collection 作为 Alice 自证，否则服务器 400 会阻断为 service_access_missing。服务器 Cookie 优先保持，SDK 自身 Account index / create / list / revoke 需统一使用 Cookie-free SDK 认证能力，Cookie 能力仅在真实 bindings 包含目标 WebID 时借用。完整约束追加于[spec §13.17](../superpowers/specs/2026-09-29-shared-ui-pod-sign-in-design.md)。

**这两项新 source 修复仍需冻结、重新构建与对应回归 / 原生验收。** 此时不声明最新 closure 整体通过，不用 12:00:55 展示版本的绿替代后续代码证据。旧安装 0.4.20 `glocal` 的最新复验、真实六小时行为、完整集成与 RC / stable 结论仍各自独立；当前只追加文档，未运行新原生门禁。


### 2026-10-03 独立 Account 凭据与探测错误的当前闭环

两项后续产品修复已完成因果回归并重新构建：SDK Account 临时失败 / 非法响应进入有界重试，终止错误使用中文提示；SDK Account 的 index / create / list / revoke 统一沿 Cookie-free 标准 SDK 认证，Cookie 能力先核对真实 WebID bindings。根工作区旧 Runtime 另有同接口接线修复，候选较新的架构保留。候选 UI 于 12:24:22.435–12:25:40.031 UTC、根工作区于 12:24:22.435–12:25:43.306 UTC actual exit 0，三个构建目标已冻结；不能用本次构建成功代替原生验收。

新增真实双身份用例此前四轮均 actual exit 1，两个原 remember / Cookie 用例每轮均通过。前三轮分别在测试试图进入已有登录 Cookie 的密码页、要求 CSS 必有 account.id、读取尚未挂载 Runtime 时失败，尚未触及独立凭据申请。第四轮 12:41:45.130–12:42:29.272 UTC 证实正常 Account UI logout 后活 Alice SDK 的精确私有读取仍为 200，Bob 真实登录后默认 Account 控件属于 Bob；随后整页重载走了新的授权页面，没有 Alice SDK DPoP 或客户端凭据 POST。其证据不能作为 Cookie-free 凭据能力的产品 RED，也未完成新的 token exchange，不能宣称 SDK 已串成 Bob。

当前 SDK 安全状态留在内存，整页重载与活会话刷新属于不同验收。新增用例改为保留活 Alice SDK，通过真实 Account refetch 更新默认 Bob，再首次触发 Gateway 申请；首次申请前所有实际客户端凭据 POST 必须严格为零。失败记录与私有证据均保留，不复制 Cookie / token 或清空 SDK 取得结果；新一轮尚待实际退出码。

全 UI Node 首轮实际结果：候选 12:44:28.268–12:47:14.745 UTC actual exit 1，1346 通过 / 4 失败；根工作区 12:44:28.268–12:46:58.733 UTC actual exit 1，1161 通过 / 1 失败。已定位并仅修正测试契约：lazy Account 边界须等待真实挂载；已登录 Account 显示个人卡片而非登录按钮，但 Pod-ready 仍须为 false；凭据重试测试明确声明原 fixture 的可信 Gateway authority，保留请求体、DPoP / Bearer、路由和请求次数断言。全量复跑尚待完成。

完整集成首轮 12:12:22.259–12:18:42.322 UTC actual exit 1：runtimecompat 30 通过，lite 163 通过 / 16 skip，full 57 通过 / 6 失败。五项失败源于测试将 JSON POST 请求头复用于无 body 的 Account GET，尚未进入 profile / provision 业务；已限定只去除 GET 的 Content-Type，不改变 POST 或产品。另一个删除后私有 GET 实际为已认证无 Read 权限的 403：后置 HTTP 状态限定 403 / 404，完整 inventory、目录、sources / quads / mirror 严格为零、kept 数据不变与旧 generation 隔离断言保留，并补 kept 匿名拒绝。两树 typecheck:test 再验 actual exit 0；完整集成必须重跑通过后才能闭环。

实际时间 / 退出码仍以根工作区 .test-data/login-lead/release-unified-results.jsonl 为准。新源码的完整原生、完整集成、RC / stable、旧安装 glocal 和实际六小时续期仍分别待验，以上不是整体完成声明。


第五轮双身份原生 12:51:35.437–12:52:37.298 UTC actual exit 1，原两个 remember 用例通过。新增用例已实际进入独立能力链：首次申请前 credential POST 为零；活 SDK / 原私有读取仍是 Alice；默认 Account 为 Bob；Alice Cookie-free DPoP 的 Account GET / credential POST 为 200、ATH 精确匹配、没有继承 CSS-Account-Token，Gateway providers 返回 200，新凭据在真实 issuer 的 client_credentials token exchange 为 200 且身份 / issuer 精确匹配，原私有内容再次完全一致。失败位于 Bob Cookie 的全对象比较，到期时间增加约 0.530497 秒，Cookie 值与其余属性完全相同；两身份各一次密码。

CSS CookieInteractionHandler 对已勾选 remember 的正常 Cookie Account interaction 使用 BaseCookieStore.refresh 滑动续期，CookieMetadataWriter 输出同值的新到期设置。因此 across Bob 正常请求要求到期时间完全相等并非服务器契约；当前日志尚未按响应采集 Set-Cookie，不能只凭时间差宣称来源已证明。新增被动响应检查将要求 SDK Alice Account 响应不设置账号 Cookie；Bob Cookie 身份 / 值 / 其他属性保持精确相同，到期推进必须对应 Bob 自身的真实合法续期。第五轮失败与私有 trace 保留，第六轮尚待实际验证。


第六轮 remember / Cookie / 双身份原生于 12:56:38.032–12:57:23.655 UTC actual exit 0，3/3 通过，无用例重试。原未勾选用例冷启动仍需密码，已勾选用例冷恢复及仅 Account Cookie 的新授权零新增密码；两个身份分别首次密码一次。双身份链的初次申请前 credential POST 严格为零，活 Alice SDK / 精确私有读取保持；默认 Bob Account 的真实 controls 保持，Alice Cookie-free DPoP 的 index / credential POST / token exchange / Gateway providers 均 200，ATH 与身份 / issuer 精确匹配。SDK 两个相关响应没有账号 Set-Cookie；Bob 五个真实成功响应同值滑动续期，Cookie 值与所有非 expiry 属性完全相同，到期推进有实际 Expires / Date 校正证据。安全记录为候选 .test-data/desktop-account-remember-acceptance-uymBqa/safe-acceptance-v6-summary.json 与 safe-cleanup-v6.json，不宣称跨 reload 双身份或 installed glocal 通过。

同一冻结源码 / static 的候选 NoPublic 于 12:58:00.981–12:58:20.146 UTC actual exit 0，根工作区 NoPublic 工具纠正 v2 于 13:00:45.744–13:01:05.960 UTC actual exit 0，各 1/1。两树均证明 Cloud card 匿名 200 / Cloud issuer与Local storage / owner 精确、启动至结束 canonical TCP 不可达、本机私有 PUT201 / GET200 精确内容、中央 Account / 凭据 / token / providers 200，Cloud 任意 sibling PUT 严格 403 且未创建。密码各一次，初始 pick / Consent 各一次；候选 30 次、根 33 次实际 JavaScript 响应 SHA 分别匹配各自当前 static。根首次门禁 12:59:37.241–12:59:51.338 UTC actual exit 1 仅为 Electron override 路径 ENOENT，尚未执行登录，保留记录并限定修正同一工具引擎启动路径，产品未改变。

上述三个成功门禁所属 Docker / 进程均清理为零，服务端口关闭，私有证据文件 0600 / 目录 0700。NoPublic 安全记录分别是候选 .test-data/managed-local-no-public-route-ASijfX/safe-acceptance-final-summary.json、根 .test-data/managed-local-no-public-route-Edbh9P/safe-acceptance-final-summary.json。这里的 providers 200 不能替代 Models、Chat、Tasks 或原安装资料的验收；最新 Matrix / refresh / 全量 UI 复跑 / 完整集成 / RC / stable 尚待各自证据。


最新冻结 UI 的正式 Matrix 于 13:01:56.115–13:04:17.064 UTC actual exit 0：浏览器 30/30、Electron 9/9，无 flaky / skipped / unexpected、无用例重试。三部署主生命周期各密码一次、初始 Consent 一次、托盘与冷恢复零新增 Consent，原私有写读与冷恢复私有读取真实通过。三部署各两个浏览器复用用例的密码分别 initial=1 / resumed=0 / explicitConsent=0，身份 / storage / 回调 state 与隔离保持；离线退出及延迟 provider 用例通过，但没有独立密码计数附件，不补称这些边界各自已统计密码。安全提取记录为根 .test-data/no-public-route/release-selection/candidate-account-independent-login-matrix-final-safe.json，本轮实际报告是候选 .test-data/login-deployment-results-39767/{browser,desktop}/report.json，私有权限已校正为文件0600 / 目录0700。三 Gateway 端口关闭，runner exited，三个服务 stop 日志完整；其他工作树容器未接管。

最新 refresh 于 13:06:46.778–13:08:41.443 UTC actual exit 0，原3/3，无断言更改：renew在原30s access TTL之后真实 refresh200及精确私有读取；expire的 refreshTTL5s 后实际400 invalid_grant，展示原中文过期提示、主动重新授权 code200并恢复私有读取（该项不宣称已超过原access30s）；idle暂停一次主动刷新计时器，超过原access30s后首次DPoP请求触发恰一次refresh200。各项初始 / 最终私有读取与匿名拒绝通过，密码均一次，111个 static / 源码 / 测试 / 桌面SHA运行前后完全相同，自有进程零 / cleanupfailure零。安全记录为根 .test-data/no-public-route/account-independent-session-refresh-safe-evidence.json；短TTL仍不替代原安装资料的六小时复现。

UI Node全量修正后复跑：候选13:10:04.482–13:12:23.179 UTC actual0，126文件1350测试全部通过；根13:10:04.482–13:12:09.449 UTC actual0，109文件1162测试全部通过。完整 UI lint 两树13:14:02–13:14:11 UTC actual0。另10份Bun原生UI测试，候选24/24 actual0；根初轮21通过 / 2失败的旧参数名及重复模型引用常量仅修测试，13:17:29.657–13:17:30.402 UTC复跑23/23 actual0，对应两个测试的lint actual0。模型引用期望来自权威models包，网络请求仍保持原PUT内容及desired / observed隔离，产品未改变。

标准full基础设施的5432 / 6379 / 9000现由另一工作树desktop-shell-integration的Taskdiag项目使用，本轮不接管或停止它。已有19端口隔离计划正补齐基础设施端口的自动分配 / 项目归属 / 单一派生连接面；完整集成尚未重新执行，不能以以上UI原生结果宣称full、已部署RC / Chat / Tasks / stable通过。

### 2026-10-03 全量集成基础设施隔离（发布前）

本轮准备时，其他工作区正在使用 PostgreSQL 5432、Redis 6379 与对象存储 9000，验收不得复用或清理其项目。全量 runner 现从同一保留集合分配三个基础设施端口和十六个运行时端口，通过私有 Compose ports override 只替换本轮项目的主机映射；运行时与直接数据库测试从本轮映射推导连接。容器内部端口保持原有值。

两棵树的有界端口与 lite runner 回归共 10 项、build:ts、typecheck:test 和 diff 检查均返回 0。真实 Compose config 检查确认仅映射本轮端口；Redis 实现接受 URI 输入。root runner 原有无条件入口曾使 import-only dry-run 误启动自有 xpod-full-test 项目，执行已结束并核实其容器为零；新增 import.meta.main 保护以及 Bun import-only 回归，后者使用拒绝 Docker 操作的私有 stub，证明导入不会启动服务。该误启动不作为正式集成通过证据。

正式 candidate 全量 gate 为 candidate-account-closure-final-20261003-72aeebf7，运行标准 bun run test:integration，不传套件过滤或新增跳过。此节记录启动与基础设施证据；全量结果另行追加。

### 2026-10-03 candidate full integration: actual exit and cleanup

`candidate-account-closure-final-20261003-72aeebf7` ran the standard `bun run test:integration` at UTC 13:35:51.345-13:40:19.913 and exited 0. Runtime compatibility: 5 files, 30 passed. Lite: 33 passed / 4 originally skipped files, 163 passed / 16 originally skipped tests. Full: 8 files and all 63 tests passed, no skips or failures. Independent Cloud identity, Pod quota, full provisioning and managed Pod deletion passed without weakening identity or storage permissions or adding skips.

Cleanup verified zero owned Compose containers (including exited ones), zero run-scoped Bun/Node processes, exited gate child, and no listeners on all nineteen selected ports. The other project's owner had stopped its own infrastructure before port allocation, so this run selected the now-free default host ports; it did not reuse that project's containers or database. Logs and cleanup evidence remain private. This standard suite uses a protocol QLever fixture; the real ABI7 native Local proof, deployed RC Chat/Tasks, and installed desktop are separate evidence layers. The final candidate precommit full rerun will be recorded separately.

### 2026-10-03 root full regression and Bun 1.4.2 packaging closure

The root standard integration gate `root-account-closure-final-20261003-72aeebf7` exited 0 at UTC 13:42:04.738-13:48:48.666. Runtime compatibility: 30 passed. Root's existing lite scope: 32 passed / 3 skipped files, 157 passed / 6 originally skipped tests. Root's existing full scope: 5 files, 46 passed, no failures or skips. Its original target list was preserved rather than replaced with the newer candidate list. Owned containers, processes, networks, volumes and nineteen allocated listeners were all absent after cleanup.

Candidate `test:packages` initially failed because the upgraded compiler required a missing `licenses/javascript/generated/1.4.2/index.json`. The notice validator and product build remained strict. A separate audited 1.4.2 index, five exact source/prefix objects and two corresponding documentation updates fix this material gap; earlier compiler materials remain intact. Root does not contain this newer CLI implementation and received no partial CLI transplant. The original failing notice test and complete CLI suite passed, followed by Lead's standard `bun run test:packages` rerun: gate `candidate-account-independent-packages-tests-final-v2`, actual exit 0, UTC 13:50:57.269-13:51:24.918, 1061 tests across 105 files in the seven packages with test scripts. This is local regression and packaging evidence, not deployed RC Chat/Tasks evidence.

### 2026-10-03 candidate precommit full rerun

Lead reran the unfiltered standard `bun run test:integration`: `candidate-account-closure-precommit-20261003-72aeebf7`, actual exit 0, UTC 13:50:04.154-13:56:30.339. Runtime compatibility: 30 passed. Lite: 33 passed / 4 originally skipped files, 163 passed / 16 originally skipped tests. Full: all 8 files and 63 tests passed, no failures or skips. No product, SDK, UI or static asset source changed between the successful formal runs; only acceptance/spec evidence and the compiler-specific CLI notice materials were added.

Read-only Cookie lifetime review confirmed the current CSS Account TTL is 1,209,600 seconds (14 days), not six hours. With remember enabled, successful Account interactions refresh the server deadline and browser Expires; ordinary Pod traffic does not itself extend this deadline. Without remember, the browser receives a session Cookie and this interaction chain does not refresh it. OIDC AccessToken is 3,600 seconds, RefreshToken and Session are 1,209,600 seconds. An unexpired Account Cookie and standard issuer reauthorization can avoid another password submission after a new document or process; public email hints grant no authority. These are current source/configuration facts, not a claim that the locked legacy installed instance or a literal six-hour idle interval has passed.

Precommit cleanup was independently checked: zero owned containers (including exited containers), networks, volumes and run-scoped processes; gate wrapper and child exited; all nineteen allocated ports had no listeners. The frozen infra source hashes remained unchanged. Private cleanup record: candidate-account-closure-precommit-20261003-72aeebf7-safe-cleanup.json (0600).

User clarification: valid Refresh Token renewal is independent of Account login Cookie. An expired Account Cookie alone must not interrupt a still-refreshable SDK/WebID live session or force password entry. Password entry is required only when a new authorization is necessary and the issuer login cannot be reused; fourteen days is not a unified password-login schedule. The spec now states these independent boundaries explicitly. No product source changed in this documentation clarification.

### 2026-10-03 首轮 RC 失败（禁止提升 stable）

候选 commit `cc08174163d71d5bbbb22e13b0b88078d9649e52` 的 [RC run 37128200393](https://github.com/undefinedsco/xpod/actions/runs/37128200393) 返回 failure。macOS 原生 runtime、Linux Local runtime 和服务镜像步骤通过，但桌面 job 的干净 tarball 消费者在 Bun 1.4.2 导入共享 SDK 时失败；部署 job 在临时外部 RP 关闭阶段返回 `Server is not running`。这两项失败均保留，不创建 stable tag，不跳过门禁。

部署日志确认两套 Account 的 token、Account、bindings 和公开 Profile 请求返回 200；这不能替代随后尚未执行的私有 Pod 隔离断言。关闭夹具先调用 `closeAllConnections()`、后调用 `close(callback)`，Bun 1.4.2 的前者已经停止服务，后者因此报错，并可能覆盖主流程异常。修复仅限夹具关闭顺序及必要的错误保留，认证和隔离断言保持严格。

干净消费者错误已在私有复制树打包的真实 tarball 中连续三次复现：Inrupt 的 CommonJS 入口同步加载 jose 的 Bun/browser ESM 入口失败。目录依赖曾通过，不能代替真实 tarball；根工作区 postinstall 补丁也不能代表下游无脚本安装可用。共享包的交付修复与回归仍在定位，此时不声明 RC、部署 Chat/Tasks 或 stable 通过。原始日志保持私有。

随后两树 RP 关闭修复完成因果回归：旧实现 Bun 1.4.2 为 0/3、Node 为 2/3；新实现两者均 3/3。测试通过真实 keep-alive socket、端口重新绑定、并发和重复关闭，核实连接与监听器已释放；注册 transport 的原始 Error 实例与 HTTP 503 诊断保持。默认 Vitest 入口自动运行同一 Bun/Node 回归，候选对应两文件 6 项、根两文件 13 项通过，两树测试类型与针对性 lint 返回 0。这些是夹具本地回归，不替代尚待重跑的部署 Pod smoke。

SDK 交付修复从原 `index.js` 严格单次替换 session 重导出生成 Bun 根入口；Bun 的 session 子入口指向同一 external CJS 构建产物。其余 ESM 模块、浏览器 / Node / 类型入口保留，避免整包 CJS 内联导致 Context、store 或会话工厂重复。无新增依赖、上游预打包或消费者安装补丁。

私有原型的 25 个公开 JS 入口各冷启动三次，共 75/75；公开导出的名称和类型与 Node ESM 对照一致，31 个跨入口导出引用相同。同步默认工厂与受控 adapter 的初始化、登录、fetch、退出和撤销检查通过，后者不冒充真实 OAuth。正式源码构建后，七个真实 tarball 在干净 Bun 1.4.2 消费者中通过各入口独立冷进程、跨 SDK 入口引用身份以及原完整 imports、NodeNext 类型和 CSS 检查；仍使用 `--ignore-scripts`，七份原 manifest 逐字节恢复。

Lead 再运行标准 `bun run test:packages`，gate `candidate-rc-blockers-packages` 于 UTC 14:50:04.302–14:50:28.612 actual exit 0：105 文件、七个有测试脚本的包共 1,061 项通过。完整集成与后续新 RC 尚待实际结果，首轮 RC 的失败不被这些本地通过覆盖。

源码冻结后的 targeted ESLint（Node / TS recommended，零 warning）、两树 `typecheck:test`、两树 SDK build 与服务端 `build:ts` 均 actual 0。独立只读审阅未发现 P1/P2 阻塞，并在 Bun 1.4.2 验证 `require(root)` 与 `require(session)` 的工厂引用相同；认证 Cookie / refresh 语义未改。

候选首轮标准完整集成 `candidate-rc-blockers-integration-first` 于 UTC 14:48:28.085–14:53:12.910 actual exit 0：runtime 30、lite 163（16 个既有 skip）、full 8 文件 63 项通过。自有容器、网络和卷均为零。根工作树标准完整集成 `root-rc-blockers-integration` 于 UTC 14:54:23.992–15:00:39.208 actual exit 0：runtime 30、lite 157（6 个既有 skip）、原有 full 5 文件 46 项全部通过；不把原工作树的旧 target list 冒充候选 63 项。根自有容器、网络、卷为零，四个实际 Gateway 端口已关闭。

候选提交前第二轮标准完整集成已启动，结果另行追加。这些标准套件仍使用协议 QLever 夹具；真实原生 ABI7、已部署 RC 的 Pod / Chat / Tasks 和原安装资料的桌面复验仍各有独立证据边界。下一 RC 尚未触发，stable tag 尚未创建。

提交前第二轮 `candidate-rc-blockers-integration-precommit` 于 UTC 15:02:28.293–15:09:00.176 actual exit 0：runtime 30、lite 163（16 个既有 skip）、full 8 文件 63 项全部通过，full 无 skip / failure。产品与 SDK 分发源码自首轮完整集成起保持冻结；期间仅追加验收文档。最终核实自有容器、网络、卷为零，四个实际 Gateway 端口关闭。发布修复严格选择 9 个源码 / 测试 / 文档文件，未包含环境文件或私有测试数据；新提交和新 RC 的结果须另行记录，不把旧 RC failure 视为已接受。


### Worker 对比的证据边界（2026-10-03）

本轮 GPT-6.1 Sol worker 给出了 RP 关闭次序的 RED/GREEN 复现、真实 tarball 的 Bun 冷启动消费验证，并拒绝了会拆分 root/subpath 共享 Context 的整包 CJS 方案。当前这类跨认证、SDK 分发与发布验收的任务，Lead 倾向继续使用 Sol；Lead 仍负责独立验收和发布门禁。

没有 DeepSeek 与 Sol 在同题、同环境下的耗时、返工次数、token 和费用对照，因此不能据此给出普遍的质量或效率排名。原生编译、镜像构建和远端 CI 等待时间不计作模型工作速度；用户的“若 429 则 Lead 接手”约定也不是实际发生 429 的证据。

模型选择参考官方 [GPT-6.1 Sol 说明](https://developers.openai.com/api/docs/models/gpt-6.1-sol)，仅用于确认其复杂编码定位与需按实际任务评估取舍，不构成与 DeepSeek 的对比证据。

### Account Cookie 与 Refresh Token 独立能力实测（2026-10-03）

候选 b5bce18112eef6e650a70c59cf51c716c975c676 的独立真实 Local 自身 issuer、Bun 1.4.2、native ABI7、Electron SDK 夹具通过（1/1，0 skip/flaky，runner/Electron/fixture 实际 exit 0）。Account Cookie 经真实服务端 logout 200 失效后，Cookie-only Account 控制保持匿名；同一个已挂载 SDK 对象在原 Access Token 的真实 JWT exp 到期 812ms 后取得一次 refresh_token 200，随后原私有 Pod 读取 200。刷新后 Cookie-only 仍匿名，新增授权请求 0，授权码总数 1、密码 POST 总数 1；无 Token 注入、SDK logout/clear。

证据边界是 Account 服务端退出，而非自然 14 天到期；其他 OIDC Cookie 可能仍在。该结果证明 Account Cookie 失效不等于原活 SDK Refresh Token 失效，不证明原安装版、跨文档令牌持久化或六小时真实等待。源码 HEAD/全部 tracked diff/记录的文件哈希保持不变，夹具数据库及桌面 userData 已清理，原用户进程未变。私有证据：候选工作区 .test-data/refresh-without-account-cookie-oe41pii7/safe-result.json。

### 第二 RC 的 Tasks authority 阻断（2026-10-03）

RC 37132403764（source b5bce18112eef6e650a70c59cf51c716c975c676）Authenticated Pod smoke 通过，随后 Live Gateway 步骤的 runtime/identity、canonical Pod PUT/GET、Gateway 认证、AI Connections、Models 200 和真实 Chat 200 均通过；第一失败发生在任务 approved:prepare 的 POST /api/tasks HTTP 400。验收请求 helper 在读取响应体前抛出，因此没有保留下游安全错误码，不凭步骤名将其记作 Chat 失败。

私有 authority 对比发现 Task resource 读取打到了 Cloud card namespace，其 origin 与已经成功读写的独立 storage root 不同。Cloud 403 是正确边界，不能放宽权限来迁就 Tasks。当前修复切片是权威 storage 发现与上下文传递，拒绝以 WebID 路径截取值作为 Pod 写入 root。approved 失败后的清理通过；rejected/Stop 等未执行项不得算通过。该候选不具备 stable promotion 条件，桌面验收仍独立跟踪。

第二 RC 最终 watch 实际 exit 1。桌面共享包的真实 Bun tarball 门禁已通过（7 packages、25 module/type exports 与 CSS）；随后 root 包 Node consumer 及 packaged authentication 通过，但 Bun 1.4.2 consumer 的旧 CJS probe 断言失败。该 probe 要求 require('jose') 解析至 Node ESM，而现有 patch-jose 契约明确是 bun.import→Node ESM、bun.require→Node CJS；实际 require 解析至 Node CJS 与产品配置一致。修复应更新夹具以精确验证两种入口，保留真实认证探针，不能放宽产品模块边界。桌面真实自更新及最终产物验收未执行，不能记作通过。

### 第三候选修复的本地门禁（2026-10-04）

Tasks / ChatKit 的八个 authority/cache 场景两树全部通过（real drizzle + 受控 transport 单元，非真实 Local 服务器）。既有夹具仅补已知显式 root / DB binding，不改断言；候选 RED 22 fail → GREEN 49 pass，root RED 19 fail → GREEN 46 pass，各 22 个需栈的用例交给完整集成门禁。两树完整 test types 与最终 build:ts 均实际 exit 0；新测试 lint 0，产品推荐规则基线 candidate 58/root 53、既有夹具 UI 配置基线各 93 诊断保持，不冒称全量 lint 零错误。

真实 CAND workspace 打包后，Node 22.21.1 与 exact Bun 1.4.2 的完整 clean consumer 均实际 exit 0，日志均确认原 packaged authentication 与 package-only consumer 通过。新 probe 严格检查 require 为 Node CJS、import 为 Node ESM，两个入口均生成 ES256 密钥并导出 JWK；未改 patch-jose 产品行为。候选版本应用/打包期间的 11 个 manifest/lock 文件逐字节恢复，临时 backup 不存在。

此前私有 staging 验证出现 include-platform 准备遗漏、隐式 bin 文件缺失、链接身份导致重复嵌套，以及 Node 目录内旧 Bun 覆盖 PATH；这些诊断轮不计产品失败或完整通过。Lead 收敛到真正 workspace pack、同目录 Node 22/Bun 1.4.2 和宿主代理后得到权威消费结果。这是本轮可观察的环境复现返工，也说明 worker 的效率不能仅按最终通过或 CI 等待时长排名；仍没有与 DeepSeek 同题同条件的对照。

候选修复后第一轮完整 `bun run test:integration` 实际 exit 0（UTC 16:12:31–16:18:00）：runtime 30/5 files，lite 163/33 files 与原有 16 tests/4 files skip，full 63/8 files 全通过。原先单独收集时跳过的 ChatKit 集成用例在标准完整栈执行；自有 Compose containers/networks/volumes 均 0，5737/5739/6300/6400 的 IPv4/IPv6 检查均无监听。标准完整套件的 fake QLever 不能替代真实 ABI7、远端 Chat/Tasks 或原安装桌面。Root 完整回归与候选提交前复跑继续由 Lead 执行，新 RC 尚待创建，不具备 stable promotion 凭证。

### 第三候选独立复核与使用中到期补验（2026-10-04，进行中）

独立只读复核发现一个 P2：真实 storage root 修正后，TaskMaterializer、RunStateCenter 和 ManagedRunWorker 仍用 Cloud WebID 截取 Run/Task/Thread 关联；RunStep 原样保存旧 Cloud run IRI，而读取按 Local storage IRI 查询，导致跨 origin 步骤历史无法返回。此前八项 authority 单元与完整集成通过不覆盖该场景，不能据此发布。修复须统一已验证 storage binding，并补生产者到 RDF 写后读回归；当前尚未记为通过。

用户新增要求持续使用和无人值守跨令牌到期。已有桌面 SDK 短 TTL 与 Account logout 后刷新通过，后台客户端凭据仍须分别验证。只读发现 OwnerPodAccess 的缓存 fetch 固定最初 token，401 后只使工厂缓存失效，原 fetch 不会取新 session；真实短 TTL GET 对照与最小修复正在执行。此处服务端使用 client_credentials，不能记作浏览器 refresh_token。并发续期、撤销、迟到 401 与写请求不盲重放也须独立回归。进行中长流尚无通过证据。

上述追加修复前，Root 标准完整集成于 UTC 17:01:49.781–17:13:51.328 actual exit 0：runtime 30，lite 157 与原有 6 skip，full 5 文件 46 项全通过。自有 Compose containers/networks/volumes 均为零，四个 Gateway 端口 IPv4/IPv6 无监听。此结果只记录当时源码，不覆盖随后 RunStep 或后台续期修复；新源码须重新完成标准完整集成与提交前复跑。

任务授权上下文切换不得继承调用者的 credential-bound DB/fetch 缓存。只验证 OwnerPodAccess 显式 taskCredential 分支，不证明真实 Tasks 链仍保留了 grant ref/version；TaskAuthBinding 的授权传递与缓存边界也纳入修复和回归，暂不记录全任务撤销或无人值守通过。

### ORM 边界修正的本地门禁（2026-10-04）

架构复审要求停止在业务层组装 Cloud/Local 存储 URL。修正后业务服务（TaskService、TaskHandler、TaskMaterializer、RunStateCenter、ManagedRunWorker）只传不透明 base-relative 资源 ID 与关系；`PodChatKitStore` 作为唯一拥有 `podUrl` 的适配器，读回时用 ORM 的 `parsePodResourceRef` 把本 Pod 关系还原成同样 ID，外部绝对 IRI 原样保留；`appendRunStep` 对显式绝对 `run` 仅接受等于本 Pod 当前 Run 的值，否则拒绝。已用真实安装版 drizzle-solid 探针验证：base-relative 关系按 `podUrl` 解析为 `${podUrl}/.data/...`，绝对外来链接不被重绑，`buildPodResourceIriForDatabase` 与 WebID 无关。结论是业务侧地址假设而非 ORM 能力缺口，未新增 issue/绕过/schema 分叉。

候选两树 `typecheck:test` 与源 `build:ts` 实际 exit 0。候选受影响子集（tests/api + tests/service + tests/ai + ChatKit Pod 集成）实际 171 文件通过、1861 通过 / 29 既有 skip；root 受影响子集 6 文件 54 通过、广义子集 149 文件 1654 通过 / 7 skip。跨 origin 场景以 `RunStepStorageAuthority`（3 个真实 RDF 序列化生产者写后读）、`PodChatKitStore.storageAuthority`（真实 drizzle 写 Local、拒绝多 root 与未绑定）、`TaskHandler.service`（opaque ID 的 create→run→selection/list/Stop）、`RunRelations`（外来链接保持）覆盖。修正 `TaskAuthBinding` 在凭据切换时清理真实存在的 `_threadSurfaceIdCache` / `_threadMetadataCache`，并在 `openDb` 转发 `taskCredential` ref/version 且以 `_cachedAuth` 防止跨凭据复用旧 DB/fetch。

候选全量单元 `vitest --run` 实际 8 文件 14 项失败、795 文件 8050 项通过；14 项失败文件均为 UI/runtime/依赖状态/agent-directory/inrupt patch，未 import 本次任何改动模块，属既有环境基线，不计作本次回归、也不能据此宣称全量绿。

标准完整 `bun run test:integration`、真实已部署 RC 的 Tasks approved/rejected/Stop、真实原生 ABI7、已安装桌面与 stable promotion 仍各自独立，尚未在本轮取得通过证据。历史 RC 37128200393 与 37132403764 的失败保持原样，不追认为通过；新 RC 尚未创建。
