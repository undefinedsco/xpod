# 0.4.9 发布与实际 Local 登录验收

## 发布产物

- 源提交：`05f076ac7a013f2e11ef247934027377168a5b9e`，签名标签 `v0.4.9`。
- RC：35391290877，21 项通过，包括 stable 要求的 18 项。
- 正式发布：35396986367 attempt 5 成功；Node 22/24/25 × npm/Bun 六消费者通过。
- npm root/native latest 均为 0.4.9；生产 `.co` 使用已验收 digest `sha256:d1661482968bc81078f34a791aa7f2a3fb39935f8ab49e45d2f134630b62befb`。
- [正式 macOS DMG/ZIP 与 GitHub Release](https://github.com/undefinedsco/xpod/releases/tag/v0.4.9)。

首次运行受原生 tarball 传播延迟影响；随后一次 npm 下载连接重置，以及两次 latest 写入后即时读回旧值，分别保留失败日志。仅在新证据允许后重跑失败项，没有改写标签、重发相同版本或削弱安装门禁。

## 实际 Local 安装

官方 root/native tarball 的 SRI、SHA1、gitHead 均已验证；原生 manifest 和 15 个文件与本轮 RC 一致。安装后六个内置包共 2164 个文件逐字节核对通过。程序目录设为只读，所有符号链接均留在目录内，未发现共享硬链接。

已在原数据目录、配置、issuer 和节点身份下启动官方 0.4.9；CSS/API 运行且重启次数为 0。备份及配置验证独立记录，文件 stat 对比不冒充重新读取全部数据的内容哈希。

### Bun 安装边界

Bun 1.3.12 在特定首次安装依赖图下，会把内置 `file:` 依赖文件变为自身符号链接，安装仍返回 0。最小复现中 default/copyfile/clonefile 均可触发，不能归因于某一种复制方式；官方 tarball 与安装缓存文件本身正确。先建立依赖状态再安装的对照正常，具体 Bun 内部根因尚未确认。

实际采用正式 CI 已验证的初始化及安装流程，保留 manifest/lock，并重新核对全部内置文件和原生文件；未手改 node_modules。问题报告及自包含复现保存在本轮证据目录，尚未对外提交。

## 在线验收分层

产品服务使用 Bun 1.3.12；浏览器验收使用 Node 24 和系统 Chrome。直接使用 Bun 执行 Playwright 曾在请求解析处失败，不能把测试运行器兼容性错误判作服务端登录失败。

| 层级 | 当前证据 |
| --- | --- |
| 完整 WebID 身份 | 两个实际账号分别匹配原始 WebID 与预期 Pod；不做 WebID URL 归一化 |
| 登录与切换 | 真实密码、PKCE、code/state、token/verifier；A→B 后身份及 Pod 匹配 |
| 私有 Pod | 两账号 PUT 201、GET 200、内容一致、匿名 401；测试文件已删除 |
| 恢复 | 页面刷新、浏览器上下文恢复、已加载页面离线再联网保持同一身份 |
| Gateway 凭据 | 当前会话创建临时凭据、注册、认证及撤销清理通过 |
| Models/Chat | 当前验收账号没有配置模型，models 200 空数组；Chat 未执行，不计通过 |
| 完整退出 | 最新完整双账号链通过，产品身份和会话清除；本次请求边界无违规 |

## 退出与 SSO 边界

实际 Managed Local 页面中的 Account 经浏览器请求确认匿名，但直接携带 issuer Cookie 的 APIRequestContext 仍能看到 Cloud SSO。退出产品后 WebID 与两种浏览器存储中的会话记录清除、操作结束且无错误；跨站 SSO 保留。不能将此表述为所有 Cloud SSO 都已注销。

验收按页面实际 Account 前态判断：已认证时仍要求注销 POST 成功与原受保护 Account 接口被拒绝；已确认匿名时验证 WebID-only 产品退出，并单列 issuer SSO 状态。未知、错误或损坏 controls 不算匿名。

此前失败还包含菜单已展开时再次点击头像将其关闭、随后 Sign out 点击超时，以及将用户卡消失误当整项退出完成。完整验收已修正这些前置条件与时序，没有修改产品实现来迁就测试。

## 覆盖与剩余事项

三模式、记住账号/应用、恢复/过期、故障回退、原文身份和模块边界的分层证据见 [覆盖与模块化审计](login-coverage-and-modularity.md)。已有矩阵不是所有部署、浏览器、操作系统与故障的无限组合；SMTP、离线冷启动等边界仍按原审计明确保留。

发布传播可靠性补丁已回移开发工作区，保留用户已有 workflow 差异；14 项 Node 回归通过，独立工作树两轮完整集成都为 Lite 151 通过/6 跳过、Full 45/45。Full 使用既有 fake QLever，不替代以上实际 Local 验收。补丁属于后续工作，不在已签名的 0.4.9 中。

最新完整报告：`.test-data/login-audit-20260915/release-preparation/online/evidence-managed-local-1789771796768-654cf2fa/report.json`，`loginLifecyclePassed=true`、请求边界无违规、Gateway 临时凭据认证和清理通过。总结果仍为失败（`GATEWAY_LAYERS_INCOMPLETE`），因为账号没有可用于 Models/Chat 验收的已有配置。

后续完整复跑 `evidence-managed-local-1789771929608-3f960a2d/report.json` 再次复现退出后请求：GET `/api/ai/connections/…`（四段路径）发往 canonical 节点域名，未携带 Authorization/DPoP，严格请求边界将其阻断。产品退出已通过，但该轮 `loginLifecyclePassed=false`、`AUTHORITY_BOUNDARY`，不能声称问题已解决。独立工作树正在为旧异步操作跨退出/切换继续执行补回归与修复；未修改已发布产物。整个目标尚未完成。

## 退出竞态的共享层回归

独立测试使用实际 Inrupt Session/ClientAuthentication 与 SDK 源码，仅替换 transport、无真实网络：旧 Pod database.fetch 在 logout 后仍发匿名请求；同一 Session 恢复 B 后，旧引用会使用 B 的 signer 请求 A 的 URL。两个防御性断言失败，raw fetch 匿名兼容对照通过。这证明共享层旧引用未绑定原会话，不等同于已经观测到线上凭据泄露。

修复分两层进行：SDK/Provider 为业务请求绑定完整原始 WebID 与会话代次，保留 raw fetch 契约；controller 取消已失效或卸载的多步加载。另补三部署真实浏览器延迟完成回归，避免现有测试先离开 AI Connections 再退出而遗漏问题。上述修复仍在独立工作树开发，尚未发布或声称验收通过。
