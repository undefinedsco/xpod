# 账号记忆、应用授权与 Consent 卡片

## 身份边界

桌面应用在登录前就拥有固定 `client_id`：
`https://id.undefineds.co/app/xpod-desktop-client.json`。
公开注册文档位于 `ui/public/xpod-desktop-client.json`，随 Account 静态资源发布。
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

重新选择 WebID 时，`ScopedPickWebIdHandler` 只对当前固定应用已验证的记忆 grant 清除会话绑定并保留 grant；其他情况沿用 CSS 的清除行为。切换账号后仍按新账号独立查找授权，不能复用上一账号的 grant。

## 卡片

Account 文档采用最大 448px 的单列卡片。Consent 的“记住应用”是左侧复选框加文字，批准/拒绝并排。真实 Chrome 布局测试覆盖 1440/768/390px、480×640 桌面窗口和较长的节点 WebID；测试同时检查按钮可见、无横向溢出和复选框可操作。

## 发布与验收

服务端授权策略和公开 client metadata 必须先发布，再交付依赖它们的桌面版本。只更新本机 runtime 不会替换 `id.undefineds.co` 提供的 Account/Consent 文档。公共 ID 一旦发布保持稳定，不按版本生成新 URL。

发布遵循 [RC 与正式发布流程](RELEASE.md)，不得直接改容器内静态文件。源代码/隔离测试通过不等于云端生效，实际验收应逐项记录：

1. 记住账号后退出进程再启动，无须重输账号密码；不记住账号和显式退出的行为不被改变。
2. 首次勾选记住应用后再次登录，同一 `client_id`、无动态注册、无重复 consent；强制一次静默恢复失败后重验。
3. 不记住、撤销、过期或新权限仍要求授权，不跨账号复用。
4. 实际云端 Account bundle 和固定 metadata 已更新，480×640 窗口中 consent 操作可见。

本文件描述实现契约；具体执行结果以当次验收记录为准，不能据此声称已发布。
