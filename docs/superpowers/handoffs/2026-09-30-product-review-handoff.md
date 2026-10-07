# Handoff：Xpod 其他模块的产品审查（2026-09-30）

这份文档交给新会话，用来审查 Xpod 除登录以外的模块。

**总设计**：[Pod 登录前门设计（shared-ui Pod Sign-in）](../specs/2026-09-29-shared-ui-pod-sign-in-design.md)，配套画板 https://claude.ai/artifact/4zgKc2kZik6EwfNhBxPzij 。下文的决策都以它为准，审查其他模块前先读它的 §3 用语、§5 视觉和 §6 各组状态。

**登录模块不在本次交接范围内**：它仍由原会话继续跟进，包括设计、第一期实现、三模式验收和第二期。新会话不要修改登录相关的 spec、画板、worktree 或分支（§4 列了清单）。但登录审查中定下的决策和方法，是审查其他模块的输入（§1、§2）。

## 1. 登录审查已经定下、其他模块必须一致的决策

- **身份一律是 WebID**。
  - 应用和 Xpod 控制台都只持有 WebID 会话；AI 连接、Xpod API Key、授权过的应用，都属于当前 WebID。
  - Account（邮箱密码）只出现在账号服务自己的页面里，不作为任何模块的登录门，也不作为数据归属。
- **只有一个账号服务：Xpod**（`pod.undefineds.co`）。
  - "Xpod 云端 / Xpod 边缘"只表示 **Pod 存在哪里**，不是两种账号，也不是两种产品。
  - 用户可见的用语：WebID、Pod、Xpod 云端、Xpod 边缘、设备、网络。不暴露 route、binding、issuer、provider、storage 这类实现词。
- **WebID 和 Pod 一起创建、互相绑定**：Pod 的存放位置只在新建时选定，以后要换走"迁移"。
- **账号页（账号服务的整页）分三块：WebID / 设备 / 密钥**。
  - **网络跟着设备走**：公网入口和隧道是设备级的事实，不挂在 WebID 或 Pod 上。
  - 首期不单独做设备管理；设备在新建 WebID 时选定，添加设备是一个三步弹窗（安装并登录 → 检查网络 → 完成）。
- **隧道有四家**：Cloudflare / ngrok / SakuraFrp / 自建 FRP。字段由 `src/tunnel/TunnelProviderCatalog.ts` 生成，界面不按供应商写分支。
- **出错只留一行提示**：
  - 普通用户看不到错误屏和错误码，主按钮直接变成能解决问题的动作；
  - 技术细节只在开发者模式下可见。开发者模式是 Xpod 设置里的全局开关，第二期实现。
- **本机拉起（启动本机 Xpod）只在宿主有这个能力时出现**。没有能力时显示文字"在那台设备上打开 Xpod"，不放点了没用的按钮。
- **视觉**：
  - 颜色：纸色 `#F7F4ED` 加墨紫 `#563E84`，token 已在 `packages/shared-ui/src/theme.css` 中定义，第一期分支落地；
  - 字体与尺寸：系统字体；主按钮 44px，正文 14px，最小字号 12px；
  - 版式：每屏只有一个标题，主操作贴底，次要信息默认收起；
  - 品牌图标：用 `/Users/ganlu/develop/homepage/public/brand/` 里的正式 SVG（`xpod-app.svg`、`linx-app.svg`）；
  - 共用组件：不写死任何应用。

详见[总设计](../specs/2026-09-29-shared-ui-pod-sign-in-design.md)的 §3 用语、§5 视觉、§6 各组状态。

## 2. 用户的审查方法和偏好

- **现有文档不是权威**，只参考产品风格。做得不够好的地方直接给出更好的设计，与 canonical、R6 冲突的地方列表待裁决。
- **先画出来再讨论**：
  - 用 Design 画板，状态分组编号，一屏一张；
  - 要演示交互时，把画板做成可点着试；
  - 同一个 body 换外框时，用 `dc-import` 复用，保证两处一致。
- **先定概念分层，再画界面**。每个模块先回答三个问题：
  - 数据属于哪个 WebID；
  - 存在哪台设备；
  - 需要哪一层身份。
- **对照成熟产品的模式**（例如微信登录、下单时填收货地址），追求步骤少、不打扰；三层以上的嵌套就要拆开。
- **用户不喜欢的问题**：
  - 长链条、到处是小卡、两个标题；
  - 重复入口；
  - 过重的错误信息；
  - 写死某个应用；
  - 图标错用；
  - 以及"只有空状态的设计"：必须同时画出空状态和已有数据的日常状态。
- **用户的话有时是讨论，不是指令**。拿不准时先给判断和建议，再动手。
- **回复用中文**，结论先行，写明改了什么、为什么；没验证的要说清楚。
- **产出惯例**：
  - spec 放 `docs/superpowers/specs/`，并包含可实施的接口、分期和门禁；
  - 实现派 Sonnet 代理在独立 worktree 里做，完成后由主会话验收；
  - 视觉验收要看 360×540、200% 文字和深色主题。

## 3. 建议的审查起点

- **范围**：`homepage/docs/specs/xpod-product-experience-r6.md`（在 homepage 仓库）。登录部分已审完，其余的四入口、知识 / 模型 / Run 对象页、F01–F07 操作链、存储与迁移，都还没审。
- **R2 本机体验**：[2026-09-27-xpod-product-experience-spec.md](../specs/2026-09-27-xpod-product-experience-spec.md)，四个入口是概览 / 存储空间 / AI / 服务与访问。
- **品牌与用词**：`homepage/DESIGN.md`、`homepage/docs/story-and-style.md`。
- **现有界面**：`ui/src/pages/`（dashboard、settings、status），以及 `packages/ai-connections`。
- **登录审查里发现、其他模块大概率也有的结构性问题**：
  1. 新增的对象页需要哪一层身份（Account / WebID / Pod / 宿主）没有定义；
  2. 续接状态绑定在错误的层级（应绑 WebID + Pod，不应绑 Account）；
  3. 跨产品深链遇到身份不一致时，没有对应的界面状态；
  4. 验收条件依赖尚未定义的交互（canonical 的 D-14 / D-15 等）；
  5. 用户可见文案混用实现概念。

## 4. 不要碰：登录模块的进行中事项（由原会话负责）

- [总设计 spec](../specs/2026-09-29-shared-ui-pod-sign-in-design.md) 和登录画板（https://claude.ai/artifact/4zgKc2kZik6EwfNhBxPzij）。
- worktree `.claude/worktrees/agent-a9b6d90344612fc30`，分支 `feat/pod-sign-in-phase1`（基于 `release/0.4.19`）。它正在修复并准备三模式验收。
- 登录相关源码：`packages/shared-ui/src/pod-sign-in/`、`theme.css`、`packages/extension-sdk/src/react/solid-auth-boundary.tsx`、`ui/src/solid/WebIdAuthBoundary.tsx`、`ui/src/auth/*`、`ui/src/pages/ConsentPage.tsx` / `WelcomePage.tsx`。其他模块的改动如果要碰这些文件，先记下来交给原会话。
- 新会话自己的 worktree 请基于 `release/0.4.19`（用户的工作分支），不要基于 `origin/main`：两者已经分叉。

## 5. 本机运行 Xpod 的安全须知

- 本机 3000 端口的 Xpod 目前没有运行。
- **不要**直接调用 `startXpodRuntime({ mode: 'local' })`。它默认会向真实 Cloud（`api.undefineds.co`）做首次注册，并修改 DDNS。
  - 要隔离，必须设 `SOLID_OIDC_ISSUER`：等于自己的 baseUrl 即 Standalone，指向本地起的 Cloud 即 Managed Local；
  - 同时把 `XPOD_LOCAL_SETUP_PATH` 指向隔离目录，并传 `envFile: undefined`。
- 需要真实三模式环境时，参考 `tests/helpers/runLoginDeploymentMatrix.ts` 的起法。它依赖 Docker，以及 `/Applications/Xpod.app/Contents/Resources/runtime/qlever/bin/xpod_qlever_local_runtime`。
