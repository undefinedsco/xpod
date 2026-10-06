# 桌面权限与发行验收契约

2026-10-05：0.4.26 候选增加本契约。单元/本地协议通过不等于 exact 0.4.26 安装包通过。生产 Cloud 的只读诊断 run [37239166566](https://github.com/undefinedsco/xpod/actions/runs/37239166566) 确认 namespace 工作负载 replica 为 0，managed 登录与权限链尚无恢复证据。0.4.25 已发布事实与此缺项分别保存。

2026-10-06：首个正式 RC run [37425088832](https://github.com/undefinedsco/xpod/actions/runs/37425088832)（source `9d153c3b6`）服务侧 19 项与 `launch`/`provision` 全绿，在 `pod-a` 失败：驱动要求一次显式 Consent 选择，而产品对唯一精确绑定不渲染任何身份/存储选择器。singleton 只表示"没有可挑的身份/存储选项"，**不代表**"自动代替用户同意"：实际的批准提交（POST）与显式"记住授权"选择仍然必须被证明。该阶段失败是验收驱动对呈现形态过严，不是产品缺陷；修复见下节，`pod-a` 失败事实保留。

2026-10-06：第二个正式 RC run [37437352362](https://github.com/undefinedsco/xpod/actions/runs/37437352362)（source `7a67a12ce`，version `0.4.26-rc.272`）服务侧 19 项、native 构建/SDK/local runtime/image 与自更新全绿，仍停在 `pod-a`，失败 code 为 `remember-grant`。绑定证明已通过，说明上一节的单绑定修复生效；新的失败点是显式"记住客户端"选择的驱动前置条件：产品为**每个交互渲染一份独立的批准文档**（Pick-WebID 与 Consent 是两份文档，各自持有独立勾选状态），而驱动只在一份文档上操作一次该选项，后一份文档便提交了默认的 `remember:false`。该阶段失败同样是验收驱动与产品 ABI 不一致，不是产品缺陷；修复见下节，`pod-a` 失败事实保留，未因修复而改写。

## 同一个必需 desktop check

`scripts/desktop-acceptance.cjs` 同时验证旧包到新包自更新和新包权限操作。两份证据必须属于同一 source SHA、version 和实际 zip（SHA256、SHA512、size），runtime hash 必须由 verifier 从该 zip 的 `Xpod.app/Contents/Resources/runtime/xpod` 成员独立计算。permission verifier 单独只可输出 `desktop-permissions`，不能覆盖必需 `desktop`；Finalize 缺 permission artifact、运行失败或归属不匹配均失败。

RC 的 macOS job 等本次服务部署验收成功，再使用已授权 provider secret 和 RC issuer。不同 release 分支共享 workflow-level `xpod-shared-rc-workflow` 锁且 cancel=false，跨 desktop/Finalize/cleanup 整轮串行；该锁与 job-level RC 锁不同，避免嵌套死锁和另一分支提前重建实例。RC 缩容由独立 always 下游清理执行，等待服务、桌面和 Finalize 都结束（含失败路径）；清理复用共享 RC concurrency，并分别核对本轮 seed secret 的 deployment 归属与 Postgres 在 apply 前写入的同轮 owner annotation（服务部署未创建也可清理自己的数据库），不能缩容其他运行或生产。stable 在同 SHA 的稳定版本新 zip 上重跑权限操作与旧版本自更新，两份实际证据再次组合验证。此前 RC 自更新证据仅用于定位其真实旧版 tag，不能当稳定 zip 的通过证据。

## 实际流程

1. 只从 exact zip 解出新的 App，独有 userData、cache、数据/数据库与配置 apply/backups 目录；不启动或修改原 App/profile。检查 plist、bundled binary 版本与 hash、真实 desktop IPC ownership/PID、实际运行命令及生成的配置位置。
2. 复用现有 Cloud Account/password、provision receipt、Local route、浏览器 OIDC helper，一个 Cloud WebID/card 对应两份注册 Local 存储绑定。公开 card 使用已安装 Solid client 的 `getSolidDataset`、exact WebID `getThing` 和 `getPodUrlAllFrom` 读取存储关系，支持相对 Turtle/prefix 序列化；只去 HTTP 文档 fragment，主体身份保持完整。实际 Consent 确认目标 Pod 并独立确认 callback/PKCE，不通过写 remembered storage 伪造选择。当前入口为账号卡片“切换账号”后新的 Consent 事务。
   绑定的证明分两条互斥路径：surface 出现 WebID/存储选择器或 radio 时，必须实际选中该 exact 绑定；surface 一个选择器都不渲染（`ConsentView` 的 `single = webIds.length === 1`，事务已带 `entryBinding` 时即为此形态）时，取该已渲染的单绑定事实，加上页面运行态 binding 为 authenticated 且 webId/podUrl 与目标完全一致。两条路径都要求 callback code/state 与 PKCE 证据。已提供的选择器不匹配时不得回退到单绑定路径；若事务没有目标选项且 surface 提供了选择器，流程失败。

### 显式"记住授权"选择按批准文档生效

`ConsentView`/`ConsentPage` 的"以后不再询问"默认不勾选，且**每份批准文档各自持有勾选状态**：`Pick-WebID` 与 `Consent` 是两次独立提交（`/.account/oidc/pick-webid/`、`/.account/oidc/consent/`），后一次不会继承前一次的勾选。因此带 `rememberClient` 的登录场景必须在**每一份**渲染了该选项的批准文档上重新设置并校验该勾选，不能只在首次出现时设置一次；driver 以 origin+pathname 识别当前文档（不保留 query，避免把潜在秘密写进文档键），文档变化即重新应用。只有"每份同意文档的实际 POST 都携带该选择"才算记住授权成立，因此 `consentRememberPosted` 仍取实际 POST 的 `remember` 值。

### 失败可诊断性

驱动失败时只把 allowlist 的 stage 与受审的固定失败 code/说明（`invalid-arguments`、`identity-binding`、`consent-binding`、`task-isolation` 等固定枚举）写入 `failure-safe.json`（0644，位于私有目录内）。`remember-grant` 例外地附带一个**封闭词表**的子条件 token（`choice-not-offered` / `choice-not-retained` / `remember-not-posted`），使 CI 无需私有文件即可判断 gate 的哪一段失败；该 token 只由布尔条件推导，不包含原始 trace。runner 的 stdout 投影现在直接给出真实受审 code（此前统一降级为 `unclassified`）；任何非本驱动抛出的类型化错误一律降级为固定的 `unclassified` 说明——不依赖正则清洗，因此 provider key、opaque token、assertion/credential dump 不会因为绕过正则而外泄。原始 message、错误名与 stack 只进 600 权限的私有文件，从不公开。workflow 用 `if: failure()` + `if-no-files-found: ignore` 单独上传该文件。私有目录本身（含账号、Cookie/token、callback URL、输入配置）从不作为 artifact 上传，因此产物缺失不等于通过。
3. 每个 Pod 都先检查实际 HEAD：404 才记录 absent；已存在目标仍须官方 SDK 独立证明服务权限 missing。首次 authorize 后逐资源 readback，父 ACR 字节不变；再次 authorize 逐资源读取、零 ACR 写且不重新登录。资源集合只从共享声明加载，不复制路径表、不预创建目标绕过首次初始化。
4. 使用原 mounted controller 的公开 client，等待 collection adoption 后只创建一次 credential；等 pending 清空、无 conflict，独立读回 credential，核对 discovery 与发布模型的 provider/model/credential 关系及真实 quota。Account Key 通过真实 dialog 创建、list、配置 apply 与 revoke；验证本次新增 Account credential 唯一且和 Pod record 绑定，配置文件实际落在独有目录。HTTP 200/201 成功仍要求合法 readback 与正确 Account actor。
5. 每个 Pod 的第一笔 Chat 请求只 dispatch 一次，校验 200 和 exact marker；两次 GET 复用 descriptor 签发的同一 held invocation。A 的真实批准/拒绝/Stop、Session 终态和 grant cleanup 复用现有 live Task helper。独立读回 A 的三个 Task，B 的集合须为空，A invocation 配 B hint 拒绝，B 不能 resume A 的 Run。
6. 删除本次 provider 与 Pod/Account Key，恢复该 capability 归属的授权变化。产品已经补偿“Account 已签发、Pod 注册失败”的中间状态；producer 不另造 revoke，独立比较 Account 创建前后集合，仍有新增项即失败。保留已有授权、控制权限和其他 agent 策略。

## 证据与清理

公开 evidence 仅允许 source/version、archive/runtime hash、绑定 hash、计数和布尔结果，不上传账号、Cookie/token/key、授权 URL、输入配置或原始错误。每 Pod 的 Chat `dispatches=1` 分别实际确认；公开 operations 为两 Pod 都满足该断言的汇总。详细阶段、模型/credential 关系、Task 状态、回滚异常仅保存在 task-private/RUNNER_TEMP 600 文件中。

App 生命周期持续记录自有 PID/PPID/start identity，包括 reparented child；正常 ps 不存在与工具/权限错误区分。仅成功观测所有自有进程已终止才删除独有数据并记录 remainingOwnedPids=0；未知状态保留数据、拒绝清理成功。失败和回滚失败同时留档，始终 dispose retained handle，不用 cleanup 异常覆盖原失败阶段。

正式 runner 拒绝未提交 source/runner 文件；允许既有 `release-candidate` 的精确 version/native optional dependency 变换和明确生成目录/pack 预算文件。生成目录仅为 `dist/`、`components/`、`desktop/dist/`、`desktop/release/` 与 UI 实际产出的 `static/app/`、`static/dashboard/`、`static/settings/`；`static/landing/` 等发布源输入修改仍拒绝。生成目录允许重建并不证明缓存防篡改；archive/runtime 内容由实际包 hash 和执行证据独立绑定。所有代码/CI/文档冻结并完成最终两轮完整回归后可先提交本地 immutable SHA，再构建真实包。真实验收失败必须保留失败并后续修复，未全绿不能 stable tag/promotion。

本契约不覆盖所有 provider 订阅授权、原安装 App 全流程或 Linux bubblewrap 实测；这些缺项单列。Cloud 停服、人类授权未完成或外部额度/凭据失败均不能以单元、协议夹具或旧发行门禁代替。
