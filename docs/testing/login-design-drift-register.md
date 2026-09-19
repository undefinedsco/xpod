# 登录设计漂移登记（2026-09-19）

本表逐条登记"设计文档 vs 代码"的不一致，并给出**合理性判断**与裁决。
最终设计见 [`../superpowers/specs/2026-09-19-xpod-login-and-host-design.md`](../superpowers/specs/2026-09-19-xpod-login-and-host-design.md)。

## 裁决原则

用户 2026-09-19 指示：**逐条重新判断合理性，以最合理的为准**；本轮**只做对齐，不引入行为变更**。
因此每条按以下顺序判断：

1. 文档主张的**语义**是否正确（是否表达了用户/产品真正需要的行为）？
2. 代码的实现是否**恰好**表达了那个语义，还是只是碰巧如此？
3. 若两者都"部分对"——通常是**语义对、词汇错**，或**要求对、实现不全**——
   则保留正确的语义，把错误的一方显式标注，并把需要改行为的部分登记为待办。

**安全裁决**：Account cookie 的管理与原生 CSS 对齐，**Xpod 不做拓展或增强**。

## 前置结论：旧文档清理已经做过

用户假设"代码里应该有很多过时的文档"。核对结果：**2026-08-30 那批降级已经执行完毕**。

| 检查项 | 结果 |
| --- | --- |
| `XpodAuthProvider` / `useXpodAuth` | 已从代码移除（仅剩同名的 `useXpodAuthWindowSurface`，无关） |
| `CssAccountTokenAuthenticator` | 已从代码与配置移除 |
| `2026-08-10-shared-account-login-view-design.md` | 已标 SUPERSEDED |
| `2026-08-13-xpod-login-state-machine.md` | 已标 HISTORICAL |
| `xpod-service-auth-boundaries.md` | 已标 Superseded（降为索引） |
| `docs/xpod-authentication.md` | 已加 authority note |
| `ai-connections-product-spec.md` | 已无冲突的会话合成表述 |

**所以真正的问题不是"重复的过时文档"，而是"当前有效的文档描述了一个代码没有实现的设计"。**
这类漂移更危险：读者会把文档当成现状。

## 漂移登记表

| ID | 文档位置 | 文档主张 | 代码事实 | 合理性判断 | 裁决 | 本轮动作 |
| --- | --- | --- | --- | --- | --- | --- |
| **D-01** | `login-state-matrix.md:32-45,51-60` | 两张状态图共 12 个状态名 | **11 个在 `ui/src`+`packages/solid-sdk/src` 中零命中**；唯一命中的 `Authorizing` 是同名 `isAuthorizing` | **语义对、词汇错。** 那些情形真实存在且需区分，但用了一套代码里不存在、也无法对照检验的词汇表。而"不另造大状态机、组合三源"是文档自己明确选择的 | **文档为准的语义 + 代码为准的词汇**：废弃单机状态图，改为三源组合表（合法组合 C-1…C-6 / 非法组合 X-1…X-5） | 已写入新设计 §4 |
| **D-02** | `login-state-matrix.md:25` | Account `submitting` 是权威状态 | **无生产者**（`ui/src` 除类型声明外无任何 `setAccountState({status:'submitting'})`）；密码表单另有局部 `pending`（`XpodAccountCredentials.tsx:47`），而 `AccountAuthBoundary.tsx:39` 却分支在这个死状态上 | **语义对、归属错。** "提交中"确实需要表达，但它属于**表单**而非 Account 权威——文档自己也说 Account 状态归 Xpod 产品代码、AuthContext 只做 CSS 适配。把登录/注册/找回/重置各自的提交态塞进 Account 状态机会把表单细节泄漏进权威层 | 保留 UI 分支与类型成员；登记"由表单驱动该状态 **或** 从类型移除并改用表单 pending"的待办 | 待办（§9 D-02） |
| **D-03** | `login-coverage-and-modularity.md:22` | 必须区分 unknown / error / anonymous | **没有 `unknown`**：瞬时 502/503/504 由 `transientAccountState(exposeError)` 折叠成 `error` 或 `initializing`（`AuthContext.tsx:53-57`）；且 `ConsentPage.tsx:641`、`ProtectedRoute.tsx:21` 把 `!isLoggedIn`（含 error）当未登录 | **文档正确、实现有缺陷。** 这不是文档洁癖：CSS controls 连续 5xx 时，持有有效 Account 会话的用户会被当成未登录并跳转登录页 | **文档为准**，实现另开一轮 | 待办（§9 D-03） |
| **D-04** | `login-state-matrix.md:26` | WebID 首态是 `initializing` | 代码是 `loading`（`XpodSolidRuntime.ts:32`） | **纯命名不一致。** 三源里 Account 用 `initializing`、WebID 用 `loading`，读者会以为它们语义不同 | 文档改记代码实际取值，并把"三源命名统一"登记为低优先待办 | 已写入新设计 §3.2；待办 |
| **D-05** | 全部登录文档 | Pod/存储层**没有状态清单** | **8 态**（`storage-selection.ts:4-12`） | **文档缺失。** 一个 8 态状态机既无清单也无转换契约，且不在失败隔离矩阵里，与 Account/WebID 两层处理明显不对称 | 补齐状态清单 + 规则 | 已写入新设计 §3.3 |
| **D-06** | `2026-08-30-xpod-auth-authority-boundaries.md:89-92` | Account token "same-origin, session-scoped cookie … **no persistent lifetime**" | 实现**有意保留** CSS 的持久 `Expires`（`account-session.ts:85-98` 注释明确：不重写就会把记住账号降级为会话登录） | **实现与 `consent-session-reuse.md:14-18` 一致且正确；spec 这句是 Xpod 越权规定 CSS 的 cookie 生命期。** 用户裁决：cookie 归 CSS，Xpod 不拓展不增强 | **改文档**（spec 那一句），实现不动 | 待改 spec（见下） |
| **D-07** | 全部登录文档 | —（无记录） | **18 个回调失败码**（协议 10 + 存储 8）及其三分处置（可重试 / 自动重置 / 终止）定义在 `webid-auth.ts:57-67`、`XpodOidcCallbackApp.tsx:38-79`；抽样 7 个码在 `docs/` 命中数为 0 | **文档缺失，且这是产品级安全契约**——它决定哪些失败可静默重试、哪些必须让用户重新授权。缺文档意味着这条契约无法评审 | 补入设计 | 已写入新设计 §3.5 |
| **D-08** | `2026-09-06-auth-frontend-redesign.md:3,219` | "尚未完成新 RC 或桌面实机验收" | 0.4.6–0.4.10 已发布；桌面三部署验收已完成并有记录 | **状态行过期。** 读者会以为该设计尚未验收 | 更新状态行并指向实际验收记录 | 待改（见下） |
| **D-09** | `login-edge-acceptance-plan.md:4` | "执行结果回填覆盖矩阵" | 未被回填；该文件仍是计划 | **计划已过期。** 其中部分内容（测试辅助整理、桌面三部署重构）后来确实执行了 | 降级为归档，正文移出设计路径 | 待改（见下） |
| **D-10** | `login-coverage-and-modularity.md:76` | "18 格均已有对应入口与部署证据" | **无任何测试带格子编号**；12 格由 6 条参数化用例代表、6 格由 3 条代表 | **表述过强。** 实际是"9 条测试映射 18 个设计格"，属部分证实 | 改为"逐格映射 + 实际代表的测试"，并在新设计中要求每格编号（§8.2） | 已写入新设计 §8.2 |
| **D-11** | `login-audit-2026-09-15.md:133,136,159,164` | 各类计数（"Host 29 文件/359 项、SDK 74、桌面 137"、"矩阵 6/6"、"Host 324 项"等） | 实测无法复现（Host 25 文件/375、SDK 7 文件/125、桌面 20 文件/140；矩阵实际 9 条而非 6） | **失准，但性质是"当时快照"。** 该文件是 dated 审计记录，不是规范 | 保留为历史快照并加"计数未复现"标注，不作规范引用 | 待改（见下） |
| **D-12** | `login-state-matrix.md:15`、`login-coverage-and-modularity.md:29` | 多个绑定必须**显式选择**，冲突不得静默选另一个 Pod | **UI 层做到**（唯一候选才 ready，多候选 `selecting`）；**服务端 `PodLookupRepository.findByWebId` 取 `findAllByWebId(webId)[0]`**，且 `PodSettingsHandler`、`AiConfigHandler`、`container/common.ts` 不做歧义检查。直接登录链路无选择器，失败原因被压成通用文案 | **文档正确、实现不完整，且两层不一致。** 同一条设计规则在一层执行、另一层违反 | 文档保留要求，**显式标注覆盖边界与缺口**；实现另开一轮 | 已写入新设计 §3.3（D-13）；待办 |
| **D-13** | `login-state-matrix.md:62` | "已成功的 WebID 清理不因 Account 重试而重复执行" | `retryXpodProductLogout` **合规**（保留 `solidCleared`）；但**新的** `logoutXpodProduct` 会重建 operation、重置 `solidCleared` 并丢弃在途 `onComplete`（`xpod-product-logout.ts:41-43`） | **文档只覆盖了"重试"，未覆盖"新调用"。** 现状不是违反文档，而是文档没定义这个场景 | 保留文档语义，补"新调用 vs 重试"的定义 | 待办（§9 D-14） |
| **D-14** | `login-state-matrix.md:30` | 列举了合法组合 | 未列举"Pod ready + Account 已切换"等；`automaticLoginBlocked` 只有置位无复位（`xpod-product-logout.ts:42`） | **合法组合表不完整。** 非法组合没有显式清单，也就没人能指出"由谁阻止" | 补合法组合 C-1…C-6 与非法组合 X-1…X-5 | 已写入新设计 §4 |
| **D-15** | `2026-08-30-...:385` | 浏览器权威子集用 `bun run auth:accept:browser` 执行，"不是 mock 或源码文本断言" | 命令存在且含 5 条 `@auth-boundary` 真实用例；但 CI 里实际生效的常驻守卫是**源码文本断言**（`tests/ui/auth-authority-boundaries.test.ts` 读文件字符串），且 `auth:accept` **不在任何 workflow** | **规范正确、门禁缺失** | 文档保留；CI 变更登记待办 | 待办（§9 D-19） |
| **D-16** | `login-audit-2026-09-15.md` 整体 | 结尾称"整个目标尚未完成" | 其后 0.4.6–0.4.10 已发布并验收 | **历史快照，非现状** | 加"截至当日"标注 | 待改（见下） |

## 本轮已完成的文档动作

1. 新建 canonical 设计：`docs/superpowers/specs/2026-09-19-xpod-login-and-host-design.md`
   —— 收敛状态清单（含 Pod 8 态）、组合规则、转换矩阵、15 条链路、失败隔离、18 个失败码、
   验收契约与证据分级。
2. 本登记表：把 16 条漂移逐条裁决，区分"文档错 / 实现缺 / 两者部分对"。

## 本轮之后的待办（按优先级）

### P0 — 设计已明确、实现未满足

| 待办 | 依据 |
| --- | --- |
| 补 `unknown` 态（或让 `ConsentPage`/`ProtectedRoute` 显式区分 error 与 anonymous） | D-03 |
| 多 Pod 在直接登录链路补显式选择出口（或明确的"去账号页选择"放弃出口） | D-12 |
| 定义退出"新调用 vs 重试"语义 + `automaticLoginBlocked` 复位时机 | D-13 |
| Consent 页切号清理旧 WebID/Pod，或写明为何保留 | D-14 / X-1 |

### P1 — 契约与门禁

| 待办 | 依据 |
| --- | --- |
| 把 `bun run test` 纳入 `candidate.yml`；把 `auth:accept:browser` 纳入 CI | D-15 |
| 产品退出补取消点；applet `requireLogin()` 补失败/取消信号 | §9 D-18 / D-17 |
| SDK 引入 logout epoch（退出后迟到回调不得让底层重新登录） | D-16（设计侧 X-2） |

### P2 — 文档收尾（本轮未做的机械动作）

| 待办 | 依据 |
| --- | --- |
| 修正 authority spec §1 的 cookie 句（改为"CSS 决定生命期，Xpod 不拓展不缩短"） | D-06 |
| 更新 `2026-09-06-auth-frontend-redesign.md` 状态行 | D-08 |
| `login-edge-acceptance-plan.md` 降级为归档 | D-09 |
| `login-audit-2026-09-15.md` 加"计数为当日快照、未复现"标注 | D-11 / D-16 |
| 把 `login-state-matrix` / `login-coverage-and-modularity` / `login-interaction-recovery` / `oidc-interaction-isolation` / `auth-presentation-boundary` 降为指向新设计的 redirect，保留仍有效的说明性内容 | 文档架构收敛 |
| `Account submitting` 由表单驱动，或从类型移除 | D-02 |
| 三源状态命名统一 | D-04 |
| 补 `creating` / `waiting_for_binding` 的状态级测试 | D-01 |

## 未验证边界

- 本表结论来自静态阅读与定向运行（单元 1010 通过、lite 151、full 45/45），
  **未执行**浏览器 E2E、桌面 Electron、三模式矩阵，也未连接运行中的 Gateway（该实例是已安装的 0.4.9）。
- 行号对应当前工作区（HEAD `92fc7d5b` + 未提交改动），未绑定具体 revision。
- 上游 `oidc-provider` 的 interaction 生命周期不在本仓库，未逐行审计。
