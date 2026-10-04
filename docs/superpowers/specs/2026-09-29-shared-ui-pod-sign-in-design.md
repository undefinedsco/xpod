# shared-ui 登录前门（Pod Sign-in）设计

日期：2026-09-29（2026-10-03 规则校正）。**现行规则以 §13 的有日期裁决为准，注册与入口的替代关系见 §13.16。** 第一期实现与 20 道本地门禁属于 2026-10-01 的历史记录（§12.4），不证明本轮 Cloud card 拓扑、账号记忆或实际安装版已验收；外部发布仍须精确 SHA 证据。

**总体设计范围**（本稿确实定义，A/B/C/D 四组都在稿内）：

- **A 组**（应用侧前门）、**C 组**（一行错误提示）：`@undefineds.co/shared-ui` 中面向"未登录 / 需要 Pod"的呈现组件，以及经 `@undefineds.co/extension-sdk` 的 `SolidAuthBoundary` 暴露给生态应用的同一界面。
- **B 组**（账号服务侧的登录、注册、找回、授权页）：属于本稿范围，定义其呈现与文案（§6 B 组、§8.3）。
- **D 组**（账号服务自己的账号页：WebID / 设备 / 网络 / 密钥分区）：同样属于本稿范围，定义其呈现（§6 D 组、§8.4）。

**分期范围**（见 §11）：第一期交付 A/C 组新组件与接线、B 组换皮，并把 D 组的**公共呈现**接进已有账号页；第二期再做新增设备 / 网络 / 跨设备能力。注册只创建 Account，Pod 由后续明确动作创建；原 B2 自动编排计划已撤回（§13.16）。分期区分的是"本期是否接入呈现与新增能力"，**不是**"账号页是否属于本设计"——账号页的呈现属于本稿。

本稿以现有代码与产品风格（主站 DESIGN：纸色、墨紫、日常工具气质）为参照，不以既有 spec 条款为约束；与既有 spec 冲突处在 §9 列出，由负责人裁决后回写。

## 1. 为什么要重做

生态开发者和用户接触 Xpod 的第一个界面，就是这里。现在它有四个问题。

**1.1 同一件事有四套界面。**

| 入口 | 实际渲染 | 文案 |
|---|---|---|
| LinX Web / 桌面 | `linx/apps/web/src/modules/login/LoginModal.tsx`（1010 行，shared-ui `LoginModal` 的分叉副本） | 中文硬编码 |
| 第三方应用（extension-sdk） | `SolidAuthBoundary` → `WebIdLoginRouteView` + `StorageBootstrapView`，Card 外框，`max-w-lg` | 英文开发者用语："Connect to Solid""Choose an identity route""storage binding" |
| Xpod 自身 WebID 门 | `WebIdAuthBoundary` → `login.tsx` 原语 + `WebIdLoginEntryView` | 中文，原语默认值为英文 |
| Xpod Account 登录 | `WebAccountLayout` 280×400 compact 卡 | 盾牌图标 + 过期标语 "Personal Messages Platform" |

同一个用户，从 LinX 进来看到的是一套界面，从第三方应用进来是另一套，打开 Xpod 又是第三套。生态应用也就没法说清"用 Pod 登录"长什么样。

**1.2 第一屏先问存储，再问身份，而且会静默走错。** `ProviderSelectionView` 首屏是"数据保存位置：云端 / 本机"分段控件，主按钮只写"继续"。用户选了"本机"，但没有本机 provider 时，代码 `localProvider ?? cloudProvider` 会直接连到云端。用户以为数据留在本机，实际走了云端。这是信任层面的缺陷，不只是体验问题。此外，存储位置是创建 Pod 时的决定，不应在确认身份之前询问。

**1.3 用语全是实现概念。** 同一个对象在不同界面里分别叫"空间 / 本机空间 / 独立空间 / 存储空间 / Pod / Storage / storage binding / identity route / 账号供应商"。标签直接显示 `Cloud`、`Local`、`Standalone` 这类内部 label。冲突页并排列出两条完整 URL，让用户自己比对。

**1.4 视觉与品牌脱节，尺寸也不够用。**
- 配色（**历史观察，非当前源码现状**）：重做前 `theme.css` 曾用中性灰加 #7B68C8 系紫，本机 / 独立标记曾用 `sky-500`、`emerald-500`。当前 `packages/shared-ui/src/theme.css` 已换成新版公共主题角色——浅色 primary `#563E84`（墨紫）、深色 primary `#B7ABC3`、深色 canvas `#211D19`（§5）；本节记录的是当时的旧值，不代表现况。
- 尺寸：280×400 容器里正文被压到 11–12px，次按钮只有 32–36px。浏览器里内容溢出，出现滚动条，"创建账号 / 忘记密码"被截断（实测 `localhost:3000/dashboard/`）。
- 圆角：`rounded-lg / xl / 2xl / [18%]` 混用。按钮高度在 h-8、9、10、11 之间摇摆。
- 可访问性：旧 `LoginModal` 按钮没有 focus-visible；分段控件不是 radiogroup；自定义 provider 的 URL 非法时静默无反馈（代码注释写着 "Keep the compact modal quiet"）。

## 2. 设计目标

1. **一个前门**：所有宿主（LinX、第三方应用、Xpod 自身）渲染同一组状态、同一套文案和视觉。宿主只提供应用身份、provider 列表和回调。
2. **先确认身份，再准备 Pod**：登录只回答"你是谁、在哪个服务登录"。Pod 放在登录之后，而且只在确实缺少时才出现。
3. **说清要去哪里**：每次跳转外部登录前，都标明将要打开的服务主机名。这是生态信任的基础，也能防钓鱼。
4. **不静默改道**：用户选的是本机，就只走本机；本机不可用就明说，并给出修复动作。
5. **一眼可认**：纸色画布、墨紫主操作、系统字体、48px 主按钮。在应用的品牌下出现，但能看出是 Xpod/Pod 登录。

## 3. 用语（唯一口径）

| 用户可见 | 含义 | 不再使用 |
|---|---|---|
| **WebID** | 登录用的身份。应用侧只说"WebID 登录"，不说"用 Pod 登录" | 用你的 Pod 登录、登录 Xpod 账号 |
| **账号服务** | 签发身份的服务（OIDC issuer），界面同时显示主机名 | 账号供应商、identity route、provider、issuer |
| **Pod** | 保存数据的个人空间；首次出现时附一句"保存你数据的个人空间" | 空间、存储空间、storage、storage binding、本机空间/独立空间作为名词 |
| **Xpod**（账号服务） | Cloud 与 managed Local 共用已发现的 Cloud 账号服务；独立 Standalone 使用自身账号服务。登录、注册、授权均遵循该服务的权威地址 | 把存储节点地址当作账号服务 |
| **Xpod 云端 / Xpod 边缘**（存储位置） | 这两个只描述 **Pod 存在哪里**，不是两种账号服务：云端由 Xpod 托管；边缘运行在你自己的设备上（这台电脑、NAS 等），用图标和状态点表示是否运行中 | 这台电脑上的 Xpod（作为账号服务）、本机空间、独立空间、Local、Standalone |
| **继续为 {名字}** / **使用其他账号** | 记住的身份与切换 | 继续使用 X、切换账号、换一个空间 |
| **轻量快速创建页（轻页）** | 授权页缺 Pod 时进入的同 UID 专用快速建 Pod 页（`/.account/interaction/{UID}/create-pod/`）；只提交本次创建所需字段 | 在授权页里内嵌建 Pod 表单 |
| **重管理页（重页）** | 仅由桌面 Xpod 承载的完整 Pod 管理（`/settings/pod`）；Web 只提供桌面入口 | 在浏览器或登录弹窗里展示完整工作台 |
| **日常管理入口** | Account 提供桌面 Xpod 管理入口；日常访问不携带旧 Consent 任务 | 用遗留授权任务冒充日常入口 |

英文包使用对应的 *sign-in service / Pod / Xpod on this computer / Xpod Cloud / Continue as {name} / Use another account*。

规则：
- "WebID"作为概念名出现，首次附"什么是 WebID？"折叠说明；WebID 的 URL 原文只放在"详情"里。
- "Xpod"只作为服务或产品名出现（账号服务 Xpod、存储位置 Xpod 云端 / 边缘、Xpod 控制台），不要求用户理解它和 Pod 的关系。
- URL 默认只显示主机名，完整地址放在折叠的详情里。
- 文案按 locale 打包，随组件发布；宿主可以覆盖，不必每家重写一遍。
- **locale 唯一**：默认 zh-CN；需要英文的宿主显式选择 `en`。同一流程内登录、注册、授权，以及现有账号页的空态、操作、验证提示必须使用同一 locale，不得在流程中途切换语言。
- **注册 / 登录相邻链接成对**：登录页写"还没有账号？注册账号"；注册页写"已有账号？登录"。两侧措辞成对出现，不混用"注册 / Sign up / 创建账号"。
- **边缘设备 ≠ 自带账号服务的独立部署**：界面中的"Xpod 边缘 / 这台电脑"只表示 Pod 存在哪里，仍然用 Xpod 账号登录；只有极少数 Standalone 部署自带账号服务（§6 A 组）。文案不得暗示普通浏览器能把当前账号服务变成本机服务。
- **轻页 / 桌面 / 日常入口的安全任务口径**：授权页缺 Pod 只读引导，主操作把**一次性创建任务**交给同 UID 轻页；轻页的"使用自己的部署"引导到桌面 Xpod，原浏览器保留该任务，不能假定任务已安全跨进程迁移。返回原标签页后须重查任务与权威绑定再回原授权。任务绑定真实 Account id（**不是**服务地址 / WebID / username）、精确 UID、同源原 ConsentURL、TTL、单次消耗；切号 / 超时 / 服务端授权 410 一律拒绝旧任务。
- **日常入口不被遗留任务覆盖**：Account 的桌面管理入口不消费旧 Consent 任务；只有持有当前、经过验证的原授权上下文时才显示回到授权的操作。

## 4. 容器与版式

| 呈现 | 尺寸 | 用于 |
|---|---|---|
| `window` | 宿主窗口默认 **440×620**，最小 320×480，内容铺满、无卡片 | 桌面独立认证窗 |
| `dialog` | 宽 480px（窄屏为 100vw−32px），舒适高度 440px、高随内容增加，最大 90dvh | 应用内弹层（LinX、第三方） |
| `page` | 整页左右两栏：左栏是介绍（图标、名称、一句主张、几条要点，下沉底色；A 组由应用提供，B 组为账号服务介绍）；右栏居中放上限 480px 的响应式 body。窄屏收成单列 | 浏览器直接访问、重定向落地页 |

- 放弃 280×400。按 14px 正文、48px 主按钮、应用头部加说明计算，280 宽度装不下中文两行说明和主机名；1.4 里的溢出就是这么来的。
- **呈现由宿主传入，不由页面默认**。`PodSignInFrame` 接收 `presentation: 'window' | 'dialog' | 'page'`（§8.1）。**不得把所有账号页默认成 compact 小卡**——`XpodAccountPageSurface` 与 `XpodBlockingAccountCredentialsSurface` 已改为经 `WebAccountLayout` 按宿主选择 `page` / `window`，不再默认或固定 `compact`；`compact` 小卡只保留给应用侧 WebID 门（`XpodAuthSurface`，`ui/src/auth/XpodAuthSurface.tsx`）。
  - **桌面独立认证小窗**：`window`，铺满 440×620（最小 320×480），无卡片外框。
  - **浏览器直接访问的登录 / 注册 / 找回 / 授权页**：`page`。宽屏左右两栏——左栏是**账号服务介绍**（图标、名称、一句主张、几条要点，下沉底色），右栏居中放 最多 480px 宽 body；窄屏收成**单列**，介绍置顶或收起。真正的认证小窗才用 `window` 铺满 440×620。
  - **应用内弹层**：`dialog`。
- **层次用公共语义 token 表达，不能"把整站 primary 换掉"就算完成**：账号服务顶栏用底色条（`IdpChrome`："服务图标 + Xpod · 账号服务 + 主机名"）与应用侧轻量标识区分；表单底色、必要边界、选中 tint 各用公共角色（raised / control / tint，见 §5 与 R2 §8.1），不新造登录专用色板。
- 三种呈现共用同一个 body，只有外框不同。body 永远是一个单列：**来源标识 → 标题 → 主体 → 操作区**。
- **每屏只有一个标题**（h1，**22/600**，见 §5）。B 组（登录 / 注册 / 找回 / 授权）与 A/C 组标题统一为 22/600；D 组账号页若将来出现页面级大标题，需在 §6 D 组单独声明，不能写进这里的通用承诺。顶部的来源标识不是标题，只是一行 24px 图标加 13px 名称：
  - 应用侧（A、C 组）标识写应用名称，由宿主传入，组件里不写死任何应用。
  - 账号服务侧（B 组）标识写 "Xpod" 和服务主机名。用户在弹窗里能认出这是哪个服务的页面，这一行同时起防钓鱼的作用。
- **次要信息默认收起**。每屏正文不超过两行，Pod 的解释、位置差异、完整地址、错误码、检测明细都放进 `<details>` 折叠区（"什么是 Pod？""详情""原因和处理"）。
- "由 Xpod 提供"不再占用固定页脚。账号服务侧的标识已经说明了来源，应用侧放在"什么是 Pod？"的展开内容里。
- 操作区贴底，内容超长时只允许主体区滚动；主操作、错误和返回永远可见。

## 5. 视觉规格

以主站 DESIGN 为准，映射进 shared-ui 的 `theme.css` 语义 token（只改变量值，组件类名不变）。下表只列登录前门用到的角色；**色值唯一来源是 `packages/shared-ui/src/theme.css`，完整公共角色表引用 R2 `2026-09-27-xpod-product-experience-spec.md` §8.1**，本节不新建登录专用色板，也不逐一改写整套调色板：

| token（公共角色） | 浅色 | 深色 | 用途 |
|---|---|---|---|
| `--background`（canvas） | `#F7F4ED` 纸 | `#211D19` | 画布 |
| `--card`（raised） | `#FBFAF7` | `#2B2621` | 弹层、输入框、列表行 |
| `--foreground`（text） | `#2B2621` | `#F7F4ED` | 正文 |
| `--muted-foreground`（muted） | `#655D53` | `#C7BEB2` | 次要文字 |
| `--border`（line） | `#DFDBD5` | `#494139` | 分隔 |
| `--input`（control） | `#87837D` | `#93897D` | 控件边框（满足 3:1） |
| `--primary`（action / focus） | `#563E84` **墨紫** | `#B7ABC3` | 主按钮、链接、焦点 |
| `--accent`（tint） | `#E0DBDE` | `#39313E` | 选中行淡底 |

深色 action 是墨紫的浅化映射，**不能拿固定墨紫当深色小字或焦点色**（R2 §8.4：固定墨紫 / 深色 canvas 对比度仅 1.93）。

- 字体：系统无衬线栈（PingFang SC / SF Pro Text / Segoe UI / Noto Sans SC …），不加载网络字体；主机名用等宽 12px。
- 字号：标题 22/600，正文 14/400（行高 22），输入与主操作 16，字段标签 14，说明 13，最小 12。不再使用 11px 和 10px。
- 控件：主按钮 48px 高、8px 圆角、满宽；次按钮 48px 描边；文字按钮 36px。外框 12px 圆角，列表行 8px。全局只用这三档圆角。
- 状态色只用 token：`--destructive`、`--warning`、`--success`。不使用 sky/emerald 等原色，"本机"标记用中性图标加文字。
- 焦点：见下方"焦点"小节。
- 动效：120–180ms 淡入；`prefers-reduced-motion` 时去掉。加载转圈旁边必须有阶段文字。

### 5.1 焦点（共享 Input 统一处理）

- **视觉归原语所有**：`packages/shared-ui/src/input.tsx` 等原语负责控件焦点外观；账号表单组件只复用原语，页面只负责布局，不在页面层再叠一层边框。
- **只呈现一套清楚边界**：聚焦时只能有一条可见边界，聚焦边框与 token 统一（`--ring` = action）。**禁止**浏览器默认 / `@tailwindcss/forms` 的蓝色 `ring` / `box-shadow` 与自定义紫色 `outline` / `ring` 叠加成双层框。`focus.ts` 已声明 single focus 意图（`controlFocusClass` / `interactiveFocusClass` / `buttonFocusClass`），实现须与之一致。
- **2026-10-01 用户实测修订**：文字输入框的紫色焦点边界须覆盖原边框（2px、`outline-offset: -2px`，原 border 同步改为 action），不再用正 offset 保留一个灰框再另画紫框。checkbox / radio 的填充状态仍保留独立键盘焦点提示；链接与按钮继续各用自己的焦点规则。
- **可访问性不回退**：键盘焦点必须可见；label、字段级错误、`disabled`、`autocomplete` 能力都保留。**不得靠禁用密码管理器**来掩盖焦点或样式问题。
- **按钮、对话框不机械套 Input 规则**：按钮沿用自身表面（`buttonFocusClass`）；对话框打开时焦点落在对话框本身，按一次 Tab 到主操作。
- **定位方式**：截图只能说明"出现了双框"，**不足以确定是 border、outline 还是 box-shadow 的哪一条**；需在真实浏览器比较 computed style（`border` / `outline` / `box-shadow`）定位后修复（§12 证据表）。

## 6. 状态与界面

前门分两侧，由不同的一方渲染：

- **A / C 组：应用侧**。在应用自己的窗口或页面里出现，由 `PodSignIn` 渲染。任何应用都用这一套，不存在专属于某个应用的版本。
- **B 组：账号服务侧**。在账号服务的弹窗或跳转页里出现，由 Xpod 的 Account 前端复用同一套外框和 token 渲染。
- **D 组：账号页**。账号服务自己的整页，管理存储、WebID 和密钥；本机和其他机器上的 Pod 在这里创建。Xpod 控制台（AI、服务等）是普通的 WebID 应用，走 A 组登录。

**身份一律是 WebID**。应用和 Xpod 控制台都只持有 WebID 会话，AI 连接和 API Key 也挂在 WebID 上。Account 只存在于账号服务自己的页面（登录、注册、账号设置），不作为任何应用的登录门。

每屏只有一个主操作，也只有一个标题。

### A 组：应用侧

保留一键进入的登录逻辑：**大多数人只会看到"记住的身份"，点一下就进去**。应用侧没有独立的"选择服务"首屏，也没有"验证中"过渡屏。

**A0 恢复中 `restoring`**
- 小于 300ms：只显示来源标识。
- 300ms 以后：显示记住的头像和名字。
- 能静默恢复时直接进入，界面上看不到任何登录步骤。

**A1 记住的身份 `remembered`**（最常见）
- 显示头像（角标表示数据存在哪）和名字。
- 主操作"进入 LinX"。点击后按钮上转圈，完成后直接进入，不再经过验证中的过渡屏。
- 次操作"使用其他账号"，直接打开默认或上次使用的账号服务的 B1。

**A2 已过期 `expired`**
- 与 A1 同样的版式，名字下多一行"登录已过期，需要重新确认"。
- 主操作"重新登录"，直接打开该身份所属服务的 B1。

**A3 首次登录 `choose-service`**
- 只在两种情况下出现：
  - 第三方网页第一次打开，没有记住的身份；
  - 从 B1 点"使用其他 Solid 账号"。
- 标题"登录"，下面一句"用你的 WebID 账号登录，数据保存在你自己的 Pod 里"。
- 主按钮："使用 Xpod 账号登录"，按钮上带 Xpod 标志。
- 次按钮："使用其他 Solid 账号"，点开后在按钮下方展开账号服务地址或 WebID 输入框。
- 底部："还没有账号？注册 Xpod"，直接打开 B2。
- **Xpod 云端和 Xpod 边缘不作为登录选项出现**。它们只是存储位置：边缘设备上的 Pod 也用 Xpod 账号登录，存储位置在授权页和账号页里体现。只有极少数 Standalone 部署自带账号服务，按"其他 Solid 账号"处理。

**首次使用**：桌面 LinX 等有默认服务的宿主，第一次打开时直接进入默认服务的 B1。

**另开窗口**：只有宿主必须另开窗口时（如调用系统浏览器），才在 A1 按钮下方显示一行"在浏览器中完成登录 · 重新打开"。

### B 组：账号服务侧（弹窗内）

来源标识改为顶部至少 56px 底色条："服务图标 + Xpod · 账号服务 + 主机名"，和应用侧的轻量标识在视觉上明确区分。邮箱和密码表单**只出现在这里**，任何应用都不会渲染它。

登录或注册完成后，账号服务读取权威 Pod 清单：
- 至少有一个 Pod：进入 B4 授权。多个时在 B4 里选择。
- 确认没有 Pod：进入 B3。
- 清单读取失败：原地重试。不能当作"没有 Pod"。

**B1 登录 `idp-sign-in`**
- 标题"登录 Xpod"（写明登录的是哪个服务），副行"完成后回到 {应用}"。
- 字段：邮箱、密码。"忘记密码？"放在密码标签右侧；"在这台设备上保持登录"默认不勾选。
- 主操作"登录"。底部左侧"还没有账号？注册账号"，沿用当前宿主容器打开 B2；右侧"使用其他 Solid 账号"，回到 A3 并展开地址输入框。

**B2 注册 `idp-register`**
- 注册**只创建 Account**，不准备或创建 WebID / Pod，不以存储可用性作为注册成功条件。
- 字段由 Account controls 的真实要求决定；保留邮箱、密码及服务要求的账号名称，不前置 Pod 名称、部署选择或 WebID / Pod 创建预览。
- 注册完成后续接经验证的原授权；权威清单确认缺 Pod 时进入 B3，再由同 UID 轻页显式创建。没有原授权时进入账号总览。
- 存储与独立部署的选择属于后续创建流程；Web 的"使用自己的部署"仅引导到桌面 Xpod。
- 主操作："注册"。次操作："已有账号？登录"。

**B3 账号还没有 WebID `idp-no-webid`（轻量引导，2026-10-01 确认）**
- 新注册账号或已有账号经权威清单确认没有可用 Pod 时进入；绑定清单读取失败**不算**"没有 Pod"，走失败重试。
- 标题"还没有 WebID"，一句说明"新建一个 WebID 来登录 {应用}，数据存在它的 Pod 里"。
- **Consent（B4）里不再放名字表单，也不直接 POST。**缺 Pod 时授权页只读说明缺席原因，主操作把当前会话的**一次性创建任务**交给**轻量快速创建页**（同 UID 的 `/.account/interaction/{UID}/create-pod/`；入口见 `ui/src/pages/ConsentPage.tsx` 的 `handleGoToCreatePod`，页面见 `ui/src/pages/FirstPodPage.tsx`）。
- **轻页**只提交本次创建所需字段（名称 + 显式 submit），创建仍由全仓唯一的受守卫 prepare + POST 事务负责；提交后回到**原来的** Consent 继续授权。
- **轻页的"使用自己的部署"是明确口子**：引导到桌面 Xpod，原浏览器保留同一个一次性任务；完成桌面操作后，原标签页重查 Account、interaction 和 Pod 绑定，再续接原 Consent，不承诺跨进程自动传递任务。
- **日常入口**是 Account 提供的桌面 Xpod 管理入口；工作台沿用自身 WebID / Pod 准入，账号服务仍验证 Account 权威。遗留 Consent 不能覆盖日常访问。
- 登录弹窗里**不做**机器选择、启动服务、域名分配或外网检测。

**B4 授权 `consent`**

授权页上有三个角色，各占固定位置，不能混排：

| 角色 | 位置 | 样式 |
|---|---|---|
| **账号服务**（验证身份的一方，页面归它所有） | 顶部至少 56px 底色条 | 服务图标 + "Xpod · 账号服务" + 右侧主机名。B 组所有页面共用这条，表示"你现在在账号服务的页面上" |
| **请求授权的应用** | 页面主体居中 | 应用图标，标题"授权 LinX"，下方是应用主机名 |
| **你授出的身份** | 标签"用哪个 WebID 登录？"加单选列表 | 每行：头像（角标表示数据存在哪：电脑 / 云）+ 名字 + WebID 短名。只有一个 WebID 时只显示一行，不出现单选框 |

- Solid 里存储由 WebID profile 声明，选 WebID 就同时决定了数据在哪。**选择哪个 WebID 只在授权页做**（一个账号可以有多个 WebID），不单独选 Pod。存放位置只用头像角标表达（悬停与读屏给出"数据存在这台电脑上"）。
- 想换成另一个账号，是回到 A1"使用其他账号"重新登录，不是在授权页里切换。
- 同一套角标也用在 A1/A2 记住的身份上。
- 身份行下方用一句次要文字说明后果："LinX 将以这个身份读写你的数据，之后可以在 Xpod 中收回。"
- "请求详情"默认收起，里面放 scope、应用标识，以及"以后不再询问"（默认不勾选）。
- client 未能验证时，在标题下方加一行警示，并去掉"以后不再询问"。
- 底部两个按钮并排："拒绝"（描边）和"允许"（主色）。

### C 组：出错时只留一行提示

错误处理：普通用户**看不到错误屏、错误码和技术详情**。出错时留在 A1，只做两件事：
- 在主按钮上方加**一行**提示（13px，可带 14px 图标）；
- 把主按钮的文字改成能解决问题的动作。

| 情况 | 那一行提示 | 主按钮 |
|---|---|---|
| C1 连不上账号服务或读不到 Pod 列表 | "暂时连不上 Xpod，请稍后再试" | "重试" |
| C2 这台电脑上的 Xpod 没有运行 | "这台电脑上的 Xpod 没有运行" | "启动 Xpod 并进入"，一步完成启动和进入；宿主不能启动时改为"打开 Xpod" |
| C3 用户在账号服务里取消或拒绝了授权 | 灰字"登录已取消"（不用红色，这是用户自己的选择） | 恢复为"进入 LinX" |
| C4 位置不匹配、事务过期等少见问题 | "登录没有完成，请再试一次" | "重新登录" |

规则：
- 不因为出错切到其他服务，也不静默改用云端。C2 只提供启动本机，不提供"改用云端"。
- 服务不可达不等于"未登录"，也不等于"没有 Pod"，不清除已有会话。
- **技术详情只在开发者模式可见**：Xpod 设置里打开开发者模式后，那一行提示可以点开，显示阶段、错误码和服务主机名；也可以一键复制，方便报告问题。普通模式下这些信息只进日志。
- B 组表单的字段级错误（密码错误、用户名已被占用）仍然就地显示在字段下方，这属于表单校验，不算错误屏。

### D 组：账号总览与桌面管理

Web 账号总览保留账号服务自己的整页容器（B 组底色顶栏加 880px 内容列），负责身份 / Pod 绑定总览、账号安全与 Solid 客户端凭据。下列设备、网络与完整创建管理设计只由桌面 Xpod 承载；Web 提供桌面入口，不因复用组件而开放工作台。对应概念仍为**身份与 Pod（WebID）/ 存放位置（设备）/ 网络（跟着设备走）**：

| 分区 | 内容 | 操作 |
|---|---|---|
| **WebID** | 每行是一个 WebID 和它的 Pod：头像（角标表示云端/边缘）、名字、WebID；"Pod 在 {设备名}"（可跳到设备分区）；已授权应用数 | "新建 WebID"、"关联已有 WebID" |
| **设备** | Xpod 云端，以及所有登录过本账号的边缘设备：图标、名称、云端/边缘标签、地址（如 `node-7f3a.undefineds.co`）、Pod 数、状态（正常 / ⚠ 其他设备访问不到 / Xpod 已停止 / 离线） | "添加设备"（弹窗，见下）；边缘设备行尾"网络 / 处理"；已停止的在线设备行尾"启动" |
| **密钥** | Solid Client Credentials：让脚本或服务以某个 WebID 直接访问 Pod | "新建密钥"（没有 WebID 时禁用） |

- **网络挂在设备上**，不挂在 WebID 或 Pod 上：公网入口和隧道都是设备级别的事实，一台设备上的所有 Pod 共用。
- 设备归属只能靠在那台设备上用本账号登录来证明，不提供输入 IP 或地址来绑定。
- 这里的"密钥"是账号服务层的 Solid 凭据。AI 连接和 Xpod API Key 属于应用层，在 Xpod 控制台（WebID 登录）里管理。

**新建 WebID：参照"下单时选收货地址"**
- **入口只有一个**：WebID 分区标题行右侧的"新建 WebID"，表单展开时这个按钮隐藏。
  - 从授权流程进来时，表单直接展开。
  - 直接访问账号页时，表单默认收起。
- 表单上下两步：
  1. **名称**：下面预览 WebID 地址。
  2. **存放在**：像默认收货地址一样，**直接带出一台设备的摘要卡**（默认这台电脑；若这台电脑不是边缘设备，则默认 Xpod 云端），显示图标、名称、云端/边缘标签、状态点。右侧是"更换 ›"。卡片下方一行写"创建后不能直接更换，以后要换请使用迁移"。
- **点"更换"弹出"选择存放设备"对话框**，就像地址列表：
  - 列出全部设备，点一行立即选中并关闭；离线设备置灰不可选。
  - 列表底部是"＋ 添加设备"，打开同一个"添加设备"弹窗（见下）；完成后回到这里并已选中新设备。
  - 选择过程中不涉及网络设置。网络在"设备"分区里管理，就像地址簿在设置里管理。
- 创建步骤只和所选设备有关：
  - 设备运行中：只有一步"创建 WebID 和 Pod"；
  - 设备在线但 Xpod 已停止：先"启动这台设备上的 Xpod"，再创建。
  - 外网连通检测不属于新建流程，在设备分区的网络面板里处理。
- 创建完成后，WebID 列表多一行，对应设备的 Pod 数加一。创建期间写一行"关闭页面不会中断创建"。

**WebID 分区的两种常见状态**
- **还没有 WebID**：从授权流程进来时就是这种状态。列表里只有一行说明，表单直接展开，顶部有"回到授权"横条。
- **已有 WebID**（日常访问）：没有横条，列表逐行显示已有的 WebID（"Pod 在 {设备}"、已授权应用数），表单收起。点"新建 WebID"后，表单在已有行下方展开（下沉底色、上边分隔线），名称默认给出不重复的建议。

**添加设备（弹窗，顺带验证网络）**
- 从"设备"分区的"添加设备"进入，或者从选择存放设备对话框的"＋ 添加设备"进入，两处打开同一个弹窗。
- 顶部三步：1 安装并登录 → 2 检查网络 → 3 完成。
  1. **安装并登录**：
     - 宿主有本机拉起能力（在 Xpod 桌面端里打开），而且这台电脑还没加入时，最上方给出"把这台电脑加入"：一键拉起本机 Xpod 边缘，并用当前账号登录，然后直接进入第 2 步。
     - 下方是添加其他设备的说明：在那台设备上安装 Xpod 边缘并登录。弹窗显示"正在等待新设备上线，登录后这里会自动继续"。
  2. **检查网络**：新设备卡片出现（名称、边缘标签、分配的地址、"已上线"），然后依次检测本机 → 局域网 → 其他网络。外网不通时，就地选择隧道，按钮是"跳过，稍后设置"和"开启并检测"。
  3. **完成**：从设备分区进入时按钮写"完成"；从选择设备进入时写"用这台设备"，回到新建 WebID 并选中这台设备。

**本机拉起的位置**（只在宿主有能力时显示；没有能力时换成文字"在那台设备上打开 Xpod"）
- 添加设备弹窗的第 1 步："把这台电脑加入"。
- 新建 WebID 时，所选设备的 Xpod 已停止：创建步骤里自动先"启动这台设备上的 Xpod"。
- 设备行："Xpod 已停止"且在线时，行尾"启动"。离线设备不提供，因为远程开不了机。
- 应用侧 C2："启动 Xpod 并进入"。

**网络（设备行上的"网络 / 处理"）**
- 在设备行下方展开"网络访问"面板，横排三项检测：这台电脑、局域网、其他网络（公网入口）。
- 外网不通时，横排四家隧道：Cloudflare / ngrok / SakuraFrp / 自建 FRP。所需字段按 `TunnelProviderCatalog` 渲染。
- 主按钮"开启并重新检测"，次按钮"重新检测"。通过后写明"通过 {隧道} 可以访问"，设备状态回到"正常"。
- 面板底部常驻一行说明："只影响其他设备；这台电脑上照常可用"。

**返回原授权时（原浏览器保留的有效 Consent 任务）**
- 页面最上方出现一条回到授权的横条：LinX 图标、"LinX 正在等你完成授权"、一行状态说明、"取消授权"、主按钮"继续授权 LinX"。
- 还没有可用的 Pod 时，按钮禁用，说明写"先创建一个 Pod，完成后回到授权"。Pod 就绪后按钮变为可点，说明改为"Pod 已就绪，可以回去授权了"。
- 点击后回到原来的授权页（B4），并重新读取 WebID 与 Pod，不沿用过期的状态。
- 不是从授权进入时，没有这条横条。

**管理导航语义（直接访问 vs 从授权进入）**
- **直接访问账号页**：进入受 Account 权威保护的轻量账号总览；完整 Pod 管理由桌面 Xpod 提供。日常访问没有当前 OIDC interaction 需要续接，也不能绕过目的页的 WebID / Pod 权威检查。
- **从授权进入**：`ConsentResumeBanner` 必须携带**一次性续接上下文**，内容至少为：当前 Account 身份 + 原 OIDC interaction + 经校验的目的地址 + 有效期。落地形式可放受保护的服务端 / session，不要求明文进 URL。
- 原浏览器任务页展示回到授权横条；返回时**重新读取 WebID / Pod**并验证上下文，再回到原授权；**过期 / 取消 / 中途切换账号后不得复用旧授权**。
- **不得把裸 `returnTo` URL 当安全续接**：续接使用 `ui/src/utils/safe-continuation.ts` 的真实 Account id、interaction、经校验的同源原 ConsentURL 与 TTL。Consent 先进入同 UID 轻页；桌面入口不能把 URL 参数当作跨进程授权，日常入口不携带任务。
- **不绕过目的页权威检查，也不把 Account 与 WebID 会话等同**：账号页准入看 Account，Pod 数据访问才看 WebID（见 `settings-routes.tsx` 注释）。

## 7. 典型路径

1. **老用户（最常见）**：A1 点"进入 LinX"，直接进入。能静默恢复时连 A1 都看不到。
2. **切换账号**：A1 点"使用其他账号" → B1 输入账号密码 → B4（仅这个应用第一次，或账号有多个 WebID 时需要选择）→ 进入。
3. **新用户**：B1 点"注册" → B2（仅创建 Account）→ 原 UID 的 B3 / 轻页 → 用户显式创建 → 回原 B4 → 进入；无原授权时注册后进入账号总览。
4. **其他 Solid 账号**：B1 点"使用其他 Solid 账号" → A3 输入地址 → 该服务的登录页。
5. **已有账号没有 Pod**：B1 → B3 → 同 UID 轻量快速创建页（显式 submit）→ 回原 B4。"使用自己的部署"引导到桌面 Xpod，原标签页保留任务，回来重查后续接；日常桌面管理不消费 Consent 任务。
6. **本机 Xpod 未启动**：A1 上提示"这台电脑上的 Xpod 没有运行"，按钮变为"启动 Xpod 并进入"，点一下即可进入。

## 8. 组件与 API

所有组件都放在 `packages/shared-ui/src/pod-sign-in/` 下，从 `packages/shared-ui/src/index.ts` 导出。组件**只负责呈现**：
- 不发请求，不跳转，不读写 storage；
- 状态由宿主的控制器映射后传入；
- 文案随组件发布 zh-CN 和 en 两套，宿主只做局部覆盖。

### 8.1 外框与共用件

```ts
type SignInPresentation = 'window' | 'dialog' | 'page'

interface AppIdentity { name: string; icon?: ReactNode }          // 应用侧来源标识

// 外框：window = 铺满宿主窗口；dialog = 宽 480 的弹层；page = 左右两栏
interface PodSignInFrameProps {
  presentation: SignInPresentation
  ariaLabel: string
  appIntro?: ReactNode          // 仅 page：左栏介绍，由宿主（应用或账号服务适配器）提供；A 组为应用介绍，B 组为账号服务介绍。真实 API 保留 appIntro，不设 pageIntro 别名
  children: ReactNode           // 最多 480px 宽的 body
}

// 头像右下角标：数据存在云端还是边缘
type StorageLocationKind = 'cloud' | 'edge'
interface StorageBadgeProps { kind: StorageLocationKind; label: string }   // label 给读屏和悬停用

// B 组顶部至少 56px 底色条
interface IdpChromeProps { serviceName: string; serviceHost: string; icon?: ReactNode }
```

### 8.2 A 组：`PodSignIn`（应用侧，包括 C 组的一行提示）

```ts
interface RememberedIdentity {
  displayName: string
  avatarUrl?: string
  storage?: { kind: StorageLocationKind; label: string }   // 用于角标
}

type PodSignInState =
  | { kind: 'restoring'; identity?: RememberedIdentity }                 // A0
  | { kind: 'remembered'; identity: RememberedIdentity; busy?: boolean } // A1
  | { kind: 'expired'; identity: RememberedIdentity; busy?: boolean }    // A2
  | { kind: 'choose-service'; customOpen?: boolean; customError?: string; busy?: boolean } // A3

// C 组：挂在 A1/A2/A3 上的一行提示和替换后的主操作
interface PodSignInNotice {
  tone: 'neutral' | 'warning'           // neutral=灰字（如“登录已取消”），warning=带图标
  text: string
  primaryLabel?: string                 // 覆盖主按钮文字，如“重试”“启动 Xpod 并进入”
  developerDetail?: string              // 只在 developerMode 下可点开查看
}

interface PodSignInProps {
  app: AppIdentity
  state: PodSignInState
  notice?: PodSignInNotice
  locale?: 'zh-CN' | 'en'
  copy?: Partial<PodSignInCopy>
  developerMode?: boolean
  capabilities?: { customService?: boolean; register?: boolean }
  onPrimary(): void                 // A1 进入 / A2 重新登录 / A3 使用 Xpod 账号登录 / notice 覆盖后的动作
  onUseAnother?(): void             // A1/A2 “使用其他账号”
  onCustomService?(input: string): void
  onRegister?(): void
  onToggleCustom?(open: boolean): void
}
```

- `busy` 为 true 时，主按钮显示转圈并禁用。**不再单独渲染"验证中"过渡屏。**
- 标题规则：A1 和 A2 的标题是名字，A3 的标题是"登录"。来源标识不算标题。

### 8.3 B 组：账号服务侧

```ts
interface IdpSignInViewProps {         // B1
  serviceName: string; returnToAppName?: string
  error?: string; fieldErrors?: { email?: string; password?: string }; pending?: boolean
  remember: boolean
  onRememberChange(v: boolean): void; onSubmit(v: { email: string; password: string }): void
  onForgot(): void; onRegister(): void; onUseOtherSolid?(): void
}
interface IdpRegisterViewProps {       // B2
  serviceName: string; returnToAppName?: string
  usernamePreview?: string             // 仅账号名称提示；不得预告注册即创建 WebID / Pod
  requireUsername: boolean             // 由 CSS controls 决定
  fieldErrors?: Record<'username' | 'email' | 'password', string | undefined>; pending?: boolean
  onSubmit(v: { username?: string; email: string; password: string }): void; onSignIn(): void
}
interface IdpNoWebIdViewProps {        // B3
  serviceName: string; serviceHost: string
  appName: string
  defaultName?: string                 // 省略时不渲染名称字段（Consent 缺 Pod 的主流形态：创建交给轻页）
  nameHint?: { tone: 'ok' | 'muted' | 'error'; text: string }
  error?: string; pending?: boolean
  onNameChange?(name: string): void
  onCreate(name: string): void         // 有名称字段时才带回名称
  onChooseOtherLocation?(): void
}
interface ConsentViewProps {           // B4
  app: { name: string; icon?: ReactNode; host: string; clientId?: string; verified: boolean }
  webIds: Array<{ id: string; displayName: string; shortName: string; avatarUrl?: string;
                  storage: { kind: StorageLocationKind; label: string } }>
  selectedWebId: string
  scopes: Array<{ id: string; label: string }>
  rememberChoice: boolean
  pending?: 'approve' | 'deny'
  onSelectWebId(id: string): void; onRememberChange(v: boolean): void
  onApprove(): void; onDeny(): void
}
```

- B1–B4 都用 `IdpChrome` 加 最多 480px 宽 body，由 `PodSignInFrame` 的 `window` 或 `page` 外框承载。
- `ConsentView`：只有一个 WebID 时只显示一行，不出现单选。client 未能验证时，在标题下加警示，并隐藏"以后不再询问"。
- B3 的"创建并继续"在 Consent 缺 Pod 时只**导航**到同 UID 轻页（`/.account/create-pod/` 作用域化），不在这里 prepare 或 POST；名称字段与显式提交由轻页承担（`ui/src/pages/FirstPodPage.tsx`）。`onChooseOtherLocation` 按宿主能力走（当前是打开同 UID 账号页）。

### 8.4 D 组：账号页分区（新增分区首期只做呈现与夹具，见 §11）

- **新增跨设备分区**（`DeviceSection` / `NetworkPanel` / `AddDeviceDialog` 等）首期只做呈现与夹具；已有 WebID / Pod / 凭据 / 密码内容本期就换用公共呈现（§11.1 第 3、6 条）。
- 设计过程中的 HTML 原型（如 `.test-data/login-lead/reference/` 下的 360×540 / 1280 屏幕）**只作视觉参照**：原型里的假设备、假定时器、假状态数据**不是能力声明**，不得据此认为跨设备 / 远程拉起 / 网络检测已可用。真实能力以 §11 分期与接口现状为准。
- `WebIdSection`，内含：
  - `CreateWebIdForm`：两步表单，存放位置用摘要卡加"更换 ›"；
  - `DevicePickerDialog`：选择存放设备的对话框。
- `DeviceSection`，内含：
  - `NetworkPanel`：网络检测，以及四家隧道的字段；
  - `AddDeviceDialog`：三步，含"把这台电脑加入"的本机拉起入口。
- `CredentialSection`：密钥分区。
- `ConsentResumeBanner`：从授权进来时顶部的回到授权横条。

隧道字段不在组件里写死，由 `TunnelProviderCatalog` 的描述（`id / label / parameterFields` 加凭据字段）生成。

### 8.5 旧组件

以下组件保留一个版本，标记 `@deprecated`，并在 JSDoc 中指向新组件：
- `LoginModal`、`LoginView`、`RememberedLoginView`
- `LoginAccountView`、`LoginConnectingView`、`LoginRestoringView`、`LoginFailureView`
- `WebIdLoginRouteView`、`WebIdLoginEntryView`、`StorageBootstrapView`

不改变这些组件现有的行为和测试。

## 9. 与现有规定的偏差（2026-09-29 评审；注册计划已由 §13.16 替代）

| 本稿 | 现有规定 | 理由 |
|---|---|---|
| 桌面小窗 440×620 | 280×400 compact 基线 | 280 宽度下 14px 正文和 44px 按钮放不下，浏览器实测已溢出 |
| 注册只建 Account；缺 Pod 时 Consent 只交任务，由同 UID 轻页显式 submit 创建 | 9/29 曾批准注册同时建 Account / WebID / Pod，后列为第二期 | 2026-10-03 本会话已纠正该计划（§13.16）；注册、显式创建与授权各自保留独立成功和失败边界 |
| Xpod 控制台用 WebID 登录，不以 Account 表单作为入口 | 现有 dashboard 首屏是 Account 邮箱密码表单 | AI 连接和 API Key 都是 WebID 级；Account 只处理账号本身的事务 |
| 云端 / 边缘只表示存储位置，账号服务只有 Xpod | 旧前门把"本机空间"当登录选项 | 边缘设备上的 Pod 也用 Xpod 账号登录 |
| 出错只留一行提示，技术细节只在开发者模式可见 | 现有失败页显示通用错误与重试 | 减少登录中断；排障信息仍在开发者模式和日志里 |
| 外网连通不阻塞创建与加入设备 | 现有本机引导把连通检测放在登录前 | 本机可用就能工作；远程访问提供修复入口即可 |

canonical（9/19）与 R2 的对应条款，在本稿实现并验收后另行回写；实现期间以本稿为准。2026-10-01 确认的"轻页 / 重页 / 日常"三入口与"授权页只交任务不建 Pod"以本节新条款优先；R2 的颜色角色（浅 primary `#563E84`、深 primary `#B7ABC3`、深 canvas `#211D19`）仍然有效（§5）。

## 10. 验收

1. **A 组状态**：`SolidAuthBoundary` 示例应用和 Xpod WebID 门，逐状态截图一致：A0–A3，以及 C1–C4 的一行提示。
2. **尺寸与主题**：`window` 440×620、`dialog`、`page`（1280 宽两栏，390 宽单栏），200% 文字、深浅主题下，主操作和返回都可见，没有水平滚动。
3. **键盘与读屏**：只用键盘能走完路径 1–4。状态变化用 polite 播报，失败用 assertive。
4. **一行提示**：普通模式下，C 组只有一行提示，没有错误码；开启开发者模式后，可以点开查看详情。
5. **不静默改道**：本机 Xpod 边缘不可用时，不会有任何请求发往其他 issuer（回归测试）。
6. **测试**：所有新组件都有单元测试，覆盖每个状态的渲染、按钮回调、ARIA 角色（radiogroup / dialog / status / alert）。
7. **呈现选择**：直接访问账号页（登录 / 注册 / 找回 / 授权）宽屏为两栏 `page`（左栏有账号服务介绍）、窄屏为单列；真正的认证小窗 `window` 铺满 440×620。三种呈现分别截图，均无水平滚动。
8. **Input 状态**：共享 Input 的 focus / filled / error / disabled / auto-fill 逐态检查，聚焦只有一套可见边界，无蓝色与紫色叠加；键盘焦点可见。
9. **locale 一致**：登录、注册、授权、账号页空态 / 操作 / 验证提示在同一流程内使用同一 locale；zh-CN 为默认，en 为显式选择。
10. **账号管理旧功能回归**：已有 WebID、Pod、凭据、密码等既有功能换公共呈现后仍可用。
11. **管理导航**：直接管理访问可进入；从授权进入的管理往返携带一次性续接上下文；refresh / expiry / cancel / account-switch 四类场景不得复用旧授权。

以上为**待验清单**；2026-10-01 已由 Lead 在加载当前源码的私有浏览器 fixture（路由 Account API）上完成分项检查，完整门禁仍未跑完（见 §12）。

## 11. 实施分期

### 11.1 第一期（本次派发）：新前门组件，并接入 Xpod 与 extension-sdk

（2026-10-01：下列第 1–6 条已接入，§11.2 本地门禁和提交前第二轮完整集成均已通过；证据与发布边界见 §12.4。）

范围：

1. **主题**：`packages/shared-ui/src/theme.css` 的浅色和深色 token，按 §5 改成纸色与墨紫。`.light`、`:root`、`.dark` 三处保持一致；同步更新 `theme.test.ts` 的断言。
2. **新组件**：实现 §8.1–§8.3 的 `pod-sign-in` 模块，含 zh-CN / en 文案和测试，并从 `index.ts` 导出。
3. **D 组呈现件**：按 §8.4 实现 `WebIdSection`、`DeviceSection`、`NetworkPanel`、`DevicePickerDialog`、`AddDeviceDialog`、`CredentialSection`、`ConsentResumeBanner`，只用 props 驱动，并配测试。**已有账号页（WebID / Pod / 凭据 / 密码）本期就换用这套公共呈现**，不改协议与请求；只有**新增的跨设备能力**（设备列表 `/v1/nodes`、远程拉起、添加设备 / 网络面板接线）延到第二期。`/v1/nodes` 返回 501 只阻塞新增跨设备能力，**不阻塞已有页面改版**；本期也不需要实现远程启动或任何尚不存在的接口。
4. **extension-sdk**：`packages/extension-sdk/src/react/solid-auth-boundary.tsx` 改为渲染 `PodSignIn`，映射关系如下，公开 props 保持向后兼容：

   | WebIdAuthState | StorageSelectionState | 渲染 |
   |---|---|---|
   | `restoring` | 任意 | A0 |
   | `anonymous` 且有 `remembered` | 任意 | A1 |
   | `anonymous` 且无 `remembered` | 任意 | A3（routes 只有一条时，主按钮就是这一条） |
   | `connecting` | 任意 | 上一屏，`busy: true` |
   | `expired` | 任意 | A2 |
   | `error` | 任意 | A1 或 A3，加 C4 提示 |
   | `authenticated` | `ready` 或 `undefined` | children |
   | `authenticated` | `loading`、`waiting_for_binding`、`creating` | A1，`busy: true` |
   | `authenticated` | `error` | A1，加 C1 提示（"重试"） |
   | `authenticated` | `conflict` | A1，加 C4 提示（"使用其他账号"） |
   | `authenticated` | `empty` | A1，加提示"还没有 WebID"，主按钮"去创建"，调用 `onCreateStorage` |
   | `authenticated` | `selecting` | 保留现有的 `StorageSelectionView`，但换成新 token 与 响应式 body 样式 |

   更新 `packages/extension-sdk/test` 中的相关断言。
5. **Xpod WebID 门**：`ui/src/solid/WebIdAuthBoundary.tsx` 改用 `PodSignIn`，映射同上。
   - 记住身份时，`bindingLabel` 换成角标。
   - `connecting` 不再渲染 `LoginConnectingView`，改为主按钮 `busy`。
   - 失败走 notice，`SolidSessionPendingError` 的提示为"上次登录尚未结束"，主按钮"刷新页面"。
   - 更新 `WebIdAuthBoundary.test.tsx`。
6. **Xpod 账号服务页换皮**：只换呈现，不改协议、状态和请求。
   - **呈现选择**：浏览器直接访问的登录 / 注册 / 找回 / 授权用 `page`（宽屏两栏、左栏为账号服务介绍；窄屏单列），**不是默认 `compact`**；真正的认证小窗才用 `window` 铺满 440×620。当前实现：`XpodAccountPageSurface` 与 `XpodBlockingAccountCredentialsSurface` 已统一经 `WebAccountLayout` 按 host 推导 `page` / `window`（`ui/src/auth/XpodAuthSurface.tsx`），不再有 `compact` 默认值，也不再固定 `compact`；**不新增 presentation props**。
   - 登录（`XpodBlockingAccountCredentialsSurface` 的 login 模式）→ `IdpSignInView`；
   - 注册 → `IdpRegisterView`（`requireUsername` 按现有 controls 决定）；
   - `ConsentPage` 的正常授权 → `ConsentView`；
   - `ConsentPage` 缺 Pod 的分支 → `IdpNoWebIdView`（只读引导，不放创建表单）；主操作 `handleGoToCreatePod` 把一次性任务交给同 UID 的轻量快速创建页（`ui/src/pages/FirstPodPage.tsx`），不再在 Consent 内直接创建；
   - **管理导航**：Web 留桌面 Xpod 入口；原浏览器按 §6 D 组保存与验证 Account、interaction、目的地址和有效期，返回时重查绑定再显示续接操作，不只保存裸 `returnTo`，也不自动跨进程传递授权任务。
   - **文案**：账号页现有英文（`Account Dashboard` / `Storage` / `Identity` 等）改为 zh-CN 默认、en 显式选择，与登录 / 注册 / 授权同 locale；去掉 `WebAccountLayout` 里过期的"Personal Messages Platform"标语，标准版式左栏的旧英文产品介绍（"Simplify Life with…"）换成账号服务介绍。
   - 保留原有测试中的 id 和可访问名称（如 `oidc-consent-webid`），必要时调整断言。

不在第一期：
- 原 B2 注册即建 WebID / Pod 编排已撤回，不列入任何一期；注册只创建 Account 的要求持续有效；
- 账号页**新增设备**的接线：`/v1/nodes`、宿主代理拉起、添加设备 / 网络面板的真实数据、跨设备网络；
- LinX 迁移（另一个仓库）；
- 开发者模式开关的持久化（本期只提供 prop）；
- canonical 回写。

> 注意：第一期**不**排除已有账号页——基础版式、中文、现有 WebID / Pod / 凭据 / 密码功能必须接新公共呈现（上第 3、6 条）。被排除的只是新增跨设备能力。

### 11.2 第一期的门禁命令（全部通过才算完成）

```bash
bun run --filter '@undefineds.co/shared-ui' test
bun run --filter '@undefineds.co/extension-sdk' test
bun run build:ts
bun run typecheck:test
bun run test
bun run test:integration      # lite + full（= test:integration:all）
bun run build:ui              # app + dashboard + settings（= ui build:all）
```

`ui/` 下的测试随 `bun run test` 执行，被改动的 ui 测试文件必须通过。`bun run test:integration` 展开为 `test:integration:lite && test:integration:full`（AGENTS「必须执行的回归检查」）；`bun run build:ui` 覆盖 app / dashboard / settings 三个前端构建。

2026-10-01 Root 接手后的完整重建与 20 道本地门禁全部实际 exit 0，随后提交前再次执行完整 lite + full 集成也 exit 0。原生真实浏览器 9 / Electron 3 通过；仓库集成使用 fake QLever，不能混为原生证据。完整计数、条件跳过与产物发布边界见 §12.4；旧统一 run 仅作历史，不替代本轮结果。

### 11.3 第二期（第一期验收后再派发）

- 保持注册与显式 Pod 创建解耦；不得恢复已撤回的 B2 自动编排；
- 账号页**新增分区与新增能力**接入 `AccountPage.tsx`（基础版式与已有 WebID / Pod / 凭据 / 密码已在一期换成公共呈现）：
  - 设备分区先接本机（`/provision/status`、`/api/network/settings/*`）；
  - 跨设备依赖 `/v1/nodes` 恢复；
- 本机拉起接桌面宿主能力（`startLocal`）；
- LinX 改用 `PodSignIn`；
- 开发者模式开关放进 Xpod 设置。

## 12. 证据与文档状态（2026-10-01，历史实施记录）

（2026-09-30 的用户截图反馈是本次改版的起点；其视觉结论已被本轮源码与浏览器分项验证取代，历史叙述见 §1.4、§5。）

### 12.1 静态确认（当前 worktree，只读检查）

| 观察 | 证据位置 |
|---|---|
| 授权页缺 Pod 不再内嵌创建：只读引导，主操作把一次性任务交给同 UID 轻页 | `ui/src/pages/ConsentPage.tsx`（`showNoPodStorage` / `handleGoToCreatePod` / `handleGoToPodManagement`） |
| 轻量快速创建页：同 UID、显式 submit、空任务即失效、已有绑定直接回授权、"使用自己的部署"跳重页 | `ui/src/pages/FirstPodPage.tsx` |
| 任务安全绑定真实 Account id + 精确 UID + 同源原 ConsentURL + TTL + 单次消耗 | `ui/src/utils/safe-continuation.ts` |
| 同 UID 作用域携带 `/.account/interaction/{UID}/...` | `ui/src/utils/account-interaction-url.ts` |
| 授权页缺 Pod 回归（7 项：含无权威 Account id / 无作用域 / 读取 500 与 malformed 不误 create） | `ui/src/pages/ConsentNoPod.test.tsx`；轻页回归 `ui/src/pages/FirstPodContinuation.test.tsx` |
| 公共 Input 单一边界；浅 primary `#563E84`、深 primary `#B7ABC3`、深 canvas `#211D19` | `packages/shared-ui/src/theme.css`、`packages/shared-ui/src/focus.ts`、`packages/shared-ui/src/input.tsx` |
| 页面 / 窗口两种外框：左介绍右 360 body、登录窗口 360×540 | `packages/shared-ui/src/pod-sign-in/PodSignInFrame.tsx` |
| Account WebID / Pod / 凭据 / 密码已换公共呈现（一期接入） | `ui/src/pages/AccountPage.tsx`、`ui/src/auth/XpodAuthSurface.tsx`、`ui/src/auth/WebAccountLayout.tsx` |
| Pod 管理受 Account 权威边界保护——**不能**写成"已证实认证绕过" | `ui/src/settings-routes.tsx`（`AccountAuthBoundary` 包裹 `/settings/pod`） |

### 12.2 验证证据（Lead，加载当前源码的真实浏览器，分项）

- 分项：9 个布局分项、12 项 native focus 分项、7 项 quick-create 流程分项、6 项重页面（`/settings/pod`）续接流程分项、Account 异步取消 / 切号、普通 + Local CRUD。
- Lead 结论（`lead-acceptance-report.md`）：本轮登录 / Account / 轻重功能与视觉分项已由 Lead 在加载当前源码的私有浏览器 fixture（路由 Account API）上逐项检查；这些分项本身不证明 Gateway 或发布；最终完整集成与真实原生矩阵的独立通过结果见 §12.4，外部发布仍按精确 SHA 验收。上述浏览器证据仍是隔离 fixture，**不等于**用户 40991 / RC / prod 实例验收。
- 证据文件（被忽略的 `.test-data/login-lead/` 下）：`lead-browser-check.json`、`lead-native-focus-matrix.json`、`lead-quick-pod-flow.json`、`lead-own-deployment-check.json`、`lead-account-resume-check.json`、`lead-account-crud-check.json`、`lead-account-local-crud-check.json`。
- 这些是**加载实际组件与 CSS 的浏览器分项，配合 Account / API 隔离 fixture**；**不是**真实运行 Gateway 的账号 / Pod 验收，也**不是**用户 40991 实例的验收——该用户实例本轮没有更新，我们也没有启动它。
- `lead-consent-title-check.json`：最后一处 Consent 标题样式修正后，4 个（宽/窄 × 浅/深）真实浏览器用例的授权标题为 17px / weight 600，无横向溢出、无页面错误。
- `lead-first-pod-local-scope.json`、`lead-missing-account-check.json`：Local other-root 上的既有绑定不使当前目标误判就绪；重页面丢失 Account 身份时立即隐藏续接动作（各分项通过）。
- **当前完整门禁与集成**实际结果见 §12.4、`.test-data/login-lead/release-unified-results.jsonl`、`lead-issuer-full-gates-logs/` 与 `lead-precommit-second-integration.log`。旧 `dev-final-status.json`、旧统一 run 的 `07` 根测试 / 集成为改动前历史；不把旧结果冒充当前通过。

### 12.3 本轮根因与结论（更正"只改文档 / 蓝框无法源码定位"）

- 根因是 **UI 全局 token 覆盖 + `@tailwindcss/forms` 的原生控件 focus 与 shared-ui `focus.ts` 单一 outline 冲突**，**已在源码处理**：删除重复色板 token，并让 reset 覆盖 native checkbox / radio 的默认焦点。
- 证据是加载当前源码的浏览器分项（12.2）。更早的 `localhost:40991` computed style 观察（`live-account-focus.json`）**仅作历史记录**：其运行资产为旧配色，不代表当前源码现状，也**不表示用户的服务失效**——该用户实例本轮未更新、我们也未启动它。

### 12.4 本地验收证据与发布门禁

本节区分：旧历史 / 失败尝试、改动后已通过的源码与单元证据、私有视觉 fixture，以及仍在待验项；并区分 **fake-fixture 集成**、**原生单元回归**与**真实登录矩阵**。

**旧历史 / 失败尝试（历史记录，非当前状态）**

- 旧 `dev-final-status.json` / `dev-final-*` 系列（更早一轮）：根 `bun run test` 1 条基线 canary 类型错误、`typecheck:test` 56 条、UI lint 21 error / 5 warning、full 集成段因 `quay.io/minio/minio` 固定 digest 401 未执行，随后 S3 冷启动 `ECONNRESET`。这些已在本轮修复或替换，**只作历史**。
- 真实 3 模式 auth matrix 两次失败尝试（均**在浏览器用例前退出，未执行任何浏览器用例**）：`08-auth-matrix-attempt1` 在 Cloud localhost readiness 等待 60s 后超时（`localhost:39002/service/status`），根因是外来 IPv6 监听者共享了所选端口；`13-auth-matrix-attempt2` 在 API `39004` 以 `EADDRINUSE` 失败，根因是 wildcard 探测可与特定 `127.0.0.1` 占用在同一 macOS 主机上共存。
- 早前统一 run（会话 `01a0f3fd`）在真实原生 matrix 第 16 项于 Standalone reload 处失败后终止，final-source root / static **未执行**；其根测试（644 文件 / 6434）与集成（lite 156 + full 45，**仓库 fake QLever 夹具**）均为**改动前历史**，不作为当前 final-source 证明。
- 浏览器 / 桌面矩阵中间轮次（已由 Root 审阅实际 `report.json`）：浏览器侧既有全绿也有非全绿，当时桌面侧尚未全绿；中间一轮（`53303`）为浏览器 9/9、桌面 0 通过 / 1 失败 / 2 未执行。两类失败要分开看，**不可**混为一谈：
- **浏览器侧间歇性非全绿：成因保持未证实**。失败疑似与导航相关，但 `DOMContentLoaded` 超时**不能**证明 Gateway 文档失败，也**不能**证明某个响应是否提交；产品响应 vs 测试生命周期尚无逐请求证据，不得据此断言 Gateway 根因。
- **桌面侧 `53303` 失败：已知成因，非未证实的导航停顿**。cloud 例已进入受保护的 AI Config，但 config GET 500、models 403（消毒 trace `47661`：DPoP config 500 / models 403 → session-owned Bearer 200）。已定位为 `AiConfigHandler` 的 mapped-Pod-access-error 契约问题，并在**源码 / 单元**层修复（§12.4「改动后源码 / 单元证据」：developer red 1/25 → 26 通过、related 57 通过、types 0，Root 独立 3 文件 / 36 用例 exit 0）。该中间轮次不是桌面通过证据；本轮修复后的真实 Electron 结果见下方「最终源码全门禁」。
- 最终源码尝试 `78113`：五项重建与静态检查通过后，真实原生浏览器矩阵为 **4 通过 / 1 失败 / 4 未执行**，Electron 未运行。加强后的 AI Config 内容断言捕获 managed-local 加载错误（应为 6 行，实际 0 行）；同一轮 Cloud 内容检查通过。实际日志记录客户端凭据 token exchange HTTP 400。其下游 root / packages / Bun / 完整集成未执行，不作为通过证据。

**改动后源码 / 单元证据（已通过，但不等于真实矩阵 / Electron / 发布）**

- 端口分配：`NodeRuntimeHost` 默认端口改用 wildcard + loopback 分配器；Root 独立 Node 14 / native Bun 3 通过。**仅默认 wildcard / loopback、macOS**；非 Linux、非自定义 LAN bindHost。
- AI 配置访问失败映射：`AiConfigHandler` GET / PATCH 复用既有 `sendPodAccessFailure`（owner / scope / DPoP 不变）；developer 由 red 1 失败 25 通过 → 26 通过，related 57 通过，build ts / types 0；Root 独立 36 通过。源码 / 单元级修复已接受，最终真实 Electron 三模式也已通过，见下方独立报告计数。
- 客户端凭据 issuer 绑定：`common.ts` 的 session factory 改用 `oidcIssuer ?? solidBaseUrl`，避免把 managed Local 的 SP 地址当作 Cloud issuer；内部 CSS 别名路由保持原契约。Root 的实际隔离 CSS / 原生运行时 / 同一真实凭据对照中，错误 canonical 返回 `400 invalid_dpop_proof`，正确 issuer 返回 200 DPoP 且 WebID 匹配；这是请求机制诊断，**不等于完整 managed-local 矩阵**。新增容器注册回归先得到 1 失败 / 3 通过，修复后相关 8 文件 / 87 用例通过，后端编译与测试类型检查 exit 0。首次新增测试的 Vitest 泛型类型错误已修正；随后完整产物重建和真实三模式矩阵均通过，见下方最终源码结果。
- 组件回归单测（Vitest）：BG 单一当前凭据 + identity generation 14/14；sharedDialog 26/26。
- Local 模式 other-root 的 FirstPod 漏洞已修复并由 Lead 复验通过（`lead-first-pod-local-scope.json`）。
- 原生预检：QLever 补丁 `603ae070`、ABI 7 的原生运行时预检仍有效，但**预检不等于真实矩阵通过**。

**最终源码全门禁（Root 接手后，2026-10-01 01:52 UTC）**

用户明确「好，你先自己来实现吧」后，剩余修复和测试由 Root 接手。冻结 115 个源码 / 测试 / 文档文件，完成全部产物重建后依次执行 20 道门禁；每项均读取实际进程退出码，全部 exit 0，结束时逐文件 SHA-256 复核未发生变化。

| 验收层级 | 当前实际结果 | 证据边界 |
| --- | --- | --- |
| packages、后端、Components.js、app / dashboard / settings、desktop 构建 | 全部通过 | 本地完整重建；不是 RC 精确 SHA 产物 |
| 测试类型、UI lint、版本、diff 检查及末轮复查 | 全部 exit 0 | 当前源码；没有放宽产品接口或新增依赖 |
| 工作区包测试 | 856 通过 | shared-ui 143、pod-collections 68、solid-sdk 141、extension-sdk 86、ai-connections 418 |
| 根测试 | 646 文件 / 6,472 用例通过；40 文件 / 282 用例条件跳过，1 todo | 仓库默认条件测试；不把跳过项算通过 |
| Bun runtime / allocator | runtime smoke exit 0，allocator 3 通过 | vector 动态扩展因本机 sqlite3 能力未执行；不是 VEC conformance 证据 |
| Bun WebSocket relay | 9 通过，0 失败 | 原生 Bun 单独执行 |
| 完整集成 lite + full | lite 31 文件 / 156 通过，3 文件 / 6 条件跳过；full 4 文件 / 45 通过 | 仓库 **fake QLever 夹具**，真实 Postgres / Redis / immutable S3；不是原生 runtime 矩阵 |
| 真实原生浏览器三模式 | **9 通过、0 失败 / 跳过 / flaky** | 实际 Chromium、独立 Cloud / managed-local / standalone，含加强的 AI Config 内容与刷新断言 |
| 真实原生 Electron 三模式 | **3 通过、0 失败 / 跳过 / flaky** | 实际 Electron 的认证 renderer、托盘保留与退出恢复；不替代 macOS 安装包发布验收 |

真实矩阵 PID `42599` 最终进程 exit 0；Root 独立读取 browser 与 desktop 的实际 `report.json`，并确认运行的是 ABI 7 / patch `603ae070` 的真实 native QLever 进程。两份最终报告分别为 expected 9 / 3，unexpected、skipped、flaky 均为 0。这是隔离真实拓扑的本地验收，**不表示用户 40991、RC 或生产已更新**。原生 artifact 已复核全部 15 个文件 SHA-256；发布仍须由 exact 新 source SHA 在 RC 构建并接受产物。

**视觉分项（私有 fixture：路由 Account API / 桌面桥；非 Gateway / Electron / 40991 / RC / prod）**

- 实际源码 fixture 由旧 12 失败 → 新 9 通过 1 失败（390 + 200% root text 溢出 34px）；对页面 wrapper 施以最小 `min-w-0` 一处类修复后，developer 10/10 + shared 143，浅 / 深主题 0 溢出。Root 曾独立复现 9/1 与 34px 并查看新截图，随后 Root 独立绿运行（`lead-account-visual-run.json` playwrightExit 0、`lead-account-visual-results.json` expected 10 / unexpected 0）证明 10/10。
- 注意 root font 16→32、rem 12→24，但固定 px 17 **不变**；**不是**实际 Chrome 200% zoom，也**不是**所有文字加倍。旧 3 / 2 / 32 计数的页面布局、对话框键盘与状态分项仍为私有无头 fixture。

**提交前第二轮完整集成（Root）**

在上表完整门禁通过后，Root 再执行一次完整 `bun run test:integration`，实际 exit 0；lite 156 通过 / 6 条件跳过，full 45 通过。测试开始与结束逐文件复核冻结的 115 文件无变化，终止时间为 `2026-10-01T02:00:24.971Z`。随后仅同步本文的状态叙述和已发生的验收结果，产品与测试文件 SHA-256 保持不变。

**提交与外部发布门禁**

- 提交前必须再次运行 **第二轮完整 `bun run test:integration`** 并读取实际结果；外部发布仍须精确 SHA 的 RC acceptance、stable promotion、npm 消费者和同 digest 生产验收。
- `tests/e2e/login-deployment-matrix.spec.ts` 已对齐同 origin + 精确 UID 显式创建，并新增轻页「使用自己的部署」→ 同源 `/settings/pod` → 「回到授权」原 Consent → 轻页再次创建；该流程在最终真实三模式浏览器矩阵中执行并通过；源码适配和 scoped types 本身仍不能代替矩阵证据。

**未发布 / 范围边界**

- 本节记录的是提交前的本地验收结果；`0.4.20` 在本节更新时 **未发布**（无 RC / stable / prod）。发布结果必须以 exact SHA 的 acceptance artifact、稳定发布与生产运行证据为准。
- 用户 `localhost:40991` 未更新、未启动；本文不代表该实例验收。
- **历史计划**：跨设备 `nodes`（`/v1/nodes` 501）/ 设备 API / 远程拉起 / 网络接线 / B2 后端编排当时列为 §11.3 第二期（B2 现已由 §13.16 撤回）；**不得**用 `nodes` 501 推迟已接入的 Account 公共呈现 phase1，**不得**用 HTML 原型里的 fake 设备 / 假定时器 / 假状态冒充真实能力（§8.4）。

状态：本文档截至 2026-10-01 **本地实现与本轮 20 道验收门禁已通过**；提交前第二轮完整集成也已通过，精确 SHA 外部发布按 §12.4 执行。任务完成须包含 RC、stable、npm 和同 digest 生产证据。本文不代表用户 `localhost:40991` 已更新或已验收。


## 13. 发布后用户验收修订（2026-10-01，本地回归通过，未发布）

本节记录 0.4.20 发布后的用户实测问题，优先于旧呈现细节。0.4.20 已发布是历史事实，不表示本节修正已发布。当前修正分支为 `codex/login-acceptance-followup`。

### 13.1 两套 Web 页面的入口与职责

2026-10-02 用户确认的新边界优先于前文旧入口约定：**Web 始终轻量，重管理仅在桌面 Xpod 提供**。dashboard、settings、回调文档现经同一个宿主入口收敛：只有桌面 preload bridge 才加载工作台和桌面 OIDC callback；浏览器显示轻量桌面指引。最终真实链路证据另见 §13.8，旧工作台浏览器测试不再代表此契约。

| 页面 | 正常入口 | 职责与去向 |
|---|---|---|
| 账号服务 | 身份服务的 `/.account/`；已有会话进入 `/.account/account/` | 邮箱登录、注册、找回、WebID/Pod 绑定总览、授权和账号安全。它不是完整工作台。 |
| 桌面 Xpod 工作台（重页面） | 桌面 Xpod；`/settings/pod`、`/ai-connections` 等为桌面承载的规范工作区 | Pod、AI 连接、系统配置等日常管理仅在桌面提供。Web 留桌面 Xpod 入口，明确说明用途；不能继续直接展示完整工作台。 |
| 工作台回账号服务 | 已登录工作台的账号菜单 → “账号管理” | 使用已发现的账号服务 index 构造账号总览地址；managed Local 不得误跳本机假账号管理页。不接受非 HTTP(S) 或带用户信息的 index。 |
| Consent 快速创建（轻页面） | 缺 Pod 的同 UID Consent → 同 UID `create-pod` | 快速创建后回原 Consent；“使用自己的部署”引导到桌面 Xpod。保持 §9 原有一次性任务与安全验证，日常访问不复用旧 Consent 任务；不得假定浏览器任务已安全跨进程迁移到桌面。 |

“重页面”仅是设计文档内的布局术语，不出现在按钮文案中。生产工作台与账号服务可在同一部署中，但两者的会话准入与职责仍各自保持。

### 13.2 身份、存储与部署类型

- 卡片名称是 WebID 的可读名称。WebID（身份地址）与 Pod（存储地址）分别标注，完整 URL 放在默认收起的“查看地址”中，展开后可读、可点，不能混成两行无标签的长地址。
- 根据真实绑定的 Pod origin 与该账户的已发现身份服务 origin 区分“账号服务托管”与“独立部署”。WebID 与 Pod 同源只表示同一源，**不能证明它是云端 Pod**。
- “独立部署”是部署关系，不冒称“这台电脑在线”。当前没有设备事实时，不按账号名、node-id 或 hostname 子串捏造本机/设备状态。
- 删除 Pod 等危险操作显示按钮边界并保留既有确认；不得静默删除或把管理入口做成删除动作。

### 13.3 品牌与浏览器标签

- Account 生产模板、Vite Account 入口、工作台的 dashboard/settings 入口及登录回调都使用同一选定 Xpod 品牌，移除活动入口的 Solid/Vite 默认 favicon。
- Account 标签命名为“Xpod · 账号服务”，两份工作台构建入口统一为“Xpod · 工作台”。两个构建 bundle 不代表两个独立产品。
- favicon 采用 homepage 已选定、经小尺寸优化的留缝折角 `xpod-app-16.svg`；16/24px 源文件副本在 `ui/public/brand/` 留档。来源与 hash 见 `docs/design-history/2026-10-01-login-web-entry-and-brand.md`。原有历史图标资源不删除。

### 13.4 邮箱输入框与选区兼容

- 用户反馈 Chrome 拖选或双击后“先全选，随后只剩一个字符”。此问题与焦点框分别验收。
- 不得把快捷键全选通过当作鼠标问题通过；须记录真实系统 Chrome 的鼠标事件和选区，并与同浏览器裸输入框对照。
- 实际 Chrome 配置中的旧 React 邮箱框及裸 `type=email` 对照，均观察到双击选区随后丢失，期间没有输入框替换或 value 重写。裸 `type=text` 对照保留选区。辅助功能返回的一个对象占位字符不能证明实际选中了某个邮箱字符；Chrome、扩展或辅助功能交互中的具体触发者尚未确定。
- 以共享 `EmailInput` 统一登录、注册、找回密码的兼容实现：展示控件使用 `type=text`、`inputMode=email`，保持 `name=email` 与原有 `autocomplete`、禁用拼写检查和自动大写。复用 `Input` 的外观和焦点规则，不在各页面复制处理逻辑。
- 邮箱语法仍交由浏览器的离线 `type=email` 控件判定，并通过展示控件的 `setCustomValidity` 参与表单校验。支持受控更新、input/change、multiple；required/pattern 继续由展示控件验证。不硬编码另一套邮箱正则，不强制全选或恢复选区，不禁用浏览器扩展。
- 实际 Chrome 加载编译后匿名本地页面：双击选中邮箱用户名后至少 1 秒仍保持，直接键入只替换选中部分；鼠标三击全选后至少 1 秒仍保持。密码管理器仍识别用户名控件，但未授权或测试真实密码自动填充。实际系统拖动工具未产生有效拖选轨迹，不能据此宣称用户配置的拖选已验收；自动化浏览器的真实鼠标拖选另有通过证据。
- 此结论是经对照验证的兼容措施，不宣称已确定浏览器或扩展根因，也不代表生产实例已更新。

### 13.5 本轮修正的本地回归证据

- 最终 shared-ui 单元测试 149/149、账号与入口相关 host 测试 59/59、隔离浏览器布局与鼠标选区 15/15；共享组件构建、UI 三入口构建、UI lint、测试类型检查、依赖状态和 diff 检查均通过。
- 首轮完整集成在 Matrix sync 超时：lite 155 通过 / 1 失败 / 6 条件跳过，full 因前置失败未执行。没有修改 Matrix 产品代码、排除用例或增加超时时限，也没有把失败归因为环境。
- 后续完整集成通过：lite 156 通过 / 6 条件跳过、full 45 通过，exit 0。邮箱校验与 ref 复查修正后，再运行最终完整集成，结果同样为 lite 156 通过 / 6 条件跳过、full 45 通过，exit 0。
- 本地证据保存在忽略目录 `.test-data/login-lead/feedback-final-acceptance.md`、`feedback-email-final-*`、`feedback-frozen-typecheck.log`、`feedback-integration-2.log`、`feedback-integration-3-final.log`；实际 Chrome 对照记录在 `.test-data/login-feedback-selection/`。视觉截图已复核浅/深单一边界与 Account 总览。
- 这些本地分项不代表生产部署更新。实际 Chrome 使用编译后的匿名 fixture；用户原标签页、真实账号/Pod、40991/5173 服务和密码管理器配置没有变更。

### 13.6 用户验收补充：删除确认与独立 Local 删除（历史阶段记录）

用户截图暴露两个遗漏：使用原生浏览器确认框，以及独立 Local 删除失败。旧 `pods` inventory 管理 URL 并未提供 DELETE，旧 Local API 又只删除目录。本项补充优先于 §13.2 的“保留既有确认”描述。

- 共享页面内确认弹窗：默认焦点取消，显示完整 Pod 地址及不可撤销说明；取消零请求，请求中禁止重复点击/关闭，失败留在弹窗内并可重试。撤销客户端凭据复用该组件。
- 前端只接受独立 `podDeletionControls` 声明，不把 owner 管理 URL 当作删除能力。未知外部 provider 或无法证明旧独立部署代次时安全关闭该能力。
- 自有 Pod 的文件/RDF/ACL 与账号 metadata 经同一生命周期删除。受管 Local 通过可信节点身份与精确目标/代次的命令执行，Local 完成后才清理 Cloud 绑定；节点离线或回执失败不隐藏绑定。
- 旧独立 Local 绑定先在账号页申请短期授权任务，再进入该节点的单任务删除授权页面，由 Local 管理员确认当前 Pod 代次。该页面不提供完整工作台导航；浏览器仅承载这一次授权操作。此步骤只恢复删除能力，不执行删除；返回账号页后仍需独立确认永久删除。普通预配 token、heartbeat 或已有 Pod 的 receipt 均不能代替管理员授权。公共隧道入口无法证明本机管理员权限时，提供转到本机管理地址继续的入口。
- 删除计划持久化；写入、删除、创建相互协调；旧操作不能误删同地址重建的新 Pod。具体接口与边界留档于 `docs/pod-deletion-lifecycle.md`。
- 已完成页面 fixture：AccountPage 与 Local 授权面板 37/37、共享 UI 151/151、窄屏明暗确认弹窗及完整布局/邮箱浏览器回归 22/22；这些是 mock UI 证据。隔离 Cloud→Local 原生存储删除链已实际通过，完整集成测试用例通过后仍有 Bun 关闭卡点，正在修复；进程未正常退出的运行不算完整门禁通过。本段不能视为已发布或当前生产 Local 删除已通过。

### 13.7 Local / Consent 独立复验（2026-10-02，历史轮次）

当前源码隔离实例中，Local 浏览器 6/6、Consent 实际存储恢复 7/7、安全守卫 114/114 和 Cloud→Local 原生删除 1/1 通过。Managed Local 桌面通过；Standalone 桌面出现回调页停顿，单独复查通过，但仍保留间歇性失败。Cloud 重登录也出现账号页停顿。整体稳定性尚未验收通过。

本轮最后补跑的完整集成正常退出：Lite 157 通过 / 6 条件跳过，Full 46 通过，命令 exit 0。这是本轮门禁通过证据，不抹除此前关闭失败或上述 UI 导航失败，也不代表专项 WebSocket 替换/心跳关闭缺口已经修复。

测试脚本已按公共邮箱输入与 WebID 单选卡更新定位，未为测试修改产品行为。具体拓扑、分项、失败和私有证据见 [Local 与 Consent 验收记录](../../testing/2026-10-02-local-consent-acceptance.md)。本历史轮次结束时桌面独占重管理边界和残留旧品牌仍待实现；后续实现以 §13.8 为准。

### 13.8 桌面边界与登录部署信息（2026-10-02）

- Web 的 dashboard/settings/callback 统一由 `XpodProductEntry` 分流。只以桌面 preload bridge 判断宿主，不根据 hostname、查询参数或屏幕尺寸开放工作台。浏览器提供真实桌面下载入口与按发现的 issuer 构造的账号入口；单次 Local 删除授权保留为轻量任务。
- Consent 自己部署入口保留原标签页的一次性任务；显示入口与点击返回时均重读 Account/interaction 绑定。过期、账号切换或权限撤销时关闭续接，不能自动批准或假定跨进程转移。
- 正式登录品牌复用共享 `XpodMark`，不再使用旧 shield；favicon 继续采用 §13.3 的留缝折角。
- **最新呈现以 logo + info 取代独立 tag**：同一正式 Xpod 主标用“云端”“托管部署”“独立部署”下标区分，嵌入已有品牌位置，不另加信息行或重复 logo。悬停、聚焦或点击 info 显示部署类型（Cloud/Local）、当前访问、节点/服务地址与不同源的账号服务；再次点击、Escape、外部点击收起。长地址换行，窄屏详情不溢出，不默认堆放多行信息。
- 通用 `BrandInfo` 只提供 `logo`、`info`、`infoLabel` 与样式插槽，支持任意宿主品牌，不请求接口或判断 edition。Xpod adapter 负责真实元数据与下标，Account 普通/内嵌登录、Consent、桌面首次登录和回调复用；共享服务栏不能把整个图标插槽设为 `aria-hidden` 或裁剪交互图标。
- Account 登录与桌面首次 WebID 登录复用 `XpodDeploymentIdentity`。`/api/service-info` 使用服务端 edition 和原有预配状态，响应禁止缓存；只输出安全 HTTP(S) 展示地址。缺失分配地址显示“尚未分配”，不以 `CSS_BASE_URL` 本机回退冒称分配成功；显示元数据不参与认证授权。
- 最低 Bun 基线改为 1.4.2，由包声明、CI、镜像与启动门禁统一约束。原 HTTP 流停顿和 WebSocket 关闭问题均先在旧 Bun 重现，再在相同产品代码的新 Bun 验证；不通过放宽断言、改用 Node 或代理超时兜底掩盖缺陷。

最新 logo + info（最终 Portal 版本）当前源码原生三部署矩阵正常 exit 0：浏览器 24/24、真实 Electron 9/9；Consent 异常恢复 7/7，组件与宿主回归 271/271。完整集成正常 exit 0：运行时 29/29、Lite 157 通过 / 6 原条件跳过、Full 46/46。窄屏截图已复核，产品与测试快照无漂移。证据统一在 [验收记录](../../testing/2026-10-02-local-consent-acceptance.md) 维护，旧轮次失败记录保留。此修订尚未提交或发布，不代表用户生产实例已更新。

### 13.9 桌面旧会话恢复的权威校验（2026-10-02）

恢复登录前先读取当前 Gateway 的 `/provision/status`。托管 Local 的账号服务以其中的 `oidcIssuer` 为准，不能把节点自身的 OIDC discovery 当作账号服务，也不能用展示用的历史 issuer hint 自证旧会话有效。只检查 Inrupt `currentSession` 指向的公共记录；旧记录 issuer 缺失或与当前权威不符时，关闭此次静默恢复，进入既有登录流程，保留用户资料和 Pod。正常 callback 仍交给 SDK 验证 state、PKCE 和 token。

权威查询与响应体读取共用 5 秒截止时间，失败可重试。SDK 恢复的公开等待最多 15 秒；无法取消的旧签名操作在结束前保持隔离，迟到结果或错误不能覆盖有效登录、退出或更新后的状态。销毁 runtime 时结算公开等待。以上属于恢复保护，不能用超时提示代替实际桌面登录、Pod 读写或 Gateway Chat 验收。

### 13.10 canonical 公网地址的客户端多路径接入（2026-10-03）

公网 WebID 与 Pod URL 保持稳定。桌面客户端按[多通道访问约定](../../multi-channel-access.md)探活并选择可用路径，不能把公网直连失败当作本机 Pod 不可用，也不自动启用 Cloud relay。

恢复登录前使用同一次 `/provision/status` 查询准备资源路由；首次打开已记住的 Pod 同样先准备路由，再访问数据。会话签名请求和显式服务凭据请求共用底层路径选择，后者保留原有 Authorization、请求体和 canonical 标识，不再经过会话签名器。中央账号服务和 token endpoint 保持原 authority；未覆盖的目标直接透传，不触发节点探活或故障重试。

网络故障仅允许 GET、HEAD、OPTIONS 在当前请求中切换路径重试；写操作不自动重放。失效候选只在该次故障切换中排除，后续用户主动重试仍可重新连接。此规则不改变登录凭据持久化方案；本机资源读取成功也不代表中央 Account、模型同步或 Chat 已通过。

### 13.11 登录版式舒适度修订（2026-10-03）

用户明确不追求微信的卡片比例，保留现有品牌与登录流程，放宽默认认证空间。桌面 WebID / Account 认证窗口共用 440×620（兼容最小 320×480），切换时不因表单种类改变尺寸。页面 body 上限 480px；弹层宽度上限 480px、舒适高度 440px，始终受 90dvh 和窄屏可用宽度限制。页面表单保留至少 520px 的内容区。

400px 以下的宿主保留左右 24px 边距，其余用 32px。主体分区间距 28px，操作区间距 16px；主标题 22/600，输入与主操作 16px / 48px 高，字段标签 14px，服务栏最小 56px。较高的桌面窗将多余留白放到操作区下方，避免选项与主按钮断开。窄屏优先保留服务名称，完整域名仍可在已有 info 中查看。

高度不足 560px 的原生认证窗使用 16px 主体间距和顶部留白、12px 操作间距及 16px 底部留白，保留 48px 控件。最小 320×480 的登录选项与独立部署入口不能被固定操作区裁切；更长内容仍由主体滚动。

颜色、logo/info、认证状态、授权规则和请求处理沿用现有实现；次要信息保持默认收起，长表单滚动主体区，操作区保持可达。此前 360×540 / 400px / 17px 的验收记录属于旧版测量，保留作为历史，不再约束本次版式。当前组件截图与测试证据统一存入 `.test-data/login-card-comfort/`，视觉判定存入 `.omx/state/login-card-comfort/ralph-progress.json`。呈现夹具不是实际 Account 或 Chat 验收。


### 13.12 三部署与会话复用契约（2026-10-03）

Cloud、托管 Local（独立节点、中央 Cloud issuer）和独立 Local（自身 issuer）使用同一共享登录组件与轻量 Web 边界；不得把托管 Local 当作独立 Local 验收。三种部署均须覆盖注册后快速创建 Pod、续接原 Consent、已有账号授权、私有 Pod 读写和无登录访问拒绝。

- 有效 Account 登录复用时不重复提交邮箱密码。完整 IdP 会话复用保留 WebID；仅剩 Account cookie、IdP session 已清除时，允许重新选择 WebID，不得暗中补填密码或替用户选择不同身份。
- 账号登录与客户端授权分开验收。外部 native 客户端遵循现有授权策略，复用账号会话仍可要求 Consent；显式 `prompt=consent` 必须显示确认。每次回调使用新的 state，并校验 issuer、WebID 与实际私有 Pod 访问，不以页面跳转成功代替授权成功。
- Xpod 桌面首次明确选择“以后不再询问”后，同一客户端、身份和权限的有效记住授权可复用。关闭到托盘后保留同一 renderer、会话与私有 Pod 访问；完整退出后允许自动恢复或既有记住账号入口恢复，两者均不得重复输密码或重复 Consent。记住账号元数据不等于持久化 token。
- 无登录的新浏览器上下文须要求密码且拒绝私有 Pod；离线退出后不得复活旧身份；延迟返回的 provider 数据不得把已退出的会话重新置为已登录。
- 令牌生命周期另验：access token 到期后由真实桌面 SDK 自动续期，仍可读私有 Pod且不新增授权码登录；refresh token 到期返回 `invalid_grant` 后展示过期状态，经用户重新登录取得新授权码，再恢复原私有 Pod 读取。

**历史验收范围**：以下记录来自修正 Cloud card 拓扑之前的前版夹具，不能作为 §13.14 正确拓扑或本机已安装版本的会话恢复验收凭证。保留退出码事实；本轮必须重新验证真实跨站入口、冷启动与令牌到期链路。

本轮隔离真实 Xpod 三拓扑矩阵 browser 30/30、Electron 9/9，零跳过、零重试成功：三模式均自动冷启动恢复，密码提交仅首次 1 次、托盘与冷启动 Consent 增量均为 0。浏览器两类会话复用、显式 Consent 与干净上下文隔离均通过。矩阵使用隔离账号、真实 Cloud 数据服务和原生 Local QLever，不替代用户原安装资料或生产公网网络的验收。独立 Local 的实际 Electron 短期令牌专项 2/2，覆盖自动续期及 refresh 失效后的用户重登；不扩大为三部署 TTL 验收。最终完整集成正常 exit 0（运行时 30/30、Lite 157 通过 / 6 原条件跳过、Full 46/46），类型检查与 UI lint 通过。分项证据在[验收记录](../../testing/2026-10-02-local-consent-acceptance.md)维护；AI 模型同步和 Chat 不属于上述登录通过结论。

**2026-10-03 拓扑纠正：** 上述是当时实现的历史行为证据，其中 managed Local 将 profile 放在节点 Pod，违反 §13.14 的独立 Cloud card 契约；browser/Electron 通过不代表该契约已经验收，需修复 provisioning 后重新执行。原退出码和请求事实保留。

### 13.13 空闲续期与浏览器授权返回页（2026-10-03）

空闲六小时本身不是要求重新登录的条件。access token 到期时，由原 SDK 的令牌持有层在发出首次认证请求前续期；计时器暂停后也按真实到期时间检查，并发请求共用一次续期。续期暂时失败不发送旧令牌、不自动重放写操作，也不把服务商的普通 401 误判为 Xpod 会话过期。refresh token 已失效时沿用显式重新登录；仍有效的 Account / IdP 会话应复用，不能因客户端重取授权码而重复要求密码。

浏览器 loopback 授权回调使用正式 Xpod 折角主标、墨水紫操作色及暖中性色。页面自包含，无外部资源、脚本或自动启动应用；提供明确的“返回 Xpod”主操作，适配窄屏、明暗主题和键盘聚焦。接收成功、链接无效、授权未完成、接收失败分别呈现，成功文案只表示授权结果已被接收，不表示 token 交换或 Pod 保存已经完成。

返回链接固定为 `xpod://ai-connections`，只承载导航，不携带授权码、state、token 或任意目标 URL。桌面复用现有窗口与会话；正在进行的 Account / PKCE 登录保持原页面，等待产品壳就绪后再处理导航。回调继续保留一次性 state、有效期、Host / 路径及参数校验，HTML 禁止缓存和 Referer 传递。最后一个注册过期后原有监听器关闭，不能承诺此时仍能渲染失效页。

桌面 OIDC 回调在组件挂载时保存原始回调地址。SDK 交换授权码并清理浏览器地址后，若首次 profile 读取暂时失败，原页面的重试仍使用这一次回调的绑定，不能因地址已清理而报 `oidc-state-invalid`、重新交换授权码或主动退出。身份、state、时效和目标路由检查继续生效。

前端呈现快照归档于 [授权返回页设计留档](../../design-history/2026-10-03-authorization-callback/README.md)。实际安装版、短期令牌与全量门禁的证据及限制见 [验收记录](../../testing/2026-10-02-local-consent-acceptance.md)。

### 13.14 本机可用性不依赖公网路由（2026-10-03，profile 归属纠正）

Cloud 与 managed Local 使用 Cloud 托管的 WebID 和 Cloud OIDC issuer；独立 Standalone 使用自身账号服务与 profile，不强制依赖 Cloud。`profile/card` 是独立的身份与 Pod 发现文档：无论 Pod 存储部署在 Cloud 还是 Local，这份 card 都在 Cloud，身份地址不随数据位置或 Local 公网路由改变。card 通过 `solid:storage` 声明实际 Pod 的 canonical URL，通过 `solid:oidcIssuer` 声明 Cloud issuer。Local 保存用户 Pod 数据及其访问控制，owner 使用同一个 Cloud WebID；不能从 Local Pod URL 拼出一个新 WebID，也不能为托管这份 card 额外创建一个 Cloud 用户存储 Pod。

`publicRoute.configured=false` 或 `available=false` 只表示 Local 的远端数据入站路径不可用，不是本机登录、授权、私有 Pod 读写或 AI Connections 的前提。Cloud profile 仍须可以通过 Cloud 读取；本机访问 Local 数据按既有 managed route 选择本机/LAN路径，不改 WebID、issuer 或 canonical Pod URL，也不自动开启 Cloud relay。中央账号服务及模型上游的出站访问条件独立验收。

验收必须分别证明 Cloud card 匿名 HTTP 200、其中的 issuer 与 Local storage 指针、Account/token/session/Local owner 使用同一个 Cloud WebID，以及公网数据入口关闭时本机私有读写可用。新建 managed Local 身份的 Cloud 命名空间只托管 card 及必要的原生访问控制：owner 可以管理 card，但不能因此获得向该命名空间上传任意 Cloud 用户文件的权限；不得新增 Cloud 用户存储 Pod。这一限制不收紧既有合法 Cloud 存储 Pod 的数据权限。不能关闭 Local profile 地址后以跳过 profile 验证来声称这套部署架构已通过。会话复用、模型列表与真实 Chat 仍须按各自请求结果独立报告。

前版 §13.14 将 profile 误认为托管在 Local，并据此要求新增 Account-only 自有公钥验证；此方案前提已撤回，Draft PR #29 暂缓，先前上线确认作废。原测试退出码与请求事实保留，但其 Local-profile 拓扑不能作为本契约的验收证据。本轮源码修正通过 authenticated `controls.account.profile` 先准备当前 Account 的 Cloud card，Local prepare 接收同一 Cloud WebID，Cloud finalize 使用原生 `settings.webId` 登记签名回执并更新发现指针。源码回归、修正后的真实栈验收和精确 SHA 发布结果须分别记录；此前通过的错误拓扑不能替代本轮证据。既有 node-origin WebID 的迁移单独处理，不得默默改写用户已持有的身份、凭据或 Pod 数据。


### 13.15 账号记忆与重复密码复核（2026-10-03）

“记住账号”控制 CSS Account cookie 的生命周期与该 Account authority 的邮箱提示；Consent 的“以后不再询问”是独立的客户端授权选择。取消勾选时，邮箱只供本次页面会话使用，清理同 authority 的旧持久邮箱提示；勾选时才保存持久邮箱。展示缓存只包含非秘密身份信息，不保存密码或 token。

Account 表单首次进入、没有该 authority 的明确历史选择时，保持 B1 的**默认不勾选**；仅恢复同一已确认 authority 下用户显式保存的选择。Consent 保持 B4 的**默认不勾选**，不能由 Account 记忆或旧测试注入自动选中；需要记住授权的真实验收须明确操作该选项。

表单挂载后 Account authority / 记忆选择可能晚到：只在 authority 已确认、当前表单尚未被用户编辑时补齐该 authority 的已保存选择，不能用晚到结果覆盖用户刚输入的邮箱或刚切换的勾选。authority 改变时重新隔离表单选择与提示；上一 authority 的异步结果、未标作用域的旧记录以及全局默认值均不得冒充新 authority 的用户选择。

已确认的 authority 切换时，密码及密码确认字段必须清空；不能将上一服务的密码带到新服务。首次初始化尚未确认 authority 时禁止提交密码；稍后确认同一次登录目标时，只补齐未被编辑的邮箱，不覆盖用户已经输入的内容。

Cloud 与本机 origin 的浏览器存储彼此隔离。不能假定 Cloud 上的选择自动出现在本机存储，也不能把其他 authority 或旧未标作用域的邮箱拼接到当前账号。独立 WebID 展示缓存与 Account 持久登录分开判定；存在展示缓存不证明账号 Cookie、WebID 会话或 Pod 已就绪。CSS Account 的实际 id 必须保留；当响应缺少 username/displayName 时，可用本次同 authority 的邮箱补展示信息。

验收须统计实际密码 POST 和 OIDC 发起次数，并分别覆盖默认桌面入口、旧入口转入、有效账号 Cookie、完整退出后恢复与令牌过期。Cloud localhost 与 Local 127.0.0.1 的跨站场景必须使用真实 Cookie/OIDC，不得注入 Cookie、token 或记忆选择制造通过结果。新建夹具的首次登录只有一次密码，不替代已安装版本与用户原有资料的复现。


**检验范围**：文档校正本身不构成实现通过。默认选择、同 authority 选择恢复、用户编辑后 late bootstrap、authority 切换隔离等代码回归，以及正确拓扑的跨站会话和实际安装版须另有独立证据。§13.12 的历史矩阵不能作为本轮通过结论，亦不证明模型同步或 Chat 可用。

### 13.16 注册与入口规则的替代裁决（2026-10-03）

本会话已确认：注册只创建 Account；缺 Pod 时返回原 UID 的轻量流程，由用户明确提交创建。此裁决替代 2026-09-29 B2“注册同时建 Account、WebID 和 Pod”及其第二期实施计划；原评审确实提出过该计划，但它不再是现行要求。§12 的实施记录、退出码和旧入口事实保留为历史，不因本次文档校正改写为当前通过。

Web 始终轻量，独立部署入口引导到桌面 Xpod；Consent 任务留在原浏览器并在返回时验证，不承诺自动跨进程迁移。Cloud / managed Local 的 card 始终在 Cloud，Pod 数据位置由发现指针表达；Standalone 不强制依赖 Cloud。Account 与 Consent 的默认均保持不勾选，恢复同 authority 的已保存 Account 选择与主动记住客户端授权分别验证。


### 13.17 跨站桌面账号状态与标准 SDK 会话（2026-10-03）

Managed Local 的本机页面不能依赖跨站 fetch 自动携带 Cloud Account cookie。桌面已有有效 Solid 会话时，先读取 Cloud 的真实 Account controls：Cookie 已确认登录的 Account 保持优先；只有 Cloud 明确返回匿名 controls，且当前 SDK issuer 与 Account authority 一致时，才通过现有 SDK authenticated fetch 再核对账号。账号 id 与操作入口来自服务器响应，不从 WebID、JWT 展示字段或缓存推断。

Account 与 Solid 身份保持独立。Cookie 的 Bob Account 可以与 Alice WebID 同时存在；补齐账号状态不能覆盖一个已经确认的 Cookie Account，也不能将它的操作权限交给另一个 WebID。通过 SDK 确认的 Account 操作沿同一个会话请求来源执行；读取、创建和续接各自仍遵守原有 authority、interaction UID 与绑定校验，非 Account 请求保留其既有传输。

账号信息核对期间显示正在恢复，不能先展示第二份密码表单。SDK 会话或 issuer 切换、退出、组件卸载立即撤销依赖该 SDK 的账号请求来源和能力，迟到响应不能恢复旧账号；独立 Cookie Account 仍按自身状态判断。退出不能被尚未清理的 SDK 会话自动反向恢复；网络失败保持可重试状态。仅仅补齐同一 SDK 会话的 Account 展示信息，不得取消正在签发的客户端凭据、重新发行 Key 或重建 Solid 会话。

本节是修复契约，未单独宣称验收完成。代码回归须覆盖独立身份、来源撤销、在途凭据和迟到响应；真实跨站桌面还须证明账号状态、精确绑定、私有读写及密码次数。当前失败与随后复验在[验收记录](../../testing/2026-10-02-local-consent-acceptance.md)追加，不用历史通过记录替代。


#### Account 展示缓存的权威范围（2026-10-03 补充）

历史 Account 展示缓存只在 issuer 与服务器权威 Account id 均精确匹配时补齐缺失的名称。复用 `resolveAuthoritativeAccountId(controls, identity)`，包括服务器仅通过 Account controls URL 提供 id 的情况；不得从历史缓存、JWT 或 WebID 猜测 Account id。权威 id 无法可靠确认，或旧缓存没有 id 时，不借用历史 Account 名称、用户名或邮箱来冒充当前 Account。服务器返回的 username / displayName 优先；本次登录流程的 pending 邮箱仍可按现有 issuer 范围提供展示，另一个 Account 的历史字段不得覆盖它。

该约束仅限 Account 展示缓存，不把 Account id 变成 SDK 认证键，不修改 WebID / Pod 记忆匹配或权限。Cookie Account 与 SDK WebID 保持独立；Cookie Bob 与 SDK Alice 的合法独立会话不因缓存展示规则而被合并、覆盖或否定。当前激活 WebID 的 profile 展示仍归该 WebID。


#### Account 探测结果与独立凭据能力（2026-10-03 后续修复契约）

SDK Account 探测只有真实 401 / 403 或经过结构校验的匿名 controls 可以确认匿名。503 等临时失败、网络失败及非法的 200 响应必须保留可重试错误状态，不能落入匿名成功而跳过重试；Cookie Account 原有 500 错误语义保持。账号探测失败不等于账号已退出，也不能据此再次要求密码。

Cookie Bob Account 与 SDK Alice WebID 并存时，服务器的 Cookie 优先规则保持；不得把 Bob 的 client-credentials collection 当作 Alice 的自证能力。SDK 专属 Account 能力的 index / create / list / revoke 必须沿同一套 Cookie-free authenticated fetch：省略 Cookie，去除继承的 CSS-Account-Token，仅由现有 SDK 提供自身 DPoP 认证，并校验当前会话、authority / Account path 与禁止重定向边界。Cookie Account 能力只有在真实 bindings 明确包含目标 WebID 时才可借用；否则应取得 SDK 身份自己的能力，不以降低服务器自证检查解决 400 / service_access_missing。

本补充是已确认缺口的修复约束；独立凭据、临时探测错误及随后真实栈复验的证据分别见验收记录，此前展示修复的原生通过不能覆盖这两项后续变化。请求来源与凭据边界是程序行为，不作为普通 UI 产品文案中的实现细节。

#### 活会话、页面恢复与账号记忆的分别验收

当前浏览器 SDK 的安全令牌、refresh token 和 DPoP signer 留在 SDK 内存；整页重载或进程重启不等于仅重新构建请求凭证。跨文档恢复由标准 SDK 重新向 issuer 授权，同一有效 Account Cookie 应免去再次提交密码，但该过程不能被记为复用上一文档的 refresh grant。账号记忆、授权记忆、展示提示都不能代替安全令牌，也不得将令牌复制到这些公开存储中。

Cookie Bob 与正在运行的 SDK Alice 的独立能力验收，应保持真实 Alice 会话，以正常 Account refetch 更新 Cookie 账号，再首次触发 Gateway 凭据申请；不得用清空、注入或回填令牌构造通过。跨文档后若当前 Cookie 主体已经改变，须另行核对新的授权主体与 storage binding，不能仅凭相同 issuer 宣称仍是 Alice。本条记录当前恢复边界，不承诺跨账号 Cookie 切换后静默保留旧主体；原安装版恢复与实际六小时续期仍须独立证据。

#### 当前账号 Cookie 寿命与邮箱提示范围

2026-10-03 核对的 CSS 实现中，Account Cookie 服务端 TTL 为 14 天，Xpod 未覆盖该 TTL。勾选“记住账号”后，成功的 Account 交互会滑动续期，并为浏览器 Cookie 设置 Expires；普通 Pod 数据请求本身不触发这条续期。不勾选时浏览器使用没有 Expires 的会话 Cookie，这条交互链不续期。当前实现没有六小时账号登录硬期限；账号 Cookie、OIDC access/refresh token 与 SDK 活会话的寿命须分别判断。

Refresh Token 刷新 Access Token 不依赖 Account 登录 Cookie。即使账号 Cookie 已过期，只要当前 SDK 会话的 Refresh Token 仍有效，就继续续期 WebID 活会话，不得因账号状态而强制密码重登或退出 SDK。账号 Cookie 负责账号页面及新的 OIDC 授权免密码恢复，不能作为 Refresh Token 有效性的判断条件。

只有必须发起新的授权且 issuer 现有登录态也无法复用时，才重新要求账号密码。Access Token 到期、跨文档 SDK 恢复或暂时的探测错误不能单独触发密码重登。用户明确退出某一会话的选择仍须遵守其自身作用域，不得被迟到响应反向恢复。14 天是各自会话的当前配置寿命，不是统一的密码重登周期；账号交互续期也可能延后其 Cookie 到期时间。

邮箱提示仅属于当前浏览器 origin 内、已确认 Account authority origin 的存储范围，不区分该 authority 同源路径。勾选时用持久存储，不勾选时用页面会话存储；提示没有时间 TTL、不保存密码，也不授予登录权限。冷启动通过仅证明当次持久化与恢复，不能替代原安装实例的六小时证据。

### 13.18 Tasks / ChatKit 的数据 Pod 根（2026-10-04）

Cloud 上的独立 WebID card 与数据 Pod 地址分开。Tasks / ChatKit 创建 drizzle 数据库前，必须使用内部已验证的显式 storage root 或 identity DB 的 Pod ownership/storage binding，并将该 root 显式传入 `podUrl`；不能从 WebID、issuer 或 profile 路径截取数据根，也不能把未连接数据库的猜测初值作为权威地址。保留 canonical RDF URL 与既有 OwnerPodAccess 私有 transport，公网入口不可用不改变该地址归属。

ChatKit 没有已验证的选定 root 时，只接受唯一的数据 storage root；重复同 root 绑定去重，无绑定或多个不同 root 明确拒绝。本补充不新增多 Pod 选择 UI，也不改变其他消费者既有选择语义。Cloud card-only provisioning 不登记数据 Pod ownership；Standalone 的显式绑定同样适用。Workspace 字符串不能未经绑定验证成为 storage authority。

已缓存的内部数据库仅复用其原已验证绑定；同一 context 改选不同显式 root 时拒绝复用，不静默切换。正确数据 Pod 的 403 保持错误，不能当作资源不存在，也不能回退写 Cloud card namespace。真实任务审批须另验 approved / rejected / Stop 及清理，局部 drizzle 回归不能代替发布验收。

Run、Task 与 RunStep 的关联 IRI 同样使用该已验证数据 root。写入位置与关联查询必须一致；不能将 Cloud WebID 截出的关联写入 Local 数据库，再按 Local IRI 查询。须覆盖 Cloud card 与 Local storage 不同 origin 的步骤写后读。

#### 修正：存储地址解析归 ORM/适配器，业务层只用不透明 ID（2026-10-04）

上面的“业务层传入 podUrl”实施在复审时被判定越界：TaskService / TaskHandler / TaskMaterializer / RunStateCenter / ManagedRunWorker 不应派生 Cloud/Local 存储 URL，也不应调用 `getPodBaseUrl` / `resolveBoundPodBaseUrl` 组装绝对 IRI。业务层只传不透明的 base-relative 资源 ID 与关系；地址解析由 `PodChatKitStore` 这一处拥有。

已实测的 ORM 契约（`@undefineds.co/drizzle-solid`，配 `{ podUrl }`）：写入时 base-relative 关系解析为 `${podUrl}/.data/...`；已是绝对 http(s) 的外键原样保留，不会静默重绑到本 Pod；查询侧 `eq(Run.thread, <base-relative>)` 同样按 `podUrl` 解析；`buildPodResourceIriForDatabase(db, resource, id)` 取 `db` 的显式 `podUrl`，与 WebID 无关。因此这属于业务层地址假设，不是 ORM 能力缺口，无需 issue/绕过/改 schema。

落地边界：(1) TaskService / TaskMaterializer / RunStateCenter / ManagedRunWorker / TaskHandler 只写 `task.id` / `thread.id` / `run.id` 等不透明 ID；(2) `PodChatKitStore` 读回时用 ORM 的 `parsePodResourceRef` 把本 Pod 关系还原为同样的不透明 ID，外部绝对 IRI 保持原样；(3) 步骤写入若显式给出绝对 `run`，仅当它等于本 Pod 当前 Run 才接受，否则拒绝，绝不重写外来链接。Workspace 等 plain-uri 协作关系保持完整 URI。测试须断言 Local 写后读、外来链接不被改写，以及 InMemoryStore 路径只流转不透明 ID。

### 13.19 使用中到期与无人值守续期（2026-10-04）

有效 Refresh Token 的活 SDK 会话应在持续使用跨 Access Token 到期，以及无人操作、刷新计时器暂停后的首次请求中自动续期，不依赖用户在场、Account Cookie、重新输入密码或新增授权。验收记录真实 JWT 到期时刻、refresh grant、私有读取及密码和授权次数，不能仅凭计时器触发宣称通过。

后台任务使用其已授权客户端凭据交换短期令牌，须分别验证同一个缓存请求对象跨到期后的可用性；该交换不称作浏览器 Refresh Token 刷新。凭据被撤销或身份不匹配时必须拒绝，不借用其他账号或部署持有的权限。并发续期复用同一交换；不能用无界重放非幂等写请求掩盖过期。

进行中长请求或流是否跨到期继续完成须单列证据。已经开始的响应与下一次请求的认证分开判断；短 TTL 私有读取不能代替流式请求、原安装资料或自然 14 天有效期验收。


### 2026-10-04：运行时本机入口与冻结续期补证

RC `a2e5f2b95b71da611b9eb3f890a55b43d68852ec` / run `37171159407` 实际失败：真实 Chat 为 200 且有内容，但 Task 在 approved:checkpoint 前出现 `provider_error`（Pi `openai-completions`，所选 `deepseek-v4-pro`）；Finalize skipped，不具备 stable promotion 凭证。原生与桌面 self-update / clean-consumer 门禁通过不能抵消该失败。

API 容器此前把规范公网 node 地址交给内部 Pi 客户端；无公网路由的 Local 中，请求没有进入本机 Gateway inference Handler。修复只在容器传输绑定边界复用已绑定 Gateway 入口，socket 模式保留已映射的规范 origin。身份、token audience/issuer 保持规范地址；业务服务不推导 Pod 根地址。因果回归先 1 fail/1 pass，修复后候选相关 60 项通过，新增补证组合 32 项通过；新增/修改文件推荐 TypeScript lint 0。两树 build:ts 与 test types 均实际 exit 0。

冻结最新 OwnerPodAccess/SolidSessionFactory 源码的真实短 TTL + 原生 ABI7 + 新 Electron 33.4.11 夹具完成：同一个持有的 fetch 在原 JWT exp+121580ms（超过默认 verifier 120s 容差）返回 200，正文精确一致；此时发生第 3 次 client_credentials exchange，全部 token exchange 无 Account Cookie。后续新 fetch 也 200 且内容一致。运行期间相关源码 hash 未变化。证据 `.test-data/sol-release/held-final/safe-result.json` 私有保存；旧 source-race smoke 仍只作历史，不改写为最终证明。

新增 TaskAuthBinding→OwnerPodAccess 链路回归确认 caller DB/fetch 缓存清理、ref/version 冻结、原 grant 续期、撤销后不派发 POST；并发 wire 回归确认迟到的旧 401 不清除新 session，原写入仅派发一次。这里是受控 transport 回归，真实 approved/rejected/Stop 仍由下一 immutable RC 验收。

原安装 `/Applications/Xpod.app` 0.4.20 及其用户资料未修改；该原安装完整重管理链路、长时间 in-flight stream、字面 6h/14d 等待未在本轮证明。标准完整集成正在运行，下一 RC 与 stable 状态另行补录，不宣称已经发布。


完整门禁后续补录：candidate runtime 30 与 lite 163 pass/16 既有 skip 实际通过后，full 首次 exit 1 是专属 Colima 未挂载本工作区、SQL bind 变成空目录。只修正 VM 内本轮静态夹具并逐项校验 SHA 后，标准 full 子门禁 actual exit 0，63 tests/8 files；自有 Compose containers/networks/volumes 均 0。接下来仍需两次完整 `bun run test:integration` 成功，不把分段结果记成已完成整条命令。

历史 broader 单元欠账因果核对：独立 detached `b5bce18112eef6e650a70c59cf51c716c975c676`（fe51 收敛之前）构建源码与 Components 后，在 Node 22.21.1 / Bun 1.4.2 执行失败的八个文件，actual exit 1 为 14 fail/58 pass；当前含本机传输修复的源码同条件也是 14 fail/58 pass，失败用例完全一致。私有 `.test-data/sol-release/baseline-differential.json` 保留逐项清单；只读基线 checkout 已清理。该证明支持“不是 fe51 及本轮传输修复新增”，不支持“全量单元全部通过”；既有 fixture/assertion 欠账仍明确保留。


Root 本轮完整 `bun run test:integration` actual exit 0，UTC 2026-10-04T03:36:50.195Z—03:44:37.709Z：runtime 30/5 files，lite 157/32 files 与 6 既有 skips/3 files，full 46/5 files；19 个实际选定端口（IPv4/IPv6）均无监听，自有 Compose containers/networks/volumes 均 0。原 3000 与其他工作区资源不动。候选两次完整成功门禁尚在执行。

本轮 lint 边界：候选四个改动代码/测试文件推荐 TypeScript 规则为 0；Root 同一切片唯一诊断是既有 `matrixStore` 解构参数 `config` 未使用（与本轮 Gateway helper 修改无关），新增测试全部 0。本轮不擅自改动该无关切片，也不把 Root 整体 lint 写成零诊断。


边界复核补录：签发器同时向外部客户端返回配置，因此规范 base URL 保留；只由 API 容器把已绑定 Gateway 传输入口注入 Pi 执行适配器，复制运行时输入并覆盖传输地址，不修改持久配置、token claim 或业务存储地址。真正 Pi SDK 对本机 HTTP/SSE 的回归先 RED（24 pass/2 fail），修复后 26 pass；沙箱输入覆盖与远端配置均独立校验。含身份、授权和管理 Handler 的组合为 122 pass/5 files。先前 root 完整通过及 candidate pass1（actual exit 0，UTC 03:45:18.934—03:57:50.943）属于该边界修订前记录；修订后须重新执行完整门禁，不继承为最终通过。


传输入口审查补录：Gateway 绑定收敛为 typed canonical/transport 对，只重绑本宿主签发的规范入口；独立 Pi 外部连接不改变 endpoint。Cloud socket 模式的子进程不继承父 shim，因此把现有注册表的已绑定 socket 随私有 worker payload 传递，在 worker 用同一 `registerSocketOriginShims` 生命周期注册/释放；Linux sandbox 只读挂载运行包与绑定 socket，不降低隔离。真实 SDK 揭示共享 socket 传输把 canonical HTTPS 当作 Unix listener TLS 的缺陷；统一 transport 现按本机 listener 的 plain HTTP 请求，canonical Host 保持。候选组合 33 pass/3 files，包含真实安装 SDK 的 TCP/socket/外部端点，以及实际 `sandbox-exec`（sandboxed=true）子进程 TCP/socket 两例；未用 mock runner 代替实际 OS 隔离证明。Linux bubblewrap 尚无本轮实际运行证据，不混记为 macOS 通过。此前 typed/socket 修订之前的 candidate 完整命令 exit 0（UTC 04:28:17.999—04:34:45.174，runtime30/lite163+16skip/full63）；后续源码仍须两次最终完整回归。


沙箱读面复核：不挂载 PACKAGE_ROOT 或 workspace package 整根；Linux worker 清单仅包含实际 src/dist 代码、node_modules、根 package.json、各 workspace 的 dist/package.json 与已绑定 socket。配置负例确认 .env/.git/local/data 与包根均不被扩大挂载。macOS 既有 Seatbelt allow-default 读面是既存限制，本轮实际 sandbox-exec 连通证明不称作秘密隔离证明。真实 TLS 用例证明未注册 HTTPS 与显式 TLS socketPath 仍使用原生 TLS；与 Gateway HTTPS→plain HTTP socket 的行为分开。含真实 OS worker、身份、授权、管理与 TLS 的候选组合 actual 128 pass/6 files。改动代码切片 lint 的 Pi 驱动 6 项与 socket-http 13 项均与 a2e5 原始源码的规则/消息逐项相同，其余改动切片 0；不把整体 lint 说成全绿。产品源码最后修订后完整回归须重新执行，旧并行测试记录不作为最终接受证据。


### 2026-10-04：冻结源码最终本地门禁

以上历史结果不追认为最终绿。最后产品/测试修订后，候选10文件hash持续不变，两次完整 `bun run test:integration` 均actual exit0：UTC 05:02:05.433—05:07:52.826和提交前10:12:30.596—10:18:10.414；每次runtime30/5files、lite163pass/16既有skip（33pass/4skip files）、full63/8files。Root最终完整命令actual exit0，UTC09:24:01.995—09:29:01.234：runtime30、lite157/6既有skip、full46。两树build:ts/test types均actual exit0；候选闭环128/6files、Root闭环40/5files、发布契约99/10files及稳定提升Node31均通过。私有 `.test-data/sol-release/final-local-gates.json` 保留原始退出记录；最终自有Compose containers/networks/volumes均0。Root只镜像本轮12路径的窄修改，不提交或覆盖其其他变更。

失败原样保留：额外Linux SDK/bubblewrap镜像拉取的资源估算错误造成宿主ENOSPC，Root那次完整exit1；停止大镜像路线，仅重建本轮自有sol VM/数据盘，不清共享Docker/用户数据。随后Root Matrix单次超时，独立真实认证复跑exit0（63/63events、10sync pages）后再取得上面的整条0。候选另一次完整exit1为临时postgres:16-alpine拉取TLS超时及三例对象存储RequestTimeTooSkewed；pmset确认执行期间宿主多次Sleep/DarkWake。最终只预拉四张必要小镜像，核对host/guest空间、时差与allocation，使用测试生命周期caffeinate，完整重跑通过，没有产品fallback或削弱断言。Linux实际SDK+bubblewrap额外证明仍not-tested；参数负例和macOS sandbox-exec不代替该证明，也不混称秘密隔离。

原安装0.4.20/用户资料、长时间in-flight stream、字面6h/14d等待仍未验证；新Electron夹具和默认120s容差后的同一held-fetch正文证明按上文范围成立。全量单元14项既有失败和两个文件19项既有lint诊断保留，不能写全量绿。新immutable RC/stable仍待外部证据：只在exact SHA artifact的19项全部通过后签名v0.4.23并提升同一digest；a2e5/37171159407失败和Finalize skipped仍无发布凭证。

### 2026-10-04：审批身份与数据库绑定的关系读回

RC `3be53aba6aa04df0a93520ab3a94af0e9bad768a` / run `37195150178` 实际 completed/failure。真实 Chat 为 200 且有内容；Task 的 Pi streaming 已进入本机 Gateway，165 events、finishReason=tool_calls，但随后因 `Approval session identity mismatch` 在 approved:checkpoint 前失败。桌面自更新、原生和 clean consumers 成功，Finalize skipped；该 SHA 没有最终接受凭证，不得 promotion。

真实 drizzle RDF 读回把链接 Thread 返回为绝对 IRI，而业务传递不透明相对 ID。adapter 原先直接比较字符串，误拒绝同一个 Thread；审批读回也没有遵循 Run/Task 的相对关系契约。另一个真实负例证明先前“parsePodResourceRef 会保留 foreign”的注释不成立：该 helper 解析资源布局，本身不验证当前 Pod 归属。这不是共享 ORM 能力缺口。

修复在唯一 `PodChatKitStore` adapter 内完成：Session/checkpoint 比较通过共享 `Thread.buildIriForDatabase` 和已验证数据库绑定解析；关系读回只在提取 ID 经共享 resource helper 能完全还原原 IRI 时转为相对 ID。另一 origin、同 origin 的另一 owner、缺少已验证 DB 绑定都保留绝对 IRI；不同 Thread fragment 仍为不同资源。owner、assignedTo、toolCallId、session、target、action 的 exact 检查保持，业务层没有增加存储 URL 分支。Root 仅同步其已有关系 helper/context；旧 Root 不具备 Candidate 审批 API，不做宽迁移。

回归先取得 Session/checkpoint 两个真实 ORM 正例 RED、审批读回正例 RED，以及 foreign 同路径误归一 RED；修复后 Candidate 68 项/6 files、Root 22 项/3 files actual exit 0。测试保留 owner fragment/无 fragment、其他账号和 Thread、foreign checkpoint、强 ETag、未知 RDF、terminal Session 不重开等保护。两树 build:ts 与 typecheck:test actual exit 0；新测试 lint 0，Pod store 推荐规则从既有 62 项降为 59 项，没有新增诊断。冻结 Candidate 第一轮完整 `bun run test:integration` actual exit 0，UTC 11:10:56.529—11:17:05.637：runtime 30、lite 163/16 既有 skip、full 63。追加修订前 11:00:02.376—11:04:37.309 的完整 exit 0 仅作历史，不替代当前源码门禁；Root 最终完整、Candidate 提交前复跑和新 immutable RC 另行补录。


冻结关系修复的最终门禁补录：Candidate提交前完整 `bun run test:integration` actual exit 0，UTC 11:25:00.393—11:30:45.372（runtime 30、lite 163/16 既有 skip、full 63），与上述修后第一轮均属于当前源码。Root 完整门禁 actual exit 0，UTC 11:19:12.321—11:24:10.273（runtime 30、lite 157/6 既有 skip、full 46）。两树源码/测试 hash 不变；扩大 ChatKit/Run/Task Handler 相关回归 100 项/12 files 全通过。私有 `.test-data/sol-release/approval-final-local-gates.json` 保留原始 exit/signal 和日期证据；自有 Compose containers/networks/volumes 均 0，仅停止本轮 sol VM，其他运行资源不动。新 RC 尚待接受凭证，不宣称 stable 已发布。
