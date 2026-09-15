# 登录边角与部署补充验收

2026-09-16，补充用户明确提出的记住应用、记住账号、会话恢复/过期、断网，以及 Cloud / Managed Local / Standalone。
本文件记录补测计划；执行结果回填 [覆盖矩阵](login-coverage-and-modularity.md)，不把计划当通过证据。

## 边界和顺序

1. 先完成现有浏览器静态资源挂起的分层诊断；不改超时、不删除缓存禁用、不用自动重试掩盖失败。
2. 记住账号：先补回归，再在现有 Account 表单中提供选择；默认保持当前记住行为，选择交给 CSS `remember`，不另存认证事实。
3. 记住应用：真实 provider 验证记住/不记住/取消、撤销、过期、显式 consent、新权限、换 Account，以及在线 refresh 的成功和失效。
4. 断网：加载后的匿名 Account 提交、有效会话的 Pod 请求、回调兑换、产品退出分别验证；恢复网络后可重试。冷启动无法下载网页资源单独记录，不能假定存在离线缓存应用。
5. 三种部署：复用 XpodTestStack 和已有 OIDC 驱动器，Cloud / Managed Local / Standalone 各验证两个正式 applet 入口，并检查 Account、原路由、精确 Pod、鉴权读写、刷新和退出。
6. 产品修改后重建受影响入口，执行定向回归及最终完整集成；测试栈串行运行，全部使用隔离账号/数据并清理。

## 测试辅助代码的小范围整理计划

- 已有 shared-login 浏览器行为作为回归基线。
- 把“读取当前 React host 能力”的测试访问合并到 `tests/helpers/browserXpodRuntime.ts`：只调用当前 Account/SDK/Pod 实例，不创建 Session、不注入凭据。
- 部署矩阵和断网测试共用该入口，删除 shared-login 中重复的 Account provider 遍历。
- 仅归并测试访问逻辑，不改产品 provider、认证状态或窗口布局。Account 和 WebID 仍允许两套尺寸。

## 不能混称的证据

- Cookie/公开账号记忆/SDK 会话/IdP 应用 grant 分别验收。
- 真实协议 fixture 不等于已部署 Cloud 更新；同源 Local 不等于 Cloud issuer + Managed Local。
- Browser、Electron、CLI 是不同宿主，某一宿主通过不能填满其他宿主的矩阵。
- 现有根测试 TypeScript 工具链问题单独报告，不用依赖升级扩大本次修改。

## 桌面三部署验收重构计划

- 先保留并重跑现有自有 issuer 的 Local edition（Standalone）Electron 单项，保护托盘同 renderer/document/session 与第二实例唤回行为。
- 将同一桌面生命周期测试参数化为 runner 私有 manifest 的 Cloud / Managed Local / Standalone；复用既有三服务与浏览器真实注册产物，不复制基础设施，不注入认证状态。
- 通过当前产品 runtime.fetch 写读私有文件并断言匿名拒绝，核对准确 WebID/Pod 和 Account controls 中本次账号的 WebID；不以公开 profile 200 替代私有权限验证。
- 冷启动若安全回退到记住账号入口，继续真实登录并重读原私有文件；根据实际分支核对密码提交次数，托盘路径仍严格禁止新增密码提交或重建文档。
- 浏览器六项与桌面三项串行共用服务，输出目录独立；源码静态验证后，等待集成槽释放执行 Standalone 基线，再执行九项联合验收。
