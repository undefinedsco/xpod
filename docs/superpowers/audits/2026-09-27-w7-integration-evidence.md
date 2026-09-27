# W7 集成与发布证据（2026-09-27 R2）

本文件按实施 spec §13 的 **AC-01 … AC-14** 汇总本轮（W1–W6）实际落地的证据与缺口。
口径：**只记录已经能复核的东西**；依赖运行侧、领域 owner 或真机走查的部分单独标注，不用前端证据顶替。

| 标记 | 含义 |
|---|---|
| ✅ 已实现 | 有前端/宿主代码与可复跑的测试证据 |
| 🟡 部分实现 | 主体已落地，仍有明确未做项（逐条写出） |
| 🔵 依赖运行侧/领域 owner | 按 §11 由对应 owner 提供证据，前端不自行宣称 |
| ⬜ 未做 | 本轮未开展 |

## 本轮验证基线（2026-09-27）

| 套件 | 结果 |
|---|---|
| `ui/src` + `tests/ui` + `packages/{ai-connections,shared-ui,extension-sdk}/test` | **167 文件 / 1586 用例通过**（1 skipped、1 todo） |
| 桌面壳 `bun run --filter @undefinedsco/xpod-desktop test` | **141 用例通过** |
| `bun run test:account-layout`（Playwright，768/390 等） | **12 通过** |
| `bun run build:packages` / `bun run build:ui` / 桌面 `build` | 均成功 |
| `bun run typecheck:test` / 桌面 `typecheck` | 无错误 |

## AC 证据表

| AC | 状态 | 证据（文件 / 测试） | 缺口或边界 |
|---|---|---|---|
| AC-01 所有表面共用一套 token/primitive | ✅ | `packages/shared-ui/src/theme.css` 唯一语义映射；`ui/src/styles/global.css` 只留布局/工具规则；`ui/src/theme/system-theme.test.ts`（禁止重定义同名 token）、`tests/ui/semantic-colour-contract.test.ts`（禁止页面自建语义彩色）、`packages/shared-ui/test/{theme,overlay-layers}.test.ts` | 中性调色板经实测为 0 处，并由 `semantic-colour-contract.test.ts` 同时禁止语义色与中性色字面量 |
| AC-02 对比度、小 Logo 可辨、旧资产仍在 | ✅ | §8.4 的 18 组比值由 `theme.css` 现值复算一致（偏差 0.00）；`desktop/assets/README.md` 记录 34 个资产来源与 sha256；选定记录 `homepage/public/brand/manifest.json`；旧资产在 `homepage/docs/reference/archive/2026-09-26-before-selection/` | 系统图标与真机可辨性未实测 |
| AC-03 键盘/焦点/200% 文字/长内容 | 🟡 | 上述单元/样例证据；e2e `account-web-layout.spec.ts`（768/390 边界）；**真实浏览器** `accept-r2-workspace.ts` 覆盖窄窗（700）任务栏+抽屉与宽窗导航 | 200% 字体缩放与长错误的键盘走查未做 |
| AC-04 四入口、集合才用对象列、旧深链映射 | ✅ | **真实浏览器**（`accept-r2-workspace.ts`：四个任务入口可见、窄窗抽屉复用同一树）+ **真实运行时**（`accept-r2-route-map.ts`：§3.1 七路径 200）；`ui/src/layout/global-navigation.test.ts`（四入口顺序/标签/归属/唯一命中）、`packages/extension-sdk/test/layout-pages.test.ts`（非集合页任何宽度不出对象列）、`packages/extension-sdk/test/workspace-layout.test.tsx`（≥1284 视口才并排、否则堆叠）、`ui/src/routes/canonical-routes.test.ts`（§3.3 各行） | 已关闭：`/network/overview` 为显式路由，`/dashboard/network`、`/settings/network` 按 §3.3 指向它（第六轮） |
| AC-05 三种 authority 各守边界、失败隔离 | 🔵 | 既有覆盖：`ui/src/auth/AccountAuthBoundary.test.tsx`、`ui/src/auth/WebAccountViews.test.tsx`、`ui/src/auth/XpodAuthSurface.test.tsx`、e2e `account-webid-isolation.spec.ts`、`consent-cross-origin-resume.spec.ts` | 本轮未改动认证权威层；最终安全行为按领域真实验证 |
| AC-06 每场景唯一容器与窗口 owner | ✅ | `packages/shared-ui/test/auth-surface.test.tsx`（compact 画布铺满 + 16px + 无内嵌白卡）、`ui/src/auth/WebAccountLayout.tsx`（≥900 断点）、`desktop/src/window-mode.ts`（工作区 1180×800/最小 640×560） | Account 文档窗口的 1040×760 与可缩放性待宿主决定（已在 W3 审计记录） |
| AC-07 注册仅建 Account、零 Pod 可达管理、显式创建 | ✅ | `ui/src/pages/WelcomeNoPod.test.tsx`（注册不 provisioning、无 Pod 落账号管理）、`tests/ui/registration-flow.test.ts`（注册模块不含创建入口）、`ui/src/pages/settings/PodManagementPanel.test.tsx`（零 Pod 可进入 + 唯一被守卫事务）、`ui/src/pages/ConsentPage.tsx:517` | 创建协议本身（Account controls/幂等/健康检查）按 §11 |
| AC-08 无/多 Pod、缺 owner、过期 interaction、切号安全出口 | 🔵 | 既有覆盖：`ui/src/pages/ConsentNoPod.test.tsx`、`ConsentResume.test.tsx`、`ConsentRetry.test.tsx`、e2e `consent-recovery.spec.ts` | 本轮未逐条重验；绑定已有 Pod 的证明协议仍由 9/19 §4.2 待定（入口保持禁用） |
| AC-09 三服务/网络/机器/Pod 访问互不冒充、用量未知非零、刷新保留快照 | ✅ | `ui/src/pages/admin/StatusPage.test.tsx`（结论优先、≤4 事实、服务未知写「状态无法确认」且不出现 `0/`、多问题只铺一张卡 + 「还有 N 项」）、`ui/src/pages/admin/UsagePage.test.tsx`（有值/真 0/不支持/失败四态） | 用量记录时间与来源在部分部署可能缺失，显示「未标注」 |
| AC-10 保存/应用/检测/重启分别反馈；取消等待不伪装撤销 | 🟡 | `ui/src/pages/settings/ServicesAccessSections.test.tsx`（服务与访问四主题 + 未知态）、`packages/ai-connections/test/client-configuration.test.tsx`（四段结果 + 只重试写入）、既有 `SystemSettingsSubjectPanel` 保存/重启路径 | 「取消等待 ≠ 撤销」在部分流式操作上未逐条走查 |
| AC-11 Provider 凭据 / Xpod Key / 客户端配置 / 用途不混用；排序不改默认 | ✅ | `ui/src/pages/settings/ai-config/ModelAssignmentsPanel.tsx`（概要用例/当前模型/可用性三列 + 编辑视图；用途为主语、角色名为副文本、说明"不改运行语义"）+ `ModelAssignmentsPanel.flow.test.tsx`（切换 embedding 的确认与重建提示）；`packages/ai-connections/test/gateway-keys.test.tsx`（凭据与 Key 分开） | 「排序/首项不隐含默认」属运行侧解析语义 → 🔵（AI 领域 owner） |
| AC-12 托盘与 Status 一致；退出动作按能力分开 | 🟡 | `desktop/src/tray-menu.ts`（中文五态 + 服务计数 + 崩溃直达日志 + 「关闭窗口后服务继续运行；退出 Xpod 才会停止服务」）、`desktop/test/tray-menu.test.ts`（141 全过）、`desktop/src/window-lifecycle.ts`（关窗=隐藏） | 「退出登录/代理退出」等动作依赖 9/19 D-14/D-18，未定前不实现（保持不可执行） |
| AC-13 连接客户端与改搜索模型可在连续任务完成；Key 建好但写入失败只重试写入 | ✅ | `packages/ai-connections/test/client-configuration.test.tsx`（两次 apply 之间 `createClientCredential` 只 1 次、`revoke` 0 次、写入行 failed→ok）、`ModelAssignmentsPanel.flow.test.tsx`（改向量模型 → 影响提示 → 重建） | 已实施：客户端优先入口 + Key 来源显式选择与共享影响说明（W5 审计） |
| AC-14 正常/首次/停止/未知/异常的信息优先级；首屏无告警墙 | ✅ | **真实浏览器**（`accept-r2-workspace.ts`：首屏一个结论、4 组事实、专业详情默认收起）；`ui/src/pages/admin/StatusPage.test.tsx`（恰一个结论、事实 ≤4、正常态零强调动作、details 默认收起）、`ui/src/layout/global-navigation.test.ts`（顶层只有四个任务入口，18 项不再常驻） | 窄窗首屏走查未做 |

## 真实实例证据（本轮补）

| 项 | 内容 |
|---|---|
| 路由冒烟 | `bun scripts/accept-r2-route-map.ts`：在从源码启动的 standalone 运行时上逐一访问 §3.1 的七个目标路径（`/status/overview`、`/status/usage/overview`、`/settings/pod`、`/settings/runtime`、`/ai-connections`、`/network/overview`、`/network/domain-dns`），全部 **HTTP 200 + SPA 外壳**，输出 `ROUTE SMOKE OK` |
| 覆盖的 AC | AC-04 的路径可用性（真实运行时），以及 §3.3 映射目标确实存在 |
| 浏览器检查 | `bun scripts/accept-r2-login-surface.ts`：真实 Chromium（浅色/深色 × 1000/800 视口）打开未登录的 `/status/overview`，读取**计算后**的画布与正文色：浅色 `rgb(247,244,237)` / `rgb(43,38,33)`，深色 `rgb(33,29,25)` / `rgb(247,244,237)`，与 §8.1 一致；Account 页面铺满画布、无内嵌卡片，输出 `LOGIN SURFACE OK` |
| 覆盖的 AC（浏览器侧） | AC-01/AC-02：公共主题在真实浏览器里的计算值就是 §8.1 的角色值（两套主题）；§5.1 第 1 行的"画布铺满、无内嵌白卡"在登录/恢复路由上成立 |
| 工作区检查 | `bun scripts/accept-r2-workspace.ts`：真实 Chromium 走**真实登录**（邮箱+密码）后进入工作区，核对概览首屏（恰一个结论、4 组事实、专业详情默认收起）、宽窗 1440 下导航列 **184px** 且四个任务入口可见、窄窗 700 下改为顶部任务栏 + 常驻导航列隐藏 + 抽屉复用同一导航树，输出 `WORKSPACE CHECK OK` |
| 不覆盖 | 200% 缩放、菜单栏与 Dock 真机行为、系统图标可辨性（见走查清单 C 段） |

## 发布侧证据（已发生的实机验收）

| 项 | 内容 |
|---|---|
| 候选版本 | `0.4.17-rc.200`，source `d8f25786e32b75788b591b97950b5f7b50bb27fd`，镜像 `sha256:349542…` |
| 验收记录 | `release-acceptance-d8f2578675b8c3bcb08d5822f8f2b5e0a4a2d0f9`：**21/21 项通过**，含 `dashboard`、`protected-route`、`authenticated-pod`、`pod-read-write`、`gateway-key`、`ai-connections`、`models`、`chat`、`qlever-local`、`desktop`、`package-consumers` |
| 已发布 | stable tag `v0.4.17`（生产部署 + GitHub Release 含 `latest-mac.yml` 更新源）；`v0.4.16` 为首个带 R2 文档的稳定版 |

**这份证据说明什么、不说明什么**：它证明**部署后的产品链路**（登录、Pod 读写、网关密钥、模型与对话）在真实环境可用；它**不**替代本文件表格里标注为 🟡/🔵/⬜ 的设计走查（真机菜单栏、200% 字体、窄窗、未定生命周期语义）。

## 复核方式（可复跑）

```bash
# 前端与包
./scripts/run-vitest-safe.sh --run ui/src tests/ui packages/ai-connections/test packages/shared-ui/test packages/extension-sdk/test
bun run --filter @undefinedsco/xpod-desktop test
bun run test:account-layout
bun run typecheck:test && bun run build:packages && bun run build:ui

# 对比度契约（§8.4）
# 见 docs/superpowers/specs/2026-09-27-xpod-product-experience-spec.md §8.4 与 theme.css 现值

# 部署级验收（历史证据）
gh run download <rc-run-id> -n release-acceptance-d8f2578675b8c3bcb08d5822f8f2b5e0a4a2d0f9
```

## 未覆盖与交接（明确不假装完成的部分）

三项外部依赖的责任方、所需证据与验收口径见 [`2026-09-27-external-dependencies-handoff.md`](2026-09-27-external-dependencies-handoff.md)。

1. **真机走查**：菜单栏可辨性、Dock 图标、200% 字体、窄窗首屏 —— 清单见 [`2026-09-27-r2-walkthrough-checklist.md`](2026-09-27-r2-walkthrough-checklist.md)；
2. **未定语义**：9/19 D-14（退出/重试关系）与 D-18（放弃退出）——认证 owner 决定后才补动作；
3. **运行侧依赖**：模型解析与"排序不改默认"、允许列表限制（AI 领域 owner，§11）；Key ↔ 客户端关联数据（同上）；
4. **未做前端项**：无（中性调色板经实测为 0 处，已由色板契约测试守住；`/network/overview` 已建立）；
5. **Account 文档窗口**的 1040×760 与可缩放性（需宿主侧一起决定）。

## 结论

R2 的**结构性要求**已在前端/宿主落地并有测试：四任务入口、页型与条件对象列、结论优先的首屏、单一主题源与语义色、显式创建与零 Pod 可达、创建四段结果与只重试写入、用量三态、托盘语言与生命周期说明、资产可追溯。剩余的每一项都属于"需要运行侧数据、真机走查或领域决定"的类别，已在上面逐条登记，不以设计稿或前端测试冒充已经发生的事实。
