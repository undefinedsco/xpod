# OpenCode Go 额度

OpenCode Go 是 Custom 下的显式套餐，使用标准 API Key 连接、现有凭据池和额度适配器接口。普通 OpenAI/Anthropic Compatible 连接不会根据 URL 自动识别套餐，也不会自动把凭据发送到其他站点。

已有 OpenCode Go 连接可在“编辑凭证”的“套餐 / 区域”选择 OpenCode Go；Key 留空即可保留，凭据 id、模型关系、标签、优先级、启用状态和现有 Base URL 不变。迁移路径由程序目录的 `credentialMigrationFrom` 声明，未声明的套餐切换会拒绝。若旧 Base URL 不是当前官方 Chat 地址，请另行显式更新。

程序目录声明 Chat 地址 `https://opencode.ai/inference/go/openai/v1`、独立模型目录地址 `https://opencode.ai/inference/go/v1/models`；服务端额度能力声明 `https://opencode.ai/inference/go/v1/usage`。额度地址取自程序声明，不从用户 Base URL 推测。通用 `usage-percent-windows` 适配器根据声明的窗口映射读取 `usage`，归一化为五小时、周、月三个百分比窗口，保留代理、取消信号和错误语义。

刷新每条连接的额度时使用该条连接的凭据，界面展示剩余百分比及重置时间。上游 `percent` 是已用的整数百分比，0 不代表精确零使用；空或畸形响应不算可用额度。月窗口重置时间只表示额度周期重置，不能据此声明订阅到期或续费日。

官方契约：[OpenCode Go Usage](https://opencode.ai/docs/console/go/#usage)。此功能不修改账号订阅、付款方式或 upstream Key。

## 通用适配器的适应面

`DeclaredUsageQuotaAdapter` 实现既有 `ProviderQuotaAdapter`，由 `QuotaCapabilityRegistry` 按 `usage-percent-windows` 分派。程序目录可为其他服务声明 HTTPS `url` 及 `windows`（上游 meter key → Xpod 窗口名），适用于返回 `usage[key].status/percent/resetsAt` 的 API-key 接口；不需要新增 provider 判断。不同响应形状继续实现同一接口的其他协议 handler。模型发现支持独立、程序声明的 `modelDiscovery.baseUrl`，不会由用户的推理地址反推额度地址。
