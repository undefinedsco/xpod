# 微信网站登录与本地联调

身份绑定已收敛到独立扩展表，字段、CSS adapter 与升级步骤见
[外部身份扩展表设计](external-login-storage.md)。以下测试证据保留原实现时的记录，新存储验收需另行记录。

实现分支：`codex/wechat-login`，基于 `origin/staging` 的 `9b64a697`。更新：2026-10-26。

使用 `@logto/connector-wechat-web@1.6.6`，Logto 只作为连接器供应商。保持 Xpod 单进程，连接器通过工厂创建，负责微信授权地址、换码和用户信息；账号、会话、remember、OIDC interaction 和 Pod Consent 仍由现有 CSS 链路管理。职责与插件接入方式见 [连接器工厂适配](external-login-connectors.md)。

## 支持范围

- 网站应用扫码登录，顶层跳转微信授权页，scope 为 `snsapi_login`。
- 已绑定微信登录原账号；首次使用必须明确选择“创建账号”，不会把登录悄悄变成注册。
- 在已登录账号页绑定或解绑微信；不按昵称、头像或邮箱自动合并账号。
- 默认不开启。账号 authority 同时配置 AppID、AppSecret 后才公布能力，前端根据同一份 capability 渲染。
- Managed Local 配置外部 issuer 时不启用本机微信连接器，继续委托原有账号 authority，不能把中央 AppSecret 分发到桌面设备。
- 微信登录本身不自动创建 Pod，不跳过 WebID、存储选择或 Consent。

公众号内网页授权、小程序登录、原生移动 SDK 不属于本期范围，其 AppID、scope 和回调约定不能混用。

## 接口与流程

所有接口属于 CSS 账号交互链，不增加另一套 API Server 登录系统，也不增加 `/start/` 路由。

| 接口 | 用途 |
| --- | --- |
| `POST /.account/login/wechat/` | 发起登录，JSON 包含 `intent`（`login` / `register` / `link`）、浏览器 `proof`、`remember`；返回 `authorizationUrl`、`state` 和完成回调地址 |
| `GET /.account/login/wechat/callback/` | 微信重定向返回的浏览器页面，不在 GET 中交换 code |
| `POST /.account/login/wechat/callback/` | 浏览器提交 `code`、`state`、`proof`，验证后完成 CSS 登录 |
| `DELETE /.account/login/wechat/` | 当前已认证账号解绑，沿用现有最后一种登录方式保护 |

路径相对规范 `baseUrl` 推导。来自 OIDC interaction 时，POST 完成地址使用原来的 `/.account/interaction/<uid>/login/wechat/callback/`，由 CSS 验证原 interaction cookie；交给微信的 `redirect_uri` 始终是固定规范回调。无需为每个 interaction 在微信后台添加回调。

1. 浏览器生成随机 proof，同源 JSON POST 发起事务。服务端生成随机一次性 state，记录意图、actor、interaction 和 remember。
2. proof 与回调关联保存在发起标签页的 `sessionStorage`。proof 是 Xpod 的浏览器事务关联机制，不是声称微信支持 PKCE。
3. 跳转连接器生成的微信网站授权页，用户扫码确认后携 code/state 返回固定回调页。
4. 回调页在异步工作前清除地址栏查询参数，原子删除标签页记录，再向原完成回调 POST。服务端验证摘要、有效期、provider、回调、actor、interaction，并原子消费事务后才调用连接器。
5. 使用固定 `provider + AppID + OpenID` 直接查询扩展表中的账号绑定。UnionID 仅作可选元数据，不使用 Logto 的 `unionid ?? openid` 作为持久绑定主键。
6. 通过 `ResolveLoginHandler` 建立或轮换原账号 cookie，处理 remember 并恢复原 OIDC interaction。绑定不改变原账号的 remember 选择。

## 实现归属

- `src/identity/external/ExternalLoginProvider.ts`：Xpod 统一接口，不依赖连接器供应商。
- `ExternalLoginProviderFactory.ts`：根据已注册连接器工厂与应用入口声明创建 provider；拒绝未知连接器、重复注册和非法入口。
- `LogtoSocialConnectorAdapter.ts`：供应商适配、稳定身份字段声明、初始化和错误脱敏；包含微信网站连接器工厂注册。
- `externalLoginProviders.ts`：供应商装配与部署凭据到入口声明的唯一转换入口。UI 不按 provider 身份分支。
- `ExternalLoginRepository.ts`：身份库中的短期授权事务，支持 SQLite、PostgreSQL。
- `ExternalIdentityStorage.ts` / `ExternalIdentityAccountStorage.ts`：独立身份表、CSS 存储适配与事务协调。
- `ExternalLoginService.ts`：事务校验、账号绑定与注册、CSS 登录方式登记、解绑。
- `ExternalLoginHandler.ts`：复用 CSS route、能力发现和 `ResolveLoginHandler`。
- `config/external-login.json`：组件、路由、ENV extractor 和响应头映射，由 `xpod.base.json` 引入。
- UI：共享能力按钮、独立回调页、账号页绑定管理；保留原密码登录和注册。

## 存储与安全边界

认证元数据属于账号 identity DB，不是用户 Pod RDF，不新增共享 models schema。

- `identity_external_identities` 是绑定事实唯一权威；CSS 的 `external-login` 类型通过 adapter 读写该表，继续登记为登录方式并受原有账号策略保护。
- `identity_external_login_transactions` 保存 state/proof 的 SHA-256 摘要及上下文，10 分钟到期，使用 `DELETE ... RETURNING` 原子消费。
- 三元组唯一约束防止跨账号重复绑定；PG 使用事务级账号锁，SQLite 使用写事务协调。密码与外部登录的删除经过同一入口。
- `created_at`、`updated_at` 由服务端生成；普通登录及重复绑定不修改时间。旧 JSON 绑定和辅助索引按升级流程迁移并清理。
- actor 不由前端指定账号 ID。绑定/解绑要求已认证账号上下文；同源 JSON、浏览器 proof、CSS 原有请求认证和 interaction 校验共同约束流程。`ExternalLoginRequestGuard` 在 HTTP 元数据解析层拒绝浏览器跨来源修改请求（包括同站兄弟子域），允许微信返回的 GET 页面和不带浏览器头的原有 CLI 认证方式。
- 回调响应禁止缓存并设置 `Referrer-Policy: no-referrer`；HTML 在资源加载前声明同样策略。应用代码不记录 code、微信 token、AppSecret；上游错误转为无 URL/凭据的固定错误。
- 其他浏览器/标签页不能完成此事务；重复回调不重复换码。失败页提供重试入口，已知原 interaction 时保留其密码登录地址。

## 配置与本地真实联调

只新增两个部署方 ENV 输入，不能传到前端，也不作为 CLI 参数：

```dotenv
XPOD_WECHAT_APP_ID=<微信开放平台网站应用 AppID>
XPOD_WECHAT_APP_SECRET=<仅在后端配置的 AppSecret>
```

现有输入无法推导部署者的微信应用凭据，因此需部署者提供；回调从 `baseUrl` 推导，不新增重复配置键。缺一个配置时启动报错；都未配置则关闭。

真实扫码需要：

1. 微信开放平台审核通过的网站应用和微信登录权限，不能用公众号/小程序测试账号替代。
2. AppID、AppSecret，通过未跟踪的秘密文件或秘密存储配置，不发到聊天或提交 Git。
3. 微信后台授权域名匹配的固定开发域名，建议可信 HTTPS。反向代理或固定隧道将账号页、回调、OIDC 入口一起转到本地 Gateway，保持同源 cookie 和规范 URL。
4. 可写身份存储、测试账号/Pod、微信号与手机；后端可访问微信 API，浏览器可访问微信授权页。

网站授权回调是原浏览器导航，不是微信推送的 webhook。不能假设 localhost、随机隧道域名或 file:// 页面能用于完整验收。

## 测试证据与限制

本次使用隔离安装的受支持 Bun 1.4.2，未修改系统 Bun。macOS 构建设置 `COPYFILE_DISABLE=1`，避免 tar 添加 AppleDouble 元数据而触发原有发布清单校验，未削弱校验。

- 通过：后端 TypeScript、Components.js 生成、测试 TypeScript、app/dashboard/settings 三套 UI 构建。
- 专项 8 个文件共 41 项通过，覆盖真实 SQLite/CSS 存储、一次性事务、错误 proof、过期、并发 reservation、actor/interaction 变更、显式注册、绑定冲突、解绑保护、remember/cookie、interaction 完成和跨来源请求防护。协议测试用实际发布连接器，仅替换 HTTP 传输。
- 独立 Gateway HTTP 测试已通过：fixture AppID/Secret 下能力发现、授权 URL、原密码能力、回调 HTML/防缓存头、错误 proof 拒绝、匿名解绑拒绝。没有向微信换码。
- 完整 `bun run test:integration` 修复后两轮均通过并自然退出（退出码均为 0）：每轮 runtime 前置 30 项通过，lite 164 项通过 / 16 项跳过（含新增 Gateway 边界测试），full 63 项通过。两轮均保留本机原有 issuer/Redis 环境，没有依赖命令行清除这些值，且无 Redis NOAUTH 错误。
- 原先 full 的 9 项失败已确认是测试启动器环境隔离缺陷：两个 Cloud 没有明确指定各自的 issuer，继承开发机的外部 `SOLID_OIDC_ISSUER` 后，被正确的账号 authority 检查拒绝；两个 Local 还继承了外部 Redis，导致 NOAUTH 重试。仅清除测试进程这几项环境值、不改产品代码的对照实验即为 full 63 项通过、退出码 0。修复位于 `scripts/run-integration-full.ts`：显式声明各节点 issuer，Local/Standalone 关闭外部 Redis；没有放宽权限检查、重试失败用例或跳过断言。
- 新增两项启动器环境污染回归用例，旧代码下均失败、修复后均通过；启动器相关 58 项与微信相关 41 项合计 99 项通过，测试类型检查通过。测试结束后只清理本次创建的隔离实例和容器，不操作既有 Docker 服务。
- 浏览器检查状态：DONE_WITH_CONCERNS。在临时本地 Gateway 上用实际 Chromium 点击登录/注册切换、微信入口、失败回调和返回登录；确认顶层跳转到微信授权 URL，回调立即移除 code/state 查询串。仅使用 fixture AppID，没有真实扫码或换码。控制台没有新增 JS 异常，但原有无 element 的密码路由有 React Router 警告：`Matched leaf route at location "/.account/login/password/" does not have an element or Component. This means it will render an <Outlet /> with a null value by default resulting in an "empty" page.` 注册路由有同类警告；实际密码表单由外层 PasswordEntryHost 正常渲染。
- 未验收：真实微信扫码、真实应用换码、当前实际运行 Gateway 的用户/Pod 全链路、桌面系统浏览器回跳。未配置真实应用凭据或代用户扫码。

自动化门禁通过不替代上述真实联调。发布前仍须独立验收真实微信登录、账号会话、WebID/Consent 和 Pod 读写。AI 的 Pod 读写、Gateway 客户端认证、models 列表、真实 Chat 请求是四层独立验收，本次不声称 AI 链路通过。

## 官方依据

- [Logto 微信网站连接器](https://docs.logto.io/integrations/wechat-web)，发布包许可 MPL-2.0；通过依赖复用，未修改连接器源码。
- [微信网站应用登录指南](https://developers.weixin.qq.com/doc/oplatform/Website_App/WeChat_Login/Wechat_Login.html)。应用资质、审核、域名、权限以开放平台后台实际要求为准。
