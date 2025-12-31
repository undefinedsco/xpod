# Xpod UI/UX Modernization: "Agent OS" Design & Implementation Plan

## 1. 目标与愿景 (Goals & Vision)

**核心目标**:
1.  **现代化 Xpod 前端界面**: 彻底摆脱 Community Solid Server (CSS) 默认的简陋 HTML 样式，提供具有品牌辨识度、符合现代审美的用户体验。
2.  **桌面端就绪 (App Shell Architecture)**: 设计风格和前端架构需具备平滑过渡到 Electron 桌面应用的能力，减少未来重构成本。
3.  **品牌形象塑造**: UI/UX 需体现 "Agent OS" 的科技感、控制感和简洁性，强化“AI 代理操作系统”的定位。

## 2. 设计理念: "Agent OS"

我们将打造一种 **“轻量级、沉浸式、终端感”** 的视觉与交互语言，以增强用户对“操作系统”的感知。

### 核心视觉风格

*   **Neo-Brutalism (新粗野主义) 结合 Glassmorphism (磨砂玻璃)**:
    *   **Neo-Brutalism 元素**: 强调清晰的边框、分明的层级、强烈的对比度。少量使用 Drop Shadow 或 Inner Shadow 来增加深度感，但保持整体简洁硬朗。
    *   **Glassmorphism 元素**: 少量用于背景层或弹出组件，通过背景模糊和透明度来增加现代感和信息层级，但不滥用以避免视觉疲劳。
*   **色彩系统**:
    *   **Primary (主品牌色)**: 选取饱和度更高、更具科技感的**紫色**系，与 Solid 社区品牌色调保持一致，同时提升视觉冲击力。
        *   `--color-primary-500`: `#7c3aed` (Base Purple)
        *   `--color-primary-600`: `#6d28d9` (Darker for Hover/Active)
        *   `--color-primary-400`: `#9333ea` (Lighter for Accents)
    *   **Accent (辅助色)**: 选用与主色系互补或相邻的色调，如青色或洋红色，用于状态提示（成功/警告）或次要高亮。
        *   `--color-accent-500`: `#d946ef` (Fuchsia for vibrancy)
    *   **Neutral (中性色)**: 采用 `slate` 或 `zinc` 系列作为基础，区分深浅用于背景、文字、边框。
        *   **Dark Mode (默认)**:
            *   背景 (Background): `slate-900` / `zinc-900`
            *   表面 (Surface/Card): `slate-800` / `zinc-800`
            *   文字 (Text): `slate-100` / `zinc-100`
            *   边框 (Border): `slate-700` / `zinc-700`
        *   **Light Mode (备选)**:
            *   背景: `white` / `slate-50`
            *   表面: `white` / `slate-100`
            *   文字: `slate-900` / `zinc-900`
            *   边框: `slate-200` / `zinc-200`
*   **字体选择**:
    *   **UI 文本 (Sans-serif)**: `Inter` 或 `Roboto` (Google Fonts)，保证在各种屏幕和大小下的可读性。
    *   **代码/ID/路径 (Monospace)**: `JetBrains Mono` 或 `Fira Code` (Google Fonts)，增强“终端”和“开发”感。
*   **图标**: 简洁的线条图标 (Lucide/Heroicons)，确保在深色背景下清晰可见。
*   **间距与排版**: 遵循 8px 网格系统，保持一致性。

### 核心交互模式

*   **单一窗口模型**: 页面跳转不触发整体浏览器刷新，而是模拟桌面应用的视图切换（通过 JS 或未来 React 实现）。
*   **沉浸式体验**: 尽量减少浏览器原生的滚动条和边框，UI 元素填充整个视口。
*   **键盘优先**: 重要的操作和导航应支持键盘快捷键，提升效率。

## 3. 核心页面功能设计 (MVP)

### A. 认证流程 (Authentication Flow) - **本次改造重点**

所有用户首次接触 Xpod 的“开机界面”，需具备强烈的品牌感和流畅的交互。

1.  **Welcome / Login Page (欢迎/登录页面)**:
    *   **URL**: `/.account/` (或重定向至此)。
    *   **旧版**: CSS 默认的朴素登录表单。
    *   **新版设计**:
        *   **布局**: 采用分屏式设计。
            *   **左侧 (品牌展示区)**: Xpod Logo，Slogan ("The Semantic File System for AI Agents")，可以加入动态背景或抽象几何 SVG 动画，突出科技感。
            *   **右侧 (交互区)**: 包含登录表单、注册链接、忘记密码链接。
        *   **登录方式**:
            *   **本地账户**: 邮箱/密码。
            *   **OIDC (Solid)**: 外部身份提供者登录。
            *   通过 Tab 或按钮组切换两种登录方式，切换时表单内容平滑过渡。
        *   **表单交互**: 输入框获得焦点时，边框颜色从中性色变为品牌主色。错误提示清晰醒目。
        *   **保持登录**: Checkbox 样式优化。
        *   **按钮**: 主操作按钮使用品牌紫色，并带微弱的交互动画 (如 Hover 时轻微下沉或颜色变化)。

2.  **Register Page (注册页面)**:
    *   **URL**: `/.account/login/password/register/`。
    *   **旧版**: 冗长的注册表单。
    *   **新版设计**:
        *   **布局**: 与登录页保持一致的分屏设计或独立居中 Card 布局。
        *   **分步向导 (Stepper)**:
            1.  **基本信息**: 邮箱、密码 (包含密码强度提示)。
            2.  **WebID 设置**: 用户选择 WebID 标识 (例如 `alice`)，需有实时可用性检测 (通过后端 API 调用)。显示完整的 WebID 预览 (如 `https://your-domain.com/alice/profile/card#me`)。
            3.  **完成**: 注册成功消息，显示新生成的 WebID，提供“一键复制”按钮和“进入系统”按钮。
        *   **验证**: 实时表单验证（客户端 JS），提供友好的错误提示。

3.  **Consent Page (OIDC 授权页面)**:
    *   **URL**: `/.account/oidc/consent/`。
    *   **场景**: 当第三方应用程序（Client App）请求访问用户的 Pod 资源时。
    *   **新版设计**:
        *   **布局**: 居中弹窗或 Card 形式，模拟手机或桌面 App 的权限请求弹窗。
        *   **信息展示**: 清晰显示请求授权的 Client App 名称/Logo。
        *   **请求权限**: 列出 Client App 请求的权限列表（Read/Write/Append/Control），使用易懂的图标或文字解释权限范围。
        *   **操作按钮**: 明确的 "Allow (允许)" 和 "Deny (拒绝)" 按钮，"Allow" 使用品牌紫色。

### B. 系统主页 (Dashboard / Landing Page) - **后续规划**

用户登录成功后进入的第一个界面。

*   **URL**: `/` (根目录，在用户登录后)。
*   **设计**:
    *   **Status Indicators**: 显示系统核心状态，如 "System Online", "Pod Active"。
    *   **Resource Overview**: 简要展示当前用户拥有的 Pods 列表，每个 Pod 卡片显示关键信息（如存储使用量、最近活动）。
    *   **Quick Access**: “启动终端”、“浏览文件”、“进入设置”等快速入口。
    *   **Notification/Activity Feed**: 显示系统通知或最近的 Pod 活动。

## 4. 技术架构与实施路线图

### 核心技术栈

*   **HTML 模板**: EJS (现有)。
*   **样式框架**: Tailwind CSS。
*   **动态交互**: Vanilla JS (少量，主要用于表单处理、视图切换)。

### 目录结构重构

```
xpod/
├── static/
│   ├── css/                       (编译后的 CSS 产物)
│   │   └── main.css
│   ├── fonts/                     (自定义字体，如 Inter, JetBrains Mono)
│   ├── images/                    (Xpod Logo, Illustrations)
│   ├── js/                        (少量通用 JS 辅助函数)
│   └── app/                       (未来 React App 的静态文件挂载点)
├── src/
│   ├── styles/
│   │   └── input.css              (Tailwind CSS 源码入口)
│   └── scripts/                   (EJS 模板所需的 JS 逻辑，例如 fetchControls 辅助函数)
├── templates/
│   └── identity/
│       ├── _layouts/              (所有认证页面的基础布局)
│       │   └── auth.ejs           <- 包含 <head>, <body> 骨架, Tailwind 引用
│       ├── _components/           (认证流程中的可复用 EJS 片段)
│       │   ├── header.ejs
│       │   ├── form-input.ejs
│       │   ├── primary-button.ejs
│       │   └── social-login-buttons.ejs (Placeholder for future)
│       ├── login.html.ejs         <- 主页面，`include` 布局和组件
│       ├── register.html.ejs
│       ├── oidc/
│       │   └── consent.html.ejs
│       └── password/
│           ├── forgot.html.ejs
│           └── reset.html.ejs
```

### 实施步骤 (分阶段进行)

#### 阶段 A: 基础建设 (Infrastructure & Layout)

1.  **安装 `@tailwindcss/forms`**: `npm install -D @tailwindcss/forms`
2.  **修改 `tailwind.config.ts`**:
    *   `content`: 增加 `templates/**/*.{ejs,html}` 扫描路径。
    *   `theme.extend.colors`: 定义 `primary` 和 `accent` 紫色系。
    *   `plugins`: 引入 `@tailwindcss/forms`。
    *   配置 `darkMode: ['class', '[data-mode="dark"]]`。
3.  **创建 Tailwind CSS 入口文件 `src/styles/input.css`**:
    ```css
    @tailwind base;
    @tailwind components;
    @tailwind utilities;
    ```
4.  **更新 `package.json`**: 添加 `build:css` 脚本。
    ```json
    "scripts": {
      "build:css": "tailwindcss -i ./src/styles/input.css -o ./static/css/main.css --minify",
      "build": "npm run build:ts && npm run build:components && npm run build:css", // 将 build:css 加入主 build 流程
      // ... 其他 scripts
    }
    ```
5.  **修改 `config/xpod.json`**:
    *   添加 `StaticAssetEntry`，将 `/css/` 路径映射到 `./static/css/`。
    *   考虑到 CSS 的 StaticAssetHandler 覆盖机制，这里需要小心，避免覆盖默认的 favicon 等。一种方式是增加一个独立的 StaticAssetHandler，或者明确列出所有需要服务的静态资源。**推荐方案：在主 `extensions.*.json` 中定义一个新的 HTTP Handler 插入到链中。**
    *   *暂时替代方案 (为快速验证)*: 允许浏览器直接访问 `static/css/main.css` 路径。

6.  **创建通用布局 `templates/identity/_layouts/auth.ejs`**:
    *   包含 HTML `<!DOCTYPE html>`, `<html>`, `<head>`, `<body>` 结构。
    *   引入 `static/css/main.css`。
    *   设置 `lang="zh-CN"`。
    *   `<body>` 使用 Tailwind classes (`min-h-screen bg-zinc-900 text-zinc-100 font-sans antialiased`)。
    *   预留 `<%- body %>` 占位符。

#### 阶段 B: 页面改造 (认证流程)

1.  **重写 `login.html.ejs`**:
    *   使用 `_layouts/auth.ejs` 作为父布局。
    *   应用 Tailwind CSS classes 改造表单和布局。
    *   实现分屏布局或居中卡片布局。
    *   保留 `fetchControls` 和 `postJsonForm` 等 JS 逻辑。
2.  **重写 `register.html.ejs`**:
    *   同样使用 `_layouts/auth.ejs`。
    *   应用 Tailwind CSS classes。
    *   实现分步向导的 UI。
    *   保留原有 JS 逻辑。
3.  **重写 `oidc/consent.html.ejs`**:
    *   使用 `_layouts/auth.ejs`。
    *   应用 Tailwind CSS classes，改造为弹窗或卡片样式。
    *   保留原有 JS 逻辑。

#### 阶段 C: Landing Page

1.  **重写 `static/landing/index.html`**:
    *   用 Tailwind CSS 和新的设计语言重写欢迎页。
    *   确保登录后的用户能看到一个符合新 UI 风格的“主页”。
    *   这个页面是纯静态 HTML，不依赖 EJS 渲染。

## 5. 预期成果

*   所有认证相关页面拥有统一、现代、品牌的 UI/UX。
*   页面加载速度快，响应式布局。
*   为未来 Electron 桌面应用和 React SPA 打下坚实的基础。
*   Xpod 在用户心中的“AI Agent OS”形象得到强化。
