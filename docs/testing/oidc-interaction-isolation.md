# OIDC interaction 与宿主 Session 回归

## 边界

宿主路由共用 SessionProvider、Session 和 authenticated fetch。独立浏览器文档则可以各自进行 OIDC 授权，不能用宿主全局锁禁止并发。

CSS 的固定 Account interaction 入口会让同名 Cookie 落在同一路径。Xpod 用上游 IdInteractionRoute 为每条交互提供 `/.account/interaction/<uid>/`，让 oidc-provider 原生 Cookie Path 隔离。服务端先执行原生签名、有效期、session principal 校验，再比较 UID 并映射到既有 Account 路由。Account 权限不会由 WebID 状态代替。

前端从当前 URL 派生路由作用域，不将它存入共享 localStorage，不改变 canonical Account authority。原生 resume 可能产生新 UID，后续操作必须跟随其返回的新路径。

## 可重复运行的样例

已有构建产物准备好后运行：

```sh
bun run test:integration:auth
```

本机使用已安装的 Chrome：

```sh
XPOD_PLAYWRIGHT_SYSTEM_CHROME=1 bun run test:integration:auth
```

该入口强制 `XPOD_E2E_REAL_POD=1`：启动隔离的真实 Xpod Gateway、CSS/OIDC、native Pod，使用真实 Inrupt SDK。不是当前用户3000实例验收，也不代表真实外部AI。故障恢复场景有明确的HTTP/Storage故障注入。

`tests/e2e/shared-login.spec.ts` 包括：

- 同源双标签 A→B、B→A 完成各自授权与PKCE回调。
- 取消 A 后 B 仍可完成。
- 缺失交互Cookie、将 B 的有效Cookie用在 A 路径、篡改原生Cookie签名时拒绝，且原事务未被消费。
- WebID 已登录、Account 匿名时，Status 保留导航但不展示受保护内容；返回 AI Connections 仍用原会话。
- 原有登录、注册/首Pod续接、刷新、拒绝授权、回调重放与退出恢复。

`tests/identity/ValidatingIdentityProviderHttpHandler.test.ts` 另以组件测试覆盖缺签名、失效、principal变化及UID不匹配时禁止进入Account handler；这部分使用mock，不替代上述真实浏览器校验。

`bun run test:integration` 仍是既有后台混合集成套件；浏览器认证套件有独立入口，不能把后台套件通过当作浏览器链路通过。

## 干净安装中的补丁校验

0.4.6 候选的首次真实浏览器验收发现，手写 CSS patch 的第二段错误使用了已插入第一段后的行号：`-270,+274`。Bun 安装后，`config.interactions.url` 仍调用不带 UID 的 `getPath()`，新增代码却落入 `config.routes`，首次授权返回 `Missing interactionId`。已有工作区安装状态不能证明干净安装正确。

补丁现在从 CSS 8.0.0-alpha.1 原始发行文件生成，第二段为 `-266,+270`。通过包管理器重新安装后，整个安装文件必须与“原始文件 + 声明变更”的预期结果逐字节一致，并实际执行 `configureRoutes().interactions.url(_, { uid })` 检查对应 scoped 路径；在源码中搜索到 `interactionId` 不足以证明补丁生效。不得直接修改 node_modules 来通过验收。

还需在正式分发的包中重复行为验收；源码安装通过不能替代 npm 包或容器的消费者验证。
