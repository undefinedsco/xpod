# LinX CLI Auth / Runtime Status

## 背景

本轮联调的目标是：

- 默认入口为 `linx`，前端是 Pi 原生 TUI
- 认证走 LinX Cloud 浏览器授权
- 运行时走 cloud `api.undefineds.co/v1`
- Pod / provider 配置由 cloud / Pod 侧管理，而不是要求用户本地手填 API key

## 当前已经打通的部分

### 1. CLI / TUI 登录入口

当前 `linx` 默认已切到 Pi 原生 TUI。

- `linx` 进入 Pi TUI
- `linx login` 走浏览器授权
- 不再使用旧的 email/password 交互

### 2. 浏览器授权链路

当前登录流使用：

- Authorization Code + PKCE
- loopback callback（本地 callback server）

即：

1. CLI 在本机启动 `http://127.0.0.1:<port>/auth/callback`
2. 浏览器跳转到 `https://id.undefineds.co/.oidc/auth?...`
3. 用户在浏览器完成授权
4. IdP 回跳本地 callback
5. CLI 完成 token exchange
6. 将登录态写入 `~/.linx`

### 3. id.undefineds.co 现已接受 loopback redirect

联调中曾遇到：

- `invalid_redirect_uri`

后来再次验证，同类请求现在返回的是：

- `303 Location: https://id.undefineds.co/.account/`

说明 `id.undefineds.co` 侧对 loopback callback 的限制已经放开，CLI/TUI 本地回调路线可用。

### 4. 登录态本地持久化

当前会写入：

- `~/.linx/config.json`
- `~/.linx/secrets.json`
- `~/.linx/account.json`
- `~/.linx/oidc-storage/`

当前本地保存的是 OIDC 登录态，不再是旧的 client credentials 登录。

### 5. TUI 内不再要求用户自己填模型供应商 API key

当前 `linx-cloud` provider 的目标语义是：

- TUI / CLI 自身只持有 LinX Cloud 登录态
- 对 cloud `/v1/models` 和 `/v1/chat/completions` 的请求使用 LinX access token
- 用户自己的 OpenAI / Anthropic / 其他供应商 key 不应在本地 CLI 输入
- 这些 key 应由 cloud / Pod 配置解析

## 当前已修过的体验问题

### 1. 默认前端切换

- 不再把产品入口暴露成 `linx pi-frontend`
- 默认入口是 `linx`
- `pi` / `pi-frontend` 只保留为兼容别名（可继续隐藏/移除）

### 2. 本地 callback 完成页

浏览器完成授权后的本地 callback 页之前只是：

- `LinX login complete. You can close this window.`

现在已经改成 LinX 品牌化的最小完成页。

说明：

- 这个页面是 CLI 本地 callback server 提供的
- 不是 xpod / cloud 页面

从技术上这是标准 loopback callback 方案；从产品一致性看，长期仍建议 xpod 提供 HTTPS callback bridge。

### 3. 已有登录态复用

当前逻辑已经调整为：

- 若本地有未过期 access token，则直接复用
- 若旧态损坏或缺失，不直接抛内部 refresh 错误
- 而是退回浏览器授权

## 当前仍未完全打通的部分

### 1. 登录成功 != runtime 可用

当前 `linx login` 成功后，本地保存的 WebID 类似：

- `https://id.undefineds.co/ganbb/profile/card#me`

这表示浏览器授权已经成功，但并不代表后续 cloud runtime 已完全可用。

### 2. `/v1/models` 仍未在真实环境拿到 live 结果

目前联调中最关键的 blocker 已经从授权链路转移到 runtime 可达性：

在本机使用保存下来的 OIDC token 调用：

- `https://api.undefineds.co/v1/models`

得到的错误是：

- `getaddrinfo ENOTFOUND api.undefineds.co`

这说明当前失败不再是 OIDC 逻辑问题，而是：

- `api.undefineds.co` 在用户机器当前环境不可解析 / 不可达

因此当前不能据此判断 cloud `/models` 实现本身是否正确。

## 关键结论

### 授权问题

授权问题基本已经从“协议不支持”变成“协议已通”。

即：

- loopback redirect 已可用
- CLI/TUI 浏览器授权闭环已建立

### 真正剩余 blocker

当前剩余主 blocker 是：

- `api.undefineds.co` 的 DNS / 网络可达性

而不是：

- OIDC redirect
- callback server
- TUI 登录入口本身

## 对 xpod / cloud 的建议

### P0

1. 确认 `api.undefineds.co` 在目标用户环境下可解析、可访问
2. 若存在 region / private DNS / split-horizon 策略，明确发布给 CLI/TUI 的正确 runtime 域名
3. 明确 `/v1/models` 与 `/v1/chat/completions` 的 OIDC bearer token 支持状态

### P1

1. 提供一个稳定的 account / Pod / runtime 真相接口，用于 CLI/TUI 登录后判断业务上下文是否已完整
2. 明确登录成功后默认 WebID 与真实业务 Pod / storage 之间的关系

### P2

1. 若要进一步产品化 CLI/TUI 体验，可提供 HTTPS callback bridge，避免用户最终看到 localhost callback 页
2. 可补 device code flow 作为 loopback callback 的 fallback

## 建议验证顺序

对后续联调，建议按下面顺序验证：

1. `linx login` 是否成功
2. 本地是否写入 `~/.linx`
3. `api.undefineds.co` 是否可解析 / 可访问
4. `linx models` 是否拿到 live `/v1/models`
5. `linx` TUI 中模型显示是否与 live `/models` 一致
6. `chat/completions` 是否真正用 LinX token 跑通

## 一句话总结

当前 LinX CLI / Pi TUI 的浏览器授权链路已经基本打通。

现在真正卡住的不是登录，而是 cloud runtime 域名 `api.undefineds.co` 在真实环境中的可达性，以及登录成功后的 runtime 真相对齐。
