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

当前真正要回答的问题已经变成：

### `/v1/models` 的产品语义到底是什么？

是下面哪一种：

#### 方案 1：平台级模型目录

- 只要用户已登录
- `/v1/models` 就应该返回平台模型目录
- 与用户 Pod 中是否已配置具体 provider 无关

如果产品语义是这个，那么当前返回空列表就是 cloud runtime bug。

#### 方案 2：用户可用模型列表

- `/v1/models` 只返回当前身份实际可用的模型
- 这些模型取决于：
  - Pod 中的 provider / credential 配置
  - account / WebID / Pod 绑定是否完整
  - cloud 对当前身份的 provider 授权判断

如果产品语义是这个，那么当前返回空列表说明：

- 账号 / Pod / provider state 没完全对齐
- 或 cloud 没正确读取它们

## 对 xpod / cloud 的建议

### P0

1. 明确 `/v1/models` 的服务端契约
   - 平台目录？还是用户可用目录？

2. 若是用户可用目录：
   - 明确它依赖哪些真相源：
     - account
     - webId
     - pod
     - provider rows
     - credential rows

3. 给空列表场景加可观测性：
   - 日志里明确打印：
     - 当前 account / webId
     - 关联 Pod
     - 找到的 provider rows / credential rows
     - 最终为何判定为 0 models

### P1

1. 如果 `/v1/models` 是平台目录，就不要对未配置 provider 的用户返回空数组
2. 如果 `/v1/models` 是用户目录，就需要在 account / consent / Pod 绑定流程完成后，确保模型真相同步完成

### P2

1. 给 CLI/TUI 提供更明确的 machine-readable 空列表原因
   - 例如：
     - `no-provider-configured`
     - `pod-not-bound`
     - `account-has-no-models`

## 建议排查点

优先检查 cloud runtime `/v1/models` 的实现：

1. 当前请求身份是什么？
   - `webId = https://id.undefineds.co/ganbb/profile/card#me`

2. 这个身份在服务端被映射成哪个 account / pod？

3. 该 pod 下是否存在：
   - provider rows
   - credential rows
   - model rows

4. 如果存在，为何最终还是 `[]`

5. 如果不存在，账号页 / Pod 绑定流程是否本就没有写入这些配置

## 一句话总结

当前 LinX CLI 的登录和 `/models` 调用链路已经基本打通。剩余问题已经收缩为：

- **cloud `/v1/models` 对当前身份返回空列表**

这应优先在 xpod / cloud runtime 侧确认模型发现的真实契约与数据来源。
