# Edge Cluster Performance Notes

## 带宽与延迟监控
- `UsageTrackingStore` 仍是唯一的数据来源，所有的 ingress/egress 字节都会落表，可直接根据 `identity_account_usage`、`identity_pod_usage` 统计隧道流量。
- 心跳中的 `tunnel.client` 提供 frpc 运行状态（`running`/`inactive`/`error`），后续可以扩展成报告 RTT、重连次数等指标（当前标记为 TODO）。

## 手动压测流程（建议）
1. 启动 cluster（`yarn server`）和有代表性的 Edge Node（`XPOD_EDGE_NODES_ENABLED=true`，并开启 frp）。
2. 使用 `wrk`/`bombardier` 等工具打到 Pod 的域名，分别在直连模式与 proxy 模式下记录带宽/延迟。
3. 对比 `UsageTrackingStore` 的写入量与压力工具的统计，确保误差在预期范围内。
4. 将采集结果记录在 PR 描述里，特别是直连/隧道切换的延迟（期望 <30s）。

## TODO
- [ ] 在 `tunnel.client` 中追加平均 RTT、最近一次重连耗时等字段。
- [ ] 将 UsageTracking 的统计写入 Prometheus exporter，方便统一监控。
