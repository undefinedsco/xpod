# 0.4.6 登录候选验收

状态：首个 RC 的凭据兼容失败已在本地修复；9 月 18 日纳入登录存储与鉴权修正后，两轮完整集成通过。仍须由新提交取得 RC acceptance，尚未提升 stable。

## 范围

候选基于 `92fc7d5bf7f158096fb1e259053e1f8229f144d3`，包含 0.4.5 后的 32 个既有提交，以及从共享开发工作区审查后抽取的登录改动。

纳入 Account / WebID 独立权威、scoped interaction、记住账号/应用、SDK 恢复及多标签页隔离、Applet session 投影、错误后的重试/返回/取消、桌面窗口与会话生命周期、Bun 1.3.12 完整 HTTP 响应修复。

开发中的通知、Pod collections、AI 业务及后续 models 整包升级未进入本次源码抽取。RC 发现基线 root models 0.2.55 与 UI 0.2.53 的兼容缺口后，UI 对齐 0.2.55，并回迁共享模型的最小兼容修复；没有引入开发树的其他模型变化。四套 UI 与依赖锁必须由候选源码重新生成。

## 证据边界

[9 月 15 日审计](login-audit-2026-09-15.md)、[覆盖矩阵](login-coverage-and-modularity.md)和[交互恢复记录](login-interaction-recovery.md)包含共享开发工作区的历史结果；覆盖矩阵后续新增的账号隔离行已单独标明候选复验。必须逐项区分来源，不能直接把历史结果当作拆分候选的验收。原审计提到的新增 WebSocket relay 修复也不在本次候选内。

候选必须重新通过源码构建、登录回归、两轮完整集成、三模式浏览器/桌面以及发布工作流门禁。线上验收由新的 exact SHA 与 image digest 记录，旧 0.4.5 acceptance 不适用。

## 候选本地验收（2026-09-16）

下表为首个候选 `e759a9b331ac218a6b5b416e2bfbfe695d063ba8` 的本地证据，均在隔离的 `release/0.4.6` 工作树运行，使用 Bun 1.3.12。日志位于开发工作区 `.test-data/login-audit-20260915/release-preparation/`；交互恢复的日志位于 `.test-data/release-preparation/`。这些本地日志不随包发布，线上凭证仍以 CI acceptance artifact 为准。后续修复的复验单独记录，不能沿用此表声称新提交通过。

| 检查 | 结果 | 证据 |
| --- | --- | --- |
| 干净依赖安装与完整构建 | 工作区包、根 TypeScript、Components 定义、四套 UI 全部通过 | `install-corrected-patch.log`、`build-ordered.log` |
| 桌面模块 | 140/140；构建与范围内 lint 通过 | `candidate-desktop-test.log`、`candidate-desktop-build.log`、`candidate-desktop-lint.log` |
| UI 单元检查 | 首轮 68 文件，691 通过、4 失败、1 跳过、1 todo；4 个失败均已定向复验关闭，生产 TypeScript 与范围内 lint 通过 | `candidate-ui-tests.log` 及定向复验日志；未把定向复验表述为整套重跑 |
| 原有真实浏览器登录组合 | 51/51，零重试；跨源 3、外部 applet 5、真实 Pod 5、共享登录 38 | `candidate-original51.log` |
| 新增交互恢复与账号隔离 | 浏览器 7/7，Electron 1/1；原生取消、返回 App、两种窗口尺寸保留严格断言 | `candidate-recovery-browser-corrected-patch.log`、`candidate-recovery-electron-explicit-quit.log` |
| 完整集成，第 3、4 轮 | 两轮各 Lite 151 通过、6 跳过；Full 45/45 | `candidate-integration-3.log`、`candidate-integration-4.log` |
| Cloud / managed Local / Standalone | 独占验收一轮浏览器 6/6、桌面 3/3，退出码 0；各模式真实注册、Pod 读写、退出与恢复 | `candidate-mode-matrix-exclusive.log`；候选 `.test-data/login-deployment-results-44243/{browser,desktop}/report.json` |
| 发布规则与 workflow lint | 打包修复后的联合门禁 99/99，workflow lint 退出 0 | `release-gates-final-serial.log`、`workflow-lint.log` |
| 干净消费者安装与认证补丁 | 同一 tgz 在 Node 24.19.0、Bun 1.3.12 `--no-install` 下通过行为 probe；打包测试 11/11 | 候选 `.test-data/pack-auth-regression/`；29 个内置包，压缩 15,789,493 字节，原生二进制扫描为 0 |

Account B 与 WebID A 的用例证明的是会话权威及权限隔离：跨标签页切换 Account 后，既有 WebID 会话可保持有效；B 不能选择或读取 A 的私有 Pod。它不声明产品支持混合身份业务；正式“切换账号”仍需清理旧 WebID/Pod 会话。

该隔离用例限定同 issuer、同浏览器 context 的跨标签页变化；管理侧断言检查 B 专属 controls 和 B 的 Cookie 不能读取 A 的私有 Pod，没有逐一审计所有管理 API。断网用例覆盖已加载页面的失败与恢复，不代表完全离线冷启动或离线续期。真实 token 过期、刷新和断网是独立专项，没有执行这些维度与三种部署模式的全排列。

三模式首轮浏览器 6/6 通过，桌面 Cloud 通过；Managed Local 在业务断言通过后触发严格 20 秒退出等待失败，Standalone 未执行。测试补充主进程退出事件、子进程退出与私有 stderr 诊断，保持产品、超时及业务断言不变；独占运行的一轮浏览器 6/6、桌面 3/3 全部通过。初轮退出等待异常未稳定复现，不能宣称已修复某个桌面产品缺陷。

最后一轮三模式均自动恢复，密码提交各一次；六次 Electron 子进程退出均为 `code=0, signal=null`。报告无重试或跳过，本轮服务、容器与 runtime 临时目录已清理。追加诊断后的测试通过范围内严格类型检查和 lint。

联合发布门禁第一次并发运行有 2 个 CLI 子进程在 30 秒内未完成；保持原断言和超时，单 worker 运行 99/99 通过。三模式退出诊断的第二轮在 Cloud 注册阶段出现账号锁超时，未到达桌面；该轮也保留为失败证据。

本地 tgz smoke 移除了平台 optional dependencies，因此只证明 JavaScript 安装及认证补丁。平台包安装、原生 QLever、未签名桌面分发和同一镜像 digest 的三模式验收仍由 RC/stable 发布门禁独立证明。

三模式矩阵检查基础登录生命周期；外部 applet、账号漂移及共享登录负例并未逐模式重跑。记住账号 Cookie 属性与桌面重启也不承诺所有浏览器的 session restore 策略一致。真实 SMTP 投递、所有操作系统与浏览器、CLI OAuth 跨进程恢复不在本次本地登录验收内；真实 AI Chat 由 RC canary 单独验收。

生产 `co` 的自动部署门禁覆盖公开页面、匿名拒绝、运行 digest 与健康状态；它不自动证明浏览器登录、恢复、切换和退出。稳定版本部署后须以明确指向生产的 UI/API/issuer 地址另行进行认证验收，不能把 localhost API 结果标为生产结果。

## 干净安装发现并关闭的问题

- 服务编译依赖工作区构建产物，调整根构建与 Docker 构建顺序为工作区包先行。
- Docker 构建上下文补齐 Inrupt cleanup postinstall 脚本，并用声明脚本契约检查 COPY 与 `.dockerignore`。
- 从官方 CSS 8.0.0-alpha.1 原文件重新生成补丁，纠正 interaction URL 的 hunk 位置；强制重新安装后核对整个目标文件和真实路由行为。
- npm 产物受控内置已打补丁的认证包及关键调用者，保留版本冲突所需的纯 JavaScript 嵌套依赖；其他依赖由安装器处理。打包失败时恢复源 manifest。
- Electron 交互恢复测试改用真实原生 Quit 与严格子进程退出断言，避免 Playwright context 关闭阶段掩盖已经完成的交互断言。

完整集成早期失败记录保留：一次默认 Docker project 引用了过期容器；一次高负载运行有 3 个 Cloud Pod 创建锁超时。后续两轮使用独立 project、原有超时及断言通过；没有将锁超时归因于 CSS 补丁，也没有放宽门限。

## RC 发现的历史凭据兼容问题

[首个 RC 35020630219](https://github.com/undefinedsco/xpod/actions/runs/35020630219) 在 `Exercise the Gateway credential path against the exact image` 失败：UI 写入及密钥回读成功，但 Gateway 的 `credentialResource` 查询返回零条。原生 runtime 构建、conformance 和桌面产物通过，不构成服务镜像整体接受。

models 0.2.55 新增必需的 `dc:created` 查询字段，0.2.53 的凭据没有该三元组，因此被新版查询过滤。仅对齐新 UI 的版本不能修复既有数据。修复在 models 权威 schema 中保留创建时间的写入默认值，将读取字段设为可空，再通过候选既有依赖补丁回迁；不添加 Xpod 私有 schema，也不修改用户已有凭据。

回归保留原失败断言，并通过真实 Pod PATCH 构造缺少 `dc:created` 的历史记录，要求 UI、Gateway 模型查询和生产 repository 均能读取同一凭据与密钥。安装包探针另检查消费者实际加载的模型具有可空读取、创建默认值和 OPTIONAL 查询，防止打包遗漏补丁。

## 9 月 18 日修订与复验

对共享开发树的新改动再次逐文件比较：Account、WebID、Consent、Callback、Applet 登录与桌面登录代码和候选一致。新增纳入如下独立修复：

- Cloud AccountStorage 在 Drizzle 存储上增加最后登录方式删除保护，兼容合法的无密码 SP 账户。
- Drizzle 存储使用自身生成的 ID，缺失行更新返回 404，字段更新由单条 SQL 完成。
- 未知节点或节点查询异常认证失败；管理读取和 DDNS 管理入口使用既有管理员规则及 Gateway 签名。
- DDNS service 修改操作要求既有 `network:write`；节点仅能修改明确归属自身的记录，无主记录不开放接管。
- WebID/issuer 缓存增加 15 分钟 TTL 和每类 1000 条上限；过期后抓取失败不会返回旧信任。TTL 内不承诺即时撤销。
- 依赖检查按补丁声明位置识别合法重复别名；发现漂移时拒绝猜测性修改依赖文件。

开发树 Pod 查询优化发现的四项历史兼容回归已在开发树修复，定向 29/29 与生产类型检查通过。该查询性能改动及 db/AccountRole 下推没有迁入候选；候选保留原有完整查询语义。

| 检查 | 修订后结果 | 证据 |
| --- | --- | --- |
| 旧凭据兼容 | 原始失败及统一 UI 后的旧数据失败均复现；修复后真实 QLever 1/1、UI store 21/21、models 2/2 与模型构建通过 | 候选 `.test-data/credential-release-repair/` |
| UI 完整组合 | 68/68 文件，695 通过、1 跳过、1 todo；生产 UI 类型检查通过 | `candidate-ui-post-credential.*.log` |
| 登录存储保护 | 28 项定向回归通过；真实 CSS HTTP 拒绝删除唯一密码且保留登录能力，允许删除第二密码，无密码账户可创建 Pod | `guard-storage-*.log`；HTTP 使用 Cloud AccountStorage 配置及隔离 SQLite，不冒称完整 PG Cloud |
| Token 缓存 | 18 项缓存及 13 项既有 extractor 测试通过，含真实 ES256 新旧密钥验签；严格类型与范围内 lint 通过 | 候选 `.test-data/token-cache-regression/green-node24.log` |
| API 与打包回归 | 联合 78 项中 75 项通过；3 项 Gateway 测试仍断言旧的公开读取行为，更新为拒绝读取及无数据泄露后 7/7 通过 | `auth-review-final.log`、`admin-proxy-green.log`，位于候选兼容修复目录 |
| 完整集成第 5、6 轮 | 两轮均 Lite 151 通过/6 跳过、Full 45/45，退出 0；固定 Bun 1.3.12 与 Node 24.19.0，未修改超时或断言，夹具已清理 | `candidate-integration-{5,6}.{log,json}` |

曾用 UI 的 ESLint 配置额外检查服务端旧文件，报告 26 项 `any`、未使用参数及空接口风格诊断，未将其写成服务端全量 lint 通过。服务端生产构建、上述范围内类型检查和实际行为回归分别记录。

最终安装包在仓库外以 Bun 全新安装，包内认证与历史凭据探针分别在 Bun 1.3.12、Node 24.19.0 通过；本轮发布门禁 13 个文件、99/99 通过。证据为候选 `.test-data/credential-release-repair/final-consumer-20260918.log`、`final-consumer-node24-20260918.log`、`final-release-gates-20260918.log`。平台 optional dependencies 仍由 RC/stable 原生门禁独立验收。

## 第二次 RC 的验收脚本漂移

[RC 35307202779](https://github.com/undefinedsco/xpod/actions/runs/35307202779) 针对 `709c26ae`：SDK、macOS runtime、桌面、主服务镜像、真实镜像旧凭据门禁、部署及认证 Pod smoke 均通过。live canary 已完成实际 Local runtime、CSS client credentials 登录及私有 Pod PUT/GET，但调用已删除的 `client.revealGatewayKey()` 时失败。失败清理完成凭据撤销、注册移除及拒绝重放；Models/Chat 未执行，无统一 acceptance artifact，未提升 stable。

Gateway key 的现行契约是仅创建时返回一次明文，列表只返回元数据。旧 canary 的明文回读期待与该契约冲突，其字符串测试也错误地要求保留旧调用；修正范围限定为验收脚本与回归检查，产品 API 保持现有一次性返回语义。

修订新增真实 TypeScript 入口检查，先复现不存在的 reveal 方法及未收窄的 credential version 两项错误，再验证入口诊断为 0；脚本回归 13/13、联合发布门禁 14 文件 112/112 通过。列表脱敏检查使用同一登录会话的原始 HTTP 响应，避免 SDK 规范化丢弃意外秘密字段后掩盖泄漏。创建时 wrapper 相等断言、活跃认证、完整撤销与撤销后 401、Models 非空及 Chat 精确响应要求均保留。证据见候选 `.test-data/canary-contract-repair/`。

脚本修复后的第 7 轮完整集成通过（Lite 151/6 跳过，Full 45/45）。第 8 轮 Lite 在 ChatKit 测试夹具绑定端口时出现 `EADDRINUSE`，148 项通过、6 跳过，3 项未执行，Full 未启动。夹具先在 loopback 探测空闲端口并关闭，再让 ApiServer 重新绑定 wildcard 地址，存在释放后重绑定竞态；当前端口已释放，日志不足以识别当时的占用者。修复限定测试夹具直接监听 loopback 的系统分配端口，再从已启动 server 读取端口，产品、断言与超时保持不变。

夹具修订后定向 3/3 通过，第 9、10 轮完整集成均退出 0：每轮 Lite 151 通过/6 跳过、Full 45/45；自有容器与卷已清理。证据为开发树发布准备目录 `candidate-integration-{9,10}.{log,json}`，第 8 轮失败记录保留。
