# W3 Account / Pod 前端 · 设计自查与实施范围

### 范围与职责

- 模块 / 负责人：Xpod Account body、layout、流程 controller 与受保护续接（W3）
- 审查日期 / 纲领与实施 spec 版本：2026-09-27 / 纲领 R2、实施 spec 2026-09-27 R2
- 适用设计决定 D 编号 / 实施验收 AC 编号：D-02、D-03、D-04；AC-06、AC-07、AC-08（本轮不冒充已做运行验收）
- 用户任务（一句话）：注册只得到 Account，创建存储空间是用户显式发起的动作，中途离开还能回到原任务
- 场景：桌面工作区内的 `/settings/pod`、从注册/consent 进入的 Account 文档、280×400 compact、Web Account
- 本模块负责 / 不负责：负责 Account/Pod 前端的 body、容器归属、创建与续接 controller；不负责创建协议本身（Account controls、授权机器清单、健康检查按 §11 单独列证据）
- 前置模块 / 完成后去向：W1 公共视觉与 W2 页型/导航已就位；W4 概览与空间消费本模块的创建入口与状态
- 审查层次：文档 + 前端表达（读取 `ui/src/pages/WelcomePage.tsx`、`ui/src/utils/registration-flow.ts`、`ui/src/utils/consent-first-pod.ts`、`ui/src/pages/settings/PodManagementPanel.tsx`、`ui/src/pages/ConsentPage.tsx`、`ui/src/auth/WebAccountLayout.tsx` 及其测试；未启动应用）
- 已阅读的文件、章节或行号：
  - `ui/src/utils/registration-flow.ts`（原 `completeRegistrationProvisioning` 定义、`loginAccountPassword`、`bootstrapAccountPasswordLogin`、`retryRegistrationReadiness`）
  - `ui/src/pages/WelcomeNoPod.test.tsx`（两条 W3 回归：注册不得 provisioning、已登录无 Pod 落 Account 管理）
  - `ui/src/pages/ConsentPage.tsx:517`（授权流程不代用户创建 Pod）、`tests/ui/registration-flow.test.ts`
  - 实施 spec §5.1–§5.3、§7.2、§10、§12 W3；AC-06/07/08；纲领 XP-05/XP-07
- 未覆盖范围：真实创建协议（Account controls/幂等/健康检查）、真机窗口行为与视觉走查、Webidauth 与 LinX 侧消费者

### 适用依据

| 依据 ID | 文件与位置 | 适用对象 / 规则摘要 | 性质 |
|---|---|---|---|
| E-01 | spec §5.2 第 2 步 | 注册完成进入 Account 页面，反馈"账号已创建"；不调用 Local prepare、不自动创建 Pod | 领域规范 |
| E-02 | spec §5.3 | Consent 展示应用、权限、WebID 与目标 Pod；无 Pod 时给"前往 Pod 管理 / 取消授权"，去管理只保存安全续接上下文 | 领域规范 |
| E-03 | spec §5.1 | 容器由场景决定：Shell 内 `/settings/pod` 用存储空间 Content；注册/consent 用 Account 文档；compact 280×400 | 领域规范 |
| E-04 | spec §7.2 | 零 Pod 仍能进入清单与创建；缺 Account 只影响依赖 Account 的区域 | 领域规范 |
| E-05 | spec §11 | 显式创建的验证依赖 Account controls、授权机器清单、健康检查、幂等查询；缺哪步说明哪步 | 依赖边界 |
| E-06 | spec §12 W3 | 交付 body、layout、流程 controller 与受保护续接；纠正隐式创建 | 工作包 |
| E-07 | `ui/src/utils/registration-flow.ts` | 现状：`completeRegistrationProvisioning` 会 prepare/创建 Pod，并被 `tests/ui/registration-flow.test.ts` 固化为"注册时创建" | 前端表达 |
| E-08 | `ui/src/pages/ConsentPage.tsx:517` | 现状：授权页已经不代用户创建 Pod，并给"前往 Pod 管理" | 前端表达 |
| E-09 | `ui/src/pages/WelcomeNoPod.test.tsx` | 现状：两条 W3 回归已写好并通过 | 前端表达 |

### 功能与操作是否成立（先于规则合规）

| 功能 / 入口 | 用户要作的决定 | 没有它哪条任务受损 | 判定 | 理由和受影响能力 |
|---|---|---|---|---|
| 注册（仅 Account） | 邮箱/密码等 Account 必填项 | 注册即建资源会让用户失去"在哪里建"的决定权 | 保留 | 页面已不 provisioning（E-09），但流程模块仍留着创建入口（E-07） |
| 显式创建 Pod | 位置、名称、确认提交 | 没有它就没有存储空间；缺它会让注册被迫承担 | 保留 | `PodManagementPanel` 承担显式创建；协议依赖按 §11 列证据 |
| 无 Pod 的授权 | 前往 Pod 管理 / 取消授权 | 用户会被卡在授权页或被迫先建资源 | 符合 | 授权页只说明并给去向（E-08） |
| 受保护续接 | 是否继续准备空间 | 中途离开会丢上下文、重复注册或建替代 Pod | 缺证据 | `consent-first-pod.ts` 与续接测试存在，但未经本轮逐条核对（见 W3-DESIGN-02） |
| 容器归属（compact/Account 文档/Shell） | 不需要决定 | 同一流程出现两种容器与两个窗口 owner | 缺证据 | `WebAccountLayout` 与 §5.1 的场景矩阵未逐项核对（见 W3-DESIGN-03） |

### 原则自查表

| 原则 | 判定 | 层次 | 本模块判断与依据 |
|---|---|---|---|
| XP-01 用户任务与产品职责 | 符合 | 文档 | 注册与创建分开（E-01/E-04） |
| XP-02 愿景、目标与能力边界 | 符合 | 文档 | 不把"绑定已存在 Pod"等未定协议说成已支持（E-05） |
| XP-03 对象与事实来源 | 符合 | 文档 | Account、WebID、Pod 三对象与各自 authority 不混用（E-02/E-04） |
| XP-04 意图、执行与观察结果 | 缺证据 | 前端 | 创建阶段（已提交/已创建/绑定已确认/已就绪）尚未逐项核对展示 |
| XP-05 用户控制与改变后果 | 偏离 | 前端 | 流程模块仍提供"注册时创建"的入口（E-07），与必须由用户显式发起冲突 |
| XP-06 失败与恢复 | 缺证据 | 前端 | 超时/刷新后的原任务查询与"取消等待"语义未逐条核对 |
| XP-07 模块分工与任务续接 | 缺证据 | 前端 | 续接上下文（有时限、绑定当前 Account 与原 interaction）未逐项核对 |
| XP-08 生命周期与数据操作 | 符合 | 文档 | 创建/绑定/就绪分别表达，删除与移除属其他模块 |
| XP-09 信息架构与层次 | 符合 | 文档 | 空间入口与创建清单同属存储空间（W2 已定导航归属） |
| XP-10 品牌与操作气质 | 符合 | 文档 | 容器与按钮消费 W1 公共层 |
| XP-11 公共设计系统与归属 | 符合 | 前端 | 表单 primitive 来自 shared-ui；Account body 不与共享层互换业务 |
| XP-12 可访问性与异常状态 | 缺证据 | 前端 | 长错误与 200% 字体下的单滚动区未逐项核对 |

### 问题记录

```text
问题 ID：W3-DESIGN-01
标题：注册流程模块仍保留会自动创建 Pod 的公开入口
判定：偏离
优先级：P1
关联原则：XP-05
审查层次：前端
适用规则：E-01「注册完成…不调用 Local prepare 或自动创建 Pod」
实际材料：`ui/src/utils/registration-flow.ts` 的 `completeRegistrationProvisioning` 会 prepare 并创建
Pod，且 `tests/ui/registration-flow.test.ts` 把"注册时创建"固化成用例（E-07）
用户影响：任何调用方都能在注册路径上隐式建资源；失败与重试范围会把创建混进注册
最小修正方向：删除该入口与其创建用例，改为断言模块不再导出创建能力；创建只走存储空间显式入口
主责模块 / 关联模块：Xpod Account（主）/ 存储空间（显式创建）
完成条件：流程模块不再包含 prepare/创建调用；注册回归用例覆盖"不 provisioning"
未验证边界：未跑真实创建（协议依赖按 §11）
```

```text
问题 ID：W3-DESIGN-02
标题：受保护续接与阶段结果未逐项核对
判定：缺证据
优先级：P2
关联原则：XP-04、XP-07
审查层次：前端
适用规则：E-02 的"去管理只保存有时限、绑定当前 Account 与原 interaction 的安全续接上下文"；E-05 的四段结果
实际材料：`ui/src/utils/consent-first-pod.ts`（577 行）与 `ConsentResume.test.tsx` 存在，但本次未逐条比对
§5.2 第 6/7 步与 §5.3 的每个阶段
用户影响：续接失败时可能重新发起注册、换名称或建替代 Pod
最小修正方向：按 §5.2 第 6/7 步列出四段结果与恢复动作，逐条落到现有 controller 或标记缺口
主责模块 / 关联模块：Xpod Account
完成条件：四段结果与三种恢复（超时/刷新/重复进入）各有用例
未验证边界：未跑真实续接
```

```text
问题 ID：W3-DESIGN-03
标题：容器与窗口 owner 尚未按 §5.1 逐项核对
判定：缺证据
优先级：P2
关联原则：XP-12
审查层次：前端
适用规则：E-03 的容器矩阵（Shell Content / Account 文档 / compact / Web Account）与"宿主唯一决定窗口几何"
实际材料：`ui/src/auth/WebAccountLayout.tsx` 与桌面 `window-mode.ts` 存在；本次未逐条比对矩阵
用户影响：同一流程可能在两种容器里出现，或业务 body 影响窗口
最小修正方向：按矩阵逐行核对容器与窗口 owner，列出偏差
主责模块 / 关联模块：Xpod Account / 宿主
完成条件：每个场景有唯一容器与窗口 owner
未验证边界：未做真机窗口走查
```

### 跨模块事项与交接

| 问题 ID | 主责 / 消费模块 | 可直接引用的决定，或待决定的问题 | 各模块需同步什么 | 完成条件 |
|---|---|---|---|---|
| W3-DESIGN-01 | Xpod Account（主）/ W4 | 直接引用 E-01 | 存储空间提供显式创建入口 | 流程模块无创建能力 |
| W3-DESIGN-02 | Xpod Account | 直接引用 E-02/E-05 | 续接上下文与阶段结果 | 四段结果有用例 |
| W3-DESIGN-03 | Xpod Account / 宿主 | 直接引用 E-03 | 容器与窗口 owner 唯一 | 矩阵逐行核对 |

### 结论

- 最重要的设计结论（不超过三项）：
  1. 隐式创建的实际风险不在页面，而在流程模块仍保留的公开创建入口；
  2. 授权页已经符合"不代用户创建"，零 Pod 路径可用；
  3. 续接与容器归属尚缺逐项证据，属下一轮核对项。
- 值得保留的设计：`WelcomeNoPod` 的两条回归用例把"注册不建 Pod"锁住了；授权页的"前往 Pod 管理"已是规范行为。
- 本模块可修正事项 / 公共层事项 / 待决定事项：可修正 01；核对 02、03；无待用户决定事项。
- 本次仍缺少的设计或前端材料：创建四段结果与续接恢复的用例矩阵。
- 本轮结论范围：文档 + 前端表达审查；未运行应用。

## 实施范围与依赖清单（§12 W3 要求）

| 项 | 内容 |
|---|---|
| 实现范围 | 删除注册路径的隐式创建入口；核对并补齐受保护续接与四段结果；核对容器/窗口矩阵；明确创建只由存储空间显式入口发起 |
| 未覆盖范围 | 创建协议与幂等实现（§11 依赖）、Webidauth 与 LinX 侧消费者、真机窗口 |
| 对应编号 | D-02、D-03、D-04；AC-06、AC-07、AC-08 |
| 变更文件（预计） | `ui/src/utils/registration-flow.ts`、`tests/ui/registration-flow.test.ts`、`ui/src/pages/WelcomeNoPod.test.tsx`、`ui/src/utils/consent-first-pod.ts`（核对）、`ui/src/auth/WebAccountLayout.tsx`（核对） |
| 依赖 | W1 公共层、W2 页型与导航（已完成）；Account controls 与创建协议按 §11 由领域 owner 提供证据 |
| 验收证据分层 | 前端：注册回归、模块契约、续接用例、容器矩阵核对；运行：实施后按 AC-06/07/08 分别取证 |
| 其他模块需接入的公共接口 | 显式创建入口与四段结果的状态表达；W4 消费时不复制 controller |

## 实施状态（2026-09-27 第一轮）

| 项 | 状态 | 证据 |
|---|---|---|
| W3-DESIGN-01 注册不再隐式创建 | 已实施 | 删除 `completeRegistrationProvisioning` 及其专用 helper（共 117 行）与两个"注册时创建"用例；`tests/ui/registration-flow.test.ts` 改为契约断言：模块不导出创建入口、源码不含 `prepareProvisionedPod`/`createPodUrl`/`hasExistingPod` |
| `WelcomeNoPod` 回归 | 已在旧轮修好，本轮刷新注释 | 两条用例（注册不 provisioning、无 Pod 落 Account 管理）均通过；测试头注释改为陈述契约 |
| W3-DESIGN-02 续接核对 | 未开始 | —— |
| W3-DESIGN-03 容器/窗口核对 | 未开始 | —— |

验证记录：`tests/ui` 16 文件 / 136 测试；`ui/src` + `tests/ui` + `packages/extension-sdk/test` 合计 1103 通过；`bun run build:components`、`bun run build:ui` 成功；`bun run test:account-layout` 12/12；`bun run typecheck:test` 无错误。附带修正：`tests/ui` 中 4 处按旧设计写的契约断言（taro 调色板、`sr-only` 图标栏、默认断点）已更新为 R2 契约，`NetworkPage` 的媒体桩改为按查询回答。
