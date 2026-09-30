# shared-ui 登录前门（Pod Sign-in）设计

日期：2026-09-29。状态：设计提案，未实现。范围：`@undefineds.co/shared-ui` 中所有面向"未登录 / 需要 Pod"的呈现组件，以及经由 `@undefineds.co/extension-sdk` 的 `SolidAuthBoundary` 暴露给生态应用的同一界面。Xpod 自己的 CSS Account 文档页（注册、找回密码、Pod 管理）不在本稿范围，只定义前门如何把用户交给它们。

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
- 配色：`theme.css` 用中性灰加 #7B68C8 系紫，没有用品牌的纸色和墨紫；本机、独立标记用 `sky-500`、`emerald-500`，也不在调色板里。
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

英文包使用对应的 *sign-in service / Pod / Xpod on this computer / Xpod Cloud / Continue as {name} / Use another account*。

规则：
- "WebID"作为概念名出现，首次附"什么是 WebID？"折叠说明；WebID 的 URL 原文只放在"详情"里。
- "Xpod"只作为服务或产品名出现（账号服务 Xpod、存储位置 Xpod 云端 / 边缘、Xpod 控制台），不要求用户理解它和 Pod 的关系。
- URL 默认只显示主机名，完整地址放在折叠的详情里。
- 文案按 locale 打包，随组件发布；宿主可以覆盖，不必每家重写一遍。

## 4. 容器与版式

| 呈现 | 尺寸 | 用于 |
|---|---|---|
| `window` | 宿主窗口 **360×540**，最小 320×480，内容铺满、无卡片 | 桌面独立认证小窗 |
| `dialog` | 宽 400px（窄屏为 100vw−32px），高随内容，最大 90dvh | 应用内弹层（LinX、第三方） |
| `page` | 宽屏（≥768）整页左右两栏：左栏是介绍（下沉底色），右栏居中放同一个 360 宽的 body；窄屏退回单栏 | 浏览器直接访问、重定向落地页 |

- `page` 左栏内容：由应用发起（OIDC）时介绍这个应用（图标、名称、host）；直接访问账号服务时介绍 Xpod 账号（一句话加三条要点：一个 WebID 登录所有 Solid 应用；数据存在你选的 Pod 里；可以放在云端，也可以放在自己的设备上）。浏览器里直接打开账号服务，不得只显示一张小卡。
- 放弃 280×400。按 14px 正文、44px 主按钮、应用头部加说明计算，280 宽度装不下中文两行说明和主机名；1.4 里的溢出就是这么来的。
- 三种呈现共用同一个 body，只有外框不同。body 永远是一个单列：**来源标识 → 标题 → 主体 → 操作区**。
- **每屏只有一个标题**（h1，20/600）。顶部的来源标识不是标题，只是一行 24px 图标加 13px 名称：
  - 应用侧（A、C 组）标识写应用名称，由宿主传入，组件里不写死任何应用。
  - 账号服务侧（B 组）标识写 "Xpod" 和服务主机名。用户在弹窗里能认出这是哪个服务的页面，这一行同时起防钓鱼的作用。
- **次要信息默认收起**。每屏正文不超过两行，Pod 的解释、位置差异、完整地址、错误码、检测明细都放进 `<details>` 折叠区（"什么是 Pod？""详情""原因和处理"）。
- "由 Xpod 提供"不再占用固定页脚。账号服务侧的标识已经说明了来源，应用侧放在"什么是 Pod？"的展开内容里。
- 操作区贴底，内容超长时只允许主体区滚动；主操作、错误和返回永远可见。

## 5. 视觉规格

以主站 DESIGN 为准，映射进 shared-ui 的 `theme.css` 语义 token（只改变量值，组件类名不变）：

| token | 浅色 | 深色 | 用途 |
|---|---|---|---|
| `--background` | `#F7F4ED` 纸 | `#1C1A17` | 画布 |
| `--card` | `#FBFAF7` | `#24211D` | 弹层、输入框、列表行 |
| `--foreground` | `#2B2621` | `#F2EEE6` | 正文 |
| `--muted-foreground` | `#655D53` | `#B3AA9E` | 次要文字 |
| `--border` | `#DFDBD5` | `#3A3630` | 分隔 |
| `--input` | `#87837D` | `#6E685F` | 控件边框（满足 3:1） |
| `--primary` | `#563E84` 墨紫 | `#9C86CC` | 主按钮、链接、选中 |
| `--accent` | `#E9E4E4` | `#2E2A33` | 选中行淡底 |

- 字体：系统无衬线栈（PingFang SC / SF Pro Text / Segoe UI / Noto Sans SC …），不加载网络字体；主机名用等宽 12px。
- 字号：标题 17/600，正文 14/400（行高 22），说明 13，最小 12。不再使用 11px 和 10px。
- 控件：主按钮 44px 高、8px 圆角、满宽；次按钮 44px 描边；文字按钮 36px。外框 12px 圆角，列表行 8px。全局只用这三档圆角。
- 状态色只用 token：`--destructive`、`--warning`、`--success`。不使用 sky/emerald 等原色，"本机"标记用中性图标加文字。
- 焦点：`2px solid var(--primary)` 外轮廓、3px offset；打开时焦点落在对话框本身，按一次 Tab 到主操作。
- 动效：120–180ms 淡入；`prefers-reduced-motion` 时去掉。加载转圈旁边必须有阶段文字。

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

来源标识改为顶部 44px 底色条："服务图标 + Xpod · 账号服务 + 主机名"，和应用侧的轻量标识在视觉上明确区分。底色条要一眼能和正文分开：带一条底部分隔线，底色在深浅主题下都与正文有可辨的色差。

输入框聚焦只有一层聚焦样式，不叠加浏览器自带的 outline。邮箱和密码表单**只出现在这里**，任何应用都不会渲染它。

登录或注册完成后，账号服务读取权威 Pod 清单：
- 至少有一个 Pod：进入 B4 授权。多个时在 B4 里选择。
- 确认没有 Pod：进入 B3。
- 清单读取失败：原地重试。不能当作"没有 Pod"。

**B1 登录 `idp-sign-in`**
- 标题"登录 Xpod"（写明登录的是哪个服务），副行"完成后回到 {应用}"。
- 字段：邮箱、密码。"忘记密码？"放在密码标签右侧；"在这台设备上保持登录"默认不勾选。
- 主操作"登录"。底部左侧"没有账号？注册"（与 B2 的"已有账号？登录"对称），在同一张小卡里打开 B2；右侧"使用其他 Solid 账号"，回到 A3 并展开地址输入框。

**B2 注册 `idp-register`**
- 用户没有另选存储位置时，注册在同一个服务上**同时建好 Account、WebID 和 Pod**。
- 字段：用户名、邮箱、密码。
- 用户名下方实时预览"将创建你的 WebID 和 Pod：pod.undefineds.co/xiaolin/"。表单明示、由用户提交，不算隐式创建。
- "想把 Pod 放在自己的电脑上？"默认收起，说明注册后可以在账号页的"WebID"里建到自己的设备上。**只在账号服务支持边缘设备时出现**（由运行时能力推导，不按部署名分支）；Standalone 本身就在用户自己的电脑上，不出现。
- 主操作："注册"。次操作："已有账号？登录"。

**B3 账号还没有 WebID `idp-no-webid`**
- 老账号，或者注册时没能建成 Pod 时进入。
- 标题"还没有 WebID"，一句说明"新建一个 WebID 来登录 {应用}，数据存在它的 Pod 里"。名称已预填，可用性实时检查，位置固定为当前服务。
- 主操作："创建并继续"，完成后直接进入 B4。
- 次操作："存到边缘设备（打开账号页）"，账号页顶部会出现回到授权的横条。
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

## 7. 典型路径

1. **老用户（最常见）**：A1 点"进入 LinX"，直接进入。能静默恢复时连 A1 都看不到。
2. **切换账号**：A1 点"使用其他账号" → B1 输入账号密码 → B4（仅这个应用第一次，或账号有多个 WebID 时需要选择）→ 进入。
3. **新用户**：B1 点"注册" → B2（小卡，同时得到 WebID 和 Pod）→ B4 → 进入。
4. **其他 Solid 账号**：B1 点"使用其他 Solid 账号" → A3 输入地址 → 该服务的登录页。
5. **老账号没有 Pod**：B1 → B3"创建并继续"→ B4。要放在别处时，点"建在其他位置"进入账号页 D，建好后点"继续授权 LinX"。
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
  appIntro?: ReactNode          // 仅 page：左栏，由应用提供
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
  appName: string; defaultName: string; nameHint?: { tone: 'ok' | 'error'; text: string }
  pending?: boolean
  onCreate(name: string): void; onChooseOtherLocation(): void
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

### 8.4 D 组：账号页分区（首期只做呈现与夹具，见 §11）

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
| 没有另选存储位置时，注册同时创建 Account、WebID 和 Pod（B2）；老账号没有 WebID 时，可在弹窗内一步创建（B3） | 9/19：注册只建 Account；9/6：授权页不嵌创建表单 | 表单明示将创建什么、由用户提交；边缘设备、网络这类基础设施操作只在账号页（D 组） |
| Xpod 控制台用 WebID 登录，不以 Account 表单作为入口 | 现有 dashboard 首屏是 Account 邮箱密码表单 | AI 连接和 API Key 都是 WebID 级；Account 只处理账号本身的事务 |
| 云端 / 边缘只表示存储位置，账号服务只有 Xpod | 旧前门把"本机空间"当登录选项 | 边缘设备上的 Pod 也用 Xpod 账号登录 |
| 出错只留一行提示，技术细节只在开发者模式可见 | 现有失败页显示通用错误与重试 | 与微信式的轻量登录一致；排障信息仍在开发者模式和日志里 |
| 外网连通不阻塞创建与加入设备 | 现有本机引导把连通检测放在登录前 | 本机可用就能工作；远程访问提供修复入口即可 |

canonical（9/19）与 R2 的对应条款，在本稿实现并验收后另行回写；实现期间以本稿为准。

## 10. 验收

1. **A 组状态**：`SolidAuthBoundary` 示例应用和 Xpod WebID 门，逐状态截图一致：A0–A3，以及 C1–C4 的一行提示。
2. **尺寸与主题**：`window` 360×540、`dialog`、`page`（1280 宽两栏，390 宽单栏），200% 文字、深浅主题下，主操作和返回都可见，没有水平滚动。
3. **键盘与读屏**：只用键盘能走完路径 1–4。状态变化用 polite 播报，失败用 assertive。
4. **一行提示**：普通模式下，C 组只有一行提示，没有错误码；开启开发者模式后，可以点开查看详情。
5. **不静默改道**：本机 Xpod 边缘不可用时，不会有任何请求发往其他 issuer（回归测试）。
6. **测试**：所有新组件都有单元测试，覆盖每个状态的渲染、按钮回调、ARIA 角色（radiogroup / dialog / status / alert）。

## 11. 实施分期

### 11.1 第一期（本次派发）：新前门组件，并接入 Xpod 与 extension-sdk

范围：

1. **主题**：`packages/shared-ui/src/theme.css` 的浅色和深色 token，按 §5 改成纸色与墨紫。`.light`、`:root`、`.dark` 三处保持一致；同步更新 `theme.test.ts` 的断言。
2. **新组件**：实现 §8.1–§8.3 的 `pod-sign-in` 模块，含 zh-CN / en 文案和测试，并从 `index.ts` 导出。
3. **D 组账号页**（2026-09-30 试用后从第二期提前）：按 §8.4 实现各分区组件，并接入 `AccountPage.tsx`，替换旧的英文 Account Dashboard：
   - WebID 分区接现有 WebID 与 Pod 列表；新建只走 `CreateWebIdForm`（名称 + 存放在），旧的"Manage Pods"入口和旧建 Pod 页不再从账号页进入；
   - 设备分区先接本机（`/provision/status`、`/api/network/settings/*`）；`/v1/nodes` 仍返回 501，跨设备部分只显示本机和云端，不放无效按钮；
   - 密钥分区接现有 client credentials；从授权进来时显示 `ConsentResumeBanner`；
   - 语言与登录页使用同一判断；修改密码、退出放进账号菜单。
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
   - 登录（`XpodBlockingAccountCredentialsSurface` 的 login 模式）→ `IdpSignInView`；
   - 注册 → `IdpRegisterView`（`requireUsername` 按现有 controls 决定）；
   - `ConsentPage` 的正常授权 → `ConsentView`；
   - `ConsentPage` 缺 Pod 的分支 → `IdpNoWebIdView`，沿用现有的 `handleCreateFirstPodAndContinue` / `handleGoToPodManagement`；
   - 保留原有测试中的 id 和可访问名称（如 `oidc-consent-webid`），必要时调整断言；
   - 去掉 `WebAccountLayout` 里过期的"Personal Messages Platform"标语。

不在第一期：
- 注册时一并创建 WebID 和 Pod 的服务端编排；
- `/v1/nodes`、宿主代理拉起、跨设备网络；
- LinX 迁移（另一个仓库）；
- 开发者模式开关的持久化（本期只提供 prop）；
- canonical 回写。

### 11.2 第一期的门禁命令（全部通过才算完成）

```bash
bun run --filter '@undefineds.co/shared-ui' test
bun run --filter '@undefineds.co/extension-sdk' test
bun run build:ts
bun run typecheck:test
bun run test
```

`ui/` 下的测试随 `bun run test` 执行，被改动的 ui 测试文件必须通过。另外运行 `cd ui && bun run build:dashboard`，确认前端能构建。

### 11.3 第二期（第一期验收后再派发）

- 注册时一并创建 WebID 和 Pod（B2 编排）；
- 账号页跨设备部分：依赖 `/v1/nodes` 恢复；
- 本机拉起接桌面宿主能力（`startLocal`）；
- LinX 改用 `PodSignIn`；
- 开发者模式开关放进 Xpod 设置。
