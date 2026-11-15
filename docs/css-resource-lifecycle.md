# CSS WebSocket 生命周期

CSS 模块通过 `FinalizingWebSocketServerConfigurator` 等位替换 CSS 的
`WebSocketServerConfigurator`。升级协议与现有 `WebSocketHandler.handleSafe`
契约保持一致，连接归创建它们的配置组件拥有，不由 CLI 维护第二份 socket 清单。

`config/xpod.base.json` 将同一配置组件登记到 CSS App 的 `Finalizer`。
它与 HTTP listener finalizer 并行运行：先移除自身的 upgrade listener，
再向已有连接发送 1001 close，等待真实 WebSocket server close 回调。
因此 HTTP `server.close` 不会因为尚存的升级连接而永久等待。
本组件不移除其他组件的 upgrade listener。

客户端在 5 秒内未回应 close 时，组件终止它拥有的残留连接并报告失败，
不能把这次强制清理表示为正常关停。并发 finalization 共享一次结果。
local、cloud、standalone 通过同一基础配置使用这一责任边界。

精准回归使用真实 HTTP/WebSocket 网络连接，覆盖正常 close 应答、
HTTP finalizer 并行等待、并发停止，以及不回应 close 的客户端。
阶段产物的协议诊断与最终归档的独立安装验收分别保存证据；
阶段产物、单元测试通过不代表真实部署、cluster 或数据库 lease 已完成验收。
