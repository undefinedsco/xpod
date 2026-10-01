# shared-ui 登录前门（Pod Sign-in）设计

日期：2026-09-29（2026-10-01 更新）。状态：**第一期实现与本地验收已通过，外部发布仍待精确 SHA 验收**。A/C 组新组件、B 组换皮与 D 组公共呈现已接入；Root 接手后完成 20 道本地门禁和提交前第二轮完整集成，证据与边界见 §12.4。用户 `localhost:40991` 未由本任务更新，phase2 新增能力仍按 §11.3 执行。

**总体设计范围**（本稿确实定义，A/B/C/D 四组都在稿内）：

- **A 组**（应用侧前门）、**C 组**（一行错误提示）：`@undefineds.co/shared-ui` 中面向"未登录 / 需要 Pod"的呈现组件，以及经 `@undefineds.co/extension-sdk` 的 `SolidAuthBoundary` 暴露给生态应用的同一界面。
- **B 组**（账号服务侧的登录、注册、找回、授权页）：属于本稿范围，定义其呈现与文案（§6 B 组、§8.3）。
- **D 组**（账号服务自己的账号页：WebID / 设备 / 网络 / 密钥分区）：同样属于本稿范围，定义其呈现（§6 D 组、§8.4）。

**分期范围**（见 §11）：第一期交付 A/C 组新组件与接线、B 组换皮，并把 D 组的**公共呈现**接进已有账号页；第二期再做新增设备 / 网络 / 跨设备能力，以及 B2（注册即建 WebID 和 Pod）的服务端编排。分期区分的是"本期是否接入呈现与新增能力"，**不是**"账号页是否属于本设计"——账号页的呈现属于本稿。

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
5. **一眼可认**：纸色画布、墨紫主操作、系统字体、44px 主按钮。在应用的品牌下出现，但能看出是 Xpod/Pod 登录。

## 3. 用语（唯一口径）

| 用户可见 | 含义 | 不再使用 |
|---|---|---|
| **WebID** | 登录用的身份。应用侧只说"WebID 登录"，不说"用 Pod 登录" | 用你的 Pod 登录、登录 Xpod 账号 |
| **账号服务** | 签发身份的服务（OIDC issuer），界面同时显示主机名 | 账号供应商、identity route、provider、issuer |
| **Pod** | 保存数据的个人空间；首次出现时附一句"保存你数据的个人空间" | 空间、存储空间、storage、storage binding、本机空间/独立空间作为名词 |
| **Xpod**（账号服务） | 签发 WebID 的服务，只有一个：`pod.undefineds.co`。登录、注册、授权都在这里完成 | Xpod 云、云端账号 |
| **Xpod 云端 / Xpod 边缘**（存储位置） | 这两个只描述 **Pod 存在哪里**，不是两种账号服务：云端由 Xpod 托管；边缘运行在你自己的设备上（这台电脑、NAS 等），用图标和状态点表示是否运行中 | 这台电脑上的 Xpod（作为账号服务）、本机空间、独立空间、Local、Standalone |
| **继续为 {名字}** / **使用其他账号** | 记住的身份与切换 | 继续使用 X、切换账号、换一个空间 |
| **轻量快速创建页（轻页）** | 授权页缺 Pod 时进入的同 UID 专用快速建 Pod 页（`/.account/interaction/{UID}/create-pod/`）；只提交本次创建所需字段 | 在授权页里内嵌建 Pod 表单 |
| **重管理页（重页）** | 完整的 Pod 管理页（`/settings/pod`）；从轻页"使用自己的部署"或日常"管理 Pod"进入 | 把完整 Pod 管理塞进登录弹窗 |
| **日常管理入口** | Account 里的"管理 Pod"→ 重页 → 回到 Account | 用遗留授权任务冒充日常入口 |

英文包使用对应的 *sign-in service / Pod / Xpod on this computer / Xpod Cloud / Continue as {name} / Use another account*。

规则：
- "WebID"作为概念名出现，首次附"什么是 WebID？"折叠说明；WebID 的 URL 原文只放在"详情"里。
- "Xpod"只作为服务或产品名出现（账号服务 Xpod、存储位置 Xpod 云端 / 边缘、Xpod 控制台），不要求用户理解它和 Pod 的关系。
- URL 默认只显示主机名，完整地址放在折叠的详情里。
- 文案按 locale 打包，随组件发布；宿主可以覆盖，不必每家重写一遍。
- **locale 唯一**：默认 zh-CN；需要英文的宿主显式选择 `en`。同一流程内登录、注册、授权，以及现有账号页的空态、操作、验证提示必须使用同一 locale，不得在流程中途切换语言。
- **注册 / 登录相邻链接成对**：登录页写"还没有账号？注册账号"；注册页写"已有账号？登录"。两侧措辞成对出现，不混用"注册 / Sign up / 创建账号"。
- **边缘设备 ≠ 自带账号服务的独立部署**：界面中的"Xpod 边缘 / 这台电脑"只表示 Pod 存在哪里，仍然用 Xpod 账号登录；只有极少数 Standalone 部署自带账号服务（§6 A 组）。文案不得暗示普通浏览器能把当前账号服务变成本机服务。
- **轻页 / 重页 / 日常三入口共用一条安全任务口径（2026-10-01 确认）**：授权页缺 Pod 只读引导，主操作把**一次性创建任务**交给同 UID 轻页；轻页的"使用自己的部署"带**同一个**任务跳重页；重页做完回到原授权。三者的任务安全绑定真实 Account id（**不是**服务地址 / WebID / username）、精确 UID、同源原 ConsentURL、TTL、单次消耗（`ui/src/utils/safe-continuation.ts`）；切号 / 超时 / 服务端授权 410 一律拒绝误创建与旧导航。
- **日常入口不被遗留任务覆盖**：Account 的"管理 Pod"走重页再回到 Account，**不**消费也不被 Account 同账号遗留的旧 Consent 任务覆盖；只有从授权进入时才携带任务并显示回到授权横条。

## 4. 容器与版式

| 呈现 | 尺寸 | 用于 |
|---|---|---|
| `window` | 宿主窗口 **360×540**，最小 320×480，内容铺满、无卡片 | 桌面独立认证小窗 |
| `dialog` | 宽 400px（窄屏为 100vw−32px），高随内容，最大 90dvh | 应用内弹层（LinX、第三方） |
| `page` | 整页左右两栏：左栏是介绍（图标、名称、一句主张、几条要点，下沉底色；A 组由应用提供，B 组为账号服务介绍）；右栏居中放同一个 360 宽的 body。窄屏收成单列 | 浏览器直接访问、重定向落地页 |

- 放弃 280×400。按 14px 正文、44px 主按钮、应用头部加说明计算，280 宽度装不下中文两行说明和主机名；1.4 里的溢出就是这么来的。
- **呈现由宿主传入，不由页面默认**。`PodSignInFrame` 接收 `presentation: 'window' | 'dialog' | 'page'`（§8.1）。**不得把所有账号页默认成 compact 小卡**——`XpodAccountPageSurface` 与 `XpodBlockingAccountCredentialsSurface` 已改为经 `WebAccountLayout` 按宿主选择 `page` / `window`，不再默认或固定 `compact`；`compact` 小卡只保留给应用侧 WebID 门（`XpodAuthSurface`，`ui/src/auth/XpodAuthSurface.tsx`）。
  - **桌面独立认证小窗**：`window`，铺满 360×540（最小 320×480），无卡片外框。
  - **浏览器直接访问的登录 / 注册 / 找回 / 授权页**：`page`。宽屏左右两栏——左栏是**账号服务介绍**（图标、名称、一句主张、几条要点，下沉底色），右栏居中放 360 宽 body；窄屏收成**单列**，介绍置顶或收起。真正的认证小窗才用 `window` 铺满 360×540。
  - **应用内弹层**：`dialog`。
- **层次用公共语义 token 表达，不能"把整站 primary 换掉"就算完成**：账号服务顶栏用底色条（`IdpChrome`："服务图标 + Xpod · 账号服务 + 主机名"）与应用侧轻量标识区分；表单底色、必要边界、选中 tint 各用公共角色（raised / control / tint，见 §5 与 R2 §8.1），不新造登录专用色板。
- 三种呈现共用同一个 body，只有外框不同。body 永远是一个单列：**来源标识 → 标题 → 主体 → 操作区**。
- **每屏只有一个标题**（h1，**17/600**，见 §5）。B 组（登录 / 注册 / 找回 / 授权）与 A/C 组标题都是 17/600，**不承诺 20/600**；D 组账号页若将来出现页面级大标题，需在 §6 D 组单独声明，不能写进这里的通用承诺。顶部的来源标识不是标题，只是一行 24px 图标加 13px 名称：
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
- 字号：标题 17/600，正文 14/400（行高 22），说明 13，最小 12。不再使用 11px 和 10px。
- 控件：主按钮 44px 高、8px 圆角、满宽；次按钮 44px 描边；文字按钮 36px。外框 12px 圆角，列表行 8px。全局只用这三档圆角。
- 状态色只用 token：`--destructive`、`--warning`、`--success`。不使用 sky/emerald 等原色，"本机"标记用中性图标加文字。
- 焦点：见下方"焦点"小节。
- 动效：120–180ms 淡入；`prefers-reduced-motion` 时去掉。加载转圈旁边必须有阶段文字。

### 5.1 焦点（共享 Input 统一处理）

- **视觉归原语所有**：`packages/shared-ui/src/input.tsx` 等原语负责控件焦点外观；账号表单组件只复用原语，页面只负责布局，不在页面层再叠一层边框。
- **只呈现一套清楚边界**：聚焦时只能有一条可见边界，聚焦边框与 token 统一（`--ring` = action）。**禁止**浏览器默认 / `@tailwindcss/forms` 的蓝色 `ring` / `box-shadow` 与自定义紫色 `outline` / `ring` 叠加成双层框。`focus.ts` 已声明 single focus 意图（`controlFocusClass` / `interactiveFocusClass` / `buttonFocusClass`），实现须与之一致。
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

参照微信的登录逻辑：**大多数人只会看到"记住的身份"，点一下就进去**。应用侧没有独立的"选择服务"首屏，也没有"验证中"过渡屏。

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

来源标识改为顶部 44px 底色条："服务图标 + Xpod · 账号服务 + 主机名"，和应用侧的轻量标识在视觉上明确区分。邮箱和密码表单**只出现在这里**，任何应用都不会渲染它。

登录或注册完成后，账号服务读取权威 Pod 清单：
- 至少有一个 Pod：进入 B4 授权。多个时在 B4 里选择。
- 确认没有 Pod：进入 B3。
- 清单读取失败：原地重试。不能当作"没有 Pod"。

**B1 登录 `idp-sign-in`**
- 标题"登录 Xpod"（写明登录的是哪个服务），副行"完成后回到 {应用}"。
- 字段：邮箱、密码。"忘记密码？"放在密码标签右侧；"在这台设备上保持登录"默认不勾选。
- 主操作"登录"。底部左侧"还没有账号？注册账号"，在同一张小卡里打开 B2；右侧"使用其他 Solid 账号"，回到 A3 并展开地址输入框。

**B2 注册 `idp-register`**
- 用户没有另选存储位置时，注册在同一个服务上**同时建好 Account、WebID 和 Pod**。
- 字段：用户名、邮箱、密码。
- 用户名下方实时预览"将创建你的 WebID 和 Pod：pod.undefineds.co/xiaolin/"。表单明示、由用户提交，不算隐式创建。
- "想把 Pod 放在自己的电脑上？"默认收起，说明注册后可以在账号页的"存储"里建到别处。
- 主操作："注册"。次操作："已有账号？登录"。

**B3 账号还没有 WebID `idp-no-webid`（轻量引导，2026-10-01 确认）**
- 老账号，或者注册时没能建成 Pod 时进入；绑定清单读取失败**不算**"没有 Pod"，走失败重试（§12）。
- 标题"还没有 WebID"，一句说明"新建一个 WebID 来登录 {应用}，数据存在它的 Pod 里"。
- **Consent（B4）里不再放名字表单，也不直接 POST。**缺 Pod 时授权页只读说明缺席原因，主操作把当前会话的**一次性创建任务**交给**轻量快速创建页**（同 UID 的 `/.account/interaction/{UID}/create-pod/`；入口见 `ui/src/pages/ConsentPage.tsx` 的 `handleGoToCreatePod`，页面见 `ui/src/pages/FirstPodPage.tsx`）。
- **轻页**只提交本次创建所需字段（名称 + 显式 submit），创建仍由全仓唯一的受守卫 prepare + POST 事务负责；提交后回到**原来的** Consent 继续授权。
- **轻页的"使用自己的部署"是明确口子**：跳**重管理页** `/settings/pod`，携带**同一个**一次性任务；在重页处理完（或在别处建好 Pod）后回到原授权。
- **日常入口**是 Account 的"管理 Pod"→ 重页 → 回到 Account（由 `AccountAuthBoundary` 准入，§12）。它与从授权进入共用同一个重页，但**遗留旧 Consent 不能覆盖**日常管理入口。
- 登录弹窗里**不做**机器选择、启动服务、域名分配或外网检测。

**B4 授权 `consent`**

授权页上有三个角色，各占固定位置，不能混排：

| 角色 | 位置 | 样式 |
|---|---|---|
| **账号服务**（验证身份的一方，页面归它所有） | 顶部 44px 底色条 | 服务图标 + "Xpod · 账号服务" + 右侧主机名。B 组所有页面共用这条，表示"你现在在账号服务的页面上" |
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

参照微信：普通用户**看不到错误屏、错误码和技术详情**。出错时留在 A1，只做两件事：
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

### D 组：账号服务的账号页

账号页是账号服务自己的**一个整页**（B 组底色顶栏加 880px 内容列）。页面分三块，对应三层概念：**身份与 Pod（WebID）/ 存放位置（设备）/ 网络（跟着设备走）**，外加密钥：

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

**从授权进入时（B3"建在其他位置"或授权页的"管理账号"）**
- 页面最上方出现一条回到授权的横条：LinX 图标、"LinX 正在等你完成授权"、一行状态说明、"取消授权"、主按钮"继续授权 LinX"。
- 还没有可用的 Pod 时，按钮禁用，说明写"先创建一个 Pod，完成后回到授权"。Pod 就绪后按钮变为可点，说明改为"Pod 已就绪，可以回去授权了"。
- 点击后回到原来的授权页（B4），并重新读取 WebID 与 Pod，不沿用过期的状态。
- 不是从授权进入时，没有这条横条。

**管理导航语义（直接访问 vs 从授权进入）**
- **直接访问账号页**：可以进入受 Account 权威保护的账号管理页（如 `/settings/pod`，由 `AccountAuthBoundary` 准入，§12 证据表），**不必重走应用前门**。直接访问只是没有当前 OIDC interaction 需要续接，不等于绕过账号权威或目的页权威检查。
- **从授权进入**：`ConsentResumeBanner` 必须携带**一次性续接上下文**，内容至少为：当前 Account 身份 + 原 OIDC interaction + 经校验的目的地址 + 有效期。落地形式可放受保护的服务端 / session，不要求明文进 URL。
- 管理页展示回到授权横条；结束时**重新读取 WebID / Pod**，再回到原授权；**过期 / 取消 / 中途切换账号后不得复用旧授权**。
- **不得把裸 `returnTo` URL 当安全续接**：`ui/src/utils/returnTo.ts` 只是 sessionStorage 里的裸 URL，没有 Account、interaction、TTL，**不再**作为续接依据。当前实现改用 `ui/src/utils/safe-continuation.ts`：从授权进入时 `ConsentPage.handleGoToPodManagement` 写入一次性续接上下文（真实 Account id + interaction + 经校验的同源原 ConsentURL + TTL），再前往重页 `/settings/pod`；日常入口不携带任务（§12.1）。
- **不绕过目的页权威检查，也不把 Account 与 WebID 会话等同**：账号页准入看 Account，Pod 数据访问才看 WebID（见 `settings-routes.tsx` 注释）。

## 7. 典型路径

1. **老用户（最常见）**：A1 点"进入 LinX"，直接进入。能静默恢复时连 A1 都看不到。
2. **切换账号**：A1 点"使用其他账号" → B1 输入账号密码 → B4（仅这个应用第一次，或账号有多个 WebID 时需要选择）→ 进入。
3. **新用户**：B1 点"注册" → B2（小卡，同时得到 WebID 和 Pod）→ B4 → 进入。
4. **其他 Solid 账号**：B1 点"使用其他 Solid 账号" → A3 输入地址 → 该服务的登录页。
5. **老账号没有 Pod**：B1 → B3 → 轻量快速创建页（同 UID 的 `/.account/interaction/{UID}/create-pod/`，显式 submit）→ 回到原 B4。要放在别处时，轻页点"使用自己的部署"进入重管理页（`/settings/pod`，带同一一次性任务），处理完回到原授权；日常则从 Account 的"管理 Pod"走同一重页再回到 Account。
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

// 外框：window = 铺满宿主窗口；dialog = 宽 400 的弹层；page = 左右两栏
interface PodSignInFrameProps {
  presentation: SignInPresentation
  ariaLabel: string
  appIntro?: ReactNode          // 仅 page：左栏介绍，由宿主（应用或账号服务适配器）提供；A 组为应用介绍，B 组为账号服务介绍。真实 API 保留 appIntro，不设 pageIntro 别名
  children: ReactNode           // 360 宽的 body
}

// 头像右下角标：数据存在云端还是边缘
type StorageLocationKind = 'cloud' | 'edge'
interface StorageBadgeProps { kind: StorageLocationKind; label: string }   // label 给读屏和悬停用

// B 组顶部 44px 底色条
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
  usernamePreview?: string             // “将创建你的 WebID，Pod 存在 Xpod 云端：…”
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

- B1–B4 都用 `IdpChrome` 加 360 宽 body，由 `PodSignInFrame` 的 `window` 或 `page` 外框承载。
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

## 9. 与现有规定的偏差（已由产品负责人在 2026-09-29 设计评审中确认方向）

| 本稿 | 现有规定 | 理由 |
|---|---|---|
| 桌面小窗 360×540 | 280×400 compact 基线 | 280 宽度下 14px 正文和 44px 按钮放不下，浏览器实测已溢出 |
| 没有另选存储位置时，注册同时创建 Account、WebID 和 Pod（B2）；老账号缺 Pod 时授权页**不放表单**，主操作把一次性任务交给同 UID 轻页，由轻页显式 submit 创建（B3） | 9/19：注册只建 Account；9/6：授权页不嵌创建表单 | 表单明示将创建什么、由用户提交；授权页只交任务、不建 Pod；边缘设备、网络这类基础设施操作只在账号页（D 组） |
| Xpod 控制台用 WebID 登录，不以 Account 表单作为入口 | 现有 dashboard 首屏是 Account 邮箱密码表单 | AI 连接和 API Key 都是 WebID 级；Account 只处理账号本身的事务 |
| 云端 / 边缘只表示存储位置，账号服务只有 Xpod | 旧前门把"本机空间"当登录选项 | 边缘设备上的 Pod 也用 Xpod 账号登录 |
| 出错只留一行提示，技术细节只在开发者模式可见 | 现有失败页显示通用错误与重试 | 与微信式的轻量登录一致；排障信息仍在开发者模式和日志里 |
| 外网连通不阻塞创建与加入设备 | 现有本机引导把连通检测放在登录前 | 本机可用就能工作；远程访问提供修复入口即可 |

canonical（9/19）与 R2 的对应条款，在本稿实现并验收后另行回写；实现期间以本稿为准。2026-10-01 确认的"轻页 / 重页 / 日常"三入口与"授权页只交任务不建 Pod"以本节新条款优先；R2 的颜色角色（浅 primary `#563E84`、深 primary `#B7ABC3`、深 canvas `#211D19`）仍然有效（§5）。

## 10. 验收

1. **A 组状态**：`SolidAuthBoundary` 示例应用和 Xpod WebID 门，逐状态截图一致：A0–A3，以及 C1–C4 的一行提示。
2. **尺寸与主题**：`window` 360×540、`dialog`、`page`（1280 宽两栏，390 宽单栏），200% 文字、深浅主题下，主操作和返回都可见，没有水平滚动。
3. **键盘与读屏**：只用键盘能走完路径 1–4。状态变化用 polite 播报，失败用 assertive。
4. **一行提示**：普通模式下，C 组只有一行提示，没有错误码；开启开发者模式后，可以点开查看详情。
5. **不静默改道**：本机 Xpod 边缘不可用时，不会有任何请求发往其他 issuer（回归测试）。
6. **测试**：所有新组件都有单元测试，覆盖每个状态的渲染、按钮回调、ARIA 角色（radiogroup / dialog / status / alert）。
7. **呈现选择**：直接访问账号页（登录 / 注册 / 找回 / 授权）宽屏为两栏 `page`（左栏有账号服务介绍）、窄屏为单列；真正的认证小窗 `window` 铺满 360×540。三种呈现分别截图，均无水平滚动。
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
3. **D 组呈现件**：按 §8.4 实现 `WebIdSection`、`DeviceSection`、`NetworkPanel`、`DevicePickerDialog`、`AddDeviceDialog`、`CredentialSection`、`ConsentResumeBanner`，只用 props 驱动，并配测试。**已有账号页（WebID / Pod / 凭据 / 密码）本期就换用这套公共呈现**，不改协议与请求；只有**新增的跨设备能力**（设备列表 `/v1/nodes`、远程拉起、添加设备 / 网络面板接线、B2 服务端编排）延到第二期。`/v1/nodes` 返回 501 只阻塞新增跨设备能力，**不阻塞已有页面改版**；本期也不需要实现远程启动或任何尚不存在的接口。
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
   | `authenticated` | `selecting` | 保留现有的 `StorageSelectionView`，但换成新 token 与 360 body 样式 |

   更新 `packages/extension-sdk/test` 中的相关断言。
5. **Xpod WebID 门**：`ui/src/solid/WebIdAuthBoundary.tsx` 改用 `PodSignIn`，映射同上。
   - 记住身份时，`bindingLabel` 换成角标。
   - `connecting` 不再渲染 `LoginConnectingView`，改为主按钮 `busy`。
   - 失败走 notice，`SolidSessionPendingError` 的提示为"上次登录尚未结束"，主按钮"刷新页面"。
   - 更新 `WebIdAuthBoundary.test.tsx`。
6. **Xpod 账号服务页换皮**：只换呈现，不改协议、状态和请求。
   - **呈现选择**：浏览器直接访问的登录 / 注册 / 找回 / 授权用 `page`（宽屏两栏、左栏为账号服务介绍；窄屏单列），**不是默认 `compact`**；真正的认证小窗才用 `window` 铺满 360×540。当前实现：`XpodAccountPageSurface` 与 `XpodBlockingAccountCredentialsSurface` 已统一经 `WebAccountLayout` 按 host 推导 `page` / `window`（`ui/src/auth/XpodAuthSurface.tsx`），不再有 `compact` 默认值，也不再固定 `compact`；**不新增 presentation props**。
   - 登录（`XpodBlockingAccountCredentialsSurface` 的 login 模式）→ `IdpSignInView`；
   - 注册 → `IdpRegisterView`（`requireUsername` 按现有 controls 决定）；
   - `ConsentPage` 的正常授权 → `ConsentView`；
   - `ConsentPage` 缺 Pod 的分支 → `IdpNoWebIdView`（只读引导，不放创建表单）；主操作 `handleGoToCreatePod` 把一次性任务交给同 UID 的轻量快速创建页（`ui/src/pages/FirstPodPage.tsx`），不再在 Consent 内直接创建；
   - **管理导航**：`Manage Pods` / `handleGoToPodManagement` 按 §6 D 组的"直接访问 vs 从授权进入"语义改写——从授权进入时写入一次性续接上下文（Account + interaction + 经校验目的地址 + 有效期），管理页展示回到授权横条；不再只 `persistReturnTo(window.location.href)`。
   - **文案**：账号页现有英文（`Account Dashboard` / `Storage` / `Identity` 等）改为 zh-CN 默认、en 显式选择，与登录 / 注册 / 授权同 locale；去掉 `WebAccountLayout` 里过期的"Personal Messages Platform"标语，标准版式左栏的旧英文产品介绍（"Simplify Life with…"）换成账号服务介绍。
   - 保留原有测试中的 id 和可访问名称（如 `oidc-consent-webid`），必要时调整断言。

不在第一期：
- 注册时一并创建 WebID 和 Pod 的服务端编排（B2）；
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

- 注册时一并创建 WebID 和 Pod（B2 编排）；
- 账号页**新增分区与新增能力**接入 `AccountPage.tsx`（基础版式与已有 WebID / Pod / 凭据 / 密码已在一期换成公共呈现）：
  - 设备分区先接本机（`/provision/status`、`/api/network/settings/*`）；
  - 跨设备依赖 `/v1/nodes` 恢复；
- 本机拉起接桌面宿主能力（`startLocal`）；
- LinX 改用 `PodSignIn`；
- 开发者模式开关放进 Xpod 设置。

## 12. 证据与文档状态（2026-10-01）

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
- 跨设备 `nodes`（`/v1/nodes` 501）/ 设备 API / 远程拉起 / 网络接线 / B2 后端编排仍是 §11.3 第二期；**不得**用 `nodes` 501 推迟已接入的 Account 公共呈现 phase1，**不得**用 HTML 原型里的 fake 设备 / 假定时器 / 假状态冒充真实能力（§8.4）。

状态：本文档截至 2026-10-01 **本地实现与本轮 20 道验收门禁已通过**；提交前第二轮完整集成也已通过，精确 SHA 外部发布按 §12.4 执行。任务完成须包含 RC、stable、npm 和同 digest 生产证据。本文不代表用户 `localhost:40991` 已更新或已验收。
