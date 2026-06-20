# Edge Node Agent 使用说明

## 1. 目标

- 在节点主机上周期性上报心跳、Pod 列表以及系统指标。
- 自动携带 `metadata.dns` / `metadata.certificate.dns01` 字段，触发 cluster 侧的 DNS 与证书自动化逻辑。
- 轻量化部署：仅依赖 Node.js 18+，无额外守护进程。
- 桌面版展望：后续将把证书申请、隧道开关、日志查看等功能整合到桌面客户端；本页面聚焦底层能力说明。

## 2. 快速开始

```bash
node dist/edge-node-agent-start.js \
  --signalEndpoint https://cluster.example/api/signal \
  --nodeId <NODE_ID> \
  --nodeToken <NODE_TOKEN> \
  --baseUrl https://alice.cluster.example/ \
  --directCandidates https://203.0.113.10:443/ \
  --pods https://alice.cluster.example/
```

> **提示**：仓库默认未提供 CLI 包装脚本，可直接在自定义入口中引用 `EdgeNodeAgent`；上方命令示例展示了常见参数，具体实现需自行封装。

## 3. 代码集成示例

```ts
import { EdgeNodeAgent } from '@undefineds/xpod';

const agent = new EdgeNodeAgent();
await agent.start({
  signalEndpoint: process.env.XPOD_SIGNAL_ENDPOINT!,
  nodeId: process.env.XPOD_NODE_ID!,
  nodeToken: process.env.XPOD_NODE_TOKEN!,
  baseUrl: process.env.CSS_BASE_URL,
  directCandidates: process.env.XPOD_NODE_DIRECT_CANDIDATES?.split(','),
  pods: process.env.CSS_NODE_PODS?.split(','),
  includeSystemMetrics: true,
  metadata: {
    dns: {
      subdomain: process.env.CSS_NODE_SUBDOMAIN,
      target: process.env.CSS_NODE_TARGET,
    },
    certificate: {
      dns01: {
        subdomain: `_acme-challenge.${process.env.CSS_NODE_SUBDOMAIN}`,
        value: process.env.CSS_NODE_ACME_VALUE,
      },
      frp: {
        serverHost: process.env.CSS_FRP_SERVER_HOST,
        serverPort: process.env.CSS_FRP_SERVER_PORT,
      }
    },
  },
  onHeartbeatResponse: (payload) => {
    const tunnel = (payload as any)?.metadata?.tunnel?.config;
    if (tunnel) {
      console.log('收到隧道配置，可写入 frpc.ini:', tunnel);
    }
  },
  acme: {
    email: process.env.CSS_ACME_EMAIL!,
    domains: [ process.env.CSS_NODE_SUBDOMAIN! + '.xpod.example' ],
    accountKeyPath: './certs/account.key',
    certificateKeyPath: './certs/tls.key',
    certificatePath: './certs/tls.crt',
    postDeployCommand: [ '/usr/bin/systemctl', 'reload', 'community-solid-server' ],
  },
  frp: {
    binaryPath: '/usr/local/bin/frpc',
    configPath: './frpc.ini',
    workingDirectory: process.cwd(),
  },
  p2p: {
    enabled: true,
    targetBaseUrl: process.env.CSS_BASE_URL ?? 'http://127.0.0.1:3000/',
    label: 'xpod-p2p-http',
  },
});
```

- `includeSystemMetrics` 开启后会自动采集 `loadavg`、内存、CPU 等信息，并写入 `metadata.system` 与 `metrics` 字段。
- 需要停止 agent 时调用 `agent.stop()`，该方法会清理内部定时器。

## 4. 最佳实践

- 建议与进程守护工具（systemd、supervisord、PM2 等）结合，确保节点重启时自动恢复心跳。
- Heartbeat 默认 30 秒发送一次，可通过 `intervalMs` 调整频率。
- 通过本仓库 CSS local 配置自动启动 Agent 时，需显式设置：
  - `XPOD_EDGE_NODE_AGENT_ENABLED=true`
  - `XPOD_SIGNAL_ENDPOINT=https://cluster.example/api/signal`
  - `XPOD_NODE_ID=<NODE_ID>`
  - `XPOD_NODE_TOKEN=<NODE_TOKEN>`
  - `XPOD_P2P_ENABLED=true`
  - `XPOD_P2P_TARGET_BASE_URL=http://127.0.0.1:3000/`
  - 可选：`XPOD_P2P_LABEL`。
  - 可选：`XPOD_P2P_ACCEPT_INTERVAL_MS=1000`。
  - 可选：`XPOD_P2P_CONNECT_TIMEOUT_MS=5000`。
- 启用 `XPOD_P2P_ENABLED=true` 后，Agent 会在心跳 `metadata.routes` 中自动追加
  `id=p2p-raw-tcp`、`kind=p2p`、`targetUrl=tcp-punch://node/<nodeId>` 的 managed-only route。
  Cloud 创建 P2P session 时会把该 route 放入 `nodeCandidates`，managed/native client
  才能在 session 返回值中选择 raw TCP P2P 数据面。不要把这个 `tcp-punch://...`
  写成 Pod Root 或 WebID；Solid canonical URL 仍来自 `baseUrl` / route registry。
- 若节点拥有多个 Pod，`pods` 数组可列出多个 baseUrl；缺失时仍可通过控制面 API 感知 Pod 实际列表。
- `metadata.dns` 与 `metadata.certificate.dns01` 字段可以在心跳期间动态更新，以便控制面及时刷新 DNS/TXT 记录（当 `acme.mode=local` 时仍旧适用）。
- 启用控制面自动化需在 cluster 端设置 `CSS_EDGE_NODES_ENABLED=true`，并按需提供 `CSS_TENCENT_DNS_TOKEN_ID`/`CSS_TENCENT_DNS_TOKEN` 等变量（详见《edge-node-control-plane》）；DNS 根域名自动复用 CSS `baseUrl`。
- FRP 隧道信息会在心跳响应的 `metadata.tunnel.config` 中返回（包含 `serverHost`、`serverPort`、`token`、`proxyName`、`remotePort`）。若在 Agent 中启用 `frp` 配置，将自动生成 `frpc.ini` 并守护 `frpc` 进程；未配置时可自行处理或保持直连。
- Agent 会在心跳的 `tunnel.client` 字段中汇报 frpc 运行状态（`running/inactive/error`、进程 PID、最近更新及故障信息），Cluster 侧可据此监控隧道健康。
- TODO：后续将在该字段补充更细的带宽/延迟指标，方便观察隧道性能。
- Cloudflare Tunnel、FRP/SakuraFRP 是已实现的公网 `user-tunnel` 能力，必须保留；raw TCP P2P 只是 managed/native client 的数据面优化，不替代、不删除这些 fallback。
- 当前 `p2p` 负责两件事：在 heartbeat 中声明 raw TCP P2P route，并启动 node-side
  accept loop 轮询 `/v1/signal/nodes/:nodeId/sessions`。发现 client-created raw TCP
  session 后，Agent 会追加 node candidates，执行候选连接，并把成功 socket 接入
  `targetBaseUrl` 指向的本地 CSS/SP。真实跨 NAT TCP simultaneous-open 仍依赖后续
  native/CLI/desktop/mobile connector 通过 `connectSocket` 提供平台级 socket 能力。
- 普通浏览器不支持 raw TCP socket、同号端口 bind 或 simultaneous open；手机浏览器页面只能验证
  Cloud IdP、SP route 和 signaling 控制面。Chrome Isolated Web App 的 Direct Sockets
  只能作为安装式 runtime 自定义 TCP transport 的后续研究项；它不是普通浏览器能力，
  也不作为当前浏览器数据面承诺。
- 若提供 `acme` 配置，Agent 会自动申请/续签证书：
- `mode=cluster`（默认推荐）：节点本地仅负责生成私钥与 CSR，调用 `/api/signal/certificate` 让 cluster 完成 ACME DNS-01、证书签发与分发。Cluster 会在心跳响应的 `metadata.certificate` 中回传有效期、域名等信息，Agent 根据这些指令调度下一次续签。
- `mode=local`：兼容旧实现，由节点本地直接调用 ACME CA，cluster 只负责写入 TXT 记录。仅在需要完全离线或自定义 CA 时使用。
  - 两种模式都遵循“私钥只在节点本地存储”原则；cluster 模式下 CSR 与证书的 HTTP 交互均走 `/api/signal/certificate`。
  - `accountKeyPath`、`certificateKeyPath`、`certificatePath` 等路径需可写；不存在的目录会自动创建。
  - 证书到期前 `renewBeforeDays`（默认 15 天）会触发续签，DNS challenge 会通过心跳调用 cluster 自动写入。提供 `postDeployCommand` 可在证书更新后自动执行服务重载脚本。

## 5. 注意事项

- 必须保证 `nodeId`/`nodeToken` 由 cluster 控制面签发，否则信令接口会返回 401。
- 如需通过代理或隧道访问 cluster，可在外层配置 HTTP 代理；Agent 内部默认直接向 `signalEndpoint` 发起 HTTPS 请求。启用 `frp` 后请确保本地允许执行指定的 frpc 二进制，并监控其日志。
- 若心跳失败，可查看日志是否出现 `Edge node heartbeat failed`，并针对具体 HTTP 状态或错误信息排查网络、证书、DNS 配置。
