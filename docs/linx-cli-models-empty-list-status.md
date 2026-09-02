# LinX CLI Models Empty List Status

## 结论

LinX CLI / Pi TUI 侧登录链路已经基本打通。

当前主 blocker 已经从：

- OIDC redirect / callback
- localhost callback 页面
- login 命令卡住

转移为：

- cloud runtime `GET /v1/models` 返回空列表

也就是说，本轮联调最新状态不是“登录不通”，而是：

- **登录成功**
- **`linx models` 能正常跑到 cloud runtime**
- 但 cloud runtime 返回：
  - `Cloud runtime returned an empty model list.`

## 已打通部分

### 1. CLI / TUI 登录入口

当前默认入口：

- `linx`

前端：

- Pi 原生 TUI

显式登录：

- `linx login`

### 2. 浏览器授权链路

当前已打通：

1. CLI 起本地 loopback callback
   - `http://127.0.0.1:<port>/auth/callback`
2. 浏览器跳转到：
   - `https://id.undefineds.co/.oidc/auth?...`
3. 浏览器完成授权
4. IdP 回跳本地 callback
5. CLI 完成 token exchange
6. 登录态写入：
   - `~/.linx/config.json`
   - `~/.linx/secrets.json`
   - `~/.linx/account.json`
   - `~/.linx/oidc-storage/`

### 3. id.undefineds.co 已接受 loopback redirect

之前曾出现：

- `invalid_redirect_uri`

后续联调已确认：

- 同类授权请求返回 `303` 到 `/.account/`

说明 loopback redirect 已在云端放开。

### 4. `linx login` 命令已经收口

现在 `linx login` 成功后会正常结束，不再因为 callback server / 句柄残留卡住。

### 5. TUI / runtime 不再要求用户本地输入模型供应商 API key

当前设计目标已经明确：

- CLI/TUI 只持有 LinX Cloud 登录态
- 对 cloud `/v1/models` 与 `/v1/chat/completions` 的请求使用 LinX OIDC token
- 供应商 key（OpenAI / Anthropic 等）应由 cloud / Pod 配置解析，而不是本地 CLI 输入

## 本轮重要修复

### A. `linx models` 已改为轻路径

之前：

- `linx models` 会走 `resolveContext()`
- 会初始化 Pod / chat 数据
- 会错误触发 `pod-chat-store` 内部查询
- 从而被 `drizzle-solid` 的 `id` where policy 拦住

现在：

- `linx models` 改为只做 runtime auth + `/v1/models`
- 不再初始化 Pod / chat
- 因此可以单独验证 cloud runtime 模型发现链路

### B. OIDC access token 获取逻辑已从“本地 token 直读”切到“session 恢复 / refresh 路线”

联调过程中发现：

- 只信 `~/.linx/secrets.json` 里的 `oidcAccessToken` 是不够的
- token 会过期
- 旧实现会导致 models / runtime 停在过期 token 上

当前 CLI 侧已经开始切向正确方向：

- 从 `~/.linx/oidc-storage` 恢复 Inrupt session
- 再用 session 做 refresh / token 复用

这部分仍在收尾，但方向已从“错误实现”切回“正确实现”。

## 当前最新观测结果

用户反馈最新结果：

```text
linx login
LinX login successful.
server: https://id.undefineds.co/
webId: https://id.undefineds.co/ganbb/profile/card#me
auth: oidc_oauth
session: reused
```

说明：

- 登录与本地状态复用都已工作

随后：

```text
linx models
Cloud runtime returned an empty model list.
```

说明：

- 命令已到达 cloud runtime
- 不是本地异常
- 不是 `drizzle-solid` 问题
- 不是 callback / login 问题
- 是服务端模型发现结果为 empty

## 这意味着什么

`GET /v1/models` 的产品语义已经明确：

- **不是**平台公开目录（不 dump Provider Registry）
- **不是**把 Cloud 模型写进用户 Pod
- **也不是**扫 WebID 下的全部 Pod

Local 的 `/v1/models` 是两份用户身份投影的并集：

1. **Local**：当前 WebID 自己的 Pod 凭据 / Pick
2. **Cloud**：带着同一用户身份转发 `GET {oidcIssuer}/v1/models`；Cloud 认这个身份，不需要再写密钥

去重按 model id。本进程已经是 Cloud、issuer 与本机同源、或 Cloud 不可达时，只返回 Local 列表。

Local Chat 在本机没有可用凭据时，同样带着调用方身份转发 Cloud `/v1/chat/completions`（以及 `/v1/responses`、`/v1/messages`）。Cloud 认这个身份，不写密钥进 Pod。本机凭据优先；DPoP、显式 credential、Cloud 未配置都不转发。不可达 Cloud 返回 `provider_error` 502，不吞成本机空结果。

## 对 xpod / cloud 的建议

### P0

Local 侧已按该契约实现：`src/api/ai-gateway/CloudGatewayModelsClient.ts` 转发调用方 `Authorization` 打 Cloud `GET /v1/models`，再与本机用户 Pod 投影并集。Cloud 进程、同源 issuer、不可达 Cloud 都跳过拼接。

Cloud 自身 `/v1/models` 仍只投影 **该用户自己的 Cloud Pod**。如果 Cloud 对 `https://id.undefineds.co/ganbb/profile/card#me` 也返回空列表，那是 Cloud Pod 里没有可用凭据 / Pick，不是 Local 漏拼平台目录。

### P1

给空列表场景加可观测性：当前身份、是否尝试 Cloud splice、Cloud HTTP 状态、最终本地 / Cloud 条数。

### P2

给 CLI/TUI 提供更明确的 machine-readable 空列表原因，例如 `no-provider-configured` / `cloud-unreachable`。

5. 如果不存在，账号页 / Pod 绑定流程是否本就没有写入这些配置

## 一句话总结

当前 LinX CLI 的登录和 `/models` 调用链路已经基本打通。剩余问题已经收缩为：

- **cloud `/v1/models` 对当前身份返回空列表**

这应优先在 xpod / cloud runtime 侧确认模型发现的真实契约与数据来源。
