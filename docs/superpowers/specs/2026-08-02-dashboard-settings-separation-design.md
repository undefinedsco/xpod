# Xpod Dashboard 与 Settings 分离设计

## 目标

Xpod 提供两个语义明确、视觉一致的产品入口：

- `/dashboard/*` 用于查看运行状态、诊断与用量。
- `/settings/*` 用于修改用户和服务配置。

两者共享 Layout SDK、Solid session、设计 token 与基础组件，但拥有独立路由、静态入口和产品导航。不得将 `dashboard` 简单改名为 `settings`，也不得让同一功能长期存在两个 canonical URL。

## 产品边界

判断页面归属的首要规则是操作性质：

- 只读状态、历史、诊断、健康度和配额归 Dashboard。
- 会保存、连接、更新或改变运行行为的配置归 Settings。
- 同一领域同时存在状态和配置时拆成两个页面，通过明确链接互跳。

### Dashboard

正式入口为 `/dashboard/overview`，`/dashboard` 重定向到该地址。

一级页面：

| 路由 | 职责 |
| --- | --- |
| `/dashboard/overview` | Xpod 总体状态摘要与关键告警 |
| `/dashboard/runtime` | 服务健康、生命周期状态与运行信息 |
| `/dashboard/logs` | 日志查看与筛选 |
| `/dashboard/rdf` | RDF 索引、水化和查询状态 |
| `/dashboard/network` | 地址、DNS、TLS、隧道和连通性诊断 |
| `/dashboard/usage` | 存储、流量、模型额度与配额概览 |

Dashboard 默认只读。确实需要改变配置的操作应链接到对应 Settings 页面，不在状态页复制表单。

### Settings

正式入口为 `/settings/models`，`/settings` 重定向到该地址。

一级页面：

| 路由 | 职责 |
| --- | --- |
| `/settings/models` | AI Connection、Provider 凭证、浏览器鉴权、API Key 与编码客户端接入 |
| `/settings/pod` | Solid 身份、Pod 关联与用户级数据设置 |
| `/settings/network` | 域名、隧道、证书策略等可编辑网络配置 |
| `/settings/services` | 服务级可写配置 |

Settings 中的运行结果和健康状态只保留必要摘要，并提供“查看状态”链接回 Dashboard。

## 现有页面迁移

| 现有地址或能力 | 新归属 |
| --- | --- |
| `/dashboard/models` | `/settings/models` |
| `/dashboard/pod` 的身份与配置 | `/settings/pod` |
| `/dashboard/pod` 的用量状态 | `/dashboard/usage` |
| `/dashboard/network` 的只读状态与诊断 | 保留 `/dashboard/network` |
| `/dashboard/network` 的可编辑配置 | `/settings/network` |
| Services 运行状态 | `/dashboard/runtime` |
| Services 配置 | `/settings/services` |
| `/dashboard/status` | `/dashboard/overview` |
| `/dashboard/settings` | `/settings/services` |

迁移完成后，旧的错误归属地址使用一次性 HTTP 重定向到唯一新地址。重定向保留查询参数，不在两个入口同时渲染同一页面。

## 应用与构建结构

Xpod 生成两个独立 SPA 入口：

- Dashboard 构建到 `static/dashboard`，Vite base 为 `/dashboard/`。
- Settings 构建到 `static/settings`，Vite base 为 `/settings/`。

两个入口使用各自的 React Router basename 和路由表。共享实现放在现有 UI 模块与 SDK 中，不复制 Layout、Solid runtime、认证边界或业务组件。

根 `build:ui` 必须同时构建 `/app/`、Dashboard 和 Settings 三个发布目标，避免任一产品继续提供旧静态产物。

服务端为两个静态目录分别注册 SPA fallback、静态资源、GET 和 HEAD 路由。通用静态文件服务逻辑应抽取复用，Dashboard/Settings 注册函数只声明挂载路径、静态目录和默认入口。

## Layout 与导航

两套产品沿用已经对齐 Linx 的布局契约：

- 60px 一级图标栏。
- 210px 列表栏。
- 列表头和内容头均为 48px。
- 搜索和新增操作属于列表头。
- 当前对象标题与对象级操作属于内容头。

Dashboard 和 Settings 的导航集合不同，但尺寸、间距、颜色、焦点状态及响应式行为相同。一级栏应提供在 Dashboard 与 Settings 之间切换的明确入口；托盘菜单同时提供“查看状态”和“设置”。

## Session 与权限

Dashboard 和 Settings 共享同一套 Solid OIDC session 实现，不创建第二个 Provider 或第二套 OIDC 登录。浏览器在同 origin 下访问两个入口时复用有效 session；session 过期仍按标准 Solid OIDC 流程重新登录。

权限由当前登录身份、Applet appId/clientId 和 Pod 授权决定。路由拆分不改变权限模型，也不引入 local/cloud 分支。

## 页面间导航

跨产品导航使用绝对路径：

- Dashboard 状态页的“配置”动作进入对应 `/settings/*`。
- Settings 页的“查看状态”动作进入对应 `/dashboard/*`。

OIDC `returnTo` 必须允许并正确恢复两个 basename 下的站内路径。未知 Dashboard 路径回到 `/dashboard/overview`；未知 Settings 路径回到 `/settings/models`。

## 测试与验收

### 路由测试

- 两个 basename 分别加载正确路由表。
- 默认入口和未知路径落到各自默认页面。
- 旧地址只重定向到唯一 canonical URL，并保留查询参数。
- Dashboard 不渲染设置表单；Settings 不复制完整状态页。

### 构建和服务测试

- `build:ui` 同时生成 app、dashboard 和 settings 产物。
- `/dashboard/*` 和 `/settings/*` 的 HTML、资源与 SPA fallback 均可访问。
- GET/HEAD、缓存头和路径遍历保护在两个入口行为一致。

### 会话测试

- 同一浏览器 session 可连续访问两个入口，不触发重复 OIDC 登录。
- 登录回调能恢复 Dashboard 或 Settings 原始路径。
- session 过期后的重新登录不产生并行 Session/Provider。

### 视觉验收

- 两个入口均为 60/210/48/48 布局。
- Dashboard 与 Settings 的边框、间距、搜索框、图标和选中态一致。
- `/settings/models` 中 AI Connection 使用真实数据和真实操作，不展示 demo 状态。

## 非目标

- 本次不重命名 `DashboardHandler` 等内部类型，除非抽取通用静态服务时自然消除该名称。
- 本次不重新设计 AI Connection 数据模型或 Provider 鉴权协议。
- 本次不增加新的 OIDC session 层。
- 本次不把 Dashboard 与 Settings 合并为一个无 basename 的单 SPA。
