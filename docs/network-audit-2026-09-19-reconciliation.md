# 《Xpod 联网模块审查报告》基线对账（2026-09-19）

- 对账对象：[`network-audit-2026-09-19.md`](/Users/ganlu/.codex/worktrees/external-network/xpod/docs/network-audit-2026-09-19.md)（报告与脱敏证据索引位于 codex worktree，未纳入主仓库）
- 审查基线：`92fc7d5bf7f158096fb1e259053e1f8229f144d3`
- 被对账代码：`/Users/ganlu/develop/xpod`（`release/0.4.5`，HEAD 同为 `92fc7d5b`，**工作区未提交改动 425 文件、未跟踪 313 文件**）
- 对账方式：**静态源码对账**，未执行测试、未修改任何产品代码、未提交或 stash 工作区改动

## 0. 结论摘要

| 判定 | 数量 | 项 |
| --- | --- | --- |
| 已修复 | 0 | — |
| 部分缓解 | 3 | N01（仅读接口直连面）、N09（仅 UI 层）、N12（仅 admin public-ip） |
| 仍存在 | 16 | N02、N03、N04、N05、N06、N07、N08、N10、N11、N13、N14、N15、N16、N17、N18、N19 |
| 仍存在（对账后新增） | 1 | N20（真实验收发现，见 4.4） |

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
| N03 raw TCP P2P 无认证加密 | P1 | **仍存在** | `src/edge/reachability/TcpP2PDataPlaneTransport.ts` 全文 `tls/crypto/auth/hmac/handshake` **零命中**；`src/cli/commands/start.ts:238` 在 managed edge 下硬编码 `p2p.enabled = true`，即注册到 Cloud 的节点默认启用该数据面 | `tests/edge/reachability/TcpP2PDataPlaneTransport.test.ts` 只覆盖现有（无加密）行为 |
| N04 建会话不校验节点访问权 | P1 | **仍存在** | `src/api/handlers/ReachabilityHandler.ts:285` 起：solid/service principal 一律 `allowed: true`，无节点归属与 scope 校验 | 报告已指出的"session owner 只证明创建者"未变 |
| N05 Cloud 健康探测缺网络边界 | P1 | **仍存在** | `src/edge/EdgeNodeHealthProbeService.ts:79-94` `collectCandidates` 只做字符串/去空判断就接受节点上报的 `directCandidates`/tunnel entrypoint/`baseUrl`，全文件无 `169.254`/loopback/link-local/redirect/DNS 重解析守卫（精确 grep 零命中）；`src/api/container/cloud.ts:137` 默认注册探测服务 | `tests/edge/EdgeNodeHealthProbeService.test.ts` **只有 1 个正例**（多位置探测并写样本） |
| N06 选路不校验设备/有效期/身份 | P1 | **仍存在** | `src/edge/reachability/ManagedClientFetch.ts:105` `candidateRoutes` 只按 `health`+`priority` 过滤；`:137` 探测判定为 `response.status < 500`（404 视为通过） | 需补"两设备同端口/无关服务返回 200/404/过期路径"负例 |
| N07 并发会话读改写丢更新 | P1 | **仍存在** | `src/edge/reachability/ReachabilitySessionService.ts:257-269` 是 `getNodeMetadata` → `mergeNodeMetadata` 的读改写；`src/identity/drizzle/EdgeNodeRepository.ts:146-158` 整列写 `metadata`。工作区对该仓库文件的改动只涉及时间戳与 JSON 解析辅助，**合并语义未变** | 无 `ReachabilitySessionService` 并发/限额回归 |
| N08 关闭/删除后隧道被复活 | P1 | **仍存在** | `src/tunnel/TunnelProfiles.ts:176-192` 回退顺序：显式 ID → legacy provider → 首个可用 profile；`ui/src/pages/settings/NetworkPage.tsx:368` 空值即 None。该文件与基线逐字一致 | ⚠️ `tests/tunnel/TunnelProfiles.test.ts:90`「keeps legacy auto priority when only old provider env values exist」把现有回退行为**断言为预期**，修 N08 必须同步改这条测试 |
| N09 profile 字段/provider 列表跨层不一致 | P1 | **部分缓解** | UI 侧已收敛为单表 `ui/src/utils/tunnel-providers.ts`（含 `sakura_frp`/`frp`，附 `ui/src/utils/tunnel-providers.test.ts`），三处 UI 分支消除；但 API store 仍只认三家（`src/api/network/NetworkEnvironmentConfigurationStore.ts:93`）、runtime 认四家（`src/tunnel/TunnelProfiles.ts:1`）、`NetworkPage.tsx:372` 下拉仅三家 → 跨层契约仍不一致 | `tests/api/ai-config/NetworkEnvironmentConfigurationStore.test.ts` 仍只测 envPatch，无"UI shape → API parser → store → runtime"合同测试 |
| N10 多 profile 凭据按 provider 全局覆盖 | P1 | **仍存在** | `src/api/network/NetworkEnvironmentConfigurationStore.ts:79` 在循环里写 provider 级全局 key（后写覆盖前写）；`src/api/container/index.ts`、`local.ts` 未变 | 无 A/B 切换精确对应各自账号的用例 |
| N11 DNS/HTTPS/P2P 控件未控制真实运行 | P1 | **仍存在** | store 写 `XPOD_HTTPS_CERT_PATH`/`XPOD_HTTPS_KEY_PATH`（`:65-66`），而 `src/runtime/bootstrap.ts:324-325` 实际读 `XPOD_ACME_CERTIFICATE_PATH`/`XPOD_ACME_CERTIFICATE_KEY_PATH`；`XPOD_HTTPS_*` **全仓只写不读**（仅 store 与 AdminHandler 白名单引用）。DNS/P2P 控件映射问题同基线 | 每个控件缺"保存→应用/重启→行为变化与关闭"用例 |
| N12 诊断把"有 URL"当"可达/延迟" | P1 | **部分缓解** | `AdminHandler.ts:411` 新增 `describeUnservedPublicRoute`，并在 `:794` 把 public-ip 从 `pass` 改为 `unknown`（不再仅凭地址断言可达）；但 `src/api/handlers/NetworkSettingsHandler.ts:423/468` 与 `NetworkPage.tsx:491` 未变，仍是"endpoint check 无探测 + 函数耗时当延迟 + 同一结果映射多条地址" | 无"不存在域名/关闭端口/错证书/异网 LAN 不得显示 Reachable"负例 |
| N13 provider 就绪误报及错误目标 | P1 | **仍存在** | ngrok `src/tunnel/NgrokTunnelProvider.ts:197/301-315/381-404`；Cloudflare `LocalTunnelProvider.ts:159/331`；Sakura `SakuraFrpTunnelProvider.ts:93/163`（`login to server success` 即 connected、任意 frpc 即接管）三处均与基线一致 | 无错 token/退出/超时/端口冲突/多隧道/无关 frpc 的负例 |
| N14 Cloudflare DNS 误删可并存记录 | P1 | **仍存在** | `src/dns/cloudflare/CloudflareDnsProvider.ts:90-100` 类型不同即 DELETE；`findRecord`（`:229-251`）不带 type 时返回 `response[0]` | `tests/dns/CloudflareDnsProvider.test.ts` 全部为 A 记录用例，**无 MX/TXT 共存负例** |
| N15 生产证书失败回退 staging、续期链不完整 | P1 | **仍存在** | `src/edge/acme/AcmeCertificateManager.ts:102` 默认 fallback 列表含 `letsencrypt.staging`；`:255-265` 失败即换下一个 CA，无"生产禁止隐式 staging"约束 | 无 CA 失败/续期阈值/长期运行用例 |
| N16 发布产物不含隧道客户端 | P1（若承诺免安装） | **仍存在** | `Dockerfile`、`scripts/build-platform-package.cjs` 对 `cloudflared`/`ngrok`/`frpc` **零命中**；Dockerfile 的工作区改动仅 bun 版本与构建顺序 | 无干净 OS/架构的产物启动验收 |
| N17 数据面资源上限、流式与取消缺口 | P1（若启用公网 P2P） | **仍存在** | `TcpP2PDataPlaneTransport.ts` 无帧/请求体/并发上限（仅 `DEFAULT_MAX_CLOCK_ERROR_SECONDS` 常量）；`P2PDataPlane.ts:103` 仍全量读取 | 无超额拒绝、SSE 首字节、取消释放用例 |
| N18 恢复监督、动态选路与文件权限 | P2 | **仍存在** | `src/api/runtime.ts` 无 supervisor/重启退避相关引用（工作区改动仅日志文件解析）；`FrpcProcessManager.ts`、`AcmeCertificateManager.ts` 无 `chmod`/`mode`/`0o600` | 无 kill 子进程/断网恢复/umask022 用例 |
| N19 测试入口与合同覆盖漂移 | P2 | **仍存在（并新增一例）** | `vitest.config.ts` 排除表仍含 `ui/src/api/network-settings.test.ts`（该测试与 `ui/src/api/network-settings.ts` 均未更新），且**新增** `tests/bun/**` 排除；CI（`.github/workflows/ci.yml:45`）只跑 `bun run test:run`，`package.json` 无执行 `tests/bun/**` 的脚本 | 见 4.3：新测试文件当前**没有任何执行入口** |
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
| W4 | N12、N19 | N12 已有 admin 侧先例 | 运维界面区分"已配置"与"已验证"；两类测试入口都进 CI（含 `tests/bun/**` 与 `ui/src/api/network-settings.test.ts`） | 修复 `ui/src/api/network-settings.test.ts` 签名漂移，并纳入默认入口 |
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
