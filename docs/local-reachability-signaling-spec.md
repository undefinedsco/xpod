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

## 非浏览器 P2P 数据面协议

P2P 数据面的目标不是把 Solid 改成另一套协议。Solid client、Inrupt SDK、
drizzle-solid、CSS handler 看到的仍然是 HTTP(S) request/response：

```text
Solid SDK / app
  -> fetch("https://node-abc.pods.example.com/alice/a.txt")
  -> canonical HTTP request frame
  -> P2P transport stream
  -> Local node forwards to local CSS HTTP endpoint
  -> canonical HTTP response frame
```

因此协议分两层：

1. **语义层：HTTP**
   - 请求方法、URL、headers、body、status、response headers、response body
     必须完整保留。
   - WebID、Pod root、ACL/ACP、DPoP/OIDC audience 仍按 canonical HTTPS URL 判断。
   - 当前内部帧版本命名为 `xpod-p2p-http/1`，用于把 HTTP request/response
     编码到任意 P2P stream 上；它不是新的 Solid 协议。

2. **传输层：可插拔 P2P provider**
   - 推荐最终以 QUIC stream 承载 HTTP frame：QUIC 原生支持加密、多路复用和流控，
     和 HTTP/3 的语义边界一致。
   - NAT 穿透/候选交换由 signaling 协调，具体 provider 可以是 QUIC+ICE、
     TCP punch、WebRTC DataChannel 或 libp2p。provider 不进入 URL 形状和 Pod 模型。
   - WebRTC 只能是 provider 之一，不能成为 Xpod P2P 数据面的产品协议。

当前实现阶段：

- `P2PDataPlane` 已实现 `xpod-p2p-http/1` 帧层和本地 node handler：managed
  client 把 canonical HTTP request 编码成 frame，local node 解码后转发给本地
  CSS HTTP endpoint，再把 HTTP response 编码回 frame。
- `UdpP2PTransport` 是开发/直连验证 provider：它用 Node 原生 UDP socket 在两个
  非浏览器进程之间传递 `xpod-p2p-http/1` frame，用于证明数据面已经跨真实 socket，
  不再只是内存函数调用。它支持把超过单个 UDP datagram 限制的 HTTP frame 拆成
  `xpod-p2p-http-fragment` 多包并在接收端重组，因此可验证较大的 Solid 请求体和响应体
  能穿过当前 P2P 数据面。
- `UdpP2PRendezvous` 是当前 UDP provider 的最小打洞前置能力：双方先绑定各自 UDP
  socket，把本地 UDP candidate 通过 signaling session 交换，然后用同一个 socket
  对候选地址发送 `hello/ack`，握手成功后继续用该 socket 承载 `xpod-p2p-http/1`。
  这样能验证“候选交换 → socket rendezvous → Solid HTTP 数据面”的完整本地链路。
- `P2PSignalingClient` 和 `connectUdpP2PThroughSignaling` 已把控制面和当前 UDP provider
  串起来：managed client / node 可以通过 `/v1/signal/nodes/{nodeId}/sessions`
  创建或读取会话、追加本地 candidate、轮询远端 candidate，然后复用 rendezvous socket
  建立 `UdpP2PDataPlaneTransport`。
- `UdpStunCandidate` 已支持最小 STUN Binding：在同一个 rendezvous UDP socket 上向
  STUN server 发送 Binding Request，解析 `XOR-MAPPED-ADDRESS` 生成
  `candidateType=server-reflexive` candidate，并通过 signaling 与 direct candidate
  一起发布。这是跨 NAT 的前置能力，但还不是完整 ICE。
- `WeriftDataChannelP2PTransport` 已支持 Node / native 非浏览器 DataChannel provider：
  通过仓库现有 `werift` 依赖建立 RTCPeerConnection，使用 ICE + DTLS + SCTP DataChannel
  承载同一套 `xpod-p2p-http/1` frame。它证明 HTTP frame 可以跑在可靠有序的非浏览器
  P2P stream 上，不需要普通浏览器参与。
- `connectWeriftDataChannelThroughSignaling` 已把 werift provider 接入现有 P2P signaling
  session：client 发布 `offer` signal candidate，node 轮询后发布 `answer` signal candidate，
  双方再打开 DataChannel 承载 `xpod-p2p-http/1`。client 侧也可用
  `createWeriftDataChannelSessionThroughSignaling` 直接创建 `/sessions`，把 initial offer
  放入创建请求的 `candidates`，再等待 node answer。
- 当前仍未完成生产级公网 P2P：UDP provider 有 frame 分片/重组，但没有丢包重传、
  拥塞控制或加密握手；werift provider 已具备 ICE/DTLS/SCTP 和 signaling offer/answer
  建链能力，但还没有实现 trickle ICE candidate 增量同步、TURN 策略、移动端网络切换
  和真实跨 NAT 验证。

设计约束：

- `p2p` route 的 `targetUrl` 是 managed client 的 transport endpoint，不给普通浏览器打开。
- Cloud signaling 只交换 session、candidate、credential 和状态；默认不承载 Pod HTTP body。
- Local node 必须把收到的 P2P HTTP frame 转为本机 CSS HTTP 请求，并注入
  `x-xpod-canonical-url` / `x-xpod-canonical-origin` / `x-xpod-canonical-host`
  供本地网关和审计保留 canonical 语义。
- 连接失败时回落到下一个 route；不能把 P2P 成功作为 Solid resource identity 的前提。

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
GET /v1/signal/nodes/{nodeId}/routes
Authorization: Bearer <clientToken> # optional; absent callers receive public-filtered routes
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
POST /v1/signal/nodes/{nodeId}/sessions
Authorization: Bearer <clientToken>
Content-Type: application/json

{
  "kind": "p2p",
  "clientId": "device_123",
  "capabilities": ["tcp-punch", "udp-hole-punch"],
  "candidates": []
}
```

返回：

```json
{
  "sessionId": "p2p_...",
  "kind": "p2p",
  "expiresAt": "2026-06-19T00:05:00Z",
  "nodeCandidates": [],
  "signalingUrl": "https://api.example.com/v1/signal/nodes/node-abc/sessions/p2p_..."
}
```

要求：

- Cloud 只做候选交换和会话鉴权，不承载 Pod HTTP body。
- 会话必须短 TTL，可撤销，可审计。
- 失败后回落到下一候选 route，不阻塞本地可用性。

会话创建后，`signalingUrl` 是该短 TTL 会话的控制面入口：

```http
GET /v1/signal/nodes/{nodeId}/sessions/{sessionId}
Authorization: Bearer <nodeToken|serviceToken>
```

返回当前 P2P session，包括双方已上报的 transport candidates。候选是 provider-neutral
结构：公共字段只保留 `role`、`sourceId`、`protocol`、`transport`、`host`、`address`、
`port`、`url`、`priority`、`metadata`。QUIC、UDP punch、WebRTC、libp2p 等 provider
自己的细节放入 `metadata`，不进入 Solid URL、Pod RDF 或 route kind。

双方用同一个 session 追加候选：

```http
POST /v1/signal/nodes/{nodeId}/sessions/{sessionId}/candidates
Authorization: Bearer <nodeToken|serviceToken>
Content-Type: application/json

{
  "role": "client",
  "sourceId": "device_123",
  "candidates": [
    {
      "protocol": "udp",
      "host": "198.51.100.10",
      "port": 43122,
      "priority": 100,
      "metadata": {
        "provider": "quic-ice"
      }
    }
  ]
}
```

节点使用 node token 追加候选时，Cloud 从认证上下文强制推导 `role=node`、
`sourceId=nodeId`，不信任 body 里的伪造身份。service token 可代表 managed client
提交 `role=client` 候选。会话过期后候选更新返回 `410`，客户端必须创建新 session
或回落到下一 route。

当前 UDP provider 的非浏览器握手流程：

1. node 和 managed client 各自创建 `UdpP2PRendezvousPeer`，绑定 UDP socket。
2. 双方调用 `candidate()` 得到 `protocol=udp`、`host`、`port`、`role`、`sourceId`
   的本地候选，并通过 `P2PSignalingClient.addP2PCandidates()` 写入同一个 P2P session。
3. 如配置 STUN，双方在同一个 rendezvous socket 上执行 Binding Request，得到
   server-reflexive candidate；STUN 失败只降级为 direct candidate，不阻断连接尝试。
4. 双方通过 `P2PSignalingClient.getP2PSession()` 轮询 session candidates，拿到远端
   candidate 后调用 `connect()`，对远端候选重复发送 `xpod-p2p-udp-rendezvous-hello`。
5. 收到同 session、对端 role/source 的 hello 后返回
   `xpod-p2p-udp-rendezvous-ack`，并记录实际来源地址/端口作为数据面 remote endpoint。
6. `connectUdpP2PThroughSignaling()` 在握手成功后为调用方创建
   `UdpP2PDataPlaneTransport`，node 侧用 `UdpP2PDataPlaneServer` 监听同一个 socket；
   二者都复用 rendezvous socket，避免 NAT 映射因为换 socket 而失效。

这个流程仍然只是 provider 层能力，不改变 Solid HTTP 语义，不新增 Pod RDF 模型，
也不把 UDP endpoint 暴露给普通浏览器。

### Relay / Tunnel 会话：新增但默认关闭

```http
POST /v1/signal/nodes/{nodeId}/sessions
Authorization: Bearer <clientToken>
Content-Type: application/json

{
  "kind": "relay",
  "reason": "temporary remote verification",
  "ttlSeconds": 900
}
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
- `route.targetUrl`：canonical SP URL，例如 `https://node-abc.pods.example.com/`。

这里的 session 是控制面授权和审计记录，不产生 Cloud API 分享链接。外部验收访问仍使用 SP 域名本身：

```http
GET http://node-0000.undefineds.co/alice/a.txt
Host: node-0000.undefineds.co
```

数据面由普通 SP 域名入口承载：DNS / ingress 根据 `Host` 命中 Cloud gateway，`EdgeNodeProxyHttpHandler` 通过 `cluster_node.subdomain` 找到节点；当节点是 `access_mode=proxy` 且 metadata 里存在 `tunnel.entrypoint` 或 `managedTunnel.endpoint` 时，gateway 将原始资源路径转发到该 tunnel entrypoint。也就是说，浏览器看到和分享的始终是 SP 域名，不是 `/v1/relay/...` API URL。

最小外部验收可以直接打开资源 URL，也可以打开同源浏览器验证页：

```http
GET http://node-0000.undefineds.co/app/reachability.html?path=%2Falice%2Fa.txt
```

验证页由 Local SP 的 `/app/` 静态资源提供；它只从当前 origin fetch `/alice/a.txt`，用于证明普通浏览器数据面可达。它不验证 P2P 打洞或 managed-client 私有 route。

如果验收目标是“通过信令服务验证基本 Pod 功能”，使用信令验证页：

```http
GET http://node-0000.undefineds.co/app/signal-pod.html?nodeId=node-0000&path=%2Falice%2Fa.txt
```

该页面先调用 `GET /v1/signal/nodes/{nodeId}/routes`，可选调用
`POST /v1/signal/nodes/{nodeId}/sessions`，再从返回的
`nodeCandidates` / route 中选择数据入口去 `GET` Pod resource。它验证的是
当前信令控制面、route/candidate 返回和 Pod HTTP 读取链路；在 worker/client
实现完整 candidate exchange 和连接建立前，不把它解释为完整 P2P 打洞成功。

当前实现边界：

- `/v1/signal/...` 只负责 route、session、候选和审计等控制面，不承载浏览器资源 URL。
- 数据面入口是 `http(s)://{node-subdomain}/{pod-resource-path}`，不是 `/v1/relay/...`。
- Cloud gateway 不把 loopback、LAN、managed-only route 暴露给普通浏览器；它只使用节点显式上报并已启用的 tunnel/proxy entrypoint。
- 会话过期、限额和撤销应影响该节点的 tunnel/proxy 可用状态，而不是生成另一套资源 URL。
- 这不是 NAT 打洞本身；打洞仍由 signaling 协调。外部浏览器验收依赖 SP 域名入口和可用 tunnel/proxy entrypoint。

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
2. `GET /v1/signal/nodes/{nodeId}/routes` 查询与权限过滤。
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
