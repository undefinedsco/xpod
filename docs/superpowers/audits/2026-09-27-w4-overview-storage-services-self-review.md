# W4 概览 / 存储空间 / 服务与访问 · 设计自查与实施范围

### 范围与职责

- 模块 / 负责人：概览、存储空间、服务与访问三个任务域的独占页面与组合视图（W4）
- 审查日期 / 纲领与实施 spec 版本：2026-09-27 / 纲领 R2、实施 spec 2026-09-27 R2
- 适用设计决定 D 编号 / 实施验收 AC 编号：D-01、D-08、D-10；AC-05、AC-09、AC-10、AC-14
- 用户任务（一句话）：一眼知道现在能不能用、要处理什么、东西在哪，并在同一个任务里改配置、看结果
- 场景：桌面工作区（概览常见于首次与唤回）、窄窗、诊断专业视图
- 本模块负责 / 不负责：负责三域的页面组织、事实优先级、状态与配置的分区呈现、专业详情入口；不负责 Pod 创建 controller（W3 拥有，W4 消费）、AI 两域（W5）、主题参数（W1）
- 前置模块 / 完成后去向：W1 公共视觉、W2 页型与导航、W3 创建与续接；W7 集成与发布证据消费本模块的验收记录
- 审查层次：文档 + 前端表达（读取 `ui/src/pages/admin/StatusPage.tsx`、`ui/src/dashboard-routes.tsx`、`ui/src/layout/status-navigation.ts`、`ui/src/pages/settings/NetworkPage.tsx`、`ui/src/pages/settings/SystemSettingsSubjectPanel.tsx`、`ui/tailwind.config.js`；未启动应用）
- 已阅读的文件、章节或行号：
  - `ui/src/pages/admin/StatusPage.tsx`（578 行，卡片式：访问路径 / 完整路径详情 / 需处理事项 …）
  - `ui/src/dashboard-routes.tsx:20-31`（`/status/*` 路由表：无 `usage/*`）
  - `ui/tailwind.config.js`（语义色只映射 border/input/ring/primary/secondary/muted/accent/destructive）
  - 实施 spec §7.1、§7.2、§7.5、§7.6、§8.1、§10、§12 W4；AC-05/09/10/14；纲领 XP-01/XP-09/XP-10
- 未覆盖范围：真实运行数据的事实来源核对、窄窗走查、AI 两域（W5）

### 适用依据

| 依据 ID | 文件与位置 | 适用对象 / 规则摘要 | 性质 |
|---|---|---|---|
| E-01 | spec §7.1 | 概览固定分区：结论、需处理事项、访问与空间摘要、专业详情入口；正常首屏 = 一个结论 + ≤4 组事实 + 0–1 强调动作；五种情况各有优先信息 | 领域规范 |
| E-02 | spec §7.2 | 存储空间以 `/settings/pod` 为入口，聚合位置、用量、应用访问、搜索处理；统计未知不显示零；"查看资料"只在真有内容应用时出现 | 领域规范 |
| E-03 | spec §7.5 | 服务与访问在同一上下文提供状态、配置与诊断；保存≠应用≠可达；运行秘密只写或脱敏 | 领域规范 |
| E-04 | spec §7.6 | 页型信息预算：概览、对象集合、配置、诊断各自的常态信息与操作规则 | 领域规范 |
| E-05 | spec §8.1 末段 | 页面不可自建语义彩色；success/warning/destructive 保留语义，由公共主题统一映射 | 领域规范 |
| E-06 | spec §3.1/§3.3 | 用量深链 `/status/usage/overview` 及 storage/bandwidth/ai/index-storage；`/dashboard/usage` 映射到它 | 领域规范 |
| E-07 | `ui/src/pages/admin/StatusPage.tsx` | 现状：卡片并列（访问路径 / 完整路径详情 / 需处理），含 amber 字面量 | 前端表达 |
| E-08 | `ui/src/dashboard-routes.tsx` | 现状：有 index、logs、services 深链，**没有 usage 路由** | 前端表达 |
| E-09 | `ui/tailwind.config.js` | 现状：未映射 success/warning，页面只能用调色板字面量表达语义 | 前端表达 |

### 功能与操作是否成立（先于规则合规）

| 功能 / 入口 | 用户要作的决定 | 没有它哪条任务受损 | 判定 | 理由和受影响能力 |
|---|---|---|---|---|
| 概览结论区 | 现在能不能用、要不要处理 | 用户在卡片间自行拼结论 | 保留（需重排） | 现状多卡并列，没有先给结论（E-07） |
| 需处理事项 | 先处理哪一个 | 同一根因重复成多张卡，优先级不明 | 合并 | 现状有 ActionNeededCard，但与其他卡同权 |
| 空间用量 | 用多少、在哪 | 用户去别处拼接；未知被显示成零 | 缺证据 | 无 usage 路由（E-08），未知/零的区分未核对 |
| 服务与访问 | 看状态、改配置、确认结果 | 保存与生效混为一谈 | 缺证据 | 三个域分散（status/settings/network），同任务分区未落地 |
| 诊断入口 | 需要时能直达 | 专业信息被藏或与日常并列 | 保留 | `/status/index/*`、`/status/logs` 深链已在，导航归属由 W2 定 |

### 原则自查表

| 原则 | 判定 | 层次 | 本模块判断与依据 |
|---|---|---|---|
| XP-01 用户任务与产品职责 | 偏离 | 前端 | 概览以系统视角的卡片组织，而非"现在能不能用"的结论（E-01/E-07） |
| XP-02 愿景、目标与能力边界 | 符合 | 文档 | 不声称云端可管主机（E-03） |
| XP-03 对象与事实来源 | 缺证据 | 前端 | 机器在线、服务健康、地址可达、空间访问是否各按来源表达未逐项核对（E-01） |
| XP-04 意图、执行与观察结果 | 缺证据 | 前端 | 保存/应用/检测/重启的分别反馈未逐项核对（E-03/AC-10） |
| XP-05 用户控制与改变后果 | 符合 | 文档 | 配置修改的后果说明由 §7.5 规定 |
| XP-06 失败与恢复 | 缺证据 | 前端 | 局部失败与状态未知的恢复动作未逐项核对 |
| XP-07 模块分工与任务续接 | 符合 | 文档 | 创建 controller 归 W3，W4 消费 |
| XP-08 生命周期与数据操作 | 符合 | 文档 | 删除与重建语义由领域 owner 规定 |
| XP-09 信息架构与层次 | 偏离 | 前端 | 概览未按 §7.1 的固定分区与信息预算；用量域缺失（E-01/E-08） |
| XP-10 品牌与操作气质 | 偏离 | 前端 | 页面用调色板字面量表达语义（amber 等），绕过公共语义映射（E-05/E-09） |
| XP-11 公共设计系统与归属 | 偏离 | 前端 | success/warning 未进入公共映射，导致页面各写颜色（E-09） |
| XP-12 可访问性与异常状态 | 缺证据 | 前端 | 窄窗与 200% 字体下的概览未走查 |

### 问题记录

```text
问题 ID：W4-DESIGN-01
标题：概览以并列卡片呈现，未先给结论，也未按信息预算收敛
判定：偏离
优先级：P1
关联原则：XP-01、XP-09
审查层次：前端
适用规则：E-01「结论、需处理事项、访问与空间摘要、专业详情入口」+ 正常首屏一个结论、≤4 组事实、0–1 强调动作
实际材料：`ui/src/pages/admin/StatusPage.tsx` 的 Card 并列（访问路径、完整路径详情、需处理事项等，E-07）
用户影响：用户要在多张同权卡片间自己拼出"现在能不能用"，异常时也看不出先处理哪一项
最小修正方向：先出结论与影响，把服务健康收成一行摘要，需处理事项合并成一条主错误 + 其余数量；专业详情用可展开入口
主责模块 / 关联模块：概览（主）/ 服务与访问、诊断
完成条件：正常态首屏恰有一个结论、不超过四组事实、强调动作 0–1；五种情况各有优先信息
未验证边界：未做窄窗与 200% 字体走查
```

```text
问题 ID：W4-DESIGN-02
标题：用量域在实现中不存在，空间用途与容量无法在对象内看到
判定：缺证据
优先级：P1
关联原则：XP-09
审查层次：前端
适用规则：E-06（`/status/usage/overview` 及 storage/bandwidth/ai/index-storage 深链）；E-02（统计未知不显示零）
实际材料：`ui/src/dashboard-routes.tsx` 无 usage 路由（E-08）；W2 的映射表已把 `/dashboard/usage` 暂落概览并在注释中记录缺口
用户影响：用户看不到已用容量与带宽，也无法从空间详情进入；未知与零无法区分
最小修正方向：建立用量页并接入空间详情；未知一律表达为未知，不回落 0
主责模块 / 关联模块：存储空间（主）/ 概览、服务与访问
完成条件：空间详情可进入用量；未知/零/有值三态都有用例
未验证边界：真实用量来源未核对
```

```text
问题 ID：W4-DESIGN-03
标题：页面用调色板字面量表达语义，公共层没有 success/warning 映射
判定：偏离
优先级：P2
关联原则：XP-10、XP-11
审查层次：前端
适用规则：E-05「success、warning、destructive 保留语义…不新增红绿橙调色板；页面不可自建语义彩色」
实际材料：`amber|red|green|blue|emerald` 等字面量共 17 处在 12 个产品文件（StatusPage、NetworkPage、StatusBadge、XpodUserCard 等）；`ui/tailwind.config.js` 未映射 success/warning（E-09）
用户影响：同一"警告/成功"在不同页面呈现不同颜色；深色主题下不保证对比度
最小修正方向：把 success/warning（含 foreground）加入公共映射，页面改用语义类；保留确有出处的品牌色并标注
主责模块 / 关联模块：shared-ui/公共映射（主）/ 各页面
完成条件：产品页面不再用调色板字面量表达语义；语义色只来自公共 token
未验证边界：未逐处确认视觉等价
```

```text
问题 ID：W4-DESIGN-04
标题：服务状态、连接设置与诊断仍是三个独立页面，"同一任务内分区"未落地
判定：缺证据
优先级：P2
关联原则：XP-04
审查层次：前端
适用规则：E-03「服务健康与运行策略、访问观测与配置可以同页，事实和动作仍分清」
实际材料：`/status/*`、`/settings/runtime`、`/network/*` 各自成页；W2 已把它们归入「服务与访问」入口
用户影响：查看状态 → 改配置 → 确认结果要跨页，容易把"保存"当"已生效"
最小修正方向：在服务与访问内按任务分区（服务与启动 / 访问与连接 / 对外访问 / 诊断），共用 owner 数据但分区呈现
主责模块 / 关联模块：服务与访问（主）/ 各领域 owner
完成条件：同一任务内可看状态、改配置、确认结果；保存/应用/检测分别反馈
未验证边界：未做交互走查
```

### 跨模块事项与交接

| 问题 ID | 主责 / 消费模块 | 可直接引用的决定，或待决定的问题 | 各模块需同步什么 | 完成条件 |
|---|---|---|---|---|
| W4-DESIGN-01 | 概览 / W5 | 直接引用 E-01 | AI 与空间的摘要由各域提供 | 首屏预算成立 |
| W4-DESIGN-02 | 存储空间 / 用量 owner | 直接引用 E-06 | 用量页与空间详情接线 | 三态用例 |
| W4-DESIGN-03 | shared-ui / 各页面 | 直接引用 E-05 | 公共映射新增 success/warning | 无字面量语义色 |
| W4-DESIGN-04 | 服务与访问 | 直接引用 E-03 | 各域提供状态与配置读写接口 | 同任务分区 |

### 结论

- 最重要的设计结论（不超过三项）：
  1. 概览需要从"卡片并列"改为"结论优先 + 信息预算"，这是 W4 的核心；
  2. 用量域整体缺失，属空间任务闭环的缺口；
  3. 语义色必须先回到公共映射，页面才能按规范表达状态。
- 值得保留的设计：`/status/index/*`、`/status/logs`、`/status/services/*` 深链齐全，专业信息可直达；服务与访问的四个主题已有对应页面。
- 本模块可修正事项 / 公共层事项 / 待决定事项：可修正 01、03；公共层事项 03 的映射；核对 02、04；无待用户决定事项。
- 本次仍缺少的设计或前端材料：用量三态（未知/零/有值）用例、概览五种情况的首屏用例、窄窗走查。
- 本轮结论范围：文档 + 前端表达审查；未运行应用。

## 实施范围与依赖清单（§12 W4 要求）

| 项 | 内容 |
|---|---|
| 实现范围 | 概览按 §7.1 重排（结论 / 需处理 / 访问与空间摘要 / 专业入口 + 首屏预算）；用量页与空间详情接线；服务与访问内按任务分区；语义色改走公共映射 |
| 未覆盖范围 | Pod 创建 controller（W3）、AI 两域（W5）、主题参数本身（W1）、真实用量来源 |
| 对应编号 | D-01、D-08、D-10；AC-05、AC-09、AC-10、AC-14 |
| 变更文件（预计） | `ui/src/pages/admin/StatusPage.tsx`、`ui/src/dashboard-routes.tsx`、`ui/src/layout/status-navigation.ts`、`ui/src/pages/settings/NetworkPage.tsx`、`ui/src/pages/settings/SystemSettingsSubjectPanel.tsx`、`ui/tailwind.config.js`、相关测试 |
| 依赖 | W1 公共层（已完成）、W2 页型与导航（已完成）、W3 创建 controller（已完成）；用量与网络事实来源按 §11 由领域 owner 提供证据 |
| 验收证据分层 | 前端：首屏预算用例、三态用例、语义色契约；运行：实施后按 AC-05/09/10/14 分别取证 |
| 其他模块需接入的公共接口 | 语义色 `success`/`warning`（含 foreground）；用量事实的三态表达；服务状态与配置的同一 owner 数据 |

## 实施状态（2026-09-27 第一轮）

| 项 | 状态 | 证据 |
|---|---|---|
| W4-DESIGN-03 语义色（含中性色）回到公共映射 | 已实施 | `ui/tailwind.config.js` 新增 `success`/`warning`（含 foreground），映射 W1 在 `theme.css` 发布的同名 token；`ui/src/**/*.tsx` 中 14 个文件的 17 处调色板字面量（amber/green/emerald/red/blue 等）改为语义类（`text-success`、`border-warning/40`、`bg-destructive/10` …）；新增 `tests/ui/semantic-colour-contract.test.ts` 断言产品页面不再出现语义性调色板类，并核对 theme.css 与 Tailwind 映射同时存在。更正（2026-09-27 第六轮）：审计当时写"中性调色板仍有使用"并未实测；实测 `ui/src/**/*.tsx` 中 slate/zinc/stone/gray/neutral 调色板类为 **0 处**。为防止回退，`tests/ui/semantic-colour-contract.test.ts` 现在同时禁止语义色与中性色调色板类。
验证记录（第五轮）：`ui/src` + `tests/ui` + `packages/shared-ui/test` + `packages/extension-sdk/test` 139 文件 / 1163 测试；`bun run build:ui` 成功；`bun run test:account-layout` 12/12；`bun run typecheck:test` 无错误。

第四轮验证记录：`ui/src` + `tests/ui` + `packages/shared-ui/test` + `packages/extension-sdk/test` 138 文件 / 1162 测试；`bun run build:ui` 成功；`bun run test:account-layout` 12/12；`bun run typecheck:test` 无错误。

第三轮验证记录：`ui/src` + `tests/ui` + `packages/shared-ui/test` + `packages/extension-sdk/test` 138 文件 / 1161 测试；`bun run build:ui` 成功；`bun run test:account-layout` 12/12；`bun run typecheck:test` 无错误。

第二轮验证记录：`ui/src` + `tests/ui` + `packages/shared-ui/test` + `packages/extension-sdk/test` 137 文件 / 1157 测试；`bun run build:ui` 成功；`bun run test:account-layout` 12/12；`bun run typecheck:test` 无错误。

第一轮验证记录：137 文件 / 1155 测试；`bun run build:ui` 成功；`bun run test:account-layout` 12/12；`bun run typecheck:test` 无错误。

| W4-DESIGN-01 概览重排 | 已实施 | `StatusPage.tsx` 现在先给一个结论（`data-testid="overview-conclusion"`，tone 取 normal/attention/unknown，五种情况折叠为正常／服务未就绪／对外访问有问题／读取失败／状态未知），再一次 ≤4 组事实（实例、核心服务 N/M、推荐访问、上次检查；服务未知显示「状态无法确认」而非 0，符合 AC-09），服务明细、访问路径、Cloud 与配置摘要收进默认收起的 `<details>`（`overview-details`/`overview-access-details`/`overview-runtime-details`）。`StatusPage.test.tsx` 新增两条用例：正常态恰一个结论、事实 ≤4、无强调动作、details 均收起；服务未知时 tone=unknown 且不出现 `0/`。第二轮补充：「访问与空间」事实组已接入空间用量（复用 `fetchPodSettingsStatus`，`describeStorageUsage` 对未支持/失败分别给「此部署不提供用量」「用量未知」，不回落成 0）；需处理事项改为问题列表驱动：只铺一张最高影响卡片，其余以「还有 N 项：<标题链接>」计数（§7.1）。`StatusPage.test.tsx` 增补服务异常 + 外部访问异常同时出现时只有一张卡且计数为 1 的用例。未完成：AI 摘要依赖 W5；`index-storage` 仍无独立来源（已在用量页说明）。 |
| W4-DESIGN-02 用量域 | 已实施 | 新增 `ui/src/pages/admin/UsagePage.tsx`（复用既有 `fetchPodSettingsStatus` 客户端，此前无任何消费者），路由 `/status/usage/{overview,storage,bandwidth,ai,index-storage}`（§3.1 的五个深链），`status-navigation.ts` 增加 Usage 分组；三态严格区分：`available` 显示实测值（真的 0 显示 0）、`unsupported` 说明部署不提供、读取失败显示「状态无法确认」并提供重试，均不回落成 0（AC-09）；`index-storage` 明确说明尚无独立数据来源，不编造。空间详情（Pod 面板）新增「查看用量」入口（§7.2）。`/dashboard/usage` 的旧入口改指 §3.3 的目标 `/status/usage/overview`，W2-DESIGN-04 记录的目标路由缺口随之关闭。`UsagePage.test.tsx` 四条用例覆盖有值/零/不支持/失败。未完成：用量记录时间与来源字段在部分部署可能缺失，显示为「未标注」 |
| W4-DESIGN-04 服务与访问分区 | 已实施（同页四主题 + 配置就地） | `/settings/runtime`（§3.1 的服务与访问默认路径）现在先渲染四个主题的卡片：服务与启动（服务状态 + 运行时长，配置表单就在本页下方）、访问与连接（当前存储地址/登录态 + 连接页入口）、对外访问设置（公网地址与可达性，读不到写「对外访问状态无法确认」）、诊断（索引与用量直达）。状态只呈现读到的值，未知不写成正常或 0（AC-09）。`ServicesAccessSections.test.tsx` 断言四个主题的顺序与未知态文案。未完成：访问范围（本机/局域网/外部）与隧道切换仍在 `/network`，尚未并入同页分区 |
