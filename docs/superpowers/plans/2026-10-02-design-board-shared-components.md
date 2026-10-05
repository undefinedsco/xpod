# 桌面外壳画板 → 共享组件提取计划

日期：2026-10-02
状态：初版为只读盘点（历史阶段，见 §1）；本组件切片**已完成落地、评审修复与受控验证**，当前状态见 §0.1，已交付 API 与实际消费方见 §0.2。
范围：`docs/superpowers/specs/assets/2026-10-01-xpod-desktop-shell/` 画板中反复出现的**视觉结构与状态表达**，对照现有 `@undefineds.co/shared-ui`、`@undefineds.co/extension-sdk/react` 与真实消费方，给出可提取清单、API、归属、抽取顺序、并行切片、清理与验证方案。

依据：
- `docs/superpowers/specs/2026-10-01-xpod-desktop-shell-and-applets-design.md`（§1 S-01…S-08、§12 分期与门禁）
- `docs/ui-modernization.md`（§2 边界、§3 视觉、§6 收敛规则、§6.1 旧 workspace 兼容例外）
- `docs/superpowers/plans/2026-10-02-shared-component-consolidation.md`（已落地的 SearchInput / NativeSelect / Textarea / Checkbox / FormField / EmptyState / Radix Select）

---

## 0. 结论摘要

- 画板里真正反复出现的不是"输入框"，而是**一批状态/结构外壳**：状态点与状态词、同行内提示条、区块头、列表容器与对象行、标签-值详情网格、分段选择、可选项卡片、容量条、设置开关行、方形实体标、`待接入` 标记、列表头工具条。
- 现有公共层已经覆盖基础控件（Button/Card/Input/Badge/Dialog/Switch/Avatar/Select/SearchInput/FormField/EmptyState/Toast/Tooltip 等），**不得重建**。本计划只做增量。
- 已从源码证据识别出真正"确实缺失且有多消费方"的后补组件为：反馈/结构/选择三类（StatusDot/StatusLine、InlineNotice、SectionHeader、ListSurface/ListRow、SettingRow/SwitchSettingRow、SegmentedControl、Badge `pending` variant）；`Meter` 在 AI 额度卡有真实消费方并已随本轮落地。**2026-10-02 复核修正**：候选清单里的 `RadioCardGroup`/`ChoiceCard`、`EntityTile`、`CollectionHeader` 按"当前实现消费者"口径均不成立，见下条与 §4。
- 归属修正：`CollectionHeader`（搜索 + 动作）只是视觉列表头，**归 shared-ui 或复用现有 `PaneListHeader`，不归 extension-sdk**，除非出现真实的布局/能力协议需求；`EntityTile` 优先扩展既有 `Avatar` 的方形形态，不新建包装；`RadioCardGroup` 待真实消费方（目前仅 tasks 的 radio fieldset 与 shared-ui 内部 pod-sign-in，不属本轮 AI/Pod 采用面）出现再评估。另有 3 项（DescriptionList、RailNavItem、NetworkPanel body）标为条件性/不归 shared-ui。
- 业务语义（任务、AI 凭据、Pod 生命周期、路由、权限）留在各自 applet/app；布局协议留在 extension-sdk；shared-ui 只收纯展示。
- 抽取后按**文件独占**方式切成可并行的实现切片；`shared-ui/src/index.ts` 等唯一出口由单一"接线 owner"串行追加，避免并行冲突。

### 0.1 实施与验证状态（2026-10-02，实现后）

- 已落地组件：`StatusDot`/`StatusLine`、`InlineNotice`、`SectionHeader`、`ListSurface`/`ListRow`、`SettingRow`/`SwitchSettingRow`、`SegmentedControl`、`Meter`、`Badge` `pending` variant；由 `packages/shared-ui/src/index.ts` 统一导出，未删除任何既有导出或旧 workspace 兼容出口。
- 未新增 `RadioCardGroup`/`ChoiceCard`、`EntityTile`、`CollectionHeader`（无实现消费方，见 §4）。
- 只读评审（`asset-review-report.md`）发现的问题已处理：F1 tasks 焦点、F2 分段密度、F3 最小高度、F4 class-snapshot 测试清理、F6/F7 组件健壮性、F8 文档漂移、F9 中性态配色均修复；F5 以理由保留（Radix `Switch` 根为可关联的 `<button>`）。
- 验证检查点（最新全局检查点，2026-10-02）：`build:packages`（7 包）、root `build:ts`、`typecheck:test`、UI `eslint`、UI `build:all`（app/dashboard/settings）、`desktop` build 全部通过；全量单测 `bun run test -- --maxWorkers=4 --minWorkers=1` = **747 文件通过 / 44 跳过（791）；7324 测试通过 / 309 跳过 / 1 todo（7634）**，完整 `bun run test:integration` 的 **lite 与 full 均通过**（全局重跑在 Matrix 生产修复后完成，见 `.test-data/opencode-shared/matrix-full-verification-done.json`）；shared-ui 源语单测 26 文件 / 189 测试；真实 Chromium 与原生 Electron 受控 QA **46/46 通过**（深浅主题 canonical token 与对比度、键盘、`FormData`、precise 36 / coarse 44、320/390/320+200/390+200 与长文案）。私有 QA harness 曾误用 `light dark` 根类导致深色 token 被 `.light` 覆盖，已修正后复验（属 harness 缺陷，非产品缺陷）。
- 独立的纯组件 harness 只验证共享组件在真实渲染引擎中的语义与 token，**不等同于真实 Xpod 完整流程**：本切片未做在线已认证 OIDC/后端联调，也未做画板运行时的像素级验收。全局单测与 `test:integration`（lite/full）已通过、Matrix 生产修复已完成，但**真实桌面端到端验收与发布仍未完成**（发布归对应 owner）；受控 QA 46/46 不得表述为真实 Xpod 或像素验收通过。
- 已知缺陷（已修复，见 §0.3）：窄窗+放大文字下 `SegmentedControl` 曾溢出；在固定 320px 容器、200% 文字下量测为 `scrollWidth 340 / 组宽 324`，而 `SettingRow` 与 `ListSurface/ListRow` 单独不溢出。根因是 `SegmentedControl` 选项文案 `truncate whitespace-nowrap` 抬高 min-content；已改为允许收缩换行并复验。320+200 与 390+200 组合现均通过；仍不据此宣称真实 Xpod 端到端或画板像素通过。

### 0.2 已交付公共 API → 实际模块消费方

| 公共 API | 实际消费方（实现文件） | 用法要点 |
|---|---|---|
| `StatusDot` | `packages/ai-connections/src/AiConnectionsList.tsx`、`ui/src/layout/XpodProductLayout.tsx`、`ui/src/shell/ShellHeaderControls.tsx` | 列表/通知无 `label` → 装饰点；rail attention 带可访问名 |
| `StatusLine` | `ui/src/components/ui/StatusBar.tsx`、`ui/src/layout/XpodUserCard.tsx` | 点 + 可见状态词 |
| `InlineNotice` | `ui/src/shell/ShellHeaderControls.tsx`、`packages/ai-connections/src/AiGatewayKeysSection.tsx`、`packages/ai-connections/src/AiConnectionsList.tsx`、`packages/tasks/src/TasksPanel.tsx` | `role` 由调用方给，`action` 槽被使用 |
| `SectionHeader` | `ui/src/pages/device/DevicePages.tsx`、`packages/ai-connections/src/AiGatewayKeysSection.tsx`、`packages/ai-connections/src/AiCredentialPoolSection.tsx`、`packages/pod-settings/src/PodBody.tsx` | level 2/3，`actions` 槽被使用 |
| `ListSurface` / `ListRow` | `ui/src/pages/device/DevicePages.tsx`；`ListSurface` 另用于 `AiGatewayKeysSection.tsx`、`AiSortableCredentialList.tsx` | 非交互行保持语义容器；AI 容器用 `asChild` 保留 ul/li 或原拖动 div/ref |
| `SegmentedControl` | `packages/tasks/src/TasksPanel.tsx` | 筛选/视图/计划类型，真实 radio 组 |
| `SettingRow` | `packages/pod-settings/src/PodBody.tsx` | `control` 渲染既有 `Checkbox` |
| `SwitchSettingRow` | `ui/src/pages/device/DevicePages.tsx` | 复用共享 `Switch` |
| `Meter` | `packages/ai-connections/src/AiQuotaCard.tsx` | 有值 progressbar，无值装饰 |
| `Badge variant="pending"` | `packages/pod-settings/src/PodBody.tsx` | 纯视觉“待接入” |

### 0.3 已知缺陷修复：320px + 200% 分段选择溢出（已修复并复验）

- 复现与归因：在固定 320px 宽、真实内容约束的容器内分别挂载各原语，量测 `scrollWidth/clientWidth`（私有 `repro.mjs`）。320px + 200% 时 `SegmentedControl` 容器溢出（`scrollWidth 340` vs `320`，`role=radiogroup` 324px 且 `inline-flex nowrap`），长标签变体 337px；`SettingRow` 与 `ListSurface/ListRow` 单独**不溢出**；`Switch` 按钮自身有约 2px 内禀差（`scrollWidth 74` vs `72`）但容器不溢出。此前 harness 用 `display:grid` 隐式 `auto` 轨道，被 `SegmentedControl` 的 min-content 撑宽后使 `SettingRow` 看起来溢出——属测试容器伪像，非 SettingRow 缺陷。
- 根因：`SegmentedControl` 选项文案 span 使用 `truncate whitespace-nowrap`，在窄窗+放大文字下把 min-content 抬到容器之上。
- 修复（公共原语）：允许选项文案收缩换行（`min-w-0 break-words text-center`，去掉 `nowrap`/`truncate`）；正常宽度保持单行外观，窄/放大时增高（高度是下限）。保留原生 radio、roving tabindex、方向键/Home/End、`FormData`、焦点语言；保留精确指针 36px 与粗指针 44px 下限。
- 私有 harness：根容器由 `display:grid` 改为真实宿主面板的纵向 flex（子项拉伸到容器宽），测试矩阵补齐 **320+200%、390+200%、长文案**，不隐藏溢出、不强制字体、不删长文案、不省略 320+200。
- 回归方式：真实浏览器量测溢出 + 长文案可读/可交互（不新增 class/实现快照断言）。
- 实施结果：`packages/shared-ui/src/segmented-control.tsx` 选项文案 span 改为 `min-w-0 break-words text-center`。隔离复现 RED→GREEN：320+200 下 `SegmentedControl` 由 `scrollWidth 340 / 组宽 324` 降为 `320 / 288`（不再溢出），`SettingRow`/`ListSurface` 仍不溢出。受控 QA 扩到 **46/46 通过**，含 **320+200**、**390+200**、长文案、字体对比度、键盘（方向键/Home/End）、`FormData`、precise 36 / coarse 44；私有 harness 根容器改为纵向 flex。目标证明：`build:packages`、root `typecheck:test`、shared-ui 26/189、tasks 3/12、UI `eslint` 与 `build:all` 均通过；全量单测按约定交由 Matrix 修复后统一重跑，现全局检查点为 747 文件 / 7324 测试通过（见 §0.1）。源语单测用 jsdom 无法量测布局，故回归以真实浏览器量测为准，未新增实现快照断言。

---

## 1. 证据方法与边界

> 历史阶段说明：本节记录**实施前的初版只读盘点方法**，当时未改产品源码。实现、评审修复与验证结果见 §0.1；实施后源码状态以仓库为准。

- 画板为 Design 画板运行时格式（`*.dc.html` + `canvas.json`），以场景结尾的文件只是 `<dc-import>` 外壳（`README.md:7`、`AiConnect.dc.html:16`）。已读主画板：`Main`、`Nav`、`LinxRail`、`HostBar`、`IdentityMenu`、`Device`、`NetworkPanel`、`Tray`、`NarrowDevice`、`NarrowDrawer`、`Ai`、`Task`、`Pod`。
- 画板里的颜色为字面色值；真实实现必须映射到 `packages/shared-ui/src/theme.css` 语义 token（`--success`/`--warning`/`--destructive`/`--primary`/`--muted-foreground` 等，见 `theme.css:4-63`、`:69-119`）。缺 `--info` token，`info` 映射 `--primary`，**不新增 token**，避免触碰共享主题文件。
- **初版盘点只做源码分析，不是像素验收**。仓库不含画板运行时（`README.md:9-11`），无法本地渲染；像素级验收仍需另起真实画板并截图 1280/390/200% 文字/深浅主题（`design §12 门禁`）。§0.1 的受控 QA 只证明共享组件在真实引擎中的语义与 token，不等同于画板像素验收，本文件不宣称视觉通过。
- 初版盘点未启动任何构建/测试/服务，未改产品源码，未读取或输出凭据；实现后的验证记录见 §0.1。

---

## 2. 画板 → 组件 → 消费方矩阵

约定：`锚点` 格式为 `资产文件:行` 或 `源码文件:行`。"现有"= 已有可复用实现；"缺失"= 需新增。

| # | 反复结构 | 画板锚点（反复出现） | 现有实现 | 真实消费方（可迁移） | 结论 |
|---|---|---|---|---|---|
| C1 | 状态点 / 状态词（tone: ok/warn/off/info） | `HostBar:17,39`；`NetworkPanel:46,128-140`；`Device:72,180-183`；`Ai:89,334,360`；`Pod:103,285,320-323`；`Task:129,147,159,256,274-276,327`；`Main:54`；`Nav:31`；`Tray:32,104` | 各处内联 class（`AiCredentialRow.tsx:66-75`、`account-parts.tsx:25-32,63`、`StatusBar.tsx:27`、`XpodUserCard.tsx:210`） | ai-connections、tasks、device、shell、pod-sign-in | **缺失，提取 `StatusDot`** |
| C2 | 同行内提示条（图标 + 文案 + 可选动作，role=status/alert） | `Ai:70-73,116-120`；`Task:180-184`；`Pod:210`；`NetworkPanel:76-81` | 内联（`ShellHeaderControls.tsx:20-30,42-44`、`TasksPanel.tsx:120,133,135`、`DevicePages.tsx:43,70`） | tasks、ai-connections、device、shell | **缺失，提取 `InlineNotice`** |
| C3 | 区块头（h2 + 说明/meta + 右侧动作） | `Ai:64,111,144`；`Pod:93,159,172`；`Task:143,189`；`NetworkPanel:36` | 内联 h2/h3（`AiGatewayKeysSection.tsx:316-324`、`TasksPanel.tsx:107-113`、`DevicePages.tsx:44,48`） | ai-connections、tasks、device、pod | **缺失，提取 `SectionHeader`** |
| C4 | 列表容器 + 对象行（圆角描边、分隔线、最小行高、leading/trailing） | `Ai:76,123`；`Device:68`；`Pod:127`；`Task:145` | 内联（`AiGatewayKeysSection.tsx:341`、`AiCredentialRow.tsx:52-61`、`DevicePages.tsx:44,48,95`） | ai-connections、device、tasks、pod | **缺失，提取 `ListSurface`/`ListRow`** |
| C5 | 分段选择（胶囊容器 + 选中白底） | `Task:30-39,219-223` | 内联（`TasksPanel.tsx:104`） | tasks（后续 device/pod 视图切换） | **缺失，提取 `SegmentedControl`**（视觉泛型） |
| C6 | 可选项卡片（可选描边卡：标题 + 说明，选中主色边） | `NetworkPanel:58-65`；`Pod:195-203` | 仅画板；`NetworkPage.tsx` 隧道选项用 `select`，`PodBody` 用 `NativeSelect`，tasks 用原生 radio `fieldset` | 无（画板表达，尚无实现消费方） | **暂缓提取 `RadioCardGroup`/`ChoiceCard`**（等真实消费方，见 §4） |
| C7 | 容量/进度条（细轨 + 填充） | `Ai:84`；`Pod:105,165` | 内联 `role="progressbar"`（`AiQuotaCard.tsx:194-205`） | ai-connections（Pod 画板仅有表达，`PodBody` 进度为文本） | **缺失，提取 `Meter`（本轮已落地并采用于 AI 额度）** |
| C8 | 设置开关行（label + 说明 + Switch/控件） | `Device:87-91`；`Pod:80-85,113-118` | 内联（`DevicePages.tsx:71-72`）；`Switch` 已存在（`switch.tsx`） | device、pod | **缺失，提取 `SettingRow`（复用 `Switch`）** |
| C9 | 方形实体标（圆角方形 initials/品牌图） | `Ai:34,52,126,243`；`Pod:131,295`；`Main:24,44`；`Nav:18` | 已用圆角方形 `Avatar`（`XpodUserCard.tsx:175-178`、`AiConnectionsList.tsx:106-114` 直接以 `rounded-md` className 表达） | ai-connections、shell（均已用 `Avatar`） | **不新建 `EntityTile`；如需收敛，优先给 `Avatar` 加方形形态，本轮无采用证据** |
| C10 | `待接入` 标记（虚线描边 pill） | `Task:137,185`；`Pod:64,140,176` | `Badge` 无该 variant（`badge.tsx:6-19`） | tasks、pod、device | **缺失，给 `Badge` 加 `pending` variant** |
| C11 | 列表头工具条（搜索 + 可选新增/动作，48px） | `Device:23-26`；`Ai:24-28`；`Task:24-28`；`Pod:24-27` | `SearchInput` 已有；标题版 `PaneListHeader.tsx:1-3`；`DesktopWorkspaces.tsx:29` 手拼 | ui/app、tasks、ai-connections | **视觉件，归 shared-ui（或复用 `PaneListHeader`），不归 extension-sdk**；无真实布局/能力协议前不新建 `CollectionHeader` |
| C12 | 正方形图标按钮（36/32 ghost） | `HostBar:18,22`；`Ai:27,93,130,179`；`Task:27,85,133,211`；`Pod:133,192` | `Button variant=ghost size=icon` 已存在（`button.tsx:23-24`） | 全部 | **不新增，约定复用 `Button`** |
| C13 | 标签-值详情网格（110px 标签列） | `Task:87-91,135-141` | 内联 | 目前仅 tasks 一个真实消费方 | **条件性，暂缓**（见 §4） |
| C14 | rail 图标入口（active + 角标） | `Nav:23-33`；`LinxRail:18-30` | `getRailNavItemClass`（`nav-item-style.ts:23-30`）、`XpodProductLayout.tsx:34-58` | 仅宿主外壳 | **不归 shared-ui，见 §4** |
| C15 | 网络访问 body（检查项 + 隧道行 + 添加表单） | `NetworkPanel` 全篇；`Device:49`；`NarrowDevice:27` | `NetworkPage.tsx` 已有复杂实现 | device 与账号页设备行共用 | **不归 shared-ui**（含隧道目录/宿主能力业务），见 §4 |

已存在、**本轮不重建**：`SearchInput`、`NativeSelect`、`Textarea`、`Checkbox`、`FormField`、`EmptyState`、公开 `Select`、`Button`、`Card`、`Dialog`、`Switch`、`Avatar`、`Badge`、`Separator`、`Skeleton`、`Toast`、`Tooltip`、`ScrollArea`。

---

## 3. 组件 API / slots 设计（新增部分）

所有新组件：纯展示、无网络、无路由、无 Pod/账户业务；文案由调用方注入；只用语义 token；用 `cn()`；焦点样式复用 `focus.ts`。

### 3.1 `StatusDot` / `StatusLine`
- 文件：`packages/shared-ui/src/status.tsx`
- 类型：`export type StatusTone = 'success' | 'warning' | 'destructive' | 'info' | 'neutral'`（画板写 ok/warn/off/info，由调用方映射到这套规范名）
- `StatusDot({ tone, label?, size?: 'sm' | 'md', className? })`：`label` **可选**——给了 `label`/`aria-label` 时输出 `role="img"` + `aria-label`/`title`；省略时按相邻可见文案的装饰点处理（`aria-hidden`），不靠颜色单独表达（`design §1`、现有 `account-parts.tsx:45` 同约定）；`neutral` 用空心描边（对应画板 stopped/off）。
- `StatusLine({ tone, children, dotSize?, className? })`：点 + 文字（画板 `Device:72`、`Ai:89`、`Pod:103`）；点自身装饰，`children` 即可访问名。
- tone→token：success=`--success`、warning=`--warning`、destructive=`--destructive`、info=`--primary`（仓库无独立 `--info` token）、neutral=`--muted-foreground`。

### 3.2 `InlineNotice`
- 文件：`packages/shared-ui/src/notice.tsx`
- 类型：`export type NoticeTone = 'info' | 'success' | 'warning' | 'destructive' | 'neutral'`
- `InlineNotice({ tone?, title?, icon?, children?, action?, role?: 'status' | 'alert', className? })`（`tone` 默认 `info`）
- `role` 默认 `status`；错误类由调用方显式传 `role="alert"`（保留控制权，组件不按 tone 猜 role）。
- 图标按 tone 中性兜底，可被 `icon` 覆盖（图标恒为装饰）；`action` 为右侧动作槽；文案全部由调用方注入。

### 3.3 `SectionHeader`
- 文件：`packages/shared-ui/src/section-header.tsx`
- `SectionHeader({ title, description?, actions?, level?: 2 | 3 | 4, titleClassName?, className? })`
- `level` 决定 `h2`/`h3`/`h4`（默认 2）；`actions` 组合槽；`titleClassName` 让消费方调字号/字重（`DevicePages`、`AiGatewayKeysSection`、`PodBody` 均已用 level 2/3 + `titleClassName`）；不内置业务按钮。

### 3.4 `ListSurface` / `ListRow`
- 文件：`packages/shared-ui/src/list.tsx`
- `ListSurface({ asChild?, ...props }: ListSurfaceProps)`：纯展示的圆角描边 + `divide-y` 容器，不合成 `role=list/listitem`。默认 div；`asChild` 将样式/ref/事件组合到唯一子元素，保留真实 ul/li 或拖动容器。已有行自带分隔线时以 `divide-y-0` 覆盖公共分隔，不产生重复边框。
- `ListRow({ leading?, title?, description?, trailing?, asChild?, className?, ...rest })`：非交互行保持语义容器；交互行通过 `asChild` 传入真实 `button`/`a`，由调用方保留原生角色与焦点（无 `interactive`/`selected` 布尔）。
- 行以 `p-4` + 内容自然撑高满足密度契约（精确指针双行 56px 下限，`ui-modernization §3.1`）；组件本身不写死 min-height，长文案/放大文字可增高。

### 3.5 `SegmentedControl`
- 文件：`packages/shared-ui/src/segmented-control.tsx`
- `SegmentedControl<T extends string>({ value, onValueChange, options: { value, label?, icon?, disabled?, 'aria-label'? }[], ariaLabel, name?, size?: 'sm' | 'md' })`（`label` 省略即 icon-only，此时由调用方在选项上给 `aria-label`；`name` 省略时内部生成，保证仍是一组 radio）
- 语义：`role="radiogroup"`；每项原生 `input[type=radio]`（由 `checked` 表达选中）+ roving tabindex；键盘方向键切换、Home/End 跳首尾、跳过 disabled 项；`icon` 仅装饰，组件**不**据 icon 自动生成可访问名。
- 密度：`sm`/`md` 均为 `min-h-9`（36px，精确指针下限），`@media(pointer:coarse)` 提升到 `min-h-11`（44px）；高度是下限，长文案可撑高（选项文案 `min-w-0 break-words`，窄窗+放大文字允许换行）。

### 3.6 `RadioCardGroup` / `ChoiceCard`（暂缓，见 §4）
- 文件（若启动）：`packages/shared-ui/src/choice-card.tsx`——**当前不创建**：无实现消费方，避免死导出。
- 启动条件：`PodBody`/`NetworkPage`/tasks 真正迁移到选择卡形态后再落地，API 草案见下。
- `RadioCardGroup<T>({ value, onValueChange, options: { value, title, description?, disabled?, meta? }[], ariaLabel })`
- `ChoiceCard({ selected, disabled, children, className? })`：可单独用于非单选场景。
- 原生 `input[type=radio].sr-only` 包在 `label` 内保证表单语义；选中用主色描边。

### 3.7 `Meter`
- 文件：`packages/shared-ui/src/meter.tsx`
- `Meter` 为判别联合类型：`{ value: number; label: string }` 或 `{ value?: undefined; label?: string }`；公共项还有 `max?: number`（默认 100）、`tone?: MeterTone`（`'primary' | 'success' | 'warning' | 'danger'`，默认 `primary`）、`className?`。
- 有 `value` 时 `role="progressbar"` + `aria-label` 与 `aria-valuemin`/`aria-valuemax`/`aria-valuenow`（此时 `label` 必填）；无值（占位 `[流量]`）时 `aria-hidden`，由相邻文案表达。

### 3.8 `SettingRow`
- 文件：`packages/shared-ui/src/setting-row.tsx`
- `SettingRow({ label, description?, control, className? })`：`control` 是渲染函数 `(props: { id: string; 'aria-describedby'?: string }) => ReactNode`，调用方必须把 `id` 落到真实控件上，可见 label 才与控件关联（`PodBody` 用它渲染 `Checkbox`）。
- `SwitchSettingRow({ checked, onCheckedChange, disabled?, label, description? })`：复用现有 `Switch` 的便捷形态（不新增开关实现），内部以 `useId()` 提供关联 id。

### 3.9 `EntityTile`（不新建，见 §4）
- 结论：现有 `Avatar` + `rounded-md` 已表达方形实体标；如需统一，优先给 `Avatar` 增加方形形态，不新增 `EntityTile` 包装。
- 草案（如未来启动）：`EntityTile({ label, tone, size, className? })`，纯展示、不取图片。

### 3.10 `Badge` 新增 variant
- 文件：`packages/shared-ui/src/badge.tsx`（**改现有文件**）
- 追加 `pending: 'border border-dashed border-muted-foreground bg-transparent text-muted-foreground shadow-none hover:bg-transparent'`，用于 `待接入`。
- 本轮**只**加 `pending`；`success`/`warning` 未加入。若未来加入，需在使用侧约束语义，不与 `StatusDot` 重复。

### 3.11 列表头（列表头工具条，复核后归 shared-ui / 复用）
- 结论：**不新建 extension-sdk `CollectionHeader`**。搜索 + 动作只是视觉组合，现有 `SearchInput` 与 `PaneListHeader.tsx:1-3` 足够；如确有跨 applet 复用需求，收敛到 shared-ui 视觉件。
- 仅当出现真实的布局/能力协议需求（需要宿主注入布局、焦点、返回协议）时，才评估放进 `extension-sdk`。

---

## 4. 明确不提取 / 暂缓（附理由）

- **C13 DescriptionList（暂缓）**：目前只有 `Task.dc.html:87-91,135-141` 一个画板、`TasksPanel.tsx` 一个真实消费方；且字段语义（截止/重要/怎么来的）属任务业务。按"两处以上重复才抽取"的代码品味，先不做，等第二个真实消费方出现再评估。
- **C6 RadioCardGroup/ChoiceCard（暂缓，复核修正）**：原表把 `device/network`、`pod` 列为消费者，但当前实现里 `NetworkPage.tsx` 用 `select`、`PodBody` 用 `NativeSelect` 表达同类选择，只有 tasks 用原生 radio `fieldset`。没有实现消费方就不建立会变成死导出的组件；等 device/pod/tasks 真正迁移到选择卡形态再评估。
- **C9 EntityTile（不新建，复核修正）**：`ai-connections`/`shell` 现状已直接用 `Avatar` + `rounded-md` 表达方形实体标（`AiConnectionsList.tsx:106-114`、`XpodUserCard.tsx:175-178`）。按"优先扩展现有 `Avatar` 而非包装"原则，不新增 `EntityTile`；本轮无采用证据。
- **C11 CollectionHeader（归 shared-ui / 复用，复核修正）**：列表头（搜索 + 动作）只是视觉组合，`PaneListHeader.tsx` 已是现有标题版。没有真实布局或能力协议需求时，不把它放进 extension-sdk，也不新建第二份列表头原语。
- **C14 rail 入口（不归 shared-ui）**：rail 是宿主导航协议，`design S-01` 明确宿主只负责 rail。现有 `getRailNavItemClass` + `XpodProductLayout` 已是宿主实现；跨宿主（LinX）在第 61e6 工作树另有实现。**不改协议、不要新增第二套 rail 组件**；角标状态用 C1 `StatusDot` 表达即可。
- **C15 NetworkPanel body（不归 shared-ui）**：含 `TunnelProviderCatalog` 声明、宿主能力、install 检测与校验，属 device 能力；账号页设备行共用的应是**能力模块级 body**（如 `NetworkPanel` 提取到 device 能力包），不是 shared-ui 视觉件。本计划只记录，不实施。
- **旧 workspace 兼容例外**：`shared-ui/workspace.tsx` 的 `TwoPaneWorkspace`/`useAppletLayout`/`AppletListItem` 保持不动（`ui-modernization §6.1`）；新调用一律用 extension-sdk `TwoPaneLayout`/`useWorkspaceLayout`。
- 业务查询、路由、Pod 生命周期、AI 凭据状态机、任务执行、索引重建、设备控制：全部留在 owner，不因视觉相似下沉。

---

## 5. 归属与放置

```
@undefineds.co/shared-ui           视觉 primitives（C1-C5、C7-C8、C10）
  status.tsx / notice.tsx / section-header.tsx / list.tsx /
  segmented-control.tsx / meter.tsx / setting-row.tsx / badge.tsx(variant)
  （C6 choice-card、C9 entity-tile 暂缓；C11 复用/归 shared-ui 视觉，不归 SDK）
ui app / applet                    业务数据、文案、路由、组合、清理
```

- 所有新文件只 `import` 同层 `focus.ts`/`utils.ts`/已有 primitive，反向不依赖。
- 不新增 extension-sdk 导出（复核后 C11 不需要布局协议）；shared-ui 不得反向导入 extension-sdk。

---

## 6. 抽取顺序

1. **护栏**：先给将被清理的消费方补/确认行为回归（现有测试：`packages/shared-ui/test/*`、`ui/src/pages/device/*`、`packages/tasks`、`packages/ai-connections`）。无保护时先补有意义的回归再改实现。
2. **原子件（可并行）**：C1、C2、C3、C4、C5、C7、C8 各自新建文件 + 单测（C6、C9 暂缓；C7 `Meter` 本轮已由 integration 落地并采用于 AI）。
3. **既有文件增量**：C10 `Badge` variant（C11 复核后不需要新 SDK 组件；如需列表头视觉，先复用 `PaneListHeader` 或在 shared-ui 内收敛）。
4. **出口接线（串行）**：单一 owner 只在 `packages/shared-ui/src/index.ts` 追加导出。本轮**不**在 `packages/extension-sdk/src/react.ts` 追加导出（C11 不需要布局协议，见 §3.11、§4、§5）。此步不与组件文件并行修改同一文件。
5. **消费方清理（按模块分批）**：device → tasks → ai-connections → shell/pod。每批独立提交，删内联重复、保留业务。
6. **回归门禁**：见 §8。

---

## 7. 并行实现切片（文件独占，不共享出口）

下表用于并行派发；除标"串行"外，各切片只改列出的文件与对应新测试文件，互不重叠。

| 切片 | 交付 | 独占文件 | 测试文件 |
|---|---|---|---|
| A `status` | `StatusDot`/`StatusLine` | `packages/shared-ui/src/status.tsx` | `packages/shared-ui/test/status.test.tsx` |
| B `notice` | `InlineNotice` | `packages/shared-ui/src/notice.tsx` | `packages/shared-ui/test/notice.test.tsx` |
| C `section` | `SectionHeader` | `packages/shared-ui/src/section-header.tsx` | `packages/shared-ui/test/section-header.test.tsx` |
| D `list` | `ListSurface`/`ListRow` | `packages/shared-ui/src/list.tsx` | `packages/shared-ui/test/list.test.tsx` |
| E `segmented` | `SegmentedControl` | `packages/shared-ui/src/segmented-control.tsx` | `packages/shared-ui/test/segmented-control.test.tsx` |
| F `choice` | `RadioCardGroup`/`ChoiceCard` **（暂缓，§4）** | — | — |
| G `meter` | `Meter`（已由 integration 落地） | `packages/shared-ui/src/meter.tsx` | `packages/shared-ui/test/meter.test.tsx` |
| H `setting` | `SettingRow`/`SwitchSettingRow` | `packages/shared-ui/src/setting-row.tsx` | `packages/shared-ui/test/setting-row.test.tsx` |
| I `tile` | `EntityTile` **（不新建，§4）** | — | — |
| J `badge` | `Badge` 加 `pending`（本轮仅 `pending`，未加 success/warning） | `packages/shared-ui/src/badge.tsx` | `packages/shared-ui/test/components.test.tsx`（追加用例） |
| K `collection-header` | **（复核后取消；归 shared-ui/复用，§4）** | — | — |
| L `exports`（串行，依赖 A–E、G、H） | shared-ui 出口接线 | `packages/shared-ui/src/index.ts` | — |
| M `device-adopt` | device 页清理 | `ui/src/pages/device/DevicePages.tsx` 等 | 现有 device 测试 |
| N `tasks-adopt` | tasks 清理 | `packages/tasks/src/TasksPanel.tsx`、`packages/tasks/src/style.css` | tasks 测试 |
| O `ai-adopt` | ai-connections 清理 | `packages/ai-connections/src/Ai*.tsx` | ai-connections 测试 |
| P `shell-adopt` | shell/pod 清理 | `ui/src/shell/ShellHeaderControls.tsx`、`ui/src/layout/XpodUserCard.tsx` | shell 测试 |

冲突规则：L 独占 `index.ts`；M–P 按模块目录隔离。A–E、G、H 之间与 M–P 可并行；F、I、K 本轮取消。

---

## 8. 有界清理计划

> 口径说明：本节是**清理计划/意图**，不是"全部已完成"的清单。本轮实际已采用的子集（组件 → 消费方）以 §0.2 为准；本节未出现在 §0.2 的条目属后续可选清理，未采用不等于已交付。

每个消费方只做"删内联重复 → 换共享件"，不改业务：

- `ui/src/pages/device/DevicePages.tsx`：服务状态行 → `ListSurface`/`ListRow`；状态词 → `StatusLine`；运行设置两行 → `SwitchSettingRow`；错误/提示 → `InlineNotice`；区块标题 → `SectionHeader`。保留 `globalThis.xpodDesktop`、`fetchServicesStatusSnapshot`、`updateAdminConfig` 等业务调用。
- `packages/tasks/src/TasksPanel.tsx`：筛选/视图/类型选择 → `SegmentedControl`；运行/失败提示 → `InlineNotice`；运行行/区块 → `SectionHeader` + `ListRow`。保留 `TasksClient`、分组与选择逻辑、`openMain()` 协议。
- `packages/ai-connections`：凭据/密钥行状态点 → `StatusDot`；额度/进度 → `Meter`；容器 → `ListSurface`/`ListRow`；区块头 → `SectionHeader`；异常汇总条 → `InlineNotice`。保留 `AiConnectionsController`、`contract` 适配、`ProviderRuntimeAdapter` 分类。
- `ui/src/shell/ShellHeaderControls.tsx`、`ui/src/layout/XpodUserCard.tsx`：提示条/状态点/实体标替换；**保留**现有 `useShellState`、焦点恢复、portal 定位、`account-card-position` 行为。
- `ui/src/DesktopWorkspaces.tsx`、`PaneListHeader.tsx`：**不新建 `CollectionHeader`**（复核后取消，见 §3.11、§4）；保留 `PaneListHeader`，仅在需要时用 `SearchInput` 组合搜索变体。
- 删除项仅限"同一视觉被新组件取代"的内联块；不得删除业务视图、权限判断、路由或状态机。

---

## 9. 验证策略（编辑后执行）

1. 组件单测：每个新件的渲染、`role`/`aria-*`、tone→token、键盘（`SegmentedControl` 方向键/Home/End）、焦点唯一（沿用 `controlFocusClass`/`interactiveFocusClass`）。`RadioCardGroup` 本轮未落地（§4），不列其用例。
2. 回归：`bun run build:packages`（或包级 build）→ `bun run typecheck:test` → `bun run test`（含 `scripts/check-dependency-state.ts`）→ `bun run test:integration`。
3. UI 构建：`cd ui && bun run build:dashboard`。
4. 依赖状态：如新增 workspace 依赖需 `bun install` 更新 `bun.lock`；本计划**不新增外部依赖**。
5. 视觉验收（独立于源码分析）：起真实画板运行时，按 `design §12`/`README.md` 在 1280×800、390 宽、200% 文字、深/浅主题逐张对照；未完成前不得声称视觉通过。
6. 真实链路验收：按 `docs/cli-dev-testing.md`，AI 四项（Pod 读写 / Gateway 客户端认证 / `/v1/models` / `/v1/chat/completions`）分项报告，不以 mock/临时端口结果冒充。

---

## 10. 风险与开放问题

- **tone 词汇不统一**：画板用 ok/warn/off/info，`login/presentation.ts:6` 用 neutral/primary/success/warning/danger，`account-parts.tsx` 用 `DeviceStatus`。C1 采用 5 值 `StatusTone`，需要一次映射表收敛，不得在组件内做 provider/业务分支。
- **颜色语义**：`--info` 缺失，`info` 暂映射 `--primary`；若后续要做独立 info token，应单独走主题变更，不在本计划夹带。
- **`SegmentedControl` 与 `RadioCardGroup` 的语义边界**：前者是小尺寸视图/筛选切换（已落地），后者是带说明的选择卡（本轮未落地，见 §4）；若未来实现都要保留原生 radio 语义，避免退化成纯按钮组丢失表单可访问性。
- **清理误删**：`TasksPanel`/`AiGatewayKeysSection` 状态与权限耦合较深，迁移必须逐块核对，不整体重写。
- **向后兼容**：新增 shared-ui 导出不删除任何现有导出；旧 `workspace.tsx` 出口按 `§6.1` 保持。
- **并行协调**：唯一共享出口 `packages/shared-ui/src/index.ts` 由 L 单点维护（本轮 `react.ts` 不追加导出）；若实现者各自改出口，会与并行前提冲突，需在派单时明确禁止。

---

## 11. 资产与源码精确锚点索引

- 画板根目录：`docs/superpowers/specs/assets/2026-10-01-xpod-desktop-shell/`
  - 索引：`canvas.json`（`order` 于 `:421-466`）；说明：`README.md:7,9-11,24`。
  - 外壳：`Main.dc.html:17-114`（未登录 `:19-35`、个人卡片 `:41-63`、通知 `:65-86`、收件箱 `:88-113`）；`Nav.dc.html:16-34`；`LinxRail.dc.html:16-31`；`HostBar.dc.html:16-26`。
  - 设备：`Device.dc.html:19-123`（列表头 `:23-26`、服务行 `:65-79`、运行设置 `:84-101`、日志 `:104-118`）；`NetworkPanel.dc.html:19-94`。
  - AI：`Ai.dc.html:19-226`（列表 `:23-41`、当前连接 `:60-105`、密钥 `:107-140`、模型 `:142-168`、弹窗 `:174-225`）。
  - 任务：`Task.dc.html:19-240`（工具条 `:29-40`、列表 `:41-68`、待办详情 `:79-97`、任务详情 `:126-154`、运行 `:156-200`、新建弹窗 `:206-239`）。
  - Pod：`Pod.dc.html:19-218`（模型 `:47-74`、检索 `:76-122`、应用 `:124-154`、数据 `:156-182`、弹窗 `:187-217`）。
  - 托盘/窄窗：`Tray.dc.html:15-62`；`NarrowDevice.dc.html:17-29`；`NarrowDrawer.dc.html:16-37`。
- 源码：
  - shared-ui 出口：`packages/shared-ui/src/index.ts:1-104`；主题：`packages/shared-ui/src/theme.css:4-63`。
  - 已有原语：`button.tsx:7-49`、`badge.tsx:6-29`、`dialog.tsx:15-132`、`switch.tsx:9-39`、`avatar.tsx:5-45`、`select.tsx:7-113`、`search-input.tsx:9-23`、`form-field.tsx:19-35`、`empty-state.tsx:11-19`、`focus.ts:7-18`。
  - 本轮新增原语：`status.tsx`、`notice.tsx`、`section-header.tsx`、`list.tsx`、`segmented-control.tsx`、`setting-row.tsx`、`meter.tsx`（均由 `index.ts` 导出）。
  - 布局协议：`packages/extension-sdk/src/react/workspace-layout.tsx:265-553`、`app-layout.tsx:29-95`、`layout-context.tsx`。
  - 消费方：`ui/src/DesktopWorkspaces.tsx:23-54`；`ui/src/layout/XpodProductLayout.tsx:34-121`；`ui/src/layout/XpodUserCard.tsx:209-249`；`ui/src/shell/ShellHeaderControls.tsx:20-93`；`ui/src/pages/device/DevicePages.tsx:41-96`；`ui/src/pages/settings/PaneListHeader.tsx:1-3`；`packages/ai-connections/src/AiGatewayKeysSection.tsx:301-455`；`packages/ai-connections/src/AiCredentialRow.tsx:52-133`；`packages/ai-connections/src/AiConnectionsHeader.tsx:48-79`；`packages/tasks/src/TasksPanel.tsx:92-177`；`packages/shared-ui/src/pod-sign-in/account-parts.tsx:20-65`；`packages/shared-ui/src/login/presentation.ts:6-183`。
