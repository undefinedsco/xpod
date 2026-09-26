# W2–W4 交付摘要：联网审查剩余工作包

- 分支：`codex/network-audit-w2`（worktree `/Users/ganlu/develop/.worktrees/xpod-main-n20-merge`）
- 基线：`origin/main` = `cf822bb9`（N20 主干合并点），本分支**基于该点**，9 个提交
- 台账：[`network-audit-2026-09-19-reconciliation.md`](network-audit-2026-09-19-reconciliation.md)（第 0 节为滚动状态；第 9、10 节为 W2–W4 处置记录）
- 合入方式：**快进（fast-forward）**——`origin/main` 是本分支的祖先，`git merge-tree --write-tree origin/main HEAD` 无冲突
- 本文只汇总"改了什么、证据在哪、还差什么"；每条判定的推理过程在台账对应小节

## 1. 提交清单

| # | 提交 | 标题 | 对应项 |
| --- | --- | --- | --- |
| 1 | `fd29e5e2` | 🐛 Validate access routes and write signaling sessions atomically | N06、N07 |
| 2 | `06681b46` | 🚧 Bound the P2P data plane and let it stream and cancel | N17 |
| 3 | `b33a3968` | 🧪 Give the supervisor lifecycle test a load-proof budget | N20 测试加固（负载下偶发超时） |
| 4 | `c0ee66da` | 🔐 Seal the raw TCP data plane with a per-session key | N03 |
| 5 | `d7ffbe56` | 🐛 Keep DNS records by type, staging out of production, secrets at 0600 | N14、N15（禁 staging）、N18（权限/退避） |
| 6 | `8cd8ce05` | 🚚 Declare tunnel clients once and resolve them in one order | N16（声明/解析/探测） |
| 7 | `c7dcc8b1` | 🧪 Give the Bun-only tests an entry and stop calling check time latency | N19、N12（诊断面） |
| 8 | `2dbbaa38` | 📝 Make the audit ledger's status table a rolling one | 文档：汇总表归位 |
| 9 | `33cabbd9` | ⏱️ Renew certificates on their own and supervise background services | N15（续期链）、N18（监督） |

## 2. 逐项交付与证据

| 项 | 改了什么（一句话契约） | 负向优先证据 | 落点 |
| --- | --- | --- | --- |
| N03 raw TCP 数据面无认证加密 | 每会话密钥只经认证信令下发，HKDF 派生方向分离密钥，AES-256-GCM 逐帧封装 + 严格序列号 + 握手 nonce 重放守卫；未带密钥的 tcp-punch 会话创建即 400 | `tests/edge/reachability/P2PDataPlaneSecurity.test.ts` 11 例；把封装改成直通后 **3/11 失败**（明文 URL 上 wire、错误密钥可通、篡改帧被投递） | `P2PDataPlaneCrypto.ts`、`TcpP2PDataPlaneTransport.ts`、`TcpP2PSignalingSession.ts`、`ReachabilitySessionService.ts`、`ReachabilityHandler.ts` |
| N06 选路不校验设备/有效期/身份 | 过期/不可解析 expiresAt/`local-only` 在探测前拒绝；探测答案必须带 Solid 身份证据（404/5xx 一律不算） | `ManagedClientFetch.test.ts` +6 例（旧实现 6/6 失败）、`ManagedRouteSelector.test.ts` +3 例（旧实现 3/6 失败） | `RouteValidation.ts`（新）、`ManagedClientFetch.ts`、`ManagedRouteSelector.ts` |
| N07 会话并发读改写丢更新 | `updateNodeMetadataAtomic()` 比较交换 + 服务侧重读重放，耗尽抛 `NodeMetadataConflictError`；会话上限在被写入的那份 metadata 上校验 | `ReachabilitySessionService.atomic.test.ts`（真实 SQLite）：旧语义 **4/5 失败**（丢候选、并发探测写消失、冲突不报错、并发建会话越限） | `db.ts`、`EdgeNodeRepository.ts`、`ReachabilitySessionService.ts` |
| N17 数据面限额/取消/流式 | 帧 8 MiB / 体 4 MiB / 在途 16 / chunk 256 KiB；超限拒绝不排队；cancel 信封让上游 fetch 真被 abort；head→chunk→end 分块流式 | `P2PDataPlaneLimits.test.ts` 11 例；关掉强制后 **7/11 失败** | `P2PDataPlane.ts`、`TcpP2PDataPlaneTransport.ts` |
| N14 DNS 误删可并存记录 | 一次拉回同名全部记录按类型判定；只有 CNAME 互斥才按 ID 删除；MX/TXT 与 A/AAAA 共存；删除强制带类型且拒绝类型不匹配 | `tests/dns/CloudflareDnsProvider.test.ts` +8 例（旧实现 **4/8 失败**） | `CloudflareDnsProvider.ts` |
| N15 生产回退 staging / 续期链 | 默认失败链只有生产 CA；staging 仅限显式配置并告警；续期由后台调度器驱动（到期即续、失败指数退避、停止即停） | ACME 策略 5 例（旧实现 3/5 失败）、调度器 6 例 + 管理面 2 例（关掉循环后 4 例失败） | `AcmeCertificateManager.ts`、`CertificateRenewalScheduler.ts`（新）、`EdgeNodeAgent.ts` |
| N16 产物不含隧道客户端 | provider 目录声明客户端（名字/环境变量/安装提示/许可/可否分发），统一解析顺序（显式→打包→PATH），缺失附安装提示，`scripts/check-tunnel-clients.ts` 预检 | `TunnelClientResolver.test.ts` 9 例 + provider 环境变量 1 例；绕过解析顺序后 **5 例失败** | `TunnelProviderCatalog.ts`、`TunnelClientResolver.ts`（新）、三个 provider、`TunnelLifecycle.ts` |
| N18 监督/退避/权限 | frpc 指数退避 + 健康清零 + 停止/替换语义；私钥与 frpc 配置 0600；`src/api/runtime.ts` 用 `BackgroundServiceSupervisor` 接管 DDNS 与隧道（失败重试、存活复查、停止不被待重试复活） | frpc +4 例、私钥 0600 1 例、监督器 7 例（去掉监督循环后 1 例失败） | `FrpcProcessManager.ts`、`AcmeCertificateManager.ts`、`background-service-supervisor.ts`（新）、`runtime.ts` |
| N19 测试入口漂移 | `bun run test:bun`（`scripts/run-bun-tests.ts`）收集 `tests/bun/**` 与所有 `bun:test` 文件并执行，CI unit job 同时跑 vitest 与 Bun 两个入口；修掉两处真实漂移 | 入口故意放失败用例时 exit=1；11 文件 / 32 例全过 | `scripts/run-bun-tests.ts`（新）、`package.json`、`.github/workflows/ci.yml`、`vitest.config.ts` |
| N12 诊断把"已配置"当"已验证" | `durationMs`→`checkDurationMs`（并注明不是延迟）；能力状态映射显式白/黑名单（invalid/expired 等算 error，未知状态只算 warning） | `NetworkSettingsHandler.test.ts` 新增负例；改回旧映射后 **2 例失败** | `NetworkSettingsHandler.ts`、`ui/src/api/network-settings.ts` |

## 3. 门禁与验收记录

- `bun run build:ts`：每轮通过
- 定向批次：W2 121 文件 / 1120 例；N16 134 文件 / 1387 例；N18 169 文件 / 1651 例；N15+N18 56 文件 / 570 例
- **完整集成（干净跑）**：`618 文件通过 / 38 跳过，6036 通过 / 0 失败 / 0 unhandled error`（exit 0，第 9 个提交前）
- **Bun 入口**：`bun run test:bun` → 11 文件 / 32 例通过，且证明会失败
- 环境噪声（如实记录）：Postgres/PGlite 与脚本类用例在并发负载下偶发超时，隔离复跑均通过；一次干净全跑为 0 失败
- 真实验收：本轮新增的真实实例证据只有 N20 的 kill 矩阵（已随 N20 合入主干）；W2–W4 的改动以隔离测试为主，真实实例验收边界见第 4 节

## 4. 明确未做 / 已知边界

| 项 | 边界 |
| --- | --- |
| N12 | admin 侧仍**不做真实探测**（诚实地报 `unknown`）。要不要对外发探针是产品决策 |
| N16 | 产物仍**未携带任何客户端**；`redistributable` 已声明（cloudflared/frpc 可分发，ngrok 与 natfrp fork 不可），打包落地与干净 OS 验收未做 |
| N03 | 无密钥轮换、**无前向保密**（静态会话密钥 + nonce 派生）；重放守卫是进程内的（1024 条） |
| N07 | `updateNodeMetadataAtomic` 只在 SQLite 上实测过行数路径（PG 同一 SQL 形态，未在 PG 跑） |
| N17 | 上限是每连接而非全局；没有字节/秒级限速；流式是增量扩展而非版本协商 |
| N06 | 会话内已建立路由的**中途切换（failover）**未实现：只保证不选中坏路由并对失败关闭 |
| N15 | cluster 模式证书走心跳下发（`ClusterCertificateManager`），不带本地续期调度 |
| N19 | `ui/src/api/ai-config.test.ts` 等 10 个 Bun 测试现在会跑，但它们与 `tests/bun/**` 不共享 fixture 约定；后续新增 Bun 测试需自行遵守 `bun:test` 导入约定才会被自动收集 |
| 通用 | W2–W4 未做跨机器/跨 NAT 真实验收；`tests/scripts/p2p-dual-smoke.test.ts` 因自建 loopback bridge 不兼容密封握手而**暂时 skip**（原因写在测试里） |

## 5. 合入主干步骤（等下一次发布完成后执行）

```sh
# 1. 确认主干没有新提交（若已前进，先 rebase 并重跑门禁）
git -C /Users/ganlu/develop/.worktrees/xpod-main-n20-merge fetch origin
git -C /Users/ganlu/develop/.worktrees/xpod-main-n20-merge log --oneline -1 origin/main

# 2. 门禁（在分支上）
bun run build:ts && bun run test && bun run test:bun

# 3. 快进合入（origin/main 是祖先，无需合并提交）
git -C /Users/ganlu/develop/.worktrees/xpod-main-n20-merge push origin HEAD:main

# 4. 核对
git log --oneline -1 origin/main
```

不要推 `release/*`：发布线的 RC 会因此作废。
