# 账号记忆、应用授权与 Consent 卡片

## 身份边界

桌面应用在登录前就拥有固定 `client_id`：
`https://id.undefineds.co/app/xpod-desktop-client.json`。
唯一客户端声明位于 `src/identity/oidc/xpod-desktop-client.json`；共用 Provider factory 将它静态注册，Vite 从同一源生成公开注册文档，随 Account 静态资源发布。UI 的固定 client ID 也从该声明读取，Standalone 不再依赖公网下载自己的客户端元数据。
应用身份不从用户 Pod、浏览器存储、用户会话或节点注册状态推导；退出、换账号、清理会话和版本升级不产生新应用注册。

文档声明 native public client、授权码流程和 loopback `/auth/callback`。IdP 原生处理本机端口变化；不允许任意远端域名或其他回调路径，继续要求 PKCE 和 DPoP。不能为了消除重复 consent 把桌面应用声明成 web client。

`XpodSolidRuntimeProvider` 在 Desktop bridge 宿主中始终向 Inrupt 传固定 ID，删除 SDK 自动添加的默认 `prompt=consent`，保留用户显式 prompt 和 provisioning scope。此前读取/捕获/恢复用户 session 中注册数据的补偿逻辑已删除，保留真实 SDK sessionId 与宿主指针对齐、失效令牌清理。非桌面 Web 宿主的注册方式不属于本轮变更。

## 记住账号

CSS 服务端决定账号 Cookie 是否持久、何时到期。前端 `storeAccountSessionToken` 收到与当前 Cookie 相同的 token 时不再重写 Cookie，避免把服务端的持久 Cookie 降为会话 Cookie。

跨域 JSON 登录仍保留原有本地会话 Cookie 桥；它不复制服务端凭据有效期，也不擅自延长登录。用户不记住账号时不会被客户端升级为持久登录。退出清除 Cookie 及历史 token 副本。

## 记住应用

应用身份与用户对应用的授权是两件事。授权由 IdP 管理，绑定已认证 WebID、固定 client ID 和实际 grant。

原 CSS `remember` 只影响 `offline_access`，不能据此可靠判断用户是否要求复用授权。`RememberedConsentHandler` 装饰现有 CSS ConsentHandler，在原流程成功后保存或取消明确的记忆记录；其他应用沿用原行为。

`RememberedClientGrantStore` 在服务端既有内部存储维护 account/client 到实际 grant 的单一权威记录，记录 TTL 不超过实际 grant 的期限。复用时重新读取 grant，核对 owner、client、期限及撤销状态，不能仅凭索引或浏览器传入的 WebID 放行。

`RememberedClientPromptFactory` 保留默认账号 Cookie 和 WebID 归属检查，在 login 之后、consent 之前恢复记住的有效 grant。随后仅对已明确记住的 Xpod Desktop grant 免除重复 native 提示；首次、未记住、已撤销、过期、换账号、新增权限或显式 `prompt=consent` 仍须交互。当前刚提交的 consent 优先，不用旧记录覆盖新选择。

刚过期的 grant 可能仍处于 Provider 的时钟容差内；此时进入 consent 前创建新的无 scope grant，不修改旧 grant 的到期时间。产品 `config/main.json` 的容差为 120 秒，协议回归夹具使用默认 15 秒，并分别验证容差内刚过期与容差外过期；二者都必须重新确认，不能靠容差恢复旧权限。

若用户已经打开同意页面，旧 grant 在提交前才过期，`RememberedConsentHandler` 会返回 Provider 重新计算授权要求，再展示新的同意页。首次提交不自动批准新增权限；第二次明确同意后才产生新授权，拒绝则不兑换 token、不记住授权。这也覆盖存储已清理、无法再查到旧 grant 的情况。

重新选择 WebID 时，`ScopedPickWebIdHandler` 只对当前固定应用已验证的记忆 grant 清除会话绑定并保留 grant；其他情况沿用 CSS 的清除行为。切换账号后仍按新账号独立查找授权，不能复用上一账号的 grant。

## 授权跳转边界

账号 Cookie、当前 OIDC interaction 和应用 SDK Session 是三个不同状态。
账号已登录并不代表当前 interaction 已完成，也不代表本机 SDK 已收到授权码。

| 当前状态 | 动作及响应 | 下一步负责方 |
| --- | --- | --- |
| 未登录账号 | 在当前 interaction 内登录或注册 | Account 回到同一 interaction，不能丢弃它进入 Dashboard |
| 已登录，尚未选 WebID | POST pick-webid，得到 JSON location | 浏览器顶层导航到 location，并结束当前页面提交 |
| native resume | IdP 校验身份、grant 和所需权限 | 返回新的 consent，或跳转 SDK callback |
| 需要用户授权 | 用户批准后 POST consent，得到 JSON location | 浏览器顶层导航；不能再次提交旧 interaction |
| 收到 callback | Inrupt 校验 state/PKCE 并交换 token | 宿主既有 SessionProvider 恢复原入口 |
| 服务不可达 | 显示重连，保留 Session | 服务恢复后继续；不将网络失败当成退出登录 |

pick-webid 的 location 不能再由 fetch 请求：其后可能跨 origin 跳到本机
callback，浏览器会阻止 AJAX 读取，且 SDK callback 文档不会运行。跨 origin
是 native loopback 登录的正常边界，不能通过放宽 CORS 或增加 Session 副本修复。
pick 成功但未返回有效 location 时必须停止，不得继续 POST 已完成的旧 consent。

回归必须覆盖已记住授权直接回 callback，以及新增权限需要再次 consent 两条分支。
发布验收同时核对云端 Account bundle；本机源码或桌面包更新不会自动更新云端页面。
RC 部署前运行 `ConsentResume` / `ConsentRetry` 产品页面回归，以及
`tests/e2e/consent-cross-origin-resume.spec.ts` 的真实浏览器协议回归。
后者使用真实 HTTP、oidc-provider 和 WebID picker，账号归属与展示 HTML 是夹具，
不替代已部署云端账号的验收；它也纳入 `test:integration:auth`。

## 取消卡住的桌面登录

桌面原生“取消登录并返回 Xpod”入口不依赖授权网页的 JavaScript。它停止当前导航，回到本机产品入口并携带 `xpod-login=cancelled`；产品页消费该意图，仅取消当前标签页的待完成交易，清除旧返回地址，并等待用户手动继续。当前 origin 的取消偏好跨刷新和应用重启保留，显式继续登录后清除；它不是会话锁，不阻止已有有效 Session，也不影响其他设备。

关闭授权窗口应先返回上述恢复入口再隐藏；普通工作区关闭仍保留窗口。系统 Quit 正常退出进程并清理桌面拥有的 runtime，不调用 Account 或 Solid logout。取消、退出都不手动删除 Inrupt 的凭据或 PKCE 数据。

自动化验收入口为 `node desktop/scripts/login-recovery-acceptance.mjs`，使用真实 Electron 与 HTTP 夹具验证原生取消、关闭后重开、网页阻止卸载和真正退出。夹具结果不替代当前安装包及云端登录验收。

## 在线会话续期

免重复授权的请求不带 `prompt=consent`，oidc-provider 会移除 `offline_access`；默认策略因此不签发 refresh token。只验证授权码交换成功会漏掉此问题：短期 access token 到期后，浏览器 SDK 会直接报告会话过期，即使账号 Cookie 和应用授权仍有效。

`SessionBoundIdentityProviderFactory` 使用提供方正式的 `issueRefreshToken` hook，仅允许固定 Desktop client 为 `expiresWithSession=true` 的授权码获取在线 refresh token，仍要求客户端允许 `refresh_token` grant。其他客户端保留默认 offline scope 条件，显式自定义策略优先。它不增加权限、不延长 TTL，也不修改 `expiresWithSession`；提供方继续校验 grant 和原会话，并在会话或授权失效时拒绝刷新。

CSS 的配置 JSON 深拷贝会丢失函数，因此 Bun 包补丁仅保留这个发行 hook。升级 CSS 时必须重验该边界。设计依据见 [oidc-provider 9.5.1 的 issueRefreshToken](https://github.com/panva/node-oidc-provider/blob/v9.5.1/docs/README.md#issuerefreshtoken) 与 [expiresWithSession](https://github.com/panva/node-oidc-provider/blob/v9.5.1/docs/README.md#expireswithsession)。

Bun 原生包中的 Xpod 工厂继承已打包的同一 CSS 入口，确保提供方 policy 与默认 Account prompt 的类身份一致；不能分别内联两份依赖后仅用源码测试代替原生启动验收。

## 卡片

Account 文档采用最大 448px 的单列卡片。Consent 的“记住应用”是左侧复选框加文字，批准/拒绝并排。真实 Chrome 布局测试覆盖 1440/768/390px、480×640 桌面窗口和较长的节点 WebID；测试同时检查按钮可见、无横向溢出和复选框可操作。

## 发布与验收

服务端授权策略和公开 client metadata 必须先发布，再交付依赖它们的桌面版本。只更新本机 runtime 不会替换 `id.undefineds.co` 提供的 Account/Consent 文档。公共 ID 一旦发布保持稳定，不按版本生成新 URL。

发布遵循 [RC 与正式发布流程](RELEASE.md)，不得直接改容器内静态文件。源代码/隔离测试通过不等于云端生效，实际验收应逐项记录：

1. 记住账号后退出进程再启动，无须重输账号密码；不记住账号和显式退出的行为不被改变。
2. 首次勾选记住应用后再次登录，同一 `client_id`、无动态注册、无重复 consent；强制一次静默恢复失败后重验。
3. 不记住、撤销、过期或新权限仍要求授权，不跨账号复用。
4. 实际云端 Account bundle 和固定 metadata 已更新，480×640 窗口中 consent 操作可见。
5. 普通恢复登录获取 refresh token，并能连续刷新；短有效期真实 SDK 验收须证明空闲时自动续期后仍可访问 Pod，不能只检查 callback 或模拟到期事件。

本文件描述实现契约；具体执行结果以当次验收记录为准，不能据此声称已发布。
