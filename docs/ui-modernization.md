# Xpod 前端设计原则与参考系

> 本文是当前前端设计权威说明。旧版内容描述的 EJS/Vanilla 实施路线、Neo-Brutalism + Glassmorphism 视觉方向、默认 Dark Mode 已废止；现行实现以 React/Vite、`@undefineds.co/shared-ui` 和 `@undefineds.co/extension-sdk/react` 为准。

## 1. 当前形态

Xpod 前端由多个 surface 组成：`status`、`network`、`ai-connections`、`ai-config`、`settings` 与遗留 `dashboard` 入口。各 surface 可以独立加载，但必须共享同一套设计系统和交互协议。

当前分层：

```text
@undefineds.co/shared-ui
  纯展示组件、token、基础交互、认证展示

@undefineds.co/extension-sdk/react
  状态/能力/布局协议适配，不拥有视觉系统

ui app / applet
  业务数据、产品文案、路由、页面组合
```

## 2. 不可突破的边界

### 2.1 shared-ui

`shared-ui` 只负责：

- Button、Card、Input、Badge、Dialog、Switch、Toast 等 primitives
- `AuthSurface`、登录、注册、OIDC consent、Storage bootstrap 等公共展示视图
- Tailwind semantic token、focus 样式、`cn()` 合并规则
- 可通过 props/copy 注入的展示状态和文案

`shared-ui` 不负责：

- 网络请求、路由、Solid、Pod、账户业务
- 具体产品文案
- 页面级布局协议
- 与宿主能力耦合的状态机

### 2.2 extension-sdk/react

`extension-sdk/react` 只负责：

- `AppLayout`、`TwoPaneLayout` 等布局协议
- Solid/auth boundary 的状态到视图适配
- 宿主能力注入和回调接线

它不应重新实现 shared-ui 已有视图，也不应烘焙不可覆盖的用户可见文案。

### 2.3 ui app / applet

应用层负责：

- 业务数据加载与状态映射
- 中文产品文案
- 路由和页面组合
- 通过 shared-ui primitives 搭建页面

应用层不得复制 Button、Card、Input 等基础组件，不得绕过 package exports 引用内部文件。

## 3. 视觉风格原则

1. **Token 先行**：颜色、圆角、阴影、间距均来自 `shared-ui/theme.css` 的语义 token；禁止字面色值和页面级私有主题。
2. **Primitive 唯一**：同一语义的 Button、Card、Input、Badge、Select 只有一份实现；差异通过 variant 或 `className` 表达。
3. **同类交互同构**：primary/secondary/destructive/ghost、hover/focus/disabled/selected 在所有 surface 一致。
4. **一个场景一个外壳**：认证用 `AuthSurface`，产品用 `AppLayout`，双栏工作区用 `TwoPaneLayout`。
5. **桌面优先，移动适配**：默认按桌面 App Shell 设计；窄屏使用共享 stack/pane 行为，不各页面自写移动逻辑。
6. **视觉克制**：以浅色中性背景、紫色 primary、清晰边框和轻量阴影为现行语言；不恢复旧版 Neo-Brutalism/Glassmorphism 方向。

## 4. 交互原则

1. **可访问性默认完成**：语义 HTML、正确 `aria-*`、键盘可达、modal focus trap、Escape 关闭、错误 `role="alert"`。
2. **Focus 只有一种语言**：使用 shared-ui 的 `controlFocusClass` / `interactiveFocusClass`；不叠加 ring，不画双层框。
3. **状态机显式化**：loading、anonymous、authenticated、error、pending、empty 都有明确 UI；异步操作期间禁止重复提交。
4. **文案注入**：shared-ui 提供中性默认值，宿主/产品注入中文文案；SDK 不新增不可覆盖的用户可见文案。
5. **反馈统一**：成功、警告、失败、进行中使用统一 Badge/Toast/alert 语义；通知位置和 z-index 不散落。
6. **导航克制**：同 surface 内使用客户端路由；跨 surface 允许整页跳转，但必须恢复用户原始 deep link。
7. **危险操作显式确认**：destructive 操作需要明确确认路径，不能只靠颜色暗示。

## 5. 参考系

### 5.1 产品参考：Agent OS / Desktop App Shell

Xpod 的前端不是营销网站，而是 Agent OS 的桌面式控制面。设计目标是轻量、沉浸、可键盘操作、可迁移 Electron。

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

- 列表密度、Action Sheet、Tab 导航
- 二维码/授权确认路径
- 聊天消息流与窄屏操作

不把 WeChat 的品牌色、组件皮肤或小程序限制搬进 Xpod。

## 6. 当前必须收敛的分叉

以下事项是已确认的设计系统债务，新增代码不得继续扩大：

1. `ui/src/components/ui/` 下的本地 Button/Card/Input 是 shared-ui fork，应删除或迁移。
2. `shared-ui/src/workspace.tsx` 与 extension-sdk 的 `TwoPaneLayout` 重复，workspace 协议只保留 SDK 一份。
3. SDK 内的 `StorageSelectionView` 应下沉为 shared-ui 展示组件。
4. `LoginCardShell` 与 `AuthSurface` 重叠，认证外壳只保留 `AuthSurface`。
5. Account/About/Chat 等页面不得继续手写平行按钮、输入框和页面壳。
6. 用户可见文案必须由 app 注入；SDK/shared-ui 的默认值只做中性兜底。
7. 成功、警告、失败颜色必须走 `--success`、`--warning`、`--destructive` token。

## 7. 新代码检查清单

提交前端代码前，逐项确认：

- [ ] 是否只从 `@undefineds.co/shared-ui` 或 `@undefineds.co/extension-sdk/react` 的公开出口导入？
- [ ] 是否没有复制 shared-ui 已有 primitive 或布局协议？
- [ ] 是否没有字面色值、私有 focus、私有 z-index、私有页面壳？
- [ ] 是否所有用户可见文案都可由宿主/产品注入？
- [ ] 是否键盘可达、focus 正确、错误状态可感知？
- [ ] 是否同 surface 内使用客户端路由，跨 surface 能恢复 deep link？
- [ ] 是否没有为了当前页面引入“以后再说”的第二份实现？
