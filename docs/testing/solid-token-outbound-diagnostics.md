# Solid Token 出站验证诊断

`SolidTokenCaches` 为 WebID、OIDC discovery、JWKS 的请求和响应体读取失败补充安全上下文。异常仍沿现有 verifier 路径拒绝认证；`ConfiguredLoopbackDPoPWebIdExtractor` 的现有 warning 会记录该上下文，不依赖开启 debug 日志。

示例（标识为虚构）：

```text
Solid token document unavailable (stage=webid-profile, phase=headers, route=external, origin=0123456789abcdef, cause=BunFetchSocketClosed)
```

| 字段 | 含义 |
| --- | --- |
| `stage` | `webid-profile`、`oidc-discovery`、`issuer-jwks`，明确失败文档 |
| `phase` | `headers` 表示 `fetch` 未成功返回 Response；`body` 表示 Response 已返回，读取 text/JSON 失败（JSON 解码失败也在此阶段） |
| `route` | `internal` 表示同源文档被既有配置转发到 CSS 内部 origin；`external` 表示使用文档自身 origin，不代表目标一定是公网 |
| `origin` | 请求文档的初始逻辑 origin 的 SHA-256 前 16 个十六进制字符，供已知 origin 对照；不是路径、WebID、Token 或原始 URL；不能定位 HTTP redirect 的后续目标 |
| `cause` | 固定允许列表中的网络错误 code/name；不认识的错误用 `unknown`，不输出上游 message |

用已有权威输入计算候选 origin 标识：

```ts
import { createHash } from 'node:crypto';
const fingerprint = createHash('sha256').update(new URL(knownUrl).origin).digest('hex').slice(0, 16);
```

只处理安全 message 作为诊断证据。原异常保留在 `cause` 供进程内检查，可能带私有信息，不应直接导出或保存整个异常链。HTTP 非成功状态仍使用既有错误和 WebID bootstrap 状态重试策略；网络异常没有新增重试，也没有缓存过期后的信任回退。DPoP、JWT、issuer 信任、client allowlist 和 Account WebID 关联检查均未改变。没有新配置项或依赖。

中央实例需要运行包含此变更的产物，才能通过现有只读生产诊断 workflow 获取实际失败 stage/phase/origin。现有 workflow 仅执行 `kubectl get`、`describe`、`logs`，不能证明从中央容器到目标文档的出站连通性；本机或隔离 socket 测试也不能替代中央网络验收。此变更解决诊断缺口，不代表中央网络故障已修复。
