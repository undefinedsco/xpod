# W1 公共视觉 · 设计自查与实施范围

### 范围与职责

- 模块 / 负责人：shared-ui 公共主题与 primitive（W1），本报告由 W1 执行方提交
- 审查日期 / 纲领与实施 spec 版本：2026-09-27 / 纲领 R2、实施 spec 2026-09-27 R2
- 适用设计决定 D 编号 / 实施验收 AC 编号：D-01、D-05、D-06、D-07；AC-01、AC-02、AC-03（本轮不冒充已做运行验收）
- 用户任务（一句话）：让所有产品表面显示同一套品牌与状态语义，用户不必分辨哪个页面来自哪套主题
- 场景（桌面 / Web / 云端 / 本机 / 自托管）：桌面与本机工作区、Account 文档、认证 compact；云端控制台复用同一主题
- 本模块负责 / 不负责：负责主题 token、primitive 外观、焦点与状态、公共尺寸/层级映射；不负责页面文案、业务容器、布局协议（归 extension-sdk）与各工作区业务
- 前置模块 / 完成后去向：无前置；W2 布局与 Shell、W3 Account/Pod 前端、W4/W5 工作区消费本包接口
- 审查层次：文档 + 前端表达（读取了 `packages/shared-ui/src` 与 `ui/src` 的样式与组件源码，未启动应用）
- 已阅读的文件、章节或行号：
  - `packages/shared-ui/src/theme.css`（238 行，`:root` L2–49、`.dark` L50–87、`.light` L88–…、`@layer components` L218、`@layer utilities` L230）
  - `ui/src/styles/global.css`（231 行，76 个自定义属性）、`ui/src/theme/system-theme.test.ts`、`ui/src/theme/XpodThemeProvider.tsx`
  - `packages/shared-ui/src/*.tsx`（18 个 primitive）、`packages/shared-ui/test/theme.test.ts`
  - `packages/extension-sdk/src/layout.ts`、`packages/extension-sdk/src/react/`
  - 实施 spec §8.1–§8.4、§10、§12 W1；AC-01/02/03；纲领 XP-10/XP-11
- 未覆盖范围：运行时截图与真机验收；系统图标打包；各工作区页面的最终视觉走查（属 W2/W4/W5）

### 适用依据

| 依据 ID | 文件与位置 | 适用对象 / 规则摘要 | 性质 |
|---|---|---|---|
| E-01 | `docs/superpowers/specs/2026-09-27-xpod-product-experience-spec.md` §8.1 | 主题角色由 shared-ui 语义 token 唯一映射，应用只消费；深色为本轮补全 | 领域规范（本轮设计补全） |
| E-02 | 同上 §8.2 | 字体、控件尺寸、圆角、内容宽度与 z-index 层级表（base=0…toast=50） | 领域规范 |
| E-03 | 同上 §8.4 | 正文 ≥4.5:1、必要控件/图形 ≥3:1；`line` 不能充当必要控件边界 | 领域规范（参数计算） |
| E-04 | 同上 §10 | shared-ui 唯一负责主题、primitive、焦点/状态外观、无业务容器 | 领域规范 |
| E-05 | 同上 §12 W1 | 先核对公开出口与其他消费者；交付主题与 primitive、双主题全状态样例、公共尺寸/层级映射 | 工作包 |
| E-06 | `docs/product-design-charter.md` XP-10/XP-11 | 温暖现代的气质靠行为与信息结构实现；共用一套设计系统，业务由模块表达 | 纲领 |
| E-07 | `packages/shared-ui/src/theme.css` | 现状：HSL 三段式 token（`:root`/`.dark`/`.light`），中性灰 + 通用紫，非本轮品牌 | 前端表达 |
| E-08 | `ui/src/styles/global.css` | 现状：`@import '@undefineds.co/shared-ui/theme.css'` 后重定义同名 token（76 个属性） | 前端表达 |

### 功能与操作是否成立（先于规则合规）

| 功能 / 入口 | 用户要作的决定 | 没有它哪条任务受损 | 判定 | 理由和受影响能力 |
|---|---|---|---|---|
| 主题 token 唯一映射 | 无需决定，系统承担 | 页面间配色/焦点漂移会让“同一产品”判断受损；换品牌要改多处 | 保留（需修正） | 现状两处同名 token 并存，谁生效取决于导入顺序 |
| primitive 外观与状态 | 无需决定 | 按钮/输入/弹窗在各页面语义不一致 | 保留 | 18 个 primitive 已归 shared-ui，方向正确 |
| 公共尺寸与层级 | 无需决定 | 触达目标与弹层层级不一致，窄窗与键盘用户受损 | 合并（补参数） | §8.2 的层级表在代码中尚无命名层 |

| 场景 | 首屏结论与关键事实 | 强调动作（允许没有） | 专业详情如何可达 | 当前页型及密度理由 |
|---|---|---|---|---|
| 正常 | 主题正确、无闪烁；状态由图形+文字表达 | 无 | — | 主题是全局基础，不占页面信息预算 |
| 首次 | 同上，首帧即正确主题（AC-06） | 无 | — | —— |
| 异常 | 错误/降级/未知状态使用同一语义映射 | 无 | — | 状态色不得独自传达含义 |

### 原则自查表

| 原则 | 判定 | 层次 | 本模块判断与依据 |
|---|---|---|---|
| XP-01 用户任务与产品职责 | 符合 | 文档 | shared-ui 只提供外观与状态，不含业务容器（E-04） |
| XP-02 愿景、目标与能力边界 | 符合 | 文档 | 不因主题改动宣称产品已重设计 |
| XP-03 对象与事实来源 | 偏离 | 前端 | 同一语义 token 有两份来源（E-07/E-08），事实来源不唯一 |
| XP-04 意图、执行与观察结果 | 缺证据 | 前端 | 未见统一的状态→外观样例；待 W1 交付双主题全状态样例 |
| XP-05 用户控制与改变后果 | 不适用 | — | 主题随系统，不提供手动开关（D-06） |
| XP-06 失败与恢复 | 缺证据 | 前端 | 失败/降级视觉存在，但无按 §8.1 的成对验收样例 |
| XP-07 模块分工与任务续接 | 符合 | 文档 | 布局协议归 extension-sdk，业务归各工作区（E-04） |
| XP-08 生命周期与数据操作 | 不适用 | — | 本模块不承载数据操作 |
| XP-09 信息架构与层次 | 缺证据 | 前端 | z-index 层级表未落为公共命名层（E-02） |
| XP-10 品牌与操作气质 | 偏离 | 前端 | 现状为中性灰 + 通用紫，非纸色/墨紫；深色为本轮补全（E-01/E-07） |
| XP-11 公共设计系统与归属 | 偏离 | 前端 | `ui/src/styles/global.css` 重定义同名 token，违反单点归属（E-08） |
| XP-12 可访问性与异常状态 | 缺证据 | 前端 | §8.4 的 18 组比值已核对，但未落为可复算的验收样例 |

### 关键任务契约

| 项目 | 设计说明 / 前端表达位置 |
|---|---|
| 用户要完成什么，作用于哪个对象 | 无需操作：正确主题与状态语义自动生效于所有产品表面 |
| 前置条件，由哪个模块负责 | 无；shared-ui 自身 |
| 主动作与改变范围 | 公共层改 `packages/shared-ui/src/theme.css`；页面不得再写私有颜色 |
| 提交、进行中、完成各说明什么 | 不适用（无提交语义） |
| 等待、失败、部分完成时如何恢复 | 首帧即应用正确主题；主题切换不重排焦点 |
| 取消、返回或离开会发生什么 | 不适用 |
| 完成后去哪里，保留哪些上下文 | 各工作区消费同一 token 名，无需迁移 |

### 问题记录

```text
问题 ID：W1-DESIGN-01
标题：同一语义 token 存在两份来源，页面与公共层各自可覆盖
判定：偏离
优先级：P1
关联原则：XP-03、XP-11
审查层次：前端
适用规则：E-01「由 shared-ui 的语义 token 唯一映射，应用只消费」；E-04
实际材料：`ui/src/styles/global.css:1` 导入 shared-ui 主题后又重定义 76 个同名属性（E-08）
用户影响：换品牌或修焦点需要改多处，且页面可能悄悄偏离公共状态语义
最小修正方向：把 §8.1 角色落进 `theme.css`，`global.css` 只保留布局/工具规则，不再重定义 token
主责模块 / 关联模块：shared-ui（主责）/ 各工作区（消费）
完成条件：`global.css` 中不再出现与公共层同名的语义 token；产物中同名 token 只解析到 shared-ui
未验证边界：未做视觉回归截图
```

```text
问题 ID：W1-DESIGN-02
标题：公共主题仍为中性灰 + 通用紫，未落本轮纸色/墨紫与深色补全
判定：偏离
优先级：P1
关联原则：XP-10
审查层次：前端
适用规则：E-01 的 §8.1 角色表（浅色来自品牌，深色为本轮补全）
实际材料：`theme.css` `--background: 0 0% 98%`、`--primary: 252 46% 57%`（E-07）
用户影响：产品与已选定品牌不一致；深色缺 §8.1 的对照值
最小修正方向：按 §8.1 重写 `:root`/`.dark` 的角色值，缺的角色（control-strong、action hover/pressed、三档 tint）补名
主责模块 / 关联模块：shared-ui
完成条件：§8.1 每个角色都能在 `theme.css` 找到唯一 token，且 §8.4 比值可复算
未验证边界：系统图标与品牌资产不含在内
```

```text
问题 ID：W1-DESIGN-03
标题：§8.2 的 z-index 层级表未落为公共命名层
判定：缺证据
优先级：P2
关联原则：XP-09
审查层次：前端
适用规则：E-02「公共层统一 base=0、sticky=10、popover=20、modal backdrop=30、modal=40、toast=50」
实际材料：`packages/*/src` 与 `ui/src` 均未出现字面 z-index（grep 计数 0），也未见命名层导出
用户影响：Dialog 内 Select/Popover 的归属没有公共依据，容易出现被遮罩覆盖
最小修正方向：在公共层导出命名层级并在 primitive 中使用；不改各页私有堆叠
主责模块 / 关联模块：shared-ui / extension-sdk
完成条件：弹层与 toast 的层级来自公共命名层，页面不再自带数值
未验证边界：未做跨浏览器叠层实测

处置（2026-09-27，已实施）：`theme.css` 发布 `--layer-base/sticky/popover/backdrop/modal/toast`
与 `--scrim`，并新增 `.xpod-overlay-scrim`；`dialog`、`tooltip`、`toast`、`login`、`auth-surface`
改为 `z-[var(--layer-…)]` 与 scrim 类，`packages/shared-ui/src/*.tsx` 中不再有字面量层级或
`bg-black/NN`（`packages/shared-ui/test/overlay-layers.test.ts` 以此为契约）。
```

```text
问题 ID：W1-DESIGN-04
标题：组件源码仍有 23 处颜色字面量
判定：缺证据
优先级：P3
关联原则：XP-11
审查层次：前端
适用规则：E-01「页面不可自建语义彩色」；E-04
实际材料：`ui/src` 的 tsx/ts 中 23 处 hex/hsl 字面量；`packages/ai-connections/src/provider-visuals.ts` 含 provider 品牌色
用户影响：局部偏离公共状态色；provider 品牌色按 §8.1 属允许范围，需与操作色分开说明
最小修正方向：逐个判断是品牌色（保留并标注）还是语义色（改为 token）
主责模块 / 关联模块：共享 UI / AI Connections
完成条件：语义色不再以字面量出现；品牌色有出处说明
未验证边界：未逐处确认视觉等价

处置（2026-09-27，已实施）：产品可达页 `ui/src/inrupt-smoke.ts` 改为导入公共主题并全部使用
`hsl(var(--…))`，文件内颜色字面量为 0；`ui/src` 其余匹配均为"不得使用旧 zinc/白/旧紫"的
反向断言（`AboutPage.test.tsx`、`AccountPage.test.tsx`），不属私有调色板。
`packages/ai-connections/src/provider-visuals.ts` 为 provider 品牌色，按 §8.1 末段与操作色分开，
保留并在此登记为允许项。
```

### 跨模块事项与交接

| 问题 ID | 主责 / 消费模块 | 可直接引用的决定，或待决定的问题 | 各模块需同步什么 | 完成条件 |
|---|---|---|---|---|
| W1-DESIGN-01 | shared-ui（主）/ W2、W4、W5 | 直接引用 E-01：应用只消费 | 移除页面私有 token 定义 | 产物中同名 token 单一来源 |
| W1-DESIGN-03 | shared-ui / extension-sdk | 直接引用 E-02 的层级表 | primitive 使用命名层 | 无页面私有 z-index |
| W1-DESIGN-04 | shared-ui / AI Connections | provider 品牌色与操作色分开（§8.1 末段） | 标注品牌色出处 | 语义色无字面量 |

### 结论

- 最重要的设计结论（不超过三项）：
  1. 公共主题存在两份同名 token 来源，是 W1 的 P1 修正项，也是 AC-01 的前置条件；
  2. §8.1 的角色表必须落进 `theme.css` 的单一映射，深色为新增对照值；
  3. §8.2 的层级表尚未落地，属公共层缺口，不是页面问题。
- 值得保留的设计：18 个 primitive 已集中在 shared-ui；`theme.css` 已有系统主题与原生控件基线，测试已锁结构（`packages/shared-ui/test/theme.test.ts`）。
- 本模块可修正事项 / 公共层事项 / 待决定事项：可修正 01、02、04；公共层事项 03（与 extension-sdk 协同）；无待用户决定事项。
- 本次仍缺少的设计或前端材料：双主题全状态样例（XP-04/XP-06/XP-12 的验收材料）。
- 本轮结论范围：文档 + 前端表达审查；未运行应用，未做视觉回归。

## 实施范围与依赖清单（§12 W1 要求）

| 项 | 内容 |
|---|---|
| 实现范围 | `packages/shared-ui/src/theme.css` 的 §8.1 角色映射（浅色 + 深色 + `.light` 去重）；`ui/src/styles/global.css` 移除同名 token 重定义；公共层级命名层；双主题全状态样例 |
| 未覆盖范围 | 页面结构、导航与布局协议（W2）、Account/Pod 流程（W3）、各工作区业务视觉（W4/W5）、系统图标资产 |
| 对应编号 | D-01、D-05、D-06、D-07；AC-01、AC-02、AC-03 |
| 变更文件（预计） | `packages/shared-ui/src/theme.css`、`ui/src/styles/global.css`、新增公共状态样例（fixture 或测试）、`packages/shared-ui/src/` 中消费字面量处 |
| 依赖 | 无外部依赖；先核对公开出口与其他消费者（`ui/src` 全部入口、`packages/*/src`），不删除 LinX/extension 仍在使用的导出 |
| 验收证据分层 | 前端：token 单源检查、字面量检查、§8.4 比值复算；运行：实施后按 AC-01–03 分别取证 |
| 其他模块需接入的公共接口 | 命名层级（z-index 命名层）、`control-strong`/action 三态/tint 三档 token 名；W2 布局协议按 §8.3 复用之 |

## 实施状态（2026-09-27 第一轮）

| 项 | 状态 | 证据 |
|---|---|---|
| W1-DESIGN-01 单一来源 | 已实施 | `ui/src/styles/global.css` 删除 76 个同名 token；`ui/src/theme/system-theme.test.ts` 断言不再重定义 |
| W1-DESIGN-02 R2 主题 | 已实施 | `theme.css` 三块（`:root`/`.dark`/`.light`）按 §8.1 重写，一位小数 HSL 可精确回到原 hex；§8.4 全部 18 组比值由提交后 CSS 复算一致（0 处不符） |
| W1-DESIGN-03 命名层级 | 已实施 | `--layer-*` 六档 + `--scrim` + `.xpod-overlay-scrim`；`theme-states` 样例含遮罩块；契约测试见 `overlay-layers.test.ts` |
| W1-DESIGN-04 颜色字面量 | 已实施 | `inrupt-smoke.ts` 字面量 0；provider 品牌色登记为允许项 |
| 双主题全状态样例 | 已交付 | `packages/shared-ui/samples/theme-states.html`（浅/深并排、19 个状态）+ `test/theme-states.test.ts` 核对覆盖度与"不只靠颜色" |

验证记录：`packages/shared-ui/test` 55/55；`ui/src` 95 文件 / 877 测试全过；`bun run build:ui` 成功（含 smoke 入口）；`bun run test:account-layout` 12/12。未做：真机/跨浏览器视觉回归与系统图标打包（仍属未覆盖范围）。
