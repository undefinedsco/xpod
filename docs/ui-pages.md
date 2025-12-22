# 前端页面功能与路由对照

本文整理当前 Xpod 前端页面的功能、路由与跳转关系，便于对齐 UI 表达与 CSS 规范。

## 服务入口与渲染方式

- `/`：静态落地页（`static/landing/index.html`），由 `config/xpod.json` 覆盖 `RootStaticAsset` 指向。
- `/.account/*`：身份/账号 SPA（`static/app/auth.html` + `static/app/assets/*`），由 `ReactAppViewHandler` 统一渲染。

## 页面与功能一览

| 路由 | 页面类型 | 主要功能 | 主要信息 |
| --- | --- | --- | --- |
| `/` | 落地页 | 展示品牌与产品能力，引导登录/注册 | Xpod 作为 Pod 控制面，统一管理 Pod/身份/权限，云边协同 |
| `/.account/` | 入口页 | 根据登录状态选择跳转 | 未登录 → 登录；已登录 → Dashboard |
| `/.account/login/` | 登录方式选择 | 展示可用登录方式（若无则直跳密码登录） | 选择登录方式 |
| `/.account/login/password/` | 登录页 | 邮箱+密码登录；找回密码入口 | 登录以进入 Xpod 控制台 |
| `/.account/login/password/register/` | 注册页 | 邮箱+密码注册；创建账号 | 创建 Xpod 账号 |
| `/.account/login/password/forgot/` | 找回密码 | 提交邮箱触发重置流程 | 重置密码 |
| `/.account/account/` | Dashboard | 管理 WebID、Pod、凭证、密码 | 账号管理与资源操作 |
| `/.account/oidc/consent/` | 授权页 | 选择 WebID、同意/拒绝应用授权 | 授权第三方应用访问 |

## 跳转关系（关键路径）

- `/.account/`  
  - 已登录：跳转 `/.account/account/`  
  - 未登录：跳转 `/.account/login/password/`

- `/.account/login/`  
  - 若存在 `controls.main.logins`：展示登录方式  
  - 否则：跳转 `/.account/login/password/`

- 登录成功跳转优先级：  
  1) `json.location`（响应体）  
  2) `Location` 响应头  
  3) `returnTo`（会话中记录的回跳地址）  
  4) `/.account/account/`

- 注册成功跳转优先级：  
  1) `returnTo`  
  2) `/.account/account/`

- 授权页（`/.account/oidc/consent/`）  
  - Deny：POST `controls.oidc.cancel` → 使用返回 `location` 回跳  
  - Allow：按 CSS 原生流程分两步执行（见下方“Consent 前端流程”）  
  - 未登录：提示先登录，并将当前 consent URL 写入 `returnTo`

## Consent 前端流程（对齐 CSS 默认实现）

当用户点击 “Authorize” 时，前端按以下顺序调用：

1) `POST controls.oidc.webId`  
   - body: `{ webId }`  
   - 响应包含 `location`

2) `GET location`  
   - 必须访问此 URL 以更新 OIDC interaction 状态  
   - 失败会导致后续 consent 报 “Only interactions with a valid session”

3) `POST controls.oidc.consent`  
   - body: `{ remember: true | false }`  
   - 响应包含最终 `location`，前端跳转回调用方

注：不要直接对 `location` 做 redirect，而应发起 `GET` 保持 interaction 会话一致。

## 主要表达信息（页面文案对齐）

- 落地页与登录页强调 Xpod 控制面能力：Pod/身份/权限统一管理、云边协同、Solid 兼容。
- 授权页明确是第三方应用的访问请求，并允许选择 WebID。
- Dashboard 强调账户资源管理：WebID、Pod、Client Credentials、密码维护。

## 相关配置入口

- `config/xpod.json`  
  - `RootStaticAsset` → `static/landing/index.html`  
  - `HtmlViewHandler` → `ReactAppViewHandler`（统一 SPA）  
  - `MainTemplateEngine` → `templates/main.html.ejs`（移除默认 CSS 外壳）

## 注意事项

- HTML/JSON 双栈：`/.account/*` 在 `Accept: text/html` 下返回 SPA HTML，在 `Accept: application/json` 下返回控制信息（controls）。
- OIDC 授权页只有在授权交互存在时才会进入，非交互场景会返回 401/403。
