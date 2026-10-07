# Account host 会话授权边界（前提撤回，暂缓）

> 用户确认 Cloud/managed Local 的独立 `profile/card` 文档始终托管在 Cloud，用于身份与 Pod 发现；数据存储位置不改变 card 的归属。本文件下述设计基于 Local profile 拓扑，不能作为无公网 Local 的发布契约；Draft PR #29 暂缓。正确契约见共享登录 spec §13.14，应先修复 profile 与 Local storage 的预配归属。保留本文供原方案审计，不据此降低资源验证或迁移既有用户身份。

中央 IdP 管理自己的 Account 时，权威证据是它自身签发的 host 会话与当前 Account/WebID 关联。Pod 资源服务器判断一个外部 issuer 能否代表 WebID 时，权威证据仍是 WebID profile 中的 `solid:oidcIssuer`。这两个验证目的应当分开。

已撤回的诊断前提是：错误 Local-profile 拓扑下，本机 Gateway 可访问 Pod，而中央读取该 Local 公网 profile 失败，Account controls 因而不暴露客户端凭据入口。这是当时实现行为的历史分析，不能作为产品设计：正确架构中的 card 始终由 Cloud 托管，Local 数据入口关闭不应让它不可达。下面保留原方案的验证边界供审计。

`AccountHostDPoPCredentialsExtractor` 只挂在 `/.account/` 处理链。它固定使用 CSS 自身 `baseUrl` 与 `JwkGenerator` 公钥，不从请求 claims 选择信任源。JWT 必须通过签名、issuer、audience、时间约束与必需 claims 检查，包括非空 `sub` 和签名保护的 `webid`。`sub` 保留 issuer 的 OIDC subject 语义，允许 pairwise subject，不要求等于 WebID；Account 绑定由 `webid` 的实时唯一关联确定。DPoP 必须通过签名、`typ`、时间约束、密钥 thumbprint、method、URL 与 JTI 防重放检查。提供 `ath` 时必须是非空字符串，并通过原验证器的 access-token hash 检查。验证后的 client 必须属于 host allowlist，默认只允许内置 Desktop client。

以上自身签名路径只属于发行 Account 会话的 authority。组件复用既有 `oidcIssuer` 判断运行模式：若其规范 URL 不同于自身 `baseUrl`，本机 managed Local SP 继续委托原通用 `CredentialsExtractor`；外层仍使用同一请求缓存。本机的旧 Account 操作不因此失去中央 host 会话，客户端凭据入口仍由中央 Account authority 提供。未设置外部 issuer 或 issuer 就是自身时，采用自身签名路径，无额外环境变量或开关。

Account authorizer 与 `ValidatingIdentityProviderHttpHandler` 引用同一个 `CachedHandler`，按同一个 HTTP request 对象复用验证结果。其他请求复用相同 proof 仍被 JTI cache 拒绝。不能为修复重复验证而关闭 replay 防护或缓存不同请求的 proof 结果。

自身 authority 的请求 target 必须是 issuer origin 下的 Account 路径（包含 `baseUrl` 的路径前缀）。沿用 CSS `OriginalUrlExtractor` 根据 Host/Forwarded headers 重建客户端签名的规范 URL，允许规范 URL 经 Gateway 走内部 transport；其他 origin 的 `/.account/` 不能获得自身 Account authority。managed Local 的外部 issuer 委托路径保持原行为。

`ValidatingIdentityProviderHttpHandler` 实时查询 `webIdLink`，拒绝无关联或指向多个不同 Account 的歧义关联；唯一关联的 Account 还必须存在。Cookie / `CSS-Account-Token` 继续作为优先账号凭据。合法的非 host Solid 会话不获得 Account 权限；无效 DPoP 保留 CSS 前置 authorizer 的拒绝契约。

该路径不等于信任所有已关联 WebID 的外部 issuer，也不意味着这些 WebID 都由 managed Local 托管。全局 LDP、SPARQL 与 API extractor 未改动，仍验证 profile 对 issuer 的声明。客户端凭据仍在发行它的 IdP 交换，Pod 请求仍携带用户自己的凭据通过既有本机 transport 访问；没有部署级凭据兜底。

Bun 下既有 JOSE 安装补丁按模块加载器选择 Node 实现：ESM `import` 使用 `dist/node/esm`，CJS `require` 使用 `dist/node/cjs`。不能把两者都指向 ESM，否则 Solid 验证器的同步加载可能在模块图未就绪时崩溃；这属于运行时兼容，不改变 token 或权限语义。依赖状态检查拒绝旧的单一 Bun ESM export，补丁重复执行保持幂等，真实 CLI 登录与私有读写验证加载链。

浏览器 SDK 的 Inrupt core 3.1.1 资源 signer 原本未发送 `ath`。既有 `scripts/patch-inrupt-authn-transport.js` 安装补丁在 core 持有当前 access token 的边界，将它传给 signer 并计算 SHA-256/base64url；浏览器 ESM 与 Node CJS 同时覆盖。刷新与重定向后的请求重新签名，hash 对应实际 Authorization token。OAuth token endpoint 尚无 access token 的 proof 不添加 `ath`，Bearer 请求保持原行为。该修复不在 UI 或 provider 增加第二层 signer。

WebCrypto digest 返回的 `ArrayBuffer` 必须先转换成 `Uint8Array`，才能传给浏览器 JOSE 的 base64url 编码器。Node 的 Buffer 编码器能接受原始 `ArrayBuffer`，因此仅运行 Node 环境下的 ESM/CJS 测试会漏掉浏览器产生空 hash 的问题。sender 专项当前包含 27 项回归，覆盖 Node CJS、core ESM、实际浏览器 Session 的 redirect factory/fetch、真实浏览器 JOSE 编码器和 WebCrypto，以及补丁幂等/缺失/重复检查。

本次 Account 等位替换保留上游对遗留缺少 `ath` proof 的兼容行为，以免公网依赖修复阻断已发行 host 会话。此类旧 proof 不满足最新 RFC 9449 的 access-token hash 要求；新 SDK 始终发送 `ath`。未来全面强制 `ath` 必须作为独立迁移处理，不能在本次替换中隐式收紧旧客户端准入。`ath=null`、数字或空字符串不属于遗留缺失，必须拒绝。

回归覆盖见 `tests/authentication/AccountHostDPoPCredentialsExtractor.test.ts` 与 `tests/identity/ValidatingIdentityProviderHttpHandler.test.ts`：公网 profile 不可达、固定公钥/issuer、pairwise subject、所有 DPoP 约束、请求缓存与跨请求 replay、Cookie/token 路径、非 host client、账号唯一性、账号及关联删除。SDK 的 `packages/solid-sdk/test/dpop-resource-proof.test.ts` 验证真实资源 signer 的 token hash、刷新、重定向与 token endpoint 边界，`browser-jose-resource-proof.test.ts` 单独锁定浏览器编码器的字节类型契约；依赖补丁必须版本对齐且恰好应用一次。真实 Xpod 验收还需分别验证 Pod 读写、Gateway 认证、models 与真实 Chat 响应；单元通过不代表现网中央 IdP 已部署此修复。
