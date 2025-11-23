# Edge Cluster Deployment & Troubleshooting Guide

## 准备工作
1. 配置数据库与 DNS：
   - `XPOD_IDENTITY_DB_URL` 指向 PostgreSQL。
   - `XPOD_TENCENT_DNS_*` 必须可更新节点子域，根域名默认复用 CSS `baseUrl` 的 hostname。
2. ACME/证书：
   - 设置 `XPOD_ACME_EMAIL`、`XPOD_ACME_DIRECTORY_URL`、`XPOD_ACME_ACCOUNT_KEY_PATH`、`XPOD_ACME_CERTIFICATE_STORE`。
3. 隧道/代理：
   - 准备 frps，并为 `XPOD_FRP_SERVER_HOST` 提供高可用域名。
   - 节点端配置 `EdgeNodeAgent` 的 `frp` 字段（binary/config 路径、日志前缀等）。
4. 健康探测：
   - `XPOD_EDGE_HEALTH_PROBES_ENABLED=true`，并根据需要在 `XPOD_EDGE_PROBE_LOCATIONS` 中填写多个探测点。

## 部署步骤
1. `yarn build && yarn cluster:server`（`yarn cluster` 仍可兼容，或使用 `yarn server`）启动 Cluster 控制面；确认门户和登录流程正常。
2. 在普通用户门户的「边缘节点」入口里创建节点（会返回 `nodeId`/`nodeToken`），或通过等效 API 获取凭证。若仅做本地验证，可先在 `.env.cluster.local` 写入自定义 `XPOD_NODE_ID`/`XPOD_NODE_TOKEN`，然后运行 `node test-node-registration.js` 自动写入数据库并调用 `/api/signal`。
3. 在节点主机上运行 Agent（参见 `docs/edge-node-agent.md` 示例），确保心跳日志显示“sent successfully”。
4. 访问 Pod 域名，验证：
   - 直连模式：DNS 指向节点公网 IP，`accessMode=direct`。
   - 隧道模式：DNS 指向 cluster，HTTP 请求经代理，响应头包含 `X-Xpod-Edge-Node`。

## 常见问题
- **心跳 401**：确认 node token 未过期且没有多次复制；必要时在门户里重新生成。
- **证书签发失败**：检查 `XPOD_ACME_*` 配置、DNS TXT 是否可读，并查看 node 端 agent 日志。
- **frpc 不断重启**：查看心跳 `tunnel.client` 字段中的 `error`，常见原因是 token 不匹配或 server host 不可达。
- **隧道状态“active”但无法访问**：若 HTTP proxy 返回 502，首先确认 frps 是否接受连接；其次检查 proxy handler 日志中是否报 “Tunnel not ready”。
