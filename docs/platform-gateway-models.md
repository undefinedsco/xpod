# 平台模型与个人模型

Gateway 的模型列表与 Chat 使用同一个组合 credential store。用户 Pod 保持个人模型及凭据的权威来源；部署提供的平台容量由已有 `DEFAULT_API_BASE`、`DEFAULT_API_KEY`、`DEFAULT_PROVIDER`、`DEFAULT_MODEL` 配置声明，不写入用户 Pod，也不投影到 Agent 环境。

平台使用内部 `platform-<provider>` 身份隔离部署端点，不覆盖同名个人 provider 的目录或端点。通用 OpenAI-compatible runtime 接收程序声明的 descriptor；Cloud 个人凭据仍受既有目录端点限制。平台部署端点的精确 origin 是可信运维声明，可访问内网平台服务；用户凭据不能声明新的可信 origin。

平台 `/models` 使用五秒超时、六十秒进程缓存和并发请求合并，发现结果与部署者明确声明的默认模型合并。发现失败保留上次成功列表，首次失败仅保留部署者明确配置的默认模型。缺少端点或密钥时不注册平台容量，不凭空返回模型。发现协议仅提供模型身份和名称时，其他模型能力保持未知。

Cloud 列表与平台发现共用公开模型投影解析器，保留经过验证的 `context_window`、布尔能力、Gateway 协议、输入/输出 modalities 和自定义能力。平台 `owned_by` 始终绑定本地平台 provider；上游任意字段与嵌套 secret 不透传。平台 cache 返回独立快照，调用者不能修改后续请求的元数据。

平台密钥在服务内使用现有 `plaintext-v1` secret 解码契约，并不持久化为用户 credential。平台 success/failure 状态在进程内维护，401 标记无效，429 与服务错误记录短期 cooldown；OAuth renewal、rewrap 不委托用户 Pod。个人凭据的这些操作仍完整委托原仓储。每个用户会话的 Gateway cooldown 仍由既有 session affinity store 管理。

验收分开记录认证、Pod 读写、模型列表及真实 Chat 响应。隔离上游测试通过不能替代当前运行域名上的验收。
