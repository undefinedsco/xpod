## 需求细化草案

  ### 1. 布局与页面流
  - **主框架**：左右双栏
    - 左侧固定宽度，包含：
      - Profile 模块：展示当前账号、当前激活的 WebID；支持下拉切换 + 编辑 Profile（昵称、头像、语言等）。
      - 二级菜单：
        1. Pods（列表 + 创建/删除入口）
        2. 密钥（Client Credentials / API Keys 管理）
        3. WebID 注册/绑定
        4. 基本信息（后续可扩展）
    - 右侧为内容区，上方展示当前服务信息（Solid logo、GitHub 链接、环境标签）。
  - **主页逻辑**：
    - 未登录：自动跳转或弹窗提示到登录流程；提供注册入口。
    - 已登录：显示欢迎页（欢迎语、最近活动等）。
    - 若账号尚未创建 Pod，则在欢迎页突出“创建 Pod”引导。
  - **二级页面**：
    - Pods：列表（名称、WebID、配额、最近活动），右侧可进入详情/删除。
    - 密钥：列出现有 Client Credentials，支持新增 / 吊销。
    - WebID 注册：展示已绑定 WebID、绑定新 WebID 的表单。
    - Profile 编辑：支持修改昵称/头像/语言/通知偏好等。
  - 路由建议：使用 SPA 路由（如 `/dashboard`、`/pods`、`/keys`、`/webid` 等）统一管理。

  ### 2. 前端技术方案
  - 继续基于 React + TypeScript。
  - 路由层使用 `react-router-dom`，共享控制台的 `react-i18next` 配置。
  - 全局状态建议使用 React Context 配合 SWR/React Query 管理身份信息。
  - UI 组件复用 Tailwind，抽象出通用卡片、列表、表单组件。
  - 认证处理：
    - 登录成功后沿用 CSS 的 Cookie/Token 机制，前端初次加载时调用 Profile API 判断登录态；返回 401/403 时跳转到登录页。
    - 支持 OIDC prompt 等多步交互：解析服务端返回的 redirect/controls，并在前端执行对应操作。

  ### 3. 后端/接口预研（待确认）
  - Profile：是否存在 REST API（例如 `GET /.account/profile`）；若无需新增。
  - Pods：创建/删除/查询接口，确认是否已有 JSON 入口。
  - 密钥：Client Credentials 的创建与吊销是否已有 REST API。
  - WebID 注册：确认绑定/解绑流程需要访问哪些端点。
  - 登录/注册/忘记密码：SPA 需要调用 `/login/password`、`/login/password/register` 等接口，并处理返回体中的 `location`/`controls`。
  - 服务信息：建议新增 `/identity/config`，统一返回环境、版本、功能开关，供右上角展示。

  ### 4. 开发迭代建议
  1. **调研阶段**：梳理所有 identity 相关路由的 `controls` 结构，明确交互流程；评估是否需新增后端接口。
  2. **骨架搭建**：实现 SPA Layout、导航与路由守卫；接入国际化。
  3. **功能迁移**：按模块逐步迁移 Profile / Pods / 密钥 / WebID / 登录流程。
  4. **切换策略**：配置开关控制是否使用 SPA；灰度期间保留模板做回退。
  5. **测试验收**：覆盖 OIDC 交互、权限不足、语言切换、无 Pod 新建等场景。

  ### 5. 风险与开放问题
  - CSS 的 controls 协议（尤其 OIDC prompt）当前依赖模板脚本，SPA 需要完全接管。
  - 如果 CSS 未提供 REST API，则需要扩展后端接口，工作量显著增加。
  - 安全策略必须与 CSS 原有机制一致，避免 Token/Credential 泄露。
  - 需要跨前端、后端、QA 协作，开发周期可能较长。