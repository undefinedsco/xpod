# RC PostgreSQL / QLever 接入与验收

历史基线记录（2026-10-03）：此前整合基于 `release/0.4.22` 的
`9460a7e0249af5c58896bd386b5f8372e250ca81`，分支为
`codex/agentfs-current-release`。新增三个 release 提交已纳入基线；六个冲突路径已完成语义整合，相关专项 125 通过、1 跳过，当前已无未合并项；整合后的完整回归仍待执行。此前 `ab583de` 的兼容代码审查完成；历史两轮失败保留如下。修正过时的 RC 静态测试契约后，该旧基线原始完整集成实际退出 0：Lite 162 通过/16 跳过，Full 62 全部通过，8,277 项覆盖路径前后稳定。
本工作树尚未发布、部署或验收新原生 QLever RC。远端既有 candidate 流水线的实际分层证据见下，不能将 QLever 夹具、旧 RC223 或客户端预览的通过记录算作新后端通过。

## 当前 RC → SealOS 执行顺序

用户已授权先发布候选镜像，再通过现有 CI 的 SealOS 凭据完成实际验证；不发布 stable。开发分支已 fast-forward 到 `cc08174163d71d5bbbb22e13b0b88078d9649e52`，8 处冲突已语义合并，相关 148 项回归及源码／测试类型检查通过，依赖补丁和 workspace、Components.js、UI 官方构建已恢复；最终原始完整门禁已通过。保留已有 419 路径登录、UI、Pod 生命周期与服务运行时修复。服务最低 Bun 1.4.2；新外部工具已完成官方校验，旧 1.3.8 门禁不认证整合源码。

GitHub `rc` environment 已存在 kubeconfig、runtime、seed 和真实 provider 配置，现有流水线的 namespace/DNS prerequisites 实际通过；这不等于 registry 拉取或部署通过。新 Private17 authority 尚未生成。执行顺序为：最终源码门禁 → 新 RC 的 exact source/digest 镜像与 Public16 → 独立 private component-only CI 对同一镜像和固定 PG17 测试并生成摘要 → 负责人独立验证并运输 sanitized 摘要 → 原失败 deploy job 复用原成功 build outputs → namespace 独占拉取预检 → SealOS 部署与真实公共协议、账号／Pod、权限、Chat 和重启验收。Private17 CI 接线及隔离门禁已通过，提交 `18e56f3ec439bb2650828ec88f5de8a8cdc3c892` 已推送独立开发分支；真实 workflow 执行尚待完成，不能用旧 existing-rc 模式或构造哈希替代真实生产。现有 release/0.4.22 和 /0.4.23 不覆盖、不取消；只读核对其最新候选运行均已失败结束。 本轮选下一候选 `release/0.4.24`，官方同步 root／desktop／平台版本与锁文件，版本相关 59 项回归通过；CLI 仍为 preview.2。创建 ref 前再次检查，不 force-push。

最新提交前 whole producer 13395 由容量监督器停止，未取得完整 Lite/Full 结果；日志和 owned 清理已闭合。后续固定 Bun 1.4.2 的 producer 50759 原始完整回归实际退出 0、signal null、343.921 秒：前置 30 项、Lite 163 通过/16 跳过、Full 63 全通过（含 CloudManagedPodDeletion）。ROOT 独立核验 8,916 项源码／SDK／dist／static 正文、前后集合、闭合日志与进程组／容器／卷／探针清理；runner SHA256 为 `c47673c52101dbc082dc267f6ea7ed9f1b63eea333216d3b05d27459e22f822f`。它来自独立官方源码编译，并将在发布 commit 上重新绑定，不由被测镜像自证。缺少 runner/Public16 artifact 的既有流程不阻塞独立 component dispatch，最终实际 CI 结果仍必须收齐。客户端 native kit5 只通过完整源码核验，最新 Mac/Linux 安装挂载、RSS／崩溃验收与公开 preview.2 继续独立门禁。

## 最新既有 RC 流水线的分层证据

已只读核对 [candidate 37107807694](https://github.com/undefinedsco/xpod/actions/runs/37107807694)，输入源码为 `9460a7e0249af5c58896bd386b5f8372e250ca81`。服务及 native 构建 job 成功；名为“Live Gateway login and Chat acceptance”的步骤实际在任务审批前失败，并非登录或聊天失败。该日志分别证明 client login/身份解析、Pod PUT/GET、Gateway 凭据、models HTTP 200 及 chat HTTP 200 精确验收标记通过。

任务 approved case 已取得 queued 回执，但 producer 在请求审批前变为 failed。安全 Task artifact 与远端 digest 一致，包含清理成功，不含内部 Run 标识、阶段或错误码；现有日志无法证明原因。失败后的 `invalid_client` 没有 Run 关联，不能据此修认证。后续服务验收材料创建、上传与 Finalize 均跳过；这些成功层级不能证明 Private17/public16、精确镜像配对、任务审批、挂载复验或 RC 晋级通过。当前准确 Pg17 digest 未在本地缓存，现有 QLever 缓存不得替代它。

日志与安全材料保存在 ignored `gpt-6.1-sol-current-native-rc-inventory/`，原始日志闭合 SHA 为 `f04fba6addca22e9923b3fff0c728f0f29ff4449f0e7e5be7d1591d677aef2ac`，任务原因边界回执为 `74a33172ac2cc95e20b49bff1ab3aee58513468e3dbb17e7d10d80e8aecedd34`。这与本机过期登录的失败是不同验收上下文。

## 当前证据与限制

当前 Task 路径新增只投影固定 code/stage/status 的首个失败诊断，API、live consumer 和安全 artifact 共用同一个 canonical helper；不公开原始错误、prompt、凭据或 metadata。五文件 77 项专项实际通过，独立源码复审无剩余 P1/P2。此改动是为下一次真实 RC 保留可定位证据，现有 `37107807694` 根因仍未知。当前整合的包构建、依赖检查、源码／测试类型检查与组件生成通过；原始完整集成因另一个 worktree 的固定端口占用在启动前停止，未产生测试进程或结果。必须在同一最终源码上继续原始完整门禁和真实 RC，不能引用旧基线绿色结果替代。

账号 B／DeepSeek v4.1 Flash 的原始 `bun run test:integration` 单次自然退出 0，
signal 为 null，耗时 145953 ms，于 UTC 2026-10-02 23:52:57 完成。
Lite 32 文件通过 / 4 跳过，162 测试通过 / 16 跳过；Full 7 文件、62 测试通过。
Matrix 协作用例 52248 ms，仍执行四并发、63 事件、两个运行时和分页大于 1 的断言。
此次没有观察器、诊断预算覆盖或扩大期限。

24 个授权源码/测试路径运行前后哈希一致，但完整运行入口、实际 SDK 和生成产物
的前后快照未交付。记录实际子进程退出码的 Bun reaper 未等待输出流 finish；
保存日志包含最终 Lite/Full 汇总，但仍有尾部截断风险。其 `timedOut: false` 为
固定字段，不能作为独立外层 watchdog 证据。代理自然退出不等于最终验收通过。
原类型检查经 `tail` 管道执行的 exit 0 不能证明编译器成功；ROOT 已直接补验源码、测试及 CLI 类型检查，三个编译器均实际退出 0。这些独立问题随后已修复。GPT‑6.1 Sol 接手最后的输出路径边界，43 项测试与直接编译门禁通过；独立真实 Bun 的 8 个路径/权限探针通过。旧完整运行的缺失快照不能事后补造，整合后须重新执行原始完整集成。

原始退出记录 SHA256：
`8326f191e0f4a6a9c3edf2f369b88a044bae16573632ccf1a444bdf57539b148`；
监督回执 SHA256：
`c7408e2fc603424f143a69326085d12763f13680953bba5fed743647a468ccbb`。
私密原始材料位于当前 worktree 的 ignored
`.test-data/agent-directory-workers/opencode-go-b-current-release-compatibility/`。

## 当前冻结完整回归失败

ROOT 在 `ab583de` 整合基线上运行原始 `bun run test:integration`，测试生产者实际退出 1、无 signal，耗时 643374 ms；8,272 项源码、入口、SDK 与生成产物前后快照全部一致，日志流关闭后取 hash。Lite 为 30 文件通过 / 2 失败 / 4 跳过、159 测试通过 / 3 失败 / 16 跳过，Full 未进入。Python 监督器自己的退出码不能替代这个生产者退出码。

本次 Matrix 的 request 84 是 `pagination-sync` GET，在 262874 ms 后收到 HTTP 500；它不是旧 request 40 的 PUT。helper 实际退出 1、未被 kill，未触发 900 秒计时。同一操作的首个已证明失败边界为 `events.select`：通过 drizzle-solid 的消息查询在 262107 ms 后抛出 TimeoutError，SDK 内具体 await 仍未知。不能将它移用为旧 PUT 的归因。

ChatKit 单次隔离诊断 22 项通过；Matrix 单次隔离诊断在准备 Pod 时因 6000 ms 账号写锁到期返回 500，workload 没有进入。这是另一失败边界，尚未证明与完整测试 GET 有共同原因。默认失败快照与 fetch/body 分段记录已加入，未修改期限、绕过 SDK 或自动重放写入；诊断通过不算因果修复。

当前证据在 ignored `root-current-release-acceptance/formal-whole/`，result/log hash 与 helper 材料均保持私密。语义专项通过不能替代这次失败；当前源码尚不允许提交或晋级。

## 后续完整回归与测试契约修复

另一轮原始完整集成的 producer PID26552 自然退出 1、signal null，单调计时
225364.614 ms；8,277 项冻结路径前后一致，日志关闭后取 hash。Lite 31 文件通过 /
1 失败 / 4 跳过、161 测试通过 / 1 失败 / 16 跳过，Full 未进入。这轮 Matrix 与
ChatKit 通过，仅说明本次未复现历史等待，不能证明上述原因已修复。

唯一失败为 `XpodSettings.integration.test.ts` 的静态源码字符串断言：仍要求旧
navigationLabel selector 和三条旧路由。已同步到当前 href selector 与 canonical
`/pod/models`、`/device/network`、`/device/services`；会话、真实点击导航及禁止
local fixture 的断言保留。focused case 实际退出 0，1 通过／28 未选；它没有启动
CSS，不能替代修复后的原始完整回归。

该轮原始材料为 ignored `formal-whole-sol-final/`。stdout SHA256 为
`02c38bc48e172e2e8f92a69e3ff14a1e30ccadcbd5cc3fa97007bed98df95da5`，stderr 为
`2760f9de42de3d3f178f148df228656f3953ab91114f63c4d0b31d23556256cd`。

## 2026-10-03 ab583 基线完整回归通过（历史证据）

原始 `bun run test:integration` 的实际 producer PID92064 自然退出 0、signal null，
单调计时 204886.612 ms。Lite 为 32 文件通过/4 跳过、162 测试通过/16 跳过；
Full 为 7 文件、62 测试全部通过。8,277 项源码、入口、SDK、配置与生成产物
前后快照无变化，日志关闭后校验 SHA。stdout 为
`bb93fc40612d566c98012a31e756ea0f5f60e63509af5e9ff71e19b1eba17e69`，
stderr 为 `beaa04a76f6071edf5675391fd0d04d19d2ab92a055139a7830dbd35d81ebf41`。
原始材料为 ignored `formal-whole-sol-post-contract/`，ROOT 验收回执为
`formal-whole-sol-post-contract-root-review.json`。未筛选、加观察器或放宽原预算。
该隔离栈使用 native QLever 测试夹具，不能算新原生镜像或真实身份验收。

当前实际 Gateway 的 `/service/status` 可达，但现有登录已过期，一次正常刷新
返回 `invalid_client`；尚未进入当前 Profile/Pod/Chat 验收。未创建替代账号或绕过 SDK。

## 长等待仍未解决

旧基线 `44bfe72b` 的一次未经观察器的完整回归实际退出 1：Lite 161 passed /
16 skipped / 1 failed，Full 未进入。请求 id=40 的 backlog PUT 在
273675.797 ms 后收到 HTTP 500；同批另外三条约 1175–1448 ms 完成。
客户端每条请求独立的 300 秒预算尚余约 26 秒，helper 的 900 秒计时未触发。
这不是正常 PUT 写入性能，也不是已证明的客户端截止。

该次服务日志只确认 `TimeoutError` / 数值 code 23，没有同次操作的首个失败
await。另一个历史样本曾定位到通过 drizzle-solid 执行的写前 SELECT，但不能
移用它的归因。后续两轮完整集成通过仅证明未复现，不能声明 273 秒异常已修复。

旧失败 stdout SHA256：
`73afc93434fa523d8d5e7d834f865891b988eba6e7fa6289e1cc72b59d0dd284`；
stderr SHA256：
`2758ac45ce8e68a4710575c6dbc592545ec920b7761530c5941715ded2225a74`。
新集成测试已在失败时保存 helper 已缓冲的 stdout/stderr，以便下次取得同操作
阶段证据；不扩大超时、不绕过 drizzle-solid、不自动重放写入。

## Pod 与服务内部状态边界

Pod 业务 RDF 继续优先通过 drizzle-solid 和 Solid 授权接口访问；客户端不直连
数据库，也不把 Pod 下的资源变成自行维护的 SQL 表。
TaskCredential 的 SQL 表属于已有服务内部任务凭据状态。初始化竞争修复由 Store
等待唯一初始化入口，在 PostgreSQL 同一事务、同一连接上使用事务 advisory lock。
这不构成 Pod 业务数据绕过 Solid 的许可。

## 当前发布基线的邻接失败

上游 `ab583de` 已修复 Electron 安装二进制和导航抽屉测试复用；保留这些改动。
[当前 CI](https://github.com/undefinedsco/xpod/actions/runs/37081330802) 仍缺 ripgrep，并有子进程 stdout 完结采集问题；现有兼容 CI 补丁覆盖前者。12 个收集值有两种不足以证明产品密钥竞争，需先等待 child close 并验证全部输出格式。

[当前 RC](https://github.com/undefinedsco/xpod/actions/runs/37081326630) 的桌面单测 182 项通过，但完整打包获取固定 Inngest docs tree 返回 HTTP 403；现有日志没有原因分类，不能断定限流。构建步骤尚未把已有 GitHub token 传入该 API 请求。部署 E2E 仍等待过时的 Settings 标题；需按当前 canonical 页面校准，不能跳过功能断言。这些运行仍没有新 native17 或真实 Chat 证据。

当前工作区已修复 source 层的 token 传递，仅对固定 GitHub tree URL 发送认证并拒绝重定向；28 项回归通过、1 项真实材料测试跳过。stdout 收集等待 child close，原 12+2 子进程全部验证格式后检查唯一性；这些本地证据不代表上述 CI 已重跑通过。RC E2E 已校准到当前页面，实际浏览器验收仍待执行。

## 已实现的 native RC 准入与未接通边界

`config/cloud.qlever.json` 导入当前 Cloud profile，只替换相同层级的原生能力与
SPARQL engine，保留 PG DSN、FTS/VEC、hot operators 和维护能力，不设 Comunica
回退。安装态 helper 使用 Bun。源码、测试类型与 Components 三项门禁实际退出
0；此前新增 helper 的 Bun 全局类型错误实际退出 2，已修复并保留失败记录。
资源清理的 fake 回归与独立安全复审不等同于精确镜像或真实集群验收。

唯一 PG 候选输入为
`ccr.ccs.tencentyun.com/undefineds/xpod-rdf-postgres@sha256:de247beacf40af59a9e209e02cf257b0bdb33d9f47a7f77e4eb379635a2488ba`。
它还没有与新 service 实际配对验收。Public16 使用每轮独立数据库，核对 OCI
source/revision、当前 compiled runner、语义、search、ABI 和 owned cleanup；
namespace 拉取预检使用独立 nonce、实际 UID/imageID、Always 与无业务 volume。
Docker 按不可变 ID 清理，Kubernetes 使用 UID precondition 原子 DELETE，保留
foreign 对象和 primary failure。

Private17 固定夹具 hash 为
`09e389146adc51a10a26785a34ef471c66d8bbf00f61b0b69d536d29874120b8`，
夹具不得上传。独立 installed-component producer 已实现：独立 owned 镜像 pair
与 DB、固定17-case validator、保密 stdin fixture、不可变资源清理，确认 DB 和
资源缺席后才生成脱敏摘要。最终 receipt 写入失败保留原 primary；真实 EACCES
和显式注入 ENOSPC 的回归通过，实际磁盘耗尽未测试。私有完整静态门禁随后
通过：Python15项、Bun六文件57项零失败，实际producer PID98757退出0/null、
231.073秒，5源/9冻结文件/SDK原始字节前后稳定。首次缺少源码路径ENV的前提
失败保留，纠正已有两键后原样重跑，未放宽预算。

公共入口改为单个有 64KiB 上限的严格 JSON：外部 ROOT authority SHA 先于解析，
绑定 exact source/pair/runner、固定夹具/validator/producer 与闭合清理。固定
`undefinedsco/xpod` Release 的 `private17-admission.json` 只负责运输，不是信任根；
沿用现有 `github.token`，不执行私有 CJS。两套件90项、最终绑定31项通过。
缺材料时仍在凭据轮换和部署前拒绝。真实 pair 的 private17/public16、摘要取得、
失败 deploy job 原源码 rerun 和变量刷新尚未运行；不能仅设置 vars hash 或创建
同形 JSON 就称准入通过，更不能将 component 证明称为 RC/replay 验收。

## 0.4.24-rc.234 的真实发布与阻点

公共源码 `440f3be336e685ce944ef0478c8823d0c2375908` 已正常推送到
`release/0.4.24`。实际 candidate run 为 `37130973254`，版本为
`0.4.24-rc.234`，服务构建成功，镜像为
`ghcr.io/undefinedsco/xpod@sha256:5918ffc3d6f3060aa5b8fec994076070fdd600a50fed2da69b2b1293aecaebc1`。
原始完整集成的 163/16 与 63 全通过证明发布时源码，不能覆盖后续修复。
该 RC 整体失败，尚未完成 namespace 镜像拉取、部署或真实 Gateway 验收。

公共 deploy 在 registry 配置阶段拒绝；Public16 和 Private17 gate 均未执行。
随后使用运维文档明确引用的现有 CO 配置只读验证同一 namespace，证实
`tcr-creds` 不含 CCR authority，其唯一 entry 属于另一个 registry。
HTTPS registry key 的兼容性修复及固定安全错误分类已完成专项测试，但不能
把地址规范化称为有效 CCR 凭据的恢复。本机 exact CCR keychain entry 的
manifest 认证交换也返回 HTTP401，没有可用凭据证明；未修改该 namespace secret。

私有 component-only run `37132221419` 在 CO TLS preflight 失败，producer
没有启动。私有诊断源码 `854adbe030c92bf4b2f04f6b7a1a690b174720c6` 的
run `37133379531` 保留原失败，上传了私密证书元数据；未关闭 TLS、替换
信任根或生成 admission。已有 CO 运维配置以当前 CA 实际通过 namespace
TLS 和认证，随后仅通过 stdin 恢复已有 `SEALOS_CO_KUBECONFIG`。
下一次实际 CI 仍需验证恢复结果，并先取得有效的原有 CCR 凭据。

桌面 clean consumer 真实复现了 Inrupt CommonJS 加载 JOSE browser ESM 的
Bun 错误。后续 SDK 修复在发布边界链接依赖，保持 React/Zustand 外部依赖及
原有类型接口；未增加 consumer 补丁前置。Bun/Node 的 ESM/CommonJS 消费、
原七包 tarball 的所有导出、类型和 CSS，以及源码和测试类型门禁通过。
NOTICE 随 tarball 包含实际六个内嵌依赖，SDK 压缩包增加 247,985 bytes。
SDK 版本仍为 0.1.1，仅证明 RC 本地 tarball；独立 registry 发布须使用新版本。
修复后的原始完整集成实际退出 0、signal null，耗时 315.520 秒：前置 30 项、
Lite 163 项通过／16 项跳过、Full 63 项全部通过。负责人独立核验全部 8,919
个覆盖路径正文、闭合日志和前后快照，测试进程、专属容器及卷均已退出并清理。
此结果只证明隔离集成；新 RC 发布、SealOS 与最新 AgentFS 原生验收仍须单独验证。

## 新 native RC 的发布门槛

以下为待完成门槛，不能把计划、mock 或静态通过写成真实验收通过。

1. 保留当前 Cloud 配置的能力，增加显式原生 QLever profile；原生模式不得静默
   回落到 Comunica。保留最新版 source/artifact/desktop/package 校验。
2. 服务和 PostgreSQL 均固定不可变镜像。任何 RC 凭据轮换或部署之前，先完成
   精确镜像的成对语义检查及 namespace 内独立 fresh Job 的真实拉取预检。
   只能使用已有授权凭据及精确 `ccr.ccs.tencentyun.com` authority，不猜测密钥、
   改用镜像站、替换 tag 或创建另一套认证事实。
3. 实际 PostgreSQL 必须具备 vector、xpod_rdf、xpod_qlever，SQL ABI 为 1 且 ready。
   Public16 当前夹具 hash 为
   `c15f1bba83aff573b9e3bab685bf66bacb35cd82bac7a13e93e8163559ed5778`；
   private17 必须单独核对其来源和夹具，不能互相代替。
4. 安装态 conformance 绑定当前服务源码、runner/fixture hash、真实 Pod UID 与
   imageID。使用本次独占数据库，检查并清理，仅清理已证明本次拥有的资源。
5. 真实 Gateway、规范账号/Pod、授权及 search，随后同轮服务重启、原凭据继续
   可用、固定 63 事件负载必须分别有成功证据。`/v1/models` 不代替真实 Chat。
6. 验证公开客户端与新 RC 的兼容，并对新增 Rust 修复从新 source kit 重建的
   macOS NFS / Linux Node 22 FUSE 包重新验收目录、Range、dirty、重挂恢复、
   条件提交与冲突保留；另测大文件 RSS。旧 RC223 和旧 helper 结果不代替新版。
7. 最终源码直接类型/静态检查与原始完整集成通过；保存全部相关源码、入口、
   SDK、生成产物的前后快照及已写完的私密原始日志，再提交和晋级 exact candidate。

客户端公开包、已通过平台与代理路径限制见
[预览发行记录](../xpod-cli-preview-release.md)。NAS 实机、x64 和 Windows 挂载
尚未验收；不将 Linux ARM64 容器结果泛化为这些设备通过。
