# Edge Cluster Security Checklist

## 证书与密钥
- ACME 账号私钥保存在 `XPOD_ACME_ACCOUNT_KEY_PATH`；Cluster 只存储账户级私钥与已签发的证书，节点私钥一直留在本地（`EdgeNodeAgent` 自行生成 CSR）。
- `/api/signal/certificate` 仅接受已经注册的 nodeId + token；所有响应都包含完整证书链与过期时间，方便节点自行验证。
- Cluster 端会在 `identity_edge_node.metadata.certificate` 中记录证书颁发时间、域名与到期时间，便于审计。

## 隧道/FRP
- 隧道配置只通过受保护的信令接口下发，payload 内包含 `serverHost/serverPort/token` 等敏感信息；需要确保存储在受控目录（例如 Agent 本地 `./local/frp/`）。
- FRP Token 不落数据库，只存在于 pods_config/环境变量中；如需轮换，只需更新 Cluster 端变量并重启 Agent（新的 config 会覆盖旧值）。
- 心跳中的 `tunnel.client` 包含运行状态和 PID，用于 Cluster 判断异常重启或误杀；该状态本身不暴露敏感信息。

## 控制面/API
- 所有 `/api/signal/*` 接口仍依赖 node token + DB hash 校验；在高频心跳场景下建议观察并限制失败次数。
- 新增的 HTTP proxy 仅在 `accessMode=proxy` 的子域下生效，并在响应中注入 `X-Xpod-Edge-Node` 以便上游日志审计。

## TODO
- [ ] 针对心跳/证书/隧道接口补充速率限制。
- [ ] 对 `tunnel.client` 里的状态变更增加审计日志（例如持续的 error 状态）。
