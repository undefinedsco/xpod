# Local Pod 可达性与信令 Spec

## 状态

- 状态：开发前 spec
- 适用范围：Xpod Local / Edge Pod、Desktop / CLI / Native client、Cloud 控制面
- 非适用范围：Matrix / ChatKit / Responses 协议本身、Agent Reconciler 调度策略

## 背景与决策

Xpod Cloud 已经负责分配稳定二级域名，因此“是否有域名”不是主要矛盾。主要矛盾是：**有了稳定域名以后，Local Pod 的数据流量是否默认经过 Cloud**。

本 spec 的结论：

1. Cloud 是控制面：身份、节点注册、域名、证书协作、信令、route discovery、可观测状态。
2. Local / Edge 节点是数据与权限的所有者：Pod 数据、ACL/ACP、私钥、最终鉴权在节点侧。
3. 数据面默认不走 Cloud relay。Cloud relay 只能作为显式、限额、临时或诊断兜底。
4. Desktop / CLI / Native client 是 Local Pod 的主力访问端。Web 浏览器只能使用 public route，或者作为 Cloud 控制台展示状态与配置入口。
5. Solid 语义不随访问路径变化：WebID、Pod Root、ACL/ACP、RDF IRI、OIDC audience 始终使用 canonical HTTPS URL。

换句话说：**Xpod Cloud 分配域名，但不承诺用 Cloud 带宽兜住所有 Local Pod 数据访问。**

## 术语

| 术语 | 含义 |
| --- | --- |
| `canonicalUrl` | Solid 层稳定资源 origin，例如 `https://node-abc.pods.example.com/`。WebID、Pod Root、ACL/ACP、OIDC resource audience 使用它。 |
| `accessRoute` | 客户端实际连接路径，例如 loopback、LAN、公网直连、P2P、第三方 tunnel、relay。 |
| managed client | Xpod Desktop / CLI / Native app，可使用受控 fetch、本地网关、P2P signaling，不等同普通浏览器。 |
| public browser | 未安装本地能力的普通 Web 浏览器，只能访问公网 HTTPS route。 |
| signaling | Cloud 只交换候选地址、节点状态、会话令牌和唤醒信息，不承载 Pod 数据流。 |
| relay | Cloud 或第三方中转实际数据流。Xpod Cloud relay 默认关闭或强限额。 |

## 目标

- 在不破坏 Solid canonical URI 的前提下，为 Local Pod 提供多 route 访问。
- 优先使用低成本数据路径：same-device、LAN、公网 IPv4/IPv6 直连、P2P 打洞。
- Cloud 提供统一信令和 route registry，支撑多客户端发现同一个 Local Pod。
- 明确 Web 浏览器能力边界，避免把“域名已分配”误读为“公网数据面一定可达”。
- 给后续开发提供接口、数据结构、验收标准。

## 非目标

- 不实现普通浏览器对 localhost/LAN/P2P 的透明劫持。
- 不把 Cloud relay 作为默认公网访问方案。
- 不把 `127.0.0.1`、LAN IP 或临时 tunnel 域名写成 WebID / Pod Root。
- 不在 Solid 资源里为不同 route 生成多套 IRI。
- 不把 NAT 打洞宣传成 100% 可用；CGNAT、防火墙、NAT 类型仍可能失败。

## 架构边界

```text
                  ┌────────────────────────────┐
                  │        Xpod Cloud           │
                  │ identity / node registry    │
                  │ domain / DNS / cert assist  │
                  │ route registry / signaling  │
                  │ optional bounded relay      │
                  └──────────────┬─────────────┘
                                 │ control plane only by default
                                 │
┌──────────────────────┐         │         ┌──────────────────────┐
│ Desktop / CLI / App  │◀────────┴────────▶│ Local / Edge Node     │
│ route selection      │  signaling / API  │ Pod data / CSS        │
│ canonical fetch shim │◀═════════════════▶│ ACL / ACP / TLS key   │
│ optional P2P path    │     data plane     │ route heartbeat       │
└──────────────────────┘                   └──────────────────────┘

Public browser:
  - only uses public HTTPS route
  - otherwise shows Cloud console status / install Desktop or CLI / configure tunnel
```

职责划分：

| 组件 | 负责 | 不负责 |
| --- | --- | --- |
| Cloud 控制面 | node 注册、二级域名、DNS-01 协作、route registry、心跳、P2P/relay 会话协调 | 默认承载 Pod 数据流、替节点做资源级 ACL 判定 |
| Local / Edge Node | Pod 数据、CSS 服务、ACL/ACP、证书私钥、route 探测、心跳上报 | 为所有浏览器强行提供公网入口 |
| Desktop / CLI / Native | 获取 route 表、探测、选择 accessRoute、维持 canonical fetch 语义、必要时参与 P2P | 改写 Pod 内 RDF IRI 或权限模型 |
| Web 控制台 | 展示节点状态、引导配置、可在 public route 可用时打开 Pod | 直接使用 loopback/LAN/P2P route |

## Route 优先级

默认 route 选择顺序：

| 优先级 | route kind | 数据是否过 Cloud | 适用客户端 | 说明 |
| --- | --- | --- | --- | --- |
| 10 | `loopback` | 否 | same-device managed client | 同机 Desktop / CLI 首选。 |
| 20 | `lan` | 否 | LAN managed client | 局域网内访问。 |
| 30 | `public-direct` | 否 | browser / managed client | 公网 IPv4/IPv6 直连，DNS 指向节点。 |
| 40 | `p2p` | 否 | managed client | 通过 Cloud 信令交换候选，成功后直连。 |
| 50 | `user-tunnel` | 取决于 provider | browser / managed client | 用户自备 Cloudflare Tunnel、FRP、Tailscale Funnel 等。 |
| 90 | `xpod-relay` | 是 | browser / managed client | 显式开启、限额、TTL、诊断或临时兜底。 |

选择规则：

- managed client 可并发探测多个候选，采用最先健康且优先级最高的 route。
- public browser 只接收 `requiresManagedClient=false` 的公网 HTTPS route。
- `xpod-relay` 不自动兜底；必须有用户或策略显式授权，且带配额/TTL。
- route 变化不触发 WebID、Pod Root、ACL 或 RDF IRI 迁移。

## Route 数据结构

Cloud route registry 和本地 route 表使用同一抽象：

```ts
export type AccessRouteKind =
  | 'loopback'
  | 'lan'
  | 'public-direct'
  | 'p2p'
  | 'user-tunnel'
  | 'xpod-relay';

export interface AccessRoute {
  id: string;
  nodeId: string;
  canonicalUrl: string;
  kind: AccessRouteKind;
  targetUrl: string;
  priority: number;
  requiresManagedClient: boolean;
  visibility: 'local-only' | 'same-account' | 'authorized-client' | 'public';
  health: 'unknown' | 'healthy' | 'degraded' | 'unreachable';
  lastCheckedAt?: string;
  expiresAt?: string;
  metadata?: Record<string, unknown>;
}

export interface RouteSet {
  nodeId: string;
  canonicalUrl: string;
  generatedAt: string;
  routes: AccessRoute[];
}
```

约束：

- `canonicalUrl` 是 Solid 资源身份，不随 `targetUrl` 改变。
- `targetUrl` 是 transport endpoint，不写入 Pod durable RDF。
- `loopback` / `lan` 默认 `visibility=local-only` 或 `authorized-client`，不得进入公开 discovery。
- 外部 provider 的 opaque id 放入 `metadata.protocols.<provider>`，不升级成共享模型字段，除非需要跨系统查询或审计。

## Cloud API 草案

### 节点心跳：已有方向

```http
POST /v1/signal/heartbeat
Authorization: Bearer <nodeToken>
Content-Type: application/json
```

payload 继续承载：

- `nodeId`
- `ipv4` / `ipv6`
- `directCandidates`
- `reachability`
- `tunnel`
- `certificate`
- `metrics`
- `metadata.dns`

要求：

- Node 只能上报自己的候选 route 和健康状态。
- Cloud 可以探测并修正健康状态，但不能把私网 route 发布给未授权客户端。
- DNS 编排只针对 `public-direct` 或明确启用的 tunnel/relay route。

### Route 获取：新增

```http
GET /v1/nodes/{nodeId}/routes
Authorization: Bearer <clientToken>
```

返回：

```json
{
  "nodeId": "node_abc",
  "canonicalUrl": "https://node-abc.pods.example.com/",
  "generatedAt": "2026-06-19T00:00:00Z",
  "routes": []
}
```

服务端按调用者身份过滤：

- public browser / 未授权：最多返回 public route 或状态页所需摘要。
- 同账号 managed client：可返回 LAN、P2P、user tunnel、relay 候选。
- same-device route 通常由本地发现提供，不依赖 Cloud 返回。

### P2P 会话：新增

```http
POST /v1/nodes/{nodeId}/p2p-sessions
Authorization: Bearer <clientToken>
Content-Type: application/json

{
  "clientId": "device_123",
  "capabilities": ["tcp-punch", "udp-hole-punch"],
  "candidates": []
}
```

返回：

```json
{
  "sessionId": "p2p_...",
  "expiresAt": "2026-06-19T00:05:00Z",
  "nodeCandidates": [],
  "signalingUrl": "https://api.example.com/v1/p2p-sessions/p2p_..."
}
```

要求：

- Cloud 只做候选交换和会话鉴权，不承载 Pod HTTP body。
- 会话必须短 TTL，可撤销，可审计。
- 失败后回落到下一候选 route，不阻塞本地可用性。

### Relay 会话：新增但默认关闭

```http
POST /v1/nodes/{nodeId}/relay-sessions
Authorization: Bearer <clientToken>
```

必须满足至少一个条件：

- 用户显式启用临时远程访问；
- 诊断/运维授权；
- 套餐或策略允许的低频限额场景。

返回必须包含：

- `expiresAt`
- `bandwidthLimitBytes` 或 `bandwidthLimitBps`
- `reason`
- `auditId`

## Solid 兼容规则

1. **canonical URL 不变**
   `https://node-abc.pods.example.com/alice/profile/card#me` 仍是 WebID；不能因为同机访问就变成 `http://127.0.0.1:5737/...`。

2. **上层 SDK 看到 canonical URL**
   Desktop / CLI 可通过受控 `fetch`、本地网关或 undici dispatcher 把请求送到 `targetUrl`，但业务层和 Solid SDK 的 resource URL 仍是 canonical。

3. **鉴权以 canonical origin 判定**
   DPoP、OIDC audience、ACL/ACP、CORS、resource identifier 都按 canonical resource origin 处理。`allowedHosts` 只是服务端接受 Host 的安全名单，不替代授权语义。

4. **Pod durable 数据不写 route endpoint**
   route endpoint 属于运行时/控制面状态。Pod 内可以记录用户授权的节点关系或配置，但 RDF 资源 IRI 不因 route 切换而改写。

5. **浏览器路径必须真实 HTTPS 可达**
   普通浏览器不能假装使用 `https://canonical`，实际透明连 `http://localhost`。如果没有公网 HTTPS route，浏览器只能展示引导或控制台。

## 安全与成本约束

- Cloud relay 必须默认关闭或强限额；不能把它作为 Local Pod 标准数据路径。
- 公开 discovery 不暴露 `127.0.0.1`、RFC1918 LAN IP、节点内网端口。
- 私网 route 只对同账号、已授权、具备 managed-client 能力的设备返回。
- 节点证书私钥留在节点；Cloud 只做 DNS-01 TXT 协作或证书链传递。
- P2P/relay session 都必须有短 TTL、审计日志、撤销能力。
- 失败路径要可诊断：明确是无公网 route、P2P 失败、provider tunnel 未配置，还是 relay 未授权。

## 与现有实现映射

当前已有基础：

- `EdgeNodeSignalClient`：可发送 `ipv4`、`ipv6`、`directCandidates`、`reachability`、`tunnel`、`certificate`、`metrics`、`metadata`。
- `EdgeNodeSignalHandler`：接收心跳、鉴权、落库 metadata，并触发健康探测 / DNS 协调。
- `LocalNetworkManager`：处理公网 IP 检测与 DNS 更新；没有公网时保持本机/LAN route 可用。
- `EdgeNodeCapabilityDetector`：探测本地 IPv4/IPv6、公网 IPv4/IPv6 和 IPv6 可达性。
- `EdgeNodeAgent`：周期性上报节点状态，可消费心跳响应中的 tunnel 配置。

缺口：

1. 统一 `RouteSet` DTO 和持久化位置。
2. `GET /v1/nodes/{nodeId}/routes` 查询与权限过滤。
3. Desktop / CLI route selector 和 canonical fetch adapter。
4. P2P signaling session API 与 native client 实现。
5. `xpod-relay` 的显式授权、限额、TTL 和审计。
6. UI 状态页：区分 canonical domain、public route、managed-client route、relay fallback。

## 开发阶段

### P0：文档与模型收敛

- 本 spec 成为 Local Pod 可达性设计入口。
- `multi-channel-access.md`、`domain-tunnel-roadmap.md`、`edge-node-control-plane.md` 只保留与本 spec 不冲突的细节。
- 明确 Cloud-managed domain 不等于 Cloud data relay。

### P1：Route registry

- 定义 `RouteSet` DTO。
- 心跳写入 route candidates。
- 新增 route 查询 API，按客户端能力和权限过滤。
- Web 控制台展示 route 状态。

### P2：Managed client route selection

- Desktop / CLI 读取本地 route 和 Cloud route。
- 并发探测 loopback/LAN/public-direct/user-tunnel。
- 对 Solid SDK 暴露 canonical fetch。

### P3：P2P signaling

- 新增 P2P session API。
- Native client 和节点交换 candidates。
- 成功后作为 `p2p` route 加入 route set，失败则回落。

### P4：受控 relay fallback

- 新增 relay session API。
- 强制 TTL、带宽限额、审计、用户显式授权。
- UI 标记“流量经过 Xpod Cloud”。

## 验收标准

- Cloud-managed Local 节点注册后拿到稳定 `canonicalUrl`，但未必有 public route。
- Desktop / CLI 在无公网 route 时仍可通过 loopback 或 LAN 使用同一个 canonical URL 的 Pod。
- 普通浏览器在无 public route 时不假装可用，展示安装 managed client / 配置 tunnel / 开启临时 relay 的指引。
- Route 表中私网地址不进入公开 discovery。
- P2P 或 relay 失败不会迁移 WebID、Pod Root 或 RDF IRI。
- Cloud relay 使用前必须能看到 TTL、限额和审计原因。
- 所有请求的资源身份和授权判定仍以 canonical HTTPS URL 为准。
