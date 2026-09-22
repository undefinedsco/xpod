# 联网审查 W0 交付说明（授权与节点边界）

- 基线：`release/0.4.11`（起点 `69cccc87`，提交前 rebase 到该分支当时的尖端 `398e763e`）
- 分支：`codex/network-audit-w0`；合并：`d0e1c76e` 以 fast-forward 进入 `release/0.4.11`（未推送）
- 审查报告：[`network-audit-2026-09-19.md`](/Users/ganlu/.codex/worktrees/external-network/xpod/docs/network-audit-2026-09-19.md)（报告与证据索引位于 codex worktree，未纳入本仓库）
- 基线对账：[`network-audit-2026-09-19-reconciliation.md`](/Users/ganlu/develop/xpod/docs/network-audit-2026-09-19-reconciliation.md)
- 范围：报告 W0 工作包 —— N01、N02、N04、N05（P0 与本期发布阻断项）。W1–W5 未在本轮处理。

## 1. 逐项修复

### N01 · 远端通道被误判为本机管理员

**根因**：Gateway 用「对端 socket 地址是回环」当作「本机用户」，而受管隧道（cloudflared/ngrok/Sakura）与 P2P 数据面都从本机发起连接，因此经它们到达的请求天然满足该条件，管理接口随即放行。

**修复**：新增**专用不可信入口监听**（loopback-only 的独立端口），所有远端转发路径都指向它；经该监听到达的请求不再是「本机」，与对端地址、`Host`、`X-Forwarded-*`、伪造内部标记无关。

- `src/runtime/Proxy.ts`：新增 `ingressPort` 选项与第二个监听器，`originalClientLoopback = !untrustedIngress && isLoopbackRemoteAddress(...)`。
- 端口来源：`RuntimePorts.ingress`（`src/runtime/host/*` 分配，默认 `DEFAULT_TUNNEL_ORIGIN_PORT = 5737`、占用自动顺延；`src/runtime/bootstrap.ts` 导出为 `XPOD_GATEWAY_INGRESS_PORT`，`/api/network/settings/status.ingress` 显示给用户）。
- 隧道 origin：`resolveTunnelIngressPort()`（`src/api/runtime.ts`）优先取入口端口，`buildApiChildEnv` 注入。
- P2P 转发：`resolveManagedEdgeAgentConfig(..., ingressPort)` 让转发目标落到入口监听；LAN 广播地址仍是 Gateway 主监听（`EdgeNodeAgent.p2p.lanBaseUrl`），避免把 loopback-only 端口广播给局域网。
- 入口 `src/cli/commands/start.ts`、`src/main.ts`、`src/runtime/lifecycle.ts`（桌面/嵌入式运行时）三处均已接线。

**回归**：`tests/gateway/admin-proxy-auth.test.ts` 新增三条 —— 回环对端经入口监听仍 403、伪造内部标记/forwarded/Host 无效、普通业务流量在入口监听上仍按远端处理（401 而非放行）。

### N02 · 节点心跳可影响其他节点 DNS

**根因**：心跳把节点上报的 `metadata` 整块合并，DB 绑定只在字段缺省时回填，DNS coordinator 随后信任 `metadata.subdomain`。

**修复**：subdomain 权威来源收敛到控制面。

- `src/api/handlers/EdgeNodeSignalHandler.ts`：合并后**删除**节点上报的 `subdomain`（含 `metadata.dns.subdomain` 旧提示），只用 `getNodeConnectivityInfo()` 的绑定回填；并显式把该绑定传给 coordinator。
- `src/edge/EdgeNodeDnsCoordinator.ts`：`synchronize(nodeId, metadata, binding?)` 新增权威绑定参数；提供 binding 时**只**认它，未绑定（`subdomain` 为空）即跳过同步，绝不回退到节点上报值。`LocalNetworkManager` 等本地自有 subdomain 的调用方保持原语义。

**回归**：`tests/api/handlers/EdgeNodeSignalHandler.test.ts` 增「上报 bob 不能覆盖绑定 alice」「无绑定时丢弃上报值」；`tests/edge/EdgeNodeDnsCoordinator.test.ts` 增「binding 覆盖 metadata」「无绑定即跳过 upsert/delete」。

### N04 · 创建信令会话没有验证目标节点访问权

**根因**：任何已登录的 Solid principal 都能给任意节点建信令会话，service principal 不校验 scope；session owner 只记录创建者。

**修复**：按访问面分层授权。

- 新增 `src/edge/reachability/NodeAccessResolver.ts`：`createPodOwnershipNodeAccessResolver()` 通过 Pod 归属（`PodLookupRepository.listAllPods()` 的 `webId/webIds` 与 `nodeId/edgeNodeId`）判定 WebID 与节点的关系；缺依赖或查询失败一律返回「无权限」（fail closed）。
- `src/api/handlers/ReachabilityHandler.ts`：`resolveSessionAccess(..., target)` —— **节点级**操作（建会话、列会话）要求 Solid principal 有可解析的节点关系；service principal 必须带 `network:write`；**会话级**操作（读/追加本人会话）仍由 session ownership 把关，避免因归属数据缺失而拒绝本人会话。
- `src/api/container/routes.ts`：用 `podLookupRepo` 装配该 resolver。

**回归**：`tests/api/handlers/ReachabilityHandler.test.ts` 增「未授权 WebID 403」「无 resolver 时 fail closed」「service 缺 `network:write` 403 / 具备则 201」；新增 `tests/edge/reachability/NodeAccessResolver.test.ts`（归属命中、别名、失败关闭）。

### N05 · Cloud 健康探测缺目标网络边界

**根因**：探测目标来自节点 metadata，直接 `fetch`，没有私网/回环/link-local/元数据地址限制，也不校验重定向。

**修复**：新增 `src/edge/ProbeTargetGuard.ts`。

- `isPublicIpAddress()`：IPv4/IPv6 阻断表（私网、回环、CGNAT、link-local、ULA、多播、保留段、文档段、IPv4-mapped 归一化）。实现上 IPv4/IPv6 分表，因为混合 BlockList 会让 `check(ipv4)` 命中 IPv6 规则。
- `assertPublicProbeTarget()`：解析**全部**地址并要求都为公网，混入私网记录即拒绝；不可解析、非 http(s) 亦拒绝。
- `createPinnedHeadProbeRequest()`：用 `node:http(s)` 发起 HEAD 并把连接**钉在已校验的地址**上，杜绝校验后再解析（DNS rebinding）的窗口。
- `EdgeNodeHealthProbeService`：探测前先过策略（远端 probe location 同样不再收到私网目标），直连探测逐跳手动跟随重定向并**每一跳重新校验**（上限 `maxRedirects`，默认 3）。

**回归**：新增 `tests/edge/ProbeTargetGuard.test.ts`（地址段、字面量私网/元数据拒绝且不解析、混合解析拒绝、钉地址连接、非 http 拒绝）；`tests/edge/EdgeNodeHealthProbeService.test.ts` 增「私网/回环/元数据候选零请求」「不给远端 location 传私网目标」「重定向进私网被拒」「公网重定向可跟随」。

## 2. 顺带修复（同域、非报告条目）

1. **修复 0.4.11 上一条陈旧发布门禁**：`tests/runtime/XpodRuntime.integration.test.ts` 仍断言「外部客户端读 `/api/admin/status` 得到 200 + capabilities=false」，而 0.4.11 已把管理读接口收紧为需管理员权限，该测试在**干净 0.4.11 上就失败**（已用 stash 对照确认）。现改为断言 403 且不返回 capability 清单。
2. **测试夹具 scope 词汇对齐**：`src/test-utils/local-managed-client-p2p-e2e-smoke.ts`、`scripts/docker-p2p-signal-fixture.ts` 使用生产不存在的 `reachability:read|write`，改为生产的 `network:read|write`（否则在 N04 的 scope 校验下会被拒）。
3. **组件生成白名单**：`config/components-ignore.json` 加入 4 个新增纯函数导出，`bun run build:components` 保持通过。
4. **入口端口改为 OS 分配（本轮自审发现的自身回归）**：第一版把入口端口实现为「`api + 1` 起找空闲端口」。完整集成 harness 的端口规划是 `css = gateway + 10`、`api = gateway + 11`，于是本 runtime 的 `api + 1` 正是**另一个 runtime 计划中的 CSS 端口**；local runtime 先绑定它后，standalone 的 CSS 绑不上该端口，其 `/.account/` 请求被 local runtime 的入口监听接走，账号落到 local 的 canonical 域，两个 standalone 用例失败（`canWrite: false`、`ENOTFOUND local-managed-node.undefineds.site`）。现改为 `getEphemeralLoopbackPort()`（bind `127.0.0.1:0` 取 OS 分配端口），并在 `tests/runtime/NodeRuntimeHost.test.ts` 增回归：分配并绑定入口监听后，另一 runtime 计划中的端口仍须可绑定。
   —— 定向 418 项测试当时全绿，只有完整集成暴露了它；这是完整集成门禁必须保留的直接证据。

## 3. 测试与证据

| 检查 | 命令 | 结果 |
| --- | --- | --- |
| 类型检查 | `bun run build:ts` | 退出 0 |
| 工作区包构建 | `bun run build:packages` | 退出 0 |
| Components.js 生成 | `bun run build:components` | 退出 0 |
| 联网定向回归 | `./scripts/run-vitest-safe.sh --run tests/tunnel tests/edge tests/dns tests/subdomain tests/api/handlers/{Reachability,NetworkSettings,EdgeNodeSignal,Ddns,AdminDdns}Handler.test.ts tests/api/ai-config/NetworkEnvironmentConfigurationStore.test.ts tests/api/container/local.test.ts tests/api/runtime.test.ts tests/gateway/admin-proxy-auth.test.ts tests/runtime` | 62 文件 / **419 通过 / 0 失败** |
| 完整集成 | `XPOD_FULL_PROJECT=xpod-w0-network-audit bun run test:integration` | 退出 0；lite **151 通过 / 6 跳过**（29 文件通过、3 跳过），full **45 通过**（4 文件）；基础设施已清理 |
| 合并门禁复跑 | rebase 到 `398e763e` 后重跑定向 419 项 + 完整集成（`XPOD_FULL_PROJECT=xpod-w0-merge-gate`） | 同上，均通过；合并因此未被 rebase 影响 |

新增负向回归清单（均先在修复前失败或以当前实现无法通过为前提编写）：

- `tests/gateway/admin-proxy-auth.test.ts`：入口监听三条。
- `tests/api/handlers/EdgeNodeSignalHandler.test.ts`：跨节点 subdomain 两条。
- `tests/edge/EdgeNodeDnsCoordinator.test.ts`：权威绑定两条。
- `tests/api/handlers/ReachabilityHandler.test.ts`：未授权 WebID / fail closed / scope 三条。
- `tests/edge/reachability/NodeAccessResolver.test.ts`：归属解析四条。
- `tests/edge/ProbeTargetGuard.test.ts`：目标策略七条。
- `tests/edge/EdgeNodeHealthProbeService.test.ts`：探测边界四条。

## 4. 配置与兼容

- **不新增用户必填配置**：入口端口有一个文档化默认值 `5737`（`DEFAULT_TUNNEL_ORIGIN_PORT`），被占用时自动顺延到下一个空闲端口，并记录在运行时状态目录（`.xpod/runtime/ingress-port`）与 `XPOD_GATEWAY_INGRESS_PORT`，同时在网络设置页显示为隧道回源地址——用户只需读取这一个数字填进 provider 控制台，不需要理解 CSS/API/main 端口之间的关系。
- **行为变化（有意）**：
  - 隧道/P2P 转发改走入口监听；经隧道访问管理接口不再获得本机权限（原来会）。
  - 管理接口在 0.4.11 已收紧为 loopback 或 `XPOD_ADMIN_TOKEN`；本轮不再改变其判定，但**非本机浏览器访问设置页所用的管理读接口会得到 403**（见对账文档 4.1，W4 需决定显式认证入口）。
  - P2P/信令：Solid principal 需具备节点归属；service principal 需 `network:write`。
  - 探测：候选地址为私网/回环/元数据的节点将得到 `blocked-target:*`，不再参与可达性判定。
- **显式覆盖的残余风险**：若部署显式设置 `XPOD_P2P_TARGET_BASE_URL` 指向 Gateway 主端口，等于自行绕过入口监听；默认派生值不会。

## 5. 未覆盖边界（下一轮）

- **未做真实验收**：三家隧道真实账号、跨 NAT 双真机、真实 Pod/账号读写均未执行；本轮的替换物是隔离测试（内存/临时端口/注入边界），不构成上线验收。
- **W0 之外的发现未处理**：N03（raw TCP 无认证加密）、N06（选路不校验设备/有效期/身份）、N07（会话读改写丢更新）、N08–N11、N13–N19。
- **N01 的形态选择**：入口监听绑定 loopback，LAN 广播仍用主监听；若未来要求入口监听也对外提供服务，需要额外论证。
- **N02 的保留项**：本轮覆盖 A/B 跨节点与「无绑定即跳过」；**根域、保留名（如 `www`、`api`）与 provider 维度的记录归属证明未做**。另外 DNS 记录的 `type/target` 仍由节点上报（IP/隧道入口由节点自行决定），本轮只收紧了 subdomain 归属；记录级归属校验与 Cloudflare 误删无关记录（N14）同属一类，留到 W3。
- **N04 的保留项**：归属判定目前只支持 **Pod 归属**；「显式共享授权」尚无数据模型，撤销设备（device revocation）也没有建模，因此 `canAccessNode` 只表达"Pod 属于该 WebID 且 Pod 在该节点上"。
- **N05 的对抗性验证**：钉地址连接有单测证明（Host 指向 `edge.example`、连接落在被钉的 `127.0.0.1`），但没有用「先答公网、再答私网」的对抗性 DNS 服务器做过端到端重绑定演练。
- **N05 的 provider 侧**：远端 probe location 的目标策略由被注入的 `headRequest`/worker 决定，本轮只保证 Cloud 不再把私网目标发出去。
- **性能与长期运行**：未测连接数、探测频率对 Cloud 的影响；会话清理与限额属 N07/N17。
