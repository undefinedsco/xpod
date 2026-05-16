# TUI / CLI Authorization Path

## 背景

当前系统已经具备面向浏览器页面的 OIDC / consent 流：

- `/.account/login/*`
- `/.account/oidc/consent/`

这些路径对 Web 页面是成立的，但它们**不等于**已经为 TUI / CLI 设计好了授权路径。

在实际联调中，LinX CLI / Pi TUI 想做“进入 TUI 后直接触发浏览器授权”，发起的授权请求类似：

```text
https://id.undefineds.co/.oidc/auth?...&redirect_uri=http://127.0.0.1:61226/auth/callback&...
```

服务端返回：

```text
invalid_redirect_uri
```

这说明当前 Identity / CSS 侧**没有接受 TUI/CLI 常用的本地 loopback callback**，因此浏览器授权虽然被拉起，但无法完成回跳。

## 结论

问题的根源不是“TUI 没页面”这么简单，而是：

1. **当前 OIDC 产品化路径是按 Web 页面设计的**
2. **没有为纯终端 / TUI 明确设计一条授权完成路径**
3. **服务端当前拒绝了本地 loopback callback**

所以现状是：

- Web 页面可以走 `/.account/oidc/consent/`
- 但 TUI / CLI 无法完成同一条授权闭环

## 为什么 TUI 不能直接复用 Web consent 页面

### Web 页面模型

Web 页面对 OIDC 的默认假设是：

1. 当前应用自身有浏览器上下文
2. 有一个稳定可回跳的页面 URL
3. 授权完成后，IdP 重定向回这个 URL
4. 前端页面继续处理 state/code

### TUI / CLI 模型

TUI / CLI 没有这些天然前提：

1. 没有内嵌浏览器上下文
2. 没有天然固定的回调页面
3. 用户看到的是终端，不是单页应用
4. 若要走浏览器授权，必须额外设计“如何把浏览器结果带回终端”

所以：

- **有浏览器 consent 页面**
- **不代表 TUI/CLI 有授权完成路径**

## 业界常见做法

### 方案 A：Loopback callback（最常见）

这是目前多数 CLI 最常见方案。

流程：

1. CLI 起本地 HTTP server（随机端口）
2. 打开系统浏览器
3. 浏览器授权完成后回跳 `http://127.0.0.1:<port>/callback`
4. CLI 收到回调并完成登录

优点：

- 体验最好
- 用户几乎不需要额外理解
- 适合本地开发机 / 桌面场景

缺点：

- IdP 必须允许 `127.0.0.1` / `localhost` callback
- 若 redirect URI 校验策略太严格，会像现在这样直接失败

### 方案 B：Device Code Flow（最稳妥）

这是 CLI/TUI 第二常见方案。

流程：

1. CLI 向服务端申请 `device_code`
2. CLI 显示短码与浏览器访问地址
3. 用户在浏览器确认
4. CLI 定期轮询 token endpoint
5. 授权完成后获得 token

优点：

- 不需要本地回调地址
- 非常适合纯终端
- 不依赖 localhost redirect 策略

缺点：

- 用户体验比 loopback 略笨
- 需要服务端明确支持 device authorization grant

### 方案 C：固定 HTTPS callback bridge

流程：

1. 浏览器授权完成后跳回固定的服务端 callback 页面
2. 服务端把授权结果短期暂存
3. CLI/TUI 通过 polling / one-shot token exchange 取回结果

优点：

- 不需要 localhost callback
- 仍可保持“点击浏览器登录”的体验

缺点：

- 服务端复杂度更高
- 需要额外的临时状态管理

### 方案 D：手动粘贴 callback URL / code

流程：

1. CLI 打开浏览器
2. 浏览器完成授权后停在某个页面
3. 用户把最终 URL / code 粘回终端

优点：

- 很容易作为 fallback

缺点：

- 用户体验最差
- 不应作为主路径

## 当前 Xpod 的缺口

### 已经有的能力

1. 浏览器端账号/consent 页面
2. OIDC / account 路由
3. 面向 Web 的授权流程

### 缺失的能力

1. **接受 CLI/TUI 的 localhost redirect URI**
2. 或 **提供 device code flow**
3. 或 **提供固定 callback bridge**

这意味着当前系统并不是“没有授权”，而是：

- **没有面向 TUI/CLI 的授权完成机制**

## 联调证据

在当前联调中，CLI/TUI 发出的授权请求为：

```text
redirect_uri=http://127.0.0.1:<random-port>/auth/callback
```

服务端返回：

```text
invalid_redirect_uri
```

这可以直接推断：

1. CLI 走的是标准 Authorization Code + PKCE
2. CLI 用的是标准 loopback callback 模式
3. 服务端当前不接受该 redirect URI

因此问题不在 CLI 是否“瞎写路径”，而在服务端 redirect policy 没覆盖 TUI 场景。

## 建议路线

### P0：先支持 localhost / loopback callback

目标：

- 允许 `http://127.0.0.1:<port>/auth/callback`
- 允许 `http://localhost:<port>/auth/callback`

要求：

1. 端口可变，不应要求预注册所有端口
2. host 至少支持：
   - `127.0.0.1`
   - `localhost`
3. path 可先固定为：
   - `/auth/callback`

这是把当前 CLI/TUI 授权链打通的最低成本路径。

### P1：补 device code flow

这是更健壮的 TUI 方案。

适用：

- 远程 SSH
- 无法打开本地浏览器
- localhost redirect 被策略或网络环境限制

### P2：再考虑 callback bridge

如果未来还要支持：

- 纯 headless
- 多设备授权接力
- 本地禁止开端口环境

可补服务端 bridge 模式。

## 对服务端实现的具体要求

### 1. Redirect URI 策略

当前需要新增一类合法 redirect URI 规则：

- `http://127.0.0.1:{port}/auth/callback`
- `http://localhost:{port}/auth/callback`

不要把它们与普通 Web SPA callback 混在一起做静态白名单。

应新增“CLI loopback redirect”专门规则。

### 2. OIDC metadata / client registration 行为

若系统使用动态注册或 client 文档机制，需要确认：

1. loopback redirect 是否允许写入 `redirect_uris`
2. 若校验时不允许任意端口，需要提供明确的规则支持
3. 错误响应不能只给 `invalid_redirect_uri`，还应附带可定位信息

### 3. 错误语义

对 CLI/TUI 场景，建议返回更明确错误，例如：

```json
{
  "error": "invalid_redirect_uri",
  "message": "Loopback redirect URIs are not enabled for this identity provider."
}
```

而不是只给泛化的 Bad Request。

## UI / 产品建议

### 交互 TUI

进入 TUI 后，如果未登录，产品上最合理的是：

1. 给用户一个显式选项
2. 用户确认后再打开浏览器
3. 授权完成回到 TUI

不应要求用户必须先理解 `/login` 命令，也不应在没有解释的情况下自动弹浏览器。

### 非交互模式

例如：

```bash
linx --print "..."
```

这种模式没有交互 UI，就不能在中途要求用户完成授权。

因此合理行为是：

1. 若已有登录态，直接用
2. 若没有登录态，明确报错并提示先登录

这部分不需要服务端额外改动，只需要客户端做体验区分。

## 验收标准

### 场景 1：本地桌面 CLI / TUI

1. 用户启动 TUI
2. 选择登录
3. 浏览器打开授权页
4. 授权完成后回跳 `127.0.0.1` callback
5. TUI 获得 token 并继续工作

### 场景 2：无 localhost callback

1. 若 loopback redirect 未启用
2. 服务端明确返回可理解错误
3. 产品可 fallback 到 device code（若实现）

### 场景 3：纯 Web 页面

现有 `/.account/oidc/consent/` 流程继续工作，不受 CLI redirect 策略变更影响。

## 建议涉及的模块

### 服务端 / OIDC / identity

- redirect URI 校验逻辑所在模块
- client registration / authorization request 校验模块
- 相关错误响应构造模块

### 文档

- account / identity / OIDC 文档
- CLI/TUI 集成文档
- 若引入 device code，还需新增单独说明

## 一句话总结

当前 Xpod / CSS 有 **Web 授权路径**，但没有真正完成 **TUI/CLI 授权产品化**。  
短期最优先是：**支持 localhost loopback redirect URI**。  
中期最稳妥是：**补 device code flow 作为 fallback**。

