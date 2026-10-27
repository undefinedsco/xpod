# 快捷登录连接器与工厂适配

更新：2026-10-26。部署形态保持 Xpod 单进程；Logto 作为连接器供应商。

## 职责

| 层级 | 职责 |
| --- | --- |
| 连接器供应商 | 实现第三方授权地址、换码、用户信息协议；当前使用固定版本的 Logto 微信网站连接器 |
| `LogtoSocialConnectorAdapter` | 适配供应商接口，按声明提取稳定身份，管理连接器初始化，统一脱敏错误 |
| `ExternalLoginProviderFactory` | 根据连接器注册和登录入口声明创建统一的 `ExternalLoginProvider` |
| `ExternalLoginService` | Xpod 浏览器事务、显式注册、登录、绑定和解绑 |
| `ExternalIdentityAccountStorage` | `identity_external_identities` 与原 CSS 账号存储的事务协调 |
| CSS | 账号 cookie、remember、Solid OIDC interaction、WebID 与 Pod Consent |

项目不接入 Logto 用户库、OIDC 服务、账号 API 或管理控制台，不要求额外的 Logto endpoint、
AppID 或 AppSecret。现有 `XPOD_WECHAT_APP_ID` / `XPOD_WECHAT_APP_SECRET` 指微信应用凭据。
复用连接器不会自动引入供应商认证服务的 MFA、SSO 或用户管理能力。

## 创建路径与注册

`externalLoginProviders.ts` 是程序装配入口：选择随程序发布的连接器工厂，
并将现有部署凭据转换为登录入口声明。所有供应商通过相同工厂接口注册；
业务服务和 UI 不根据平台身份选择协议实现。

```text
部署配置 → 登录入口声明 → ExternalLoginProviderFactory
                         → 已注册连接器工厂
                         → ExternalLoginProvider
                         → ExternalLoginService → CSS
```

每个连接器工厂实现 `ExternalLoginConnectorFactory`：注册唯一 `id`，实现 `create(entry)`。
每个入口声明包含唯一 `id`、`connector`、可选展示名 `name` 和私有 `config`。
工厂拒绝重复注册、未知连接器和非法入口 ID；登录服务拒绝重复入口 ID。
供应商专有配置校验及身份契约留在该连接器工厂内。

`ExternalLoginService.registerConnector()` / `registerProvider()` 使用相同工厂路径提供程序侧扩展。
它们不是用户管理 API；连接器支持范围和应用凭据不能写进用户 Pod。
默认网站微信入口仍为 `wechat`，既有路由和身份绑定无需重命名。

例如，在程序装配处增加第二个网站应用：

```ts
service.registerProvider({
  id: 'wechat-second',
  connector: 'logto-wechat-web',
  name: '第二个网站微信',
  config: { appId: secondAppId, appSecret: secondAppSecret },
});
```

默认 ENV 装配仍只启用一个微信网站应用；多应用通过程序侧声明接入，没有新增环境变量或用户配置入口。
Managed Local 使用外部账号 authority 时，即使通过程序注册也拒绝启用本机登录入口。

## 通用适配面的边界

`ExternalLoginProvider` 使用授权地址生成和授权码身份验证两个方法。
通用 Logto 适配器覆盖使用 `getAuthorizationUri({state, redirectUri})` 与
`getUserInfo({code})` 的社交连接器；身份字段可以声明取自标准 profile（如 `id`）
或原始 `rawData`（如 `openid`），并可声明可选 UnionID。

连接器实例在首次调用时初始化，同一入口的并发调用共享同一实例；初始化失败不缓存失败结果。
授权地址、换码和初始化错误都转换为固定错误，不传播含凭据的供应商 URL 或异常文本。
不自动将 `unionid`、昵称、邮箱等字段替代缺失的主身份。

微信网站插件声明 `provider = wechat`、`namespace = AppID`、`subject = rawData.openid`。
namespace 从该连接器的凭据推导，部署者不用重复提供。可选 UnionID 只作为元数据。

需要额外验证数据、客户端 SDK 或不同授权握手的协议不能直接套用此通用适配器。
这类插件仍实现同一个 Xpod 接口，经工厂注册；必要时先扩展公共请求契约，
不得在登录服务或 UI 中追加平台专有换码分支。

## 三个标识各司其职

| 标识 | 示例 | 用途 |
| --- | --- | --- |
| 入口 `id` | `wechat` / `wechat-second` | 路由、能力发现、浏览器授权事务 |
| 连接器 `connector` | `logto-wechat-web` | 选择协议实现及供应商 |
| 身份键 | `wechat + AppID + OpenID` | 扩展表绑定现有 accountId |

两个网站应用可以引用同一个连接器，各有入口 ID 和 AppID；不会相互覆盖。
同一账号可绑定两条不同 namespace 的身份，解绑只影响所选入口的 namespace。
授权回调必须匹配最初的入口 ID，不能提交到同平台的另一个入口。

换供应商不会自动改变持久身份键；确需变化时必须设计显式迁移。
账号、WebID、Pod 的标识继续沿用现有值，绑定表详见 [外部身份存储](external-login-storage.md)。

## 已修复的审查问题

- 共享 SQLite 事务原先只协调原生 SQL 辅助函数，直接 ORM 操作可能被其他请求的事务回滚。
  统一 `executeIdentityOperation` 后，现有服务令牌、DDNS、节点能力、Pod 接口密钥和用量仓储
  使用相同执行边界；PG ORM 操作也进入当前事务连接。
- 用量仓储使用统一异步事务入口，避免 SQLite 同步事务回调提前提交。
- 入口 ID 与身份提供方分离，并拒绝重复注册，消除同平台多应用入口覆盖。
- 连接器构造与供应商 API 调用统一收敛到工厂和适配层。

## 验证范围

专项回归覆盖实际发布的微信连接器（替换 HTTP 传输）、多应用入口、跨入口回调拒绝、
稳定身份提取、初始化共享与失败恢复、错误脱敏、CSS 会话及事务隔离。
PG 回归验证真实仓储 ORM 写入随当前事务回滚，而独立请求成功写入不受影响。

QQ、微信小程序仍需各自的连接器与真实客户端验收；当前工厂扩展能力不等于这些协议已实现。
完整集成结果记录在 [外部身份存储](external-login-storage.md)；隔离测试不替代真实扫码与实际 Pod 验收。
