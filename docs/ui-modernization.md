# Xpod 前端设计原则与参考系

> **桌面规格对齐（2026-10-02）**：[10/1 桌面 Shell/applets 规格](superpowers/specs/2026-10-01-xpod-desktop-shell-and-applets-design.md)及其 §9 控制本轮入口、布局与共享 applet；旧 R2 四入口和尺寸为历史。[联合体验 R6](../../homepage/docs/specs/personal-ai-product-experience-r6.md)规定 LinX 工作/知识/我的 AI 与 Xpod 资产、授权、运行恢复的交接。业务权威、权限和数据归属不随导航合并。

> **跨模块自查入口（2026-09-27）**：[产品与体验纲领](product-design-charter.md)统一产品职责、交互判断、品牌映射与规范裁决；[AI 自查模板](product-design-self-review-template.md)统一交付方式。本文继续负责前端组件、布局协议和实现归属。本轮布局与窗口以[根设计入口](../DESIGN.md)汇总的 10/1 规格及合并合同为准；[R2 产品体验 spec](superpowers/specs/2026-09-27-xpod-product-experience-spec.md)中未被覆盖的可访问性、状态与领域安全约束继续有效。本文不另定主题或业务事实。旧视觉描述不能覆盖新选定品牌；`success / warning / destructive` 的语义继续保留，具体配色由公共主题统一映射，不由页面自行添加。主站未覆盖的深色主题不等于取消产品已有系统主题要求。

> 本文规定前端的组件与归属边界，不证明当前发布包已完成迁移。旧版内容描述的 EJS/Vanilla 实施路线、Neo-Brutalism + Glassmorphism 视觉方向、默认 Dark Mode 已废止；前端方案以 React/Vite、`@undefineds.co/shared-ui` 和 `@undefineds.co/extension-sdk/react` 为基线。认证展示的具体范围以[9 月 6 日前端重设计](superpowers/specs/2026-09-06-auth-frontend-redesign.md)为准，认证与 Pod 生命周期以[9 月 19 日 canonical](superpowers/specs/2026-09-19-xpod-login-and-host-design.md)为准。

## 1. 当前产品组织

Shell rail 上方放 **Tasks、AI 连接、Pod**，下方放宿主的**这台设备、设置**。前三者使用双宿主共享的 applet body，需要 WebID；本机设备与设置按宿主权限可匿名访问。Tasks 的数据可在两个宿主内编辑；知识页暂不做，聊天和训练表单仍归原业务 owner。旧的 `status`、`network`、`ai-connections`、`ai-config`、`settings` 是路由或业务模块，不再逐一决定顶层导航。遗留 `dashboard` 作为兼容入口处理，不新增第二套导航。

| 入口 | 内容组织 | 保留的业务边界 |
| --- | --- | --- |
| Tasks | 任务、待办、运行详情与待确认事项；两个宿主复用同一 body | Task/Run/Approval 事实与权限留在各自领域；同一次运行续接不等于重新提交 |
| AI 连接 | 常驻服务商目录与连接；Xpod 密钥及其应用配置 | 提供方凭据、Solid 客户端凭据、Foundry 发布及 runtime 观察分别保留原 owner |
| Pod | 模型设置、检索与索引、授权应用、数据管理 | 需要 WebID/目标 Pod 权限；Pod 清单和新建仅在 Account 页面，原 `/settings/pod` 创建表单不再作为当前要求 |
| 这台设备 / 设置 | 网络访问、服务状态、运行设置、日志及宿主偏好 | 本机宿主授权不以 WebID 登录为前提；Account 管理仍在账号服务页面 |

概览入口删除；状态通过各页一行结论和托盘表达，消费领域事实，不合成健康或认证状态，可选 AI 未配置不报警。服务、用量、索引保留稳定详情链接。RDF、FTS、Vector、cache、slow queries、benchmark 等留在专业详情，不占据无关任务的首屏。长期 Grant、导入/导出/跨设备迁移、多隧道等依赖新规格 §10，未接入时明确标待接入，不用设计状态冒充执行结果。

前端分层：

```text
@undefineds.co/shared-ui
  纯展示组件、语义 token、基础交互、通用 WebID 展示

@undefineds.co/extension-sdk/react
  状态/能力/布局协议适配，不拥有视觉系统

ui app / applet
  业务数据、产品文案、路由、页面组合
```

## 2. 不可突破的边界

### 2.1 shared-ui

`shared-ui` 只负责：

- Button、Card、Input、Badge、Dialog、Switch、Toast 等 primitives
- `AuthSurface` 等无业务展示容器，以及 WebID 登录、恢复、跳转、回调等待和协议错误的通用视图
- 通用 WebID 资源选择/发现的纯展示；不得拥有 Xpod Account 的注册、CSS consent 或 Pod 创建业务
- Tailwind semantic token、focus 样式、`cn()` 合并规则
- 可通过 props/copy 注入的展示状态和文案

`shared-ui` 不负责：

- 网络请求、路由、Solid、Pod、账户业务
- 具体产品文案、Xpod Account 表单和业务步骤
- 页面级布局协议
- 与宿主能力耦合的状态机

### 2.2 extension-sdk/react

`extension-sdk/react` 只负责：

- `AppLayout`、`TwoPaneLayout` 等布局协议：统一 rail、对象/配置导航与内容区，响应式共享一次实现；applet body 不复制宿主导航
- Solid/auth boundary 的状态到视图适配
- 宿主能力注入和回调接线

它不应重新实现 shared-ui 已有视图，也不应烘焙不可覆盖的用户可见文案。适配只消费既有 authority；不能新增 Account + WebID + Pod 组合会话，也不能因为安装了 provider 就让所有路由启动 WebID 恢复。

### 2.3 ui app / applet

应用层负责：

- 业务数据加载与状态映射
- 产品文案与国际化输入（包括中文文案）
- Xpod Account 登录、注册、找回/重设、CSS consent，以及 Pod 管理的表单与业务步骤；复用基础 primitives，不把业务下沉 shared-ui
- 路由和页面组合；由应用宿主按显式场景选择窗口几何与恢复焦点，layout 或表单不操作宿主窗口
- 通过 shared-ui primitives 搭建页面

应用层不得复制 Button、Card、Input 等基础组件，不得绕过 package exports 引用内部文件。

## 3. 视觉风格原则

1. **Token 先行**：颜色、圆角、阴影、间距均来自 `shared-ui/theme.css` 的语义 token；禁止字面色值和页面级私有主题。
2. **Primitive 唯一**：同一语义的 Button、Card、Input、Badge、Select 只有一份实现；差异通过 variant 或 `className` 表达。
3. **同类交互同构**：primary/secondary/destructive/ghost、hover/focus/disabled/selected 在所有 surface 一致。
4. **一个场景一个外壳**：WebID 与 Account 登录复用适合短流程的容器，桌面宿主统一登录窗口；Account 管理继续用文档/工作区布局。产品用 `AppLayout`，对象和配置导航按当前任务组织。业务 body 不叠第二层宿主外框或固定高度滚动。
5. **统一 Shell 分栏**：rail 64 px、对象栏 270 px、头部 48 px；rail 图标具备可访问名称。窄窗使用共享导航抽屉和返回行为，各页面不另写导航或焦点协议。
6. **品牌映射统一**：浅色主题采用已选定的纸色画布、墨紫操作和深色文字，通过 shared-ui 语义 token 统一落地；使用选定 Xpod 留缝折角 Logo 与对应尺寸资产，保留旧资产。具体值与浅/深色、状态、托盘资产映射入口见产品体验 spec。不恢复旧版 Neo-Brutalism/Glassmorphism 方向，也不把紫色用作全部状态色。
7. **密度属于产品**：功能界面使用无衬线、清晰行组和稳定控件密度。官网 Hero、书信排版、section 大留白不进入常规工作区；窄窗、放大文字和长错误的完整可达性优先于固定高度。
8. **跟随系统主题**：公共主题、页面首帧和宿主窗口背景共同响应系统；深色主题由公共设计一次定义，不由模块私配，也不因官网只有浅色就取消现有深色能力。

### 3.1 布局与密度契约

以下同步 10/1 规格和用户 10/2 最新纠正后的宿主窗口合同；R2 的 184/224 px 导航仍为历史值。短登录采用微信式窗口尺寸，完整文档流程使用工作区：

| 场景 | 要求 |
| --- | --- |
| 宽窗 Shell | 默认内容视口 1280 × 800，对应 10/1 canvas；rail 64 px；对象栏采用规格 260–280 px 范围内的 270 px；列表及内容头部 48 px，每屏一个标题 |
| 窄窗 | 共享导航抽屉与对象返回，保留任务标题、选中、位置和焦点；Escape 关闭后恢复触发点 |
| 桌面登录窗口 | WebID 与简短 Account 登录、恢复、回调采用 280 × 400 原生逻辑 bounds（最小同尺寸），内容填满扣除标题栏后的视口；注册、完整 Consent、首次 Pod 与 Account 管理使用工作区文档布局 |
| 桌面精确指针 | 普通控件/可操作行最小 36 px；只读诊断行 28–32 px；双行对象最小 56 px |
| 粗指针 | 可操作目标最小 44 px，双行对象最小 60 px |
| 认证 | 主操作最小 44 px；登录流程与 Account 管理按各自内容布局，长错误和 200% 文字完整可达 |

密度通过分组、层级与有意义的行距控制，不通过缩小字体实现。高度是下限；长文案、错误和字体放大允许增高。诊断的只读密度不授权缩小按钮/复制等操作命中区。窗口变化保留选中目标、安全输入和深链上下文。

知识来源精读和模型评估对照按阅读/比较任务组合公共控件，不强制套用28–32px诊断行、单表单或短认证小窗。此要求不把LinX/Foundry编辑业务移入本机控制器；资源详情的去向和返回由应用路由决定。字段多时优先呈现会改变决定的来源、版本、范围和差异，再展开技术细节。

## 4. 交互原则

1. **可访问性默认完成**：语义 HTML、正确 `aria-*`、键盘可达、modal focus trap、Escape 关闭、错误 `role="alert"`。
2. **Focus 只有一种语言**：使用 shared-ui 的 `controlFocusClass` / `interactiveFocusClass`；不叠加 ring，不画双层框。
3. **状态如实投影**：分别消费 Account、WebID、Pod、表单及资源的领域状态；loading、错误、空数据等有对应 UI，但不把这些词拼成新全局状态机。等待反馈时机采用产品体验 spec；展示计时不改变认证事实。异步提交期间防重复，重试保持原操作范围。
4. **文案注入**：shared-ui 的无业务视图可提供中性默认值，宿主/产品注入具体文案与国际化输入；SDK 不新增不可覆盖的用户可见文案。
5. **反馈统一**：成功、警告、失败、进行中使用统一 Badge/Toast/alert 语义；通知位置和 z-index 不散落。
6. **任务连续，深链稳定**：本机页面按当前 applet 与宿主入口组织；同 surface 内使用客户端路由，跨 surface 恢复合法原对象、版本、用途/客户端及返回位置。AI连接与用途、空间搜索状态与策略可以同处任务流；修复后重验权限、材料范围、版本及成本，不自动提交训练或创建替代Key/Pod。具体四条路径复用产品体验spec §7.7，不能复制业务逻辑或扩大权限。
7. **后果与确认相称**：删除资料、扩大访问或停止服务等有实际后果的操作明确对象、范围和恢复能力，按领域契约确认；普通可逆保存不统一增加确认弹窗。不能只靠颜色表达风险。
8. **观察不能替代业务事实**：发布目标、runtime版本、客户端选择、Run使用记录分别投影其owner；取消请求不冒充已停止，修复依赖不冒充Run完成，索引覆盖不冒充已训练。缺少版本/进度/关联证据时标明未知，不由SDK合成。
9. **身份与资产不因视觉合并**：产品切号遵守X-1，单层退出明确命名；训练用途不由读权限推导。备份和迁移视图列真实字节、外部store与恢复范围；已发布模型不是缓存。停止/升级影响按本机、远端和调度分别呈现，未定义协议交回原owner。

## 5. 参考系

### 5.1 产品参考：Agent OS / Desktop App Shell

本规范的 Xpod 本机前端是管理空间资产、权限、覆盖、AI 接入和服务恢复的桌面控制面，不等于完整 Xpod 产品。Agent OS 是技术定位，不要求用户先学习架构；状态看得懂、操作可控、诊断可达、键盘可用。日常工作/知识/我的 AI 由 LinX 承接，通过稳定资源定位往返，不复制其工作流，也不因资料归属叙事改成网盘首页。

### 5.2 桌面参考：Apple HIG

Apple HIG 是桌面交互的一级参考：

- System Settings 的设置信息层级
- Sheet/Alert 的模态语义
- 窗口层级、键盘导航、focus 与动效克制
- 认证和授权弹窗的紧凑、清晰、低干扰

只借交互模型和信息层级，不复制 Apple 视觉皮肤。

### 5.3 组件 API 参考：shadcn/ui + Radix

组件 API 形状、cva variants、Slot 组合、forwardRef 习惯参考 shadcn/ui 与 Radix；实现只能由 `shared-ui` 持有。

### 5.4 SaaS 密度参考：Linear / Vercel / Stripe

- Linear：workspace 信息密度、导航和状态切换
- Vercel：状态页、服务页、设置页的信息层级
- Stripe：表单、错误、空状态、克制的高级感

### 5.5 授权参考：GitHub / OIDC 授权页

Consent 页面参考 GitHub OAuth 与标准 OIDC 授权体验：明确 client、权限、目标账号、Allow/Deny，不做过度品牌包装。

### 5.6 移动与对话参考：WeChat / WeUI

WeChat 只作为移动端和对话场景参考：

- 列表密度、Action Sheet、触摸操作反馈（不据此为 Xpod 引入底部 Tab）
- 二维码/授权确认路径
- 聊天消息流与窄屏操作

不把 WeChat 的品牌色、组件皮肤或小程序限制搬进 Xpod。

## 6. 收敛规则与历史债务

以下是归属规则。旧稿点名的文件和组件是历史待核对项，不能据此宣称当前版本仍有重复实现，也不能跳过消费者核对直接删除共享导出。

1. 应用层已有 primitive 若确为 shared-ui 的重复副本，应收敛到公开出口；先区分业务组合与真正 fork，不删除必要业务视图。
2. workspace 布局协议归 extension-sdk，shared-ui 提供其所需视觉 primitives；收敛为 R2 的文字导航、按需对象列及共享窄窗行为。复用布局能力不等于保留旧强制三栏；迁移时保留宿主、applet 的必要权限与任务契约。
3. `StorageSelectionView` 只有无业务资源选择展示可以进入 shared-ui；绑定发现由 SDK 消费权威，Xpod Account 的 Pod 清单、显式创建及恢复编排归 Xpod，不能因视图名称相似一并下沉。
4. WebID 的 `LoginCardShell`、`AuthSurface` 等容器按 9 月 6 日契约收敛；Xpod Account body 与 WebAccount layout 保留自身职责。历史导出有其他产品消费者时先安排兼容迁移，不能用“一种外壳”强制删掉所有 Account 页面布局。
5. Account/About/Chat 等页面复用公共按钮、输入框和焦点规则，业务表单及页面组合仍由各自应用拥有。
6. 用户可见文案由 app 注入；SDK/shared-ui 的默认值仅为中性兜底。共享视图不得携带具体产品的 Account、授权或创建流程。
7. 成功、警告、失败保留 `--success`、`--warning`、`--destructive` 语义；主题色值、前景/背景组合、焦点与选中反馈由公共主题统一，页面不复制。

任何清理必须先核对实际前端引用和兼容消费者，独立记录“目标归属 / 当前表达 / 待迁移项”。本文本轮仅修正规范，不执行代码删除。

### 6.1 旧 workspace 导出的兼容例外与迁移入口

`shared-ui/workspace.tsx` 暂时保留 `TwoPaneWorkspace`、`useAppletLayout` 及 `AppletListItem` 的隐式切 pane 行为，仅作为已知 LinX 分支的兼容例外，不是新的布局入口。2026-10-02 核对：Xpod 产品源码无这些消费者；LinX 的 `61e6` 工作树、`codex/applet-packages` 与 `codex/pod-ai-gateway-linx` 分支仍有 AI Connection 页面或 standalone host 消费，使用各自的 `0.1.0` workspace 包。此证据不代表它们已消费 Xpod 当前发布包，也不代表跨仓库迁移完成。

迁移统一到 `@undefineds.co/extension-sdk/react` 的 `TwoPaneLayout` 与 `useWorkspaceLayout`：宿主将原 header 显式映射到 `listHeader` / `mainHeader`，`wide` / `narrow` 对应 `split` / `stack`；消费者在原选择操作后显式调用 `openMain()`，`backToList()` 改用 `openList()`。返回及上下文折叠文案通过布局的可选 `copy` 注入，未传字段保留现有中性默认值。本轮及以后新增调用一律使用 SDK；shared-ui 继续拥有视觉 primitives，不得反向导入 SDK 来转发旧协议。

本节是旧出口的唯一迁移说明。移除条件：所有上述已知消费者完成迁移并验证窄窗返回、选择、焦点和历史行为；重新核对公开导出及其他实际消费者，并在对应包升级中记录 API 变更。满足前保持旧出口行为，满足后删除旧导航 context / hook / wrapper，保留无协议的列表视觉 primitive；不得把“预稳定版本”当成已经完成消费者验证。

## 7. 新代码检查清单

提交前端代码前，逐项确认：

- [ ] 是否只从 `@undefineds.co/shared-ui` 或 `@undefineds.co/extension-sdk/react` 的公开出口导入？
- [ ] 是否没有复制 shared-ui 已有 primitive 或布局协议，且没有以复用为理由强制所有页三栏？
- [ ] 是否没有字面色值、私有 focus、私有 z-index、私有页面壳？
- [ ] 是否所有用户可见文案都可由宿主/产品注入？
- [ ] 是否键盘可达、focus 正确、错误状态可感知？
- [ ] 是否同 surface 内使用客户端路由，跨 surface 能恢复 deep link？
- [ ] 是否没有为了当前页面引入“以后再说”的第二份实现？
- [ ] Account、WebID、Pod 是否沿用领域权威，局部资源失败不会全局锁住无关路由？
- [ ] Web Account 文档、WebID 短流程、宿主窗口是否各按场景使用一个容器，未互相套用尺寸？
- [ ] 等待、错误、空态、禁用、焦点、选中以及系统浅/深色是否采用统一主题与反馈契约？
- [ ] 是否区分设计要求、前端表达和发布验证，未把历史文档标签当成当前版本通过？
- [ ] 是否采用 Tasks、AI 连接、Pod 与本机设备/设置入口，共享 applet body 并保留原对象返回，未恢复旧 R2 四入口或复制训练表单？
- [ ] 各页与托盘是否先表达可用结论和问题影响，服务正常时一行摘要，且可选 AI 未配置不报警？
- [ ] 对象/配置导航是否对应当前任务，空态是否有实际下一步，窄窗抽屉、返回与焦点是否完整？
- [ ] 精确指针、粗指针和认证操作是否按统一密度区分，字体未被缩小，长文案仍完整可达？
- [ ] 服务/用量/索引专业详情是否有稳定入口，网络设置是否仅呈现实际支持方法，旧深链是否落在正确任务与对象？
- [ ] AI 导航合并、空间搜索状态/策略/重建聚合后，是否仍使用原业务 owner 与权限，未创造第二份配置事实？
- [ ] 是否按R2 AC-15–20列出四条原对象路径、版本事实来源、续接/取消/重试、生命周期影响、模型资产携带及范围/位置/费用证据，未由共享组件发明业务协议？
- [ ] 产品切号与单层退出是否明确区分，已发布模型是否未被当作缓存，缺测量/版本/恢复证据时是否准确表达未知？
- [ ] 阅读、来源核对和评估对照是否有合适内容区域、窄窗返回和焦点，未强用诊断行密度或短认证尺寸？
