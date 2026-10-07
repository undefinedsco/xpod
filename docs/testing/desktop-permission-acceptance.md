# 桌面权限与发行验收契约

2026-10-07：RC [37603049900](https://github.com/undefinedsco/xpod/actions/runs/37603049900)（source `2fd900fb7`，version `0.4.30-rc.290`）服务侧 19 项通过，桌面停在 `pod-a / pod-permission / mounted-runtime`，尚未进入 invocation 读取。该固定子条件只定位到当前 React/AI 挂载句柄，不能证明更细根因。源码发现驱动在会话认证完成后立即读取懒加载 applet，未等待其提交；新增回归确认：已认证但 applet 尚未挂载时原驱动立即失败。现改为最多 30 秒等待真实 committed tree 中同一 WebID、同一 Pod、已认证且 ready 的 host/controller；其他 Pod、匿名会话及 stale alternate 仍不能满足条件，权限和业务操作断言保持不变。这是已证明的驱动时序缺口修正；本次 RC 是否仅因该缺口失败仍未证明，需要后续真实安装包验收。

2026-10-07：RC [37594862227](https://github.com/undefinedsco/xpod/actions/runs/37594862227)（source `7d3ba5b64`，version `0.4.30-rc.289`）桌面自更新通过，权限验收停在 `pod-a / pod-permission`，公开回执没有更细子条件。随后源码与可执行回归确认驱动契约错误：服务端 `AiConnectionsInvocationKeyIssuer` 返回 `AIConnectionInvocationConfig.apiKey`，驱动却读取不存在的 `invocation.token`，必然误报 invocation 缺失。修正为引用共享类型并读取 `apiKey`；回归直接执行实际驱动的字段读取并使用真实 issuer 返回值，先 RED 再 GREEN。这个修复只纠正验收驱动，不能据此宣称真实桌面权限或后续操作已通过，仍需新 exact-source RC 证明。挂载授权、独立回读、重复授予零写入、恢复与跨 Pod 隔离断言全部保留。

2026-10-05：0.4.26 候选增加本契约。单元/本地协议通过不等于 exact 0.4.26 安装包通过。生产 Cloud 的只读诊断 run [37239166566](https://github.com/undefinedsco/xpod/actions/runs/37239166566) 确认 namespace 工作负载 replica 为 0，managed 登录与权限链尚无恢复证据。0.4.25 已发布事实与此缺项分别保存。

2026-10-06：首个正式 RC run [37425088832](https://github.com/undefinedsco/xpod/actions/runs/37425088832)（source `9d153c3b6`）服务侧 19 项与 `launch`/`provision` 全绿，在 `pod-a` 失败：驱动要求一次显式 Consent 选择，而产品对唯一精确绑定不渲染任何身份/存储选择器。singleton 只表示"没有可挑的身份/存储选项"，**不代表**"自动代替用户同意"：实际的批准提交（POST）与显式"记住授权"选择仍然必须被证明。该阶段失败是验收驱动对呈现形态过严，不是产品缺陷；修复见下节，`pod-a` 失败事实保留。

2026-10-06：第二个正式 RC run [37437352362](https://github.com/undefinedsco/xpod/actions/runs/37437352362)（source `7a67a12ce`，version `0.4.26-rc.272`）服务侧 19 项、native 构建/SDK/local runtime/image 与自更新全绿，仍停在 `pod-a`，失败 code 为 `remember-grant`。绑定证明已通过，说明上一节的单绑定修复生效；该阶段的新失败点是显式"记住客户端"选择的驱动前置条件。当时驱动侧**推断**产品为每个交互渲染一份独立的批准文档（Pick-WebID 与 Consent 是两份文档，各自持有独立勾选状态），而它只在一份文档上操作一次该选项，后一份文档便提交了默认的 `remember:false`；该"每份文档独立勾选状态"的推断**尚未被独立验证**（见下节），"该失败源于驱动与产品 ABI 不一致、不是产品缺陷"也只是当时的推断而非结论。`pod-a` 失败事实保留，未因修复而改写。

2026-10-06：第三个正式 RC run [37446580517](https://github.com/undefinedsco/xpod/actions/runs/37446580517)（source `0c0b9fb64`，version `0.4.26-rc.273`）服务侧 19 项、native 构建/SDK/local runtime/image 与自更新全绿，`deploy_and_accept` 与 Cleanup 成功、Finalize 因 desktop 失败而 skipped；desktop job 停在第 23 步（`pod-a`），`failure-safe.json` 的 code 是固定的 `unclassified`。`unclassified` 只说明抛出的**不是**已受审的类型化失败（当时代码里非受审的普通 `Error` 一律降级），**不说明**是哪一步失败：该 run 的私有 trace 只在 runner 的 `RUNNER_TEMP`，未随 artifact 上传，公开安全缺口记录只有 `stage=pod-a` 与固定 `code=unclassified`。`pod-a` 进入 stage 后约 15 秒即跳到 `cleanup`；仅凭时长**不能**证明失败发生在 mounted 权限/真实 Chat 之前——一个发生在后续操作内部的快速失败同样会得到这样的时长。因此“失败落在登录/同意阶段而非权限阶段”只是**假设（hypothesis）**，其内部具体操作**未证明（UNPROVEN）**。这是本轮诚实缺口，不得把 `unclassified` 当作 remember-grant 通过，也不得把上一轮 `remember-grant` 的原因当成这一轮的结论。

同一 run 暴露上一节修复自身的风险：把勾选改成"文档变化即重新应用"后，只要**任一份**渲染了 Consent surface 的文档没有可操作的勾选（产品压根不给，或该文档正在被产品自己提交因而 `disabled`），helper 就会抛出普通 `Error`，整个 run 退化成 `unclassified`。修复见下节：把这类观察记录到 trace、由 driver 的 remember gate 决定红绿，并把所有登录内失败收敛成受审 code + 封闭词表子条件。

2026-10-07：第四个正式 RC run [37580705243](https://github.com/undefinedsco/xpod/actions/runs/37580705243)（source `1e6d0a4d`，version `0.4.30-rc.287`）服务侧 19 项、native 构建/SDK/local runtime/image 与自更新全绿，`deploy_and_accept` 与 Cleanup 成功、Finalize 因 desktop 失败而 skipped；desktop job 仍停在第 23 步，`failure-safe.json` 的 code 是 `unclassified`，`stage=pod-a`（06:49:35.998Z 进入，06:49:56.832Z 跳到 `cleanup`），此后没有 `operations-a` 标记。与第三轮不同，本轮登录/同意阶段的类型化条件（`binding-not-retained` 等）**没有**再次出现，不能据此证明登录/同意已通过：聚合错误也可能遮蔽类型化 primary； `pod-a` 块内**除**登录/同意之外的所有真实操作（mounted 运行时句柄、`getServiceAccess`、目标/父 ACR 读取、授权应用与回读、重复授权、回滚）当时抛出的都是普通 `Error`，一律降级为 `unclassified`。因此本轮的失败点仍然**只有** `stage=pod-a` 这个事实可证明，其内部具体操作**仍为 UNPROVEN**：按 `7146c6ba4` 的既有指令，stage 时长**不能**证明是哪个内部操作失败。本轮私有 600-mode 证据未被 workflow 上传，公开记录不含栈，因此本轮不尝试猜测产品缺陷。修复见下节：把 mounted 权限阶段的真实操作边界也标注为封闭词表 token，使**下一轮** RC 的失败能被真正归因。

同一轮还暴露一个真实缺口：mounted 权限阶段的任何失败若在回滚/句柄释放时又失败，`acceptMountedPodPermissions` 会抛出 `AggregateError[primary, rollback...]`，而 driver 只看最外层类型，于是**即使 primary 已是受审类型**也会退回 `unclassified`。因此 `describeFailure` 现在会先展开 `AggregateError`，按 primary/cleanup 顺序取第一个受审失败；若其中没有任何受审类型，仍整体降级为 `unclassified`（不放宽对未知错误的处理）。

## 同一个必需 desktop check

`scripts/desktop-acceptance.cjs` 同时验证旧包到新包自更新和新包权限操作。两份证据必须属于同一 source SHA、version 和实际 zip（SHA256、SHA512、size），runtime hash 必须由 verifier 从该 zip 的 `Xpod.app/Contents/Resources/runtime/xpod` 成员独立计算。permission verifier 单独只可输出 `desktop-permissions`，不能覆盖必需 `desktop`；Finalize 缺 permission artifact、运行失败或归属不匹配均失败。

RC 的 macOS job 等本次服务部署验收成功，再使用已授权 provider secret 和 RC issuer。不同 release 分支共享 workflow-level `xpod-shared-rc-workflow` 锁且 cancel=false，跨 desktop/Finalize/cleanup 整轮串行；该锁与 job-level RC 锁不同，避免嵌套死锁和另一分支提前重建实例。RC 缩容由独立 always 下游清理执行，等待服务、桌面和 Finalize 都结束（含失败路径）；清理复用共享 RC concurrency，并分别核对本轮 seed secret 的 deployment 归属与 Postgres 在 apply 前写入的同轮 owner annotation（服务部署未创建也可清理自己的数据库），不能缩容其他运行或生产。stable 在同 SHA 的稳定版本新 zip 上重跑权限操作与旧版本自更新，两份实际证据再次组合验证。此前 RC 自更新证据仅用于定位其真实旧版 tag，不能当稳定 zip 的通过证据。

## 实际流程

1. 只从 exact zip 解出新的 App，独有 userData、cache、数据/数据库与配置 apply/backups 目录；不启动或修改原 App/profile。检查 plist、bundled binary 版本与 hash、真实 desktop IPC ownership/PID、实际运行命令及生成的配置位置。
2. 复用现有 Cloud Account/password、provision receipt、Local route、浏览器 OIDC helper，一个 Cloud WebID/card 对应两份注册 Local 存储绑定。公开 card 使用已安装 Solid client 的 `getSolidDataset`、exact WebID `getThing` 和 `getPodUrlAllFrom` 读取存储关系，支持相对 Turtle/prefix 序列化；只去 HTTP 文档 fragment，主体身份保持完整。实际 Consent 确认目标 Pod 并独立确认 callback/PKCE，不通过写 remembered storage 伪造选择。当前入口为账号卡片“切换账号”后新的 Consent 事务。
   绑定的证明分两条互斥路径：surface 出现 WebID/存储选择器或 radio 时，必须实际选中该 exact 绑定；surface 一个选择器都不渲染（`ConsentView` 的 `single = webIds.length === 1`，事务已带 `entryBinding` 时即为此形态）时，取该已渲染的 singleton/no-chooser 呈现形态这一**观察**，加上页面运行态 binding 为 authenticated 且 webId/podUrl 与目标完全一致。no-chooser 形态只是产品渲染事实，**不等于**用户同意；两条路径都要求 callback code/state 与 PKCE 证据，并各自要有实际的批准提交。已提供的选择器不匹配时不得回退到单绑定路径；若事务没有目标选项且 surface 提供了选择器，流程失败。

### 显式"记住授权"选择按批准文档生效

`ConsentView`/`ConsentPage` 的"以后不再询问"默认不勾选。UI 侧只受审到这一条：`ui/src/pages/ConsentPage.tsx` 把 `rememberChoice`（默认 `false`）与 `allowRememberChoice` 传给 `ConsentView`，勾选状态由该页实例持有，`/.account/oidc/pick-webid/` 是同一页发起的 JSON 提交端点而非独立路由（`ui/src/App.tsx` 只注册 `/.account/oidc/consent/`）。因此"每份批准文档各自持有勾选状态、Pick-WebID 与 Consent 是两份可独立勾选的文档"是驱动侧的**推断**，不是已独立验证的产品事实；`0d2dff038` 的单元夹具只证明该推断下的行为，不证明真实产品一定渲染两份文档。留作未证事实，不得再当 product ABI 断言引用。

driver 以 origin+pathname 识别当前文档（不保留 query，避免把潜在秘密写进文档键），文档变化即重新应用勾选。但重新应用必须容忍"该文档没有可操作勾选"：勾选不可见时记 `rememberClientBlocked='not-offered'`，可见但 `disabled`（产品正在提交该文档）时记 `rememberClientBlocked='disabled'`，两者都只作为观察记录，**不再直接抛错**。真正的判据仍是端到端 gate：`rememberClientRequested === true` && `rememberClientObserved === true` && 实际 `oidc/consent/` POST 的 `remember === true`；未设置过勾选的 run 仍然红，只会以受审 code 报出（`remember-grant` 带 `choice-not-offered` / `choice-disabled`），而不是退化成无法定位的 `unclassified`。勾选可见且可操作却没有被保留（`isChecked()` 与请求值不符）仍立即失败，这是产品缺陷信号，不因本修复而放行。

### 失败可诊断性

驱动失败时只把 allowlist 的 stage 与受审的固定失败 code/说明（`invalid-arguments`、`identity-binding`、`consent-binding`、`task-isolation`、`oidc-approval`、`pod-permission` 等固定枚举）写入 `failure-safe.json`（0644，位于私有目录内）。三个 code 附带**封闭词表**的子条件 token，使 CI 无需私有文件即可判断哪一步失败：`remember-grant` 带 gate 的 `choice-not-offered` / `choice-disabled` / `choice-not-retained` / `remember-not-posted`；`oidc-approval` 带浏览器批准步骤名，由 `tests/helpers/browserSolidOidc.ts` 的 `OidcApprovalError.condition` 提供：操作归因 token（`login-navigation`、`account-credentials`、`account-submit`、`webid-entry`、`remember-choice`、`binding-select`、`approval-action`、`approval-observation`）在每个真实外部 Playwright/renderer 操作边界上标注，使 `locator.setChecked/fill/press/click/selectOption/evaluate` 自身抛出的普通 `TimeoutError`/detached/strict-mode 拒绝不再退化成 `unclassified`；具体条件 token（`choice-disabled`、`binding-not-retained`、`binding-unavailable`、`webid-unavailable`、`multiple-webids`、`second-login-action`、`recovery-boundary`、`login-timeout`、`account-remember`）保留既有精确诊断，已被标注条件的失败不会被更粗的 token 覆盖。`pod-permission` 带 mounted 权限阶段的边界 token，由 `scripts/helpers/packaged-desktop-permissions.ts` 的 `MountedPermissionError.condition` 提供：`mounted-runtime`（mounted React/AI 句柄）、`service-access`（`getServiceAccess` 与 `currentPod` 校验）、`target-read`（首个目标缺失观察与授权回读）、`parent-policy`（父 ACR Link/内容读取）、`grant-apply`（授权应用与回读、父策略不变）、`grant-repeat`（重复授权零写入/零再认证）、`grant-restore`（归因回滚）；同一阶段内部抛出的普通 `Error`/renderer 拒绝也因此被归因，且已被标注的精确条件不会被更粗的外层包裹覆盖。
这些 token 只由固定枚举推导，不包含原始 trace。runner 的 stdout 投影直接给出真实受审 code（此前统一降级为 `unclassified`）；`describeFailure` 会展开 `AggregateError` 按 primary/cleanup 顺序取第一个受审失败，但只有既非本驱动、也非登录/mounted helper 抛出、且不含任何受审类型的未知错误才降级为固定的 `unclassified` 说明——不依赖正则清洗，因此 provider key、opaque token、assertion/credential dump 不会因为绕过正则而外泄。原始 message、错误名、stack 及被包装的原始 rejection cause 只进 600 权限的私有文件，从不公开。workflow 用 `if: failure()` + `if-no-files-found: ignore` 单独上传该文件。私有目录本身（含账号、Cookie/token、callback URL、输入配置）从不作为 artifact 上传，因此产物缺失不等于通过。
3. 每个 Pod 都先检查实际 HEAD：404 才记录 absent；已存在目标仍须官方 SDK 独立证明服务权限 missing。首次 authorize 后逐资源 readback，父 ACR 字节不变；再次 authorize 逐资源读取、零 ACR 写且不重新登录。资源集合只从共享声明加载，不复制路径表、不预创建目标绕过首次初始化。
4. 使用原 mounted controller 的公开 client，等待 collection adoption 后只创建一次 credential；等 pending 清空、无 conflict，独立读回 credential，核对 discovery 与发布模型的 provider/model/credential 关系及真实 quota。集合行键与 client 返回的凭据资源标识是不同表示，创建确认及删除确认均须通过共享 `credentialResource.buildId` 比较，不能直接比较原始字符串。RC.292 的同源码桌面诊断复现了创建确认超时；回归测试证明旧驱动在合法行键/资源标识组合上也会超时，修复后的单元通过仍不代表真实桌面全链路已通过。Account Key 通过真实 dialog 创建、list、配置 apply 与 revoke；验证本次新增 Account credential 唯一且和 Pod record 绑定，配置文件实际落在独有目录。HTTP 200/201 成功仍要求合法 readback 与正确 Account actor。
5. 每个 Pod 的第一笔 Chat 请求只 dispatch 一次，校验 200 和 exact marker；两次 GET 复用 descriptor 签发的同一 held invocation。A 的真实批准/拒绝/Stop、Session 终态和 grant cleanup 复用现有 live Task helper。独立读回 A 的三个 Task，B 的集合须为空，A invocation 配 B hint 拒绝，B 不能 resume A 的 Run。
6. 删除本次 provider 与 Pod/Account Key，恢复该 capability 归属的授权变化。产品已经补偿“Account 已签发、Pod 注册失败”的中间状态；producer 不另造 revoke，独立比较 Account 创建前后集合，仍有新增项即失败。保留已有授权、控制权限和其他 agent 策略。

## 证据与清理

公开 evidence 仅允许 source/version、archive/runtime hash、绑定 hash、计数和布尔结果，不上传账号、Cookie/token/key、授权 URL、输入配置或原始错误。每 Pod 的 Chat `dispatches=1` 分别实际确认；公开 operations 为两 Pod 都满足该断言的汇总。详细阶段、模型/credential 关系、Task 状态、回滚异常仅保存在 task-private/RUNNER_TEMP 600 文件中。

App 生命周期持续记录自有 PID/PPID/start identity，包括 reparented child；正常 ps 不存在与工具/权限错误区分。仅成功观测所有自有进程已终止才删除独有数据并记录 remainingOwnedPids=0；未知状态保留数据、拒绝清理成功。失败和回滚失败同时留档，始终 dispose retained handle，不用 cleanup 异常覆盖原失败阶段。

正式 runner 拒绝未提交 source/runner 文件；允许既有 `release-candidate` 的精确 version/native optional dependency 变换和明确生成目录/pack 预算文件。生成目录仅为 `dist/`、`components/`、`desktop/dist/`、`desktop/release/` 与 UI 实际产出的 `static/app/`、`static/dashboard/`、`static/settings/`；`static/landing/` 等发布源输入修改仍拒绝。生成目录允许重建并不证明缓存防篡改；archive/runtime 内容由实际包 hash 和执行证据独立绑定。所有代码/CI/文档冻结并完成最终两轮完整回归后可先提交本地 immutable SHA，再构建真实包。真实验收失败必须保留失败并后续修复，未全绿不能 stable tag/promotion。

本契约不覆盖所有 provider 订阅授权、原安装 App 全流程或 Linux bubblewrap 实测；这些缺项单列。Cloud 停服、人类授权未完成或外部额度/凭据失败均不能以单元、协议夹具或旧发行门禁代替。
