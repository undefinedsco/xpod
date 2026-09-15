# WebID 与 CSS Account 展示边界

本规范按 2026-09-13 用户确认的边界执行；早期“桌面 Account 可以套 shared 紧凑认证壳”的说明不再适用。

| 所有者 | 职责 | 尺寸与宿主 |
| --- | --- | --- |
| shared-ui 的 WebID 登录展示 | WebID 会话恢复、已记住身份、连接中、失败和返回应用 | 沿用微信式小框基准 280×400 CSS px。浏览器是一层卡片；Electron 是同尺寸内容区，不再内嵌第二层卡片。此为项目设计基准，不是对当前微信版本实测尺寸的声明。 |
| CSS Account UI（`ui/src/auth` 与 `ui/src/pages`） | 邮箱密码、注册、找回/重置密码、consent、准备 Pod | `WebAccountLayout` 与 CSS 自有业务视图；桌面和浏览器使用同一个实现。长表单是完整、可滚动的文档，不挤入 WebID 小框。 |
| Electron | 原生窗口、托盘、导航和宿主模式 | WebID 用 auth 模式；CSS 登录与 consent 用独立 account 模式；注册、找回、创建 Pod 等完整文档恢复可调整的窗口，包括跨域 Cloud 页面。 |

共享按钮、输入框、主题 token 等基础控件可以继续使用；不因此把 Account 的业务表单、授权类型或页面外壳归入 shared WebID 层。登录控制器仍负责认证与返回原应用，展示收敛不能改写 Account/OIDC/Pod 状态机。

本地开发构建不等于 Cloud 已部署：`id.undefineds.co` 的页面来自该服务器，不能声称本地修改已自动更新线上页面。

## 本次核对

- 真实开发 Gateway + Vite：Chromium 与独立 Electron profile 加载同一账号入口，均为 CSS Account 卡片、含邮箱表单，未挂 shared 认证壳，无横向溢出。
- Electron 账号登录内容区 480×640；注册恢复 1080×760，全部字段与提交/返回可见；无事务的 WebID callback 以 280×400 展示预期失效状态，证明 shared 壳尺寸与错误状态可用，不代表本次执行了用户授权。
- 证据：`.test-data/card-boundary/visual.json` 与同目录截图。截图检查不提交账号或授权，不使用 mock 服务。
- UI 相关 101 项、shared 43 项、桌面窗口/开发工具 17 项通过；四入口构建通过。
- 最终完整集成：`VITEST_MAX_FORKS=1 VITEST_MIN_FORKS=1 bun run test:integration`，lite 149 项通过/6 项跳过，full 45 项通过。日志 `.test-data/card-boundary/integration.log`。这些回归仍按各套件原有真实服务/替身边界报告，不统称全部无 mock。
- scoped ESLint、TypeScript（四入口构建）与 `git diff --check` 通过。
