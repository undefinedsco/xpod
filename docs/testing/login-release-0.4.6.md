# 0.4.6 登录候选验收

状态：候选构建、登录回归、两轮完整集成、三模式浏览器/桌面与安装包认证检查已通过。尚无本次 RC acceptance，不得提升 stable tag。

## 范围

候选基于 `92fc7d5bf7f158096fb1e259053e1f8229f144d3`，包含 0.4.5 后的 32 个既有提交，以及从共享开发工作区审查后抽取的登录改动。

纳入 Account / WebID 独立权威、scoped interaction、记住账号/应用、SDK 恢复及多标签页隔离、Applet session 投影、错误后的重试/返回/取消、桌面窗口与会话生命周期、Bun 1.3.12 完整 HTTP 响应修复。

开发中的通知、Pod collections、AI 业务及 models 版本升级未进入本次源码抽取；候选保留基线依赖版本。四套 UI 与依赖锁必须由候选源码重新生成。

## 证据边界

[9 月 15 日审计](login-audit-2026-09-15.md)、[覆盖矩阵](login-coverage-and-modularity.md)和[交互恢复记录](login-interaction-recovery.md)包含共享开发工作区的历史结果；覆盖矩阵后续新增的账号隔离行已单独标明候选复验。必须逐项区分来源，不能直接把历史结果当作拆分候选的验收。原审计提到的新增 WebSocket relay 修复也不在本次候选内。

候选必须重新通过源码构建、登录回归、两轮完整集成、三模式浏览器/桌面以及发布工作流门禁。线上验收由新的 exact SHA 与 image digest 记录，旧 0.4.5 acceptance 不适用。

## 候选本地验收（2026-09-16）

下表均在隔离的 `release/0.4.6` 工作树运行，使用 Bun 1.3.12。日志位于开发工作区 `.test-data/login-audit-20260915/release-preparation/`；交互恢复的日志位于 `.test-data/release-preparation/`。这些本地日志不随包发布，线上凭证仍以 CI acceptance artifact 为准。

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
