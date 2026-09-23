# 《Xpod 联网模块审查报告》基线对账（2026-09-19）

- 对账对象：[`network-audit-2026-09-19.md`](/Users/ganlu/.codex/worktrees/external-network/xpod/docs/network-audit-2026-09-19.md)（报告与脱敏证据索引位于 codex worktree，未纳入主仓库）
- 审查基线：`92fc7d5bf7f158096fb1e259053e1f8229f144d3`
- 被对账代码：`/Users/ganlu/develop/xpod`（`release/0.4.5`，HEAD 同为 `92fc7d5b`，**工作区未提交改动 425 文件、未跟踪 313 文件**）
- 对账方式：**静态源码对账**，未执行测试、未修改任何产品代码、未提交或 stash 工作区改动

## 0. 结论摘要

| 判定 | 数量 | 项 |
| --- | --- | --- |
| 已修复 | 17 | W0：N01、N02、N04、N05；W1：N08、N09、N10、N11、N13；W2：N03、N06、N07、N17；W3–W5：N14、N15、N18、N19 |
| 部分修复 | 2 | N12（诊断面已改，admin 端仍不做真实探测）、N16（声明/解析/探测已做，产物仍未携带客户端） |
| 仍存在 | 0 | — |
| 对账后新增 | 1 | N20（真实验收发现的子服务生命周期缺陷，已修复并合入主干，见 4.4 与第 8 节） |

W2–W4 的逐项交付（改了什么、证据在哪、还差什么）见 [`network-audit-w2-w4-delivery.md`](network-audit-w2-w4-delivery.md)。

本表是**滚动状态**：第 3 节的逐项表是对账当日（2026-09-19）的快照，其中标"仍存在/部分缓解"的项若已由 W0–W4 修掉，以本表与各工作包交付记录为准（W0 见 [`network-audit-w0-delivery.md`](network-audit-w0-delivery.md)，W1 见 [`network-audit-w1-self-audit.md`](network-audit-w1-self-audit.md)，W2–W4 见第 9、10 节）。W1 的三家隧道真实验收边界仍以 [`network-audit-w1-three-tunnel-acceptance.md`](network-audit-w1-three-tunnel-acceptance.md) 为准。

结论：**W0（Gateway/API 授权与 Cloud 节点边界）仍是唯一正确的起手点**，报告的可信度经复核成立；同时工作区未提交改动引入了 3 个新的连带事实（第 4 节），其中 1 个是功能性回归风险，需在提交前处理。N20 不在报告范围内，是 W1 真实验收过程中在实际运行实例上观察到的生命周期缺陷，按同一口径补记。

## 1. 为什么要先做这次对账

报告在干净 worktree 中完成，全部行号只对得上 commit `92fc7d5b`；而主工作区同一 commit 上有 425 个已修改文件。若不先分层，就会出现"照着报告去修一批其实已被未提交改动处理掉的问题"，或"误以为未提交改动已经修好"。

报告引用的 39 个文件在当前工作区中的状态：

**已改动（9）**：`src/runtime/Proxy.ts`、`src/api/handlers/AdminHandler.ts`、`src/identity/drizzle/EdgeNodeRepository.ts`、`src/runtime/bootstrap.ts`、`src/api/runtime.ts`、`ui/src/pages/settings/NetworkPage.tsx`、`vitest.config.ts`、`Dockerfile`、`.github/workflows/ci.yml`

**与基线逐字一致（30）** —— 这些文件里的缺陷签名必然仍在，无需重新推断：

```text
src/cli/commands/start.ts
src/edge/reachability/{P2PDataPlane,TcpP2PDataPlaneTransport,TcpP2PSignalingSession,ReachabilitySessionService,RouteSetBuilder,ManagedClientFetch,ManagedRouteSelector}.ts
src/api/handlers/{EdgeNodeSignalHandler,ReachabilityHandler,NetworkSettingsHandler}.ts
src/api/container/{cloud,local,index}.ts
src/api/network/NetworkEnvironmentConfigurationStore.ts
src/edge/{EdgeNodeDnsCoordinator,EdgeNodeHealthProbeService,LocalNetworkManager,EdgeNodeAgentInitializer,EdgeNodeAgent}.ts
src/edge/acme/AcmeCertificateManager.ts
src/edge/frp/FrpcProcessManager.ts
src/dns/cloudflare/CloudflareDnsProvider.ts
src/tunnel/{TunnelProfiles,LocalTunnelProvider}.ts
scripts/build-platform-package.cjs
ui/src/api/{network-settings.ts,network-settings.test.ts}
tests/api/ai-config/NetworkEnvironmentConfigurationStore.test.ts
tests/tunnel/TunnelProfiles.test.ts
```

复核命令（可重复执行）：

```sh
cd /Users/ganlu/develop/xpod
git diff --quiet HEAD -- src/edge/EdgeNodeDnsCoordinator.ts && echo "与基线一致"
git log --oneline -1        # 确认 HEAD 仍是被审基线
```

## 2. 判定口径

- **仍存在**：缺陷签名在当前工作区代码中仍可直接观察到，且没有等价防护落在别的文件/层。
- **部分缓解**：同一类风险在另一条路径或另一层被处理，但本项描述的攻击面或契约仍未闭环。
- **已修复**：本项描述的行为已不可复现，且有对应实现变更。
- **不适用**：报告的前提在当前代码中已不存在。

依据仅来自源码阅读。报告中标注为 R（隔离复现）的结论，我按其引用行号复核了**代码事实**，未重跑其诊断脚本；A（自动化回归）部分见各项"回归现状"列。

## 3. 逐项对账

| 项 | 级别 | 工作区判定 | 关键依据（当前工作区，行号已核对） | 回归现状 / 缺口 |
| --- | --- | --- | --- | --- |
| N01 远端通道被误判为本机管理员 | P0 | **部分缓解** | 判定链未变：`src/runtime/Proxy.ts:249` `isLoopbackRemoteAddress(originalRemoteAddress)` → `:348/:417` 打内部标记 → `src/api/handlers/AdminHandler.ts:202` `peerLoopback && proxyMarker.valid && proxyMarker.originalClientLoopback`。新增 `assertAdminReadAllowed` 把**同一判定**复用到管理读接口，隧道/回环中继场景无任何变化 | `tests/gateway/admin-proxy-auth.test.ts` 已更新为对**直连**远端断言 403；**无隧道/中继来源用例**，即 N01 的真实场景仍无负向回归 |
| N02 心跳可影响其他节点 DNS | P0 | **仍存在** | `src/api/handlers/EdgeNodeSignalHandler.ts:59/135`（metadata 整块 `Object.assign` 合并、DB 绑定仅在缺省时回填）与 `src/edge/EdgeNodeDnsCoordinator.ts:40`（信任 `metadata.subdomain`）两文件与基线逐字一致 | `tests/edge/EdgeNodeDnsCoordinator.test.ts` 只有单节点正例（ipv4/legacy hints/unreachable delete 等），**无 A→B 跨节点负例** |
| N03 raw TCP P2P 无认证加密 | P1 | **已修复（见第 9 节）** | 对账时：`TcpP2PDataPlaneTransport.ts` 全文 `tls/crypto/auth/hmac/handshake` 零命中。现：每会话密钥经认证信令下发，AES-256-GCM 逐帧封装 + 方向分离密钥 + 严格序列号（防重放）+ 握手 nonce 重放守卫；未带密钥的 raw TCP 会话在创建时即被拒（fail closed） | `tests/edge/reachability/P2PDataPlaneSecurity.test.ts` 11 例（含抓包证明明文不出网）；把封装临时关掉后 **3/11 失败** |
| N04 建会话不校验节点访问权 | P1 | **仍存在** | `src/api/handlers/ReachabilityHandler.ts:285` 起：solid/service principal 一律 `allowed: true`，无节点归属与 scope 校验 | 报告已指出的"session owner 只证明创建者"未变 |
| N05 Cloud 健康探测缺网络边界 | P1 | **仍存在** | `src/edge/EdgeNodeHealthProbeService.ts:79-94` `collectCandidates` 只做字符串/去空判断就接受节点上报的 `directCandidates`/tunnel entrypoint/`baseUrl`，全文件无 `169.254`/loopback/link-local/redirect/DNS 重解析守卫（精确 grep 零命中）；`src/api/container/cloud.ts:137` 默认注册探测服务 | `tests/edge/EdgeNodeHealthProbeService.test.ts` **只有 1 个正例**（多位置探测并写样本） |
| N06 选路不校验设备/有效期/身份 | P1 | **已修复（见第 9 节）** | 对账时：`src/edge/reachability/ManagedClientFetch.ts:105` `candidateRoutes` 只按 `health`+`priority` 过滤；`:137` 探测判定为 `response.status < 500`（404 视为通过）。现：过期/不可解析 expiresAt/`local-only` 路由在任何探测之前就被拒，探测答案必须带 Solid 身份证据 | `tests/edge/reachability/ManagedClientFetch.test.ts` 增 6 条负例；对旧代码复跑 6/6 失败 |
| N07 并发会话读改写丢更新 | P1 | **已修复（见第 9 节）** | 对账时：`src/edge/reachability/ReachabilitySessionService.ts:257-269` 是 `getNodeMetadata` → `mergeNodeMetadata` 的读改写；`src/identity/drizzle/EdgeNodeRepository.ts:146-158` 整列写 `metadata`。现：`updateNodeMetadataAtomic` 做比较交换，服务在冲突时重读重放，耗尽即报错 | `tests/edge/reachability/ReachabilitySessionService.atomic.test.ts` + `tests/identity/EdgeNodeRepository.metadata-cas.test.ts`；对旧语义复跑 4/5 失败 |
| N08 关闭/删除后隧道被复活 | P1 | **仍存在** | `src/tunnel/TunnelProfiles.ts:176-192` 回退顺序：显式 ID → legacy provider → 首个可用 profile；`ui/src/pages/settings/NetworkPage.tsx:368` 空值即 None。该文件与基线逐字一致 | ⚠️ `tests/tunnel/TunnelProfiles.test.ts:90`「keeps legacy auto priority when only old provider env values exist」把现有回退行为**断言为预期**，修 N08 必须同步改这条测试 |
| N09 profile 字段/provider 列表跨层不一致 | P1 | **部分缓解** | UI 侧已收敛为单表 `ui/src/utils/tunnel-providers.ts`（含 `sakura_frp`/`frp`，附 `ui/src/utils/tunnel-providers.test.ts`），三处 UI 分支消除；但 API store 仍只认三家（`src/api/network/NetworkEnvironmentConfigurationStore.ts:93`）、runtime 认四家（`src/tunnel/TunnelProfiles.ts:1`）、`NetworkPage.tsx:372` 下拉仅三家 → 跨层契约仍不一致 | `tests/api/ai-config/NetworkEnvironmentConfigurationStore.test.ts` 仍只测 envPatch，无"UI shape → API parser → store → runtime"合同测试 |
| N10 多 profile 凭据按 provider 全局覆盖 | P1 | **仍存在** | `src/api/network/NetworkEnvironmentConfigurationStore.ts:79` 在循环里写 provider 级全局 key（后写覆盖前写）；`src/api/container/index.ts`、`local.ts` 未变 | 无 A/B 切换精确对应各自账号的用例 |
| N11 DNS/HTTPS/P2P 控件未控制真实运行 | P1 | **仍存在** | store 写 `XPOD_HTTPS_CERT_PATH`/`XPOD_HTTPS_KEY_PATH`（`:65-66`），而 `src/runtime/bootstrap.ts:324-325` 实际读 `XPOD_ACME_CERTIFICATE_PATH`/`XPOD_ACME_CERTIFICATE_KEY_PATH`；`XPOD_HTTPS_*` **全仓只写不读**（仅 store 与 AdminHandler 白名单引用）。DNS/P2P 控件映射问题同基线 | 每个控件缺"保存→应用/重启→行为变化与关闭"用例 |
| N12 诊断把"有 URL"当"可达/延迟" | P1 | **部分缓解** | `AdminHandler.ts:411` 新增 `describeUnservedPublicRoute`，并在 `:794` 把 public-ip 从 `pass` 改为 `unknown`（不再仅凭地址断言可达）；但 `src/api/handlers/NetworkSettingsHandler.ts:423/468` 与 `NetworkPage.tsx:491` 未变，仍是"endpoint check 无探测 + 函数耗时当延迟 + 同一结果映射多条地址" | 无"不存在域名/关闭端口/错证书/异网 LAN 不得显示 Reachable"负例 |
| N13 provider 就绪误报及错误目标 | P1 | **仍存在** | ngrok `src/tunnel/NgrokTunnelProvider.ts:197/301-315/381-404`；Cloudflare `LocalTunnelProvider.ts:159/331`；Sakura `SakuraFrpTunnelProvider.ts:93/163`（`login to server success` 即 connected、任意 frpc 即接管）三处均与基线一致 | 无错 token/退出/超时/端口冲突/多隧道/无关 frpc 的负例 |
| N14 Cloudflare DNS 误删可并存记录 | P1 | **已修复（见第 10 节）** | 对账时：`CloudflareDnsProvider` 类型不同即 DELETE、`findRecord` 不带 type 时取 `response[0]`。现：一次拉回同名全部记录、按类型判定；只有 CNAME 互斥才按 ID 删除，MX/TXT 与 A/AAAA 共存；删除强制带类型且拒绝类型不匹配的记录 | `tests/dns/CloudflareDnsProvider.test.ts` +8 例；对旧实现 **4/8 失败**。腾讯云 provider 经核查本来就按 type 过滤，无同类缺陷 |
| N15 生产证书失败回退 staging、续期链不完整 | P1 | **已修复（见 10.2/10.6）** | 对账时：默认 fallback 含 `letsencrypt.staging`，失败即换下一个 CA，且没有任何东西驱动续期。现：默认链只有生产 CA、staging 仅限显式配置并告警、失败报出全部尝试；`CertificateRenewalScheduler` 按间隔检查状态、到期自动续期、失败指数退避、停止后不再续期，`EdgeNodeAgent` 启动续期并在 stop 时收尾 | ACME 6 例 + 调度器 6 例 + agent 侧接线；关掉调度循环后 **4 例失败** |
| N16 发布产物不含隧道客户端 | P1（若承诺免安装） | **部分修复（见第 10.4 节）** | 对账时：产物对三家客户端零命中，也没有"客户端从哪来"的声明。现：provider 目录声明每个客户端（名字/环境变量/安装提示/许可/可否随产物分发），一个解析器统一顺序（显式路径 → 打包目录 → PATH），缺失时报 `binary-missing:<provider>:<binary>` **并附安装提示**，另有 `scripts/check-tunnel-clients.ts` 预检。**产物仍未携带任何客户端**（ngrok 与 natfrp fork 不可分发；cloudflared/frpc 可分发的打包工作未完） | `tests/tunnel/TunnelClientResolver.test.ts` 9 例 + provider 环境变量解析 1 例；绕过解析顺序后 **5 例失败** |
| N17 数据面资源上限、流式与取消缺口 | P1（若启用公网 P2P） | **已修复（见第 9 节）** | 对账时：`TcpP2PDataPlaneTransport.ts` 无帧/请求体/并发上限（仅 `DEFAULT_MAX_CLOCK_ERROR_SECONDS` 常量）；`P2PDataPlane.ts:103` 仍全量读取。现：帧/请求体/响应体/并发四类上限 + 取消信封 + 分块流式（head→chunk→end） | `tests/edge/reachability/P2PDataPlaneLimits.test.ts` 11 例；暂时关掉强制后 **7/11 失败** |
| N18 恢复监督、动态选路与文件权限 | P2 | **已修复（见 10.3/10.6）** | 对账时：frpc 固定 1s 重启、`stop()` 不取消待重启、私钥与 frpc 配置默认 0644、`startBackgroundServices()` 对每个后台服务只 start 一次。现：frpc 指数退避 + 健康清零 + 停止/替换语义修正；私钥与 frpc 配置 0600；**DDNS 与隧道 provider 由 `BackgroundServiceSupervisor` 接管**（启动失败退避重试、起来后按间隔复查存活、失败即重启、停止后不被待重试复活）；选路侧由 N06 的按有效期/身份过滤 + 失败关闭覆盖 | `tests/api/BackgroundServiceSupervisor.test.ts` 7 例（去掉监督循环后 1 例失败）、frpc +4 例、ACME 私钥 0600 1 例 |
| N19 测试入口与合同覆盖漂移 | P2 | **已修复（见第 10.5 节）** | 对账时：`tests/bun/**` 与 10 个 `bun:test` 的 UI 测试都只被排除、没有任何执行入口。现：`bun run test:bun`（`scripts/run-bun-tests.ts`）自动收集并执行这些文件，CI 的 unit job 同时跑 vitest 入口与 Bun 入口；两处漂移已修（`network-settings.test.ts` 参数名、AiConfig 模型 ref 改为从 models 包推导） | Bun 入口 11 文件 / 32 例全过；故意放一个失败用例时入口 exit=1 |
| N20 子服务放弃重启后网关仍报健康 | P0 | **仍存在（对账后新增，见 4.4）** | 修复前 `src/supervisor/Supervisor.ts`：`restartCount <= MAX_RESTARTS(5)` 之后只 `console.error` 并把状态留在 `stopped`，重启间隔固定 2s、无健康度重置；`src/supervisor/types.ts` 状态集只有 `stopped/starting/running/crashed`，没有"已放弃"；`src/runtime/Proxy.ts` 的 `/service/status` 只按 CSS 就绪判定 `200/503`（`:705-712`）；`src/cli/commands/stop.ts` 把 `503` 当不可达直接抛错 | 无"子服务反复失败/不可恢复失败/停机取消重启"的负向回归；W1 真实验收在活实例上直接复现（见 4.4） |

## 4. 工作区未提交改动带来的三个新事实

### 4.1 管理读接口新加"循环信任"，并带来功能性回归风险

工作区新增 `assertAdminReadAllowed`（`src/api/handlers/AdminHandler.ts:219`），把原先完全公开（`public: true`、跳过 MultiAuthenticator）的管理读接口——`/api/admin/status`、`/config`、`/logs/file`、`/logs/stream`、`/public-ip`、以及 `src/api/handlers/AdminDdnsHandler.ts` 的 `/api/admin/ddns*`——改为复用 `isAdminMutationAllowed` 判定。

- **安全面**：判定仍是"loopback 即管理员"，因此 N01 描述的隧道/回环中继攻击面**没有变化**；被收紧的只是直连远端。（同一循环信任现在覆盖更多接口。）
- **功能面（需在提交前决策）**：`ui/src/pages/settings/ServicesPage` 依赖上述全部读接口（调用点见 `ui/src/pages/settings/ServicesPage.test.tsx:99-109`）。非本机浏览器（canonical 域名、隧道入口、桌面端异机）访问这些接口现在会拿到 403，设置页将失去数据。要么给这些读接口一个显式认证入口，要么确认该页面只在本机（loopback）使用。
- 本节为静态分析结论，**未运行任何测试**验证。

### 4.2 provider 词汇表从"两层不一致"变成"三层"

| 层 | 取值 | 位置 |
| --- | --- | --- |
| UI 共享表（新） | `ngrok`、`cloudflare`、`sakura_frp`、`frp` | `ui/src/utils/tunnel-providers.ts:11` |
| UI 下拉 | `ngrok`、`cloudflare`、`frp` | `ui/src/pages/settings/NetworkPage.tsx:372` |
| API store 解析白名单 | `ngrok`、`cloudflare`、`frp` | `src/api/network/NetworkEnvironmentConfigurationStore.ts:93` |
| runtime profile 取值 | `ngrok`、`cloudflare`、`sakura_frp`、`frp` | `src/tunnel/TunnelProfiles.ts:1` |

即：UI 层现在能表达 `sakura_frp`，而 store 回读时会把它丢弃 —— N09 的跨层漂移仍在，且比报告描述时更显性。W1 应把 provider 注册收敛成单一来源，而不是再补一张表。

### 4.3 新增的 Bun-only 测试没有任何执行入口（N19 的新实例）

- `vitest.config.ts` 新增排除 `tests/bun/**`（注释：Bun-only runtime tests）。
- `tests/bun/gateway-upgrade-relay.test.ts` 为**未跟踪新文件**。
- CI 只跑 `bun run test:run`（`ci.yml:45`）；`package.json` 只有 `test:bun:runtime`（跑 `scripts/run-bun-runtime-smoke.ts`，与该目录无关），**没有** `bun test tests/bun` 之类的入口。

结论：报告要求的"两类测试入口统一纳入门禁"尚未发生，工作区又新增了一处排除；W4 需要给 `tests/bun/**` 一个明确的执行入口，否则它永远不会失败。

### 4.4 子服务放弃重启后，网关继续对外报健康（N20，真实验收现场发现）

本节不是静态对账结论，而是 **2026-09-21 在正在运行的真实实例上**（Cloud 已注册并心跳的 `7cca443f57b7b8bba68b56344237a4a2.nodes.undefineds.co` 本地实例）观察到的现象，证据来自该实例自己的 supervisor 日志与 HTTP 响应，未做任何代码改动即复现：

1. `api` 子进程反复启动失败，supervisor 依次记录 `Restarting api in 2s... (attempt 1/5 … 5/5)`，第 5 次之后打印 `[Supervisor] api exceeded max restarts (5), giving up`；
2. 放弃之后 **没有**任何失败状态对外可见：`ServiceState` 只有 `stopped`，`/service/status` 依然返回 **200**；
3. 结果是**半死实例**：gateway 与 CSS 正常，但 `/api/*`、`/provision/*` 全程 `502 ECONNREFUSED`，持续数小时直到 22:38:36 收到 SIGTERM 才结束；
4. 触发原因本身是环境级的（`Cannot find package 'global-logger-factory'` 的瞬时依赖状态 + Bun `internalConnectMultipleTimeout` 的 `TypeError`），但因为第 1–3 步，**运行中无法区分"某个子服务已死"与"一切正常"**，`xpod stop` 也会因 `503` 被当作不可达而失败。

修复后的确切契约、改动文件与回归用例见第 8 节。判定级别按对账口径取 **P0**：它把"服务不可用"伪装成"服务健康"，与本报告 N01/N02 同属"边界判断错误导致信任错位"的一类，只是这次错在进程健康面。

## 5. 修复清单（沿用报告 W0–W5 归位）

| 包 | 项 | 可复用的工作区改动 | 需新写 | 负向回归落点 |
| --- | --- | --- | --- | --- |
| W0 | N01 | 读接口鉴权骨架（复用同一判定函数） | 把"远端身份"从"回环事实"里拆出来：管理面改显式认证/可信 IPC，`Proxy.ts` 不再用对端地址签署本机管理标记 | `tests/gateway/admin-proxy-auth.test.ts` 增隧道/中继来源用例（伪造 forwarded/内部标记 + 经 loopback 中继的真实请求） |
| W0 | N02 | `DdnsHandler.ts` 新增的 `assertRecordAccess` 归属校验可作同一模式的参考 | subdomain 只取控制面分配；心跳不得覆盖；upsert/delete 校验记录归属 | `tests/edge/EdgeNodeDnsCoordinator.test.ts` 增 A/B 跨节点、根域、保留名、失联清理 |
| W0 | N04 | — | 建会话前校验节点归属/显式授权 + service scope，再过滤候选 | `tests/api/handlers/ReachabilityHandler.test.ts` 增无关 WebID/无关 scope/已撤销设备 |
| W0 | N05 | — | 探测目标限已授权公网；对解析结果与每次重定向校验 | `tests/edge/EdgeNodeHealthProbeService.test.ts` 增私网/元数据地址/重定向入私网/DNS rebinding |
| W1 | N08–N11 | N09 的 UI 单表是收敛起点；N12 的 `describeUnservedPublicRoute` 展示了"本机可判定事实"的写法 | 统一 provider 注册与 profile 契约；停用语义权威化；profile-scoped 凭据；控件字段逐个定性（用户决策/推导值/不支持） | `tests/tunnel/TunnelProfiles.test.ts:90` 需改写；补 `NetworkEnvironmentConfigurationStore` 合同测试（真实 UI shape → API → store → runtime） |
| W2 | N03、N06、N07、N17 | — | 数据面认证加密与身份绑定；按设备/网络范围/expiresAt/身份过滤后再探测；会话原子写；帧/并发/取消/流式限额 | 各 `tests/edge/reachability/*` 增负例；未完成前显式禁用公网数据面 |
| W3 | N13–N16、N18、N20 | — | 生命周期四阶段状态；DNS 按自有记录 ID/type 更新；生产禁隐式 staging；发行产物携带客户端；退避与 0600 权限；**子服务失败必须可观察且不得被报成健康** | `tests/tunnel/*`、`tests/dns/*`、`tests/edge/*` + `tests/edge/frp/*`、`tests/supervisor/lifecycle.test.ts` |
| W4 | N12、N19 | N12 已有 admin 侧先例 | 运维界面区分"已配置"与"已验证"；两类测试入口都进 CI（含 `tests/bun/**` 与 `ui/src/api/network-settings.test.ts`） | 修复 `ui/src/api/network-settings.test.ts` 签名漂移，并纳入默认入口 ✅ 见 10.5 |
| W5 | 验收矩阵 A01–A12 | — | 同一候选 SHA/产物取证；冻结阈值 | 报告第 7 节 |

## 6. 对报告本身的勘误

1. **N11 的环境变量名有误**：报告写作 `XPOD_CERT_PATH`/`KEY_PATH` 与 `XPOD_CERTIFICATE_PATH`/`KEY_PATH`。实际是 store 写 `XPOD_HTTPS_CERT_PATH`/`XPOD_HTTPS_KEY_PATH`，bootstrap 读 `XPOD_ACME_CERTIFICATE_PATH`/`XPOD_ACME_CERTIFICATE_KEY_PATH`（`src/runtime/bootstrap.ts:324-325`）。结论不变，反而更明确：`XPOD_HTTPS_*` 是只写不读的死配置。
2. **N13 的 ngrok 复现细节不严谨**：文本分支正则要求 `https://`（`NgrokTunnelProvider.ts:317-319`），"普通日志 → `endpoint=127.0.0.1:4040`"只能经由 JSON 日志行走通；缺陷本身成立（JSON 分支接受 `http:`，`isNgrokNonTunnelUrl` 只排除 ngrok 自有域名，`:400-404`）。
3. **行号可信度**：报告引用的基线行号我逐条核对无误（`Proxy.ts:162/330`、`AdminHandler.ts:200`、`start.ts:238/284`、`P2PDataPlane.ts:91`、`LocalTunnelProvider.ts:73`、`EdgeNodeDnsCoordinator.ts:40`、`CloudflareDnsProvider.ts:90/229`、vitest 排除表等），可用于直接定位。

## 7. 本次对账未做的事

- 未执行任何测试：报告第 5 节的 227 项定向测试、integration lite/full 均未重跑；
- 未修改产品代码，未提交、未 stash、未清理工作区的 425 个已修改文件与 313 个未跟踪文件；
- 未重跑报告中 R 级隔离诊断脚本（其后续脚本化请求被安全审核拒绝，我按行号复核代码事实替代）；
- 未做真实第三方账号、跨 NAT、真实 Pod 的任何验收；
- 工作区仍在演进，本对账只代表对账时刻的静态状态；工作区再次变化后，第 3 节中标注"与基线一致"的文件需要重新核对。

## 8. N20 处置记录（2026-09-21）

第 4.4 节的现象按四条独立缺陷拆分修复，全部落在同一个工作包内：

| # | 缺陷 | 修复后的契约 | 落点 |
| --- | --- | --- | --- |
| 1 | 放弃重启后对外仍报健康 | `/service/status` 的 `200/503` 由**全部受监督子服务**决定（`Supervisor.isReady()`：每个已配置子服务都必须是 `running`），CSS 网络探测降级为附加条件；同时新增 `given-up` 状态，`lastExitAt`/`consecutiveFailures`/`lastOutput`/`givenUpReason` 随状态一起返回 | `src/runtime/Proxy.ts`、`src/supervisor/{Supervisor,types}.ts` |
| 2 | 固定 2s、无健康度重置的退避 | 退避改为 2s 起指数增长、上限 60s；单次运行存活超过 60s（`healthyUptimeMs`）即清零连续失败计数；显式 `restart()` 重新授予完整重试预算 | `src/supervisor/Supervisor.ts` |
| 3 | 崩溃现场不可取证 | 每个子服务保留最后 20 行输出（`lastOutput`）与最后退出时间；输出在**进入 supervisor 状态的唯一入口**做凭据脱敏，控制台、`/service/logs` 环形缓冲与崩溃尾巴三处口径一致 | `src/supervisor/Supervisor.ts` |
| 4 | 不可恢复失败被当成可重试 | 子进程自身报 `Cannot find package` / `Cannot find module` / `MODULE_NOT_FOUND` 时立即判定为不可恢复，直接 `given-up` 并附原因，不再用 5 次重启掩盖依赖损坏 | `src/supervisor/Supervisor.ts` |

附带修正：`stop()` 会取消处于退避中的待重启定时器（否则一次 stop 会被 2s 后自己排定的重启撤销），`stopAll()` 同样清理；`xpod stop` 接受 `503`，因此半死实例仍然可停。

回归用例：`tests/supervisor/lifecycle.test.ts`（6 例，全部为负向优先：重试耗尽放弃并给出原因、不可恢复失败零重启、健康运行后重置计数、停机取消待重启、崩溃尾巴脱敏、就绪度取自受监督状态），`tests/gateway/service-endpoints.test.ts` 新增 `/service/status` 就绪降级用例（未启动 → 503、running → 200、given-up → 503 且带原因）。验证命令：`bun run build:ts`、`bunx vitest run tests/supervisor/lifecycle.test.ts tests/gateway/service-endpoints.test.ts`。

尚未验证的部分（不得当作已完成）：

- 未在真实运行的实例上复演"api 连续失败 5 次"的全链路（需要人为制造依赖损坏）；N20 的真实验收仍待补 A 级证据；
- 未覆盖 `crashed`（spawn 失败）路径的端到端表现；
- 退避上限 60s 与健康阈值 60s 是估值，未做长时间压测标定。

## 9. W2 处置记录（2026-09-23）

W2 的第一批：**N07 会话并发写**与 **N06 选路校验**。两项都是"客户端信任节点自报数据"的同一类问题，先做它们是因为它们不改变协议，只改变判定位置。

### 9.1 N07 并发会话读改写丢更新

| 层 | 修复 |
| --- | --- |
| 数据库 | `executeStatementWithCount()`（`src/identity/drizzle/db.ts`）取回被 `executeStatement` 丢弃的影响行数；驱动不报行数时按"回读校验"处理，宁可重试也不假设成功 |
| 仓储 | `EdgeNodeRepository.updateNodeMetadataAtomic(nodeId, expected, next)`：`UPDATE … WHERE id = ? AND metadata = ?`（NULL 走 `IS NULL`），返回是否落盘。比较的是序列化后的 payload，因此"等价但键序不同"只会多一次重试，**不会丢写** |
| 服务 | `ReachabilitySessionService.mutateNodeMetadata()`：读 → 变换 → 交换，失败即重读重放（默认 5 次），耗尽抛 `NodeMetadataConflictError`；`createP2PSession`/`addP2PCandidates`/`appendSession` 全部改走该路径，**会话上限校验也在被写入的那份 metadata 上执行**（并发建会话不再超限） |

证据（负向优先）：把服务临时改回旧的读改写语义后，`ReachabilitySessionService.atomic.test.ts` **4/5 失败**，失败信息正是丢更新的症状——`expected [ '10.0.0.2' ] to deeply equal [ '10.0.0.1', '10.0.0.2' ]`（一个客户端的候选被覆盖）、并发探测写 `reachability` 整块消失、冲突未报错、`maxActiveP2PSessionsPerNode: 1` 下并发建会话建出 2 条。恢复修复后 11/11 通过。

### 9.2 N06 选路不校验设备/有效期/身份

`src/edge/reachability/ManagedClientFetch.ts`：

- **任何探测之前**先做本地判定：`expiresAt` 早于当前时间 → 跳过；`expiresAt` 无法解析 → **按不可用处理（fail closed）**；`visibility: 'local-only'` → 跳过（托管客户端按定义在别的机器上，环回地址对它没有意义）。每条被跳过的路由都写进错误串，选择失败时能看出原因，而不是只报"打不开"。
- **探测答案必须证明自己是 Solid 服务**：`/.well-known/solid` 返回 404 或 5xx 一律不算（旧的 `status < 500` 会把同端口的无关服务当成路由）；其余状态还需带身份证据——`Link` 头含 `http://www.w3.org/ns/solid/terms#…` 关系，或真实的 `acl` + `describedby` 组合，或 `x-powered-by: Community Solid Server`。判据取自**在运行实例上实测**的响应（HEAD 返回 405，附上述 Link 头），不是猜测。
- **两条选路共用一套判定**：`src/edge/reachability/RouteValidation.ts`（`routeUnusableReason` / `probeSolidWellKnown` / `isSolidWellKnownResponse`）是唯一实现，`ManagedClientFetch` 与 `ManagedRouteSelector` 都改为消费它——后者原来的默认探测是 `response.ok || 401 || 403`，同样会把无关服务当路由，且完全不看 expiry。

证据（负向优先，两条路径分别验过）：`ManagedClientFetch.test.ts` 新增 6 条负例、`ManagedRouteSelector.test.ts` 新增 3 条负例；把对应源文件临时改回旧实现后，前者 **6/6 失败**（选中过期路由 / 无关服务 / 404 路由），后者 **3/6 失败**（选中过期路由、选中无关服务、把环回路由拨出去）；恢复后分别 10/10、6/6 通过。

同一族的遗留（本轮未动，记为后续）：`src/edge/EdgeNodeCapabilityDetector.ts:486` 仍用 `response.ok || response.status < 500` 判断能力探测结果，属 N12/N06 家族，改动会影响能力上报口径，需与 N12 一起处理。

### 9.3 N17 数据面限额、取消与流式

上限集中在 `P2P_DATA_PLANE_LIMITS`（`P2PDataPlane.ts`）：`maxFrameBytes` 8 MiB、`maxBodyBytes` 4 MiB、`maxConcurrentRequests` 16、`chunkBytes` 256 KiB。超限抛 `P2PDataPlaneLimitError`（带 `limit` 字段，便于上层回 413/429），取消抛 `P2PDataPlaneAbortError`。

| 面 | 修复 |
| --- | --- |
| 帧 | 两端都在"累积到分隔符之前"检查：超过上限即断开连接并回 `limit` 错误——无限长的行无法重新同步，缓冲它就是这条限制要防的事 |
| 请求体 | 客户端在读取之前先看 `content-length`，读后再校验一次；**服务端同样校验**，不信任对端 |
| 响应体 | 上游响应超过上限时返回明确错误，而不是把整个响应读进内存 |
| 并发 | 每条 transport / 每个 socket 分别计数，超出即拒绝（不排队），让背压可见 |
| 取消 | `fetch(url, { signal })` → transport 删除待处理项并向对端发 cancel 信封 → 服务端 abort 上游 fetch；socket 关闭时同样 abort 在途请求 |
| 流式 | 新增 `response-chunk` / `response-end` 信封：head 先回，chunk 逐块回，end 收尾。客户端只在 transport 声明 `supportsStreaming` 时才请求分块（否则仍走整帧路径），旧对端忽略该请求头即回整帧，协议保持向后兼容 |

**实测的流式语义**（`tests/edge/reachability/P2PDataPlaneLimits.test.ts`）：上游 SSE 风格响应推第一块后**不关闭**，客户端已经读到第一块，证明不是"攒完再回"；过程中修掉一个真实缺陷——第一版按 `chunkBytes` 攒够才发，13 字节的事件会一直等到下一块，等于没有流式（改用"每次 read 立即 flush，只在单次读取超过 `chunkBytes` 时切分"）。

### 9.4 本轮未做（W2 剩余）

- **N03**：raw TCP 数据面仍无认证与加密（`TcpP2PDataPlaneTransport` 全文无 tls/crypto/hmac）；当前缓解只有 `XPOD_P2P_ENABLED` 默认关闭。这是 W2 剩下的唯一一项，也是最大的一项。
- 上限是**每连接**而非全局：多个连接可以各自占满 16 个在途请求；也没有字节/秒级限速（速率限制属 N17 之外的新范围）。
- 流式是**增量扩展**而非协商：新客户端 + 旧节点会回退到整帧（已验证路径），但旧客户端 + 新节点不会触发流式；没有协议版本协商字段。
- 未做真实验收：N06/N07/N17 的证据都来自隔离测试（真实 SQLite、真实 TCP socket），没有跨机器/跨 NAT 的并发写与长流演练；`updateNodeMetadataAtomic` 只在 SQLite 上实测过行数路径（PG 同一 SQL 形态，未在 PG 上跑）。

### 9.5 N03 数据面认证加密与身份绑定

| 面 | 修复 |
| --- | --- |
| 密钥 | 每个会话一枚 32 字节密钥，由**创建方**生成，只经认证过的信令 API 传递（`dataPlaneSecret` 进会话记录，随 `listP2PSessions` 回到节点）；API 回显时若被剥离，创建方会发现自己拿不到密钥而不是以为已经加密 |
| 密钥派生 | HKDF-SHA256，盐含双方 nonce，info 含 `sessionId|direction`：同一会话两个方向密钥不同，帧无法跨会话或跨方向重放 |
| 帧 | 全部信封（请求/响应/分块/结束/取消）在握手后都用 AES-256-GCM 封装；AAD 绑定 `sessionId|direction|sequence`，接收端要求序列号**严格递增**，乱序、篡改、跨会话一律拒绝并断开连接 |
| 握手 | 双方各自在连接建立后立即发 `secure-hello`（sessionId + 随机 nonce），收到对方 hello 才派生密钥；握手有超时，超时/连接中断都会让等待方拿到明确错误，而不是永远挂起 |
| 重放守卫 | 进程内记住已消费的客户端 nonce（有界 1024 条）：只重放 hello + 旧帧无法伪装成新连接（序列号本身看不出差别） |
| 策略 | `ReachabilitySessionService` 对声明 `tcp-punch` 能力却不带密钥的会话请求直接拒绝（400），`ReachabilityHandler` 把它映射成 `InvalidP2PSessionRequestError` |
| 兼容性 | 有密钥的一端与无密钥的一端**互相拒绝**（各自的握手/明文检查会断开连接），即 raw TCP 数据面要求两端同版本；该数据面本身仍由 `XPOD_P2P_ENABLED` 默认关闭 |

证据（负向优先）：`tests/edge/reachability/P2PDataPlaneSecurity.test.ts` 11 例——真机抓包代理证明 canonical URL 与请求信封**不出现在明文里**、错误密钥无法建立会话、篡改密文不会送达 handler、明文请求在加密端被丢弃且连接断开、客户端在对方不应答握手时**只发 hello、绝不发明文请求**、重放的 hello nonce 被拒；把封装临时改成直通后 **3/11 失败**（明文 URL 上 wire、错误密钥也能通、篡改帧被投递）。握手期间还修掉两个真实缺陷：解析器没认新信封导致 hello 被丢弃；以及客户端在等待握手时先等后连造成死锁。

集成覆盖：`ManagedClientP2PLocalE2E.test.ts`（4 例，真实 TCP 监听而非中继）在加密后全过；`ManagedClientFetch`/`ManagedClientP2PSmoke`/`TcpP2PSignalingSession` 的手工 socket 夹具改为两端共用固定密钥。

**未做 / 已知边界（如实记录）**：

- **脚本化双进程 smoke 暂时跳过**：`tests/scripts/p2p-dual-smoke.test.ts` 用自建 loopback bridge 中继两个进程，原本按明文时序写；加密后两端一连接就各发 hello，该 bridge 的配对/缓冲逻辑需要按字节重写（节点侧已确认能接受会话、两端密钥一致，但中继后的握手仍不完成）。跳过原因写在该测试里，重新启用前必须先修夹具——这是本轮唯一被跳过的用例。
- 没有**密钥轮换**：密钥与信号会话同生命周期，会话过期即失效；不支持会话内换钥。
- 重放守卫是**进程内**的（每进程 1024 条）：多实例共享同一节点会话时，攻击者必须重放到见过原始 nonce 的进程才会被拒。
- 没有**前向保密**：静态会话密钥 + nonce 派生，泄露会话记录即可解密该会话流量（后续可换 ECDH 临时密钥）。
- 未做真实跨 NAT/跨机验收：本轮证据来自隔离测试与真实 TCP 监听的本机 E2E，不是两台机器。

## 10. W3 处置记录（2026-09-23，进行中）

### 10.1 N14 DNS 记录按 ID/type 更新（已完成）

`src/dns/cloudflare/CloudflareDnsProvider.ts`：

- **一次拉回同名全部记录**（`findRecords`，不再用 `response[0]` 猜），再按类型判断：同类型 → `PATCH` 那条记录的 ID；不同类型 → 先判断是否互斥。
- **只有 CNAME 与其他类型互斥**（RFC 1034）：写 A/AAAA 前删同名 CNAME、写 CNAME 前删同名 A/AAAA，且都是**按记录 ID** 删。MX/TXT（含 `_acme-challenge`）与 A/AAAA 可以共存，一律不动。
- **删除必须带类型**（接口里 `type` 本就是必填）：查询下发 `type=`（有 `value` 时一并下发），并且即使 API 返回了别的类型也拒绝删除（日志告警）。旧实现注释里"以防类型传错"的泛查找正是误删来源。
- 同一名字下多条 TXT（多次 `_acme-challenge` 验证）仍按接口语义删第一条匹配项；带 `value` 时精确匹配。

证据（负向优先）：`tests/dns/CloudflareDnsProvider.test.ts` 新增 8 例——MX/TXT 共存不被删、写 `_acme-challenge` TXT 不动同名 A、CNAME 互斥时按 ID 替换、同类型原地 PATCH、删除只删请求类型、类型不匹配时拒绝删除；把 provider 改回旧实现后 **4/8 失败**。腾讯云 provider 复核：`findRecord` 请求与本地双重按 type 过滤，无同类缺陷（不改）。

### 10.2 N15 生产禁隐式 staging（部分修复）

`src/edge/acme/AcmeCertificateManager.ts`：

- 默认失败切换链改为只含生产 CA（ZeroSSL），**staging 不再隐式加入**；staging 只可能来自操作者显式给出的 `fallbackDirectoryUrls`。
- 链中一旦出现 staging（且主 CA 不是 staging），启动签发前告警；真的用它签下来时再告警一次"客户端不会信任"。
- 全部 CA 失败时错误信息列出**尝试过的每个 CA**（数量 + URL）与最后错误，运维不必猜。

证据：`tests/edge/AcmeCertificateManager.test.ts` 新增 5 例（主 CA 失败时不触碰 staging、整链失败时报出全部 CA、生产切换 CA 成功落盘、显式 staging 链被尊重、主 CA 为 staging 时不引入生产）；对旧实现 **3/5 失败**。

**仍未闭环（下一轮）**：只有按需 `renewCertificate()` 与 `getCertificateStatus()` 的阈值状态，**没有调度器**在 `renewal_due` 时自动续期、没有续期失败的重试/退避、也没有"长期运行跨过阈值"的用例；证书到期告警（管理面/日志之外）未接。

### 10.3 N18 重启退避与密钥文件权限（部分修复）

`src/edge/frp/FrpcProcessManager.ts`：

- **退避**：固定 1 秒改为指数（1s、2s、4s… 上限 60s）；一次运行活过 60s 即视为健康、失败计数清零；状态里暴露 `restartCount` 与 `nextRestartInMs`，崩溃循环不再只能靠日志推断。隧道是兜底路径，到达上限后继续以 60s 重试，不放弃。
- **停止不再被自己排的重启撤销**：`stop()` 取消待重启定时器并清零计数；自动重启路径改用 `stopProcess()`（只结束进程、不碰计数）。
- **被替换进程的退出不再算数**：先清 `this.process` 再 kill，退出回调发现"自己已不是当前进程"就直接返回，既不写状态也不排重启——否则一次配置更新会额外触发一轮重启。
- **配置权限**：frpc 配置含隧道 token，写盘用 `mode: 0o600` 并对已存在的旧文件再 `chmod`（失败只告警）。

`src/edge/acme/AcmeCertificateManager.ts`：账户私钥与证书私钥改为 `writePrivateFile()`（0600 + chmod），读到旧的 0644 私钥时顺手收紧；证书本身是公开材料，保持默认权限。

证据（负向优先）：`tests/edge/frp/FrpcProcessManager.test.ts` 新增 4 例（退避 1s→2s→4s、活够久清零、stop 不被待重启复活、配置文件 0600 且含 token）；`tests/edge/AcmeCertificateManager.test.ts` 新增 1 例（账户私钥与证书私钥 0600）。把两个源文件改回旧实现后 **8 例失败**（含 N15 的 3 例）。

**仍未闭环（下一轮）**：N18 的另一半——**动态选路与运行监督**（`src/api/runtime.ts` 只有日志文件解析，没有 supervisor/健康探测/选路收敛），以及"kill 子进程后断网恢复"的用例；`umask` 非默认（如 000）场景未验（当前显式传 mode，不依赖 umask）。

### 10.4 N16 客户端声明、解析顺序与探测（部分修复）

| 面 | 修复 |
| --- | --- |
| 声明 | `TunnelProviderDescriptor.client` 成为唯一事实来源：可执行名（也是 `binary-missing:<provider>:<binary>` 里的名字）、指定路径的环境变量（`NGROK_BIN`/`CLOUDFLARED_BIN`/`FRPC_BIN`）、安装提示、**许可以及能否随产物分发** |
| 解析 | `src/tunnel/TunnelClientResolver.ts` 统一顺序：显式路径（provider 选项或目录里的环境变量）→ 包内 `vendor/tunnel-clients/<binary>` → 交给 PATH 的裸名字；三家 provider 的默认命令都改为消费该解析器 |
| 失败语义 | 缺失仍报 `binary-missing:<provider>:<binary>`（前缀不变，验收脚本的断言继续有效），后面附上该客户端的安装提示；配置了显式路径但不存在时不静默改用别的二进制（解析器直接报错） |
| 探测 | `scripts/check-tunnel-clients.ts [--require ngrok,cloudflare] [--json]`：逐个 provider 打印来源（显式/打包/PATH）、命中路径或安装提示，并打印"哪些客户端允许随产物分发"的策略句；可用于验收前置检查 |

本机实测（预检脚本真实输出）：`ngrok` 与 `cloudflared` 命中 `/opt/homebrew/bin`，`sakura_frp`/`frp` 的 `frpc` **未安装**（Homebrew 的上游 frpc 不接受 `-f <token>`，与 W1 结论一致），策略句为"允许打包 cloudflared、frpc；ngrok 与 natfrp fork 不随产物分发"。

证据（负向优先）：`tests/tunnel/TunnelClientResolver.test.ts` 9 例（显式路径优先、目录环境变量生效、显式路径不存在时拒绝回退、打包目录优先于 PATH、裸名字回落、缺失提示保留机器可读前缀、许可策略只允许可分发的客户端）+ `NgrokTunnelProvider` 新增 1 例（未给显式选项时按目录环境变量解析）；把解析顺序临时改成"永远用裸名字"后 **5 例失败**。

**仍未闭环（下一轮）**：产物真的携带客户端——需要决定镜像/包的体积与签名策略（cloudflared 约 40MB、frpc 约 14MB），在 `Dockerfile` 与 `scripts/build-platform-package.cjs` 里落地并做一次干净 OS/架构的产物启动验收；ngrok 与 natfrp fork 在拿到许可前只能保持"用户自装 + 预检提示"。

### 10.5 N19 测试入口统一进 CI（已完成）与 N12 诊断面收尾

**N19**：`tests/bun/**` 与 10 个 import `bun:test` 的 UI 测试此前只被 `vitest.config.ts` 排除，没有任何执行入口——所以它们可以一直漂移。现在：

- `scripts/run-bun-tests.ts` 自动收集「`tests/bun/**` 的全部文件」+「`ui/src`、`src` 下任何 import `bun:test` 的文件」，交给 `bun test` 执行；`--list` 可查看清单。`package.json` 新增 `test:bun`，CI 的 unit job 在 vitest 之后加了一步 `bun run test:bun`（两个入口都在 CI 里）。
- **修掉两处真实漂移**（入口一跑就暴露）：`ui/src/api/network-settings.test.ts` 用的是 `authenticatedFetch`，而模块参数早已叫 `fetchImpl`；`AiConfigContext.test.ts` 把模型 ref 硬编码成带前导斜杠的旧形状，而 models 包的 `aiConfigModelRef()` 现在返回相对形式——改成**从 models 包推导期望值**，不再保留第二份定义。
- 入口现在真的会失败：故意放一个失败用例时 `bun run test:bun` 退出码 1；当前 11 文件 / 32 例全过。

**N12（部分）**：设置页诊断此前把「检查函数耗时」放在 `durationMs` 里，语义上容易被当成网络延迟。现在：

- 字段改名 `checkDurationMs` 并在类型注释里写明"这是检查自身耗时，不是网络延迟"，`ui/src/api/network-settings.ts` 与 UI 测试夹具同步。
- 能力状态到诊断级别的映射写成显式白/黑名单：只有 `active/valid/synced/direct/ready` 算 `ok`，`error/invalid/failed/expired/untrusted/mismatch` 算 `error`（**坏证书是失败，不是警告**），其余一律 `warning`——无法归类的状态永远不会变成通过。
- 新增负例：endpoint 指向不存在域名 + 关闭端口、TLS 报 `invalid`、DNS 报 `error`、隧道报 `failed` 时，地址检查仍然只写 `configured:`，TLS/DNS/隧道三项都不得是 ok，整个响应里不出现 `reachable`/`latency`/`round-trip` 字样，且每个检查只有 `checkDurationMs`（没有 `latencyMs`）。

证据（负向优先）：把 handler 改回旧映射与旧字段名后，诊断相关 **2 例失败**（含新增负例）。

**N12 仍未闭环**：`AdminHandler` 侧的 endpoint/public-ip 探针仍只报 `unknown` 而不做真实探测（设计上"配置不等于探测结果"已经做到，但"存在域名/关闭端口/错证书/异网 LAN"这组负例没有真实探针可测）；这属于"要不要真探测"的产品决策，记在下一轮。

### 10.6 N15 续期调度链与 N18 后台服务监督（补完）

**N15（续期链闭环）**：新增 `src/edge/acme/CertificateRenewalScheduler.ts`——与 CA 实现无关的调度器（状态读取 + 续期动作 + 退避），行为是：启动即查一次；`renewal_due`/`missing` → 续期；`valid` → 只更新状态；续期失败按 60s 起指数退避（上限 1 小时），成功即清零；同一时刻只允许一次续期（并发调用共享在飞的那次）；`stop()` 之后不再触发；状态里带 `lastStatus`/`lastCheckedAt`/`lastRenewedAt`/`lastError`/`consecutiveFailures`/`nextCheckInMs`。`AcmeCertificateManager.startAutoRenewal()/stopAutoRenewal()/getRenewalSchedulerStatus()` 把它接到自己身上，`EdgeNodeAgent` 在本地 ACME 签发成功后启动（间隔/退避可用 `renewalCheckIntervalMs` 等覆盖），`agent.stop()` 时收尾。停止后仍保留调度器实例，好让"为什么没续期"这个问题有答案。

**N18（后台服务监督）**：新增 `src/api/background-service-supervisor.ts`——`start()` 失败 → 指数退避重试（5s 起、上限 5 分钟）；起来后按 `checkIntervalMs`（默认 30s）复查 `isRunning()`，返回 false 或抛错都视为已死并立即重启，`restarts` 计数可见；`stop()` 取消待重试定时器（同一类"停掉的会被自己排的重试复活"缺陷）；重复 `start()` 不会叠定时器；定时器 `unref()`，不拖住进程退出。`src/api/runtime.ts` 的 `startBackgroundServices()` 改为用它接管 **DDNS** 与 **隧道 provider**（隧道用 `getStatus().running` 做存活判据），`stopBackgroundServices()` 先停监督器再停其余服务。

证据（负向优先）：调度器 6 例（到期续期、缺证书也算到期、失败退避 100→200→400→上限、并发不重复续期、定时循环与停止、重复 start 不叠定时器）+ 管理面 2 例（自行续期并在停止后停手、重复启动不叠定时器）；把调度循环去掉后 **4 例失败**。监督器 7 例（退避重试至成功、退避封顶、存活复查触发重启、存活检查抛错按已死处理、定时循环与停止、停止后不被待重试复活、重复 start 不叠）；去掉监督循环后 1 例失败。

**本轮明确未做**：会话内已建立路由的中途切换（把正在用的路由换成另一条并保持请求）仍未实现——N06 保证不会选中过期/无关路由并对失败关闭，但"换路"是另一个设计；cluster 模式证书走心跳下发（`ClusterCertificateManager`），不带本地续期调度；N12 的 admin 侧真实探测与 N16 的产物携带客户端仍是待决策项。
