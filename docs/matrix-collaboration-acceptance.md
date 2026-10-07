> 本文保留历史协作验收；当前迁移状态见[迁移清单](solid-multiparty-migration.md)，最终指标以[验收标准](solid-multiparty-acceptance-criteria.md)为准。

> **最新状态（2026-10-05）**：下文较早的“当前”段落均为历史记录。按用户最新指示，唯一执行者已切换到 OpenCode Go A，经 Codex 子进程显式选择已配置的 `opencode-go` provider；真实连接检查退出 0。Root 负责设计及独立验收，仅 A 实际 HTTP429 才回到 GPT‑6.1 Sol。

> 用户要求直接修改的 drizzle-solid 上游已在 `codex/drizzle-solid-conditional-writes` 实现公开完整快照、exact subject 选定属性条件 update／delete、强版本单次 N3 backend 与 applied／conflict／unknown／unsupported 合同。完整单元 **87 文件／891 用例通过**，构建、类型、lint 通过；Root 独立 **41 用例**、公开调用方类型与 diff 检查通过，**1,377 输入无变化**。此限定验收包含真实 CSS 快照／未资格拒绝，以及独立编译、身份与错误边界；尚不代表真实 CSS 严格条件 mutation 成功。详见[ORM issue](issues/drizzle-solid-canonical-protocol-cas.md)。Xpod 依赖尚未切换。

> 真实生产测试器的秒级 ETag 碰撞仍待修。Xpod socket 整响应缓冲已修：12 专项及完整 runtime **28 文件／228 用例**、源码及测试类型通过；Root 实际 Node socket 与实际 Bun consumer／独立 Node producer 通过。前次冻结的原通知测试启动 hook 在原 **120 秒**期限内失败，**14 用例未执行**；真实诊断确认缺失默认路径下的 QLever native executable。显式选用现有安装产物后，Root 独立复跑原通知 **14／14，实际退出 0，4,275 输入无变化**，同时 Node socket 与实际 Bun consumer 检查通过。此证据仅限 Node 源码运行时及已选 native executable，安装 manifest 缺少 sqlite-runtime role，不能推广到 Mac Bun 冷交付。A 正修复实际文档版本，原完整集成 actual −15／未完成仍未豁免；不能用默认 unsupported 或局部通过宣布完成。

> Local 权威／Vector／共享 SQLite 的旧限定冻结 **40 文件／243 用例**、SQLite／打包 **7 文件／46 用例**、桌面 **22 用例**、冷 Bun factory **3 项**保持已记录证据。真实 macOS payload／binary 冷父子进程、四项交付缺口、原完整 Xpod 集成（Docker 查询失败）、当前用户 Gateway／生产 QLever、Search／raw／CLI／provision／direct 写者、持久恢复、Cloud、C2、冷启动及历史分页、全部 W0–W5／G01–G12、合入发布仍未完成。私有权威状态为 `.test-data/solid-multiparty-acceptance/provider-b/root-review/continuation-checkpoint.json` 的 `authoritative_latest_checkpoint`。

> 当前结果（2026-10-04）：完整原始源 CAS 与严格 ACP 服务端闭包独立155项组合及375项／29文件（80177）通过，无重试、1942输入未变，顺序构建／Components／测试类型／依赖／diff全部通过。原完整集成76940的lite165通过／6环境跳过、Matrix原样例在预算内完成，但Docker端口只读查询无限等待，根只结束自有查询后命令实际退出1；Docker45未启动，完整结束和清理标记缺失，故完整门禁未通过。1942输入未变，无Sleep/Wake。独立实际Bun探针红例确认查询没有有限生命周期，opencode-b正在修复并自测。ACP客户端证明／授权增量、ownerRecovery、业务与跨API接线、G01–G12、当前Gateway、合入发布仍待完成。开发、修复、自测、验收发布继续由B负责，仅实际429切回GPT‑6.1 Sol；主负责人设计和独立最终验收。

> 当前修复进展：B 已修复精确空 ACP 状态，Root 三项真实 HTTP 测试全部通过（根空策略、叶空策略继承、私有全局 deny）。新增完整 WebID 含 query/fragment 的反例仍待修复：实际 HEAD 200、无 query 的不同主体 403，而观察返回 400。B 继续负责修复；还需同步其自有 capability 单测夹具的 accessor 身份字段并纳入最终门禁。最新原始完整集成实际退出 1，lite 165 通过/6 环境跳过，Docker 端口查询有限超时、45 项未执行，1955 输入未变化；启动 Docker 命令仅返回已运行，实际引擎仍 503。A1 及发布未完成。


> 当前验收口径补正：空 ACP 文档必须作为 `present-empty` 与 404 区分并继续继承，观察接口仍返回 415。Root 曾错误地把该状态视为不支持；现有 1955 输入的 44/155/375 通过不能证明这一项，也不代表 A1 最终完成。保持当前原始完整测试输入冻结，终止结果到达后恢复正确断言，交给 B 修复并重新验收。此前错误归于 Root 验收口径，不能计作 B 的测试或效率问题。


> 2026-10-04 当前冻结门禁结果（1955 个输入）：B 修复逐次路由证明和目录快照并发缺口，Root 冻结验收 A1 44 项、Matrix 单测 155 项、原有 375 项独立回归全部通过，构建/测试类型/依赖/diff 检查退出 0；输入文件均未变化。新鲜观察使用同一锁实例的房间独占锁及外部策略依赖读锁，保持零数据写入。只有完整有效网络响应能够进入下一阶段证据绑定；当前启动原始完整集成，并由同一 B 账号/模型只读预检 A2，无 429。完整集成、真实 Gateway、A2/A3、其他 Matrix 指标及合入发布仍未完成。


> 2026-10-04 当前 A1 独立验收更新：opencode-b 同一账号/模型完成第一轮修复，实际退出 0，无 HTTP 429。Root 实际 HTTP/CSS 验收 11/11 通过（原始 7 项 + 隐私/身份/凭据 4 项）；前三个反例及 accessor 身份缺口已修复。随后新增逐次调用反例：requester 的 room Control 路由覆盖仍可认证后续绕过路由的 room Read，实际 200 应为 415；新增文件 1 失败、1 通过，已交给同一 B 会话修复。A1 尚未最终验收；原始完整集成、真实 Gateway、A2/A3、其余 Matrix 指标、合入和发布仍待完成。


2026-10-04 当前证据：根92060两项原生反例、基础设施16项、单元155项、顺序构建门禁及协议375项全部原样通过，1942输入未变。其后原完整33687已在同一输入启动，但本次中断未捕获最终退出，旧76940的失败JSON已隔离，当前记录为中断／退出未知，不能写成通过或新的确定退出1。全部记录的自有进程已退出。B只读预检因磁盘ENOSPC中断，当前空间外部恢复约10GiB，根未删除文件；同一B账号会话继续，未出现429。Docker仍503，独立ACP A1开发按既定阶段例外继续；真实完整集成、当前Gateway与发布门禁保留。

> 2026-10-04 基础设施复核：本机Docker Desktop返回503，具体启动原因未知；未重启服务、切换context或动其他容器。B已修复无限等待与子进程持有stdout路径，自测16项通过，根新一轮冻结回归正在执行。76940的原完整失败保留，不能以原生fake-CLI生命周期测试代替真实Docker45。独立ACP A1可以在原命令再次尝试后继续开发，最终完整集成和发布仍待全数通过。

> 前一阶段：WAC／持久授权归属339项及完整29938（lite165／6环境跳过、Docker45、结束与清理标记齐全，1937输入未变、无Sleep/Wake）已通过。八天历史授撤、公共Read残留、额外权利与旧授权保护、完整source fragment及端口重建均有夹具证据；这些不代表当前Gateway DPoP、G09进程崩溃或全部指标。下文保存历史失败与证据。

# Matrix 协作历史基线与分布式验收门禁

> 继续验收（2026-10-03）：原完整运行35049的lite165/6、Matrix63（235864ms）通过，Docker9000仍冲突、实际退出1，1893输入无变化。已补Docker published TCP reservation与Bun分配验证，原Docker段35455实际45/45、退出0，其他工作树的基础设施保持运行；修补后的完整命令72922正在运行。当前权限复核现已扩到固定GRAPH的条件更新：5条实际文件/CSS WAC独立红例确认锁内fresh授权缺失，仍未修复。两次端口失败、后续局部通过和迁移完成分别记录。

> 最新推进（2026-10-03）：目标已更新为完成 Matrix 模型验收、合入、发布，仍按 G01–G12 与 W0–W5 全部门禁执行。成员操作结构与共享 canonical CAS 独立 108 项通过；完整回归 59880 的 lite 165 通过／6 个环境跳过，原 Matrix 63 事件样例通过（653680ms），但 Docker 阶段因其他工作树占用 6379 启动失败，命令退出码 1，1783 个冻结输入无变化。测试运行器正在补独立端口隔离，不能把本轮记为完整通过。随后实际文件／CSS WAC 的锁边界独立两项均失败：跨进程 tracker 的 Control 撤权仍得到 204，且权限未在提交锁内重新读取；这是需要修复的当前权限缺口，不把 native 计数替身当作生产 QLever／Redis／用户 Gateway 证据。


> 最新游标进度（2026-10-03）：服务端源发现每页固定读取 500 行，以最后一个源行的时间和完整 IRI 续读；周期上界与原通知观察持久绑定。无通知源、空周期和旧检查点三个边界已补齐，相关 8 套回归 86 项通过；独立复核另有 38 项与 9 组探针通过，源码和测试类型检查退出码 0。开发侧此前 Matrix 786 通过、3 跳过。查询引擎毫秒转换的原版本 Bun 补丁已落地，公开 RDF/ORM 28 项通过；实际隔离 ACP Gateway 已按返回游标读出初始 7、2 条及新事件 1 条。完整迁移与用户当前 Gateway 尚未通过，下方历史数字不能作为最终验收。

> 当前证据更新（2026-10-03）：完整迁移指标以 [Solid 多方通信验收指标](solid-multiparty-acceptance-criteria.md) 为准。最近完整集成退出码 0：lite 164 通过、6 个环境跳过，Docker 45 项全部通过；Matrix 63 事件及 Agent 交接样例在原 900 秒预算内通过，ChatKit 22 项也通过。随后独立复核补齐 RDF 类型 NamedNode 校验及公开引用解析的嵌套路径/fragment 边界，drizzle/RDF 与事件校验 63 项通过；针对这些后续修改的完整命令已退出码 0（lite 164 通过、6 环境跳过，Docker 45 通过），Matrix 样例耗时 646494ms。C2 未接入读取端口的独立复核发现额外请求、角色丢失及 Literal 权限事实问题，正在修正；G01–G12 和用户当前 Gateway 尚未验收。
> SDK 后续修复进度（2026-10-03）：URI 数组与同响应体 metadata 水合已通过公开 RDF/ORM 14 项新回归，全部 drizzle/事件校验 77 项、游标 86 项通过，源码/测试类型及依赖检查退出码 0，独立 SDK 复核通过。修复后的完整集成也退出码 0：lite 164/6 个环境跳过、Docker 45/0；Matrix 63 事件与 Agent 样例耗时 688448ms。未接入 C2 读取端的错误 JSON 字面量类型与协议 null 已修复，独立 9 项通过；显式角色 null 的夹具已改为实际 typed JSON RDF term，旧版将 null 省略成字段缺失的失败不作为产品缺陷。ORM 与同响应体原始 RDF 的参与者、角色和 roomId 一致性检查已在后续 B52 完成，读取端仍尚未接入产品当前权限判定；最新证据见 B52–B54 更新。

> 最新局部验收（2026-10-03，B52–B54）：上述 ORM／同响应体原始 RDF 一致性检查已修复，独立 85 项及端口复核通过。创建路径已接入真实 Pod 登记校验，使用完整 WebID 精确比对；新的 roomId 携带实际 canonical Chat IRI，Thread／Message 按实际父路径构建。非法作者 URI、非规范 Pod 根与原始记录缺失均提前拒绝，不回退镜像；合法无 fragment WebID 与跨域身份保留。主负责人独立回归 107 项、跨域签名／创建专项 26 项通过；另一独立复核 75 项及 4 项签名通过、9 文件类型诊断为零。开发侧 Matrix 847 通过、3 条 PostgreSQL 条件跳过，源码／测试类型／依赖检查退出码 0。**产品当前权威读取、成员与 ACL 生命周期尚未接入**；本次修改后的完整集成退出码 0：lite 164 通过、6 个环境跳过，Docker 45/45；Matrix 63 事件及 Agent 样例 504692ms。首轮两条 direct-store 夹具漏注入端口已修正，夹具读取测试 Gateway 的真实 Pod 登记库，未放宽生产资格检查；修正后的单独两项与完整命令均通过。用户当前 Gateway 与 G01–G12 仍未验收。


> **时代边界（2026-09-28 加注）**：本文件记录的是 **Matrix 形状那一版实现**的基线与验收证据。
> 协议方向已改为 [Solid 多方通信协议](solid-multiparty-protocol.md)（参考 Matrix 的设计思路、**不承诺兼容**），
> 落地进度与逐项处置见 [改造清单](solid-multiparty-migration.md)。
> **本文件里仍然成立的**：实现确实存在、门禁确实通过（下面每一处都有提交与命令）；
> **已经被取代的验收口径**：每事件签名与密钥托管、入站回执与出站批次、`/_xpod/matrix/inbound` 第二条投递路径、
> MXID 形状的身份、事件 id = 内容哈希。这些项的"通过"记录**不再代表当前协议的要求**——
> 迁移完成前，本文件是**历史与回归对照**，不是当前验收标准。
> 当前 Solid 迁移的分工、通过条件与证据门禁见[开发与最终验收指标](solid-multiparty-acceptance-criteria.md)。
> 文末数字属于对应历史提交；当前部分迁移的最新证据见本文开头，完整迁移仍以新的验收指标逐项判定。

日期：2026-09-23。设计见 [协作契约](matrix-collaboration-design.md)，使用方法见 [可执行样例](examples/matrix-collaboration.md)。下表是首次运行的记录；同一分支上的逐条复跑证据见下文「特性分支复跑记录」。

## 证据定位（2026-09-26 更新）

以下通过数字是 **2026-09-23 单部署、单身份、单 Pod 实现的历史基线**，保留用于回归对照。目标现已明确为 Matrix 分布式房间与事件语义、参与者数据分别持久化到其 Pod，见 [决策登记册](matrix-collaboration-decisions.md)。历史通过项不构成 federation、跨 Pod 持久化或分布式 Agent 执行的验收证据；SQL journal 专项仅证明待迁移旧实现的行为。

Pod 资源 URI 指 Pod 中持久资源的位置，不是浏览器缓存；同一协议事件在不同 Pod 中必须保持同一 event_id，不要求在各参与者 Pod 的持久数据之外额外引入镜像层或映射表。

## 本轮结果

| 验证 | 结果 | 覆盖范围 |
| --- | --- | --- |
| `bun run build:ts` | 通过 | 最终产品代码类型检查 |
| Matrix/队列/Handler/路由/身份/Run/RDF 专项 | 180 通过，7 条环境条件测试跳过（复跑为 185，见下文） | 同时间分页、积压、晚到消息、事务并发、授权撤销、篡改、失败和崩溃恢复、HTTP 输入边界、RDF 对象隔离 |
| 真实 Redis 队列专项 | 10/10 通过，其中 4 项连接真实 Redis | 原子入队、领取、续租、旧租约拒绝，重启/数据清空后的 token 不重用；临时实例已关闭 |
| 真实 PostgreSQL journal 专项 | 空库冷启动 3/3 通过；合并 SQLite 为 9/9 | 12 实例并发初始化/事务预留、提交顺序、连接池重开；仅清理独立 scope 数据 |
| ChatKit 兼容回归及消息关系 | 7/7 通过 | 共享唤醒接口使用持久化 participants；请求伪造名单无效，client-owned/缺少 roster 不唤醒 |
| `bun run test:integration` | 完整命令通过 | lite：153 通过、6 跳过；cluster：45/45 通过 |
| 依赖状态与 `git diff --check` | 通过 | 无新增依赖，无手改 node_modules |

环境条件测试的跳过没有被计为成功；Redis/PostgreSQL 对应能力另行在实际服务上执行并读取了通过结果。

## 特性分支复跑记录（2026-09-23，分支 `codex/matrix-collaboration`）

在独立 git worktree 中按上述门禁逐条复跑。专项集合比首次记录多出 `MatrixPodResolver`、`AgentWakeHandler`、`RunRelations` 与协调者回归，因此通过数由 180 变为 185；跳过仍是同 7 条环境条件。

| 验证 | 复跑结果 | 备注 |
| --- | --- | --- |
| 依赖状态、`bun run build:ts`、`git diff --check` | 通过 | 无依赖漂移，未手改 node_modules |
| Matrix/队列/Handler/路由/身份/Run/RDF 专项 | 185 通过，7 跳过 | 同时间分页、积压、晚到消息、事务并发、授权撤销、篡改、失败与崩溃恢复、HTTP 输入边界、RDF 对象隔离 |
| 真实 Redis 队列专项 | 10/10 通过 | `WAKE_QUEUE_TEST_REDIS_URL` 指向本次临时启动的本机 Redis |
| 真实 PostgreSQL journal 专项 | 3/3 通过 | `XPOD_MATRIX_TEST_POSTGRES_URL` 指向本次临时启动的 PostgreSQL 18.4 空库，12 实例并发初始化 |
| `bun run test:integration` | lite 153 通过、6 跳过；cluster 45/45 通过 | 完整命令 `exit 0`，耗时约 352 秒 |
| 真实 Gateway 协作闭环复跑 | 1/1 通过，约 275 秒（随后两次完整门禁中为 309 秒） | `XPOD_RUN_INTEGRATION_TESTS=true SOLID_ENV_FILE=.test-data/integration/lite.env` 下单独复跑该用例，并随完整门禁再次通过 |

复跑使用的 Redis/PostgreSQL 是本次临时启动的本机实例，只清理自身 scope/namespace 后关闭，不代表生产托管版本的容量结论。真实 Gateway 闭环仍由测试自建的严格认证栈提供证据，未重启或使用常驻 localhost:3000 实例。

### 门禁抖动与处理

前两次完整门禁中该真实 Gateway 用例失败，失败点分别是积压第 21 条消息写入与随后清空 grants 的 state 写入，均为单次请求超出样例固定 120 秒预算。实测本机 Pod 单次写入约 7.5 秒、4 路并发写被串行化；并行跑完整套件时单个请求会被拖到分钟级。处理方式不是放宽事件数量或跳过该用例，而是让样例对可重复步骤按同一幂等语义重试（同 txnId / state key / 租约字段，单步总预算 480 秒），并在完成响应丢失时按 jobId 读取已存储结果；事件数量、交接与 409 断言均未放宽。回归见 `tests/api/matrix/PodMatrixStore.reliability.test.ts` 的「returns the stored event when a client retries after an unanswered write」。

## Matrix HTTP 闭环证据

正常集成开关 `XPOD_RUN_INTEGRATION_TESTS=true` 下，Matrix 测试启动独立 Bun Gateway，明确设置 `open:false`、`authMode:'acp'`，通过 HTTP 创建新账号、Pod 和客户端凭据。匿名 whoami 被拒绝。不会借用共享 open 测试栈的虚拟身份。

测试调用仓库样例，实际验证：

1. 房间与 Agent grants 写入后能够正确读回。
2. 相同发送事务返回同一事件 ID。
3. author runtime 领取、续租、提交助手结果，并显式交给 reviewer。
4. reviewer 获得前置结果并回写第二个助手结果；重复完成返回 409。
5. 每批 4 条并发追加 60 条消息，再以 limit=7 分页，核对原始消息、两个助手结果及积压消息共 **63 个事件的 ID 和正文**。
6. 最终报告断言 `status=passed`、`mode=deterministic-runtime`、`expectedEvents=observedEvents=63`、两份结果和多页同步。

该单项集成耗时约 435 秒，包含夹具与严格授权下的存储访问；不是性能基准，也不能用这个结果宣称生产延迟达标。测试完成后清理独立账号数据目录、证据临时文件与服务进程。可使用样例的 `--output` 在自己的验收环境保留报告。

## 本轮发现并处理的问题

除原审查中的身份、游标、事务去重、成员/Agent 授权和缺少执行闭环外，实际运行还暴露并处理了：

- 同文档对象 metadata 子节点重名，导致多条消息状态混合：使用 ORM 支持的显式子节点 `@id` 隔离，见 [问题记录](issues/drizzle-solid-matrix-metadata.md)。
- 队列重建后 fencing token 复用、失败终态复活、已排队触发未重验当前授权和内容。
- 助手结果已落盘而 Run/Delivery 确认中断：恢复时验证回执并补齐终态。
- PostgreSQL 首次建表的并发 catalog 冲突：初始化使用事务级 advisory lock。
- shared Reconciler 收紧名单后 ChatKit 调用方未提供 roster：改读持久化 Chat.participants。

## 尚不能由本轮证据推导的结论

- 没有重启或验收用户当前常驻的 localhost:3000 实例；这里的 HTTP 证据来自独立测试 Gateway。
- 样例由同一 WebID 下两个确定性执行器运行，没有调用 LLM、真实外部工具，也没有证明独立 executor 身份之间的完整 ACL 隔离。
- 集成存储使用仓库 QLever 测试夹具；不是生产原生 QLever 的专项认证。
- 队列、SQL 和 Pod 不是同一事务。执行保持至少一次；Pod 写入不能宣称受到原子 fencing，外部工具仍需幂等。
- 大历史量、生产并发、网络分区与长时故障恢复仍需单独验收。当前 ORM hydration 成本已记录于 [性能问题](issues/drizzle-solid-matrix-hydration.md)。
- 旧 metadata 碰撞数据、旧 MXID/游标和旧 Redis 队列没有自动修复迁移，按设计文档的迁移边界处理。

## 分支 `codex/matrix-event-primitives` 复跑记录（2026-09-27）

实现内容：协议事件随消息持久化并可仅凭 Pod 验证（内容哈希、reference hash、签名），
事务记录与事件身份对齐。设计落点见[决策登记册](matrix-collaboration-decisions.md)，
字段与排除项的规范依据见[事件哈希与签名 §2.1](reference/matrix-event-hashes-and-signing.md)。

| 验证 | 结果 | 备注 |
| --- | --- | --- |
| 依赖状态、`bun run build:ts`、`bun run typecheck:test`、`git diff --check` | 通过 | 无依赖漂移；分支自身引入的测试类型错误已清零 |
| `./node_modules/.bin/vitest --run tests/api tests/http` | 129 文件通过、11 跳过；1508 用例通过、67 跳过 | 含 `eventIntegrity` 15、`serviceIdentity` 6、`persistedEvent` 4 与并发/崩溃恢复专项 |
| `bun run test:integration` | 完整命令 `exit 0` | lite：30 文件通过、3 跳过，153 用例通过、6 跳过；cluster：4 文件 45/45 通过 |
| 真实 Gateway 协作闭环 | 通过，144.8 秒 | `tests/integration/MatrixCollaboration.integration.test.ts`；63 事件、交接与 409 断言未放宽 |

本轮新增的可验证性证据边界：验证材料（`hashes` / `signatures` / `event_id`）与房间依赖图
（`prev_events` / `auth_events` / `depth`）都随事件持久化，可从单个 Pod 的消息 metadata 独立
复核，且有跨实现依据（内容哈希排除 `event_id`，规则见[房间事件图](reference/matrix-room-event-graph.md)）。
**当时仍未**验证跨部署互操作、也**未**实现状态解析与事件授权规则的执行。**现状（2026-09-27 更正）**：状态解析
（v2，含分叉收敛）与事件授权规则（v11）都已落地并有测试；跨部署互操作已取得**进程内真实 HTTP** 证据（见下文
"两个部署经真实 HTTP 的闭环"），**真实实例证据仍缺**（本机 3000 跑的是别的构建，见"真实实例探测"）。

| 追加验证 | 结果 |
| --- | --- |
| 图与依赖（`tests/api/matrix/protocol/roomGraph.test.ts` 11 项、`persistedEvent.test.ts` 8 项） | 通过：create 为根、链式 depth、auth 选择顺序、极值点 >20 保留最深、分叉合并、无悬挂引用、房间前进后重占预占 |
| `./node_modules/.bin/vitest --run tests/api tests/http` | 130 文件通过、11 跳过；1523 用例通过、67 跳过 |

## 跨部署闭环证据（2026-09-27，分支 `codex/matrix-event-primitives`）

两个**独立部署**参与同一逻辑房间的闭环：各自一个 Pod 数据库、各自签名身份（`alice.example` /
`bob.example`，部署名只是回落）、各自出站队列与入站事务记录。出站请求交给对端
`handleFederationSend`（`PUT /_matrix/federation/v1/send/{txnId}` 的处理体）处理，等价于真实
HTTP 跳转；**唯一的测试替身是"缺依赖事件如何送到对端"**——规范路径是 `/get_missing_events`（未建），
测试按真实部署会做的那样先把房间状态交过去。

| 验证 | 结果 |
| --- | --- |
| `tests/api/matrix/federation/twoDeployment.test.ts` 9 项 | 通过：房间状态与邀请跨 Pod 送达且被授权；Bob 在 B 上加入、其加入事件由 `bob.example` 签名、A 原样保存；Alice 的消息以**相同 event_id** 落到 B；**重放事务返回首次响应且不写第二次**；未服务的目的地 403、未知签名 401、非 JSON 400；缺依赖的 PDU 报 error 且不落库 |
| 对端不可达与恢复（同文件 2 项） | 通过：断网期间的写入**不等投递**（写入返回时对端一条都没有）；整批留在队列里（3 条 PDU 不被拆散）；再次尝试**复用同一 txnId**、`attempts` 递增、`lastReason` 记不可达；恢复后这条事务送达且 3 条消息**恰好一次**、顺序与写入一致、两侧 event_id 集合相同；**队首未被应答时后面的批次不越队**（`deferred` 只提队首），恢复后仍按写入顺序到达 |
| `tests/api/matrix/federation/inboundRoute.test.ts` 8 项 | 通过：接受已知服务器签名的整笔事务并逐条报告、未知密钥拒绝、未服务目的地 403、非 JSON/非对象 400、超 50 PDU 拒绝、body origin 与签名 origin 不一致拒绝、处理中返回可重试 503、事务 id 从路径解析（含 URL 编码） |
| 接收方可见性（`PodMatrixStore.materializeReceivedRoom`） | 通过：收到的事件若属于本 Pod 尚未记录的房间，会**按事件本身**补出房间记录（room id 用对端 id、author 用 create 事件的 sender，**绝不写成 Pod 所有者**），因此邀请在接收方可见、也能被加入 |

对照门禁的现状：

| 门禁 | 现状 |
| --- | --- |
| 两个独立部署、两种身份、两个 Pod | **已取得模块级证据 + 进程内真实 HTTP 证据**（上表；两侧各自在真 socket 上跑入站路由）；TLS/SNI 已由传输层与真实握手测试覆盖；**仍未验证**：真实实例（本机 3000 是别的构建）与 grant 的签发流程 |
| 协议身份一致 | **已取得模块级证据**：同一 room_id 与 event_id 跨两个 Pod 一致，接收副本按推导 id 保存 |
| 传输与落盘恢复 | 部分：**未完成的事务会释放预留**（写失败/记录失败后对端重试即可重跑，已完成的重放仍不重复处理；"正在处理中"的并发重放仍回 503），**Pod 无授权时回 403 并点名是哪个 Pod**；事务重放与去重已证；**逐条拒绝后的重发已落地并端到端验证**（邀请先被拒、依赖到达后自动重发成功）；接收方主动补取（`/event_auth` + `/get_missing_events` 两半）已落地并端到端验证；**出站队列已由调度器驱动、随 API server 启停，并被写入本身触发**（端到端：一次写入无需任何手工 flush 即到达对端 Pod）；**断网与恢复已取得模块级证据**（保序、同 txnId 重试、恢复后恰好一次，见上表）；**仍缺**与真实委派对端的 TLS 握手验证、对端重启后的恢复（接收侧事务存档与投递进度目前是内存实现）、投递记录落控制 Pod |
| 授权与房间状态 | 已证：非法签名、缺依赖、未知 server 被拒（本表 + `inboundPdu` / `authRules` / `stateResolution` 单测） |
| Agent 执行归属 | 未做（待决策） |
| 仅凭 Pod 恢复 | 未做（旧 SQL journal 仍在）。**承载已定**（用户 2026-09-27）：用 models 已有的 `taskResource`（keyed、status、不透明 metadata、两个时间戳）装出站批次与入站事务回执，**不新建表**；**剩余**：`reserve` 的原子性需要 Pod 条件写（ETag/If-Match），回收策略待定（见[控制记录契约](matrix-control-records-contract.md)） |
| 有界同步与权限更新 | **授权判定不跨请求复用已用测试固定**（`agentGrantFreshness.test.ts` 2 项：撤销后下一次调用立即 403、重新授予立即通过；给别人的执行授权不算我们的）； **模块级证据已取得**（见"规模与 Pod 操作数"）：写入/状态/分页与房间数无关；接上变更信号后，空闲 sync 为 **0 次 Pod 读**、单房间变更 **4 次**（原 42 次）；订阅侧与"挂到本部署服务的哪些 Pod"都已落地并有测试（Pod 集合派生自注册表，周期对账，未 watch 的 scope 回 `trust: 'all'`）；**仍缺**在真实部署上重取这些数字与对端方向 |

**本轮发现的两个缺口与处置**：

1. **逐条 error 被当成已投递** —— **已修复**：事务返回 200 不再等于每条 PDU 都被接受，被拒 PDU 换新
   txnId 有界退避重试，用尽次数报 `abandoned`；对端没点名的 PDU 不算被接受；退避中的批次不阻塞队列
   （否则会与"它等的依赖排在后面"死锁）。`twoDeployment.test.ts` 端到端证明：邀请先被拒、依赖到达后
   自动重发并被接受。
2. **依赖顺序** —— **两侧闭环已取得模块级证据**：发送侧同批次内按依赖拓扑排序；接收侧遇到无法授权的
   PDU 时向发送方索取 `/event_auth` 链、按旧到新校验并接受、再重校验原事件（`twoDeployment.test.ts`
   证明：B 自己取回链并接受邀请，event_id 与 A 一致，无测试手工递状态）。**现状**：两个端点的 HTTP 外壳与 Pod
   归属解析都已落地，且这条端到端证据已改成**经 HTTP 调真路由**（不再有测试内直接调用的处理体）。

## 规模与 Pod 操作数（2026-09-27 测量）

门禁要求的是「token 和读取工作量**有界**」。有界的单位在这里是 **Pod 往返次数**（一次 Pod 读是一次
带授权的网络往返）与**读到的行数**，不是 CPU 时间；测量用内存 harness（`db.select`/`db.insert` 计数），
断言写成"10 房间与 200 房间相同"这类相对性质，所以它同时是回归门禁。

| 操作 | Pod 往返 | 读到的行 | 随房间数增长 |
| --- | --- | --- | --- |
| 写一条消息 | 1 select + 1 insert | 仅本房间 | **否**（10 与 200 房间完全相同） |
| 读房间状态 | 1 select | 仅本房间 | **否** |
| `/messages` 一页（limit 5） | 2 selects | ≤16 行（本房间事件） | **否** |
| 增量 sync（只有 1 个房间有新事件） | **2 × (房间数 + 1)**：50 房间 = 102 | **≈ 全量 sync 的行数**（602 vs 600） | **是** |
| 空闲 sync（timeout=1000） | 2 × (房间数 + 1)：20 房间 = 42 | — | **是**，但**不随等待时长增长**（等待循环零读取） |
| 1000 房间 + 2000 事件 | — | — | 堆增量 **9.6 MB** |

结论与边界（都已登记）：

- **写入、状态读、分页是有界的**，与 Pod 里有多少房间无关，也与房间历史长度无关（分页由 limit 约束）。
- **sync 不是有界的**：每趟固定做两次「房间列表 + 每个房间整条时间线」的读取（第一趟是**索引趟**，
  用于发现直接写进 Pod 的原生行；第二趟读数）。因此一趟的成本是 **O(Pod 内事件总数)**，
  而不是"变化的部分"—— 一个房间一条新事件仍要读整个 Pod。
- 把它变成有界需要 **Pod 侧变更信号或索引**（Solid 通知已在本仓库就绪，正是登记册推荐的原生机制），
  或者让房间读取带上可下推的范围（需要 models 侧的可索引字段/分桶规则，属"客户端增量"待办）。
- 注意这是**每个 Pod 的**成本：它随该 Pod 内的房间数增长，不随部署总量增长。

**变更信号接上后的实测（同日，`tests/api/matrix/syncChangeSource.test.ts` 6 项）**：把 `roomChanges`
（由通知订阅驱动的"哪些房间变了"）接进 sync 后，**20 房间**下：

| 场景 | 接入前 | 接入后 |
| --- | --- | --- |
| 已追平的调用者、无任何变更 | 42 次 Pod 读 | **0 次**（不读房间列表也不读时间线） |
| 已追平的调用者、1 个房间变了 | 42 次 | **4 次**（两趟 × (房间列表 + 该房间)） |
| 调用者落后（无 token 或 token 落后于上次索引水位） | 42 次 | 42 次（**故意**：落后的调用者必须拿到它的房间） |
| 来源承认无法完整交代（刚启动/断线） | 42 次 | 42 次 |
| 每 5 分钟一次的全量兜底趟（`roomChangeFullPassMs`，0 = 永不信任来源） | — | 42 次（防止漏掉的变更永久丢失） |

即：**"有界"从"每次调用都要读遍 Pod"变成"只在真的变了时读变了的房间"**，并且通知丢失由周期兜底
覆盖。注意 `settle` 语义：一次 sync 期间到达的变更**不会**被当作已读（只有本次真正读过的房间才允许
从来源里移除），否则等待中的变更会被永久吞掉。

订阅侧本身（`notifications/roomChangeSubscription.ts`，7 项测试）：按 topic 建 WebSocketChannel2023
通道、连接 `receiveFrom`、解析通知体、断线后**重新建通道**（通道在最后一个 socket 关闭时会被回收，
所以不能复用旧 URL）、失败上报且持续重试直到 stop、`start` 幂等。
**接线已落地**（`notifications/roomChangeTracker.ts`，7 项测试）：每个房间订阅**当天消息文档**（真正被
改写的资源；容器看不到"已存在资源被更新"），跨天 `refresh()` 续订并停掉旧 topic；`trust` 只有在每个
想要的 topic 都订上时才是 `changed`，**订阅失败 / socket 断开（含干净 close）/ 无法归属的变更**一律降级为
`all`（读遍所有房间）。代价明确：R 房间的 Pod 需要 R 条通道 / R 个 socket。

**已接上"本部署服务哪些 Pod"**（`notifications/roomWatchService.ts`，8 项测试 + 容器 1 项）：Pod 集合派生自
`participantRoutes.routes()`，每个 Pod 一个 watcher（房间列表来自 `listJoinedRooms`），服务本身就是 store 的变更
来源（容器测试断言是同一个对象），**未被 watch 的 scope 一律回 `trust: 'all'`**，周期对账接住 Pod 的出现/离开，
单个 Pod 失败只上报且它继续 `trust: 'all'`。**仍未接**：对端方向（对端订阅房间目录取增量）。

**密钥按名字发布（已落地）**：`GET /_matrix/key/v2/server` 现在按 `Host` 认定名字并只发**该名字**的密钥
（参与者是自己的 server，所以对端要的是她的密钥）；不持有的名字回 404 而不是发部署密钥——此前那条路由不看
`Host`，等于让对端永远验不过参与者签名的事件。测试见 `MatrixHandler.test.ts`（含 `Host: alice.example:8448`
得到 alice 的密钥、`bob.example` 得到 404）。

**Pod 归属解析（已落地）**：入站请求按"被寻址的 server name"找 Pod 这一层现在是**派生**的
（`src/api/matrix/participantRoutes.ts`，7 项测试 + 容器 1 项）：server name = WebID 的 host，Pod = 该 WebID
已登记的 Pod（`pod_lookup`），因此不需要第二份 Matrix 绑定记录；同一名字被多个参与者认领、或一个参与者登记了
多个 Pod 时**拒绝**而不是猜（写错 Pod 无法撤销），未登记的名字报 unknown 由外壳回 403。**现状**：外壳本身已全部
落地（`/send`、读取端点、握手、查询、版本）；"部署写目标 Pod 用的服务授权"也已落地为 `service` 上下文（参与者任务层
grant，缺 grant 即 403 点名 Pod），**仍未做**的是 grant 的**签发流程**（索取时机与界面）。

**邀请握手闭环（已取得证据）**：`/invite` 经真 socket 请被邀请方加签——事件 id 不变、双方签名都在，且被邀请方的 Pod 仍为空
（`/invite` 只负责签名，送达仍走事务）。

**按 alias 加入的闭环（已取得证据）**：`joinRoom('#lobby:alice.example')` → `/query/directory` → 握手，三步都经真 socket，
两侧 event id 一致。

**密钥闭环（已取得证据）**：Bob 的部署向 Alice 的部署**真的请求** `/_matrix/key/v2/server`（携带 `Host: alice.example`），
用取回的密钥验过 Alice 签名的事件；不发布的名字取不到密钥（而不是别人的密钥）。

**读取端点的端到端闭环（已取得证据）**：`twoDeployment.test.ts` 新增一项——Bob 加入后向 Alice 的部署经 HTTP 问
`/state`、`/state_ids`、`/backfill`、`/get_missing_events`、`/event_auth`，逐条与 Alice 真实持有的行核对（含"状态里没有
Bob 的 join，因为两条消息写在它加入之前"这条语义），并断言五条请求都真的发生过。

**远端加入的端到端闭环（已取得证据）**：`twoDeployment.test.ts` 新增一项——Bob 加入只有 Alice 的部署托管的房间，
**经 HTTP 走完 `make_join` → 签名 → `send_join`**；断言请求确实发生过、两侧 join 同 id、Bob 的 Pod 因常驻方随加入送来的
状态而持有 create 与 join_rules、事件上同时有双方签名、随后 Alice 的消息仍能到达 Bob。这一项当场暴露并修掉了三个真实缺陷
（"公开房间"没写 join rules、常驻方接受加入却不保存、由调用方提供的事件被存成无 id 事件），详见登记册同轮条目。

**两个部署经真实 HTTP 的闭环（已取得证据）**：`twoDeployment.test.ts` 新增一项——两侧各自把入站路由跑在真
socket 上（随机端口 + `registerFederationRoutes` + 真实的 Pod 路由派生），出站传输把 `https://<name>:8448/…`
改写到回环端口但**保留 `Host: <name>:8448` 与路径/查询**。房间引导、邀请、Bob 的 join（B→A）与 Alice 的消息
（A→B）全部经 HTTP，两侧 `event_id` 集合一致、两个队列清空，并断言请求次数与每次的 `Host` 都是被寻址的 server
name。**写入用的授权**：外壳新增 `contextFor`，容器接的是"以该参与者的任务层 grant 落库"（`service` 上下文）；
store 拒绝"既是会话又是部署干活"的上下文，拿不到 grant 就 403 并点名 Pod（`storePodAccess.test.ts` 4 项）。
**仍未证**：grant 的签发与撤销流程（真实 TLS/SNI 已由 `federationFetch.ts` 与真实握手测试补上）。

**入站 `/send` 的 HTTP 外壳（已落地，真实 HTTP 证据）**：`PUT /_matrix/federation/v1/send/{txnId}` 现在有真正的
路由与外壳（`src/api/handlers/FederationHandler.ts`，容器在有 Pod 注册表与验签密钥时注册）。测试
`tests/api/handlers/FederationHandler.test.ts` 6 项**全部经真实 HTTP 套接字**（随机端口 + `node:http` 以便设置
`Host`）：签名事务被接受并写进被路由的 Pod、重放同一 txnId 只写一次、同一事务内"后一条依赖刚接受的那条"可解析、
不服务的名字 403、伪造签名与 `destination` 不符 401、`Host: <name>:8448` 与 `<name>` 视为同一个名字。
**并且两个部署之间已经真的经 HTTP 跑过完整闭环**（见下）……

**联邦读取端点（服务侧与外壳都已落地）**：`/event_auth`、`/get_missing_events`、`/backfill`、`/state`、
`/state_ids` 五个端点现在都有 HTTP 外壳（`FederationHandler.ts`，与 `/send` 共用"认定被寻址名字 → X-Matrix 验签 →
按名字派生 Pod → 读协议事件"的前奏；房间为空回 404、缺参数回 400）并有 6 项真实 HTTP 测试；`twoDeployment` 里
"接收方补取 auth chain"也已改成**经 HTTP 调真路由**（断言请求过 `/event_auth` 且 `event_id` 与发送方一致）。
**失败按真实状态回答（已落地）**：读取端点此前会把 store 的 `MatrixError`（例如"没有这条 Pod 的授权"）冒成
**500**，对端会当成未知故障一直重试；现在统一按它的 status/errcode 回答，其它错误才是 500。`/version` 的客户端
一半也已就位。测试：`FederationHandler.test.ts` 26 项、`outboundTransaction.test.ts` 49 项。

**传输层（已落地，SNI/Host 缺口补上）**：`federation/federationFetch.ts` 把"连到解析出的地址、但以**被寻址的
server name** 作 SNI 与 `Host`"做成真正的传输（`fetch` 两者都改不了），出站投递与密钥获取共用同一实例；非 2xx 返回
Response 而非抛错，只有传输失败才抛。5 项测试（含真实回环往返断言对端看到的 `Host` 就是 server name），另有 **2 项真实 TLS 握手测试**
（`federationTls.test.ts`：证书只覆盖 `alice.example` 时，连回环地址也能握手成功且对端同时从 SNI 与 `Host` 看到
这个名字；同一张证书下声称 `bob.example` 则**握手被拒**，证明校验按 server name 而非连接地址）。**仍未证**：与公网上
真实委派对端的一次握手。

**不做联邦发现文档（决定）**：`.well-known/matrix/server` 按用户判断**不实现**——Pod 稀疏，拓扑来自房间成员
关系网，不需要按 host 做联邦发现；本部署的联邦端点按 server name 自身的主机可达。

**资料查询（已落地，答案为空是决定）**：`GET /_matrix/federation/v1/query/profile` 能认出"这是不是我们的用户"
（MXID 由 WebID 推导，比对而非查表），不属于本部署的用户回 404；但**字段一律省略**——展示名要来自 Solid profile
（发布给任意对端是个人数据决定），头像规范要求 `mxc://` 而本部署无媒体仓库。2 项真实 HTTP 测试 + 客户端 2 项。

**版本与自报（已落地）**：`GET /_matrix/federation/v1/version` 回 `{server: {name: 'xpod', version}}`，刻意不验签
（它只回答"是谁在应答"）；版本来源收敛到 `src/runtime/deploymentVersion.ts` 一处（CLI 与联邦端点共用）。2 项真实
HTTP 测试。

**目录查询（已落地）**：`GET /_matrix/federation/v1/query/directory` 按 alias 回答 `{room_id, servers}`——alias 是
房间记录上的字段，所以答案来自 alias 里那个 server 的 Pod，不搜索其它 Pod；`servers` 用与出站投递同一套
"joined member → 其 server"选择。2 项真实 HTTP 测试 + 客户端 2 项。

**远端加入的编排（已落地）**：`federation/remoteJoin.ts` 把"要模板 → 只补自己的事实 → 签名 → 提交 → 取回加入前的
状态与 auth chain"收在一处，并且**刻意不持久化**（写进加入者 Pod 是调用方的事）。4 项测试含真实验签（自己的密钥过、
别人的密钥不过）。**已接线**：`joinRoom` 在房间不属于本部署时走这套编排——向房间 id 里的 server 提问、把回来的状态/auth chain 以
"收到的事件"落库、我们自己的 join 用提交的那个事件经本地写入落库（`remoteJoinStore.test.ts` 2 项）。**按 alias 加入也已落地**：`resolveRoomId` 先查本地、再向 alias 命名的 server 发 `/query/directory`，解析出房间 id 后走
同一条远端加入路径（`remoteJoinStore.test.ts` 4 项）。

**成员资格握手端点也已落地外壳**：`make_join`/`send_join`(v2)/`make_leave`/`send_leave`(v2)/`invite`(v2)/
`make_knock`/`send_knock` 七个端点现在都能应答（同一份 `FederationHandler.ts`，5 项真实 HTTP 测试：模板带图位置、
`ver` 不符 400 带 `room_version`、`send_join` 回"加入前状态 + 双方签名"、leave 回空对象、敲门回四字段 stripped
state、`/invite` 为我们的用户加签且不读 Pod）。加签用**被寻址参与者的身份**（`signerFor`），查不到就不签。
**仍未做**：`send_join`/`send_leave` 的 v1（已弃用、只为 room version 1/2 存在）。

**成员资格握手（同样只差 HTTP 外壳）**：`GET /make_join`、`PUT /send_join`、`GET /make_leave`、
`PUT /send_leave`、`PUT /invite`、`GET /make_knock`、`PUT /send_knock` 七个端点的服务侧已实现
（`federation/membershipHandshake.ts`，展示状态在 `federation/strippedState.ts`）并有 29 项测试，客户端的
`makeJoin`/`sendJoin`/`makeLeave`/`sendLeave`/`sendInvite`/`makeKnock`/`sendKnock` 也已就位（16 项）。已写死的语义：模板由常驻方用
`roomGraphPosition` 给图位置（与本地写入同一函数）、加入方丢弃不符的模板、常驻方复用入站 PDU 流水线校验
提交、加入方拿到的是**加入之前**的解析状态与带常驻方签名的加入事件、`omit_members` 只当提示（本部署永不
声称省略）、房间版本按 `ver` 协商（缺省为 `['1']`）；`/invite` 是唯一只校验不授权的一个（被邀请方通常不认识
房间），只回带自己签名的那个事件；敲门回的是房间的 stripped state（敲门方客户端拿它显示"在申请加入什么"）。**未验证的部分**仍是跨部署真实 HTTP 跳转：现有证据是两侧纯函数 + 客户端签名
往返，不是两个部署之间真的跑了这几步。

测试：`tests/api/matrix/scaleOperations.test.ts` 4 项（写/状态/分页在 10 与 200 房间下逐项相同且为小常数、
增量 sync 的往返与行数性质、空闲等待循环零读取、1000 房间的堆增量与单房间读取仍为常数）。

## 分布式目标的新增验收门禁（2026-09-28 逐条对账）

这张表是当初的**准入要求**；现在每条后面写的是**实际拿到的证据**（未达成的如实标注）：

| 门禁 | 必须取得的证据 | 现状 |
| --- | --- | --- |
| 两个独立部署、两种身份、两个 Pod | 参与同一逻辑房间；各服务仅依授权写入自己负责的 Pod，参与者无需相互持有 Pod 写权限 | **✅** `twoDeployment.test.ts`（16 项，含真实 HTTP 套接字）+ lite 的双运行时夹具；写入侧没有 grant 即 403（`matrixPodWriteFor`），跨参与者写授权从未引入 |
| 协议身份一致 | 相同 room_id、event_id 及事件引用跨 Pod 保持一致；Pod 资源位置变化不改变事件身份，原始协议事件可供验证 | **✅** 两侧 create / join / message 的 `event_id` 一致（`twoDeployment` 逐项断言）；收到的事件**原样**保存（`received`，含 hashes/signatures） |
| 传输与落盘恢复 | 断网后补发、重复和乱序投递、缺失事件补取均恢复；分别核对服务器传输确认、各 Pod 持久化进度和客户端同步游标 | **✅** 断网/恢复与部分投递失败（`twoDeployment` 2 项 + 队列的逐条应答、拒绝后换新 txnId）；重放取首次回执；缺失事件与 auth chain 补取；出站批次落 Pod、重启靠列目录找回 |
| 授权与房间状态 | 非法签名/事件授权被拒绝；并发成员和 power-level 变更按 room version 的状态解析收敛；历史可见性符合房间规则 | **✅** 非法签名 401、事件授权由 v11 规则判定（纯校验器 + **写路径强制**）；分叉收敛（ban 与自助 leave 两个分支都收敛到 ban）；历史按房间规则过滤 |
| Agent 执行归属 | 同一事件的多份持久副本不会分别触发独立执行；归属、接替与重试使用稳定逻辑标识，复制不授予执行权 | **✅** D6 已定并实现：Agent 是房间成员（授权即成员）、收到的事件不转发也不入队（副本不触发执行）、执行授权与协议成员身份分开（撤销授权停执行、不停成员身份） |
| 仅凭 Pod 恢复 | 移除旧 SQL journal 并清空可重建本地状态后，去重、投递进度、同步与必要执行凭证仍可恢复 | **✅（口径已明确并量过）**：回执、批次、签名密钥都在 Pod；留在身份库的是**可重建的本地状态**——同步序号可从 Pod 确定性重建（测试钉住），本地事件预留同样可从 Pod 里那行事件重建（行带 `txnId`+`txnDevice`）。唯一不可重建的是"事件从未写出"的在途预留，那正是契约已接受的"未知结果"分支。实测（真实 Pod）：预留若搬进 Pod，每个事件要多一次写入 + 索引重建，稳态 ≈110–150 ms/次（首次 1.4 s）而 SQL ≈1 ms/条，并在真实验收夹具上破坏时序假设；因此**决定留在 SQL**，`PodMatrixEventJournal` 作为已验证未接线的实现保留 |
| 有界同步与权限更新 | **授权判定不跨请求复用已用测试固定**（`agentGrantFreshness.test.ts` 2 项：撤销后下一次调用立即 403、重新授予立即通过；给别人的执行授权不算我们的）；**"跨请求判定缓存"已指认并结案（2026-09-27）**：Pod 侧元数据缓存由 `AsyncLocalStorage` + `TracingHandler` 的每请求 `new Map()` 持有，本来就是请求内复用；CSS `CachedResourceSet` 只缓存存在性（WeakMap 按对象）；`agentGrants` 每次读当前状态。晚到事件不漏，分页稳定，token 和读取工作量有界；普通 ACL/ACR 写入后后续请求不复用旧授权判定 |

LLM/工具质量、跨身份隔离、容量与长期故障测试仍须另取证据。单 Pod 历史闭环继续作为回归基线，不能替代以上分布式协议准入门禁。

## 真实实例探测（2026-09-27，本机 127.0.0.1:3000）

本机有一个**正在运行的 Xpod Gateway**（进程 `xpod`，监听 3000）。按 AGENTS.md"真实实例验收不可替代"的要求探测了它，
结论是**它跑的不是本分支的构建**，因此不能用它验收本轮工作：

| 探测 | 结果 | 说明 |
| --- | --- | --- |
| `GET /.well-known/matrix/client` | **200** `{"m.homeserver":{"base_url":"https://<hash>.nodes.undefineds.co"}}` | 客户端发现可用，Gateway→API 路由通 |
| `GET /_matrix/client/versions` | **200**（含 `co.undefineds.matrix.pod_storage`） | 客户端面在运行构建里 |
| `GET /_matrix/key/v2/server` | **404** `{"error":"Not Found"}` | **API server 自己的 404**（不是 Matrix 形状的 `M_NOT_FOUND`）→ 这条路由在该构建里根本没注册 |
| `PUT /_matrix/federation/v1/send/txn-1` | **404** 同上 | 联邦路由不存在 |
| `GET /_matrix/federation/v1/version` | **404** 同上 | 同上 |
| `GET /.well-known/matrix/server` | **401**（CSS 侧对未知 `.well-known` 路径的响应） | 与"不做联邦发现文档"的决定一致；无需处理 |

**待办**：要取得真实实例证据，需要**用本分支的构建重启一个栈**（不能覆盖用户正在运行的那个）。做法二选一：
① 用户同意后用本分支重启 3000；② 用独立 env（另一些端口 + 独立数据目录 + 独立凭据，参照
`SOLID_ENV_FILE=.test-data/integration/lite.env`）起第二个栈，再按上表逐条探测（`/version`、`/key/v2/server` 按名字发布、
`/send` 无签名 401、`/query/directory` 无签名 401、`/state` 404/401 等）。

## 实现对照表（登记册 → 代码 → 证据）

用途：把登记册里每条**已定**的事落到文件与测试上，便于逐条审计"目标是否达成"；**未达成**的四项单列在末尾。

| 登记册条目 | 实现 | 证据 |
| --- | --- | --- |
| 事件格式、ID、内容哈希、reference hash、签名与验签 | `src/api/matrix/protocol/eventIntegrity.ts`、`persistedEvent.ts` | `protocol/eventIntegrity`/`persistedEvent` 测试；`serverKeys.test.ts` 9 项（含篡改、过期密钥窗口） |
| v11 事件授权规则 | `src/api/matrix/protocol/authRules.ts` | `protocol/authRules.test.ts`；`federation/inboundPdu.test.ts` 7 项 |
| v2 状态解析（分叉收敛） | `src/api/matrix/protocol/stateResolution.ts`、`roomState.ts` | `protocol/stateResolution.test.ts`、`roomState.test.ts`（含分叉） |
| 房间事件图（`prev_events`/`auth_events`/`depth`） | `src/api/matrix/protocol/roomGraph.ts`、`storedEvent.ts` | `protocol/roomGraph.test.ts` 11 项 |
| 参与者身份与密钥归属（MXID 派生、Pod 内封存） | `protocol/serverName.ts`、`identityRegistry.ts`、`signingKeyStore.ts`、`identityProvisioning.ts`、`podParticipantIdentity.ts` | `participantProvisioning` 7 项、`podParticipantIdentity` 7 项、`serverName` 4 项 |
| server name → Pod 归属（派生、歧义即拒绝） | `src/api/matrix/participantRoutes.ts` | `participantRoutes.test.ts` 7 项 + 容器 1 项 |
| 密钥发布（按被寻址名字）与获取（含委派） | `handlers/MatrixHandler.ts`、`federation/serverKeys.ts` | `MatrixHandler.test.ts`（alice 的名字得 alice 的密钥、未知名字 404）；`twoDeployment` 端到端取密钥验事件 |
| 出站事务（签名、txnId 语义、退避、拒绝重试） | `federation/outboundTransaction.ts`、`outboundQueue.ts`、`outboundSender.ts` | 三个文件各 45/24/7 项；`twoDeployment` 断网恢复 2 项 |
| 入站事务（去重、首次应答、释放未完成预留） | `federation/inboundTransaction.ts`、`inboundRoute.ts` | `inboundTransaction` 15 项（含并发预留唯一赢家）、`inboundRoute` 8 项 |
| 缺失事件、历史、状态读取 | `federation/missingEvents.ts`、`roomHistory.ts`、`roomStateSnapshot.ts`、`authChain.ts` | 各 7/6/7/5 项；`twoDeployment` 端到端（读取端点 + 经 HTTP 补取链） |
| 加入/离开/敲门/邀请握手（服务侧 + 客户端） | `federation/membershipHandshake.ts`、`strippedState.ts`、`remoteJoin.ts` | `membershipHandshake` 26 项、`strippedState` 3 项、`remoteJoin` 4 项；`twoDeployment` 端到端加入（含 alias） |
| 目录、资料、版本查询 | `FederationHandler.ts`（+ `outboundTransaction.queryDirectory/queryProfile/getVersion`） | `FederationHandler` 29 项、`outboundTransaction` 49 项 |
| 传输层（委派下的 SNI/Host、真实 TLS） | `federation/federationFetch.ts` | `federationFetch` 5 项 + `federationTls` 2 项 |
| 有界同步的变更信号（订阅 → sync） | `notifications/roomChangeSubscription.ts`、`roomChangeTracker.ts`、`roomWatchService.ts` | 各 7/7/9 项；`syncChangeSource` 6 项、`syncBoundedReads` 5 项、`scaleOperations` 4 项 |
| 远端加入接线（按 id 与 alias） | `PodMatrixStore.joinRoom/joinRemoteRoom/resolveRoomId` | `remoteJoinStore.test.ts` 4 项；`twoDeployment` 端到端两项 |
| 授权判定不跨请求复用 | `PodMatrixStore.agentGrants/authorize` | `agentGrantFreshness.test.ts` 2 项 |
| 入站事务回执与出站批次落 Pod（控制记录承载） | `matrix/controlRecords.ts`（models 日期布局：一天一目录、一条记录一文档；幂等插入而非 create-once）、`federation/podInboundTransaction.ts`、`federation/podOutboundStore.ts`、`matrix/podAccess.ts`（**store 与控制记录**的写入身份解析点；密钥托管那条路另在 `identityProvisioning.matrixSigningIdentityForPod`，两处必须同答）、容器装配 + `FederationHandler.recordsFor` | 单元 9 + 句柄透传 1 + 写入身份 5 + 出站 store 7 项；**真实 Pod 5 项**（见下） |

**未达成（等拍板，见登记册开头）**：写入侧 ①②③、控制记录的**每记录一文档布局**确认、出站批次的 Pod 承载
（等 `scopes()` 来源）、grant 索取流程、D6 Agent 归属、真实实例验收（另起栈或重启 3000）。
另：`full` 门禁因本机 Docker Desktop 无响应未能运行。

## 控制记录的 Pod 承载（2026-09-27，分支 `codex/matrix-event-primitives`）

这一轮把"事务回执只活在进程内存里"换成了 Pod 里的记录，并在**真实 Pod** 上先把存储语义量出来再写实现。
量出来的三条（探针输出记录在提交信息与契约 §6.1/§6.2）：

| 探测 | 结果 | 后果 |
| --- | --- | --- |
| `PATCH` + `If-None-Match: *`（文档不存在） | **201** | create-once 可用 |
| 两个并发 `If-None-Match: *` | **201 + 412** | 唯一赢家由服务端在同一把资源锁内裁决 |
| 两个并发 `If-Match: <同一 ETag>` | **205 + 205**，ETag 未变 | **`If-Match` 不是版本检查**（ETag = `DC.modified` 毫秒 + content type）→ 不能做预留 |
| `PATCH` 建出的文档 + `DELETE`（容器不存在） | **404**，文档仍在 | 写记录前必须先建容器，否则释放会永久卡住该 key |
| `db.deleteByResource` 后 `findByResource` | 行没了、文档仍在 → 再 `If-None-Match: *` 仍 **412** | 释放必须删**文档** |

证据（可复跑）：

- `tests/integration/MatrixControlRecords.integration.test.ts`（2 项，lite 门禁内、真实栈 + 真实 Pod）：
  三个并发 `reserve` **恰好一个** `created: true` 且失败方读到赢家记录；换一个 store 实例（模拟重启）仍能读到回执、
  重放（载荷不同）取**首次应答**并标记 `conflictAt`；`release` 后同一 key 可再次预留；
  以及 `handleInboundTransaction` 真的把回执写进参与者 Pod 并从记录回答重放。
- `tests/api/matrix/federation/podInboundTransaction.test.ts`（8 项，脚本化 Pod 模型同一套语义）：
  首次创建即写入 Pod、重放取赢家记录、并发唯一赢家、冲突标记不覆盖、完成后重放取首次应答、
  释放后可重试、句柄缺失/scope 不符即拒绝、Pod 拒绝写入时不假装成功。
- `tests/api/matrix/federation/inboundTransaction.test.ts` 新增 1 项：事务层把已解析句柄传给 store 的**每一次**调用。
- `tests/api/matrix/storePodAccess.test.ts` 新增 5 项：`podWriteFor` 每个 context 只解析一次并复用同一 fetch；
  注入的 db 没有 fetch 时拒绝（不给半个授权）；部署自持工作时**不借**调用方会话；
  `controlRecordHandleFor` 把"哪个 Pod"和"以谁的身份"一起解析；context 不含 Pod 时拒绝而不是默认成空 scope。

### 真实实例探测（2026-09-28，lite 真实栈，不需要 Docker）

- 门禁测试 `tests/integration/MatrixInstanceProbe.integration.test.ts`（3 项，全过）：客户端发现 200、
  版本列表 200、**联邦 `/send` 无签名 401**、**原生 `/_xpod/matrix/inbound` 无签名 401**、`/version` 200。
- **它修掉了一个实质缺口**：网关 `Proxy.shouldRouteToApi` 原先只认 `/_matrix`，`/_xpod` 会被当成 CSS 路径 → 404，
  即 ③ 的原生传输在真实部署里到不了对端（客户端会一直回退 `/send`）；补上前缀后探测回 401，已写成断言。
- **`/query/directory` 的 404 不是缺陷**：处理器先解析被寻址名字、不服务即 404，之后才验签；改问本部署服务的名字后回 **401**（已写成断言）。这个顺序是有意的取舍，理由见登记册。

### Agent 授权即成员（2026-09-28，D6 第二步）

- `setState('co.undefineds.agents')` 现在把**新增**的被授权 Agent 变成房间成员：先读上一版授权做 diff
  （必须在写入前读），写入新状态后补**邀请**（sender = 授权人）与 **Agent 自己的 join**
  （`sender == state_key == Agent 的 MXID`，由该 server name 现有密钥签名）。已授权的不重写。
- 证据：`PodMatrixStore.test.ts` 新增 1 项；`tests/api/matrix` **588 passed / 3 skipped**；
  `test:integration:lite` **159 passed / 6 skipped**。
- **撤销授权**：已按登记册既有原则收口——**撤销停执行、不停成员身份**（执行授权与协议成员身份是两件事，
  当前行为已经如此，无需改代码）。
- **v11 规则强制：已上线**（2026-09-28）。本地事件在唯一成形点（`appendEvent` 的 `buildPersistedEvent` 之后、
  落库之前）按房间解析出的 auth events 过 `authorizeEvent`，拒绝即 403 带 `v11-x.y.z` 原因；入站 PDU 仍只判一次。
  试用一轮暴露并修掉两条缺口：**Agent 重新授权只补缺的成员步骤**、**握手 join 用本地 timeline 解自己声明的
  auth events**（不是把常驻方整个状态当 auth events——那是 rule 2.2 拒的做法）；并把 `remoteJoinStore` 的夹具
  补成"常驻方随状态送回 join_rules"的真实形状（没有 join_rules 的房间默认 invite-only，没人邀请的加入本就该被拒）。
  证据：`tests/api/matrix` **588 passed / 3 skipped**、`test:integration:lite` **159 passed / 6 skipped**。

### 入站写入的成员资格判定已接线（2026-09-28）

- `inboundAuthority.ts` 的纯函数（三态：join 放行 / 状态明确说 invite·leave·ban·knock 则拒 / **未知放行**）
  已接进 `PodMatrixStore.acceptReceivedEvent`：在 `materializeReceivedRoom` 之后、写入之前判定，
  membership 取自**解析状态**（不是单槽位读），grant 由 `getDb` 先证。
- **三条回归全部验证通过**：① 邀请仍能送达；② 补房间记录（`materializeReceivedRoom`）先于判定；
  ③ 加入握手带来的"加入之前的状态"（create/join_rules/power_levels，此时本人 membership 未知）不被判死。
- **它同时就是"加入房间拿授权、出房间取消授权"这条口径的实现**：房间级授权＝成员资格本身，
  加入即允许、退出/被踢/被封即 403，不需要第二套凭证生命周期。
- 证据：单元 5 项（判定函数本身）+ `tests/api/matrix` **586 passed / 3 skipped** +
  `test:integration:lite` **159 passed / 6 skipped**（含真实 HTTP 的加入/邀请/消息链路与 `MatrixCollaboration`
  真实运行时夹具，即 ①②③ 都在真实链路上跑过）。

### 本地顺序可从 Pod 重建（2026-09-27，回应"序号为什么要进 Pod"）

- 结论：**序号不进 Pod**。它是部署本地加速器：事件按 `(createdAt, id)` 读、按该顺序发号，
  清空本地表后两次独立重建得到**同一份确定性顺序**。
- 证据：`PodMatrixStore.test.ts` 新增 1 项——同一份 Pod 内容、两个全新的日志实例，sync 出来的事件顺序完全一致，
  且消息按写入顺序出现；**同时记下它重建不出"同毫秒内的到达序"**（按 id 决胜），这既是它不能当客户端游标的理由，
  也是"游标归客户端"这条口径的技术根据。

### 事件预留迁往 Pod 的前置一步（2026-09-27）

- 事件行现在记下**写它的设备**：`metadata.protocols.matrix.txnDevice`（`MatrixEventRecord.txnDevice`）。
  预留记录的 key 是 `[设备, roomId, type, txnId]`，只有设备不在事件上；记下它之后，
  "这个事件属于哪条预留"从事件本身就能回答（两次点查），这是预留记录能搬进 Pod 的前提。
  测试：`PodMatrixStore.test.ts` 新增 1 项（形状 `XPOD…`、不含引号、`event.txnDevice` 不存在——
  它是记账不是协议字段）。
- **为什么是设备而不是整个 key（实测教训）**：key 是 JSON 数组字符串、含引号，而这个存储会把
  `metadata` 里带引号的字符串写坏——整轮 `MatrixCollaboration` 验收因此从 200 变成 **409**
  （`JSON Parse error: Expected '}'`）。改用无引号的设备 token 后恢复。这条缺口记在契约 §8 第 3 条。
- **序号那一半仍未定**：三个选项见契约 §10.2（留 SQL / Pod 计数器 / 取消序号改用
  `(origin_server_ts, event_id)` 游标，推荐第三条——它同时让"有界读取"成为可能）。

### 出站队列的 Pod 承载（2026-09-27）

- `federation/podOutboundStore.ts`：`PodMatrixOutboundStore` 实现队列的四个操作，批次落
  `<day>/outbound-<sha256(key)>.ttl#self`（与回执同一套日期布局，靠文档名的 kind 前缀分开）。
- **枚举靠列目录**：`pending(scope)` = 窗口（7 天）内每天一次容器列举 + 每条批次一次文档读；成本随"欠多少"增长，
  不随 Pod 有多大增长。`scopes()` 由部署回答（已服务的路由派生）；没有提供者时只回答被问到过的 scope。
- `remove` 改为接收整条批次（txnId 只在 `(origin, destination)` 内唯一），队列接口与内存实现同步调整。
- 证据：`podOutboundStore.test.ts` **7 项**（当天文档与容器、按队列过滤与排序、忘掉后可重复忘掉、
  跨天可枚举与超窗不可见、**一天只列举一次而不是每条一次**、`scopes()` 两种来源、无授权即 403）；
  真实 Pod 新增 1 项——写入两条批次后，**换一个 store 实例（模拟重启）靠列目录把欠的批次找回来**，
  删一条后只剩另一条。真实 Pod 用例现共 5 项。
- **已接线**（2026-09-27）：`createMatrixOutboundDelivery` 接受 store，容器装的是 `PodMatrixOutboundStore`；
  `handleFor`（scope → 该 Pod 的句柄）由**已服务的路由**派生、写入时才解析（构造期解析会与它服务的 store 成环），
  `scopes()` 同样来自路由。证据：`MatrixOutboundContainer.test.ts` 新增 2 项——交付对象带的 store 是
  `PodMatrixOutboundStore` 且 `scopes()` 等于已服务的 Pod 根；对**本部署不服务**的 scope 入队被拒
  （`holds no grant`），不会写到不确定的地方；整轮 lite 门禁在该接线生效的情况下通过（容器能起、路由能注册）。

### 控制记录改按 models 的按天累积布局（2026-09-27，回应"为什么要判赢家"）

- **布局**：`<pod>/.data/task/{yyyy}/{MM}/{dd}/<key 的 sha256>.ttl#self`——与 `message.schema.ts`
  的 `{parent}/{yyyy}/{MM}/{dd}/messages.ttl#{key}` 都使用日期目录，但物理文档粒度不同：本节记录当时控制记录的临时实现，Message 使用共享每日文档与唯一 fragment 主体，不要求一条记录一个文档；
  查找窗口 2 天（`CONTROL_RECORD_LOOKBACK_DAYS`）。
- **当时共享每日文档受到序列化缺陷阻碍（历史记录，不是协议限制）**：旧 drizzle-solid 把 `object` 列写成按行位置命名的嵌套主体
  （`<文档>#metadata-1`），同文档两行的 `metadata` 因此合并——实测把一条回执与一条批次读成同一条记录
  （`kind` 变成两个值的数组）。改为一条记录一个文档后消失；这条缺口记在契约 §6.1/§8。
- **日期目录必须由我们创建成容器**：实测文档写进 `.data/task/2026/09/28/` 后按 URL 读得到，但
  `GET 2026/` 与 `2026/09/28/` 都是 **404**——没有容器就列不到、也订阅不到。现在逐层条件 PUT。
- **更正一条早先的测量**："容器 `ldp:contains` 只列出 4 个中的 1 个"是**解析错误**（Turtle 逗号列表），
  容器列成员本来就可用于 PUT 与 PATCH 建出的文档。这条更正重新打开了"客户端按目录列举记录"的路径。
- **语义**：`writeControlRecord` 从"create-once + CAS"改为"**幂等插入 + 记录优先**"。`reserve` 的保证从
  "恰好一个赢家"改为"Pod 里只有一条记录、重放从记录回答"——这是这次实测 + 用户提问共同得出的结论
  （契约 §6.2/§6.3）。
- **顺带消掉两处复杂度**：不再需要"写前先条件 PUT 容器"与"释放要删文档"（从不删文档，
  `deleteControlRecord` 只删记录自己的三元组）；`controlRecords.ts` 现在**全部走 drizzle-solid**，
  没有任何绕过。
- 证据：单元 9 项（含"并发只为同一 id 留下一条记录"、跨天查找与超窗当新事务、释放后可再预留、
  句柄缺失/scope 不符即拒绝、Pod 拒绝写入不假装成功）；真实 Pod 3 项——**断言记录真的落在
  `.data/task/<yyyy>/<MM>/<dd>/transactions.ttl`**（HEAD 200）、重启后仍可读、重放取首次应答并标
  `conflictAt`、释放后可重预留、批次载荷原样往返。

### 原生入站端点（2026-09-27，③ 的第一步）

- `POST /_xpod/matrix/inbound/:txnId`：两个 Xpod 部署之间的写入路径，复用 `/send` 的全部判定
  （签名认证、origin 一致、体积上限、事务预占/重放、Pod 回执），只去掉联邦传输（`:8448`/SNI/`.well-known`）。
  响应按事件命名（`events`），错误码与 `/send` 同一套。
- 证据：`tests/api/handlers/FederationHandler.test.ts` 新增 4 项（经真实 HTTP 写入并逐事件应答、
  重放取首次记录不写第二遍、签名/origin/被寻址名字同样被校验、非 JSON `400 M_NOT_JSON` 与超限 `413 M_TOO_LARGE`），
  该文件 33 项全过。**未做**：部署间的客户端与出站选传输（下一步）。

### 原生传输的客户端与选择（2026-09-27，③ 的第二、三步）

- **客户端**（`federation/outboundTransaction.ts`）：`sendNativeTransaction` / `deliverNativeTransaction`
  把同一份已签名内容 POST 到 `<server name>/_xpod/matrix/inbound/<txnId>`；应答里的 `events` 折成与 `/send`
  同一个 `pdus` 结果图，所以队列只认一种形状。**404 读作"对方没有这条路由"（`unsupported`），不是拒绝**；
  其它 4xx 仍是对方的决定。地址规则是**名字本身 + 普通 HTTPS**（`nativeTargetOf`，`via: 'native-endpoint'`）：
  没有 `:8448`、没有 `.well-known`、没有 SRV——原生调用不是联邦流量，没有可委派的东西。
- **选择**（`federation/outboundSender.ts`）：**原生优先**；对方 404 就回退 `/send`（**同一个 txnId**——
  两条路共用同一份回执记录，所以"对方其实收到了"时它会直接重放首次应答）；**拒绝不回退**（那是对事件的
  决定，换个传输再问一次等于让它决定两遍）；**不可达只重试原生**（"对方还没决定"，换传输可能重复投递）。
  每个目的地记住一次答案，TTL 10 分钟（本地加速器，重启即丢，只影响先发哪个请求）。
- 证据：`outboundTransaction.test.ts` 49 → **54 项**（真实签名可被对端认证、原生路径与 POST、`events`→`pdus`、
  404=unsupported 与 403=rejected 的区别、同 txnId 重试、默认地址规则）；`outboundSender.test.ts` 7 → **12 项**
  （原生优先且不再联邦、404 回退并记住、TTL 过后重探、拒绝不回退、不可达保持重试）；
  `twoDeployment.test.ts` 的真实 HTTP 一项改为断言**事务走原生路径**（到 B ≥3 次、到 A ≥1 次，
  且 `/_matrix/federation/v1/send/` **一次都没有**），握手/读取端点仍是 Matrix；
  `outboundDelivery.test.ts` 的夹具明确扮演"只会 Matrix 的对端"，把回退路径也覆盖到。

### 出站批次载荷（2026-09-27，同一分支）

- `federation/outboundBatches.ts`：一条批次 ↔ 一条 `taskResource` 的映射（`metadata` 原样保存
  pdus/edus/attempts/notBefore/lastReason，`status` 一律 `open`，key = `[origin, destination, txnId]`）。
  证据：单元 6 项 + 真实 Pod 1 项（带签名的 PDU 与 EDU **原样往返**，换读者读回同一批）。
- **枚举实测**（同一轮，真实 Pod 的 `.data/task/` 4 行）：全表 `select` = **1 次 SPARQL 查询 + 每行 1 次文档 GET**；
  带 `FILTER(?status=…)` 的 select 只 GET 命中行（过滤可下推，但 `status='open'` 不具选择性）；
  容器 `ldp:contains` **只列出 4 个文档中的 1 个** → 对 PATCH 建出的文档不可信。
  结论与三个选项见[控制记录契约](matrix-control-records-contract.md) §9.2；**Pod 版出站 store 在定案前不实现**。

门禁（在 `f6705734` 上复跑，全文以这一处为准；上面各节里的数字是当时那一轮的）：
`typecheck:test` 通过；`tests/api/matrix` **600 passed / 3 skipped**；
`tests/api tests/http` **2054 passed / 67 skipped**；`test:integration:lite` **162 passed / 6 skipped（32 文件通过 / 3 跳过）**，
含 6 项真实 Pod 用例、真实栈端点探测（3 项）与 `MatrixCollaboration` 的真实运行时夹具。
**注意**：这里的数字是**当前分支**的门禁，不改变本文件的时代边界——上面各节验收的是 **Matrix 形状那一版**，
当前协议方向与逐项进度见 [Solid 多方通信协议](solid-multiparty-protocol.md) 与
[改造清单的「进度总览」](solid-multiparty-migration.md)。
**未做**：真实实例（本机 3000 是别的构建；Docker 见下）、`full` 门禁（需要 Docker）、控制记录天文档的物理回收。

### Docker 引擎仍然卡住（2026-09-28 复核，逐项测出来的）

| 探测 | 结果 |
| --- | --- |
| `/var/run/docker.sock` → `~/.docker/run/docker.sock` | 存在（symlink 与 socket 都在） |
| Docker Desktop 进程 | 在跑（`Docker Desktop`、Helper GPU/Network 等） |
| `docker context ls` | **秒回**（这是客户端本地信息） |
| `docker info` / `docker ps` | **挂住**，45 秒与 90 秒两次都被 SIGTERM 杀掉 |

**colima 这条路也断了**（2026-09-28 复核）：`~/.colima/default/docker.sock` **不存在**（colima 没在跑）——
直接 `DOCKER_HOST=unix://…/colima/default/docker.sock docker ps` 立刻回 "no such file or directory"，
所以不是"换个 context 就好"，必须先把某个引擎启动起来。

结论：**客户端在、daemon 不答**（Docker Desktop 引擎卡死，不是没启动；colima 未运行）。
所以 `full` 门禁与任何 Docker 起的真实实例都不能跑；需要**重启 Docker Desktop 的引擎**（UI 里 Quit/Restart），
或 `colima start` 后再试。恢复后第一件事：`docker ps` 能秒回 → 跑 `bun run test:integration:full` → 再补真实实例证据。

2026-10-03 B0／运行器最终复跑：原命令 `bun run test:integration`（5041）实际退出0，lite165通过／6环境跳过、Docker45通过，Docker测试结束和自有清理标记齐全；1897冻结输入零变化，11:26:54–11:37:07 UTC无Sleep/Wake。该证据通过B0及运行器回归，不替代C2、G01–G12、用户当前Gateway、合入或发布。此前27747实际退出0但未完成Docker的失败记录保留。下一步已由原生GPT‑6.1 Sol开发邀请service/source-port基础，根独立验收，尚未启用普通C2门禁。

邀请基础模块最终专项：共享一个不可变RDF快照复制函数，保留resolver WeakSet／port WeakMap与身份策略；去重前后61项回归均通过。独立41926为144通过／14文件，1903冻结输入无变化；源码build54053及测试类型89080实际0。先前preprojection与两种readback窗口失败均保留，修复已覆盖。原full54523已启动，尚无最终完整结果；actual原actor PDU/maker、invite/create接线、join/leave/ACL与全部C2／G01–G12仍待完成。

2026-10-03 12:06 UTC：邀请基础模块原版完整集成54523实际退出0，lite165通过／6环境跳过、Docker45通过，完成和自有清理标记齐全；1903冻结输入零变化，11:58:41–12:06:33 UTC无Sleep/Wake。与独立144项合跑一起通过该基础切片验收；原作者Pod PDU适配、业务路由、ACL生命周期、G01–G12、用户当前Gateway及合入发布仍待完成。下一片先实现严格原作者PDU读取／恢复，不改变普通消息和游标语义。

2026-10-03 原作者邀请PDU adapter专项：开发101项／4文件，独立174项／15文件通过；源码构建、测试类型与依赖／diff门禁退出0。独立新30项使用实际HTTP、公开ORM生成的条件RDF更新，验证历史作者与当前caller分离、原maker／完整IRI、旧body／父链保留、真实断响应与双HTTP竞争；计数身份header和内存journal不等于DPoP／SQL／当前Gateway证明。独立发现206部分响应被当absence后实际POST1（72698），已修strict reader仅200／404并保留原红例；普通reader行为不变。原完整36075实际退出0：lite165通过／6环境跳过、Docker45通过，两完成标记齐全；1906输入零变化，无运行区间Sleep/Wake。仅此基础adapter验收通过；join／leave／ACL、可信跨API控制与发现、业务路由、W0–W5／G01–G12、用户Gateway及合入发布仍待完成。

2026-10-03 成员 source 阶段切片：独立最终201项／16文件通过（56766），其中27项实际HTTP／公开ORM条件RDF／SQLite-vault验收，1907输入无变化；开发侧39项／3文件、源码build55711、测试类型54585及依赖／diff检查通过。完成操作槽按当前完整canonical CAS退休，不再重读上一私有PDU；这不确认旧事件或推进游标，未完成槽仍不可覆盖，publication补队列义务保留。根新增空named capability依赖负例2354为26通过／1失败，修正为立即failclosed后通过；真实resolver原本只有proof或throw，不称现网绕过。原完整80718正在运行。内部phase mark不证明真实ACL授撤或原actor PDU完成，业务路由、ownerRecovery、跨API控制、全部G门禁及用户Gateway仍待完成。

2026-10-03 成员source阶段原版完整集成80718实际退出0：lite165通过／6环境跳过、Docker45通过，结束与自有清理标记齐全；1907输入零变化，12:52:44–12:57:32 UTC无Sleep/Wake。独立201项与最终build／测试类型共同通过该内部阶段基础验收。实际ACL、ownerRecovery、业务路由／跨API及完整C2／G01–G12／用户Gateway／合入发布仍待完成。

2026-10-03 B1只读策略观测专项：真实Link发现、不猜ACL后缀；完整八个历史日桶递归观测，历史Message正文GET为0；200-empty与404分开、未知／冲突／预算耗尽显式不完整。独立27项与联合228项／17文件通过（8546／47527），1912输入零变化；开发95项、顺序build／测试类型及独立复审通过。真实Bun八组初始化／resolver／bookend／观测悬挂响应都有限取消并关闭TCP，写入0；初始超时拒绝而不伪造scope。共用sealed source setup与惰性单ORM句柄，观察能力不提供CAS。原完整45260正在运行。`effectiveRead`始终为`not-proved`，本片不调用ACL写或phase mark；提交时拓扑／完整策略守卫、实际授撤、ownerRecovery、跨API／业务接线、G01–G12／用户Gateway及合入发布仍待完成。

2026-10-03 B1只读观测原版完整复跑93228实际退出0：lite165通过／6环境跳过、Docker45通过，完成与自有清理标记齐全；1912输入零变化，13:51:12–13:54:30 UTC无Sleep/Wake。结合独立228项、真实Bun八组取消及最终build／测试类型，通过该只读观测范围验收。先前45260退出1的API5741冲突保留：确认运行器漏预分配ingress，local ingress5741撞上尚未启动的standaloneAPI5741；实际生产分配函数也复现api==ingress。属于原端口分配覆盖缺口，不能因原样重跑通过忽略，下一步收口四端口分配。实际有效Read／持锁提交守卫、ACL生命周期、ownerRecovery、业务与跨API接线、全部G门禁、当前Gateway及合入发布仍待完成。

2026-10-03 四端口分配修复最终验收：Gateway／CSS／API／ingress 共用分配函数，先校验并排除全部显式端口，完整运行器提前登记四端口并经实际 bootstrap 传递 ingress。开发58项／4文件、顺序源码构建50008与测试类型83914退出0，独立真实 Bun 16项通过，静态复审 scoped CLEAR。原命令完整集成92039实际退出0：lite165通过／6环境跳过（210.37s）、Docker45通过（9.06s），完成与自有清理标记齐全；1912输入零变化，14:03:26–14:07:48 UTC无Sleep/Wake。此前API／ingress重复端口红例保留。该修复通过局部验收；端口探测仍非OS预留，实际有效Read、持锁完整策略守卫、ACL生命周期、ownerRecovery、跨API／业务接线、全部G门禁、当前Gateway及合入发布仍待完成。

2026-10-03 15:34 UTC，服务端完整策略守卫最终验收通过：独立合跑9622为291项／20文件通过，包含实际CSS HTTP／持锁RDF持久化、策略摘要和真实Components配置实例化；1919冻结输入零变化。开发侧最终141项／6文件通过；Literal接线修复另有57项／2文件与原CLI／Matrix两个实际集成文件通过；顺序源码build76107、Components构建84520和测试类型16891实际退出0。原命令完整复跑82676实际退出0：lite165通过／6环境跳过（221.75s），Docker45通过（9.19s），Docker结束和自有清理标记齐全，1919输入零变化，15:30:07–15:34:40 UTC无Sleep/Wake。

首个完整运行7969的两项启动失败保留：内部策略profile写成Components资源而不是RDF字符串Literal，属于产品接线缺陷；改为`@value`后由实际配置注册器和原集成测试验证。旧根DI夹具需要补真实store／locker／IdentifierStrategy依赖的75304失败，则单独计作根夹具适配成本。最终通过不抹掉前述缺陷或返工。当前只验收服务端完整策略守卫；实际持久化测试的原生协议生产者是Comunica，固定WebID并非当前Gateway的DPoP／生产QLever／多进程Redis证明。Matrix受守卫传输、有效Read、ACL生命周期、ownerRecovery、业务与跨API接线、G01–G12、当前Gateway及合入发布仍待完成。

2026-10-04（本地日期）：封存Matrix受守卫传输最终范围验收通过。独立87599实际退出0，305项／22文件通过，1923冻结输入零变化（17:03:30–17:08:12 UTC）；原命令完整集成9686实际退出0，lite165通过／6环境跳过，Docker45通过，完成与自有清理标记齐全；1923输入零变化，17:09:30–17:21:23 UTC无Sleep/Wake。最后build52729→Components56888→测试类型94341退出0，静态增量复审无新增阻断。实际CSS GET／HEAD验证普通子项完整列出、辅助资源过滤及实际非后缀Link。客户端完整历史guard、精确回读、预算早停、只读lease永久等待有限拒绝／晚返零请求、响应丢失拒绝采用winner均通过独立验收。

保留独立45600的两条产品红例：公开只读context泄露owner named私有URI读取；participants改动时metadata同谓词未修改quad丢失仍被假确认。已将品牌与context内聚、关闭能力逃逸，并改为精确subject/predicate保留比较。预算循环结束才判超限的静态问题也修为逐quad早停。根8441中converter输入偏好和PodLookup构造错误、36395的MatrixError错误字段断言、80233与8441短并行窗口另记为根夹具／调度成本；不算产品缺陷，也不声称负载隔离的速度对照。

按用户最新指令，后续开发、修复、自测、验收和发布由opencode-b负责，仅实际429切回GPT‑6.1 Sol；根继续设计与最终证据核对。这次通过仅是封存传输基础；计数身份HTTP不是当前Gateway DPoP，策略reply不是有效Read，Comunica协议生产者不是生产QLever。实际ACL／成员阶段、ACP、ownerRecovery、业务和跨API接线、完整W0–W5／G01–G12、当前Gateway、合入及发布仍未完成。
