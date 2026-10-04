# 桌面外壳与 applet 发布审计（2026-10-02）

依据：`docs/superpowers/specs/2026-10-01-xpod-desktop-shell-and-applets-design.md`、画板归档 README 与 `docs/RELEASE.md`。实施分支 `codex/desktop-shell-applets`，原目标版本 0.4.21；并行目录功能已占用该候选分支，已在独立 worktree 完成集成，桌面目标为 0.4.22；其他版本分支不属于本次发布范围。本文件记录当前证据，不作为未完成门禁的通过凭证。

## 当前发布状态（2026-10-04）

提交前验收快照（2026-10-04）：基线传输修复为 `d8ea0ad4bc999fdd59741ceb5848de15bb5403df`，正常 rc.245（run `37179579152` attempt 1）在 Task `approved:decision` 失败；finalize skipped，无 accepted manifest。旧 PR CI 成功使用合并树，不能作为当前工作树的源码验收。原 native/image/desktop job 通过不替代实际 artifact 字节验收。本轮包含固定 allowlist failureDetails、订阅模型 adapter、Task host id 与浏览器 host 初始化变更；相应回归分别 60、83、25、47 tests 通过，发布相关 10 suites/104 tests、`bun run build:ts`、`bun run typecheck:test`、actionlint 已通过。诊断变更 lint 的 24 项为既有、新增 0，不能称全库 lint 零错误。当前新源码完整标准集成已退出 0，旧提交通过仍不能替代本轮证据。新候选需绑定本轮提交 SHA，stable 仅在该候选获得完整 accepted manifest 后提升；本快照不预先宣称候选或 stable 通过。

当前基础门禁使用独立 Alpine/Lima VZ、Docker socket 与 `xpod-sol-alpine-final-20261004` compose project；原三镜像、原 compose、runner、scope 与预算均未修改。前轮 UTC 11:25:54–11:36:10 标准集成退出 0（lite 506.06 秒、full 57.08 秒）仍按原 hash 留存，当时实际继承默认只读 home mount；“无 host mount”的早期声明已纠正。后续用官方 `limactl edit --mount-none` 移除该挂载，实际 mount count 0。原 compose 的 `scripts/init-postgres.sql` bind source 在 guest 缺失时被创建成目录，导致 owned PostgreSQL 首次 prep exit 1（固定类别 `Is a directory`）；这是环境恢复问题，测试尚未启动。只复制同 hash 原 SQL 到私有 guest 对应路径后，真实 pg_isready、Redis ping/SET EX、host TCP 与原 authenticated object-store probe 全部通过，无 host mount、无复制用户 home/钥匙/整项目。

最终 Storage ETag 源码快照上的标准 `VITEST_MAX_FORKS=1 VITEST_MIN_FORKS=1 bun run test:integration` 于 UTC 12:00:21 启动、12:10:54 退出 0，使用已有 `XPOD_FULL_PROJECT`、`XPOD_FULL_USE_EXISTING_INFRA=true` 和独立 `DOCKER_HOST`。lite 32 files/162 tests 通过，4 files/16 tests 按原规则跳过，529.36 秒；full 7 files/62 tests 通过、无跳过，54.26 秒。2415 个产品 hash 开始/结束一致，含 helper EOF 规范化、浏览器初始化源/测试及后端三文件；审计/并发静态构建产物单独绑定。后端 SHA-256：handler `212b211bb17ab731adbf5d2b1488704a495716769580c1a88e8ef56489836998`、handler test `696c42943004fd688a161192017115381723b720a652f71ad1a097161ce17e6c`、legacy test `f27f5682cad6cd908fea8c1fa61aa2390e8a3750ba5f807d6e870ae3288ff0b3`。最低宿主余量 2660716544 bytes，1 GiB 守护未触发；exact owned compose `down -v` 退出 0，VM/镜像保留。私有 `storage-etag-standard-integration-terminal.json` 与独立 before/after hash 回执绑定结果，旧 PASS 不覆盖为新源码结果。

真实冷 Browser 的同 TTL HTTP 500/multiple ETag terms 在正常 source-bound restart 后仍复现，不能归因旧内存。真实 CSS GET/HEAD + BasicConditions 回归修前两项失败；新修复在生成响应 ETag 时规范化 metadata，避免 conditional 304 合并 raw revision 与 rendered tag，persisted revision/CAS 不变。相关三套件 19 tests、build、测试类型检查、变更三文件 lint 通过。修前 RED 与旧 500 证据保留。此前把历史 2.72 GiB 当作三镜像独占大小的推断已撤回；公开 arm64 manifest 压缩层合计 202934002 bytes，与实际解压占用不同。

当前修复后 source/dist 绑定的 owned runtime 首次普通浏览器读取成功，未先用 Node 请求暖缓存：同 TTL 200/一个 wire ETag，Inbox 审批卡、canonical Run、owner/Pod、有效 grant 均命中。用户流程实际点击一次“只这一次”，没有后台 CAS 或再次 resume；后续独立只读证明原 Run completed/无 error、Approval approved/decision owner 命中、原 Session completed/owner 命中、marker 200 且内容精确匹配。最初 terminal 轮询的 TimeoutError 与更早读取失败保留，不升级原完整 Task helper 为通过。Task 详情与 A6/A7 剩余 UI 验收仍待收齐；三 Task API 的初始 service_access_missing 403 已观察到新 managed credential 重试 200，不能把旧短窗口缺卡直接归为权限声明缺口。订阅模型目录需要发布后执行“同步模型”再验当前实际列表，adapter tests/build 通过不能代替订阅 Models 实例 PASS。

- 唯一交付工作区为 `desktop-shell-integration/xpod`，实施分支 `codex/desktop-shell-applets`。该候选提交前基线 HEAD 为 `1cafd7fa8443b99a43367bf32ec7a2b927d38400`；本轮 Local invocation transport 修复进入 candidate-only 提交冻结；这不是 stable green freeze。下面较早日期的提交、测试和上游状态均为历史证据，不能代替本轮源码验收。
- 正常 candidate `37151032339` 的 attempt 1/2 均失败于真实 Gateway Task approval，model receipt 为 `pi_assistant_error`、SDK connection hint；finalize skipped，没有 accepted manifest。attempt 2 的实际启动已使用 public cssBaseUrl/publicUrl/canonical，不能将 standalone 的 `0.0.0.0` 静态推导当作该正常候选根因，也不能宣称已证实全部 CI 失败的唯一原因。需要新提交经正常 release branch push 生成新候选，不重跑旧 SHA。
- Local in-process 模型调用现使用既有 API listener 的 host/port 作为 wire target，复用 `localServiceUrl`；JWT audience/issuer 保留 canonical realm，Cloud public transport 不变，无新增配置。产品文件 SHA-256 为 `4e891ca03c0cd06275fd81a3128ef768049bab4fa62b414e542e84cbacd2bb9a`，新测试为 `f57de1afb201e03736a07adb4e58c214fd6c16d85bf369398887a097efd06524`。
- 真 SDK/SSE 回归先 RED（旧产品代码发生真实 ECONNREFUSED）后 GREEN（8 项）；相关 13 文件/104 项、服务构建和测试类型检查通过。独立产品审查 PASS；测试 finally 清理和 conservative guard 用例已补齐。该 owned listener 是协议 fixture，不能称为真实 Gateway/Cloud 端到端验收。
- 用户最新明确指定 `gpt-6.1-sol` 接替 B；旧“仅真实 provider 429 才切 Sol”规则已撤销。传输修复 d8ea 的提交集合仅为本审计、`src/api/container/common.ts` 与 `tests/api/container/common-ai-invocation-transport.test.ts` 三文件，旧四文件冻结和旧诊断候选策略已被后续提交与本状态取代。
- 最终标准单测 `VITEST_MAX_FORKS=1 VITEST_MIN_FORKS=1 bun run test` 退出 0，耗时 3094.28 秒：768 suites 通过、44 跳过（812）；7624 tests 通过、309 跳过、1 todo（7934），无失败，dependency-state pretest 通过。common 与最终 test hash 在开始/结束一致；变更文件 lint、`bun run typecheck:test`、`bun run build:ts`、8 case transport 回归及独立 review 已通过；不宣称全库 lint 零错误。最初四处 timeout 本轮均通过，初次 FAIL 回执继续保留；本轮通过不证明最初超时原因。依据私有 `sol-transport-serial-unit.json/md`。
- 原标准 `VITEST_MAX_FORKS=1 VITEST_MIN_FORKS=1 bun run test:integration` 完整退出 0：lite 32 文件/162 项通过、4 文件/16 项按原规则跳过，561.33 秒；full 7 文件/62 项通过、无跳过，99.52 秒。common/test 开始结束哈希一致，原 scope/排除/隔离/预算不变；runner 与专属 infra 正常清理，首次并发 FAIL 记录保留。依据私有 `sol-desktop-integration.json/md`，不冒称用户生产实例验收。
- 视觉有 47 张有效截图，root 直接复核其中 3 张。实际 `cd ui && bun run build:dashboard` 退出 0，前后 tracked UI source 相同，dashboard bundle 为 `b91b78724e9e241d133455ecf861f4dd0236bd6014f8a8b61046ef6bbb3d4d3a`。fresh owned Gateway 的四层 AI 验收成功，`linx`/`linx-lite` 真实 Chat 均 200 且内容有效。首轮标准 Task helper 在 approved checkpoint 抛原生 exception，原因未知；实际 Run waiting_input/pendingApproval、Session paused、owner 与 marker 404 已证明，不能称完整 Task PASS。旧 grant 清理撤销后，该 Run 经官方 Stop 200，Run cancelled、Session completed，marker 404；首 helper FAIL 保留。新的 private observed 标准案例、有效 grant 期间真实 UI pending 卡/A6/A7/Inbox 正在验收，完整 UI/Task 尚未通过。
- 两轮 ENOSPC 与空间波动原因未知；自有 VM 释放 2.72 GiB 后，UTC 05:15:27 私有 64 KiB write/fsync/delete 通过、可用约 5.89 GiB。不扩大其他目录调查，下载大 artifact 前需重新核可用空间。
- 单测与完整集成通过且产品已冻结，正常候选远端构建可与剩余本地 UI 验收独立并行，因此先执行 candidate-only 提交/普通推送。若本地后续发现产品 bug，须修复后新 SHA 重新验收。正式 tag 必须等待新候选 19 项 accepted manifest、实际产物字节核验和 root 当前 UI/Task 最终证据；stable/production/正式 App 更新尚未授权执行。草稿 PR #28 保留草稿状态。
- 精确清理已证明三个自有 Pod 删除；三个不同 parent 账户缺少精确 signup receipt 来源绑定，保留账户以避免误删，不能宣称全部账户/凭据已清理。不扩大调查或读取真实 profile。新的视觉夹具须有完整 signup receipt、仅使用私有 runtimeRoot，并以销毁完整 owned runtime 验证清理。
- 正式 stable 与 `/Applications/Xpod.app` 仍为 0.4.20。尚未发布 0.4.22；历史临时 updater 演练不等于正式应用更新。
- 发布顺序为最终冻结与显式暂存/Lore commit → 新 exact SHA 正常 candidate → 19 项统一 accepted manifest（16 service + qlever-local + package-consumers + desktop）及实际产物字节验证 → exact SHA stable tag。stable 先 stable-staging/消费者/latest，再 retag accepted 服务 digest、生产健康/回滚门禁；macOS 使用 exact stable source 打包并复用 accepted native runtime，生成 stable ZIP/feed 后发布 GH Release。candidate RC ZIP 与 stable ZIP 是不同版本产物，不能声称字节相同。正式应用更新后还须检查版本、图标和账号保留。

## 功能归位

### 2026-10-03 历史候选失败与修复检查点（当前终态见文首）

- 本轮修复提交前的 feature HEAD 与远端为 `85684934`；`release/0.4.22` 仍为 `ab583de4`，草稿 PR #28 随 feature 更新。尚无通过的最终候选，stable、npm latest、生产部署与已安装桌面更新均未执行。
- 真实 Ubuntu CI `37083649836` 已验证 rg 59+7 项及后台授权 14 项通过；lite/full、Bun runtime 和 18 个 package-smoke job 通过。全量 unit 仍有 `gateway-locator-secret` 的真实多进程首次读取断言失败。负载探针复现了一个空 stdout 摘要与完整摘要并存，落盘摘要一致；helper 在 `exit` 上读取尚未排空的 stdout。Sol 已完成确定性 `exit`→stdout→`close` 回归：旧 helper 返回 32/64 字符，修复后完整读取；21 项相邻回归、10 轮共 120 个真实进程、类型与 lint 通过，每个摘要都校验为 64 hex 并与落盘 SHA 一致。没有修改生产密钥逻辑，真实 Ubuntu 重跑待后续提交。
- 候选 `37081326630`（`0.4.22-rc.228`）的 AI 窄屏已通过，但 Pod/device 的旧路由与列表头断言失败，另有嵌入文档树 HTTP 403 阻止桌面构建。文档下载现只向精确 `https://api.github.com` origin 发送 CI `GH_TOKEN`，带凭据时拒绝重定向；raw/archive 路径、源码 pin 和既有超时预算不变。403 的具体成因没有响应头证据，匿名限流仅为推断。13 项下载、来源与凭据边界回归通过，真实候选构建待复验。
- 窄屏 SubjectWorkspace 的当前路由链接选择不会触发导航变更，之前会留下打开的抽屉和 inert 主区；列表现通过已有 SDK `openMain` 关闭宿主抽屉。device、Pod、settings 的当前链接回归已先失败后通过，三目标 UI 构建、UI lint 与测试类型检查退出码 0。B 的四个模块 390 宽实际 Chromium 自动关闭合同已通过；用户随后要求切换为 GPT-6.1 Sol，Sol 的 fresh Node/Chromium 四模块 × 1440/390 共八项已通过，含真实 OIDC、当前路线键盘选择、自动关闭、主区非 inert、焦点恢复和无溢出。原本地几何两项也通过，一项焦点测试在 OIDC 阶段超时、另一个 Bun probe 启动超时；单独焦点复验随后通过，未增加时间预算。两个 B 进程已终止于 API 连接失败（不是 429）；不能以测试手动关闭抽屉代替产品行为。
- 完整回归首次暴露旧静态 harness 仍要求 RC 测试旧分支、标签和路径；Sol 已在实际第 487 行复现 RED，再对齐现有声明式选择和 canonical route，保留会话、认证隔离、无本地 fixture 与严格抽屉合同，整文件 29 项和测试类型检查通过。ChatKit PodStore 的 11 项失败目前均为 15/30 秒超时；成功 Pod 请求中位约 2831ms、最大 38460ms，历史通过轮分别约 126.5/1309ms，超时后操作仍继续执行。没有认证拒绝证据，也未证明 native 或产品回归原因；该轮失败记录保留；最终冻结源码的完整 gate 已按现有单 fork 配置通过，详情见文末，预算保持不变。
- 已安装 `/Applications/Xpod.app` 仍为 `0.4.20`，其 ICNS 摘要 `26b346ad…` 与新资源 `ad16e479…` 不同。新品牌打包/Dock 证据只证明实现，完成交付仍须最终候选全部 19 门禁、自更新、正式发布与实际桌面更新检查。

### 2026-10-03 历史集成检查点

集成已提交为 `70a8bf94`，草稿 PR #28 与 release/0.4.22 指向同一提交。候选构建用于取得真实打包证据；以下未完成门禁仍阻止正式发布，下文较早轮次保留为历史。

- 当前收尾证据：修复后的全量单测 757 文件/7421 项通过（309 既有跳过、1 todo），退出码 0；完整 lite→full 连续回归 162+62 项通过、退出码 0，基础设施已清理。此前 full 启动曾遇到 CSS 6310 异步端口绑定失败；占用来源未证实，隔离 full 复验 62 项通过，没有为此改写源码。
- Socket 认证已通过真实验证：API 不再将内部 WebID 读取指向默认 3000；CSS 现让 Bearer 与 DPoP 共用已配置的校验路由，保留 issuer/签名/audience/时间约束，含 cnf 的 Bearer 无 proof 必须拒绝。凭据映射收敛到同一 helper，41 项直接回归、构建与类型检查通过，独立安全复核未发现认证绕过。最终源码下的默认 inline 八层与全部审批案例、清理整轮通过；socket 早轮批准/重复批准与精确 Pod marker 通过，但第二个拒绝场景曾在模型调用前 180 秒超时。后续阶段探针中拒绝/重复拒绝通过，Stop 的启动请求失败且原错误被 helper 隐去；不能把缺少阻塞 await 认定为不存在性能问题。最新未修改 canonical 的真实 socket 客户端计时整轮八层通过，批准、拒绝、Stop 与重复操作均通过，三次启动返回 200/queued，分别约 11.0/14.8/18.9 秒。最后一次接近既有 20 秒预算；旧失败的精确原因仍未证实，没有为此增加预算或修改生产代码。正式候选与发布门禁仍需完成。
- 候选 37074903672 已完成原生 macOS 构建、运行时 SDK/本地运行时发布与镜像构建；桌面测试在打包前失败，因为干净 Bun 安装跳过 Electron postinstall。桌面 job 现显式执行现有 vendor install.js；干净私有目录已复现缺失 path.txt 的相同错误，再执行真实安装器后可解析并运行 Electron 33.4.11。既有发布流程 33 项回归通过；修复后完整 lite→full 命令再次通过（162+62 项，外层退出码 0），测试基础设施已清理。此修复需新的候选构建验证，不能复用失败候选的桌面结果。
- 窄屏 RC 测试仍按旧列表首屏操作，未打开设计 §2.7 的宿主抽屉；新的抽屉关闭时 AI 服务列表存在但隐藏。RC 与本地端到端测试现共用导航抽屉 helper，保留提供商选择、键盘、焦点恢复与几何检查，并按共享搜索组件的真实可访问名称定位。新增 applet 抽屉回归、既有 SDK/宿主回归和测试类型检查通过；真实 Chromium 在原生隔离 Xpod 上的窄屏案例通过（退出码 0）；最终测试类型检查与完整 lite→full 回归再次通过（162+62 项，外层退出码 0）。产品组件与静态产物没有为测试改写。
- 后续 CI 暴露了三处验收缺口：Ubuntu 单测缺少既有 rg 差分套件所需的真实二进制，test job 已显式安装；后台授权测试在首次读取结束前点击禁用按钮，现等待控件可用并确认密钥准备开始，保留身份切换后的双侧零写入断言，受控慢读取已先失败后通过。桌面 package-consumers 证据生产者按 npm 包名记录七个 tarball，而校验器误用目录名；现从同一 package.json 读取包名，真实生产者输出已先失败后通过，七包与根归档摘要一致，篡改与缺失字节仍拒绝。上述修改均不改变服务认证、任务或 UI 产品行为；本轮全量单测 757 文件/7423 项、完整集成 162+62 项、Bun 专属 36 项与测试类型检查均通过，外层退出码均为 0。后续候选 37081326630 的 AI 窄屏步骤已通过，设置页仍有旧列表头定位器失败，另有嵌入文档树下载 403 阻止桌面构建；两项正在独立修复，最终候选仍未通过。
- 并行交付安排：当前已通过单元与完整集成的源码可提交为草稿 PR，并启动候选构建以获取真实包与缓存；剩余 socket 问题修复后必须提交新的最终 SHA 并重验候选，当前候选不得据此晋升 stable。
- 共享组件遵循既定分层：纯展示在 shared-ui，宿主布局与能力协议在 extension-sdk，业务与 Pod 数据在 applet。新组件已有消费方；没有新增无消费方的选择卡、实体标或第二套列表头。
- 登录窗口保持原生 280×400；内容区 280×372。控件聚焦使用同一边框；已验证浅深主题无第二层外框。密钥弹窗在 1280/390、浅深主题、真实 200% 字号下重新验收，帮助文案使用相对行高，取消与 Escape 恢复触发按钮焦点；旧误放大 harness 结果不计入本次证据。
- 当前七包构建、三目标 UI 构建、桌面构建、UI lint 均通过。桌面最新 25 文件/182 测试通过；密钥与交互 2 文件/122 测试通过；自更新证据校验 17 项和发布合同 6 文件/76 项通过。
- 桌面应用与托盘旧图标已替换为选定的「B · 留缝折角」。应用 PNG 逐字节导入 homepage 原稿，ICNS/iconset 和五种状态托盘由同一来源生成；来源与 34 项产物摘要见 `desktop/assets/brand-provenance.json`。登录组件与 AI 连接模块的 Xpod 头像统一使用同一脚本导入的原始 SVG，旧盾牌文件删除；三目标 UI 构建、lint 与登录/能力包品牌回归 4 项通过；桌面品牌与 Dock 17 项复验通过。真实 Electron 暴露了旧动态 Dock 路径遗漏包内 PNG 的问题，解析器现优先使用 `app.asar/assets/icon.png`，回归已先失败后通过。独立测试 `.app` 资源摘要与签名通过，生产 Dock helper 实际加载 1024px PNG 并设置 Dock，托盘 1x/2x 非空。该测试包使用旧运行时作为资源打包载体，不计为新版本后端或自更新验收；当前 `/Applications/Xpod.app` 仍为 0.4.20。
- 发布预检确认根 Vitest/Bun 扫描未覆盖桌面套件，candidate 桌面 job 已在版本应用后、打包前调用现有 `bun run test`，完整桌面 182 项复验通过；stable 继续消费 candidate 证据。删除只镜像命令字符串的新增断言，保留既有 workflow 回归。重新构建并暂存三目标静态产物后，检查发现 app 的共享 chunk 被旧 ignore 规则遗漏；规则已删除，69 个静态文件与暂存摘要一致，52 个 HTML/JS 文档引用无缺项。
- 完整集成首次在 lite 阶段失败：30 文件/154 测试通过，2 文件/8 测试请求超时。使用已有 Vitest 控制将 fork 并发限制为 2 后，31 文件/161 测试通过，原八项超时未重现；仅 Matrix backlog 发送超过现有 300 秒预算，full 阶段仍未运行。不能视为发布门禁通过。
- 最新组合回归：全量单测 756 文件/7398 项通过，1 文件/3 项因缺失 route-discovery fetch 模拟而失败；独立无限等待探针稳定复现同三项，补齐 fixture 后整文件 69 项、相邻 UI 31 文件/450 项通过，lint 与两层类型检查通过。完整集成已执行两个阶段：lite 32 文件/162 项通过、16 项既有跳过；full 7 文件/62 项通过，基础设施已清理。后台外层退出码未单独记录，最终提交前仍要执行前台完整命令并记录退出码；不得将本轮视为 exact-SHA candidate 的证据。
- 后续将 route-discovery 的超时与取消收敛到 SDK 的同一公开探针：fetch 与正文读取共用既有 1 秒预算，effect 清理中取消失效身份的请求；UI 删除第二套计时器。补充 opaque origin 回归并修正根审查发现的 URL 构造边界后，SDK/UI 三文件 101 项通过，七包、三目标 UI、服务端与测试类型检查及 UI lint 通过。重新暂存后的 69 个静态文件与 Git index 摘要一致，52 个 HTML/JS 引用无缺项。随后全量单测 757 文件/7415 项通过，309 项既有跳过、1 项 todo，实际外层退出码 0；这轮收集早于后续 socket 地址解析修复，后者需独立回归与真实验证。
- 最新真实 native 隔离 Gateway 的默认 inline 整轮通过：runtime、identity、Pod 读写、Gateway 认证、AI connections、models、有效 Chat、Task approval 共八层全部通过；approve、duplicate、reject、Stop 和任务/授权清理均有实际证据。Unix socket/spawn 整轮仍失败：模型继续运行后，agent Pod 同步返回 401，审批恢复接口返回 400。传输 CLI 回调通过不代表完整任务通过；根因尚待确定性诊断，发布门禁保持未通过。
- Matrix 发送路径现复用同次操作的 room/timeline，但保留独立的精确 receipt 读取。整合审查通过真实语义回归发现：仅在 timeline 查 receipt 会漏掉已移出时间线的冲突资源；修正后 105 项通过、3 项既有跳过。Task 同次请求的并行 DB 打开可合并；删除执行身份解析后的 Task 再读取会覆盖期间暂停的日程，回归已复现并恢复该边界，轮询 Task 的权限检查也保留。真实 Task 与共同 RDF 读路径的最终验收仍在继续。
- 共享 SPARQL 权限检查仅在单次请求内按资源和权限模式复用，失败检查移出缓存并原样抛出错误；下次请求重新检查，凭据隔离和授权撤销回归保留。根审查删除多余结果包装与辅助层后，69 项 handler 回归通过；合并源码 `build:ts` 与 `typecheck:test` 均通过。Task 只保留同请求 DB 打开的并发合并，相关 35 文件/245 项通过。完整组合回归仍需以下一轮实际结果为准。
- 本机原生 RDF 修复产物更新为 `e0e3d9dd70254f7b80a8d60adc8c5efb3bcd034179b4920d1e4221a0011a6a85`，严格查询夹具 12/12 通过。该产物仍链接本机 Homebrew 库，正式发布必须以 candidate 的同源码 bundle 重新验收。
- SolidFS 非 RDF 文件已进入现有 Pod HTTP 同步路径，二进制使用字节缓冲。同步自身导致的 mtime 变化只在大小与内容摘要一致时重记文件版本；并发不同字节继续进入失败/协调路径。SolidFS 102 项、连同恢复/取消共 119 项通过，控制器实际负例也证明没有错误标记完成。大文件内存占用尚未专项验收。
- 真实隔离 Standalone 的审批首次恢复及重复恢复均已通过：同一 Run、同一 Session 完成，Pod HTTP 精确回读 marker，重复请求不再执行。消息元数据持久化已切回 ORM 序列化与既有强 ETag 更新边界，删除手写 PATCH；公开 `saveItem` 的两个分支和无 ETag 拒绝回归、连同存储/Run 共 13 文件/64 项通过。后续拒绝检查点发生 Task API 超时，另一确认轮也发生超时；高负载与请求空档是相关观察，尚不能断言原因，仍需诊断并完成 approve/duplicate/reject/Stop 和清理的整轮验收。
- Unix socket/显式 Inngest spawn 的真实 CLI 回调已到达认证边界，生命周期回归 30 项通过；这项证据只证明传输可达，完整任务链路仍需单独验收。
- Inngest 原生 CLI 的固定源码、许可证、文档载体与安装消费校验已实现，73 项回归与类型检查通过。最终 registry 消费者及 bundled runtime 要在 exact SHA 候选上再验收。
- RC 最终清单的 `qlever-local` 与 `package-consumers` 已删除写死通过值：消费者保留实际安装的 tarball；原生 archive、manifest、runtime 摘要与源码权威 ABI/QLever 固定版本一致才可通过。finalize 重新核对下载产物字节。新 verifier 7 项、消费者 Node 9 项、workflow 33 项及其他发布合同 41 项、自更新 17 项通过；类型和 YAML 解析通过。真实 exact-SHA candidate 仍待执行，actionlint 本机不可用。
- 本检查点由 OpenCode Go B 执行，属于历史证据；当前最终验收与发布 owner 已改为 GPT-6.1 Sol。未发布 0.4.22；不得复用其他版本分支的 RC 证据。

该历史检查点的后续顺序已由上方“当前发布状态”取代。

- 64px rail、270px 对象列与单一 48px 内容头；任务、AI 连接、Pod 使用 WebID，设备和设置保留匿名本机入口。390px 抽屉、焦点恢复和关闭行为复用共享工作区接口。
- AI 连接提供两步密钥创建、整个 Pod 访问面、复制/配置能力降级、模型类型和真实 dimensions、凭据错误码及时间；schema 属 models，目录与行为属能力模块。
- Pod 的模型、搜索、应用、数据共用 `pod-settings` body；embedding 更换只有一个编辑入口，重建需要明确确认。
- 待办、清单、日程及运行通过共用 `tasks` body 与公开 Tasks API；终止传播到活跃执行，同次运行审批按当前 tool checkpoint 恢复。
- 通知分为需要处理与动态，Inbox 从真实 Pod 读取；桌面托盘使用同一快照，显示最多三条并支持审批和身份隔离。
- 设备页显示网络、服务、运行设置与日志；退出确认、自动重启策略、数据目录选择和安全 IPC 已实现。
- 长期 Grant、导入/导出/迁移、多隧道、尚无合同的模型默认项按设计标记待接入。

## 保留已发布行为

对照 stable v0.4.20，选择性保留 DesktopSelfUpdater、ad-hoc afterPack seal 与打包更新验收；Account app 样式固定为 `main.css`，candidate 检查 auth 文档引用资产。账号/Consent 的过期、取消、interaction 与当前 storage 绑定安全逻辑已选择性保留并回归；不通过整笔旧分支合并覆盖新外壳。

## 已收集证据

以下既有完整验收对应集成前桌面 checkpoint `7df53e1a314063ae37b324ce2aa32a75887d02e2`。目录分支合并与旧数据 ETag 升级后的源码必须重新经过全部门禁；旧结果不证明新 merge SHA 已通过。

| 验证层 | 当前结果 |
| --- | --- |
| 包构建、服务 TypeScript、Components、完整 UI 构建、测试类型检查 | 正式 models 消费后完整构建、测试类型检查及全 UI lint 已通过；审批创建、取消、普通 Chat 同 Run 续跑及会话 metadata 转发补全后，build:ts / typecheck:test / UI lint 全部通过；静态 root package.json import 改变编译布局的问题已改为读取权威 PACKAGE_ROOT |
| 全量单测 | build17 与第十轮全部通过：680 文件/6665 项；40 文件/276 项跳过、1 项 todo（现有环境门禁）。内部动态端口冲突及 localhost DNS 延迟边界已修复：端口回归 33 项、真实 runtime 16 项及 unit/helper 10 项通过；数值连接且保留原 Host/DPoP/canonical metadata 与 Response.url，未修改全局 DNS/timeout/ACL |
| RDF Run 权限 | 新 resolver 每次恢复真实认证、HEAD 验证有限来源集合并拒绝重定向/越界/失败响应；不信任旧 context。SQLite/PGlite 空集与 OPTIONAL 基数泄漏回归 162 项通过，安全复核无剩余阻断；共享语义夹具改为真实有限授权；默认容器图按 basePath、图/来源 allow 和 deny 共同下推，物理 default graph 不越权；最终 5 套件/55 项、安全复核通过 |
| 日志 | Supervisor / API 采集先去 ANSI、规范级别并统一脱敏；UI 同源 service/logs 仅在 404/405 时回退，401/403/500 保留错误；36 项针对性回归通过 |
| 完整集成测试 | 第八轮完整通过：lite 30 文件/155 项、6 项跳过；full 5 文件/46 项，无跳过，服务/容器/卷/network 全部清理。第七轮曾发生一次 credentials 写锁 6000ms 超时，原样复验未重现；旧日志不足以证明具体慢 await 或 CPU 根因，保留失败证据，未修改生产锁或测试断言 |
| 桌面 | 最终桌面 build/typecheck/main+preload+console bundle 与 169 项/547 assertions 通过（使用当前已安装 Electron 的实际 MacOS 执行目录）；隔离两版本真实 .app 下载、校验、替换及重启通过（服务 runtime 复用已发布产物，最终新源码仍走 candidate） |
| 公共 API 授权重试 | helper/Provider 118 项通过；真实浏览器无等待的首次两次 Tasks GET 均 200；Pod Config 403 正确触发重试且实际 200；错误字符串与 OpenAI 结构化错误均受同一 narrow missing-access 判定保护 |
| 真实隔离 Standalone | 真实账号/Pod/OIDC 登录通过，13 路由×4 种 viewport/theme/text-size 截图，无 pageErrors |
| 审批与运行并发 | 两个独立登录客户端的审批强 ETag 决策一个 decided、一个 conflict；ORM 回读 approved。Run、Session、续跑 claim/release 统一强 ETag CAS，412 后重新读取和计算；103 项回归及独立复核通过。真实 Pod 独立 DPoP 客户端 Run 取消与 stale completed 写、Session 终态与 stale active 写均回读保留取消/终态；后续取消投影和审计遗漏通过 89 项回归及五个修前失败的屏障用例 |
| AI 层级 | 正式实际实例：Pod TTL PUT/GET、Gateway Key 登记/认证/撤销、Models 非空（1 模型）、Chat 200 且有效内容 XPOD_OK 全部通过；OpenCode 会话标识经同一 typed adapter 接口受限透传 |
| 原生 RDF | 原 Docker/Linux 与 macOS writer 混合夹具导致 WAL 异常；相同 ABI/patch 的 macOS 原生 runtime 已通过 Todo PATCH 与 drizzle updateByIri/deleteByIri 回读。默认图 cache 缺陷通过旧/新严格编译回归；当前源码 macOS arm64 产物 d6d639dbe7c8a757b363d00d749c3e255ccbd65deb37651dc5351725d666355e 已构建并通过完整 CRUD 回读（本地 Homebrew 动态库版本，正式 bundle 由 candidate 验证）；QLever 311 项通过、1 项需要 upstream 环境的语义测试跳过 |
| models | authority worktree 0.2.60 已正式发布（f4ef9877efb6571aeac6f7e3b054a38168c3c064）；26 suites/232 tests、npm registry tarball integrity、导出与新字段类型消费通过；临时补丁已删除 |
| 共用 applet npm | 七包 stable manifests（SDK 0.1.1 等）、拓扑 staging、干净 Bun 消费者 25 个模块/类型及 CSS/integrity 门禁通过；stable exact-SHA guard 后发布，尚未实际发布 |

真实测试中使用的账号、客户端密钥及 Provider 参数只存受保护的 `.test-data` 私有文件，不作为发布产物。

## 发布门禁

1. AI 四层已通过；真实生产 Task 验收发现 drizzle-solid 嵌套 metadata IRI 未按父资源隔离（两个 Task 均写入 #metadata-1），日程/授权对象合并。问题已记录并正式发布 drizzle-solid 0.3.25（86983384f9ea98f6748631bc859a5fc187e4cd1d），839 unit + 真实两 Task CRUD 通过，Xpod patch 重新精确生成且冻结锁通过。freshTask 日程创建/暂停/执行已成功；随后发现 Run RDF context 缺少显式 accessScope，授权范围 producer 已补齐，每次使用实际 Task 身份重新探测 workspace/source 权限；空授权、隐式根 pattern、OPTIONAL 查询 fail-closed 回归与安全复核通过。真实 Task 已越过该检查，随后进入 waiting_runner：API 的权威目录映射已改为启动时捕获并按实例传给 Pi 与子进程，同时显式传递已有 token endpoint；88 项回归通过。旧 waiting_runner 已通过正式 stop 接口取消并回读确认；build13 fresh Task 已进入 running，实际模型每轮成功但 request_approval 参数为空而循环，runNow 同步等待导致默认约 5 分钟后客户端超时。该运行已正式 stop 并独立回读 cancelled，隔 20 秒步骤数量保持 50 条。manual runNow 已改为持久化后立即 ACK queued（71 项回归通过），真实 SSE 探针已复现空参数，同请求真实上游 73 分片/183 字节参数完整，而 Gateway 仅 1 分片/0 字节，已定位重复 assistant role 被误判新响应、重置工具参数缓存；通用 streaming parser 已修复并以真实 Pi SDK 的重复 role/响应身份回归验证，53 项通过；build14/15 的有界真实探针持续收到 B 上游 HTTP 500 空正文，现有账号 A 独立探针返回 429 GoUsageLimitError，Retry-After 为 259216 秒（约三天）。审批创建→同次运行恢复仍未验收通过；不得用人工 checkpoint、mock 或 HTTP 成功状态代替完整链路。Pod CRUD 和审批 CAS 已通过同系统原生回读。
2. 切换正式 models 0.2.60，删除过渡补丁，同步冻结 lock；重跑最终 build/typecheck/lint/单测/完整集成/桌面/视觉验收。
3. 并行目录功能的 `release/0.4.21` 已有成功候选（cb0bbb39abe90e8cf657f10936aba5db7321b826），不覆盖该分支。桌面按 0.4.22 准备，从经过验收的集成 source commit 创建 release/0.4.22。candidate 从同一 SHA 构建服务、原生 QLever 和桌面，记录 immutable digest 与完整 acceptance artifact。
4. 仅在 exact SHA 的 candidate 全部通过后创建对应 stable tag；stable guard 校验 acceptance，staging 发布、独立 Node/Bun 消费验收后提升 latest，再提升同一 digest 并部署。
5. 共用包通过 stable guard 后按依赖顺序 staging 发布，清洁安装检查 exports/types/CSS 和真实模块导入，再提升 latest。根包 latest 等待此门禁成功，独立 tag/manual workflow 不绕过 RC。

## 集成验证进行中

- 合并保留目录/Matrix/独立 CLI 功能和桌面 Tasks/Pod/Device。按用户 10/2 的最新纠正，微信式短登录恢复为 280×400 原生逻辑 bounds；注册、完整 Consent、Pod 管理使用工作区文档。主工作区对应画板 1280×800；共享 body 填满扣除标题栏后的内容视口，不在内部再套卡片。客户端 Consent carry 自动批准已删除，只有服务端真实已记住的授权决定可自动续接。
- 旧 timestamp-only ETag 通过既有分布式资源写锁持久化 revision 后重试读取；迁移不得覆盖业务 RDF、修改旧时间戳、重入写锁或制造临时 ETag。
- 当前上游 B 返回 500、A 返回限额 429；candidate 使用现有 RC provider 凭据运行真实生产 Task 的批准、拒绝、停止三条链路。新增 gate 要求同 Run/Session、真实 Pod marker 与凭据撤销证据，尚未在新候选运行。

## 集成后新增证据与用户纠正

- 目录候选 d938792f 的 HEAD-safe response writer 已整合；发布仍保留独立 release/0.4.21，桌面版本为 0.4.22。
- 存储重启恢复改为读取 authority 文件，不再重复写回；完成回执绑定 sourcePath、资源 URI 与精确文件版本。旧 checkpoint 可从保留操作安全补齐资源标识，无法证明时重放；跨 workspace 回执保留根目录外部删除检测。
- 独立审查复现并修复两个故障路径：同毫秒旧操作被迟到失败重新打开、journal INSERT 失败时误删已持久化 authority 文件。专项 17 文件/166 项通过，独立复验 46 项通过。真实 same-OS native HTTP 对照与 legacy 验收证明重启 revision/mtime/body 不变、仅首次旧 ETag 迁移、正式 Stop 200、Run cancelled、Session completed、两文档 stale CAS 412；一次 30 秒超时的失败证据保留，最后请求 6938ms 成功。此层不代表 Task producer 审批通过。
- 用户指出新建密钥的用途下拉框仍有内灰边框与外紫框：统一焦点改用现有边框，取消控件外侧 outline/shadow，选中 toggle 另验证与填充的对比度。最终共享组件构建后，真实 Electron 登录内容 280×372、form clientHeight=scrollHeight=372；Checkbox 只有一个可见 marker、background-image=none、border=2px、无 outline/shadow；工作区 content 1280×800，浅/深主题公共 NativeSelect 均为 2px 单边框且无水平溢出。证据位于私有 `.test-data/desktop-merge/shared-final-native.json` 与 `shared-final-*.png`。200% 文案的既有 13 项浏览器布局回归已通过，完整合并源码全量门禁仍需完成。
- RC 新增白名单三分支 Task evidence artifact，仅保留布尔证明、受控状态、清理计数和源码/工作流标识，不上传账号、任务标识、密钥或自由文本；原实际失败门禁保持强制。
- 按用户“尽量沉淀共享组件”和原分层约定，新增公共 NativeSelect、Textarea、Checkbox、FormField、EmptyState，Radix Select 从应用层移入共享唯一实现；应用层 Button/Input/Label/Select 公开转发，Card 仅兼容参数。Pod 删除手写 modal/focus 循环，任务/设备/AI 删除重复基础控件样式，业务与文案仍由各 applet 提供。SDK 布局补可注入 copy；旧 shared-ui workspace 有真实 LinX 分支消费者，按文档 §6.1 保留弃用兼容出口，不造成反向 SDK 依赖。定向公共 162 项、布局 25 项与最终五文件 30 项通过，包构建、UI 三目标构建、类型与 lint 通过。
- 最终全量验证由实际本机 OpenCode CLI 的可用 `deepseek/deepseek-flash` 配置执行。桌面原生 DeepSeek 子代理入口不支持该模型；当前 OpenCode Go 最小实际调用返回 `Go usage limit exceeded`，未被记作恢复成功。OpenCode CLI 私有状态与日志放 `.test-data/opencode-shared`；未输出密钥，未改用户全局凭据配置。

## 远端发布状态只读审计（2026-10-02）

详情见 `.test-data/opencode-shared/release-current-audit.json` 与 `release-current-audit.md`；此处只记结论。

- **0.4.22 尚未开始**：远端无 `release/0.4.22` 分支、无 tag、无 RC run；根/原生 npm 无 0.4.22，七包目标版本均未发布，无不可变碰撞。根/桌面/平台包与 models 0.2.60 / drizzle-solid 0.3.25 已对齐。
- **`release/0.4.21` 参考态**：`d938792f` 有成功 RC（run `36946171908`，`0.4.21-rc.223`，digest `sha256:eddecb89…`），acceptance 仅 21 项且**不含 `task-approval`**；该分支未 tag、未提升 latest，属另一发布线，只观察。当前 0.4.22 guard 要求 19 项，d938 在新 guard 下不可晋升。
- **门禁真实性**：15 项由 candidate 步骤真实产出；`task-approval` 是真实 producer（`acceptLiveTaskApproval`），但当前被上游阻断（A 429 `GoUsageLimitError`、B 500 空正文）；`qlever-local` / `desktop` / `package-consumers` 在 `finalize_acceptance` 中为硬编码 `'passed'` 断言，各有间接但非证据绑定的检查。
- **自更新缺口**：`desktop/scripts/packaged-update-acceptance.mjs` 是 `docs/RELEASE.md` 要求的必过门禁，但 candidate/release 均未调用；`desktop` 检查不含“旧包→新包”实测。
- **合并态**：`cb0bbb39`（3 文件）与 `d938792f`（6 文件）只 staged、未提交，HEAD `7df53e1a` 不含二者；生产全链路集成 Matrix blocker 仍在。
- **距最终发布前提**：合并落地并集成绿 → 从 exact SHA 建 `release/0.4.22` → 真实 Task 审批链路通过 → 桌面自更新纳入门禁 → 七包（含首次创建）发布 → exact SHA `v0.4.22` 走完 promotion guard / staging / consumer / latest / 同 digest 部署 / 桌面 / GitHub release。本次未改代码、workflow、spec 资产或外来 PR，未跑 build/service/test，未 push/tag/release/publish。

## 自更新发布门禁实施计划（有界，2026-10-02）

目标：让 candidate 的 `desktop` 检查由**同一 source SHA 上真实执行的旧包 → 新包自动下载/校验/替换/重启**证据产出，替代 `finalize_acceptance` 中的字面量 `'passed'`；保留 19 项 required checks 名称、accepted SHA / image digest / native runtime 绑定不变。

授权范围（仅此）：`.github/workflows/candidate.yml`、`.github/workflows/release.yml`、`desktop/scripts/packaged-update-acceptance.mjs`、以及为自更新 provenance 所必需的 release verifier 脚本/测试；本计划文档。不触碰后端 / Matrix / 组件 / release/0.4.21 线。

集成路径（复用既有，不另造更新器、不打补丁旧二进制）：
1. 扩展 `packaged-update-acceptance.mjs`：新增必填 `--source-sha`、可选 `--old-zip` 与 `--evidence-out`；成功时写机器可读 evidence（`schemaVersion`、`kind`、`sourceSha`、旧/新版本、旧二进制/旧 zip/新 zip 的 sha256、必需生命周期事件、`cleanup.removedUserData`、`ok`）；失败不写 ok 证据并以非零退出。始终保持临时 userData 清理。
2. 新增 `scripts/desktop-self-update-acceptance.cjs`：校验 evidence 的 schema、`sourceSha` 40 位 hex 精确匹配、`newVersion` 匹配 candidate、`oldVersion < newVersion`、必需事件齐全、`cleanup.removedUserData===true`，并拒绝敏感字段；通过时输出 `{ "desktop": "passed" }`。
3. `candidate.yml build_desktop_rc`：下载最近一次 stable release 的 `*-arm64-mac.zip`（旧包）→ 解包取 `Xpod.app` → 用 candidate 已构建 zip 与 `--version $CANDIDATE_VERSION --source-sha ${{ github.sha }}` 运行脚本 → verifier 校验 → 上传 artifact `desktop-self-update-acceptance-<sha>`。
4. `candidate.yml finalize_acceptance`：下载该 artifact，verifier 通过后才写入 `desktop:passed`；缺失/不匹配即失败。`qlever-local`、`package-consumers` 保持现状（其上游 job 真实存在），不在本轮改写。
5. `release.yml`：无需功能改动（promotion guard 已消费含 `desktop` 的 acceptance manifest）；仅在必要处保留绑定说明。

测试（轻量、无 GUI）：新增 `tests/scripts/desktop-self-update-acceptance.node-test.cjs`，对纯函数 verifier 做接受/拒绝用例（正确、SHA 不符、事件缺失、版本非递增、cleanup 未完成、敏感字段）。GUI 端到端仅在 coordinator 打开自更新构建门禁（或 `matrix-full-verification-done.json` ready=true）后，于 macOS runner 实跑。

具体 blocker 政策：若 macOS runner 无 GUI 登录会话导致真实更新无法执行，不做 mock / 源码契约替代，记录具体失败并把真实替代（专用带 GUI 的 macOS runner 或自托管）写进报告；门禁保持未通过。

门禁开启条件：`.test-data/opencode-shared/matrix-full-verification-done.json` `ready=true`，或 coordinator 显式开放自更新构建门禁。在此之前只交付代码与轻量单测，不跑重 GUI。

## 独立复核整改（F1-F6，2026-10-02）

依据：`.test-data/opencode-shared/self-update-review-report.md`（verdict=changes-required）。在既有授权范围内整改，外加 `desktop/scripts/update-feed-fixture.mjs`、verifier/tests 与 candidate/release workflow 接线；不动后端/Matrix/UI/共用原语。

- **F1 路径**：producer 新增导出纯函数 `resolveCallerPath`，相对路径先按 `desktop`、再按仓库根解析取存在者，保留文档化的 `release/…` 用法；workflow 传 `$PWD/desktop/release/...` 绝对路径。以真实路径行为测试，不用快照。
- **F2 checksum**：producer 计算新 zip 的 `sha512`(base64) 与 `size` 并传给 fixture；fixture 在 JSON 响应中回传 `sha512`/`size`（v0.4.20 旧包 `self-updater` 已支持该分支）。补 fixture 响应回归；负例坏校验和在重门禁后可选实跑（必须 swap 前拒绝）。
- **F3 字节绑定**：verifier 新增 `--expected-new-zip`：对 finalize 下载的 `xpod-desktop-macos-<candidate>` 实际 zip 计算 sha256/size 并要求等于 evidence，且文件名包含 candidate 版本；拒绝仅回显通过。
- **F4 接线**：`deploy_and_accept` preflight 与 `release.yml` 的 `node --test` 列表均加入 `tests/scripts/desktop-self-update-acceptance.node-test.cjs`。
- **F5 真实清理**：producer 按精确 `oldBinary` 路径跟踪/回收旧进程、重启后的新进程与 fixture，回收后才写证据；`oldAppStopped`/`relaunchedAppStopped`/`fixtureStopped`/`removedUserData` 均为实测布尔；绝不宽泛 pkill，仅限私有临时 bundle 路径；失败路径同样回收。
- **F6 旧基线 provenance**：launch 前记录旧二进制 sha256；记录官方 stable tag；`oldZip.name` 解析版本与 `oldVersion` 互校；不伪造 Info.plist、不重签旧包、不覆盖原始发布产物。0.4.17→0.4.18 旧生产者结果只作历史，不作为新门禁证明。
- 重门禁：整改只跑轻量 node/schema/path/workflow 测试；真实 old stable→new packed 同 sourceSHA 的 GUI 执行需 root 提交/候选构建后由 coordinator 打开门禁再进行。

## 2026-10-03 用户纠正：官方订阅与工作台链接

- Anthropic 官方订阅显示为 `Claude Pro / Max`，客户端产品为 `Claude Code`，订阅链接指向官方 pricing；其订阅接入仍为 unavailable、授权方法和推理 endpoint 均为空，不把官方订阅存在等同于 Xpod 已实现订阅接入。API Key 接入与计费独立，原有真实 OAuth 和宿主权限限制保留。
- 共享提供商头部把“访问官网”和声明中的“打开工作台”放在同一组链接；移除凭据工具栏重复的纯工作台按钮。外部工作台导航不启动连接，390 宽度允许自然换行。不可用订阅复用既有 offering 详情组件展示，避免静默隐藏。
- provider/offering 内容以 `@undefineds.co/ai-connections` 能力目录为唯一来源。删除服务端 models 元数据覆盖、第二份名称映射和订阅硬编码覆写；UI、客户端规范化、服务端产品投影及默认 runtime descriptor 名称均使用同一目录，runtime 插件、协议和授权边界不迁移。
- 本次新增 UI 定向 22 项、服务端相邻 228 项通过；最终冻结产品源码的完整单元测试 758 个文件、7443 项通过，Bun 专项 36 项通过。七包、UI 三目标及服务端构建、生产/测试类型检查、依赖状态通过。隔离真实 Xpod 的浏览器在 390/1440 两种宽度验证 Anthropic、百炼、Kimi 共六个页面，官网与工作台相邻、键盘焦点与溢出检查通过；挂载浏览器会话实际请求服务端目录返回 200。该隔离验证不代表部署候选或用户当前 Gateway 已验收。
- 子代理按用户新指令改为 GPT-6.1 Sol；前一组 OpenCode Go B 因 API 连接错误终止，非 429。效果与效率比较基于本任务的交接、返工和验证证据，不作为同任务受控速度或订阅额度对比。

- 完整集成失败证据保留：第一次遇到 macOS 合盖睡眠约 989 秒，Identity 启动 hook 超时并出现原有 autoOpen 未处理拒绝；第二次保持唤醒后 Identity 与原预算 Matrix 长流程通过，ChatKit 两项仍超出既有 15 秒预算。最终按现有单 fork 配置完成完整 lite/full：lite 32 文件、162 项通过（4 文件、16 项跳过）；full 7 文件、62 项通过；完整命令退出 0。未放宽断言或预算；并发配置下的 ChatKit 延迟敏感性仍保留为风险。19 项新候选门禁、正式包自更新及正式发布仍待完成。

## rc.229 实际候选证据与剩余阻断

- `3dd77d648b6484382ad877451adb8ffba518e693` 已无 force 原子推进 feature 与 release/0.4.22。Ubuntu CI `37103286195` 的 unit、Bun、lite/full 与 18 个 Node/Bun 消费者 smoke 均通过。RC `37103282424` 原生运行时、桌面构建与消费者构建通过。
- 同一步内 runtime、identity、真实 Pod 读写、Gateway Key 与鉴权、AI Connections、模型列表（HTTP 200、一项模型）和实际 Chat（HTTP 200、有有效内容）均通过。唯一失败为 Task `approved:checkpoint`：生产者在请求审批前持久化为 completed。不能将步骤名误读成登录或 Chat 故障；最终统一 acceptance manifest 因该失败未生成，不能将 18 项独立通过等同于 19 项候选全部接受。
- 官方 v0.4.20 到真实打包 0.4.22-rc.229 的自更新实际运行通过；五个生命周期事件、不同新进程 PID、全部自有进程与临时数据清理均有证据。独立下载候选实际 ZIP，sha256、sha512、大小与 sourceSha 均与证据匹配，官方旧 ZIP provenance 匹配。
- 实际候选 app 的 ICNS 与源资源逐字节一致（sha256 `ad16e479…`）；app.asar 内 Dock PNG 为 1024×1024，摘要 `415585c5…` 与源资源一致。此结论不等于已安装应用或 Dock 缓存已经更新。
- 只读诊断发现 Pi SDK 可用正常 resolve 的 assistant error 事件表达上游失败；驱动目前丢弃该错误，可能使 TaskMaterializer 将失败记为 completed。该结构缺口可独立验证，但本次 CI 没有原始 stopReason/tool-call 证据，尚不能断言它就是 rc.229 的具体根因。按原断言和预算补回归修复后，仍需新 exact-SHA 真实审批门禁。
- 正式 tag、npm latest、生产晋级和用户已安装桌面均未修改。

- 独立审查另发现 SDK retry 在 toolUse 的 message_end 即解除 prompt 等待；真实 SDK 复现了“429 → read 工具 → 最终 error”时 prompt 已 resolve、Agent 仍在 streaming，Task 因驱动提前关闭事件流而错记 completed。相同回归的“429 → request_approval”通过，不能把未复现的审批丢失归因当作本次 RC 原因。修复按 SDK 自身运行与 retry promise 等待真实终态，审批和调用方取消仍走原有提前结束路径。根代理主动停止旧冻结版本的完整集成（此前 11 文件通过、无失败），仅向已核对的自有 Vitest PID 发 SIGINT，进程组已清空；新源码冻结后须重新完整验证。

- Pi 最终修复仅使用公开 Agent.waitForIdle 和既有事件订阅中的单个生命周期等待：覆盖 SDK retry 提前返回、工具后错误/再重试耗尽、无 owner abort 的异常中止；正常审批、重试恢复、owner 取消保持。13 项真实 installed Agent/AgentSession 与实际 TaskService 消费回归，以及相邻六文件共 84 项通过；构建和测试类型检查通过，新增测试 lint 为零、生产文件原有六项 lint 未增加。独立只读审查核对 SDK 事件/状态更新顺序、无空转、取消和审批唤醒、监听与夹具清理后通过；最终完整集成已通过：lite 32 文件/162 项、full 7 文件/62 项，完整命令退出 0；使用现有单 fork 配置，断言与预算保持原值。仍须新 exact-SHA 候选真实审批证明。

## rc.230 实际失败与有界诊断（2026-10-03）

- 当前源码 `9460a7e0249af5c58896bd386b5f8372e250ca81` 的 Ubuntu CI `37107811330` 全部 22 个 job 通过；单元 759 文件、7454 项通过，lite/full、Bun 与 18 个消费者 smoke 通过。实际候选 `37107807694` 的原生、消费者、桌面打包及官方 v0.4.20 → rc.230 自更新通过，实际 ZIP 与 sourceSha、校验和及品牌资源匹配。
- 实际 Gateway 的 runtime、identity、Pod 读写、Key 鉴权、AI Connections、模型列表和有效 Chat 响应均通过；Task 仍在 `approved:checkpoint` 失败，但这次状态为 failed。驱动现在如实保存失败，尚没有证据证明该上游失败的具体原因。统一 19 项 accepted manifest 未生成，正式发布与已安装应用仍不晋级。
- 已保存的 CI 日志没有 Task Run.error、实际模型 stream 路径/状态/耗时或 tool-call 数；现有 CSS 存储访问日志不能代替推理请求证据。失败容器已清理，本机没有该部署的控制凭据。模型地址 `/v1/chat/completions` 与 SDK runtime key 的静态接入无明显缺口；不能把公网与 loopback 地址差异推断为已证明的根因。
- 诊断先复用现有 `/api/tasks/runs` 和 `/api/tasks/steps`：只在已观察到终态的失败 case 清理前保存状态、错误存在布尔、两个精确 Pi 错误分类（其他错误为 other_error）、RunStepType 白名单计数及审批工具布尔。未知实际模型请求明确标为 unobserved；不保存错误原文、模型内容、工具参数或凭据。仅失败时追加一次已有 steps GET，成功条件、请求/轮询预算与 finally 清理保持原值。
- 新回归在旧 helper 上 6 项失败，修复后相关四文件共 21 项通过；测试类型、定向 lint 与 diff 检查通过。独立只读审查确认快照时序、脱敏及诊断失败/回调异常不跳过 finally。本轮完整集成 lite 32 文件/162 项通过，full 57 项通过、5 项失败：日志显示 PostgreSQL 缺失 internal_kv，并出现目录、业务 token 和 OIDC 异常；正在核对测试数据库隔离，不能将这些失败归为性能或本次 helper 改动。
- 诊断执行复用已注册 candidate workflow 的手工入口，默认关闭，固定使用 rc.230 镜像 digest `sha256:8e3b0678a790c6f72b50dee4356b602f93e9c21a9e141851084d37e176c15eb8`；诊断源码与运行镜像源码分别记录。仅现有 feature/release 分支、rc environment、真实现有 RC IdP 和原 Local 配置。此路径不重复 Mac 打包/消费者/自更新，不生成发布 accepted 证据，不部署生产或改动 main；普通候选默认路径须保持原有依赖和门禁。

- 两个 full 测试的 PostgreSQL 客户端遗漏 runner 已有的 `XPOD_FULL_PG_URL`，现已复用该输入，保留原默认值；构造参数回归从 override 两项失败到四项通过。此缺口不能证明先前 internal_kv 缺失的具体原因。唯一自有 Compose 项目与独立数据库上 full 单独执行 7 文件、62 项通过；同轮完整命令在 lite 出现 ChatKit 15 秒、通知性能断言和 Matrix 单请求 300 秒超时，因此不能记为完整命令通过，预算未放宽。

## 智能与快速模型的 Gateway 接入状态

- 智能与快速是已有 AI Gateway 角色，不再以“待接入”表示。能力模块提供原始 Gateway 目录与统一角色匹配，保留既有 provider 归属目录接口；只匹配实际发布的 `linx` / `linx-lite` 或既有 `undefineds/` 命名空间，不从任意路径末段猜角色。
- Pod 设置业务组件独立表达支持、目录状态和可测试性；宿主负责身份、请求与保存。智能沿用 `chatModel` 覆盖和清空，快速由 Gateway 管理，不增加 Pod 字段；测试使用目录实际模型 id。空目录、401/403、网络或无效响应分别显示，不把请求失败转换成已连接。
- 七个工作区包、生产 TypeScript、测试类型与三个 UI 构建均通过；正常根 Vitest 配置消费已构建包的四文件 88 项通过。13 个源文件独立哈希审查通过，workflow/helper/contract 另九文件 74 项通过，69 个静态文件的 115 条引用无断裂。
- 真实隔离 Bun/native 浏览器最终验证 OIDC 十项、DPoP 403 service_access_missing → 用户凭据 Bearer 200 的完整认证链、实际空目录以及 390/1440 默认角色展示、单层 2px 焦点边框、无横向溢出和窄屏抽屉自动关闭。初次探针误取中间 403、布局属性定位和回调后目标路由均为私有验收问题，生产认证与布局代码未变。自定义模型保存的额外场景遇到连接弹窗固定错误，覆盖/清空浏览器结果仍待验证；隔离空目录不能证明平台实际推理可用。
- 最新完整集成命令退出 1：lite 31 文件/161 项通过，Matrix 1 项失败，full 因串联命令未执行。Matrix child 在第七个重复消息请求开始约五秒后收到 SIGTERM，未到原 300 秒请求预算；原测试只保留 stderr 末尾，不能区分实际退出原因。已在测试失败投影保留脱敏 code/signal/killed/输出字节数；四项真实子进程诊断回归、测试类型与 lint 通过，8 MiB 缓冲、960/990 秒预算和所有断言保持不变，尚未证明其具体根因。
- 同一源码的真实 Matrix 单项复验现已捕获 `ERR_CHILD_PROCESS_STDIO_MAXBUFFER`，stdout 精确 8 MiB；首消息 PUT 返回 200，重复 PUT 开始约 8.8 秒后被外层清理，无 300 秒 HTTP 超时事件，全部八个已记录自有进程已退出。根代理启用 `XPOD_MATRIX_DIAG=1` 且未设置既有日志级别覆盖，使夹具默认 debug 日志耗尽缓冲；下一完整门禁采用已有 `XPOD_MATRIX_LOG_LEVEL=warn`，保留 HTTP 诊断且不改变任何缓冲、预算或断言。此事实解释本轮缓冲超限，不推断为此前请求超时或产品错误的根因。
- warn 日志配置的完整命令仍退出 1：lite 161 项通过、Matrix 一项失败。四并发历史消息批次的第 39 项 PUT 在约 248.9 秒后抛 TimeoutError；其他三项约 12.5–12.7 秒返回 200，之前累计 55 个请求完成。本轮输出远低于缓冲上限，accept 与外层均 code 1、无信号、未被 kill，自有进程全部清理。实际客户端 START 后才创建独立 300 秒 AbortSignal，但没有保存 signal 状态或单调时钟，故尚不能确定此 TimeoutError 的触发来源。
- 同一冻结源码另行执行完整 full 阶段：7 文件、62 项全部通过，退出 0；这不能替代含 Matrix 的完整命令通过。现有模型分配界面的七项回归也通过，智能覆盖与清空的浏览器补证仍未完成，正式发布及用户已安装应用尚未更新。
- 最后一次同步安全元数据浏览器补证再次通过真实 OIDC、Alice WebID/Pod 精确绑定和两宽度默认角色验收。额外的新建连接场景仍在 45 秒弹窗关闭断言失败，未到模型覆盖/清空 PATCH；同 origin Pod 设置文档 PATCH 观察到 201，另有 PATCH 网络失败和四个 Pod 资源 GET 500。未保存响应原文或时间关联，因此不能判定 secret 完整持久化、500 的具体原因或网络失败是否来自清理取消。停止重复此场景，保留独立核心通过证据，夹具、浏览器及其唯一运行目录已清理。独立 full 结束后仅删除本轮自有独立数据库与 Compose 项目，默认数据库和其他项目未改动。

- 按 S-08 修正本轮错误的用户可见 “AI Gateway” 文案：默认显示“Xpod 提供”，读取、授权和空目录状态使用产品用语；底层继续读取已认证 Gateway 目录。同步规格 §5.1、§10 和 Pod 画板，删除智能/快速的误标待接入；已有能力缺模型或读取失败允许显示状态，只有未实现能力标待接入。业务状态留在 pod-settings，目录传输留在 ai-connections，认证与策略写入由 UI 宿主负责。
- 此次文案修正后，共享 Pod 包、三个 UI 构建与测试类型检查通过；四文件 88 项加既有模型分配七项，共 95 项回归通过。四个改动 TSX 定向 lint 通过，重新生成并暂存的 69 个静态文件无缺失、哈希差异或断裂引用。新文案的真实浏览器复验尚未执行。
- 单次窄范围保存诊断取得同一请求的精确时间关联：凭据设置文档 PATCH 返回 201 后即出现响应体取消，45 秒后弹窗仍未关闭；未出现此前四个 GET 500。已核对已安装 Comunica 的成功响应清理会主动取消响应体，因此不能将 201 后取消视为写入失败或归因为 AbortSignal。下一步定位 collection 持久化读回确认，原 HTTP 行为未修改。
- Matrix 的新增诊断仅在显式启用时记录单调时钟耗时、signal 状态及固定白名单 cause code，不记录原始异常内容；原 signal 创建位置、预算、HTTP 和断言保持不变。真实 api AST 回归由旧代码三项失败到补充后六项通过，测试类型检查通过，无新增 lint/脚本类型诊断。单次真实 Matrix 复验正在执行，尚无终态结论。

- 新增安全诊断后的单次真实 Matrix 聚焦复验通过（348.927 秒）：63 个事件、两个 runtime、十页同步校验，86 个 HTTP 完成，零失败；此前第 39 项历史消息本次 200 / 11.525 秒。源码与预算未变，全部自有进程清理；此次未产生 FAIL，不能据此解释旧超时来源。新版完整门禁的新隔离基础设施预检发现默认 PG/Redis/S3 端口由其他测试项目占用，尚未启动，也未复用或停止其他项目。

- 新版 Xpod 文案已在真实隔离 Bun/native 页面、390/1440 两宽度复验并目视通过；默认智能/快速均为“Xpod 提供”，空目录显示连接状态，控件无双层边框或横向溢出。单次保存的私有观察器透传原调用并在清理前恢复，取得原始 PodCollectionError / write_conflict；凭据文档 PATCH 201 后两次 SPARQL GET 200。保存冲突定位到集合读回确认，尚未修复或证明自定义覆盖/清空浏览器链路通过，所有自有进程已清理。

- 凭据保存误报冲突的真实 ORM 往返回归已锁定：唯一差异字段为 provider 的 URI 表示。共享 pod-collections 复用数据库公开 URI resolver/schema，把写入意图、乐观投影和持久化读回表示统一，保留严格字段比较及 write-only/secret 守卫；插入和更新复用同一路径，不按服务商分支。测试夹具改为真实 URI 往返而非回显写值。独立审查发现并关闭绝对 URI 数组的字节改写回归：外部绝对 URI 原样保留，仅相对地址解析。
- 最终六文件冻结后的相关源码测试 36 文件/538 项通过；根配置消费七个已构建包后 40 文件/574 项通过，生产与测试类型检查、三个 UI 构建通过，六文件 lint 无新增错误或警告、独立审查 PASS。重新生成静态资源仍为 69 文件，索引、磁盘哈希与引用一致；修复后真实保存和智能覆盖/恢复默认尚在单次验收中，完整集成命令尚未对新 URI 源码执行，未提交或发布。

- 最终 URI 冻结源码的完整集成命令退出 0：lite 32 文件 / 162 项通过（另 4 文件 / 16 项按原规则跳过），full 7 文件 / 62 项通过。本轮 Matrix 86 请求全部完成，无 FAIL；不能据此解释历史超时。测试后自有独立数据库已删除、默认数据库未修改、唯一 Compose 项目容器清理为空。
- 修复后真实凭据保存弹窗关闭、集合确认无异常、模型刷新 200，原 write_conflict 已消失。后续最小公开模型诊断发现同一 fixture 模型的发现结果含 modelType=chat，而页面 Context 中该类型缺失、capabilities=[]，智能下拉仅有默认项；不是名称错误或目录为空。两观察器已恢复，真实夹具已退出。类型持久化/投影损失仍在定位，智能覆盖/恢复默认尚未通过真实浏览器验收，未提交或发布。

- 模型类型缺口已关闭：发现结果按 models 的 `rdfType` / `capabilities` 写入，读取根据实际 RDF 类和独立能力投影；未知或基类不猜成 chat，省略元数据不清空既有声明。安装的 drizzle-solid 0.3.25 仍把 URI 数组编成 literal，模型标量插入保留公开 ORM plan/default/layout，URI 数组通过已有受鉴权 PATCH 接口单独写入；问题与移除条件已更新到既有 issue 文档。实际 converter / RDF 回归通过，独立审查通过。
- 智能覆盖读回又暴露相对链接重复拼 base 的真实 NamedNode：写入全 Pod 相对引用会得到重复的 `settings/providers/`。AI Config adapter 的六个模型字段与当前 Pod 的选项值现在统一使用 models 解析和构造的绝对引用；正确的外部绝对引用保留原字节，null 清空、undefined 保留。旧的错误绝对引用不猜测迁移，重新选择正确模型可覆盖；历史非法相对引用明确报错。没有修改 schema、共享引用 helper 或新增快速模型字段。
- 最终真实隔离 Xpod 完整流程通过：10 项 OIDC 检查和挂载 WebID/Pod 匹配；390/1440 模型设置文案；真实凭据保存和模型发现；智能选择自定义模型、刷新精确读回；清空 null、刷新恢复默认。两次保存 payload 仅含 chatModel，快速模型未写入。唯一 Bun/native 夹具和 Chromium 已退出。该证据不等同于部署候选或用户当前 Gateway 已验收。
- 用户反馈的紫色闪烁已取得原生首帧证据：自动登录在跳往账号服务前，短暂显示通用 WebID 页的紫色忙碌按钮；45 帧画布始终为暖中性色，未复现全画布紫色。仅原生自动登录等待改为既有登录框架内的中性加载内容；手动登录、失败重试、取消、切换账号与窗口尺寸保持。独立审查发现并关闭空 Account 上下文下切换账号的手动状态遗漏；相关 51 项测试和生产/测试类型、lint 检查通过，根配置 30 项回归及最终 UI 三目标构建通过。新首帧与最终完整集成仍须实测后记录。
- 最终模型引用与原生自动等待冻结源码的完整集成退出 0：lite 32 文件 / 162 项通过（另 4 文件 / 16 项按原规则跳过），full 7 文件 / 62 项通过；Matrix 86 个请求全部完成，无 FAIL。独立数据库与唯一 Compose 项目已清理，默认数据库未修改。首次新首帧夹具误传根路径、直接进入账号主页，其 8 帧仅保留为错误路由证据；不能据此宣称自动登录中间态已消失，最后验证必须明确从 `/ai-connections` 开始。
- 正确入口的新原生首帧验收退出 0：17 帧中前 11 帧明确为 `/ai-connections`，显示中性“正在登录…”和取消操作，没有通用 WebID 页的紫色主按钮；后 6 帧为实际账号交互页。根代理已直接检查跳转前代表帧。唯一 Bun/native 夹具、runner、Electron 均确认退出，私有 profile 删除。该验收没有重跑模型链路、修改窗口尺寸或宣称账号表单的正常紫色登录按钮也应消失；最终源码未变。

## rc.232 阻断与最小 Task 诊断

- 源码 `35dce6f1fc5f69b189b695d5321d68e9c0df9331` 的 CI `37126526552` 全部 22 个 job 通过，单元 763 文件 / 7529 项通过。实际候选 `37127823536` 仍在 `approved:checkpoint` 得到 `pi_assistant_error`，尚未进入审批；有效 Chat、其余独立门禁与官方旧包到实际候选的自更新通过。候选没有统一 accepted manifest，不能晋级正式发布；用户安装的 0.4.20 尚未更新。
- 新诊断只在失败时记录固定枚举、布尔、范围内数字和现有 session header 的 SHA256；不记录原始错误、请求体、凭据或 header。Pi 的真实 provider start 与 payload 回调区分调用阶段；SDK 已丢弃的 HTTP 状态明确为 null。Gateway 的结构化错误与 ApiServer 实际 finish / 已发送 close 分别观察推理失败和认证边界。相关性仅为 session，不声明唯一 Run，也不把认证状态当成上游状态。日志投影使用实际 API formatter 的完整时间戳和组件标签，私有原始日志在退出时删除，上传受控 JSON 始终标为 accepted=false。
- 手动 diagnostic-only 使用当前提交源码构建本地 runtime 镜像，load=true / push=false；复用既有 35dce6 原生镜像的不可变 digest，并验证原生输入未变、原生与服务源码及镜像 ID 各自匹配。它不重建或发布原生 SDK、Mac 包，不部署 Cloud，不替代 19 项正式候选门禁。清理在核对唯一自有容器后执行，并要求 Docker 可达和精确容器查询为空；未证明清理成功时不写成功证据。真实 Task 的授权、重试、预算和成功断言保持原值。
- 首次完整回归的 lite 162 项与 Matrix（436.304 秒）通过，full 启动因同一测试的 local ingress 先占用未来 standalone gateway 的 5741 失败，整套命令退出 1；独立数据库和 Compose 项目清理成功。完整 runtime 使用 CSS logger 的实际日志另促成双时间戳回归：只有 Docker outer ISO 加 CSS inner ISO 才接受该格式，单 ISO 仍拒绝。投影及 workflow 三文件共 36 项、生产/测试类型、新增文件 lint 与独立复核通过。下一完整运行使用现有四组基端口 16300 / 16400 / 16500 / 16600，间隔 100 覆盖各实例派生端口；原预算和断言不变。
- 最终冻结源码的完整重跑退出 0：lite 32 文件 / 162 项（另 4 文件 / 16 项按原规则跳过），full 7 文件 / 62 项，Matrix 336.679 秒通过；四个实际 ingress 分别为 16303 / 16403 / 16503 / 16603，启动无端口重叠。唯一独立数据库删除和唯一 Compose 项目 down 均退出 0，容器列表为空，默认数据库未修改。此结果是本地隔离完整集成，通过后仍须当前提交的真实 Task 诊断与后续正式候选验收。

## 历史源码诊断的身份阻断（2026-10-04，已被后续状态替代）

- `499b85eda15067248dfdf8014cdb884dbd3f5c5c` 的 CI `37133237097` 全部 22 个 job 通过。唯一手动 diagnostic-only `37133238064` 使用该提交构建的 runtime 与不可变的 35dce6 原生镜像，源码/镜像绑定通过，常规候选 job 全部跳过；真实 live 步骤在 identity 阶段失败，尚未进入 Task。模型诊断没有回执不等同于没有 HTTP 流量，也不能据此判断 Pi 故障原因。
- 同一终态 job 的受控日志读取只接受实际带时间戳的结构化进度。身份断言分类为 `cloud_pod_create_http`，HTTP 400；固定响应消息分类为 `local_preparation_unverified`。该消息合并了 SP secret 不存在、receipt 验证失败及身份绑定不匹配，具体原因仍未观察。三次读取的临时原始文件均已删除；安全报告不保留 body、错误 cause、URL、WebID、token 或 receipt。
- 当前源码的完整 Provision 串联回归确已执行并通过，不能把实际 RC 身份失败说成已修复。只读生命周期核查确认 CLI 初次注册、Cloud 节点持久化先于 API routes/listen；CLI 与完整 runtime 的 publicURL 传播存在差异，但诊断 Dockerfile 和启动声明均没有显式 publicURL，尚无证据证明该差异触发此次失败，不据此修改默认值。
- 下一最小客户端诊断只在 Cloud Pod 创建失败时观察回执字段与已准备 Pod、规范入口的匹配布尔值。未签名解析仅用于诊断，签名验证固定为 `unobserved`；原请求、授权、成功断言和原异常保持。它不能观察 Cloud SP secret，也不替代真实身份或 Task 验收。

## 2026-10-04 历史范围重置与诚实状态（已被后续状态替代）

本节保留当时的范围纠正、失败证据与操作记录。以下“当前”“最新”、四文件冻结、B-only/429 路由及旧候选策略均指该历史检查点，已被文首当前发布状态取代；不得作为现行执行指令或最终验收结果。

### 范围界线

- 本分支 `codex/desktop-shell-applets` 的开发范围是**桌面外壳与共用 applet**（依据 `docs/superpowers/specs/2026-10-01-xpod-desktop-shell-and-applets-design.md` 及画板归档 README）。矩阵（Matrix）与 AgentDirectoryProtocol 的失败**不属于**本分支开发范围。
- 最新完整集成 `bun run test:integration` 的 lite 阶段实际为 **160 项通过 / 2 项失败**（失败为 `MatrixCollaboration.integration.test.ts` 与 `AgentDirectoryProtocol.integration.test.ts`），full 阶段未启动，退出码 1；独立数据库与唯一 Compose 项目清理退出 `0 0`。**不得表述为全量集成通过。**
- 当前三个未提交的 provision 诊断代码文件（`scripts/accept-live-gateway-login-chat.ts`、`scripts/helpers/project-provision-receipt-diagnostics.ts`、`tests/scripts/provision-receipt-diagnostics-projection.test.ts`）未触达这两个失败 suite；它们是当前全量集成的既有失败事实，**不作为本分支产品的因果证据**。**未做精确 baseline 对照**，因此既不推断本分支 feature 历史全部未改，也不推断“baseline 必然也失败”。不为让门禁变绿修改他人模块、锁模型、权限或测试超时。

### 已停止的外范围工作（事实）

- 用户纠正“为什么定位其他人分支的问题”后，root 已停止 Matrix 只读诊断与 AgentDirectory 额外复现；两者不再恢复，仅作为全量集成既有失败记录。
- AgentDirectory 的 targeted 复现只完成了读命令（环境/测试栈/命令核对），**未启动 tests/infra**；两会话由 SIGINT 结束，**不是 provider 429**。
- 未对两个失败模块做任何修复、断言或预算改动，未提交、未推送、未操作远端。

### 本分支用户关注项的实现状态（源码可核对）

- **公共组件沉淀与分层**：`packages/shared-ui/src/` 已含 `native-select`、`textarea`、`checkbox`、`form-field`、`empty-state`、`focus.ts` 等共享原语；纯展示在 shared-ui，宿主布局/能力协议在 extension-sdk，业务与 Pod 数据在 applet。新组件有真实消费方，无第二套列表头或选择卡。
- **单层选中框**：`packages/shared-ui/src/focus.ts` 与 `theme.css` 约定带框控件用自身 2px 边框表达焦点、不加外层 outline/shadow；`theme.css` 有针对性规则避免控件同时绘制自身与外层焦点。
- **微信登录框尺寸**：`desktop/src/window-mode.ts` 定义短登录/恢复页共用 **280 × 400** 原生逻辑 bounds；内容区渲染 280 × 372（见既有 `shared-final-native.json` 记录）。
- **桌面图标**：`desktop/assets/brand-provenance.json` 记录选定“B · 留缝折角”与逐字节来源（ICNS sha256 `ad16e479…`），托盘五态同源生成。
- **Anthropic 官方订阅 + 官方链接旁工作台**：`packages/ai-connections/src/controller.tsx` 将 Anthropic 描述为官方 Claude 模型、Pro/Max 订阅经官方入口使用；`AiProviderCard.tsx` 把“访问官网”与声明的“打开工作台”放在同一组链接，移除重复纯工作台按钮。
- **智能 / 快速经 ai-gateway 可用**：`packages/ai-connections/src/contract/client/gateway-model-roles.ts` 定义 `smart`/`fast` 角色（`linx` / `linx-lite`），不再标“待接入”；Pod 设置消费目录实际模型，快速由 Gateway 管理，不新增 Pod 字段。
- **登录首帧紫底**：原生自动登录等待已改为登录框架内的中性“正在登录…”（`WebIdAuthBoundary` 等），不再显示通用 WebID 页的紫色忙碌主按钮；手动登录、失败重试、取消、切换账号与窗口尺寸保持。正确入口 `/ai-connections` 的 17 帧验收曾通过（历史记录）。

### 当时执行者路由（历史，用户最新 Sol 指令已替代）

- 本轮及近期实际执行者是 **OpenCode Go B 的 CLI 路由**（当前模型经 OpenCode Go 提供），**不是**桌面原生 DeepSeek 子代理入口；后者不支持该模型。上文“本机 OpenCode CLI 的可用 deepseek 配置”应理解为 CLI 路由，而非桌面 native role 被成功使用。
- 只有真实模型 provider HTTP 429 才请求切换 Sol；工具输出或测试中的 HTTP 429 不算，且不得自行切换模型。

### 当时未提交与未完成事项（历史，非当前冻结集合）

- 四个未提交文件保持冻结：`docs/superpowers/plans/2026-10-02-desktop-shell-release-audit.md`、`scripts/accept-live-gateway-login-chat.ts`、`scripts/helpers/project-provision-receipt-diagnostics.ts`、`tests/scripts/provision-receipt-diagnostics-projection.test.ts`。三个代码文件 sha256 与 `opencode-b-takeover-report` 记录一致（`3d1c61…` / `8b424e…` / `c5df09…`）；37 项 focused + 类型/lint/build/dependency 检查此前通过，无新源码变化不重跑。
- **发布阻断（本分支真实未完成，须按源码/时间分开，不能并成同一次运行）**：
  - `35dce6f1f`（rc.232，候选 `37127823536`）：Task 在 `approved:checkpoint` 得到 `pi_assistant_error`，未进入审批。
  - `499b85eda`（手动 diagnostic `37133238064`）：在 Cloud account Pod 身份阶段返回 HTTP 400 / 固定分类 `local_preparation_unverified`，**根本没有进入 Task**。这两项属于不同源码、不同运行。
  - 当前 client failure-only 布尔投影仅用于下一次识别，**不能称已修复 HMAC/身份问题**。无 accepted 19 项 manifest；stable、npm latest、生产部署均未执行；官方 `/Applications/Xpod.app` 仍为 0.4.20。
- **候选策略**：三个 provision 诊断代码文件保持未提交冻结，**不宣称已释放或已验收**。已提交的桌面变更 `499b85e` 已有完整本地集成退出 0 与 CI `37133237097` success；当前未提交集的完整 integration 失败如实保留，不修复 Matrix/AgentDirectory。不提交新诊断文件，改由独立 B delivery 针对已验证的 `499b85e` 推进新的正常候选 19 门禁，不修改产品或削弱门禁；正式发布仍必须 accepted。
- 下一最小动作属 root 协调范围：在授权下执行新的 single manual 诊断与 exact-SHA 候选 19 门禁；本分支不在无授权时修改 provision/身份默认值，也不 dispatch 新诊断。

## 2026-10-04 rc.238 历史正常候选、SDK hint 诊断与完整集成（UTC 时间）

- 已提交源码 `499b85eda15067248dfdf8014cdb884dbd3f5c5c`（rc.238）的唯一正常候选 run `37142454990`（attempt 1，`release/0.4.22`，event push，workflow 326443657）在 `deploy_and_accept` 第 16 步 "Live Gateway login and Chat acceptance" 失败；run 终态 failure，`37133237097` 为该 exact-SHA CI success。固定进度投影显示 runtime、identity、Pod 读写、Gateway 鉴权、AI connections、models、有效 Chat 全部通过，唯一 `taskApproval` 失败（`approved:checkpoint` → `pi_assistant_error`）。此事实只区分阶段，不定性 Task/HMAC 根因。
- Task 安全证据：`approved:checkpoint` 终态 failed、`errorClassification=pi_assistant_error`、`modelRequest=unobserved`、步骤计数（run.created/run.started/runtime.error/run.failed）。Task 模型回执为 `stage=payload_prepared`、`api=openai-completions`、`stopReason=error`、`retryCount=3`（SDK `auto_retry_start` 计数，**不是 HTTP 请求数**）、`credentialPresent=true`、`httpStatus=null`、`correlatedSessions` 为空。identity 层未失败，未复现此前手动 499 的 Cloud 400 身份模式。
- Mac 作业与官方旧包 → 候选 `0.4.22-rc.238` 自更新生产者通过（artifact ok，五个生命周期事件）；但 `finalize_acceptance` 未执行，因此**没有下载/字节校验实际候选 ZIP**。未生成 19 项统一 accepted manifest；stable、npm latest、生产部署与用户已安装 `/Applications/Xpod.app`（仍 0.4.20）均未晋级。
- SDK 公开接口只有 `onPayload`，无结构化响应/状态 hook；provider 失败仅保留格式化 `errorMessage`。据此新增的 `sdkErrorHint` 是**消息 hint**，`httpStatus` 保持 null，不冒充观测到的 HTTP 状态。最小 RED 11 项失败 → 聚焦 33 项 + 相关 94 项通过；独立只读审查 PASS（5 源 + 3 client 冻结 hash 一致、`sdkErrorHint` 为可选严格校验、driver 语义保持）。
- 冻结源码的完整集成 `bun run test:integration` 退出 0：lite 32 文件 / 162 项通过（另 4 文件 / 16 项按原规则跳过），full 7 文件 / 62 项通过；命令 `full-integration.exit.json` testExitCode=0（UTC 2026-10-03T19:36:48Z）。自有唯一数据库 `xpod_task_diag_1791055539868_cb2a2b8c526d`（create receipt、vector true）与唯一 Compose 项目 `xpod-task-diag-20261004-8ab46eaa` 清理：down exit 0、精确 project 容器查询 exit 0 且为空、磁盘释放；默认数据库与外来项目未改动。
- 该 sdkErrorHint 只用于后续识别“模型失败发生在 payload 之后、HTTP 状态未知”这一事实，**不是根因修复**；真实 Task 授权与 19 项 accepted 仍缺。本轮不修改他人模块，不做 baseline 对照，也不声称 Matrix/AgentDirectory 必然失败。
