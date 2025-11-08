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
  --publicAddress https://203.0.113.10:443/ \
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
  baseUrl: process.env.XPOD_NODE_BASE_URL,
  publicAddress: process.env.XPOD_NODE_PUBLIC_ADDRESS,
  pods: process.env.XPOD_NODE_PODS?.split(','),
  includeSystemMetrics: true,
  metadata: {
    dns: {
      subdomain: process.env.XPOD_NODE_SUBDOMAIN,
      target: process.env.XPOD_NODE_TARGET,
    },
    certificate: {
      dns01: {
        subdomain: `_acme-challenge.${process.env.XPOD_NODE_SUBDOMAIN}`,
        value: process.env.XPOD_NODE_ACME_VALUE,
      },
      frp: {
        serverHost: process.env.XPOD_FRP_SERVER_HOST,
        serverPort: process.env.XPOD_FRP_SERVER_PORT,
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
    email: process.env.XPOD_ACME_EMAIL!,
    domains: [ process.env.XPOD_NODE_SUBDOMAIN! + '.xpod.example' ],
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
});
```

- `includeSystemMetrics` 开启后会自动采集 `loadavg`、内存、CPU 等信息，并写入 `metadata.system` 与 `metrics` 字段。
- 需要停止 agent 时调用 `agent.stop()`，该方法会清理内部定时器。

## 4. 最佳实践

- 建议与进程守护工具（systemd、supervisord、PM2 等）结合，确保节点重启时自动恢复心跳。
- Heartbeat 默认 30 秒发送一次，可通过 `intervalMs` 调整频率。
- 若节点拥有多个 Pod，`pods` 数组可列出多个 baseUrl；缺失时仍可通过控制面 API 感知 Pod 实际列表。
- `metadata.dns` 与 `metadata.certificate.dns01` 字段可以在心跳期间动态更新，以便控制面及时刷新 DNS/TXT 记录。
- 启用控制面自动化需在 cluster 端设置 `XPOD_EDGE_NODES_ENABLED=true`，并按需提供 `XPOD_TENCENT_DNS_TOKEN_ID`/`XPOD_TENCENT_DNS_TOKEN`、`XPOD_DNS_ROOT_DOMAIN` 等变量（详见《edge-node-control-plane》）。
- FRP 隧道信息会在心跳响应的 `metadata.tunnel.config` 中返回（包含 `serverHost`、`serverPort`、`token`、`proxyName`、`customDomains`/`remotePort`）。若在 Agent 中启用 `frp` 配置，将自动生成 `frpc.ini` 并守护 `frpc` 进程；未配置时可自行处理或保持直连。
- 若提供 `acme` 配置，Agent 会自动调用 Let’s Encrypt（或自定义目录）申请/续签证书：
  - `accountKeyPath`、`certificateKeyPath`、`certificatePath` 等路径需可写；不存在的目录会自动创建。
  - 证书到期前 `renewBeforeDays`（默认 15 天）会触发续签，DNS challenge 会通过心跳调用 cluster 自动写入。提供 `postDeployCommand` 可在证书更新后自动执行服务重载脚本。

## 5. 注意事项

- 必须保证 `nodeId`/`nodeToken` 由 cluster 控制面签发，否则信令接口会返回 401。
- 如需通过代理或隧道访问 cluster，可在外层配置 HTTP 代理；Agent 内部默认直接向 `signalEndpoint` 发起 HTTPS 请求。启用 `frp` 后请确保本地允许执行指定的 frpc 二进制，并监控其日志。
- 若心跳失败，可查看日志是否出现 `Edge node heartbeat failed`，并针对具体 HTTP 状态或错误信息排查网络、证书、DNS 配置。
