# Web Account 恢复与 RC 验收

## 边界与清理计划

- 在 `codex/account-provisioning-latest` 保留上一轮 provisioning 修复；不迁入旧工作区。
- 恢复原 Web Account 的说明/表单双栏与窄屏单栏，Account 页面使用本仓库展示组件。仅 App 的认证窗口继续 compact/window，不按 viewport 宽度猜宿主。
- 保留 CSS Account 控制器、表单校验、Inrupt 会话与最新 provisioning 协议；不回退历史业务逻辑。
- 先补 Web 与 App 布局分离回归，再替换固定 window 包装。Consent/初始化不再使用 shared-ui 业务展示，不堆叠卡片或重复错误。
- 不添加依赖/配置，不发布 stable，不移动 latest，不操作生产。

## 2026-09-06 注册遮挡修正

- Account 注册、邮箱密码登录、找回/重设密码由 Xpod Web Account 持有；shared-ui 不承载 Account 注册状态机或表单业务，只提供 WebID 登录及通用基础控件。
- 原注册表单代码虽已移回 `ui/src/auth/XpodAccountViews.tsx`，但 App 中仍套用 WebID 紧凑认证壳与 280×400 窗口，长注册表单被压缩。注册改为复用 Xpod 自有 Web Account 文档布局，并恢复可调整大小的 workspace 窗口。
- 不改变 CSS Account 注册 API、OIDC transaction 或 provisioning 流程。WebID 登录边界不得自动套用 Account 说明双栏；用显式 `XpodAccountPageSurface` 收口。
- 回归增加 280×400 小窗注册的字段/错误/提交/返回操作可达性，注册不再出现在固定认证壳中；已有桌面登录小窗行为保持。

## UI QA 清单

1. 桌面 Web：登录、注册、找回/重设密码、初始化、授权、错误/Loading 的说明在左、有限宽表单在右；无全屏拉伸输入框。
2. 窄屏 Web：同一页面单栏、无横向溢出，操作可达；不是 App 全屏窗口布局。
3. App bridge 宿主：WebID/简短 Account 认证入口保留 compact/window；完整 Account 文档由路由切换为 workspace，不能仅因为 bridge 存在就套 compact。无灰色遮罩和嵌套卡片。
4. 注册/登录切换、密码不匹配、失败/重试、恢复成功、授权同意/拒绝、记住应用、单/多绑定选择。
5. 非 happy path：初始化 HTTP 失败不创建 Pod；表单长错误/长 WebID 不撑破布局。
6. Playwright 截图与几何断言分开验收；本地视觉夹具不冒充 RC 真实账号验收。

## 发布顺序

类型/lint/UI/完整集成检查 → 提交并推送唯一候选源码 → 按当前 candidate workflow 发布 RC → 核对 SHA/digest → 真实 RC 登录/Pod 写读/API Key/Models/Chat 分项证据。发现阻塞保留真实日志，不跳过门禁。

## 本地验证结果（初次基线，最终追加记录在下方）

- `bun run test:account-layout`：8 项通过；1440/768/390 Web 布局，登录失败、注册密码不一致、密码恢复/重设、授权、初始化失败/重试、Loading/Error、小窗注册与返回登录。截图/几何断言都通过。该命令自动启动 Vite，CI 同样执行并保存截图。
- UI/Account/provisioning 定向 Vitest：230 项通过；包含 lookup 失败重试不创建、create 失败重试原创建操作、WebID 通用 lead 不丢失及 App window 回归。
- `bun run build:ts`、UI ESLint、全部 UI build target 与 `git diff --check` 通过；有既存的大 bundle/eval/运行时提示，不将它们隐藏为无警告。
- 完整 `bun run test:integration`：lite 149 passed / 6 skipped，full 45 passed，退出码 0；三种模式仍属于本地隔离集成证据，并非新 RC/生产成功证据。
- 独立源码复审：通用 AuthSurface 不再吞 lead；显式 Account 文档边界、注册布局和 Consent retry 无阻塞。
- 尚未声称桌面真实进程验收：当前运行包来自另一工作区，浏览器中的 desktop bridge fixture 只证明 renderer/bridge 调用行为，不能代替安装包实机验收。
- 未发布 stable、未移动 latest、未修改生产。

## 2026-09-06 收口追加证据

- 浏览器夹具最终扩展到 11 项，全部通过：新增已创建但待确认的 query-only retry、200% 字体与键盘顺序、Local discovery 失败不发送 Account 请求及重试恢复。截图和几何断言分别检查；源码冻结后重跑，未把开发时 HMR 触发表单重置的失败当成功。
- 定向 UI/状态/绑定回归 43 文件、336 项通过；随后新增的严格 provisioning 结构校验与初始化重试单独 29 项通过。完整全仓结果以最终日志为准，不把不同批次计数相加。
- 同一真实账号再次密码登录进入 Dashboard，等到数据加载后核对了 canonical Pod 与 WebID；不是只检查导航 URL。证据：`.test-data/auth-redesign-live/final-account-login-ready.json`、`final-account-login-ready.png`。
- 真实 Pod 为 `https://e333626390203a88630a8cc987268072.nodes.undefineds.co/acceptance-auth-1788631726638/`，WebID 为同一路径下 `profile/card#me`。实际 Gateway 来自旧桌面 runtime，这证明当前前端的真实恢复/登录，不证明新服务端代码已发布。
- 本次发现并修正 Cloud bindings 的远端 SP 过滤、Local prepare receipt 缺失、过期 code 挡住 durable binding，以及 discovery 失败误选 Account authority；详见 [整体审查](../specs/2026-09-06-auth-frontend-redesign.md)。
- 额外诊断 `typecheck:test` 尚非通过：根 TS 5.5 无法解析当前 plugin-react 类型声明；使用已安装 UI TS 5.9 诊断又暴露仓库既有测试类型/ambient 声明边界问题。没有添加依赖、没有关闭类型检查；根生产 `build:ts` 与 UI `tsc -b` 分别验收，不能称全仓测试 TypeScript 已通过。
- 新 RC、真实 Electron、三模式 immutable digest、Pod API Key 写读及 Chat 均仍需各自证据，不复用旧候选结论。

### 提交前最终检查

- `bun run test:run`：504 文件通过 / 36 跳过；4413 项通过 / 270 跳过 / 1 TODO。首轮与构建、集成并行时有一项 PGlite 文本搜索超时；原设置下该套件单独 36 项通过，随后不并行构建的完整复跑全部通过。未放宽超时或跳过失败测试。
- `bun run test:account-layout`：11 项通过；`AuthContext` 最终 29 项通过。
- `bun run test:integration` 最终再次运行：lite 149 通过 / 6 跳过，full 45 通过，退出码 0。
- `bun run build:ts`、`bun run build:ui`（四目标）、UI ESLint、`git diff --check` 均通过；生成的静态资源同步提交。
- 日志在忽略目录 `.test-data/auth-redesign-*`；没有把测试账号、密码、token、kubeconfig 或运行产物日志提交到仓库。提交本身不是 RC 验收通过声明，最终 SHA/digest 由新的候选 workflow 绑定。
