# Xpod Design

更新于 2026-10-02：合并 10/1 桌面 Shell/applets 规格与 R6 跨产品交接约束。本文是产品设计入口；所有链接中的设计目标均不自动构成当前版本已实现或发布的证据。

## 当前实施入口

先读[10/1 桌面 Shell 与 applets 规格](docs/superpowers/specs/2026-10-01-xpod-desktop-shell-and-applets-design.md)：本轮本机 UI、双宿主共享 applet 及与 R2/R6 的覆盖关系按其 §9 执行。[个人 AI 联合体验 R6](../homepage/docs/specs/personal-ai-product-experience-r6.md)的跨产品原对象交接、权限重验和业务事实来源继续有效；身份与资源协议仍由领域规范决定。

| 本轮范围 | 采用的合同 |
|---|---|
| Shell | 桌面工作区默认内容视口对应 10/1 canvas.json 画板 1280 × 800；响应式最小窗口仍为 640 × 560；rail 64 px；对象栏在规格 260–280 px 范围内取 270 px；列表与内容头部 48 px；窄窗导航和焦点按新规格验收 |
| 入口与身份 | Tasks、AI 连接、Pod applet 需要 WebID；这台设备、设置依本机宿主权限可匿名打开；Account 管理从个人卡片进入，不成为壳的全局门禁 |
| 登录窗口 | WebID 与简短 Account 登录、恢复、回调恢复微信式 280 × 400 宿主逻辑 bounds（最小同尺寸）；内容填充扣除原生标题栏后的可用视口。注册、完整 Consent、首次 Pod 与 Account 管理使用工作区文档布局 |
| 能力与证据 | 长期 Grant、导入/导出/跨设备迁移、多隧道同时生效等未定义或未接入能力继续标待接入；设计稿、历史测试数和文档合并均不证明本次运行或发布通过 |

1. [产品与体验纲领](docs/product-design-charter.md)：产品职责、十二条原则、规范如何裁决。
2. [产品、交互与视觉实施 Spec](docs/superpowers/specs/2026-09-27-xpod-product-experience-spec.md)：页面职责、流程、主题参数、状态、窗口、任务分工与验收，保留 R2 历史布局与 R6 业务交接细则；本轮布局、入口和共享 applet 以 10/1 规格为准。
3. [AI 自查模板](docs/product-design-self-review-template.md)：各模块按同一方法提供有依据的检查结果。
4. [功能、操作与信息架构审查](docs/product-experience-critique-2026-09-27.md)：为何旧功能显露、操作路径与布局不成立，及R2替代方案。
5. [本轮设计校正记录](docs/design-alignment-2026-09-27.md)：哪些旧规则被修正、依据是什么、哪些历史材料保留。

## 产品边界

Xpod 承载资料、知识、任务和个人模型资产，提供授权、索引覆盖、运行与恢复基础。LinX 以“工作、知识、我的 AI”承接日常编辑、反馈和个人 AI 使用；Foundry 保留训练与模型发布治理。Xpod 本机桌面管理这些任务所需的空间、接入和服务，不复制聊天、知识编辑器或训练提交表单。北极星由 Our Vision 表达，产品操作先让当下的事情清楚可控。

R2 的“概览、存储空间、AI、服务与访问”四入口和文字导航是历史方案，不作为本轮验收要求。10/1 规格采用共享 Tasks、AI 连接、Pod applet；配置跟壳，数据跟 applet，Tasks 可在两个宿主中编辑。资源与运行详情稳定可达，跨产品修复后返回同一对象与原任务；这不改变模型发布、训练或资源 schema 的业务权威。新品牌是纸色、墨紫与留缝折角；功能界面保留桌面密度、系统主题和诊断能力。旧 Logo 永久保留，切换使用引用，不覆盖原稿。

## 领域权威

| 范围 | 文档 |
|---|---|
| 品牌、故事与愿景 | [主站 DESIGN](../homepage/DESIGN.md)、[故事与风格](../homepage/docs/story-and-style.md)、[Our Vision](../homepage/docs/our-vision.zh-CN.md) |
| 个人 AI 产品任务与跨端交接 | [联合体验 R6](../homepage/docs/specs/personal-ai-product-experience-r6.md)、[产品故事 R5](../homepage/docs/specs/personal-ai-product-story-r5.md) |
| Shell 与 applet 分工 | [10/1 桌面规格](docs/superpowers/specs/2026-10-01-xpod-desktop-shell-and-applets-design.md)；[8/9 Shell](docs/superpowers/specs/2026-08-09-xpod-shell-information-architecture-design.md)保留历史方案与未被覆盖的领域边界 |
| 登录、Pod、宿主生命周期 | [9/19 canonical](docs/superpowers/specs/2026-09-19-xpod-login-and-host-design.md)及其指定仍有效的[8/30 权威边界](docs/superpowers/specs/2026-08-30-xpod-auth-authority-boundaries.md) |
| Account/WebID 展示范围 | [9/6 前端重设计](docs/superpowers/specs/2026-09-06-auth-frontend-redesign.md) |
| AI 接入 | [AI Connections](docs/ai-connections-product-spec.md) |
| 组件、布局与业务归属 | [前端设计原则](docs/ui-modernization.md) |

10/1 桌面规格决定本轮任务组织、功能显露、布局与交互参数，不新建认证会话或改写权限。Account 管理、授权本机操作、WebID/Pod 任务分别消费自己的 authority；注册不自动创建 Pod；目标架构和过渡版本的实际能力分别表达。

## 历史材料

原根 DESIGN 的全文保存为[2026-06-29 runtime console 记录](docs/design-history/runtime-console-2026-06-29.md)。旧三项导航、冷灰色板、金唱片、双产品导航及旧 AI Secretary 文案不再作为本轮实施要求；具体替代关系见校正记录。历史记录保留原时间与证据范围，不改写成新版本通过。
