# Xpod 桌面端规划

本文记录桌面版（local 运维客户端）的核心目标与待拆功能，便于后续独立仓库实现时对照。当前仓库中已经提供了底层 API/Agent 支撑，UI 与进程管理将在桌面端落地。

## 目标能力

1. **节点生命周期管理**
   - 启动/停止本地 CSS 实例（`yarn local` 或自定义打包的可执行程序）。
   - 管理数据目录、备份与恢复操作。
   - 展示运行状态（端口、日志、版本）并提供快捷重启。

2. **证书配置（ACME）**
   - 可视化填写邮箱、域名列表、证书保存路径。
   - 调用 `EdgeNodeAgent` 的 `acme` 功能，展示申请进度、到期时间、错误信息。
   - 支持“应用证书后自动重载 CSS/反向代理”的一键操作。

3. **隧道/网络**
   - 切换直连 / FRP 隧道，填写 frps 地址、token、自定义域后缀。
   - 启停本地 `frpc` 进程，查看连接状态、入口 URL。
   - 结合心跳信息，展示 cluster 侧探测结果与故障排查建议。
   - 引入“网络流量”配额概念：后端已在 `identity_account_usage` / `identity_pod_usage` 表维护 `ingress_bytes` / `egress_bytes` 与带宽上限（默认 10 MiB/s），桌面端需读取统计、展示趋势，并支持阈值告警/重置。

4. **信令与云边协同**
   - 绑定 `nodeId`/`nodeToken`，查看最近心跳时间、上报的 Pod 列表。
   - 提供 Pod/账号用量的汇总视图（读取 `UsageRepository` 数据）。
   - 支持手动触发“上报心跳”“刷新 DNS”等操作。

5. **日志与调试**
   - 聚合 CSS、Agent、frpc、ACME 等组件日志。
   - 提供日志等级切换、关键字搜索以及导出功能。
   - 快速访问诊断信息（配置文件、当前环境变量、版本号）。

## 需要拆出的仓库内容

下述模块在当前仓库中仅提供底层能力，桌面端实现时应封装 UI 或守护逻辑：

- `src/edge/EdgeNodeAgent` 及其 `acme`、`frp` 配置：桌面端负责包装调用、生命周期管理。
- `src/edge/acme/AcmeCertificateManager`：在桌面端触发申请、展示状态、处理 post-deploy。
- `src/edge/frp/FrpcProcessManager`：桌面端守护 frpc，提供可视化配置与日志查看。
- 心跳返回的 `metadata.tunnel.config`/`metadata.certificate` 数据：桌面端解析并呈现。
- 任何 admin console 相关的 UI 逻辑（未来会在桌面/外部系统中重建）。

## 交付形态建议

- **独立仓库**：桌面端以 Electron/Tauri 等框架实现，依赖本仓库发布的 npm 包（或通过 REST API 调用）。
- **脚手架支持**：可提供 `yarn desktop` 类脚本，协助下载桌面客户端、启动 Agent。
- **版本管理**：与 server/local 版本解耦，桌面端独立发布、维护升级通道。

后续迭代时，建议在此文档持续补充 API 变化、UI 需求以及待清理的旧逻辑，确保服务端与桌面端团队对齐。
