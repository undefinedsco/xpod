# Agent 目录 MVP：开发与验收任务书

当前执行约定（2026-10-05）：AgentFS 是产品主线，依据见 [选型决定](xpod-cli-engine-selection.md)。用户已指定账号 B 的 `opencode-go/deepseek-v4.1-flash` 负责开发、修复、自测和发布；主负责人负责设计及独立验收。只有确认该 provider 返回 HTTP 429，才切换 GPT-6.1 Sol。代理自然退出、磁盘不足或工具拒绝不构成切换条件。本页不是最终发布完成记录。

当前服务发行开发在 `codex/agentfs-current-release`；挂载验收在 `/Users/ganlu/.codex/worktrees/agentfs-native-acceptance/xpod` 的 `codex/agentfs-mounted-platform-acceptance`，消费冻结产品 `c7e9aadbf87302908e766411f4ea1fea6d0a54bf`，产品与测试源码分别绑定。私有诊断使用 `codex/private17-rc024-admission`。主 checkout 不参与开发。最新验收范围见 [目录验收记录](agent-directory-mvp-acceptance.md)；下面的工作区与职责段保留为 2026-10-01 的历史安排，不作为当前执行约定。

## 历史工作区与职责（2026-10-01）

- 唯一开发工作区：`/Users/ganlu/develop/.worktrees/xpod-virtual-folder-design`。
- 唯一开发分支：`codex/virtual-folder-design`；基线 `9c88a0ac2003998f15b7ad466328759dd9a35d64`。
- 不修改主 checkout、其他 worktree、共享 models 仓库或系统 rg/grep。
- 主负责人接手产品代码和测试；可继续使用只读独立审查，不再启动实现 worker 修改相同文件。
- 当前已有未提交的设计/调研文件必须保留。不得 reset、clean、覆盖他人修改、自动提交/推送或另开产品路线。
- 不新增依赖；先复用 Bun、已有客户端认证、Solid 授权链及存储接口。原生挂载技术需要以验证结果决定，不因 AgentFS 有接口就宣布它已接入。

## 固定设计

Local / Cloud 的 Pod 目录访问统一走已认证 HTTP。同机不保留持久正文读缓存，远端按需缓存；临时编辑、dirty 和 pending 文件不属于可随意淘汰的缓存。Pod 是文件权威；外部项目只在 Pod 保留 Link，Git/worktree 生命周期属于外部工具。

Agent 执行环境前置 rg wrapper，受管理路径走 HTTP 搜索，普通路径和不支持的调用转交预先解析的原生 rg。先交付 rg，再依据真实调用增加 grep；不替换系统可执行文件。语义搜索单独暴露，不把 VEC 近似命中作为精确 grep。

会话存在未提交 delta 时，受支持的 rg 调用也转交实际挂载视图上的原生 rg；远端索引不能代表未发布修改。clean 会话使用 HTTP 搜索，查询期间若 native manifest 发生变化则回退到挂载视图。TS 仅观察 native manifest，不写第二份 pending 状态。

原生 session 的 MVP 采用跨进程文件锁，每次事务重新读取 manifest。显式 commit 与本地修改串行执行；持久记录条件请求意图，保存确认结果后回收正文。请求结果不确定或写响应缺 ETag 时保留 dirty 并要求恢复，不换用新 HEAD 自动覆盖。该串行策略不宣称原生性能或多客户端并行提交能力。

## 开发次序

1. 先核对当前源码的 CLI 入口、认证/DPoP 生命周期、CSS 逐资源权限与服务注册方式。形成简短的实际文件/接口映射，遇到与任务书冲突的架构选择上报主负责人。
2. 交付 HTTP 目录枚举与精确内容查询的最小链路，以及可实际执行的 rg wrapper。首批兼容 `--files` 和显式固定字符串搜索；仅在等价性有测试保护时加入 `-n`、`-l`、路径过滤等组合。regex、ignore、编码、输出等不兼容组合必须走原生回退，不静默改变语义。
3. 接入已有认证生命周期和 CLI 启动方式；提供按会话生效的 PATH 安装/注入入口。未知选项、stdin、管道、混合根目录等保留原生行为。支持范围必须写清楚。
4. 再验证按需文件视图 backend 和挂载接入，逐文件版本基线、条件写回、缓存策略与本地 delta 合并。挂载不可用必须报告具体缺口，不能用全目录复制伪装按需挂载。

全文精确查询允许服务端扫描已授权正文作为第一版通用实现；这不等于索引优化已完成。不得向客户端回传全目录正文再在那里 grep。FTS 仅能用作不会漏匹配的候选筛选；索引覆盖不完整时扫描缺口或明确失败。目录/文件名/片段/计数均须逐资源权限过滤，认证成功不等于任意资源可读。

服务路由必须真实注册到当前运行链路。不得把仅存在于测试夹具里的 endpoint、绕过权限的 backing directory 或无消费者的接口骨架当成交付。服务端禁止执行客户端提交的任意 shell 命令、任意远端 URL 或任意本机路径。

## 验收标准

- 原生 rg 与 wrapper 使用同一夹具做差分：文件集合、命中内容、行号、stdout/stderr、退出码；包含空结果、空文件、UTF-8、隐藏项及支持参数组合。
- 原生命令回退保留 argv、cwd、stdin 与退出状态，不能递归调用 wrapper；路径穿越、根外路径、符号链接越界、恶意 URL 和重定向有拒绝证据。
- HTTP 测试证明资源权限隔离；无权访问的路径、正文和计数都不泄漏。认证刷新与 DPoP 不以假 token 或身份字段代替。
- 支持的远端搜索仅返回结果/元数据；客户端传输统计证明没有下载整个目录正文。索引缺失、过期、分页、截断与并发修改不得造成假“完整零命中”。
- 挂载阶段再证明读取只拉所需文件，dirty/add/delete 合并到搜索视图，冲突不覆盖远端，pending 不被缓存淘汰；同机持久正文读缓存关闭。
- worker 执行针对性测试、`bun run build:ts`、`bun run typecheck:test`、依赖状态检查及完整 `bun run test:integration`。完整集成测试必须在交付前再运行；失败保留根因和日志，禁止修改不相关产品逻辑来迁就夹具。
- 主负责人独立复核 diff、差分/权限证据及关键命令；若未连接当前实际 Gateway，报告只能是隔离集成通过，不能声称真实 Xpod 或第三方 Agent 已验收。

测试数据与运行日志位于 `.test-data/agent-directory-workers/`，结束时清理测试夹具。报告记录执行目录、分支、变更文件、命令及退出码、未完成能力与阻塞；日志不得输出凭据。
