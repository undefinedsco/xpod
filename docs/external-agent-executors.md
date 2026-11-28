# 外部 Agent 执行器规格（AGY、Claude Code）

状态：Draft，供讨论。日期：2026-11-24。

本规格是 X 线：通过 ACP 把 Google Antigravity CLI（AGY）和 Claude Code 作为 Task/Run 的**外部 Agent 执行器**接入。它依赖[模型执行与持久执行规格](pi-native-provider-integration.md)（下称“主规格”）的三项合同：

- 执行合同：主规格 §3.2 的 `RunExecutionBackend` 与合同操作表；
- 两层持久分工：主规格 §3.3，外部 Agent 由 Inngest 投递，执行内的会话与续跑归官方客户端；
- 本机会话位置与跨设备继续：主规格 §6。

外部 Agent 执行器是主规格 §0 接入原则的第 3 层。在厂商允许的范围内，通过 ACP 接入原生 API 未覆盖的 Agent 能力。AGY、Claude Code 和后续执行器都按同一 ACP 路径注册。

外部 Agent 按执行器分别验证、分别激活，作为可选组件按需下载。某个执行器未通过时只有它保持 blocked，不影响另一个执行器，也不影响主规格的 M、D 线。

## 1 依据与适用边界

- AGY 依据 2026-11-24 核对的官方 [Antigravity CLI ACP 文档](https://antigravity.google/docs/cli/acp/)：`agy acp --help` 用于核对已安装版本是否支持 ACP；登录由 `agy` 交互完成或 `agy acp --login` 发起；认证、设置和工具由 CLI 自己拥有。
- Claude 首版审核 [claude-agent-acp](https://github.com/agentclientprotocol/claude-agent-acp)，它以 ACP 接入 Claude Agent SDK。认证和计费分别依据 Anthropic 的[法律与合规说明](https://code.claude.com/docs/en/legal-and-compliance)和[套餐计费说明](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan)，以实际适配器和认证模式验收。
- 本规格中的 **ACP 指 Agent Client Protocol**（[回合与取消](https://agentclientprotocol.com/protocol/v1/prompt-turn)、[会话恢复](https://agentclientprotocol.com/protocol/v1/session-setup)），不是仓库其他位置所说的 Solid Access Control Policy。两者不得混用命名、配置或权限判断。

## 2 现状与目标

**初版基线**：初版审查时，`AcpRunner` 和 `AcpAgentRuntime` 只经测试中的 `AcpRunExecutionBackend` 使用，正式容器使用 `PiAgentRuntimeDriver`。原测试路径每回合新建会话，直接允许权限请求。接入条件是把权限交给 Xpod 审批，通过真实回合结束事件确认完成，并按 §10 分别验收 AGY 与 Claude。

**目标**：

1. Task/Run 通过主规格 §3.2 的同一合同选择 pi、AGY 或 Claude 执行器；选择执行器不等于选择模型，不进入 `/v1/models` 或模型连接池。
2. AGY 用官方原生 `agy acp`，Claude 用经过审查的 ACP 适配器，两者共享 stdio JSON-RPC、审批、取消和会话恢复实现。认证、设置、工具和计费归相应厂商的运行时。
3. 已安装、已认证、能力可用、用户已配置和真实回合已验证分别记录；安装或登录成功不能自动宣称工具、取消、恢复均通过。

## 3 执行器合同

### 3.1 通用 ACP 执行器与 AGY

加固现有 `AcpRunner` 和 `AcpAgentRuntime`，经生产适配接入 `RunExecutionBackend`。版本和功能按 `initialize` 协商结果启用。AGY 注册 `agy acp`，Claude 注册经过审查的 ACP 适配器，共用传输和会话适配。

AGY 是独立执行器，不是合成模型：

- 激活前用 `agy acp --help` 核对已安装版本是否提供 ACP；不支持时报告“需要更新 AGY”，不伪装成可用。
- 登录由官方 CLI 负责：用户在终端交互运行 `agy`，或按文档运行 `agy acp --login`。
- 不把 Google token 复制到 Pod 或 pi；Xpod 只在现有 schema 允许的元数据中记录执行器身份、版本和用户选择。现有 schema 不能表达必要字段或 URI 布局时，先记录 schema 缺口，不自行发明字段、资源类型或 URI。
- 不读取 AGY 的 SQLite、缓存或全局认证文件，不实现 token 代理，不从浏览器或其他 CLI 导入登录态。

### 3.2 Claude Code

Claude 执行器与“Anthropic API 模型由 pi 执行”是两条不同路径。

- 首版复用通用 ACP 执行器，审核并锁定 `claude-agent-acp` 的版本与启动方式。会话恢复、工具审批、取消均通过协商后的 ACP 接口验收。
- **Claude 运行时使用用户自己安装的 `claude` CLI**（2026-11-28 用户决定），Xpod 不随包分发 Claude Code 可执行文件。适配器按需下载并锁定版本与摘要；用户 CLI 无法由 Xpod 预先锁定摘要，因此在激活时解析出绝对路径，用 `claude --version` 记录实际版本，不在支持范围内时报告“需要更新 Claude Code”。每次启动前复核同一路径与版本，变化后重新探测，不静默沿用旧结果。
- 分别验证适配器实际支持的认证模式、官方使用条件和计费。用户订阅登录运行 Agent SDK 时的计费说明，须结合这条 ACP 路径的官方接入条件及真实回合验证后，才能标记订阅模式可用。
- Claude 运行时负责用户登录态。Xpod 通过 ACP 管理交互和任务状态，登录 token 留在 Claude 运行时。
- 实施时先核对已有原生会话和用户授权；普通已授权登录不重复索取确认，只有缺少必要用户操作、需要接受新协议或扩大权限时才按相应动作要求处理。

### 3.3 认证、计费与准入

外部 Agent 的认证和计费归官方客户端；Xpod 不成为 token 代理，不改写父级 Codex provider，也不改变 `dsh-worker` 路由。

| 路径 | 认证/计费权威 | 允许的 Xpod 行为 | 禁止与停止条件 |
| --- | --- | --- | --- |
| AGY 原生 ACP | `agy` 官方客户端 | 启动官方进程、协商能力、按用户授权发起官方登录、桥接会话与权限 | 复制 token、读 SQLite、代收密码、无 ACP 时静默 fallback |
| Claude ACP | Claude 运行时及用户账号 | 启动受审查的适配器、协商能力、桥接会话与权限、验证各认证模式 | 导入或中介 token、以 SDK 存在推断订阅包含、无依据扩大权限 |
| API Key 模式 | 用户提供的 API Key 合同 | 作为独立能力明确标注和验证 | 伪装成订阅成功；与原生登录态混用 |

技术协商成功不等于订阅允许：ACP 只是 Agent 客户端协议，不改变官方授权、计费或套餐范围。无法证明合法模式时停止启用并报告未验证，不用其他账号、执行器或 API Key 透明替代。外部 Agent 也不得反向把 Xpod `/v1` 当作自身认证/订阅的替代通道。

### 3.4 进程、权限与隔离

- 运行时进程使用显式环境变量 allowlist，不继承宿主完整环境；只加入官方客户端完成原生认证所必需且有记录理由的变量。
- 网络出口由执行设备的宿主机统一管理。Claude、AGY 和后续 ACP 执行器共用进程监督器，沿用执行设备的网络路由，并原样继承宿主机传给 Xpod 服务进程的 `HTTP_PROXY`、`HTTPS_PROXY`、`ALL_PROXY`、`NO_PROXY` 及其小写形式。执行器注册不配置代理，也不改写原生客户端的供应商地址。
- **工作区隔离分三层，由最外层兜底**。ACP 文件接口只能限制经协议发起的读写；官方 CLI 自己启动的 shell、hooks 和 MCP 子进程是普通操作系统进程，可以绕过 ACP 直接访问宿主文件。因此：
  1. **操作系统沙箱（强制边界）**：`AgentProcessSupervisor` 在沙箱中启动 ACP 进程及原生运行时，限制对整个进程树生效。macOS 使用 Seatbelt（`sandbox-exec` 配置），Linux 使用 Landlock 或 bubblewrap 命名空间，容器使用挂载边界。开放任务工作区、临时目录以及该执行器对当前用户和工作区所需的原生会话持久写入位置。程序和认证所需资源按已验证的最小权限开放。
  2. **官方 CLI 的权限与沙箱设置**：启用 CLI 自带的权限规则和沙箱选项，关闭工作区之外的 hooks 与 MCP 自动加载。这一层收窄行为，但不作为隔离依据。
  3. **ACP 协商的文件能力**：根目录限制在工作区。
- 所在平台无法提供第 1 层时，该执行器不能标为 verified，只能在用户明确知情同意后以“无隔离”状态运行，界面持续显示该状态；不得以第 2、3 层代替第 1 层宣称已隔离。
- 权限取官方客户端原生策略与 Xpod 策略的交集；默认不 bypass、不 auto-approve、不因“无人值守”自动放行。权限请求进入现有审批并表现为 `waiting_input`，批准前不执行工具，拒绝或超时不重放工具。
- 审批绑定具体回合、请求和动作。客户端仍在线时，将审批结果回复给原请求；进程已退出且客户端无法恢复待审批请求时，旧审批到期，后续由客户端发出新请求。ACP 回合以 `session/prompt` 的最终结果或明确的失败、取消结束；空闲超时按中断处理。
- 固定可执行文件身份与版本：按绝对路径/受控查找结果和版本记录，argv 以数组传递，不经过 shell 插值；命令、参数和环境来自程序侧声明，不来自 Pod 任意脚本。
- stdout 只承载协议/结构化输出；stderr 有界采集并脱敏后用于诊断，不无限缓冲、直接回显或写入用户可见错误。处理输出背压，慢消费者不能导致无界内存增长。
- 未知或未协商的能力返回可辨识的“不支持”状态，不猜测执行。
- 取消和超时收敛整个子进程组，关闭标准流并等待回收；重启、异常退出和取消后不留下僵尸进程或孤儿工具进程。
- 执行器身份或用户作用域变化后，拒收旧执行尝试迟到的结果。
- AGY 和 Claude Code 各自写自己的原生会话。Xpod 本机只保存用户、设备、工作区、执行尝试与原生 session ID 的绑定，并通过协商后的 ACP 能力打开同一会话。执行器注册时记录其原生存储所需的最小范围。启动配置须让该会话在重启后可读写，同时隔离其他工作区和用户的会话。无法满足时，相应隔离模式保持未验证。
- 任务中途不透明切换执行器：不重放已完成的工具副作用，不把配额耗尽自动转成另一账号/另一执行器的透明继续。需要换执行器时创建新的显式 run，并按主规格 §6 选择交接内容。

外部 Agent 的本地进程能力受部署网络和工作区边界约束，不因“本机 CLI”自动获得 Cloud 权限。

## 4 界面、状态与额度

模型用途和执行器由用户分别选择。任务界面单独展示执行器选择（pi/AGY/Claude）；安装 Claude/AGY 不能使模型列表多出名为 `claude`/`linx` 的假模型，也不能创建重复的服务商入口或池连接。任务保存执行器引用，本机保存会话绑定；旧会话 ID 和待审批请求仍归原执行器。

每个执行器显示真实状态和未知原因：

| 状态 | 含义 |
| --- | --- |
| installed | 找到官方可执行文件并记录版本；不代表已登录 |
| authenticated | 官方客户端以文档化方式确认的登录状态；不能靠猜文件推断 |
| available | 版本与能力协商通过，可发起该执行器 |
| configured | 用户为任务选择了该执行器及其工作区/权限 |
| verified | 真实完成一次文本回合，并在受控验收中通过工具、审批和取消/恢复 |

选定外部 Agent 后，可以在该会话内展示它实际声明可选的模型和思考级别；这些是 Agent 的会话选项，不因此成为 Xpod `/v1` 可调用模型或共享连接池成员。

额度与用量只取官方 CLI/API 的文档化输出；未知、失败、过期不显示为 0，不从进程输出猜一个数字。可观测性记录执行器身份、固定版本、协商能力、会话/任务作用域和取消/回收结果，不记录登录 token、原始 stderr 或用户文件内容。

执行器失败不自动切到另一执行器，也不把配额耗尽转成另一账号。

## 5 分发

首版检测用户已有的 AGY CLI 和 Claude Code CLI。用户自行安装和登录厂商 CLI。未安装或版本过低时，Xpod 显示原因和官方安装或升级入口。ACP 适配器（如 `claude-agent-acp`）作为 Xpod 可选组件，按[模块发布与安装合同](module-publication-v2.md)锁定版本与摘要，由 API 和桌面按需下载。登录沿用各运行时自己的流程。二进制再分发须有明确许可与分发设计。

AI Connections 是订阅、API Key 与 CLI 的统一入口：已安装的厂商 CLI 在其中作为一类连接展示安装、版本、登录与可用状态，经 ACP 访问；它与 API Key 连接并存，由用户选择连接决定执行时走哪条路，不出现假模型，也不形成第二套连接目录。

## 6 实施阶段与文件所有权

| 阶段 | 主要文件范围 | 交付和退出条件 |
| --- | --- | --- |
| E1 执行器合同 | `RunExecutionBackend`、容器装配、现有 ACP 实现和审批桥接 | 命令来源、进程取消、回合终态和权限回复通过受控测试，覆盖审批与进程退出 |
| E2 AGY 原生 ACP | 加固 `AcpRunner`、`AcpAgentRuntime`，注册 `agy acp` | 版本探测、能力协商、文本、工具、审批、取消和恢复通过 |
| E3 Claude ACP | 在通用 ACP 执行器注册受审查的 Claude 适配器及测试 | 复用 ACP 传输、审批和取消，验证原生会话恢复及实际认证和计费模式 |
| E4 选择与状态投影 | `AgentRuntimeRegistry` 的目录投影、UI host slots、状态/额度展示和文档 | 模型与执行器分离、五态显示、未知额度、任务绑定和无假模型通过；不新增服务商入口 |

E2 与 E3 分别达到可激活状态即可分别启用。

| 路径 | 所有权职责 |
| --- | --- |
| `src/api/runs/AgentRuntimeRegistry.ts`（拟建） | 单一执行器注册/发现及其 UI 目录投影，独立于 `/v1/models`；注册 AGY/Claude 描述，不建第二张品牌目录。Claude ACP 注册仅在审查过的适配器和真实合同下启用 |
| `src/api/chatkit/runtime/AcpRunner.ts`、`AcpAgentRuntime.ts` | 复用 stdio 传输及回合处理，补齐协商、权限和生命周期；生产适配以 `tests/helpers/AcpRunExecutionBackend.ts` 为现状参考，补上取消和续跑语义 |
| `src/api/runs/AgentProcessSupervisor.ts`（拟建） | 以操作系统沙箱（macOS Seatbelt、Linux Landlock/bubblewrap、容器挂载）启动整个进程树；固定可执行文件与版本，管理参数、环境、工作区和原生会话写入范围，限制输出并回收子进程组 |
| `src/api/runs/AgentPermissionBridge.ts`（拟建） | 官方权限请求与 Xpod 审批的交集、`waiting_input`、拒绝/超时、禁止 tool replay |
| `packages/tasks/src/`、`ui/src/extensions/` 中的任务宿主适配 | 模型用途与执行器分离的共享视图/host 适配；实施前按已有 slots 确定具体文件，不在 API 包内放 UI |
| `tests/api/runs/agent-runtime-contract.test.ts`、`agy-acp-driver.test.ts`、`claude-acp.test.ts`、`agent-process-lifecycle.test.ts`、`agent-permission-bridge.test.ts` | 统一合同、AGY 协商、Claude 认证/计费边界、进程清理、权限交集和未知状态；夹具放 `.test-data/pi-agent-spec/`，不放真实 token 或用户文件 |

外部 Agent 的真实模式验收由父级执行或复核，不能由 worker 自报代替。

## 7 验收矩阵

编号沿用原合并规格，与主规格不重复。

| 编号 | 场景 | 通过条件 |
| --- | --- | --- |
| V17 | AGY ACP 协商 | 记录 `agy` 路径与版本；`agy acp --help` 结果和实际协商能力一致；未知/未协商能力明确拒绝；无 ACP 的版本报告需更新，不静默改用其他模式 |
| V18 | AGY 真实回合 | 在获授权的真实模式下完成文本与工具请求，审批进入 `waiting_input` 且不自动批准，取消能结束回合，恢复后会话仍属于同一用户/工作区/任务 |
| V19 | ACP 能力缺失 | AGY 版本或 Claude 适配器不支持所需 ACP 能力时给出对应原因，保留会话归属，执行器按缺失能力显示状态 |
| V20 | Claude ACP 真实回合 | 经受审查的 ACP 适配器完成真实文本、工具、审批、取消和会话恢复，分别记录已验证的认证与计费模式 |
| V21 | 会话完整性与切换 | 更换执行器不破坏已有会话；session id 不互换；中途切换不重放已完成工具副作用，只允许新的显式 run |
| V22 | 隔离与权限 | 在同一沙箱配置下，每个执行器能保存并在进程重启后恢复自己的原生会话。分别由 ACP 文件接口、shell、hook、MCP 子进程验证无法读写用户主目录中未授权的路径、其他工作区及他人会话。环境 allowlist 和原生/Xpod 权限交集生效。用受控代理与 `NO_PROXY` 验证沙箱进程遵循宿主机提供的出口规则。平台不支持沙箱时执行器不显示 verified |
| V23 | 进程与诊断清理 | 取消、超时、异常退出、重启后无僵尸/孤儿进程或悬挂管道；stderr 有界、脱敏，不泄漏 token、用户文件或原始供应商正文 |
| V24 | 无模型旁路 | Agent 不出现在 `/v1/models`，不创建合成模型/连接；Agent 输出不经假 API 包装成模型或订阅通道 |
| V26 | 未验证状态 | 缺凭据、未登录、版本不支持或真实模式未授权时，状态显示 unverified/blocked 及原因；不显示 verified、可用、零额度或已支持 |
| V27 | 选择与状态 UI | 模型用途和执行器分开选择；五态分别显示；无重复服务商入口，无因安装 Agent 而出现的假模型 |

外部 Agent 使用 fake ACP/CLI 进程验证协议和生命周期，但 fake 通过不能替代真实 AGY/Claude 模式的证据。真实验收提供官方 CLI/ACP 的实际版本、认证模式、真实文本+工具回合、审批、取消/恢复和进程清理证据，并记录进程启动到协商完成、权限等待和回收耗时。未持有授权账号、未完成合法登录或真实模式未获授权时，只报告受控测试或 unverified。

## 8 兼容与回退

外部 Agent 的启用/停用是独立开关，不与主规格的迁移捆绑。停用 AGY/Claude 只移除执行器选择并保留已有任务/会话记录；不删除用户官方客户端的登录态，不重建 Key，不把会话转交其他执行器。回退时终止本任务启动的子进程并确认无遗留。

## 9 启用前必须解决的条件

1. **执行器合同**：统一 driver、进程监督、操作系统沙箱、权限交集、会话绑定和取消回收先通过受控测试；没有这些基础不得直接接真实 CLI。
2. **AGY 官方 ACP 可用性**：确认目标安装版本提供 `agy acp` 且官方原生登录路径可用；不支持时先报告更新，不引入 SQLite 抓取、token 代理或静默替代。
3. **Claude ACP 的认证与计费**：锁定并验证适配器与运行时，在同一 ACP 路径上逐一核对计划启用的认证模式。订阅、API Key 或受支持的云供应商模式分别记录。
4. **法律与用户授权**：先核对已有授权和官方会话，不重复确认已经授权的常规动作；新协议、权限扩张及必须由用户完成的登录步骤按各自动作要求处理，并只在授权范围内验收。

## 10 完成标准

按执行器分别判定，不以“已声明支持”或只完成文档替代：

| 执行器 | 完成条件 |
| --- | --- |
| 公共部分 | V21–V24、V26、V27 通过 |
| AGY | 公共部分 + V17–V19：官方 `agy acp` 在获授权真实模式下完成文本、工具、审批、取消和恢复 |
| Claude | 公共部分 + V19、V20：经统一 ACP 执行器完成真实回合并验证实际启用的认证与计费模式 |

共同条件：未验证状态诚实显示原因；环境 allowlist、工作区隔离、权限交集、审批、无重放、无僵尸进程、stderr 有界脱敏和过期身份拒绝均有测试或真实证据；由父级复核真实验收证据，本规格本身不执行安装、登录、生产切换或发布。
