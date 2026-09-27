# Xpod Design

更新于 2026-09-27 R2。本文是产品设计入口；所有链接中的设计目标均不自动构成当前版本已实现或发布的证据。

## 当前实施入口

1. [产品与体验纲领](docs/product-design-charter.md)：产品职责、十二条原则、规范如何裁决。
2. [产品、交互与视觉实施 Spec](docs/superpowers/specs/2026-09-27-xpod-product-experience-spec.md)：页面职责、流程、主题参数、状态、窗口、任务分工与验收，作为本轮派工主文档。
3. [AI 自查模板](docs/product-design-self-review-template.md)：各模块按同一方法提供有依据的检查结果。
4. [功能、操作与信息架构审查](docs/product-experience-critique-2026-09-27.md)：为何旧功能显露、操作路径与布局不成立，及R2替代方案。
5. [本轮设计校正记录](docs/design-alignment-2026-09-27.md)：哪些旧规则被修正、依据是什么、哪些历史材料保留。

## 产品边界

Xpod 提供资料保存、访问和应用连接基础；桌面管理本机服务、网络、AI 接入与相关配置。LinX 是日常工作入口。北极星由 Our Vision 表达，产品操作先让当下的事情清楚可控。

R2按任务组织“概览、存储空间、AI、服务与访问”。基础为文字导航+内容，真实对象集合才增加列表—详情；正常、异常、配置、诊断各有信息优先级。五工作区与永久三栏是已撤回的旧设计选择，不是用户固定要求。新品牌是纸色、墨紫与留缝折角；功能界面保留桌面密度、系统主题和诊断能力。旧 Logo 永久保留，切换使用引用，不覆盖原稿。

## 领域权威

| 范围 | 文档 |
|---|---|
| 品牌、故事与愿景 | [主站 DESIGN](../homepage/DESIGN.md)、[故事与风格](../homepage/docs/story-and-style.md)、[Our Vision](../homepage/docs/our-vision.zh-CN.md) |
| Shell 与模块分工 | [8/9 Shell](docs/superpowers/specs/2026-08-09-xpod-shell-information-architecture-design.md) |
| 登录、Pod、宿主生命周期 | [9/19 canonical](docs/superpowers/specs/2026-09-19-xpod-login-and-host-design.md)及其指定仍有效的[8/30 权威边界](docs/superpowers/specs/2026-08-30-xpod-auth-authority-boundaries.md) |
| Account/WebID 展示范围 | [9/6 前端重设计](docs/superpowers/specs/2026-09-06-auth-frontend-redesign.md) |
| AI 接入 | [AI Connections](docs/ai-connections-product-spec.md) |
| 组件、布局与业务归属 | [前端设计原则](docs/ui-modernization.md) |

产品体验 spec 决定当前任务组织、功能显露、布局与交互参数，不新建认证会话或改写权限。Account 管理、授权本机操作、WebID/Pod 任务分别消费自己的 authority；注册不自动创建 Pod；目标架构和过渡版本的实际能力分别表达。

## 历史材料

原根 DESIGN 的全文保存为[2026-06-29 runtime console 记录](docs/design-history/runtime-console-2026-06-29.md)。旧三项导航、冷灰色板、金唱片、双产品导航及旧 AI Secretary 文案不再作为本轮实施要求；具体替代关系见校正记录。历史记录保留原时间与证据范围，不改写成新版本通过。
